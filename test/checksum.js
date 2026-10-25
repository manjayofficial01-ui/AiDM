// Tests for src/engine/checksum.js — input normalisation + verification.
// Run: node test/checksum.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  normalizeChecksum, verifyChecksum, hashFile, detectAlgorithm, cleanDigest,
  DIGEST_HEX_LENGTHS,
} = require('../src/engine/checksum');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra === undefined ? '' : extra); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}
function throws(name, fn, match) {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (e) {
    const ok = !match || match.test(e.message);
    check(name, ok, ok ? e.message.slice(0, 90) : `wrong message: ${e.message}`);
  }
}

const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';                  // 32
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';          // 40
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 64
const SHA512 = 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce' +
  '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';           // 128

console.log('── length → algorithm inference ──');
check('32 chars → md5', detectAlgorithm(MD5) === 'md5');
check('40 chars → sha1', detectAlgorithm(SHA1) === 'sha1');
check('64 chars → sha256', detectAlgorithm(SHA256) === 'sha256');
check('128 chars → sha512', detectAlgorithm(SHA512) === 'sha512');
check('odd length → null', detectAlgorithm('abc') === null);
check('table is consistent', DIGEST_HEX_LENGTHS.sha256 === 64 && DIGEST_HEX_LENGTHS.sha512 === 128);

console.log('\n── cleanDigest (tolerant input) ──');
check('plain hex kept', cleanDigest(SHA256) === SHA256);
check('uppercase lowercased', cleanDigest(SHA256.toUpperCase()) === SHA256);
check('0x prefix stripped', cleanDigest('0x' + SHA256) === SHA256);
check('0X prefix stripped', cleanDigest('0X' + SHA256) === SHA256);
check('surrounding whitespace trimmed', cleanDigest('  ' + SHA256 + '  ') === SHA256);
check('colon grouping removed', cleanDigest('ab:cd:ef') === 'abcdef');
check('dash grouping removed', cleanDigest('ab-cd-ef') === 'abcdef');
check('space grouping removed', cleanDigest('ab cd ef') === 'abcdef');
check('"<digest>  file.zip" keeps the digest', cleanDigest(SHA256 + '  file.zip') === SHA256);
check('empty stays empty', cleanDigest('') === '');

console.log('\n── normalizeChecksum: explicit algorithm ──');
{
  const r = normalizeChecksum({ algorithm: 'sha256', value: SHA256 });
  check('sha256 accepted', r.algorithm === 'sha256' && r.value === SHA256);
}
check('SHA-256 alias', normalizeChecksum({ algorithm: 'SHA-256', value: SHA256 }).algorithm === 'sha256');
check('SHA1 alias', normalizeChecksum({ algorithm: 'sha1', value: SHA1 }).algorithm === 'sha1');
check('SHA-1 alias', normalizeChecksum({ algorithm: 'SHA-1', value: SHA1 }).algorithm === 'sha1');
check('md5 alias', normalizeChecksum({ algorithm: 'md5', value: MD5 }).algorithm === 'md5');
check('sha512 alias', normalizeChecksum({ algorithm: 'sha512', value: SHA512 }).algorithm === 'sha512');
check('uppercase digest is normalised',
  normalizeChecksum({ algorithm: 'sha256', value: SHA256.toUpperCase() }).value === SHA256);

console.log('\n── normalizeChecksum: algorithm inferred ──');
check('bare 64-char digest → sha256',
  normalizeChecksum({ value: SHA256 }).algorithm === 'sha256');
check('bare 32-char digest → md5', normalizeChecksum({ value: MD5 }).algorithm === 'md5');
check('bare 40-char digest → sha1', normalizeChecksum({ value: SHA1 }).algorithm === 'sha1');
check('bare 128-char digest → sha512', normalizeChecksum({ value: SHA512 }).algorithm === 'sha512');
check('null algorithm behaves like absent',
  normalizeChecksum({ algorithm: null, value: SHA256 }).algorithm === 'sha256');
check('empty algorithm string behaves like absent',
  normalizeChecksum({ algorithm: '', value: SHA256 }).algorithm === 'sha256');

console.log('\n── normalizeChecksum: prefixed string forms ──');
check('"sha256:<hex>"', normalizeChecksum('sha256:' + SHA256).algorithm === 'sha256');
check('"SHA-256: <hex>"', normalizeChecksum('SHA-256: ' + SHA256).algorithm === 'sha256');
check('"sha256=<hex>"', normalizeChecksum('sha256=' + SHA256).algorithm === 'sha256');
check('"sha256 <hex>"', normalizeChecksum('sha256 ' + SHA256).algorithm === 'sha256');
check('prefix inside value field',
  normalizeChecksum({ value: 'sha256:' + SHA256 }).algorithm === 'sha256');
check('prefixed value keeps the bare digest',
  normalizeChecksum('sha256:' + SHA256).value === SHA256);
check('bare string input works', normalizeChecksum(SHA256).algorithm === 'sha256');

console.log('\n── normalizeChecksum: hard failures ──');
throws('wrong length for the declared algorithm', () => normalizeChecksum({ algorithm: 'sha256', value: MD5 }), /but this one is 32/);
throws('short digest of unknown length', () => normalizeChecksum({ value: 'abcdef' }), /Cannot tell which algorithm/);
throws('non-hex characters rejected', () => normalizeChecksum({ algorithm: 'sha256', value: 'z'.repeat(64) }), /hex digest/);
throws('empty value rejected', () => normalizeChecksum({ algorithm: 'sha256', value: '' }), /empty/);
throws('missing value rejected', () => normalizeChecksum({ algorithm: 'sha256' }), /empty/);
throws('unsupported algorithm rejected', () => normalizeChecksum({ algorithm: 'crc32', value: 'abcd1234' }), /Unsupported hash algorithm/);
throws('null input rejected', () => normalizeChecksum(null), /missing/);
throws('undefined input rejected', () => normalizeChecksum(undefined), /missing/);
throws('a 63-char digest is not silently sha256',
  () => normalizeChecksum({ algorithm: 'sha256', value: 'a'.repeat(63) }), /64 hex characters/);

console.log('\n── verifyChecksum (real files) ──');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-sum-'));
  const file = path.join(dir, 'payload.bin');
  const data = Buffer.from('AiDM checksum fixture — deterministic bytes 0123456789');
  fs.writeFileSync(file, data);

  const digests = {
    md5: crypto.createHash('md5').update(data).digest('hex'),
    sha1: crypto.createHash('sha1').update(data).digest('hex'),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    sha512: crypto.createHash('sha512').update(data).digest('hex'),
  };

  for (const [alg, digest] of Object.entries(digests)) {
    let ok = true;
    try { await verifyChecksum(file, { algorithm: alg, value: digest }); } catch (e) { ok = false; }
    check(`${alg} verifies a correct digest`, ok);
  }
  check('hashFile agrees with crypto for sha256', await hashFile(file, 'sha256') === digests.sha256);

  // The parity claim: a bare digest verifies without naming the algorithm.
  let inferredOk = true;
  try { await verifyChecksum(file, digests.sha256); } catch (e) { inferredOk = false; }
  check('bare digest verifies without an algorithm', inferredOk);

  let upperOk = true;
  try { await verifyChecksum(file, digests.sha256.toUpperCase()); } catch (e) { upperOk = false; }
  check('uppercase digest verifies (FDM bug #272855 class)', upperOk);

  let prefixedOk = true;
  try { await verifyChecksum(file, 'sha256:' + digests.sha256); } catch (e) { prefixedOk = false; }
  check('"sha256:<hex>" verifies', prefixedOk);

  let wrongThrew = false;
  try { await verifyChecksum(file, { algorithm: 'sha256', value: 'a'.repeat(64) }); } catch (e) {
    wrongThrew = /mismatch/.test(e.message);
  }
  check('a wrong digest still fails with a mismatch message', wrongThrew);

  let wrongLenThrew = false;
  try { await verifyChecksum(file, { algorithm: 'sha256', value: digests.md5 }); } catch (e) {
    wrongLenThrew = /hex characters/.test(e.message);
  }
  check('a wrong-length digest is explained, not blamed on the file', wrongLenThrew);

  // A wrong algorithm but a valid length must still fail (not silently pass).
  let algMismatch = false;
  try { await verifyChecksum(file, { algorithm: 'sha1', value: digests.sha256.slice(0, 40) }); } catch (e) {
    algMismatch = /mismatch/.test(e.message);
  }
  check('right length + wrong algorithm fails', algMismatch);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
