// @ts-check
const { sleep } = require('./utils');

const MIN_BURST = 64 * 1024;

/**
 * Token bucket used for traffic shaping. Workers call `acquire(n)` before
 * consuming `n` bytes; when the bucket runs dry the caller sleeps until it refills.
 * A rate of 0 disables limiting. Buckets can be stacked (global + per-task).
 */
class TokenBucket {
  /**
   * @param {number} [bytesPerSecond]
   */
  constructor(bytesPerSecond = 0) {
    this.rate = 0;
    this.burst = MIN_BURST;
    this.tokens = 0;
    this.last = performance.now();
    this.setRate(bytesPerSecond);
  }

  get bytesPerSecond() {
    return this.rate;
  }

  /**
   * @param {number} bytesPerSecond
   */
  setRate(bytesPerSecond) {
    this.refill();
    this.rate = Math.max(0, Math.floor(bytesPerSecond));
    this.burst = Math.max(MIN_BURST, this.rate / 4);
    this.tokens = Math.min(this.tokens, this.burst);
  }

  /**
   * @param {number} bytes
   * @returns {Promise<void>}
   */
  async acquire(bytes) {
    if (this.rate <= 0 || bytes <= 0) return;
    this.refill();
    this.tokens -= bytes;
    if (this.tokens >= 0) return;
    const waitMs = (-this.tokens / this.rate) * 1000;
    await sleep(waitMs);
  }

  refill() {
    const now = performance.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    if (this.rate <= 0) {
      this.tokens = this.burst;
      return;
    }
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
  }
}

module.exports = {
  TokenBucket,
};
