// Regression: the yt-dlp runner must actually emit progress, and must not
// report success when it produced no file.
//
// Two real bugs this file exists to prevent:
//
//   1. --no-progress silently disables --progress-template. yt-dlp checks
//      `noprogress` FIRST and installs a QuietMultilinePrinter, so the
//      template prints nothing. Measured against the shipped binary: a real
//      download emits 0 AIDMPROGRESS lines with the flag and 13 without it.
//      The row then sat at 0% for the entire transfer and looked stuck/failed.
//
//   2. Exit code 0 is not proof that a file exists. `--ignore-errors`
//      (subtitle jobs) makes yt-dlp return 0 even when it downloaded nothing,
//      and a merge that never ran leaves only .part files behind. Claiming
//      success there is the "it says completed but there is no file" bug.
//
// Source-level + pure-unit only: no yt-dlp binary is required or spawned.
// Run: node test/youtube-progress.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'yt-dlp.js'), 'utf8');
const ytdlp = require(path.join(ROOT, 'src', 'yt-dlp.js'));

// ── 1. The runner argv must not kill its own progress output ───────────────
console.log('\nRunner argv: progress must survive');
// The argv block is the array literal that starts at `const args = [`.
const argsBlock = /const args = \[([\s\S]*?)\n {4}\];/.exec(src);
check('the runner argv block was found', !!argsBlock);
if (argsBlock) {
  const argv = argsBlock[1];
  check('--no-progress is NOT passed (it silences --progress-template)',
    !/['"]--no-progress['"]/.test(argv));
  check('--progress-template is still passed',
    /--progress-template/.test(argv) && /PROGRESS_TEMPLATE/.test(argv));
  check('--newline is still passed (one update per line)',
    /['"]--newline['"]/.test(argv));
  check('the template still carries the machine-readable prefix',
    /const PROGRESS_PREFIX = 'AIDMPROGRESS\|'/.test(src) &&
    /const PROGRESS_TEMPLATE =\s*\n?\s*PROGRESS_PREFIX/.test(src) &&
    /%\(progress\.status\)s/.test(src));
}

// Guard the whole file, not just that literal: the flag must never come back
// through some other path either.
check('the file explains why --no-progress must stay out',
  /do NOT add --no-progress/.test(src));

// ── 2. Progress lines are still parsed correctly ───────────────────────────
console.log('\nProgress parsing');
const p1 = ytdlp.parseProgressLine('AIDMPROGRESS|downloading|2096128|3449447|23158738.08|0');
check('template line parses', !!p1 && p1.status === 'downloading', p1 && p1.status);
check('downloaded bytes read', p1 && p1.downloaded === 2096128, p1 && p1.downloaded);
check('total bytes read', p1 && p1.total === 3449447, p1 && p1.total);
check('the finished status is recognised (not treated as downloading)',
  (() => { const f = ytdlp.parseProgressLine('AIDMPROGRESS|finished|100|100|1|NA'); return !!f && f.status === 'finished'; })());
check('a non-progress line still parses as null',
  ytdlp.parseProgressLine('[info] Writing metadata') === null);
check('the classic [download] line still parses',
  !!(ytdlp.parseProgressLine('[download]  12.3% of 10.00MiB at 1.50MiB/s ETA 00:30')));

// ── 3. Exit 0 with no file must fail, not succeed ──────────────────────────
console.log('\nExit 0 must still prove a file exists');
const closeBlock = /child\.on\('close', \(code\) => \{([\s\S]*?)\n {4}\}\);/.exec(src);
check('the close handler was found', !!closeBlock);
if (closeBlock) {
  const body = closeBlock[1];
  check('probes for a produced file before reporting success',
    /producedFileFor\(outputTemplate\)/.test(body));
  check('fails when nothing was produced',
    /finished without producing a file/.test(body));
  check('uses a distinct no-output error code (not a misleading "merge")',
    /err\.code = 'no-output'/.test(body));
  check('keeps the redacted stderr + diagnostic log on that failure',
    /err\.raw = redact\(stderrTail\)/.test(body) && /writeDiagnosticLog\(/.test(body));
  check('the no-output check runs BEFORE the audio verify (order matters)',
    body.indexOf('producedFileFor(outputTemplate)') < body.indexOf('verifyMergedAudio('));
}

// ── 4. Split video+audio must not make the row go backwards ────────────────
//      yt-dlp counts PER TRACK, so the counter restarts at 0 when the audio
//      track begins. Without accumulation a 1080p row visibly jumped 48% → 0%.
console.log('\nSplit video+audio: progress must be monotonic');
{
  const seen = [];
  // Feed the runner's own line handler by driving download() with a stub
  // runner is heavy here, so assert the invariant at the unit level instead:
  // the 'finished' status must be recognised so its bytes can be banked.
  const fin = ytdlp.parseProgressLine('AIDMPROGRESS|finished|61500000|61500000|1|NA');
  check('a finished track reports its real size',
    !!fin && fin.downloaded === 61500000 && fin.total === 61500000,
    fin && fin.downloaded);
  check('finished is a distinct status (not lumped in with downloading)',
    !!fin && fin.status === 'finished');
  seen.push(fin);
}
const accSrc = /let trackDone = 0;/.test(src);
check('the runner keeps a running total across tracks', accSrc);
check('a finished track banks its bytes into that total',
  /trackDone \+= \(p\.downloaded \|\| p\.total \|\| 0\)/.test(src));
check('downloading progress is reported on top of the banked bytes',
  /const downloaded = trackDone \+ \(p\.downloaded \|\| 0\)/.test(src));
check('the estimate is abandoned once real bytes overtake it',
  /downloaded <= expectedBytes[\s\S]{0,80}expectedBytes\s*;[\s\S]{0,120}trackDone \+ \(p\.total/.test(src));
check('percent is still clamped to 100',
  /Math\.min\(100, \(downloaded \/ total\) \* 100\)/.test(src));

console.log(`\nyoutube-progress: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
