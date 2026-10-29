'use strict';
// Extension-origin trust (AUD-012).
//
// The local API used to accept ANY chrome-extension:// or moz-extension://
// origin. Origin alone is not proof of identity: any other installed
// extension with localhost access could read the download list and drive
// state-changing routes. The desktop now accepts an extension origin only
// after the user explicitly allows it once (native Allow/Block prompt);
// the decision is persisted as an exact origin in settings.
//
// Pure helpers so the rules are testable without Electron or HTTP.

// Chrome/Edge extension IDs: exactly 32 chars from [a-p].
const CHROME_EXT_RE = /^chrome-extension:\/\/([a-p]{32})$/i;
// Firefox extension IDs are UUIDs (plus optional non-UUID ids, which are
// host-permission-style strings; only the UUID form is accepted here).
const MOZ_EXT_RE = /^moz-extension:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function isExtensionOrigin(origin) {
  return /^(chrome|moz)-extension:\/\//i.test(String(origin || '').trim());
}

/**
 * Canonical form of a browser-extension origin, or null when it is malformed.
 * The canonical form is what gets stored and compared — a trailing slash or
 * different case must not create a second "trusted" entry.
 */
function normalizeExtensionOrigin(origin) {
  const raw = String(origin || '').trim().replace(/\/+$/, '');
  if (CHROME_EXT_RE.test(raw)) return raw.toLowerCase();
  if (MOZ_EXT_RE.test(raw)) return raw.toLowerCase();
  return null;
}

function isPairedExtension(pairedOrigins, origin) {
  const canon = normalizeExtensionOrigin(origin);
  if (!canon) return false;
  if (!Array.isArray(pairedOrigins)) return false;
  return pairedOrigins.some((entry) => normalizeExtensionOrigin(entry) === canon);
}

function pairExtension(pairedOrigins, origin) {
  const canon = normalizeExtensionOrigin(origin);
  const list = Array.isArray(pairedOrigins) ? [...pairedOrigins] : [];
  if (!canon) return list;
  if (list.some((entry) => normalizeExtensionOrigin(entry) === canon)) return list;
  list.push(canon);
  return list;
}

function unpairExtension(pairedOrigins, origin) {
  const canon = normalizeExtensionOrigin(origin);
  if (!canon || !Array.isArray(pairedOrigins)) return [];
  return pairedOrigins.filter((entry) => normalizeExtensionOrigin(entry) !== canon);
}

module.exports = {
  isExtensionOrigin,
  normalizeExtensionOrigin,
  isPairedExtension,
  pairExtension,
  unpairExtension,
};
