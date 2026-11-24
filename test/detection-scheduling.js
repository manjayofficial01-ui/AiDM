'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'chrome-extension', 'content.js'),
  'utf8',
);
const schedulerStart = source.indexOf('const SCAN_COOLDOWN_MS');
const schedulerEnd = source.indexOf('// Cheap pre-checks', schedulerStart);
const initialStart = source.indexOf('// ── Initial Scan');
const initialEnd = source.indexOf('// Hidden tabs', initialStart);
assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart, 'scan scheduler must exist');
assert.ok(initialStart >= 0 && initialEnd > initialStart, 'initial scan block must exist');
const shippedScheduling = source.slice(schedulerStart, schedulerEnd) + '\n' +
  source.slice(initialStart, initialEnd) + '\nscheduleFullScan();';

let scans = 0;
let capsuleSyncs = 0;
const timers = [];
new Function(
  'fullScan',
  'scheduleSyncCapsules',
  'scanNetworkResources',
  'probe',
  'setTimeout',
  shippedScheduling,
)(
  () => { scans++; },
  () => { capsuleSyncs++; },
  () => [],
  () => {},
  (fn, ms) => { timers.push([fn, ms]); },
);

for (const [fn, ms] of timers) {
  if (ms === 0) fn();
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  OK  ', name);
  } catch (err) {
    fail++;
    console.log('  FAIL', name, '—', err.message);
  }
}

check('the initial full scan runs immediately at document_idle', () => {
  assert.equal(scans, 1);
});
check('capsules sync immediately after the initial scan', () => {
  assert.equal(capsuleSyncs, 1);
});
check('initial capsule DOM updates do not queue a zero-delay duplicate scan', () => {
  assert.equal(timers.filter(([, ms]) => ms === 0).length, 0);
});
check('fallback probing and full-scan cooldown remain delayed', () => {
  assert.ok(timers.some(([, ms]) => ms === 2500));
  assert.ok(timers.some(([, ms]) => ms > 0 && ms < 2500));
});

console.log(`\ndetection-scheduling: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
