// Tests for src/archive-extract.js — dependency-free ZIP extraction.
// Run: node test/archive-extract.js
//
// The fixture writer below produces REAL ZIP bytes (local header + central
// directory + EOCD) so the reader is exercised against the format itself, not
// against a mock. Every attack case asserts BOTH the refusal reason AND that
// nothing landed outside the destination directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ae = require('../src/archive-extract');
const { makeZip } = require('./_zip-fixture');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra === undefined ? '' : extra); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-zip-'));
let tmpSeq = 0;
function tmpPath(name) {
  const dir = path.join(tmpRoot, String(tmpSeq++));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}


function writeZip(name, entries) {
  const p = tmpPath(name);
  fs.writeFileSync(p, makeZip(entries));
  return p;
}

(async () => {
  console.log('── sniffArchiveFormat ──');
  check('ZIP local header', ae.sniffArchiveFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])) === 'zip');
  check('empty ZIP (EOCD only)', ae.sniffArchiveFormat(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0])) === 'zip');
  check('7z magic', ae.sniffArchiveFormat(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0, 0])) === '7z');
  check('RAR magic', ae.sniffArchiveFormat(Buffer.from('Rar!\x1a\x07\x00', 'latin1')) === 'rar');
  check('gzip magic', ae.sniffArchiveFormat(Buffer.from([0x1f, 0x8b, 0x08, 0x00])) === 'gz');
  check('plain text is not an archive', ae.sniffArchiveFormat(Buffer.from('hello world!')) === null);
  check('short buffer is null', ae.sniffArchiveFormat(Buffer.from([0x50])) === null);

  console.log('\n── resolveEntryPath (zip-slip boundary) ──');
  const root = path.resolve(tmpRoot, 'root');
  const safe = ae.resolveEntryPath(root, 'docs/readme.txt');
  check('normal nested path is allowed', safe.ok === true, safe.rel);
  check('backslashes are normalised', ae.resolveEntryPath(root, 'a\\b.txt').rel === 'a/b.txt');
  check('"./x" is allowed', ae.resolveEntryPath(root, './x.txt').ok === true);
  check('../escape refused', ae.resolveEntryPath(root, '../evil.txt').reason === 'parent-traversal');
  check('nested .. refused', ae.resolveEntryPath(root, 'a/../../evil.txt').reason === 'parent-traversal');
  check('absolute /etc/passwd refused', ae.resolveEntryPath(root, '/etc/passwd').reason === 'absolute-path');
  check('drive letter refused', ae.resolveEntryPath(root, 'C:\\Windows\\x.dll').reason === 'drive-letter');
  check('UNC path refused', ae.resolveEntryPath(root, '\\\\server\\share\\x').reason === 'unc-path');
  check('NUL byte refused', ae.resolveEntryPath(root, 'a\u0000b').reason === 'control-char');
  check('NTFS alternate data stream refused', ae.resolveEntryPath(root, 'readme.txt:zone.identifier').reason === 'ntfs-ads');
  check('reserved device name refused', ae.resolveEntryPath(root, 'CON').reason === 'reserved-name');
  check('reserved device name with extension refused', ae.resolveEntryPath(root, 'logs/NUL.txt').reason === 'reserved-name');
  check('empty name refused', ae.resolveEntryPath(root, '').reason === 'empty-name');
  check('root itself refused', ae.resolveEntryPath(root, '.').ok === false);

  console.log('\n── extractZip: happy path ──');
  const zip = writeZip('sample.zip', [
    { name: 'readme.txt', data: 'hello archive', method: 8 },
    { name: 'bin/stored.bin', data: Buffer.from([0, 1, 2, 3, 4, 250]), method: 0 },
    { name: 'nested/deep/note.txt', data: 'deep', method: 8 },
    { name: 'empty/', data: '', method: 0, mode: 0o40755 },
  ]);
  const res = await ae.extractZip(zip);
  check('extraction succeeds', res.ok === true, res.reason || '');
  check('three files extracted', res.extracted.length === 3, res.extracted.join(','));
  check('nothing skipped', res.skipped.length === 0, JSON.stringify(res.skipped));
  check('dest dir is named after the archive', path.basename(res.destDir) === 'sample');
  const readme = fs.readFileSync(path.join(res.destDir, 'readme.txt'), 'utf8');
  check('deflated content is byte-exact', readme === 'hello archive', readme);
  const stored = fs.readFileSync(path.join(res.destDir, 'bin', 'stored.bin'));
  check('stored content is byte-exact', stored.equals(Buffer.from([0, 1, 2, 3, 4, 250])));
  check('nested directory created', fs.existsSync(path.join(res.destDir, 'nested', 'deep', 'note.txt')));
  check('explicit dir entry created', fs.existsSync(path.join(res.destDir, 'empty')));

  console.log('\n── extractZip: attack cases ──');
  const slip = writeZip('slip.zip', [
    { name: 'good.txt', data: 'ok' },
    { name: '../escaped.txt', data: 'pwned' },
    { name: '/abs-escaped.txt', data: 'pwned' },
    { name: 'C:/drive-escaped.txt', data: 'pwned' },
    { name: 'a/../../deep-escape.txt', data: 'pwned' },
    { name: 'link', data: '/etc/passwd', mode: 0o120777 }, // S_IFLNK | 0777
  ]);
  const slipRes = await ae.extractZip(slip);
  const reasons = slipRes.skipped.map((s) => s.reason).sort();
  check('only the safe entry extracted', slipRes.extracted.length === 1, slipRes.extracted.join(','));
  check('parent traversal refused', reasons.includes('parent-traversal'));
  check('absolute path refused', reasons.includes('absolute-path'));
  check('drive letter refused', reasons.includes('drive-letter'));
  check('symlink entry refused', reasons.includes('symlink'));
  const outside = [
    path.join(path.dirname(slipRes.destDir), 'escaped.txt'),
    path.join(path.dirname(path.dirname(slipRes.destDir)), 'escaped.txt'),
    path.join(tmpRoot, 'abs-escaped.txt'),
  ];
  check('no file escaped the destination', outside.every((p) => !fs.existsSync(p)), outside.join(' | '));

  console.log('\n── extractZip: integrity + unsupported ──');
  const badCrc = writeZip('badcrc.zip', [
    { name: 'corrupt.txt', data: 'original bytes', crcOverride: 0xDEADBEEF },
  ]);
  const badCrcRes = await ae.extractZip(badCrc);
  check('CRC mismatch is refused', badCrcRes.skipped.some((s) => s.reason === 'crc-mismatch'));
  check('corrupt file is NOT written', !fs.existsSync(path.join(badCrcRes.destDir, 'corrupt.txt')));
  check('bad-CRC archive reports not ok', badCrcRes.ok === false);

  const bzip = writeZip('method12.zip', [{ name: 'x.bin', data: 'abc', method: 8 }]);
  // Patch the CENTRAL directory method field (the reader trusts the central
  // record, not the local header), so the entry claims an unsupported codec.
  {
    const buf = fs.readFileSync(bzip);
    const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cdOffset = buf.readUInt32LE(eocdAt + 16);
    buf.writeUInt16LE(12, cdOffset + 10);
    fs.writeFileSync(bzip, buf);
  }
  const bzipRes = await ae.extractZip(bzip);
  check('unsupported compression method skipped', bzipRes.skipped.some((s) => /unsupported-compression-12/.test(s.reason)));

  const sevenZip = tmpPath('thing.zip'); // deliberately mislabelled extension
  fs.writeFileSync(sevenZip, Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]));
  const sevenRes = await ae.extractArchive(sevenZip);
  check('7z content is refused by magic, not extension', sevenRes.reason === 'unsupported-format: 7z', sevenRes.reason);
  check('7z refusal keeps format in the result', sevenRes.format === '7z');

  const rar = tmpPath('thing.rar');
  fs.writeFileSync(rar, Buffer.from('Rar!\x1a\x07\x00', 'latin1'));
  check('RAR refused', (await ae.extractArchive(rar)).reason === 'unsupported-format: rar');

  const text = tmpPath('notes.zip');
  fs.writeFileSync(text, 'this is not a zip at all, just text');
  const textRes = await ae.extractArchive(text);
  check('non-archive refused', textRes.reason === 'not-an-archive', textRes.reason);

  const missing = path.join(tmpRoot, 'does-not-exist.zip');
  const missingRes = await ae.extractArchive(missing);
  check('missing file refused without throwing', missingRes.ok === false && !!missingRes.reason, missingRes.reason);

  console.log('\n── extractZip: caps + collisions ──');
  const many = writeZip('many.zip', [
    { name: 'a.txt', data: 'a' }, { name: 'b.txt', data: 'b' }, { name: 'c.txt', data: 'c' },
  ]);
  const capped = await ae.extractZip(many, { maxEntries: 1 });
  check('entry cap is enforced', capped.reason === 'too-many-entries', capped.reason);

  const tinyCap = await ae.extractZip(many, { maxTotalBytes: 1 });
  check('total-size cap stops extraction',
    tinyCap.skipped.some((s) => s.reason === 'total-size-cap') && tinyCap.extracted.length < 3,
    `extracted=${tinyCap.extracted.length} skipped=${tinyCap.skipped.length}`);

  const first = await ae.extractZip(many);
  const second = await ae.extractZip(many);
  check('repeated extraction never reuses a folder', second.destDir !== first.destDir, `${path.basename(first.destDir)} → ${path.basename(second.destDir)}`);
  check('the second folder is numbered', /^many \(\d+\)$/.test(path.basename(second.destDir)), path.basename(second.destDir));
  check('first folder untouched', fs.existsSync(path.join(first.destDir, 'a.txt')));

  const dirA = await ae.uniqueDir(tmpRoot, 'x');
  fs.mkdirSync(dirA, { recursive: true });
  const dirB = await ae.uniqueDir(tmpRoot, 'x');
  check('uniqueDir increments', path.basename(dirB) === 'x (2)', dirB);

  console.log('\n── bounded streaming (APP-010) ──');
  // A real 16 MB entry must round-trip byte-exact through the streamed path.
  {
    const big = Buffer.alloc(16 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xFF; // not all zeros
    const p = writeZip('big.zip', [{ name: 'big.bin', data: big }]);
    const res = await ae.extractZip(p);
    const out = res.destDir ? fs.readFileSync(path.join(res.destDir, 'big.bin')) : Buffer.alloc(0);
    check('16 MB deflated entry extracts byte-exact', res.ok && out.length === big.length && out.equals(big));
  }
  // A big STORED entry takes the no-inflater path.
  {
    const storedData = Buffer.alloc(4 * 1024 * 1024, 0x5A);
    const p = writeZip('stored-big.zip', [{ name: 'plain.bin', data: storedData, method: 0 }]);
    const res = await ae.extractZip(p);
    const out = res.destDir ? fs.readFileSync(path.join(res.destDir, 'plain.bin')) : Buffer.alloc(0);
    check('4 MB stored entry extracts byte-exact', res.ok && out.equals(storedData));
  }
  // Zip bomb: headers claim 1 KB, the stream actually inflates to 64 MB. The
  // per-entry leak must stop it mid-stream and leave no partial file.
  {
    const bombData = Buffer.alloc(64 * 1024 * 1024, 0); // deflates to ~64 KB
    const p = writeZip('bomb.zip', [{ name: 'bomb.bin', data: bombData, declaredSize: 1024 }]);
    const before = process.memoryUsage().rss;
    const res = await ae.extractZip(p, { maxEntryBytes: 1024 * 1024 });
    const rssDelta = process.memoryUsage().rss - before;
    const leaked = res.destDir ? fs.readdirSync(res.destDir) : [];
    check('zip bomb is refused, not written',
      !res.ok && res.skipped.some(s => s.reason === 'entry-size-cap'),
      res.skipped.map(s => s.reason).join(','));
    check('zip bomb leaves no partial file', leaked.length === 0, leaked.join(','));
    check('zip bomb memory stays far below the real payload', rssDelta < 48 * 1024 * 1024,
      `${(rssDelta / 1048576).toFixed(1)} MiB`);
  }
  // A cap that is hit exactly at a legit size still succeeds (>= vs >).
  {
    const exact = Buffer.alloc(1024 * 1024, 7);
    const p = writeZip('exact.zip', [{ name: 'exact.bin', data: exact }]);
    const res = await ae.extractZip(p, { maxEntryBytes: exact.length });
    check('entry exactly at the cap extracts', res.ok && res.extracted.length === 1);
  }
  // EEXIST safety: an existing file is never deleted by the stream cleanup.
  {
    const existing = tmpPath('existing.bin');
    fs.writeFileSync(existing, 'PRE-EXISTING');
    const fh = await fs.promises.open(existing, 'r');
    const verdict = await ae._streamEntryToFile(fh, 0, {
      name: 'existing.bin', method: 0, compressedSize: 3,
      uncompressedSize: 3, crc32: ae.crc32(Buffer.from('abc')),
    }, existing, { overwrite: false, maxEntryBytes: 1024 });
    await fh.close();
    check('collision reports already-exists', verdict.ok === false && verdict.reason === 'already-exists', verdict.reason);
    check('collision keeps the existing file', fs.readFileSync(existing, 'utf8') === 'PRE-EXISTING');
  }

  console.log('\n── empty / degenerate archives ──');
  const emptyZip = tmpPath('empty.zip');
  const eocdOnly = Buffer.alloc(22);
  eocdOnly.writeUInt32LE(0x06054b50, 0);
  fs.writeFileSync(emptyZip, eocdOnly);
  const emptyRes = await ae.extractZip(emptyZip);
  check('empty archive reports a reason', emptyRes.ok === false && emptyRes.reason === 'empty-archive', emptyRes.reason);

  const truncated = tmpPath('truncated.zip');
  fs.writeFileSync(truncated, makeZip([{ name: 'a.txt', data: 'hello' }]).subarray(0, 40));
  const truncRes = await ae.extractZip(truncated);
  check('truncated archive refused', truncRes.ok === false && !!truncRes.reason, truncRes.reason);

  // Cleanup
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
