// Regression harness for the floating download pill ("capsule") drag bugs
// (all original AiDM code in chrome-extension/content.js):
//   1. STICKY PILL — ending a drag depended only on pointerup/pointercancel
//      reaching window. Releasing outside the window or frame, Alt+Tab
//      mid-drag, or dragging out of an iframe document (hqporner/mydaddy
//      embeds) delivers neither, leaking the move listener so the pill
//      follows the cursor forever.
//   2. PILL WON'T LEAVE THE PLAYER — same boundary: pointer tracking died at
//      the iframe document edge, freezing the pill there (a position:fixed
//      pill inside a frame document is clipped to the frame box, and every
//      exit path must still end the gesture cleanly).
//   3. Glassmorphism restyle of the pill.
//
// The SHIPPED clampCapsulePos is extracted (not copied); the drag-exit paths
// and the glass CSS are asserted as shipped patterns. Run: node test/capsule.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

function grabShipped(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in shipped source');
  const j = src.indexOf('{', i);
  let d = 0, inStr = null, esc = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/') {
      let p = k - 1;
      while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
      const pc = p >= 0 ? src[p] : '(';
      if (!/[(,=:?!&|{;\[]/.test(pc)) continue;
      let q = k + 1, qc = false, cls = false;
      for (; q < src.length; q++) {
        const cc = src[q];
        if (qc) { qc = false; continue; }
        if (cc === '\\') { qc = true; continue; }
        if (cc === '[') cls = true;
        else if (cc === ']') cls = false;
        else if (cc === '/' && !cls) break;
        else if (cc === '\n') break;
      }
      k = q; continue;
    }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const ROOT = path.join(__dirname, '..');
const ctSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8');

const clampCapsulePos = new Function(
  grabShipped(ctSrc, 'clampCapsulePos') + '\nreturn clampCapsulePos;'
)();

// ── 1. viewport parking (never the player, never off-screen) ───────────────
{
  const VW = 1280, VH = 800;
  check('inside anchor passes through',
    JSON.stringify(clampCapsulePos(500, 300, VW, VH)) === JSON.stringify({ x: 500, y: 300 }));
  check('left/top clamp reserves pill + margin',
    JSON.stringify(clampCapsulePos(20, -50, VW, VH)) === JSON.stringify({ x: 150, y: 8 }));
  check('right/bottom clamp keeps pill on-screen',
    JSON.stringify(clampCapsulePos(5000, 4000, VW, VH)) === JSON.stringify({ x: VW - 8, y: VH - 40 }));
  check('far-away drop point survives (not snapped to player)',
    JSON.stringify(clampCapsulePos(1100, 700, VW, VH)) === JSON.stringify({ x: 1100, y: 700 }));
  check('degenerate viewport still yields a visible anchor',
    JSON.stringify(clampCapsulePos(0, 0, 0, 0)) === JSON.stringify({ x: 150, y: 8 }));
  check('positionCapsule uses the pure clamp',
    /clampCapsulePos\(r\.right - 8 \+ off\.dx, r\.top \+ 8 \+ off\.dy, vw, vh\)/.test(ctSrc));
}

// ── 2. every gesture exit ends the drag ────────────────────────────────────
check('pointer capture keeps events flowing to the pill',
  /btn\.setPointerCapture\(e\.pointerId\)/.test(ctSrc));
check('lostpointercapture ends the drag',
  /addEventListener\('lostpointercapture', onCaptureLost\)/.test(ctSrc) &&
  /const onCaptureLost = \(\) => \{ endDrag\(true\); \};/.test(ctSrc));
check('button-less move ends a missed release',
  /ev\.pointerType !== 'touch' && ev\.buttons === 0/.test(ctSrc));
check('leaving the document ends the drag',
  /addEventListener\('mouseleave', onLeave\)/.test(ctSrc));
check('window blur ends the drag',
  /addEventListener\('blur', onBlur, true\)/.test(ctSrc));
check('Escape cancels the drag',
  /ev\.key === 'Escape'/.test(ctSrc));
check('single-flight: second press ends the first gesture',
  /activeDrags\.get\(video\)/.test(ctSrc) && /activeDrags\.set\(video, endDrag\)/.test(ctSrc));
check('destroying a capsule ends its drag',
  /const active = activeDrags\.get\(video\)/.test(ctSrc));
check('cancel paths suppress the click-toggle',
  /const onCancel = \(\) => \{ endDrag\(true\); \};/.test(ctSrc));
check('dragging state flagged on the pill for styling',
  /btn\.classList\.add\('aidm-dragging'\)/.test(ctSrc) &&
  /btn\.classList\.remove\('aidm-dragging'\)/.test(ctSrc));

// ── 3. glassmorphism pill ──────────────────────────────────────────────────
check('glass blur + saturation on the pill',
  /backdrop-filter: blur\(12px\) saturate\(1\.6\)/.test(ctSrc));
check('translucent gradient + glass border',
  /rgba\(74,157,234,.78\)/.test(ctSrc) && /1px solid rgba\(255,255,255,.38\)/.test(ctSrc));
check('3d depth: layered + inset shadows',
  /inset 0 1px 0 rgba\(255,255,255,.5\)/.test(ctSrc));
check('dragging feedback style present',
  /\.aidm-cap-btn\.aidm-dragging/.test(ctSrc));
check('touch dragging not hijacked by scroll',
  /touch-action: none/.test(ctSrc));

// ── 4. open-panel rebuild gating (Twitter download-button vanish) ─────────
// The panel used to rebuild (innerHTML wipe + multi-second re-probe) on EVERY
// refreshOpenPanel() trigger — and the playing-event handler fires it
// unconditionally, so on looping players (Twitter/X fires `playing` every few
// seconds) the Download button vanished between hover and click. The rebuild
// must be gated on real detection-data changes and deferred while the pointer
// is over the open panel.
check('refreshOpenPanel gated on data version, not unconditional',
  /st\.builtPanelDataVersion !== panelDataVersion\) buildCapsulePanel/.test(ctSrc));
check('closed panel never rebuilds',
  /st\.panel\.style\.display === 'none'\) return;/.test(ctSrc));
check('pointer-over-panel defers the rebuild (pendingRefresh)',
  /st\.pointerInside\) \{ st\.pendingRefresh = true; return; \}/.test(ctSrc));
check('deferred rebuild flushes on pointerleave',
  /st\.pendingRefresh = false;\s*\n\s*try \{ refreshOpenPanel\(\); \} catch/.test(ctSrc));
check('build stamps the content version it rendered from',
  /st\.builtPanelDataVersion = panelDataVersion;/.test(ctSrc));
check('direct build supersedes any deferred refresh',
  /st\.pendingRefresh = false; \/\/ a direct \(re\)build supersedes/.test(ctSrc));
check('new detection data bumps the version',
  /detectedVideos\.set\(url, info\);\s*\n\s*if \(n\) detectedNormKeys\.add\(n\);\s*\n\s*panelDataVersion\+\+/.test(ctSrc));
check('twitter variant bucket growth bumps the version',
  /const added = noteTwitterVariants[\s\S]*?if \(added\) \{\s*\n\s*panelDataVersion\+\+/.test(ctSrc));

// ── 5. outside-click close must survive the CLOSED shadow root ────────────
// v5.9.2 switched the capsule shadow root to mode:'closed'. From the document,
// composedPath() of a press INSIDE our shadow tree is retargeted to the host —
// st.wrap/st.panel/st.btn never appear in it. The old "outside" test matched
// every press on the panel, closing it on pointerdown before the Download
// button's click could fire ("can't click Download / panel wraps up on press").
// The host IS in the retargeted path, so it is the inside test now.
check('outside-close handler tests the shadow host (closed-root aware)',
  /!path\.includes\(capsuleHost\) && !path\.includes\(st\.wrap\)/.test(ctSrc));
check('genuine outside pointerdown still closes the open panel',
  /path\.includes\(capsuleHost\)[\s\S]{0,200}st\.panel\.style\.display = 'none';\s*\n\s*openCapsuleVideo = null;/.test(ctSrc));
check('the shadow root that forces this is closed (keep the two in sync)',
  /attachShadow\(\{ mode: 'closed' \}\)/.test(ctSrc));

console.log(`\ncapsule: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
