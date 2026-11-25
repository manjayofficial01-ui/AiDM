// Trust Control Center contracts: every local door must be observable and
// revocable from one Settings tab, with counters that cannot leak request data.
// Run: node test/trust-center.js
'use strict';

const fs = require('fs');
const path = require('path');
const { IPCServer } = require('../src/server');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const html = read('ui', 'index.html');
const app = read('ui', 'app.js');
const css = read('ui', 'styles.css');
const main = read('main.js');
const preload = read('preload.js');
const serverSrc = read('src', 'server.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('\n── 1. Trust pane ──');
check('a Trust tab and pane exist', () => {
  assert(/data-settings-tab="trust"/.test(html), 'tab missing');
  assert(/data-settings-pane="trust"/.test(html), 'pane missing');
});
check('paired extensions are managed in the Trust pane', () => {
  const pane = html.slice(html.indexOf('data-settings-pane="trust"'), html.indexOf('</section>', html.indexOf('data-settings-pane="trust"')));
  assert(/id="trusted-extensions"/.test(pane), 'extension list is not in the Trust pane');
  assert(/id="trust-denied"/.test(pane), 'session denials not visible');
});
check('API, bridge and audit views have containers and controls', () => {
  ['trust-api-status', 'trust-api-counters', 'trust-limiters', 'trust-mcp-status',
    'trust-audit', 'btn-reset-api-stats', 'btn-rotate-mcp-token'].forEach((id) => {
    assert(html.includes(`id="${id}"`), `${id} missing from markup`);
  });
  assert(/\.trust-metric\b/.test(css) && /\.trust-row\b/.test(css), 'trust styles missing');
});
check('the pane refreshes on open and after revoke', () => {
  assert(/if \(id === 'trust'\) refreshTrustOverview\(\)/.test(app), 'not refreshed on tab open');
  const revoker = app.slice(app.indexOf("showNotification('Extension access revoked'") - 400, app.indexOf("showNotification('Extension access revoked'") + 80);
  assert(/refreshTrustOverview\(\)/.test(revoker), 'not refreshed after revoke');
});

console.log('\n── 2. Main-process snapshot & controls ──');
check('renderer exposes only IPC, never the audit file or gate internals', () => {
  assert(/getTrustStatus: \(\) => ipcRenderer\.invoke\('get-trust-status'\)/.test(preload));
  assert(/resetApiStats:/.test(preload) && /rotateMcpToken:/.test(preload));
  assert(!/fs\./.test(preload), 'preload must not import fs');
});
check('main provides snapshot, reset and token rotation', () => {
  ["ipcMain.handle('get-trust-status'", "ipcMain.handle('reset-api-stats'", "ipcMain.handle('rotate-mcp-token'"]
    .forEach((needle) => assert(main.includes(needle), `${needle} missing`));
  assert(/await syncMcpBridge\(\)/.test(main.slice(main.indexOf("handle('rotate-mcp-token'"))), 'rotation bypasses the serialized bridge');
});
check('UI renders all values as text, never innerHTML', () => {
  const fn = app.slice(app.indexOf('async function refreshTrustOverview'), app.indexOf('function renderTrustedExtensions'));
  assert(!/innerHTML/.test(fn), 'trust overview uses innerHTML');
  assert(/textContent =/.test(fn), 'no textContent rendering');
});

console.log('\n── 3. Server telemetry ──');
check('rate limiters keep lifetime allowed/rejected counters', () => {
  assert(/this\.allowed = 0;\s*this\.rejected = 0;/.test(serverSrc), 'lifetime counters missing');
  assert(/this\.rejected\+\+; return false;/.test(serverSrc), 'rejections not counted');
  assert(/reset\(\)[\s\S]{0,140}this\.allowed = 0;/.test(serverSrc), 'reset() does not clear counters');
});
check('getStats reports gates without request data', () => {
  const dm = { getSettings: () => ({ trustedExtensionOrigins: ['chrome-extension://known'] }) };
  const api = new IPCServer(dm, { pairedOrigins: () => dm.getSettings().trustedExtensionOrigins });
  const s = api.getStats();
  assert(s.running === false, 'an unstarted server must report stopped');
  assert(s.activity.requests === 0, 'fresh request counter must be zero');
  assert(s.pairedOrigins.length === 1, 'paired origins missing from snapshot');
  assert(Array.isArray(s.limiters) && s.limiters.some((l) => l.endpoint === '/api/batch'), 'batch limiter missing');
  const dump = JSON.stringify(s);
  assert(!/https?:\/\//.test(dump), 'snapshot leaked a URL');
  api.resetStats();
  assert(api.getStats().activity.requests === 0, 'reset did not work');
});
check('request gate decisions are counted', () => {
  assert(/this\._activity\.requests\+\+/.test(serverSrc), 'requests not counted');
  assert(/this\._activity\.rejectedHost\+\+/.test(serverSrc), 'host gate not counted');
  assert(/this\._activity\.rejectedExtension\+\+/.test(serverSrc), 'pairing denials not counted');
});

console.log(`\ntrust-center: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
