'use strict';
// Regression: ONE YouTube page must offer ONE canonical row.
//
// The extension's sniffer registered every googlevideo rendition the player
// requested (one per itag plus ad/quality probes) as its own row — a single
// video showed "11 downloadable links" with a badge of 23, and every one of
// those signed, minutes-lived URLs 403'd in the desktop engine ("Failed").
// The fix: YouTube pages hand the desktop the canonical WATCH URL once and
// the app's yt-dlp pipeline resolves real qualities (see /api/resolve-youtube
// and _routeDownload in src/server.js, which were already built for it).
//
// SHIPPED definitions are extracted (not copied), following the
// extension-dimensions.js grab pattern. Run: node test/ext-youtube-canonical.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, actual === expected ? '' : `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const ROOT = path.join(__dirname, '..');
const CONTENT = path.join(ROOT, 'chrome-extension', 'content.js');
const ctSrc = fs.readFileSync(CONTENT, 'utf8');

function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in content.js');
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
    if (c === '"') { inStr = '"'; continue; }
    if (c === "'") { inStr = "'"; continue; }
    if (c === '`') { inStr = '`'; continue; }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

// The shipped page-matcher regex literal.
const ytReM = /const YT_PAGE_RE = (\/.*?\/[a-z]*);/.exec(ctSrc);
if (!ytReM) throw new Error('YT_PAGE_RE literal not found in content.js');
const YT_PAGE_RE = new Function('return ' + ytReM[1] + ';')();

function makeLib(location, docTitle) {
  return new Function(
    'YT_PAGE_RE', 'location', 'document',
    grab(ctSrc, 'isYouTubePage') + '\n' +
    grab(ctSrc, 'youTubePageVideoId') + '\n' +
    grab(ctSrc, 'youTubeCanonicalUrl') + '\n' +
    grab(ctSrc, 'youTubeRowTitle') + '\n' +
    grab(ctSrc, 'youTubeCanonicalRow') + '\n' +
    'return { isYouTubePage, youTubePageVideoId, youTubeCanonicalUrl, youTubeCanonicalRow };'
  )(YT_PAGE_RE, location, { title: docTitle });
}

const ID = 'dQw4w9WgXcQ';

// ── 1. Page detection ─────────────────────────────────────────────────────────
console.log('\nYouTube page detection');
const loc = (hostname, pathname, search) => ({ hostname, pathname: pathname || '/', search: search || '' });
for (const [label, l] of [
  ['www.youtube.com', loc('www.youtube.com', '/watch', '?v=' + ID)],
  ['m.youtube.com', loc('m.youtube.com', '/watch', '?v=' + ID)],
  ['music.youtube.com', loc('music.youtube.com', '/watch', '?v=' + ID)],
  ['youtu.be', loc('youtu.be', '/' + ID)],
  ['youtube-nocookie', loc('www.youtube-nocookie.com', '/embed/' + ID)],
]) {
  check(label + ' is a YouTube page', makeLib(l, '').isYouTubePage());
}
for (const [label, l] of [
  ['example.com', loc('example.com')],
  ['lookalike host', loc('notyoutube.com')],
  ['youtube.evil.tld', loc('youtube.evil.tld')],
]) {
  check(label + ' is NOT a YouTube page', !makeLib(l, '').isYouTubePage());
}

// ── 2. Video id extraction ────────────────────────────────────────────────────
console.log('\nVideo id extraction (all page forms, 11-char strict)');
const cases = [
  ['watch url', loc('www.youtube.com', '/watch', '?v=' + ID + '&t=42s'), ID],
  ['watch + playlist', loc('www.youtube.com', '/watch', '?v=' + ID + '&list=PL123'), ID],
  ['shorts', loc('www.youtube.com', '/shorts/' + ID), ID],
  ['live', loc('www.youtube.com', '/live/' + ID), ID],
  ['embed', loc('www.youtube.com', '/embed/' + ID), ID],
  ['v path', loc('www.youtube.com', '/v/' + ID), ID],
  ['youtu.be + si', loc('youtu.be', '/' + ID, '?si=abc'), ID],
  ['nocookie embed', loc('www.youtube-nocookie.com', '/embed/' + ID), ID],
  ['12-char id rejected', loc('www.youtube.com', '/watch', '?v=' + ID + 'X'), null],
  ['homepage has none', loc('www.youtube.com', '/'), null],
  ['results page has none', loc('www.youtube.com', '/results', '?search_query=x'), null],
];
for (const [label, l, want] of cases) {
  eq(label, makeLib(l, '').youTubePageVideoId(), want);
}

// ── 3. Canonical row ──────────────────────────────────────────────────────────
console.log('\nCanonical watch-URL row');
const watchLoc = loc('www.youtube.com', '/watch', '?v=' + ID);
const row = makeLib(watchLoc, 'Photoshop\'s New Interface & More Updates In 10 Minutes - YouTube').youTubeCanonicalRow();
eq('row url is the canonical watch url', row && row.url, 'https://www.youtube.com/watch?v=' + ID);
eq('row is a video row', row && row.type, 'video');
eq('" - YouTube" suffix stripped from the title',
  row && row.title, 'Photoshop\'s New Interface & More Updates In 10 Minutes');
eq('filename built from the clean title', row && row.filename,
  'Photoshop\'s New Interface & More Updates In 10 Minutes.mp4');
eq('quality label', row && row.quality, 'Best');
check('row is marked as the playing handoff', !!row && row.playing === true && row.ytCanonical === true);
check('no title → no fabricated name', !makeLib(watchLoc, '').youTubeCanonicalRow().filename);

// ── 4. Consumers are wired to the collapse ────────────────────────────────────
console.log('\nConsumer wiring (shipped source)');
check('popup list returns the canonical row on YouTube pages',
  /function videosForDownloadList\(\) \{[\s\S]{0,200}if \(isYouTubePage\(\)\)[\s\S]{0,120}youTubeCanonicalRow/.test(ctSrc));
check('pill badge counts one link, not the rendition set',
  /else if \(isYouTubePage\(\) && youTubeCanonicalUrl\(\)\) \{[\s\S]{0,260}countUrl\(youTubeCanonicalUrl\(\)\)/.test(ctSrc));
check('pill panel offers the single canonical row',
  /const ytCanonical = isYouTubePage\(\) \? youTubeCanonicalRow\(\) : null;[\s\S]{0,120}if \(ytCanonical\) \{/.test(ctSrc));
check('fail-open: a YouTube page without a video id keeps the generic list',
  /if \(ytRow\) return \[ytRow\];/.test(ctSrc));

// ── 5. Panel builds are generation-guarded ───────────────────────────────────
// buildCapsulePanel is ASYNC and media events re-trigger it while one is in
// flight; the old guards only caught a different video or a closed panel, so
// overlapping builds each appended their rows + footer — the panel read row,
// foot, row, foot… with one row-set per rebuild.
console.log('\nPanel build race guard');
check('builds carry a generation token',
  /st\.buildGen = \(st\.buildGen \|\| 0\) \+ 1;\s*\n\s*const buildGen = st\.buildGen;/.test(ctSrc));
check('superseded() covers generation, video and closed-panel',
  /const superseded = \(\) => st\.buildGen !== buildGen \|\|\s*\n\s*openCapsuleVideo !== video \|\| !capsuleState\.get\(video\);/.test(ctSrc));
const genChecks = (ctSrc.match(/if \(superseded\(\)\) return;/g) || []).length;
check('every await point drops a superseded build', genChecks >= 4, genChecks + ' guards');
check('no stale openCapsuleVideo-only guards left in the build path',
  !/await requestPanelData\(\); \} catch \(e\) \{\}\s*\n\s*if \(openCapsuleVideo !== video \|\| !capsuleState\.get\(video\)\) return;/.test(ctSrc));

console.log(`\next-youtube-canonical: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
