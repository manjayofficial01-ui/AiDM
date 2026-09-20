const { EventEmitter } = require('events');
const jev = require('./jev');

/**
 * Clipboard Monitor - Inspired by JDownloader's clipboard monitoring
 * Watches clipboard for download URLs and notifies the UI
 */
class ClipboardMonitor extends EventEmitter {
  /**
   * @param {{ jevAssist?: () => boolean }} [opts] `jevAssist` lets the host
   *   gate the Jev fallback at call time (settings toggle). Default: on when
   *   TYPESAFE_API_KEY is present.
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.interval = null;
    this.lastContent = '';
    this.downloadPatterns = [
      /\.(zip|rar|7z|tar|gz|bz2|xz|iso|dmg|exe|msi|deb|rpm|apk|ipa)(\?|$)/i,
      /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mp3|wav|flac|aac|ogg|wma)(\?|$)/i,
      /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt|rtf)(\?|$)/i,
      /\.(jpg|jpeg|png|gif|bmp|svg|webp|tiff|psd|ai)(\?|$)/i,
      /\.(iso|img|bin|cue|mdf|nrg)(\?|$)/i,
      /\.(m3u8|mpd)(\?|$)/i,
      // Directories / hosts that are almost always file downloads
      /\/download\//i,
      /\/releases\//i,
      /\/dl\//i,
      /\/files\//i,
      /[?&]download=/i,
      // Social video pages — AiDM resolves these into real files (Twitter/X
      // via syndication, Facebook/Instagram via page resolver). Without these
      // patterns a copied watch/tweet link never popped the Add dialog.
      /(?:www\.|m\.|web\.)?facebook\.com\/(?:watch|reel|share\/v|video\.php|story\.php|[^/]+\/videos)/i,
      /fb\.watch\//i,
      /(?:www\.)?instagram\.com\/(?:reel|p|tv)\//i,
      /(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/(?:i\/web\/)?(?:[^/]+\/)?status(?:es)?\/\d{5,25}/i,
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
    // Inside the Electron main process, read the clipboard directly. The old
    // implementation spawned `powershell Get-Clipboard` every poll tick, which
    // blocked the main process (and with it every download callback and the
    // whole UI) for hundreds of milliseconds per tick.
    try {
      const electron = require('electron');
      if (electron && typeof electron === 'object' && electron.clipboard) {
        const text = String(electron.clipboard.readText() || '');
        // Multi-line clipboard content (e.g. copied from a document) is not a
        // URL — only the first non-empty line is considered.
        const firstLine = text.split(/\r?\n/).find(l => l.trim());
        return (firstLine || '').trim();
      }
    } catch (e) { /* not running inside Electron — fall back below (tests) */ }

    try {
      const { execSync } = require('child_process');
      const platform = process.platform;
      let text = '';
      if (platform === 'win32') {
        text = execSync('powershell -NoProfile -Command "Get-Clipboard -Raw"', { encoding: 'utf-8', timeout: 3000 });
      } else if (platform === 'darwin') {
        text = execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 });
      } else {
        try {
          text = execSync('xclip -selection clipboard -o', { encoding: 'utf-8', timeout: 3000 });
        } catch {
          return '';
        }
      }
      const firstLine = String(text || '').split(/\r?\n/).find(l => l.trim());
      return (firstLine || '').trim();
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
      return;
    }

    // Jev fallback: the static patterns missed this URL. Ask the System One
    // model whether it is a downloadable file link; if confident, promote it
    // exactly like a regex hit. Fail-open — no key, network trouble, or a
    // "webpage" verdict all mean the URL is simply ignored, as before.
    this._jevRescue(content);
  }

  /**
   * @param {string} url
   */
  _jevRescue(url) {
    if (this._jevPending === url) return; // still deciding on this exact URL
    this._jevPending = url;
    const enabled = this.opts.jevAssist ? !!this.opts.jevAssist() : jev.isConfigured();
    Promise.resolve()
      .then(() => (enabled ? jev.classifyLink(url) : null))
      .then((verdict) => {
        if (verdict && verdict.downloadable) this.emit('link-found', url);
      })
      .catch(() => { /* never let the AI path break clipboard polling */ })
      .finally(() => {
        if (this._jevPending === url) this._jevPending = null;
      });
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
