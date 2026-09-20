// @ts-check
// Keep-alive connection pooling for the download engine.
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
// `destroyAgents()` must be called on app quit: pooled idle sockets keep the
// event loop alive otherwise (tests, and a clean shutdown).

const http = require('http');
const https = require('https');

let secureAgent = null;
let insecureAgent = null;
let plainAgent = null;

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
 * Pooled agent for a URL. `insecure` selects the agent whose sockets skip
 * certificate validation (never mixed with validated sockets).
 * @param {string | URL} url
 * @param {{ insecure?: boolean, maxSockets?: number }} [opts]
 */
function agentFor(url, opts = {}) {
  const maxSockets = Math.max(1, Math.min(Number(opts.maxSockets) || 64, 256));
  const insecure = opts.insecure === true;
  try {
    const proto = new URL(String(url)).protocol;
    if (proto === 'http:') {
      if (!plainAgent) plainAgent = new http.Agent(agentOptions(maxSockets, 8));
      return plainAgent;
    }
    if (insecure) {
      if (!insecureAgent) insecureAgent = new https.Agent({ ...agentOptions(maxSockets, 8), rejectUnauthorized: false });
      return insecureAgent;
    }
    if (!secureAgent) secureAgent = new https.Agent(agentOptions(maxSockets, 8));
    return secureAgent;
  } catch (e) {
    return undefined; // malformed URL: let the caller's own validation fail
  }
}

/** Close every pooled socket (app quit / test teardown). */
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

module.exports = { agentFor, destroyAgents, pooledSocketCount };
