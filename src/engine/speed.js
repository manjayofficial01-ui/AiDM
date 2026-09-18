// @ts-check
/**
 * Sliding-window throughput meter with an EMA-smoothed companion value.
 * The window is a ring of fixed-width time buckets so `add()` is O(1).
 */
class SpeedMeter {
  /**
   * @param {number} [windowMs]
   * @param {number} [bucketMs]
   * @param {number} [alpha]
   */
  constructor(windowMs = 5000, bucketMs = 250, alpha = 0.3) {
    this.windowMs = windowMs;
    this.bucketMs = bucketMs;
    this.alpha = alpha;
    this.buckets = new Array(Math.max(1, Math.ceil(windowMs / bucketMs))).fill(0);
    this.head = 0;
    this.headTime = Date.now();
    this.startTime = this.headTime;
    this.ema = 0;
    this.total = 0;
  }

  /**
   * @param {number} bytes
   */
  add(bytes) {
    this.advance();
    this.buckets[this.head] += bytes;
    this.total += bytes;
  }

  /**
   * Bytes per second over the sliding window.
   * @returns {number}
   */
  bytesPerSecond() {
    this.advance();
    const elapsed = Math.min(this.windowMs, Date.now() - this.startTime);
    const seconds = Math.max(this.bucketMs, elapsed) / 1000;
    let sum = 0;
    for (const b of this.buckets) sum += b;
    return sum / seconds;
  }

  /**
   * Call periodically (e.g. every tick) to fold the instantaneous speed into the EMA.
   * @returns {number}
   */
  sample() {
    const instant = this.bytesPerSecond();
    this.ema = this.ema === 0 ? instant : this.alpha * instant + (1 - this.alpha) * this.ema;
    return this.ema;
  }

  get smoothed() {
    return this.ema;
  }

  reset() {
    this.buckets.fill(0);
    this.head = 0;
    this.headTime = Date.now();
    this.startTime = this.headTime;
    this.ema = 0;
    this.total = 0;
  }

  advance() {
    const now = Date.now();
    const steps = Math.floor((now - this.headTime) / this.bucketMs);
    if (steps <= 0) return;
    if (steps >= this.buckets.length) {
      this.buckets.fill(0);
      this.head = 0;
      this.headTime = now;
      return;
    }
    for (let i = 0; i < steps; i++) {
      this.head = (this.head + 1) % this.buckets.length;
      this.buckets[this.head] = 0;
    }
    this.headTime += steps * this.bucketMs;
  }
}

module.exports = {
  SpeedMeter,
};
