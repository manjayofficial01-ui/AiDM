/**
 * AiDM Chrome Extension - Background Service Worker v2
 * Intercepts ALL browser downloads and routes them to AiDM
 * Detects video streams with quality/resolution/size metadata
 */

const AIDM_API = 'http://127.0.0.1:18765';
let isConnected = false;
let interceptedCount = 0;
let settings = {
  askLocationEveryTime: false,
  categoryPaths: {},
  browserIntegration: true,
  // Browser-takeover controls (v4.3.0, original AiDM implementation):
  // take every download by default; restrict via the type list / site list.
  // Default type list mirrors DEFAULT_INTERCEPT_TYPES in src/scheduler.js —
  // keep the two in sync. The desktop pushes its own values on connect.
  interceptAll: true,
  interceptFileTypes: ['exe', 'msi', 'msix', 'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'pdf', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'm4v', 'ts', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
  excludedSites: [],
  forceTakeoverKey: 'Shift',
};

// Transient takeover hotkey state, fed by the content script's key tracker.
// Timestamps (epoch ms); entries expire after a few seconds so a stuck key
// can never hijack downloads forever.
let keyPreventAt = 0;
let keyForceAt = 0;
const KEY_STATE_TTL_MS = 4000;

// ── Stream sniffing (webRequest) ─────────────────────────────────────────────
// Catches manifests / media that page-level scans miss: players (Nubiles,
// Xtream, …) load .m3u8/.mp4 over XHR/fetch with no plain <video src>.
const STREAM_REQ_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ts|m4s|key|akamai)($|\?|#)/i;
const STREAM_PATH_RE = /videoplayback|\/live\/|\/movie\/|\/series\/|\/hls\/|\/get_file\/|\/mp4\/|\.akamaihd\.net|\/secure\/|\/videos?\//i;
// Facebook / Instagram serve video from fbcdn/scontent, often WITHOUT a file
// extension (…/v/t59.4756-21/…?oh=…&oe=…&bytestart=…). Without these patterns
// the webRequest sniffer never saw Facebook video at all.
const FB_HOST_RE = /fbcdn\.net|scontent\.|facebook\.com|fb\.com|instagram\.com|cdninstagram\.com/i;
const FB_PATH_RE = /\/v\/t|video\.php|watchparty|\/reel|\/watch\/|playable|bytestart|\/dash\/|\/hls\//i;
// DASH/HLS media segments (…seg-3.m4s, …chunklist…, …frag12.ts) are not
// playable files — offering each one as a "download link" is exactly how a
// single playing video used to explode into dozens of duplicate rows.
// NOTE: a SINGLE ?bytestart=N on a Facebook fbcdn URL is NOT a segment — it
// is a byte-slice of the full progressive MP4 and is rewritten to the full
// file via stripFbRange() before dedup/download. Only repeated bytestart
// params (an MSE slice-chain artefact) count as a segment here.
const SEGMENT_URL_RE = /\.m4s($|\?|#|;)|init\.mp4($|\?|#)|seg-?\d+|chunklist|chunk-?store|fragment|frag-?\d+|\/range\/|bytestart=\d+.*&.*bytestart/i;

function isSegmentUrl(u) {
  if (!u || typeof u !== 'string') return false;
  // .m4s is ALWAYS a DASH segment, never a playable file.
  if (/\.m4s($|\?|#|;)/i.test(u)) return true;
  // Facebook ?bytestart=N range-slices are recoverable (stripFbRange rewrites
  // them to the full progressive MP4 before dedup/download) — never drop a
  // single-slice URL here.
  if (/bytestart=\d+/i.test(u) && /fbcdn\.net|scontent\.|facebook\.com|cdninstagram\.com/i.test(u) && !/bytestart=\d+.*&.*bytestart/i.test(u)) return false;
  // Twitter/X HLS chunks are plain .ts with no seg/chunk keywords — there is
  // no progressive .ts on twimg, so treat them all as segments.
  if (/\.ts($|\?|#|;)/i.test(u) && /twimg\.com/i.test(u)) return true;
  // .ts is a segment when it looks like one (playlist chunks); a bare .ts
  // progressive file is rare but playable, so require a segment keyword.
  if (/\.ts($|\?|#|;)/i.test(u) && /seg|chunk|frag|part|range|hls|dash|playlist|media|sq_|index|seq/i.test(u)) return true;
  if (SEGMENT_URL_RE.test(u)) return true;
  return false;
}

// Twitter / X: the player polls …/pu/pl/…m3u8?tag=… every few seconds while a
// video plays. Each poll looks like a new stream, so one video explodes into
// 100+ capsule rows. Those playlists are AES-128 encrypted (the engine
// refuses them) — the downloadable assets are the …/pu/vid/….mp4 variants
// extracted from GraphQL JSON / resolved via the syndication API instead.
function isTwitterPlaylistUrl(u) {
  if (!u || typeof u !== 'string') return false;
  if (!/video\.twimg\.com|pbs\.twimg\.com|t\.twimg\.com/i.test(u)) return false;
  return /\/pl\//i.test(u) || /\.(m3u8|mpd)(\?|#|$|;)/i.test(u);
}

const tabStreams = new Map(); // tabId -> [{ url, time }]
const tabNavAt = new Map();   // tabId -> epoch ms of the tab's last navigation start
const STREAM_KEEP_MS = 10 * 60 * 1000;
const STREAM_MAX = 80;

function noteTabStream(tabId, url) {
  if (tabId == null || tabId < 0 || !url || !/^https?:/i.test(url)) return;
  if (url.startsWith(AIDM_API)) return;
  // Never offer raw media segments as downloadable links. Facebook
  // ?bytestart=N slices are rewritten to the full-file URL FIRST so all
  // slices collapse into the one playable progressive MP4.
  try { url = stripFbRange(url); } catch {}
  if (isSegmentUrl(url)) return;
  // Twitter/X HLS playlists are encrypted and re-polled with rotating ?tag= —
  // never offer them; the MP4 variants are resolved separately.
  if (isTwitterPlaylistUrl(url)) return;
  // Twitter/X strict whitelist: only direct …/pu/vid/….mp4 variants are
  // downloadable — chunks, playlists and thumbs must never become rows.
  if (/video\.twimg\.com|pbs\.twimg\.com|t\.twimg\.com/i.test(url) &&
      !(/\.mp4(\?|#|$)/i.test(url) && /\/vid\/|ext_tw_video|amplify_video/i.test(url))) return;
  let list = tabStreams.get(tabId);
  if (!list) { list = []; tabStreams.set(tabId, list); }
  if (list.some(e => e.url === url)) return;
  // Token-normalized dedup: the same Facebook/CDN file with a rotated
  // ?oh=/&oe= signature must not stack as a second row.
  const n = normalizeSentUrl(url);
  if (n && list.some(e => normalizeSentUrl(e.url) === n)) return;
  list.unshift({ url, time: Date.now() });
  if (list.length > STREAM_MAX) list.length = STREAM_MAX;
}

// ── Exact media-request matching + header capture ──────────────────────────
// Pure functions (test/browser-engine.js + test/facebook-junk.js extract the
// SHIPPED definitions).
// `store` is injected so tests run without extension state.

/**
 * True for media resources and streaming paths (incl. extensionless
 * Facebook/video URLs that never match the extension regex).
 */
function isMediaRequestUrl(u, type) {
  u = u || '';
  if (type === 'media') return true;
  if (STREAM_REQ_RE.test(u) || STREAM_PATH_RE.test(u)) return true;
  // Facebook: extensionless fbcdn video URLs (/v/t…, bytestart, dash/hls)
  // never match the extension regex, so match host+path explicitly.
  return FB_HOST_RE.test(u) && (STREAM_REQ_RE.test(u) || FB_PATH_RE.test(u) || /\/v\//i.test(u));
}

const CAPTURE_TTL_MS = 10 * 60 * 1000;
const CAPTURE_MAX = 200;

/** Record the browser's exact request headers for a media URL. */
function noteCapturedRequest(store, details) {
  if (!store || !details || !details.url) return;
  const map = {};
  for (const h of details.requestHeaders || []) {
    if (h && h.name) map[String(h.name).toLowerCase()] = String(h.value == null ? '' : h.value);
  }
  const entry = {
    cookie: map['cookie'] || '',
    referer: map['referer'] || '',
    origin: map['origin'] || '',
    userAgent: map['user-agent'] || '',
    tabId: details.tabId,
    time: Date.now(),
  };
  store.set(details.url, entry);
  // Same URL without fragment resolves to the same entry.
  try {
    const noFrag = details.url.split('#')[0];
    if (noFrag !== details.url) store.set(noFrag, entry);
  } catch (e) {}
  if (store.size > CAPTURE_MAX) {
    store.delete(store.keys().next().value);
  }
}

/**
 * Best captured header set for a download URL: exact match, then
 * fragment-stripped, then same-file (query-agnostic) match for token-rotated
 * URLs. Stale entries (older than CAPTURE_TTL_MS) are skipped.
 */
function getCapturedRequest(store, url) {
  if (!store || !url) return null;
  const fresh = (e) => e && (Date.now() - (e.time || 0) < CAPTURE_TTL_MS);
  const direct = store.get(url);
  if (fresh(direct)) return direct;
  try {
    const noFrag = String(url).split('#')[0];
    const byFrag = store.get(noFrag);
    if (fresh(byFrag)) return byFrag;
    const base = String(url).split('?')[0];
    for (const [k, v] of store) {
      if (fresh(v) && String(k).split('?')[0] === base) return v;
    }
  } catch (e) {}
  return null;
}

// Exact browser header sets keyed by media URL (see noteCapturedRequest).
const capturedReqHeaders = new Map();

// Tabs with recent segmented-stream (DASH) traffic: tabId -> epoch ms.
// Lets the capsule show an honest "protected" row instead of junk when a
// blob-playing video has no direct file. Pure helpers below.
const tabDashActive = new Map();
const DASH_ACTIVE_TTL_MS = 5 * 60 * 1000;

/** DASH-only signals: segmented traffic the engine cannot save as a file. */
function isDashSignalUrl(u) {
  if (!u || typeof u !== 'string' || !/^https?:/i.test(u)) return false;
  return /\.m4s($|\?|#|;)|^[^?#]*init\.mp4($|\?|#)|\.mpd(\?|#|$)|\/dash\//i.test(u);
}

/** Record DASH activity for a tab (injected store for tests). */
function noteDashActive(store, tabId) {
  if (!store || tabId == null || tabId < 0) return;
  store.set(tabId, Date.now());
  if (store.size > 500) store.delete(store.keys().next().value);
}

/** Fresh DASH activity for a tab (injected store for tests). */
function isDashActiveTab(store, tabId) {
  if (!store || tabId == null) return false;
  const t = store.get(tabId) || 0;
  return t > 0 && (Date.now() - t < DASH_ACTIVE_TTL_MS);
}

/**
 * Not-a-video verdict (mirrors dropVideoCandidate in content.js — keep the
 * two in sync; test/facebook-junk.js asserts parity). Audio-typed responses
 * complete fine but contain no video track.
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

try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (isMediaRequestUrl(details.url, details.type)) {
        noteTabStream(details.tabId, details.url);
      }
      // DASH beacons: segmented-stream traffic (never directly downloadable)
      // marks the tab, so the capsule can show an honest "protected" state
      // instead of junk rows when no direct file exists.
      try {
        if (details.tabId != null && details.tabId >= 0 && isDashSignalUrl(details.url)) {
          noteDashActive(tabDashActive, details.tabId);
        }
      } catch (e) {}
    },
    { urls: ['<all_urls>'] }
  );

  // Exact request-header capture (v4.3.2, original AiDM implementation).
  // Premium/hotlink CDNs validate the full set the browser used while the
  // video played (Cookie + Referer + Origin + UA together) — guessing those
  // values later is what makes "browser works, downloader gets 403" happen.
  // Captured sets are replayed verbatim on the desktop download.
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        if (details.tabId == null || details.tabId < 0) return;
        if (!isMediaRequestUrl(details.url, details.type)) return;
        noteCapturedRequest(capturedReqHeaders, details);
      } catch (e) { /* never break page traffic for bookkeeping */ }
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders']
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const u = details.url || '';
      if (!u || !/^https?:/i.test(u) || u.startsWith(AIDM_API)) return;
      const hs = details.responseHeaders;
      if (!hs) return;
      let ct = '';
      let cl = null;
      let cd = '';
      for (const h of hs) {
        const n = (h.name || '').toLowerCase();
        if (n === 'content-type') ct = (h.value || '').toLowerCase();
        else if (n === 'content-length') { const v = parseInt(h.value, 10); if (v > 0) cl = v; }
        else if (n === 'content-disposition') cd = h.value || '';
      }
      const isMediaCt = ct.startsWith('video/') || ct.startsWith('audio/') ||
        ct.includes('application/vnd.apple.mpegurl') ||
        ct.includes('application/x-mpegurl') ||
        ct.includes('application/dash+xml');
      const cdName = cd ? parseContentDispositionFilename(cd) : null;
      // Native-style download: the server marks it as an attachment and/or
      // names a media file (KVS members areas answer /get_file/ this way).
      const isAttachment = /attachment/i.test(cd);
      const mediaNamed = !!cdName && /\.(mp4|m4v|webm|mkv|mov|ts|m4s|m3u8|mpd|zip|rar|7z)(\?|#|$)/i.test(cdName);
      if (isMediaCt) noteTabStream(details.tabId, u);
      if (isAttachment && (isMediaCt || mediaNamed || /octet-stream/.test(ct))) {
        noteTabStream(details.tabId, u);
      }
      if (cdName || isMediaCt || isAttachment) {
        noteStreamMeta(u, { filename: cdName, size: cl, contentType: ct });
      }
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
  );
} catch (e) { /* webRequest unavailable — page scan still works */ }

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabStreams.delete(tabId);
    tabDashActive.delete(tabId);
    // Per-tab state must go with the tab — these maps were never cleaned
    // and grew for the whole browser session.
    tabNavAt.delete(tabId);
    tabYtPage.delete(tabId);
    pruneResolvedCaches();
  });
} catch (e) {}

// ── Twitter / X tweet pages ────────────────────────────────────────────────
// X does not expose the direct MP4 URLs to the page (they live in GraphQL /
// syndication metadata), and the syndication endpoint is CORS-restricted to
// platform.twitter.com so page JS can't read it. Instead of sniffing, we hand
// the tweet URL to the AiDM app, which resolves the real MP4 variants
// server-side with no login required. This works even when the timeline JSON
// is server-rendered or compressed — the usual reason detection fails.
const TWEET_URL_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/(?:i\/web\/)?(?:[^/]+\/)?status(?:es)?\/(\d{5,25})/i;
const resolvedTweets = new Map(); // tweetId -> last attempt time
const TWEET_RETRY_MS = 60 * 1000;

function maybeResolveTweet(url) {
  try {
    if (!url) return;
    const m = TWEET_URL_RE.exec(url);
    if (!m) return;
    const tweetId = m[1];
    const now = Date.now();
    const last = resolvedTweets.get(tweetId) || 0;
    if (now - last < TWEET_RETRY_MS) return;
    resolvedTweets.set(tweetId, now);

    fetch(`${AIDM_API}/api/resolve-twitter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then(
      async (resp) => {
        try {
          const data = await resp.json();
          // Unresolvable right now (rate-limited, login-walled…) — allow a
          // retry instead of suppressing this tweet for a full minute.
          if (!data || data.success === false) resolvedTweets.delete(tweetId);
        } catch (e) { resolvedTweets.delete(tweetId); }
      },
      () => { resolvedTweets.delete(tweetId); } // app not running — retry later
    );
  } catch (e) { /* swallow */ }
}

// ── Facebook / Instagram watch pages ───────────────────────────────────────
// Same handoff as tweets: the desktop resolves the page server-side into
// fresh progressive MP4s (see src/facebook-resolver.js). The extension passes
// the browser's session cookies along so login-walled videos resolve too.
const FB_PAGE_URL_RE = /^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/(?:watch|reel|share\/v|video\.php|story\.php|[^/]+\/videos)/i;
const FB_SHORT_URL_RE = /^https?:\/\/fb\.watch\//i;
const IG_PAGE_URL_RE = /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv)\//i;
const resolvedFbPages = new Map(); // pageUrl -> last attempt time
const FB_RETRY_MS = 60 * 1000;

function isFacebookPageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return FB_PAGE_URL_RE.test(url) || FB_SHORT_URL_RE.test(url) || IG_PAGE_URL_RE.test(url);
}

function maybeResolveFacebook(url) {
  try {
    if (!url || !isFacebookPageUrl(url)) return;
    const key = url.split('#')[0];
    const now = Date.now();
    const last = resolvedFbPages.get(key) || 0;
    if (now - last < FB_RETRY_MS) return;
    resolvedFbPages.set(key, now);

    (async () => {
      let cookies = null;
      try {
        const all = await collectCookies(new Set([url]));
        if (all.length) cookies = all.join('; ');
      } catch (e) { /* probe without cookies */ }
      try {
        const resp = await fetch(`${AIDM_API}/api/resolve-facebook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, cookies }),
        });
        const data = await resp.json().catch(() => null);
        if (!data || data.success === false) {
          // App unreachable or page unresolvable — allow a retry later
          // instead of suppressing this page for a full minute.
          resolvedFbPages.delete(key);
        }
      } catch (e) {
        resolvedFbPages.delete(key); // app not running — allow a retry later
      }
    })();
  } catch (e) { /* swallow */ }
}

// ── YouTube watch pages ────────────────────────────────────────────────────
// YouTube is the one site where the SNIFFED urls are useless to a download
// manager: the player fetches picture and sound as two separate signed DASH
// URLs (a saved file would be silent) and those links expire in minutes.
// So the extension hands the WATCH PAGE to the desktop instead, which
// resolves it with yt-dlp into real, merged qualities (with sound).
//
// No cookies are attached: AiDM does not bypass login walls or bot checks.
// A video that needs sign-in is reported as an error, never worked around.
const YT_PAGE_URL_RE = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*[?&])?v=|shorts\/|embed\/|live\/|v\/)|youtube-nocookie\.com\/embed\/|youtu\.be\/)[A-Za-z0-9_-]{11}/i;
const resolvedYtPages = new Map(); // pageUrl -> last attempt time
const YT_RETRY_MS = 60 * 1000;
const tabYtPage = new Map();       // tabId -> true while the tab shows YouTube
// tabYtPage values are booleans, not timestamps — pruning uses a set copy.
function pruneResolvedCaches() {
  const cutoff = Date.now() - RESOLVED_TTL_MS;
  const prune = (m) => {
    for (const [k, t] of m) { if (typeof t === 'number' && t < cutoff) m.delete(k); }
  };
  try { prune(resolvedTweets); } catch (e) {}
  try { prune(resolvedFbPages); } catch (e) {}
  try { prune(resolvedYtPages); } catch (e) {}
}

function isYouTubePageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return YT_PAGE_URL_RE.test(url);
}

function maybeResolveYouTube(url) {
  try {
    if (!isYouTubePageUrl(url)) return;
    const key = url.split('#')[0];
    const now = Date.now();
    if (now - (resolvedYtPages.get(key) || 0) < YT_RETRY_MS) return;
    resolvedYtPages.set(key, now);

    (async () => {
      try {
        const resp = await fetch(`${AIDM_API}/api/resolve-youtube`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await resp.json().catch(() => null);
        if (!data || data.success === false) {
          // App unreachable or page unresolvable — allow a retry later
          // instead of suppressing this page for a full minute.
          resolvedYtPages.delete(key);
        }
      } catch (e) {
        resolvedYtPages.delete(key); // app not running — allow a retry later
      }
    })();
  } catch (e) { /* swallow */ }
}

try {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // A real navigation starts a fresh page → drop this tab's sniffed-stream
    // history. tabStreams is keyed by tabId and used to survive 10 minutes,
    // but without this clear the PREVIOUS site's media URLs kept resurfacing
    // in the capsule panel on every OTHER site opened in the same tab — one
    // stale, tokenized link (e.g. a mydaddy.cc video) that looked "hardcoded"
    // and whose download always failed (rotated/expired signature + wrong
    // Referer), making AiDM appear broken on those sites.
    if (changeInfo.status === 'loading') {
      tabStreams.delete(tabId);
      tabYtPage.delete(tabId);
      tabNavAt.set(tabId, Date.now());
    }
    if (changeInfo.status === 'complete' && tab && tab.url) {
      if (isYouTubePageUrl(tab.url)) tabYtPage.set(tabId, true);
      maybeResolveTweet(tab.url);
      maybeResolveFacebook(tab.url);
      maybeResolveYouTube(tab.url);
    }
  });
} catch (e) { /* tabs API unavailable */ }

// X, Facebook and Instagram are single-page apps: moving from one tweet /
// video to the next uses history.pushState, which never fires tabs.onUpdated.
// Without this, auto-resolve only worked for full page loads (paste, reload)
// and silently missed every in-app navigation — the classic "AiDM doesn't
// detect Twitter/Facebook videos".
try {
  if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
      try {
        if (!details || details.frameId !== 0 || !details.url) return;
        // YouTube is an SPA: navigating to the next video never fires a load,
        // so the "hide the player's own CDN urls" flag must follow pushState.
        if (isYouTubePageUrl(details.url)) tabYtPage.set(details.tabId, true);
        else tabYtPage.delete(details.tabId);
        // SPA navigations get no tabs.onUpdated 'loading' either, so the
        // tab's sniffed-stream history must be dropped here too — otherwise
        // the previous page's tokenized links keep resurfacing in the
        // capsule panel on the next video (same mydaddy class of bug as the
        // full-navigation one).
        tabStreams.delete(details.tabId);
        tabNavAt.set(details.tabId, Date.now());
        maybeResolveTweet(details.url);
        maybeResolveFacebook(details.url);
        maybeResolveYouTube(details.url);
      } catch (e) { /* swallow */ }
    });
  }
} catch (e) { /* webNavigation unavailable */ }

// Pure filtering for a tab's sniffed-stream history — extracted so the
// regression test (test/panel-freshness.js) exercises the SHIPPED logic.
// `since` drops anything captured BEFORE the current page load (epoch ms);
// `keepMs` drops anything older than the freshness window.
function filterTabStreams(list, now, since, keepMs) {
  return (list || [])
    .filter(e => !(keepMs > 0 && now - e.time >= keepMs))
    .filter(e => !(since > 0 && e.time < since))
    .map(e => e.url);
}

// Pure: on a YouTube page the desktop already offers real, MERGED qualities
// (see maybeResolveYouTube), so the player's own CDN urls are hidden. They are
// separate signed DASH tracks — picture-only or sound-only — that expire in
// minutes, so clicking one in the capsule saves a silent or dead file.
function dropYoutubeCdn(list, isYtPage) {
  if (!isYtPage || !Array.isArray(list)) return list;
  return list.filter(v => !v || !/googlevideo\.com\/videoplayback/i.test(v.url || ''));
}

function getTabStreams(tabId, since) {
  return dropYoutubeCdn(
    filterTabStreams(tabStreams.get(tabId), Date.now(), since, STREAM_KEEP_MS),
    !!tabYtPage.get(tabId)
  );
}

// ── Response metadata (native download filename + exact size) ────────────────
// Content-Disposition is the name a native browser download would save the
// file as; Content-Length is its exact size. Captured per URL so the capsule
// panel/popup can show them and the desktop can reuse the same filename.
const streamMeta = new Map(); // url -> { filename, size, contentType, time }
const META_KEEP_MS = 10 * 60 * 1000;
const META_MAX = 300;

function noteStreamMeta(url, meta) {
  if (!url || !meta) return;
  streamMeta.set(url, { ...meta, time: Date.now() });
  if (streamMeta.size > META_MAX) {
    streamMeta.delete(streamMeta.keys().next().value);
  }
}

/** Parse `filename` / `filename*=UTF-8''…` out of a Content-Disposition value. */
function parseContentDispositionFilename(cd) {
  if (!cd || typeof cd !== 'string') return null;
  let name = null;
  const star = /filename\*\s*=\s*([^\s;]+)/i.exec(cd);
  if (star) {
    const raw = star[1].replace(/^UTF-8''/i, '').replace(/^"|"$/g, '');
    try { name = decodeURIComponent(raw); } catch (e) { name = raw; }
  }
  if (!name) {
    const plain = /filename\s*=\s*("[^"]*"|'[^']*'|[^;\s]+)/i.exec(cd);
    if (plain) name = plain[1].replace(/^["']|["']$/g, '').trim();
  }
  if (!name) return null;
  try { name = decodeURIComponent(name); } catch (e) {}
  // Strip any path components a misbehaving server might include.
  return name.split(/[\\/]/).pop() || null;
}

/** Fresh metadata for a URL (exact match; token-insensitive fallback). */
function getStreamMeta(url) {
  if (!url) return null;
  const now = Date.now();
  const m = streamMeta.get(url);
  if (m && now - m.time < META_KEEP_MS) return m;
  const n = normalizeSentUrl(url);
  if (!n) return null;
  for (const [k, v] of streamMeta) {
    if (now - v.time < META_KEEP_MS && normalizeSentUrl(k) === n) return v;
  }
  return null;
}

// ── Already-sent tracking (dedup) ────────────────────────────────────────────
// URLs handed to AiDM (exact + token-normalized) so the capsule/popup stop
// offering them and the manager never stacks a duplicate row.
const TOKEN_PARAMS = new Set([
  'token', 'tokens', 'sig', 'signature', 'sign', 'expires', 'expiry', 'exp',
  'e', 'h', 'hdnea', 'hdntl', 'hdnts', 'st', 'key', 'auth', 'authkey',
  'wmsauthsign', 'mst', 'access_token', 'token_expires', 'session', 'sid',
  'policy', 'token_hash', 'verify', 'md5', 't', 'ts', '_',
  // Facebook / Instagram CDN auth (rotates per request — same video, new ?oh=&oe=).
  // `vabr` (video-adaptive-bitrate token on hd_src/sd_src) rotates the same way.
  'oh', 'oe', 'dl', 'rl', 'vabr', 'efg', 'bytestart', 'byteend',
  '_nc_ht', '_nc_cat', '_nc_ohc', '_nc_rid', '_nc_sid', 'ccb',
  // Twitter / X video CDN (?tag=12/14/16 rotates per poll — same file)
  'tag', 'container', 'containers',
]);

// Facebook edge-pool hosts rotate per request (video-ak-fbcdn-…, scontent-…,
// video-….fbcdn.net). Collapse them to a service class so the same file
// compares equal, while `efg`/`rl` (encode tag / rate level) are KEPT so SD
// and HD variants never merge into one row.
function fbCanonicalHost(h) {
  try {
    h = String(h || '').toLowerCase().replace(/\.$/, '');
    // PATH identifies the object; edge-pool hosts are interchangeable.
    if (/\.fbcdn\.net$/i.test(h)) return 'fbcdn.net';
    if (/cdninstagram\.com$/i.test(h)) return 'cdninstagram.com';
    return h;
  } catch { return String(h || '').toLowerCase(); }
}

// Keep only the PER-RENDITION fields of efg; `bhak` rotates per request and
// keeping the raw blob made one video explode into 99+ rows.
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

// Facebook serves split DASH renditions as two extensionless .mp4 range URLs
// sharing an efg video_id: a video-only track and an audio-only track
// (encode_tag contains "audio"). Mirrors fbTrackKindOfUrl in content.js.
function fbTrackKindOfUrl(u) {
  try {
    const efg = new URL(String(u || '')).searchParams.get('efg');
    const obj = fbEfgObj(efg);
    if (!obj) return null;
    const tag = String(obj.encode_tag || '') + ' ' + String(obj.vencode_tag || '');
    if (!tag.trim()) return null;
    // Audio renditions are tagged by codec, often without the word "audio"
    // (dash_ln_heaac_vbr3, dash_aac_lc, dash_mp4a.40.2). Mirrors efgIsAudio.
    return /audio|heaac|aac[_-]|mp4a|opus|vorbis/i.test(tag) ? 'audio' : 'video';
  } catch (e) { return null; }
}

function fbVideoIdOfUrl(u) {
  try {
    const efg = new URL(String(u || '')).searchParams.get('efg');
    const obj = fbEfgObj(efg);
    return (obj && obj.video_id != null) ? String(obj.video_id) : null;
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

// ── Facebook presentation collapse ─────────────────────────────────────────
// The URL-level keys above stay untouched (dedup map, sent tracking, all
// regression tests). The quality-picker payload collapses on top of them:
// same canonical path + rendition tag + quality + resolution + size, so one
// file re-requested with rotated tokens renders as one row. Pure functions —
// test/facebook-panel.js extracts the SHIPPED definitions and asserts parity
// with the content-script and popup copies.

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
 * Presentation collapse key. Non-Facebook URLs keep exact-key semantics so
 * other sites' behavior cannot change.
 */
function collapseRowKey(v) {
  const url = String((v && v.url) || '');
  if (!fbPathKey(url)) return 'u:' + (normalizeSentUrl(url) || url);
  // No `size` in the key: the same file probed at different moments can be
  // known vs unknown, and keying on it split one file into two rows.
  const q = (v && v.quality && v.quality !== 'unknown') ? v.quality : '?';
  const res = (v && v.resolution) || '?';
  return fbPathKey(url) + '|' + fbEfgTagOfUrl(url) + '|' + q + '|' + res;
}

/** Collapse same-file rows, merging known fields into the kept row. */
function collapseVideoRows(list) {
  const out = new Map();
  for (const v of list || []) {
    if (!v) continue;
    const k = collapseRowKey(v);
    const prev = out.get(k);
    if (!prev) { out.set(k, v); continue; }
    try {
      if (v.playing) prev.playing = true;
      if (!prev.filename && v.filename) prev.filename = v.filename;
      if (!prev.size && v.size) prev.size = v.size;
      if ((!prev.quality || prev.quality === 'unknown') && v.quality && v.quality !== 'unknown') {
        prev.quality = v.quality;
        if (v.resolution) prev.resolution = v.resolution;
      }
      if (!prev.resolution && v.resolution) prev.resolution = v.resolution;
    } catch (e) {}
  }
  return [...out.values()];
}

// ── Facebook range-strip ───────────────────────────────────────────────────
// ?bytestart=N / ?byteend=M turn a full progressive MP4 into a SLICE starting
// at byte N. The MSE player fetches the file in such slices; if AiDM saves
// the slice URL as-is, the file on disk is missing its ftyp/moov header and
// no player can open it ("downloaded video is not playing"). Stripping both
// params restores the full-file URL. Every OTHER param is auth (oh/oe/efg…)
// and must be KEPT for the download itself — only the compare key drops them.
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

function normalizeSentUrl(u) {
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
  } catch {
    return null;
  }
}

/**
 * Collect every cookie the browser would send for a set of URLs/hosts.
 * KVS members areas (Nubiles et al.) and Xtream/IPTV panels keep the session
 * cookie on the *parent* domain (`.nubiles-porn.com`, `.example.com`) while
 * the video URL is on a subdomain or a sibling CDN. A naive
 * `cookies.getAll({domain: cdnHost})` therefore misses the session cookie and
 * the desktop engine gets 403'd. We match by URL (the way the browser does it)
 * AND walk every parent label down to the registrable domain.
 */
async function collectCookies(hosts) {
  const cookieSet = new Set();
  try {
    for (const h of hosts) {
      try {
        const url = h.startsWith('http') ? h : 'https://' + h + '/';
        (await chrome.cookies.getAll({ url })).forEach(c => cookieSet.add(c.name + '=' + c.value));
      } catch (e) { /* CSP / no access */ }
    }
    const domains = new Set();
    for (const h of hosts) {
      try {
        const host = h.startsWith('http') ? new URL(h).hostname : h;
        const parts = host.split('.');
        for (let i = 0; i < parts.length - 1; i++) domains.add(parts.slice(i).join('.'));
      } catch (e) {}
    }
    for (const d of domains) {
      try {
        (await chrome.cookies.getAll({ domain: d })).forEach(c => cookieSet.add(c.name + '=' + c.value));
      } catch (e) {}
    }
  } catch (e) {}
  return [...cookieSet];
}

const sentExact = new Set();
const sentNorm = new Set();
const SENT_MAX = 1000;

function markSent(url) {
  if (!url) return;
  sentExact.add(url);
  const n = normalizeSentUrl(url);
  if (n) sentNorm.add(n);
  if (sentExact.size > SENT_MAX) sentExact.delete(sentExact.values().next().value);
  if (sentNorm.size > SENT_MAX) sentNorm.delete(sentNorm.values().next().value);
}

function isSent(url) {
  if (!url) return false;
  if (sentExact.has(url)) return true;
  const n = normalizeSentUrl(url);
  return !!n && sentNorm.has(n);
}

// ── Capsule link liveness probe ──────────────────────────────────────────────
// Sites like mydaddy.cc / KVS put TIME-LIMITED CDN links on the page. By the
// time the user clicks Download the link is dead (HTTP 404) and the desktop
// shows a 0% row that fails with "Server responded with HTTP 404". The capsule
// therefore asks us to verify every candidate URL BEFORE offering it: one GET
// with `Range: bytes=0-0` (206/200 = alive, 404/410 = dead) with the same
// cookies + Referer the desktop download would send — so anything the probe
// cannot fetch is something the desktop could not download either.
const probeCache = new Map(); // url -> { result, time }
const PROBE_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 6000;
const PROBE_MAX_URLS = 16;

async function probeStreamUrl(url, referrer) {
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.time < PROBE_TTL_MS) return cached.result;
  let result;
  try {
    const headers = {
      'Range': 'bytes=0-0',
      'Referer': referrer || new URL(url).origin + '/',
      'User-Agent': navigator.userAgent || '',
      'Accept-Language': (navigator.language || 'en-US') + ',en;q=0.9',
    };
    try {
      const cookieHosts = new Set([url, new URL(url).hostname]);
      if (referrer) {
        try { cookieHosts.add(referrer); } catch (e) {}
        try { cookieHosts.add(new URL(referrer).hostname); } catch (e) {}
      }
      const all = await collectCookies(cookieHosts);
      if (all.length) headers.Cookie = all.join('; ');
    } catch (e) { /* cookies unavailable — probe without them */ }
    const resp = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Exact total size from Content-Range ("bytes 0-0/814923799") or the plain
    // Content-Length fallback. Only the first byte is read either way — the
    // body is cancelled immediately so a Range-ignoring 200 costs nothing.
    let size = null;
    const cr = resp.headers.get('content-range');
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) size = parseInt(m[1], 10);
    }
    if (!size) {
      const cl = parseInt(resp.headers.get('content-length'), 10);
      if (cl > 0) size = cl;
    }
    try { if (resp.body) resp.body.cancel(); } catch (e) {}
    let status = resp.status;
    // Hosts that block Range probes (401/403) yet serve plain browser GETs:
    // retry once without Range so such links are not misreported as dead —
    // the desktop engine does the same before downloading.
    if (status === 401 || status === 403) {
      try {
        const plainHeaders = { ...headers };
        delete plainHeaders.Range;
        delete plainHeaders.range;
        const resp2 = await fetch(url, {
          method: 'GET',
          headers: plainHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        let size2 = null;
        const cl2 = parseInt(resp2.headers.get('content-length'), 10);
        if (cl2 > 0) size2 = cl2;
        try { if (resp2.body) resp2.body.cancel(); } catch (e) {}
        if (resp2.status === 200) {
          status = 200;
          if (size2 && !size) size = size2;
        }
      } catch (e) { /* plain GET failed too — keep the probe status */ }
    }
    result = {
      status,
      size,
      alive: status === 200 || status === 206,
      dead: status === 404 || status === 410,
    };
  } catch (e) {
    // Network error / timeout / probe blocked — UNKNOWN, not dead. Keep the
    // row: some servers refuse probe requests but serve the real download.
    result = { status: 0, size: null, alive: null, dead: false };
  }
  probeCache.set(url, { result, time: Date.now() });
  if (probeCache.size > 300) probeCache.delete(probeCache.keys().next().value);
  return result;
}

async function probeStreamUrls(urls, referrer) {
  const list = (Array.isArray(urls) ? urls : [])
    .filter(u => typeof u === 'string' && /^https?:/i.test(u) && !u.startsWith(AIDM_API))
    .slice(0, PROBE_MAX_URLS);
  const out = {};
  await Promise.all(list.map(async (u) => { out[u] = await probeStreamUrl(u, referrer); }));
  return out;
}


// ── Connection & Settings ─────────────────────────────────────────────────────

async function checkConnection() {
  try {
    const resp = await fetch(`${AIDM_API}/api/status`, { signal: AbortSignal.timeout(2000) });
    const data = await resp.json();
    isConnected = data.status === 'running';
    // Merge over defaults so a missing key never disables a control.
    if (data.settings) settings = { ...settings, ...data.settings };
    updateBadge();
    return isConnected;
  } catch {
    isConnected = false;
    updateBadge();
    return false;
  }
}

function updateBadge() {
  if (isConnected) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
  } else {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f87171' });
  }
}

// ── Download to AiDM ──────────────────────────────────────────────────────────

// `blob:` URLs (AI-generated images on Leonardo, canvas snapshots, in-page
// image previews) are in-memory browser objects the Electron main process
// cannot fetch. Resolve them in the extension (same-origin context can read
// the blob), then hand the raw bytes to the desktop as a `data:` URL — the
// engine writes them directly without an HTTP probe.
const BLOB_MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'image/tiff': 'tiff', 'image/x-icon': 'ico', 'image/avif': 'avif',
  'image/heic': 'heic', 'image/heif': 'heif',
};

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function sanitizeBlobFilename(name, ext) {
  const safe = String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').trim();
  const base = safe.replace(/\.[^./\\]+$/, '') || 'image';
  return base + '.' + ext;
}

async function sendBlobToAiDM(url, filename, opts = {}) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return { sent: false, success: false, error: 'fetch ' + resp.status };
    const blob = await resp.blob();
    const mime = (blob && blob.type) || 'image/png';
    const ext = BLOB_MIME_EXT[mime.toLowerCase()] || 'png';
    const buf = await blob.arrayBuffer();
    // `extractFilename(blobUrl)` returns 'download', so prefer the caller's
    // filename when it looks real, otherwise stamp one.
    const looksReal = filename && filename !== 'download' && /\.[a-z0-9]{2,5}$/i.test(filename);
    const finalName = sanitizeBlobFilename(
      looksReal ? filename : `image-${Date.now()}.${ext}`,
      ext
    );
    const dataUrl = `data:${mime};base64,${arrayBufferToBase64(buf)}`;
    const body = {
      url: dataUrl,
      filename: finalName,
      meta: Object.assign({}, opts.meta || {}, { contentType: mime, sourceUrl: url }),
    };
    const post = await fetch(`${AIDM_API}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const data = await post.json();
    if (data && data.success) {
      if (!data.duplicate) interceptedCount++;
      return { sent: !data.duplicate, success: true, duplicate: !!data.duplicate };
    }
    return { sent: false, success: false, error: (data && data.error) || 'upload failed' };
  } catch (e) {
    return { sent: false, success: false, error: e.message };
  }
}

async function sendToAiDM(url, filename, opts = {}) {
  if (!url) return { sent: false, success: false };
  // Resolve blob: URLs to data: URLs first (see sendBlobToAiDM).
  if (typeof url === 'string' && url.startsWith('blob:')) {
    return sendBlobToAiDM(url, filename, opts);
  }
  // Facebook: never download a ?bytestart=N slice — it is a partial chunk of
  // the file (missing the MP4 header) and saves as an unplayable video.
  // Strip the range params so the full progressive file is fetched instead.
  try { url = stripFbRange(url); } catch {}
  if (isSent(url)) return { sent: false, success: true, duplicate: true };
  try {
    const body = { url, filename, ...opts };
    // Exact browser headers win: the webRequest capture holds the Cookie /
    // Referer / Origin / UA the browser itself used while this file played —
    // replaying that set verbatim is what passes multi-layer anti-hotlink
    // checks that guessed values fail ("browser works, AiDM gets 403").
    const captured = getCapturedRequest(capturedReqHeaders, url);
    // Replay headers so anti-hotlink (Referer) checks on the desktop pass.
    // `opts.referrer` is the real referrer from the Chrome downloads API (a
    // native browser save already has it); pages send `pageUrl`. The captured
    // Referer beats all of them; the bare media origin is the last resort —
    // many CDNs reject an off-domain-or-no Referer, which is exactly why
    // "the browser downloads it but AiDM can't".
    const ref = (captured && captured.referer) ||
      opts.pageUrl || opts.referrer ||
      (opts.meta && opts.meta.pageUrl) ||
      (body.headers && (body.headers.Referer || body.headers.referer)) ||
      (new URL(url).origin + '/');
    // Facebook CDN rate-limits browser User-Agents (yt-dlp facebook extractor
    // pins facebookexternalhit/1.1 for the same reason). Captured browser UA
    // is exactly what gets rejected — override on fbcdn/scontent hosts.
    const isFbCdn = /fbcdn\.net|scontent\.|cdninstagram\.com/i.test(String(url));
    body.headers = Object.assign({}, body.headers, {
      Referer: ref,
      'User-Agent': isFbCdn
        ? 'facebookexternalhit/1.1'
        : ((captured && captured.userAgent) || navigator.userAgent || ''),
      'Accept-Language': (navigator.language || 'en-US') + ',en;q=0.9',
    });
    if (captured && captured.origin && !body.headers.Origin && !body.headers.origin) {
      body.headers.Origin = captured.origin;
    }
    // Attach session cookies for authenticated downloads (KVS /get_file/,
    // Xtream IPTV). The captured Cookie is the exact set the browser sent
    // during playback, so it wins; otherwise collect for both the video host
    // and the page/referer host (walk parent domains too — see
    // collectCookies).
    if (!body.cookies && captured && captured.cookie) {
      body.cookies = captured.cookie;
    }
    if (!body.cookies) {
      try {
        const hosts = new Set();
        hosts.add(url);
        try { hosts.add(new URL(url).hostname); } catch (e) {}
        try { hosts.add(ref); } catch (e) {}
        try { if (ref) hosts.add(new URL(ref).hostname); } catch (e) {}
        const all = await collectCookies(hosts);
        if (all.length) body.cookies = all.join('; ');
      } catch (e) { /* cookies API unavailable or blocked */ }
    }
    const resp = await fetch(`${AIDM_API}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (data.success) {
      if (!data.duplicate) interceptedCount++;
      markSent(url);
      return { sent: !data.duplicate, success: true, duplicate: !!data.duplicate };
    }
    return { sent: false, success: false };
  } catch {
    return { sent: false, success: false };
  }
}

async function sendBatchToAiDM(urls) {
  try {
    const resp = await fetch(`${AIDM_API}/api/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    (data.downloads || []).forEach(d => { if (d && d.url && !d.error) markSent(d.url); });
    return data.success;
  } catch {
    return false;
  }
}

async function sendVideoDetection(videoData) {
  try {
    // Title helpers (pure logic mirrors aidm/src/titles.js — keep in sync).
    // An untitled embed/alt-player iframe reports an empty pageTitle; the old
    // code then fell back to nothing here but the capsule used the hostname,
    // producing "mydaddy.cc [1080p].mp4" downloads. Hostnames are never titles.
    const looksLikeHostname = (s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(s || '').trim());
    const GENERIC_TITLE_RE = /^(video|watch|play|player|home|index|untitled|download|downloads|media|clip|embed|empty|blank|no\s*title)$/i;
    const isRealTitle = (t, hostname) => {
      const s = String(t == null ? '' : t).trim().replace(/\s+/g, ' ');
      if (!s || s.length < 2) return false;
      const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
      if (host && s.toLowerCase() === host) return false;
      if (looksLikeHostname(s)) return false;
      if (GENERIC_TITLE_RE.test(s)) return false;
      // A bare domain with an affix ("mydaddy.cc - Home") is still not a title.
      const core = s
        .replace(/\s*[-|–—:|]\s*[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*$/i, '')
        .replace(/^[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*[-|–—:|]\s*/i, '')
        .trim();
      if (!core || looksLikeHostname(core) || GENERIC_TITLE_RE.test(core)) return false;
      return true;
    };
    const cleanTitle = (raw) => {
      let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
      if (!s) return null;
      s = s.replace(/\s*[-|–—:|]\s*(YouTube|Facebook|Vimeo|Dailymotion|Twitch).*/i, '').trim();
      s = s.replace(/\s*[-|–—:|]\s*[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*$/i, '').trim();
      return isRealTitle(s) ? s.slice(0, 100) : null;
    };
    // Attach session cookies for the page host so the desktop quality-picker
    // download path can replay them (KVS /get_file/ requires the site session).
    const payload = { ...videoData };
    // Enrich every variant with the REAL filename + exact size sniffed from
    // response headers (Content-Disposition / Content-Length). Without this
    // the desktop quality picker only knows resolution+size and users pick
    // the wrong video. Segments are dropped so one video never becomes many.
    try {
      const vids = Array.isArray(payload.videos) ? payload.videos : [];
      const seen = new Set();
      const enriched = [];
      const fbAudioByVid = new Map();
      const fbAudioByDir = new Map();
      let fbSoleAudio = null;
      for (const v of vids) {
        if (!v || !v.url || !/^https?:/i.test(v.url)) continue;
        // Facebook range-slices are partial chunks, never playable files:
        // rewrite to the full-file URL BEFORE dedup so all slices collapse
        // into the one downloadable progressive MP4.
        try { v.url = stripFbRange(v.url); } catch {}
        if (isSegmentUrl(v.url)) continue;
        if (isTwitterPlaylistUrl(v.url)) continue;
        // Facebook split-AV: Facebook now serves the picture and the sound as
        // TWO separate DASH renditions sharing an efg video_id. An audio-only
        // track is never a video row — remember it so its video track can be
        // muxed with it on the desktop (see audioUrl below).
        if (fbTrackKindOfUrl(v.url) === 'audio') {
          const vid = fbVideoIdOfUrl(v.url);
          if (vid && !fbAudioByVid.has(vid)) fbAudioByVid.set(vid, v.url);
          try {
            const dir = new URL(v.url).pathname.replace(/\/[^/]+$/, '');
            if (dir && !fbAudioByDir.has(dir)) fbAudioByDir.set(dir, v.url);
          } catch (e) {}
          if (!fbSoleAudio) fbSoleAudio = v.url;
          continue;
        }
        // Not-a-video filter: audio-typed responses (DASH audio slices as
        // .mp4) complete fine but contain no video — never offer them as
        // video rows in the desktop quality picker.
        try {
          const mm = getStreamMeta(v.url);
          if (dropVideoCandidate({ contentType: mm && mm.contentType })) continue;
        } catch (e) {}
        const n = normalizeSentUrl(v.url) || v.url;
        if (seen.has(n)) {
          // Merge missing fields into the surviving row instead of stacking.
          const prev = enriched.find(e => (normalizeSentUrl(e.url) || e.url) === n);
          if (prev) {
            if (!prev.filename) {
              const m0 = getStreamMeta(v.url);
              if (m0 && m0.filename) prev.filename = m0.filename;
              else if (v.filename) prev.filename = v.filename;
            }
            if (!prev.size) {
              const m0 = getStreamMeta(v.url);
              if (m0 && m0.size) prev.size = m0.size;
              else if (v.size) prev.size = v.size;
            }
          }
          continue;
        }
        seen.add(n);
        const meta = getStreamMeta(v.url);
        if (meta) {
          if (!v.filename && meta.filename) v.filename = meta.filename;
          if (!v.size && meta.size) v.size = meta.size;
        }
        // Fall back to a readable name derived from the real video/page title
        // + quality so the picker never shows a bare "videoplayback" hash with
        // no name. Per-video titles (KVS flashvars, JSON-LD) win over the page
        // title, and hostname-like placeholders ("mydaddy.cc") are rejected —
        // an untitled page leaves the filename empty so the desktop derives an
        // honest one from the URL / Content-Disposition instead.
        const srcTitle = (v.title && isRealTitle(v.title) ? String(v.title).trim().replace(/\s+/g, ' ').slice(0, 100) : null)
          || cleanTitle(payload.pageTitle);
        if (!v.filename && srcTitle) {
          const q = (v.quality && v.quality !== 'unknown') ? ` [${v.quality}]` : '';
          const ext = (v.format || (/\.([a-z0-9]{2,4})(\?|#|$)/i.exec(v.url) || [])[1] || 'mp4').toLowerCase();
          v.filename = `${srcTitle.replace(/[<>:\"/\\|?*\u0000-\u001f]/g, '_')}${q}.${ext}`;
        }
        enriched.push(v);
      }
      // Pair each Facebook video-only track with the audio-only track that
      // shares its efg video_id (or path directory / sole audio track). The
      // desktop downloads both and muxes them with FFmpeg — without this the
      // saved file has no sound.
      if (fbAudioByVid.size || fbAudioByDir.size || fbSoleAudio) {
        for (const v of enriched) {
          if (!v || v.audioUrl) continue;
          const vid = fbVideoIdOfUrl(v.url);
          if (vid && fbAudioByVid.has(vid)) {
            v.audioUrl = fbAudioByVid.get(vid);
            continue;
          }
          try {
            const dir = new URL(v.url).pathname.replace(/\/[^/]+$/, '');
            if (dir && fbAudioByDir.has(dir)) {
              v.audioUrl = fbAudioByDir.get(dir);
              continue;
            }
          } catch (e) {}
          // DASH video track + a single audio track on this page → pair them.
          if (fbSoleAudio && fbTrackKindOfUrl(v.url) === 'video') {
            v.audioUrl = fbSoleAudio;
          }
        }
      }
      // Same-file rows (token rotation, player re-fetches) collapse here so
      // the desktop quality picker never shows one video N times.
      payload.videos = collapseVideoRows(enriched);
    } catch (e) { /* enrichment is best-effort */ }
    if (!payload.cookies) {
      try {
        const hosts = new Set();
        if (payload.pageUrl) hosts.add(payload.pageUrl);
        (payload.videos || []).forEach(v => { if (v && v.url) hosts.add(v.url); });
        const all = await collectCookies(hosts);
        if (all.length) payload.cookies = all.join('; ');
      } catch (e) { /* cookies API unavailable */ }
    }
    const resp = await fetch(`${AIDM_API}/api/video-detected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return await resp.json();
  } catch {
    return null;
  }
}

// ── Intercept ALL Chrome Downloads ────────────────────────────────────────────
// This is the key change: intercept every download, not just filtered ones.
// AiDM becomes the system's download manager, just like IDM.

/**
 * Take a native download away from Chrome and hand it to AiDM.
 *
 * Contract notes that make this actually reliable:
 *  • The listener must RETURN true and call suggest() exactly once — an async
 *    function returns a Promise, which Chrome does NOT treat as the async
 *    signal for this event; suggest() then fires "after the listener returned"
 *    and Chrome carries on by itself.
 *  • Chrome's download is only PAUSED during the handoff. It is cancelled and
 *    erased AFTER AiDM has accepted it. The old code cancelled first, so a
 *    failed POST silently destroyed the user's download.
 */
function interceptDownload(downloadItem, suggest) {
  // Keep Chrome's copy alive (paused) until AiDM has really accepted the file.
  let pausedOk = false;
  try {
    chrome.downloads.pause(downloadItem.id, () => { pausedOk = !chrome.runtime.lastError; });
  } catch (e) { /* may already be complete — fall through */ }

  const fallBackToChrome = () => {
    // Give the download back: resume it and let Chrome use its own filename.
    if (pausedOk) { try { chrome.downloads.resume(downloadItem.id); } catch (e) {} }
    try { suggest({ filename: downloadItem.filename }); }
    catch (e) { try { suggest(); } catch (e2) { /* determination already closed */ } }
  };

  (async () => {
    if (!isConnected) await checkConnection();
    if (!isConnected) return fallBackToChrome();

    // Browser-takeover gate (v4.3.0): site exclusions, the Alt-prevent /
    // force-takeover hotkeys, then the file-type list. Explicit user actions
    // (capsule, popup, context menu) bypass this entirely — only automatic
    // interception of native downloads is gated.
    const targetUrl = downloadItem.finalUrl || downloadItem.url;
    if (!shouldTakeOver(targetUrl, {
      browserIntegration: settings.browserIntegration,
      interceptAll: settings.interceptAll,
      interceptFileTypes: settings.interceptFileTypes,
      excludedSites: settings.excludedSites,
      preventAt: keyPreventAt,
      forceAt: keyForceAt,
      nowMs: Date.now(),
    })) return fallBackToChrome();

    const sent = await sendToAiDM(
      downloadItem.finalUrl || downloadItem.url,
      downloadItem.filename,
      {
        referrer: downloadItem.referrer,
        fileSize: downloadItem.fileSize,
        mime: downloadItem.mime,
      }
    );

    if (sent && (sent.sent || sent.duplicate)) {
      // Handoff complete (or already in AiDM) — drop Chrome's own copy.
      try { chrome.downloads.cancel(downloadItem.id); } catch (e) {}
      try { chrome.downloads.erase({ id: downloadItem.id }); } catch (e) {}
      try { suggest(); } catch (e) { /* download already gone */ }
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: 'AiDM',
        message: (sent.duplicate ? 'Already in AiDM: ' : 'Download started: ') + downloadItem.filename,
      });
      return;
    }

    // AiDM refused or is unreachable — never destroy the user's download.
    fallBackToChrome();
  })();
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  interceptDownload(downloadItem, suggest);
  return true; // suggest() is called asynchronously — required by the API
});

// ── Context Menus ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'aidm-download-link',
    title: '⬇️ Download with AiDM',
    contexts: ['link'],
  });

  chrome.contextMenus.create({
    id: 'aidm-download-video',
    title: '🎬 Download video with AiDM',
    contexts: ['video', 'audio'],
  });

  chrome.contextMenus.create({
    id: 'aidm-download-image',
    title: '🖼️ Download image with AiDM',
    contexts: ['image'],
  });

  chrome.contextMenus.create({
    id: 'aidm-download-all',
    title: '📋 Download all links with AiDM',
    contexts: ['page', 'selection'],
  });

  chrome.contextMenus.create({
    id: 'aidm-download-browser',
    title: '🌐 Download with browser (fallback)',
    contexts: ['link', 'video', 'audio', 'image'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'aidm-download-link') {
    await sendToAiDM(info.linkUrl, extractFilename(info.linkUrl));
  } else if (info.menuItemId === 'aidm-download-video') {
    const url = info.srcUrl || info.linkUrl;
    await sendToAiDM(url, extractFilename(url));
  } else if (info.menuItemId === 'aidm-download-image') {
    await sendToAiDM(info.srcUrl, extractFilename(info.srcUrl));
  } else if (info.menuItemId === 'aidm-download-all') {
    chrome.tabs.sendMessage(tab.id, { action: 'collect-links' });
  } else if (info.menuItemId === 'aidm-download-browser') {
    // Last-resort native download (see nativeDownloadToBrowser): Chrome
    // fetches the file itself when the desktop engine is refused.
    const url = info.linkUrl || info.srcUrl;
    let tabUrl = null;
    try { tabUrl = tab && tab.url; } catch (e) {}
    const r = await nativeDownloadToBrowser({ url, filename: extractFilename(url), referrer: tabUrl });
    if (!r.success) {
      try {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon128.png',
          title: 'AiDM',
          message: 'Browser download failed: ' + (r.error || 'unknown error'),
        });
      } catch (e) {}
    }
  }
});

// ── Message Handling ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'batch-download') {
    sendBatchToAiDM(msg.urls).then(success => sendResponse({ success }));
    return true;
  }

  if (msg.action === 'single-download') {
    // Fall back to the filename sniffed from the response headers when the
    // caller has none — mirrors the name a native browser download would use.
    const sniff = getStreamMeta(msg.url);
    const filename = msg.filename || (sniff && sniff.filename) || undefined;
    sendToAiDM(msg.url, filename, msg.opts).then(r => sendResponse({ success: !!(r && r.success), duplicate: !!(r && r.duplicate) }));
    return true;
  }

  // Last-resort native download: Chrome fetches the file itself (correct
  // SameSite cookies, Sec-Fetch-*, TLS fingerprint) with the page Referer
  // injected via a short-lived session rule. For strict CDNs that refuse the
  // desktop engine (401/403/501) while the browser plays fine.
  if (msg.action === 'native-download') {
    nativeDownloadToBrowser({
      url: msg.url,
      filename: msg.filename,
      referrer: msg.referrer || msg.pageUrl || (msg.opts && (msg.opts.pageUrl || msg.opts.referrer)) || null,
    }).then(
      (r) => sendResponse(r),
      (err) => sendResponse({ success: false, error: String((err && err.message) || err) })
    );
    return true;
  }

  if (msg.action === 'check-connection') {
    checkConnection().then(connected => {
      sendResponse({ connected, intercepted: interceptedCount, settings });
    });
    return true;
  }

  if (msg.action === 'video-detected') {
    // Legacy alias: older content builds sent a bare `data` payload; the live
    // path is `videos-with-quality` (flat pageTitle/pageUrl/videos).
    sendVideoDetection(msg.data).then(result => {
      sendResponse({ ok: true, result });
    });
    return true;
  }

  if (msg.action === 'videos-with-quality') {
    // Content script found videos with quality variants
    sendVideoDetection({
      pageTitle: msg.pageTitle,
      pageUrl: msg.pageUrl,
      videos: msg.videos,
    }).then(result => {
      sendResponse({ ok: true, result });
    });
    return true;
  }

  // One round-trip for the capsule/popup: recent tab streams + sent URLs
  if (msg.action === 'get-panel-data') {
    const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
    // Page-load floor for stream freshness. Content scripts send their own
    // performance.timeOrigin; the popup has no page clock, so fall back to
    // the tab's last-navigation time recorded by this worker.
    const since = (typeof msg.since === 'number' && msg.since > 0)
      ? msg.since
      : (tabNavAt.get(tabId) || 0);
    // Attach fresh response metadata (native filename + exact size) so the
    // capsule rows mirror what a browser download would have produced.
    const now = Date.now();
    const meta = {};
    for (const [k, v] of streamMeta) {
      if (now - v.time < META_KEEP_MS) {
        meta[k] = { filename: v.filename, size: v.size, contentType: v.contentType };
      }
    }
    sendResponse({ streams: getTabStreams(tabId, since), sent: [...sentExact].slice(-500), meta, dashActive: isDashActiveTab(tabDashActive, tabId) });
    return false;
  }

  // Capsule link liveness check — see probeStreamUrl() above.
  if (msg.action === 'probe-streams') {
    probeStreamUrls(msg.urls, msg.referrer).then(probes => sendResponse({ probes }));
    return true;
  }

  // Embed resolution via the real browser network stack — fallback for when
  // the desktop's own page fetch is bot-walled (mydaddy.cc serves some
  // clients a stub). If this tab can play the video, this fetch can read the
  // player page (Chrome TLS fingerprint, user cookies, residential IP).
  // Variants are forwarded as video-detected so the normal quality picker
  // opens on the desktop.
  if (msg.action === 'resolve-embed') {
    resolveEmbedViaBrowser(msg.url, msg.referrer).then(
      async (r) => {
        try {
          await fetch(`${AIDM_API}/api/video-detected`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pageTitle: r.title,
              pageUrl: r.canonicalUrl,
              thumbnail: r.thumbnail || undefined,
              duration: r.duration || undefined,
              provider: r.provider,
              videos: r.videos,
              cookies: r.cookies || undefined,
            }),
            signal: AbortSignal.timeout(5000),
          });
        } catch (e) { /* desktop unreachable — still report what we found */ }
        sendResponse({ success: true, count: r.videos.length, title: r.title, videos: r.videos });
      },
      (err) => sendResponse({ success: false, error: String((err && err.message) || err) })
    );
    return true;
  }

  // Takeover hotkey state from the content script's key tracker. `false`
  // clears immediately; otherwise entries expire via keyFresh() so a stuck
  // key can never hijack downloads forever.
  if (msg.action === 'key-state') {
    const now = Date.now();
    if (msg.prevent) keyPreventAt = now; else if (msg.prevent === false) keyPreventAt = 0;
    if (msg.force) keyForceAt = now; else if (msg.force === false) keyForceAt = 0;
    sendResponse({ ok: true });
    return false;
  }

  // Content scripts ask for the configured force-takeover key.
  if (msg.action === 'get-settings') {
    sendResponse({ forceTakeoverKey: settings.forceTakeoverKey || 'Shift' });
    return false;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Embed parsers (mydaddy.cc / hqporner.com) ───────────────────────────────
// Pure logic mirrors src/embed-resolver.js — keep the two in sync.
// test/embed-resolver.js asserts behavioral parity on shared fixtures, so a
// drift here fails the suite rather than surprising users.
const QUALITY_RESOLUTION = {
  2160: '3840x2160',
  1440: '2560x1440',
  1080: '1920x1080',
  720: '1280x720',
  480: '854x480',
  360: '640x360',
  240: '426x240',
};

function qualityFromLabel(h) {
  const m = /(\d{3,4})\s*p\b/i.exec(String(h || ''));
  if (!m) return null;
  const height = parseInt(m[1], 10);
  return QUALITY_RESOLUTION[height] ? height : null;
}

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
    if (c && !(hostname && c.toLowerCase() === String(hostname).toLowerCase())) return c;
  }
  m = /<h1[^>]*>([\s\S]{2,200}?)<\/h1\s*>/i.exec(html || '');
  if (m) {
    const c = clean(textOf(m[1]));
    if (c) return c;
  }
  return null;
}

function extractMydaddyEmbed(html) {
  const src = String(html || '');
  let m = /<iframe[^>]+src=["'](\/\/mydaddy\.cc\/video\/[A-Za-z0-9]+\/?(?:&alt)?)["']/i.exec(src);
  if (m) {
    const base = ('https:' + m[1].replace(/&amp;/g, '&')).split('&alt')[0].replace(/\/+$/, '');
    return base + '/';
  }
  m = /\/(?:blocks\/)?(?:alt|native)player\.php\?i=\/\/mydaddy\.cc\/video\/([A-Za-z0-9]+)\/?/i.exec(src);
  if (m) return 'https://mydaddy.cc/video/' + m[1] + '/';
  m = /mydaddy\.cc\/video\/([A-Za-z0-9]{8,})/i.exec(src);
  if (m) return 'https://mydaddy.cc/video/' + m[1] + '/';
  return null;
}

function extractMydaddyVariants(html, pageUrl) {
  const src = String(html || '');
  const found = new Map();
  const mpdSeen = new Set();
  let mpdCount = 0;
  const take = (raw, labelHint) => {
    if (!raw || typeof raw !== 'string') return;
    let u = raw.trim().replace(/&amp;/g, '&').replace(/["'\),;\\]+$/, '');
    if (!u) return;
    if (u.startsWith('//')) u = 'https:' + u;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) {
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
    if (!isMp4 && !isHls) return;
    if (/\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|css|js|vtt|srt|woff2?)(\?|#|$)/i.test(u)) return;
    try {
      const normalized = new URL(u, pageUrl || undefined).href;
      if (!found.has(normalized)) {
        found.set(normalized, { url: normalized, format: isHls ? 'hls' : 'mp4', labelHint: labelHint || null });
      }
    } catch (e) { /* malformed URL — skip */ }
  };
  const attrRe = /(?:href|src)\s*=\s*["']((?:https?:)?\/\/[^"'<>\s]+\.(?:mp4|m4v|webm|mkv|mov|m3u8|mpd)[^"'<>\s]*|[^"'<>\s]+\.(?:mp4|m4v|webm|mkv|mov|m3u8|mpd)[^"'<>\s]*)["']/gi;
  let m;
  while ((m = attrRe.exec(src)) !== null) take(m[1]);
  const jsRe = /(?:video_(?:url|alt_url\d*)|["']?(?:file|src|url|source)["']?)\s*[:=]\s*["']([^"']+\.(?:mp4|m4v|webm|mkv|mov|m3u8|mpd)[^"']*)["']/gi;
  while ((m = jsRe.exec(src)) !== null) take(m[1]);
  const out = [];
  for (const entry of found.values()) {
    const url = entry.url, format = entry.format, labelHint = entry.labelHint;
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
      const anyQ = /(\d{3,4})p/i.exec(url);
      if (anyQ && QUALITY_RESOLUTION[parseInt(anyQ[1], 10)]) height = parseInt(anyQ[1], 10);
    }
    if (!height && labelHint) {
      const lh = qualityFromLabel(labelHint);
      if (lh) height = lh;
    }
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
      quality: height ? height + 'p' : 'unknown',
    });
  }
  out.sort((a, b) => (Number(b.isMp4) - Number(a.isMp4)) ||
                     (b.height - a.height) || (b.bitrate - a.bitrate));
  out._mpdCount = mpdCount;
  return out;
}

function extractDurationSeconds(html) {
  const src = String(html || '');
  let m = /(\d+)\s*min\s*(\d+)\s*sec/i.exec(src) || /(\d+)\s*m\s*(\d+)\s*s\b/i.exec(src);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = /duration["']?\s*[:=]\s*["']?(\d+)\s*:\s*(\d{1,2})/i.exec(src);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

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
    .replace(/[<>:\"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/** Minimal page-URL shape check (mirrors parseEmbedUrl in src/embed-resolver.js). */
function parseEmbedUrlShape(input) {
  let u;
  try { u = new URL(String(input == null ? '' : input).trim()); }
  catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'mydaddy.cc' || host === 'www.mydaddy.cc') {
    const m = /^\/video\/([A-Za-z0-9]+)\/?(?:[?&]alt)?\/?$/i.exec(u.pathname);
    if (!m) return null;
    return { provider: 'mydaddy', id: m[1], pageUrl: 'https://mydaddy.cc/video/' + m[1] + '/' };
  }
  if (host === 'hqporner.com' || host === 'www.hqporner.com' || host === 'm.hqporner.com') {
    const m = /^\/hdporn\/(\d+)-([^/]*)\.html$/i.exec(u.pathname);
    if (!m) return null;
    const slug = /^[A-Za-z0-9_-]{1,120}$/.test(m[2] || '') ? m[2] : 'video';
    return { provider: 'hqporner', id: m[1], pageUrl: 'https://hqporner.com/hdporn/' + m[1] + '-' + slug + '.html' };
  }
  return null;
}

/**
 * Resolve a mydaddy/hqporner page with the browser's own network stack.
 * Same result shape as resolveEmbedVideos in src/embed-resolver.js, plus the
 * session cookies the desktop quality-picker download replays.
 */
async function resolveEmbedViaBrowser(url, referrer) {
  const parsed = parseEmbedUrlShape(url);
  if (!parsed) throw new Error('Not a mydaddy.cc or hqporner.com video URL');

  const fetchHtmlBrowser = async (target, ref) => {
    const headers = {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': (navigator.language || 'en-US') + ',en;q=0.9',
    };
    if (ref) headers.Referer = ref;
    const resp = await fetch(target, {
      credentials: 'include',
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const text = await resp.text();
    if (text.length > 3 * 1024 * 1024) throw new Error('page too large');
    return { html: text, finalUrl: resp.url || target };
  };

  let mydaddyUrl;
  let title = null, thumbnail = null, duration = null;
  if (parsed.provider === 'hqporner') {
    let hqHtml;
    try {
      hqHtml = (await fetchHtmlBrowser(parsed.pageUrl, referrer)).html;
    } catch (e) {
      throw new Error('Could not load the hqporner page (' + (e.message || e) + ')');
    }
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
    mdHtml = (await fetchHtmlBrowser(mydaddyUrl, parsed.provider === 'hqporner' ? parsed.pageUrl : referrer)).html;
  } catch (e) {
    throw new Error('Could not load the mydaddy player page (' + (e.message || e) + ')');
  }
  if (!title) title = extractEmbedTitle(mdHtml, 'mydaddy.cc');
  if (!thumbnail) thumbnail = extractThumbnail(mdHtml, mydaddyUrl);
  const variants = extractMydaddyVariants(mdHtml, mydaddyUrl);
  if (!variants.length) {
    if (variants._mpdCount > 0) {
      throw new Error('This page only offers DASH streams (.mpd), which AiDM cannot download yet');
    }
    throw new Error('No downloadable video found on this page (it may have been removed or require login)');
  }

  const label = safeTitle(title || 'video', 'video');
  const videos = variants.map((v) => {
    const isHls = v.isMp4 === false;
    return {
      url: v.url,
      quality: v.quality || 'unknown',
      resolution: v.width && v.height ? v.width + 'x' + v.height : null,
      format: isHls ? 'hls' : 'mp4',
      size: null,
      filename: label + (v.quality && v.quality !== 'unknown' ? ' [' + v.quality + ']' : '') + '.' + (isHls ? 'm3u8' : 'mp4'),
    };
  });

  // Session cookies for the desktop quality-picker download path.
  let cookies = null;
  try {
    const hosts = new Set([mydaddyUrl, new URL(mydaddyUrl).hostname]);
    if (parsed.provider === 'hqporner') {
      hosts.add(parsed.pageUrl);
      try { hosts.add(new URL(parsed.pageUrl).hostname); } catch (e) {}
    }
    const all = await collectCookies(hosts);
    if (all.length) cookies = all.join('; ');
  } catch (e) { /* cookies API unavailable — proceed without */ }

  return {
    provider: parsed.provider,
    id: parsed.provider === 'hqporner' ? parsed.id : mydaddyIdShape(mydaddyUrl),
    title: label,
    thumbnail,
    duration,
    canonicalUrl: mydaddyUrl,
    videos,
    cookies,
  };
}

function mydaddyIdShape(pageUrl) {
  const m = /\/video\/([A-Za-z0-9]+)/i.exec(String(pageUrl || ''));
  return m ? m[1] : 'video';
}

// Browser-takeover controls (v4.3.0, original AiDM implementation).
// Pure functions — the regression harness (test/interception.js) extracts and
// exercises the SHIPPED definitions below.

/** True when the URL's file extension is on the auto-capture type list. */
function matchesFileType(url, types) {
  try {
    const list = Array.isArray(types) ? types : [];
    if (!list.length) return false;
    const set = new Set(list.map(t => String(t).toLowerCase().replace(/^\.+/, '')));
    const pathname = new URL(String(url)).pathname;
    const parts = pathname.split('/').filter(Boolean);
    const base = parts.length ? decodeURIComponent(parts.pop()) : '';
    const m = /\.([A-Za-z0-9]{1,10})$/.exec(base);
    if (!m) return false;
    return set.has(m[1].toLowerCase());
  } catch (e) { return false; }
}

/** True when the URL belongs to an excluded site (exact or subdomain). */
function isExcludedSite(url, sites) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return false;
    for (const s of (sites || [])) {
      const site = String(s).toLowerCase().trim().replace(/\.$/, '');
      if (!site) continue;
      if (host === site || host.endsWith('.' + site)) return true;
    }
    return false;
  } catch (e) { return false; }
}

/** True when a hotkey timestamp is still fresh (not expired). */
function keyFresh(ts, nowMs) {
  const t = Number(ts) || 0;
  const now = Number(nowMs) || Date.now();
  return t > 0 && (now - t) < KEY_STATE_TTL_MS;
}

/**
 * Should AiDM automatically take over this native browser download?
 * Explicit user actions (capsule/popup/menu) never consult this — only the
 * automatic downloads-API interception does.
 */
function shouldTakeOver(url, opts) {
  const o = opts || {};
  if (o.browserIntegration === false) return false;
  if (isExcludedSite(url, o.excludedSites)) return false;
  if (keyFresh(o.preventAt, o.nowMs)) return false;
  if (keyFresh(o.forceAt, o.nowMs)) return true;
  if (o.interceptAll !== false) return true;
  return matchesFileType(url, o.interceptFileTypes);
}

// ── Native browser fallback (v4.3.2, original AiDM implementation) ─────────
// Pure rule builder (test/browser-engine.js extracts the SHIPPED definition).

const AIDM_DNR_RULE_BASE = 7000;
let aidmDnrNextId = AIDM_DNR_RULE_BASE;

/** Session DNR rule setting the page Referer for one download host. */
function buildAidmRefererRule(id, domain, referer) {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Referer', operation: 'set', value: String(referer).slice(0, 512) }],
    },
    condition: {
      urlFilter: '||' + domain + '/',
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other'],
    },
  };
}

/** Ensure a short-lived Referer rule for the download host. Never throws. */
async function ensureAidmRefererRule(url, referer) {
  if (!chrome.declarativeNetRequest || !url || !referer) return false;
  let domain = '';
  try { domain = new URL(String(url)).hostname; } catch (e) { return false; }
  if (!domain) return false;
  try {
    const filter = '||' + domain + '/';
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ours = (rules || []).filter(r => r && r.id >= AIDM_DNR_RULE_BASE);
    const covered = ours.some(r => r.condition && r.condition.urlFilter === filter &&
      ((r.action && r.action.requestHeaders) || []).some(h => String(h.header || '').toLowerCase() === 'referer'));
    if (covered) return true;
    if (ours.length > 20) {
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ours.map(r => r.id) });
        aidmDnrNextId = AIDM_DNR_RULE_BASE;
      } catch (e) { /* continue with a fresh id anyway */ }
    }
    const ruleId = aidmDnrNextId++;
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [buildAidmRefererRule(ruleId, domain, referer)],
    });
    // Session rules die with the browser session anyway; drop ours early so
    // a later download never inherits a stale Referer.
    setTimeout(() => {
      try {
        chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
      } catch (e) {}
    }, 5 * 60 * 1000);
    return true;
  } catch (e) { return false; }
}

/**
 * Download via Chrome itself. SameSite cookies, Sec-Fetch-* and the TLS
 * fingerprint are exactly right because it IS the browser downloading.
 * @returns {Promise<{success: boolean, downloadId?: number, error?: string}>}
 */
async function nativeDownloadToBrowser({ url, filename, referrer }) {
  if (!url || !/^https?:/i.test(String(url))) {
    return { success: false, error: 'Missing url' };
  }
  try {
    if (referrer) await ensureAidmRefererRule(url, referrer);
    const name = (filename && String(filename).trim()) || extractFilename(url);
    const downloadId = await chrome.downloads.download({
      url: String(url),
      filename: name,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: 'AiDM',
        message: 'Browser download started: ' + name,
      });
    } catch (e) {}
    return { success: true, downloadId };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
}

function extractFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    let name = pathname.split('/').pop();
    if (!name || name === '/') name = 'download';
    return decodeURIComponent(name);
  } catch {
    return 'download';
  }
}

// Periodic connection check
setInterval(checkConnection, 30000);
checkConnection();
