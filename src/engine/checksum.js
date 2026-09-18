// @ts-check
const { createHash } = require('crypto');
const { createReadStream } = require('fs');
const { pipeline } = require('stream/promises');
const { DownloadError } = require('./errors');

const ALGORITHM_ALIASES = {
  md5: 'md5',
  sha1: 'sha1',
  'sha-1': 'sha1',
  sha256: 'sha256',
  'sha-256': 'sha256',
  sha512: 'sha512',
  'sha-512': 'sha512',
};

/**
 * @param {{ algorithm: string, value: string }} input
 * @returns {{ algorithm: string, value: string }}
 */
function normalizeChecksum(input) {
  const algorithm = ALGORITHM_ALIASES[input.algorithm.toLowerCase()];
  if (!algorithm) throw new DownloadError('CHECKSUM_MISMATCH', `Unsupported hash algorithm: ${input.algorithm}`);
  const value = input.value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(value)) {
    throw new DownloadError('CHECKSUM_MISMATCH', 'Checksum must be a hex digest');
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
 * @param {{ algorithm: string, value: string }} checksum
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
};
