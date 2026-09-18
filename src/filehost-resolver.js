/**
 * File-hoster resolver — Rapidgator (first host, framework for more).
 *
 * Background
 * ----------
 * A pasted `https://rapidgator.net/file/<id>/<name>.html` link used to fall
 * through every resolver, so the manager downloaded the PAGE HTML as a file.
 * This module turns a file-hoster page URL into one direct file URL plus the
 * replay headers the engine needs — the same contract every other resolver
 * in src/resolvers.js honours.
 *
 * Security (same rules as src/embed-resolver.js):
 *   • Only identifiers are parsed out of user input. Page/API fetches go to
 *     URLs we construct on an allowlist of Rapidgator hosts; anything else is
 *     refused before a socket is opened (no open proxy / no generic fetcher).
 *   • Redirects are followed only inside the Rapidgator host family, max 3.
 *   • Bodies are capped (2 MB) — file pages are small HTML.
 *
 * Anti-abuse stance: the free-user path is forced through a wait timer and
 * often a captcha. We do NOT solve, skip or bypass either, and we never call
 * a third-party "debrid"/leach service. A wait is reported back to the caller
 * (`waitSeconds` + `requiresCredentials`) with the hint that a premium
 * account or a logged-in session cookie removes it.
 *
 * Download flags: Rapidgator links commonly reject `Range` and produce corrupt
 * files when requested in parallel segments, so every direct URL is flagged
 * `singleConnection: true` / `resumable: false`. Team F's manager reads them.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { cleanPageTitle } = require('./titles');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_WAIT_SECONDS = 60;

const WAIT_HINT = 'This Rapidgator link needs a premium account or a logged-in session cookie — add one in Settings › File hosts.';

// Path segments that are site chrome, never a file identifier.
const NON_FILE_PATHS = new Set([
  'api', 'login', 'logout', 'registration', 'register', 'signup', 'premium',
  'news', 'article', 'articles', 'blog', 'page', 'pages', 'user', 'users',
  'auth', 'oauth', 'account', 'accounts', 'faq', 'contact', 'support',
  'terms', 'privacy', 'help', 'money', 'tariffs', 'refund', 'dmca', 'tos',
  'index', 'main', 'home', 'sitemap', 'search', 'upload', 'loader', 'remote',
  'remoteupload', 'static', 'assets', 'img', 'images', 'css', 'js', 'download',
]);

// ── Host allowlist ─────────────────────────────────────────────────────────

/**
 * Hosts this resolver may ever touch: the site itself plus its own download
 * /CDN sub-domains (`s3.rapidgator.net`, `dl.rg.to`, …). Everything else —
 * including a look-alike such as `rapidgator.net.evil.com` — is refused.
 */
const HOSTS = {
  rapidgator: {
    id: 'rapidgator',
    label: 'Rapidgator',
    provider: 'rapidgator',
    primaryHost: 'rapidgator.net',
    pageHosts: [
      'rapidgator.net', 'www.rapidgator.net', 'rg.to', 'www.rg.to',
    ],
    hostPatterns: [
      /^(www\.)?rapidgator\.net$/i,
      /^(www\.)?rg\.to$/i,
      /^[a-z0-9-]+\.rapidgator\.net$/i,
      /^[a-z0-9-]+\.rg\.to$/i,
    ],
    api: {
      login: 'https://rapidgator.net/api/user/login',
      download: 'https://rapidgator.net/api/file/download',
    },
    isAllowedHost(host) { return isAllowedHost(host); },
  },
};

/** Pure allowlist guard. Never throws. */
function isAllowedHost(host) {
  const h = String(host == null ? '' : host).trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return HOSTS.rapidgator.hostPatterns.some((re) => re.test(h));
}

/** True when both hosts belong to the same site family (redirect guard). */
function sameHostFamily(a, b) {
  const base = (h) => String(h || '').toLowerCase().replace(/^(www\.|m\.)/, '')
    .replace(/^[a-z0-9-]+\./, '').replace(/\.$/, '');
  return base(a) === base(b) || (isAllowedHost(a) && isAllowedHost(b));
}

// ── Strict URL parsing (identifier-only) ────────────────────────────────────

function decodeSegment(s) {
  try { return decodeURIComponent(String(s || '')); } catch (e) { return String(s || ''); }
}

/** Slug ("My.File.rar") → a safe file name, or null when unusable. */
function cleanSlugName(slug) {
  let s = decodeSegment(slug).replace(/\.html?$/i, '').trim();
  if (!s) return null;
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  if (!s || s === '.' || s === '..') return null;
  return s.slice(0, 160);
}

/**
 * @returns {{ host:'rapidgator', provider:'rapidgator', fileId:string,
 *   fileName:string|null, kind:'file'|'download'|'short', pageUrl:string }|null}
 * Never throws; null when the input is not a supported Rapidgator link.
 */
function parseFileHostUrl(input) {
  let u;
  try {
    u = new URL(String(input == null ? '' : input).trim());
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!isAllowedHost(hostname)) return null;

  const path = u.pathname || '/';
  const canonicalHost = /rg\.to$/i.test(hostname) ? 'rapidgator.net' : 'rapidgator.net';

  // 1. /file/<id>/<slug>.html  — and the short /file/<id> form.
  let m = /^\/file\/(\d{4,20})(?:\/([^/]*))?\/?$/i.exec(path);
  if (m) {
    const fileId = m[1];
    const slug = cleanSlugName(m[2] || '');
    return {
      host: 'rapidgator',
      provider: 'rapidgator',
      fileId,
      fileName: slug || null,
      kind: 'file',
      pageUrl: `https://${canonicalHost}/file/${fileId}/${slug ? encodeURIComponent(slug) + '.html' : ''}`,
    };
  }

  // 2. /download/<hash>
  m = /^\/download\/([A-Za-z0-9]{6,64})\/?$/i.exec(path);
  if (m) {
    return {
      host: 'rapidgator',
      provider: 'rapidgator',
      fileId: m[1],
      fileName: null,
      kind: 'download',
      pageUrl: `https://${canonicalHost}/download/${m[1]}`,
    };
  }

  // 3. /<hash> short link (site chrome paths are rejected explicitly).
  m = /^\/([A-Za-z0-9_-]{8,64})\/?$/.exec(path);
  if (m && !NON_FILE_PATHS.has(m[1].toLowerCase())) {
    return {
      host: 'rapidgator',
      provider: 'rapidgator',
      fileId: m[1],
      fileName: null,
      kind: 'short',
      pageUrl: `https://${canonicalHost}/${m[1]}`,
    };
  }

  return null;
}

function isFileHostUrl(input) {
  return parseFileHostUrl(input) !== null;
}

// ── Pure page parsers (no network) ──────────────────────────────────────────

/** Strip tags/entities down to comparable text. */
function textOf(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Absolute https/http URL from a possibly relative or protocol-relative one. */
function absolutize(raw, pageUrl) {
  let u = String(raw || '').trim().replace(/&amp;/g, '&').replace(/["'\),;\\]+$/, '');
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) {
    try { u = new URL(u, pageUrl || 'https://rapidgator.net/').href; } catch (e) { return null; }
  }
  if (!/^https?:\/\//i.test(u)) return null;
  try { return new URL(u).href; } catch (e) { return null; }
}

/** True when the URL points at the file's bytes rather than another HTML page. */
function looksLikeDirectFile(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return false; }
  if (!isAllowedHost(u.hostname)) return false;
  const path = u.pathname || '/';
  if (/\.(html?|php[0-9]?|asp|aspx|jsp|json|xml)$/i.test(path)) return false;
  if (/^\/(?:file|article|articles|login|registration|premium|user|users|api|news|page|pages|blog)(\/|$)/i.test(path)) return false;
  // Download/CDN sub-domains serve the file itself even without an extension.
  if (/^(?:s\d+|fs\d*|dl\d*|cdn|files?|download|storage)\./i.test(u.hostname)) return true;
  return /\.[A-Za-z0-9]{2,8}$/.test(path);
}

// Link hrefs that are site chrome / another page, never the download itself.
const NON_DOWNLOAD_HREF = /(?:\.html?|\.php[0-9]?|\.css|\.js|\.jpe?g|\.png|\.gif|\.svg|\.ico)(?:[?#]|$)|^\/+(?:file|article|login|registration|premium|user|api|news|page|blog|faq|support|contact|terms|privacy|remote|upload)(\/|$)|^(?:javascript|mailto):|^\/?#/i;

/**
 * The download link inside a Rapidgator file page: the free/premium "download"
 * anchor, a download-host link, a JS `window.location` hand-off, or a meta
 * refresh. Pure function — no network.
 *
 * @returns {string|null} absolute URL, or null when the page offers none
 *   (wait / captcha / premium-only pages legitimately return null — use
 *   detectFileHostPageState() for the reason).
 */
function extractDownloadUrlFromPage(html, pageUrl) {
  const src = String(html || '');
  const base = pageUrl || 'https://rapidgator.net/';
  const candidates = [];

  const push = (raw) => {
    const abs = absolutize(raw, base);
    if (!abs) return;
    let u;
    try { u = new URL(abs); } catch (e) { return; }
    if (!isAllowedHost(u.hostname)) return;
    if (NON_DOWNLOAD_HREF.test(u.pathname + (u.search || ''))) return;
    if (u.pathname === '/' || u.pathname === '') return;
    candidates.push(abs);
  };

  // 1. Real anchors (single or double quotes), download buttons included.
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(src)) !== null) push(m[1]);

  // 2. JS hand-off: window.location / document.location / location.href.
  const jsRe = /(?:window\.)?(?:document\.)?location(?:\.href)?\s*=\s*["']([^"']{4,400})["']/gi;
  while ((m = jsRe.exec(src)) !== null) push(m[1]);

  // 3. Meta refresh.
  m = /<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>\s]+)["']/i.exec(src);
  if (m) push(m[1]);

  // 4. JS config values (`url: "…"`, `download_url`, `file:`).
  const cfgRe = /(?:download_url|downloadUrl|url|file|link)\s*[:=]\s*["']((?:https?:)?\/\/[^"'<>]{4,400}|[^"'<>]*(?:\/download\/|\/dl\/)[^"'<>]{4,400})["']/gi;
  while ((m = cfgRe.exec(src)) !== null) push(m[1]);

  if (!candidates.length) return null;

  const scored = candidates.map((url) => {
    let score = 0;
    if (/\/d(?:own)?l(?:oad)?\/|\/download\/|\/get\/|\/dl\//i.test(url)) score += 3;
    if (/^(?:s\d+|fs\d*|dl\d*|cdn|files?|download|storage)\./i.test(new URL(url).hostname)) score += 4;
    if (/\.[A-Za-z0-9]{2,8}$/.test(new URL(url).pathname)) score += 2;
    if (/premium|free/i.test(url)) score += 1;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].url;
}

/**
 * A POST form on the file page (Rapidgator's free-download button posts a
 * small hidden-field form). Pure function.
 * @returns {{ action:string, fields:Object<string,string> }|null}
 */
function extractDownloadForm(html, pageUrl) {
  const src = String(html || '');
  const fm = /<form\b([^>]*)>([\s\S]{0,4000}?)<\/form\s*>/i.exec(src);
  if (!fm) return null;
  const attrs = fm[1] || '';
  const body = fm[2] || '';
  const am = /(?:^|\s)action\s*=\s*["']([^"']+)["']/i.exec(attrs);
  const action = absolutize(am ? am[1] : '', pageUrl || 'https://rapidgator.net/');
  if (!action || !isAllowedHost(new URL(action).hostname)) return null;
  const fields = {};
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(body)) !== null) {
    const tag = m[1] || '';
    const nm = /(?:^|\s)name\s*=\s*["']([^"']+)["']/i.exec(tag);
    const vm = /(?:^|\s)value\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!nm) continue;
    if (/(?:^|\s)type\s*=\s*["'](?:submit|button|reset|image)["']/i.test(tag)) continue;
    if (/(?:^|\s)type\s*=\s*["']checkbox["']/i.test(tag) && !/(?:^|\s)checked/i.test(tag)) continue;
    fields[nm[1]] = vm ? vm[1].replace(/&amp;/g, '&') : '';
  }
  const hasDownloadHint = /download|dl|free|premium|get/i.test(attrs + body);
  if (!hasDownloadHint && !Object.keys(fields).length) return null;
  return { action, fields };
}

/**
 * What the file page is actually telling us. Pure function — the single place
 * that recognises wait / captcha / premium-only / removed / limit pages, so
 * the resolver never tries to bypass any of them.
 *
 * @returns {{ kind:'ready'|'wait'|'captcha'|'premium-only'|'not-found'|'traffic-limit'|'free-limit',
 *   waitSeconds:number, requiresCredentials:boolean, message:string|null }}
 */
function detectFileHostPageState(html) {
  const src = String(html || '');
  const text = textOf(src);

  const waitSeconds = extractWaitSeconds(src, text);

  if (/file\s*(?:was|has been|is)?\s*(?:not\s*found|removed|deleted)|not\s*found\s*\(?404|404\s*not\s*found|this\s*file\s*(?:does\s*not\s*exist|is\s*no\s*longer)|file\s*is\s*(?:unavailable|not\s*available\s*for\s*download)|no\s*such\s*file/i.test(text)) {
    return { kind: 'not-found', waitSeconds: 0, requiresCredentials: false, message: 'This Rapidgator file is not available — it was removed, or the link is wrong.' };
  }
  if (/file\s*not\s*available\s*for\s*free\s*users|not\s*available\s*for\s*free|only\s*(?:available\s*)?for\s*premium|premium\s*(?:account|access|membership)?\s*(?:is\s*)?required|available\s*only\s*for\s*premium|files?\s*larger\s*than\s*\d+\s*(?:mb|gb).{0,40}premium/i.test(text)) {
    return { kind: 'premium-only', waitSeconds: 0, requiresCredentials: true, message: 'This Rapidgator file is not available for free users.' };
  }
  if (/traffic\s*limit|you\s*(?:have\s*)?(?:reached|exceeded)\s*(?:your\s*)?(?:daily\s*)?traffic|not\s*enough\s*traffic|limit\s*of\s*traffic/i.test(text)) {
    return { kind: 'traffic-limit', waitSeconds: 0, requiresCredentials: false, message: 'Rapidgator says your traffic limit is reached.' };
  }
  if (/download\s*limit\s*for\s*free\s*users(?:\s*is)?\s*exceeded|free\s*(?:user\s*)?(?:download\s*)?limit|you\s*(?:have\s*)?exceeded\s*(?:the\s*)?(?:download\s*)?limit|limit\s*exceeded|maximum\s*download\s*sessions|you\s*have\s*reached\s*(?:the\s*)?limit/i.test(text)) {
    return { kind: 'free-limit', waitSeconds: 0, requiresCredentials: false, message: 'Rapidgator says the download limit for free users is exceeded.' };
  }
  if (/captcha|recaptcha|hcaptcha|are\s*you\s*a\s*(?:human|robot)|enter\s*the\s*(?:code|symbols)/i.test(text)) {
    return { kind: 'captcha', waitSeconds: waitSeconds || DEFAULT_WAIT_SECONDS, requiresCredentials: true, message: 'This Rapidgator link is behind a captcha.' };
  }
  if (/please\s*wait|you\s*(?:must|have\s*to)\s*wait|wait\s*\d+\s*seconds|free\s*download|downloading\s*is\s*(?:only\s*)?available|timer|countdown|you\s*can\s*download\s*(?:the\s*)?next\s*file/i.test(text) || waitSeconds > 0) {
    return { kind: 'wait', waitSeconds: waitSeconds || DEFAULT_WAIT_SECONDS, requiresCredentials: true, message: 'Rapidgator free downloads require a wait before the link is issued.' };
  }
  return { kind: 'ready', waitSeconds: 0, requiresCredentials: false, message: null };
}

function extractWaitSeconds(src, text) {
  const patterns = [
    /wait\s*(?:for\s*)?(\d{1,4})\s*(?:seconds?|sec|s\b)/i,
    /(\d{1,4})\s*(?:seconds?|sec\b)\s*(?:before|until|to\s*wait|left|remaining)/i,
    /(?:data-(?:timer|wait|seconds|time)|timer|countdown)\s*["'=:>\s]{1,4}(\d{1,4})/i,
    /var\s+(?:sec|secs|seconds?|timer|wait\w*|countdown)\s*=\s*(\d{1,4})/i,
    /id=["'](?:timer|wait\w*|countdown)["'][^>]*>\s*(\d{1,4})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(src) || re.exec(text);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < 86400) return n;
    }
  }
  return 0;
}

/**
 * Real file name from the page (never a hostname): the file-name element,
 * <h1>, then <title>. Pure function.
 */
function extractFileTitle(html) {
  const src = String(html || '');
  const clean = (raw) => {
    let s = textOf(raw).replace(/\s+/g, ' ').trim();
    if (!s) return null;
    s = s.replace(/^download\s+(?:file\s+)?/i, '').trim();
    s = s.replace(/\s*\(\s*\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB|TB)\s*\)\s*$/i, '').trim();
    s = s.replace(/\s*[-|–—:|]\s*[\w.-]*rapidgator[\w.-]*\s*$/i, '').trim();
    s = s.replace(/\s*[-|–—:|]\s*[\w.-]*rg\.to\s*$/i, '').trim();
    s = s.replace(/\s*[-|–—:|]\s*\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB|TB)\s*$/i, '').trim();
    if (!s) return null;
    const low = s.toLowerCase();
    if (/^(download|downloads|file|files|home|login|rapidgator|rg\.to|rapidgator\.net)$/.test(low)) return null;
    // A file name ("Movie.2024.mkv") legitimately looks like a hostname, so
    // only run the page-title cleaner on names that are NOT file-shaped.
    if (/\.[A-Za-z0-9]{1,6}$/.test(s)) return s.slice(0, 160);
    const t = cleanPageTitle(s, 'rapidgator.net');
    return (t || s).slice(0, 160);
  };

  let m = /<(?:h1|h2|div|span|strong|b|td|p)\b[^>]*(?:class|id)=["'][^"']*(?:file[-_]?name|filename|file[-_]?title|name[-_]?file)[^"']*["'][^>]*>([\s\S]{1,300}?)<\//i.exec(src);
  if (m) { const t = clean(m[1]); if (t) return t; }
  m = /<h1[^>]*>([\s\S]{1,300}?)<\/h1\s*>/i.exec(src);
  if (m) { const t = clean(m[1]); if (t) return t; }
  m = /<meta[^>]+(?:property|name)=["'](?:og:title|title)["'][^>]*content=["']([^"']{2,300})["']/i.exec(src);
  if (m) { const t = clean(m[1]); if (t) return t; }
  m = /<title[^>]*>([^<]{2,300})<\/title\s*>/i.exec(src);
  if (m) { const t = clean(m[1]); if (t) return t; }
  return null;
}

/** File size in bytes advertised on the page, or null. Pure function. */
function extractFileSize(html) {
  const text = textOf(html);
  let m = /(?:file\s*size|size|размер)\s*[:<\s]{0,6}(\d+(?:[.,]\d+)?)\s*(KB|MB|GB|TB|B)\b/i.exec(text);
  if (!m) m = /(\d+(?:[.,]\d+)?)\s*(KB|MB|GB|TB)\b/i.exec(text);
  if (!m) return null;
  const n = parseFloat(String(m[1]).replace(',', '.'));
  if (!isFinite(n)) return null;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[String(m[2]).toLowerCase()] || 1;
  return Math.round(n * mult);
}

// ── Rapidgator API (premium / session) ──────────────────────────────────────

/**
 * Every intentional failure goes through here: the message is already
 * human-readable, so resolveFileHost rethrows it untouched (a raw TypeError
 * from a bug is the only thing that ever gets wrapped).
 */
function fail(message, opts) {
  const e = new Error(String(message));
  e.readable = true;
  if (opts && opts.fatal === false) e.fatal = false;
  if (opts && opts.code) e.code = opts.code;
  return e;
}

function readJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(String(text)); } catch (e) { return null; }
}

function apiMessage(json, status) {
  const j = json || {};
  const parts = [];
  const push = (v) => { if (v && typeof v === 'string' && !parts.includes(v)) parts.push(v); };
  push(j.details);
  push(j.message);
  push(j.error);
  push(j.status_text);
  if (j.response && typeof j.response === 'object') {
    push(j.response.message);
    push(j.response.details);
    push(j.response.error);
  }
  if (!parts.length && status) parts.push(`Rapidgator API returned status ${status}.`);
  return parts.join(' ');
}

/**
 * Pull `response.token` out of a `POST /api/user/login` envelope.
 * Throws with Rapidgator's own message on a 401/403/other error envelope.
 * Pure (no network) — takes the already-fetched response body.
 */
function extractApiToken(text) {
  const json = readJson(text);
  if (!json) throw fail('Rapidgator returned an unreadable response from its login API.');
  const status = parseInt(json.status != null ? json.status : (json.response && json.response.status), 10);
  if (status && status !== 200) {
    if (status === 401) throw fail(`Rapidgator rejected the login or password (${apiMessage(json, status) || '401'}). Check them in Settings › File hosts.`);
    if (status === 403) throw fail(`Rapidgator denied access to this account (${apiMessage(json, status) || '403'}).`);
    throw fail(`Rapidgator login failed: ${apiMessage(json, status)}`);
  }
  const token = json.response && (json.response.token || json.response.session_id || json.response.sid);
  if (!token) throw fail(`Rapidgator did not return a session token (${apiMessage(json, status) || 'empty response'}).`);
  return String(token);
}

/**
 * Pull `response.download_url` out of a `GET /api/file/download` envelope.
 * Rejects off-allowlist URLs so a rogue response can never turn this into an
 * open fetcher. Pure (no network).
 */
function extractApiDownloadUrl(json) {
  const parsed = readJson(json);
  if (!parsed) {
    // Tolerate a raw body that only carries the URL (defensive, never thrown at
    // the user as JSON noise).
    const m = /"download_url"\s*:\s*"([^"]+)"/i.exec(String(json || ''));
    if (!m) throw fail('Rapidgator returned an unreadable response from its download API.');
    return validateDirectUrl(m[1].replace(/\\\//g, '/'));
  }
  const status = parseInt(parsed.status != null ? parsed.status : (parsed.response && parsed.response.status), 10);
  if (status && status !== 200) {
    const msg = apiMessage(parsed, status);
    if (status === 401) throw fail(`Rapidgator says the session expired or the login is wrong — ${msg || '401'}. Update it in Settings › File hosts.`);
    if (status === 403) throw fail(`Rapidgator denied this download: ${msg || '403'}.`);
    if (status === 404) throw fail('This Rapidgator file is not available — it was removed, or the link is wrong.');
    throw fail(`Rapidgator could not issue a download link: ${msg || status}`);
  }
  const res = parsed.response || {};
  const url = res.download_url || res.url || res.download || res.link;
  if (!url || typeof url !== 'string') {
    throw fail(`Rapidgator did not return a download URL (${apiMessage(parsed, status) || 'empty response'}).`);
  }
  return validateDirectUrl(url);
}

function validateDirectUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) {
    throw fail('Rapidgator returned an invalid download URL.');
  }
  if (!isAllowedHost(u.hostname)) {
    throw fail(`File-host resolver refuses to fetch off-allowlist host: ${u.hostname}`);
  }
  return u.href;
}

// ── Fetching (allowlisted, capped, redirect-limited) ────────────────────────

function cookieHeader(creds) {
  const c = creds && creds.cookie;
  if (!c) return null;
  if (typeof c === 'string') return c.trim() || null;
  if (typeof c === 'object') {
    return Object.keys(c).map((k) => `${k}=${c[k]}`).join('; ') || null;
  }
  return null;
}

function baseHeaders(creds) {
  const h = {
    'User-Agent': CHROME_UA,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const cookie = cookieHeader(creds);
  if (cookie) h.Cookie = cookie;
  return h;
}

/**
 * Default network fetch. Capped body, allowlisted hosts, max 3 redirects and
 * only inside the Rapidgator host family.
 * @returns {Promise<{status:number, headers:object, text:string, finalUrl:string}>}
 */
function fetchFileHostUrl(url, opts) {
  const o = opts || {};
  const method = (o.method || 'GET').toUpperCase();
  const headers = Object.assign({}, o.headers || {});
  const timeoutMs = o.timeoutMs || 20000;
  const redirectCount = o.redirectCount || 0;
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      reject(fail('Too many redirects while resolving this Rapidgator link'));
      return;
    }
    let u;
    try { u = new URL(String(url)); } catch (e) { reject(fail('Invalid URL while resolving this Rapidgator link')); return; }
    if (!isAllowedHost(u.hostname)) {
      reject(fail(`File-host resolver refuses to fetch off-allowlist host: ${u.hostname}`));
      return;
    }
    const client = u.protocol === 'https:' ? https : http;
    let req;
    try {
      req = client.request({
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers: Object.assign({ 'Content-Length': o.body ? Buffer.byteLength(o.body) : undefined }, headers),
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers && res.headers.location) {
          res.resume();
          let target;
          try { target = new URL(res.headers.location, u.href); } catch (e) { reject(fail('Invalid redirect while resolving this Rapidgator link')); return; }
          if (!isAllowedHost(target.hostname) || !sameHostFamily(target.hostname, u.hostname)) {
            reject(fail('Rapidgator link redirected to an unexpected host'));
            return;
          }
          resolve(fetchFileHostUrl(target.href, {
            method: 'GET', headers, timeoutMs, redirectCount: redirectCount + 1,
          }));
          return;
        }
        const chunks = [];
        let bytes = 0;
        let capped = false;
        res.on('data', (c) => {
          if (capped) return;
          bytes += c.length;
          if (bytes > MAX_BODY_BYTES) {
            capped = true;
            try { req.destroy(); } catch (e) { /* already gone */ }
            reject(fail('Rapidgator page too large to resolve'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (capped) return;
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            text: Buffer.concat(chunks).toString('utf8'),
            finalUrl: u.href,
          });
        });
        res.on('error', (e) => reject(fail(`Could not read the Rapidgator response (${e && e.message ? e.message : 'network error'})`, { fatal: false })));
      });
    } catch (e) {
      reject(fail(`Could not open a request to Rapidgator (${e && e.message ? e.message : 'network error'})`, { fatal: false }));
      return;
    }
    req.on('error', (e) => reject(fail(`Could not reach Rapidgator (${e && e.message ? e.message : 'network error'})`, { fatal: false })));
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) { /* already gone */ }
      reject(fail('The Rapidgator request timed out', { fatal: false }));
    });
    if (o.body) req.write(o.body);
    req.end();
  });
}

// ── Credentials ─────────────────────────────────────────────────────────────

function normalizeCredentials(credentials, cookie) {
  const c = (credentials && typeof credentials === 'object') ? credentials : {};
  const user = String(c.user || c.username || c.login || c.email || '').trim();
  const password = String(c.password || c.pass || '').trim();
  const ck = String((c.cookie != null ? c.cookie : cookie) || '').trim();
  return {
    user: user || null,
    password: password || null,
    cookie: ck || null,
    hasUserPass: !!(user && password),
    hasSession: !!(ck || (user && password)),
  };
}

function safeFileName(name, fallback) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.+/g, '.').replace(/^\.+/, '');
  s = s.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!s || /^(\.|_)+$/.test(s)) s = fallback;
  return s;
}

function extOf(urlOrName) {
  const m = /\.([A-Za-z0-9]{1,8})(?:[?#]|$)/.exec(String(urlOrName || '').split('/').pop() || '');
  return m ? m[1].toLowerCase() : '';
}

const MIME_BY_EXT = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', m4v: 'video/x-m4v', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', zip: 'application/zip',
  rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', tar: 'application/x-tar',
  gz: 'application/gzip', pdf: 'application/pdf', iso: 'application/x-iso9660-image',
  exe: 'application/octet-stream', msi: 'application/octet-stream', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', txt: 'text/plain',
  srt: 'application/x-subrip', nfo: 'text/plain',
};

function mimeFor(name, url) {
  const ext = extOf(name) || extOf(url);
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// ── Result assembly ─────────────────────────────────────────────────────────

function buildResult(opts) {
  const parsed = opts.parsed || {};
  const pageUrl = opts.pageUrl || parsed.pageUrl || 'https://rapidgator.net/';
  const directUrl = opts.url;
  const fallbackName = parsed.fileName || `rapidgator-${parsed.fileId || 'file'}`;
  const rawTitle = opts.title || parsed.fileName || (parsed.fileId ? `Rapidgator file ${parsed.fileId}` : 'Rapidgator file');
  const title = safeFileName(rawTitle, 'Rapidgator file');
  const filename = safeFileName(opts.filename || parsed.fileName || title, fallbackName);
  const size = (typeof opts.size === 'number' && opts.size > 0) ? opts.size : null;

  // Replay headers — the download itself must look like it came from the page.
  const headers = {
    Referer: pageUrl,
    'User-Agent': CHROME_UA,
  };
  if (opts.cookie) headers.Cookie = opts.cookie;

  const media = [{
    type: 'file',
    url: directUrl,
    mime: mimeFor(filename, directUrl),
    filename,
    size,
    width: 0,
    height: 0,
    headers,
    // Rapidgator rejects Range and corrupts parallel segments.
    singleConnection: true,
    resumable: false,
  }];

  const pickerVideos = [{
    url: directUrl,
    quality: 'file',
    resolution: null,
    size,
    format: extOf(filename) || 'file',
    filename,
    provider: 'rapidgator',
    headers,
    singleConnection: true,
    resumable: false,
    pageUrl,
  }];

  return {
    provider: 'rapidgator',
    id: parsed.fileId || null,
    title,
    filename,
    size,
    thumbnail: null,
    duration: 0,
    canonicalUrl: pageUrl,
    referer: pageUrl,
    media,
    pickerVideos,
    requiresCredentials: false,
    waitSeconds: 0,
  };
}

function waitResult(opts) {
  const parsed = opts.parsed || {};
  const pageUrl = opts.pageUrl || parsed.pageUrl || 'https://rapidgator.net/';
  const title = safeFileName(opts.title || parsed.fileName || (parsed.fileId ? `Rapidgator file ${parsed.fileId}` : 'Rapidgator file'), 'Rapidgator file');
  return {
    provider: 'rapidgator',
    id: parsed.fileId || null,
    title,
    filename: title,
    size: (typeof opts.size === 'number' && opts.size > 0) ? opts.size : null,
    thumbnail: null,
    duration: 0,
    canonicalUrl: pageUrl,
    referer: pageUrl,
    media: [],
    pickerVideos: [],
    requiresCredentials: true,
    waitSeconds: opts.waitSeconds || 0,
    blocked: opts.blocked || 'wait',
    // Human-readable hint: a premium account or a session cookie removes it.
    hint: WAIT_HINT,
    error: WAIT_HINT,
  };
}

// ── resolveFileHost ─────────────────────────────────────────────────────────

async function apiLogin(fetchImpl, creds) {
  const body = `login=${encodeURIComponent(creds.user)}&password=${encodeURIComponent(creds.password)}`;
  const res = await fetchImpl(HOSTS.rapidgator.api.login, {
    method: 'POST',
    headers: Object.assign(baseHeaders(creds), {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/plain, */*',
    }),
    body,
  });
  if (!res || typeof res.text !== 'string') throw fail('Rapidgator returned an empty response from its login API.');
  return extractApiToken(res.text);
}

async function apiDownloadUrl(fetchImpl, fileId, token, creds) {
  const url = `${HOSTS.rapidgator.api.download}?file_id=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: Object.assign(baseHeaders(creds), { Accept: 'application/json, text/plain, */*' }),
  });
  if (!res || res.text == null) throw fail('Rapidgator returned an empty response from its download API.');
  return extractApiDownloadUrl(res.text);
}

/**
 * Resolve a Rapidgator link into one direct file URL.
 *
 * @param {string} input
 * @param {{ credentials?:{user?:string,password?:string,cookie?:string},
 *           cookie?:string, fetchImpl?:Function, onWait?:Function }} [opts]
 * @returns {Promise<Result>} never rejects with a non-Error / opaque value:
 *   every failure is an `Error` with human-readable text.
 */
async function resolveFileHost(input, opts) {
  const o = opts || {};
  const parsed = parseFileHostUrl(input);
  if (!parsed) {
    throw fail('Not a supported file-host link — AiDM resolves Rapidgator links (rapidgator.net / rg.to) only.');
  }

  const fetchImpl = (typeof o.fetchImpl === 'function') ? o.fetchImpl : fetchFileHostUrl;
  const creds = normalizeCredentials(o.credentials, o.cookie);
  const headers = baseHeaders(creds);

  try {
    // ── Premium / logged-in session: use the API (no wait, no captcha) ─────
    if (creds.hasUserPass && /^\d+$/.test(parsed.fileId)) {
      let token;
      try {
        token = await apiLogin(fetchImpl, creds);
      } catch (e) {
        if (e && e.fatal === false) throw e;
        throw fail(`Rapidgator login failed — ${e && e.message ? e.message : 'unknown error'}`);
      }
      let direct;
      try {
        direct = await apiDownloadUrl(fetchImpl, parsed.fileId, token, creds);
      } catch (e) {
        if (e && e.fatal === false) throw e;
        throw fail(e && e.message ? e.message : 'Rapidgator could not issue a download link.');
      }
      return buildResult({
        parsed,
        pageUrl: parsed.pageUrl,
        url: direct,
        title: parsed.fileName,
        filename: parsed.fileName,
        size: null,
        cookie: creds.cookie,
      });
    }

    // ── Page flow (cookie session, or anonymous) ──────────────────────────
    let cursorUrl = parsed.pageUrl;
    let cursorText = '';
    let pageTitle = null;
    let pageSize = null;

    for (let hop = 0; hop <= 2; hop++) {
      const res = await fetchImpl(cursorUrl, { method: 'GET', headers });
      if (!res || typeof res.text !== 'string') {
        throw fail('Rapidgator returned an empty page for this link.');
      }
      cursorText = res.text;
      const landed = (res.finalUrl && isAllowedHost(new URL(res.finalUrl).hostname)) ? res.finalUrl : cursorUrl;

      // A short /download link may redirect straight at the file's bytes.
      if (hop > 0 && looksLikeDirectFile(landed)) {
        return buildResult({
          parsed, pageUrl: parsed.pageUrl, url: landed,
          title: pageTitle || parsed.fileName, filename: parsed.fileName,
          size: pageSize, cookie: creds.cookie,
        });
      }

      const state = detectFileHostPageState(cursorText);
      if (!pageTitle) pageTitle = extractFileTitle(cursorText);
      if (pageSize == null) pageSize = extractFileSize(cursorText);

      if (state.kind === 'not-found') throw fail(state.message || 'This Rapidgator file is not available — it was removed, or the link is wrong.');
      if (state.kind === 'premium-only') {
        throw fail(`${state.message || 'This Rapidgator file is not available for free users.'} ${WAIT_HINT}`);
      }
      if (state.kind === 'traffic-limit') throw fail(`${state.message || 'Rapidgator says your traffic limit is reached.'} Wait for it to reset, or use a premium account.`);
      if (state.kind === 'free-limit') throw fail(`${state.message || 'Rapidgator says the download limit for free users is exceeded.'} ${WAIT_HINT}`);

      // Download link, or a POST form that issues one. A real link wins over
      // any wait wording on the page (a premium/cookie session sees both).
      let next = extractDownloadUrlFromPage(cursorText, landed);
      if (!next) {
        const form = extractDownloadForm(cursorText, landed);
        if (form) {
          const body = Object.keys(form.fields || {})
            .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(form.fields[k])}`)
            .join('&');
          const posted = await fetchImpl(form.action, {
            method: 'POST',
            headers: Object.assign({}, headers, { 'Content-Type': 'application/x-www-form-urlencoded' }),
            body,
          });
          const postedUrl = (posted && posted.finalUrl && isAllowedHost(new URL(posted.finalUrl).hostname)) ? posted.finalUrl : form.action;
          if (looksLikeDirectFile(postedUrl)) {
            next = postedUrl;
          } else if (posted && typeof posted.text === 'string') {
            const postedState = detectFileHostPageState(posted.text);
            if (!pageTitle) pageTitle = extractFileTitle(posted.text);
            if (postedState.kind === 'wait' || postedState.kind === 'captcha') {
              const waitSeconds = postedState.waitSeconds > 0 ? postedState.waitSeconds : DEFAULT_WAIT_SECONDS;
              const result = waitResult({ parsed, pageUrl: parsed.pageUrl, waitSeconds, blocked: postedState.kind, title: pageTitle, size: pageSize });
              if (typeof o.onWait === 'function') {
                try { o.onWait({ waitSeconds, hint: WAIT_HINT, result }); } catch (e) { /* noop */ }
              }
              return result;
            }
            next = extractDownloadUrlFromPage(posted.text, postedUrl) || postedUrl;
          }
        }
      }
      if (!next) {
        // No link at all — this is where a free user's wait/captcha shows up.
        if (state.kind === 'wait' || state.kind === 'captcha') {
          const waitSeconds = state.waitSeconds > 0 ? state.waitSeconds : DEFAULT_WAIT_SECONDS;
          const result = waitResult({
            parsed, pageUrl: parsed.pageUrl, waitSeconds,
            blocked: state.kind, title: pageTitle, size: pageSize,
          });
          if (typeof o.onWait === 'function') {
            try { o.onWait({ waitSeconds, hint: WAIT_HINT, result }); } catch (e) { /* callback must never break the resolve */ }
          }
          return result;
        }
        break;
      }

      if (looksLikeDirectFile(next)) {
        return buildResult({
          parsed, pageUrl: parsed.pageUrl, url: next,
          title: pageTitle || parsed.fileName, filename: parsed.fileName || nameFromUrl(next) || pageTitle,
          size: pageSize, cookie: creds.cookie,
        });
      }
      // Another HTML hop (e.g. /download/<hash> → the real link).
      if (next === cursorUrl || next === landed) break;
      cursorUrl = next;
    }

    throw fail(`Rapidgator did not offer a download link for this file. ${WAIT_HINT}`);
  } catch (e) {
    // Already human-readable (every intentional failure is): rethrow as-is.
    // Anything else is a bug — never let a raw TypeError reach the main process.
    if (e instanceof Error && e.readable) throw e;
    throw fail(`Could not resolve this Rapidgator link (${e && e.message ? e.message : 'unknown error'}).`);
  }
}

function nameFromUrl(url) {
  try {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean);
    const base = decodeURIComponent(parts.pop() || '');
    if (!base || !/\.[A-Za-z0-9]{1,8}$/.test(base)) return null;
    return base.slice(0, 160);
  } catch (e) {
    return null;
  }
}

// ── Picker payload ──────────────────────────────────────────────────────────

/**
 * Convert a resolve result into the shape the UI's quality picker expects
 * (single source of truth — mirrors the other resolvers' toPickerVideos).
 * Accepts a Result, a media[] array or a videos[] array.
 */
function toPickerVideos(result) {
  const list = Array.isArray(result)
    ? result
    : ((result && Array.isArray(result.pickerVideos) && result.pickerVideos.length)
      ? result.pickerVideos
      : ((result && Array.isArray(result.media)) ? result.media : []));

  return list.filter(Boolean).map((v) => ({
    url: v.url,
    quality: v.quality || 'file',
    resolution: v.resolution || null,
    size: (typeof v.size === 'number' ? v.size : null),
    format: v.format || extOf(v.filename || v.url) || 'file',
    filename: v.filename || nameFromUrl(v.url) || 'file',
    provider: v.provider || 'rapidgator',
    headers: v.headers || null,
    singleConnection: true,
    resumable: false,
    pageUrl: v.pageUrl || (result && result.canonicalUrl) || null,
  }));
}

// ── Resolver adapter for src/resolvers.js ───────────────────────────────────

const fileHostMediaResolver = {
  name: 'filehost',

  supports(url) {
    try { return isFileHostUrl(url); } catch (e) { return false; }
  },

  async resolve(url, opts) {
    const r = await resolveFileHost(url, opts || {});
    if (r && r.waitSeconds > 0 && (!r.media || !r.media.length)) {
      // Nothing downloadable yet: surface the wait instead of a silent row.
      return r;
    }
    return r;
  },
};

module.exports = {
  isFileHostUrl,
  parseFileHostUrl,
  resolveFileHost,
  toPickerVideos,
  fileHostMediaResolver,
  HOSTS,

  // Pure, network-free surface (unit-testable).
  isAllowedHost,
  extractDownloadUrlFromPage,
  extractDownloadForm,
  extractApiDownloadUrl,
  extractApiToken,
  detectFileHostPageState,
  extractWaitSeconds,
  extractFileTitle,
  extractFileSize,
  looksLikeDirectFile,
  validateDirectUrl,
  normalizeCredentials,
  fetchFileHostUrl,

  CHROME_UA,
  WAIT_HINT,
};
