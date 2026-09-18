// Regression harness for the v4.3.2 browser-parity download path.
//
// Research finding (verified against the TurboGet extension folder's own
// changelog, no code copied — it ships without a license): strict CDNs
// validate the EXACT header set the browser used during playback (Cookie +
// Referer + Origin + UA together), and `fetch()` from an extension context
// fails their SameSite/Sec-Fetch checks where Chrome's own downloader
// succeeds. AiDM answers with three original mechanisms:
//   1. exact request-header capture (webRequest.onBeforeSendHeaders) replayed
//      verbatim on the desktop download,
//   2. fresh-URL refresh at Download-click time (signed URLs expire fast),
//   3. last-resort native download via chrome.downloads + a short-lived DNR
//      Referer rule, plus an HTTP 501 fast-fail that points at it.
//
// The SHIPPED definitions are extracted (not copied). Run: node test/browser-engine.js
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
const bgSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
const ctSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8');
const mgrSrc = fs.readFileSync(path.join(ROOT, 'src', 'download-manager.js'), 'utf8');

const bg = new Function(
  'CAPTURE_MAX', 'CAPTURE_TTL_MS',
  grabShipped(bgSrc, 'noteCapturedRequest') + '\n' +
  grabShipped(bgSrc, 'getCapturedRequest') + '\n' +
  grabShipped(bgSrc, 'buildAidmRefererRule') + '\n' +
  'return { noteCapturedRequest, getCapturedRequest, buildAidmRefererRule };'
)(200, 10 * 60 * 1000);

// isMediaRequestUrl needs the module-scope regexes — provide matching ones.
const STREAM_REQ_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ts|m4s|key|akamai)($|\?|#)/i;
const STREAM_PATH_RE = /videoplayback|\/live\/|\/movie\/|\/series\/|\/hls\/|\/get_file\/|\/mp4\/|\.akamaihd\.net|\/secure\/|\/videos?\//i;
const FB_HOST_RE = /fbcdn\.net|scontent\.|facebook\.com|fb\.com|instagram\.com|cdninstagram\.com/i;
const FB_PATH_RE = /\/v\/t|video\.php|watchparty|\/reel|\/watch\/|playable|bytestart|\/dash\/|\/hls\//i;
const isMediaRequestUrl = new Function(
  'STREAM_REQ_RE', 'STREAM_PATH_RE', 'FB_HOST_RE', 'FB_PATH_RE',
  grabShipped(bgSrc, 'isMediaRequestUrl') + '\nreturn isMediaRequestUrl;'
)(STREAM_REQ_RE, STREAM_PATH_RE, FB_HOST_RE, FB_PATH_RE);

const { noteCapturedRequest, getCapturedRequest, buildAidmRefererRule } = bg;

// ── 1. media-request matching ──────────────────────────────────────────────
check('media type matches', isMediaRequestUrl('https://x.com/anything', 'media') === true);
check('mp4 matches', isMediaRequestUrl('https://s45.bigcdn.cc/pubs/abc/1080.mp4', 'xmlhttprequest') === true);
check('get_file matches', isMediaRequestUrl('https://site.example/get_file/abc123', 'xmlhttprequest') === true);
check('plain page does not match', isMediaRequestUrl('https://example.com/page.html', 'main_frame') === false);
check('image does not match', isMediaRequestUrl('https://example.com/a.jpg', 'image') === false);

// ── 2. header capture store ────────────────────────────────────────────────
function details(url, headers) {
  return {
    url, tabId: 7,
    requestHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
  };
}
{
  const store = new Map();
  noteCapturedRequest(store, details('https://s45.bigcdn.cc/pubs/abc/1080.mp4?sig=1',
    { Cookie: 'sess=tok123', Referer: 'https://mydaddy.cc/video/09c662a75858eed4ca/', Origin: 'https://mydaddy.cc', 'User-Agent': 'UA/1' }));
  const got = getCapturedRequest(store, 'https://s45.bigcdn.cc/pubs/abc/1080.mp4?sig=1');
  check('exact capture round-trips',
    !!got && got.cookie === 'sess=tok123' && got.referer === 'https://mydaddy.cc/video/09c662a75858eed4ca/' &&
    got.origin === 'https://mydaddy.cc' && got.userAgent === 'UA/1');
  check('rotated-token URL matches same file',
    getCapturedRequest(store, 'https://s45.bigcdn.cc/pubs/abc/1080.mp4?sig=ROTATED') === got);
  check('unrelated URL misses', getCapturedRequest(store, 'https://other.example/v.mp4') === null);
  check('stale entries skipped',
    getCapturedRequest(new Map([['u', { cookie: 'a', time: Date.now() - 20 * 60 * 1000 }]]), 'u') === null);
  check('bad input safe', getCapturedRequest(null, null) === null);
  noteCapturedRequest(null, null); // must not throw
  check('null store tolerated', true);
}

// ── 3. DNR referer rule builder ────────────────────────────────────────────
{
  const rule = buildAidmRefererRule(7001, 's45.bigcdn.cc', 'https://mydaddy.cc/video/09c662a75858eed4ca/');
  check('rule targets the host',
    rule.id === 7001 && rule.condition.urlFilter === '||s45.bigcdn.cc/' &&
    rule.action.requestHeaders[0].header === 'Referer' &&
    rule.action.requestHeaders[0].value === 'https://mydaddy.cc/video/09c662a75858eed4ca/');
  check('rule covers download traffic',
    rule.condition.resourceTypes.includes('media') && rule.action.type === 'modifyHeaders');
}

// ── 4. fresh URL at click time ─────────────────────────────────────────────
const pickFreshUrl = new Function(
  grabShipped(ctSrc, 'pickFreshUrl') + '\nreturn pickFreshUrl;'
)();
{
  const norm = (u) => String(u).split('?')[0]; // stand-in for token normalization
  check('same-file fresh URL wins',
    pickFreshUrl(
      ['https://cdn.example/v.mp4?sig=NEW', 'https://cdn.example/v.mp4?sig=OLD'],
      'https://cdn.example/v.mp4?sig=OLD', norm) === 'https://cdn.example/v.mp4?sig=NEW');
  check('stale list falls back', pickFreshUrl(
    ['https://cdn.example/other.mp4'], 'https://cdn.example/v.mp4?sig=OLD', norm) ===
    'https://cdn.example/v.mp4?sig=OLD');
  check('non-http candidates skipped', pickFreshUrl(
    ['blob:abc', 'data:x'], 'https://cdn.example/v.mp4', norm) === 'https://cdn.example/v.mp4');
  check('no fallback picks first playable', pickFreshUrl(
    ['blob:abc', 'https://cdn.example/v.mp4'], null, norm) === 'https://cdn.example/v.mp4');
}

// ── 5. HTTP 501 fast-fail with fallback hint ───────────────────────────────
const methodBlockedMessage = new Function(
  grabShipped(mgrSrc, 'methodBlockedMessage') + '\nreturn methodBlockedMessage;'
)();
{
  const m = methodBlockedMessage(501);
  check('501 message names status + browser fallback',
    /501/.test(m) && /browser.*fallback/i.test(m), m.slice(0, 80) + '…');
  check('501 guard wired at probe time',
    /meta\.status === 501/.test(mgrSrc) && /methodBlockedMessage\(meta\.status\)/.test(mgrSrc));
  check('501 mapped mid-stream',
    /401\|403\|501/.test(mgrSrc) && /methodBlockedMessage\(code\)/.test(mgrSrc));
}

// ── 6. wiring ──────────────────────────────────────────────────────────────
check('request-header capture listener registered',
  /onBeforeSendHeaders/.test(bgSrc) && /noteCapturedRequest\(capturedReqHeaders, details\)/.test(bgSrc));
check('captured headers replayed on desktop sends',
  /getCapturedRequest\(capturedReqHeaders, url\)/.test(bgSrc));
check('native-download handler present',
  /action === 'native-download'/.test(bgSrc) && /chrome\.downloads\.download/.test(bgSrc));
check('fallback context-menu entry present',
  /aidm-download-browser/.test(bgSrc));
check('capsule refreshes URL at click',
  /pickFreshUrl\(currentVideoUrls\(video\), v\.url/.test(ctSrc));
check('manifest allows DNR injection',
  /declarativeNetRequest/.test(fs.readFileSync(path.join(ROOT, 'chrome-extension', 'manifest.json'), 'utf8')));

console.log(`\nbrowser-engine: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
