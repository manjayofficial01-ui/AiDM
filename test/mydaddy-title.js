// Regression harness for the "downloading always shows mydaddy.cc [1080p].mp4
// which is not any link" bug.
//
// Root cause chain:
//   1. mydaddy.cc-style players run inside an embed/alt-player iframe whose
//      document has no <title>. The title fallback returned location.hostname,
//      so every download from such a page was named "mydaddy.cc [1080p].mp4".
//   2. The desktop kept ANY explicit name that already had an extension, so the
//      hostname-derived name survived even when Content-Disposition knew better.
//   3. bigcdn.cc anti-hotlink links probed without the page Referer (or with
//      the CDN's own origin as Referer) 403'd, and 401/403 had no fast-fail
//      guard — the row sat at 0% "DOWNLOADING" instead of failing with guidance.
//
// This harness exercises the SHIPPED pure helpers (src/titles.js) plus the
// wiring in the manager and the extension consumers.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const titles = require('../src/titles');
const { isRealTitle, cleanPageTitle, isGenericFilename, specificUrlBasename } = titles;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

function grab(srcFile, name) {
  const src = fs.readFileSync(srcFile, 'utf8');
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name + ' in ' + srcFile);
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
    if (c === '{') d++;
    if (c === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

// ── 1. hostnames are never titles ──────────────────────────────────────────
check('bare hostname is not a title', isRealTitle('mydaddy.cc', 'mydaddy.cc') === false);
check('bare hostname rejected without host arg', isRealTitle('mydaddy.cc') === false);
check('other hostname rejected', isRealTitle('s45.bigcdn.cc') === false);
check('hostname with suffix rejected', isRealTitle('mydaddy.cc - Home', 'mydaddy.cc') === false);
check('generic chrome rejected', isRealTitle('Video') === false && isRealTitle('Watch') === false);
check('real title accepted', isRealTitle('Steamy Backroom Session', 'mydaddy.cc') === true);
check('real title with site suffix accepted',
  isRealTitle('Steamy Backroom Session - MyDaddy', 'mydaddy.cc') === true);

check('cleanPageTitle strips domain suffix',
  cleanPageTitle('Steamy Backroom Session - mydaddy.cc', 'mydaddy.cc') === 'Steamy Backroom Session');
check('cleanPageTitle null for hostname', cleanPageTitle('mydaddy.cc', 'mydaddy.cc') === null);
check('cleanPageTitle null for empty', cleanPageTitle('', 'mydaddy.cc') === null);
check('cleanPageTitle null for untitled iframe', cleanPageTitle(null, 'mydaddy.cc') === null);

// ── 2. generic file names ──────────────────────────────────────────────────
const BIGCDN = 'https://s45.bigcdn.cc/pubs/6aaa296da857b9.75039518/1080.mp4';
check('hostname + quality tag is generic',
  isGenericFilename('mydaddy.cc [1080p].mp4', BIGCDN) === true);
check('bare hostname file is generic',
  isGenericFilename('mydaddy.cc.mp4', 'https://mydaddy.cc/video/abc/') === true);
check('rendition-only basename is generic',
  isGenericFilename('1080.mp4', BIGCDN) === true);
check('CDN hash is generic',
  isGenericFilename('6aaa296da857b9.75039518', BIGCDN) === true);
check('videoplayback is generic',
  isGenericFilename('videoplayback.mp4', 'https://x.com/videoplayback?x=1') === true);
check('real name is kept',
  isGenericFilename('Steamy Backroom Session [1080p].mp4', BIGCDN) === false);
check('specific CDN basename is kept',
  isGenericFilename('my-video.mp4', 'https://cdn.example.com/files/my-video.mp4') === false);
check('specificUrlBasename drops rendition labels',
  specificUrlBasename(BIGCDN) === null);
check('specificUrlBasename keeps real names',
  specificUrlBasename('https://cdn.example.com/files/my-video.mp4') === 'my-video.mp4');

// ── 3. manager: access-denied message + wiring ─────────────────────────────
const MANAGER = path.join(ROOT, 'src', 'download-manager.js');
const accessDeniedMessage = new Function(grab(MANAGER, 'accessDeniedMessage') + '\nreturn accessDeniedMessage;')();
const m403 = accessDeniedMessage(403);
check('403 message says refused + tells the user what to do',
  /refused/i.test(m403) && /403/.test(m403) && /re-?detect|[Ff]resh/.test(m403),
  JSON.stringify(m403.slice(0, 60)) + '…');
check('403 message does not claim expiry',
  !/expired on/i.test(m403));

const mgrSrc = fs.readFileSync(MANAGER, 'utf8');
check('addDownload derives (not blindly trusts) the filename',
  /_deriveFilename\(url, filename, meta, quality\)/.test(mgrSrc));
check('queueDownload derives the filename',
  /_deriveFilename\(opts\.url, opts\.filename, opts\.meta, opts\.quality\)/.test(mgrSrc));
check('probe-time 401/403 fails fast with guidance',
  /meta\.status === 401 \|\| meta\.status === 403/.test(mgrSrc) &&
  /accessDeniedMessage\(meta\.status\)/.test(mgrSrc));
check('page Referer is replayed when the caller gave none',
  /download\.meta && download\.meta\.pageUrl/.test(mgrSrc));
check('generic names yield to Content-Disposition',
  /curGeneric && cdUsable/.test(mgrSrc));
check('probe-issued cookies replayed for the real download',
  /meta\.responseCookies/.test(mgrSrc));

// ── 3b. browser-parity download path ───────────────────────────────────────
const probeSrc = fs.readFileSync(path.join(ROOT, 'src', 'engine', 'probe.js'), 'utf8');
const engSrc = fs.readFileSync(path.join(ROOT, 'src', 'download-engine.js'), 'utf8');
const bgSrcEarly = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
check('probeRemote retries plain GET when Range is refused',
  /rangesBlocked: true/.test(probeSrc) && /_jar: jar/.test(probeSrc));
check('probe-learned cookies persist into segment requests',
  /info\.responseCookies/.test(fs.readFileSync(path.join(ROOT, 'src', 'engine', 'task.js'), 'utf8')));
check('redirect chains replay minted cookies',
  /jarHeader\(jar, headers\)/.test(engSrc) && /jarNote\(jar, res\.headers\)/.test(engSrc));
check('capsule probe retries plain GET on 401/403',
  /delete plainHeaders\.Range/.test(bgSrcEarly));
const bgSrc = bgSrcEarly;

// ── 4. engine: no invented CDN-origin Referer ──────────────────────────────
check('engine does not fake a CDN-origin Referer',
  !/headers\['Referer'\] = u\.origin/.test(engSrc));

// ── 5. extension/UI consumers validate titles ──────────────────────────────
const ctSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'content.js'), 'utf8');
check('content.js title never falls back to hostname',
  !/return location\.hostname/.test(ctSrc));
check('content.js prefers per-video title, rejects placeholders',
  /isGenericName\(nativeName, v\.url\)/.test(ctSrc) && /extractKvsTitle\(\)/.test(ctSrc));
check('content.js ships the real title to the desktop',
  /title: realTitle \|\| undefined/.test(ctSrc));
check('background.js validates pageTitle before inventing a filename',
  /cleanTitle\(payload\.pageTitle\)/.test(bgSrc));
const popSrc = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
check('popup.js rejects generic display names',
  /isGenericNameInline\(item\.filename, item\.url\)/.test(popSrc));
const appSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
check('quality picker rejects generic filenames',
  /_isGeneric\(video\.filename, video\.url\)/.test(appSrc));

console.log('\nmydaddy-title: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
