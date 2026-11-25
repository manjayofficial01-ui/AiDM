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
  // Count only real attributes (quoted `data-category="…"`). The v5.9.3
  // toolbar added a quick-jump button whose onclick JS references
  // `.sidebar-item[data-category=pending]` — an unquoted SELECTOR string
  // that must not inflate the attribute count.
  assert((html.match(/data-category="/g) || []).length === (html.match(/aria-pressed=/g) || []).length,
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
  // Dynamic count: adding a modal (e.g. Transfer Health) must not silently
  // ship an overlay without dialog semantics.
  const overlays = html.match(/class="modal-overlay"/g) || [];
  assert(dialogs.length === overlays.length,
    `every overlay must be a labelled dialog (${dialogs.length}/${overlays.length})`);
  assert(/aria-labelledby="[a-z-]+-title"/.test(html), 'dialogs are labelled by their heading');
  assert(/function openOverlay[\s\S]{0,1800}?\.focus\(\)/.test(appSrc), 'opening moves focus inside');
  assert(/overlayReturnFocus[\s\S]{0,300}?prev\.focus/.test(appSrc), 'closing restores focus');
});
check('every form control has an accessible name', () => {
  // A label "counts" when it has for= pointing at THIS control, or when it
  // actually wraps it. The previous heuristic looked only for "the nearest
  // preceding <label>" and treated ANY input/select inside that slice as a
  // wrapper — which let an unlabelled control borrow the label of a
  // different control further up the page (the seven category-path inputs
  // slipped through that way). Labels are now matched to their real bounds.
  const labelOpens = [];
  const openRe = /<label(?:\s[^>]*)?>/g;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    labelOpens.push({ start: m.index, end: m.index + m[0].length, for: (/for="([^"]+)"/.exec(m[0]) || [])[1] });
  }
  const labelCloses = [];
  const closeRe = /<\/label>/g;
  while ((m = closeRe.exec(html)) !== null) labelCloses.push(m.index);
  // Match each label opening with its closing tag (labels are not nested).
  for (const l of labelOpens) {
    l.close = labelCloses.find(c => c > l.start);
    l.body = l.close === undefined ? html.slice(l.end) : html.slice(l.end, l.close);
  }
  // A control is wrapped when it sits between a label's open and close.
  const wrappedBy = (at) => labelOpens.find(l => l.close !== undefined && l.start < at && at < l.close);

  // Every label must either point at a control or contain one.
  const unassociated = labelOpens.filter(l => !l.for && !/<input|<select|<textarea/.test(l.body));
  assert(unassociated.length === 0,
    'labels with neither a for= nor a contained control: ' + unassociated.length);

  const controls = [];
  const controlRe = /<(input|select|textarea)\b[^>]*>/g;
  while ((m = controlRe.exec(html)) !== null) controls.push({ tag: m[0], at: m.index });
  const unnamed = controls.filter(c => {
    if (/type="hidden"/.test(c.tag)) return false;
    if (/aria-label=/.test(c.tag) || /aria-labelledby=/.test(c.tag)) return false;
    const id = (/id="([^"]+)"/.exec(c.tag) || [])[1];
    if (id && labelOpens.some(l => l.for === id)) return false;
    const wrapper = wrappedBy(c.at);
    if (wrapper && /<input|<select|<textarea/.test(wrapper.body)) return false;
    return true;
  });
  assert(unnamed.length === 0, 'unnamed controls: ' + unnamed.map(c => c.tag.slice(0, 80)).join(' | '));

  // The category-path inputs are the ones this heuristic used to miss.
  const catPaths = controls.filter(c => /id="cat-path-/.test(c.tag));
  assert(catPaths.length === 7, 'seven category-path inputs, got ' + catPaths.length);
  for (const c of catPaths) {
    const id = (/id="([^"]+)"/.exec(c.tag) || [])[1];
    assert(labelOpens.some(l => l.for === id), 'category path input has no label: ' + id);
  }
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
