const { EventEmitter } = require('events');

/**
 * Clipboard Monitor - Inspired by JDownloader's clipboard monitoring
 * Watches clipboard for download URLs and notifies the UI
 */
class ClipboardMonitor extends EventEmitter {
  constructor() {
    super();
    this.interval = null;
    this.lastContent = '';
    this.downloadPatterns = [
      /\.(zip|rar|7z|tar|gz|bz2|xz|iso|dmg|exe|msi|deb|rpm|apk|ipa)(\?|$)/i,
      /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mp3|wav|flac|aac|ogg|wma)(\?|$)/i,
      /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt|rtf)(\?|$)/i,
      /\.(jpg|jpeg|png|gif|bmp|svg|webp|tiff|psd|ai)(\?|$)/i,
      /\.(iso|img|bin|cue|mdf|nrg)(\?|$)/i,
      /download/i,
      /\/dl\//i,
      /cdn\./i,
      /releases\//i,
    ];
  }

  start() {
    if (this.interval) return;
    this.lastContent = this._getClipboard();
    this.interval = setInterval(() => this._check(), 1500);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  _getClipboard() {
    try {
      const { execSync } = require('child_process');
      const platform = process.platform;
      if (platform === 'win32') {
        return execSync('powershell -command "Get-Clipboard"', { encoding: 'utf-8', timeout: 3000 }).trim();
      } else if (platform === 'darwin') {
        return execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 }).trim();
      } else {
        try {
          return execSync('xclip -selection clipboard -o', { encoding: 'utf-8', timeout: 3000 }).trim();
        } catch {
          return '';
        }
      }
    } catch {
      return '';
    }
  }

  _check() {
    const content = this._getClipboard();
    if (!content || content === this.lastContent) return;
    this.lastContent = content;

    // Check if it looks like a download URL
    if (this._isDownloadUrl(content)) {
      this.emit('link-found', content);
    }
  }

  _isDownloadUrl(text) {
    // Must be a valid URL
    try {
      const url = new URL(text.trim());
      if (!['http:', 'https:', 'ftp:'].includes(url.protocol)) return false;
    } catch {
      return false;
    }

    // Check against patterns
    return this.downloadPatterns.some(pattern => pattern.test(text));
  }
}

module.exports = { ClipboardMonitor };
