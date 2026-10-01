// @ts-check
/**
 * URL hygiene for URLs entering AiDM from outside the app.
 *
 * Why this exists: "Download failed: Server responded with HTTP 400" on a
 * Gmail attachment. The link in Gmail's DOM is HTML-escaped, so anything that
 * reads it as markup (copy from a rendered page, `innerHTML`, a `text/html`
 * clipboard flavor, an email or chat forward) yields
 *
 *   https://mail.google.com/mail/u/0/?ui=2&amp;ik=…&amp;attid=0.1&amp;…&zw
 *
 * Google then sees ONE query parameter (`ui`) whose value is
 * `2&amp;ik=…` — no `attid`, no `view`, no `realattid` — and answers a
 * parameter-validation failure with **HTTP 400**. The browser never hits this
 * because `getAttribute('href')` returns the already-decoded value.
 *
 * The video resolvers and the extension already did this
 * (`embed-resolver.js`, `facebook-resolver.js`, `filehost-resolver.js`,
 * `chrome-extension/{background,content}.js`); the plain-file path — a pasted
 * PDF link, the HTTP API, the clipboard monitor, the NL command — never did.
 *
 * Deliberately conservative: only escaped AMPERSANDS are decoded, because
 * those are the entities that corrupt a query string. `&lt;`/`&gt;`/`&quot;`
 * are left alone — a URL may legitimately carry `%3C`-style escapes, and
 * decoding them would change the bytes on the wire.
 */

// Named + numeric entities that mean "&". Case-insensitive; `#038`/`#x026`
// appear in the wild with leading zeros.
const AMP_ENTITY = /&(?:amp|#0*38|#[xX]0*26);/g;

// Wrapping characters a human or a chat client puts around a pasted link.
const WRAP_CHARS = /^[\s"'`<>«»“”、，。（）()[\]{}]+|[\s"'`<>«»“”、，。（）()[\]{}]+$/g;

// Zero-width / bidi / NBSP characters that survive copy-paste from HTML and
// chat clients. Inside a URL they are invisible corruption.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00a0\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** @param {string} s */
function decodeAmpEntities(s) {
  let out = String(s == null ? '' : s);
  // Bounded loop: `&amp;amp;` is rare but real, and an unbounded replace is
  // the kind of thing that turns into a hang on adversarial input.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(AMP_ENTITY, '&');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Clean one raw URL string. Pure, never throws, never returns empty for a
 * non-empty input, and leaves a well-formed URL byte-identical.
 *
 * @param {unknown} raw
 * @returns {string} the cleaned URL, or '' when the input was not a string
 */
function sanitizeEntryUrl(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';

  s = decodeAmpEntities(s);

  // Strip wrapping quotes/punctuation, repeatedly — pastes like
  // `("https://x/y?a=1&amp;b=2")` need more than one pass.
  for (let i = 0; i < 4; i++) {
    const next = s.replace(WRAP_CHARS, '');
    if (next === s) break;
    s = next;
  }

  // Invisible characters and embedded newlines/tabs (a link wrapped across
  // lines by a mail client) — real URLs never contain raw whitespace.
  s = s.replace(INVISIBLE, '').replace(/[\r\n\t\v\f]+/g, '');

  return s;
}

/**
 * True when `raw` was actually changed by `sanitizeEntryUrl` — used to log
 * the repair without spamming on every clean URL.
 * @param {unknown} raw
 */
function entryUrlWasRepaired(raw) {
  return typeof raw === 'string' && sanitizeEntryUrl(raw) !== raw;
}

// ── Single-use / one-shot signed attachment URLs ─────────────────────────────
//
// Why: a Gmail attachment URL (mail-attachment.googleusercontent.com/…?…&
// saddbat=ANGjdJ-…) and the Drive usercontent endpoint carry a TOKEN that is
// spent by the first request that touches it. A browser downloads the file
// with exactly ONE plain GET and succeeds; AiDM's probe issues HEAD → Range →
// Range → plain GET (up to four requests), the token is consumed by the time
// the real download fires, and the server answers **HTTP 400** — the exact
// symptom the user reported ("normal Chrome downloads it, AiDM 400s").
//
// The fix lives in the manager (see _resolveFilename): for these URLs we skip
// the network probe entirely and start a single plain connection, so exactly
// one GET reaches the server — matching what the browser does.

// Hosts whose download URLs always carry a one-shot signed token.
const SINGLE_USE_TOKEN_HOST_RE = [
  /^mail-attachment\.googleusercontent\.com$/i,
  /^drive\.usercontent\.googleusercontent\.com$/i,
];

// Query-param signatures of one-shot signed attachment URLs on any host.
function hasSingleUseTokenParam(url) {
  if (typeof url !== 'string' || !url) return false;
  // Gmail attachment: a batchexecute attachment token, or the attachment-id
  // + view=att pair that appears on the inline "download" link.
  if (/[?&]saddbat=/.test(url)) return true;
  if (/[?&]realattid=/.test(url) && /[?&]view=att\b/.test(url)) return true;
  // Google Drive "download" interstitial that carries a confirm token.
  if (/[?&]export=download\b/.test(url) && /[?&]confirm=/.test(url)) return true;
  return false;
}

/**
 * True for URLs whose signed token is consumed by every extra request, so the
 * engine must fetch them with a single plain connection (no HEAD/Range probe,
 * no segmented Range burst). Conservative on purpose: only the Google
 * attachment / Drive-usercontent class is matched — ordinary signed CDN links
 * (Azure SAS, AWS S3 presigned) stay multi-connection because their tokens are
 * valid for a window, not a single hit.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function isSingleUseTokenUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let u = null;
  try { u = new URL(raw); } catch (e) { u = null; }
  if (u) {
    if (!/^https?:$/i.test(u.protocol)) return false;
    if (SINGLE_USE_TOKEN_HOST_RE.some((re) => re.test(u.hostname))) return true;
  }
  return hasSingleUseTokenParam(raw);
}

module.exports = {
  sanitizeEntryUrl,
  decodeAmpEntities,
  entryUrlWasRepaired,
  isSingleUseTokenUrl,
  hasSingleUseTokenParam,
};
