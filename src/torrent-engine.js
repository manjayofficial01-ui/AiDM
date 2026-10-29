// @ts-check
/**
 * Torrent / magnet download engine (WebTorrent).
 *
 * The single biggest feature gap vs. modern download managers (FDM ships
 * libtorrent, Motrix 2.0 does BT+magnet): AiDM could not download a torrent
 * at all. This engine wraps WebTorrent so magnet URIs and .torrent links flow
 * through the SAME row lifecycle as HTTP downloads — add, progress, pause,
 * resume, complete, remove — with progress events shaped exactly like the
 * HTTP engine's so the UI and persistence code are untouched.
 *
 * Version pin: WebTorrent 3.x requires Node >= 22. On Electron 28 (Node 18)
 * we were pinned to ^2.8; the Electron 45 platform jump (Node 24.22) lifted
 * that, so we track ^3 now. WebTorrent is ESM-only in both lines, hence the
 * dynamic `import()` inside `_ensureClient()` — plain `require()` fails with
 * ERR_REQUIRE_ASYNC_MODULE.
 *
 * Advisory note: webtorrent → torrent-discovery → bittorrent-tracker still
 * depends on the abandoned `ip` package (GHSA-2p57-rm9w-gvfp, unpatched
 * upstream). npm `overrides` in package.json swaps it for our audited shim
 * tools/shims/node-ip (test/ip-shim.js pins the contract) — the only call the
 * tree makes is tracker-SERVER code a client never runs.
 *
 * Persistence/resume: WebTorrent's chunk store (fs-chunk-store) keeps pieces
 * under the save path, so re-adding the same magnet after an app restart
 * resumes where it stopped — matching the HTTP engine's resume promise.
 */
'use strict';
const { EventEmitter } = require('events');

/** @param {string} url */
function isTorrentUrl(url) {
  const s = String(url || '').trim();
  return /^magnet:\?/i.test(s) || /\.torrent([?#]|$)/i.test(s);
}

/**
 * Pull the display name out of a magnet URI (`&dn=…`) so the row has a real
 * name before metadata arrives. Returns '' when absent or undecodable.
 * @param {string} url
 */
function magnetDisplayName(url) {
  const m = /[?&]dn=([^&]+)/i.exec(String(url || ''));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
  } catch {
    return m[1];
  }
}

function cleanStringList(value, max = 100) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, max)
    : [];
}

function normalizeFileSelection(selection, count) {
  const out = new Array(Math.max(0, count)).fill(true);
  if (!Array.isArray(selection) || selection.length === 0) return out;
  if (selection.every((item) => Number.isInteger(item))) {
    out.fill(false);
    for (const index of selection) {
      if (index >= 0 && index < out.length) out[index] = true;
    }
    return out;
  }
  for (let i = 0; i < out.length; i++) out[i] = selection[i] !== false;
  return out;
}

function torrentFileSnapshot(torrent, selection) {
  return (torrent.files || []).map((file, index) => ({
    index,
    name: file.name,
    path: file.path || file.name,
    length: file.length,
    selected: selection[index] !== false,
    done: !!file.done,
    progress: file.progress || 0,
  }));
}

function selectedBytes(torrent, selection) {
  const files = torrent.files || [];
  if (!files.some((file) => Number.isFinite(file.downloaded))) return torrent.downloaded || 0;
  return files.reduce((sum, file, index) => (
    selection[index] === false ? sum : sum + (file.downloaded || 0)
  ), 0);
}

function selectedSize(torrent, selection) {
  return (torrent.files || []).reduce((sum, file, index) => (
    selection[index] === false ? sum : sum + file.length
  ), 0);
}

class TorrentEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      maxConns: Math.max(1, Math.floor(Number(options.maxConns) || 55)),
      dht: options.dht !== false,
      lsd: options.lsd !== false,
      utPex: options.utPex !== false,
      secure: Number.isFinite(options.secure) ? options.secure : 1,
      createClient: typeof options.createClient === 'function' ? options.createClient : null,
    };
    this.limits = {
      download: Math.max(0, Number(options.downloadLimit) || 0),
      upload: Math.max(0, Number(options.uploadLimit) || 0),
    };
    /** @type {import('webtorrent') | null} */
    this.client = null;
    this._clientPromise = null;
    /** @type {Map<string, { torrent: any, download: any, startedAt: number, done: boolean, selection: boolean[], files: any[] }>} */
    this.jobs = new Map();
    this._ticker = null;
  }

  /**
   * Lazy-load WebTorrent. ESM-only package → dynamic import from this CJS
   * module. One shared promise so concurrent starts reuse the same client.
   */
  _ensureClient() {
    if (this.client) return Promise.resolve(this.client);
    if (!this._clientPromise) {
      const clientOptions = {
        maxConns: this.options.maxConns,
        dht: this.options.dht,
        lsd: this.options.lsd,
        utPex: this.options.utPex,
        secure: this.options.secure,
      };
      this._clientPromise = Promise.resolve()
        .then(async () => {
          if (this.options.createClient) return this.options.createClient(clientOptions);
          const mod = await import('webtorrent');
          const WebTorrent = mod.default;
          return new WebTorrent(clientOptions);
        })
        .then((client) => {
          this.client = client;
          if (this.limits.upload > 0) client.throttleUpload(this.limits.upload);
          if (this.limits.download > 0) client.throttleDownload(this.limits.download);
          return client;
        })
        .catch((err) => {
          this._clientPromise = null;
          throw new Error(`WebTorrent failed to load: ${err && err.message ? err.message : err}`);
        });
    }
    return this._clientPromise;
  }

  /**
   * Start (or attach to) a torrent for a download row.
   * @param {{ id: string, url: string, savePath: string }} download
   */
  async start(download) {
    const client = await this._ensureClient();

    // Re-attach instead of double-adding (resume path: row restarted while
    // the torrent object still lives in the client).
    const existing = this.jobs.get(download.id);
    if (existing && existing.torrent && !existing.torrent.destroyed) {
      existing.download = download;
      this._wire(existing);
      return;
    }

    const rawSelection = Array.isArray(download.fileSelection) ? download.fileSelection : [];
    const explicitSelection = rawSelection.length > 0;
    const explicitPartial = explicitSelection && (
      rawSelection.every((item) => Number.isInteger(item)) ||
      rawSelection.some((item) => item === false)
    );
    let torrent;
    try {
      torrent = client.add(download.url, {
        path: download.savePath,
        announce: cleanStringList(download.trackerUrls),
        urlList: cleanStringList(download.webSeedUrls),
        maxWebConns: Math.max(0, Math.floor(Number(download.maxWebConns) || 4)),
        strategy: download.pieceStrategy === 'rarest' ? 'rarest' : 'sequential',
        deselect: explicitPartial,
      });
    } catch (err) {
      this.emit('download-error', { id: download.id, error: (err && err.message) || String(err) });
      return;
    }

    const job = {
      torrent,
      download,
      startedAt: Date.now(),
      done: false,
      selection: Array.isArray(download.fileSelection) && download.fileSelection.length ? download.fileSelection : null,
      files: [],
    };
    this.jobs.set(download.id, job);
    this._wire(job);
    this._ensureTicker();
  }

  _wire(job) {
    const t = job.torrent;
    if (job._wired) return;
    job._wired = true;
    t.on('metadata', () => this._onMetadata(job));
    t.on('done', () => this._onDone(job));
    t.on('error', (err) => this._onError(job, err));
    t.on('close', () => {
      this.jobs.delete(job.download.id);
      if (this.jobs.size === 0) this._stopTicker();
    });
    // Resume path: metadata can already be present when we attach.
    if (t.ready && t.files && t.files.length) this._onMetadata(job);
  }

  _onMetadata(job) {
    // Dedupe: a re-attached torrent can satisfy the `t.ready` check in _wire
    // AND emit 'metadata' a tick later.
    if (job._metadataSent) return;
    job._metadataSent = true;
    const t = job.torrent;
    const single = t.files && t.files.length === 1;
    const name = single ? t.files[0].name : t.name;
    job.name = name;
    const selection = normalizeFileSelection(job.selection, (t.files || []).length);
    job.selection = selection;
    this._applySelection(job);
    job.files = torrentFileSnapshot(t, selection);
    const size = selectedSize(t, selection);
    this.emit('download-metadata', {
      id: job.download.id,
      name,
      totalSize: size || t.length,
      infoHash: t.infoHash,
      multiFile: !single,
      files: job.files,
      fileSelection: selection.map((selected, index) => ({ index, selected })),
    });
    this._emitProgress(job);
  }

  _applySelection(job) {
    const files = job.torrent?.files || [];
    files.forEach((file, index) => {
      if (job.selection[index] === false) {
        if (typeof file.deselect === 'function') file.deselect();
      } else if (!file.done && typeof file.select === 'function') {
        file.select();
      }
    });
  }

  _selectedFiles(job) {
    return (job.torrent?.files || []).filter((_, index) => job.selection[index] !== false);
  }

  _onDone(job) {
    if (job.done) return;
    const selected = this._selectedFiles(job);
    const canTrack = selected.some((file) => typeof file.done === 'boolean' || Number.isFinite(file.downloaded));
    if (canTrack && selected.length && !selected.every((file) => file.done)) return;
    job.done = true;
    const t = job.torrent;
    const total = Math.max(0, selectedSize(t, job.selection || []));
    this.emit('download-complete', {
      id: job.download.id,
      totalSize: total,
      duration: (Date.now() - job.startedAt) / 1000,
      uploaded: t.uploaded || 0,
      ratio: typeof t.ratio === 'number' && Number.isFinite(t.ratio) ? t.ratio : 0,
    });
    const policy = job.download && job.download.seedPolicy;
    if (policy && policy !== 'unlimited' && this.client) {
      try {
        this.client.remove(t, { destroyStore: false }, () => {});
      } catch { /* already gone */ }
    }
  }

  _onError(job, err) {
    // 'close' follows most errors; report once.
    this.emit('download-error', { id: job.download.id, error: (err && err.message) || String(err) });
  }

  _ensureTicker() {
    if (this._ticker) return;
    this._ticker = setInterval(() => {
      for (const job of this.jobs.values()) this._emitProgress(job);
    }, 1000);
    this._ticker.unref?.();
  }

  _stopTicker() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  _emitProgress(job) {
    const t = job.torrent;
    if (!t || t.destroyed) return;
    const remainingMs = t.timeRemaining; // Infinity until speed > 0
    const selection = job.selection || normalizeFileSelection([], (t.files || []).length);
    const selectedDownloaded = t.files && t.files.length ? selectedBytes(t, selection) : t.downloaded;
    const selectedTotal = t.files && t.files.length ? selectedSize(t, selection) : t.length;
    const speed = t.downloadSpeed || 0;
    const remaining = Math.max(0, selectedTotal - selectedDownloaded);
    this.emit('download-progress', {
      id: job.download.id,
      downloaded: selectedDownloaded,
      totalSize: selectedTotal,
      speed,
      percent: selectedTotal ? Math.min(100, Math.round((selectedDownloaded / selectedTotal) * 10000) / 100) : Math.round((t.progress || 0) * 10000) / 100,
      eta: Number.isFinite(remainingMs) && remainingMs > 0 ? Math.ceil(remainingMs / 1000) : (speed > 0 && remaining > 0 ? Math.ceil(remaining / speed) : null),
      peers: t.numPeers,
      uploadSpeed: t.uploadSpeed,
      uploaded: t.uploaded || 0,
      ratio: typeof t.ratio === 'number' && Number.isFinite(t.ratio) ? t.ratio : 0,
    });
  }

  /** @param {string} id */
  has(id) {
    const job = this.jobs.get(id);
    return !!(job && job.torrent && !job.torrent.destroyed);
  }

  getInfo(id) {
    const job = this.jobs.get(id);
    if (!job || !job.torrent || job.torrent.destroyed) return null;
    const t = job.torrent;
    return {
      id,
      infoHash: t.infoHash || null,
      name: t.name || job.name || null,
      files: torrentFileSnapshot(t, job.selection || []),
      selection: job.selection || [],
      peers: t.numPeers || 0,
      downloaded: selectedBytes(t, job.selection || []),
      totalSize: selectedSize(t, job.selection || []),
      uploaded: t.uploaded || 0,
      downloadSpeed: t.downloadSpeed || 0,
      uploadSpeed: t.uploadSpeed || 0,
      ratio: typeof t.ratio === 'number' && Number.isFinite(t.ratio) ? t.ratio : 0,
      done: !!job.done,
    };
  }

  /**
   * @param {string} id
   * @param {Array<boolean|number>} selection
   */
  selectFiles(id, selection) {
    const job = this.jobs.get(id);
    if (!job || !job.torrent || job.torrent.destroyed) return false;
    job.selection = normalizeFileSelection(selection, (job.torrent.files || []).length);
    job.download.fileSelection = job.selection;
    this._applySelection(job);
    job.done = false;
    job.files = torrentFileSnapshot(job.torrent, job.selection);
    this.emit('download-metadata', {
      id,
      name: job.name,
      totalSize: selectedSize(job.torrent, job.selection),
      infoHash: job.torrent.infoHash,
      multiFile: !!(job.torrent.files && job.torrent.files.length !== 1),
      files: job.files,
      fileSelection: job.selection.map((selected, index) => ({ index, selected })),
    });
    this._emitProgress(job);
    return true;
  }

  /** @param {string} id */
  pause(id) {
    const job = this.jobs.get(id);
    if (job && job.torrent && !job.torrent.destroyed) {
      job.torrent.pause();
      return true;
    }
    return false;
  }

  /** @param {string} id */
  resume(id) {
    const job = this.jobs.get(id);
    if (job && job.torrent && !job.torrent.destroyed) {
      job.torrent.resume();
      return true;
    }
    return false;
  }

  /**
   * @param {string} id
   * @param {{ deleteFiles?: boolean }} [opts]
   */
  remove(id, opts = {}) {
    const job = this.jobs.get(id);
    this.jobs.delete(id);
    if (this.jobs.size === 0) this._stopTicker();
    if (job && job.torrent && this.client) {
      try {
        this.client.remove(job.torrent, { destroyStore: !!opts.deleteFiles }, () => {});
      } catch {
        /* already gone */
      }
    }
  }

  /** Global throttle in bytes/sec; 0/-1 disables. */
  setSpeedLimit(bytesPerSec) {
    const rate = Math.max(0, Number(bytesPerSec) || 0);
    this.limits.download = rate;
    if (this.client) {
      try { this.client.throttleDownload(rate > 0 ? rate : -1); } catch { /* noop */ }
    }
  }

  /** Global upload cap (seed bandwidth). 0 disables throttling. */
  setUploadLimit(bytesPerSec) {
    const rate = Math.max(0, Number(bytesPerSec) || 0);
    this.limits.upload = rate;
    if (this.client) {
      try { this.client.throttleUpload(rate > 0 ? rate : -1); } catch { /* noop */ }
    }
  }

  /** Apply a set of live/global caps in one call. */
  applyLimits(limits = {}) {
    if (limits.download !== undefined) this.setSpeedLimit(limits.download);
    if (limits.upload !== undefined) this.setUploadLimit(limits.upload);
    if (limits.maxConns !== undefined) this.options.maxConns = Math.max(1, Math.floor(Number(limits.maxConns) || 55));
    if (limits.dht !== undefined) this.options.dht = limits.dht !== false;
    if (limits.lsd !== undefined) this.options.lsd = limits.lsd !== false;
    if (limits.utPex !== undefined) this.options.utPex = limits.utPex !== false;
    return { ...this.options, ...this.limits };
  }

  async destroy() {
    this._stopTicker();
    this.jobs.clear();
    if (this.client) {
      const client = this.client;
      this.client = null;
      this._clientPromise = null;
      try { await client.destroy(); } catch { /* noop */ }
    }
  }
}

module.exports = {
  TorrentEngine,
  isTorrentUrl,
  magnetDisplayName,
  normalizeFileSelection,
  selectedBytes,
  selectedSize,
  torrentFileSnapshot,
};
