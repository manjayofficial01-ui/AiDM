// Regression harness for the "stuck on one hardcoded video link" bug
// (mydaddy.cc report, fixed in v4.2.0).
//
// Root cause: background.js kept sniffed media URLs per TAB for 10 minutes and
// only cleared them when the tab closed — never on navigation. The capsule
// panel therefore kept offering the PREVIOUS site's tokenized video link on
// every other site opened in the same tab; clicking it always failed.
//
// This harness exercises the SHIPPED filtering code (extracted from
// chrome-extension/background.js, not copied) and asserts the wiring exists:
//   1. filterTabStreams honors the keep-window AND the `since` page-load floor
//   2. background.js clears tabStreams when a tab navigates (status 'loading')
//   3. content.js sends `since` (performance.timeOrigin) with get-panel-data
//   4. background.js get-panel-data passes msg.since through to getTabStreams
const fs = require('fs');
const path = require('path');

function grab(srcFile, name) {
  const src = fs.readFileSync(srcFile, 'utf8');
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in ' + srcFile);
  const j = src.indexOf('{', i);
  let d = 0, inRe = false, inStr = null, esc = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (inRe) {
      if (c === '\\') esc = true;
      else if (c === '/') inRe = false;
      else if (c === '[') { const e = src.indexOf(']', k); if (e > 0) k = e; }
      continue;
    }
    // comments FIRST — shipped functions contain prose with braces/apostrophes
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && /[(,=:?!&|{;\[]/.test(src[k - 1] || '(')) { inRe = true; continue; }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const BG = path.join(__dirname, '..', 'chrome-extension', 'background.js');
const CONTENT = path.join(__dirname, '..', 'chrome-extension', 'content.js');

// Load the shipped filter as a real function.
const filterTabStreams = new Function(
  grab(BG, 'filterTabStreams') + '\nreturn filterTabStreams;'
)();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// ── 1. filterTabStreams behavior ─────────────────────────────────────────────
const KEEP = 10 * 60 * 1000;
const NOW = 1_000_000_000_000;
const mk = (url, age) => ({ url, time: NOW - age });

const list = [
  mk('https://fresh-site.cd/clip-720.mp4', 5_000),        // fresh this page
  mk('https://fresh-site.cd/clip-1080.mp4', 9 * 60_000),  // fresh, near window edge (9 min < 10 min)
  mk('https://old-site.cd/old.mp4', KEEP + 1_000),        // beyond keep window
  mk('https://mydaddy.cc/v/old-video.mp4?sig=abc', 30_000), // stale from PREVIOUS page
];

// keep-window only (no since — legacy caller shape). NOTE: the mydaddy row is
// still inside the keep window here — that is exactly why the keep window
// ALONE was never enough and the since floor (next checks) is required.
check('keep-window drops entries older than 10 min',
  JSON.stringify(filterTabStreams(list, NOW, 0, KEEP)) ===
  JSON.stringify(['https://fresh-site.cd/clip-720.mp4', 'https://fresh-site.cd/clip-1080.mp4', 'https://mydaddy.cc/v/old-video.mp4?sig=abc']));

// since = current page navigation start: the mydaddy row was captured BEFORE
// this page loaded → must disappear even though it is well inside the window.
const PAGE_START = NOW - 20_000;
check('since floor drops streams captured before this page load',
  !filterTabStreams(list, NOW, PAGE_START, KEEP).includes('https://mydaddy.cc/v/old-video.mp4?sig=abc'));

check('since floor keeps streams captured during this page load',
  filterTabStreams(list, NOW, PAGE_START, KEEP).includes('https://fresh-site.cd/clip-720.mp4'));

// boundary: a stream captured EXACTLY at navigation start is this page's → kept
check('since boundary is inclusive (time === since kept)',
  filterTabStreams([{ url: 'https://x/y.mp4', time: PAGE_START }], NOW, PAGE_START, KEEP).length === 1);

// since=0/undefined → no page scoping (back-compat with old callers)
check('since=0 disables page scoping',
  filterTabStreams([mk('https://a/b.mp4', 1)], NOW, 0, KEEP).length === 1);

check('unknown/empty tab yields no rows',
  filterTabStreams(undefined, NOW, 0, KEEP).length === 0 && filterTabStreams(null, NOW, PAGE_START, KEEP).length === 0);

// ── 2. navigation clears the tab's stream history ───────────────────────────
const bgSrc = fs.readFileSync(BG, 'utf8');
const onUpdatedIdx = bgSrc.indexOf('chrome.tabs.onUpdated.addListener');
const snippet = onUpdatedIdx >= 0 ? bgSrc.slice(onUpdatedIdx, onUpdatedIdx + 1200) : '';
check('onUpdated listener clears tabStreams on navigation start (loading)',
  /status\s*===?\s*'loading'[\s\S]{0,300}?tabStreams\.delete\(tabId\)/.test(snippet),
  snippet ? '' : '(listener missing)');

// ── 3. content.js scopes panel data to the current page load ────────────────
const contentSrc = fs.readFileSync(CONTENT, 'utf8');
check("content.js sends since=performance.timeOrigin with get-panel-data",
  /action:\s*'get-panel-data'[\s\S]{0,200}?since:\s*Math\.round\(performance\.timeOrigin\)/.test(contentSrc) ||
  /since:\s*Math\.round\(performance\.timeOrigin\)[\s\S]{0,40}\}\s*,\s*\(resp\)/.test(contentSrc));

// ── 4. get-panel-data handler passes the page floor through ─────────────────
// v4.6.0: msg.since is preferred, else the tab's recorded navigation time.
check('background get-panel-data forwards the page floor to getTabStreams',
  /getTabStreams\(tabId,\s*since\)/.test(bgSrc));

// ── 5. a dead extension service worker is surfaced, never silent ────────────
// 2026-11-23 report ("can't download YT/Twitter/Facebook anymore"): the
// unpacked extension's background.js failed SW REGISTRATION after being
// reloaded mid-edit; every click then failed while the app itself was fine.
// The pill/popup must tell the user to reload instead of a bare "Failed".
check('requestPanelData surfaces a dead background (bgDead) instead of empty data',
  /get-panel-data[\s\S]{0,400}?bgDead:\s*true/.test(contentSrc));
check('requestPanelData timeout also reports bgDead (silent dead port)',
  /bgDead:\s*true,\s*bgDeadErr:\s*'timeout'/.test(contentSrc));
check('capsule renders the reload banner when the background is dead',
  /pd\s*&&\s*pd\.bgDead[\s\S]{0,200}?aidm-cap-banner/.test(contentSrc) &&
  /chrome:\/\/extensions/.test(contentSrc));
check('pill click distinguishes a dead extension from "AiDM offline"',
  /receiving end does not exist\|message port closed/i.test(contentSrc) &&
  /⚠ Reload extension/.test(contentSrc));

// ── 6. the reload banner must actually RENDER (TDZ regression) ──────────────
// v5.9.7 shipped the banner BEFORE the `let pd` declaration in
// buildCapsulePanel: reading pd there hit the let-TDZ, the surrounding
// try/catch swallowed the ReferenceError, and the banner never rendered —
// the user saw a dead pill with no guidance. Presence checks (section 5)
// passed on the broken code; only execution order catches this.
const POPUP = path.join(__dirname, '..', 'chrome-extension', 'popup.js');
const popupSrc = fs.readFileSync(POPUP, 'utf8');

const declIdx = contentSrc.indexOf('let pd = { streams: [], sent: [] };');
const useIdx = contentSrc.indexOf('if (pd && pd.bgDead)');
check('banner reads pd AFTER its let declaration (no TDZ)',
  declIdx >= 0 && useIdx > declIdx, 'decl@' + declIdx + ' use@' + useIdx);

// Execute the SHIPPED segment (pd assignment → banner) with stubs and assert
// the banner node reaches the panel; then prove the OLD order fails silently.
const insIdx = contentSrc.indexOf('st.panel.insertBefore(warn, loading);');
const segEnd = contentSrc.indexOf('} catch (e) {}', insIdx) + '} catch (e) {}'.length;
const shippedSeg = contentSrc.slice(declIdx, segEnd);
const bannerStart = contentSrc.lastIndexOf('try {', useIdx);
const bannerBlock = contentSrc.slice(bannerStart, segEnd);
check('shipped segment extracts cleanly', shippedSeg.includes('insertBefore(warn, loading)') && bannerBlock.length > 0);

function runSeg(seg, pdResp) {
  const inserted = [];
  const st = { panel: { insertBefore: (n) => inserted.push(n), appendChild: () => {} } };
  const doc = { createElement: () => ({ className: '', textContent: '', title: '' }) };
  const fn = new Function('st', 'loading', 'document', 'requestPanelData', 'superseded',
    'return (async () => {' + seg + '\n})();');
  return fn(st, {}, doc, async () => pdResp, () => false).then(() => inserted);
}

(async () => {
  const fixed = await runSeg(shippedSeg, { bgDead: true });
  check('EXECUTED shipped segment renders the banner when bgDead',
    fixed.length === 1 && fixed[0].className === 'aidm-cap-banner', JSON.stringify(fixed.map(n => n.className)));
  const quiet = await runSeg(shippedSeg, { streams: [], sent: [] });
  check('EXECUTED shipped segment stays quiet with a live background', quiet.length === 0);
  // The v5.9.7 broken order: banner block BEFORE the declaration. Must NOT
  // render (swallowed TDZ ReferenceError) — this is the regression signature.
  const broken = await runSeg(bannerBlock + '\nlet pd = { streams: [], sent: [] };\ntry { pd = await requestPanelData(); } catch (e) {}', { bgDead: true });
  check('OLD banner-before-declaration order provably renders nothing', broken.length === 0);

  check('pill + popup dead-context regex covers invalidated extension contexts',
    /receiving end does not exist\|message port closed\|extension context invalidated/i.test(contentSrc) &&
    (popupSrc.match(/extension context invalidated/g) || []).length >= 2);

  console.log('\npanel-freshness: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
