/**
 * AiDM Content Script v2
 * Auto-detects downloadable videos with quality/resolution/size info
 * Scans for video sources, HLS manifests, and direct download links
 */

(function() {
  'use strict';

  // ── Patterns ─────────────────────────────────────────────────────────────────

  const VIDEO_EXT = /\.(mp4|webm|mkv|avi|mov|flv|m4v|ts|m4s)(\?|#|$)/i;
  const STREAM_EXT = /\.(m3u8|mpd)(\?|#|$)/i;
  const AUDIO_EXT = /\.(mp3|wav|flac|aac|ogg|wma|m4a|opus)(\?|#|$)/i;
  // Image files are first-class downloadable assets — treat them exactly like
  // video/audio when deciding what the page "offers" for download.
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|ico|heic|heif)(\?|#|$)/i;
  const DOWNLOAD_EXT = /\.(zip|rar|7z|tar|gz|exe|msi|iso|dmg|deb|rpm|apk|pdf|doc|docx|xls|xlsx|ppt|pptx)(\?|#|$)/i;

  const VIDEO_HOSTS = [
    /googlevideo\.com/i,
    /youtube\.com\/videoplayback/i,
    /cdn.*video/i,
    /stream.*video/i,
    /video.*cdn/i,
    /\.cdn\./i,
    /twimg\.com/i,        // Twitter / X video CDN (direct MP4 variants)
    /fbcdn\.net/i,        // Facebook / Instagram video CDN
    /scontent\./i,        // Facebook image/video edge
    /cdninstagram\.com/i, // Instagram Reels edge
  ];

  // Facebook video: often extensionless (…/v/t59.4756-21/…?oh=…&oe=…).
  const FB_HOST_RE = /fbcdn\.net|scontent\.|facebook\.com|fb\.com|instagram\.com|cdninstagram\.com/i;
  const FB_VIDEO_PATH_RE = /\/v\/t|video\.php|playable|bytestart|\/dash\/|\/hls\/|\/reel|\/watch\//i;
  // Raw DASH/HLS segments must never become "download links" — they are why
  // one playing video exploded into dozens of duplicate rows.
  const SEGMENT_RE = /\.m4s($|\?|#|;)|init\.mp4($|\?|#)|seg-?\d+|chunklist|fragment|frag-?\d+|\/range\//i;
  function isSegmentUrl(u) {
    if (!u || typeof u !== 'string') return false;
    if (/\.m4s($|\?|#|;)/i.test(u)) return true;
    // Facebook ?bytestart=N range-slices are recoverable (stripFbRange rewrites
    // them to the full progressive MP4 before dedup/download) — never drop.
    if (/bytestart=\d+/i.test(u) && /fbcdn\.net|scontent\.|facebook\.com|cdninstagram\.com/i.test(u)) return false;
    // Twitter/X HLS chunks are served as plain .ts (no seg/chunk keywords) —
    // there is no such thing as a progressive .ts on twimg, so treat all as
    // segments. Otherwise a 2-minute video becomes dozens of "videos".
    if (/\.ts($|\?|#|;)/i.test(u) && /twimg\.com/i.test(u)) return true;
    if (/\.ts($|\?|#|;)/i.test(u) && /seg|chunk|frag|part|range|hls|dash|playlist|media|sq_|index|seq/i.test(u)) return true;
    return SEGMENT_RE.test(u);
  }
  // Facebook video URLs: must have a real video signal. A bare /v/ path is
  // NOT enough — Facebook images also live at /v/t1.…, /v/t31.… etc.
  // Video quality buckets are t40–t49; images use lower t-numbers.
  function isFacebookVideoUrl(u) {
    if (!u || typeof u !== 'string' || !/^https?:/i.test(u)) return false;
    if (!FB_HOST_RE.test(u)) return false;
    // Hard reject image extensions even on fbcdn hosts
    if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|ico)(\?|#|$)/i.test(u)) return false;
    // Explicit video extension
    if (/\.(mp4|m4v|webm|mov|mkv|avi)(\?|#|$)/i.test(u)) return true;
    // Stream playlists
    if (/\.(m3u8|mpd)(\?|#|$)/i.test(u)) return true;
    // Facebook video quality bucket (t40–t49) — the strongest extensionless signal
    if (/\/v\/t4[0-9](?:\.|\/|$)/i.test(u)) return true;
    // Explicit video endpoints
    if (/video\.php|playable|bytestart|\/dash\/|\/hls\/|\/watch\//i.test(u)) return true;
    return false;
  }
  // Add-or-merge into the detected registry using a token-normalized key so
  // the same file with rotated ?oh=/&oe= signatures never stacks twice.
  // Returns true when a NEW row was created.
  function addDetectedVideo(url, info) {
    if (!url || typeof url !== 'string' || !/^https?:/i.test(url)) return false;
    if (isSegmentUrl(url)) return false;
    // Images never become download rows — Facebook alone loads dozens.
    if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|ico|heic|heif)(\?|#|$)/i.test(url)) return false;
    // Twitter/X strict whitelist: the ONLY downloadable assets on twimg are
    // the direct progressive MP4s (…/pu/vid/<WxH>/….mp4). Playlists, chunks,
    // audio renditions and thumbnails must never become rows — that is how one
    // playing video exploded into 131 identical entries.
    if (TWIMG_RE.test(url) && !isTwitterMp4Url(url)) return false;
    if (detectedVideos.has(url)) return false;
    const n = normalizeStreamUrl(url);
    if (n) {
      for (const [k, v] of detectedVideos) {
        if (normalizeStreamUrl(k) === n) {
          // Merge anything the survivor is missing (filename/size/quality).
          try {
            if (v && info) {
              if (!v.filename && info.filename) v.filename = info.filename;
              if (!v.size && info.size) v.size = info.size;
              if ((!v.quality || v.quality === 'unknown') && info.quality && info.quality !== 'unknown') {
                v.quality = info.quality;
                if (info.resolution) v.resolution = info.resolution;
              }
              if (!v.resolution && info.resolution) v.resolution = info.resolution;
              if (!v.title && info.title) v.title = info.title;
            }
          } catch (e) {}
          return false;
        }
      }
    }
    detectedVideos.set(url, info);
    return true;
  }

  // Xtream-Codes style streams: /live|movie|series/user/pass/id[.ext]?
  // (Xtream *live* channels are served with no extension — `…/live/u/p/123`
  // returns an m3u8 — so the optional extension is required to detect them.)
  const XTREAM_RE = /\/(live|movie|series)\/[^/?#]+\/[^/?#]+\/\d+(?:\.(m3u8|ts|mp4|mkv|avi))?(?:$|[/?#])/i;

  // Per-request token params stripped when comparing stream URLs
  const TOKEN_PARAMS = new Set([
    'token', 'tokens', 'sig', 'signature', 'sign', 'expires', 'expiry', 'exp',
    'e', 'h', 'hdnea', 'hdntl', 'hdnts', 'st', 'key', 'auth', 'authkey',
    'wmsauthsign', 'mst', 'access_token', 'token_expires', 'session', 'sid',
    'policy', 'token_hash', 'verify', 'md5', 't', 'ts', '_',
    // Facebook / Instagram CDN auth (rotates per request — same video, new ?oh=&oe=)
    // NOTE: `vabr` (video-adaptive-bitrate token on hd_src/sd_src) also rotates
    // per request and must be stripped — otherwise the SAME file compares as
    // N distinct URLs and one video explodes into dozens of identical rows.
    'oh', 'oe', 'dl', 'rl', 'vabr', 'efg', 'bytestart', 'byteend',
    '_nc_ht', '_nc_cat', '_nc_ohc', '_nc_rid', '_nc_sid', 'ccb',
    // Twitter / X video CDN (same file re-requested with ?tag=12/14/16… and
    // &container=fmp4 — the tag selects nothing downloadable, it only
    // busts caches while the player polls the HLS playlist).
    'tag', 'container', 'containers',
  ]);

  // ── Twitter / X helpers ────────────────────────────────────────────────────
  // X plays video through blob:+MSE with AES-128 HLS. The player polls
  // https://video.twimg.com/ext_tw_video/…/pu/pl/…m3u8?tag=… every few seconds,
  // so generic sniffing sees one playing video as dozens of "new" playlists
  // (each ?tag= variation looks like a distinct URL). Those playlists are
  // encrypted and not downloadable — the only downloadable Twitter assets are
  // the direct progressive MP4s at …/pu/vid/<WxH>/<hash>.mp4 (surfaced via the
  // GraphQL extractor + the desktop syndication resolver).
  const TWIMG_RE = /video\.twimg\.com|pbs\.twimg\.com|t\.twimg\.com/i;
  function isTwitterPlaylistUrl(u) {
    if (!u || typeof u !== 'string') return false;
    if (!TWIMG_RE.test(u)) return false;
    return /\/pl\//i.test(u) || /\.(m3u8|mpd)(\?|#|$|;)/i.test(u);
  }
  function isTwitterMp4Url(u) {
    if (!u || typeof u !== 'string') return false;
    return /video\.twimg\.com/i.test(u) &&
      /\.mp4(\?|#|$)/i.test(u) &&
      /\/vid\/|ext_tw_video|amplify_video/i.test(u);
  }
  function isTwitterPage() {
    try { return /(^|\.)(twitter\.com|x\.com)$/i.test(location.hostname); }
    catch (e) { return false; }
  }
  // Variants of ONE video share their media id:
  //   /ext_tw_video/<mediaId>/pu/vid/640x360/<hash>.mp4
  //   /ext_tw_video/<mediaId>/pu/vid/1280x720/<hash>.mp4
  // so a pill can be scoped to exactly its own video even on a timeline full
  // of other tweets' videos.
  function twGroupKey(u) {
    try {
      const m = /\/(ext_tw_video|amplify_video)\/(\d+)/i.exec(u || '');
      return m ? (m[1].toLowerCase() + '/' + m[2]) : null;
    } catch (e) { return null; }
  }
  // tweetId -> Map(url -> info), fed by the MAIN-world GraphQL extractor
  // (interceptor.js posts 'twitter-variants' with the tweet each variant set
  // was parsed out of — no guessing involved).
  const twitterVariants = new Map();
  function noteTwitterVariants(tweetId, urls) {
    if (!tweetId || !Array.isArray(urls) || !urls.length) return 0;
    let bucket = twitterVariants.get(String(tweetId));
    if (!bucket) { bucket = new Map(); twitterVariants.set(String(tweetId), bucket); }
    let added = 0;
    for (const u of urls) {
      if (!u || typeof u !== 'string' || !/^https?:/i.test(u)) continue;
      if (isSegmentUrl(u) || !isTwitterMp4Url(u)) continue;
      if (!bucket.has(u)) {
        bucket.set(u, detectQuality(u, null));
        added++;
      }
    }
    if (twitterVariants.size > 200) twitterVariants.delete(twitterVariants.keys().next().value);
    return added;
  }
  // Which tweet does this <video> belong to? Nearest article's status link
  // wins (quotes/replies resolve to their own tweet); a bare status permalink
  // is the fallback for single-tweet pages.
  function tweetIdForVideo(video) {
    try {
      const art = video && video.closest ? video.closest('article') : null;
      if (art) {
        const links = art.querySelectorAll('a[href*="/status/"]');
        for (const a of links) {
          const m = /\/status(?:es)?\/(\d{5,25})/i.exec(a.getAttribute('href') || a.href || '');
          if (m) return m[1];
        }
      }
      const lm = /\/status(?:es)?\/(\d{5,25})/i.exec(location.href || '');
      if (lm) return lm[1];
    } catch (e) {}
    return null;
  }
  // Best-effort per-video URL set for a Twitter <video>, most precise first:
  //   1. blob→MP4 mapping's media group (exact video, all its qualities)
  //   2. tweet association from the GraphQL extractor (exact tweet)
  //   3. null → caller falls back to the page-global MP4 list
  function scopedTwitterUrls(video) {
    try {
      const srcs = [];
      if (video) {
        if (video.src) srcs.push(video.src);
        if (video.currentSrc) srcs.push(video.currentSrc);
      }
      for (const s of srcs) {
        const mapped = (s && s.startsWith('blob:')) ? blobToRealUrlMap.get(s) : s;
        const g = mapped && twGroupKey(mapped);
        if (g) {
          const group = [];
          detectedVideos.forEach(v => {
            if (v && v.url && isTwitterMp4Url(v.url) && twGroupKey(v.url) === g) group.push(v.url);
          });
          interceptedMediaUrls.forEach(u => {
            if (isTwitterMp4Url(u) && twGroupKey(u) === g && !group.includes(u)) group.push(u);
          });
          if (!group.includes(mapped) && isTwitterMp4Url(mapped)) group.unshift(mapped);
          if (group.length) return group;
        }
      }
      const tid = tweetIdForVideo(video);
      if (tid && twitterVariants.has(String(tid))) {
        return Array.from(twitterVariants.get(String(tid)).keys());
      }
    } catch (e) {}
    return null;
  }
  function globalTwitterMp4s() {
    const out = [];
    const seen = new Set();
    const take = (u) => {
      if (!isTwitterMp4Url(u)) return;
      const n = normalizeStreamUrl(u) || u;
      if (seen.has(n)) return;
      seen.add(n);
      out.push(u);
    };
    try { detectedVideos.forEach(v => { if (v && v.url) take(v.url); }); } catch (e) {}
    try { interceptedMediaUrls.forEach(take); } catch (e) {}
    return out;
  }

  // ── Facebook helpers ─────────────────────────────────────────────────────────
// Facebook no-auth progressive MP4s come from dedicated edge pools whose
// hostnames rotate per request AND per quality (video-ak-fbcdn-shv-*.xx,
// scontent-*.xx, video-*.xx.fbcdn.net …). The host alone therefore cannot be
// used to tell two URLs apart, and two QUALITIES of the same video share the
// same filename-bearing path. What IS stable per quality variant is the
// filename-bearing path tail WITHOUT query (e.g. /<id>_<a>_<b>_n.mp4 +
// an optional `efg` video-encode tag). Two variants of the same video at the
// same quality share that key; two DIFFERENT videos never do.
function fbCanonicalHost(h) {
  try {
    h = String(h || '').toLowerCase().replace(/\.$/, '');
    // Facebook edge pools: *.xx.fbcdn.net, scontent-*.xx.fbcdn.net,
    // video-*.xx.fbcdn.net … The PATH alone identifies the object (hosts are
    // interchangeable edge caches), so every fbcdn class collapses to ONE
    // service class — the same file fetched via video-* AND scontent-* must
    // dedup to a single row.
    if (/\.fbcdn\.net$/i.test(h)) return 'fbcdn.net';
    if (/cdninstagram\.com$/i.test(h)) return 'cdninstagram.com';
    return h;
  } catch { return String(h || '').toLowerCase(); }
}

// `efg` is base64url (sometimes raw JSON) carrying the encode descriptor:
// {vrt, bhak, itag, pcv, encode_tag, …}. `bhak` is a PER-REQUEST nonce — the
// raw string changes on every player re-fetch (seek/rebuffer/quality poll).
// Keeping it verbatim in the dedup key is what exploded one playing Facebook
// video into 99+ identical rows. Only fields that are stable PER RENDITION
// may enter the key; anything unknown is dropped.
function fbEfgObj(efg) {
  try {
    const s = String(efg);
    let obj = null;
    if (s.charAt(0) === '{') { try { obj = JSON.parse(s); } catch (e) {} }
    if (!obj) {
      let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      try { obj = JSON.parse(atob(b64)); } catch (e) { obj = null; }
    }
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (e) { return null; }
}

function fbEfgTag(efg) {
  try {
    const s = String(efg);
    let obj = null;
    if (s.charAt(0) === '{') { try { obj = JSON.parse(s); } catch (e) {} }
    if (!obj) {
      let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      try { obj = JSON.parse(atob(b64)); } catch (e) { obj = null; }
    }
    if (!obj || typeof obj !== 'object') return null;
    const bits = [];
    if (obj.encode_tag != null) bits.push('tag:' + obj.encode_tag);
    if (obj.itag != null) bits.push('itag:' + obj.itag);
    if (obj.xw != null && obj.yh != null) bits.push('res:' + obj.xw + 'x' + obj.yh);
    return bits.length ? bits.join(',') : null;
  } catch (e) { return null; }
}

// Facebook serves split DASH renditions as TWO extensionless .mp4 range URLs
// that share an efg video_id: a video-only track (encode_tag like
// "dash_r2av1-r1gen2vp9_q20") and an audio-only track (encode_tag containing
// "audio", e.g. "dash_ln_heaac_vbr3_audio"). Neither is a playable standalone
// file. `fbTrackKindOfUrl` classifies them so the panel can (a) never present
// an audio-only track as a video row and (b) pair the two by video_id.
function fbTrackKindOfUrl(u) {
  try {
    const efg = new URL(String(u || '')).searchParams.get('efg');
    const obj = fbEfgObj(efg);
    if (!obj) return null;
    const tag = String(obj.encode_tag || '');
    if (!tag) return null;
    if (/audio/i.test(tag)) return 'audio';
    return 'video';
  } catch (e) { return null; }
}

function fbVideoIdOfUrl(u) {
  try {
    const efg = new URL(String(u || '')).searchParams.get('efg');
    const obj = fbEfgObj(efg);
    if (obj && obj.video_id != null) return String(obj.video_id);
    return null;
  } catch (e) { return null; }
}

function fbFileKey(u) {
  try {
    const x = new URL(String(u || '').trim());
    x.hash = '';
    x.hostname = fbCanonicalHost(x.hostname);
    let tail = x.pathname || '';
    const efg = x.searchParams.get('efg');
    if (efg) {
      const parsedEfg = fbEfgTag(efg);
      if (parsedEfg) tail += '|efg=' + parsedEfg;
    }
    if (/fbcdn\.net$/i.test(x.hostname) || /cdninstagram\.com$/i.test(x.hostname)) {
      const q = x.searchParams.get('vabr') || x.searchParams.get('rl') || '';
      if (q) tail += '|q=' + q;
    }
    return x.protocol + '//' + x.hostname + tail;
  } catch { return null; }
}

// ?bytestart=N / ?byteend=M turn a full progressive MP4 into a byte SLICE
// (the MSE player fetches the file in such slices). Saving a slice URL as-is
// writes a file missing its ftyp/moov header — "downloaded but not playing".
// This rewrites the slice to its full-file URL. Auth params (oh/oe/efg…)
// are KEPT — only the range is dropped.
function stripFbRange(u) {
  try {
    const s = String(u || '');
    if (!FB_HOST_RE.test(s)) return u;
    const x = new URL(s.trim());
    if (!x.searchParams.has('bytestart') && !x.searchParams.has('byteend')) return u;
    x.searchParams.delete('bytestart');
    x.searchParams.delete('byteend');
    return x.toString();
  } catch { return u; }
}

function normalizeStreamUrl(u) {
    // Facebook: collapse rotating edge-pool hosts AND rotating auth query so
    // the same file requested twice compares equal. `efg`/`rl` (encode tag /
    // rate-level) are KEPT via fbFileKey so SD and HD never merge.
    try {
      if (FB_HOST_RE.test(String(u || ''))) {
        const fk = fbFileKey(u);
        if (fk) return 'fb:' + fk;
      }
    } catch {}
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

  // ── Facebook row collapsing + per-video scoping ───────────────────────────
  // One playing Facebook video can surface dozens of identical panel rows:
  // the player re-requests the same file with rotated tokens (vabr/rl/oh/oe
  // churn per poll), and feed/watch pages hold EVERY related video's URLs,
  // which the panel used to merge into every pill. The URL-level keys above
  // stay untouched (dedup map, sent tracking, all regression tests); the
  // presentation layer collapses and scopes on top of them instead.
  // Pure functions — test/facebook-panel.js extracts the SHIPPED definitions.

  /** Canonical path identity of a Facebook media object (query-immune). */
  function fbPathKey(u) {
    try {
      const x = new URL(String(u || ''));
      if (!FB_HOST_RE.test(x.hostname)) return null;
      return 'fbpath:' + fbCanonicalHost(x.hostname) + x.pathname;
    } catch (e) { return null; }
  }

  /** Stable rendition tag of a Facebook URL ('' when absent/unparseable). */
  function fbEfgTagOfUrl(u) {
    try {
      const efg = new URL(String(u || '')).searchParams.get('efg');
      return fbEfgTag(efg) || '';
    } catch (e) { return ''; }
  }

  /**
   * Presentation collapse key: same canonical path + rendition tag +
   * quality + resolution + size. Rotated tokens (vabr/rl/oh/oe/…) never
   * split rows; genuinely different renditions still differ in at least one
   * of tag/quality/resolution/size. Non-Facebook URLs keep exact-key
   * semantics so other sites' behavior cannot change.
   */
  function collapseRowKey(v) {
    const url = String((v && v.url) || '');
    if (!fbPathKey(url)) return 'u:' + (normalizeStreamUrl(url) || url);
    const q = (v && v.quality && v.quality !== 'unknown') ? v.quality : '?';
    const res = (v && v.resolution) || '?';
    const size = (v && v.size) || '?';
    return fbPathKey(url) + '|' + fbEfgTagOfUrl(url) + '|' + q + '|' + res + '|' + size;
  }

  /** Merge a collapsed-away duplicate's known fields into the kept row. */
  function mergeRowInto(prev, v) {
    try {
      if (!prev || !v) return;
      if (!prev.filename && v.filename) prev.filename = v.filename;
      if (!prev.size && v.size) prev.size = v.size;
      if ((!prev.quality || prev.quality === 'unknown') && v.quality && v.quality !== 'unknown') {
        prev.quality = v.quality;
        if (v.resolution) prev.resolution = v.resolution;
      }
      if (!prev.resolution && v.resolution) prev.resolution = v.resolution;
    } catch (e) {}
  }

  function isFacebookPage() {
    try { return FB_HOST_RE.test(location.hostname); }
    catch (e) { return false; }
  }

  /**
   * Canonical paths of THIS video element's own files (own src/sources, with
   * blob: URLs resolved through the interceptor's blob→real map). Empty when
   * unattributable — callers must then fall back to the global list so the
   * panel never strands the user.
   */
  function elementFilePaths(video) {
    const out = new Set();
    try {
      const urls = [];
      if (video) {
        if (video.currentSrc) urls.push(video.currentSrc);
        if (video.src) urls.push(video.src);
        video.querySelectorAll('source').forEach(s => {
          urls.push(s.src || (s.getAttribute && s.getAttribute('src')));
        });
      }
      for (let u of urls) {
        if (!u || typeof u !== 'string') continue;
        if (u.startsWith('blob:')) u = blobToRealUrlMap.get(u) || null;
        if (u && /^https?:/i.test(u)) {
          const k = fbPathKey(u);
          if (k) out.add(k);
        }
      }
    } catch (e) {}
    return out;
  }

  /**
   * Scope gate for one candidate URL against an attribution set (null/empty
   * set = unattributable = allow everything). Non-Facebook URLs always pass:
   * scoping only ever narrows Facebook rows.
   */
  function fbScopeAllows(url, scope) {
    if (!scope || !scope.size) return true;
    const k = fbPathKey(url);
    if (!k) return true;
    return scope.has(k);
  }

  /**
   * Not-a-video verdict for a capsule candidate. Pills belong to <video>
   * elements only, so an audio-typed response (DASH audio slices served as
   * .mp4, preview clips) can never be the requested download — yet such
   * files complete "successfully" and look exactly like "downloaded but no
   * video". Returns 'audio' | 'preview' | null (keep).
   * o: { contentType, probed, hasVideo, durationSec, sizeBytes }
   * Pure function — test/facebook-junk.js asserts parity across the copies.
   */
  function dropVideoCandidate(o) {
    const ct = String((o && o.contentType) || '');
    if (/^audio\//i.test(ct)) return 'audio';
    if (o && o.probed) {
      if (!o.hasVideo) return 'audio';
      const dur = Number(o.durationSec) || 0;
      const size = Number(o.sizeBytes) || 0;
      if (dur > 0 && dur < 2 && size > 0 && size < 1048576) return 'preview';
    }
    return null;
  }
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

  // ── Page-HTML media extraction (KVS watch pages: Nubiles et al.) ──────
  // yt-dlp's NubilesPorn extractor parses the HTML5 <video>/<source> markup
  // inside the `watch-page-video-wrapper` element. JS players usually replace
  // that markup after boot, so we read BOTH the live DOM region and a
  // credentials-included re-fetch of the raw page HTML. This is the reliable
  // detector for members.nubiles-porn.com watch pages, whose player never
  // exposes a plain <video src> to the normal page scan.

  const WATCH_WRAPPER_SEL = '[class*="watch-page-video"], [id*="watch-page-video"]';
  const MEDIA_URL_EXT_RE = /\.(mp4|m4v|webm|mkv|mov|m3u8|mpd|ts|m4s)(\?|#|$)/i;
  // Fonts, scripts, stylesheets, subtitles and similar page assets are NOT
  // "downloadable media". Images ARE — they are handled by IMAGE_EXT above.
  const NON_MEDIA_EXT_RE = /\.(css|js|json|xml|vtt|srt|woff2?|ttf|eot)(\?|#|$)/i;
  const AD_URL_RE = /doubleclick|googlesyndication|googleads|adservice|adsystem|analytics|tracking|beacon|pixel|prebid|taboola|outbrain/i;

  /** Loose unescape for JSON-in-HTML / JS-literal embedded URLs. */
  function unescapeLoose(s) {
    return String(s == null ? '' : s)
      .replace(/\\u002[fF]/g, '/')
      .replace(/\\u003[aA]/g, ':')
      .replace(/\\u003[dD]/g, '=')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');
  }

  /** True when a URL is a plausible downloadable media resource for this page. */
  function isPageMediaUrl(u) {
    if (!u || !/^https?:/i.test(u)) return false;
    if (AD_URL_RE.test(u)) return false;
    if (NON_MEDIA_EXT_RE.test(u)) return false;
    if (MEDIA_URL_EXT_RE.test(u)) return true;
    if (IMAGE_EXT.test(u)) return true;
    // KVS direct-download endpoints carry no file extension at all
    return /\/(?:get_file|dwnl)\/|\/hls\/|\/mp4\//i.test(u);
  }

  /** Same-site check: page host, one of its subdomains, or shared eTLD+1. */
  function isSameSiteHost(u) {
    try {
      const h = new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
      const p = location.hostname.replace(/^www\./i, '').toLowerCase();
      if (!h || !p) return false;
      if (h === p || h.endsWith('.' + p) || p.endsWith('.' + h)) return true;
      const l2 = x => x.split('.').slice(-2).join('.');
      return l2(h) === l2(p);
    } catch (e) { return false; }
  }

  /** Mine absolute, protocol-relative and root-relative media URLs from HTML/JS. */
  function mediaUrlsFromHtml(html, baseUrl) {
    const out = new Set();
    if (!html) return out;
    const text = unescapeLoose(html);
    const absRe = /(?:https?:)?\/\/[^\s"'<>\\`{}]+/gi;
    let m;
    while ((m = absRe.exec(text)) !== null) {
      let u = m[0].replace(/[),.;]+$/, '');
      if (u.startsWith('//')) u = location.protocol + u;
      if (!isSameSiteHost(u) && !MEDIA_URL_EXT_RE.test(u) && !IMAGE_EXT.test(u)) continue;
      if (isPageMediaUrl(u)) out.add(u);
    }
    const relRe = /["'(=\s](\/[^\s"'<>\\]*?(?:get_file|dwnl)\/[^\s"'<>\\]*)/gi;
    while ((m = relRe.exec(text)) !== null) {
      try {
        const u = new URL(m[1], baseUrl || location.href).href;
        if (isPageMediaUrl(u)) out.add(u);
      } catch (e) {}
    }
    const relExtRe = /["'(=\s](\/[^\s"'<>\\]*?\.(?:mp4|m4v|webm|mkv|mov|m3u8|mpd)(?:\?[^\s"'<>\\]*)?)/gi;
    while ((m = relExtRe.exec(text)) !== null) {
      try {
        const u = new URL(m[1], baseUrl || location.href).href;
        if (isPageMediaUrl(u)) out.add(u);
      } catch (e) {}
    }
    return out;
  }

  /** Collect media URLs (with quality hints) from one live DOM region. */
  function mediaUrlsFromDomRoot(root) {
    const out = new Map(); // url -> quality hint ("1080p") or null
    if (!root || !root.querySelectorAll) return out;
    const nodes = [root, ...root.querySelectorAll(
      'video, source, a, [src], [href], [data-src], [data-url], [data-href], ' +
      '[data-file], [data-video], [data-video-url], [data-download-url], [data-hd], [data-sd]'
    )];
    for (const el of nodes) {
      let hint = null;
      for (const attr of el.attributes || []) {
        if (/^(?:label|title|data-quality|data-res|data-resolution|data-label)$/.test(attr.name.toLowerCase())) {
          const qm = String(attr.value).match(/(\d{3,4})\s*p/i);
          if (qm) { hint = qm[1] + 'p'; break; }
        }
      }
      for (const attr of el.attributes || []) {
        const name = attr.name.toLowerCase();
        if (!/^(?:src|href|data-|style)$/.test(name)) continue;
        const val = attr.value || '';
        if (!val || val.length > 4096) continue;
        for (const u of mediaUrlsFromHtml(val, location.href)) {
          if (!out.has(u)) out.set(u, hint);
        }
      }
    }
    return out;
  }

  /** Sync pass over the live `watch-page-video-wrapper` region(s). */
  function extractPageHtmlMediaSync() {
    const found = new Map(); // url -> hint
    const regions = [];
    document.querySelectorAll(WATCH_WRAPPER_SEL).forEach(el => regions.push(el));
    document.querySelectorAll('video').forEach(v => { if (v.parentElement) regions.push(v.parentElement); });
    for (const r of regions) {
      for (const [u, hint] of mediaUrlsFromDomRoot(r)) {
        if (!found.has(u)) found.set(u, hint);
      }
    }
    const out = [];
    for (const [u, hint] of found) {
      const info = detectQuality(u, null);
      if (hint) {
        if (!info.quality || info.quality === 'unknown') info.quality = hint;
        if (!info.resolution && QUALITY_MAP[hint]) info.resolution = QUALITY_MAP[hint].resolution;
      }
      info.source = 'page-html';
      out.push(info);
    }
    return out;
  }

  // Async half: re-fetch the raw page (credentials included) and mine the
  // wrapper region exactly like yt-dlp does. Capped at 2 fetches per page URL.
  const pageHtmlFetches = new Map(); // href -> count
  let pageHtmlRefreshInFlight = null;

  async function fetchPageHtmlMedia() {
    const pageKey = location.href;
    const count = pageHtmlFetches.get(pageKey) || 0;
    if (count >= 2) return [];
    pageHtmlFetches.set(pageKey, count + 1);
    try {
      let html = '';
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        const res = await fetch(pageKey, { credentials: 'include', cache: 'force-cache', signal: ctrl.signal });
        clearTimeout(timer);
        if (res && res.ok) html = await res.text();
      } catch (e) { /* CSP / offline — DOM fallback below */ }
      if (!html) {
        try { html = document.documentElement.outerHTML || ''; } catch (e) { html = ''; }
      }
      if (!html || !/<video|<source|\.mp4|\.m3u8|watch-page-video/i.test(html)) return [];
      let scope = html;
      const i = html.indexOf('watch-page-video-wrapper');
      if (i >= 0) scope = html.slice(i, i + 30000);
      let urls = mediaUrlsFromHtml(scope, pageKey);
      if (!urls.size && scope !== html) urls = mediaUrlsFromHtml(html, pageKey);
      const out = [];
      for (const u of urls) {
        const info = detectQuality(u, null);
        info.source = 'page-html';
        out.push(info);
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  /** Merge extracted info objects into the registry; returns how many are new. */
  function mergePageHtmlMedia(list) {
    let added = 0;
    for (const v of list || []) {
      if (!v || !v.url || isSegmentUrl(v.url)) continue;
      try {
        if (addDetectedVideo(v.url, v)) added++;
      } catch (e) {
        if (!detectedVideos.has(v.url)) { detectedVideos.set(v.url, v); added++; }
      }
    }
    return added;
  }

  /** Fire-and-forget refresh; rebuilds an open capsule when new rows land. */
  function refreshPageHtmlMedia() {
    if (pageHtmlRefreshInFlight) return pageHtmlRefreshInFlight;
    pageHtmlRefreshInFlight = fetchPageHtmlMedia()
      .then((list) => {
        pageHtmlRefreshInFlight = null;
        const added = mergePageHtmlMedia(list);
        if (added) {
          scheduleSyncCapsules();
          refreshOpenPanel();
        }
        return added;
      })
      .catch(() => { pageHtmlRefreshInFlight = null; return 0; });
    return pageHtmlRefreshInFlight;
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
    if (isSegmentUrl(url)) return false;
    // Images are never downloadable video — reject early
    if (IMAGE_EXT.test(url)) return false;
    if (VIDEO_EXT.test(url) || STREAM_EXT.test(url) || AUDIO_EXT.test(url)) return true;
    if (XTREAM_RE.test(url)) return true;
    if (isFacebookVideoUrl(url)) return true;
    // Generic video hosts — but not if it's clearly an image
    if (VIDEO_HOSTS.some(p => p.test(url)) && !IMAGE_EXT.test(url)) return true;
    if (/videoplayback|\/get_file\/|\/hls\/|\/dash\/|\/mp4\//i.test(url)) return true;
    return false;
  }

  // ── Listen to MAIN world interceptor (interceptor.js) ────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'aidm-interceptor') return;
    const { type, url, blobUrl, sources, filename } = event.data;

    if (type === 'media-url' && url) {
      if (isSegmentUrl(url)) return;
      // Twitter/X: encrypted HLS playlists are never downloadable — the direct
      // MP4 variants arrive separately via the GraphQL extractor. Dropping the
      // playlists here keeps one playing video from becoming 100+ rows.
      if (isTwitterPlaylistUrl(url)) return;
      if (TWIMG_RE.test(url) && !isTwitterMp4Url(url)) return;
      if (!interceptedMediaUrls.has(url)) {
        // Normalized dedup: rotated CDN signatures are the same file.
        const nUrl = normalizeStreamUrl(url);
        let dup = false;
        if (nUrl) {
          for (const u of interceptedMediaUrls) {
            if (normalizeStreamUrl(u) === nUrl) { dup = true; break; }
          }
        }
        if (!dup) interceptedMediaUrls.add(url);
        const info = detectQuality(url, null);
        addDetectedVideo(url, info);
        // NOTE: do NOT forward to the desktop here. Passive detection used to
        // fire `videos-with-quality` on every page, which popped the quality
        // picker on YouTube and every other site. The capsule panel and the
        // extension popup read `detectedVideos` on demand instead.
        // If a video element is currently playing with blob:, map it
        document.querySelectorAll('video').forEach(v => {
          if (isPlayingVideo(v) && v.currentSrc && v.currentSrc.startsWith('blob:')) {
            blobToRealUrlMap.set(v.currentSrc, url);
          }
        });
        scheduleSyncCapsules();
      }
    } else if (type === 'player-sources' && Array.isArray(sources)) {
      sources.forEach(s => {
        if (s && s.url && !isSegmentUrl(s.url) && !isTwitterPlaylistUrl(s.url)) {
          const info = detectQuality(s.url, null);
          if (s.label) info.quality = s.label;
          addDetectedVideo(s.url, info);
        }
      });
      scheduleSyncCapsules();
    } else if (type === 'download-link' && url) {
      // The browser would have downloaded this natively (captured in
      // interceptor.js). Merge it with the filename the link intends so the
      // capsule/popup offer the exact file the site itself would save.
      if (isSegmentUrl(url)) return;
      const info = detectedVideos.get(url) || detectQuality(url, null);
      if (filename) info.filename = filename;
      if (!info.source) info.source = 'download-link';
      addDetectedVideo(url, info);
      // Ensure the merged filename survives a normalized-dedup merge.
      try {
        const n = normalizeStreamUrl(url);
        if (n) {
          for (const [k, v] of detectedVideos) {
            if (normalizeStreamUrl(k) === n && filename && !v.filename) v.filename = filename;
          }
        }
      } catch (e) {}
      scheduleSyncCapsules();
    } else if (type === 'mse-blob' && blobUrl) {
      mseBlobUrls.add(blobUrl);
      scheduleSyncCapsules();
    } else if (type === 'twitter-variants' && event.data) {
      // Attributed variant sets straight out of the tweet's own GraphQL JSON:
      // { tweetId, urls[] }. Powers per-video scoping on timelines.
      try {
        const added = noteTwitterVariants(event.data.tweetId, event.data.urls);
        if (added) {
          (event.data.urls || []).forEach(u => {
            if (u && /^https?:/i.test(u) && !isSegmentUrl(u) && isTwitterMp4Url(u)) {
              addDetectedVideo(u, detectQuality(u, null));
            }
          });
          scheduleSyncCapsules();
          refreshOpenPanel();
        }
      } catch (e) {}
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

    // KVS-style CDN paths encode the rendition in the FILENAME: …/pubs/<id>/1080.mp4.
    // Without this, the player's REAL variants show up as unlabeled "VIDEO ·
    // unknown size" rows while the (often expired) static page links get the
    // nice labels — so users click the dead one.
    if (info.quality === 'unknown') {
      const pathQ = url.match(/\/(\d{3,4})\.(?:mp4|m4v|mkv|webm|mov)(?:[?#]|$)/i);
      if (pathQ) {
        const label = parseInt(pathQ[1], 10) + 'p';
        info.quality = label;
        if (QUALITY_MAP[label]) info.resolution = QUALITY_MAP[label].resolution;
      }
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
          // Do NOT stamp the playing element's intrinsic size onto every
          // candidate. One <video> exposes several <source> variants (360p /
          // 720p / 1080p); giving them all video.videoWidth produced N rows
          // with one identical resolution — the bug where "every downloadable
          // video shows the same dimension". Worse, on a DASH/MSE player
          // videoWidth is the CURRENT rendition, which changes as it adapts.
          // Only fill in when the URL yielded nothing AND this candidate is
          // what the element is actually playing. Otherwise leave it unknown:
          // the desktop app proves real geometry from the file (media-probe).
          if (!info.resolution && video.videoWidth && video.videoHeight &&
              srcUrl === video.currentSrc) {
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
      if (!url || isSegmentUrl(url)) return;
      // Twitter/X: skip encrypted HLS playlists (player polls ?tag=… variants
      // of the same /pu/pl/ playlist — each looks like a new video).
      if (isTwitterPlaylistUrl(url)) return;
      // Twitter/X thumbnails/avatars (pbs.twimg.com …jpg) are not videos — the
      // blanket twimg host match below must not promote them into video rows.
      if (TWIMG_RE.test(url) && !isTwitterMp4Url(url) &&
          !/\.(m3u8|mpd)(\?|#|$)/i.test(url) &&
          !/\.(mp4|m4v|webm|mkv|mov)(\?|#|$)/i.test(url) &&
          !/\/(vid|pl)\/|ext_tw_video|amplify_video/i.test(url)) return;
      if (VIDEO_EXT.test(url) || STREAM_EXT.test(url) || XTREAM_RE.test(url) ||
          VIDEO_HOSTS.some(p => p.test(url)) || isFacebookVideoUrl(url)) {
        const info = detectQuality(url, null);
        // Performance API gives us transfer size
        if (entry.transferSize > 0) info.size = entry.transferSize;
        videos.push(info);
      }
    });

    return videos;
  }

  // ── Facebook / Instagram playable URLs ─────────────────────────────────────
  // Facebook hides the progressive MP4 in page JSON (`playable_url`,
  // `playable_url_quality_hd`, `browser_native_hd/sd_url`, `hd_src/sd_src`)
  // instead of a plain <video src>. The player itself runs on blob:+MSE with
  // extensionless fbcdn requests, so without this extractor there is nothing
  // to offer and the capsule never appears on facebook.com.
  function extractFacebookVideos() {
    const out = [];
    if (!FB_HOST_RE.test(location.hostname) && !/facebook|instagram/i.test(location.hostname)) {
      // Still scan — embeds (facebook.com/plugins/video.php) live on any host.
    }
    try {
      const chunks = [];
      document.querySelectorAll('script:not([src])').forEach(s => {
        const t = s.textContent || '';
        if (t.length > 20 && /playable_url|browser_native|hd_src|sd_src|fbcdn/i.test(t)) chunks.push(t);
      });
      try {
        const html = document.documentElement ? document.documentElement.innerHTML || '' : '';
        if (/playable_url|browser_native/i.test(html)) chunks.push(html.slice(0, 500000));
      } catch (e) {}
      const text = chunks.join('\n');
      if (!text) return out;
      const clean = (s) => String(s || '')
        .replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=')
        .replace(/\\"/g, '"').replace(/&amp;/g, '&');
      const pushUrl = (u, quality) => {
        if (!u) return;
        u = clean(u).replace(/[",);\\]+$/, '');
        if (!/^https?:/i.test(u)) return;
        if (isSegmentUrl(u)) return;
        if (!isFacebookVideoUrl(u) && !looksLikeMedia(u)) return;
        try { u = stripFbRange(u); } catch {}
        const info = detectQuality(u, null);
        if (quality && QUALITY_MAP[quality]) {
          info.quality = quality;
          info.resolution = QUALITY_MAP[quality].resolution;
        }
        info.source = 'facebook';
        out.push(info);
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
      ];
      for (const [re, quality] of pats) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) pushUrl(m[1], quality);
      }
      // Generic fallback: any fbcdn …mp4 in the page JSON.
      const fbMp4 = /https?:\\?\/\\?\/[^"'\\\s<>]*?fbcdn[^"'\\\s<>]*?\.mp4[^"'\\\s<>]*/gi;
      let m2;
      while ((m2 = fbMp4.exec(text)) !== null) pushUrl(m2[0], null);
    } catch (e) {}
    return out;
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
            VIDEO_EXT.test(resolved) || STREAM_EXT.test(resolved) || XTREAM_RE.test(resolved) ||
            IMAGE_EXT.test(resolved)) {
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
    const track = (v) => {
      if (!v || !v.url || isSegmentUrl(v.url)) return;
      if (addDetectedVideo(v.url, v)) allVideos.push(v);
    };

    // 1. Video elements
    scanVideoElements().forEach(track);

    // 2. Quality selectors
    scanQualitySelectors().forEach(track);

    // 3. Network resources
    scanNetworkResources().forEach(track);

    // 4. Download links
    scanLinks();

    // 5. KVS player flashvars (Nubiles, BustyAR, PetitesRDS, etc.)
    extractKvsFlashvars().forEach(track);

    // 6. OpenGraph and Twitter meta tags
    scanOGAndMetaTags().forEach(track);

    // 7. Schema.org JSON-LD VideoObjects
    scanJsonLd().forEach(track);

    // 7b. Facebook / Instagram playable URLs (blob+MSE pages have no <video src>)
    try { extractFacebookVideos().forEach(track); } catch (e) {}

    // 8. Request MAIN-world player extraction (JWPlayer, Video.js, etc.)
    requestPlayerExtraction();

    // 9. Page HTML — KVS watch-page wrapper (members.nubiles-porn.com …).
    //    The player markup ships inside `watch-page-video-wrapper`; JS players
    //    usually replace it before a plain <video src> is observable, so the
    //    raw page HTML is re-fetched in the background (async) as well.
    extractPageHtmlMediaSync().forEach(v => {
      if (!v || !v.url || isSegmentUrl(v.url)) return;
      if (addDetectedVideo(v.url, v)) allVideos.push(v);
    });
    refreshPageHtmlMedia();

    // Do NOT auto-forward to the desktop — that pops the quality picker on
    // every page load. The capsule panel and extension popup read
    // `detectedVideos` on demand. Explicit user actions (popup "Grab Video",
    // capsule Download) send their own targeted messages.
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

    if (msg.action === 'grab-site') {
      // Site grabber: crawl same-origin pages, then hand matches to the
      // normal batch flow (the desktop dedups against existing rows).
      grabSite(msg.opts || {}).then(
        (result) => {
          const urls = (result.files || []).slice(0, 200);
          if (!urls.length) {
            sendResponse({ success: true, count: 0, pages: result.pages || 0 });
            return;
          }
          chrome.runtime.sendMessage({ action: 'batch-download', urls }, () => {
            sendResponse({ success: true, count: urls.length, pages: result.pages || 0 });
          });
        },
        (err) => sendResponse({ success: false, message: String((err && err.message) || err) })
      );
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

  // ── Takeover hotkey tracker (v4.3.0, original AiDM implementation) ─────────
  // Reports Alt (let the browser handle it) and the configured
  // force-takeover key to the background, which gates automatic download
  // interception. Explicit capsule/popup clicks are never affected.
  let forceTakeoverKey = 'Shift';
  const keysDown = new Set();
  function refreshForceKey() {
    try {
      chrome.runtime.sendMessage({ action: 'get-settings' }, (resp) => {
        if (resp && resp.forceTakeoverKey) forceTakeoverKey = String(resp.forceTakeoverKey);
      });
    } catch (e) { /* background unreachable — keep the default */ }
  }
  function reportKeyState() {
    try {
      chrome.runtime.sendMessage({
        action: 'key-state',
        prevent: keysDown.has('Alt') || keysDown.has('AltGraph'),
        force: !!forceTakeoverKey && keysDown.has(forceTakeoverKey),
      });
    } catch (e) { /* background unreachable — interception falls back safely */ }
  }
  function trackKey(e, down) {
    const k = e && e.key;
    if (!k) return;
    if (k === 'Alt' || k === 'AltGraph' || (!!forceTakeoverKey && k === forceTakeoverKey)) {
      if (down) keysDown.add(k); else keysDown.delete(k);
      reportKeyState();
    }
  }
  try {
    window.addEventListener('keydown', (e) => trackKey(e, true), true);
    window.addEventListener('keyup', (e) => trackKey(e, false), true);
    window.addEventListener('blur', () => { if (keysDown.size) { keysDown.clear(); reportKeyState(); } }, true);
    refreshForceKey();
    setInterval(refreshForceKey, 60000);
  } catch (e) { /* event API unavailable */ }

  // ── Site grabber (v4.3.0, original AiDM implementation) ───────────────────
  // Same-origin crawl from this page: collects downloadable file links up to
  // `depth` hops away, filtered by extension. Runs in-page (same-origin
  // fetches have no CORS issues) and hands matches to the normal batch flow.
  // Pure helpers (grabFilter, anchorUrlsFromHtml) are regression-tested by
  // extracting the SHIPPED definitions in test/grabber.js.

  // Default capture set when the user gives no explicit filter.
  const GRABBER_DEFAULT_EXTS = new Set([
    'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'ts',
    'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus', 'wma',
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'epub',
    'exe', 'msi', 'apk', 'dmg',
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg',
  ]);

  /** True when the URL is a downloadable file (optionally restricted to `types`). */
  function grabFilter(url, types) {
    if (!url || typeof url !== 'string' || !/^https?:/i.test(url)) return false;
    let ext = '';
    try {
      const pathname = new URL(url).pathname;
      const parts = pathname.split('/').filter(Boolean);
      const base = parts.length ? decodeURIComponent(parts.pop()) : '';
      const m = /\.([A-Za-z0-9]{2,5})$/.exec(base);
      if (m) ext = m[1].toLowerCase();
    } catch (e) { return false; }
    // Pages, scripts and styles are crawl targets, never downloads.
    if (!ext || /^(html?|php|asp|aspx|jsp|jspx|do|cgi|pl|js|css|json|xml)$/i.test(ext)) return false;
    if (Array.isArray(types) && types.length) {
      const want = new Set(types.map(t => String(t).toLowerCase().replace(/^\.+/, '')));
      return want.has(ext);
    }
    return GRABBER_DEFAULT_EXTS.has(ext);
  }

  /** All http(s) anchor targets in an HTML document, resolved + deduped. */
  function anchorUrlsFromHtml(html, baseUrl) {
    const out = new Set();
    if (!html) return out;
    const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>`]+))/gi;
    let m;
    while ((m = re.exec(String(html))) !== null) {
      const raw = (m[1] || m[2] || m[3] || '').trim();
      if (!raw || raw.startsWith('#')) continue;
      if (/^(javascript|mailto|tel|data|blob|ftp):/i.test(raw)) continue;
      try {
        const href = new URL(raw, baseUrl || location.href).href;
        if (/^https?:/i.test(href)) out.add(href.split('#')[0]);
      } catch (e) { /* unresolvable href — skip */ }
    }
    return out;
  }

  /**
   * Crawl same-origin pages breadth-first from here.
   * @returns {Promise<{files: string[], pages: number}>}
   */
  async function grabSite(opts) {
    const o = opts || {};
    const maxDepth = Math.max(0, Math.min(parseInt(o.depth, 10) || 1, 2));
    const maxPages = Math.max(1, Math.min(parseInt(o.maxPages, 10) || 20, 50));
    const types = Array.isArray(o.types) && o.types.length ? o.types : null;
    let origin = '';
    try { origin = location.origin; } catch (e) { return { files: [], pages: 0 }; }
    const seen = new Set();
    const files = new Set();
    const queue = [{ url: location.href.split('#')[0], depth: 0 }];
    const deadline = Date.now() + 60000;
    while (queue.length && seen.size < maxPages && Date.now() < deadline) {
      const { url, depth } = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      let html = '';
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        let res;
        try {
          res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        const ct = (res.headers.get('Content-Type') || '').toLowerCase();
        if (!res.ok || (ct && ct.indexOf('html') < 0)) continue;
        html = await res.text();
        if (html.length > 2 * 1024 * 1024) html = html.slice(0, 2 * 1024 * 1024);
      } catch (e) { continue; }
      for (const link of anchorUrlsFromHtml(html, url)) {
        if (grabFilter(link, types)) {
          files.add(link);
          if (files.size >= 200) return { files: Array.from(files), pages: seen.size };
        } else if (depth < maxDepth) {
          try {
            const u = new URL(link);
            if (u.origin === origin && !seen.has(link)) queue.push({ url: link, depth: depth + 1 });
          } catch (e) { /* skip */ }
        }
      }
    }
    return { files: Array.from(files), pages: seen.size };
  }

  const CAP_MIN_W = 120, CAP_MIN_H = 68;
  const capsuleState = new WeakMap(); // video -> { wrap, count, panel, btn }
  const capsuleVideos = new Set();    // videos that own a capsule (for orphan cleanup)
  const dragOffsets = new WeakMap();  // video -> { dx, dy }
  const activeDrags = new WeakMap();  // video -> endDrag() of the in-flight gesture (single-flight)

  /**
   * Park a pill anchor anywhere inside the viewport. The pill hangs LEFT of
   * its anchor via translateX(-100%), so minX reserves its own width; the
   * point is only ever clamped to the viewport — never to the player — so a
   * dragged pill stays exactly where it was dropped. Pure function;
   * test/capsule.js extracts and exercises the SHIPPED definition.
   */
  function clampCapsulePos(anchorX, anchorY, vw, vh) {
    const minX = 150;
    const maxX = Math.max(minX, (vw || 0) - 8);
    const minY = 8;
    const maxY = Math.max(minY, (vh || 0) - 40);
    return {
      x: Math.max(minX, Math.min(maxX, anchorX)),
      y: Math.max(minY, Math.min(maxY, anchorY)),
    };
  }
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
      text-shadow: 0 1px 2px rgba(10,40,90,.45);
      background: linear-gradient(135deg, rgba(74,157,234,.78) 0%, rgba(26,92,176,.78) 55%, rgba(15,60,130,.82) 100%);
      -webkit-backdrop-filter: blur(12px) saturate(1.6);
      backdrop-filter: blur(12px) saturate(1.6);
      border: 1px solid rgba(255,255,255,.38);
      border-radius: 999px;
      padding: 5px 12px 5px 9px;
      cursor: grab;
      touch-action: none;
      box-shadow: 0 8px 24px rgba(15,77,168,.38),
        inset 0 1px 0 rgba(255,255,255,.5),
        inset 0 -2px 4px rgba(8,30,70,.25);
      white-space: nowrap;
      box-sizing: border-box;
      transition: background 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
    }
    .aidm-cap-btn:active { cursor: grabbing; }
    .aidm-cap-btn:hover {
      background: linear-gradient(135deg, rgba(90,168,244,.85) 0%, rgba(36,112,196,.85) 55%, rgba(20,72,150,.88) 100%);
      transform: translateY(-1px);
      box-shadow: 0 12px 28px rgba(15,77,168,.45),
        inset 0 1px 0 rgba(255,255,255,.55),
        inset 0 -2px 4px rgba(8,30,70,.25);
    }
    .aidm-cap-btn.aidm-dragging {
      cursor: grabbing;
      transform: scale(1.06);
      box-shadow: 0 16px 36px rgba(15,77,168,.55),
        inset 0 1px 0 rgba(255,255,255,.6),
        inset 0 -2px 4px rgba(8,30,70,.25);
    }
    .aidm-cap-btn .aidm-cap-logo {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: rgba(255,255,255,.92);
      color: #1a5cb0;
      font-size: 10px;
      font-weight: 700;
      box-shadow: inset 0 -1px 2px rgba(15,77,168,.25), 0 1px 2px rgba(8,30,70,.3);
    }
    .aidm-cap-btn .aidm-cap-n {
      display: none;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 8px;
      background: rgba(255,210,62,.95);
      color: #1a2b4a;
      font-size: 10px;
      font-weight: 700;
      box-shadow: inset 0 -1px 2px rgba(120,70,0,.3), 0 1px 2px rgba(8,30,70,.3);
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
    .aidm-cap-sep {
      padding: 6px 10px 4px;
      font-size: 10px;
      font-weight: 700;
      color: #7a8ba3;
      text-transform: uppercase;
      letter-spacing: .4px;
      background: #f1f5f9;
      border-top: 1px solid #e4edf9;
      border-bottom: 1px solid #e4edf9;
    }
    .aidm-cap-dashlock { opacity: .9; }
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

  /**
   * Look up sniffed response metadata (real filename from Content-Disposition,
   * exact Content-Length) captured by the background webRequest listener.
   * Matches the exact URL first, then token-insensitively.
   */
  function urlMeta(pd, url) {
    if (!pd || !pd.meta || !url) return null;
    if (pd.meta[url]) return pd.meta[url];
    const n = normalizeStreamUrl(url);
    if (!n) return null;
    for (const [k, v] of Object.entries(pd.meta)) {
      if (normalizeStreamUrl(k) === n) return v;
    }
    return null;
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

  // ── Real video titles (never hostnames) ────────────────────────────────────
  // mydaddy.cc-style players run inside an embed/alt-player iframe whose
  // document has no <title> at all. The old fallback returned
  // location.hostname, so every download from such a page was named
  // "mydaddy.cc [1080p].mp4" — a name that identifies no video. A bare
  // hostname (or any other placeholder) is NEVER a real title.
  // Pure logic mirrors aidm/src/titles.js — keep the two in sync.
  function looksLikeHostname(s) {
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(s || '').trim());
  }
  const GENERIC_TITLE_RE = /^(video|watch|play|player|home|index|untitled|download|downloads|media|clip|embed|empty|blank|no\s*title)$/i;
  function isRealTitle(t, hostname) {
    const s = String(t == null ? '' : t).trim().replace(/\s+/g, ' ');
    if (!s || s.length < 2) return false;
    const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
    if (host && s.toLowerCase() === host) return false;
    if (looksLikeHostname(s)) return false;
    if (GENERIC_TITLE_RE.test(s)) return false;
    // A bare domain with an affix ("mydaddy.cc - Home", "Home | mydaddy.cc")
    // is still not a title.
    const core = s
      .replace(/\s*[-|–—:|]\s*[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*$/i, '')
      .replace(/^[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*[-|–—:|]\s*/i, '')
      .trim();
    if (!core) return false;
    if (looksLikeHostname(core)) return false;
    if (GENERIC_TITLE_RE.test(core)) return false;
    return true;
  }
  function cleanPageTitle(raw, hostname) {
    let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!s) return null;
    s = s.replace(/\s*[-|–—:|]\s*(YouTube|Facebook|Vimeo|Dailymotion|Twitch).*/i, '').trim();
    s = s.replace(/\s*[-|–—:|]\s*[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*$/i, '').trim();
    if (!isRealTitle(s, hostname)) return null;
    return s.slice(0, 100);
  }
  // KVS flashvars carry the authoritative per-video title (video_title /
  // alt_video_title). Read it directly so iframe/alt-player pages — where
  // document.title is empty — still name the file after the video.
  function extractKvsTitle() {
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const text = s.textContent || '';
        if (text.length > 200000) continue;
        const m = text.match(/video_title\s*[:=]\s*['"]([^'"]{2,200})['"]/i) ||
                  text.match(/alt_video_title\s*[:=]\s*['"]([^'"]{2,200})['"]/i);
        if (m && isRealTitle(m[1], location.hostname)) return m[1].trim().replace(/\s+/g, ' ').slice(0, 100);
      }
    } catch (e) {}
    return null;
  }
  function extractJsonLdTitle() {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const sc of scripts) {
        let data = null;
        try { data = JSON.parse(sc.textContent || ''); } catch (e) { continue; }
        const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const item of items || []) {
          if (!item) continue;
          const type = item['@type'];
          const isVideo = type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'));
          if (isVideo && typeof item.name === 'string' && isRealTitle(item.name, location.hostname)) {
            return item.name.trim().replace(/\s+/g, ' ').slice(0, 100);
          }
        }
      }
    } catch (e) {}
    return null;
  }
  // Basenames that name the rendition/endpoint, not the file.
  function isGenericName(name, url) {
    const s = String(name || '').trim();
    if (!s) return true;
    let host = '';
    try { host = new URL(String(url || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) {}
    const stem = s.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    if (!stem) return true;
    const low = stem.toLowerCase();
    if (host && (low === host || low === host.replace(/^www\./, ''))) return true;
    if (looksLikeHostname(stem)) return true;
    if (/^\d{3,4}p?$/i.test(stem)) return true; // "1080", "1080p" rendition label
    if (/^(videoplayback|watch|video|play|index|download|media|get_file|dwnl|file|stream|content|player|embed)$/i.test(stem)) return true;
    if (/^download_\d+$/.test(stem)) return true;
    if (stem.length >= 12 && /^[0-9a-f]+$/i.test(stem)) return true; // CDN hash
    return false;
  }
  function specificUrlBasename(u) {
    try {
      const parts = new URL(String(u || '')).pathname.split('/').filter(Boolean);
      const base = decodeURIComponent(parts.pop() || '');
      if (!base || !/\.[A-Za-z0-9]{2,4}$/.test(base)) return null;
      if (isGenericName(base, u)) return null;
      return base;
    } catch (e) { return null; }
  }
  /** Best-effort real title for the playing video (per-video first). */
  function getVideoTitle(video) {
    let host = '';
    try { host = location.hostname; } catch (e) { host = ''; }
    try {
      const kvs = extractKvsTitle();
      if (kvs) return kvs;
    } catch (e) {}
    try {
      const ld = extractJsonLdTitle();
      if (ld) return ld;
    } catch (e) {}
    try {
      const vLabel = (video.getAttribute('title') || video.getAttribute('aria-label') || '').trim();
      // Generic player labels ("Video player", "Play video", X's "Embedded
      // video") are not real titles — fall through to the page title instead.
      if (vLabel && !/^(video|movie|media)\s*(player)?$/i.test(vLabel) && !/^play\b/i.test(vLabel) && !/^embedded?\s*videos?$/i.test(vLabel) && isRealTitle(vLabel, host)) return vLabel;
    } catch (e) {}
    try {
      const og = document.querySelector('meta[property="og:title"]') || document.querySelector('meta[name="twitter:title"]');
      if (og && og.content && isRealTitle(og.content, host)) {
        const cleaned = cleanPageTitle(og.content, host);
        if (cleaned) return cleaned;
      }
    } catch (e) {}
    try {
      const h1 = document.querySelector('h1');
      if (h1 && h1.textContent && isRealTitle(h1.textContent, host)) {
        return h1.textContent.trim().replace(/\s+/g, ' ').slice(0, 100);
      }
    } catch (e) {}
    try {
      const t = cleanPageTitle(document.title, host);
      if (t) return t;
    } catch (e) {}
    // No real title on this document (untitled embed/alt-player iframe, …).
    // Return a neutral placeholder — NEVER the hostname.
    return 'Video';
  }

  function sanitizeFilename(name, fallbackExt) {
    const clean = String(name || 'video').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video';
    return /\.\w{2,4}$/.test(clean) ? clean : clean + '.' + (fallbackExt || 'mp4');
  }

  /** Collect directly-downloadable variants for ONE video element. */
  function getVideoVariants(video) {
    const out = [];
    const seen = new Set(); // normalized URLs — same file, one row
    const push = (url, el) => {
      if (!url || isSegmentUrl(url)) return;
      // Twitter/X strict whitelist (see addDetectedVideo).
      if (TWIMG_RE.test(url) && !isTwitterMp4Url(url)) return;
      if (url.startsWith('blob:')) {
        const mapped = blobToRealUrlMap.get(url);
        if (mapped) push(mapped, el);
        return;
      }
      if (!/^https?:/i.test(url)) return;
      const n = normalizeStreamUrl(url) || url;
      if (seen.has(n) || seen.has(url)) return;
      seen.add(n);
      seen.add(url);
      const info = detectQuality(url, el);
      // Same rule as scanVideoElements(): the element's intrinsic size belongs
      // only to the variant it is currently playing. Stamping it on sibling
      // variants (or on an adaptive element mid-rendition-switch) is what made
      // every row in the picker report one identical resolution. Unknown is
      // better than wrong — the app resolves real geometry after download.
      let isCurrentSrc = false;
      try {
        isCurrentSrc = !!(video.currentSrc &&
          (normalizeStreamUrl(video.currentSrc) === n || video.currentSrc === url));
      } catch (e) { isCurrentSrc = false; }
      if (!info.resolution && isCurrentSrc && video.videoWidth && video.videoHeight) {
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
    // PLUS Facebook playable URLs and sniffed tab streams merged into detectedVideos.
    // (Facebook runs on blob:+MSE with no <video src> — without this the panel
    // is empty and the capsule looks broken.)
    // Twitter/X exception: never merge HLS playlists here — the blob-playing
    // <video> would otherwise inherit every playlist poll on the page (100+
    // identical rows). Direct MP4 variants (GraphQL extractor) still merge.
    // Feed scoping: on X timelines the page holds MANY tweets' videos, so a
    // blanket global merge puts every tweet into this pill. Prefer this
    // video's own scoped set (media-group → tweet → page-global MP4s).
    if (out.length === 0 && (isPlayingVideo(video) || isActuallyPlaying(video) || (video.currentSrc && video.currentSrc.startsWith('blob:')) || (video.src && video.src.startsWith('blob:')))) {
      if (isTwitterPage()) {
        const scoped = scopedTwitterUrls(video) || globalTwitterMp4s();
        scoped.forEach(u => { if (!isTwitterPlaylistUrl(u)) push(u, video); });
      } else {
        interceptedMediaUrls.forEach(u => { if (!isTwitterPlaylistUrl(u)) push(u, video); });
        try {
          detectedVideos.forEach(v => { if (v && v.url && !isTwitterPlaylistUrl(v.url)) push(v.url, video); });
        } catch (e) {}
      }
    }

    return out;
  }

  /**
   * Re-resolve the freshest playable URL for the same file at click time.
   * Signed CDN URLs expire within minutes: the row's URL may be stale while
   * the player already moved on to a re-signed one. The pure core
   * (pickFreshUrl) is regression-tested in test/browser-engine.js with an
   * injected normalizer.
   */
  function pickFreshUrl(candidates, fallbackUrl, normalize) {
    const norm = normalize || ((u) => u);
    if (!fallbackUrl) {
      for (const c of candidates || []) {
        if (c && /^https?:/i.test(c)) return c;
      }
      return null;
    }
    let target = fallbackUrl;
    try { target = norm(fallbackUrl) || fallbackUrl; } catch (e) { target = fallbackUrl; }
    for (const c of candidates || []) {
      if (!c || !/^https?:/i.test(c)) continue;
      try {
        if ((norm(c) || c) === target) return c;
      } catch (e) { /* unnormalizable candidate — skip */ }
    }
    return fallbackUrl;
  }

  /** This video element's current playable URLs, freshest first. */
  function currentVideoUrls(video) {
    const out = [];
    const push = (u) => {
      if (!u || typeof u !== 'string') return;
      let target = u;
      if (target.startsWith('blob:')) target = blobToRealUrlMap.get(target) || null;
      if (target && /^https?:/i.test(target) && !out.includes(target)) out.push(target);
    };
    try {
      if (video) {
        if (video.currentSrc) push(video.currentSrc);
        if (video.src) push(video.src);
        video.querySelectorAll('source').forEach(s => push(s.src || (s.getAttribute && s.getAttribute('src'))));
      }
    } catch (e) {}
    // Recent same-file network loads (player re-fetch with a fresh token).
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (let i = entries.length - 1; i >= 0 && out.length < 12; i--) {
        const name = entries[i] && entries[i].name;
        if (name && /^https?:/i.test(name) && !isSegmentUrl(name) && !out.includes(name)) out.push(name);
      }
    } catch (e) {}
    return out;
  }

  // ── True video dimensions via metadata probing ─────────────────────────────
  // Variant URLs don't always encode their rendition (Twitter amplify_video
  // links, bare CDN hashes): every such row then displays the PLAYING
  // element's size, so truly different dimensions all read identically.
  // Reading each file's own metadata (a cheap range request, CORS-free for
  // plain <video> loads) gives the real WxH per row. Pure gate
  // (needsMetaProbe) is regression-tested in test/row-accuracy.js.
  // True when this file's own dimensions still need probing: no authoritative
  // resolution came with the row, and the URL is a directly readable video.
  function needsMetaProbe(url, hasResolution) {
    if (hasResolution) return false;
    if (!url || typeof url !== 'string') return false;
    if (!/^https?:/i.test(url)) return false;
    if (/\.m3u8(\?|#|$)/i.test(url) || /\.mpd(\?|#|$)/i.test(url)) return false;
    return /\.(mp4|m4v|webm|mkv|mov|avi)(\?|#|$)/i.test(url);
  }

  const metaProbeCache = new Map(); // url -> Promise<{width,height,durationSec}|null>
  const META_PROBE_MAX_ROWS = 12; // per panel open; the cache dedupes globally
  function probeVideoMeta(url) {
    if (metaProbeCache.has(url)) return metaProbeCache.get(url);
    const p = new Promise((resolve) => {
      let done = false;
      const finish = (out) => { if (!done) { done = true; resolve(out); } };
      try {
        const el = document.createElement('video');
        el.preload = 'metadata';
        el.muted = true;
        const timer = setTimeout(() => {
          try { el.removeAttribute('src'); el.load(); } catch (e) {}
          finish(null);
        }, 8000);
        el.onloadedmetadata = () => {
          clearTimeout(timer);
          const w = el.videoWidth || 0, h = el.videoHeight || 0;
          let d = 0;
          try { d = Number(el.duration) || 0; } catch (e) {}
          try { el.removeAttribute('src'); el.load(); } catch (e) {}
          finish({ width: w, height: h, durationSec: Number.isFinite(d) ? d : 0 });
        };
        el.onerror = () => { clearTimeout(timer); finish(null); };
        el.src = url;
      } catch (e) { finish(null); }
    });
    metaProbeCache.set(url, p);
    if (metaProbeCache.size > 60) metaProbeCache.delete(metaProbeCache.keys().next().value);
    return p;
  }

  function hasBlobSource(video) {
    try {
      if (!video) return false;
      if (video.currentSrc && video.currentSrc.startsWith('blob:')) return true;
      if (video.src && video.src.startsWith('blob:')) return true;
    } catch (e) {}
    return false;
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

  // Audio-only HLS rendition playlists named by masters (EXT-X-MEDIA
  // TYPE=AUDIO): downloading one yields sound without picture, so they are
  // denied as candidates everywhere. Query-immune origin+path keys because
  // rendition URLs carry rotating tokens. Pure helpers — test/av-tracks.js.
  const audioPlaylistPaths = new Set();
  function noteAudioPlaylists(text, baseUrl) {
    try {
      const lines = String(text || '').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!/^#EXT-X-MEDIA/i.test(line)) continue;
        if (!/TYPE\s*=\s*AUDIO/i.test(line)) continue;
        const m = /URI\s*=\s*"([^"]+)"/i.exec(line);
        if (!m) continue;
        try {
          const u = new URL(m[1], baseUrl);
          audioPlaylistPaths.add(u.hostname.toLowerCase() + u.pathname);
          if (audioPlaylistPaths.size > 200) {
            audioPlaylistPaths.delete(audioPlaylistPaths.keys().next().value);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
  function isKnownAudioPlaylist(u) {
    try {
      const x = new URL(String(u || ''));
      return audioPlaylistPaths.has(x.hostname.toLowerCase() + x.pathname);
    } catch (e) { return false; }
  }

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
        // Remember audio-group playlists so directly-sniffed copies of them
        // are never offered as video downloads.
        try { noteAudioPlaylists(text, res.url || url); } catch (e) {}
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
        // `since` = this page load's navigation start. The background only
        // returns streams captured DURING the current page — without it, URLs
        // sniffed on a previous site in this same tab (kept for 10 min)
        // leaked into the panel and looked like a stuck/hardcoded download
        // link that always failed.
        chrome.runtime.sendMessage({ action: 'get-panel-data', since: Math.round(performance.timeOrigin) }, (resp) => {
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
    // End any in-flight drag first so its listeners never outlive the pill.
    try {
      const active = activeDrags.get(video);
      if (active) active(true);
    } catch (e) {}
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

    // Drag to move (click without drag toggles the panel).
    //
    // Sticky-pill hardening: ending a drag used to depend ONLY on `pointerup`
    // / `pointercancel` reaching `window` — but releasing outside the window
    // or frame, Alt+Tab mid-drag, or dragging out of an iframe document (the
    // hqporner/mydaddy embeds!) delivers neither, leaking the move listener
    // so the pill follows the cursor forever. Every exit below ends the drag:
    // pointerup, pointercancel, lostpointercapture, pointer leaving the
    // document, window blur, a button-less move (missed release), and Escape.
    // Pointer capture keeps move/up events flowing to the pill even when the
    // cursor leaves its box mid-gesture.
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button && e.button !== 0) return; // left button / touch / pen only
      // Single-flight: a second press ends the previous gesture first, so a
      // missed release can never stack two move listeners on one pill.
      try {
        const prev = activeDrags.get(video);
        if (prev) prev(true);
      } catch (err) { /* no previous gesture */ }
      try {
        if (btn.setPointerCapture && e.pointerId !== undefined) btn.setPointerCapture(e.pointerId);
      } catch (err) { /* capture unsupported — the other exits still apply */ }
      const startX = e.clientX, startY = e.clientY;
      const off = dragOffsets.get(video) || { dx: 0, dy: 0 };
      let moved = false;
      let ended = false;
      // The single exit for every gesture end. `cancel` suppresses the
      // click-toggle (release outside the frame, blur, Escape…); a plain
      // release toggles the panel only when nothing moved.
      const endDrag = (cancel) => {
        if (ended) return;
        ended = true;
        try { btn.removeEventListener('lostpointercapture', onCaptureLost); } catch (err) {}
        try {
          if (btn.releasePointerCapture && e.pointerId !== undefined &&
              btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) {
            btn.releasePointerCapture(e.pointerId);
          }
        } catch (err) { /* already released */ }
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onCancel, true);
        window.removeEventListener('blur', onBlur, true);
        try { document.documentElement.removeEventListener('mouseleave', onLeave); } catch (err) {}
        window.removeEventListener('keydown', onKey, true);
        try { btn.classList.remove('aidm-dragging'); } catch (err) {}
        try {
          if (activeDrags.get(video) === endDrag) activeDrags.delete(video);
        } catch (err) {}
        if (!moved && !cancel) toggleCapsulePanel(video);
      };
      const onMove = (ev) => {
        if (ended) return;
        // A button-less move means the release happened where this document
        // never saw it (outside the window/frame) — end instead of sticking.
        try {
          if (ev.pointerType !== 'touch' && ev.buttons === 0) { endDrag(true); return; }
        } catch (err) {}
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 5) {
          moved = true;
          try { btn.classList.add('aidm-dragging'); } catch (err) {}
        }
        if (moved) {
          dragOffsets.set(video, { dx: off.dx + ev.clientX - startX, dy: off.dy + ev.clientY - startY });
          positionCapsule(video);
        }
      };
      const onUp = () => { endDrag(false); };
      const onCancel = () => { endDrag(true); };
      const onBlur = () => { endDrag(true); };
      const onLeave = () => { endDrag(true); };
      const onKey = (ev) => {
        if (ev && ev.key === 'Escape') {
          try { ev.stopPropagation(); } catch (err) {}
          endDrag(true);
        }
      };
      const onCaptureLost = () => { endDrag(true); };
      btn.addEventListener('lostpointercapture', onCaptureLost);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
      window.addEventListener('blur', onBlur, true);
      try { document.documentElement.addEventListener('mouseleave', onLeave); } catch (err) {}
      window.addEventListener('keydown', onKey, true);
      try { activeDrags.set(video, endDrag); } catch (err) {}
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

    // Anchor: top-right corner of the video plus the drag offset, parked
    // anywhere inside the viewport (pure helper — test/capsule.js covers it).
    const pos = clampCapsulePos(r.right - 8 + off.dx, r.top + 8 + off.dy, vw, vh);
    const posX = pos.x, posY = pos.y;

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

    // Facebook feed ranking (mirrors the Twitter per-video scoping, but
    // non-destructive): a feed or watch page holds EVERY related video's
    // URLs. When THIS element's own file is attributable (own src or blob
    // mapping), its rows render first under "this video" and the rest follow
    // under a divider — nobody is ever hidden, so a wrong guess can never
    // cause a wrong-video download the way hard filtering could.
    const fbScope = isFacebookPage() ? elementFilePaths(video) : null;

    const seen = new Set();
    const cands = [];
    // ONLY real video/audio/stream URLs belong in the capsule. Images, fonts,
    // CSS and other page assets are excluded — Facebook alone loads dozens of
    // scontent CDN images that used to flood the panel.
    const VIDEO_AUDIO_RE = /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m4s|m3u8|mpd|mp3|wav|flac|aac|ogg|m4a|opus|wma)(\?|#|$)/i;
    const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|ico|heic|heif)(\?|#|$)/i;
    const isVideoOrAudio = (u) => {
      if (!u || typeof u !== 'string') return false;
      if (isSegmentUrl(u)) return false;
      // Hard reject images before any positive match
      if (IMAGE_EXT.test(u)) return false;
      if (VIDEO_AUDIO_RE.test(u)) return true;
      if (XTREAM_RE.test(u)) return true;
      if (/videoplayback|get_file|akamaihd|\.m3u8|\.mpd/i.test(u)) return true;
      if (isFacebookVideoUrl(u)) return true;
      return false;
    };
    const pushCand = (v) => {
      if (!v || !v.url || !/^https?:/i.test(v.url)) return;
      if (isSegmentUrl(v.url)) return;
      // Twitter/X: encrypted HLS playlists are not downloadable. The desktop
      // resolver (syndication API) supplies the real MP4 variants instead.
      if (isTwitterPlaylistUrl(v.url)) return;
      // Facebook ?bytestart=N URLs are byte-slices of the SAME progressive MP4
      // (the MSE player fetches the file in slices). Rewrite to the full-file
      // URL BEFORE dedup — one video becomes one downloadable row, and the
      // saved file keeps its MP4 header so it actually plays.
      try { v.url = stripFbRange(v.url); } catch {}
      // Twitter/X strict whitelist: only direct …/pu/vid/….mp4 variants.
      if (TWIMG_RE.test(v.url) && !isTwitterMp4Url(v.url)) return;
      // Audio-only HLS renditions (named by their master's EXT-X-MEDIA)
      // download as sound-without-picture — never offer them as videos.
      try { if (isKnownAudioPlaylist(v.url)) return; } catch (e) {}
      // Not-a-video filter: audio-typed responses complete fine but contain
      // no video track — offering them as video rows is the "downloaded but
      // no video" bug. (Probed no-track/preview drops happen at row render.)
      try {
        const nm = urlMeta(pd, v.url);
        if (dropVideoCandidate({ contentType: nm && nm.contentType })) return;
      } catch (e) {}
      // Facebook ranking tag (see above): 'mine' sorts first, 'other'
      // renders under a divider, 'all' means unattributable.
      try {
        v._fbScope = (!fbScope || !fbScope.size) ? 'all'
          : (fbScopeAllows(v.url, fbScope) ? 'mine' : 'other');
      } catch (e) { v._fbScope = 'all'; }
      if (!isVideoOrAudio(v.url)) return;
      const n = normalizeStreamUrl(v.url) || v.url;
      if (seen.has(n) || seen.has(v.url)) {
        // Same file, rotated token — merge the real filename/size instead of
        // stacking a second identical row.
        const prev = cands.find(c => (normalizeStreamUrl(c.url) || c.url) === n);
        if (prev) {
          if (!prev.filename && v.filename) prev.filename = v.filename;
          if (!prev.size && v.size) prev.size = v.size;
          if ((!prev.quality || prev.quality === 'unknown') && v.quality && v.quality !== 'unknown') {
            prev.quality = v.quality;
            if (v.resolution) prev.resolution = v.resolution;
          }
        }
        return;
      }
      seen.add(n);
      seen.add(v.url);
      cands.push(v);
    };
    direct.forEach(pushCand);
    if (isTwitterPage()) {
      // Feed scoping (see getVideoVariants): this pill shows THIS video's
      // MP4s — never the whole timeline's. pushCand's twimg whitelist already
      // drops playlists/chunks/thumbs, so only real variants remain.
      const scoped = scopedTwitterUrls(video) || globalTwitterMp4s();
      scoped.forEach(u => pushCand(detectQuality(u, video)));
    } else {
      // Add intercepted media URLs from MAIN world
      interceptedMediaUrls.forEach(u => { if (!isSegmentUrl(u)) pushCand(detectQuality(stripFbRange(u), video)); });
      // Merge page-level + webRequest-sniffed streams as extra candidates
      detectedVideos.forEach(pushCand);
      (pd.streams || []).forEach(u => {
        if (isSegmentUrl(u)) return;
        if (isTwitterPlaylistUrl(u)) return;
        if (isVideoOrAudio(stripFbRange(u))) {
          pushCand(detectQuality(stripFbRange(u), null));
        }
      });
    }
    // Facebook playable URLs live in page JSON, not in network entries.
    try {
      extractFacebookVideos().forEach(pushCand);
    } catch (e) {}

    // Facebook DASH split-AV: the video-only track and its audio-only
    // counterpart share an efg video_id. Attach the audio URL to its video
    // candidate as `audioUrl` so the desktop can mux them into one file; the
    // audio track is never offered as a row itself. Sourced from every URL
    // the page exposed (sniffed player traffic, page JSON, webRequest streams).
    try {
      const fbAll = [];
      interceptedMediaUrls.forEach(u => fbAll.push(u));
      detectedVideos.forEach(v => { if (v && v.url) fbAll.push(v.url); });
      (pd.streams || []).forEach(u => fbAll.push(u));
      const audioByVid = new Map();
      for (const u of fbAll) {
        if (fbTrackKindOfUrl(u) !== 'audio') continue;
        const vid = fbVideoIdOfUrl(u);
        if (!vid || audioByVid.has(vid)) continue;
        audioByVid.set(vid, stripFbRange(u));
      }
      if (audioByVid.size) {
        for (const v of cands) {
          if (v.audioUrl) continue;
          const vid = fbVideoIdOfUrl(v.url);
          if (!vid) continue;
          const a = audioByVid.get(vid);
          if (a) v.audioUrl = a;
        }
      }
    } catch (e) {}

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
    let rows = expanded.filter(v => {
      if (sentSet.has(v.url)) return false;
      const n = normalizeStreamUrl(v.url);
      if ((n && sentNorm.has(n)) || seen2.has(n || v.url)) return false;
      seen2.add(n || v.url);
      return true;
    }).sort((a, b) => tierOf(b.quality) - tierOf(a.quality));

    // ── Live liveness probe: never offer expired CDN links ────────────────────
    // Sites like mydaddy.cc / KVS put TIME-LIMITED links on the page. By the
    // time the user clicks Download the link is already dead (HTTP 404) and
    // the desktop shows a 0% row that fails with "Server responded with HTTP
    // 404". The background cheaply asks each CDN "is this still alive?"
    // (GET with Range: bytes=0-0) using the SAME cookies + Referer the desktop
    // download would send — so anything the probe can't fetch, the desktop
    // couldn't either. Dead rows (404/410) are dropped and real sizes from
    // Content-Range fill the "Unknown size" rows; the collapse pass below
    // then merges same-file duplicates (same path + rendition + quality +
    // resolution + size) whether or not the probe answered.
    const uniqueUrls = [...new Set(rows.map(v => v.url))];
    let probes = null;
    try {
      probes = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 7000);
        chrome.runtime.sendMessage({ action: 'probe-streams', urls: uniqueUrls, referrer: location.href }, (resp) => {
          clearTimeout(t);
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp && resp.probes ? resp.probes : null);
        });
      });
    } catch (e) { probes = null; }
    if (!capsuleState.get(video)) return;
    if (probes) {
      rows = rows.filter((v) => {
        const p = probes[v.url];
        if (p) {
          if (p.dead) return false;                // 404/410 — expired CDN link
          if (p.size && !v.size) v.size = p.size;  // exact total from Content-Range
        }
        return true;
      });
    }

    // Collapse same-file rows (token rotation, player re-fetches): same
    // canonical path + rendition tag + quality + resolution + size, merging
    // known fields into the kept row. Runs with or without probe data —
    // unknown sizes simply compare as '?'. Genuinely different renditions
    // still differ in at least one component.
    {
      const collapsed = new Map();
      for (const v of rows) {
        const k = collapseRowKey(v);
        const prev = collapsed.get(k);
        if (!prev) { collapsed.set(k, v); continue; }
        mergeRowInto(prev, v);
      }
      rows = [...collapsed.values()];
    }

    if (!capsuleState.get(video)) return;
    loading.remove();

    // Ranked rendering: this video's rows first, other videos' rows (if any)
    // under a divider. Attributed-or-not, every candidate stays downloadable.
    const mineRows = rows.filter(v => v && v._fbScope !== 'other');
    const otherRows = rows.filter(v => v && v._fbScope === 'other');
    const ordered = otherRows.length ? [...mineRows, ...otherRows] : rows;
    const splitAt = otherRows.length ? mineRows.length : -1;
    // DASH signal for the honest empty state (set by the background when
    // segment traffic flows in this tab).
    const pdDashActive = !!(pd && pd.dashActive);
    let mineCount = mineRows.length, otherCount = otherRows.length;
    const refreshSubCount = () => {
      try {
        sub.textContent = otherCount > 0
          ? `${location.hostname} · ${mineCount} this video · ${otherCount} others`
          : location.hostname + ' · ' + mineCount + ' downloadable link' + (mineCount === 1 ? '' : 's');
      } catch (e) {}
    };
    // Remove a row that probed as not-a-video and keep the counts truthful.
    const dropRow = (rowV, rowEl) => {
      try { if (rowEl.isConnected) rowEl.remove(); } catch (e) {}
      try {
        if (rowV && rowV._fbScope === 'other') otherCount = Math.max(0, otherCount - 1);
        else mineCount = Math.max(0, mineCount - 1);
      } catch (e) {}
      refreshSubCount();
      ensureProtectedRow();
    };
    // Honest empty state: blob-playing video + DASH segment traffic + no
    // direct file = protected stream. Says so instead of offering junk.
    const ensureProtectedRow = () => {
      try {
        if (mineCount + otherCount > 0) return;
        if (st.panel.querySelector('.aidm-cap-dashlock')) return;
        if (!pdDashActive || !hasBlobSource(video)) return;
        const drow = document.createElement('div');
        drow.className = 'aidm-cap-row aidm-cap-dashlock';
        const dq = document.createElement('span');
        dq.className = 'aidm-cap-q';
        dq.textContent = 'DASH';
        const dm = document.createElement('span');
        dm.className = 'aidm-cap-meta';
        dm.textContent = 'Protected stream — no direct file to download';
        dm.title = 'This video plays as a segmented stream; AiDM cannot save it as a file';
        const lock = document.createElement('span');
        lock.className = 'aidm-cap-meta';
        lock.textContent = '🔒 Protected';
        lock.title = 'Segmented/encrypted playback — downloading is not supported';
        drow.appendChild(dq);
        drow.appendChild(dm);
        drow.appendChild(lock);
        st.panel.appendChild(drow);
      } catch (e) {}
    };
    refreshSubCount();

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'aidm-cap-empty';
      empty.textContent = 'Scanning video… play it for a few seconds, then reopen this panel.';
      st.panel.appendChild(empty);
      ensureProtectedRow();
    }

    // Metadata probes queued while rows build (bounded below).
    const metaProbeRuns = [];
    ordered.forEach((v, idx) => {
      if (idx === splitAt) {
        const sep = document.createElement('div');
        sep.className = 'aidm-cap-sep';
        sep.textContent = `Other videos on this page (${otherRows.length})`;
        st.panel.appendChild(sep);
      }
      const row = document.createElement('div');
      row.className = 'aidm-cap-row';

      // The row URL is always a full-file URL by now (pushCand strips
      // ?bytestart). Belt-and-braces: strip again in case a row was merged in
      // from an older cache entry, so the Download button can never save a
      // byte-slice that won't play.
      try { v.url = stripFbRange(v.url); } catch {}
      // Enrich with the playing element's real dimensions when the URL didn't
      // encode a resolution (common for /get_file/, videoplayback, CDN paths).
      // Facebook progressive URLs carry no resolution hint at all — the
      // player's CURRENT render size is NOT the file's quality (DASH switches
      // rendition as it buffers), so guessing "1080p" from clientWidth is what
      // produced N identical "1080p" rows. Only use the element size when the
      // row came from that element's own <video src> (getVideoVariants sets
      // source:'video-element' for those).
      let res = v.resolution;
      let qual = v.quality;
      // Whether the row already carries URL-derived (authoritative) geometry.
      // Without it, rows fall back to the playing element's size below — every
      // variant then reads identically, hiding truly different dimensions
      // (fixed up by metadata probing further down for Twitter files).
      const hadAuthoritativeRes = !!(v.resolution && v.resolution !== '—');
      if ((!res || res === '—') && video.videoWidth && video.videoHeight &&
          (v.source === 'video-element' || (!v.source && /\.(mp4|webm|mkv|mov|m4v)(\?|#|$)/i.test(v.url)))) {
        res = video.videoWidth + 'x' + video.videoHeight;
        if (!qual || qual === 'unknown') qual = qualityFromHeight(video.videoHeight);
      }
      // Sniffed response metadata for this exact URL (background webRequest):
      // the Content-Disposition filename is what a native browser download
      // would save and Content-Length is the exact final size.
      const nMeta = urlMeta(pd, v.url);
      const nativeName = (nMeta && nMeta.filename) || v.filename || null;
      // Try performance API for a transfer size if none was detected
      let size = v.size || (nMeta && nMeta.size) || null;
      if (!size) {
        try {
          const entries = performance.getEntriesByName(v.url);
          for (const e of entries) {
            if (e.transferSize > 0) { size = e.transferSize; break; }
            if (e.decodedBodySize > 0) { size = e.decodedBodySize; break; }
          }
        } catch (e) {}
      }
      // Format from URL extension when not set
      let fmt = v.format;
      if (!fmt) {
        const m = /\.([a-z0-9]{2,4})(\?|#|$)/i.exec(v.url);
        if (m) fmt = m[1].toLowerCase();
      }

      const isImg = IMAGE_EXT.test(v.url);
      const q = document.createElement('span');
      q.className = 'aidm-cap-q';
      q.textContent = isImg ? 'IMAGE' : (qual && qual !== 'unknown' ? String(qual).toUpperCase() : 'VIDEO');

      // Real filename next to resolution/size so users never grab the wrong
      // video when several qualities look identical. Preference: the site's
      // own Content-Disposition name (native download behaviour) > the
      // per-video title scraped from the page (KVS flashvars, JSON-LD, …) >
      // the page title — but only when each is REAL. Hostname-derived and
      // rendition-only names ("mydaddy.cc [1080p].mp4", "1080.mp4") are
      // rejected; an untitled embed falls back to the URL basename or "Video".
      const vt = (v.title && isRealTitle(v.title)) ? v.title.trim().replace(/\s+/g, ' ').slice(0, 100) : null;
      const realTitle = vt || ((title && isRealTitle(title)) ? title : null);
      // Display filename, recomputed live: metadata probing below can upgrade
      // v.quality after first paint, and the Download button must send the
      // fresh values — never the stale guess.
      const refreshName = () => {
        const lq = (v.quality && v.quality !== 'unknown') ? v.quality : qual;
        const tag = (base) => base + ((lq && lq !== 'unknown') ? ' [' + lq + ']' : '');
        if (nativeName && !isGenericName(nativeName, v.url)) return nativeName;
        if (v.filename && !isGenericName(v.filename, v.url)) return v.filename;
        if (realTitle) return tag(realTitle);
        return specificUrlBasename(v.url) || tag('Video');
      };
      let displayName = refreshName();
      let liveName = displayName;
      const meta = document.createElement('span');
      meta.className = 'aidm-cap-meta';
      meta.textContent = displayName + ' · ' + (res || '—') + ' · ' + formatCapBytes(size) + ' · ' + (fmt || 'mp4').toUpperCase();
      meta.title = displayName + '\n' + v.url;

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

      // Facebook rows without a proven quality stay labelled VIDEO (honest),
      // and rows that only differ by rotated auth collapse via fbFileKey — so
      // the panel shows the real SD/HD choice, never 17 fake "1080p" rows.

      const dl = document.createElement('button');
      dl.className = 'aidm-cap-dl';
      dl.textContent = '⬇ Download';
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        // Live values: a metadata probe may have upgraded quality/resolution
        // after first paint — send the fresh ones, never the stale guess.
        const sendQual = (v.quality && v.quality !== 'unknown') ? v.quality
          : ((qual && qual !== 'unknown') ? qual : 'auto');
        const sendRes = v.resolution || res || null;
        const fname = sanitizeFilename(
          liveName,
          (fmt || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4'
        );
        // Refresh the URL at click time: signed CDN links expire within
        // minutes, and the player may already hold a re-signed equivalent.
        let sendUrl = v.url;
        try {
          sendUrl = pickFreshUrl(currentVideoUrls(video), v.url, normalizeStreamUrl) || v.url;
          v.url = sendUrl;
        } catch (err) { sendUrl = v.url; }
        try {
          chrome.runtime.sendMessage({
            action: 'single-download',
            url: sendUrl,
            filename: fname,
            opts: {
              // Facebook split-AV: the paired audio-only track for this video
              // (same efg video_id). The desktop downloads both and muxes them
              // with FFmpeg — without it the saved file has no sound.
              audioUrl: v.audioUrl || undefined,
              quality: {
                label: String(sendQual).toUpperCase(),
                resolution: sendRes,
                size: size || null,
                format: fmt || 'mp4',
              },
              meta: { pageTitle: document.title, pageUrl: location.href, title: realTitle || undefined },
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

      // Queue a true-dimensions probe when this row only shows an element
      // guess (bounded per panel; URL-described rows never need it). The
      // row, badge, filename and click payload all refresh in place.
      // Verify every video-container row carries a real video track, and
      // repaint geometry for rows that only showed an element guess.
      // needsMetaProbe(false) gates by container type alone; the repaint is
      // skipped for URL-described rows so good values are never churned.
      // Bounded per panel; cached globally across reopens.
      // Facebook split-AV video tracks are DASH fragments, not standalone
      // files: a <video> probe reports 0x0 (or never fires) even though the
      // track is real. Probing them used to drop every Facebook row — the
      // "video isn't detected" regression. Exempt them; the desktop muxes in
      // the paired audio track instead.
      const isFbSplitVideo = FB_HOST_RE.test(String(v.url || '')) &&
        fbTrackKindOfUrl(v.url) === 'video';
      if (!v.encrypted && !isFbSplitVideo && needsMetaProbe(v.url, false) &&
          metaProbeRuns.length < META_PROBE_MAX_ROWS) {
        metaProbeRuns.push(() => {
          probeVideoMeta(v.url).then((file) => {
            if (!file || !row.isConnected) return;
            // Drop files that are not videos after all: audio-only slices
            // and sub-second previews download fine and play nothing — the
            // exact "completed but no video" complaint.
            const verdict = dropVideoCandidate({
              contentType: null,
              probed: true,
              hasVideo: file.width > 0 && file.height > 0,
              durationSec: file.durationSec || 0,
              sizeBytes: size || 0,
            });
            if (verdict) { dropRow(v, row); return; }
            if (hadAuthoritativeRes) return;
            if (file.width <= 0 || file.height <= 0) return;
            v.resolution = file.width + 'x' + file.height;
            v.quality = qualityFromHeight(file.height);
            res = v.resolution; qual = v.quality;
            liveName = refreshName();
            q.textContent = isImg ? 'IMAGE' : String(qual).toUpperCase();
            meta.textContent = liveName + ' · ' + res + ' · ' + formatCapBytes(size) + ' · ' + (fmt || 'mp4').toUpperCase();
            meta.title = liveName + '\n' + v.url;
          }).catch(() => {});
        });
      }

      row.appendChild(q);
      row.appendChild(meta);
      row.appendChild(dl);
      st.panel.appendChild(row);
    });

    const foot = document.createElement('div');
    foot.className = 'aidm-cap-foot';
    foot.textContent = 'AiDM · drag the pill to move it';
    st.panel.appendChild(foot);

    // Fire the queued metadata probes (each file probed once globally via
    // the shared cache, even across reopened panels).
    if (metaProbeRuns.length) {
      try {
        metaProbeRuns.forEach((run) => { try { run(); } catch (e) {} });
      } catch (e) {}
    }
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
      // Facebook runs on blob:+MSE with no <video src> and extensionless
      // fbcdn requests — videoHasHttpSource() is false there, yet the video
      // is perfectly downloadable via playable_url / sniffed streams. Treat
      // a genuinely-playing, in-view video as having a source so the pill
      // still appears and the panel can offer what the extractors found.
      const isFbPage = FB_HOST_RE.test(location.hostname);
      const hasSource = videoHasHttpSource(video) || isBlob || !!video.currentSrc ||
        (isFbPage && playing && inView);

      let st = capsuleState.get(video);

      if (!playing || !inView || !hasSource) {
        if (st) hideCapsule(video);
        return;
      }
      if (!st || !st.wrap.isConnected) st = ensureCapsule(video);
      if (!st) return;

      // Count only real video/audio candidates (same filter as the panel).
      // Facebook URLs count by canonical path: rotating tokens must not
      // inflate the badge the way they once inflated the panel.
      const VIDEO_AUDIO_RE_COUNT = /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m4s|m3u8|mpd|mp3|wav|flac|aac|ogg|m4a|opus|wma)(\?|#|$)/i;
      const IMAGE_EXT_COUNT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|ico|heic|heif)(\?|#|$)/i;
      const countKeys = new Set();
      const countUrl = (u) => {
        if (!u || typeof u !== 'string' || !/^https?:/i.test(u)) return;
        if (isSegmentUrl(u)) return;
        if (isTwitterPlaylistUrl(u)) return;
        if (TWIMG_RE.test(u) && !isTwitterMp4Url(u)) return;
        if (IMAGE_EXT_COUNT.test(u)) return; // never count images
        if (!(VIDEO_AUDIO_RE_COUNT.test(u) || XTREAM_RE.test(u) || /videoplayback|get_file|akamaihd/i.test(u) || isFacebookVideoUrl(u))) return;
        countKeys.add(fbPathKey(u) || normalizeStreamUrl(u) || u);
      };
      if (isTwitterPage()) {
        // Scoped badge: this video's variants only (see getVideoVariants).
        getVideoVariants(video).forEach(v => { if (v && v.url) countUrl(v.url); });
      } else if (isFacebookPage()) {
        // Scoped badge like the panel: this video's path family when
        // attributable, otherwise the page-global path set.
        const scope = elementFilePaths(video);
        const inScope = (u) => {
          if (!scope.size) return true;
          const k = fbPathKey(u);
          return !k || scope.has(k);
        };
        getVideoVariants(video).forEach(v => { if (v && v.url) countUrl(v.url); });
        interceptedMediaUrls.forEach(u => { if (inScope(u)) countUrl(u); });
        detectedVideos.forEach(v => { if (v && v.url && inScope(v.url)) countUrl(v.url); });
      } else {
        getVideoVariants(video).forEach(v => { if (v && v.url) countUrl(v.url); });
        interceptedMediaUrls.forEach(countUrl);
        detectedVideos.forEach(v => { if (v && v.url) countUrl(v.url); });
      }
      const n = countKeys.size;
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
      try {
        scanNetworkResources().forEach(v => { if (v && v.url) addDetectedVideo(v.url, v); });
      } catch (err) {}
      requestPlayerExtraction();
      // Watch-page HTML refresh (players that inject the real markup late).
      refreshPageHtmlMedia();
      // Re-scan KVS flashvars (player may have loaded after initial scan).
      // Track locally only — do NOT push to the desktop (that pops the picker).
      try {
        extractKvsFlashvars().forEach(v => { if (v && v.url) addDetectedVideo(v.url, v); });
      } catch (err) {}
      // Facebook playable URLs appear only after playback starts.
      try {
        extractFacebookVideos().forEach(v => { if (v && v.url) addDetectedVideo(v.url, v); });
      } catch (err) {}
      try {
        requestPanelData().then(pd => {
          (pd.streams || []).forEach(u => {
            if (!/^https?:/i.test(u)) return;
            if (isSegmentUrl(u)) return;
            if (isTwitterPlaylistUrl(u)) return;
            if (!/\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ts|m4s)(\?|#|$)/i.test(u) &&
                !XTREAM_RE.test(u) && !/videoplayback|get_file|video\.php|watchparty|\/reel/i.test(u) &&
                !isFacebookVideoUrl(u)) return;
            try { addDetectedVideo(u, detectQuality(u, null)); } catch (err2) {}
          });
          scheduleSyncCapsules();
          refreshOpenPanel();
        });
      } catch (err) {}
      scheduleSyncCapsules();
      setTimeout(scheduleSyncCapsules, 1500);
    }
  }, true);

  // ── Intercept Click-to-Download ──────────────────────────────────────────────

  document.addEventListener('click', (e) => {
    // Also catch members-area file links whose URL carries no extension
    // (KVS /get_file/<hash>, /dwnl/) — the native download is grabbed by
    // background.js anyway; this makes the grab instant and lets the capsule
    // offer the same file.
    const link = e.target.closest('a[download], a[href$=".mp4"], a[href$=".m4v"], a[href$=".webm"], a[href$=".mkv"], a[href$=".mov"], a[href$=".zip"], a[href$=".rar"], a[href$=".7z"], a[href$=".exe"], a[href*="/get_file/"], a[href*="/dwnl/"]');
    if (link && link.href && /^https?:/i.test(link.href)) {
      if (link.closest('#aidm-capsule-root')) return; // never re-grab our own UI
      // Filename: the `download` attribute first, then the last path segment
      // when it looks like a file, else nothing (desktop keeps server name).
      let filename = link.getAttribute('download') || '';
      if (!filename) {
        try {
          const last = decodeURIComponent(new URL(link.href).pathname.split('/').filter(Boolean).pop() || '');
          if (/\.[A-Za-z0-9]{2,4}$/.test(last)) filename = last;
        } catch (err) {}
      }
      // Record it so the capsule panel can offer the exact file too.
      try {
        const info = detectedVideos.get(link.href) || detectQuality(link.href, null);
        if (filename) info.filename = filename;
        detectedVideos.set(link.href, info);
      } catch (err) {}
      chrome.runtime.sendMessage({
        action: 'single-download',
        url: link.href,
        filename: filename || undefined,
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
