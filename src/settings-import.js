'use strict';

/**
 * Settings-import safety.
 *
 * Importing a settings file is a file-driven trust decision: the payload
 * arrives from disk (a shared preset, a colleague's export, a downloaded
 * archive) and is written straight into the live settings. Most settings are
 * harmless, but three kinds are not:
 *
 *  - **code that will run** — `postDownloadCmd` is spawned on every completed
 *    download, so an imported command line is remote code execution;
 *  - **where a secret is sent** — `aiBaseURL` decides which host receives the
 *    AI API key as `Authorization: Bearer …`;
 *  - **which binary runs** — `youtubeJsRuntime` is the interpreter yt-dlp
 *    drives the extractor with, and `youtubeExtractorArgs` feeds it flags;
 *  - **who may drive the app** — `mcpEnabled` opens the local bridge an AI
 *    assistant talks to, so an imported file must not be able to turn it on.
 *
 * Those keys are therefore never carried by an import. The user can still set
 * them by hand in Settings — an explicit, local action — and the import
 * reports what it skipped instead of silently dropping it.
 *
 * Pure module: no Electron, no filesystem. Unit-tested directly.
 */

/**
 * Keys an import must never carry, with the reason shown to the user.
 * @type {Record<string, string>}
 */
const UNSAFE_IMPORT_KEYS = {
  postDownloadCmd: 'runs a command on every completed download',
  postDownloadCmdTimeoutSec: 'belongs to the post-download command',
  aiBaseURL: 'decides which host receives the AI API key',
  youtubeJsRuntime: 'names the binary yt-dlp runs the extractor with',
  youtubeExtractorArgs: 'adds flags to the extractor runtime',
  trustedExtensionOrigins: 'trusts a browser extension on this machine',
  mcpEnabled: 'opens the bridge an AI assistant drives the app through',
};

/**
 * Strip the settings an import must not carry.
 *
 * @param {unknown} settings the parsed import payload
 * @returns {{ payload: unknown, skipped: { key: string, reason: string }[] }}
 */
function sanitizeImportedSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { payload: settings, skipped: [] };
  }
  const payload = { ...settings };
  /** @type {{ key: string, reason: string }[]} */
  const skipped = [];
  for (const [key, reason] of Object.entries(UNSAFE_IMPORT_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      delete payload[key];
      skipped.push({ key, reason });
    }
  }
  return { payload, skipped };
}

module.exports = { sanitizeImportedSettings, UNSAFE_IMPORT_KEYS };
