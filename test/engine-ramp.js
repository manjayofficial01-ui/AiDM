// Integration test for the ramp controller wired into DownloadTask. Run: node test/engine-ramp.js
const { DownloadTask } = require('../src/engine/task');
const { SegmentManager } = require('../src/engine/segments');
const { RampController, DomainConnCaps } = require('../src/engine/ramp-controller');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

console.log('── task.js ramp integration (FluxDown port) ──');

function makeTask() {
  const caps = new DomainConnCaps();
  const t = new DownloadTask(
    { url: 'https://cdn.example.com/big.bin', adaptiveConnections: true, maxConnections: 16, initialConnections: 8, directory: "." },
    { domainConnCaps: caps },
  );
  t.segments = SegmentManager.fresh(1e9, t.segmentOptions({ acceptRanges: true, size: 1e9 }));
  t.info = { acceptRanges: true, size: 1e9, finalUrl: 'https://cdn.example.com/big.bin' };
  t.forceSingleConnection = false;
  // Replicate prepare()'s ramp build.
  const host = t.hostFromUrl();
  t.ramp = new RampController({ maxCap: t.config.maxConnections, now: 0 });
  t.targetConnections = t.ramp.allowed;
  t.meter = { bytesPerSecond: () => 5e6 };
  return { t, caps, host };
}

const { t, caps, host } = makeTask();
check('segmentOptions carries dynamicMinSplit', t.segmentOptions({ acceptRanges: true, size: 1e9 }).dynamicMinSplit === t.config.minSplitSize);
check('segmentOptions enables tailMicroSplit', t.segmentOptions({ acceptRanges: true, size: 1e9 }).tailMicroSplit === true);
check('hostFromUrl extracts registrable host', host === 'cdn.example.com', host);
check('starts conservative (RAMP_INITIAL_WORKERS)', t.targetConnections === 2, `target=${t.targetConnections}`);

// Improving throughput ramps up. The real loop only launches connections up to
// targetConnections, so we simulate `alive` connections keeping pace with the cap.
let now = 0;
for (let i = 0; i < 8; i++) {
  now += 2000;
  t.active = new Map(Array.from({ length: t.targetConnections }, (_, k) => [k, 1]));
  t.meter = { bytesPerSecond: () => 5e6 * (1 + i * 0.2) };
  t.adapt(now);
}
check('ramp raised targetConnections above start', t.targetConnections > 2, `target=${t.targetConnections}`);
check('positive hint recorded for host', caps.getHint(host) != null, `hint=${caps.getHint(host)}`);

// Server push-back (429/503) collapses to a recorded lower cap.
const { t: t2, caps: caps2, host: host2 } = makeTask();
t2.targetConnections = 10;
t2.active = new Map([['a', 1], ['b', 2], ['c', 3]]); // 3 live
t2.backOffConnections({ message: '429 Too Many Requests' });
check('backOff collapses connections', t2.targetConnections < 10, `target=${t2.targetConnections}`);
check('backOff records negative cap for host', caps2.getNegative(host2) === t2.targetConnections, `neg=${caps2.getNegative(host2)}`);

// A second task on the same host starts at the recorded (low) scale.
const { t: t3, host: host3 } = makeTask();
// Simulate a prior collapse persisted in the shared caps.
caps2.recordCollapse(host3, 3);
const t3b = new DownloadTask(
  { url: 'https://cdn.example.com/other.bin', adaptiveConnections: true, maxConnections: 16, initialConnections: 8, directory: "." },
  { domainConnCaps: caps2 },
);
t3b.segments = SegmentManager.fresh(1e9, t3b.segmentOptions({ acceptRanges: true, size: 1e9 }));
t3b.info = { acceptRanges: true, size: 1e9, finalUrl: 'https://cdn.example.com/other.bin' };
t3b.forceSingleConnection = false;
const hint3 = caps2.getHint(host3);
const neg3 = caps2.getNegative(host3);
t3b.ramp = new RampController({ maxCap: t3b.config.maxConnections, hint: hint3, negativeCap: neg3, now: 0 });
// New task starts at the *proven* hint (2), which is safely below the negative
// collapse cap (3) — it must never start above a known-bad scale.
check('new task starts at proven hint', t3b.ramp.allowed === hint3 && hint3 <= neg3, `allowed=${t3b.ramp.allowed} hint=${hint3} neg=${neg3}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
