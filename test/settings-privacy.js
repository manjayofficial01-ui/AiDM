'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DownloadManager } = require('../src/download-manager');

let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log('  OK  ', name); }
  catch (error) { failed++; console.log('  FAIL', name, error.message); }
}
const fixture = () => ({
  defaultSavePath: path.resolve(__dirname), categoryPaths: {},
  aiApiKey: 'fixture-ai-secret', proxyUrl: 'http://fixture-user:fixture-proxy-secret@proxy.test:8080',
  maxConcurrentDownloads: 3,
  fileHosts: {
    rapidgator: { user: 'fixture-user', password: 'fixture-host-secret', cookie: 'fixture-cookie-secret' },
    other: { user: 'other-user', password: 'fixture-other-secret', cookie: 'fixture-other-cookie' },
  },
});
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const handlers = new Map();
const manager = Object.create(DownloadManager.prototype);
manager.settings = fixture();
manager.engine = { setSpeedLimit() {}, setHlsConcurrency() {} };
manager.bandwidthWatch = { stop() {} };
for (const name of ['_applyEngineSettings', '_ensureDirectories', '_saveSettings', '_purgeFinished']) manager[name] = () => {};
const context = vm.createContext({
  downloadManager: manager,
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  assertAllowedSettingsPaths() {}, syncAiConfig() {}, applyTimetableSpeed() {},
  scheduler: null, clipboardMonitor: null, tray: null,
});
const viewPath = path.join(__dirname, '../src/settings-view.js');
if (fs.existsSync(viewPath)) Object.assign(context, require(viewPath));
for (const name of ['get-settings', 'save-settings', 'import-settings', 'export-settings']) {
  const match = new RegExp("ipcMain\\.handle\\('" + name + "'[\\s\\S]*?\\n\\}\\);").exec(source);
  assert.ok(match, name);
  vm.runInContext(match[0], context);
}
const invoke = (name, payload) => handlers.get(name)({ sender: {} }, payload);
const clean = value => {
  const serialized = JSON.stringify(value);
  assert.ok(!/fixture-(?:ai|proxy|host|cookie|other)-secret|fixture-other-cookie/.test(serialized), 'returned settings contain fixture secrets');
  assert.equal(value.aiApiKey, undefined);
  for (const cfg of Object.values(value.fileHosts || {})) {
    assert.equal(cfg.password, undefined);
    assert.equal(cfg.cookie, undefined);
  }
};
(async () => {
  for (const name of ['get-settings', 'save-settings', 'import-settings', 'export-settings']) {
    await check(`${name} returns no reusable credentials`, async () => clean(await invoke(name, {})));
  }
  await check('renderer gets presence flags and a credential-free proxy address', async () => {
    const view = await invoke('get-settings');
    assert.equal(view.hasAiApiKey, true);
    assert.equal(view.hasProxyCredentials, true);
    assert.equal(view.proxyUrl, 'http://proxy.test:8080');
    assert.equal(view.fileHosts.rapidgator.hasPassword, true);
    assert.equal(view.fileHosts.rapidgator.hasCookie, true);
  });
  await check('view does not mutate settings or share nested host objects', async () => {
    const before = JSON.stringify(manager.settings);
    const view = await invoke('get-settings');
    view.fileHosts.rapidgator.user = 'changed-view-only';
    assert.equal(JSON.stringify(manager.settings), before);
  });
  await check('omitted secrets survive ordinary settings updates', async () => {
    await invoke('save-settings', { maxConcurrentDownloads: 5, fileHosts: { rapidgator: { user: 'updated-user' } } });
    assert.equal(manager.settings.aiApiKey, 'fixture-ai-secret');
    assert.equal(manager.settings.proxyUrl, fixture().proxyUrl);
    assert.equal(manager.settings.fileHosts.rapidgator.password, 'fixture-host-secret');
    assert.equal(manager.settings.fileHosts.rapidgator.cookie, 'fixture-cookie-secret');
    assert.equal(manager.settings.fileHosts.other.password, 'fixture-other-secret');
    assert.equal(manager.settings.maxConcurrentDownloads, 5);
  });
  await check('explicit replacements and clearing persist without being returned', async () => {
    const result = await invoke('save-settings', { aiApiKey: 'fixture-ai-secret', proxyUrl: '', fileHosts: { rapidgator: { password: '', cookie: '' } } });
    clean(result);
    assert.equal(manager.settings.proxyUrl, '');
    assert.equal(manager.settings.fileHosts.rapidgator.password, '');
    assert.equal(manager.settings.fileHosts.rapidgator.cookie, '');
    assert.equal(result.fileHosts.rapidgator.hasPassword, false);
  });
  await check('portable export/import preserves existing private proxy and secrets', async () => {
    manager.settings = fixture();
    const exported = await invoke('export-settings');
    clean(exported);
    assert.equal(exported.proxyUrl, undefined);
    assert.equal(exported.hasAiApiKey, undefined);
    assert.equal(exported.fileHosts.rapidgator.hasPassword, undefined);
    await invoke('import-settings', exported);
    assert.equal(manager.settings.proxyUrl, fixture().proxyUrl);
    assert.equal(manager.settings.aiApiKey, 'fixture-ai-secret');
    assert.equal(manager.settings.fileHosts.rapidgator.cookie, 'fixture-cookie-secret');
  });
  await check('plain proxy export remains portable and invalid URLs are not exposed', async () => {
    manager.settings.proxyUrl = 'socks5://proxy.test:1080';
    assert.equal((await invoke('export-settings')).proxyUrl, 'socks5://proxy.test:1080');
    manager.settings.proxyUrl = 'invalid fixture-proxy-secret';
    const view = await invoke('get-settings');
    clean(view);
    assert.equal(view.proxyUrl, '');
    assert.equal((await invoke('export-settings')).proxyUrl, undefined);
  });
  console.log(`\nsettings-privacy: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
