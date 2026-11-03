// @ts-check
// Global connection budget (v5.9.0, clean-room port of the IDEA OmniGet
// benchmarks in its adaptive_concurrency.rs: N downloads × M segments each is
// NOT a throughput strategy — 8×8 regressed to half the throughput of a
// ~24-connection global budget split across downloads. A CDN (or a home
// uplink) has one congestion window, not one per download.)
//
// Two mechanisms, deliberately kept boring:
//  1. FAIR SHARE — every active download's connection ceiling becomes
//     floor(budget / activeCount), recomputed when a download starts or ends.
//     This is the polite part: growth stops at the share, and when a
//     download finishes the others' ceilings rise again through their own
//     ramp probing (never a jump).
//  2. HARD GATE — a HostGate instance keyed on a single synthetic host (the
//     gate already implements the waiter-callback fill-block the task loop
//     expects) so the sum of live connections can never overshoot the budget,
//     even in the race windows between recompute and apply.
//
// budget = 0 disables both (the pre-5.9.0 behavior).

const { HostGate } = require('./host-gate');

/** Synthetic host key under which the global gate counts all connections. */
const GLOBAL_GATE_KEY = '*global*';

class GlobalConnectionBudget {
  /**
   * @param {number} [budget] max simultaneous engine connections (0 = off)
   */
  constructor(budget = 0) {
    this._budget = Math.max(0, Math.floor(Number(budget) || 0));
    this.gate = new HostGate(this._budget);
    /** @type {Map<string, number>} taskId -> the task's OWN ceiling (never the shared one) */
    this.registered = new Map();
  }

  get budget() {
    return this._budget;
  }

  /** 0 disables the budget (and releases everyone waiting on the gate). */
  setBudget(n) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    if (v === this._budget) return;
    this._budget = v;
    this.gate.setLimit(v);
  }

  get activeCount() {
    return this.registered.size;
  }

  /**
   * Fair per-download ceiling right now: floor(budget / active), clamped to
   * at least 1. Infinity when disabled — callers min() it away.
   */
  fairCeiling() {
    if (this._budget <= 0) return Infinity;
    const active = this.registered.size;
    if (active <= 0) return this._budget;
    return Math.max(1, Math.floor(this._budget / active));
  }

  /**
   * Register a task's own ceiling and return the effective one to start with.
   * @param {string} taskId
   * @param {number} ownMax  the task's user/advisor ceiling
   * @returns {number} min(ownMax, fairCeiling) when budgeted, else ownMax
   */
  register(taskId, ownMax) {
    const own = Math.max(1, Math.floor(Number(ownMax) || 1));
    this.registered.set(taskId, own);
    const fair = this.fairCeiling();
    return Number.isFinite(fair) ? Math.max(1, Math.min(own, fair)) : own;
  }

  /** Drop a task and return true when other tasks' ceilings should rise. */
  unregister(taskId) {
    this.registered.delete(taskId);
    return this._budget > 0 && this.registered.size > 0;
  }

  /**
   * Effective ceiling for a registered task: its own, min'd with the current
   * fair share. Used on every recompute.
   * @param {string} taskId
   * @returns {number|null} null when the task is unknown
   */
  effectiveFor(taskId) {
    const own = this.registered.get(taskId);
    if (own == null) return null;
    const fair = this.fairCeiling();
    return Number.isFinite(fair) ? Math.max(1, Math.min(own, fair)) : own;
  }

  /** Iterate [taskId, effectiveCeiling] pairs for recompute fan-out. */
  effectiveEntries() {
    const out = [];
    for (const id of this.registered.keys()) {
      const eff = this.effectiveFor(id);
      if (eff != null) out.push([id, eff]);
    }
    return out;
  }

  hasCapacity() {
    return this.gate.hasCapacity(GLOBAL_GATE_KEY);
  }

  acquire() {
    return this.gate.acquire(GLOBAL_GATE_KEY);
  }

  release() {
    this.gate.release(GLOBAL_GATE_KEY);
  }

  waitForSlot(key, cb) {
    this.gate.waitForSlot(GLOBAL_GATE_KEY, key, cb);
  }
}

module.exports = { GlobalConnectionBudget, GLOBAL_GATE_KEY };
