// AUD-015 contracts: focus visibility, target sizes, keyboard column sizing,
// and narrow-layout containment. Real rendering is verified by
// _focus-browser.js through Playwright.
//
// Run: node test/ui-focus.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'ui', 'styles.css'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}

const focusBlock = css.slice(css.indexOf('/* Visible keyboard focus for every custom control'),
  css.indexOf('.download-table th[data-sortable="1"] { cursor: pointer; }', css.indexOf('/* Visible keyboard focus')));

console.log('\n── 1. visible focus for every custom control ──');
check('the shared focus ring covers native + custom controls', () => {
  for (const selector of [
    '.col-resizer:focus-visible', '.search-clear:focus-visible', '.modal-close:focus-visible',
    '.action-btn:focus-visible', '.ctx-item:focus-visible', '.sidebar-collapse:focus-visible',
    'input[type="checkbox"]:focus-visible', 'input[type="radio"]:focus-visible',
    'input[type="text"]:focus-visible', 'select:focus-visible', 'textarea:focus-visible',
  ]) {
    assert(focusBlock.includes(selector), `missing ${selector}`);
  }
  assert(/outline: 2px solid var\(--accent\)/.test(focusBlock));
});
check('the custom switch re-declares its outline (specificity fix)', () => {
  const rule = css.slice(css.indexOf('.form-group.toggle input[type="checkbox"]:focus-visible'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert(/outline: 2px solid var\(--accent\)/.test(body), 'toggle focus rule must set the full outline');
  assert(/outline-offset: 3px/.test(body));
});
check('inputs that remove the native outline still show a ring on focus', () => {
  // .search-bar input / .form-group input / select / textarea rely on the ring
  // rules, not on the UA outline.
  assert(/\.search-bar input:focus \{[^}]*box-shadow/.test(css));
  assert(/\.form-group input:focus, \.form-group select:focus \{[^}]*box-shadow/.test(css));
});

console.log('\n── 2. target sizes (WCAG 2.2 2.5.8) ──');
check('the settings switch is at least 40×24', () => {
  const rule = css.slice(css.indexOf('.form-group.toggle input[type="checkbox"] {'), css.indexOf('.form-group.toggle input[type="checkbox"]::before'));
  assert(/width: 40px; height: 24px/.test(rule), 'switch size');
});
check('checkboxes are 16px with spaced cells', () => {
  assert(/input\[type="checkbox"\] \{[^}]*width: 16px; height: 16px/.test(css));
  assert(/\.col-check \{ width: 36px;/.test(css));
});
check('the search clear button is 26×26', () => {
  const rule = css.slice(css.indexOf('.search-clear {'), css.indexOf('.search-clear:hover'));
  assert(/width: 26px; height: 26px/.test(rule));
});
check('the column grab strip is 14px wide', () => {
  const rule = css.slice(css.indexOf('.col-resizer {'), css.indexOf('.col-resizer::after'));
  assert(/width: 14px/.test(rule));
  assert(/touch-action: none/.test(rule));
});

console.log('\n── 3. keyboard column sizing ──');
check('resizers are labelled buttons, not spans', () => {
  const tags = html.match(/<(button|span)[^>]*class="col-resizer"[^>]*>/g) || [];
  assert(tags.length === 7, `expected 7 resizers, got ${tags.length}`);
  assert(tags.every(t => t.startsWith('<button')), 'resizer must be a real button');
  assert(tags.every(t => /aria-label="Resize the [^"]+ column"/.test(t)), 'each resizer is named');
  assert(tags.every(t => /type="button"/.test(t)), 'type=button so it never submits');
});
check('Arrow keys resize and Home resets', () => {
  const fn = appSrc.slice(appSrc.indexOf('function setupColResize'), appSrc.indexOf('function toggleSidebar'));
  assert(/e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'/.test(fn));
  assert(/e\.shiftKey \? 48 : 16/.test(fn), 'shift = coarse step');
  assert(/e\.key === 'Home'/.test(fn));
  assert(/saveColWidths\(\)/.test(fn), 'keyboard sizes persist');
});
check('pointer dragging still works', () => {
  const fn = appSrc.slice(appSrc.indexOf('function setupColResize'), appSrc.indexOf('function toggleSidebar'));
  assert(/handle\.addEventListener\('mousedown'/.test(fn));
  assert(/handle\.addEventListener\('dblclick'/.test(fn));
});

console.log('\n── 4. narrow layout containment ──');
check('the table scrolls inside its container, not the page', () => {
  assert(/\.download-table-container \{[^}]*overflow: auto/.test(css));
  assert(/\.download-table-container \{[^}]*min-width: 0/.test(css));
});
check('the shell never allows a page-level horizontal scrollbar', () => {
  assert(/html, body \{ height: 100%; \}/.test(css));
  assert(/body \{[^}]*overflow: hidden/.test(css));
});
check('modals fit a narrow window', () => {
  assert(/\.modal \{[^}]*max-width: calc\(100vw - 32px\)/.test(css));
  assert(/\.modal \{[^}]*max-height: calc\(100vh - 32px\)/.test(css));
});

console.log(`\nui-focus: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
