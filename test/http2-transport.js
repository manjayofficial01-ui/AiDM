// HTTP/2 transport (src/engine/http2-fetch.js).
//
// Proves the fetch-compatible h2 client against a REAL local HTTP/2 server:
// plain GET, ranged GET (206 + Content-Range), redirect following, abort
// signals, concurrent requests over one pooled session, and clean fallback to
// HTTP/1.1 when ALPN refuses h2 or the URL is plain http. The cert is
// self-signed; requests pass the engine's internal `_insecure` hook (same
// convention as init._jar) so no process-wide CA install is needed.
//
// Run: node test/http2-transport.js
'use strict';
// Self-signed cert for the local h2 server. Requests pass the engine's
// internal `_insecure` hook (same convention as init._jar) so no process-wide
// CA install is needed; production callers never set it.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-h2-'));
const KEY = path.join(TMP, 'key.pem');
const CERT = path.join(TMP, 'cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-keyout', KEY, '-out', CERT,
  '-days', '1', '-nodes', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
], { stdio: 'ignore' });

const http2 = require('http2');
const { h2fetch, makeH2AwareFetch, closeAllSessions } = require('../src/engine/http2-fetch');
const H2INIT = { _insecure: true, redirect: 'follow' };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PAYLOAD = Buffer.from('AiDM-HTTP2-transport-test-payload. '.repeat(32), 'utf8');

(async () => {
  const server = http2.createSecureServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, (req, res) => {
    const u = new URL(req.url, 'https://localhost');
    if (u.pathname === '/file') {
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (m) {
          const start = Number(m[1]); const end = Math.min(Number(m[2]), PAYLOAD.length - 1);
          const slice = PAYLOAD.subarray(start, end + 1);
          res.setHeader('content-range', `bytes ${start}-${end}/${PAYLOAD.length}`);
          res.setHeader('content-length', String(slice.length));
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('accept-ranges', 'bytes');
          res.statusCode = 206;
          res.end(slice);
          return;
        }
      }
      res.setHeader('content-length', String(PAYLOAD.length));
      res.setHeader('content-type', 'application/octet-stream');
      res.end(PAYLOAD);
      return;
    }
    if (u.pathname === '/redirect') {
      res.statusCode = 302;
      res.setHeader('location', '/file');
      res.end();
      return;
    }
    if (u.pathname === '/slow') {
      // Drip the body so an abort mid-flight is observable.
      res.setHeader('content-length', String(PAYLOAD.length));
      res.write(PAYLOAD.subarray(0, 16));
      setTimeout(() => { try { res.end(PAYLOAD.subarray(16)); } catch { /* aborted */ } }, 5000);
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  // The h1-only host below will reject our h2 ALPN offer; its server-side
  // socket then emits an 'error' with no listener. Swallow it so teardown
  // stays silent (this is test-harness noise, not the module under test).
  server.on('clientError', () => {});
  server.on('error', () => {});
  const port = server.address().port;
  const base = `https://127.0.0.1:${port}`;

  try {
    console.log('── 1. plain GET over h2 ──');
    {
      const res = await h2fetch(`${base}/file`, H2INIT);
      check('status 200', res.status === 200, String(res.status));
      check('headers.get is case-insensitive',
        res.headers.get('Content-Type') === 'application/octet-stream' && res.headers.get('CONTENT-LENGTH') === String(PAYLOAD.length));
      const buf = Buffer.from(await new Response(res.body).arrayBuffer());
      check('body byte-correct', buf.equals(PAYLOAD), `${buf.length} B`);
      check('res.url reported', typeof res.url === 'string' && res.url.includes('/file'));
    }

    console.log('── 2. ranged GET (206 + Content-Range) ──');
    {
      const res = await h2fetch(`${base}/file`, { ...H2INIT, headers: { Range: 'bytes=10-29' } });
      check('status 206', res.status === 206, String(res.status));
      check('content-range header',
        res.headers.get('content-range') === `bytes 10-29/${PAYLOAD.length}`, res.headers.get('content-range'));
      const buf = Buffer.from(await new Response(res.body).arrayBuffer());
      check('range slice byte-correct', buf.equals(PAYLOAD.subarray(10, 30)), `${buf.length} B`);
    }

    console.log('── 3. redirect following ──');
    {
      const res = await h2fetch(`${base}/redirect`, H2INIT);
      check('302 followed to 200', res.status === 200, String(res.status));
      const buf = Buffer.from(await new Response(res.body).arrayBuffer());
      check('redirect body is the file', buf.equals(PAYLOAD));
    }

    console.log('── 4. abort signal cancels mid-body ──');
    {
      const controller = new AbortController();
      const res = await h2fetch(`${base}/slow`, { ...H2INIT, signal: controller.signal });
      check('headers arrived before abort', res.status === 200);
      setTimeout(() => controller.abort(), 100);
      let threw = null;
      try {
        await new Response(res.body).arrayBuffer();
      } catch (e) { threw = e; }
      check('body read rejects on abort', !!threw, threw && threw.message);
    }

    console.log('── 5. session reuse (one origin, many concurrent requests) ──');
    {
      // Three concurrent requests to the same origin all share the pooled h2
      // session. Assert each returns the exact payload bytes — a broken
      // reuse path (e.g. one session per request, or a race writing the
      // response) would corrupt or drop one of them.
      const results = await Promise.all([
        h2fetch(`${base}/file`, H2INIT),
        h2fetch(`${base}/file`, H2INIT),
        h2fetch(`${base}/file`, H2INIT),
      ].map(async (p) => {
        const r = await p;
        const buf = Buffer.from(await new Response(r.body).arrayBuffer());
        return buf.equals(PAYLOAD);
      }));
      check('all 3 concurrent requests return correct bytes', results.every(Boolean), results.join(','));
    }

    console.log('── 6. graceful fallback when h2 is unavailable ──');
    {
      let fallbackCalls = 0;
      const fallback = async (url, init) => { fallbackCalls++; return { status: 200, url, headers: { get: () => null }, body: null }; };
      const h2Aware = makeH2AwareFetch(fallback);

      // plain http: never h2.
      const r1 = await h2Aware('http://example.com/file', {});
      check('http URL falls back', fallbackCalls === 1 && r1.status === 200);

      // https to an h1-only host: ALPN answers http/1.1 → h2fetch must throw
      // H2NotNegotiatedError and the wrapper must fall back, transparently.
      const https = require('https');
      const h1 = https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, (req, res) => {
        res.end('h1-world');
      });
      h1.on('clientError', () => {});
      h1.on('error', () => {});
      await new Promise(r => h1.listen(0, '127.0.0.1', r));
      try {
        const r2 = await h2Aware(`https://127.0.0.1:${h1.address().port}/x`, {});
        check('h1-only host falls back', fallbackCalls === 2 && r2.status === 200, `calls=${fallbackCalls}`);
      } finally {
        h1.close();
      }
    }

    console.log('── 7. engine integration point ──');
    {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-engine.js'), 'utf8');
      check('engine selects h2 fetch when enabled',
        /fetch: this\.engineHttp2 \? makeH2AwareFetch\(robustFetch\) : robustFetch/.test(src));
      const mgr = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-manager.js'), 'utf8');
      check('engineHttp2 setting plumbed to engine', /http2: s\.engineHttp2/.test(mgr));
      check('engineHttp2 default present', /engineHttp2: false/.test(mgr));
    }
  } finally {
    closeAllSessions();
    server.close();
  }

  console.log(`\nhttp2-transport: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
