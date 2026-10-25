// Regression harness for the "Liquid Glow" download-animation layer (v5.6.0).
//
// Three decoration-only effects, all gated on prefers-reduced-motion:
//   1. LIQUID CREST — two-wavelength SVG waves on active fills, animated by
//      pure CSS transform (seamless -50% loop), bounded per row.
//   2. SPEED GLOW — row `data-glow` 0–3 derived from the MEASURED throughput.
//   3. COMPLETION FLOURISH — drawn success ring + particle burst, once per
//      completion, self-cleaning.
//
// House rules under test: reduced motion removes (never fakes); animation is
// decoration — the honest percent/fill/success colour carry the information.
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

console.log('── 1. speedGlowTier: measured throughput → honest tier ──');
{
  check('idle/paused → tier 0', DV.speedGlowTier(0) === 0 && DV.speedGlowTier(-5) === 0);
  check('non-numeric → tier 0', DV.speedGlowTier(NaN) === 0 && DV.speedGlowTier(undefined) === 0);
  check('trickle (<5 MB/s) → tier 1', DV.speedGlowTier(1024) === 1 && DV.speedGlowTier(5 * 1024 * 1024 - 1) === 1);
  check('fast (≥5, <25 MB/s) → tier 2', DV.speedGlowTier(5 * 1024 * 1024) === 2 && DV.speedGlowTier(24.9 * 1024 * 1024) === 2);
  check('saturating (≥25 MB/s) → tier 3', DV.speedGlowTier(25 * 1024 * 1024) === 3 && DV.speedGlowTier(1e9) === 3);
}

console.log('── 2. liquidHtml: seamless two-layer wave, reduced-motion empty ──');
{
  const still = { matches: true };
  const moving = { matches: false };
  check('reduced motion → no markup at all', DV.liquidHtml(still) === '');
  const html = DV.liquidHtml(moving);
  check('two SVG layers', (html.match(/<svg/g) || []).length === 2, 'liquid + liquid-2');
  check('layers carry the .liquid class for the CSS loop',
    /class="liquid"/.test(html) && /class="liquid liquid-2"/.test(html));
  check('both paths are closed shapes (crest + body)',
    (html.match(/Z"/g) || []).length === 2);
  check('paths are two wavelengths wide (seamless -50% loop)',
    /L200,10 L0,10 Z/.test(html));
  check('no JS timers in the markup (pure CSS animation)',
    !/setInterval|setTimeout|requestAnimationFrame/.test(html));
  check('aria-hidden (decoration, not information)', /aria-hidden="true"/.test(html));
}

console.log('── 3. wave gating on the real markup builders ──');
{
  const still = { matches: true };
  const active = { downloaded: 50, totalSize: 100, status: 'downloading' };
  const paused = { downloaded: 50, totalSize: 100, status: 'paused' };
  const esc = (s) => s;
  check('active byte map embeds the wave', /liquid/.test(DV.byteBlockHtml(active, esc, { liquid: true })));
  check('paused byte map does not', !/liquid/.test(DV.byteBlockHtml(paused, esc, { liquid: true })));
  check('liquid:false (caller honours reduced motion) → plain fill',
    !/liquid/.test(DV.byteBlockHtml(active, esc, { liquid: false })));
  check('flow band unchanged (has its own stripe, no wave)',
    !/liquid/.test(DV.flowBandHtml(esc, still)));

  const segs = Array.from({ length: 24 }, (_, i) => ({
    start: i * 100, end: i * 100 + 99, downloaded: 40, state: 'active',
  }));
  const grid = DV.blockGridHtml(segs, esc, { liquid: true });
  const waves = (grid.match(/class="liquid"/g) || []).length;
  check('many-connection row capped at LIQUID_MAX_CELLS waves',
    waves === DV.LIQUID_MAX_CELLS, waves + ' of 24 cells');
  const small = DV.blockGridHtml(segs.slice(0, 4), esc, { liquid: true });
  check('small grid: every active cell gets a wave',
    (small.match(/class="liquid"/g) || []).length === 4);
  check('grid without liquid keeps the pre-v5.6.0 markup',
    !/liquid/.test(DV.blockGridHtml(segs.slice(0, 3), esc)));
}

console.log('── 4. app.js wiring (source guards) ──');
{
  const app = read('ui/app.js');
  check('map builders pass the reduced-motion gate to the viz',
    /blockGridHtml\(segments, escapeAttr, \{ liquid: motionOk\(\) \}\)/.test(app) &&
    /byteBlockHtml\(dl, escapeAttr, \{ liquid: motionOk\(\) \}\)/.test(app));
  check('motionOk() is the single gate',
    /function motionOk\(\)/.test(app) &&
    /prefersReducedMotion/.test(app.slice(app.indexOf('function motionOk'), app.indexOf('function motionOk') + 200)));
  check('patch path syncs the wave on state flips', /function syncMapWave\(/.test(app));
  check('patch path syncs the glow tier every tick', /function syncSpeedGlow\(/.test(app) && /syncSpeedGlow\(tr, dl\)/.test(app));
  check('full render seeds data-glow', /tr\.dataset\.glow = String\(/.test(app));
  check('completion flourish fires from onDownloadComplete',
    /onDownloadComplete\(\(data\) => \{[\s\S]*?fireCompletionFx\(rowEls\.get\(data\.id\), dl\)/.test(app));
  check('flourish fires at most once per completion', /completionFxIds\.has\(tr\.dataset\.id\)/.test(app));
  check('flourish skipped entirely under reduced motion',
    app.indexOf('completionFxIds.add(tr.dataset.id)') < app.indexOf('if (!motionOk()) return;'));
  check('burst self-cleans on a timer',
    /burst isConnected.*remove/.test(app.replace(/\s+/g, ' ')) || /if \(burst\.isConnected\) burst\.remove\(\)/.test(app));
  check('resumed rows may flourish again', /completionFxIds\.delete\(data\.id\)/.test(app));
  check('ring self-cleans with a fallback timeout', /setTimeout\(\(\) => \{ if \(ring\.isConnected\) ring\.remove\(\); \}, 2500\)/.test(app));
}

console.log('── 5. styles.css: GPU-only animation + reduced-motion removal ──');
{
  const css = read('ui/styles.css');
  check('liquid loop is transform-only', /@keyframes liquid-slide \{\s*from \{ transform: translateX\(0\); \}\s*to \{ transform: translateX\(-50%\); \}\s*\}/.test(css));
  check('particles fly on transform/opacity only',
    /@keyframes burst-fly/.test(css) && /translate\(var\(--dx\), var\(--dy\)\) rotate\(var\(--rot\)\)/.test(css));
  check('ring + tick draw via stroke-dashoffset',
    /@keyframes ring-draw \{ to \{ stroke-dashoffset: 0; \} \}/.test(css) &&
    /@keyframes tick-draw \{ to \{ stroke-dashoffset: 0; \} \}/.test(css));
  check('glow tiers scale opacity with throughput',
    /tr\[data-glow="1"\] \.progress-bar::before \{ opacity: \.28; \}/.test(css) &&
    /tr\[data-glow="3"\] \.progress-bar::before \{ opacity: \.85; \}/.test(css));
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  check('reduced motion REMOVES the whole layer',
    /\.liquid, \.burst, \.done-ring \{ display: none !important; \}/.test(rm));
  check('reduced motion freezes the glow transition', /progress-bar::before \{ transition: none; \}/.test(rm));
  check('wave clips inside the fill (no bleed over the track)',
    /\.block-fill \{ overflow: hidden; \}/.test(css));
}

console.log('── 6. geometry sanity: the wave really is two wavelengths ──');
{
  // λ=56 over width 200 must yield a closed path whose horizontal extent is
  // exactly 200 and whose crests alternate above/below the midline.
  const d = DV.wavePathD(200, 10, 56, 2.4, 5);
  check('path starts at the midline', d.startsWith('M0,5'));
  check('path closes at the bottom-right then bottom-left',
    /L200,10 L0,10 Z$/.test(d));
  const crests = (d.match(/,2\.6\b/g) || []).length;   // 5 + (-2.4) → 2.6
  const troughs = (d.match(/,7\.4\b/g) || []).length;  // 5 + 2.4  → 7.4
  // λ=50 across 200 → 4 crests + 4 troughs; each half-wave carries TWO cubic
  // control points at the crest y, hence 8 matches per direction.
  check('crests and troughs alternate across both wavelengths',
    crests === 8 && troughs === 8, crests + '↑ ' + troughs + '↓ (4 crests × 2 ctrl pts)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 2000).unref();
