// Regression harness for v4.6.0 — truth-in-UI + reliability pass.
//
// Covers:
//   1. "Playing now" tagging: content.js tags the variant the element renders
//      (currentSrc match + actually playing), blob/MSE rows get tagged via the
//      blob→real map, and the flag survives collapse merges (content,
//      background, popup copies).
//   2. True sizes only: performance transferSize/decodedBodySize never feed
//      row sizes; size is dropped from the collapse key (no twin rows).
//   3. SPA freshness: content caches clear on pushState/replaceState/popstate,
//      popup passes `since`, background clears tabStreams on history updates.
//   4. Manifest hygiene: dead permissions removed.
//   5. Desktop: HLS resume bytes flow to startHlsDownload; rows that needed
//      cookies skip auto-resume; state files write atomically with a .bak;
//      failed rows stay failed across restart; HLS errors emit once; the
//      generation guard protects the flush path.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const bgSrc = read('chrome-extension/background.js');
const ctSrc = read('chrome-extension/content.js');
const popSrc = read('chrome-extension/popup.js');
const popHtml = read('chrome-extension/popup.html');
const manifest = JSON.parse(read('chrome-extension/manifest.json'));
const managerSrc = read('src/download-manager.js');
const engineSrc = read('src/download-engine.js');
const serverSrc = read('src/server.js');
const uiSrc = read('ui/app.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// Extract a shipped function (brace-balanced, comment-aware — same approach
// as test/facebook-panel.js / test/panel-freshness.js).
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
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
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && /[(,=:?!&|{;\[]/.test(src[k - 1] || '(')) { inRe = true; continue; }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

// ── 1. Playing-now tagging ───────────────────────────────────────────────────
console.log('\nPlaying-now tagging');
check('scanVideoElements tags the variant the element renders',
  /srcUrl === video\.currentSrc[\s\S]{0,700}?info\.playing = true/.test(ctSrc));
check('getVideoVariants tags the current-src variant',
  /isCurrentSrc && \(isPlayingVideo\(video\) \|\| isActuallyPlaying\(video\)\)[\s\S]{0,120}?info\.playing = true/.test(ctSrc));
check('blob/MSE playing elements tag their real CDN row',
  /blobToRealUrlMap\.set\(v\.currentSrc, url\);[\s\S]{0,450}?info\.playing = true/.test(ctSrc));
check('capsule renders the ▶ NOW PLAYING badge',
  /aidm-cap-now/.test(ctSrc) && /▶ NOW PLAYING/.test(ctSrc));
check('popup renders the playing badge',
  /playing-badge/.test(popSrc) && popHtml.includes('playing-badge'));

{
  // mergeRowInto (shipped) must propagate the playing flag during collapse.
  const ct = new Function(
    grab(ctSrc, 'fbCanonicalHost') + '\n' +
    grab(ctSrc, 'fbEfgTag') + '\n' +
    grab(ctSrc, 'mergeRowInto') + '\n' +
    'return { mergeRowInto };'
  )();
  const prev = { url: 'https://video-a.fbcdn.net/f.mp4?oh=1', quality: '720p' };
  const dup = { url: 'https://video-a.fbcdn.net/f.mp4?oh=2', quality: '720p', playing: true };
  ct.mergeRowInto(prev, dup);
  check('mergeRowInto keeps the playing flag on the kept row', prev.playing === true);
}

{
  // background collapseVideoRows (shipped) must propagate it too.
  const FB_HOST_RE = /fbcdn\.net|scontent\.|facebook\.com|fb\.com|instagram\.com|cdninstagram\.com/i;
  const TOKEN_PARAMS = new Set(['token', 'sig']);
  const bg = new Function('FB_HOST_RE', 'TOKEN_PARAMS',
    grab(bgSrc, 'fbCanonicalHost') + '\n' +
    grab(bgSrc, 'fbEfgTag') + '\n' +
    grab(bgSrc, 'fbFileKey') + '\n' +
    grab(bgSrc, 'normalizeSentUrl') + '\n' +
    grab(bgSrc, 'fbPathKey') + '\n' +
    grab(bgSrc, 'fbEfgTagOfUrl') + '\n' +
    grab(bgSrc, 'collapseRowKey') + '\n' +
    grab(bgSrc, 'collapseVideoRows') + '\n' +
    'return { collapseVideoRows };'
  )(FB_HOST_RE, TOKEN_PARAMS);
  const rows = [
    { url: 'https://video-a.fbcdn.net/f.mp4?oh=1', quality: '720p', resolution: '1280x720' },
    { url: 'https://video-a.fbcdn.net/f.mp4?oh=2', quality: '720p', resolution: '1280x720', playing: true },
  ];
  const out = bg.collapseVideoRows(rows);
  check('collapseVideoRows keeps the playing flag', out.length === 1 && out[0].playing === true);
}

// ── 2. True sizes only ───────────────────────────────────────────────────────
console.log('\nTrue sizes only');
check('content.js never feeds transferSize/decodedBodySize into row sizes',
  !/info\.size = e(ntry)?\.transferSize/.test(ctSrc) &&
  !/\.size = e\.transferSize/.test(ctSrc) &&
  !/size = e\.transferSize/.test(ctSrc) &&
  !/size = e\.decodedBodySize/.test(ctSrc));
check('size is out of the content collapse key',
  !grab(ctSrc, 'collapseRowKey').includes('v.size'));
check('size is out of the background collapse key',
  !grab(bgSrc, 'collapseRowKey').includes('v.size'));
check('size is out of the popup collapse key',
  !grab(popSrc, 'collapseRowKeyInline').includes('v.size'));

// ── 3. SPA freshness ─────────────────────────────────────────────────────────
console.log('\nSPA freshness');
check('content clears page caches on pushState/replaceState/popstate',
  /history\.pushState[\s\S]{0,300}?clearPageDetections/.test(ctSrc) &&
  /history\.replaceState[\s\S]{0,300}?clearPageDetections/.test(ctSrc) &&
  /addEventListener\('popstate'[\s\S]{0,120}?clearPageDetections/.test(ctSrc));
check('clearPageDetections resets the detection caches',
  /function clearPageDetections\(\)[\s\S]{0,500}?detectedVideos\.clear\(\)[\s\S]{0,300}?interceptedMediaUrls\.clear\(\)/.test(ctSrc));
check('popup omits since (background falls back to tab navigation time)',
  !/get-panel-data'[^}]*since/.test(popSrc));
check('background records tab navigation time for the popup freshness floor',
  /tabNavAt\.set\(tabId, Date\.now\(\)\)/.test(bgSrc) &&
  /tabNavAt\.set\(details\.tabId, Date\.now\(\)\)/.test(bgSrc) &&
  /tabNavAt\.get\(tabId\) \|\| 0/.test(bgSrc));
check('background clears tabStreams on SPA history updates',
  /onHistoryStateUpdated[\s\S]{0,900}?tabStreams\.delete\(details\.tabId\)/.test(bgSrc));

// ── 4. Manifest hygiene ──────────────────────────────────────────────────────
console.log('\nManifest hygiene');
check('dead permissions removed',
  !manifest.permissions.includes('storage') &&
  !manifest.permissions.includes('activeTab') &&
  !manifest.permissions.includes('downloads.open') &&
  !manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
check('permissions actually used stay',
  manifest.permissions.includes('downloads') && manifest.permissions.includes('cookies') &&
  manifest.permissions.includes('webRequest') && manifest.permissions.includes('declarativeNetRequest'));

// ── 5. Desktop reliability ───────────────────────────────────────────────────
console.log('\nDesktop reliability');
check('manager passes the persisted HLS resume point to the engine',
  /startHlsDownload\(\{[\s\S]{0,600}?resumeBytes:/.test(managerSrc));
check('engine accepts resumeIndex/resumeBytes params',
  /startHlsDownload\(\{[\s\S]{0,400}?resumeIndex: resumeIndexArg = 0[\s\S]{0,120}?resumeBytes: resumeBytesArg = 0/.test(engineSrc));
check('rows record needsSession for restart decisions',
  /needsSession: !!replay\.cookies/.test(managerSrc));
check('auto-resume skips rows that needed session cookies',
  /settings\.autoResume !== false[\s\S]{0,300}?!d\.needsSession/.test(managerSrc));
check('downloads state writes atomically (tmp + rename)',
  /_persistDownloads\(\)[\s\S]{0,2600}?\.tmp['"][\s\S]{0,600}?renameSync/.test(managerSrc));
check('downloads state keeps a .bak fallback and _loadDownloads uses it',
  /copyFileSync\(dataPath, dataPath \+ '\.bak'\)/.test(managerSrc) &&
  /readFileSync\(dataPath \+ '\.bak'/.test(managerSrc));
check('restart preserves failed (error) rows',
  /d\.status !== 'error'[\s\S]{0,120}?d\.status = 'paused'/.test(managerSrc.replace(/\r?\n\s*/g, ' ')) ||
  /d\.status !== 'completed'[\s\S]{0,400}?'error'[\s\S]{0,200}?\{[\s\S]{0,200}?d\.status = 'paused'/.test(managerSrc));
check('HLS failure emits download-error exactly once (status guard)',
  /download\.status !== 'paused' && !download\.cancelled && download\.status !== 'error'[\s\S]{0,80}?fail\(err\.message\)/.test(engineSrc));
check('HLS generation guard protects flush and close paths',
  /_hlsGen/.test(engineSrc) && /genDead\(\)\) return/.test(engineSrc.replace(/\s+/g, ' ')));
check('resolve-twitter routes through the strict registry',
  /req\.url === '\/api\/resolve-twitter'[\s\S]{0,1400}?resolvers\.resolveMedia\(url\)/.test(serverSrc));
check('resolve endpoints use per-endpoint limiters',
  (serverSrc.match(/RESOLVE_LIMITERS\[req\.url\]\?\.allow\(\)/g) || []).length === 4);
check('completed UI rows zero speed and snap to total',
  /onDownloadComplete[\s\S]{0,500}?dl\.speed = 0[\s\S]{0,300}?dl\.percent = 100/.test(uiSrc.replace(/\r?\n\s*/g, ' ')));
check('open-file paths are AiDM-scoped (isAiOwnedPath)',
  /function isAiOwnedPath\(/.test(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')));

console.log('\nplaying-now: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
