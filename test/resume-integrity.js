// Regression harness for the 2026-11-23 upgrade cycle: the two PROVEN
// high-severity engine defects and the shared-gate waiter leak.
//
//  1. RESUME INTEGRITY — the `.part` file is preallocated SPARSE, so its size
//     always reports the full resource length and cannot tell a written byte
//     from a hole. A bitmap that claims a segment it never wrote produced a
//     finished file with a zero-filled hole that the app reported as
//     "completed". The restored bytes are now read back and an unwritten
//     segment is re-downloaded.
//  2. GATE WAITERS — a cancelled task left its waiter registered on the
//     shared host gate. The next released connection woke the DEAD task, the
//     slot was spent, and a LIVE download sat idle while the gate still
//     reported capacity.
//
// Run: node test/resume-integrity.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SegmentManager } = require('../src/engine/segments');
const { findUnwrittenSegments, demoteSegments, sampleOffsets } = require('../src/engine/restore-verify');
const { HostGate } = require('../src/engine/host-gate');
const { GlobalConnectionBudget } = require('../src/engine/global-budget');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-resume-'));
const SEG_OPTS = { minSplitSize: 1024, pieceSelection: 'largest', allowSplit: true };

/**
 * A sparse `.part`: the file reports the FULL size from the start, but only
 * `written` bytes at the front were ever written.
 */
function sparsePart(name, total, written) {
  const p = path.join(TMP, name);
  const fd = fs.openSync(p, 'w+');
  fs.ftruncateSync(fd, total);
  if (written > 0) fs.writeSync(fd, Buffer.alloc(written, 0x41), 0, written, 0);
  fs.closeSync(fd);
  return p;
}

(async () => {
  // ── 1. Sparse preallocation defeats the file-size trim guard ─────────────
  console.log('\n── 1a. the on-disk size cannot see a hole (the bug) ──');
  {
    const partPath = sparsePart('sparse.part', 1024 * 1024, 256 * 1024);
    eq('the .part reports the FULL size (sparse)', fs.statSync(partPath).size, 1024 * 1024);

    // The control file claims segment 1 (0..524287) is complete.
    const restored = SegmentManager.restore(
      [{ id: 1, start: 0, end: 524287, downloaded: 524288, state: 'done' }],
      1024 * 1024,
      SEG_OPTS,
      fs.statSync(partPath).size, // <- what the engine passes today
    );
    eq('the file-size trim does NOT demote the claimed segment', restored.all[0].state, 'done');
  }

  console.log('\n── 1b. the byte check demotes the unwritten segment ──');
  {
    const partPath = sparsePart('sparse.part', 1024 * 1024, 256 * 1024);
    const restored = SegmentManager.restore(
      [{ id: 1, start: 0, end: 524287, downloaded: 524288, state: 'done' }],
      1024 * 1024,
      SEG_OPTS,
      fs.statSync(partPath).size,
    );
    const unwritten = await findUnwrittenSegments(partPath, restored.all);
    check('the zero-written segment is detected', unwritten.includes(1), `unwritten=${JSON.stringify(unwritten)}`);

    const demoted = demoteSegments(restored.all, unwritten);
    eq('the segment is demoted to pending', restored.all[0].state, 'pending');
    eq('its claimed bytes are dropped', restored.all[0].downloaded, 0);
    eq('one segment was demoted', demoted, 1);
    eq('the manager no longer counts it as downloaded', restored.downloadedBytes, 0);
    check('the task would re-download it', restored.remainingBytes === 1024 * 1024, `remaining=${restored.remainingBytes}`);
  }

  console.log('\n── 1c. real data is NOT distrusted ──');
  {
    const partPath = path.join(TMP, 'real.part');
    const payload = Buffer.alloc(512 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7) & 0xff;
    const fd = fs.openSync(partPath, 'w+');
    fs.ftruncateSync(fd, 1024 * 1024);
    fs.writeSync(fd, payload, 0, payload.length, 0);
    fs.closeSync(fd);

    const restored = SegmentManager.restore(
      [{ id: 1, start: 0, end: 524287, downloaded: 524288, state: 'done' }],
      1024 * 1024,
      SEG_OPTS,
      fs.statSync(partPath).size,
    );
    const unwritten = await findUnwrittenSegments(partPath, restored.all);
    check('a written segment is kept', !unwritten.includes(1), `unwritten=${JSON.stringify(unwritten)}`);
  }

  console.log('\n── 1d. a segment past the end of the file is unwritten ──');
  {
    const partPath = path.join(TMP, 'short.part');
    fs.writeFileSync(partPath, Buffer.alloc(1024, 0x42));
    // Hand-made segment (not via restore): the engine's own restore() already
    // trims a short file by its size, so this guards the verifier itself.
    const unwritten = await findUnwrittenSegments(partPath, [
      { id: 9, start: 4096, end: 8191, downloaded: 4096, state: 'done' },
    ]);
    check('a segment beyond the file is reported', unwritten.includes(9), `unwritten=${JSON.stringify(unwritten)}`);

    const written = await findUnwrittenSegments(partPath, [
      { id: 10, start: 0, end: 1023, downloaded: 1024, state: 'done' },
    ]);
    check('a segment inside the file is kept', !written.includes(10), `unwritten=${JSON.stringify(written)}`);
  }

  console.log('\n── 1d2. a half-written segment is re-downloaded ──');
  {
    // 1 MB sparse file, only the first 256 KB written, but the bitmap claims
    // the whole first segment (512 KB) is done.
    const partPath = sparsePart('half.part', 1024 * 1024, 256 * 1024);
    const unwritten = await findUnwrittenSegments(partPath, [
      { id: 1, start: 0, end: 524287, downloaded: 524288, state: 'done' },
    ]);
    check('the half-written segment is reported', unwritten.includes(1), `unwritten=${JSON.stringify(unwritten)}`);
  }

  console.log('\n── 1e. sampling covers the whole segment ──');
  {
    const offsets = sampleOffsets(0, 1023 * 1024, 4096, 3);
    eq('three windows are sampled', offsets.length, 3);
    check('the first window is the segment start', offsets[0] === 0, `offsets=${JSON.stringify(offsets)}`);
    check('the last window reaches the segment end', offsets[2] + 4096 - 1 === 1023 * 1024, `offsets=${JSON.stringify(offsets)}`);
    check('all windows stay inside the segment', offsets.every((o) => o >= 0 && o + 4096 - 1 <= 1023 * 1024));
  }

  // ── 2. The shared-gate waiter leak ───────────────────────────────────────
  console.log('\n── 2a. a dead waiter must not eat the released slot ──');
  {
    const gate = new HostGate(1);
    gate.acquire('cdn.test'); // the only slot is busy

    let deadWoken = false;
    let liveWoken = false;
    gate.waitForSlot('cdn.test', 'dead-task', () => { deadWoken = true; return false; }); // task is gone
    gate.waitForSlot('cdn.test', 'live-task', () => { liveWoken = true; return true; });

    gate.release('cdn.test'); // one slot frees

    check('the dead task is not the winner', deadWoken === true);
    check('the LIVE task gets the freed slot', liveWoken === true, `liveWoken=${liveWoken}`);
  }

  console.log('\n── 2b. waiters are cleared when a task stops ──');
  {
    const gate = new HostGate(1);
    gate.acquire('cdn.test');
    gate.waitForSlot('cdn.test', 'task-a', () => true);
    gate.waitForSlot('other.test', 'task-a', () => true);
    eq('the task holds two waiters', gate.waiterCount('task-a'), 2);

    const removed = gate.clearWaiters('task-a');
    eq('both waiters are dropped', removed, 2);
    eq('no waiter is left', gate.waiterCount('task-a'), 0);

    // The gate is empty → a released slot wakes nobody.
    let woken = false;
    gate.waitForSlot('cdn.test', 'task-b', () => { woken = true; return true; });
    gate.release('cdn.test');
    check('a live waiter still wakes', woken === true);
  }

  console.log('\n── 2c. the global budget clears its waiter too ──');
  {
    const budget = new GlobalConnectionBudget(1);
    budget.register('task-a', 4);
    budget.acquire();
    let woken = false;
    budget.waitForSlot('task-a', () => { woken = true; return true; });
    budget.clearWaiter('task-a');
    budget.release();
    check('the cleared waiter is not woken', woken === false);
  }

  console.log('\n── 2d. the task lifecycle clears its waiters ──');
  {
    const taskSrc = fs.readFileSync(path.join(__dirname, '../src/engine/task.js'), 'utf8');
    check('the task tracks the hosts it waits on', /this\._gateWaitHosts = new Set\(\)/.test(taskSrc));
    check('a stopped task releases its waiters',
      /releaseGateWaiters\(\)/.test(taskSrc) && /finally \{[\s\S]{0,400}?this\.releaseGateWaiters\(\)/.test(taskSrc));
    check('the global-budget waiter is released too',
      /this\.globalBudget\.clearWaiter\(this\.id\)/.test(taskSrc));
    check('a waiter callback reports whether it consumed the slot',
      /_onGateWake\(\)/.test(taskSrc) && /return false;/.test(taskSrc));
    check('the restored bytes are verified on every resume path',
      (taskSrc.match(/await this\._verifyRestoredBytes\(/g) || []).length === 3);
  }

  // ── 3. The control file is written AFTER the data ───────────────────────
  console.log('\n── 3. write ordering: data before bitmap ──');
  {
    const taskSrc = fs.readFileSync(path.join(__dirname, '../src/engine/task.js'), 'utf8');
    const saveControl = /async saveControl\(\) \{[\s\S]*?\n  \}/.exec(taskSrc);
    check('saveControl exists', !!saveControl);
    const body = saveControl ? saveControl[0] : '';
    const syncAt = body.indexOf('sync()');
    const writeAt = body.indexOf('saveControlFile(');
    check('the writer is flushed before the bitmap is written',
      syncAt >= 0 && writeAt > syncAt, `sync@${syncAt} write@${writeAt}`);

    const ctlSrc = fs.readFileSync(path.join(__dirname, '../src/engine/control-file.js'), 'utf8');
    check('the control file itself is fsynced', /handle\.sync\(\)/.test(ctlSrc));
    check('the directory entry is flushed after the rename',
      /rename\(tmp, filePath\)/.test(ctlSrc) && /dir\.sync\(\)/.test(ctlSrc));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
