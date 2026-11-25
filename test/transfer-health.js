// Transfer Health: an honest, read-only view of metrics the engine already
// collects. No new network calls, no credential/URL leakage into the renderer.
// Run: node test/transfer-health.js
'use strict';

const fs = require('fs');
const path = require('path');
const { DownloadEngine } = require('../src/download-engine');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const app = read('ui', 'app.js');
const html = read('ui', 'index.html');
const main = read('main.js');
const preload = read('preload.js');
const engineSrc = read('src', 'download-engine.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('\n── 1. Engine snapshot ──');
check('the engine exposes getTransferHealth without live tasks', () => {
  const engine = new DownloadEngine();
  const h = engine.getTransferHealth('missing-id', { status: 'paused', url: 'https://example.test/a.zip' });
  assert(h && h.id === 'missing-id', 'no snapshot returned');
  assert(h.live === false, 'a missing task must not be reported live');
  assert(h.savedState === 'paused', 'saved row state not included');
  assert(h.progress === null && h.telemetry === null, 'fabricated live metrics');
  if (engine.serverProfiles && engine.serverProfiles.close) engine.serverProfiles.close();
});
check('snapshot is serializable and leaks no URLs, tokens or error text', () => {
  const engine = new DownloadEngine();
  const h = engine.getTransferHealth('x', {
    url: 'https://user:tok3n@secret.example.test/private.zip',
    status: 'error',
    checksum: 'sha256',
    pieces: [1, 2, 3],
  });
  const dump = JSON.stringify(h);
  assert(!/tok3n/.test(dump), 'credential leaked');
  assert(!/private\.zip/.test(dump), 'path leaked');
  assert(h.checksum && h.checksum.mode === 'sha256' && h.checksum.pieces === 3, 'checksum state missing');
  if (engine.serverProfiles && engine.serverProfiles.close) engine.serverProfiles.close();
});
check('engine health reads existing metrics only — no hashing or fetch', () => {
  const start = engineSrc.indexOf('getTransferHealth(');
  const fn = engineSrc.slice(start, engineSrc.indexOf('_hashFileAsync', start));
  assert(!/fetch\(/.test(fn) && !/createHash\(/.test(fn), 'new I/O introduced');
  assert(/getTelemetry\(\)/.test(fn) && /getProgress\(\)/.test(fn), 'live telemetry not used');
  assert(/p\.error = \{ code/.test(fn), 'raw error message not stripped');
});

console.log('\n── 2. UI surface ──');
check('every row has a health action wired to a real handler', () => {
  assert(/data-action="health"/.test(app), 'no row action');
  assert(/case 'health': showHealthModal\(id\)/.test(app), 'action not dispatched');
  assert(/id="health-overlay"/.test(html), 'health dialog missing');
});
check('the dialog is registered with the shared overlay plumbing', () => {
  assert(/'health-overlay': hideHealthModal/.test(app), 'not in OVERLAY_HIDE');
  assert(/'health-overlay'\]/.test(app), 'not in overlay id list');
  assert(/hideHealthModal\(\); \}/.test(app), 'Escape does not close it');
  ['health-close', 'btn-health-close', 'health-verdict', 'health-metrics',
    'health-reasons', 'health-segments', 'health-timeline'].forEach((id) => {
    assert(html.includes(`id="${id}"`), `${id} missing`);
  });
});
check('health IPC is exposed but never reads files in the renderer', () => {
  assert(/getTransferHealth: \(id\) => ipcRenderer\.invoke\('get-transfer-health', id\)/.test(preload));
  assert(/ipcMain\.handle\('get-transfer-health'/.test(main), 'main handler missing');
  const fn = app.slice(app.indexOf('async function refreshHealth'), app.indexOf('function renderTrustedExtensions'));
  assert(!/innerHTML/.test(fn), 'innerHTML used in health view');
  assert(/server-side throttling/.test(fn), 'honest speed caveat missing');
  assert(/formatSpeed\(/.test(fn) && /fmtMs\(/.test(fn), 'metrics not human-formatted');
});

console.log(`\ntransfer-health: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
