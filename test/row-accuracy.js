// Regression harness for two row-accuracy bugs:
//   1. TWITTER same-dimensions: variant URLs that encode no rendition
//      (amplify_video links, bare CDN hashes) all displayed the PLAYING
//      element's size, so truly different dimensions read identically
//      (e.g. five rows of "1440p · 3412x1970"). Rows without authoritative
//      geometry now read each file's own metadata and refresh in place,
//      and Download sends the refreshed values.
//   2. FACEBOOK wrong-video download: hard per-video filtering could hide
//      the right video when blob attribution guessed wrong. Candidates are
//      now RANKED (this video first, rest under a divider) — never dropped.
//
// SHIPPED needsMetaProbe is extracted (not copied); the rest is asserted as
// shipped patterns. Run: node test/row-accuracy.js
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
const popSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');

const needsMetaProbe = new Function(
  grabShipped(ctSrc, 'needsMetaProbe') + '\nreturn needsMetaProbe;'
)();

// ── 1. probe gate: only unreadable-geometry direct video files ─────────────
check('mp4 without resolution needs probing',
  needsMetaProbe('https://video.twimg.com/amplify_video/123/vid.mp4', false) === true);
check('mp4 with resolution skips probing',
  needsMetaProbe('https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4', true) === false);
check('bare mp4 probes even with unknown flag',
  needsMetaProbe('https://cdn.example.com/v/abc.mp4', false) === true);
check('playlists never probe',
  needsMetaProbe('https://cdn.example.com/v/x.m3u8', false) === false &&
  needsMetaProbe('https://cdn.example.com/v/x.mpd', false) === false);
check('non-files never probe',
  needsMetaProbe('https://example.com/page', false) === false &&
  needsMetaProbe('blob:https://x.com/1', false) === false &&
  needsMetaProbe(null, false) === false);

// ── 2. capsule refreshes rows + sends live values ──────────────────────────
check('row tracks whether geometry is authoritative',
  /hadAuthoritativeRes/.test(ctSrc));
check('probe queue is bounded per panel',
  /META_PROBE_MAX_ROWS/.test(ctSrc) && /metaProbeRuns\.length < META_PROBE_MAX_ROWS/.test(ctSrc));
check('probed rows repaint badge + meta + filename source',
  /liveName = refreshName\(\)/.test(ctSrc));
check('Download sends live quality/resolution/filename',
  /const sendQual =/.test(ctSrc) && /const sendRes = v\.resolution \|\| res \|\| null/.test(ctSrc) &&
  /sanitizeFilename\(\s*liveName,/.test(ctSrc));
check('metadata probe is cached + time-boxed',
  /metaProbeCache/.test(ctSrc) && /preload = 'metadata'/.test(ctSrc));

// ── 3. facebook ranked sections (nothing hidden) ───────────────────────────
check('candidates are tagged, never dropped, for ranking',
  /v\._fbScope = \(!fbScope \|\| !fbScope\.size\) \? 'all'/.test(ctSrc));
check('no hard scope-drop remains in pushCand',
  !/if \(useFbScope && !fbScopeAllows\(v\.url, fbScope\)\) return;/.test(ctSrc));
check('mine-first + others divider rendering',
  /mineRows/.test(ctSrc) && /otherRows/.test(ctSrc) &&
  /aidm-cap-sep/.test(ctSrc) && /Other videos on this page/.test(ctSrc));
check('sub-line reports the split',
  /this video/.test(ctSrc));

// ── 4. popup parity ────────────────────────────────────────────────────────
check('popup probes dimension-less twitter mp4s',
  /probePopupMeta\(item\.url\)/.test(popSrc) && /POPUP_META_PROBE_MAX/.test(popSrc));
check('popup refreshes badges in place',
  /metaBadgesHtml\(item\)/.test(popSrc));
check('popup Download already sends live item fields',
  /quality: item\.quality/.test(popSrc) && /resolution: item\.resolution/.test(popSrc));

console.log(`\nrow-accuracy: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
