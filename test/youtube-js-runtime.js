// Regression: yt-dlp must be given a JavaScript runtime, and the YouTube
// extractor's own knobs must be reachable — plus the network-level blocks must
// be reported for what they are.
//
// THREE separate defects this locks down, all found by running the SHIPPED
// yt-dlp against the live site:
//
//   1. NO JS RUNTIME. Current yt-dlp builds carry no built-in JS interpreter;
//      they delegate YouTube's stream-signature challenge (nsig/sig) and
//      PO-token generation to an external runtime. AiDM passed none, so every
//      job ran in the mode yt-dlp itself warns about:
//        WARNING: [youtube] No supported JavaScript runtime could be found …
//        YouTube extraction without a JS runtime has been deprecated, and some
//        formats may be missing.
//      With `--js-runtimes node:<path>` the same binary reports
//        [youtube] [jsc:node] Solving JS challenges using node
//      so the challenge is actually solved instead of skipped.
//
//   2. NO EXTRACTOR ARGS. YouTube answers the default clients with SABR-only
//      (URL-less) formats and refuses a GVS PO token without visitor data
//      ("Missing required Visitor Data"), so `--extractor-args` has to be
//      reachable — safely, without becoming an argv-injection hole.
//
//   3. WRONG ERROR FOR A RATE LIMIT. An over-used IP is answered with a
//      redirect to google.com/sorry ("unusual traffic") and HTTP 429. That was
//      reported as a per-video bot check, sending the user off to "pick another
//      quality" for a problem that affects every video on the network.
//
// Pure helpers are tested directly; no yt-dlp binary is spawned.
// Run: node test/youtube-js-runtime.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const ROOT = path.join(__dirname, '..');
const jr = require(path.join(ROOT, 'src', 'js-runtime.js'));
const ytdlp = require(path.join(ROOT, 'src', 'yt-dlp.js'));
const yt = require(path.join(ROOT, 'src', 'youtube-resolver.js'));

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ytdlpSrc = read('src/yt-dlp.js');
const dmSrc = read('src/download-manager.js');
const serverSrc = read('src/server.js');
const appSrc = read('ui/app.js');
const htmlSrc = read('ui/index.html');
const mainSrc = read('main.js');

// ── inferRuntime ────────────────────────────────────────────────────────────
console.log('── inferRuntime ──');
check('deno.exe → deno', jr.inferRuntime('C:\\tools\\deno.exe') === 'deno');
check('bun.exe → bun', jr.inferRuntime('/usr/local/bin/bun') === 'bun');
check('qjs.exe → quickjs', jr.inferRuntime('C:\\qjs\\qjs.exe') === 'quickjs');
check('quickjs in the name → quickjs', jr.inferRuntime('/opt/quickjs-bin') === 'quickjs');
check('anything else → node (the safe default)', jr.inferRuntime('C:\\x\\mystery.exe') === 'node');
check('empty → node, never throws', jr.inferRuntime('') === 'node');

// ── candidates ──────────────────────────────────────────────────────────────
console.log('── candidates ──');
{
  const c = jr.candidates({ explicit: 'deno' });
  check('a bare runtime name is tried first', c[0].runtime === 'deno', JSON.stringify(c[0]));
  check('AiDM\'s own bin dir is searched', c.some(x => /AiDM[\\/]bin/i.test(x.path)));
  const c2 = jr.candidates({ explicit: 'deno:C:\\tools\\deno.exe' });
  check('name:path form is honoured verbatim', c2[0].runtime === 'deno' && c2[0].path === 'C:\\tools\\deno.exe',
    JSON.stringify(c2[0]));
  const c3 = jr.candidates({ explicit: 'C:\\Program Files\\nodejs\\node.exe' });
  check('a bare absolute path is not split on its drive colon',
    c3[0].runtime === 'node' && c3[0].path === 'C:\\Program Files\\nodejs\\node.exe', JSON.stringify(c3[0]));
  const c4 = jr.candidates({});
  check('all four supported runtimes are searched when unconfigured',
    ['deno', 'bun', 'node', 'quickjs'].every(r => c4.some(x => x.runtime === r)));
  check('no duplicate (runtime, path) pairs', new Set(c4.map(x => x.runtime + '|' + x.path.toLowerCase())).size === c4.length);
}

// ── jsRuntimeArgs ───────────────────────────────────────────────────────────
console.log('── jsRuntimeArgs ──');
check('no runtime → no argument (old behaviour preserved)', jr.jsRuntimeArgs(null).length === 0);
check('undefined → no argument', jr.jsRuntimeArgs(undefined).length === 0);
check('incomplete record → no argument', jr.jsRuntimeArgs({ runtime: 'node' }).length === 0);
{
  const a = jr.jsRuntimeArgs({ runtime: 'node', path: 'node.exe' });
  check('emits --js-runtimes with name:path', a.length === 2 && a[0] === '--js-runtimes' && a[1] === 'node:node.exe',
    JSON.stringify(a));
  const b = jr.jsRuntimeArgs({ runtime: 'deno', path: 'C:\\tools\\deno.exe' });
  check('Windows path keeps its colon after the runtime name', b[1] === 'deno:C:\\tools\\deno.exe', b[1]);
  check('an unsupported runtime name is refused (never reaches argv)',
    jr.jsRuntimeArgs({ runtime: 'evil', path: 'x' }).length === 0);
}
check('describe() names the runtime, version and path',
  /node 1\.2\.3 \(.*node\.exe\)/.test(jr.describeJsRuntime({ runtime: 'node', version: '1.2.3', path: 'C:\\n\\node.exe' })));
check('describe() is honest when nothing was found', /not found/i.test(jr.describeJsRuntime(null)));
check('the install dir is inside AiDM\'s per-user folder', /AiDM[\\/]bin$/i.test(jr.installDir() || ''));

// ── extractorArgs ───────────────────────────────────────────────────────────
console.log('── extractorArgs ──');
check('empty → no argument', ytdlp.extractorArgs('').length === 0);
check('whitespace → no argument', ytdlp.extractorArgs('   ').length === 0);
check('null → no argument', ytdlp.extractorArgs(null).length === 0);
check('a value with no "=" is refused (not a real arg)', ytdlp.extractorArgs('justaword').length === 0);
{
  const a = ytdlp.extractorArgs('player_client=web_safari');
  check('emits --extractor-args youtube:<body>',
    a.length === 2 && a[0] === '--extractor-args' && a[1] === 'youtube:player_client=web_safari', JSON.stringify(a));
  const b = ytdlp.extractorArgs('youtube:player_client=web_safari');
  check('a pasted "youtube:" prefix is not doubled', b[1] === 'youtube:player_client=web_safari', b[1]);
  const c = ytdlp.extractorArgs('visitor_data=CgABC-1_2.3&player_client=web');
  check('an &-joined pair list survives', c[1] === 'youtube:visitor_data=CgABC-1_2.3&player_client=web', c[1]);
}
{
  // Injection guard: a crafted value must never become a SECOND argv entry.
  // The rule is REFUSE-don't-mangle: anything that is not a plain pair list
  // yields no argument at all, so what AiDM emits is always exactly one entry.
  const a = ytdlp.extractorArgs('player_client=web --proxy http://evil');
  check('a space refuses the value entirely (no mangling)', a.length === 0, JSON.stringify(a));
  const b = ytdlp.extractorArgs('x=1"&&"y=2');
  check('quotes refuse the value entirely', b.length === 0, JSON.stringify(b));
  const c = ytdlp.extractorArgs('x=1\n--exec=calc');
  check('a newline refuses the value entirely', c.length === 0, JSON.stringify(c));
  const d = ytdlp.extractorArgs('x=1;rm -rf /');
  check('a shell metacharacter refuses the value entirely', d.length === 0, JSON.stringify(d));
  // And the positive case still emits exactly ONE --extractor-args entry.
  const ok = ytdlp.extractorArgs('player_client=web_safari');
  check('a clean value yields exactly one flag + one value',
    ok.length === 2 && ok.filter(v => /^--/.test(v)).length === 1 && ok[0] === '--extractor-args');
}

// ── classifyError: rate limit is NOT a bot check ────────────────────────────
console.log('── classifyError ──');
check('google.com/sorry is a rate limit, not a bot check',
  ytdlp.classifyError('ERROR: Unable to download webpage: HTTP Error 429 (redirect to https://www.google.com/sorry/index)').code === 'rate-limited');
check('a bare HTTP 429 is a rate limit',
  ytdlp.classifyError('ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests').code === 'rate-limited');
check('"unusual traffic" is a rate limit',
  ytdlp.classifyError('Our systems have detected unusual traffic from your computer network').code === 'rate-limited');
check('the rate-limit message says it is temporary and affects every video',
  /temporary/i.test(ytdlp.classifyError('HTTP Error 429').message) &&
  /every video/i.test(ytdlp.classifyError('HTTP Error 429').message));
check('a genuine bot check is still a bot check',
  ytdlp.classifyError('ERROR: [youtube] X: Sign in to confirm you\u2019re not a bot.').code === 'bot-check');
check('the bot-check message no longer claims AiDM "does not bypass" it',
  !/does not bypass/i.test(ytdlp.classifyError('Sign in to confirm you\u2019re not a bot').message));
check('the bot-check message points at the extension / cookies.txt',
  /extension/i.test(ytdlp.classifyError('Sign in to confirm you\u2019re not a bot').message));
check('private stays private', ytdlp.classifyError('This video is private').code === 'private');
check('unknown output still degrades to extract', ytdlp.classifyError('something odd').code === 'extract');

// ── resolver: rate-limited probes still yield a retryable row ───────────────
console.log('── resolver ──');
check('rate-limited is a retryable probe code', yt.RETRYABLE_PROBE_CODES.has('rate-limited'));
check('bot-check is still retryable', yt.RETRYABLE_PROBE_CODES.has('bot-check'));
check('private is NOT retryable', !yt.RETRYABLE_PROBE_CODES.has('private'));
{
  const fb = yt.fallbackPayload('https://www.youtube.com/watch?v=abc', 'abc', 'rate limited');
  check('the fallback row carries the reason', fb.probeError === 'rate limited');
  check('the fallback row is still downloadable', fb.pickerVideos.length === 1);
}

// ── wiring: probe / download / manager / server / UI ────────────────────────
console.log('── wiring ──');
check('yt-dlp.js requires the js-runtime module', /require\(['"]\.\/js-runtime['"]\)/.test(ytdlpSrc));
check('probe() detects a runtime', /jsRuntime\.detectJsRuntime\(/.test(ytdlpSrc));
check('probe() forwards the runtime into argv', /jsRuntime\.jsRuntimeArgs\(jsrt\)/.test(ytdlpSrc));
check('download() resolves the runtime alongside yt-dlp', /jsRuntime\.detectJsRuntime\(false, \{ explicit: o && o\.jsRuntimePath \}\)/.test(ytdlpSrc));
check('download() forwards the runtime into argv', /jsRuntime\.jsRuntimeArgs\(o\._jsRuntime\)/.test(ytdlpSrc));
check('download() forwards extractor args', /args\.push\(\.\.\.extractorArgs\(o\.extractorArgs\)\)/.test(ytdlpSrc));
check('probe() accepts extractor args', /extractorArgsRaw/.test(ytdlpSrc));
check('the js runtime is NOT passed via a shell', !/shell:\s*true/.test(ytdlpSrc));

check('the resolver forwards jsRuntimePath to the probe', /jsRuntimePath: opts\.jsRuntimePath/.test(read('src/youtube-resolver.js')));
check('the resolver forwards extractorArgsRaw to the probe', /extractorArgsRaw: opts\.extractorArgsRaw/.test(read('src/youtube-resolver.js')));

check('the manager reads a youtubeJsRuntime setting', /jsRuntimePath: String\(this\.settings\.youtubeJsRuntime/.test(dmSrc));
check('the manager reads a youtubeExtractorArgs setting', /extractorArgs: String\(this\.settings\.youtubeExtractorArgs/.test(dmSrc));
check('both settings default to empty (= auto / none)',
  /youtubeJsRuntime: ''/.test(dmSrc) && /youtubeExtractorArgs: ''/.test(dmSrc));

check('the server exposes the js-runtime override', /_youtubeJsRuntime\(\)/.test(serverSrc));
check('the server exposes the extractor-args override', /_youtubeExtractorArgs\(\)/.test(serverSrc));
check('every resolve call site forwards the runtime',
  (serverSrc.match(/jsRuntimePath: this\._youtubeJsRuntime\(\)/g) || []).length === 4,
  String((serverSrc.match(/jsRuntimePath: this\._youtubeJsRuntime\(\)/g) || []).length));
check('the picker payload carries the blocked-probe reason',
  (serverSrc.match(/probeError: r\.probeError/g) || []).length === 2);
check('the resolve HTTP response never echoes probeError to the extension',
  !/success: true, provider: 'youtube'[\s\S]{0,200}probeError/.test(serverSrc));

check('the status IPC reports the js runtime', /jsRuntime: jsStatus/.test(mainSrc));
check('Settings shows a JS runtime row', /id="yt-js-runtime"/.test(htmlSrc));
check('Settings shows a Re-detect button', /id="btn-yt-js-rescan"/.test(htmlSrc));
check('Settings shows an extractor-args field', /id="setting-yt-extractor-args"/.test(htmlSrc));
check('the renderer loads the extractor-args setting', /setting-yt-extractor-args'\)\?\.value/.test(appSrc));
check('the renderer saves the extractor-args setting', /youtubeExtractorArgs: \(document\.getElementById\('setting-yt-extractor-args'\)/.test(appSrc));
check('the renderer renders the JS runtime status', /jsInput\.value = js && js\.found/.test(appSrc));
check('the renderer warns when no runtime was found', /No JavaScript runtime found/.test(appSrc));
check('the picker shows the blocked-probe note', /quality-page-note/.test(appSrc) && /id="quality-page-note"/.test(htmlSrc));

console.log(`\nyoutube-js-runtime: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
