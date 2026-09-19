const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');
const { EventEmitter } = require('events');

const {
  DownloadTask,
  DownloadEngineCoordinator,
  TokenBucket,
  hashFile,
  verifyChecksum,
  probeRemote,
} = require('./engine');

// ── DNS-over-HTTPS fallback ──────────────────────────────────────────────────
// Some Windows VPN, ISP and filtering DNS resolvers return NXDOMAIN for media
// CDN subdomains while Chromium still plays the same resource through Secure
// DNS. Node's `https.request` normally relies only on the Windows resolver,
// causing `getaddrinfo ENOTFOUND` even though the browser can download. Keep
// the OS resolver as the normal fast path, and query public DoH *only* after a
// DNS-name failure. The original hostname remains the HTTP Host and TLS SNI;
// only the socket address changes.
const DOH_ENDPOINTS = [
  'https://dns.google/resolve?name=',
  'https://cloudflare-dns.com/dns-query?name=',
];
const DOH_CACHE = new Map(); // hostname -> { address, expiresAt }
const DOH_MIN_TTL_MS = 60 * 1000;
const DOH_MAX_TTL_MS = 10 * 60 * 1000;

function isDnsLookupError(err) {
  return !!err && /ENOTFOUND|EAI_AGAIN|ENODATA|EAI_NONAME/i.test(String(err.code || err.message || ''));
}

function parseDohIPv4(payload) {
  const answers = payload && Array.isArray(payload.Answer) ? payload.Answer : [];
  for (const answer of answers) {
    const address = String(answer && answer.data || '').trim();
    if (answer && answer.type === 1 && net.isIP(address) === 4) {
      return { address, ttl: Number(answer.TTL) || 0 };
    }
  }
  return null;
}

async function resolveDohIPv4(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || net.isIP(host)) return null;
  const cached = DOH_CACHE.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.address;

  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const res = await fetch(endpoint + encodeURIComponent(host) + '&type=A', {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const record = parseDohIPv4(await res.json());
      if (!record) continue;
      const ttlMs = Math.max(DOH_MIN_TTL_MS, Math.min((record.ttl || 60) * 1000, DOH_MAX_TTL_MS));
      DOH_CACHE.set(host, { address: record.address, expiresAt: Date.now() + ttlMs });
      return record.address;
    } catch (e) { /* try the next public resolver */ }
  }
  return null;
}

/**
 * Node's request `lookup` callback with an opt-in-on-failure DoH fallback.
 * Injecting the two dependencies keeps this deterministic and unit-testable.
 */
function createDohFallbackLookup(nativeLookup = dns.lookup, resolveDoh = resolveDohIPv4) {
  return (hostname, options, callback) => {
    let opts = options;
    let done = callback;
    if (typeof options === 'function') {
      done = options;
      opts = {};
    }
    nativeLookup(hostname, opts || {}, async (err, address, family) => {
      if (!err) return done(null, address, family);
      if (!isDnsLookupError(err) || net.isIP(String(hostname || ''))) return done(err);
      try {
        const fallback = await resolveDoh(hostname);
        if (fallback) return done(null, fallback, 4);
      } catch (e) { /* report the original OS-DNS error below */ }
      return done(err);
    });
  };
}

const dohFallbackLookup = createDohFallbackLookup();

// Socket-level failures worth one more try before giving up (reset peers,
// half-open VPN tunnels, a DoH-resolved address that timed out once).
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETRESET', 'EADDRINUSE', 'UND_ERR_SOCKET', 'EAI_AGAIN',
]);
function isTransientNetError(err) {
  const code = (err && err.code) || '';
  if (TRANSIENT_NET_CODES.has(String(code))) return true;
  return /socket hang up|network is unreachable|other side closed/i.test(String((err && err.message) || ''));
}

/**
 * Aborts must not masquerade as generic network errors: `toDownloadError`
 * turns a plain Error into a *retryable* NETWORK failure, so a cancelled or
 * paused download would spin through its retry budget instead of stopping.
 */
function abortErrorFor(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('Request aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Fetch-compatible wrapper around Node http/https that preserves the robust
 * transport the old engine had: DoH DNS fallback and insecure-TLS retry.
 * Node's built-in `fetch` (undici) uses its own TLS stack and DNS, so sites
 * that worked with http.request silently started failing after the V4 rewrite.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, signal?: AbortSignal, redirect?: string }} [init]
 * @returns {Promise<Response>}
 */
function robustFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(e); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error('Unsupported protocol: ' + parsed.protocol));
      return;
    }

    const method = (init.method || 'GET').toUpperCase();
    const headers = { ...(init.headers || {}) };
    const signal = init.signal;
    // Cookie jar shared across the redirect chain (see jarHeader/jarNote):
    // servers that mint a token/session cookie on an intermediate hop expect
    // it back on the next one — a plain client drops it and gets refused.
    const jar = (init._jar && typeof init._jar.cookies === 'string') ? init._jar : { cookies: '' };

    const doRequest = (insecure, attempt = 0) => {
      const client = parsed.protocol === 'https:' ? https : http;
      /** @type {ReadableStreamDefaultController | null} */
      let bodyCtl = null;
      let responded = false;
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const failStream = (err) => {
        if (!bodyCtl) return;
        try { bodyCtl.error(err); } catch (e) { /* already closed */ }
      };

      const req = client.request({
        method,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: jarHeader(jar, headers),
        timeout: 30000,
        rejectUnauthorized: !insecure,
        lookup: dohFallbackLookup,
      }, (res) => {
        responded = true;
        // Follow redirects manually so we can re-apply DoH/TLS on the next hop
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && init.redirect !== 'manual') {
          jarNote(jar, res.headers);
          res.resume();
          try {
            const next = new URL(res.headers.location, url).href;
            robustFetch(next, { ...init, redirect: 'follow', _jar: jar }).then(
              (v) => settle(resolve, v),
              (e) => settle(reject, e),
            );
          } catch (e) { settle(reject, e); }
          return;
        }

        // Build a fetch-compatible Response from the Node stream
        const headerObj = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headerObj[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        }
        const bodyStream = res.statusCode === 204 || res.statusCode === 304
          ? null
          : new ReadableStream({
              start(controller) {
                bodyCtl = controller;
                res.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
                res.on('end', () => controller.close());
                res.on('error', (err) => failStream(err));
                // A server that hangs up mid-body must surface as a stream
                // error, not as a silently truncated download.
                res.on('close', () => {
                  if (!res.complete) failStream(new Error('Response ended prematurely'));
                });
              },
              cancel() { res.destroy(); },
            });
        const response = new Response(bodyStream, {
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: headerObj,
        });
        // ReadableStream body is consumed lazily; expose the final URL
        Object.defineProperty(response, 'url', { value: url, writable: false });
        settle(resolve, response);
      });

      req.on('error', (err) => {
        if (!insecure && isTlsError(err)) {
          doRequest(true, attempt);
          return;
        }
        if (!responded && attempt === 0 && isTransientNetError(err)) {
          doRequest(insecure, attempt + 1);
          return;
        }
        if (responded) { failStream(err); return; }
        settle(reject, err);
      });
      req.on('timeout', () => {
        const err = new Error('Connection timeout');
        if (responded) { failStream(err); try { req.destroy(); } catch (e) {} return; }
        try { req.destroy(); } catch (e) {}
        settle(reject, err);
      });

      function onAbort() {
        try { req.destroy(); } catch (e) {}
        if (responded) { failStream(abortErrorFor(signal)); return; }
        settle(reject, abortErrorFor(signal));
      }

      if (signal) {
        if (signal.aborted) { try { req.destroy(); } catch (e) {} settle(reject, abortErrorFor(signal)); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      req.end();
    };

    doRequest(false);
  });
}

/** Pull `name=value` pairs out of Set-Cookie response headers. */
function parseSetCookiePairs(headers) {
  const out = [];
  try {
    const sc = headers && headers['set-cookie'];
    const list = Array.isArray(sc) ? sc : (sc ? [sc] : []);
    for (const s of list) {
      const pair = String(s).split(';')[0].trim();
      if (pair && pair.includes('=')) out.push(pair);
    }
  } catch (e) { /* ignore malformed headers */ }
  return out;
}

/** Merge cookie pairs into an existing Cookie header value (later wins). */
function mergeCookieHeader(existing, extra) {
  const map = new Map();
  const eat = (s) => String(s || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) {
      const k = p.slice(0, i).trim();
      if (k) map.set(k, p.slice(i + 1).trim());
    }
  });
  eat(existing);
  eat(extra);
  return [...map].map(([k, v]) => k + '=' + v).join('; ');
}

/**
 * Minimal cookie jar for a redirect chain: replay cookies a server set
 * mid-chain (token/session issuers on /get_file/ flows) on later hops.
 * `jar` is `{ cookies: '' }` and mutates in place.
 */
function jarHeader(jar, headers) {
  if (!jar || !jar.cookies) return { ...(headers || {}) };
  const out = { ...(headers || {}) };
  const key = Object.keys(out).find((k) => k.toLowerCase() === 'cookie');
  if (key) out[key] = mergeCookieHeader(out[key], jar.cookies);
  else out.Cookie = jar.cookies;
  return out;
}

function jarNote(jar, resHeaders) {
  if (!jar) return;
  const pairs = parseSetCookiePairs(resHeaders);
  if (pairs.length) jar.cookies = mergeCookieHeader(jar.cookies, pairs.join('; '));
}

/**
 * Parse the attribute list of an `#EXT-X-KEY:` tag.
 * Returns raw (upper-cased key) attributes: METHOD, URI, IV, KEYFORMAT…
 */
function parseKeyAttrs(attrs) {
  const out = {};
  const get = (name) => {
    const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|([^,]*))', 'i');
    const mm = String(attrs || '').match(re);
    if (!mm) return null;
    return mm[1] !== undefined ? mm[1] : (mm[2] !== undefined ? mm[2].trim() : null);
  };
  out.METHOD = (get('METHOD') || 'NONE').toUpperCase();
  out.URI = get('URI');
  out.IV = get('IV');
  out.KEYFORMAT = get('KEYFORMAT');
  return out;
}

/**
 * Parse the first #EXT-X-KEY tag of an HLS playlist.
 * Returns { method, uri, iv, keyformat } or null when the playlist is clear.
 */
function parseHlsKey(text) {
  const m = String(text || '').match(/#EXT-X-KEY:([^\r\n]*)/i);
  if (!m) return null;
  const a = parseKeyAttrs(m[1]);
  return { method: a.METHOD, uri: a.URI, iv: a.IV, keyformat: a.KEYFORMAT };
}

/**
 * Read #EXT-X-MEDIA-SEQUENCE (used to derive implicit AES IVs).
 */
function parseHlsMediaSequence(text) {
  const m = String(text || '').match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Pull the server's own file name out of a `Content-Disposition` header.
 */
function filenameFromContentDisposition(cd) {
  if (!cd) return null;
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
  if (star && star[1]) {
    try {
      const n = decodeURIComponent(star[1].trim());
      if (n) return n;
    } catch (e) { /* fall through to plain filename */ }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(cd);
  if (quoted && quoted[1].trim()) return quoted[1].trim();
  const bare = /filename\s*=\s*([^;]+)/i.exec(cd);
  if (bare && bare[1].trim()) return bare[1].trim();
  return null;
}

/** Map common MIME types to an extension. */
const MIME_EXTENSIONS = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/mp2t': 'ts',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/webm': 'weba',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/x-7z-compressed': '7z',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/pdf': 'pdf',
  'application/octet-stream': '',
};

function extFromMime(ct) {
  if (!ct) return null;
  const clean = ct.split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS[clean] || null;
}

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
// Facebook's CDN rate-limits downloads that carry a browser User-Agent (see
// yt-dlp's facebook extractor, which pins this UA for the same reason). An
// explicitly captured browser UA is still honoured — this only changes the
// default for fbcdn/scontent/cdninstagram hosts.
const FB_CDN_RE = /fbcdn\.net|scontent\.|cdninstagram\.com/i;
const FB_UA = 'facebookexternalhit/1.1';

function buildRequestHeaders(url, callerHeaders = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(callerHeaders || {})) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      headers[k] = String(v);
    }
  }

  const hasKey = (name) => Object.keys(headers).some(k => k.toLowerCase() === name.toLowerCase());

  if (!hasKey('User-Agent')) {
    let fbHost = false;
    try { fbHost = FB_CDN_RE.test(new URL(url).hostname); } catch (e) { fbHost = false; }
    headers['User-Agent'] = fbHost ? FB_UA : CHROME_UA;
  }
  if (!hasKey('Accept')) {
    headers['Accept'] = '*/*';
  }
  if (!hasKey('Accept-Language')) {
    headers['Accept-Language'] = 'en-US,en;q=0.9';
  }

  // No invented Referer here: the manager replays the video page URL when it
  // knows one (required by anti-hotlink CDNs like bigcdn.cc), and for a bare
  // URL with no page context omitting Referer matches browser behaviour.
  // The old fallback sent the CDN's own origin as Referer, which hotlink
  // protection rejects outright (mysterious 403s on otherwise good links).

  return headers;
}

class HttpError extends Error {
  constructor(message, status, url, contentType = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.contentType = contentType;
  }
}

function isTlsError(err) {
  const code = (err && err.code) || '';
  const msg = (err && err.message) || '';
  return /SELF_SIGNED|CERT_|DEPTH_ZERO_SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID/i.test(code) ||
         /certificate|ssl|tls/i.test(msg);
}

function hlsFetchError(what, err) {
  if (err instanceof HttpError) {
    if (err.status === 403 || err.status === 401) {
      return `Access denied (${err.status}) fetching the ${what}. The link may require cookies or an active login.`;
    }
    if (err.status === 404) {
      return `Stream ${what} was not found (404). The stream may have ended or the link has expired.`;
    }
    return `Server returned HTTP ${err.status} while fetching the ${what}.`;
  }
  if (isDnsLookupError(err)) {
    return `Could not resolve the stream host for the ${what} (${err.code || 'DNS failure'}).`;
  }
  return `Could not fetch the ${what}: ${err.message || String(err)}`;
}

const LIVE_DEFAULT_SECONDS = 3 * 3600;

/**
 * Next-Gen AiDM Download Engine (v4.0.0)
 * Combining IDM-style dynamic segment splitting, positional file I/O, mirror pools,
 * atomic .part.meta control file recovery, TokenBucket rate limiting, and full HLS support.
 */
class DownloadEngine extends EventEmitter {
  constructor() {
    super();
    this.coordinator = new DownloadEngineCoordinator();
    this.activeTasks = new Map();     // downloadId -> DownloadTask
    this.activeSegments = new Map();  // downloadId -> HLS or wrapper download record
    this.globalSpeedLimit = 0;        // bytes/sec, 0 = unlimited
    this.globalLimiter = new TokenBucket(0);
    this.hlsConcurrency = 6;          // parallel segment fetches for HLS streams
  }

  /** Set a global download speed limit (bytes/sec). 0 disables the limit. */
  setSpeedLimit(bytesPerSec) {
    this.globalSpeedLimit = Math.max(0, parseInt(bytesPerSec, 10) || 0);
    this.globalLimiter.setRate(this.globalSpeedLimit);
    this.coordinator.setGlobalSpeedLimit(this.globalSpeedLimit);
  }

  /** Parallel segment fetches used by the HLS downloader (1-16). */
  setHlsConcurrency(n) {
    this.hlsConcurrency = Math.max(1, Math.min(parseInt(n, 10) || 6, 16));
  }

  _throttle(bytes) {
    return this.globalLimiter.acquire(bytes);
  }

  /**
   * Start or resume a multi-segment download using the Next-Gen V4 Engine.
   */
  async startDownload({
    id,
    url,
    filepath,
    totalSegments = 8,
    headers = {},
    meta: preProbed = null,
    resumeOffsets = null,
    mirrors = [],
    checksum = null,
    // 'rename' is the default: a re-added / re-run download must never rm()
    // an already finished file of the same name. Callers that really want to
    // replace one pass 'overwrite' explicitly.
    onConflict = 'rename',
    // File-hoster links (team B/F) reject Range: one plain connection.
    singleConnection = false,
    resumable = null,
    resumeable = null,
  }) {
    // 1. Handle data: URLs directly
    if (typeof url === 'string' && url.startsWith('data:')) {
      const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
      if (!m) throw new Error('Malformed data: URL');
      const payload = m[3] || '';
      const buf = m[2]
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8');
      const dir = path.dirname(filepath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filepath, buf);

      const fakeDl = {
        id, url, filepath, totalSegments: 1, segments: [{ index: 0, status: 'completed', downloaded: buf.length }],
        totalSize: buf.length, downloadedSize: buf.length, status: 'completed',
      };
      this.activeSegments.set(id, fakeDl);

      this.emit('download-complete', { id, filepath, totalSize: buf.length, duration: 0 });
      this._hashFileAsync(id, filepath);
      return fakeDl;
    }

    // 2. Multi-segment download powered by DownloadTask
    const dir = path.dirname(filepath);
    const filename = path.basename(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const reqHeaders = buildRequestHeaders(url, headers);
    const wantsSingle = singleConnection === true || !!(preProbed && preProbed.singleConnection);
    const maxConn = wantsSingle ? 1 : Math.max(1, Math.min(totalSegments || 8, 32));

    const taskOptions = {
      id,
      url,
      directory: dir,
      filename,
      mirrors: Array.isArray(mirrors) ? mirrors : [],
      headers: reqHeaders,
      maxConnections: maxConn,
      initialConnections: Math.min(maxConn, 4),
      minSplitSize: 1024 * 1024,
      adaptiveConnections: !wantsSingle,
      pieceSelection: 'largest',
      preallocation: 'sparse',
      onConflict: ['rename', 'overwrite', 'fail'].includes(onConflict) ? onConflict : 'rename',
      singleConnection: wantsSingle,
      resumable: resumable === false || resumeable === false ? false : true,
      speedLimit: this.globalSpeedLimit || 0,
      checksum: checksum || undefined,
      resumeOffsets: resumeOffsets || null,
      // Use the robust http/https transport (DoH fallback + insecure-TLS retry)
      // instead of Node's built-in fetch, which uses undici's stricter TLS/DNS.
      fetch: robustFetch,
    };

    const task = new DownloadTask(taskOptions, { globalLimiter: this.globalLimiter });
    this.activeTasks.set(id, task);

    const startTime = Date.now();
    let totalSize = (preProbed && preProbed.contentLength) || 0;
    let initialEmitted = false;

    // Create backward-compatible download record for getDownload(id)
    const downloadRecord = {
      id,
      url,
      filepath,
      headers: reqHeaders,
      totalSegments: maxConn,
      startTime,
      cancelled: false,
      task,
      get status() {
        const st = task.state;
        if (st === 'probing') return 'connecting';
        if (st === 'verifying') return 'downloading';
        return st;
      },
      get downloadedSize() {
        return task.getProgress().downloadedBytes;
      },
      get totalSize() {
        return task.getProgress().totalBytes || totalSize;
      },
      get segments() {
        const p = task.getProgress();
        return (p.segments || []).map((s) => ({
          index: s.id - 1,
          status: s.state === 'done' ? 'completed' : s.state === 'active' ? 'downloading' : 'pending',
          downloaded: s.downloaded,
          start: s.start,
          end: s.end,
        }));
      },
    };
    this.activeSegments.set(id, downloadRecord);

    task.on('state', (cur, prev) => {
      if (cur === 'downloading') {
        const prog = task.getProgress();
        this.emit('download-progress', {
          id,
          downloaded: prog.downloadedBytes,
          totalSize: prog.totalBytes,
          total: prog.totalBytes,
          speed: 0,
          percent: 0,
          segments: [],
        });
        if (prev === 'paused') {
          this.emit('download-resumed', { id });
        }
      } else if (cur === 'paused') {
        this.emit('download-paused', { id });
      }
    });

    task.on('progress', (prog) => {
      totalSize = prog.totalBytes || totalSize;
      const segs = (prog.segments || []).map((s) => ({
        index: s.id - 1,
        status: s.state === 'done' ? 'completed' : s.state === 'active' ? 'downloading' : 'pending',
        downloaded: s.downloaded,
        start: s.start,
        end: s.end,
      }));

      this.emit('download-progress', {
        id,
        downloaded: prog.downloadedBytes,
        totalSize: prog.totalBytes,
        total: prog.totalBytes,
        speed: prog.speed,
        percent: prog.percent !== null ? Number(prog.percent).toFixed(1) : 0,
        segments: segs,
      });
    });

    task.on('completed', (info) => {
      this.activeTasks.delete(id);
      this.activeSegments.delete(id);
      const outPath = info.path || filepath;
      // Never lie about completion: when the real size is known the bytes on
      // disk must match it, otherwise the UI would show a "finished" file that
      // cannot be opened.
      const knownTotal = task.getProgress().totalBytes;
      let onDisk = -1;
      try { onDisk = fs.statSync(outPath).size; } catch (e) { onDisk = -1; }
      if (knownTotal && ((info.bytes && info.bytes < knownTotal) || (onDisk >= 0 && onDisk < knownTotal))) {
        this.emit('download-error', {
          id,
          error: `Download is incomplete: ${Math.min(info.bytes || onDisk, onDisk < 0 ? (info.bytes || 0) : onDisk)} of ${knownTotal} bytes written`,
        });
        return;
      }
      this.emit('download-complete', {
        id,
        filepath: outPath,
        totalSize: info.bytes || onDisk,
        duration: info.elapsedMs || (Date.now() - startTime),
      });
      this._hashFileAsync(id, outPath);
    });

    task.on('failed', (err) => {
      this.activeTasks.delete(id);
      this.activeSegments.delete(id);
      this.emit('download-error', {
        id,
        error: err.message || 'Download failed',
      });
    });

    // Start asynchronously
    task.start().catch((err) => {
      this.activeTasks.delete(id);
      this.activeSegments.delete(id);
      this.emit('download-error', { id, error: err.message });
    });

    return downloadRecord;
  }

  pauseDownload(id) {
    const task = this.activeTasks.get(id);
    if (task) {
      task.pause().catch(() => {});
      return;
    }

    const hlsDl = this.activeSegments.get(id);
    if (hlsDl && hlsDl.hls) {
      hlsDl.status = 'paused';
      if (hlsDl.currentReq) {
        try { hlsDl.currentReq.destroy(); } catch (e) {}
        hlsDl.currentReq = null;
      }
      if (hlsDl.hlsReqs) {
        hlsDl.hlsReqs.forEach((req) => { try { req.destroy(); } catch (e) {} });
        hlsDl.hlsReqs.clear();
      }
      hlsDl.segments.forEach((seg) => { seg.status = 'paused'; });
      this.emit('download-paused', { id });
    }
  }

  resumeDownload(id) {
    const task = this.activeTasks.get(id);
    if (task) {
      task.resume().catch(() => {});
      return;
    }

    const hlsDl = this.activeSegments.get(id);
    if (hlsDl && hlsDl.hls) {
      hlsDl.status = 'downloading';
      hlsDl.cancelled = false;
      hlsDl.startTime = Date.now();
      this.emit('download-resumed', { id });
      this.startHlsDownload({
        id,
        url: hlsDl.url,
        filepath: hlsDl.filepath,
        headers: hlsDl.headers || {},
        expectedSize: hlsDl.totalSize || 0,
        variantUrl: hlsDl.hlsVariantUrl || null,
        maxSeconds: hlsDl.maxSeconds || 0,
      }).catch(() => {});
    }
  }

  cancelDownload(id) {
    const task = this.activeTasks.get(id);
    if (task) {
      const isCompleted = task.state === 'completed';
      task.cancel({ deleteFiles: !isCompleted }).catch(() => {});
      this.activeTasks.delete(id);
    }

    const dl = this.activeSegments.get(id);
    if (dl) {
      const wasCompleted = dl.status === 'completed';
      dl.cancelled = true;
      if (dl.currentReq) {
        try { dl.currentReq.destroy(); } catch (e) {}
        dl.currentReq = null;
      }
      if (dl.hlsReqs) {
        dl.hlsReqs.forEach((req) => { try { req.destroy(); } catch (e) {} });
        dl.hlsReqs.clear();
      }
      // Only assign status for HLS-style records (plain property). Task-backed
      // records expose status as a computed getter from task.state — assigning
      // throws a TypeError. The task.cancel() call above already handles state.
      try { dl.status = 'cancelled'; } catch (_) { /* getter-only: task record */ }
      if (!wasCompleted) {
        // For task-backed downloads, file deletion is handled by task.cancel()
        // (deleteFiles: true). For HLS/legacy records, clean up manually.
        if (!dl.task) {
          try { fs.unlinkSync(dl.filepath); } catch (e) {}
          try { fs.unlinkSync(`${dl.filepath}.part`); } catch (e) {}
          try { fs.unlinkSync(`${dl.filepath}.part.meta`); } catch (e) {}
        }
      }
      this.activeSegments.delete(id);
    }
  }

  getDownload(id) {
    return this.activeSegments.get(id) || this.activeTasks.get(id) || null;
  }

  /** Background SHA-256 calculation emitting download-hash */
  _hashFileAsync(downloadId, filepath) {
    try {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filepath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => {
        this.emit('download-hash', { id: downloadId, sha256: hash.digest('hex') });
      });
      stream.on('error', () => {});
    } catch (e) {}
  }

  _openRequest(url, { method = 'HEAD', headers = {}, timeout = 15000, insecure = false } = {}) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${url}`));
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return reject(new Error('Unsupported protocol: ' + parsed.protocol));
      }
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request({
        method,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: buildRequestHeaders(url, headers),
        timeout,
        rejectUnauthorized: !insecure,
        lookup: dohFallbackLookup,
      }, (res) => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          url,
          destroy: () => {
            try { res.destroy(); } catch (e) {}
            try { req.destroy(); } catch (e) {}
          },
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        try { req.destroy(); } catch (e) {}
        reject(new Error('Connection timeout during probe'));
      });
      req.end();
    });
  }

  async _openRequestAuto(url, opts = {}) {
    try {
      return await this._openRequest(url, opts);
    } catch (e) {
      if (isTlsError(e) && !opts.insecure) {
        return this._openRequest(url, { ...opts, insecure: true });
      }
      throw e;
    }
  }

  async _probeFile(url, extraHeaders = {}, redirectCount = 0, jar = null) {
    if (redirectCount > 5) throw new Error('Too many redirects');
    jar = jar || { cookies: '' };
    const headers = jarHeader(jar, { ...extraHeaders });

    const redirectTo = (r) => {
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        try { return new URL(r.headers.location, r.url).href; } catch (e) { return null; }
      }
      return null;
    };

    let head = null;
    try {
      head = await this._openRequestAuto(url, { method: 'HEAD', headers });
      jarNote(jar, head.headers);
    } catch (e) {
      head = null;
    }
    if (head) {
      const loc = redirectTo(head);
      if (loc) { head.destroy(); return this._probeFile(loc, extraHeaders, redirectCount + 1, jar); }
    }
    if (!head || head.status === 405 || head.status === 403 || head.status === 501 || head.status === 401) {
      if (head) head.destroy();
      head = await this._openRequestAuto(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' } });
      jarNote(jar, head.headers);
      const loc = redirectTo(head);
      if (loc) { head.destroy(); return this._probeFile(loc, extraHeaders, redirectCount + 1, jar); }
    }

    const contentType = head.headers['content-type'] || '';
    const contentDisposition = head.headers['content-disposition'] || '';
    let contentLength = parseInt(head.headers['content-length'], 10) || 0;

    let supportsRange = false;
    let rangeProbe = null;
    try {
      rangeProbe = await this._openRequestAuto(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-1' } });
      jarNote(jar, rangeProbe.headers);
      const loc = redirectTo(rangeProbe);
      if (loc) {
        rangeProbe.destroy();
        head.destroy();
        return this._probeFile(loc, extraHeaders, redirectCount + 1, jar);
      }
      if (rangeProbe.status === 206) {
        supportsRange = true;
        const cr = rangeProbe.headers['content-range'];
        const m = cr && /\/(\d+|\*)\s*$/.exec(cr);
        if (m && m[1] !== '*') contentLength = parseInt(m[1], 10) || contentLength;
      } else if (rangeProbe.status === 200) {
        const l = parseInt(rangeProbe.headers['content-length'], 10);
        if (l) contentLength = l;
        supportsRange = false;
      }
    } catch (e) {
      supportsRange = false;
    } finally {
      if (rangeProbe) rangeProbe.destroy();
    }

    // Plain-GET fallback: some tube/CDN hosts (WAF, mod_security, hotlink
    // rules) reject HEAD and Range probes with 401/403 yet serve a plain
    // browser-style GET just fine — a native browser download IS a plain GET,
    // so try one (headers only, body destroyed unread) before reporting the
    // URL as refused. Success means single-connection, Range-free download.
    const probesBlocked = (head.status === 401 || head.status === 403) &&
      (!rangeProbe || rangeProbe.status === 401 || rangeProbe.status === 403);
    if (probesBlocked) {
      let plain = null;
      try {
        plain = await this._probePlainGet(url, extraHeaders, 0, jar);
        if (plain && plain.status === 200) {
          const pct = plain.headers['content-type'] || '';
          const pcd = plain.headers['content-disposition'] || '';
          const pcl = parseInt(plain.headers['content-length'], 10) || 0;
          const res = {
            contentLength: pcl,
            supportsRange: false,
            rangesBlocked: true,
            finalUrl: plain.url,
            contentType: pct,
            contentDisposition: pcd,
            suggestedFilename: filenameFromContentDisposition(pcd),
            headers: plain.headers,
            status: 200,
            responseCookies: jar.cookies || null,
          };
          plain.destroy();
          head.destroy();
          return res;
        }
      } catch (e) { /* plain GET also failed — report the probe status below */ }
      finally {
        if (plain) { try { plain.destroy(); } catch (e) {} }
      }
    }

    const result = {
      contentLength,
      supportsRange,
      finalUrl: url,
      contentType,
      contentDisposition,
      suggestedFilename: filenameFromContentDisposition(contentDisposition),
      headers: head.headers,
      status: head.status,
      responseCookies: jar.cookies || null,
    };
    head.destroy();
    return result;
  }

  /**
   * Headers-only plain GET (no Range), following redirects with the cookie
   * jar. The body is never read — the caller destroys the response. Used when
   * a host blocks HEAD/Range probes but serves browser-style GETs.
   */
  async _probePlainGet(url, extraHeaders = {}, redirectCount = 0, jar = null) {
    if (redirectCount > 5) throw new Error('Too many redirects');
    jar = jar || { cookies: '' };
    const r = await this._openRequestAuto(url, { method: 'GET', headers: jarHeader(jar, { ...extraHeaders }) });
    jarNote(jar, r.headers);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      try {
        const loc = new URL(r.headers.location, r.url).href;
        r.destroy();
        return this._probePlainGet(loc, extraHeaders, redirectCount + 1, jar);
      } catch (e) { /* malformed Location — return the response as-is */ }
    }
    return r;
  }

  probeMeta(url, headers = {}) {
    return this._probeFile(url, headers);
  }

  async probeHlsSize(url, headers = {}) {
    try {
      const fetched = await this._fetchUrl(url, { headers });
      let text = fetched.text;
      let mediaUrl = fetched.finalUrl;
      if (!/#EXTM3U/i.test(text)) return { size: 0, estimated: false, count: 0, duration: 0 };

      if (/#EXT-X-STREAM-INF/i.test(text)) {
        const variants = parseHlsMaster(text, mediaUrl);
        if (variants.length) {
          // Same variant the downloader will actually take — otherwise the
          // estimate describes a rendition the user never receives.
          const chosen = pickHlsVariant(variants, text);
          const vFetched = await this._fetchUrl(chosen.url, { headers });
          text = vFetched.text;
          mediaUrl = vFetched.finalUrl;
        }
      }

      const parsed = parseHlsMedia(text, mediaUrl);
      const segCount = parsed.segs.length;
      const duration = sumHlsDuration(text);
      let totalRangeBytes = 0;
      let hasRanges = false;
      for (const s of parsed.segs) {
        if (s.range && s.range.length > 0) {
          totalRangeBytes += s.range.length;
          hasRanges = true;
        }
      }
      if (hasRanges && totalRangeBytes > 0) {
        return { size: totalRangeBytes, estimated: false, count: segCount, duration };
      }

      if (segCount > 0) {
        const sampleCount = Math.min(3, segCount);
        let sampleTotal = 0;
        let samplesRead = 0;
        for (let i = 0; i < sampleCount; i++) {
          try {
            const probe = await this._openRequestAuto(parsed.segs[i].url, { method: 'HEAD', headers });
            const cl = parseInt(probe.headers['content-length'], 10);
            probe.destroy();
            if (cl > 0) { sampleTotal += cl; samplesRead++; }
          } catch (e) {}
        }
        if (samplesRead > 0) {
          const avg = sampleTotal / samplesRead;
          return { size: Math.round(avg * segCount), estimated: true, count: segCount, duration };
        }
      }

      if (duration > 0) {
        return { size: Math.round(duration * 300 * 1024), estimated: true, count: segCount, duration };
      }
      return { size: 0, estimated: false, count: segCount, duration: 0 };
    } catch (e) {
      return { size: 0, estimated: false, count: 0, duration: 0 };
    }
  }

  _fetchUrl(url, { headers = {}, timeoutMs = 30000, maxRedirects = 5, onRequest = null, insecure = false, method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
      // Replay cookies set mid-redirect-chain on later hops (token/session
      // issuers on /get_file/-style flows) — a plain client would drop them.
      const jar = { cookies: '' };
      const doFetch = (currentUrl, redirectsLeft, allowInsecure) => {
        let parsed;
        try {
          parsed = new URL(currentUrl);
        } catch (e) {
          reject(e);
          return;
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          reject(new Error('Unsupported protocol: ' + parsed.protocol));
          return;
        }
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request({
          method,
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          headers: buildRequestHeaders(currentUrl, jarHeader(jar, headers)),
          timeout: timeoutMs,
          rejectUnauthorized: !allowInsecure,
          lookup: dohFallbackLookup,
        }, (res) => {
          jarNote(jar, res.headers);
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            try {
              doFetch(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1, allowInsecure);
            } catch (e) {
              reject(e);
            }
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            reject(new HttpError(
              `HTTP ${res.statusCode} for ${currentUrl}`,
              res.statusCode,
              currentUrl,
              res.headers['content-type'] || ''
            ));
            return;
          }
          const chunks = [];
          const declared = parseInt(res.headers['content-length'], 10);
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            // A body shorter than Content-Length means the socket died mid
            // transfer. Without this the caller happily writes a truncated
            // HLS segment / manifest and reports success.
            if (method !== 'HEAD' && Number.isFinite(declared) && declared > 0 && buf.length < declared) {
              reject(new Error(`Incomplete response: expected ${declared} bytes, received ${buf.length}`));
              return;
            }
            resolve({
              buf,
              text: buf.toString('utf8'),
              finalUrl: currentUrl,
              status: res.statusCode,
              contentType: res.headers['content-type'] || '',
            });
          });
          res.on('error', reject);
        });
        req.on('error', (e) => {
          if (isTlsError(e) && !allowInsecure) {
            doFetch(currentUrl, redirectsLeft, true);
            return;
          }
          reject(e);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout for ' + currentUrl)); });
        if (onRequest) onRequest(req);
        req.end();
      };
      doFetch(url, maxRedirects, insecure);
    });
  }

  async startHlsDownload({ id, url, filepath, headers = {}, expectedSize = 0, variantUrl = null, maxSeconds = 0, concurrency = 0, resumeIndex: resumeIndexArg = 0, resumeBytes: resumeBytesArg = 0 }) {
    let download = this.activeSegments.get(id);
    // Resume state comes from two sources: an in-memory engine record
    // (pause → resume in the same session) or explicit params from the
    // manager's persisted row (resume after an app restart — the engine has
    // no record then, and without the params the file was re-opened 'w' and
    // every segment re-downloaded from zero).
    const resumeIndex = (download && download.hlsResumeIndex) || resumeIndexArg || 0;
    const resumeBytes = (download && download.hlsResumeBytes) || resumeBytesArg || 0;
    if (!download) {
      download = {
        id, url, filepath, headers,
        finalUrl: url,
        totalSegments: 1,
        segments: [{ index: 0, downloaded: 0, status: 'active', retries: 0, maxRetries: 3 }],
        totalSize: 0,
        downloadedSize: 0,
        startTime: Date.now(),
        speed: 0,
        status: 'downloading',
        hls: true,
        cancelled: false,
        currentReq: null,
      };
      this.activeSegments.set(id, download);
    } else if (resumeIndex > 0) {
      download.status = 'downloading';
      download.downloadedSize = resumeBytes;
      download._speedSamples = [];
    } else {
      download.status = 'downloading';
      download.startTime = Date.now();
      download.downloadedSize = 0;
      download._speedSamples = [];
      if (expectedSize <= 0) download.totalSize = 0;
    }

    const hlsReqs = new Set();
    download.hlsReqs = hlsReqs;
    if (expectedSize > 0) download.totalSize = expectedSize;

    let isLive = false;
    let queueLen = 0;
    let lastEmit = 0;
    let fd = null;

    const emitProgress = (doneCount) => {
      const now = Date.now();
      if (now - lastEmit < 200 && doneCount !== queueLen) return;
      lastEmit = now;
      const elapsed = (now - download.startTime) / 1000;
      download.speed = elapsed > 0 ? download.downloadedSize / elapsed : 0;
      download.segments[0].downloaded = download.downloadedSize;
      let percent = 0;
      if (isLive) {
        const limit = maxSeconds > 0 ? maxSeconds : LIVE_DEFAULT_SECONDS;
        percent = Math.min(100, (elapsed / limit) * 100).toFixed(1);
      } else if (queueLen > 0) {
        percent = (doneCount / queueLen * 100).toFixed(1);
      }
      this.emit('download-progress', {
        id,
        downloaded: download.downloadedSize,
        total: download.totalSize,
        totalSize: download.totalSize,
        speed: download.speed,
        percent,
        segments: download.segments.map(s => ({ index: s.index, downloaded: s.downloaded, status: s.status })),
        // Restart resume: the manager persists these with the row and feeds
        // them back after an app restart (the engine record is gone then).
        hlsResumeIndex: download.hlsResumeIndex || 0,
        hlsResumeBytes: download.hlsResumeBytes || 0,
      });
    };

    const fail = (msg) => {
      download.status = 'error';
      download.error = msg;
      download.segments.forEach(s => { s.status = 'error'; });
      this.emit('download-error', { id, error: msg });
      throw new Error(msg);
    };

    // Generation token: bumped on cancel/pause so in-flight workers and the
    // flusher stop touching `fd` and the file. Without it, cancelDownload
    // unlinked the file while a worker was still fs.writeSync-ing (EBADF →
    // spurious download-error for a deleted id) and a resume re-opened 'w'
    // while the old run's workers were still draining (two writers, one fd).
    let hlsGen = (download._hlsGen || 0) + 1;
    download._hlsGen = hlsGen;
    const genDead = () => download._hlsGen !== hlsGen || stopped();

    const fetchTracked = async (u, opts) => {
      let req = null;
      try {
        return await this._fetchUrl(u, {
          ...opts,
          onRequest: (r) => { req = r; hlsReqs.add(r); download.currentReq = r; },
        });
      } finally {
        if (req) {
          hlsReqs.delete(req);
          if (download.currentReq === req) download.currentReq = null;
        }
      }
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const stopped = () => download.cancelled || download.status === 'paused' || download.status === 'error';

    // Real geometry, proven from the container bytes of the first segments
    // (src/media-probe.js, team A) — never guessed from a quality label.
    let geometryTries = 0;
    const applyGeometry = (buf) => {
      if (download.media || geometryTries >= 3 || !buf || !buf.length) return;
      geometryTries++;
      let info = null;
      try {
        const mp = require('./media-probe');
        if (mp && typeof mp.probeBuffer === 'function') info = mp.probeBuffer(buf);
      } catch (e) { info = null; }
      if (!info) return;
      download.media = {
        width: info.width || 0,
        height: info.height || 0,
        durationSec: info.durationSec || 0,
        hasVideo: !!info.hasVideo,
        hasAudio: !!info.hasAudio,
        vcodec: info.vcodec || null,
        acodec: info.acodec || null,
        container: info.container || null,
        probedAt: Date.now(),
      };
      download.audioMissing = !!info.hasVideo && !info.hasAudio;
      if (info.width && info.height) {
        download.width = info.width;
        download.height = info.height;
        if (download.hlsVariant) {
          download.hlsVariant.width = info.width;
          download.hlsVariant.height = info.height;
        }
      }
      if (info.hasAudio && download.hlsVariant) download.hlsVariant.hasAudio = true;
    };

    try {
      let fetched;
      try {
        fetched = await fetchTracked(url, { headers });
      } catch (err) {
        return fail(hlsFetchError('stream playlist', err));
      }
      let text = fetched.text;
      let mediaUrl = fetched.finalUrl;
      download.finalUrl = mediaUrl;

      if (!/#EXTM3U/i.test(text)) {
        return fail('Stream playlist is not a valid HLS manifest (server returned ' +
          (fetched.contentType || 'an unexpected response') + ')');
      }

      for (let depth = 0; depth < 4 && /#EXT-X-STREAM-INF/i.test(text); depth++) {
        const skm = text.match(/#EXT-X-SESSION-KEY:([^\r\n]*)/i);
        if (skm) {
          const a = parseKeyAttrs(skm[1]);
          const kf = (a.KEYFORMAT || 'identity').toLowerCase();
          const plain = a.METHOD === 'AES-128' && (kf === 'identity' || kf === '' || kf === 'null');
          if (a.METHOD !== 'NONE' && !plain) return fail('DRM-protected stream is not supported');
        }
        const variants = parseHlsMaster(text, mediaUrl);
        if (!variants.length) return fail('Stream playlist has no playable variants');
        // Prefer a variant that actually carries audio: master playlists
        // routinely offer video-only renditions at the top bitrate, and
        // taking one produces a mute file.
        const chosen = (variantUrl && variants.find(v => v.url === variantUrl)) || pickHlsVariant(variants, text);
        download.hlsVariantUrl = chosen.url;
        download.hlsVariant = {
          url: chosen.url,
          width: chosen.width || 0,
          height: chosen.height || 0,
          bandwidth: chosen.bandwidth || 0,
          frameRate: chosen.frameRate || 0,
          codecs: chosen.codecs || null,
          audioGroupId: chosen.audio || null,
          hasAudio: hlsVariantAudioScore(chosen, parseHlsAudioGroups(text)) > 0,
        };
        download.width = download.hlsVariant.width;
        download.height = download.hlsVariant.height;
        try {
          fetched = await fetchTracked(chosen.url, { headers });
        } catch (err) {
          return fail(hlsFetchError('stream variant', err));
        }
        text = fetched.text;
        mediaUrl = fetched.finalUrl;
      }
      if (stopped()) return;

      // A bare media playlist (no master) still gets a variant record so the
      // manager has somewhere to read geometry from.
      if (!download.hlsVariant) {
        download.hlsVariant = {
          url: mediaUrl, width: 0, height: 0, bandwidth: 0, frameRate: 0,
          codecs: null, audioGroupId: null, hasAudio: null,
        };
      }

      isLive = !/#EXT-X-ENDLIST/i.test(text);
      download.isLive = isLive;
      const targetDuration = parseInt((/^#EXT-X-TARGETDURATION:(\d+)/im.exec(text) || [])[1], 10) || 4;

      const parsed = parseHlsMedia(text, mediaUrl);
      const mediaSeq = parseHlsMediaSequence(text);
      if (!parsed.segs.length) return fail('Stream playlist contains no segments');
      if (!isLive && parsed.segs.length > 20000) return fail('Stream too long (>20000 segments)');

      const queue = [];
      const pushSegs = (segs, baseSeq) => {
        segs.forEach((s, i) => queue.push({ url: s.url, range: s.range, key: s.key || null, seq: baseSeq + i }));
      };
      if (parsed.mapUri) {
        queue.push({ url: parsed.mapUri, range: parsed.mapRange, key: null, seq: -1, init: true });
      }
      pushSegs(parsed.segs, mediaSeq);
      let lastSeq = mediaSeq + parsed.segs.length - 1;
      queueLen = queue.length;

      let writePos = 0;
      let startIdx = resumeIndex;
      try {
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (startIdx > 0 && fs.existsSync(filepath) && fs.statSync(filepath).size === resumeBytes) {
          fd = fs.openSync(filepath, 'a');
          writePos = resumeBytes;
        } else if (startIdx > 0) {
          startIdx = 0;
        }
        if (fd === null) fd = fs.openSync(filepath, 'w');
      } catch (openErr) {
        return fail(`Cannot create output file: ${openErr.message}`);
      }

      const keyCache = new Map();
      const getKey = async (attrs) => {
        if (!attrs) return null;
        const kf = (attrs.KEYFORMAT || 'identity').toLowerCase();
        if (!(attrs.METHOD === 'AES-128' && (kf === 'identity' || kf === '' || kf === 'null'))) {
          throw new Error('Unsupported stream protection: ' + attrs.METHOD +
            (kf && kf !== 'identity' ? ' (' + kf + ')' : '') + ' — DRM is not supported');
        }
        if (!attrs.URI) throw new Error('Encrypted stream (AES-128) has no key URI');
        let keyUrl;
        try { keyUrl = new URL(attrs.URI, mediaUrl).href; }
        catch (e) { throw new Error('Encrypted stream has an invalid key URI'); }
        if (keyCache.has(keyUrl)) return keyCache.get(keyUrl);
        let kr;
        try {
          kr = await fetchTracked(keyUrl, { headers });
        } catch (err) {
          throw new Error('Could not fetch decryption key: ' + err.message);
        }
        if (!kr.buf || kr.buf.length < 16) throw new Error('Invalid AES-128 key (expected 16 bytes)');
        let iv = null;
        if (attrs.IV) {
          const ivBuf = Buffer.from(String(attrs.IV).replace(/^0x/i, ''), 'hex');
          if (ivBuf.length === 16) iv = ivBuf;
        }
        const entry = { key: kr.buf.slice(0, 16), iv };
        keyCache.set(keyUrl, entry);
        return entry;
      };

      const pending = new Map();
      let writeIdx = startIdx;
      let nextIndex = startIdx;
      let liveDone = false;
      let firstError = null;

      const flush = () => {
        while (pending.has(writeIdx)) {
          const item = pending.get(writeIdx);
          pending.delete(writeIdx);
          // A pause/cancel during a pending fetch: this run is obsolete — its
          // fd belongs to a previous generation. Drop the buffer instead of
          // writing into a file that may already be unlinked or re-opened.
          if (genDead()) return;
          let buf = item.buf;
          if (item.key && item.key.key) {
            let iv = item.key.iv;
            if (!iv) {
              iv = Buffer.alloc(16);
              iv.writeUInt32BE((item.seq >>> 0), 12);
            }
            try {
              const decipher = crypto.createDecipheriv('aes-128-cbc', item.key.key, iv);
              buf = Buffer.concat([decipher.update(buf), decipher.final()]);
            } catch (e) {
              throw new Error('Failed to decrypt segment ' + (writeIdx + 1) + ': ' + e.message);
            }
          }
          try {
            fs.writeSync(fd, buf, 0, buf.length, writePos);
          } catch (writeErr) {
            throw new Error(`Write failed: ${writeErr.message}`);
          }
          writePos += buf.length;
          writeIdx++;
          download.downloadedSize = writePos;
          download.hlsResumeIndex = writeIdx;
          download.hlsResumeBytes = writePos;
          emitProgress(writeIdx);
        }
      };

      const worker = async () => {
        for (;;) {
          if (genDead() || liveDone) return;
          if (nextIndex >= queue.length) {
            if (!isLive) return;
            await sleep(250);
            continue;
          }
          const idx = nextIndex++;
          const seg = queue[idx];
          let buf = null;
          let lastErr = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (genDead() || liveDone) return;
            try {
              const segHeaders = seg.range
                ? { ...headers, Range: `bytes=${seg.range.offset}-${seg.range.offset + seg.range.length - 1}` }
                : headers;
              const r = await fetchTracked(seg.url, { headers: segHeaders, timeoutMs: 45000 });
              buf = r.buf;
              if (this.globalSpeedLimit > 0) {
                await this._throttle(buf.length);
                if (stopped()) return;
              }
              if (seg.range && r.status !== 206 && buf.length > seg.range.length) {
                buf = buf.slice(seg.range.offset, seg.range.offset + seg.range.length);
              }
              if (seg.range && seg.range.length > 0 && buf.length < seg.range.length) {
                // Byte-range segment that came back short: the file would be
                // corrupt. Treat it as a failed attempt so the retry loop runs.
                throw new Error(`Segment ${idx + 1} is truncated: ${buf.length} of ${seg.range.length} bytes`);
              }
              applyGeometry(buf);
              break;
            } catch (err) {
              lastErr = err;
              if (stopped()) return;
              await sleep(700 * (attempt + 1));
            }
          }
          if (!buf) {
            firstError = firstError || new Error(`Segment ${idx + 1} failed: ${lastErr ? lastErr.message : 'unknown error'}`);
            return;
          }
          let keyEntry = null;
          try {
            keyEntry = await getKey(seg.key);
          } catch (e) {
            firstError = firstError || e;
            return;
          }
          pending.set(idx, { buf, key: keyEntry, seq: seg.seq });
          try {
            flush();
          } catch (e) {
            firstError = firstError || e;
            return;
          }
        }
      };

      let refresher = null;
      if (isLive) {
        const limitSec = maxSeconds > 0 ? maxSeconds : LIVE_DEFAULT_SECONDS;
        const stopTimer = setTimeout(() => { liveDone = true; }, limitSec * 1000);
        refresher = (async () => {
          const wait = Math.max(1200, Math.min(6000, (targetDuration * 1000) / 2));
          try {
            while (!stopped() && !liveDone) {
              await sleep(wait);
              if (stopped() || liveDone) break;
              try {
                const r = await fetchTracked(mediaUrl, { headers, timeoutMs: 20000 });
                if (!/#EXTM3U/i.test(r.text)) continue;
                const seq = parseHlsMediaSequence(r.text);
                const p = parseHlsMedia(r.text, r.finalUrl);
                let added = 0;
                p.segs.forEach((s, i) => {
                  const abs = seq + i;
                  if (abs <= lastSeq) return;
                  lastSeq = abs;
                  queue.push({ url: s.url, range: s.range, key: s.key || null, seq: abs });
                  added++;
                });
                if (added) queueLen = queue.length;
              } catch (e) {}
            }
          } finally {
            clearTimeout(stopTimer);
          }
        })();
      }

      const poolSize = Math.max(1, Math.min(concurrency || this.hlsConcurrency || 6, 16));
      const workers = [];
      const n = isLive ? poolSize : Math.max(1, Math.min(poolSize, queue.length - startIdx));
      for (let i = 0; i < n; i++) workers.push(worker());
      await Promise.all(workers);
      liveDone = true;
      if (refresher) { try { await refresher; } catch (e) {} }

      // Superseded run (cancel/pause/start raced): never close, emit, or
      // touch the file — the current generation owns it now.
      if (genDead()) return;
      try { fs.closeSync(fd); } catch (e) {}
      fd = null;

      if (stopped()) return;
      if (firstError) return fail(firstError.message);
      if (!isLive && writeIdx < queue.length) {
        return fail(`Stream incomplete: ${queue.length - writeIdx} of ${queue.length} segments could not be downloaded`);
      }
      if (writePos === 0) return fail('Stream produced no data');

      download.hlsResumeIndex = 0;
      download.hlsResumeBytes = 0;
      download.segments[0].status = 'completed';
      download.status = 'completed';
      download.isLive = false;
      this.emit('download-complete', {
        id,
        filepath,
        totalSize: writePos,
        duration: Date.now() - download.startTime,
        variant: download.hlsVariant || null,
        media: download.media || null,
      });
      this._hashFileAsync(id, filepath);
    } catch (err) {
      if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
      // fail() already emitted download-error for pre-flight failures (bad
      // playlist, DRM, …) and set status='error' — emitting again sent the
      // UI two errors for one failure.
      if (download.status !== 'paused' && !download.cancelled && download.status !== 'error') {
        fail(err.message);
      }
    }
  }
}

/** Audio codec prefixes that prove a rendition is NOT video-only. */
const HLS_AUDIO_CODEC_RE = /(^|[.,])(mp4a|ac-3|ec-3|opus|alac|dtsc|dts[he]|\.mp3)/i;

/**
 * GROUP-IDs of every `#EXT-X-MEDIA:TYPE=AUDIO` rendition declared in a master
 * playlist. A `#EXT-X-STREAM-INF` that references one of these with `AUDIO=`
 * has a real audio track; a variant that references none (while others do) is
 * a video-only rendition — picking it silently yields a mute file.
 * @param {string} text
 * @returns {Set<string>}
 */
function parseHlsAudioGroups(text) {
  const groups = new Set();
  const re = /#EXT-X-MEDIA:([^\r\n]*)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (!/\bTYPE\s*=\s*AUDIO\b/i.test(m[1])) continue;
    const g = /\bGROUP-ID\s*=\s*"([^"]*)"/i.exec(m[1]);
    if (g && g[1]) groups.add(g[1]);
  }
  return groups;
}

/**
 * @param {any} v variant from parseHlsMaster
 * @param {Set<string>} audioGroups
 * @returns {number} 2 = audio rendition declared, 1 = audio assumed/proven
 *   muxed, 0 = video-only
 */
function hlsVariantAudioScore(v, audioGroups) {
  if (v.audio && audioGroups.size > 0 && audioGroups.has(v.audio)) return 2;
  if (v.audioCodec) return 1;
  if (audioGroups.size === 0) return 1; // no renditions declared: audio is muxed
  return 0;
}

/**
 * Choose the variant that will actually be downloaded: highest quality among
 * those that carry audio. Never returns null for a non-empty list.
 * @param {any[]} variants
 * @param {string} masterText
 * @returns {any | null}
 */
function pickHlsVariant(variants, masterText) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const groups = parseHlsAudioGroups(masterText);
  const better = (a, b) => (a.height - b.height) || (a.bandwidth - b.bandwidth);
  let best = null;
  let bestScore = -1;
  for (const v of variants) {
    const score = hlsVariantAudioScore(v, groups);
    if (score > bestScore || (score === bestScore && best && better(v, best) > 0)) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

function parseHlsMaster(text, baseUrl) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.toUpperCase().startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = /BANDWIDTH=(\d+)/i.exec(line);
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
    const audio = /\bAUDIO\s*=\s*"([^"]*)"/i.exec(line);
    const video = /\bVIDEO\s*=\s*"([^"]*)"/i.exec(line);
    const codecs = /\bCODECS\s*=\s*"([^"]*)"/i.exec(line);
    const fps = /\bFRAME-RATE\s*=\s*([\d.]+)/i.exec(line);
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (l && !l.startsWith('#')) { uri = l; break; }
    }
    if (!uri) continue;
    const codecValue = codecs ? codecs[1] : '';
    try {
      out.push({
        url: new URL(uri, baseUrl).toString(),
        bandwidth: bw ? parseInt(bw[1], 10) : 0,
        width: res ? parseInt(res[1], 10) : 0,
        height: res ? parseInt(res[2], 10) : 0,
        audio: audio ? audio[1] : null,
        video: video ? video[1] : null,
        codecs: codecValue,
        frameRate: fps ? parseFloat(fps[1]) : 0,
        audioCodec: HLS_AUDIO_CODEC_RE.test(codecValue),
      });
    } catch (e) {}
  }
  return out;
}

function parseHlsByterange(line, fallbackOffset) {
  const m = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?\s*$/i.exec(String(line || '').trim());
  if (!m) return null;
  const length = parseInt(m[1], 10);
  if (!Number.isFinite(length) || length < 0) return null;
  const offset = m[2] !== undefined ? parseInt(m[2], 10) : (Number.isFinite(fallbackOffset) ? fallbackOffset : 0);
  if (!Number.isFinite(offset) || offset < 0) return null;
  return { length, offset };
}

function parseHlsMedia(text, baseUrl) {
  const lines = String(text || '').split('\n');
  let mapUri = null;
  let mapRange = null;
  const segs = [];
  let pendingRange = null;
  let nextOffset = 0;
  let currentKey = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const keyM = /^#EXT-X-KEY:(.*)$/i.exec(line);
    if (keyM) {
      const a = parseKeyAttrs(keyM[1]);
      currentKey = (a.METHOD && a.METHOD !== 'NONE') ? a : null;
      continue;
    }

    if (line.toUpperCase().startsWith('#EXT-X-MAP:')) {
      const m = /URI="([^"]+)"/i.exec(line);
      if (m) {
        try { mapUri = new URL(m[1], baseUrl).toString(); } catch (e) {}
        const br = /BYTERANGE="(\d+)(?:@(\d+))?"/i.exec(line);
        if (br) {
          const length = parseInt(br[1], 10);
          const offset = br[2] !== undefined ? parseInt(br[2], 10) : 0;
          if (Number.isFinite(length) && Number.isFinite(offset)) mapRange = { length, offset };
        }
      }
      continue;
    }

    if (line.toUpperCase().startsWith('#EXT-X-BYTERANGE:')) {
      const r = parseHlsByterange(line, nextOffset);
      if (r) {
        pendingRange = r;
        nextOffset = r.offset + r.length;
      }
      continue;
    }

    if (line.startsWith('#')) continue;

    try {
      segs.push({ url: new URL(line, baseUrl).toString(), range: pendingRange, key: currentKey });
    } catch (e) {}
    pendingRange = null;
  }
  return { mapUri, mapRange, segs };
}

function sumHlsDuration(text) {
  let total = 0;
  const lines = String(text || '').split('\n');
  for (const raw of lines) {
    const m = /^#EXTINF:(\d+(?:\.\d+)?)/i.exec(raw.trim());
    if (m) total += parseFloat(m[1]) || 0;
  }
  return total;
}

module.exports = {
  DownloadEngine,
  DownloadTask,
  DownloadEngineCoordinator,
  TokenBucket,
  hashFile,
  verifyChecksum,
  probeRemote,
  HttpError,
  buildRequestHeaders,
  isDnsLookupError,
  parseDohIPv4,
  resolveDohIPv4,
  createDohFallbackLookup,
  hlsFetchError,
  parseHlsMaster,
  parseHlsAudioGroups,
  pickHlsVariant,
  hlsVariantAudioScore,
  parseHlsMedia,
  parseHlsKey,
  parseKeyAttrs,
  parseHlsMediaSequence,
  sumHlsDuration,
  filenameFromContentDisposition,
  extFromMime,
};
