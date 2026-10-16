// Integration test for "Combine networks": robustFetch must actually honour a
// per-request localAddress (source-address binding), and a real download with
// the multi-network spread engaged must still complete byte-correct.
// Run: node test/engine-network-bind.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { robustFetch, DownloadTask } = require('../src/download-engine.js');
const { destroyAgents } = require('../src/engine/agents.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// A crypto-random body so a corrupted/off-by-one download can't accidentally
// match. Served with full Range support like a real segmented host.
const BODY = crypto.randomBytes(1_500_000);
let server;
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), BODY.length - 1) : BODY.length - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${BODY.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        res.end(BODY.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'Content-Length': BODY.length, 'Accept-Ranges': 'bytes' });
        res.end(BODY);
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

(async () => {
  const port = await startServer();
  const url = `http://127.0.0.1:${port}/file.bin`;
  console.log('\u2500\u2500 robustFetch honours localAddress (source-address binding) \u2500\u2500');

  // Back-compat: no binding at all still works.
  {
    const res = await robustFetch(url, { method: 'GET' });
    check('default route (no localAddress) resolves 200', res.status === 200, 'status=' + res.status);
    await res.arrayBuffer();
  }
  // Binding to an address the machine actually owns (loopback) works.
  {
    const res = await robustFetch(url, { method: 'GET', localAddress: '127.0.0.1', family: 4 });
    check('bound to a real local address resolves', res.status === 200 || res.status === 206, 'status=' + res.status);
    await res.arrayBuffer();
  }
  // Binding to an UNASSIGNED address must fail (EADDRNOTAVAIL) — proves the
  // option is actually threaded into the socket, not silently ignored.
  {
    let ok = false, err = null;
    try { await robustFetch(url, { method: 'GET', localAddress: '192.0.2.123', family: 4 }); ok = true; }
    catch (e) { err = e; }
    check('binding to an unassigned address fails', !ok && err, 'err=' + (err && (err.code || err.message)));
  }

  console.log('\u2500\u2500 DownloadTask carries the multi-network pool \u2500\u2500');
  const one = [{ id: 'a', name: 'a', address: '127.0.0.1', family: 4 }];
  const two = [
    { id: 'a', name: 'a', address: '127.0.0.1', family: 4 },
    { id: 'b', name: 'b', address: '127.0.0.2', family: 4 },
  ];
  const mkTask = (netInterfaces, networkSpread) =>
    new DownloadTask({ id: 'x', url, directory: os.tmpdir(), filepath: path.join(os.tmpdir(), 'x.bin'), netInterfaces, networkSpread }, {}, {});
  check('networkSpread with <2 interfaces stays inert',
    mkTask(one, true).getProgress().networkSpread === false);
  check('networkSpread with >=2 interfaces engages',
    mkTask(two, true).getProgress().networkSpread === true &&
    mkTask(two, true).getProgress().networkCount === 2);
  check('networkSpread=false never engages',
    mkTask(two, false).getProgress().networkSpread === false);

  console.log('\u2500\u2500 Functional: a real spread download completes byte-correct \u2500\u2500');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-net-'));
  const filepath = path.join(dir, 'file.bin');
  const task = new DownloadTask({
    id: 'spread-1',
    url,
    directory: dir,
    filepath,
    maxConnections: 4,
    initialConnections: 3,
    // Two interfaces both bound to loopback (this host's only usable source
    // while looping back): the round-robin spread path runs for real.
    netInterfaces: [
      { id: 'a', name: 'a', address: '127.0.0.1', family: 4 },
      { id: 'b', name: 'b', address: '127.0.0.1', family: 4 },
    ],
    networkSpread: true,
  }, {}, {});
  const finalState = await task.start();
  const got = fs.existsSync(filepath) ? fs.readFileSync(filepath) : Buffer.alloc(0);
  check('download completed', finalState === 'completed', 'state=' + finalState);
  check('downloaded the full '+ BODY.length + ' bytes', got.length === BODY.length, 'got=' + got.length);
  check('bytes match the source exactly', crypto.createHash('sha256').update(got).digest('hex') === crypto.createHash('sha256').update(BODY).digest('hex'));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

  server.close();
  destroyAgents();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('engine-network-bind crashed:', e);
  try { if (server) server.close(); } catch (_) {}
  destroyAgents();
  process.exit(1);
});
