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
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');

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

// ── 3b. the single-chunk byte map + flow band cover every OTHER row ─────────
check('renderRowMap picks the most honest representation',
  /function renderRowMap\(dl\)/.test(app) &&
  /DV\.byteBlockState\(dl\)/.test(app) &&
  /DV\.flowBandHtml\(escapeAttr\)/.test(app));
check('rows render through renderRowMap', /\$\{renderRowMap\(dl\)\}/.test(app));
check('rowMapSig keys the map by kind, not by live fill',
  /function rowMapSig\(dl\)/.test(app) && /'byte:' \+/.test(app) && /'flow'/.test(app));
check('segments still re-render on their own signature',
  /'seg:' \+ segmentSignature\(segs\)/.test(app));
check('patchRow patches the byte map fill in place (smooth transition)',
  /sig\.indexOf\('byte:'\) === 0/.test(app) &&
  /window\.DownloadViz\.byteBlockState\(dl\)/.test(app) &&
  /fill\.style\.width !== st\.pct/.test(app));

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
// v5.7.1 one-motion: block cells are deliberately STATIC — the liquid wave
// on the row's main bar is the single downloading animation (user feedback).
check('block cells are static (the main-bar wave is the one motion)',
  !/\.block\.active \.block-fill::after/.test(css));
check('done block is success-coloured', /\.block\.done \.block-fill\s*\{[^}]*var\(--success\)/.test(css));
check('net chip styled distinctly from the conn chip', /\.net-chip\s*\{/.test(css) && /A78BFA/.test(css));
check('byte map covers the paused/stalled states', /\.block\.paused \.block-fill/.test(css) && /\.block\.stalled \.block-fill/.test(css));
check('flow band slides; reduced motion degrades to a static wash',
  /\.flow-fill\s*\{/.test(css) && /flow-fill\.still/.test(css) && /@keyframes flow-slide/.test(css));
check('sparkline paths themed', /\.spark-line\s*\{[^}]*var\(--success\)/.test(css) && /\.spark-grad-top/.test(css));
check('reduced-motion gate present', /@media \(prefers-reduced-motion: reduce\)/.test(css));

// ── 7. bridge + main process ───────────────────────────────────────────────
check('preload exposes getNetworkInterfaces', /getNetworkInterfaces/.test(preload));
check('main handles get-network-interfaces', /get-network-interfaces/.test(main));
check('manager gates spread behind the setting + >=2 NICs',
  /this\.settings\.combineNetworks/.test(manager) && /pool\.length >= 2/.test(manager));
check('manager passes the NIC pool into the engine start',
  /\.\.\.\(singleConnection \? \{\} : this\._networkCombine\(\)\)/.test(manager));

// ── 8. yt-dlp engine: in-app update + cookies.txt (Settings › YouTube) ─────
check('youtube pane has the cookies.txt input', html.includes('id="setting-yt-cookies-file"'));
check('youtube pane has the cookies browse button', html.includes('id="btn-yt-cookies-browse"'));
check('youtube pane shows the detected yt-dlp version', html.includes('id="ytdlp-version"'));
check('youtube pane has the one-click updater', html.includes('id="btn-ytdlp-update"'));
check('settings load reads youtubeCookiesFile',
  /getElementById\('setting-yt-cookies-file'\);/.test(app) && /ytCookieFile\) ytCookieFile\.value = String\(settings\.youtubeCookiesFile/.test(app));
check('settings save writes youtubeCookiesFile',
  /youtubeCookiesFile: \(document\.getElementById\('setting-yt-cookies-file'\)\?\.value/.test(app));
check('refreshYtDlpStatus asks the main process for the engine status',
  /window\.aidm\.getYtDlpStatus\(\)/.test(app) && /function refreshYtDlpStatus/.test(app));
check('the YouTube settings tab refreshes the version live',
  /if \(id === 'youtube'\) refreshYtDlpStatus\(\)/.test(app));
check('updateYtDlp invokes the main-process installer',
  /window\.aidm\.updateYtDlp\(\)/.test(app) && /function updateYtDlp/.test(app));
check('the update-result note survives the status refresh',
  /ytdlpUpdateNote/.test(app) && /if \(hint && ytdlpUpdateNote\) hint\.textContent = ytdlpUpdateNote/.test(app));
check('live update progress reaches the hint', /onYtDlpUpdateStatus/.test(app));
check('preload exposes the cookie picker + engine bridges',
  /selectCookieFile: \(\) => ipcRenderer\.invoke\('select-cookie-file'\)/.test(preload) &&
  /getYtDlpStatus: \(\) => ipcRenderer\.invoke\('yt-dlp-status'\)/.test(preload) &&
  /updateYtDlp: \(\) => ipcRenderer\.invoke\('update-yt-dlp'\)/.test(preload));
check('main handles select-cookie-file with a txt filter',
  /select-cookie-file/.test(main) && /extensions: \['txt'\]/.test(main));
check('main handles yt-dlp-status via detectRunner(true)',
  /yt-dlp-status/.test(main) && /detectRunner\(true\)/.test(main));
check('main handles update-yt-dlp via the shared installer',
  /update-yt-dlp/.test(main) && /installYtDlp/.test(main));
check('the update path is nightly-only (the stable tag lags)',
  /installYtDlp\(\{ channel: 'nightly'/.test(main));
check('main reads the cookie file setting for resolves',
  /cookieFile: youtubeCookieFile\(\)/.test(main));
check('the cookie file getter verifies existence',
  /function youtubeCookieFile\(\)/.test(main) && /fs\.existsSync\(p\)/.test(main));
check('server forwards the cookie file on every resolve site',
  (server.match(/cookieFile: this\._youtubeCookieFile\(\)/g) || []).length === 4);
check('server cookie-file getter verifies existence', /_youtubeCookieFile\(\)/.test(server) && /existsSync/.test(server));
check('manager carries the cookies.txt default', manager.includes('youtubeCookiesFile:'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
