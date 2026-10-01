// @ts-check
const { basename } = require('path');
const { DownloadError, classifyHttpStatus, toDownloadError, isRetryableStatus } = require('./errors');
const { parseRetryAfter, backoffDelay } = require('./retry');
const { DEFAULT_RETRY_POLICY } = require('./types');

// A probe is the first request a task makes, and until now it had no retry at
// all: one 429 (Google/CDN rate limiting an authenticated attachment) or one
// 503 from a cold CDN edge killed the row before a single byte transferred,
// even though the transfer itself is protected by a full retry policy.
const DEFAULT_PROBE_ATTEMPTS = 3;

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    // Don't leave a timer referenced if the caller aborts while we wait.
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * Probe with `GET Range: bytes=0-0` rather than HEAD, retrying transient
 * failures (429/5xx/timeouts) with backoff before giving up.
 * @param {string} url
 * @param {{ headers: Record<string, string>, fetchImpl: typeof fetch, signal?: AbortSignal, timeoutMs: number, probeAttempts?: number }} opts
 */
async function probeRemote(url, opts) {
  const attempts = Math.max(1, Math.min(5, Number(opts.probeAttempts) || DEFAULT_PROBE_ATTEMPTS));
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await probeRemoteOnce(url, opts);
    } catch (err) {
      const de = err instanceof DownloadError ? err : toDownloadError(err);
      last = de;
      const worthRetrying = de.retryable || (typeof de.status === 'number' && isRetryableStatus(de.status));
      if (!worthRetrying || attempt === attempts) throw de;
      await sleep(backoffDelay(attempt, DEFAULT_RETRY_POLICY, de.retryAfterMs), opts.signal);
    }
  }
  throw last || new DownloadError('UNKNOWN', 'Probe failed');
}

/**
 * @param {string} url
 * @param {{ headers: Record<string, string>, fetchImpl: typeof fetch, signal?: AbortSignal, timeoutMs: number }} opts
 */
async function probeRemoteOnce(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DownloadError('TIMEOUT', `Probe timed out after ${opts.timeoutMs}ms`, { retryable: true })),
    opts.timeoutMs,
  );
  timer.unref?.();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  // The timer must not outlive the probe: an uncleared 30s handle would keep
  // the Electron main loop referenced after every completed probe.
  const disarm = () => clearTimeout(timer);

  // One jar shared by both attempts below: a redirect hop may mint a
  // token/session cookie that the follow-up request (or the plain-GET retry)
  // must replay. Jar-aware transports (robustFetch) honour `_jar`; the
  // standard fetch API simply ignores the extra property.
  const jar = { cookies: '' };

  let res;
  try {
    res = await opts.fetchImpl(url, {
      method: 'GET',
      headers: { ...opts.headers, Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
      redirect: 'follow',
      signal,
      _jar: jar,
    });
  } catch (err) {
    disarm();
    throw toDownloadError(err);
  }

  // Some tube/CDN hosts (WAF, mod_security, hotlink rules) reject HEAD and
  // Range probes with 401/403/400 yet serve a plain browser-style GET just
  // fine. A native browser download IS a plain GET, so retry once without
  // Range before declaring the URL dead — otherwise sites that "work in the
  // browser" can never download in AiDM. (400 joins the family: strict WAFs
  // answer a malformed-looking Range/If-Range probe with 400 instead of
  // 401/403, and classifyHttpStatus treats 400 as permanent.) The body is
  // cancelled immediately; only status + headers are read.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    try { await res.body?.cancel().catch(() => {}); } catch {}
    const plainHeaders = { ...(opts.headers || {}), 'Accept-Encoding': 'identity' };
    for (const k of Object.keys(plainHeaders)) {
      if (k.toLowerCase() === 'range') delete plainHeaders[k];
    }
    let plain;
    try {
      plain = await opts.fetchImpl(url, {
        method: 'GET',
        headers: plainHeaders,
        redirect: 'follow',
        // Keep the probe timeout armed for the retry too — a plain GET that
        // never answers must not hang the task forever.
        signal,
        _jar: jar,
      });
    } catch (err) {
      disarm();
      throw toDownloadError(err);
    }
    try {
      const h = plain.headers;
      const len = h.get('content-length');
      const size = len && /^\d+$/.test(len.trim()) ? Number(len) : null;
      if (plain.status === 200) {
        return {
          url,
          finalUrl: plain.url || url,
          etag: h.get('etag'),
          lastModified: h.get('last-modified'),
          contentType: h.get('content-type'),
          filename: filenameFromContentDisposition(h.get('content-disposition')),
          size,
          // Plain GET only: this host blocks Range outright, so the task must
          // download single-connection without ever sending Range.
          acceptRanges: false,
          rangesBlocked: true,
          responseCookies: jar.cookies || null,
        };
      }
      throw classifyHttpStatus(plain.status, parseRetryAfter(h.get('retry-after')));
    } finally {
      disarm();
      try { await plain.body?.cancel().catch(() => {}); } catch {}
    }
  }

  try {
    const h = res.headers;
    const base = {
      url,
      finalUrl: res.url || url,
      etag: h.get('etag'),
      lastModified: h.get('last-modified'),
      contentType: h.get('content-type'),
      filename: filenameFromContentDisposition(h.get('content-disposition')),
    };

    if (res.status === 206) {
      const range = parseContentRange(h.get('content-range'));
      return { ...base, size: range?.total ?? null, acceptRanges: true, responseCookies: jar.cookies || null };
    }
    if (res.status === 200) {
      const len = h.get('content-length');
      const size = len && /^\d+$/.test(len.trim()) ? Number(len) : null;
      return { ...base, size, acceptRanges: false, responseCookies: jar.cookies || null };
    }
    if (res.status === 416) {
      const range = parseContentRange(h.get('content-range'));
      return { ...base, size: range?.total ?? 0, acceptRanges: range?.total !== null && range?.total !== undefined, responseCookies: jar.cookies || null };
    }
    throw classifyHttpStatus(res.status, parseRetryAfter(h.get('retry-after')));
  } finally {
    disarm();
    res.body?.cancel().catch(() => {});
  }
}

/**
 * @param {string | null} header
 * @returns {{ start: number | null, end: number | null, total: number | null } | null}
 */
function parseContentRange(header) {
  if (!header) return null;
  const m = /^\s*bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)\s*$/i.exec(header);
  if (!m) return null;
  return {
    start: m[1] !== undefined ? Number(m[1]) : null,
    end: m[2] !== undefined ? Number(m[2]) : null,
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

/**
 * RFC 6266 / RFC 8187: prefers `filename*=charset''percent-encoded`, falls back to `filename=`.
 * @param {string | null} header
 * @returns {string | null}
 */
function filenameFromContentDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  if (star) {
    const raw = (star[1] ?? star[2] ?? '').trim();
    const parts = /^([^']*)'[^']*'(.*)$/.exec(raw);
    const encoded = parts ? parts[2] : raw;
    try {
      const decoded = decodeURIComponent(encoded);
      const clean = sanitizeFilename(decoded);
      if (clean) return clean;
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  if (plain) {
    const raw = (plain[1] !== undefined ? plain[1].replace(/\\(.)/g, '$1') : plain[2]).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
    const clean = sanitizeFilename(value);
    if (clean) return clean;
  }
  return null;
}

/**
 * @param {string} url
 * @returns {string | null}
 */
function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      /* keep raw */
    }
    return sanitizeFilename(decoded) || null;
  } catch {
    return null;
  }
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_FILENAME_LENGTH = 200;

/**
 * @param {string} input
 * @returns {string}
 */
function sanitizeFilename(input) {
  let name = basename(input.normalize('NFC').replace(/[\\/]/g, '_'));
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f:*?"<>|]/g, '_');
  name = name.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (RESERVED_NAMES.test(name)) name = `_${name}`;
  if (name.length > MAX_FILENAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  return name;
}

/**
 * @param {string} rawUrl
 * @returns {{ url: string, auth?: { username: string, password: string } }}
 */
function splitCredentials(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new DownloadError('INVALID_URL', `Invalid URL: ${rawUrl}`);
  }
  if (!/^https?:$/.test(u.protocol)) {
    throw new DownloadError('INVALID_URL', `Unsupported protocol: ${u.protocol}`);
  }
  if (!u.username && !u.password) return { url: u.toString() };
  const auth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  u.username = '';
  u.password = '';
  return { url: u.toString(), auth };
}

/**
 * @param {{ username: string, password: string }} auth
 * @returns {string}
 */
function basicAuthHeader(auth) {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
}

module.exports = {
  probeRemote,
  parseContentRange,
  filenameFromContentDisposition,
  filenameFromUrl,
  sanitizeFilename,
  splitCredentials,
  basicAuthHeader,
};
