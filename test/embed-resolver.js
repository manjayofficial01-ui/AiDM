// Regression harness for "hqporner.com videos don't download"
// (https://hqporner.com/hdporn/127856-kidnapped_body_heat.html).
//
// Root cause chain:
//   1. hqporner `/hdporn/` pages contain NO direct media — the player is a
//      mydaddy.cc iframe plus /blocks/altplayer.php|nativeplayer.php handoffs,
//      so generic sniffing depends on iframe playback timing and yields
//      short-lived bigcdn URLs that are often dead by click time.
//   2. Nothing turned a pasted page URL into fresh variants (the Twitter
//      resolver pattern existed but had no embed provider).
//
// Shipped behavior under test (pure parsers + stubbed resolve):
//   - parseEmbedUrl strictness (both providers, &alt tolerant, rejects media
//     URLs and non-video paths)
//   - extractMydaddyEmbed on the real hqporner page shape
//   - extractEmbedTitle (domain suffix stripped, hostname never returned)
//   - extractMydaddyVariants on the real mydaddy player shape (best-first)
//   - extractDurationSeconds / thumbnail helpers
//   - resolveEmbedVideos end-to-end with stubbed page fetches
//   - resolver registry wiring (supports + provider dispatch)
//   - fetchPageHtml SSRF guard (off-allowlist refused without network)
//
// Run: node test/embed-resolver.js
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// Extract a top-level `function name(` definition from shipped source
// (regex-aware brace matching, same approach as test/grabber.js).
function grabShipped(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in shipped source');
  const j = src.indexOf('{', i);
  let d = 0, inStr = null, esc = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && src[k + 1] === '/') { const e = src.indexOf('\n', k); k = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k); k = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/') {
      let p = k - 1;
      while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
      const pc = p >= 0 ? src[p] : '(';
      if (!/[(,=:?!&|{;\[]/.test(pc)) continue;
      let q = k + 1, qc = false, cls = false;
      for (; q < src.length; q++) {
        const cc = src[q];
        if (qc) { qc = false; continue; }
        if (cc === '\\') { qc = true; continue; }
        if (cc === '[') cls = true;
        else if (cc === ']') cls = false;
        else if (cc === '/' && !cls) break;
        else if (cc === '\n') break;
      }
      k = q; continue;
    }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const embed = require('../src/embed-resolver');
const resolvers = require('../src/resolvers');

const HQPORNER_URL = 'https://hqporner.com/hdporn/127856-kidnapped_body_heat.html';
const MYDADDY_URL = 'https://mydaddy.cc/video/09c662a75858eed4ca/';

// ── 1. strict page-URL parsing ─────────────────────────────────────────────
{
  const h = embed.parseEmbedUrl(HQPORNER_URL);
  check('hqporner page parsed', h && h.provider === 'hqporner' && h.id === '127856', JSON.stringify(h));
  const m = embed.parseEmbedUrl(MYDADDY_URL);
  check('mydaddy page parsed', m && m.provider === 'mydaddy' && m.id === '09c662a75858eed4ca');
  const alt = embed.parseEmbedUrl('https://mydaddy.cc/video/09c662a75858eed4ca/&alt');
  check('mydaddy &alt variant parsed', alt && alt.id === '09c662a75858eed4ca', alt && alt.pageUrl);
  check('isEmbedUrl true for both', embed.isEmbedUrl(HQPORNER_URL) && embed.isEmbedUrl(MYDADDY_URL));
  check('tweet URL rejected', !embed.isEmbedUrl('https://x.com/foo/status/123456789012345678'));
  check('twimg media URL rejected',
    !embed.isEmbedUrl('https://video.twimg.com/ext_tw_video/1001551417340022785/pu/vid/720x1280/abc.mp4'));
  check('bigcdn file URL rejected (not a page)',
    !embed.isEmbedUrl('https://s45.bigcdn.cc/pubs/6aaa296da857b9.75039518/1080.mp4'));
  check('hqporner non-video path rejected', !embed.isEmbedUrl('https://hqporner.com/categories'));
  check('garbage rejected', !embed.isEmbedUrl('not a url') && embed.parseEmbedUrl(null) === null);
}

// Real hqporner page shape (trimmed from a live fetch of the reported URL).
const HQPORNER_HTML = `
<!DOCTYPE HTML><html><head>
<title>Kidnapped Body Heat - HQporner.com</title>
<meta name="description" content="Watch porn video Kidnapped Body Heat in high definition for free. Video duration is 35min 53sec. Tags related to this video: story movies, cougar." />
</head><body>
<script type="text/javascript">
function altPlayer() {
$.ajax({
url: '/blocks/altplayer.php?i=//mydaddy.cc/video/09c662a75858eed4ca/',
cache: false });
}
</script>
<div class="videoWrapper" id="playerWrapper" style="background:#000;">
<iframe width="560" height="350" src="//mydaddy.cc/video/09c662a75858eed4ca/" frameborder="0" allowfullscreen></iframe>
</div>
<header><h1 class="main-h1" style="line-height: 1em;">
kidnapped body heat</h1></header>
</body></html>`;

// Real mydaddy player shape (fluidplayer page per field reports).
const MYDADDY_HTML = `
<html><head><title>Some Video Title - mydaddy.cc</title></head><body>
<video id="player" controls preload="metadata"
  poster="https://s2.bigcdn.cc/pubs/62cf1617754f13.dsad/main.jpg">
  <source src="https://s2.bigcdn.cc/pubs/62cf1617754f13.dsad/1080.mp4" type="video/mp4" />
</video>
<div class="downloads">
<a href='//s2.bigcdn.cc/pubs/62cf1617754f13.dsad/1080.mp4'>1080p</a>
<a href='//s2.bigcdn.cc/pubs/62cf1617754f13.dsad/720.mp4'>720p</a>
<a href='//s2.bigcdn.cc/pubs/62cf1617754f13.dsad/480.mp4'>480p</a>
</div>
<script>var flashvars = { video_url: '/get_file/abc123/456/720.mp4' };</script>
</body></html>`;

// ── 2. embed discovery on the hqporner page ────────────────────────────────
check('mydaddy embed found in hqporner page',
  embed.extractMydaddyEmbed(HQPORNER_HTML) === 'https://mydaddy.cc/video/09c662a75858eed4ca/');
check('altplayer handoff parsed when iframe missing',
  embed.extractMydaddyEmbed(HQPORNER_HTML.replace(/<iframe[\s\S]*?<\/iframe>/i, '')) ===
    'https://mydaddy.cc/video/09c662a75858eed4ca/');
check('no embed → null', embed.extractMydaddyEmbed('<html><body>hello</body></html>') === null);

// ── 3. titles ─────────────────────────────────────────────────────────────
check('hqporner title from <title>, suffix stripped',
  embed.extractEmbedTitle(HQPORNER_HTML, 'hqporner.com') === 'Kidnapped Body Heat');
check('mydaddy title suffix stripped',
  embed.extractEmbedTitle(MYDADDY_HTML, 'mydaddy.cc') === 'Some Video Title');
check('bare hostname title rejected',
  embed.extractEmbedTitle('<title>mydaddy.cc</title>', 'mydaddy.cc') === null);
check('h1 fallback works',
  embed.extractEmbedTitle('<html><body><h1 class="main-h1">kidnapped body heat</h1></body></html>', 'hqporner.com') ===
    'kidnapped body heat');

// ── 4. mydaddy variants ───────────────────────────────────────────────────
{
  const vs = embed.extractMydaddyVariants(MYDADDY_HTML, MYDADDY_URL);
  // <video><source 1080> collapses with the identical <a> 1080 link; the
  // relative /get_file/720.mp4 resolves against the player page into a 4th.
  check('four variants found (dup collapsed, relative resolved)',
    vs.length === 4, vs.map(v => v.quality).join(','));
  check('best-first ordering',
    vs.map(v => v.height).join(',') === '1080,720,720,480', vs.map(v => v.quality).join(','));
  check('resolutions mapped',
    vs[0].width === 1920 && vs[0].height === 1080 && vs[1].height === 720);
  check('absolute https URLs', vs.every(v => /^https:\/\//.test(v.url)));
  check('relative get_file resolved against player page',
    vs.some(v => v.url === 'https://mydaddy.cc/get_file/abc123/456/720.mp4'));
  check('all mp4', vs.every(v => v.isMp4 && v.contentType === 'video/mp4'));
  check('posters excluded', !vs.some(v => /main\.jpg/.test(v.url)));
}

// ── 5. duration / thumbnail ───────────────────────────────────────────────
check('duration parsed (35min 53sec → 2153s)',
  embed.extractDurationSeconds(HQPORNER_HTML) === 35 * 60 + 53);
check('thumbnail from video poster',
  embed.extractThumbnail(MYDADDY_HTML, MYDADDY_URL) ===
    'https://s2.bigcdn.cc/pubs/62cf1617754f13.dsad/main.jpg');
check('no duration → null', embed.extractDurationSeconds('<html></html>') === null);

// ── 5b. HLS masters + DASH awareness ───────────────────────────────────────
const HLS_PLAYER_HTML = `
<html><head><title>Stream Title - mydaddy.cc</title></head><body>
<video id="player" controls>
  <source src="https://s9.bigcdn.cc/hls/abc123/master.m3u8" type="application/x-mpegURL" data-quality="720p" />
</video>
<a href="https://s9.bigcdn.cc/hls/abc123/master.m3u8">Watch in 720p quality</a>
</body></html>`;
{
  const vs = embed.extractMydaddyVariants(HLS_PLAYER_HTML, MYDADDY_URL);
  check('m3u8 extracted as hls', vs.length === 1 && vs[0].isMp4 === false &&
    vs[0].contentType === 'application/x-mpegURL', JSON.stringify(vs.map(v => v.quality)));
  check('hls quality from label', vs[0].quality === '720p' && vs[0].height === 720);
}
{
  const mixed = embed.extractMydaddyVariants(
    MYDADDY_HTML + `<a href="https://s9.bigcdn.cc/hls/abc123/master.m3u8">720p</a>`, MYDADDY_URL);
  check('mp4 sorts before hls', mixed[0].isMp4 === true && mixed[mixed.length - 1].isMp4 === false);
}
{
  const dashOnly = embed.extractMydaddyVariants(
    `<html><body><video><source src="https://cdn.example.com/v/stream.mpd" /></video></body></html>`,
    MYDADDY_URL);
  check('mpd counted, never offered', dashOnly.length === 0 && dashOnly._mpdCount === 1);
}

// ── 6. full resolve with stubbed fetches ──────────────────────────────────
(async () => {
  const stubFetch = async (url) => {
    if (url.includes('hqporner.com')) return HQPORNER_HTML;
    if (url.includes('mydaddy.cc')) return MYDADDY_HTML;
    throw new Error('unexpected fetch: ' + url);
  };

  const r = await embed.resolveEmbedVideos(HQPORNER_URL, { fetchHtml: stubFetch });
  check('resolve provider/id', r.provider === 'hqporner' && r.id === '127856');
  // <title> ("Kidnapped Body Heat") wins over the lowercase <h1>.
  check('resolve uses hqporner title', r.title === 'Kidnapped Body Heat', r.title);
  check('resolve duration + thumbnail', r.duration === 2153 && /main\.jpg$/.test(r.thumbnail || ''));
  check('resolve canonical/referer point at the player page',
    r.canonicalUrl === 'https://mydaddy.cc/video/09c662a75858eed4ca/' && r.referer === r.canonicalUrl);
  check('resolve videos best-first with filenames',
    r.videos.length === 4 &&
    r.videos[0].filename === 'Kidnapped Body Heat [1080p].mp4' &&
    r.videos[0].resolution === '1920x1080');

  const m = await embed.resolveEmbedVideos(MYDADDY_URL, { fetchHtml: stubFetch });
  check('mydaddy direct resolve', m.provider === 'mydaddy' && m.videos.length === 4);
  check('mydaddy title from player page', m.title === 'Some Video Title', m.title);

  const picker = embed.toPickerVideos(r.videos);
  check('picker shape', picker[0].url === r.videos[0].url && picker[0].format === 'mp4');

  let threw = null;
  try {
    await embed.resolveEmbedVideos(HQPORNER_URL, { fetchHtml: async () => '<html><body>no player</body></html>' });
  } catch (e) { threw = e; }
  check('missing embed throws readable error', !!threw && /No playable video/.test(threw.message));

  let threw2 = null;
  try { await embed.resolveEmbedVideos('https://x.com/foo/status/123456789012345678'); }
  catch (e) { threw2 = e; }
  check('non-embed URL throws', !!threw2 && /Not a mydaddy/.test(threw2.message));

  let threwDash = null;
  try {
    await embed.resolveEmbedVideos(MYDADDY_URL, {
      fetchHtml: async () => '<html><body><video><source src="https://cdn.example.com/v/s.mpd" /></video></body></html>',
    });
  } catch (e) { threwDash = e; }
  check('DASH-only page throws DASH-specific error',
    !!threwDash && /DASH/.test(threwDash.message), threwDash && threwDash.message);

  const hlsResolved = await embed.resolveEmbedVideos(MYDADDY_URL, {
    fetchHtml: async () => HLS_PLAYER_HTML,
  });
  check('hls resolve keeps hls format + m3u8 filename',
    hlsResolved.videos.length === 1 && hlsResolved.videos[0].format === 'hls' &&
    /\.m3u8$/.test(hlsResolved.videos[0].filename), hlsResolved.videos[0].filename);

  // ── 7. registry wiring ──────────────────────────────────────────────────
  check('registry supports hqporner page', resolvers.hasResolverFor(HQPORNER_URL));
  check('registry supports mydaddy page', resolvers.hasResolverFor(MYDADDY_URL));
  check('registry rejects file URLs',
    !resolvers.hasResolverFor('https://s45.bigcdn.cc/pubs/x/1080.mp4'));
  const found = resolvers.findResolver(HQPORNER_URL);
  check('embed resolver wins for hqporner', found && found.name === 'embed');

  // ── 8. SSRF guard (no network touched) ──────────────────────────────────
  let ssrf = null;
  try { await embed.fetchPageHtml('https://evil.example/video/123/'); }
  catch (e) { ssrf = e; }
  check('off-allowlist fetch refused', !!ssrf && /allowlist/.test(ssrf.message));

  // ── 9. service-worker parity: background.js mirrors the parsers ──────────
  // The resolve-embed fallback parses with the SW copies; behavior must match
  // the desktop copies on the same fixtures or the two paths diverge.
  {
    const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'background.js'), 'utf8');
    const mapMatch = /const QUALITY_RESOLUTION = (\{[\s\S]*?\});/.exec(bgSrc);
    if (!mapMatch) throw new Error('QUALITY_RESOLUTION not found in background.js');
    const QUALITY_RESOLUTION_BG = new Function('return (' + mapMatch[1] + ');')();
    const lib = new Function(
      'QUALITY_RESOLUTION',
      grabShipped(bgSrc, 'qualityFromLabel') + '\n' +
      grabShipped(bgSrc, 'textOf') + '\n' +
      grabShipped(bgSrc, 'extractEmbedTitle') + '\n' +
      grabShipped(bgSrc, 'extractMydaddyEmbed') + '\n' +
      grabShipped(bgSrc, 'extractMydaddyVariants') + '\n' +
      grabShipped(bgSrc, 'extractDurationSeconds') + '\n' +
      grabShipped(bgSrc, 'extractThumbnail') + '\n' +
      'return { qualityFromLabel, textOf, extractEmbedTitle, extractMydaddyEmbed,' +
      ' extractMydaddyVariants, extractDurationSeconds, extractThumbnail };'
    )(QUALITY_RESOLUTION_BG);
    const norm = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === '_mpdCount' ? undefined : v)));
    check('SW extractMydaddyEmbed parity',
      lib.extractMydaddyEmbed(HQPORNER_HTML) === embed.extractMydaddyEmbed(HQPORNER_HTML));
    check('SW extractEmbedTitle parity',
      lib.extractEmbedTitle(HQPORNER_HTML, 'hqporner.com') === embed.extractEmbedTitle(HQPORNER_HTML, 'hqporner.com') &&
      lib.extractEmbedTitle(MYDADDY_HTML, 'mydaddy.cc') === embed.extractEmbedTitle(MYDADDY_HTML, 'mydaddy.cc'));
    check('SW extractMydaddyVariants parity',
      JSON.stringify(norm(lib.extractMydaddyVariants(MYDADDY_HTML, MYDADDY_URL))) ===
      JSON.stringify(norm(embed.extractMydaddyVariants(MYDADDY_HTML, MYDADDY_URL))));
    check('SW hls extraction parity',
      JSON.stringify(norm(lib.extractMydaddyVariants(HLS_PLAYER_HTML, MYDADDY_URL))) ===
      JSON.stringify(norm(embed.extractMydaddyVariants(HLS_PLAYER_HTML, MYDADDY_URL))));
    check('SW duration/thumbnail parity',
      lib.extractDurationSeconds(HQPORNER_HTML) === embed.extractDurationSeconds(HQPORNER_HTML) &&
      lib.extractThumbnail(MYDADDY_HTML, MYDADDY_URL) === embed.extractThumbnail(MYDADDY_HTML, MYDADDY_URL));
    check('SW resolve-embed forwards to the quality picker',
      /action === 'resolve-embed'/.test(bgSrc) &&
      /\/api\/video-detected/.test(bgSrc) &&
      /credentials: 'include'/.test(bgSrc));
    const popSrc = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'popup.js'), 'utf8');
    check('popup has resolve-page-video entry',
      /btn-resolve/.test(popSrc) && /action: 'resolve-embed'/.test(popSrc));
  }

  // ── 10. resolve failures surface instead of saving page HTML ─────────────
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check('failed resolve returns resolveFailed (no silent HTML download)',
      /resolveFailed: true/.test(mainSrc) &&
      !/Fall through and\n    \/\/ let the URL be added normally/.test(mainSrc));
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
    check('add-URL dialog shows resolve errors',
      /result\.resolveFailed/.test(appSrc) && /Could not resolve video/.test(appSrc));
  }

  console.log(`\nembed-resolver: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
