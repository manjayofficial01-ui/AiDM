// Regression harness for the download-table COLUMN BUDGET (Phase 4, AUD-018).
//
// The bug this pins:
//   At the app's minimum window width (900px, main.js minWidth) the download
//   table's Actions column was pushed completely out of the visible table
//   area, and the file-name column collapsed to 78px. Cause:
//     * `table-layout: fixed` takes the column widths from the FIRST ROW and
//       IGNORES a cell's `min-width`, so the old min-width-only columns
//       (name, progress) were squeezed to the leftover;
//     * the fixed columns' widths summed past the table area, so the table
//       overflowed its container (689px of content in a 682px box) and the
//       last column (Actions = Pause / Resume / Remove) sat off-screen.
//
// The fix:
//     * every column has an explicit width; the file name is elastic;
//     * the table has a width floor equal to the sum of the column floors;
//     * the renderer re-fits the budget whenever the space changes, and the
//       give-way order keeps Actions on screen even for a hostile restored
//       width set.
//
// The layout was verified live in Chromium at 900px (overflow 0, name 154px,
// Actions flush with the container). These assertions pin the contract so a
// later change cannot silently reintroduce it.
//
// Run: node test/ui-responsive-table.js
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra == null ? '' : `— ${extra}`); }
  else { fail++; console.log('  FAIL', name, extra == null ? '' : `— ${extra}`); }
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'ui', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

// The width of one column as declared in the stylesheet.
function cssWidth(cls) {
  const m = new RegExp(`\\.${cls}\\s*\\{[^}]*width:\\s*(\\d+)px`).exec(css);
  return m ? Number(m[1]) : null;
}

console.log('\n── 1. The window minimum width the layout must survive ──');
check('the app still pins a 900px minimum window width', /minWidth:\s*900/.test(main));

console.log('\n── 2. Every column has an explicit width (no min-width-only column) ──');
const COLUMNS = ['check', 'name', 'size', 'dims', 'progress', 'speed', 'status', 'actions'];
for (const cls of COLUMNS) {
  if (cls === 'name') continue; // the file name is elastic, not a fixed width
  const w = cssWidth('col-' + cls);
  check(`.${cls} declares an explicit width`, w !== null, w == null ? 'missing' : `${w}px`);
}
check('the file-name column is the elastic one (width:auto, no hard floor)',
  /\.col-name\s*\{[^}]*width:\s*auto/.test(css));
check('no column relies on a cell min-width any more',
  !/\.col-(name|progress)\s*\{[^}]*min-width/.test(css),
  'table-layout:fixed ignores cell min-width');

console.log('\n── 3. The table floor covers the sum of the column floors ──');
const floors = { name: 140, size: 64, dims: 70, progress: 96, speed: 60, status: 84, actions: 76 };
const floorSum = Object.values(floors).reduce((a, b) => a + b, 0) + 36; // + the checkbox column
const tableMin = Number((/\.download-table\s*\{[^}]*min-width:\s*(\d+)px/.exec(css) || [])[1]);
check('the table declares a width floor', Number.isFinite(tableMin), tableMin + 'px');
check('the floor is at least the sum of the column floors',
  tableMin >= floorSum, `floor=${tableMin} sum=${floorSum}`);
check('the floor still fits the narrowest table area (682px at a 900px window)',
  tableMin <= 682, `${tableMin}px <= 682px`);

console.log('\n── 4. The renderer keeps the budget honest ──');
check('the renderer measures the space the table actually has',
  /function columnSpace\(\)/.test(app) && /clientWidth/.test(app));
check('the renderer re-fits the layout when the space changes',
  /function applyColumnLayout\(\)/.test(app));
check('a window resize re-fits the columns',
  /window\.addEventListener\('resize',\s*scheduleColumnRefit\)/.test(app));
check('the sidebar toggle re-fits the columns',
  /sidebarToggle\.addEventListener\('click',\s*scheduleColumnRefit\)/.test(app));
check('the layout is (re)applied once the table becomes visible',
  /state === 'ready'\) applyColumnLayout\(\)/.test(app),
  'a hidden table measures every column as 0px');

console.log('\n── 5. Actions can never be pushed out of view ──');
check('the give-way order ends with the Actions column',
  /COL_SHRINK_ORDER\s*=\s*\[[^\]]*'actions'\s*\]/.test(app));
check('the shrink order starts with the least important column (dims)',
  /COL_SHRINK_ORDER\s*=\s*\['dims'/.test(app));
check('the Actions column has a floor like every other column',
  /COL_MIN_WIDTH\s*=\s*\{[^}]*actions:\s*\d+/.test(app));
check('the fixed columns are clamped to their floors',
  /Math\.max\(COL_MIN_WIDTH\[key\],\s*colWidths\[key\]/.test(app));

console.log('\n── 6. The resize floors match the stylesheet ──');
const minMatch = /COL_MIN_WIDTH\s*=\s*\{([^}]*)\}/.exec(app);
check('the renderer declares a floor for every column', !!minMatch && minMatch[1].includes('actions'));
if (minMatch) {
  const declared = {};
  for (const pair of minMatch[1].split(',')) {
    const m = /(\w+):\s*(\d+)/.exec(pair);
    if (m) declared[m[1]] = Number(m[2]);
  }
  for (const key of Object.keys(floors)) {
    check(`the ${key} floor is ${floors[key]}px`,
      declared[key] === floors[key], `declared=${declared[key]}`);
  }
  const defaults = /COL_DEFAULT_WIDTH\s*=\s*\{([^}]*)\}/.exec(app);
  check('the renderer declares a default width for the fixed columns',
    !!defaults && defaults[1].includes('actions'));
  if (defaults) {
    for (const key of Object.keys(defaults[1].split(','))) {
      const m = /(\w+):\s*(\d+)/.exec(key);
      if (!m) continue;
      const declaredDefault = Number(m[2]);
      const cssDefault = cssWidth('col-' + m[1]);
      check(`the ${m[1]} default matches the stylesheet`,
        cssDefault === declaredDefault, `css=${cssDefault} js=${declaredDefault}`);
    }
  }
}

console.log('\n── 7. The last column\'s resize handle no longer overflows ──');
check('the final resize handle is pulled inside the table',
  /\.download-table th:last-child \.col-resizer\s*\{\s*right:\s*0/.test(css));

console.log('\n── 8. The narrow-window breakpoint is reachable ──');
const breakpoints = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map(m => Number(m[1]));
check('a narrow-window media query exists', breakpoints.length > 0, breakpoints.join(', '));
check('every max-width breakpoint is at or above the 900px window minimum',
  breakpoints.every(b => b >= 900), breakpoints.join(', '));

console.log(`\nui-responsive-table: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
