// Regression harness for the v4.7.0 generalized per-video scoping.
//
// The capsule/pill previously scoped rows to the playing video only on
// Facebook (fbPathKey family) and Twitter (scopedTwitterUrls); every other
// site merged the page-global registry into EVERY pill — unrelated videos'
// links appeared under the playing video's download options.
//
// v4.7.0 generalizes the FB mechanism: mediaPathKey() is a query-immune
// canonical path family for ANY media URL, and elementMediaKeys() collects
// the playing element's own file paths (blob-resolved). Capsule candidates
// from a different family rank under the "Other videos on this page"
// divider instead of polluting the pill. SHIPPED definitions are extracted
// from content.js (not copied).
// Run: node test/popup-video-scope.js
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
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

function constRegexLiteral(src, constName) {
  const m = new RegExp('const ' + constName + ' = (\\/.*?\\/i);').exec(src);
  if (!m) throw new Error(constName + ' literal not found');
  return eval(m[1]);
}

const ROOT = path.join(__dirname, '..');
const ctSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8');

// MEDIA_PATH_RE is declared with the new functions.
const mpRe = new RegExp('const MEDIA_PATH_RE = (\\/.*?\\/i);').exec(ctSrc);
if (!mpRe) { console.error('MEDIA_PATH_RE not found'); process.exit(1); }

const ct = new Function(
  'FB_HOST_RE', 'MEDIA_PATH_RE', 'blobToRealUrlMap',
  grabShipped(ctSrc, 'fbCanonicalHost') + '\n' +
  grabShipped(ctSrc, 'mediaPathKey') + '\n' +
  grabShipped(ctSrc, 'elementMediaKeys') + '\n' +
  'return { mediaPathKey, elementMediaKeys };'
)(constRegexLiteral(ctSrc, 'FB_HOST_RE'), eval(mpRe[1]), new Map());

// ── 1. mediaPathKey: query-immune path family for any site ──────────────────
const playing = 'https://cdn.mysite.com/media/hls/1080/seg-video.mp4?tok=abc&exp=111';
const rotated = 'https://cdn.mysite.com/media/hls/1080/seg-video.mp4?tok=xyz&exp=222';
const otherVideo = 'https://cdn.mysite.com/media/hls/720/other-clip.mp4?tok=abc';
const pageUrl = 'https://cdn.mysite.com/watch/12345';          // HTML page path
const singleSeg = 'https://cdn.mysite.com/video.mp4?tok=1';    // single segment
const image = 'https://cdn.mysite.com/media/hls/1080/preview.jpg';

check('same file, rotated query → same media path key',
  ct.mediaPathKey(playing) === ct.mediaPathKey(rotated) && ct.mediaPathKey(playing) !== null);
check('different videos → different media path keys',
  ct.mediaPathKey(playing) !== ct.mediaPathKey(otherVideo));
check('HTML page path never keys a family', ct.mediaPathKey(pageUrl) === null);
check('single-segment paths never key a family', ct.mediaPathKey(singleSeg) === null);
check('non-media extensions → null', ct.mediaPathKey(image) === null);
check('garbage URL → null', ct.mediaPathKey('not a url') === null);

// ── 2. elementMediaKeys: blob resolution + own sources ──────────────────────
{
  const blobMap = new Map();
  const blobUrl = 'blob:https://mysite.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  blobMap.set(blobUrl, playing);
  const el = new Function(
    'FB_HOST_RE', 'MEDIA_PATH_RE', 'blobToRealUrlMap',
    grabShipped(ctSrc, 'fbCanonicalHost') + '\n' +
    grabShipped(ctSrc, 'mediaPathKey') + '\n' +
    grabShipped(ctSrc, 'elementMediaKeys') + '\n' +
    'return { elementMediaKeys };'
  )(constRegexLiteral(ctSrc, 'FB_HOST_RE'), eval(mpRe[1]), blobMap);

  const video = {
    currentSrc: blobUrl,
    src: '',
    querySelectorAll: () => [],
  };
  const keys = el.elementMediaKeys(video);
  check('blob currentSrc resolves to the real file family', keys.size === 1 && keys.has(ct.mediaPathKey(playing)));

  const el2 = new Function(
    'FB_HOST_RE', 'MEDIA_PATH_RE', 'blobToRealUrlMap',
    grabShipped(ctSrc, 'fbCanonicalHost') + '\n' +
    grabShipped(ctSrc, 'mediaPathKey') + '\n' +
    grabShipped(ctSrc, 'elementMediaKeys') + '\n' +
    'return { elementMediaKeys };'
  )(constRegexLiteral(ctSrc, 'FB_HOST_RE'), eval(mpRe[1]), blobMap);
  const unmappedBlob = { currentSrc: 'blob:https://mysite.com/1-2-3-4-5', src: '', querySelectorAll: () => [] };
  check('unmapped blob contributes nothing (empty scope → global fallback)',
    el2.elementMediaKeys(unmappedBlob).size === 0);
}

// ── 3. wiring in the capsule + badge paths ──────────────────────────────────
check('capsule builds the generalized scope for non-Facebook pages',
  /const genScope = isFacebookPage\(\) \? null : elementMediaKeys\(video\);/.test(ctSrc));
check('capsule tags out-of-family rows as other',
  /genScope\.has\(k\)\) \? 'all' : 'other'/.test(ctSrc));
check('Facebook keeps its exact fbPathKey scope',
  /fbScopeAllows\(v\.url, fbScope\)/.test(ctSrc));
check('badge generalizes scoping via elementMediaKeys',
  /const scope = elementMediaKeys\(video\);/.test(ctSrc) &&
  /const k = mediaPathKey\(u\);\s*\n\s*return !k \|\| scope\.has\(k\);/.test(ctSrc));
check('badge counts mediaPathKey-keyed URLs too',
  /fbPathKey\(u\) \|\| mediaPathKey\(u\) \|\| normalizeStreamUrl/.test(ctSrc));
// v4.8.1+: Facebook download list is PLAYING-video only — related feed/watch
// links are hard-filtered, never ranked under a divider.
check('Facebook capsule hard-filters to playing video only',
  /filterFacebookPlayingOnly\(rows, video\)/.test(ctSrc));
check('Facebook scan/grab responses use playing-only list',
  /videosForDownloadList\(\)/.test(ctSrc));
check('playing-only helper exists',
  /function filterFacebookPlayingOnly\(/.test(ctSrc) &&
  /function facebookPageVideoId\(/.test(ctSrc));
check('no Facebook "other videos" divider remains',
  !/Other videos on this page/.test(ctSrc));

// ── 4. SPA staleness: new page state cleared on navigation ──────────────────
check('clearPageDetections resets detectedLinks', /detectedLinks = new Set\(\);/.test(ctSrc));
check('clearPageDetections resets twitterVariants', /twitterVariants\.clear\(\);/.test(ctSrc));
check('clearPageDetections resets probe/HLS caches',
  /metaProbeCache\.clear\(\);/.test(ctSrc) && /hlsExpandCache\.clear\(\);/.test(ctSrc));
check('clearPageDetections resets pageScanComplete', /pageScanComplete = false;/.test(ctSrc));

// ── 5. stale page-HTML fetch cannot merge across navigation ─────────────────
check('fetchPageHtmlMedia bails when the page changed mid-flight',
  /if \(location\.href !== pageKey\) return \[\];/.test(ctSrc));

// ── 6. interceptor dedup resets on SPA navigation ───────────────────────────
const itSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'interceptor.js'), 'utf8');
check('interceptor clears sentUrls on pushState/replaceState',
  /sentUrls\.clear\(\);/.test(itSrc) &&
  /history\.pushState = function/.test(itSrc) &&
  /history\.replaceState = function/.test(itSrc));

// ── 7. background per-tab map hygiene ───────────────────────────────────────
const bgSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
check('tab close clears the per-tab maps',
  /tabStreams\.delete\(tabId\);/.test(bgSrc) &&
  /tabNavAt\.delete\(tabId\);/.test(bgSrc) &&
  /tabDashActive\.delete\(tabId\);/.test(bgSrc));
check('resolved caches are TTL-pruned', /pruneResolvedCaches\(\);/.test(bgSrc));

console.log(`\npopup-video-scope: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
