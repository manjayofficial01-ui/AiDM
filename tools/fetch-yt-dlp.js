#!/usr/bin/env node
/**
 * Install yt-dlp for AiDM's YouTube engine.
 *
 *   node tools/fetch-yt-dlp.js            install (or update) into the user bin dir
 *   node tools/fetch-yt-dlp.js --check    report the detected version, install nothing
 *   node tools/fetch-yt-dlp.js --dir <d>  install into <d>
 *
 * Where it installs (no elevation needed):
 *   Windows  %LOCALAPPDATA%\AiDM\bin\yt-dlp.exe
 *   Linux    $XDG_DATA_HOME/aidm/bin/yt-dlp   (default ~/.local/share/aidm/bin)
 *   macOS    ~/Library/Application Support/aidm/bin/yt-dlp  (XDG_DATA_HOME honoured)
 *
 * Integrity: the official `SHA2-256SUMS` published with the same release is
 * downloaded over HTTPS and the binary's digest is checked against it before
 * it is made executable. A mismatch leaves nothing behind.
 *
 * Zero dependencies — uses only node's built-in https/fs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const REPO = 'yt-dlp/yt-dlp';
const API = 'https://api.github.com/repos/' + REPO + '/releases/latest';

function defaultDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'), 'AiDM', 'bin');
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '.', 'Library', 'Application Support'), 'aidm', 'bin');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '.', '.local', 'share'), 'aidm', 'bin');
}

function targetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  return 'yt-dlp';
}

function get(url, { headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'AiDM-yt-dlp-installer', ...headers },
      timeout: 30000,
    }, (res) => {
      const { statusCode, headers: h } = res;
      if (statusCode >= 300 && statusCode < 400 && h.location) {
        res.resume();
        if (redirects > 5) { reject(new Error('Too many redirects')); return; }
        get(h.location, { headers, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + statusCode + ' for ' + url));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: h }));
    });
    req.on('timeout', () => { req.destroy(new Error('Timed out downloading ' + url)); });
    req.on('error', reject);
  });
}

function sha256(buf) {
  return require('crypto').createHash('sha256').update(buf).digest('hex');
}

async function latestRelease() {
  const { body } = await get(API, { headers: { Accept: 'application/vnd.github+json' } });
  const json = JSON.parse(body.toString('utf8'));
  const tag = json.tag_name;
  if (!tag) throw new Error('Could not read the latest release tag');
  const asset = (json.assets || []).find(a => a.name === targetName());
  if (!asset) throw new Error('Release ' + tag + ' has no asset named ' + targetName());
  const sums = (json.assets || []).find(a => a.name === 'SHA2-256SUMS');
  return { tag, assetUrl: asset.browser_download_url, sumsUrl: sums ? sums.browser_download_url : null };
}

async function main() {
  const args = process.argv.slice(2);
  const dir = (() => {
    const i = args.indexOf('--dir');
    return i >= 0 && args[i + 1] ? args[i + 1] : defaultDir();
  })();

  if (args.includes('--check')) {
    // Report what AiDM would actually detect.
    delete process.env.AIDM_YTDLP;
    const { detectRunner } = require('../src/yt-dlp.js');
    const runner = await detectRunner(true);
    if (!runner) {
      console.log('yt-dlp: NOT FOUND');
      console.log('Install with: node tools/fetch-yt-dlp.js');
      process.exit(1);
    }
    console.log('yt-dlp: ' + runner.version + '  (' + runner.source + ')  ' + runner.argv.join(' '));
    return;
  }

  console.log('Fetching the latest yt-dlp release…');
  const { tag, assetUrl, sumsUrl } = await latestRelease();
  console.log('Latest: ' + tag);

  const { body } = await get(assetUrl);
  if (!body.length) throw new Error('Downloaded an empty file');

  if (sumsUrl) {
    const { body: sumsBody } = await get(sumsUrl);
    const digest = sha256(body);
    const line = sumsBody.toString('utf8').split('\n')
      .map(l => l.trim().split(/\s+/))
      .find(p => p.length >= 2 && p[1] === targetName());
    if (!line) throw new Error('No checksum published for ' + targetName());
    if (line[0].toLowerCase() !== digest) {
      throw new Error('Checksum mismatch — expected ' + line[0] + ' got ' + digest + '. Nothing was installed.');
    }
    console.log('Checksum verified (' + digest.slice(0, 16) + '…)');
  } else {
    console.log('WARNING: no SHA2-256SUMS published for this release — installing without verification.');
  }

  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, targetName());
  fs.writeFileSync(target, body);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);

  // Prove it runs before declaring success.
  const out = execFileSync(target, ['--version'], { encoding: 'utf8' }).trim();
  console.log('Installed ' + targetName() + ' ' + out + '\n  → ' + target);
  console.log('\nRestart AiDM so the YouTube engine picks it up.');
}

main().catch((e) => {
  console.error('Install failed: ' + (e && e.message || e));
  process.exit(1);
});
