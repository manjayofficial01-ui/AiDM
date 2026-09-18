// Regression harness for Twitter/X resolver robustness.
//
// Covers the 2026 hardening (embed-widget query shape, UA fallback export,
// animated_gif variants, tombstone-shaped payloads):
//   - syndicationUrl carries id + lang + features + token
//   - variantsFromSyndication picks up animated_gif video_info too (X stores
//     GIFs as silent looped MP4s — they must resolve like videos)
//   - HLS-only payloads still surface (engine assembles them)
//   - quoted-tweet media is attributed without crashing
//
// Run: node test/twitter-resolver.js
'use strict';

const tw = require('../src/twitter-resolver');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// ── syndicationUrl ─────────────────────────────────────────────────────────
{
  const id = '2023205364368351634';
  const u = tw.syndicationUrl(id, tw.syndicationToken(id));
  check('embeds cdn host', u.startsWith('https://cdn.syndication.twimg.com/tweet-result?'));
  check('carries id', u.includes('id=' + id));
  check('carries lang=en', /[?&]lang=en(&|$)/.test(u));
  check('carries features', /[?&]features=tfw_timeline_list/.test(u));
  check('carries token', /[?&]token=[A-Za-z0-9]+/.test(u));
}

// ── variantsFromSyndication ────────────────────────────────────────────────
function mediaEntry(type, id, variants) {
  return {
    type,
    media_url_https: 'https://pbs.twimg.com/media/x.jpg',
    video_info: { duration_millis: 3200, variants },
  };
}

{
  const json = {
    user: { screen_name: 'someone' },
    text: 'a gif post',
    mediaDetails: [
      mediaEntry('animated_gif', 1, [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/tweet_video/x/pl/a.m3u8?tag=14' },
        { bitrate: 0, content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/x/vid/320x180/y.mp4?tag=14' },
      ]),
    ],
  };
  const out = tw.variantsFromSyndication(json);
  check('animated_gif mp4 resolves', out.some(v => v.isMp4 && /tweet_video/.test(v.url)));
  check('mp4 sorts before hls', out[0] && out[0].isMp4 === true);
}

{
  const json = {
    mediaDetails: [
      mediaEntry('video', 1, [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/1/pu/pl/z.m3u8?tag=16' },
      ]),
    ],
  };
  const out = tw.variantsFromSyndication(json);
  check('hls-only still surfaces', out.length === 1 && out[0].isMp4 === false);
}

{
  const json = {
    mediaDetails: [],
    quoted_tweet: {
      mediaDetails: [
        mediaEntry('video', 2, [
          { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/2/pu/vid/640x360/q.mp4' },
        ]),
      ],
    },
  };
  const out = tw.variantsFromSyndication(json);
  check('quoted-tweet media included', out.length === 1 && out[0].isMp4 === true);
}

{
  const picker = tw.toPickerVideos([
    { url: 'https://video.twimg.com/x/vid/640x360/a.mp4', filename: 'twitter_u_1_360p.mp4', quality: '360p', width: 640, height: 360, isMp4: true, mediaIndex: 0 },
  ]);
  check('picker shape', picker.length === 1 && picker[0].format === 'mp4' && picker[0].size === null);
}

console.log(`\ntwitter-resolver: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
