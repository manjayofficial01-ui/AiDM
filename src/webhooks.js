// @ts-check
/**
 * Task-event webhooks — a FluxDown-style feature missing from AiDM.
 *
 * The manager can POST a JSON payload to one or more endpoints whenever a
 * download reaches a notable state (started, completed, error, paused, resumed).
 * Endpoints are parsed LENIENTLY (mirroring FluxDown's WebhookSpec): non-object
 * entries are skipped, a missing `url` drops the endpoint, unknown fields fall
 * back to defaults, and a bad endpoint is never allowed to throw or block the
 * download it observes. Deliveries are best-effort (one retry on transient
 * failure) and never reject the owning download.
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

/**
 * @typedef {object} EndpointSpec
 * @property {string} url
 * @property {'POST'} method
 * @property {string[]} events
 * @property {string} [secret]
 */

class WebhookManager {
  /** @param {{ fetchImpl?: Function, enabled?: boolean }} [opts] */
  constructor(opts = {}) {
    /** @type {EndpointSpec[]} */
    this.endpoints = [];
    this.fetchImpl = opts.fetchImpl || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
    this.enabled = opts.enabled !== false;
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
   * Fire a webhook event. Best-effort: never throws. A matching endpoint whose
   * `events` include `kind` (or the endpoint has no specific filter beyond
   * defaults) receives one POST; transient failures get a single retry.
   * @param {string} kind  One of WEBHOOK_EVENTS.
   * @param {object} data  Payload body.
   * @returns {Promise<void>}
   */
  async emit(kind, data) {
    if (!this.enabled || !this.fetchImpl) return;
    if (!WEBHOOK_EVENTS.includes(kind)) return;
    const body = JSON.stringify({ event: kind, timestamp: Date.now(), data: data || {} });
    for (const ep of this.endpoints) {
      if (!ep.events.includes(kind)) continue;
      // eslint-disable-next-line no-await-in-loop
      await this._deliver(ep, body);
    }
  }

  async _deliver(ep, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (ep.secret) {
      const sig = crypto.createHmac('sha256', ep.secret).update(body).digest('hex');
      headers['X-AiDM-Signature'] = `sha256=${sig}`;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchImpl(ep.url, { method: 'POST', headers, body });
        if (res && typeof res.ok === 'boolean' && !res.ok && res.status >= 500) {
          // retry server errors once
          if (attempt === 0) continue;
        }
        return;
      } catch (err) {
        if (attempt === 1) return; // give up after one retry
      }
    }
  }
}

module.exports = { WebhookManager, WEBHOOK_EVENTS, DEFAULT_EVENTS };
