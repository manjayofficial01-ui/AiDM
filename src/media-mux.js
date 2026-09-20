const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (e) {
  ffmpegPath = null;
}

// Same UA yt-dlp's facebook extractor pins: Facebook CDN rate-limits browser
// User-Agents on media GETs. The desktop engine uses this for video segments;
// the audio-mux fetch must use it too or the paired track 403s.
const FB_UA = 'facebookexternalhit/1.1';
const FB_CDN_RE = /fbcdn\.net|scontent\.|cdninstagram\.com/i;

function resolveFfmpeg() {
  if (!ffmpegPath) return null;
  let p = ffmpegPath;
  if (p.includes('app.asar')) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  try {
    if (fs.existsSync(p)) return p;
  } catch (e) {}
  return null;
}

function isAvailable() {
  return !!resolveFfmpeg();
}

function isFacebookCdnUrl(u) {
  try { return FB_CDN_RE.test(new URL(String(u)).hostname); }
  catch (e) { return false; }
}

function runFfmpeg(args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpeg();
    if (!bin) {
      reject(new Error('ffmpeg-static is not available'));
      return;
    }
    // stdout must not stay piped: a tool writing progress to stdout (or a
    // filter with a chatty banner) can fill the OS pipe buffer and deadlock
    // the child. ffmpeg reports on stderr, which we do collect.
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch (e) {}
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited ' + code + ': ' + stderr.trim().split('\n').slice(-3).join(' | ')));
    });
  });
}

/**
 * Merge a video-only track with a paired audio track.
 * First tries stream copy (fast, lossless). Facebook DASH pairs are often
 * fragmented MP4 + AAC where `-c copy` produces a silent-looking file or
 * fails — fall back to re-encoding audio to AAC while keeping video copy.
 */
async function muxAudioVideo(videoPath, audioPath, outPath, opts = {}) {
  const copyArgs = [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0?',
    '-map', '1:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ];
  try {
    await runFfmpeg(copyArgs, opts);
    return outPath;
  } catch (copyErr) {
    // Re-encode audio only — video stays copy so quality is preserved.
    const reencodeArgs = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0?',
      '-map', '1:a:0?',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-movflags', '+faststart',
      outPath,
    ];
    await runFfmpeg(reencodeArgs, opts);
    return outPath;
  }
}

/**
 * Headers for fetching a Facebook/Instagram CDN media file (video or audio).
 * Always pins facebookexternalhit — browser UA is rate-limited by FB CDN
 * (yt-dlp facebook extractor documents this explicitly).
 */
function facebookMediaHeaders(url, extra = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== undefined && v !== null && String(v).trim() !== '') headers[k] = String(v);
  }
  const hasKey = (name) => Object.keys(headers).some(k => k.toLowerCase() === name.toLowerCase());
  if (isFacebookCdnUrl(url) || /facebook\.com|fb\.watch|instagram\.com/i.test(String(url))) {
    // Always override: captured browser UA is exactly what FB rate-limits.
    headers['User-Agent'] = FB_UA;
  } else if (!hasKey('User-Agent')) {
    headers['User-Agent'] = FB_UA;
  }
  if (!hasKey('Accept')) headers['Accept'] = '*/*';
  return headers;
}

module.exports = {
  muxAudioVideo,
  isAvailable,
  resolveFfmpeg,
  runFfmpeg,
  facebookMediaHeaders,
  isFacebookCdnUrl,
  FB_UA,
};
