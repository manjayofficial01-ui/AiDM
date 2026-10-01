// @ts-check
// Tests for the v5 network layer: proxy parsing, the pooled-agent proxy
// wiring (CONNECT tunnel + plain-HTTP absolute-form), the SOCKS5 handshake,
// the cross-download HostGate, and the yt-dlp proxy argv builder.
// Everything runs against in-process fake proxies — no internet required.
const net = require('net');
const http = require('http');
const assert = require('assert');

const { parseProxyUrl, connectViaProxy } = require('../src/engine/proxy');
const { agentFor, setProxyUrl, getProxyState, destroyAgents } = require('../src/engine/agents');
const { HostGate } = require('../src/engine/host-gate');
const { proxyArgs, setProxyResolver } = require('../src/yt-dlp');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}
function eq(name, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ── Fakes ─────────────────────────────────────────────────────────────────────
// Origin: answers PING with PONG on plain TCP.

function startEchoOrigin() {
  const server = net.createServer((sock) => {
    sock.once('data', (d) => {
      if (d.toString().startsWith('PING')) sock.write('PONG\n');
      sock.destroy();
    });
  });
  return listen(server).then((port) => ({ port, server }));
}

// CONNECT-only proxy. requireAuth checks a fixed credential pair.
function startConnectProxy(opts = {}) {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buf.slice(0, end);
      sock.removeAllListeners('data');
      // A socket stays "flowing" after its last data listener goes away and
      // silently drops arriving chunks — pause so the client's first request
      // bytes wait in the buffer until the pipe is attached.
      sock.pause();
      if (opts.requireAuth) {
        const want = 'Basic ' + Buffer.from('proxyuser:proxypass').toString('base64');
        if (!head.includes('Proxy-Authorization: ' + want)) {
          sock.write('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          sock.end();
          return;
        }
      }
      const m = /^CONNECT (\S+):(\d+) HTTP\/1\.1/i.exec(head);
      if (!m) { sock.destroy(); return; }
      const target = net.connect(Number(m[2]), m[1], () => {
        sock.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: fake\r\n\r\n');
        const rest = Buffer.from(buf.slice(end + 4), 'latin1');
        if (rest.length) target.write(rest);
        target.pipe(sock);
        sock.pipe(target);
        sock.resume();
      });
      target.on('error', () => sock.destroy());
    });
  });
  return listen(server).then((port) => ({ port, server }));
}

function startRejectingProxy() {
  const server = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      sock.end();
    });
  });
  return listen(server).then((port) => ({ port, server }));
}

// Speaks BOTH proxy dialects: absolute-form HTTP relay (for plain http://
// targets) and CONNECT tunnels.
function startDualRelay() {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buf.subarray(0, end).toString('latin1');
      sock.removeAllListeners('data');
      sock.pause();
      const rest = buf.subarray(end + 4);
      const am = /^(GET|POST|HEAD|PUT|DELETE) (https?:\/\/\S+) \S+\r\n/i.exec(head);
      if (am) {
        const target = new URL(am[2]);
        const up = net.connect(Number(target.port) || 80, target.hostname, () => {
          // The relayed request-line is rewritten origin-form; the parser on
          // the origin side only fires the request once the blank line is there.
          const rewritten = head.replace(am[1] + ' ' + am[2] + ' ', am[1] + ' ' + (target.pathname || '/') + ' ') + '\r\n\r\n';
          up.write(Buffer.concat([Buffer.from(rewritten, 'latin1'), rest]));
          up.pipe(sock);
          sock.pipe(up);
          sock.resume();
        });
        up.on('error', () => sock.destroy());
        return;
      }
      const cm = /^CONNECT (\S+):(\d+) HTTP\/1\.1/i.exec(head);
      if (!cm) { sock.destroy(); return; }
      const up = net.connect(Number(cm[2]), cm[1], () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) up.write(rest);
        up.pipe(sock);
        sock.pipe(up);
        sock.resume();
      });
      up.on('error', () => sock.destroy());
    });
  });
  return listen(server).then((port) => ({ port, server }));
}

// Minimal spec-correct SOCKS5 server (no-auth or RFC1929 user/pass).
function startSocks5Proxy(opts = {}) {
  const server = net.createServer((sock) => {
    let phase = 'greeting';
    let buf = Buffer.alloc(0);
    const sendConnectReply = () => {
      if (buf.length < 5) return false;
      const atyp = buf[3];
      const addrLen = atyp === 1 ? 4 : atyp === 3 ? (buf.length < 5 ? -2 : buf[4] + 1) : atyp === 4 ? 16 : -1;
      if (addrLen === -1 || addrLen === -2) return false;
      if (buf.length < 4 + addrLen + 2) return false;
      let host;
      if (atyp === 1) host = [...buf.subarray(4, 8)].join('.');
      else if (atyp === 3) host = buf.subarray(5, 5 + buf[4]).toString('utf8');
      else host = 'ipv6.invalid';
      const port = buf.readUInt16BE(4 + addrLen);
      const reply = Buffer.alloc(10);
      reply[0] = 5; reply[1] = 0; reply[3] = 1;
      reply.writeUInt16BE(port, 8);
      sock.write(reply);
      const leftover = buf.subarray(4 + addrLen + 2);
      sock.removeAllListeners('data');
      sock.pause();
      const target = net.connect(port, host, () => {
        if (leftover.length) target.write(leftover);
        target.pipe(sock);
        sock.pipe(target);
        sock.resume();
      });
      target.on('error', () => sock.destroy());
      return true;
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (phase === 'greeting') {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = [...buf.subarray(2, 2 + n)];
        buf = buf.subarray(2 + n);
        if (opts.requireAuth) {
          if (!methods.includes(0x02)) { sock.write(Buffer.from([5, 0xff])); sock.end(); return; }
          sock.write(Buffer.from([5, 2]));
          phase = 'auth';
        } else {
          sock.write(Buffer.from([5, 0]));
          phase = 'connect';
        }
        if (buf.length) { if (phase === 'connect') sendConnectReply(); }
        return;
      }
      if (phase === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const user = buf.subarray(2, 2 + ulen).toString('utf8');
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
        buf = buf.subarray(3 + ulen + plen);
        if (user === 'proxyuser' && pass === 'proxypass') {
          sock.write(Buffer.from([1, 0]));
          phase = 'connect';
          if (buf.length && !sendConnectReply()) return;
        } else {
          sock.write(Buffer.from([1, 1]));
          sock.end();
        }
        return;
      }
      sendConnectReply();
    });
  });
  return listen(server).then((port) => ({ port, server }));
}

function roundtrip(sock) {
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => { sock.destroy(); reject(new Error('roundtrip timeout')); }, 4000);
    sock.on('data', (d) => {
      out += d.toString();
      if (out.includes('PONG')) { clearTimeout(t); resolve('PONG'); }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
    sock.on('close', () => { if (!out.includes('PONG')) { clearTimeout(t); reject(new Error('closed without PONG')); } });
    sock.write('PING');
  });
}

async function expectReject(name, promise, re) {
  try {
    const s = await promise;
    try { s.destroy(); } catch (e) {}
    check(name, false);
  } catch (e) {
    check(name, !re || re.test(e.message));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nparseProxyUrl');
  {
    const p = parseProxyUrl('http://user:pass@proxy.example:8080');
    eq('http with credentials', p && [p.scheme, p.host, p.port, p.user, p.pass], ['http', 'proxy.example', 8080, 'user', 'pass']);
    check('basic auth header built', p.proxyAuthorization === 'Basic ' + Buffer.from('user:pass').toString('base64'));
    eq('bare host:port', (() => { const q = parseProxyUrl('127.0.0.1:3128'); return q && [q.scheme, q.host, q.port, q.proxyAuthorization]; })(), ['http', '127.0.0.1', 3128, null]);
    eq('socks5 default port', (() => { const q = parseProxyUrl('socks5://10.0.0.1'); return q && [q.scheme, q.port]; })(), ['socks5', 1080]);
    eq('socks5h ipv6 host', (() => { const q = parseProxyUrl('socks5h://[::1]:1081'); return q && [q.scheme, q.host, q.port]; })(), ['socks5h', '::1', 1081]);
    eq('https proxy default port', (() => { const q = parseProxyUrl('https://p.example'); return q && [q.scheme, q.port]; })(), ['https', 443]);
    check('percent-decoded password', (() => { const q = parseProxyUrl('http://u:p%40ss@h'); return q && q.pass; })() === 'p@ss');
    check('empty is null', parseProxyUrl('') === null);
    check('garbage is null', parseProxyUrl('not a url at all') === null);
    check('unsupported scheme is null', parseProxyUrl('ftp://host:21') === null);
    check('bad port is null', parseProxyUrl('http://host:99999') === null);
  }

  const origin = await startEchoOrigin();
  const conn = await startConnectProxy();
  const authConn = await startConnectProxy({ requireAuth: true });
  const denyConn = await startRejectingProxy();
  const socks = await startSocks5Proxy();
  const socksAuth = await startSocks5Proxy({ requireAuth: true });
  const relay = await startDualRelay();
  const httpOrigin = http.createServer((req, res) => { res.writeHead(200); res.end('origin-body'); });
  const httpOriginPort = await listen(httpOrigin);

  console.log('\nconnectViaProxy (in-process fake proxies)');
  {
    const target = () => ({ host: '127.0.0.1', port: origin.port });
    const via = (spec) => connectViaProxy(parseProxyUrl(spec), target());

    await (async () => {
      try { eq('http CONNECT tunnel', await roundtrip(await via(`http://127.0.0.1:${conn.port}`)), 'PONG'); }
      catch (e) { check('http CONNECT tunnel — ' + e.message, false); }
    })();
    await (async () => {
      try { eq('CONNECT with Proxy-Authorization', await roundtrip(await via(`http://proxyuser:proxypass@127.0.0.1:${authConn.port}`)), 'PONG'); }
      catch (e) { check('CONNECT with Proxy-Authorization — ' + e.message, false); }
    })();
    await expectReject('CONNECT 407 with wrong creds', via(`http://wrong:nope@127.0.0.1:${authConn.port}`), /407/);
    await expectReject('CONNECT 407 without creds', via(`http://127.0.0.1:${authConn.port}`), /407/);
    await expectReject('CONNECT 403 rejected', via(`http://127.0.0.1:${denyConn.port}`), /403/);
    await (async () => {
      try { eq('socks5 no-auth (ipv4 ATYP)', await roundtrip(await via(`socks5://127.0.0.1:${socks.port}`)), 'PONG'); }
      catch (e) { check('socks5 no-auth (ipv4 ATYP) — ' + e.message, false); }
    })();
    await (async () => {
      try { eq('socks5 RFC1929 auth', await roundtrip(await via(`socks5://proxyuser:proxypass@127.0.0.1:${socksAuth.port}`)), 'PONG'); }
      catch (e) { check('socks5 RFC1929 auth — ' + e.message, false); }
    })();
    await expectReject('socks5 bad credentials', via(`socks5://bad:nope@127.0.0.1:${socksAuth.port}`), /credentials/);
    await expectReject('socks5 method 0x02 demanded without creds', via(`socks5://127.0.0.1:${socksAuth.port}`), /username\/password/);
    // socks5h delegates DNS: the domain goes out as ATYP 0x03. The fake only
    // answers a well-formed request, so a completed handshake proves it.
    await (async () => {
      try {
        const s = await connectViaProxy(parseProxyUrl(`socks5h://127.0.0.1:${socks.port}`), { host: 'localhost', port: origin.port });
        eq('socks5h sends domains for proxy-side resolution', await roundtrip(s), 'PONG');
      } catch (e) { check('socks5h sends domains for proxy-side resolution — ' + e.message, false); }
    })();
    await expectReject('invalid target rejected', connectViaProxy(parseProxyUrl('http://127.0.0.1:1'), {}), /Invalid proxy target/);
  }

  console.log('\nagents + setProxyUrl');
  {
    check('direct by default', agentFor('https://example.com/x').constructor.name === 'Agent');
    setProxyUrl(`http://127.0.0.1:${conn.port}`);
    const proxied = agentFor('https://example.com/x');
    check('proxied https agent gets tunnel createConnection', typeof proxied.options.createConnection === 'function');
    check('proxy state readable', !!getProxyState().proxy && getProxyState().proxy.port === conn.port);
    check('invalid proxy url yields null', setProxyUrl('ftp://x') === null);
    setProxyUrl('');
    check('cleared back to direct', agentFor('https://example.com/x').options.createConnection === undefined);
    destroyAgents();

    // End-to-end: plain HTTP GET through the dual relay (absolute-form path).
    setProxyUrl(`http://127.0.0.1:${relay.port}`);
    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: httpOriginPort,
        path: '/file.txt',
        method: 'GET',
        agent: agentFor(`http://127.0.0.1:${httpOriginPort}/file.txt`),
      }, (res) => {
        let out = '';
        res.on('data', (d) => out += d);
        res.on('end', () => resolve(out));
      });
      req.on('error', reject);
      req.end();
    });
    eq('plain HTTP via proxy (absolute-form relay)', body, 'origin-body');

    // Keep-alive reuse: the second request must ride the SAME proxy socket.
    const body2 = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: httpOriginPort, path: '/again.txt', method: 'GET',
        agent: agentFor(`http://127.0.0.1:${httpOriginPort}/again.txt`),
      }, (res) => {
        let out = '';
        res.on('data', (d) => out += d);
        res.on('end', () => resolve(out));
      });
      req.on('error', reject);
      req.end();
    });
    eq('proxied keep-alive reuse', body2, 'origin-body');
    setProxyUrl('');
    destroyAgents();
  }

  console.log('\nHostGate');
  {
    const g = new HostGate(2);
    check('acquire up to limit', !!g.acquire('a') && !!g.acquire('a') && !g.acquire('a'));
    check('other host independent', !!g.acquire('b'));
    let woke = 0;
    g.waitForSlot('a', 'task1', () => woke++);
    g.release('a');
    check('release wakes exactly one waiter', woke === 1);
    check('slot available after wake', !!g.acquire('a'));
    g.release('a'); g.release('a'); g.release('b');
    check('release beyond zero stays sane', g.hasCapacity('a') && !!g.acquire('a'));

    let second = 0;
    g.waitForSlot('a', 'task2', () => second++);
    g.waitForSlot('a', 'task2', () => second++);
    g.release('a');
    check('duplicate waiter key wakes once', second === 1);

    const g0 = new HostGate(0);
    check('limit 0 is unlimited', g0.acquire('x') && g0.acquire('x') && g0.acquire('x'));
    const g2 = new HostGate(1);
    g2.acquire('slow');
    let raised = 0;
    g2.waitForSlot('slow', 't', () => raised++);
    g2.setLimit(0);
    check('raising to 0 wakes parked tasks', raised === 1);
    let cleared = 0;
    g2.waitForSlot('slow', 'k', () => cleared++);
    g2.clearWaiter('slow', 'k');
    g2.release('slow');
    check('clearWaiter removes pending callback', cleared === 0);
  }

  console.log('\nyt-dlp proxyArgs');
  eq('explicit proxy passes', proxyArgs({ proxy: 'http://p:8080' }), ['--proxy', 'http://p:8080']);
  eq('socks5 passes', proxyArgs({ proxy: 'socks5h://10.0.0.1:1080' }), ['--proxy', 'socks5h://10.0.0.1:1080']);
  eq('empty yields no flag', proxyArgs({ proxy: '' }), []);
  eq('garbage yields no flag', proxyArgs({ proxy: '; rm -rf /' }), []);
  eq('schemeless yields no flag', proxyArgs({ proxy: 'host:3128' }), []);
  setProxyResolver(() => 'http://global:3128');
  eq('global resolver fills in when no explicit', proxyArgs({}), ['--proxy', 'http://global:3128']);
  eq('explicit beats global', proxyArgs({ proxy: 'http://e:1' }), ['--proxy', 'http://e:1']);
  setProxyResolver(null);

  for (const s of [origin, conn, authConn, denyConn, socks, socksAuth, relay]) await close(s.server);
  await close(httpOrigin);

  console.log(`\nengine-proxy: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('engine-proxy crashed:', e);
  process.exit(1);
});
