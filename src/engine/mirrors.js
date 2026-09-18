// @ts-check
class Mirror {
  /**
   * @param {string} url
   * @param {string} host
   */
  constructor(url, host) {
    this.url = url;
    this.host = host;
    this.active = 0;
    this.failures = 0;
    this.consecutiveFailures = 0;
    this.tested = false;
    this.banned = false;
    this.speedEma = 0;
    this.lastError = null;
  }

  snapshot() {
    return {
      url: this.url,
      host: this.host,
      active: this.active,
      failures: this.failures,
      banned: this.banned,
      tested: this.tested,
      speed: this.speedEma,
    };
  }
}

/**
 * aria2-style feedback URI selector: untested mirrors are probed first, then the
 * fastest known mirror wins while respecting the per-host connection cap.
 */
class MirrorPool {
  /**
   * @param {string[]} urls
   * @param {number} maxPerServer
   * @param {number} [banAfterConsecutive]
   */
  constructor(urls, maxPerServer, banAfterConsecutive = 3) {
    this.maxPerServer = maxPerServer;
    this.banAfterConsecutive = banAfterConsecutive;
    const seen = new Set();
    this.mirrors = [];
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      this.mirrors.push(new Mirror(url, safeHost(url)));
    }
  }

  get all() {
    return this.mirrors;
  }

  get primary() {
    return this.mirrors[0];
  }

  get lastError() {
    for (let i = this.mirrors.length - 1; i >= 0; i--) {
      if (this.mirrors[i].lastError) return this.mirrors[i].lastError;
    }
    return null;
  }

  /**
   * @param {string} host
   */
  hostActive(host) {
    return this.mirrors.reduce((n, m) => n + (m.host === host ? m.active : 0), 0);
  }

  available() {
    return this.mirrors.filter((m) => !m.banned && this.hostActive(m.host) < this.maxPerServer);
  }

  hasCapacity() {
    return this.available().length > 0;
  }

  /**
   * @param {Mirror} to
   */
  hasAlternative(to) {
    return this.mirrors.some((m) => m !== to && !m.banned);
  }

  /**
   * @returns {Mirror | null}
   */
  select() {
    const avail = this.available();
    if (avail.length === 0) return null;
    const untested = avail.filter((m) => !m.tested);
    if (untested.length > 0) return untested[0];
    avail.sort((a, b) => b.speedEma - a.speedEma || a.active - b.active);
    return avail[0];
  }

  /**
   * @param {Mirror} m
   */
  acquire(m) {
    m.active++;
  }

  /**
   * @param {Mirror} m
   */
  release(m) {
    m.active = Math.max(0, m.active - 1);
  }

  /**
   * @param {Mirror} m
   * @param {number} bytes
   * @param {number} elapsedMs
   */
  reportSuccess(m, bytes, elapsedMs) {
    m.tested = true;
    m.consecutiveFailures = 0;
    if (elapsedMs > 0 && bytes > 0) {
      const speed = bytes / (elapsedMs / 1000);
      m.speedEma = m.speedEma === 0 ? speed : 0.7 * m.speedEma + 0.3 * speed;
    }
  }

  /**
   * @param {Mirror} m
   * @param {any} err
   */
  reportFailure(m, err) {
    m.tested = true;
    m.failures++;
    m.consecutiveFailures++;
    m.lastError = err.message;
    const hasOthers = this.hasAlternative(m);
    if (hasOthers && (!err.retryable || m.consecutiveFailures >= this.banAfterConsecutive)) {
      m.banned = true;
    }
  }

  /**
   * @param {Mirror} m
   * @param {string} finalUrl
   */
  updateUrl(m, finalUrl) {
    if (finalUrl && finalUrl !== m.url) m.url = finalUrl;
  }

  snapshot() {
    return this.mirrors.map((m) => m.snapshot());
  }
}

/**
 * @param {string} url
 */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

module.exports = {
  Mirror,
  MirrorPool,
};
