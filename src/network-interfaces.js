// @ts-check
/*
 * network-interfaces.js — the OS's usable networks, for AiDM's "Combine
 * networks" mode (the Plexo headline feature: spread a download's connections
 * across several physical interfaces — Wi-Fi + Ethernet + USB tether — to beat
 * a single connection's ceiling).
 *
 * AiDM already splits a file across many *connections*; what it lacked was
 * spreading them across *networks*. When two or more interfaces are eligible,
 * the engine binds each new connection to one interface's source address
 * (`localAddress`): Windows and macOS route a socket by its source IP, so each
 * connection rides the interface that owns that address (Plexo's approach; it
 * needs no SO_BINDTODEVICE native call off Linux). Fewer than two eligible
 * interfaces → the feature is inert and every connection uses the default route.
 *
 * Detect only — never guess. Only real addresses from os.networkInterfaces()
 * are reported; classification is a best-effort label from the interface name.
 */
const os = require('os');

/**
 * Best-effort kind from an interface's name (Node reports the Windows adapter
 * alias — "Wi-Fi", "Ethernet 2" — and macOS's en0/en1; Linux's predictable
 * names classify well by prefix). Never used for routing, only for display.
 * @param {string} name
 * @returns {'wifi'|'usb'|'ethernet'|'bridge'|'loopback'|'other'}
 */
function classifyInterfaceKind(name) {
  const n = String(name || '').toLowerCase();
  if (/^lo(opback)?$|loopback/.test(n)) return 'loopback';
  if (/wi-?fi|wireless|wlan|802\.11|airport|^wl/.test(n)) return 'wifi';
  if (/rndis|tether|usb|^enx|_u\d|^usb/.test(n)) return 'usb';
  if (/bridge|vmbr|^br\d/.test(n)) return 'bridge';
  if (/ethernet|local area|^en\d|^enp|^eth|^lan/.test(n)) return 'ethernet';
  return 'other';
}

/**
 * Pick the one source address to bind a connection to: prefer a global IPv4
 * (routing by source address is the reliable path on Windows/macOS), then a
 * usable IPv6. Returns { address, family } or null when the interface has none.
 * @param {Array<{address:string, family:string|number, internal?:boolean}>} addresses
 */
function pickSourceAddress(addresses) {
  if (!Array.isArray(addresses)) return null;
  const fam = (a) => String(a.family);
  const isV4 = (a) => fam(a) === 'IPv4' || fam(a) === '4';
  const isV6 = (a) => fam(a) === 'IPv6' || fam(a) === '6';
  const v4 = addresses.find(
    (a) => isV4(a) && !a.internal && a.address && !a.address.startsWith('169.254.')
  );
  if (v4) return { address: v4.address, family: 4 };
  const v6 = addresses.find(
    (a) => isV6(a) && !a.internal && a.address && !/^fe[89ab]/i.test(a.address) && a.address !== '::1'
  );
  if (v6) return { address: v6.address, family: 6 };
  return null;
}

/**
 * @typedef {{id:string,name:string,kind:string,address:string,family:4|6}} NetInterface
 */

/**
 * The computer's active, non-loopback interfaces, each with the one source
 * address the engine would bind a connection to. Read-only, no child processes,
 * never throws (a machine with one interface simply yields one entry).
 * @returns {NetInterface[]}
 */
function listActiveInterfaces() {
  /** @type {NodeJS.Dict<os.NetworkInterfaceInfo[]>} */ // @ts-ignore
  let all;
  try { all = os.networkInterfaces(); } catch (e) { return []; }
  /** @type {NetInterface[]} */
  const out = [];
  const seen = new Set();
  for (const [id, addresses] of Object.entries(all || {})) {
    const usable = (addresses || []).filter((a) => !a.internal);
    if (!usable.length) continue;
    const picked = pickSourceAddress(usable);
    if (!picked) continue;
    // Two adapters can share an address (VPN/tunnel re-exporting the same route);
    // binding to the same source twice adds nothing, so keep the first.
    if (seen.has(picked.address)) continue;
    seen.add(picked.address);
    out.push({ id, name: id, kind: classifyInterfaceKind(id), address: picked.address, family: picked.family });
  }
  return out;
}

/**
 * The subset eligible to be combined: distinct, non-loopback, with an address.
 * @param {NetInterface[]} list
 * @returns {NetInterface[]}
 */
function eligibleForCombine(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const i of list) {
    if (!i || i.kind === 'loopback' || !i.address) continue;
    if (seen.has(i.address)) continue;
    seen.add(i.address);
    out.push(i);
  }
  return out;
}

/**
 * A short, human label for the combine banner/e.g. "Wi-Fi + Ethernet · 2×".
 * @param {NetInterface[]} ifaces
 * @returns {string}
 */
function combineLabel(ifaces) {
  const e = eligibleForCombine(ifaces);
  if (e.length < 2) return '';
  const named = e.map(function (i) {
    if (i.kind === 'wifi') return 'Wi-Fi';
    if (i.kind === 'ethernet') return 'Ethernet';
    if (i.kind === 'usb') return 'USB tether';
    if (i.kind === 'bridge') return 'Bridge';
    return i.name;
  });
  return named.join(' + ') + ' \u00b7 ' + e.length + '\u00d7';
}

module.exports = {
  classifyInterfaceKind,
  pickSourceAddress,
  listActiveInterfaces,
  eligibleForCombine,
  combineLabel,
};
