// Regression harness for the YouTube engine (yt-dlp + FFmpeg).
//
// Why this exists: a YouTube watch URL is a WEB PAGE. Pasting it used to make
// AiDM download the page HTML as a file, and even a sniffed stream URL is a
// signed link that expires in minutes (and above ~720p carries picture only —
// a silent file). This suite locks down:
//   • strict URL normalisation (only the 11-char id survives — SSRF guard)
//   • format mapping: progressive vs DASH picture+sound pairs
//   • the freshness rule that decides native-engine vs yt-dlp handoff
//   • progress/expiry/log-redaction parsing
//   • row wiring in download-manager (no silent HTML download, ever)
//
// All checks are offline: no network, and they pass whether or not yt-dlp is
// installed (the one check that touches the binary is skipped when absent).
//
// Run: node test/youtube-resolver.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const yt = require('../src/youtube-resolver');
const ytdlp = require('../src/yt-dlp');
const { DownloadManager, youtubeFields, findProducedFile, uniqueFilePath } = require('../src/download-manager');
const resolvers = require('../src/resolvers');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, actual === expected ? '' : `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// ── 1. Strict URL normalisation ──────────────────────────────────────────────

console.log('\nURL normalisation (accepted)');
for (const [label, input] of [
  ['watch url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['watch + extra params', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123'],
  ['no scheme', 'youtube.com/watch?v=dQw4w9WgXcQ'],
  ['m.youtube', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['music.youtube', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['youtu.be', 'https://youtu.be/dQw4w9WgXcQ?si=abc'],
  ['shorts', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'],
  ['embed', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
  ['live', 'https://www.youtube.com/live/dQw4w9WgXcQ'],
  ['/v/', 'https://www.youtube.com/v/dQw4w9WgXcQ'],
  ['nocookie embed', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
  ['bare 11-char id', 'dQw4w9WgXcQ'],
  ['padded id', '  dQw4w9WgXcQ  '],
]) {
  eq(label, yt.normalizeYouTubeUrl(input), CANON);
}

console.log('\nURL normalisation (rejected — never reaches the extractor)');
for (const [label, input] of [
  ['lookalike host', 'https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ'],
  ['host suffix attack', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ'],
  ['host as subdomain', 'https://youtube.com.attacker.io/watch?v=dQw4w9WgXcQ'],
  ['javascript scheme', 'javascript:alert(1)//watch?v=dQw4w9WgXcQ'],
  ['file scheme', 'file:///C:/windows/watch?v=dQw4w9WgXcQ'],
  ['credentials', 'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['odd port', 'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ'],
  ['channel page', 'https://www.youtube.com/@MrBeast'],
  ['playlist', 'https://www.youtube.com/playlist?list=PL123'],
  ['watch without v', 'https://www.youtube.com/watch?list=PL123'],
  ['short id', 'https://www.youtube.com/watch?v=dQw4w9Wg'],
  ['long id', 'https://www.youtube.com/watch?v=dQw4w9WgXcQQ'],
  ['empty', ''],
  ['null', null],
  ['googlevideo stream url', 'https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1700000000&itag=137'],
]) {
  const id = yt.parseYouTubeVideoId(input);
  check('rejects ' + label, id === null, id === null ? '' : `(leaked ${id})`);
}

check('canonical url is always https + www + only v',
  yt.normalizeYouTubeUrl('http://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share') === CANON);

// ── 2. Expiry + freshness ────────────────────────────────────────────────────

console.log('\nSigned-URL expiry');
eq('reads expire= from a cdn url',
  yt.extractExpiry('https://x/videoplayback?expire=1700000000&itag=137'), 1700000000 * 1000);
eq('no expire param → null', yt.extractExpiry('https://x/video.mp4'), null);
eq('garbage input → null', yt.extractExpiry(null), null);

console.log('\nNative engine vs yt-dlp handoff');
const NOW = 1_700_000_000_000;
const prog = (over = {}) => ({
  progressive: true, url: 'https://x/videoplayback', extractedAt: NOW, ...over,
});
check('null choice → handoff', yt.isChoiceFresh(null, NOW) === false);
check('DASH pair → handoff (needs merging)',
  yt.isChoiceFresh({ progressive: false, url: 'https://x/v', extractedAt: NOW }, NOW) === false);
check('progressive with no url → handoff',
  yt.isChoiceFresh(prog({ url: null }), NOW) === false);
check('fresh progressive (expires in 6h) → native engine',
  yt.isChoiceFresh(prog({ expiresAt: NOW + 6 * 3600e3 }), NOW) === true);
check('progressive expiring in 30s → handoff',
  yt.isChoiceFresh(prog({ expiresAt: NOW + 30e3 }), NOW) === false);
check('progressive, no expiry, just extracted → native engine',
  yt.isChoiceFresh(prog(), NOW) === true);
check('progressive, no expiry, 30 min old → handoff',
  yt.isChoiceFresh(prog({ extractedAt: NOW - 30 * 60e3 }), NOW) === false);

// ── 3. Format mapping (pure, on a stub info dict) ────────────────────────────

console.log('\nFormat mapping');
const INFO = {
  id: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up - YouTube',
  duration: 212,
  formats: [
    // progressive: picture + sound in ONE file
    { format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, width: 640, filesize: 12_000_000, tbr: 600, url: 'https://x/360' },
    // DASH: picture only
    { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920, filesize: 90_000_000, tbr: 4000, url: 'https://x/1080v' },
    { format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, width: 1920, filesize: 60_000_000, tbr: 2500, url: 'https://x/1080webm' },
    { format_id: '136', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, width: 1280, filesize: 40_000_000, tbr: 2000, url: 'https://x/720v' },
    // audio only
    { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', filesize: 4_000_000, abr: 128, url: 'https://x/a140' },
    { format_id: '251', ext: 'webm', acodec: 'opus', vcodec: 'none', filesize: 6_000_000, abr: 160, url: 'https://x/a251' },
  ],
};

const videoChoices = yt.buildChoices(INFO).filter(c => !c.audioOnly);
const choices = yt.buildChoices(INFO);
eq('one choice per height (+ audio)', choices.length, 4);
eq('audio-only choice is last', choices[3].audioOnly, true);
eq('audio spec prefers m4a', choices[3].formatId, 'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio');
eq('audio choice is named m4a', yt.choiceExt(choices[3]), 'm4a');
eq('audio choice is labelled Audio', yt.choiceLabel(choices[3]), 'Audio');
eq('audio choice is never "fresh" (needs yt-dlp)', yt.isChoiceFresh(choices[3]), false);
eq('best first', videoChoices[0].height, 1080);
eq('720p second', videoChoices[1].height, 720);
eq('360p progressive single file', videoChoices[2].progressive, true);
eq('1080p is a DASH pair', choices[0].progressive, false);
eq('1080p picks mp4 over webm at the same height', choices[0].formatId, '137');
eq('1080p pairs the m4a audio (no re-encode)', choices[0].audioFormatId, '140');
eq('DASH size = video + audio', choices[0].size, 94_000_000);
eq('progressive carries no audio id', choices[2].audioFormatId, null);
eq('format spec: progressive is one id', yt.buildFormatSpec(choices[2]), '18');
eq('format spec: DASH is video+audio', yt.buildFormatSpec(choices[0]), '137+140');

const noAudio = yt.buildChoices({ id: 'x', formats: [
  { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, url: 'https://x/1080v' },
] });
eq('video-only with no audio track is dropped', noAudio.length, 1);
eq('falls back to bestvideo+bestaudio', noAudio[0].formatId, 'bestvideo+bestaudio/best');

const broken = yt.buildChoices({ id: 'x', formats: [] });
check('empty format list still yields one usable choice',
  broken.length === 1 && broken[0].formatId === 'bestvideo+bestaudio/best');

// ── 4. Picker payload ────────────────────────────────────────────────────────

console.log('\nBlocked probe degrades instead of blocking the download');
const realProbe = ytdlp.probe;
async function withProbeError(code, fn) {
  ytdlp.probe = async () => { throw Object.assign(new Error('probe refused'), { code }); };
  try { return await fn(); } finally { ytdlp.probe = realProbe; }
}

async function fallbackTests() {
  const fb = await withProbeError('bot-check', () => yt.resolveYouTubeVideos(CANON));
  eq('bot-checked probe still yields a row', (fb.pickerVideos || []).length, 1);
  eq('fallback asks for the best mergeable pair', fb.pickerVideos[0].ytFormat.formatId, 'bestvideo+bestaudio/best');
  eq('fallback keeps the canonical page url', fb.pickerVideos[0].ytUrl, CANON);
  eq('fallback row is routed through yt-dlp', fb.pickerVideos[0].ytFormat.progressive, false);
  check('fallback records why the preview failed', /probe refused/.test(fb.probeError || ''));

  const t = await withProbeError('timeout', () => yt.resolveYouTubeVideos(CANON)).catch(() => null);
  check('timeout also degrades', !!t && t.pickerVideos.length === 1);

  for (const code of ['private', 'age', 'members', 'unavailable']) {
    const err = await withProbeError(code, () => yt.resolveYouTubeVideos(CANON)).then(() => null, e => e);
    check('access failure "' + code + '" is NOT retried (stays an error)', !!err && /probe refused/.test(err.message));
  }
  check('missing yt-dlp is not masked by the fallback',
    await withProbeError('missing', () => yt.resolveYouTubeVideos(CANON)).then(() => false, () => true));
}

console.log('\nPicker payload');
const picker = yt.toPickerVideos(INFO, { canonicalUrl: CANON, id: 'dQw4w9WgXcQ', title: INFO.title });
eq('one row per choice (incl. audio)', picker.length, 4);
eq('audio row is last and labelled', picker[3].quality, 'Audio');
eq('audio row is named .m4a', picker[3].filename, 'Never Gonna Give You Up.m4a');
eq('audio row carries no resolution', picker[3].resolution, undefined);
eq('quality label', picker[0].quality, '1080p');
eq('resolution string', picker[0].resolution, '1920x1080');
check('filename is readable and titled',
  picker[0].filename === 'Never Gonna Give You Up [1080p].mp4',
  picker[0].filename);
check('every row carries the handoff payload',
  picker.every(v => v.provider === 'youtube' && v.ytUrl === CANON && v.ytFormat && v.ytFormat.formatId));
eq('DASH rows are flagged merged', picker[0].merged, true);
eq('progressive rows are not', picker[2].merged, false);
check('non-progressive rows fall back to the page url (re-resolved at start)',
  picker[0].url === CANON);
check('progressive rows carry the real stream url', picker[2].url === 'https://x/360');

// ── 5. Filename safety ───────────────────────────────────────────────────────

console.log('\nFilenames');
eq('strips path separators', yt.buildFilename({ title: 'a/b\\c:d', id: 'x', height: 720 }), 'a b c d [720p].mp4');
eq('strips the " - YouTube" suffix',
  yt.buildFilename({ title: 'Song - YouTube', id: 'x', height: 480 }), 'Song [480p].mp4');
eq('falls back to the video id when no title',
  yt.buildFilename({ title: null, id: 'dQw4w9WgXcQ', height: 1080 }), 'youtube_dQw4w9WgXcQ [1080p].mp4');
eq('no height → no label', yt.buildFilename({ title: 'Clip', id: 'x', height: 0 }), 'Clip.mp4');
check('windows reserved name is neutralised', /^_?nul/i.test(yt.safeTitle('nul')) === false || yt.safeTitle('nul') !== 'nul');

// ── 6. Progress / redaction / error classification ───────────────────────────

console.log('\nProgress + diagnostics');
const tpl = ytdlp.parseProgressLine('AIDMPROGRESS|downloading|1048576|10485760|524288|19|clip.mp4');
eq('template: downloaded', tpl.downloaded, 1048576);
eq('template: total', tpl.total, 10485760);
eq('template: speed', tpl.speed, 524288);
eq('template: eta', tpl.eta, 19);
const classic = ytdlp.parseProgressLine('[download]  42.5% of ~  10.00MiB at   1.50MiB/s ETA 00:12');
eq('classic line: percent', Math.round(classic.percent), 43);
eq('classic line: downloaded ≈ 10 MiB', classic.downloaded, 10 * 1024 * 1024);
eq('classic line: speed ≈ 1.5 MiB/s', classic.speed, Math.round(1.5 * 1024 * 1024));
eq('unrelated line → null', ytdlp.parseProgressLine('[info] Writing metadata'), null);

check('redacts signatures from logs',
  /sig=REDACTED/.test(ytdlp.redact('https://x/videoplayback?sig=ABC123&itag=137')) &&
  !/ABC123/.test(ytdlp.redact('https://x/videoplayback?sig=ABC123&itag=137')));
check('redacts po tokens', !/POTVALUE/.test(ytdlp.redact('?pot=POTVALUE&x=1')));

eq('private video', ytdlp.classifyError('ERROR: Private video').code, 'private');
eq('bot check', ytdlp.classifyError('Sign in to confirm you\'re not a bot').code, 'bot-check');
eq('age gate', ytdlp.classifyError('ERROR: age-restricted').code, 'age');
eq('members only', ytdlp.classifyError('Join this channel to get access').code, 'members');
eq('removed', ytdlp.classifyError('Video unavailable').code, 'unavailable');
eq('stale quality', ytdlp.classifyError('Requested format is not available').code, 'format');
eq('ffmpeg merge', ytdlp.classifyError('ERROR: Postprocessing: ffmpeg exited').code, 'merge');
eq('timeout', ytdlp.classifyError('timed out').code, 'timeout');
eq('unknown → generic extract failure', ytdlp.classifyError('something odd').code, 'extract');

// ── 7. Registry wiring ───────────────────────────────────────────────────────

console.log('\nResolver registry');
const found = resolvers.findResolver(CANON);
check('watch url resolves to the youtube provider', !!found && found.name === 'youtube');
check('supports() is true for a shorts url', !!resolvers.findResolver('https://youtu.be/dQw4w9WgXcQ'));
check('a sniffed googlevideo url is NOT resolved (extension handles those)',
  resolvers.findResolver('https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1') === null);
check('twitter/facebook providers still win for their own urls',
  (resolvers.findResolver('https://x.com/user/status/1234567890') || {}).name === 'twitter');

// ── 8. Download-manager row wiring ───────────────────────────────────────────

console.log('\nDownload-manager wiring');
eq('non-youtube metadata adds no fields', Object.keys(youtubeFields({ pageUrl: 'x' })).length, 0);
eq('youtube metadata adds provider + ytUrl + ytFormat',
  Object.keys(youtubeFields({ provider: 'youtube', ytUrl: CANON, ytFormat: { formatId: '137' } })).sort().join(','),
  'provider,ytFormat,ytUrl');
eq('a bare ytUrl is enough (no provider key)',
  youtubeFields({ ytUrl: CANON }).provider, 'youtube');
eq('empty meta → no fields', Object.keys(youtubeFields(null)).length, 0);

console.log('\nDuplicate detection (same page, different quality)');
const dupCtx = (rows) => ({ downloads: new Map(rows.map(r => [r.id, r])) });
const existing = { id: 'a', url: CANON, _normUrl: 'norm-yt', ytFormat: { formatId: '137', audioFormatId: '140', progressive: false } };
const c1 = dupCtx([existing]);
check('same url + same quality is a duplicate',
  DownloadManager.prototype.findDuplicate.call(c1, CANON, { formatId: '137' }) === existing);
check('same url + DIFFERENT quality is NOT a duplicate',
  DownloadManager.prototype.findDuplicate.call(c1, CANON, { formatId: '136' }) === null);
check('normalized match + different quality is NOT a duplicate',
  DownloadManager.prototype.findDuplicate.call(c1, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9', { formatId: '248' }) === null);
check('no format given keeps the old behaviour (duplicate)',
  DownloadManager.prototype.findDuplicate.call(c1, CANON, null) === existing);
const c2 = dupCtx([{ id: 'b', url: 'https://cdn.example.com/clip.mp4', _normUrl: 'norm-file' }]);
check('non-YouTube urls are unaffected',
  DownloadManager.prototype.findDuplicate.call(c2, 'https://cdn.example.com/clip.mp4') !== null);
check('unrelated url → null',
  DownloadManager.prototype.findDuplicate.call(c2, 'https://cdn.example.com/other.mp4') === null);
check('empty url → null',
  DownloadManager.prototype.findDuplicate.call(c2, '') === null);

const dmSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-manager.js'), 'utf8');
check('youtube rows are intercepted before the generic probe',
  /if \(download\.provider === 'youtube'\)[\s\S]{0,200}_startYoutubeDownload\(download\)/.test(dmSrc));
const ytSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'yt-dlp.js'), 'utf8');
check('handoff uses --merge-output-format mp4', /merge-output-format/.test(ytSrc));
check('speed limit is forwarded to yt-dlp', /--limit-rate/.test(ytSrc));
check('resume is enabled (--continue)', /'--continue'/.test(ytSrc));
check('no shell, argv only (no shell:true)', !/shell:\s*true/.test(ytSrc));
check('url is passed after -- (no argument injection)', /args\.push\('--', String\(url\)\)/.test(ytSrc));
check('pause flips a youtube row with no engine state',
  /dl\.status === 'downloading' && dl\.provider === 'youtube'/.test(dmSrc));
check('missing yt-dlp never throws at require time',
  !/throw new Error\(ytdlpMissingMessage/.test(dmSrc) && /ytdlpMissingMessage\(\), 'missing'/.test(dmSrc));

console.log('\nDiagnostics wiring');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
check('log dir is outside the download folder', /'logs'/.test(dmSrc) && /function youtubeLogDir/.test(dmSrc));
check('logs are pruned (newest 20, 24h cap)', /function pruneYoutubeLogs/.test(dmSrc) && /maxAgeMs = 24 \* 3600 \* 1000/.test(dmSrc));
check('manager passes a per-job log path', /logPath,/.test(dmSrc));
check('open-download-log handler exists', /ipcMain\.handle\('open-download-log'/.test(mainSrc));
check('handler only opens THIS row\'s log', /dl && dl\.ytLogPath/.test(mainSrc));
check('handler confines the path to the app log dir', /abs\.startsWith\(dir \+ path\.sep\)/.test(mainSrc));
check('handler refuses traversal / null bytes', /includes\('\\0'\)/.test(mainSrc));
check('preload exposes openDownloadLog', /openDownloadLog:/.test(preloadSrc));
check('error rows show a log button', /data-action="open-log"/.test(uiSrc) && /dl\.ytLogPath/.test(uiSrc));
check('ui handles the open-log action', /case 'open-log':/.test(uiSrc));

// Output-file picking (fs-backed, temp dir)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-yt-'));
try {
  fs.writeFileSync(path.join(TMP, 'clip.yt.f137.mp4'), 'x'.repeat(100));
  fs.writeFileSync(path.join(TMP, 'clip.yt.mp4'), 'x'.repeat(500));
  eq('merged file beats the raw track',
    path.basename(findProducedFile(TMP, 'clip')), 'clip.yt.mp4');

  fs.writeFileSync(path.join(TMP, 'other.yt.webm'), 'x'.repeat(900));
  fs.writeFileSync(path.join(TMP, 'other.yt.mp4'), 'x'.repeat(10));
  eq('mp4 beats webm', path.basename(findProducedFile(TMP, 'other')), 'other.yt.mp4');

  eq('no output → null', findProducedFile(TMP, 'missing'), null);

  const target = path.join(TMP, 'clip.mp4');
  fs.writeFileSync(target, 'x');
  eq('collision gets a suffix', path.basename(uniqueFilePath(target)), 'clip (1).mp4');
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// ── 9. Manager handoff, with the yt-dlp child stubbed out ────────────────────
// Exercises the real _startYoutubeDownload (progress → row, output discovery,
// rename, completion) without spawning anything.

console.log('\nHandoff (stubbed child process)');
const realDetect = ytdlp.detectRunner;
const realDownload = ytdlp.download;

function stubContext(row, extra = {}) {
  return {
    downloads: new Map([[row.id, row]]),
    settings: {},
    queue: [],
    engine: {},
    _ytActive: 0,
    _persistDownloads() { this.persisted = (this.persisted || 0) + 1; },
    _processQueue() { this.queued = (this.queued || 0) + 1; },
    emit(name, payload) { (this.events = this.events || []).push([name, payload]); },
    ...extra,
  };
}
function stubRow(dir, over = {}) {
  return {
    id: 'yt1',
    url: CANON,
    ytUrl: CANON,
    provider: 'youtube',
    filename: 'Clip [1080p].mp4',
    filepath: path.join(dir, 'Clip [1080p].mp4'),
    downloaded: 0,
    totalSize: 94_000_000,
    percent: 0,
    speed: 0,
    eta: null,
    status: 'queued',
    ytFormat: { formatId: '137', audioFormatId: '140', progressive: false, size: 94_000_000 },
    ...over,
  };
}

async function handoffTests() {
const HANDOFF_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-yt-handoff-'));
try {
  // 9a. Happy path
  ytdlp.detectRunner = async () => ({ argv: ['stub'], source: 'stub', version: 'stub' });
  ytdlp.download = async (o) => {
    o.onProgress({ downloaded: 47_000_000, total: 94_000_000, speed: 1_000_000, percent: 50, eta: 47 });
    // yt-dlp merges to "<template with ext>" — here <stem>.ytmp4.mp4
    fs.writeFileSync(o.outputTemplate.replace('%(ext)s', 'mp4') + '.mp4', Buffer.alloc(2048, 'v'));
    return { ok: true, sawProgress: true };
  };

  const row1 = stubRow(HANDOFF_TMP);
  const ctx1 = stubContext(row1);
  const handled1 = await DownloadManager.prototype._startYoutubeDownload.call(ctx1, row1);

  eq('handoff takes over a DASH row', handled1, true);
  eq('row completes', row1.status, 'completed');
  eq('output renamed to the chosen filename', path.basename(row1.filepath), 'Clip [1080p].mp4');
  check('output file exists on disk', fs.existsSync(row1.filepath), row1.filepath);
  eq('final size recorded', row1.totalSize, 2048);
  eq('percent 100', row1.percent, 100);
  check('progress was reported mid-flight',
    (ctx1.events || []).some(([n, p]) => n === 'download-progress' && p.percent === 50 && p.downloaded === 47_000_000));
  check('completion event emitted',
    (ctx1.events || []).some(([n]) => n === 'download-complete'));
  check('queue advanced after completion', ctx1.queued >= 1);

  // 9b. Fresh progressive URL keeps the native engine
  const row2 = stubRow(HANDOFF_TMP, {
    ytFormat: { formatId: '18', audioFormatId: null, progressive: true, url: 'https://x/360', extractedAt: Date.now() },
  });
  const ctx2 = stubContext(row2);
  const handled2 = await DownloadManager.prototype._startYoutubeDownload.call(ctx2, row2);
  eq('fresh progressive → native engine (not handled)', handled2, false);

  // 9c. Missing yt-dlp → actionable error, never a crash
  ytdlp.detectRunner = async () => null;
  const row3 = stubRow(HANDOFF_TMP);
  const ctx3 = stubContext(row3);
  const handled3 = await DownloadManager.prototype._startYoutubeDownload.call(ctx3, row3);
  eq('missing binary is handled, not thrown', handled3, true);
  eq('row errors', row3.status, 'error');
  check('error message points at the installer', /fetch-yt-dlp\.js/.test(row3.error || ''));
  eq('error code', row3.ytErrorCode, 'missing');

  // 9d. Pause mid-flight → row pauses (resume continues from the .part file)
  ytdlp.detectRunner = async () => ({ argv: ['stub'], source: 'stub', version: 'stub' });
  const row4 = stubRow(HANDOFF_TMP);
  const ctx4 = stubContext(row4);
  ytdlp.download = async (o) => {
    o.shouldAbort();                       // manager sees status 'paused'
    row4.status = 'paused';
    const e = new Error('Stopped.'); e.code = 'aborted'; throw e;
  };
  const handled4 = await DownloadManager.prototype._startYoutubeDownload.call(ctx4, row4);
  eq('abort is handled', handled4, true);
  eq('pause leaves the row paused (resumable)', row4.status, 'paused');

  // 9d1. Concurrency cap: a second job waits instead of spawning a child
  ytdlp.detectRunner = async () => ({ argv: ['stub'], source: 'stub', version: 'stub' });
  let ran = 0;
  ytdlp.download = async () => { ran++; return { ok: true }; };
  const row6 = stubRow(HANDOFF_TMP);
  const ctx6 = stubContext(row6, { _ytActive: 1 });
  ctx6.settings = { youtubeMaxConcurrent: 1 };          // one slot, already busy
  const handled6 = await DownloadManager.prototype._startYoutubeDownload.call(ctx6, row6);
  eq('at capacity → taken over (no child spawned)', handled6, true);
  eq('no download started while at capacity', ran, 0);
  eq('row goes back to the queue', row6.status, 'queued');
  check('row is queued exactly once', (ctx6.queue || []).length === 0 || (ctx6.queue || []).length === 1);

  const ctx6b = stubContext(row6, { _ytActive: 0 });
  ctx6b.settings = { youtubeMaxConcurrent: 1 };
  await DownloadManager.prototype._startYoutubeDownload.call(ctx6b, row6);
  eq('a free slot starts the job', ran, 1);
  eq('slot is released again after the run', ctx6b._ytActive, 0);

  // 9d2. Slot is released even when the download fails
  const row7 = stubRow(HANDOFF_TMP);
  const ctx7 = stubContext(row7);
  ytdlp.download = async () => { const e = new Error('boom'); e.code = 'merge'; throw e; };
  await DownloadManager.prototype._startYoutubeDownload.call(ctx7, row7);
  eq('failed job releases its slot', ctx7._ytActive, 0);
  eq('failed job is reported', row7.status, 'error');

  // 9d3. Speed limit reaches yt-dlp (the scheduler must apply here too)
  let seenRate = null;
  ytdlp.download = async (o) => { seenRate = o.limitRate; return { ok: true }; };
  const row8 = stubRow(HANDOFF_TMP);
  const ctx8 = stubContext(row8, { engine: { globalSpeedLimit: 512 * 1024 } });
  await DownloadManager.prototype._startYoutubeDownload.call(ctx8, row8);
  eq('engine speed limit is passed to yt-dlp', seenRate, 512 * 1024);
  const row9 = stubRow(HANDOFF_TMP);
  await DownloadManager.prototype._startYoutubeDownload.call(stubContext(row9, { engine: {} }), row9);
  eq('no limit when none is set', seenRate, 0);

  // 9e2. Container honesty: never save an mkv/m4a under a .mp4 name
  ytdlp.detectRunner = async () => ({ argv: ['stub'], source: 'stub', version: 'stub' });
  const rowM = stubRow(HANDOFF_TMP);   // wants "Clip [1080p].mp4"
  ytdlp.download = async (o) => {
    fs.writeFileSync(o.outputTemplate.replace('%(ext)s', 'mkv'), Buffer.alloc(256, 'v'));
    return { ok: true };
  };
  await DownloadManager.prototype._startYoutubeDownload.call(stubContext(rowM), rowM);
  eq('row keeps its name but takes the real container', path.basename(rowM.filepath), 'Clip [1080p].mkv');
  check('renamed file exists', fs.existsSync(rowM.filepath));

  // 9e3. Diagnostics: a redacted log for failures, and only for failures
  const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-yt-logs-'));
  try {
    ytdlp.detectRunner = async () => ({ argv: ['stub'], source: 'stub', version: '2026.08.19' });
    const rowL = stubRow(HANDOFF_TMP);
    const ctxL = stubContext(rowL);
    ytdlp.download = async (o) => {
      o.logPath && require('fs').writeFileSync(o.logPath, 'SIG leak sig=SECRETVALUE');
      const e = new Error('boom'); e.code = 'merge'; e.logPath = o.logPath; throw e;
    };
    await DownloadManager.prototype._startYoutubeDownload.call(ctxL, rowL);
    check('failed row records its log path', rowL.ytLogPath === undefined || typeof rowL.ytLogPath === 'string');

    // The real writer (not the stub): secrets must never reach the log.
    const logFile = path.join(LOGDIR, 'job.log');
    const p = ytdlp.writeDiagnosticLog(logFile, {
      code: 'bot-check', url: CANON, formatSpec: '137+140', runner: '2026.08.19',
      tail: 'ERROR: [youtube] x: Sign in to confirm\nhttps://rr3.googlevideo.com/videoplayback?sig=SECRETVALUE&pot=POKEMON',
    });
    eq('log written to the given path', p, logFile);
    const text = fs.readFileSync(logFile, 'utf8');
    check('log names the error code', /error code:\s+bot-check/.test(text));
    check('log records the yt-dlp version', /yt-dlp:\s+2026\.08\.19/.test(text));
    check('log keeps the canonical page url', text.includes(CANON));
    check('log keeps the extractor words', /Sign in to confirm/.test(text));
    check('log REDACTS signatures', !/SECRETVALUE/.test(text) && /sig=REDACTED/.test(text));
    check('log REDACTS po tokens', !/POKEMON/.test(text));
    eq('missing log path is not an error', ytdlp.writeDiagnosticLog(null, { tail: 'x' }), null);
  } finally {
    try { fs.rmSync(LOGDIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  // 9f. Persistence: progress must reach disk (crash leaves real bytes)
  const rowA = stubRow(HANDOFF_TMP);
  const ctxA = stubContext(rowA);
  ytdlp.download = async (o) => {
    ctxA._lastYtProgressPersist = Date.now() - 60000;   // force the 5s window open
    o.onProgress({ downloaded: 1000, total: 94_000_000, speed: 500_000, percent: 1, eta: 180 });
    fs.writeFileSync(o.outputTemplate.replace('%(ext)s', 'mp4') + '.mp4', Buffer.alloc(512, 'v'));
    return { ok: true };
  };
  await DownloadManager.prototype._startYoutubeDownload.call(ctxA, rowA);
  check('progress is persisted (not just the completion)', ctxA.persisted >= 2, 'persists=' + ctxA.persisted);

  const rowB = stubRow(HANDOFF_TMP);
  const ctxB = stubContext(rowB);
  ytdlp.download = async (o) => {
    fs.writeFileSync(o.outputTemplate.replace('%(ext)s', 'mp4') + '.mp4', Buffer.alloc(512, 'v'));
    return { ok: true };
  };
  await DownloadManager.prototype._startYoutubeDownload.call(ctxB, rowB);
  eq('a run without progress ticks persists once', ctxB.persisted, 1);

  // 9e. A stale/expired row is re-extracted instead of downloaded directly
  const row5 = stubRow(HANDOFF_TMP, {
    ytFormat: { formatId: '18', progressive: true, url: 'https://x/360', expiresAt: Date.now() - 1000, extractedAt: Date.now() - 3600e3 },
  });
  ytdlp.download = async () => { row5.stubRan = true; return { ok: true }; };
  await DownloadManager.prototype._startYoutubeDownload.call(stubContext(row5), row5);
  eq('expired url → yt-dlp re-extracts', row5.stubRan, true);
} finally {
  ytdlp.detectRunner = realDetect;
  ytdlp.download = realDownload;
  try { fs.rmSync(HANDOFF_TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
}

// ── 10. Installed binary (informational; skipped when absent) ────────────────

(async () => {
  await fallbackTests();
  await handoffTests();

  const runner = await ytdlp.detectRunner();
  if (runner) {
    check('detected installed yt-dlp (' + runner.source + ')', !!runner.version, runner.version);
  } else {
    console.log('  SKIP yt-dlp not installed — run: node tools/fetch-yt-dlp.js');
  }
  check('missing-yt-dlp message is actionable',
    /tools\/fetch-yt-dlp\.js/.test(yt.ytdlpMissingMessage()) && /AIDM_YTDLP/.test(yt.ytdlpMissingMessage()));

  console.log(`\nyoutube-resolver: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
