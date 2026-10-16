#!/usr/bin/env node
/**
 * Install yt-dlp for AiDM's YouTube engine (CLI wrapper around
 * src/yt-dlp-install.js — the same code the in-app updater runs).
 *
 *   node tools/fetch-yt-dlp.js              install the nightly (default)
 *   node tools/fetch-yt-dlp.js --stable     install the stable release tag
 *   node tools/fetch-yt-dlp.js --check      report the detected version, install nothing
 *   node tools/fetch-yt-dlp.js --dir <d>    install into <d>
 *
 * Nightly is the default because the stable tag lags: when YouTube began
 * requiring sign-in confirmation for extraction (Oct 2026), stable was
 * 2026.08.19 while the nightly builds already carried the fixes. See
 * src/yt-dlp-install.js for the full rationale.
 *
 * Where it installs (no elevation needed):
 *   Windows  %LOCALAPPDATA%\AiDM\bin\yt-dlp.exe
 *   Linux    $XDG_DATA_HOME/aidm/bin/yt-dlp   (default ~/.local/share/aidm/bin)
 *   macOS    ~/Library/Application Support/aidm/bin/yt-dlp  (XDG_DATA_HOME honoured)
 */

'use strict';

const { installYtDlp } = require('../src/yt-dlp-install.js');

async function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1] : undefined;
  const channel = args.includes('--stable') ? 'stable' : 'nightly';

  if (args.includes('--check')) {
    // Report what AiDM would actually detect.
    delete process.env.AIDM_YTDLP;
    const { detectRunner } = require('../src/yt-dlp.js');
    const runner = await detectRunner(true);
    if (!runner) {
      console.log('yt-dlp: NOT FOUND');
      console.log('Install with: node tools/fetch-yt-dlp.js   (or --stable for the release tag)');
      process.exit(1);
    }
    console.log('yt-dlp: ' + runner.version + '  (' + runner.source + ')  ' + runner.argv.join(' '));
    return;
  }

  const res = await installYtDlp({ channel, dir, log: (m) => console.log(m) });
  console.log('\nRestart AiDM so the YouTube engine picks it up.');
  return res;
}

main().catch((e) => {
  console.error('Install failed: ' + (e && e.message || e));
  process.exit(1);
});
