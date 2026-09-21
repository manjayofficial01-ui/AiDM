/**
 * YouTube resolver — turns a watch PAGE url into real, downloadable media.
 *
 * Same contract as the Twitter / Facebook / embed resolvers (see
 * src/resolvers.js): strict identifier-only URL parsing, then provider-
 * specific extraction. Two things make YouTube different:
 *
 *   1. The page contains no direct file. yt-dlp runs the player logic and
 *      returns fresh, SIGNED, EXPIRING stream URLs (src/yt-dlp.js).
 *   2. Above ~720p YouTube serves PICTURE and SOUND as SEPARATE DASH tracks.
 *      Handing a bare video URL to the segment engine would save a silent
 *      file, so those choices are handed to yt-dlp whole (extract → download
 *      → merge with the bundled FFmpeg). Progressive (single-file) choices
 *      keep AiDM's native multi-segment engine, which is faster and resumable.
 *
 * The split is decided by `isChoiceFresh()` + `choice.progressive`, and the
 * decision travels with the row (download.ytFormat) so a restart or a resume
 * re-resolves from the canonical page URL instead of a dead stream URL.
 *
 * Legal scope: this downloads media the user can already watch. It does NOT
 * bypass age gates, members-only walls, sign-in checks, region locks, paid
 * rentals or DRM — those are reported as failures (see src/yt-dlp.js
 * classifyError) and never worked around.
 */

const path = require('path');
const ytdlp = require('./yt-dlp');
const { cleanPageTitle } = require('./titles');

// ── Strict URL parsing ───────────────────────────────────────────────────────
//
// Only the 11-character video id survives. Everything else the user pasted —
// host, query string, fragment, credentials, port — is discarded and rebuilt
// into a canonical https://www.youtube.com/watch?v=<id>. That is both an SSRF
// guard (no arbitrary host ever reaches the extractor) and the reason the row
// can be re-resolved later after the signed stream URL expires.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

/**
 * @returns {string|null} video id, or null when the input is not a YouTube
 *          video URL. Never throws — `supports()` depends on that.
 */
function parseYouTubeVideoId(input) {
  try {
    return normalizeYouTubeUrl(input).split('v=')[1] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Normalise any YouTube video URL (or bare id) to the canonical watch URL.
 * @throws {Error} when the input is not a clean YouTube video URL.
 */
function normalizeYouTubeUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('Not a YouTube video URL');

  // Bare 11-character id (users paste these from the "Copy video ID" menu).
  if (VIDEO_ID.test(raw)) return 'https://www.youtube.com/watch?v=' + raw;

  // Tolerate a missing scheme in a pasted link ("youtube.com/watch?v=…").
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : 'https://' + raw;

  let u;
  try { u = new URL(withScheme); } catch (e) { throw new Error('Not a valid URL'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Not a YouTube video URL');
  if (u.username || u.password) throw new Error('Not a YouTube video URL');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('Not a YouTube video URL');

  const host = (u.hostname || '').toLowerCase();
  const segments = u.pathname.split('/').filter(Boolean);

  let videoId = null;
  if (SHORT_HOSTS.has(host) && segments.length === 1) {
    videoId = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (u.pathname.replace(/\/+$/, '') === '/watch') {
      videoId = u.searchParams.get('v') || '';
    } else if (segments.length === 2 && (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live' || segments[0] === 'v')) {
      videoId = segments[1];
    }
  }

  if (!videoId || !VIDEO_ID.test(videoId)) throw new Error('Not a YouTube video URL');
  return 'https://www.youtube.com/watch?v=' + videoId;
}

function isYouTubeUrl(url) {
  try { normalizeYouTubeUrl(url); return true; } catch (e) { return false; }
}

// ── Signed-URL expiry ────────────────────────────────────────────────────────
// YouTube CDN URLs carry `expire=<unix-seconds>`. Reading it tells us whether a
// stream URL is still worth handing to the native engine.

function extractExpiry(url) {
  try {
    const m = /[?&]expire=(\d{6,})/.exec(String(url || ''));
    if (!m) return null;
    const secs = Number(m[1]);
    if (!isFinite(secs)) return null;
    return secs * 1000;
  } catch (e) {
    return null;
  }
}

// ── Format selection ─────────────────────────────────────────────────────────
// Pure over the yt-dlp info dict, so the test suite can assert the mapping
// without network access or an installed yt-dlp.

const BYTES = (f) => (f && (f.filesize || f.filesize_approx)) || 0;

/**
 * Size of a format, ESTIMATED when yt-dlp does not report one.
 *
 * Newer DASH itags (269, 230, 270 …) carry a real `tbr` but report
 * `filesize: 0`. Reading the raw filesize alone collapsed every picker row to
 * the audio track's size — 144p and 1080p showed the same number — and the
 * same wrong value is what feeds `expectedBytes`, so the progress bar ran on
 * a total that ignored the whole video track. `tbr x duration` is the same
 * estimate yt-dlp itself uses to fill `filesize_approx`.
 *
 * Pure: no duration (or no bitrate) means "unknown", never a guess.
 */
function estimatedBytes(f, durationSec) {
  const known = BYTES(f);
  if (known > 0) return known;
  const tbr = Number(f && f.tbr) || 0;      // kbit/s
  const dur = Number(durationSec) || 0;     // seconds
  if (tbr > 0 && dur > 0) return Math.round((tbr * 1000 * dur) / 8);
  return 0;
}

/**
 * How well an audio-only format fits an MP4 merge.
 *
 * M4A/AAC is what the MP4 container wants: yt-dlp can copy it in with no
 * re-encode and the result plays everywhere. Opus/Vorbis (WebM) must be
 * transcoded, which costs time and can silently produce an .mkv instead of
 * the .mp4 the row advertises — so it ranks below ANY AAC track, whatever
 * its bitrate.
 */
function audioScore(f) {
  if (!f) return -Infinity;
  const ext = String(f.ext || '').toLowerCase();
  const ac = String(f.acodec || '').toLowerCase();
  let score = 0;
  if (ext === 'm4a' || ac.startsWith('mp4a') || ac.includes('aac')) score += 1000;
  else if (ext === 'mp4') score += 500;
  if (ext === 'webm' || ac.includes('opus') || ac.includes('vorbis')) score -= 400;
  score += Number(f.abr || f.tbr || 0) / 100;   // tie-break: louder track wins
  return score;
}

function pickBestAudio(audios) {
  return (audios || [])
    .slice()
    .sort((a, b) => audioScore(b) - audioScore(a))[0] || null;
}

/**
 * Real geometry of a choice, as `'<width>x<height>'`.
 *
 * HONESTY RULE: only yt-dlp's own width/height are used. When either is
 * missing the resolution is `undefined` — never a synthesised 16:9 number.
 * A fabricated width is what made a 360p row display as 2160p and made
 * every row on a page show the same resolution.
 */
function resolutionOfChoice(choice) {
  const c = choice || {};
  const h = Number(c.height) || 0;
  const w = Number(c.width) || 0;
  if (h <= 0 || w <= 0) return undefined;
  return w + 'x' + h;
}

/** Shown when a video genuinely has no audio stream at all. */
const NO_AUDIO_NOTE = 'This video has no audio track — the file will be silent.';

/**
 * HARD INVARIANT — never ship a silent file.
 *
 * A DASH video track (`itag 137`) is picture only: handing yt-dlp `-f 137`
 * saves a video with no sound. This repairs any choice that lost its audio
 * pick (stale persisted row, failed audio scan, hand-built choice) by
 * requesting audio explicitly. Audio-only and progressive choices already
 * carry sound and are returned untouched.
 */
function ensureAudioChoice(choice) {
  if (!choice) return choice;
  if (choice.audioOnly || choice.progressive) return choice;
  if (choice.audioFormatId) return choice;
  const v = String(choice.formatId || '');
  // Already a composite/selector spec ("bestvideo+bestaudio/best"): as good
  // as it gets, but it still never names a bare video id.
  if (!v || v.includes('+') || v.includes('/')) {
    return { ...choice, formatId: v || 'bestvideo+bestaudio/best' };
  }
  return { ...choice, formatId: v + '+bestaudio/best', audioGuaranteed: true };
}

/**
 * Build the downloadable choices, best first.
 * Progressive (one file, picture + sound) wins at a given height because it
 * needs no merge; otherwise the height is a DASH pair (video track + audio).
 */
function buildChoices(info, { maxChoices = 10, includeAudio = true } = {}) {
  const formats = Array.isArray(info && info.formats) ? info.formats : [];
  // Only used to estimate a size yt-dlp left at 0 — see estimatedBytes().
  const durationSec = Number(info && info.duration) || 0;
  const usable = formats.filter(f => f && f.url);
  const videos = usable.filter(f => f.vcodec && f.vcodec !== 'none' && f.height);
  const audios = usable.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  const audio = pickBestAudio(audios);

  const byHeight = new Map();
  // One entry per real height. The WHOLE candidate is swapped when a better
  // format wins, so the recorded width always belongs to the winning format —
  // a stale width from a lower-scoring format can never survive.
  const consider = (height, candidate) => {
    const h = Number(height);
    if (!isFinite(h) || h <= 0) return;
    const current = byHeight.get(h);
    if (!current || candidate.score > current.score) byHeight.set(h, candidate);
  };

  for (const f of videos) {
    const progressive = !!(f.acodec && f.acodec !== 'none');
    const isMp4 = f.ext === 'mp4' ? 1 : 0;
    // Score: progressive (single file) beats DASH; MP4 beats WebM; then bitrate.
    const score = (progressive ? 1000 : 0) + isMp4 * 100 + (f.tbr || 0) / 1000;
    consider(f.height, {
      score,
      height: Number(f.height),
      // Only yt-dlp's real width. 0 (never a 16:9 guess) when it is unknown.
      width: Number(f.width) || 0,
      progressive,
      formatId: f.format_id,
      audioFormatId: progressive ? null : (audio ? audio.format_id : null),
      ext: f.ext || (progressive ? 'mp4' : 'mp4'),
      size: progressive
        ? estimatedBytes(f, durationSec)
        : estimatedBytes(f, durationSec) + estimatedBytes(audio, durationSec),
      hasAudioSource: !progressive && !!audio,
      // Only a progressive URL is a usable FILE url. A DASH video track is
      // picture-only — exposing it would let the row (or a stale retry) save a
      // silent video — so it stays null and the page URL is used instead.
      url: progressive ? f.url : null,
      fps: f.fps || undefined,
      vcodec: f.vcodec,
      acodec: f.acodec,
      expiresAt: extractExpiry(f.url),
      extractedAt: Date.now(),
    });
  }

  let choices = [...byHeight.values()].sort((a, b) => b.height - a.height);

  // A DASH pair with no audio track is useless — drop it rather than offering
  // a guaranteed-silent download.
  choices = choices.filter(c => c.progressive || c.hasAudioSource);

  // Every surviving choice is stamped with its REAL resolution. Portrait,
  // 4:3 and cinemascope videos keep their own geometry; an unknown width
  // stays unknown instead of being invented.
  choices = choices.map((c) => ({ ...c, resolution: resolutionOfChoice(c) }));

  // Audio-only choice, always last: YouTube is mostly a music library and
  // AiDM has an audio category. M4A/AAC is preferred so the file plays
  // everywhere without re-encoding.
  if (includeAudio && audio && choices.length) {
    choices.push({
      score: -1,
      height: 0,
      progressive: false,
      audioOnly: true,
      formatId: 'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio',
      audioFormatId: null,
      ext: 'm4a',
      size: estimatedBytes(audio, durationSec),
      hasAudioSource: true,
      resolution: undefined,
      url: null,
      extractedAt: Date.now(),
      expiresAt: null,
    });

    // MP3, offered as its own choice rather than replacing the M4A pick.
    // YouTube's audio is AAC/Opus and plays fine almost everywhere, but MP3
    // is what people mean by "a file that works anywhere" — car stereos, old
    // phones, video editors. It costs one re-encode (FFmpeg, already
    // bundled), so it is the user's call, never the default.
    choices.push({
      score: -2,
      height: 0,
      progressive: false,
      audioOnly: true,
      mp3: true,
      formatId: 'bestaudio/best',
      audioFormatId: null,
      ext: 'mp3',
      size: estimatedBytes(audio, durationSec),
      hasAudioSource: true,
      resolution: undefined,
      url: null,
      extractedAt: Date.now(),
      expiresAt: null,
    });
  }

  if (!choices.length) {
    // Fallback: audio-only post (music), or an extractor that gave us no
    // height. Let yt-dlp choose — still merged to MP4 by the download step.
    //
    // The video may nevertheless be SILENT (some uploads carry no audio
    // stream at all). We cannot invent one, so instead of pretending, the
    // choice is tagged and every payload built from it surfaces the note —
    // the row must never quietly report a picture-only file as a success.
    const silent = formats.length > 0 && !audio && !videos.some(f => f.acodec && f.acodec !== 'none');
    choices = [{
      score: 0,
      height: 0,
      width: 0,
      progressive: false,
      formatId: 'bestvideo+bestaudio/best',
      audioFormatId: null,
      ext: 'mp4',
      size: BYTES(info) || 0,
      hasAudioSource: !silent,
      noAudioTrack: silent,
      audioNote: silent ? NO_AUDIO_NOTE : undefined,
      resolution: undefined,
      url: null,
      extractedAt: Date.now(),
      expiresAt: null,
      fallback: true,
    }];
  }

  // Last line of defence: nothing leaves this function that could produce a
  // picture-only file while claiming to be a normal video row.
  return choices.slice(0, maxChoices).map(ensureAudioChoice);
}

/** yt-dlp `-f` expression for a choice. */
function buildFormatSpec(choice) {
  const fixed = ensureAudioChoice(choice);
  if (!fixed) return 'bestvideo+bestaudio/best';
  // Progressive and audio-only specs are single/complete already.
  if (fixed.progressive || fixed.audioOnly) return String(fixed.formatId || 'best');
  if (fixed.audioFormatId) {
    return String(fixed.formatId || 'bestvideo') + '+' + fixed.audioFormatId;
  }
  // DASH video with no paired audio: `ensureAudioChoice` already appended
  // `+bestaudio/best`. Never a bare video id — that is the silent-file bug.
  return String(fixed.formatId || 'bestvideo+bestaudio/best');
}

/** Container a choice will produce, for naming and categorising the row. */
function choiceExt(choice) {
  if (!choice) return 'mp4';
  if (choice.audioOnly) return choice.ext || 'm4a';
  return 'mp4';
}

/**
 * Extra yt-dlp arguments a choice needs BEYOND its `-f` spec.
 *
 * It lives next to buildFormatSpec on purpose: the picker and the downloader
 * must never disagree about what a choice means. A choice that only sets `-f`
 * returns [] and changes nothing.
 *
 * Only ever real argv entries — never a shell string, so a crafted title or
 * URL can never inject a flag.
 */
function buildExtraArgs(choice) {
  const c = choice || {};
  if (c.mp3) return ['--extract-audio', '--audio-format', 'mp3'];
  return [];
}

function choiceLabel(choice) {
  if (!choice) return 'Best';
  if (choice.audioOnly) return choice.mp3 ? 'Audio (MP3)' : 'Audio';
  // Only the REAL height of the winning format — never a defaulted or stale
  // one, and never a value derived from a guessed width.
  const h = Number(choice.height) || 0;
  return h > 0 ? h + 'p' : 'Best';
}

/**
 * True when a choice can go through AiDM's native multi-segment engine
 * (faster, pause/resume, speed limits) instead of the yt-dlp handoff.
 * Only single-file (progressive) URLs qualify, and only while still fresh.
 */
function isChoiceFresh(choice, nowMs = Date.now()) {
  // Audio-only and DASH pairs always go through yt-dlp (they need extraction
  // and, for pairs, a merge).
  if (!choice || !choice.progressive || !choice.url) return false;
  if (choice.expiresAt) return choice.expiresAt - nowMs > 2 * 60 * 1000;
  // No expiry parameter: treat the URL as usable for a short window only —
  // the safest assumption for a signed CDN link.
  const age = nowMs - (choice.extractedAt || 0);
  return age >= 0 && age < 10 * 60 * 1000;
}

// ── Naming ───────────────────────────────────────────────────────────────────

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

function safeTitle(raw) {
  let s = String(raw || '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  // Windows reserved device names
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s.slice(0, 110);
}

/**
 * `Some Title [1080p].mp4` — readable, sorted-friendly, and never the
 * extractor's opaque id.
 */
function buildFilename({ title, id, height, ext = 'mp4' }) {
  const clean = cleanPageTitle(title, 'youtube.com') || safeTitle(title);
  const stem = (clean && clean.trim()) ? clean.trim() : ('youtube_' + (id || 'video'));
  const h = Number(height) || 0;
  const label = h > 0 ? ' [' + h + 'p]' : '';
  return safeTitle(stem + label) + '.' + (ext || 'mp4');
}

// ── Picker payload ───────────────────────────────────────────────────────────

function toPickerVideos(info, { canonicalUrl, id, title } = {}) {
  return buildChoices(info).map((c) => ({
    url: c.url || canonicalUrl,          // progressive: real stream URL; DASH: page URL (re-resolved at start)
    quality: choiceLabel(c),
    // Real geometry or nothing. One shared helper keeps the picker row, the
    // media entry and the filename tag in agreement.
    resolution: c.audioOnly ? undefined : resolutionOfChoice(c),
    size: c.size || undefined,
    format: choiceExt(c),
    filename: buildFilename({ title, id, height: c.audioOnly ? 0 : c.height, ext: choiceExt(c) }),
    audioOnly: !!c.audioOnly,
    noAudioTrack: !!c.noAudioTrack,
    audioNote: c.audioNote || undefined,
    // ── yt-dlp handoff payload (survives into download.meta) ──
    provider: 'youtube',
    ytUrl: canonicalUrl,
    ytFormat: {
      formatId: c.formatId,
      audioFormatId: c.audioFormatId || null,
      progressive: !!c.progressive,
      audioOnly: !!c.audioOnly,
      height: c.height || 0,
      width: c.width || 0,
      resolution: c.audioOnly ? undefined : resolutionOfChoice(c),
      size: c.size || 0,
      noAudioTrack: !!c.noAudioTrack,
      expiresAt: c.expiresAt || null,
      extractedAt: c.extractedAt || Date.now(),
      url: c.url || null,
    },
    merged: !c.progressive,
  }));
}

// ── Resolver ─────────────────────────────────────────────────────────────────

// Failures where the video itself may still be downloadable. YouTube refuses
// the metadata PROBE ("Sign in to confirm you're not a bot") far more often
// than it refuses the media, and the handoff re-extracts at start anyway — so
// a blocked preview must not block the download. Offering one "Best available"
// row lets the user try; nothing about it bypasses access control (no cookies,
// no auth, no alternative client — the same yt-dlp call runs at start).
// Genuine access failures (private, members-only, age, removed, live) are NOT
// retried: they cannot succeed, so they stay errors.
const RETRYABLE_PROBE_CODES = new Set(['bot-check', 'timeout', 'extract', 'parse']);

/** Minimal payload used when the probe is blocked but the video may still work. */
function fallbackPayload(canonical, id, reason) {
  const choice = {
    formatId: 'bestvideo+bestaudio/best',
    audioFormatId: null,
    progressive: false,
    height: 0,
    width: 0,
    resolution: undefined,
    size: 0,
    expiresAt: null,
    extractedAt: Date.now(),
    url: null,
  };
  return {
    provider: 'youtube',
    id,
    title: undefined,
    canonicalUrl: canonical,
    probeError: reason || null,
    media: [{
      type: 'video',
      url: canonical,
      mime: 'video/mp4',
      format: 'mp4',
      filename: buildFilename({ title: null, id, height: 0 }),
      provider: 'youtube',
      ytUrl: canonical,
      ytFormat: { ...choice },
    }],
    pickerVideos: [{
      url: canonical,
      quality: 'Best',
      resolution: undefined,
      size: undefined,
      format: 'mp4',
      filename: buildFilename({ title: null, id, height: 0 }),
      provider: 'youtube',
      ytUrl: canonical,
      ytFormat: { ...choice },
      merged: true,
    }],
  };
}

async function resolveYouTubeVideos(url, opts = {}) {
  const canonical = normalizeYouTubeUrl(url);
  const id = canonical.split('v=')[1];

  let info;
  try {
    // A private / members-only / age-confirmed video cannot even be LISTED
    // without the session, so the probe carries the same cookies the download
    // will use — otherwise the picker comes back empty for a logged-in user.
    info = await ytdlp.probe(canonical, {
      timeoutMs: opts.timeoutMs || 60000,
      cookies: opts.cookies || null,
      referer: opts.referer || null,
      cookiesFromBrowser: opts.cookiesFromBrowser || null,
    });
  } catch (e) {
    if (RETRYABLE_PROBE_CODES.has(e && e.code)) return fallbackPayload(canonical, id, e && e.message);
    throw e;
  }

  if (info && (info.is_live || info.was_live || info.live_status === 'is_live')) {
    throw new Error('This is a live stream — AiDM downloads finished videos only.');
  }

  const title = (info && info.title) || null;
  const choices = buildChoices(info);

  const media = choices.map((c) => ({
    type: c.audioOnly ? 'audio' : 'video',
    url: c.url || canonical,
    mime: c.audioOnly ? 'audio/mp4' : 'video/mp4',
    // 0 when unknown — never a 16:9 guess (see resolutionOfChoice).
    width: Number(c.width) || 0,
    height: Number(c.height) || 0,
    resolution: c.audioOnly ? undefined : resolutionOfChoice(c),
    quality: choiceLabel(c),
    format: choiceExt(c),
    filename: buildFilename({ title, id, height: c.audioOnly ? 0 : c.height, ext: choiceExt(c) }),
    provider: 'youtube',
    ytUrl: canonical,
    noAudioTrack: !!c.noAudioTrack,
    audioNote: c.audioNote || undefined,
    ytFormat: {
      formatId: c.formatId,
      audioFormatId: c.audioFormatId || null,
      progressive: !!c.progressive,
      audioOnly: !!c.audioOnly,
      height: c.height || 0,
      width: Number(c.width) || 0,
      resolution: c.audioOnly ? undefined : resolutionOfChoice(c),
      size: c.size || 0,
      noAudioTrack: !!c.noAudioTrack,
      expiresAt: c.expiresAt || null,
      extractedAt: c.extractedAt || Date.now(),
      url: c.url || null,
    },
    // Consumer note: with yt-dlp the URL is a signed stream URL, not a
    // permanent file — the row must be resolved again after a restart.
    expiresAt: c.expiresAt || null,
  }));

  return {
    provider: 'youtube',
    id,
    title: title || undefined,
    thumbnail: (info && info.thumbnail) || undefined,
    duration: (info && info.duration) || undefined,
    canonicalUrl: canonical,
    uploader: (info && (info.uploader || info.channel)) || undefined,
    media,
    pickerVideos: toPickerVideos(info, { canonicalUrl: canonical, id, title }),
  };
}

const youtubeMediaResolver = {
  name: 'youtube',

  supports(url) {
    try { return isYouTubeUrl(url); } catch (e) { return false; }
  },

  async resolve(url, opts) {
    return resolveYouTubeVideos(url, opts || {});
  },
};

module.exports = {
  VIDEO_ID,
  YOUTUBE_HOSTS,
  SHORT_HOSTS,
  parseYouTubeVideoId,
  normalizeYouTubeUrl,
  isYouTubeUrl,
  extractExpiry,
  buildChoices,
  buildFormatSpec,
  buildExtraArgs,
  choiceExt,
  choiceLabel,
  isChoiceFresh,
  buildFilename,
  safeTitle,
  toPickerVideos,
  resolveYouTubeVideos,
  fallbackPayload,
  // ── geometry (real, never guessed) ──
  resolutionOfChoice,
  // ── audio invariant ──
  pickBestAudio,
  audioScore,
  ensureAudioChoice,
  NO_AUDIO_NOTE,
  RETRYABLE_PROBE_CODES,
  youtubeMediaResolver,
  ytdlpMissingMessage: ytdlp.ytdlpMissingMessage,
};
