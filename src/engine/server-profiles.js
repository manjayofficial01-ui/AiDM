'use strict';

const DEFAULT_MAX_HOSTS = 128;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SAVE_INTERVAL_MS = 5000;
const CONSECUTIVE_FAILURE_QUARANTINE = 3;
const QUARANTINE_MS = 15 * 60 * 1000;
const MAX_SPEED_SAMPLES = 20;

function safeOrigin(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function cleanNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

class ServerProfileStore {
  constructor(options = {}) {
    this.maxHosts = Math.max(4, Math.floor(options.maxHosts || DEFAULT_MAX_HOSTS));
    this.ttlMs = Math.max(60000, Math.floor(options.ttlMs || DEFAULT_TTL_MS));
    this.saveIntervalMs = Math.max(1000, Math.floor(options.saveIntervalMs || DEFAULT_SAVE_INTERVAL_MS));
    this.now = options.now || Date.now;
    this.persist = options.persist || null;
    this.entries = new Map();
    this._lastSave = 0;
    this._closed = false;
  }

  _entry(origin) {
    const existing = this.entries.get(origin);
    if (existing) return existing;
    const entry = {
      speedEma: 0,
      samples: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      quarantineUntil: 0,
      updatedAt: 0,
    };
    this.entries.set(origin, entry);
    return entry;
  }

  _prune(now = this.now()) {
    for (const [origin, entry] of this.entries) {
      if (now - cleanNumber(entry.updatedAt) > this.ttlMs) this.entries.delete(origin);
    }
    while (this.entries.size > this.maxHosts) {
      let oldestOrigin = null;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [origin, entry] of this.entries) {
        const updatedAt = cleanNumber(entry.updatedAt);
        if (updatedAt <= oldestTime) {
          oldestTime = updatedAt;
          oldestOrigin = origin;
        }
      }
      if (!oldestOrigin) break;
      this.entries.delete(oldestOrigin);
    }
  }

  _scheduleSave(force = false) {
    if (this._closed || !this.persist) return;
    const now = this.now();
    if (!force && now - this._lastSave < this.saveIntervalMs) return;
    this._lastSave = now;
    try {
      this.persist(this.toJSON());
    } catch (_) {
      /* best-effort, like the other engine caches */
    }
  }

  observeSuccess(origin, bytes, elapsedMs) {
    const cleanOrigin = safeOrigin(origin);
    const b = cleanNumber(bytes);
    const ms = cleanNumber(elapsedMs);
    if (!cleanOrigin || b <= 0 || ms <= 0) return null;
    const now = this.now();
    const entry = this._entry(cleanOrigin);
    const speed = (b * 1000) / ms;
    const alpha = entry.samples === 0 ? 1 : Math.min(0.3, 2 / (entry.samples + 2));
    entry.speedEma = entry.speedEma * (1 - alpha) + speed * alpha;
    entry.samples = Math.min(MAX_SPEED_SAMPLES, entry.samples + 1);
    entry.successes++;
    entry.consecutiveFailures = 0;
    entry.quarantineUntil = 0;
    entry.updatedAt = now;
    this._prune(now);
    this._scheduleSave();
    return { ...entry };
  }

  observeFailure(origin, retryable = true) {
    const cleanOrigin = safeOrigin(origin);
    if (!cleanOrigin) return null;
    const now = this.now();
    const entry = this._entry(cleanOrigin);
    entry.failures++;
    entry.consecutiveFailures++;
    if (!retryable || entry.consecutiveFailures >= CONSECUTIVE_FAILURE_QUARANTINE) {
      entry.quarantineUntil = now + QUARANTINE_MS;
    }
    entry.updatedAt = now;
    this._prune(now);
    this._scheduleSave();
    return { ...entry };
  }

  score(origin, now = this.now()) {
    const cleanOrigin = safeOrigin(origin);
    if (!cleanOrigin) return 0;
    const entry = this.entries.get(cleanOrigin);
    if (!entry || now - cleanNumber(entry.updatedAt) > this.ttlMs) return 0;
    if (entry.quarantineUntil > now) return 0;
    const confidence = Math.min(1, Math.max(0, entry.samples) / 3);
    const ageFactor = Math.max(0.25, 1 - (now - cleanNumber(entry.updatedAt)) / this.ttlMs);
    return cleanNumber(entry.speedEma) * confidence * ageFactor;
  }

  snapshot() {
    const out = [];
    for (const [origin, entry] of this.entries) {
      out.push({ origin, ...entry, score: this.score(origin) });
    }
    return out.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  }

  toJSON() {
    const hosts = {};
    for (const [origin, entry] of this.entries) hosts[origin] = { ...entry };
    return { version: 1, updatedAt: this.now(), hosts };
  }

  load(json) {
    this.entries.clear();
    if (!json || typeof json !== 'object' || json.version !== 1 || !json.hosts) return this;
    const now = this.now();
    for (const [rawOrigin, raw] of Object.entries(json.hosts)) {
      const origin = safeOrigin(rawOrigin);
      if (!origin || !raw || typeof raw !== 'object') continue;
      const updatedAt = cleanNumber(raw.updatedAt);
      if (updatedAt <= 0 || now - updatedAt > this.ttlMs) continue;
      this.entries.set(origin, {
        speedEma: cleanNumber(raw.speedEma),
        samples: Math.min(MAX_SPEED_SAMPLES, cleanNumber(raw.samples)),
        successes: cleanNumber(raw.successes),
        failures: cleanNumber(raw.failures),
        consecutiveFailures: cleanNumber(raw.consecutiveFailures),
        quarantineUntil: cleanNumber(raw.quarantineUntil),
        updatedAt,
      });
    }
    this._prune(now);
    return this;
  }

  flush() {
    this._scheduleSave(true);
  }

  close() {
    this.flush();
    this._closed = true;
  }
}

module.exports = {
  ServerProfileStore,
  DEFAULT_MAX_HOSTS,
  DEFAULT_TTL_MS,
  safeOrigin,
};
