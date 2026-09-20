// @ts-check
// Jev (TypeSafe AI "System One") client for the AiDM download engine.
//
// Jev takes state + typed questions (Choice / Score / Noul) and returns
// structured, probability-calibrated answers. AiDM uses it as a *link triage*
// brain: when the static heuristics (extension regexes, known hosts) can't
// tell whether a captured URL is a downloadable video/image/file or just a
// web page, Jev gets asked — its answer promotes URLs the regexes would
// silently drop.
//
// Design rules (the engine must never depend on the AI being reachable):
// - Fail-open: every failure path returns null and callers keep their
//   existing behavior.
// - Bounded: hard timeout on every call; a circuit breaker stops calling out
//   entirely after repeated failures.
// - Cached: identical (state, questions) pairs are answered from a short-TTL
//   memory cache; clipboard polling must not spam the API.
// - Secret-safe: the API key is read only from TYPESAFE_API_KEY in the
//   environment, sent only in the Authorization header, and never logged.

const crypto = require('crypto');

const JEVI_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEVI_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const BREAKER_THRESHOLD = 3;        // consecutive failures before opening
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/** @type {Map<string, { answers: any, expiresAt: number }>} */
const cache = new Map();
/** @type {Map<string, Promise<any>>} */
const inFlight = new Map();
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

// Injectable for tests (defaults to global fetch).
let fetchImpl = null;
/** @param {typeof fetch} impl */
function setFetchImpl(impl) { fetchImpl = impl; }
function getFetchImpl() { return fetchImpl || fetch; }

/** Test/teardown hook: clear cache + breaker state. */
function resetJev() {
  cache.clear();
  inFlight.clear();
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

function isConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

function breakerOpen() {
  return Date.now() < breakerOpenUntil;
}

function cacheKey(state, questions) {
  const h = crypto.createHash('sha256');
  h.update(state);
  h.update('\u0000');
  h.update(JSON.stringify(questions));
  return h.digest('hex');
}

/**
 * Ask Jev one or more typed questions about the given state.
 * @param {string} state Text context for the model.
 * @param {Record<string, any>} questions Typed question map (choice/score/noul).
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Record<string, any> | null>} answers keyed by question
 *   name, or null on ANY failure (no key, breaker open, timeout, bad shape).
 */
async function ask(state, questions, opts = {}) {
  if (!isConfigured() || breakerOpen()) return null;
  const timeoutMs = Math.max(500, opts.timeoutMs || DEFAULT_TIMEOUT_MS);

  const key = cacheKey(state, questions);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.answers;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const res = await getFetchImpl()(JEVI_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state, model: JEVI_MODEL, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Jev HTTP ${res.status}`);
      const data = await res.json();
      const answers = data && data.answers;
      if (!answers || typeof answers !== 'object') throw new Error('Jev: bad response shape');
      consecutiveFailures = 0; // success closes the breaker
      cache.set(key, { answers, expiresAt: Date.now() + CACHE_TTL_MS });
      return answers;
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= BREAKER_THRESHOLD) {
        breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
        consecutiveFailures = 0;
      }
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/**
 * Classify a URL the static heuristics could not resolve.
 * @param {string} url
 * @param {{ pageUrl?: string, contentType?: string, contentLength?: number }} [context]
 * @returns {Promise<{ downloadable: boolean, kind: string, confidence: number } | null>}
 *   null when Jev is unavailable — callers treat that as "no opinion".
 */
async function classifyLink(url, context = {}) {
  const anatomy = describeUrl(url);
  const ctx = [];
  if (context.contentType) ctx.push(`Known content-type: ${context.contentType}`);
  if (typeof context.contentLength === 'number' && context.contentLength > 0) {
    ctx.push(`Known size: ${context.contentLength} bytes`);
  }
  if (context.pageUrl) ctx.push(`Captured from page: ${context.pageUrl}`);
  const state = [
    'A download manager captured this URL and its static rules (file-extension regexes, known host lists) could not classify it.',
    `URL: ${url}`,
    anatomy,
    ...ctx,
    '',
    'Decide whether this URL points at a directly downloadable file — a video, audio track, image, document or archive — as opposed to an interactive web page (social feed, search page, HTML app, login page). Short signed CDN paths, /download/ style endpoints and tokenized media URLs count as downloadable even without a file extension.',
  ].join('\n');

  const answers = await ask(state, {
    kind: {
      type: 'choice',
      instructions: 'What kind of resource does this URL most likely point to?',
      criteria: {
        video: 'a video file or video stream (mp4, m3u8, mpd, …)',
        audio: 'an audio file or audio-only rendition',
        image: 'an image file (jpg, png, webp, …)',
        file: 'a document, archive, program or other binary file',
        webpage: 'an interactive web page, not a file',
        unsure: 'cannot reasonably be determined',
      },
    },
    downloadable: {
      type: 'noul',
      instructions: 'Is this URL a directly downloadable file link (video/image/audio/document/archive) rather than a web page?',
    },
  }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (!answers) return null;

  const noul = answers.downloadable;
  const prob = noul && typeof noul.noul === 'number' ? noul.noul : 0;
  const conf = noul && typeof noul.confidence === 'number' ? noul.confidence : 0;
  const choice = answers.kind || {};
  return {
    downloadable: prob >= 0.7,
    kind: typeof choice.choice === 'string' ? choice.choice : 'unsure',
    confidence: Math.max(conf, typeof choice.confidence === 'number' ? choice.confidence : 0),
    /** @type {any} raw answer passthrough for callers that want the odds */
    raw: answers,
  };
}

/** Compact one-line anatomy of a URL for the model. */
function describeUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return '(not a valid absolute URL)'; }
  const parts = [
    `scheme: ${u.protocol.replace(':', '')}`,
    `host: ${u.hostname}`,
    `path: ${u.pathname}`,
  ];
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(u.pathname) || [])[1];
  if (ext) parts.push(`extension: .${ext.toLowerCase()}`);
  else parts.push('extension: none');
  if (u.search) parts.push(`query: ${u.search.slice(0, 200)}`);
  return parts.join(' | ');
}

module.exports = {
  ask,
  classifyLink,
  describeUrl,
  isConfigured,
  setFetchImpl,
  resetJev,
};
