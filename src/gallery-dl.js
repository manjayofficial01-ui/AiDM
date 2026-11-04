/*
 * gallery-dl.js — the gallery/image-site engine (v5.9.0).
 *
 * AiDM's own HTTP engine, yt-dlp and WebTorrent cover video, direct files and
 * torrents — but image galleries (pixiv, danbooru & friends, deviantart,
 * tumblr, kemono, patreon, mangadex, …250+ sites) need site-specific API
 * knowledge that no generic engine can guess. gallery-dl (GPL-2.0, invoked as
 * an UNMODIFIED external subprocess — the same legal pattern as yt-dlp, which
 * AiDM already ships) supplies that knowledge; this module supplies the AiDM
 * integration: discovery, per-user install, argument building, progress
 * parsing and exit-code → error mapping.
 *
 * CLI contract facts (verified against gallery-dl docs/options.md, 2026-11):
 *   -J/--resolve-json   metadata as JSON (implies simulation)
 *   -K/--list-keywords  metadata keys + example values
 *   -d/--destination    base download directory
 *   -C/--cookies FILE   Netscape cookies.txt (same shape yt-dlp writes)
 *   --cookies-from-browser BROWSER[/DOMAIN]
 *   --proxy URL
 *   --download-archive FILE   one line per downloaded id — re-running the same
 *                       gallery skips what is already on disk, which is how
 *                       pause/resume works here (a resumed row re-runs the
 *                       same command and only the missing files are fetched).
 *   Exit codes are a BITMASK OR-combined across files/URLs (exception.py):
 *     0 ok · 1 unexpected · 4 extraction/per-file failures · 8 challenge
 *     (captcha) · 16 auth required · 32 input error · 64 no extractor
 *     · 128 OSError during download.
 *
 * Update logistics: gallery-dl's stable channel moved to Codeberg and its
 * built-in self-updater still targets GitHub (404 today), so AiDM owns the
 * update path — Codeberg for stable, gdl-org/builds for nightly — exactly
 * like the yt-dlp flow. No published SHA256SUMS ship with these releases, so
 * the downloaded binary is validated by EXECUTING it (`--version` must answer
 * in the expected shape) before it replaces the old one; a binary that does
 * not run never lands in the bin dir.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { killTree, redact } = require('./yt-dlp.js');

const IS_WIN = process.platform === 'win32';
const CODEBERG_API = 'https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases?limit=1';
const CODEBERG_ASSET_BASE = 'https://codeberg.org/mikf/gallery-dl/releases/download';
const NIGHTLY_ASSET_URL = 'https://github.com/gdl-org/builds/releases/latest/download/gallery-dl_windows.exe';

function exeName() {
  return IS_WIN ? 'gallery-dl.exe' : 'gallery-dl';
}

/** Search order mirrors yt-dlp.js binDirs(): env → packaged → dev → per-user. */
function binDirs() {
  const dirs = [];
  if (process.env.AIDM_GALLERYDL_BIN) dirs.push(process.env.AIDM_GALLERYDL_BIN);
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bin'));
  dirs.push(path.join(__dirname, '..', 'bin'));
  if (IS_WIN) {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'AiDM', 'bin'));
  } else {
    const base = process.env.XDG_DATA_HOME || (process.env.HOME && path.join(process.env.HOME, '.local', 'share'));
    if (base) dirs.push(path.join(base, 'aidm', 'bin'));
  }
  return dirs;
}

function candidatePaths() {
  const out = [];
  if (process.env.AIDM_GALLERYDL) out.push(process.env.AIDM_GALLERYDL);
  for (const dir of binDirs()) {
    if (!dir) continue;
    const p = path.join(dir, exeName());
    try { if (fs.existsSync(p)) out.push(p); } catch (e) { /* ignore */ }
  }
  // PATH lookup is delegated to spawn('gallery-dl') by the runner below.
  out.push(exeName());
  return out;
}

function runOnce(argv, args, { timeoutMs = 15000, maxOutput = 65536 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], [...argv.slice(1), ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, reason: String(e && e.message || e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < maxOutput) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < maxOutput) stderr += d.toString(); });
    child.on('error', (e) => finish({ ok: false, reason: String(e && e.message || e) }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

let runnerCache;      // { argv, source, version } | null
let runnerCacheMissAt = 0;
let runnerPromise = null;

/**
 * gallery-dl `--version` prints a BARE semver ("1.32.19") — unlike yt-dlp it
 * does not prefix its own name. Accept both shapes so a future upstream
 * change cannot brick detection either way, and nothing else ("yt-dlp
 * 2025.01.01" on PATH must never read as a gallery-dl version).
 */
const VERSION_OUT_RE = /^(?:gallery-dl\s+)?(\d+\.\d+\.\d+)\s*$/m;

/** Pure: extract a semver from a `--version` stdout, or null. */
function parseVersionOutput(stdout) {
  const m = VERSION_OUT_RE.exec(String(stdout || ''));
  return m ? m[1] : null;
}

/** Detect a working gallery-dl. Cached — `detectRunner(true)` re-checks. */
function detectRunner(force = false) {
  if (!force && runnerCache) return Promise.resolve(runnerCache);
  // A miss is cached for only 60s: the user installs gallery-dl while AiDM
  // runs (Settings button), and a permanent negative cache would keep every
  // gallery row failing until restart.
  if (!force && runnerCache === null && Date.now() - runnerCacheMissAt < 60000) {
    return Promise.resolve(null);
  }
  if (runnerPromise && !force) return runnerPromise;
  runnerPromise = (async () => {
    try {
      for (const p of candidatePaths()) {
        const isPathProbe = p === exeName();
        const res = await runOnce([p], ['--version'], { timeoutMs: 10000 });
        const version = res.ok && parseVersionOutput(res.stdout);
        if (version) {
          runnerCache = { argv: [p], source: isPathProbe ? 'path' : 'bundled', version };
          return runnerCache;
        }
      }
      runnerCache = null;
      runnerCacheMissAt = Date.now();
      return null;
    } finally {
      runnerPromise = null;
    }
  })();
  return runnerPromise;
}

function isAvailable() {
  return !!runnerCache;
}

/** Where the in-app installer puts the binary (writable without elevation). */
function installTarget() {
  const base = IS_WIN
    ? (process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME || (process.env.HOME && path.join(process.env.HOME, '.local', 'share')));
  return path.join(base, IS_WIN ? 'AiDM' : 'aidm', 'bin', exeName());
}

/** Actionable guidance shown when the engine is not installed. */
function galleryDlMissingMessage() {
  const target = installTarget();
  return 'gallery-dl is not installed. Open Settings › gallery-dl and click "Install gallery-dl" — ' +
    'it installs per-user (no admin rights) into ' + target + '.';
}

// ── Installer ────────────────────────────────────────────────────────────────

/** Latest-release descriptor for a channel (stable → Codeberg, nightly → GitHub). */
async function fetchLatestRelease(channel) {
  if (String(channel || '').trim().toLowerCase() === 'nightly') {
    // gdl-org/builds does not expose a stable metadata API for "latest" via the
    // plain redirect; the asset URL itself is canonical (GitHub resolves it).
    return { tag: 'nightly', assetUrl: NIGHTLY_ASSET_URL, assetName: 'gallery-dl_windows.exe' };
  }
  const body = await httpsGetJson(CODEBERG_API);
  const rel = Array.isArray(body) && body[0];
  if (!rel || !rel.tag_name) throw new Error('Could not read the gallery-dl release list from Codeberg.');
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const asset = assets.find((a) => a && a.name === 'gallery-dl.exe' && a.browser_download_url);
  if (!asset) throw new Error('The latest gallery-dl release (' + rel.tag_name + ') has no Windows binary attached.');
  return { tag: rel.tag_name, assetUrl: asset.browser_download_url, assetName: 'gallery-dl.exe' };
}

function httpsGetJson(url) {
  return httpsGet(url, 8000).then((buf) => JSON.parse(buf.toString('utf8')));
}

/** HTTPS GET with redirect following (Codeberg/GitHub both redirect). */
function httpsGet(url, timeoutMs = 30000, maxBytes = 96 * 1024 * 1024, onBytes = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const get = (u, hops) => {
      if (hops > 6) return done(reject, new Error('Too many redirects'));
      const req = https.get(u, { headers: { 'User-Agent': 'AiDM/' + 'gallery-dl-installer', Accept: '*/*' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return get(next, hops + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return done(reject, new Error('HTTP ' + res.statusCode + ' for ' + u));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(); return done(reject, new Error('Download too large')); }
          chunks.push(c);
          if (onBytes) { try { onBytes(size); } catch (e) { /* progress only */ } }
        });
        res.on('end', () => done(resolve, Buffer.concat(chunks)));
        res.on('error', (e) => done(reject, e));
      });
      req.on('error', (e) => done(reject, e));
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    };
    get(url, 0);
  });
}

/**
 * Download + install gallery-dl into the per-user bin dir.
 * Validation-before-swap: the downloaded binary must execute and answer
 * `gallery-dl <semver>` before it replaces anything.
 */
async function installGalleryDl({ channel = 'stable', log = () => {} } = {}) {
  const rel = await fetchLatestRelease(channel);
  log('Downloading gallery-dl ' + rel.tag + ' (' + channel + ')…');
  const target = installTarget();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Stage under a REAL .exe name: Windows CreateProcess refuses to launch a
  // "gallery-dl.exe.new" (extension must be .exe), so validating the staged
  // file under a ".new" name fails even when the download is perfect.
  const staging = path.join(path.dirname(target), '.gallery-dl-staging.exe');
  const buf = await httpsGet(rel.assetUrl, 120000, 96 * 1024 * 1024, (n) => {
    log('Downloaded ' + Math.round(n / 1024) + ' KB…');
  });
  if (buf.length < 1024 * 1024) throw new Error('The downloaded gallery-dl binary is suspiciously small — refusing to install it.');
  fs.writeFileSync(staging, buf);

  // Validate by executing: `--version` must answer in the expected shape
  // (bare semver — see the note above detectRunner).
  const check = await runOnce([staging], ['--version'], { timeoutMs: 20000 });
  const version = check.ok && parseVersionOutput(check.stdout);
  if (!version) {
    try { fs.unlinkSync(staging); } catch (e) { /* keep for forensics is worse than a clean fail */ }
    throw new Error('The downloaded gallery-dl binary did not run correctly — install aborted.');
  }

  // Atomic swap. On Windows an exe that is currently running cannot be
  // replaced — report that verbatim (staging kept for the retry).
  try {
    fs.renameSync(staging, target);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/EPERM|EBUSY|EACCES/i.test(msg)) {
      throw new Error('gallery-dl is currently running (a download may be active). Stop it and retry the install. (' + msg + ')');
    }
    throw e;
  }
  runnerCache = null; // force re-detection
  return { version, tag: rel.tag, channel, path: target };
}

// ── URL classification ───────────────────────────────────────────────────────

/**
 * Host suffixes gallery-dl handles well AND that AiDM cannot otherwise
 * download (page-style gallery URLs). Deliberately conservative: anything
 * video-first (reddit, twitter, instagram posts) stays with its existing
 * resolver, and direct file URLs never route here (see looksLikeDirectFile).
 */
const GALLERY_HOSTS = [
  'pixiv.net', 'fanbox.cc',
  'danbooru.donmai.us', 'gelbooru.com', 'safebooru.org', 'e621.net', 'e926.net',
  'rule34.xxx', 'hypnohub.net', 'konachan.com', 'konachan.net', 'yande.re', 'lolibooru.moe',
  'deviantart.com', 'artstation.com', 'behance.net', 'smugmug.com',
  'tumblr.com', 'mangadex.org', 'booth.pm',
  'kemono.su', 'kemono.party', 'kemono.cr',
  'patreon.com', 'imgur.com', 'redgifs.com', 'vsco.co', 'newgrounds.com',
  'weibo.com', 'weibo.cn', 'naver.com', 'gallerij.as',
];

const DIRECT_FILE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|mp4|webm|mkv|mov|avi|m4v|mp3|flac|wav|ogg|zip|rar|7z|gz|pdf|epub|apk|exe|iso|dmg)(?:[?#]|$)/i;

/** A URL that points at one concrete file (extension in the last path segment). */
function looksLikeDirectFile(url) {
  try {
    const u = new URL(String(url));
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    return DIRECT_FILE_EXT_RE.test(seg);
  } catch (e) { return false; }
}

/**
 * Route decision: page-style gallery URLs whose host gallery-dl is known to
 * cover. Direct file URLs and unknown hosts fall through to the generic
 * engine — a gallery row must never steal a plain image URL.
 */
function isGalleryUrl(url) {
  if (typeof url !== 'string' || /^magnet:|^data:/i.test(url)) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (looksLikeDirectFile(url)) return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
  return GALLERY_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// ── Argument building (pure — regression-tested) ─────────────────────────────

/**
 * Build the gallery-dl argv for one gallery row. Pure; never spawns.
 * @param {object} o
 * @param {string} o.destDir        base directory (gallery-dl nests site/user below it)
 * @param {string} [o.archivePath]  --download-archive file (resume/dedupe)
 * @param {string[]} [o.cookieFiles] Netscape cookies.txt paths
 * @param {string} [o.cookiesFromBrowser] e.g. 'chrome' (opt-in; empty = off)
 * @param {string} [o.proxy]        http(s)/socks proxy URL
 * @param {string} o.url            the gallery/page URL
 * @returns {string[]}
 */
function buildArgs(o) {
  const out = [];
  if (!o || !o.destDir || !o.url) return out;
  out.push('--destination', String(o.destDir));
  const archive = String(o.archivePath || '').trim();
  if (archive) out.push('--download-archive', archive);
  const browser = String(o.cookiesFromBrowser || '').trim().toLowerCase();
  if (browser && /^[a-z][a-z0-9-]*$/.test(browser)) out.push('--cookies-from-browser', browser);
  for (const f of (Array.isArray(o.cookieFiles) ? o.cookieFiles : [])) {
    if (f) out.push('--cookies', String(f));
  }
  const proxy = String(o.proxy || '').trim();
  if (proxy && /^(https?|socks5h?):\/\//i.test(proxy)) out.push('--proxy', proxy);
  // `--` ends option parsing: a URL can never become a flag.
  out.push('--', String(o.url));
  return out;
}

// ── Exit-code mapping (pure — regression-tested) ─────────────────────────────

const EXIT = { GENERIC: 1, EXTRACTION: 4, CHALLENGE: 8, AUTH: 16, INPUT: 32, NO_EXTRACTOR: 64, OS: 128 };

/**
 * gallery-dl exit codes are a bitmask. Map to { fatal, code, message }:
 * fatal rows fail; non-fatal results complete with what was downloaded.
 * @param {number} code  process exit code
 * @param {number} filesDone  files that DID land on disk
 * @param {string} [stderrTail] last stderr lines for the message body
 * @returns {{ fatal: boolean, code: string, message: string } | null} null = plain success
 */
function mapExitCode(code, filesDone, stderrTail) {
  const c = Number(code) || 0;
  // gallery-dl stderr carries full page/CDN URLs with signed query params;
  // the tail lands on the row, the UI and the persisted state file — redact
  // it exactly like the yt-dlp path does.
  const tail = redact(String(stderrTail || '').trim().split('\n').filter(Boolean).pop() || '');
  if (c === 0) return null;
  if (c & EXIT.AUTH) {
    return { fatal: filesDone <= 0, code: 'auth', message: 'This gallery needs a login. Set cookies for the site (Settings › gallery-dl, or let the browser extension capture them) and retry.' };
  }
  if (c & EXIT.CHALLENGE) {
    return { fatal: filesDone <= 0, code: 'challenge', message: 'The site answered with a CAPTCHA/challenge. Solve it in your browser, then retry — cookies from that browser session will be used.' };
  }
  if (c & EXIT.NO_EXTRACTOR) {
    return { fatal: true, code: 'unsupported', message: 'gallery-dl has no extractor for this URL. It is not a supported gallery page.' };
  }
  if (c & EXIT.OS) {
    return { fatal: true, code: 'os', message: 'The system blocked part of the download (disk or permissions).' + (tail ? ' ' + tail : '') };
  }
  if (c & EXIT.EXTRACTION) {
    if (filesDone > 0) return { fatal: false, code: 'partial', message: 'Finished, but ' + filesDone + ' file(s) downloaded and some failed (rate limit or removed posts).' };
    return { fatal: true, code: 'extract', message: 'gallery-dl could not extract this gallery.' + (tail ? ' ' + tail : '') };
  }
  if (c & EXIT.INPUT) {
    return { fatal: true, code: 'input', message: 'gallery-dl rejected the request (invalid URL or options).' };
  }
  return { fatal: true, code: 'generic', message: 'gallery-dl failed with exit code ' + c + '.' + (tail ? ' ' + tail : '') };
}

// ── Runner ───────────────────────────────────────────────────────────────────

const GALLERY_LOG_DIR = () => {
  const base = IS_WIN
    ? (process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME || (process.env.HOME && path.join(process.env.HOME, '.local', 'share')));
  return path.join(base, IS_WIN ? 'AiDM' : 'aidm', 'gallery-dl-logs');
};

/**
 * Run one gallery download. Resolves { filesDone, lastFile, partial, warning }
 * or rejects Error with .code from mapExitCode().
 *
 * Progress is FILE-count based: gallery-dl prints each finished file's path
 * on stdout. Byte totals are unknown ahead of time (a gallery is N unknown
 * files), so rows show the indeterminate progress state — the same treatment
 * live HLS gets — plus an honest "N files" counter.
 */
function runGalleryDl(o) {
  return new Promise((resolve, reject) => {
    const args = buildArgs(o);
    if (!args.length) { reject(new Error('gallery-dl: nothing to run')); return; }

    let child;
    try {
      child = spawn(o.runner.argv[0], [...o.runner.argv.slice(1), ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(Object.assign(new Error('Could not start gallery-dl: ' + (e && e.message || e)), { code: 'spawn' }));
      return;
    }

    let filesDone = 0;
    let lastFile = null;
    let stderrTail = '';
    let stdoutTail = '';
    let settled = false;
    const abortCheck = setInterval(() => {
      let stop = false;
      try { stop = !!(o.shouldAbort && o.shouldAbort()); } catch (e) { stop = false; }
      if (stop) {
        clearInterval(abortCheck);
        try { killTree(child.pid); } catch (e) { try { child.kill(); } catch (e2) { /* gone */ } }
      }
    }, 400);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(abortCheck);
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { killTree(child.pid); } catch (e) { try { child.kill(); } catch (e2) { /* gone */ } }
      finish(reject, Object.assign(new Error('The gallery download ran past its time limit and was stopped.'), { code: 'timeout' }));
    }, Number(o.timeoutMs) || 4 * 60 * 60 * 1000);

    child.stdout.on('data', (d) => {
      stdoutTail = (stdoutTail + d.toString()).slice(-65536);
      for (const line of d.toString().split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('[')) continue;   // [gallery-dl][version] chatter
        if (/[/\\]/.test(t)) {                    // a finished file path
          filesDone++;
          lastFile = t;
          try { o.onProgress && o.onProgress({ filesDone, lastFile: t }); } catch (e) { /* progress only */ }
        }
      }
    });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-16384); });
    child.on('error', (e) => finish(reject, Object.assign(new Error('gallery-dl process error: ' + (e && e.message || e)), { code: 'spawn' })));
    child.on('close', (code) => {
      if (o.shouldAbort && (() => { try { return o.shouldAbort(); } catch (e) { return false; } })()) {
        // Stopped on purpose (pause/cancel/remove): surface as an abort, the
        // row's state already belongs to the pause/cancel handler.
        finish(reject, Object.assign(new Error('gallery-dl stopped'), { code: 'aborted', filesDone }));
        return;
      }
      const mapped = mapExitCode(code, filesDone, stderrTail);
      if (mapped && mapped.fatal) {
        finish(reject, Object.assign(new Error(mapped.message), { code: mapped.code, stderrTail }));
        return;
      }
      if (filesDone <= 0) {
        // Exit 0 but nothing on disk: an empty/deleted gallery. Never mark a
        // row "completed" when no file exists — that lies about the result.
        finish(reject, Object.assign(
          new Error('gallery-dl finished but downloaded 0 files — the gallery may be empty, private, or all posts were already downloaded elsewhere.'),
          { code: 'no-output', stderrTail }));
        return;
      }
      finish(resolve, { filesDone, lastFile, partial: !!(mapped && !mapped.fatal), warning: (mapped && mapped.message) || null, logTail: stdoutTail.slice(-2000) });
    });
  });
}

module.exports = {
  detectRunner,
  isAvailable,
  galleryDlMissingMessage,
  installGalleryDl,
  installTarget,
  fetchLatestRelease,
  parseVersionOutput,
  buildArgs,
  mapExitCode,
  runGalleryDl,
  isGalleryUrl,
  looksLikeDirectFile,
  GALLERY_HOSTS,
  EXIT,
  binDirs,
  candidatePaths,
};
