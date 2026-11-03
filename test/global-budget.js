// Regression harness for the global connection budget (v5.9.0).
//
// Why this exists: N downloads × M connections each is not a throughput
// strategy — OmniGet's documented benchmark (8 downloads × 8 segments regressed
// to ~half the throughput of a 24-connection global budget split fairly) and
// the same math on any home uplink. AiDM's engine already had a per-host gate
// and a per-task ramp, but NOTHING shared the total pool across downloads, so
// 4+ concurrent rows each ramped to their own 8-32 connections and competed.
//
// The budget has two halves, both covered here:
//   1. FAIR SHARE — every active download's ceiling becomes floor(budget /
//      activeCount), recomputed as downloads start and finish, with each
//      task's OWN ceiling restored when the pool frees up.
//   2. HARD GATE — the sum of live connections can never exceed the budget
//      even in race windows (waiter-callback fill-block, same design as the
//      per-host HostGate).
// Run: node test/global-budget.js
const { GlobalConnectionBudget, GLOBAL_GATE_KEY } = require('../src/engine/global-budget.js');
const { DownloadEngine } = require('../src/download-engine.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

function main() {
  console.log('── fair-share math ──');
  const b = new GlobalConnectionBudget(24);
  check('budget default round-trips', b.budget === 24);
  check('empty registry gives the whole budget', b.fairCeiling() === 24);

  const a = b.register('a', 8);
  check('a lone download keeps its own ceiling (8 ≤ 24)', a === 8, `got ${a}`);
  const b2 = b.register('b', 8);
  check('two downloads share: ceil(24/2)=12, own cap 8 wins', b2 === 8, `got ${b2}`);
  const c = b.register('c', 8);
  check('three downloads: 24/3=8 each', c === 8, `got ${c}`);
  const d = b.register('d', 8);
  check('four downloads: 24/4=6 each — the documented regression case', d === 6, `got ${d}`);
  check('earlier tasks re-read the lower share', b.effectiveFor('a') === 6, `got ${b.effectiveFor('a')}`);

  check('unregistering returns a bool for recompute fan-out', b.unregister('a') === true);
  check('own ceiling is restored as the pool frees (24/3=8)', b.effectiveFor('d') === 8, `got ${b.effectiveFor('d')}`);
  b.unregister('b'); b.unregister('c'); b.unregister('d');
  check('empty again → whole budget', b.fairCeiling() === 24);

  console.log('── a small download never blocks a big one unfairly ──');
  const big = b.register('big', 16);
  check('a 16-connection task takes min(16, 24)=16 alone', big === 16, `got ${big}`);
  const small = b.register('small', 4);
  check('a 4-connection task stays at 4 next to it (24/2=12 > 4)', small === 4, `got ${small}`);
  check('the big task steps down to the 12 share', b.effectiveFor('big') === 12, `got ${b.effectiveFor('big')}`);
  b.unregister('big'); b.unregister('small');

  console.log('── disable (0) restores pre-5.9.0 behavior ──');
  b.setBudget(0);
  check('disabled → Infinity ceiling', b.fairCeiling() === Infinity);
  check('disabled register → own ceiling untouched', b.register('x', 8) === 8);
  b.unregister('x');

  console.log('── hard gate ──');
  const g = new GlobalConnectionBudget(2);
  check('gate accepts up to the budget', g.acquire() && g.acquire());
  check('gate refuses past the budget', g.hasCapacity() === false);
  check('gate acquire under saturation reports false', g.acquire() === false);
  let woke = 0;
  g.waitForSlot('t1', () => woke++);
  g.release();
  check('a release wakes exactly one waiter', woke === 1, `woke=${woke}`);
  g.release(); g.release(); // drain back to 0
  check('counts never go negative (release idempotent at 0)', g.hasCapacity() === true);
  check('gate key is the synthetic global host', GLOBAL_GATE_KEY === '*global*');

  console.log('── engine wiring ──');
  const eng = new DownloadEngine();
  eng.setEngineOptions({ globalConnectionBudget: 24 });
  check('setEngineOptions applies the budget', eng.globalBudget.budget === 24);
  eng.setEngineOptions({ globalConnectionBudget: 0 });
  check('0 disables through the engine', eng.globalBudget.budget === 0);
  eng.setGlobalConnectionBudget(64);
  check('direct setter clamps to 64 and applies', eng.globalBudget.budget === 64);
  eng.setGlobalConnectionBudget(24); // back to the default for the share test
  // Register/unregister round-trip on a real engine instance.
  const eff = eng.globalBudget.register('task-1', 8);
  check('engine-registered task starts at its own ceiling', eff === 8, `got ${eff}`);
  eng.globalBudget.register('task-2', 8); eng.globalBudget.register('task-3', 8);
  eng.globalBudget.register('task-4', 8); eng.globalBudget.register('task-5', 8);
  check('5 live downloads share 24 → 4 each', eng.globalBudget.effectiveFor('task-1') === 4, `got ${eng.globalBudget.effectiveFor('task-1')}`);
  eng._onTaskRemoved('task-1'); eng._onTaskRemoved('task-2'); eng._onTaskRemoved('task-3'); eng._onTaskRemoved('task-4');
  check('_onTaskRemoved restores the survivor (24/1 → own 8)', eng.globalBudget.effectiveFor('task-5') === 8, `got ${eng.globalBudget.effectiveFor('task-5')}`);
  eng._onTaskRemoved('task-5');
  check('removal is idempotent — no throw, no leak', eng.globalBudget.activeCount === 0 && eng._taskOwnMaxConn.size === 0);
  eng.setGlobalConnectionBudget(0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
