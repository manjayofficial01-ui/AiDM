const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');
const { EventEmitter } = require('events');

/**
 * Parse the first #EXT-X-KEY tag of an HLS playlist.
 * Returns { method, uri, iv, keyformat } or null when the playlist is clear.
 * METHODS: NONE (clear), AES-128 (decryptable), SAMPLE-AES (DRM - unsupported).
 */
function parseHlsKey(text) {
  const m = String(text || '').match(/#EXT-X-KEY:([^\r\n]*)/i);
  if (!m) return null;
  const attrs = m[1];
  const get = (name) => {
    const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|([^,]*))', 'i');
    const mm = attrs.match(re);
    if (!mm) return null;
    return mm[1] !== undefined ? mm[1] : (mm[2] !== undefined ? mm[2].trim() : null);
  };
  return {
    method: (get('METHOD') || 'NONE').toUpperCase(),
    uri: get('URI'),
    iv: get('IV'),
    keyformat: get('KEYFORMAT'),
  };
}

/**
 * Read #EXT-X-MEDIA-SEQUENCE (used to derive implicit AES IVs).
 */
function parseHlsMediaSequence(text) {
  const m = String(text || '').match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * AiDM Multi-Segment Download Engine
 * Inspired by IDM's dynamic file segmentation technology
 * - Splits files into multiple segments for parallel downloading
 * - Dynamic segment resizing based on connection speed
 * - Resume support with Range headers
 * - Connection reuse and retry logic
 */
class DownloadEngine extends EventEmitter {
  constructor() {
    super();
    this.activeSegments = new Map(); // downloadId -> segment[]
  }

  async startDownload({ id, url, filepath, totalSegments = 8, headers = {} }) {
    const download = {
      id,
      url,
      filepath,
      totalSegments,
      headers,
      segments: [],
      totalSize: 0,
      downloadedSize: 0,
      startTime: Date.now(),
      speed: 0,
      status: 'connecting',
    };

    try {
      // Step 1: Probe file size and check resume support
      const meta = await this._probeFile(url, headers);
      download.totalSize = meta.contentLength || 0;
      download.supportsRange = meta.supportsRange;
      download.finalUrl = meta.finalUrl || url;

      if (!meta.supportsRange || download.totalSize === 0) {
        // Single connection for non-resumable or unknown-size files
        download.totalSegments = 1;
      }

      // Ensure output directory exists
      const dir = path.dirname(filepath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Pre-allocate file
      if (download.totalSize > 0) {
        const fd = fs.openSync(filepath, 'w');
        fs.ftruncateSync(fd, download.totalSize);
        fs.closeSync(fd);
      } else {
        fs.writeFileSync(filepath, '');
      }

      download.status = 'downloading';
      this.activeSegments.set(id, download);

      // Step 2: Launch segments
      const segSize = download.totalSize > 0
        ? Math.ceil(download.totalSize / download.totalSegments)
        : 0;

      for (let i = 0; i < download.totalSegments; i++) {
        const start = segSize * i;
        const end = download.totalSegments === 1
          ? undefined
          : Math.min(start + segSize - 1, download.totalSize - 1);

        const segment = this._createSegment({
          downloadId: id,
          segmentIndex: i,
          url: download.finalUrl,
          filepath,
          start,
          end,
          headers,
        });

        download.segments.push(segment);
      }

      return download;
    } catch (err) {
      download.status = 'error';
      download.error = err.message;
      this.emit('download-error', { id, error: err.message });
      throw err;
    }
  }

  _probeFile(url, extraHeaders = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      if (redirectCount > 5) {
        return reject(new Error('Too many redirects'));
      }
      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${url}`));
      }

      const client = parsed.protocol === 'https:' ? https : http;
      const defaultUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

      const opts = {
        method: 'HEAD',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': defaultUA,
          ...extraHeaders,
        },
        timeout: 15000,
      };

      const doProbe = (method) => {
        opts.method = method;
        if (method === 'GET') {
          opts.headers = { ...opts.headers, 'Range': 'bytes=0-1' };
        }

        const req = client.request(opts, (res) => {
          // Handle 3xx redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            try {
              const redirectUrl = new URL(res.headers.location, url).href;
              return this._probeFile(redirectUrl, extraHeaders, redirectCount + 1).then(resolve, reject);
            } catch (err) {
              return reject(new Error(`Invalid redirect URL: ${res.headers.location}`));
            }
          }

          // If HEAD is not allowed (405, 403, 501), fallback to GET with Range: bytes=0-1
          if (method === 'HEAD' && (res.statusCode === 405 || res.statusCode === 403 || res.statusCode === 501)) {
            res.resume();
            return doProbe('GET');
          }

          let contentLength = parseInt(res.headers['content-length'], 10) || 0;
          const acceptRanges = res.headers['accept-ranges'];
          const contentRange = res.headers['content-range'];
          let supportsRange = acceptRanges === 'bytes';

          // If range probe was used (206 Partial Content)
          if (res.statusCode === 206 && contentRange) {
            supportsRange = true;
            const match = contentRange.match(/\/(\d+|\*)$/);
            if (match && match[1] !== '*') {
              contentLength = parseInt(match[1], 10) || contentLength;
            }
          } else if (contentLength > 0) {
            supportsRange = supportsRange || true;
          }

          resolve({
            contentLength,
            supportsRange,
            finalUrl: url,
            headers: res.headers,
          });
          res.resume();
        });

        req.on('error', (err) => {
          if (method === 'HEAD') {
            return doProbe('GET');
          }
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Connection timeout during probe'));
        });

        req.end();
      };

      doProbe('HEAD');
    });
  }

  _createSegment({ downloadId, segmentIndex, url, filepath, start, end, headers }) {
    const segment = {
      index: segmentIndex,
      downloaded: 0,
      status: 'active',
      retries: 0,
      maxRetries: 5,
    };

    let currentUrl = url;
    const defaultUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    const rangeHeaders = {
      'User-Agent': defaultUA,
      ...headers,
    };

    if (end !== undefined) {
      rangeHeaders['Range'] = `bytes=${start + (segment.downloaded || 0)}-${end}`;
    }

    const doRequest = () => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        segment.status = 'error';
        this._checkDownloadComplete(downloadId);
        return;
      }
      const client = parsed.protocol === 'https:' ? https : http;

      const opts = {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: rangeHeaders,
        timeout: 30000,
      };

      const req = client.request(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect with protocol switch support
          try {
            currentUrl = new URL(res.headers.location, currentUrl).href;
          } catch (e) {
            segment.status = 'error';
            this._checkDownloadComplete(downloadId);
            return;
          }
          res.resume();
          doRequest();
          return;
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          segment.status = 'error';
          this._checkDownloadComplete(downloadId);
          return;
        }

        const writeOffset = start !== undefined ? start + segment.downloaded : segment.downloaded;
        const fd = fs.openSync(filepath, 'r+');
        let writePos = writeOffset;

        res.on('data', (chunk) => {
          fs.writeSync(fd, chunk, 0, chunk.length, writePos);
          writePos += chunk.length;
          segment.downloaded += chunk.length;

          // Update parent download
          const download = this.activeSegments.get(downloadId);
          if (download) {
            download.downloadedSize = download.segments.reduce((sum, s) => sum + s.downloaded, 0);
            const elapsed = (Date.now() - download.startTime) / 1000;
            download.speed = elapsed > 0 ? download.downloadedSize / elapsed : 0;

            // Dynamic segment speed tracking for smart allocation
            segment.currentSpeed = chunk.length; // bytes per tick

            this.emit('download-progress', {
              id: downloadId,
              downloaded: download.downloadedSize,
              total: download.totalSize,
              speed: download.speed,
              percent: download.totalSize > 0
                ? (download.downloadedSize / download.totalSize * 100).toFixed(1)
                : 0,
              segments: download.segments.map(s => ({
                index: s.index,
                downloaded: s.downloaded,
                status: s.status,
              })),
            });
          }
        });

        res.on('end', () => {
          fs.closeSync(fd);
          segment.status = 'completed';
          this._checkDownloadComplete(downloadId);
        });

        res.on('error', (err) => {
          fs.closeSync(fd);
          this._handleSegmentError(downloadId, segment, doRequest);
        });
      });

      req.on('error', () => {
        this._handleSegmentError(downloadId, segment, doRequest);
      });

      req.on('timeout', () => {
        req.destroy();
        this._handleSegmentError(downloadId, segment, doRequest);
      });

      segment.request = req;
      req.end();
    };

    doRequest();
    return segment;
  }

  _handleSegmentError(downloadId, segment, retryFn) {
    segment.retries++;
    if (segment.retries < segment.maxRetries) {
      // Exponential backoff
      setTimeout(retryFn, Math.min(1000 * Math.pow(2, segment.retries), 30000));
    } else {
      segment.status = 'error';
      this._checkDownloadComplete(downloadId);
    }
  }

  _checkDownloadComplete(downloadId) {
    const download = this.activeSegments.get(downloadId);
    if (!download) return;

    const allDone = download.segments.every(s => s.status === 'completed');
    const anyError = download.segments.some(s => s.status === 'error');

    if (allDone) {
      download.status = 'completed';
      this.emit('download-complete', {
        id: downloadId,
        filepath: download.filepath,
        totalSize: download.totalSize,
        duration: Date.now() - download.startTime,
      });
    } else if (anyError) {
      download.status = 'error';
      download.error = 'One or more segments failed';
      this.emit('download-error', { id: downloadId, error: download.error });
    }
  }

  pauseDownload(id) {
    const download = this.activeSegments.get(id);
    if (!download) return;
    download.status = 'paused';
    if (download.currentReq) {
      try { download.currentReq.destroy(); } catch (e) {}
      download.currentReq = null;
    }
    download.segments.forEach(seg => {
      if (seg.request) seg.request.destroy();
      seg.status = 'paused';
    });
    this.emit('download-paused', { id });
  }

  resumeDownload(id) {
    const download = this.activeSegments.get(id);
    if (!download) return;
    // HLS downloads restart from the first segment (no byte-range resume)
    if (download.hls) {
      download.status = 'downloading';
      download.cancelled = false;
      download.startTime = Date.now();
      download.downloadedSize = 0;
      download.segments.forEach(s => { s.status = 'active'; s.downloaded = 0; });
      this.emit('download-resumed', { id });
      this.startHlsDownload({
        id,
        url: download.url,
        filepath: download.filepath,
        headers: download.headers || {},
      }).catch(() => {});
      return;
    }
    download.status = 'downloading';
    this.emit('download-resumed', { id });
    // Re-launch active segments
    download.segments.forEach((seg, i) => {
      if (seg.status === 'paused' || seg.status === 'error') {
        seg.status = 'active';
        seg.retries = 0;
        const segSize = download.totalSize > 0
          ? Math.ceil(download.totalSize / download.totalSegments)
          : 0;
        const start = segSize * i;
        const end = download.totalSegments === 1 ? undefined : Math.min(start + segSize - 1, download.totalSize - 1);

        const newSeg = this._createSegment({
          downloadId: id,
          segmentIndex: i,
          url: download.finalUrl,
          filepath: download.filepath,
          start,
          end,
          headers: download.headers,
        });
        download.segments[i] = newSeg;
      }
    });
  }

  cancelDownload(id) {
    const download = this.activeSegments.get(id);
    if (!download) return;
    download.cancelled = true;
    if (download.currentReq) {
      try { download.currentReq.destroy(); } catch (e) {}
      download.currentReq = null;
    }
    download.segments.forEach(seg => {
      if (seg.request) seg.request.destroy();
    });
    download.status = 'cancelled';
    this.activeSegments.delete(id);
    // Clean up partial file
    try { fs.unlinkSync(download.filepath); } catch (e) {}
  }

  getDownload(id) {
    return this.activeSegments.get(id);
  }

  // ── HLS (m3u8) downloads ───────────────────────────────────────────────────
  // Assembles an unencrypted, finished (VOD) HLS stream segment-by-segment
  // into a single .ts file (plays in VLC and most players).
  // Refuses encrypted (EXT-X-KEY / DRM) and live (no ENDLIST) streams.

  _fetchUrl(url, { headers = {}, timeoutMs = 30000, maxRedirects = 5, onRequest = null } = {}) {
    return new Promise((resolve, reject) => {
      const doFetch = (currentUrl, redirectsLeft) => {
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
          method: 'GET',
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'AiDM/1.0 Download Manager', ...headers },
          timeout: timeoutMs,
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            try {
              doFetch(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
            } catch (e) {
              reject(e);
            }
            return;
          }
          // 2xx are all successes: 200 = whole body, 206 = partial content
          // (returned when we ask for a byte range with `Range:`).
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({ buf, text: buf.toString('utf8'), finalUrl: currentUrl, status: res.statusCode });
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout for ' + currentUrl)); });
        if (onRequest) onRequest(req);
        req.end();
      };
      doFetch(url, maxRedirects);
    });
  }

  async startHlsDownload({ id, url, filepath, headers = {} }) {
    let download = this.activeSegments.get(id);
    if (!download || !download.hls) {
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
    } else {
      download.status = 'downloading';
      download.startTime = Date.now();
      download.downloadedSize = 0;
      download.totalSize = 0;
    }

    const emitProgress = (segDone, segTotal) => {
      const elapsed = (Date.now() - download.startTime) / 1000;
      download.speed = elapsed > 0 ? download.downloadedSize / elapsed : 0;
      this.emit('download-progress', {
        id,
        downloaded: download.downloadedSize,
        total: download.totalSize,
        totalSize: download.totalSize,
        speed: download.speed,
        percent: segTotal > 0 ? (segDone / segTotal * 100).toFixed(1) : 0,
        segments: download.segments.map(s => ({ index: s.index, downloaded: s.downloaded, status: s.status })),
      });
    };

    const fail = (msg) => {
      download.status = 'error';
      download.error = msg;
      download.segments.forEach(s => { s.status = 'error'; });
      this.emit('download-error', { id, error: msg });
      throw new Error(msg);
    };

    const trackReq = (req) => { download.currentReq = req; };

    try {
      // 1. Fetch playlist (master or media)
      let fetched;
      try {
        fetched = await this._fetchUrl(url, { headers, onRequest: trackReq });
      } catch (err) {
        return fail('Could not fetch stream playlist: ' + err.message);
      }
      download.currentReq = null;
      if (download.cancelled || download.status === 'paused') return;
      let text = fetched.text;
      let baseUrl = fetched.finalUrl;
      download.finalUrl = baseUrl;

      // 2. Master playlist? Pick the highest-resolution variant.
      if (/#EXT-X-STREAM-INF/i.test(text)) {
        // #EXT-X-SESSION-KEY is only DRM when it isn't plain AES-128. Twitter/X
        // master playlists carry SESSION-KEY:METHOD=AES-128, which is decryptable,
        // so only refuse genuine DRM (SAMPLE-AES / custom key systems).
        const skm = text.match(/#EXT-X-SESSION-KEY:([^\r\n]*)/i);
        if (skm) {
          const getA = (name) => {
            const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|([^,]*))', 'i');
            const mm = skm[1].match(re);
            if (!mm) return null;
            return mm[1] !== undefined ? mm[1] : (mm[2] !== undefined ? mm[2].trim() : null);
          };
          const sm = (getA('METHOD') || 'NONE').toUpperCase();
          const skf = (getA('KEYFORMAT') || 'identity').toLowerCase();
          const isPlainAes = sm === 'AES-128' && (skf === 'identity' || skf === '' || skf === 'null');
          if (sm !== 'NONE' && !isPlainAes) {
            return fail('DRM-protected stream is not supported');
          }
        }
        const variants = parseHlsMaster(text, baseUrl);
        if (!variants.length) return fail('Stream playlist has no playable variants');
        variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
        try {
          fetched = await this._fetchUrl(variants[0].url, { headers, onRequest: trackReq });
        } catch (err) {
          return fail('Could not fetch stream variant: ' + err.message);
        }
        download.currentReq = null;
        if (download.cancelled || download.status === 'paused') return;
        text = fetched.text;
        baseUrl = fetched.finalUrl;
      }

      // 3. Encryption. Ordinary AES-128 with a fetchable key IS supported —
      //    that's exactly what Twitter/X (and many CDNs) serve. Only genuine
      //    DRM (SAMPLE-AES / custom KEYFORMAT) is refused.
      const keyInfo = parseHlsKey(text);
      let aesKey = null;
      let aesIv = null;
      if (keyInfo && keyInfo.method !== 'NONE') {
        const kf = (keyInfo.keyformat || 'identity').toLowerCase();
        if (keyInfo.method === 'AES-128' && (kf === 'identity' || kf === '' || kf === 'null')) {
          if (!keyInfo.uri) return fail('Encrypted stream (AES-128) has no key URI');
          let keyUrl;
          try { keyUrl = new URL(keyInfo.uri, baseUrl).href; }
          catch (e) { return fail('Encrypted stream has an invalid key URI'); }
          try {
            const kr = await this._fetchUrl(keyUrl, { headers, onRequest: trackReq });
            if (!kr.buf || kr.buf.length < 16) return fail('Invalid AES-128 key (expected 16 bytes)');
            aesKey = kr.buf.slice(0, 16);
          } catch (err) {
            return fail('Could not fetch decryption key: ' + err.message);
          }
          download.currentReq = null;
          if (download.cancelled || download.status === 'paused') return;
          if (keyInfo.iv) {
            const ivBuf = Buffer.from(String(keyInfo.iv).replace(/^0x/i, ''), 'hex');
            if (ivBuf.length === 16) aesIv = ivBuf;
          }
        } else {
          return fail('Unsupported stream protection: ' + keyInfo.method +
            (kf && kf !== 'identity' ? ' (' + kf + ')' : '') + ' — DRM is not supported');
        }
      }

      if (!/#EXT-X-ENDLIST/i.test(text)) return fail('Live streams are not supported — only finished videos');

      const { mapUri, mapRange, segs } = parseHlsMedia(text, baseUrl);
      const mediaSeq = parseHlsMediaSequence(text);
      if (!segs.length) return fail('Stream playlist contains no segments');
      if (segs.length > 5000) return fail('Stream too long (>5000 segments)');

      // 4. Download init segment + media segments sequentially, append to .ts.
      //    Every queue entry is `{url, range}`; `range` is set for
      //    #EXT-X-BYTERANGE segments, which must be fetched with a Range header
      //    instead of downloading the whole underlying resource each time.
      const queue = [];
      if (mapUri) queue.push({ url: mapUri, range: mapRange });
      for (const s of segs) queue.push(s);
      const fd = fs.openSync(filepath, 'w');
      let writePos = 0;
      try {
        for (let i = 0; i < queue.length; i++) {
          if (download.cancelled || download.status === 'paused') return;
          let buf = null;
          let lastErr = null;
          const seg = queue[i];
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const segHeaders = seg.range
                ? Object.assign({}, headers, {
                    Range: `bytes=${seg.range.offset}-${seg.range.offset + seg.range.length - 1}`,
                  })
                : headers;
              const r = await this._fetchUrl(seg.url, { headers: segHeaders, timeoutMs: 45000, onRequest: trackReq });
              download.currentReq = null;
              buf = r.buf;
              // Some CDNs ignore `Range:` and answer 200 with the whole
              // resource. Carve out the requested sub-range ourselves so the
              // assembled stream stays byte-correct.
              if (seg.range && r.status !== 206 && buf.length > seg.range.length) {
                buf = buf.slice(seg.range.offset, seg.range.offset + seg.range.length);
              }
              break;
            } catch (err) {
              lastErr = err;
              if (download.cancelled || download.status === 'paused') return;
              await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
            }
          }
          if (!buf) return fail(`Segment ${i + 1}/${queue.length} failed: ${lastErr ? lastErr.message : 'unknown error'}`);

          // AES-128: decrypt this segment before writing. The init/map segment
          // (when present) is never encrypted, so skip index 0 in that case.
          if (aesKey && !(mapUri && i === 0)) {
            const seqIndex = mapUri ? i - 1 : i;
            let iv = aesIv;
            if (!iv) {
              iv = Buffer.alloc(16);
              iv.writeUInt32BE(mediaSeq + seqIndex, 12);
            }
            try {
              const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
              buf = Buffer.concat([decipher.update(buf), decipher.final()]);
            } catch (e) {
              return fail('Failed to decrypt segment ' + (seqIndex + 1) + ': ' + e.message);
            }
          }

          fs.writeSync(fd, buf, 0, buf.length, writePos);
          writePos += buf.length;
          download.downloadedSize = writePos;
          download.segments[0].downloaded = writePos;
          emitProgress(i + 1, queue.length);
        }
      } finally {
        try { fs.closeSync(fd); } catch (e) {}
      }
      if (download.cancelled || download.status === 'paused') return;

      download.segments[0].status = 'completed';
      download.status = 'completed';
      this.emit('download-complete', {
        id,
        filepath,
        totalSize: writePos,
        duration: Date.now() - download.startTime,
      });
    } catch (err) {
      // fail() already emitted; anything else is pause/cancel noise
      if (download.status !== 'paused' && !download.cancelled && download.status !== 'error') {
        fail(err.message);
      }
    }
  }
}

/**
 * Parse an HLS master playlist into variant entries.
 * @returns [{ url, bandwidth, width, height }]
 */
function parseHlsMaster(text, baseUrl) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.toUpperCase().startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = /BANDWIDTH=(\d+)/i.exec(line);
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (l && !l.startsWith('#')) { uri = l; break; }
    }
    if (!uri) continue;
    try {
      out.push({
        url: new URL(uri, baseUrl).toString(),
        bandwidth: bw ? parseInt(bw[1], 10) : 0,
        width: res ? parseInt(res[1], 10) : 0,
        height: res ? parseInt(res[2], 10) : 0,
      });
    } catch (e) {}
  }
  return out;
}

/**
 * Parse `#EXT-X-BYTERANGE:<n>[@<o>]`.
 * Per RFC 8216 4.3.2.2: when the offset is omitted, the sub-range starts at
 * the byte right after the previous byte-ranged segment (0 if there is none).
 * @param {string} line   the raw playlist line
 * @param {number} fallbackOffset offset to use when `@<o>` is absent
 * @returns {{length:number, offset:number}|null}
 */
function parseHlsByterange(line, fallbackOffset) {
  const m = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?\s*$/i.exec(String(line || '').trim());
  if (!m) return null;
  const length = parseInt(m[1], 10);
  if (!Number.isFinite(length) || length < 0) return null;
  const offset = m[2] !== undefined ? parseInt(m[2], 10) : (Number.isFinite(fallbackOffset) ? fallbackOffset : 0);
  if (!Number.isFinite(offset) || offset < 0) return null;
  return { length, offset };
}

/**
 * Parse an HLS media playlist into an init segment + media segments.
 *
 * Segments are returned as descriptors rather than bare strings, because a
 * segment may be a byte sub-range of a larger resource (`#EXT-X-BYTERANGE`).
 * Twitter/X and several CDNs serve playlists like that, and downloading the
 * whole resource for each segment would produce a corrupt file.
 *
 * @returns {{ mapUri: string|null, mapRange: {length:number,offset:number}|null,
 *             segs: Array<{url:string, range:{length:number,offset:number}|null}> }}
 */
function parseHlsMedia(text, baseUrl) {
  const lines = String(text || '').split('\n');
  let mapUri = null;
  let mapRange = null;
  const segs = [];
  let pendingRange = null;
  let nextOffset = 0; // rolling offset for `@`-less byte ranges

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.toUpperCase().startsWith('#EXT-X-MAP:')) {
      const m = /URI="([^"]+)"/i.exec(line);
      if (m) {
        try { mapUri = new URL(m[1], baseUrl).toString(); } catch (e) {}
        // #EXT-X-MAP may carry its own BYTERANGE="<n>[@<o>]" attribute.
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
      segs.push({ url: new URL(line, baseUrl).toString(), range: pendingRange });
    } catch (e) {}
    pendingRange = null;
  }
  return { mapUri, mapRange, segs };
}

module.exports = { DownloadEngine, parseHlsMaster, parseHlsMedia, parseHlsKey, parseHlsMediaSequence };
