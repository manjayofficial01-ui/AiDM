/**
 * mydaddy.cc / hqporner.com embed resolver (no authentication required).
 *
 * Background
 * ----------
 * Generic "capture the network" detection is fragile on these sites:
 *   • hqporner.com `/hdporn/` pages contain NO direct media at all — the
 *     player is `<iframe src="//mydaddy.cc/video/<id>/">` plus
 *     `/blocks/altplayer.php` / `/blocks/nativeplayer.php` handoffs.
 *   • The real files (`https://sXX.bigcdn.cc/pubs/<hash>.<id>/1080.mp4`, …)
 *     live one hop deeper, inside the mydaddy player document, as
 *     `<a href='//…/1080.mp4'>` quality links (fluidplayer page).
 *   • Those CDN links are short-lived: a sniffed URL is often already dead
 *     (HTTP 404) by the time the user clicks Download.
 *
 * This module instead resolves AT CLICK TIME, server-side in the Node main
 * process (page JS could not do it: mydaddy.cc sends no CORS headers):
 *   hqporner page → mydaddy embed URL → mydaddy player page → fresh MP4 list
 * or directly:
 *   mydaddy page → fresh MP4 list
 *
 * Fresh links + the real video title + the mydaddy page as Referer is exactly
 * what the desktop downloader needs (bigcdn.cc is anti-hotlink).
 *
 * Security (same rules as resolvers.js):
 *   • Only identifiers are parsed out of user input; page fetches go to URLs
 *     we construct on an allowlist of hosts (mydaddy.cc, hqporner.com).
 *   • Redirects are followed only within the same host family — never to a
 *     third party (no open proxy).
 *   • Bodies are capped (2 MB) — player pages are small HTML.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MAX_HTML_BYTES = 2 * 1024 * 1024;

// Hosts this resolver is allowed to fetch page HTML from. Everything else is
// refused (including redirect targets) — the resolver must never become a
// generic URL fetcher.
const PAGE_HOSTS = new Set(['mydaddy.cc', 'www.mydaddy.cc', 'hqporner.com', 'www.hqporner.com', 'm.hqporner.com']);

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
 * @returns {{ provider: 'mydaddy'|'hqporner', id: string, pageUrl: string }|null}
 * Never throws; returns null when the input is not a supported page URL.
 */
function parseEmbedUrl(input) {
  let u;
  try {
    u = new URL(String(input == null ? '' : input).trim());
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');

  if (host === 'mydaddy.cc' || host === 'www.mydaddy.cc') {
    // /video/<hash>/ with an optional &alt suffix (hqporner's alt player
    // appends "&alt" without a "?").
    const m = /^\/video\/([A-Za-z0-9]+)\/?(?:[?&]alt)?\/?$/i.exec(u.pathname);
    if (!m) return null;
    return { provider: 'mydaddy', id: m[1], pageUrl: `https://mydaddy.cc/video/${m[1]}/` };
  }

  if (host === 'hqporner.com' || host === 'www.hqporner.com' || host === 'm.hqporner.com') {
    // /hdporn/<numericId>-<slug>.html
    const m = /^\/hdporn\/(\d+)-[^/]*\.html$/i.exec(u.pathname);
    if (!m) return null;
    return { provider: 'hqporner', id: m[1], pageUrl: `https://hqporner.com/hdporn/${m[1]}-${slugOf(u.pathname)}.html` };
  }

  return null;
}

function slugOf(pathname) {
  const m = /^\/hdporn\/\d+-([^/]*)\.html$/i.exec(String(pathname || ''));
  const slug = (m && m[1]) || 'video';
  return /^[A-Za-z0-9_-]{1,120}$/.test(slug) ? slug : 'video';
}

function isEmbedUrl(input) {
  return parseEmbedUrl(input) !== null;
}

// ── Page fetching (allowlisted hosts only) ─────────────────────────────────

function sameFamily(a, b) {
  const base = (h) => String(h || '').toLowerCase().replace(/^(www\.|m\.)/, '');
  return base(a) === base(b);
}

function fetchPageHtml(url, { timeoutMs = 15000, redirectCount = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 3) { reject(new Error('Too many redirects while resolving video page')); return; }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) { reject(new Error('Invalid URL')); return; }
    if (!PAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
      reject(new Error('Resolver refuses to fetch off-allowlist host: ' + parsed.hostname));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let target;
        try { target = new URL(res.headers.location, url); } catch (e) { reject(e); return; }
        if (!PAGE_HOSTS.has(target.hostname.toLowerCase()) || !sameFamily(target.hostname, parsed.hostname)) {
          reject(new Error('Video page redirected to an unexpected host'));
          return;
        }
        resolve(fetchPageHtml(target.toString(), { timeoutMs, redirectCount: redirectCount + 1 }));
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
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Video page request timed out')); });
    req.end();
  });
}

// ── Pure HTML parsers (unit-testable, no network) ──────────────────────────

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
 * Real video title from a mydaddy/hqporner page: <title>, og:title, then <h1>.
 * Returns null when nothing usable is found (never a hostname).
 */
function extractEmbedTitle(html, hostname) {
  const isUsable = (t) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (s.length < 2) return false;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) return false;
    if (/^(video|watch|play|player|home|index|untitled|download|media|clip|embed)$/i.test(s)) return false;
    return true;
  };
  const clean = (t) => {
    let s = String(t || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*[-|–—:|]\s*[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*$/i, '').trim();
    return isUsable(s) ? s.slice(0, 100) : null;
  };

  let m = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{2,200})["']/i.exec(html || '');
  if (m && clean(m[1])) return clean(m[1]);
  m = /<title[^>]*>([^<]{2,200})<\/title\s*>/i.exec(html || '');
  if (m) {
    const c = clean(m[1]);
    // A bare "<title>mydaddy.cc</title>" (embed player chrome) is not a title.
    if (c && !(hostname && c.toLowerCase() === String(hostname).toLowerCase())) return c;
  }
  m = /<h1[^>]*>([\s\S]{2,200}?)<\/h1\s*>/i.exec(html || '');
  if (m) {
    const c = clean(textOf(m[1]));
    if (c) return c;
  }
  return null;
}

/**
 * Find the mydaddy player page URL inside an hqporner page: the player
 * iframe, the alt/native player handoff blocks, or any bare reference.
 * Returns a canonical https URL or null. Pure function.
 */
function extractMydaddyEmbed(html) {
  const src = String(html || '');
  let m = /<iframe[^>]+src=["'](\/\/mydaddy\.cc\/video\/[A-Za-z0-9]+\/?(?:&alt)?)["']/i.exec(src);
  if (m) {
    const base = ('https:' + m[1].replace(/&amp;/g, '&')).split('&alt')[0].replace(/\/+$/, '');
    return base + '/';
  }
  m = /\/(?:blocks\/)?(?:alt|native)player\.php\?i=\/\/mydaddy\.cc\/video\/([A-Za-z0-9]+)\/?/i.exec(src);
  if (m) return `https://mydaddy.cc/video/${m[1]}/`;
  m = /mydaddy\.cc\/video\/([A-Za-z0-9]{8,})/i.exec(src);
  if (m) return `https://mydaddy.cc/video/${m[1]}/`;
  return null;
}

function qualityFromLabel(h) {
  const m = /(\d{3,4})\s*p\b/i.exec(String(h || ''));
  if (!m) return null;
  const height = parseInt(m[1], 10);
  return QUALITY_RESOLUTION[height] ? height : null;
}

/**
 * Direct playable links from a mydaddy player page. Covers server-rendered
 * `<a href='//sXX.bigcdn.cc/pubs/<hash>.<id>/1080.mp4'>` quality links,
 * `<video>/<source src>`, `video_url`/`file` JS config values, and HLS
 * masters (`.m3u8` — the engine assembles those; quality comes from a label
 * when the URL carries none). DASH manifests (`.mpd`) are counted but never
 * offered: the engine cannot download them yet (see resolveEmbedVideos).
 * Quality comes from the KVS rendition filename (`/1080.mp4`) or a label.
 * Returns best-first (MP4 before HLS), de-duplicated. Pure function.
 */
function extractMydaddyVariants(html, pageUrl) {
  const src = String(html || '');
  const found = new Map(); // url -> { url, format, labelHint }
  const mpdSeen = new Set(); // unique DASH manifests (sightings deduped)
  let mpdCount = 0;

  const take = (raw, labelHint) => {
    if (!raw || typeof raw !== 'string') return;
    let u = raw.trim().replace(/&amp;/g, '&').replace(/["'\),;\\]+$/, '');
    if (!u) return;
    if (u.startsWith('//')) u = 'https:' + u;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) {
      // Root-relative or relative link — resolve against the player page.
      try { u = new URL(u, pageUrl || undefined).href; } catch (e) { return; }
    }
    if (!/^https?:\/\//i.test(u)) return;
    const isHls = /\.m3u8(\?|#|$)/i.test(u);
    const isMp4 = /\.(mp4|m4v|webm|mkv|mov)(\?|#|$)/i.test(u);
    const isMpd = /\.mpd(\?|#|$)/i.test(u);
    if (isMpd) {
      try {
        const n = new URL(u, pageUrl || undefined).href;
        if (!mpdSeen.has(n)) { mpdSeen.add(n); mpdCount++; }
      } catch (e) { mpdCount++; }
      return;
    }
    // Media files only — never posters, scripts, or stylesheets.
    if (!isMp4 && !isHls) return;
    if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|css|js|vtt|srt|woff2?)(\?|#|$)/i.test(u)) return;
    try {
      const normalized = new URL(u, pageUrl || undefined).href;
      if (!found.has(normalized)) {
        found.set(normalized, { url: normalized, format: isHls ? 'hls' : 'mp4', labelHint: labelHint || null });
      }
    } catch (e) { /* malformed URL — skip */ }
  };

  // 1. Markup: <a href>, <source src>, <video src> (single or double quotes).
  const attrRe = /(?:href|src)\s*=\s*["']((?:https?:)?\/\/[^"'<>\s]+\.(?:mp4|m4v|webm|mkv|mov|m3u8|mpd)[^"'<>\s]*|[^"'<>\s]+\.(?:mp4|m4v|webm|mkv|mov|m3u8|mpd)[^"'<>\s]*)["']/gi;
  let m;
  while ((m = attrRe.exec(src)) !== null) take(m[1]);

  // 2. JS player config: video_url / video_alt_urlN / file / src values.
  const jsRe = /(?:video_(?:url|alt_url\d*)|["']?(?:file|src|url|source)["']?)\s*[:=]\s*["']([^"']+\.(?:mp4|m4v|webm|mkv|mov|m3u8|mpd)[^"']*)["']/gi;
  while ((m = jsRe.exec(src)) !== null) take(m[1]);

  // 3. Quality labels next to the links (`>1080p<`, `data-quality="720p"`).
  const out = [];
  for (const { url, format, labelHint } of found.values()) {
    let height = null;
    if (format === 'mp4') {
      const pathQ = /\/(\d{3,4})\.(?:mp4|m4v|mkv|webm|mov)(?:[?#]|$)/i.exec(url);
      if (pathQ && QUALITY_RESOLUTION[parseInt(pathQ[1], 10)]) {
        height = parseInt(pathQ[1], 10);
      } else {
        const anyQ = /(\d{3,4})p/i.exec(url);
        if (anyQ && QUALITY_RESOLUTION[parseInt(anyQ[1], 10)]) height = parseInt(anyQ[1], 10);
      }
    } else {
      // HLS masters rarely encode rendition in the URL — read the label.
      const anyQ = /(\d{3,4})p/i.exec(url);
      if (anyQ && QUALITY_RESOLUTION[parseInt(anyQ[1], 10)]) height = parseInt(anyQ[1], 10);
    }
    if (!height && labelHint) {
      const lh = qualityFromLabel(labelHint);
      if (lh) height = lh;
    }
    // Label search around the URL's position in the source as a last resort.
    if (!height) {
      const idx = src.indexOf(url.replace(/^https?:/, ''));
      const window = idx >= 0 ? src.slice(Math.max(0, idx - 160), idx + url.length + 160) : '';
      const wq = /(\d{3,4})\s*p\b/i.exec(window);
      if (wq && QUALITY_RESOLUTION[parseInt(wq[1], 10)]) height = parseInt(wq[1], 10);
    }
    out.push({
      url,
      contentType: format === 'hls' ? 'application/x-mpegURL' : 'video/mp4',
      isMp4: format === 'mp4',
      bitrate: 0,
      width: height && QUALITY_RESOLUTION[height] ? parseInt(QUALITY_RESOLUTION[height].split('x')[0], 10) : 0,
      height: height || 0,
      quality: height ? `${height}p` : 'unknown',
    });
  }

  out.sort((a, b) => (Number(b.isMp4) - Number(a.isMp4)) ||
                     (b.height - a.height) || (b.bitrate - a.bitrate));
  out._mpdCount = mpdCount;
  return out;
}

/** "35min 53sec" / "35m 53s" style durations from hqporner meta text. */
function extractDurationSeconds(html) {
  const src = String(html || '');
  let m = /(\d+)\s*min\s*(\d+)\s*sec/i.exec(src) || /(\d+)\s*m\s*(\d+)\s*s\b/i.exec(src);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = /duration["']?\s*[:=]\s*["']?(\d+)\s*:\s*(\d{1,2})/i.exec(src);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

/** Poster image, if the page advertises one (og:image preferred). */
function extractThumbnail(html, pageUrl) {
  const src = String(html || '');
  let m = /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(src);
  const abs = (u) => {
    if (!u) return null;
    try {
      const href = new URL(String(u).replace(/&amp;/g, '&'), pageUrl || undefined).href;
      return /^https?:/i.test(href) ? href : null;
    } catch (e) { return null; }
  };
  if (m) { const t = abs(m[1]); if (t) return t; }
  m = /<video[^>]+poster=["']([^"']+)["']/i.exec(src);
  if (m) { const t = abs(m[1]); if (t) return t; }
  return null;
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
 * Resolve a mydaddy.cc/video/ or hqporner.com/hdporn/ URL into fresh,
 * directly-downloadable MP4 variants. Throws with a human-readable message
 * when the page has no playable video.
 *
 * `deps.fetchHtml` optionally overrides page fetching (tests).
 *
 * @returns {Promise<{provider, id, title, thumbnail, duration, canonicalUrl,
 *   referer, videos: Array<{url, quality, resolution, format, filename}>}>}
 */
async function resolveEmbedVideos(input, deps = {}) {
  const fetchHtml = (deps && deps.fetchHtml) || fetchPageHtml;
  const parsed = parseEmbedUrl(input);
  if (!parsed) throw new Error('Not a mydaddy.cc or hqporner.com video URL');

  let mydaddyUrl;
  let title = null;
  let thumbnail = null;
  let duration = null;

  if (parsed.provider === 'hqporner') {
    let hqHtml;
    try {
      hqHtml = await fetchHtml(parsed.pageUrl);
    } catch (e) {
      throw new Error(`Could not load the hqporner page (${e.message})`);
    }
    // The hqporner h1 is the real video title ("kidnapped body heat").
    title = extractEmbedTitle(hqHtml, 'hqporner.com');
    thumbnail = extractThumbnail(hqHtml, parsed.pageUrl);
    duration = extractDurationSeconds(hqHtml);
    const embed = extractMydaddyEmbed(hqHtml);
    if (!embed) throw new Error('No playable video found on this hqporner page (player embed missing)');
    mydaddyUrl = embed;
  } else {
    mydaddyUrl = parsed.pageUrl;
  }

  let mdHtml;
  try {
    mdHtml = await fetchHtml(mydaddyUrl);
  } catch (e) {
    throw new Error(`Could not load the mydaddy player page (${e.message})`);
  }
  if (!title) title = extractEmbedTitle(mdHtml, 'mydaddy.cc');
  if (!thumbnail) thumbnail = extractThumbnail(mdHtml, mydaddyUrl);
  const variants = extractMydaddyVariants(mdHtml, mydaddyUrl);
  if (!variants.length) {
    // The player exists but offers nothing we can download. Say exactly why:
    // a DASH-only page needs engine support that does not exist yet, while a
    // truly empty page usually means a removed video or a login wall.
    if (variants._mpdCount > 0) {
      throw new Error('This page only offers DASH streams (.mpd), which AiDM cannot download yet — try the native/alternative player if the site offers one');
    }
    throw new Error('No downloadable video found on this page (it may have been removed or require login)');
  }

  const label = safeTitle(title || 'video', 'video');
  const videos = variants.map((v) => {
    const isHls = v.isMp4 === false;
    return {
      url: v.url,
      quality: v.quality || 'unknown',
      resolution: v.width && v.height ? `${v.width}x${v.height}` : null,
      format: isHls ? 'hls' : 'mp4',
      // The manager assembles HLS into a .ts container regardless of this
      // suffix; keep the human-readable shape identical for both kinds.
      filename: `${label}${v.quality && v.quality !== 'unknown' ? ` [${v.quality}]` : ''}.${isHls ? 'm3u8' : 'mp4'}`,
    };
  });

  return {
    provider: parsed.provider,
    id: parsed.provider === 'hqporner' ? parsed.id : mydaddyId(mydaddyUrl),
    title: label,
    thumbnail,
    duration,
    // Downloads must replay THIS page as Referer (bigcdn.cc is anti-hotlink).
    canonicalUrl: mydaddyUrl,
    referer: mydaddyUrl,
    videos,
  };
}

function mydaddyId(pageUrl) {
  const m = /\/video\/([A-Za-z0-9]+)/i.exec(String(pageUrl || ''));
  return m ? m[1] : 'video';
}

/**
 * Convert resolver variants into the shape the UI's quality picker expects.
 * Single source of truth — mirrors twitter-resolver.toPickerVideos.
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
  parseEmbedUrl,
  isEmbedUrl,
  fetchPageHtml,
  extractEmbedTitle,
  extractMydaddyEmbed,
  extractMydaddyVariants,
  extractDurationSeconds,
  extractThumbnail,
  resolveEmbedVideos,
  toPickerVideos,
};
