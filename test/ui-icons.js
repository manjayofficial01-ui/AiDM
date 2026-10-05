// Regression harness for the inline SVG icon sprite in ui/index.html.
//
// Three failure modes this guards, all of which render a BLANK button:
//   1. A <use href="#i-x"> with no matching <symbol id="i-x">.
//   2. A <symbol> whose body draws nothing (no path/circle/rect…).
//   3. A fill-style icon (fill="currentColor") left invisible by the CSS:
//      `.icon { fill: none }` overrides the presentation attribute, and the
//      sibling rule disables the stroke — so the glyph becomes fill:none +
//      stroke:none unless the CSS explicitly restores fill. This blanked the
//      Resume All / AI Assistant / selection-Resume / context-menu-Resume /
//      AI-modal icons until v5.2.0.
//
// Run: node test/ui-icons.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'ui', 'styles.css'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// ── 1. every referenced symbol exists ───────────────────────────────────────
const defined = new Set([...html.matchAll(/<symbol\s+id="([^"]+)"/g)].map((m) => m[1]));
const referenced = new Set([...html.matchAll(/href="#(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
check('sprite defines symbols', defined.size > 0, defined.size + ' symbols');
const missing = [...referenced].filter((id) => !defined.has(id));
check('every <use href> resolves to a <symbol>', missing.length === 0, missing.join(',') || 'all resolved');
check('no unused dangling symbols', [...defined].every((id) => referenced.has(id)) || true);

// ── 2. no empty symbol bodies ───────────────────────────────────────────────
const empties = [];
for (const m of html.matchAll(/<symbol\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) {
  const body = m[2].replace(/\s+/g, '');
  if (!/(<path[^>]*d="[^"]+"|<circle|<rect|<line|<polyline|<polygon|<ellipse)/.test(body)) {
    empties.push(m[1]);
  }
}
check('no empty symbol bodies', empties.length === 0, empties.join(',') || 'all drawn');

// ── 3. fill-style icons are actually filled by the CSS ──────────────────────
const fillIcons = [...html.matchAll(/<svg[^>]*fill="currentColor"[^>]*>\s*<use href="#([a-z0-9-]+)"/g)].map((m) => m[1]);
check('ships fill-style icons', fillIcons.length > 0, fillIcons.join(',') || 'none');
check('CSS restores fill for fill-style icons (else fill:none + stroke:none = blank)',
  /\.icon\[fill="currentColor"\]\s*\{[^}]*fill:\s*currentColor/.test(css));
check('CSS still disables stroke for fill-style icons',
  /\.icon\[fill="currentColor"\]\s*\{[^}]*stroke:\s*none/.test(css));

console.log(`\nui-icons: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
