// @ts-check
// Dependency-free proxy connectors for the engine's pooled HTTP agents.
//
// Supports http://, https:// (CONNECT tunnel) and socks5:// / socks5h://
// (RFC 1928 + optional RFC 1929 username/password) proxies, with optional
// credentials embedded in the URL: http://user:pass@proxy:8080
//
// Everything here returns a raw, connected duplex stream pointed at the
// TARGET host; the caller layers TLS on top when needed. That keeps the
// agents module in charge of pooling (sockets stay keyed by target origin,
// so keep-alive reuse works exactly like the direct path).

const net = require('net');
const tls = require('tls');
const dns = require('dns');

const CONNECT_TIMEOUT_MS = 15000;
const MAX_CONNECT_HEADER_BYTES = 16 * 1024;

const PROXY_SCHEMES = new Set(['http', 'https', 'socks5', 'socks5h']);

/**
 * Parse a proxy URL. Bare "host:port" is accepted and treated as http.
 * @param {string} raw
 * @returns {{ scheme: string, host: string, port: number, user: string, pass: string, proxyAuthorization: string | null } | null}
 */
function parseProxyUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s);
  } catch (e) {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (!PROXY_SCHEMES.has(scheme)) return null;
  // WHATWG keeps the brackets on IPv6 hostnames; net.connect wants them gone.
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) return null;
  const defaultPort = scheme === 'https' ? 443 : scheme.startsWith('socks') ? 1080 : 80;
  const port = u.port ? Number(u.port) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let user = '';
  let pass = '';
  try {
    user = decodeURIComponent(u.username || '');
    pass = decodeURIComponent(u.password || '');
  } catch (e) {
    user = u.username || '';
    pass = u.password || '';
  }
  const proxyAuthorization = user || pass
    ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    : null;
  return { scheme, host, port, user, pass, proxyAuthorization };
}

/**
 * Open a socket (optionally TLS-wrapped for https:// proxies) to the proxy
 * server itself. Resolves with the connected stream.
 * @param {ReturnType<typeof parseProxyUrl>} proxy
 * @param {number} [timeoutMs]
 * @returns {Promise<net.Socket | tls.TLSSocket>}
 */
function connectToProxyServer(proxy, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!proxy) {
      reject(new Error('No proxy configured'));
      return;
    }
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeListener('error', onError);
      fn(value);
    };
    const onErr = (err) => done(reject, err);
    const onError = (err) => onErr(err);
    let socket;
    if (proxy.scheme === 'https') {
      socket = tls.connect({
        host: proxy.host,
        port: proxy.port,
        servername: proxy.host,
        // Proxy endpoints are frequently served with a corporate CA cert;
        // strict validation here would make such proxies unusable, and the
        // tunneled payload is still TLS-validated end-to-end by the engine.
        rejectUnauthorized: false,
      });
      socket.once('secureConnect', () => done(resolve, socket));
    } else {
      socket = net.connect({ host: proxy.host, port: proxy.port });
      socket.once('connect', () => done(resolve, socket));
    }
    socket.once('error', onError);
    socket.setTimeout(timeoutMs, () => {
      const err = new Error(`Proxy ${proxy.host}:${proxy.port} connection timed out`);
      socket.destroy(err);
      onErr(err);
    });
  });
}

/**
 * HTTP CONNECT tunnel (RFC 9110 §9.3.6) through an http/https proxy.
 * Resolves with the raw socket positioned at the first target byte; any
 * bytes the proxy sent beyond the CONNECT response are unshifted back.
 */
function connectViaHttpProxy(proxy, target, timeoutMs) {
  return connectToProxyServer(proxy, timeoutMs).then((socket) => new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const fail = (msg) => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.destroy();
      reject(new Error(msg));
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > MAX_CONNECT_HEADER_BYTES) fail('Proxy CONNECT response too large');
        return;
      }
      const head = buf.subarray(0, end).toString('latin1');
      const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
      const status = m ? Number(m[1]) : 0;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.setTimeout(0);
      if (status !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT to ${target.host}:${target.port} failed: HTTP ${status || '?'}`));
        return;
      }
      const leftover = buf.subarray(end + 4);
      if (leftover.length) socket.unshift(leftover);
      resolve(socket);
    };
    const onError = (err) => fail(`Proxy CONNECT failed: ${err.message}`);
    const onTimeout = () => fail('Proxy CONNECT timed out');
    socket.on('data', onData);
    socket.once('error', onError);
    socket.setTimeout(timeoutMs || CONNECT_TIMEOUT_MS, onTimeout);

    const host = net.isIPv6(target.host) ? `[${target.host}]` : target.host;
    const lines = [
      `CONNECT ${host}:${target.port} HTTP/1.1`,
      `Host: ${host}:${target.port}`,
    ];
    if (proxy.proxyAuthorization) lines.push(`Proxy-Authorization: ${proxy.proxyAuthorization}`);
    lines.push('Connection: keep-alive', '', '');
    socket.write(lines.join('\r\n'));
  }));
}

const SOCKS_ERRORS = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
};

function socksAddressBytes(host) {
  if (net.isIPv4(host)) return { atyp: 1, bytes: Buffer.from(host.split('.').map(Number)) };
  const domain = Buffer.from(String(host), 'utf8');
  if (domain.length > 255) return null;
  return { atyp: 3, bytes: Buffer.concat([Buffer.from([domain.length]), domain]) };
}

/**
 * SOCKS5 CONNECT (RFC 1928) with optional username/password auth (RFC 1929).
 * socks5 resolves the target locally (IPv4) when possible; socks5h always
 * delegates DNS to the proxy.
 */
function connectViaSocksProxy(proxy, target, timeoutMs, remoteDns) {
  const sendConnect = (socket, addressBuf) => {
    const head = Buffer.alloc(4);
    head[0] = 0x05; head[1] = 0x01; head[3] = addressBuf.atyp;
    const port = Buffer.alloc(2);
    port.writeUInt16BE(target.port);
    socket.write(Buffer.concat([head, addressBuf.bytes, port]));
  };

  const resolveAddress = () => {
    if (remoteDns) return Promise.resolve(socksAddressBytes(target.host));
    if (net.isIPv4(target.host)) return Promise.resolve(socksAddressBytes(target.host));
    if (net.isIPv6(target.host)) {
      const bytes = Buffer.from(target.host.split(':').filter(Boolean).flatMap((h) => {
        const v = parseInt(h, 16);
        return [(v >> 8) & 0xff, v & 0xff];
      }));
      if (bytes.length === 16) {
        return Promise.resolve({ atyp: 4, bytes });
      }
      return Promise.resolve(socksAddressBytes(target.host)); // domain fallback
    }
    return new Promise((res) => {
      dns.lookup(target.host, { family: 4 }, (err, address) => {
        res(err || !address ? socksAddressBytes(target.host) : { atyp: 1, bytes: Buffer.from(address.split('.').map(Number)) });
      });
    });
  };

  return Promise.all([connectToProxyServer(proxy, timeoutMs), resolveAddress()])
    .then(([socket, address]) => new Promise((resolve, reject) => {
      if (!address) {
        socket.destroy();
        reject(new Error('SOCKS5: target host name too long for a domain request'));
        return;
      }
      let buf = Buffer.alloc(0);
      let phase = 'greeting';
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        pump();
      };
      const onError = (err) => fail(`SOCKS5 proxy failed: ${err.message}`);
      const onTimeout = () => fail('SOCKS5 proxy handshake timed out');
      const fail = (msg) => {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('timeout', onTimeout);
        socket.destroy();
        reject(new Error(msg));
      };
      const pump = () => {
        if (phase === 'greeting') {
          if (buf.length < 2) return;
          const ver = buf[0];
          const method = buf[1];
          buf = buf.subarray(2);
          if (ver !== 5) return fail(`SOCKS5: unexpected version ${ver}`);
          if (method === 0xff) return fail('SOCKS5: proxy rejected all auth methods (it likely requires a username/password)');
          if (method === 2) {
            if (!proxy.user) return fail('SOCKS5: proxy requires a username/password');
            const u = Buffer.from(proxy.user, 'utf8');
            const p = Buffer.from(proxy.pass || '', 'utf8');
            if (u.length > 255 || p.length > 255) return fail('SOCKS5: credentials too long');
            phase = 'auth';
            socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
            return;
          }
          phase = 'connect';
          sendConnect(socket, address);
          return;
        }
        if (phase === 'auth') {
          if (buf.length < 2) return;
          const status = buf[1];
          buf = buf.subarray(2);
          if (status !== 0) return fail('SOCKS5: proxy rejected the credentials');
          phase = 'connect';
          sendConnect(socket, address);
          return;
        }
        // phase === 'connect': reply is 4+ variable address bytes.
        if (buf.length < 4) return;
        const rep = buf[1];
        const atyp = buf[3];
        const addrLen = atyp === 1 ? 4 : atyp === 3 ? (buf.length < 5 ? null : buf[4]) : atyp === 4 ? 16 : -1;
        if (addrLen === null) return; // need the domain-length byte
        if (addrLen === -1) return fail(`SOCKS5: unexpected address type ${atyp}`);
        const total = 4 + addrLen + (atyp === 3 ? 1 : 0) + 2;
        if (buf.length < total) return;
        if (rep !== 0) return fail(`SOCKS5: ${SOCKS_ERRORS[rep] || `connect failed (${rep})`}`);
        const leftover = buf.subarray(total);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('timeout', onTimeout);
        socket.setTimeout(0);
        if (leftover.length) socket.unshift(leftover);
        resolve(socket);
      };
      socket.on('data', onData);
      socket.once('error', onError);
      socket.setTimeout(timeoutMs || CONNECT_TIMEOUT_MS, onTimeout);

      const methods = proxy.user ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    }));
}

/**
 * Connect to {host,port} through the given parsed proxy, dispatching on
 * scheme. Resolves with a raw socket ready for TLS or plain HTTP.
 * @param {ReturnType<typeof parseProxyUrl>} proxy
 * @param {{ host: string, port: number }} target
 * @param {{ timeoutMs?: number }} [opts]
 */
function connectViaProxy(proxy, target, opts = {}) {
  const timeoutMs = opts.timeoutMs || CONNECT_TIMEOUT_MS;
  if (!proxy) return Promise.reject(new Error('No proxy configured'));
  if (!target || !target.host || !Number.isFinite(target.port)) {
    return Promise.reject(new Error('Invalid proxy target'));
  }
  if (proxy.scheme === 'http' || proxy.scheme === 'https') {
    return connectViaHttpProxy(proxy, target, timeoutMs);
  }
  return connectViaSocksProxy(proxy, target, timeoutMs, proxy.scheme === 'socks5h');
}

module.exports = {
  parseProxyUrl,
  connectViaProxy,
  connectToProxyServer,
};
