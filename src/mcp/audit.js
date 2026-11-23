// @ts-check
'use strict';

/**
 * The audit log: a plain, append-only record of what an AI assistant asked
 * AiDM to do and what came of it.
 *
 * It exists because the app hands control to something else. When a user
 * asks "did the assistant download that?", this file is the answer — and it
 * is also the paper trail for the access level, the rate limit and the
 * refusals.
 *
 * Two rules:
 *   - No secrets. A URL's query string is redacted before it is written,
 *     because signed links carry tokens.
 *   - No unbounded growth. The file rotates at a size cap.
 */

const fs = require('fs');
const path = require('path');

const { sanitizeText } = require('./safety');

/** The log is rotated once it grows past this. */
const MAX_BYTES = 1024 * 1024;

/** How many rotated copies are kept. */
const KEEP_ROTATIONS = 3;

/**
 * Redact the query string of a URL: the parameter NAMES stay (they are
 * useful), the VALUES go (they are often tokens).
 * @param {unknown} raw
 * @returns {string}
 */
function redactUrl(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch (e) {
    return sanitizeText(text, 200);
  }
  if (!parsed.search) return sanitizeText(parsed.toString(), 300);
  const names = [];
  for (const part of parsed.search.replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const name = part.split('=')[0];
    if (name && !names.includes(name)) names.push(name);
  }
  const suffix = names.length ? `?${names.join('&')}=REDACTED` : '';
  return sanitizeText(`${parsed.origin}${parsed.pathname}${suffix}`, 300);
}

/**
 * The audit log.
 */
class AuditLog {
  /**
   * @param {{ file?: string, maxBytes?: number, keepRotations?: number }} [options]
   */
  constructor(options = {}) {
    this.file = options.file || require('./paths').auditLogFile();
    this.maxBytes = options.maxBytes || MAX_BYTES;
    this.keepRotations = options.keepRotations || KEEP_ROTATIONS;
  }

  /**
   * Write one entry. Never throws: an audit failure must not break a call.
   * @param {{ tool?: string, level?: string, outcome?: string, detail?: unknown }} entry
   * @returns {boolean} whether the entry was written
   */
  append(entry) {
    const record = {
      ts: new Date().toISOString(),
      tool: sanitizeText(entry && entry.tool, 60),
      level: sanitizeText(entry && entry.level, 20),
      outcome: sanitizeText(entry && entry.outcome, 40),
      detail: this._detail(entry && entry.detail),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this._rotateIfNeeded();
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * The newest entries, oldest first.
   * @param {number} [limit]
   * @returns {Array<object>}
   */
  read(limit = 50) {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      return [];
    }
    const lines = text.split('\n').filter(Boolean);
    const max = Math.max(1, Math.min(200, limit | 0 || 50));
    return lines
      .slice(-max)
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' ? parsed : { detail: sanitizeText(line, 200) };
        } catch (e) {
          return { detail: sanitizeText(line, 200) };
        }
      });
  }

  /**
   * Turn a detail value into something safe to store.
   * @param {unknown} detail
   * @returns {string}
   */
  _detail(detail) {
    if (detail == null) return '';
    if (typeof detail === 'string') return redactUrl(detail);
    try {
      return sanitizeText(JSON.stringify(detail), 300);
    } catch (e) {
      return '';
    }
  }

  /** Rotate the log when it grew past the cap. */
  _rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch (e) {
      return;
    }
    if (size < this.maxBytes) return;
    try {
      const oldest = `${this.file}.${this.keepRotations}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let i = this.keepRotations - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch (e) {
      // A failed rotation must never stop the app from logging.
    }
  }
}

module.exports = { AuditLog, redactUrl, MAX_BYTES, KEEP_ROTATIONS };
