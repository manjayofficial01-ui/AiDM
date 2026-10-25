// End-to-end test for archive auto-extract wiring in DownloadManager.
// Run: node test/auto-extract.js
//
// This deliberately drives the REAL completion path (`_finishRow` →
// `_maybeAutoExtract`) against a real HTTP download, because a unit test of
// src/archive-extract.js alone would prove the extractor works while the
// feature stays unwired — exactly the failure mode this project has been
// burned by before.
//
// All state goes to a scratch dir: USERPROFILE/HOME are redirected BEFORE
// requiring the manager, so the user's real settings/downloads are untouched.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeZip } = require('./_zip-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(ROOT, '.openclaw', 'tmp', 'aidm-autoextract-' + process.pid);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { DownloadManager } = require('../src/download-manager');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra === undefined ? '' : extra); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serve a fixed buffer with real Range support (the engine asks for ranges). */
function startServer(body, contentType = 'application/zip') {
  const server = http.createServer((req, res) => {
    const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': String(body.length) });
      return res.end();
    }
    let start = 0, end = body.length - 1, code = 200;
    const range = req.headers.range;
    const m = range && /bytes=(\d*)-(\d*)/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), body.length - 1);
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
    }
    headers['Content-Length'] = String(end - start + 1);
    res.writeHead(code, headers);
    res.end(body.subarray(start, end + 1));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function waitForStatus(dm, id, status, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const dl = dm.downloads.get(id);
      if (dl && dl.status === status) return resolve(dl);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${status}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** `_finishRow` is fire-and-forget; poll the row for the side effect. */
async function waitFor(predicate, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

function writeSettings(extra) {
  fs.writeFileSync(
    path.join(TMP, '.aidm_settings.json'),
    JSON.stringify({ autoResume: false, defaultSegments: 2, ...extra }, null, 2),
  );
}

(async () => {
  const zipBody = makeZip([
    { name: 'manifest.json', data: '{"name":"fixture"}' },
    { name: 'payload/readme.txt', data: 'extracted by AiDM' },
    { name: 'payload/nested/leaf.bin', data: Buffer.from([9, 8, 7, 6, 5]) },
  ]);

  console.log('── 1. autoExtract ON: a finished ZIP is unpacked ──');
  {
    writeSettings({ autoExtract: true, autoExtractDelete: false });
    const { server, port } = await startServer(zipBody);
    const dm = new DownloadManager();
    let row;
    try {
      row = dm.addDownload({ url: `http://127.0.0.1:${port}/bundle.zip`, filename: 'bundle.zip' });
      const done = await waitForStatus(dm, row.id, 'completed');
      const live = await waitFor(() => {
        const d = dm.downloads.get(row.id);
        return d && d.extractDir ? d : null;
      });

      check('row reached completed', done.status === 'completed', done.status);
      check('extraction recorded on the row', !!live, live ? live.extractDir : 'no extractDir');
      if (live) {
        check('3 entries extracted', live.extractCount === 3, String(live.extractCount));
        check('nothing skipped', live.extractSkipped === 0, String(live.extractSkipped));
        check('note is human-readable', /3 files extracted/.test(live.extractNote || ''), live.extractNote);
        check('folder sits beside the archive', path.dirname(live.extractDir) === path.dirname(live.filepath),
          `${path.dirname(live.extractDir)} vs ${path.dirname(live.filepath)}`);
        check('manifest.json is byte-exact',
          fs.readFileSync(path.join(live.extractDir, 'manifest.json'), 'utf8') === '{"name":"fixture"}');
        check('nested file is byte-exact',
          fs.readFileSync(path.join(live.extractDir, 'payload', 'nested', 'leaf.bin')).equals(Buffer.from([9, 8, 7, 6, 5])));
        check('source archive kept when delete is off', fs.existsSync(live.filepath));
      }
    } finally {
      dm.engine.cancelDownload && dm.engine.cancelDownload(row.id);
      server.close();
    }
  }

  console.log('\n── 2. autoExtract OFF (default): nothing is written ──');
  {
    writeSettings({ autoExtract: false });
    const { server, port } = await startServer(zipBody);
    const dm = new DownloadManager();
    try {
      row = dm.addDownload({ url: `http://127.0.0.1:${port}/bundle-off.zip`, filename: 'bundle-off.zip' });
      await waitForStatus(dm, row.id, 'completed');
      await sleep(700); // give any (wrong) extraction time to happen
      const live = dm.downloads.get(row.id);
      check('no extractDir when the setting is off', !live.extractDir, live.extractDir || '');
      const sibling = path.join(path.dirname(live.filepath), 'bundle-off');
      check('no folder created on disk', !fs.existsSync(sibling), sibling);
    } finally {
      server.close();
    }
  }

  console.log('\n── 3. autoExtractDelete ON: source removed after a clean extract ──');
  {
    writeSettings({ autoExtract: true, autoExtractDelete: true });
    const { server, port } = await startServer(zipBody);
    const dm = new DownloadManager();
    try {
      const row = dm.addDownload({ url: `http://127.0.0.1:${port}/bundle.zip`, filename: 'bundle.zip' });
      await waitForStatus(dm, row.id, 'completed');
      const live = await waitFor(() => {
        const d = dm.downloads.get(row.id);
        return d && d.extractDir ? d : null;
      });
      check('extraction happened', !!live);
      if (live) {
        check('source archive removed', !fs.existsSync(live.filepath), live.filepath);
        check('row records the removal', live.extractSourceRemoved === true);
        check('extracted files survive the source removal',
          fs.existsSync(path.join(live.extractDir, 'payload', 'readme.txt')));
      }
    } finally {
      server.close();
    }
  }

  console.log('\n── 4. a 7z mislabelled as .zip is refused honestly, not fatally ──');
  {
    writeSettings({ autoExtract: true });
    const sevenZip = Buffer.concat([
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
      Buffer.alloc(2048, 0x41),
    ]);
    const { server, port } = await startServer(sevenZip, 'application/zip');
    const dm = new DownloadManager();
    try {
      const row = dm.addDownload({ url: `http://127.0.0.1:${port}/trap.zip`, filename: 'trap.zip' });
      const done = await waitForStatus(dm, row.id, 'completed');
      const live = await waitFor(() => {
        const d = dm.downloads.get(row.id);
        return d && d.extractNote ? d : null;
      });
      check('download still succeeds', done.status === 'completed');
      check('refusal recorded on the row', !!live && /not supported/.test(live.extractNote || ''),
        live ? live.extractNote : 'no note');
      check('no extractDir for a refused archive', !live || !live.extractDir);
      check('row is not flipped to error', done.status !== 'error');
    } finally {
      server.close();
    }
  }

  console.log('\n── 5. a genuine .7z is reported, not silently ignored ──');
  {
    writeSettings({ autoExtract: true });
    const sevenZip = Buffer.concat([
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
      Buffer.alloc(2048, 0x41),
    ]);
    const { server, port } = await startServer(sevenZip, 'application/x-7z-compressed');
    const dm = new DownloadManager();
    try {
      const row = dm.addDownload({ url: `http://127.0.0.1:${port}/bundle.7z`, filename: 'bundle.7z' });
      await waitForStatus(dm, row.id, 'completed');
      const live = await waitFor(() => {
        const d = dm.downloads.get(row.id);
        return d && d.extractNote ? d : null;
      });
      check('7z row still completes', dm.downloads.get(row.id).status === 'completed');
      check('7z gets an explanatory note', !!live && /7Z extraction is not supported/.test(live.extractNote || ''),
        live ? live.extractNote : 'no note');
      check('no folder created for 7z', !live || !live.extractDir);
    } finally {
      server.close();
    }
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
