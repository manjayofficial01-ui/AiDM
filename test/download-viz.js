// Unit tests for ui/download-viz.js — the Plexo-derived BlockGrid /
// ThroughputChart primitives. Run: node test/download-viz.js
const assert = require('assert');
const viz = require('../ui/download-viz.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// download-viz.js ships as a UMD bundle (browser global + module.exports); it
// must export every primitive the renderer relies on.
console.log('\u2500\u2500 download-viz export surface \u2500\u2500');
for (const fn of ['prefersReducedMotion', 'fmtEta', 'blockFillPercent', 'blocksFromSegments', 'areaPath', 'assignInterfaces', 'byteBlockState', 'byteBlockHtml', 'flowBandHtml']) {
  check('exports ' + fn, typeof viz[fn] === 'function');
}

console.log('\u2500\u2500 prefersReducedMotion \u2500\u2500');
check('honors a passed-in matchMedia handle', viz.prefersReducedMotion({ matches: true }) === true);
check('false when handle says so', viz.prefersReducedMotion({ matches: false }) === false);
check('false with no matchMedia available', viz.prefersReducedMotion(null) === false);

console.log('\u2500\u2500 fmtEta (Plexo #149) \u2500\u2500');
check('sub-minute reads seconds', viz.fmtEta(45) === '45s', viz.fmtEta(45));
check('just under a minute reads seconds', viz.fmtEta(59) === '59s', viz.fmtEta(59));
check('a value that rounds up to 60 reads 1m 00s, not 60s', viz.fmtEta(59.4) === '1m 00s', viz.fmtEta(59.4));
check('minutes+seconds padded', viz.fmtEta(192) === '3m 12s', viz.fmtEta(192));
check('hours read h + zero-padded m', viz.fmtEta(3900) === '1h 05m', viz.fmtEta(3900));
check('unknown -> empty', viz.fmtEta(null) === '' && viz.fmtEta(0) === '' && viz.fmtEta(-1) === '');

console.log('\u2500\u2500 blockFillPercent \u2500\u2500');
check('done is full', viz.blockFillPercent(10, 1000, 'done') === 100);
check('half is half', viz.blockFillPercent(500, 1000, 'active') === 50);
check('zero stay is 0', viz.blockFillPercent(0, 1000, 'active') === 0);
check('a started chunk floors to a 6% sliver', viz.blockFillPercent(1, 100, 'active') === 6);
check('far too few bytes to count stay 0', viz.blockFillPercent(1, 1024 * 1024, 'active') === 0);
check('open-ended (no length) sizes to 0 when not done', viz.blockFillPercent(500, 0, 'active') === 0);

console.log('\u2500\u2500 blocksFromSegments (BlockGrid) \u2500\u2500');
check('single/absent segment -> empty (fallback to plain bar)', viz.blocksFromSegments([{ state: 'done' }], 1000).length === 0 && viz.blocksFromSegments(null, 1000).length === 0);
const two = viz.blocksFromSegments(
  [
    { start: 0, end: 499, downloaded: 500, state: 'done' },
    { start: 500, end: 999, downloaded: 250, state: 'active' },
  ], 1000);
check('two segments -> two blocks', two.length === 2);
check('block width follows byte share', Math.abs(two[0].width - 50) < 1e-6, 'w0=' + two[0].width);
check('done block is full', two[0].pct === 100 && two[0].state === 'done');
check('active block shows its fill', two[1].pct === 50 && two[1].state === 'active');
check('widths sum to ~100%', Math.abs(two.reduce((n, b) => n + b.width, 0) - 100) < 1e-5);

// A big split into many segments must coalesce to the cap, not blow up the DOM.
const many = [];
for (let i = 0; i < 500; i++) many.push({ start: i * 1000, end: i * 1000 + 999, downloaded: i < 250 ? 1000 : 0, state: i < 250 ? 'done' : 'pending' });
const capped = viz.blocksFromSegments(many, 500000, { maxBlocks: 40 });
check('500 segments coalesce to <= cap', capped.length <= 40 && capped.length > 0, 'n=' + capped.length);
check('a coalesced cell is done if all its members were', capped[0].state === 'done' && capped[0].pct === 100);
check('a coalesced cell stays pending if none active', capped[capped.length - 1].state === 'pending');
const activeMix = viz.blocksFromSegments(many.slice(0, 4).map(function (s, i) { return i === 1 ? { ...s, state: 'active', downloaded: 100 } : s; }), 4000, { maxBlocks: 2 });
check('a coalesced cell reads active if any member is (glow)', activeMix[0].state === 'active');

console.log('\u2500\u2500 areaPath (ThroughputChart) \u2500\u2500');
const flat = viz.areaPath([0, 0, 0], 100, 20);
check('empty/flat still draws a line', typeof flat.line === 'string' && flat.line.length > 0);
check('area closes back to the baseline', flat.area.indexOf('L100,20') !== -1 || flat.area.length > flat.line.length);
check('nothing to draw -> empty strings', viz.areaPath([], 100, 20).line === '');
const single = viz.areaPath([5], 100, 20);
check('a single sample is doubled to a flat line', typeof single.line === 'string' && single.line.length > 0);
const rising = viz.areaPath([1, 3, 2], 100, 20);
check('rising series produces distinct y coords', (rising.line.match(/,[0-9.]+/g) || []).length === 3);

console.log('\u2500\u2500 assignInterfaces (multi-network round-robin) \u2500\u2500');
const nets = [{ address: '10.0.0.2', family: 4 }, { address: '192.168.1.5', family: 4 }, { address: '172.16.0.3', family: 4 }];
check('fewer than two networks -> null (default route)', viz.assignInterfaces([nets[0]], 0) === null && viz.assignInterfaces([], 3) === null);
let seq = [];
for (let t = 0; t < 6; t++) seq.push(viz.assignInterfaces(nets, t).address);
check('round-robin cycles through every interface', seq.join(',') === '10.0.0.2,192.168.1.5,172.16.0.3,10.0.0.2,192.168.1.5,172.16.0.3', seq.join(','));
check('tick is normalized (>=0)', viz.assignInterfaces(nets, -1).address === '10.0.0.2');

console.log('\u2500\u2500 blockGridHtml (BlockGrid markup) \u2500\u2500');
const esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); };
check('single/absent segment -> empty markup', viz.blockGridHtml([{ state: 'done' }], esc) === '' && viz.blockGridHtml(null, esc) === '');
const grid = viz.blockGridHtml([
  { start: 0, end: 749999, downloaded: 750000, state: 'done' },
  { start: 750000, end: 999999, downloaded: 125000, state: 'active' },
  { start: 1000000, end: 1249999, downloaded: 0, state: 'pending' },
], esc);
check('renders the block-grid container', grid.indexOf('segments-bar block-grid') !== -1);
check('one .block cell per segment', (grid.match(/class="block /g) || []).length === 3, grid.slice(0, 120));
check('block flex-basis follows the byte share', grid.indexOf('flex:0 0 60.00%') !== -1, grid.slice(0, 160));
check('done block fills to 100%', grid.indexOf('width:100%') !== -1);
check('active block fills to its own progress', grid.indexOf('width:50%') !== -1);
check('active block carries the glow class', grid.indexOf('block active') !== -1);
check('titles are escaped through the injected escaper', typeof viz.blockGridHtml([{ start: 0, end: 9, downloaded: 0, state: 'pending', tail: true }], esc) === 'string');
check('missing escaper still renders (no crash)', viz.blockGridHtml([{ start: 0, end: 9, state: 'done' }, { start: 10, end: 19, state: 'pending' }]).indexOf('block done') !== -1);
check('markup has no unescaped raw ampersand in a title', grid.indexOf('title="&') === -1);

console.log('\u2500\u2500 byteBlockState (single-chunk byte map) \u2500\u2500');
check('byte truth wins: half of the file', (() => { const s = viz.byteBlockState({ downloaded: 500, totalSize: 1000, status: 'downloading' }); return s.pct === 50 && s.state === 'active'; })());
check('completed row is a full done block', (() => { const s = viz.byteBlockState({ downloaded: 1000, totalSize: 1000, status: 'completed' }); return s.pct === 100 && s.state === 'done' && s.tip.indexOf('complete') !== -1; })());
check('an in-flight row never reads as 0 (6% sliver)', viz.byteBlockState({ downloaded: 0, totalSize: 999, status: 'downloading' }).pct === 6);
check('a barely-started file still gets the in-flight sliver', viz.byteBlockState({ downloaded: 1, totalSize: 1024 * 1024, status: 'downloading' }).pct === 6);
check('fragment percent is honest but labelled', (() => { const s = viz.byteBlockState({ totalSize: 0, percent: 45, status: 'downloading' }); return s.pct === 45 && s.tip.indexOf('Fragment progress') !== -1 && s.tip.indexOf('byte count unknown') !== -1; })());
check('completed without any size still completes', viz.byteBlockState({ status: 'completed' }).pct === 100);
check('paused holds its fill and says so', (() => { const s = viz.byteBlockState({ downloaded: 250, totalSize: 1000, status: 'paused' }); return s.pct === 25 && s.state === 'paused' && s.tip.indexOf('(paused)') !== -1; })());
check('error row reads stalled', viz.byteBlockState({ downloaded: 250, totalSize: 1000, status: 'error' }).state === 'stalled');
check('no truth and not done -> null (caller uses the flow band)', viz.byteBlockState({ status: 'downloading' }) === null && viz.byteBlockState({ totalSize: 0, percent: 0, status: 'downloading' }) === null);
check('null row is safe', viz.byteBlockState(null) === null);

console.log('\u2500\u2500 byteBlockHtml (single-block markup) \u2500\u2500');
const byteMap = viz.byteBlockHtml({ downloaded: 500, totalSize: 1000, status: 'downloading' }, esc);
check('renders the byte-map container', byteMap.indexOf('segments-bar block-grid byte-map') !== -1, byteMap.slice(0, 90));
check('exactly one 100%-width block cell', byteMap.indexOf('flex:0 0 100%') !== -1 && (byteMap.match(/class="block /g) || []).length === 1);
check('fill follows the real percent', byteMap.indexOf('width:50%') !== -1);
check('in-flight block carries the glow class', byteMap.indexOf('block active') !== -1);
check('title is escaped through the injected escaper', (() => { let calls = 0; viz.byteBlockHtml({ downloaded: 5, totalSize: 10, status: 'downloading' }, function (s) { calls++; return String(s); }); return calls === 1; })());
check('no truth -> empty markup (fall back to the flow band)', viz.byteBlockHtml({ status: 'downloading' }, esc) === '');
check('missing escaper still renders (no crash)', viz.byteBlockHtml({ downloaded: 10, totalSize: 10, status: 'completed' }).indexOf('block done') !== -1);

console.log('\u2500\u2500 flowBandHtml (indeterminate in-flight band) \u2500\u2500');
const band = viz.flowBandHtml(esc);
check('renders the flow-band container', band.indexOf('byte-map flow-band') !== -1);
check('carries the sliding flow fill', band.indexOf('flow-fill') !== -1);
check('no percent is claimed anywhere', band.indexOf('width:') === -1, band.slice(0, 120));
check('title says the size is unknown', band.indexOf('Downloading \u2014 size unknown') !== -1);
check('reduced motion degrades to the static wash', viz.flowBandHtml(esc, { matches: true }).indexOf('flow-fill still') !== -1);
check('no reduced-motion handle -> animated', viz.flowBandHtml(esc, null).indexOf('flow-fill"') !== -1);
check('missing escaper still renders (no crash)', viz.flowBandHtml().indexOf('flow-band') !== -1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
