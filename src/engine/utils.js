// @ts-check
const { access, stat } = require('fs/promises');
const { basename, dirname, extname, join } = require('path');

/**
 * @template T
 */
class Deferred {
  constructor() {
    this.settled = false;
    /** @type {(value: T) => void} */
    this.resolve = () => {};
    /** @type {(reason: unknown) => void} */
    this.reject = () => {};

    /** @type {Promise<T>} */
    this.promise = new Promise((res, rej) => {
      this.resolve = (value) => {
        if (this.settled) return;
        this.settled = true;
        res(value);
      };
      this.reject = (reason) => {
        if (this.settled) return;
        this.settled = true;
        rej(reason);
      };
    });
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {Promise<number | null>}
 */
async function fileSize(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @param {(candidate: string) => Promise<boolean>} alsoAvoid
 * @returns {Promise<string>}
 */
async function uniquePath(path, alsoAvoid) {
  if (!(await fileExists(path)) && !(await alsoAvoid(path))) return path;
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  for (let n = 1; n < 10000; n++) {
    const candidate = join(dir, `${stem} (${n})${ext}`);
    if (!(await fileExists(candidate)) && !(await alsoAvoid(candidate))) return candidate;
  }
  throw new Error(`Could not find a free filename for ${path}`);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  Deferred,
  sleep,
  fileExists,
  fileSize,
  uniquePath,
  clamp,
};
