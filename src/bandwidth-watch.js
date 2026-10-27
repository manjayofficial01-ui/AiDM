'use strict';
/**
 * System-wide network throughput sampler for app-aware bandwidth.
 *
 * The 2026 download-manager trend (ABDM 1.11.0 ships it; the "smart
 * bandwidth" pattern generally): hold AiDM's own speed cap only while OTHER
 * applications actually need the network, and let downloads run unlimited
 * when the machine is otherwise idle — without the user flipping a manual
 * limit on and off.
 *
 * How "other apps" traffic is measured: Windows ships `typeperf`, which can
 * stream the "\Network Interface(*)\Bytes Total/sec" performance counter at
 * a fixed interval. One long-lived child process, one CSV line per sample,
 * zero new dependencies. macOS/Linux have no equivalent one-liner, so the
 * watch is INERT there (the feature no-ops) instead of shelling out to
 * fragile per-OS scripts.
 *
 * The emitted number is the machine's TOTAL NIC throughput; the caller
 * subtracts AiDM's own transfer speed to learn what everyone else uses.
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

class BandwidthWatch extends EventEmitter {
  /**
   * @param {{ intervalSec?: number, spawnFn?: Function, platform?: string }} opts
   *        `spawnFn`/`platform` are injectable for tests.
   */
  constructor(opts = {}) {
    super();
    this.intervalSec = opts.intervalSec || 2;
    this.spawnFn = opts.spawnFn || spawn;
    this.platform = opts.platform || process.platform;
    this.child = null;
    this.stopped = true;
    this._unavailable = false;
  }

  get running() {
    return !this.stopped && !!this.child;
  }

  start() {
    if (!this.stopped || this._unavailable) return;
    if (this.platform !== 'win32') {
      // No portable sampler off-Windows: stay silent, the manager treats a
      // watch that never samples as "unknown", which reads as not busy.
      this._unavailable = true;
      return;
    }
    this.stopped = false;
    try {
      // One stream of samples until killed. -si controls the cadence; the
      // first line is the CSV header, subsequent lines are samples.
      this.child = this.spawnFn('typeperf', [
        '\\Network Interface(*)\\Bytes Total/sec', '-si', String(this.intervalSec),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this._unavailable = true;
      this.stopped = true;
      this.emit('unavailable', e && e.message);
      return;
    }
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        const sample = BandwidthWatch.parseLine(line);
        if (sample !== null && !this.stopped) {
          this.emit('sample', { totalBytesPerSec: sample, at: Date.now() });
        }
      }
    });
    const fail = (err) => {
      if (this._unavailable || this.stopped) return;
      this._unavailable = true;
      this.stopped = true;
      this.emit('unavailable', (err && err.message) || 'typeperf failed');
    };
    this.child.stderr?.on('data', () => { /* counter-installed chatter; keep */ });
    this.child.on('error', fail);
    this.child.on('exit', (code) => {
      if (!this.stopped) fail(new Error(`typeperf exited early (code ${code})`));
    });
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      try { this.child.kill(); } catch (e) { /* already gone */ }
      this.child = null;
    }
  }

  /**
   * One typeperf CSV line → summed counter value, or null when the line is
   * not a sample (header, separator, garbled). Only fields that are ENTIRELY
   * numeric count: the first field is a timestamp ("10/27/2026 23:15:01.123")
   * whose leading digits must not leak into the sum.
   */
  static parseLine(line) {
    const s = String(line || '').trim();
    if (!s || s.startsWith('(PDH-CSV')) return null;
    let sum = 0;
    let sawNumber = false;
    for (const field of s.split(',')) {
      const v = field.replace(/"/g, '').trim();
      if (!/^-?\d+(\.\d+)?$/.test(v)) continue;
      sum += parseFloat(v);
      sawNumber = true;
    }
    return sawNumber ? sum : null;
  }
}

module.exports = { BandwidthWatch };
