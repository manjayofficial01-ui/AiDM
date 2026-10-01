// Response-integrity guards: refuse to WRITE bytes that cannot be correct.
//
//  1. Content-Encoding. Every request the engine makes asks for
//     `Accept-Encoding: identity` (a compressed body has no usable byte-range
//     semantics and breaks checksum verification). A server that compresses
//     anyway used to have its bytes written raw — a file that reported 100%
//     and a plausible size but would not open. Now the row fails loudly.
//  2. If-Range / entity validation. worker.js sends `If-Range: etag ??
//     lastModified`. The old code only ever compared ETags, so a host with no
//     ETag (where the validator was Last-Modified) answered 200, `sameEntity`
//     came out false, and a good partial download was destroyed by a
//     RESOURCE_CHANGED restart. Absent evidence must not mean "changed".
//
// Run: node test/response-integrity.js
'use strict';
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}

const { DownloadTask } = require('../src/engine/task');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-integrity-'));
const PAYLOAD = Buffer.from('AiDM response-integrity payload. '.repeat(64), 'utf8');

(async () => {
  // A host that ignores `Accept-Encoding: identity` and gzips anyway.
  const gzipServer = http.createServer((req, res) => {
    const body = zlib.gzipSync(PAYLOAD);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(body.length));
    res.writeHead(200);
    res.end(body);
  });

  await new Promise(r => gzipServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gzipServer.address().port}`;

  try {
    console.log('── 1. compressed response is refused, not written ──');
    const outDir = path.join(TMP, 'gz');
    fs.mkdirSync(outDir, { recursive: true });
    const task = new DownloadTask({
      url: `${base}/invoice.pdf`,
      directory: outDir,
      filename: 'invoice.pdf',
      maxConnections: 1,
      fetch: globalThis.fetch.bind(globalThis),
      onConflict: 'overwrite',
    });
    let failed = null;
    task.on('failed', e => { failed = e; });
    const state = await task.start();
    check('compressed download fails instead of succeeding', state === 'failed', state);
    check('failure names the compression', failed && /compressed/i.test(failed.message),
      failed && failed.message.slice(0, 70));
    check('failure is marked non-retryable (no retry storm)', failed && failed.retryable === false);
    const out = path.join(outDir, 'invoice.pdf');
    check('no corrupt file was left on disk', !fs.existsSync(out) || fs.statSync(out).size === 0,
      fs.existsSync(out) ? `${fs.statSync(out).size} B` : 'absent');
  } finally {
    gzipServer.close();
  }

  // ── 2. entity validation: absent evidence is not evidence of change ───────
  console.log('── 2. If-Range validator handling ──');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'worker.js'), 'utf8');
    check('If-Range validator falls back to Last-Modified',
      /const validator = ctx\.info\.etag \?\? ctx\.info\.lastModified/.test(src));
    // The fix: judge on the validator actually sent, not always on ETag.
    check('sameEntity judges an ETag host on ETag', /if \(ctx\.info\.etag\) \{/.test(src));
    check('sameEntity judges a Last-Modified host on Last-Modified',
      /lastModified === null \|\| lastModified === ctx\.info\.lastModified/.test(src));
    check('a 200 without a validator is not treated as a change',
      !/sameEntity = etag !== null && ctx\.info\.etag !== null && etag === ctx\.info\.etag/.test(src));
  }

  console.log(`\nresponse-integrity: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
