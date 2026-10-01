// @ts-check
/**
 * Google Drive / Gmail-hosted file resolver.
 *
 * AiDM had ZERO Google Drive support — a pasted `drive.google.com/file/d/<id>`
 * link was handed straight to the download engine, which saved the Drive HTML
 * viewer page as the file. Green row, 100%, useless bytes.
 *
 * Drive's download endpoint also MOVED. The old
 * `drive.google.com/uc?export=download` path now bounces through
 * `drive.usercontent.google.com/download`, and files that Drive deems
 * unverified (its "couldn't be scanned" interstitial) answer with an HTML page
 * containing a `<form id="download-form">` of hidden inputs instead of the
 * file. Every modern downloader (yt-dlp `googledrive.py`, gdown) follows that
 * form and re-requests with `confirm=t` + the form's `uuid`; this is the
 * 2024-2026 behaviour we were missing.
 *
 * The resolver runs at download START (not at add time) inside
 * `DownloadManager._startDownload`, so every entry point — UI paste, HTTP API,
 * IPC, clipboard — benefits, and the row still re-resolves after a restart.
 *
 * Pure helpers are exported so the whole flow is regression-testable offline.
 */

const DRIVE_HOSTS = /^(?:drive|docs|drive\.usercontent)\.google\.com$/i;

// /file/d/<id>/view · /open?id=<id> · /uc?id=<id> · /a/<domain>/uc?id=<id>
// Drive ids are base64url and normally 28-44 chars, but short ids exist on
// older resources. 6 is a safe floor given the host + path gates around it.
const ID_PATTERNS = [
  /\/file\/d\/([A-Za-z0-9_-]{6,})/,
  /\/folders\/([A-Za-z0-9_-]{6,})/,
  /[?&]id=([A-Za-z0-9_-]{6,})/,
  /\/document\/d\/([A-Za-z0-9_-]{6,})/,
];

/** @param {string} url */
function extractDriveFileId(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!/google\.com$/.test(host)) return null;
  for (const re of ID_PATTERNS) {
    const m = re.exec(u.pathname + u.search);
    if (m) return m[1];
  }
  return null;
}

/**
 * True for a Drive share/view URL that is a PAGE, not a file. A URL already
 * pointing at the download endpoint is left alone (it is already direct).
 * @param {string} url
 */
function isGoogleDriveUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (host === 'drive.usercontent.google.com') return false; // already direct
  if (!/^(?:drive|docs)\.google\.com$/.test(host)) return false;
  // Folder links have no single file to download.
  if (/\/folders\//.test(u.pathname)) return false;
  return !!extractDriveFileId(url);
}

/**
 * The modern Drive download endpoint. `confirm=t` skips the "file could not
 * be scanned" interstitial for files Drive will serve anyway.
 * @param {string} id
 */
function driveDirectUrl(id) {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
}

/**
 * Parse Drive's interstitial. Returns { action, fields } from
 * `<form id="download-form" action="…">` plus its hidden inputs, or null.
 *
 * @param {string} html
 * @returns {{ action: string, fields: Record<string, string> } | null}
 */
function parseDriveConfirmForm(html) {
  const src = String(html || '');
  if (!src) return null;

  // Prefer the form Drive actually uses; fall back to any form whose action
  // points at a download endpoint.
  let form = /<form\b[^>]*\bid=["']?download-form["']?[^>]*>([\s\S]*?)<\/form>/i.exec(src);
  if (!form) {
    form = /<form\b[^>]*\baction=["']?([^"'>]*download[^"'>]*)["']?[^>]*>([\s\S]*?)<\/form>/i.exec(src);
  }
  if (!form) return null;

  const body = form[1] || '';
  const actionMatch = /<form\b[^>]*\baction=["']?([^"'>]+)["']?/i.exec(form[0]) ||
    (form[2] ? null : null);
  // The action attribute is HTML — Drive escapes its own `&` separators, so
  // the URL is unusable until the entities are decoded.
  let action = actionMatch ? decodeEntities(actionMatch[1]) : '';
  if (!action && /^https?:/i.test(form[1] || '')) action = decodeEntities(form[1]);

  const fields = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(body))) {
    const tag = m[0];
    if (!/\btype=["']?hidden["']?/i.test(tag) && !/name=/i.test(tag)) continue;
    const name = /\bname=["']?([^"'>\s]+)["']?/i.exec(tag);
    if (!name) continue;
    const value = /\bvalue=["']?([^"'>]*)["']?/i.exec(tag);
    fields[name[1]] = value ? decodeEntities(value[1]) : '';
  }
  return { action, fields };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Build the follow-up GET URL from Drive's confirm form.
 * Drive's form is a GET form, so action + hidden inputs become a plain URL the
 * download engine can fetch (it cannot POST).
 *
 * @param {{ action: string, fields: Record<string, string> }} form
 * @param {string} fallbackId
 * @returns {string}
 */
function confirmFormUrl(form, fallbackId) {
  const base = /^https?:/i.test(form.action || '')
    ? form.action
    : 'https://drive.usercontent.google.com/download';
  let u;
  try { u = new URL(base); } catch { return driveDirectUrl(fallbackId); }
  for (const [k, v] of Object.entries(form.fields || {})) u.searchParams.set(k, v);
  // Drive's own form omits these on some responses; without `confirm` the
  // server just hands back the same interstitial.
  if (!u.searchParams.has('confirm')) u.searchParams.set('confirm', 't');
  if (!u.searchParams.has('id') && fallbackId) u.searchParams.set('id', fallbackId);
  if (!u.searchParams.has('export')) u.searchParams.set('export', 'download');
  return u.toString();
}

/** @param {string | null} header */
function hasContentDisposition(header) {
  return !!header && /filename/i.test(String(header));
}

/**
 * Resolve a Drive share URL into a URL that serves the real bytes.
 *
 * @param {string} url
 * @param {{ cookies?: string|null, headers?: Record<string,string>, fetchImpl?: any, timeoutMs?: number }} [opts]
 * @returns {Promise<{ url: string, filename: string|null, contentType: string|null, contentLength: number|null }>}
 */
async function resolveGoogleDriveUrl(url, opts = {}) {
  const id = extractDriveFileId(url);
  if (!id) throw new Error('This does not look like a Google Drive file link.');

  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchImpl) throw new Error('No HTTP transport available for Google Drive resolution.');

  const timeoutMs = opts.timeoutMs || 20000;
  const headers = { ...(opts.headers || {}) };
  if (opts.cookies && !Object.keys(headers).some(k => k.toLowerCase() === 'cookie')) {
    headers.Cookie = opts.cookies;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  /** @param {string} target @param {boolean} readBody */
  const attempt = async (target, readBody) => {
    const res = await fetchImpl(target, {
      method: 'GET',
      headers: { ...headers, Accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const cd = res.headers && res.headers.get ? res.headers.get('content-disposition') : null;
    const ct = res.headers && res.headers.get ? res.headers.get('content-type') : null;
    const cl = res.headers && res.headers.get ? res.headers.get('content-length') : null;
    if (hasContentDisposition(cd)) {
      try { await res.body?.cancel().catch(() => {}); } catch {}
      return {
        url: res.url || target,
        filename: filenameFromDisposition(cd),
        contentType: ct,
        contentLength: cl && /^\d+$/.test(cl.trim()) ? Number(cl) : null,
      };
    }
    let html = '';
    if (readBody && ct && /text\/html/i.test(ct)) {
      try { html = await res.text(); } catch { html = ''; }
    }
    try { await res.body?.cancel().catch(() => {}); } catch {}
    return { url: res.url || target, filename: null, contentType: ct, contentLength: null, html };
  };

  try {
    // 1. The direct endpoint with confirm=t — serves most files outright.
    const first = await attempt(driveDirectUrl(id), true);

    // 2. Drive's scan interstitial: follow its form and re-request.
    if (first.html) {
      const form = parseDriveConfirmForm(first.html);
      if (form && (form.action || Object.keys(form.fields || {}).length)) {
        // The form is a GET form, so the follow-up is a plain URL the engine
        // can fetch. Whether it really serves bytes is settled one layer up by
        // the engine's own probe and the auth-wall guard.
        const follow = await attempt(confirmFormUrl(form, id), false);
        return {
          url: follow.url,
          filename: follow.filename,
          contentType: follow.contentType,
          contentLength: follow.contentLength,
        };
      }
      throw new Error(
        'Google Drive would not release this file. Open it in your browser once ' +
        '(Drive sometimes requires a manual confirm for files it could not scan), ' +
        'then retry — or use Gmail/Drive "Download" from the browser.'
      );
    }

    // Small files answer the direct URL with 200 + Content-Disposition, so
    // `first.filename` is set. A nameless non-HTML answer still carries bytes.
    if (!first.filename && first.contentType && /text\/html/i.test(first.contentType)) {
      throw new Error('Google Drive returned a page instead of the file — the link may need a browser login.');
    }
    return { url: first.url, filename: first.filename, contentType: first.contentType, contentLength: first.contentLength };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string | null} header */
function filenameFromDisposition(header) {
  const raw = String(header || '');
  const star = /filename\*\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(raw);
  if (star) {
    const v = (star[1] ?? star[2] ?? '').trim();
    const parts = /^([^']*)'[^']*'(.*)$/.exec(v);
    try { return decodeURIComponent(parts ? parts[2] : v); } catch { return v; }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(raw);
  if (!plain) return null;
  return (plain[1] !== undefined ? plain[1].replace(/\\(.)/g, '$1') : plain[2]).trim();
}

module.exports = {
  isGoogleDriveUrl,
  extractDriveFileId,
  driveDirectUrl,
  parseDriveConfirmForm,
  confirmFormUrl,
  resolveGoogleDriveUrl,
  filenameFromDisposition,
  DRIVE_HOSTS,
};
