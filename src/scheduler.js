/**
 * Download scheduler — original AiDM implementation.
 *
 * Lets the queue start (and stop) on a timetable — overnight downloads,
 * off-peak syncing — with an optional action when the queue drains and an
 * optional per-schedule speed limit. Also hosts the timetabled speed-limit
 * rules ("slow down while I work, full speed at night").
 *
 * Design notes
 * ------------
 * - All date math here is pure and local-time based, so it is unit-testable
 *   without timers: `computeNextRun`, `speedLimitAt`, `parseSpeedRules`.
 * - The `Scheduler` class only decides WHEN things fire and emits
 *   `schedule-start` / `schedule-stop`; the main process owns the queue and
 *   the OS-level completion actions.
 * - One-shot schedules never refire inside a run (fired-key tracking) and
 *   `computeNextRun` returns null once they are in the past, so a restart
 *   cannot resurrect them.
 */

const { EventEmitter } = require('events');

const COMPLETION_ACTIONS = ['none', 'notify', 'shutdown', 'hibernate'];

// Classic auto-capture file types for browser interception. A starting
// default only — the user edits it in Settings.
const DEFAULT_INTERCEPT_TYPES = [
  'exe', 'msi', 'msix',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso',
  'pdf',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus', 'wma',
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'm4v', 'ts',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
];

/** "HH:MM" (24h) → minutes since midnight, or null. */
function parseTimeHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** "YYYY-MM-DD" → { y, m, d } or null (validated, no rollover). */
function parseDateISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return { y, mo, d };
}

function atTime(base, minutes) {
  const d = new Date(base.getTime());
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

/**
 * Next firing time for a schedule strictly after `now`, or null when there
 * is none (disabled, malformed, or a one-shot in the past).
 *
 * schedule: { enabled, type: 'once'|'daily'|'weekly', time: 'HH:MM',
 *             date: 'YYYY-MM-DD'|null, days: [0-6]|null }
 */
function computeNextRun(schedule, now) {
  if (!schedule || schedule.enabled === false) return null;
  const nowD = now instanceof Date ? now : new Date(now);
  const mins = parseTimeHHMM(schedule.time);
  if (mins === null) return null;

  if (schedule.type === 'once') {
    const p = parseDateISO(schedule.date);
    if (!p) return null;
    const at = new Date(p.y, p.mo - 1, p.d, Math.floor(mins / 60), mins % 60, 0, 0);
    return at.getTime() > nowD.getTime() ? at : null;
  }

  if (schedule.type === 'daily') {
    const today = atTime(nowD, mins);
    if (today.getTime() > nowD.getTime()) return today;
    const tomorrow = new Date(today.getTime() + 24 * 3600 * 1000);
    return tomorrow;
  }

  if (schedule.type === 'weekly') {
    const days = Array.isArray(schedule.days) && schedule.days.length
      ? [...new Set(schedule.days.map(Number).filter(d => d >= 0 && d <= 6))]
      : [0, 1, 2, 3, 4, 5, 6];
    for (let ahead = 0; ahead < 8; ahead++) {
      const cand = new Date(nowD.getTime() + ahead * 24 * 3600 * 1000);
      if (!days.includes(cand.getDay())) continue;
      const at = atTime(cand, mins);
      if (at.getTime() > nowD.getTime()) return at;
    }
    return null;
  }

  return null;
}

/** Validate a schedule object from the UI. Returns { ok, error }. */
function validateSchedule(s) {
  if (!s || typeof s !== 'object') return { ok: false, error: 'Schedule is empty' };
  if (!['once', 'daily', 'weekly'].includes(s.type)) return { ok: false, error: 'Repeat must be once, daily or weekly' };
  if (parseTimeHHMM(s.time) === null) return { ok: false, error: 'Start time must be HH:MM (24h)' };
  if (s.type === 'once' && !parseDateISO(s.date)) return { ok: false, error: 'One-time schedules need a valid date' };
  if (s.type === 'weekly' && (!Array.isArray(s.days) || !s.days.length)) {
    return { ok: false, error: 'Weekly schedules need at least one weekday' };
  }
  if (s.stopAfterMinutes != null && s.stopAfterMinutes !== '' &&
      !(Number.isFinite(Number(s.stopAfterMinutes)) && Number(s.stopAfterMinutes) > 0)) {
    return { ok: false, error: 'Stop-after must be a positive number of minutes' };
  }
  if (s.onComplete != null && !COMPLETION_ACTIONS.includes(s.onComplete)) {
    return { ok: false, error: 'Unknown completion action' };
  }
  if (s.speedLimitKBs != null && s.speedLimitKBs !== '' &&
      !(Number.isFinite(Number(s.speedLimitKBs)) && Number(s.speedLimitKBs) >= 0)) {
    return { ok: false, error: 'Speed limit must be 0 (unlimited) or more KB/s' };
  }
  return { ok: true, error: null };
}

/** "Morning backup" + next-run summary for the UI. */
function describeSchedule(s, now) {
  const name = (s && s.name && String(s.name).trim()) || 'Untitled schedule';
  if (!s || s.enabled === false) return `${name} — disabled`;
  const next = computeNextRun(s, now || new Date());
  if (!next) return `${name} — no upcoming run`;
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  let when;
  try { when = next.toLocaleString(undefined, opts); }
  catch (e) { when = next.toString(); }
  const bits = [`next ${when}`];
  if (s.stopAfterMinutes) bits.push(`stops after ${s.stopAfterMinutes} min`);
  if (s.onComplete && s.onComplete !== 'none') bits.push(`then ${s.onComplete}`);
  if (s.retryFailed) bits.push('retries failed first');
  return `${name} — ${bits.join(' · ')}`;
}

/**
 * Parse timetabled speed rules, one per line: "HH:MM-HH:MM=KBPS".
 * Overnight wraps are allowed ("22:00-07:00=512"). Bad lines are skipped
 * (with their numbers reported) so one typo never kills the whole table.
 * @returns {{ rules: Array<{fromMin,toMin,limitKBs}>, errors: Array<string> }}
 */
function parseSpeedRules(text) {
  const rules = [];
  const errors = [];
  String(text == null ? '' : text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*=\s*(\d+)$/.exec(line);
    if (!m) { errors.push(`Line ${i + 1}: expected HH:MM-HH:MM=KBPS`); return; }
    const fromMin = parseTimeHHMM(m[1]);
    const toMin = parseTimeHHMM(m[2]);
    const limitKBs = parseInt(m[3], 10);
    if (fromMin === null || toMin === null || !Number.isFinite(limitKBs)) {
      errors.push(`Line ${i + 1}: bad time or limit`);
      return;
    }
    rules.push({ fromMin, toMin, limitKBs });
  });
  return { rules, errors };
}

/** Scheduled limit (KB/s) in force at `when`, or null when no rule matches. */
function speedLimitAt(when, rules) {
  const d = when instanceof Date ? when : new Date(when);
  const mins = d.getHours() * 60 + d.getMinutes();
  for (const r of rules || []) {
    if (r.fromMin <= r.toMin) {
      if (mins >= r.fromMin && mins < r.toMin) return r.limitKBs;
    } else if (mins >= r.fromMin || mins < r.toMin) {
      return r.limitKBs; // overnight wrap
    }
  }
  return null;
}

/** "exe, zip PDF" / array → deduplicated lowercase extensions without dots. */
function normalizeExtList(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input == null ? '' : input);
  const out = [];
  const seen = new Set();
  raw.split(/[,;\s]+/).forEach(t => {
    const ext = t.trim().toLowerCase().replace(/^\.+/, '');
    if (!ext || seen.has(ext)) return;
    if (!/^[a-z0-9]{1,10}$/.test(ext)) return;
    seen.add(ext);
    out.push(ext);
  });
  return out;
}

/** "example.com, sub.site.org" / array → deduplicated lowercase hostnames. */
function normalizeSiteList(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input == null ? '' : input);
  const out = [];
  const seen = new Set();
  raw.split(/[,;\s]+/).forEach(t => {
    let h = t.trim().toLowerCase().replace(/\.$/, '');
    if (!h) return;
    try {
      // Tolerate full URLs pasted into the list — keep only the host.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) h = new URL(h).hostname.toLowerCase();
      else h = h.split('/')[0];
    } catch (e) { return; }
    h = h.replace(/\.$/, '');
    if (!h || seen.has(h)) return;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) && !/^localhost$/i.test(h)) return;
    seen.add(h);
    out.push(h);
  });
  return out;
}

/**
 * The firing datetime for a schedule ON the given date (local time), or null
 * when it does not fire that day (disabled, malformed, wrong date/weekday).
 * Unlike computeNextRun this ignores past-vs-future — the tick loop uses it
 * to match "is this minute a firing minute" without seconds-precision races.
 */
function firesAtMinute(schedule, dateObj) {
  if (!schedule || schedule.enabled === false) return null;
  const mins = parseTimeHHMM(schedule.time);
  if (mins === null) return null;
  const at = new Date(
    dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(),
    Math.floor(mins / 60), mins % 60, 0, 0
  );
  if (schedule.type === 'once') {
    const p = parseDateISO(schedule.date);
    if (!p) return null;
    return (p.y === at.getFullYear() && p.mo === at.getMonth() + 1 && p.d === at.getDate()) ? at : null;
  }
  if (schedule.type === 'daily') return at;
  if (schedule.type === 'weekly') {
    const days = Array.isArray(schedule.days) && schedule.days.length
      ? schedule.days.map(Number)
      : [0, 1, 2, 3, 4, 5, 6];
    return days.includes(at.getDay()) ? at : null;
  }
  return null;
}

function minuteKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}

class Scheduler extends EventEmitter {
  constructor() {
    super();
    this.schedules = [];
    this._firedStart = new Set(); // `${id}@${minuteKey}` — no refire within a run
    this._firedStop = new Set();
    this._firedOnceIds = new Set(); // one-shot ids already started this run
  }

  configure(settings) {
    const list = settings && Array.isArray(settings.schedules) ? settings.schedules : [];
    this.schedules = list.filter(s => s && typeof s === 'object');
  }

  /** Schedules with their next run, soonest first. */
  getNextRuns(now) {
    const at = now instanceof Date ? now : new Date(now || Date.now());
    return this.schedules
      .map(s => ({ schedule: s, at: computeNextRun(s, at) }))
      .filter(e => e.at)
      .sort((a, b) => a.at - b.at);
  }

  /**
   * Check every schedule against `now` (call ~every 20-30s). Emits
   * `schedule-start` { schedule, at } and `schedule-stop` { schedule, at }.
   * A firing matches when its minute equals the current minute — any tick
   * inside that minute catches it, and ticks outside it never refire it.
   */
  tick(now) {
    const at = now instanceof Date ? now : new Date();
    const key = minuteKey(at);
    for (const s of this.schedules) {
      if (!s || s.enabled === false || !s.id) continue;
      if (validateSchedule(s).ok === false) continue;

      const firing = firesAtMinute(s, at);
      if (firing && minuteKey(firing) === key && at.getTime() >= firing.getTime()) {
        const fk = `${s.id}@${key}`;
        const onceDone = s.type === 'once' && this._firedOnceIds.has(String(s.id));
        if (!this._firedStart.has(fk) && !onceDone) {
          this._firedStart.add(fk);
          if (s.type === 'once') this._firedOnceIds.add(String(s.id));
          this.emit('schedule-start', { schedule: s, at: new Date(at.getTime()) });
        }
      }

      // Stop: fixed offset after the firing minute. Fires on any tick at or
      // after the stop time (keyed by the firing minute) — with the old
      // "stop minute must equal the tick minute" rule, a missed minute
      // (sleep, app busy) meant the scheduled stop NEVER fired.
      const stopAfter = Number(s.stopAfterMinutes);
      if (firing && Number.isFinite(stopAfter) && stopAfter > 0) {
        const stopAt = firing.getTime() + stopAfter * 60000;
        if (at.getTime() >= stopAt) {
          const sk = `${s.id}@${minuteKey(firing)}`;
          if (!this._firedStop.has(sk)) {
            this._firedStop.add(sk);
            this.emit('schedule-stop', { schedule: s, at: new Date(at.getTime()) });
          }
        }
      }
    }
    this._pruneFired(at);
  }

  /** Fired-key sets grow one entry per schedule per run — prune old ones. */
  _pruneFired(at) {
    if (this._firedStart.size < 512 && this._firedStop.size < 512) return;
    const cutoff = at.getTime() - 2 * 24 * 60 * 60 * 1000;
    const keepRecent = (set) => {
      for (const k of set) {
        // Keys are `${id}@${Y-M-D-H-M}` — parse the minute back out.
        const m = /^(.*)@(\d+)-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(k);
        if (!m) { set.delete(k); continue; }
        const t = new Date(+m[2], +m[3], +m[4], +m[5], +m[6]).getTime();
        if (t < cutoff) set.delete(k);
      }
    };
    keepRecent(this._firedStart);
    keepRecent(this._firedStop);
  }
}

module.exports = {
  Scheduler,
  computeNextRun,
  firesAtMinute,
  validateSchedule,
  describeSchedule,
  parseTimeHHMM,
  parseSpeedRules,
  speedLimitAt,
  normalizeExtList,
  normalizeSiteList,
  COMPLETION_ACTIONS,
  DEFAULT_INTERCEPT_TYPES,
};
