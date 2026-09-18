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
  // The CURRENT build is authoritative: package.json is the version that was
  // just packaged. Only fall back to the yml's own version when package.json
  // cannot be read. Reading the version from the yml first meant the tool
  // happily re-hashed the PREVIOUS installer every time, so the updater
  // metadata stayed a release behind after any build.
  const version = readVersion() || (/^version:\s*(\S+)/m.exec(yml) || [])[1];
  const file = 'AiDM-Setup-' + version + '.exe';
  const target = path.join(DIST, file);

  if (!fs.existsSync(target)) {
    console.error('Missing ' + target + ' — nothing to describe.');
    process.exit(1);
  }

  const buf = fs.readFileSync(target);
  const sha = crypto.createHash('sha512').update(buf).digest('base64');
  // Only keep the old date when it still belongs to the version we are
  // describing — otherwise a bumped release inherits the previous build's
  // releaseDate and the updater may treat it as older than it is.
  const prevVersion = (/^version:\s*(\S+)/m.exec(yml) || [])[1];
  const prevDate = (/^releaseDate:\s*'?([^'\n]+)'?/m.exec(yml) || [])[1];
  const releaseDate = (prevVersion === version && prevDate) ? prevDate : new Date().toISOString();

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
