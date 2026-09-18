#!/usr/bin/env node
/**
 * Rewrite dist/latest.yml from the installer that is actually on disk.
 *
 * Why this exists: electron-builder's very last step deletes its temporary
 * artifacts (the NSIS .7z, the __uninstaller.exe). When a bulk-delete guard
 * blocks that step the build exits non-zero EVEN THOUGH the installer was
 * already built and signed — and latest.yml is left describing the PREVIOUS
 * build, so the updater metadata no longer matches the file.
 *
 *   node tools/refresh-latest-yml.js
 *
 * Zero dependencies. Safe to re-run: it only recomputes sha512 + size.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIST = path.join(__dirname, '..', 'dist');
const YML = path.join(DIST, 'latest.yml');

function readVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch (e) { return null; }
}

function main() {
  if (!fs.existsSync(YML)) {
    console.error('No dist/latest.yml — run a build first.');
    process.exit(1);
  }
  const yml = fs.readFileSync(YML, 'utf8');
  const version = (/^version:\s*(\S+)/m.exec(yml) || [])[1] || readVersion();
  const file = (/^path:\s*(\S+)/m.exec(yml) || [])[1] || ('AiDM-Setup-' + version + '.exe');
  const target = path.join(DIST, file);

  if (!fs.existsSync(target)) {
    console.error('Missing ' + target + ' — nothing to describe.');
    process.exit(1);
  }

  const buf = fs.readFileSync(target);
  const sha = crypto.createHash('sha512').update(buf).digest('base64');
  const releaseDate = (/^releaseDate:\s*'?([^'\n]+)'?/m.exec(yml) || [])[1] || new Date().toISOString();

  const out = [
    'version: ' + version,
    'files:',
    '  - url: ' + file,
    '    sha512: ' + sha,
    '    size: ' + buf.length,
    'path: ' + file,
    'sha512: ' + sha,
    "releaseDate: '" + releaseDate + "'",
    '',
  ].join('\n');

  fs.writeFileSync(YML, out);
  console.log('latest.yml now describes ' + file + ' (' + buf.length + ' bytes)');
  console.log('sha512: ' + sha);
}

main();
