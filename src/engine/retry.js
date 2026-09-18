// @ts-check
const { DEFAULT_RETRY_POLICY } = require('./types');

/**
 * Exponential backoff with equal jitter. Honors a server-provided Retry-After when present.
 * @param {number} attempt
 * @param {typeof DEFAULT_RETRY_POLICY} policy
 * @param {number} [retryAfterMs]
 * @returns {number}
 */
function backoffDelay(attempt, policy, retryAfterMs) {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, policy.maxDelayMs * 2);
  }
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1)));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/**
 * @param {string | null} header
 * @returns {number | undefined}
 */
function parseRetryAfter(header) {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

module.exports = {
  DEFAULT_RETRY_POLICY,
  backoffDelay,
  parseRetryAfter,
};
