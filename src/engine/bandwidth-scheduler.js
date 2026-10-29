'use strict';

const PRIORITY_WEIGHTS = Object.freeze({ low: 1, normal: 2, high: 3 });
const AGING_STEP_MS = 10 * 60 * 1000;
const MAX_AGING_STEPS = 1;

function normalizePriority(value) {
  const p = String(value || '').trim().toLowerCase();
  if (p === '1' || p === 'low' || p === 'lowest') return 'low';
  if (p === '3' || p === 'high' || p === 'highest' || p === 'urgent') return 'high';
  return 'normal';
}

function priorityWeight(value) {
  return PRIORITY_WEIGHTS[normalizePriority(value)] || PRIORITY_WEIGHTS.normal;
}

function agingRank(row, now = Date.now()) {
  const addedAt = Number(row && row.addedAt) || now;
  const waited = Math.max(0, now - addedAt);
  return priorityWeight(row && row.priority) + Math.min(MAX_AGING_STEPS, Math.floor(waited / AGING_STEP_MS));
}

function selectQueued(rows, slots, now = Date.now()) {
  if (!(slots > 0) || !Array.isArray(rows)) return [];
  return [...rows]
    .sort((a, b) => {
      const rankDifference = agingRank(b, now) - agingRank(a, now);
      if (rankDifference !== 0) return rankDifference;
      const ageDifference = (Number(a.addedAt) || 0) - (Number(b.addedAt) || 0);
      if (ageDifference !== 0) return ageDifference;
      return String(a.id || '').localeCompare(String(b.id || ''));
    })
    .slice(0, Math.floor(slots))
    .map((row) => row.id);
}

function normalizeLimit(value, globalCap) {
  const n = Math.floor(Number(value) || 0);
  if (n <= 0) return Number.POSITIVE_INFINITY;
  return Number.isFinite(globalCap) && globalCap > 0 ? Math.min(n, globalCap) : n;
}

function allocateBandwidth(globalBytesPerSec, rows) {
  const active = (Array.isArray(rows) ? rows : []).filter((row) => row && row.id);
  const requested = Math.floor(Number(globalBytesPerSec) || 0);
  if (requested <= 0) {
    const out = {};
    for (const row of active) {
      const explicit = Math.floor(Number(row.speedLimit) || 0);
      if (explicit > 0) out[row.id] = explicit;
    }
    return out;
  }

  const entries = active.map((row) => ({
    id: row.id,
    weight: priorityWeight(row.priority),
    limit: normalizeLimit(row.speedLimit, requested),
    allocated: 0,
  }));
  if (entries.length === 0) return {};

  let remaining = requested;
  let pool = entries.filter((entry) => entry.allocated < entry.limit);
  while (remaining > 0 && pool.length > 0) {
    const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
    const unit = remaining / totalWeight;
    const constrained = pool.reduce(
      (minimum, entry) => Math.min(minimum, (entry.limit - entry.allocated) / entry.weight),
      Number.POSITIVE_INFINITY,
    );
    const shareUnit = Math.min(unit, constrained);
    let distributed = 0;
    for (const entry of pool) {
      const granted = Math.floor(shareUnit * entry.weight);
      entry.allocated += granted;
      distributed += granted;
    }
    remaining -= distributed;
    if (!(shareUnit > 0) || distributed <= 0) {
      // Rounding can strand the last byte(s); give them to the first eligible
      // entry rather than leaving a configured cap intentionally underused.
      for (const entry of pool) {
        if (entry.allocated < entry.limit) {
          entry.allocated += remaining;
          remaining = 0;
          break;
        }
      }
      break;
    }
    pool = entries.filter((entry) => entry.allocated < entry.limit);
  }

  const out = {};
  for (const entry of entries) {
    if (Number.isFinite(entry.allocated) && entry.allocated > 0) out[entry.id] = entry.allocated;
  }
  return out;
}

module.exports = {
  PRIORITY_WEIGHTS,
  normalizePriority,
  priorityWeight,
  agingRank,
  selectQueued,
  allocateBandwidth,
};
