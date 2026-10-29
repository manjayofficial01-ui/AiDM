// APP-012 contract checks: semantic state tokens and honest state feedback.
//
// Source/DOM-contract assertions over the shipped renderer and extension files
// (the same style as ui-layout.js). Real rendering is verified by the
// _startup-browser fixture through Playwright.
//
// Run: node test/ui-states.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'ui', 'styles.css'), 'utf8');
const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.html'), 'utf8');
const contentSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  OK  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}

// The dark and light token blocks are the two top-level theme scopes.
const darkBlock = css.slice(css.indexOf(':root, html[data-theme="dark"]'), css.indexOf('html[data-theme="light"]'));
const lightBlock = css.slice(css.indexOf('html[data-theme="light"]'), css.indexOf('* { margin: 0'));

const STATE_TOKENS = [
  'state-success', 'state-warning', 'state-danger', 'state-info',
  'state-neutral', 'state-fresh', 'state-pending',
  'state-success-bg', 'state-warning-bg', 'state-danger-bg', 'state-info-bg',
  'state-neutral-bg', 'state-fresh-bg', 'state-pending-bg',
  'state-success-border', 'state-warning-border', 'state-danger-border',
  'state-info-border', 'state-neutral-border', 'state-fresh-border', 'state-pending-border',
];

console.log('\n── 1. Semantic state token contract (AUD-017) ──');
check('every state token is defined in both themes', () => {
  for (const token of STATE_TOKENS) {
    assert(darkBlock.includes(`--${token}:`), `dark theme missing --${token}`);
    assert(lightBlock.includes(`--${token}:`), `light theme missing --${token}`);
  }
});
check('status badges read tokens, not raw colors', () => {
  const badgeBlock = css.slice(css.indexOf('.status-badge.downloading'), css.indexOf('.col-status .status-badge'));
  assert(badgeBlock.length > 0);
  assert(!/#[0-9A-Fa-f]{3,8}|rgba?\(/.test(badgeBlock), 'badge rules still contain raw colors');
  assert(/var\(--state-(info|success|warning|danger|neutral|fresh|pending)(-bg|-border)?\)/.test(badgeBlock));
});
check('elevation, focus and radius tokens exist', () => {
  for (const token of ['elevation-1', 'elevation-2', 'focus-ring', 'radius-sm']) {
    assert(darkBlock.includes(`--${token}:`), `missing --${token}`);
  }
});
check('the extension uses the same token names', () => {
  for (const token of ['state-success', 'state-warning', 'state-danger', 'state-info']) {
    assert(popup.includes(`--${token}:`), `popup missing --${token}`);
    assert(contentSrc.includes(`--${token}:`), `capsule missing --${token}`);
  }
});
check('popup status dot and badges read tokens', () => {
  assert(!/\.status-dot \{[^}]*#[0-9a-f]{6}/i.test(popup), 'status dot still hard-codes a color');
  assert(!/\.status-dot\.connected \{[^}]*#[0-9a-f]{6}/i.test(popup), 'connected dot still hard-codes a color');
  assert(/\.status-dot\.connected \{[^}]*var\(--state-success\)/.test(popup));
  assert(/\.quality-badge\.playing-badge \{[^}]*var\(--state-success-bg\)/.test(popup));
});
check('reduced-motion is honoured for the new animations', () => {
  assert(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}?\.boot-spinner \{ animation: none; \}/.test(css));
  assert(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}?field-reject \{ animation: none; \}/.test(css));
});

console.log('\n── 2. Empty vs filtered states (AUD-014) ──');
check('empty canvas has distinct title, hint and both actions', () => {
  assert(/id="empty-title"/.test(html));
  assert(/id="empty-hint"/.test(html));
  assert(/id="btn-empty-add"/.test(html));
  assert(/id="btn-empty-clear"/.test(html));
  assert(/id="empty-state"[^>]*role="status"[^>]*aria-live="polite"/.test(html));
});
check('filtered-empty copy is computed from the active filter', () => {
  const fn = appSrc.slice(appSrc.indexOf('function renderEmptyState'), appSrc.indexOf('function activateCategory'));
  assert(/hasActiveFilters\(\)/.test(fn));
  assert(/No downloads match your search/.test(fn));
  assert(/Nothing in this category/.test(fn));
  assert(/btn-empty-clear/.test(fn), 'clear-filters action toggled');
  assert(/btn-empty-add/.test(fn), 'add action hidden while filtered');
});
check('search and category are the filter inputs', () => {
  assert(/activeCategory !== 'all'/.test(appSrc));
  assert(/searchInput\.value/.test(appSrc));
});
check('Clear filters resets search AND category', () => {
  const fn = appSrc.slice(appSrc.indexOf('function clearFilters'), appSrc.indexOf('function renderDownloads'));
  assert(/searchInput\.value = ''/.test(fn));
  assert(/activateCategory\('all'\)/.test(fn));
});
check('empty state is only rendered after a ready boot', () => {
  assert(/bootState === 'ready'[\s\S]{0,120}?renderEmptyState\(\)/.test(appSrc));
});

console.log('\n── 3. Add-URL validation (AUD-014) ──');
check('the URL field has an inline error element and description', () => {
  assert(/id="group-url"/.test(html));
  assert(/aria-describedby="input-url-error"/.test(html));
  assert(/id="input-url-error"[^>]*role="alert"/.test(html));
});
check('an empty submit is no longer silent', () => {
  const fn = appSrc.slice(appSrc.indexOf('async function startNewDownload'));
  assert(/if \(!raw\) \{[\s\S]{0,120}?setUrlError\(/.test(fn), 'empty value must set an inline error');
  assert(!/if \(!raw\) return;/.test(fn), 'the silent early-return is gone');
});
check('non-link input is rejected with a scheme hint', () => {
  const fn = appSrc.slice(appSrc.indexOf('async function startNewDownload'), appSrc.indexOf('async function exportDownloadsJson'));
  assert(/https\?:\\\/\\\/\|magnet:/.test(fn), 'scheme validation present');
  assert(/is not a link|doesn’t look like a link/.test(fn), 'actionable copy present');
});
check('the error clears on edit and on close', () => {
  assert(/urlInput\.addEventListener\('input', \(\) => setUrlError\(null\)\)/.test(appSrc));
  const hide = appSrc.slice(appSrc.indexOf('function hideAddModal'), appSrc.indexOf('async function startNewDownload'));
  assert(/setUrlError\(null\)/.test(hide));
});
check('error state is announced and visually distinct', () => {
  assert(/input\.setAttribute\('aria-invalid', 'true'\)/.test(appSrc));
  assert(/classList\.add\('has-error', 'field-reject'\)/.test(appSrc));
  assert(/\.form-group\.has-error input/.test(css));
  assert(/\.field-error\.visible \{ display: block; \}/.test(css));
});
check('Enter submits from the URL field', () => {
  assert(/keydown[\s\S]{0,160}?e\.key === 'Enter'[\s\S]{0,120}?startNewDownload\(\)/.test(appSrc));
});

console.log(`\nui-states: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
