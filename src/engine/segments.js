// @ts-check
const { TAIL_MIN_SPLIT_BYTES } = require('./ramp-controller');

// Tail micro-split threshold (FluxDown: 64 KB). Below this there is nothing
// smaller to split, so the tail micro-split strategy is disabled.
const TAIL_SPLIT_BYTES = TAIL_MIN_SPLIT_BYTES;
// Straggler guard: only micro-split when the largest remaining active segment
// is >= 2x the tail threshold, indicating a genuine imbalance worth rescuing.
const STAGG_BUILDER = 2 * TAIL_SPLIT_BYTES;

class Segment {
  /**
   * @param {number} id
   * @param {number} start
   * @param {number} end
   * @param {number} [downloaded]
   */
  constructor(id, start, end, downloaded = 0) {
    this.id = id;
    this.start = start;
    /** @type {number} Inclusive end offset; -1 means open-ended */
    this.end = end;
    this.downloaded = downloaded;
    /** @type {'pending' | 'active' | 'done'} */
    this.state = 'pending';
    /** True for a FluxDown-style tail micro-split segment (small straggler slice). */
    this.tail = false;
    this.attempts = 0;
    this.retryAt = 0;
  }

  get isOpenEnded() {
    return this.end < 0;
  }

  get position() {
    return this.start + this.downloaded;
  }

  get length() {
    return this.isOpenEnded ? Number.POSITIVE_INFINITY : this.end - this.start + 1;
  }

  get remaining() {
    return this.isOpenEnded ? Number.POSITIVE_INFINITY : Math.max(0, this.end - this.position + 1);
  }

  snapshot() {
    return {
      id: this.id,
      start: this.start,
      end: this.end,
      downloaded: this.downloaded,
      state: this.state,
      tail: this.tail,
    };
  }
}

/**
 * IDM-style dynamic segmentation. The file starts as one segment. Whenever a connection
 * becomes available and no pending segment exists, the largest in-flight segment is split
 * in half and the new connection takes the second half.
 */
class SegmentManager {
  /**
   * @param {number | null} totalSize
   * @param {{ minSplitSize: number, pieceSelection: 'largest' | 'inorder', allowSplit: boolean, dynamicMinSplit?: number, tailMicroSplit?: boolean }} opts
   */
  constructor(totalSize, opts) {
    this.totalSize = totalSize;
    this.opts = opts;
    /** @type {Segment[]} */
    this.segments = [];
    this.nextId = 1;
  }

  /**
   * Effective minimum split size. When the ramp controller has measured a live
   * throughput it lowers this (512 KB at low speed, 1 MB mid, 2 MB high) so
   * idle workers can join slow segments without thrashing tiny ranges.
   * @returns {number}
   */
  get currentMinSplit() {
    return this.opts.dynamicMinSplit && this.opts.dynamicMinSplit > 0
      ? this.opts.dynamicMinSplit
      : this.opts.minSplitSize;
  }

  /**
   * @param {number | null} totalSize
   * @param {{ minSplitSize: number, pieceSelection: 'largest' | 'inorder', allowSplit: boolean }} opts
   */
  static fresh(totalSize, opts) {
    const m = new SegmentManager(totalSize, opts);
    const seg = new Segment(m.nextId++, 0, totalSize === null ? -1 : totalSize - 1);
    if (totalSize === 0) seg.state = 'done';
    m.segments.push(seg);
    return m;
  }

  /**
   * @param {any[]} snapshots
   * @param {number | null} totalSize
   * @param {{ minSplitSize: number, pieceSelection: 'largest' | 'inorder', allowSplit: boolean }} opts
   * @param {number | null} [maxWritten] real byte count present on disk; claims
   *   beyond it are trimmed so a stale/over-reported control file can never
   *   leave zero-filled holes in the finished file.
   */
  static restore(snapshots, totalSize, opts, maxWritten = null) {
    const m = new SegmentManager(totalSize, opts);
    const sizeKnown = Number.isFinite(totalSize) && totalSize >= 0;
    const lastByte = sizeKnown ? totalSize - 1 : null;
    const clean = [];

    for (const s of snapshots) {
      if (!s || !Number.isFinite(Number(s.start))) continue;
      let start = Math.max(0, Math.floor(Number(s.start)));
      let end = s.end === null || s.end === undefined || !Number.isFinite(Number(s.end)) ? -1 : Math.floor(Number(s.end));
      if (sizeKnown) {
        if (start > lastByte) continue;              // entirely past EOF
        if (end >= 0) end = Math.min(end, lastByte); // never write past EOF
      }
      if (end >= 0 && end < start) continue;         // empty / inverted
      const seg = new Segment(Number.isFinite(Number(s.id)) ? Number(s.id) : clean.length + 1, start, end);
      const limit = seg.isOpenEnded ? Number.POSITIVE_INFINITY : seg.length;
      seg.downloaded = Math.min(Math.max(0, Math.floor(Number(s.downloaded)) || 0), limit);
      seg.state = !seg.isOpenEnded && seg.downloaded >= seg.length ? 'done' : 'pending';
      if (seg.state === 'done') seg.downloaded = seg.length;
      clean.push(seg);
      m.nextId = Math.max(m.nextId, seg.id + 1);
    }

    clean.sort((a, b) => a.start - b.start);

    // Close gaps and trim overlaps: a control file that does not cover every
    // byte would otherwise leave zero-filled holes in the finished file
    // (preallocation) and still report success.
    let cursor = 0;
    for (const seg of clean) {
      if (seg.start < cursor) {
        const drop = cursor - seg.start;
        seg.start = cursor;
        seg.downloaded = Math.max(0, seg.downloaded - drop);
        if (!seg.isOpenEnded && seg.downloaded >= seg.length) {
          seg.state = 'done';
          seg.downloaded = seg.length;
        }
      }
      if (!seg.isOpenEnded && seg.end < seg.start) continue;
      if (seg.start > cursor) {
        m.segments.push(new Segment(m.nextId++, cursor, seg.start - 1));
        cursor = seg.start;
      }
      m.segments.push(seg);
      cursor = seg.isOpenEnded ? (lastByte === null ? cursor : lastByte + 1) : seg.end + 1;
    }
    if (lastByte !== null && cursor <= lastByte) {
      m.segments.push(new Segment(m.nextId++, cursor, lastByte));
    }

    if (m.segments.length === 0) return SegmentManager.fresh(totalSize, opts);

    if (maxWritten !== null && Number.isFinite(maxWritten) && maxWritten >= 0) {
      let budget = maxWritten;
      for (const seg of m.segments) {
        if (seg.downloaded > budget) {
          seg.downloaded = Math.max(0, budget);
          seg.state = !seg.isOpenEnded && seg.downloaded >= seg.length ? 'done' : 'pending';
        }
        budget = Math.max(0, budget - seg.downloaded);
      }
    }

    return m;
  }

  get all() {
    return this.segments;
  }

  get activeCount() {
    return this.segments.reduce((n, s) => n + (s.state === 'active' ? 1 : 0), 0);
  }

  get downloadedBytes() {
    return this.segments.reduce((n, s) => n + s.downloaded, 0);
  }

  get remainingBytes() {
    return this.totalSize === null ? null : Math.max(0, this.totalSize - this.downloadedBytes);
  }

  get isComplete() {
    return this.segments.every((s) => s.state === 'done');
  }

  /**
   * @param {number} [now]
   */
  hasWork(now = Date.now()) {
    return (
      this.segments.some((s) => s.state === 'pending' && s.retryAt <= now) ||
      this.splitCandidate() !== null ||
      this.microSplitCandidate() !== null
    );
  }

  /**
   * @param {number} [now]
   */
  nextRetryAt(now = Date.now()) {
    let next = null;
    for (const s of this.segments) {
      if (s.state === 'pending' && s.retryAt > now && (next === null || s.retryAt < next)) next = s.retryAt;
    }
    return next;
  }

  /**
   * @param {number} [now]
   * @returns {Segment | null}
   */
  claim(now = Date.now()) {
    const pending = this.segments.filter((s) => s.state === 'pending' && s.retryAt <= now);
    let seg = null;
    if (pending.length > 0) {
      seg =
        this.opts.pieceSelection === 'inorder'
          ? pending.reduce((a, b) => (b.start < a.start ? b : a))
          : pending.reduce((a, b) => (b.remaining > a.remaining ? b : a));
    } else {
      seg = this.split();
      // Strategy 3 (FluxDown tail micro-split): when a normal split fails because
      // the remaining bytes are below the dynamic threshold, retry at the small
      // tail threshold so an idle worker can help finish a slow tail segment
      // ~2x faster instead of 15 workers idling on one straggler.
      if (!seg && this.opts.tailMicroSplit !== false) seg = this.microSplitTagged();
    }
    if (seg) seg.state = 'active';
    return seg;
  }

  /**
   * @param {Segment} seg
   */
  release(seg) {
    if (seg.state !== 'active') return;
    // A split may have shrunk this segment below what the worker already
    // wrote (or an abort landed after the last chunk): it is complete.
    // Re-pending it would retry with an inverted Range (position > end),
    // which answers 416 and escalates to a spurious RESOURCE_CHANGED restart.
    if (!seg.isOpenEnded && seg.remaining === 0) {
      seg.downloaded = seg.length;
      seg.state = 'done';
      return;
    }
    seg.state = 'pending';
  }

  /**
   * @param {Segment} seg
   */
  complete(seg) {
    if (seg.isOpenEnded) {
      seg.end = seg.position - 1;
      this.totalSize = seg.end + 1;
    } else {
      seg.downloaded = seg.length;
    }
    seg.state = 'done';
  }

  snapshot() {
    return this.segments.map((s) => s.snapshot());
  }

  /**
   * @returns {Segment | null}
   */
  splitCandidate() {
    return this.trySplitLargest(2 * this.currentMinSplit);
  }

  /**
   * Find the largest in-flight active segment whose remaining bytes are at
   * least `threshold`, split it in half, and return the newly-created second
   * half. Returns null when nothing qualifies (no work-stealing possible).
   * @param {number} threshold
   * @returns {Segment | null}
   */
  trySplitLargest(threshold) {
    if (!this.opts.allowSplit || this.totalSize === null) return null;
    const candidates = this.segments.filter((s) => s.state === 'active' && s.remaining >= threshold);
    if (candidates.length === 0) return null;
    const victim = this.opts.pieceSelection === 'inorder'
      ? candidates.reduce((a, b) => (b.start < a.start ? b : a))
      : candidates.reduce((a, b) => (b.remaining > a.remaining ? b : a));
    const half = Math.floor(victim.remaining / 2);
    const mid = victim.position + half;
    const created = new Segment(this.nextId++, mid, victim.end);
    victim.end = mid - 1;
    const idx = this.segments.indexOf(victim);
    this.segments.splice(idx + 1, 0, created);
    return created;
  }

  /**
   * Perform a tail micro-split at the small tail threshold and mark the
   * resulting segment so the UI can render it distinctly (a FluxDown-style
   * "straggler" slice that keeps idle workers busy near EOF).
   * @returns {Segment | null}
   */
  microSplitTagged() {
    const created = this.microSplit();
    if (created) created.tail = true;
    return created;
  }

  /**
   * @returns {Segment | null}
   */
  split() {
    return this.trySplitLargest(2 * this.currentMinSplit);
  }

  /**
   * Tail micro-split candidate: only when the normal threshold is above the
   * tail threshold AND the largest remaining active segment is a genuine
   * straggler (>= 2x tail). Without the straggler guard, equally-tiny tail
   * segments cascade-split into dust and workers retire en-masse, causing the
   * visible "99% speed drop".
   * @returns {Segment | null}
   */
  microSplitCandidate() {
    if (this.opts.tailMicroSplit === false || !this.opts.allowSplit || this.totalSize === null) return null;
    if (this.currentMinSplit <= TAIL_SPLIT_BYTES) return null;
    const maxRemaining = this.segments
      .filter((s) => s.state === 'active')
      .reduce((m, s) => Math.max(m, s.remaining), 0);
    if (maxRemaining < STAGG_BUILDER) return null;
    return this.segments.some((s) => s.state === 'active' && s.remaining >= TAIL_SPLIT_BYTES) ? STAGG_BUILDER_SEG : null;
  }

  /**
   * Perform a tail micro-split at the small tail threshold.
   * @returns {Segment | null}
   */
  microSplit() {
    if (this.opts.tailMicroSplit === false || !this.opts.allowSplit || this.totalSize === null) return null;
    if (this.currentMinSplit <= TAIL_SPLIT_BYTES) return null;
    const maxRemaining = this.segments
      .filter((s) => s.state === 'active')
      .reduce((m, s) => Math.max(m, s.remaining), 0);
    if (maxRemaining < STAGG_BUILDER) return null;
    return this.trySplitLargest(TAIL_SPLIT_BYTES);
  }
}

// Sentinel returned by microSplitCandidate to satisfy hasWork() without
// re-scanning; claim() recomputes the actual victim via microSplit().
const STAGG_BUILDER_SEG = Symbol('tail-micro-split');

module.exports = {
  Segment,
  SegmentManager,
};
