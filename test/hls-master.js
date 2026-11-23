// Regression harness for "the manager only detects fragments of HLS videos".
//
// Site shape (mindgeek SPA + hls.js + tokened private CDN, e.g.
// adultmobile.com → site-api.project1service.com → stream-private-ht.project
// 1content.com): the deliverable is a master.m3u8 with validto/ip/hash auth
// params; hls.js then fetches variant playlists and .ts segments. Four gaps
// were confirmed against that pipeline and are locked here:
//   1. panel build discarded webRequest-sniffed .m3u8/.mpd — the ONLY capture
//      of the master whenever the MAIN-world interceptor missed the player's
//      own XHR (worker fetch / frozen prototypes / late extension load);
//   2. no master canonicalization: master + variant playlists surfaced as
//      sibling "fragment" rows;
//   3. no variant→master reconstruction: a lone child playlist could not be
//      promoted to the real master (same release root, auth query preserved);
//   4. SPA data-API JSON bodies (which embed the master URL BEFORE the player
//      fetches anything) were never scanned.
// Extraction-based like test/fb-dedup.js: the SHIPPED definitions run, not
// copies.
//
// Run: node test/hls-master.js
'use strict';

const fs = require('fs');
const path = require('path');

const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'content.js'), 'utf8');
const BACKGROUND = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'background.js'), 'utf8');
const INTERCEPTOR = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'interceptor.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra !== undefined ? `(${extra})` : ''); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? `(${extra})` : ''); }
}

// ── grab(): extract a shipped top-level definition (same convention as
// test/fb-dedup.js / test/ext-early-takeover.js) ──────────────────────────────
function grab(src, name, kind) {
  kind = kind || 'function';
  const needle = (kind === 'function' ? 'function ' + name + '(' : 'const ' + name + ' =');
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('missing ' + name + ' in source');
  if (kind === 'const') {
    // Regex-literal consts contain ';' inside character classes — take the
    // whole physical line (all sniffed consts are single-line regexes).
    let j = src.indexOf('\n', i);
    if (j < 0) j = src.length;
    return src.slice(i, j);
  }
  const j = src.indexOf('{', i);
  let d = 0, inRe = false, inStr = null, esc = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (inRe) {
      if (c === '\\') esc = true;
      else if (c === '/') inRe = false;
      else if (c === '[') { const e = src.indexOf(']', k); if (e > 0) k = e; }
      continue;
    }
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/') {
      // Whitespace-tolerant regex-start lookback (same as test/ext-early-takeover.js):
      // `const re = /…/` puts a SPACE before the slash.
      let p = k - 1;
      while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
      const pc = p >= 0 ? src[p] : '(';
      if (/[(,=:?!&|{;\[]/.test(pc)) { inRe = true; continue; }
      continue;
    }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

// ── Shipped code under test ──────────────────────────────────────────────────
const contentIsSegmentUrl = new Function(
  grab(CONTENT, 'SEGMENT_RE', 'const') + '\n' +
  grab(CONTENT, 'isSegmentUrl') + '\nreturn isSegmentUrl;'
)();
const contentIsHlsMasterUrl = new Function(
  grab(CONTENT, 'isHlsMasterUrl') + '\nreturn isHlsMasterUrl;'
)();
const contentReleaseRootKey = new Function(
  grab(CONTENT, 'hlsReleaseRootKey') + '\nreturn hlsReleaseRootKey;'
)();
const contentReconstruct = new Function(
  grab(CONTENT, 'reconstructMasterCandidates') + '\nreturn reconstructMasterCandidates;'
)();

const bgConsts = ['STREAM_REQ_RE', 'STREAM_PATH_RE', 'FB_HOST_RE', 'FB_PATH_RE', 'SEGMENT_URL_RE']
  .map(n => grab(BACKGROUND, n, 'const')).join('\n');
const bgIsSegmentUrl = new Function(
  bgConsts + '\n' + grab(BACKGROUND, 'isSegmentUrl') + '\nreturn isSegmentUrl;'
)();
const bgIsMediaRequestUrl = new Function(
  bgConsts + '\n' + grab(BACKGROUND, 'isMediaRequestUrl') + '\nreturn isMediaRequestUrl;'
)();
const bgParseMaster = new Function(
  grab(BACKGROUND, 'HLS_AUTH_QUERY_RE_BG', 'const') + '\n' +
  grab(BACKGROUND, 'hlsAuthQueryBg') + '\n' +
  grab(BACKGROUND, 'qualityFromHeightBg') + '\n' +
  grab(BACKGROUND, 'parseMasterPlaylistBg') + '\nreturn parseMasterPlaylistBg;'
)();
const bgIsTwitterPlaylistUrl = new Function(
  grab(BACKGROUND, 'isTwitterPlaylistUrl') + '\nreturn isTwitterPlaylistUrl;'
)();

let notified = [];
const interceptorNotifyManifests = new Function(
  'notifyUrl',
  grab(INTERCEPTOR, 'notifyManifestsInBody') + '\nreturn notifyManifestsInBody;'
)((u, extra) => notified.push({ url: u, extra }));

// ── Real-world URL shapes (adultmobile.com / mindgeek / project1content) ─────
const MASTER =
  'https://stream-private-ht.project1content.com/hls/bf1/56b/c0c/f45/459/485/ad6/13e/597/994/1a' +
  '/video/f134fb779e175a7c6b0639630bbd1820bde12959.mp4/master.m3u8' +
  '?validto=1795371928&ip=103.216.221.104&hash=uzKHlydJxsv0cnjCZ%2BCnKOWHfGQ%3D';
const VARIANT =
  'https://stream-private-ht.project1content.com/hls/bf1/56b/c0c/f45/459/485/ad6/13e/597/994/1a' +
  '/video/f134fb779e175a7c6b0639630bbd1820bde12959.mp4/720p/playlist.m3u8' +
  '?validto=1795371928&ip=103.216.221.104&hash=uzKHlydJxsv0cnjCZ%2BCnKOWHfGQ%3D';
const SEGMENT =
  'https://stream-private-ht.project1content.com/hls/bf1/56b/c0c/f45/459/485/ad6/13e/597/994/1a' +
  '/video/f134fb779e175a7c6b0639630bbd1820bde12959.mp4/720p/seg-1.ts' +
  '?validto=1795371928&ip=103.216.221.104&hash=uzKHlydJxsv0cnjCZ%2BCnKOWHfGQ%3D';
const MASTER_NOQUERY =
  'https://stream-private-ht.project1content.com/hls/bf1/56b/c0c/f45/459/485/ad6/13e/597/994/1a' +
  '/video/f134fb779e175a7c6b0639630bbd1820bde12959.mp4/master.m3u8';

console.log('── 1. the master playlist survives every junk filter ──');
{
  check('content.isSegmentUrl(master) = false', contentIsSegmentUrl(MASTER) === false);
  check('background.isSegmentUrl(master) = false', bgIsSegmentUrl(MASTER) === false);
  check('background.isMediaRequestUrl(master) = true (webRequest capture)', bgIsMediaRequestUrl(MASTER, 'xmlhttprequest') === true);
  check('background.isTwitterPlaylistUrl(master) = false', bgIsTwitterPlaylistUrl(MASTER) === false);
  check('segment .ts URL is refused everywhere', contentIsSegmentUrl(SEGMENT) === true && bgIsSegmentUrl(SEGMENT) === true);
}

console.log('── 2. master identification + release-root family key ──');
{
  check('isHlsMasterUrl(master) = true', contentIsHlsMasterUrl(MASTER) === true);
  check('isHlsMasterUrl(variant playlist) = false', contentIsHlsMasterUrl(VARIANT) === false);
  const masterKey = contentReleaseRootKey(MASTER);
  const variantKey = contentReleaseRootKey(VARIANT);
  check('release-root key exists', !!masterKey, masterKey && masterKey.slice(0, 90));
  check('master and variant share ONE release root', masterKey === variantKey);
  check('root ends at the .mp4/ marker', /\/video\/f134fb[0-9a-f]+\.mp4\/$/.test(masterKey || ''));
  const mKey = contentReleaseRootKey(MASTER_NOQUERY);
  check('query-immune (master without query → same key)', mKey === masterKey);
  check('non-playlist URL has no key', contentReleaseRootKey('https://site-ma.adultmobile.com/scene/11527762/x') === null);
}

console.log('── 3. variant → master reconstruction (auth query preserved) ──');
{
  const cands = contentReconstruct(VARIANT);
  check('reconstruction yields candidates', cands.length === 2, `${cands.length}`);
  // Candidate 1 = release-root master WITH the variant's auth query (the
  // parent of …/720p/ IS the release root, so the parent-dir candidate
  // dedupes against it); candidate 2 = same-directory master fallback.
  const expectedMaster = MASTER_NOQUERY + '?' + VARIANT.slice(VARIANT.indexOf('?') + 1);
  check('first candidate IS the real master (release root + master.m3u8 + auth query)', cands[0] === expectedMaster,
    cands[0] && cands[0].slice(0, 110) + '…');
  check('second candidate is the same-directory fallback', cands[1] ===
    VARIANT.slice(0, VARIANT.lastIndexOf('/') + 1) + 'master.m3u8' + VARIANT.slice(VARIANT.indexOf('?')),
    cands[1] && cands[1].slice(0, 110) + '…');
  const withQuery = contentReconstruct(VARIANT);
  check('auth query (validto/ip/hash) glued onto reconstruction',
    withQuery[0].indexOf('validto=1795371928') > 0 && withQuery[0].indexOf('hash=') > 0);
  check('original URL never among the candidates',
    !cands.some(u => u.replace(/\?.*$/, '') === VARIANT.replace(/\?.*$/, '')));
  check('reconstruction from a master still offers only OTHER directories',
    !contentReconstruct(MASTER).some(u => u.indexOf(MASTER_NOQUERY) === 0));
  const live = contentReconstruct('https://cdn.example.com/live/abc/chunklist.m3u8?wmsAuthSign=xyz');
  check('non-.mp4 playlist reconstructs same-dir + parent-dir masters', live.length === 2 &&
    live[0] === 'https://cdn.example.com/live/abc/master.m3u8?wmsAuthSign=xyz' &&
    live[1] === 'https://cdn.example.com/live/master.m3u8?wmsAuthSign=xyz',
    JSON.stringify(live));
  check('non-playlist input → []', contentReconstruct('https://cdn.example.com/video/clip.mp4').length === 0);
}

console.log('── 4. background master parser (per-quality rows, CORS-free path) ──');
{
  const masterText = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=4365000,RESOLUTION=1920x1080',
    '1080/list.m3u8?validto=1795371928',
    '#EXT-X-STREAM-INF:BANDWIDTH=2136000,RESOLUTION=1280x720',
    '720/list.m3u8?validto=1795371928',
    '#EXT-X-STREAM-INF:BANDWIDTH=964000,RESOLUTION=854x480',
    '480/list.m3u8?validto=1795371928',
  ].join('\n');
  const variants = bgParseMaster(masterText, MASTER_NOQUERY);
  check('three variants parsed', variants.length === 3, `${variants.length}`);
  // Tokened-master fixture (relative URIs, signed query on the master only)
  const masterText2 = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=2136000,RESOLUTION=1280x720',
    '720p/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=964000,RESOLUTION=854x480',
    '480p/index.m3u8',
  ].join('\n');
  const MASTER_TOKENED = MASTER_NOQUERY + '?validto=1799999999&ip=127.0.0.1&hash=synthetic';
  check('variant URLs resolve against the MASTER url', variants[0].url ===
    MASTER_NOQUERY.replace('master.m3u8', '1080/list.m3u8') + '?validto=1795371928',
    variants[0] && variants[0].url.slice(-70));
  check('qualities labeled', variants.map(v => v.quality).join(',') === '1080p,720p,480p');
  check('variant rows carry hls+format tags', variants.every(v => v.hls === true && v.format === 'm3u8'));
  check('media playlist (no STREAM-INF) parses to []',
    bgParseMaster('#EXTM3U\n#EXTINF:4.0,\nseg-1.ts\n', MASTER_NOQUERY).length === 0);
  // Tokened master: variants MUST inherit the signed query (validto/ip/hash)
  // — without it every quality row 474s on click.
  const tokenedVariants = bgParseMaster(masterText2, MASTER_TOKENED);
  check('tokened master → variants inherit the auth query',
    tokenedVariants.length === 2 && tokenedVariants.every(v => v.url.indexOf('validto=1799999999') > 0),
    tokenedVariants[0] && tokenedVariants[0].url.slice(-70));
}

console.log('── 5. SPA data-API JSON scan (master before any player fetch) ──');
{
  notified = [];
  const releaseJson = JSON.stringify({
    result: {
      title: 'She Has a Tight Young Pussy',
      videos: [{ files: { 1080: { urls: { view: MASTER } } } }],
    },
  });
  // The wire form JSON-escapes / and & inside string values.
  const escaped = releaseJson.replace(/\//g, '\\/').replace(/&/g, '\\u0026');
  interceptorNotifyManifests(escaped, 'fetch-json');
  check('escaped-JSON body yields the master URL', notified.length === 1 && notified[0].url === MASTER,
    notified[0] && notified[0].url.slice(0, 90));
  check('via tag flows through', notified[0] && notified[0].extra && notified[0].extra.via === 'fetch-json');

  notified = [];
  interceptorNotifyManifests('{"html":"<p>no media here</p>"}', 'fetch-json');
  check('body without manifests → nothing', notified.length === 0);

  notified = [];
  interceptorNotifyManifests('{"err":"' + 'x'.repeat(3000000) + '.m3u8"}', 'fetch-json');
  check('oversized body → nothing (cost gate)', notified.length === 0);

  notified = [];
  const many = [];
  for (let i = 0; i < 9; i++) many.push(`https://cdn.example.com/hls/v${i}/master.m3u8?t=${i}`);
  interceptorNotifyManifests(JSON.stringify({ urls: many }), 'fetch-json');
  check('scan is capped at 6 URLs per body', notified.length === 6, `${notified.length}`);

  notified = [];
  const segOnly = JSON.stringify({ segs: [SEGMENT] });
  interceptorNotifyManifests(segOnly, 'fetch-json');
  check('segment-only body → nothing (segments never become rows)', notified.length === 0);
}

console.log('── 6. Cloudflare-wall decision (mediaboxplayer.com case) ──');
(async () => {
  // fetch stub: scriptable status sequence per call; Range presence exposed
  // via a marker the stub reads from init.headers.
  let script = [];
  let calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, range: !!(init && init.headers && (init.headers.Range || init.headers.range)), credentials: init && init.credentials });
    const status = script.shift();
    return { status, headers: { get: () => null }, body: { cancel() {} } };
  };
  // wallCheckCache / WALL_CHECK_TTL_MS live at background top level — inject
  // them alongside the environment stubs.
  const swWallCheck = new Function(
    'fetch', 'navigator', 'AbortSignal', 'isSingleUseTokenUrl', 'isGmailAttachmentEntryUrl',
    'wallCheckCache', 'WALL_CHECK_TTL_MS',
    'async ' + grab(BACKGROUND, 'swWallCheck') + '\nreturn swWallCheck;'
  )(fetchStub, { language: 'en-US' }, AbortSignal, () => false, () => false, new Map(), 60000);

  // 403 with Range, 403 plain → wall (engine mirrors the same retry).
  script = [403, 403];
  calls = [];
  const wall = await swWallCheck('https://mediaboxplayer.com/cdn/down/x/files/clip.mp4?md5=abc&expires=1795457206',
    'https://site-ma.adultmobile.com/scene/11527762/x');
  check('403 + 403 (Range retried plain) = walled host', wall === true, JSON.stringify(calls.map(c => c.range)));
  check('wall probe carries browser credentials', calls[0].credentials === 'include');

  // 403 with Range, then 200 plain → strict-Range host, NOT a wall.
  script = [403, 200];
  const notWall = await swWallCheck('https://strict-cdn.example.com/video/hd.mp4?t=1', 'https://x.example.com/');
  check('403 then 200 plain = strict-Range host, engine may pass', notWall === false);

  // 200 → not a wall (and cached: second call must not hit fetch again).
  script = [200];
  calls = [];
  await swWallCheck('https://plain-cdn.example.com/a.mp4', null);
  const before = calls.length;
  await swWallCheck('https://plain-cdn.example.com/b.mp4', null);
  check('decision cached per origin (5 min TTL)', calls.length === before, `${before} → ${calls.length}`);

  // Gmail single-use URLs are never probed (one-shot tokens).
  const swWallCheckSingle = new Function(
    'fetch', 'navigator', 'AbortSignal', 'isSingleUseTokenUrl', 'isGmailAttachmentEntryUrl',
    'wallCheckCache', 'WALL_CHECK_TTL_MS',
    'async ' + grab(BACKGROUND, 'swWallCheck') + '\nreturn swWallCheck;'
  )(() => { throw new Error('must not fetch'); }, { language: 'en-US' }, AbortSignal,
    (u) => /mail-attachment\.googleusercontent\.com/i.test(u), () => false, new Map(), 60000);
  const never = await swWallCheckSingle(
    'https://mail-attachment.googleusercontent.com/attachment/u/0/?ui=2&view=att&disp=safe', null);
  check('single-use token URLs skip the probe entirely', never === false);

  // 503 (challenge page) counts as a wall.
  script = [503, 503];
  check('503 challenge = wall', await swWallCheck('https://cf.example.com/file.mp4', null) === true);

  console.log(`\n${pass} passed, ${fail} failed (sections 1-6)`);
  if (fail) { process.exitCode = 1; return; }
})();

console.log('── 7. engine: token-query inheritance + 474 guidance ──');
(async () => {
  const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-engine.js'), 'utf8');
  const inject = (names, body) => new Function(...names, body);
  const engineConsts = ['HLS_AUTH_QUERY_RE']
    .map(n => grab(ENGINE, n, 'const')).join('\n');
  const mkAuthQuery = inject(
    ['HttpErrorStub', 'isDnsLookupErrorStub'],
    engineConsts + '\n' +
    grab(ENGINE, 'hlsAuthQuery') + '\n' +
    grab(ENGINE, 'resolveHlsChild') + '\nreturn hlsAuthQuery;'
  );
  const hlsAuthQuery = mkAuthQuery(null, null);

  // mindgeek row shape: tokened playlist → children must inherit the query
  const tokenedVariant =
    'https://stream-private-ht.project1content.com/hls/71d/6b9/10a/ffe/440/5bf/b83/3c9/559/857/ba' +
    '/video/a15bebb5ae48fb90f4e42bdd78baccb0408991c4.mp4/index-v1-a1.m3u8' +
    '?validto=1795373795&ip=103.216.221.104&hash=v0AFoOyS8v6wsq2Jw067xeUXKOc%3D';
  const q = hlsAuthQuery(tokenedVariant);
  check('tokened playlist → auth query detected', !!q && q.indexOf('validto=1795373795') === 1, q && q.slice(0, 40));
  check('plain playlist → no auth query', hlsAuthQuery('https://cdn.example.com/live/master.m3u8?foo=1') === null);
  check('no query → no auth query', hlsAuthQuery('https://cdn.example.com/live/master.m3u8') === null);

  const resolveChild = inject(
    [],
    engineConsts + '\n' +
    grab(ENGINE, 'hlsAuthQuery') + '\n' +
    grab(ENGINE, 'resolveHlsChild') + '\nreturn resolveHlsChild;'
  )();
  const seg = resolveChild('seg-1.ts', tokenedVariant, hlsAuthQuery(tokenedVariant));
  check('segment inherits validto/ip/hash from the tokened parent',
    seg.href.indexOf('validto=1795373795') > 0 && seg.href.indexOf('ip=103.216.221.104') > 0 &&
    seg.href.indexOf('hash=') > 0, seg.href.slice(-90));
  check('child with its OWN query is left untouched',
    resolveChild('seg-1.ts?t=9', tokenedVariant, q).search === '?t=9');
  check('non-tokened parent → plain resolution (no invented query)',
    resolveChild('seg-1.ts', 'https://cdn.example.com/live/playlist.m3u8?foo=1', hlsAuthQuery('https://cdn.example.com/live/playlist.m3u8?foo=1')).search === '');

  // Master parser: variants resolve + inherit when the master is tokened
  const parseHlsMaster = inject(
    [],
    engineConsts + '\n' +
    grab(ENGINE, 'HLS_AUDIO_CODEC_RE', 'const') + '\n' +
    grab(ENGINE, 'hlsAuthQuery') + '\n' +
    grab(ENGINE, 'resolveHlsChild') + '\n' +
    grab(ENGINE, 'parseHlsMaster') + '\nreturn parseHlsMaster;'
  )();
  const masterUrl = MASTER_NOQUERY; // https://...mp4/master.m3u8 (no query)
  const tokenedMaster = masterUrl + '?validto=99&ip=1.2.3.4&hash=zz';
  const variants = parseHlsMaster(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\n1080/index.m3u8\n', tokenedMaster);
  check('tokened master → variants inherit the query',
    variants.length === 1 && variants[0].url.indexOf('validto=99') > 0, variants[0] && variants[0].url.slice(-60));
  const plainVariants = parseHlsMaster(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\n1080/index.m3u8\n', masterUrl);
  check('non-tokened master → variants unchanged',
    plainVariants.length === 1 && plainVariants[0].url.indexOf('validto') < 0);

  // Media parser: segments + init map inherit
  const parseHlsMedia = inject(
    [],
    engineConsts + '\n' +
    grab(ENGINE, 'hlsAuthQuery') + '\n' +
    grab(ENGINE, 'resolveHlsChild') + '\n' +
    grab(ENGINE, 'parseKeyAttrs') + '\n' +
    grab(ENGINE, 'parseHlsMedia') + '\nreturn parseHlsMedia;'
  )();
  const media = parseHlsMedia(
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg-1.ts\n#EXTINF:4.0,\nseg-2.ts\n', tokenedVariant);
  check('segments inherit the auth query',
    media.segs.length === 2 && media.segs.every(s => s.url.indexOf('validto=1795373795') > 0));
  check('init map inherits the auth query', media.mapUri && media.mapUri.indexOf('validto=1795373795') > 0);

  // 474 gets actionable guidance instead of a bare status line
  const HttpError = class { constructor(m, s) { this.message = m; this.status = s; } };
  const hlsFetchError = inject(
    ['HttpError', 'isDnsLookupError'],
    grab(ENGINE, 'hlsFetchError') + '\nreturn hlsFetchError;'
  )(HttpError, () => false);
  const msg474 = hlsFetchError('stream playlist', new HttpError('HTTP 474', 474));
  check('474 message names the status and the fix',
    /HTTP 474/.test(msg474) && /anti-hotlink/i.test(msg474) && /extension|re-detect/i.test(msg474),
    msg474.slice(0, 90));
  const msg403 = hlsFetchError('stream variant', new HttpError('HTTP 403', 403));
  check('403 keeps its own wording', /Access denied \(403\)/.test(msg403));


  // ── 8. playlist content-type + init segments + wall-check guard ────────────
  // The empty-pill report ("badge 6 · 0 downloadable links",
  // members.nubiles-porn.com 2026-11-23): mindgeek CDNs ship playlists as
  // audio/x-mpegurl; dropVideoCandidate classified them as audio and deleted
  // every master/variant row. Init segments named init-v1-a1.mp4 leaked past
  // init\.mp4. swWallCheck must never route a playlist to the native
  // downloader (it would save the manifest TEXT as video.mp4).
  {
    const ctDropC = new Function(grab(CONTENT, 'dropVideoCandidate') + '\nreturn dropVideoCandidate;')();
    const ctDropB = new Function(grab(BACKGROUND, 'dropVideoCandidate') + '\nreturn dropVideoCandidate;')();
    const M = 'https://stream-private-ht.project1content.com/hls/ab12cd34ef56/video/0a1b2c3d4e5f.mp4/master.m3u8?validto=1799999999&ip=192.0.2.9&hash=feedface';
    check('audio/x-mpegurl master kept (content)', ctDropC({ contentType: 'audio/x-mpegurl', url: M }) === null);
    check('audio/x-mpegurl master kept (background)', ctDropB({ contentType: 'audio/x-mpegurl', url: M }) === null);
    check('audio/x-mpegurl on a FILE still drops (content)',
      ctDropC({ contentType: 'audio/x-mpegurl', url: 'https://c/x.mp4' }) === 'audio');

    const isSegC = new Function(grab(CONTENT, 'SEGMENT_RE', 'const') + '\n' + grab(CONTENT, 'isSegmentUrl') + '\nreturn isSegmentUrl;')();
    check('init-v1-a1.mp4 (mindgeek fMP4 init) is a segment',
      isSegC('https://stream-private-ht.project1content.com/hls/ab12cd34ef56/video/0a1b.mp4/init-v1-a1.mp4?validto=1&ip=2&hash=3'));
    check('init_1080.mp4 is a segment', isSegC('https://c/hls/init_1080.mp4?token=t'));
    check('plain init.mp4 still a segment', isSegC('https://c/hls/init.mp4'));
    check('initial-cut.mp4 (real file, no dash) NOT a segment',
      !isSegC('https://c/videos/initial-cut.mp4'));
    check('variant playlist NOT a segment',
      !isSegC('https://stream-private-ht.project1content.com/hls/ab12cd34ef56/video/0a1b.mp4/index-v1-a1.m3u8?validto=1&ip=2&hash=3'));

    // swWallCheck: the playlist guard sits before any fetch/cache work.
    check('swWallCheck refuses playlists before probing (no native text-file save)',
      /function swWallCheck\([\s\S]{0,500}\.\(m3u8\|mpd\)[\s\S]{0,300}return false;/.test(BACKGROUND));

    // Panel fail-open wiring: expansion/scoping can never strand the user.
    check('panel rescue: empty expansion re-surfaces canonical candidates',
      /if \(!expanded\.length && cands\.length\)/.test(CONTENT));
    check('panel fail-open: scoping never empties the panel while rows exist',
      /if \(hasScope && !ordered\.length && rows\.length\) ordered = rows;/.test(CONTENT));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
