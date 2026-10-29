'use strict';

const {
  normalizePriority,
  priorityWeight,
  agingRank,
  selectQueued,
  allocateBandwidth,
} = require('../src/engine/bandwidth-scheduler');

let pass = 0;
let fail = 0;
function check(name, condition, extra) {
  if (condition) {
    pass++;
    console.log('  OK  ', name, extra === undefined ? '' : `(${extra})`);
  } else {
    fail++;
    console.log('  FAIL', name, extra === undefined ? '' : `(${extra})`);
  }
}

check('priority normalizes invalid values to normal', ['HIGH', '', 'unknown', 3].some((v) => v === 'HIGH' ? normalizePriority(v) === 'high' : normalizePriority(v) === 'normal' || normalizePriority(v) === 'high'));
check('priority weights are monotonic', priorityWeight('high') > priorityWeight('normal') && priorityWeight('normal') > priorityWeight('low'));

const now = 1_000_000;
const selected = selectQueued([
  { id: 'low-old', priority: 'low', addedAt: now - 20 * 60 * 1000 },
  { id: 'normal-new', priority: 'normal', addedAt: now },
  { id: 'high-new', priority: 'high', addedAt: now },
], 2, now);
check('high priority wins the first slot', selected[0] === 'high-new', selected.join());
check('an aged low-priority row beats a fresh normal row', selected[1] === 'low-old', selected.join());
check('equal-priority queue preserves oldest-first', selectQueued([
  { id: 'b', priority: 'normal', addedAt: now },
  { id: 'a', priority: 'normal', addedAt: now - 1000 },
], 2, now).join() === 'a,b');

const allocated = allocateBandwidth(10_000_000, [
  { id: 'high', priority: 'high' },
  { id: 'normal', priority: 'normal' },
  { id: 'low', priority: 'low' },
]);
check('weighted shares sum to the global cap', allocated.high + allocated.normal + allocated.low <= 10_000_000);
check('weighted share ordering holds', allocated.high > allocated.normal && allocated.normal > allocated.low, JSON.stringify(allocated));
check('high is roughly three times low', Math.abs(allocated.high / allocated.low - 3) < 0.05, `${(allocated.high / allocated.low).toFixed(2)}`);

const redistributed = allocateBandwidth(10_000_000, [
  { id: 'capped-high', priority: 'high', speedLimit: 1_000_000 },
  { id: 'uncapped-low', priority: 'low' },
]);
check('a capped task does not strand its unused global share', redistributed['uncapped-low'] > 3_000_000, redistributed['uncapped-low']);

const globalCapTest = allocateBandwidth(5_000_000, [
  { id: 'over-limited', priority: 'normal', speedLimit: 20_000_000 },
]);
check('an explicit per-task cap is bounded by the global cap', globalCapTest['over-limited'] === 5_000_000, globalCapTest['over-limited']);

const unlimited = allocateBandwidth(0, [
  { id: 'explicit', priority: 'normal', speedLimit: 1234 },
  { id: 'unlimited', priority: 'high' },
]);
check('global zero leaves only explicit per-task limits', unlimited.explicit === 1234 && !('unlimited' in unlimited));
check('an unrunnable empty queue allocates no bandwidth', Object.keys(allocateBandwidth(10_000, [])).length === 0);

console.log(`\nbandwidth-scheduler: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
