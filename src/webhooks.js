// @ts-check
/**
 * Task-event webhooks — a FluxDown-style feature missing from AiDM.
 *
 * The manager can POST a JSON payload to one or more endpoints whenever a
 * download reaches a notable state (started, completed, error, paused, resumed).
 * Endpoints are parsed LENIENTLY (mirroring FluxDown's WebhookSpec): non-object
 * entries are skipped, a missing `url` drops the endpoint, unknown fields fall
 * back to defaults, and a bad endpoint is never allowed to throw or block the
 * download it observes.
 *
 * Delivery is bounded (AUD-013):
 *   - every request has a deadline (AbortController) — a stalled endpoint can
 *     no longer pin a socket forever;
 *   - transient failures (network, 408/429/5xx) retry with exponential
 *     backoff instead of an immediate hammer;
 *   - a single sequential worker drains a bounded queue, dropping the OLDEST
 *     queued event when the backlog cap is hit (counted in `stats.dropped`);
 *   - `close()` cancels timers and clears the queue at app shutdown.
 *
 * `emit()` enqueues and resolves immediately; `flush()` awaits the drained
 * queue (tests use it; production never blocks a download on a webhook).
 *
 * An optional `secret` signs each body with HMAC-SHA256 in the
 * `X-AiDM-Signature` header so receivers can verify authenticity.
 */
const crypto = require('crypto');

/** Event kinds a webhook endpoint may subscribe to. */
const WEBHOOK_EVENTS = [
  'download_started',
  'download_completed',
  'download_error',
  'download_paused',
  'download_resumed',
];

const DEFAULT_EVENTS = ['download_completed', 'download_error'];

// Bounds. A stalled receiver must never accumulate work without limit.
const DEFAULT_TIMEOUT_MS = 10000;      // per HTTP attempt
const DEFAULT_MAX_ATTEMPTS = 3;        // first try + 2 retries
const DEFAULT_MAX_PENDING = 100;       // queued deliveries (endpoints × events)
const DEFAULT_BACKOFF_MS = 1000;       // 1s, 2s, 4s… (capped at 30s)

/**
 * @typedef {object} EndpointSpec
 * @property {string} url
 * @property {'POST'} method
 * @property {string[]} events
 * @property {string} [secret]
 */

class WebhookManager {
  /**
   * @param {{ fetchImpl?: Function, enabled?: boolean, timeoutMs?: number,
   *           maxAttempts?: number, maxPending?: number, backoffMs?: number,
   *           sleep?: (ms: number) => Promise<void> }} [opts]
   */
  constructor(opts = {}) {
    /** @type {EndpointSpec[]} */
    this.endpoints = [];
    this.fetchImpl = opts.fetchImpl || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
    this.enabled = opts.enabled !== false;
    this.timeoutMs = Math.max(50, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.maxAttempts = Math.max(1, Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
    this.maxPending = Math.max(1, Number(opts.maxPending) || DEFAULT_MAX_PENDING);
    this.backoffMs = Math.max(0, Number(opts.backoffMs) || DEFAULT_BACKOFF_MS);
    // Injectable so tests never wait on real timers.
    this._sleepImpl = typeof opts.sleep === 'function' ? opts.sleep : null;

    /** @type {{ ep: EndpointSpec, body: string }[]} */
    this._queue = [];
    this._draining = false;
    this._closed = false;
    this._timers = new Set();
    this._controllers = new Set();
    this._flushWaiters = [];
    this.stats = { delivered: 0, failed: 0, dropped: 0, retried: 0 };
  }

  /** Queued deliveries not yet attempted. */
  get pending() {
    return this._queue.length;
  }

  /**
   * Replace endpoints with a leniently-parsed list. Invalid entries are dropped
   * (never throw). Mirrors FluxDown's lenient endpoint reload.
   * @param {any[]} list
   */
  setEndpoints(list) {
    if (!Array.isArray(list)) {
      this.endpoints = [];
      return;
    }
    const out = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue; // skip non-objects
      const url = typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) continue; // url required + http(s)
      let events = Array.isArray(raw.events)
        ? raw.events.filter((e) => typeof e === 'string' && WEBHOOK_EVENTS.includes(e))
        : [];
      if (events.length === 0) events = DEFAULT_EVENTS.slice();
      const secret = typeof raw.secret === 'string' && raw.secret.length > 0 ? raw.secret : undefined;
      out.push({ url, method: 'POST', events, secret });
    }
    this.endpoints = out;
  }

  /** @param {object} json */
  load(json) {
    if (json && Array.isArray(json.endpoints)) this.setEndpoints(json.endpoints);
    if (json && typeof json.enabled === 'boolean') this.enabled = json.enabled;
  }

  toJSON() {
    return {
      enabled: this.enabled,
      endpoints: this.endpoints.map((e) => ({ url: e.url, events: e.events, secret: e.secret })),
    };
  }

  /**
   * Enqueue a webhook event. Never throws and never rejects.
   * @param {string} kind  One of WEBHOOK_EVENTS.
   * @param {object} data  Payload body.
   * @returns {Promise<void>} resolves when the event is queued
   */
  async emit(kind, data) {
    if (!this.enabled || !this.fetchImpl || this._closed) return;
    if (!WEBHOOK_EVENTS.includes(kind)) return;
    const body = JSON.stringify({ event: kind, timestamp: Date.now(), data: data || {} });
    for (const ep of this.endpoints) {
      if (!ep.events.includes(kind)) continue;
      if (this._queue.length >= this.maxPending) {
        // Drop the OLDEST queued delivery: the newest events describe the state
        // the receiver actually cares about now.
        this._queue.shift();
        this.stats.dropped++;
      }
      this._queue.push({ ep, body });
    }
    // Deliberately not awaited: a webhook must never delay the download.
    this._drain().catch(() => {});
  }

  /** Resolve when the current queue has fully drained (tests / shutdown). */
  flush() {
    if (!this._draining && this._queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => { this._flushWaiters.push(resolve); });
  }

  /** Stop all delivery: aborts in-flight attempts, clears timers, drops the queue. */
  close() {
    this._closed = true;
    this._queue.length = 0;
    for (const t of this._timers) {
      try { clearTimeout(t); } catch (e) { /* already fired */ }
    }
    this._timers.clear();
    for (const c of this._controllers) {
      try { c.abort(); } catch (e) { /* already aborted */ }
    }
    this._controllers.clear();
    this._resolveFlushWaiters();
  }

  _resolveFlushWaiters() {
    if (this._queue.length || this._draining) return;
    const waiters = this._flushWaiters;
    this._flushWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async _drain() {
    if (this._draining || this._closed) return;
    this._draining = true;
    try {
      while (this._queue.length && !this._closed) {
        const job = this._queue.shift();
        await this._deliver(job.ep, job.body);
      }
    } finally {
      this._draining = false;
      this._resolveFlushWaiters();
    }
  }

  _sleep(ms) {
    if (this._sleepImpl) return this._sleepImpl(ms);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this._timers.delete(t);
        resolve();
      }, ms);
      if (t.unref) t.unref();
      this._timers.add(t);
    });
  }

  _backoff(attempt) {
    return Math.min(this.backoffMs * Math.pow(2, attempt), 30000);
  }

  async _deliver(ep, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (ep.secret) {
      const sig = crypto.createHmac('sha256', ep.secret).update(body).digest('hex');
      headers['X-AiDM-Signature'] = `sha256=${sig}`;
    }
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (this._closed) return;
      const controller = new AbortController();
      this._controllers.add(controller);
      // NOT unref'd: an attempt in flight is real work — the deadline must be
      // able to fire even when nothing else keeps the event loop alive.
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let retryable = true;
      try {
        const res = await this.fetchImpl(ep.url, {
          method: 'POST', headers, body, signal: controller.signal,
        });
        if (this._closed) return;
        if (res && res.ok !== false) {
          this.stats.delivered++;
          return;
        }
        const status = res && typeof res.status === 'number' ? res.status : 0;
        // 4xx (except 408/429) means the receiver rejected the request — a
        // retry would send the same rejected bytes again.
        retryable = status === 0 || status === 408 || status === 429 || status >= 500;
        if (!retryable) {
          this.stats.failed++;
          return;
        }
      } catch (err) {
        if (this._closed) return; // close() aborted us — not a delivery failure
        retryable = true; // network error / timeout
      } finally {
        clearTimeout(timer);
        this._controllers.delete(controller);
      }
      if (attempt === this.maxAttempts - 1) {
        this.stats.failed++;
        return;
      }
      this.stats.retried++;
      await this._sleep(this._backoff(attempt));
    }
  }
}

module.exports = {
  WebhookManager,
  WEBHOOK_EVENTS,
  DEFAULT_EVENTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_PENDING,
};
