// Tests for src/keep-awake.js — sleep-inhibition policy + blocker lifecycle.
// Run: node test/keep-awake.js
const fs = require('fs');
const path = require('path');
const { shouldKeepAwake, countActiveTransfers, KeepAwake } = require('../src/keep-awake');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra === undefined ? '' : extra); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}

/** Records start/stop calls; mimics Electron's powerSaveBlocker (numeric ids). */
function fakeBlocker() {
  let next = 1;
  const live = new Set();
  const calls = { start: 0, stop: 0, stoppedIds: [] };
  return {
    calls,
    live,
    start(type) {
      calls.start++;
      if (type !== 'prevent-app-suspension') throw new Error('unexpected type ' + type);
      const id = next++;
      live.add(id);
      return id;
    },
    stop(id) {
      calls.stop++;
      calls.stoppedIds.push(id);
      if (!live.has(id)) throw new Error('stop of a non-live id ' + id);
      live.delete(id);
    },
  };
}

console.log('── shouldKeepAwake (policy) ──');
check('no state → false', shouldKeepAwake() === false);
check('idle → false', shouldKeepAwake({ activeTransfers: 0 }) === false);
check('one active transfer → true', shouldKeepAwake({ activeTransfers: 1 }) === true);
check('many active → true', shouldKeepAwake({ activeTransfers: 7 }) === true);
check('schedule running → true', shouldKeepAwake({ activeTransfers: 0, scheduleRunning: true }) === true);
check('user disabled → false even while active',
  shouldKeepAwake({ activeTransfers: 3, enabled: false }) === false);
check('user disabled → false even with a schedule',
  shouldKeepAwake({ scheduleRunning: true, enabled: false }) === false);
check('enabled undefined means on', shouldKeepAwake({ activeTransfers: 1, enabled: undefined }) === true);
check('negative count is not "active"', shouldKeepAwake({ activeTransfers: -1 }) === false);
check('NaN count is not "active"', shouldKeepAwake({ activeTransfers: NaN }) === false);
check('string count does not crash', shouldKeepAwake({ activeTransfers: '2' }) === true);

console.log('\n── countActiveTransfers ──');
check('null rows → 0', countActiveTransfers(null) === 0);
check('undefined rows → 0', countActiveTransfers(undefined) === 0);
check('empty → 0', countActiveTransfers([]) === 0);
check('downloading counts', countActiveTransfers([{ status: 'downloading' }]) === 1);
check('connecting counts', countActiveTransfers([{ status: 'connecting' }]) === 1);
check('paused does NOT count', countActiveTransfers([{ status: 'paused' }]) === 0);
check('queued does NOT count', countActiveTransfers([{ status: 'queued' }]) === 0);
check('error/completed do not count',
  countActiveTransfers([{ status: 'error' }, { status: 'completed' }]) === 0);
check('pending-approval does not count', countActiveTransfers([{ status: 'pending-approval' }]) === 0);
check('mixed set counts only live rows',
  countActiveTransfers([
    { status: 'downloading' }, { status: 'paused' }, { status: 'connecting' }, { status: 'queued' },
  ]) === 2);
check('works with a Map', countActiveTransfers(new Map([['a', { status: 'downloading' }]]).values()) === 1);
check('null rows inside the list are skipped',
  countActiveTransfers([null, { status: 'downloading' }]) === 1);

console.log('\n── KeepAwake: acquisition ──');
{
  const b = fakeBlocker();
  const ka = new KeepAwake(b);
  check('starts inactive', ka.active === false);
  check('idle update acquires nothing', ka.update({ activeTransfers: 0 }) === false && b.calls.start === 0);
  check('active update acquires a blocker', ka.update({ activeTransfers: 1 }) === true && b.live.size === 1);
  check('start was called exactly once', b.calls.start === 1);
  check('blocker type is suspension, not display', true, 'prevent-app-suspension');
}

console.log('\n── KeepAwake: idempotence (called on every progress tick) ──');
{
  const b = fakeBlocker();
  const ka = new KeepAwake(b);
  for (let i = 0; i < 200; i++) ka.update({ activeTransfers: 4 });
  check('200 active updates → ONE blocker', b.calls.start === 1, `start=${b.calls.start}`);
  check('still active', ka.active === true);
  for (let i = 0; i < 50; i++) ka.update({ activeTransfers: 0 });
  check('50 idle updates → ONE stop', b.calls.stop === 1, `stop=${b.calls.stop}`);
  check('inactive afterwards', ka.active === false);
  check('nothing left live', b.live.size === 0);
}

console.log('\n── KeepAwake: transitions ──');
{
  const b = fakeBlocker();
  const ka = new KeepAwake(b);
  ka.update({ activeTransfers: 1 });          // start
  const firstId = [...b.live][0];
  ka.update({ activeTransfers: 0 });          // stop
  ka.update({ activeTransfers: 1 });          // start again
  check('re-acquires after going idle', b.calls.start === 2);
  check('the new id differs from the old one', [...b.live][0] !== firstId, `${firstId} → ${[...b.live][0]}`);
  ka.update({ activeTransfers: 0, scheduleRunning: true });
  check('a running schedule keeps it held', ka.active === true && b.calls.stop === 1);
  ka.update({ activeTransfers: 0, scheduleRunning: false });
  check('released once the schedule ends', ka.active === false && b.calls.stop === 2);
}
{
  const b = fakeBlocker();
  const ka = new KeepAwake(b);
  ka.update({ activeTransfers: 2 });
  ka.update({ activeTransfers: 2, enabled: false });
  check('turning the setting off releases immediately', ka.active === false && b.calls.stop === 1);
  ka.update({ activeTransfers: 2, enabled: true });
  check('turning it back on re-acquires', ka.active === true && b.calls.start === 2);
}

console.log('\n── KeepAwake: failure + release safety ──');
{
  const broken = { start() { throw new Error('blocker unavailable'); }, stop() { throw new Error('nope'); } };
  const ka = new KeepAwake(broken);
  let threw = false;
  try { ka.update({ activeTransfers: 1 }); } catch (e) { threw = true; }
  check('a failing blocker never throws', threw === false);
  check('stays inactive when the blocker fails', ka.active === false);
}
{
  const b = fakeBlocker();
  const ka = new KeepAwake(b);
  ka.update({ activeTransfers: 1 });
  ka.release();
  check('release drops the blocker', ka.active === false && b.live.size === 0);
  ka.release();
  ka.release();
  check('release is idempotent', b.calls.stop === 1, `stop=${b.calls.stop}`);
}

console.log('\n── main.js wiring (source guard) ──');
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('main.js requires keep-awake', /require\('\.\/src\/keep-awake'\)/.test(mainSrc));
  check('uses Electron powerSaveBlocker', /powerSaveBlocker/.test(mainSrc));
  check('refresh runs on download events', /downloadManager\.on\(event[\s\S]{0,220}refreshKeepAwake\(\)/.test(mainSrc));
  check('refresh runs when a schedule starts', /startQueue\(\)[\s\S]{0,120}refreshKeepAwake\(\)/.test(mainSrc));
  check('blocker is released on quit', /before-quit[\s\S]{0,200}keepAwake\.release\(\)/.test(mainSrc));
}

console.log('\n── default setting ──');
{
  const dmSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-manager.js'), 'utf8');
  check('preventSleep defaults to on', /preventSleep:\s*true/.test(dmSrc));
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  check('settings exposes the toggle', /id="setting-prevent-sleep"/.test(html));
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  check('the toggle is loaded', /setting-prevent-sleep'\)\.checked\s*=/.test(appJs));
  check('the toggle is saved', /preventSleep:\s*document\.getElementById\('setting-prevent-sleep'\)/.test(appJs));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
