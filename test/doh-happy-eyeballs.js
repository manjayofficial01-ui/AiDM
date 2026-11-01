// Regression harness for "Download failed: Network error (ERR_INVALID_IP_ADDRESS):
// Invalid IP address: undefined".
//
// The DoH fallback lookup (src/download-engine.js) exists so a download survives
// a resolver that answers NXDOMAIN for a media CDN while public DoH still has the
// record. Node ≥20 runs Happy Eyeballs by default (`getDefaultAutoSelectFamily()`
// is true), so `net` calls the injected lookup with `{ all: true }` and requires an
// ARRAY of {address, family} records back. The fallback used to hand back a bare
// string, which Node reads character by character: every entry's `.address` is
// undefined, the connect fails with ERR_INVALID_IP_ADDRESS, and the engine reports
// the misleading "Invalid IP address: undefined" instead of downloading.
//
// The old smoke check passed because it called the lookup with `{}` (single-answer
// shape), never the all-mode shape the real socket uses.
// Run: node test/doh-happy-eyeballs.js
const http = require('http');
const net = require('net');
const { createDohFallbackLookup } = require('../src/download-engine.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const BODY = 'doh-fallback-body';
const FAKE_HOST = 'cdn.example.test';

let server;
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': String(BODY.length) });
      res.end(BODY);
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// OS resolver always fails the way a poisoned VPN/ISP resolver does; DoH knows
// the answer and points it at the local server.
const failingNativeLookup = (hostname, opts, cb) => {
  cb({ code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND ${hostname}` });
};
const resolveDohTo = (address) => async (host) => (host === FAKE_HOST ? address : null);

function get(port, lookup) {
  return new Promise((resolve) => {
    // agent:false — a pooled keep-alive socket would skip the lookup entirely and
    // make the negative cases pass for the wrong reason.
    const req = http.request({ host: FAKE_HOST, port, path: '/file.bin', lookup, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', (err) => resolve({ error: err }));
    req.end();
  });
}

function askLookup(lookup, options) {
  return new Promise((resolve) => {
    lookup(FAKE_HOST, options, (err, address, family) => resolve({ err, address, family }));
  });
}

(async () => {
  const port = await startServer();
  const lookup = createDohFallbackLookup(failingNativeLookup, resolveDohTo('127.0.0.1'));

  console.log('\u2500\u2500 what the real socket asks for \u2500\u2500');
  check('Happy Eyeballs is on by default in this Node', net.getDefaultAutoSelectFamily() === true,
    `autoSelectFamily=${net.getDefaultAutoSelectFamily()} node=${process.version}`);

  const single = await askLookup(lookup, {});
  check('single-answer shape is a plain IPv4 string',
    !single.err && single.address === '127.0.0.1' && single.family === 4,
    `address=${JSON.stringify(single.address)} family=${single.family}`);

  const all = await askLookup(lookup, { all: true, verbatim: true });
  check('all-mode shape is an array of records',
    !all.err && Array.isArray(all.address) && all.address.length === 1 &&
    all.address[0].address === '127.0.0.1' && all.address[0].family === 4,
    `address=${JSON.stringify(all.address)}`);

  console.log('\u2500\u2500 a download whose OS lookup fails still completes \u2500\u2500');
  const res = await get(port, lookup);
  check('no ERR_INVALID_IP_ADDRESS from the DoH fallback',
    !res.error && res.error?.code !== 'ERR_INVALID_IP_ADDRESS',
    res.error ? `err=${res.error.code} | ${res.error.message}` : `status=${res.status}`);
  check('the DoH-resolved route serves the body', res.status === 200 && res.body === BODY,
    `status=${res.status} body=${JSON.stringify(res.body || '')}`);

  console.log('\u2500\u2500 failure paths keep reporting the real DNS error \u2500\u2500');
  const noDoh = createDohFallbackLookup(failingNativeLookup, async () => null);
  const gone = await get(port, noDoh);
  check('DoH with no answer surfaces the original ENOTFOUND',
    gone.error && gone.error.code === 'ENOTFOUND', `err=${gone.error && gone.error.code}`);

  const junkDoh = createDohFallbackLookup(failingNativeLookup, async () => 'not-an-ip');
  const junk = await askLookup(junkDoh, { all: true });
  check('a junk DoH answer never reaches the socket as an address',
    !!junk.err || (Array.isArray(junk.address) && junk.address.length > 0 &&
      junk.address.every((r) => net.isIP(r.address) !== 0)),
    `address=${JSON.stringify(junk.address)} err=${junk.err && junk.err.code}`);
  const junkSingle = await askLookup(junkDoh, {});
  check('a junk DoH answer is refused in single mode too',
    !!junkSingle.err || !junkSingle.address || net.isIP(junkSingle.address) !== 0,
    `address=${JSON.stringify(junkSingle.address)} err=${junkSingle.err && junkSingle.err.code}`);
  const junkGet = await get(port, junkDoh);
  check('a junk DoH answer falls back to the real DNS error',
    junkGet.error && junkGet.error.code === 'ENOTFOUND',
    `err=${junkGet.error && junkGet.error.code}`);

  try { server.close(); } catch (e) { /* already closed */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
