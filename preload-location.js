/* Minimal, purpose-built bridge for the topmost download-location window.
 * Only the handful of operations that window needs are exposed.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aidmLocation', {
  /** Receives { id, filename, category, suggestedPath } once, right after load. */
  init: (cb) => ipcRenderer.on('location-init', (_, data) => cb(data)),
  /** Opens the native folder picker, owned by this (topmost) window. */
  browse: () => ipcRenderer.invoke('location-browse'),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  /** Resolves the dialog with a chosen location. */
  confirm: (data) => ipcRenderer.invoke('location-confirm', data),
  /** Resolves the dialog as cancelled/closed. */
  cancel: () => ipcRenderer.invoke('location-cancel'),
});
