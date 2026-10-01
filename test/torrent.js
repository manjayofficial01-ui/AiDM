// Torrent / magnet support (src/torrent-engine.js + DownloadManager wiring).
//
// WebTorrent is exercised through a FAKE client/torrent so the whole plumbing
// is deterministic and offline: job tracking, metadata rename, progress shape,
// completion, pause/resume/remove, and the manager's row lifecycle for a
// magnet link. (A live swarm download is not a unit test — it needs peers,
// DHT and minutes of wall time.)
//
// Run: node test/torrent.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

const { TorrentEngine, isTorrentUrl, magnetDisplayName } = require('../src/torrent-engine');

const MAGNET = 'magnet:?xt=urn:btih:deadbeefcafe&dn=Big+Buck+Bunny+1080p.mp4';

// ── URL detection ────────────────────────────────────────────────────────────
console.log('── 1. torrent URL detection ──');
{
  check('magnet URI detected', isTorrentUrl(MAGNET));
  check('.torrent file URL detected', isTorrentUrl('https://mirror.example.com/files/ubuntu-24.04.torrent'));
  check('.torrent with query detected', isTorrentUrl('https://mirror.example.com/files/ubuntu.torrent?sig=abc'));
  check('plain file NOT a torrent', !isTorrentUrl('https://x.com/files/movie.mp4'));
  check('magnet display name decoded', magnetDisplayName(MAGNET) === 'Big Buck Bunny 1080p.mp4',
    magnetDisplayName(MAGNET));
  check('no display name → empty', magnetDisplayName('magnet:?xt=urn:btih:deadbeef') === '');
}

// ── Fake WebTorrent client ───────────────────────────────────────────────────
class FakeTorrent extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.paused = false;
    this.ready = false;
    this.files = [{ name: 'Big Buck Bunny 1080p.mp4', length: 5000 }];
    this.name = 'Big Buck Bunny 1080p.mp4';
    this.length = 5000;
    this.downloaded = 0;
    this.uploaded = 0;
    this.downloadSpeed = 0;
    this.uploadSpeed = 0;
    this.numPeers = 0;
    this.infoHash = 'deadbeefcafe';
  }
  get progress() { return this.downloaded / this.length; }
  get timeRemaining() { return this.downloadSpeed > 0 ? 4000 : Infinity; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
}

class FakeClient extends EventEmitter {
  constructor() { super(); this.torrents = []; this.throttled = null; this.destroyed = false; }
  add(url, opts) {
    const t = new FakeTorrent();
    t._url = url; t._opts = opts;
    this.torrents.push(t);
    // WebTorrent delivers metadata asynchronously.
    setImmediate(() => { t.ready = true; t.emit('metadata'); });
    return t;
  }
  remove(torrent, opts, cb) {
    this.torrents = this.torrents.filter(x => x !== torrent);
    torrent.destroyed = true;
    torrent.emit('close');
    if (cb) cb();
  }
  throttleDownload(rate) { this.throttled = rate; return true; }
  async destroy() { this.destroyed = true; }
}

// ── Engine plumbing ──────────────────────────────────────────────────────────
(async () => {
  console.log('── 2. TorrentEngine event plumbing (fake client) ──');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-torrent-'));
  const engine = new TorrentEngine();
  const fake = new FakeClient();
  engine.client = fake; // inject — _ensureClient() returns this.client when set

  const got = { metadata: [], progress: [], complete: [], error: [] };
  engine.on('download-metadata', d => got.metadata.push(d));
  engine.on('download-progress', d => got.progress.push(d));
  engine.on('download-complete', d => got.complete.push(d));
  engine.on('download-error', d => got.error.push(d));

  await engine.start({ id: 't1', url: MAGNET, savePath: TMP });
  check('torrent handed to the client', fake.torrents.length === 1);
  check('save path honoured', fake.torrents[0]._opts.path === TMP, fake.torrents[0]._opts.path);
  check('job tracked', engine.has('t1'));

  await tick();
  check('metadata event emitted', got.metadata.length === 1, `${got.metadata.length}`);
  check('metadata carries real name + size',
    got.metadata[0] && got.metadata[0].name === 'Big Buck Bunny 1080p.mp4' && got.metadata[0].totalSize === 5000);

  // Simulate swarm progress: half the file at 1 KB/s with 7 peers.
  const t = fake.torrents[0];
  t.downloaded = 2500; t.downloadSpeed = 1000; t.numPeers = 7; t.uploadSpeed = 100;
  engine._emitProgress(engine.jobs.get('t1'));
  const p = got.progress[got.progress.length - 1];
  check('progress shape matches HTTP engine', p && p.id === 't1' && p.downloaded === 2500 &&
    p.totalSize === 5000 && p.speed === 1000 && p.percent === 50 && p.peers === 7, JSON.stringify(p));
  check('eta computed from timeRemaining', p && p.eta === 4, p && String(p.eta));

  // Finish.
  t.downloaded = 5000;
  t.emit('done');
  check('completion emitted once', got.complete.length === 1);
  check('completion carries size', got.complete[0].totalSize === 5000);

  // Pause / resume / remove.
  check('pause reaches the torrent', engine.pause('t1') === true && t.paused === true);
  check('resume reaches the torrent', engine.resume('t1') === true && t.paused === false);
  engine.remove('t1', { deleteFiles: true });
  check('remove drops the job', !engine.has('t1'));
  check('remove destroys the torrent', t.destroyed === true);
  check('remove forwards destroyStore', fake.torrents.length === 0);

  // Error path.
  await engine.start({ id: 't2', url: 'magnet:?xt=urn:btih:beefbeef', savePath: TMP });
  const t2 = fake.torrents[0];
  t2.emit('error', new Error('tracker unreachable'));
  check('error surfaces as download-error', got.error.length === 1 && /tracker unreachable/.test(got.error[0].error));

  // Global throttle.
  engine.setSpeedLimit(512000);
  check('throttle applied to client', fake.throttled === 512000, String(fake.throttled));

  await engine.destroy();

  // ── Manager integration ────────────────────────────────────────────────────
  console.log('── 3. DownloadManager row lifecycle for a magnet ──');
  {
    const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-tmgr-'));
    fs.writeFileSync(path.join(settingsDir, '.aidm_settings.json'),
      JSON.stringify({ autoResume: false, defaultSegments: 4 }, null, 2));
    const previousHome = process.env.USERPROFILE;
    process.env.USERPROFILE = settingsDir;
    try {
      const { DownloadManager } = require('../src/download-manager');
      const dm = new DownloadManager();
      // Stub BEFORE addDownload: a free slot auto-starts the row, and we must
      // not let a real WebTorrent client touch a bogus magnet in a unit test.
      let startedWith = null;
      dm.torrent.start = async (dl) => { startedWith = dl; };
      const row = dm.addDownload({ url: MAGNET });
      check('row marked torrent', row.isTorrent === true && row.protocol === 'torrent');
      check('row named from magnet dn', /Big Buck Bunny/.test(row.filename), row.filename);
      check('row auto-started into connecting', row.status === 'connecting' && startedWith === row, row.status);

      const live = dm.downloads.get(row.id);
      await dm._startDownload(live);
      check('start delegated to torrent engine', startedWith === live);
      check('no engine task created for torrents', !dm.engine.getDownload(row.id));

      // Pause flips the row even with no swarm attached yet.
      dm.pauseDownload(row.id);
      check('pause flips row without swarm', dm.downloads.get(row.id).status === 'paused');
      check('resume re-enters the start path', (() => {
        let again = false;
        dm.torrent.start = async () => { again = true; };
        dm.resumeDownload(row.id);
        return again && dm.downloads.get(row.id).status === 'connecting';
      })());

      // Metadata rename updates the row.
      dm.torrent.emit('download-metadata', { id: row.id, name: 'Real Name.mp4', totalSize: 999, infoHash: 'abc' });
      check('metadata renames row + sets size',
        dm.downloads.get(row.id).filename === 'Real Name.mp4' && dm.downloads.get(row.id).totalSize === 999);

      dm.removeDownload(row.id);
      check('removal drops the torrent row', !dm.downloads.get(row.id));
    } finally {
      process.env.USERPROFILE = previousHome;
    }
  }

  console.log(`\ntorrent: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
