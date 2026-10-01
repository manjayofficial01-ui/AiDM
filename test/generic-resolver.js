// @ts-check
// Pattern tests for the generic long-tail resolver: strict host+path matching,
// the media-file guard, and registry routing (it must stay registered last and
// never steal URLs owned by a dedicated provider). No network, no yt-dlp.
const { matchPattern, isGenericVideoUrl } = require('../src/generic-resolver');
const { findResolver, hasResolverFor } = require('../src/resolvers');

let passed = 0;
let failed = 0;
function eq(name, actual, expected) {
  try { require('assert').deepStrictEqual(actual, expected); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
}
function check(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

console.log('\ngeneric resolver patterns');
eq('vimeo id', matchPattern('https://vimeo.com/76979871'), { provider: 'vimeo', id: '76979871' });
eq('vimeo with query', matchPattern('https://vimeo.com/76979871?share=copy_of_link'), { provider: 'vimeo', id: '76979871' });
eq('vimeo player host', matchPattern('https://player.vimeo.com/video/76979871/'), { provider: 'vimeo', id: '76979871' });
eq('vimeo channels path', matchPattern('https://vimeo.com/staff/picks/76979871'), { provider: 'vimeo', id: '76979871' });
eq('tiktok', matchPattern('https://www.tiktok.com/@user.name/video/7173786365744278786'), { provider: 'tiktok', id: '7173786365744278786' });
eq('reddit comment', matchPattern('https://www.reddit.com/r/videos/comments/abc12z/some-title/'), { provider: 'reddit', id: 'abc12z' });
eq('redd.it short', matchPattern('https://redd.it/abc12z'), { provider: 'reddit', id: 'abc12z' });
eq('twitch clips host', matchPattern('https://clips.twitch.tv/FunnyClipTitle'), { provider: 'twitch', id: 'FunnyClipTitle' });
eq('twitch channel clip', matchPattern('https://www.twitch.tv/someone/clip/ClipId-AbC123'), { provider: 'twitch', id: 'ClipId-AbC123' });

console.log('\ngeneric resolver rejections');
check('vimeo non-numeric path', !isGenericVideoUrl('https://vimeo.com/channels/staffpicks'));
check('vimeo search', !isGenericVideoUrl('https://vimeo.com/search?q=cat'));
check('tiktok profile (no video id)', !isGenericVideoUrl('https://www.tiktok.com/@user.name'));
check('unknown host', !isGenericVideoUrl('https://example.com/76979871'));
check('media file on a pattern host', !isGenericVideoUrl('https://clips.twitch.tv/Clip.mp4'));
check('file extension guard', !isGenericVideoUrl('https://vimeo.com/download/video.mp4'));
check('not a url', !isGenericVideoUrl('vimeo'));
check('data: url rejected', !isGenericVideoUrl('data:text/plain,123'));

console.log('\nregistry routing');
eq('vimeo routes to generic', findResolver('https://vimeo.com/76979871') && findResolver('https://vimeo.com/76979871').name, 'generic');
check('youtube URL is NOT taken by generic', (() => {
  const r = findResolver('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  return r && r.name === 'youtube';
})());
check('tweet URL still routes to twitter', (() => {
  const r = findResolver('https://x.com/user/status/1234567890123456789');
  return r && r.name === 'twitter';
})());
check('plain file URL has no resolver', !hasResolverFor('https://example.com/setup.exe'));
check('cdn media URL is not a page', !hasResolverFor('https://cdn.example.com/video/9384756.mp4'));

console.log(`\ngeneric-resolver: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
