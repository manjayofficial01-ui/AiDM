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

  // Mark ourselves as loaded
  postToContentScript('interceptor-ready', {});
})();
