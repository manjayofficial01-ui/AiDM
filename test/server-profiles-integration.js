'use strict';

const fs = require('fs');
const path = require('path');
const { DownloadTask } = require('../src/engine/task');
const { ServerProfileStore } = require('../src/engine/server-profiles');
const { startFixture, payloadFor } = require('../tools/engine-benchmark');

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
  const workspaceTmp = path.join(__dirname, '..', '.openclaw', 'tmp');
  fs.mkdirSync(workspaceTmp, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(workspaceTmp, 'server-profile-task-'));
  const payload = payloadFor(256 * 1024);
  const fixture = await startFixture(payload);
  try {
    const profiles = new ServerProfileStore({ saveIntervalMs: Number.MAX_SAFE_INTEGER });
    const directory = path.join(tmp, 'task');
    fs.mkdirSync(directory, { recursive: true });
    const task = new DownloadTask({
      url: `${fixture.origin}/file.bin`,
      directory,
      filename: 'file.bin',
      maxConnections: 2,
      initialConnections: 2,
      minSplitSize: 64 * 1024,
      adaptiveConnections: false,
      onConflict: 'overwrite',
    }, { serverProfiles: profiles });

    const state = await task.start();
    check('DownloadTask records completed transfers in the server profile', state === 'completed' && profiles.score(fixture.origin) > 0, state);
    check('DownloadTask profile omits file paths and query strings', !JSON.stringify(profiles.toJSON()).includes('/file.bin'));
    check('DownloadTask mirror telemetry exposes origins instead of signed URLs', task.getTelemetry().mirrors.every((mirror) => !('url' in mirror)));
    const task2 = new DownloadTask({
      url: `${fixture.origin}/file.bin`,
      directory,
      filename: 'profiled-second.bin',
      maxConnections: 2,
      initialConnections: 2,
      minSplitSize: 64 * 1024,
      adaptiveConnections: false,
      onConflict: 'overwrite',
    }, { serverProfiles: profiles });
    check('later task inherits the persisted origin score', task2.mirrors.all[0].initialScore > 0);
    check('later task completed state', await task2.start() === 'completed');
  } finally {
    await fixture.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  console.log(`\nserver-profiles-integration: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('  FAIL', err && err.stack || err);
  process.exitCode = 1;
});
