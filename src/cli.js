// @ts-check
'use strict';

/**
 * Command-line intake for AiDM.
 *
 * Every desktop download manager that people script has this: IDM ships
 * `idman /d <url>`, Motrix and Gopeed ship CLIs, AB Download Manager exposes a
 * REST `/add`. AiDM already accepts `--hidden`, but ignored URLs entirely — so
 * "Open with AiDM", a batch file, or a shell one-liner all did nothing.
 *
 * This module is deliberately PURE: it parses and validates, and returns a
 * plan. It never touches the manager, Electron, or the network — `main.js`
 * owns the dispatch. That keeps every rule below testable without booting the
 * app, and keeps URL handling in one place instead of sprinkled through
 * lifecycle code.
 *
 * Security note: an argument is only ever treated as a URL when it carries an
 * explicit scheme from `ALLOWED_SCHEMES`. Everything else is reported as
 * `unknown` rather than guessed at — a stray path or shell fragment must never
 * silently become a download.
 */

/** Schemes AiDM's own engine can act on (torrent rows included). */
const ALLOWED_SCHEMES = ['http', 'https', 'ftp', 'magnet'];

/** File extensions accepted by `--add-file`. */
const LIST_EXTENSIONS = ['.txt', '.list', '.json', '.csv'];

/** Strip one layer of surrounding quotes (Windows shells pass them through). */
function unquote(value) {
  const s = String(value == null ? '' : value).trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Is this argument a URL AiDM should download?
 * Scheme allowlist, not a heuristic — `C:\x.zip` and `foo.mp4` must NOT match.
 * @param {string} value
 */
function isAllowedUrl(value) {
  const s = unquote(value);
  if (!s || /\s/.test(s)) return false;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!m) return false;
  return ALLOWED_SCHEMES.includes(m[1].toLowerCase());
}

/**
 * Parse one URL list document (plain text or JSON) into URLs.
 * Blank lines, `#`/`;` comments and duplicates are dropped, order preserved.
 * @param {string} text
 * @param {'json'|'text'} [mode]
 * @returns {string[]}
 */
function parseUrlList(text, mode = 'text') {
  const raw = String(text == null ? '' : text);
  /** @type {unknown[]} */
  let candidates = [];
  if (mode === 'json') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) candidates = parsed;
      else if (parsed && Array.isArray(parsed.urls)) candidates = parsed.urls;
      else if (parsed && Array.isArray(parsed.downloads)) {
        candidates = parsed.downloads.map((d) => (d && typeof d === 'object' ? d.url : d));
      }
    } catch (e) {
      // Not JSON after all — fall through to line parsing.
      candidates = [];
    }
  }
  if (!candidates.length) {
    candidates = raw.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('//')) return '';
      // "url<tab>filename" style exports: keep the URL only.
      return trimmed.split(/[\t,]/)[0].trim();
    });
  }
  const seen = new Set();
  const out = [];
  for (const rawCandidate of candidates) {
    // An exported download record is an object; only its URL matters here.
    const candidate = rawCandidate && typeof rawCandidate === 'object'
      ? (/** @type {any} */ (rawCandidate).url)
      : rawCandidate;
    const u = unquote(candidate);
    if (!isAllowedUrl(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * @typedef {Object} Intake
 * @property {string[]} urls     URLs to queue, de-duplicated, order preserved
 * @property {string[]} files    list files that were read
 * @property {boolean} hidden    start without showing the window
 * @property {boolean} minimized start minimized
 * @property {boolean} version   print version and exit
 * @property {boolean} help      print usage and exit
 * @property {string[]} unknown  arguments that were recognised as neither flag, URL nor list file
 * @property {{ file: string, error: string }[]} errors unreadable list files
 */

/**
 * Parse argv into an intake plan.
 *
 * @param {string[]} argv raw arguments (no executable, no script path)
 * @param {{ existsSync?: (p: string) => boolean, readFileSync?: (p: string, enc: string) => string }} [io]
 *        injected so the parser stays pure and unit-testable
 * @returns {Intake}
 */
function parseArgs(argv, io = {}) {
  const existsSync = io.existsSync || (() => false);
  const readFileSync = io.readFileSync || (() => '');
  const args = Array.isArray(argv) ? argv : [];

  /** @type {Intake} */
  const out = {
    urls: [], files: [], hidden: false, minimized: false,
    version: false, help: false, unknown: [], errors: [],
  };
  const seenUrls = new Set();
  const pushUrl = (u) => {
    if (!u || seenUrls.has(u)) return;
    seenUrls.add(u);
    out.urls.push(u);
  };

  for (let i = 0; i < args.length; i++) {
    const rawArg = String(args[i] == null ? '' : args[i]);
    const arg = rawArg.trim();
    if (!arg) continue;

    // `--flag=value` form first, so the value is never mistaken for a URL.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq > 0 ? arg.slice(eq + 1) : null;
    const lower = flag.toLowerCase().replace(/^--?/, '');

    if (flag.startsWith('-')) {
      switch (lower) {
        case 'hidden': out.hidden = true; continue;
        case 'minimized':
        case 'minimise':
        case 'm': out.minimized = true; continue;
        case 'version':
        case 'v': out.version = true; continue;
        case 'help':
        case 'h':
        case '?': out.help = true; continue;
        case 'add-file':
        case 'addfile':
        case 'f': {
          const value = inlineValue != null ? unquote(inlineValue) : unquote(args[++i]);
          if (!value) { out.unknown.push(flag); continue; }
          if (!existsSync(value)) {
            out.errors.push({ file: value, error: 'not found' });
            continue;
          }
          try {
            const isJson = /\.json$/i.test(value);
            const text = readFileSync(value, 'utf8');
            for (const u of parseUrlList(text, isJson ? 'json' : 'text')) pushUrl(u);
            out.files.push(value);
          } catch (e) {
            out.errors.push({ file: value, error: (e && e.message) || 'read failed' });
          }
          continue;
        }
        default:
          out.unknown.push(flag);
          continue;
      }
    }

    // Positional: URL, or a list file path, or nothing we understand.
    if (isAllowedUrl(arg)) { pushUrl(unquote(arg)); continue; }
    const lowerArg = arg.toLowerCase();
    if (LIST_EXTENSIONS.some((ext) => lowerArg.endsWith(ext)) && existsSync(unquote(arg))) {
      try {
        const p = unquote(arg);
        const text = readFileSync(p, 'utf8');
        for (const u of parseUrlList(text, /\.json$/i.test(p) ? 'json' : 'text')) pushUrl(u);
        out.files.push(p);
      } catch (e) {
        out.errors.push({ file: unquote(arg), error: (e && e.message) || 'read failed' });
      }
      continue;
    }
    out.unknown.push(arg);
  }

  return out;
}

/** Usage text for `--help`. Kept short: it is read in a terminal, not a manual. */
const USAGE = [
  'AiDM — AI-powered download manager',
  '',
  'Usage:',
  '  AiDM.exe [options] [url ...]',
  '',
  'Arguments:',
  '  url                     Queue a download (http, https, ftp, magnet).',
  '                          Page URLs (YouTube/Twitter/Facebook) open the quality picker.',
  '',
  'Options:',
  '  -f, --add-file <path>   Queue every URL in a .txt/.list/.json/.csv list.',
  '      --hidden            Start in the tray without showing the window.',
  '  -m, --minimized         Start with the window minimized.',
  '  -v, --version           Print the version and exit.',
  '  -h, --help              Print this help and exit.',
  '',
  'Examples:',
  '  AiDM.exe https://example.com/file.zip',
  '  AiDM.exe --hidden --add-file links.txt',
].join('\n');

module.exports = {
  parseArgs,
  parseUrlList,
  isAllowedUrl,
  unquote,
  USAGE,
  ALLOWED_SCHEMES,
  LIST_EXTENSIONS,
};
