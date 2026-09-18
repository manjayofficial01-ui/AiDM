// Regression harness for the Facebook "99+ video download links" explosion.
// Exercises the SHIPPED dedup key from all three extension files (extracted
// from source, not copied) and asserts content/background/popup agree AND that
// per-request token rotation (efg.bhak / oh / oe / bytestart / vs / _nc_*) no
// longer creates a new row per player re-fetch.
const fs = require('fs');
const path = require('path');

function grab(srcFile, name) {
  const src = fs.readFileSync(srcFile, 'utf8');
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in ' + srcFile);
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
    // comments FIRST — the shipped functions contain braces & apostrophes in prose
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && /[(,=:?!&|{;\[]/.test(src[k - 1] || '(')) { inRe = true; continue; }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

function loadImpl(rel, names) {
  const code = names.map(n => grab(path.join(__dirname, '..', rel), n)).join('\n');
  const fn = new Function('atob', code + '\nreturn ' + names[names.length - 1] + ';');
  return (u) => fn(typeof atob !== 'undefined' ? atob : require('node:buffer').atob)(u);
}

// names per file — last name is the exported key builder
const contentKey = loadImpl(path.join('chrome-extension', 'content.js'), ['fbCanonicalHost', 'fbEfgTag', 'fbFileKey']);
const bgKey = loadImpl(path.join('chrome-extension', 'background.js'), ['fbCanonicalHost', 'fbEfgTag', 'fbFileKey']);
const popupKey = loadImpl(path.join('chrome-extension', 'popup.js'), ['fbCanonHostInline', 'fbEfgTagInline', 'fbKeyInline']);
const dmKey = loadImpl(path.join('src', 'download-manager.js'), ['fbCanonicalHost', 'fbEfgTag', 'fbFileKey']);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const efgB64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// One real-shaped progressive MP4 URL. `rot` changes on EVERY player request.
function fbUrl(host, pathPart, tag, rot, opts) {
  o = opts || {};
  const q = new URLSearchParams({
    ccb: '16-1',
    efg: o.rawEfg ? JSON.stringify(tag) : efgB64(Object.assign({ vrt: 40960464216783, bhak: '/AZ' + rot, pcv: 200 }, tag)),
    _nc_cat: String(100 + rot % 7), _nc_sid: '0', _nc_ohc: 'ohc' + rot, _nc_ht: host,
    oh: 'hash' + rot, oe: '5E' + (1000 + rot), vh: 'vh' + rot, vs: '1798796466_' + rot,
  });
  if (o.bytestart != null) q.set('bytestart', String(o.bytestart));
  if (o.extra) for (const [k, v] of Object.entries(o.extra)) q.set(k, v);
  return 'https://' + host + pathPart + '?' + q.toString();
}

const keys3 = (u) => [contentKey(u), bgKey(u), popupKey(u)];

// ── 1. THE BUG: same rendition, 20 player re-fetches with rotating bhak/oh/oe/bytestart/vs
const reurls = [];
for (let i = 0; i < 20; i++) {
  reurls.push(fbUrl('video-lAX4-1.xx.fbcdn.net', '/o1/0/mp4/1234/ABC_hd.mp4', { itag: 607 }, i,
    { bytestart: i * 500000 }));
}
const k1 = new Set(reurls.map(contentKey));
check('20 re-fetches of ONE rendition collapse to 1 row', k1.size === 1, 'rows=' + k1.size);

// ── 2. video-* and scontent-* edges carry the SAME file → one row
const both = [
  fbUrl('video-lAX4-1.xx.fbcdn.net', '/o1/0/mp4/1234/ABC_hd.mp4', { itag: 110 }, 1, {}),
  fbUrl('scontent-lAX4-1.xx.fbcdn.net', '/o1/0/mp4/1234/ABC_hd.mp4', { itag: 110 }, 2, {}),
];
check('video-* and scontent-* edges of same path dedup', new Set(both.map(contentKey)).size === 1);

// ── 3. DIFFERENT renditions must STAY distinct (same path, different itag)
const itagA = fbUrl('video-x.xx.fbcdn.net', '/v/t59.4756-21/999_n.mp4', { itag: 110 }, 1, {});
const itagB = fbUrl('video-x.xx.fbcdn.net', '/v/t59.4756-21/999_n.mp4', { itag: 607 }, 1, {});
check('different itag = different row', contentKey(itagA) !== contentKey(itagB));

// ── 4. different encode_tag must stay distinct
const e1 = fbUrl('video-x.xx.fbcdn.net', '/o1/a.mp4', { encode_tag: 'dash_svv_default_copy' }, 1, {});
const e2 = fbUrl('video-x.xx.fbcdn.net', '/o1/a.mp4', { encode_tag: 'vp9_av1_hdt2s' }, 1, {});
check('different encode_tag = different row', contentKey(e1) !== contentKey(e2));

// ── 5. raw-JSON efg form and base64url form of the same rendition → same key
const raw = fbUrl('video-x.xx.fbcdn.net', '/o1/a.mp4', { itag: 607 }, 3, { rawEfg: true });
const b64 = fbUrl('video-x.xx.fbcdn.net', '/o1/a.mp4', { itag: 607 }, 4, {});
check('raw-JSON and base64url efg forms dedup', contentKey(raw) === contentKey(b64));

// ── 6. hd_src/sd_src: one path, quality ONLY in vabr (no efg) → two rows
const mkNoEfg = (vabr) => 'https://video-x.xx.fbcdn.net/o1/n/555_n.mp4?oh=a&oe=b&vabr=' + vabr;
check('vabr separates *_n.mp4 HD/SD when efg absent', contentKey(mkNoEfg('2800')) !== contentKey(mkNoEfg('900')));
const rotVabr = [mkNoEfg('2800'), 'https://video-x.xx.fbcdn.net/o1/n/555_n.mp4?oh=Z&oe=9&vabr=2800'];
check('same vabr re-fetch dedups', new Set(rotVabr.map(contentKey)).size === 1);

// ── 7. unparseable efg must not crash (falls back to raw value)
try {
  const bad = contentKey('https://video-x.xx.fbcdn.net/o1/a.mp4?efg=%25%2F%2Fnot-b64%25&oh=1');
  check('garbage efg handled', typeof bad === 'string' && bad.length > 0);
} catch (e) { check('garbage efg handled', false, e.message); }

// ── 8. all four shipped implementations agree on every URL
const corpus = [...reurls, ...both, itagA, itagB, e1, e2, raw, b64, ...rotVabr];
const agree = corpus.every(u => { const [a, b, c, d] = keys3(u).concat(dmKey(u)); return a && a === b && b === c && c === d; });
check('content/background/popup/download-manager keys byte-identical', agree);

// ── 9. end-to-end simulation: 8 qualities × 12 refetches during playback
const simulated = new Set();
for (let q = 0; q < 8; q++) {
  for (let r = 0; r < 12; r++) {
    simulated.add(contentKey(fbUrl('video-x' + r + '.xx.fbcdn.net', '/o1/0/mp4/77/rend' + q + '.mp4',
      { itag: 100 + q }, r * 8 + q, { bytestart: r * 1000 })));
  }
}
check('96 requests → ≤8 rows (was 96 → "99+")', simulated.size === 8, 'rows=' + simulated.size);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
