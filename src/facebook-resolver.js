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

// `efg` carries the encode descriptor; an audio encode_tag means the URL is
// the audio-only half of a split DASH rendition — never a playable download.
// Facebook tags audio renditions with a codec fingerprint, often WITHOUT the
// literal word "audio" (e.g. dash_ln_heaac_vbr3, dash_aac_lc, dash_mp4a.40.2,
// dash_ln_heaacv3). Matching only /audio/i misclassified those as VIDEO rows —
// the audio half was offered as a playable video and the real video shipped
// silent. Match the codec fingerprints too; never the video codecs
// (vp9/av1/avc/h264/hev). (Regex shape routed via Jev triage.)
const FB_AUDIO_TAG_RE = /audio|heaac|aac[_-]|mp4a|opus|vorbis/i;
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
    // encode_tag is the primary descriptor. Some renditions expose the codec
    // under vencode_tag too, so test both for an audio fingerprint (an audio
    // half still carries an audio codec in one of them).
    const enc = String(obj.encode_tag || '');
    const venc = String(obj.vencode_tag || '');
    return FB_AUDIO_TAG_RE.test(enc) || FB_AUDIO_TAG_RE.test(venc);
  } catch (e) { return false; }
}

function qualityFromHeight(h) {
  const n = parseInt(h, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (QUALITY_RESOLUTION[n]) return { quality: `${n}p`, width: parseInt(QUALITY_RESOLUTION[n].split('x')[0], 10), height: n };
  return { quality: `${n}p`, width: 0, height: n };
}

/**
 * Loose page-video id from a href — used to scope variants to the page's own
 * (playing) video. Does NOT enforce parseFacebookUrl's strict id rules, so
 * short fixture ids and reel tokens still scope the list.
 */
function looseFacebookVideoId(href) {
  try {
    const u = new URL(String(href || ''));
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'fb.watch') {
      const m = /^\/([A-Za-z0-9_-]{3,64})\/?$/i.exec(u.pathname);
      return m ? m[1] : null;
    }
    if (/facebook\.com$/i.test(host)) {
      if (/^\/watch\/?$/i.test(u.pathname)) return u.searchParams.get('v') || null;
      if (/^\/(video|story)\.php$/i.test(u.pathname)) {
        return u.searchParams.get('v') || u.searchParams.get('video_id') || u.searchParams.get('story_fbid') || null;
      }
      const m = /^\/[^/]+\/videos\/(?:[^/]+\/)?(\d{3,25})\/?$/i.exec(u.pathname) ||
                /^\/reel\/([A-Za-z0-9_-]{3,64})\/?$/i.exec(u.pathname) ||
                /^\/share\/v\/([A-Za-z0-9_-]{3,64})\/?$/i.exec(u.pathname);
      return m ? m[1] : null;
    }
    if (/instagram\.com$/i.test(host)) {
      const m = /^\/(reel|p|tv)\/([A-Za-z0-9_-]{3,64})\/?/i.exec(u.pathname);
      return m ? m[2] : null;
    }
  } catch (e) {}
  return null;
}

/** efg.video_id or path-token id of a Facebook CDN URL, or null. */
function videoIdFromFbUrl(u) {
  try {
    const x = new URL(String(u), 'https://www.facebook.com/');
    const efg = x.searchParams.get('efg');
    if (efg) {
      let parsed = null;
      try {
        if (String(efg).charAt(0) === '{') parsed = JSON.parse(String(efg));
      } catch (e) {}
      if (!parsed) {
        let b64 = String(efg).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        try { parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch (e) { parsed = null; }
      }
      if (parsed && parsed.video_id != null) return String(parsed.video_id);
    }
    const path = x.pathname || '';
    const m = /\/(\d{3,25})[_/.]/.exec(path) || /\/(\d{3,25})$/.exec(path);
    if (m) return m[1];
  } catch (e) {}
  return null;
}

/**
 * Drop variants that belong to OTHER videos on the same page payload.
 * Fail-open: when nothing is attributable to `videoId`, return variants
 * unchanged — a wrong empty list is worse than a slightly broad one.
 * Only URLs that PROVE a different video id are dropped when matches exist.
 */
function filterVariantsToPageVideo(variants, videoId, html) {
  const list = (variants || []).slice();
  if (!list.length || !videoId) return list;
  const id = String(videoId);
  if (/^watch-/i.test(id)) return list; // fb.watch short token — no CDN id

  const idOf = (u) => videoIdFromFbUrl(u);
  const matches = list.filter(v => idOf(v.url) === id);
  const pathMatch = list.filter(v => {
    try {
      const path = new URL(String(v.url), 'https://www.facebook.com/').pathname || '';
      return path.includes('/' + id + '_') || path.includes('/' + id + '/') || path.includes('/' + id + '.');
    } catch (e) { return false; }
  });
  const scored = matches.length ? matches : pathMatch;
  if (!scored.length) {
    // Nothing carries this id (common: progressive URLs are hash paths).
    // Drop only rows that PROVE a different numeric id; keep the rest.
    return list.filter(v => {
      const vid = idOf(v.url);
      if (!vid) return true;
      return String(vid) === id;
    });
  }
  // At least one URL is proven to be this page's video — keep that family
  // plus unattributable siblings (same page playable_url cluster).
  const keepIds = new Set(scored.map(v => idOf(v.url)).filter(Boolean));
  const keepPaths = new Set(scored.map(v => {
    try { return new URL(String(v.url), 'https://www.facebook.com/').pathname || ''; }
    catch (e) { return ''; }
  }).filter(Boolean));
  return list.filter(v => {
    const vid = idOf(v.url);
    if (vid) return keepIds.has(vid) || vid === id;
    try {
      const path = new URL(String(v.url), 'https://www.facebook.com/').pathname || '';
      if (keepPaths.has(path)) return true;
      // Same path directory as a proven match (rendition siblings).
      for (const p of keepPaths) {
        const dir = p.replace(/\/[^/]+$/, '');
        if (dir && path.startsWith(dir + '/')) return true;
      }
    } catch (e) {}
    return true; // unattributable progressive URL stays
  });
}

function pathDirOf(u) {
  try {
    return new URL(String(u), 'https://www.facebook.com/').pathname.replace(/\/[^/]+$/, '');
  } catch (e) { return null; }
}

/**
 * Fresh progressive MP4s from a Facebook/Instagram video page. Covers the
 * keys the web player itself embeds (`playable_url`, `playable_url_quality_hd`,
 * `browser_native_hd/sd_url`, `hd_src`/`sd_src`, and the newer
 * `videoDeliveryResponseFragment…progressive_urls[]`), plus a generic fbcdn
 * …mp4 fallback. HLS masters are kept as a last resort (the engine assembles
 * them); DASH manifests (.mpd) are counted but never offered. Audio-only
 * efg renditions are collected and paired onto video variants as `audioUrl`
 * so the desktop can mux sound into split-AV downloads. Variants belonging
 * to other videos on the page are filtered out.
 * Returns best-first (MP4 before HLS), de-duplicated. Pure function.
 */
function extractFacebookVariants(html, pageUrl) {
  const src = String(html || '');
  const found = new Map(); // url -> { url, format, quality, width, height }
  const audioTracks = []; // { url, videoId, pathDir }
  const seenAudio = new Set();
  // One URL can surface under several keys (audio_url + generic efg sweep):
  // dedupe so the single-audio fallback (`soleAudio`) still fires.
  const rememberAudio = (u) => {
    try {
      const abs = new URL(String(u), pageUrl || undefined).href;
      if (seenAudio.has(abs)) return;
      seenAudio.add(abs);
      audioTracks.push({ url: abs, videoId: videoIdFromFbUrl(abs), pathDir: pathDirOf(abs) });
    } catch (e) { /* ignore */ }
  };
  let mpdCount = 0;

  const unescape = (s) => String(s || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&');

  const take = (raw, qualityHint, sourceTag) => {
    if (!raw || typeof raw !== 'string') return;
    let u = unescape(raw).trim().replace(/&amp;/g, '&').replace(/["'\),;\\]+$/, '');
    if (!u) return;
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https?:\/\//i.test(u)) return;
    // Split-AV audio harvest FIRST: an audio-only DASH rendition is never a
    // video row, no matter its extension (or lack of one). Classifying before
    // the container gate keeps extensionless fbcdn audio URLs pairable —
    // otherwise the paired video downloads silent with no audioUrl attached.
    try {
      const efg = new URL(u, pageUrl || undefined).searchParams.get('efg');
      if (efg && efgIsAudio(efg)) {
        rememberAudio(u);
        return;
      }
    } catch (e) { /* keep — unparseable efg is not proof of audio */ }
    // Explicit audio keys (audio_url, dash_audio, …) are trusted when the URL
    // is either efg-audio (handled above) or audio-typed by container/path.
    // Anything else falls through to normal video handling — a mislabeled key
    // must never hide the only playable file.
    if (sourceTag === 'audio' &&
        !/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma)(\?|#|$)/i.test(u) &&
        !/(^|[/_?&-])audio([/_?&-]|$)/i.test(u)) {
      sourceTag = null;
    }
    const isHls = /\.m3u8(\?|#|$)/i.test(u);
    const isMp4 = /\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(u);
    const isAudioFile = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma)(\?|#|$)/i.test(u);
    if (/\.mpd(\?|#|$)/i.test(u)) { mpdCount++; return; }
    if (!isMp4 && !isHls && !isAudioFile && sourceTag !== 'audio') return;
    if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|css|js|vtt|srt|woff2?)(\?|#|$)/i.test(u)) return;
    // Audio-only half of a split DASH rendition — never a video row, but
    // remember it so the paired video track can be muxed with sound.
    // (efg-audio was already harvested above; this covers audio-typed files
    // and explicit audio keys without an efg tag.)
    if (sourceTag === 'audio' || isAudioFile) {
      rememberAudio(u);
      return;
    }
    try {
      const efg = new URL(u, pageUrl || undefined).searchParams.get('efg');
      if (efg && efgIsAudio(efg)) {
        rememberAudio(u);
        return;
      }
    } catch (e) { /* keep — unparseable efg is not proof of audio */ }
    try {
      const normalized = new URL(u, pageUrl || undefined).href;
      // progressive: named playable_url / browser_native / progressive_url /
      // hd_src / sd_src — these usually carry audio. Generic fbcdn scrapes
      // are often DASH video-only (silent) — tag them so we can rank.
      const prog = sourceTag === 'progressive';
      if (!found.has(normalized)) {
        found.set(normalized, {
          url: normalized,
          format: isHls ? 'hls' : 'mp4',
          qualityHint: qualityHint || null,
          progressive: prog,
        });
      } else if (qualityHint && !found.get(normalized).qualityHint) {
        found.get(normalized).qualityHint = qualityHint;
      } else if (prog && !found.get(normalized).progressive) {
        found.get(normalized).progressive = true;
      }
    } catch (e) { /* malformed URL — skip */ }
  };

  const pats = [
    [/"playable_url_quality_hd"\s*:\s*"([^"]+)"/gi, null, 'progressive'],
    [/"playable_url"\s*:\s*"([^"]+)"/gi, null, 'progressive'],
    [/\bplayable_url_quality_hd["']?\s*[:=]\s*["']([^"']+)/gi, null, 'progressive'],
    [/\bplayable_url["']?\s*[:=]\s*["']([^"']+)/gi, null, 'progressive'],
    [/"browser_native_hd_url"\s*:\s*"([^"]+)"/gi, '1080p', 'progressive'],
    [/"browser_native_sd_url"\s*:\s*"([^"]+)"/gi, '480p', 'progressive'],
    [/\bbrowser_native_hd_url["']?\s*[:=]\s*["']([^"']+)/gi, '1080p', 'progressive'],
    [/\bbrowser_native_sd_url["']?\s*[:=]\s*["']([^"']+)/gi, '480p', 'progressive'],
    [/"hd_src"\s*:\s*"([^"]+)"/gi, '720p', 'progressive'],
    [/"sd_src"\s*:\s*"([^"]+)"/gi, '480p', 'progressive'],
    [/\bhd_src["']?\s*[:=]\s*["']([^"']+)/gi, '720p', 'progressive'],
    [/\bsd_src["']?\s*[:=]\s*["']([^"']+)/gi, '480p', 'progressive'],
    // Newer delivery fragment: {"progressive_url":"…","metadata":{"quality":"hd",…}}
    [/"progressive_url"\s*:\s*"([^"]+)"/gi, null, 'progressive'],
    [/"hls_playlist_url"\s*:\s*"([^"]+)"/gi, null, null],
    // Audio-only counterparts live under their own keys (and extensionless on
    // some surfaces). take() routes efg-audio / audio-typed values into the
    // paired-audio pool, never into video rows.
    [/"audio_url"\s*:\s*"([^"]+)"/gi, null, 'audio'],
    [/"audio_playable_url"\s*:\s*"([^"]+)"/gi, null, 'audio'],
    [/"playable_audio_url"\s*:\s*"([^"]+)"/gi, null, 'audio'],
    [/"audio_browser_native_hd_url"\s*:\s*"([^"]+)"/gi, null, 'audio'],
    [/"audio_browser_native_sd_url"\s*:\s*"([^"]+)"/gi, null, 'audio'],
    [/"dash_audio(?:_url)?"\s*:\s*"([^"]+)"/gi, null, 'audio'],
    [/\baudio_url["']?\s*[:=]\s*["']([^"']+)/gi, null, 'audio'],
    [/\bdash_audio(?:_url)?["']?\s*[:=]\s*["']([^"']+)/gi, null, 'audio'],
    // DASH manifests: counted (so the resolver can say "DASH-only") but never
    // offered — take() routes .mpd into mpdCount.
    [/"dash_manifest(?:_url)?"\s*:\s*"([^"]+)"/gi, null, null],
    [/\bdash_manifest(?:_url)?["']?\s*[:=]\s*["']([^"']+)/gi, null, null],
  ];
  for (const [re, q, tag] of pats) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) take(m[1], q, tag);
  }
  // Generic fallback: any fbcdn/scontent …mp4 in the page payload.
  const fbMp4 = /https?:\\?\/\\?\/[^"'\\\s<>]*?(?:fbcdn|scontent)[^"'\\\s<>]*?\.mp4[^"'\\\s<>]*/gi;
  let g;
  while ((g = fbMp4.exec(src)) !== null) take(g[0], null, 'generic');
  // …and any fbcdn/scontent/cdninstagram URL carrying an efg rendition tag,
  // whatever its extension (audio DASH renditions are extensionless on some
  // surfaces — take() harvests the efg-audio ones into the audio pool).
  const fbEfg = /https?:\\?\/\\?\/[^"'\\\s<>]*?(?:fbcdn|scontent|cdninstagram)[^"'\\\s<>]*?[?&]efg=[^"'\\\s<>]*/gi;
  let eg;
  while ((eg = fbEfg.exec(src)) !== null) take(eg[0], null, 'generic');
  // …and any …mpd (counted, never offered).
  const fbMpd = /https?:\\?\/\\?\/[^"'\\\s<>]*?(?:fbcdn|scontent)[^"'\\\s<>]*?\.mpd[^"'\\\s<>]*/gi;
  let d;
  while ((d = fbMpd.exec(src)) !== null) take(d[0], null, null);

  const out = [];
  for (const { url, format, qualityHint, progressive } of found.values()) {
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
      progressive: !!progressive,
    });
  }

  // Prefer progressive (playable_url / progressive_urls) — those usually
  // carry audio. DASH video-only scrapes sort after and rely on audioUrl mux.
  // playable_url vs playable_url_quality_hd order in the page is SD-then-HD;
  // sort best-first so the picker and "best" selection agree.
  out.sort((a, b) => (Number(!!b.progressive) - Number(!!a.progressive)) ||
                     (Number(b.isMp4) - Number(a.isMp4)) ||
                     (b.height - a.height) || (b.bitrate - a.bitrate));

  // Pair split-AV audio onto video rows (desktop muxes these after download).
  try {
    const audioById = new Map();
    const audioByDir = new Map();
    for (const a of audioTracks) {
      if (a.videoId && !audioById.has(a.videoId)) audioById.set(a.videoId, a.url);
      if (a.pathDir && !audioByDir.has(a.pathDir)) audioByDir.set(a.pathDir, a.url);
    }
    // Page identity for hash-path videos: an id-less progressive row (no efg,
    // opaque filename) still belongs to this page, so its audio sibling —
    // which usually DOES carry the page video id — pairs by page, not by row.
    // This is what keeps single-video pages from downloading silent when other
    // audios on the page defeat the sole-audio fallback.
    let pageVid = null;
    try { pageVid = looseFacebookVideoId(pageUrl); } catch (e) { pageVid = null; }
    if (pageVid) pageVid = String(pageVid);
    const soleAudio = audioTracks.length === 1 ? audioTracks[0].url : null;
    for (const v of out) {
      if (v.audioUrl) continue;
      const vid = videoIdFromFbUrl(v.url);
      const dir = pathDirOf(v.url);
      const paired = (vid && audioById.get(vid)) ||
        (pageVid && audioById.get(pageVid)) ||
        (dir && audioByDir.get(dir)) || soleAudio || null;
      if (paired) v.audioUrl = paired;
    }
  } catch (e) { /* pairing is best-effort */ }

  // Only the page's own video — never related/watch-list neighbours.
  let pageVid = looseFacebookVideoId(pageUrl);
  if (!pageVid) {
    try {
      const parsed = parseFacebookUrl(pageUrl);
      if (parsed && parsed.id) pageVid = String(parsed.id);
    } catch (e) {}
  }
  const scoped = filterVariantsToPageVideo(out, pageVid, src);
  scoped._mpdCount = mpdCount;
  return scoped;
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
  // Prefer the final page id (redirects can change watch?v=) over the input.
  let pageVid = parsed.id && !String(parsed.id).startsWith('watch-') ? String(parsed.id) : null;
  const looseFinal = looseFacebookVideoId(finalUrl);
  if (looseFinal && !String(looseFinal).startsWith('watch-')) pageVid = String(looseFinal);
  else {
    try {
      const fromFinal = parseFacebookUrl(finalUrl);
      if (fromFinal && fromFinal.id && !String(fromFinal.id).startsWith('watch-')) {
        pageVid = String(fromFinal.id);
      }
    } catch (e) { /* keep input id */ }
  }
  const allVariants = extractFacebookVariants(html, finalUrl);
  // extractFacebookVariants already scopes by pageUrl; re-scope with the
  // resolved id when the final URL was a short/ambiguous form.
  const variants = pageVid
    ? filterVariantsToPageVideo(allVariants, pageVid, html)
    : allVariants;
  try { variants._mpdCount = allVariants._mpdCount || 0; } catch (e) {}
  if (!variants.length) {
    if ((allVariants._mpdCount || 0) > 0) {
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
      audioUrl: v.audioUrl || null,
      progressive: !!v.progressive,
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
 * `audioUrl` rides along so split-AV Facebook downloads can be muxed.
 */
function toPickerVideos(videos) {
  return (videos || []).map((v) => ({
    url: v.url,
    filename: v.filename,
    quality: v.quality || 'auto',
    resolution: v.resolution || null,
    format: v.format || 'mp4',
    size: v.size || null,
    audioUrl: v.audioUrl || null,
    progressive: !!v.progressive,
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
  filterVariantsToPageVideo,
  videoIdFromFbUrl,
  looseFacebookVideoId,
  resolveFacebookVideos,
  toPickerVideos,
};
