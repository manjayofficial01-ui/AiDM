'use strict';
/**
 * Security-corrected replacement for the abandoned `ip` package (indutny/node-ip).
 *
 * Why: GHSA-2p57-rm9w-gvfp (SSRF: isPublic misclassifies short/hex/octal forms
 * like `127.1`, `0x7f.1`, `012.1.2.3` as PUBLIC) has no upstream patch — the
 * package is unmaintained and every bittorrent-tracker version depends on it,
 * so `npm audit` reports 4 highs through webtorrent 2.x AND 3.x. No maintained
 * fork exists on npm (the `ip2` name is an unrelated 2015 package), so the
 * advisory is closed with this local shim wired in via npm overrides.
 *
 * Scope: the AiDM dependency tree calls exactly ONE function from it —
 * `ipLib.toString(uint32)` in bittorrent-tracker's tracker-SERVER code
 * (`lib/server/parse-udp.js`), which AiDM (a client) never executes. The rest
 * of the classic surface is still implemented so a future tracker update that
 * reaches for more of it gets correct answers, and every security-relevant
 * predicate FAILS CLOSED: an address that cannot be parsed strictly is never
 * reported as public.
 *
 * CJS with `module.exports.default` so `import ipLib from 'ip'` keeps working.
 */
const os = require('os');
const net = require('net');

const api = {};

/**
 * Dotted-quad (possibly short/hex/octal) → uint32, parsed strictly with
 * POSIX inet_aton semantics: fewer than 4 parts means the LAST part covers
 * all remaining bits (`127.1` → 127.0.0.1, `1.2.3` → 1.2.0.3), hex and
 * 0-prefixed octal parts accepted, anything ambiguous → -1. This is the
 * single parsing choke point every predicate goes through.
 */
function normalizeToLong(addr) {
  const parts = String(addr || '').split('.');
  const n = parts.length;
  if (n < 1 || n > 4) return -1;
  let val = 0;
  for (let i = 0; i < n; i++) {
    const part = parts[i];
    let num;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) num = parseInt(part, 16);
    else if (/^0[0-7]*$/.test(part)) num = parseInt(part, 8);
    else if (/^(0|[1-9]\d*)$/.test(part)) num = parseInt(part, 10);
    else return -1;
    if (!Number.isFinite(num) || num < 0) return -1;
    if (i < n - 1) {
      if (num > 255) return -1;
      val += num * 2 ** (32 - 8 * (i + 1));
    } else {
      // inet_aton: the last part fills ALL remaining bits (a.b → b is 24-bit)
      if (num >= 2 ** (32 - 8 * (n - 1))) return -1;
      val += num;
    }
  }
  if (val >= 2 ** 32) return -1;
  return val >>> 0;
}

/** Any v4-ish input (incl. shorthand) → canonical dotted quad, or null. */
function canonicalV4(addr) {
  if (!/^[\dxXa-fA-F.]+$/.test(String(addr || ''))) return null;
  const long = normalizeToLong(addr);
  return long < 0 ? null : fromLong(long);
}

function fromLong(ipl) {
  const v = ipl >>> 0;
  return `${v >>> 24}.${(v >> 16) & 255}.${(v >> 8) & 255}.${v & 255}`;
}

api.isV4Format = function (addr) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(addr || ''));
};

api.isV6Format = function (addr) {
  const s = String(addr || '');
  return s.includes(':') && net.isIPv6(s);
};

api.toBuffer = function (addr, buff, offset) {
  offset = ~~offset;
  const s = String(addr || '');
  let out;
  if (api.isV4Format(s)) {
    const long = normalizeToLong(s);
    if (long < 0) throw new Error(`Invalid ip address: ${addr}`);
    out = buff || Buffer.alloc(offset + 4);
    out.writeUInt32BE(long, offset);
  } else if (net.isIPv6(s)) {
    out = buff || Buffer.alloc(offset + 16);
    const sections = s.split('::');
    if (sections.length > 2) throw new Error(`Invalid ip address: ${addr}`);
    const head = sections[0].split(':').filter(Boolean);
    const tail = (sections[1] || '').split(':').filter(Boolean);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) throw new Error(`Invalid ip address: ${addr}`);
    const groups = [...head, ...Array(fill).fill('0'), ...tail];
    if (groups.length !== 8) throw new Error(`Invalid ip address: ${addr}`);
    groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, offset + i * 2));
  } else {
    const norm = canonicalV4(s);
    if (!norm) throw new Error(`Invalid ip address: ${addr}`);
    return api.toBuffer(norm, buff, offset);
  }
  return out;
};

api.toString = function (buff, offset, length) {
  offset = ~~offset;
  // bittorrent-tracker's parse-udp passes a bare host-order uint32 here (the
  // optional in-packet announce address). node-ip 2.0.1 returned [] for that;
  // interpret it as a long — strictly better and type-compatible.
  if (typeof buff === 'number') return fromLong(buff >>> 0);
  if (!buff || typeof buff.length !== 'number') return '';
  length = length || (buff.length - offset);
  if (length === 4) {
    const octets = [];
    for (let i = 0; i < 4; i++) octets.push(buff[offset + i]);
    return octets.join('.');
  }
  if (length === 16) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(buff.readUInt16BE(offset + i).toString(16));
    return groups.join(':')
      .replace(/(^|:)0(:0)*:0(:|$)/, '$1::$3')
      .replace(/:{3,4}/, '::');
  }
  return '';
};

api.toLong = function (addr) {
  const long = normalizeToLong(addr);
  if (long < 0) throw new Error(`Invalid ip address: ${addr}`);
  return long;
};

api.fromLong = fromLong;
api.normalizeToLong = normalizeToLong;

function popcount32(v) {
  let c = 0;
  while (v) { v &= v - 1; c++; }
  return c;
}

api.fromPrefixLen = function (prefixlen, family) {
  const p = parseInt(prefixlen, 10);
  const v6 = (family && String(family).includes('6')) || p > 32;
  if (p === 0) return v6 ? '::' : '0.0.0.0';
  if (v6) {
    if (p < 0 || p > 128) throw new Error('Invalid prefix length');
    const groups = [];
    for (let i = 0; i < 8; i++) {
      const take = Math.min(16, Math.max(0, p - i * 16));
      groups.push((take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff).toString(16));
    }
    return groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '$1::$3');
  }
  if (p < 0 || p > 32) throw new Error('Invalid prefix length');
  return fromLong((0xffffffff << (32 - p)) >>> 0);
};

api.mask = function (addr, mask) {
  const a = api.toBuffer(addr);
  const m = api.toBuffer(mask);
  if (a.length !== m.length) throw new Error('Address and mask must be the same family');
  for (let i = 0; i < a.length; i++) a[i] &= m[i];
  return api.toString(a);
};

api.cidr = function (cidrString) {
  const slash = String(cidrString || '').indexOf('/');
  if (slash < 0) throw new Error(`Invalid cidr: ${cidrString}`);
  return api.mask(cidrString.slice(0, slash), api.fromPrefixLen(cidrString.slice(slash + 1)));
};

/** v4-only (mirrors node-ip's behavior; v6 subnets throw). */
api.subnet = function (addr, mask) {
  const addrLong = normalizeToLong(addr);
  const maskLong = normalizeToLong(mask);
  if (addrLong < 0 || maskLong < 0) throw new Error('Invalid subnet input');
  const network = (addrLong & maskLong) >>> 0;
  const broadcast = (network | (~maskLong >>> 0)) >>> 0;
  const count = 2 ** (32 - popcount32(maskLong));
  return {
    networkAddress: fromLong(network),
    firstAddress: count <= 2 ? fromLong(network) : fromLong(network + 1),
    lastAddress: count <= 2 ? fromLong(broadcast) : fromLong(broadcast - 1),
    broadcastAddress: fromLong(broadcast),
    subnetMask: fromLong(maskLong),
    subnetMaskLength: popcount32(maskLong),
    numHosts: count <= 2 ? count : count - 2,
    length: count,
    contains(other) {
      const o = normalizeToLong(other);
      return o >= 0 && ((o & maskLong) >>> 0) === network;
    },
  };
};

api.cidrSubnet = function (cidrString) {
  const slash = String(cidrString || '').indexOf('/');
  if (slash < 0) throw new Error(`Invalid cidr: ${cidrString}`);
  const addr = cidrString.slice(0, slash);
  if (addr.includes(':')) throw new Error(`Invalid cidr: ${cidrString}`);
  return api.subnet(addr, api.fromPrefixLen(cidrString.slice(slash + 1)));
};

api.not = function (addr) {
  const b = api.toBuffer(addr);
  for (let i = 0; i < b.length; i++) b[i] = ~b[i] & 0xff;
  return api.toString(b);
};

api.or = function (a, b) {
  const ba = api.toBuffer(a);
  const bb = api.toBuffer(b);
  if (ba.length !== bb.length) throw new Error('Inputs must be the same family');
  for (let i = 0; i < ba.length; i++) ba[i] |= bb[i];
  return api.toString(ba);
};

api.isEqual = function (a, b) {
  if (!a || !b) return false;
  const sa = String(a);
  const sb = String(b);
  if (api.isV4Format(sa) !== api.isV4Format(sb)) {
    // Mixed family: match a bare v4 against its ::ffff: v4-mapped form.
    const [v4, other] = api.isV4Format(sa) ? [sa, sb] : [sb, sa];
    if (other.toLowerCase().startsWith('::ffff:')) {
      const otherV4 = other.slice(7);
      return api.isV4Format(otherV4) && canonicalV4(v4) === canonicalV4(otherV4);
    }
    return false;
  }
  return api.toBuffer(sa).equals(api.toBuffer(sb));
};

/**
 * The advisory's blast radius. Everything funnels through strict parsing:
 * shorthand v4 is expanded first, v6 is validated by Node's parser, and any
 * unparseable input fails CLOSED (private) so isPublic can never bless a
 * shorthand loopback like `127.1` or `0x7f.1`.
 */
function isPrivateStrict(addr) {
  const s = String(addr || '');
  if (!s) return true;
  const v4ish = canonicalV4(s);
  if (v4ish) {
    const long = normalizeToLong(v4ish);
    const o1 = long >>> 24, o2 = (long >> 16) & 255;
    if (o1 === 0 || o1 === 10 || o1 === 127) return true;              // 0/8, 10/8, 127/8
    if (o1 === 169 && o2 === 254) return true;                         // 169.254/16 link-local
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;               // 172.16/12
    if (o1 === 192 && o2 === 168) return true;                         // 192.168/16
    if (o1 === 192 && o2 === 0) return true;                           // 192.0.0/24 + 192.0.2/24 (doc)
    if (o1 === 198 && (o2 === 18 || o2 === 19)) return true;           // 198.18/15 (bench)
    if (o1 === 198 && o2 === 51) return true;                          // 198.51.100/24 (doc)
    if (o1 === 203 && o2 === 0) return true;                           // 203.0.113/24 (doc)
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;              // 100.64/10 CGNAT
    const top = long >>> 28;
    if (top === 0xE || top === 0xF) return true;                       // 224/4 multicast, 240/4 reserved
    return false;
  }
  if (net.isIPv6(s)) {
    const low = s.toLowerCase().split('%')[0]; // strip zone id
    if (low.startsWith('::ffff:')) {
      const mapped = low.slice(7);
      // v4-mapped: apply the v4 rules to the embedded address; unparseable
      // embedded forms fail closed.
      return canonicalV4(mapped) ? isPrivateStrict(mapped) : true;
    }
    // Classify on the PARSED bytes, not the text — `000:0:0000::01` is ::1.
    let b;
    try { b = api.toBuffer(low); } catch { return true; }
    const zeros = b.every((byte, i) => byte === 0 || i === 15);
    if (zeros) return true;                    // :: (unspecified) and ::1 (loopback)
    if (b[0] === 0xfc || b[0] === 0xfd) return true;                 // fc00::/7 ULA
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;        // fe80::/10 link-local
    if (b[0] === 0xff) return true;                                  // ff00::/8 multicast
    if (b[0] === 0 && b[1] === 0 && b[10] === 0 && b[11] === 0) {
      // v4-compatible legacy form (::a.b.c.d): apply the v4 rules, fail closed.
      return isPrivateStrict(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
    }
    return false;
  }
  return true; // unparseable → fail closed
}

api.isPrivate = isPrivateStrict;
api.isPublic = function (addr) {
  return !isPrivateStrict(addr);
};

api.isLoopback = function (addr) {
  const s = String(addr || '');
  const v4ish = canonicalV4(s);
  if (v4ish) return (normalizeToLong(v4ish) >>> 24) === 127;
  if (net.isIPv6(s)) {
    let b;
    try { b = api.toBuffer(s.toLowerCase().split('%')[0]); } catch { return false; }
    return b.every((byte, i) => byte === 0 || i === 15) && b[15] === 1;
  }
  return false;
};

api.loopback = function (family) {
  return (family && String(family).includes('6')) ? '::1' : '127.0.0.1';
};

api.address = function (name, family) {
  const want = (family && String(family).includes('6')) ? 'IPv6' : 'IPv4';
  const interfaces = os.networkInterfaces();
  const pick = (entries) => (entries || [])
    .filter(i => i && !i.internal && i.family === want)
    .map(i => i.address);
  let all = name && interfaces[name] ? pick(interfaces[name]) : [];
  if (!all.length) {
    all = Object.values(interfaces).flatMap(pick);
  }
  return all.length ? all[0] : api.loopback(want === 'IPv6' ? 'ipv6' : 'ipv4');
};

module.exports = api;
module.exports.default = api;
