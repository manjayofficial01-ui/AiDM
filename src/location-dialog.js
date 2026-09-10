/**
 * Topmost "Choose Download Location" dialog.
 *
 * The save-location prompt is a dedicated, real top-level window so that
 * *the dialog* can be pinned above other applications without ever making the
 * AiDM main window (or the whole app) always-on-top.
 *
 * Why a separate window instead of an in-page overlay:
 *   • alwaysOnTop can then be applied to the prompt alone and removed when it
 *     closes — no permanent change to the application's window state;
 *   • it can be raised even when the main window is minimized or hidden in the
 *     tray, because it does not depend on the parent being on screen;
 *   • `parent` + `modal` make it modal to the AiDM workflow only — other
 *     applications keep receiving input.
 *
 * Windows semantics (important, do not over-promise):
 *   "Topmost" means above ordinary, non-topmost windows. It cannot rise above
 *   the secure desktop / UAC prompt, every exclusive full-screen application,
 *   or windows that are themselves already topmost.
 *
 * No focus-stealing loops, no global hooks, no elevated privileges: when
 * Windows refuses to activate a background-initiated dialog we leave it
 * topmost and visible and attract attention once (taskbar flash + toast).
 */

const { BrowserWindow, ipcMain, dialog, screen, Notification } = require('electron');
const path = require('path');

const DIALOG_W = 520;
const DIALOG_H = 340;

let getMainWindow = () => null;
let getDownloadManager = () => null;
let getIconPath = () => null;

let dialogWin = null;        // the BrowserWindow while open
let resolveDialog = null;    // resolves the current dialog's promise
let flashTimer = null;
const queue = [];            // a second prompt must never be dropped
let draining = false;
let handlersInstalled = false;

// ── Placement ──────────────────────────────────────────────────────────────

/** Work area (DIPs, taskbar excluded) of the display the dialog should use. */
function targetWorkArea() {
  const mw = getMainWindow();
  try {
    if (mw && !mw.isDestroyed() && mw.isVisible() && !mw.isMinimized()) {
      return screen.getDisplayMatching(mw.getBounds()).workArea;
    }
  } catch (e) { /* fall through to the monitor under the cursor */ }
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  } catch (e) {
    return screen.getPrimaryDisplay().workArea;
  }
}

/**
 * Centre the dialog on the right monitor, clamped so it is always fully
 * visible. Electron bounds are DIPs, so per-monitor scaling (125 %, 150 %,
 * mixed-DPI setups) is handled by the framework; we only clamp.
 */
function placeOnTargetDisplay(win, w, h) {
  try {
    const wa = targetWorkArea();
    const x = Math.round(wa.x + (wa.width - w) / 2);
    const y = Math.round(wa.y + (wa.height - h) / 2);
    win.setBounds({
      x: Math.max(wa.x, Math.min(x, wa.x + Math.max(0, wa.width - w))),
      y: Math.max(wa.y, Math.min(y, wa.y + Math.max(0, wa.height - h))),
      width: w,
      height: h,
    });
  } catch (e) { /* keep the OS default placement */ }
}

// ── Temporary topmost owner (for native pickers without a parent) ───────────

/**
 * A 1×1 invisible, always-on-top window. It exists only so that a native
 * folder picker has a topmost owner; it is destroyed immediately afterwards.
 */
function createTempTopmostOwner() {
  try {
    const w = new BrowserWindow({
      show: false, width: 1, height: 1,
      frame: false, skipTaskbar: true, transparent: true,
      focusable: false, movable: false, resizable: false,
      hasShadow: false, fullscreenable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    try {
      const wa = targetWorkArea();
      w.setPosition(wa.x + Math.round(wa.width / 2), wa.y + Math.round(wa.height / 2));
    } catch (e) {}
    w.setAlwaysOnTop(true, 'screen-saver');
    try { w.setOpacity(0); } catch (e) {}
    w.show(); // must be shown to be able to own a modal dialog
    return w;
  } catch (e) {
    return null;
  }
}

function destroyTempOwner(w) {
  if (!w) return;
  try { w.setAlwaysOnTop(false); } catch (e) {}
  try { if (!w.isDestroyed()) w.destroy(); } catch (e) {}
}

/**
 * Native folder picker that is reliably raised: owned by the topmost dialog
 * when one is open, otherwise by a temporary topmost owner that is disposed in
 * the `finally` block.
 */
async function pickFolder(owner) {
  let tempOwner = null;
  try {
    let win = (owner && !owner.isDestroyed()) ? owner : null;
    if (!win) {
      tempOwner = createTempTopmostOwner();
      win = tempOwner;
    }
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  } catch (e) {
    console.warn('[AiDM] folder picker failed:', e.message);
    return null;
  } finally {
    destroyTempOwner(tempOwner);
  }
}

// ── Attention (no focus-stealing loop) ──────────────────────────────────────

function attendIfNotFocused(win, payload) {
  let focused = false;
  try { focused = win.isFocused(); } catch (e) { focused = false; }
  if (focused) return true;

  // Windows only lets the foreground process activate a window. Retrying would
  // be blocked (and hostile), so: stay topmost + flash the taskbar once.
  try { win.flashFrame(true); } catch (e) {}
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    try { if (dialogWin && !dialogWin.isDestroyed()) dialogWin.flashFrame(false); } catch (e) {}
  }, 10000);

  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'AiDM — choose a download location',
        body: ((payload && payload.filename) || 'A download') + ' is waiting for a save folder.',
      }).show();
    }
  } catch (e) {}
  return false;
}

// ── The dialog ─────────────────────────────────────────────────────────────

function showDialog(payload) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      teardown();
      resolve(value);
    };
    resolveDialog = finish;

    try {
      const iconPath = getIconPath();
      const mw = getMainWindow();
      // Only parent/modal to AiDM when the main window is really on screen —
      // a minimized or tray-hidden window cannot own a modal dialog.
      const parentUsable = !!(mw && !mw.isDestroyed() && mw.isVisible() && !mw.isMinimized());

      const win = new BrowserWindow({
        width: DIALOG_W,
        height: DIALOG_H,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        frame: false,
        show: false,
        skipTaskbar: false,          // a taskbar button is required for flashing
        alwaysOnTop: true,
        ...(parentUsable ? { parent: mw, modal: true } : {}),
        title: 'Choose Download Location',
        ...(iconPath ? { icon: iconPath } : {}),
        backgroundColor: '#f2f6fc',
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload-location.js'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      dialogWin = win;

      // Closing the window (X, Alt+F4, .destroy()) counts as "cancel".
      win.on('closed', () => finish(null));

      win.loadFile(path.join(__dirname, '..', 'ui', 'location-dialog.html'));

      win.webContents.once('did-finish-load', () => {
        try { win.webContents.send('location-init', payload); } catch (e) {}
        placeOnTargetDisplay(win, DIALOG_W, DIALOG_H);
        try {
          if (win.isMinimized()) win.restore();
          if (!win.isVisible()) win.show();  // activates when Windows permits
          win.moveTop();
          win.focus();
        } catch (e) {}
        // Topmost for the whole lifetime — a single raise is not enough.
        try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {}
        // Re-apply once the real DPI of the target monitor is known.
        placeOnTargetDisplay(win, DIALOG_W, DIALOG_H);
        attendIfNotFocused(win, payload);
      });
    } catch (e) {
      console.warn('[AiDM] location dialog failed:', e.message);
      finish(null);
    }
  });
}

/**
 * Remove every trace of the dialog: stop flashing, drop the topmost state,
 * destroy the window and any temporary owner. Runs on confirm, cancel, close
 * and on error.
 */
function teardown() {
  clearTimeout(flashTimer);
  flashTimer = null;
  const win = dialogWin;
  dialogWin = null;
  resolveDialog = null;
  if (!win) return;
  try { win.flashFrame(false); } catch (e) {}
  try { win.setAlwaysOnTop(false); } catch (e) {}
  try { if (!win.isDestroyed()) win.destroy(); } catch (e) {}
}

function requestLocation(payload) {
  if (!payload || !payload.id) return;
  queue.push(payload);
  drain();
}

/**
 * If the topmost dialog is currently open for `id`, push a field update into
 * it (e.g. the file name learned from the server after the dialog opened).
 * Only sent while no field has been edited by the user in the renderer, so it
 * never clobbers manual input.
 */
function patch(id, patch_) {
  if (!dialogWin || !dialogWin.webContents || dialogWin.isDestroyed()) return;
  try { dialogWin.webContents.send('location-patch', { id, ...patch_ }); } catch (e) {}
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      let result = null;
      try {
        result = await showDialog({ ...item, defaultPath: item.defaultPath || item.suggestedPath });
      } catch (e) {
        console.warn('[AiDM] location dialog error:', e.message);
        result = null;
      }
      const dm = getDownloadManager();
      try {
        if (result && result.savePath) {
          if (result.remember && result.category && dm) {
            const s = dm.getSettings();
            dm.saveSettings({
              ...s,
              categoryPaths: { ...(s.categoryPaths || {}), [result.category]: result.savePath },
            });
          }
          if (dm) dm.approveDownload(item.id, result.savePath, result.filename);
        } else if (dm) {
          dm.rejectDownload(item.id);
        }
      } catch (e) {
        console.warn('[AiDM] could not finalise download:', e.message);
      }
    }
  } finally {
    draining = false;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

function init(opts = {}) {
  getMainWindow = opts.getMainWindow || (() => null);
  getDownloadManager = opts.getDownloadManager || (() => null);
  getIconPath = opts.getIconPath || (() => null);

  if (handlersInstalled) return;
  handlersInstalled = true;

  ipcMain.handle('location-confirm', (event, data) => {
    if (!dialogWin || event.sender !== dialogWin.webContents) return false;
    if (resolveDialog) {
      resolveDialog({
        savePath: data && data.savePath,
        filename: data && data.filename,
        remember: !!(data && data.remember),
        category: (data && data.category) || '',
      });
    }
    return true;
  });

  ipcMain.handle('location-cancel', (event) => {
    if (!dialogWin || event.sender !== dialogWin.webContents) return false;
    if (resolveDialog) resolveDialog(null);
    return true;
  });

  ipcMain.handle('location-browse', async () => pickFolder(dialogWin));
}

module.exports = {
  init,
  requestLocation,
  pickFolder,
  patch,
  teardown,
  /** test/introspection helper */
  _currentWindow: () => dialogWin,
};
