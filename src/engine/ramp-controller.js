// @ts-check
/**
 * Adaptive connection ramp controller — ported from FluxDown's
 * `native/engine/src/segment_coordinator.rs`.
 *
 * `initialConnections` is a *maximum cap*, not a startup concurrency: the
 * controller starts from RAMP_INITIAL_WORKERS connections and, every
 * RAMP_TICK_SECS window, measures total throughput and either ramps up,
 * freezes, or collapses:
 *
 *   - IMPROVE  (throughput >= pre-grow x IMPROVE_FACTOR): keep ramping.
 *   - FREEZE   (no net gain): stop expansion at the current scale.
 *   - COLLAPSE (throughput <  pre-grow x COLLAPSE_FACTOR): a server punished
 *              the extra connections — roll back to the pre-grow scale and
 *              record a per-domain connection cap so future tasks on that host
 *              start there directly.
 *
 * Once frozen it may re-probe after a cooldown (Soft state) up to a budget,
 * then hard-freeze. Tail micro-split (see segments.js) keeps idle workers busy
 * near EOF so the visible speed does not cliff at 99%.
 *
 * The controller is a pure state machine: the owning task feeds it throughput
 * + live worker counts every tick and applies the returned `target`.
 */

const RAMP_INITIAL_WORKERS = 2;
const RAMP_TICK_SECS = 2;
/** Shortest complete eval window after first response (skip sampling below). */
const RAMP_MIN_EVAL_WINDOW_MS = 500;
/** Soft-freeze cooldown before a +1 probe (15 x 2s ~= 30s). */
const RAMP_SOFT_PROBE_COOLDOWN_TICKS = 15;
const RAMP_SOFT_PROBE_MAX_ATTEMPTS = 2;
const RAMP_SOFT_PROBE_TASK_BUDGET = 6;
/** Desktop uncap ceiling for positive hints. */
const HINT_UNCAP_MAX = 64;

const MIN_SPLIT_BYTES = 2 * 1024 * 1024; // 2 MB
const TAIL_FRACTION_DENOM = 50;
const TAIL_MIN_SPLIT_BYTES = 64 * 1024; // 64 KB

const RAMP_IMPROVE_FACTOR = 1.05;
const RAMP_COLLAPSE_FACTOR = 0.5;
const RAMP_SHRINK_STRIKES = 2;
const RAMP_PEAK_DECAY = 0.99;

/**
 * Three-way verdict on the window throughput relative to the pre-grow window.
 * @param {number} preGrowBps
 * @param {number} curBps
 * @returns {'improved'|'freeze'|'collapse'}
 */
function rampVerdict(preGrowBps, curBps) {
  if (curBps > preGrowBps * RAMP_IMPROVE_FACTOR) return 'improved';
  if (curBps < preGrowBps * RAMP_COLLAPSE_FACTOR) return 'collapse';
  return 'freeze';
}

/**
 * Tail predicate: remaining is both too small to give every target connection
 * a full segment (work starvation) AND near EOF. Both required to avoid
 * misclassifying small/medium files or giant files far from EOF.
 * @param {number} remaining
 * @param {number} workerCap
 * @param {number} total
 * @returns {boolean}
 */
function isTail(remaining, workerCap, total) {
  const r = Number(remaining) || 0;
  const t = Number(total) || 0;
  return r < workerCap * MIN_SPLIT_BYTES && r < t / TAIL_FRACTION_DENOM;
}

/**
 * Dynamic minimum split threshold based on real-time throughput.
 * @param {number} throughputBps
 * @returns {number}
 */
function dynamicMinSplitBytes(throughputBps) {
  const bw = Number(throughputBps) || 0;
  const BW_LOW = 1 * 1024 * 1024;
  const BW_HIGH = 10 * 1024 * 1024;
  if (bw < BW_LOW) return 512 * 1024;
  if (bw < BW_HIGH) return 1024 * 1024;
  return MIN_SPLIT_BYTES;
}

/**
 * Peak-throughput shrink predicate: count a shrink strike only when not in an
 * eval window, frozen or at cap, allowed>1, alive==allowed, throughput below
 * peak x COLLAPSE_FACTOR.
 */
function shouldShrink(throughput, peak, allowed, cap, alive, frozen, awaitingEval) {
  return (
    !awaitingEval &&
    (frozen || allowed >= cap) &&
    allowed > 1 &&
    alive === allowed &&
    peak > 0 &&
    throughput < peak * RAMP_COLLAPSE_FACTOR
  );
}

/**
 * Expansion gate: not frozen, no connection-sensitive signal, alive>=allowed,
 * allowed<cap, and no shrink happened this tick.
 */
function shouldExpand(frozen, connSensitive, alive, allowed, cap, shrunkThisTick) {
  return !frozen && !connSensitive && alive >= allowed && allowed < cap && !shrunkThisTick;
}

/**
 * Ramp start allowance: a positive same-domain hint lets us start at that
 * scale; otherwise conservative RAMP_INITIAL_WORKERS.
 */
function initialAllowedWorkers(workerCap, hint) {
  let base = RAMP_INITIAL_WORKERS;
  if (hint && hint > RAMP_INITIAL_WORKERS) base = hint;
  return Math.max(1, Math.min(workerCap, base));
}

/**
 * Hint uncap ceiling: with allow + no negative cap + a positive hint, raise the
 * base cap to hint*2 (next exploration tier above a proven scale), clamped to
 * HINT_UNCAP_MAX. The ramp's improve/collapse/reject feedback loop is preserved.
 */
function hintUncapCeiling(allow, negativeCap, hint, baseCap) {
  if (!allow || negativeCap != null) return baseCap;
  if (!hint || hint <= 0) return baseCap;
  const target = Math.min(HINT_UNCAP_MAX, Math.min(MAX_SEGMENTS_LOCAL, hint * 2));
  return target > baseCap ? target : baseCap;
}

const MAX_SEGMENTS_LOCAL = 64;

/**
 * Per-domain connection-cap store. A host earns a *positive* hint when it
 * sustained a concurrency without a collapse; a *negative* (collapse) cap is
 * recorded when the server punished extra connections. Persisted externally.
 */
class DomainConnCaps {
  /**
   * @param {Record<string, {hint?: number, negative?: number}>} [seed]
   * @param {{ persist?: (json: object) => void }} [opts]
   */
  constructor(seed, opts) {
    /** @type {Map<string, {hint?: number, negative?: number}>} */
    this.map = new Map();
    this.persist = opts && opts.persist;
    if (seed) for (const [k, v] of Object.entries(seed)) this.map.set(k, { ...v });
  }

  _persist() {
    if (this.persist) {
      try { this.persist(this.toJSON()); } catch (_) { /* best-effort */ }
    }
  }

  /**
   * A task reached `scale` live connections on `host` with no collapse/429.
   * Promote the hint to the highest proven scale.
   */
  recordSuccess(host, scale) {
    const cur = this.map.get(host) || {};
    if (cur.negative != null && scale <= cur.negative) return; // below a known bad cap
    if (cur.hint == null || scale > cur.hint) cur.hint = scale;
    this.map.set(host, cur);
    this._persist();
  }

  /**
   * The server punished `scale` connections — roll future tasks back to
   * `rolledBackTo` and remember it as a negative cap.
   */
  recordCollapse(host, rolledBackTo) {
    const cur = this.map.get(host) || {};
    cur.negative = Math.max(1, rolledBackTo);
    if (cur.hint == null || cur.hint > cur.negative) cur.hint = cur.negative;
    this.map.set(host, cur);
    this._persist();
  }

  /** Positive start hint for a host (undefined = none). Returns the proven-safe
   *  scale even when it equals the negative cap (a collapsed task should still
   *  start at that rolled-back scale). */
  getHint(host) {
    const cur = this.map.get(host);
    return cur && cur.hint != null && (cur.negative == null || cur.hint <= cur.negative) ? cur.hint : undefined;
  }

  /** Negative cap for a host (undefined = none). */
  getNegative(host) {
    const cur = this.map.get(host);
    return cur && cur.negative != null ? cur.negative : undefined;
  }

  toJSON() {
    const out = {};
    for (const [k, v] of this.map) out[k] = { ...v };
    return out;
  }
}

/**
 * Adaptive ramp state machine.
 */
class RampController {
  /**
   * @param {object} opts
   * @param {number} opts.maxCap            Hard ceiling (usually segment advisor cap).
   * @param {number} [opts.hint]            Positive per-domain hint (start scale).
   * @param {boolean} [opts.allowHintUncap] User left auto-max on (lets hints raise ceiling).
   * @param {number} [opts.now]             Current time ms.
   */
  constructor(opts) {
    const maxCap = Math.max(1, Math.min(64, opts.maxCap || 8));
    const negative = opts.negativeCap != null ? opts.negativeCap : undefined;
    const baseCap = hintUncapCeiling(opts.allowHintUncap !== false, negative, opts.hint, maxCap);
    this.maxCap = baseCap;
    this.allowed = initialAllowedWorkers(baseCap, opts.hint);
    this.freeze = { kind: 'active' };
    this.peakBps = 0;
    this.preGrowBps = 0;
    this.prevBps = 0;
    this.awaitingEval = false;
    this.lastEvalAt = opts.now || Date.now();
    this.shrinkStrikes = 0;
    this.softProbe = { ticksWaited: 0, attempts: 0, cooldown: RAMP_SOFT_PROBE_COOLDOWN_TICKS };
    this.taskSoftBudget = RAMP_SOFT_PROBE_TASK_BUDGET;
    this.rollingBack = false;
    this.collapsedTo = null;
  }

  /**
   * Evaluate one ramp tick.
   * @param {object} ctx
   * @param {number} ctx.throughputBps  Measured total throughput this window.
   * @param {number} ctx.alive          Live worker count.
   * @param {number} ctx.remaining      Remaining bytes (for tail short-circuit).
   * @param {number} ctx.total          Total bytes.
   * @param {number} ctx.now
   * @returns {{action:'expand'|'freeze'|'collapse'|'shrink'|'none', target:number, collapsedTo:?number, connSensitive:boolean}}
   */
  tick(ctx) {
    const now = ctx.now || Date.now();
    const elapsed = now - this.lastEvalAt;
    const result = { action: 'none', target: this.allowed, collapsedTo: null, connSensitive: false };

    // Tail: freeze the cap, short-circuit shrink/learn — keep current connections
    // to finish remaining bytes and avoid the end-of-file speed cliff.
    const tail = isTail(ctx.remaining, this.allowed, ctx.total);

    // Decay the peak reference (~70 windows half-life) so sustained degradation
    // tracks recent reality, not a startup burst.
    this.peakBps = this.peakBps > 0 ? this.peakBps * RAMP_PEAK_DECAY : ctx.throughputBps;
    if (ctx.throughputBps > this.peakBps) this.peakBps = ctx.throughputBps;

    if (this.awaitingEval) {
      const verdict = rampVerdict(this.preGrowBps, ctx.throughputBps);
      this.awaitingEval = false;
      if (verdict === 'improved') {
        this.freeze = { kind: 'active' };
      } else if (verdict === 'collapse') {
        const rolledBackTo = Math.max(1, this.preGrowAllowed != null ? this.preGrowAllowed : this.allowed - 1);
        this.allowed = rolledBackTo;
        this.rollingBack = false;
        this.freeze = { kind: 'hard' };
        this.shrinkStrikes = 0;
        result.action = 'collapse';
        result.target = this.allowed;
        result.collapsedTo = rolledBackTo;
        result.connSensitive = true;
      } else {
        // Freeze — soft so we may re-probe after cooldown.
        this.freeze = { kind: 'soft', ticksWaited: 0, cooldown: RAMP_SOFT_PROBE_COOLDOWN_TICKS, attempts: 0 };
      }
      this.lastEvalAt = now;
      this.prevBps = ctx.throughputBps;
      return result;
    }

    // Not awaiting an eval: consider shrinking (sustained degradation) or expanding.
    if (!tail && shouldShrink(ctx.throughputBps, this.peakBps, this.allowed, this.maxCap, ctx.alive, this.freeze.kind !== 'active', false)) {
      this.shrinkStrikes++;
      if (this.shrinkStrikes >= RAMP_SHRINK_STRIKES) {
        const halved = Math.max(1, Math.floor(this.allowed / 2));
        this.allowed = halved;
        this.shrinkStrikes = 0;
        result.action = 'shrink';
        result.target = this.allowed;
      }
      this.lastEvalAt = now;
      this.prevBps = ctx.throughputBps;
      return result;
    }
    this.shrinkStrikes = 0;

    if (tail) {
      this.lastEvalAt = now;
      this.prevBps = ctx.throughputBps;
      return result; // frozen, no expand/shrink at tail
    }

    const frozen = this.freeze.kind !== 'active';
    if (shouldExpand(frozen, false, ctx.alive, this.allowed, this.maxCap, false)) {
      // Soft-freeze re-probe gating.
      if (this.freeze.kind === 'soft') {
        this.freeze.ticksWaited++;
        if (this.freeze.ticksWaited < this.freeze.cooldown) {
          this.lastEvalAt = now;
          this.prevBps = ctx.throughputBps;
          return result;
        }
        if (this.freeze.attempts >= RAMP_SOFT_PROBE_MAX_ATTEMPTS || this.taskSoftBudget <= 0) {
          this.freeze = { kind: 'hard' };
          this.lastEvalAt = now;
          this.prevBps = ctx.throughputBps;
          return result;
        }
        this.freeze.attempts++;
        this.taskSoftBudget--;
      }
      this.preGrowAllowed = this.allowed;
      this.allowed = Math.min(this.maxCap, this.allowed + 1);
      this.preGrowBps = ctx.throughputBps;
      this.awaitingEval = true;
      result.action = 'expand';
      result.target = this.allowed;
    }

    this.lastEvalAt = now;
    this.prevBps = ctx.throughputBps;
    return result;
  }

  /** Mark the host pushed back (429/503) — collapse-roll back and flag. */
  markConnSensitive(rolledBackTo) {
    this.allowed = Math.max(1, rolledBackTo != null ? rolledBackTo : this.allowed - 1);
    this.freeze = { kind: 'hard' };
    this.awaitingEval = false;
    this.shrinkStrikes = 0;
  }
}

module.exports = {
  RAMP_INITIAL_WORKERS,
  RAMP_TICK_SECS,
  RAMP_MIN_EVAL_WINDOW_MS,
  RAMP_IMPROVE_FACTOR,
  RAMP_COLLAPSE_FACTOR,
  RAMP_SHRINK_STRIKES,
  RAMP_PEAK_DECAY,
  MIN_SPLIT_BYTES,
  TAIL_FRACTION_DENOM,
  TAIL_MIN_SPLIT_BYTES,
  rampVerdict,
  isTail,
  dynamicMinSplitBytes,
  shouldShrink,
  shouldExpand,
  initialAllowedWorkers,
  hintUncapCeiling,
  DomainConnCaps,
  RampController,
};
