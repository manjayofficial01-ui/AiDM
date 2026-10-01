// @ts-check
/**
 * Auth-wall detection — "the server handed us a login page, not the file".
 *
 * The Gmail PDF failure has two faces. With a good session cookie the request
 * reaches Gmail and a mangled URL is answered with HTTP 400. With NO cookie
 * (or an expired one) Google does not 400 at all: it 302s to
 * `accounts.google.com/ServiceLogin?continue=…` and serves a 200 HTML page.
 * AiDM followed the redirect and happily wrote that sign-in page to disk as
 * `invoice.pdf` — a completed row, 100%, silently wrong. That is worse than
 * an error, because nothing tells the user to look.
 *
 * This module is the guard: from headers only (a probe never reads the body)
 * decide whether the response is an authentication interstitial, and give the
 * user an actionable message instead of a saved HTML file.
 *
 * Pure and dependency-free so it is regression-testable without a network.
 */

// Hosts / paths that exist only to authenticate a user.
const AUTH_HOST_RE = [
  /^accounts\.google\.[a-z.]+$/i,
  /^login\.microsoftonline\.[a-z.]+$/i,
  /^account\.live\.[a-z.]+$/i,
  /^login\.(?:live|microsoft|yahoo|dropbox|box)\.[a-z.]+$/i,
  /^signin\.[a-z0-9.-]+$/i,
  /^id\.msn\.[a-z.]+$/i,
  /^auth\.[a-z0-9.-]+$/i,
  /^sso\.[a-z0-9.-]+$/i,
];

const AUTH_PATH_RE = [
  /\/servicelogin\b/i,
  /\/signin\b/i,
  /\/sign-in\b/i,
  /\/login\b/i,
  /\/log-in\b/i,
  /\/accounts?\/login\b/i,
  /\/auth(?:enticate|wall)?\b/i,
  /\/session(?:_?expired|\/new)\b/i,
  /\/checkpoint\b/i,
  /\/oauth2?\/authorize\b/i,
  /\/saml\b/i,
  /\/idp\b/i,
  /\/passport\b/i,
  /\/u\/0\/signin/i,
  /\/interstitial\b/i,
  // Single sign-on endpoints live at many paths, not just known SSO hosts.
  /\/sso\b/i,
  /\/sso\/login\b/i,
];

// Extensions that are never HTML. If the server answers one of these with
// `text/html`, it is not the file — it is a page standing in front of it.
const BINARY_EXTENSIONS = new Set([
  'pdf', 'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg', 'img',
  'exe', 'msi', 'deb', 'rpm', 'apk', 'appimage', 'msix',
  'mp4', 'mkv', 'mov', 'avi', 'wmv', 'webm', 'flv', 'm4v', 'ts',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'opus', 'm4a',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'psd',
]);

/** @param {string} u */
function extensionOfUrl(u) {
  try {
    const parsed = new URL(String(u || ''));
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    const dot = last.lastIndexOf('.');
    return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

/** @param {string} name */
function extensionOfFilename(name) {
  const last = String(name || '').split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

/**
 * Decide whether a probe result is an authentication interstitial.
 *
 * @param {{
 *   finalUrl?: string|null,
 *   contentType?: string|null,
 *   contentLength?: number|null,
 *   status?: number|null,
 *   filename?: string|null,
 *   url?: string|null,
 * }} meta
 * @returns {boolean}
 */
function looksLikeAuthWall(meta) {
  const m = meta || {};
  const finalUrl = String(m.finalUrl || m.url || '');
  const ctype = String(m.contentType || '').toLowerCase();

  // 1. Explicit redirect to a sign-in endpoint — unambiguous.
  let host = '';
  let pathname = '';
  try {
    const u = new URL(finalUrl);
    host = u.hostname;
    pathname = u.pathname || '';
  } catch {
    host = '';
    pathname = '';
  }
  if (host && (AUTH_HOST_RE.some(re => re.test(host)) || AUTH_PATH_RE.some(re => re.test(pathname)))) {
    return true;
  }

  // 2. HTML where a binary document was expected. This is the silent case:
  //    the row completes, the file is a sign-in page.
  if (/\btext\/html\b/.test(ctype)) {
    const ext = extensionOfFilename(m.filename || '') || extensionOfUrl(finalUrl);
    if (ext && BINARY_EXTENSIONS.has(ext)) return true;
  }

  return false;
}

/**
 * Friendly, actionable message for a row that hit an auth wall.
 * Extracted pure so it is regression-testable.
 */
function sessionExpiredMessage() {
  return 'This link needs a browser login — the server returned a sign-in ' +
    'page instead of the file. Open the page in your browser and download ' +
    'from there (or capture it with the AiDM browser extension) so AiDM ' +
    'receives the session cookie, then retry this row.';
}

module.exports = {
  looksLikeAuthWall,
  sessionExpiredMessage,
  extensionOfUrl,
  extensionOfFilename,
  AUTH_HOST_RE,
  AUTH_PATH_RE,
  BINARY_EXTENSIONS,
};
