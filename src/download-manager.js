const { DownloadEngine, extFromMime } = require('./download-engine');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { isGenericFilename, cleanPageTitle } = require('./titles');
const { DEFAULT_INTERCEPT_TYPES } = require('./scheduler');
const { muxAudioVideo, isAvailable: ffmpegAvailable, facebookMediaHeaders } = require('./media-mux');
const ytdlp = require('./yt-dlp');
const youtubeResolver = require('./youtube-resolver');

// Team A's real geometry reader (width/height/duration/audio-track presence
// proven from the container bytes). Required defensively: a missing or broken
// probe must degrade to "no proven dimensions", never crash the main process
// and never block a completed download.
let mediaProbe = null;
try { mediaProbe = require('./media-probe'); } catch (e) { mediaProbe = null; }

const CATEGORIES = {
  video:    { label: 'Videos',    icon: '🎬', extensions: ['mp4','mkv','avi','mov','wmv','webm','flv','m4v','ts','m3u8'] },
  audio:    { label: 'Music',     icon: '🎵', extensions: ['mp3','wav','flac','aac','ogg','wma','m4a','opus'] },
  document: { label: 'Documents', icon: '📄', extensions: ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv','rtf','epub'] },
  archive:  { label: 'Archives',  icon: '📦', extensions: ['zip','rar','7z','tar','gz','bz2','xz','iso','dmg','img'] },
  software: { label: 'Software',  icon: '💿', extensions: ['exe','msi','deb','rpm','apk','appimage','msix'] },
  image:    { label: 'Images',    icon: '🖼️', extensions: ['jpg','jpeg','png','gif','bmp','svg','webp','tiff','psd','ico'] },
  other:    { label: 'Other',     icon: '📁', extensions: [] },
};

// Containers `src/media-probe.js` can actually read. Used to skip rows that
// are not media at all: probing a finished .zip/.exe would spawn the FFmpeg
// fallback for nothing on every single download.
const MEDIA_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', '3gp', 'mpg', 'mpeg', 'wmv',
  'ts', 'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'mka',
]);

function isMediaFile(filePath, category) {
  if (category === 'video' || category === 'audio') return true;
  const ext = String(filePath || '').split('.').pop().toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

function detectCategory(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  for (const [cat, info] of Object.entries(CATEGORIES)) {
    if (info.extensions.includes(ext)) return cat;
  }
  return 'other';
}

/**
 * Friendly message for a link the CDN already reports as gone. Sites like
 * mydaddy.cc / KVS put TIME-LIMITED links on the page; by the time the user
 * clicks Download the link has expired. Failing at ADD time with clear
 * guidance beats a 0% "DOWNLOADING" row whose segments each hit the same 404.
 * Extracted as a pure function so test/dead-link-guard.js can assert it.
 */
function deadLinkMessage(status) {
  const code = status === 410 ? '410 (gone)' : '404 (not found)';
  return 'This link has expired on the site\'s CDN (HTTP ' + code + '). ' +
    'These CDN links are short-lived — open the video page again, let AiDM re-detect it, and click Download on the fresh link.';
}

/**
 * Row fields for a YouTube download, taken from the resolver/picker metadata.
 * Returns {} for anything that is not a YouTube choice, so every other
 * download keeps exactly the shape it had before this feature existed.
 *
 * Why the row stores the PAGE url + format ids instead of the stream url:
 * YouTube signs and expires stream URLs (minutes). A row that only held the
 * stream url would be unresolvable after a pause, a restart or a retry.
 */
function youtubeFields(meta) {
  const m = meta || {};
  const isYt = m.provider === 'youtube' || youtubeResolver.isYouTubeUrl(m.ytUrl || '');
  if (!isYt) return {};
  return {
    provider: 'youtube',
    ytUrl: m.ytUrl || null,
    ytFormat: m.ytFormat || null,
  };
}

/**
 * Transport flags a resolver proved about a URL — file hosters (Rapidgator,
 * team B) reject `Range` and corrupt parallel segments, so their rows must run
 * as ONE plain connection and must not claim to be resumable.
 *
 * Read from the resolver metadata itself (`meta`, e.g. the chosen picker
 * video) or from its first `media[]` entry. Returns the safe defaults
 * (`singleConnection: false`, `resumable: true`) for everything else, so an
 * ordinary download keeps exactly the behaviour it had before.
 */
function resolverTransport(meta) {
  const sources = [meta, (meta && Array.isArray(meta.media) ? meta.media[0] : null)];
  let singleConnection = false;
  let resumable = true;
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    if (s.singleConnection === true) singleConnection = true;
    if (s.resumable === false || s.resumeable === false) resumable = false;
  }
  return {
    singleConnection,
    resumable,
    headers: (meta && meta.headers && typeof meta.headers === 'object') ? meta.headers : null,
  };
}

/**
 * Replay headers for a new row. An explicit caller-supplied set wins; when the
 * caller gave none, the resolver's own set (Referer/Cookie/User-Agent — file
 * hosters need all three) is used instead.
 *
 * A `Cookie` header is MOVED into the separate `cookies` field: `_persistDownloads`
 * drops `cookies` but keeps `headers`, so leaving it in `headers` would write a
 * live credential to disk in plaintext.
 */
function replayHeaders(headers, cookies, fallbackHeaders) {
  let out = null;
  if (headers && typeof headers === 'object' && Object.keys(headers).length) out = { ...headers };
  else if (fallbackHeaders && typeof fallbackHeaders === 'object') out = { ...fallbackHeaders };
  let outCookies = cookies || null;
  if (out) {
    const key = Object.keys(out).find(k => String(k).toLowerCase() === 'cookie');
    if (key) {
      const value = String(out[key] || '');
      if (!outCookies && value) outCookies = value;
      delete out[key];
    }
    if (!Object.keys(out).length) out = null;
  }
  return { headers: out, cookies: outCookies };
}

/** Copy of `h` with any `Cookie` entry removed (never persisted in plaintext). */
function withoutCookieHeader(h) {
  if (!h || typeof h !== 'object') return h;
  const key = Object.keys(h).find(k => String(k).toLowerCase() === 'cookie');
  if (!key) return h;
  const out = { ...h };
  delete out[key];
  return out;
}

/**
 * Pick the file yt-dlp actually produced for `stem` inside `dir`.
 * A merged download leaves `<stem>.yt.mp4`; an interrupted one can leave the
 * raw tracks (`<stem>.yt.f137.mp4`) — the merged file always wins.
 */
function findProducedFile(dir, stem) {
  try {
    const prefix = stem + '.yt';
    // Subtitle sidecars (.srt/.vtt) share the stem — they must never be
    // mistaken for the finished media, so they are excluded up front.
    const names = fs.readdirSync(dir)
      .filter(n => n.startsWith(prefix) && !/\.part$|\.ytdl$/i.test(n))
      .filter(n => !/\.(srt|vtt)$/i.test(n));
    if (!names.length) return null;
    const scored = names.map((n) => {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(dir, n)); size = st.size; mtime = st.mtimeMs; } catch (e) { /* ignore */ }
      return {
        n, size, mtime,
        merged: /\.f\d+\./i.test(n) ? 0 : 1,          // merged beats raw track
        mp4: /\.mp4$/i.test(n) ? 1 : 0,               // MP4 beats webm/mkv
      };
    });
    scored.sort((a, b) => (b.merged - a.merged) || (b.mp4 - a.mp4) || (b.size - a.size) || (b.mtime - a.mtime));
    return path.join(dir, scored[0].n);
  } catch (e) {
    return null;
  }
}

/**
 * Where redacted YouTube failure logs live (short retention, per user).
 * Never inside the download folder — a stray .log next to someone's videos is
 * noise, and the save folder may be a synced/shared location.
 */
function youtubeLogDir() {
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME || path.join(process.env.HOME || '.', '.local', 'share'));
  return path.join(base, process.platform === 'win32' ? 'AiDM' : 'aidm', 'logs');
}

/** Keep the log folder small: newest 20 survive, nothing older than a day. */
function pruneYoutubeLogs(dir, { keep = 20, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  try {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const files = fs.readdirSync(dir)
      .filter(n => /\.log$/i.test(n))
      .map(n => { const p = path.join(dir, n); let t = 0; try { t = fs.statSync(p).mtimeMs; } catch (e) {} return { p, t }; })
      .sort((a, b) => b.t - a.t);
    files.forEach((f, i) => {
      if (i >= keep || (f.t && now - f.t > maxAgeMs)) {
        try { fs.unlinkSync(f.p); } catch (e) { /* ignore */ }
      }
    });
  } catch (e) { /* never let housekeeping break a download */ }
}

/** `clip.mp4` → `clip (1).mp4` → `clip (2).mp4` … (never overwrites). */
function uniqueFilePath(filePath) {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = base + ' (' + i + ')' + ext;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return base + ' (' + Date.now() + ')' + ext;
}

/**
 * Friendly message for a link the CDN refuses to serve (401/403) even with
 * the page's Referer + session cookies replayed. Unlike 404/410 the file may
 * still exist — the request was blocked (expired token, missing login, or an
 * anti-hotlink rule) — so the guidance differs from the expired-link case.
 * Extracted as a pure function so test/mydaddy-title.js can assert it.
 */
function accessDeniedMessage(status) {
  return 'The server refused this download (HTTP ' + status + '). ' +
    'The link may have expired, need an active login, or block non-browser requests — open the video page again, let AiDM re-detect it, and click Download on the fresh link.';
}

/**
 * Friendly message for HTTP 501: the server rejects the request itself
 * (strict CDNs answer 501 to Range/HEAD probes from non-browser clients).
 * Retrying can never help, so it points at the in-browser fallback instead:
 * Chrome fetching the file itself carries the exact cookies and Fetch
 * metadata the CDN demands. Extracted pure for test/browser-engine.js.
 */
function methodBlockedMessage(status) {
  return 'The server refused this download request (HTTP ' + status + '). ' +
    'This host rejects download-manager requests but usually serves the same file to the browser — ' +
    'right-click the video (or link) and choose "Download with browser (fallback)" in the AiDM extension menu.';
}

/**
 * True when the up-front probe proves the resource is gone. Deliberately
 * narrow (404/410 only): 403 often means "hotlink-protected but works with
 * cookies", and other statuses are ambiguous.
 */
function isDeadProbeStatus(status) {
  return status === 404 || status === 410;
}

// Query params that are per-request signatures/tokens (expiring CDN auth).
// Stripped for duplicate comparison so the same stream requested twice
// (e.g. site download button + extension capsule) matches as one download.
const TOKEN_PARAMS = new Set([
  'token', 'tokens', 'sig', 'signature', 'sign', 'expires', 'expiry', 'exp',
  'e', 'h', 'hdnea', 'hdntl', 'hdnts', 'st', 'key', 'auth', 'authkey',
  'wmsauthsign', 'mst', 'access_token', 'token_expires', 'session', 'sid',
  'policy', 'token_hash', 'verify', 'md5', 't', 'ts', '_',
  // Facebook / Instagram CDN auth (rotates per request — same video, new ?oh=&oe=).
  // `vabr` rotates the same way on hd_src/sd_src URLs.
  'oh', 'oe', 'dl', 'rl', 'vabr', 'efg', 'bytestart', 'byteend',
  '_nc_ht', '_nc_cat', '_nc_ohc', '_nc_rid', '_nc_sid', 'ccb',
  // Twitter / X video CDN (?tag=12/14/16 rotates per poll — same file)
  'tag', 'container', 'containers',
]);

// Facebook edge pools rotate hostnames per request (video-ak-fbcdn-…,
// scontent-…, video-….fbcdn.net). The path alone identifies the object, so
// every fbcdn class collapses to one host — the same file compares equal
// no matter which edge served it.
function fbCanonicalHost(h) {
  try {
    h = String(h || '').toLowerCase().replace(/\.$/, '');
    if (/\.fbcdn\.net$/i.test(h)) return 'fbcdn.net';
    if (/cdninstagram\.com$/i.test(h)) return 'cdninstagram.com';
    return h;
  } catch { return String(h || '').toLowerCase(); }
}

// `efg` is base64url (sometimes raw JSON) carrying {vrt, bhak, itag, …}.
// `bhak` rotates on EVERY request, so keeping the raw blob made one video
// explode into 99+ "links". Keep only the per-rendition fields — must stay
// in sync with fbFileKey in chrome-extension/{content,background,popup}.js.
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

function fbFileKey(u) {
  try {
    const x = new URL(String(u || '').trim());
    x.hash = '';
    x.hostname = fbCanonicalHost(x.hostname);
    let tail = x.pathname || '';
    const efg = x.searchParams.get('efg');
    if (efg) {
      tail += '|efg=' + (fbEfgTag(efg) || efg);
    } else if (/fbcdn\.net$/i.test(x.hostname) || /cdninstagram\.com$/i.test(x.hostname)) {
      const q = x.searchParams.get('vabr') || x.searchParams.get('rl') || '';
      if (q) tail += '|q=' + q;
    }
    return x.protocol + '//' + x.hostname + tail;
  } catch { return null; }
}

// ?bytestart=N / ?byteend=M turn a full progressive MP4 into a byte SLICE.
// Saving the slice as-is writes a file missing its ftyp/moov header —
// "downloaded but won't play". Strip ONLY the range; keep auth (oh/oe/efg…).
function stripFbRange(u) {
  try {
    const s = String(u || '');
    if (!/fbcdn\.net|scontent\.|facebook\.com|fb\.com|instagram\.com|cdninstagram\.com/i.test(s)) return u;
    const x = new URL(s.trim());
    if (!x.searchParams.has('bytestart') && !x.searchParams.has('byteend')) return u;
    x.searchParams.delete('bytestart');
    x.searchParams.delete('byteend');
    return x.toString();
  } catch { return u; }
}

/**
 * Normalize a media URL for duplicate detection: lowercase host, sorted
 * non-token query params. Facebook edge URLs collapse to a file key
 * (canonical host + path + encode tag). Returns null for unparseable URLs.
 */
function normalizeMediaUrl(u) {
  try {
    if (/fbcdn\.net|scontent\.|facebook\.com|fb\.com|instagram\.com|cdninstagram\.com/i.test(String(u || ''))) {
      const fk = fbFileKey(u);
      if (fk) return 'fb:' + fk;
    }
  } catch {}
  try {
    const x = new URL(String(u || '').trim());
    x.hash = '';
    x.hostname = x.hostname.toLowerCase();
    const kept = [];
    // Preserve duplicate keys deterministically
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

function isHlsUrl(u) {
  const s = String(u || '');
  // Plain extension, with query/hash/fragment/path suffix (KVS & Xtream do
  // `…/index.m3u8?token=…`, `…/playlist.m3u8;session=…`, `…/master.m3u8#…`).
  if (/\.m3u8(?:[/?#;]|$)/i.test(s)) return true;
  // The manifest hidden inside a query param (`?file=…/x.m3u8`, `?manifest=…`).
  if (/[?&](?:file|src|manifest|playlist|url)=[^&]*\.m3u8/i.test(s)) return true;
  return false;
}

function isDashUrl(u) {
  const s = String(u || '');
  if (/\.mpd(?:[/?#;]|$)/i.test(s)) return true;
  if (/[?&](?:file|src|manifest|playlist|url)=[^&]*\.mpd/i.test(s)) return true;
  return false;
}

/**
 * Content-Types that mean "this is a stream, not a file". Used to reclassify
 * extension-less URLs (Xtream live `…/live/u/p/id` with no suffix, CDN
 * proxy paths) that a normal HEAD probe would otherwise save as garbage text.
 */
function mediaContentTypeIsStream(ct) {
  if (!ct || typeof ct !== 'string') return false;
  ct = ct.toLowerCase();
  return ct.includes('application/vnd.apple.mpegurl') ||
         ct.includes('application/x-mpegurl') ||
         ct.includes('application/dash+xml') ||
         ct.includes('vnd.apple.mpegurl');
}

const DEFAULT_SETTINGS = {
  maxConcurrentDownloads: 3,
  defaultSegments: 8,
  defaultSavePath: '',
  hlsConcurrency: 6,    // parallel segment fetches for HLS streams
  maxLiveMinutes: 180,   // hard cap when recording a live stream (Xtream/IPTV)
  autoResume: true,
  speedLimit: 0,
  queueMaxActive: 3, // historical default kept for settings-file compatibility (unused; concurrency uses maxConcurrentDownloads)
  clipboardMonitor: true,
  browserIntegration: true,
  notifications: true,
  askLocationEveryTime: false,
  // Download scheduler (v4.3.0): one-time/daily/weekly queue runs.
  schedules: [],
  // Timetabled speed limits, one rule per line: "HH:MM-HH:MM=KBPS".
  speedRules: '',
  // Browser takeover: take every download (classic), or only listed types;
  // never take over from excluded sites. Force/prevent keys handled live.
  interceptAll: true,
  interceptFileTypes: [...DEFAULT_INTERCEPT_TYPES],
  excludedSites: [],
  forceTakeoverKey: 'Shift',
  // Installed-app behavior (Windows installer sets these up)
  launchAtStartup: true,   // start AiDM automatically when Windows starts
  minimizeToTray: true,    // closing the window keeps AiDM running in the tray
  // AI (TokenHarbor OpenAI-compatible gateway). API key itself is NOT
  // stored here by default — set TOKENHARBOR_API_KEY env var. If aiApiKey
  // is set, it lives only in the local settings file (~/.aidm_settings.json).
  aiEnabled: true,
  aiBaseURL: 'https://tokenharbor.ai/v1',
  aiApiKey: '',
  aiPrimaryModel: 'mimo-v2.5:free',
  aiFallbackModel: 'deepseek-v4-flash:free',
  // Jev (TypeSafe System One) link-triage assist: when clipboard/extension
  // capture produces a URL the static patterns can't classify, Jev decides
  // whether it is a downloadable file. Needs TYPESAFE_API_KEY in the env.
  jevAssist: true,
  // Per-category save paths — empty string means use defaultSavePath
  categoryPaths: {
    video: '',
    audio: '',
    document: '',
    archive: '',
    software: '',
    image: '',
    other: '',
  },
  // File-hoster accounts (v4.5.0). A premium account (or a logged-in session
  // cookie) is what removes Rapidgator's free-user wait. Credentials are used
  // server-side by src/filehost-resolver.js and are never attached to a row —
  // only the resulting direct download URL is stored.
  fileHosts: {
    rapidgator: { user: '', password: '', cookie: '' },
  },
  // yt-dlp runs as a child process and does NOT inherit the browser session,
  // so a logged-in user's private / members-only / age-confirmed video used to
  // fail. Empty = off. Set to a browser name (chrome, edge, firefox, brave…)
  // to let yt-dlp read that browser's own cookie store; it is opt-in and only
  // ever used for the site being downloaded.
  youtubeCookiesFromBrowser: '',
  // Post-download actions (v4.8.0, IDM/AntDM style): run a command on every
  // finished download. `postDownloadCmd` may contain {file} — replaced with
  // the finished file's path. Typical antivirus usage:
  //   "C:\Program Files\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File "{file}"
  // Empty = disabled. Also: autoDeleteAfterHash optionally removes the row's
  // list entry requirements — kept minimal on purpose.
  postDownloadCmd: '',
  postDownloadCmdTimeoutSec: 120,
};

class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.engine = new DownloadEngine();
    this.downloads = new Map();
    this.queue = [];
    this.settings = this._loadSettings();
    this.maxConcurrent = this.settings.maxConcurrentDownloads;
    this.engine.setSpeedLimit(this.settings.speedLimit || 0);
    this.engine.setHlsConcurrency(this.settings.hlsConcurrency || 6);

    if (!this.settings.defaultSavePath) {
      this.settings.defaultSavePath = path.join(
        process.env.USERPROFILE || process.env.HOME || '',
        'Downloads', 'AiDM'
      );
    }

    // Ensure all category directories exist
    this._ensureDirectories();

    // Forward engine events
    // Progress events are throttled in the engine (5/s); persist the list at
    // most every 5s so a crash or restart resumes from near-current bytes.
    // (Nothing used to persist during download — after a restart the file said
    // downloaded: 0 and "byte-accurate resume" silently restarted from zero.)
    this._lastProgressPersist = 0;
    this.engine.on('download-progress', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) {
        dl.downloaded = data.downloaded;
        dl.totalSize = data.totalSize;
        dl.speed = data.speed;
        dl.percent = data.percent;
        // `segments` on the manager's download is always the COUNT. The live
        // per-segment array lives in `segmentDetails` so a progress event
        // never overwrites the count with an array (which broke resume).
        if (Array.isArray(data.segments)) {
          dl.segmentDetails = data.segments;
          dl._segProgress = data.segments.map(s => s.downloaded || 0);
        }
        // Only mark downloading if not already in a paused/stopped state.
        // A progress tick from the old run can fire right after pause() is
        // called (the 500ms ticker doesn't stop instantly), which would
        // overwrite 'paused' back to 'downloading' and confuse resumeDownload.
        const ACTIVE_OVERRIDABLE = new Set(['connecting', 'downloading', 'queued']);
        if (ACTIVE_OVERRIDABLE.has(dl.status)) {
          dl.status = 'downloading';
        }
        // Persist the HLS write cursor so a restart resumes the stream
        // instead of re-downloading every segment from zero.
        if (data.hlsResumeIndex) dl._hlsResumeIndex = data.hlsResumeIndex;
        if (data.hlsResumeBytes) dl._hlsResumeBytes = data.hlsResumeBytes;
        // ETA in seconds (null when speed or remaining size is unknown)
        const remaining = (data.totalSize || 0) - (data.downloaded || 0);
        dl.eta = (data.speed > 0 && remaining > 0) ? Math.ceil(remaining / data.speed) : null;
      }
      const now = Date.now();
      if (now - this._lastProgressPersist > 5000) {
        this._lastProgressPersist = now;
        this._persistDownloads(true);
      }
      this.emit('download-progress', { ...data, eta: dl ? dl.eta : null });
    });

    this.engine.on('download-complete', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) {
        dl.status = 'completed';
        dl.completedAt = Date.now();
        dl.duration = data.duration;
        // Record the real final size (especially important for HLS, whose size
        // was only estimated/known-from-playlist until now).
        if (data.totalSize > 0) {
          dl.totalSize = data.totalSize;
          dl.sizeEstimated = false;
        }
      }
      this._persistDownloads(true);
      this._processQueue();
      this.emit('download-complete', data);
      // Prove the real geometry (and the audio track) from the finished file,
      // then mux in a paired audio track when the row has one. Async, and
      // never allowed to throw into the completion path.
      this._finishRow(dl);
    });

    this.engine.on('download-error', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) {
        dl.status = 'error';
        dl.error = data.error;
      }
      this._persistDownloads(true);
      this._processQueue();
      this.emit('download-error', data);
    });

    this.engine.on('download-paused', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) dl.status = 'paused';
      // Persist now: pause must be the resume point after a restart.
      this._persistDownloads(true);
      this.emit('download-paused', data);
    });

    this.engine.on('download-resumed', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) dl.status = 'downloading';
      this.emit('download-resumed', data);
    });

    this.engine.on('download-hash', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) {
        dl.sha256 = data.sha256;
        this._persistDownloads(true);
      }
      this.emit('download-hash', data);
    });

    this._loadDownloads();
  }

  /**
   * Find an existing download for the same media (exact or normalized URL).
   * Used to avoid stacking a duplicate row when the same link is sent twice
   * (e.g. site download button + extension capsule/popup).
   */
  findDuplicate(url, ytFormat) {
    if (!url) return null;
    const norm = normalizeMediaUrl(url);
    // A YouTube row stores the WATCH url (the stream url expires), so every
    // quality of one video shares the same url. Different chosen quality is a
    // different download — without this, picking 720p after 1080p was reported
    // as a duplicate and silently returned the 1080p row.
    const fmt = (ytFormat && ytFormat.formatId) ? String(ytFormat.formatId) : null;
    const sameQuality = (dl) => !fmt ||
      !(dl && dl.ytFormat && dl.ytFormat.formatId) ||
      String(dl.ytFormat.formatId) === fmt;
    for (const dl of this.downloads.values()) {
      if (dl.url === url) {
        if (sameQuality(dl)) return dl;
        continue;
      }
      if (norm && dl._normUrl && dl._normUrl === norm) {
        if (sameQuality(dl)) return dl;
        continue;
      }
    }
    return null;
  }

  /**
   * Add a download. If askLocationEveryTime is on, the download enters
   * "pending-approval" state and the UI is prompted to pick a folder.
   * The caller receives the download object immediately; the actual
   * network work starts only after approveDownload(id, chosenPath) is called.
   *
   * If the same media is already listed, the existing entry is returned
   * with `duplicate: true` and no new row/event is created.
   */
  addDownload({ url, filename, savePath, segments, quality, meta, headers, cookies, category, mirrors, checksum, audioUrl }) {
    // Facebook: a ?bytestart=N URL is a byte-slice of the file, not the file.
    // Saving it as-is writes a headerless chunk that no player can open — so
    // always download the full-file URL (auth params kept, only range dropped).
    try { url = stripFbRange(url); } catch {}
    const dup = this.findDuplicate(url, youtubeFields(meta).ytFormat);
    if (dup) {
      // A re-sent row may carry what the first one lacked: attach a missing
      // paired audio track (Facebook split-AV) so the finished file can still
      // be muxed with sound instead of staying silent.
      try {
        const live = (dup && dup.id && this.downloads.get(dup.id)) || dup;
        if (live && !live.audioUrl && typeof audioUrl === 'string' && /^https?:/i.test(audioUrl)) {
          live.audioUrl = audioUrl;
          this._persistDownloads(true);
          if (live.status === 'completed') this._finishRow(live);
          else this.emit('download-updated', { ...live });
        }
      } catch (e) { /* attach is best-effort */ }
      return { ...dup, duplicate: true };
    }

    // File hosters (Rapidgator) reject Range and corrupt parallel segments:
    // one connection, honestly marked non-resumable.
    const transport = resolverTransport(meta);
    const replay = replayHeaders(headers, cookies, transport.headers);
    const id = uuidv4();
    // An explicit name wins — unless it is generic (a bare hostname like
    // "mydaddy.cc [1080p].mp4" from an untitled embed iframe, a rendition-only
    // "1080.mp4", a CDN hash). Generic names identify no video, so fall back
    // to the URL basename or the real page/video title instead.
    let parsedName = this._deriveFilename(url, filename, meta, quality);
    if (isHlsUrl(url) && !/\.ts$/i.test(parsedName)) {
      // HLS streams are assembled into a single .ts container
      parsedName = parsedName.replace(/\.(mp4|mkv|webm|m4v|mov|avi|m3u8|mpd)$/i, '');
      if (!/\.ts$/i.test(parsedName)) parsedName += '.ts';
    }
    // Explicit category from the UI wins over extension-based auto-detect.
    const detectedCategory = detectCategory(parsedName);
    const finalCategory = (category && CATEGORIES[category]) ? category : detectedCategory;
    const categoryPath = this.settings.categoryPaths[finalCategory] || '';
    const defaultPath = categoryPath || this.settings.defaultSavePath;
    const finalSavePath = savePath || defaultPath;
    const finalPath = path.join(finalSavePath, parsedName);
    // A detection pipeline that already knows the byte size (e.g. a direct
    // MP4 from the Twitter resolver) seeds the size immediately.
    const seedSize = (quality && quality.size) ? quality.size : 0;

    const download = {
      id,
      url,
      _normUrl: normalizeMediaUrl(url),
      filename: parsedName,
      category: finalCategory,
      savePath: finalSavePath,
      filepath: finalPath,
      segments: transport.singleConnection ? 1 : (segments || this.settings.defaultSegments),
      singleConnection: transport.singleConnection,
      resumable: transport.resumable,
      mirrors: Array.isArray(mirrors) ? mirrors : [],
      checksum: checksum || null,
      status: 'queued',
      addedAt: Date.now(),
      downloaded: 0,
      totalSize: seedSize,
      sizeEstimated: false,
      speed: 0,
      percent: 0,
      eta: null,                   // seconds remaining, null when unknown
      quality: quality || null,      // e.g. { label: '1080p', resolution: '1920x1080', size: 50000000 }
      meta: meta || null,            // video metadata from detection
      headers: replay.headers,       // allowlisted replay headers (Referer/Origin/UA)
      cookies: replay.cookies,       // session cookies for authenticated downloads (KVS etc.)
      // Persisted (cookies themselves are not): a row that needed session
      // cookies cannot resume after a restart — the cookies are gone, the
      // probe would 401/403. _loadDownloads reads this to skip auto-resume.
      needsSession: !!replay.cookies,
      audioUrl: audioUrl || null,    // paired audio-only track to mux in (split-AV)
      isHls: isHlsUrl(url),
      isDash: isDashUrl(url),
      _customPath: !!savePath,       // a folder was chosen — don't auto-move it on refine
      // ── YouTube (yt-dlp engine) ──────────────────────────────────────────
      // A YouTube row carries the canonical WATCH url plus the chosen format
      // ids, not just a signed stream URL: stream URLs expire in minutes, and
      // a row restored after a restart must be re-resolvable.
      ...youtubeFields(meta),
    };

    this.downloads.set(id, download);
    this._persistDownloads(true);
    this.emit('download-added', download);

    // Ask-every-time: resolve the real file name first, then raise the
    // topmost location dialog pre-filled with it and the default folder.
    if (this.settings.askLocationEveryTime && !savePath) {
      download.status = 'pending-approval';
      this._askLocation(download);
      return download;
    }

    // Normal flow: start or queue
    const activeCount = this._getActiveCount();
    if (activeCount < this.maxConcurrent) {
      this._startDownload(download);
    } else {
      this.queue.push(id);
      download.status = 'queued';
    }

    return download;
  }

  /**
   * Turn a user-typed (or pasted) file name into a safe one.
   * Strips any pasted folder path and characters Windows rejects, and keeps
   * HLS streams in the .ts container they are assembled into.
   * Returns null when nothing usable is left.
   */
  _cleanFilename(rawName) {
    let name = String(rawName == null ? '' : rawName).trim();
    if (!name) return null;

    // A pasted URL — drop the query/fragment and decode %20-style escapes.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name) || name.startsWith('//')) {
      name = name.split('#')[0];
      const q = name.indexOf('?');
      if (q >= 0) name = name.slice(0, q);
      try { name = decodeURIComponent(name); } catch (e) { /* keep as typed */ }
    }

    // A pasted full path — keep only the file name part.
    const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    if (slash >= 0) name = name.slice(slash + 1);
    name = name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    if (!name) return null;
    if (name.length > 180) name = name.slice(0, 180);
    return name;
  }

  /**
   * Called after the user picks a folder in the "ask every time" flow.
   * `chosenName` is the (optional) file name the user typed or pasted.
   */
  /**
   * For the "ask every time" flow: raise the topmost location dialog AT ONCE
   * (IDM-style) with the URL-derived name, then refine the real file name and
   * size in the background. The dialog shows "Fetching file info…" until the
   * probe lands, and live-updates via `download-updated` → location-patch —
   * so a slow or unreachable server never blocks the workflow.
   */
  _askLocation(dl) {
    const payload = () => ({
      id: dl.id,
      filename: dl.filename,
      category: dl.category,
      suggestedPath: dl.savePath,
      defaultPath: this.settings.categoryPaths[dl.category] || this.settings.defaultSavePath,
      // IDM-style file info for the dialog (may refine after the probe).
      url: dl.url,
      totalSize: (typeof dl.totalSize === 'number' && dl.totalSize > 0) ? dl.totalSize : null,
      sizeEstimated: !!dl.sizeEstimated,
      contentType: (dl._probe && dl._probe.contentType) || null,
    });
    const emit = () => {
      if (this.downloads.has(dl.id) && dl.status === 'pending-approval') {
        this.emit('download-ask-location', payload());
      }
    };
    // Open immediately; the probe below refines name/size via patch.
    emit();
    // Pass cookies + headers so authenticated CDNs (KVS etc.) don't 403 the probe
    const probeHeaders = { ...(dl.headers || {}) };
    if (!Object.keys(probeHeaders).some(k => k.toLowerCase() === 'referer') &&
        dl.meta && dl.meta.pageUrl) {
      probeHeaders.Referer = dl.meta.pageUrl;
    }
    if (dl.cookies && !probeHeaders.Cookie) probeHeaders.Cookie = dl.cookies;
    // _resolveFilename emits download-updated with the refined name/size,
    // which the main process forwards into the open dialog as a patch.
    this._resolveFilename(dl, probeHeaders).then(() => {}, () => {});
  }

  approveDownload(id, chosenPath, chosenName) {
    const dl = this.downloads.get(id);
    if (!dl) return null;

    dl.savePath = chosenPath;
    dl._customPath = true;

    // Renaming is only possible while nothing has been written yet.
    const cleaned = chosenName ? this._cleanFilename(chosenName) : null;
    if (cleaned && cleaned !== dl.filename) {
      let name = cleaned;
      if (dl.isHls && !/\.ts$/i.test(name)) {
        name = name.replace(/\.(mp4|mkv|webm|m4v|mov|avi|m3u8|mpd)$/i, '');
        if (!/\.ts$/i.test(name)) name += '.ts';
      }
      dl.filename = name;
      dl.category = detectCategory(name);
    }

    dl.filepath = path.join(chosenPath, dl.filename);
    dl.status = 'queued';

    const activeCount = this._getActiveCount();
    if (activeCount < this.maxConcurrent) {
      this._startDownload(dl);
    } else {
      this.queue.push(id);
    }
    this._persistDownloads(true);
    return dl;
  }

  /** Cancel a download that's waiting for folder approval */
  rejectDownload(id) {
    const dl = this.downloads.get(id);
    if (dl) dl._cancelRequested = true;
    this.downloads.delete(id);
    this._persistDownloads(true);
    this.emit('download-removed', { id });
  }

  queueDownload(opts) {
    const dup = this.findDuplicate(opts.url, youtubeFields(opts.meta).ytFormat);
    if (dup) {
      // Same split-AV attach as addDownload: a re-queued row may carry the
      // paired audio track the first one lacked.
      try {
        const live = (dup && dup.id && this.downloads.get(dup.id)) || dup;
        if (live && !live.audioUrl && opts && typeof opts.audioUrl === 'string' && /^https?:/i.test(opts.audioUrl)) {
          live.audioUrl = opts.audioUrl;
          this._persistDownloads(true);
          this.emit('download-updated', { ...live });
        }
      } catch (e) { /* attach is best-effort */ }
      return { ...dup, duplicate: true };
    }

    const transport = resolverTransport(opts.meta);
    const replay = replayHeaders(opts.headers, opts.cookies, transport.headers);
    const id = uuidv4();
    let parsedName = this._deriveFilename(opts.url, opts.filename, opts.meta, opts.quality);
    if (isHlsUrl(opts.url) && !/\.ts$/i.test(parsedName)) {
      // HLS streams are assembled into a single .ts container
      parsedName = parsedName.replace(/\.(mp4|mkv|webm|m4v|mov|avi|m3u8|mpd)$/i, '');
      if (!/\.ts$/i.test(parsedName)) parsedName += '.ts';
    }
    const category = detectCategory(parsedName);
    const categoryPath = this.settings.categoryPaths[category] || '';
    const defaultPath = categoryPath || this.settings.defaultSavePath;
    const finalSavePath = opts.savePath || defaultPath;
    const finalPath = path.join(finalSavePath, parsedName);
    const seedSize = (opts.quality && opts.quality.size) ? opts.quality.size : 0;

    const download = {
      id,
      url: opts.url,
      _normUrl: normalizeMediaUrl(opts.url),
      filename: parsedName,
      category,
      savePath: finalSavePath,
      filepath: finalPath,
      segments: transport.singleConnection ? 1 : (opts.segments || this.settings.defaultSegments),
      singleConnection: transport.singleConnection,
      resumable: transport.resumable,
      status: 'queued',
      addedAt: Date.now(),
      downloaded: 0,
      totalSize: seedSize,
      sizeEstimated: false,
      speed: 0,
      percent: 0,
      quality: opts.quality || null,
      meta: opts.meta || null,
      headers: replay.headers,
      cookies: replay.cookies,
      audioUrl: (opts && typeof opts.audioUrl === 'string' && /^https?:/i.test(opts.audioUrl)) ? opts.audioUrl : null,
      isHls: isHlsUrl(opts.url),
      isDash: isDashUrl(opts.url),
      _customPath: !!opts.savePath,
      ...youtubeFields(opts.meta),
    };

    this.downloads.set(id, download);
    this.queue.push(id);
    this._persistDownloads(true);
    this.emit('download-added', download);
    return download;
  }

  /** True when the download was cancelled/removed/paused while we were probing. */
  _startAborted(download) {
    return !this.downloads.has(download.id) || download._cancelRequested || download.status === 'paused';
  }

  /**
   * Read the REAL geometry of a finished file and rewrite the row from it.
   *
   * Why: `quality.resolution` used to be whatever the extension, a URL regex
   * or the playing <video> element guessed — that is why a 360p file showed
   * 2160p and why every row on a page showed the same resolution. A proven
   * geometry always beats a guess; when the probe proves nothing the existing
   * label is kept and `resolution` is left undefined (never fabricated).
   *
   * Also sets `download.audioMissing` (video with no audio track), the signal
   * the UI surfaces for "it only downloaded the video".
   *
   * Never throws, never rejects. Returns the MediaInfo-ish `download.media`
   * object, or null when nothing could be proven.
   */
  async probeMedia(download) {
    try {
      if (!download || !mediaProbe || typeof mediaProbe.probeFile !== 'function') return null;
      if (!this.downloads.has(download.id)) return null;
      // Only a finished file can be trusted: probing a half-written one would
      // publish geometry from an incomplete container.
      if (download.status !== 'completed' && download.status !== 'muxing') return null;
      const filePath = download.filepath;
      if (!filePath || typeof filePath !== 'string') return null;
      if (!isMediaFile(filePath, download.category)) return null;
      let size = 0;
      try { size = fs.statSync(filePath).size; } catch (e) { return null; }
      if (!size) return null;

      const info = await mediaProbe.probeFile(filePath);
      if (!info) return null;

      download.media = {
        width: info.width || 0,
        height: info.height || 0,
        durationSec: info.durationSec || 0,
        hasVideo: !!info.hasVideo,
        hasAudio: !!info.hasAudio,
        vcodec: info.vcodec || null,
        acodec: info.acodec || null,
        container: info.container || null,
        probedAt: Date.now(),
      };
      download.audioMissing = !!(download.media.hasVideo && !download.media.hasAudio);

      const resolution = mediaProbe.resolutionOf(info);
      const label = mediaProbe.labelForHeight(info.height);
      const cur = (download.quality && typeof download.quality === 'object') ? download.quality : null;
      if (resolution) {
        // Proven geometry wins over any guess — including a stale 2160p label.
        download.quality = { ...(cur || {}), resolution, label: label || (cur && cur.label) || null };
      } else if (cur && cur.resolution !== undefined) {
        // No geometry: keep the guessed label, drop an unproven resolution
        // instead of inventing 16:9 from a height.
        delete cur.resolution;
      }
      this.emit('download-updated', { ...download });
      return download.media;
    } catch (e) {
      return null;
    }
  }

  /**
   * Post-completion row work: prove the geometry, then repair a silent file
   * when a paired audio track is available. Fire-and-forget by design — a
   * probe or a mux can never fail (or delay) a completed download.
   */
  _finishRow(dl) {
    try {
      if (!dl || !this.downloads.has(dl.id)) return;
      Promise.resolve()
        .then(() => this.probeMedia(dl))
        .then(() => this._ensureAudio(dl))
        .catch(() => {})
        .finally(() => this._runPostDownloadAction(dl));
    } catch (e) { /* never throw into the Electron main process */ }
  }

  /**
   * Post-download action (v4.8.0): run a user-configured command on the
   * finished file — the IDM/AntDM antivirus-hook pattern. Typical AV line:
   *   "C:\Program Files\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File "{file}"
   * Runs once per row (after the audio-mux step so the FINAL file is what
   * gets scanned). The command runs detached from the completion path: its
   * result is logged on the row (postDownloadResult), never thrown.
   */
  _runPostDownloadAction(dl) {
    try {
      if (!dl || dl.status !== 'completed' || dl._postActionDone) return;
      const cmd = String(this.settings.postDownloadCmd || '').trim();
      if (!cmd) return;
      if (!dl.filepath || !fs.existsSync(dl.filepath)) return;
      dl._postActionDone = true;
      const { spawn } = require('child_process');
      // {file} placeholder — quoted form too, so users can write just
      // -File "{file}" without hand-building quoting for spaces.
      const withFile = cmd.includes('{file}')
        ? cmd.split('{file}').join(dl.filepath)
        : cmd + ' "' + dl.filepath + '"';
      const timeoutSec = Math.max(10, Number(this.settings.postDownloadCmdTimeoutSec) || 120);
      let child;
      try {
        child = spawn(withFile, [], { shell: true, windowsHide: true, stdio: 'ignore' });
      } catch (e) {
        dl.postDownloadResult = 'Command failed to start: ' + e.message;
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) {}
      }, timeoutSec * 1000);
      child.on('error', (e) => {
        clearTimeout(timer);
        dl.postDownloadResult = 'Command error: ' + e.message;
        this._persistDownloads(true);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        dl.postDownloadResult = code === 0 ? 'ok' : 'exit code ' + code;
        this._persistDownloads(true);
      });
    } catch (e) { /* never throw into the completion path */ }
  }

  /** Manual refresh (row menu / re-check): re-prove geometry and audio. */
  refreshDownload(id) {
    const dl = this.downloads.get(id);
    if (!dl) return null;
    this._finishRow(dl);
    return dl;
  }

  /**
   * A video-only file with a paired audio track (Facebook split-AV) gets the
   * audio muxed in. If no pair is attached but the file is silent on a
   * Facebook/Instagram page, try to recover audioUrl from the page first.
   */
  async _ensureAudio(dl) {
    try {
      if (!dl || dl._muxDone) return false;
      if (!dl.media) {
        try { await this.probeMedia(dl); } catch (e) {}
      }
      if (dl.media && dl.media.hasAudio) {
        dl._muxDone = true;
        return false;
      }
      if (!dl.audioUrl) {
        const recovered = await this._recoverFacebookAudioUrl(dl);
        if (recovered) dl.audioUrl = recovered;
      }
      if (!dl.audioUrl) {
        if (dl.media && dl.media.hasVideo && !dl.media.hasAudio) dl.audioMissing = true;
        return false;
      }
      return await this._muxFacebookAudio(dl);
    } catch (e) {
      return false;
    }
  }

  /**
   * Silent Facebook download with no audioUrl: re-resolve the watch page and
   * pick a paired audio track (yt-dlp documents playable_url/DASH pairing).
   */
  async _recoverFacebookAudioUrl(download) {
    try {
      const pageUrl = (download.meta && (download.meta.pageUrl || download.meta.url)) || '';
      if (!pageUrl || !/facebook\.com|fb\.watch|instagram\.com/i.test(String(pageUrl))) return null;
      if (download._audioRecoverTried) return null;
      download._audioRecoverTried = true;
      let facebookResolver;
      try { facebookResolver = require('./facebook-resolver'); } catch (e) { return null; }
      if (!facebookResolver || typeof facebookResolver.resolveFacebookVideos !== 'function') return null;
      if (!facebookResolver.isFacebookUrl(pageUrl)) return null;
      const r = await facebookResolver.resolveFacebookVideos(pageUrl, {
        cookies: download.cookies || null,
        userAgent: (typeof facebookMediaHeaders === 'function'
          ? facebookMediaHeaders(pageUrl)['User-Agent']
          : null) || 'facebookexternalhit/1.1',
      });
      const videos = (r && r.videos) || [];
      const withAudio = videos.filter(v => v && v.audioUrl && /^https?:/i.test(v.audioUrl));
      if (!withAudio.length) return null;
      if (withAudio.length === 1) return withAudio[0].audioUrl;
      // Several qualities re-resolved: return the audio that belongs to THIS
      // download, not just the first row's. A wrong-video audio track would
      // mux foreign sound (or fail); fail-open keeps first-found only when
      // nothing matches.
      try {
        const targetNorm = normalizeMediaUrl(download.url);
        if (targetNorm) {
          const exact = withAudio.find(v => v.url && normalizeMediaUrl(v.url) === targetNorm);
          if (exact) return exact.audioUrl;
        }
      } catch (e) { /* fall through to family matching */ }
      try {
        const vidOf = (u) => facebookResolver.videoIdFromFbUrl(u);
        const dirOf = (u) => {
          try { return new URL(String(u)).pathname.replace(/\/[^/]+$/, ''); }
          catch (e) { return null; }
        };
        const vid = vidOf(download.url);
        const dir = dirOf(download.url);
        if (vid) {
          const m = withAudio.find(v => vidOf(v.url) === vid || (v.audioUrl && vidOf(v.audioUrl) === vid));
          if (m) return m.audioUrl;
        }
        if (dir) {
          const m = withAudio.find(v => dirOf(v.url) === dir);
          if (m) return m.audioUrl;
        }
      } catch (e) { /* fall through to first-found */ }
      return withAudio[0].audioUrl;
    } catch (e) {
      return null;
    }
  }

  /**
   * Split-AV mux. Facebook CDN MUST be fetched with facebookexternalhit/1.1
   * (yt-dlp: browser UA is rate-limited). Stream-copy first, AAC re-encode
   * fallback for fragmented MP4 pairs.
   */
  async _muxFacebookAudio(download) {
    if (!download || !download.audioUrl) return false;
    if (!ffmpegAvailable()) {
      download.audioMissing = true;
      download.muxNote = 'FFmpeg is unavailable, so the separate audio track could not be merged in. The video-only file was kept exactly as downloaded.';
      download._muxDone = true;
      this.emit('download-updated', { ...download });
      return false;
    }
    const videoPath = download.filepath;
    const audioPath = videoPath + '.audio.part';
    const muxedPath = videoPath + '.muxed.mp4';
    const backupPath = videoPath + '.video.bak';
    let backedUp = false;
    try {
      if (!fs.existsSync(videoPath)) { download._muxDone = true; return false; }
      // Always pin facebookexternalhit on FB CDN — never replay browser UA.
      const reqHeaders = facebookMediaHeaders(download.audioUrl, {
        ...(download.headers || {}),
      });
      if (!Object.keys(reqHeaders).some(k => k.toLowerCase() === 'referer') && download.meta && download.meta.pageUrl) {
        reqHeaders.Referer = download.meta.pageUrl;
      }
      if (download.cookies && !reqHeaders.Cookie) reqHeaders.Cookie = download.cookies;
      const prevStatus = download.status;
      download.status = 'muxing';
      this.emit('download-updated', { ...download });
      const resp = await fetch(download.audioUrl, { headers: reqHeaders });
      if (!resp.ok) throw new Error('audio fetch ' + resp.status);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length) throw new Error('empty audio track');
      fs.writeFileSync(audioPath, buf);
      await muxAudioVideo(videoPath, audioPath, muxedPath);
      let muxedSize = 0;
      try { muxedSize = fs.statSync(muxedPath).size; } catch (e) { muxedSize = 0; }
      if (!muxedSize) throw new Error('mux produced an empty file');

      fs.renameSync(videoPath, backupPath);
      backedUp = true;
      try {
        fs.renameSync(muxedPath, videoPath);
      } catch (e) {
        try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch (err) {}
        fs.renameSync(muxedPath, videoPath);
      }
      try { fs.unlinkSync(backupPath); } catch (e) {}
      backedUp = false;
      try { fs.unlinkSync(audioPath); } catch (e) {}
      download.status = prevStatus === 'completed' ? 'completed' : prevStatus;
      download.muxed = true;
      download._muxDone = true;
      delete download.muxNote;
      await this.probeMedia(download);
      if (download.media && download.media.hasVideo && !download.media.hasAudio) {
        download.audioMissing = true;
        download.muxNote = 'Audio merge finished but the file still reports no audio track. Facebook may be serving a protected stream — try the page URL again while logged in.';
      }
      this._persistDownloads(true);
      this.emit('download-updated', { ...download });
      return true;
    } catch (e) {
      try { if (fs.existsSync(muxedPath)) fs.unlinkSync(muxedPath); } catch (err) {}
      try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch (err) {}
      if (backedUp) {
        try {
          if (fs.existsSync(backupPath)) {
            try { fs.renameSync(backupPath, videoPath); }
            catch (err) {
              try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch (err2) {}
              fs.renameSync(backupPath, videoPath);
            }
          }
        } catch (err) {}
      }
      if (download.status === 'muxing') {
        download.status = 'completed';
        download.audioMissing = true;
        download.muxNote = 'The separate audio track could not be merged in, so the video-only file was kept as downloaded.';
      }
      // Allow one later retry (e.g. after audio recovery or re-scan).
      download._muxDone = false;
      this._persistDownloads(true);
      this.emit('download-updated', { ...download });
      return false;
    }
  }

  /**
   * Re-prove rows restored from disk that never got a probe (older saves, or
   * a crash between completion and the probe). Bounded and staggered: a
   * library of 500 completed videos must not turn startup into 500 file reads.
   *
   * Persists ONCE at the end of the pass — never per row.
   */
  _probeRestoredRows(limit = 20) {
    try {
      if (!mediaProbe || typeof mediaProbe.probeFile !== 'function') return;
      const rows = [];
      for (const d of this.downloads.values()) {
        if (d && d.status === 'completed' && d.filepath && !d.media) rows.push(d);
        if (rows.length >= limit) break;
      }
      if (!rows.length) return;
      let left = rows.length;
      rows.forEach((d, i) => {
        setTimeout(() => {
          Promise.resolve(this.probeMedia(d)).catch(() => {}).then(() => {
            left -= 1;
            if (left <= 0) this._persistDownloads(true);
          });
        }, i * 150);
      });
    } catch (e) { /* never let housekeeping break startup */ }
  }

  /**
   * YouTube download through the yt-dlp engine (extract → download → merge).
   *
   * A watch URL is a page; the real media are signed DASH URLs that expire in
   * minutes, and above ~720p picture and sound are SEPARATE tracks — so the
   * native segment engine would either 403 on a stale URL or save a silent
   * file. yt-dlp resolves and merges in one process instead.
   *
   * The one exception is a fresh PROGRESSIVE (single-file) URL: it is a real
   * file URL, so AiDM keeps it — multi-segment, resumable, speed-limited.
   *
   * @returns {Promise<boolean>} true when this method has taken over the row
   *          (the caller must return); false to continue with the normal engine.
   */
  async _startYoutubeDownload(download, { force = false } = {}) {
    const choice = download.ytFormat || null;
    if (!force && youtubeResolver.isChoiceFresh(choice)) return false;

    // Bound how many yt-dlp processes run at once. Each one is a full
    // extract + download + (FFmpeg) merge — without a cap, a burst of YouTube
    // rows would spawn as many children as the queue allows.
    const cap = Math.max(1, Number(this.settings.youtubeMaxConcurrent) || 2);
    if ((this._ytActive || 0) >= cap) {
      if (!this.queue.includes(download.id)) this.queue.push(download.id);
      download.status = 'queued';
      this.emit('download-updated', { ...download });
      return true; // taken over — the queue restarts it when a slot frees
    }

    const pageUrl = download.ytUrl || (download.meta && download.meta.ytUrl) || download.url;
    const dir = path.dirname(download.filepath);
    const stem = path.basename(download.filepath, path.extname(download.filepath));
    // yt-dlp owns the container extension until the merge is done, so let it
    // write "<stem>.yt%(ext)s" and rename to the real filename afterwards.
    const template = path.join(dir, stem + '.yt%(ext)s');

    const fail = (message, code, logFile) => {
      download.status = 'error';
      download.error = message;
      download.ytErrorCode = code || 'extract';
      // Only set (or clear) the log path for failures that actually produced
      // one, so a row never points at another job's log.
      if (logFile) download.ytLogPath = logFile;
      else delete download.ytLogPath;
      this._persistDownloads(true);
      this._processQueue();
      this.emit('download-error', { id: download.id, error: message });
    };

    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* handled below */ }
    }

    if (!(await ytdlp.detectRunner())) {
      fail(ytdlp.ytdlpMissingMessage(), 'missing');
      return true;
    }

    // Redacted diagnostic log for this job (opened from the row on failure).
    let logPath = null;
    try {
      const logDir = youtubeLogDir();
      fs.mkdirSync(logDir, { recursive: true });
      pruneYoutubeLogs(logDir);
      logPath = path.join(logDir, download.id + '.log');
    } catch (e) { logPath = null; }

    download.status = 'downloading';
    download.error = null;
    this._ytActive = (this._ytActive || 0) + 1;
    this.emit('download-updated', { ...download });

    try {
      await ytdlp.download({
        url: pageUrl,
        formatSpec: youtubeResolver.buildFormatSpec(choice),
        outputTemplate: template,
        // Flags the CHOICE itself needs (an MP3 pick re-encodes) plus the
        // user's subtitle preference. Subtitles are opt-in, so this is
        // normally an empty list and changes nothing about the normal path.
        extraArgs: [
          ...youtubeResolver.buildExtraArgs(choice),
          ...ytdlp.buildSubtitleArgs({
            langs: String(this.settings.youtubeSubtitleLangs || '').trim(),
            auto: this.settings.youtubeSubtitleAuto !== false,
            embed: this.settings.youtubeSubtitleEmbed === true,
          }),
        ],
        limitRate: Number(this.engine && this.engine.globalSpeedLimit) || 0,
        logPath,
        // yt-dlp is a CHILD PROCESS and does not inherit the browser session.
        // Forward the cookies this row already carries (captured by the
        // extension) plus the page URL as Referer, so a logged-in user's own
        // private / members-only / age-confirmed video actually downloads
        // instead of failing with "Sign in to confirm you're not a bot".
        cookies: download.cookies || (download.meta && download.meta.cookies) || null,
        referer: (download.meta && download.meta.pageUrl) || null,
        cookiesFromBrowser: String(this.settings.youtubeCookiesFromBrowser || '').trim() || null,
        // With video+audio the per-track total is only half the job; the
        // resolver's combined size makes the percentage honest.
        expectedBytes: (choice && choice.size) || download.totalSize || 0,
        timeoutMs: Math.max(5, Number(this.settings.youtubeTimeoutMinutes) || 30) * 60 * 1000,
        shouldAbort: () => !this.downloads.has(download.id) ||
          download._cancelRequested ||
          download.status === 'paused',
        onProgress: (p) => {
          download.downloaded = p.downloaded;
          download.totalSize = p.total || download.totalSize;
          download.speed = p.speed;
          download.percent = p.percent;
          download.eta = (p.eta != null ? p.eta : null);
          // Persist at most every 5s (same cadence as the engine path) so a
          // crash mid-download leaves a row with real bytes written instead of
          // a misleading 0 — yt-dlp's --continue then resumes the .part file.
          const now = Date.now();
          if (now - (this._lastYtProgressPersist || 0) > 5000) {
            this._lastYtProgressPersist = now;
            this._persistDownloads(true);
          }
          this.emit('download-progress', {
            id: download.id,
            downloaded: p.downloaded,
            totalSize: download.totalSize,
            speed: p.speed,
            percent: p.percent,
            eta: download.eta,
          });
        },
      });

      const produced = findProducedFile(dir, stem);
      if (!produced) {
        throw Object.assign(new Error('The download finished but no output file was found.'), { code: 'no-output' });
      }

      // yt-dlp chooses the container (m4a for an audio row; webm/mkv if a
      // merge had to fall back). Keep the chosen NAME but never lie about the
      // container — a .mp4 name on an m4a/mkv file breaks players, thumbnailers
      // and the category the row is filed under.
      // The template is "<stem>.yt%(ext)s", so everything after the ".yt"
      // marker is the container ("mkv", "m4a", or "mp4.mp4" when a merge
      // appended the merged extension — the last component is the real one).
      let finalPath = download.filepath;
      const marker = stem + '.yt';
      const base = path.basename(produced);
      if (base.startsWith(marker)) {
        const rest = base.slice(marker.length).split('.').filter(Boolean).pop();
        if (rest && /^[a-z0-9]{2,5}$/i.test(rest)) {
          const container = '.' + rest.toLowerCase();
          const rowExt = path.extname(finalPath);
          if (rowExt && container !== rowExt.toLowerCase()) {
            finalPath = finalPath.slice(0, finalPath.length - rowExt.length) + container;
          }
        }
      }

      try {
        if (path.resolve(produced) !== path.resolve(finalPath)) {
          if (fs.existsSync(finalPath)) finalPath = uniqueFilePath(finalPath);
          fs.renameSync(produced, finalPath);
        }
      } catch (e) {
        finalPath = produced;   // keep the file rather than losing the download
      }

      let size = 0;
      try { size = fs.statSync(finalPath).size; } catch (e) { /* stay 0 */ }

      // An empty or header-only file is never a finished download. Marking it
      // `completed` is the "31 bytes and it says 100% done" bug: the row looks
      // green, the file cannot be played, and the user has no idea why. Fail
      // with the real reason and remove the useless file.
      // 1 KiB is below the smallest possible valid media container (an mp4
      // needs its ftyp+moov boxes alone), so anything under it is an error
      // page or a stub, not a video.
      if (size < 1024) {
        try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (e) { /* best effort */ }
        fail('The download finished but the saved file is empty or incomplete, so it was not kept. Retry, or pick a different quality.', 'no-output', logPath);
        return true;
      }

      download.filepath = finalPath;
      download.filename = path.basename(finalPath);
      download.downloaded = size;
      download.totalSize = size;
      download.percent = 100;
      download.speed = 0;
      download.eta = null;
      download.sizeEstimated = false;
      download.status = 'completed';
      download.completedAt = Date.now();
      this._persistDownloads(true);
      this._processQueue();
      this.emit('download-complete', { id: download.id, totalSize: size, duration: null });
      // Same post-completion truth as the native/HLS path: prove the real
      // geometry from the merged file (yt-dlp's own container, so the row's
      // guessed label is the least reliable of all).
      // Guarded: this method is also driven with a minimal context (tests).
      try { this._finishRow(download); } catch (e) { /* never fail the row */ }
      return true;
    } catch (e) {
      const code = (e && e.code) || 'extract';
      if (code === 'aborted') {
        // Paused or removed mid-flight. yt-dlp leaves a .part file, so a
        // resume continues instead of starting over.
        if (this.downloads.has(download.id) && !download._cancelRequested) {
          download.status = 'paused';
          this._persistDownloads(true);
          this.emit('download-paused', { id: download.id });
        }
        return true;
      }
      fail((e && e.message) || 'YouTube download failed.', code, e && e.logPath);
      return true;
    } finally {
      // Free the slot on every path — success, error, pause and cancel —
      // or a single failure would leak it and stall the queue forever.
      this._ytActive = Math.max(0, (this._ytActive || 0) - 1);
    }
  }

  async _startDownload(download) {
    try {
      download.status = 'connecting';

      // YouTube rows never go through the generic probe: the URL is a signed
      // stream (or a watch page), so a HEAD/Range probe either proves nothing
      // or 403s from a different connection. yt-dlp re-extracts fresh URLs
      // itself on every start, which also makes a restart-able row possible.
      if (download.provider === 'youtube') {
        const handled = await this._startYoutubeDownload(download);
        if (handled) return;
      }

      // Merge session cookies into request headers BEFORE the probe.
      // KVS /get_file/ and other authenticated CDNs return 403 without the
      // session cookie — probing without it produces a useless meta result
      // (size 0, no Range support) that then poisons the real download.
      const reqHeaders = { ...(download.headers || {}) };
      // Anti-hotlink CDNs (bigcdn.cc et al.) accept only the video page as
      // Referer. When the caller gave none (e.g. a hand-typed URL), replay the
      // known page URL instead of letting the engine fall back to the CDN's
      // own origin — a CDN-origin Referer is rejected outright.
      if (!Object.keys(reqHeaders).some(k => k.toLowerCase() === 'referer') &&
          download.meta && download.meta.pageUrl) {
        reqHeaders.Referer = download.meta.pageUrl;
      }
      if (download.cookies && !reqHeaders.Cookie) {
        reqHeaders.Cookie = download.cookies;
      }

      // Resolve the real file name/size from the server before touching disk.
      // Cached on the download so we don't probe twice.
      const meta = await this._resolveFilename(download, reqHeaders);
      // Cookies a redirect hop issued during probing (token/session issuers
      // on /get_file/-style flows): replay them for the real download when
      // the browser supplied nothing better.
      if (!reqHeaders.Cookie && meta && meta.responseCookies) {
        reqHeaders.Cookie = meta.responseCookies;
      }
      // The user may have cancelled/removed/paused the row while the probe was
      // in flight (it can take seconds) — don't start a ghost download.
      if (this._startAborted(download)) return;

      // Dead-link guard: the probe with the real headers (Referer + session
      // cookies) proves the CDN no longer serves this URL (404/410). Fail at
      // ADD time with guidance instead of a doomed 0% "DOWNLOADING" row whose
      // segments each repeat the same 404. Fresh starts only — a resume with
      // bytes on disk keeps its existing behavior.
      // 401/403 with the real headers is a different verdict — blocked, not
      // necessarily gone (expired token, login wall, anti-hotlink rule) — so
      // it fails fast with its own message rather than sitting at 0% through
      // every segment retry or being misreported as "expired".
      if (!download.isHls && !download.isDash && download.downloaded === 0 && meta) {
        if (isDeadProbeStatus(meta.status)) {
          download.status = 'error';
          download.error = deadLinkMessage(meta.status);
          this._persistDownloads(true);
          this.emit('download-error', { id: download.id, error: download.error });
          this._processQueue();
          return;
        }
        if (meta.status === 401 || meta.status === 403) {
          download.status = 'error';
          download.error = accessDeniedMessage(meta.status);
          this._persistDownloads(true);
          this.emit('download-error', { id: download.id, error: download.error });
          this._processQueue();
          return;
        }
        // 501 rejects the request itself (strict CDNs answer 501 to
        // Range/HEAD from non-browser clients). Retrying cannot help — point
        // at the in-browser fallback instead of looping through segments.
        if (meta.status === 501) {
          download.status = 'error';
          download.error = methodBlockedMessage(meta.status);
          this._persistDownloads(true);
          this.emit('download-error', { id: download.id, error: download.error });
          this._processQueue();
          return;
        }
      }

      download.filepath = path.join(download.savePath, download.filename);

      // Ensure target directory exists
      const dir = path.dirname(download.filepath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // HLS streams (m3u8) are assembled segment-by-segment, not ranged.
      if (download.isDash) {
        // Minimal coverage: flag unsupported up front rather than silently
        // saving the manifest XML as a video.
        const err = new Error('DASH (.mpd) streams are not yet supported by AiDM.');
        download.status = 'error';
        download.error = err.message;
        this.emit('download-error', { id: download.id, error: err.message });
        return;
      }
      if (download.isHls) {
        // Live (no ENDLIST, e.g. Xtream/IPTV channels) records until stopped
        // or the user's cap elapses. VOD has no cap (0).
        download.maxSeconds = download.isLive ? ((this.settings.maxLiveMinutes || 180) * 60) : 0;
        // Persisted resume point for a restart: the engine's in-memory record
        // is gone after a restart, so feed the last flushed HLS state back in
        // from the row's saved progress (segProgress[0] = bytes written).
        // Without this the file was re-opened 'w' and every segment
        // re-downloaded from zero.
        const hlsProgress = Array.isArray(download._segProgress) ? (download._segProgress[0] || 0) : 0;
        await this.engine.startHlsDownload({
          id: download.id,
          url: download.url,
          filepath: download.filepath,
          headers: reqHeaders,
          expectedSize: download.totalSize || 0,
          variantUrl: download.hlsVariantUrl || null,
          maxSeconds: download.maxSeconds || 0,
          resumeIndex: download._hlsResumeIndex || 0,
          resumeBytes: download._hlsResumeBytes || (download.downloaded > 0 ? hlsProgress : 0),
        });
        return;
      }

      // Build per-segment resume offsets from the persisted progress so a
      // restart (or re-queue) continues from the last written byte instead of
      // re-downloading everything.
      // A non-resumable row (file hoster) is excluded on purpose: splicing new
      // bytes onto a stale part file is what produced corrupt downloads.
      const singleConnection = download.singleConnection === true;
      const resumable = download.resumable !== false;
      let resumeOffsets = null;
      if (resumable && download.downloaded > 0 && download.totalSize > 0 && Array.isArray(download._segProgress)) {
        resumeOffsets = {};
        download._segProgress.forEach((bytes, i) => { resumeOffsets[i] = bytes || 0; });
      }

      const engineDl = await this.engine.startDownload({
        id: download.id,
        url: download.url,
        filepath: download.filepath,
        totalSegments: download.segments || this.settings.defaultSegments,
        headers: reqHeaders,
        meta: download._probe || meta,
        resumeOffsets,
        mirrors: download.mirrors || [],
        checksum: download.checksum || null,
        // File hosters reject Range and corrupt parallel segments — one plain
        // connection, honestly marked non-resumable (team E's engine honours
        // both and always starts such a row clean).
        singleConnection,
        resumable,
      });
      // Cancelled while the engine was doing its own probe: tear the engine
      // state (and any partial file) back down instead of leaving it running.
      if (this._startAborted(download)) this.engine.cancelDownload(download.id);
    } catch (err) {
      download.status = 'error';
      // Map the engine's raw HTTP failures to friendly guidance: a 404/410
      // mid-stream is the same expired-CDN-link situation as a dead probe,
      // 401/403 means the request was blocked (see accessDeniedMessage), and
      // 501 rejects the request itself (see methodBlockedMessage).
      const httpDead = /HTTP (404|410|401|403|501)\b/.exec(err && err.message);
      if (httpDead) {
        const code = parseInt(httpDead[1], 10);
        download.error = (code === 401 || code === 403)
          ? accessDeniedMessage(code)
          : (code === 501 ? methodBlockedMessage(code) : deadLinkMessage(code));
      } else {
        download.error = err.message;
      }
      this.emit('download-error', { id: download.id, error: download.error });
      this._processQueue();
    }
  }

  pauseDownload(id) {
    const dl = this.downloads.get(id);
    this.engine.pauseDownload(id);
    this.queue = this.queue.filter(qid => qid !== id);
    // The engine only knows downloads it already started. A 'connecting' or
    // 'queued' row has no engine state yet — engine.pauseDownload no-oped, so
    // flip the row here or it would silently start downloading anyway.
    // YouTube rows run outside the engine (yt-dlp child process), so they are
    // mid-'downloading' with no engine state: pausing them must flip the row
    // too, or the abort watcher in _startYoutubeDownload would never fire.
    const noEngineState = !!dl && !this.engine.getDownload(id);
    if (noEngineState && (dl.status === 'connecting' || dl.status === 'queued' ||
        (dl.status === 'downloading' && dl.provider === 'youtube'))) {
      dl.status = 'paused';
      this._persistDownloads(true);
      this.emit('download-paused', { id });
    }
    return dl;
  }

  resumeDownload(id) {
    const dl = this.downloads.get(id);
    if (!dl) return null;

    // Accept 'downloading' status as resumable when the underlying engine task
    // is actually paused. This handles a race where a stale progress tick
    // (fired from the 500ms engine ticker right after pause) re-wrote
    // dl.status back to 'downloading' before the ticker stopped.
    const engineTask = this.engine.activeTasks?.get(id);
    const engineTaskPaused = engineTask && engineTask.state === 'paused';
    const resumable = ['paused', 'error', 'queued-paused'].includes(dl.status) || engineTaskPaused;
    if (!resumable) return dl;

    const activeCount = this._getActiveCount();
    if (activeCount < this.maxConcurrent) {
      if (this.engine.getDownload(id)) {
        this.engine.resumeDownload(id);
        dl.status = 'downloading';
      } else {
        // The engine has no state for this download (it was loaded from disk
        // after a restart, or it never got past probing). engine.resumeDownload
        // would silently no-op while the row claimed "Downloading" forever —
        // start it properly instead; _startDownload continues from the
        // persisted per-segment byte offsets.
        this._startDownload(dl);
      }
    } else {
      this.queue.push(id);
      dl.status = 'queued';
    }
    return dl;
  }

  cancelDownload(id) {
    const dl = this.downloads.get(id);
    // Tell any in-flight _startDownload (probing phase) to stand down.
    if (dl) dl._cancelRequested = true;
    this.engine.cancelDownload(id);
    this.queue = this.queue.filter(qid => qid !== id);
    this.downloads.delete(id);
    this._persistDownloads(true);
    this.emit('download-removed', { id });
    return true;
  }

  removeDownload(id) {
    const dl = this.downloads.get(id);
    if (!dl) return false;
    dl._cancelRequested = true;
    // Cancel unconditionally (a no-op when the engine isn't running it): a
    // 'connecting' download used to survive removal and start anyway,
    // writing a file for a row that no longer exists.
    this.engine.cancelDownload(id);
    this.queue = this.queue.filter(qid => qid !== id);
    this.downloads.delete(id);
    this._persistDownloads(true);
    this.emit('download-removed', { id });
    return true;
  }

  getAllDownloads() {
    return Array.from(this.downloads.values());
  }

  getSettings() {
    return { ...this.settings };
  }

  saveSettings(newSettings) {
    // Deep-merge the nested maps: a settings dialog that leaves a file-hoster
    // password blank must not wipe the saved one, and a newer hoster added by
    // a later version must survive an older settings payload.
    const merged = { ...this.settings, ...newSettings };
    if (newSettings && typeof newSettings.categoryPaths === 'object' && newSettings.categoryPaths) {
      merged.categoryPaths = { ...(this.settings.categoryPaths || {}), ...newSettings.categoryPaths };
    }
    if (newSettings && typeof newSettings.fileHosts === 'object' && newSettings.fileHosts) {
      const nextHosts = { ...(this.settings.fileHosts || {}), ...newSettings.fileHosts };
      for (const [host, cfg] of Object.entries(nextHosts)) {
        if (cfg && typeof cfg === 'object') {
          nextHosts[host] = { ...((this.settings.fileHosts || {})[host] || {}), ...cfg };
        }
      }
      merged.fileHosts = nextHosts;
    }
    this.settings = merged;
    this.maxConcurrent = this.settings.maxConcurrentDownloads;
    // Propagate speed limit to the engine (bytes/sec; 0 = unlimited)
    this.engine.setSpeedLimit(this.settings.speedLimit || 0);
    this.engine.setHlsConcurrency(this.settings.hlsConcurrency || 6);
    this._ensureDirectories();
    this._saveSettings();
    return this.settings;
  }

  startQueue() {
    // Promote queue-paused items back to runnable, then start filling slots.
    this.queue.forEach(id => {
      const dl = this.downloads.get(id);
      if (dl && dl.status === 'queued-paused') dl.status = 'queued';
    });
    this._processQueue();
  }

  pauseQueue() {
    this.queue.forEach(id => {
      const dl = this.downloads.get(id);
      if (dl) dl.status = 'queued-paused';
    });
  }

  _processQueue() {
    const activeCount = this._getActiveCount();
    if (activeCount >= this.maxConcurrent) return;
    let slots = this.maxConcurrent - activeCount;
    for (let i = 0; i < this.queue.length && slots > 0;) {
      const id = this.queue[i];
      const dl = this.downloads.get(id);
      if (dl && dl.status === 'queued') {
        // Remove from the queue only when it actually starts. The old shift()
        // dropped non-starting items permanently — a queued-paused row that
        // went through here once could never be started by startQueue().
        this.queue.splice(i, 1);
        this._startDownload(dl);
        slots--;
      } else if (!dl || dl.status === 'paused' || dl.status === 'cancelled' ||
                 dl.status === 'completed' || dl.status === 'error') {
        // Stale entry (row removed or no longer runnable) — drop it.
        this.queue.splice(i, 1);
      } else {
        // 'queued-paused' and anything else stays in place for startQueue().
        i++;
      }
    }
  }

  _getActiveCount() {
    let count = 0;
    this.downloads.forEach(dl => {
      if (dl.status === 'downloading' || dl.status === 'connecting') count++;
    });
    return count;
  }

  _extractFilename(url) {
    try {
      const raw = String(url || '');
      // blob: URLs carry the page origin, not a file name — strip the scheme
      // and parse what remains so `blob:https://x.com/uuid` doesn't leak a URL.
      const inner = raw.startsWith('blob:') ? raw.slice(5) : raw;
      const parsed = new URL(inner);
      let name = path.basename(parsed.pathname);
      if (!name || name === '/' || name === parsed.hostname) name = '';
      if (name) {
        name = decodeURIComponent(name).replace(/[<>:"/\\|?*]/g, '_').trim();
      }
      // Windows MAX_PATH is 260; keep the name itself well under that so the
      // full path (save dir + name) never exceeds the limit and causes ENOENT.
      if (name && name.length > 150) {
        const ext = path.extname(name).slice(0, 10);
        name = name.slice(0, 150 - ext.length) + ext;
      }
      if (name) return name;
    } catch {
      /* fall through to the fallback below */
    }
    return 'download_' + Date.now();
  }

  /**
   * Pick the initial file name for a new download. An explicit name wins
   * unless it is generic (bare hostname, rendition-only, CDN hash,
   * placeholder — see titles.isGenericFilename); generic names identify no
   * video, so the specific URL basename or the real page/video title is more
   * truthful. Never throws: falls back to _extractFilename.
   */
  _deriveFilename(url, provided, meta, quality) {
    try {
      const cleanProvided = provided ? this._cleanFilename(provided) : null;
      if (cleanProvided && !isGenericFilename(cleanProvided, url)) return cleanProvided;
      const urlBase = this._extractFilename(url);
      if (urlBase && !isGenericFilename(urlBase, url)) return urlBase;
      const pageTitle = cleanPageTitle(meta && (meta.pageTitle || meta.title), null);
      if (pageTitle) {
        const q = quality && quality.label && String(quality.label).toLowerCase() !== 'unknown'
          ? ` [${quality.label}]` : '';
        let ext = 'mp4';
        try {
          const m = /\.([A-Za-z0-9]{2,4})(?:[?#]|$)/.exec(String(url || ''));
          if (m) ext = m[1].toLowerCase();
        } catch {}
        return this._cleanFilename(`${pageTitle}${q}.${ext}`) || urlBase;
      }
      return urlBase;
    } catch {
      return this._extractFilename(url);
    }
  }

  /**
   * Improve a download's file name from the server's own response.
   *
   * Order of authority:
   *   1. a `Content-Disposition` filename (the real name the server gives);
   *   2. a container extension guessed from `Content-Type` when the URL-derived
   *      name has none (fixes `videoplayback`, `blob:` ids, query strings, …).
   *
   * A generic current name (bare hostname like "mydaddy.cc [1080p].mp4",
   * rendition-only "1080.mp4", CDN hash) is replaced by the server's real
   * name whenever one exists — the old code kept any name that already had an
   * extension, so hostname-derived names survived even when Content-Disposition
   * knew better.
   *
   * Returns true when the name (and possibly the category/save path) changed.
   * HLS streams keep the `.ts` container the engine assembles them into.
   */
  _refineFilename(dl, meta) {
    if (!meta) return false;
    const cur = String(dl.filename || '');
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(cur);
    const curGeneric = isGenericFilename(cur, dl.url);

    let next = cur;
    const cd = meta.suggestedFilename ? this._cleanFilename(meta.suggestedFilename) : null;
    const cdUsable = cd && /\.[A-Za-z0-9]{1,8}$/.test(cd) && !isGenericFilename(cd, dl.url);
    if (curGeneric && cdUsable) {
      next = cd;
    } else if (!hasExt) {
      if (cdUsable) {
        next = cd;
      } else {
        const ext = extFromMime(meta.contentType);
        if (ext) next = cur + '.' + ext;
      }
    }
    if (!next || next === cur) return false;

    // HLS streams are assembled into a single .ts container.
    if (dl.isHls) {
      next = next.replace(/\.(mp4|mkv|webm|m4v|mov|avi|m3u8|mpd)$/i, '');
      if (!/\.ts$/i.test(next)) next += '.ts';
    }

    dl.filename = next;
    dl.category = detectCategory(next);

    // If the user (or the caller) hasn't pinned a folder, a category change
    // should move the download into that category's default folder.
    if (!dl._customPath) {
      const catPath = this.settings.categoryPaths[dl.category] || '';
      dl.savePath = catPath || this.settings.defaultSavePath;
    }
    return true;
  }

  /**
   * Ask the server for the real file name/size up front. Never throws: on any
   * failure it returns `null` and the URL-derived name is kept. The result is
   * cached on the download so `_startDownload` can reuse it without a second
   * probe. Emits `download-updated` when the name improves.
   *
   * `extraHeaders` (e.g. session Cookie + Referer) must be passed in for
   * authenticated CDNs — probing without them gets 403 and a useless meta.
   */
  async _resolveFilename(download, extraHeaders = null) {
    if (download._nameResolved) return download._probe || null;
    const probeHeaders = extraHeaders || download.headers || {};
    let meta = null;
    let hlsSize = null;
    try {
      if (download.isHls) {
        // Real (or close-estimate) total size from the playlist, so the UI can
        // show a size for an HLS stream before/while it downloads.
        hlsSize = await Promise.race([
          this.engine.probeHlsSize(download.url, probeHeaders),
          new Promise((r) => setTimeout(() => r(null), 20000)),
        ]);
        if (hlsSize && hlsSize.totalSize > 0) {
          download.totalSize = hlsSize.totalSize;
          download.sizeEstimated = !!hlsSize.estimated;
        }
        // fMP4 (`#EXT-X-MAP`) playlists assemble into a real .mp4; everything
        // else into .ts. Set here too so direct .m3u8 URLs get the right name.
        download.isLive = !!(hlsSize && hlsSize.isLive);
        download._hlsContainer = (hlsSize && hlsSize.container) || 'ts';
      } else {
        meta = await Promise.race([
          this.engine.probeMeta(download.url, probeHeaders),
          new Promise((r) => setTimeout(() => r(null), 8000)),
        ]);
        // Surface the real size up front: direct downloads usually advertise a
        // Content-Length, and showing it early avoids an "Unknown" row.
        if (meta && meta.contentLength > 0) {
          download.totalSize = meta.contentLength;
          download.sizeEstimated = false;
        }
        // Reclassify: a normal HEAD probe can land on a manifest — an
        // extension-less HLS URL (Xtream live `…/live/u/p/id`), a CDN proxy
        // path, or a KVS endpoint that returns the playlist with video/*
        // content. Without this, the manager saved the playlist text as a file.
        if (meta && mediaContentTypeIsStream(meta.contentType || '')) {
          if (isDashUrl(download.url) || /dash\+xml/.test(meta.contentType || '')) {
            download.isDash = true;
          } else {
            download.isHls = true;
            const h2 = await Promise.race([
              this.engine.probeHlsSize(download.url, probeHeaders),
              new Promise((r) => setTimeout(() => r(null), 20000)),
            ]);
            if (h2 && h2.totalSize > 0) {
              download.totalSize = h2.totalSize;
              download.sizeEstimated = !!h2.estimated;
            }
            download.isLive = !!h2 && !!h2.isLive;
            download._hlsContainer = (h2 && h2.container) || 'ts';
          }
        }
      }
    } catch (e) {
      meta = null;
      hlsSize = null;
    }
    download._nameResolved = true;
    // Only cache a probe that actually succeeded. A 403/401/5xx probe (common
    // for KVS /get_file/ when cookies are missing) would otherwise poison the
    // real download with a bogus size and no-Range fallback.
    const probeOk = meta && meta.status >= 200 && meta.status < 400;
    download._probe = probeOk ? meta : (hlsSize ? { contentLength: hlsSize.totalSize } : null);

    // Pick the real output container for HLS: fMP4 (`#EXT-X-MAP`) playlists
    // assemble into a genuine .mp4; everything else becomes .ts. Extensionless
    // DASH is forced to .mp4 too (so it isn't named after a query string).
    if (download.isHls && !/\.(ts|mp4|mkv|mov|m4v|webm|avi|mp3|m4a)$/i.test(download.filename)) {
      const ext = (download._hlsContainer === 'mp4') ? 'mp4' : 'ts';
      download.filename = download.filename.replace(/\.[^.]+$/i, '') + '.' + ext;
      download.category = detectCategory(download.filename);
    } else if (download.isDash && !/\.(mp4|mkv|ts)$/i.test(download.filename)) {
      download.filename = download.filename.replace(/\.[^.]+$/i, '') + '.mp4';
      download.category = detectCategory(download.filename);
    }

    // Refine the file name from the server (direct files only; HLS/DASH
    // resolve to a container decided just above).
    if (!download.isHls && !download.isDash && this._refineFilename(download, meta)) {
      download.filepath = path.join(download.savePath, download.filename);
    }
    this._persistDownloads(true);
    this.emit('download-updated', download);
    return meta || (hlsSize ? hlsSize : null);
  }

  _ensureDirectories() {
    const base = this.settings.defaultSavePath;
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
    for (const p of Object.values(this.settings.categoryPaths)) {
      if (p && !fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    }
  }

  /**
   * State file lives next to the settings file in the user's home dir —
   * NEVER inside the download folder. The old location
   * (<savePath>/.aidm_downloads.json) polluted the user's Desktop/Downloads
   * with a visible dotfile every time a download was added.
   */
  _getStatePath() {
    return path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.aidm_downloads.json'
    );
  }

  /** Legacy state locations that must be migrated away + deleted. */
  _getLegacyStatePaths() {
    const out = [];
    try {
      const legacy = path.join(this.settings.defaultSavePath || '', '.aidm_downloads.json');
      if (legacy) out.push(legacy);
    } catch {}
    // Common case from bug reports: save path was Desktop, so the dotfile
    // sat visibly on the Desktop. Clean it even after the user moved folders.
    try {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      if (home) {
        out.push(path.join(home, 'Desktop', '.aidm_downloads.json'));
        out.push(path.join(home, 'Downloads', '.aidm_downloads.json'));
      }
    } catch {}
    return [...new Set(out)];
  }

  /**
   * Persist the download list. Callers in user-action paths (add/pause/
   * resume/cancel/complete) pass force=true so the .bak backup is always
   * refreshed at a meaningful state boundary; the 5s progress tick omits it
   * so the backup only refreshes every 60s (a full copyFileSync on every
   * tick stalled the main thread on large lists).
   */
  _persistDownloads(force = false) {
    try {
      const dataPath = this._getStatePath();
      // Strip session cookies and probe caches — they are live credentials and
      // internal scratch, not something that should sit on disk in plaintext.
      // Keep `_segProgress` so a restart can resume mid-file.
      const data = Array.from(this.downloads.values()).map(d => {
        const { cookies, headers, meta, _probe, _normUrl, _nameResolved, _customPath, _speedSamples, ...rest } = d;
        return {
          ...rest,
          // Keep sanitized headers (Referer/Origin/UA) but never cookies —
          // including a Cookie inside the resolver's own replay headers
          // (file hosters hand us a session cookie in `meta.headers`).
          headers: withoutCookieHeader(headers) || null,
          meta: meta && typeof meta === 'object'
            ? { ...meta, headers: withoutCookieHeader(meta.headers) }
            : (meta || null),
          status: d.status === 'downloading' ? 'paused' : d.status,
        };
      });
      // Atomic write (tmp + rename): a crash or power loss mid-write used to
      // leave a torn JSON file behind, and the next start silently wiped the
      // whole download list. The previous file stays intact until the rename.
      // On the 5s progress tick the .bak copy is refreshed at most every 60s:
      // a full copyFileSync of the whole list on every tick stalled the main
      // thread on large lists, and a 60s-old backup is still a good fallback.
      const tmpPath = dataPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      const now = Date.now();
      if (force) this._lastBakTime = 0;
      if (now - (this._lastBakTime || 0) > 60000) {
        try {
          fs.copyFileSync(dataPath, dataPath + '.bak');
          this._lastBakTime = now;
        } catch (e) { /* first run — no previous file to back up */ }
      }
      fs.renameSync(tmpPath, dataPath);
      // One-time cleanup: remove dotfiles left in download folders / Desktop
      // by older versions so they never reappear.
      try {
        for (const legacy of this._getLegacyStatePaths()) {
          if (legacy && legacy !== dataPath && fs.existsSync(legacy)) {
            try { fs.unlinkSync(legacy); } catch {}
          }
        }
      } catch {}
    } catch (e) {}
  }

  _loadDownloads() {
    try {
      const dataPath = this._getStatePath();
      // Migrate a legacy state file (old versions kept it in the save folder)
      // to the new home-dir location on first run after upgrade.
      try {
        if (!fs.existsSync(dataPath)) {
          for (const legacy of this._getLegacyStatePaths()) {
            if (legacy && legacy !== dataPath && fs.existsSync(legacy)) {
              try {
                fs.copyFileSync(legacy, dataPath);
                try { fs.unlinkSync(legacy); } catch {}
              } catch {}
              break;
            }
          }
        }
      } catch {}
      if (fs.existsSync(dataPath)) {
        let data = null;
        try {
          data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
        } catch (parseErr) {
          // Torn/corrupt main file: fall back to the last good copy instead of
          // silently starting with an empty list (which the next persist would
          // bake in, permanently deleting the user's history).
          try {
            data = JSON.parse(fs.readFileSync(dataPath + '.bak', 'utf-8'));
          } catch (bakErr) {
            data = null;
          }
        }
        if (Array.isArray(data)) data.forEach(d => {
          if (!d._normUrl) d._normUrl = normalizeMediaUrl(d.url); // migrate old saves
          if (typeof d.isHls !== 'boolean') d.isHls = isHlsUrl(d.url);
          // A restart must not resurrect a failed download as "paused" — the
          // user dismissed that error deliberately. Only genuinely
          // interrupted states become paused (and thus auto-resumable).
          if (d.status !== 'completed' && d.status !== 'cancelled' &&
              d.status !== 'pending-approval' && d.status !== 'error') {
            d.status = 'paused';
            d.speed = 0;
            d.percent = d.totalSize > 0 ? (d.downloaded / d.totalSize * 100).toFixed(1) : 0;
          } else if (d.status === 'error' || d.status === 'completed' || d.status === 'paused') {
            d.speed = 0;
          }
          this.downloads.set(d.id, d);
        });

        // Auto-resume incomplete downloads on startup (if the user left it on).
        // Rows that needed session cookies are excluded (needsSession): the
        // cookies are deliberately not persisted, so resuming them after a
        // restart sends an unauthenticated probe that fails 401/403. They stay
        // paused — the user can re-send them from the browser (fresh cookies).
        if (this.settings.autoResume !== false) {
          const incomplete = [...this.downloads.values()].filter(
            d => d.status === 'paused' && d.totalSize > 0 && d.downloaded < d.totalSize && !d.needsSession
          );
          for (const d of incomplete.slice(0, this.maxConcurrent)) {
            this._startDownload(d).catch(() => {});
          }
        }

        // Completed rows restored without a probe (older saves, or a crash
        // right after completion) get their real geometry in the background —
        // bounded, so a big library never stalls startup.
        this._probeRestoredRows();
      }
    } catch (e) {}
  }

  _loadSettings() {
    try {
      const settingsPath = path.join(
        process.env.USERPROFILE || process.env.HOME || '',
        '.aidm_settings.json'
      );
      if (fs.existsSync(settingsPath)) {
        const loaded = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        // Deep-merge the nested maps so a hoster or category added by a newer
        // version is always present in an older settings file.
        return {
          ...DEFAULT_SETTINGS,
          ...loaded,
          categoryPaths: { ...DEFAULT_SETTINGS.categoryPaths, ...(loaded.categoryPaths || {}) },
          fileHosts: {
            ...DEFAULT_SETTINGS.fileHosts,
            ...(loaded.fileHosts || {}),
            rapidgator: {
              ...(DEFAULT_SETTINGS.fileHosts.rapidgator || {}),
              ...((loaded.fileHosts || {}).rapidgator || {}),
            },
          },
        };
      }
    } catch (e) {}
    return { ...DEFAULT_SETTINGS };
  }

  _saveSettings() {
    try {
      const settingsPath = path.join(
        process.env.USERPROFILE || process.env.HOME || '',
        '.aidm_settings.json'
      );
      fs.writeFileSync(settingsPath + '.tmp', JSON.stringify(this.settings, null, 2));
      fs.renameSync(settingsPath + '.tmp', settingsPath);
    } catch (e) {}
  }
}

module.exports = {
  DownloadManager,
  CATEGORIES,
  detectCategory,
  normalizeMediaUrl,
  stripFbRange,
  isHlsUrl,
  isDashUrl,
  // YouTube engine helpers — exported so the regression suite can assert the
  // row wiring and the output-file picking without running a real download.
  youtubeFields,
  findProducedFile,
  uniqueFilePath,
  youtubeLogDir,
  pruneYoutubeLogs,
};
