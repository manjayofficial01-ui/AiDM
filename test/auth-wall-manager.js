// Manager-level integration test for the auth-wall guard.
//
// test/auth-wall.js proves the PURE decision function. This file proves the
// WIRING: that DownloadManager._enforceProbeGuards actually consumes
// looksLikeAuthWall and, on a login-page probe, (1) returns null so the caller
// does not double-start, (2) flips the row to status='error', (3) sets
// needsSession=true, and (4) emits 'download-error'. It calls the real
// prototype method with a fake `this` so we exercise the production branch
// without booting Electron / a BrowserWindow.
//
// Run: node test/auth-wall-manager.js
'use strict';

const assert = require('assert');
const { DownloadManager } = require('../src/download-manager');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}

// A minimal stand-in for `this` inside _enforceProbeGuards: it only touches
// _persistDownloads / emit / _processQueue (observed in src/download-manager.js).
function fakeManager() {
  return {
    persisted: 0,
    emits: [],
    processed: 0,
    _persistDownloads() { this.persisted++; },
    emit(ev, payload) { this.emits.push([ev, payload]); },
    _processQueue() { this.processed++; },
  };
}

console.log('── 1. auth-wall probe fails the row and asks for a session ──');
check('Google ServiceLogin probe is blocked, not written to disk', () => {
  const mgr = fakeManager();
  const download = {
    id: 'dl-1', url: 'https://drive.google.com/uc?export=download&id=ABC',
    filename: 'invoice.pdf', status: 'downloading', error: null,
    needsSession: false, downloaded: 0, isHls: false, isDash: false,
  };
  const meta = {
    finalUrl: 'https://accounts.google.com/ServiceLogin?continue=…',
    contentType: 'text/html',
  };
  const rc = DownloadManager.prototype._enforceProbeGuards.call(mgr, download, meta);
  assert.strictEqual(rc, null, 'guard must return null so the row is not double-started');
  assert.strictEqual(download.status, 'error', 'row status must be set to error');
  assert.strictEqual(download.needsSession, true, 'row must be flagged needsSession');
  assert.ok(download.error && /login/i.test(download.error), 'error message must mention login');
  assert.strictEqual(mgr.persisted, 1, '_persistDownloads must be called to save the error state');
  assert.ok(mgr.emits.some(([ev]) => ev === 'download-error'), 'must emit download-error');
  assert.strictEqual(mgr.processed, 1, '_processQueue must be called to advance the queue');
});

check('generic /sso probe is blocked (path-based detection in the manager)', () => {
  const mgr = fakeManager();
  const download = {
    id: 'dl-2', url: 'https://files.example.com/sso?next=/file',
    filename: 'report.pdf', status: 'downloading', error: null,
    needsSession: false, downloaded: 0, isHls: false, isDash: false,
  };
  const meta = { finalUrl: 'https://files.example.com/sso?next=/file', contentType: 'text/html' };
  const rc = DownloadManager.prototype._enforceProbeGuards.call(mgr, download, meta);
  assert.strictEqual(rc, null);
  assert.strictEqual(download.status, 'error');
  assert.strictEqual(download.needsSession, true);
});

console.log('── 2. a real file probe is NOT blocked (no false positive) ──');
check('real application/pdf probe passes through unchanged', () => {
  const mgr = fakeManager();
  const download = {
    id: 'dl-3', url: 'https://example.com/invoice.pdf',
    filename: 'invoice.pdf', status: 'downloading', error: null,
    needsSession: false, downloaded: 0, isHls: false, isDash: false,
  };
  const meta = { finalUrl: 'https://example.com/invoice.pdf', contentType: 'application/pdf' };
  const rc = DownloadManager.prototype._enforceProbeGuards.call(mgr, download, meta);
  assert.strictEqual(rc, meta, 'guard must return the meta so the download proceeds');
  assert.strictEqual(download.status, 'downloading', 'status must be left untouched');
  assert.strictEqual(download.needsSession, false, 'must not be flagged needsSession');
  assert.strictEqual(mgr.persisted, 0, 'must not persist on a pass-through');
  assert.strictEqual(mgr.emits.length, 0, 'must not emit on a pass-through');
});

check('null meta is a safe no-op', () => {
  const mgr = fakeManager();
  const download = { id: 'dl-4', url: 'x', filename: 'y', status: 'downloading',
    needsSession: false, downloaded: 0, isHls: false, isDash: false };
  const rc = DownloadManager.prototype._enforceProbeGuards.call(mgr, download, null);
  assert.strictEqual(rc, null, 'null meta returns null but must NOT flag the row');
  assert.strictEqual(download.status, 'downloading', 'status untouched on null meta');
  assert.strictEqual(download.needsSession, false, 'not flagged on null meta');
});

console.log(`\nauth-wall-manager: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
