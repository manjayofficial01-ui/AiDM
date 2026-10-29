'use strict';

const { EventEmitter } = require('events');
const {
  TorrentEngine,
  normalizeFileSelection,
  selectedBytes,
  selectedSize,
} = require('../src/torrent-engine');

let pass = 0;
let fail = 0;
function check(name, condition, extra) {
  if (condition) {
    pass++;
    console.log('  OK  ', name, extra === undefined ? '' : `(${extra})`);
  } else {
    fail++;
    console.log('  FAIL', name, extra === undefined ? '' : `(${extra})`);
  }
}

function makeFile(name, length, downloaded = 0) {
  const file = new EventEmitter();
  Object.assign(file, { name, path: name, length, done: downloaded >= length });
  Object.defineProperty(file, 'downloaded', {
    get() { return downloaded; },
    configurable: true,
  });
  Object.defineProperty(file, 'progress', { get: () => length ? downloaded / length : 0 });
  file.selectCalls = 0;
  file.deselectCalls = 0;
  file.select = () => { file.selectCalls++; };
  file.deselect = () => { file.deselectCalls++; };
  file._set = (value) => {
    downloaded = Math.min(length, value);
    file.done = downloaded >= length;
  };
  return file;
}

class FakeTorrent extends EventEmitter {
  constructor(files, length) {
    super();
    this.files = files;
    this.length = length;
    this.infoHash = 'abc';
    this.name = 'bundle';
    this.numPeers = 3;
    this.downloadSpeed = 1234;
    this.uploadSpeed = 456;
    this.uploaded = 999;
    this.ratio = 1.5;
    this.timeRemaining = Infinity;
    this.progress = 0;
    this.destroyed = false;
  }
}

class FakeClient {
  constructor() {
    this.added = [];
    this.removed = [];
    this.downloadedThrottled = null;
    this.uploadedThrottled = null;
  }
  add(url, options) {
    const files = options.aidmTestFiles;
    const torrent = new FakeTorrent(files, options.aidmTestLength);
    this.added.push({ url, options, torrent });
    return torrent;
  }
  remove(torrent, opts, cb) {
    this.removed.push({ torrent, opts });
    if (cb) cb();
  }
  throttleDownload(rate) { this.downloadedThrottled = rate; }
  throttleUpload(rate) { this.uploadedThrottled = rate; }
  async destroy() {}
}

async function main() {
  check('boolean selection keeps explicit choices', normalizeFileSelection([true, false, true], 3).join() === 'true,false,true');
  check('integer selection enables only named indices', normalizeFileSelection([0, 2], 3).join() === 'true,false,true');
  check('empty selection means all files', normalizeFileSelection([], 2).join() === 'true,true');

  const files = [makeFile('a.bin', 100, 60), makeFile('b.bin', 200, 50)];
  const fakeClient = new FakeClient();
  const engine = new TorrentEngine({
    downloadLimit: 1000,
    uploadLimit: 50,
    maxConns: 11,
    createClient: async () => fakeClient,
  });
  await engine._ensureClient();
  check('torrent limits apply when the client is created', fakeClient.downloadedThrottled === 1000 && fakeClient.uploadedThrottled === 50);

  const events = [];
  engine.on('download-metadata', (e) => events.push({ type: 'metadata', e }));
  engine.on('download-progress', (e) => events.push({ type: 'progress', e }));
  engine.on('download-complete', (e) => events.push({ type: 'complete', e }));
  const download = {
    id: 'row-1',
    url: 'magnet:?xt=urn:btih:abc',
    savePath: 'C:/tmp',
    fileSelection: [0],
    trackerUrls: ['http://tracker.invalid/announce', '', 'https://other.invalid/announce'],
    webSeedUrls: ['https://seed.invalid/a.bin'],
    seedPolicy: 'stop',
  };
  fakeClient.add = function (url, options) {
    const torrent = new FakeTorrent(files, 300);
    this.added.push({ url, options, torrent });
    return torrent;
  };
  await engine.start(download);
  check('tracker and web-seed lists are sanitized', fakeClient.added[0].options.announce.length === 2 && fakeClient.added[0].options.urlList[0] === 'https://seed.invalid/a.bin');
  check('partial selection starts the torrent deselected', fakeClient.added[0].options.deselect === true);
  fakeClient.added[0].torrent.emit('metadata');
  const metadata = events.find((entry) => entry.type === 'metadata');
  check('metadata exposes per-file selection', metadata && metadata.e.files.length === 2 && metadata.e.files[0].selected && !metadata.e.files[1].selected);
  check('metadata total size follows selected files', metadata.e.totalSize === 100);
  check('selected file is explicitly selected', files[0].selectCalls === 1);
  check('unselected file is explicitly deselected', files[1].deselectCalls === 1);

  engine._emitProgress(engine.jobs.get('row-1'));
  const progress = events.filter((entry) => entry.type === 'progress').at(-1).e;
  check('progress reports only selected bytes', progress.downloaded === 60 && progress.totalSize === 100 && progress.percent === 60, JSON.stringify(progress));
  check('progress reports swarm and seeding telemetry', progress.peers === 3 && progress.uploaded === 999 && progress.ratio === 1.5);

  files[0]._set(100);
  engine._onDone(engine.jobs.get('row-1'));
  const complete = events.find((entry) => entry.type === 'complete');
  check('completion uses selected size, not whole torrent size', complete && complete.e.totalSize === 100);
  check('seed policy stop removes the torrent after selected completion', fakeClient.removed.length === 1 && fakeClient.removed[0].opts.destroyStore === false);

  engine.jobs.set('row-2', { torrent: { files, destroyed: false }, selection: normalizeFileSelection([1], files.length) });
  const info = { selection: engine.jobs.get('row-2').selection, selectedBytes: selectedBytes({ files }, engine.jobs.get('row-2').selection), selectedSize: selectedSize({ files }, engine.jobs.get('row-2').selection) };
  check('selection helpers sum only enabled files', info.selectedBytes === 50 && info.selectedSize === 200);

  engine.limits.download = 0;
  engine.setUploadLimit('3000');
  check('upload cap normalizes numeric strings', fakeClient.uploadedThrottled === 3000);
  const settings = engine.applyLimits({ maxConns: 22, dht: false, lsd: false, utPex: false });
  check('connection/DHT/discovery settings persist for future clients', settings.maxConns === 22 && settings.dht === false && settings.lsd === false && settings.utPex === false);
  await engine.destroy();

  console.log(`\ntorrent-controls: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('  FAIL', err && err.stack || err);
  process.exitCode = 1;
});
