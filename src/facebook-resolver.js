/**
 * Facebook / Instagram page resolver (no API key required).
 *
 * Background
 * ----------
 * Pasting a facebook.com/watch (or reel / fb.watch / instagram reel) URL into
 * AiDM used to download the page HTML as a file: no resolver claimed page
 * URLs, so the manager treated them as direct files. Generic network sniffing
 * is also fragile on these sites — the player runs on blob:+MSE with
 * extensionless fbcdn range requests, and the sniffed tracks are often split
 * DASH video-only/audio-only renditions rather than the playable file.
 *
 * This module instead resolves AT CLICK TIME, server-side in the Node main
 * process, exactly like the Twitter and mydaddy/hqporner resolvers:
 *   facebook watch/reel page → fresh progressive MP4 list (hd_src / sd_src,
 *   playable_url(_quality_hd), browser_native_hd/sd_url, progressive_urls)
 * with the page title as the filename and the page URL as Referer.
 *
 * The page fetch replays the browser's session cookies when the extension
 * supplies them (login-walled / private videos); anonymous fetches still work
 * for public videos and crawler-visible og tags.
 *
 * Security (same rules as resolvers.js / embed-resolver.js):
 *   • Only identifiers are parsed out of user input; page fetches go to URLs
 *     we construct on an allowlist of hosts (facebook.com, fb.watch,
 *     instagram.com families).
 *   • Redirects are followed only within the same host family (fb.watch may
 *     bounce to facebook.com) — never to a third party (no open proxy).
 *   • Bodies are capped (5 MB) — video pages are HTML/JSON, never huge.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MAX_HTML_BYTES = 5 * 1024 * 1024;

// Hosts this resolver is allowed to fetch page HTML from. Everything else is
// refused (including redirect targets) — the resolver must never become a
// generic URL fetcher.
const PAGE_HOSTS = new Set([
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com',
  'fb.watch',
  'instagram.com', 'www.instagram.com',
]);

const QUALITY_RESOLUTION = {
  2160: '3840x2160',
  1440: '2560x1440',
  1080: '1920x1080',
  720: '1280x720',
  480: '854x480',
  360: '640x360',
  240: '426x240',
};

// ── Strict URL parsing (identifier-only) ───────────────────────────────────

/**
 * @returns {{ provider: 'facebook'|'instagram', id: string, pageUrl: string }|null}
 * Never throws; returns null when the input is not a supported page URL.
 * Media/CDN URLs (fbcdn, twimg…) are never claimed — only watch pages.
 */
function parseFacebookUrl(input) {
  let u;
  try {
    u = new URL(String(input == null ? '' : input).trim());
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');

  if (host === 'fb.watch') {
    // Short links: https://fb.watch/<token>/
    const m = /^\/([A-Za-z0-9_-]{3,64})\/?$/i.exec(u.pathname);
    if (!m) return null;
    return { provider: 'facebook', id: 'watch-' + m[1], pageUrl: `https://fb.watch/${m[1]}/` };
  }

  if (host === 'facebook.com' || host === 'www.facebook.com' ||
      host === 'm.facebook.com' || host === 'web.facebook.com') {
    // /watch/?v=<id> (canonical watch URL)
    if (/^\/watch\/?$/i.test(u.pathname)) {
      const v = u.searchParams.get('v');
      if (v && /^\d{5,25}$/.test(v)) {
        return { provider: 'facebook', id: v, pageUrl: `https://www.facebook.com/watch/?v=${v}` };
      }
      return null;
    }
    // /video.php?v=<id>, /story.php?story_fbid=<id>
    if (/^\/(video|story)\.php$/i.test(u.pathname)) {
      const v = u.searchParams.get('v') || u.searchParams.get('video_id') || u.searchParams.get('story_fbid');
      if (v && /^\d{5,25}$/.test(v)) {
        return { provider: 'facebook', id: v, pageUrl: `https://www.facebook.com/watch/?v=${v}` };
      }
      return null;
    }
    // /<page>/videos/<id>/, /reel/<id>/, /share/v/<id>/
    let m = /^\/[^/]+\/videos\/(?:[^/]+\/)?(\d{5,25})\/?$/i.exec(u.pathname) ||
            /^\/reel\/([A-Za-z0-9_-]{3,64})\/?$/i.exec(u.pathname) ||
            /^\/share\/v\/([A-Za-z0-9_-]{3,64})\/?$/i.exec(u.pathname);
    if (m) return { provider: 'facebook', id: m[1], pageUrl: `https://www.facebook.com${u.pathname.replace(/\/?$/, '/')}` };
    return null;
  }

  if (host === 'instagram.com' || host === 'www.instagram.com') {
    // /reel/<id>/, /p/<id>/, /tv/<id>/
    const m = /^\/(reel|p|tv)\/([A-Za-z0-9_-]{3,64})\/?/i.exec(u.pathname);
    if (!m) return null;
    return { provider: 'instagram', id: m[2], pageUrl: `https://www.instagram.com/${m[1]}/${m[2]}/` };
  }

  return null;
}

function isFacebookUrl(input) {
  return parseFacebookUrl(input) !== null;
}

// ── Page fetching (allowlisted hosts only) ─────────────────────────────────

function baseHost(h) {
  return String(h || '').toLowerCase().replace(/^(www\.|m\.|web\.)/, '');
}

function sameFamily(a, b) {
  return baseHost(a) === baseHost(b);
}

function fetchPageHtml(url, { timeoutMs = 20000, redirectCount = 0, cookies = null, userAgent = null } = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) { reject(new Error('Too many redirects while resolving video page')); return; }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) { reject(new Error('Invalid URL')); return; }
    if (!PAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
      reject(new Error('Resolver refuses to fetch off-allowlist host: ' + parsed.hostname));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': userAgent || CHROME_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (cookies) headers.Cookie = String(cookies).slice(0, 32768);
    const req = client.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let target;
        try { target = new URL(res.headers.location, url); } catch (e) { reject(e); return; }
        if (!PAGE_HOSTS.has(target.hostname.toLowerCase())) {
          reject(new Error('Video page redirected to an unexpected host'));
          return;
        }
        // fb.watch short links legitimately bounce to facebook.com; anything
        // else must stay within its own host family.
        const fromFbWatch = parsed.hostname.toLowerCase() === 'fb.watch';
        const toFacebook = baseHost(target.hostname) === 'facebook.com';
        if (!sameFamily(target.hostname, parsed.hostname) && !(fromFbWatch && toFacebook)) {
          reject(new Error('Video page redirected to an unexpected host'));
          return;
        }
        resolve(fetchPageHtml(target.toString(), { timeoutMs, redirectCount: redirectCount + 1, cookies, userAgent }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Video page returned HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      let capped = false;
      res.on('data', (c) => {
        if (capped) return;
        bytes += c.length;
        if (bytes > MAX_HTML_BYTES) { capped = true; req.destroy(); reject(new Error('Video page too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (capped) return;
        resolve({ html: Buffer.concat(chunks).toString('utf8'), finalUrl: url });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Video page request timed out')); });
    req.end();
  });
}

// ── Pure HTML parsers (unit-testable, no network) ──────────────────────────

/** True when the page is a login wall rather than the video. */
function isLoginWall(html) {
  const s = String(html || '');
  return />You must log in to continue</i.test(s) ||
    /id="login_form"/i.test(s) ||
    /"login_data"/i.test(s) && /captcha/i.test(s) && !/playable_url|hd_src|sd_src/i.test(s);
}

/** Strip tags/entities down to comparable text. */
function textOf(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Real video title from the page: og:title, then <title>, then <h1>.
 * Returns null when nothing usable is found (never a hostname).
 */
function extractFacebookTitle(html, hostname) {
  const isUsable = (t) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (s.length < 2) return false;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) return false;
    if (/^(video|watch|play|player|home|index|untitled|download|media|clip|embed|log in|login|facebook|instagram)$/i.test(s)) return false;
    return true;
  };
  const clean = (t) => {
    let s = String(t || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*[-|–—:|]\s*(Facebook|Instagram)\s*$/i, '').trim();
    return isUsable(s) ? s.slice(0, 100) : null;
  };

  let m = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{2,300})["']/i.exec(html || '');
  if (m && clean(m[1])) return clean(m[1]);
  m = /<title[^>]*>([^<]{2,300})<\/title\s*>/i.exec(html || '');
  if (m) {
    const c = clean(m[1]);
    if (c && !(hostname && c.toLowerCase() === String(hostname).toLowerCase())) return c;
  }
  m = /<h1[^>]*>([\s\S]{2,300}?)<\/h1\s*>/i.exec(html || '');
  if (m) {
    const c = clean(textOf(m[1]));
    if (c) return c;
  }
  return null;
}

/** Poster image, if the page advertises one (og:image preferred). */
function extractFacebookThumbnail(html, pageUrl) {
  const src = String(html || '');
  let m = /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(src);
  if (m) {
    try {
      const href = new URL(String(m[1]).replace(/&amp;/g, '&'), pageUrl || undefined).href;
      if (/^https?:/i.test(href)) return href;
    } catch (e) { /* fall through */ }
  }
  return null;
}

/** Duration in seconds from og:video:duration / JSON hints, else null. */
function extractFacebookDuration(html) {
  const src = String(html || '');
  let m = /<meta[^>]+property=["']og:(?:video:)?duration["'][^>]*content=["'](\d+(?:\.\d+)?)["']/i.exec(src);
  if (m) return Math.round(parseFloat(m[1]) * 10) / 10;
  m = /"playable_duration_in_ms"\s*:\s*(\d+)/i.exec(src) ||
      /"playable_duration"\s*:\s*(\d+(?:\.\d+)?)/i.exec(src);
  if (m) {
    const v = parseFloat(m[1]);
    return Math.round((m[0].includes('_ms') ? v / 1000 : v) * 10) / 10;
  }
  return null;
}

// `efg` carries the encode descriptor; an `audio` encode_tag means the URL is
// the audio-only half of a split DASH rendition — never a playable download.
function efgIsAudio(efg) {
  try {
    const s = String(efg || '');
    if (!s) return false;
    let obj = null;
    if (s.charAt(0) === '{') { try { obj = JSON.parse(s); } catch (e) {} }
    if (!obj) {
      let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      try { obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch (e) { obj = null; }
    }
    if (!obj || typeof obj !== 'object') return false;
    return /audio/i.test(String(obj.encode_tag || obj.vencode_tag || ''));
  } catch (e) { return false; }
}

function qualityFromHeight(h) {
  const n = parseInt(h, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (QUALITY_RESOLUTION[n]) return { quality: `${n}p`, width: parseInt(QUALITY_RESOLUTION[n].split('x')[0], 10), height: n };
  return { quality: `${n}p`, width: 0, height: n };
}

/**
 * Fresh progressive MP4s from a Facebook/Instagram video page. Covers the
 * keys the web player itself embeds (`playable_url`, `playable_url_quality_hd`,
 * `browser_native_hd/sd_url`, `hd_src`/`sd_src`, and the newer
 * `videoDeliveryResponseFragment…progressive_urls[]`), plus a generic fbcdn
 * …mp4 fallback. HLS masters are kept as a last resort (the engine assembles
 * them); DASH manifests (.mpd) are counted but never offered. Audio-only
 * efg renditions are skipped — they are half of a split track, not a video.
 * Returns best-first (MP4 before HLS), de-duplicated. Pure function.
 */
function extractFacebookVariants(html, pageUrl) {
  const src = String(html || '');
  const found = new Map(); // url -> { url, format, quality, width, height }
  let mpdCount = 0;

  const unescape = (s) => String(s || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&');

  const take = (raw, qualityHint) => {
    if (!raw || typeof raw !== 'string') return;
    let u = unescape(raw).trim().replace(/&amp;/g, '&').replace(/["'\),;\\]+$/, '');
    if (!u) return;
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https?:\/\//i.test(u)) return;
    const isHls = /\.m3u8(\?|#|$)/i.test(u);
    const isMp4 = /\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(u);
    if (/\.mpd(\?|#|$)/i.test(u)) { mpdCount++; return; }
    if (!isMp4 && !isHls) return;
    if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|css|js|vtt|srt|woff2?)(\?|#|$)/i.test(u)) return;
    // Audio-only half of a split DASH rendition — never a video row.
    try {
      const efg = new URL(u, pageUrl || undefined).searchParams.get('efg');
      if (efg && efgIsAudio(efg)) return;
    } catch (e) { /* keep — unparseable efg is not proof of audio */ }
    try {
      const normalized = new URL(u, pageUrl || undefined).href;
      if (!found.has(normalized)) {
        found.set(normalized, { url: normalized, format: isHls ? 'hls' : 'mp4', qualityHint: qualityHint || null });
      } else if (qualityHint && !found.get(normalized).qualityHint) {
        found.get(normalized).qualityHint = qualityHint;
      }
    } catch (e) { /* malformed URL — skip */ }
  };

  const pats = [
    [/"playable_url_quality_hd"\s*:\s*"([^"]+)"/gi, null],
    [/"playable_url"\s*:\s*"([^"]+)"/gi, null],
    [/\bplayable_url_quality_hd["']?\s*[:=]\s*["']([^"']+)/gi, null],
    [/\bplayable_url["']?\s*[:=]\s*["']([^"']+)/gi, null],
    [/"browser_native_hd_url"\s*:\s*"([^"]+)"/gi, '1080p'],
    [/"browser_native_sd_url"\s*:\s*"([^"]+)"/gi, '480p'],
    [/\bbrowser_native_hd_url["']?\s*[:=]\s*["']([^"']+)/gi, '1080p'],
    [/\bbrowser_native_sd_url["']?\s*[:=]\s*["']([^"']+)/gi, '480p'],
    [/"hd_src"\s*:\s*"([^"]+)"/gi, '720p'],
    [/"sd_src"\s*:\s*"([^"]+)"/gi, '480p'],
    [/\bhd_src["']?\s*[:=]\s*["']([^"']+)/gi, '720p'],
    [/\bsd_src["']?\s*[:=]\s*["']([^"']+)/gi, '480p'],
    // Newer delivery fragment: {"progressive_url":"…","metadata":{"quality":"hd",…}}
    [/"progressive_url"\s*:\s*"([^"]+)"/gi, null],
    [/"hls_playlist_url"\s*:\s*"([^"]+)"/gi, null],
    // DASH manifests: counted (so the resolver can say "DASH-only") but never
    // offered — take() routes .mpd into mpdCount.
    [/"dash_manifest(?:_url)?"\s*:\s*"([^"]+)"/gi, null],
    [/\bdash_manifest(?:_url)?["']?\s*[:=]\s*["']([^"']+)/gi, null],
  ];
  for (const [re, q] of pats) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) take(m[1], q);
  }
  // Generic fallback: any fbcdn/scontent …mp4 in the page payload.
  const fbMp4 = /https?:\\?\/\\?\/[^"'\\\s<>]*?(?:fbcdn|scontent)[^"'\\\s<>]*?\.mp4[^"'\\\s<>]*/gi;
  let g;
  while ((g = fbMp4.exec(src)) !== null) take(g[0], null);
  // …and any …mpd (counted, never offered).
  const fbMpd = /https?:\\?\/\\?\/[^"'\\\s<>]*?(?:fbcdn|scontent)[^"'\\\s<>]*?\.mpd[^"'\\\s<>]*/gi;
  let d;
  while ((d = fbMpd.exec(src)) !== null) take(d[0], null);

  const out = [];
  for (const { url, format, qualityHint } of found.values()) {
    let quality = null, width = 0, height = 0;
    const qm = qualityHint && /^(\d{3,4})p$/i.exec(qualityHint);
    if (qm) {
      const q = qualityFromHeight(qm[1]);
      if (q) { quality = q.quality; width = q.width; height = q.height; }
    }
    if (!height) {
      // Rendition encoded next to the URL ("hd"/"sd" label or WxH in path).
      const idx = src.indexOf(url.replace(/^https?:/, '').slice(0, 80));
      const win = idx >= 0 ? src.slice(Math.max(0, idx - 200), idx + 200) : '';
      const wh = /(\d{3,4})x(\d{3,4})/.exec(url) || /(\d{3,4})x(\d{3,4})/.exec(win);
      if (wh) {
        width = parseInt(wh[1], 10); height = parseInt(wh[2], 10);
        quality = `${height}p`;
      } else if (/\bhd\b/i.test(win) || qualityHint === 'hd') {
        quality = '720p'; width = 1280; height = 720;
      } else if (/\bsd\b/i.test(win) || qualityHint === 'sd') {
        quality = '480p'; width = 854; height = 480;
      }
    }
    out.push({
      url,
      contentType: format === 'hls' ? 'application/x-mpegURL' : 'video/mp4',
      isMp4: format === 'mp4',
      bitrate: 0,
      width,
      height,
      quality: quality || 'unknown',
    });
  }

  // playable_url vs playable_url_quality_hd order in the page is SD-then-HD;
  // sort best-first so the picker and "best" selection agree.
  out.sort((a, b) => (Number(b.isMp4) - Number(a.isMp4)) ||
                     (b.height - a.height) || (b.bitrate - a.bitrate));
  out._mpdCount = mpdCount;
  return out;
}

function safeTitle(s, fallback) {
  const cleaned = String(s || 'video')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * Resolve a facebook.com/watch|reel|share, fb.watch, or instagram reel/p/tv
 * URL into fresh, directly-downloadable MP4 variants.
 *
 * `deps.fetchHtml` optionally overrides page fetching (tests); `deps.cookies`
 * replays the browser session for login-walled videos; `deps.userAgent`
 * overrides the request UA.
 */
async function resolveFacebookVideos(input, deps = {}) {
  const fetchHtml = (deps && deps.fetchHtml) || fetchPageHtml;
  const parsed = parseFacebookUrl(input);
  if (!parsed) throw new Error('Not a Facebook or Instagram video URL');

  let page;
  try {
    const r = await fetchHtml(parsed.pageUrl, { cookies: deps.cookies || null, userAgent: deps.userAgent || null });
    page = typeof r === 'string' ? { html: r, finalUrl: parsed.pageUrl } : r;
  } catch (e) {
    throw new Error(`Could not load the video page (${e.message})`);
  }
  const html = (page && page.html) || '';
  const finalUrl = (page && page.finalUrl) || parsed.pageUrl;

  if (!html || html.length < 500) {
    throw new Error('The video page returned almost no content (it may require login — open it in your browser while logged in and try again from the AiDM extension)');
  }
  if (isLoginWall(html)) {
    throw new Error('This video needs a Facebook/Instagram login. Open it in your browser while logged in, then use the AiDM browser extension (it replays your session) or copy the page URL again.');
  }

  let title = extractFacebookTitle(html, 'facebook.com');
  const thumbnail = extractFacebookThumbnail(html, finalUrl);
  const duration = extractFacebookDuration(html);
  const variants = extractFacebookVariants(html, finalUrl);
  if (!variants.length) {
    if (variants._mpdCount > 0) {
      throw new Error('This page only offers DASH streams (.mpd), which AiDM cannot download yet');
    }
    throw new Error('No downloadable video found on this page (it may have been removed, be private, or require login)');
  }
  if (!title) title = `${parsed.provider === 'instagram' ? 'Instagram' : 'Facebook'} video ${parsed.id}`.slice(0, 80);

  const label = safeTitle(title, 'video');
  const videos = variants.map((v) => {
    const isHls = v.isMp4 === false;
    return {
      url: v.url,
      quality: v.quality || 'unknown',
      resolution: v.width && v.height ? `${v.width}x${v.height}` : null,
      format: isHls ? 'hls' : 'mp4',
      filename: `${label}${v.quality && v.quality !== 'unknown' ? ` [${v.quality}]` : ''}.${isHls ? 'm3u8' : 'mp4'}`,
    };
  });

  return {
    provider: parsed.provider,
    id: parsed.id,
    title: label,
    thumbnail,
    duration,
    canonicalUrl: finalUrl,
    referer: finalUrl,
    videos,
  };
}

/**
 * Convert resolver variants into the shape the UI's quality picker expects.
 * Single source of truth — mirrors embed-resolver.toPickerVideos.
 */
function toPickerVideos(videos) {
  return (videos || []).map((v) => ({
    url: v.url,
    filename: v.filename,
    quality: v.quality || 'auto',
    resolution: v.resolution || null,
    format: v.format || 'mp4',
    size: v.size || null,
  }));
}

module.exports = {
  parseFacebookUrl,
  isFacebookUrl,
  fetchPageHtml,
  isLoginWall,
  extractFacebookTitle,
  extractFacebookThumbnail,
  extractFacebookDuration,
  extractFacebookVariants,
  efgIsAudio,
  resolveFacebookVideos,
  toPickerVideos,
};
