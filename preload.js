const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aidm', {
  // Download operations
  addDownload: (opts) => ipcRenderer.invoke('add-download', opts),
  pauseDownload: (id) => ipcRenderer.invoke('pause-download', { id }),
  resumeDownload: (id) => ipcRenderer.invoke('resume-download', { id }),
  cancelDownload: (id) => ipcRenderer.invoke('cancel-download', { id }),
  removeDownload: (id) => ipcRenderer.invoke('remove-download', { id }),
  setDownloadPriority: (id, priority) => ipcRenderer.invoke('set-download-priority', { id, priority }),
  setDownloadSpeedLimit: (id, bytesPerSecond) => ipcRenderer.invoke('set-download-speed-limit', { id, bytesPerSecond }),
  getTorrentInfo: (id) => ipcRenderer.invoke('get-torrent-info', { id }),
  setTorrentSelection: (id, selection) => ipcRenderer.invoke('set-torrent-selection', { id, selection }),
  setTorrentSeedPolicy: (id, policy) => ipcRenderer.invoke('set-torrent-seed-policy', { id, policy }),
  approveDownload: (id, savePath, filename) => ipcRenderer.invoke('approve-download', { id, savePath, filename }),
  rejectDownload: (id) => ipcRenderer.invoke('reject-download', { id }),
  getDownloads: () => ipcRenderer.invoke('get-downloads'),

  // Queue operations
  queueDownload: (opts) => ipcRenderer.invoke('queue-download', opts),
  startQueue: () => ipcRenderer.invoke('start-queue'),
  pauseQueue: () => ipcRenderer.invoke('pause-queue'),

  // Scheduler (v4.3.0)
  getSchedules: () => ipcRenderer.invoke('get-schedules'),
  saveSchedules: (schedules) => ipcRenderer.invoke('save-schedules', schedules),
  schedulerNext: () => ipcRenderer.invoke('scheduler-next'),

  // File operations
  openFile: (filePath) => ipcRenderer.invoke('open-file', { filePath }),
  openDownloadLog: (id) => ipcRenderer.invoke('open-download-log', { id }),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', { folderPath }),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  /** Netscape cookies.txt picker for yt-dlp (Settings › YouTube). */
  selectCookieFile: () => ipcRenderer.invoke('select-cookie-file'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),

  // yt-dlp engine (Settings › YouTube): detected version + one-click update
  getYtDlpStatus: () => ipcRenderer.invoke('yt-dlp-status'),
  updateYtDlp: () => ipcRenderer.invoke('update-yt-dlp'),

  // AI (TokenHarbor: mimo-v2.5:free + deepseek-v4-flash:free)
  aiStatus: () => ipcRenderer.invoke('ai-status'),
  aiChat: (messages, opts) => ipcRenderer.invoke('ai-chat', { messages, opts }),
  aiSmartFilename: (url, hint) => ipcRenderer.invoke('ai-smart-filename', { url, hint }),
  aiCategorize: (url, filename) => ipcRenderer.invoke('ai-categorize', { url, filename }),
  aiExplainError: (error, url) => ipcRenderer.invoke('ai-explain-error', { error, url }),
  aiSummarize: (text, title) => ipcRenderer.invoke('ai-summarize', { text, title }),
  aiHealth: () => ipcRenderer.invoke('ai-health'),
  aiModels: () => ipcRenderer.invoke('ai-models'),
  exportDownloads: () => ipcRenderer.invoke('export-downloads'),
  importDownloads: (items) => ipcRenderer.invoke('import-downloads', items),
  exportSettings: () => ipcRenderer.invoke('export-settings'),
  importSettings: (settings) => ipcRenderer.invoke('import-settings', settings),
  batchUrls: (urls) => ipcRenderer.invoke('batch-urls', { urls }),
  nlCommand: (text) => ipcRenderer.invoke('nl-command', { text }),
  // Recursive site grabber: returns { files: [{url, depth, crossOrigin}], … }.
  // It only DISCOVERS URLs — queueing them still goes through batchUrls, i.e.
  // the normal addDownload door.
  grabSite: (opts) => ipcRenderer.invoke('grab-site', opts),
  onGrabProgress: (cb) => ipcRenderer.on('grab-progress', (_, data) => cb(data)),

  // Window controls
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  showWindow: () => ipcRenderer.invoke('show-window'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  deleteFileFromDisk: (filepath) => ipcRenderer.invoke('delete-file-from-disk', { filepath }),

  // Approval-dialog helpers
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  /** Ask the main process to open the topmost download-location dialog. */
  requestLocation: (id) => ipcRenderer.invoke('request-location', { id }),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window-always-on-top', !!on),

  // Event listeners
  onDownloadAdded: (cb) => ipcRenderer.on('download-added', (_, data) => cb(data)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_, data) => cb(data)),
  onDownloadComplete: (cb) => ipcRenderer.on('download-complete', (_, data) => cb(data)),
  onDownloadError: (cb) => ipcRenderer.on('download-error', (_, data) => cb(data)),
  onDownloadPaused: (cb) => ipcRenderer.on('download-paused', (_, data) => cb(data)),
  onDownloadResumed: (cb) => ipcRenderer.on('download-resumed', (_, data) => cb(data)),
  onDownloadRemoved: (cb) => ipcRenderer.on('download-removed', (_, data) => cb(data)),
  onDownloadUpdated: (cb) => ipcRenderer.on('download-updated', (_, data) => cb(data)),
  onDownloadHash: (cb) => ipcRenderer.on('download-hash', (_, data) => cb(data)),
  onClipboardLink: (cb) => ipcRenderer.on('clipboard-link', (_, url) => cb(url)),
  onDownloadAskLocation: (cb) => ipcRenderer.on('download-ask-location', (_, data) => cb(data)),
  onVideoDetected: (cb) => ipcRenderer.on('video-detected', (_, data) => cb(data)),
  onSchedulerEvent: (cb) => ipcRenderer.on('scheduler-event', (_, data) => cb(data)),
  /** Live progress of the in-app yt-dlp update (Settings › YouTube). */
  onYtDlpUpdateStatus: (cb) => ipcRenderer.on('yt-dlp-update-status', (_, data) => cb(data)),
  /** Disk state could not be saved (shown in the status bar until recovery). */
  onPersistError: (cb) => ipcRenderer.on('persist-error', (_, data) => cb(data)),
  onPersistRecovered: (cb) => ipcRenderer.on('persist-recovered', (_, data) => cb(data)),
  /** Local-API health for the status bar (main-process request, no Origin). */
  getApiStatus: () => ipcRenderer.invoke('api-status'),
});
