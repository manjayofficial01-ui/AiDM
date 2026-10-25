// Regression harness for the download-animation layer.
//
// v5.7.1 "ONE MOTION" (user feedback): after the Pulse Flow redesign a
// downloading row ran six simultaneous effects — ring, comet, current,
// shimmer, glow, waves. The contract now: an active download shows exactly
// ONE animation, the liquid wave floating on the main progress fill.
// Everything else on the row is static; connecting rows keep the honest
// flow band; completion keeps the brief drawn tick; reduced motion removes
// all of it while the fill/percent/success colour keep the information.
//
// Run: node test/download-animation.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DV = require('../ui/download-viz');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('── 1. The wave: seamless, two-layer, reduced-motion empty ──');
{
  const still = { matches: true };
  const moving = { matches: false };
  check('reduced motion → no markup at all', DV.liquidHtml(still) === '');
  const html = DV.liquidHtml(moving);
  check('two SVG layers', (html.match(/<svg/g) || []).length === 2, 'liquid + liquid-2');
  check('layers carry the .liquid class for the CSS loop',
    /class="liquid"/.test(html) && /class="liquid liquid-2"/.test(html));
  check('paths are closed shapes (crest + body)', (html.match(/Z"/g) || []).length === 2);
  check('paths are two wavelengths wide (seamless -50% loop)', /L200,10 L0,10 Z/.test(html));
  check('no JS timers in the markup (pure CSS animation)',
    !/setInterval|setTimeout|requestAnimationFrame/.test(html));
  check('aria-hidden (decoration, not information)', /aria-hidden="true"/.test(html));

  // λ must divide 100 exactly: the -50% translate has to land on an identical
  // phase or the loop visibly jumps (this exact bug shipped once — λ=56).
  const d = DV.wavePathD(200, 10, 50, 2.4, 5);
  check('path starts at the midline', d.startsWith('M0,5'));
  check('path closes bottom-right then bottom-left', /L200,10 L0,10 Z$/.test(d));
  const crests = (d.match(/,2\.6\b/g) || []).length;
  const troughs = (d.match(/,7\.4\b/g) || []).length;
  check('crests/troughs alternate across both wavelengths (4 each × 2 ctrl pts)',
    crests === 8 && troughs === 8, crests + '↑ ' + troughs + '↓');
}

console.log('── 2. ONE MOTION: the wave lives on the main fill, nothing else ──');
{
  const app = read('ui/app.js');
  check('active row embeds the wave in the main progress fill',
    /progress-fill \$\{fillClass\}" style="width:\$\{percent\}%">\$\{dl\.status === 'downloading' && motionOk\(\) \? fillWaveHtml\(\) : ''\}/.test(app));
  check('patch path syncs the wave on the main fill (state flips)',
    /function syncFillWave\(/.test(app) && /syncFillWave\(fill, dl\.status === 'downloading' && motionOk\(\)\)/.test(app));
  check('the wave is the ONLY animation markup the row renders',
    !/iconRing/.test(app) && !/currentHtml/.test(app) && !/done-ripple/.test(app) &&
    !/className = 'burst'/.test(app) && !/data-glow/.test(app) && !/segStatesCache/.test(app));
  check('completion keeps only the drawn tick (no burst, no ripple)',
    /done-ring/.test(app) && /tick-draw/.test(app) &&
    !/BURST|burst\.style|done-ripple/.test(app));
  check('flow band unchanged for connecting rows',
    /flowBandHtml\(escapeAttr\)/.test(app));

  const css = read('ui/styles.css');
  check('css: the wave clips inside the fill',
    /\.progress-fill \{ overflow: hidden; \}/.test(css));
  check('css: wave loop is transform-only',
    /@keyframes liquid-slide \{\s*from \{ transform: translateX\(0\); \}\s*to \{ transform: translateX\(-50%\); \}\s*\}/.test(css));
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  check('reduced motion removes the wave and the tick draw',
    /\.liquid, \.done-ring \{ display: none !important; \}/.test(rm));

  console.log('    ── negative guards: none of the retired effects survive ──');
  check('no icon ring / comet in css', !/\.icon-ring/.test(css) && !/ring-comet/.test(css));
  check('no current dashes in css', !/\.current\b/.test(css) && !/current-flow/.test(css));
  check('no speed-glow halo in css', !/data-glow/.test(css) && !/radial-gradient\(60% 140%/.test(css));
  check('no shimmer on active fills or block cells',
    !/is-active::after/.test(css) && !/block\.active \.block-fill::after/.test(css));
  check('no cell landing springs / spring var / ripple / burst in css',
    !/just-done/.test(css) && !/cell-land/.test(css) && !/--spring-pop/.test(css) &&
    !/done-ripple/.test(css) && !/\.burst/.test(css) && !/burst-fly/.test(css));
  check('no stale keyframes (shimmer kept only where still referenced)',
    !/cell-land|ripple-out|current-flow|ring-comet|burst-fly/.test(css));
}

console.log('── 3. Static maps stay honest and motionless ──');
{
  const esc = (s) => s;
  const segs = Array.from({ length: 4 }, (_, i) => ({
    start: i * 100, end: i * 100 + 99, downloaded: 40, state: 'active',
  }));
  const grid = DV.blockGridHtml(segs, esc);
  check('BlockGrid renders no wave markup (static by design)', !/liquid/.test(grid));
  check('byte map renders no wave markup', !/liquid/.test(
    DV.byteBlockHtml({ downloaded: 50, totalSize: 100, status: 'downloading' }, esc)));
  check('flow band still has its honest stripe',
    /flow-fill/.test(DV.flowBandHtml(esc, { matches: false })));
  check('flow band is static under reduced motion',
    /still/.test(DV.flowBandHtml(esc, { matches: true })));
  check('viz exports only the one-motion surface (no ring/current/glow tier)',
    DV.iconRingState === undefined && DV.currentHtml === undefined &&
    DV.speedGlowTier === undefined);
}

console.log('── 4. Completion tick: once, self-cleaning, reduced-motion safe ──');
{
  const app = read('ui/app.js');
  check('fires at most once per completion', /completionFxIds\.has\(tr\.dataset\.id\)/.test(app));
  check('skipped entirely under reduced motion',
    app.indexOf('completionFxIds.add(tr.dataset.id)') < app.indexOf('if (!motionOk()) return;'));
  check('self-cleans with a fallback timeout',
    /setTimeout\(\(\) => \{ if \(ring\.isConnected\) ring\.remove\(\); \}, 2500\)/.test(app));
  check('resumed rows may tick again', /completionFxIds\.delete\(data\.id\)/.test(app));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 2000).unref();
