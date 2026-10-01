// @ts-check
'use strict';
/**
 * HTTP/2 transport: a `fetch()`-compatible client over Node's built-in `http2`.
 *
 * Why it exists: some CDNs and anti-bot fronts negotiate h2 over ALPN and
 * behave differently (or only) over HTTP/2, and one multiplexed connection
 * carrying ranged streams is a legitimate fallback when a host rate-limits
 * per-connection concurrency. Node ships `http2` in core, so this adds no
 * dependency and no native build.
 *
 * Interface contract (matches what src/engine/task.js + probe.js consume):
 *   h2fetch(url, init) → Promise<{
 *     status: number,
 *     headers: { get(name): string | null },   // case-insensitive
 *     body: ReadableStream (web),              // .getReader() / .cancel()
 *     url: string,
 *   }>
 *
 * - Follows redirects when init.redirect === 'follow' (bounded).
 * - Honors init.signal (AbortSignal) by cancelling the h2 stream.
 * - Reuses one session per origin (that is the point of h2); idle sessions
 *   are swept after SESSION_IDLE_MS.
 * - Throws `H2NotNegotiatedError` when the host answers ALPN with http/1.1,
 *   so the caller can fall back to the HTTP/1.1 transport cleanly.
 */
const http2 = require('http2');
const { Readable } = require('stream');
const { isSameRegistrableDomain } = require('../url-hygiene');

class H2NotNegotiatedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'H2NotNegotiatedError';
    this.code = 'H2_NOT_NEGOTIATED';
  }
}

const SESSION_IDLE_MS = 60 * 1000;
/** @type {Map<string, { session: import('http2').ClientHttp2Session, lastUsed: number }>} */
const sessions = new Map();
let sweepTimer = null;

function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [origin, entry] of sessions) {
      if (entry.session.destroyed || entry.session.closed) {
        sessions.delete(origin);
      } else if (now - entry.lastUsed > SESSION_IDLE_MS) {
        sessions.delete(origin);
        try { entry.session.close(); } catch { entry.session.destroy(); }
      }
    }
    if (sessions.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, 15000);
  sweepTimer.unref?.();
}

/**
 * @param {string} origin
 * @param {boolean} insecure internal/test hook (init._insecure) — skip TLS
 *   verification. Never set by production callers; exists so tests can use a
 *   self-signed cert without a process-wide CA install.
 */
function getSession(origin, insecure) {
  const key = insecure ? origin + '|insecure' : origin;
  const existing = sessions.get(key);
  if (existing && !existing.session.destroyed && !existing.session.closed) {
    existing.lastUsed = Date.now();
    return existing.session;
  }
  const session = insecure
    ? http2.connect(origin, { rejectUnauthorized: false })
    : http2.connect(origin);
  const entry = { session, lastUsed: Date.now() };
  sessions.set(key, entry);
  session._rejects = session._rejects || new Set();
  // Permanent: a session that dies (e.g. ALPN mismatch on an h1-only host)
  // emits an error. Map ALPN/protocol failures onto every in-flight request so
  // the wrapper can fall back to HTTP/1.1; swallow the follow-up error Node
  // emits when it tears the dead session down during destroy() (on both the
  // session and its socket) so teardown stays silent. This is deliberately
  // NOT a per-request handler — the same pooled session is shared across many
  // requests, so a per-request error listener would leak.
  session.on('error', (e) => {
    if (sessions.get(key) === entry) sessions.delete(key);
    if (isAlpnFailure(e)) {
      const err = new H2NotNegotiatedError(`ALPN negotiation failed: ${e.message}`);
      for (const r of session._rejects) { try { r(err); } catch { /* noop */ } }
    }
    session._rejects.clear();
    session.on('error', () => {});
    if (session.socket) session.socket.on('error', () => {});
    try { session.destroy(); } catch { /* noop */ }
  });
  session.on('close', () => { if (sessions.get(key) === entry) sessions.delete(key); });
  ensureSweep();
  return session;
}

/**
 * True when the error means the server refused (or couldn't negotiate) h2 at
 * TLS ALPN. These are the ONLY cases where falling back to HTTP/1.1 is safe —
 * any other error is a genuine transport/HTTP failure the caller must surface.
 */
function isAlpnFailure(err) {
  if (!err) return false;
  if (err.code === 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL') return true;
  if (err.code === 'ERR_HTTP2_PROTOCOL_ERROR') return true;
  if (err.code === 'ERR_HTTP2_ERROR') return true;
  return /no application protocol|alpn|application protocol/i.test(err.message || '');
}

/** Test/teardown helper: close every pooled session. */
function closeAllSessions() {
  for (const entry of sessions.values()) {
    // A session that died at TLS ALPN can emit a spurious error during
    // destroy() (ERR_HTTP2_STREAM_CANCEL / no-application-protocol). Swallow
    // it so teardown doesn't surface an unhandled rejection.
    entry.session.on('error', () => {});
    if (!entry.session.destroyed && !entry.session.closed) {
      try { entry.session.destroy(); } catch { /* noop */ }
    }
  }
  sessions.clear();
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

// HTTP/1.1-only headers that must never be translated onto the wire.
const FORBIDDEN = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'te']);

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, redirect?: string, signal?: AbortSignal }} [init]
 * @param {number} [redirectCount]
 */
async function h2fetch(url, init = {}, redirectCount = 0) {
  const target = new URL(url);
  if (target.protocol !== 'https:') {
    throw new H2NotNegotiatedError('h2fetch only speaks https');
  }
  if (redirectCount > 5) throw new Error('Too many redirects');

  const session = getSession(target.origin, !!init._insecure);

  // ALPN verdict: http2.connect negotiated something that is not h2. The
  // socket is usually not handshaked yet here (alpn === null), so this is a
  // secondary guard only — the authoritative ALPN check lives in getSession's
  // permanent error handler, which maps the failure onto every in-flight
  // request so the wrapper can fall back to HTTP/1.1.
  const alpn = session.socket && session.socket.alpnProtocol;
  if (alpn && alpn !== 'h2') {
    throw new H2NotNegotiatedError(`ALPN negotiated ${alpn}`);
  }

  const inHeaders = init.headers || {};
  /** @type {Record<string, string>} */
  const reqHeaders = {
    ':method': init.method || 'GET',
    ':path': (target.pathname || '/') + (target.search || ''),
  };
  for (const [k, v] of Object.entries(inHeaders)) {
    const lk = k.toLowerCase();
    if (FORBIDDEN.has(lk)) continue;
    if (lk.startsWith(':')) continue;
    if (v == null) continue;
    reqHeaders[lk] = String(v);
  }

  return new Promise((_resolve, _reject) => {
    let req;
    try {
      req = session.request(reqHeaders);
    } catch (err) {
      _reject(err);
      return;
    }

    /** @type {Record<string, string>} */
    const respHeaders = {};
    let status = 0;
    let settled = false;

    // Register this request so getSession's permanent ALPN handler can reject
    // it (and only it) when the host can't negotiate h2. Wrapped resolve/reject
    // also deregister on settle so a completed request can't be rejected late.
    if (!session._rejects) session._rejects = new Set();
    const reject = (e) => {
      if (settled) return;
      settled = true;
      try { session._rejects.delete(reject); } catch { /* noop */ }
      _reject(e);
    };
    const resolve = (v) => {
      if (settled) return;
      settled = true;
      try { session._rejects.delete(reject); } catch { /* noop */ }
      _resolve(v);
    };
    session._rejects.add(reject);

    req.on('response', (headers) => {
      status = headers[':status'] || 0;
      for (const [k, v] of Object.entries(headers)) {
        if (!k.startsWith(':')) respHeaders[k.toLowerCase()] = String(v);
      }
    });

    req.on('error', (err) => {
      // A stream error: map ALPN-class failures so the wrapper can fall back;
      // any other error is a genuine transport/HTTP failure to surface.
      if (!settled) reject(isAlpnFailure(err) ? new H2NotNegotiatedError(`ALPN negotiation failed: ${err.message}`) : err);
    });

    if (init.signal) {
      const abortErr = Object.assign(new Error('Request aborted'), { name: 'AbortError' });
      if (init.signal.aborted) {
        reject(abortErr);
        return;
      }
      init.signal.addEventListener('abort', () => {
        // Tear the stream down even if headers already arrived — that is the
        // whole point of aborting a streaming body (see test 4). The reject
        // is a no-op once settled, so a resolved promise is never rejected.
        try { req.destroy(abortErr); } catch { /* noop */ }
        reject(abortErr);
      }, { once: true });
    }

    // The web ReadableStream wrapper must exist before data can be consumed;
    // buffering is handled internally by Readable.toWeb.
    const body = Readable.toWeb(req);

    req.on('end', () => {
      // The wrapped resolve/reject own `settled`, so just delegate — calling
      // finish() twice is harmless (the second resolve is a guarded no-op).
      if (!settled) finish();
    });
    req.on('close', () => {
      if (!settled) {
        // Stream closed before 'end' — treat as a transport error so the
        // task's retry machinery engages rather than a truncated success.
        reject(new Error('HTTP/2 stream closed prematurely'));
      }
    });

    async function finish() {
      const location = respHeaders.location;
      if (status >= 300 && status < 400 && location && init.redirect === 'follow') {
        // Follow the redirect. A 3xx response has no body, so the stream
        // closes normally — mark settled up front so req 'close' doesn't
        // mistake that for a truncated download. Hand off to the raw
        // resolve/reject so the inner request settles THIS promise.
        settled = true;
        const next = new URL(location, url).href;
        let nextInit = init;
        try {
          const curHost = new URL(url).hostname;
          const nextHost = new URL(next).hostname;
          if (!isSameRegistrableDomain(curHost, nextHost) && init && init.headers) {
            const nextHeaders = { ...init.headers };
            for (const k of Object.keys(nextHeaders)) {
              if (/^(cookie|authorization)$/i.test(k)) delete nextHeaders[k];
            }
            nextInit = { ...init, headers: nextHeaders };
          }
        } catch (e) {}
        h2fetch(next, nextInit, redirectCount + 1).then(_resolve, _reject);
        return;
      }
      resolve({
        status,
        headers: { get: (n) => respHeaders[String(n).toLowerCase()] ?? null },
        body,
        url,
      });
    }

    // Fire the request. Errors before 'end' are surfaced via 'error'/'close'.
    try {
      req.end();
      // Resolve as soon as headers arrive — the caller reads the body lazily
      // through the web stream, exactly like fetch.
      req.once('response', () => {
        if (!settled) finish();
      });
    } catch (err) {
      if (!settled) reject(err);
    }
  });
}

/**
 * Wrap h2fetch so it degrades to the HTTP/1.1 transport when h2 is unavailable
 * (plain http URL, or ALPN answered http/1.1). Mid-stream errors propagate —
 * the segment retry policy owns those.
 *
 * @param {(url: string, init?: any) => Promise<any>} fallbackFetch
 */
function makeH2AwareFetch(fallbackFetch) {
  return async function h2AwareFetch(url, init = {}) {
    let u;
    try { u = new URL(url); } catch { return fallbackFetch(url, init); }
    if (u.protocol !== 'https:') return fallbackFetch(url, init);
    try {
      return await h2fetch(url, init);
    } catch (err) {
      if (err && err.code === 'H2_NOT_NEGOTIATED') return fallbackFetch(url, init);
      throw err;
    }
  };
}

module.exports = {
  h2fetch,
  makeH2AwareFetch,
  closeAllSessions,
  H2NotNegotiatedError,
};
