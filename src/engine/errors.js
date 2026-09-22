// @ts-check
/**
 * Error hierarchy for the Next-Gen Download Engine.
 */

class DownloadError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ retryable?: boolean, status?: number, retryAfterMs?: number, cause?: unknown }} [init]
   */
  constructor(code, message, init = {}) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'DownloadError';
    this.code = code;
    this.retryable = init.retryable ?? false;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
    };
  }
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
// 501 is "method not implemented" — Range/HEAD from non-browser clients.
// Retrying burns the whole budget and never succeeds.
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 410, 451, 501]);

/**
 * @param {number} status
 * @param {number} [retryAfterMs]
 */
function classifyHttpStatus(status, retryAfterMs) {
  const retryable = RETRYABLE_STATUSES.has(status) || (status >= 500 && !PERMANENT_STATUSES.has(status));
  return new DownloadError('HTTP', `Server responded with HTTP ${status}`, { retryable, status, retryAfterMs });
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
function extractCode(err) {
  if (!err || typeof err !== 'object') return undefined;
  const own = /** @type {{ code?: unknown }} */ (err).code;
  if (typeof own === 'string') return own;
  const cause = /** @type {{ cause?: unknown }} */ (err).cause;
  if (cause && typeof cause === 'object') {
    const c = /** @type {{ code?: unknown }} */ (cause).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/**
 * @param {unknown} err
 * @returns {DownloadError}
 */
function toDownloadError(err) {
  if (err instanceof DownloadError) return err;

  if (err && typeof err === 'object' && /** @type {{ name?: string }} */ (err).name === 'AbortError') {
    return new DownloadError('CANCELLED', 'Request aborted', { cause: err });
  }

  const code = extractCode(err);
  const message = err instanceof Error ? err.message : String(err);

  if (code && TIMEOUT_CODES.has(code)) {
    return new DownloadError('TIMEOUT', `Connection timed out (${code})`, { retryable: true, cause: err });
  }
  if (code && (code.startsWith('E') || code.startsWith('UND_ERR'))) {
    return new DownloadError('NETWORK', `Network error (${code}): ${message}`, { retryable: true, cause: err });
  }
  if (err instanceof TypeError && /fetch failed/i.test(message)) {
    return new DownloadError('NETWORK', 'Network error: fetch failed', { retryable: true, cause: err });
  }
  // Plain logic / JSON / disk errors must not masquerade as retryable network
  // failures — that caused full retry storms on deterministic faults.
  if (err instanceof DownloadError) return err;
  return new DownloadError('UNKNOWN', message || 'Unknown error', { retryable: false, cause: err });
}

module.exports = {
  DownloadError,
  classifyHttpStatus,
  toDownloadError,
};
