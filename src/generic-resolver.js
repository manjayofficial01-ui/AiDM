// @ts-check
// Generic yt-dlp page resolver for the long tail of video sites.
//
// The strict resolvers cover Twitter/Facebook/embeds/hosters/YouTube; pasting
// a Vimeo/TikTok/Reddit/Twitch-clip page used to download the page HTML.
// yt-dlp already speaks all of those sites, so this resolver runs the same
// probe→variants pipeline the YouTube path uses, but stays inside the
// provider-agnostic picker flow: it returns DIRECT progressive MP4 (or HLS)
// URLs from the info dict, so the chosen row downloads through AiDM's own
// engine like any other media URL.
//
// Deliberate limits:
//   • supports() is a strict host+path allowlist — no "try yt-dlp on every
//     unknown URL" (that would route plain file downloads through a probe).
//   • DASH-only catalogs (picture and sound in separate formats) are NOT
//     offered: merging belongs to the dedicated YouTube pipeline, and an
//     engine row with video-only would be the "silent video" bug again.

const ytdlp = require('./yt-dlp');

// host -> path pattern. Anchored; digits-only ids keep media CDN URLs out.
const PATTERNS = [
  { provider: 'vimeo', host: /^player\.vimeo\.com$/, path: /^\/video\/(\d+)\/?$/ },
  { provider: 'vimeo', host: /^(?:www\.)?vimeo\.com$/, path: /^\/(?:[^/]+\/[^/]+\/)?(\d+)\/?(?:\?.*)?$/ },
  { provider: 'tiktok', host: /^(?:www\.|m\.)?tiktok\.com$/, path: /^\/@(?:[\w.\-']+)\/video\/(\d+)\/?$/ },
  { provider: 'reddit', host: /^(?:www\.|old\.)?reddit\.com(?:\.redd\.it)?$/, path: /^\/r\/[^/]+\/comments\/([a-z0-9]{1,10})\//i },
  { provider: 'reddit', host: /^redd\.it$/, path: /^\/([a-z0-9]{1,10})\/?$/i },
  { provider: 'twitch', host: /^clips\.twitch\.tv$/, path: /^\/([\w-]+)\/?$/ },
  // On channel clip pages the clip id is the second segment.
  { provider: 'twitch', host: /^(?:www\.)?twitch\.tv$/, path: /^\/([\w-]+)\/clip\/([\w-]+)\/?$/, idGroup: 2 },
];

function matchPattern(url) {
  let u;
  try { u = new URL(String(url == null ? '' : url).trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // A URL that already points at a media file is never a page to resolve.
  if (/\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|opus|ogg|flac|wav|zip|rar|7z|tar|gz|exe|msi|iso|pdf|jpg|jpeg|png|gif|webp)$/i.test(u.pathname)) return null;
  const host = u.hostname.toLowerCase();
  for (const p of PATTERNS) {
    if (!p.host.test(host)) continue;
    const m = p.path.exec(u.pathname);
    if (m) return { provider: p.provider, id: m[p.idGroup || 1] };
  }
  return null;
}

function isGenericVideoUrl(url) {
  return !!matchPattern(url);
}

function safeTitle(title) {
  return String(title || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'video';
}

function extFor(fmt, isHls) {
  if (isHls) return 'mp4';
  const c = String(fmt.ext || fmt.container || 'mp4').toLowerCase();
  return ['mp4', 'mov', 'webm', 'mkv'].includes(c) ? c : 'mp4';
}

/**
 * Resolve a supported page URL into direct media variants (best progressive
 * first). Throws a clean error when only DASH/pair formats exist.
 */
async function resolveGenericVideo(url, opts = {}) {
  const match = matchPattern(url);
  if (!match) throw new Error('Not a supported video page URL');
  const runner = await ytdlp.detectRunner();
  if (!runner) throw new Error(ytdlp.ytdlpMissingMessage());

  const pageUrl = String(url).trim();
  let info;
  try {
    info = await ytdlp.probe(pageUrl, {
      timeoutMs: opts.timeoutMs || 60000,
      cookies: opts.cookies || null,
      referer: opts.referer || pageUrl,
      cookiesFromBrowser: opts.cookiesFromBrowser || null,
      proxy: opts.proxy || null,
    });
  } catch (e) {
    if (e && (e.code === 'missing' || /yt-dlp was not found/i.test(e.message || ''))) {
      throw new Error(ytdlp.ytdlpMissingMessage());
    }
    throw new Error(`Could not resolve this ${match.provider} video: ${e.message || String(e)}`);
  }

  const formats = Array.isArray(info && info.formats) ? info.formats : [];
  const playable = formats.filter(f => f && typeof f.url === 'string' && f.url && !/\/-/i.test(f.format_note || ''));
  const isStream = (f) =>
    /m3u8|\.mpd|ism\/? Manifest/i.test(String(f.url || '')) ||
    /m3u8|hls|dash|ism/i.test(String(f.protocol || ''));
  const progressive = playable
    .filter(f =>
      String(f.vcodec || 'none') !== 'none' &&
      String(f.acodec || 'none') !== 'none' &&
      /^https?:/i.test(String(f.protocol || 'https')) &&
      !isStream(f))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));

  const media = [];
  const seen = new Set();
  for (const f of progressive) {
    const label = f.height ? `${f.height}p` : (f.format_note || `${f.format_id}`);
    if (seen.has(label)) continue;
    seen.add(label);
    media.push({
      type: 'video',
      url: f.url,
      mime: 'video/mp4',
      width: f.width || undefined,
      height: f.height || undefined,
      bitrate: f.tbr ? Math.round(f.tbr * 1000) : undefined,
      quality: label,
      format: 'mp4',
      filename: `${safeTitle(info.title)} [${match.id}] ${label}.${extFor(f)}`,
      directUrl: true,
    });
    if (media.length >= 4) break;
  }

  if (!media.length) {
    // HLS master/variant manifests are downloadable by AiDM's HLS engine.
    const hls = playable
      .filter(f => /m3u8/i.test(f.url || '') || /m3u8|hls/i.test(f.protocol || ''))
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (hls) {
      media.push({
        type: 'video',
        url: hls.url,
        mime: 'application/x-mpegurl',
        width: hls.width || undefined,
        height: hls.height || undefined,
        quality: hls.height ? `${hls.height}p` : 'HLS',
        format: 'hls',
        filename: `${safeTitle(info.title)} [${match.id}].mp4`,
        directUrl: true,
      });
    }
  }

  if (!media.length) {
    throw new Error(
      `This ${match.provider} video is served only as adaptive DASH/HLS tracks ` +
      'that AiDM cannot merge outside its YouTube pipeline. ' +
      'If a single-file variant exists it will be offered on a retry.'
    );
  }

  const pickerVideos = media.map(m => ({
    url: m.url,
    filename: m.filename,
    quality: m.quality || 'auto',
    resolution: m.width && m.height ? `${m.width}x${m.height}` : null,
    format: m.format,
    isMp4: m.format === 'mp4',
    codec: null,
    size: null,
  }));

  return {
    provider: match.provider,
    id: match.id,
    title: (info && info.title) || undefined,
    thumbnail: (info && info.thumbnail) || undefined,
    duration: (info && info.duration) || undefined,
    canonicalUrl: (info && info.webpage_url) || pageUrl,
    referer: pageUrl,
    media,
    pickerVideos,
  };
}

const genericMediaResolver = {
  name: 'generic',

  supports(url) {
    try { return isGenericVideoUrl(url); } catch (e) { return false; }
  },

  async resolve(url, opts) {
    return resolveGenericVideo(url, opts || {});
  },
};

module.exports = {
  isGenericVideoUrl,
  matchPattern,
  resolveGenericVideo,
  genericMediaResolver,
  PATTERNS,
};
