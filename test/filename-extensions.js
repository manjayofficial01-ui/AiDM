'use strict';

const { DownloadManager } = require('../src/download-manager');
const { specificUrlBasename } = require('../src/titles');
const { filenameFromContentDisposition, extFromMime, ensureExtension } = require('../src/engine/probe');

let pass = 0;
let fail = 0;
function check(name, condition, extra) {
  if (condition) {
    pass++;
    console.log('  OK  ', name, extra === undefined ? '' : `(${extra})`);
  } else {
    fail++;
    console.log('  FAIL', name, extra === undefined ? '' : `(${extra})`);
  }
}

check('MIME table recognizes images and installers', extFromMime('image/png') === 'png' && extFromMime('application/vnd.android.package-archive') === 'apk' && extFromMime('application/x-msdownload; charset=binary') === 'exe');
check('opaque MIME types are never invented', extFromMime('application/octet-stream') === null && extFromMime('') === null);
check('ensureExtension adds only what Content-Type proves', ensureExtension('invoice', 'application/pdf') === 'invoice.pdf' && ensureExtension('photo', 'image/webp') === 'photo.webp');
check('existing compound extensions are preserved', ensureExtension('release.tar.gz', 'application/gzip') === 'release.tar.gz' && ensureExtension('data.csv', 'text/plain') === 'data.csv');
check('extensionless name without Content-Type remains untouched', ensureExtension('video', '') === 'video');

check('quoted filename* is decoded without a trailing quote', filenameFromContentDisposition('attachment; filename*="UTF-8\'\'resume%202026.pdf"') === 'resume 2026.pdf');
check('single-quoted filename is accepted', filenameFromContentDisposition("attachment; filename='single.pdf'") === 'single.pdf');
check('extensionless server filename survives parsing', filenameFromContentDisposition('attachment; filename="Invoice Q4"') === 'Invoice Q4');
check('version numbers are not mistaken for extensions', specificUrlBasename('https://example.test/releases/2.24') === null);
check('real containers with digits remain valid', specificUrlBasename('https://example.test/tool.7z') === 'tool.7z' && specificUrlBasename('https://example.test/app.docx') === 'app.docx');

function manager() {
  const m = Object.create(DownloadManager.prototype);
  m.settings = { defaultSavePath: 'D:\\Downloads', categoryPaths: {} };
  return m;
}

const refined = manager();
const row = {
  id: 'row',
  url: 'https://cdn.example.test/download?id=721',
  filename: 'download',
  category: 'other',
  savePath: 'D:\\Downloads',
};
const changed = refined._refineFilename(row, {
  suggestedFilename: 'Invoice Q4',
  contentType: 'application/pdf',
});
check('extensionless Content-Disposition name is used and completed from MIME', changed && row.filename === 'Invoice Q4.pdf', row.filename);
check('category follows the recovered extension', row.category === 'pdf', row.category);

const urlOnly = manager();
const guessedRow = { id: 'img', url: 'https://cdn.example.test/asset?id=99', filename: 'asset', savePath: 'D:\\Downloads', category: 'other' };
const guessed = urlOnly._refineFilename(guessedRow, { contentType: 'image/jpeg' });
check('extensionless URL asset becomes .jpg', guessed && guessedRow.filename === 'asset.jpg', guessedRow.filename);

const derived = manager();
const mediaName = derived._deriveFilename(
  'https://example.test/releases/2.24',
  null,
  { pageTitle: 'Firmware release', contentType: 'application/octet-stream' },
  { label: '1080p', format: 'mkv' },
);
check('quality container beats the bogus version-number extension', mediaName === 'Firmware release [1080p].mkv', mediaName);
const derivedImage = derived._deriveFilename(
  'https://example.test/files/88',
  null,
  { pageTitle: 'Product sheet', contentType: 'application/pdf' },
  null,
);
check('server Content-Type supplies the media-name extension', derivedImage === 'Product sheet.pdf', derivedImage);

const approved = manager();
approved.downloads = new Map([['approve-row', {
  id: 'approve-row', url: 'https://cdn.example.test/file', filename: 'original.pdf',
  category: 'pdf', savePath: 'D:\\Downloads', _probe: { contentType: 'application/pdf' },
}]]);
approved.queue = [];
approved.maxConcurrent = 0;
approved._persistDownloads = () => true;
approved._processQueue = () => {};
approved._startDownload = () => {};
const approvedResult = approved.approveDownload('approve-row', 'D:\\Downloads', 'invoice');
check('user-typed extensionless name gets its proven container', approvedResult.filename === 'invoice.pdf', approvedResult.filename);
check('typing a name still preserves user authority', approvedResult._userNamed === true);

console.log(`\nfilename-extensions: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
