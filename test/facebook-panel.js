// Regression harness for the Facebook "72 downloadable links" panel explosion
// (all identical 1080P rows for one playing video).
//
// Two compounding causes, fixed without touching the URL-level dedup keys
// (normalizeStreamUrl / fbFileKey / sent tracking and every fb-dedup.js
// assertion stay exactly as they were):
//   1. Same-file re-requests with rotated tokens (vabr/rl/oh/oe churn per
//      player poll) produced distinct keys → distinct rows. The presentation
//      layer now collapses on canonical path + rendition tag + quality +
//      resolution + size (test Collapse section).
//   2. Feed/watch pages hold EVERY related video's URLs and the panel merged
//      them into every pill. The panel (and badge) now scope to the playing
//      video's own path family when attributable, falling back to global
//      otherwise (test Scope section).
//
// SHIPPED definitions are extracted from content.js / background.js /
// popup.js (not copied); parity across the three copies is asserted.
// Run: node test/facebook-panel.js
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

function constSetLiteral(src, constName) {
  const m = new RegExp('const ' + constName + ' = new Set\\(\\[([\\s\\S]*?)\\]\\);').exec(src);
  if (!m) throw new Error(constName + ' literal not found');
  return new Function('return new Set([' + m[1] + ']);')();
}

function constRegexLiteral(src, constName) {
  const m = new RegExp('const ' + constName + ' = (\\/.*?\\/i);').exec(src);
  if (!m) throw new Error(constName + ' literal not found');
  return eval(m[1]);
}

const ROOT = path.join(__dirname, '..');
const ctSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
const popSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');

// ── content.js scope ───────────────────────────────────────────────────────
const ct = new Function(
  'FB_HOST_RE', 'TOKEN_PARAMS',
  grabShipped(ctSrc, 'fbCanonicalHost') + '\n' +
  grabShipped(ctSrc, 'fbEfgTag') + '\n' +
  grabShipped(ctSrc, 'fbFileKey') + '\n' +
  grabShipped(ctSrc, 'normalizeStreamUrl') + '\n' +
  grabShipped(ctSrc, 'fbPathKey') + '\n' +
  grabShipped(ctSrc, 'fbEfgTagOfUrl') + '\n' +
  grabShipped(ctSrc, 'collapseRowKey') + '\n' +
  grabShipped(ctSrc, 'mergeRowInto') + '\n' +
  grabShipped(ctSrc, 'fbScopeAllows') + '\n' +
  'return { fbPathKey, fbEfgTagOfUrl, collapseRowKey, mergeRowInto, fbScopeAllows };'
)(constRegexLiteral(ctSrc, 'FB_HOST_RE'), constSetLiteral(ctSrc, 'TOKEN_PARAMS'));

// ── background.js scope ────────────────────────────────────────────────────
const bg = new Function(
  'FB_HOST_RE', 'TOKEN_PARAMS',
  grabShipped(bgSrc, 'fbCanonicalHost') + '\n' +
  grabShipped(bgSrc, 'fbEfgTag') + '\n' +
  grabShipped(bgSrc, 'fbFileKey') + '\n' +
  grabShipped(bgSrc, 'normalizeSentUrl') + '\n' +
  grabShipped(bgSrc, 'fbPathKey') + '\n' +
  grabShipped(bgSrc, 'fbEfgTagOfUrl') + '\n' +
  grabShipped(bgSrc, 'collapseRowKey') + '\n' +
  grabShipped(bgSrc, 'collapseVideoRows') + '\n' +
  'return { fbPathKey, fbEfgTagOfUrl, collapseRowKey, collapseVideoRows };'
)(constRegexLiteral(bgSrc, 'FB_HOST_RE'), constSetLiteral(bgSrc, 'TOKEN_PARAMS'));

// ── popup.js scope ─────────────────────────────────────────────────────────
const pop = new Function(
  'FB_INLINE_RE', 'TOKEN_KEYS',
  grabShipped(popSrc, 'fbCanonHostInline') + '\n' +
  grabShipped(popSrc, 'fbEfgTagInline') + '\n' +
  grabShipped(popSrc, 'fbKeyInline') + '\n' +
  grabShipped(popSrc, 'normalizeInline') + '\n' +
  grabShipped(popSrc, 'fbPathKeyInline') + '\n' +
  grabShipped(popSrc, 'fbEfgTagOfUrlInline') + '\n' +
  grabShipped(popSrc, 'collapseRowKeyInline') + '\n' +
  'return { fbPathKeyInline, collapseRowKeyInline };'
)(
  (function () {
    const m = /const FB_INLINE_RE = (\/.*?\/i);/.exec(popSrc);
    if (!m) throw new Error('FB_INLINE_RE not found');
    return eval(m[1]);
  })(),
  constSetLiteral(popSrc, 'TOKEN_KEYS')
);

// ── fixtures: one file re-requested with churned tokens ────────────────────
const efgB64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const HD = { encode_tag: 'hd_tag', itag: 607 };
const SD = { encode_tag: 'sd_tag', itag: 110 };
function fbProgressive(pathPart, tag, rot, vabr) {
  const q = new URLSearchParams({
    efg: efgB64(Object.assign({ vrt: 1, bhak: '/AZ' + rot }, tag)),
    oh: 'hash' + rot, oe: '5E' + (1000 + rot),
    _nc_ht: 'video.xx.fbcdn.net', _nc_cat: '100', _nc_ohc: 'ohc' + rot,
  });
  if (vabr != null) q.set('vabr', String(vabr));
  return 'https://video-ab1.xx.fbcdn.net' + pathPart + '?' + q.toString();
}
const PATH = '/v/t59.1-2/12345_n.mp4';
const rotA = fbProgressive(PATH, HD, 1, 2800);   // same rendition, poll 1
const rotB = fbProgressive(PATH, HD, 2, 9417);   // same rendition, poll 2 (vabr churned!)
const rendSD = fbProgressive(PATH, SD, 1, 900);  // genuinely different rendition
const otherVideo = fbProgressive('/v/t59.1-2/99999_n.mp4', HD, 1, 2800);
const nonFb = 'https://cdn.example.com/files/clip.mp4?tok=1';

// ── 1. path identity is query-immune ───────────────────────────────────────
check('same file, churned query → same path key',
  ct.fbPathKey(rotA) === ct.fbPathKey(rotB) && ct.fbPathKey(rotA) !== null);
check('different videos → different path keys',
  ct.fbPathKey(rotA) !== ct.fbPathKey(otherVideo));
check('edge pools canonicalize', ct.fbPathKey(rotA) ===
  ct.fbPathKey(rotA.replace('video-ab1.xx.fbcdn.net', 'scontent-ab1.xx.fbcdn.net')));
check('non-Facebook → null path key', ct.fbPathKey(nonFb) === null);

// ── 2. collapse: rotation merges, renditions survive ───────────────────────
function row(url, quality, resolution, size) {
  return { url, quality, resolution, size };
}
check('rotated re-fetch collapses',
  ct.collapseRowKey(row(rotA, '1080p', '1920x1080', 800000)) ===
  ct.collapseRowKey(row(rotB, '1080p', '1920x1080', 800000)));
check('different rendition stays split',
  ct.collapseRowKey(row(rotA, '1080p', '1920x1080', 800000)) !==
  ct.collapseRowKey(row(rendSD, '720p', '1280x720', 400000)));
check('different videos stay split',
  ct.collapseRowKey(row(rotA, '1080p', '1920x1080', 800000)) !==
  ct.collapseRowKey(row(otherVideo, '1080p', '1920x1080', 800000)));
check('unknown-size twins merge (accepted edge: same path+label+res)',
  ct.collapseRowKey(row(rotA, 'unknown', null, null)) ===
  ct.collapseRowKey(row(rotB, 'unknown', null, null)));
check('non-Facebook keeps exact-key semantics',
  ct.collapseRowKey(row(nonFb, 'unknown', null, null)) ===
  ct.collapseRowKey(row(nonFb, 'unknown', null, null)) &&
  ct.collapseRowKey(row(nonFb, 'unknown', null, null)) !==
  ct.collapseRowKey(row('https://cdn.example.com/files/other.mp4', 'unknown', null, null)));

// ── 3. merge fills the kept row ────────────────────────────────────────────
{
  const prev = row(rotA, 'unknown', null, null);
  ct.mergeRowInto(prev, row(rotB, '1080p', '1920x1080', 800000));
  check('merge upgrades label/resolution/size',
    prev.quality === '1080p' && prev.resolution === '1920x1080' && prev.size === 800000);
}

// ── 4. scope gate ──────────────────────────────────────────────────────────
{
  const scope = new Set([ct.fbPathKey(rotA)]);
  check('scope admits same path, rotated query',
    ct.fbScopeAllows(rotB, scope) === true);
  check('scope drops other videos', ct.fbScopeAllows(otherVideo, scope) === false);
  check('scope lets non-Facebook URLs through', ct.fbScopeAllows(nonFb, scope) === true);
  check('empty scope allows everything (fallback)',
    ct.fbScopeAllows(otherVideo, new Set()) === true &&
    ct.fbScopeAllows(otherVideo, null) === true);
}

// ── 5. three-copy parity on a mixed corpus ─────────────────────────────────
{
  const corpus = [
    row(rotA, '1080p', '1920x1080', 800000),
    row(rotB, '1080p', '1920x1080', 800000),
    row(rendSD, '720p', '1280x720', 400000),
    row(otherVideo, '1080p', '1920x1080', 800000),
    row(nonFb, 'unknown', null, null),
    row(rotA, 'unknown', null, null),
  ];
  const agree = corpus.every(v =>
    ct.collapseRowKey(v) === bg.collapseRowKey(v) &&
    bg.collapseRowKey(v) === pop.collapseRowKeyInline(v));
  check('content/background/popup collapse keys identical', agree);
  check('background collapseVideoRows merges rotations to one',
    bg.collapseVideoRows([corpus[0], corpus[1]]).length === 1);
  check('background collapse keeps renditions + videos distinct',
    bg.collapseVideoRows(corpus).length === 5);
}

// ── 6. wiring ──────────────────────────────────────────────────────────────
check('panel gates candidates by scope',
  /fbScopeAllows\(v\.url, fbScope\)/.test(ctSrc));
check('panel collapses rows unconditionally',
  /collapseRowKey\(v\)/.test(ctSrc) && /mergeRowInto\(prev, v\)/.test(ctSrc));
check('badge counts Facebook by path + scopes per video',
  /fbPathKey\(u\) \|\| (mediaPathKey\(u\) \|\| )?normalizeStreamUrl/.test(ctSrc) && /elementFilePaths\(video\)/.test(ctSrc));
check('desktop payload collapses before the picker',
  /collapseVideoRows\(enriched\)/.test(bgSrc));
check('popup collapses in dedupeMedia',
  /collapseRowKeyInline\(m\)/.test(popSrc));

// ── 7. playing-only download list (user: never list not-playing videos) ────
check('playing-only filter is wired into the capsule',
  /filterFacebookPlayingOnly\(rows, video\)/.test(ctSrc));
check('scan/grab/get-videos return playing-only Facebook lists',
  (ctSrc.match(/videosForDownloadList\(\)/g) || []).length >= 4);
check('popup applies the same Facebook playing-only filter',
  /filterFacebookPlayingOnlyInline/.test(popSrc));
check('resolver scopes variants to the page video',
  /filterVariantsToPageVideo/.test(fs.readFileSync(path.join(ROOT, 'src/facebook-resolver.js'), 'utf8')));

{
  // Extract shipped filterFacebookPlayingOnly + helpers with browser stubs.
  const needs = [
    'fbCanonicalHost', 'fbVideoIdOfUrl', 'fbPathKey', 'fbScopeAllows',
    'elementFilePaths', 'facebookPageVideoId', 'fbUrlBelongsToVideoId',
    'playingFbPathKey', 'playingFbVideoId', 'filterFacebookPlayingOnly',
    'isSegmentUrl', 'stripFbRange', 'fbEfgTag', 'fbEfgObj', 'fbFileKey',
    'isFacebookPage', 'isFacebookVideoUrl',
  ];
  const body = needs.map(n => grabShipped(ctSrc, n)).join('\n');
  const locationStub = { hostname: 'www.facebook.com', href: 'https://www.facebook.com/watch/?v=111' };
  const resources = [];
  const performanceStub = { getEntriesByType: () => resources };
  const playingEl = {
    currentSrc: 'blob:https://www.facebook.com/aaaa',
    src: '',
    querySelectorAll: () => [],
    paused: false, ended: false, readyState: 4,
  };
  const filt = new Function(
    'FB_HOST_RE', 'location', 'performance', 'blobToRealUrlMap',
    'isPlayingVideo', 'isActuallyPlaying',
    body + '\nreturn { filterFacebookPlayingOnly, facebookPageVideoId, fbUrlBelongsToVideoId };'
  )(
    constRegexLiteral(ctSrc, 'FB_HOST_RE'),
    locationStub,
    performanceStub,
    new Map([['blob:https://www.facebook.com/aaaa', rotA]]),
    (v) => !!(v && v.paused === false && !v.ended && v.readyState > 2),
    (v) => !!(v && v.paused === false && !v.ended && v.readyState >= 3)
  );

  const playingRow = { url: rotA, playing: true, quality: '1080p' };
  const siblingRow = { url: rendSD, quality: '720p' }; // same path family, no playing flag
  const otherRow = { url: otherVideo, quality: '1080p' };

  const onlyPlaying = filt.filterFacebookPlayingOnly([playingRow, otherRow, siblingRow], playingEl);
  check('playing flag drops other videos, keeps same-path siblings',
    onlyPlaying.some(v => v.url === rotA || v.url === rendSD) &&
    !onlyPlaying.some(v => v.url === otherVideo),
    onlyPlaying.map(v => v.url).join(' | '));

  locationStub.href = 'https://www.facebook.com/watch/?v=111';
  const byPage = filt.filterFacebookPlayingOnly([
    { url: 'https://video.xx.fbcdn.net/v/t/111_hd.mp4?oh=1' },
    { url: 'https://video.xx.fbcdn.net/v/t/999999999_n.mp4?oh=2' },
  ], null);
  check('page id keeps own video, drops related',
    byPage.length === 1 && /111_/.test(byPage[0].url));

  // FAIL-OPEN: blob+MSE progressive URLs often carry no page id in the path.
  // A playing <video> must still get those links — never an empty panel.
  locationStub.href = 'https://www.facebook.com/watch/?v=111';
  const unattr = filt.filterFacebookPlayingOnly([
    { url: 'https://video.xx.fbcdn.net/v/t42.9040-2/abcdef_n.mp4?oh=1', source: 'facebook' },
    { url: 'https://video.xx.fbcdn.net/v/t/999999999_n.mp4?oh=2' },
  ], playingEl);
  check('playing element keeps unattributable progressive links',
    unattr.some(v => /abcdef_n\.mp4/.test(v.url)) &&
    !unattr.some(v => /999999999/.test(v.url)),
    unattr.map(v => v.url).join(' | '));

  const allUnattr = filt.filterFacebookPlayingOnly([
    { url: 'https://video.xx.fbcdn.net/v/t42.9040-2/aaa_n.mp4', source: 'facebook' },
    { url: 'https://video.xx.fbcdn.net/v/t42.9040-2/bbb_hd.mp4', source: 'facebook' },
  ], playingEl);
  check('fail-open: playing + unattributable rows are never emptied',
    allUnattr.length === 2, 'got ' + allUnattr.length);

  locationStub.href = 'https://www.facebook.com/';
  locationStub.hostname = 'www.facebook.com';
  const feed = filt.filterFacebookPlayingOnly([
    { url: 'https://video.xx.fbcdn.net/v/t/222_n.mp4' },
    { url: 'https://video.xx.fbcdn.net/v/t/333_n.mp4' },
  ], null);
  check('feed with nothing playing lists nothing',
    feed.length === 0, 'got ' + feed.length);

  locationStub.href = 'https://www.facebook.com/watch/?v=111';
  check('page id parser', filt.facebookPageVideoId('https://www.facebook.com/watch/?v=111') === '111');
  check('belongs-to-id via path',
    filt.fbUrlBelongsToVideoId('https://video.xx.fbcdn.net/v/t/111_hd.mp4?oh=a', '111') === true &&
    filt.fbUrlBelongsToVideoId('https://video.xx.fbcdn.net/v/t/999999999_n.mp4?oh=a', '111') === false);
}

console.log(`\nfacebook-panel: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
