const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { DownloadManager } = require('./src/download-manager');
const { ClipboardMonitor } = require('./src/clipboard-monitor');
const { IPCServer } = require('./src/server');
const { AiService } = require('./src/ai-service');
const twitterResolver = require('./src/twitter-resolver');
const locationDialog = require('./src/location-dialog');

let mainWindow;
let tray = null;
let isQuitting = false;
let downloadManager;
let clipboardMonitor;
let ipcServer;
let aiService;

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
  ];
  events.forEach(event => {
    downloadManager.on(event, (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(event, data);
      }
    });
  });

  // "Ask every time": raise the topmost location dialog. The download stays in
  // "pending-approval" until the user picks a folder or cancels, so the
  // workflow is modal without blocking any other application.
  downloadManager.on('download-ask-location', (data) => locationDialog.requestLocation(data));
  // (download-ask-location already carries suggestedPath = the default; the
  //  dialog treats it as the default location and lets the user override it.)

  // When the real file name is learned after the dialog opened, refresh the
  // still-open dialog (and the pending row) with the improved name/path.
  downloadManager.on('download-updated', (d) => {
    locationDialog.patch(d.id, { filename: d.filename, savePath: d.savePath });
  });

  clipboardMonitor.on('link-found', (url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-link', url);
    }
  });

  ipcServer.start();
  clipboardMonitor.start();
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

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('add-download', async (event, opts) => {
  // Twitter/X: a status URL is a web page, not a file — adding it directly
  // would download the tweet's HTML. Resolve it to the real MP4 variants and
  // show the normal quality picker instead. Guarded by isTweetUrl(), which is
  // deliberately strict so media URLs (twimg paths contain 19-digit ids) are
  // never mistaken for a tweet.
  try {
    if (opts && opts.url && twitterResolver.isTweetUrl(opts.url)) {
      const { tweetId, videos } = await twitterResolver.resolveTweetVideos(opts.url);
      const payload = {
        pageUrl: opts.url,
        pageTitle: `Tweet ${tweetId}`,
        videos: twitterResolver.toPickerVideos(videos),
      };
      downloadManager.emit('video-detected', payload);
      return { twitterResolved: true, tweetId, videos: payload.videos };
    }
  } catch (e) {
    // Resolution failed (image-only tweet, deleted, offline…). Fall through and
    // let the URL be added normally rather than silently swallowing the request.
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

ipcMain.handle('approve-download', async (event, { id, savePath }) => {
  return downloadManager.approveDownload(id, savePath);
});

ipcMain.handle('reject-download', async (event, { id }) => {
  return downloadManager.rejectDownload(id);
});

ipcMain.handle('get-downloads', async () => {
  return downloadManager.getAllDownloads();
});

ipcMain.handle('open-file', async (event, { filePath }) => {
  shell.openPath(filePath);
});

ipcMain.handle('open-folder', async (event, { folderPath }) => {
  shell.showItemInFolder(folderPath);
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
    suggestedPath: dl.savePath || dm.settings.defaultSavePath,
    defaultPath: dm.settings.categoryPaths[dl.category] || dm.settings.defaultSavePath,
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
  try { return { enabled: app.getLoginItemSettings().openAtLogin }; }
  catch { return { enabled: false }; }
});

ipcMain.handle('get-settings', async () => {
  return downloadManager.getSettings();
});

ipcMain.handle('save-settings', async (event, settings) => {
  const saved = downloadManager.saveSettings(settings);
  syncAiConfig();
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
