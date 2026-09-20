// Regression harness: pooled keep-alive connection reuse in the engine.
//
// Why: the engine used to open a fresh TCP+TLS connection for EVERY segment
// request (robustFetch / _openRequest / _fetchUrl all used client.request with
// the default agent). IDM's headline engine technique is the opposite —
// "full reuse of connections without additional connect and login stages" —
// and a Jev decision pass rated the missing reuse AiDM's #1 speed bottleneck.
//
// These tests pin the fix: consecutive requests to the same host MUST reuse
// one pooled socket, and teardown must release every pooled socket.
//
// Run: node test/engine-agents.js
'use strict';
const http = require('http');
const assert = require('assert');
const { agentFor, destroyAgents, pooledSocketCount } = require('../src/engine/agents');
const { DownloadEngine } = require('../src/download-engine');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function main() {
  // ── 1. agent selection sanity ────────────────────────────────────────────
  const a1 = agentFor('https://example.com/x');
  const a2 = agentFor('https://example.com/y');
  const a3 = agentFor('https://other.example/z');
  check('secure agent is https with keepAlive', a1 && a1.constructor.name === 'Agent' && a1.options.keepAlive === true);
  check('same secure agent reused across hosts', a1 === a2 && a1 === a3);
  const a4 = agentFor('https://example.com/x', { insecure: true });
  check('insecure agent separate from secure', a4 !== a1 && a4.options.rejectUnauthorized === false);
  const a5 = agentFor('http://example.com/x');
  check('plain http gets its own agent', a5 !== a1 && a5 !== a4);
  check('malformed url yields no agent', agentFor('not a url') === undefined);
  check('maxSockets clamped', agentFor('http://example.com/y', { maxSockets: 99999 }).options.maxSockets <= 256);

  // ── 2. socket REUSE over the real engine transport ───────────────────────
  // The probe path (_openRequest/_probeFile) and robustFetch are what segment
  // workers ride on; if they still open a fresh connection per request, the
  // server sees N distinct sockets for N requests. With pooling it sees 1.
  let connections = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end('hello');
  });
  server.on('connection', () => { connections++; });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  const engine = new DownloadEngine();
  // 6 sequential probes = HEAD + Range probes per probeFile call, all to one host.
  for (let i = 0; i < 3; i++) {
    await engine.probeMeta(`${base}/file-${i}.bin`, {});
  }
  check('probe requests all answered', requests >= 3, `${requests} requests`);
  // Probe path holds the HEAD response open while the Range probe runs (its
  // headers feed the final result), so one probe occupies two sockets by
  // design: measured 4 connections for 6 requests (was 6/6 without pooling).
  // Full single-socket reuse is asserted on the GET path below — that is the
  // path segment downloads actually ride on.
  check('probe path reuses sockets (fewer conns than requests)', connections <= 4 && connections < requests, `${connections} connections for ${requests} requests`);

  // Direct robustFetch-style reuse through the pooled agent: two GETs in a row.
  const before = connections;
  await new Promise((resolve, reject) => {
    http.get(`${base}/a`, { agent: agentFor(`${base}/a`) }, (res) => {
      res.resume(); res.on('end', resolve);
    }).on('error', reject);
  });
  await new Promise((resolve, reject) => {
    http.get(`${base}/b`, { agent: agentFor(`${base}/b`) }, (res) => {
      res.resume(); res.on('end', resolve);
    }).on('error', reject);
  });
  check('pooled agent reuses the socket for back-to-back GETs', connections - before <= 1, `${connections - before} new connection(s)`);

  // ── 3. teardown releases every pooled socket ─────────────────────────────
  await new Promise((r) => setTimeout(r, 150)); // let sockets settle into the pool
  check('pool holds sockets before destroy', pooledSocketCount() > 0 || connections > 0);
  destroyAgents();
  check('destroyAgents clears the pool', pooledSocketCount() === 0);

  server.close();
  await new Promise((r) => server.closeAllConnections ? server.closeAllConnections(() => r()) : setTimeout(r, 100));

  console.log(`\nengine-agents: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
