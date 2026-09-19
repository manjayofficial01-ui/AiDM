const { app, BrowserWindow, ipcMain, clipboard, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { DownloadManager, youtubeLogDir } = require('./src/download-manager');
const { ClipboardMonitor } = require('./src/clipboard-monitor');
const { IPCServer } = require('./src/server');
const { AiService } = require('./src/ai-service');
const resolvers = require('./src/resolvers');
const locationDialog = require('./src/location-dialog');
const { Scheduler, parseSpeedRules, speedLimitAt, validateSchedule } = require('./src/scheduler');
const { exec } = require('child_process');

let mainWindow;
let tray = null;
let isQuitting = false;
let downloadManager;
let clipboardMonitor;
let ipcServer;
let aiService;
// Download scheduler (v4.3.0) + its active session, if any.
let scheduler = null;
let schedulerSession = null;

// ── Global crash guards ───────────────────────────────────────────────────────
// An uncaught exception in a download callback (e.g. fs.openSync on a missing
// or OneDrive-locked file) used to show a blocking "JavaScript error occurred"
// dialog that persisted until the process was killed from Task Manager.
// Log and keep running instead — individual downloads already surface errors
// to the UI via download-error events.
process.on('uncaughtException', (err) => {
  console.error('[AiDM] uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[AiDM] unhandledRejection:', reason && reason.stack || reason);
});

// Launched by Windows at login (openAtLogin) or with an explicit flag:
// start hidden in the tray so the app is "just always there".
const START_HIDDEN = process.argv.some(a => /--hidden|--minimized/i.test(a));

function getAppIcon() {
  const candidates = [
    path.join(__dirname, 'build', 'icon.ico'), // packaged build
    path.join(__dirname, 'ui', 'icon.png'),    // dev fallback
    path.join(__dirname, 'icon.png'),          // dev fallback
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function applyLoginItem(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      // Relaunch hidden in the tray after login / reboot.
      args: enabled ? ['--hidden'] : [],
    });
  } catch (e) {
    console.warn('[AiDM] setLoginItemSettings failed:', e.message);
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  try {
    const iconPath = getAppIcon();
    const img = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(img.isEmpty() ? undefined : img);
    tray.setToolTip('AiDM - Download Manager');
    const rebuildMenu = () => {
      const s = downloadManager ? downloadManager.getSettings() : {};
      const ctx = Menu.buildFromTemplate([
        { label: 'Open AiDM', click: showWindow },
        { type: 'separator' },
        {
          label: 'Start with Windows',
          type: 'checkbox',
          checked: s.launchAtStartup !== false,
          click: (item) => {
            const saved = downloadManager.saveSettings({ launchAtStartup: item.checked });
            applyLoginItem(saved.launchAtStartup !== false);
          },
        },
        { type: 'separator' },
        {
          label: 'Quit AiDM', click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]);
      tray.setContextMenu(ctx);
    };
    rebuildMenu();
    tray.on('double-click', showWindow);
    tray.on('click', showWindow);
    tray._rebuild = rebuildMenu;
  } catch (e) {
    console.warn('[AiDM] Tray unavailable:', e.message);
  }
}

function getAiService() {
  if (!aiService) {
    const s = downloadManager ? downloadManager.getSettings() : {};
    aiService = new AiService({
      baseURL: s.aiBaseURL,
      apiKey: process.env.TOKENHARBOR_API_KEY || s.aiApiKey || '',
      primaryModel: s.aiPrimaryModel,
      fallbackModel: s.aiFallbackModel,
    });
  }
  return aiService;
}

function syncAiConfig() {
  if (!downloadManager) return;
  const s = downloadManager.getSettings();
  getAiService().configure({
    baseURL: s.aiBaseURL,
    apiKey: process.env.TOKENHARBOR_API_KEY || s.aiApiKey || '',
    primaryModel: s.aiPrimaryModel,
    fallbackModel: s.aiFallbackModel,
  });
}

function createWindow() {
  const iconPath = getAppIcon();
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'AiDM - Download Manager',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#1a1a2e',
    frame: false,
    titleBarStyle: 'hidden',
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  downloadManager = new DownloadManager();
  clipboardMonitor = new ClipboardMonitor();
  ipcServer = new IPCServer(downloadManager);

  // ── Download scheduler (v4.3.0, original implementation) ──────────────
  // Fires one-time/daily/weekly queue runs, enforces the timetabled speed
  // limits, and runs the per-schedule completion action when the queue
  // drains. All decisions live in src/scheduler.js (pure, tested); this file
  // only owns the queue, the engine limit, and the OS-level actions.
  scheduler = new Scheduler();
  scheduler.configure(downloadManager.getSettings());
  scheduler.on('schedule-start', onScheduleStart);
  scheduler.on('schedule-stop', onScheduleStop);
  setInterval(() => { try { scheduler.tick(new Date()); } catch (e) {} }, 20000);
  setInterval(applyTimetableSpeed, 30000);
  try { scheduler.tick(new Date()); } catch (e) {}
  applyTimetableSpeed();

  // Topmost download-location dialog (its own window, not an in-page overlay)
  locationDialog.init({
    getMainWindow: () => mainWindow,
    getDownloadManager: () => downloadManager,
    getIconPath: () => getAppIcon(),
  });

  // Forward all download events to renderer
  const events = [
    'download-added', 'download-progress', 'download-complete',
    'download-error', 'download-paused', 'download-resumed',
    'download-removed', 'download-updated', 'download-ask-location', 'video-detected',
    'download-hash',
  ];
  events.forEach(event => {
    downloadManager.on(event, (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(event, data);
      }
    });
  });

  // When a scheduler session is active, a drained queue triggers its
  // completion action (notify / shutdown / hibernate).
  downloadManager.on('download-complete', () => maybeSchedulerComplete());
  downloadManager.on('download-error', () => maybeSchedulerComplete());
  // "Ask every time": raise the topmost location dialog. The download stays
  // in "pending-approval" until the user picks a folder or cancels, so the
  // workflow is modal without blocking any other application.
  downloadManager.on('download-ask-location', (data) => locationDialog.requestLocation(data));
  // (download-ask-location already carries suggestedPath = the default; the
  //  dialog treats it as the default location and lets the user override it.)

  // When the real file name/size is learned after the dialog opened, refresh
  // the still-open dialog (and the pending row) with the improved values.
  downloadManager.on('download-updated', (d) => {
    locationDialog.patch(d.id, {
      filename: d.filename,
      savePath: d.savePath,
      totalSize: (typeof d.totalSize === 'number' && d.totalSize > 0) ? d.totalSize : null,
      sizeEstimated: !!d.sizeEstimated,
      contentType: (d._probe && d._probe.contentType) || null,
    });
  });

  clipboardMonitor.on('link-found', (url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-link', url);
    }
  });

  ipcServer.start();
  // Honor the persisted "Clipboard monitoring" toggle (it used to be saved by
  // the settings dialog but never actually applied to the monitor).
  if (downloadManager.getSettings().clipboardMonitor !== false) {
    clipboardMonitor.start();
  }
  createTray();

  // Honor the persisted auto-start preference on every launch, and if the
  // user asked to start with Windows, make sure the login item exists.
  try {
    const s = downloadManager.getSettings();
    if (s.launchAtStartup !== false) applyLoginItem(true);
  } catch {}

  // ── Installed-app window behavior ─────────────────────────────────────
  // Closing the window keeps AiDM alive in the tray (clipboard monitor +
  // browser-integration API keep running) unless the user opted out.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    let toTray = true;
    try { toTray = downloadManager.getSettings().minimizeToTray !== false; } catch {}
    if (toTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (START_HIDDEN) {
    // Start quietly in the tray (Windows login launch).
    mainWindow.hide();
  } else {
    mainWindow.show();
  }
}

// ── Scheduler session handling ─────────────────────────────────────────────

function notifyScheduler(message) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scheduler-event', { message, at: Date.now() });
    }
  } catch (e) { /* renderer gone — skip */ }
}

function onScheduleStart({ schedule }) {
  if (!downloadManager) return;
  try {
    // Optional: retry previously failed downloads first.
    if (schedule.retryFailed) {
      downloadManager.getAllDownloads()
        .filter(d => d && d.status === 'error')
        .forEach(d => { try { downloadManager.resumeDownload(d.id); } catch (e) {} });
    }
    const prevSpeed = (downloadManager.engine && downloadManager.engine.globalSpeedLimit) || 0;
    let speed = null;
    const overrideKBs = schedule.speedLimitKBs !== '' && schedule.speedLimitKBs != null
      ? Number(schedule.speedLimitKBs) : NaN;
    if (Number.isFinite(overrideKBs) && overrideKBs >= 0) {
      speed = Math.round(overrideKBs * 1024);
      try { downloadManager.engine.setSpeedLimit(speed); } catch (e) {}
    }
    schedulerSession = {
      id: schedule.id,
      name: schedule.name || 'Scheduled run',
      prevSpeed,
      speed,
      onComplete: schedule.onComplete || 'none',
    };
    downloadManager.startQueue();
    applyTimetableSpeed();
    notifyScheduler(`Scheduler started: ${schedulerSession.name}`);
    // An empty queue drains instantly — settle the session on next tick.
    setTimeout(maybeSchedulerComplete, 10000);
  } catch (e) {
    console.warn('[AiDM] schedule start failed:', e.message);
  }
}

function onScheduleStop({ schedule }) {
  if (!downloadManager) return;
  try {
    if (schedulerSession && schedulerSession.id === schedule.id) {
      try { downloadManager.engine.setSpeedLimit(schedulerSession.prevSpeed || 0); } catch (e) {}
      schedulerSession = null;
    }
    downloadManager.pauseQueue();
    applyTimetableSpeed();
    notifyScheduler(`Scheduler stopped${schedule && schedule.name ? ': ' + schedule.name : ''}`);
  } catch (e) {
    console.warn('[AiDM] schedule stop failed:', e.message);
  }
}

/** True when nothing is downloading and nothing is queued. */
function managerIsIdle() {
  try {
    if (!downloadManager) return true;
    const active = downloadManager._getActiveCount();
    const queued = Array.isArray(downloadManager.queue) ? downloadManager.queue.length : 0;
    return active === 0 && queued === 0;
  } catch (e) { return false; }
}

function maybeSchedulerComplete() {
  if (!schedulerSession || !managerIsIdle()) return;
  const sess = schedulerSession;
  schedulerSession = null;
  try { downloadManager.engine.setSpeedLimit(sess.prevSpeed || 0); } catch (e) {}
  applyTimetableSpeed();
  runCompletionAction(sess.onComplete, sess.name);
}

async function runCompletionAction(action, name) {
  const label = name ? ` (${name})` : '';
  if (!action || action === 'none') {
    notifyScheduler(`Scheduler finished${label} — queue drained`);
    return;
  }
  if (action === 'notify') {
    notifyScheduler(`Downloads finished${label} — queue drained`);
    return;
  }
  if (action === 'shutdown' || action === 'hibernate') {
    // OS power actions are destructive: they NEVER run without an explicit,
    // in-the-moment confirmation, even though the schedule opted in.
    if (process.platform !== 'win32') {
      notifyScheduler(`"${action}" is only supported on Windows`);
      return;
    }
    const verb = action === 'shutdown' ? 'Shut down' : 'Hibernate';
    try { showWindow(); } catch (e) {}
    let response = { response: 0 };
    try {
      response = await dialog.showMessageBox(
        mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
        {
          type: 'warning',
          buttons: ['Cancel', `${verb} now`],
          defaultId: 0,
          cancelId: 0,
          title: 'AiDM Scheduler',
          message: `Downloads finished${label}. ${verb} this PC now?`,
          detail: action === 'shutdown'
            ? 'Windows will shut down in 30 seconds (abort anytime with: shutdown /a).'
            : 'Unsaved work in other apps may be lost.',
        }
      );
    } catch (e) { response = { response: 0 }; }
    if (!response || response.response !== 1) {
      notifyScheduler(`${verb} cancelled`);
      return;
    }
    notifyScheduler(`${verb} initiated`);
    exec(action === 'shutdown' ? 'shutdown /s /t 30' : 'shutdown /h', (err) => {
      if (err) notifyScheduler(`Could not ${verb.toLowerCase()}: ${err.message}`);
    });
    return;
  }
  notifyScheduler(`Unknown completion action "${action}" — ignored`);
}

/** Enforce the timetabled speed limit (schedule override > table > default). */
function applyTimetableSpeed() {
  if (!downloadManager || !downloadManager.engine) return;
  try {
    const s = downloadManager.getSettings();
    let desired = s.speedLimit || 0;
    let source = 'default';
    if (schedulerSession && schedulerSession.speed !== null && schedulerSession.speed !== undefined) {
      desired = schedulerSession.speed;
      source = 'schedule';
    } else {
      const { rules } = parseSpeedRules(s.speedRules || '');
      const hit = speedLimitAt(new Date(), rules);
      if (hit !== null) {
        desired = Math.round(hit * 1024);
        source = 'timetable';
      }
    }
    if (downloadManager.engine.globalSpeedLimit !== desired) {
      downloadManager.engine.setSpeedLimit(desired);
      notifyScheduler(source === 'default'
        ? 'Speed limit restored to default'
        : `Speed limit: ${Math.round(desired / 1024)} KB/s (${source})`);
    }
  } catch (e) { /* never break the app for a limit tweak */ }
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

/**
 * File-hoster credentials from the saved settings (Settings › File hosts).
 * Kept here so no credential ever travels through the renderer: the resolver
 * reads it server-side, and the row only ever stores the resulting direct URL.
 */
/** Opt-in: let yt-dlp read a browser's own cookie store (empty = off). */
function youtubeCookiesFromBrowser() {
  try {
    const v = String((downloadManager && downloadManager.getSettings().youtubeCookiesFromBrowser) || '').trim();
    return v || null;
  } catch (e) { return null; }
}

function fileHostCredentials() {
  try {
    const hosts = (downloadManager && downloadManager.getSettings().fileHosts) || {};
    return { ...(hosts.rapidgator || {}) };
  } catch (e) {
    return {};
  }
}

ipcMain.handle('add-download', async (event, opts) => {
  // A page URL (e.g. a tweet) is not a file — adding it directly would
  // download HTML. The resolver layer turns it into normalised media variants
  // and the UI shows the normal quality picker instead. Provider support is
  // determined by the strict resolver registry (identifier-only parsing, so
  // media URLs with long digit ids are never mistaken for posts).
  try {
    if (opts && opts.url && resolvers.hasResolverFor(opts.url)) {
      // File hosters (Rapidgator …) need the account the user saved in
      // Settings › File hosts; every other provider ignores the option.
      // yt-dlp (YouTube) additionally gets the session the extension captured,
      // plus the opt-in "read cookies from this browser" setting, so a
      // logged-in user's own private/members-only video can be listed at all.
      const resolved = await resolvers.resolveMedia(opts.url, {
        credentials: fileHostCredentials(),
        cookies: (opts && opts.cookies) || null,
        referer: (opts && opts.pageUrl) || null,
        cookiesFromBrowser: youtubeCookiesFromBrowser(),
      });
      // The quality picker replays pageUrl as Referer when downloading. For
      // embed providers (mydaddy/hqporner) the CDN only honours the PLAYER
      // page, so prefer the resolver's canonical URL over the pasted one
      // (for tweets they are equivalent).
      // A hoster that answered with a wait (free-user timer) instead of a file
      // must say so, not open an empty quality picker.
      if (!resolved.pickerVideos || !resolved.pickerVideos.length) {
        return {
          resolveFailed: true,
          provider: resolved.provider,
          waitSeconds: resolved.waitSeconds || 0,
          requiresCredentials: !!resolved.requiresCredentials,
          error: resolved.hint || resolved.error ||
            `No downloadable file was found on this ${resolved.provider || 'hoster'} page.`,
        };
      }
      const pageUrl = resolved.canonicalUrl || opts.url;
      const payload = {
        pageUrl,
        pageTitle: resolved.title || `${resolved.provider} ${resolved.id}`,
        provider: resolved.provider,
        thumbnail: resolved.thumbnail || null,
        duration: resolved.duration || null,
        videos: resolved.pickerVideos || [],
      };
      downloadManager.emit('video-detected', payload);
      return {
        twitterResolved: true, // legacy renderer/extension flag
        provider: resolved.provider,
        tweetId: resolved.id,
        videos: payload.videos,
      };
    }
  } catch (e) {
    // Resolution failed (page unreachable, embed changed, DASH-only…).
    // Report the reason INSTEAD of falling through: adding the page URL
    // directly would download the page HTML as a file (e.g. an hqporner page
    // saved as "..._kidnapped_body_heat.html"), which looks exactly like
    // "AiDM can't download the video".
    const message = (e && e.message) || 'Could not resolve this page URL';
    return { resolveFailed: true, error: message };
  }
  return downloadManager.addDownload(opts);
});

ipcMain.handle('pause-download', async (event, { id }) => {
  return downloadManager.pauseDownload(id);
});

ipcMain.handle('resume-download', async (event, { id }) => {
  return downloadManager.resumeDownload(id);
});

ipcMain.handle('cancel-download', async (event, { id }) => {
  return downloadManager.cancelDownload(id);
});

ipcMain.handle('remove-download', async (event, { id }) => {
  return downloadManager.removeDownload(id);
});

ipcMain.handle('approve-download', async (event, { id, savePath, filename }) => {
  return downloadManager.approveDownload(id, savePath, filename);
});

ipcMain.handle('reject-download', async (event, { id }) => {
  return downloadManager.rejectDownload(id);
});

ipcMain.handle('get-downloads', async () => {
  return downloadManager.getAllDownloads();
});

/**
 * Guard against path traversal: the renderer sends a path, but we only open
 * files that actually exist on disk and refuse null-bytes / relative tricks.
 * For open-file/open-folder the path must additionally belong to AiDM: a
 * recorded download's file, a location inside a configured save/category
 * folder, or AiDM's own yt-dlp log folder. Existence alone would let a
 * compromised renderer open ANY path on disk.
 */
function isAiOwnedPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.includes('\0')) return false;
  let abs;
  try {
    abs = path.resolve(p);
  } catch {
    return false;
  }
  try {
    if (!fs.existsSync(abs)) return false;
  } catch {
    return false;
  }
  // Exact match on any recorded download's file (the common case).
  try {
    for (const d of downloadManager.downloads.values()) {
      if (d.filepath && path.resolve(d.filepath) === abs) return true;
      if (d.savePath && path.resolve(d.savePath) === abs) return true;
    }
  } catch {}
  // Or inside a configured save location (default + per-category).
  const roots = new Set();
  try {
    if (downloadManager.settings.defaultSavePath) roots.add(path.resolve(downloadManager.settings.defaultSavePath));
    const cp = downloadManager.settings.categoryPaths || {};
    Object.values(cp).forEach(v => { if (v) roots.add(path.resolve(v)); });
  } catch {}
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + path.sep)) return true;
  }
  // AiDM's own yt-dlp log folder.
  try {
    const logDir = path.resolve(youtubeLogDir());
    if (abs.startsWith(logDir + path.sep)) return true;
  } catch {}
  return false;
}

ipcMain.handle('open-file', async (event, { filePath }) => {
  if (!isAiOwnedPath(filePath)) return;
  shell.openPath(filePath);
});

ipcMain.handle('open-folder', async (event, { folderPath }) => {
  if (!isAiOwnedPath(folderPath)) return;
  shell.showItemInFolder(folderPath);
});

// Open the redacted yt-dlp log for a failed YouTube download. The path must be
// the one the manager recorded for THIS row and must live inside AiDM's own log
// folder — a row is user-visible data, so it must never be able to point
// anywhere else on disk.
ipcMain.handle('open-download-log', async (event, { id }) => {
  try {
    const dl = downloadManager.downloads.get(String(id || ''));
    const p = dl && dl.ytLogPath;
    if (!p || typeof p !== 'string' || p.includes('\0')) return false;
    const dir = path.resolve(youtubeLogDir());
    const abs = path.resolve(p);
    if (!abs.startsWith(dir + path.sep) || !fs.existsSync(abs)) return false;
    const opened = await shell.openPath(abs);
    return !opened; // empty string = success
  } catch (e) {
    return false;
  }
});

// Re-open the topmost location dialog for a download that is still waiting
// (e.g. the 📁 button on a "pending" row).
ipcMain.handle('request-location', async (event, { id }) => {
  if (!downloadManager || !id) return false;
  const dl = downloadManager.getAllDownloads().find(d => d.id === id);
  if (!dl) return false;
  locationDialog.requestLocation({
    id: dl.id,
    filename: dl.filename,
    category: dl.category,
    suggestedPath: dl.savePath || downloadManager.settings.defaultSavePath,
    defaultPath: downloadManager.settings.categoryPaths[dl.category] || downloadManager.settings.defaultSavePath,
    url: dl.url,
    totalSize: (typeof dl.totalSize === 'number' && dl.totalSize > 0) ? dl.totalSize : null,
    sizeEstimated: !!dl.sizeEstimated,
    contentType: (dl._probe && dl._probe.contentType) || null,
  });
  return true;
});

ipcMain.handle('select-folder', async () => {
  // Owned by the topmost location dialog when one is open, otherwise by a
  // temporary topmost owner (created and destroyed inside pickFolder).
  return locationDialog.pickFolder();
});

ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());
ipcMain.handle('show-window', () => showWindow());

ipcMain.handle('read-clipboard', async () => {
  try { return clipboard.readText(); } catch { return ''; }
});

ipcMain.handle('window-always-on-top', async (event, on) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.setAlwaysOnTop(!!on, 'screen-saver'); } catch {}
});
ipcMain.handle('quit-app', () => {
  isQuitting = true;
  app.quit();
});
ipcMain.handle('get-autostart', () => {
  // Report the persisted setting — applyLoginItem enforces it, while the OS
  // login item can be flipped by other tools and momentarily disagree.
  try {
    const enabled = downloadManager && downloadManager.settings
      ? downloadManager.settings.launchAtStartup !== false
      : app.getLoginItemSettings().openAtLogin;
    return { enabled };
  } catch { return { enabled: false }; }
});

ipcMain.handle('get-app-version', () => {
  return {
    version: app.getVersion(),
    // The server auto-increments past a stale 18765 holder — the UI's
    // extension-status check must probe the port actually in use.
    apiPort: ipcServer ? ipcServer.port : 18765,
  };
});

/**
 * Delete a downloaded file from disk. Only files inside the configured save
 * paths are allowed — this prevents a compromised renderer from deleting
 * arbitrary system files via a crafted filepath.
 */
ipcMain.handle('delete-file-from-disk', async (event, { filepath }) => {
  if (!filepath || typeof filepath !== 'string' || filepath.includes('\0')) return false;
  try {
    const abs = path.resolve(filepath);
    const base = path.resolve(downloadManager.settings.defaultSavePath || '');
    // Also allow any configured category path
    const allowedRoots = [base];
    for (const p of Object.values(downloadManager.settings.categoryPaths || {})) {
      if (p) allowedRoots.push(path.resolve(p));
    }
    const underAllowed = allowedRoots.some(root => abs === root || abs.startsWith(root + path.sep));
    if (!underAllowed) {
      console.warn('[AiDM] delete refused — outside save paths:', abs);
      return false;
    }
    if (!fs.existsSync(abs)) return false;
    fs.unlinkSync(abs);
    return true;
  } catch (e) {
    console.warn('[AiDM] delete failed:', e.message);
    return false;
  }
});

ipcMain.handle('get-settings', async () => {
  return downloadManager.getSettings();
});

ipcMain.handle('save-settings', async (event, settings) => {
  const saved = downloadManager.saveSettings(settings);
  syncAiConfig();
  // Keep the scheduler and the timetabled speed limit in sync with edits.
  try { if (scheduler) scheduler.configure(saved); } catch (e) {}
  try { applyTimetableSpeed(); } catch (e) {}
  // Apply the clipboard-monitor toggle live (start/stop, not just persist).
  if (clipboardMonitor) {
    if (saved.clipboardMonitor === false) clipboardMonitor.stop();
    else clipboardMonitor.start();
  }
  if (settings && typeof settings.launchAtStartup !== 'undefined') {
    applyLoginItem(saved.launchAtStartup !== false);
  }
  if (tray && tray._rebuild) tray._rebuild();
  return saved;
});

ipcMain.handle('queue-download', async (event, opts) => {
  return downloadManager.queueDownload(opts);
});

ipcMain.handle('start-queue', async () => {
  return downloadManager.startQueue();
});

ipcMain.handle('pause-queue', async () => {
  return downloadManager.pauseQueue();
});

// ── Scheduler (v4.3.0) ─────────────────────────────────────────────────────

ipcMain.handle('get-schedules', async () => {
  if (!downloadManager) return [];
  return downloadManager.getSettings().schedules || [];
});

ipcMain.handle('save-schedules', async (event, schedules) => {
  if (!downloadManager || !scheduler) throw new Error('Scheduler not ready');
  if (!Array.isArray(schedules) || schedules.length > 50) {
    throw new Error('Schedules must be a list of at most 50 entries');
  }
  const clean = schedules.map((s, i) => {
    const v = validateSchedule(s || {});
    if (!v.ok) throw new Error(`Schedule ${i + 1} ("${(s && s.name) || 'untitled'}"): ${v.error}`);
    return {
      id: String((s && s.id) || `${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}`),
      name: String((s && s.name) || '').trim().slice(0, 60) || `Schedule ${i + 1}`,
      enabled: (s && s.enabled) !== false,
      type: s.type,
      time: String(s.time).trim(),
      date: s.type === 'once' ? String(s.date || '').trim() : null,
      days: s.type === 'weekly'
        ? [...new Set((s.days || []).map(Number).filter(d => d >= 0 && d <= 6))].sort()
        : null,
      stopAfterMinutes: (s.stopAfterMinutes === '' || s.stopAfterMinutes == null)
        ? null : Number(s.stopAfterMinutes),
      retryFailed: !!(s && s.retryFailed),
      speedLimitKBs: (s.speedLimitKBs === '' || s.speedLimitKBs == null)
        ? null : Number(s.speedLimitKBs),
      onComplete: (s && s.onComplete) || 'none',
    };
  });
  downloadManager.saveSettings({ schedules: clean });
  scheduler.configure(downloadManager.getSettings());
  return clean;
});

ipcMain.handle('scheduler-next', async () => {
  if (!scheduler) return [];
  return scheduler.getNextRuns(new Date()).map(e => ({
    id: e.schedule.id,
    name: e.schedule.name || 'Scheduled run',
    at: e.at.getTime(),
  }));
});

// ── AI (TokenHarbor) ──────────────────────────────────────────────────────────

ipcMain.handle('ai-status', async () => {
  syncAiConfig();
  const s = getAiService().getConfigStatus();
  return { ...s, envKeyPresent: Boolean(process.env.TOKENHARBOR_API_KEY) };
});

ipcMain.handle('ai-chat', async (event, { messages, opts }) => {
  syncAiConfig();
  return getAiService().chat(messages, opts || {});
});

ipcMain.handle('ai-smart-filename', async (event, { url, hint }) => {
  syncAiConfig();
  return { filename: await getAiService().smartFilename(url, hint) };
});

ipcMain.handle('ai-categorize', async (event, { url, filename }) => {
  syncAiConfig();
  return { category: await getAiService().categorize(url, filename) };
});

ipcMain.handle('ai-explain-error', async (event, { error, url }) => {
  syncAiConfig();
  return { explanation: await getAiService().explainError(error, url) };
});

ipcMain.handle('ai-health', async () => {
  syncAiConfig();
  return getAiService().healthCheck();
});

ipcMain.handle('ai-models', async () => {
  syncAiConfig();
  return { models: await getAiService().listModels() };
});

// ── App Lifecycle ─────────────────────────────────────────────────────────────

// Single instance: a second launch (e.g. Start Menu /Run-AiDM) just focuses
// the already-running app instead of starting a duplicate server.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(createWindow);
}

app.on('before-quit', () => {
  isQuitting = true;
  // Never leave a topmost window or a temporary owner behind on exit.
  locationDialog.teardown();
});

app.on('window-all-closed', () => {
  if (clipboardMonitor) clipboardMonitor.stop();
  if (ipcServer) ipcServer.stop();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
