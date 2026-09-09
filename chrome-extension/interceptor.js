/**
 * AiDM Interceptor — MAIN world script
 * Runs in the page's JS context (world: "MAIN") at document_start.
 *
 * Monkey-patches URL.createObjectURL, HTMLMediaElement.src setter, and
 * XMLHttpRequest/fetch to capture real media URLs that the page's player
 * wraps inside blob: URLs via MediaSource Extensions (MSE).
 *
 * Communicates discovered URLs back to the ISOLATED content script via
 * window.postMessage (the only cross-world channel available in MV3).
 */
(function () {
  'use strict';

  // ── Dedup & rate-limit ────────────────────────────────────────────────────
  const sentUrls = new Set();
  const MAX_SENT = 2000;

  function postToContentScript(type, payload) {
    try {
      window.postMessage({ source: 'aidm-interceptor', type, ...payload }, '*');
    } catch (e) { /* swallow */ }
  }

  function notifyUrl(url, extra) {
    if (!url || typeof url !== 'string') return;
    if (sentUrls.has(url)) return;
    if (!/^https?:/i.test(url)) return;
    sentUrls.add(url);
    if (sentUrls.size > MAX_SENT) {
      const first = sentUrls.values().next().value;
      sentUrls.delete(first);
    }
    postToContentScript('media-url', { url, ...extra });
  }

  // ── Media-URL heuristics ──────────────────────────────────────────────────
  const VIDEO_RE = /\.(mp4|webm|mkv|avi|mov|flv|m4v|ts|m4s)(\?|#|$)/i;
  const STREAM_RE = /\.(m3u8|mpd)(\?|#|$)/i;
  const AUDIO_RE = /\.(mp3|wav|flac|aac|ogg|wma|m4a|opus)(\?|#|$)/i;
  const CDN_RE = /googlevideo\.com|cdn.*video|video.*cdn|\.cdn\.|akamaihd\.net|cloudfront\.net|fastly/i;
  const XTREAM_RE = /\/(live|movie|series)\/[^/?#]+\/[^/?#]+\/\d+\.(m3u8|ts|mp4|mkv|avi)/i;
  const PATH_RE = /videoplayback|\/get_file\/|\/hls\/|\/dash\/|\/mp4\/|\/videos?\//i;

  function looksLikeMedia(url) {
    return VIDEO_RE.test(url) || STREAM_RE.test(url) || AUDIO_RE.test(url) ||
           CDN_RE.test(url) || XTREAM_RE.test(url) || PATH_RE.test(url);
  }

  function looksLikeMediaContentType(ct) {
    if (!ct || typeof ct !== 'string') return false;
    ct = ct.toLowerCase();
    return ct.startsWith('video/') || ct.startsWith('audio/') ||
           ct === 'application/vnd.apple.mpegurl' ||
           ct === 'application/x-mpegurl' ||
           ct === 'application/dash+xml' ||
           ct === 'application/octet-stream'; // many CDNs use this for video
  }

  // ── Twitter / X video support ───────────────────────────────────────────────
  // Twitter's web player streams AES-128-encrypted HLS (.m3u8) during playback,
  // which the AiDM download engine deliberately refuses. But the same GraphQL
  // media JSON that the player fetches also lists the direct, UNENCRYPTED MP4
  // variants at video.twimg.com/ext_tw_video/.../pu/vid/<W>x<H>/<id>.mp4 (and
  // older amplify_video/.../vid.mp4). This is what IDM grabs. So we parse that
  // JSON and surface the MP4 variant URLs as normal media — they route through
  // the plain HTTP downloader, not the HLS engine.

  function isTwitterApiUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      const h = u.hostname.toLowerCase();
      if (!(h.endsWith('twitter.com') || h.endsWith('x.com'))) return false;
      // The video metadata lives under the GraphQL API (and legacy 1.1/i endpoints).
      return /\/graphql(\/|$)/i.test(u.pathname) ||
             /\/(?:1\.1|i)\//i.test(u.pathname) ||
             /\bvideo\b/i.test(u.pathname + u.search);
    } catch (e) {
      return false;
    }
  }

  // Cheap guard before we pay to materialize a response body.
  function maybeTwitterVideoJson(text) {
    if (!text || text.length < 64) return false;
    return /ext_tw_video|amplify_video|video_info|video\.twimg\.com|t\.twimg\.com/i.test(text);
  }

  function decodeJsonUrl(s) {
    // Twitter sometimes HTML-escapes JSON embedded in pages, and GraphQL over
    // the wire may contain \u0026 for &. Normalize the common escapes.
    return String(s)
      .replace(/\\u0026/g, '&')
      .replace(/\\u003c/g, '<')
      .replace(/\\u003e/g, '>')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"');
  }

  /**
   * Extract direct Twitter MP4 variant URLs from a GraphQL/timeline JSON body.
   * Returns an array of https URLs (highest-bitrate variant preferred, but all
   * distinct resolutions are returned so the capsule can offer quality choices).
   */
  function extractTwitterMp4s(text) {
    if (!maybeTwitterVideoJson(text)) return [];
    const out = new Set();

    // 1) Raw MP4 URLs with the known Twitter CDN path patterns.
    const mp4Re = /https?:\/\/[^\s"'\\<>]*?(?:ext_tw_video|amplify_video|t\.twimg\.com|video\.twimg\.com)[^\s"'\\<>]*?\.mp4[^\s"'\\<>]*/gi;
    let m;
    while ((m = mp4Re.exec(text)) !== null) out.add(decodeJsonUrl(m[0]));

    // 2) JSON-aware: video/mp4 variants carry { url, bitrate }. Order-independent.
    try {
      const variantRe = /"content_type"\s*:\s*"video\/mp4"[^}]*?"url"\s*:\s*"([^"]+)"/gi;
      while ((m = variantRe.exec(text)) !== null) out.add(decodeJsonUrl(m[1]));
    } catch (e) { /* swallow */ }
    try {
      const variantRe2 = /"url"\s*:\s*"([^"]+)"[^}]*?"content_type"\s*:\s*"video\/mp4"/gi;
      while ((m = variantRe2.exec(text)) !== null) out.add(decodeJsonUrl(m[1]));
    } catch (e) { /* swallow */ }

    // 3) Fallback: any video/mp4 URL field anywhere in the body.
    try {
      const anyRe = /"url"\s*:\s*"(https?:\/\/[^"]*?\.mp4[^"]*)"/gi;
      while ((m = anyRe.exec(text)) !== null) {
        const u = decodeJsonUrl(m[1]);
        if (/twimg\.com|twitter|ext_tw_video|amplify_video/i.test(u)) out.add(u);
      }
    } catch (e) { /* swallow */ }

    // Twitter's public MP4 on twimg needs no query/fragment — strip it so the
    // same variant isn't offered twice (once with ?tag=…, once without) and to
    // produce the most robust, hotlink-proof URL.
    const cleaned = Array.from(out).map(u => {
      try {
        const noFrag = u.split('#')[0];
        const cut = Math.min(
          noFrag.indexOf('?') >= 0 ? noFrag.indexOf('?') : Infinity,
          noFrag.indexOf('&') >= 0 ? noFrag.indexOf('&') : Infinity
        );
        return cut === Infinity ? noFrag : noFrag.slice(0, cut);
      } catch (e) { return u; }
    });
    return Array.from(new Set(cleaned)).filter(u => /^https?:/i.test(u));
  }

  function notifyTwitterMp4s(text, via) {
    try {
      const urls = extractTwitterMp4s(text);
      urls.forEach(u => notifyUrl(u, { via, contentType: 'video/mp4' }));
    } catch (e) { /* swallow */ }
  }

  // NOTE ON TWITTER MP4s — do NOT try to derive them from the HLS playlist.
  // A widely repeated trick says you can swap `/pl/` for `/vid/` and `.m3u8`
  // for `.mp4`. That is false: verified against a real tweet, the playlist and
  // the MP4 use DIFFERENT hashes -
  //   /pu/pl/480x360/FIEgxZpmsPAhzqP9.m3u8
  //   /pu/vid/480x360/Du6ODfDSnDJ3rQqd.mp4
  // so any derived URL 404s. The only reliable source for the direct MP4s is
  // the tweet's media metadata, which the AiDM app fetches server-side via the
  // public syndication endpoint (see src/twitter-resolver.js). The extension
  // just tells the app which tweet it is looking at; background.js does that.

  // Periodic sweep of everything the page has already loaded. Catches media
  // that started before our hooks were installed, or that the page fetched in
  // a way we don't patch.
  function scanPerformanceResources() {
    try {
      const entries = performance.getEntriesByType('resource');
      for (const e of entries) {
        const n = e.name;
        if (!n || !/^https?:/i.test(n)) continue;
        if (looksLikeMedia(n)) notifyUrl(n, { via: 'perf' });
      }
    } catch (e) { /* swallow */ }
  }

  // ── 1. Intercept URL.createObjectURL ──────────────────────────────────────
  const origCreateObjectURL = URL.createObjectURL;

  URL.createObjectURL = function (obj) {
    const blobUrl = origCreateObjectURL.apply(this, arguments);
    try {
      if (obj instanceof MediaSource) {
        postToContentScript('mse-blob', { blobUrl });
      }
    } catch (e) { /* swallow */ }
    return blobUrl;
  };

  // ── 2. Intercept HTMLMediaElement.src setter ──────────────────────────────
  try {
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (srcDesc && srcDesc.set) {
      const origSet = srcDesc.set;
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        ...srcDesc,
        set(value) {
          try {
            if (value && typeof value === 'string' && /^https?:/i.test(value)) {
              notifyUrl(value, { via: 'src-setter', tag: this.tagName });
            }
          } catch (e) { /* swallow */ }
          return origSet.call(this, value);
        },
      });
    }
  } catch (e) { /* property not writable on this browser — skip */ }

  // ── 3. Intercept XMLHttpRequest ───────────────────────────────────────────
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const xhrUrls = new WeakMap();

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url && typeof url === 'string') {
        const resolved = new URL(url, location.href).href;
        xhrUrls.set(this, resolved);
      }
    } catch (e) { /* swallow */ }
    return origXhrOpen.apply(this, arguments);
  };

  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    try {
      const url = xhrUrls.get(this);
      if (url && looksLikeMedia(url)) {
        notifyUrl(url, { via: 'xhr' });
      }
      // Also check Content-Type on response
      this.addEventListener('load', function onLoad() {
        try {
          const ct = this.getResponseHeader('Content-Type');
          const url2 = xhrUrls.get(this) || this.responseURL;
          if (url2 && looksLikeMediaContentType(ct)) {
            notifyUrl(url2, { via: 'xhr-ct', contentType: ct });
          }
          // Twitter: the media JSON is in the response body, not a media request.
          if (url2 && isTwitterApiUrl(url2)) {
            const rt = this.responseType;
            let body = null;
            if (rt === '' || rt === 'text') {
              body = this.responseText || '';
            } else if (rt === 'json' && this.response) {
              // responseType 'json' gives a parsed object — re-serialize it.
              try { body = JSON.stringify(this.response); } catch (e) { body = null; }
            }
            if (body) notifyTwitterMp4s(body, 'twitter-xhr');
          }
        } catch (e) { /* swallow */ }
      }, { once: true });
    } catch (e) { /* swallow */ }
    return origXhrSend.apply(this, arguments);
  };

  // ── 4. Intercept fetch ────────────────────────────────────────────────────
  const origFetch = window.fetch;

  window.fetch = function (input, init) {
    let url = null;
    try {
      if (typeof input === 'string') {
        url = new URL(input, location.href).href;
      } else if (input && input.url) {
        url = new URL(input.url, location.href).href;
      }
    } catch (e) { /* swallow */ }

    if (url && looksLikeMedia(url)) {
      notifyUrl(url, { via: 'fetch' });
    }
    // Twitter: try to upgrade an HLS playlist to a direct MP4.

    const result = origFetch.apply(this, arguments);

    // Check response Content-Type for media
    if (url) {
      result.then(resp => {
        try {
          const ct = resp.headers.get('Content-Type');
          const finalUrl = resp.url || url;
          if (looksLikeMediaContentType(ct)) {
            notifyUrl(finalUrl, { via: 'fetch-ct', contentType: ct });
          }
          // Twitter: the media JSON is in the GraphQL response body. Clone so we
          // don't consume the stream the page's player is still reading. Only
          // bother for JSON responses (cheap gate — Twitter GraphQL is JSON).
          if ((isTwitterApiUrl(finalUrl) || isTwitterApiUrl(url)) && ct && /json/i.test(ct)) {
            try {
              const cloned = resp.clone();
              cloned.text()
                .then(body => notifyTwitterMp4s(body, 'twitter-graphql'))
                .catch(() => { /* swallow */ });
            } catch (e) { /* swallow */ }
          }
        } catch (e) { /* swallow */ }
      }).catch(() => { /* swallow */ });
    }

    return result;
  };

  // ── 5. Intercept <source> element src setting ─────────────────────────────
  try {
    const sourceSrcDesc = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
    if (sourceSrcDesc && sourceSrcDesc.set) {
      const origSourceSet = sourceSrcDesc.set;
      Object.defineProperty(HTMLSourceElement.prototype, 'src', {
        ...sourceSrcDesc,
        set(value) {
          try {
            if (value && typeof value === 'string' && /^https?:/i.test(value)) {
              notifyUrl(value, { via: 'source-src' });
            }
          } catch (e) { /* swallow */ }
          return origSourceSet.call(this, value);
        },
      });
    }
  } catch (e) { /* swallow */ }

  // ── 6. Expose known-player extraction helpers ─────────────────────────────
  // These run in the MAIN world where page JS objects are accessible.
  // Called on-demand by the content script via postMessage.

  function extractPlayerSources() {
    const sources = [];

    // JW Player
    try {
      if (typeof jwplayer === 'function') {
        const inst = jwplayer();
        if (inst && typeof inst.getPlaylistItem === 'function') {
          const item = inst.getPlaylistItem();
          if (item) {
            (item.sources || [item]).forEach(s => {
              if (s.file) sources.push({ url: s.file, via: 'jwplayer', label: s.label || '' });
            });
            if (item.file) sources.push({ url: item.file, via: 'jwplayer' });
          }
        }
      }
    } catch (e) { /* swallow */ }

    // Video.js
    try {
      if (typeof videojs === 'function') {
        const players = videojs.getAllPlayers ? videojs.getAllPlayers() : [];
        players.forEach(p => {
          try {
            const srcs = p.currentSources ? p.currentSources() : (p.currentSource ? [p.currentSource()] : []);
            srcs.forEach(s => {
              if (s.src) sources.push({ url: s.src, via: 'videojs', type: s.type || '' });
            });
          } catch (e) { /* swallow */ }
        });
      }
    } catch (e) { /* swallow */ }

    // Plyr
    try {
      if (typeof Plyr !== 'undefined') {
        document.querySelectorAll('.plyr').forEach(el => {
          const p = el.__plyr || el.plyr;
          if (p && p.source && p.source.sources) {
            p.source.sources.forEach(s => {
              if (s.src) sources.push({ url: s.src, via: 'plyr' });
            });
          }
        });
      }
    } catch (e) { /* swallow */ }

    // Flowplayer
    try {
      if (typeof flowplayer === 'function') {
        const fp = flowplayer();
        if (fp && fp.video && fp.video.src) {
          sources.push({ url: fp.video.src, via: 'flowplayer' });
        }
      }
    } catch (e) { /* swallow */ }

    // Clappr
    try {
      if (typeof Clappr !== 'undefined') {
        document.querySelectorAll('[data-clappr]').forEach(el => {
          const p = el.__clappr;
          if (p && p.options && p.options.source) {
            sources.push({ url: p.options.source, via: 'clappr' });
          }
        });
      }
    } catch (e) { /* swallow */ }

    // Generic: scan window for known player config patterns
    try {
      // Many sites expose a global config object
      const configKeys = ['playerConfig', 'videoConfig', 'embedConfig', 'mediaConfig'];
      configKeys.forEach(key => {
        const cfg = window[key];
        if (cfg && typeof cfg === 'object') {
          const candidates = [cfg.url, cfg.src, cfg.source, cfg.file, cfg.stream,
                              cfg.videoUrl, cfg.video_url, cfg.streamUrl, cfg.stream_url,
                              cfg.mp4, cfg.hls, cfg.dash, cfg.m3u8];
          candidates.forEach(c => {
            if (c && typeof c === 'string' && /^https?:/i.test(c)) {
              sources.push({ url: c, via: 'globalConfig:' + key });
            }
          });
        }
      });
    } catch (e) { /* swallow */ }

    return sources;
  }

  // Listen for extraction requests from the content script
  window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'aidm-content' && e.data.type === 'extract-players') {
      const sources = extractPlayerSources();
      postToContentScript('player-sources', { sources });
    }
  });

  // ── 7. Auto-scan on media events ──────────────────────────────────────────
  // When any video starts playing, try to extract player sources
  document.addEventListener('playing', () => {
    try {
      const sources = extractPlayerSources();
      sources.forEach(s => notifyUrl(s.url, { via: s.via }));
    } catch (e) { /* swallow */ }
  }, true);

  // Sweep periodically so media that loaded before our hooks were installed,
  // or via a path we don't patch, still gets picked up.
  try {
    setInterval(scanPerformanceResources, 3000);
    setTimeout(scanPerformanceResources, 1500);
  } catch (e) { /* swallow */ }

  // Mark ourselves as loaded
  postToContentScript('interceptor-ready', {});
})();
