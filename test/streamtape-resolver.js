// Regression harness for "yesporn.io videos can't be detected or downloaded".
//
// Root cause chain (verified live 2026-11-17, yesporn.io → streamtape.to):
//   1. yesporn.io video pages hold NO media — the player is a same-origin
//      /embed/<id> iframe that is a CLICK-GATE shell: any click first opens
//      an ad popunder, then an api.php get_block XHR injects a Streamtape
//      player iframe. Nothing on the page matches AiDM's media heuristics.
//   2. Streamtape serves ONE progressive MP4 behind an extensionless signed
//      redirect (/get_video?id=…&expires=…&ip=…&token=… → 302 →
//      <node>.tapecontent.net/radosgw/…), which matches no resolver and no
//      extension sniffer pattern — the playing video was invisible.
//   3. No resolver spoke Streamtape at all.
//
// Shipped behavior under test:
//   - parseStreamtapeEmbed / parseStreamtapeDirect / parseYespornUrl
//     strictness (identifiers only; &stream=1/&plain=1 chrome dropped;
//     signed tapecontent targets are NEVER "supported" inputs)
//   - extractStreamtapeQuery on the real server variants (hidden divs,
//     innerHTML de-obfuscation payloads, &amp; entities, remotecaption
//     distractor tokens that must NOT match)
//   - extractYespornBlock / extractEmbedIframeSrc on the real click-gate +
//     async-block shapes
//   - resolveStreamtapeVideos end-to-end with stubbed fetch/mint (page →
//     embed → Streamtape → fresh signed link; re-mint on sniffed links;
//     get_video fallback when the mint fails; clean errors)
//   - resolver registry wiring (supports + hasResolverFor dispatch)
//   - extension sniffer parity (PATH_RE / STREAM_PATH_RE / content.js
//     looksLikeMedia + scanEmbedFrames wiring)
//
// Run: node test/streamtape-resolver.js
'use strict';

const fs = require('fs');
const path = require('path');

const st = require('../src/streamtape-resolver');
const resolvers = require('../src/resolvers');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// Real embed-page shapes (values shaped like the live site; the token churns
// per fetch, the structure is what the parsers must survive).
const ST_EMBED_HTML = [
  '<html><head><title>Streamtape.com</title></head><body>',
  '<span id="botlink" style="display:none;">/streamtape.to/get_video?id=ak8oXaq7Doi0xg&amp;expires=1795012591&amp;ip=FRqsDHqnDS9X&amp;token=bQVs4sf0KBzA</span>',
  '<div id="robotlink" style="display:none;">/streamtape.to/get_video?id=ak8oXaq7Doi0xg&amp;expires=1795012591&amp;ip=FRqsDHqnDS9X&amp;token=bQVs4sf0KBzA</div>',
  '<div id="robot" style="display:none;">049</div>',
  '<script>window.PTiarEegFitr={adblock:false,"fileid":"ak8oXaq7Doi0xg","cors":"https:\\/\\/thumb.tapecontent.net\\/remotecaption\\/expires=1795012481&amp;ip=FRqsDHqnDS9X&amp;token=DISTRACT0R",</script>',
  '<script>window.HsFNZayBraY_={"token":"5d2e93017eee330933","adblock":false,"fileid":"ak8oXaq7Doi0xg","showtitle":"[Milfed] Kenzie Taylor (Neighbor To The Rescue / 01.29.2026)","poster":"https:\\/\\/thumb.tapecontent.net\\/thumb\\/ak8oXaq7Doi0xg\\/q824wWwdeyuz3WL.jpg"};</script>',
  '<script>document.getElementById(\'botlink\').innerHTML = \'//strea\'+ (\'xyzamtape.to/get_video?id=ak8oXaq7Doi0xg&expires=1795012591&ip=FRqsDHqnDS9X&token=bQVs4sf0KBzA\').substring(4);</script>',
  '<video crossorigin="anonymous" id="mainvideo" poster="https://thumb.tapecontent.net/thumb/ak8oXaq7Doi0xg/q824wWwdeyuz3WL.jpg"></video>',
  '<script>jQuery(function ($) { var srclink = $(\'#botlink\').text() + \'&stream=1\'; $(".play-overlay").click(function(){ document.getElementById("mainvideo").src = srclink; }); });</script>',
  '</body></html>',
].join('\n');

// The click-gate shell (yesporn.io/embed/<id>): a fake play button + the
// async-block XHR target. No media anywhere.
const YESPORN_EMBED_HTML = [
  '<html><head><title>Milfed - Kenzie Taylor - Neighbor To The Rescue</title>',
  '<meta property="og:image" content="https://i.postimg.cc/TYX7t1F8/1769695739032.jpg"></head><body>',
  '<div id="playButton"></div><div id="iframeContainer"></div>',
  '<script>document.body.addEventListener(\'click\', function() {',
  'window.open(\'https://go.mavrtracktor.com?sourceId=yesporn.io&userId=abc\', \'_blank\');',
  'var xhr = new XMLHttpRequest();',
  'xhr.open(\'GET\', \'https://yesporn.io/api.php?mode=async&function=get_block&block_id=video_view_api_video_view&id=499430\', true);',
  'xhr.send(); });</script>',
  '</body></html>',
].join('\n');

// The async-block response: exactly what api.php returns — one iframe.
const YESPORN_BLOCK_HTML =
  '<iframe width="600" height="480" src="https://streamtape.to/e/ak8oXaq7Doi0xg/" scrolling="no" frameborder="0" allowfullscreen="true"></iframe>';

// The signed 302 target shape (filename rides in the path tail).
const SIGNED_URL =
  'https://908483818.tapecontent.net/radosgw/ak8oXaq7Doi0xg/rH3WxRUJFxE3Jdrc5KeMVnCtQ5XCs1Sb/%5BMilfed%5D+Kenzie+Taylor+%28Neighbor+To+The+Rescue+%2F+01.29.2026%29';
const GET_VIDEO_URL =
  'https://streamtape.to/get_video?id=ak8oXaq7Doi0xg&expires=1795012591&ip=FRqsDHqnDS9X&token=bQVs4sf0KBzA';

// ── 1. Parsing strictness ─────────────────────────────────────────────────────
{
  const e = st.parseStreamtapeEmbed('https://streamtape.to/e/ak8oXaq7Doi0xg/');
  check('streamtape /e/ embed parsed', !!e && e.id === 'ak8oXaq7Doi0xg' && e.host === 'streamtape.to');
  const v = st.parseStreamtapeEmbed('https://streamtape.com/v/ak8oXaq7Doi0xg');
  check('streamtape /v/ embed parsed (no trailing slash)', !!v && v.id === 'ak8oXaq7Doi0xg');
  check('streamtape embed rejects video path', st.parseStreamtapeEmbed('https://streamtape.to/watch/xyz') === null);
  check('streamtape embed rejects other hosts', st.parseStreamtapeEmbed('https://evil.example/e/ak8oXaq7Doi0xg') === null);

  const d = st.parseStreamtapeDirect(GET_VIDEO_URL + '&stream=1&plain=1');
  check('direct get_video parsed; player chrome params dropped',
    !!d && d.id === 'ak8oXaq7Doi0xg' &&
    d.query === 'id=ak8oXaq7Doi0xg&expires=1795012591&ip=FRqsDHqnDS9X&token=bQVs4sf0KBzA');
  check('direct get_video without token rejected',
    st.parseStreamtapeDirect('https://streamtape.to/get_video?id=x&expires=1') === null);
  check('signed tapecontent target is not an input', st.parseStreamtapeDirect(SIGNED_URL) === null);

  const p = st.parseYespornUrl('https://yesporn.io/milfed-kenzie-taylor-neighbor-to-the-rescue-499430');
  check('yesporn page slug-<id> parsed', !!p && p.id === '499430' && p.kind === 'page');
  const pe = st.parseYespornUrl('https://yesporn.io/embed/499430');
  check('yesporn /embed/<id> parsed', !!pe && pe.id === '499430' && pe.kind === 'embed');
  check('yesporn non-video paths rejected',
    st.parseYespornUrl('https://yesporn.io/search?q=x') === null &&
    st.parseYespornUrl('https://yesporn.io/login') === null &&
    st.parseYespornUrl('https://www.yesporn.io/signup') === null);
  check('other hosts rejected everywhere',
    st.parseYespornUrl('https://example.com/video-123') === null &&
    st.parseStreamtapeEmbed('https://www.youtube.com/watch?v=abc') === null);

  check('isStreamtapeUrl / isYespornUrl agree',
    st.isStreamtapeUrl(GET_VIDEO_URL) === true &&
    st.isStreamtapeUrl('https://streamtape.to/e/ak8oXaq7Doi0xg/') === true &&
    st.isYespornUrl('https://yesporn.io/embed/499430') === true &&
    !st.isStreamtapeUrl('https://example.com/x') &&
    !st.isYespornUrl('https://example.com/video-123'));
}

// ── 2. Extraction on the real shapes ──────────────────────────────────────────
{
  const q = st.extractStreamtapeQuery(ST_EMBED_HTML);
  check('query extracted through &amp; entities + payloads',
    q === 'id=ak8oXaq7Doi0xg&expires=1795012591&ip=FRqsDHqnDS9X&token=bQVs4sf0KBzA', q || '(none)');
  check('remotecaption distractor never matches',
    !/DISTRACT0R/.test(st.extractStreamtapeQuery(ST_EMBED_HTML) || ''));
  check('query extraction on empty/broken pages is null',
    st.extractStreamtapeQuery('') === null && st.extractStreamtapeQuery('<html></html>') === null);

  const b = st.extractYespornBlock(YESPORN_EMBED_HTML);
  check('click-gate block id read from the shell',
    b.blockId === 'video_view_api_video_view' && b.id === '499430');
  check('block id falls back to defaults',
    st.extractYespornBlock('<html></html>').blockId === 'video_view_api_video_view');

  check('async-block iframe src found', st.extractEmbedIframeSrc(YESPORN_BLOCK_HTML) === 'https://streamtape.to/e/ak8oXaq7Doi0xg/');
  check('non-streamtape iframes ignored',
    st.extractEmbedIframeSrc('<iframe src="https://ads.example/e/xyz/"></iframe>') === null);
  check('relative iframe src absolutized',
    st.extractEmbedIframeSrc('<iframe src="//streamtape.net/e/abc12345/"></iframe>') === 'https://streamtape.net/e/abc12345/');

  check('title from config showtitle',
    st.extractStreamtapeTitle(ST_EMBED_HTML) === '[Milfed] Kenzie Taylor (Neighbor To The Rescue / 01.29.2026)');
  check('poster from config', st.extractStreamtapePoster(ST_EMBED_HTML) === 'https://thumb.tapecontent.net/thumb/ak8oXaq7Doi0xg/q824wWwdeyuz3WL.jpg');

  check('filename sanitized (slash, plus, quotes)',
    st.sanitizeFilename('[Milfed]+Kenzie+Taylor+(Neighbor To The Rescue / 01.29.2026)') ===
      '[Milfed] Kenzie Taylor (Neighbor To The Rescue 01.29.2026)');
  check('title from signed URL path tail',
    st.titleFromSignedUrl(SIGNED_URL) === '[Milfed] Kenzie Taylor (Neighbor To The Rescue / 01.29.2026)');
}

// ── 3. Resolve pipeline with stubbed fetch/mint ───────────────────────────────
async function resolveTests() {
  // a) yesporn page → embed shell → block → streamtape → mint.
  {
    const fetched = [];
    const fetchHtml = async (url, opts) => {
      fetched.push(url);
      if (/yesporn\.io\/embed\/499430/.test(url)) return YESPORN_EMBED_HTML;
      if (/api\.php\?mode=async/.test(url)) return YESPORN_BLOCK_HTML;
      if (/streamtape\.to\/e\//.test(url)) return ST_EMBED_HTML;
      throw new Error('unexpected fetch: ' + url);
    };
    const mintDirectUrl = async (url) => {
      check('mint hits the exact get_video link', url === GET_VIDEO_URL);
      return SIGNED_URL;
    };
    const r = await st.resolveStreamtapeVideos('https://yesporn.io/milfed-kenzie-taylor-neighbor-to-the-rescue-499430', { fetchHtml, mintDirectUrl });
    check('yesporn page resolves through the whole chain', fetched.length === 3);
    check('download URL is the freshly minted signed link', r.videos[0].url === SIGNED_URL);
    check('title taken from the signed URL', r.title === '[Milfed] Kenzie Taylor (Neighbor To The Rescue 01.29.2026)', r.title);
    check('filename is <title>.mp4', r.videos[0].filename === '[Milfed] Kenzie Taylor (Neighbor To The Rescue 01.29.2026).mp4');
    check('variant is plain mp4, no referer', r.videos[0].format === 'mp4' && r.videos[0].quality === 'Original' && r.referer === null);
    check('poster rides along', r.thumbnail === 'https://thumb.tapecontent.net/thumb/ak8oXaq7Doi0xg/q824wWwdeyuz3WL.jpg');
    check('canonicalUrl is the streamtape embed', r.canonicalUrl === 'https://streamtape.to/e/ak8oXaq7Doi0xg/');
  }

  // b) Streamtape embed URL direct input.
  {
    const r = await st.resolveStreamtapeVideos('https://streamtape.to/e/ak8oXaq7Doi0xg/', {
      fetchHtml: async () => ST_EMBED_HTML,
      mintDirectUrl: async () => SIGNED_URL,
    });
    check('streamtape embed resolves directly', r.videos[0].url === SIGNED_URL && r.id === 'ak8oXaq7Doi0xg');
  }

  // c) A sniffed /get_video link re-mints (stale link in, fresh link out).
  {
    const r = await st.resolveStreamtapeVideos(GET_VIDEO_URL, { mintDirectUrl: async () => SIGNED_URL + '?fresh=1' });
    check('sniffed get_video re-mints instead of downloading the stale token',
      r.videos[0].url === SIGNED_URL + '?fresh=1');
  }

  // d) Mint failure is FATAL — a poisoned token answers 200 {"status":500}
  //    instead of the 302; handing that URL to the engine would save a 48-byte
  //    JSON error body as .mp4. The resolver must error out instead.
  {
    let threw = '';
    try {
      await st.resolveStreamtapeVideos(GET_VIDEO_URL, {
        mintDirectUrl: async () => { throw new Error('HTTP 200 instead of redirect'); },
      });
    } catch (e) { threw = e.message; }
    check('mint failure errors cleanly (never a poisoned download)',
      /Could not mint a fresh Streamtape download link/.test(threw) && /HTTP 200/.test(threw), threw);
  }

  // d2) The Electron mint runs first; its browser-minted token feeds the
  //     plain redirect mint (node + valid token → 302 verified live).
  {
    const seen = [];
    const r = await st.resolveStreamtapeVideos('https://streamtape.to/e/ak8oXaq7Doi0xg/', {
      fetchHtml: async () => ST_EMBED_HTML,
      mintViaElectron: async (embedUrl) => {
        seen.push(embedUrl);
        return 'https://streamtape.to/get_video?id=browser&expires=1&ip=x&token=browser';
      },
      mintDirectUrl: async (url) => { seen.push(url); return SIGNED_URL; },
    });
    check('electron mint is tried first with the embed URL', seen[0] === 'https://streamtape.to/e/ak8oXaq7Doi0xg/');
    check('plain mint runs on the browser-minted token', /token=browser/.test(seen[1] || ''), seen[1]);
    check('electron-minted link wins', r.videos[0].url === SIGNED_URL);
  }

  // e) Clean errors.
  {
    let threw = '';
    try {
      await st.resolveStreamtapeVideos('https://streamtape.to/e/ak8oXaq7Doi0xg/', {
        fetchHtml: async () => '<html>video removed</html>',
        mintDirectUrl: async () => SIGNED_URL,
      });
    } catch (e) { threw = e.message; }
    check('embed without a link errors cleanly', /did not expose/.test(threw), threw);

    threw = '';
    try {
      await st.resolveStreamtapeVideos('https://yesporn.io/milfed-kenzie-taylor-neighbor-to-the-rescue-499430', {
        fetchHtml: async (url) => (/api\.php/.test(url) ? '<iframe src="https://unsupported.host/e/x/"></iframe>' : YESPORN_EMBED_HTML),
        mintDirectUrl: async () => SIGNED_URL,
      });
    } catch (e) { threw = e.message; }
    check('unsupported player host errors cleanly', /embeds no supported player/.test(threw), threw);

    threw = '';
    try { await st.resolveStreamtapeVideos('https://example.com/not-a-video'); } catch (e) { threw = e.message; }
    check('off-provider URL rejected without any fetch', /Not a Streamtape/.test(threw), threw);
  }
}

// ── 4. Registry wiring ────────────────────────────────────────────────────────
function registryTests() {
  check('registry supports the yesporn page URL',
    resolvers.hasResolverFor('https://yesporn.io/milfed-kenzie-taylor-neighbor-to-the-rescue-499430'));
  check('registry supports the yesporn embed URL', resolvers.hasResolverFor('https://yesporn.io/embed/499430'));
  check('registry supports the streamtape embed URL', resolvers.hasResolverFor('https://streamtape.to/e/ak8oXaq7Doi0xg/'));
  check('registry supports a sniffed get_video link', resolvers.hasResolverFor(GET_VIDEO_URL));
  check('registry does NOT claim the signed tapecontent target', !resolvers.hasResolverFor(SIGNED_URL));
  check('registry still routes YouTube pages to the YouTube resolver (streamtape must not claim them)',
    resolvers.hasResolverFor('https://www.youtube.com/watch?v=abcdefghijk') === true);
}

// ── 5. Extension sniffer parity ───────────────────────────────────────────────
function extensionTests() {
  const ROOT = path.join(__dirname, '..');
  const bgSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
  const ctSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8');
  const itSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'interceptor.js'), 'utf8');

  check('background STREAM_PATH_RE carries /get_video',
    /const STREAM_PATH_RE = [^\n]*\\\/get_video\\\?[^\n]*\//.test(bgSrc));
  check('interceptor PATH_RE carries /get_video',
    /const PATH_RE = [^\n]*\\\/get_video\\\?[^\n]*\//.test(itSrc));
  check('content.js looksLikeMedia carries /get_video',
    /videoplayback\|\\\/get_file\\\/\|\\\/get_video\\\?/.test(ctSrc));
  check('content.js ships scanEmbedFrames + fullScan wiring',
    /function scanEmbedFrames\(\)/.test(ctSrc) && /scanEmbedFrames\(\)\.forEach\(track\)/.test(ctSrc));

  // isMediaRequestUrl must actually match the get_video class (same
  // extraction trick as test/browser-engine.js — regexes injected fresh).
  const grabShipped = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    const j = src.indexOf('{', i);
    let d = 0;
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') d++;
      if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    throw new Error('unbalanced ' + name);
  };
  const isMediaRequestUrl = new Function(
    'STREAM_REQ_RE', 'STREAM_PATH_RE', 'FB_HOST_RE', 'FB_PATH_RE',
    grabShipped(bgSrc, 'isMediaRequestUrl') + '\nreturn isMediaRequestUrl;'
  )(
    /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ts|m4s|key|akamai)($|\?|#)/i,
    /videoplayback|\/live\/|\/movie\/|\/series\/|\/hls\/|\/get_file\/|\/get_video\?|\/mp4\/|\.akamaihd\.net|\/secure\/|\/videos?\//i,
    /fbcdn\.net|scontent\.|facebook\.com|fb\.com|instagram\.com|cdninstagram\.com/i,
    /\/v\/t|video\.php|watchparty|\/reel|\/watch\/|playable|bytestart|\/dash\/|\/hls\//i
  );
  check('webRequest sniffer admits the playing get_video request (xhr)',
    isMediaRequestUrl(GET_VIDEO_URL, 'xmlhttprequest') === true);
  check('webRequest sniffer admits the get_video media-element request',
    isMediaRequestUrl(GET_VIDEO_URL + '&stream=1', 'media') === true);
  check('webRequest sniffer ignores plain pages',
    isMediaRequestUrl('https://yesporn.io/embed/499430', 'main_frame') === false);
}

(async () => {
  console.log('streamtape-resolver regression');
  registryTests();
  extensionTests();
  await resolveTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
