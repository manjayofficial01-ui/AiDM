// APP-006 / APP-007 / APP-009 contract checks.
//
// These are source/DOM-contract assertions over the SHIPPED renderer files,
// in the same style as ui-layout.js: they pin the accessibility semantics and
// startup-state wiring that the real Chromium fixture then exercises.
//
// Run: node test/startup-a11y.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'ui', 'styles.css'), 'utf8');
const managerSrc = fs.readFileSync(path.join(ROOT, 'src', 'download-manager.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}

console.log('\n── 1. Startup states (APP-007) ──');
check('a boot state exists with a Retry control', () => {
  assert(/id="boot-state"/.test(html));
  assert(/id="btn-boot-retry"/.test(html));
  assert(/id="boot-text"/.test(html));
});
check('the table and empty state start hidden (no false empty library)', () => {
  assert(/<table class="download-table" id="download-table" style="display:none;"/.test(html));
  assert(/<div class="empty-state" id="empty-state" style="display:none;"/.test(html));
});
check('the shell wires itself before awaiting IPC', () => {
  const init = appSrc.slice(appSrc.indexOf("document.addEventListener('DOMContentLoaded'"));
  const body = init.slice(0, init.indexOf('});'));
  assert(/setupEventListeners\(\)/.test(body), 'listeners must attach synchronously');
  assert(/setupIPCListeners\(\)/.test(body), 'IPC listeners must attach synchronously');
  assert(/bootstrapLibrary\(\)/.test(body));
  assert(!/await window\.aidm\.getDownloads\(\)/.test(body), 'init must not block on IPC');
});
check('load, empty and failure are distinct states', () => {
  const fn = appSrc.slice(appSrc.indexOf('async function bootstrapLibrary'), appSrc.indexOf("document.addEventListener('DOMContentLoaded'"));
  assert(/setBootState\('loading'\)/.test(fn));
  assert(/setBootState\('ready'\)/.test(fn));
  assert(/catch \(e\)[\s\S]{0,600}?setBootState\('error'/.test(fn), 'a failed load must show the error state');
  assert(/Array\.isArray\(rows\) \? rows : \[\]/.test(fn), 'junk IPC payload must not crash rendering');
});
check('a successful retry/refresh recovers the error state', () => {
  assert(/btn-boot-retry'\)[\s\S]{0,160}?bootstrapLibrary\(\)/.test(appSrc));
  const refresh = appSrc.slice(appSrc.indexOf('async function refreshList'));
  assert(/catch \(err\)[\s\S]{0,160}?showNotification\([^)]*'error'\)/.test(refresh.slice(0, 1400)),
    'refresh failure must not use a success toast');
});
check('the empty state is never shown while loading or in error', () => {
  const fn = appSrc.slice(appSrc.indexOf('function setBootState'), appSrc.indexOf('async function bootstrapLibrary'));
  assert(/emptyState\.style\.display = 'none'/.test(fn));
});
check('aria-live status on the boot region', () => {
  assert(/id="boot-state"[^>]*role="status"[^>]*aria-live="polite"/.test(html));
});

console.log('\n── 2. Keyboard access to core journeys (APP-006) ──');
check('category filters are real buttons with pressed state', () => {
  const items = html.match(/<(button|div)[^>]*class="sidebar-item[^"]*"/g) || [];
  assert(items.length >= 11, 'all categories present');
  assert(items.every(tag => tag.startsWith('<button')), 'no pointer-only category divs');
  assert((html.match(/data-category=/g) || []).length === (html.match(/aria-pressed=/g) || []).length,
    'every category exposes aria-pressed');
  assert(/setAttribute\('aria-pressed', on \? 'true' : 'false'\)/.test(appSrc),
    'active state stays in sync');
});
check('sortable headers are focusable and announce sort state', () => {
  const ths = html.match(/<th class="[^"]*" data-col="[^"]+" data-sortable="1"[^>]*>/g) || [];
  assert(ths.length === 5, 'five sortable columns');
  assert(ths.every(t => /tabindex="0"/.test(t)), 'each header is keyboard reachable');
  assert(ths.every(t => !/role="button"/.test(t)), 'column-header semantics are preserved');
  assert(/aria-sort/.test(appSrc), 'aria-sort is maintained');
  assert(/keydown[\s\S]{0,300}?toggleSort/.test(appSrc), 'Enter/Space sorts');
});
check('quality options are a keyboard radio group', () => {
  assert(/setAttribute\('role', 'radiogroup'\)/.test(appSrc));
  assert(/setAttribute\('role', 'radio'\)/.test(appSrc));
  assert(/setAttribute\('aria-checked', 'true'\)/.test(appSrc));
  assert(/ArrowDown' \|\| e\.key === 'ArrowUp'/.test(appSrc), 'arrow-key navigation exists');
});
check('dialogs expose dialog semantics and take initial focus', () => {
  const dialogs = html.match(/role="dialog" aria-modal="true"/g) || [];
  assert(dialogs.length === 8, 'all eight modals are dialogs, got ' + dialogs.length);
  assert(/aria-labelledby="[a-z-]+-title"/.test(html), 'dialogs are labelled by their heading');
  assert(/function openOverlay[\s\S]{0,1800}?\.focus\(\)/.test(appSrc), 'opening moves focus inside');
  assert(/overlayReturnFocus[\s\S]{0,300}?prev\.focus/.test(appSrc), 'closing restores focus');
});
check('every form control has an accessible name', () => {
  // A label "counts" when it has for= OR wraps its own control (weekday
  // checkboxes). Everything else must carry aria-label.
  const labelBlocks = html.match(/<label(?:\s[^>]*)?>[\s\S]*?<\/label>/g) || [];
  const unassociated = labelBlocks.filter(l => !/for="/.test(l) && !/<input|<select|<textarea/.test(l));
  assert(unassociated.length <= 1, 'unassociated labels remain: ' + unassociated.length);
  const controls = html.match(/<(input|select|textarea)\b[^>]*>/g) || [];
  const unnamed = controls.filter(tag => {
    if (/type="hidden"/.test(tag)) return false;
    if (/aria-label=/.test(tag)) return false;
    const id = /id="([^"]+)"/.exec(tag);
    if (id && html.includes(`for="${id[1]}"`)) return false;
    // Wrapped by its own label: find the nearest preceding <label ...> whose
    // block contains this exact tag.
    const at = html.indexOf(tag);
    const before = html.lastIndexOf('<label', at);
    if (before !== -1) {
      const close = html.indexOf('</label>', at);
      const block = html.slice(before, close === -1 ? at : close + 8);
      if (block.includes('<input') || block.includes('<select')) return false;
    }
    return true;
  });
  assert(unnamed.length === 0, 'unnamed controls: ' + unnamed.map(t => t.slice(0, 80)).join(' | '));
});
check('toasts are announced (polite status, assertive errors)', () => {
  assert(/setAttribute\('aria-live', 'polite'\)/.test(appSrc));
  assert(/kind === 'error' \? 'alert' : 'status'/.test(appSrc));
});
check('custom focus rings exist for the new controls', () => {
  assert(/\.sidebar-item:focus-visible/.test(css));
  assert(/\.quality-option:focus-visible/.test(css));
  assert(/th\[data-sortable="1"\]:focus-visible/.test(css));
});
check('row checkboxes and search have names', () => {
  assert(/aria-label="Select all downloads"/.test(html));
  assert(/id="search-input" aria-label=/.test(html));
  assert(/aria-label="Select \$\{escapeAttr\(dl\.filename\)\}"/.test(appSrc));
});

console.log('\n── 3. Bounded, visible persistence (APP-009) ──');
check('non-forced writes coalesce instead of stacking', () => {
  assert(/_stateFlushTimer/.test(managerSrc));
  assert(/sinceWrite < 1500/.test(managerSrc));
  assert(/unref\?\.\(\)/.test(managerSrc), 'the trailing flush must not hold the process open');
});
check('state JSON is compact (machine state, not a document)', () => {
  assert(!/JSON\.stringify\(data, null, 2\)/.test(managerSrc), 'pretty state serialization removed');
  assert(/fs\.writeFileSync\(tmpPath, JSON\.stringify\(data\)\)/.test(managerSrc));
});
check('disk failures are captured and emitted once per streak', () => {
  assert(/lastPersistError/.test(managerSrc));
  assert(/firstFailure[\s\S]{0,300}?emit\('persist-error'/.test(managerSrc));
  assert(/emit\('persist-recovered'/.test(managerSrc));
});
check('persistence events reach the renderer', () => {
  assert(/'persist-error', 'persist-recovered'/.test(mainSrc), 'main forwards both events');
  assert(/onPersistError/.test(preloadSrc) && /onPersistRecovered/.test(preloadSrc));
  assert(/setPersistStatus\(/.test(appSrc));
  assert(/id="persist-status"[^>]*role="status"/.test(html));
});

console.log(`\nstartup-a11y: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
