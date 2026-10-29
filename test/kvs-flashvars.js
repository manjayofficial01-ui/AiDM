'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../chrome-extension/content.js'), 'utf8');
const start = source.indexOf('  function parseKvsFlashvars(');
const extractionStart = source.indexOf('  function extractKvsFlashvars(');
const end = source.indexOf('  // ── Page-HTML media extraction', extractionStart);
const context = vm.createContext({
  scripts: [],
  document: { title: 'Fixture title', querySelectorAll: () => context.scripts },
  location: { protocol: 'https:', origin: 'https://example.test' },
  kvsDecodeUrl: (url) => url,
  executed: false,
});
vm.runInContext(source.slice(start < 0 ? extractionStart : start, end), context);
const extract = (text) => {
  context.scripts = [{ textContent: text }];
  return context.extractKvsFlashvars();
};
let pass = 0, fail = 0;
function check(name, run) {
  try { run(); pass++; console.log('  OK  ', name); }
  catch (error) { fail++; console.log('  FAIL', name, error.message); }
}

check('strict JSON metadata remains supported', () => {
  const rows = extract('var flashvars = {"video_url":"https://cdn.example.test/1080p.mp4","video_url_text":"1080p","video_title":"Sample"};');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quality, '1080p');
  assert.equal(rows[0].title, 'Sample');
});
check('unquoted keys, single quotes, comments and trailing commas are data', () => {
  const rows = extract("const flashvars = { /*fixture*/ video_url: '/720p.mp4', video_url_text: '720p', video_alt_url: '//cdn.example.test/480p.mp4', video_alt_url_text: '480p', options: { enabled: true, count: 2, }, list: [null, false, 1.5,], }; bootPlayer();");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://example.test/720p.mp4');
  assert.equal(rows[1].url, 'https://cdn.example.test/480p.mp4');
  assert.equal(rows[1].quality, '480p');
});
check('escaped quotes, URLs and Unicode decode without corrupting apostrophes', () => {
  const rows = extract(String.raw`flashvars = {video_url: 'https:\/\/cdn.example.test\/720p.mp4?x=1\u0026y=2', video_title: 'Sam\'s "clip" \u03a9 \x21',};`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://cdn.example.test/720p.mp4?x=1&y=2');
  assert.equal(rows[0].title, 'Sam\'s "clip" Ω !');
});
check('literal object delimiters inside a title do not truncate parsing', () => {
  const rows = extract("flashvars = {video_title: 'A }); title', video_url: '/720p.mp4'};");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'A }); title');
});
check('prototype-like keys remain inert own data', () => {
  const rows = extract("flashvars = {__proto__: {video_url: '/inherited.mp4'}, constructor: 'data', video_url: '/real.mp4'};");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://example.test/real.mp4');
});
check('unexpected scalar metadata does not abort extraction', () => {
  const rows = extract("flashvars = {video_url: '/720p.mp4', video_url_text: 720, video_title: {text: 'not a title'}, license_code: null};");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Fixture title');
});
for (const [name, object] of [
  ['call expression', "{video_url: '/clip.mp4', payload: (globalThis.executed = true)}"],
  ['function call', "{video_url: (() => {globalThis.executed = true; return '/clip.mp4';})()}"],
  ['getter', "{get video_url() {globalThis.executed = true; return '/clip.mp4';}}"],
  ['computed key', "{[globalThis.executed = true]: '/clip.mp4'}"],
  ['spread expression', "{...((globalThis.executed = true) && {}), video_url: '/clip.mp4'}"],
  ['template expression', '{video_url: `${globalThis.executed = true}`}'],
  ['identifier reference', "{video_url: location.origin}"],
  ['function value', "{video_url: '/clip.mp4', fn: function () {}}"],
  ['object expression suffix', "{video_url: '/clip.mp4'} + (globalThis.executed = true)"],
  ['malformed string', "{video_url: '/clip.mp4}"],
]) {
  check(`${name} is rejected without executing page code`, () => {
    context.executed = false;
    const rows = extract(`flashvars = ${object};`);
    assert.equal(context.executed, false);
    assert.equal(rows.length, 0);
  });
}
check('invalid script does not prevent a later valid flashvars object', () => {
  context.executed = false;
  context.scripts = [
    { textContent: "flashvars = {video_url: (globalThis.executed = true)};" },
    { textContent: "flashvars = {video_url: '/valid.mp4'};" },
  ];
  const rows = context.extractKvsFlashvars();
  assert.equal(context.executed, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://example.test/valid.mp4');
});
check('unrelated trailing script does not count toward the literal size limit', () => {
  const rows = extract(`flashvars = {video_url: '/clip.mp4', video_alt_url: '/other.mp4'}; /*${'x'.repeat(262144)}*/`);
  assert.equal(rows.length, 2);
});
check('oversized and deeply nested objects fail closed', () => {
  assert.equal(extract(`flashvars = {video_url: '/clip.mp4', x: '${'x'.repeat(262144)}'};`).length, 0);
  assert.equal(extract(`flashvars = {video_url: '/clip.mp4', x: ${'['.repeat(40)}0${']'.repeat(40)}};`).length, 0);
});
check('content script contains no dynamic evaluation', () => {
  assert.equal(/\bnew\s+Function\s*\(|\beval\s*\(/.test(source), false);
});
console.log(`\nkvs-flashvars: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
