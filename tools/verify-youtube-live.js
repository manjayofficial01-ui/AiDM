#!/usr/bin/env node
/**
 * Live end-to-end check of AiDM's YouTube engine.
 *
 *   node tools/verify-youtube-live.js [url] [--quality 720p] [--audio]
 *
 * This is the one test the unit suite cannot do: it talks to the REAL
 * extractor, through the REAL code path (src/yt-dlp.js + src/youtube-resolver.js),
 * and proves the finished file carries both picture and sound.
 *
 * It is deliberately separate from `npm test`: the suite must stay fast and
 * offline (it mocks yt-dlp), while this one needs the network. Run it after
 * installing/updating yt-dlp (`node tools/fetch-yt-dlp.js`).
 *
 * Default url is a short, public, stable clip so the check stays quick.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ytdlp = require('../src/yt-dlp');
const yt = require('../src/youtube-resolver');
const mediaProbe = require('../src/media-probe');

const DEFAULT_URL = 'https://www.youtube.com/watch?v=DdAfr9PfswU';

/**
 * Drive the REAL manager: DownloadManager.addDownload() → resolver → engine.
 *
 * Everything else in this file calls src/yt-dlp.js directly, which proves the
 * engine works but skips the layer a user actually touches — the resolver
 * registry, row creation, category folder, renaming and completion. This
 * exercises that whole path.
 *
 * State and media both land in `outDir`, so nothing touches the user's real
 * Downloads folder or their saved download list.
 */
function managerDownload({ row, canonicalUrl, outDir, timeoutMs, onProgress }) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const { DownloadManager } = require('../src/download-manager');
    const dm = new DownloadManager();

    // ISOLATE STATE. The manager persists to `$HOME/.aidm_downloads.json` —
    // the user's REAL AiDM list, not the save folder. Without this, a check
    // run adds rows to the live app's list, and a later run then matches its
    // own leftover row as a duplicate and returns it instead of downloading
    // (which is how a bogus "completed" row appeared here).
    //
    // Overriding HOME/USERPROFILE is NOT safe — it changed behaviour deeper in
    // the stack and the row stalled at "connecting". Redirect only the state
    // path, which is the one thing that must not be touched.
    const statePath = path.join(outDir, '.aidm_downloads.json');
    dm._getStatePath = () => statePath;
    dm._getLegacyStatePaths = () => [];
    // Redirect persistence + media before anything is written.
    dm.settings.defaultSavePath = outDir;
    dm.settings.autoResume = false;
    dm._ensureDirectories();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('timed out waiting for the manager to finish the row'));
    }, timeoutMs);

    const done = (err, row) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(row);
    };

    dm.on('download-progress', (p) => { if (onProgress) onProgress(p); });
    dm.on('download-error', (e) => done(new Error((e && e.error) || 'manager reported an error')));
    // The event only carries { id, totalSize, duration } — the filepath lives
    // on the stored row, so resolve with that or the caller sees "null".
    dm.on('download-complete', (d) => done(null, dm.downloads.get(d && d.id)));

    // This mirrors main.js's `add-download`: the renderer sends back the row
    // the user picked (its ytFormat travels in `meta`), NOT the bare page URL.
    // Passing a bare watch URL here downloads the page HTML and saves it under
    // the video's name — which looks exactly like "AiDM can't download video".
    let added;
    try {
      added = dm.addDownload({
        url: (row && row.url) || canonicalUrl,
        filename: (row && row.filename) || undefined,
        meta: {
          ytUrl: (row && row.ytUrl) || canonicalUrl,
          ytFormat: (row && row.ytFormat) || null,
          pageUrl: canonicalUrl,
          provider: (row && row.provider) || 'youtube',
        },
      });
    } catch (e) {
      done(e);
      return;
    }
    if (!added || !added.id) { done(new Error('addDownload() returned no row')); return; }

    // addDownload() leaves the row in `pending-approval` — that is AiDM's
    // "pick a folder / name" dialog, and nothing advances it headlessly.
    // approveDownload() is what the UI calls; it sets the path and starts the
    // row. Skipping it was why the row sat at 0 bytes forever.
    try {
      dm.approveDownload(added.id, outDir, (row && row.filename) || undefined);
    } catch (e) {
      done(new Error('approveDownload() failed: ' + (e && e.message)));
      return;
    }

    // Safety net: also poll, in case the row settles without an event.
    const poll = setInterval(() => {
      if (settled) { clearInterval(poll); return; }
      const row = dm.downloads.get(added.id);
      if (!row) return;
      if (row.status === 'completed') { clearInterval(poll); done(null, row); }
      else if (row.status === 'error') { clearInterval(poll); done(new Error(row.error || 'row failed')); }
    }, 500);
  });
}

function parseArgs(argv) {
  const o = { url: DEFAULT_URL, quality: null, audio: false, subs: null, manager: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--audio') { o.audio = true; continue; }
    if (a === '--mp3') { o.audio = true; o.mp3 = true; continue; }
    if (a === '--manager') { o.manager = true; continue; }
    if (a === '--subs') { o.subs = argv[++i] || 'en.*'; continue; }
    if (a === '--dir') { o.dir = argv[++i]; continue; }
    if (a === '--keep') { o.keep = true; continue; }
    if (a === '--quality') { o.quality = argv[++i]; continue; }
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    if (!a.startsWith('-')) o.url = a;
  }
  return o;
}

function hr(t) { return '─'.repeat(t || 62); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node tools/verify-youtube-live.js [url] [--quality 720p] [--audio] [--mp3] [--subs en.*]');
    return 0;
  }

  console.log(hr());
  console.log('AiDM — live YouTube engine check');
  console.log(hr());

  // 1 ── engine present?
  const runner = await ytdlp.detectRunner(true);
  if (!runner) {
    console.log('FAIL  ' + ytdlp.ytdlpMissingMessage());
    return 1;
  }
  console.log('yt-dlp      : ' + runner.version + '  (' + runner.source + ')');
  console.log('url         : ' + args.url);

  // 2 ── probe (metadata only, no download)
  let info;
  try {
    info = await ytdlp.probe(args.url, { timeoutMs: 90000 });
  } catch (e) {
    console.log('FAIL  probe: ' + (e && e.message));
    return 1;
  }
  console.log('title       : ' + info.title);
  console.log('channel     : ' + (info.channel || info.uploader || '-'));
  console.log('duration    : ' + (info.duration || '-') + 's');

  // 3 ── choices the resolver would offer in the picker
  const choices = yt.buildChoices(info, { maxChoices: 10, includeAudio: true });
  console.log(hr());
  console.log('picker choices (' + choices.length + '):');
  for (const c of choices) {
    console.log('  ' + String(yt.choiceLabel(c)).padEnd(34) +
      (c.size ? (c.size / 1048576).toFixed(1) + ' MB' : '-') +
      (c.audioOnly ? '   [audio-only]' : ''));
  }

  // 4 ── pick one: explicit quality, or audio-only, or best
  let choice = choices[0];
  if (args.audio) {
    const audio = choices.filter(c => c.audioOnly);
    choice = (args.mp3 ? audio.find(c => c.mp3) : audio.find(c => !c.mp3)) || audio[0] || choice;
  } else if (args.quality) {
    const want = parseInt(String(args.quality), 10);
    const capped = choices.filter(c => !c.audioOnly && c.height > 0 && c.height <= want);
    if (capped.length) choice = capped[0];
    else console.log('note  no choice at or below ' + args.quality + ' — using best');
  }
  const spec = yt.buildFormatSpec(choice);
  console.log(hr());
  console.log('selected     : ' + yt.choiceLabel(choice) + '   (-f ' + spec + ')');

  // 5 ── download. Two modes:
  //      default  → src/yt-dlp.js directly (engine-level, choice selectable)
  //      --manager → DownloadManager.addDownload() (the real user path)
  const outDir = args.dir
    ? (fs.mkdirSync(args.dir, { recursive: true }), args.dir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-yt-'));
  const tpl = path.join(outDir, 'AiDM YouTube check.%(ext)s');

  let file = null;
  let pickedAudioOnly = !!choice.audioOnly;

  if (args.manager) {
    // Exactly what main.js does for a pasted page URL: resolve → picker → the
    // row the user picked goes to addDownload(). A bare URL must never reach
    // the manager, or the WATCH PAGE is saved as "*.mp4".
    const resolvers = require('../src/resolvers');
    console.log('mode         : real DownloadManager (resolve → picker → add)');
    if (!resolvers.hasResolverFor(args.url)) {
      console.log('note  no resolver claims this URL — adding it directly would save the page HTML');
    }

    let resolved;
    try {
      resolved = await resolvers.resolveMedia(args.url, {});
    } catch (e) {
      console.log('FAIL  resolveMedia: ' + (e && e.message));
      return 1;
    }
    const picks = (resolved && resolved.pickerVideos) || [];
    if (!picks.length) {
      console.log('FAIL  resolver produced no picker rows (' + ((resolved && resolved.error) || 'unknown') + ')');
      return 1;
    }

    // Same preference order as the direct mode, applied to picker rows.
    let pick = picks[0];
    if (args.mp3) pick = picks.find((p) => p.quality === 'Audio (MP3)') || pick;
    else if (args.audio) pick = picks.find((p) => p.quality === 'Audio') || pick;
    else if (args.quality) {
      const want = parseInt(String(args.quality), 10);
      const capped = picks.filter((p) => !p.audioOnly && Number(p.ytFormat && p.ytFormat.height) > 0
        && Number(p.ytFormat.height) <= want);
      if (capped.length) pick = capped[0];
    }
    pickedAudioOnly = !!pick.audioOnly;
    console.log('picked       : ' + pick.quality + '  →  ' + pick.filename);
    console.log('saving into  : ' + outDir + ' …');

    let row;
    try {
      row = await managerDownload({
        row: pick,
        canonicalUrl: resolved.canonicalUrl || args.url,
        outDir,
        timeoutMs: 12 * 60 * 1000,
        onProgress: (p) => {
          process.stdout.write('\r  ' + String(p.percent != null ? p.percent : '').padStart(5) +
            '%  ' + (p.speed ? (p.speed / 1048576).toFixed(1) + ' MB/s' : '        ') + '   ');
        },
      });
    } catch (e) {
      process.stdout.write('\n');
      console.log('FAIL  manager: ' + (e && e.message));
      return 1;
    }
    process.stdout.write('\n');
    file = (row && (row.filepath || row.filename)) || null;
    if (file && !path.isAbsolute(file)) file = path.join(outDir, file);
    if (!file || !fs.existsSync(file)) {
      console.log('FAIL  manager reported completion but no file is on disk: ' + file);
      return 1;
    }
    console.log('row status   : ' + (row.status || 'completed'));
  } else {
  console.log('downloading into ' + outDir + ' …');

  let result;
  try {
    result = await ytdlp.download({
      url: args.url,
      formatSpec: spec,
      outputTemplate: tpl,
      // Same two sources the manager uses: flags the choice needs (MP3
      // re-encode) plus the subtitle preference (empty ⇒ no sidecars).
      extraArgs: [
        ...yt.buildExtraArgs(choice),
        ...ytdlp.buildSubtitleArgs(args.subs ? { langs: args.subs, auto: true } : {}),
      ],
      timeoutMs: 10 * 60 * 1000,
      expectedBytes: choice.size || 0,
      onProgress: (p) => {
        process.stdout.write('\r  ' + String(p.percent).padStart(5) + '%  ' +
          (p.speed ? (p.speed / 1048576).toFixed(1) + ' MB/s' : '        ') + '   ');
      },
    });
  } catch (e) {
    process.stdout.write('\n');
    console.log('FAIL  download: ' + (e && e.message));
    return 1;
  }
  process.stdout.write('\n');

  file = ytdlp.producedFileFor(tpl);
  if (!file) { console.log('FAIL  yt-dlp finished but no file was produced'); return 1; }
  } // end direct-engine mode

  const st = fs.statSync(file);
  console.log('file         : ' + path.basename(file));
  console.log('size         : ' + st.size + ' bytes (' + (st.size / 1048576).toFixed(1) + ' MB)');

  // 6 ── the check that matters: real geometry + a real audio track
  const probe = await mediaProbe.probeFile(file, { maxBytes: 12 * 1024 * 1024 });
  if (!probe) {
    console.log('FAIL  media-probe could not read the produced file');
    return 1;
  }
  console.log(hr());
  console.log('container    : ' + (probe.container || '-'));
  console.log('video        : ' + (probe.hasVideo ? (probe.width + 'x' + probe.height +
    '  ' + (probe.videoCodec || '')) : 'none'));
  console.log('audio        : ' + (probe.hasAudio ? (probe.audioCodec || 'present') : 'NONE'));

  const wantsVideo = !pickedAudioOnly;
  const ok = wantsVideo
    ? (probe.hasVideo && probe.hasAudio)
    : probe.hasAudio;
  console.log(hr());
  console.log(ok ? 'PASS  AiDM saved a real, playable ' + (wantsVideo ? 'video (picture + sound)' : 'audio file') + '.'
                : 'FAIL  produced file is missing ' + (wantsVideo ? 'an audio track' : 'audio') + '.');
  console.log(hr());

  // Leave nothing behind on success/failure alike — this is a check, not a download.
  // --keep leaves the file for an independent check (e.g. ffprobe) instead of
  // deleting it; without it this is a check, not a download, so nothing stays.
  if (!args.keep) {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  } else {
    console.log('kept         : ' + outDir);
  }
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.log('FAIL  unexpected: ' + (e && e.stack || e));
  process.exit(1);
});
