// Unit tests for src/network-interfaces.js — the "Combine networks" detection
// layer (Plexo's multi-interface headline feature, AiDM side).
// Run: node test/network-interfaces.js
const assert = require('assert');
const os = require('os');
const ni = require('../src/network-interfaces.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

console.log('\u2500\u2500 export surface \u2500\u2500');
for (const fn of ['classifyInterfaceKind', 'pickSourceAddress', 'listActiveInterfaces', 'eligibleForCombine', 'combineLabel']) {
  check('exports ' + fn, typeof ni[fn] === 'function');
}

console.log('\u2500\u2500 classifyInterfaceKind \u2500\u2500');
const kindCases = [
  ['Wi-Fi', 'wifi'], ['Wireless Network', 'wifi'], ['wlp2s0', 'wifi'], ['wlx1a2b', 'wifi'],
  ['Ethernet', 'ethernet'], ['Ethernet 2', 'ethernet'], ['en0', 'ethernet'], ['eth0', 'ethernet'], ['enp3s0', 'ethernet'],
  ['iPhone USB', 'usb'], ['enx3a5b0c1d2e4f', 'usb'], ['RNDIS', 'usb'], ['usb0', 'usb'],
  ['Local Area Connection', 'ethernet'], ['vmbr0', 'bridge'], ['br0', 'bridge'],
  ['lo', 'loopback'], ['Loopback Pseudo-Interface 1', 'loopback'], ['', 'other'], ['Mystery', 'other'],
];
for (const [n, k] of kindCases) check('classify ' + JSON.stringify(n) + ' -> ' + k, ni.classifyInterfaceKind(n) === k, 'got ' + ni.classifyInterfaceKind(n));

console.log('\u2500\u2500 pickSourceAddress \u2500\u2500');
check('prefers global IPv4', ni.pickSourceAddress([{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '10.0.0.5', family: 'IPv4', internal: false }]).family === 4);
check('picks a usable IPv6 when no IPv4', JSON.stringify(ni.pickSourceAddress([{ address: '2001:db8::5', family: 'IPv6', internal: false }])) === JSON.stringify({ address: '2001:db8::5', family: 6 }));
check('skips 169.254 link-local IPv4', ni.pickSourceAddress([{ address: '169.254.1.2', family: 'IPv4', internal: false }]) === null);
check('skips fe80 link-local IPv6', ni.pickSourceAddress([{ address: 'fe80::abcd', family: 'IPv6', internal: false }]) === null);
check('ignores internal addresses', ni.pickSourceAddress([{ address: '127.0.0.1', family: 'IPv4', internal: true }]) === null);
check('null on empty', ni.pickSourceAddress([]) === null);

console.log('\u2500\u2500 eligibleForCombine \u2500\u2500');
const sim = [
  { id: 'Wi-Fi', name: 'Wi-Fi', kind: 'wifi', address: '192.168.1.7', family: 4 },
  { id: 'Ethernet', name: 'Ethernet', kind: 'ethernet', address: '10.0.0.9', family: 4 },
  { id: 'Loopback', name: 'lo', kind: 'loopback', address: '127.0.0.1', family: 4 },
  { id: 'dupe', name: 'dupe', kind: 'ethernet', address: '10.0.0.9', family: 4 },
];
const e = ni.eligibleForCombine(sim);
check('drops loopback', !e.some((i) => i.kind === 'loopback'), 'n=' + e.length);
check('drops duplicate addresses', e.filter((i) => i.address === '10.0.0.9').length === 1);
check('two distinct networks survive', e.length === 2, 'n=' + e.length);

console.log('\u2500\u2500 combineLabel \u2500\u2500');
check('two networks -> "Wi-Fi + Ethernet \u00b7 2\u00d7"', ni.combineLabel(e) === 'Wi-Fi + Ethernet \u00b7 2\u00d7', ni.combineLabel(e));
check('lonely single network -> no label', ni.combineLabel([sim[0]]) === '');
check('empty -> no label', ni.combineLabel([]) === '');

console.log('\u2500\u2500 listActiveInterfaces (live, shape-only) \u2500\u2500');
const real = ni.listActiveInterfaces();
check('returns an array', Array.isArray(real));
check('every entry is non-loopback with an address', real.every((i) => i && i.kind !== 'loopback' && typeof i.address === 'string' && i.address.length > 0));
check('no duplicate addresses', new Set(real.map((i) => i.address)).size === real.length);
const eligible = ni.eligibleForCombine(real);
console.log('      (this machine: ' + real.length + ' active interface(s), ' + eligible.length + ' eligible \u2014 combine mode ' + (eligible.length >= 2 ? 'AVAILABLE' : 'inert on single-network host') + ')');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
