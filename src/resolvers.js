/**
 * Provider-neutral media resolver layer.
 *
 * One interface, many providers. The queue, retries, pause/resume, filename
 * generation, progress reporting, concurrency control and file writing in the
 * engine/manager stay completely provider-independent — a resolver only turns
 * a page URL into a normalised metadata + media list:
 *
 *   resolve(url) => {
 *     provider, id, username?, title?, thumbnail?, duration?,
 *     canonicalUrl?,
 *     media: [{ type: 'video'|'image', url, mime?, width?, height?,
 *               bitrate?, quality?, format?, filename?, preferred? }],
 *     pickerVideos: [...]   // optional provider-specific UI payload
 *   }
 *
 * Security rules baked in here (see the SSRF notes in the docs):
 *   • Resolvers must parse ONLY the post identifier out of a URL and never
 *     fetch arbitrary user-supplied URLs (no open-proxy /proxy?url=…).
 *   • Supports() is deliberately strict: a URL either cleanly belongs to a
 *     provider's known post format or it is not resolved at all.
 *   • The metadata source (endpoint, API, key) lives inside a resolver and
 *     can be swapped without touching the rest of the app.
 */

const twitterResolver = require('./twitter-resolver');
const embedResolver = require('./embed-resolver');
const facebookResolver = require('./facebook-resolver');
const youtubeResolver = require('./youtube-resolver');
const fileHostResolver = require('./filehost-resolver');

// ── Registry ──────────────────────────────────────────────────────────────────

const registry = [];

/**
 * Register a resolver. Resolvers are checked in registration order.
 * @param {{ name: string, supports: (url: string) => boolean,
 *            resolve: (url: string) => Promise<object> }} resolver
 */
function registerResolver(resolver) {
  if (!resolver || typeof resolver.supports !== 'function' || typeof resolver.resolve !== 'function') {
    throw new Error('Resolver must implement supports() and resolve()');
  }
  registry.push(resolver);
}

/** First resolver whose supports() returns true, or null. */
function findResolver(url) {
  for (const r of registry) {
    try { if (r.supports(url)) return r; } catch (e) { /* supports() must not throw upward */ }
  }
  return null;
}

function hasResolverFor(url) {
  return !!findResolver(url);
}

/** Run the matching resolver. Throws when no provider supports the URL. */
async function resolveMedia(url, opts) {
  const resolver = findResolver(url);
  if (!resolver) throw new Error('No resolver supports this URL');
  const resolved = await resolver.resolve(url, opts || {});

  // Provider-independent progressive-MP4 preference: flag the best MP4 in the
  // media list. Callers that just want "the best file" read this flag instead
  // of re-implementing per-provider quality heuristics.
  if (Array.isArray(resolved.media)) {
    const best = bestMP4(resolved.media);
    const winner = best && resolved.media.find(m => m.url === best.url);
    if (winner) winner.preferred = true;
  }
  return resolved;
}

// ── Strict X/Twitter URL parsing (identifier-only) ───────────────────────────
//
// Deliberately extracts ONLY the post username + id. Host allowlist means an
// arbitrary user URL is never passed to the metadata backend, and the anchored
// regex means things like `/status/123abc` or a random 19-digit number in a
// media URL can never be mistaken for a post id.

const TWITTER_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com']);

/**
 * @returns {{ username: string|null, statusId: string, canonicalUrl: string }}
 * @throws when the input is not a clean X/Twitter post URL
 */
function parseTwitterUrl(input) {
  let u;
  try {
    u = new URL(String(input == null ? '' : input).trim());
  } catch (e) {
    throw new Error('Invalid URL');
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!TWITTER_HOSTS.has(host)) throw new Error('Not an X/Twitter URL');

  // /username/status/123, /username/statuses/123, /i/web/status/123,
  // optional trailing path (/photo/1) — nothing else.
  const m = u.pathname.match(/^\/(?:i\/web\/)?(?:(\S+)\/)?status(?:es)?\/(\d{5,25})(?:\/.*)?$/);
  if (!m) throw new Error('Not a Twitter/X post URL');

  const username = m[1] || null;
  return {
    username,
    statusId: m[2],
    canonicalUrl: username
      ? `https://x.com/${username}/status/${m[2]}`
      : `https://x.com/i/web/status/${m[2]}`,
  };
}

// ── Provider-independent variant selection ────────────────────────────────────

/**
 * Pick the best progressive MP4 from a variant list — independent of any
 * provider. Prefers resolution, then bitrate. Returns null when the list has
 * no MP4 (e.g. HLS-only), leaving the caller free to decide what to do.
 */
function bestMP4(variants) {
  return (variants || [])
    .filter(v => v && (
      v.mime === 'video/mp4' ||
      v.isMp4 === true ||
      (typeof v.url === 'string' && /\.mp4(?:\?|$)/i.test(v.url))
    ))
    .sort((a, b) =>
      ((b.height || 0) - (a.height || 0)) ||
      ((b.bitrate || 0) - (a.bitrate || 0))
    )[0] || null;
}

// ── Twitter/X resolver (first provider) ───────────────────────────────────────
// Wraps src/twitter-resolver.js (the syndication-endpoint client + parser).
// Swapping the metadata source for the official X API later means editing only
// this adapter — the endpoint, rate limiting and UI keep working unchanged.

const twitterMediaResolver = {
  name: 'twitter',

  supports(url) {
    try { parseTwitterUrl(url); return true; } catch (e) { return false; }
  },

  async resolve(url) {
    const parsed = parseTwitterUrl(url);
    const { tweetId, videos, author, title, thumbnail, duration } =
      await twitterResolver.resolveTweetVideos(parsed.canonicalUrl);

    // Report-shaped media list, best progressive MP4 first.
    const media = videos.map(v => ({
      type: 'video',
      url: v.url,
      mime: v.contentType,
      width: v.width || undefined,
      height: v.height || undefined,
      bitrate: v.bitrate || undefined,
      quality: v.quality || undefined,
      format: v.isMp4 ? 'mp4' : 'hls',
      filename: v.filename,
    }));

    return {
      provider: 'twitter',
      id: tweetId,
      username: author || parsed.username,
      title,
      thumbnail,
      duration,
      canonicalUrl: parsed.canonicalUrl,
      media,
      // UI payload for the existing quality picker (filename + labels).
      pickerVideos: twitterResolver.toPickerVideos(videos),
    };
  },
};

registerResolver(twitterMediaResolver);

// ── mydaddy.cc / hqporner.com embed resolver (second provider) ───────────────
// hqporner `/hdporn/` pages hold no direct media (mydaddy iframe embed), and
// the CDN links inside the player are short-lived — so pasting either page URL
// resolves fresh MP4 variants server-side at click time, exactly like the
// Twitter resolver does for tweets. Swapping the page-parsing strategy later
// means editing only src/embed-resolver.js.

const embedMediaResolver = {
  name: 'embed',

  supports(url) {
    try { return embedResolver.isEmbedUrl(url); } catch (e) { return false; }
  },

  async resolve(url) {
    const r = await embedResolver.resolveEmbedVideos(url);

    const media = r.videos.map(v => {
      let width, height;
      const rm = /^(\d+)x(\d+)$/.exec(v.resolution || '');
      if (rm) { width = parseInt(rm[1], 10); height = parseInt(rm[2], 10); }
      const isHls = v.format === 'hls' || /\.m3u8(\?|#|$)/i.test(v.url);
      return {
        type: 'video',
        url: v.url,
        mime: isHls ? 'application/x-mpegurl' : 'video/mp4',
        width: width || undefined,
        height: height || undefined,
        quality: v.quality || undefined,
        format: isHls ? 'hls' : 'mp4',
        filename: v.filename,
      };
    });

    return {
      provider: r.provider,
      id: r.id,
      title: r.title,
      thumbnail: r.thumbnail,
      duration: r.duration,
      canonicalUrl: r.canonicalUrl,
      referer: r.referer,
      media,
      // UI payload for the existing quality picker (filename + labels).
      pickerVideos: embedResolver.toPickerVideos(r.videos),
    };
  },
};

registerResolver(embedMediaResolver);

// ── Facebook / Instagram page resolver (third provider) ────────────────────
// A pasted facebook.com/watch (reel, fb.watch, instagram reel/p/tv) URL used
// to fall through to a direct download of the page HTML itself — the classic
// "AiDM can't download Facebook videos". Resolving the page server-side into
// fresh progressive MP4s (hd_src/sd_src/playable_url/…) at click time gives
// the quality picker real files, exactly like the Twitter resolver does.

const facebookMediaResolver = {
  name: 'facebook',

  supports(url) {
    try { return facebookResolver.isFacebookUrl(url); } catch (e) { return false; }
  },

  async resolve(url, opts) {
    const r = await facebookResolver.resolveFacebookVideos(url, opts || {});

    const media = r.videos.map(v => {
      let width, height;
      const rm = /^(\d+)x(\d+)$/.exec(v.resolution || '');
      if (rm) { width = parseInt(rm[1], 10); height = parseInt(rm[2], 10); }
      const isHls = v.format === 'hls' || /\.m3u8(\?|#|$)/i.test(v.url);
      return {
        type: 'video',
        url: v.url,
        mime: isHls ? 'application/x-mpegurl' : 'video/mp4',
        width: width || undefined,
        height: height || undefined,
        quality: v.quality || undefined,
        format: isHls ? 'hls' : 'mp4',
        filename: v.filename,
        audioUrl: v.audioUrl || undefined,
      };
    });

    return {
      provider: r.provider,
      id: r.id,
      title: r.title,
      thumbnail: r.thumbnail,
      duration: r.duration,
      canonicalUrl: r.canonicalUrl,
      referer: r.referer,
      media,
      // UI payload for the existing quality picker (filename + labels).
      pickerVideos: facebookResolver.toPickerVideos(r.videos),
    };
  },
};

registerResolver(facebookMediaResolver);

// ── File-hoster resolver (fourth provider: Rapidgator …) ────────────────────
// A pasted rapidgator.net file page used to fall through to a direct download
// of the page HTML itself — the classic "AiDM can't download Rapidgator".
// src/filehost-resolver.js turns the page (or the hoster's API, when the user
// saved an account in Settings › File hosts) into one real, directly
// downloadable file URL.
//
// Two things make hoster links different from media links, and the row carries
// both so the engine can honour them:
//   • `singleConnection: true` — hoster links routinely reject Range requests,
//     and a multi-segment download of one produces a corrupt file.
//   • `resumable: false` — a free/premium hoster link is single-use and signed.
//
// Registered before YouTube: a hoster URL can never look like a YouTube watch
// URL, and YouTube's grammar stays the strictest of all.

const fileHostMediaResolver = fileHostResolver.fileHostMediaResolver;

registerResolver(fileHostMediaResolver);

// ── YouTube watch-page resolver (fifth provider) ────────────────────────────
// A pasted youtube.com/watch?v=… URL used to be downloaded as the page's HTML.
// yt-dlp resolves it into real stream URLs instead; progressive (single-file)
// variants keep AiDM's multi-segment engine, while DASH picture+sound pairs
// are downloaded and merged by yt-dlp itself. See docs/YOUTUBE-ENGINE.md.
//
// The resolver is registered LAST: its URL grammar is the strictest, and no
// other provider's URL can look like a canonical YouTube watch URL.

const youtubeMediaResolver = youtubeResolver.youtubeMediaResolver;

registerResolver(youtubeMediaResolver);

module.exports = {
  registerResolver,
  findResolver,
  hasResolverFor,
  resolveMedia,
  parseTwitterUrl,
  bestMP4,
  twitterMediaResolver,
  embedMediaResolver,
  facebookMediaResolver,
  fileHostMediaResolver,
  youtubeMediaResolver,
  youtubeResolver,
  fileHostResolver,
};
