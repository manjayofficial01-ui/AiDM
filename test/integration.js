// Live integration test for AiDM's manager + engine.
// Runs the real DownloadManager against a local HTTP server and verifies the
// behaviors that used to be broken:
//   1. multi-segment download produces byte-correct output
//   2. pause stops all writes (in-flight retries used to keep downloading)
//   3. resume continues and completes
//   4. cancel deletes the file and NOTHING recreates it (ghost-download bug)
//   5. resume after a "restart" (fresh manager, engine has no state) works
//   6. _processQueue does not start 'queued-paused' rows
//
// All writes go to a scratch dir under the workspace (.openclaw/tmp), never to
// the user's real home. Run: node test/integration.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(ROOT, '.openclaw', 'tmp', 'aidm-integration-' + process.pid);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// DownloadManager reads settings/downloads from USERPROFILE — point it at the
// scratch dir BEFORE requiring the module.
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { DownloadManager } = require('../src/download-manager');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Test server ───────────────────────────────────────────────────────────────
// Serves a deterministic buffer with real Range support; `?slow=1` drips bytes
// so pause/cancel have time to land mid-transfer.
function startServer(totalBytes, dripBytes = 8 * 1024, dripMs = 30) {
  const data = Buffer.alloc(totalBytes);
  for (let i = 0; i < totalBytes; i++) data[i] = (i * 7 + (i >> 9)) & 0xFF;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const slow = u.searchParams.has('slow');
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': String(totalBytes) });
      return res.end();
    }
    let start = 0, end = totalBytes - 1, code = 200;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m && (m[1] || m[2])) {
        if (m[1]) start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), totalBytes - 1);
        code = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${totalBytes}`;
      }
    }
    headers['Content-Length'] = String(end - start + 1);
    res.writeHead(code, headers);
    let pos = start;
    const done = () => pos > end;
    if (slow) {
      const timer = setInterval(() => {
        if (done() || res.destroyed) { clearInterval(timer); try { res.end(); } catch (e) {} return; }
        const len = Math.min(dripBytes, end - pos + 1);
        res.write(data.subarray(pos, pos + len));
        pos += len;
        if (done()) { clearInterval(timer); res.end(); }
      }, dripMs);
      req.on('close', () => clearInterval(timer));
    } else {
      while (!done()) {
        const len = Math.min(64 * 1024, end - pos + 1);
        res.write(data.subarray(pos, pos + len));
        pos += len;
      }
      res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, data, port: server.address().port }));
  });
}

function waitForDownload(dm, id, status, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${status}`));
    }, timeoutMs);
    const handler = (data) => {
      if (data.id === id) {
        const dl = dm.downloads.get(id);
        if (dl && dl.status === status) { cleanup(); resolve(dl); }
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      dm.off('download-complete', handler);
      dm.off('download-error', handler);
      dm.off('download-paused', handler);
      dm.off('download-progress', handler);
    };
    dm.on('download-complete', handler);
    dm.on('download-error', handler);
    dm.on('download-paused', handler);
    dm.on('download-progress', handler);
    const dl = dm.downloads.get(id);
    if (dl && dl.status === status) { cleanup(); resolve(dl); }
  });
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
  const { server, data, port } = await startServer(1024 * 1024); // 1 MB
  const base = `http://127.0.0.1:${port}`;
  // Keep auto-resume off so tests drive every start explicitly.
  fs.writeFileSync(path.join(TMP, '.aidm_settings.json'),
    JSON.stringify({ autoResume: false, defaultSegments: 4 }, null, 2));

  try {
    // ── Test 1: multi-segment download is byte-correct ──────────────────────
    console.log('── 1. multi-segment download ──');
    {
      const dm = new DownloadManager();
      const added = dm.addDownload({ url: `${base}/dl-full.bin`, filename: 'full.bin' });
      await waitForDownload(dm, added.id, 'completed');
      const got = fs.readFileSync(path.join(TMP, 'Downloads', 'AiDM', 'full.bin'));
      check('byte-correct output', got.equals(data), `${got.length} bytes`);
      dm.engine.cancelDownload(added.id); // tidy engine state
    }

    // ── Test 2+3: pause stops all writes; resume finishes ───────────────────
    console.log('── 2/3. pause stops writes, resume completes ──');
    {
      const dm = new DownloadManager();
      const added = dm.addDownload({ url: `${base}/dl-pause.bin?slow=1`, filename: 'pause.bin' });
      const dl = dm.downloads.get(added.id);
      await waitForDownload(dm, added.id, 'downloading');
      await sleep(900); // let some bytes land
      dm.pauseDownload(added.id);
      await sleep(300);
      const pausedBytes = dl.downloaded;
      check('pause captured progress', pausedBytes > 0, `${pausedBytes} B`);
      await sleep(1500); // pending retry timers used to keep writing here
      const afterPause = dl.downloaded;
      check('no growth while paused', afterPause === pausedBytes,
        `${afterPause} vs ${pausedBytes}`);
      dm.resumeDownload(added.id);
      await waitForDownload(dm, added.id, 'completed');
      const got = fs.readFileSync(path.join(TMP, 'Downloads', 'AiDM', 'pause.bin'));
      check('resumed file byte-correct', got.equals(data), `${got.length} bytes`);
    }

    // ── Test 4: cancel deletes file; nothing resurrects it ──────────────────
    console.log('── 4. cancel leaves no ghost ──');
    {
      const dm = new DownloadManager();
      const added = dm.addDownload({ url: `${base}/dl-cancel.bin?slow=1`, filename: 'cancel.bin' });
      const dl = dm.downloads.get(added.id);
      await waitForDownload(dm, added.id, 'downloading');
      await sleep(900);
      dm.cancelDownload(added.id);
      const p = path.join(TMP, 'Downloads', 'AiDM', 'cancel.bin');
      check('file deleted on cancel', !fs.existsSync(p));
      await sleep(3500); // a pending retry used to recreate + keep downloading
      check('file stays deleted (no ghost)', !fs.existsSync(p) && !dm.downloads.has(added.id));
      check('engine state cleaned', !dm.engine.getDownload(added.id));
    }

    // ── Test 5: resume after "restart" (engine has no state) ────────────────
    console.log('── 5. resume after restart ──');
    {
      const dm1 = new DownloadManager();
      const added = dm1.addDownload({ url: `${base}/file.bin?slow=1`, filename: 'restart.bin' });
      const dl = dm1.downloads.get(added.id);
      await waitForDownload(dm1, added.id, 'downloading');
      await sleep(1200);
      dm1.pauseDownload(added.id);
      await sleep(200);
      const pausedBytes = dl.downloaded;
      dm1._persistDownloads();
      // NOTE: do NOT engine.cancelDownload here — it deletes the partial file
      // by design. A real restart leaves the file on disk, so we just drop it.

      // "Restart": a fresh manager loads the persisted row (autoResume off).
      const dm2 = new DownloadManager();
      const loaded = dm2.downloads.get(added.id);
      check('row survived restart as paused', !!loaded && loaded.status === 'paused');
      check('progress survived restart', loaded && loaded.downloaded > 0,
        loaded && `${loaded.downloaded} B`);

      let firstProgress = null;
      dm2.on('download-progress', (d) => { if (d.id === added.id && firstProgress === null) firstProgress = d.downloaded; });
      dm2.resumeDownload(added.id);
      await waitForDownload(dm2, added.id, 'completed');
      check('resume started near paused offset', firstProgress !== null && firstProgress >= pausedBytes * 0.8,
        firstProgress !== null ? `first event at ${firstProgress} B, paused at ${pausedBytes} B` : 'no progress');
      const got = fs.readFileSync(path.join(TMP, 'Downloads', 'AiDM', 'restart.bin'));
      check('restarted file byte-correct', got.equals(data), `${got.length} bytes`);
    }

    // ── Test 6: queued-paused rows must not start via _processQueue ─────────
    console.log('── 6. queued-paused stays paused ──');
    {
      const dm = new DownloadManager();
      // slow drip so the row is still mid-flight when asserted
      const added = dm.queueDownload({ url: `${base}/dl-queue.bin?slow=1`, filename: 'q.bin' });
      dm.pauseQueue();
      dm._processQueue();
      await sleep(400);
      const dl = dm.downloads.get(added.id);
      check('queued-paused not started by _processQueue', dl.status === 'queued-paused', dl.status);
      dm.startQueue();
      await sleep(400);
      check('startQueue resumes it', ['connecting', 'downloading'].includes(dm.downloads.get(added.id).status),
        dm.downloads.get(added.id).status);
      dm.cancelDownload(added.id);
    }
  } finally {
    server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
