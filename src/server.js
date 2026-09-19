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
        this._readBody(req).then((body) => {
          try {
            const data = JSON.parse(body);
            if (!data.url || typeof data.url !== 'string') {
              throw new Error('Missing url');
            }
            const download = this.dm.addDownload({
              url: data.url,
              filename: data.filename,
              savePath: data.savePath,
              segments: data.segments,
              quality: data.quality,
              meta: data.meta,
              headers: sanitizeHeaders(data.headers),
              cookies: typeof data.cookies === 'string' && data.cookies.length < 32768 ? data.cookies : null,
              audioUrl: typeof data.audioUrl === 'string' && data.audioUrl.length < 4096 ? data.audioUrl : null,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, duplicate: !!download.duplicate, download }));
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
            // Forward to UI so it can show a quality picker
            this.dm.emit('video-detected', data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: (data.videos || []).length }));
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

      // POST /api/batch — submit multiple URLs
      if (req.method === 'POST' && req.url === '/api/batch') {
        this._readBody(req).then((body) => {
          try {
            const parsed = JSON.parse(body);
            const { urls } = parsed;
            if (!Array.isArray(urls) || urls.length === 0 || urls.length > 200) {
              throw new Error('urls must be a non-empty array (max 200)');
            }
            const batchHeaders = sanitizeHeaders(parsed.headers);
            const results = urls.map(url => {
              try {
                return this.dm.addDownload({ url, headers: batchHeaders });
              } catch (err) {
                return { error: err.message, url };
              }
            });
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
}

module.exports = { IPCServer };
