const { DownloadEngine, extFromMime } = require('./download-engine');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const CATEGORIES = {
  video:    { label: 'Videos',    icon: '🎬', extensions: ['mp4','mkv','avi','mov','wmv','webm','flv','m4v','ts','m3u8'] },
  audio:    { label: 'Music',     icon: '🎵', extensions: ['mp3','wav','flac','aac','ogg','wma','m4a','opus'] },
  document: { label: 'Documents', icon: '📄', extensions: ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv','rtf','epub'] },
  archive:  { label: 'Archives',  icon: '📦', extensions: ['zip','rar','7z','tar','gz','bz2','xz','iso','dmg','img'] },
  software: { label: 'Software',  icon: '💿', extensions: ['exe','msi','deb','rpm','apk','appimage','msix'] },
  image:    { label: 'Images',    icon: '🖼️', extensions: ['jpg','jpeg','png','gif','bmp','svg','webp','tiff','psd','ico'] },
  other:    { label: 'Other',     icon: '📁', extensions: [] },
};

function detectCategory(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  for (const [cat, info] of Object.entries(CATEGORIES)) {
    if (info.extensions.includes(ext)) return cat;
  }
  return 'other';
}

// Query params that are per-request signatures/tokens (expiring CDN auth).
// Stripped for duplicate comparison so the same stream requested twice
// (e.g. site download button + extension capsule) matches as one download.
const TOKEN_PARAMS = new Set([
  'token', 'tokens', 'sig', 'signature', 'sign', 'expires', 'expiry', 'exp',
  'e', 'h', 'hdnea', 'hdntl', 'hdnts', 'st', 'key', 'auth', 'authkey',
  'wmsauthsign', 'mst', 'access_token', 'token_expires', 'session', 'sid',
  'policy', 'token_hash', 'verify', 'md5', 't', 'ts', '_',
]);

/**
 * Normalize a media URL for duplicate detection: lowercase host, sorted
 * non-token query params. Returns null for unparseable URLs.
 */
function normalizeMediaUrl(u) {
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
  return /\.m3u8($|\?|#)/i.test(String(u || ''));
}

const DEFAULT_SETTINGS = {
  maxConcurrentDownloads: 3,
  defaultSegments: 8,
  defaultSavePath: '',
  autoResume: true,
  speedLimit: 0,
  queueMaxActive: 3,
  clipboardMonitor: true,
  browserIntegration: true,
  notifications: true,
  askLocationEveryTime: false,
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
};

class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.engine = new DownloadEngine();
    this.downloads = new Map();
    this.queue = [];
    this.pendingApprovals = new Map(); // id -> {resolve, reject} for ask-every-time
    this.settings = this._loadSettings();
    this.maxConcurrent = this.settings.maxConcurrentDownloads;

    if (!this.settings.defaultSavePath) {
      this.settings.defaultSavePath = path.join(
        process.env.USERPROFILE || process.env.HOME || '',
        'Downloads', 'AiDM'
      );
    }

    // Ensure all category directories exist
    this._ensureDirectories();

    // Forward engine events
    this.engine.on('download-progress', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) {
        dl.downloaded = data.downloaded;
        dl.totalSize = data.totalSize;
        dl.speed = data.speed;
        dl.percent = data.percent;
        dl.segments = data.segments;
        dl.status = 'downloading';
      }
      this.emit('download-progress', data);
    });

    this.engine.on('download-complete', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) {
        dl.status = 'completed';
        dl.completedAt = Date.now();
        dl.duration = data.duration;
      }
      this._processQueue();
      this.emit('download-complete', data);
    });

    this.engine.on('download-error', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) {
        dl.status = 'error';
        dl.error = data.error;
      }
      this.emit('download-error', data);
    });

    this.engine.on('download-paused', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) dl.status = 'paused';
      this.emit('download-paused', data);
    });

    this.engine.on('download-resumed', (data) => {
      const dl = this.downloads.get(data.id);
      if (dl) dl.status = 'downloading';
      this.emit('download-resumed', data);
    });

    this._loadDownloads();
  }

  /**
   * Find an existing download for the same media (exact or normalized URL).
   * Used to avoid stacking a duplicate row when the same link is sent twice
   * (e.g. site download button + extension capsule/popup).
   */
  findDuplicate(url) {
    if (!url) return null;
    const norm = normalizeMediaUrl(url);
    for (const dl of this.downloads.values()) {
      if (dl.url === url) return dl;
      if (norm && dl._normUrl && dl._normUrl === norm) return dl;
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
  addDownload({ url, filename, savePath, segments, quality, meta, headers, cookies }) {
    const dup = this.findDuplicate(url);
    if (dup) return { ...dup, duplicate: true };

    const id = uuidv4();
    let parsedName = filename || this._extractFilename(url);
    if (isHlsUrl(url) && !/\.ts$/i.test(parsedName)) {
      // HLS streams are assembled into a single .ts container
      parsedName = parsedName.replace(/\.(mp4|mkv|webm|m4v|mov|avi|m3u8|mpd)$/i, '');
      if (!/\.ts$/i.test(parsedName)) parsedName += '.ts';
    }
    const category = detectCategory(parsedName);
    const categoryPath = this.settings.categoryPaths[category] || '';
    const defaultPath = categoryPath || this.settings.defaultSavePath;
    const finalSavePath = savePath || defaultPath;
    const finalPath = path.join(finalSavePath, parsedName);

    const download = {
      id,
      url,
      _normUrl: normalizeMediaUrl(url),
      filename: parsedName,
      category,
      savePath: finalSavePath,
      filepath: finalPath,
      segments: segments || this.settings.defaultSegments,
      status: 'queued',
      addedAt: Date.now(),
      downloaded: 0,
      totalSize: 0,
      speed: 0,
      percent: 0,
      quality: quality || null,      // e.g. { label: '1080p', resolution: '1920x1080', size: 50000000 }
      meta: meta || null,            // video metadata from detection
      headers: headers || null,      // allowlisted replay headers (Referer/Origin/UA)
      cookies: cookies || null,      // session cookies for authenticated downloads (KVS etc.)
      isHls: isHlsUrl(url),
      _customPath: !!savePath,       // a folder was chosen — don't auto-move it on refine
    };

    this.downloads.set(id, download);
    this._persistDownloads();
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
   * For the "ask every time" flow: learn the real file name, then raise the
   * topmost location dialog with it and the default folder already filled in.
   * The dialog still appears if the probe fails or times out, so a slow or
   * unreachable server never blocks the workflow.
   */
  _askLocation(dl) {
    const emit = () => {
      if (this.downloads.has(dl.id) && dl.status === 'pending-approval') {
        this.emit('download-ask-location', {
          id: dl.id,
          filename: dl.filename,
          category: dl.category,
          suggestedPath: dl.savePath,
          defaultPath: this.settings.categoryPaths[dl.category] || this.settings.defaultSavePath,
        });
      }
    };
    this._resolveFilename(dl).then(emit, emit);
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
    this._persistDownloads();
    return dl;
  }

  /** Cancel a download that's waiting for folder approval */
  rejectDownload(id) {    this.downloads.delete(id);
    this._persistDownloads();
    this.emit('download-removed', { id });
  }

  queueDownload(opts) {
    const dup = this.findDuplicate(opts.url);
    if (dup) return { ...dup, duplicate: true };

    const id = uuidv4();
    let parsedName = opts.filename || this._extractFilename(opts.url);
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

    const download = {
      id,
      url: opts.url,
      _normUrl: normalizeMediaUrl(opts.url),
      filename: parsedName,
      category,
      savePath: finalSavePath,
      filepath: finalPath,
      segments: opts.segments || this.settings.defaultSegments,
      status: 'queued',
      addedAt: Date.now(),
      downloaded: 0,
      totalSize: 0,
      speed: 0,
      percent: 0,
      quality: opts.quality || null,
      meta: opts.meta || null,
      headers: opts.headers || null,
      isHls: isHlsUrl(opts.url),
      _customPath: !!opts.savePath,
    };

    this.downloads.set(id, download);
    this.queue.push(id);
    this._persistDownloads();
    this.emit('download-added', download);
    return download;
  }

  async _startDownload(download) {
    try {
      download.status = 'connecting';

      // Resolve the real file name/size from the server before touching disk.
      // Cached on the download so we don't probe twice.
      const meta = await this._resolveFilename(download);
      download.filepath = path.join(download.savePath, download.filename);

      // Ensure target directory exists
      const dir = path.dirname(download.filepath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Merge session cookies into request headers for authenticated downloads
      const reqHeaders = { ...(download.headers || {}) };
      if (download.cookies && !reqHeaders.Cookie) {
        reqHeaders.Cookie = download.cookies;
      }

      // HLS streams (m3u8) are assembled segment-by-segment, not ranged.
      if (download.isHls) {
        await this.engine.startHlsDownload({
          id: download.id,
          url: download.url,
          filepath: download.filepath,
          headers: reqHeaders,
        });
        return;
      }

      await this.engine.startDownload({
        id: download.id,
        url: download.url,
        filepath: download.filepath,
        totalSegments: download.segments,
        headers: reqHeaders,
        meta: download._probe || meta,
      });
    } catch (err) {
      download.status = 'error';
      download.error = err.message;
      this.emit('download-error', { id: download.id, error: err.message });
      this._processQueue();
    }
  }

  pauseDownload(id) {
    this.engine.pauseDownload(id);
    this.queue = this.queue.filter(qid => qid !== id);
    return this.downloads.get(id);
  }

  resumeDownload(id) {
    const dl = this.downloads.get(id);
    if (!dl) return null;

    const activeCount = this._getActiveCount();
    if (activeCount < this.maxConcurrent) {
      this.engine.resumeDownload(id);
      dl.status = 'downloading';
    } else {
      this.queue.push(id);
      dl.status = 'queued';
    }
    return dl;
  }

  cancelDownload(id) {
    this.engine.cancelDownload(id);
    this.queue = this.queue.filter(qid => qid !== id);
    this.downloads.delete(id);
    this._persistDownloads();
    this.emit('download-removed', { id });
    return true;
  }

  removeDownload(id) {
    const dl = this.downloads.get(id);
    if (!dl) return false;
    if (dl.status === 'downloading') {
      this.engine.cancelDownload(id);
    }
    this.queue = this.queue.filter(qid => qid !== id);
    this.downloads.delete(id);
    this._persistDownloads();
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
    this.settings = { ...this.settings, ...newSettings };
    this.maxConcurrent = this.settings.maxConcurrentDownloads;
    this._ensureDirectories();
    this._saveSettings();
    return this.settings;
  }

  startQueue() { this._processQueue(); }

  pauseQueue() {
    this.queue.forEach(id => {
      const dl = this.downloads.get(id);
      if (dl) dl.status = 'queued-paused';
    });
  }

  _processQueue() {
    const activeCount = this._getActiveCount();
    if (activeCount >= this.maxConcurrent) return;
    const toStart = this.maxConcurrent - activeCount;
    for (let i = 0; i < toStart && this.queue.length > 0; i++) {
      const nextId = this.queue.shift();
      const dl = this.downloads.get(nextId);
      if (dl && (dl.status === 'queued' || dl.status === 'queued-paused')) {
        this._startDownload(dl);
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
      if (name) return name;
    } catch {
      /* fall through to the fallback below */
    }
    return 'download_' + Date.now();
  }

  /**
   * Improve a download's file name from the server's own response.
   *
   * Order of authority:
   *   1. a `Content-Disposition` filename (the real name the server gives);
   *   2. a container extension guessed from `Content-Type` when the URL-derived
   *      name has none (fixes `videoplayback`, `blob:` ids, query strings, …).
   *
   * Returns true when the name (and possibly the category/save path) changed.
   * HLS streams keep the `.ts` container the engine assembles them into.
   */
  _refineFilename(dl, meta) {
    if (!meta) return false;
    const cur = String(dl.filename || '');
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(cur);

    let next = cur;
    if (!hasExt) {
      const cd = meta.suggestedFilename ? this._cleanFilename(meta.suggestedFilename) : null;
      if (cd && /\.[A-Za-z0-9]{1,8}$/.test(cd)) {
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
   */
  async _resolveFilename(download) {
    if (download._nameResolved) return download._probe || null;
    let meta = null;
    try {
      meta = await Promise.race([
        this.engine.probeMeta(download.url, download.headers || {}),
        new Promise((r) => setTimeout(() => r(null), 8000)),
      ]);
    } catch (e) {
      meta = null;
    }
    download._nameResolved = true;
    download._probe = meta;
    if (this._refineFilename(download, meta)) {
      download.filepath = path.join(download.savePath, download.filename);
      this._persistDownloads();
      this.emit('download-updated', download);
    }
    return meta;
  }

  _ensureDirectories() {
    const base = this.settings.defaultSavePath;
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
    for (const p of Object.values(this.settings.categoryPaths)) {
      if (p && !fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    }
  }

  _persistDownloads() {
    try {
      const dataPath = path.join(this.settings.defaultSavePath, '.aidm_downloads.json');
      const data = Array.from(this.downloads.values()).map(d => ({
        ...d,
        status: d.status === 'downloading' ? 'paused' : d.status,
      }));
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    } catch (e) {}
  }

  _loadDownloads() {
    try {
      const dataPath = path.join(this.settings.defaultSavePath, '.aidm_downloads.json');
      if (fs.existsSync(dataPath)) {
        const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
        data.forEach(d => {
          if (!d._normUrl) d._normUrl = normalizeMediaUrl(d.url); // migrate old saves
          if (typeof d.isHls !== 'boolean') d.isHls = isHlsUrl(d.url);
          if (d.status !== 'completed' && d.status !== 'cancelled' && d.status !== 'pending-approval') {
            d.status = 'paused';
            d.speed = 0;
            d.percent = d.totalSize > 0 ? (d.downloaded / d.totalSize * 100).toFixed(1) : 0;
          }
          this.downloads.set(d.id, d);
        });
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
        // Deep-merge categoryPaths so new categories are always present
        return {
          ...DEFAULT_SETTINGS,
          ...loaded,
          categoryPaths: { ...DEFAULT_SETTINGS.categoryPaths, ...(loaded.categoryPaths || {}) },
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
      fs.writeFileSync(settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (e) {}
  }
}

module.exports = { DownloadManager, CATEGORIES, detectCategory, normalizeMediaUrl, isHlsUrl };
