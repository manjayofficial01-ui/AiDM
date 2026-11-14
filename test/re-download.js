// Regression harness for "downloading the same file a second time does nothing".
//
// findDuplicate() used to match ANY row with the same URL — including
// completed / errored / cancelled ones — so re-adding a finished link bounced
// off the dead row with `duplicate: true` and the UI said "Already in the
// download list". No second download was ever possible.
//
// Now terminal rows never match: a re-download creates a fresh row, and the
// engine's onConflict:'rename' saves it as "name (1).ext" without touching
// the first copy. LIVE rows (queued/downloading/paused) still dedupe — the
// original site-button + extension-capsule double-fire protection.
//
// Runs the real DownloadManager against a local HTTP server.
// Run: node test/re-download.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(ROOT, '.openclaw', 'tmp', 'aidm-redownload-' + process.pid);
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

// Range-capable server; `?slow=1` drips bytes so a second add lands while the
// first transfer is still running. /dead.bin 404s to build an errored row.
function startServer(totalBytes, dripBytes = 8 * 1024, dripMs = 30) {
  const data = Buffer.alloc(totalBytes);
  for (let i = 0; i < totalBytes; i++) data[i] = (i * 7 + (i >> 9)) & 0xFF;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/dead.bin') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('gone');
    }
    const slow = u.searchParams.has('slow');
    const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
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
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${status}`)); }, timeoutMs);
    const handler = () => {
      const dl = dm.downloads.get(id);
      if (dl && dl.status === status) { cleanup(); resolve(dl); }
    };
    const cleanup = () => {
      clearTimeout(timer);
      dm.off('download-complete', handler);
      dm.off('download-error', handler);
      dm.off('download-progress', handler);
      dm.off('download-updated', handler);
    };
    dm.on('download-complete', handler);
    dm.on('download-error', handler);
    dm.on('download-progress', handler);
    dm.on('download-updated', handler);
    handler();
  });
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
  const { server, data, port } = await startServer(512 * 1024);
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(TMP, '.aidm_settings.json'),
    JSON.stringify({ autoResume: false, defaultSegments: 4 }, null, 2));
  const saveDir = path.join(TMP, 'Downloads', 'AiDM');

  try {
    // ── 1. completed row must NOT block a re-download ────────────────────────
    console.log('── 1. re-download after completion ──');
    {
      const dm = new DownloadManager();
      const first = dm.addDownload({ url: `${base}/again.bin`, filename: 'again.bin' });
      check('first download is fresh', !first.duplicate, `id=${first.id}`);
      await waitForDownload(dm, first.id, 'completed');
      const firstPath = path.join(saveDir, 'again.bin');
      check('first copy on disk', fs.existsSync(firstPath));
      const firstSum = sha(fs.readFileSync(firstPath));

      const second = dm.addDownload({ url: `${base}/again.bin`, filename: 'again.bin' });
      check('re-download is NOT a duplicate', !second.duplicate);
      check('re-download is a NEW row', second.id !== first.id);
      const sec = await waitForDownload(dm, second.id, 'completed');
      const secondPath = path.join(saveDir, sec.filename || 'again (1).bin');
      check('second copy saved as renamed file', fs.existsSync(secondPath),
        path.basename(secondPath));
      check('first copy untouched', sha(fs.readFileSync(firstPath)) === firstSum);
      check('second copy byte-correct', sha(fs.readFileSync(secondPath)) === sha(data));
    }

    // ── 2. errored row must NOT block a re-download ──────────────────────────
    console.log('── 2. re-download after error ──');
    {
      const dm = new DownloadManager();
      const dead = dm.addDownload({ url: `${base}/dead.bin`, filename: 'dead.bin' });
      await waitForDownload(dm, dead.id, 'error');
      const retry = dm.addDownload({ url: `${base}/dead.bin`, filename: 'dead.bin' });
      check('re-add after error is NOT a duplicate', !retry.duplicate);
      check('re-add after error is a NEW row', retry.id !== dead.id);
      await waitForDownload(dm, retry.id, 'error'); // expected — 404 again
    }

    // ── 3. cancelled row must NOT block a re-download ────────────────────────
    console.log('── 3. re-download after cancel ──');
    {
      const dm = new DownloadManager();
      const a = dm.addDownload({ url: `${base}/cancel.bin?slow=1`, filename: 'cancel.bin' });
      await waitForDownload(dm, a.id, 'downloading');
      await sleep(400);
      dm.cancelDownload(a.id);
      await sleep(200);
      const again = dm.addDownload({ url: `${base}/cancel.bin`, filename: 'cancel.bin' });
      check('re-add after cancel is NOT a duplicate', !again.duplicate);
      check('re-add after cancel is a NEW row', again.id !== a.id);
      const done = await waitForDownload(dm, again.id, 'completed');
      check('re-download after cancel completes', done.status === 'completed');
    }

    // ── 4. LIVE rows still dedupe (downloading + paused) ─────────────────────
    console.log('── 4. live rows still dedupe ──');
    {
      const dm = new DownloadManager();
      const live = dm.addDownload({ url: `${base}/live.bin?slow=1`, filename: 'live.bin' });
      await waitForDownload(dm, live.id, 'downloading');
      const whileRunning = dm.addDownload({ url: `${base}/live.bin?slow=1`, filename: 'live.bin' });
      check('same URL while downloading → duplicate', whileRunning.duplicate === true);
      check('duplicate points at the SAME row', whileRunning.id === live.id);
      dm.pauseDownload(live.id);
      await sleep(250);
      const whilePaused = dm.addDownload({ url: `${base}/live.bin?slow=1`, filename: 'live.bin' });
      check('same URL while paused → duplicate', whilePaused.duplicate === true);
      dm.cancelDownload(live.id);
    }

    // ── 5. double-fire while queued (no slow URL): rapid same-URL pair ───────
    console.log('── 5. queued rows still dedupe ──');
    {
      const dm = new DownloadManager();
      dm.maxConcurrent = 1;
      const a = dm.addDownload({ url: `${base}/q1.bin?slow=1`, filename: 'q1.bin' });
      const b = dm.addDownload({ url: `${base}/q2.bin?slow=1`, filename: 'q2.bin' });
      const c = dm.addDownload({ url: `${base}/q2.bin?slow=1`, filename: 'q2.bin' });
      check('first row live', !a.duplicate);
      check('second queued row live', !b.duplicate);
      check('third (same as second) → duplicate', c.duplicate === true && c.id === b.id);
      dm.cancelDownload(a.id);
      dm.cancelDownload(b.id);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('HARNESS ERROR:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  }
})();
