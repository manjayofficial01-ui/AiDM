// @ts-check
/**
 * Dynamic segment (connection) allocation — ported from FluxDown's
 * `native/engine/src/segment_advisor.rs`.
 *
 * Instead of a hard-coded "8 segments", this module calculates a *recommended
 * connection cap* from:
 *   1. file size — tiny files need fewer segments; each segment should get at
 *      least MIN_BYTES_PER_SEGMENT bytes to amortize HTTP/TLS handshake + TCP
 *      slow-start overhead;
 *   2. CPU logical cores — more segments than cores is wasteful for I/O
 *      scheduling (downloads are async/IO-bound, so we allow 4× cores).
 *
 * For HTTP the result is a *cap*, not a startup concurrency target: the ramp
 * controller (see `ramp-controller.js`) ramps the live worker count from a
 * small initial value up to this cap based on observed throughput.
 *
 * All thresholds mirror FluxDown so behaviour matches across engines.
 */

const MIN_SEGMENTS = 1;
const MAX_SEGMENTS = 64;
/** Each segment should handle at least 1 MB to amortize HTTP/TLS overhead. */
const MIN_BYTES_PER_SEGMENT = 1024 * 1024; // 1 MB
/** Files <= this are always single-segment (no benefit from splitting). */
const SINGLE_SEGMENT_THRESHOLD = 2 * 1024 * 1024; // 2 MB

/** Bandwidth thresholds (bytes/sec) for segment scaling. */
const BW_LOW = 512 * 1024; //   512 KB/s
const BW_MED = 5 * 1024 * 1024; //   5 MB/s
const BW_HIGH = 50 * 1024 * 1024; // 50 MB/s

/**
 * @typedef {object} AdvisorInput
 * @property {number} totalBytes         Total file size in bytes (from Content-Length).
 * @property {boolean} supportsRange      Whether the server supports HTTP Range requests.
 * @property {number} [cpuCores]          Logical CPU cores (falls back to 4).
 */

/**
 * @typedef {object} SegmentAdvice
 * @property {number} segments  Recommended segment count.
 * @property {string} reason    Human-readable explanation (debug logging).
 */

/**
 * Get the number of logical CPU cores (falls back to 4 on error / non-Node env).
 * @returns {number}
 */
function availableParallelism() {
  try {
    if (typeof require !== 'undefined') {
      // Node.js
      const os = require('os');
      const n = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
      return n > 0 ? n : 4;
    }
  } catch (_) {
    /* ignore */
  }
  return 4;
}

/**
 * Calculate the optimal segment count WITHOUT a bandwidth probe (fast path).
 * @param {AdvisorInput} input
 * @returns {SegmentAdvice}
 */
function adviseStatic(input) {
  const totalBytes = Number(input.totalBytes) || 0;
  const supportsRange = !!input.supportsRange;

  // Unknown size or no range support -> single segment.
  if (totalBytes <= 0 || !supportsRange) {
    return {
      segments: 1,
      reason: !supportsRange ? 'server does not support Range requests' : 'unknown file size',
    };
  }

  // Very small files — no benefit from multi-segment.
  if (totalBytes <= SINGLE_SEGMENT_THRESHOLD) {
    return {
      segments: 1,
      reason: `file size ${totalBytes} bytes <= ${SINGLE_SEGMENT_THRESHOLD} threshold`,
    };
  }

  const cpuCores = input.cpuCores || availableParallelism();

  // How many segments the file can sustain (each >= MIN_BYTES_PER_SEGMENT).
  const bySize = Math.max(1, Math.floor(totalBytes / MIN_BYTES_PER_SEGMENT));

  // Downloads are I/O-bound (async waiting on network), not CPU-bound.
  // Allow up to 4x logical cores before capping.
  const ioCap = Math.min(cpuCores * 4, MAX_SEGMENTS);
  const recommended = Math.max(MIN_SEGMENTS, Math.min(bySize, ioCap));

  return {
    segments: recommended,
    reason: `file=${totalBytes} bytes, by_size=${bySize}, cpu_cores=${cpuCores}, io_cap=${ioCap} -> ${recommended}`,
  };
}

/**
 * Calculate the optimal segment count WITH bandwidth estimation.
 * Refines `adviseStatic` by incorporating an observed download speed.
 * @param {AdvisorInput} input
 * @param {number} bandwidthBps  Observed throughput in bytes/sec.
 * @returns {SegmentAdvice}
 */
function adviseWithBandwidth(input, bandwidthBps) {
  const staticAdvice = adviseStatic(input);

  // If static already chose 1, don't override (server or file constraints).
  if (staticAdvice.segments <= 1) return staticAdvice;

  const bw = Number(bandwidthBps) || 0;

  // Scale the static recommendation based on bandwidth:
  //  - < 512 KB/s : keep ~50% (multiple connections bypass per-connection throttling)
  //  - 512KB–5MB  : interpolate 0.5 -> 0.75
  //  - 5–50MB     : interpolate 0.75 -> 1.0
  //  - > 50MB     : full parallelism
  let bwFactor;
  if (bw < BW_LOW) bwFactor = 0.5;
  else if (bw < BW_MED) {
    const t = (bw - BW_LOW) / (BW_MED - BW_LOW);
    bwFactor = 0.5 + t * 0.25;
  } else if (bw < BW_HIGH) {
    const t = (bw - BW_MED) / (BW_HIGH - BW_MED);
    bwFactor = 0.75 + t * 0.25;
  } else {
    bwFactor = 1.0;
  }

  const adjusted = Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.ceil(staticAdvice.segments * bwFactor)));

  return {
    segments: adjusted,
    reason: `static=${staticAdvice.segments}, bandwidth=${(bw / 1024).toFixed(1)} KB/s, bw_factor=${bwFactor.toFixed(2)} -> ${adjusted}`,
  };
}

module.exports = {
  MIN_SEGMENTS,
  MAX_SEGMENTS,
  MIN_BYTES_PER_SEGMENT,
  SINGLE_SEGMENT_THRESHOLD,
  BW_LOW,
  BW_MED,
  BW_HIGH,
  availableParallelism,
  adviseStatic,
  adviseWithBandwidth,
};
