// Unit tests for the FluxDown-derived segment advisor. Run: node test/segment-advisor.js
const sa = require('../src/engine/segment-advisor');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

console.log('── segment-advisor (FluxDown port) ──');

// No range support -> single segment.
const noRange = sa.adviseStatic({ totalBytes: 1e9, supportsRange: false });
check('no range support -> 1 segment', noRange.segments === 1, noRange.reason);

// Unknown size -> single segment.
const unknown = sa.adviseStatic({ totalBytes: 0, supportsRange: true });
check('unknown size -> 1 segment', unknown.segments === 1, unknown.reason);

// Tiny file -> single segment.
const tiny = sa.adviseStatic({ totalBytes: 1_000_000, supportsRange: true });
check('1MB file -> 1 segment', tiny.segments === 1, tiny.reason);

// 2MB boundary -> single segment (threshold is inclusive <=).
const boundary = sa.adviseStatic({ totalBytes: 2 * 1024 * 1024, supportsRange: true });
check('2MB file -> 1 segment', boundary.segments === 1, boundary.reason);

// Large file scales up, capped at 64.
const big = sa.adviseStatic({ totalBytes: 1e9, supportsRange: true });
check('1GB file scales > 1', big.segments > 1, `segments=${big.segments}`);
check('1GB file capped at 64', big.segments <= sa.MAX_SEGMENTS, `segments=${big.segments}`);

// 500MB on a 4-core box -> by_size=476, io_cap=16 -> 16.
const mid = sa.adviseStatic({ totalBytes: 500 * 1024 * 1024, supportsRange: true, cpuCores: 4 });
check('500MB/4core -> 16 segments', mid.segments === 16, `segments=${mid.segments}`);

// Bandwidth refines: slow link keeps ~50%, fast link full.
const input = { totalBytes: 1e9, supportsRange: true };
const slow = sa.adviseWithBandwidth(input, 100 * 1024);
const fast = sa.adviseWithBandwidth(input, 100 * 1024 * 1024);
check('slow bandwidth <= fast bandwidth', slow.segments <= fast.segments, `slow=${slow.segments} fast=${fast.segments}`);
check('slow bandwidth keeps >=50% of static', slow.segments >= Math.ceil(big.segments * 0.5 * 0.9), `slow=${slow.segments}`);

// If static chose 1, bandwidth does not override.
const single = sa.adviseWithBandwidth({ totalBytes: 1e6, supportsRange: true }, 1e9);
check('static=1 not overridden by bandwidth', single.segments === 1);

// Throughput thresholds: below LOW -> 0.5, above HIGH -> 1.0.
const bw1 = sa.adviseWithBandwidth(input, sa.BW_LOW / 2).segments;
const bw2 = sa.adviseWithBandwidth(input, sa.BW_HIGH * 2).segments;
check('very slow factor ~0.5', Math.abs(bw1 / big.segments - 0.5) < 0.2, `ratio=${(bw1 / big.segments).toFixed(2)}`);
check('very fast factor ~1.0', bw2 === big.segments, `fast=${bw2}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
