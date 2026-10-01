// Single-use / one-shot signed attachment URLs must NOT be multi-probed.
//
// A Gmail attachment (mail-attachment.googleusercontent.com/…?…&saddbat=…) and
// the Drive usercontent endpoint carry a token that the first request spends.
// The browser fetches the file with ONE plain GET and works; AiDM's HEAD→Range
// →Range→plain-GET probe (up to four requests) consumes the token first, so the
// real download 400s — the exact "normal Chrome downloads it, AiDM 400s" bug.
//
// This proves two things:
//   1. isSingleUseTokenUrl() classifies the Gmail/Drive class correctly and
//      does NOT false-positive on ordinary / non-Google / non-http URLs.
//   2. DownloadManager._resolveFilename() SHORT-CIRCUITS for those URLs: it
//      returns a single-connection synthetic meta and never calls the network
//      probe (engine.probeMeta), so exactly one GET reaches the server.
//
// Run: node test/single-use-token.js
'use strict';

const assert = require('assert');
const { isSingleUseTokenUrl, hasSingleUseTokenParam } = require('../src/url-hygiene');
const { DownloadManager } = require('../src/download-manager');

let pass = 0, fail = 0;
const pending = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { pass++; console.log('  OK  ', name); },
        (e) => { fail++; console.log('  FAIL', name, '—', e.message); }
      ));
      return;
    }
    pass++; console.log('  OK  ', name);
  } catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
}

// The exact URL the user reported (truncated token, as pasted).
const GMAIL_SADDBAT = 'https://mail-attachment.googleusercontent.com/attachment/u/7/?ui=2&ik=376495d32f&attid=0.1&permmsgid=msg-f:1877767227827513920&th=1a0f2b5849876a40&view=att&disp=safe&realattid=f_muo771zz0&zw&saddbat=ANGjdJ-abc123';
const GMAIL_REALATTID = 'https://mail-attachment.googleusercontent.com/attachment/u/0/?ui=2&ik=x&attid=0.1&view=att&realattid=f_abc&zw';
const DRIVE_USERCONTENT = 'https://drive.usercontent.google.com/download?id=ABC&export=download&confirm=t';

console.log('── 1. isSingleUseTokenUrl classifier ──');
check('matches Gmail attachment URL with saddbat token', () => {
  assert.strictEqual(isSingleUseTokenUrl(GMAIL_SADDBAT), true);
});
check('matches Gmail attachment realattid + view=att', () => {
  assert.strictEqual(isSingleUseTokenUrl(GMAIL_REALATTID), true);
});
check('matches Drive usercontent download endpoint', () => {
  assert.strictEqual(isSingleUseTokenUrl(DRIVE_USERCONTENT), true);
});

const NEGATIVES = [
  ['ordinary pdf', 'https://example.com/invoice.pdf'],
  ['drive web page (resolved by resolver, not a one-shot token)', 'https://drive.google.com/uc?export=download&id=ABC'],
  ['youtube', 'https://youtube.com/watch?v=abc'],
  ['gcs bucket (token valid for a window, not single-shot)', 'https://storage.googleapis.com/bucket/file.zip'],
  ['non-http', 'ftp://host/file'],
  ['empty', ''],
  ['null', null],
  ['azure sas (multi-use within expiry)', 'https://host.blob.core.windows.net/c?sig=Z&se=2026-12-31'],
  ['aws s3 presigned (multi-use within expiry)', 'https://bucket.s3.amazonaws.com/x?X-Amz-Signature=Z'],
];
NEGATIVES.forEach(([label, u]) => {
  check('does NOT match ' + label, () => {
    assert.strictEqual(isSingleUseTokenUrl(u), false, 'url: ' + String(u).slice(0, 50));
  });
});
check('hasSingleUseTokenParam catches saddbat on any host', () => {
  assert.strictEqual(hasSingleUseTokenParam('https://x.test/y?a=1&saddbat=ZZ'), true);
  assert.strictEqual(hasSingleUseTokenParam('https://x.test/y?a=1'), false);
});

console.log('── 2. manager skips the network probe for single-use tokens ──');
check('Gmail attachment: short-circuits to single-connection, probeMeta never called', () => {
  let probeCalled = false;
  const mgr = {
    emits: [],
    emit(ev) { this.emits.push(ev); },
    engine: {
      probeMeta() {
        probeCalled = true;
        throw new Error('probeMeta must NOT be called for single-use tokens');
      },
    },
  };
  const download = {
    id: 'dl-g', url: GMAIL_SADDBAT, filename: 'my-invoice.pdf', status: 'downloading',
    headers: {}, _nameResolved: false, downloaded: 0, isHls: false, isDash: false,
    singleConnection: false, resumable: true,
  };
  return DownloadManager.prototype._resolveFilename.call(mgr, download, {}).then((meta) => {
    assert.strictEqual(probeCalled, false, 'probeMeta must not be invoked');
    assert.strictEqual(download._nameResolved, true, 'row marked name-resolved');
    assert.strictEqual(download.singleConnection, true, 'row forced to single connection');
    assert.strictEqual(download.resumable, false, 'row marked non-resumable');
    assert.ok(meta && meta.singleConnection === true, 'meta carries singleConnection:true');
    assert.strictEqual(meta.status, 200, 'meta status 200');
    assert.ok(mgr.emits.includes('download-updated'), 'emits download-updated');
    // The browser (extension) already supplied the real filename; it must be kept.
    assert.strictEqual(download.filename, 'my-invoice.pdf', 'browser-supplied filename preserved');
  });
});
check('ordinary URL still probes (path NOT short-circuited)', () => {
  let probeCalled = false;
  const mgr = {
    emits: [],
    emit() {},
    _persistDownloads() {},
    _processQueue() {},
    _applyProbeResult() {},
    _enforceProbeGuards() { return null; },
    downloads: { has() { return true; } },
    engine: {
      probeMeta() {
        probeCalled = true;
        return Promise.resolve({ kind: 'file', meta: { status: 200, contentLength: 10 }, hlsSize: null });
      },
    },
  };
  const download = {
    id: 'dl-o', url: 'https://example.com/invoice.pdf', filename: 'invoice.pdf', status: 'downloading',
    headers: {}, _nameResolved: false, downloaded: 0, isHls: false, isDash: false,
    singleConnection: false, resumable: true,
  };
  return DownloadManager.prototype._resolveFilename.call(mgr, download, {}).then(() => {
    assert.strictEqual(probeCalled, true, 'probeMeta must be invoked for ordinary URLs');
    assert.strictEqual(download.singleConnection, false, 'ordinary url stays multi-connection');
  });
});

(async () => {
  await Promise.all(pending);
  console.log(`\nsingle-use-token: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
