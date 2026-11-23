// @ts-check
// Cross-download per-host connection gate.
//
// Each task already caps its own connections, and the agent pool caps global
// sockets — but three concurrent downloads from the same CDN still burst 24
// connections at one host, which is exactly what rate-limiting CDNs punish
// (429s, soft-bans). The gate is a shared counter keyed by host with a
// waiter-callback design (no polling): a task that finds the host saturated
// registers a fill() callback and the releasing connection wakes exactly one
// waiter. limit <= 0 disables gating entirely.

class HostGate {
  /** @param {number} [limit] concurrent connections allowed per host (0 = off) */
  constructor(limit = 0) {
    this.limit = Math.max(0, parseInt(limit, 10) || 0);
    /** @type {Map<string, number>} */
    this.counts = new Map();
    /** @type {Map<string, Map<string, () => void>>} host -> (waiterKey -> cb) */
    this.waiters = new Map();
  }

  /** @param {number} n 0 disables gating and releases everyone. */
  setLimit(n) {
    const v = Math.max(0, parseInt(n, 10) || 0);
    if (v === this.limit) return;
    this.limit = v;
    if (v <= 0) {
      for (const host of [...this.waiters.keys()]) this._wake(host);
    }
  }

  hasCapacity(host) {
    if (this.limit <= 0) return true;
    return (this.counts.get(host) || 0) < this.limit;
  }

  /** Non-blocking claim. Returns false when the host is saturated. */
  acquire(host) {
    if (!this.hasCapacity(host)) return false;
    this.counts.set(host, (this.counts.get(host) || 0) + 1);
    return true;
  }

  release(host) {
    const n = (this.counts.get(host) || 0) - 1;
    if (n > 0) this.counts.set(host, n);
    else this.counts.delete(host);
    this._wake(host);
  }

  /**
   * Register (or replace) a callback invoked when `host` frees a slot.
   * Keyed so a re-arming task never stacks duplicate waiters.
   *
   * The callback may return `false` to say "I am gone — give the slot to
   * somebody else". `_wake` then keeps looking instead of burning the slot
   * on a dead task.
   */
  waitForSlot(host, key, cb) {
    let m = this.waiters.get(host);
    if (!m) {
      m = new Map();
      this.waiters.set(host, m);
    }
    m.set(key, cb);
  }

  /** Drop a task's waiters (task stopping/completing). */
  clearWaiter(host, key) {
    const m = this.waiters.get(host);
    if (!m) return;
    m.delete(key);
    if (m.size === 0) this.waiters.delete(host);
  }

  /**
   * Drop a key's waiters on EVERY host.
   *
   * A task can be waiting on more than one host (a mirror rotates), so
   * stopping it must clear all of them — a leftover waiter holds a closure
   * over the whole task and, worse, eats the next released slot.
   *
   * @param {string} key
   * @returns {number} how many waiters were removed
   */
  clearWaiters(key) {
    let removed = 0;
    for (const [host, m] of this.waiters) {
      if (m.delete(key)) removed += 1;
      if (m.size === 0) this.waiters.delete(host);
    }
    return removed;
  }

  /** How many waiters a key holds (diagnostics + tests). */
  waiterCount(key) {
    let n = 0;
    for (const m of this.waiters.values()) if (m.has(key)) n += 1;
    return n;
  }

  /**
   * Wake one live waiter for `host`.
   *
   * A waiter whose task has gone returns `false`; the slot is still free, so
   * the next waiter is tried. Without this a cancelled task's waiter swallows
   * the release and a LIVE task sits idle while the gate reports capacity.
   */
  _wake(host) {
    if (this.waiters.size === 0) return;
    if (!this.hasCapacity(host)) return;
    const m = this.waiters.get(host);
    if (!m || m.size === 0) return;
    for (const [key, cb] of [...m.entries()]) {
      m.delete(key);
      if (m.size === 0) this.waiters.delete(host);
      let consumed = true;
      try {
        consumed = cb() !== false;
      } catch (e) { /* a dead task's fill() is a no-op */ }
      if (consumed) return;
      // The task is gone: keep looking for a live waiter.
    }
  }
}

module.exports = { HostGate };
