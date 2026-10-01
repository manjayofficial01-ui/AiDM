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
 * Version pin: WebTorrent 3.x requires Node >= 22, but Electron 28 bundles
 * Node 18, so we pin WebTorrent ^2.8 (engines: node >= 16). WebTorrent 2 is
 * ESM-only, hence the dynamic `import()` inside `_ensureClient()` — plain
 * `require()` fails with ERR_REQUIRE_ASYNC_MODULE.
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

class TorrentEngine extends EventEmitter {
  constructor() {
    super();
    /** @type {import('webtorrent') | null} */
    this.client = null;
    this._clientPromise = null;
    /** @type {Map<string, { torrent: any, download: any, startedAt: number, done: boolean }>} */
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
      this._clientPromise = import('webtorrent')
        .then((mod) => {
          const WebTorrent = mod.default;
          this.client = new WebTorrent();
          return this.client;
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

    let torrent;
    try {
      torrent = client.add(download.url, { path: download.savePath });
    } catch (err) {
      this.emit('download-error', { id: download.id, error: (err && err.message) || String(err) });
      return;
    }

    const job = { torrent, download, startedAt: Date.now(), done: false };
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
    this.emit('download-metadata', {
      id: job.download.id,
      name,
      totalSize: t.length,
      infoHash: t.infoHash,
      multiFile: !single,
    });
    this._emitProgress(job);
  }

  _onDone(job) {
    if (job.done) return;
    job.done = true;
    const t = job.torrent;
    this.emit('download-complete', {
      id: job.download.id,
      totalSize: t.length,
      duration: (Date.now() - job.startedAt) / 1000,
    });
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
    this.emit('download-progress', {
      id: job.download.id,
      downloaded: t.downloaded,
      totalSize: t.length,
      speed: t.downloadSpeed,
      percent: Math.round(t.progress * 10000) / 100,
      eta: Number.isFinite(remainingMs) && remainingMs > 0 ? Math.ceil(remainingMs / 1000) : null,
      peers: t.numPeers,
      uploadSpeed: t.uploadSpeed,
    });
  }

  /** @param {string} id */
  has(id) {
    const job = this.jobs.get(id);
    return !!(job && job.torrent && !job.torrent.destroyed);
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
    if (this.client) {
      try { this.client.throttleDownload(bytesPerSec > 0 ? bytesPerSec : -1); } catch { /* noop */ }
    }
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
};
