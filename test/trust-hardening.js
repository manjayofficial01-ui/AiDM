// Regression contracts for the "best suggestion" audit fixes:
// selection safety, real batch intake, batch API limits, draft-only AI test,
// serialized MCP bridge, and pre-paint theme application.
// Run: node test/trust-hardening.js
'use strict';

const fs = require('fs');
const path = require('path');
const { DownloadManager } = require('../src/download-manager');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const app = read('ui', 'app.js');
const html = read('ui', 'index.html');
const server = read('src', 'server.js');
const main = read('main.js');
const managerSrc = read('src', 'download-manager.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('\n── 1. Batch intake ──');
check('the Add dialog accepts multi-line input (textarea, not a single-line input)', () => {
  assert(/<textarea id="input-url"/.test(html), 'URL field must be a textarea');
  assert(!/<input[^>]+id="input-url"/.test(html), 'old single-line input is gone');
});
check('Ctrl+Enter submits a batch, plain Enter still submits a single link', () => {
  const block = app.slice(app.indexOf("urlInput.addEventListener('keydown'"));
  assert(/e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey/.test(block.slice(0, 500)), 'Ctrl/Cmd+Enter path missing');
});
check('manager imports magnets as well as http(s) links', () => {
  const mgr = Object.create(DownloadManager.prototype);
  const seen = [];
  mgr.addDownload = (opts) => { seen.push(opts); return { id: `r${seen.length}`, url: opts.url }; };
  const out = mgr.importDownloads([
    'https://example.test/a.zip',
    'magnet:?xt=urn:btih:abc',
    'ftp://example.test/no',
  ]);
  assert(out.added === 2 && out.skipped === 1, `expected 2 added / 1 skipped, got ${out.added}/${out.skipped}`);
  assert(seen[1].url.startsWith('magnet:'), 'magnet line was dropped');
});
check('batch items carry the dialog\'s shared options', () => {
  const fn = app.slice(app.indexOf('if (lines.length > 1)'), app.indexOf('const url = lines[0]'));
  assert(/const items = lines\.map\(\(url\) => \(\{ url, \.\.\.common \}\)\)/.test(fn), 'options not forwarded to import');
});

console.log('\n── 2. Destructive-action safety ──');
check('delete-from-disk has no implicit whole-list fallback', () => {
  const fn = app.slice(app.indexOf('function deleteSelectedOrAll'), app.indexOf('async function refreshList'));
  assert(!/showDeleteModal\(downloads\.map/.test(fn), 'whole-list fallback still present');
  assert(/visibleSelectedIds\(\)/.test(fn), 'must resolve the visible selection');
});
check('bulk actions cannot act on hidden rows', () => {
  assert(/function visibleSelectedIds\(\)/.test(app), 'helper missing');
  assert(/function pruneSelectionToVisible\(\)/.test(app), 'prune helper missing');
  const cat = app.slice(app.indexOf('function activateCategory'), app.indexOf('function clearFilters'));
  assert(/pruneSelectionToVisible\(\)/.test(cat), 'category change does not prune selection');
  const bar = app.slice(app.indexOf("bindSel('btn-sel-pause'"), app.indexOf("bindSel('btn-sel-clear'"));
  assert((bar.match(/visibleSelectedIds\(\)/g) || []).length >= 3, 'selection bar still uses raw selectedIds');
});
check('Pause All also pauses in-flight connecting downloads', () => {
  const fn = app.slice(app.indexOf('async function pauseAll'), app.indexOf('async function resumeAll'));
  assert(/dl\.status === 'connecting'/.test(fn), 'connecting phase excluded');
});

console.log('\n── 3. API & process hardening ──');
check('/api/batch is rate limited', () => {
  assert(/\/api\/batch': new RateLimiter\(/.test(server), 'no batch limiter registered');
  const route = server.slice(server.indexOf("req.url === '/api/batch'"), server.indexOf("res.writeHead(404"));
  assert(/RESOLVE_LIMITERS\['\/api\/batch'\]\.allow\(\)/.test(route), 'limiter not enforced');
});
check('batch fan-out is bounded by a worker pool', () => {
  const route = server.slice(server.indexOf('const concurrency = Math.min'), server.indexOf('await Promise.all'));
  assert(/Math\.min\(8, urls\.length\)/.test(route), 'fan-out is still unbounded');
  assert(/while \(cursor < urls\.length\)/.test(route), 'worker loop missing');
});
check('MCP bridge toggles are serialized', () => {
  assert(/async function syncMcpBridgeOnce\(/.test(main), 'single-shot body missing');
  assert(/mcpBridgeSync = mcpBridgeSync\.then\(syncMcpBridgeOnce/.test(main), 'toggles not chained');
});
check('AI Test checks the draft without persisting it', () => {
  const fn = app.slice(app.indexOf('async function testAiConnection'), app.indexOf('function refreshMcpStatus'));
  assert(/aiHealthDraft\(draft\)/.test(fn), 'draft IPC not used');
  assert(!/saveSettings\(/.test(fn), 'Test still writes settings');
  assert(/ipcMain\.handle\('ai-health-draft'/.test(main), 'draft IPC handler missing');
});

console.log('\n── 4. Craft ──');
check('saved theme is applied before first paint', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert(/localStorage\.getItem\('aidm-theme'\)/.test(head), 'no pre-paint theme script');
});
check('context menu danger item has valid markup', () => {
  assert(!/class="ctx-item" danger"/.test(html), 'malformed attribute still present');
  assert(/class="ctx-item danger"/.test(html), 'danger class missing');
});

console.log(`\ntrust-hardening: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
