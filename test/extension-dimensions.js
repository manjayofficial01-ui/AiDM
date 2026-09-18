// Regression: the extension must NOT stamp the playing <video> element's
// intrinsic size onto every variant it reports.
//
// One <video> exposes several <source> variants (360p / 720p / 1080p). Writing
// `video.videoWidth` onto all of them produced N rows with one identical
// resolution — the reported "every downloadable video shows the same
// dimension" bug. It is worse on DASH/MSE players, where videoWidth is the
// CURRENT rendition and changes as the stream adapts.
//
// The rule now: the element's intrinsic size belongs only to the variant that
// element is actually playing. Everything else stays unknown, and the desktop
// app proves real geometry from the file afterwards (src/media-probe.js).
//
// SHIPPED definitions are extracted (not copied), following the grabber.js
// pattern. Run: node test/extension-dimensions.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// Extract a shipped function by brace matching (identical to grabber.js).
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
const CONTENT = path.join(ROOT, 'chrome-extension', 'content.js');
const ctSrc = fs.readFileSync(CONTENT, 'utf8');

// Reuse the shipped QUALITY_MAP literal.
const qmM = /const QUALITY_MAP = \{([\s\S]*?)\n  \};/.exec(ctSrc);
if (!qmM) throw new Error('QUALITY_MAP literal not found in content.js');
const QUALITY_MAP = new Function('return {' + qmM[1] + '};')();

// Reuse the shipped segment-detection regex too.
const segM = /const SEGMENT_RE = (\/.*?\/[a-z]*);/.exec(ctSrc);
if (!segM) throw new Error('SEGMENT_RE literal not found in content.js');
const SEGMENT_RE = new Function('return ' + segM[1] + ';')();

const lib = new Function(
  'QUALITY_MAP', 'SEGMENT_RE', 'blobToRealUrlMap', 'TWIMG_RE', 'isTwitterMp4Url',
  'isTwitterPlaylistUrl', 'isTwitterPage', 'scopedTwitterUrls',
  'globalTwitterMp4s', 'interceptedMediaUrls', 'detectedVideos',
  'isPlayingVideo', 'isActuallyPlaying', 'performance', 'document', 'window',
  'probeSizeAsync',
  grab(CONTENT, 'normalizeStreamUrl') + '\n' +
  grab(CONTENT, 'isSegmentUrl') + '\n' +
  grab(CONTENT, 'detectQuality') + '\n' +
  grab(CONTENT, 'qualityFromHeight') + '\n' +
  grab(CONTENT, 'getVideoVariants') + '\n' +
  grab(CONTENT, 'scanVideoElements') + '\n' +
  'return { getVideoVariants, scanVideoElements };'
)(
  QUALITY_MAP,
  SEGMENT_RE,
  new Map(),                // blobToRealUrlMap
  /^$/,                     // TWIMG_RE — never matches
  () => true,               // isTwitterMp4Url
  () => false,              // isTwitterPlaylistUrl
  () => false,              // isTwitterPage
  () => [],                 // scopedTwitterUrls
  () => [],                 // globalTwitterMp4s
  [],                       // interceptedMediaUrls
  new Map(),                // detectedVideos
  () => false,              // isPlayingVideo
  () => false,              // isActuallyPlaying
  { getEntriesByName: () => [] }, // performance
  { querySelectorAll: () => [] }, // document (replaced per-test below)
  { location: { origin: 'https://cdn.example.com' } }, // window
  () => {}                      // probeSizeAsync (async size probe; irrelevant
);

// Minimal DOM surface: detectQuality reads dataset + data-* attributes.
function fakeEl(extra) {
  return Object.assign({
    dataset: {},
    getAttribute: () => null,
    hasAttribute: () => false,
    closest: () => null,
    tagName: 'VIDEO',
  }, extra);
}

// Build a fake <video>: playing `cur` at 1920x1080, offering `sources`.
function makeVideo(cur, sources) {
  return fakeEl({
    src: cur,
    currentSrc: cur,
    videoWidth: 1920,
    videoHeight: 1080,
    querySelectorAll: (sel) =>
      (sel === 'source'
        ? sources.map(s => fakeEl({ src: s, tagName: 'SOURCE' }))
        : []),
  });
}

// ── 1. URLs with no resolution hint ─────────────────────────────────────────
// Three DIFFERENT files. Before the fix all three reported 1920x1080.
console.log('── 1. unlabeled URLs: element size only on the playing variant ──');
{
  const cur = 'https://cdn.example.com/get_file/5/?id=cur';
  const v = makeVideo(cur, [
    'https://cdn.example.com/get_file/5/?id=variant-a',
    'https://cdn.example.com/get_file/5/?id=variant-b',
  ]);
  const out = lib.getVideoVariants(v);
  check('three distinct variants reported', out.length === 3, `${out.length} rows`);

  const playing = out.filter(r => r.url === cur)[0];
  const siblings = out.filter(r => r.url !== cur);

  check('playing variant uses the element size',
    playing && playing.resolution === '1920x1080', playing && playing.resolution);
  check('sibling variants are NOT stamped with it',
    siblings.length === 2 && siblings.every(r => !r.resolution),
    siblings.map(r => r.resolution).join(','));
  check('no two variants share a fabricated resolution',
    new Set(out.map(r => r.resolution)).size === out.length ||
    siblings.every(r => !r.resolution));
}

// ── 2. URLs that DO encode a resolution must keep their own values ──────────
console.log('── 2. URL-derived resolutions survive and differ ──');
{
  const cur = 'https://cdn.example.com/v/1080.mp4';
  const v = makeVideo(cur, [
    'https://cdn.example.com/v/360.mp4',
    'https://cdn.example.com/v/720.mp4',
  ]);
  const out = lib.getVideoVariants(v);
  const byUrl = Object.fromEntries(out.map(r => [r.url, r.resolution]));
  check('360p variant keeps 640x360', byUrl['https://cdn.example.com/v/360.mp4'] === '640x360',
    byUrl['https://cdn.example.com/v/360.mp4']);
  check('720p variant keeps 1280x720', byUrl['https://cdn.example.com/v/720.mp4'] === '1280x720',
    byUrl['https://cdn.example.com/v/720.mp4']);
  check('1080p variant keeps 1920x1080', byUrl[cur] === '1920x1080', byUrl[cur]);
  check('all three differ (the original bug reported one value)',
    new Set(Object.values(byUrl)).size === 3);
}

// ── 3. scanVideoElements obeys the same rule ────────────────────────────────
console.log('── 3. scanVideoElements: same rule ──');
{
  const cur = 'https://cdn.example.com/get_file/9/?id=cur';
  const v = makeVideo(cur, ['https://cdn.example.com/get_file/9/?id=other']);
  const doc = { querySelectorAll: () => [v] };
  // scanVideoElements reads `document` as a free variable; bind a stub.
  const scan = new Function('document', 'QUALITY_MAP', 'blobToRealUrlMap', 'window', 'probeSizeAsync',
    grab(CONTENT, 'normalizeStreamUrl') + '\n' +
    grab(CONTENT, 'detectQuality') + '\n' +
    grab(CONTENT, 'qualityFromHeight') + '\n' +
    grab(CONTENT, 'scanVideoElements') + '\n' +
    'return scanVideoElements;'
  )(doc, QUALITY_MAP, new Map(), { location: { origin: 'https://cdn.example.com' } }, () => {});

  const out = scan();
  const playing = out.filter(r => r.url === cur)[0];
  const others = out.filter(r => r.url !== cur);
  check('playing source gets the element size',
    playing && playing.resolution === '1920x1080', playing && playing.resolution);
  check('other candidates left unknown',
    others.length > 0 && others.every(r => !r.resolution),
    others.map(r => r.resolution).join(',') || 'none');
}

// ── 4. Source-level guard: the unguarded stamp must not come back ───────────
console.log('── 4. no unguarded element-size stamp in shipped source ──');
check('no bare `if (video.videoWidth && video.videoHeight)` overwrite',
  !/if\s*\(\s*video\.videoWidth\s*&&\s*video\.videoHeight\s*\)\s*\{/.test(ctSrc));
check('no bare `if (v.videoWidth && v.videoHeight)` overwrite',
  !/if\s*\(\s*v\.videoWidth\s*&&\s*v\.videoHeight\s*\)\s*\{/.test(ctSrc));
check('extension version matches the app',
  JSON.parse(fs.readFileSync(path.join(ROOT, 'chrome-extension', 'manifest.json'), 'utf8')).version ===
  JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);

console.log(`\nextension-dimensions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
