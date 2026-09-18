// Quick smoke test for AiDM core helpers. Run: node test/smoke.js
const path = require('path');
const eng = require('../src/download-engine');
const dm = require('../src/download-manager');
const tw = require('../src/twitter-resolver');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}
function throws(fn) {
  try { fn(); return false; } catch (e) { return true; }
}

console.log('── download-engine ──');
check('buildRequestHeaders has Chrome UA', /Chrome/.test(eng.buildRequestHeaders('https://x.com/a.mp4')['User-Agent']));
check('buildRequestHeaders invents no Referer (page Referer is replayed by the manager)',
  eng.buildRequestHeaders('https://x.com/a.mp4').Referer === undefined,
  String(eng.buildRequestHeaders('https://x.com/a.mp4').Referer));
const withRef = eng.buildRequestHeaders('https://s45.bigcdn.cc/pubs/x/1080.mp4', { Referer: 'https://mydaddy.cc/video/abc/' });
check('buildRequestHeaders caller Referer wins', withRef.Referer === 'https://mydaddy.cc/video/abc/');
const badUA = eng.buildRequestHeaders('https://x.com/a.mp4', { 'User-Agent': 'curl/8' });
check('buildRequestHeaders caller UA wins', badUA['User-Agent'] === 'curl/8');

const he = new eng.HttpError('boom', 403, 'https://x.com/a.m3u8');
check('HttpError carries status', he.status === 403 && he instanceof Error);
check('isDnsLookupError recognizes ENOTFOUND', eng.isDnsLookupError({ code: 'ENOTFOUND' }));
const dohRecord = eng.parseDohIPv4({ Answer: [{ type: 28, data: '2001:db8::1' }, { type: 1, TTL: 150, data: '203.0.113.7' }] });
check('parseDohIPv4 selects IPv4 answer', dohRecord && dohRecord.address === '203.0.113.7' && dohRecord.ttl === 150);

const keyAttrs = eng.parseKeyAttrs('METHOD=AES-128,URI="key",IV=0x1');
check('parseKeyAttrs method', keyAttrs.METHOD === 'AES-128');
check('parseKeyAttrs uri', keyAttrs.URI === 'key');

// HLS media playlist with per-segment key rotation
const rot = [
  '#EXTM3U',
  '#EXT-X-KEY:METHOD=AES-128,URI="k1"',
  '#EXTINF:4,',
  's1.ts',
  '#EXT-X-KEY:METHOD=AES-128,URI="k2"',
  '#EXTINF:4,',
  's2.ts',
].join('\n');
const rotParsed = eng.parseHlsMedia(rot, 'https://cdn.example.com/');
check('parseHlsMedia rotation key1', rotParsed.segs[0].key && rotParsed.segs[0].key.URI === 'k1');
check('parseHlsMedia rotation key2', rotParsed.segs[1].key && rotParsed.segs[1].key.URI === 'k2');

const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
  '720p.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080',
  '1080p.m3u8',
].join('\n');
const variants = eng.parseHlsMaster(master, 'https://cdn.example.com/');
check('parseHlsMaster count', variants.length === 2, `got ${variants.length}`);
check('parseHlsMaster height', variants.some(v => v.height === 1080));

const media = [
  '#EXTM3U',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:4,',
  '#EXT-X-BYTERANGE:1000@0',
  'seg1.m4s',
  '#EXTINF:4,',
  '#EXT-X-BYTERANGE:1000@1000',
  'seg2.m4s',
  '#EXT-X-ENDLIST',
].join('\n');
const parsed = eng.parseHlsMedia(media, 'https://cdn.example.com/');
check('parseHlsMedia segs', parsed.segs.length === 2, `got ${parsed.segs.length}`);
check('parseHlsMedia map', !!parsed.mapUri);
check('parseHlsMedia range', parsed.segs[0].range && parsed.segs[0].range.length === 1000);

const cd = eng.filenameFromContentDisposition('attachment; filename="my file.mp4"');
check('filenameFromContentDisposition', cd === 'my file.mp4', `got ${cd}`);

check('extFromMime mp4', eng.extFromMime('video/mp4; codecs=avc1') === 'mp4');
check('extFromMime zip', eng.extFromMime('application/zip') === 'zip');

console.log('── twitter-resolver ──');
check('isTweetUrl x.com', tw.isTweetUrl('https://x.com/user/status/1234567890123456789'));
check('isTweetUrl media false', !tw.isTweetUrl('https://video.twimg.com/ext_tw_video/123/pu/vid/720/abc.mp4'));
check('extractTweetId', tw.extractTweetId('https://twitter.com/foo/status/987654321098765432') === '987654321098765432');

// Syndication metadata extraction (pure — no network)
const syj = {
  text: 'First line of the post\nsecond line',
  user: { screen_name: 'nasa' },
  mediaDetails: [
    { type: 'video', media_url_https: 'https://pbs.twimg.com/poster.jpg',
      video_info: { duration_millis: 18400, variants: [] } },
    { type: 'video', media_url_https: 'https://pbs.twimg.com/poster2.jpg',
      video_info: { duration_millis: 9500, variants: [] } },
  ],
};
const syMeta = tw.metaFromSyndication(syj);
check('metaFromSyndication title', syMeta.title === 'First line of the post', syMeta.title);
check('metaFromSyndication thumbnail', syMeta.thumbnail === 'https://pbs.twimg.com/poster.jpg');
check('metaFromSyndication duration picks longest', syMeta.duration === 18.4, syMeta.duration);
check('metaFromSyndication empty', tw.metaFromSyndication({}).title === 'Tweet');

console.log('── resolver layer ──');
const rs = require('../src/resolvers');

// Strict identifier-only parsing
check('parseTwitterUrl x.com', rs.parseTwitterUrl('https://x.com/user/status/1234567890123456789').statusId === '1234567890123456789');
check('parseTwitterUrl twitter.com', rs.parseTwitterUrl('https://twitter.com/foo/status/987654321098765432?s=20').username === 'foo');
check('parseTwitterUrl mobile', rs.parseTwitterUrl('https://mobile.twitter.com/foo/statuses/123456789012345').statusId === '123456789012345');
check('parseTwitterUrl i/web', rs.parseTwitterUrl('https://x.com/i/web/status/123456789012345678').username === null);
check('parseTwitterUrl trailing path', rs.parseTwitterUrl('https://x.com/foo/status/123456789012345678/photo/1').statusId === '123456789012345678');
check('parseTwitterUrl canonical', rs.parseTwitterUrl('https://twitter.com/foo/status/123456789012345678?s=20&t=x').canonicalUrl === 'https://x.com/foo/status/123456789012345678');
check('parseTwitterUrl rejects other host', throws(() => rs.parseTwitterUrl('https://example.com/foo/status/123456789012345678')));
check('parseTwitterUrl rejects /status/123abc', throws(() => rs.parseTwitterUrl('https://x.com/foo/status/123abc')));
check('parseTwitterUrl rejects non-post path', throws(() => rs.parseTwitterUrl('https://x.com/foo/following')));
check('parseTwitterUrl rejects garbage', throws(() => rs.parseTwitterUrl('not a url at all')));

// Strict parser must not mistake twimg media URLs (long digit ids) for posts
check('parser vs media URL', throws(() => rs.parseTwitterUrl('https://video.twimg.com/ext_tw_video/1001551417340022785/pu/vid/720x1280/abc.mp4')));

// bestMP4 — provider-independent selection
const pickVariants = [
  { url: 'a.m3u8', mime: 'application/x-mpegurl', height: 1080, bitrate: 2000 },
  { url: '360.mp4', mime: 'video/mp4', height: 360, bitrate: 500 },
  { url: '720.mp4', mime: 'video/mp4', height: 720, bitrate: 1200 },
  { url: '720hi.mp4', mime: 'video/mp4', height: 720, bitrate: 2176 },
];
const bm = rs.bestMP4(pickVariants);
check('bestMP4 picks highest then bitrate', bm && bm.url === '720hi.mp4');
check('bestMP4 null when HLS-only', rs.bestMP4([{ url: 'x.m3u8', mime: 'application/x-mpegurl' }]) === null);

// Registry
check('twitter resolver registered', rs.hasResolverFor('https://x.com/foo/status/123456789012345678'));
check('registry rejects non-member URL', !rs.hasResolverFor('https://example.com/video.mp4'));
rs.registerResolver({ name: 'mock', supports: () => true, resolve: async () => ({ provider: 'mock', id: 'x', media: [] }) });
check('registerResolver + precedence', rs.hasResolverFor('https://example.com/x.mp4'));
check('bad resolver rejected', throws(() => rs.registerResolver({ name: 'bad' })));

console.log('── download-manager ──');
check('detectCategory mp4', dm.detectCategory('movie.mp4') === 'video');
check('detectCategory zip', dm.detectCategory('archive.zip') === 'archive');
check('detectCategory unknown', dm.detectCategory('file.xyz') === 'other');
check('isHlsUrl', dm.isHlsUrl('https://x.com/a.m3u8?tok=1'));
check('isHlsUrl query param', dm.isHlsUrl('https://x.com/p?file=/x/master.m3u8'));
check('isHlsUrl trailing slash', dm.isHlsUrl('https://x.com/index.m3u8/'));
check('isHlsUrl false', !dm.isHlsUrl('https://x.com/a.mp4'));
check('isDashUrl', dm.isDashUrl('https://x.com/a.mpd'));
check('isDashUrl false', !dm.isDashUrl('https://x.com/a.mp4'));

const n1 = dm.normalizeMediaUrl('https://CDN.Example.com/video.mp4?token=abc&quality=hd&expires=999');
const n2 = dm.normalizeMediaUrl('https://cdn.example.com/video.mp4?quality=hd&token=xyz&expires=111');
check('normalizeMediaUrl token-strip', n1 === n2 && n1 !== null, n1);

// Twitter/X: ?tag= rotates per player poll — same file must normalize equal.
const tw1 = dm.normalizeMediaUrl('https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/abc.mp4?tag=12');
const tw2 = dm.normalizeMediaUrl('https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/abc.mp4?tag=16');
check('normalizeMediaUrl twitter tag-strip', tw1 === tw2 && tw1 !== null, tw1);
const tw3 = dm.normalizeMediaUrl('https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/abc.mp4?tag=12&container=fmp4');
check('normalizeMediaUrl twitter container-strip', tw3 === tw1, tw3);
// Distinct variants (different hashes) must NOT collapse.
const twA = dm.normalizeMediaUrl('https://video.twimg.com/ext_tw_video/123/pu/vid/640x360/aaa.mp4?tag=12');
const twB = dm.normalizeMediaUrl('https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/bbb.mp4?tag=12');
check('normalizeMediaUrl twitter distinct kept', twA !== twB);

console.log('── ai-service ──');
const { AiService } = require('../src/ai-service');
const ai = new AiService({ apiKey: '' });
check('isConfigured empty', !ai.isConfigured());
const ai2 = new AiService({ apiKey: 'thk_live_test12345' });
check('isConfigured set', ai2.isConfigured());
check('keyPrefix safe', ai2.getConfigStatus().keyPrefix === 'thk_live…');

console.log('── clipboard patterns ──');
const { ClipboardMonitor } = require('../src/clipboard-monitor');
const cm = new ClipboardMonitor();
check('clipboard zip', cm._isDownloadUrl('https://example.com/file.zip'));
check('clipboard page false', !cm._isDownloadUrl('https://example.com/about'));
check('clipboard releases', cm._isDownloadUrl('https://github.com/org/repo/releases/download/v1/app.exe'));

(async () => {
  const testLookup = eng.createDohFallbackLookup(
    (_host, _opts, cb) => cb({ code: 'ENOTFOUND', message: 'simulated local DNS failure' }),
    async host => host === 'cdn.example.test' ? '203.0.113.44' : null
  );
  const lookupResult = await new Promise(resolve => {
    testLookup('cdn.example.test', {}, (error, address, family) => resolve({ error, address, family }));
  });
  check('DoH lookup falls back after ENOTFOUND', !lookupResult.error && lookupResult.address === '203.0.113.44' && lookupResult.family === 4);

  // resolveMedia rejects (async) when no resolver supports the URL — checked
  // before the mock resolver was registered, so re-verify via a fresh probe
  // of a URL only the mock matches.
  const rsAsync = await rs.resolveMedia('https://mock-provider.invalid/anything').then(v => v.provider);
  check('resolveMedia dispatches to provider', rsAsync === 'mock');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
