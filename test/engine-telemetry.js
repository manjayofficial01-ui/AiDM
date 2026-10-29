'use strict';

const { runEngineBenchmark } = require('../tools/engine-benchmark');

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

async function main() {
  const report = await runEngineBenchmark({
    size: 512 * 1024,
    failDataRequests: 1,
    scenarios: [{ name: 'retry-telemetry', path: 'file.bin', maxConnections: 3 }],
  });
  const scenario = report.scenarios[0];
  const telemetry = scenario.telemetry;

  check('benchmark completes a byte-correct ranged download', scenario.state === 'completed' && scenario.bytes === 512 * 1024);
  check('benchmark records loopback fixture metadata', report.fixture.transport === 'loopback-http1' && report.fixture.rangeRequests > 0);
  check('telemetry records elapsed and first-byte timing', telemetry.elapsedMs >= 0 && telemetry.timeToFirstByteMs !== null);
  check('telemetry records tail timing', telemetry.tail5Ms !== null && telemetry.tail1Ms !== null);
  check('telemetry records the injected retry', telemetry.retries >= 1, `retries=${telemetry.retries}`);
  check('telemetry records connection activity', telemetry.connectionLaunches >= 1 && telemetry.peakConnections >= 1);
  check('writer telemetry survived writer close', telemetry.writer && telemetry.writer.bytesWritten === scenario.bytes);
  check('writer telemetry counts calls and operations', telemetry.writer.writeCalls > 0 && telemetry.writer.writeOperations >= telemetry.writer.writeCalls);
  check('writer telemetry records final sync', telemetry.writer.syncCalls >= 1 && telemetry.writer.syncTotalMs >= 0);
  check('mirror telemetry excludes URLs and credentials', telemetry.mirrors.every((m) => !('url' in m) && typeof m.host === 'string'));
  check('progress samples expose ramp and throughput history', scenario.progress.length > 0 && scenario.progress.every((p) => p.speed >= 0 && p.targetConnections >= 1));
  check('report contains no absolute output paths', !JSON.stringify(report).includes(__dirname));

  console.log(`\nengine-telemetry: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('  FAIL', err && err.stack || err);
  process.exitCode = 1;
});
