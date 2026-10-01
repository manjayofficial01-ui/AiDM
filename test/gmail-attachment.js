// Regression harness for "Download failed: Server responded with HTTP 400"
// on a Gmail PDF attachment, plus the two failure modes it exposed:
//
//   1. An HTML-escaped link. Read out of rendered markup, Gmail's attachment
//      URL carries `&amp;` instead of `&`. Google then sees ONE parameter
//      (`ui=2&amp;ik=…`) — no attid, no view — and answers a parameter-
//      validation failure with HTTP 400. Browsers never see it because
//      getAttribute('href') is already decoded. The video resolvers did this;
//      the plain-file path (paste / HTTP API / clipboard / NL) never did.
//   2. A missing session. With no cookie Google does not 400 — it 302s to
//      accounts.google.com and serves 200 HTML, which AiDM used to write to
//      disk as "invoice.pdf". A green row holding a login page is worse than
//      an error, so that is now detected and reported (src/auth-wall.js).
//
// Also covers the Google Drive confirm-token flow (src/google-drive-resolver.js)
// and the new probe retry (429/503 during probe used to be terminal).
//
// Run: node test/gmail-attachment.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}

const { sanitizeEntryUrl, decodeAmpEntities, entryUrlWasRepaired } = require('../src/url-hygiene');
const { looksLikeAuthWall, sessionExpiredMessage } = require('../src/auth-wall');
const drive = require('../src/google-drive-resolver');
const { probeRemote } = require('../src/engine/probe');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-gmail-'));

// The shape Gmail's DOM yields when read as markup rather than as an href.
const GMAIL_RAW = 'https://mail.google.com/mail/u/0/?ui=2&amp;ik=ABC123&amp;attid=0.1' +
  '&amp;permmsgid=msg-a:r-998877&amp;th=1a2b3c&amp;view=att&amp;disp=inline' +
  '&amp;realattid=f_lz1abc0&amp;zw';
const GMAIL_CLEAN = GMAIL_RAW.replace(/&amp;/g, '&');

// ── 1. URL hygiene ──────────────────────────────────────────────────────────
console.log('── 1. URL hygiene (the HTTP 400 root cause) ──');
{
  check('decodes &amp; back to &', sanitizeEntryUrl(GMAIL_RAW) === GMAIL_CLEAN);
  check('preserves the empty-valued trailing &zw',
    sanitizeEntryUrl(GMAIL_RAW).endsWith('&zw'), sanitizeEntryUrl(GMAIL_RAW).slice(-24));
  check('recovers every Gmail parameter', ['ui=2', 'ik=ABC123', 'attid=0.1', 'view=att', 'realattid=f_lz1abc0']
    .every(p => sanitizeEntryUrl(GMAIL_RAW).includes(p)));

  check('a clean URL is left byte-identical',
    sanitizeEntryUrl('https://files.example.com/a/b.pdf?x=1&y=2#z') === 'https://files.example.com/a/b.pdf?x=1&y=2#z');
  check('numeric entity &#38; decoded too', decodeAmpEntities('a?x=1&#38;y=2') === 'a?x=1&y=2');
  check('hex entity &#x26; decoded too', decodeAmpEntities('a?x=1&#x26;y=2') === 'a?x=1&y=2');
  check('double-escaped &amp;amp; handled', decodeAmpEntities('a?x=1&amp;amp;y=2') === 'a?x=1&y=2');

  // Percent-escapes must survive: decoding them would change the wire bytes.
  check('percent-escaped %26 is NOT touched',
    sanitizeEntryUrl('https://x.com/f?a=b%26c') === 'https://x.com/f?a=b%26c');

  check('strips wrapping quotes and parens',
    sanitizeEntryUrl('  ("https://x.com/f.pdf?a=1")  ') === 'https://x.com/f.pdf?a=1');
  check('strips invisible/zero-width characters',
    sanitizeEntryUrl('https://x.com/f.pdf?a=1\u200b&b=2\ufeff') === 'https://x.com/f.pdf?a=1&b=2');
  check('joins a link wrapped across lines',
    sanitizeEntryUrl('https://x.com/f.pdf?a=\n1&b=2') === 'https://x.com/f.pdf?a=1&b=2');
  check('non-string input yields empty string', sanitizeEntryUrl(null) === '' && sanitizeEntryUrl(42) === '');
  check('repair detection is quiet for clean input', entryUrlWasRepaired(GMAIL_CLEAN) === false);
  check('repair detection fires for escaped input', entryUrlWasRepaired(GMAIL_RAW) === true);
}

// ── 2. The repair is actually wired into the single add choke point ──────────
console.log('── 2. addDownload applies hygiene (real manager) ──');
{
  const settingsDir = TMP;
  fs.writeFileSync(path.join(settingsDir, '.aidm_settings.json'),
    JSON.stringify({ autoResume: false, defaultSegments: 1 }, null, 2));
  const previousHome = process.env.USERPROFILE;
  process.env.USERPROFILE = settingsDir;
  try {
    const { DownloadManager } = require('../src/download-manager');
    const dm = new DownloadManager();
    const row = dm.addDownload({ url: GMAIL_RAW, filename: 'invoice.pdf' });
    check('stored URL is the decoded one', row.url === GMAIL_CLEAN, row.url.slice(0, 60) + '…');
    check('stored URL still ends with &zw', String(row.url).endsWith('&zw'));
    check('attid survives into the stored URL', String(row.url).includes('attid=0.1'));
    dm.engine.cancelDownload && dm.engine.cancelDownload(row.id);
  } finally {
    process.env.USERPROFILE = previousHome;
  }
}

// ── 3. Auth-wall detection ──────────────────────────────────────────────────
console.log('── 3. auth-wall detection (the silent "saved login page" bug) ──');
{
  check('accounts.google.com is an auth wall',
    looksLikeAuthWall({ finalUrl: 'https://accounts.google.com/ServiceLogin?continue=x', contentType: 'text/html' }));
  check('/ServiceLogin path is an auth wall',
    looksLikeAuthWall({ finalUrl: 'https://mail.google.com/accounts/ServiceLogin?x=1', contentType: 'text/html' }));
  check('HTML where a PDF was expected is an auth wall',
    looksLikeAuthWall({ finalUrl: 'https://mail.google.com/mail/u/0/?ui=2', contentType: 'text/html', filename: 'invoice.pdf' }));
  check('HTML where a ZIP was expected is an auth wall',
    looksLikeAuthWall({ finalUrl: 'https://drive.google.com/x', contentType: 'text/html', filename: 'photos.zip' }));

  check('a real PDF response is NOT an auth wall',
    !looksLikeAuthWall({ finalUrl: 'https://files.example.com/invoice.pdf', contentType: 'application/pdf', filename: 'invoice.pdf' }));
  check('deliberately downloading an .html page is NOT an auth wall',
    !looksLikeAuthWall({ finalUrl: 'https://example.com/index.html', contentType: 'text/html', filename: 'index.html' }));
  check('an HTML page without a binary extension is NOT an auth wall',
    !looksLikeAuthWall({ finalUrl: 'https://example.com/download', contentType: 'text/html', filename: 'download' }));
  check('empty meta is NOT an auth wall', !looksLikeAuthWall({}) && !looksLikeAuthWall(null));

  const msg = sessionExpiredMessage();
  check('auth-wall message explains what to do', /login/i.test(msg) && /browser/i.test(msg), msg.slice(0, 48) + '…');
}

// ── 4. Google Drive confirm-token flow ──────────────────────────────────────
console.log('── 4. Google Drive / Gmail-hosted file resolution ──');
{
  check('share URL recognised', drive.isGoogleDriveUrl('https://drive.google.com/file/d/ABC123def456/view?usp=sharing'));
  check('open?id= URL recognised', drive.isGoogleDriveUrl('https://drive.google.com/open?id=ABC123def456'));
  check('uc?export=download URL recognised', drive.isGoogleDriveUrl('https://docs.google.com/uc?id=ABC123def456&export=download'));
  check('non-Google URL not recognised', !drive.isGoogleDriveUrl('https://files.example.com/invoice.pdf'));
  check('already-direct endpoint not re-resolved',
    !drive.isGoogleDriveUrl('https://drive.usercontent.google.com/download?id=ABC123def456&export=download&confirm=t'));
  check('folder links refused', !drive.isGoogleDriveUrl('https://drive.google.com/drive/folders/ABC123def456'));
  check('file id extracted', drive.extractDriveFileId('https://drive.google.com/file/d/ABC123def456/view') === 'ABC123def456');
  check('direct endpoint uses drive.usercontent.google.com',
    drive.driveDirectUrl('XYZ') === 'https://drive.usercontent.google.com/download?id=XYZ&export=download&confirm=t');

  // Drive's real interstitial: a GET form of hidden inputs.
  const interstitial = '<!DOCTYPE html><html><head><title>Google Drive - Virus scan warning</title></head><body>' +
    '<form id="download-form" action="https://drive.usercontent.google.com/download?id=ABC&amp;export=download&amp;confirm=t" method="get">' +
    '<input type="hidden" name="id" value="ABC">' +
    '<input type="hidden" name="export" value="download">' +
    '<input type="hidden" name="confirm" value="t">' +
    '<input type="hidden" name="uuid" value="UUID-99">' +
    '<input type="submit" value="Download anyway"></form></body></html>';

  const form = drive.parseDriveConfirmForm(interstitial);
  check('confirm form parsed', !!form);
  check('form action recovered (entity-decoded)',
    form && form.action === 'https://drive.usercontent.google.com/download?id=ABC&export=download&confirm=t', form && form.action);
  check('hidden uuid field recovered', form && form.fields.uuid === 'UUID-99', form && JSON.stringify(form.fields));
  check('no form in ordinary HTML', drive.parseDriveConfirmForm('<html><body>hello</body></html>') === null);

  const follow = drive.confirmFormUrl({ action: 'https://drive.usercontent.google.com/download', fields: { uuid: 'U1', id: 'ABC' } }, 'ABC');
  check('follow-up URL carries uuid', follow.includes('uuid=U1'), follow);
  check('follow-up URL carries confirm=t', /[?&]confirm=t/.test(follow));
  check('follow-up URL carries export=download', follow.includes('export=download'));

  // RFC 8187: filename* wins and is percent-decoded.
  check('Content-Disposition filename parsed (RFC 8187 filename*)',
    drive.filenameFromDisposition('attachment;filename="Report 2026.pdf";filename*=UTF-8\'\'Report%202026.pdf') === 'Report 2026.pdf',
    String(drive.filenameFromDisposition('attachment;filename="Report 2026.pdf";filename*=UTF-8\'\'Report%202026.pdf')));
  check('plain filename= parsed when no filename*',
    drive.filenameFromDisposition('attachment; filename="invoice.pdf"') === 'invoice.pdf');

  // End-to-end against a Drive-mimicking stub transport.
  const seen = [];
  const stubFetch = async (url) => {
    seen.push(url);
    const mk = (headers, body) => ({
      url,
      headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
      text: async () => body,
      body: { cancel: async () => {} },
    });
    if (seen.length === 1) {
      return mk({ 'content-type': 'text/html; charset=utf-8' }, interstitial);
    }
    return mk({
      'content-type': 'application/pdf',
      'content-disposition': 'attachment;filename="Report 2026.pdf"',
      'content-length': '48231',
    }, '');
  };

  const DRIVE_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  drive.resolveGoogleDriveUrl(`https://drive.google.com/file/d/${DRIVE_ID}/view`, { fetchImpl: stubFetch })
    .then((r) => {
      check('interstitial followed with a second request', seen.length === 2, `${seen.length} requests`);
      check('resolved URL carries the confirm uuid', String(r.url).includes('uuid=UUID-99'));
      check('real filename recovered from Content-Disposition', r.filename === 'Report 2026.pdf', String(r.filename));
      check('size recovered', r.contentLength === 48231, String(r.contentLength));

      // A file Drive serves outright needs no second hop.
      const seen2 = [];
      const directFetch = async (url) => {
        seen2.push(url);
        return {
          url,
          headers: {
            get: (n) => ({
              'content-type': 'application/pdf',
              'content-disposition': 'attachment;filename="plain.pdf"',
              'content-length': '100',
            })[String(n).toLowerCase()] ?? null,
          },
          text: async () => '',
          body: { cancel: async () => {} },
        };
      };
      return drive.resolveGoogleDriveUrl(`https://drive.google.com/open?id=${DRIVE_ID}`, { fetchImpl: directFetch })
        .then((r2) => {
          check('already-served file resolves in one hop', seen2.length === 1, `${seen2.length} requests`);
          check('single-hop filename', r2.filename === 'plain.pdf', String(r2.filename));
        });
    })
    .then(() => {
      // ── 5. Probe retry ────────────────────────────────────────────────────
      console.log('── 5. probe retry for transient statuses ──');
      const stubRes = (status, headers = {}) => {
        const lower = {};
        for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
        return { status, headers: { get: (n) => lower[String(n).toLowerCase()] ?? null }, url: 'http://x/', body: { cancel: async () => {} } };
      };

      let calls = 0;
      const flaky = async () => {
        calls++;
        if (calls < 3) return stubRes(503);
        return stubRes(200, { 'content-length': '4096', 'content-type': 'application/pdf' });
      };
      return probeRemote('http://cdn.example/f.pdf', { headers: {}, fetchImpl: flaky, timeoutMs: 5000 })
        .then((info) => {
          check('probe retried past a 503', calls === 3, `${calls} attempts`);
          check('probe succeeded on the third try', info.size === 4096, String(info.size));
        })
        .then(() => {
          let n429 = 0;
          const limited = async () => {
            n429++;
            return stubRes(429, { 'retry-after': '0' });
          };
          return probeRemote('http://cdn.example/f.pdf', { headers: {}, fetchImpl: limited, timeoutMs: 5000 })
            .then(() => { check('persistent 429 still fails', false, 'expected throw'); })
            .catch((e) => {
              check('persistent 429 still fails (with bounded attempts)', /HTTP 429/.test(e.message), `${n429} attempts`);
              check('429 attempts bounded at 3', n429 === 3, `${n429}`);
            });
        })
        .then(() => {
          // 400 must NOT be retried — the existing plain-GET fallback handles
          // it, and retrying a bad request just burns time.
          let n400 = 0;
          const bad = async () => { n400++; return stubRes(400); };
          return probeRemote('http://cdn.example/f.pdf', { headers: {}, fetchImpl: bad, timeoutMs: 5000 })
            .catch((e) => {
              check('400 still surfaces as HTTP 400', /HTTP 400/.test(e.message), e.message);
              check('400 was not retried in a loop', n400 <= 2, `${n400} attempts`);
            });
        });
    })
    .then(() => {
      // ── 6. batch endpoint forwards cookies ────────────────────────────────
      console.log('── 6. /api/batch cookie forwarding ──');
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
      check('batch passes cookies through to the router',
        /_routeDownload\(\{\s*url,\s*headers:\s*batchHeaders,\s*cookies:\s*parsed\.cookies\s*\}/.test(src));
      const mgr = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-manager.js'), 'utf8');
      check('addDownload applies entry URL hygiene', /entryUrlWasRepaired\(url\)/.test(mgr));
      check('auth-wall guard reached from the probe guards', /looksLikeAuthWall\(\{/.test(mgr));
    })
    .then(() => {
      console.log(`\ngmail-attachment: ${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
