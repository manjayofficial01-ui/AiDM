// Regression harness for split A/V adaptations offered as standalone videos:
// a playing Facebook video can yield a SILENT video file and, separately, an
// AUDIO-ONLY file (DASH/HLS adaptations, audio renditions) — "video has no
// audio, and audio without video gets downloaded".
//
// Fixes (all original AiDM code):
//   1. HLS audio-group deny set: EXT-X-MEDIA TYPE=AUDIO playlists named by a
//      master are never offered as video rows (query-immune origin+path).
//   2. Every video-container capsule row is verified to carry a real video
//      track (metadata probe); trackless rows drop. Geometry repaints only
//      for rows the URL didn't describe.
//   3. Popup parity: all video-container rows verified, trackless dropped
//      with count refresh.
//
// SHIPPED noteAudioPlaylists/isKnownAudioPlaylist are extracted (not copied).
// Run: node test/av-tracks.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

function grabShipped(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in shipped source');
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
      let p = k - 1;
      while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
      const pc = p >= 0 ? src[p] : '(';
      if (!/[(,=:?!&|{;\[]/.test(pc)) continue;
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
const ctSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8');
const popSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
const dmSrc = fs.readFileSync(path.join(ROOT, 'src', 'download-manager.js'), 'utf8');
const srvSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
const pkgSrc = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const fbSrc = fs.readFileSync(path.join(ROOT, 'src', 'facebook-resolver.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');

const audioLib = new Function(
  'audioPlaylistPaths',
  grabShipped(ctSrc, 'noteAudioPlaylists') + '\n' +
  grabShipped(ctSrc, 'isKnownAudioPlaylist') + '\n' +
  'return { noteAudioPlaylists, isKnownAudioPlaylist };'
)(new Set());

// ── 1. HLS audio groups denied, video variants untouched ───────────────────
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="English",URI="audio/en.m3u8?tok=1"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="Espanol",DEFAULT=NO,URI="https://cdn.example.com/h/es.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="a1"',
  'https://cdn.example.com/h/720.m3u8?tok=1',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a1"',
  '720p.m3u8',
].join('\n');
audioLib.noteAudioPlaylists(MASTER, 'https://cdn.example.com/h/master.m3u8');
check('relative audio URI resolved + denied',
  audioLib.isKnownAudioPlaylist('https://cdn.example.com/h/audio/en.m3u8?tok=1') === true);
check('query rotation does not escape the deny set',
  audioLib.isKnownAudioPlaylist('https://cdn.example.com/h/audio/en.m3u8?tok=ROTATED') === true);
check('absolute audio URI denied',
  audioLib.isKnownAudioPlaylist('https://cdn.example.com/h/es.m3u8') === true);
check('video variants not denied',
  audioLib.isKnownAudioPlaylist('https://cdn.example.com/h/720.m3u8?tok=1') === false);
check('unrelated URLs pass',
  audioLib.isKnownAudioPlaylist('https://cdn.example.com/h/other.mp4') === false &&
  audioLib.isKnownAudioPlaylist('not a url') === false &&
  audioLib.isKnownAudioPlaylist(null) === false);
check('non-audio media groups ignored',
  (() => {
    audioLib.noteAudioPlaylists('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="sub/en.m3u8"', 'https://cdn.example.com/h/m.m3u8');
    return audioLib.isKnownAudioPlaylist('https://cdn.example.com/h/sub/en.m3u8') === false;
  })());

// ── 2. capsule wiring ──────────────────────────────────────────────────────
check('master expansion records audio groups',
  /noteAudioPlaylists\(text, res\.url \|\| url\)/.test(ctSrc));
check('candidates drop known audio playlists',
  /isKnownAudioPlaylist\(v\.url\)/.test(ctSrc));
check('every video-container row verified (not just res-less)',
  /needsMetaProbe\(v\.url, false\)/.test(ctSrc));
check('repaint stays limited to undescribed rows',
  /if \(hadAuthoritativeRes\) return;/.test(ctSrc));
check('probe reports duration for preview detection',
  /durationSec: Number\.isFinite/.test(ctSrc));

// ── 3. popup parity ────────────────────────────────────────────────────────
check('popup verifies all video-container rows',
  popSrc.includes('.(mp4|m4v|webm|mkv|mov|avi)') || /mp4\|m4v\|webm\|mkv\|mov\|avi/.test(popSrc));
check('popup drops trackless rows + refreshes count',
  /if \(!file\.width \|\| !file\.height\)/.test(popSrc) &&
  /querySelectorAll\('\.media-item'\)/.test(popSrc));
check('popup probe always resolves the file object',
  /finish\(\{ width: w, height: h, durationSec: Number\.isFinite/.test(popSrc));

// ── 4. Facebook split-AV audio pairing ──────────────────────────────────
check('content.js pairs audio-only tracks by efg video_id / path dir',
  /function rememberFbAudioUrl\(/.test(ctSrc) &&
  /function attachFbAudioUrl\(/.test(ctSrc) &&
  /fbAudioByVid/.test(ctSrc) &&
  /attachFbAudioUrl/.test(ctSrc));
check('content.js attaches audioUrl on the download list path',
  /attachFbAudioUrls\(/.test(ctSrc) && /videosForDownloadList/.test(ctSrc));
check('content.js harvests audio before the playing-only filter',
  /rememberFbAudioUrl/.test(ctSrc) &&
  /Harvest audio-only Facebook tracks|rememberFbAudioUrl\(v\.url\)/.test(ctSrc));
check('background.js ships fbTrackKindOfUrl + fbVideoIdOfUrl + fbEfgObj helpers',
  /function fbTrackKindOfUrl\(u\)/.test(bgSrc) &&
  /function fbVideoIdOfUrl\(u\)/.test(bgSrc) &&
  /function fbEfgObj\(efg\)/.test(bgSrc));
check('background.js skip-audio-and-pair post-pass is present',
  /fbAudioByVid\.set\(vid, v\.url\)/.test(bgSrc) &&
  /fbAudioByVid\.size/.test(bgSrc) &&
  /v\.audioUrl = fbAudioByVid\.get\(vid\)/.test(bgSrc));
check('background.js also pairs by path dir / sole audio track',
  /fbAudioByDir/.test(bgSrc) && /fbSoleAudio/.test(bgSrc));

// v4.8.3 drift guard: the audio-codec fingerprint must ship IDENTICALLY in
// every track classifier (desktop resolver + content + background + popup).
// A prior pass fixed 3 of 4 copies and left popup.js on the old /audio/i-only
// match with NO test failing — this assertion makes any copy desync fail.
{
  const AUDIO_FP = 'audio|heaac|aac[_-]|mp4a|opus|vorbis';
  const inAll =
    popSrc.includes(AUDIO_FP) &&
    bgSrc.includes(AUDIO_FP) &&
    ctSrc.includes(AUDIO_FP) &&
    fbSrc.includes(AUDIO_FP);
  check('audio-codec fingerprint ships in ALL 4 track classifiers (no drift)',
    inAll,
    ['popup:' + popSrc.includes(AUDIO_FP), 'bg:' + bgSrc.includes(AUDIO_FP),
     'content:' + ctSrc.includes(AUDIO_FP), 'resolver:' + fbSrc.includes(AUDIO_FP)].join(' '));
  // Each copy must also read vencode_tag, not just encode_tag.
  check('all 4 classifiers read vencode_tag as well as encode_tag',
    /vencode_tag/.test(popSrc) && /vencode_tag/.test(bgSrc) &&
    /vencode_tag/.test(ctSrc) && /vencode_tag/.test(fbSrc));
}
check('audioUrl propagated to desktop single-download opts',
  /audioUrl:\s*v\.audioUrl/.test(ctSrc) &&
  /audioUrl:\s*item\.audioUrl/.test(popSrc) &&
  /audioUrl:\s*typeof data\.audioUrl/.test(srvSrc));
check('quality picker forwards audioUrl to addDownload',
  /audioUrl:\s*video\.audioUrl/.test(uiSrc) || /audioUrl:\s*video\.audioUrl \|\|/.test(uiSrc));
check('facebook-resolver pairs audio onto picker variants',
  /audioUrl:\s*v\.audioUrl/.test(fbSrc) && /audioTracks/.test(fbSrc));
check('facebook-resolver prefers progressive (audio-bearing) URLs',
  /progressive: !!progressive/.test(fbSrc) || /progressive: !!v\.progressive/.test(fbSrc));
check('download-manager muxes when audioUrl is present even if probe is silent',
  /if \(!dl \|\| dl\._muxDone\) return false;/.test(dmSrc) &&
  /dl\.media && dl\.media\.hasAudio/.test(dmSrc) &&
  /_recoverFacebookAudioUrl/.test(dmSrc));
check('mux audio fetch pins facebookexternalhit on Facebook CDN',
  /facebookMediaHeaders/.test(dmSrc) &&
  /facebookexternalhit\/1\.1/.test(fs.readFileSync(path.join(ROOT, 'src', 'media-mux.js'), 'utf8')));
check('mux has AAC re-encode fallback for fragmented Facebook pairs',
  /-c:a['"],\s*['"]aac['"]/.test(fs.readFileSync(path.join(ROOT, 'src', 'media-mux.js'), 'utf8')) ||
  /'aac'/.test(fs.readFileSync(path.join(ROOT, 'src', 'media-mux.js'), 'utf8')));
check('extension send pins FB UA on fbcdn downloads',
  /facebookexternalhit\/1\.1/.test(bgSrc) && /isFbCdn/.test(bgSrc));
check('desktop mux module exists and is required by download-manager',
  fs.existsSync(path.join(ROOT, 'src', 'media-mux.js')) &&
  /require\('\.\/media-mux'\)/.test(dmSrc) &&
  /_muxFacebookAudio\(dl\)/.test(dmSrc) &&
  /muxAudioVideo\(videoPath, audioPath, muxedPath\)/.test(dmSrc));
check('queueDownload preserves a paired audioUrl',
  /queueDownload\(opts\)/.test(dmSrc) &&
  /audioUrl: \(opts && typeof opts\.audioUrl/.test(dmSrc));
check('duplicate re-add attaches a missing audioUrl to the live row',
  /live\.audioUrl = audioUrl/.test(dmSrc) &&
  /live\.audioUrl = opts\.audioUrl/.test(dmSrc));
check('audio recovery prefers the downloaded variant over first-found',
  /withAudio\.find\(v => v\.url && normalizeMediaUrl\(v\.url\) === targetNorm\)/.test(dmSrc));
check('resolver harvests extensionless efg-audio + audio keys, deduped',
  /rememberAudio\(u\)/.test(fbSrc) &&
  /"audio_url"/.test(fbSrc) &&
  /dash_audio\(\?:_url\)\?/.test(fbSrc) &&
  /seenAudio\.has\(abs\)/.test(fbSrc));
check('ffmpeg-static is bundled and asarUnpack is configured',
  /ffmpeg-static/.test(pkgSrc) &&
  /asarUnpack/.test(pkgSrc));

console.log(`\nav-tracks: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
