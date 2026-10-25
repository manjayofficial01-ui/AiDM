// @ts-check
'use strict';

/**
 * Dependency-free archive extraction for the post-download pipeline.
 *
 * Why not a library: AiDM ships zero native builds by design (see
 * docs/HTTP3-ASSESSMENT.md) and adding an unzip dependency for one feature is
 * a supply-chain cost we do not need. ZIP's container format is simple enough
 * to read directly, and `zlib.inflateRawSync` already does the only hard part.
 *
 * Supported: ZIP (stored + deflate, Zip64, CRC-verified).
 * Deliberately refused, with a recorded reason instead of a silent failure:
 * 7z, RAR, tar, gzip, and AES-encrypted ZIP entries — no bundled decoder, and
 * pretending otherwise would hand the user a corrupt folder.
 *
 * SECURITY — this module writes attacker-influenced paths to disk, so every
 * entry name is treated as hostile:
 *   - absolute paths, drive letters, UNC prefixes and any `..` segment are refused
 *   - the resolved path must still be inside the destination root after resolution
 *   - symlink entries are refused (a symlink could redirect a later write out of tree)
 *   - NUL bytes and control characters are refused
 *   - entry count and total uncompressed bytes are capped (zip-bomb guard)
 * A refused entry is reported in `skipped`, never extracted, and never fatal.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const DEFAULT_MAX_ENTRIES = 20000;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB uncompressed
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;  // 2 GB per entry
const CHUNK = 64 * 1024;

/** @typedef {{ name: string, method: number, compressedSize: number, uncompressedSize: number,
 *              localOffset: number, flags: number, externalAttrs: number, crc32: number }} ZipEntry */

// ── CRC-32 (IEEE 802.3, the polynomial ZIP uses) ────────────────────────────
// Table built once; used to verify every entry so a truncated/patched archive
// cannot silently produce a corrupt file.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

/**
 * @param {Buffer} buf
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number} unsigned CRC-32
 */
function crc32(buf, start = 0, end = buf.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Container detection ─────────────────────────────────────────────────────

/**
 * Identify an archive by magic bytes. Never trusts the file extension: a
 * ".zip" that is really a 7z must not be handed to the ZIP reader.
 * @param {Buffer} head first ~512 bytes of the file
 * @returns {'zip'|'7z'|'rar'|'gz'|'tar'|'bz2'|'xz'|null}
 */
function sniffArchiveFormat(head) {
  if (!head || head.length < 4) return null;
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // PK\x03\x04 (local), PK\x05\x06 (empty archive), PK\x07\x08 (spanned)
    if (head[2] === 0x03 && head[3] === 0x04) return 'zip';
    if (head[2] === 0x05 && head[3] === 0x06) return 'zip';
    if (head[2] === 0x07 && head[3] === 0x08) return 'zip';
  }
  if (head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) return '7z';
  if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) return 'rar';
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gz';
  if (head.length > 262 && head.toString('latin1', 257, 262) === 'ustar') return 'tar';
  if (head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) return 'bz2';
  if (head[0] === 0xfd && head[1] === 0x37 && head[2] === 0x7a && head[3] === 0x58) return 'xz';
  return null;
}

/** @param {string} p @returns {Promise<string|null>} */
async function sniffFileFormat(p) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return sniffArchiveFormat(buf.subarray(0, bytesRead));
  } catch (e) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// ── End of central directory ────────────────────────────────────────────────

/**
 * Locate the End Of Central Directory record. It sits at the very end of the
 * file minus a comment of up to 64 KB, so the scan is bounded.
 * @param {Buffer} tail last min(fileSize, 65557) bytes
 * @param {number} tailStart absolute file offset where `tail` begins
 * @returns {{ centralDirOffset: number, entryCount: number, centralDirSize: number }|null}
 */
function findEocd(tail, tailStart = 0) {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    const entryCount = tail.readUInt16LE(i + 10);
    const centralDirSize = tail.readUInt32LE(i + 12);
    const centralDirOffset = tail.readUInt32LE(i + 16);
    const absEocd = tailStart + i;

    // Zip64: any saturated field means the real values live in the Zip64
    // record, reachable through the locator that precedes the EOCD.
    const needsZip64 = entryCount === 0xFFFF || centralDirSize === 0xFFFFFFFF ||
      centralDirOffset === 0xFFFFFFFF;
    if (needsZip64) {
      const zip64 = readZip64(tail, i);
      if (zip64) return zip64;
    }
    return { centralDirOffset, entryCount, centralDirSize };
  }
  return null;
}

/**
 * @param {Buffer} tail
 * @param {number} eocdIndex index of the EOCD inside `tail`
 * @returns {{ centralDirOffset: number, entryCount: number, centralDirSize: number }|null}
 */
function readZip64(tail, eocdIndex) {
  const locIndex = eocdIndex - 20;
  if (locIndex < 0) return null;
  if (tail.readUInt32LE(locIndex) !== SIG_EOCD64_LOCATOR) return null;
  const recordOffset = Number(tail.readBigUInt64LE(locIndex + 8));
  // The record offset is absolute; convert to an index in `tail` when possible.
  const base = tail.length - (eocdIndex + 22 - (tail.readUInt16LE(eocdIndex + 20) + 22));
  const idx = recordOffset - base;
  if (idx < 0 || idx + 56 > tail.length) return null;
  if (tail.readUInt32LE(idx) !== SIG_EOCD64) return null;
  const entryCount = Number(tail.readBigUInt64LE(idx + 32));
  const centralDirSize = Number(tail.readBigUInt64LE(idx + 40));
  const centralDirOffset = Number(tail.readBigUInt64LE(idx + 48));
  return { centralDirOffset, entryCount, centralDirSize };
}

// ── Central directory ───────────────────────────────────────────────────────

/**
 * Parse the central directory. Sizes and offsets are authoritative here, which
 * is why a streamed (bit-3 data-descriptor) archive still extracts correctly.
 * @param {Buffer} cd
 * @param {number} [limit]
 * @returns {ZipEntry[]}
 */
function parseCentralDirectory(cd, limit = DEFAULT_MAX_ENTRIES) {
  /** @type {ZipEntry[]} */
  const entries = [];
  let off = 0;
  while (off + 46 <= cd.length && entries.length < limit) {
    if (cd.readUInt32LE(off) !== SIG_CENTRAL) break;
    const flags = cd.readUInt16LE(off + 8);
    const method = cd.readUInt16LE(off + 10);
    const crc = cd.readUInt32LE(off + 16);
    let compressedSize = cd.readUInt32LE(off + 20);
    let uncompressedSize = cd.readUInt32LE(off + 24);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const externalAttrs = cd.readUInt32LE(off + 38);
    let localOffset = cd.readUInt32LE(off + 42);

    const nameBuf = cd.subarray(off + 46, off + 46 + nameLen);
    const name = nameBuf.toString(flags & 0x0800 ? 'utf8' : 'latin1');

    // Zip64 extended information (0x0001) replaces saturated fields, in the
    // fixed order the spec defines.
    if (uncompressedSize === 0xFFFFFFFF || compressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      const extra = cd.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen);
      const z64 = readZip64Extra(extra, {
        uncompressedSize: uncompressedSize === 0xFFFFFFFF,
        compressedSize: compressedSize === 0xFFFFFFFF,
        localOffset: localOffset === 0xFFFFFFFF,
      });
      if (z64) {
        if (z64.uncompressedSize != null) uncompressedSize = z64.uncompressedSize;
        if (z64.compressedSize != null) compressedSize = z64.compressedSize;
        if (z64.localOffset != null) localOffset = z64.localOffset;
      }
    }

    entries.push({
      name, method, compressedSize, uncompressedSize, localOffset,
      flags, externalAttrs, crc32: crc,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * @param {Buffer} extra
 * @param {{ uncompressedSize: boolean, compressedSize: boolean, localOffset: boolean }} want
 * @returns {{ uncompressedSize?: number, compressedSize?: number, localOffset?: number }|null}
 */
function readZip64Extra(extra, want) {
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const size = extra.readUInt16LE(off + 2);
    if (id === 0x0001) {
      /** @type {{ uncompressedSize?: number, compressedSize?: number, localOffset?: number }} */
      const out = {};
      let p = off + 4;
      const end = Math.min(off + 4 + size, extra.length);
      if (want.uncompressedSize && p + 8 <= end) { out.uncompressedSize = Number(extra.readBigUInt64LE(p)); p += 8; }
      if (want.compressedSize && p + 8 <= end) { out.compressedSize = Number(extra.readBigUInt64LE(p)); p += 8; }
      if (want.localOffset && p + 8 <= end) { out.localOffset = Number(extra.readBigUInt64LE(p)); p += 8; }
      return out;
    }
    off += 4 + size;
  }
  return null;
}

// ── Path safety ─────────────────────────────────────────────────────────────

/**
 * Resolve an archive entry name to a destination path, or refuse it.
 *
 * This is the zip-slip boundary. Order matters: the cheap syntactic checks
 * reject the obvious attacks before any filesystem call, and the final
 * `path.relative` containment check catches everything the syntax missed
 * (case folding, 8.3 short names, trailing dots on Windows).
 *
 * @param {string} root absolute destination root
 * @param {string} name entry name from the archive
 * @returns {{ ok: true, abs: string, rel: string } | { ok: false, reason: string }}
 */
function resolveEntryPath(root, name) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, reason: 'empty-name' };
  if (name.length > 1024) return { ok: false, reason: 'name-too-long' };
  if (/[\u0000-\u001f]/.test(name)) return { ok: false, reason: 'control-char' };

  const norm = name.replace(/\\/g, '/');
  // UNC first: `//host/share` is also "absolute", but naming it precisely makes
  // the refusal diagnosable instead of lumping it in with `/etc/passwd`.
  if (norm.startsWith('//')) return { ok: false, reason: 'unc-path' };
  if (norm.startsWith('/')) return { ok: false, reason: 'absolute-path' };
  if (/^[a-zA-Z]:/.test(norm)) return { ok: false, reason: 'drive-letter' };

  const segments = norm.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) return { ok: false, reason: 'parent-traversal' };
  if (segments.length === 0) return { ok: false, reason: 'empty-name' };

  const abs = path.resolve(root, ...segments);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'escapes-root' };
  }
  return { ok: true, abs, rel: rel.split(path.sep).join('/') };
}

/** POSIX mode bits live in the high 16 bits of the external attributes. */
function isSymlinkEntry(entry) {
  const mode = (entry.externalAttrs >>> 16) & 0xFFFF;
  return (mode & 0xF000) === 0xA000;
}

function isDirectoryEntry(entry) {
  return entry.name.endsWith('/') || entry.name.endsWith('\\');
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Choose a non-colliding output directory: `<parent>/<stem>`, then
 * `<parent>/<stem> (2)`, … Mirrors the "extract here" behaviour users expect
 * and never overwrites an existing folder.
 * @param {string} parent
 * @param {string} stem
 * @returns {Promise<string>}
 */
async function uniqueDir(parent, stem) {
  const base = stem.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'extracted';
  let candidate = path.join(parent, base);
  let n = 2;
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = path.join(parent, `${base} (${n++})`);
    } catch (e) {
      return candidate;
    }
  }
}

/**
 * Extract a ZIP archive into `<destDir or archive folder>/<archive stem>`.
 *
 * @param {string} archivePath
 * @param {{ destDir?: string, maxEntries?: number, maxTotalBytes?: number,
 *           maxEntryBytes?: number, overwrite?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, format: string, destDir: string|null,
 *   extracted: string[], skipped: { name: string, reason: string }[], reason?: string }>}
 */
async function extractZip(archivePath, opts = {}) {
  const maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = opts.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES;
  const maxEntryBytes = opts.maxEntryBytes || DEFAULT_MAX_ENTRY_BYTES;

  /** @type {{ ok: boolean, format: string, destDir: string|null, extracted: string[], skipped: { name: string, reason: string }[], reason?: string }} */
  const result = { ok: false, format: 'zip', destDir: null, extracted: [], skipped: [] };

  let fh;
  try {
    const stat = await fsp.stat(archivePath);
    if (!stat.isFile() || stat.size < 22) {
      result.reason = 'not-a-zip';
      return result;
    }
    fh = await fsp.open(archivePath, 'r');

    // Tail scan for the EOCD (bounded by the max 64 KB archive comment).
    const tailLen = Math.min(stat.size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, stat.size - tailLen);
    const eocd = findEocd(tail, stat.size - tailLen);
    if (!eocd) {
      result.reason = 'no-central-directory';
      return result;
    }
    if (eocd.centralDirOffset < 0 || eocd.centralDirOffset + eocd.centralDirSize > stat.size) {
      result.reason = 'corrupt-central-directory';
      return result;
    }

    const cd = Buffer.alloc(eocd.centralDirSize);
    if (eocd.centralDirSize > 0) {
      await fh.read(cd, 0, eocd.centralDirSize, eocd.centralDirOffset);
    }
    const entries = parseCentralDirectory(cd, maxEntries);
    if (!entries.length) {
      result.reason = 'empty-archive';
      return result;
    }
    if (eocd.entryCount > maxEntries) {
      result.reason = 'too-many-entries';
      return result;
    }

    const parent = opts.destDir ? path.resolve(opts.destDir) : path.dirname(archivePath);
    const stem = path.basename(archivePath, path.extname(archivePath));
    const destDir = await uniqueDir(parent, stem);
    await fsp.mkdir(destDir, { recursive: true });
    result.destDir = destDir;

    let totalBytes = 0;
    for (const entry of entries) {
      const resolved = resolveEntryPath(destDir, entry.name);
      if (!resolved.ok) {
        result.skipped.push({ name: entry.name, reason: resolved.reason });
        continue;
      }
      if (isSymlinkEntry(entry)) {
        result.skipped.push({ name: entry.name, reason: 'symlink' });
        continue;
      }
      if (isDirectoryEntry(entry)) {
        await fsp.mkdir(resolved.abs, { recursive: true });
        continue;
      }
      if (entry.flags & 0x0001) {
        result.skipped.push({ name: entry.name, reason: 'encrypted' });
        continue;
      }
      if (entry.method !== 0 && entry.method !== 8) {
        result.skipped.push({ name: entry.name, reason: `unsupported-compression-${entry.method}` });
        continue;
      }
      if (entry.uncompressedSize > maxEntryBytes) {
        result.skipped.push({ name: entry.name, reason: 'entry-too-large' });
        continue;
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > maxTotalBytes) {
        result.skipped.push({ name: entry.name, reason: 'total-size-cap' });
        break;
      }

      // Local header carries its OWN name/extra lengths — the central ones can
      // differ (extra fields are commonly rewritten), so they must be re-read.
      const locHead = Buffer.alloc(30);
      await fh.read(locHead, 0, 30, entry.localOffset);
      if (locHead.readUInt32LE(0) !== SIG_LOCAL) {
        result.skipped.push({ name: entry.name, reason: 'bad-local-header' });
        continue;
      }
      const locNameLen = locHead.readUInt16LE(26);
      const locExtraLen = locHead.readUInt16LE(28);
      const dataStart = entry.localOffset + 30 + locNameLen + locExtraLen;
      if (dataStart + entry.compressedSize > stat.size) {
        result.skipped.push({ name: entry.name, reason: 'truncated' });
        continue;
      }

      const raw = Buffer.alloc(entry.compressedSize);
      if (entry.compressedSize > 0) {
        await fh.read(raw, 0, entry.compressedSize, dataStart);
      }

      /** @type {Buffer} */
      let out;
      try {
        out = entry.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
      } catch (e) {
        result.skipped.push({ name: entry.name, reason: 'decompress-failed' });
        continue;
      }
      if (out.length !== entry.uncompressedSize || crc32(out) !== entry.crc32) {
        // A CRC mismatch means the bytes are not what the archive promised.
        // Writing them would hand the user a corrupt file that looks fine.
        result.skipped.push({ name: entry.name, reason: 'crc-mismatch' });
        continue;
      }

      await fsp.mkdir(path.dirname(resolved.abs), { recursive: true });
      await fsp.writeFile(resolved.abs, out, { flag: opts.overwrite ? 'w' : 'wx' })
        .catch(async (e) => {
          if (e.code !== 'EEXIST') throw e;
          result.skipped.push({ name: entry.name, reason: 'already-exists' });
          return null;
        });
      result.extracted.push(resolved.rel);
    }

    result.ok = result.extracted.length > 0;
    if (!result.ok && !result.reason) result.reason = 'nothing-extracted';
    return result;
  } catch (e) {
    result.reason = 'io-error: ' + (e && e.message ? e.message : String(e));
    return result;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * Extract any recognised archive. Non-ZIP formats return `ok: false` with a
 * precise reason so the UI can explain itself instead of failing silently.
 *
 * @param {string} archivePath
 * @param {{ destDir?: string }} [opts]
 * @returns {Promise<{ ok: boolean, format: string|null, destDir: string|null,
 *   extracted: string[], skipped: { name: string, reason: string }[], reason?: string }>}
 */
async function extractArchive(archivePath, opts = {}) {
  const format = await sniffFileFormat(archivePath);
  if (!format) {
    return { ok: false, format: null, destDir: null, extracted: [], skipped: [], reason: 'not-an-archive' };
  }
  if (format !== 'zip') {
    return {
      ok: false, format, destDir: null, extracted: [], skipped: [],
      reason: `unsupported-format: ${format}`,
    };
  }
  return extractZip(archivePath, opts);
}

module.exports = {
  sniffArchiveFormat,
  sniffFileFormat,
  findEocd,
  parseCentralDirectory,
  resolveEntryPath,
  extractZip,
  extractArchive,
  crc32,
  uniqueDir,
  // Exported for tests and for callers that want the caps without re-deriving them.
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
};
