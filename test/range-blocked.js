// Regression harness for "fixed the name but still can't download, while the
// native browser can" (tube-CDN report, e.g. mydaddy.cc / bigcdn.cc).
//
// Root cause: a native browser download starts with a PLAIN GET, but AiDM's
// first contact was always HEAD or `Range: bytes=0-0`. Hosts with WAF /
// mod_security / hotlink rules reject those probes with 401/403 while serving
// plain GETs fine — so AiDM reported "refused" for URLs the browser downloads
// without complaint.
//
// Shipped behavior under test:
//   1. probeRemote (src/engine/probe.js) retries once without Range on 401/403
//      and reports { acceptRanges:false, rangesBlocked:true } on plain-200.
//   2. DownloadEngine._probeFile does the same (headers-only plain GET,
//      nothing of the body read) and reports rangesBlocked + responseCookies.
//   3. A full DownloadTask against such a host completes byte-correct over a
//      single plain-GET connection (no Range ever sent).
//   4. Redirect chains that mint cookies mid-flight work end-to-end through
//      DownloadEngine.startDownload (jar replayed on later hops).
//
// Run: node test/range-blocked.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}

const { probeRemote } = require('../src/engine/probe');
const { DownloadEngine } = require('../src/download-engine');
const { DownloadTask } = require('../src/engine/task');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-rangeblocked-'));

function headersOf(obj) {
  const lower = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = String(v);
  return { get: (n) => lower[String(n).toLowerCase()] ?? null };
}
function stubRes({ status, headers = {}, url = 'http://x/' }) {
  return { status, headers: headersOf(headers), url, body: { cancel: async () => {} } };
}

(async () => {
// ── 1. probeRemote falls back to plain GET on 403 ──────────────────────────
{
  const seen = [];
  const fetchStub = async (url, init) => {
    seen.push({ range: (init.headers && (init.headers.Range || init.headers.range)) || null });
    if (seen.length === 1) return stubRes({ status: 403, headers: {} }); // ranged probe refused
    return stubRes({ status: 200, headers: { 'content-length': '777', 'content-type': 'video/mp4' } });
  };
  const info = await probeRemote('http://cdn.example/v.mp4', {
    headers: {}, fetchImpl: fetchStub, timeoutMs: 5000,
  });
  check('probeRemote retries without Range after 403', seen.length === 2 && seen[1].range === null);
  check('probeRemote reports plain-GET success', info.size === 777 && info.acceptRanges === false);
  check('probeRemote flags rangesBlocked', info.rangesBlocked === true);
}

// ── 2-4. live server: Range-hostile tube-CDN mock ──────────────────────────
const payload = Buffer.alloc(256 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xFF;

const server = http.createServer((req, res) => {
  // /cookie-start mints a session cookie then redirects (like /get_file/).
  if (req.url === '/cookie-start') {
    res.setHeader('Set-Cookie', 'sess=tok123; Path=/');
    res.writeHead(302, { Location: '/cookie-file' });
    res.end();
    return;
  }
  if (req.url === '/cookie-file') {
    const ok = (req.headers.cookie || '').includes('sess=tok123');
    if (!ok) { res.writeHead(403); res.end('forbidden'); return; }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(payload.length));
    res.writeHead(200);
    res.end(payload);
    return;
  }
  // Plain tube-CDN file: HEAD and any Range request are refused; a plain
  // browser-style GET serves the file.
  if (req.method === 'HEAD' || req.headers.range) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', String(payload.length));
  res.writeHead(200);
  res.end(payload);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

try {
  // ── 2. engine probe sees through the block ─────────────────────────────
  {
    const eng = new DownloadEngine();
    const meta = await eng.probeMeta(`${base}/video.mp4`, { Referer: `${base}/` });
    check('probeMeta plain-GET fallback status 200', meta.status === 200, `got ${meta.status}`);
    check('probeMeta reads size without Range', meta.contentLength === payload.length);
    check('probeMeta flags rangesBlocked', meta.rangesBlocked === true);
    check('probeMeta never claims Range support', meta.supportsRange === false);
  }

  // ── 3. full task completes with zero Range requests ────────────────────
  {
    let rangeSeen = 0;
    const origFetch = globalThis.fetch.bind(globalThis);
    const spyFetch = (url, init) => {
      const h = (init && init.headers) || {};
      if (h.Range || h.range) rangeSeen++;
      return origFetch(url, init);
    };
    const outDir = path.join(TMP, 'plain');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `${base}/video.mp4`,
      directory: outDir,
      filename: 'video.mp4',
      maxConnections: 8,
      fetch: spyFetch,
      onConflict: 'overwrite',
    });
    let failed = null;
    task.on('failed', e => { failed = e; });
    await task.start();
    const got = fs.readFileSync(path.join(outDir, 'video.mp4'));
    check('range-hostile host downloads byte-correct', !failed && got.equals(payload), `${got.length} B`);
    // The probe itself always tries Range once (then falls back); no SEGMENT
    // request may carry one on a rangesBlocked host.
    check('only the probe sends Range; segments stay plain', rangeSeen === 1, `${rangeSeen} ranged`);
  }

  // ── 4. redirect-minted cookies replayed end-to-end ─────────────────────
  {
    const eng = new DownloadEngine();
    const outDir = path.join(TMP, 'jar');
    fs.mkdirSync(outDir, { recursive: true });
    const fp = path.join(outDir, 'cookie.mp4');
    const done = new Promise((resolve) => {
      eng.on('download-complete', (d) => resolve({ ok: true, d }));
      eng.on('download-error', (d) => resolve({ ok: false, d }));
    });
    await eng.startDownload({
      id: 'jar-test', url: `${base}/cookie-start`, filepath: fp, totalSegments: 4, headers: {},
    });
    const res = await done;
    let bytes = -1;
    try { bytes = fs.statSync(res.ok ? (res.d.filepath || fp) : fp).size; } catch (e) {}
    check('redirect cookie jar completes download', res.ok && bytes === payload.length, `${bytes} B`);
  }
} finally {
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise(r => server.close(r));
}

console.log(`\nrange-blocked: ${pass} passed, ${fail} failed`);
// NOTE: exit via exitCode (natural loop drain), not process.exit(). The probe
// fallback cancels response bodies mid-stream; forcing exit in the same tick
// races undici's socket cleanup and trips a libuv assert on Windows.
process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('FATAL', e); process.exit(1); });
