/**
 * Twitter / X video resolver (no authentication required).
 *
 * Background
 * ----------
 * Sniffing the page's GraphQL traffic is unreliable: the video metadata may be
 * server-rendered into the initial HTML, streamed, or compressed, and X changes
 * the response shape often. That is why "capture the network" detection breaks.
 *
 * This module instead uses X's public *syndication* endpoint, which returns a
 * tweet's media metadata as JSON for anyone, with no login and no API key:
 *
 *   GET https://cdn.syndication.twimg.com/tweet-result?id=<tweetId>&token=<token>
 *
 * The token is derived from the tweet id with X's own published formula:
 *
 *   ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
 *
 * The JSON contains `mediaDetails[].video_info.variants[]`, which lists BOTH
 * the HLS playlist and — crucially — the direct, unencrypted MP4 files at
 * video.twimg.com (e.g. .../pu/vid/1280x720/<hash>.mp4). Those MP4s download
 * with a plain GET (verified: HTTP 200, video/mp4, no cookies or Referer).
 *
 * IMPORTANT: the syndication endpoint sends
 *   Access-Control-Allow-Origin: https://platform.twitter.com
 * so it CANNOT be called from page JavaScript on x.com (CORS blocks it). It
 * must be called from a privileged context — this Node main process, or the
 * extension's background service worker with host permissions. That is exactly
 * where this module is used.
 *
 * Note on a popular myth: you cannot derive the MP4 URL from the HLS playlist
 * by swapping `/pl/` for `/vid/`. Verified against a real tweet, the basenames
 * are different hashes:
 *   playlist: /pu/pl/480x360/FIEgxZpmsPAhzqP9.m3u8
 *   mp4:      /pu/vid/480x360/Du6ODfDSnDJ3rQqd.mp4
 * so always read the variants from the API instead of guessing.
 */

const https = require('https');
const { URL } = require('url');

const SYNDICATION_HOST = 'cdn.syndication.twimg.com';
const SYNDICATION_PATH = '/tweet-result';
// X only serves this endpoint to crawler-ish user agents.
const UA = 'Googlebot';
// Real-browser fallback UA: the endpoint occasionally refuses the crawler UA
// ("moody" without a browser UA — see the embed-widget clients), so a failed
// first attempt is retried once with this before giving up.
const UA_FALLBACK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
// Query shape used by X's own embed widgets (Vercel react-tweet and friends):
// id + lang + features + token. The token is not verified server-side, but
// sending the full shape keeps responses consistent across tweets.
const SYNDICATION_FEATURES = [
  'tfw_timeline_list:',
  'tfw_follower_count_sunset:true',
  'tfw_tweet_edit_backend:on',
  'tfw_refsrc_session:on',
  'tfw_show_business_verified_badge:on',
  'tfw_duplicate_scribes_to_settings:on',
  'tfw_show_blue_verified_badge:on',
  'tfw_legacy_timeline_sunset:true',
  'tfw_show_gov_verified_badge:on',
  'tfw_show_business_affiliate_badge:on',
  'tfw_tweet_edit_frontend:on',
].join(';');

function syndicationUrl(tweetId, token) {
  return `https://${SYNDICATION_HOST}${SYNDICATION_PATH}?id=${encodeURIComponent(tweetId)}` +
    `&lang=en&features=${encodeURIComponent(SYNDICATION_FEATURES)}&token=${encodeURIComponent(token)}`;
}

/**
 * X's own token formula. Uses float division exactly like X's JS does, so the
 * loss of precision on 64-bit ids is intentional and matches the reference.
 * @param {string|number} twid numeric tweet id
 * @returns {string}
 */
function syndicationToken(twid) {
  const n = Number(String(twid));
  if (!Number.isFinite(n)) return '';
  return ((n / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/**
 * Pull the numeric tweet id out of anything we might be given:
 * a full status URL, a bare id, or a URL with query/fragment.
 * @returns {string|null}
 */
function extractTweetId(input) {
  if (!input) return null;
  const s = String(input).trim();

  // Already a bare numeric id
  if (/^\d{5,25}$/.test(s)) return s;

  // https://x.com/<user>/status/<id>[/…][?…]
  let m = /(?:\/\/)?(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/(?:i\/web\/)?(?:[^/]+\/)?status(?:es)?\/(\d{5,25})/i.exec(s);
  if (m) return m[1];

  // Fallback: first long digit run that looks like a snowflake id
  m = /(\d{15,25})/.exec(s);
  return m ? m[1] : null;
}

// Strict "is this a tweet permalink?" test. Unlike extractTweetId this does NOT
// fall back to matching any long digit run, because media URLs such as
// video.twimg.com/ext_tw_video/1001551417340022785/... also contain 19-digit
// ids and must not be mistaken for a tweet.
function isTweetUrl(input) {
  if (!input) return false;
  return /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\//i.test(String(input).trim()) &&
         /\/status(?:es)?\/\d{5,25}/i.test(String(input));
}

function httpsGetJson(url, { timeoutMs = 15000, headers = {}, redirectCount = 0, userAgent = UA } = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 3) { reject(new Error('Too many redirects from syndication endpoint')); return; }
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error('Invalid URL')); return; }
    const req = https.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': userAgent || UA, Accept: 'application/json', ...headers },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let target;
        try { target = new URL(res.headers.location, url); } catch (e) { reject(e); return; }
        // SSRF hardening: the syndication endpoint has no business redirecting
        // anywhere else — never follow a bounce to a third-party host.
        if (target.hostname.toLowerCase() !== SYNDICATION_HOST) {
          reject(new Error('Syndication endpoint redirected to an unexpected host'));
          return;
        }
        resolve(httpsGetJson(target.toString(), { timeoutMs, headers, redirectCount: redirectCount + 1, userAgent }));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from syndication endpoint`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Syndication endpoint returned non-JSON (tweet may not exist)')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Syndication request timed out')); });
    req.end();
  });
}

function parseResolution(url) {
  const m = /\/(\d{2,5})x(\d{2,5})\//.exec(url || '');
  if (!m) return null;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/**
 * Turn a syndication JSON payload into a normalised list of video variants.
 * @returns {Array<{url, contentType, bitrate, width, height, quality}>}
 */
function variantsFromSyndication(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;

  const buckets = [];
  const push = (o) => { if (o && typeof o === 'object') buckets.push(o); };
  (json.mediaDetails || []).forEach(push);
  if (json.quoted_tweet) (json.quoted_tweet.mediaDetails || []).forEach(push);

  for (let mi = 0; mi < buckets.length; mi++) {
    const media = buckets[mi];
    const variants = (media && media.video_info && media.video_info.variants) || [];
    for (const v of variants) {
      const url = v && v.url;
      if (!url || typeof url !== 'string') continue;
      const contentType = (v.content_type || v.contentType || '').toLowerCase();
      const isMp4 = contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(url);
      const isHls = /x-mpegurl|\.m3u8(?:[?#]|$)/i.test(contentType + ' ' + url);
      if (!isMp4 && !isHls) continue;
      const res = parseResolution(url);
      out.push({
        url,
        contentType: isMp4 ? 'video/mp4' : 'application/x-mpegURL',
        isMp4,
        bitrate: v.bitrate || v.bit_rate || 0,
        width: res ? res.width : 0,
        height: res ? res.height : 0,
        quality: res ? `${res.height}p` : null,
        mediaIndex: mi, // which attachment of the tweet this belongs to
      });
    }
  }

  // Prefer direct MP4, then highest resolution/bitrate.
  out.sort((a, b) => (Number(b.isMp4) - Number(a.isMp4)) ||
                     (b.height - a.height) ||
                     (b.bitrate - a.bitrate));

  // De-duplicate identical URLs
  const seen = new Set();
  return out.filter(v => (seen.has(v.url) ? false : (seen.add(v.url), true)));
}

/**
 * Resolve a tweet URL (or bare id) into its downloadable video variants.
 * @param {string} input  tweet URL or numeric id
 * @returns {Promise<{tweetId: string, videos: Array}>}
 */
// Keep a suggested filename filesystem-safe and reasonably short.
function safeName(s, fallback) {
  const cleaned = String(s || '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

/**
 * Extract display metadata from a syndication JSON payload — pure function so
 * it is unit-testable without network. Only the MAIN tweet's media is used for
 * thumbnail/duration (a quoted tweet's media belongs to the quoted post).
 *
 * @returns {{ title: string, thumbnail: string|null, duration: number|null }}
 */
function metaFromSyndication(json) {
  if (!json || typeof json !== 'object') {
    return { title: 'Tweet', thumbnail: null, duration: null };
  }
  const author = (json.user && json.user.screen_name) || '';

  // Title: first line of the post text, trimmed to a sensible label length.
  let title = String(json.text || '').split(/\r?\n/).find(l => l.trim()) || '';
  title = title.trim().slice(0, 100);
  if (!title) title = author ? `Post by @${author}` : 'Tweet';

  // Thumbnail: the poster frame of the first main-tweet media attachment.
  let thumbnail = null;
  const mainMedia = Array.isArray(json.mediaDetails) ? json.mediaDetails : [];
  for (const m of mainMedia) {
    if (m && typeof m.media_url_https === 'string' && m.media_url_https) { thumbnail = m.media_url_https; break; }
  }

  // Duration: longest video on the post (seconds, rounded).
  let duration = null;
  for (const m of mainMedia) {
    const ms = m && m.video_info && Number(m.video_info.duration_millis);
    if (Number.isFinite(ms) && ms > 0) {
      const sec = Math.round(ms / 100) / 10; // one decimal
      if (duration == null || sec > duration) duration = sec;
    }
  }

  return { title, thumbnail, duration };
}

async function resolveTweetVideos(input) {
  const tweetId = extractTweetId(input);
  if (!tweetId) throw new Error('Not a Twitter/X status URL');

  const token = syndicationToken(tweetId);
  if (!token) throw new Error('Could not derive syndication token');

  const url = syndicationUrl(tweetId, token);
  let json;
  try {
    json = await httpsGetJson(url);
  } catch (e) {
    // One retry with a real-browser UA before surfacing the failure.
    json = await httpsGetJson(url, { userAgent: UA_FALLBACK });
  }
  if (!json || typeof json !== 'object' || Object.keys(json).length === 0) {
    throw new Error('This post was not found (it may have been deleted or the account is private)');
  }
  if (json.__typename === 'TweetTombstone') {
    throw new Error('This post is unavailable (deleted, protected, or age-restricted — log in on x.com and use the AiDM browser extension for such posts)');
  }
  const videos = variantsFromSyndication(json);
  if (!videos.length) throw new Error('No video found on this tweet (it may be image-only, age-restricted, or deleted)');

  const author = safeName(json && json.user && json.user.screen_name, 'unknown');
  const meta = metaFromSyndication(json);

  // Twitter's real filenames are opaque hashes (e.g. Du6ODfDSnDJ3rQqd.mp4),
  // which is useless in a download folder. Suggest something meaningful:
  //   twitter_<author>_<tweetId>_<720p>.mp4
  // A tweet can hold up to 4 videos — without the attachment number they would
  // all get the same filename and overwrite each other on disk.
  const mediaCount = new Set(videos.map(v => v.mediaIndex || 0)).size;
  videos.forEach(v => {
    const tag = v.height ? `${v.height}p` : (v.bitrate ? `${Math.round(v.bitrate / 1000)}k` : 'auto');
    const part = mediaCount > 1 ? `_v${(v.mediaIndex || 0) + 1}` : '';
    v.filename = `twitter_${author}_${tweetId}${part}_${tag}.${v.isMp4 ? 'mp4' : 'm3u8'}`;
  });

  return { tweetId, videos, author, title: meta.title, thumbnail: meta.thumbnail, duration: meta.duration };
}

/**
 * Convert resolver variants into the shape the UI's quality picker expects.
 * Single source of truth — used by both the HTTP API and the add-download IPC.
 *
 * A tweet can carry several videos (up to 4). Without a marker the picker would
 * list e.g. 12 entries all reading "720p" with no way to tell them apart, so we
 * prefix the resolution with "Video N" whenever there is more than one.
 */
function toPickerVideos(videos) {
  const list = videos || [];
  const mediaCount = new Set(list.map(v => v.mediaIndex || 0)).size;
  return list.map(v => {
    const res = v.width && v.height ? `${v.width}x${v.height}` : '';
    const prefix = mediaCount > 1 ? `Video ${(v.mediaIndex || 0) + 1}` : '';
    return {
      url: v.url,
      filename: v.filename,
      quality: v.quality || (v.bitrate ? `${Math.round(v.bitrate / 1000)}kbps` : 'auto'),
      resolution: prefix ? (res ? `${prefix} · ${res}` : prefix) : (res || null),
      format: v.isMp4 ? 'mp4' : 'hls',
      isMp4: v.isMp4,
      codec: null,
      size: null,
    };
  });
}

/**
 * Best single variant to hand straight to the downloader.
 * Prefers the highest-resolution direct MP4; falls back to HLS.
 */
function pickBestVariant(videos) {
  if (!videos || !videos.length) return null;
  return videos[0];
}

module.exports = {
  resolveTweetVideos,
  toPickerVideos,
  pickBestVariant,
  extractTweetId,
  isTweetUrl,
  syndicationToken,
  syndicationUrl,
  variantsFromSyndication,
  metaFromSyndication,
};
