// Unit tests for src/yt-dlp-install.js — the shared yt-dlp installer used by
// both tools/fetch-yt-dlp.js and the in-app updater (Settings › YouTube).
// The network path is exercised by the real tool; these assert the pure
// logic: channel selection, checksum parsing/verification, asset picking.
// Run: node test/yt-dlp-install.js
'use strict';
const assert = require('assert');
const inst = require('../src/yt-dlp-install.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

console.log('\u2500\u2500 export surface \u2500\u2500');
for (const fn of ['installYtDlp', 'repoForChannel', 'latestReleaseApi', 'parseSums', 'digestMatches', 'pickReleaseAsset', 'exeName', 'defaultDir']) {
  check('exports ' + fn, typeof inst[fn] === 'function');
}

console.log('\u2500\u2500 channel selection (nightly is the default) \u2500\u2500');
check('default/empty resolves to the nightly build repo', inst.repoForChannel() === 'yt-dlp/yt-dlp-nightly-builds');
check('explicit nightly resolves to the nightly build repo', inst.repoForChannel('nightly') === 'yt-dlp/yt-dlp-nightly-builds');
check('stable opts into the release-tag repo', inst.repoForChannel('stable') === 'yt-dlp/yt-dlp');
check('stable is case/space tolerant', inst.repoForChannel(' STABLE ') === 'yt-dlp/yt-dlp');
check('a nonsense channel resolves to nightly (safer default)', inst.repoForChannel('banana') === 'yt-dlp/yt-dlp-nightly-builds');
check('nightly API URL is the nightly repo', inst.latestReleaseApi('nightly').includes('yt-dlp-nightly-builds/releases/latest'));
check('stable API URL is the release repo', inst.latestReleaseApi('stable').includes('/yt-dlp/yt-dlp/releases/latest'));

console.log('\u2500\u2500 parseSums (SHA2-256SUMS) \u2500\u2500');
const SUMS = [
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  yt-dlp',
  'e7cafc44db8aa433da8dd78303b9157f2c1dd509c4cbfcd8418081b7e1d26a7a  yt-dlp.exe',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  yt-dlp_linux',
].join('\n');
check('finds the wanted asset', inst.parseSums(SUMS, 'yt-dlp.exe') === 'e7cafc44db8aa433da8dd78303b9157f2c1dd509c4cbfcd8418081b7e1d26a7a');
check('missing asset → null', inst.parseSums(SUMS, 'yt-dlp_macos') === null);
check('empty body → null', inst.parseSums('', 'yt-dlp.exe') === null);
check('a malformed digest line is skipped', inst.parseSums('nothex  yt-dlp.exe', 'yt-dlp.exe') === null);

console.log('\u2500\u2500 digestMatches \u2500\u2500');
check('equal digests match', inst.digestMatches('ABCDEF0123', 'abcdef0123') === true);
check('different digests do not match', inst.digestMatches('abcdef0123', 'abcdef0124') === false);
check('empty never matches', inst.digestMatches('', '') === false && inst.digestMatches(null, 'a') === false);

console.log('\u2500\u2500 pickReleaseAsset \u2500\u2500');
const IS_WIN = process.platform === 'win32';
const NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
check('exeName matches the platform', inst.exeName() === NAME);
const release = {
  tag_name: '2026.10.10.233141',
  assets: [
    { name: 'SHA2-256SUMS', browser_download_url: 'https://example.test/sums' },
    { name: NAME, browser_download_url: 'https://example.test/' + NAME },
  ],
};
const picked = inst.pickReleaseAsset(release);
check('asset url picked', picked.assetUrl === 'https://example.test/' + NAME, picked.assetUrl);
check('sums url picked when published', picked.sumsUrl === 'https://example.test/sums');
check('tag carried through', picked.tag === '2026.10.10.233141');
check('sums url null when the release lacks them', inst.pickReleaseAsset({ tag_name: 'x', assets: [{ name: NAME, browser_download_url: 'u' }] }).sumsUrl === null);
assert.throws(() => inst.pickReleaseAsset({ tag_name: 'x', assets: [{ name: 'other', browser_download_url: 'u' }] }), /no asset named/);
check('a release without the binary throws', true);

console.log('\u2500\u2500 defaultDir \u2500\u2500');
const dir = inst.defaultDir();
check('returns a non-empty per-user dir', typeof dir === 'string' && dir.length > 3, dir);
check('win32 dir is under LOCALAPPDATA\\AiDM\\bin',
  process.platform === 'win32' ? /AiDM[\\/]+bin$/.test(dir) : dir.length > 3);

// ── quarantine detection (IObit renamed yt-dlp.exe → yt-dlp_IObitDel.exe) ──
console.log('\u2500\u2500 quarantine hint \u2500\u2500');
{
  const fs = require('fs');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(__dirname, '_aidm-iobit-test-'));
  const ytdlp = require('../src/yt-dlp.js');
  check('clean dir → no remnant detected',
    ytdlp.quarantinedRemnantName([tmp]) === null);
  check('clean dir guidance does not claim quarantine',
    !/QUARANTINED/.test(ytdlp.ytdlpMissingMessage([tmp])));
  fs.writeFileSync(path.join(tmp, 'yt-dlp_IObitDel.exe'), 'x');
  check('IObit-renamed remnant detected by name',
    ytdlp.quarantinedRemnantName([tmp]) === 'yt-dlp_IObitDel.exe');
  check('guidance names the quarantine in the injected search directory',
    /QUARANTINED/.test(ytdlp.ytdlpMissingMessage([tmp])) &&
    /yt-dlp_IObitDel\.exe/.test(ytdlp.ytdlpMissingMessage([tmp])));
  check('unrelated renamed files are ignored',
    (() => { fs.rmSync(path.join(tmp, 'yt-dlp_IObitDel.exe'));
      fs.writeFileSync(path.join(tmp, 'yt-dlp_backup.exe'), 'x');
      const r = ytdlp.quarantinedRemnantName([tmp]);
      fs.rmSync(tmp, { recursive: true, force: true });
      return r === null; })());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
