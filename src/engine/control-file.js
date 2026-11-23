// @ts-check
const { open, readFile, rename, rm, writeFile } = require('fs/promises');
const path = require('path');

const CONTROL_FILE_VERSION = 1;

/**
 * @param {string} partPath
 * @returns {string}
 */
function controlFilePath(partPath) {
  return `${partPath}.meta`;
}

/**
 * Crash-safe persistence of the segment bitmap.
 *
 * The bitmap claims which bytes are on disk, so it must not outlive them:
 * the data is fsynced by the task BEFORE this runs (see DownloadTask.
 * saveControl). Here the temp file itself is fsynced and the directory entry
 * is flushed after the rename, so a power loss can lose the whole control
 * file (the task then re-downloads — safe) but can never leave a bitmap that
 * claims bytes the disk does not have (unsafe).
 *
 * @param {string} filePath
 * @param {object} data
 * @returns {Promise<void>}
 */
async function saveControlFile(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  try {
    const handle = await open(tmp, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (e) {
    // fsync is unavailable on some filesystems — the rename below is still
    // atomic, so the file is either the old one or the new one.
  }
  await rename(tmp, filePath);
  try {
    // Flush the directory entry so the rename itself survives a power loss.
    const dir = await open(path.dirname(filePath), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (e) {
    // Windows cannot fsync a directory handle — the rename is still atomic.
  }
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
