// @ts-check
const { EventEmitter } = require('events');
const { readdir } = require('fs/promises');
const { join } = require('path');
const { loadControlFile } = require('./control-file');
const { TokenBucket } = require('./rate-limiter');
const { DownloadTask } = require('./task');
const { clamp } = require('./utils');

/**
 * Multi-download coordinator: bounded concurrency queue, shared global bandwidth bucket,
 * and crash recovery by re-hydrating tasks from `.part.meta` control files.
 */
class DownloadEngineCoordinator extends EventEmitter {
  /**
   * @param {{
   *   maxConcurrentDownloads?: number,
   *   globalSpeedLimit?: number,
   *   defaults?: any
   * }} [options]
   */
  constructor(options = {}) {
    super();
    this.tasks = new Map();
    this.queue = [];
    this.running = new Set();
    this.maxConcurrent = clamp(Math.floor(options.maxConcurrentDownloads ?? 3), 1, 100);
    this.globalLimiter = new TokenBucket(options.globalSpeedLimit ?? 0);
    this.defaults = options.defaults ?? {};
    this.paused = false;
  }

  // ---------------------------------------------------------------- task management

  /**
   * @param {any} options
   * @returns {DownloadTask}
   */
  add(options) {
    const task = new DownloadTask(options, { globalLimiter: this.globalLimiter }, this.defaults);
    if (this.tasks.has(task.id)) throw new Error(`Task ${task.id} already exists`);
    this.register(task);
    this.queue.push(task.id);
    this.emit('added', task);
    this.schedule();
    return task;
  }

  /**
   * @param {string} id
   * @returns {DownloadTask | undefined}
   */
  get(id) {
    return this.tasks.get(id);
  }

  /**
   * @returns {DownloadTask[]}
   */
  list() {
    return [...this.tasks.values()];
  }

  /**
   * @param {string} id
   */
  async pause(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.dequeue(id);
    await task.pause();
  }

  /**
   * @param {string} id
   */
  resume(id) {
    const task = this.tasks.get(id);
    if (!task || task.isTerminal) return;
    if (!this.queue.includes(id) && !this.running.has(id)) this.queue.push(id);
    this.schedule();
  }

  /**
   * @param {string} id
   * @param {{ deleteFiles?: boolean }} [opts]
   */
  async cancel(id, opts = {}) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.dequeue(id);
    await task.cancel(opts);
  }

  /**
   * @param {string} id
   * @param {{ deleteFiles?: boolean }} [opts]
   */
  async remove(id, opts = {}) {
    const task = this.tasks.get(id);
    if (!task) return;
    await this.cancel(id, { deleteFiles: opts.deleteFiles ?? task.state !== 'completed' });
    this.tasks.delete(id);
    this.emit('removed', task);
  }

  async pauseAll() {
    this.paused = true;
    await Promise.all(this.list().map((t) => t.pause()));
  }

  resumeAll() {
    this.paused = false;
    for (const task of this.tasks.values()) {
      if (task.state === 'paused' || task.state === 'queued' || task.state === 'failed') this.resume(task.id);
    }
  }

  // ---------------------------------------------------------------- global controls

  /**
   * @param {number} bytesPerSecond
   */
  setGlobalSpeedLimit(bytesPerSecond) {
    this.globalLimiter.setRate(bytesPerSecond);
  }

  get globalSpeedLimit() {
    return this.globalLimiter.bytesPerSecond;
  }

  /**
   * @param {number} n
   */
  setMaxConcurrentDownloads(n) {
    this.maxConcurrent = clamp(Math.floor(n), 1, 100);
    this.schedule();
  }

  get maxConcurrentDownloads() {
    return this.maxConcurrent;
  }

  get activeCount() {
    return this.running.size;
  }

  get queuedCount() {
    return this.queue.length;
  }

  // ---------------------------------------------------------------- crash recovery

  /**
   * Re-create a task from a `.part.meta` control file.
   * @param {string} controlFilePath
   * @param {any} [overrides]
   * @returns {Promise<DownloadTask | null>}
   */
  async restore(controlFilePath, overrides = {}) {
    const data = await loadControlFile(controlFilePath);
    if (!data || this.tasks.has(data.id)) return null;
    return this.add({ ...data.options, ...overrides, id: data.id, filename: data.filename });
  }

  /**
   * Scan a directory for unfinished downloads and restore them all.
   * @param {string} directory
   * @returns {Promise<DownloadTask[]>}
   */
  async restoreDirectory(directory) {
    let entries;
    try {
      entries = await readdir(directory);
    } catch {
      return [];
    }
    const restored = [];
    for (const entry of entries) {
      if (!entry.endsWith('.part.meta')) continue;
      const task = await this.restore(join(directory, entry));
      if (task) restored.push(task);
    }
    return restored;
  }

  // ---------------------------------------------------------------- internals

  /**
   * @param {DownloadTask} task
   */
  register(task) {
    this.tasks.set(task.id, task);
    task.on('state', (cur, prev) => this.emit('state', task, cur, prev));
    task.on('progress', (p) => this.emit('progress', task, p));
    task.on('segment', (s) => this.emit('segment', task, s));
    task.on('completed', (info) => this.emit('completed', task, info));
    task.on('failed', (err) => this.emit('failed', task, err));
    task.on('log', (entry) => this.emit('log', task, entry));
  }

  /**
   * @param {string} id
   */
  dequeue(id) {
    const idx = this.queue.indexOf(id);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  schedule() {
    if (this.paused) return;
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const task = this.tasks.get(id);
      if (!task || task.isTerminal || task.state === 'downloading' || task.state === 'probing') continue;
      this.running.add(id);
      task
        .start()
        .catch(() => undefined)
        .finally(() => {
          this.running.delete(id);
          this.schedule();
          if (this.running.size === 0 && this.queue.length === 0) this.emit('idle');
        });
    }
  }
}

module.exports = {
  DownloadEngineCoordinator,
};
