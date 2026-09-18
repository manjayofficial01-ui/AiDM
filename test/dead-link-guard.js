// Regression harness for the "whatever video you try to download sticks at
// 0% / fails with HTTP 404" bug (mydaddy.cc report, fixed in v4.2.1).
//
// Root cause chain:
//   1. Sites like mydaddy.cc put TIME-LIMITED CDN links on the page; by the
//      time the user clicked, the link was already dead (HTTP 404).
//   2. The capsule offered the dead link prominently (labeled 1080P with a
//      size) while the real player variants showed as unlabeled "VIDEO ·
//      unknown size" rows — because /pubs/<id>/1080.mp4 has no "1080p" text.
//   3. The desktop skipped its liveness signal (_probe=null on 404) and still
//      created a 16-segment download that sat at 0% "DOWNLOADING" before
//      failing with the raw "Server responded with HTTP 404".
//
// This harness exercises the SHIPPED code (extracted, not copied):
//   - deadLinkMessage / isDeadProbeStatus (src/download-manager.js)
//   - detectQuality path-quality detection (chrome-extension/content.js)
//   - the wiring: add-time guard, capsule probe request + dead-row drop,
//     background probe endpoint with Range/cookies.
const fs = require('fs');
const path = require('path');

function grab(srcFile, name) {
  const src = fs.readFileSync(srcFile, 'utf8');
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in ' + srcFile);
  const j = src.indexOf('{', i);
  let d = 0, inRe = false, inStr = null, esc = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (inRe) {
      if (c === '\\') esc = true;
      else if (c === '/') inRe = false;
      else if (c === '[') { const e = src.indexOf(']', k); if (e > 0) k = e; }
      continue;
    }
    // comments FIRST — shipped functions contain prose with braces/apostrophes
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && /[(,=:?!&|{;\[]/.test(src[k - 1] || '(')) { inRe = true; continue; }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const ROOT = path.join(__dirname, '..');
const MANAGER = path.join(ROOT, 'src', 'download-manager.js');
const BG = path.join(ROOT, 'chrome-extension', 'background.js');
const CONTENT = path.join(ROOT, 'chrome-extension', 'content.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// ── 1. shipped helpers: deadLinkMessage / isDeadProbeStatus ──────────────────
const deadLinkMessage = new Function(grab(MANAGER, 'deadLinkMessage') + '\nreturn deadLinkMessage;')();
const isDeadProbeStatus = new Function(grab(MANAGER, 'isDeadProbeStatus') + '\nreturn isDeadProbeStatus;')();

const m404 = deadLinkMessage(404);
check('404 message says the link expired + tells the user what to do',
  /expired/i.test(m404) && /404/.test(m404) && /[Rr]e-?detect|[Dd]ownload again|[Ff]resh/.test(m404),
  JSON.stringify(m404.slice(0, 60)) + '…');

const m410 = deadLinkMessage(410);
check('410 message names 410 (gone)', m410.includes('410') && m410.includes('gone'));

check('dead statuses are exactly 404/410',
  isDeadProbeStatus(404) === true && isDeadProbeStatus(410) === true &&
  isDeadProbeStatus(403) === false && isDeadProbeStatus(200) === false &&
  isDeadProbeStatus(206) === false && isDeadProbeStatus(500) === false &&
  isDeadProbeStatus(null) === false && isDeadProbeStatus(undefined) === false &&
  isDeadProbeStatus(0) === false);


// ── 2. shipped detectQuality: KVS/CDN path labels ────────────────────────────
const QUALITY_MAP = {
  '2160p': { resolution: '3840x2160', label: '4K (2160p)', tier: 5 },
  '1440p': { resolution: '2560x1440', label: '2K (1440p)', tier: 4 },
  '1080p': { resolution: '1920x1080', label: 'Full HD (1080p)', tier: 3 },
  '720p':  { resolution: '1280x720',  label: 'HD (720p)', tier: 2 },
  '480p':  { resolution: '854x480',   label: 'SD (480p)', tier: 1 },
  '360p':  { resolution: '640x360',   label: '360p', tier: 0 },
  '240p':  { resolution: '426x240',   label: '240p', tier: -1 },
};
const detectQuality = new Function(
  'QUALITY_MAP', 'window', 'probeSizeAsync',
  grab(CONTENT, 'detectQuality') + '\nreturn detectQuality;'
)(QUALITY_MAP, { location: { origin: 'https://somewhere.example' } }, () => {});

const NO_EL = null;
const q1080 = detectQuality('https://s43.bigcdn.cc/pubs/6aa99cc8e5db31.94221158/1080.mp4', NO_EL);
check('KVS path /1080.mp4 → 1080p · 1920x1080',
  q1080.quality === '1080p' && q1080.resolution === '1920x1080' && q1080.format === 'mp4',
  q1080.quality + ' ' + q1080.resolution);

check('KVS path /720.mp4 → 720p',
  detectQuality('https://cdn.example/pubs/x/720.mp4', NO_EL).quality === '720p');
check('KVS path /480.mp4?sig=1 → 480p (query tolerated)',
  detectQuality('https://cdn.example/pubs/x/480.mp4?sig=1', NO_EL).quality === '480p');
check('non-KVS URL stays unknown',
  detectQuality('https://example.com/video/watch', NO_EL).quality === 'unknown');

// element-provided quality must still win over the URL path guess
const el720 = { dataset: { quality: '720p' }, getAttribute: () => null };
check('element quality label wins over path guess',
  detectQuality('https://cdn.example/pubs/x/1080.mp4', el720).quality === '720p');

// ── 3. wiring: add-time dead-link guard in the manager ──────────────────────
const mgrSrc = fs.readFileSync(MANAGER, 'utf8');
check('manager fails at ADD time on dead probe (fresh starts only)',
  /isDeadProbeStatus\(meta\.status\)/.test(mgrSrc) &&
  /download\.downloaded === 0/.test(mgrSrc) &&
  /deadLinkMessage\(meta\.status\)/.test(mgrSrc));
check('mid-stream failures get friendly messages (404/410 expired, 401/403 blocked, 501 method)',
  /HTTP \(404\|410\|401\|403\|501\)\\b|HTTP \(404\|410/.test(mgrSrc) && /deadLinkMessage\(code\)/.test(mgrSrc) && /accessDeniedMessage\(code\)/.test(mgrSrc) && /methodBlockedMessage\(code\)/.test(mgrSrc));

// ── 4. wiring: capsule probe-before-offer ────────────────────────────────────
const bgSrc = fs.readFileSync(BG, 'utf8');
const ctSrc = fs.readFileSync(CONTENT, 'utf8');
check("background serves 'probe-streams' with a 1-byte Range GET",
  bgSrc.includes("action === 'probe-streams'") &&
  /'Range'[\s\S]{0,40}bytes=0-0/.test(bgSrc));
check('probe classifies 404/410 as dead, network errors as unknown',
  /status === 404 \|\| status === 410/.test(bgSrc) &&
  /dead:\s*false/.test(bgSrc));
check('probe attaches site cookies like the desktop download would',
  /collectCookies\(cookieHosts\)/.test(bgSrc));
check('capsule drops dead rows and fills real sizes',
  ctSrc.includes("action: 'probe-streams'") &&
  /if \(p\.dead\) return false;/.test(ctSrc) &&
  /if \(p\.size && !v\.size\) v\.size = p\.size;/.test(ctSrc));
check('capsule collapses same-file duplicates (path rendition quality resolution size)',
  /collapseRowKey\(v\)/.test(ctSrc) && /mergeRowInto\(prev, v\)/.test(ctSrc));

console.log('\ndead-link-guard: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
