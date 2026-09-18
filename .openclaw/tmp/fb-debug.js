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
    if (inStr) { if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (inRe) { if (c === '\\') esc = true; else if (c === '/') inRe = false; else if (c === '[') { const e = src.indexOf(']', k); if (e > 0) k = e; } continue; }
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === String.fromCharCode(34) || c === String.fromCharCode(39) || c === String.fromCharCode(96)) { inStr = c; continue; }
    if (c === '/' && /[(,=:?!&|{;\[]/.test(src[k - 1] || '(')) { inRe = true; continue; }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
function loadImpl(rel, names) {
  const code = names.map(n => grab(path.join('chrome-extension', 'x'), n).length >= 0 ? grab(path.join.apply(null, rel.split('/')), n) : '').join('\n');
  const fn = new Function('atob', code + '\nreturn ' + names[names.length - 1] + ';');
  return fn;
}
const atob = (s) => Buffer.from(s, 'base64').toString('binary');
const mk = (rel, names) => loadImpl(rel, names);
const contentFns = ['fbCanonicalHost', 'fbEfgTag', 'fbFileKey'];
const bgFns = ['fbCanonicalHost', 'fbEfgTag', 'fbFileKey'];
const dmFns = ['fbCanonicalHost', 'fbEfgTag', 'fbFileKey'];
const popupFns = ['fbCanonHostInline', 'fbEfgTagInline', 'fbKeyInline'];
function build(file, names) {
  const code = names.map(n => grab(file, n)).join('\n');
  return new Function('atob', code + '\nreturn ' + names[names.length - 1] + ';')(atob);
}
const ck = build('chrome-extension/content.js', contentFns);
const bk = build('chrome-extension/background.js', bgFns);
const pk = build('chrome-extension/popup.js', popupFns);
const dk = build('src/download-manager.js', dmFns);
const efgB64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fbUrl(host, pathPart, tag, rot, opts) {
  const q = new URLSearchParams({
    ccb: '16-1',
    efg: efgB64(Object.assign({ vrt: 40960464216783, bhak: '/AZ' + rot, pcv: 200 }, tag)),
    _nc_cat: String(100 + rot % 7), _nc_sid: '0', _nc_ohc: 'ohc' + rot, _nc_ht: host,
    oh: 'hash' + rot, oe: '5E' + (1000 + rot), vh: 'vh' + rot, vs: '1798796466_' + rot,
  });
  return 'https://' + host + pathPart + '?' + q.toString();
}
const itagA = fbUrl('video-x.xx.fbcdn.net', '/v/t59.4756-21/999_n.mp4', { itag: 110 }, 1, {});
const itagB = fbUrl('video-x.xx.fbcdn.net', '/v/t59.4756-21/999_n.mp4', { itag: 607 }, 1, {});
console.log('content itagA:', ck(itagA));
console.log('content itagB:', ck(itagB));
console.log('bg      itagA:', bk(itagA));
console.log('bg      itagB:', bk(itagB));
console.log('dm      itagA:', dk(itagA));
console.log('dm      itagB:', dk(itagB));
const mkNoEfg = (vabr) => 'https://video-x.xx.fbcdn.net/o1/n/555_n.mp4?oh=a&oe=b&vabr=' + vabr;
console.log('content vabr2800:', ck(mkNoEfg('2800')));
console.log('content vabr900 :', ck(mkNoEfg('900')));
