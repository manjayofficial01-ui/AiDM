// Boot smoke test for the Electron MAIN PROCESS.
//
// Every other suite tests modules in isolation; main.js was only ever
// regex-scanned, so a top-level error in it (a bad require, a typo in a new
// helper, a handler registered under the wrong name) would ship without any
// test noticing — the app would just fail to start.
//
// This loads the REAL main.js with a stubbed `electron`. Nothing is created:
// DownloadManager, the window, the tray, the clipboard monitor and the local
// server all live inside createWindow(), which only runs on app.whenReady()
// — and the stub makes that promise never resolve. So this is fast, offline
// and side-effect free.
//
// Run: node test/main-boot.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'main.js');

// ── Stub electron ───────────────────────────────────────────────────────────
const ipcHandlers = new Map();
const appEvents = new Map();
let quitCalled = false;

const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    // Never resolves → createWindow() (and everything it builds) never runs.
    whenReady: () => new Promise(() => {}),
    on: (evt, fn) => appEvents.set(evt, fn),
    quit: () => { quitCalled = true; },
    getPath: (n) => path.join(os.tmpdir(), 'aidm-boot-test', n),
    getName: () => 'AiDM',
    getVersion: () => '4.8.0',
    isPackaged: false,
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() { return []; }
    constructor() { throw new Error('createWindow() must not run in this test'); }
  },
  ipcMain: {
    handle: (ch, fn) => ipcHandlers.set(ch, fn),
    on: (ch, fn) => ipcHandlers.set(ch, fn),
    removeHandler: (ch) => ipcHandlers.delete(ch),
  },
  clipboard: { readText: () => '', writeText: () => {} },
  shell: { openPath: () => Promise.resolve(''), showItemInFolder: () => {}, beep: () => {} },
  Tray: class Tray { constructor() { throw new Error('tray must not be created here'); } },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
};

// ── Load the real main.js ───────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-boot-'));
const savedEnv = {
  USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME,
  APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
};
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
process.env.APPDATA = scratch;
process.env.LOCALAPPDATA = scratch;

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

let bootError = null;
try {
  require(MAIN);
} catch (e) {
  bootError = e;
} finally {
  Module._load = origLoad;
}

console.log('── main process boots ──');
check('main.js loads without throwing', !bootError, bootError ? bootError.message : '');
check('single-instance lock requested', !quitCalled);
check('registers the core IPC handlers', ipcHandlers.size > 10, `${ipcHandlers.size} channels`);
for (const ch of ['add-download', 'pause-download', 'resume-download', 'cancel-download',
  'get-downloads', 'save-settings', 'get-settings', 'read-clipboard']) {
  check(`handler: ${ch}`, ipcHandlers.has(ch));
}
check('listens for before-quit', appEvents.has('before-quit'));

// ── The settings helper must never throw into the main process ──────────────
console.log('── youtubeCookiesFromBrowser is defensive ──');
{
  const mainSrc = fs.readFileSync(MAIN, 'utf8');
  const m = /function youtubeCookiesFromBrowser\(\)\s*\{[\s\S]*?\n\}/.exec(mainSrc);
  check('helper exists in main.js', !!m);
  if (m) {
    const make = (dm) => new Function('downloadManager', m[0] + '\nreturn youtubeCookiesFromBrowser;')(dm);
    check('undefined manager → null (app not ready yet)',
      (() => { try { return make(undefined)() === null; } catch (e) { return false; } })());
    check('empty setting → null',
      make({ getSettings: () => ({}) })() === null);
    check('returns the configured browser',
      make({ getSettings: () => ({ youtubeCookiesFromBrowser: 'chrome' }) })() === 'chrome');
    check('trims whitespace / case preserved for yt-dlp',
      make({ getSettings: () => ({ youtubeCookiesFromBrowser: '  edge  ' }) })() === 'edge');
    check('a throwing manager → null, never throws',
      (() => { try { return make({ getSettings: () => { throw new Error('boom'); } })() === null; } catch (e) { return false; } })());
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
Object.keys(savedEnv).forEach(k => { process.env[k] = savedEnv[k]; });
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}

console.log(`\nmain-boot: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
