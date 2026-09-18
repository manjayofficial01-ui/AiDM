// @ts-check
const { constants } = require('fs');
const { open } = require('fs/promises');
const { DownloadError } = require('./errors');

const ZERO_BLOCK = Buffer.alloc(4 * 1024 * 1024);

/**
 * Positional writer shared by all segment workers. Every write carries its own absolute
 * offset, so concurrent segments never contend on a cursor. Preallocation reserves the
 * final size up front.
 */
class SegmentFileWriter {
  /**
   * @param {import('fs/promises').FileHandle} handle
   * @param {string} path
   */
  constructor(handle, path) {
    this.handle = handle;
    this.path = path;
    this.closed = false;
  }

  /**
   * @param {string} path
   * @param {{ size: number | null, preallocation: 'none' | 'sparse' | 'full', fresh: boolean }} opts
   * @returns {Promise<SegmentFileWriter>}
   */
  static async open(path, opts) {
    let handle;
    try {
      handle = await open(path, constants.O_RDWR | constants.O_CREAT);
    } catch (err) {
      throw new DownloadError('IO', `Cannot open ${path}`, { cause: err });
    }
    const writer = new SegmentFileWriter(handle, path);
    try {
      if (opts.fresh) await handle.truncate(0);
      if (opts.size !== null && opts.size > 0) {
        await writer.preallocate(opts.size, opts.fresh ? opts.preallocation : 'sparse');
      }
    } catch (err) {
      await writer.close();
      throw err instanceof DownloadError ? err : new DownloadError('IO', `Cannot preallocate ${path}`, { cause: err });
    }
    return writer;
  }

  /**
   * @param {Uint8Array} chunk
   * @param {number} position
   * @returns {Promise<void>}
   */
  async write(chunk, position) {
    if (this.closed) throw new DownloadError('IO', 'Writer is closed');
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(chunk, offset, chunk.byteLength - offset, position + offset);
      if (bytesWritten <= 0) throw new DownloadError('IO', `Short write at offset ${position + offset}`);
      offset += bytesWritten;
    }
  }

  /**
   * @param {number} size
   * @returns {Promise<void>}
   */
  async truncate(size) {
    await this.handle.truncate(size);
  }

  async sync() {
    if (this.closed) return;
    await this.handle.sync();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  /**
   * @param {number} size
   * @param {'none' | 'sparse' | 'full'} mode
   */
  async preallocate(size, mode) {
    const stat = await this.handle.stat();
    if (mode === 'none') return;
    if (mode === 'sparse') {
      // Pin the file to the exact target size: a resumed .part that is longer
      // than the resource would otherwise be renamed into an oversized,
      // unplayable final file.
      if (stat.size !== size) await this.handle.truncate(size);
      return;
    }
    let position = stat.size;
    while (position < size) {
      const len = Math.min(ZERO_BLOCK.byteLength, size - position);
      await this.handle.write(ZERO_BLOCK, 0, len, position);
      position += len;
    }
  }
}

module.exports = {
  SegmentFileWriter,
};
