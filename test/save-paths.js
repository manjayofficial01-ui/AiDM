'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { isAllowedSavePath } = require('../src/save-paths');

const scratch = fs.mkdtempSync(path.join(__dirname, '_save-paths-'));
let pass = 0, fail = 0;
async function check(name, run) {
  try { await run(); pass++; console.log('  OK  ', name); }
  catch (error) { fail++; console.log('  FAIL', name, error.message); }
}

(async () => {
  try {
    const root = path.join(scratch, 'downloads');
    const category = path.join(scratch, 'videos');
    const outside = path.join(scratch, 'outside');
    for (const folder of [root, category, outside]) fs.mkdirSync(folder);
    const settings = { defaultSavePath: root, categoryPaths: { video: category } };
    const allowed = (candidate) => isAllowedSavePath(settings, candidate);
    await check('configured roots and not-yet-created children are allowed', () => {
      for (const candidate of [root, category, path.join(root, 'new', 'child'), path.join(category, 'new')]) {
        assert.equal(allowed(candidate), true, candidate);
      }
    });
    await check('outside, sibling-prefix and traversal paths are denied', () => {
      for (const candidate of [outside, root + '-other', path.join(root, '..', 'outside')]) {
        assert.equal(allowed(candidate), false, candidate);
      }
    });
    await check('missing, relative, NUL and non-string paths are denied', () => {
      for (const candidate of ['', null, {}, '.', path.relative(process.cwd(), root), root + '\0bad']) {
        assert.equal(allowed(candidate), false);
      }
      assert.equal(isAllowedSavePath(null, root), false);
    });
    await check('filesystem root and Windows case follow platform path semantics', () => {
      assert.equal(isAllowedSavePath({ defaultSavePath: path.parse(root).root }, root), true);
      if (process.platform === 'win32') assert.equal(allowed(root.toUpperCase()), true);
    });
    await check('junction or symlink cannot escape even through nonexistent children', () => {
      const link = path.join(root, 'escape');
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(allowed(link), false);
      assert.equal(allowed(path.join(link, 'new', 'child')), false);
      const inside = path.join(root, 'inside-link');
      fs.symlinkSync(category, inside, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(allowed(path.join(inside, 'new')), true);
    });
    await check('a configured symlink root is usable', () => {
      const link = path.join(scratch, 'configured-link');
      fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(isAllowedSavePath({ defaultSavePath: link }, path.join(link, 'new')), true);
    });

    const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const handlers = new Map();
    const calls = [];
    let selection = outside;
    const sender = {}, otherSender = {};
    const context = vm.createContext({
      isAllowedSavePath,
      ...require('../src/settings-view'),
      downloadManager: {
        getSettings: () => settings,
        saveSettings: (next) => { calls.push(['settings', next]); return Object.assign(settings, next); },
        addDownload: (opts) => { calls.push(['add', opts]); return opts; },
        queueDownload: (opts) => { calls.push(['queue', opts]); return opts; },
        approveDownload: (id, savePath, filename) => { calls.push(['approve', savePath]); return { id, savePath, filename }; },
        importDownloads: (items) => { calls.push(['import', items]); return items; },
      },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      locationDialog: { pickFolder: async () => selection },
      resolvers: { hasResolverFor: () => false },
      syncAiConfig: () => {}, applyTimetableSpeed: () => {},
      scheduler: null, clipboardMonitor: null, tray: null,
    });
    const helpers = main.slice(main.indexOf('function assertAllowedSavePath('), main.indexOf("ipcMain.handle('add-download'"));
    vm.runInContext('const approvedSaveFolders = new WeakMap();\n' + helpers, context);
    for (const name of ['add-download', 'queue-download', 'approve-download', 'import-downloads', 'select-folder', 'save-settings', 'import-settings']) {
      const match = new RegExp("ipcMain\\.handle\\('" + name + "'[\\s\\S]*?\\n\\}\\);").exec(main);
      assert.ok(match, name);
      vm.runInContext(match[0], context);
    }
    const invoke = (name, payload, caller = sender) => handlers.get(name)({ sender: caller }, payload);
    const payload = (savePath) => ({ id: 'fixture', url: 'https://example.test/file.mp4', savePath, filename: 'file.mp4' });
    for (const name of ['add-download', 'queue-download', 'approve-download']) {
      await check(`${name} rejects before manager side effects`, async () => {
        const before = calls.length;
        await assert.rejects(invoke(name, payload(outside)), /outside the configured/);
        assert.equal(calls.length, before);
      });
      await check(`${name} passes valid custom filenames and paths through`, async () => {
        const result = await invoke(name, payload(root));
        assert.equal(result.savePath, root);
        assert.equal(result.filename, 'file.mp4');
      });
    }
    await check('approval requires an explicit path before any mutation', async () => {
      const before = calls.length;
      for (const missing of [null, undefined, '']) {
        await assert.rejects(invoke('approve-download', payload(missing)), /outside the configured/);
      }
      assert.equal(calls.length, before);
    });
    await check('add and queue can use default locations', async () => {
      await invoke('add-download', payload(undefined));
      await invoke('queue-download', payload(undefined));
    });
    await check('invalid import is rejected before any row is created', async () => {
      const before = calls.length;
      await assert.rejects(invoke('import-downloads', [payload(root), payload(outside)]), /outside the configured/);
      assert.equal(calls.length, before);
      const items = ['https://example.test/file.mp4', payload(root)];
      assert.equal(await invoke('import-downloads', items), items);
    });
    for (const name of ['save-settings', 'import-settings']) {
      await check(`${name} cannot authorize an outside root without native approval`, async () => {
        const before = calls.length;
        await assert.rejects(invoke(name, { defaultSavePath: outside }), /outside the configured/);
        await assert.rejects(invoke(name, { categoryPaths: { video: outside } }), /outside the configured/);
        assert.equal(calls.length, before);
        assert.equal(settings.defaultSavePath, root);
        assert.equal(settings.categoryPaths.video, category);
      });
    }
    await check('native Browse approval permits the selected folder for its sender only', async () => {
      assert.equal(await invoke('select-folder'), outside);
      for (const name of ['add-download', 'queue-download', 'approve-download']) {
        await invoke(name, payload(outside));
        await assert.rejects(invoke(name, payload(outside), otherSender), /outside the configured/);
      }
      await invoke('import-downloads', [payload(outside)]);
    });
    await check('cancelling Browse grants no folder', async () => {
      selection = null;
      assert.equal(await invoke('select-folder', undefined, otherSender), null);
      await assert.rejects(invoke('add-download', payload(outside), otherSender), /outside the configured/);
    });
    await check('settings can persist native-approved roots and clear category overrides', async () => {
      const saved = await invoke('save-settings', { defaultSavePath: outside, categoryPaths: { video: '' } });
      assert.equal(saved.defaultSavePath, outside);
      assert.equal(saved.categoryPaths.video, '');
      const imported = await invoke('import-settings', { categoryPaths: { video: path.join(outside, 'videos') } });
      assert.equal(imported.categoryPaths.video, path.join(outside, 'videos'));
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\nsave-paths: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
