'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { DownloadTask } = require('../src/engine/task');

const WORKSPACE_TMP = path.join(__dirname, '..', '.openclaw', 'tmp');

function payloadFor(size) {
  const payload = Buffer.alloc(size);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
  return payload;
}

async function startFixture(payload, options = {}) {
  const stats = {
    requests: 0,
    rangeRequests: 0,
    bytesSent: 0,
    active: 0,
    peakActive: 0,
    perPath: {},
  };
  let remainingFailures = options.failDataRequests || 0;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture.local').pathname;
    const pathStats = stats.perPath[pathname] || { requests: 0, bytesSent: 0 };
    stats.perPath[pathname] = pathStats;
    stats.requests++;
    pathStats.requests++;
    stats.active++;
    stats.peakActive = Math.max(stats.peakActive, stats.active);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      stats.active = Math.max(0, stats.active - 1);
    };
    res.on('finish', settle);
    res.on('close', settle);

    const isProbe = req.headers.range === 'bytes=0-0';
    if (!isProbe && remainingFailures > 0) {
      remainingFailures--;
      req.socket.destroy();
      settle();
      return;
    }

    let start = 0;
    let end = payload.length - 1;
    let status = 200;
    if (req.headers.range) {
      stats.rangeRequests++;
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (match) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), payload.length - 1);
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
        res.setHeader('Accept-Ranges', 'bytes');
      }
    }
    const body = payload.subarray(start, end + 1);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('ETag', '"benchmark-v1"');
    res.writeHead(status);
    stats.bytesSent += body.length;
    pathStats.bytesSent += body.length;

    const delayMs = pathname.includes('slow') ? (options.slowChunkDelayMs || 0) : (options.chunkDelayMs || 0);
    const chunkBytes = options.chunkBytes || 64 * 1024;
    let offset = 0;
    const writeNext = () => {
      if (res.destroyed || offset >= body.length) {
        if (!res.destroyed) res.end();
        return;
      }
      const chunk = body.subarray(offset, Math.min(body.length, offset + chunkBytes));
      offset += chunk.length;
      res.write(chunk);
      if (delayMs > 0) setTimeout(writeNext, delayMs);
      else writeNext();
    };
    writeNext();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    stats,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runScenario(fixture, directory, options) {
  const task = new DownloadTask({
    url: `${fixture.origin}/${options.path || 'file.bin'}`,
    mirrors: (options.mirrorPaths || []).map((p) => `${fixture.origin}/${p}`),
    directory,
    filename: `${options.name}.bin`,
    maxConnections: options.maxConnections || 4,
    initialConnections: options.initialConnections || 2,
    minSplitSize: options.minSplitSize || 64 * 1024,
    adaptiveConnections: options.adaptiveConnections !== false,
    retry: { maxTries: 4, baseDelayMs: 10, maxDelayMs: 40, factor: 2 },
    onConflict: 'overwrite',
  });
  const progress = [];
  task.on('progress', (sample) => {
    if (progress.length < 500) {
      progress.push({
        at: Date.now(),
        downloadedBytes: sample.downloadedBytes,
        speed: Math.round(sample.speed || 0),
        connections: sample.connections,
        targetConnections: sample.targetConnections,
      });
    }
  });
  const wallStartedAt = Date.now();
  const state = await task.start();
  const wallMs = Date.now() - wallStartedAt;
  if (state !== 'completed') {
    throw new Error(`${options.name} ended in ${state}: ${task.error ? task.error.message : 'unknown error'}`);
  }
  const output = fs.readFileSync(path.join(directory, `${options.name}.bin`));
  const telemetry = task.getTelemetry();
  const throughputMbps = wallMs > 0 ? (output.length * 8) / (wallMs / 1000) / 1e6 : null;
  return {
    name: options.name,
    state,
    bytes: output.length,
    wallMs,
    throughputMbps: throughputMbps === null ? null : Number(throughputMbps.toFixed(3)),
    telemetry,
    progress,
  };
}

async function runEngineBenchmark(options = {}) {
  const size = Math.max(64 * 1024, Math.floor(options.size || 2 * 1024 * 1024));
  const payload = payloadFor(size);
  const fixture = await startFixture(payload, {
    failDataRequests: options.failDataRequests || 0,
    chunkDelayMs: options.chunkDelayMs || 0,
    slowChunkDelayMs: options.slowChunkDelayMs || 0,
    chunkBytes: options.chunkBytes || 64 * 1024,
  });
  fs.mkdirSync(WORKSPACE_TMP, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(WORKSPACE_TMP, 'engine-benchmark-'));
  const requestBaseline = {
    requests: fixture.stats.requests,
    rangeRequests: fixture.stats.rangeRequests,
    bytesSent: fixture.stats.bytesSent,
    peakActive: fixture.stats.peakActive,
  };
  try {
    const scenarios = [];
    const configs = options.scenarios || [
      { name: 'ranged', path: 'file.bin', maxConnections: 4 },
      { name: 'mirrors', path: 'slow.bin', mirrorPaths: ['fast.bin'], maxConnections: 4 },
    ];
    for (const config of configs) {
      const directory = path.join(tmp, config.name);
      fs.mkdirSync(directory, { recursive: true });
      const result = await runScenario(fixture, directory, config);
      const output = fs.readFileSync(path.join(directory, `${config.name}.bin`));
      if (!output.equals(payload)) throw new Error(`${config.name} produced different bytes`);
      scenarios.push(result);
    }
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      fixture: {
        transport: 'loopback-http1',
        payloadBytes: payload.length,
        requests: fixture.stats.requests - requestBaseline.requests,
        rangeRequests: fixture.stats.rangeRequests - requestBaseline.rangeRequests,
        bytesSent: fixture.stats.bytesSent - requestBaseline.bytesSent,
        peakActive: fixture.stats.peakActive,
        perPath: fixture.stats.perPath,
      },
      scenarios,
    };
  } finally {
    await fixture.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (require.main === module) {
  runEngineBenchmark().then((report) => {
    fs.mkdirSync(WORKSPACE_TMP, { recursive: true });
    const outputPath = path.join(WORKSPACE_TMP, 'engine-benchmark.json');
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      outputPath,
      scenarios: report.scenarios.map((s) => ({
        name: s.name,
        wallMs: s.wallMs,
        throughputMbps: s.throughputMbps,
        firstByteMs: s.telemetry.timeToFirstByteMs,
        tail1Ms: s.telemetry.tail1Ms,
        writes: s.telemetry.writer && s.telemetry.writer.writeCalls,
      })),
    }, null, 2));
  }).catch((err) => {
    console.error(err && err.stack || err);
    process.exitCode = 1;
  });
}

module.exports = { runEngineBenchmark, payloadFor, startFixture };
