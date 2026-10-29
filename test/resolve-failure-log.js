'use strict';
// Regression: a failed RESOLVE (the quality-picker stage) used to leave
// NOTHING on disk — only the download stage wrote a diagnostic log — so
// "again not able to download" was undebuggable after the fact. Every
// resolver failure now writes a redacted log next to the download logs with
// the same retention rules (newest 20, nothing older than a day).
//
// Run: node test/resolve-failure-log.js

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, actual === expected ? '' : `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// Redirect the log dir BEFORE requiring the module — resolveLogDir reads the
// env at call time, so a temp LOCALAPPDATA keeps the test out of the real
// user data (and out of the running app's way).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-resolve-log-'));
process.env.LOCALAPPDATA = TMP;
process.env.XDG_DATA_HOME = TMP;

const ytdlp = require('../src/yt-dlp');

const logsDir = path.join(TMP, 'AiDM', 'logs');
const failingErr = () => Object.assign(
  new Error('ERROR: Sign in to confirm you are not a bot'),
  {
    code: 'bot-check',
    raw: 'https://x.googlevideo.com/videoplayback?sig=SECRET123&pot=TOPSECRETPOT&expire=999',
  }
);
const URL_ = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

console.log('\nResolve-failure diagnostic log');
const p1 = ytdlp.logResolveFailure(failingErr(), URL_);
check('log file written', !!p1 && fs.existsSync(p1), p1 || '');
const body = fs.readFileSync(p1, 'utf8');
check('names the error code', /error code:\s+bot-check/.test(body));
check('carries the page url', body.includes('watch?v=' + 'dQw4w9WgXcQ'));
check('keeps the extractor words', body.includes('Sign in to confirm you are not a bot'));
check('REDACTS signed-URL params', !/SECRET123/.test(body) && body.includes('sig=REDACTED'));
check('REDACTS po tokens', !/TOPSECRETPOT/.test(body) && body.includes('pot=REDACTED'));

console.log('\nRetention (bounded, like the download logs)');
for (let i = 0; i < 25; i++) ytdlp.logResolveFailure(failingErr(), URL_);
const left = fs.readdirSync(logsDir).filter((n) => /^resolve-.*\.log$/i.test(n));
eq('keeps the newest 20', left.length, 20);
check('never throws on a garbage error object',
  !!ytdlp.logResolveFailure(null, URL_) || ytdlp.logResolveFailure(null, URL_) === null);
check('never throws on a non-URL', typeof ytdlp.logResolveFailure(failingErr(), 'not a url') === 'string' || true);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nresolve-failure-log: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
