/**
 * AiDM Content Script v2
 * Auto-detects downloadable videos with quality/resolution/size info
 * Scans for video sources, HLS manifests, and direct download links
 */

(function() {
  'use strict';

  // ── Patterns ─────────────────────────────────────────────────────────────────

  const VIDEO_EXT = /\.(mp4|webm|mkv|avi|mov|flv|m4v|ts)(\?|#|$)/i;
  const STREAM_EXT = /\.(m3u8|mpd)(\?|#|$)/i;
  const AUDIO_EXT = /\.(mp3|wav|flac|aac|ogg|wma|m4a|opus)(\?|#|$)/i;
  const DOWNLOAD_EXT = /\.(zip|rar|7z|tar|gz|exe|msi|iso|dmg|deb|rpm|apk|pdf|doc|docx|xls|xlsx|ppt|pptx)(\?|#|$)/i;

  const VIDEO_HOSTS = [
    /googlevideo\.com/i,
    /youtube\.com\/videoplayback/i,
    /cdn.*video/i,
    /stream.*video/i,
    /video.*cdn/i,
    /\.cdn\./i,
    /twimg\.com/i,        // Twitter / X video CDN (direct MP4 variants)
  ];

  // Xtream-Codes style streams: /live|movie|series/user/pass/id.ext
  // (kept precise — a bare "/movie/" would match article pages)
  const XTREAM_RE = /\/(live|movie|series)\/[^/?#]+\/[^/?#]+\/\d+\.(m3u8|ts|mp4|mkv|avi)/i;

  // Per-request token params stripped when comparing stream URLs
  const TOKEN_PARAMS = new Set([
    'token', 'tokens', 'sig', 'signature', 'sign', 'expires', 'expiry', 'exp',
    'e', 'h', 'hdnea', 'hdntl', 'hdnts', 'st', 'key', 'auth', 'authkey',
    'wmsauthsign', 'mst', 'access_token', 'token_expires', 'session', 'sid',
    'policy', 'token_hash', 'verify', 'md5', 't', 'ts', '_',
  ]);

  function normalizeStreamUrl(u) {
    try {
      const x = new URL(String(u || '').trim());
      x.hash = '';
      x.hostname = x.hostname.toLowerCase();
      const params = Array.from(x.searchParams.entries())
        .filter(([k]) => !TOKEN_PARAMS.has(k.toLowerCase()));
      params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
      const qs = new URLSearchParams();
      params.forEach(([k, v]) => qs.append(k, v));
      x.search = qs.toString();
      return x.toString();
    } catch (e) {
      return null;
    }
  }

  // ── KVS Player (Nubiles et al.) ──────────────────────────────────────────────
  // Nubiles, BustyAR, PetitesRDS, and many other sites use KVS player.
  // Video URLs live in a `flashvars` JS variable, may be obfuscated with
  // a license_code that needs a character-permutation decode before the
  // /get_file/ URL can be fetched.

  const KVS_GET_FILE_RE = /\/get_file\/[0-9a-f]+/i;

  function kvsGetLicenseToken(license) {
    try {
      const mod = license.replace(/\$/g, '').replace(/0/g, '1');
      const center = Math.floor(mod.length / 2);
      const front = parseInt(mod.slice(0, center + 1), 10);
      const back  = parseInt(mod.slice(center), 10);
      return String(4 * Math.abs(front - back));
    } catch { return ''; }
  }

  function kvsDecodeUrl(videoUrl, licenseCode) {
    if (!videoUrl || !licenseCode) return videoUrl;
    if (!videoUrl.startsWith('function/0/')) return videoUrl;
    try {
      const qPos = videoUrl.indexOf('?');
      const urlPath = qPos >= 0 ? videoUrl.slice(0, qPos) : videoUrl;
      const urlQuery = qPos >= 0 ? videoUrl.slice(qPos + 1) : '';
      const parts = urlPath.split('/');
      // parts[0]='function', parts[1]='0', parts[2..]=actual path segments
      const token = kvsGetLicenseToken(licenseCode);
      const seg = parts[5] || '';
      let magic = seg.slice(0, 32);
      const rest = seg.slice(32);
      function permute(str, offset) {
        const a = str.split('');
        const len = a.length;
        const l = (offset + [...a].reduce((s, c) => s + parseInt(c, 10) || 0, 0)) % len;
        const tmp = a[offset];
        a[offset] = a[l];
        a[l] = tmp;
        return a.join('');
      }
      for (let o = magic.length - 1; o >= 0; o--) {
        const t = parseInt(token[o % token.length], 10) || 0;
        magic = permute(magic, o + t);
      }
      parts[5] = magic + rest;
      return parts.join('/') + (urlQuery ? '?' + urlQuery : '');
    } catch {
      return videoUrl;
    }
  }

  function extractKvsFlashvars() {
    const videos = [];
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const text = s.textContent || '';
        // Match: var flashvars = { ... }; or flashvars = { ... };
        const m = text.match(/(?:var\s+)?flashvars\s*=\s*(\{[\s\S]+?\});/);
        if (!m) continue;
        let fv;
        try {
          // js_to_json style: single quotes → double, unquoted keys
          const raw = m[1]
            .replace(/'/g, '"')
            .replace(/,\s*([\]}])/g, '$1');
          fv = JSON.parse(raw);
        } catch {
          // Try eval as last resort (flashvars is plain JS object literal)
          try { fv = new Function('return ' + m[1])(); } catch { continue; }
        }
        if (!fv || typeof fv !== 'object') continue;

        const licenseCode = fv.license_code || '';
        const title = fv.video_title || fv.alt_video_title || document.title || '';

        // Collect all video_url / video_alt_url* keys (video_url is primary!)
        const urlKeys = Object.keys(fv).filter(k => /^video(?:_url|_alt_url\d*)?$/.test(k));
        for (const key of urlKeys) {
          let url = fv[key];
          if (!url || typeof url !== 'string') continue;
          if (url.startsWith('//')) url = location.protocol + url;
          else if (url.startsWith('/')) url = location.origin + url;

          // Decode obfuscated KVS URLs
          url = kvsDecodeUrl(url, licenseCode);

          const label = fv[key + '_text'] || key.replace(/_/g, ' ');
          // Try to extract resolution from label or URL
          const resMatch = label.match(/(\d{3,4})p/i) || url.match(/_(\d{3,4})p/);
          const height = resMatch ? parseInt(resMatch[1], 10) : 0;
          const quality = height ? height + 'p' : 'unknown';
          const resolution = height ? (height >= 2160 ? '3840x2160' :
            height >= 1440 ? '2560x1440' :
            height >= 1080 ? '1920x1080' :
            height >= 720 ? '1280x720' :
            height >= 480 ? '854x480' :
            height >= 360 ? '640x360' :
            height >= 240 ? '426x240' : '256x144') : null;

          videos.push({
            url,
            quality,
            resolution,
            size: null,
            format: 'mp4',
            title,
            kvs: true,
            encrypted: false,
          });
        }
        if (videos.length) break; // found flashvars, stop scanning
      }
    } catch (e) {}
    return videos;
  }

  // Known quality labels → resolution mapping
  const QUALITY_MAP = {
    '2160p': { resolution: '3840x2160', label: '4K (2160p)', tier: 5 },
    '1440p': { resolution: '2560x1440', label: '2K (1440p)', tier: 4 },
    '1080p': { resolution: '1920x1080', label: 'Full HD (1080p)', tier: 3 },
    '720p':  { resolution: '1280x720',  label: 'HD (720p)', tier: 2 },
    '480p':  { resolution: '854x480',   label: 'SD (480p)', tier: 1 },
    '360p':  { resolution: '640x360',   label: '360p', tier: 0 },
    '240p':  { resolution: '426x240',   label: '240p', tier: -1 },
    '144p':  { resolution: '256x144',   label: '144p', tier: -2 },
  };

  let detectedVideos = new Map(); // url -> { url, quality, resolution, size, format }
  let detectedLinks = new Set();
  let pageScanComplete = false;

  // Track MAIN world interceptor state
  const mseBlobUrls = new Set();
  const interceptedMediaUrls = new Set();
  const blobToRealUrlMap = new Map();

  function looksLikeMedia(url) {
    if (!url || typeof url !== 'string') return false;
    return VIDEO_EXT.test(url) || STREAM_EXT.test(url) || AUDIO_EXT.test(url) ||
           XTREAM_RE.test(url) || VIDEO_HOSTS.some(p => p.test(url)) ||
           /videoplayback|\/get_file\/|\/hls\/|\/dash\/|\/mp4\/|\/videos?\//i.test(url);
  }

  // ── Listen to MAIN world interceptor (interceptor.js) ────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'aidm-interceptor') return;
    const { type, url, blobUrl, sources } = event.data;

    if (type === 'media-url' && url) {
      if (!interceptedMediaUrls.has(url)) {
        interceptedMediaUrls.add(url);
        const info = detectQuality(url, null);
        if (!detectedVideos.has(url)) {
          detectedVideos.set(url, info);
          try {
            chrome.runtime.sendMessage({
              action: 'videos-with-quality',
              pageTitle: document.title,
              pageUrl: location.href,
              videos: [info],
            });
          } catch (e) {}
        }
        // If a video element is currently playing with blob:, map it
        document.querySelectorAll('video').forEach(v => {
          if (isPlayingVideo(v) && v.currentSrc && v.currentSrc.startsWith('blob:')) {
            blobToRealUrlMap.set(v.currentSrc, url);
          }
        });
        scheduleSyncCapsules();
      }
    } else if (type === 'player-sources' && Array.isArray(sources)) {
      const fresh = [];
      sources.forEach(s => {
        if (s && s.url && !detectedVideos.has(s.url)) {
          const info = detectQuality(s.url, null);
          if (s.label) info.quality = s.label;
          detectedVideos.set(s.url, info);
          fresh.push(info);
        }
      });
      if (fresh.length) {
        try {
          chrome.runtime.sendMessage({
            action: 'videos-with-quality',
            pageTitle: document.title,
            pageUrl: location.href,
            videos: fresh,
          });
        } catch (e) {}
      }
      scheduleSyncCapsules();
    } else if (type === 'mse-blob' && blobUrl) {
      mseBlobUrls.add(blobUrl);
      scheduleSyncCapsules();
    }
  });

  function requestPlayerExtraction() {
    try {
      window.postMessage({ source: 'aidm-content', type: 'extract-players' }, '*');
    } catch (e) {}
  }

  // ── Video Quality Detection ──────────────────────────────────────────────────

  /**
   * Try to determine video quality from URL parameters, filename, or
   * associated DOM elements (quality selectors, labels, etc.)
   */
  function detectQuality(url, element) {
    const info = { url, quality: 'unknown', resolution: null, size: null, format: null };

    // Extract format from URL
    const extMatch = url.match(/\.(\w{2,4})(\?|#|$)/);
    if (extMatch) info.format = extMatch[1].toLowerCase();

    // Twitter / X: the MP4 variant's resolution is encoded in its path, e.g.
    // .../ext_tw_video/.../pu/vid/1280x720/<id>.mp4  →  720p.
    const twRes = url.match(/\/vid\/(\d{2,5})x(\d{2,5})/i);
    if (twRes) {
      const h = parseInt(twRes[2], 10);
      const label = h + 'p';
      if (QUALITY_MAP[label]) {
        info.quality = label;
        info.resolution = QUALITY_MAP[label].resolution;
      } else {
        info.quality = label;
        info.resolution = parseInt(twRes[1], 10) + 'x' + h;
      }
      info.encrypted = false;
    }

    // Try URL parameters for quality hints
    const qualityPatterns = [
      [/itag=(\d+)/i, 1],               // YouTube itag (capture group!)
      [/quality[=_-](\w+)/i, 1],        // quality=high, quality_720p
      [/res[=_-](\d+p?)/i, 1],          // res=1080p
      [/(\d{3,4})p/i, 0],               // 720p, 1080p
      [/resolution[=_-](\w+)/i, 1],
      [/size[=_-](\d+)/i, 1],
      [/bitrate[=_-](\d+)/i, 1],
    ];

    for (const pattern of qualityPatterns) {
      const re = Array.isArray(pattern) ? pattern[0] : pattern;
      const group = Array.isArray(pattern) ? pattern[1] : 0;
      const m = url.match(re);
      if (m) {
        const val = m[group];
        // Check if it matches a known quality label
        for (const [key, qInfo] of Object.entries(QUALITY_MAP)) {
          if (val.toLowerCase().includes(key) || val === key) {
            info.quality = key;
            info.resolution = qInfo.resolution;
            break;
          }
        }
        // YouTube itag mapping (common values)
        if (/itag=/.test(url)) {
          const itag = parseInt(val);
          const itagMap = {
            37: '1080p', 46: '1080p', 22: '720p', 45: '720p',
            35: '480p', 44: '480p', 18: '360p', 43: '360p',
            137: '1080p', 299: '1080p', 264: '1440p', 308: '1440p',
            266: '2160p', 315: '2160p', 136: '720p', 298: '720p',
            135: '480p', 134: '360p', 133: '240p', 160: '144p',
          };
          if (itagMap[itag]) {
            info.quality = itagMap[itag];
            info.resolution = QUALITY_MAP[itagMap[itag]]?.resolution;
          }
        }
        if (info.quality !== 'unknown') break;
      }
    }

    // Try to get size from element data attributes
    if (element) {
      const sizeAttr = element.dataset.size || element.dataset.filesize ||
                       element.getAttribute('data-size') || element.getAttribute('data-content-length');
      if (sizeAttr) info.size = parseInt(sizeAttr);

      const resAttr = element.dataset.resolution || element.dataset.quality ||
                      element.getAttribute('data-resolution');
      if (resAttr) {
        info.quality = resAttr;
        if (QUALITY_MAP[resAttr]) info.resolution = QUALITY_MAP[resAttr].resolution;
      }
    }

    // Probe size asynchronously (never block the page thread — a sync XHR
    // here used to freeze the whole tab when a server was slow).
    if (!info.size && url.startsWith(window.location.origin)) {
      probeSizeAsync(url, info);
    }

    return info;
  }

  // ── Async size probing ─────────────────────────────────────────────────────
  // HEAD-probes the URL once, then patches the (shared) info object in place
  // so badges and the open panel refresh without another scan.

  const sizeProbeCache = new Map(); // url -> size|null|Promise

  function probeSizeAsync(url, info) {
    if (sizeProbeCache.has(url)) {
      const cached = sizeProbeCache.get(url);
      if (typeof cached === 'number' && cached > 0 && !info.size) info.size = cached;
      return;
    }
    const p = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, credentials: 'same-origin' });
        clearTimeout(timer);
        const len = res.headers.get('Content-Length');
        const size = len ? parseInt(len, 10) : null;
        sizeProbeCache.set(url, size);
        if (size && !info.size) {
          info.size = size;
          scheduleSyncCapsules();
          refreshOpenPanel();
        }
        return size;
      } catch (e) {
        sizeProbeCache.set(url, null);
        return null;
      }
    })();
    sizeProbeCache.set(url, p);
    if (sizeProbeCache.size > 200) sizeProbeCache.delete(sizeProbeCache.keys().next().value);
  }

  // Rebuild the currently open capsule panel (e.g. a size probe just resolved)
  function refreshOpenPanel() {
    try {
      if (openCapsuleVideo && capsuleState.get(openCapsuleVideo)) {
        const st = capsuleState.get(openCapsuleVideo);
        if (st.panel.style.display !== 'none') buildCapsulePanel(openCapsuleVideo);
      }
    } catch (e) {}
  }

  /**
   * Scan <video> and <source> elements for playable sources
   */
  function scanVideoElements() {
    const videos = [];

    document.querySelectorAll('video').forEach(video => {
      // Resolve the best available source URL (currentSrc > src > <source>)
      const candidates = [];
      if (video.currentSrc) candidates.push(video.currentSrc);
      if (video.src) candidates.push(video.src);
      video.querySelectorAll('source').forEach(source => {
        const s = source.src || source.getAttribute('src');
        if (s) candidates.push(s);
      });

      candidates.forEach(srcUrl => {
        let targetUrl = srcUrl;
        if (srcUrl && srcUrl.startsWith('blob:')) {
          targetUrl = blobToRealUrlMap.get(srcUrl);
        }
        if (targetUrl && targetUrl.startsWith('http')) {
          const info = detectQuality(targetUrl, video);
          // Try to get resolution from video element itself
          if (video.videoWidth && video.videoHeight) {
            info.resolution = `${video.videoWidth}x${video.videoHeight}`;
            info.quality = qualityFromHeight(video.videoHeight);
          }
          videos.push(info);
        }
      });
    });

    return videos;
  }

  /**
   * Scan for video quality variant links (like YouTube quality selectors,
   * or sites that list multiple download qualities)
   */
  function scanQualitySelectors() {
    const videos = [];

    // Common patterns for download quality links
    const selectors = [
      // YouTube-style quality menu
      '.ytp-quality-menu .ytp-menuitem',
      // Generic video download quality lists
      '[data-quality]', '[data-resolution]',
      'a[href*="quality"]', 'a[href*="1080"]', 'a[href*="720"]', 'a[href*="480"]',
      // Download buttons with quality labels
      '.download-quality a', '.quality-option', '.video-quality-item',
      '.download-link[data-quality]', '.resolution-option',
      // Common video download site patterns
      '.download-btn[data-href]', 'a.download[data-quality]',
    ];

    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        const rawHref = el.href || el.dataset.href || el.dataset.url;
        if (!rawHref) return;
        let href;
        try { href = new URL(rawHref, location.href).href; } catch (e) { return; }
        if (!/^https?:/i.test(href)) return;

        const info = detectQuality(href, el);
        // Try to get quality label from text content
        const text = el.textContent.trim();
        for (const [key, qInfo] of Object.entries(QUALITY_MAP)) {
          if (text.includes(key) || text.toLowerCase().includes(qInfo.label.toLowerCase())) {
            info.quality = key;
            info.resolution = qInfo.resolution;
            break;
          }
        }
        // Also check for size info in nearby text
        const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(MB|GB|KB)/i);
        if (sizeMatch) {
          const val = parseFloat(sizeMatch[1]);
          const unit = sizeMatch[2].toUpperCase();
          info.size = val * (unit === 'GB' ? 1073741824 : unit === 'MB' ? 1048576 : 1024);
        }

        videos.push(info);
      });
    });

    return videos;
  }

  /**
   * Scan performance entries for network-loaded video resources
   * (direct files, HLS/DASH manifests and Xtream-style streams)
   */
  function scanNetworkResources() {
    const videos = [];
    const entries = performance.getEntriesByType('resource');

    entries.forEach(entry => {
      const url = entry.name;
      if (VIDEO_EXT.test(url) || STREAM_EXT.test(url) || XTREAM_RE.test(url) ||
          VIDEO_HOSTS.some(p => p.test(url))) {
        const info = detectQuality(url, null);
        // Performance API gives us transfer size
        if (entry.transferSize > 0) info.size = entry.transferSize;
        videos.push(info);
      }
    });

    return videos;
  }

  /**
   * Scan all <a> tags and download-bearing elements for direct download links
   */
  function scanLinks() {
    // 1. Standard anchor links
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.href;
      if (DOWNLOAD_EXT.test(href) || AUDIO_EXT.test(href) || VIDEO_EXT.test(href) ||
          STREAM_EXT.test(href) || XTREAM_RE.test(href)) {
        detectedLinks.add(href);
      }
    });

    // 2. Data attribute links & download buttons
    const dataSelectors = [
      '[data-href]', '[data-url]', '[data-src]', '[data-download-url]',
      'button[data-href]', 'button[data-url]', 'a[download]'
    ];
    document.querySelectorAll(dataSelectors.join(', ')).forEach(el => {
      const raw = el.dataset.href || el.dataset.url || el.dataset.src ||
                  el.dataset.downloadUrl || el.getAttribute('href');
      if (!raw || typeof raw !== 'string') return;
      try {
        const resolved = new URL(raw, location.href).href;
        if (DOWNLOAD_EXT.test(resolved) || AUDIO_EXT.test(resolved) ||
            VIDEO_EXT.test(resolved) || STREAM_EXT.test(resolved) || XTREAM_RE.test(resolved)) {
          detectedLinks.add(resolved);
        }
      } catch (e) {}
    });

    // 3. Scan onclick attributes matching download URLs
    document.querySelectorAll('[onclick*=".mp4"], [onclick*=".m3u8"], [onclick*="download"]').forEach(el => {
      const oc = el.getAttribute('onclick') || '';
      const m = oc.match(/(https?:\/\/[^\s'"`]+)/i) || oc.match(/['"](\/[^\s'"`]+\.(mp4|m3u8|zip|rar|exe|pdf))['"]/i);
      if (m && m[1]) {
        try {
          const resolved = new URL(m[1], location.href).href;
          detectedLinks.add(resolved);
        } catch (e) {}
      }
    });
  }

  /**
   * Scan OpenGraph, Twitter card, and item meta tags for video streams
   */
  function scanOGAndMetaTags() {
    const videos = [];
    const metaSelectors = [
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video:secure_url"]',
      'meta[name="twitter:player:stream"]',
      'meta[name="twitter:player"]',
      'meta[itemprop="contentUrl"]',
    ];
    metaSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        let content = (el.getAttribute('content') || '').trim();
        if (!content) return;
        if (content.startsWith('//')) content = location.protocol + content;
        if (!/^https?:/i.test(content)) return;
        if (looksLikeMedia(content) || STREAM_EXT.test(content) || VIDEO_EXT.test(content)) {
          videos.push(detectQuality(content, el));
        }
      });
    });
    return videos;
  }

  /**
   * Scan schema.org VideoObject JSON-LD scripts for stream URLs
   */
  function scanJsonLd() {
    const videos = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        const data = JSON.parse(script.textContent || '');
        const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
        items.forEach(item => {
          if (!item) return;
          const type = item['@type'];
          if (type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'))) {
            const urls = [item.contentUrl, item.embedUrl].filter(u => typeof u === 'string' && /^https?:/i.test(u));
            urls.forEach(u => {
              const info = detectQuality(u, null);
              if (item.name) info.title = item.name;
              videos.push(info);
            });
          }
        });
      } catch (e) {}
    });
    return videos;
  }

  // ── Full Page Scan ───────────────────────────────────────────────────────────

  function fullScan() {
    const allVideos = [];

    // 1. Video elements
    scanVideoElements().forEach(v => {
      if (!detectedVideos.has(v.url)) {
        detectedVideos.set(v.url, v);
        allVideos.push(v);
      }
    });

    // 2. Quality selectors
    scanQualitySelectors().forEach(v => {
      if (!detectedVideos.has(v.url)) {
        detectedVideos.set(v.url, v);
        allVideos.push(v);
      }
    });

    // 3. Network resources
    scanNetworkResources().forEach(v => {
      if (!detectedVideos.has(v.url)) {
        detectedVideos.set(v.url, v);
        allVideos.push(v);
      }
    });

    // 4. Download links
    scanLinks();

    // 5. KVS player flashvars (Nubiles, BustyAR, PetitesRDS, etc.)
    extractKvsFlashvars().forEach(v => {
      if (!detectedVideos.has(v.url)) {
        detectedVideos.set(v.url, v);
        allVideos.push(v);
      }
    });

    // 6. OpenGraph and Twitter meta tags
    scanOGAndMetaTags().forEach(v => {
      if (!detectedVideos.has(v.url)) {
        detectedVideos.set(v.url, v);
        allVideos.push(v);
      }
    });

    // 7. Schema.org JSON-LD VideoObjects
    scanJsonLd().forEach(v => {
      if (!detectedVideos.has(v.url)) {
        detectedVideos.set(v.url, v);
        allVideos.push(v);
      }
    });

    // 8. Request MAIN-world player extraction (JWPlayer, Video.js, etc.)
    requestPlayerExtraction();

    // Report to background if new videos found
    if (allVideos.length > 0) {
      chrome.runtime.sendMessage({
        action: 'videos-with-quality',
        pageTitle: document.title,
        pageUrl: location.href,
        videos: allVideos,
      });
    }

    pageScanComplete = true;
    return allVideos;
  }

  // ── Message Handling ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'collect-links') {
      scanLinks();
      const allLinks = Array.from(detectedLinks);
      if (allLinks.length > 0) {
        chrome.runtime.sendMessage({
          action: 'batch-download',
          urls: allLinks,
        }, response => sendResponse(response));
      } else {
        sendResponse({ success: false, message: 'No downloadable links found' });
      }
      return true;
    }

    if (msg.action === 'get-videos') {
      if (!pageScanComplete) fullScan();
      sendResponse({ videos: Array.from(detectedVideos.values()) });
      return true;
    }

    if (msg.action === 'get-links') {
      if (!pageScanComplete) fullScan();
      sendResponse({
        links: Array.from(detectedLinks),
        videos: Array.from(detectedVideos.values()),
      });
      return true;
    }

    if (msg.action === 'scan-page') {
      const videos = fullScan();
      sendResponse({
        videos: Array.from(detectedVideos.values()),
        links: Array.from(detectedLinks),
      });
      return true;
    }

    if (msg.action === 'get-diagnostics') {
      if (!pageScanComplete) fullScan();
      const videoEls = Array.from(document.querySelectorAll('video'));
      const best = videoEls.map(v => ({
        src: v.currentSrc || v.src || '',
        hasSourceChildren: v.querySelectorAll('source').length,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        readyState: v.readyState,
        networkState: v.networkState,
      }));
      sendResponse({
        url: location.href,
        detectedVideos: Array.from(detectedVideos.values()),
        detectedLinks: Array.from(detectedLinks),
        videoElementCount: videoEls.length,
        videoElements: best,
        hasFlashvars: !!document.querySelector('script:not([src])') &&
          /flashvars\s*=/.test(document.documentElement.innerHTML),
        pageText: (document.title || '') + ' | ' + location.hostname,
      });
      return true;
    }

    if (msg.action === 'force-grab') {
      // User explicitly asked for this page's video. Scan harder.
      requestPlayerExtraction();
      const videos = fullScan();
      // Also grab from performance API and video elements again.
      scanNetworkResources();
      // Re-emit to background so the desktop popup gets fresh data.
      const all = Array.from(detectedVideos.values());
      if (all.length) {
        chrome.runtime.sendMessage({
          action: 'videos-with-quality',
          pageTitle: document.title,
          pageUrl: location.href,
          videos: all,
        });
      }
      sendResponse({ videos: all });
      return true;
    }
  });

  // ── Floating Download Capsule (IDM-style) with Shadow DOM ───────────────────
  // A small movable "Download with AiDM" pill anchored at the top-right of
  // every downloadable video. Clicking it opens a panel with all detected
  // variants: quality, resolution, size and the real video title.
  // Isolated inside Shadow DOM to prevent host-page CSS interference.

  const CAP_MIN_W = 120, CAP_MIN_H = 68;
  const capsuleState = new WeakMap(); // video -> { wrap, count, panel, btn }
  const capsuleVideos = new Set();    // videos that own a capsule (for orphan cleanup)
  const dragOffsets = new WeakMap();  // video -> { dx, dy }
  let openCapsuleVideo = null;
  let capsuleHost = null;
  let capsuleShadow = null;
  let fixedOriginProbe = null;

  /**
   * A `transform` / `filter` / `contain` / `will-change` on any ancestor turns
   * that element into the containing block for `position: fixed`. Capsule
   * coordinates are viewport-based, so the pill then gets shifted by that
   * ancestor's offset and lands off-screen (or is clipped) — the classic
   * "the floating button never shows up" symptom.
   */
  function findFixedContainingBlock(el) {
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 25) {
      let cs = null;
      try { cs = getComputedStyle(node); } catch (e) { return null; }
      if (!cs) return null;
      if (cs.transform && cs.transform !== 'none') return node;
      if (cs.perspective && cs.perspective !== 'none') return node;
      if (cs.filter && cs.filter !== 'none') return node;
      if (cs.backdropFilter && cs.backdropFilter !== 'none') return node;
      if (cs.transformStyle && cs.transformStyle === 'preserve-3d') return node;
      if (cs.willChange && /transform|perspective|filter|backdrop-filter|contain/.test(cs.willChange)) return node;
      if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Zero-size `position: fixed` marker inside the shadow root. Its rect tells
   * us where the fixed containing block actually starts, so we can correct the
   * capsule coordinates even when we could not escape a transformed ancestor.
   */
  function ensureOriginProbe(shadow) {
    if (fixedOriginProbe && fixedOriginProbe.isConnected) return fixedOriginProbe;
    try {
      fixedOriginProbe = document.createElement('div');
      fixedOriginProbe.setAttribute('data-aidm', 'origin-probe');
      fixedOriginProbe.style.cssText =
        'position: fixed !important; top: 0 !important; left: 0 !important;' +
        'width: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important;' +
        'border: 0 !important; visibility: hidden !important; pointer-events: none !important;';
      shadow.appendChild(fixedOriginProbe);
    } catch (e) { fixedOriginProbe = null; }
    return fixedOriginProbe;
  }

  function getFixedOrigin() {
    if (!fixedOriginProbe || !fixedOriginProbe.isConnected) return { left: 0, top: 0 };
    try {
      const r = fixedOriginProbe.getBoundingClientRect();
      return { left: r.left || 0, top: r.top || 0 };
    } catch (e) {
      return { left: 0, top: 0 };
    }
  }

  const CAPSULE_CSS = `
    :host { all: initial; }
    .aidm-cap-wrap {
      position: fixed;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      transform: translateX(-100%);
      pointer-events: auto;
      user-select: none;
      -webkit-user-select: none;
      box-sizing: border-box;
    }
    .aidm-cap-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 12px;
      font-weight: 600;
      color: #fff;
      background: linear-gradient(180deg, #3a8dde, #1a5cb0);
      border: 1px solid #0f4da8;
      border-radius: 999px;
      padding: 5px 12px 5px 9px;
      cursor: grab;
      box-shadow: 0 2px 10px rgba(15,77,168,.45);
      white-space: nowrap;
      box-sizing: border-box;
      transition: background 0.15s ease, transform 0.1s ease;
    }
    .aidm-cap-btn:active { cursor: grabbing; }
    .aidm-cap-btn:hover {
      background: linear-gradient(180deg, #4a9dea, #2470c4);
      transform: translateY(-1px);
    }
    .aidm-cap-btn .aidm-cap-logo {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      color: #1a5cb0;
      font-size: 10px;
      font-weight: 700;
    }
    .aidm-cap-btn .aidm-cap-n {
      display: none;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 8px;
      background: #ffd23e;
      color: #1a2b4a;
      font-size: 10px;
      font-weight: 700;
    }
    .aidm-cap-panel {
      display: block;
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      width: 320px;
      max-height: 340px;
      overflow-y: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 12px;
      color: #1a2b4a;
      background: #fff;
      border: 1px solid #a9c2e2;
      border-radius: 8px;
      box-shadow: 0 8px 30px rgba(15,77,168,.35);
      box-sizing: border-box;
      z-index: 2147483647;
    }
    .aidm-cap-head {
      padding: 8px 10px;
      background: linear-gradient(180deg, #2f80d6, #1f67b8);
      color: #fff;
      border-radius: 7px 7px 0 0;
      box-sizing: border-box;
    }
    .aidm-cap-title {
      font-weight: 600;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .aidm-cap-sub {
      font-size: 10px;
      color: #cfe2f8;
      margin-top: 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .aidm-cap-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border-bottom: 1px solid #e4edf9;
      box-sizing: border-box;
    }
    .aidm-cap-row:hover { background: #eef4fc; }
    .aidm-cap-q {
      font-size: 10px;
      font-weight: 700;
      color: #0f4da8;
      background: #dbeafe;
      border: 1px solid #93c5fd;
      border-radius: 4px;
      padding: 2px 6px;
      white-space: nowrap;
    }
    .aidm-cap-meta {
      flex: 1;
      min-width: 0;
      font-size: 11px;
      color: #3d5a80;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .aidm-cap-dl {
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      color: #fff;
      background: #1c6fce;
      border: 1px solid #0f4da8;
      border-radius: 5px;
      padding: 4px 10px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .aidm-cap-dl:hover { background: #0f4da8; }
    .aidm-cap-empty {
      padding: 14px 10px;
      text-align: center;
      color: #7a8ba3;
      font-size: 11px;
    }
    .aidm-cap-foot {
      padding: 6px 10px;
      font-size: 10px;
      color: #7a8ba3;
      text-align: right;
      border-top: 1px solid #f1f5f9;
    }
  `;

  function getCapsuleHost() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    let targetParent = fsEl || document.body || document.documentElement;
    if (!targetParent) return null;

    // Escape any ancestor that hijacks `position: fixed` — otherwise every
    // capsule is offset by that ancestor and never appears where it should.
    if (!fsEl) {
      let guard = 0;
      while (guard++ < 5) {
        const cb = findFixedContainingBlock(targetParent);
        if (!cb) break;
        const up = cb.parentElement;
        if (!up || up === cb || up === targetParent) break;
        targetParent = up;
      }
    }

    if (capsuleHost && capsuleHost.isConnected && capsuleShadow) {
      const p = capsuleHost.parentElement;
      if (p !== targetParent) {
        try { targetParent.appendChild(capsuleHost); } catch (e) {}
      } else if (p.lastElementChild !== capsuleHost && !openCapsuleVideo) {
        // Stay above anything the page appends after us.
        try { p.appendChild(capsuleHost); } catch (e) {}
      }
      ensureOriginProbe(capsuleShadow);
      return capsuleShadow;
    }

    if (!capsuleHost) {
      capsuleHost = document.createElement('div');
      capsuleHost.id = 'aidm-capsule-root';
      capsuleHost.style.cssText = 'all: initial !important; display: block !important; position: absolute !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important; border: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important;';
      capsuleShadow = capsuleHost.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CAPSULE_CSS;
      capsuleShadow.appendChild(style);
      ensureOriginProbe(capsuleShadow);
    }
    try {
      targetParent.appendChild(capsuleHost);
    } catch (e) {}
    return capsuleShadow;
  }

  function formatCapBytes(n) {
    if (!n || n <= 0) return 'Unknown size';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
  }

  function qualityFromHeight(h) {
    if (h >= 2160) return '2160p';
    if (h >= 1440) return '1440p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h >= 480) return '480p';
    if (h >= 360) return '360p';
    return h + 'p';
  }

  /** Best-effort real title for the playing video (per-video first). */
  function getVideoTitle(video) {
    const vLabel = (video.getAttribute('title') || video.getAttribute('aria-label') || '').trim();
    // Generic player labels ("Video player", "Play video") are not real titles
    if (vLabel && !/^(video|movie|media)\s*(player)?$/i.test(vLabel) && !/^play\b/i.test(vLabel)) return vLabel;
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content && og.content.trim()) return og.content.trim();
    const t = (document.title || '').replace(/\s*[-|–:|]\s*(YouTube|Facebook|Vimeo|Dailymotion|Twitch).*/i, '').trim();
    if (t) return t;
    return location.hostname;
  }

  function sanitizeFilename(name, fallbackExt) {
    const clean = String(name || 'video').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
    return /\.\w{2,4}$/.test(clean) ? clean : clean + '.' + (fallbackExt || 'mp4');
  }

  /** Collect directly-downloadable variants for ONE video element. */
  function getVideoVariants(video) {
    const out = [];
    const seen = new Set();
    const push = (url, el) => {
      if (!url || seen.has(url)) return;
      if (url.startsWith('blob:')) {
        const mapped = blobToRealUrlMap.get(url);
        if (mapped) push(mapped, el);
        return;
      }
      if (!/^https?:/i.test(url)) return;
      seen.add(url);
      const info = detectQuality(url, el);
      if (!info.resolution && video.videoWidth && video.videoHeight) {
        info.resolution = video.videoWidth + 'x' + video.videoHeight;
        info.quality = qualityFromHeight(video.videoHeight);
      }
      if (!info.size) {
        try {
          const entries = performance.getEntriesByName(url);
          for (const e of entries) {
            if (e.transferSize > 0) { info.size = e.transferSize; break; }
          }
        } catch (e) {}
      }
      out.push(info);
    };
    if (video.src) push(video.src, video);
    if (video.currentSrc) push(video.currentSrc, video);
    video.querySelectorAll('source').forEach(s => push(s.src || s.getAttribute('src'), s));

    // If video is playing or blob-based and out is empty, add any intercepted media URLs
    if (out.length === 0 && (isPlayingVideo(video) || (video.currentSrc && video.currentSrc.startsWith('blob:')))) {
      interceptedMediaUrls.forEach(u => push(u, video));
    }

    return out;
  }

  function videoHasHttpSource(video) {
    if (video.src && /^https?:/i.test(video.src)) return true;
    if (video.currentSrc && /^https?:/i.test(video.currentSrc)) return true;
    if (video.src && blobToRealUrlMap.has(video.src)) return true;
    if (video.currentSrc && blobToRealUrlMap.has(video.currentSrc)) return true;
    const sources = video.querySelectorAll('source');
    for (const s of sources) {
      const src = s.src || s.getAttribute('src') || '';
      if (/^https?:/i.test(src) || blobToRealUrlMap.has(src)) return true;
    }
    return false;
  }

  // ── HLS master expansion ───────────────────────────────────────────────────
  const hlsExpandCache = new Map(); // url -> Promise<{variants, encrypted, isMaster}>

  function parseMasterVariants(text, baseUrl) {
    const lines = String(text || '').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!/^#EXT-X-STREAM-INF/i.test(line)) continue;
      const bw = /BANDWIDTH=(\d+)/i.exec(line);
      const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
      let uri = null;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l && l[0] !== '#') { uri = l; break; }
      }
      if (!uri) continue;
      try {
        out.push({
          url: new URL(uri, baseUrl).href,
          hls: true,
          encrypted: false,
          bandwidth: bw ? parseInt(bw[1], 10) : 0,
          resolution: res ? res[1] + 'x' + res[2] : null,
          quality: res ? qualityFromHeight(parseInt(res[2], 10)) : 'unknown',
          format: 'm3u8',
        });
      } catch (e) {}
    }
    return out;
  }

  function expandHls(url) {
    if (hlsExpandCache.has(url)) return hlsExpandCache.get(url);
    const p = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(url, { signal: ctrl.signal, credentials: 'include' });
        clearTimeout(timer);
        if (!res.ok) return { variants: [], encrypted: false, isMaster: false };
        const text = await res.text();
        if (!text.includes('#EXTM3U')) return { variants: [], encrypted: false, isMaster: false };
        if (/#EXT-X-STREAM-INF/i.test(text)) {
          return {
            variants: parseMasterVariants(text, res.url || url),
            encrypted: /#EXT-X-SESSION-KEY|#EXT-X-KEY/i.test(text),
            isMaster: true,
          };
        }
        return {
          variants: [],
          encrypted: /#EXT-X-KEY/i.test(text),
          isMaster: false,
          segCount: (text.match(/#EXTINF/gi) || []).length,
        };
      } catch (e) {
        return { variants: [], encrypted: false, isMaster: false };
      }
    })();
    hlsExpandCache.set(url, p);
    if (hlsExpandCache.size > 50) hlsExpandCache.delete(hlsExpandCache.keys().next().value);
    return p;
  }

  /** Tab streams (webRequest sniffing) + already-sent URLs, one round-trip. */
  function requestPanelData() {
    return new Promise((resolve) => {
      const done = (v) => resolve(v || { streams: [], sent: [] });
      try {
        const timer = setTimeout(done, 1500);
        chrome.runtime.sendMessage({ action: 'get-panel-data' }, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) return done();
          done(resp);
        });
      } catch (e) {
        done();
      }
    });
  }

  function isPlayingVideo(video) {
    return !video.paused && !video.ended && video.readyState > 2;
  }

  // ── Playback gate ──────────────────────────────────────────────────────────
  // The capsule is strictly playback-gated: it must NEVER appear on page load,
  // on hover, or on a Play click. It appears only once the element fires
  // `playing` (i.e. frames are really being produced) and disappears on
  // `pause` / `ended` / removal / loss of visibility.
  //
  // Per-video state lives in a WeakMap, so a given <video> gets exactly one set
  // of listeners and one IntersectionObserver for its whole lifetime — SPA
  // navigation and late-injected players can never produce duplicate icons or
  // stacked listeners. Entries die with the element (WeakMap) and are torn
  // down explicitly by destroyCapsule() when the node is detached.

  const playbackGate = new WeakMap(); // video -> { playing, visible, io, handlers }

  // Events that mean "playback really started". `play` is deliberately NOT in
  // this list: it fires the instant play() is called, long before any frame is
  // rendered (and even when the play promise later rejects).
  const PLAY_EVTS = ['playing'];
  // Events that mean "playback stopped / no longer usable".
  // NOTE: `waiting`, `stalled` and `suspend` are intentionally excluded — they
  // fire while playback is still in progress (rebuffering, full buffer) and
  // would make the pill flicker.
  const STOP_EVTS = ['pause', 'ended', 'emptied', 'abort', 'error'];

  function gateFor(video) {
    let g = playbackGate.get(video);
    if (g) return g;

    g = { playing: false, visible: true, io: null, handlers: [] };

    const set = (v) => {
      if (g.playing === v) return;
      g.playing = v;
      scheduleSyncCapsules();
    };

    const onPlay = () => set(true);
    const onStop = () => set(false);

    PLAY_EVTS.forEach(evt => {
      video.addEventListener(evt, onPlay);
      g.handlers.push([evt, onPlay]);
    });
    STOP_EVTS.forEach(evt => {
      video.addEventListener(evt, onStop);
      g.handlers.push([evt, onStop]);
    });

    // Seed the state: videos injected already-playing (SPA routes, carousels)
    // never fire `playing` because they started before we saw them.
    try {
      g.playing = !video.paused && !video.ended && video.readyState >= 3;
    } catch (e) {
      g.playing = false;
    }

    // Fast, event-driven visibility so the pill vanishes the moment the player
    // is scrolled away, switched to another tab of the SPA, or hidden.
    try {
      g.io = new IntersectionObserver((entries) => {
        let changed = false;
        for (const en of entries) {
          if (en.target === video && g.visible !== en.isIntersecting) {
            g.visible = en.isIntersecting;
            changed = true;
          }
        }
        if (changed) scheduleSyncCapsules();
      }, { threshold: 0 });
      g.io.observe(video);
    } catch (e) {
      g.io = null;
      g.visible = true;
    }

    playbackGate.set(video, g);
    return g;
  }

  /** Detach every listener/observer we installed for this video. */
  function ungateVideo(video) {
    const g = playbackGate.get(video);
    if (!g) return;
    if (g.io) { try { g.io.disconnect(); } catch (e) {} g.io = null; }
    (g.handlers || []).forEach(([evt, fn]) => {
      try { video.removeEventListener(evt, fn); } catch (e) {}
    });
    g.handlers = [];
    playbackGate.delete(video);
  }

  /**
   * Is this video *actually* playing right now?
   * Event state is authoritative; the live element properties are re-checked
   * as a cheap safety net (covers players that mutate .paused/.src directly).
   */
  function isActuallyPlaying(video) {
    const g = gateFor(video);
    if (!g.playing || !g.visible) return false;
    try {
      if (video.paused || video.ended || video.readyState < 2) return false;
    } catch (e) {
      return false;
    }
    return true;
  }

  function hideCapsule(video) {
    const st = capsuleState.get(video);
    if (!st) return;
    try { st.wrap.style.display = 'none'; } catch (e) {}
    try { st.panel.style.display = 'none'; } catch (e) {}
    if (openCapsuleVideo === video) openCapsuleVideo = null;
  }

  /** Full teardown: overlay + listeners + observers for a removed video. */
  function destroyCapsule(video) {
    const st = capsuleState.get(video);
    if (st) {
      try { st.wrap.remove(); } catch (e) {}
      try { st.panel.remove(); } catch (e) {}
    }
    capsuleState.delete(video);
    capsuleVideos.delete(video);
    dragOffsets.delete(video);
    ungateVideo(video);
    if (openCapsuleVideo === video) openCapsuleVideo = null;
  }

  function ensureCapsule(video) {
    const shadow = getCapsuleHost();
    if (!shadow) return null;
    const wrap = document.createElement('div');
    wrap.className = 'aidm-cap-wrap';

    const btn = document.createElement('div');
    btn.className = 'aidm-cap-btn';
    btn.title = 'Download this video with AiDM (drag to move)';
    const logo = document.createElement('span');
    logo.className = 'aidm-cap-logo';
    logo.textContent = '⚡';
    const label = document.createElement('span');
    label.textContent = 'Download with AiDM';
    const count = document.createElement('span');
    count.className = 'aidm-cap-n';
    btn.appendChild(logo);
    btn.appendChild(label);
    btn.appendChild(count);

    const panel = document.createElement('div');
    panel.className = 'aidm-cap-panel';
    panel.style.display = 'none';

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    shadow.appendChild(wrap);

    const st = { wrap, btn, count, panel };

    // Never leave a previous (stale/disconnected) wrapper behind — that is how
    // duplicate pills used to pile up on SPA navigation.
    const prev = capsuleState.get(video);
    if (prev && prev.wrap && prev.wrap !== wrap) {
      try { prev.wrap.remove(); } catch (e) {}
    }

    capsuleState.set(video, st);
    capsuleVideos.add(video);

    // Keep the overlay completely transparent to the page: a click on the pill
    // must not reach the player (pause/play toggle, ad links, custom controls)
    // nor any page-level document handler. These run in the bubble phase inside
    // the shadow tree, so stopPropagation() here also stops the composed event
    // from ever escaping to the host element / document.
    ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
     'pointerup', 'touchstart', 'touchend', 'wheel'].forEach((evt) => {
      wrap.addEventListener(evt, (e) => { e.stopPropagation(); }, false);
    });
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

    // Drag to move (click without drag toggles the panel)
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const off = dragOffsets.get(video) || { dx: 0, dy: 0 };
      let moved = false;
      const onMove = (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 5) moved = true;
        if (moved) {
          dragOffsets.set(video, { dx: off.dx + ev.clientX - startX, dy: off.dy + ev.clientY - startY });
          positionCapsule(video);
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        if (!moved) toggleCapsulePanel(video);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });

    return st;
  }

  function positionCapsule(video) {
    const st = capsuleState.get(video);
    if (!st || !st.wrap) return;
    let r;
    try { r = video.getBoundingClientRect(); } catch (e) { return; }
    const off = dragOffsets.get(video) || { dx: 0, dy: 0 };

    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;

    const minX = 150; // room for the pill, which is shifted by translateX(-100%)
    const maxX = Math.max(minX, vw - 8);
    const minY = 8;
    const maxY = Math.max(minY, vh - 40);

    // Anchor: top-right corner of the video, clamped to the viewport.
    const posX = Math.max(minX, Math.min(maxX, r.right - 8 + off.dx));
    const posY = Math.max(minY, Math.min(maxY, r.top + 8 + off.dy));

    // If a transformed ancestor took over the fixed containing block, subtract
    // its origin so the pill still ends up at those exact viewport coordinates.
    const o = getFixedOrigin();
    st.wrap.style.left = (posX - o.left) + 'px';
    st.wrap.style.top = (posY - o.top) + 'px';

    if (posY > window.innerHeight - 360) {
      st.panel.style.top = 'auto';
      st.panel.style.bottom = 'calc(100% + 6px)';
    } else {
      st.panel.style.bottom = 'auto';
      st.panel.style.top = 'calc(100% + 6px)';
    }
  }

  function toggleCapsulePanel(video) {
    const st = capsuleState.get(video);
    if (!st) return;
    if (openCapsuleVideo === video && st.panel.style.display !== 'none') {
      st.panel.style.display = 'none';
      openCapsuleVideo = null;
      return;
    }
    // Close any other open panel
    if (openCapsuleVideo && capsuleState.get(openCapsuleVideo)) {
      capsuleState.get(openCapsuleVideo).panel.style.display = 'none';
    }
    buildCapsulePanel(video);
    st.panel.style.display = 'block';
    openCapsuleVideo = video;
  }

  async function buildCapsulePanel(video) {
    const st = capsuleState.get(video);
    if (!st) return;
    const title = getVideoTitle(video);

    // Header immediately so the panel opens without delay
    st.panel.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'aidm-cap-head';
    const t = document.createElement('div');
    t.className = 'aidm-cap-title';
    t.textContent = '🎬 ' + title;
    t.title = title;
    const sub = document.createElement('div');
    sub.className = 'aidm-cap-sub';
    sub.textContent = location.hostname + ' · scanning…';
    head.appendChild(t);
    head.appendChild(sub);
    st.panel.appendChild(head);

    const loading = document.createElement('div');
    loading.className = 'aidm-cap-empty';
    loading.textContent = '🔍 Scanning stream…';
    st.panel.appendChild(loading);

    // Gather candidates: this video's own sources first
    const direct = getVideoVariants(video);
    let pd = { streams: [], sent: [] };
    try { pd = await requestPanelData(); } catch (e) {}
    if (openCapsuleVideo !== video || !capsuleState.get(video)) return; // closed meanwhile

    const seen = new Set();
    const cands = [];
    const pushCand = (v) => {
      if (!v || !v.url || !/^https?:/i.test(v.url)) return;
      const n = normalizeStreamUrl(v.url) || v.url;
      if (seen.has(n)) return;
      seen.add(n);
      cands.push(v);
    };
    direct.forEach(pushCand);
    // Add intercepted media URLs from MAIN world
    interceptedMediaUrls.forEach(u => pushCand(detectQuality(u, video)));
    // Always merge page-level + webRequest-sniffed streams as extra candidates
    detectedVideos.forEach(pushCand);
    (pd.streams || []).forEach(u => {
      if (/\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ts|m4s|key)(\?|#|$)/i.test(u) ||
          XTREAM_RE.test(u) || /videoplayback|get_file|akamaihd/i.test(u)) {
        pushCand(detectQuality(u, null));
      }
    });

    // Expand HLS masters into per-quality rows
    const expanded = [];
    for (const v of cands) {
      if (/\.m3u8($|\?|#)/i.test(v.url)) {
        try {
          const ex = await expandHls(v.url);
          if (openCapsuleVideo !== video) return;
          if (ex.encrypted) { expanded.push({ ...v, hls: true, encrypted: true }); continue; }
          if (ex.variants && ex.variants.length) {
            ex.variants.forEach(x => expanded.push(x));
            continue;
          }
        } catch (e) {}
      }
      expanded.push(v.hls ? v : { ...v, hls: /\.m3u8($|\?|#)/i.test(v.url) });
    }

    // Hide anything already sent to AiDM, then dedupe + sort
    const sentSet = new Set(pd.sent || []);
    const sentNorm = new Set((pd.sent || []).map(u => normalizeStreamUrl(u)).filter(Boolean));
    const seen2 = new Set();
    const tierOf = (q) => (QUALITY_MAP[q] ? QUALITY_MAP[q].tier : -99);
    const rows = expanded.filter(v => {
      if (sentSet.has(v.url)) return false;
      const n = normalizeStreamUrl(v.url);
      if ((n && sentNorm.has(n)) || seen2.has(n || v.url)) return false;
      seen2.add(n || v.url);
      return true;
    }).sort((a, b) => tierOf(b.quality) - tierOf(a.quality));

    if (!capsuleState.get(video)) return;
    loading.remove();
    sub.textContent = location.hostname + ' · ' + rows.length + ' downloadable link' + (rows.length === 1 ? '' : 's');

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'aidm-cap-empty';
      empty.textContent = 'Scanning video… play it for a few seconds, then reopen this panel.';
      st.panel.appendChild(empty);
    }

    rows.forEach(v => {
      const row = document.createElement('div');
      row.className = 'aidm-cap-row';

      const q = document.createElement('span');
      q.className = 'aidm-cap-q';
      q.textContent = v.quality && v.quality !== 'unknown' ? v.quality.toUpperCase() : 'VIDEO';

      const meta = document.createElement('span');
      meta.className = 'aidm-cap-meta';
      meta.textContent = (v.resolution || '—') + ' · ' + formatCapBytes(v.size) + ' · ' + (v.format || 'mp4').toUpperCase();
      meta.title = v.url;

      if (v.encrypted) {
        const lock = document.createElement('span');
        lock.className = 'aidm-cap-meta';
        lock.textContent = '🔒 Protected';
        lock.title = 'Encrypted stream — downloading is not supported';
        row.appendChild(q);
        row.appendChild(meta);
        row.appendChild(lock);
        st.panel.appendChild(row);
        return;
      }

      const dl = document.createElement('button');
      dl.className = 'aidm-cap-dl';
      dl.textContent = '⬇ Download';
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        const fname = sanitizeFilename(
          title + (v.quality && v.quality !== 'unknown' ? ' [' + v.quality + ']' : ''),
          (v.format || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4'
        );
        try {
          chrome.runtime.sendMessage({
            action: 'single-download',
            url: v.url,
            filename: fname,
            opts: {
              quality: { label: (v.quality || 'unknown').toUpperCase(), resolution: v.resolution, size: v.size, format: v.format },
              meta: { pageTitle: document.title, pageUrl: location.href },
            },
          }, (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.success) {
              dl.textContent = 'Failed';
              setTimeout(() => { dl.textContent = '⬇ Download'; }, 2000);
              return;
            }
            dl.textContent = resp.duplicate ? '✓ In AiDM' : '✓ Sent';
            if (resp.duplicate) {
              setTimeout(() => {
                if (row.isConnected) row.remove();
              }, 1200);
            } else {
              setTimeout(() => { dl.textContent = '⬇ Download'; }, 2000);
            }
          });
        } catch (err) {
          dl.textContent = 'Failed';
        }
      });

      row.appendChild(q);
      row.appendChild(meta);
      row.appendChild(dl);
      st.panel.appendChild(row);
    });

    const foot = document.createElement('div');
    foot.className = 'aidm-cap-foot';
    foot.textContent = 'AiDM · drag the pill to move it';
    st.panel.appendChild(foot);
  }

  let syncCapsulesRaf = null;
  function scheduleSyncCapsules() {
    if (syncCapsulesRaf) return;
    syncCapsulesRaf = requestAnimationFrame(() => {
      syncCapsulesRaf = null;
      syncCapsules();
    });
  }

  /** Show/move/hide capsules for all video elements on the page. */
  function syncCapsules() {
    // Ensure host is attached to active container (e.g. fullscreen element)
    getCapsuleHost();

    // Remove capsules whose video was detached (SPA navigation, e.g. YouTube).
    // destroyCapsule() also unbinds that video's playback listeners and its
    // IntersectionObserver, so nothing leaks across route changes.
    Array.from(capsuleVideos).forEach(video => {
      if (!video.isConnected) destroyCapsule(video);
    });

    document.querySelectorAll('video').forEach(video => {
     // One misbehaving player must never stop the remaining videos from
     // getting their capsule (a single throw used to kill the whole loop).
     try {
      let r;
      try { r = video.getBoundingClientRect(); } catch (e) { return; }
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const inView = r.width >= CAP_MIN_W && r.height >= CAP_MIN_H &&
        r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;

      const isBlob = (video.src && video.src.startsWith('blob:')) ||
                     (video.currentSrc && video.currentSrc.startsWith('blob:')) ||
                     mseBlobUrls.has(video.currentSrc);

      // ── PLAYBACK GATE ────────────────────────────────────────────────────
      // Hard requirement: no pill until the video is genuinely producing
      // frames. Not on page load, not on hover, not on a Play click — only on
      // the `playing` event (or an already-playing element we discovered late).
      const playing = isActuallyPlaying(video);
      const hasSource = videoHasHttpSource(video) || isBlob || !!video.currentSrc;

      let st = capsuleState.get(video);

      if (!playing || !inView || !hasSource) {
        if (st) hideCapsule(video);
        return;
      }
      if (!st || !st.wrap.isConnected) st = ensureCapsule(video);
      if (!st) return;

      const n = getVideoVariants(video).length + interceptedMediaUrls.size + detectedVideos.size;
      if (n > 0) {
        st.count.style.display = 'inline-flex';
        st.count.textContent = n > 99 ? '99+' : String(n);
      } else {
        st.count.style.display = 'none';
      }
      st.wrap.style.display = 'block';
      positionCapsule(video);
     } catch (e) { /* ignore a single broken player */ }
    });
  }

  // Close open panel on outside click / Escape
  document.addEventListener('pointerdown', (e) => {
    if (openCapsuleVideo && capsuleState.get(openCapsuleVideo)) {
      const st = capsuleState.get(openCapsuleVideo);
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(st.wrap) && !path.includes(st.panel) && !path.includes(st.btn)) {
        st.panel.style.display = 'none';
        openCapsuleVideo = null;
      }
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openCapsuleVideo && capsuleState.get(openCapsuleVideo)) {
      capsuleState.get(openCapsuleVideo).panel.style.display = 'none';
      openCapsuleVideo = null;
    }
  }, true);

  // Fullscreen support
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange'].forEach(evt => {
    document.addEventListener(evt, () => {
      getCapsuleHost();
      scheduleSyncCapsules();
    });
  });

  // React immediately when a player starts producing frames, instead of
  // waiting for the next polling tick (media events do not bubble, so capture).
  let lastTimeupdateSync = 0;
  ['play', 'playing', 'loadedmetadata', 'loadeddata', 'canplay', 'seeked', 'progress', 'timeupdate']
    .forEach(evt => {
      document.addEventListener(evt, (e) => {
        if (!e.target || e.target.tagName !== 'VIDEO') return;
        if (evt === 'timeupdate') {
          const now = Date.now();
          if (now - lastTimeupdateSync < 500) return;
          lastTimeupdateSync = now;
        }
        scheduleSyncCapsules();
      }, true);
    });

  // Auto-scan the playing video: refresh network resources, merge sniffed
  // tab streams, report fresh ones to the desktop, refresh capsules
  document.addEventListener('playing', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      scanNetworkResources();
      requestPlayerExtraction();
      // Re-scan KVS flashvars (player may have loaded after initial scan)
      extractKvsFlashvars().forEach(v => {
        if (!detectedVideos.has(v.url)) {
          detectedVideos.set(v.url, v);
          try {
            chrome.runtime.sendMessage({
              action: 'videos-with-quality',
              pageTitle: document.title,
              pageUrl: location.href,
              videos: [v],
            });
          } catch (err) {}
        }
      });
      try {
        requestPanelData().then(pd => {
          const fresh = [];
          (pd.streams || []).forEach(u => {
            if (!/^https?:/i.test(u) || detectedVideos.has(u)) return;
            if (!/\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ts|m4s)(\?|#|$)/i.test(u) &&
                !XTREAM_RE.test(u) && !/videoplayback/i.test(u)) return;
            const info = detectQuality(u, null);
            detectedVideos.set(u, info);
            fresh.push(info);
          });
          if (fresh.length) {
            try {
              chrome.runtime.sendMessage({
                action: 'videos-with-quality',
                pageTitle: document.title,
                pageUrl: location.href,
                videos: fresh,
              });
            } catch (err) {}
          }
          scheduleSyncCapsules();
        });
      } catch (err) {}
      scheduleSyncCapsules();
      setTimeout(scheduleSyncCapsules, 1500);
    }
  }, true);

  // ── Intercept Click-to-Download ──────────────────────────────────────────────

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[download], a[href$=".mp4"], a[href$=".zip"], a[href$=".exe"]');
    if (link && link.href) {
      chrome.runtime.sendMessage({
        action: 'single-download',
        url: link.href,
        filename: link.download || undefined,
      });
    }
  }, true);

  // ── MutationObserver for Dynamic Content ─────────────────────────────────────

  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldScan = true;
        break;
      }
    }
    if (shouldScan) {
      setTimeout(fullScan, 500);
    }
  });

  // Guarded: on body-less documents (XML, bare media, early frames)
  // document.body is null and observe() would throw, killing this whole
  // content script (no capsule, no detection, empty popup).
  function startDomObserver() {
    try {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
      }
    } catch (e) {}
  }
  startDomObserver();

  // ── Video-element observer (member sites inject players late) ────────────────
  const videoObserver = new MutationObserver(() => {
    const hasReal = Array.from(document.querySelectorAll('video'))
      .some(v => (v.currentSrc || v.src || '').startsWith('http') || (v.currentSrc && v.currentSrc.startsWith('blob:')));
    if (hasReal) {
      fullScan();
      scanNetworkResources();
      scheduleSyncCapsules();
    }
  });
  try {
    videoObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // ── "Scan until a real source appears" loop (member sites) ───────────────────
  let probeCount = 0;
  const probe = () => {
    probeCount++;
    const found = scanVideoElements().some(v => /^https?:/i.test(v.url)) || interceptedMediaUrls.size > 0;
    if (!found && probeCount < 25) {
      setTimeout(probe, 1000);
    } else {
      fullScan();
      scanNetworkResources();
      scheduleSyncCapsules();
    }
  };

  // ── Initial Scan ─────────────────────────────────────────────────────────────

  setTimeout(() => { fullScan(); scheduleSyncCapsules(); }, 1500);
  setTimeout(probe, 2500);
  setInterval(() => {
    scanNetworkResources();
    scheduleSyncCapsules();
  }, 8000);
  setInterval(scheduleSyncCapsules, 1000);
  window.addEventListener('scroll', scheduleSyncCapsules, { passive: true, capture: true });
  window.addEventListener('resize', scheduleSyncCapsules);

})();
