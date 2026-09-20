// Regression harness for "AiDM can't detect/download Facebook videos".
//
// Root cause chain:
//   1. No resolver claimed facebook.com/watch (reel, fb.watch, instagram)
//      page URLs, so pasting one fell through to a direct download of the
//      page HTML itself — the classic "AiDM can't download Facebook videos".
//   2. The browser extension only auto-resolved tweets on full page loads
//      (tabs.onUpdated), missing every SPA navigation on facebook.com too.
//
// Shipped behavior under test (pure parsers + stubbed resolve):
//   - parseFacebookUrl strictness (watch/reel/share/video.php/fb.watch/
//     instagram reel|p|tv; rejects media URLs and non-video paths)
//   - extractFacebookTitle (og:title wins, site suffix stripped, hostname
//     never returned)
//   - extractFacebookVariants on a real FB page shape (hd_src/sd_src/
//     playable_url/browser_native first, audio-only efg skipped, HLS last,
//     DASH counted but never offered, best-first, de-duplicated)
//   - isLoginWall detection
//   - resolveFacebookVideos end-to-end with stubbed page fetches
//   - resolver registry wiring (supports + provider dispatch)
//   - fetchPageHtml SSRF guard (off-allowlist refused without network)
//
// Run: node test/facebook-resolver.js
'use strict';

const fb = require('../src/facebook-resolver');
const resolvers = require('../src/resolvers');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── 1. parseFacebookUrl ──────────────────────────────────────────────────
check('watch?v=',
  fb.parseFacebookUrl('https://www.facebook.com/watch/?v=123456789012345')?.id === '123456789012345');
check('video.php?v=',
  fb.parseFacebookUrl('https://www.facebook.com/video.php?v=123456789012345')?.id === '123456789012345');
check('page videos path',
  fb.parseFacebookUrl('https://www.facebook.com/SomePage/videos/123456789012345/')?.id === '123456789012345');
check('reel',
  fb.parseFacebookUrl('https://www.facebook.com/reel/AbC123xYz/')?.provider === 'facebook');
check('share link',
  fb.parseFacebookUrl('https://www.facebook.com/share/v/AbC123xYz/')?.provider === 'facebook');
check('fb.watch short link',
  fb.parseFacebookUrl('https://fb.watch/AbC123xYz/')?.provider === 'facebook');
check('instagram reel',
  fb.parseFacebookUrl('https://www.instagram.com/reel/C8abcDEF123/')?.provider === 'instagram');
check('instagram post',
  fb.parseFacebookUrl('https://www.instagram.com/p/C8abcDEF123/')?.provider === 'instagram');
check('rejects fbcdn media URL',
  fb.parseFacebookUrl('https://video.few1-1.fna.fbcdn.net/v/t42.9040-2/123_n.mp4?oh=a&oe=b') === null);
check('rejects facebook home',
  fb.parseFacebookUrl('https://www.facebook.com/') === null);
check('rejects facebook profile',
  fb.parseFacebookUrl('https://www.facebook.com/SomePage/') === null);
check('rejects watch without id',
  fb.parseFacebookUrl('https://www.facebook.com/watch/') === null);
check('rejects non-video host',
  fb.parseFacebookUrl('https://example.com/watch/?v=123456789012345') === null);
check('rejects garbage',
  fb.parseFacebookUrl('not a url') === null && fb.parseFacebookUrl(null) === null);
check('isFacebookUrl mirrors parse',
  fb.isFacebookUrl('https://www.facebook.com/watch/?v=123456789012345') === true &&
  fb.isFacebookUrl('https://video.twimg.com/x.mp4') === false);

// ── 2. extractFacebookTitle ──────────────────────────────────────────────
check('og:title wins, site suffix stripped',
  fb.extractFacebookTitle('<meta property="og:title" content="Funny cat video - Facebook" />', 'facebook.com') === 'Funny cat video');
check('title fallback',
  fb.extractFacebookTitle('<title>My Reel | Facebook</title>', 'facebook.com') === 'My Reel');
check('hostname never a title',
  fb.extractFacebookTitle('<title>facebook.com</title>', 'facebook.com') === null);
check('login placeholder rejected',
  fb.extractFacebookTitle('<title>Log in | Facebook</title>', 'facebook.com') === null);

// ── 3. extractFacebookVariants ───────────────────────────────────────────
const AUDIO_EFG = b64url({ encode_tag: 'dash_audio_only', video_id: 111 });
const VIDEO_EFG = b64url({ encode_tag: 'dash_hd', video_id: 111 });
const FIXTURE = `
<html><head><title>Fixture</title></head><body>
<script>{"playable_url":"https:\\/\\/video.few1-1.fna.fbcdn.net\\/v\\/t42.9040-2\\/111_sd.mp4?oh=aaa\\u0026oe=bbb",
"playable_url_quality_hd":"https:\\/\\/video.few1-1.fna.fbcdn.net\\/v\\/t42.9040-2\\/111_hd.mp4?oh=aaa\\u0026oe=bbb",
"browser_native_hd_url":"https:\\/\\/video.few1-1.fna.fbcdn.net\\/v\\/t42.9040-2\\/111_hd2.mp4?oh=aaa\\u0026oe=bbb",
"hd_src":"https:\\/\\/video.few1-1.fna.fbcdn.net\\/v\\/t42.9040-2\\/111_hdsrc.mp4?oh=aaa\\u0026oe=bbb",
"sd_src":"https:\\/\\/video.few1-1.fna.fbcdn.net\\/v\\/t42.9040-2\\/111_sdsrc.mp4?oh=aaa\\u0026oe=bbb"}</script>
<script>junk "dash_manifest_url":"https:\\/\\/video.few1-1.fna.fbcdn.net\\/v\\/t1.0-0\\/manifest.mpd?x=1"</script>
</body></html>`;

{
  const variants = fb.extractFacebookVariants(FIXTURE, 'https://www.facebook.com/watch/?v=111');
  check('finds progressive variants', variants.length >= 4, `got ${variants.length}`);
  check('mp4 before hls, best first',
    variants.every(v => v.isMp4) && variants[0].height >= variants[variants.length - 1].height);
  check('no duplicates', new Set(variants.map(v => v.url)).size === variants.length);
  check('mpd counted not offered',
    variants.every(v => !/\.mpd/i.test(v.url)) && variants._mpdCount >= 1);
}

// ── 3b. playing/page-video only (related videos dropped) ───────────────────
{
  const other = 'https://video.xx.fbcdn.net/v/t42.9040-2/999999999_n.mp4?oh=x&oe=y';
  const mixed = `
    <script>{"playable_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/t42.9040-2\\/111_sd.mp4?oh=aaa",
    "playable_url_quality_hd":"https:\\/\\/video.xx.fbcdn.net\\/v\\/t42.9040-2\\/111_hd.mp4?oh=aaa"}</script>
    <script>{"playable_url":"${other}"}</script>`;
  const scoped = fb.extractFacebookVariants(mixed, 'https://www.facebook.com/watch/?v=111');
  check('page video variants kept',
    scoped.some(v => /111_/.test(v.url)) && scoped.length >= 2,
    scoped.map(v => v.url).join(' | '));
  check('related not-playing video dropped',
    !scoped.some(v => /999999999/.test(v.url)),
    scoped.map(v => v.url).join(' | '));
  check('filterVariantsToPageVideo keeps matching only',
    (() => {
      const all = [
        { url: 'https://video.xx.fbcdn.net/v/t/111_n.mp4' },
        { url: 'https://video.xx.fbcdn.net/v/t/999999999_n.mp4' },
      ];
      const out = fb.filterVariantsToPageVideo(all, '111', mixed);
      return out.length === 1 && /111_/.test(out[0].url);
    })());
  check('unattributable list left intact (short reel tokens)',
    fb.filterVariantsToPageVideo([{ url: 'https://video.xx.fbcdn.net/v/t/x_n.mp4' }], 'watch-AbC', '')
      .length === 1);
  // Fail-open: progressive URLs with no id in the path must survive when
  // they cannot be proven to be another video.
  check('fail-open keeps unattributable progressive siblings',
    (() => {
      const all = [
        { url: 'https://video.xx.fbcdn.net/v/t42.9040-2/abcdef_n.mp4' },
        { url: 'https://video.xx.fbcdn.net/v/t/999999999_n.mp4' },
      ];
      const out = fb.filterVariantsToPageVideo(all, '111', '');
      return out.some(v => /abcdef/.test(v.url)) && !out.some(v => /999999999/.test(v.url));
    })());
  check('fail-open: nothing attributable → list unchanged',
    fb.filterVariantsToPageVideo([
      { url: 'https://video.xx.fbcdn.net/v/t42.9040-2/aaa_n.mp4' },
      { url: 'https://video.xx.fbcdn.net/v/t42.9040-2/bbb_n.mp4' },
    ], '111', '').length === 2);
}

{
  const audioUrl = `https://scontent.xx.fbcdn.net/v/t66.0-0/111_n.mp4?efg=${encodeURIComponent(AUDIO_EFG)}&oh=a&oe=b`;
  const videoUrl = `https://video.few1-1.fna.fbcdn.net/v/t42.9040-2/111_n.mp4?efg=${encodeURIComponent(VIDEO_EFG)}&oh=a&oe=b`;
  const html = `<script>{"hd_src":"${videoUrl}","sd_src":"${audioUrl}"}</script>`;
  const variants = fb.extractFacebookVariants(html, 'https://www.facebook.com/watch/?v=111');
  const urls = variants.map(v => v.url);
  // NOTE: compare the FULL efg blob — audio/video payloads share a base64
  // prefix ({"encode_tag":"dash_), so a prefix match would false-positive.
  check('audio-only efg rendition skipped',
    !urls.some(u => u.includes(AUDIO_EFG)));
  check('video efg rendition kept',
    urls.some(u => u.includes(VIDEO_EFG)));
  check('split-AV audio is paired onto the video row as audioUrl',
    variants.some(v => /111_n\.mp4/.test(v.url) && v.audioUrl && v.audioUrl.includes(AUDIO_EFG)),
    variants.map(v => v.url + ' → ' + (v.audioUrl || 'none')).join(' | '));
  check('toPickerVideos forwards audioUrl',
    fb.toPickerVideos(variants).some(p => p.audioUrl && p.audioUrl.includes(AUDIO_EFG)));
}

// Silent-download regression: extensionless efg-audio renditions (no .mp4)
// and audio under audio-specific keys must still be harvested and paired —
// otherwise the video row ships with no audioUrl and downloads silent.
{
  const extAudio = `https://scontent.xx.fbcdn.net/v/t66.0-0/abcdef?efg=${encodeURIComponent(AUDIO_EFG)}&oh=a&oe=b`;
  const videoUrl = `https://video.few1-1.fna.fbcdn.net/v/t42.9040-2/111_n.mp4?efg=${encodeURIComponent(VIDEO_EFG)}&oh=a&oe=b`;
  const html = `<script>{"hd_src":"${videoUrl}"}</script><script>{"dash_audio":"${extAudio}"}</script>`;
  const variants = fb.extractFacebookVariants(html, 'https://www.facebook.com/watch/?v=111');
  check('extensionless efg-audio harvested + paired (not silent)',
    variants.some(v => /111_n\.mp4/.test(v.url) && v.audioUrl && v.audioUrl.includes('scontent')),
    variants.map(v => v.url + ' → ' + (v.audioUrl || 'none')).join(' | '));
}

// v4.8.3 silent-download regression: Facebook tags many audio renditions with
// a CODEC fingerprint and NO literal "audio" word (dash_ln_heaac_vbr3,
// dash_aac_lc, dash_mp4a.40.2). The old /audio/i-only match classified those
// as VIDEO rows — the real video then downloaded silent. These must be
// detected as audio (never offered as a video row) and paired as audioUrl.
{
  const efgAudio = (tag) => encodeURIComponent(b64url({ encode_tag: tag, video_id: 555 }));
  const audioEfgs = ['dash_ln_heaac_vbr3', 'dash_aac_lc', 'dash_mp4a.40.2', 'dash_ln_heaacv3'];
  const videoEfgs = ['dash_r2av1-r1gen2vp9_q20', 'dash_vp9_basic_gen2', 'dash_av1', 'dash_avc1.64001f'];
  check('audio-codec tags (no "audio" word) detected as audio',
    audioEfgs.every(t => fb.efgIsAudio(decodeURIComponent(efgAudio(t)))),
    audioEfgs.map(t => t + '=' + fb.efgIsAudio(decodeURIComponent(efgAudio(t)))).join(','));
  check('video-codec tags never misclassified as audio',
    videoEfgs.every(t => !fb.efgIsAudio(decodeURIComponent(efgAudio(t)))),
    videoEfgs.map(t => t + '=' + fb.efgIsAudio(decodeURIComponent(efgAudio(t)))).join(','));
}

{
  // End-to-end: a page whose audio rendition carries ONLY a codec tag (no
  // "audio" word) must still pair that audio onto the video row.
  const videoUrl = `https://video.xx.fbcdn.net/v/t42.9040-2/555_n.mp4?efg=${encodeURIComponent(b64url({ encode_tag: 'dash_r2av1-r1gen2vp9_q20', video_id: 555 }))}&oh=a`;
  const audioUrl = `https://scontent.xx.fbcdn.net/v/t66.0-0/aud555?efg=${encodeURIComponent(b64url({ encode_tag: 'dash_ln_heaac_vbr3', video_id: 555 }))}&oh=a`;
  const html = `<script>{"playable_url":"${videoUrl}","audio_url":"${audioUrl}"}</script>`;
  const variants = fb.extractFacebookVariants(html, 'https://www.facebook.com/watch/?v=555');
  const v = variants.find(x => /555_n\.mp4/.test(x.url));
  check('codec-tagged audio (no "audio" word) harvested + paired, not silent',
    !!(v && v.audioUrl && v.audioUrl.includes('aud555')),
    variants.map(x => x.url + ' → ' + (x.audioUrl || 'none')).join(' | '));
  check('codec-tagged audio is NOT listed as a video row',
    !variants.some(x => /aud555/.test(x.url)));
}

{
  const videoUrl = `https://video.xx.fbcdn.net/v/t42.9040-2/222_n.mp4?oh=a&oe=b`;
  const audio222 = `https://scontent.xx.fbcdn.net/v/t66.0-0/abcdef?efg=${encodeURIComponent(b64url({ encode_tag: 'dash_audio_only', video_id: 222 }))}&oh=a`;
  const html = `<script>{"playable_url":"${videoUrl}","audio_url":"${audio222}"}</script>`;
  const variants = fb.extractFacebookVariants(html, 'https://www.facebook.com/watch/?v=222');
  const v = variants.find(x => /222_n\.mp4/.test(x.url));
  check('audio_url key harvested + paired onto same-video row',
    !!(v && v.audioUrl && /222/.test(fb.videoIdFromFbUrl(v.audioUrl) || v.audioUrl)));
}

{
  // Same audio surfacing under two paths (audio_url key + generic efg sweep)
  // must dedupe — otherwise the sole-audio fallback dies and id-less videos
  // download silent.
  const soleAudio = `https://scontent.xx.fbcdn.net/v/t66.0-0/xyzabc?efg=${encodeURIComponent(b64url({ encode_tag: 'dash_audio_only', video_id: 999 }))}&oh=a`;
  const videoUrl = `https://video.xx.fbcdn.net/v/t42.9040-2/hashprog.mp4?oh=a&oe=b`;
  const html = `<script>{"playable_url":"${videoUrl}","audio_url":"${soleAudio}"}</script>`;
  const variants = fb.extractFacebookVariants(html, 'https://www.facebook.com/watch/?v=444');
  const v = variants.find(x => /hashprog/.test(x.url));
  check('deduped single audio still pairs (not silent)',
    !!(v && v.audioUrl));
}

{
  const hlsHtml = `<script>{"hls_playlist_url":"https://video.few1-1.fna.fbcdn.net/v/hls/111.m3u8?oh=a"}</script>`;
  const variants = fb.extractFacebookVariants(hlsHtml, 'https://www.facebook.com/watch/?v=111');
  check('hls kept as last resort',
    variants.length === 1 && variants[0].isMp4 === false);
}

// ── 4. isLoginWall ───────────────────────────────────────────────────────
check('login wall detected',
  fb.isLoginWall('<div>You must log in to continue</div><form id="login_form">') === true);
check('real page not a wall', fb.isLoginWall(FIXTURE) === false);

// ── 5. resolveFacebookVideos (stubbed fetch) ─────────────────────────────
(async () => {
  const stub = async () => ({
    html: `<meta property="og:title" content="Stub video - Facebook" />` + FIXTURE,
    finalUrl: 'https://www.facebook.com/watch/?v=111',
  });
  try {
    const r = await fb.resolveFacebookVideos('https://www.facebook.com/watch/?v=123456789012345', { fetchHtml: stub });
    check('resolve provider/id', r.provider === 'facebook' && r.id === '123456789012345');
    check('resolve title', r.title === 'Stub video');
    check('resolve videos have filenames',
      r.videos.length >= 4 && r.videos.every(v => /\.mp4$/i.test(v.filename)));
    check('resolve picker shape',
      fb.toPickerVideos(r.videos).every(v => v.url && v.filename && v.quality));
    check('resolve referer is page', /facebook\.com/.test(r.referer));
  } catch (e) {
    check('resolve stubbed page', false, e.message);
  }

  try {
    // Padded past the short-content guard so the login-wall branch itself is
    // exercised, not the empty-page branch.
    const wallHtml = ('<div>timeline filler text lorem ipsum dolor sit amet </div>'.repeat(30)) +
      '<div>You must log in to continue</div><form id="login_form">';
    await fb.resolveFacebookVideos('https://www.facebook.com/watch/?v=123456789012345',
      { fetchHtml: async () => ({ html: wallHtml, finalUrl: 'https://www.facebook.com/watch/?v=1' }) });
    check('login wall throws', false);
  } catch (e) {
    check('login wall throws', /needs a Facebook\/Instagram login/i.test(e.message), e.message);
  }

  try {
    await fb.resolveFacebookVideos('https://www.facebook.com/watch/?v=123456789012345',
      { fetchHtml: async () => ({ html: '<html><body>no video here at all, just text '.repeat(50), finalUrl: 'https://www.facebook.com/watch/?v=1' }) });
    check('empty page throws', false);
  } catch (e) {
    check('empty page throws', /No downloadable video/i.test(e.message), e.message);
  }

  try {
    await fb.resolveFacebookVideos('https://example.com/watch/?v=123', { fetchHtml: stub });
    check('non-fb url rejected', false);
  } catch (e) {
    check('non-fb url rejected', /Not a Facebook/i.test(e.message));
  }

  // ── 6. registry wiring ───────────────────────────────────────────────
  check('facebook resolver registered',
    resolvers.hasResolverFor('https://www.facebook.com/watch/?v=123456789012345') === true);
  check('registry dispatches to facebook',
    resolvers.findResolver('https://www.facebook.com/reel/AbC123xYz/')?.name === 'facebook');
  check('registry ignores fbcdn media urls',
    resolvers.hasResolverFor('https://video.few1-1.fna.fbcdn.net/v/t42.9040-2/1_n.mp4?oh=a') === false);
  check('twitter still dispatches to twitter',
    resolvers.findResolver('https://x.com/u/status/1234567890123456789')?.name === 'twitter');
  try {
    const r = await resolvers.resolveMedia('https://www.facebook.com/watch/?v=123456789012345', { fetchHtml: stub });
    check('resolveMedia end-to-end (facebook)',
      r.provider === 'facebook' && Array.isArray(r.media) && r.media.length >= 4 &&
      r.pickerVideos.length === r.media.length);
    check('best progressive flagged preferred',
      r.media.some(m => m.preferred === true && m.format === 'mp4'));
  } catch (e) {
    check('resolveMedia end-to-end (facebook)', false, e.message);
  }

  // ── 7. SSRF guard (no network) ───────────────────────────────────────
  try {
    await fb.fetchPageHtml('https://evil.example.com/video');
    check('off-allowlist refused', false);
  } catch (e) {
    check('off-allowlist refused', /allowlist/i.test(e.message), e.message);
  }

  console.log(`\nfacebook-resolver: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
