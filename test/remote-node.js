// Headless-node foundation: device-code pairing, queue-scoped tokens and a
// standalone CLI. No remote token may reach settings, media resolution or files.
// Run: node test/remote-node.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { RemoteAccess } = require('../src/remote-access');
const { IPCServer } = require('../src/server');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const html = read('ui', 'index.html');
const app = read('ui', 'app.js');
const main = read('main.js');
const preload = read('preload.js');
const serverSrc = read('src', 'server.js');
const cli = read('tools', 'aidm-remote.js');
const pkg = JSON.parse(read('package.json'));

let pass = 0, fail = 0;
const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => { pass++; console.log('  OK  ', name); },
    (e) => { fail++; console.log('  FAIL', name, '—', e.message); },
  ));
}

function fixedAccess() {
  let clock = 1000;
  let n = 0;
  const access = new RemoteAccess({
    now: () => clock,
    random: () => { n++; return String(n).padStart(8, '0'); },
  });
  return { access, advance: (ms) => { clock += ms; } };
}

function req(port, method, route, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers['X-AiDM-Token'] = token;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port, method, path: route, headers, timeout: 5000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (payload) r.write(payload);
    r.end();
  });
}

console.log('\n── 1. Pairing logic ──');
check('a code is pending until the user approves', () => {
  const { access } = fixedAccess();
  const issued = access.requestCode();
  if (!/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(issued.code)) throw new Error('bad code format');
  if (!access.exchange(issued.code).pending) throw new Error('code was usable before approval');
  if (!access.setDecision(issued.code, true)) throw new Error('approval failed');
  if (access.status().pendingCodes !== 0) throw new Error('approved code still pending');
});
check('a token is queue-scoped, single-use per code and verifiable', () => {
  const { access } = fixedAccess();
  const code = access.requestCode().code;
  access.setDecision(code, true);
  const first = access.exchange(code);
  if (!first.token || first.scope !== 'queue') throw new Error('no queue token');
  if (!access.verify(first.token)) throw new Error('token did not verify');
  if (!access.exchange(code).error) throw new Error('code could be exchanged twice');
  if (access.verify('bad'.repeat(20))) throw new Error('invalid token accepted');
  const revoked = access.revokeAll();
  if (revoked !== 1 || access.verify(first.token)) throw new Error('revoke failed');
});
check('denied and expired codes never issue tokens', () => {
  const { access, advance } = fixedAccess();
  const denied = access.requestCode().code;
  access.setDecision(denied, false);
  if (access.exchange(denied).error !== 'denied') throw new Error('denial ignored');
  const expired = access.requestCode().code;
  advance(6 * 60 * 1000);
  if (access.exchange(expired).error !== 'unknown-or-expired-code') throw new Error('expiry ignored');
});

console.log('\n── 2. HTTP enforcement ──');
check('device code + token only unlock queue endpoints', async () => {
  const seen = [];
  const dm = {
    getSettings: () => ({ trustedExtensionOrigins: [] }),
    getAllDownloads: () => seen,
    pauseDownload: (id) => { seen.push({ id, paused: true }); return true; },
    resumeDownload: () => true,
    cancelDownload: () => true,
    rejectDownload: () => true,
    addDownload: () => ({ id: 'new' }),
    importDownloads: () => ({ added: 0, skipped: 0 }),
  };
  const api = new IPCServer(dm, {
    onDeviceCode: (code) => api.remote.setDecision(code, true),
  });
  const server = api;
  server.port = 0;
  server.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const port = server.server.address().port;
    const codeRes = await req(port, 'POST', '/api/device-code', {});
    if (codeRes.status !== 200 || !codeRes.body.code) throw new Error('no code issued');
    const tokenRes = await req(port, 'POST', '/api/device-token', { code: codeRes.body.code });
    const token = tokenRes.body && tokenRes.body.token;
    if (!token) throw new Error('no token issued');
    const ok = await req(port, 'GET', '/api/downloads', undefined, token);
    if (ok.status !== 200) throw new Error(`queue read refused: ${ok.status}`);
    const denied = await req(port, 'GET', '/api/settings', undefined, token);
    if (denied.status !== 403) throw new Error(`settings reachable with queue token: ${denied.status}`);
    const bad = await req(port, 'GET', '/api/downloads', undefined, 'nope'.repeat(12));
    if (bad.status !== 401) throw new Error(`invalid token accepted: ${bad.status}`);
    const paused = await req(port, 'POST', '/api/pause', { id: 'abc' }, token);
    if (paused.status !== 200 || !seen.some((e) => e.id === 'abc' && e.paused)) throw new Error('pause route failed');
    if (api.getRemoteStatus().activeTokens !== 1) throw new Error('remote status missing token');
    if (api.revokeRemoteTokens() !== 1) throw new Error('revoke failed');
  } finally {
    server.stop();
  }
});

console.log('\n── 3. Wiring ──');
check('native dialog gates approval in the main process', () => {
  if (!/title: 'Allow remote AiDM control\?'/.test(main)) throw new Error('no approval dialog');
  if (!/ipcServer\.remote\.setDecision\(code/.test(main)) throw new Error('dialog result ignored');
});
check('scope allowlist excludes settings, resolvers and files', () => {
  const set = serverSrc.slice(serverSrc.indexOf('const REMOTE_QUEUE_ENDPOINTS'), serverSrc.indexOf('function sanitizeHeaders'));
  ['/api/status', '/api/downloads', '/api/download', '/api/batch', '/api/pause', '/api/resume', '/api/cancel']
    .forEach((e) => { if (!set.includes(`'${e}'`)) throw new Error(`${e} missing from allowlist`); });
  ['/api/settings', '/api/resolve', '/api/remove', '/api/video-detected']
    .forEach((e) => { if (set.includes(`'${e}'`)) throw new Error(`${e} must not be remotely reachable`); });
  if (!/x-aidm-token/.test(serverSrc)) throw new Error('token header not checked');
});
check('renderer sees status only, plus a one-click revoke', () => {
  if (!/getRemoteStatus:/.test(preload) || !/revokeRemoteTokens:/.test(preload)) throw new Error('preload missing');
  if (!/ipcMain\.handle\('get-remote-status'/.test(main) || !/ipcMain\.handle\('revoke-remote-tokens'/.test(main)) throw new Error('main missing');
  if (!/id="trust-remote-status"/.test(html) || !/id="btn-revoke-remote"/.test(html)) throw new Error('trust UI missing');
  if (!/btn-revoke-remote/.test(app)) throw new Error('revoke button unwired');
});
check('standalone CLI pairs, stores a 0600 token and speaks JSON only', () => {
  if (!/X-AiDM-Token/.test(cli)) throw new Error('no token header');
  if (!/mode: 0o600/.test(cli)) throw new Error('token file is not private');
  if (!/api\/device-code/.test(cli) || !/api\/device-token/.test(cli)) throw new Error('pairing flow missing');
  if (!/process\.stdout\.write\(JSON\.stringify/.test(cli)) throw new Error('stdout is not JSON');
  if (!pkg.scripts.remote || !JSON.stringify(pkg.build.extraResources).includes('aidm-remote/aidm-remote.js')) throw new Error('CLI not shipped');
});

Promise.all(pending).then(() => {
  console.log(`\nremote-node: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
});
