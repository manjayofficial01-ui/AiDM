// Unit tests for enhanced SegmentManager: tail micro-split + dynamic min-split.
// Run: node test/segments-v2.js
const { Segment, SegmentManager } = require('../src/engine/segments');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

console.log('── SegmentManager enhancements (FluxDown tail micro-split) ──');

// Backward compat: a fresh multi-GB file splits on the 2nd claim (first claim
// returns the initial pending segment, the next splits it).
const big = SegmentManager.fresh(1e9, { minSplitSize: 1024 * 1024, allowSplit: true, pieceSelection: 'largest' });
const s0 = big.claim();
check('first claim returns the initial segment', s0 && big.segments.length === 1, `segs=${big.segments.length}`);
const s1 = big.claim();
check('second claim splits the file', s1 && big.segments.length === 2, `segs=${big.segments.length}`);
check('first segment active', s0.state === 'active');

// Dynamic min-split: lowering currentMinSplit lowers the normal split threshold.
const dyn = SegmentManager.fresh(2 * 1024 * 1024, {
  minSplitSize: 2 * 1024 * 1024,
  dynamicMinSplit: 512 * 1024,
  allowSplit: true,
  pieceSelection: 'largest',
});
check('dynamicMinSplit overrides minSplitSize', dyn.currentMinSplit === 512 * 1024, `min=${dyn.currentMinSplit}`);
dyn.claim();
const dseg = dyn.claim();
// 2MB file: with dynamic 512KB, normal threshold 1MB -> the 2MB segment qualifies -> splits.
check('dynamic min-split enables split on 2MB file', dseg && dyn.segments.length === 2, `segs=${dyn.segments.length}`);

// Tail micro-split: normal threshold too high, but a straggler is rescued.
const tail = new SegmentManager(300 * 1024, {
  minSplitSize: 2 * 1024 * 1024,
  allowSplit: true,
  tailMicroSplit: true,
  pieceSelection: 'largest',
});
// Fully-covering byte ranges: [0,100KB) + [100KB,300KB).
tail.segments = [new Segment(1, 0, 100 * 1024 - 1), new Segment(2, 100 * 1024, 300 * 1024 - 1)];
tail.segments.forEach((s) => (s.state = 'active'));
const before = tail.segments.length;
const rescued = tail.claim();
check('tail micro-split rescues a straggler', rescued && tail.segments.length === before + 1, `segs=${tail.segments.length}`);
// Coverage preserved: bytes [0, 300KB) fully covered, no overlap.
let covered = 0;
for (const s of tail.segments) covered += s.end - s.start + 1;
check('micro-split keeps full byte coverage', covered === 300 * 1024, `covered=${covered}`);

// Straggler guard: when all remaining segments are equally tiny, no cascade split.
const flat = new SegmentManager(130 * 1024, {
  minSplitSize: 2 * 1024 * 1024,
  allowSplit: true,
  tailMicroSplit: true,
  pieceSelection: 'largest',
});
flat.segments = [new Segment(1, 0, 65 * 1024 - 1), new Segment(2, 65 * 1024, 130 * 1024 - 1)];
flat.segments.forEach((s) => (s.state = 'active'));
const flatRescued = flat.claim();
check('no micro-split when no straggler (all tiny)', flatRescued === null, `rescued=${flatRescued}`);

// Disabled tail micro-split: behaves like before (no rescue).
const off = new SegmentManager(300 * 1024, {
  minSplitSize: 2 * 1024 * 1024,
  allowSplit: true,
  tailMicroSplit: false,
  pieceSelection: 'largest',
});
off.segments = [new Segment(1, 0, 100 * 1024 - 1), new Segment(2, 100 * 1024, 300 * 1024 - 1)];
off.segments.forEach((s) => (s.state = 'active'));
check('tail micro-split disabled -> no rescue', off.claim() === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
