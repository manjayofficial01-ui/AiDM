// APP-008 regression: a late probe that fails a row AFTER its transfer has
// started must tear the active writer down exactly once.
//
// Before the fix the row flipped to 'error' while the engine kept writing —
// and since _getActiveCount() only counts connecting/downloading rows, the
// queue treated the slot as free and could exceed maxConcurrent.
//
// The real prototype methods run against a fake `this` (manager shape without
// Electron), plus a stubbed engine that records cancel calls.
//
// Run: node test/late-probe-cancel.js
'use strict';

const assert = require('assert');
const { DownloadManager } = require('../src/download-manager');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}

function fakeManager({ engineActive = true } = {}) {
  // Inherit the real prototype: _enforceProbeGuards delegates to _failRow.
  const manager = Object.create(DownloadManager.prototype);
  Object.assign(manager, {
    persisted: 0,
    emits: [],
    processed: 0,
    cancelled: [],
    engine: {
      getDownload(id) { return engineActive ? { id } : null; },
      cancelDownload(id) { manager.cancelled.push(id); },
    },
    downloads: new Map(),
    _persistDownloads() { this.persisted++; },
    emit(ev, payload) { this.emits.push([ev, payload]); },
    _processQueue() { this.processed++; },
  });
  return manager;
}

function row(overrides = {}) {
  return {
    id: 'dl-late', url: 'https://cdn.example.test/v.mp4', filename: 'v.mp4',
    status: 'downloading', error: null, needsSession: false, downloaded: 0,
    isHls: false, isDash: false, ...overrides,
  };
}

console.log('── 1. a late dead-link probe cancels the active writer ──');
check('engine cancel is called once for the failing row', () => {
  const mgr = fakeManager();
  const dl = row();
  mgr.downloads.set(dl.id, dl);
  const meta = { status: 404, contentType: 'video/mp4', finalUrl: dl.url };
  const rc = DownloadManager.prototype._enforceProbeGuards.call(mgr, dl, meta);
  assert.strictEqual(rc, null);
  assert.strictEqual(dl.status, 'error');
  assert.deepStrictEqual(mgr.cancelled, ['dl-late'], 'engine must be torn down');
  assert.strictEqual(mgr.processed, 1, 'queue must advance exactly once');
  assert.strictEqual(mgr.emits.filter(([ev]) => ev === 'download-error').length, 1);
});

check('no engine record yet (probe still racing) is a safe no-op cancel', () => {
  const mgr = fakeManager({ engineActive: false });
  const dl = row({ id: 'dl-nostart' });
  mgr.downloads.set(dl.id, dl);
  const rc = DownloadManager.prototype._enforceProbeGuards.call(
    mgr, dl, { status: 404, contentType: 'video/mp4', finalUrl: dl.url });
  assert.strictEqual(rc, null);
  assert.strictEqual(dl.status, 'error');
  assert.deepStrictEqual(mgr.cancelled, []);
});

check('auth wall also cancels the writer and flags needsSession', () => {
  const mgr = fakeManager();
  const dl = row({ id: 'dl-auth' });
  mgr.downloads.set(dl.id, dl);
  DownloadManager.prototype._enforceProbeGuards.call(mgr, dl, {
    finalUrl: 'https://accounts.google.com/ServiceLogin?continue=x',
    contentType: 'text/html',
  });
  assert.strictEqual(dl.status, 'error');
  assert.strictEqual(dl.needsSession, true);
  assert.deepStrictEqual(mgr.cancelled, ['dl-auth']);
});

console.log('── 2. terminal rows are never re-failed ──');
check('a probe settling after completion does not repaint the row', () => {
  const mgr = fakeManager();
  const dl = row({ id: 'dl-done', status: 'completed', downloaded: 1048576 });
  mgr.downloads.set(dl.id, dl);
  const rc = DownloadManager.prototype._enforceProbeGuards.call(
    mgr, dl, { status: 404, contentType: 'video/mp4', finalUrl: dl.url });
  assert.strictEqual(dl.status, 'completed', 'completed row must stay completed');
  assert.strictEqual(dl.error, null);
  assert.strictEqual(mgr.emits.length, 0, 'no error emit for a terminal row');
  assert.deepStrictEqual(mgr.cancelled, []);
});

check('a resume with bytes on disk keeps its dead-probe pass-through', () => {
  const mgr = fakeManager({ engineActive: false });
  const dl = row({ id: 'dl-resume', status: 'downloading', downloaded: 524288 });
  mgr.downloads.set(dl.id, dl);
  const meta = { status: 404, contentType: 'video/mp4', finalUrl: dl.url };
  const rc = DownloadManager.prototype._enforceProbeGuards.call(mgr, dl, meta);
  assert.strictEqual(rc, meta, 'fresh-start guards skip rows with bytes on disk');
  assert.strictEqual(dl.status, 'downloading');
});

console.log('── 3. one error per transition (no double emit) ──');
check('a second failure of the same row emits nothing and cancels nothing', () => {
  const mgr = fakeManager();
  const dl = row({ id: 'dl-twice' });
  mgr.downloads.set(dl.id, dl);
  const meta = { status: 404, contentType: 'video/mp4', finalUrl: dl.url };
  DownloadManager.prototype._enforceProbeGuards.call(mgr, dl, meta);
  const afterFirst = mgr.emits.length;
  DownloadManager.prototype._enforceProbeGuards.call(mgr, dl, meta);
  assert.strictEqual(mgr.emits.length, afterFirst, 'second error must not emit');
  assert.deepStrictEqual(mgr.cancelled, ['dl-twice'], 'engine cancel stays once');
  assert.strictEqual(mgr.processed, 1, 'queue advance stays once');
});

console.log('── 4. _startAborted covers errored rows ──');
check('error rows report aborted (start path stands down)', () => {
  const mgr = fakeManager();
  const dl = row({ id: 'dl-abort', status: 'error' });
  mgr.downloads.set(dl.id, dl);
  assert.strictEqual(DownloadManager.prototype._startAborted.call(mgr, dl), true);
});
check('cancelled rows report aborted', () => {
  const mgr = fakeManager();
  const dl = row({ id: 'dl-cancel', status: 'cancelled' });
  mgr.downloads.set(dl.id, dl);
  assert.strictEqual(DownloadManager.prototype._startAborted.call(mgr, dl), true);
});
check('a live downloading row is not aborted', () => {
  const mgr = fakeManager();
  const dl = row({ id: 'dl-live' });
  mgr.downloads.set(dl.id, dl);
  assert.strictEqual(DownloadManager.prototype._startAborted.call(mgr, dl), false);
});

console.log(`\nlate-probe-cancel: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
