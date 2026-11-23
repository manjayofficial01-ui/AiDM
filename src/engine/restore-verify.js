// @ts-check
'use strict';

/**
 * Resume integrity: catch a control file that claims more than the disk holds.
 *
 * The `.part` file is preallocated SPARSE (`ftruncate` to the resource size),
 * so its apparent size is the FULL size from the very first tick — the file
 * size says nothing about how many bytes were really written. A control file
 * (or a persisted offset map) that claims a segment is complete while its
 * bytes never reached the disk therefore produces a finished file with a
 * zero-filled hole, which the app happily reports as "completed".
 *
 * The engine already orders its writes so this cannot normally happen (the
 * data is fsynced BEFORE the bitmap is written), but a bitmap written by an
 * older build — or by a power loss in the window between the data flush and
 * the bitmap flush — can still be inconsistent.
 *
 * This module is the safety net: a segment that claims to be complete but
 * whose bytes read back as holes is demoted to "pending" and re-downloaded.
 * A hole reads as zeros, so the check samples a few windows spread across
 * the segment; only a segment that is zero EVERYWHERE is distrusted, which
 * keeps false positives (a legitimately sparse region) vanishingly rare.
 */

const { open } = require('fs/promises');

/** Bytes read per sample window. */
const SAMPLE_BYTES = 4096;
/** Windows sampled per segment (start / middle / end). */
const MAX_SAMPLES = 3;
/** Bytes at the END of a claimed range that decide whether it was written. */
const TAIL_BYTES = 1024;

/**
 * @param {Buffer} buf
 * @returns {boolean} true when every byte is zero
 */
function isAllZero(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/**
 * Offsets to sample inside [start, end]: the beginning, the middle and the
 * end of the segment, each a window of `sampleBytes`.
 *
 * @param {number} start
 * @param {number} end inclusive
 * @param {number} sampleBytes
 * @param {number} maxSamples
 * @returns {number[]}
 */
function sampleOffsets(start, end, sampleBytes, maxSamples) {
  const length = end - start + 1;
  if (length <= 0) return [];
  const out = [];
  const push = (offset) => {
    const clamped = Math.max(start, Math.min(offset, end - sampleBytes + 1));
    if (!out.includes(clamped)) out.push(clamped);
  };
  push(start);
  if (maxSamples >= 2) push(start + Math.floor(length / 2) - Math.floor(sampleBytes / 2));
  if (maxSamples >= 3) push(end - sampleBytes + 1);
  return out.slice(0, maxSamples);
}

/**
 * Find segments that claim to be complete but whose bytes are not on disk.
 *
 * @param {string} partPath the `.part` file
 * @param {Array<{ id: number, start: number, end: number, downloaded?: number, state: string, isOpenEnded?: boolean }>} segments
 * @param {{ sampleBytes?: number, maxSamples?: number }} [opts]
 * @returns {Promise<number[]>} the ids of the segments that must be re-downloaded
 */
async function findUnwrittenSegments(partPath, segments, opts = {}) {
  const sampleBytes = Math.max(256, opts.sampleBytes ?? SAMPLE_BYTES);
  const maxSamples = Math.max(1, opts.maxSamples ?? MAX_SAMPLES);
  /** @type {number[]} */
  const unwritten = [];
  if (!Array.isArray(segments) || !segments.length) return unwritten;

  let handle;
  try {
    handle = await open(partPath, 'r');
  } catch (e) {
    // No file at all: nothing was written, so every "done" segment is a lie.
    for (const seg of segments) if (seg && seg.state === 'done') unwritten.push(seg.id);
    return unwritten;
  }

  try {
    const stat = await handle.stat();
    const size = stat.size;
    for (const seg of segments) {
      if (!seg || seg.state !== 'done') continue;
      const start = Number(seg.start);
      const end = seg.isOpenEnded || Number(seg.end) < 0
        ? start + Math.max(0, Number(seg.downloaded) || 0) - 1
        : Number(seg.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;

      // The segment claims bytes past the end of the file: they cannot exist.
      if (end >= size) {
        unwritten.push(seg.id);
        continue;
      }

      // The TAIL is the decisive sample: a segment is written sequentially
      // (position = start + downloaded), so the bytes at the end of the
      // claimed range are the LAST ones written. If they are still a hole,
      // the segment was never finished.
      const tailLen = Math.min(TAIL_BYTES, end - start + 1);
      const tailBuf = Buffer.alloc(tailLen);
      const tailRead = await handle.read(tailBuf, 0, tailLen, end - tailLen + 1);
      if (tailRead.bytesRead <= 0 || isAllZero(tailBuf.subarray(0, tailRead.bytesRead))) {
        unwritten.push(seg.id);
        continue;
      }

      // Belt and braces: a segment that reads as a hole everywhere was never
      // written either.
      let allZero = true;
      for (const offset of sampleOffsets(start, end, sampleBytes, maxSamples)) {
        const want = Math.min(sampleBytes, end - offset + 1);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await handle.read(buf, 0, want, offset);
        if (bytesRead <= 0) { allZero = true; break; } // short read → unwritten
        if (!isAllZero(buf.subarray(0, bytesRead))) { allZero = false; break; }
      }
      if (allZero) unwritten.push(seg.id);
    }
  } catch (e) {
    // A read failure must not fail the resume: trust the bitmap.
  } finally {
    await handle.close().catch(() => {});
  }
  return unwritten;
}

/**
 * Demote the given segments to "pending" so they are downloaded again.
 *
 * @param {Array<any>} segments
 * @param {number[]} ids
 * @returns {number} how many segments were demoted
 */
function demoteSegments(segments, ids) {
  if (!Array.isArray(segments) || !Array.isArray(ids) || !ids.length) return 0;
  const set = new Set(ids);
  let demoted = 0;
  for (const seg of segments) {
    if (!seg || !set.has(seg.id)) continue;
    if (seg.state === 'done') {
      seg.state = 'pending';
      seg.downloaded = 0;
      demoted += 1;
    }
  }
  return demoted;
}

module.exports = {
  findUnwrittenSegments,
  demoteSegments,
  sampleOffsets,
  isAllZero,
  SAMPLE_BYTES,
  MAX_SAMPLES,
  TAIL_BYTES,
};
