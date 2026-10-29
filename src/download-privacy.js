'use strict';

function sanitizeDownloadPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeDownloadPayload);
  if (!value || typeof value !== 'object') return value;
  // Null prototypes preserve JSON keys such as __proto__ as data, not setters.
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (/^(cookies?|authorization|proxy-authorization)$/i.test(key)) continue;
    out[key] = sanitizeDownloadPayload(item);
  }
  return out;
}

module.exports = { sanitizeDownloadPayload };
