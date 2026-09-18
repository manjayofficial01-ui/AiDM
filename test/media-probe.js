// Regression harness for TRUE media geometry (src/media-probe.js).
//
// Why this exists: AiDM used to guess video dimensions from quality labels,
// URL text and the playing <video> element's render size. That is why a 360p
// file displayed as 2160p and why every row on a page showed the same
// resolution. These fixtures are hand-built byte-for-byte (no external deps,
// no real media files) so the suite locks down:
//   • real ISO-BMFF box walking (moov before AND after mdat, 16.16 tkhd,
//     stsd visual-sample width/height winning over tkhd)
//   • the "downloaded video with no sound" signal: no `soun` track ⇒
//     hasAudio false — the regression that produced silent downloads
//   • real EBML/Matroska parsing (Pixel/Display width, TrackType, vint sizes,
//     unknown-size elements)
//   • MPEG-TS PAT → PMT stream types (video-only ⇒ hasAudio false, 0x0 dims)
//   • probeUrl never downloads a whole file and never throws
//   • NEVER inventing a dimension: garbage ⇒ null, unproven ⇒ 0x0
//
// Run: node test/media-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert');

const probe = require('../src/media-probe');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, actual === expected ? '' : `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders — every byte below is written on purpose.
// ─────────────────────────────────────────────────────────────────────────────

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function tag(s) { return Buffer.from(String(s), 'latin1'); }

function box(type, ...parts) {
  const payload = Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : tag(p))));
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(8 + payload.length, 0);
  out.write(type, 4, 4, 'latin1');
  payload.copy(out, 8);
  return out;
}

// VisualSampleEntry: width/height are uint16 at +32/+34 of the entry.
function avc1Entry(w, h) {
  const size = 86;
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0);
  b.write('avc1', 4, 4, 'latin1');
  b.writeUInt16BE(1, 14);            // data_reference_index
  b.writeUInt16BE(w, 32);
  b.writeUInt16BE(h, 34);
  b.writeUInt32BE(0x00480000, 36);   // horizresolution 72dpi
  b.writeUInt32BE(0x00480000, 40);   // vertresolution
  b.writeUInt16BE(1, 48);            // frame_count
  b.writeUInt8(4, 50);
  b.write('aidm', 51, 4, 'latin1');  // compressorname
  b.writeUInt16BE(0x0018, 82);       // depth
  b.writeInt16BE(-1, 84);            // pre_defined = -1
  return b;
}

function mp4aEntry() {
  const size = 36;
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0);
  b.write('mp4a', 4, 4, 'latin1');
  b.writeUInt16BE(1, 14);            // data_reference_index
  b.writeUInt16BE(0, 16);            // version
  b.writeUInt16BE(0, 18);            // revision
  b.writeUInt32BE(0, 20);            // vendor
  b.writeUInt16BE(2, 24);            // channelcount
  b.writeUInt16BE(16, 26);           // samplesize
  b.writeUInt32BE((48000 << 16) >>> 0, 32); // samplerate 16.16
  return b;
}

// tkhd: width/height are the last two 32-bit fields — 16.16 fixed point.
function tkhdBox(trackId, w, h, volume, duration) {
  const b = Buffer.alloc(84);
  b[3] = 7;                                          // enabled | in movie | in preview
  b.writeUInt32BE(trackId, 12);
  b.writeUInt32BE(duration || 30000, 20);
  b.writeUInt16BE(volume || 0, 36);
  const unity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  unity.forEach((v, i) => b.writeUInt32BE(v >>> 0, 40 + i * 4));
  b.writeUInt32BE((w * 65536) >>> 0, 76);
  b.writeUInt32BE((h * 65536) >>> 0, 80);
  return box('tkhd', b);
}

function mdhdBox() {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(1000, 12);       // timescale
  b.writeUInt32BE(30000, 16);      // duration
  b.writeUInt16BE(0x55c4, 20);     // language 'und'
  return box('mdhd', b);
}

function hdlrBox(handlerType, name) {
  const b = Buffer.alloc(24 + name.length);
  b.write(handlerType, 8, 4, 'latin1');
  b.write(name, 24, name.length, 'latin1');
  return box('hdlr', b);
}

function stblBox(entry) {
  return box(
    'stbl',
    box('stsd', u32(0), u32(1), entry),
    box('stts', u32(0), u32(0)),
    box('stsc', u32(0), u32(0)),
    box('stsz', u32(0), u32(0), u32(0)),
    box('stco', u32(0), u32(0)),
  );
}

function trakBox(kind, w, h, trackId) {
  const isVideo = kind === 'video';
  const entry = isVideo ? avc1Entry(w, h) : mp4aEntry();
  const tkhd = tkhdBox(trackId, isVideo ? w : 0, isVideo ? h : 0, isVideo ? 0 : 0x0100);
  const mdia = box('mdia', mdhdBox(), hdlrBox(isVideo ? 'vide' : 'soun', isVideo ? 'VideoHandler' : 'SoundHandler'),
    box('minf', stblBox(entry)));
  return box('trak', tkhd, mdia);
}

function mvhdBox(timescale, duration, nextTrackId) {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(timescale || 1000, 12);
  b.writeUInt32BE(duration || 30000, 16);
  b.writeUInt32BE(0x00010000, 20);   // rate 1.0
  b.writeUInt16BE(0x0100, 24);       // volume 1.0
  const unity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  unity.forEach((v, i) => b.writeUInt32BE(v >>> 0, 36 + i * 4));
  b.writeUInt32BE(nextTrackId || 3, 96);
  return box('mvhd', b);
}

/**
 * @param {{ width:number, height:number, audio?:boolean, moovAfter?:boolean,
 *           stsdWidth?:number, stsdHeight?:number, mdatBytes?:number }} o
 */
function buildMp4(o) {
  const ftyp = box('ftyp', 'isom', u32(0x200), 'isom', 'iso2', 'avc1', 'mp41');
  const mdat = box('mdat', Buffer.alloc(o.mdatBytes || 2048, 0x5a));
  const sw = o.stsdWidth || o.width;
  const sh = o.stsdHeight || o.height;
  const tracks = [trakBox('video', sw, sh, 1)];
  if (o.audio !== false) tracks.push(trakBox('audio', 0, 0, 2));
  const moov = box('moov', mvhdBox(1000, 30000, tracks.length + 1), ...tracks);
  return o.moovAfter ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

function buildM4a() {
  const ftyp = box('ftyp', 'M4A ', u32(0x200), 'M4A ', 'mp42', 'isom');
  const moov = box('moov', mvhdBox(44100, 1323000, 2), trakBox('audio', 0, 0, 1));
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(512, 0x33))]);
}

// ── EBML ────────────────────────────────────────────────────────────────────

function vintSize(n, forcedLen) {
  for (let L = forcedLen || 1; L <= 8; L++) {
    if (forcedLen || n < Math.pow(2, 7 * L) - 1) {
      const out = Buffer.alloc(L);
      let v = n;
      for (let i = L - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
      out[0] |= 0x80 >> (L - 1);
      return out;
    }
  }
  return null;
}

function vintUnknown(len) {
  const out = Buffer.alloc(len);
  out.fill(0xff);
  out[0] = 0x80 >> (len - 1);
  if (len === 8) out[0] = 0x01;      // 0x01FFFFFFFFFFFFFF
  return out;
}

function euint(n) {
  let L = 1;
  while (n >= Math.pow(2, 8 * L) && L < 8) L++;
  const out = Buffer.alloc(L);
  let v = n;
  for (let i = L - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  return out;
}

function efloat(n) { const b = Buffer.alloc(8); b.writeDoubleBE(n, 0); return b; }
function estr(s) { return Buffer.from(s, 'utf8'); }

function eel(idBytes, payload, unknownLen) {
  const id = Buffer.from(idBytes);
  const size = unknownLen ? vintUnknown(unknownLen) : vintSize(payload.length);
  return Buffer.concat([id, size, payload]);
}

const E = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3], DocType: [0x42, 0x82], DocTypeVersion: [0x42, 0x87],
  Segment: [0x18, 0x53, 0x80, 0x67], Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1], Duration: [0x44, 0x89],
  Tracks: [0x16, 0x54, 0xae, 0x6b], TrackEntry: [0xae], TrackNumber: [0xd7],
  TrackType: [0x83], CodecID: [0x86], Video: [0xe0], PixelWidth: [0xb0],
  PixelHeight: [0xba], DisplayWidth: [0x54, 0xb0], DisplayHeight: [0x54, 0xba],
  Audio: [0xe1], Channels: [0x9f],
};

function ebmlHeader(docType) {
  return eel(E.EBML, Buffer.concat([
    eel([0x42, 0x86], euint(1)), eel([0x42, 0xf7], euint(1)),
    eel([0x42, 0xf2], euint(4)), eel([0x42, 0xf3], euint(8)),
    eel(E.DocType, estr(docType)), eel(E.DocTypeVersion, euint(4)),
  ]));
}

function mkTrackEntry(type, codecId, geom) {
  const kids = [eel(E.TrackNumber, euint(type)), eel(E.TrackType, euint(type)), eel(E.CodecID, estr(codecId))];
  if (type === 1) {
    const v = [];
    if (geom && geom.pixel) {
      v.push(eel(E.PixelWidth, euint(geom.w)), eel(E.PixelHeight, euint(geom.h)));
    }
    if (geom && geom.display) {
      v.push(eel(E.DisplayWidth, euint(geom.w)), eel(E.DisplayHeight, euint(geom.h)));
    }
    kids.push(eel(E.Video, Buffer.concat(v)));
  } else {
    kids.push(eel(E.Audio, Buffer.concat([eel(E.Channels, euint(2))])));
  }
  return eel(E.TrackEntry, Buffer.concat(kids));
}

/** @param {{ unknownSegment?:boolean, displayOnly?:boolean }} [o] */
function buildMkv(o) {
  const opts = o || {};
  const geom = { w: 1280, h: 720, pixel: !opts.displayOnly, display: true };
  const tracks = eel(E.Tracks, Buffer.concat([
    mkTrackEntry(1, 'V_MPEG4/ISO/AVC', geom),
    mkTrackEntry(2, 'A_AAC', null),
  ]));
  const info = eel(E.Info, Buffer.concat([
    eel(E.TimecodeScale, euint(1000000)),   // 1 ms
    eel(E.Duration, efloat(123500)),       // 123500 × 1 ms TimecodeScale = 123.5 s
  ]));
  const segPayload = Buffer.concat([info, tracks]);
  const segment = eel(E.Segment, segPayload, opts.unknownSegment ? 8 : 0);
  return Buffer.concat([ebmlHeader('matroska'), segment, Buffer.alloc(256, 0x7f)]);
}

// ── MPEG-TS ─────────────────────────────────────────────────────────────────

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] << 24;
    for (let k = 0; k < 8; k++) c = ((c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1)) >>> 0;
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE(c >>> 0, 0);
  return out;
}

function psiSection(tableId, body) {
  const len = body.length + 4;                       // + CRC32
  const head = Buffer.from([tableId, 0xb0 | ((len >> 8) & 0x0f), len & 0xff]);
  const section = Buffer.concat([head, body]);
  return Buffer.concat([section, crc32(section)]);
}

function patPayload(programNumber, pmtPid) {
  const b = Buffer.alloc(9);
  b.writeUInt16BE(1, 0);                             // transport_stream_id
  b[2] = 0xc1;                                       // version 0, current_next 1
  b.writeUInt16BE(programNumber, 5);
  b.writeUInt16BE(0xe000 | pmtPid, 7);
  return psiSection(0x00, b);
}

function pmtPayload(pcrPid, streams) {
  const es = Buffer.concat(streams.map(s => Buffer.from([
    s.type, 0xe0 | ((s.pid >> 8) & 0x1f), s.pid & 0xff, 0xf0, 0x00,
  ])));
  const b = Buffer.alloc(9 + es.length);
  b.writeUInt16BE(1, 0);                             // program_number
  b[2] = 0xc1;
  b.writeUInt16BE(0xe000 | pcrPid, 5);
  b.writeUInt16BE(0xf000, 7);                        // program_info_length = 0
  es.copy(b, 9);
  return psiSection(0x02, b);
}

function tsPacket(pid, payload, pusi, cc, raw) {
  const p = Buffer.alloc(188);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = 0x10 | (cc & 0x0f);                         // payload only, no adaptation
  const body = raw ? payload : Buffer.concat([Buffer.from([0x00]), payload]);
  assert.ok(body.length <= 184, 'TS payload too big');
  body.copy(p, 4);
  p.fill(0xff, 4 + body.length);                     // stuffing
  return p;
}

function buildTs(streams) {
  const PMT_PID = 0x1000;
  const parts = [
    tsPacket(0x0000, patPayload(1, PMT_PID), true, 0),
    tsPacket(PMT_PID, pmtPayload(0x0100, streams), true, 0),
  ];
  let cc = 0;
  for (const s of streams) {
    for (let i = 0; i < 3; i++) {
      parts.push(tsPacket(s.pid, Buffer.alloc(120, 0x11), i === 0, cc++ & 0x0f, true));
    }
  }
  return Buffer.concat(parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure helpers (the label/resolution table the UI reads)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nlabelForHeight buckets');
eq('2160', probe.labelForHeight(2160), '2160p');
eq('3840 (4k file, not 5k)', probe.labelForHeight(3840), '2160p');
eq('1440', probe.labelForHeight(1440), '1440p');
eq('1080', probe.labelForHeight(1080), '1080p');
eq('1079 falls to 720p', probe.labelForHeight(1079), '720p');
eq('720', probe.labelForHeight(720), '720p');
eq('480', probe.labelForHeight(480), '480p');
eq('360', probe.labelForHeight(360), '360p');
eq('240', probe.labelForHeight(240), '240p');
eq('144 falls through to Np', probe.labelForHeight(144), '144p');
eq('garbage height → null', probe.labelForHeight(NaN), null);
eq('null height → null', probe.labelForHeight(null), null);

console.log('\nresolutionForLabel table');
eq('2160p', probe.resolutionForLabel('2160p'), '3840x2160');
eq('1440p', probe.resolutionForLabel('1440p'), '2560x1440');
eq('1080p', probe.resolutionForLabel('1080p'), '1920x1080');
eq('720p', probe.resolutionForLabel('720p'), '1280x720');
eq('480p', probe.resolutionForLabel('480p'), '854x480');
eq('360p', probe.resolutionForLabel('360p'), '640x360');
eq('240p', probe.resolutionForLabel('240p'), '426x240');
eq('144p', probe.resolutionForLabel('144p'), '256x144');
eq('unknown label → null', probe.resolutionForLabel('4k'), null);
eq('empty label → null', probe.resolutionForLabel(''), null);

console.log('\nresolutionOf / hasAudio / hasVideo helpers');
eq('null info → null', probe.resolutionOf(null), null);
eq('zero dims → null (never invented)', probe.resolutionOf({ width: 0, height: 0 }), null);
eq('real dims', probe.resolutionOf({ width: 1920, height: 1080 }), '1920x1080');
eq('hasAudio(null) → false', probe.hasAudio(null), false);
eq('hasVideo(null) → false', probe.hasVideo(null), false);
eq('hasAudio reads the flag', probe.hasAudio({ hasAudio: true }), true);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Refuse to guess
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nUnusable input → null, never a guess');
eq('null buffer', probe.probeBuffer(null), null);
eq('empty buffer', probe.probeBuffer(Buffer.alloc(0)), null);
eq('garbage text', probe.probeBuffer(Buffer.from('<!doctype html><html><body>not a video</body></html>')), null);
eq('random bytes', probe.probeBuffer(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251))), null);
eq('a webm/ts/mp4-shaped lie (label only) is still null',
  probe.probeBuffer(Buffer.from('2160p|3840x2160|h264', 'utf8')), null);
eq('parseMp4 on garbage', probe.parseMp4(Buffer.alloc(1024, 0x41)), null);
eq('parseMatroska on garbage', probe.parseMatroska(Buffer.alloc(1024, 0x41)), null);
eq('parseMpegTs on garbage', probe.parseMpegTs(Buffer.alloc(1024, 0x41)), null);

// ─────────────────────────────────────────────────────────────────────────────
// 3. ISO-BMFF
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nMP4: moov before mdat, 1920x1080, avc1 + mp4a');
const mp4Both = buildMp4({ width: 1920, height: 1080, audio: true });
const both = probe.probeBuffer(mp4Both);
check('parsed', !!both, both ? `${both.width}x${both.height}` : 'null');
eq('width', both && both.width, 1920);
eq('height', both && both.height, 1080);
eq('resolutionOf', probe.resolutionOf(both), '1920x1080');
eq('label', probe.labelForHeight(both && both.height), '1080p');
eq('hasVideo', both && both.hasVideo, true);
eq('hasAudio', both && both.hasAudio, true);
eq('vcodec', both && both.vcodec, 'h264');
eq('acodec', both && both.acodec, 'aac');
eq('container', both && both.container, 'mp4');
eq('duration from mvhd (30000/1000)', both && both.durationSec, 30);
eq('bitrate unknown → 0', both && both.bitrateKbps, 0);

console.log('\nMP4: same video, audio track removed (the silent-download regression)');
const mp4VideoOnly = buildMp4({ width: 1920, height: 1080, audio: false });
const vOnly = probe.probeBuffer(mp4VideoOnly);
eq('still 1920x1080', probe.resolutionOf(vOnly), '1920x1080');
eq('hasVideo', vOnly && vOnly.hasVideo, true);
eq('hasAudio is FALSE (no soun track)', vOnly && vOnly.hasAudio, false);
eq('acodec is null', vOnly && vOnly.acodec, null);

console.log('\nMP4: moov AFTER mdat (streamed / non-faststart)');
const mp4Tail = buildMp4({ width: 1920, height: 1080, audio: true, moovAfter: true, mdatBytes: 8192 });
const tailInfo = probe.probeBuffer(mp4Tail);
eq('found trailing moov', probe.resolutionOf(tailInfo), '1920x1080');
eq('trailing moov still proves audio', tailInfo && tailInfo.hasAudio, true);

console.log('\nMP4: 360p must not be reported as 2160p');
const mp4_360 = buildMp4({ width: 640, height: 360, audio: true });
const p360 = probe.probeBuffer(mp4_360);
eq('resolutionOf', probe.resolutionOf(p360), '640x360');
eq('labelForHeight(360)', probe.labelForHeight(p360 && p360.height), '360p');
check('height is NOT 2160', p360.height !== 2160, 'h=' + p360.height);
check('label is NOT 2160p', probe.labelForHeight(p360.height) !== '2160p');

console.log('\nMP4: stsd sample-entry size wins over tkhd');
const mp4Mixed = buildMp4({ width: 1920, height: 1080, stsdWidth: 1280, stsdHeight: 720, audio: false });
eq('stsd 1280x720 beats tkhd 1920x1080', probe.resolutionOf(probe.probeBuffer(mp4Mixed)), '1280x720');

console.log('\nM4A: audio only');
const m4a = buildM4a();
const aOnly = probe.probeBuffer(m4a);
eq('hasAudio', aOnly && aOnly.hasAudio, true);
eq('hasVideo', aOnly && aOnly.hasVideo, false);
eq('width stays 0', aOnly && aOnly.width, 0);
eq('height stays 0', aOnly && aOnly.height, 0);
eq('resolutionOf → null', probe.resolutionOf(aOnly), null);
eq('acodec', aOnly && aOnly.acodec, 'aac');

// ─────────────────────────────────────────────────────────────────────────────
// 4. Matroska / WebM
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nMatroska: 1280x720 V_MPEG4/ISO/AVC + A_AAC');
const mkv = buildMkv();
const mkvInfo = probe.probeBuffer(mkv);
check('parsed', !!mkvInfo, mkvInfo ? `${mkvInfo.width}x${mkvInfo.height}` : 'null');
eq('width', mkvInfo && mkvInfo.width, 1280);
eq('height', mkvInfo && mkvInfo.height, 720);
eq('hasVideo', mkvInfo && mkvInfo.hasVideo, true);
eq('hasAudio', mkvInfo && mkvInfo.hasAudio, true);
eq('vcodec', mkvInfo && mkvInfo.vcodec, 'h264');
eq('acodec', mkvInfo && mkvInfo.acodec, 'aac');
eq('container', mkvInfo && mkvInfo.container, 'mkv');
eq('duration scaled by TimecodeScale', mkvInfo && Math.round(mkvInfo.durationSec), 124);

console.log('\nMatroska: unknown-size Segment + display-size-only track');
const mkvOdd = buildMkv({ unknownSegment: true, displayOnly: true });
const mkvOddInfo = probe.probeBuffer(mkvOdd);
eq('unknown-size element handled', probe.resolutionOf(mkvOddInfo), '1280x720');
eq('audio still proven', mkvOddInfo && mkvOddInfo.hasAudio, true);

// ─────────────────────────────────────────────────────────────────────────────
// 5. MPEG-TS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nMPEG-TS: video PID only');
const tsVideo = buildTs([{ type: 0x1b, pid: 0x0100 }]);
const tsInfo = probe.probeBuffer(tsVideo);
check('parsed', !!tsInfo, tsInfo ? `v=${tsInfo.hasVideo} a=${tsInfo.hasAudio}` : 'null');
eq('hasVideo', tsInfo && tsInfo.hasVideo, true);
eq('hasAudio', tsInfo && tsInfo.hasAudio, false);
eq('width stays 0 (TS header carries none)', tsInfo && tsInfo.width, 0);
eq('height stays 0', tsInfo && tsInfo.height, 0);
eq('resolutionOf → null', probe.resolutionOf(tsInfo), null);
eq('container', tsInfo && tsInfo.container, 'ts');
eq('vcodec', tsInfo && tsInfo.vcodec, 'h264');

console.log('\nMPEG-TS: video + audio PIDs');
const tsBoth = buildTs([{ type: 0x1b, pid: 0x0100 }, { type: 0x0f, pid: 0x0101 }]);
const tsBothInfo = probe.probeBuffer(tsBoth);
eq('hasVideo', tsBothInfo && tsBothInfo.hasVideo, true);
eq('hasAudio', tsBothInfo && tsBothInfo.hasAudio, true);
eq('acodec', tsBothInfo && tsBothInfo.acodec, 'aac');
eq('no invented geometry', probe.resolutionOf(tsBothInfo), null);

// ─────────────────────────────────────────────────────────────────────────────
// 6. probeFile (fs-backed)
// ─────────────────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-probe-'));
const written = {};

function write(name, buf) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, buf);
  written[name] = p;
  return p;
}

async function fileTests() {
  console.log('\nprobeFile');
  write('clip-1080.mp4', mp4Both);
  write('clip-360.mp4', mp4_360);
  write('clip-silent.mp4', mp4VideoOnly);
  write('song.m4a', m4a);
  write('clip.mkv', mkv);
  write('clip.ts', tsVideo);
  write('junk.mp4', Buffer.from('this is not a media file, it is 2160p honest', 'utf8'));

  const f1 = await probe.probeFile(written['clip-1080.mp4']);
  eq('reads real geometry from disk', probe.resolutionOf(f1), '1920x1080');
  eq('audio proven from disk', f1 && f1.hasAudio, true);

  const f2 = await probe.probeFile(written['clip-360.mp4']);
  eq('360p file stays 640x360', probe.resolutionOf(f2), '640x360');
  eq('...and is labelled 360p, not 2160p', probe.labelForHeight(f2 && f2.height), '360p');

  const f3 = await probe.probeFile(written['clip-silent.mp4']);
  eq('silent file: hasVideo', f3 && f3.hasVideo, true);
  eq('silent file: hasAudio FALSE', f3 && f3.hasAudio, false);

  const f4 = await probe.probeFile(written['song.m4a']);
  eq('m4a: hasVideo false', f4 && f4.hasVideo, false);
  eq('m4a: hasAudio true', f4 && f4.hasAudio, true);

  const f5 = await probe.probeFile(written['clip.mkv']);
  eq('mkv from disk', probe.resolutionOf(f5), '1280x720');

  const f6 = await probe.probeFile(written['clip.ts']);
  eq('ts from disk: hasVideo', f6 && f6.hasVideo, true);
  eq('ts from disk: no invented size', f6 && f6.width, 0);

  const f7 = await probe.probeFile(written['junk.mp4']);
  check('a non-media file yields null (or 0x0), never a guess',
    f7 === null || (f7.width === 0 && f7.height === 0), JSON.stringify(f7));

  eq('missing path → null', await probe.probeFile(path.join(TMP, 'nope.mp4')), null);
  eq('empty path → null', await probe.probeFile(''), null);
  eq('null path → null', await probe.probeFile(null), null);
  eq('a directory → null', await probe.probeFile(TMP), null);

  // Trailing moov: the head window must not contain it, only the last 2 MB.
  const bigTail = Buffer.concat([
    box('ftyp', 'isom', u32(0x200), 'isom', 'avc1'),
    box('mdat', Buffer.alloc(64 * 1024, 0x5a)),
    buildMp4({ width: 1920, height: 1080, audio: true }).slice(20),   // ftyp + moov + mdat tail
  ]);
  write('trailing-moov.mp4', bigTail);
  const f8 = await probe.probeFile(written['trailing-moov.mp4'], { maxBytes: 1024 });
  eq('moov at the end found via the tail read', probe.resolutionOf(f8), '1920x1080');

  console.log('\nffmpeg fallback');
  let ffmpegPath = null;
  try { ffmpegPath = require('../src/media-mux').resolveFfmpeg(); } catch (e) { ffmpegPath = null; }
  if (ffmpegPath) {
    const ff = await probe.probeFile(written['junk.mp4']);
    check('ffmpeg fallback never crashes on a non-media file', ff === null || typeof ff === 'object');
    console.log('  OK   ffmpeg available (' + path.basename(ffmpegPath) + ')');
    pass++;
  } else {
    console.log('  SKIP ffmpeg-static not installed — fallback path not exercised');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. probeUrl (injected transport, no network)
// ─────────────────────────────────────────────────────────────────────────────

async function urlTests() {
  console.log('\nprobeUrl: range request, never the whole file');

  const calls = [];
  const fakeFetch = (buf, opts) => async (url, headers, start, end) => {
    calls.push({ start, end, range: headers && headers.Range, url });
    const o = opts || {};
    const want = end - start + 1;
    let out;
    if (o.pad) {                                     // server honours the range but
      out = Buffer.alloc(want);                      // `moov` lives further in
      buf.copy(out, 0, 0, Math.min(buf.length, want));
    } else {
      out = Buffer.from(buf.subarray(0, Math.min(buf.length, want)));
    }
    out.rangeHonoured = o.honourRange !== false && out.length === want;
    return out;
  };

  const URL_MP4 = 'https://cdn.example.com/clip.mp4';

  const r1 = await probe.probeUrl(URL_MP4, { fetchBytes: fakeFetch(mp4Both, {}) });
  eq('small file resolved in one request', calls.length, 1);
  eq('first window is 512 KB', calls[0].end, 512 * 1024 - 1);
  eq('sends Range: bytes=0-N', calls[0].range, 'bytes=0-524287');
  eq('geometry proven from the head', probe.resolutionOf(r1), '1920x1080');

  // A moov that sits beyond the first windows: escalate 512K → 4M → 12M, then stop.
  calls.length = 0;
  const r2 = await probe.probeUrl(URL_MP4, { fetchBytes: fakeFetch(mp4Tail.subarray(0, 600), { pad: true }) });
  eq('escalates to the 12 MB hard cap only', calls.length, 3);
  eq('windows are 512K / 4M / 12M',
    calls.map(c => c.end + 1).join(','), [512 * 1024, 4 * 1024 * 1024, 12 * 1024 * 1024].join(','));
  check('no geometry invented for a headerless head', r2 === null || r2.width === 0, JSON.stringify(r2));

  // A server that ignores Range: the body is read up to the cap, no escalation.
  calls.length = 0;
  const ignoring = async (url, headers, start, end) => {
    calls.push({ start, end, range: headers && headers.Range });
    const out = Buffer.from(mp4Both);
    out.rangeHonoured = false;                        // 200 OK, whole file
    return out;
  };
  const r3 = await probe.probeUrl(URL_MP4, { fetchBytes: ignoring });
  eq('non-honoured server short-circuits the file', calls.length, 1);
  eq('still reads the real geometry', probe.resolutionOf(r3), '1920x1080');

  console.log('\nprobeUrl: failures must not throw');
  eq('fetchBytes rejects → null',
    await probe.probeUrl(URL_MP4, { fetchBytes: async () => { throw new Error('offline'); } }), null);
  eq('fetchBytes throws synchronously → null',
    await probe.probeUrl(URL_MP4, { fetchBytes: () => { throw new Error('boom'); } }), null);
  eq('fetchBytes returns junk → null',
    await probe.probeUrl(URL_MP4, { fetchBytes: async () => Buffer.from('not media at all, promise') }), null);
  eq('fetchBytes returns an empty buffer → null',
    await probe.probeUrl(URL_MP4, { fetchBytes: async () => Buffer.alloc(0) }), null);
  eq('fetchBytes returns a non-buffer → null',
    await probe.probeUrl(URL_MP4, { fetchBytes: async () => 'nope' }), null);
  eq('non-http url → null', await probe.probeUrl('file:///C:/windows/clip.mp4', { fetchBytes: fakeFetch(mp4Both) }), null);
  eq('empty url → null', await probe.probeUrl('', { fetchBytes: fakeFetch(mp4Both) }), null);
  eq('null url → null', await probe.probeUrl(null, { fetchBytes: fakeFetch(mp4Both) }), null);

  let slowRan = false;
  const t0 = Date.now();
  const slow = await probe.probeUrl(URL_MP4, {
    timeoutMs: 60,
    fetchBytes: () => new Promise(res => setTimeout(() => { slowRan = true; res(mp4Both); }, 4000)),
  });
  eq('a hanging transport times out → null', slow, null);
  check('timeout is honoured quickly', Date.now() - t0 < 3000, (Date.now() - t0) + 'ms');

  // A real range fetch must still work through the injected transport.
  const r4 = await probe.probeUrl('https://cdn.example.com/clip.mkv', { fetchBytes: fakeFetch(mkv, {}), maxBytes: 1024 * 1024 });
  eq('mkv over a range request', probe.resolutionOf(r4), '1280x720');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Fuzz: the parsers must never throw
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nFuzz: never throw, never invent');
(function fuzz() {
  let threw = 0;
  let invented = 0;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 400; i++) {
    const len = 32 + Math.floor(rnd() * 4096);
    const buf = Buffer.alloc(len);
    for (let j = 0; j < len; j++) buf[j] = Math.floor(rnd() * 256);
    // Sprinkle real signatures so the parsers actually engage.
    if (i % 4 === 0) buf.write('moov', Math.floor(rnd() * (len - 8)), 'latin1');
    if (i % 4 === 1) buf.write('ftyp', 4, 'latin1');
    if (i % 4 === 2) { buf[0] = 0x1a; buf[1] = 0x45; buf[2] = 0xdf; buf[3] = 0xa3; }
    if (i % 4 === 3) for (let j = 0; j + 188 <= len; j += 188) buf[j] = 0x47;
    try {
      probe.parseMp4(buf); probe.parseMatroska(buf); probe.parseMpegTs(buf);
      const info = probe.probeBuffer(buf);
      if (info && (info.width > 0 || info.height > 0)) invented++;
    } catch (e) {
      threw++;
    }
  }
  eq('400 random buffers, 0 exceptions', threw, 0);
  check('no geometry invented from noise', invented === 0, 'invented=' + invented);

  // Truncating a real file must degrade, never crash and never lie.
  let truncThrew = 0;
  let truncWrong = 0;
  for (const [name, buf] of [['mp4', mp4Both], ['mp4-tail', mp4Tail], ['mkv', mkv], ['ts', tsVideo], ['m4a', m4a]]) {
    for (let cut = 8; cut < buf.length; cut += Math.max(1, Math.floor(buf.length / 25))) {
      try {
        const info = probe.probeBuffer(buf.subarray(0, cut));
        if (info && info.width > 0 && (info.width !== 1920 && info.width !== 1280)) truncWrong++;
      } catch (e) { truncThrew++; }
    }
  }
  eq('truncated real files, 0 exceptions', truncThrew, 0);
  eq('truncated real files, 0 wrong dimensions', truncWrong, 0);
})();

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await fileTests();
    await urlTests();
  } catch (e) {
    fail++;
    console.log('  FAIL harness threw', e && e.stack ? e.stack : e);
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log(`\nmedia-probe: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
