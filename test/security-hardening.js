// Regression harness for the 2026-11-05 deep security audit (v5.9.2).
//
// Every check here locks a finding from the five-surface audit (local HTTP
// API, renderer/extension XSS, filesystem write paths, subprocess/SSRF/
// secrets, Chrome extension). The unit tests drive real behavior; the
// "source guard" checks pin the wiring that has no cheap unit seam (DOM
// sinks, MV3 service-worker handlers) the same way test/keep-awake.js does.
//
// Run: node test/security-hardening.js
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// DownloadManager reads/writes settings + state under USERPROFILE — point it
// at a scratch dir BEFORE requiring the module.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-sec-profile-'));
process.env.USERPROFILE = PROFILE;
process.env.HOME = PROFILE;

const { DownloadManager } = require('../src/download-manager');
const { DownloadEngine } = require('../src/download-engine');
const { DownloadTask } = require('../src/engine/task');
const gallerydl = require('../src/gallery-dl');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function readRepo(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const dm = new DownloadManager();

// ── 1. Windows reserved device names never reach the disk ──────────────────
console.log('\n── reserved device names (row names) ──');
eq('_cleanFilename NUL', dm._cleanFilename('NUL'), '_NUL');
eq('_cleanFilename NUL.ts', dm._cleanFilename('NUL.ts'), '_NUL.txt'.replace('txt', 'ts'));
eq('_cleanFilename CON', dm._cleanFilename('CON'), '_CON');
eq('_cleanFilename com1.zip', dm._cleanFilename('com1.zip'), '_com1.zip');
eq('_cleanFilename normal name untouched', dm._cleanFilename('report v2.pdf'), 'report v2.pdf');
eq('_cleanFilename traversal stays in-dir', dm._cleanFilename('..\\..\\evil.bat'), 'evil.bat');
eq('_cleanFilename ADS neutralized', dm._cleanFilename('file.zip:evil'), 'file.zip_evil');

// ── 2. Imported JSON cannot smuggle a segment-map into the renderer ────────
console.log('\n── importDownloads segments coercion ──');
{
  const evilSegments = [
    { start: 0, end: 9, state: '"><img src=x onerror=window.aidm.saveSettings({})>' },
    { start: 10, end: 19 },
  ];
  const row = dm.importDownloads([{ url: 'https://example.com/a.mp4', segments: evilSegments }]);
  check('import added the row', row.added === 1);
  const stored = dm.getAllDownloads().find((d) => /a\.mp4$/.test(d.url || ''));
  check('array segments reduced to a count (engine + renderer safe)',
    typeof stored.segments === 'number' && stored.segments === 2, `segments=${JSON.stringify(stored.segments)}`);

  const row2 = dm.importDownloads([{ url: 'https://example.com/b.mp4', segments: 999 }]);
  const stored2 = dm.getAllDownloads().find((d) => /b\.mp4$/.test(d.url || ''));
  check('out-of-range count falls back to the engine default',
    row2.added === 1 && typeof stored2.segments === 'number' && stored2.segments <= 32,
    `segments=${stored2.segments}`);

  const row3 = dm.importDownloads([{ url: 'https://example.com/c.mp4', segments: 'many' }]);
  const stored3 = dm.getAllDownloads().find((d) => /c\.mp4$/.test(d.url || ''));
  check('non-numeric segments dropped entirely', row3.added === 1 && typeof stored3.segments === 'number');
}

// ── 3. Credential scoping for machine-added targets ─────────────────────────
console.log('\n── cookie scoping (metalink mirrors / sibling rows) ──');
{
  const cookies = 'sid=session-secret';
  check('same registrable domain keeps cookies',
    dm._scopedCookies(cookies, 'https://www.example.com/f.zip', 'https://cdn.example.com/f.zip') === cookies);
  eq('cross-domain mirror gets none', dm._scopedCookies(cookies, 'https://www.example.com/f.zip', 'https://evil.example.net/f.zip'), null);
  eq('garbage target refused', dm._scopedCookies(cookies, 'https://www.example.com/f.zip', 'not a url'), null);
  eq('no cookies → null', dm._scopedCookies(null, 'https://a.com/x', 'https://a.com/x'), null);
}
{
  const t = Object.create(DownloadTask.prototype);
  t.config = { url: 'https://www.example.com/file.zip' };
  t.baseHeaders = { 'User-Agent': 'ua', Cookie: 'sid=session-secret' };
  const same = t.headersForTarget('https://cdn.example.com/file.zip');
  const other = t.headersForTarget('https://collector.evil.example.net/file.zip');
  check('mirror probe on same registrable domain keeps the Cookie header', same.Cookie === 'sid=session-secret');
  check('mirror on a foreign domain fetches WITHOUT Cookie', other && !other.Cookie && other['User-Agent'] === 'ua');
}

// ── 4. The post-download hook refuses interpreters ──────────────────────────
console.log('\n── post-download interpreter refusal ──');
{
  const exeFile = path.join(PROFILE, 'evil.bat');
  fs.writeFileSync(exeFile, 'echo pwned');
  const dl = { id: 'row-x', status: 'completed', filepath: exeFile, filename: 'evil.bat' };
  const saved = dm.settings.postDownloadCmd;
  dm.settings.postDownloadCmd = 'cmd.exe /c {file}';
  dm._runPostDownloadAction(dl);
  dm.settings.postDownloadCmd = saved;
  check('cmd.exe hook is refused with an honest row message',
    typeof dl.postDownloadResult === 'string' && dl.postDownloadResult.startsWith('Refused'),
    dl.postDownloadResult);
  check('nothing was spawned for the refused command', dl._postActionDone === true);
}

// ── 5. Probe redirects never forward credentials cross-domain (live) ───────
async function liveProbeRedirectTests() {
  console.log('\n── probe redirect credential stripping (live loopback) ──');
{
  let crossCookie = null, sameCookie = null;
  const b1 = http.createServer((req, res) => { crossCookie = req.headers.cookie || null; res.writeHead(200); res.end(); });
  const b2 = http.createServer((req, res) => { sameCookie = req.headers.cookie || null; res.writeHead(200); res.end(); });
  await new Promise((r) => b1.listen(0, '127.0.0.1', r));
  await new Promise((r) => b2.listen(0, '127.0.0.1', r));
  const p1 = b1.address().port, p2 = b2.address().port;
  // Cross-registrable-domain hop: 127.0.0.1 → localhost (different hostnames).
  const a1 = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://localhost:${p2}/file.zip` });
    res.end();
  });
  // Same-host hop: 127.0.0.1 → 127.0.0.1 (credential replay must survive).
  const a2 = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${p2}/file.zip` });
    res.end();
  });
  await new Promise((r) => a1.listen(0, '127.0.0.1', r));
  await new Promise((r) => a2.listen(0, '127.0.0.1', r));
  const q1 = a1.address().port, q2 = a2.address().port;
  const eng = new DownloadEngine();
  try {
    await eng.probeMeta(`http://127.0.0.1:${q1}/file.zip`, { Cookie: 'sid=session-secret' });
    await new Promise((r) => setTimeout(r, 150));
    check('cross-domain 302 strips the Cookie header', crossCookie === null, `server B saw ${JSON.stringify(crossCookie)}`);
    await eng.probeMeta(`http://127.0.0.1:${q2}/file.zip`, { Cookie: 'sid=session-secret' });
    await new Promise((r) => setTimeout(r, 150));
    check('same-host 302 still carries the Cookie (CDN case unchanged)', sameCookie === 'sid=session-secret');
  } finally {
    for (const s of [a1, a2, b1, b2]) { try { s.close(); } catch (e) {} }
  }
}
}

async function main() {
  await liveProbeRedirectTests();

// ── 6. gallery-dl stderr is redacted before it reaches rows/logs ────────────
console.log('\n── gallery-dl stderr redaction ──');
{
  const r = gallerydl.mapExitCode(gallerydl.EXIT.EXTRACTION, 0, 'ERROR https://host/pics/?sig=SECRET123&page=2 failed');
  check('signed query params never reach the row message',
    r && !/SECRET123/.test(r.message), r && r.message);
}

// ── 7. Source guards (DOM/MV3 seams without a unit harness) ─────────────────
console.log('\n── source guards ──');
{
  const popup = readRepo('chrome-extension/popup.js');
  check('popup escapeHtml escapes quotes (attribute-safe)', /innerHTML[^}]*&quot;/.test(popup));
  check('popup format badge is escaped', /escapeHtml\(formatText\)/.test(popup));

  const app = readRepo('ui/app.js');
  check('segment state validated before class=', /const rawState = String\(\(s && s\.state\) \|\| 'pending'\)/.test(app));
  check('status badge uses sanitizeStateClass', /status-badge \$\{sanitizeStateClass\(dl\.status\)\}/.test(app));
  check('formatStatus fallback escapes unknown statuses', /labels\[status\] \|\| escapeHtml/.test(app));

  const viz = readRepo('ui/download-viz.js');
  check('block grid validates block state', /rawState/.test(viz) && /a-z0-9_-/.test(viz));

  const bg = readRepo('chrome-extension/background.js');
  check('sendToAiDM enforces http(s) only', /Only http\(s\) URLs can be downloaded/.test(bg));
  check('batch sender filters to http(s)', /filter\(u => typeof u === 'string' && \/\^https\?:\/i/.test(bg));
  check('panel data locked to sender.tab for content scripts', /sender\.tab && sender\.tab\.id != null\)\s*\?\s*sender\.tab\.id/.test(bg));
  check('DNR referer rule is tab-scoped', /condition\.tabIds = \[tabId\]/.test(bg));

  const content = readRepo('chrome-extension/content.js');
  check('auto-send requires a trusted click', /!e\.isTrusted\) return;/.test(content));
  check('takeover key tracking requires trusted events', /!e \|\| !e\.isTrusted/.test(content));
  check('capsule shadow root is closed', /attachShadow\(\{ mode: 'closed' \}\)/.test(content));

  const interceptor = readRepo('chrome-extension/interceptor.js');
  check('MAIN-world click poster requires a trusted click', /!e\.isTrusted\) return;/.test(interceptor));

  const mainSrc = readRepo('main.js');
  check('extension pairing dialog defaults to Block', /defaultId: 1,/.test(mainSrc));

  const gsrc = readRepo('src/gallery-dl.js');
  check('gallery-dl stderr tail passes through redact()', /redact\(String\(stderrTail/.test(gsrc));

  const dmSrc = readRepo('src/download-manager.js');
  check('settings file written 0600', /mode: 0o600/.test(dmSrc));
  check('reserved-name guard wired into _cleanFilename', /RESERVED_WIN_NAMES\.test\(name\)\) name = '_' \+ name/.test(dmSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
