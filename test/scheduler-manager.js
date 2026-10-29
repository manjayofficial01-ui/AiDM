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

function fakeManager(rows, options = {}) {
  const manager = Object.create(DownloadManager.prototype);
  manager.downloads = new Map(rows.map((row) => [row.id, row]));
  manager.queue = rows
    .filter((row) => row.status === 'queued' || row.status === 'queued-paused')
    .map((row) => row.id);
  manager.maxConcurrent = options.maxConcurrent || 1;
  manager.settings = { speedLimit: options.globalSpeedLimit || 0 };
  manager.started = [];
  manager.limits = {};
  manager.persistCount = 0;
  manager.updates = [];
  manager.engine = {
    globalSpeedLimit: options.globalSpeedLimit || 0,
    setTaskSpeedLimit(id, bytesPerSecond) {
      manager.limits[id] = bytesPerSecond;
      return true;
    },
  };
  manager._startDownload = (dl) => {
    manager.started.push(dl.id);
    dl.status = 'connecting';
  };
  manager._persistDownloads = () => { manager.persistCount++; return true; };
  manager.emit = (name, payload) => manager.updates.push({ name, payload });
  return manager;
}

const now = 2_000_000;
const manager = fakeManager([
  { id: 'normal', status: 'queued', priority: 'normal', addedAt: now },
  { id: 'high', status: 'queued', priority: 'high', addedAt: now },
  { id: 'paused', status: 'queued-paused', priority: 'high', addedAt: now - 1000 },
  { id: 'error', status: 'error', priority: 'high', addedAt: now - 1000 },
], { maxConcurrent: 1, globalSpeedLimit: 9_000_000 });
manager._processQueue();
check('scheduler starts the highest-priority runnable row', manager.started.join() === 'high', manager.started.join());
check('starting a row removes only that row from the queue', manager.queue.join() === 'normal,paused', manager.queue.join());
check('stale error rows leave the queue', !manager.queue.includes('error'));
check('queued-paused remains under manual control', manager.queue.includes('paused'));
check('active task receives its weighted share', manager.limits.high > 0, manager.limits.high);

const cappedManager = fakeManager([
  { id: 'capped', status: 'connecting', priority: 'normal', addedAt: now, speedLimit: 1_500_000 },
  { id: 'free', status: 'connecting', priority: 'low', addedAt: now, speedLimit: 0 },
], { globalSpeedLimit: 10_000_000 });
cappedManager.resyncScheduler();
check('a capped active task receives exactly its requested limit', cappedManager.limits.capped === 1_500_000, cappedManager.limits.capped);
check('unused capped bandwidth is redistributed to the remaining task', cappedManager.limits.free === 8_500_000, cappedManager.limits.free);

const unlimitedManager = fakeManager([
  { id: 'default', status: 'connecting', priority: 'normal', addedAt: now },
], { globalSpeedLimit: 0 });
unlimitedManager.resyncScheduler();
check('an unlimited global cap does not impose a scheduler share', unlimitedManager.limits.default === 0, String(unlimitedManager.limits.default));

const priorityManager = fakeManager([
  { id: 'row', status: 'paused', priority: 'normal', addedAt: now },
]);
priorityManager.setDownloadPriority('row', 'HIGH');
check('priority setter normalizes and persists', priorityManager.downloads.get('row').priority === 'high' && priorityManager.persistCount > 0);
check('priority setter emits an update', priorityManager.updates.some((event) => event.name === 'download-updated'));

const rateManager = fakeManager([
  { id: 'row', status: 'paused', priority: 'normal', addedAt: now },
]);
rateManager.setDownloadSpeedLimit('row', '2500000');
check('per-task speed setter sanitizes the value', rateManager.downloads.get('row').speedLimit === 2_500_000);
check('missing rows reject scheduler control changes', rateManager.setDownloadPriority('missing', 'high') === false && rateManager.setDownloadSpeedLimit('missing', 1000) === false);

console.log(`\nscheduler-manager: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
