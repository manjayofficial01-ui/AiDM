// Regression: a finished yt-dlp job MUST be recognised as finished.
//
// THE BUG (shipped in v5.1.0, still in v5.3.1)
// -------------------------------------------
// `isJobOutputName()` decided whether a file in the download folder belonged to
// the job by taking the template prefix — everything up to `%(ext)s`, which
// ALWAYS ends with a dot ("Clip.%(ext)s" → "Clip.", "Clip [1080p].yt%(ext)s" →
// "Clip [1080p].yt") — then testing the REMAINDER against /^\.[A-Za-z0-9]{1,10}$/.
// The remainder of a real output is a BARE extension ("mp4"), with no leading
// dot, because the dot was already consumed by the prefix. The regex therefore
// never matched:
//
//     producedFileFor('…\clip.%(ext)s')  →  null   (clip.mp4 was right there)
//
// `download()` treats a null result as failure and throws `no-output`:
//
//     "yt-dlp finished without producing a file, so nothing was saved."
//
// So EVERY yt-dlp job — every YouTube download — failed at the last step, with
// a perfectly good file already written to disk. Verified live: the same
// command run by hand produced a 2,058,142-byte clip.mp4, while AiDM's own
// download() reported no-output on the identical file.
//
// WHY THE SUITE MISSED IT
// -----------------------
// test/youtube-resolver.js exercises the handoff with `ytdlp.download` STUBBED
// — and the stub is the exact function this check lives in. The gap was total.
//
// This file drives the REAL download() with a fake child process, so the
// completion gate is genuinely exercised.
//
// Run: node test/yt-dlp-output.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// ── Intercept child_process BEFORE yt-dlp.js destructures spawn ─────────────
// yt-dlp.js does `const { spawn } = require('child_process')` at load time, so
// patching here (before the require below) is what makes the fake effective.
const cp = require('child_process');
const { EventEmitter } = require('events');
const realSpawn = cp.spawn;

/** Files the fake yt-dlp should leave behind, by job key. */
let fakeOutputs = [];
let fakeExitCode = 0;
let lastArgs = [];

function fakeChild(argv) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const isVersion = argv.includes('--version');
  setTimeout(() => {
    if (isVersion) {
      child.stdout.emit('data', Buffer.from('2026.10.10.233141\n'));
      child.emit('close', 0);
      return;
    }
    // A real job: write the files the "download" produced, then exit.
    for (const f of fakeOutputs) {
      try { fs.writeFileSync(f.path, Buffer.alloc(f.size, 'x')); } catch (e) { /* ignore */ }
    }
    child.emit('close', fakeExitCode);
  }, 5);
  return child;
}

cp.spawn = (cmd, argv) => { lastArgs = argv || []; return fakeChild(lastArgs); };

const ROOT = path.join(__dirname, '..');
const ytdlp = require(path.join(ROOT, 'src', 'yt-dlp.js'));

// ── producedFileFor: the exact function that was broken ─────────────────────
console.log('── producedFileFor ──');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  // 1. A plain template. This is the case that regressed.
  fs.writeFileSync(path.join(dir, 'clip.mp4'), Buffer.alloc(2048));
  const tpl = path.join(dir, 'clip.%(ext)s');
  check('a bare extension IS recognised (the regression)',
    ytdlp.producedFileFor(tpl) === path.join(dir, 'clip.mp4'),
    String(ytdlp.producedFileFor(tpl)));

  // 2. The manager's real template: "<stem>.yt%(ext)s" → "<stem>.ytmp4".
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  fs.writeFileSync(path.join(dir2, 'Clip [1080p].ytmp4'), Buffer.alloc(4096));
  const tpl2 = path.join(dir2, 'Clip [1080p].yt%(ext)s');
  check('the manager template (.yt%(ext)s) IS recognised',
    ytdlp.producedFileFor(tpl2) === path.join(dir2, 'Clip [1080p].ytmp4'),
    String(ytdlp.producedFileFor(tpl2)));

  // 3b. A MERGED job lands as "<stem>.yt<ext>.<container>" — the template's own
  //     extension PLUS the one `--merge-output-format mp4` appends. This is the
  //     NORMAL result of every DASH (1080p+) download, and it was missed too.
  const dir3b = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  fs.writeFileSync(path.join(dir3b, 'm.ytmp4.mp4'), Buffer.alloc(9094155));
  check('a merge-appended double extension (m.ytmp4.mp4) IS recognised',
    ytdlp.producedFileFor(path.join(dir3b, 'm.yt%(ext)s')) === path.join(dir3b, 'm.ytmp4.mp4'),
    String(ytdlp.producedFileFor(path.join(dir3b, 'm.yt%(ext)s'))));
  const dir3c = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  fs.writeFileSync(path.join(dir3c, 'm.ytmkv'), Buffer.alloc(1000));
  check('a merge fallback container (m.ytmkv) IS recognised',
    ytdlp.producedFileFor(path.join(dir3c, 'm.yt%(ext)s')) === path.join(dir3c, 'm.ytmkv'));

  // 3. A dotted extension still works (the case the old regex did handle).
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  fs.writeFileSync(path.join(dir3, 'clip.mp4'), Buffer.alloc(1024));
  check('a template with no dot before %(ext)s still works',
    ytdlp.producedFileFor(path.join(dir3, 'clip%(ext)s')) === path.join(dir3, 'clip.mp4'));

  // 4. Intermediates must NOT be adopted as the finished file.
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  fs.writeFileSync(path.join(dir4, 'clip.mp4.part'), Buffer.alloc(9000));
  fs.writeFileSync(path.join(dir4, 'clip.mp4.ytdl'), Buffer.alloc(10));
  check('a .part leftover is not adopted',
    ytdlp.producedFileFor(path.join(dir4, 'clip.%(ext)s')) === null);
  const dir4b = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  fs.writeFileSync(path.join(dir4b, 'clip.f137.mp4'), Buffer.alloc(9000));
  check('a raw .f<id> track is not adopted',
    ytdlp.producedFileFor(path.join(dir4b, 'clip.%(ext)s')) === null);

  // 5. The LARGEST real output wins.
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  fs.writeFileSync(path.join(dir5, 'clip.webm'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir5, 'clip.mp4'), Buffer.alloc(5000));
  check('the largest real output wins',
    ytdlp.producedFileFor(path.join(dir5, 'clip.%(ext)s')) === path.join(dir5, 'clip.mp4'));

  // 6. Unrelated files that merely share the prefix must never match.
  const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  fs.writeFileSync(path.join(dir6, 'Clip.yt 2.mp4'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(dir6, 'Clip.youtube-notes.txt'), Buffer.alloc(5000));
  check('a user file sharing the title prefix is NOT adopted',
    ytdlp.producedFileFor(path.join(dir6, 'Clip.yt%(ext)s')) === null);
  const dir6b = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  fs.writeFileSync(path.join(dir6b, 'Clip.youtube-notes.txt'), Buffer.alloc(5000));
  check('a "Clip.youtube…" file is NOT adopted',
    ytdlp.producedFileFor(path.join(dir6b, 'Clip.%(ext)s')) === null);

  // 7. An empty folder is still a clean null.
  const dir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-out-'));
  check('an empty folder yields null', ytdlp.producedFileFor(path.join(dir7, 'clip.%(ext)s')) === null);
}

// ── cleanupPartialOutputs: removes job files, spares everything else ────────
console.log('── cleanupPartialOutputs ──');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-cln-'));
  const tpl = path.join(dir, 'Clip.yt%(ext)s');
  const jobFiles = ['Clip.ytmp4', 'Clip.ytmp4.part', 'Clip.yt.mp4', 'Clip.ytf137.mp4', 'Clip.ytmp4.ytdl'];
  for (const n of jobFiles) fs.writeFileSync(path.join(dir, n), Buffer.alloc(64));
  const bystanders = ['Clip.yt 2.mp4', 'Clip.youtube-notes.txt', 'holiday.mp4'];
  for (const n of bystanders) fs.writeFileSync(path.join(dir, n), Buffer.alloc(64));
  const removed = ytdlp.cleanupPartialOutputs(tpl);
  const left = fs.readdirSync(dir).sort();
  check('every job file is removed', removed === jobFiles.length, 'removed=' + removed);
  check('no job file survives', !jobFiles.some(n => left.includes(n)), JSON.stringify(left));
  check('unrelated files survive untouched',
    bystanders.every(n => left.includes(n)), JSON.stringify(left));
}

// ── The real download(): a produced file must mean SUCCESS ──────────────────
async function downloadTests() {
  console.log('── download() end-to-end (fake child process) ──');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-dl-'));
  const outFile = path.join(dir, 'Clip [1080p].ytmp4');
  const tpl = path.join(dir, 'Clip [1080p].yt%(ext)s');

  // 9a. Happy path: the child writes the merged file and exits 0.
  fakeOutputs = [{ path: outFile, size: 8192 }];
  fakeExitCode = 0;
  try {
    const r = await ytdlp.download({ url: 'https://www.youtube.com/watch?v=abc', formatSpec: '137+140', outputTemplate: tpl, timeoutMs: 5000 });
    check('a produced file resolves as SUCCESS (no no-output error)', !!(r && r.ok), JSON.stringify(r));
  } catch (e) {
    check('a produced file resolves as SUCCESS (no no-output error)', false, 'threw ' + e.code + ': ' + e.message);
  }
  check('the file really is on disk', fs.existsSync(outFile));

  // 9b. The regression guard: exit 0 with NOTHING written must still fail —
  //     `--ignore-errors` makes yt-dlp exit 0 even when it saved nothing.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-dl-'));
  fakeOutputs = [];
  fakeExitCode = 0;
  try {
    await ytdlp.download({ url: 'https://www.youtube.com/watch?v=abc', formatSpec: '137+140', outputTemplate: path.join(dir2, 'Clip.yt%(ext)s'), timeoutMs: 5000 });
    check('exit 0 with no file still fails (the check is not simply removed)', false, 'resolved instead of throwing');
  } catch (e) {
    check('exit 0 with no file still fails (the check is not simply removed)', e.code === 'no-output', e.code);
  }

  // 9c. A .part-only leftover must also fail — a half file is not a download.
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-dl-'));
  fakeOutputs = [{ path: path.join(dir3, 'Clip.ytmp4.part'), size: 4096 }];
  fakeExitCode = 0;
  try {
    await ytdlp.download({ url: 'https://www.youtube.com/watch?v=abc', formatSpec: '137+140', outputTemplate: path.join(dir3, 'Clip.yt%(ext)s'), timeoutMs: 5000 });
    check('a .part-only leftover fails', false, 'resolved instead of throwing');
  } catch (e) {
    check('a .part-only leftover fails', e.code === 'no-output', e.code);
  }

  // 9d. The JS runtime really reaches the child's argv.
  check('the child received --js-runtimes',
    lastArgs.includes('--js-runtimes'), JSON.stringify(lastArgs.filter(a => /js-runtimes/.test(a))));

  cp.spawn = realSpawn;
}

// ── The manager's own picker must not crown a raw track ─────────────────────
console.log('── findProducedFile (manager) ──');
{
  const dm = require(path.join(ROOT, 'src', 'download-manager.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-fpf-'));
  const stem = 'Clip [1080p]';
  // The raw video track is deliberately BIGGER than the merged file — a
  // picture-only stream can easily out-size a merged one. The ".yt" sits
  // between the stem and ".f137", so the old /\.f\d+\./ test never matched it
  // and the raw track won.
  fs.writeFileSync(path.join(dir, stem + '.ytmp4'), Buffer.alloc(3000));
  fs.writeFileSync(path.join(dir, stem + '.ytf137.mp4'), Buffer.alloc(9000));
  check('the merged file beats a LARGER raw track',
    dm.findProducedFile(dir, stem) === path.join(dir, stem + '.ytmp4'),
    path.basename(String(dm.findProducedFile(dir, stem))));

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-fpf-'));
  fs.writeFileSync(path.join(dir2, stem + '.ytwebm'), Buffer.alloc(3000));
  fs.writeFileSync(path.join(dir2, stem + '.ytmp4'), Buffer.alloc(3000));
  check('mp4 beats webm at equal size',
    dm.findProducedFile(dir2, stem) === path.join(dir2, stem + '.ytmp4'));

  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-fpf-'));
  fs.writeFileSync(path.join(dir3, stem + '.yten.srt'), Buffer.alloc(9000));
  check('a subtitle sidecar is never the download',
    dm.findProducedFile(dir3, stem) === null);

  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-fpf-'));
  fs.writeFileSync(path.join(dir4, stem + '.ytmp4.part'), Buffer.alloc(9000));
  check('a .part leftover is never the download',
    dm.findProducedFile(dir4, stem) === null);
}

downloadTests().then(() => {
  console.log(`\nyt-dlp-output: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  cp.spawn = realSpawn;
  console.log('  FAIL harness crashed: ' + (e && e.message));
  console.log(`\nyt-dlp-output: ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
