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

function httpsGetJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error('Invalid URL')); return; }
    const req = https.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        try { resolve(httpsGetJson(new URL(res.headers.location, url).toString(), { timeoutMs, headers })); }
        catch (e) { reject(e); }
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

  for (const media of buckets) {
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
async function resolveTweetVideos(input) {
  const tweetId = extractTweetId(input);
  if (!tweetId) throw new Error('Not a Twitter/X status URL');

  const token = syndicationToken(tweetId);
  if (!token) throw new Error('Could not derive syndication token');

  const url = `https://${SYNDICATION_HOST}${SYNDICATION_PATH}?id=${encodeURIComponent(tweetId)}&token=${encodeURIComponent(token)}`;
  const json = await httpsGetJson(url);
  const videos = variantsFromSyndication(json);
  if (!videos.length) throw new Error('No video found on this tweet (it may be image-only, age-restricted, or deleted)');
  return { tweetId, videos };
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
  pickBestVariant,
  extractTweetId,
  syndicationToken,
  variantsFromSyndication,
};
