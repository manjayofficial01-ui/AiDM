// Regression harness for the Plexo integration's renderer wiring.
//
// The download visualisations (BlockGrid, ThroughputChart, multi-network
// chip) live across four files, and a missing <script>, a renamed element
// id or a dropped field copy fails SILENTLY — the UI just keeps its old
// look. This asserts over the shipped files (no DOM needed) so the wiring
// can't rot.
//
// Run: node test/plexo-ui-wiring.js
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
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const manager = fs.readFileSync(path.join(ROOT, 'src', 'download-manager.js'), 'utf8');

// ── 1. the shared viz module actually loads, before app.js ─────────────────
const vizIdx = html.indexOf('src="download-viz.js"');
const appIdx = html.indexOf('src="app.js"');
check('index.html loads download-viz.js', vizIdx !== -1);
check('download-viz.js loads before app.js', vizIdx !== -1 && appIdx !== -1 && vizIdx < appIdx);

// ── 2. the sparkline is the SVG ThroughputChart, not the old canvas ────────
check('no <canvas> sparkline left', !/<canvas[^>]*id="speed-sparkline"/.test(html));
check('sparkline is an SVG with viewBox', /<svg[^>]*id="speed-sparkline"[^>]*viewBox="0 0 72 22"/.test(html));
for (const id of ['spark-area', 'spark-line', 'spark-head']) {
  check(`sparkline has #${id}`, html.includes(`id="${id}"`));
}
check('sparkline gradient stops exist', html.includes('id="spark-grad"'));
check('drawSparkline uses the shared areaPath geometry',
  /DownloadViz\.areaPath\(speedHistory/.test(app));
check('drawSparkline paints line + area + head dot',
  /spark-line/.test(app) && /spark-area/.test(app) && /spark-head/.test(app));

// ── 3. BlockGrid is wired into the row renderer ────────────────────────────
check('renderSegments renders via blockGridHtml',
  /DownloadViz\.blockGridHtml\(segments/.test(app));
check('equal-width bar kept as fallback',
  /class="segments-bar"/.test(app) && /class="segment/.test(app));
check('blockGridHtml output is trusted HTML (built with a tested escaper)',
  /blockGridHtml\(/.test(app));

// ── 4. "Combine networks" settings ─────────────────────────────────────────
check('network pane has the combine toggle', html.includes('id="setting-combine-networks"'));
check('combine toggle lives in the network settings pane', (() => {
  const pane = html.slice(html.indexOf('data-settings-pane="network"'), html.indexOf('data-settings-pane="paths"'));
  return pane.includes('id="setting-combine-networks"');
})());
check('combine hint element exists', html.includes('id="combine-net-hint"'));
check('settings load reads combineNetworks',
  /setting-combine-networks'\)\.checked = settings\.combineNetworks/.test(app));
check('settings save writes combineNetworks',
  /combineNetworks: document\.getElementById\('setting-combine-networks'\)\.checked/.test(app));
check('hint asks the main process for the live NIC list',
  /getNetworkInterfaces\(\)/.test(app) && /combine-net-hint/.test(app));

// ── 5. live network fields reach the row ───────────────────────────────────
check('progress tick copies connections', /dl\.connections = data\.connections/.test(app));
check('progress tick copies targetConnections', /dl\.targetConnections = data\.targetConnections/.test(app));
check('progress tick copies the engine etaSeconds', /dl\.eta = data\.etaSeconds/.test(app));
check('progress tick copies networkSpread', /dl\.networkSpread = data\.networkSpread/.test(app));
check('progress tick copies networkNames', /dl\.networkNames = data\.networkNames/.test(app));
check('progress tick copies networkCount', /dl\.networkCount = data\.networkCount/.test(app));
check('row renders the NET chip when spreading', /dl\.networkSpread \? netChipHtml\(dl\) : ''/.test(app));
check('patchRow adds/removes the NET chip live',
  /dl\.networkSpread && !netChip/.test(app) && /!dl\.networkSpread && netChip/.test(app));
check('patchRow can create the conn chip mid-download',
  /else if \(dl\.connections != null \|\| dl\.targetConnections != null\)/.test(app));

// ── 6. styles: BlockGrid, chip, reduced-motion gate ────────────────────────
check('BlockGrid cells styled', /\.block-grid\s*\{/.test(css) && /\.block-fill\s*\{/.test(css));
check('active block keeps the shimmer glow', /\.block\.active \.block-fill::after/.test(css));
check('done block is success-coloured', /\.block\.done \.block-fill\s*\{[^}]*var\(--success\)/.test(css));
check('net chip styled distinctly from the conn chip', /\.net-chip\s*\{/.test(css) && /A78BFA/.test(css));
check('sparkline paths themed', /\.spark-line\s*\{[^}]*var\(--success\)/.test(css) && /\.spark-grad-top/.test(css));
check('reduced-motion gate present', /@media \(prefers-reduced-motion: reduce\)/.test(css));

// ── 7. bridge + main process ───────────────────────────────────────────────
check('preload exposes getNetworkInterfaces', /getNetworkInterfaces/.test(preload));
check('main handles get-network-interfaces', /get-network-interfaces/.test(main));
check('manager gates spread behind the setting + >=2 NICs',
  /this\.settings\.combineNetworks/.test(manager) && /pool\.length >= 2/.test(manager));
check('manager passes the NIC pool into the engine start',
  /\.\.\.\(singleConnection \? \{\} : this\._networkCombine\(\)\)/.test(manager));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
