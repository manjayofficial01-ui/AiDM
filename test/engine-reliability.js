// Team E — transport reliability regression suite.
//
// Everything runs against tiny local http servers on 127.0.0.1:0 that serve
// controlled responses (ranged, non-ranged, lying, truncated, slow, 404/500).
// No real network, no Electron.
//
// Covers:
//   1. ranged multi-segment happy path -> byte-exact file
//   2. server that ignores Range -> collapses to one connection, still correct
//   3. server that promises ranges on the probe then ignores them mid-flight
//   4. truncated body -> error, never a false download-complete
//   5. a finished file is NEVER deleted by a second startDownload
//   6. resume from persisted offsets -> correct final file
//   7. cancel leaves no leaked interval / retry timer
//   8. singleConnection / resumable:false are honoured
//   9. HLS picks a variant that actually carries audio and reports geometry
//  10. SegmentManager.restore clamps to the real size and fills gaps
//
// Run: node test/engine-reliability.js
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { DownloadTask } = require('../src/engine/task');
const { SegmentManager } = require('../src/engine/segments');
const { DownloadEngine, pickHlsVariant, parseHlsAudioGroups } = require('../src/download-engine');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-reliability-'));

// ── helpers ─────────────────────────────────────────────────────────────────
function makePayload(n) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 31 + (i >> 7)) & 0xff;
  return buf;
}

/** Start a server. `handler(req, res, payload)`. */
function startServer(handler, payload) {
  const server = http.createServer((req, res) => handler(req, res, payload));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function stopServer(server) {
  if (server.closeAllConnections) server.closeAllConnections();
  return new Promise((r) => server.close(r));
}
function readRange(req) {
  const range = req.headers.range;
  if (!range) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m || (!m[1] && !m[2])) return null;
  return { start: m[1] ? parseInt(m[1], 10) : 0, end: m[2] ? parseInt(m[2], 10) : null };
}
function sendPartial(res, payload, start, end) {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
  res.setHeader('Content-Length', String(end - start + 1));
  res.writeHead(206);
  res.end(payload.subarray(start, end + 1));
}
function sendFull(res, payload) {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(payload.length));
  res.writeHead(200);
  res.end(payload);
}

const FAST_RETRY = { maxTries: 3, baseDelayMs: 20, maxDelayMs: 60, factor: 2 };

// ── 1. ranged multi-segment happy path ──────────────────────────────────────
(async () => {
console.log('\n-- 1. ranged multi-segment download --');
{
  const payload = makePayload(512 * 1024);
  const seen = [];
  const { server, port } = await startServer((req, res) => {
    const r = readRange(req);
    if (!r) return sendFull(res, payload);
    seen.push(r);
    sendPartial(res, payload, r.start, r.end === null ? payload.length - 1 : Math.min(r.end, payload.length - 1));
  });
  try {
    const outDir = path.join(TMP, 'ranged');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir,
      filename: 'f.bin',
      maxConnections: 4,
      initialConnections: 4,
      minSplitSize: 64 * 1024,
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    await task.start();
    const got = fs.readFileSync(path.join(outDir, 'f.bin'));
    check('multi-segment output byte-exact', got.equals(payload), `${got.length} B`);
    check('more than one range request issued', seen.length > 1, `${seen.length} ranged requests`);
    check('task reports completed', task.state === 'completed', task.state);
  } finally { await stopServer(server); }
}

// ── 2. server ignoring Range entirely ───────────────────────────────────────
console.log('\n-- 2. server ignoring Range collapses to one connection --');
{
  const payload = makePayload(256 * 1024);
  let rangeRequests = 0;
  const { server, port } = await startServer((req, res) => {
    if (req.headers.range) rangeRequests++;
    sendFull(res, payload); // always 200, Range ignored
  });
  try {
    const outDir = path.join(TMP, 'norange');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir,
      filename: 'f.bin',
      maxConnections: 8,
      minSplitSize: 64 * 1024,
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    await task.start();
    const got = fs.readFileSync(path.join(outDir, 'f.bin'));
    check('non-ranged host still byte-exact', got.equals(payload), `${got.length} B`);
    check('no false failure', task.state === 'completed', task.state);
    check('only the probe sent a Range header', rangeRequests === 1, `${rangeRequests}`);
  } finally { await stopServer(server); }
}

// ── 3. host that advertises ranges on the probe then ignores them ───────────
console.log('\n-- 3. "lying" host: RANGE_UNSUPPORTED collapses to one connection --');
{
  const payload = makePayload(256 * 1024);
  const { server, port } = await startServer((req, res) => {
    const r = readRange(req);
    // Only the probe's 1-byte request is honoured; every real segment gets a
    // full 200 body thrown at it.
    if (r && r.end !== null && r.end - r.start < 2) {
      return sendPartial(res, payload, r.start, r.end);
    }
    sendFull(res, payload);
  });
  try {
    const outDir = path.join(TMP, 'lying');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir,
      filename: 'f.bin',
      maxConnections: 8,
      minSplitSize: 64 * 1024,
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    await task.start();
    const got = fs.readFileSync(path.join(outDir, 'f.bin'));
    check('range-hostile host byte-exact after collapse', got.equals(payload), `${got.length} B`);
    check('engine collapsed to a single connection', task.forceSingleConnection === true);
    check('no error reported', task.state === 'completed' && !task.error, task.state);
  } finally { await stopServer(server); }
}

// ── 4. truncated body must never be a success ───────────────────────────────
console.log('\n-- 4. truncated body surfaces an error --');
{
  const payload = makePayload(256 * 1024);
  const { server, port } = await startServer((req, res) => {
    const r = readRange(req);
    const start = r ? r.start : 0;
    const end = r && r.end !== null ? Math.min(r.end, payload.length - 1) : payload.length - 1;
    const code = r ? 206 : 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    if (r) res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
    // Lie: promise the full length, then hang up half way.
    res.setHeader('Content-Length', String(end - start + 1));
    res.writeHead(code);
    res.write(payload.subarray(start, start + Math.floor((end - start + 1) / 2)));
    setTimeout(() => res.destroy(), 10);
  });
  try {
    const outDir = path.join(TMP, 'truncated');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir,
      filename: 'f.bin',
      maxConnections: 2,
      minSplitSize: 64 * 1024,
      retry: { maxTries: 2, baseDelayMs: 10, maxDelayMs: 20, factor: 2 },
      connectTimeoutMs: 5000,
      readTimeoutMs: 5000,
      onConflict: 'overwrite',
    });
    let completed = false;
    task.on('completed', () => { completed = true; });
    await task.start();
    check('truncated download does not complete', !completed && task.state === 'failed', task.state);
    check('no final file left behind', !fs.existsSync(path.join(outDir, 'f.bin')));
    check('error is reported', !!task.error, task.error && task.error.code);
  } finally { await stopServer(server); }
}

// ── 5. a finished file is never destroyed ───────────────────────────────────
console.log('\n-- 5. existing finished file survives a second startDownload --');
{
  const payload = makePayload(128 * 1024);
  const { server, port } = await startServer((req, res) => {
    const r = readRange(req);
    if (!r) return sendFull(res, payload);
    sendPartial(res, payload, r.start, r.end === null ? payload.length - 1 : Math.min(r.end, payload.length - 1));
  });
  try {
    const outDir = path.join(TMP, 'conflict');
    fs.mkdirSync(outDir, { recursive: true });
    const filepath = path.join(outDir, 'movie.mp4');
    const eng = new DownloadEngine();

    const runOnce = (id) => new Promise((resolve) => {
      const done = (d) => { eng.off('download-complete', ok); eng.off('download-error', bad); resolve(d); };
      const ok = (d) => { if (d.id === id) done({ ok: true, d }); };
      const bad = (d) => { if (d.id === id) done({ ok: false, d }); };
      eng.on('download-complete', ok);
      eng.on('download-error', bad);
      eng.startDownload({ id, url: `http://127.0.0.1:${port}/movie.mp4`, filepath, totalSegments: 4 })
        .catch((e) => done({ ok: false, d: { error: e.message } }));
    });

    const first = await runOnce('conflict-1');
    check('first download completed', first.ok, first.ok ? '' : JSON.stringify(first.d));
    check('first file written', fs.existsSync(filepath) && fs.readFileSync(filepath).equals(payload));

    const second = await runOnce('conflict-2');
    check('second download completed', second.ok, second.ok ? '' : JSON.stringify(second.d));
    check('original file NOT deleted', fs.existsSync(filepath) && fs.readFileSync(filepath).equals(payload));
    const files = fs.readdirSync(outDir).filter((f) => !f.endsWith('.part') && !f.endsWith('.part.meta'));
    check('second download got its own name', files.length === 2, files.join(', '));
    const other = files.find((f) => f !== 'movie.mp4');
    check('second file is byte-exact', other && fs.readFileSync(path.join(outDir, other)).equals(payload), other);
  } finally { await stopServer(server); }
}

// ── 6. resume from persisted offsets ────────────────────────────────────────
console.log('\n-- 6. resume from offsets --');
{
  const payload = makePayload(256 * 1024);
  const half = payload.length / 2;
  const { server, port } = await startServer((req, res) => {
    const r = readRange(req);
    if (!r) return sendFull(res, payload);
    sendPartial(res, payload, r.start, r.end === null ? payload.length - 1 : Math.min(r.end, payload.length - 1));
  });
  try {
    const outDir = path.join(TMP, 'resume');
    fs.mkdirSync(outDir, { recursive: true });
    // A part file holding the first half, exactly as a killed run would leave it.
    fs.writeFileSync(path.join(outDir, 'f.bin.part'), payload.subarray(0, half));
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir,
      filename: 'f.bin',
      maxConnections: 2,
      minSplitSize: 128 * 1024,
      resumeOffsets: { 0: half, 1: 0 },
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    await task.start();
    const got = fs.readFileSync(path.join(outDir, 'f.bin'));
    check('resumed file byte-exact', got.equals(payload), `${got.length} B`);
    check('resume reported progress up front', task.state === 'completed', task.state);

    // Already-complete resume: the part file holds everything.
    const outDir2 = path.join(TMP, 'resume-done');
    fs.mkdirSync(outDir2, { recursive: true });
    fs.writeFileSync(path.join(outDir2, 'g.bin.part'), payload);
    const task2 = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir2,
      filename: 'g.bin',
      maxConnections: 2,
      resumeOffsets: { 0: payload.length },
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    await task2.start();
    const got2 = fs.readFileSync(path.join(outDir2, 'g.bin'));
    check('complete resume finalises without re-download', got2.equals(payload), `${got2.length} B`);

    // Over-reported progress (crash between "reserved" and "written") must be
    // trimmed back to the bytes actually on disk, not leave zero holes.
    const outDir3 = path.join(TMP, 'resume-lie');
    fs.mkdirSync(outDir3, { recursive: true });
    const quarter = Math.floor(payload.length / 4);
    fs.writeFileSync(path.join(outDir3, 'h.bin.part'), payload.subarray(0, quarter));
    const task3 = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir3,
      filename: 'h.bin',
      maxConnections: 1,
      minSplitSize: 1024 * 1024,
      resumeOffsets: { 0: half }, // claims twice what exists
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    await task3.start();
    const got3 = fs.readFileSync(path.join(outDir3, 'h.bin'));
    check('over-reported offsets trimmed to real bytes', got3.equals(payload), `${got3.length} B`);

    // An oversized .part (bigger than the resource) must not become an
    // oversized final file.
    const outDir4 = path.join(TMP, 'resume-big');
    fs.mkdirSync(outDir4, { recursive: true });
    fs.writeFileSync(path.join(outDir4, 'i.bin.part'), Buffer.concat([payload, Buffer.alloc(4096)]));
    const task4 = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir4,
      filename: 'i.bin',
      maxConnections: 1,
      minSplitSize: 1024 * 1024,
      resumeOffsets: { 0: payload.length },
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    await task4.start();
    const got4 = fs.readFileSync(path.join(outDir4, 'i.bin'));
    check('oversized part truncated to the real size', got4.equals(payload), `${got4.length} B`);
  } finally { await stopServer(server); }
}

// ── 7. cancel leaks nothing ─────────────────────────────────────────────────
console.log('\n-- 7. cancel leaves no timers --');
{
  const payload = makePayload(512 * 1024);
  const { server, port } = await startServer((req, res) => {
    const r = readRange(req);
    const start = r ? r.start : 0;
    const end = r && r.end !== null ? Math.min(r.end, payload.length - 1) : payload.length - 1;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    if (r) res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
    res.setHeader('Content-Length', String(end - start + 1));
    res.writeHead(r ? 206 : 200);
    let pos = start;
    // Drip slowly and in small chunks: this test cancels mid-flight, so the
    // transfer must still be running when the cancel lands. At the old
    // 16 KB / 20 ms the whole 512 KB finished inside the 400 ms wait on a
    // fast (or lightly loaded) machine and the "cancel" assertions below
    // measured a completed download instead — a flaky suite, not a real bug.
    const timer = setInterval(() => {
      if (pos > end || res.destroyed) { clearInterval(timer); try { res.end(); } catch (e) {} return; }
      const len = Math.min(8 * 1024, end - pos + 1);
      res.write(payload.subarray(pos, pos + len));
      pos += len;
      if (pos > end) { clearInterval(timer); res.end(); }
    }, 60);
    req.on('close', () => clearInterval(timer));
  });
  try {
    const outDir = path.join(TMP, 'cancel');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir,
      filename: 'f.bin',
      maxConnections: 2,
      minSplitSize: 64 * 1024,
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    let completed = false;
    task.on('completed', () => { completed = true; });
    const started = task.start();
    // Wait for the state instead of guessing a fixed delay — a slow CI box and
    // a fast desktop must both see "still downloading" here.
    for (let i = 0; i < 100 && task.state !== 'downloading'; i++) await sleep(20);
    check('download is running before cancel', task.state === 'downloading', task.state);
    await task.cancel({ deleteFiles: true });
    await started;
    check('ticker cleared after cancel', task.ticker === null, String(task.ticker));
    check('retry timer cleared after cancel', task.retryTimer === null, String(task.retryTimer));
    check('no completion emitted', !completed);
    check('state is cancelled', task.state === 'cancelled', task.state);
    await sleep(200);
    check('no file resurrected after cancel', !fs.existsSync(path.join(outDir, 'f.bin')));
  } finally { await stopServer(server); }
}

// ── 8. singleConnection / resumable flags ───────────────────────────────────
console.log('\n-- 8. singleConnection + resumable:false --');
{
  const payload = makePayload(128 * 1024);
  let segmentRanges = 0;
  const { server, port } = await startServer((req, res) => {
    const r = readRange(req);
    // Refuse every Range request with 403, serve plain GETs (file-hoster style).
    if (r) {
      // the very first probe request is a range request too, count only the rest
      segmentRanges++;
      res.writeHead(403); res.end('no ranges'); return;
    }
    sendFull(res, payload);
  });
  try {
    const outDir = path.join(TMP, 'single');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir,
      filename: 'f.bin',
      maxConnections: 8,
      singleConnection: true,
      resumable: false,
      minSplitSize: 32 * 1024,
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    await task.start();
    const got = fs.readFileSync(path.join(outDir, 'f.bin'));
    check('singleConnection download byte-exact', got.equals(payload), `${got.length} B`);
    check('single connection used', task.forceSingleConnection === true);

    // resumable:false must not pick up an existing part file
    const outDir2 = path.join(TMP, 'noresume');
    fs.mkdirSync(outDir2, { recursive: true });
    fs.writeFileSync(path.join(outDir2, 'g.bin.part'), payload.subarray(0, 1024));
    const task2 = new DownloadTask({
      url: `http://127.0.0.1:${port}/f.bin`,
      directory: outDir2,
      filename: 'g.bin',
      maxConnections: 2,
      resumable: false,
      resumeOffsets: { 0: 1024 },
      retry: FAST_RETRY,
      onConflict: 'overwrite',
    });
    await task2.start();
    const got2 = fs.readFileSync(path.join(outDir2, 'g.bin'));
    check('resumable:false restarts clean (no corrupt resume)', got2.equals(payload), `${got2.length} B`);
  } finally { await stopServer(server); }
}

// ── 9. HLS variant selection ────────────────────────────────────────────────
console.log('\n-- 9. HLS picks a variant that carries audio --');
{
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac-128k",NAME="English",DEFAULT=YES,URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
    'video-only-1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac-128k"',
    'with-audio-720.m3u8',
  ].join('\n');

  check('parseHlsAudioGroups finds the audio group', parseHlsAudioGroups(master).has('aac-128k'));

  const engMod = require('../src/download-engine');
  const variants = engMod.parseHlsMaster(master, 'https://cdn.example.com/master.m3u8');
  const chosen = pickHlsVariant(variants, master);
  check('picks the variant with audio, not the biggest', chosen && /with-audio-720/.test(chosen.url), chosen && chosen.url);
  check('chosen variant height exposed', chosen && chosen.height === 720, chosen && chosen.height);
  check('chosen variant bandwidth exposed', chosen && chosen.bandwidth === 4000000, chosen && chosen.bandwidth);

  // No audio renditions declared at all -> assume muxed, take the best.
  const plainMaster = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480',
    '480.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    '1080.m3u8',
  ].join('\n');
  const plain = pickHlsVariant(engMod.parseHlsMaster(plainMaster, 'https://c/'), plainMaster);
  check('falls back to best variant when no audio groups exist', plain && /1080/.test(plain.url), plain && plain.url);

  // End-to-end: the master above served over HTTP, download must take 720p.
  const segA = Buffer.from('AAAA-init-and-data-720');
  const segB = Buffer.from('BBBB-more-data-720');
  const media720 = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4,', 's1.ts', '#EXTINF:4,', 's2.ts', '#EXT-X-ENDLIST'].join('\n');
  const media1080 = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4,', 'v1.ts', '#EXT-X-ENDLIST'].join('\n');
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    const send = (body, type) => {
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', String(Buffer.byteLength(body)));
      res.writeHead(200);
      res.end(body);
    };
    if (u === '/master.m3u8') return send(master, 'application/vnd.apple.mpegurl');
    if (u === '/with-audio-720.m3u8') return send(media720, 'application/vnd.apple.mpegurl');
    if (u === '/video-only-1080.m3u8') return send(media1080, 'application/vnd.apple.mpegurl');
    if (u === '/s1.ts') return send(segA, 'video/mp2t');
    if (u === '/s2.ts') return send(segB, 'video/mp2t');
    if (u === '/v1.ts') return send(Buffer.from('ZZZZ-1080-video-only'), 'video/mp2t');
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const eng = new DownloadEngine();
    const outFile = path.join(TMP, 'hls', 'stream.ts');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const outcome = await new Promise((resolve) => {
      eng.on('download-complete', (d) => resolve({ ok: true, d }));
      eng.on('download-error', (d) => resolve({ ok: false, d }));
      eng.startHlsDownload({
        id: 'hls-1',
        url: `http://127.0.0.1:${port}/master.m3u8`,
        filepath: outFile,
        headers: {},
      }).catch((e) => resolve({ ok: false, d: { error: e.message } }));
    });
    check('HLS download completes', outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.d));
    const body = fs.existsSync(outFile) ? fs.readFileSync(outFile) : Buffer.alloc(0);
    check('HLS wrote the audio-carrying variant bytes', body.equals(Buffer.concat([segA, segB])), body.toString());
    const rec = eng.getDownload('hls-1');
    check('variant geometry on the record', rec && rec.hlsVariant && rec.hlsVariant.height === 720,
      rec && rec.hlsVariant && `${rec.hlsVariant.width}x${rec.hlsVariant.height}`);
    check('variant reports audio', rec && rec.hlsVariant && rec.hlsVariant.hasAudio === true);
  } finally { await stopServer(server); }

  // A segment that stops mid-body must not be written as if it were whole.
  const media = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4,', 't1.ts', '#EXT-X-ENDLIST'].join('\n');
  const full = Buffer.alloc(64 * 1024, 7);
  const tServer = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/m.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Content-Length', String(Buffer.byteLength(media)));
      res.writeHead(200); return res.end(media);
    }
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', String(full.length)); // promise everything…
    res.writeHead(200);
    res.write(full.subarray(0, 1024));                    // …send a fragment
    setTimeout(() => res.destroy(), 10);
  });
  await new Promise((r) => tServer.listen(0, '127.0.0.1', r));
  try {
    const eng = new DownloadEngine();
    const outFile = path.join(TMP, 'hls', 'truncated.ts');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const outcome = await new Promise((resolve) => {
      eng.on('download-complete', (d) => resolve({ ok: true, d }));
      eng.on('download-error', (d) => resolve({ ok: false, d }));
      eng.startHlsDownload({
        id: 'hls-2', url: `http://127.0.0.1:${tServer.address().port}/m.m3u8`, filepath: outFile, headers: {},
      }).catch((e) => resolve({ ok: false, d: { error: e.message } }));
    });
    check('truncated HLS segment errors instead of completing', !outcome.ok,
      outcome.ok ? 'reported completion' : (outcome.d && outcome.d.error));
  } finally { await stopServer(tServer); }
}

// ── 10. SegmentManager.restore clamps to the real size ──────────────────────
console.log('\n-- 10. SegmentManager.restore clamps and fills --');
{
  const opts = { minSplitSize: 1024, pieceSelection: 'largest', allowSplit: true };
  const total = 10000;
  const mgr = SegmentManager.restore([
    { id: 1, start: 0, end: 9999, downloaded: 5000 },
    { id: 2, start: 5000, end: 49999, downloaded: 999999 }, // past EOF, bogus progress
  ], total, opts);
  check('restore clamps end to EOF', mgr.all.every((s) => s.isOpenEnded || s.end <= total - 1),
    mgr.all.map((s) => `${s.start}-${s.end}`).join(','));
  check('restore clamps downloaded to segment length', mgr.all.every((s) => s.isOpenEnded || s.downloaded <= s.length));
  check('restore never exceeds the total size', mgr.downloadedBytes <= total, `${mgr.downloadedBytes}`);

  const gap = SegmentManager.restore([
    { id: 1, start: 0, end: 3999, downloaded: 4000 },
    { id: 2, start: 6000, end: 9999, downloaded: 1000 },
  ], total, opts);
  check('gap is filled', gap.all.length === 3, `${gap.all.length} segments`);
  check('coverage is complete', gap.all[0].start === 0 && gap.all[gap.all.length - 1].end === total - 1);
  check('gap segment starts pending', gap.all[1].start === 4000 && gap.all[1].state === 'pending');

  const empty = SegmentManager.restore([], total, opts);
  check('empty restore falls back to a fresh manager', empty.all.length === 1 && empty.all[0].start === 0);

  const bogus = SegmentManager.restore([{ id: 1, start: 5, end: 2, downloaded: 10 }], total, opts);
  check('inverted segment dropped', bogus.all.length === 1 && bogus.all[0].start === 0 && bogus.all[0].end === total - 1);
}

console.log(`\nengine-reliability: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
