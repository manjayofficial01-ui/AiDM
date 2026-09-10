const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aidm', {
  // Download operations
  addDownload: (opts) => ipcRenderer.invoke('add-download', opts),
  pauseDownload: (id) => ipcRenderer.invoke('pause-download', { id }),
  resumeDownload: (id) => ipcRenderer.invoke('resume-download', { id }),
  cancelDownload: (id) => ipcRenderer.invoke('cancel-download', { id }),
  removeDownload: (id) => ipcRenderer.invoke('remove-download', { id }),
  approveDownload: (id, savePath) => ipcRenderer.invoke('approve-download', { id, savePath }),
  rejectDownload: (id) => ipcRenderer.invoke('reject-download', { id }),
  getDownloads: () => ipcRenderer.invoke('get-downloads'),

  // Queue operations
  queueDownload: (opts) => ipcRenderer.invoke('queue-download', opts),
  startQueue: () => ipcRenderer.invoke('start-queue'),
  pauseQueue: () => ipcRenderer.invoke('pause-queue'),

  // File operations
  openFile: (filePath) => ipcRenderer.invoke('open-file', { filePath }),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', { folderPath }),
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // AI (TokenHarbor: mimo-v2.5:free + deepseek-v4-flash:free)
  aiStatus: () => ipcRenderer.invoke('ai-status'),
  aiChat: (messages, opts) => ipcRenderer.invoke('ai-chat', { messages, opts }),
  aiSmartFilename: (url, hint) => ipcRenderer.invoke('ai-smart-filename', { url, hint }),
  aiCategorize: (url, filename) => ipcRenderer.invoke('ai-categorize', { url, filename }),
  aiExplainError: (error, url) => ipcRenderer.invoke('ai-explain-error', { error, url }),
  aiHealth: () => ipcRenderer.invoke('ai-health'),
  aiModels: () => ipcRenderer.invoke('ai-models'),

  // Window controls
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  showWindow: () => ipcRenderer.invoke('show-window'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),

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
  onClipboardLink: (cb) => ipcRenderer.on('clipboard-link', (_, url) => cb(url)),
  onDownloadAskLocation: (cb) => ipcRenderer.on('download-ask-location', (_, data) => cb(data)),
  onVideoDetected: (cb) => ipcRenderer.on('video-detected', (_, data) => cb(data)),
});
