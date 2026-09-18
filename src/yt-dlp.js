/**
 * yt-dlp runner — the YouTube (and any yt-dlp-supported site) extraction
 * engine behind AiDM's YouTube resolver.
 *
 * Why a subprocess instead of re-implementing extraction in Node:
 *   • A YouTube watch URL is a WEB PAGE, not a file. The real media lives in
 *     player-side JS (`player` script, nsig/throttling, PO tokens) that changes
 *     every few weeks. yt-dlp tracks that; AiDM would be permanently broken
 *     the day after each change.
 *   • Modern YouTube serves PICTURE and SOUND as separate DASH streams. A
 *     normal download manager saves a silent file. yt-dlp downloads both and
 *     merges them with FFmpeg.
 *   • Stream URLs are SIGNED AND EXPIRE (minutes). Extract → download → merge
 *     in one shot, so a stale URL never reaches the segment engine.
 *
 * Design rules for a DESKTOP app (this is not the FastAPI service sketch):
 *   • Missing yt-dlp is NEVER fatal at require-time — the app must still boot
 *     and every other download must keep working. Callers get an actionable
 *     error (ytdlpMissingMessage) instead.
 *   • Windows first (AiDM ships on Windows): no os.killpg / start_new_session.
 *     Timeouts and cancels kill the whole process TREE (yt-dlp spawns FFmpeg),
 *     via `taskkill /T /F`.
 *   • No shell, argv only, `--` before the URL → no injection from a pasted
 *     URL.
 *   • Secrets (signatures/PO tokens) are redacted before a log line is shown
 *     to the user or written to the UI.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { isAvailable: ffmpegAvailable, resolveFfmpeg } = require('./media-mux');

const IS_WIN = process.platform === 'win32';

// ── Binary discovery ─────────────────────────────────────────────────────────
// Order: explicit env override → shipped/user bin dirs → PATH → `python -m
// yt_dlp`. Every candidate is VERIFIED with `--version` before use (a broken
// or hijacked path is skipped, not trusted).

const PYTHON_CANDIDATES = IS_WIN
  ? [['py', '-3'], ['python'], ['python3']]
  : [['python3'], ['python']];

function binDirs() {
  const dirs = [];
  if (process.env.AIDM_YTDLP_BIN) dirs.push(process.env.AIDM_YTDLP_BIN);
  // Packaged Electron app: extraResources / resources/bin
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bin'));
  // Dev checkout: aidm/bin
  dirs.push(path.join(__dirname, '..', 'bin'));
  // Per-user, writable without elevation (where tools/fetch-yt-dlp.js installs)
  if (IS_WIN) {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'AiDM', 'bin'));
  } else {
    const base = process.env.XDG_DATA_HOME || (process.env.HOME && path.join(process.env.HOME, '.local', 'share'));
    if (base) dirs.push(path.join(base, 'aidm', 'bin'));
  }
  return dirs;
}

function exeName() {
  return IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
}

function candidateRunners() {
  const out = [];
  if (process.env.AIDM_YTDLP) out.push({ argv: [process.env.AIDM_YTDLP], source: 'env' });
  for (const dir of binDirs()) {
    if (!dir) continue;
    const p = path.join(dir, exeName());
    try { if (fs.existsSync(p)) out.push({ argv: [p], source: 'bundled' }); } catch (e) { /* ignore */ }
  }
  out.push({ argv: [exeName()], source: 'path' });
  for (const py of PYTHON_CANDIDATES) out.push({ argv: [...py, '-m', 'yt_dlp'], source: 'python' });
  return out;
}

function runOnce(argv, args, { timeoutMs = 8000, maxOutput = 65536 } = {}) {
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
let runnerPromise = null;

/** Detect a working yt-dlp. Cached — call `detectRunner(true)` to re-check. */
function detectRunner(force = false) {
  if (!force && runnerCache !== undefined) return Promise.resolve(runnerCache);
  if (runnerPromise && !force) return runnerPromise;
  runnerPromise = (async () => {
    for (const candidate of candidateRunners()) {
      const res = await runOnce(candidate.argv, ['--version'], { timeoutMs: 10000 });
      if (res.ok && /\d{4}[.\-]\d{2}/.test(res.stdout)) {
        runnerCache = { argv: candidate.argv, source: candidate.source, version: res.stdout.split(/\s+/).pop() };
        return runnerCache;
      }
    }
    runnerCache = null;
    return null;
  })();
  return runnerPromise;
}

function isAvailable() {
  return !!runnerCache;
}

/** Actionable, non-fatal guidance shown when the engine is not installed. */
function ytdlpMissingMessage() {
  const dir = IS_WIN
    ? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'AiDM', 'bin') : '%LOCALAPPDATA%\\AiDM\\bin')
    : '~/.local/share/aidm/bin';
  return 'yt-dlp was not found, so this YouTube link cannot be extracted. ' +
    'Install it with: node tools/fetch-yt-dlp.js  (downloads the official ' +
    'release into ' + dir + '), or grab yt-dlp from ' +
    'github.com/yt-dlp/yt-dlp/releases/latest and drop the binary there ' +
    'yourself, or set AIDM_YTDLP to its full path — then restart AiDM.';
}

// ── Merge safety ─────────────────────────────────────────────────────────────
// Above ~720p YouTube ships picture and sound as two files. Without FFmpeg
// yt-dlp cannot join them, and the "success" would be a SILENT video (or an
// .mkv under a .mp4 name). Everything below exists so that never happens:
// prove FFmpeg exists first, clean up every intermediate afterwards, and
// check the finished file really has an audio track.

/** True when a `-f` expression asks for more than one stream (needs a merge). */
function specNeedsMerge(spec) {
  const s = String(spec || '');
  if (!s) return false;
  if (s.includes('+')) return true;                       // "137+140", "bv+ba"
  return /^best(video|audio)?\s*\+/i.test(s);
}

/**
 * Remove every file this job wrote for `outputTemplate` (merged file, the
 * separate video/audio tracks, .part leftovers). Only names carrying the
 * template's own prefix are touched, so a user's unrelated file is safe.
 */
function cleanupPartialOutputs(outputTemplate) {
  let removed = 0;
  try {
    const tpl = String(outputTemplate || '');
    const dir = path.dirname(tpl);
    const prefix = path.basename(tpl).split('%(ext)s')[0];
    if (!prefix || !dir) return 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed++; } catch (e) { /* in use */ }
    }
  } catch (e) { /* best effort */ }
  return removed;
}

/** The file this job produced (largest match), or null. */
function producedFileFor(outputTemplate) {
  try {
    const tpl = String(outputTemplate || '');
    const dir = path.dirname(tpl);
    const prefix = path.basename(tpl).split('%(ext)s')[0];
    if (!prefix || !dir) return null;
    let best = null;
    let bestSize = -1;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      if (/\.part($|\.)/i.test(name) || /\.ytdl$/i.test(name)) continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (!st.isFile() || st.size <= bestSize) continue;
      best = p;
      bestSize = st.size;
    }
    return best;
  } catch (e) {
    return null;
  }
}

/**
 * Prove the merged file really carries sound.
 *
 * Only a CONFIDENT "video with no audio" fails. If the probe cannot say
 * anything (unknown container, parse failure) the file is left alone —
 * destroying a good download on a hunch is worse than a late warning.
 */
async function verifyMergedAudio(filePath) {
  try {
    if (!filePath) return { ok: true, unknown: true };
    const mp = require('./media-probe');        // team A — real geometry/codecs
    if (!mp || typeof mp.probeFile !== 'function') return { ok: true, unknown: true };
    const info = await mp.probeFile(filePath, { maxBytes: 12 * 1024 * 1024 });
    if (!info) return { ok: true, unknown: true };
    if (!info.hasVideo) return { ok: true, unknown: true };      // audio-only row
    return info.hasAudio ? { ok: true } : { ok: false };
  } catch (e) {
    return { ok: true, unknown: true };
  }
}

// ── Output hygiene ───────────────────────────────────────────────────────────

const SECRET_PARAMS = /(sig|s|sp|signature|lsig|pot|potc|token|expire|ip|ipbits|source|key|gcr|oauth_token)=[^&\s"']+/gi;

/** Strip signed-URL parameters so logs never leak tokens into the UI. */
function redact(text) {
  return String(text == null ? '' : text)
    .replace(SECRET_PARAMS, '$1=REDACTED')
    // A header echoed back by yt-dlp must never reach a log the user can open.
    .replace(/(Cookie|Authorization):\s*[^\r\n"']+/gi, '$1: REDACTED');
}

// ── Error classification ─────────────────────────────────────────────────────
// yt-dlp's stderr is technical; the UI needs a short, honest reason. Codes are
// stable so callers can branch (e.g. offer "pick another quality").

function classifyError(raw) {
  const t = String(raw || '');
  const has = (re) => re.test(t);
  if (has(/timed out/i) && !has(/socket/i)) return { code: 'timeout', message: 'The download exceeded the time limit and was stopped.' };
  if (has(/private video|This video is private/i)) return { code: 'private', message: 'This video is private. AiDM only downloads videos you can already watch.' };
  if (has(/Sign in to confirm you.?re not a bot|not a bot/i)) return { code: 'bot-check', message: 'YouTube asked for a sign-in check before playing this video. AiDM does not bypass that — open the video in your browser first.' };
  if (has(/age-restricted|age restricted|confirm your age/i)) return { code: 'age', message: 'This video is age-restricted. AiDM does not bypass age verification.' };
  if (has(/members-only|Join this channel|member-only/i)) return { code: 'members', message: 'This video is members-only. AiDM does not bypass paid access.' };
  if (has(/Video unavailable|unavailable|has been removed|deleted/i)) return { code: 'unavailable', message: 'This video is unavailable or has been removed.' };
  if (has(/Requested format is not available|No video formats|format is not available/i)) return { code: 'format', message: 'That quality is no longer offered for this video. Remove the row and add it again to re-read the available qualities.' };
  if (has(/is not a valid URL|Unsupported URL|Cannot find/i)) return { code: 'url', message: 'That link is not a video AiDM can extract.' };
  if (has(/Postprocessing|ffmpeg|Error opening output|Conversion failed|Merger/i)) return { code: 'merge', message: 'The video and audio tracks could not be merged. Nothing was left in your folder as a silent video — try again or pick a different quality.' };
  if (has(/File is larger than|max-filesize/i)) return { code: 'too-large', message: 'The file is larger than the configured size limit.' };
  if (has(/Permission denied|Read-only file system|No space left/i)) return { code: 'disk', message: 'The file could not be written — check the save folder, its permissions and free space.' };
  return { code: 'extract', message: 'Extraction failed. The video may be unavailable, restricted, or need an updated yt-dlp (run node tools/fetch-yt-dlp.js).' };
}

/**
 * Write a short, REDACTED diagnostic log for a failed job.
 *
 * The generic message shown in the UI is deliberately short, which makes a
 * failure hard to act on. The log keeps the extractor's own words — but with
 * every signature/token stripped, and it is only ever opened by the user who
 * owns the download (see the `open-download-log` handler in main.js).
 *
 * @returns {string|null} the path, or null when it could not be written
 */
function writeDiagnosticLog(logPath, { code, url, formatSpec, runner, tail }) {
  if (!logPath) return null;
  try {
    const body = [
      'AiDM YouTube engine — diagnostic log',
      'time:        ' + new Date().toISOString(),
      'yt-dlp:      ' + runner,
      'error code:  ' + code,
      'format:      ' + String(formatSpec || '-'),
      // The page url is safe (it is the canonical watch url); signatures are
      // stripped from everything else below.
      'url:         ' + String(url || '-'),
      '',
      '— extractor output (signatures and tokens redacted) —',
      redact(String(tail || '')).slice(-4000),
      '',
    ].join('\n');
    require('fs').writeFileSync(logPath, body, 'utf8');
    return logPath;
  } catch (e) {
    return null;
  }
}

// ── Process-tree kill ────────────────────────────────────────────────────────
// yt-dlp spawns FFmpeg for the merge. Killing only the parent leaves an
// orphaned FFmpeg holding the output file. On Windows there is no process
// group, so use taskkill /T (tree).

function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) { /* gone */ } }
    }
  } catch (e) { /* best effort */ }
}

// ── Cookies / Referer ────────────────────────────────────────────────────────
// yt-dlp runs as a CHILD PROCESS and therefore does not inherit the browser
// session the extension captured. Without this block, cookies AiDM already
// held for a row were silently dropped on the YouTube path: private,
// members-only and age-confirmed videos failed even for a logged-in user,
// while the same cookies worked fine for direct HTTP downloads.
//
// Secrets go to a Netscape cookie FILE, never onto the command line — an argv
// entry is visible to every process listing on the machine (`tasklist`,
// WMI, /proc), a 0600 file is not.

const COOKIE_FILE_MAGIC = '# Netscape HTTP Cookie File\n';

// Browsers yt-dlp can read a cookie store from, so users can opt in to
// "--cookies-from-browser" instead of pasting anything.
const BROWSERS = ['chrome', 'chromium', 'edge', 'firefox', 'safari', 'opera', 'brave', 'vivaldi', 'whale'];

/** Hostname of a URL, or null. Never throws — a bad URL must not break a job. */
function cookieDomainFor(url) {
  try {
    const h = new URL(String(url)).hostname;
    return h || null;
  } catch (e) { return null; }
}

/** Split a `Cookie:` header value into [name, value] pairs. */
function parseCookiePairs(header) {
  const out = [];
  String(header || '').split(';').forEach((part) => {
    const t = part.trim();
    if (!t) return;
    const i = t.indexOf('=');
    if (i <= 0) return; // flag-only or malformed
    const name = t.slice(0, i).trim();
    const value = t.slice(i + 1).trim();
    if (!name) return;
    out.push([name, value]);
  });
  return out;
}

/**
 * Render a Netscape cookie file (pure — testable without touching disk).
 * @returns {string} '' when there is nothing usable to write
 */
function netscapeCookieFile(domain, cookieHeader) {
  const pairs = parseCookiePairs(cookieHeader);
  if (!domain || !pairs.length) return '';
  // A leading dot makes the cookie apply to subdomains; YouTube sets its
  // session cookies on .youtube.com, not www.youtube.com.
  const d = (!domain.startsWith('.') && domain.split('.').length >= 2) ? '.' + domain : domain;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const rows = pairs.map(([n, v]) => `${d}\tTRUE\t/\tFALSE\t${expires}\t${n}\t${v}`);
  return COOKIE_FILE_MAGIC + rows.join('\n') + '\n';
}

function cookieDir() {
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(base, process.platform === 'win32' ? 'AiDM' : 'aidm', 'cookies');
}

/**
 * Write the row's cookies to a throwaway Netscape file for one job.
 * @returns {string|null} path (caller deletes it), or null when there is
 *          nothing to write / the file cannot be created.
 */
function writeCookieFile(url, cookieHeader) {
  const body = netscapeCookieFile(cookieDomainFor(url), cookieHeader);
  if (!body) return null;
  try {
    const dir = cookieDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'cookies-' + crypto.randomBytes(8).toString('hex') + '.txt');
    fs.writeFileSync(p, body, { mode: 0o600 });
    return p;
  } catch (e) { return null; }
}

/** Best-effort delete of a cookie file written by writeCookieFile(). */
function deleteCookieFile(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
}

/**
 * Build the yt-dlp cookie/referer arguments. Pure — the test suite asserts it
 * without ever running yt-dlp.
 *
 * @param {object} o
 * @param {string} [o.cookieFile] Netscape file from writeCookieFile()
 * @param {string} [o.cookiesFromBrowser] e.g. 'chrome' (opt-in; empty = off)
 * @param {string} [o.referer] page URL some CDNs require
 * @returns {string[]} ready to spread into argv
 */
function cookieArgs(o) {
  const out = [];
  if (!o) return out;
  const browser = String(o.cookiesFromBrowser || '').trim().toLowerCase();
  if (browser && BROWSERS.includes(browser)) out.push('--cookies-from-browser', browser);
  if (o.cookieFile) out.push('--cookies', String(o.cookieFile));
  const ref = String(o.referer || '').trim();
  if (ref && /^https?:\/\//i.test(ref)) out.push('--referer', ref);
  return out;
}

// ── probe(): metadata + fresh formats, no download ───────────────────────────

/**
 * Run `yt-dlp -J` and return the parsed info dict.
 * @param {string} url canonical (already normalised) page URL
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.cookies]    `Cookie:` header value for this job
 * @param {string} [opts.referer]    page URL to send as Referer
 * @param {string} [opts.cookiesFromBrowser] opt-in browser cookie store
 * @returns {Promise<object>} parsed info dict
 */
async function probe(url, { timeoutMs = 60000, cookies = null, referer = null, cookiesFromBrowser = null } = {}) {
  const runner = await detectRunner();
  if (!runner) throw Object.assign(new Error(ytdlpMissingMessage()), { code: 'missing' });
  // A private/members-only video cannot even be LISTED without the session,
  // so the picker must carry cookies too — not just the download.
  const cookieFile = cookies ? writeCookieFile(url, cookies) : null;
  const args = [
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    '--no-call-home',
    '--no-cache-dir',
    '--ignore-config',
    '--skip-download',
    '--socket-timeout', '20',
    '--retries', '2',
    '--extractor-retries', '2',
    ...cookieArgs({ cookieFile, referer, cookiesFromBrowser }),
    '--',
    String(url),
  ];
  try {
    const res = await runOnce(runner.argv, args, { timeoutMs, maxOutput: 8 * 1024 * 1024 });
    if (!res.ok) {
      const why = classifyError(res.stderr || res.reason);
      throw Object.assign(new Error(why.message), { code: why.code, raw: redact(res.stderr || res.reason).slice(0, 500) });
    }
    // `--no-warnings` keeps stdout clean, but be defensive: take the last JSON
    // object in case an extractor printed a banner anyway.
    const lines = String(res.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('{')) {
        try { return JSON.parse(lines[i]); } catch (e) { /* try older line */ }
      }
    }
    throw Object.assign(new Error('Could not read the video information.'), { code: 'parse' });
  } finally {
    deleteCookieFile(cookieFile);
  }
}

// ── Progress parsing ─────────────────────────────────────────────────────────
// `--progress-template` with a machine-readable prefix; if an older yt-dlp
// ignores the template we still read the classic `[download] 12.3% of …` line.

const PROGRESS_PREFIX = 'AIDMPROGRESS|';
const PROGRESS_TEMPLATE =
  PROGRESS_PREFIX +
  '%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.speed)s|%(progress.eta)s|%(progress.filename)s';

const CLASSIC = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+)([KMGT]?)i?B(?:\s+at\s+~?\s*([\d.]+)([KMGT]?)i?B\/s)?(?:\s+ETA\s+(\d+:\d+(?::\d+)?))?/i;

function parseSize(value, unit) {
  const n = parseFloat(value);
  if (!isFinite(n)) return null;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[(unit || '').toUpperCase()] || 1;
  return Math.round(n * mult);
}

function parseProgressLine(line) {
  const s = String(line || '');
  if (s.includes(PROGRESS_PREFIX)) {
    const i = s.indexOf(PROGRESS_PREFIX);
    const parts = s.slice(i + PROGRESS_PREFIX.length).split('|');
    const num = (v) => { const n = Number(v); return isFinite(n) && n >= 0 ? n : null; };
    const status = parts[0] || '';
    if (status && status !== 'downloading') return { status };
    return {
      status: 'downloading',
      downloaded: num(parts[1]),
      total: num(parts[2]),
      speed: num(parts[3]),
      eta: num(parts[4]),
      file: parts[5] || null,
    };
  }
  const m = CLASSIC.exec(s);
  if (m) {
    return {
      status: 'downloading',
      percent: parseFloat(m[1]),
      downloaded: parseSize(m[2], m[3]),
      speed: m[4] ? parseSize(m[4], m[5]) : null,
      eta: null,
    };
  }
  return null;
}

// ── download(): extract + fetch + merge in one process ──────────────────────

/**
 * @param {object} o
 * @param {string} o.url            canonical page URL
 * @param {string} o.formatSpec     yt-dlp -f expression (e.g. "137+140")
 * @param {string} o.outputTemplate output path with %(ext)s
 * @param {number} [o.timeoutMs]    hard wall-clock cap (default 30 min)
 * @param {number} [o.expectedBytes] optional combined size (video+audio) —
 *        makes the percentage meaningful while the audio track downloads
 * @param {number} [o.limitRate] bytes/sec cap (0/undefined = unlimited)
 * @param {string} [o.logPath] when set, a REDACTED diagnostic log is written
 *        here on failure (short retention — see youtubeLogDir() in the manager)
 * @param {(p:{downloaded:number,total:number,speed:number,percent:number,eta:number|null})=>void} [o.onProgress]
 * @param {()=>boolean} [o.shouldAbort] polled every 400 ms (pause/cancel/remove)
 * @param {string} [o.cookies]    `Cookie:` header value for this job (the
 *        session the browser extension captured). Written to a throwaway
 *        Netscape file, never onto the command line.
 * @param {string} [o.referer]    page URL some CDNs require
 * @param {string} [o.cookiesFromBrowser] opt-in browser cookie store name
 * @returns {Promise<{filePath:string,size:number}>}
 */
function download(o) {
  return new Promise(async (resolve, reject) => {
    const runner = await detectRunner();
    if (!runner) {
      const err = new Error(ytdlpMissingMessage());
      err.code = 'missing';
      reject(err);
      return;
    }

    const {
      url, formatSpec, outputTemplate,
      timeoutMs = 30 * 60 * 1000,
      expectedBytes = 0,
      limitRate = 0,
      logPath = null,
      onProgress = null,
      shouldAbort = null,
      cookies = null,
      referer = null,
      cookiesFromBrowser = null,
    } = o;

    if (!url || !formatSpec || !outputTemplate) {
      reject(new Error('yt-dlp download requires url, formatSpec and outputTemplate'));
      return;
    }

    // Does this job need a merge? If it does and FFmpeg cannot be found, stop
    // NOW: going ahead would either fail halfway or — worse — leave a
    // picture-only file behind, which is exactly the "video without audio"
    // bug. A clear error beats a silent download.
    const ff = resolveFfmpeg();
    const needsMerge = o.requiresMerge == null ? specNeedsMerge(formatSpec) : !!o.requiresMerge;
    if (needsMerge && !ff) {
      const err = new Error(
        'FFmpeg was not found, so the video and audio tracks cannot be merged. ' +
        'Nothing was downloaded — AiDM will not save a video with no sound. ' +
        'Reinstall AiDM (FFmpeg ships with it) or install FFmpeg and try again.');
      err.code = 'merge';
      reject(err);
      return;
    }

    const args = [
      '--ignore-config',
      '--no-playlist',
      '--no-warnings',
      '--no-call-home',
      '--no-cache-dir',
      '--no-progress',          // we emit our own newline-delimited lines
      '--newline',
      '--no-colors',
      '--progress-template', PROGRESS_TEMPLATE,
      '--continue',             // resume a .part file after pause/crash
      '--socket-timeout', '30',
      '--retries', '3',
      '--fragment-retries', '3',
      '--concurrent-fragments', '4',
      '-f', formatSpec,
      '-o', outputTemplate,
      '--merge-output-format', 'mp4',
    ];

    // Never leave the separate video track behind: a stray "…f137.mp4" is a
    // silent file waiting to be mistaken for the finished download.
    if (needsMerge) args.push('--no-keep-video');

    // Honour AiDM's global/scheduled speed cap on this path too — otherwise
    // the scheduler's limit would simply not apply to YouTube downloads.
    const rate = Number(limitRate) || 0;
    if (rate > 0) args.push('--limit-rate', Math.max(1, Math.round(rate / 1024)) + 'K');

    // AiDM already ships ffmpeg-static — point yt-dlp at it so no system
    // FFmpeg install is required for the audio/video merge.
    if (ff) args.push('--ffmpeg-location', ff);

    // Session cookies / Referer for this job (see the cookie block above).
    // Written to a file so the secret never appears in argv.
    const cookieFile = cookies ? writeCookieFile(url, cookies) : null;
    args.push(...cookieArgs({ cookieFile, referer, cookiesFromBrowser }));

    args.push('--', String(url));

    let child;
    try {
      child = spawn(runner.argv[0], [...runner.argv.slice(1), ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX so killTree() can take FFmpeg with it.
        detached: !IS_WIN,
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stderrTail = '';
    let settled = false;
    let lastEmit = 0;
    let sawProgress = false;

    const cleanup = () => { try { child.unref?.(); } catch (e) { /* noop */ } };

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearInterval(abortTimer);
      cleanup();
      deleteCookieFile(cookieFile); // never leave the session on disk
      if (err) reject(err); else resolve(result);
    };

    const hardTimer = setTimeout(() => {
      killTree(child.pid);
      const err = new Error('The download exceeded the time limit and was stopped.');
      err.code = 'timeout';
      finish(err);
    }, timeoutMs);

    const abortTimer = setInterval(() => {
      if (settled) return;
      if (shouldAbort && shouldAbort()) {
        killTree(child.pid);
        const err = new Error('Stopped.');
        err.code = 'aborted';
        finish(err);
      }
    }, 400);

    const handleLine = (line) => {
      const p = parseProgressLine(line);
      if (!p || p.status !== 'downloading' || !onProgress) return;
      sawProgress = true;
      const now = Date.now();
      if (now - lastEmit < 200) return;   // ≥5 UI updates/s at most
      lastEmit = now;
      const downloaded = p.downloaded || 0;
      // With split video+audio the per-track total is only half the job, so
      // prefer the known combined size when the resolver gave us one.
      const total = expectedBytes > 0 ? expectedBytes : (p.total || 0);
      const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : (p.percent || 0);
      onProgress({
        downloaded,
        total: total || downloaded,
        speed: p.speed || 0,
        percent: Math.round(percent * 10) / 10,
        eta: p.eta != null ? p.eta : null,
      });
    };

    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const nl = stdoutBuf.lastIndexOf('\n');
      if (nl >= 0) {
        const block = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        for (const line of block.split('\n')) handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > 16384) stderrTail = stderrTail.slice(-16384);
      // yt-dlp writes progress to stderr in some builds/versions too.
      const nl = stderrTail.lastIndexOf('\n');
      if (nl >= 0) {
        for (const line of stderrTail.slice(0, nl).split('\n')) handleLine(line);
      }
    });

    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      if (code === 0) {
        // yt-dlp exited clean — but "clean" is not proof that the merge
        // happened. Verify the finished file actually has an audio track
        // before the row is allowed to report success.
        if (needsMerge && o.verifyAudio !== false) {
          verifyMergedAudio(producedFileFor(outputTemplate)).then((v) => {
            if (settled) return;
            if (v.ok) { finish(null, { ok: true, sawProgress, verified: !v.unknown }); return; }
            cleanupPartialOutputs(outputTemplate);
            const err = new Error(
              'The download finished without an audio track (the merge did not ' +
              'happen), so the file was removed instead of being saved as a ' +
              'silent video. Try again or pick a different quality.');
            err.code = 'merge';
            err.raw = redact(stderrTail).slice(-800);
            err.logPath = writeDiagnosticLog(logPath, {
              code: 'merge',
              url,
              formatSpec,
              runner: (runner && runner.version) || 'unknown',
              tail: stderrTail + '\nAIDM: merged file has no audio track',
            });
            finish(err);
          }).catch(() => finish(null, { ok: true, sawProgress }));
          return;
        }
        finish(null, { ok: true, sawProgress });
        return;
      }
      const why = classifyError(stderrTail);
      // A failed merge leaves the separate tracks (and possibly a
      // picture-only file) in the download folder. Delete them — but never on
      // an abort, where --continue resumes from the .part file.
      if (why.code !== 'aborted') cleanupPartialOutputs(outputTemplate);
      const err = new Error(why.message);
      err.code = why.code;
      err.raw = redact(stderrTail).slice(-800);
      err.logPath = writeDiagnosticLog(logPath, {
        code: why.code,
        url,
        formatSpec,
        runner: (runner && runner.version) || 'unknown',
        tail: stderrTail,
      });
      finish(err);
    });
  });
}

module.exports = {
  detectRunner,
  isAvailable,
  ytdlpMissingMessage,
  redact,
  classifyError,
  parseProgressLine,
  writeDiagnosticLog,
  probe,
  download,
  killTree,
  candidateRunners,
  // ── merge safety ──
  specNeedsMerge,
  cleanupPartialOutputs,
  producedFileFor,
  verifyMergedAudio,
  // Cookie / Referer plumbing (pure helpers are regression-tested).
  BROWSERS,
  cookieArgs,
  cookieDomainFor,
  parseCookiePairs,
  netscapeCookieFile,
  writeCookieFile,
  deleteCookieFile,
};
