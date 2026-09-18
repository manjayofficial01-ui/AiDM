// TRUE media geometry — no guessing.
//
// Why this exists: AiDM used to guess video dimensions from quality labels,
// URL text and the playing <video> element's current render size (see
// chrome-extension/content.js). That is why a 360p file displayed as 2160p and
// why every row on a page showed the same resolution. Everything here reads
// geometry out of the real container bytes instead:
//
//   • MP4/MOV/fMP4 — real ISO-BMFF box walking: moov → trak → mdia → minf →
//     stbl → stsd, tkhd width/height as 16.16 fixed point, stsd visual sample
//     entry preferred when non-zero, duration from mvhd duration/timescale.
//   • MKV/WebM — real EBML: Segment/Info/Duration (TimecodeScale ns),
//     Tracks/TrackEntry/Video/PixelWidth|PixelHeight, TrackType 1 vs 2.
//   • MPEG-TS — PAT → PMT → stream_type (0x1b/0x24/… video, 0x0f/0x03/… audio).
//     Transport streams carry no geometry in their headers: width/height stay 0.
//
// Two hard rules: NEVER throw (null on anything unusable) and NEVER invent a
// dimension — unproven geometry is `width: 0, height: 0`, because a wrong
// dimension is worse than none.
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const KB = 1024;
const MB = 1024 * KB;
const HEAD_WINDOW = 512 * KB;     // probeUrl first range request
const SECOND_WINDOW = 4 * MB;     // retry when no geometry was found
const HARD_CAP = 12 * MB;         // never read more than this
const TAIL_WINDOW = 2 * MB;       // probeFile: catch an MP4 with trailing moov
const DEFAULT_URL_TIMEOUT_MS = 8000;
const FFMPEG_TIMEOUT_MS = 5000;

// ── MediaInfo ───────────────────────────────────────────────────────────────

function mkInfo(o) {
  return {
    width: num(o && o.width) || 0,
    height: num(o && o.height) || 0,
    durationSec: roundSec(o && o.durationSec),
    hasVideo: !!(o && o.hasVideo),
    hasAudio: !!(o && o.hasAudio),
    vcodec: (o && o.vcodec) || null,
    acodec: (o && o.acodec) || null,
    container: (o && o.container) || null,
    bitrateKbps: num(o && o.bitrateKbps) || 0,
  };
}

function num(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

// Duration keeps its fraction (a 29.97 fps file is not 29 s).
function roundSec(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : 0;
}

// A dimension is only trusted when it is a plausible pixel size.
function sane(w, h) {
  return w > 0 && h > 0 && w < 100000 && h < 100000;
}

function mergeInfo(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const w = a.width || b.width;
  const h = a.height || b.height;
  return mkInfo({
    width: w,
    height: h,
    durationSec: a.durationSec || b.durationSec,
    hasVideo: a.hasVideo || b.hasVideo,
    hasAudio: a.hasAudio || b.hasAudio,
    vcodec: a.vcodec || b.vcodec,
    acodec: a.acodec || b.acodec,
    container: a.container || b.container,
  });
}

// ── ISO-BMFF (MP4 / MOV / fMP4) ─────────────────────────────────────────────

// Boxes whose payload is itself a list of boxes. Anything else is a leaf, so a
// walk never descends into `mdat` or into a sample entry's binary blob.
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf']);

const VIDEO_FOURCC = new Set(['avc1', 'avc2', 'avc3', 'avc4', 'hev1', 'hvc1', 'dvh1', 'dvhe', 'av01', 'vp09', 'vp08', 'mp4v']);
const AUDIO_FOURCC = new Set(['mp4a', 'ac-3', 'ec-3', 'Opus', '.mp3', 'ms\x00\x11', 'alac', 'fLaC']);

function fourccToVcodec(cc) {
  switch (cc) {
    case 'avc1': case 'avc2': case 'avc3': case 'avc4': return 'h264';
    case 'hev1': case 'hvc1': case 'dvh1': case 'dvhe': return 'h265';
    case 'av01': return 'av1';
    case 'vp09': case 'vp08': return 'vp9';
    case 'mp4v': return 'mpeg4';
    default: return null;
  }
}

function fourccToAcodec(cc) {
  switch (cc) {
    case 'mp4a': return 'aac';
    case 'ac-3': case 'ec-3': return 'ac3';
    case 'Opus': return 'opus';
    case '.mp3': return 'mp3';
    default: return null; // alac / fLaC / ms\x00\x11 — audio proven, codec not a bucket
  }
}

/**
 * Walk the boxes in [start, end). `cb(type, dataStart, dataEnd, boxStart)`.
 * Handles 32-bit sizes, 64-bit largesize (size === 1) and size === 0
 * (extends to the end of the enclosing box / file). Stops at the first box
 * that does not fit, so a truncated buffer degrades instead of throwing.
 */
function forEachBox(buf, start, end, cb) {
  let p = start;
  let guard = 0;
  while (p + 8 <= end && guard++ < 4096) {
    let size;
    let header = 8;
    const type = buf.toString('latin1', p + 4, p + 8);
    size = buf.readUInt32BE(p);
    if (size === 1) {
      if (p + 16 > end) return;
      const hi = buf.readUInt32BE(p + 8);
      const lo = buf.readUInt32BE(p + 12);
      size = hi * 4294967296 + lo;
      header = 16;
      if (type === 'uuid') header += 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (!isFinite(size) || size < header) return;
    const boxEnd = p + size > end ? end : p + size;   // tolerate a truncated tail
    cb(type, p + header > boxEnd ? boxEnd : p + header, boxEnd, p);
    if (p + size > end) return;
    p += size;
  }
}

function mp4Container(buf) {
  let brand = '';
  forEachBox(buf, 0, buf.length, (type, ds, de) => {
    if (type === 'ftyp' && !brand && de - ds >= 4) brand = buf.toString('latin1', ds, ds + 4);
  });
  if (/^qt/i.test(brand)) return 'mov';
  return 'mp4';
}

function findMoovBox(buf) {
  let found = null;
  forEachBox(buf, 0, buf.length, (type, ds, de) => {
    if (!found && type === 'moov') found = { ds, de };
  });
  if (found) return found;

  // Streamed/fragmented files put `moov` after `mdat` (or at the very end), so
  // a top-level walk of a partial buffer misses it. Scan for the signature and
  // accept the first candidate that actually parses into a track.
  let idx = buf.indexOf('moov', 0, 'latin1');
  let guard = 0;
  while (idx > 4 && idx !== -1 && guard++ < 64) {
    const boxStart = idx - 4;
    let size = buf.readUInt32BE(boxStart);
    let header = 8;
    if (size === 1 && boxStart + 16 <= buf.length) {
      size = buf.readUInt32BE(boxStart + 8) * 4294967296 + buf.readUInt32BE(boxStart + 12);
      header = 16;
    }
    if (size >= header && boxStart + header <= buf.length) {
      const cand = {
        ds: boxStart + header,
        de: boxStart + size > buf.length ? buf.length : boxStart + size,
      };
      if (collectTracks(buf, cand.ds, cand.de).length) return cand;
    }
    idx = buf.indexOf('moov', idx + 1, 'latin1');
  }
  return null;
}

// tkhd: width/height are the LAST two 32-bit fields of the box, in both
// version 0 and version 1 — the reliable way to read the 16.16 fixed point.
function readTkhd(buf, ds, de) {
  if (de - ds < 84) return null;
  const w = Math.round(buf.readUInt32BE(de - 8) / 65536);
  const h = Math.round(buf.readUInt32BE(de - 4) / 65536);
  return sane(w, h) ? { width: w, height: h } : null;
}

function readMvhd(buf, ds, de) {
  if (de - ds < 20) return null;
  const version = buf[ds];
  let timescale = 0;
  let duration = 0;
  if (version === 1) {
    if (de - ds < 32) return null;
    timescale = buf.readUInt32BE(ds + 20);
    duration = buf.readUInt32BE(ds + 24) * 4294967296 + buf.readUInt32BE(ds + 28);
  } else {
    timescale = buf.readUInt32BE(ds + 12);
    duration = buf.readUInt32BE(ds + 16);
  }
  if (!timescale || !duration) return null;
  return duration / timescale;
}

// stsd → sample entries. A visual sample entry carries its own width/height
// (uint16 at +32/+34 of the entry), which wins over tkhd when non-zero.
function readStsd(buf, ds, de) {
  const entries = [];
  if (de - ds < 8) return entries;
  const count = buf.readUInt32BE(ds + 4);
  let p = ds + 8;
  for (let i = 0; i < count && p + 8 <= de; i++) {
    let size = buf.readUInt32BE(p);
    const format = buf.toString('latin1', p + 4, p + 8);
    if (!size || p + size > de) size = de - p;
    const entry = { format, width: 0, height: 0 };
    if (VIDEO_FOURCC.has(format) && size >= 36) {
      const w = buf.readUInt16BE(p + 32);
      const h = buf.readUInt16BE(p + 34);
      if (sane(w, h)) { entry.width = w; entry.height = h; }
    }
    entries.push(entry);
    p += size;
    if (size < 8) break;
  }
  return entries;
}

function parseTrak(buf, ds, de) {
  const track = { kind: null, width: 0, height: 0, vcodec: null, acodec: null, fourcc: null };
  let tkhdWH = null;
  let handler = null;
  let stsdWH = null;

  const visit = (type, s, e) => {
    if (type === 'tkhd') {
      tkhdWH = readTkhd(buf, s, e) || tkhdWH;
    } else if (type === 'hdlr' && e - s >= 12) {
      handler = buf.toString('latin1', s + 8, s + 12);
    } else if (type === 'stsd') {
      const entries = readStsd(buf, s, e);
      for (const en of entries) {
        if (VIDEO_FOURCC.has(en.format)) {
          track.kind = 'video';
          track.vcodec = fourccToVcodec(en.format);
          track.fourcc = en.format;
          if (en.width && en.height) stsdWH = { width: en.width, height: en.height };
        } else if (AUDIO_FOURCC.has(en.format)) {
          if (track.kind !== 'video') track.kind = 'audio';
          track.acodec = fourccToAcodec(en.format);
          track.fourcc = track.fourcc || en.format;
        }
      }
    }
  };

  forEachBox(buf, ds, de, (type, s, e) => {
    if (type === 'mdia') {
      forEachBox(buf, s, e, (t2, s2, e2) => {
        visit(t2, s2, e2);
        if (t2 === 'minf') {
          forEachBox(buf, s2, e2, (t3, s3, e3) => {
            if (t3 === 'stbl') forEachBox(buf, s3, e3, visit);
          });
        }
      });
    } else {
      visit(type, s, e);
    }
  });

  if (!track.kind) {
    if (handler === 'vide') track.kind = 'video';
    else if (handler === 'soun') track.kind = 'audio';
  }

  const geom = stsdWH || tkhdWH;
  if (geom) { track.width = geom.width; track.height = geom.height; }
  return track.kind ? track : null;
}

function collectTracks(buf, moovStart, moovEnd) {
  const tracks = [];
  forEachBox(buf, moovStart, moovEnd, (type, ds, de) => {
    if (type !== 'trak') return;
    const t = parseTrak(buf, ds, de);
    if (t) tracks.push(t);
  });
  return tracks;
}

/**
 * ISO-BMFF / MOV / fMP4. Returns `null` when no `moov`/track can be proven.
 */
function parseMp4(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  try {
    const moov = findMoovBox(buf);
    if (!moov) return null;
    const tracks = collectTracks(buf, moov.ds, moov.de);
    if (!tracks.length) return null;

    let durationSec = 0;
    forEachBox(buf, moov.ds, moov.de, (type, ds, de) => {
      if (type === 'mvhd' && !durationSec) {
        const d = readMvhd(buf, ds, de);
        if (d) durationSec = d;
      }
    });

    const videos = tracks.filter(t => t.kind === 'video');
    const audios = tracks.filter(t => t.kind === 'audio');
    let width = 0;
    let height = 0;
    for (const v of videos) {
      if (sane(v.width, v.height) && (!width || v.width > width)) { width = v.width; height = v.height; }
    }
    return mkInfo({
      width,
      height,
      durationSec,
      hasVideo: videos.length > 0,
      hasAudio: audios.length > 0,   // no `soun` track ⇒ downloaded video with no sound
      vcodec: (videos[0] && videos[0].vcodec) || null,
      acodec: (audios[0] && audios[0].acodec) || null,
      container: mp4Container(buf),
    });
  } catch (e) {
    return null;
  }
}

// ── EBML / Matroska (MKV / WebM) ────────────────────────────────────────────

const EBML_MAGIC = 0x1a45dfa3;
const ID = {
  EBML: EBML_MAGIC,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  Audio: 0xe1,
  Channels: 0x9f,
};

function readVint(buf, pos) {
  if (pos < 0 || pos >= buf.length) return null;
  const b0 = buf[pos];
  if (!b0) return null;
  let len = 0;
  for (let i = 7; i >= 0; i--) {
    if (b0 & (1 << i)) { len = 8 - i; break; }
  }
  if (!len || pos + len > buf.length) return null;
  // `raw` keeps the length marker bit (that is how element IDs are written);
  // `value` has it stripped (that is how element sizes are written).
  let raw = 0;
  for (let i = 0; i < len; i++) raw = raw * 256 + buf[pos + i];
  let value = b0 & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  if (!isFinite(value) || value < 0) value = Number.MAX_SAFE_INTEGER;
  // Unknown size: every value bit set (0xFF, 0x7FFF, 0x01FFFFFFFFFFFFFF…).
  let unknown = true;
  for (let i = 0; i < len; i++) {
    const mask = i === 0 ? (0xff >> len) : 0xff;
    if ((buf[pos + i] & mask) !== mask) { unknown = false; break; }
  }
  return { raw, value, length: len, unknown };
}

function ebmlUint(buf, s, e) {
  let v = 0;
  for (let i = s; i < e && i - s < 8; i++) v = v * 256 + buf[i];
  return v;
}

function ebmlFloat(buf, s, e) {
  const len = e - s;
  try {
    if (len === 8) return buf.readDoubleBE(s);
    if (len === 4) return buf.readFloatBE(s);
  } catch (err) { /* truncated */ }
  return 0;
}

function mkvCodec(kind, codecId) {
  const id = String(codecId || '');
  if (kind === 'video') {
    if (/V_MPEG4\/ISO\/AVC|V_MPEG4\/ISO\/SVC/i.test(id)) return 'h264';
    if (/V_MPEGH\/ISO\/HEVC|V_MPEG4\/ISO\/HEVC/i.test(id)) return 'h265';
    if (/V_AV1/i.test(id)) return 'av1';
    if (/V_VP9/i.test(id)) return 'vp9';
    if (/V_VP8/i.test(id)) return 'vp9';
    if (/V_MPEG4\/ISO\/ASP|V_MPEG4\/ISO\/SP/i.test(id)) return 'mpeg4';
    return null;
  }
  if (/A_AAC/i.test(id)) return 'aac';
  if (/A_OPUS/i.test(id)) return 'opus';
  if (/A_VORBIS/i.test(id)) return 'vorbis';
  if (/A_AC3|A_EAC3/i.test(id)) return 'ac3';
  if (/A_MPEG\/L3|A_MPEG\/L2/i.test(id)) return 'mp3';
  return null;
}

function ebmlWalk(buf, start, end, ctx, depth) {
  if (depth > 8) return;
  let p = start;
  let guard = 0;
  while (p + 2 <= end && guard++ < 20000) {
    const idv = readVint(buf, p);
    if (!idv) return;
    const sv = readVint(buf, p + idv.length);
    if (!sv) return;
    const ds = p + idv.length + sv.length;
    // An unknown-size element runs to the end of its parent.
    const de = sv.unknown ? end : (ds + sv.value > end ? end : ds + sv.value);
    if (ds > end) return;

    switch (idv.raw) {
      case ID.DocType:
        ctx.state.docType = buf.toString('utf8', ds, de).replace(/\0.*$/, '').trim().toLowerCase();
        break;
      case ID.TimecodeScale:
        if (!sv.unknown) ctx.state.timecodeScale = ebmlUint(buf, ds, de) || ctx.state.timecodeScale;
        break;
      case ID.Duration: {
        const f = ebmlFloat(buf, ds, de);
        if (f > 0) ctx.state.durationFloat = f;
        break;
      }
      case ID.TrackEntry: {
        const track = { type: null, codec: '', pw: 0, ph: 0, dw: 0, dh: 0, channels: 0 };
        ctx.state.tracks.push(track);
        ebmlWalk(buf, ds, de, { state: ctx.state, track }, depth + 1);
        break;
      }
      case ID.TrackType:
        if (ctx.track) ctx.track.type = ebmlUint(buf, ds, de);
        break;
      case ID.CodecID:
        if (ctx.track) ctx.track.codec = buf.toString('utf8', ds, de).replace(/\0.*$/, '');
        break;
      case ID.Channels:
        if (ctx.track) ctx.track.channels = ebmlUint(buf, ds, de);
        break;
      case ID.PixelWidth:
        if (ctx.track) ctx.track.pw = ebmlUint(buf, ds, de);
        break;
      case ID.PixelHeight:
        if (ctx.track) ctx.track.ph = ebmlUint(buf, ds, de);
        break;
      case ID.DisplayWidth:
        if (ctx.track) ctx.track.dw = ebmlUint(buf, ds, de);
        break;
      case ID.DisplayHeight:
        if (ctx.track) ctx.track.dh = ebmlUint(buf, ds, de);
        break;
      case ID.EBML:
      case ID.Segment:
      case ID.Info:
      case ID.Tracks:
      case ID.Video:
      case ID.Audio:
        ebmlWalk(buf, ds, de, { state: ctx.state, track: ctx.track }, depth + 1);
        break;
      default:
        break;
    }
    p = de;
  }
}

/**
 * EBML/Matroska. Returns `null` when no track entry can be proven.
 */
function parseMatroska(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  try {
    const magic = readVint(buf, 0);
    if (!magic || magic.raw !== EBML_MAGIC) return null;
    const state = { docType: '', timecodeScale: 1000000, durationFloat: 0, tracks: [] };
    ebmlWalk(buf, 0, buf.length, { state, track: null }, 0);
    if (!state.tracks.length) return null;

    let width = 0;
    let height = 0;
    let vcodec = null;
    let acodec = null;
    let hasVideo = false;
    let hasAudio = false;

    for (const t of state.tracks) {
      const isVideo = t.type === 1 || (!t.type && /^V_/i.test(t.codec));
      const isAudio = t.type === 2 || (!t.type && /^A_/i.test(t.codec));
      if (isVideo) {
        hasVideo = true;
        const w = t.pw || t.dw;
        const h = t.ph || t.dh;
        if (sane(w, h) && (!width || w > width)) { width = w; height = h; }
        vcodec = vcodec || mkvCodec('video', t.codec);
      } else if (isAudio) {
        hasAudio = true;
        acodec = acodec || mkvCodec('audio', t.codec);
      }
    }

    const durationSec = state.durationFloat > 0
      ? (state.durationFloat * state.timecodeScale) / 1e9
      : 0;

    return mkInfo({
      width,
      height,
      durationSec,
      hasVideo,
      hasAudio,
      vcodec,
      acodec,
      container: state.docType === 'webm' ? 'webm' : 'mkv',
    });
  } catch (e) {
    return null;
  }
}

// ── MPEG-TS ─────────────────────────────────────────────────────────────────

const TS_VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x21, 0x22, 0x24]);
const TS_AUDIO_TYPES = new Set([0x03, 0x04, 0x06, 0x0f, 0x81, 0x87]);

function tsVideoCodec(type) {
  if (type === 0x1b || type === 0x21) return 'h264';
  if (type === 0x24) return 'h265';
  return null;
}

function tsAudioCodec(type) {
  if (type === 0x0f) return 'aac';
  if (type === 0x03 || type === 0x04) return 'mp3';
  if (type === 0x81 || type === 0x06 || type === 0x87) return 'ac3';
  return null;
}

// Find the 188-byte packet alignment (a TS may be padded/stripped).
function tsAlignment(buf) {
  let best = -1;
  let bestScore = 0;
  for (let start = 0; start < 188; start++) {
    let score = 0;
    for (let i = 0; i < 6; i++) {
      const p = start + i * 188;
      if (p + 188 <= buf.length && buf[p] === 0x47) score++;
      else break;
    }
    if (score > bestScore) { bestScore = score; best = start; }
  }
  return bestScore >= 3 ? best : -1;
}

function tsPayload(buf, off) {
  const afc = (buf[off + 3] >> 4) & 0x03;
  if (!(afc & 0x01)) return -1;                       // no payload
  let p = off + 4;
  if (afc & 0x02) p += 1 + buf[off + 4];              // adaptation field
  if (p >= off + 188) return -1;
  if (buf[off + 1] & 0x40) p += 1 + buf[p];           // PUSI → pointer_field
  return p < off + 188 ? p : -1;
}

function parsePat(buf, off, end) {
  const programs = [];
  const tableId = buf[off];
  if (tableId !== 0x00) return programs;
  const sectionLen = ((buf[off + 1] & 0x0f) << 8) | buf[off + 2];
  const stop = Math.min(off + 3 + sectionLen, end);
  let p = off + 8;                                    // skip tsid/version/section numbers
  while (p + 4 <= stop) {
    const program = buf.readUInt16BE(p);
    const pid = buf.readUInt16BE(p + 2) & 0x1fff;
    if (program !== 0 && pid !== 0) programs.push(pid);
    p += 4;
  }
  return programs;
}

function parsePmt(buf, off, end, out) {
  const tableId = buf[off];
  if (tableId !== 0x02) return;
  const sectionLen = ((buf[off + 1] & 0x0f) << 8) | buf[off + 2];
  const stop = Math.min(off + 3 + sectionLen, end);
  const infoLen = ((buf[off + 10] & 0x0f) << 8) | buf[off + 11];
  let p = off + 12 + infoLen;
  while (p + 5 <= stop) {
    const streamType = buf[p];
    const esInfoLen = ((buf[p + 3] & 0x0f) << 8) | buf[p + 4];
    if (TS_VIDEO_TYPES.has(streamType)) {
      out.hasVideo = true;
      out.vcodec = out.vcodec || tsVideoCodec(streamType);
    } else if (TS_AUDIO_TYPES.has(streamType)) {
      out.hasAudio = true;
      out.acodec = out.acodec || tsAudioCodec(streamType);
    }
    p += 5 + esInfoLen;
  }
}

/**
 * MPEG-TS. Proves which elementary streams exist; transport stream headers
 * carry no picture size, so width/height stay 0 rather than being guessed.
 */
function parseMpegTs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 188 * 2) return null;
  try {
    const start = tsAlignment(buf);
    if (start < 0) return null;
    const out = { hasVideo: false, hasAudio: false, vcodec: null, acodec: null, sawPmt: false };
    const pmtPids = new Set();
    let scanned = 0;

    for (let off = start; off + 188 <= buf.length && scanned < 4000; off += 188, scanned++) {
      if (buf[off] !== 0x47) continue;
      const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
      const p = tsPayload(buf, off);
      if (p < 0) continue;
      if (pid === 0) {
        for (const pid2 of parsePat(buf, p, off + 188)) pmtPids.add(pid2);
      } else if (pmtPids.has(pid)) {
        parsePmt(buf, p, off + 188, out);
        out.sawPmt = true;
      }
      if (out.sawPmt && off > start + 188 * 40) break;
    }

    if (!out.sawPmt) return null;
    return mkInfo({
      width: 0,
      height: 0,
      durationSec: 0,
      hasVideo: out.hasVideo,
      hasAudio: out.hasAudio,
      vcodec: out.vcodec,
      acodec: out.acodec,
      container: 'ts',
    });
  } catch (e) {
    return null;
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

function looksLikeMp4(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return true;
  return buf.includes('moov', 0, 'latin1');
}

function looksLikeEbml(buf) {
  return buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
}

/**
 * Pure, synchronous: identify the container and read real geometry out of it.
 * `null` when nothing can be proven.
 */
function probeBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  try {
    if (looksLikeEbml(buf)) {
      const mkv = parseMatroska(buf);
      if (mkv) return mkv;
    }
    if (looksLikeMp4(buf)) {
      const mp4 = parseMp4(buf);
      if (mp4) return mp4;
    }
    const ts = parseMpegTs(buf);
    if (ts) return ts;
    return null;
  } catch (e) {
    return null;
  }
}

// ── probeFile ───────────────────────────────────────────────────────────────

async function readRange(filePath, from, length) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) return Buffer.alloc(0);
    const n = Math.max(0, Math.min(length, st.size - from));
    if (!n) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(n);
    let read = 0;
    while (read < n) {
      const res = await fh.read(out, read, n - read, from + read);
      if (!res.bytesRead) break;
      read += res.bytesRead;
    }
    return read === n ? out : out.subarray(0, read);
  } finally {
    try { await fh.close(); } catch (e) { /* ignore */ }
  }
}

function containerFromFfmpeg(name) {
  const n = String(name || '').toLowerCase();
  if (n.indexOf('matroska') >= 0) return 'mkv';
  if (n.indexOf('webm') >= 0) return 'webm';
  if (n.indexOf('mpegts') >= 0) return 'ts';
  if (n.indexOf('flv') >= 0) return 'flv';
  return 'mp4';
}

function ffmpegCodec(kind, name) {
  const n = String(name || '').toLowerCase();
  if (kind === 'video') {
    if (n === 'h264' || n === 'avc') return 'h264';
    if (n === 'hevc' || n === 'h265') return 'h265';
    if (n === 'av1') return 'av1';
    if (n === 'vp9') return 'vp9';
    if (n === 'mpeg4') return 'mpeg4';
    return null;
  }
  if (n === 'aac') return 'aac';
  if (n === 'mp3') return 'mp3';
  if (n === 'opus') return 'opus';
  if (n === 'vorbis') return 'vorbis';
  if (n === 'ac3' || n === 'eac3') return 'ac3';
  return null;
}

/** Parse `ffmpeg -i` stderr. Pure, so it is unit-testable. */
function parseFfmpegOutput(text) {
  if (!text) return null;
  let width = 0;
  let height = 0;
  let durationSec = 0;
  let container = null;
  let vcodec = null;
  let acodec = null;
  let hasVideo = false;
  let hasAudio = false;
  let bitrateKbps = 0;

  const dur = /Duration:\s*(?:N\/A|(\d+):(\d{2}):(\d{2}(?:\.\d+)?))/.exec(text);
  if (dur && dur[1]) durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);

  const input = /Input #0,\s*([^,]+)/.exec(text);
  if (input) container = containerFromFfmpeg(input[1]);

  const v = /Stream #\d+:\d+[^\n]*?:\s*Video:\s*([a-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})/i.exec(text);
  if (v) {
    hasVideo = true;
    vcodec = ffmpegCodec('video', v[1]);
    const w = Number(v[2]);
    const h = Number(v[3]);
    if (sane(w, h)) { width = w; height = h; }
  } else if (/Stream #\d+:\d+[^\n]*?:\s*Video:/i.test(text)) {
    hasVideo = true;                                  // video stream, size unknown
  }

  const a = /Stream #\d+:\d+[^\n]*?:\s*Audio:\s*([a-z0-9_]+)/i.exec(text);
  if (a) { hasAudio = true; acodec = ffmpegCodec('audio', a[1]); }

  const br = /bitrate:\s*(\d+)\s*kb\/s/.exec(text);
  if (br) bitrateKbps = Number(br[1]);

  if (!hasVideo && !hasAudio && !durationSec) return null;
  return mkInfo({ width, height, durationSec, hasVideo, hasAudio, vcodec, acodec, container, bitrateKbps });
}

function ffmpegProbe(filePath, timeoutMs = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let bin = null;
    try {
      const mux = require('./media-mux');
      bin = typeof mux.resolveFfmpeg === 'function' ? mux.resolveFfmpeg() : null;
    } catch (e) {
      bin = null;
    }
    if (!bin) { resolve(null); return; }

    let stderr = '';
    let child = null;
    let done = false;
    const finish = (info) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (child) child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      resolve(info);
    };
    const timer = setTimeout(() => finish(parseFfmpegOutput(stderr)), timeoutMs);
    try {
      child = spawn(bin, ['-hide_banner', '-i', filePath], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 65536) stderr = stderr.slice(-65536);
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(parseFfmpegOutput(stderr)));
  });
}

/**
 * Read the first `maxBytes` (default 12 MB), and — for an MP4 whose `moov`
 * sits at the end — the last 2 MB as well. Falls back to `ffmpeg -i` only when
 * the pure parsers prove nothing.
 */
async function probeFile(filePath, opts = {}) {
  try {
    const p = typeof filePath === 'string' ? filePath : '';
    if (!p) return null;
    const maxBytes = Number(opts && opts.maxBytes) > 0 ? Number(opts.maxBytes) : HARD_CAP;

    const head = await readRange(p, 0, maxBytes);
    let info = probeBuffer(head);

    if (!info || (!info.width && !info.height)) {
      const size = await fs.promises.stat(p).then(st => st.size, () => 0);
      if (size > head.length + 8) {
        const tail = await readRange(p, Math.max(0, size - TAIL_WINDOW), TAIL_WINDOW);
        const ti = probeBuffer(tail);
        if (ti) info = mergeInfo(info, ti);
      }
    }

    if (info && (info.width > 0 || (info.hasAudio && !info.hasVideo))) return info;
    return await ffmpegProbe(p, FFMPEG_TIMEOUT_MS);
  } catch (e) {
    return null;
  }
}

// ── probeUrl ────────────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe timed out')), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function readBodyCapped(res, cap) {
  const body = res && res.body;
  if (!body) return Buffer.alloc(0);
  if (typeof body.getReader !== 'function') {
    try {
      const ab = await res.arrayBuffer();
      return Buffer.from(ab.slice(0, cap));
    } catch (e) {
      return Buffer.alloc(0);
    }
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < cap) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value || Buffer.alloc(0));
      if (!chunk.length) break;
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    try { await reader.cancel(); } catch (e) { /* abort the rest of the body */ }
    try { if (typeof body.destroy === 'function') body.destroy(); } catch (e) { /* ignore */ }
  }
  return Buffer.concat(chunks, total);
}

/**
 * Default transport: `GET` with `Range: bytes=start-end`, reading only the
 * requested window (never the whole file). `rangeHonoured` is attached to the
 * returned Buffer so probeUrl knows whether escalating the window can help.
 */
async function httpFetchBytes(url, headers, start, end, timeoutMs = DEFAULT_URL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch (e) { /* ignore */ } }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: Object.assign({}, headers || {}, { Range: `bytes=${start}-${end}` }),
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res || res.status >= 400) return Buffer.alloc(0);
    const out = await readBodyCapped(res, end - start + 1);
    out.rangeHonoured = res.status === 206;
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prove geometry from the first bytes of a remote file only.
 * Windows: 512 KB → 4 MB → 12 MB (hard cap). A server that ignores `Range`
 * gets its body read up to the cap and then aborted.
 *
 * @param {string} url
 * @param {{ headers?: object, fetchBytes?: (url: string, headers: object, start: number, end: number) => Promise<Buffer>,
 *           timeoutMs?: number, maxBytes?: number }} [opts]
 */
async function probeUrl(url, opts = {}) {
  try {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return null;
    const o = opts || {};
    const headers = o.headers && typeof o.headers === 'object' ? o.headers : {};
    const fetchBytes = typeof o.fetchBytes === 'function' ? o.fetchBytes : httpFetchBytes;
    const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_URL_TIMEOUT_MS;
    const cap = Number(o.maxBytes) > 0 ? Math.min(Number(o.maxBytes), HARD_CAP) : HARD_CAP;

    const windows = [HEAD_WINDOW, SECOND_WINDOW, cap]
      .filter((v, i, arr) => v <= cap && arr.indexOf(v) === i)
      .sort((a, b) => a - b);

    let last = null;
    for (const n of windows) {
      const rangeHeaders = Object.assign({}, headers, { Range: `bytes=0-${n - 1}` });
      const buf = await withTimeout(fetchBytes(u, rangeHeaders, 0, n - 1, timeoutMs), timeoutMs + 500);
      if (!Buffer.isBuffer(buf) || !buf.length) break;
      const info = probeBuffer(buf);
      if (info) {
        if (info.width > 0 || info.container === 'ts' || info.container === 'flv') return info;
        last = last ? mergeInfo(last, info) : info;
      }
      // A short response means the server sent the whole file (or ignored the
      // range) — a bigger window cannot reveal more.
      const honoured = buf.rangeHonoured !== undefined ? !!buf.rangeHonoured : buf.length >= n;
      if (!honoured && buf.length < n) break;
      if (n >= cap) break;
    }
    return last;
  } catch (e) {
    return null;
  }
}

// ── Small helpers used by the UI / manager ──────────────────────────────────

function resolutionOf(info) {
  if (!info || !info.width || !info.height) return null;
  return `${info.width}x${info.height}`;
}

function labelForHeight(h) {
  if (h === null || h === undefined || h === '') return null;
  const n = Number(h);
  if (!isFinite(n) || n < 0) return null;
  if (n >= 2160) return '2160p';
  if (n >= 1440) return '1440p';
  if (n >= 1080) return '1080p';
  if (n >= 720) return '720p';
  if (n >= 480) return '480p';
  if (n >= 360) return '360p';
  if (n >= 240) return '240p';
  return Math.floor(n) + 'p';
}

function resolutionForLabel(label) {
  const m = /^(\d+)\s*p$/i.exec(String(label == null ? '' : label).trim());
  if (!m) return null;
  switch (Number(m[1])) {
    case 2160: return '3840x2160';
    case 1440: return '2560x1440';
    case 1080: return '1920x1080';
    case 720: return '1280x720';
    case 480: return '854x480';
    case 360: return '640x360';
    case 240: return '426x240';
    case 144: return '256x144';
    default: return null;
  }
}

function hasAudio(info) {
  return !!(info && info.hasAudio);
}

function hasVideo(info) {
  return !!(info && info.hasVideo);
}

module.exports = {
  probeFile,
  probeBuffer,
  probeUrl,
  parseMp4,
  parseMatroska,
  parseMpegTs,
  resolutionOf,
  labelForHeight,
  resolutionForLabel,
  hasAudio,
  hasVideo,
};
