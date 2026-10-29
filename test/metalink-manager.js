'use strict';

const { DownloadManager } = require('../src/download-manager');

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

function fakeManager(xml) {
  const manager = Object.create(DownloadManager.prototype);
  manager.downloads = new Map();
  manager.queue = [];
  manager.queued = [];
  manager.updates = [];
  manager.persistCount = 0;
  manager.settings = { defaultSavePath: 'C:/tmp' };
  manager._fetchMetalinkDocument = async () => xml;
  manager.queueDownload = (opts) => { manager.queued.push(opts); return { ...opts, id: `queued-${manager.queued.length}` }; };
  manager._persistDownloads = () => { manager.persistCount++; return true; };
  manager.emit = (name, payload) => manager.updates.push({ name, payload });
  manager._startAborted = () => false;
  manager._cleanFilename = (name) => String(name || '').replace(/[\\/]/g, '_');
  return manager;
}

const xml = `<metalink xmlns="urn:ietf:params:xml:ns:metalink" version="4.0">
  <file name="first.mp4">
    <length>4096</length>
    <hash type="sha-256">${'a'.repeat(64)}</hash>
    <pieces type="sha-256" length="2048"><hash>${'1'.repeat(64)}</hash><hash>${'2'.repeat(64)}</hash></pieces>
    <url priority="5">https://backup.invalid/first.mp4</url>
    <url priority="1">https://fast.invalid/first.mp4</url>
  </file>
  <file name="second.zip">
    <url>https://mirror.invalid/second.zip</url>
  </file>
</metalink>`;

async function main() {
  const download = {
    id: 'metalink-row',
    url: 'https://example.invalid/files.meta4',
    filename: 'files.meta4',
    category: 'other',
    savePath: 'C:/tmp/AiDM',
    filepath: 'C:/tmp/AiDM/files.meta4',
    status: 'connecting',
    downloaded: 0,
    totalSize: 0,
    mirrors: [],
    checksum: null,
    priority: 'high',
    speedLimit: 1000,
  };
  const manager = fakeManager(xml);
  const result = await DownloadManager.prototype._expandMetalink.call(manager, download, { Referer: 'https://page.invalid' });
  check('Metalink expansion succeeds', result.ok === true);
  check('container row becomes the first real file', download.filename === 'first.mp4' && download.url === 'https://fast.invalid/first.mp4');
  check('first row receives mirror list', download.mirrors.join() === 'https://backup.invalid/first.mp4', download.mirrors.join());
  check('first row receives size and checksum', download.totalSize === 4096 && download.checksum.algorithm === 'sha256');
  check('first row receives piece manifest', download.pieces.algorithm === 'sha256' && download.pieces.pieceLengthBytes === 2048 && download.pieces.hashes.length === 2);
  check('first row path is updated', /[\\/]first\.mp4$/.test(download.filepath) && !/[\\/]files\.meta4$/.test(download.filepath), download.filepath);
  check('container expansion is marked and persists', download._metalinkExpanded === true && manager.persistCount === 1);
  check('additional files are queued in the same folder', manager.queued.length === 1 && manager.queued[0].savePath === download.savePath);
  check('additional rows inherit priority and rate', manager.queued[0].priority === 'high' && manager.queued[0].speedLimit === 1000);
  check('additional rows inherit request headers', manager.queued[0].headers.Referer === 'https://page.invalid');

  const badManager = fakeManager('<rss></rss>');
  const bad = await DownloadManager.prototype._expandMetalink.call(badManager, { ...download, _metalinkExpanded: false });
  check('invalid Metalink returns an actionable error', bad.ok === false && /metalink/i.test(bad.error), bad.error);

  console.log(`\nmetalink-manager: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('  FAIL', err && err.stack || err);
  process.exitCode = 1;
});
