/**
 * Shared video-title / file-name helpers (pure, no DOM, no Node deps).
 *
 * WHY THIS FILE EXISTS
 * Tube/clone sites (mydaddy.cc, …) serve their player inside an embed or
 * alt-player iframe whose document has no <title> at all. The old fallback
 * returned `location.hostname`, so every download from such a page was named
 * "mydaddy.cc [1080p].mp4" — a name that identifies no video and, once saved,
 * made every row look like the same stuck link. A bare hostname (or any other
 * placeholder) is NEVER a real title, so these helpers reject it everywhere
 * a file name is invented: extension capsule, popup, quality picker, desktop.
 *
 * NOTE FOR EXTENSION/UI COPIES: content.js, background.js, popup.js and
 * ui/app.js run in contexts that cannot require() this module, so they carry
 * small inline copies of isRealTitle/cleanPageTitle/isGenericFilename/
 * specificUrlBasename. Keep the logic byte-identical when touching it here.
 */

function looksLikeHostname(s) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(s || '').trim());
}

// Single words that are chrome around a player, never a video's name.
const GENERIC_TITLE_RE = /^(video|watch|play|player|home|index|untitled|download|downloads|media|clip|embed|empty|blank|no\s*title)$/i;

// Basenames that name the rendition/endpoint, not the file:
// KVS/CDN "/pubs/<id>/1080.mp4" labels, /get_file/<hash>, videoplayback, …
const GENERIC_BASENAMES = new Set([
  'videoplayback', 'watch', 'video', 'play', 'index', 'download', 'media',
  'get_file', 'dwnl', 'file', 'stream', 'content', 'player', 'embed',
]);

/**
 * True when `t` actually names the video. Rejects bare hostnames
 * ("mydaddy.cc"), bare hostnames with a suffix ("mydaddy.cc - Home") and
 * generic chrome ("Video", "Watch"). `hostname` (optional) is the page host,
 * rejected even when it has no dot (intranet / single-label hosts).
 */
function isRealTitle(t, hostname) {
  const s = String(t == null ? '' : t).trim().replace(/\s+/g, ' ');
  if (!s || s.length < 2) return false;
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (host && s.toLowerCase() === host) return false;
  if (looksLikeHostname(s)) return false;
  if (GENERIC_TITLE_RE.test(s)) return false;
  // A bare domain with an affix ("mydaddy.cc - Home", "Home | mydaddy.cc")
  // is still not a title.
  const core = s
    .replace(/\s*[-|–—:|]\s*[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*$/i, '')
    .replace(/^[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*[-|–—:|]\s*/i, '')
    .trim();
  if (!core) return false;
  if (looksLikeHostname(core)) return false;
  if (GENERIC_TITLE_RE.test(core)) return false;
  return true;
}

/**
 * Strip " - SiteName" / " | SiteName" suffixes (including bare-domain ones
 * like " - mydaddy.cc") and return the real title, or null when nothing
 * usable remains. Never returns a hostname.
 */
function cleanPageTitle(raw, hostname) {
  let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(/\s*[-|–—:|]\s*(YouTube|Facebook|Vimeo|Dailymotion|Twitch).*/i, '').trim();
  s = s.replace(/\s*[-|–—:|]\s*[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*$/i, '').trim();
  if (!isRealTitle(s, hostname)) return null;
  return s.slice(0, 100);
}

/** True when a URL basename stem carries no identity (rendition/endpoint/hash). */
function stemIsGeneric(stem) {
  const s = String(stem || '').trim();
  if (!s) return true;
  if (/^\d{3,4}p?$/i.test(s)) return true; // "1080", "1080p" (KVS rendition label)
  if (GENERIC_BASENAMES.has(s.toLowerCase())) return true;
  if (/^download_\d+$/.test(s)) return true;
  // Long hex hashes (KVS /get_file/<hash>, bigcdn /pubs/<hash>.<id>) name
  // the CDN object, not the video a human would recognise.
  if (s.length >= 12 && /^[0-9a-f]+$/i.test(s)) return true;
  return false;
}

/**
 * True when a proposed file name carries no real identity: a bare hostname
 * ("mydaddy.cc.mp4", "mydaddy.cc [1080p].mp4"), a rendition-only basename
 * ("1080.mp4"), a CDN hash, or a placeholder ("video", "download_…").
 */
function isGenericFilename(name, url) {
  const s = String(name || '').trim();
  if (!s) return true;
  let host = '';
  try { host = new URL(String(url || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch {}
  const stem = s
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .trim();
  if (!stem) return true;
  const low = stem.toLowerCase();
  if (host && (low === host || low === host.replace(/^www\./, ''))) return true;
  if (looksLikeHostname(stem)) return true;
  if (stemIsGeneric(stem)) return true;
  return false;
}

/**
 * The last URL path segment, or null when it is not a human-meaningful file
 * name (missing, extensionless, rendition-only, endpoint, hash).
 */
function specificUrlBasename(u) {
  try {
    const parts = new URL(String(u || '')).pathname.split('/').filter(Boolean);
    const base = decodeURIComponent(parts.pop() || '');
    if (!base || !/\.[A-Za-z0-9]{2,4}$/.test(base)) return null;
    if (isGenericFilename(base, u)) return null;
    return base;
  } catch {
    return null;
  }
}

module.exports = {
  looksLikeHostname,
  isRealTitle,
  cleanPageTitle,
  stemIsGeneric,
  isGenericFilename,
  specificUrlBasename,
};
