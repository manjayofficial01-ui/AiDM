// Regression: subtitle and post-processing flags must reach yt-dlp as real
// argv entries, and must stay OFF unless the user asked for them.
//
// Two failure modes this file exists to prevent:
//
//   1. Silent surprise — subtitles are opt-in. Writing .srt sidecars into
//      someone's save folder when they only asked for a video is a bug, so an
//      empty language list must produce NO arguments at all.
//   2. Injection — flags are built as discrete argv entries from a settings
//      value. Nothing here may ever become a shell string, or a value that
//      reaches the settings store could smuggle in an extra yt-dlp flag.
//
// Pure helpers only: no yt-dlp binary is needed (or spawned).
// Run: node test/youtube-subtitles.js
'use strict';
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const ROOT = path.join(__dirname, '..');
const ytdlp = require(path.join(ROOT, 'src', 'yt-dlp.js'));
const yt = require(path.join(ROOT, 'src', 'youtube-resolver.js'));

const join = (a) => a.join(' ');

// ── buildSubtitleArgs: opt-in, never silent ─────────────────────────────────
console.log('── buildSubtitleArgs (default off) ──');
check('no langs → no arguments at all', ytdlp.buildSubtitleArgs({}).length === 0);
check('empty langs → no arguments', ytdlp.buildSubtitleArgs({ langs: '' }).length === 0);
check('whitespace langs → no arguments', ytdlp.buildSubtitleArgs({ langs: '   ' }).length === 0);
check('no options object → no arguments', ytdlp.buildSubtitleArgs().length === 0);
check('null → no arguments', ytdlp.buildSubtitleArgs(null).length === 0);
// The normal (no-subtitle) path must keep failing loudly — --ignore-errors is
// only ever added as part of an opted-in subtitle request.
check('subtitles off ⇒ --ignore-errors is NOT added',
  !ytdlp.buildSubtitleArgs({ langs: '' }).includes('--ignore-errors'));

// ── buildSubtitleArgs: what it asks for ─────────────────────────────────────
console.log('── buildSubtitleArgs (opted in) ──');
{
  const a = ytdlp.buildSubtitleArgs({ langs: 'en.*' });
  check('writes real subtitle tracks', a.includes('--write-subs'), join(a));
  // Regression (verified live): YouTube 429s the caption endpoint and yt-dlp
  // treats that as FATAL — the whole job aborted with no media file at all.
  // Subtitles must never cost the user the video.
  check('a failed subtitle fetch cannot abort the video', a.includes('--ignore-errors'));
  check('no auto-captions unless asked', !a.includes('--write-auto-subs'));
  check('passes the language list', a[a.indexOf('--sub-langs') + 1] === 'en.*');
  check('converts to SRT (what players open)',
    a.includes('--convert-subs') && a[a.indexOf('--convert-subs') + 1] === 'srt');
  check('no embedding by default (sidecar, not burned in)', !a.includes('--embed-subs'));
}
{
  const a = ytdlp.buildSubtitleArgs({ langs: 'en.*,zh.*', auto: true, embed: true });
  check('auto captions when asked', a.includes('--write-auto-subs'), join(a));
  check('multi-language list is one value', a[a.indexOf('--sub-langs') + 1] === 'en.*,zh.*');
  check('embed when asked', a.includes('--embed-subs'));
}

// ── Injection safety ────────────────────────────────────────────────────────
console.log('── injection safety ──');
{
  // A hostile settings value must travel as ONE argv value, never split into
  // extra flags. argv is passed to spawn() with no shell, so a value
  // containing spaces/semicolons cannot become a second argument.
  const hostile = 'en.* --write-thumbnail';
  const a = ytdlp.buildSubtitleArgs({ langs: hostile });
  const value = a[a.indexOf('--sub-langs') + 1];
  check('a crafted lang value stays a single argv entry', value === hostile, JSON.stringify(value));
  check('the crafted flag is not emitted as a real flag',
    !a.includes('--write-thumbnail'), join(a));
  check('every entry is a plain string', a.every((x) => typeof x === 'string'));
}

// ── MP3 extra args ──────────────────────────────────────────────────────────
console.log('── buildExtraArgs (MP3 pick) ──');
check('MP3 choice re-encodes',
  join(yt.buildExtraArgs({ mp3: true, audioOnly: true })) === '--extract-audio --audio-format mp3');
check('a plain video choice adds nothing', yt.buildExtraArgs({ height: 1080 }).length === 0);
check('the m4a audio choice adds nothing', yt.buildExtraArgs({ audioOnly: true }).length === 0);
check('null choice adds nothing', yt.buildExtraArgs(null).length === 0);

// ── The picker really offers both audio picks ───────────────────────────────
console.log('── picker offers m4a and mp3 ──');
{
  const info = {
    duration: 100,
    title: 'Clip',
    formats: [
      { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, width: 1920, filesize: 1000, tbr: 500, url: 'https://x/v' },
      { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', filesize: 2000, abr: 128, url: 'https://x/a' },
    ],
  };
  const choices = yt.buildChoices(info);
  const audio = choices.filter((c) => c.audioOnly);
  check('two audio picks are offered', audio.length === 2, 'got ' + audio.length);
  check('m4a first', !audio[0].mp3 && yt.choiceExt(audio[0]) === 'm4a');
  check('mp3 second', audio[1].mp3 === true && yt.choiceExt(audio[1]) === 'mp3');
  check('labels differ so the user can tell them apart',
    yt.choiceLabel(audio[0]) !== yt.choiceLabel(audio[1]),
    yt.choiceLabel(audio[0]) + ' / ' + yt.choiceLabel(audio[1]));
}

console.log('\nyoutube-subtitles: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
