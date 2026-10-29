'use strict';

const { MirrorPool } = require('../src/engine/mirrors');
const { ServerProfileStore, safeOrigin } = require('../src/engine/server-profiles');

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

const nowRef = { value: 1_000_000 };
const clock = () => nowRef.value;
const newStore = (extra = {}) => new ServerProfileStore({
  now: clock,
  saveIntervalMs: 0,
  ttlMs: 60_000,
  maxHosts: 4,
  ...extra,
});

check('profile origins strip paths and credentials', safeOrigin('https://user:pass@cdn.example:8443/private/file.zip?token=secret') === 'https://cdn.example:8443');
check('profile origin rejects non-HTTP schemes', safeOrigin('file:///c:/secret') === null && safeOrigin('javascript:alert(1)') === null);

const store = newStore();
check('empty origin scores zero', store.score('http://unseen.invalid') === 0);
store.observeSuccess('https://a.invalid/file', 1_000_000, 1000);
check('successful throughput produces score', store.score('https://a.invalid/file') > 300_000, store.score('https://a.invalid/file'));
check('score key is origin only', store.score('https://a.invalid/other/path') === store.score('https://a.invalid/file'));
check('profile JSON stores origins only', !JSON.stringify(store.toJSON()).includes('/file') && !JSON.stringify(store.toJSON()).includes('token'));

store.observeFailure('https://b.invalid/file', false);
check('permanent failure quarantines origin', store.score('https://b.invalid') === 0);
const afterQuarantine = store.observeSuccess('https://b.invalid/file', 100_000, 1000);
check('healthy response clears quarantine', afterQuarantine && afterQuarantine.quarantineUntil === 0);
check('success records confidence samples', afterQuarantine.samples === 1, `samples=${afterQuarantine && afterQuarantine.samples}`);

nowRef.value += 120_000;
check('expired profiles stop affecting selection', store.score('https://a.invalid') === 0);
nowRef.value = 1_000_000;

const bounded = newStore();
for (let i = 0; i < 10; i++) {
  nowRef.value += 1;
  bounded.observeSuccess(`https://host-${i}.invalid`, 10_000, 10);
}
check('profile store is bounded', bounded.entries.size <= 4, `entries=${bounded.entries.size}`);
check('bounded store keeps recent entries', bounded.score('https://host-9.invalid') > 0 && bounded.score('https://host-0.invalid') === 0);
nowRef.value = 1_000_000;

const persisted = newStore();
persisted.observeSuccess('https://fast.invalid', 10_000_000, 1000);
const json = persisted.toJSON();
const restored = newStore().load(json);
check('server profile round-trips', restored.score('https://fast.invalid') > 0);
check('invalid profile payloads fail closed', newStore().load({ version: 2, hosts: 'bad' }).entries.size === 0 && newStore().load({ version: 1, hosts: { 'file:///x': { speedEma: 1 } } }).entries.size === 0);

const writes = [];
const saver = newStore({ persist: (json) => writes.push(json), saveIntervalMs: 0 });
saver.observeSuccess('https://persist.invalid', 1000, 10);
check('throttled persistence saves immediately when configured', writes.length === 1);
saver.close();
check('close flushes current profile snapshot', writes.length === 2 && writes[1].hosts['https://persist.invalid']);

const fast = 'https://fast.invalid/file';
const slow = 'https://slow.invalid/file';
const poolsStore = newStore();
poolsStore.observeSuccess(slow, 100_000, 1000);
poolsStore.observeSuccess(fast, 10_000_000, 1000);
const pool = new MirrorPool([slow, fast], 4, 3, { serverProfiles: poolsStore });
check('untested mirrors are probed in profile order', pool.select().url === fast);
const chosen = pool.select();
pool.acquire(chosen);
pool.reportSuccess(chosen, 200_000_000, 1000);
check('live mirror success feeds the cross-download profile', poolsStore.score('https://fast.invalid') > 10_000_000);
pool.reportFailure(pool.all.find((m) => m.url === slow), Object.assign(new Error('HTTP 403'), { retryable: false }));
check('permanent mirror failure is recorded', poolsStore.entries.get('https://slow.invalid').failures === 1);
check('mirror snapshot exposes no profile credentials', !JSON.stringify(pool.snapshot()).includes('file'));

const srcMirrorPool = new MirrorPool(['http://plain.invalid/file'], 4);
srcMirrorPool.reportSuccess(srcMirrorPool.all[0], 1_000_000, 1000);
check('MirrorPool remains backward compatible without a store', srcMirrorPool.all[0].speedEma === 1_000_000);

console.log(`\nserver-profiles: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
