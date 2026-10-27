// Auto-purge (autoPurgeDays, FDM parity, market research cycle 3): completed
// rows older than the configured window leave the LIST — files on disk are
// never touched, and rows of any other status are never purged.
// Run: node test/auto-purge.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// DownloadManager reads/writes settings + state under USERPROFILE — point it
// at a scratch dir BEFORE requiring the module.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-auto-purge-profile-'));
process.env.USERPROFILE = PROFILE;
process.env.HOME = PROFILE;

const { DownloadManager } = require('../src/download-manager');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const DAY = 86400000;
const NOW = Date.now();

(async () => {
  console.log('\n── 1. the sweep: old completed rows leave, everything else stays ──');
  {
    const mgr = new DownloadManager();
    mgr.settings.autoPurgeDays = 7;

    const row = (id, status, completedAt) => ({
      id, url: `https://cdn.test/${id}`, filename: `${id}.bin`,
      status, completedAt, addedAt: NOW - 30 * DAY,
      savePath: PROFILE, filepath: path.join(PROFILE, `${id}.bin`),
    });
    const old = row('old-done', 'completed', NOW - 10 * DAY);
    const fresh = row('fresh-done', 'completed', NOW - 1 * DAY);
    // No completedAt but a RECENT addedAt: the sweep falls back to addedAt,
    // so a freshly imported completion stays (unknown-but-recent age).
    const noAge = row('no-age', 'completed', undefined);
    noAge.addedAt = NOW;
    const active = row('still-running', 'downloading', NOW - 30 * DAY);
    const cancelled = row('cancelled-old', 'cancelled', NOW - 30 * DAY);
    const errored = row('errored-old', 'error', NOW - 30 * DAY);
    for (const r of [old, fresh, noAge, active, cancelled, errored]) mgr.downloads.set(r.id, r);

    // A real file behind the purged row — the sweep must not touch the disk.
    fs.writeFileSync(old.filepath, 'keep me');

    const removed = [];
    mgr.on('download-removed', (d) => removed.push(d));

    const purged = mgr._purgeFinished(NOW);
    check('exactly the stale completed row is purged', purged.length === 1 && purged[0] === 'old-done', JSON.stringify(purged));
    check('the row left the list', !mgr.downloads.has('old-done'));
    check('fresh completed row stays', mgr.downloads.has('fresh-done'));
    check('row with recent addedAt fallback stays', mgr.downloads.has('no-age'));
    check('active downloads are never purged', mgr.downloads.has('still-running'));
    check('cancelled rows are never purged', mgr.downloads.has('cancelled-old'));
    check('errored rows are never purged', mgr.downloads.has('errored-old'));
    check('the file on disk is untouched', fs.existsSync(old.filepath));
    check('download-removed fired for the purged row',
      removed.length === 1 && removed[0].id === 'old-done' && removed[0].purged === true);
    mgr.removeAllListeners?.();
  }

  console.log('\n── 2. disabled by default and by 0 / junk values ──');
  {
    const mgr = new DownloadManager();
    check('default autoPurgeDays is 0 (off)', (mgr.settings.autoPurgeDays || 0) === 0, mgr.settings.autoPurgeDays);
    mgr.downloads.set('ancient', {
      id: 'ancient', url: 'https://cdn.test/ancient', filename: 'a.bin',
      status: 'completed', completedAt: NOW - 3650 * DAY, addedAt: NOW - 3650 * DAY,
      savePath: PROFILE, filepath: path.join(PROFILE, 'a.bin'),
    });
    mgr.settings.autoPurgeDays = 0;
    check('0 = never purge', mgr._purgeFinished(NOW).length === 0 && mgr.downloads.has('ancient'));
    mgr.settings.autoPurgeDays = 'junk';
    check('junk value = never purge', mgr._purgeFinished(NOW).length === 0 && mgr.downloads.has('ancient'));
    mgr.settings.autoPurgeDays = -5;
    check('negative value = never purge', mgr._purgeFinished(NOW).length === 0 && mgr.downloads.has('ancient'));
  }

  console.log('\n── 3. settings load coerces junk to 0 (the sweep cannot see NaN) ──');
  {
    fs.writeFileSync(path.join(PROFILE, '.aidm_settings.json'),
      JSON.stringify({ autoPurgeDays: 'not-a-number' }));
    const mgr = new DownloadManager();
    check('loaded junk becomes 0', mgr.settings.autoPurgeDays === 0, mgr.settings.autoPurgeDays);
    fs.writeFileSync(path.join(PROFILE, '.aidm_settings.json'),
      JSON.stringify({ autoPurgeDays: '14' }));
    const mgr2 = new DownloadManager();
    check('loaded numeric string becomes 14', mgr2.settings.autoPurgeDays === 14, mgr2.settings.autoPurgeDays);
  }

  console.log('\n── 4. wiring: settings save sweeps immediately ──');
  {
    const mgr = new DownloadManager();
    mgr.downloads.set('ancient', {
      id: 'ancient', url: 'https://cdn.test/ancient', filename: 'a.bin',
      status: 'completed', completedAt: NOW - 3650 * DAY, addedAt: NOW - 3650 * DAY,
      savePath: PROFILE, filepath: path.join(PROFILE, 'a.bin'),
    });
    mgr.saveSettings({ autoPurgeDays: 30 });
    check('saving a window enforces it at once', !mgr.downloads.has('ancient'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 1000).unref();
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
