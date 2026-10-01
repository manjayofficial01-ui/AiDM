// Auth-wall / session-resilience detection (src/auth-wall.js).
//
// The dominant 2025-26 failure mode for download managers is the "server handed
// us a login page, not the file" case: with no / expired session cookie, hosts
// 302 to a sign-in endpoint and serve 200 HTML. AiDM used to write that page
// to disk as e.g. invoice.pdf — a green row, 100%, silently wrong. This module
// is the guard; it must be pure (headers-only, no network) and regression-tested
// so a detection regression can't sneak a login page into a user's downloads.
//
// Run: node test/auth-wall.js
'use strict';

const {
  looksLikeAuthWall,
  sessionExpiredMessage,
  extensionOfUrl,
  extensionOfFilename,
  AUTH_HOST_RE,
  AUTH_PATH_RE,
  BINARY_EXTENSIONS,
} = require('../src/auth-wall');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}

console.log('── 1. explicit redirect to a sign-in endpoint ──');
{
  check('Google ServiceLogin redirect',
    looksLikeAuthWall({ finalUrl: 'https://accounts.google.com/ServiceLogin?continue=…', contentType: 'text/html' }) === true);
  check('Microsoft login host',
    looksLikeAuthWall({ finalUrl: 'https://login.microsoftonline.com/…', contentType: 'text/html' }) === true);
  check('Dropbox login host',
    looksLikeAuthWall({ finalUrl: 'https://www.dropbox.com/login?…', contentType: 'text/html' }) === true);
  check('generic /sso path on any host',
    looksLikeAuthWall({ finalUrl: 'https://files.example.com/sso?next=…', contentType: 'text/html' }) === true);
  check('generic /signin path',
    looksLikeAuthWall({ finalUrl: 'https://cdn.example.org/signin', contentType: 'text/html' }) === true);
  check('OAuth authorize endpoint',
    looksLikeAuthWall({ finalUrl: 'https://auth.example.com/oauth2/authorize?…', contentType: 'text/html' }) === true);
}

console.log('── 2. silent case: HTML where a binary was expected ──');
{
  // The dangerous one — no redirect to a known auth host, just text/html for a
  // file the user asked for by a binary extension.
  check('HTML for a .pdf request is flagged',
    looksLikeAuthWall({ finalUrl: 'https://drive.google.com/file/d/ABC/view', contentType: 'text/html', filename: 'invoice.pdf' }) === true);
  check('HTML for a .zip request is flagged',
    looksLikeAuthWall({ finalUrl: 'https://share.example.com/x', contentType: 'text/html', filename: 'archive.zip' }) === true);
  check('HTML for a .mp4 request is flagged',
    looksLikeAuthWall({ finalUrl: 'https://v.example.com/watch', contentType: 'text/html', filename: 'clip.mp4' }) === true);
  check('text/html for a .html URL is NOT flagged (it is a page, as asked)',
    looksLikeAuthWall({ finalUrl: 'https://example.com/report.html', contentType: 'text/html', filename: 'report.html' }) === false);
}

console.log('── 3. legitimate responses are NOT flagged ──');
{
  check('real PDF content-type, no auth host',
    looksLikeAuthWall({ finalUrl: 'https://example.com/invoice.pdf', contentType: 'application/pdf' }) === false);
  check('real image content-type',
    looksLikeAuthWall({ finalUrl: 'https://example.com/a.png', contentType: 'image/png' }) === false);
  check('unknown content-type but binary extension and no auth redirect',
    looksLikeAuthWall({ finalUrl: 'https://example.com/x', contentType: 'application/octet-stream', filename: 'data.bin' }) === false);
  check('empty meta is safe',
    looksLikeAuthWall({}) === false);
  check('auth host but real binary content-type (e.g. a direct asset on login host)',
    looksLikeAuthWall({ finalUrl: 'https://login.example.com/static/logo.png', contentType: 'image/png' }) === false);
}

console.log('── 4. message + helpers ──');
{
  const msg = sessionExpiredMessage();
  check('message is actionable (mentions browser/login)',
    typeof msg === 'string' && /browser/i.test(msg) && /login/i.test(msg));
  check('message names the session cookie', /cookie/i.test(msg));
  check('extensionOfUrl parses extension', extensionOfUrl('https://x.com/a/b/invoice.PDF') === 'pdf');
  check('extensionOfFilename parses extension', extensionOfFilename('my movie.MP4') === 'mp4');
  check('AUTH_HOST_RE is a populated array', Array.isArray(AUTH_HOST_RE) && AUTH_HOST_RE.length > 0);
  check('AUTH_PATH_RE is a populated array', Array.isArray(AUTH_PATH_RE) && AUTH_PATH_RE.length > 0);
  check('BINARY_EXTENSIONS covers common types',
    BINARY_EXTENSIONS.has('pdf') && BINARY_EXTENSIONS.has('zip') && BINARY_EXTENSIONS.has('mp4'));
}

console.log(`\nauth-wall: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
