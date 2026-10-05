// Unit tests for the FluxDown-derived ramp controller + domain conn-caps. Run: node test/ramp-controller.js
const rc = require('../src/engine/ramp-controller');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

console.log('── ramp-controller (FluxDown port) ──');

// rampVerdict three-way.
check('verdict improved', rc.rampVerdict(100, 200) === 'improved');
check('verdict freeze (small drop)', rc.rampVerdict(100, 90) === 'freeze');
check('verdict collapse (>=50% drop)', rc.rampVerdict(100, 40) === 'collapse');
check('verdict freeze at boundary 0.5', rc.rampVerdict(100, 50) === 'freeze');

// isTail requires BOTH conditions.
check('tail when small + near EOF', rc.isTail(1.5 * 1024 * 1024, 16, 1e9) === true);
check('not tail when far from EOF', rc.isTail(200 * 1024 * 1024, 16, 1e9) === false);
check('not tail when large remaining', rc.isTail(100 * 1024 * 1024, 16, 1e9) === false);

// dynamicMinSplitBytes by throughput tier.
check('min-split low bw = 512KB', rc.dynamicMinSplitBytes(500 * 1024) === 512 * 1024);
check('min-split mid bw = 1MB', rc.dynamicMinSplitBytes(5 * 1024 * 1024) === 1024 * 1024);
check('min-split high bw = 2MB', rc.dynamicMinSplitBytes(20 * 1024 * 1024) === 2 * 1024 * 1024);

// RampController starts conservative and ramps up on steadily improving throughput.
// Each expand is followed by an eval window; the eval must show >5% gain to keep
// expanding (mirrors FluxDown's improve/freeze/collapse verdict).
const c = new rc.RampController({ maxCap: 16, now: 0 });
check('starts at RAMP_INITIAL_WORKERS', c.allowed === rc.RAMP_INITIAL_WORKERS, `allowed=${c.allowed}`);
let expanded = 0;
// Strictly improving throughput each eval window (x1.15 per window > IMPROVE_FACTOR).
let tp = 1e6;
let now = 0;
for (let i = 0; i < 12; i++) {
  now += 2000;
  tp *= 1.15;
  const r = c.tick({ throughputBps: tp, alive: c.allowed, remaining: 1e9, total: 1e9, now });
  if (r.action === 'expand') expanded++;
}
check('ramps up on improving throughput', expanded >= 3 && c.allowed > rc.RAMP_INITIAL_WORKERS, `expanded=${expanded}, allowed=${c.allowed}`);

// Collapse on a throughput cliff (expand tick, then eval tick with a cliff).
const c2 = new rc.RampController({ maxCap: 16, now: 0 });
c2.tick({ throughputBps: 5e6, alive: 2, remaining: 1e9, total: 1e9, now: 2000 }); // expand -> 3
const before = c2.allowed; // 3
const cr = c2.tick({ throughputBps: 5e6 * 0.3, alive: before, remaining: 1e9, total: 1e9, now: 4000 }); // eval -> collapse
check('collapse detected on throughput cliff', cr.action === 'collapse', `action=${cr.action}`);
check('collapse rolls back below pre-grow', cr.collapsedTo != null && cr.collapsedTo < before, `rolled=${cr.collapsedTo} before=${before}`);
check('hard freeze after collapse', c2.freeze.kind === 'hard');

// Positive hint starts at that scale.
const c3 = new rc.RampController({ maxCap: 16, hint: 8, now: 0 });
check('positive hint starts at hint scale', c3.allowed === 8, `allowed=${c3.allowed}`);

// Domain conn-caps learn + rollback.
const caps = new rc.DomainConnCaps();
caps.recordSuccess('cdn.example', 16);
check('hint recorded on success', caps.getHint('cdn.example') === 16);
caps.recordCollapse('cdn.example', 4);
check('negative cap recorded on collapse', caps.getNegative('cdn.example') === 4);
check('hint lowered to negative cap', caps.getHint('cdn.example') === 4);
const caps2 = new rc.DomainConnCaps(caps.toJSON());
check('conn-caps serialise/restore', caps2.getNegative('cdn.example') === 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
