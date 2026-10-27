// The npm `overrides` entry replaces the abandoned `ip` package with
// tools/shims/node-ip (GHSA-2p57-rm9w-gvfp has no upstream patch and every
// bittorrent-tracker version depends on `ip`, so webtorrent 3.x alone could
// not clear the audit). This suite pins the shim's contract:
//   1. the advisory's exact bypass addresses fail CLOSED (never "public");
//   2. the one call the dependency tree makes (toString on a uint32, tracker
//      server code) returns a real dotted quad — node-ip 2.0.1 returned [];
//   3. the rest of the surface the tracker could grow into stays correct.
// Run: node test/ip-shim.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

// Load through the SAME path shape the tracker's ESM import resolves to.
const ip = require('../node_modules/bittorrent-tracker/node_modules/ip');

console.log('\n── 1. GHSA-2p57-rm9w-gvfp: shorthand loopbacks are never public ──');
for (const addr of ['127.1', '0x7f.1', '012.1.2.3', '000:0:0000::01', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '0.0.0.0', '169.254.1.1', '100.64.0.1']) {
  check(`isPublic('${addr}') is false`, ip.isPublic(addr) === false);
}
check('isPublic(8.8.8.8) is true', ip.isPublic('8.8.8.8') === true);
check('isPublic(1.1.1.1) is true', ip.isPublic('1.1.1.1') === true);
check('isPublic(2606:4700:4700::1111) is true', ip.isPublic('2606:4700:4700::1111') === true);
check('isPublic(::ffff:8.8.8.8) is true (v4-mapped public)', ip.isPublic('::ffff:8.8.8.8') === true);
check('isPublic(::ffff:127.0.0.1) is false (v4-mapped loopback)', ip.isPublic('::ffff:127.0.0.1') === false);
check('unparseable input fails closed', ip.isPublic('not-an-ip') === false);
check('empty input fails closed', ip.isPublic('') === false);
check('fc00::1 (ULA) is private', ip.isPublic('fc00::1') === false);
check('fe80::1 (link-local) is private', ip.isPublic('fe80::1') === false);
check('::1 loopback is private', ip.isPublic('::1') === false);
check('224.0.0.1 (multicast) is not public', ip.isPublic('224.0.0.1') === false);

console.log('\n── 2. the call bittorrent-tracker actually makes ──');
check('toString(uint32) is a dotted quad (node-ip returned [])',
  ip.toString(3232235777) === '192.168.1.1', ip.toString(3232235777));
check('toString(4-byte buffer)', ip.toString(Buffer.from([10, 0, 0, 1])) === '10.0.0.1');
check('toString(16-byte buffer)', ip.toString(Buffer.alloc(16, 0)) === '::');
check('toString(garbage) does not throw', (ip.toString(undefined), true));

console.log('\n── 3. format checks + roundtrips ──');
check('isV4Format strict', ip.isV4Format('1.2.3.4') === true && ip.isV4Format('1.2.3') === false);
check('isV6Format strict', ip.isV6Format('::1') === true && ip.isV6Format('1.2.3.4') === false);
check('toLong/fromLong roundtrip',
  ip.fromLong(ip.toLong('192.168.1.1')) === '192.168.1.1');
check('toLong accepts shorthand', ip.toLong('127.1') === 0x7F000001, '0x' + ip.toLong('127.1').toString(16));
check('toBuffer/toString roundtrip v4',
  ip.toString(ip.toBuffer('172.16.31.5')) === '172.16.31.5');
check('toBuffer/toString roundtrip v6',
  ip.toString(ip.toBuffer('2001:db8::1')) === '2001:db8::1', ip.toString(ip.toBuffer('2001:db8::1')));
check('toBuffer rejects garbage', (() => { try { ip.toBuffer('nope'); return false; } catch { return true; } })());
check('shorthand toBuffer expands', ip.toString(ip.toBuffer('127.1')) === '127.0.0.1');

console.log('\n── 4. subnet helpers the tracker does not use yet ──');
const sn = ip.subnet('192.168.1.77', '255.255.255.0');
check('subnet network', sn.networkAddress === '192.168.1.0', sn.networkAddress);
check('subnet broadcast', sn.broadcastAddress === '192.168.1.255', sn.broadcastAddress);
check('subnet contains()', sn.contains('192.168.1.200') === true && sn.contains('192.168.2.1') === false);
check('cidrSubnet', ip.cidrSubnet('10.0.0.0/8').subnetMask === '255.0.0.0');
check('fromPrefixLen(24)', ip.fromPrefixLen(24) === '255.255.255.0');
check('mask', ip.mask('192.168.1.77', '255.255.255.0') === '192.168.1.0');
check('isEqual v4', ip.isEqual('1.2.3.4', '1.2.3.4') === true && ip.isEqual('1.2.3.4', '1.2.3.5') === false);
check('isEqual v4 vs ::ffff: v4-mapped', ip.isEqual('1.2.3.4', '::ffff:1.2.3.4') === true);
check('isLoopback', ip.isLoopback('127.0.0.1') === true && ip.isLoopback('127.1') === true && ip.isLoopback('8.8.8.8') === false);

console.log('\n── 5. ESM default-import interop (how the tracker loads it) ──');
const { pathToFileURL } = require('url');
(async () => {
  const mod = await import(pathToFileURL(require.resolve('../node_modules/bittorrent-tracker/node_modules/ip')).href);
  check('default export is the api object', typeof mod.default.isPublic === 'function' && typeof mod.default.toString === 'function');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 500).unref();
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
