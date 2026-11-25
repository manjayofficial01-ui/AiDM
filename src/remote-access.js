// @ts-check
'use strict';

/**
 * Device-code pairing for a headless/remote AiDM node.
 *
 * Pure logic: no HTTP, no Electron, no disk. The local API owns the transport,
 * the main process owns the native approval dialog. A token is scope-limited
 * to QUEUE operations — never settings, never file deletion, never arbitrary
 * paths. Tokens and codes are held in memory only: an app restart revokes
 * every remote client, which is the safe default for a foundation release.
 */

const crypto = require('crypto');

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function normalizeCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase();
}

class RemoteAccess {
  /**
   * @param {{ now?: () => number, random?: () => string,
   *           codeTtlMs?: number, tokenTtlMs?: number }} [options]
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.random = typeof options.random === 'function' ? options.random : () => crypto.randomBytes(24).toString('hex');
    this.codeTtlMs = options.codeTtlMs || 5 * 60 * 1000;
    this.tokenTtlMs = options.tokenTtlMs || 30 * 24 * 60 * 60 * 1000;
    /** @type {Map<string, {status: string, createdAt: number, decidedAt?: number}>} */
    this.codes = new Map();
    /** @type {Map<string, {scope: string, createdAt: number, expiresAt: number, lastUsedAt?: number, uses?: number}>} */
    this.tokens = new Map();
    // Scope is deliberately a single fixed value: a remote client cannot ask
    // for more, and the API enforces an endpoint allowlist for this scope.
    this.scope = 'queue';
  }

  _prune() {
    const now = this.now();
    for (const [code, entry] of this.codes) {
      if (now - entry.createdAt > this.codeTtlMs) this.codes.delete(code);
    }
    for (const [hash, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(hash);
    }
  }

  /** Create a short-lived verification code for the native approval dialog. */
  requestCode() {
    this._prune();
    let code = '';
    for (let i = 0; i < 10 && !code; i++) {
      const hex = this.random().replace(/[^a-f0-9]/gi, '').toUpperCase();
      const candidate = `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
      if (candidate.length === 9 && !this.codes.has(candidate)) code = candidate;
    }
    if (!code) return null;
    this.codes.set(code, { status: 'pending', createdAt: this.now() });
    return { code, expiresAt: this.now() + this.codeTtlMs };
  }

  /** Main-process dialog result. Any non-true value is a denial. */
  setDecision(code, allowed) {
    const key = normalizeCode(code);
    const entry = this.codes.get(key);
    if (!entry || entry.status !== 'pending') return false;
    entry.status = allowed === true ? 'approved' : 'denied';
    entry.decidedAt = this.now();
    return entry.status === 'approved';
  }

  /**
   * CLI polling step. Returns `{ pending:true }` until the user decides,
   * then a one-time queue token. A code can never be exchanged twice.
   */
  exchange(code) {
    this._prune();
    const key = normalizeCode(code);
    const entry = this.codes.get(key);
    if (!entry) return { error: 'unknown-or-expired-code' };
    if (entry.status === 'pending') return { pending: true };
    if (entry.status === 'denied') { this.codes.delete(key); return { error: 'denied' }; }
    this.codes.delete(key);
    const token = `${this.random()}${this.random()}`;
    this.tokens.set(tokenHash(token), {
      scope: this.scope, createdAt: this.now(), expiresAt: this.now() + this.tokenTtlMs,
    });
    return { token, scope: this.scope };
  }

  /** Verify a token on an API request. Updates usage counters only. */
  verify(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 512) return null;
    this._prune();
    const hash = tokenHash(token);
    const entry = this.tokens.get(hash);
    if (!entry) return null;
    entry.lastUsedAt = this.now();
    entry.uses = (entry.uses || 0) + 1;
    return { scope: entry.scope };
  }

  /** One-click revoke in Settings › Trust. Returns how many tokens died. */
  revokeAll() {
    const n = this.tokens.size;
    this.tokens.clear();
    for (const [code, entry] of this.codes) {
      if (entry.status === 'approved') this.codes.delete(code);
    }
    return n;
  }

  status() {
    this._prune();
    return {
      activeTokens: this.tokens.size,
      pendingCodes: [...this.codes.values()].filter((e) => e.status === 'pending').length,
      scope: this.scope,
      tokenTtlMs: this.tokenTtlMs,
    };
  }
}

module.exports = { RemoteAccess, tokenHash, normalizeCode };
