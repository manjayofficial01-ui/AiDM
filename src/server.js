const http = require('http');
const facebookResolver = require('./facebook-resolver.js');
const resolvers = require('./resolvers.js');

// Headers the extension is allowed to attach to a download so the desktop
// engine can replay anti-hotlink checks (Referer/Origin/UA). Everything
// else (notably Cookie/Authorization) is stripped for safety.
const HEADER_ALLOWLIST = ['referer', 'origin', 'user-agent', 'accept-language'];
// 128 MB — large enough to carry a base64 data: URL for image bytes
// (e.g. an AI-generated PNG/JPG the extension converted from blob:).
// The server is bound to 127.0.0.1 only, so localhost is the trust boundary.
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/**
 * Simple sliding-window rate limiter for the resolve endpoints. Resolution
 * hits an external metadata source — without a cap, a runaway tab or a
 * malicious local page could hammer it in a loop.
 */
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = [];
  }
  allow() {
    const now = Date.now();
    this.hits = this.hits.filter(t => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

// 30 resolutions per minute per endpoint is far above interactive use. One
// limiter PER endpoint: a shared one let a runaway tab on /api/resolve
// starve the video endpoints (and vice versa).
const RESOLVE_LIMITERS = {
  '/api/resolve': new RateLimiter(30, 60 * 1000),
  '/api/resolve-twitter': new RateLimiter(30, 60 * 1000),
  '/api/resolve-facebook': new RateLimiter(30, 60 * 1000),
  '/api/resolve-youtube': new RateLimiter(30, 60 * 1000),
  // When /api/download routes a page URL through the resolver, this caps how
  // often a runaway tab can force resolution.
  '/api/download': new RateLimiter(30, 60 * 1000),
};

function sanitizeHeaders(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    if (HEADER_ALLOWLIST.includes(String(k).toLowerCase()) && typeof v === 'string' && v.length < 2048) {
      out[k] = v;
    }
  }
  return out;
}

// ── YouTube CDN guard ───────────────────────────────────────────────────────
// YouTube serves picture and sound as SEPARATE signed DASH tracks from
// googlevideo.com/videoplayback. They expire in minutes and need the player's
// own context (Range + the right Referer + a live signature), so replaying one
// through the native multi-segment engine yields ~30 bytes that the engine
// honestly reports as "100% complete" — the "downloaded a video that is 31
// bytes" bug.
//
// A googlevideo URL must therefore NEVER become a plain row. It is either
// rerouted to /api/resolve-youtube (which uses yt-dlp on the WATCH PAGE and
// offers real merged qualities), or refused outright.

/** True for YouTube's own media CDN (never a page URL).
 *
 *  Anything served from googlevideo.com is a player-side streaming endpoint
 *  — /videoplayback (the actual DASH tracks), /generate_204 (the player's
 *  connectivity probe that returns 204 0 bytes when fetched naively),
 *  /initplayback, /anything. They are NEVER files. Saving one to disk was
 *  the original "31-byte completed" bug for /videoplayback and the
 *  "HTTP 204 failed" bug for /generate_204. The host alone is the
 *  meaningful criterion; the path never was.
 */
function isYouTubeMediaUrl(url) {
  try {
    const u = new URL(String(url));
    return /(^|\.)googlevideo\.com$/i.test(String(u.hostname || ''));
  } catch (e) {
    return false; // not a URL at all → not a YouTube CDN url
  }
}

/**
 * The WATCH PAGE a YouTube CDN url belongs to, if the caller told us.
 *
 * The extension normally forwards it (`pageUrl`, `meta.pageUrl`, or the
 * Referer it captured). A bare CDN origin ("https://www.youtube.com/") is not
 * enough to resolve anything, so it is rejected.
 */
function youtubePageUrlFor(body, headers) {
  const b = body || {};
  const m = (b.meta && typeof b.meta === 'object') ? b.meta : {};
  const candidates = [
    b.pageUrl, b.url, m.pageUrl, m.ytUrl, b.referrer, b.referer,
    headers && (headers.Referer || headers.referer),
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    try {
      if (resolvers.youtubeResolver.isYouTubeUrl(c)) return c;
    } catch (e) { /* not a YouTube page */ }
  }
  return null;
}

/**
 * IPC Server - Local HTTP server for Chrome Extension communication
 * Runs on localhost to receive download requests from the browser extension
 * Supports video detection with quality/resolution/size metadata
 */
class IPCServer {
  constructor(downloadManager) {
    this.dm = downloadManager;
    this.server = null;
    this.port = 18765;
  }

  /**
   * Opt-in: the browser whose own cookie store yt-dlp may read (empty = off).
   * Read from settings at call time so changing it in Settings takes effect
   * without restarting the app.
   */
  _youtubeCookiesFromBrowser() {
    try {
      const v = String((this.dm && this.dm.getSettings().youtubeCookiesFromBrowser) || '').trim();
      return v || null;
    } catch (e) { return null; }
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  start() {
    this.server = http.createServer((req, res) => {
      // CORS: this server binds to 127.0.0.1 only, so the real boundary is
      // localhost. Reflect the request Origin so Chrome extensions (which
      // send `Origin: chrome-extension://…`) and localhost pages can read
      // responses. A missing Origin (privileged extension fetch) still works.
      //
      // NOTE: v3.0.0 restricted this to an allowlist and broke extension
      // connectivity on some Chrome versions — host_permissions does NOT
      // guarantee the response is readable without a CORS header. Keep
      // permissive reflection; the localhost bind is the security boundary.
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // GET /api/status — health check
      if (req.method === 'GET' && req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'running',
          version: require('../package.json').version,
          name: 'AiDM',
          downloads: this.dm.getAllDownloads().length,
          active: this.dm.getAllDownloads().filter(d => d.status === 'downloading').length,
          settings: {
            askLocationEveryTime: this.dm.settings.askLocationEveryTime,
            categoryPaths: this.dm.settings.categoryPaths,
            browserIntegration: this.dm.settings.browserIntegration !== false,
            notifications: this.dm.settings.notifications !== false,
            // Browser-takeover controls (v4.3.0) so the extension can enforce
            // them without an extra round-trip.
            interceptAll: this.dm.settings.interceptAll !== false,
            interceptFileTypes: this.dm.settings.interceptFileTypes || [],
            excludedSites: this.dm.settings.excludedSites || [],
            forceTakeoverKey: this.dm.settings.forceTakeoverKey || 'Shift',
          },
        }));
        return;
      }

      // GET /api/downloads — list all downloads
      if (req.method === 'GET' && req.url === '/api/downloads') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.dm.getAllDownloads()));
        return;
      }

      // GET /api/settings — get current settings
      if (req.method === 'GET' && req.url === '/api/settings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.dm.getSettings()));
        return;
      }

      // POST /api/download — submit a single download
      // Body: { url, filename?, savePath?, segments?, quality?, meta?, headers? }
      if (req.method === 'POST' && req.url === '/api/download') {
        this._readBody(req).then(async (body) => {
          try {
            const data = JSON.parse(body);
            const r = await this._routeDownload(data);
            res.writeHead(r.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r.body));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/video-detected — video with quality variants detected
      // Body: { pageTitle, pageUrl, videos: [{ url, quality, resolution, size, format, codec }] }
      if (req.method === 'POST' && req.url === '/api/video-detected') {
        this._readBody(req).then((body) => {
          try {
            const data = JSON.parse(body);
            // The extension's variant list can still carry the player's own
            // googlevideo URLs (its filter only ever covered /videoplayback,
            // and only for the capsule list). Showing one in the picker is a
            // dead click: the row it creates is refused or produces the
            // 31-byte / HTTP 204 failure. Drop them here too — same rule as
            // the /api/download guard.
            const videos = Array.isArray(data.videos)
              ? data.videos.filter(v => !v || !isYouTubeMediaUrl(v.url))
              : [];
            if (!videos.length) {
              // Nothing playable left — don't open an empty picker.
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, count: 0, filtered: (data.videos || []).length }));
              return;
            }
            // Forward to UI so it can show a quality picker
            this.dm.emit('video-detected', { ...data, videos });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: videos.length }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/resolve — provider-neutral media resolver (v3.5.0).
      // Body: { url } — e.g. a tweet URL, later: any registered provider.
      // Returns the normalised shape used by every resolver:
      //   { provider, id, title, thumbnail, duration, media: [...] }
      // The media list is best-progressive-MP4-first (`preferred: true` marks
      // the winner). Resolution is rate-limited and only ever passes the
      // post identifier — never an arbitrary URL — to the metadata source.
      if (req.method === 'POST' && req.url === '/api/resolve') {
        this._readBody(req).then(async (body) => {
          const respond = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
          };
          try {
            if (!RESOLVE_LIMITERS[req.url]?.allow()) {
              return respond(429, { success: false, error: 'Too many resolve requests — try again in a minute' });
            }
            const { url, credentials, cookies, referer } = JSON.parse(body || '{}');
            if (!url || typeof url !== 'string') throw new Error('Missing url');
            // File hosters (Rapidgator …) need the account the user saved in
            // Settings › File hosts. The extension may forward it; when it
            // does not, fall back to the desktop's own saved settings so
            // pasting a hoster link in the browser works like pasting it in
            // the app.
            // yt-dlp additionally gets the session the caller captured plus the
            // opt-in browser cookie store, so a signed-in user's own video can
            // be listed at all (see src/yt-dlp.js cookie block).
            const resolved = await resolvers.resolveMedia(url, {
              credentials: credentials || ((this.dm.getSettings().fileHosts || {}).rapidgator || {}),
              cookies: cookies || null,
              referer: referer || null,
              cookiesFromBrowser: this._youtubeCookiesFromBrowser(),
            });
            respond(200, { success: true, ...resolved });
          } catch (err) {
            respond(err.message === 'No resolver supports this URL' ? 422 : 400, { success: false, error: err.message });
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/resolve-twitter — resolve a tweet URL to direct MP4 variants
      // Body: { url: "https://x.com/<user>/status/<id>" }
      //
      // X hides the direct MP4s inside its GraphQL/syndication metadata rather
      // than exposing them to the page, and the syndication endpoint is NOT
      // reachable from page JS (CORS is limited to platform.twitter.com). So
      // the extension hands us the tweet URL and we resolve it here in Node,
      // then emit `video-detected` so the UI shows the normal quality picker.
      if (req.method === 'POST' && req.url === '/api/resolve-twitter') {
        this._readBody(req).then(async (body) => {
          try {
            if (!RESOLVE_LIMITERS[req.url]?.allow()) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Too many resolve requests — try again in a minute' }));
              return;
            }
            const { url, pageTitle } = JSON.parse(body || '{}');
            // Route through the resolver registry (strict parseTwitterUrl) —
            // calling twitterResolver directly used to accept the loose
            // "any 15-25 digit run" fallback, so a media CDN URL containing a
            // 19-digit id could be mistaken for a tweet id. The registry's
            // twitter adapter only accepts real status permalinks.
            const r = await resolvers.resolveMedia(url);
            const payload = {
              url,
              pageUrl: r.canonicalUrl || url,
              pageTitle: pageTitle || r.title || `Tweet ${r.id}`,
              thumbnail: r.thumbnail,
              duration: r.duration,
              videos: r.pickerVideos || [],
            };
            this.dm.emit('video-detected', payload);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, tweetId: r.id, videos: payload.videos }));
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/resolve-facebook — resolve a Facebook/Instagram video page
      // to fresh progressive MP4 variants.
      // Body: { url, cookies?, pageTitle? } — cookies replay the browser
      // session for login-walled videos (supplied by the extension).
      // Pasted page URLs used to fall through to a direct download of the
      // page HTML itself; like /api/resolve-twitter this emits
      // `video-detected` so the UI shows the normal quality picker instead.
      if (req.method === 'POST' && req.url === '/api/resolve-facebook') {
        this._readBody(req).then(async (body) => {
          try {
            if (!RESOLVE_LIMITERS[req.url]?.allow()) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Too many resolve requests — try again in a minute' }));
              return;
            }
            const { url, cookies, pageTitle } = JSON.parse(body || '{}');
            const r = await facebookResolver.resolveFacebookVideos(url, { cookies: cookies || null });

            const payload = {
              url,
              pageUrl: r.canonicalUrl || url,
              pageTitle: pageTitle || r.title || 'Facebook video',
              provider: r.provider,
              thumbnail: r.thumbnail || undefined,
              duration: r.duration || undefined,
              cookies: (typeof cookies === 'string' && cookies) ? cookies : undefined,
              videos: facebookResolver.toPickerVideos(r.videos),
            };
            this.dm.emit('video-detected', payload);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, provider: r.provider, id: r.id, videos: payload.videos }));
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/resolve-youtube — resolve a YouTube page into real, merged
      // qualities (see src/youtube-resolver.js).
      //
      // The extension sends the WATCH PAGE, never a sniffed stream URL:
      // YouTube serves picture and sound as two separate signed DASH urls that
      // expire in minutes, so a sniffed link would save a silent (or dead)
      // file. yt-dlp resolves it into real qualities and merges them, and the
      // normal quality picker is shown with sizes taken from the probe.
      if (req.method === 'POST' && req.url === '/api/resolve-youtube') {
        this._readBody(req).then(async (body) => {
          try {
            if (!RESOLVE_LIMITERS[req.url]?.allow()) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Too many resolve requests — try again in a minute' }));
              return;
            }
            const { url, pageTitle, cookies, referer } = JSON.parse(body || '{}');
            // The extension sends only the page URL, so the session has to come
            // from the opt-in browser cookie store here — without it a private /
            // members-only video is reported as unavailable to a signed-in user.
            const r = await resolvers.resolveMedia(url, {
              cookies: cookies || null,
              referer: referer || null,
              cookiesFromBrowser: this._youtubeCookiesFromBrowser(),
            });

            const payload = {
              url: r.canonicalUrl || url,
              pageUrl: r.canonicalUrl || url,
              pageTitle: pageTitle || r.title || 'YouTube video',
              provider: 'youtube',
              thumbnail: r.thumbnail || undefined,
              duration: r.duration || undefined,
              videos: r.pickerVideos || [],
            };
            this.dm.emit('video-detected', payload);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, provider: 'youtube', id: r.id, videos: payload.videos }));
          } catch (err) {
            // Unresolvable (bot check, private, live, no yt-dlp…) — the
            // extension is told so it can retry on the next navigation.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/approve — approve a pending download with chosen path
      // Body: { id, savePath }
      if (req.method === 'POST' && req.url === '/api/approve') {
        this._readBody(req).then((body) => {
          try {
            const { id, savePath } = JSON.parse(body);
            const dl = this.dm.approveDownload(id, savePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, download: dl }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/remove — drop a row by id. Symmetric with the IPC
      // remove-download handler. Without this, an extension or automated
      // harness cannot clean up rows it created — leaving stale rows that
      // the user has no way to dismiss from outside the renderer.
      if (req.method === 'POST' && req.url === '/api/remove') {
        this._readBody(req).then((body) => {
          try {
            const { id } = JSON.parse(body);
            if (!id || typeof id !== 'string') throw new Error('Missing id');
            this.dm.removeDownload(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/cancel — cancel an in-flight row by id (keeps the row,
      // status='cancelled'). Symmetric with IPC cancel-download.
      if (req.method === 'POST' && req.url === '/api/cancel') {
        this._readBody(req).then((body) => {
          try {
            const { id } = JSON.parse(body);
            if (!id || typeof id !== 'string') throw new Error('Missing id');
            const dl = this.dm.cancelDownload(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, download: dl }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/reject — reject a pending download (drops the row).
      // Symmetric with IPC reject-download.
      if (req.method === 'POST' && req.url === '/api/reject') {
        this._readBody(req).then((body) => {
          try {
            const { id } = JSON.parse(body);
            if (!id || typeof id !== 'string') throw new Error('Missing id');
            this.dm.rejectDownload(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      // POST /api/batch — submit multiple URLs
      if (req.method === 'POST' && req.url === '/api/batch') {
        this._readBody(req).then(async (body) => {
          try {
            const parsed = JSON.parse(body);
            const { urls } = parsed;
            if (!Array.isArray(urls) || urls.length === 0 || urls.length > 200) {
              throw new Error('urls must be a non-empty array (max 200)');
            }
            const batchHeaders = sanitizeHeaders(parsed.headers);
            // Same routing as /api/download per URL — otherwise a batch
            // could turn a googlevideo URL or a YouTube page URL into a
            // plain row, exactly the bug class the single endpoint already
            // guards against.
            const results = await Promise.all(urls.map(async (url) => {
              try {
                const r = await this._routeDownload({ url, headers: batchHeaders });
                // Surface the URL alongside non-success results so the caller
                // can tell which entry failed.
                if (r.body && r.body.success === false) return { url, ...r.body };
                return { url, ...r.body };
              } catch (err) {
                return { url, error: (err && err.message) || String(err) };
              }
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, downloads: results }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }).catch((err) => {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`AiDM IPC Server running on http://127.0.0.1:${this.port}`);
    });

    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${this.port} in use, trying ${this.port + 1}`);
        this.port++;
        this.server.listen(this.port, '127.0.0.1');
      }
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * Route ONE download request through the same guards /api/download uses.
   *
   * Returns `{ statusCode, body }`. HTTP callers (single + batch) write the
   * body and the status; the routing logic lives here so both endpoints
   * share it. Branches, in order:
   *
   *   1. googlevideo URL → refuse (no page URL) or reroute to picker (with
   *      page URL). Never creates a plain row.
   *   2. Page URL the resolver registry recognises → resolve and emit
   *      video-detected. Exception: caller already picked a quality
   *      (meta.ytFormat set) → fall through to addDownload.
   *   3. Anything else → addDownload (a real file URL, a hoster reply, …).
   *
   * Errors thrown by the underlying machinery (resolver, addDownload)
   * bubble; the caller decides how to render them.
   */
  async _routeDownload(data) {
    if (!data || !data.url || typeof data.url !== 'string') {
      return { statusCode: 400, body: { error: 'Missing url' } };
    }
    const headers = sanitizeHeaders(data.headers);

    // ── googlevideo host: any path. Player-side endpoint, never a file. ──
    if (isYouTubeMediaUrl(data.url)) {
      const pageUrl = youtubePageUrlFor(data, headers);
      const refuse = (msg) => ({ statusCode: 200, body: { success: false, youtubeCdn: true, error: msg } });
      if (!pageUrl) {
        return refuse('This is a YouTube media stream, not a downloadable ' +
          'file — AiDM will not save it as a 31-byte video. Open the ' +
          "video's page and download it from there (the page URL is " +
          'what AiDM needs to build real qualities).');
      }
      if (!RESOLVE_LIMITERS['/api/resolve-youtube']?.allow()) {
        return { statusCode: 429, body: { success: false, youtubeCdn: true, error: 'Too many resolve requests — try again in a minute' } };
      }
      const r = await resolvers.resolveMedia(pageUrl, {
        cookies: typeof data.cookies === 'string' ? data.cookies : null,
        referer: pageUrl,
        cookiesFromBrowser: this._youtubeCookiesFromBrowser(),
      });
      const payload = {
        url: r.canonicalUrl || pageUrl,
        pageUrl: r.canonicalUrl || pageUrl,
        pageTitle: (data.meta && data.meta.pageTitle) || r.title || 'YouTube video',
        provider: 'youtube',
        thumbnail: r.thumbnail || undefined,
        duration: r.duration || undefined,
        videos: r.pickerVideos || [],
      };
      this.dm.emit('video-detected', payload);
      return { statusCode: 200, body: { success: true, rerouted: 'youtube', provider: 'youtube', id: r.id, videos: payload.videos } };
    }

    // ── Page URL routing (YouTube / Twitter / Facebook). ──
    if (resolvers.hasResolverFor(data.url)) {
      const ytFormat = (data.meta && data.meta.ytFormat && typeof data.meta.ytFormat === 'object')
        ? data.meta.ytFormat : null;
      if (!ytFormat) {
        if (!RESOLVE_LIMITERS['/api/download']?.allow()) {
          return { statusCode: 429, body: { success: false, resolveFailed: true, error: 'Too many resolve requests — try again in a minute' } };
        }
        try {
          const resolved = await resolvers.resolveMedia(data.url, {
            cookies: typeof data.cookies === 'string' ? data.cookies : null,
            referer: (data.meta && data.meta.pageUrl) || data.url,
            cookiesFromBrowser: this._youtubeCookiesFromBrowser(),
          });
          if (!resolved.pickerVideos || !resolved.pickerVideos.length) {
            return { statusCode: 200, body: {
              success: false, resolveFailed: true,
              provider: resolved.provider,
              waitSeconds: resolved.waitSeconds || 0,
              requiresCredentials: !!resolved.requiresCredentials,
              error: resolved.hint || resolved.error ||
                `No downloadable file was found on this ${resolved.provider || 'page'}.`,
            } };
          }
          const pageUrl = resolved.canonicalUrl || data.url;
          this.dm.emit('video-detected', {
            url: pageUrl,
            pageUrl,
            pageTitle: (data.meta && data.meta.pageTitle) || resolved.title || `${resolved.provider} video`,
            provider: resolved.provider,
            thumbnail: resolved.thumbnail || undefined,
            duration: resolved.duration || undefined,
            videos: resolved.pickerVideos,
          });
          return { statusCode: 200, body: { success: true, resolved: true, provider: resolved.provider, id: resolved.id, videos: resolved.pickerVideos } };
        } catch (e) {
          return { statusCode: 200, body: { success: false, resolveFailed: true, error: (e && e.message) || 'Could not resolve this page URL' } };
        }
      }
      // ytFormat present → caller picked; fall through to addDownload.
    }

    const download = this.dm.addDownload({
      url: data.url,
      filename: data.filename,
      savePath: data.savePath,
      segments: data.segments,
      quality: data.quality,
      meta: data.meta,
      headers,
      cookies: typeof data.cookies === 'string' && data.cookies.length < 32768 ? data.cookies : null,
      audioUrl: typeof data.audioUrl === 'string' && data.audioUrl.length < 4096 ? data.audioUrl : null,
    });
    return { statusCode: 200, body: { success: true, duplicate: !!download.duplicate, download } };
  }
}

module.exports = {
  IPCServer,
  // Pure helpers — exported so the YouTube CDN guard is regression-tested
  // without booting the HTTP server (see test/server-youtube-cdn-guard.js).
  isYouTubeMediaUrl,
  youtubePageUrlFor,
  sanitizeHeaders,
};
