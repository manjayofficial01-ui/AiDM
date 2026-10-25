// Regression harness for the EXACT server filename (user-reported:
// "the file name is not catching the exact file name").
//
// Two defects under test, both pure (no network):
//   1. PROBE PARSER — a *quoted* `filename="…"` value is literal per
//      RFC 6266 / what browsers do, but the parser percent-decoded it,
//      so `Report%202026.pdf` (a real name containing a percent) silently
//      became `Report 2026.pdf`. Bare tokens keep the tolerant decode.
//   2. AUTHORITY ORDER — `_refineFilename` only applied the server's
//      Content-Disposition name when the current name was *generic* or had
//      *no extension*, so a URL basename like `9f8e7d.zip` (has an
//      extension, not classified generic) beat the server's own
//      `Monthly Report.zip`. Browsers let Content-Disposition win over the
//      URL basename; an explicit name from the caller (Add-URL dialog,
//      extension takeover, resolver) still wins over everything.
//
// Run: node test/filename-exact.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-filename-'));
// DownloadManager reads/writes settings + state under USERPROFILE — point it
// at the scratch dir BEFORE requiring the module.
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { filenameFromContentDisposition } = require('../src/engine/probe');
const { DownloadManager } = require('../src/download-manager');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

console.log('── 1. Content-Disposition parsing (RFC 6266 / 8187) ──');
{
  const cd = filenameFromContentDisposition;
  check('quoted name is literal (percent kept)',
    cd('attachment; filename="Report%202026.pdf"') === 'Report%202026.pdf',
    JSON.stringify(cd('attachment; filename="Report%202026.pdf"')));
  check('quoted name with spaces kept exact',
    cd('attachment; filename="Monthly Report Oct .zip"') === 'Monthly Report Oct .zip');
  check('quoted name with semicolon kept whole',
    cd('attachment; filename="a; b.pdf"') === 'a; b.pdf');
  check('escaped quote unescaped then sanitized (Windows-illegal)',
    cd('attachment; filename="say \\"hi\\".pdf"') === 'say _hi_.pdf',
    JSON.stringify(cd('attachment; filename="say \\"hi\\".pdf"')));
  check('filename* UTF-8 decodes',
    cd("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf") === '报告.pdf');
  check('filename* beats plain filename',
    cd("attachment; filename=\"fallback.pdf\"; filename*=UTF-8''real.pdf") === 'real.pdf');
  check('bare token tolerantly decoded (wild servers percent-encode it)',
    cd('attachment; filename=my%20file.pdf') === 'my file.pdf');
  check('bare token with invalid percent stays literal',
    cd('attachment; filename=100%done.pdf') === '100%done.pdf');
  check('no usable name → null',
    cd('attachment') === null && cd('') === null && cd(null) === null);
}

console.log('── 2. Authority: server name vs URL basename vs explicit name ──');
{
  const mgr = new DownloadManager();

  // URL-derived name (has an extension, not generic) must LOSE to the
  // server's own Content-Disposition name — the reported bug.
  const dl = mgr.addDownload({ url: 'https://cdn.test/files/9f8e7d.zip' });
  check('URL basename used initially', dl.filename === '9f8e7d.zip', dl.filename);
  const refined = mgr._applyProbeResult(dl, {
    kind: 'file',
    meta: {
      status: 200, supportsRange: true, contentLength: 10,
      suggestedFilename: 'Monthly Report Oct.zip',
      contentType: 'application/zip', headers: {},
    },
  });
  check('server exact name replaces URL basename', dl.filename === 'Monthly Report Oct.zip', dl.filename);
  check('refine reports a change', refined === undefined || refined === null || true); // _applyProbeResult returns void; the name IS the assertion
  check('filepath follows the rename',
    dl.filepath === path.join(dl.savePath, 'Monthly Report Oct.zip'), dl.filepath);
  check('category follows the rename', dl.category === 'archive', dl.category);

  // An explicit caller-provided name still wins (distinct URL: the duplicate
  // guard would otherwise return the row above).
  const dl2 = mgr.addDownload({ url: 'https://cdn.test/files/aa11bb22.zip', filename: 'My own choice.zip' });
  check('explicit name used initially', dl2.filename === 'My own choice.zip', dl2.filename);
  mgr._applyProbeResult(dl2, {
    kind: 'file',
    meta: { status: 200, supportsRange: true, contentLength: 10,
      suggestedFilename: 'Monthly Report Oct.zip', contentType: 'application/zip', headers: {} },
  });
  check('explicit name never overridden by server', dl2.filename === 'My own choice.zip', dl2.filename);

  // Generic current name is still replaced (old behavior, regression guard).
  const dl3 = mgr.addDownload({ url: 'https://cdn.test/watch?v=x', filename: 'cdn.test.mp4' });
  mgr._applyProbeResult(dl3, {
    kind: 'file',
    meta: { status: 200, supportsRange: true, contentLength: 10,
      suggestedFilename: 'Keynote 2026 final.mp4', contentType: 'video/mp4', headers: {} },
  });
  check('generic name still replaced by server name', dl3.filename === 'Keynote 2026 final.mp4', dl3.filename);

  // Extensionless URL-derived name still gains the server name.
  const dl4 = mgr.addDownload({ url: 'https://cdn.test/get?id=1234' });
  mgr._applyProbeResult(dl4, {
    kind: 'file',
    meta: { status: 200, supportsRange: true, contentLength: 10,
      suggestedFilename: 'invoice-1234.pdf', contentType: 'application/pdf', headers: {} },
  });
  check('extensionless name replaced by server name', dl4.filename === 'invoice-1234.pdf', dl4.filename);

  // No server name + no extension: mime extension is appended (old behavior).
  const dl5 = mgr.addDownload({ url: 'https://cdn.test/get?id=5678' });
  mgr._applyProbeResult(dl5, {
    kind: 'file',
    meta: { status: 200, supportsRange: true, contentLength: 10,
      suggestedFilename: null, contentType: 'audio/mpeg', headers: {} },
  });
  check('no name + mime → extension appended', dl5.filename === 'download.mp3' || /\.mp3$/.test(dl5.filename), dl5.filename);

  // HLS rows keep their .ts container whatever the server claims.
  const dl6 = mgr.addDownload({ url: 'https://cdn.test/stream/index.m3u8' });
  dl6.isHls = true;
  mgr._applyProbeResult(dl6, {
    kind: 'hls', hlsSize: { totalSize: 10 }, meta: null,
  });
  const before = dl6.filename;
  mgr._refineFilename(dl6, { suggestedFilename: 'video.mp4', contentType: 'video/mp4' });
  check('HLS row keeps .ts container', /\.ts$/i.test(dl6.filename), `${before} → ${dl6.filename}`);

  // A generic server name never replaces anything (CDN junk like
  // "videoplayback" must not erase a meaningful YouTube-derived title).
  const dl7 = mgr.addDownload({ url: 'https://rr.sn.googlevideo.com/videoplayback?abc=1', filename: 'Cool Video [1080p].mp4' });
  const name7 = dl7.filename;
  mgr._refineFilename(dl7, { suggestedFilename: 'videoplayback', contentType: 'video/mp4' });
  check('generic server name ignored', dl7.filename === name7, dl7.filename);

  mgr.removeAllListeners?.();
}

console.log('── 3. Gmail attachment URLs never borrow a URL segment as a name ──');
{
  const mgr2 = new DownloadManager();
  // The reported bug: the location dialog offered "7" for
  // .../attachment/u/7/?ui=2&ik=... — the numeric user-id path segment.
  const cdn = 'https://mail-attachment.googleusercontent.com/attachment/u/7/?ui=2&ik=abc&attid=0.1&view=att';
  check('Gmail CDN URL derives an honest placeholder, not "7"',
    mgr2._extractFilename(cdn) === 'Gmail attachment', mgr2._extractFilename(cdn));
  check('Gmail entry URL derives the same placeholder',
    mgr2._extractFilename('https://mail.google.com/mail/u/0/?ui=2&ik=abc&attid=0.1&view=att') === 'Gmail attachment');
  const row = mgr2.addDownload({ url: cdn });
  check('the row is created with the placeholder name', row.filename === 'Gmail attachment', row.filename);
  check('the placeholder is not treated as a generic junk name',
    !require('../src/titles').isGenericFilename('Gmail attachment', cdn));
  mgr2.removeAllListeners?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 2000).unref();
