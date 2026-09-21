#!/usr/bin/env node
/**
 * End-to-end YouTube download against the RUNNING AiDM app, over the HTTP API.
 *
 * This drives exactly the same endpoints the extension and the UI use:
 *   POST /api/resolve-youtube  ->  picker qualities
 *   POST /api/download         ->  create the row (pending-approval)
 *   POST /api/approve          ->  start it
 *   GET  /api/downloads        ->  poll progress
 *
 * Usage: node tools/api-e2e-youtube.js --url <watch-url> [--quality 720p] [--dir <out>]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.AIDM_PORT || 18765);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: p,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(b) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: b });
          }
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const url = arg('url');
  const quality = arg('quality', null);
  const outDir = arg('dir', path.join(os.tmpdir(), `aidm-e2e-${Date.now()}`));
  if (!url) {
    console.error('usage: node tools/api-e2e-youtube.js --url <watch-url> [--quality 720p] [--dir <out>]');
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[1/4] resolve-youtube  ${url}`);
  const r1 = await req('POST', '/api/resolve-youtube', { url, pageTitle: 'API E2E' });
  if (!r1.json || !r1.json.success) {
    console.error('  RESOLVE FAILED:', JSON.stringify(r1.json || r1.raw));
    process.exit(1);
  }
  const videos = r1.json.videos || [];
  console.log(`  -> ${videos.length} qualities`);
  videos.forEach((v, i) =>
    console.log(`     [${i}] ${v.quality} ${v.resolution} ${(v.size / 1048576).toFixed(1)} MB  ${v.filename}`)
  );

  let pick = videos[0];
  if (quality) {
    const m = videos.find((v) => String(v.quality).toLowerCase() === String(quality).toLowerCase());
    if (m) pick = m;
    else console.warn(`  (no exact match for ${quality}, using ${pick.quality})`);
  }
  console.log(`  chosen: ${pick.quality} -> ${pick.filename}`);

  console.log('[2/4] download (create row)');
  const r2 = await req('POST', '/api/download', {
    url: pick.url,
    filename: pick.filename,
    meta: { ytUrl: r1.json.url || url, ytFormat: pick.ytFormat, pageUrl: url, provider: 'youtube' },
  });
  if (!r2.json || !r2.json.success) {
    console.error('  ADD FAILED:', JSON.stringify(r2.json || r2.raw));
    process.exit(1);
  }
  const id = r2.json.download && r2.json.download.id;
  console.log(`  -> row ${id} (duplicate=${!!r2.json.duplicate})`);

  console.log(`[3/4] approve -> ${outDir}`);
  const r3 = await req('POST', '/api/approve', { id, savePath: outDir });
  if (!r3.json || !r3.json.success) {
    console.error('  APPROVE FAILED:', JSON.stringify(r3.json || r3.raw));
    process.exit(1);
  }

  console.log('[4/4] polling…');
  const deadline = Date.now() + 240000;
  let row = null;
  while (Date.now() < deadline) {
    const g = await req('GET', '/api/downloads');
    row = (g.json || []).find((d) => d.id === id);
    if (!row) break;
    // The two engines name this field differently: the native segment engine
    // writes `downloadedSize`, the yt-dlp (YouTube) path writes `downloaded`.
    // Reading only `downloadedSize` made every YouTube row look frozen at
    // 0.0 MB even while it was downloading fine.
    const done = Number(row.downloaded != null ? row.downloaded : row.downloadedSize) || 0;
    const pct = row.totalSize ? (done / row.totalSize) * 100 : 0;
    process.stdout.write(
      `\r  ${row.status.padEnd(12)} ${(done / 1048576).toFixed(1)}/${((row.totalSize || 0) / 1048576).toFixed(1)} MB  ${pct.toFixed(0)}%   `
    );
    if (row.status === 'completed' || row.status === 'error' || row.status === 'failed') break;
    await sleep(1000);
  }
  console.log('');

  if (!row || row.status !== 'completed') {
    console.error('  NOT COMPLETED:', row ? `${row.status} — ${row.error || ''}` : 'row vanished');
    process.exit(1);
  }

  const files = fs
    .readdirSync(outDir)
    .filter((n) => !n.startsWith('.'))
    .map((n) => ({ n, s: fs.statSync(path.join(outDir, n)).size }))
    .filter((f) => f.s > 0)
    .sort((a, b) => b.s - a.s);

  console.log('\nRESULT');
  console.log(`  status : ${row.status}`);
  console.log(`  dir    : ${outDir}`);
  files.forEach((f) => console.log(`  file   : ${f.n}  (${f.s} bytes)`));
  if (!files.length) {
    console.error('  FAIL: completed but nothing on disk');
    process.exit(1);
  }
  console.log(`\n  ffprobe: ffprobe -v error -show_entries format=duration,size -of default=nw=1 "${path.join(outDir, files[0].n)}"`);

  // Always remove the row we created — a successful test should leave no
  // "pending-approval" ghosts in the manager, and an interrupted one must
  // NOT leave the location dialog stuck open on the user's machine.
  if (id) {
    try { await req('POST', '/api/remove', { id }); } catch (e) { /* best effort */ }
  }
})().catch(async (e) => {
  console.error(e);
  // Same guarantee on the error path: cancel whatever the test started so
  // the location dialog does not stay open after the harness exits.
  if (typeof id !== 'undefined' && id) {
    try { await req('POST', '/api/remove', { id }); } catch (_) { /* best effort */ }
  }
  process.exit(1);
});
