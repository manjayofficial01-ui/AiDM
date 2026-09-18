// Regression harness for the v4.3.0 site grabber (all original AiDM code in
// chrome-extension/content.js): same-origin crawl helpers — anchor mining and
// the downloadable-file filter. The SHIPPED definitions are extracted (not
// copied), following the dead-link-guard.js pattern.
//
// Run: node test/grabber.js
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

// The filter closes over the shipped default set — reuse the shipped literal.
const setMatch = /const GRABBER_DEFAULT_EXTS = new Set\(\[([\s\S]*?)\]\);/.exec(ctSrc);
if (!setMatch) throw new Error('GRABBER_DEFAULT_EXTS literal not found');
const GRABBER_DEFAULT_EXTS = new Function('return new Set([' + setMatch[1] + ']);')();

const lib = new Function(
  'GRABBER_DEFAULT_EXTS',
  grab(CONTENT, 'grabFilter') + '\n' +
  grab(CONTENT, 'anchorUrlsFromHtml') + '\n' +
  'return { grabFilter, anchorUrlsFromHtml };'
)(GRABBER_DEFAULT_EXTS);

const { grabFilter, anchorUrlsFromHtml } = lib;

// ── anchorUrlsFromHtml ─────────────────────────────────────────────────────
{
  const html = `
    <a href="/files/setup.exe">x</a>
    <a href='https://cdn.example.com/v/clip.mp4?tok=1#frag'>y</a>
    <a href="https://other.example/page2.html">z</a>
    <a href="#top">frag</a>
    <a href="javascript:void(0)">js</a>
    <a href="mailto:a@b.c">mail</a>
    <a href="/files/setup.exe">dup</a>`;
  const out = anchorUrlsFromHtml(html, 'https://example.com/dir/page.html');
  check('relative resolved', out.has('https://example.com/files/setup.exe'));
  check('absolute kept, fragment stripped',
    out.has('https://cdn.example.com/v/clip.mp4?tok=1'));
  check('page links kept for crawling', out.has('https://other.example/page2.html'));
  check('fragments/javascript/mailto dropped',
    ![...out].some(u => u.includes('#') || /^(javascript|mailto):/i.test(u)));
  check('duplicates collapsed', out.size === 3, `${out.size} urls`);
  check('empty html safe', anchorUrlsFromHtml('', 'https://example.com/').size === 0);
}

// ── grabFilter ─────────────────────────────────────────────────────────────
check('exe passes default', grabFilter('https://example.com/f/setup.exe', null) === true);
check('mp3 passes default', grabFilter('https://cdn.example.com/a/song.mp3', []) === true);
check('html never passes', grabFilter('https://example.com/page2.html', null) === false);
check('php never passes', grabFilter('https://example.com/dl.php?id=1', ['php']) === false);
check('explicit type filter honored',
  grabFilter('https://example.com/f/song.mp3', ['mp3', 'zip']) === true &&
  grabFilter('https://example.com/f/setup.exe', ['mp3', 'zip']) === false);
check('non-url rejected', grabFilter('notaurl', null) === false);

// ── wiring: crawler + popup entry point ────────────────────────────────────
check('content handles grab-site and caps batch size',
  /action === 'grab-site'/.test(ctSrc) && /\.slice\(0, 200\)/.test(ctSrc));
check('content crawls same-origin only',
  /u\.origin === origin/.test(ctSrc));
{
  const popSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  check('popup sends grab-site with depth + types',
    /action: 'grab-site'/.test(popSrc) && /grab-depth/.test(popSrc));
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.html'), 'utf8');
  check('popup has grab-site controls', /btn-grab-site/.test(htmlSrc));
}

console.log(`\ngrabber: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
