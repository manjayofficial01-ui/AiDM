'use strict';

const {
  isMetalinkSource,
  isSafeHttpUrl,
  parseMetalinkDocument,
} = require('../src/metalink');

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

const doc = `<?xml version="1.0" encoding="UTF-8"?>
<metalink xmlns="urn:ietf:params:xml:ns:metalink" version="4.0">
  <dynamic>false</dynamic>
  <file name="/remote/video &amp; more.mp4">
    <length>1048576</length>
    <hash type="sha-256">${'a'.repeat(64)}</hash>
    <url priority="10">https://slow.example/video.mp4</url>
    <url priority="1">https://fast.example/video.mp4</url>
    <url>file:///C:/secret.mp4</url>
    <url>https://user:pass@evil.example/video.mp4</url>
  </file>
  <file name="archive.zip">
    <url type="feed">https://mirror.example/archive.zip</url>
  </file>
</metalink>`;
const parsed = parseMetalinkDocument(doc);
check('Metalink v4 preserves file entries', parsed.files.length === 2);
check('unsafe and credential-bearing URLs are dropped', parsed.files[0].urls.length === 2 && parsed.files[0].urls[0] === 'https://fast.example/video.mp4');
check('URL priority is honored', parsed.files[0].urls.join() === 'https://fast.example/video.mp4,https://slow.example/video.mp4');
check('entities decode into the filename', parsed.files[0].filename === 'video & more.mp4');
check('metadata size and checksum normalize', parsed.files[0].size === 1048576 && parsed.files[0].checksum.algorithm === 'sha256');
check('dynamic flag is parsed', parsed.dynamic === false);
check('file without a usable HTTP URL is rejected', parsed.files[1].urls.join() === 'https://mirror.example/archive.zip');

const v3 = '<metalink><file name="v3.bin"><url>http://a.invalid/v3.bin</url><hash>0123456789abcdef0123456789abcdef</hash></file></metalink>';
check('Metalink v3 is accepted', parseMetalinkDocument(v3).files[0].checksum.value === '0123456789abcdef0123456789abcdef');

check('Metalink URL extension detection', isMetalinkSource('https://x.invalid/file.meta4') && isMetalinkSource('https://x.invalid/file.metalink?token=x'));
check('Metalink content-type detection', isMetalinkSource('https://x.invalid/download', 'application/metalink4+xml; charset=utf-8'));
check('normal file URL is not Metalink', isMetalinkSource('https://x.invalid/file.mp4', 'video/mp4') === false);
check('URL helper only accepts http/https', isSafeHttpUrl('https://good.invalid') && !isSafeHttpUrl('file:///bad') && !isSafeHttpUrl('https://u:p@good.invalid'));

check('oversized documents are rejected', (() => {
  try {
    parseMetalinkDocument('<metalink><file name="x"><url>' + 'a'.repeat(3 * 1024 * 1024) + '</url></file></metalink>');
    return false;
  } catch (err) {
    return /too large/i.test(err.message);
  }
})());
check('DTD/entity declarations are rejected', (() => {
  try {
    parseMetalinkDocument('<!DOCTYPE metalink><metalink></metalink>');
    return false;
  } catch (err) {
    return /not allowed/i.test(err.message);
  }
})());
check('non-Metalink XML is rejected', (() => {
  try {
    parseMetalinkDocument('<rss></rss>');
    return false;
  } catch (err) {
    return /not a metalink/i.test(err.message);
  }
})());
check('too many files are rejected', (() => {
  const many = '<metalink>' + Array.from({ length: 1001 }, (_, i) => `<file name="f${i}"><url>https://x.invalid/f${i}</url></file>`).join('') + '</metalink>';
  try {
    parseMetalinkDocument(many);
    return false;
  } catch (err) {
    return /too many/i.test(err.message);
  }
})());
check('pieces metadata is retained for future repair', parseMetalinkDocument(`<metalink><file name="p.bin"><pieces type="sha-256" length="1024"><hash>${'1'.repeat(64)}</hash><hash>${'2'.repeat(64)}</hash></pieces><url>https://x.invalid/p.bin</url></file></metalink>`).files[0].pieces.hashes.length === 2);

console.log(`\nmetalink: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
