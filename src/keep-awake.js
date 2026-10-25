// @ts-check
'use strict';

/**
 * Sleep inhibition while transfers are running.
 *
 * The bug this closes: Windows suspends the machine on its own idle timer, so a
 * large overnight download simply stops at ~30 minutes of inactivity and the
 * user finds a half-finished file in the morning. FDM advertises exactly this
 * ("disable sleep while a download is scheduled"); AiDM never held a
 * `powerSaveBlocker` at all.
 *
 * Scope is deliberately narrow — this holds a *suspension* blocker only while
 * something is actually transferring. It does NOT:
 *   - keep the display on (`prevent-display-sleep` is a different, rude mode),
 *   - wake a machine that is already asleep (that needs an OS wake timer /
 *     scheduled task, not a suspension blocker),
 *   - block sleep for merely *armed* future schedules, which would keep a
 *     desktop awake for a day.
 *
 * The policy is a pure function and the controller talks to an injected
 * blocker interface, so both are testable without Electron.
 */

/**
 * @typedef {Object} KeepAwakeState
 * @property {number} [activeTransfers] rows currently transferring
 * @property {boolean} [scheduleRunning] a scheduler session is executing
 * @property {boolean} [enabled] user setting (`preventSleep`), default on
 */

/**
 * Should the OS be kept awake right now?
 * @param {KeepAwakeState} [state]
 * @returns {boolean}
 */
function shouldKeepAwake(state) {
  if (!state) return false;
  if (state.enabled === false) return false;
  const active = Number(state.activeTransfers);
  if (Number.isFinite(active) && active > 0) return true;
  return state.scheduleRunning === true;
}

/** Statuses that mean "bytes are moving" (or are about to). Paused is excluded. */
const ACTIVE_STATUSES = new Set(['downloading', 'connecting']);

/**
 * Count rows whose transfer is live. Takes an iterable of rows so it works with
 * a Map, an array, or a plain object's values.
 * @param {Iterable<any>|null|undefined} rows
 * @returns {number}
 */
function countActiveTransfers(rows) {
  if (!rows) return 0;
  let n = 0;
  for (const row of rows) {
    if (row && ACTIVE_STATUSES.has(row.status)) n++;
  }
  return n;
}

/**
 * @typedef {{ start: (type: string) => number, stop: (id: number) => void }} Blocker
 *   Electron's `powerSaveBlocker` satisfies this shape.
 */

/**
 * Holds at most one blocker id and reconciles it against the desired state.
 * `update()` is idempotent, so it can be called on every progress tick.
 */
class KeepAwake {
  /**
   * @param {Blocker} blocker
   * @param {{ type?: string }} [opts]
   */
  constructor(blocker, opts = {}) {
    /** @type {Blocker} */
    this.blocker = blocker;
    this.type = opts.type || 'prevent-app-suspension';
    /** @type {number|null} */
    this.id = null;
  }

  /** Is a blocker currently held? */
  get active() {
    return this.id !== null;
  }

  /**
   * Reconcile with the desired state.
   * @param {KeepAwakeState} state
   * @returns {boolean} whether a blocker is held afterwards
   */
  update(state) {
    const want = shouldKeepAwake(state);
    if (want && this.id === null) {
      try {
        this.id = this.blocker.start(this.type);
      } catch (e) {
        // A blocker failure must never break a download.
        this.id = null;
      }
    } else if (!want && this.id !== null) {
      this.release();
    }
    return this.active;
  }

  /** Drop the blocker (app quit, or the user turned the setting off). */
  release() {
    if (this.id === null) return;
    const id = this.id;
    this.id = null;
    try { this.blocker.stop(id); } catch (e) { /* already stopped */ }
  }
}

module.exports = {
  shouldKeepAwake,
  countActiveTransfers,
  KeepAwake,
  ACTIVE_STATUSES,
};
