// Regression harness for the v4.3.0 browser-takeover controls (all original
// AiDM code in chrome-extension/background.js): file-type capture list, site
// exclusions, and the Alt-prevent / force-takeover hotkeys.
//
// The SHIPPED function definitions are extracted (not copied) and exercised
// with injected settings, following the dead-link-guard.js pattern.
//
// Run: node test/interception.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

function grab(srcFile, name) {
  const src = fs.readFileSync(srcFile, 'utf8');
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in ' + srcFile);
  const j = src.indexOf('{', i);
  let d = 0, inStr = null, esc = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/') {
      // Regex-vs-division: look back past whitespace for an opener.
      let p = k - 1;
      while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
      const pc = p >= 0 ? src[p] : '(';
      if (!/[(,=:?!&|{;\[]/.test(pc)) continue; // division — ignore
      { // regex literal — skip to its end
        let q = k + 1, qc = false, cls = false;
        for (; q < src.length; q++) {
          const cc = src[q];
          if (qc) { qc = false; continue; }
          if (cc === '\\') { qc = true; continue; }
          if (cc === '[') cls = true;
          else if (cc === ']') cls = false;
          else if (cc === '/' && !cls) break;
        }
        k = q; continue;
      }
    }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const ROOT = path.join(__dirname, '..');
const BG = path.join(ROOT, 'chrome-extension', 'background.js');

const lib = new Function(
  'KEY_STATE_TTL_MS',
  grab(BG, 'matchesFileType') + '\n' +
  grab(BG, 'isExcludedSite') + '\n' +
  grab(BG, 'keyFresh') + '\n' +
  grab(BG, 'shouldTakeOver') + '\n' +
  'return { matchesFileType, isExcludedSite, keyFresh, shouldTakeOver };'
)(4000);

const { matchesFileType, isExcludedSite, keyFresh, shouldTakeOver } = lib;
const TYPES = ['exe', 'zip', 'mp3', 'mp4', 'pdf'];

// ── matchesFileType ────────────────────────────────────────────────────────
check('exe matches', matchesFileType('https://cdn.example.com/a/setup.EXE', TYPES) === true);
check('mp4 with query matches', matchesFileType('https://cdn.example.com/v/clip.mp4?tok=1', TYPES) === true);
check('html does not match', matchesFileType('https://example.com/page.html', TYPES) === false);
check('extensionless does not match', matchesFileType('https://example.com/get_file/abc', TYPES) === false);
check('empty list matches nothing', matchesFileType('https://cdn.example.com/a.zip', []) === false);
check('garbage URL is safe', matchesFileType('not a url', TYPES) === false);

// ── isExcludedSite ─────────────────────────────────────────────────────────
check('exact host excluded', isExcludedSite('https://intranet.local/file.zip', ['intranet.local']) === true);
check('subdomain excluded', isExcludedSite('https://dl.intranet.local/f.zip', ['intranet.local']) === true);
check('suffix lookalike NOT excluded',
  isExcludedSite('https://notintranet.local/f.zip', ['intranet.local']) === false);
check('other host not excluded', isExcludedSite('https://example.com/f.zip', ['intranet.local']) === false);
check('empty list excludes nothing', isExcludedSite('https://example.com/f.zip', []) === false);

// ── keyFresh ───────────────────────────────────────────────────────────────
check('fresh key counts', keyFresh(Date.now() - 1000, Date.now()) === true);
check('stale key expired', keyFresh(Date.now() - 30000, Date.now()) === false);
check('zero timestamp never fresh', keyFresh(0, Date.now()) === false);

// ── shouldTakeOver ─────────────────────────────────────────────────────────
const NOW = Date.now();
const base = {
  browserIntegration: true, interceptAll: true,
  interceptFileTypes: TYPES, excludedSites: [], preventAt: 0, forceAt: 0, nowMs: NOW,
};
check('default takes everything', shouldTakeOver('https://example.com/page.html', base) === true);
check('integration off takes nothing',
  shouldTakeOver('https://example.com/a.zip', { ...base, browserIntegration: false }) === false);
check('excluded site left to Chrome',
  shouldTakeOver('https://intranet.local/a.zip', { ...base, excludedSites: ['intranet.local'] }) === false);
check('Alt-prevent wins over everything',
  shouldTakeOver('https://example.com/a.zip', { ...base, preventAt: NOW - 500 }) === false);
check('force key takes even unlisted types',
  shouldTakeOver('https://example.com/page.html',
    { ...base, interceptAll: false, forceAt: NOW - 500 }) === true);
check('restricted mode takes listed types',
  shouldTakeOver('https://cdn.example.com/a.zip', { ...base, interceptAll: false }) === true);
check('restricted mode skips unlisted types',
  shouldTakeOver('https://example.com/page.html', { ...base, interceptAll: false }) === false);
check('stale force key does not stick',
  shouldTakeOver('https://example.com/page.html',
    { ...base, interceptAll: false, forceAt: NOW - 60000 }) === false);

// ── wiring: interception is actually consulted ─────────────────────────────
{
  const bgSrc = fs.readFileSync(BG, 'utf8');
  check('downloads-API interception consults shouldTakeOver',
    /shouldTakeOver\(targetUrl, \{/.test(bgSrc));
  check('content script reports key-state + reads force key',
    fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8').includes("action: 'key-state'"));
  check('background answers key-state + get-settings',
    /action === 'key-state'/.test(bgSrc) && /action === 'get-settings'/.test(bgSrc));
}

console.log(`\ninterception: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
