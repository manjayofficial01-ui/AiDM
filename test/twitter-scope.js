// Harness: exercises the SHIPPED interceptor attribution code (extracted from
// source, not copied) against synthetic multi-tweet GraphQL JSON.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'interceptor.js'), 'utf8');

function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
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
      else if (c === '[') { /* char class: skip to ] */ const e = src.indexOf(']', k); if (e > 0) k = e; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    // crude regex start heuristic: / preceded by ( , = : [ ! & | ? { } ; or start
    if (c === '/' && /[(,=:?!&|{;\[]/.test(src[k - 1] || '(')) {
      // avoid // comments and /* comments */
      if (src[k + 1] === '/' || src[k + 1] === '*') continue;
      inRe = true; continue;
    }
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const names = ['maybeTwitterVideoJson', 'decodeJsonUrl', 'isSegmentUrl', 'extractTwitterVariantsByTweet'];
const defs = names.map(grab).join('\n');
// The shipped isSegmentUrl closes over the IIFE-scope SEGMENT_RE const —
 // provide the identical definition so the eval'd copy behaves the same.
const SEGMENT_RE = /\.m4s($|\?|#|;)|init\.mp4($|\?|#)|seg-?\d+|chunklist|fragment|frag-?\d+|\/range\//i;
eval(defs);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const body = JSON.stringify({ data: {
  t1: { result: { rest_id: '1111111111111111111',
    legacy: { id_str: '1111111111111111111', full_text: 'owl video',
      extended_entities: { media: [{ video_info: { duration_millis: 9000, variants: [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/111/pu/pl/PlA.m3u8?tag=14' },
        { bitrate: 632000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/111/pu/vid/480x360/VaA.mp4?tag=14' },
        { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/111/pu/vid/1280x720/VbB.mp4?tag=14' },
        { bitrate: 3000000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/111/pu/vid/1920x1080/VcC.mp4?tag=14' } ] } } ] } } } },
  t2: { result: { rest_id: '2222222222222222222',
    legacy: { id_str: '2222222222222222222', full_text: 'cat video',
      extended_entities: { media: [{ video_info: { variants: [
        { bitrate: 800000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/222/pu/vid/640x360/VdD.mp4?tag=12' } ] } } ] } } } },
} });

const groups = extractTwitterVariantsByTweet(body);
check('two tweet groups', groups.length === 2, 'got ' + groups.length);
const g1 = groups.find((g) => g.tweetId === '1111111111111111111');
const g2 = groups.find((g) => g.tweetId === '2222222222222222222');
check('tweet1 has 3 mp4s', g1 && g1.urls.length === 3, g1 && g1.urls.length);
check('tweet2 has 1 mp4', g2 && g2.urls.length === 1, g2 && g2.urls.length);
check('queries stripped, no m3u8', groups.every((g) => g.urls.every((u) => u.indexOf('?') < 0 && u.indexOf('m3u8') < 0)));
check('non-json returns []', extractTwitterVariantsByTweet('<html>nope</html>').length === 0);
check('media id must not become a group', !groups.some((g) => g.tweetId === '111'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
