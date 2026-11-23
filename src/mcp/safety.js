// @ts-check
'use strict';

/**
 * Safety rules for AiDM's MCP (Model Context Protocol) server.
 *
 * An MCP client is an AI assistant. Everything it sends is text a model
 * produced, which means every value it sends is untrusted: a link it was
 * talked into fetching, a name it invented, a file name with a path inside it.
 * This module holds the rules that keep that untrusted input inside the box
 * AiDM is willing to work in:
 *
 *   - ACCESS LEVELS — what a given connection may do at all.
 *   - URL GUARD     — a link may not point at this machine, the LAN, or a
 *                     cloud metadata address (SSRF).
 *   - TEXT HYGIENE  — remote-supplied text is stripped of control characters
 *                     and length-capped before it reaches the model.
 *   - RATE LIMIT    — a client may not hammer the app.
 *
 * Everything here is pure and side-effect free, so the rules can be tested
 * without booting Electron and without touching the network (the DNS lookup
 * is injectable).
 */

const dns = require('dns');

/** Access levels, weakest first. */
const LEVELS = ['look', 'standard', 'full'];

/** Rank per level — a higher rank may do everything a lower one may. */
const LEVEL_RANK = Object.freeze({ look: 0, standard: 1, full: 2 });

/** The level used when nothing says otherwise. */
const DEFAULT_LEVEL = 'standard';

/** Longest free text an assistant is shown. */
const MAX_TEXT_LENGTH = 400;

/** Longest file name an assistant may suggest. */
const MAX_NAME_LENGTH = 120;

/** C0 controls (minus tab and newline), DEL and the C1 range. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Characters Windows refuses in a file name. */
const RESERVED_NAME_CHARS = /[<>:"|?*]/g;

/** Host names that always mean "this machine" or "our network". */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/** Suffixes that only ever resolve inside a private network. */
const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.home.arpa',
];

/**
 * Coerce anything into a known level.
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {'look'|'standard'|'full'}
 */
function normalizeLevel(value, fallback = DEFAULT_LEVEL) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVEL_RANK, s)) return /** @type {'look'|'standard'|'full'} */ (s);
  return /** @type {'look'|'standard'|'full'} */ (fallback);
}

/**
 * Rank of a level (higher = more power).
 * @param {unknown} level
 * @returns {number}
 */
function levelRank(level) {
  return LEVEL_RANK[normalizeLevel(level)];
}

/**
 * The power a connection actually gets: never more than the APP allows and
 * never more than the CLIENT asked for. This is the rule Swift Download
 * Manager states as "a connection can only lower what the app allows, never
 * raise it" — and it is the only way a client-side flag can be trusted.
 * @param {unknown} appLevel
 * @param {unknown} requestedLevel
 * @returns {'look'|'standard'|'full'}
 */
function effectiveLevel(appLevel, requestedLevel) {
  const app = levelRank(appLevel);
  const req = levelRank(requestedLevel);
  return /** @type {'look'|'standard'|'full'} */ (LEVELS[Math.min(app, req)]);
}

/**
 * May a connection at `level` perform an action that requires `required`?
 * @param {unknown} level
 * @param {unknown} required
 * @returns {boolean}
 */
function levelAllows(level, required) {
  return levelRank(level) >= levelRank(required);
}

/**
 * Strip control characters and cap the length of text that came from
 * outside the app (a server's file name, an error message, a URL).
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function sanitizeText(value, max = MAX_TEXT_LENGTH) {
  if (value == null) return '';
  let out = String(value).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const limit = Math.max(1, max | 0);
  if (out.length > limit) out = out.slice(0, limit - 1) + '…';
  return out;
}

/**
 * Turn an assistant-supplied name into something safe to hand to the
 * download manager: no path separators, no reserved characters, no leading
 * or trailing dots/spaces, and a bounded length.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function sanitizeFileName(value, max = MAX_NAME_LENGTH) {
  let out = sanitizeText(value, max * 2);
  out = out.replace(/[\\/]/g, ' ');          // a name is never a path
  out = out.replace(RESERVED_NAME_CHARS, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  if (/^\.+$/.test(out)) out = '';           // "." and ".." are not names
  out = out.replace(/[. ]+$/g, '');          // Windows drops trailing dots
  const limit = Math.max(1, max | 0);
  if (out.length > limit) out = out.slice(0, limit).trim();
  return out;
}

/**
 * Parse a dotted quad. `null` means "looks like one but is not a plain
 * address" (a leading-zero octet such as 012.1.2.3, which some resolvers
 * read as octal).
 * @param {string} host
 * @returns {number[]|null}
 */
function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [];
  for (let i = 1; i <= 4; i++) {
    const raw = m[i];
    if (raw.length > 1 && raw[0] === '0') return null;  // ambiguous octal
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    parts.push(n);
  }
  return parts;
}

/**
 * Classify an IPv4 address.
 * @param {number[]} p
 * @returns {'public'|'private'}
 */
function classifyIPv4Parts(p) {
  const [a, b] = p;
  if (a === 0) return 'private';                          // 0.0.0.0/8
  if (a === 10) return 'private';                         // 10/8
  if (a === 127) return 'private';                        // loopback
  if (a === 169 && b === 254) return 'private';           // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return 'private';  // 172.16/12
  if (a === 192 && b === 168) return 'private';           // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT 100.64/10
  if (a === 192 && b === 0) return 'private';             // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return 'private'; // 198.18/15
  if (a >= 224) return 'private';                         // multicast + reserved
  return 'public';
}

/**
 * Classify a host that is written as an address.
 * @param {string} host
 * @returns {'public'|'private'|'ambiguous'|'not-ip'}
 */
function classifyIPv4Host(host) {
  const parts = parseIPv4(host);
  if (parts) return classifyIPv4Parts(parts);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'ambiguous';  // bad octets
  if (/^0[xX][0-9a-fA-F]+$/.test(host)) return 'ambiguous';       // hex integer
  if (/^\d+$/.test(host)) return 'ambiguous';                     // decimal integer
  if (/^\d+(\.\d+){1,2}$/.test(host)) return 'ambiguous';         // 127.1
  return 'not-ip';
}

/**
 * Expand an IPv6 address into its eight groups.
 * @param {string} host
 * @returns {number[]|null}
 */
function expandIPv6(host) {
  let h = String(host || '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const lastColon = h.lastIndexOf(':');
  if (h.includes('.') && lastColon >= 0) {
    const p = parseIPv4(h.slice(lastColon + 1));
    if (!p) return null;
    h = h.slice(0, lastColon + 1)
      + ((p[0] << 8) | p[1]).toString(16) + ':'
      + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    head.push(...Array(fill).fill('0'), ...tail);
  }
  const out = [];
  for (const g of head) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

/**
 * Classify an IPv6 address, including the forms that carry an IPv4 address
 * inside them (v4-mapped, NAT64, 6to4) — those must be judged by the IPv4
 * they point at.
 * @param {string} host
 * @returns {'public'|'private'|'ambiguous'|'not-ip'}
 */
function classifyIPv6Host(host) {
  if (!String(host || '').includes(':')) return 'not-ip';
  const g = expandIPv6(host);
  if (!g) return 'ambiguous';
  const zero = g.every((x) => x === 0);
  if (zero) return 'private';                                  // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'private'; // ::1
  const v4Mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0
    && g[4] === 0 && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if (v4Mapped || nat64) {
    return classifyIPv4Parts([(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255]);
  }
  if (g[0] === 0x2002) {                                        // 6to4
    return classifyIPv4Parts([(g[1] >> 8) & 255, g[1] & 255, (g[2] >> 8) & 255, g[2] & 255]);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';             // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return 'private';             // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return 'private';             // ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'private';     // documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return 'private';     // Teredo
  return 'public';
}

/**
 * Is this host name one that only ever means "this machine" or "our LAN"?
 * @param {string} host
 * @returns {boolean}
 */
function isBlockedHostName(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_HOSTS.has(h)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/**
 * Judge a host that is written as a literal address.
 * @param {string} host
 * @returns {{ ok: boolean, reason?: string }}
 */
function judgeLiteralHost(host) {
  const v4 = classifyIPv4Host(host);
  if (v4 === 'public') return { ok: true };
  if (v4 === 'private') return { ok: false, reason: `${host} is a private or local address` };
  if (v4 === 'ambiguous') return { ok: false, reason: `${host} is not a plain IP address (it may be shorthand for a local one)` };
  const v6 = classifyIPv6Host(host);
  if (v6 === 'public') return { ok: true };
  if (v6 === 'private') return { ok: false, reason: `${host} is a private or local address` };
  if (v6 === 'ambiguous') return { ok: false, reason: `${host} is not a plain IP address` };
  return { ok: true };
}

/**
 * Look a host up and judge every address it resolves to.
 * @param {string} host
 * @param {{ lookup?: (h: string) => Promise<Array<{ address: string }>> }} [io]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function judgeResolvedHost(host, io = {}) {
  const lookup = io.lookup || ((h) => dns.promises.lookup(h, { all: true, verbatim: true }));
  /** @type {Array<{ address: string }>} */
  let addresses = [];
  try {
    addresses = await lookup(host);
  } catch (e) {
    return { ok: false, reason: `${host} could not be resolved (${(e && e.message) || 'lookup failed'})` };
  }
  if (!addresses || !addresses.length) {
    return { ok: false, reason: `${host} did not resolve to any address` };
  }
  for (const entry of addresses) {
    const address = String((entry && entry.address) || '');
    const verdict = judgeLiteralHost(address);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/**
 * The gate every assistant-supplied link passes before the app fetches it.
 * Only http, https and ftp are considered — magnet links name no host.
 * @param {unknown} rawUrl
 * @param {{ lookup?: (h: string) => Promise<Array<{ address: string }>> }} [io]
 * @returns {Promise<{ ok: boolean, reason?: string, url?: string, host?: string }>}
 */
async function checkUrl(rawUrl, io = {}) {
  const text = String(rawUrl == null ? '' : rawUrl).trim();
  if (!text) return { ok: false, reason: 'no link was given' };
  if (text.length > 4096) return { ok: false, reason: 'the link is too long' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch (e) {
    return { ok: false, reason: 'that is not a link AiDM can read' };
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'ftp'].includes(scheme)) {
    return { ok: false, reason: `AiDM cannot fetch ${scheme} links` };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'the link has no host' };
  if (isBlockedHostName(host)) {
    return { ok: false, reason: `${host} is this computer or the local network` };
  }
  const literal = judgeLiteralHost(host);
  if (!literal.ok) return { ok: false, reason: literal.reason };
  if (classifyIPv4Host(host) === 'not-ip' && classifyIPv6Host(host) === 'not-ip') {
    const resolved = await judgeResolvedHost(host, io);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
  }
  return { ok: true, url: parsed.toString(), host };
}

/**
 * A sliding-window rate limiter: at most `limit` calls per `windowMs`.
 */
class RateLimiter {
  /**
   * @param {{ limit?: number, windowMs?: number }} [options]
   */
  constructor(options = {}) {
    this.limit = Math.max(1, options.limit || 60);
    this.windowMs = Math.max(1000, options.windowMs || 60000);
    /** @type {number[]} */
    this.stamps = [];
  }

  /**
   * May one more call happen now?
   * @param {number} [now]
   * @returns {{ ok: boolean, retryAfterMs?: number }}
   */
  allow(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.stamps = this.stamps.filter((t) => t > cutoff);
    if (this.stamps.length >= this.limit) {
      const oldest = this.stamps[0];
      return { ok: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }
    this.stamps.push(now);
    return { ok: true };
  }

  /** Forget every recorded call. */
  reset() {
    this.stamps = [];
  }
}

module.exports = {
  LEVELS,
  LEVEL_RANK,
  DEFAULT_LEVEL,
  MAX_TEXT_LENGTH,
  MAX_NAME_LENGTH,
  normalizeLevel,
  levelRank,
  effectiveLevel,
  levelAllows,
  sanitizeText,
  sanitizeFileName,
  classifyIPv4Host,
  classifyIPv6Host,
  isBlockedHostName,
  judgeLiteralHost,
  judgeResolvedHost,
  checkUrl,
  RateLimiter,
};
