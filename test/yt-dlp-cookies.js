// Regression: yt-dlp must receive the session cookies AiDM already has.
//
// yt-dlp runs as a CHILD PROCESS and does not inherit the browser session the
// extension captured. Before this, cookies were forwarded to direct HTTP
// downloads but silently dropped on the YouTube path — so a logged-in user's
// own private / members-only / age-confirmed video failed with "Sign in to
// confirm you're not a bot" while the same video played fine in the browser.
//
// The secret must reach yt-dlp as a FILE, never as an argv entry: a command
// line is visible to every process listing on the machine.
//
// Pure helpers are tested directly; no yt-dlp binary is needed (or spawned).
// Run: node test/yt-dlp-cookies.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const ROOT = path.join(__dirname, '..');
const ytdlp = require(path.join(ROOT, 'src', 'yt-dlp.js'));

// ── cookieDomainFor ─────────────────────────────────────────────────────────
console.log('── cookieDomainFor ──');
check('host from a watch URL', ytdlp.cookieDomainFor('https://www.youtube.com/watch?v=abc') === 'www.youtube.com',
  ytdlp.cookieDomainFor('https://www.youtube.com/watch?v=abc'));
check('host from a bare host URL', ytdlp.cookieDomainFor('https://example.com/x') === 'example.com');
check('null for a non-URL (never throws)', ytdlp.cookieDomainFor('not a url') === null);
check('null for empty input', ytdlp.cookieDomainFor('') === null);

// ── parseCookiePairs ────────────────────────────────────────────────────────
console.log('── parseCookiePairs ──');
{
  const pairs = ytdlp.parseCookiePairs('a=1; b=2;   c=3');
  check('splits name=value pairs', pairs.length === 3, JSON.stringify(pairs));
  check('values kept verbatim', pairs[1] && pairs[1][0] === 'b' && pairs[1][1] === '2');
  check('value containing = survives',
    JSON.stringify(ytdlp.parseCookiePairs('tok=ab=cd')).includes('ab=cd'));
  check('flag-only fragment dropped', ytdlp.parseCookiePairs('Secure; a=1').length === 1);
  check('empty header → no pairs', ytdlp.parseCookiePairs('').length === 0);
  check('null header → no pairs', ytdlp.parseCookiePairs(null).length === 0);
}

// ── netscapeCookieFile ──────────────────────────────────────────────────────
console.log('── netscapeCookieFile ──');
{
  const body = ytdlp.netscapeCookieFile('www.youtube.com', 'SID=xyz; LOGIN_INFO=abc');
  const lines = body.split('\n').filter(Boolean);
  check('Netscape header present', lines[0] === '# Netscape HTTP Cookie File', lines[0]);
  check('one row per cookie', lines.length === 3, `${lines.length} lines`);

  const row = lines[1].split('\t');
  check('tab-separated with 7 fields', row.length === 7, `${row.length} fields`);
  check('leading dot for subdomain match', row[0] === '.www.youtube.com', row[0]);
  check('includeSubdomains TRUE', row[1] === 'TRUE');
  check('path is /', row[2] === '/');
  check('secure flag FALSE', row[3] === 'FALSE');
  const expires = Number(row[4]);
  check('expiry is in the future', Number.isFinite(expires) && expires * 1000 > Date.now());
  check('name and value land in the right fields', row[5] === 'SID' && row[6] === 'xyz',
    `${row[5]}=${row[6]}`);

  check('empty when no domain', ytdlp.netscapeCookieFile(null, 'a=1') === '');
  check('empty when no usable cookie', ytdlp.netscapeCookieFile('x.com', 'Secure') === '');
  check('empty when header is null', ytdlp.netscapeCookieFile('x.com', null) === '');
  check('no leading dot for a single-label host',
    ytdlp.netscapeCookieFile('localhost', 'a=1').split('\n')[1].split('\t')[0] === 'localhost');
}

// ── cookieArgs ──────────────────────────────────────────────────────────────
console.log('── cookieArgs ──');
{
  check('cookie file forwarded',
    JSON.stringify(ytdlp.cookieArgs({ cookieFile: '/tmp/c.txt' })) === '["--cookies","/tmp/c.txt"]',
    JSON.stringify(ytdlp.cookieArgs({ cookieFile: '/tmp/c.txt' })));
  check('browser name lowercased',
    JSON.stringify(ytdlp.cookieArgs({ cookiesFromBrowser: 'Chrome' })) === '["--cookies-from-browser","chrome"]');
  check('edge accepted',
    ytdlp.cookieArgs({ cookiesFromBrowser: 'edge' })[1] === 'edge');
  check('unknown browser ignored (argv injection guard)',
    ytdlp.cookieArgs({ cookiesFromBrowser: 'netscape --evil' }).length === 0);
  check('http referer forwarded',
    JSON.stringify(ytdlp.cookieArgs({ referer: 'https://www.youtube.com/watch?v=x' })) ===
    '["--referer","https://www.youtube.com/watch?v=x"]');
  check('javascript: referer rejected',
    ytdlp.cookieArgs({ referer: 'javascript:alert(1)' }).length === 0);
  check('non-http referer rejected',
    ytdlp.cookieArgs({ referer: 'file:///etc/passwd' }).length === 0);
  check('empty options → no args', JSON.stringify(ytdlp.cookieArgs({})) === '[]');
  check('null options → no args', JSON.stringify(ytdlp.cookieArgs(null)) === '[]');
  check('file + browser + referer combine in a stable order',
    JSON.stringify(ytdlp.cookieArgs({ cookieFile: '/tmp/c.txt', cookiesFromBrowser: 'firefox', referer: 'https://x.test/' })) ===
    '["--cookies-from-browser","firefox","--cookies","/tmp/c.txt","--referer","https://x.test/"]');
}

// ── writeCookieFile / deleteCookieFile ──────────────────────────────────────
console.log('── writeCookieFile round-trip ──');
{
  // cookieDir() reads the env at call time, so point it at a scratch dir.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-cookie-test-'));
  const savedLocal = process.env.LOCALAPPDATA;
  const savedHome = process.env.HOME;
  const savedXdg = process.env.XDG_DATA_HOME;
  process.env.LOCALAPPDATA = scratch;
  process.env.HOME = scratch;
  process.env.XDG_DATA_HOME = scratch;
  try {
    const p = ytdlp.writeCookieFile('https://www.youtube.com/watch?v=abc', 'SID=xyz');
    check('file written', !!p && fs.existsSync(p), p ? path.basename(p) : 'null');
    if (p) {
      const text = fs.readFileSync(p, 'utf8');
      check('content is a Netscape file', text.startsWith('# Netscape HTTP Cookie File'));
      check('cookie value present', text.includes('SID') && text.includes('xyz'));
      check('not adjacent to the app data (own dir)', p.includes(path.join('cookies')));
      ytdlp.deleteCookieFile(p);
      check('deleted after the job', !fs.existsSync(p));
    }
    check('no file when there is no cookie', ytdlp.writeCookieFile('https://x.test/a', null) === null);
    check('deleting null is a no-op', (() => { ytdlp.deleteCookieFile(null); return true; })());
  } finally {
    process.env.LOCALAPPDATA = savedLocal;
    process.env.HOME = savedHome;
    process.env.XDG_DATA_HOME = savedXdg;
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
  }
}

// ── redaction ───────────────────────────────────────────────────────────────
console.log('── cookies never reach a log ──');
check('Cookie header redacted',
  !ytdlp.redact('sending Cookie: SID=supersecret; HSID=zzz').includes('supersecret'),
  ytdlp.redact('sending Cookie: SID=supersecret'));
check('Authorization header redacted',
  !ytdlp.redact('Authorization: Bearer abc123').includes('abc123'));
check('signed params still redacted',
  ytdlp.redact('x?sig=deadbeef&other=1').includes('sig=REDACTED'));

// ── wiring ──────────────────────────────────────────────────────────────────
console.log('── wiring ──');
{
  const dm = fs.readFileSync(path.join(ROOT, 'src', 'download-manager.js'), 'utf8');
  const yr = fs.readFileSync(path.join(ROOT, 'src', 'youtube-resolver.js'), 'utf8');
  const yt = fs.readFileSync(path.join(ROOT, 'src', 'yt-dlp.js'), 'utf8');

  check('download() forwards the row cookies', /cookies:\s*download\.cookies/.test(dm));
  check('download() forwards the page referer', /referer:\s*\(download\.meta && download\.meta\.pageUrl\)/.test(dm));
  check('download() forwards the browser setting', /cookiesFromBrowser:\s*String\(this\.settings\.youtubeCookiesFromBrowser/.test(dm));
  check('probe() forwards cookies too (picker must list private videos)',
    /ytdlp\.probe\(canonical,[\s\S]{0,200}cookies:\s*opts\.cookies/.test(yr));
  check('module exports the cookie helpers',
    ['cookieArgs', 'netscapeCookieFile', 'writeCookieFile', 'deleteCookieFile']
      .every(k => typeof ytdlp[k] === 'function'));
  // The whole point of the file: secrets must not sit in argv.
  check('cookies are never passed via --add-header',
    !/--add-header['"]?\s*,\s*['"]?Cookie/i.test(yt));
  check('cookie file removed in download() finish',
    /deleteCookieFile\(cookieFile\)/.test(yt));
  check('probe() removes its cookie file too', /finally\s*\{\s*\n\s*deleteCookieFile\(cookieFile\)/.test(yt));
}

console.log(`\nyt-dlp-cookies: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
