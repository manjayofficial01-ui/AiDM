// @ts-check
/**
 * Natural-language queue commands for AiDM's AI assistant.
 * Parses short operator phrases into concrete actions without a network call.
 * Pure — injectable and unit-testable. Never throws on garbage input.
 */

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/**
 * @param {string} text
 * @returns {{ action: string, urls?: string[], speedBps?: number, when?: string, repeat?: string, note?: string }}
 */
function parseNlCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return { action: 'unknown' };
  const lower = raw.toLowerCase();
  const urls = raw.match(URL_RE) || [];

  if (urls.length && (/^(download|get|grab|queue|fetch|add)\b/i.test(raw) ||
      urls.length === raw.split(/\s+/).filter(Boolean).length)) {
    return { action: 'download', urls, note: `Queue ${urls.length} URL(s)` };
  }

  if (/(speed|bandwidth|throttle|cap|limit)/i.test(raw) || /unlimited/i.test(raw)) {
    if (/unlimited|no\s+limit|remove\s+limit|full\s+speed/i.test(lower)) {
      return { action: 'speed', speedBps: 0, note: 'Speed limit removed' };
    }
    const m = lower.match(/(\d+(?:\.\d+)?)\s*(kb\/s|kbs|kbps|mb\/s|mbs|mbps|kb|mb)\b/);
    if (m) {
      const n = parseFloat(m[1]);
      const bps = /mb|mbs|mbps/.test(m[2]) ? n * 1024 * 1024 : n * 1024;
      return { action: 'speed', speedBps: Math.round(bps), note: `Speed limit ${m[1]} ${m[2]}` };
    }
  }

  if (/schedule|every\s+day|daily|weekly|tonight|at\s+\d/i.test(lower)) {
    let when = null;
    const t24 = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    const t12 = lower.match(/\b(\d{1,2})\s*(?::([0-5]\d))?\s*(am|pm)\b/);
    if (t24) when = `${String(t24[1]).padStart(2, '0')}:${t24[2]}`;
    else if (t12) {
      let h = parseInt(t12[1], 10) % 12;
      if (t12[3] === 'pm') h += 12;
      when = `${String(h).padStart(2, '0')}:${(t12[2] || '00')}`;
    }
    let repeat = 'once';
    if (/daily|every\s+day/i.test(lower)) repeat = 'daily';
    else if (/weekly|every\s+week/i.test(lower)) repeat = 'weekly';
    return { action: 'schedule', when: when || '22:00', repeat, note: `Schedule ${repeat} at ${when || '22:00'}` };
  }

  if (/^(pause|stop)\b/i.test(raw) && /(all|everything|queue)/i.test(lower)) {
    return { action: 'pause-all', note: 'Pausing all downloads' };
  }
  if (/^(resume|start|continue)\b/i.test(raw) && /(all|everything|queue)/i.test(lower)) {
    return { action: 'resume-all', note: 'Resuming all downloads' };
  }

  if (urls.length) return { action: 'download', urls, note: `Queue ${urls.length} URL(s)` };
  return { action: 'unknown' };
}

module.exports = { parseNlCommand, URL_RE };
