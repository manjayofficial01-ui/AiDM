// Scratch harness (not part of the app): run the REAL /api/resolve-youtube
// handler against the real yt-dlp, on a scratch port, with a stub download
// manager. Proves the endpoint end-to-end without touching the user's running
// AiDM (4.3.9) on port 18765.
'use strict';
const { EventEmitter } = require('events');
const { IPCServer } = require('../src/server.js');

const dm = new EventEmitter();
let detected = null;
dm.on('video-detected', (p) => { detected = p; });

const srv = new IPCServer(dm);
srv.port = 18877;
srv.start();

const URLs = process.argv.slice(2);
if (!URLs.length) URLs.push('https://www.youtube.com/watch?v=aqz-KE-bpKQ');

(async () => {
  await new Promise(r => setTimeout(r, 700));
  for (const url of URLs) {
    const t0 = Date.now();
    const resp = await fetch('http://127.0.0.1:18877/api/resolve-youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await resp.json().catch(() => null);
    const ms = Date.now() - t0;
    console.log('\nURL   :', url);
    console.log('HTTP  :', resp.status, '(' + ms + ' ms)');
    console.log('BODY  :', JSON.stringify(data && { ...data, videos: undefined }, null, 0).slice(0, 300));
    if (data && Array.isArray(data.videos)) {
      console.log('QUALITIES (' + data.videos.length + '):');
      for (const v of data.videos) {
        console.log('   ' + String(v.quality).padEnd(7),
          String(v.resolution || '-').padEnd(11),
          (v.size ? (v.size / 1048576).toFixed(1) + ' MB' : '?').padEnd(10),
          v.merged ? 'merged (yt-dlp)' : 'single file',
          '|', v.filename);
      }
      console.log('video-detected payload:', detected
        ? JSON.stringify({ pageUrl: detected.pageUrl, title: (detected.pageTitle || '').slice(0, 40), videos: detected.videos.length, duration: detected.duration })
        : 'NOT EMITTED');
    }

    // Phase 2: actually run the handoff with the row the endpoint returned —
    // the probe above is bot-checked here, so this proves the fallback row
    // ("Best available") still downloads and merges for real.
    if (data && data.videos && data.videos.length) {
      const ytdlp = require('../src/yt-dlp');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { execFileSync } = require('child_process');
      const v = data.videos[0];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-live-'));
      const tpl = path.join(dir, 'live.yt%(ext)s');
      console.log('\nDOWNLOAD with format "' + v.ytFormat.formatId + '" into ' + dir);
      let last = 0;
      const t1 = Date.now();
      try {
        await ytdlp.download({
          url: v.ytUrl,
          formatSpec: v.ytFormat.formatId,
          outputTemplate: tpl,
          timeoutMs: 600000,
          onProgress: (p) => {
            if (p.percent - last >= 25) { last = p.percent; console.log('   progress ' + p.percent + '%  ' + (p.downloaded / 1048576).toFixed(1) + ' MB'); }
          },
        });
        const files = fs.readdirSync(dir);
        console.log('   files:', files.join(', '));
        const out = path.join(dir, files[0]);
        console.log('   size :', (fs.statSync(out).size / 1048576).toFixed(1) + ' MB', 'in', ((Date.now() - t1) / 1000).toFixed(0) + 's');
        const ff = require('../src/media-mux').resolveFfmpeg();
        const info = execFileSync(ff, ['-hide_banner', '-i', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        console.log('   streams:');
        console.log((info.match(/Stream #.*/g) || ['(none)']).map(s => '     ' + s.trim()).join('\n'));
      } catch (e) {
        console.log('   DOWNLOAD FAILED:', e.code, e.message);
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.log('   (temp left at ' + dir + ')'); }
      }
    }
  }
  srv.stop();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
