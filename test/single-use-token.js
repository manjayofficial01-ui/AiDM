// Single-use / one-shot signed attachment URLs must NOT be multi-probed.
//
// A Gmail attachment (mail-attachment.googleusercontent.com/…?…&saddbat=…) and
// the Drive usercontent endpoint carry a token that the FIRST request spends.
// The browser fetches the file with ONE plain GET and works; AiDM used to send
// HEAD → Range → Range → plain-GET probes (manager) AND another `Range: bytes=0-0`
// probe inside DownloadTask.prepare() — the token was long spent by the time the
// real download fired, so the server answered HTTP 400. That is the exact
// "normal Chrome downloads it, AiDM 400s" bug.
//
// The fix has three layers, all exercised here:
//   1. isSingleUseTokenUrl() classifies the Gmail/Drive class (no false positives).
//   2. DownloadManager._resolveFilename() SHORT-CIRCUITS: single-connection
//      synthetic meta, no manager probe, and flags skipProbe.
//   3. DownloadTask with skipProbe skips its OWN Range probe and streams ONE
//      plain GET — proven against a live mock server that 400s every request
//      after the first (i.e. a spent one-shot token).
//
// Run: node test/single-use-token.js
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { isSingleUseTokenUrl, isGmailAttachmentEntryUrl, hasSingleUseTokenParam } = require('../src/url-hygiene');
const { DownloadManager } = require('../src/download-manager');
const { DownloadEngine } = require('../src/download-engine');
const { DownloadTask } = require('../src/engine/task');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-single-use-'));

let pass = 0, fail = 0;
const pending = [];
// Throw-style check: a thrown error (or rejected promise) fails the check.
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { pass++; console.log('  OK  ', name); },
        (e) => { fail++; console.log('  FAIL', name, '—', e.message); }
      ));
      return;
    }
    pass++; console.log('  OK  ', name);
  } catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}
// Boolean-style check (for async server assertions).
function checkCond(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}

// The exact URL the user reported (token truncated, as pasted).
const GMAIL_SADDBAT = 'https://mail-attachment.googleusercontent.com/attachment/u/7/?ui=2&ik=376495d32f&attid=0.1&permmsgid=msg-f:1877767227827513920&th=1a0f2b5849876a40&view=att&disp=safe&realattid=f_muo771zz0&zw&saddbat=ANGjdJ-abc123';
const GMAIL_REALATTID = 'https://mail-attachment.googleusercontent.com/attachment/u/0/?ui=2&ik=x&attid=0.1&view=att&realattid=f_abc&zw';
const DRIVE_USERCONTENT = 'https://drive.usercontent.google.com/download?id=ABC&export=download&confirm=t';
// Gmail's pre-redirect attachment endpoint: same token family, reusable entry
// point (each request mints a fresh one-shot redirect target).
const GMAIL_ENTRY = 'https://mail.google.com/mail/u/0/?ui=2&ik=x&attid=0.1&permmsgid=msg-a&th=abc&view=att&disp=safe&realattid=f_abc&zw';
const GMAIL_UI = 'https://mail.google.com/mail/u/0/#inbox';

console.log('── 1. isSingleUseTokenUrl classifier ──');
check('matches Gmail attachment URL with saddbat token', () => {
  assert.strictEqual(isSingleUseTokenUrl(GMAIL_SADDBAT), true);
});
check('matches Gmail attachment realattid + view=att', () => {
  assert.strictEqual(isSingleUseTokenUrl(GMAIL_REALATTID), true);
});
check('matches Drive usercontent download endpoint', () => {
  assert.strictEqual(isSingleUseTokenUrl(DRIVE_USERCONTENT), true);
});
check('matches Gmail mail.google.com attachment entry (attid + view=att)', () => {
  assert.strictEqual(isGmailAttachmentEntryUrl(GMAIL_ENTRY), true);
});
check('bare Gmail UI is NOT an attachment entry', () => {
  assert.strictEqual(isGmailAttachmentEntryUrl(GMAIL_UI), false);
  assert.strictEqual(isGmailAttachmentEntryUrl('https://example.com/a?attid=1&view=att'), false);
});

const NEGATIVES = [
  ['ordinary pdf', 'https://example.com/invoice.pdf'],
  ['drive web page (resolved by resolver, not a one-shot token)', 'https://drive.google.com/uc?export=download&id=ABC'],
  ['youtube', 'https://youtube.com/watch?v=abc'],
  ['gcs bucket (token valid for a window, not single-shot)', 'https://storage.googleapis.com/bucket/file.zip'],
  ['non-http', 'ftp://host/file'],
  ['empty', ''],
  ['null', null],
  ['azure sas (multi-use within expiry)', 'https://host.blob.core.windows.net/c?sig=Z&se=2026-12-31'],
  ['aws s3 presigned (multi-use within expiry)', 'https://bucket.s3.amazonaws.com/x?X-Amz-Signature=Z'],
];
NEGATIVES.forEach(([label, u]) => {
  check('does NOT match ' + label, () => {
    assert.strictEqual(isSingleUseTokenUrl(u), false, 'url: ' + String(u).slice(0, 50));
  });
});
check('hasSingleUseTokenParam catches saddbat on any host', () => {
  assert.strictEqual(hasSingleUseTokenParam('https://x.test/y?a=1&saddbat=ZZ'), true);
  assert.strictEqual(hasSingleUseTokenParam('https://x.test/y?a=1'), false);
});

console.log('── 2. manager skips the network probe for single-use tokens ──');
check('Gmail attachment: short-circuits to single-connection, probeMeta never called', () => {
  let probeCalled = false;
  const mgr = {
    emits: [],
    emit(ev) { this.emits.push(ev); },
    engine: {
      probeMeta() {
        probeCalled = true;
        throw new Error('probeMeta must NOT be called for single-use tokens');
      },
    },
  };
  const download = {
    id: 'dl-g', url: GMAIL_SADDBAT, filename: 'my-invoice.pdf', status: 'downloading',
    headers: {}, _nameResolved: false, downloaded: 0, isHls: false, isDash: false,
    singleConnection: false, resumable: true,
  };
  return DownloadManager.prototype._resolveFilename.call(mgr, download, {}).then((meta) => {
    assert.strictEqual(probeCalled, false, 'probeMeta must not be invoked');
    assert.strictEqual(download._nameResolved, true, 'row marked name-resolved');
    assert.strictEqual(download.singleConnection, true, 'row forced to single connection');
    assert.strictEqual(download.resumable, false, 'row marked non-resumable');
    assert.strictEqual(download.skipProbe, true, 'row flagged skipProbe for the engine');
    assert.ok(meta && meta.singleConnection === true, 'meta carries singleConnection:true');
    assert.strictEqual(meta.status, 200, 'meta status 200');
    assert.ok(mgr.emits.includes('download-updated'), 'emits download-updated');
    assert.strictEqual(download.filename, 'my-invoice.pdf', 'browser-supplied filename preserved');
  });
});
check('ordinary URL still probes (path NOT short-circuited)', () => {
  let probeCalled = false;
  const mgr = {
    emits: [],
    emit() {},
    _persistDownloads() {},
    _processQueue() {},
    _applyProbeResult() {},
    _enforceProbeGuards() { return null; },
    downloads: { has() { return true; } },
    engine: {
      probeMeta() {
        probeCalled = true;
        return Promise.resolve({ kind: 'file', meta: { status: 200, contentLength: 10 }, hlsSize: null });
      },
    },
  };
  const download = {
    id: 'dl-o', url: 'https://example.com/invoice.pdf', filename: 'invoice.pdf', status: 'downloading',
    headers: {}, _nameResolved: false, downloaded: 0, isHls: false, isDash: false,
    singleConnection: false, resumable: true,
  };
  return DownloadManager.prototype._resolveFilename.call(mgr, download, {}).then(() => {
    assert.strictEqual(probeCalled, true, 'probeMeta must be invoked for ordinary URLs');
    assert.strictEqual(download.singleConnection, false, 'ordinary url stays multi-connection');
    assert.notStrictEqual(download.skipProbe, true, 'ordinary url must NOT set skipProbe');
  });
});
check('Gmail mail.google.com entry also skips the network probe', () => {
  let probeCalled = false;
  const mgr = {
    emits: [],
    emit(ev) { this.emits.push(ev); },
    engine: {
      probeMeta() {
        probeCalled = true;
        throw new Error('probeMeta must NOT be called for Gmail attachment entries');
      },
    },
  };
  const download = {
    id: 'dl-ge', url: GMAIL_ENTRY, filename: 'my-invoice.pdf', status: 'downloading',
    headers: {}, _nameResolved: false, downloaded: 0, isHls: false, isDash: false,
    singleConnection: false, resumable: true,
  };
  return DownloadManager.prototype._resolveFilename.call(mgr, download, {}).then((meta) => {
    assert.strictEqual(probeCalled, false, 'probeMeta must not be invoked');
    assert.strictEqual(download.singleConnection, true, 'row forced to single connection');
    assert.strictEqual(download.skipProbe, true, 'row flagged skipProbe for the engine');
    assert.ok(meta && meta.singleConnection === true, 'meta carries singleConnection:true');
  });
});

// ── 3. live mock: a server whose token is spent after the FIRST request ─────
// Serves the payload on request #1 (whatever its headers); answers HTTP 400 to
// every later request — exactly how a one-shot Gmail attachment token behaves.
const payload = Buffer.alloc(128 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 5 + 1) & 0xff;

function makeTokenServer() {
  let reqCount = 0;
  const ranges = [];
  const server = http.createServer((req, res) => {
    reqCount++;
    ranges.push(!!req.headers.range);
    if (reqCount > 1) { res.writeHead(400); res.end('token spent'); return; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(payload.length));
    res.writeHead(200);
    res.end(payload);
  });
  return { server, stats: () => ({ reqCount, ranges }) };
}

(async () => {
  await Promise.all(pending);

  console.log('── 3. DownloadTask with skipProbe: exactly one plain GET ──');
  {
    const { server, stats } = makeTokenServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/attachment/u/7/?ui=2&saddbat=ANGjdJ-xyz`;
    const outDir = path.join(TMP, 'with-skip');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url, directory: outDir, filename: 'gmail-attachment.pdf',
      skipProbe: true, singleConnection: true, maxConnections: 8,
      fetch: globalThis.fetch, onConflict: 'overwrite',
    });
    let failed = null;
    task.on('failed', (e) => { failed = e; });
    await task.start();
    const s = stats();
    let got = null;
    try { got = fs.readFileSync(path.join(outDir, 'gmail-attachment.pdf')); } catch (e) {}
    checkCond('skipProbe: exactly ONE request reaches the server', s.reqCount === 1, `reqs=${s.reqCount}`);
    checkCond('skipProbe: that request is a plain GET (no Range)', s.ranges[0] === false, `range=${s.ranges[0]}`);
    checkCond('skipProbe: file downloads byte-correct', !failed && !!got && got.equals(payload), got ? `${got.length} B` : 'no file');
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  console.log('── 4. control (NO skipProbe): the probe spends the token, download 400s ──');
  {
    const { server, stats } = makeTokenServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/attachment/u/7/?saddbat=ANGjdJ-xyz`;
    const outDir = path.join(TMP, 'no-skip');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url, directory: outDir, filename: 'gmail-attachment.pdf',
      maxConnections: 8, fetch: globalThis.fetch, onConflict: 'overwrite',
    });
    let failed = null;
    task.on('failed', (e) => { failed = e; });
    await task.start();
    const s = stats();
    checkCond('control: the probe spends the token so the download fails',
      !!failed && s.reqCount >= 2, `reqs=${s.reqCount} failed=${!!failed}`);
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  console.log('── 5. engine forwards skipProbe end-to-end ──');
  {
    const { server, stats } = makeTokenServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/attachment/u/7/?saddbat=ANGjdJ-xyz`;
    const eng = new DownloadEngine();
    const outDir = path.join(TMP, 'engine');
    fs.mkdirSync(outDir, { recursive: true });
    const fp = path.join(outDir, 'gmail-attachment.pdf');
    const done = new Promise((resolve) => {
      eng.on('download-complete', (d) => resolve({ ok: true, d }));
      eng.on('download-error', (d) => resolve({ ok: false, d }));
    });
    await eng.startDownload({
      id: 'gmail-engine-test', url, filepath: fp, totalSegments: 8,
      headers: {}, singleConnection: true, skipProbe: true,
    });
    const res = await done;
    const s = stats();
    let bytes = -1;
    try { bytes = fs.statSync(res.ok ? (res.d.filepath || fp) : fp).size; } catch (e) {}
    checkCond('engine.startDownload honours skipProbe: one request, byte-correct',
      res.ok && s.reqCount === 1 && bytes === payload.length, `reqs=${s.reqCount} bytes=${bytes}`);
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  // 6. shipped extension source: single-use token guard routes Gmail/Drive to
  // AiDM via the reusable entry URL (not the spent finalUrl) with session
  // cookies, and only falls back to Chrome for truly non-reusable tokens.
  {
    const extSource = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'background.js'), 'utf8');
    check('intercept guard detects single-use token URLs', () => {
      assert.ok(extSource.includes('isSingleUseTokenUrl(targetUrl) || isGmailAttachmentEntryUrl(targetUrl)'));
    });
    check('Gmail entry URLs routed to AiDM via gmailDriveOverride', () => {
      assert.ok(extSource.includes('gmailDriveOverride'));
      assert.ok(extSource.includes('isGmailAttachmentEntryUrl(originalUrl)'));
    });
    check('extension defines isGmailAttachmentEntryUrl (mirrors url-hygiene)', () => {
      assert.ok(extSource.includes('function isGmailAttachmentEntryUrl'));
    });
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log(`\nsingle-use-token: ${pass} passed, ${fail} failed`);
  // Natural loop drain (see test/range-blocked.js): forcing exit in the same
  // tick races undici socket cleanup after mid-stream body cancels.
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
