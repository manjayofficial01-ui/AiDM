const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (e) {
  ffmpegPath = null;
}

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

function runFfmpeg(args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpeg();
    if (!bin) {
      reject(new Error('ffmpeg-static is not available'));
      return;
    }
    const child = spawn(bin, args, { windowsHide: true });
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

async function muxAudioVideo(videoPath, audioPath, outPath, opts = {}) {
  const args = [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0?',
    '-map', '1:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ];
  await runFfmpeg(args, opts);
  return outPath;
}

module.exports = { muxAudioVideo, isAvailable, resolveFfmpeg, runFfmpeg };