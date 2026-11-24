'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { DownloadManager } = require('../src/download-manager');
const { DownloadEngine } = require('../src/download-engine');
const { DownloadTask } = require('../src/engine/task');

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  OK  ', name);
  } catch (err) {
    fail++;
    console.log('  FAIL', name, '—', err.message);
  }
}

function manager() {
  const mgr = Object.create(DownloadManager.prototype);
  mgr.settings = { defaultSavePath: 'D:\\Downloads', categoryPaths: {} };
  mgr.downloads = new Map();
  mgr.emits = [];
  mgr.emit = (event, payload) => mgr.emits.push([event, payload]);
  mgr._persistDownloads = () => {};
  return mgr;
}

(async () => {
  console.log('\n── 1. captured MIME metadata resolves the extension immediately ──');
  await check('extensionless video URL uses the captured video MIME before any probe', () => {
    const mgr = manager();
    const name = mgr._deriveFilename(
      'https://cdn.example.test/video/stream?id=721',
      null,
      { contentType: 'video/mp4' },
      null,
    );
    assert.equal(name, 'stream.mp4');
  });

  await check('quality MIME supplies the extension when page metadata has none', () => {
    const mgr = manager();
    const name = mgr._deriveFilename(
      'https://cdn.example.test/files/report',
      null,
      null,
      { contentType: 'application/pdf' },
    );
    assert.equal(name, 'report.pdf');
  });

  await check('a URL extension still wins over conflicting MIME metadata', () => {
    const mgr = manager();
    const name = mgr._deriveFilename(
      'https://cdn.example.test/video/clip.webm',
      null,
      { contentType: 'video/mp4' },
      null,
    );
    assert.equal(name, 'clip.webm');
  });

  await check('a version-shaped path is not given an invented extension', () => {
    const mgr = manager();
    const name = mgr._deriveFilename('https://example.test/releases/2.24', null, null, null);
    assert.equal(name, '2.24');
  });

  console.log('\n── 2. the location dialog receives known type data on its first render ──');
  await check('initial dialog payload uses MIME captured by the extension', () => {
    const mgr = manager();
    mgr._resolveFilename = () => new Promise(() => {});
    const dl = {
      id: 'known-mime',
      url: 'https://cdn.example.test/video/clip.mp4',
      filename: 'clip.mp4',
      category: 'video',
      savePath: 'D:\\Downloads',
      totalSize: 0,
      status: 'pending-approval',
      meta: { contentType: 'video/mp4' },
      quality: null,
    };
    mgr.downloads.set(dl.id, dl);
    mgr._askLocation(dl);
    const payload = mgr.emits.find(([event]) => event === 'download-ask-location')[1];
    assert.equal(payload.contentType, 'video/mp4');
  });

  await check('quality MIME reaches the first dialog payload when row metadata has none', () => {
    const mgr = manager();
    mgr._resolveFilename = () => new Promise(() => {});
    const dl = {
      id: 'quality-mime',
      url: 'https://cdn.example.test/files/report',
      filename: 'report.pdf',
      category: 'document',
      savePath: 'D:\\Downloads',
      totalSize: 0,
      status: 'pending-approval',
      meta: null,
      quality: { contentType: 'application/pdf' },
    };
    mgr.downloads.set(dl.id, dl);
    mgr._askLocation(dl);
    const payload = mgr.emits.find(([event]) => event === 'download-ask-location')[1];
    assert.equal(payload.contentType, 'application/pdf');
  });

  console.log('\n── 3. probe reuse is freshness-bound ──');
  await check('a fresh current-start probe is reused without another request', async () => {
    const mgr = manager();
    let calls = 0;
    mgr.engine = { probeMeta: async () => { calls++; throw new Error('unexpected probe'); } };
    const cached = {
      status: 200,
      supportsRange: true,
      contentLength: 4096,
      contentType: 'video/mp4',
      suggestedFilename: null,
      finalUrl: 'https://cdn.example.test/video/stream',
      headers: { etag: 'cached-etag' },
      probedUrl: 'https://cdn.example.test/video/stream',
      probedAt: Date.now(),
    };
    const dl = {
      id: 'fresh-probe',
      url: cached.finalUrl,
      filename: 'stream.mp4',
      category: 'video',
      savePath: 'D:\\Downloads',
      downloaded: 0,
      totalSize: 4096,
      status: 'queued',
      isHls: false,
      isDash: false,
      _nameResolved: true,
      _probe: cached,
    };
    mgr.downloads.set(dl.id, dl);
    const result = await mgr._resolveFilename(dl, {});
    assert.equal(calls, 0);
    assert.equal(result, cached);
  });

  await check('an aged approval probe is refreshed before the transfer starts', async () => {
    const mgr = manager();
    let calls = 0;
    mgr.engine = {
      probeMeta: async () => {
        calls++;
        return {
          status: 200,
          supportsRange: true,
          contentLength: 8192,
          contentType: 'video/webm',
          suggestedFilename: 'fresh.webm',
          finalUrl: 'https://cdn.example.test/video/fresh',
          headers: { etag: 'fresh-etag' },
          responseCookies: null,
        };
      },
    };
    const stale = {
      status: 200,
      supportsRange: true,
      contentLength: 4096,
      contentType: 'video/mp4',
      suggestedFilename: null,
      finalUrl: 'https://cdn.example.test/video/old',
      headers: { etag: 'old-etag' },
      probedUrl: 'https://cdn.example.test/video/old',
      probedAt: Date.now() - 120000,
    };
    const dl = {
      id: 'stale-probe',
      url: stale.finalUrl,
      filename: 'old.mp4',
      category: 'video',
      savePath: 'D:\\Downloads',
      downloaded: 0,
      totalSize: 4096,
      status: 'queued',
      isHls: false,
      isDash: false,
      _nameResolved: true,
      _probe: stale,
      _probePromise: Promise.resolve({ kind: 'file', meta: stale, hlsSize: null }),
    };
    mgr.downloads.set(dl.id, dl);
    const pending = mgr._resolveFilename(dl, {});
    assert.equal(dl._probe, null);
    await pending;
    assert.equal(calls, 1);
    assert.equal(dl._probe.headers.etag, 'fresh-etag');
    assert.ok(dl._probe.probedAt > stale.probedAt);
  });

  await check('a resolver URL change invalidates fresh metadata from the previous URL', async () => {
    const mgr = manager();
    let calls = 0;
    const payloadUrl = 'https://cdn.example.test/files/payload.bin';
    mgr.engine = {
      probeMeta: async () => {
        calls++;
        return {
          status: 200,
          supportsRange: true,
          contentLength: 8192,
          contentType: 'application/octet-stream',
          suggestedFilename: 'payload.bin',
          finalUrl: payloadUrl,
          headers: { etag: 'payload-etag' },
          responseCookies: null,
        };
      },
    };
    const dl = {
      id: 'url-change-probe',
      url: payloadUrl,
      filename: 'payload.bin',
      category: 'other',
      savePath: 'D:\\Downloads',
      downloaded: 0,
      totalSize: 321,
      status: 'queued',
      isHls: false,
      isDash: false,
      _nameResolved: true,
      _probe: {
        status: 200,
        supportsRange: false,
        contentLength: 321,
        contentType: 'application/xml',
        suggestedFilename: 'download.meta4',
        finalUrl: 'https://cdn.example.test/files/download.meta4',
        headers: { etag: 'meta4-etag' },
        probedUrl: 'https://cdn.example.test/files/download.meta4',
        probedAt: Date.now(),
      },
    };
    mgr.downloads.set(dl.id, dl);
    const pending = mgr._resolveFilename(dl, {});
    assert.equal(dl._probe, null);
    await pending;
    assert.equal(calls, 1);
    assert.equal(dl._probe.probedUrl, payloadUrl);
    assert.equal(dl._probe.contentType, 'application/octet-stream');
    assert.equal(dl._probe.headers.etag, 'payload-etag');
  });

  await check('a URL change replaces an in-flight probe from the previous URL', async () => {
    const mgr = manager();
    let calls = 0;
    const payloadUrl = 'https://cdn.example.test/files/payload.bin';
    mgr.engine = {
      probeMeta: async () => {
        calls++;
        return {
          status: 200,
          supportsRange: true,
          contentLength: 8192,
          contentType: 'application/octet-stream',
          suggestedFilename: 'payload.bin',
          finalUrl: payloadUrl,
          headers: { etag: 'payload-etag' },
          responseCookies: null,
        };
      },
    };
    const dl = {
      id: 'in-flight-url-change',
      url: payloadUrl,
      filename: 'payload.bin',
      category: 'other',
      savePath: 'D:\\Downloads',
      downloaded: 0,
      totalSize: 321,
      status: 'queued',
      isHls: false,
      isDash: false,
      _nameResolved: false,
      _probePromiseUrl: 'https://cdn.example.test/files/download.meta4',
      _probePromise: Promise.resolve({
        kind: 'file',
        meta: {
          status: 200,
          supportsRange: false,
          contentLength: 321,
          contentType: 'application/xml',
          suggestedFilename: 'download.meta4',
          finalUrl: 'https://cdn.example.test/files/download.meta4',
          headers: { etag: 'meta4-etag' },
        },
        hlsSize: null,
      }),
    };
    mgr.downloads.set(dl.id, dl);
    const result = await mgr._resolveFilename(dl, {});
    assert.equal(calls, 1);
    assert.equal(result.headers.etag, 'payload-etag');
    assert.equal(dl._probe.probedUrl, payloadUrl);
  });

  await check('a resume revalidates even a fresh same-size probe and ETag', async () => {
    const mgr = manager();
    let calls = 0;
    mgr.engine = {
      probeMeta: async () => {
        calls++;
        return {
          status: 200,
          supportsRange: true,
          contentLength: 4096,
          contentType: 'video/mp4',
          suggestedFilename: null,
          finalUrl: 'https://cdn.example.test/video/stream',
          headers: { etag: 'changed-etag' },
          responseCookies: null,
        };
      },
    };
    const dl = {
      id: 'resume-probe',
      url: 'https://cdn.example.test/video/stream',
      filename: 'stream.mp4',
      category: 'video',
      savePath: 'D:\\Downloads',
      downloaded: 2048,
      totalSize: 4096,
      status: 'paused',
      isHls: false,
      isDash: false,
      _nameResolved: true,
      _probe: {
        status: 200,
        supportsRange: true,
        contentLength: 4096,
        contentType: 'video/mp4',
        suggestedFilename: null,
        finalUrl: 'https://cdn.example.test/video/stream',
        headers: { etag: 'old-etag' },
        probedUrl: 'https://cdn.example.test/video/stream',
        probedAt: Date.now(),
      },
    };
    mgr.downloads.set(dl.id, dl);
    await mgr._resolveFilename(dl, {});
    assert.equal(calls, 1);
    assert.equal(dl._probe.headers.etag, 'changed-etag');
  });

  console.log('\n── 4. the download task reuses the completed metadata probe ──');
  await check('pre-probed file info skips the duplicate network probe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-detection-latency-'));
    const url = 'https://cdn.example.test/video/stream';
    let fetchCalls = 0;
    const task = new DownloadTask({
      url,
      directory: dir,
      filename: 'stream.mp4',
      maxConnections: 2,
      initialConnections: 1,
      fetch: async () => {
        fetchCalls++;
        return new Response('x', {
          status: 206,
          headers: {
            'content-range': 'bytes 0-0/4096',
            'content-type': 'video/webm',
            etag: 'network-etag',
          },
        });
      },
      preProbed: {
        status: 200,
        supportsRange: true,
        contentLength: 4096,
        contentType: 'video/mp4',
        suggestedFilename: 'server-name.mp4',
        finalUrl: 'https://cdn.example.test/video/resolved',
        rangesBlocked: false,
        responseCookies: 'sid=probe-cookie',
        lastModified: 'Sun, 22 Nov 2026 10:00:00 GMT',
        headers: { etag: 'preprobe-etag', 'last-modified': 'Sun, 22 Nov 2026 09:00:00 GMT' },
      },
    });
    try {
      task.runAbort = new AbortController();
      await task.prepare();
      assert.equal(fetchCalls, 0);
      assert.equal(task.info.size, 4096);
      assert.equal(task.info.acceptRanges, true);
      assert.equal(task.info.contentType, 'video/mp4');
      assert.equal(task.info.etag, 'preprobe-etag');
      assert.equal(task.info.lastModified, 'Sun, 22 Nov 2026 10:00:00 GMT');
      assert.equal(task.info.filename, 'server-name.mp4');
      assert.equal(task.info.finalUrl, 'https://cdn.example.test/video/resolved');
      assert.equal(task.info.responseCookies, 'sid=probe-cookie');
      assert.equal(task.baseHeaders.Cookie, 'sid=probe-cookie');
    } finally {
      await task.writer?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('incomplete pre-probed metadata stays unknown instead of inventing size or ranges', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-incomplete-probe-'));
    const url = 'https://cdn.example.test/video/unknown';
    let fetchCalls = 0;
    const task = new DownloadTask({
      url,
      directory: dir,
      filename: 'unknown.mp4',
      fetch: async () => {
        fetchCalls++;
        return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/4096' } });
      },
      preProbed: { status: 200, supportsRange: false, contentLength: 0, headers: {} },
    });
    try {
      task.runAbort = new AbortController();
      await task.prepare();
      assert.equal(fetchCalls, 0);
      assert.equal(task.info.size, null);
      assert.equal(task.info.acceptRanges, false);
      assert.equal(task.info.contentType, null);
      assert.equal(task.info.finalUrl, url);
    } finally {
      await task.writer?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('one-shot skipProbe still takes precedence over pre-probed metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-skip-probe-precedence-'));
    const url = 'https://cdn.example.test/one-shot';
    let fetchCalls = 0;
    const task = new DownloadTask({
      url,
      directory: dir,
      filename: 'one-shot.bin',
      skipProbe: true,
      fetch: async () => { fetchCalls++; throw new Error('one-shot URL must not be probed'); },
      preProbed: {
        status: 200,
        supportsRange: true,
        contentLength: 4096,
        contentType: 'video/mp4',
        suggestedFilename: 'wrong.mp4',
        finalUrl: url,
        headers: { etag: 'wrong-etag' },
      },
    });
    try {
      task.runAbort = new AbortController();
      await task.prepare();
      assert.equal(fetchCalls, 0);
      assert.equal(task.info.size, null);
      assert.equal(task.info.acceptRanges, false);
      assert.equal(task.info.filename, 'one-shot.bin');
      assert.equal(task.info.etag, null);
    } finally {
      await task.writer?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('engine hands the completed probe to the task instead of probing again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-engine-probe-reuse-'));
    const ranges = [];
    const server = http.createServer((req, res) => {
      ranges.push(req.headers.range || '');
      res.writeHead(206, {
        'content-range': 'bytes 0-0/4096',
        'content-length': '1',
        'content-type': 'video/mp4',
        etag: 'engine-etag',
      });
      res.end('x');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const engine = new DownloadEngine();
    engine.engineMaxConnections = 1;
    const url = `http://127.0.0.1:${server.address().port}/stream`;
    const id = 'probe-reuse-row';
    try {
      engine.startDownload({
        id,
        url,
        filepath: path.join(dir, 'stream.mp4'),
        totalSegments: 1,
        meta: {
          status: 200,
          supportsRange: true,
          contentLength: 4096,
          contentType: 'video/mp4',
          suggestedFilename: null,
          finalUrl: url,
          rangesBlocked: false,
          responseCookies: null,
          headers: { etag: 'engine-etag' },
        },
      });
      for (let i = 0; i < 100 && !ranges.some((range) => range && range !== 'bytes=0-0'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      engine.cancelDownload(id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(ranges.filter((range) => range === 'bytes=0-0').length, 0);
      assert.ok(ranges.some((range) => range && range !== 'bytes=0-0'));
    } finally {
      engine.cancelDownload(id);
      await new Promise((resolve) => {
        server.close();
        server.closeAllConnections?.();
        server.once('close', resolve);
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('an error probe cannot cap a later successful download to the error body length', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-error-probe-reuse-'));
    const payload = Buffer.alloc(1000, 0x5a);
    const server = http.createServer((req, res) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      const start = range ? Number(range[1]) : 0;
      const end = range ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
      const body = payload.subarray(start, end + 1);
      res.writeHead(range ? 206 : 200, {
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': String(body.length),
        'content-type': 'application/octet-stream',
        etag: 'payload-etag',
      });
      res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const engine = new DownloadEngine();
    engine.engineMaxConnections = 1;
    const url = `http://127.0.0.1:${server.address().port}/payload.bin`;
    const filepath = path.join(dir, 'payload.bin');
    const id = 'error-probe-row';
    let timer;
    try {
      const completed = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('download timed out')), 5000);
        engine.once('download-complete', resolve);
        engine.once('download-error', (data) => reject(new Error(data.error || 'download failed')));
      });
      engine.startDownload({
        id,
        url,
        filepath,
        totalSegments: 1,
        meta: {
          status: 503,
          supportsRange: true,
          contentLength: 123,
          contentType: 'text/plain',
          suggestedFilename: 'error-body.txt',
          finalUrl: url,
          rangesBlocked: false,
          responseCookies: null,
          headers: { etag: 'error-etag' },
        },
      });
      await completed;
      assert.equal(fs.statSync(filepath).size, payload.length);
      assert.ok(fs.readFileSync(filepath).equals(payload));
    } finally {
      clearTimeout(timer);
      engine.cancelDownload(id);
      await new Promise((resolve) => {
        server.close();
        server.closeAllConnections?.();
        server.once('close', resolve);
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\ndetection-latency: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('UNCAUGHT', err);
  process.exit(1);
});
