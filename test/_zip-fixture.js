// Shared test fixture: write REAL ZIP bytes without any dependency.
// Not a suite — `test/run-all.js` skips files starting with `_`.
const zlib = require('zlib');
const ae = require('../src/archive-extract');

/**
 * `declaredSize` writes a LIE into both headers (the data actually inflates to
 * the real length) — the fixture for a bounded-streaming zip bomb.
 *
 * @param {{ name: string, data?: Buffer|string, method?: 0|8, mode?: number,
 *           crcOverride?: number, dataOverride?: Buffer,
 *           declaredSize?: number }[]} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '', 'utf8');
    const method = e.method === undefined ? 8 : e.method;
    const payload = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = e.crcOverride !== undefined ? e.crcOverride : ae.crc32(data);
    const stored = e.dataOverride || payload;
    const declaredSize = e.declaredSize !== undefined ? e.declaredSize : data.length;
    const mode = e.mode === undefined ? 0o100644 : e.mode; // regular file, 0644

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { makeZip };
