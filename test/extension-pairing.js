// AUD-012: local-API extension origin trust.
//
// Before this change ANY chrome-extension:// origin reached every route
// (download list, add/pause/cancel, settings-derived status). Identity is now
// an exact origin the user explicitly allowed once via a native prompt.
//
// The live-server half uses the real IPCServer with a stub manager: pairing
// decisions are injected, so no Electron or dialog is needed.
//
// Run: node test/extension-pairing.js
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const server = require('../src/server.js');
const pairing = require('../src/extension-pairing');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra === undefined ? '' : extra); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}

const CHROME_A = 'chrome-extension://' + 'a'.repeat(32);
const CHROME_B = 'chrome-extension://' + 'b'.repeat(32);
const MOZ_A = 'moz-extension://123e4567-e89b-12d3-a456-426614174000';

function raw(port, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: out });
      });
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

function stubDm(settings) {
  return {
    settings,
    getSettings: () => settings,
    getAllDownloads: () => [],
    emit: () => {},
  };
}

function startServer(options) {
  const srv = new server.IPCServer(stubDm({ trustedExtensionOrigins: [] }), options);
  srv.port = 19771 + Math.floor(Math.random() * 60);
  return new Promise((resolve, reject) => {
    try {
      srv.start();
      setTimeout(() => resolve(srv), 300);
      setTimeout(() => reject(new Error('server did not start')), 3000);
    } catch (e) { reject(e); }
  });
}

(async () => {
  console.log('\n── 1. origin canonicalisation ──');
  check('valid chrome id normalises', pairing.normalizeExtensionOrigin('chrome-extension://' + 'a'.repeat(32)) === CHROME_A);
  check('uppercase id is lowercased', pairing.normalizeExtensionOrigin('CHROME-EXTENSION://' + 'A'.repeat(32)) === CHROME_A);
  check('trailing slash is stripped', pairing.normalizeExtensionOrigin(CHROME_A + '/') === CHROME_A);
  check('valid moz uuid normalises', pairing.normalizeExtensionOrigin(MOZ_A) === MOZ_A);
  check('wrong length rejected', pairing.normalizeExtensionOrigin('chrome-extension://' + 'a'.repeat(31)) === null);
  check('out-of-range characters rejected', pairing.normalizeExtensionOrigin('chrome-extension://' + 'z'.repeat(32)) === null);
  check('a plain web origin is not an extension origin', pairing.isExtensionOrigin('https://example.test') === false);
  check('a path after the id is rejected', pairing.normalizeExtensionOrigin(CHROME_A + '/page.html') === null);
  check('null is rejected', pairing.normalizeExtensionOrigin(null) === null);

  console.log('\n── 2. allowlist helpers ──');
  check('paired lookup is exact', pairing.isPairedExtension([CHROME_A], CHROME_B) === false);
  check('paired lookup is case-insensitive', pairing.isPairedExtension([CHROME_A.toUpperCase()], CHROME_A) === true);
  check('pair appends once', JSON.stringify(pairing.pairExtension([], CHROME_A)) === JSON.stringify([CHROME_A]));
  check('pair does not duplicate', pairing.pairExtension([CHROME_A], CHROME_A + '/').length === 1);
  check('pair ignores a malformed origin', pairing.pairExtension([], 'chrome-extension://nope').length === 0);
  check('unpair removes only the target', JSON.stringify(pairing.unpairExtension([CHROME_A, MOZ_A], CHROME_A)) === JSON.stringify([MOZ_A]));

  console.log('\n── 3. isTrustedOrigin requires pairing for extensions ──');
  check('no origin still passes (native callers)', server.isTrustedOrigin(undefined, []) === true);
  check('localhost passes', server.isTrustedOrigin('http://127.0.0.1:3000', []) === true);
  check('web origin fails', server.isTrustedOrigin('https://evil.example', []) === false);
  check('an unpaired extension fails', server.isTrustedOrigin(CHROME_A, []) === false);
  check('a paired extension passes', server.isTrustedOrigin(CHROME_A, [CHROME_A]) === true);
  check('pairing one extension does not trust another', server.isTrustedOrigin(CHROME_B, [CHROME_A]) === false);

  console.log('\n── 4. live gate: deny / allow / cache ──');
  {
    let paired = [];
    const prompts = [];
    const srv = await startServer({
      pairedOrigins: () => paired.slice(),
      onUnpairedExtension: (origin) => { prompts.push(origin); return false; },
    });
    try {
      const noOrigin = await raw(srv.port, 'GET', '/api/status', { Host: '127.0.0.1:' + srv.port });
      check('native (no Origin) request is served', noOrigin.status === 200);

      const denied = await raw(srv.port, 'GET', '/api/status', { Origin: CHROME_A });
      check('unpaired extension is refused', denied.status === 403, 'status=' + denied.status);
      check('refusal names the pairing reason', denied.body && denied.body.error === 'extension-not-paired');
      check('refusal reflects no CORS origin', !denied.headers['access-control-allow-origin']);
      check('a denial prompts exactly once', prompts.length === 1, 'prompts=' + prompts.length);

      const again = await raw(srv.port, 'GET', '/api/status', { Origin: CHROME_A });
      check('a denied origin is not re-prompted this session', again.status === 403 && prompts.length === 1);

      const other = await raw(srv.port, 'GET', '/api/status', { Origin: CHROME_B });
      check('a different extension gets its own decision', other.status === 403 && prompts.length === 2);
    } finally { srv.stop(); }
  }

  console.log('\n── 5. live gate: approval completes the held request ──');
  {
    let paired = [];
    const prompts = [];
    let release;
    const srv = await startServer({
      pairedOrigins: () => paired.slice(),
      onUnpairedExtension: (origin) => {
        prompts.push(origin);
        return new Promise((resolve) => { release = resolve; });
      },
    });
    try {
      const pending = raw(srv.port, 'GET', '/api/status', { Origin: CHROME_A });
      const pending2 = raw(srv.port, 'GET', '/api/downloads', { Origin: CHROME_A });
      await new Promise((r) => setTimeout(r, 200));
      check('one prompt covers concurrent requests', prompts.length === 1, 'prompts=' + prompts.length);
      paired = [CHROME_A]; // the app persists the approval before resolving true
      release(true);
      const [r1, r2] = await Promise.all([pending, pending2]);
      check('held request succeeds after Allow', r1.status === 200, 'status=' + r1.status);
      check('concurrent request succeeds too', r2.status === 200, 'status=' + r2.status);
      check('approved origin gets CORS reflection', r1.headers['access-control-allow-origin'] === CHROME_A);

      const next = await raw(srv.port, 'GET', '/api/status', { Origin: CHROME_A });
      check('later requests use the persisted pairing without prompting', next.status === 200 && prompts.length === 1);
    } finally { srv.stop(); }
  }

  console.log('\n── 6. an approval that does not persist must not open the gate ──');
  {
    const srv = await startServer({
      pairedOrigins: () => [],
      onUnpairedExtension: () => true, // claims approval but saves nothing
    });
    try {
      const r = await raw(srv.port, 'GET', '/api/status', { Origin: CHROME_A });
      check('unpersisted approval is refused', r.status === 403, 'status=' + r.status);
    } finally { srv.stop(); }
  }

  console.log('\n── 7. preflight and malformed ids ──');
  {
    let paired = [];
    const prompts = [];
    const srv = await startServer({
      pairedOrigins: () => paired.slice(),
      onUnpairedExtension: () => { prompts.push(1); return true; },
    });
    try {
      const pre = await raw(srv.port, 'OPTIONS', '/api/download', { Origin: CHROME_A });
      check('preflight is answered without pairing', pre.status === 200 && prompts.length === 0);
      const bad = await raw(srv.port, 'GET', '/api/status', { Origin: 'chrome-extension://not-an-id' });
      check('a malformed extension id is refused', bad.status === 403);
      check('a malformed id never prompts', prompts.length === 0, 'prompts=' + prompts.length);
    } finally { srv.stop(); }
  }

  console.log('\n── 8. wiring: desktop prompt + settings ──');
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const managerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-manager.js'), 'utf8');
    check('the server is constructed with the allowlist and prompt', /new IPCServer\(downloadManager, \{[\s\S]{0,500}?pairedOrigins:[\s\S]{0,300}?onUnpairedExtension:/.test(mainSrc));
    check('the prompt offers Allow/Block via a native dialog', /buttons: \['Allow', 'Block'\][\s\S]{0,900}?showMessageBox/.test(mainSrc));
    check('approval persists the exact origin', /saveSettings\(\{ trustedExtensionOrigins: pairExtension\(/.test(mainSrc));
    check('denial is session-scoped (no settings write)', /deniedExtensionOrigins\.add\(key\)/.test(mainSrc) && !/saveSettings\(\{ trustedExtensionOrigins: \[\] \}\)/.test(mainSrc));
    check('settings default to no trusted origins', /trustedExtensionOrigins: \[\]/.test(managerSrc));
    check('importing settings never imports trust', /import-settings[\s\S]{0,700}?delete payload\.trustedExtensionOrigins/.test(mainSrc));
  }

  console.log('\n── 8b. the renderer status check stays behind the gate ──');
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
    check('main answers api-status over Node (no Origin header)', /ipcMain\.handle\('api-status'/.test(mainSrc) && /http'\)\.get\(\{ host: '127\.0\.0\.1'/.test(mainSrc));
    check('preload exposes getApiStatus', /getApiStatus: \(\) => ipcRenderer\.invoke\('api-status'\)/.test(preloadSrc));
    check('renderer prefers the IPC path', /window\.aidm\.getApiStatus[\s\S]{0,220}?setState\('Connected'/.test(appSrc));
  }

  console.log('\n── 9. revocation UI ──');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'styles.css'), 'utf8');
    const fn = appSrc.slice(appSrc.indexOf('function renderTrustedExtensions'), appSrc.indexOf('async function showSettingsModal'));
    check('settings expose a trusted-extension list', /id="trusted-extensions"/.test(html));
    check('the list is rendered when settings open', /async function showSettingsModal\(\)[\s\S]{0,160}?renderTrustedExtensions\(\)/.test(appSrc));
    check('origins render as text, never markup', !/innerHTML/.test(fn) && /textContent = origin/.test(fn));
    check('removal persists the reduced list', /saveSettings\(\{ trustedExtensionOrigins: next \}\)/.test(fn));
    check('removal buttons have accessible names', /setAttribute\('aria-label', 'Remove trust for ' \+ origin\)/.test(fn));
    check('rows have styling', /\.trusted-extension-row \{/.test(css));
  }

  console.log(`\nextension-pairing: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
