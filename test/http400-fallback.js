// Regression harness for "Download failed: Server responded with HTTP 400"
// (strict-CDN report; same "works in the browser, fails in AiDM" family as
// the 401/403 Range-block case, except the host answers its WAF rejection
// with 400 instead of 401/403).
//
// Root cause chain:
//   1. probeRemote (src/engine/probe.js) probed with `Range: bytes=0-0` and
//      only fell back to a plain browser-style GET on 401/403 - a 400 from
//      the same WAF/hotlink rules was terminal (classifyHttpStatus treats
//      400 as permanent), so the task died before a single byte flowed.
//   2. Mid-download, a ranged worker GET that drew a 400 (expired signed
//      URL, strict If-Range handling) hard-failed the task instead of
//      collapsing to the proven single plain-connection restart.
//   3. The manager's friendly-error mapping covered 404/410/401/403/501 but
//      not 400, so users saw the raw engine string.
//
// Shipped behavior under test:
//   1. probeRemote falls back to plain GET on 400 and reports
//      { acceptRanges:false, rangesBlocked:true } on plain-200.
//   2. DownloadEngine._probeFile treats a 400 HEAD/Range probe like
//      401/403 and falls back to a headers-only plain GET.
//   3. A full DownloadTask against a host that 400s every RANGED request
//      (but serves plain GETs) completes byte-correct: the mid-download
//      400 converts to RANGE_UNSUPPORTED and the task restarts over one
//      plain connection.
//   4. A host that 400s EVERYTHING still fails cleanly with "HTTP 400".
//   5. friendlyHttpMessage / badRequestMessage map a 400 to friendly
//      guidance (no raw "Server responded with HTTP 400" in the UI).
//
// Run: node test/http400-fallback.js
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

// Scratch dirs live in os.tmpdir() like the other harnesses (no cleanup
// needed - the OS temp dir is ephemeral by design).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-http400-'));

// Extract a shipped top-level function from a source file (same technique as
// test/dead-link-guard.js) so the harness tests the real code, not a copy.
function grab(srcFile, name) {
  const src = fs.readFileSync(srcFile, 'utf8');
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in ' + srcFile);
  const j = src.indexOf('{', i);
  let d = 0, inRe = false, inStr = null, esc = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (inRe) {
      if (c === '\\') esc = true;
      else if (c === '/') inRe = false;
      else if (c === '[') { const e = src.indexOf(']', k); if (e > 0) k = e; }
      continue;
    }
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && /[(,=:?!&|{;\[]/.test(src[k - 1] || '(')) { inRe = true; continue; }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const MANAGER = path.join(__dirname, '..', 'src', 'download-manager.js');

function headersOf(obj) {
  const lower = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = String(v);
  return { get: (n) => lower[String(n).toLowerCase()] ?? null };
}
function stubRes({ status, headers = {}, url = 'http://x/' }) {
  return { status, headers: headersOf(headers), url, body: { cancel: async () => {} } };
}

(async () => {
// 1. probeRemote falls back to plain GET on 400 ------------------------------------------------
{
  const seen = [];
  const fetchStub = async (url, init) => {
    seen.push({ range: (init.headers && (init.headers.Range || init.headers.range)) || null });
    if (seen.length === 1) return stubRes({ status: 400, headers: {} }); // ranged probe refused with 400
    return stubRes({ status: 200, headers: { 'content-length': '777', 'content-type': 'video/mp4' } });
  };
  const info = await probeRemote('http://cdn.example/v.mp4', {
    headers: {}, fetchImpl: fetchStub, timeoutMs: 5000,
  });
  check('probeRemote retries without Range after 400', seen.length === 2 && seen[1].range === null);
  check('probeRemote reports plain-GET success', info.size === 777 && info.acceptRanges === false);
  check('probeRemote flags rangesBlocked on 400 host', info.rangesBlocked === true);
}

// 2. probeRemote still fails when the host 400s everything ------------------------------------
{
  const fetchStub = async () => stubRes({ status: 400, headers: {} });
  let threw = null;
  try {
    await probeRemote('http://cdn.example/v.mp4', { headers: {}, fetchImpl: fetchStub, timeoutMs: 5000 });
  } catch (e) { threw = e; }
  check('probeRemote throws HTTP 400 when plain GET also refused',
    threw && /HTTP 400/.test(threw.message), threw && threw.message);
}

// 3-6. live servers ----------------------------------------------------------------------------
// 8 MB so the default split (initialConnections 4, minSplitSize 1 MB) really
// produces segments starting past byte 0 - that is what makes the server's
// "400 every ranged request with start > 0" deterministic.
const PAYLOAD_BYTES = 8 * 1024 * 1024;
const payload = Buffer.alloc(PAYLOAD_BYTES);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xFF;

// Server A: the probe's bytes=0-0 slice gets a 206, but every RANGED
// request with start > 0 gets a 400 (strict WAF), plain GETs succeed -
// a host whose WAF tolerates the probe yet rejects real segment requests.
const serverA = http.createServer((req, res) => {
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-/.exec(range);
    const start = m ? Number(m[1]) : 0;
    if (start > 0) { res.writeHead(400); res.end('bad request'); return; }
    const requestedEnd = /bytes=\d+-(\d+)/.exec(range);
    const last = requestedEnd ? Math.min(Number(requestedEnd[1]), payload.length - 1) : payload.length - 1;
    const slice = payload.subarray(start, last + 1);
    res.setHeader('Content-Range', `bytes ${start}-${last}/${payload.length}`);
    res.setHeader('Content-Length', String(slice.length));
    res.setHeader('Content-Type', 'video/mp4');
    res.writeHead(206);
    res.end(slice);
    return;
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', String(payload.length));
  res.writeHead(200);
  res.end(payload);
});

// Server B: 400s EVERYTHING - a malformed/expired link.
const serverB = http.createServer((req, res) => {
  res.writeHead(400);
  res.end('bad request');
});

await new Promise(r => serverA.listen(0, '127.0.0.1', r));
await new Promise(r => serverB.listen(0, '127.0.0.1', r));
const baseA = `http://127.0.0.1:${serverA.address().port}`;
const baseB = `http://127.0.0.1:${serverB.address().port}`;

try {
  // 3. engine probe sees through the 400-Range block ------------------------------------------
  {
    const eng = new DownloadEngine();
    const meta = await eng.probeMeta(`${baseA}/video.mp4`, { Referer: `${baseA}/` });
    // The probe's bytes=0-0 slice IS answered with 206 by this WAF, so the
    // probe honestly reports Range support - only start>0 requests get 400.
    // Discovering that is the mid-download restart path's job (test 5).
    check('probeMeta reads size from the 206 slice', meta.status === 200 && meta.contentLength === payload.length, `got ${meta.status}`);
    check('probeMeta reports Range support (slice 0-0 answered 206)', meta.supportsRange === true);
  }

  // 4. engine probe honestly reports a host that 400s everything -------------------------------
  {
    const eng = new DownloadEngine();
    const meta = await eng.probeMeta(`${baseB}/gone.mp4`, {});
    check('probeMeta surfaces status 400 for a dead link', meta.status === 400, `got ${meta.status}`);
  }

  // 5. full task: mid-download 400 converts to a single-connection restart ---------------------
  {
    let rangeSeen = 0;
    const origFetch = globalThis.fetch.bind(globalThis);
    const spyFetch = (url, init) => {
      const h = (init && init.headers) || {};
      if (h.Range || h.range) rangeSeen++;
      return origFetch(url, init);
    };
    const outDir = path.join(TMP, 'restart');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `${baseA}/video.mp4`,
      directory: outDir,
      filename: 'video.mp4',
      maxConnections: 8,
      fetch: spyFetch,
      onConflict: 'overwrite',
    });
    let failed = null;
    task.on('failed', e => { failed = e; });
    const finalState = await task.start();
    const got = fs.readFileSync(path.join(outDir, 'video.mp4'));
    check('ranged-400 host completes after single-connection restart',
      !failed && got.equals(payload), `${got.length} B, state=${finalState}`);
    check('restart path used at most MAX_RESTARTS',
      task.restarts >= 1 && task.restarts <= 2, `${task.restarts} restarts`);
    // Pass 1: task probe (1) + up to 4 concurrent segment GETs that each hit
    // the 400. Restart pass: probe may send Range once more (1), then the
    // collapsed single connection stays plain. A runaway retry loop would
    // push this far beyond 6.
    check('ranged requests bounded (no retry storm)', rangeSeen <= 6, `${rangeSeen} ranged requests total`);
    check('restart collapsed to a single connection',
      task.getProgress().targetConnections === 1, `target=${task.getProgress().targetConnections}`);
  }

  // 6. full task against an all-400 host fails cleanly ------------------------------------------
  {
    const outDir = path.join(TMP, 'dead');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `${baseB}/gone.mp4`,
      directory: outDir,
      filename: 'gone.mp4',
      fetch: globalThis.fetch.bind(globalThis),
      onConflict: 'overwrite',
    });
    let failed = null;
    task.on('failed', e => { failed = e; });
    const finalState = await task.start();
    check('all-400 host fails (no infinite retries)',
      finalState === 'failed' && failed && /HTTP 400/.test(failed.message),
      failed && failed.message);
  }

  // 7. friendly message mapping (shipped functions, not copies) ---------------------------------
  {
    const badRequestMessage = new Function(grab(MANAGER, 'badRequestMessage') + '\nreturn badRequestMessage;')();
    const msg = badRequestMessage();
    check('badRequestMessage explains HTTP 400', /HTTP 400/.test(msg) && /link/i.test(msg), msg.slice(0, 60) + '...');

    // friendlyHttpMessage references its sibling helpers; inject them.
    const friendlyHttpMessage = new Function(
      'accessDeniedMessage', 'methodBlockedMessage', 'deadLinkMessage', 'badRequestMessage',
      grab(MANAGER, 'friendlyHttpMessage') + '\nreturn friendlyHttpMessage;'
    )(function () { return 'ACCESS_DENIED'; }, function () { return 'METHOD_BLOCKED'; },
      function () { return 'DEAD_LINK'; }, badRequestMessage);
    check('friendlyHttpMessage maps 400 to friendly guidance',
      friendlyHttpMessage('Server responded with HTTP 400') === msg);
    check('friendlyHttpMessage leaves unrelated errors untouched',
      friendlyHttpMessage('Disk full') === 'Disk full');
    check('friendlyHttpMessage still maps 404 to deadLink',
      friendlyHttpMessage('Server responded with HTTP 404') === 'DEAD_LINK');
    check('friendlyHttpMessage still maps 403 to accessDenied',
      friendlyHttpMessage('Server responded with HTTP 403') === 'ACCESS_DENIED');

    // Both manager call sites must include 400 in their status class.
    const src = fs.readFileSync(MANAGER, 'utf8');
    const wired = (src.match(/HTTP \(404\|410\|401\|403\|400\|501\)/g) || []).length;
    check('both manager error surfaces include 400 in the status class', wired === 2, `${wired} sites`);
    check('_enforceProbeGuards handles meta.status 400', src.includes('meta.status === 400'));
  }
} finally {
  serverA.close();
  serverB.close();
}

console.log(`\nhttp400-fallback: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });