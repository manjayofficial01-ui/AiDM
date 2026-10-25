// @ts-check
'use strict';

/**
 * Recursive site grabber ("download every file on this site").
 *
 * This is the feature IDM and FDM both treat as a headline capability and AiDM
 * never had: point it at a page, it walks the site and hands back every link
 * that points at a real file. It does not download anything itself — it
 * returns URLs, and the caller queues them through the normal
 * `addDownload()` door, so every row gets the usual engine, checksum, category
 * and folder handling.
 *
 * Boundaries, all deliberate:
 *   - Never CRAWLS off-site pages: following cross-origin links turns a grab
 *     into an open-ended crawl of the internet. Off-site links that point
 *     straight at a file ARE collected and flagged `crossOrigin`, because that
 *     is how most sites actually serve downloads (CDN, GitHub releases, mirrors)
 *     — refusing them would miss the main use case.
 *   - robots.txt is honoured by default. A grabber that ignores it is a
 *     scraper, and this is a download manager.
 *   - Hard caps on pages, depth, files and wall-clock time, so a hostile or
 *     accidentally self-linking site cannot pin the process.
 *   - A polite delay between requests, and only `text/html` bodies are parsed.
 *   - No writes, no execution, no HTML-to-DOM parsing: links are extracted with
 *     a bounded regex, which cannot be tricked into running script.
 *
 * The network call is injectable so the whole crawl can be tested against a
 * local server (and in-process fakes) without touching the internet.
 */

const DEFAULT_EXTENSIONS = [
  // archives
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso',
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'csv', 'rtf',
  // media
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'mp3', 'flac', 'm4a', 'wav', 'ogg', 'opus',
  // software
  'exe', 'msi', 'apk', 'dmg', 'deb', 'rpm',
];

const LIMITS = {
  maxPages: 25,
  maxDepth: 2,
  maxFiles: 500,
  timeBudgetMs: 60000,
  delayMs: 120,
  maxPageBytes: 2 * 1024 * 1024,
};

const SKIP_SCHEMES = /^(javascript|mailto|tel|data|blob|about|chrome|file):/i;

// ── Link extraction ─────────────────────────────────────────────────────────

/** Decode the handful of entities that actually appear inside href attributes. */
function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2f;/gi, '/');
}

/**
 * Extract every candidate link from an HTML document.
 *
 * `href` on anchors/areas/link tags, `src` on media/script tags. Deliberately
 * no `onclick`/inline JS handling and no DOM construction.
 *
 * @param {string} html
 * @param {string} baseUrl absolute URL used to resolve relative links
 * @returns {{ url: string, kind: 'page'|'asset' }[]}
 */
function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  if (typeof html !== 'string' || !html) return out;

  let base;
  try { base = new URL(baseUrl); } catch (e) { return out; }

  /** @type {{ re: RegExp, kind: 'page'|'asset' }[]} */
  const patterns = [
    { re: /<(?:a|area|link)\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, kind: 'page' },
    { re: /<(?:img|source|video|audio|embed|track|iframe|script)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, kind: 'asset' },
  ];

  for (const { re, kind } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = decodeEntities((m[1] || m[2] || m[3] || '').trim());
      if (!raw) continue;
      if (SKIP_SCHEMES.test(raw)) continue;
      if (raw.startsWith('#')) continue;
      let abs;
      try { abs = new URL(raw, base); } catch (e) { continue; }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
      abs.hash = '';
      const url = abs.toString();
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, kind });
    }
  }
  return out;
}

/**
 * Does this URL's path end in one of the wanted extensions?
 * Query strings are ignored (`file.zip?token=1` is still a zip).
 * @param {string} url
 * @param {Set<string>} extensions lowercase, no leading dot
 */
function hasWantedExtension(url, extensions) {
  let pathname;
  try { pathname = new URL(url).pathname; } catch (e) { return false; }
  const name = pathname.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return extensions.has(name.slice(dot + 1).toLowerCase());
}

// ── robots.txt ──────────────────────────────────────────────────────────────

/**
 * Parse robots.txt into rules that apply to us (`*` group plus any group whose
 * user-agent token appears in `agentName`).
 * @param {string} text
 * @param {string} [agentName]
 * @returns {{ allow: boolean, pattern: string, re: RegExp }[]}
 */
function parseRobots(text, agentName = 'aidm') {
  const rules = [];
  let applies = false;
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (const line of lines) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const idx = clean.indexOf(':');
    if (idx < 0) continue;
    const field = clean.slice(0, idx).trim().toLowerCase();
    const value = clean.slice(idx + 1).trim();
    if (field === 'user-agent') {
      const token = value.toLowerCase();
      applies = token === '*' || (!!token && agentName.toLowerCase().includes(token));
      continue;
    }
    if (!applies) continue;
    if (field !== 'allow' && field !== 'disallow') continue;
    // `Disallow:` with no value means "allow everything" — skip it.
    if (!value) continue;
    rules.push({ allow: field === 'allow', pattern: value, re: patternToRegex(value) });
  }
  return rules;
}

/**
 * Turn a robots pattern into an anchored regex.
 * `*` matches any run of characters, and a trailing `$` anchors the end
 * (a `$` anywhere else is literal, per the spec).
 * @param {string} pattern
 */
function patternToRegex(pattern) {
  let body = String(pattern);
  const endAnchored = body.endsWith('$');
  if (endAnchored) body = body.slice(0, -1);
  const escaped = body
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (endAnchored ? '$' : ''));
}

/**
 * Standard resolution: the longest matching pattern wins; `Allow` wins a tie.
 * @param {{ allow: boolean, pattern: string, re: RegExp }[]} rules
 * @param {string} pathname
 * @returns {boolean} true when the path may be fetched
 */
function robotsAllows(rules, pathname) {
  if (!Array.isArray(rules) || !rules.length) return true;
  const path = String(pathname || '/');
  let best = null;
  for (const rule of rules) {
    if (!rule.re.test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

// ── Crawl ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GrabResult
 * @property {boolean} ok
 * @property {string} startUrl
 * @property {string} origin
 * @property {{ url: string, depth: number, kind: 'page'|'asset', crossOrigin: boolean }[]} files
 * @property {string[]} pages   pages actually fetched
 * @property {{ url: string, reason: string }[]} skipped
 * @property {boolean} truncated  a cap or the time budget stopped the crawl
 * @property {string} [reason]    why nothing was found, when `ok` is false
 * @property {number} elapsedMs
 */

/**
 * Crawl a site and collect downloadable file URLs.
 *
 * @param {string} startUrl
 * @param {{
 *   maxPages?: number, maxDepth?: number, maxFiles?: number, timeBudgetMs?: number,
 *   delayMs?: number, extensions?: string[]|Set<string>, respectRobots?: boolean,
 *   fetchImpl?: (url: string, init?: any) => Promise<any>,
 *   sleep?: (ms: number) => Promise<void>,
 *   onProgress?: (p: { pages: number, files: number, currentUrl: string }) => void,
 * }} [opts]
 * @returns {Promise<GrabResult>}
 */
async function grabSite(startUrl, opts = {}) {
  const startedAt = Date.now();
  /** @type {GrabResult} */
  const result = {
    ok: false, startUrl: String(startUrl || ''), origin: '',
    files: [], pages: [], skipped: [], truncated: false, elapsedMs: 0,
  };

  let start;
  try { start = new URL(startUrl); } catch (e) {
    result.reason = 'invalid-url';
    return result;
  }
  if (start.protocol !== 'http:' && start.protocol !== 'https:') {
    result.reason = 'unsupported-protocol';
    return result;
  }
  start.hash = '';
  result.origin = start.origin;

  const maxPages = clamp(opts.maxPages, LIMITS.maxPages, 1, 500);
  const maxDepth = clamp(opts.maxDepth, LIMITS.maxDepth, 0, 8);
  const maxFiles = clamp(opts.maxFiles, LIMITS.maxFiles, 1, 5000);
  const timeBudgetMs = clamp(opts.timeBudgetMs, LIMITS.timeBudgetMs, 1000, 600000);
  const delayMs = clamp(opts.delayMs, LIMITS.delayMs, 0, 10000);
  const respectRobots = opts.respectRobots !== false;
  const extensions = toExtensionSet(opts.extensions);

  const fetchImpl = opts.fetchImpl || defaultFetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // robots.txt once per origin.
  let rules = [];
  if (respectRobots) {
    try {
      const res = await fetchImpl(start.origin + '/robots.txt', {
        headers: { 'User-Agent': USER_AGENT }, timeoutMs: 8000,
      });
      if (res && res.ok && res.status === 200) {
        const body = await readLimited(res, LIMITS.maxPageBytes);
        rules = parseRobots(body);
      }
    } catch (e) { /* no robots.txt, or unreachable → crawl normally */ }
  }

  /** @type {{ url: string, depth: number }[]} */
  const queue = [{ url: start.toString(), depth: 0 }];
  const seenPages = new Set([start.toString()]);
  const seenFiles = new Set();

  while (queue.length) {
    if (result.pages.length >= maxPages) { result.truncated = true; break; }
    if (Date.now() - startedAt > timeBudgetMs) { result.truncated = true; break; }
    if (result.files.length >= maxFiles) { result.truncated = true; break; }

    const { url, depth } = queue.shift();

    if (respectRobots) {
      let pathname = '/';
      try { pathname = new URL(url).pathname; } catch (e) { /* keep '/' */ }
      if (!robotsAllows(rules, pathname)) {
        result.skipped.push({ url, reason: 'robots-disallow' });
        continue;
      }
    }

    let html = '';
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, timeoutMs: 15000 });
      if (!res || !res.ok) {
        result.skipped.push({ url, reason: `http-${(res && res.status) || 'error'}` });
        continue;
      }
      const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
      if (type && !/html|xml/i.test(type)) {
        // A "page" that is really a file: keep it if the user wants the type.
        if (hasWantedExtension(url, extensions)) addFile(url, depth);
        else result.skipped.push({ url, reason: 'not-html' });
        continue;
      }
      html = await readLimited(res, LIMITS.maxPageBytes);
    } catch (e) {
      result.skipped.push({ url, reason: 'fetch-failed' });
      continue;
    }

    result.pages.push(url);
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress({ pages: result.pages.length, files: result.files.length, currentUrl: url }); } catch (e) {}
    }

    for (const link of extractLinks(html, url)) {
      if (hasWantedExtension(link.url, extensions)) { addFile(link.url, depth); continue; }
      // Follow only same-origin page links, and only within the depth budget.
      let parsed;
      try { parsed = new URL(link.url); } catch (e) { continue; }
      if (parsed.origin !== start.origin) continue;
      if (depth + 1 > maxDepth) continue;
      if (seenPages.has(link.url)) continue;
      if (queue.length + seenPages.size >= maxPages * 8) continue; // queue guard
      seenPages.add(link.url);
      queue.push({ url: link.url, depth: depth + 1 });
    }

    if (delayMs > 0 && queue.length) await sleep(delayMs);
  }

  function addFile(url, depth) {
    if (seenFiles.has(url)) return;
    if (result.files.length >= maxFiles) { result.truncated = true; return; }
    seenFiles.add(url);
    let crossOrigin = false;
    try { crossOrigin = new URL(url).origin !== start.origin; } catch (e) { /* same-origin by default */ }
    result.files.push({ url, depth, kind: 'asset', crossOrigin });
  }

  result.elapsedMs = Date.now() - startedAt;
  result.ok = result.files.length > 0;
  if (!result.ok) result.reason = result.pages.length ? 'no-matching-files' : 'no-pages-fetched';
  return result;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AiDM-SiteGrabber/1.0';

/** Default transport: the engine's own fetch (redirects, DoH, proxy, TLS). */
async function defaultFetch(url, init) {
  const { robustFetch } = require('./download-engine');
  return robustFetch(url, init);
}

/**
 * Read a response body, capped. A page larger than the cap is truncated rather
 * than rejected — links near the top are still useful.
 * @param {any} res
 * @param {number} capBytes
 * @returns {Promise<string>}
 */
async function readLimited(res, capBytes) {
  const declared = Number((res.headers && res.headers.get && res.headers.get('content-length')) || 0);
  if (declared && declared > capBytes * 4) return ''; // obviously not a link page
  const text = await res.text();
  return text.length > capBytes ? text.slice(0, capBytes) : text;
}

function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** @param {string[]|Set<string>|undefined} input */
function toExtensionSet(input) {
  if (input instanceof Set) {
    return new Set([...input].map((e) => String(e).replace(/^\./, '').toLowerCase()).filter(Boolean));
  }
  if (Array.isArray(input)) {
    const list = input.map((e) => String(e).replace(/^\./, '').toLowerCase().trim()).filter(Boolean);
    if (list.length) return new Set(list);
  }
  if (typeof input === 'string') {
    const list = input.split(/[\s,;]+/).map((e) => e.replace(/^\./, '').toLowerCase().trim()).filter(Boolean);
    if (list.length) return new Set(list);
  }
  return new Set(DEFAULT_EXTENSIONS);
}

module.exports = {
  grabSite,
  extractLinks,
  hasWantedExtension,
  parseRobots,
  robotsAllows,
  patternToRegex,
  toExtensionSet,
  decodeEntities,
  DEFAULT_EXTENSIONS,
  LIMITS,
};
