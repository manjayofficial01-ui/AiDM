// Regression harness for the YouTube hand-off between the Chrome extension
// and the desktop app.
//
// Why this exists: on YouTube the URLs the extension SNIFFS are worthless to a
// download manager — the player pulls picture and sound as two separate signed
// DASH urls that expire in minutes, so saving one yields a silent or dead file.
// The extension must therefore hand the WATCH PAGE to the desktop, exactly like
// it already does for tweets and Facebook videos, and the desktop resolves it
// with yt-dlp into real merged qualities.
//
// Shipped behavior under test (pure URL logic + wiring, no browser needed):
//   • YT_PAGE_URL_RE / isYouTubePageUrl acceptance and rejection
//   • maybeResolveYouTube is hooked into BOTH navigation listeners
//     (tabs.onUpdated and the SPA history listener — YouTube is an SPA, so
//     without the history hook in-app navigation would never resolve)
//   • it posts to /api/resolve-youtube, retries after a failure, and sends NO
//     cookies (AiDM does not bypass login walls or bot checks)
//   • the desktop endpoint is rate-limited, emits video-detected with the
//     canonical page url, and reports failure instead of hanging
//
// Run: node test/youtube-extension.js
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const SRC = path.join(__dirname, '..', 'chrome-extension', 'background.js');
const bg = fs.readFileSync(SRC, 'utf8');
const SRV = path.join(__dirname, '..', 'src', 'server.js');
const srv = fs.readFileSync(SRV, 'utf8');

// ── 1. Page-URL detection (the shipped regex, evaluated) ─────────────────────

const m = /const YT_PAGE_URL_RE = (\/\[\^|[^;]+?\/[a-z]*);/.exec(bg) ||
          /const YT_PAGE_URL_RE = (\/.+?\/[a-z]*);/.exec(bg);
check('YT_PAGE_URL_RE exists in shipped background.js', !!m);
if (!m) {
  console.log(`\nyoutube-extension: ${pass} passed, ${fail} failed`);
  process.exitCode = 1;
} else {
  const re = new Function('return ' + m[1])();
  const isYt = (u) => re.test(u);

  console.log('\nYouTube page detection (accepted)');
  for (const [label, url] of [
    ['watch', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['watch + feature first', 'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ'],
    ['watch + timestamp', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'],
    ['mobile', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['music', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['http', 'http://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['shorts', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'],
    ['embed', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['live', 'https://www.youtube.com/live/dQw4w9WgXcQ'],
    ['/v/', 'https://www.youtube.com/v/dQw4w9WgXcQ'],
    ['nocookie embed', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['youtu.be', 'https://youtu.be/dQw4w9WgXcQ'],
    ['youtu.be + si', 'https://youtu.be/dQw4w9WgXcQ?si=abc123'],
  ]) {
    check('accepts ' + label, isYt(url));
  }

  console.log('\nYouTube page detection (rejected)');
  for (const [label, url] of [
    ['homepage', 'https://www.youtube.com/'],
    ['watch without v', 'https://www.youtube.com/watch'],
    ['playlist', 'https://www.youtube.com/playlist?list=PL1234567890'],
    ['channel', 'https://www.youtube.com/@MrBeast'],
    ['results', 'https://www.youtube.com/results?search_query=x'],
    ['sniffed DASH url', 'https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1700000000&itag=137'],
    ['lookalike host', 'https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ'],
    ['facebook watch', 'https://www.facebook.com/watch/?v=1234567890'],
    ['short id', 'https://www.youtube.com/watch?v=dQw4w9Wg'],
    ['empty', ''],
  ]) {
    check('rejects ' + label, !isYt(url));
  }

  // ── 2. Extension wiring ───────────────────────────────────────────────────

  console.log('\nExtension wiring');
  check('maybeResolveYouTube is defined', /function maybeResolveYouTube\(/.test(bg));
  check('has its own retry map', /const resolvedYtPages = new Map\(\)/.test(bg));
  check('retry window is bounded', /YT_RETRY_MS/.test(bg) && /resolvedYtPages\.get\(key\)/.test(bg));
  check('posts to /api/resolve-youtube', /\/api\/resolve-youtube/.test(bg));

  const onUpdated = /chrome\.tabs\.onUpdated\.addListener\(([\s\S]*?)\n  \}\);/.exec(bg);
  check('hooked into tabs.onUpdated (complete)',
    !!onUpdated && onUpdated[1].includes('maybeResolveYouTube(tab.url)'));
  const onHistory = /onHistoryStateUpdated\.addListener\(([\s\S]*?)\n  \}\);/.exec(bg);
  check('hooked into the SPA history listener (YouTube is an SPA)',
    !!onHistory && onHistory[1].includes('maybeResolveYouTube(details.url)'));

  // A failed resolve must not suppress the page for a full minute.
  const fn = /function maybeResolveYouTube\(url\) \{([\s\S]*?)\n\}\n/.exec(bg);
  check('failed resolve allows a retry (key deleted)',
    !!fn && /resolvedYtPages\.delete\(key\)/.test(fn[1]));
  check('app not running allows a retry (catch deletes key)',
    !!fn && /catch \(e\) \{\s*\n?\s*resolvedYtPages\.delete\(key\)/.test(fn[1]));

  // No cookies: resolving with a session cookie would be an access-control
  // bypass, which this engine deliberately does not do.
  check('sends no cookies with a YouTube resolve',
    !!fn && !/cookies/i.test(fn[1]));

  // ── 3. Desktop endpoint ───────────────────────────────────────────────────

  console.log('\nDesktop endpoint');
  const ep = /req\.url === '\/api\/resolve-youtube'[\s\S]*?\n      \}\n/.exec(srv);
  check('/api/resolve-youtube exists', !!ep);
  if (ep) {
    check('rate limited like every resolve endpoint', /RESOLVE_LIMITERS\[req\.url\]\?\.allow\(\)/.test(ep[0]));
    check('uses the resolver registry (provider dispatch)', /resolvers\.resolveMedia\(/.test(ep[0]));
    check('emits video-detected for the capsule', /emit\('video-detected'/.test(ep[0]));
    check('page url is the canonical watch url', /pageUrl: r\.canonicalUrl \|\| url/.test(ep[0]));
    check('shows the real video title', /pageTitle: pageTitle \|\| r\.title/.test(ep[0]));
    check('passes the picker video list', /videos: r\.pickerVideos \|\| \[\]/.test(ep[0]));
    check('reports failure instead of hanging', /success: false/.test(ep[0]));
    // Cookies may be FORWARDED to the resolver — yt-dlp needs the session to
    // list a signed-in user's own private/members-only video — but they must
    // never land on the row that gets persisted, nor be echoed to the caller.
    const payloadBlock = (/const payload = \{([\s\S]*?)\n\s*\};/.exec(ep[0]) || [])[1] || '';
    check('never attaches cookies to the row', !!payloadBlock && !/cookies:/.test(payloadBlock));
    const okResponse = /res\.end\(JSON\.stringify\(\{ success: true, provider: 'youtube'[\s\S]*?\)\);/.exec(ep[0]);
    check('never returns cookies to the caller', !!okResponse && !/cookies:/.test(okResponse[0]));
    check('forwards the session to the resolver (not onto the row)',
      /resolveMedia\(url,[\s\S]{0,240}cookies:/.test(ep[0]));
  }

  // ── 4. Hiding the player's own CDN urls on a YouTube page ─────────────────

  console.log('\nCapsule: no silent DASH rows');
  const db = /function dropYoutubeCdn\(list, isYtPage\) \{([\s\S]*?)\n\}/.exec(bg);
  check('dropYoutubeCdn exists in shipped background.js', !!db);
  if (db) {
    const drop = new Function('list', 'isYtPage', db[1]);
    const dash = [
      { url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?itag=137' },
      { url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?itag=140' },
    ];
    check('drops the player DASH urls on a YouTube page', drop(dash, true).length === 0);
    check('keeps them elsewhere (non-YouTube page)', drop(dash, false).length === 2);
    check('leaves unrelated urls alone',
      drop([{ url: 'https://cdn.example.com/clip.mp4' }], true).length === 1);
    check('tolerates null / non-array input', drop(null, true) === null && drop('x', true) === 'x');
  }
  check('getTabStreams applies the filter', /return dropYoutubeCdn\([\s\S]{0,160}tabYtPage\.get\(tabId\)/.test(bg));
  check('per-tab flag declared', /const tabYtPage = new Map\(\)/.test(bg));
  check('flag set on a completed YouTube navigation',
    /if \(isYouTubePageUrl\(tab\.url\)\) tabYtPage\.set\(tabId, true\)/.test(bg));
  check('flag cleared on navigation start', /tabStreams\.delete\(tabId\);\s*\n\s*tabYtPage\.delete\(tabId\);/.test(bg));
  check('flag follows SPA navigation both ways',
    /if \(isYouTubePageUrl\(details\.url\)\) tabYtPage\.set\(details\.tabId, true\);\s*\n\s*else tabYtPage\.delete\(details\.tabId\)/.test(bg));

  check('resolver registry supports the watch url it will be sent',
    require('../src/resolvers').findResolver('https://www.youtube.com/watch?v=dQw4w9WgXcQ') !== null);
}

console.log(`\nyoutube-extension: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
