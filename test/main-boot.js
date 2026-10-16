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

// ── add-download IPC: ytFormat must skip the resolver round-trip ────────────
// Regression: when the renderer confirms a quality from the picker it sends
// { meta: { ytFormat: {...} } }. If main.js re-resolves the URL anyway, the
// picker re-opens for every video the user just chose. The HTTP API in
// /api/download respects ytFormat; the IPC must match.
console.log('── add-download IPC respects meta.ytFormat ──');
{
  const mainSrc = fs.readFileSync(MAIN, 'utf8');
  const m = /ipcMain\.handle\('add-download'[\s\S]*?\n\}\);/.exec(mainSrc);
  check('add-download handler is captured', !!m);
  if (m) {
    check('skips resolver round-trip when meta.ytFormat is present',
      /resolvers\.hasResolverFor\([^)]+\)\s*&&\s*!ytFormat/.test(m[0]) ||
      /\!\s*ytFormat[\s\S]{0,40}resolvers\.hasResolverFor/.test(m[0]));
    check('extracts ytFormat from opts.meta.ytFormat',
      /opts\.meta\.ytFormat/.test(m[0]) ||
      /opts\s*&&\s*opts\.meta\s*&&\s*opts\.meta\.ytFormat/.test(m[0]));
    // And critically: the OLD behaviour (always resolve when the URL has a
    // resolver) is gone — there must be no `if (... hasResolverFor(...))` path
    // that runs when ytFormat is set.
    check('no unguarded resolver path (the old infinite-picker loop)',
      !/if \(\s*opts\s*&&\s*opts\.url\s*&&\s*resolvers\.hasResolverFor\(opts\.url\)\s*\)\s*\{[\s\S]{0,200}video-detected/.test(mainSrc));
  }
}

// ── yt-dlp engine IPC handlers (Settings › YouTube) ────────────────────────
// Invoked for real: yt-dlp-status wraps detectRunner(true), which shells out
// to the installed binary's --version. In this scratch env there is none, so
// the assertion is the payload SHAPE (a throw or a malformed object would
// break the Settings pane); the positive path is covered by the live install.
console.log('── yt-dlp engine IPC ──');
(async () => {
  for (const ch of ['yt-dlp-status', 'update-yt-dlp', 'select-cookie-file']) {
    check(`handler: ${ch}`, ipcHandlers.has(ch));
  }
  try {
    const st = await ipcHandlers.get('yt-dlp-status')();
    check('yt-dlp-status returns a well-formed payload',
      !!st && typeof st === 'object' && typeof st.found === 'boolean',
      JSON.stringify(st));
    if (st && st.found) {
      check('reports the detected version', typeof st.version === 'string' && st.version.length > 0, st.version);
      check('reports where it came from', typeof st.source === 'string' && st.source.length > 0, st.source);
    }
  } catch (e) {
    check('yt-dlp-status does not throw', false, e && e.message);
  }
  try {
    const picked = await ipcHandlers.get('select-cookie-file')();
    check('select-cookie-file resolves (cancelled dialog → null)', picked === null);
  } catch (e) {
    check('select-cookie-file does not throw', false, e && e.message);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  Object.keys(savedEnv).forEach(k => { process.env[k] = savedEnv[k]; });
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}

  console.log(`\nmain-boot: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
