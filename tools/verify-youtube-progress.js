// Live proof: a real download through AiDM's own yt-dlp wrapper must emit
// progress lines.
//
// Before the fix, `--no-progress` sat next to `--progress-template`, so the
// template printed nothing and the row froze at 0% for the whole transfer.
// This runs the shipped runner with the shipped template and counts lines.
//
// Run: node tools/verify-youtube-progress.js [url] [formatSpec]
//
// Use a large format (e.g. `137`) to see progress actually tick — a tiny
// audio-only track finishes in ~150 ms and the runner's 200 ms UI throttle
// correctly collapses that into a single update.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ytdlp = require(path.join(ROOT, 'src', 'yt-dlp.js'));

const URL = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const FORMAT = process.argv[3] || '137';

(async () => {
  const runner = await ytdlp.detectRunner();
  if (!runner) {
    console.log('SKIP: no yt-dlp binary available — nothing to verify.');
    process.exit(0);
  }
  console.log('runner:', (runner.argv || []).join(' '), '| version:', runner.version);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-prog-'));
  const tpl = path.join(dir, 'out.%(ext)s');
  let lines = 0;
  let last = null;

  await ytdlp.download({
    url: URL,
    formatSpec: FORMAT,
    outputTemplate: tpl,
    requiresMerge: false,
    verifyAudio: false,
    timeoutMs: 180000,
    onProgress: (p) => { lines++; last = p; },
  });

  console.log('progress callbacks:', lines);
  if (last) console.log('last progress:', JSON.stringify(last));
  const files = fs.readdirSync(dir);
  console.log('files:', files.join(', '));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

  if (lines === 0) {
    console.log('FAIL: no progress was emitted — the row would look stuck.');
    process.exit(1);
  }
  console.log('PASS: progress is emitted during a real download.');
})().catch((e) => {
  console.log('ERROR:', (e && e.message) || e);
  process.exit(1);
});
