'use strict';

const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { DownloadTask } = require('../src/engine/task');
const { normalizePieceManifest, verifyPieceRanges } = require('../src/engine/checksum');

let pass = 0;
let fail = 0;
function check(name, condition, extra) {
  if (condition) {
    pass++;
    console.log('  OK  ', name, extra === undefined ? '' : `(${extra})`);
  } else {
    fail++;
    console.log('  FAIL', name, extra === undefined ? '' : `(${extra})`);
  }
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function main() {
  const workspaceTmp = path.join(__dirname, '..', '.openclaw', 'tmp');
  fs.mkdirSync(workspaceTmp, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(workspaceTmp, 'engine-pieces-'));
  const total = 32 * 1024;
  const pieceLength = 16 * 1024;
  const clean = Buffer.alloc(total);
  for (let i = 0; i < total; i++) clean[i] = (i * 13 + 5) & 0xff;
  const pieces = {
    algorithm: 'sha256',
    pieceLengthBytes: pieceLength,
    hashes: [
      sha256(clean.subarray(0, pieceLength)),
      sha256(clean.subarray(pieceLength, total)),
    ],
  };

  const validPath = path.join(tmp, 'valid.bin');
  fs.writeFileSync(validPath, clean);
  const validResult = await verifyPieceRanges(validPath, pieces, total);
  check('valid piece manifest passes', validResult.ok && validResult.badPieces.length === 0);

  const corruptPath = path.join(tmp, 'corrupt.bin');
  fs.writeFileSync(corruptPath, clean);
  fs.writeFileSync(corruptPath, Buffer.from([clean[10] ^ 0xff]), { flag: 'r+', position: 10 });
  const corruptResult = await verifyPieceRanges(corruptPath, pieces, total);
  check('corrupt piece is identified by range', !corruptResult.ok && corruptResult.badPieces.length === 1 &&
    corruptResult.badPieces[0].start === 0 && corruptResult.badPieces[0].end === pieceLength - 1, JSON.stringify(corruptResult.badPieces));

  const lastPartialTotal = 10;
  const partialPath = path.join(tmp, 'partial.bin');
  fs.writeFileSync(partialPath, clean.subarray(0, lastPartialTotal));
  const partial = {
    algorithm: 'sha256',
    pieceLengthBytes: pieceLength,
    hashes: [sha256(clean.subarray(0, lastPartialTotal))],
  };
  const partialResult = await verifyPieceRanges(partialPath, partial, lastPartialTotal);
  check('final partial piece verifies at file EOF', partialResult.ok);

  check('piece algorithm aliases normalize', normalizePieceManifest({ algorithm: 'SHA-256', pieceLength: 1024, hashes: ['a'.repeat(64)] }).algorithm === 'sha256');
  check('wrong piece digest length is rejected', normalizePieceManifest({ algorithm: 'sha256', pieceLengthBytes: 1024, hashes: ['abc'] }) === null);
  check('manifest count cannot disagree with total size', normalizePieceManifest(pieces, total + 1) === null);

  let downloadAttempts = 0;
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    const isProbe = range === 'bytes=0-0';
    if (!isProbe) downloadAttempts++;
    const body = Buffer.from(clean);
    if (downloadAttempts === 1) body[10] ^= 0xff;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(body.length),
      ETag: '"pieces-v1"',
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = path.join(tmp, 'repair-task');
  fs.mkdirSync(directory, { recursive: true });
  try {
    const task = new DownloadTask({
      url: `http://127.0.0.1:${server.address().port}/repair.bin`,
      directory,
      filename: 'repair.bin',
      pieces,
      maxConnections: 1,
      initialConnections: 1,
      adaptiveConnections: false,
      minSplitSize: 1024 * 1024,
      onConflict: 'overwrite',
    });
    const state = await task.start();
    const telemetry = task.getTelemetry();
    const output = fs.readFileSync(path.join(directory, 'repair.bin'));
    check('piece mismatch triggers targeted re-download', state === 'completed' && downloadAttempts >= 2, `state=${state}, attempts=${downloadAttempts}`);
    check('repair telemetry counts one piece-repair pass', telemetry.pieceRepairs === 1, `repairs=${telemetry.pieceRepairs}`);
    check('repaired output is byte-correct', output.equals(clean), `${output.length} B`);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  console.log(`\nengine-pieces: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('  FAIL', err && err.stack || err);
  process.exitCode = 1;
});
