// Streamtape resolver (+ yesporn.io "async block" page → embed chain).
//
// WHY THIS EXISTS
// ---------------
// yesporn.io is a KVS-style tube AGGREGATE: its video pages hold no media at
// all. The player is a same-origin `/embed/<id>` iframe, and even that embed
// is a click-gate shell — any click first opens an ad popunder, then an
// `api.php?mode=async&function=get_block` XHR injects the REAL player: a
// third-party Streamtape iframe. Streamtape serves the file as ONE
// progressive MP4 behind an extensionless, signed redirect:
//
//   https://streamtape.to/get_video?id=<id>&expires=<ts>&ip=<hash>&token=<tok>
//     → 302 → https://<node>.tapecontent.net/radosgw/<id>/<signed>/<title>
//       200/206 · video/mp4 · full Range support · no Referer/Cookie needed
//
// The signed target rotates per request; the get_video token is bound to the
// IP that fetched the embed and lives for days. The embed HTML carries the
// complete query in every server variant (hidden #robotlink/#botlink/
// #ideoolink divs plus innerHTML scripts that "de-obfuscate" the very same
// string — the nonce-stripping is theatre), so a plain GET with browser-ish
// headers yields it deterministically. Verified live 2026-11-17 on
// yesporn.io → streamtape.to/e/ak8oXaq7Doi0xg (620 MB mp4, Range 206).
//
// WHY AiDM MISSED IT: `/get_video` has no media extension and matches
// none of the generic CDN/path heuristics, the yesporn page never exposes a
// media URL pre-click, and no resolver spoke Streamtape — so pasting any of
// the four user-visible URLs or sniffing the playing player found nothing
// downloadable. This module closes that gap end to end; the extension's
// PATH_RE/STREAM_PATH_RE additions route `/get_video` traffic here.
//
// The resolver always RE-MINTS a fresh token at click time (a sniffed
// /get_video link is re-scraped from its embed page), so an expired or
// IP-shifted link still resolves — never download through a stale signature.
//
// Security (same rules as src/embed-resolver.js):
//   • Only identifiers are parsed from user input. Fetches go to URLs we
//     construct on an allowlist (yesporn.io, streamtape family); anything
//     else is refused before a socket is opened — no open fetcher.
//   • The 302 mint request reads headers only (socket destroyed, no body);
//     the redirect target is host-checked (tapecontent.net / streamtape
//     family) before it is ever handed to the engine. The engine downloads
//     the target directly with Range requests.

'use strict';

const https = require('https');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

// Streamtape's embed family. Explicit list, never a wildcard — this is the
// allowlist every fetch and the redirect-target check run against.
const STREAMTAPE_SUFFIXES = [
  'streamtape.com', 'streamtape.to', 'streamtape.net', 'streamtape.co',
  'streamta.pe', 'stape.io',
];

// One complete, signed get_video query. Anchored hard: id/expires/ip/token
// all present, nothing else — the remotecaption/thumb tokens on the same
// page must never match (they carry no `get_video?id=` prefix).
const GET_VIDEO_QUERY_RE =
  /get_video\?(id=[A-Za-z0-9_-]{4,64}&expires=\d{8,14}&ip=[^&"'`\s<>]{2,80}&token=[A-Za-z0-9_-]{4,80})/i;

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function isStreamtapeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return STREAMTAPE_SUFFIXES.some(sfx => h === sfx || h.endsWith('.' + sfx));
}

/** streamtape family embed/player page: /e/<id> or /v/<id>. */
function parseStreamtapeEmbed(input) {
  let u;
  try { u = new URL(String(input == null ? '' : input).trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isStreamtapeHost(u.hostname)) return null;
  const m = /^\/(?:e|v)\/([A-Za-z0-9_-]{4,64})\/?$/i.exec(u.pathname);
  if (!m) return null;
  return { host: u.hostname.toLowerCase(), id: m[1], pageUrl: 'https://' + u.hostname.toLowerCase() + '/e/' + m[1] + '/' };
}

/** A sniffed direct link: /get_video with a signed query (id+token required). */
function parseStreamtapeDirect(input) {
  let u;
  try { u = new URL(String(input == null ? '' : input).trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isStreamtapeHost(u.hostname)) return null;
  if (!/^\/get_video\/?$/i.test(u.pathname)) return null;
  const id = u.searchParams.get('id');
  const token = u.searchParams.get('token');
  const expires = u.searchParams.get('expires');
  const ip = u.searchParams.get('ip');
  if (!id || !token || !expires || !ip) return null;
  // Rebuild the query from ONLY the four signed params — &stream=1/&plain=1
  // (player chrome) and any extra params are dropped so the mint is clean.
  const query = 'id=' + encodeURIComponent(id) +
    '&expires=' + encodeURIComponent(expires) +
    '&ip=' + encodeURIComponent(ip) +
    '&token=' + encodeURIComponent(token);
  return { host: u.hostname.toLowerCase(), id, query };
}

/** yesporn.io video page (`/<slug>-<id>`) or its async-block embed (`/embed/<id>`). */
function parseYespornUrl(input) {
  let u;
  try { u = new URL(String(input == null ? '' : input).trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'yesporn.io' && host !== 'www.yesporn.io') return null;
  let m = /^\/embed\/(\d{2,12})\/?$/i.exec(u.pathname);
  if (m) return { host: 'yesporn.io', id: m[1], kind: 'embed', canonicalPageUrl: 'https://yesporn.io/embed/' + m[1] };
  m = /^\/[a-z0-9-]{2,120}-(\d{2,12})\/?$/i.exec(u.pathname);
  if (m && !/^\/(?:embed|search|support|signup|login)/i.test(u.pathname)) {
    return { host: 'yesporn.io', id: m[1], kind: 'page', canonicalPageUrl: 'https://yesporn.io/embed/' + m[1] };
  }
  return null;
}

function isStreamtapeUrl(input) {
  return parseStreamtapeEmbed(input) !== null || parseStreamtapeDirect(input) !== null;
}

function isYespornUrl(input) {
  return parseYespornUrl(input) !== null;
}

/** First complete signed query in an embed page (entity-decoded first). */
function extractStreamtapeQuery(html) {
  const hay = decodeHtmlEntities(String(html || ''));
  const m = GET_VIDEO_QUERY_RE.exec(hay);
  return m ? m[1] : null;
}

/**
 * The click-gate's own XHR target, from the /embed/<id> shell:
 *   GET https://yesporn.io/api.php?mode=async&function=get_block&block_id=<b>&id=<n>
 * The shell hardcodes block_id=video_view_api_video_view for video pages, but
 * read it from the page when present so theme changes do not break the chain.
 */
function extractYespornBlock(embedHtml) {
  const hay = decodeHtmlEntities(String(embedHtml || ''));
  const m = /[?&]block_id=([a-z0-9_]+)[&"']/i.exec(hay);
  const n = /[?&]id=(\d{2,12})[&"']/i.exec(hay);
  return { blockId: m ? m[1] : 'video_view_api_video_view', id: n ? n[1] : null };
}

/** First <iframe src> of the async-block response that lives on Streamtape. */
function extractEmbedIframeSrc(blockHtml) {
  const hay = decodeHtmlEntities(String(blockHtml || ''));
  const re = /<iframe[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(hay)) !== null) {
    let abs;
    try { abs = new URL(m[1], 'https://yesporn.io/'); } catch (e) { continue; }
    if (isStreamtapeHost(abs.hostname)) return 'https://' + abs.hostname.toLowerCase() + abs.pathname + abs.search;
  }
  return null;
}

/** Real player title from the embed's config JSON, else null. */
function extractStreamtapeTitle(embedHtml) {
  const m = /"showtitle"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(embedHtml || ''));
  if (!m) return null;
  let s;
  try { s = JSON.parse('"' + m[1] + '"'); } catch (e) { s = m[1]; }
  s = String(s || '').trim();
  return s.length >= 2 ? s : null;
}

/** Poster thumb from the embed's config JSON, else null. The config JSON
 * escapes slashes (`\/`) — unescape before handing the URL around. */
function extractStreamtapePoster(embedHtml) {
  const m = /"poster"\s*:\s*"(https:[^"]+)"/.exec(String(embedHtml || ''));
  if (!m) return null;
  return m[1].replace(/\\\//g, '/');
}

/** Filesystem-safe name: path/query metacharacters → spaces, plus-signs (the
 * URL-ized spaces in the tapecontent path tail) → spaces, collapsed. */
function sanitizeFilename(s) {
  let out = String(s || '')
    .replace(/[%+]+/g, ' ')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (out.length > 120) out = out.slice(0, 120).trim().replace(/[. ]+$/, '');
  return out;
}

/** Title from the signed redirect target's path tail, else null. The
 * tapecontent path tail URL-izes spaces as `+` — normalize them back. */
function titleFromSignedUrl(u) {
  try {
    const x = new URL(String(u));
    const tail = decodeURIComponent(x.pathname.split('/').pop() || '').replace(/\+/g, ' ');
    const noExt = tail.replace(/\.(mp4|m4v|mkv|mov|webm|ts)$/i, '');
    return noExt.length >= 2 ? noExt : null;
  } catch (e) { return null; }
}

// ── Page fetching (allowlisted hosts only) ─────────────────────────────────

function fetchHtml(url, { referer = null, timeoutMs = REQUEST_TIMEOUT_MS, redirectCount = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 3) { reject(new Error('Too many redirects while resolving the video page')); return; }
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error('Invalid URL')); return; }
    if (parsed.protocol !== 'https:') { reject(new Error('Refusing non-https page fetch')); return; }
    if (!(isStreamtapeHost(parsed.hostname) || /(^|\.)yesporn\.io$/i.test(parsed.hostname))) {
      reject(new Error('Resolver refuses to fetch off-allowlist host: ' + parsed.hostname));
      return;
    }
    const req = https.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'iframe',
        ...(referer ? { Referer: referer } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let target;
        try { target = new URL(res.headers.location, url); } catch (e) { reject(e); return; }
        if (!(isStreamtapeHost(target.hostname) || /(^|\.)yesporn\.io$/i.test(target.hostname))) {
          reject(new Error('Video page redirected to an unexpected host'));
          return;
        }
        resolve(fetchHtml(target.toString(), { referer, timeoutMs, redirectCount: redirectCount + 1 }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('Video page returned HTTP ' + res.statusCode));
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

/**
 * Mint a fresh signed download URL: GET the /get_video link, DO NOT follow
 * the 302 — return its Location. Headers only; the socket is destroyed as
 * soon as the response head arrives.
 */
function mintDirectUrl(getVideoUrl, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(getVideoUrl); } catch (e) { reject(new Error('Invalid get_video URL')); return; }
    if (parsed.protocol !== 'https:' || !isStreamtapeHost(parsed.hostname)) {
      reject(new Error('get_video host is not on the Streamtape allowlist'));
      return;
    }
    const req = https.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': CHROME_UA, Accept: '*/*' },
      timeout: timeoutMs,
    }, (res) => {
      const loc = res.headers.location;
      const status = res.statusCode || 0;
      res.resume();               // drain/discard the body
      req.destroy();              // headers are all we need
      if (status >= 300 && status < 400 && loc) {
        try {
          const target = new URL(loc, getVideoUrl);
          // Only hand the engine a target on Streamtape's own storage family —
          // this resolver must never turn into a generic redirect proxy.
          if (isStreamtapeHost(target.hostname) || /(^|\.)tapecontent\.net$/i.test(target.hostname)) {
            resolve(target.toString());
            return;
          }
          reject(new Error('Signed redirect target is off the Streamtape storage family'));
        } catch (e) { reject(e); }
        return;
      }
      reject(new Error('get_video did not redirect (HTTP ' + status + ')'));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('get_video request timed out')); });
    req.end();
  });
}

/**
 * Mint a VALID token by loading the embed page in a real Chromium context.
 *
 * Verified live (2026-11-17): tokens minted to non-browser clients (plain
 * node/curl page fetches — browser-ish headers included) are poisoned — the
 * /get_video endpoint answers 200 {"status":500,"msg":"Sorry, error on our
 * side!"} instead of the 302, for every header combination and every
 * &stream=1/&plain=1 suffix. Tokens minted by a real page load (Chromium TLS
 * + full page JS) validate from anywhere afterwards — node/curl get the 302
 * just fine. AiDM runs as Electron, so a hidden BrowserWindow IS the browser
 * context: load the embed, wait for the page's own scripts to populate the
 * hidden link divs, hand that URL to mintDirectUrl(). Popups/popunders are
 * denied and off-site navigations abort — the window never surfaces ads.
 *
 * Resolves null when not running inside Electron (plain node resolves the
 * electron package to a path string) or on any failure — callers fall back.
 */
function mintViaElectron(embedUrl, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    let electron;
    try { electron = require('electron'); } catch (e) { resolve(null); return; }
    if (!electron || typeof electron !== 'object' || typeof electron.BrowserWindow !== 'function') {
      resolve(null); return;   // plain node: electron module exports a path string
    }
    let win = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (win && !win.isDestroyed()) {
          // If this hidden window is the app's ONLY window, destroying it
          // fires 'window-all-closed' and the host quits under us — a resolve
          // would kill its own host (AiDM itself always keeps its main window
          // alive in the tray, so this only bites bare Electron scripts).
          // Destroy alongside other windows; otherwise just hide — app
          // teardown cleans the rest up.
          const others = electron.BrowserWindow.getAllWindows().filter(w => w !== win);
          if (others.length > 0) win.destroy(); else win.hide();
        }
      } catch (e) { /* already gone */ }
      resolve(value);
    };
    try {
      const { BrowserWindow } = electron;
      win = new BrowserWindow({
        show: false,
        width: 640,
        height: 480,
        webPreferences: {
          // The page's own scripts build the link — keep JS and timers alive.
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
    } catch (e) { finish(null); return; }
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (e, url) => {
        // A popunder steering the hidden window away ends the attempt.
        if (!/streamtape/i.test(String(url || ''))) {
          try { e.preventDefault(); } catch (e2) { /* ignore */ }
          clearTimeout(timer);
          finish(null);
        }
      });
    } catch (e) { /* older Electron — polling below still guards */ }
    const poll = async (started) => {
      if (settled) return;
      try {
        if (win.isDestroyed()) { clearTimeout(timer); finish(null); return; }
        if (!/streamtape/i.test(String(win.webContents.getURL() || ''))) {
          clearTimeout(timer); finish(null); return;
        }
        const link = await win.webContents.executeJavaScript(
          "(function(){var el=document.getElementById('botlink')||document.getElementById('robotlink');var t=el?String(el.textContent||''):'';t=t.trim();return /get_video\\?/.test(t)?t:'';})()");
        if (link && /^\/\//.test(link.trim())) {
          clearTimeout(timer);
          let abs = String(link).trim();
          if (abs.startsWith('//')) abs = 'https:' + abs;
          else if (abs.startsWith('/')) abs = 'https://streamtape.to' + abs;
          finish(abs);
          return;
        }
      } catch (e) { /* page still loading or renderer busy */ }
      if (Date.now() - started > timeoutMs - 2000) { clearTimeout(timer); finish(null); return; }
      setTimeout(() => poll(started), 400);
    };
    win.webContents.on('did-finish-load', () => poll(Date.now()));
    win.loadURL(embedUrl).catch(() => { clearTimeout(timer); finish(null); });
  });
}

/** yesporn.io page/embed → the Streamtape embed URL behind the click-gate. */
async function resolveYespornEmbed(ys, fetchHtmlDep) {
  const referer = ys.kind === 'page'
    ? 'https://yesporn.io/' // slug pages vary; the shell accepts the site root
    : ys.canonicalPageUrl;
  const embedShell = await fetchHtmlDep('https://yesporn.io/embed/' + ys.id, { referer });
  const block = extractYespornBlock(embedShell);
  const blockId = block.blockId || 'video_view_api_video_view';
  const blockIdNum = block.id || ys.id;
  const blockHtml = await fetchHtmlDep(
    'https://yesporn.io/api.php?mode=async&function=get_block&block_id=' + encodeURIComponent(blockId) + '&id=' + encodeURIComponent(blockIdNum),
    { referer: 'https://yesporn.io/' });
  const src = extractEmbedIframeSrc(blockHtml);
  if (!src) {
    throw new Error('The page embeds no supported player (its player iframe is missing or uses an unsupported host)');
  }
  return src;
}

/**
 * Resolve any supported URL into a fresh signed progressive-MP4 variant.
 * Inject deps.fetchHtml / deps.mintDirectUrl in tests.
 */
async function resolveStreamtapeVideos(input, deps = {}) {
  const fetchHtmlDep = deps.fetchHtml || fetchHtml;
  const mintDep = deps.mintDirectUrl || mintDirectUrl;

  let stage = null;               // { kind, id, query, host, embedUrl, embedHtml }
  const direct = parseStreamtapeDirect(input);
  if (direct) {
    stage = { kind: 'direct', id: direct.id, query: direct.query, host: direct.host, embedUrl: null, embedHtml: null };
  }
  if (!stage) {
    const stEmbed = parseStreamtapeEmbed(input);
    if (stEmbed) {
      const html = await fetchHtmlDep(stEmbed.pageUrl, { referer: null });
      const query = extractStreamtapeQuery(html);
      if (!query) throw new Error('The Streamtape player page did not expose its video link (the video may have been removed)');
      stage = { kind: 'streamtape', id: stEmbed.id, query, host: stEmbed.host, embedUrl: stEmbed.pageUrl, embedHtml: html };
    }
  }
  if (!stage) {
    const ys = parseYespornUrl(input);
    if (ys) {
      const embedUrl = await resolveYespornEmbed(ys, fetchHtmlDep);
      const html = await fetchHtmlDep(embedUrl, { referer: 'https://yesporn.io/' });
      const query = extractStreamtapeQuery(html);
      if (!query) throw new Error('The Streamtape player page did not expose its video link (the video may have been removed)');
      const parsed = parseStreamtapeEmbed(embedUrl);
      stage = { kind: 'yesporn', id: ys.id, query, host: parsed ? parsed.host : new URL(embedUrl).hostname, embedUrl, embedHtml: html };
    }
  }
  if (!stage) throw new Error('Not a Streamtape or yesporn.io video URL');

  // Mint a fresh signed download link. Token validity is mint-context
  // sensitive (see mintViaElectron): prefer the hidden-window mint, then try
  // the plain-node mint on the scraped token (works whenever that page fetch
  // happened to mint validly). A mint that fails is FATAL — never hand the
  // engine a poisoned link, or the "download" would be a 48-byte JSON error
  // body saved as .mp4 (verified: 200 {"status":500} instead of the 302).
  const getVideoUrl = 'https://' + stage.host + '/get_video?' + stage.query;

  let signedUrl = null;
  let lastMintErr = null;
  const electronMint = deps.mintViaElectron !== undefined
    ? deps.mintViaElectron
    : mintViaElectron;
  try {
    const browserMinted = await electronMint(
      stage.embedUrl || ('https://' + stage.host + '/e/' + stage.id + '/'));
    if (browserMinted && /get_video\?/.test(browserMinted)) {
      signedUrl = await mintDep(browserMinted);
    }
  } catch (e) { lastMintErr = e; }
  if (!signedUrl) {
    try { signedUrl = await mintDep(getVideoUrl); } catch (e) { lastMintErr = e; }
  }
  if (!signedUrl) {
    const why = lastMintErr && lastMintErr.message ? ' (' + lastMintErr.message + ')' : '';
    throw new Error('Could not mint a fresh Streamtape download link' + why + ' — try again in a minute');
  }

  const embedHtml = stage.embedHtml || '';
  let title = titleFromSignedUrl(signedUrl) ||
    extractStreamtapeTitle(embedHtml) || null;
  const thumbnail = extractStreamtapePoster(embedHtml) || null;

  const label = sanitizeFilename(title || ('streamtape-' + stage.id)) || ('streamtape-' + stage.id);
  const videos = [{
    url: signedUrl || getVideoUrl,
    quality: 'Original',
    resolution: null,
    format: 'mp4',
    filename: label + '.mp4',
  }];

  return {
    provider: 'streamtape',
    id: stage.id,
    title: label,
    thumbnail,
    duration: null,
    canonicalUrl: stage.embedUrl || getVideoUrl,
    // Streamtape's file target needs no Referer/Cookie (verified: plain curl
    // gets 206 on the signed URL). Keep it absent so the engine stays simple.
    referer: null,
    videos,
  };
}

module.exports = {
  STREAMTAPE_SUFFIXES,
  parseStreamtapeEmbed,
  parseStreamtapeDirect,
  parseYespornUrl,
  isStreamtapeUrl,
  isYespornUrl,
  extractStreamtapeQuery,
  extractYespornBlock,
  extractEmbedIframeSrc,
  extractStreamtapeTitle,
  extractStreamtapePoster,
  sanitizeFilename,
  titleFromSignedUrl,
  mintViaElectron,
  resolveStreamtapeVideos,
};
