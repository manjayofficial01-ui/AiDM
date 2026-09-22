// @ts-check
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { mkdir, rm, rename, utimes } = require('fs/promises');
const { join, resolve } = require('path');
const { verifyChecksum } = require('./checksum');
const { controlFilePath, loadControlFile, removeControlFile, saveControlFile } = require('./control-file');
const { DownloadError, toDownloadError } = require('./errors');
const { SegmentFileWriter } = require('./file-writer');
const { MirrorPool } = require('./mirrors');
const { basicAuthHeader, filenameFromUrl, probeRemote, sanitizeFilename, splitCredentials } = require('./probe');
const { TokenBucket } = require('./rate-limiter');
const { DEFAULT_RETRY_POLICY, backoffDelay } = require('./retry');
const { SegmentManager } = require('./segments');
const { SpeedMeter } = require('./speed');
const { DEFAULT_TASK_DEFAULTS } = require('./types');
const { Deferred, clamp, fileExists, fileSize, uniquePath } = require('./utils');
const { runSegmentWorker } = require('./worker');

const TICK_MS = 500;
const SAVE_INTERVAL_MS = 2000;
const ADAPT_INTERVAL_MS = 2000;
const ADAPT_COOLDOWN_MS = 10000;
const SERVER_LIMIT_COOLDOWN_MS = 30000;
const MAX_RESTARTS = 2;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; DownloadEngine/1.0)';

/**
 * @param {any} options
 * @param {any} [defaults]
 */
function resolveConfig(options, defaults = {}) {
  const merged = { ...DEFAULT_TASK_DEFAULTS, ...defaults, ...options };
  const { url, auth: urlAuth } = splitCredentials(merged.url);
  const mirrors = [url, ...(merged.mirrors ?? []).map((m) => splitCredentials(m).url)];
  const maxConnections = clamp(Math.floor(merged.maxConnections ?? 8), 1, 64);
  return {
    id: merged.id ?? randomUUID(),
    url,
    directory: resolve(merged.directory),
    filename: merged.filename ? sanitizeFilename(merged.filename) || undefined : undefined,
    mirrors,
    headers: { ...(merged.headers ?? {}) },
    userAgent: merged.userAgent ?? DEFAULT_USER_AGENT,
    referer: merged.referer,
    cookies: merged.cookies,
    auth: merged.auth ?? urlAuth,
    maxConnections,
    maxConnectionsPerServer: clamp(Math.floor(merged.maxConnectionsPerServer ?? 8), 1, 64),
    initialConnections: clamp(Math.floor(merged.initialConnections ?? 4), 1, maxConnections),
    minSplitSize: Math.max(64 * 1024, Math.floor(merged.minSplitSize ?? 1024 * 1024)),
    adaptiveConnections: merged.adaptiveConnections ?? true,
    pieceSelection: merged.pieceSelection ?? 'largest',
    speedLimit: Math.max(0, merged.speedLimit ?? 0),
    lowestSpeedLimit: Math.max(0, merged.lowestSpeedLimit ?? 0),
    connectTimeoutMs: Math.max(1000, merged.connectTimeoutMs ?? 30000),
    readTimeoutMs: Math.max(1000, merged.readTimeoutMs ?? 30000),
    retry: { ...DEFAULT_RETRY_POLICY, ...(merged.retry ?? {}) },
    checksum: merged.checksum,
    resumeOffsets: merged.resumeOffsets || null,
    preallocation: merged.preallocation ?? 'sparse',
    // `rename` is the only safe default: `overwrite` lets a re-added or
    // re-run download rm() an already finished file of the same name.
    onConflict: ['rename', 'overwrite', 'fail'].includes(merged.onConflict) ? merged.onConflict : 'rename',
    onResourceChange: merged.onResourceChange ?? 'restart',
    resumeValidation: merged.resumeValidation ?? 'lenient',
    preserveRemoteTime: merged.preserveRemoteTime ?? true,
    // File-hoster links (team B/F) reject Range: one plain connection, no splits.
    singleConnection: merged.singleConnection === true,
    // Both spellings occur in the wild (`resumeable` in older manager rows).
    resumable: merged.resumable !== false && merged.resumeable !== false,
    fetch: merged.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

class DownloadTask extends EventEmitter {
  /**
   * @param {any} options
   * @param {{ globalLimiter?: TokenBucket }} [deps]
   * @param {any} [defaults]
   */
  constructor(options, deps = {}, defaults = {}) {
    super();
    this.config = resolveConfig(options, defaults);
    this.id = this.config.id;
    const { fetch: _fetch, ...serializable } = options;
    this.originalOptions = { ...serializable, id: this.id };
    this.mirrors = new MirrorPool(this.config.mirrors, this.config.maxConnectionsPerServer);
    this.taskLimiter = new TokenBucket(this.config.speedLimit);
    this.limiters = deps.globalLimiter ? [deps.globalLimiter, this.taskLimiter] : [this.taskLimiter];
    this.baseHeaders = this.buildHeaders();

    /** @type {'queued' | 'probing' | 'downloading' | 'paused' | 'verifying' | 'completed' | 'failed' | 'cancelled'} */
    this.stateValue = 'queued';
    /** @type {any | null} */
    this.info = null;
    /** @type {SegmentManager | null} */
    this.segments = null;
    /** @type {SegmentFileWriter | null} */
    this.writer = null;

    /** @type {string | null} */
    this.filename = null;
    /** @type {string | null} */
    this.finalPath = null;
    /** @type {string | null} */
    this.partPath = null;
    /** @type {DownloadError | null} */
    this.errorValue = null;

    /** @type {AbortController | null} */
    this.runAbort = null;
    /** @type {Deferred<any> | null} */
    this.runFinished = null;
    /** @type {Deferred<void> | null} */
    this.loopDone = null;
    /** @type {'pause' | 'cancel' | null} */
    this.stopping = null;
    /** @type {DownloadError | null} */
    this.fatal = null;
    this.forceSingleConnection = this.config.singleConnection === true;
    /** Set when a worker proves the host ignores Range; drives the collapse. */
    this.rangeUnsupported = false;
    this.restarts = 0;
    /** True once we renamed the .part onto the final path (so cancel only
     *  ever removes files this task actually created). */
    this.finalPathWritten = false;

    /** @type {Map<number, Promise<void>>} */
    this.active = new Map();
    this.targetConnections = 1;
    /** @type {NodeJS.Timeout | null} */
    this.ticker = null;
    /** @type {NodeJS.Timeout | null} */
    this.retryTimer = null;

    this.meter = new SpeedMeter(5000);
    this.sessionStartedAt = 0;
    this.sessionBytes = 0;
    this.elapsedBeforeSession = 0;
    this.createdAt = Date.now();

    this.lastSaveAt = 0;
    this.lastAdaptAt = 0;
    this.lastAdaptSpeed = 0;
    /** @type {'up' | 'down' | 'none'} */
    this.lastAdaptAction = 'none';
    this.cooldownUntil = 0;
  }

  get state() {
    return this.stateValue;
  }

  get error() {
    return this.errorValue;
  }

  get remote() {
    return this.info;
  }

  get outputPath() {
    return this.finalPath;
  }

  get isTerminal() {
    return this.stateValue === 'completed' || this.stateValue === 'cancelled';
  }

  async start() {
    if (this.stateValue !== 'queued' && this.stateValue !== 'paused' && this.stateValue !== 'failed') {
      return this.stateValue;
    }
    if (this.runFinished) return this.runFinished.promise;

    this.runFinished = new Deferred();
    this.runAbort = new AbortController();
    this.stopping = null;
    this.fatal = null;
    this.errorValue = null;
    this.sessionStartedAt = Date.now();
    this.sessionBytes = 0;
    this.meter.reset();

    try {
      for (;;) {
        // Every attempt needs a fresh controller: fail() aborts the old one to
        // tear down the remaining connections, so reusing it would kill the
        // restart in its tracks (observed as an instant bogus CANCELLED).
        this.runAbort = new AbortController();
        this.stopping = null;
        this.fatal = null;
        this.errorValue = null;
        this.rangeUnsupported = false;
        try {
          await this.prepare();
          if (this.stopping) break;
          this.setState('downloading');
          this.emitProgress();
          await this.downloadLoop();
          if (this.stopping) break;
          await this.finalize();
          this.setState('completed');
          this.emit('completed', {
            id: this.id,
            path: this.finalPath ?? '',
            bytes: this.segments?.downloadedBytes ?? 0,
            elapsedMs: this.elapsedMs(),
          });
          break;
        } catch (err) {
          if (this.stopping) break;
          const de = toDownloadError(err);
          if (await this.shouldRestart(de)) continue;
          throw de;
        }
      }
    } catch (err) {
      const de = toDownloadError(err);
      this.errorValue = de;
      this.log('error', de.message);
      this.setState('failed');
      this.emit('failed', de);
    } finally {
      this.stopTicker();
      this.clearRetryTimer();
      await this.closeWriter();
      if (this.stateValue === 'paused' || this.stateValue === 'failed') {
        await this.saveControl().catch(() => {});
      }
      if (this.stateValue !== 'downloading' && this.stateValue !== 'probing') {
        this.elapsedBeforeSession += Date.now() - this.sessionStartedAt;
      }
      this.emitProgress();
      const finished = this.runFinished;
      this.runFinished = null;
      this.runAbort = null;
      finished?.resolve(this.stateValue);
    }
    return this.stateValue;
  }

  async pause() {
    if (this.stateValue !== 'downloading' && this.stateValue !== 'probing') return;
    this.stopping = 'pause';
    this.setState('paused');
    this.log('info', 'Paused');
    this.runAbort?.abort(new DownloadError('PAUSED', 'Download paused'));
    await this.runFinished?.promise;
  }

  async resume() {
    if (this.runFinished) {
      await this.runFinished.promise;
    }
    if (this.stateValue !== 'paused' && this.stateValue !== 'failed' && this.stateValue !== 'queued') {
      return this.stateValue;
    }
    return this.start();
  }

  /**
   * @param {{ deleteFiles?: boolean }} [opts]
   */
  async cancel(opts = {}) {
    if (this.isTerminal) return;
    const wasRunning = this.runFinished !== null;
    this.stopping = 'cancel';
    this.setState('cancelled');
    this.log('info', 'Cancelled');
    this.runAbort?.abort(new DownloadError('CANCELLED', 'Download cancelled'));
    if (wasRunning) await this.runFinished?.promise;
    await this.closeWriter();
    if (opts.deleteFiles ?? true) await this.deleteArtifacts();
  }

  /**
   * @param {number} bytesPerSecond
   */
  setSpeedLimit(bytesPerSecond) {
    this.config.speedLimit = Math.max(0, bytesPerSecond);
    this.taskLimiter.setRate(this.config.speedLimit);
  }

  /**
   * @param {number} n
   */
  setMaxConnections(n) {
    this.config.maxConnections = clamp(Math.floor(n), 1, 64);
    this.targetConnections = this.config.adaptiveConnections
      ? Math.min(this.targetConnections, this.config.maxConnections)
      : this.config.maxConnections;
    this.fill();
  }

  getProgress() {
    const total = this.segments?.totalSize ?? this.info?.size ?? null;
    const downloaded = this.segments?.downloadedBytes ?? 0;
    const speed = this.meter.bytesPerSecond();
    const elapsed = this.elapsedMs();
    const sessionSeconds = Math.max(0.001, (Date.now() - this.sessionStartedAt) / 1000);
    const averageSpeed = this.runFinished ? this.sessionBytes / sessionSeconds : 0;
    return {
      id: this.id,
      state: this.stateValue,
      url: this.config.url,
      filename: this.filename,
      path: this.finalPath,
      totalBytes: total,
      downloadedBytes: downloaded,
      percent: total ? Math.min(100, (downloaded / total) * 100) : total === 0 ? 100 : null,
      speed,
      smoothedSpeed: this.meter.smoothed,
      averageSpeed,
      etaSeconds: total !== null && speed > 0 ? Math.max(0, (total - downloaded) / speed) : null,
      connections: this.active.size,
      targetConnections: this.targetConnections,
      resumable: Boolean(this.info?.acceptRanges) && this.config.resumable && !this.forceSingleConnection,
      segments: this.segments?.snapshot() ?? [],
      mirrors: this.mirrors.snapshot(),
      elapsedMs: elapsed,
      error: this.errorValue?.toJSON() ?? null,
    };
  }

  toControlFile() {
    if (!this.segments || !this.info || !this.partPath || !this.finalPath || !this.filename) return null;
    return {
      version: 1,
      id: this.id,
      options: this.originalOptions,
      url: this.config.url,
      finalUrl: this.info.finalUrl,
      filename: this.filename,
      partPath: this.partPath,
      finalPath: this.finalPath,
      size: this.segments.totalSize,
      etag: this.info.etag,
      lastModified: this.info.lastModified,
      acceptRanges: this.info.acceptRanges,
      segments: this.segments.snapshot(),
      downloadedBytes: this.segments.downloadedBytes,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
    };
  }

  async prepare() {
    const signal = this.runAbort.signal;
    this.setState('probing');
    await mkdir(this.config.directory, { recursive: true });

    const info = await this.probeWithMirrors(signal);
    const previous = this.info;
    this.info = info;
    this.mirrors.updateUrl(this.mirrors.primary, info.finalUrl);
    // Cookies a redirect hop minted during probing (token/session issuers on
    // /get_file/-style flows): persist them for the segment requests when the
    // caller supplied nothing better — otherwise the probe succeeds but every
    // segment that skips the minting hop is refused.
    if (info.responseCookies &&
        !Object.keys(this.baseHeaders).some((k) => k.toLowerCase() === 'cookie')) {
      this.baseHeaders.Cookie = info.responseCookies;
    }

    const name = sanitizeFilename(this.config.filename ?? info.filename ?? filenameFromUrl(info.finalUrl) ?? 'download') || 'download';
    let finalPath = join(this.config.directory, name);
    let partPath = `${finalPath}.part`;

    // A non-resumable resource (file hoster) must always start clean: never
    // splice new bytes onto a stale part file, it produces a corrupt output.
    const canResume = info.acceptRanges && !this.forceSingleConnection && this.config.resumable;
    let restored = null;

    if (canResume && this.segments && previous && this.sameEntity(previous, info) && this.filename === name) {
      restored = this.segments;
      if (this.finalPath && this.partPath) {
        finalPath = this.finalPath;
        partPath = this.partPath;
      }
    } else if (canResume) {
      const ctl = await loadControlFile(controlFilePath(partPath));
      if (ctl && (await fileExists(partPath)) && this.controlMatches(ctl, info)) {
        // Never trust the bitmap further than the bytes actually on disk: a
        // crash between "reserved" and "written" would otherwise leave
        // zero-filled holes in a file reported as complete.
        const onDisk = await fileSize(partPath);
        restored = SegmentManager.restore(ctl.segments, info.size, this.segmentOptions(info), onDisk);
        this.createdAt = ctl.createdAt;
        this.log('info', `Resuming from control file (${restored.downloadedBytes} bytes done)`);
      }
    }

    if (!restored && canResume && this.config.resumeOffsets && (info.size > 0 || info.size == null)) {
      const existingPath = (await fileExists(partPath)) ? partPath : ((await fileExists(finalPath)) ? finalPath : null);
      if (existingPath) {
        if (existingPath === finalPath && finalPath !== partPath) {
          await rename(finalPath, partPath).catch(() => {});
        }
        const totalSize = info.size;
        const offsets = Object.values(this.config.resumeOffsets).map(Number);
        const numSegments = Math.max(1, offsets.length);
        const segSize = Math.ceil(totalSize / numSegments);
        const snapshots = [];
        for (let i = 0; i < numSegments; i++) {
          const start = segSize * i;
          const end = Math.min(start + segSize - 1, totalSize - 1);
          const downloaded = Math.min(offsets[i] || 0, Math.max(0, end - start + 1));
          snapshots.push({
            id: i + 1,
            start,
            end,
            downloaded,
            state: downloaded >= (end - start + 1) ? 'done' : 'pending',
          });
        }
        const onDisk = await fileSize(partPath);
        restored = SegmentManager.restore(snapshots, totalSize, this.segmentOptions(info), onDisk);
        this.log('info', `Resuming from persisted offsets (${restored.downloadedBytes} bytes done)`);
      }
    }

    if (!restored) {
      if (await fileExists(finalPath)) {
        switch (this.config.onConflict) {
          case 'fail':
            throw new DownloadError('FILE_EXISTS', `${finalPath} already exists`);
          case 'overwrite':
            break;
          case 'rename':
            finalPath = await uniquePath(finalPath, (c) => fileExists(`${c}.part`));
            break;
        }
      }
      partPath = `${finalPath}.part`;
      await rm(partPath, { force: true });
      await removeControlFile(controlFilePath(partPath));
    }

    this.filename = name;
    this.finalPath = finalPath;
    this.partPath = partPath;
    this.segments = restored ?? SegmentManager.fresh(info.size, this.segmentOptions(info));

    this.writer = await SegmentFileWriter.open(partPath, {
      size: info.size,
      preallocation: this.config.preallocation,
      fresh: !restored,
    });

    const splitAllowed = info.acceptRanges && info.size !== null && !this.forceSingleConnection;
    this.targetConnections = !splitAllowed
      ? 1
      : this.config.adaptiveConnections
        ? Math.min(this.config.initialConnections, this.config.maxConnections)
        : this.config.maxConnections;
    this.lastAdaptSpeed = 0;
    this.lastAdaptAction = 'none';
    this.cooldownUntil = 0;

    this.log(
      'info',
      `Probed ${info.finalUrl}: size=${info.size ?? 'unknown'} ranges=${info.acceptRanges} etag=${info.etag ?? '-'}`,
    );
  }

  /**
   * @param {AbortSignal} signal
   */
  async probeWithMirrors(signal) {
    let lastError = null;
    for (const mirror of this.mirrors.all) {
      if (mirror.banned) continue;
      try {
        return await probeRemote(mirror.url, {
          headers: this.baseHeaders,
          fetchImpl: this.config.fetch,
          signal,
          timeoutMs: this.config.connectTimeoutMs,
        });
      } catch (err) {
        const de = toDownloadError(err);
        if (de.code === 'CANCELLED' || de.code === 'PAUSED') throw de;
        lastError = de;
        this.mirrors.reportFailure(mirror, de);
        this.log('warn', `Probe failed on ${mirror.host}: ${de.message}`);
      }
    }
    throw lastError ?? new DownloadError('NO_MIRRORS', 'No mirrors available');
  }

  async downloadLoop() {
    this.loopDone = new Deferred();
    this.startTicker();
    this.fill();
    try {
      await this.loopDone.promise;
    } finally {
      this.stopTicker();
      this.clearRetryTimer();
      this.loopDone = null;
    }
  }

  async finalize() {
    const writer = this.writer;
    const partPath = this.partPath;
    let finalPath = this.finalPath;
    if (writer) {
      await writer.sync().catch(() => {});
      await writer.close();
      this.writer = null;
    }

    // Never declare success on a short file. A transport that lost bytes
    // mid-stream (or a segment bitmap that was restored too optimistically)
    // must surface as an error instead of producing an unplayable "finished"
    // file that no checksum will ever catch.
    const expected = this.segments?.totalSize ?? this.info?.size ?? null;
    if (expected !== null && expected > 0) {
      // downloadedBytes is the authoritative count: sparse preallocation makes
      // the .part file report the final size from the very first tick.
      const written = this.segments?.downloadedBytes ?? 0;
      const actual = await fileSize(partPath);
      const short = Math.min(written, actual === null ? written : actual);
      if (written < expected || (actual !== null && actual < expected)) {
        throw new DownloadError(
          'INCOMPLETE',
          `Download is incomplete: ${short} of ${expected} bytes written`,
        );
      }
    }

    if (this.config.checksum) {
      this.setState('verifying');
      this.log('info', `Verifying ${this.config.checksum.algorithm} checksum`);
      await verifyChecksum(partPath, this.config.checksum, this.runAbort?.signal);
    }

    if (await fileExists(finalPath)) {
      switch (this.config.onConflict) {
        case 'fail':
          throw new DownloadError('FILE_EXISTS', `${finalPath} already exists`);
        case 'overwrite':
          await rm(finalPath, { force: true });
          break;
        case 'rename':
          finalPath = await uniquePath(finalPath, async () => false);
          break;
      }
    }

    await rename(partPath, finalPath);
    this.finalPath = finalPath;
    this.finalPathWritten = true;
    await removeControlFile(controlFilePath(partPath));

    if (this.config.preserveRemoteTime && this.info?.lastModified) {
      const mtime = new Date(this.info.lastModified);
      if (!Number.isNaN(mtime.getTime())) await utimes(finalPath, new Date(), mtime).catch(() => {});
    }
    this.log('info', `Saved to ${finalPath}`);
  }

  /**
   * @param {DownloadError} err
   */
  async shouldRestart(err) {
    const restartable =
      (err.code === 'RESOURCE_CHANGED' && this.config.onResourceChange === 'restart') ||
      err.code === 'RANGE_UNSUPPORTED';
    if (!restartable || this.restarts >= MAX_RESTARTS) return false;
    this.restarts++;
    if (err.code === 'RANGE_UNSUPPORTED') this.forceSingleConnection = true;
    this.rangeUnsupported = false;
    this.finalPathWritten = false;
    this.log('warn', `${err.message} - restarting from scratch (${this.restarts}/${MAX_RESTARTS})`);
    await this.closeWriter();
    if (this.partPath) {
      await rm(this.partPath, { force: true });
      await removeControlFile(controlFilePath(this.partPath));
    }
    this.segments = null;
    this.info = null;
    return true;
  }

  fill() {
    if (this.stopping || this.fatal || !this.segments || !this.info || !this.writer || !this.loopDone) return;
    const segments = this.segments;

    if (segments.isComplete) {
      if (this.active.size === 0) this.loopDone.resolve();
      return;
    }

    while (this.active.size < this.targetConnections) {
      if (!this.mirrors.hasCapacity()) break;
      const segment = segments.claim();
      if (!segment) break;
      const mirror = this.mirrors.select();
      if (!mirror) {
        segments.release(segment);
        break;
      }
      this.launch(segment, mirror);
    }

    if (this.active.size === 0) {
      const next = segments.nextRetryAt();
      if (next !== null) {
        this.scheduleRetry(next);
      } else if (!this.mirrors.hasCapacity()) {
        this.fail(
          this.rangeUnsupported
            ? new DownloadError('RANGE_UNSUPPORTED', 'Server ignored the Range header on every mirror')
            : new DownloadError('NO_MIRRORS', this.mirrors.lastError ?? 'All mirrors failed'),
        );
      }
    }
  }

  /**
   * @param {import('./segments').Segment} segment
   * @param {import('./mirrors').Mirror} mirror
   */
  launch(segment, mirror) {
    const segments = this.segments;
    this.mirrors.acquire(mirror);
    this.log('debug', `Connection #${segment.id} -> ${mirror.host} [${segment.position}-${segment.end < 0 ? '' : segment.end}]`);

    const run = runSegmentWorker(segment, mirror, {
      fetchImpl: this.config.fetch,
      headers: this.baseHeaders,
      info: this.info,
      writer: this.writer,
      limiters: this.limiters,
      signal: this.runAbort.signal,
      useRanges: this.info.acceptRanges && !this.forceSingleConnection,
      connectTimeoutMs: this.config.connectTimeoutMs,
      readTimeoutMs: this.config.readTimeoutMs,
      lowestSpeedLimit: this.config.lowestSpeedLimit,
      canDropSlow: () => this.active.size > 1,
      onBytes: (n) => {
        this.meter.add(n);
        this.sessionBytes += n;
      },
    })
      .then(
        (result) => {
          this.mirrors.reportSuccess(mirror, result.bytes, result.elapsedMs);
          segments.complete(segment);
          this.emit('segment', segment.snapshot());
        },
        (err) => {
          const de = toDownloadError(err);
          segments.release(segment);
          this.onWorkerError(segment, mirror, de);
        },
      )
      .finally(() => {
        this.mirrors.release(mirror);
        this.active.delete(segment.id);
        if (this.stopping) {
          if (this.active.size === 0) this.loopDone?.resolve();
          return;
        }
        if (this.fatal) {
          if (this.active.size === 0) this.loopDone?.reject(this.fatal);
          return;
        }
        this.fill();
      })
      // A throw from any of the callbacks above would otherwise become an
      // unhandled rejection inside the Electron main process.
      .catch((err) => this.log('warn', `Segment #${segment.id} worker crashed: ${String(err)}`));

    this.active.set(segment.id, run);
  }

  /**
   * @param {import('./segments').Segment} segment
   * @param {import('./mirrors').Mirror} mirror
   * @param {DownloadError} err
   */
  onWorkerError(segment, mirror, err) {
    // Cancel/pause already returned above via stopping / CANCELLED / PAUSED.
    if (this.stopping || err.code === 'CANCELLED' || err.code === 'PAUSED') return;

    if (err.code === 'RESOURCE_CHANGED') {
      this.fail(err);
      return;
    }

    if (err.code === 'RANGE_UNSUPPORTED') {
      // The resource itself refuses byte ranges — ban the mirror only when
      // another one can take over, otherwise fail with RANGE_UNSUPPORTED so
      // shouldRestart() collapses the whole task to a single plain connection.
      this.rangeUnsupported = true;
      this.mirrors.reportFailure(mirror, err);
      if (this.mirrors.hasAlternative(mirror)) {
        this.log('warn', `${mirror.host} does not support ranges; banned`);
        return;
      }
      this.fail(err);
      return;
    }

    if (err.code === 'SLOW_CONNECTION') {
      this.log('debug', err.message);
      segment.retryAt = Date.now();
      this.mirrors.reportFailure(mirror, err);
      return;
    }

    this.mirrors.reportFailure(mirror, err);

    if (err.status === 429 || err.status === 503 || (err.code === 'NETWORK' && this.active.size > 1)) {
      this.backOffConnections(err);
    }

    if (!err.retryable && !this.mirrors.hasAlternative(mirror)) {
      this.fail(err);
      return;
    }

    segment.attempts++;
    if (segment.attempts >= this.config.retry.maxTries) {
      this.fail(new DownloadError('MAX_TRIES', `Gave up after ${segment.attempts} attempts: ${err.message}`, { cause: err }));
      return;
    }
    const delay = backoffDelay(segment.attempts, this.config.retry, err.retryAfterMs);
    segment.retryAt = Date.now() + delay;
    this.log('warn', `Segment #${segment.id} failed (${err.message}); retry ${segment.attempts}/${this.config.retry.maxTries} in ${delay}ms`);
  }

  /**
   * @param {DownloadError} err
   */
  fail(err) {
    if (this.fatal) return;
    this.fatal = err;
    this.clearRetryTimer();
    if (this.active.size === 0) {
      this.loopDone?.reject(err);
    } else {
      this.runAbort?.abort(new DownloadError('CANCELLED', 'Aborting remaining connections'));
    }
  }

  /**
   * @param {number} at
   */
  scheduleRetry(at) {
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.fill();
    }, Math.max(0, at - Date.now()));
  }

  clearRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * @param {number} now
   */
  adapt(now) {
    if (!this.config.adaptiveConnections || !this.segments || !this.info?.acceptRanges || this.forceSingleConnection) return;
    const speed = this.meter.bytesPerSecond();
    if (now < this.cooldownUntil) {
      this.lastAdaptSpeed = speed;
      return;
    }
    const max = this.config.maxConnections;
    if (this.lastAdaptSpeed === 0) {
      if (this.targetConnections < max) this.stepUp();
    } else if (this.lastAdaptAction === 'up' && speed < this.lastAdaptSpeed * 0.85 && this.targetConnections > 1) {
      this.targetConnections--;
      this.lastAdaptAction = 'down';
      this.cooldownUntil = now + ADAPT_COOLDOWN_MS;
      this.log('debug', `Throughput dropped; connections -> ${this.targetConnections}`);
    } else if (speed > this.lastAdaptSpeed * 1.05 && this.targetConnections < max && this.segments.hasWork()) {
      this.stepUp();
    } else {
      this.lastAdaptAction = 'none';
    }
    this.lastAdaptSpeed = speed;
  }

  stepUp() {
    this.targetConnections++;
    this.lastAdaptAction = 'up';
    this.fill();
  }

  /**
   * @param {DownloadError} err
   */
  backOffConnections(err) {
    const next = Math.max(1, Math.min(this.targetConnections, this.active.size) - 1);
    if (next < this.targetConnections) {
      this.targetConnections = next;
      this.lastAdaptAction = 'down';
      this.cooldownUntil = Date.now() + SERVER_LIMIT_COOLDOWN_MS;
      this.log('warn', `Server pushed back (${err.message}); connections -> ${next}`);
    }
  }

  startTicker() {
    this.stopTicker();
    this.lastSaveAt = Date.now();
    this.lastAdaptAt = Date.now();
    this.ticker = setInterval(() => {
      const now = Date.now();
      this.meter.sample();
      this.emitProgress();
      if (now - this.lastSaveAt >= SAVE_INTERVAL_MS) {
        this.lastSaveAt = now;
        this.saveControl().catch((err) => this.log('warn', `Control file save failed: ${String(err)}`));
      }
      if (now - this.lastAdaptAt >= ADAPT_INTERVAL_MS) {
        this.lastAdaptAt = now;
        this.adapt(now);
      }
    }, TICK_MS);
    this.ticker.unref?.();
  }

  stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  async saveControl() {
    const data = this.toControlFile();
    if (!data || !this.partPath || !this.info?.acceptRanges || !this.config.resumable) return;
    await saveControlFile(controlFilePath(this.partPath), data);
  }

  async closeWriter() {
    const writer = this.writer;
    this.writer = null;
    if (writer) await writer.close().catch(() => {});
  }

  async deleteArtifacts() {
    if (this.partPath) {
      await rm(this.partPath, { force: true }).catch(() => {});
      await removeControlFile(controlFilePath(this.partPath)).catch(() => {});
    }
    // Only ever delete the final path when this task actually created it:
    // a cancel must not be able to destroy a pre-existing user file that the
    // rename policy deliberately stepped around.
    if (this.finalPath && this.finalPathWritten) {
      await rm(this.finalPath, { force: true }).catch(() => {});
    }
  }

  /**
   * @param {any} ctl
   * @param {any} info
   */
  controlMatches(ctl, info) {
    if (ctl.url !== this.config.url || !ctl.acceptRanges) return false;
    if (ctl.size !== info.size) return false;
    return this.validatorsMatch(ctl.etag, ctl.lastModified, info);
  }

  /**
   * @param {any} previous
   * @param {any} info
   */
  sameEntity(previous, info) {
    if (previous.size !== info.size) return false;
    return this.validatorsMatch(previous.etag, previous.lastModified, info);
  }

  /**
   * @param {string | null} etag
   * @param {string | null} lastModified
   * @param {any} info
   */
  validatorsMatch(etag, lastModified, info) {
    if (etag && info.etag) return etag === info.etag;
    if (lastModified && info.lastModified) return lastModified === info.lastModified;
    return this.config.resumeValidation === 'lenient';
  }

  /**
   * @param {any} info
   */
  segmentOptions(info) {
    return {
      minSplitSize: this.config.minSplitSize,
      pieceSelection: this.config.pieceSelection,
      allowSplit: info.acceptRanges && info.size !== null && !this.forceSingleConnection,
    };
  }

  buildHeaders() {
    const headers = { 'User-Agent': this.config.userAgent, ...this.config.headers };
    if (this.config.referer) headers.Referer = this.config.referer;
    if (this.config.cookies) headers.Cookie = this.config.cookies;
    if (this.config.auth) headers.Authorization = basicAuthHeader(this.config.auth);
    return headers;
  }

  elapsedMs() {
    const running = this.runFinished !== null ? Date.now() - this.sessionStartedAt : 0;
    return this.elapsedBeforeSession + running;
  }

  /**
   * @param {any} next
   */
  setState(next) {
    const prev = this.stateValue;
    if (prev === next) return;
    this.stateValue = next;
    this.emit('state', next, prev);
  }

  emitProgress() {
    if (this.listenerCount('progress') > 0) this.emit('progress', this.getProgress());
  }

  /**
   * @param {'debug' | 'info' | 'warn' | 'error'} level
   * @param {string} message
   */
  log(level, message) {
    if (this.listenerCount('log') > 0) this.emit('log', { level, message, time: Date.now() });
  }
}

module.exports = {
  DownloadTask,
  resolveConfig,
};
