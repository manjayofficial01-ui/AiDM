// AiDM v4.0.0 - Next-Gen Download Engine unit/integration tests
// Covers v4-specific capabilities added via lib/download-engine integration:
//   A. MirrorPool: speed scoring, failure tracking, failover
//   B. Dynamic segment splitting in-flight (IDM-style)
//   C. SegmentFileWriter positional write + control-file crash recovery
//   D. Multi-algorithm checksum verification (SHA-256, MD5, SHA-512)
//   E. SpeedMeter EMA + sliding window
//   F. TokenBucket rate limiter
//   G. Exponential backoff with jitter
//   H. DownloadTask end-to-end with checksum verification
//
// Run: node test/engine-v4.js
'use strict';
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else       { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const md5    = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('hex');

const { MirrorPool }    = require('../src/engine/mirrors');
const { SegmentManager } = require('../src/engine/segments');
const { SegmentFileWriter } = require('../src/engine/file-writer');
const { controlFilePath, saveControlFile, loadControlFile } = require('../src/engine/control-file');
const { verifyChecksum, hashFile } = require('../src/engine/checksum');
const { SpeedMeter }    = require('../src/engine/speed');
const { TokenBucket }   = require('../src/engine/rate-limiter');
const { backoffDelay }  = require('../src/engine/retry');
const { DownloadTask }  = require('../src/engine/task');
const { DownloadError } = require('../src/engine/errors');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-v4-'));
// Note: TMP is intentionally not cleaned on exit — the OS removes /tmp on reboot.
// Using rmSync in a process.on('exit') handler causes libuv assertion errors on Node 25/Windows.

(async () => {
// ─── A. MirrorPool ───────────────────────────────────────────────────────────
console.log('\n-- A. MirrorPool speed scoring & failover --');
{
  const pool = new MirrorPool(
    ['http://primary.example.com/file', 'http://secondary.example.com/file'],
    4,
  );
  check('pool has 2 mirrors', pool.all.length === 2);
  check('primary is first', pool.primary.url === 'http://primary.example.com/file');

  const secondary = pool.all.find(m => m.url.includes('secondary'));
  pool.reportSuccess(secondary, 1_000_000, 1000);
  check('secondary speed scored', secondary.speedEma > 0, `${secondary.speedEma.toFixed(0)} B/s`);

  const primary = pool.primary;
  for (let i = 0; i < 5; i++)
    pool.reportFailure(primary, new DownloadError('NETWORK', 'connect ECONNREFUSED'));
  check('primary banned after failures', primary.banned === true);
  check('hasAlternative when primary banned', pool.hasAlternative(primary));
  const sel = pool.select();
  check('select skips banned mirror', sel !== null && !sel.banned);
}

// ─── B. Dynamic segment splitting ────────────────────────────────────────────
console.log('\n-- B. Dynamic segment splitting --');
{
  const opts = { minSplitSize: 64 * 1024, pieceSelection: 'largest', allowSplit: true };
  const mgr = SegmentManager.fresh(1024 * 1024, opts);

  const seg1 = mgr.claim();
  check('first claim returns segment', seg1 !== null);
  check('segment is active', seg1.state === 'active');

  seg1.downloaded = 128 * 1024;
  const seg2 = mgr.claim();
  check('split creates second segment', seg2 !== null && seg2 !== seg1);
  check('two segments total', mgr.all.length === 2, `${mgr.all.length}`);

  mgr.complete(seg1);
  mgr.complete(seg2);
  check('complete after both done', mgr.isComplete);
}

// ─── C. SegmentFileWriter + control-file crash recovery ──────────────────────
console.log('\n-- C. SegmentFileWriter + control-file crash recovery --');
{
  const partPath = path.join(TMP, 'crash.bin.part');
  const size = 64 * 1024;
  const buf1 = crypto.randomBytes(32 * 1024);
  const buf2 = crypto.randomBytes(32 * 1024);

  const writer = await SegmentFileWriter.open(partPath, { size, preallocation: 'sparse', fresh: true });
  await writer.write(buf1, 0);
  await writer.write(buf2, 32 * 1024);
  await writer.close();

  const written = fs.readFileSync(partPath);
  check('positional write correct', written.equals(Buffer.concat([buf1, buf2])), `${written.length} B`);

  const ctlPath = controlFilePath(partPath);
  await saveControlFile(ctlPath, {
    version: 1, id: 'crash-id', options: {}, url: 'http://x/f', finalUrl: 'http://x/f',
    filename: 'crash.bin', partPath, finalPath: partPath.replace('.part', ''),
    size, etag: null, lastModified: null, acceptRanges: true,
    segments: [
      { id: 1, start: 0, end: 32767, downloaded: 32768, state: 'done' },
      { id: 2, start: 32768, end: 65535, downloaded: 32768, state: 'done' },
    ],
    downloadedBytes: size, createdAt: Date.now(), updatedAt: Date.now(),
  });
  check('control file written to disk', fs.existsSync(ctlPath));

  const ctl = await loadControlFile(ctlPath);
  check('control file loaded', ctl !== null);
  check('id preserved', ctl && ctl.id === 'crash-id');

  const restored = SegmentManager.restore(ctl.segments, ctl.size, { minSplitSize: 64*1024, pieceSelection:'largest', allowSplit:true });
  check('restored segment count', restored.all.length === 2, `${restored.all.length}`);
  check('restored marks complete', restored.isComplete);
  check('restored downloaded bytes', restored.downloadedBytes === size, `${restored.downloadedBytes}`);
}

// ─── D. Checksum verification ─────────────────────────────────────────────────
console.log('\n-- D. Multi-algorithm checksum verification --');
{
  const data = crypto.randomBytes(256 * 1024);
  const filePath = path.join(TMP, 'check.bin');
  fs.writeFileSync(filePath, data);

  const h256 = sha256(data), hmd5 = md5(data), h512 = sha512(data);

  check('hashFile sha256', await hashFile(filePath, 'sha256') === h256);

  let ok256=false, okMd5=false, ok512=false;
  try { await verifyChecksum(filePath, { algorithm:'sha256', value:h256 }); ok256=true; } catch(_){}
  try { await verifyChecksum(filePath, { algorithm:'md5',    value:hmd5 }); okMd5=true; } catch(_){}
  try { await verifyChecksum(filePath, { algorithm:'sha512', value:h512 }); ok512=true; } catch(_){}
  check('sha256 verifies', ok256);
  check('md5 verifies',    okMd5);
  check('sha512 verifies', ok512);

  let threw = false;
  try { await verifyChecksum(filePath, { algorithm:'sha256', value:'a'.repeat(64) }); } catch(_){ threw=true; }
  check('wrong hash rejected', threw);
}

// ─── E. SpeedMeter ────────────────────────────────────────────────────────────
console.log('\n-- E. SpeedMeter --');
{
  const m = new SpeedMeter(1000);
  m.add(512*1024); m.sample();
  check('positive bytesPerSecond', m.bytesPerSecond() > 0);
  check('smoothed non-negative', m.smoothed >= 0);
  m.reset();
  check('reset clears speed', m.bytesPerSecond() === 0);
}

// ─── F. TokenBucket ───────────────────────────────────────────────────────────
console.log('\n-- F. TokenBucket rate limiter --');
{
  const unlimited = new TokenBucket(0);
  const t0 = Date.now();
  await unlimited.acquire(1024*1024);
  check('unlimited resolves instantly', Date.now()-t0 < 100);

  // 1 MB/s limit: burst = max(64KB, 1MB/4) = 256KB.
  // Acquire 1 MB in 64KB chunks; first ~256KB pass instantly via burst,
  // the remaining ~768KB at 1 MB/s must block for at least ~500ms.
  const limited = new TokenBucket(1024 * 1024); // 1 MB/s
  const t1 = Date.now();
  for (let i = 0; i < 16; i++) await limited.acquire(64 * 1024); // 1 MB total
  const elapsed = Date.now() - t1;
  check('limited bucket introduces delay', elapsed > 400, `${elapsed}ms`);
}

// ─── G. Exponential backoff ───────────────────────────────────────────────────
console.log('\n-- G. Exponential backoff --');
{
  const policy = { baseDelayMs:100, maxDelayMs:10000, factor:2 };
  const d1 = backoffDelay(1, policy);
  const d2 = backoffDelay(2, policy);
  const d3 = backoffDelay(3, policy);
  check('attempt 1 delay in range', d1 >= 50 && d1 <= 500,  `${d1}ms`);
  check('attempt 2 delay in range', d2 >= 100 && d2 <= 1000, `${d2}ms`);
  check('delay increases', d2 > d1 || d3 > d2);
  check('max delay enforced', backoffDelay(50, policy) <= 10000 * 1.5);
}

// ─── H. DownloadTask end-to-end ───────────────────────────────────────────────
console.log('\n-- H. DownloadTask end-to-end with checksum --');
{
  const payload = Buffer.alloc(128*1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xFF;
  const expectedHash = sha256(payload);

  const server = http.createServer((req, res) => {
    let start = 0, end = payload.length-1, code = 200;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m && (m[1]||m[2])) {
        if (m[1]) start = parseInt(m[1],10);
        if (m[2]) end = Math.min(parseInt(m[2],10), payload.length-1);
        code = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
        res.setHeader('Accept-Ranges', 'bytes');
      }
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(end-start+1));
    res.writeHead(code);
    res.end(payload.subarray(start, end+1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const outDir = path.join(TMP, 'task-e2e');
    fs.mkdirSync(outDir, { recursive: true });

    // Test 1: correct download with checksum pass
    const task = new DownloadTask({
      url: `http://127.0.0.1:${port}/payload.bin`,
      directory: outDir,
      filename: 'payload.bin',
      maxConnections: 2,
      minSplitSize: 32*1024,
      checksum: { algorithm:'sha256', value:expectedHash },
      onConflict: 'overwrite',
      resumeValidation: 'lenient',
    });
    const events = [];
    task.on('state', s => events.push(s));
    task.on('completed', () => events.push('completed'));
    task.on('failed', e => events.push(`failed:${e.code}`));
    await task.start();

    const got = fs.readFileSync(path.join(outDir, 'payload.bin'));
    check('task output byte-correct', got.equals(payload), `${got.length} B`);
    check('downloading state emitted', events.includes('downloading'));
    check('completed event emitted', events.includes('completed'));
    check('no failure emitted', !events.some(e => String(e).startsWith('failed')));

    // Test 2: wrong checksum should fail
    const task2 = new DownloadTask({
      url: `http://127.0.0.1:${port}/payload.bin`,
      directory: outDir,
      filename: 'payload-bad.bin',
      maxConnections: 1,
      checksum: { algorithm:'sha256', value:'a'.repeat(64) },
      onConflict: 'overwrite',
      resumeValidation: 'lenient',
    });
    let failCode = null;
    task2.on('failed', e => { failCode = e.code; });
    try { await task2.start(); } catch (_) {}
    check('wrong checksum triggers failure', failCode !== null, failCode);
  } finally {
    // closeAllConnections() is available since Node 18.2 — destroys keep-alive
    // sockets so server.close() can fully release the handle on Windows.
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });




