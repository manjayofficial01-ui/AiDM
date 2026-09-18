// Regression harness for "downloaded but no video" on Facebook:
// one playing video offers N rows (e.g. 16× "720p · 1076x1077") that all
// COMPLETE at 100% yet contain nothing playable — DASH audio slices served
// as .mp4 (40KB–3MB) and sub-second preview clips.
//
// Fixes (presentation layer only; URL keys untouched):
//   1. dropVideoCandidate policy shared by capsule (sniffed Content-Type +
//      probed track/duration/size), desktop-bound payload, and popup:
//      audio-typed and probed trackless/sub-second-tiny files are dropped
//      instead of offered.
//   2. Honest empty state: blob-playing video + tab DASH-segment traffic +
//      zero direct files renders a "DASH / Protected stream" row instead of
//      junk (or a bare spinner).
//
// SHIPPED definitions are extracted (not copied); parity across the three
// copies is asserted. Run: node test/facebook-junk.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

function grabShipped(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in shipped source');
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
      let p = k - 1;
      while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
      const pc = p >= 0 ? src[p] : '(';
      if (!/[(,=:?!&|{;\[]/.test(pc)) continue;
      let q = k + 1, qc = false, cls = false;
      for (; q < src.length; q++) {
        const cc = src[q];
        if (qc) { qc = false; continue; }
        if (cc === '\\') { qc = true; continue; }
        if (cc === '[') cls = true;
        else if (cc === ']') cls = false;
        else if (cc === '/' && !cls) break;
        else if (cc === '\n') break;
      }
      k = q; continue;
    }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const ROOT = path.join(__dirname, '..');
const ctSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
const popSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');

const ctDrop = new Function(grabShipped(ctSrc, 'dropVideoCandidate') + '\nreturn dropVideoCandidate;')();
const bgDrop = new Function(grabShipped(bgSrc, 'dropVideoCandidate') + '\nreturn dropVideoCandidate;')();
const popDrop = new Function(
  grabShipped(popSrc, 'dropVideoCandidateInline') + '\nreturn dropVideoCandidateInline;')();
const bgDash = new Function(
  'DASH_ACTIVE_TTL_MS',
  grabShipped(bgSrc, 'isDashSignalUrl') + '\n' +
  grabShipped(bgSrc, 'noteDashActive') + '\n' +
  grabShipped(bgSrc, 'isDashActiveTab') + '\n' +
  'return { isDashSignalUrl, noteDashActive, isDashActiveTab };'
)(5 * 60 * 1000);

// ── 1. drop policy ─────────────────────────────────────────────────────────
check('audio content-type drops (unprobed)',
  ctDrop({ contentType: 'audio/mp4' }) === 'audio');
check('audio content-type case-insensitive',
  ctDrop({ contentType: 'Audio/MPEG' }) === 'audio');
check('probed trackless file drops',
  ctDrop({ contentType: 'video/mp4', probed: true, hasVideo: false, durationSec: 30, sizeBytes: 1 << 20 }) === 'audio');
check('sub-second tiny preview drops',
  ctDrop({ probed: true, hasVideo: true, durationSec: 0.5, sizeBytes: 40960 }) === 'preview');
check('real video kept',
  ctDrop({ contentType: 'video/mp4', probed: true, hasVideo: true, durationSec: 215, sizeBytes: 1 << 28 }) === null);
check('unknown file kept (fail-open)',
  ctDrop({}) === null && ctDrop(null) === null && ctDrop({ contentType: 'video/mp4' }) === null);
check('short but sizable file kept (needs both signals)',
  ctDrop({ probed: true, hasVideo: true, durationSec: 1.2, sizeBytes: 5 << 20 }) === null);
check('long audio-kept? no — trackless always drops',
  ctDrop({ probed: true, hasVideo: false, durationSec: 0, sizeBytes: 0 }) === 'audio');

// ── 2. parity across copies ────────────────────────────────────────────────
{
  const corpus = [
    { contentType: 'audio/mp4' },
    { contentType: 'video/mp4', probed: true, hasVideo: false, durationSec: 10, sizeBytes: 5000 },
    { contentType: 'video/mp4', probed: true, hasVideo: true, durationSec: 0.4, sizeBytes: 40960 },
    { contentType: 'video/mp4', probed: true, hasVideo: true, durationSec: 200, sizeBytes: 1 << 28 },
    {},
    { contentType: 'application/octet-stream' },
  ];
  const agree = corpus.every(o =>
    ctDrop(o) === bgDrop(o) && bgDrop(o) === popDrop(o));
  check('content/background/popup drop verdicts identical', agree);
}

// ── 3. DASH signals ────────────────────────────────────────────────────────
check('m4s/init/mpd/dash-path detected',
  bgDash.isDashSignalUrl('https://cdn.example/seg-12.m4s?x=1') === true &&
  bgDash.isDashSignalUrl('https://cdn.example/v/init.mp4') === true &&
  bgDash.isDashSignalUrl('https://cdn.example/v/stream.mpd') === true &&
  bgDash.isDashSignalUrl('https://cdn.example/dash/seg/3') === true);
check('progressive mp4 is not a dash signal',
  bgDash.isDashSignalUrl('https://s45.bigcdn.cc/pubs/abc/1080.mp4') === false &&
  bgDash.isDashSignalUrl('https://example.com/page') === false &&
  bgDash.isDashSignalUrl(null) === false);
{
  const store = new Map();
  check('inactive tab by default', bgDash.isDashActiveTab(store, 9) === false);
  bgDash.noteDashActive(store, 9);
  check('noted tab active', bgDash.isDashActiveTab(store, 9) === true);
  check('other tab unaffected', bgDash.isDashActiveTab(store, 10) === false);
  store.set(9, Date.now() - 10 * 60 * 1000);
  check('stale activity expires', bgDash.isDashActiveTab(store, 9) === false);
  bgDash.noteDashActive(null, -1);
  check('bad input safe', true);
}

// ── 4. wiring ──────────────────────────────────────────────────────────────
check('capsule drops audio-typed candidates',
  /dropVideoCandidate\(\{ contentType: nm && nm\.contentType \}\)/.test(ctSrc));
check('capsule drops probed junk rows + refreshes counts',
  /dropVideoCandidate\(\{\s*contentType: null,/.test(ctSrc) && /dropRow\(v, row\)/.test(ctSrc));
check('capsule shows protected row when stranded',
  /aidm-cap-dashlock/.test(ctSrc) && /Protected stream — no direct file to download/.test(ctSrc) &&
  /pdDashActive/.test(ctSrc) && /hasBlobSource\(video\)/.test(ctSrc));
check('probe reports duration for preview detection',
  /durationSec/.test(ctSrc));
check('background tracks dash traffic + flags panel data',
  /isDashSignalUrl\(details\.url\)/.test(bgSrc) && /dashActive: isDashActiveTab/.test(bgSrc));
check('background drops audio variants before the picker',
  /dropVideoCandidate\(\{ contentType: mm && mm\.contentType \}\)/.test(bgSrc));
check('popup drops audio variants',
  /dropVideoCandidateInline\(\{ contentType: ct \}\)/.test(popSrc));

console.log(`\nfacebook-junk: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
