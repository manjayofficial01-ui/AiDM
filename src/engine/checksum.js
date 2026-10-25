// @ts-check
const { createHash } = require('crypto');
const { createReadStream } = require('fs');
const { pipeline } = require('stream/promises');
const { DownloadError } = require('./errors');

/**
 * Checksum input handling.
 *
 * The value users paste comes from a hundred different places: a release page
 * (`SHA-256: abc…`), a `.sha256` file (`abc…  file.zip`), a forum post
 * (`0xabc…`), a grouped digest (`ab:cd:ef…`). FDM has a documented bug here —
 * it compares case-sensitively, so an uppercase digest reports "Verification
 * Failed" on a perfectly good file (their ticket #272855).
 *
 * AiDM already lowercased, but had two silent failure modes of its own:
 *   1. a digest of the wrong length was accepted and then compared against a
 *      real hash — always a mismatch, with a message that blamed the file;
 *   2. the algorithm had to be declared by the caller, so a bare 64-char
 *      digest could not be recognised as SHA-256 at all.
 *
 * Both are now hard errors with an explanation, and the algorithm is inferred
 * from the digest length when it is not given.
 */

const ALGORITHM_ALIASES = {
  md5: 'md5',
  'md-5': 'md5',
  sha1: 'sha1',
  'sha-1': 'sha1',
  sha256: 'sha256',
  'sha-256': 'sha256',
  sha512: 'sha512',
  'sha-512': 'sha512',
};

/** Hex characters per algorithm. A digest of any other length cannot be valid. */
const DIGEST_HEX_LENGTHS = {
  md5: 32,
  sha1: 40,
  sha256: 64,
  sha512: 128,
};

const LENGTH_TO_ALGORITHM = Object.fromEntries(
  Object.entries(DIGEST_HEX_LENGTHS).map(([alg, len]) => [len, alg]),
);

/**
 * Split an optional algorithm prefix off a pasted digest.
 * Accepts `sha256:abc…`, `SHA-256=abc…`, `sha256 abc…`.
 * @param {string} raw
 * @returns {{ algorithm: string|null, value: string }}
 */
function splitAlgorithmPrefix(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const m = /^([A-Za-z][A-Za-z0-9-]{1,15})\s*[:=]\s*(.+)$/.exec(text) ||
    /^([A-Za-z][A-Za-z0-9-]{1,15})\s+(.+)$/.exec(text);
  if (m && ALGORITHM_ALIASES[m[1].toLowerCase()]) {
    return { algorithm: m[1], value: m[2] };
  }
  return { algorithm: null, value: text };
}

/**
 * Normalise a digest to bare lowercase hex: drop `0x`, whitespace and the
 * colon/dash grouping some tools print.
 * @param {string} raw
 * @returns {string}
 */
function cleanDigest(raw) {
  let value = String(raw == null ? '' : raw).trim();
  value = value.replace(/^0x/i, '');
  // `ab:cd:ef` and `ab cd ef` grouping, plus a trailing " file.zip" column
  // from `.sha256` files (the digest is the first token).
  if (/^[0-9a-fA-F]{2}([:\s-][0-9a-fA-F]{2})+$/.test(value)) {
    value = value.replace(/[:\s-]/g, '');
  } else if (/^[0-9a-fA-F]+\s+\S/.test(value)) {
    value = value.split(/\s+/)[0];
  }
  return value.replace(/\s+/g, '').toLowerCase();
}

/**
 * Infer the algorithm from a digest's length.
 * @param {string} hex
 * @returns {string|null}
 */
function detectAlgorithm(hex) {
  return LENGTH_TO_ALGORITHM[String(hex || '').length] || null;
}

/**
 * @typedef {{ algorithm: string, value: string }} NormalizedChecksum
 */

/**
 * Validate and normalise a checksum.
 *
 * @param {{ algorithm?: string|null, value: string }|string} input
 *        an object, or a bare string like `"sha256:abc…"` / `"abc…"`
 * @returns {NormalizedChecksum}
 * @throws {DownloadError} CHECKSUM_MISMATCH on anything unusable
 */
function normalizeChecksum(input) {
  let algorithmHint = null;
  let rawValue = '';

  if (typeof input === 'string') {
    const split = splitAlgorithmPrefix(input);
    algorithmHint = split.algorithm;
    rawValue = split.value;
  } else if (input && typeof input === 'object') {
    rawValue = input.value;
    algorithmHint = input.algorithm || null;
    // Some callers store the whole "sha256:abc…" string in `value`.
    if (!algorithmHint && typeof rawValue === 'string') {
      const split = splitAlgorithmPrefix(rawValue);
      if (split.algorithm) {
        algorithmHint = split.algorithm;
        rawValue = split.value;
      }
    }
  } else {
    throw new DownloadError('CHECKSUM_MISMATCH', 'Checksum is missing');
  }

  const value = cleanDigest(rawValue);
  if (!value) throw new DownloadError('CHECKSUM_MISMATCH', 'Checksum is empty');
  if (!/^[0-9a-f]+$/.test(value)) {
    throw new DownloadError('CHECKSUM_MISMATCH', 'Checksum must be a hex digest');
  }

  let algorithm;
  if (algorithmHint) {
    const resolved = ALGORITHM_ALIASES[String(algorithmHint).trim().toLowerCase()];
    if (!resolved) {
      throw new DownloadError('CHECKSUM_MISMATCH', `Unsupported hash algorithm: ${algorithmHint}`);
    }
    const expectedLength = DIGEST_HEX_LENGTHS[resolved];
    if (value.length !== expectedLength) {
      throw new DownloadError(
        'CHECKSUM_MISMATCH',
        `${resolved.toUpperCase()} digests are ${expectedLength} hex characters, ` +
        `but this one is ${value.length} — check that the digest matches the algorithm`,
      );
    }
    algorithm = resolved;
  } else {
    const detected = detectAlgorithm(value);
    if (!detected) {
      throw new DownloadError(
        'CHECKSUM_MISMATCH',
        `Cannot tell which algorithm a ${value.length}-character digest uses ` +
        `(expected 32 for MD5, 40 for SHA-1, 64 for SHA-256, 128 for SHA-512)`,
      );
    }
    algorithm = detected;
  }

  return { algorithm, value };
}

/**
 * @param {string} path
 * @param {string} algorithm
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function hashFile(path, algorithm, signal) {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(path, { highWaterMark: 1024 * 1024 }), hash, { signal });
  return hash.digest('hex');
}

/**
 * @param {string} path
 * @param {{ algorithm?: string|null, value: string }|string} checksum
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function verifyChecksum(path, checksum, signal) {
  const expected = normalizeChecksum(checksum);
  const actual = await hashFile(path, expected.algorithm, signal);
  if (actual !== expected.value) {
    throw new DownloadError(
      'CHECKSUM_MISMATCH',
      `${expected.algorithm} mismatch: expected ${expected.value}, got ${actual}`,
    );
  }
}

module.exports = {
  normalizeChecksum,
  hashFile,
  verifyChecksum,
  // Exported for the UI and for tests: lets a caller show "detected SHA-256"
  // before downloading instead of after a failed verification.
  detectAlgorithm,
  splitAlgorithmPrefix,
  cleanDigest,
  ALGORITHM_ALIASES,
  DIGEST_HEX_LENGTHS,
  LENGTH_TO_ALGORITHM,
};
