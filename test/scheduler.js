// Regression harness for the v4.3.0 download scheduler + timetabled speed
// limits + takeover-list normalizers (all original AiDM code in
// src/scheduler.js). Pure date/math logic — no timers, no network.
//
// Run: node test/scheduler.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const sched = require('../src/scheduler');
const {
  Scheduler, computeNextRun, validateSchedule, describeSchedule,
  parseTimeHHMM, parseSpeedRules, speedLimitAt,
  normalizeExtList, normalizeSiteList, COMPLETION_ACTIONS,
} = sched;

// Fixed "now": local time, so expectations are computed from the object itself.
const NOW = new Date(2026, 8, 16, 10, 30, 0); // Sep 16 2026, 10:30
const DOW = NOW.getDay();

// ── time/date parsing ──────────────────────────────────────────────────────
check('parseTimeHHMM valid', parseTimeHHMM('02:00') === 120 && parseTimeHHMM('9:05') === 545);
check('parseTimeHHMM rejects garbage',
  parseTimeHHMM('24:00') === null && parseTimeHHMM('ab') === null && parseTimeHHMM(null) === null);

// ── computeNextRun ─────────────────────────────────────────────────────────
{
  const onceFuture = computeNextRun({ enabled: true, type: 'once', time: '12:00', date: '2026-09-16' }, NOW);
  check('once later today fires today',
    onceFuture && onceFuture.getHours() === 12 && onceFuture.getDate() === 16);
  check('once in the past is null',
    computeNextRun({ enabled: true, type: 'once', time: '09:00', date: '2026-09-16' }, NOW) === null);
  check('once tomorrow fires tomorrow',
    (() => { const r = computeNextRun({ enabled: true, type: 'once', time: '09:00', date: '2026-09-17' }, NOW);
      return r && r.getDate() === 17 && r.getHours() === 9; })());
  check('disabled never fires',
    computeNextRun({ enabled: false, type: 'daily', time: '12:00' }, NOW) === null);
  check('bad time never fires',
    computeNextRun({ enabled: true, type: 'daily', time: 'xx' }, NOW) === null);

  const dailyLater = computeNextRun({ enabled: true, type: 'daily', time: '23:00' }, NOW);
  check('daily later today stays today',
    dailyLater && dailyLater.getDate() === 16 && dailyLater.getHours() === 23);
  const dailyPast = computeNextRun({ enabled: true, type: 'daily', time: '06:00' }, NOW);
  check('daily past time rolls to tomorrow',
    dailyPast && dailyPast.getDate() === 17 && dailyPast.getHours() === 6);

  const weeklyToday = computeNextRun({ enabled: true, type: 'weekly', time: '23:00', days: [DOW] }, NOW);
  check('weekly today+later fires today', weeklyToday && weeklyToday.getDate() === 16);
  const weeklyPast = computeNextRun({ enabled: true, type: 'weekly', time: '06:00', days: [DOW] }, NOW);
  check('weekly today already passed rolls a full week',
    weeklyPast && weeklyPast.getDate() === 23, weeklyPast && weeklyPast.toDateString());
  const otherDay = (DOW + 2) % 7;
  const weeklyOther = computeNextRun({ enabled: true, type: 'weekly', time: '06:00', days: [otherDay] }, NOW);
  check('weekly other weekday lands on that weekday',
    weeklyOther && weeklyOther.getDay() === otherDay && weeklyOther > NOW);
}

// ── validation ─────────────────────────────────────────────────────────────
check('valid daily passes', validateSchedule({ type: 'daily', time: '02:00' }).ok === true);
check('bad type rejected', validateSchedule({ type: 'minutely', time: '02:00' }).ok === false);
check('bad time rejected', validateSchedule({ type: 'daily', time: '25:00' }).ok === false);
check('once needs date', validateSchedule({ type: 'once', time: '02:00' }).ok === false);
check('weekly needs days',
  validateSchedule({ type: 'weekly', time: '02:00', days: [] }).ok === false);
check('bad stop-after rejected',
  validateSchedule({ type: 'daily', time: '02:00', stopAfterMinutes: -5 }).ok === false);
check('bad action rejected',
  validateSchedule({ type: 'daily', time: '02:00', onComplete: 'launch-rockets' }).ok === false);
check('completion actions known',
  COMPLETION_ACTIONS.includes('shutdown') && COMPLETION_ACTIONS.includes('notify'));

// ── describe ───────────────────────────────────────────────────────────────
{
  const d = describeSchedule({ name: 'Night', enabled: true, type: 'daily', time: '23:00', onComplete: 'shutdown' }, NOW);
  check('describe names next run + action', /Night/.test(d) && /shutdown/.test(d), d);
  check('describe disabled', /disabled/.test(describeSchedule({ name: 'X', enabled: false, type: 'daily', time: '01:00' }, NOW)));
}

// ── speed timetable ────────────────────────────────────────────────────────
{
  const { rules, errors } = parseSpeedRules('# quiet hours\n22:00-07:00=512\n09:00-18:00=256\nbogus line\n');
  check('two rules parsed, one error reported', rules.length === 2 && errors.length === 1, errors.join(';'));
  const at = (h, m) => new Date(2026, 8, 16, h, m);
  check('night rule matches', speedLimitAt(at(23, 0), rules) === 512);
  check('overnight wrap matches', speedLimitAt(at(3, 0), rules) === 512);
  check('day rule matches', speedLimitAt(at(12, 0), rules) === 256);
  check('gap returns null', speedLimitAt(at(8, 0), rules) === null);
  check('empty table returns null', speedLimitAt(at(12, 0), []) === null);
}

// ── list normalizers ───────────────────────────────────────────────────────
check('ext list normalized',
  JSON.stringify(normalizeExtList('exe, ZIP .pdf;mp4  exe')) === JSON.stringify(['exe', 'zip', 'pdf', 'mp4']));
check('site list normalized (URLs tolerated)',
  JSON.stringify(normalizeSiteList('Example.COM, https://sub.site.org/path , example.com')) ===
    JSON.stringify(['example.com', 'sub.site.org']));

// ── Scheduler class tick ───────────────────────────────────────────────────
{
  const s = new Scheduler();
  const today = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-${String(NOW.getDate()).padStart(2, '0')}`;
  const hhmm = `${String(NOW.getHours()).padStart(2, '0')}:${String(NOW.getMinutes()).padStart(2, '0')}`;
  s.configure({ schedules: [
    { id: 'a', name: 'Now', enabled: true, type: 'once', time: hhmm, date: today, stopAfterMinutes: 1 },
    { id: 'b', name: 'Off', enabled: false, type: 'once', time: hhmm, date: today },
  ] });
  let starts = 0, stops = 0;
  s.on('schedule-start', () => starts++);
  s.on('schedule-stop', () => stops++);
  s.tick(new Date(NOW.getTime() + 5000));
  s.tick(new Date(NOW.getTime() + 10000));
  check('start fires exactly once per minute', starts === 1, `${starts}x`);
  check('disabled schedule never fires', starts === 1);
  // Stop is anchored stopAfterMinutes after the firing minute.
  s.tick(new Date(NOW.getTime() + 65 * 1000));
  check('stop fires after the window', stops === 1, `${stops}x`);

  const next = s.getNextRuns(NOW);
  check('getNextRuns only lists future runs', next.every(e => e.at > NOW));
}

// ── wiring: main / server / preload / UI ───────────────────────────────────
{
  const ROOT = path.join(__dirname, '..');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  check('main creates + ticks the scheduler',
    /new Scheduler\(\)/.test(mainSrc) && /scheduler\.tick\(new Date\(\)\)/.test(mainSrc));
  check('main exposes schedule IPC',
    /get-schedules/.test(mainSrc) && /save-schedules/.test(mainSrc) && /scheduler-next/.test(mainSrc));
  check('shutdown asks first and never silently',
    /showMessageBox/.test(mainSrc) && /shutdown \/s \/t/.test(mainSrc));
  const srvSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  check('status endpoint syncs takeover controls',
    /interceptFileTypes/.test(srvSrc) && /excludedSites/.test(srvSrc) && /forceTakeoverKey/.test(srvSrc));
  const preSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  check('preload bridges scheduler IPC',
    /getSchedules/.test(preSrc) && /saveSchedules/.test(preSrc) && /onSchedulerEvent/.test(preSrc));
  const uiSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  check('UI has scheduler modal logic',
    /showSchedulerModal/.test(uiSrc) && /saveSchedulerForm/.test(uiSrc) && /setting-intercept-types/.test(uiSrc));
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  check('UI has scheduler button + modal + takeover fields',
    /btn-scheduler/.test(htmlSrc) && /scheduler-overlay/.test(htmlSrc) && /setting-excluded-sites/.test(htmlSrc));
}

console.log(`\nscheduler: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
