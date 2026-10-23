// Early download takeover at downloads.onCreated.
//
// Regression test for "dual download dialogs": with Chrome's "Ask where to
// save each file" enabled (or an explicit Save-image-as), the old flow let
// Chrome run its target determination while the extension negotiated the
// handoff — Chrome raised its native Save As dialog AND AiDM raised its own
// Choose Download Location dialog, both waiting at once (Chrome's copy was
// only cancelled after the desktop accepted the POST).
//
// The fix (chrome-extension/background.js): decide at downloads.onCreated —
// the earliest signal — and cancel Chrome's copy there (a cancelled download
// aborts target determination, so Chrome's Save As dialog never opens), then
// hand off; on refusal restore natively with saveAs: true.
//
// shouldCancelAtCreation is extracted between the
// ==TEST-EXPORT-EARLY-TAKEOVER== sentinels, markTakenOver and the real
// shouldTakeOver via the interception.js grab() mechanism — the SHIPPED code
// is exercised, not a copy.
//
// Run: node test/ext-early-takeover.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const BACKGROUND = path.join(__dirname, '..', 'chrome-extension', 'background.js');
const src = fs.readFileSync(BACKGROUND, 'utf8');

// ── grab(): extract a shipped top-level function definition (interception.js) ─
function grab(source, name) {
  const i = source.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in background.js');
  const j = source.indexOf('{', i);
  let d = 0, inStr = null, esc = false;
  for (let k = j; k < source.length; k++) {
    const c = source[k];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && source[k + 1] === '/') { const e = source.indexOf('\n', k); k = e < 0 ? source.length : e; continue; }
    if (c === '/' && source[k + 1] === '*') { const e = source.indexOf('*/', k); k = e < 0 ? source.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/') {
      let p = k - 1;
      while (p >= 0 && (source[p] === ' ' || source[p] === '\t')) p--;
      const pc = p >= 0 ? source[p] : '(';
      if (!/[(,=:?!&|{;\[]/.test(pc)) continue;
      let q = k + 1, qc = false, cls = false;
      for (; q < source.length; q++) {
        const cc = source[q];
        if (qc) { qc = false; continue; }
        if (cc === '\\') { qc = true; continue; }
        if (cc === '[') cls = true;
        else if (cc === ']') cls = false;
        else if (cc === '/' && !cls) break;
      }
      k = q; continue;
    }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return source.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

// ── shipped shouldCancelAtCreation (sentinel block) ──────────────────────────
const m = src.match(/\/\/ ==TEST-EXPORT-EARLY-TAKEOVER-BEGIN==[\s\S]*?\/\/ ==TEST-EXPORT-EARLY-TAKEOVER-END==/);
assert.ok(m, 'EARLY-TAKEOVER sentinels not found in background.js');
const body = m[0]
  .replace(/\/\/ ==TEST-EXPORT-EARLY-TAKEOVER-BEGIN==[^\n]*\n/, '')
  .replace(/\/\/ ==TEST-EXPORT-EARLY-TAKEOVER-END==[^\n]*\n?/, '');
const { shouldCancelAtCreation } = new vm.Script(
  '(function(){ ' + body + '\n; return { shouldCancelAtCreation }; })'
).runInNewContext({})();

// ── shipped markTakenOver + real gate ────────────────────────────────────────
const KEY_STATE_TTL_MS = 4000;
const gateLib = new Function(
  'KEY_STATE_TTL_MS',
  grab(src, 'matchesFileType') + '\n' +
  grab(src, 'isExcludedSite') + '\n' +
  grab(src, 'keyFresh') + '\n' +
  grab(src, 'shouldTakeOver') + '\n' +
  'return { shouldTakeOver };'
)(KEY_STATE_TTL_MS);
const { shouldTakeOver } = gateLib;

const markLib = new Function(
  'takenOverIds', 'TAKEN_OVER_MAX',
  grab(src, 'markTakenOver') + '\n return { markTakenOver };'
)(new Set(), 200);
const { markTakenOver } = markLib;

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}

const ITEM = (url, extra) => Object.assign({ id: 42, url, finalUrl: url }, extra);

console.log('── 1. shouldCancelAtCreation decision matrix ──');
check('cancels a plain https download when connected and the gate passes', () => {
  assert.strictEqual(shouldCancelAtCreation(
    ITEM('https://pbs.twimg.com/media/HVSo77tawAA0G9e?format=jpg&name=large'),
    { connected: true, gate: {}, shouldTakeOver: () => true, isSelfDownload: () => false }
  ), true);
});
check('does not cancel when the app is not connected', () => {
  assert.strictEqual(shouldCancelAtCreation(
    ITEM('https://example.com/a.jpg'),
    { connected: false, gate: {}, shouldTakeOver: () => true, isSelfDownload: () => false }
  ), false);
});
check('does not cancel without a context or a numeric id', () => {
  assert.strictEqual(shouldCancelAtCreation(ITEM('https://example.com/a.jpg'), null), false);
  assert.strictEqual(shouldCancelAtCreation(null, { connected: true, shouldTakeOver: () => true }), false);
  assert.strictEqual(shouldCancelAtCreation(
    { url: 'https://example.com/a.jpg' },
    { connected: true, shouldTakeOver: () => true, isSelfDownload: () => false }
  ), false);
});
check('does not cancel blob:/data:/chrome-extension URLs (determining-time path)', () => {
  const ctx = { connected: true, gate: {}, shouldTakeOver: () => true, isSelfDownload: () => false };
  assert.strictEqual(shouldCancelAtCreation(ITEM('blob:https://leonardo.ai/uuid'), ctx), false);
  assert.strictEqual(shouldCancelAtCreation(ITEM('data:image/png;base64,AAA'), ctx), false);
  assert.strictEqual(shouldCancelAtCreation(ITEM('chrome-extension://abc/icon.png'), ctx), false);
});
check('prefers finalUrl when it is already known', () => {
  assert.strictEqual(shouldCancelAtCreation(
    { id: 1, url: 'https://tracker.example/x', finalUrl: 'https://cdn.example/file.zip' },
    { connected: true, gate: {}, shouldTakeOver: (u) => u === 'https://cdn.example/file.zip', isSelfDownload: () => false }
  ), true);
});
check('does not cancel when the takeover gate refuses', () => {
  assert.strictEqual(shouldCancelAtCreation(
    ITEM('https://example.com/a.jpg'),
    { connected: true, gate: {}, shouldTakeOver: () => false, isSelfDownload: () => false }
  ), false);
});
check('does not cancel self-initiated downloads (fallback loop guard)', () => {
  assert.strictEqual(shouldCancelAtCreation(
    ITEM('https://example.com/a.jpg'),
    { connected: true, gate: {}, shouldTakeOver: () => true, isSelfDownload: () => true }
  ), false);
});
check('does not cancel an id already taken over', () => {
  const taken = new Set([42]);
  assert.strictEqual(shouldCancelAtCreation(
    ITEM('https://example.com/a.jpg'),
    { connected: true, gate: {}, shouldTakeOver: () => true, isSelfDownload: () => false, takenOverIds: taken }
  ), false);
});
check('a throwing gate must never cancel the user\'s download', () => {
  assert.strictEqual(shouldCancelAtCreation(
    ITEM('https://example.com/a.jpg'),
    { connected: true, gate: {}, shouldTakeOver: () => { throw new Error('boom'); }, isSelfDownload: () => false }
  ), false);
});

console.log('── 2. markTakenOver ──');
check('marks numeric ids and ignores non-numeric ones', () => {
  const set = new Set();
  const lib = new Function('takenOverIds', 'TAKEN_OVER_MAX',
    grab(src, 'markTakenOver') + '\n return { markTakenOver };')(set, 200);
  lib.markTakenOver(7);
  lib.markTakenOver('7');
  lib.markTakenOver(null);
  assert.deepStrictEqual([...set], [7]);
});
check('evicts oldest entries beyond the cap', () => {
  const set = new Set();
  const lib = new Function('takenOverIds', 'TAKEN_OVER_MAX',
    grab(src, 'markTakenOver') + '\n return { markTakenOver };')(set, 3);
  [1, 2, 3, 4, 5].forEach((id) => lib.markTakenOver(id));
  assert.strictEqual(set.size, 3);
  assert.deepStrictEqual([...set], [3, 4, 5]);
});

console.log('── 3. wiring with the SHIPPED shouldTakeOver gate ──');
const NOW = Date.now();
const GATE = (over) => Object.assign({
  browserIntegration: true,
  interceptAll: true,
  interceptFileTypes: ['jpg', 'zip'],
  excludedSites: [],
  preventAt: 0,
  forceAt: 0,
  nowMs: NOW,
}, over);
const decide = (url, over, gate) => shouldCancelAtCreation(ITEM(url), {
  connected: true,
  gate: GATE(gate),
  shouldTakeOver,
  isSelfDownload: () => false,
  ...(over || {}),
});
check('default settings (interceptAll) cancel an extensionless https download', () => {
  assert.strictEqual(decide('https://example.com/get_file/abc'), true);
});
check('excluded site is never cancelled', () => {
  assert.strictEqual(decide('https://cdn.mysite.com/a.jpg', null, { excludedSites: ['mysite.com'] }), false);
});
check('a fresh force hotkey cancels even off the type list', () => {
  assert.strictEqual(decide('https://example.com/file.xyz', null, {
    interceptAll: false, forceAt: NOW,
  }), true);
});
check('a fresh prevent hotkey leaves the download to Chrome', () => {
  assert.strictEqual(decide('https://example.com/a.jpg', null, { preventAt: NOW }), false);
});
check('interceptAll off: listed type cancels, unlisted does not', () => {
  assert.strictEqual(decide('https://example.com/pic.jpg', null, { interceptAll: false }), true);
  assert.strictEqual(decide('https://example.com/song.mp3', null, { interceptAll: false }), false);
});

console.log(`\next-early-takeover: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
