// @ts-check
// Keep-alive connection pooling for the download engine — with optional
// HTTP(S)/SOCKS5 proxying.
//
// Why: AiDM opened a fresh TCP+TLS connection for EVERY segment request —
// IDM's headline engine technique is the opposite ("full reuse of connections
// without additional connect and login stages"), and a Jev (TypeSafe System
// One) decision pass over our engine audit vs. the top-5 managers rated this
// the #1 speed bottleneck (0.98 confidence, highest impact). A shared Agent
// with keepAlive reuses sockets across segment retries, re-splits AND across
// concurrent downloads to the same host, saving the handshake cost every time.
//
// Two secure-mode variants exist because the engine's insecure-TLS retry must
// not share sockets with validated ones. Sockets stay keyed by host:port and
// never carry request state, so reuse is safe for range requests.
//
// With a proxy configured (setProxyUrl), HTTPS traffic rides a CONNECT/SOCKS
// tunnel and the agent still keys sockets by the TARGET origin — so pooled
// proxied sockets reuse exactly like direct ones. TLS for tunneled sockets is
// established in createConnection (Node skips its own wrapper once the agent
// supplies the socket), carrying through the per-request rejectUnauthorized
// so the insecure-TLS retry keeps working behind a proxy too.
//
// `destroyAgents()` must be called on app quit: pooled idle sockets keep the
// event loop alive otherwise (tests, and a clean shutdown).

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { parseProxyUrl, connectViaProxy, connectToProxyServer } = require('./proxy');

let secureAgent = null;
let insecureAgent = null;
let plainAgent = null;

/** @type {number} maxSockets the current pool was built with (rebuild on change) */
let poolMaxSockets = 0;
/** @type {string} raw proxy URL as configured ('' = direct) */
let proxyRaw = '';
/** @type {ReturnType<typeof parseProxyUrl>} */
let proxy = null;

function agentOptions(maxSockets, maxFreeSockets) {
  return {
    keepAlive: true,
    keepAliveMsecs: 30 * 1000,
    scheduling: 'lifo',          // hottest host socket first (fewer idle stalls)
    maxSockets,                  // global ceiling across all downloads
    maxFreeSockets,              // idle sockets kept for reuse
    timeout: 60 * 1000,          // destroy idle/free sockets after 60s
  };
}

/**
 * Plain-HTTP through an http/https proxy: the request line is rewritten to
 * absolute-form (GET http://host/path) and the socket points at the proxy.
 * Through a SOCKS proxy the stream is a real TCP tunnel, so requests stay
 * origin-form and only createConnection differs.
 */
class ProxyHttpAgent extends http.Agent {
  /** @param {NonNullable<ReturnType<typeof parseProxyUrl>>} p @param {any} options */
  constructor(p, options) {
    super(options);
    this._aidmProxy = p;
  }

  createConnection(options, cb) {
    const p = this._aidmProxy;
    const host = options.hostname || options.host;
    const port = options.port || 80;
    if (p.scheme === 'http' || p.scheme === 'https') {
      connectToProxyServer(p).then((s) => cb(null, s), (e) => cb(e));
    } else {
      connectViaProxy(p, { host, port }).then((s) => cb(null, s), (e) => cb(e));
    }
    return undefined;
  }

  addRequest(req, options) {
    const p = this._aidmProxy;
    if ((p.scheme === 'http' || p.scheme === 'https') && req._aidmProxiedPath !== true) {
      req._aidmProxiedPath = true;
      // ClientRequest writes headers only after the socket is assigned, so
      // mutating req.path/setHeader here still shapes the request line.
      const authority = req.getHeader('host') || req.host || `${options.hostname || options.host}:${options.port || 80}`;
      const path = req.path || '/';
      if (authority && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
        req.path = `http://${authority}${path}`;
      }
      if (p.proxyAuthorization) req.setHeader('Proxy-Authorization', p.proxyAuthorization);
    }
    super.addRequest(req, options);
  }
}

/**
 * HTTPS createConnection that tunnels through the proxy and layers TLS on
 * the tunneled socket. Socket keys (pool identity) stay target-based.
 */
function tunnelConnector(p) {
  return (options, cb) => {
    const host = options.hostname || options.host;
    const port = options.port || 443;
    let settled = false;
    connectViaProxy(p, { host, port }).then((raw) => {
      const sock = tls.connect({
        socket: raw,
        servername: options.servername || (host && !net.isIP(host) ? host : undefined),
        rejectUnauthorized: options.rejectUnauthorized !== false,
        ALPNProtocols: options.ALPNProtocols,
      }, () => {
        settled = true;
        cb(null, sock);
      });
      // Handshake errors before the socket reaches the agent must surface
      // through the createConnection callback or the request hangs.
      sock.once('error', (err) => { if (!settled) cb(err); });
    }, (err) => {
      if (!settled) cb(err);
    });
  };
}

function createPlainAgent(maxSockets) {
  const opts = agentOptions(maxSockets, 8);
  return proxy ? new ProxyHttpAgent(proxy, opts) : new http.Agent(opts);
}

function createHttpsAgent(maxSockets, validated) {
  const opts = { ...agentOptions(maxSockets, 8) };
  if (!validated) opts.rejectUnauthorized = false;
  if (proxy) opts.createConnection = tunnelConnector(proxy);
  return new https.Agent(opts);
}

/**
 * Point every pooled agent at `raw` (http/https/socks5/socks5h; '' = direct).
 * Returns the parsed proxy, or null when direct/invalid.
 * @param {string} raw
 */
function setProxyUrl(raw) {
  const next = String(raw || '').trim();
  const parsed = next ? parseProxyUrl(next) : null;
  if (next === proxyRaw) return proxy;
  proxyRaw = next;
  proxy = parsed;
  // Pooled sockets were built against the old transport (direct vs proxy, or
  // one proxy vs another): drop them all before the next request.
  destroyAgents();
  return proxy;
}

function getProxyState() {
  return { raw: proxyRaw, proxy };
}

/**
 * Pooled agent for a URL. `insecure` selects the agent whose sockets skip
 * certificate validation (never mixed with validated sockets).
 * @param {string | URL} url
 * @param {{ insecure?: boolean, maxSockets?: number }} [opts]
 */
function agentFor(url, opts = {}) {
  const maxSockets = Math.max(1, Math.min(Number(opts.maxSockets) || 64, 256));
  if (maxSockets !== poolMaxSockets) {
    // The previous code kept the first maxSockets forever: an agent built at
    // 64 silently ignored a later per-download cap of 4.
    poolMaxSockets = maxSockets;
    destroyAgents();
  }
  const insecure = opts.insecure === true;
  try {
    const proto = new URL(String(url)).protocol;
    if (proto === 'http:') {
      if (!plainAgent) plainAgent = createPlainAgent(maxSockets);
      return plainAgent;
    }
    if (insecure) {
      if (!insecureAgent) insecureAgent = createHttpsAgent(maxSockets, false);
      return insecureAgent;
    }
    if (!secureAgent) secureAgent = createHttpsAgent(maxSockets, true);
    return secureAgent;
  } catch (e) {
    return undefined; // malformed URL: let the caller's own validation fail
  }
}

/** Close every pooled socket (app quit / test teardown / proxy swap). */
function destroyAgents() {
  for (const a of [secureAgent, insecureAgent, plainAgent]) {
    try { if (a) a.destroy(); } catch (e) { /* already gone */ }
  }
  secureAgent = null;
  insecureAgent = null;
  plainAgent = null;
}

/** Test hook: current pool size across all agents (sockets incl. idle). */
function pooledSocketCount() {
  let n = 0;
  for (const a of [secureAgent, insecureAgent, plainAgent]) {
    if (!a) continue;
    for (const sockets of Object.values(a.sockets || {})) n += Array.isArray(sockets) ? sockets.length : 0;
    for (const free of Object.values(a.freeSockets || {})) n += Array.isArray(free) ? free.length : 0;
  }
  return n;
}

module.exports = { agentFor, destroyAgents, pooledSocketCount, setProxyUrl, getProxyState };
