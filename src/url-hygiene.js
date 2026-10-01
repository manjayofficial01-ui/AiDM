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

module.exports = {
  sanitizeEntryUrl,
  decodeAmpEntities,
  entryUrlWasRepaired,
};
