#!/usr/bin/env node
'use strict';
/**
 * Sync the Chrome extension's version with the main application's version.
 *
 * WHY THIS EXISTS
 * ---------------
 * The extension used to drift: the app shipped as 5.8.0 while the popup
 * footer still said "v5.0.0" and the manifest was bumped by hand (or not at
 * all), so reloading the extension in chrome://extensions showed a stale
 * version and users read the pairing as broken. The version must live in
 * exactly ONE place — package.json — and every other surface derives from
 * it:
 *
 *   chrome-extension/manifest.json  ← synced here (Chrome shows this)
 *   chrome-extension/popup.html     ← reads the live manifest at runtime
 *                                     (chrome.runtime.getManifest), so the
 *                                     popup never needs a rewrite.
 *
 * Run automatically by `npm run dist` / `dist:win` / `pack` before
 * electron-builder packs the extension via extraResources. Safe to run
 * repeatedly — it is a no-op when the versions already match.
 *
 * Exit codes: 0 synced or already in sync; 1 on any failure (the && in the
 * npm script then stops the build instead of packaging a stale manifest).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const manifestPath = path.join(ROOT, 'chrome-extension', 'manifest.json');
  const manifest = readJson(manifestPath);

  if (manifest.version === pkg.version) {
    console.log(`[sync-extension-version] already in sync at ${pkg.version}`);
    return 0;
  }

  const previous = manifest.version;
  manifest.version = pkg.version;
  // Same 2-space layout the manifest already uses, + trailing newline.
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[sync-extension-version] extension manifest ${previous} -> ${pkg.version}`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error('[sync-extension-version] FAILED:', e && e.message);
  process.exit(1);
}
