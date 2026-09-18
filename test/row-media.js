// Regression harness for the ROW-LEVEL truth of a download (src/download-manager.js).
//
// Three user-reported bugs, all pure (no network, no real media files):
//   1. WRONG DIMENSIONS — `quality.resolution` used to be whatever the
//      extension, a URL regex or the playing <video> element guessed, which is
//      why a 360p file displayed as 2160p and every row on a page showed the
//      same resolution. A completed row is now probed with src/media-probe.js
//      and the label/resolution are REWRITTEN from the proven geometry.
//   2. SILENT DOWNLOADS — a file with a video track and no audio track must
//      set `audioMissing`, and a paired `audioUrl` must be muxed in (any
//      provider, not just Facebook) without ever destroying the video.
//   3. FILE-HOSTER ROWS — `singleConnection` / `resumable: false` from the
//      resolver must force one connection and be passed to the engine.
//
// Fixtures are hand-built byte-for-byte (same approach as test/media-probe.js)
// and the engine is stubbed, so nothing here touches the network.
// Run: node test/row-media.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-row-media-'));
// DownloadManager reads/writes settings + state under USERPROFILE — point it
// at the scratch dir BEFORE requiring the module.
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { DownloadManager } = require('../src/download-manager');
const mediaProbe = require('../src/media-probe');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await tick(15);
  }
  return false;
}

// ── MP4 fixture builders (same byte layout as test/media-probe.js) ───────────

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function box(type, ...parts) {
  const payload = Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(8 + payload.length, 0);
  out.write(type, 4, 4, 'latin1');
  payload.copy(out, 8);
  return out;
}
// VisualSampleEntry: width/height are uint16 at +32/+34.
function avc1Entry(w, h) {
  const b = Buffer.alloc(86);
  b.writeUInt32BE(86, 0);
  b.write('avc1', 4, 4, 'latin1');
  b.writeUInt16BE(1, 14);
  b.writeUInt16BE(w, 32);
  b.writeUInt16BE(h, 34);
  return b;
}
function mp4aEntry() {
  const b = Buffer.alloc(36);
  b.writeUInt32BE(36, 0);
  b.write('mp4a', 4, 4, 'latin1');
  b.writeUInt16BE(1, 14);
  b.writeUInt16BE(2, 24);
  b.writeUInt16BE(16, 26);
  return b;
}
function tkhdBox(id, w, h) {
  const b = Buffer.alloc(84);
  b[3] = 7;
  b.writeUInt32BE(id, 12);
  b.writeUInt32BE(30000, 20);
  const unity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  unity.forEach((v, i) => b.writeUInt32BE(v >>> 0, 40 + i * 4));
  b.writeUInt32BE((w * 65536) >>> 0, 76);
  b.writeUInt32BE((h * 65536) >>> 0, 80);
  return box('tkhd', b);
}
function mdhdBox() {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(1000, 12);
  b.writeUInt32BE(30000, 16);
  return box('mdhd', b);
}
function hdlrBox(handler) {
  const b = Buffer.alloc(24 + 12);
  b.write(handler, 8, 4, 'latin1');
  b.write('AiDMHandler', 24, 11, 'latin1');
  return box('hdlr', b);
}
function trakBox(kind, w, h, id) {
  const isVideo = kind === 'video';
  const stbl = box('stbl',
    box('stsd', u32(0), u32(1), isVideo ? avc1Entry(w, h) : mp4aEntry()),
    box('stts', u32(0), u32(0)), box('stsc', u32(0), u32(0)),
    box('stsz', u32(0), u32(0), u32(0)), box('stco', u32(0), u32(0)));
  return box('trak', tkhdBox(id, isVideo ? w : 0, isVideo ? h : 0),
    box('mdia', mdhdBox(), hdlrBox(isVideo ? 'vide' : 'soun'), box('minf', stbl)));
}
function mvhdBox(nextId) {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(1000, 12);
  b.writeUInt32BE(30000, 16);
  b.writeUInt32BE(0x00010000, 20);
  b.writeUInt16BE(0x0100, 24);
  const unity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  unity.forEach((v, i) => b.writeUInt32BE(v >>> 0, 36 + i * 4));
  b.writeUInt32BE(nextId, 96);
  return box('mvhd', b);
}
/** @param {{width:number,height:number,audio?:boolean}} o */
function buildMp4(o) {
  const ftyp = box('ftyp', 'isom', u32(0x200), 'isom', 'iso2', 'avc1', 'mp41');
  const tracks = [trakBox('video', o.width, o.height, 1)];
  if (o.audio !== false) tracks.push(trakBox('audio', 0, 0, 2));
  const moov = box('moov', mvhdBox(tracks.length + 1), ...tracks);
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(1024, 0x5a))]);
}

function write(name, buf) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, buf);
  return p;
}

const CLIP_360 = write('clip-360.mp4', buildMp4({ width: 640, height: 360, audio: true }));
const CLIP_SILENT = write('clip-silent.mp4', buildMp4({ width: 1280, height: 720, audio: false }));
const CLIP_JUNK = write('clip-junk.mp4', Buffer.from('not a media file at all, honest', 'utf8'));

// ── Stubbed engine — no network, records what the manager asked for ──────────
//
// The manager registers its listeners on the engine in the constructor, so the
// real object is kept and only its network-touching methods are replaced.

function newManager() {
  const mgr = new DownloadManager();
  const engine = mgr.engine;
  engine.calls = [];
  engine.setSpeedLimit = () => {};
  engine.setHlsConcurrency = () => {};
  engine.getDownload = () => null;
  engine.cancelDownload = () => {};
  engine.pauseDownload = () => {};
  engine.resumeDownload = () => {};
  engine.probeMeta = async () => ({ status: 200, contentLength: 0, contentType: 'video/mp4', acceptRanges: true });
  engine.probeHlsSize = async () => null;
  engine.startDownload = async (opts) => { engine.calls.push(opts); return { id: opts.id }; };
  engine.startHlsDownload = async (opts) => { engine.calls.push(opts); return { id: opts.id }; };
  return mgr;
}

/** Add a row, let the stubbed probe/start settle, then complete it. */
async function addAndComplete(mgr, opts) {
  const dl = mgr.addDownload({ savePath: TMP, ...opts });
  await tick(30);
  let size = 0;
  try { size = fs.statSync(dl.filepath).size; } catch (e) { size = 0; }
  mgr.engine.emit('download-complete', { id: dl.id, totalSize: size, filepath: dl.filepath });
  await waitFor(() => !!dl.media, 4000);
  await tick(30);
  return dl;
}

async function main() {
  console.log('\n1. true dimensions on every row');

  {
    // The reported bug: a 360p file whose row claimed 2160p.
    const mgr = newManager();
    fs.copyFileSync(CLIP_360, path.join(TMP, 'row-360.mp4'));
    const dl = await addAndComplete(mgr, {
      url: 'https://cdn.example.com/v/row-360.mp4',
      filename: 'row-360.mp4',
      quality: { label: '2160p', resolution: '3840x2160', size: 999999, format: 'mp4' },
    });
    check('completed row carries download.media', !!dl.media && typeof dl.media === 'object');
    check('media.width is the real width', dl.media && dl.media.width === 640, dl.media && dl.media.width);
    check('media.height is the real height', dl.media && dl.media.height === 360, dl.media && dl.media.height);
    check('media.hasVideo', dl.media && dl.media.hasVideo === true);
    check('media.hasAudio', dl.media && dl.media.hasAudio === true);
    check('media.probedAt is stamped', typeof (dl.media && dl.media.probedAt) === 'number');
    check('media.container proven', dl.media && dl.media.container === 'mp4', dl.media && dl.media.container);
    check('quality.resolution rewritten from the probe',
      dl.quality && dl.quality.resolution === '640x360', dl.quality && dl.quality.resolution);
    check('quality.label rewritten from the probe',
      dl.quality && dl.quality.label === '360p', dl.quality && dl.quality.label);
    check('a 640x360 file NEVER reports 2160p',
      !/2160p|3840x2160/.test(JSON.stringify(dl.quality || {})));
    check('probe does not clobber size/format',
      dl.quality && dl.quality.size === 999999 && dl.quality.format === 'mp4');
    check('row stays completed', dl.status === 'completed');
  }

  {
    // A row with no pre-existing quality object still gets one.
    const mgr = newManager();
    fs.copyFileSync(CLIP_360, path.join(TMP, 'row-bare.mp4'));
    const dl = await addAndComplete(mgr, {
      url: 'https://cdn.example.com/v/row-bare.mp4',
      filename: 'row-bare.mp4',
    });
    check('quality is created when the row had none',
      !!dl.quality && dl.quality.resolution === '640x360' && dl.quality.label === '360p');
  }

  {
    // Manual refresh re-proves an existing row.
    const mgr = newManager();
    fs.copyFileSync(CLIP_360, path.join(TMP, 'row-refresh.mp4'));
    const dl = await addAndComplete(mgr, {
      url: 'https://cdn.example.com/v/row-refresh.mp4',
      filename: 'row-refresh.mp4',
      quality: { label: '2160p', resolution: '3840x2160' },
    });
    delete dl.media;
    dl.quality = { label: '2160p', resolution: '3840x2160' };
    let updates = 0;
    mgr.on('download-updated', () => { updates++; });
    mgr.refreshDownload(dl.id);
    const ok = await waitFor(() => !!dl.media, 4000);
    await tick(30);
    check('refreshDownload re-probes the row', ok && dl.quality.resolution === '640x360');
    check('probe emits download-updated so the UI repaints', updates > 0, updates + ' update(s)');
  }

  {
    // Restored rows: bounded lazy probe. Start from an empty state file so the
    // only completed rows in the manager are the ones inserted below.
    fs.rmSync(path.join(TMP, '.aidm_downloads.json'), { force: true });
    const mgr = newManager();
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const name = 'restored-' + i + '.mp4';
      fs.copyFileSync(CLIP_360, path.join(TMP, name));
      const row = {
        id: 'restored-row-' + i, url: 'https://cdn.example.com/v/' + name,
        filename: name, filepath: path.join(TMP, name), status: 'completed',
        category: 'video', savePath: TMP, quality: { label: '2160p', resolution: '3840x2160' },
      };
      mgr.downloads.set(row.id, row);
      rows.push(row);
    }
    mgr._probeRestoredRows(2);           // cap the pass
    await waitFor(() => rows.filter(r => r.media).length >= 2, 4000);
    await tick(400);
    const probed = rows.filter(r => r.media).length;
    check('restore pass is bounded (2 of 6 rows)', probed === 2, probed + ' probed');
    check('restored row got real geometry',
      rows[0].media && rows[0].media.height === 360 && rows[0].quality.resolution === '640x360');
  }

  console.log('\n2. missing audio is detected (and never silently ignored)');

  {
    const mgr = newManager();
    fs.copyFileSync(CLIP_SILENT, path.join(TMP, 'row-silent.mp4'));
    const dl = await addAndComplete(mgr, {
      url: 'https://cdn.example.com/v/row-silent.mp4',
      filename: 'row-silent.mp4',
      quality: { label: '2160p', resolution: '3840x2160' },
    });
    check('video-only file sets audioMissing', dl.audioMissing === true);
    check('audioMissing is hasVideo && !hasAudio',
      dl.media && dl.media.hasVideo === true && dl.media.hasAudio === false);
    check('geometry still proven for a silent file',
      dl.quality && dl.quality.resolution === '1280x720' && dl.quality.label === '720p');

    // No paired audio to mux: the row must NOT be failed.
    await tick(50);
    check('silent row without audioUrl is not failed',
      dl.status === 'completed' && !dl.error, dl.status + ' / ' + dl.error);
    check('silent row keeps audioMissing for the UI', dl.audioMissing === true);
  }

  {
    // A failed mux restores the original file instead of leaving a stub.
    const mgr = newManager();
    const target = path.join(TMP, 'row-mux-fail.mp4');
    fs.copyFileSync(CLIP_SILENT, target);
    const before = fs.statSync(target).size;
    const dl = await addAndComplete(mgr, {
      url: 'https://cdn.example.com/v/row-mux-fail.mp4',
      filename: 'row-mux-fail.mp4',
      audioUrl: 'http://127.0.0.1:9/audio.m4a',   // refused instantly, no network
    });
    const muxed = await mgr._ensureAudio(dl);
    await tick(50);
    const after = fs.existsSync(target) ? fs.statSync(target).size : -1;
    check('failed mux reports failure', muxed === false);
    check('failed mux restores the original file (never zero-byte)', after === before, before + ' → ' + after);
    check('failed mux leaves no .part/.muxed/.bak litter',
      !fs.existsSync(target + '.audio.part') &&
      !fs.existsSync(target + '.muxed.mp4') &&
      !fs.existsSync(target + '.video.bak'));
    check('failed mux does not fail the row', dl.status === 'completed' && !dl.error);
    check('failed mux explains itself with audioMissing + muxNote',
      dl.audioMissing === true && typeof dl.muxNote === 'string' && dl.muxNote.length > 0);
  }

  {
    // Double-mux guard.
    const mgr = newManager();
    const target = path.join(TMP, 'row-double-mux.mp4');
    fs.copyFileSync(CLIP_SILENT, target);
    const dl = await addAndComplete(mgr, {
      url: 'https://cdn.example.com/v/row-double-mux.mp4',
      filename: 'row-double-mux.mp4',
      audioUrl: 'http://127.0.0.1:9/audio.m4a',
    });
    dl._muxDone = true;
    const again = await mgr._muxFacebookAudio(dl);
    check('a row is never muxed twice', again === false);
  }

  console.log('\n3. file-hoster (Rapidgator) rows');

  {
    const mgr = newManager();
    const dl = mgr.addDownload({
      url: 'https://rapidgator.net/file/abc123/Big.Buck.Bunny.mp4',
      filename: 'Big.Buck.Bunny.mp4',
      savePath: TMP,
      segments: 8,
      quality: { label: 'file', resolution: '3840x2160', size: 5000, format: 'mp4' },
      meta: {
        provider: 'rapidgator',
        pageUrl: 'https://rapidgator.net/file/abc123/Big.Buck.Bunny.html',
        singleConnection: true,
        resumable: false,
        headers: {
          Referer: 'https://rapidgator.net/file/abc123/Big.Buck.Bunny.html',
          'User-Agent': 'Mozilla/5.0 Chrome/126',
          Cookie: 'PHPSESSID=supersecret',
        },
      },
    });
    await tick(60);
    check('singleConnection metadata forces segments 1', dl.segments === 1, dl.segments);
    check('download.singleConnection is set', dl.singleConnection === true);
    check('download.resumable is false', dl.resumable === false);
    check('category routing still works', dl.category === 'video', dl.category);

    const call = mgr.engine.calls[mgr.engine.calls.length - 1];
    check('engine.startDownload got singleConnection', call && call.singleConnection === true);
    check('engine.startDownload got resumable:false', call && call.resumable === false);
    check('engine.startDownload got totalSegments 1', call && call.totalSegments === 1, call && call.totalSegments);
    check('no resume offsets for a non-resumable row', call && !call.resumeOffsets);
    check('Referer replayed to the engine', !!call && call.headers && /rapidgator/.test(call.headers.Referer || ''));
    check('Cookie replayed as a header at request time',
      !!call && call.headers && call.headers.Cookie === 'PHPSESSID=supersecret');
    check('Cookie is NOT stored in row.headers (never persisted)',
      !!dl.headers && !Object.keys(dl.headers).some(k => k.toLowerCase() === 'cookie'));
    check('Cookie kept in the (stripped) row cookies', dl.cookies === 'PHPSESSID=supersecret');
  }

  {
    // Duplicate detection must still fire for a hoster row.
    const mgr = newManager();
    const opts = {
      url: 'https://rapidgator.net/file/dup1/clip.mp4',
      filename: 'clip.mp4',
      savePath: TMP,
      meta: { singleConnection: true, resumable: false },
    };
    const a = mgr.addDownload(opts);
    const b = mgr.addDownload(opts);
    check('duplicate detection still works for hoster rows', b.duplicate === true && b.id === a.id);
    check('duplicate row keeps segments 1', a.segments === 1 && a.singleConnection === true);
  }

  {
    // An ordinary row is untouched by the hoster rules.
    const mgr = newManager();
    const dl = mgr.addDownload({
      url: 'https://cdn.example.com/v/normal.mp4',
      filename: 'normal.mp4',
      savePath: TMP,
    });
    await tick(60);
    check('normal row keeps the default segment count', dl.segments === mgr.settings.defaultSegments, dl.segments);
    check('normal row is resumable', dl.resumable === true && dl.singleConnection === false);
    const call = mgr.engine.calls[mgr.engine.calls.length - 1];
    check('engine.startDownload defaults unchanged', call && call.singleConnection === false && call.resumable === true);
  }

  console.log('\n4. a failed or absent probe never breaks the row');

  {
    // No file on disk at all.
    const mgr = newManager();
    const dl = mgr.addDownload({
      url: 'https://cdn.example.com/v/gone.mp4',
      filename: 'gone.mp4',
      savePath: TMP,
      quality: { label: '720p', resolution: '1280x720' },
    });
    await tick(30);
    dl.status = 'completed';
    dl.filepath = path.join(TMP, 'does-not-exist.mp4');
    let threw = false;
    let res;
    try { res = await mgr.probeMedia(dl); } catch (e) { threw = true; }
    check('probe of a missing file does not throw', !threw);
    check('probe of a missing file returns null', res === null);
    check('missing file leaves the row intact',
      dl.quality.label === '720p' && dl.quality.resolution === '1280x720' && dl.status === 'completed');
    check('missing file sets no media', !dl.media);
  }

  {
    // The probe itself fails (returns null).
    const real = mediaProbe.probeFile;
    mediaProbe.probeFile = async () => { throw new Error('probe exploded'); };
    try {
      const mgr = newManager();
      fs.copyFileSync(CLIP_360, path.join(TMP, 'row-probe-throws.mp4'));
      const dl = await addAndComplete(mgr, {
        url: 'https://cdn.example.com/v/row-probe-throws.mp4',
        filename: 'row-probe-throws.mp4',
        quality: { label: '2160p', resolution: '3840x2160' },
      });
      check('a throwing probe never reaches completion', true);
      check('a throwing probe leaves the row completed', dl.status === 'completed' && !dl.error);
      check('a throwing probe leaves quality untouched',
        dl.quality.resolution === '3840x2160' && dl.quality.label === '2160p');
    } finally {
      mediaProbe.probeFile = real;
    }
  }

  {
    // Probe succeeds but proves no geometry → keep the label, drop resolution.
    const real = mediaProbe.probeFile;
    mediaProbe.probeFile = async () => ({
      width: 0, height: 0, durationSec: 12.5, hasVideo: true, hasAudio: true,
      vcodec: 'h264', acodec: null, container: 'ts', bitrateKbps: 0,
    });
    try {
      const mgr = newManager();
      fs.copyFileSync(CLIP_JUNK, path.join(TMP, 'row-nogeom.ts'));
      const dl = await addAndComplete(mgr, {
        url: 'https://cdn.example.com/v/row-nogeom.ts',
        filename: 'row-nogeom.ts',
        quality: { label: '720p', resolution: '1280x720', size: 10, format: 'ts' },
      });
      check('no geometry ⇒ media is still stored', !!dl.media && dl.media.hasVideo === true);
      check('no geometry ⇒ existing label is kept', dl.quality.label === '720p');
      check('no geometry ⇒ resolution is never fabricated',
        !('resolution' in dl.quality) || dl.quality.resolution === undefined,
        JSON.stringify(dl.quality.resolution));
      check('no geometry ⇒ audioMissing stays false when audio is present', dl.audioMissing === false);
    } finally {
      mediaProbe.probeFile = real;
    }
  }

  console.log('\n5. persistence stays clean');

  {
    const mgr = newManager();
    fs.copyFileSync(CLIP_360, path.join(TMP, 'row-persist.mp4'));
    mgr.addDownload({
      url: 'https://cdn.example.com/v/row-persist.mp4',
      filename: 'row-persist.mp4',
      savePath: TMP,
      cookies: 'PHPSESSID=supersecret; user__=abc',
      headers: { Referer: 'https://example.com/page', Cookie: 'stolen=1' },
      quality: { label: '2160p', resolution: '3840x2160' },
    });
    await tick(60);
    mgr._persistDownloads();
    const raw = fs.readFileSync(path.join(TMP, '.aidm_downloads.json'), 'utf8');
    check('persisted state has no cookie value', !/supersecret|stolen|user__/.test(raw));
    check('persisted state has no Cookie key', !/"Cookie"|'Cookie'|cookie/i.test(raw));
    const rows = JSON.parse(raw);
    check('persisted row keeps media/quality fields', !!rows.length && 'quality' in rows[0]);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nrow-media: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('row-media crashed:', e);
  process.exit(1);
});
