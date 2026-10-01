// Chrome-extension downloadId guard.
//
// Regression test for "Unchecked runtime.lastError: Invalid downloadId".
//
// The old handoff code called chrome.downloads.erase({ id }) WITHOUT a callback.
// When the native download was already gone (finished/removed between
// onDeterminingFilename and the AiDM handoff), the API set chrome.runtime
// .lastError to "Invalid downloadId" and — because no callback read it — Chrome
// logged "Unchecked runtime.lastError". The fix (chrome-extension/background.js,
// between the ==TEST-EXPORT== sentinels) only acts when the id still exists and
// consumes lastError in every callback.
//
// This test extracts the real production helpers from background.js (between the
// sentinels) and drives them with a mock `chrome`, so it exercises the exact
// shipped code rather than a copy.
//
// Run: node test/ext-download-guard.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const BACKGROUND = path.join(__dirname, '..', 'chrome-extension', 'background.js');
const src = fs.readFileSync(BACKGROUND, 'utf8');

const m = src.match(/\/\/ ==TEST-EXPORT-BEGIN==[\s\S]*?\/\/ ==TEST-EXPORT-END==/);
assert.ok(m, 'TEST-EXPORT sentinels not found in background.js');
let body = m[0]
  .replace(/\/\/ ==TEST-EXPORT-BEGIN==[^\n]*\n/, '')
  .replace(/\/\/ ==TEST-EXPORT-END==[^\n]*\n?/, '');

// Build a tiny mock `chrome` whose callbacks run synchronously. lastError is a
// getter so the same mock can simulate "download exists / gone / API error".
function makeChrome() {
  const calls = { search: [], cancel: [], erase: [] };
  let lastError = null;
  const chrome = {
    runtime: { get lastError() { return lastError; } },
    downloads: {
      search(filter, cb) { calls.search.push(filter); cb([{ id: filter.id }]); },
      cancel(id, cb) { calls.cancel.push(id); if (cb) cb(); },
      erase(filter, cb) { calls.erase.push(filter); if (cb) cb([]); },
    },
    _setLastError(v) { lastError = v; },
    calls,
  };
  return chrome;
}

// `body` defines `downloadExists` / `safeRemoveChromeDownload` that close over a
// `chrome` parameter. The IIFE returns them; we call it per-mock-chrome.
const makeHelpers = new vm.Script(
  '(function(chrome){ ' + body + '\n; return { downloadExists, safeRemoveChromeDownload }; })'
).runInNewContext({});

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}

console.log('── 1. downloadExists ──');
check('reports true when the id is present', () => {
  const chrome = makeChrome();
  const H = makeHelpers(chrome);
  let out = 'unset';
  H.downloadExists(42, (exists) => { out = exists; });
  assert.strictEqual(out, true);
  assert.strictEqual(chrome.calls.search.length, 1);
});
check('reports false when search returns an empty list', () => {
  const chrome = makeChrome();
  chrome.downloads.search = (filter, cb) => { chrome.calls.search.push(filter); cb([]); };
  const H = makeHelpers(chrome);
  let out = 'unset';
  H.downloadExists(7, (exists) => { out = exists; });
  assert.strictEqual(out, false);
});
check('reports false and swallows lastError when search itself errors', () => {
  const chrome = makeChrome();
  chrome.downloads.search = (filter, cb) => {
    chrome.calls.search.push(filter);
    chrome._setLastError({ message: 'boom' });
    cb(null);
  };
  const H = makeHelpers(chrome);
  let out = 'unset';
  H.downloadExists(7, (exists) => { out = exists; });
  assert.strictEqual(out, false);
});

console.log('── 2. safeRemoveChromeDownload (the Invalid downloadId fix) ──');
check('when the download exists: cancel then erase, no error', () => {
  const chrome = makeChrome();
  const H = makeHelpers(chrome);
  H.safeRemoveChromeDownload(99);
  assert.strictEqual(chrome.calls.cancel.length, 1, 'cancel must be called');
  assert.strictEqual(chrome.calls.cancel[0], 99);
  assert.strictEqual(chrome.calls.erase.length, 1, 'erase must be called');
  assert.strictEqual(chrome.calls.erase[0].id, 99);
});
check('when the download is already gone: neither cancel nor erase is called', () => {
  const chrome = makeChrome();
  chrome.downloads.search = (filter, cb) => { chrome.calls.search.push(filter); cb([]); };
  const H = makeHelpers(chrome);
  H.safeRemoveChromeDownload(99);
  assert.strictEqual(chrome.calls.cancel.length, 0, 'must NOT cancel a gone download');
  assert.strictEqual(chrome.calls.erase.length, 0, 'must NOT erase a gone download');
});
check('when search errors: no cancel/erase and no thrown lastError', () => {
  const chrome = makeChrome();
  chrome.downloads.search = (filter, cb) => {
    chrome.calls.search.push(filter);
    chrome._setLastError({ message: 'Invalid downloadId' });
    cb(null);
  };
  const H = makeHelpers(chrome);
  assert.doesNotThrow(() => H.safeRemoveChromeDownload(99));
  assert.strictEqual(chrome.calls.cancel.length, 0);
  assert.strictEqual(chrome.calls.erase.length, 0);
});
check('erase that returns Invalid downloadId is swallowed, not thrown', () => {
  const chrome = makeChrome();
  chrome.downloads.erase = (filter, cb) => {
    chrome.calls.erase.push(filter);
    chrome._setLastError({ message: 'Invalid downloadId' });
    if (cb) cb([]);
  };
  const H = makeHelpers(chrome);
  assert.doesNotThrow(() => H.safeRemoveChromeDownload(99));
  assert.strictEqual(chrome.calls.erase.length, 1);
});
check('non-number id is a no-op (guard against stray values)', () => {
  const chrome = makeChrome();
  const H = makeHelpers(chrome);
  H.safeRemoveChromeDownload('not-a-number');
  assert.strictEqual(chrome.calls.search.length, 0);
  assert.strictEqual(chrome.calls.cancel.length, 0);
  assert.strictEqual(chrome.calls.erase.length, 0);
});

console.log(`\next-download-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
