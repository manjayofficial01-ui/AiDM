// App-aware bandwidth (adaptiveBandwidth, market-research cycle 3): AiDM runs
// unlimited while the machine is idle, holds a polite cap while OTHER apps
// consume the network, and lifts it when they go idle — without touching an
// explicit user limit, timetable or schedule. The Windows sampler
// (src/bandwidth-watch.js) streams typeperf counters; the state machine needs
// two consecutive verdicts before it flips.
// Run: node test/app-aware-throttle.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// DownloadManager reads/writes settings + state under USERPROFILE — point it
// at a scratch dir BEFORE requiring the module.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-app-aware-profile-'));
process.env.USERPROFILE = PROFILE;
process.env.HOME = PROFILE;

const { DownloadManager } = require('../src/download-manager');
const { BandwidthWatch } = require('../src/bandwidth-watch');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const MB = 1024 * 1024;

(async () => {
  console.log('\n── 1. typeperf line parsing ──');
  check('real CSV sample sums every counter field',
    BandwidthWatch.parseLine('"10/27/2026 23:15:01.123", "1234.000000", "766.000000"') === 2000);
  check('header line is not a sample',
    BandwidthWatch.parseLine('"(PDH-CSV 4.0) (West Europe Standard Time)(-120)","\\\\PC\\Network Interface\\Bytes Total/sec"') === null);
  check('empty line is not a sample', BandwidthWatch.parseLine('') === null);
  check('garbage line is not a sample', BandwidthWatch.parseLine('Exiting, please wait...') === null);
  check('zero-traffic sample is a valid sample', BandwidthWatch.parseLine('"t", "0.000000", "0.000000"') === 0);

  console.log('\n── 2. the busy/idle state machine (two consecutive verdicts) ──');
  {
    const mgr = new DownloadManager();
    mgr.settings.adaptiveBandwidth = true;
    const events = [];
    mgr.on('adaptive-changed', (e) => events.push(e));

    mgr._onTrafficSample({ totalBytesPerSec: 2 * MB, at: Date.now() });
    check('one busy sample does not flip', mgr.adaptiveBusy === false);
    mgr._onTrafficSample({ totalBytesPerSec: 2 * MB, at: Date.now() });
    check('two busy samples flip to busy', mgr.adaptiveBusy === true);
    check('exactly one event fired for the flip',
      events.length === 1 && events[0].busy === true, JSON.stringify(events));
    mgr._onTrafficSample({ totalBytesPerSec: 3 * MB, at: Date.now() });
    check('staying busy fires nothing', events.length === 1);

    mgr._onTrafficSample({ totalBytesPerSec: 0.2 * MB, at: Date.now() });
    check('one idle sample does not flip', mgr.adaptiveBusy === true);
    mgr._onTrafficSample({ totalBytesPerSec: 0.2 * MB, at: Date.now() });
    check('two idle samples flip back', mgr.adaptiveBusy === false);
    check('the lift fired its own event',
      events.length === 2 && events[1].busy === false, JSON.stringify(events));
    mgr.removeAllListeners?.();
  }

  console.log('\n── 3. AiDM\'s own traffic is subtracted first ──');
  {
    const mgr = new DownloadManager();
    mgr.settings.adaptiveBandwidth = true;
    const events = [];
    mgr.on('adaptive-changed', (e) => events.push(e));

    // Machine total 10 MB/s, AiDM itself pulls 9.5 MB/s → others use 0.5 MB/s.
    mgr._noteSpeed('dl-1', 9.5 * MB);
    mgr._onTrafficSample({ totalBytesPerSec: 10 * MB, at: Date.now() });
    mgr._onTrafficSample({ totalBytesPerSec: 10 * MB, at: Date.now() });
    check('AiDM\'s own 9.5 MB/s are not mistaken for other apps',
      mgr.adaptiveBusy === false && events.length === 0, JSON.stringify(events));

    // A browser joins in: machine total rises to 11 MB/s → others 1.5 MB/s.
    mgr._onTrafficSample({ totalBytesPerSec: 11 * MB, at: Date.now() });
    mgr._onTrafficSample({ totalBytesPerSec: 11 * MB, at: Date.now() });
    check('genuinely foreign traffic flips busy', mgr.adaptiveBusy === true);
    mgr.removeAllListeners?.();
  }

  console.log('\n── 4. disabled by default and by the toggle ──');
  {
    const mgr = new DownloadManager();
    check('default is off', mgr.settings.adaptiveBandwidth === false);
    check('watch is not running by default', mgr.bandwidthWatch.running === false);
    const events = [];
    mgr.on('adaptive-changed', (e) => events.push(e));
    mgr._onTrafficSample({ totalBytesPerSec: 50 * MB, at: Date.now() });
    mgr._onTrafficSample({ totalBytesPerSec: 50 * MB, at: Date.now() });
    check('samples are ignored while disabled',
      mgr.adaptiveBusy === false && events.length === 0);
    mgr.removeAllListeners?.();
  }

  console.log('\n── 5. saveSettings starts/stops the sampler live ──');
  {
    const mgr = new DownloadManager();
    const started = [], stopped = [];
    mgr.bandwidthWatch = { start: () => started.push(1), stop: () => stopped.push(1), running: false };
    mgr.saveSettings({ adaptiveBandwidth: true });
    check('enabling starts the watch', started.length === 1 && stopped.length === 0);
    mgr.saveSettings({ adaptiveBandwidth: false });
    check('disabling stops the watch and clears the busy state',
      stopped.length === 1 && mgr.adaptiveBusy === false && mgr._adaptiveRecent.length === 0);
  }

  console.log('\n── 6. the sampler is inert off-Windows (no spawn attempted) ──');
  {
    const watch = new BandwidthWatch({
      platform: 'linux',
      spawnFn: () => { throw new Error('spawn must not be called off-Windows'); },
    });
    watch.start();
    check('off-Windows start stays inert', watch.running === false);
    watch.stop();
  }

  console.log('\n── 7. the sampler stream (injected child) ──');
  {
    const stdout = new EventEmitter();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.kill = () => { child.killed = true; };
    const spawnArgs = {};
    const watch = new BandwidthWatch({
      platform: 'win32',
      spawnFn: (cmd, args) => { spawnArgs.cmd = cmd; spawnArgs.args = args; return child; },
    });
    const samples = [];
    watch.on('sample', (s) => samples.push(s));
    watch.on('unavailable', () => samples.push('unavailable'));
    watch.start();
    stdout.emit('data', '"(PDH-CSV 4.0)","\\\\PC\\if\\Bytes Total/sec"\n');
    stdout.emit('data', '"t1", "1000.000000", "500.000000"\n"t2", "250.0');
    stdout.emit('data', '00000"\n');
    check('typeperf is the sampler command', spawnArgs.cmd === 'typeperf' &&
      spawnArgs.args.includes('\\Network Interface(*)\\Bytes Total/sec'), JSON.stringify(spawnArgs));
    check('lines split across chunks are still parsed',
      samples.length === 2 && samples[0].totalBytesPerSec === 1500 && samples[1].totalBytesPerSec === 250,
      JSON.stringify(samples));
    watch.stop();
    check('stop kills the child', child.killed === true && watch.running === false);
    stdout.emit('data', '"t3", "999.000000"\n');
    check('no samples after stop', samples.length === 2);
  }

  console.log('\n── 8. wiring: the limit chain in main.js ──');
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check('adaptive branch sits in applyTimetableSpeed',
      /source === 'default' && desired === 0 &&\s*\n?\s*s\.adaptiveBandwidth === true && downloadManager\.adaptiveBusy/.test(mainSrc));
    check('the flip recomputes the limit immediately',
      /downloadManager\.on\('adaptive-changed', \(\) => applyTimetableSpeed\(\)\)/.test(mainSrc));
    check('quit stops the sampler',
      /before-quit[\s\S]{0,600}bandwidthWatch\.stop\(\)/.test(mainSrc));
    const mgrSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-manager.js'), 'utf8');
    check('progress paths feed the own-speed tracker',
      (mgrSrc.match(/_noteSpeed/g) || []).length >= 4, 'engine + torrent + youtube + definition');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 1000).unref();
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
