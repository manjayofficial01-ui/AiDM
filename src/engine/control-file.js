// @ts-check
const { readFile, rename, rm, writeFile } = require('fs/promises');

const CONTROL_FILE_VERSION = 1;

/**
 * @param {string} partPath
 * @returns {string}
 */
function controlFilePath(partPath) {
  return `${partPath}.meta`;
}

/**
 * Crash-safe persistence of the segment bitmap:
 * write to a temp file, fsync-free rename for atomic replacement.
 * @param {string} path
 * @param {object} data
 * @returns {Promise<void>}
 */
async function saveControlFile(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, path);
}

/**
 * @param {string} path
 * @returns {Promise<any | null>}
 */
async function loadControlFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CONTROL_FILE_VERSION || !Array.isArray(parsed.segments) || typeof parsed.url !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @returns {Promise<void>}
 */
async function removeControlFile(path) {
  await rm(path, { force: true });
}

module.exports = {
  CONTROL_FILE_VERSION,
  controlFilePath,
  saveControlFile,
  loadControlFile,
  removeControlFile,
};
