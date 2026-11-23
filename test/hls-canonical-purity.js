// Regression harness for the "badge N · 0 downloadable links" row wipe on
// every NON-HLS site (Facebook / Twitter / progressive-MP4 pages), introduced
// by the HLS family canonicalization integration.
//
// Root cause: canonicalizeHlsFamilies returned its INPUT array when no HLS
// family was present (`if (!families.size) return cands;`). The panel caller
// then does `cands.length = 0; canonical.forEach(v => cands.push(v))` — with
// canonical === cands the clear empties the iteration source, so every row
// vanishes. YouTube (canonical watch row) and HLS-only sites (fresh `out`
// array) were unaffected, which is exactly the reported symptom split.
//
// Exercises the SHIPPED function (extracted from chrome-extension/content.js,
// not copied) plus the SHIPPED caller mutation pattern.
const fs = require('fs');
const path = require('path');

function grab(src, name) {
  let i = src.indexOf('async function ' + name + '(');
  if (i < 0) i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  const j = src.indexOf('{', i);
  let d = 0, inRe = false, inStr = null, esc = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (inRe) {
      if (c === '\\') esc = true;
      else if (c === '/') inRe = false;
      else if (c === '[') { const e = src.indexOf(']', k); if (e > 0) k = e; }
      continue;
    }
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && /[(,=:?!&|{;\[]/.test(src[k - 1] || '(')) { inRe = true; continue; }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const CONTENT = path.join(__dirname, '..', 'chrome-extension', 'content.js');
const src = fs.readFileSync(CONTENT, 'utf8');

// Load the shipped canonicalizer together with its shipped helpers. The
// no-master reconstruction path would need chrome.runtime; every case here
// either has no HLS family or supplies a master, so no messaging happens.
const canonicalizeHlsFamilies = new Function(
  grab(src, 'isHlsMasterUrl') + '\n' +
  grab(src, 'hlsReleaseRootKey') + '\n' +
  grab(src, 'reconstructMasterCandidates') + '\n' +
  grab(src, 'canonicalizeHlsFamilies') + '\n' +
  'return canonicalizeHlsFamilies;'
)();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// The SHIPPED caller pattern (content.js buildCapsulePanel): replace cands
// with the canonical result by clearing then re-pushing.
async function callerPattern(cands) {
  const canonical = await canonicalizeHlsFamilies(cands);
  cands.length = 0;
  canonical.forEach(v => cands.push(v));
  return cands;
}

(async () => {
  // ── 1. the regression: progressive MP4 candidates must survive ────────────
  const mp4 = [
    { url: 'https://video.fbcdn.net/v/t42.1790-2/clip.mp4?efg=abc&_nc_cat=1', quality: '720p' },
    { url: 'https://video.twimg.com/pu/vid/avc1/1280x720/xyz.mp4?tag=14', quality: '720p' },
    // Facebook DASH progressive track: extensionless fbcdn path + byte-slice
    // query — the exact shape the MAIN-world interceptor captures on FB.
    { url: 'https://video.fktm1-1.fna.fbcdn.net/v/t42.1790-2/300000000_1234567890_n?bytestart=0&byteend=999&efg=xyz', quality: 'unknown' },
  ];
  const out = await callerPattern(mp4);
  check('non-HLS candidates survive the caller clear+refill', out.length === 3,
    'got ' + out.length);
  check('urls preserved in order', out[0] && out[0].url === mp4[0].url && out[1] && out[1].url === mp4[1].url);

  // Purity contract: the returned list must never alias the input.
  const input = [{ url: 'https://x.example/v.mp4' }];
  const ret = await canonicalizeHlsFamilies(input);
  check('no-families result does not alias the input array', ret !== input);

  // ── 2. HLS families still collapse to one master per release root ─────────
  // mindgeek shape: every variant hangs off the …/<hash>.mp4/ release root,
  // so hlsReleaseRootKey groups master + variants into ONE family.
  const root = 'https://cdn.example/video/abc.mp4/';
  const hls = [
    { url: root + 'master.m3u8?token=t', quality: 'unknown' },
    { url: root + '720p/playlist.m3u8?token=t', quality: '720p' },
    { url: root + '1080p/playlist.m3u8?token=t', quality: '1080p' },
  ];
  const hout = await callerPattern(hls);
  check('master+variants collapse to ONE master row', hout.length === 1 && /master\.m3u8/.test(hout[0].url),
    'got ' + hout.length);

  // ── 3. mixed page: progressive rows AND an HLS family coexist ──────────────
  const mixed = [
    { url: 'https://video.fbcdn.net/v/clip.mp4?efg=abc', quality: '720p' },
    { url: root + 'master.m3u8?token=t', quality: 'unknown' },
    { url: root + '720p/playlist.m3u8?token=t', quality: '720p' },
  ];
  const mout = await callerPattern(mixed);
  check('mixed page keeps the progressive row AND one master', mout.length === 2 &&
    mout.some(v => /\.mp4/.test(v.url)) && mout.some(v => /master\.m3u8/.test(v.url)),
    'got ' + mout.length);

  // ── 4. empty input stays empty (no throw, no phantom rows) ─────────────────
  const eout = await callerPattern([]);
  check('empty candidate list stays empty', eout.length === 0);

  console.log('\nhls-canonical-purity: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();