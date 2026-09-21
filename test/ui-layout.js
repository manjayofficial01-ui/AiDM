// Regression harness for the v4.3.4 layout overhaul:
//   1. icon-only toolbar (text labels cost ~60% of toolbar width),
//   2. a layout that actually follows window resizes (wrap, fluid table,
//      capped modals, collapsible sidebar).
//
// Asserts over the SHIPPED markup/styles/script (no DOM needed).
// Run: node test/ui-layout.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'ui', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');

function buttonInner(id) {
  const m = new RegExp(`<button[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/button>`, 'i').exec(html);
  return m ? m[1] : null;
}
function buttonAttr(id, attr) {
  const m = new RegExp(`<button[^>]*id="${id}"[^>]*${attr}="([^"]*)"`, 'i').exec(html);
  return m ? m[1] : null;
}

// ── 1. icon-only toolbar ───────────────────────────────────────────────────
const TOOLBAR_BTNS = [
  'btn-add-url', 'btn-pause-all', 'btn-resume-all', 'btn-delete',
  'btn-delete-all', 'btn-refresh', 'btn-ai-assistant', 'btn-settings', 'btn-scheduler',
];
for (const id of TOOLBAR_BTNS) {
  const inner = buttonInner(id);
  const text = inner == null ? null : inner.replace(/<span class="btn-icon">[\s\S]*?<\/span>/g, '').trim();
  check(`toolbar ${id} is icon-only`, inner !== null && text === '', text === '' ? '' : JSON.stringify(text));
  check(`toolbar ${id} keeps tooltip + label`,
    !!buttonAttr(id, 'title') && !!buttonAttr(id, 'aria-label'));
}
check('toolbar icons keep their glyphs',
  TOOLBAR_BTNS.every(id => /btn-icon/.test(buttonInner(id) || '')));

// ── 2. responsive toolbar ──────────────────────────────────────────────────
check('toolbar wraps on narrow windows',
  /\.toolbar\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
check('toolbar groups wrap + shrink',
  /\.toolbar-group\s*\{[^}]*flex-wrap:\s*wrap/.test(css) && /\.toolbar-group\s*\{[^}]*min-width:\s*0/.test(css));
check('toolbar buttons are fixed icon squares (modal buttons untouched)',
  /\.toolbar\s+\.tool-btn\s*\{[^}]*width:\s*34px/.test(css));
check('speed/active pills never wrap internally',
  /\.speed-display,\s*\.status-display\s*\{[^}]*white-space:\s*nowrap/.test(css));

// ── 3. fluid main area ─────────────────────────────────────────────────────
check('download area can shrink with the window',
  /\.download-area\s*\{[^}]*min-width:\s*0/.test(css));
check('table scrolls both axes instead of clipping',
  /\.download-table-container\s*\{[^}]*overflow:\s*auto/.test(css));
check('name column is flexible (no 250px floor)',
  !/\.col-name\s*\{\s*min-width:\s*250px/.test(css) && /\.col-name\s*\{[^}]*min-width:\s*140px/.test(css));
check('file names fill the cell instead of a fixed 300px cap',
  !/max-width:\s*300px/.test(css));

// ── 4. collapsible sidebar ─────────────────────────────────────────────────
check('sidebar collapse button exists',
  /id="btn-sidebar-collapse"/.test(html));
check('collapsed sidebarCSS hides labels, keeps icons',
  /body\.sidebar-collapsed\s+\.sidebar\s*\{[^}]*width:\s*54px/.test(css) &&
  /body\.sidebar-collapsed\s+\.sidebar\s+\.cat-label/.test(css));
check('sidebar items keep tooltips for icon mode',
  (html.match(/class="sidebar-item[^"]*"[^>]*title="/g) || []).length >= 11);
check('sidebar toggle wired + implemented',
  /btn-sidebar-collapse'\)\.addEventListener\('click', toggleSidebar\)/.test(app) &&
  /function toggleSidebar\(\)/.test(app));

// ── 5. modals / chrome follow resizes ──────────────────────────────────────
check('modals cap to the viewport',
  /\.modal\s*\{[^}]*max-width:\s*calc\(100vw - 32px\)/.test(css));
check('status bar wraps instead of overflowing',
  /\.status-bar\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
check('narrow-window rules shed chrome',
  /@media\s*\(max-width:\s*640px\)/.test(css) && /\.app-subtitle\s*\{\s*display:\s*none/.test(css));
check('form rows wrap in narrow modals',
  /\.form-row\s*\{[^}]*flex-wrap:\s*wrap/.test(css));

// ── 6. Jev assist toggle (v4.8.2) ────────────────────────────────────────────
check('settings exposes the Jev assist toggle',
  /id="setting-jev-assist"/.test(html));
check('settings loads the Jev assist toggle (default on)',
  /getElementById\('setting-jev-assist'\)\.checked = settings\.jevAssist !== false/.test(app));
check('settings saves the Jev assist toggle',
  /jevAssist: document\.getElementById\('setting-jev-assist'\)\.checked/.test(app));

// ── 7. Quality picker must not reset the selection on a duplicate video-detected
//      (auto-resolve + the googlevideo guard reroute both fire for one click)
//      — otherwise the user's mid-pick selection snaps back to "highest quality".
//      And AFTER the user already picked, a delayed emit must not flip the
//      overlay back open behind the location dialog either.
console.log('\nQuality picker: same-video dedupe');
const pickerFn = /function showQualityPicker\(data\) \{([\s\S]*?)\n\}/.exec(app);
check('showQualityPicker exists', !!pickerFn);
if (pickerFn) {
  // Two layers of dedupe. The "sticky" guard (pageUrl remembered for the
  // session) closes the post-pick re-open bug. The "overlay visible" guard
  // is the original fast path for back-to-back emits during one pick.
  check('a sticky "shown for this pageUrl" guard exists',
    /let qualityShownForPageUrl = null/.test(app));
  check('the sticky guard bails before re-rendering',
    /if \(qualityShownForPageUrl === incomingPageUrl\) return;/.test(pickerFn[1]));
  check('bails when the overlay is already visible for the same pageUrl',
    /quality-overlay[\s\S]{0,120}qualityContext\.pageUrl === /.test(pickerFn[1]) ||
    /qualityContext[\s\S]{0,200}pageUrl === incomingPageUrl/.test(pickerFn[1]));
  check('only dedupes when the pageUrl actually matches (new video → fresh render)',
    /incomingPageUrl/.test(pickerFn[1]));
  check('does NOT silently drop a different video while one is open',
    /incomingPageUrl/.test(pickerFn[1]));
}

// ── 8. downloadSelectedQuality must not claim success when nothing was queued
//      (resolveFailed / thrown IPC / duplicate all used to fall through to
//      "Video download started" — the user waits for a row that never exists).
console.log('\nQuality picker: honest result reporting');
const dqFn = /async function downloadSelectedQuality\(\) \{([\s\S]*?)\n\}/.exec(app);
check('downloadSelectedQuality exists', !!dqFn);
if (dqFn) {
  const body = dqFn[1];
  check('captures the addDownload result instead of awaiting blindly',
    /let result;\s*try\s*\{\s*result = await window\.aidm\.addDownload\(/.test(body) ||
    /result = await window\.aidm\.addDownload\(/.test(body));
  check('reports resolveFailed instead of "started"',
    /result\s*&&\s*result\.resolveFailed/.test(body));
  check('reports an in-band success:false response',
    /result\.success === false/.test(body));
  check('catches a thrown IPC (no unguarded await)',
    /catch \(e\)[\s\S]{0,200}showNotification\([\s\S]{0,80}'error'\)/.test(body));
  check('keeps the picker open on failure (returns before hideQualityPicker)',
    /resolveFailed[\s\S]{0,400}return;/.test(body) &&
    /showNotification\([^)]*'error'\);\s*\n\s*return;/.test(body));
  check('does NOT unconditionally toast "Video download started"',
    !/await window\.aidm\.addDownload\(\{[\s\S]*?\}\);\s*\n\s*hideQualityPicker\(\);/.test(body));
  check('distinguishes a duplicate row from a fresh one',
    /result\.duplicate/.test(body) && /Already in the download list/.test(body));
}

console.log(`\nui-layout: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
