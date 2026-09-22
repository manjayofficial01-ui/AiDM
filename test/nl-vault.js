// Regression: NL commands parse locally; session vault encrypts cookies.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  OK  ', name); }
  else { failed++; console.log('  FAIL', name, detail || ''); }
}

console.log('── nl-command parser ──');
const { parseNlCommand } = require('../src/nl-command');

check('empty → unknown', parseNlCommand('').action === 'unknown');
check('chat stays unknown', parseNlCommand('why did my zip fail?').action === 'unknown');

const dl = parseNlCommand('download https://cdn.example/a.mp4 and https://cdn.example/b.zip');
check('download extracts urls', dl.action === 'download' && dl.urls.length === 2, JSON.stringify(dl));

const bare = parseNlCommand('https://cdn.example/only.mp4');
check('bare url is a download', bare.action === 'download' && bare.urls.length === 1);

const sp = parseNlCommand('limit speed to 512 KB/s');
check('speed 512 KB/s', sp.action === 'speed' && sp.speedBps === 512 * 1024, JSON.stringify(sp));

const sp2 = parseNlCommand('cap at 2 MB/s');
check('speed 2 MB/s', sp2.action === 'speed' && sp2.speedBps === 2 * 1024 * 1024, JSON.stringify(sp2));

const un = parseNlCommand('speed unlimited');
check('unlimited speed', un.action === 'speed' && un.speedBps === 0);

const sch = parseNlCommand('schedule daily at 22:30');
check('daily schedule', sch.action === 'schedule' && sch.repeat === 'daily' && sch.when === '22:30', JSON.stringify(sch));

const sch12 = parseNlCommand('run tonight at 10pm');
check('10pm → 22:00', sch12.action === 'schedule' && sch12.when === '22:00', JSON.stringify(sch12));

check('pause all', parseNlCommand('pause all').action === 'pause-all');
check('resume everything', parseNlCommand('resume everything').action === 'resume-all');

console.log('── session vault ──');
const { createSessionVault } = require('../src/session-vault');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-vault-'));
const key = Buffer.alloc(32, 7);
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encrypt: (s) => Buffer.from('ENC:' + s, 'utf8'),
  decrypt: (b) => {
    const t = b.toString('utf8');
    if (!t.startsWith('ENC:')) throw new Error('bad box');
    return t.slice(4);
  },
};
const vault = createSessionVault(fakeSafe, tmp);
check('available', vault.available() === true);
check('save cookies', vault.save('row-1', 'session=abc') === true);
check('load cookies', vault.load('row-1') === 'session=abc');
check('forget', vault.forget('row-1') === true);
check('load after forget is null', vault.load('row-1') === null);

const off = createSessionVault(null, tmp);
check('no safeStorage → unavailable', off.available() === false);
check('save without safe is no-op', off.save('x', 'y') === false);

const bad = createSessionVault({ encrypt: () => { throw new Error('nope'); }, decrypt: () => '', isEncryptionAvailable: () => true }, tmp);
check('encrypt throw → save false', bad.save('z', 'c') === false);

const mgrSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-manager.js'), 'utf8');
check('manager has setSessionVault', /setSessionVault\(/.test(mgrSrc));
check('manager restores vault cookies', /sessionVault\.load\(/.test(mgrSrc));
check('manager saves vault cookies', /sessionVault\.save\(/.test(mgrSrc));
check('AI summarize on finish', /_maybeAiSummarize\(/.test(mgrSrc));

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
check('main wires session vault', /createSessionVault\(/.test(mainSrc));
check('main wires nl-command', /ipcMain\.handle\('nl-command'/.test(mainSrc));
check('main auto-retries filehost wait', /autoRetryIn/.test(mainSrc) && /filehostAutoWait/.test(mainSrc));

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
check('preload exposes nlCommand', /nlCommand:/.test(preloadSrc));

console.log(`\nnl-vault: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
