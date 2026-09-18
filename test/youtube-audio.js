/**
 * Team C regression tests — the two user-reported YouTube bugs.
 *
 *   1. "sometimes it only downloads video without audio"
 *   2. "wrong video dimensions — 360p shown as 2160p, every quality shows the
 *      same resolution"
 *
 * Pure: fake yt-dlp info dicts are built inline, no network and no spawned
 * yt-dlp. The only filesystem use is a temp dir for the merge-cleanup checks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const yt = require('../src/youtube-resolver');
const ytdlp = require('../src/yt-dlp');

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}
function eq(name, actual, expected) {
  check(name + ' = ' + JSON.stringify(expected), actual === expected, 'got ' + JSON.stringify(actual));
}

const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// A spec that claims to be a video MUST ask for audio too, unless it is a
// single progressive file (which already carries sound).
const audioSafe = (c) => {
  if (!c || c.audioOnly || c.progressive) return true;
  return /\+|bestaudio/i.test(yt.buildFormatSpec(c));
};

// ── 1. DASH video + audio always produces BOTH ids ───────────────────────────

console.log('\nDASH pair — never a picture-only spec');
const DASH = {
  id: 'dQw4w9WgXcQ',
  title: 'DASH clip',
  formats: [
    { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920, filesize: 90_000_000, tbr: 4000, url: 'https://x/1080v' },
    { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', filesize: 4_000_000, abr: 128, url: 'https://x/a140' },
  ],
};
const dashChoices = yt.buildChoices(DASH);
const dash = dashChoices.find(c => !c.audioOnly);
eq('DASH choice exists', !!dash, true);
eq('DASH spec carries BOTH stream ids', yt.buildFormatSpec(dash), '137+140');
check('spec names the audio id', /\+140$/.test(yt.buildFormatSpec(dash)), yt.buildFormatSpec(dash));
eq('DASH size = video + audio', dash.size, 94_000_000);
eq('DASH choice is flagged as having an audio source', dash.hasAudioSource, true);

// ── 2. DASH video whose audio pick is null ───────────────────────────────────

console.log('\nDASH video with no audio stream at all');
const NO_AUDIO = {
  id: 'x',
  formats: [
    { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, width: 1920, url: 'https://x/1080v' },
  ],
};
const silent = yt.buildChoices(NO_AUDIO);
eq('the video-only choice is dropped (one fallback row remains)', silent.length, 1);
check('no row ever asks for a bare video id', silent.every(audioSafe));
check('fallback spec still requests audio', /bestaudio/.test(yt.buildFormatSpec(silent[0])), yt.buildFormatSpec(silent[0]));
eq('the row surfaces "no audio track"', silent[0].noAudioTrack, true);
check('with a human-readable note', /no audio track/i.test(silent[0].audioNote || ''), silent[0].audioNote);
const silentPicker = yt.toPickerVideos(NO_AUDIO, { canonicalUrl: CANON, id: 'x', title: null });
eq('picker row carries the flag', silentPicker[0].noAudioTrack, true);
eq('ytFormat carries the flag (it travels with the row)', silentPicker[0].ytFormat.noAudioTrack, true);

// A stale PERSISTED row can also lose its audio id — buildFormatSpec is the
// last line of defence (the manager calls it directly at start).
const stale = { formatId: '137', audioFormatId: null, progressive: false, height: 1080 };
check('a stale DASH row never degrades to "-f 137"', yt.buildFormatSpec(stale) !== '137', yt.buildFormatSpec(stale));
check('stale row still requests audio', /bestaudio/.test(yt.buildFormatSpec(stale)), yt.buildFormatSpec(stale));
eq('ensureAudioChoice appends bestaudio', yt.ensureAudioChoice(stale).formatId, '137+bestaudio/best');

// ── 3. Audio-only choice ─────────────────────────────────────────────────────

console.log('\nAudio-only choice');
const audioChoice = dashChoices.find(c => c.audioOnly);
eq('an audio row is offered', !!audioChoice, true);
eq('audio container is m4a', yt.choiceExt(audioChoice), 'm4a');
eq('audio is labelled Audio', yt.choiceLabel(audioChoice), 'Audio');
eq('audio spec prefers m4a/aac', audioChoice.formatId, 'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio');
eq('audio filename has no quality tag',
  yt.buildFilename({ title: 'Song', id: 'x', height: audioChoice.height, ext: 'm4a' }), 'Song.m4a');
eq('audio row carries no resolution', yt.resolutionOfChoice(audioChoice), undefined);

console.log('\nAudio track preference (no re-encode)');
const MIXED_AUDIO = { id: 'y', formats: [
  { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, width: 1920, url: 'https://x/v' },
  { format_id: '251', ext: 'webm', acodec: 'opus', vcodec: 'none', abr: 160, url: 'https://x/opus' },
  { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128, url: 'https://x/m4a' },
] };
eq('m4a/aac beats a louder opus track', yt.buildChoices(MIXED_AUDIO)[0].audioFormatId, '140');
eq('pickBestAudio picks m4a over webm', yt.pickBestAudio(MIXED_AUDIO.formats.slice(1)).format_id, '140');
eq('no audio formats → null', yt.pickBestAudio([]), null);

// ── 4. Real geometry: portrait, 4:3, unknown ─────────────────────────────────

console.log('\nReal dimensions (no 16:9 guessing)');
const PORTRAIT = { id: 'p', formats: [
  { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1920, width: 1080, url: 'https://x/v' },
  { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128, url: 'https://x/a' },
] };
const portrait = yt.buildChoices(PORTRAIT)[0];
eq('portrait keeps its real resolution', yt.resolutionOfChoice(portrait), '1080x1920');
check('portrait is NOT reported as landscape', yt.resolutionOfChoice(portrait) !== '3413x1920', yt.resolutionOfChoice(portrait));
const portraitPicker = yt.toPickerVideos(PORTRAIT, { canonicalUrl: CANON, id: 'p', title: 'Vertical' });
eq('picker agrees on portrait geometry', portraitPicker[0].resolution, '1080x1920');
eq('label comes from the real height', portraitPicker[0].quality, '1920p');

const FOUR_THREE = { id: 'q', formats: [
  { format_id: '18', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a.40.2', height: 480, width: 640, url: 'https://x/v' },
] };
const fourThree = yt.buildChoices(FOUR_THREE)[0];
eq('4:3 keeps its real resolution', yt.resolutionOfChoice(fourThree), '640x480');
eq('4:3 label', yt.choiceLabel(fourThree), '480p');

const NO_WIDTH = { id: 'n', formats: [
  { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 2160, url: 'https://x/v' },
  { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128, url: 'https://x/a' },
] };
const noWidth = yt.buildChoices(NO_WIDTH)[0];
eq('unknown width is NOT invented', yt.resolutionOfChoice(noWidth), undefined);
eq('picker leaves the resolution empty too',
  yt.toPickerVideos(NO_WIDTH, { canonicalUrl: CANON, id: 'n', title: 'N' })[0].resolution, undefined);
eq('empty choice → undefined', yt.resolutionOfChoice(null), undefined);
eq('zero height → undefined', yt.resolutionOfChoice({ height: 0, width: 1920 }), undefined);
eq('zero width → undefined', yt.resolutionOfChoice({ height: 1080, width: 0 }), undefined);

// ── 5. Every quality keeps its own height and label ──────────────────────────

console.log('\n360p next to 2160p (the "everything is 2160p" bug)');
const MIXED = {
  id: 'm',
  title: 'Mixed',
  formats: [
    { format_id: '18', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a.40.2', height: 360, width: 640, filesize: 12_000_000, tbr: 600, url: 'https://x/360' },
    { format_id: '401', ext: 'mp4', vcodec: 'av01', acodec: 'none', height: 2160, width: 3840, filesize: 900_000_000, tbr: 20000, url: 'https/x/2160' },
    { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', filesize: 4_000_000, abr: 128, url: 'https://x/a' },
  ],
};
const mixed = yt.buildChoices(MIXED);
const heights = mixed.filter(c => !c.audioOnly).map(c => c.height);
eq('one row per height', heights.length, 2);
eq('2160p row keeps 2160', heights[0], 2160);
eq('360p row keeps 360', heights[1], 360);
const labels = mixed.filter(c => !c.audioOnly).map(c => yt.choiceLabel(c));
eq('labels differ per row', labels.join(','), '2160p,360p');
const res = mixed.filter(c => !c.audioOnly).map(c => yt.resolutionOfChoice(c));
eq('resolutions differ per row', res.join(','), '3840x2160,640x360');
const names = mixed.filter(c => !c.audioOnly)
  .map(c => yt.buildFilename({ title: 'Mixed', id: 'm', height: c.height, ext: 'mp4' }));
eq('filenames differ per row', names.join(','), 'Mixed [2160p].mp4,Mixed [360p].mp4');
check('every row is audio-safe', mixed.every(audioSafe));

// ── 6. The whole payload agrees (media / picker / filename) ───────────────────

console.log('\nPayload agreement (stubbed probe, no network)');
const realProbe = ytdlp.probe;
async function payloadTest() {
  ytdlp.probe = async () => MIXED;
  try {
    const out = await yt.resolveYouTubeVideos(CANON);
    const m0 = out.media[0];
    const p0 = out.pickerVideos[0];
    eq('media height is the real one', m0.height, 2160);
    eq('media width is the real one', m0.width, 3840);
    eq('media and picker agree', m0.resolution, p0.resolution);
    eq('filename tag matches the height', /\[2160p\]/.test(m0.filename), true);
    eq('second row keeps 360p', out.media[1].height, 360);
    eq('second filename tag', /\[360p\]/.test(out.media[1].filename), true);
    check('no row claims audio it cannot have',
      out.media.every(m => !m.noAudioTrack || m.audioNote));
    check('every media row is audio-safe',
      out.pickerVideos.every(p => audioSafe(p.ytFormat)));
  } finally {
    ytdlp.probe = realProbe;
  }
}

// ── 7. Merge safety helpers (src/yt-dlp.js) ──────────────────────────────────

console.log('\nMerge safety');
eq('137+140 needs a merge', ytdlp.specNeedsMerge('137+140'), true);
eq('bestvideo+bestaudio/best needs a merge', ytdlp.specNeedsMerge('bestvideo+bestaudio/best'), true);
eq('a single progressive id does not', ytdlp.specNeedsMerge('18'), false);
eq('empty spec → false', ytdlp.specNeedsMerge(''), false);

async function mergeTests() {
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-yt-audio-'));
try {
  const tpl = path.join(TMP, 'Clip.yt%(ext)s');
  fs.writeFileSync(path.join(TMP, 'Clip.yt.f137.mp4'), 'v'.repeat(100));
  fs.writeFileSync(path.join(TMP, 'Clip.yt.f140.m4a'), 'a'.repeat(50));
  fs.writeFileSync(path.join(TMP, 'Clip.yt.mp4'), 'm'.repeat(500));
  fs.writeFileSync(path.join(TMP, 'Clip.yt.mp4.part'), 'p'.repeat(300));
  fs.writeFileSync(path.join(TMP, 'Someones Clip.mp4'), 'k'.repeat(9000));

  eq('produced file is the merged one', path.basename(ytdlp.producedFileFor(tpl)), 'Clip.yt.mp4');
  const removed = ytdlp.cleanupPartialOutputs(tpl);
  check('failed merge removes tracks, merged file and .part', removed >= 3, 'removed=' + removed);
  check('no intermediate is left behind',
    !fs.readdirSync(TMP).some(n => n.startsWith('Clip.yt')), fs.readdirSync(TMP).join(','));
  check('an unrelated file in the folder survives', fs.existsSync(path.join(TMP, 'Someones Clip.mp4')));
  eq('cleanup on a bogus template is a no-op', ytdlp.cleanupPartialOutputs(''), 0);
  eq('no output → null', ytdlp.producedFileFor(path.join(TMP, 'Nope.yt%(ext)s')), null);

  // A probe that cannot prove anything must NOT lose the download.
  const unknown = path.join(TMP, 'garbage.bin');
  fs.writeFileSync(unknown, 'not a media file');
  const v = await ytdlp.verifyMergedAudio(unknown);
  eq('unreadable file is left alone (unknown, not "no audio")', v.ok, true);
  eq('missing file is left alone', (await ytdlp.verifyMergedAudio(null)).ok, true);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
}

console.log('\nMerge failures are reported as merge, not success');
eq('ffmpeg failure → merge', ytdlp.classifyError('ERROR: Postprocessing: ffmpeg exited').code, 'merge');
eq('merger failure → merge', ytdlp.classifyError('ERROR: Merger failed').code, 'merge');

(async () => {
  await payloadTest();
  await mergeTests();
  console.log(`\nyoutube-audio: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
