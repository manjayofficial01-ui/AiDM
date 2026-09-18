// @ts-check
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
   * @param {{ minSplitSize: number, pieceSelection: 'largest' | 'inorder', allowSplit: boolean }} opts
   */
  constructor(totalSize, opts) {
    this.totalSize = totalSize;
    this.opts = opts;
    /** @type {Segment[]} */
    this.segments = [];
    this.nextId = 1;
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
    return this.segments.some((s) => s.state === 'pending' && s.retryAt <= now) || this.splitCandidate() !== null;
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
    }
    if (seg) seg.state = 'active';
    return seg;
  }

  /**
   * @param {Segment} seg
   */
  release(seg) {
    if (seg.state === 'active') seg.state = 'pending';
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
    if (!this.opts.allowSplit || this.totalSize === null) return null;
    const threshold = 2 * this.opts.minSplitSize;
    const candidates = this.segments.filter((s) => s.state === 'active' && s.remaining >= threshold);
    if (candidates.length === 0) return null;
    return this.opts.pieceSelection === 'inorder'
      ? candidates.reduce((a, b) => (b.start < a.start ? b : a))
      : candidates.reduce((a, b) => (b.remaining > a.remaining ? b : a));
  }

  /**
   * @returns {Segment | null}
   */
  split() {
    const victim = this.splitCandidate();
    if (!victim) return null;
    const half = Math.floor(victim.remaining / 2);
    const mid = victim.position + half;
    const created = new Segment(this.nextId++, mid, victim.end);
    victim.end = mid - 1;
    const idx = this.segments.indexOf(victim);
    this.segments.splice(idx + 1, 0, created);
    return created;
  }
}

module.exports = {
  Segment,
  SegmentManager,
};
