const http = require('http');
const twitterResolver = require('./twitter-resolver.js');

// Headers the extension is allowed to attach to a download so the desktop
// engine can replay anti-hotlink checks (Referer/Origin/UA). Everything
// else (notably Cookie/Authorization) is stripped for safety.
const HEADER_ALLOWLIST = ['referer', 'origin', 'user-agent', 'accept-language'];

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

  start() {
    this.server = http.createServer((req, res) => {
      // CORS headers for Chrome extension
      res.setHeader('Access-Control-Allow-Origin', '*');
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
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const download = this.dm.addDownload({
              url: data.url,
              filename: data.filename,
              savePath: data.savePath,
              segments: data.segments,
              quality: data.quality,
              meta: data.meta,
              headers: sanitizeHeaders(data.headers),
              cookies: typeof data.cookies === 'string' && data.cookies.length < 8192 ? data.cookies : null,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, duplicate: !!download.duplicate, download }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // POST /api/video-detected — video with quality variants detected
      // Body: { pageTitle, pageUrl, videos: [{ url, quality, resolution, size, format, codec }] }
      if (req.method === 'POST' && req.url === '/api/video-detected') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            // Forward to UI so it can show a quality picker
            this.dm.emit('video-detected', data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: data.videos.length }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
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
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { url, pageTitle } = JSON.parse(body || '{}');
            const { tweetId, videos } = await twitterResolver.resolveTweetVideos(url);

            // Shape matches what /api/video-detected sends to the UI.
            const payload = {
              url,
              pageUrl: url,
              pageTitle: pageTitle || `Tweet ${tweetId}`,
              videos: twitterResolver.toPickerVideos(videos),
            };
            this.dm.emit('video-detected', payload);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, tweetId, videos: payload.videos }));
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }

      // POST /api/approve — approve a pending download with chosen path
      // Body: { id, savePath }
      if (req.method === 'POST' && req.url === '/api/approve') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { id, savePath } = JSON.parse(body);
            const dl = this.dm.approveDownload(id, savePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, download: dl }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // POST /api/batch — submit multiple URLs
      if (req.method === 'POST' && req.url === '/api/batch') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const { urls } = parsed;
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
