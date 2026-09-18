// Regression harness for "AiDM cannot download Rapidgator links at all".
//
// Root cause: there was no resolver for file hosters, so a pasted
// https://rapidgator.net/file/<id>/<name>.html fell through the registry and
// the manager downloaded the PAGE HTML as a file.
//
// Shipped behaviour under test (pure parsers + injected fetchImpl, NO network):
//   - parseFileHostUrl strictness on every supported Rapidgator shape
//   - host allowlist refusal (an unrelated host is never fetched)
//   - extractDownloadUrlFromPage on a real download anchor / wait / captcha page
//   - extractApiDownloadUrl + extractApiToken envelope handling (200/401/403)
//   - resolveFileHost: premium API path, cookie session path, free-user wait
//     path and the readable-error paths (removed / premium-only / limits)
//   - singleConnection + resumable + replay headers on media[] and pickerVideos[]
//   - fileHostMediaResolver.supports() scope
//
// Run: node test/filehost-resolver.js
'use strict';

const fh = require('../src/filehost-resolver');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}
function eq(name, actual, expected) {
  const ok = actual === expected;
  check(name, ok, ok ? '' : `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const FILE_URL = 'https://rapidgator.net/file/123456789/Big.Buck.Bunny.mkv.html';
const PAGE_URL = 'https://rapidgator.net/file/123456789/Big.Buck.Bunny.mkv.html';
const DIRECT_URL = 'https://s3.rapidgator.net/dl/9f8e7d/Big.Buck.Bunny.mkv';

// ── 1. strict identifier-only URL parsing ──────────────────────────────────
{
  const p = fh.parseFileHostUrl(FILE_URL);
  check('file/<id>/<slug>.html parsed', !!p && p.host === 'rapidgator' &&
    p.fileId === '123456789' && p.fileName === 'Big.Buck.Bunny.mkv', JSON.stringify(p));

  const bare = fh.parseFileHostUrl('https://rapidgator.net/file/123456789');
  check('file/<id> parsed (no slug)', !!bare && bare.fileId === '123456789' && bare.fileName === null);

  const www = fh.parseFileHostUrl('https://www.rapidgator.net/file/987654321/Archive.Name.zip.html?lang=en');
  check('www host + query parsed', !!www && www.fileId === '987654321' && www.fileName === 'Archive.Name.zip');

  const rgto = fh.parseFileHostUrl('https://rg.to/file/555555555/some.iso.html');
  check('rg.to host parsed', !!rgto && rgto.host === 'rapidgator' && rgto.fileId === '555555555');

  const short = fh.parseFileHostUrl('https://rapidgator.net/Ab12Cd34Ef56Gh78');
  check('short /<hash> link parsed', !!short && short.fileId === 'Ab12Cd34Ef56Gh78' && short.kind === 'short');

  const dl = fh.parseFileHostUrl('https://rapidgator.net/download/deadbeef1234');
  check('/download/<hash> parsed', !!dl && dl.fileId === 'deadbeef1234' && dl.kind === 'download');

  check('canonical pageUrl rebuilt', !!p && p.pageUrl === PAGE_URL, p && p.pageUrl);

  eq('unrelated host rejected', fh.parseFileHostUrl('https://example.com/file/123456789/x.mkv.html'), null);
  eq('look-alike host rejected', fh.parseFileHostUrl('https://rapidgator.net.evil.com/file/123456789/x.html'), null);
  eq('site chrome path rejected', fh.parseFileHostUrl('https://rapidgator.net/article/premium'), null);
  eq('api path rejected', fh.parseFileHostUrl('https://rapidgator.net/api/file/download'), null);
  eq('non-http rejected', fh.parseFileHostUrl('ftp://rapidgator.net/file/123456789/x.html'), null);
  eq('garbage rejected', fh.parseFileHostUrl('not a url'), null);
  eq('null rejected', fh.parseFileHostUrl(null), null);

  check('isFileHostUrl true for rapidgator', fh.isFileHostUrl(FILE_URL) && fh.isFileHostUrl('https://rg.to/file/987654321/x.zip.html'));
  check('isFileHostUrl false for others',
    !fh.isFileHostUrl('https://example.com/file/123/x.html') &&
    !fh.isFileHostUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
}

// ── 2. host allowlist ──────────────────────────────────────────────────────
{
  check('rapidgator.net allowed', fh.isAllowedHost('rapidgator.net'));
  check('www.rapidgator.net allowed', fh.isAllowedHost('www.rapidgator.net'));
  check('rg.to allowed', fh.isAllowedHost('rg.to'));
  check('CDN sub-domain allowed', fh.isAllowedHost('s3.rapidgator.net') && fh.isAllowedHost('dl.rg.to'));
  check('unrelated host refused', !fh.isAllowedHost('example.com'));
  check('suffix look-alike refused', !fh.isAllowedHost('rapidgator.net.evil.com') && !fh.isAllowedHost('notrapidgator.net'));
  check('empty refused', !fh.isAllowedHost('') && !fh.isAllowedHost(null));
  check('HOSTS registry exposes rapidgator', fh.HOSTS && fh.HOSTS.rapidgator &&
    fh.HOSTS.rapidgator.pageHosts.includes('rapidgator.net') &&
    /api\/user\/login$/.test(fh.HOSTS.rapidgator.api.login));
}

// ── 3. fixtures ────────────────────────────────────────────────────────────

// Premium/cookie session page: a real download anchor straight at the bytes.
const READY_HTML = `
<!DOCTYPE html><html><head>
<title>Big.Buck.Bunny.mkv - Rapidgator.net</title>
</head><body>
<div class="file-info">
  <div class="file-name">Big.Buck.Bunny.mkv</div>
  <span>File size: 120.5 MB</span>
</div>
<a class="btn btn-premium" href="https://s3.rapidgator.net/dl/9f8e7d/Big.Buck.Bunny.mkv">Premium download</a>
<a class="btn btn-free" href="/download/9f8e7d">Slow download</a>
<a href="/premium">Go premium</a>
<a href="/file/123456789/Big.Buck.Bunny.mkv.html">Permalink</a>
</body></html>`;

// Free-user page: mandatory wait timer before a link is issued.
const WAIT_HTML = `
<!DOCTYPE html><html><head><title>Download file - Rapidgator.net</title></head><body>
<div class="file-name">Big.Buck.Bunny.mkv</div>
<div class="download-timer">Please wait <span id="timer">60</span> seconds</div>
<p>Free users must wait before the download starts.</p>
</body></html>`;

// Captcha page (never attempted — only reported).
const CAPTCHA_HTML = `
<html><body>
<h2>Please complete the captcha</h2>
<div class="g-recaptcha" data-sitekey="abc"></div>
</body></html>`;

// ── 4. extractDownloadUrlFromPage ──────────────────────────────────────────
{
  eq('direct download anchor found',
    fh.extractDownloadUrlFromPage(READY_HTML, PAGE_URL), DIRECT_URL);

  const rel = `<html><body><a href="/download/9f8e7d/Big.Buck.Bunny.mkv">Download</a></body></html>`;
  eq('relative anchor absolutized',
    fh.extractDownloadUrlFromPage(rel, PAGE_URL), 'https://rapidgator.net/download/9f8e7d/Big.Buck.Bunny.mkv');

  const protocolRel = `<html><body><a href="//s3.rapidgator.net/dl/9f8e7d/Big.Buck.Bunny.mkv">Download</a></body></html>`;
  eq('protocol-relative anchor absolutized',
    fh.extractDownloadUrlFromPage(protocolRel, PAGE_URL), DIRECT_URL);

  const jsHandoff = `<html><body><script>window.location.href = 'https://s3.rapidgator.net/dl/9f8e7d/Big.Buck.Bunny.mkv';</script></body></html>`;
  eq('JS location hand-off found',
    fh.extractDownloadUrlFromPage(jsHandoff, PAGE_URL), DIRECT_URL);

  eq('wait page offers no link', fh.extractDownloadUrlFromPage(WAIT_HTML, PAGE_URL), null);
  eq('captcha page offers no link', fh.extractDownloadUrlFromPage(CAPTCHA_HTML, PAGE_URL), null);
  eq('empty page offers no link', fh.extractDownloadUrlFromPage('', PAGE_URL), null);

  const offHost = `<html><body><a href="https://evil.example/dl/a.mkv">Download</a></body></html>`;
  eq('off-allowlist anchor refused', fh.extractDownloadUrlFromPage(offHost, PAGE_URL), null);

  const onlyPerma = `<html><body><a href="/file/123456789/Big.Buck.Bunny.mkv.html">Permalink</a></body></html>`;
  eq('permalink to the page is not a download', fh.extractDownloadUrlFromPage(onlyPerma, PAGE_URL), null);
}

// ── 5. page-state signalling (wait / captcha / limits) ─────────────────────
{
  const w = fh.detectFileHostPageState(WAIT_HTML);
  check('wait page state', w.kind === 'wait' && w.waitSeconds === 60 && w.requiresCredentials === true, JSON.stringify(w));
  const c = fh.detectFileHostPageState(CAPTCHA_HTML);
  check('captcha page state', c.kind === 'captcha' && c.requiresCredentials === true && c.waitSeconds > 0, JSON.stringify(c));
  const prem = fh.detectFileHostPageState('This file is not available for free users');
  check('premium-only state', prem.kind === 'premium-only' && prem.requiresCredentials === true);
  const gone = fh.detectFileHostPageState('File not found. The file was removed.');
  check('not-found state', gone.kind === 'not-found' && gone.requiresCredentials === false);
  const traffic = fh.detectFileHostPageState('You have reached your traffic limit');
  check('traffic-limit state', traffic.kind === 'traffic-limit');
  const freeLimit = fh.detectFileHostPageState('Download limit for free users exceeded');
  check('free-limit state', freeLimit.kind === 'free-limit');
  check('ordinary page is ready', fh.detectFileHostPageState(READY_HTML).kind === 'ready');
  eq('wait seconds parsed from timer span', fh.extractWaitSeconds(WAIT_HTML, ''), 60);
  eq('no wait seconds on a ready page', fh.extractWaitSeconds(READY_HTML, ''), 0);
}

// ── 6. title / size helpers ────────────────────────────────────────────────
eq('file title from page', fh.extractFileTitle(READY_HTML), 'Big.Buck.Bunny.mkv');
check('title never a hostname', fh.extractFileTitle('<title>Rapidgator.net</title>') === null);
eq('size parsed from page', fh.extractFileSize(READY_HTML), Math.round(120.5 * 1024 * 1024));
eq('no size → null', fh.extractFileSize('<html><body>hi</body></html>'), null);

// ── 7. API envelope parsing ────────────────────────────────────────────────
{
  const ok = { status: 200, response: { download_url: DIRECT_URL } };
  eq('api download_url', fh.extractApiDownloadUrl(ok), DIRECT_URL);
  eq('api download_url from JSON text', fh.extractApiDownloadUrl(JSON.stringify(ok)), DIRECT_URL);

  let e = null;
  try { fh.extractApiDownloadUrl({ status: 401, details: 'Invalid login or password' }); }
  catch (err) { e = err; }
  check('api 401 throws the API message', !!e && /Invalid login or password/.test(e.message), e && e.message);

  e = null;
  try { fh.extractApiDownloadUrl({ status: 403, details: 'Access denied for this account' }); }
  catch (err) { e = err; }
  check('api 403 throws the API message', !!e && /Access denied for this account/.test(e.message));

  e = null;
  try { fh.extractApiDownloadUrl({ status: 404, details: 'File not found' }); }
  catch (err) { e = err; }
  check('api 404 → readable not-available error', !!e && /not available/i.test(e.message));

  e = null;
  try { fh.extractApiDownloadUrl({ status: 200, response: { download_url: 'https://evil.example/a.mkv' } }); }
  catch (err) { e = err; }
  check('api off-allowlist download_url refused', !!e && /allowlist/.test(e.message), e && e.message);

  e = null;
  try { fh.extractApiDownloadUrl({ status: 200, response: {} }); }
  catch (err) { e = err; }
  check('api without download_url throws', !!e && /did not return a download URL/i.test(e.message));

  e = null;
  try { fh.extractApiDownloadUrl('<html>not json</html>'); }
  catch (err) { e = err; }
  check('unreadable api body throws', !!e && /unreadable/i.test(e.message));

  eq('api token from login envelope',
    fh.extractApiToken(JSON.stringify({ status: 200, response: { token: 'tok-abc' } })), 'tok-abc');
  e = null;
  try { fh.extractApiToken(JSON.stringify({ status: 401, details: 'Wrong login or password' })); }
  catch (err) { e = err; }
  check('bad login throws readable error', !!e && /login or password/i.test(e.message));
}

// ── 8. resolveFileHost with an injected fetchImpl (no network) ──────────────
(async () => {
  // 8a. premium API happy path
  {
    const calls = [];
    const apiFetch = async (url, o) => {
      calls.push({ url, method: (o && o.method) || 'GET', body: o && o.body });
      if (/api\/user\/login/.test(url)) {
        return { status: 200, headers: {}, finalUrl: url, text: JSON.stringify({ status: 200, response: { token: 'tok-abc' } }) };
      }
      if (/api\/file\/download/.test(url)) {
        return { status: 200, headers: {}, finalUrl: url, text: JSON.stringify({ status: 200, response: { download_url: DIRECT_URL } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    };

    const r = await fh.resolveFileHost(FILE_URL, {
      credentials: { user: 'me@example.com', password: 's3cret' },
      fetchImpl: apiFetch,
    });

    check('premium: login then download API called',
      calls.length === 2 && /api\/user\/login$/.test(calls[0].url) &&
      /login=me%40example\.com/.test(String(calls[0].body)) &&
      /api\/file\/download\?file_id=123456789&token=tok-abc/.test(calls[1].url),
      JSON.stringify(calls.map(c => c.url)));
    check('premium: provider + id', r.provider === 'rapidgator' && r.id === '123456789');
    check('premium: direct url', r.media.length === 1 && r.media[0].url === DIRECT_URL);
    check('premium: singleConnection + not resumable',
      r.media[0].singleConnection === true && r.media[0].resumable === false);
    check('premium: replay headers present',
      !!r.media[0].headers && r.media[0].headers.Referer === PAGE_URL && /Chrome/.test(r.media[0].headers['User-Agent']));
    check('premium: filename from the real file name', r.media[0].filename === 'Big.Buck.Bunny.mkv', r.media[0].filename);
    check('premium: title is the file name, not a hostname',
      r.title === 'Big.Buck.Bunny.mkv' && !/rapidgator|rg\.to/i.test(r.title), r.title);
    check('premium: canonicalUrl + referer', r.canonicalUrl === PAGE_URL && r.referer === PAGE_URL);
    check('premium: picker mirrors flags + headers',
      r.pickerVideos.length === 1 &&
      r.pickerVideos[0].singleConnection === true &&
      r.pickerVideos[0].resumable === false &&
      r.pickerVideos[0].headers.Referer === PAGE_URL &&
      r.pickerVideos[0].provider === 'rapidgator' &&
      r.pickerVideos[0].filename === 'Big.Buck.Bunny.mkv');
    check('premium: no wait signalled', r.waitSeconds === 0 && r.requiresCredentials === false);
  }

  // 8b. cookie (logged-in session) path — page flow, cookie replayed
  {
    const COOKIE = 'PHPSESSID=abc123; user__=def456';
    let seenCookie = null;
    const cookieFetch = async (url, o) => {
      seenCookie = (o && o.headers && o.headers.Cookie) || null;
      return { status: 200, headers: {}, finalUrl: url, text: READY_HTML };
    };
    const r = await fh.resolveFileHost(FILE_URL, { cookie: COOKIE, fetchImpl: cookieFetch });
    check('cookie: session cookie sent on the page request', seenCookie === COOKIE);
    check('cookie: direct url resolved', r.media[0].url === DIRECT_URL);
    check('cookie: cookie replayed on the download', r.media[0].headers.Cookie === COOKIE);
    check('cookie: singleConnection + not resumable',
      r.media[0].singleConnection === true && r.media[0].resumable === false);
    check('cookie: filename + size', r.media[0].filename === 'Big.Buck.Bunny.mkv' && r.media[0].size > 0,
      String(r.media[0].size));
    check('cookie: result carries size', r.size === r.media[0].size);
  }

  // 8c. free-user wait path — no captcha bypass, wait reported instead
  {
    let waited = null;
    const r = await fh.resolveFileHost(FILE_URL, {
      fetchImpl: async (url) => ({ status: 200, headers: {}, finalUrl: url, text: WAIT_HTML }),
      onWait: (info) => { waited = info; },
    });
    check('wait: waitSeconds reported', r.waitSeconds === 60, String(r.waitSeconds));
    check('wait: requiresCredentials flagged', r.requiresCredentials === true);
    check('wait: no media offered (nothing to download yet)', Array.isArray(r.media) && r.media.length === 0);
    check('wait: onWait callback fired', !!waited && waited.waitSeconds === 60);
    check('wait: hint mentions premium or session cookie',
      /premium|session cookie/i.test(r.hint || ''), r.hint);
  }

  // 8d. captcha path
  {
    const r = await fh.resolveFileHost(FILE_URL, {
      fetchImpl: async (url) => ({ status: 200, headers: {}, finalUrl: url, text: CAPTCHA_HTML }),
    });
    check('captcha: wait + credentials required, no bypass',
      r.requiresCredentials === true && r.waitSeconds > 0 && r.media.length === 0);
  }

  // 8e. failure paths — every one throws a readable Error
  {
    const cases = [
      ['file removed', 'File not found — this file was removed from our servers.', /not available|removed/i],
      ['premium-only file', 'This file is not available for free users.', /not available for free users/i],
      ['traffic limit', 'You have reached your traffic limit for today.', /traffic limit/i],
      ['free limit exceeded', 'Download limit for free users exceeded.', /limit/i],
      ['no link on page', '<html><body>Nothing here</body></html>', /premium account|session cookie/i],
    ];
    for (const [name, html, re] of cases) {
      let e = null;
      try {
        await fh.resolveFileHost(FILE_URL, {
          fetchImpl: async (url) => ({ status: 200, headers: {}, finalUrl: url, text: html }),
        });
      } catch (err) { e = err; }
      check(`${name} throws a readable error`, !!e && e instanceof Error && re.test(e.message), e && e.message);
      if (name === 'premium-only file') {
        check('premium-only error names the fix', !!e && /Settings › File hosts/.test(e.message));
      }
    }

    let e = null;
    try {
      await fh.resolveFileHost(FILE_URL, {
        credentials: { user: 'me', password: 'wrong' },
        fetchImpl: async () => ({ status: 200, headers: {}, finalUrl: 'https://rapidgator.net/api/user/login', text: JSON.stringify({ status: 401, details: 'Invalid login or password' }) }),
      });
    } catch (err) { e = err; }
    check('bad credentials throw readable error', !!e && /login or password/i.test(e.message), e && e.message);
  }

  // 8f. host allowlist refusal — an off-list URL is never fetched
  {
    let calls = 0;
    let e = null;
    try {
      await fh.resolveFileHost('https://evil.example/file/123456789/x.mkv.html', {
        fetchImpl: async () => { calls++; return { status: 200, headers: {}, text: '' }; },
      });
    } catch (err) { e = err; }
    check('off-allowlist URL refused before any fetch', !!e && calls === 0, e && e.message);
    check('off-allowlist refusal is readable', !!e && /Rapidgator/i.test(e.message));
    check('off-allowlist URL never supported', !fh.isFileHostUrl('https://evil.example/file/123456789/x.html'));
  }

  // 8g. direct file URL detection stays on the allowlist
  check('CDN url looks like a direct file', fh.looksLikeDirectFile(DIRECT_URL));
  check('file page does not look like a direct file', !fh.looksLikeDirectFile(PAGE_URL));
  check('off-host file url refused', !fh.looksLikeDirectFile('https://evil.example/a.mkv'));

  // ── 9. toPickerVideos ────────────────────────────────────────────────────
  {
    const r = await fh.resolveFileHost(FILE_URL, {
      cookie: 'PHPSESSID=x',
      fetchImpl: async (url) => ({ status: 200, headers: {}, finalUrl: url, text: READY_HTML }),
    });
    const picker = fh.toPickerVideos(r);
    check('toPickerVideos from result', picker.length === 1 &&
      picker[0].url === DIRECT_URL &&
      picker[0].singleConnection === true &&
      picker[0].resumable === false &&
      picker[0].headers.Cookie === 'PHPSESSID=x' &&
      picker[0].pageUrl === PAGE_URL && picker[0].provider === 'rapidgator');
    const fromMedia = fh.toPickerVideos(r.media);
    check('toPickerVideos from media[]', fromMedia.length === 1 && fromMedia[0].url === DIRECT_URL);
    check('toPickerVideos of nothing → []', fh.toPickerVideos(null).length === 0);
  }

  // ── 10. resolver adapter scope ───────────────────────────────────────────
  {
    const R = fh.fileHostMediaResolver;
    check('resolver name is filehost', R.name === 'filehost' &&
      typeof R.supports === 'function' && typeof R.resolve === 'function');
    check('supports rapidgator links',
      R.supports(FILE_URL) &&
      R.supports('https://rg.to/file/987654321/a.zip.html') &&
      R.supports('https://rapidgator.net/download/deadbeef1234'));
    check('does not support youtube', !R.supports('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    check('does not support twitter/x', !R.supports('https://x.com/foo/status/123456789012345678'));
    check('does not support facebook', !R.supports('https://www.facebook.com/watch/?v=1234567890'));
    check('does not support mydaddy', !R.supports('https://mydaddy.cc/video/09c662a75858eed4ca/'));
    check('supports() never throws on garbage', R.supports('not a url') === false && R.supports(null) === false);

    const r = await R.resolve(FILE_URL, {
      cookie: 'PHPSESSID=x',
      fetchImpl: async (url) => ({ status: 200, headers: {}, finalUrl: url, text: READY_HTML }),
    });
    check('resolve() returns the full contract',
      r.provider === 'rapidgator' &&
      Array.isArray(r.media) && r.media.length === 1 &&
      Array.isArray(r.pickerVideos) && r.pickerVideos.length === 1 &&
      r.canonicalUrl === PAGE_URL && r.referer === PAGE_URL &&
      r.title === 'Big.Buck.Bunny.mkv' && r.size > 0);
  }

  console.log(`\nfilehost-resolver: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
