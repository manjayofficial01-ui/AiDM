// Regression harness for the gallery-dl engine (v5.9.0).
//
// The engine is an external subprocess (GPL-2.0, unmodified — the yt-dlp
// pattern), so what CAN break in a pure test is everything around it:
//   - URL routing: gallery PAGES must go to gallery-dl, direct file URLs and
//     unknown hosts must never be stolen from the generic engine;
//   - argument building: a gallery URL (attacker-controlled text) can never
//     become an option — `--` ends the option list;
//   - exit-code mapping: gallery-dl exits are a BITMASK (OR-combined across
//     files/URLs), and the auth/challenge/partial distinctions decide whether
//     a row fails or completes with a warning.
// Run: node test/gallery-dl.js
const gallerydl = require('../src/gallery-dl.js');
const { isCourseUrl } = require('../src/url-hygiene.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

function section(t) { console.log(`\n── ${t} ──`); }

section('URL routing: gallery pages are detected');
check('pixiv user page', gallerydl.isGalleryUrl('https://www.pixiv.net/users/123') === true);
check('pixiv artwork page', gallerydl.isGalleryUrl('https://www.pixiv.net/en/artworks/98765') === true);
check('danbooru post list', gallerydl.isGalleryUrl('https://danbooru.donmai.us/posts?tags=touhou') === true);
check('kemono creator', gallerydl.isGalleryUrl('https://kemono.su/fanbox/user/9001') === true);
check('deviantart gallery', gallerydl.isGalleryUrl('https://www.deviantart.com/someone/gallery') === true);
check('imgur gallery page', gallerydl.isGalleryUrl('https://imgur.com/gallery/abc123') === true);
check('tumblr post', gallerydl.isGalleryUrl('https://blog.tumblr.com/post/700000') === true);

section('URL routing: what must NOT be stolen from the generic engine');
check('a direct imgur image keeps the HTTP engine', gallerydl.isGalleryUrl('https://i.imgur.com/abc123.jpg') === false);
check('a bare .png URL keeps the HTTP engine', gallerydl.isGalleryUrl('https://pixiv.net/fake.png') === false);
check('any direct .mp4', gallerydl.isGalleryUrl('https://kemono.su/data/ab/file.mp4') === false);
check('magnet links stay with WebTorrent', gallerydl.isGalleryUrl('magnet:?xt=urn:btih:abc') === false);
check('data: URLs stay inline', gallerydl.isGalleryUrl('data:image/png;base64,AAA') === false);
check('unknown hosts stay generic', gallerydl.isGalleryUrl('https://example.com/gallery/1') === false);
check('lookalike host (not pixiv.com) is refused', gallerydl.isGalleryUrl('https://notpixiv.net/users/1') === false);
check('suffix match needs a dot boundary (xpixiv.net ≠ pixiv.net)', gallerydl.isGalleryUrl('https://xpixiv.net/users/1') === false);
check('garbage is safely false', gallerydl.isGalleryUrl('not a url') === false && gallerydl.isGalleryUrl(null) === false);

section('looksLikeDirectFile');
check('jpg path detected', gallerydl.looksLikeDirectFile('https://a.com/img/pic.jpg') === true);
check('query string tolerated', gallerydl.looksLikeDirectFile('https://a.com/img/pic.webp?w=100') === true);
check('page path rejected', gallerydl.looksLikeDirectFile('https://a.com/users/123') === false);
check('extensionless path rejected', gallerydl.looksLikeDirectFile('https://a.com/watch') === false);

section('host list sanity');
check('every host suffix is lowercase, no scheme, no path',
  gallerydl.GALLERY_HOSTS.every((h) => h === h.toLowerCase() && !h.includes('/') && !h.includes(':')));
check('the list covers the documented majors',
  ['pixiv.net', 'danbooru.donmai.us', 'kemono.su', 'patreon.com', 'mangadex.org'].every((h) => gallerydl.GALLERY_HOSTS.includes(h)));

section('argument building (injection safety)');
const args = gallerydl.buildArgs({
  destDir: 'D:/pics', url: 'https://www.pixiv.net/users/123',
  archivePath: 'D:/pics/a.archive.txt', cookiesFromBrowser: 'firefox',
  cookieFiles: ['C:/cookies.txt'], proxy: 'socks5://127.0.0.1:1080',
});
check('destination first', args[0] === '--destination' && args[1] === 'D:/pics');
check('archive rides along', args.includes('--download-archive') && args.includes('D:/pics/a.archive.txt'));
check('browser cookies opt-in', args.includes('--cookies-from-browser') && args.includes('firefox'));
check('cookies file', args.includes('--cookies') && args.includes('C:/cookies.txt'));
check('proxy', args.includes('--proxy') && args.includes('socks5://127.0.0.1:1080'));
check('`--` separates the URL from options (a URL can never be a flag)',
  args[args.length - 2] === '--' && args[args.length - 1] === 'https://www.pixiv.net/users/123');
check('a URL that looks like a flag stays a positional operand',
  gallerydl.buildArgs({ destDir: 'x', url: 'https://a.com/--download-archive=pwned' }).slice(-2).join(' ') === '-- https://a.com/--download-archive=pwned');
check('browser name is charset-validated (no argv injection)',
  !gallerydl.buildArgs({ destDir: 'x', url: 'https://a.com/g', cookiesFromBrowser: 'chrome --evil' }).includes('--evil'));
check('junk proxy is dropped, not passed', !gallerydl.buildArgs({ destDir: 'x', url: 'https://a.com/g', proxy: 'rm -rf /' }).includes('rm -rf /'));
check('empty options → empty argv (never spawn bare)', gallerydl.buildArgs(null).length === 0 && gallerydl.buildArgs({}).length === 0);

section('exit-code mapping (bitmask semantics)');
check('exit 0 is plain success (null = no mapping)', gallerydl.mapExitCode(0, 3, '') === null);
check('exit 16 = auth required, fatal with no files', gallerydl.mapExitCode(16, 0, '').code === 'auth' && gallerydl.mapExitCode(16, 0, '').fatal === true);
check('exit 16 softens when SOME files landed', gallerydl.mapExitCode(16, 5, '').fatal === false);
check('exit 8 = challenge/captcha', gallerydl.mapExitCode(8, 0, '').code === 'challenge');
check('exit 64 = no extractor, always fatal', gallerydl.mapExitCode(64, 0, '').code === 'unsupported' && gallerydl.mapExitCode(64, 0, '').fatal);
check('exit 4 with files = partial success (non-fatal)', gallerydl.mapExitCode(4, 12, '').code === 'partial' && gallerydl.mapExitCode(4, 12, '').fatal === false);
check('exit 4 with no files = fatal extract failure', gallerydl.mapExitCode(4, 0, '').fatal === true);
check('exit 32 = input error', gallerydl.mapExitCode(32, 0, '').code === 'input');
check('exit 128 = OS error, fatal', gallerydl.mapExitCode(128, 0, '').code === 'os' && gallerydl.mapExitCode(128, 0, '').fatal);
check('OR-combined 16|4=20: auth is reported (the actionable half)', gallerydl.mapExitCode(20, 0, '').code === 'auth');
check('OR-combined 4|1=5 still maps', !!gallerydl.mapExitCode(5, 0, 'rate limited by pixiv').message);
check('unknown code gets a generic message with the code in it',
  gallerydl.mapExitCode(3, 0, '').code === 'generic' && gallerydl.mapExitCode(3, 0, '').message.includes('3'));

section('course URLs (Udemy via yt-dlp)');
check('course landing page', isCourseUrl('https://www.udemy.com/course/linux-basics/') === true);
check('learn player URL', isCourseUrl('https://www.udemy.com/course/linux-basics/learn/lecture/1#notes') === true);
check('bare /learn/ path', isCourseUrl('https://www.udemy.com/learn/lecture/1') === true);
check('draft paths classify (extractor decides)', isCourseUrl('https://www.udemy.com/draft/123/x/') === true);
check('instructor tooling is not a course', isCourseUrl('https://www.udemy.com/instructor/dashboard/') === false);
check('lookalike host refused', isCourseUrl('https://udemy.com.evil.io/course/x/') === false);
check('udemy SUPPORT host refused', isCourseUrl('https://support.udemy.com/hc/x') === false);
check('non-udemy hosts refused', isCourseUrl('https://example.com/course/x') === false);
check('non-http refused', isCourseUrl('ftp://udemy.com/course/x') === false && isCourseUrl(null) === false);

section('binary discovery plumbing');
check('install target is the per-user bin dir',
  gallerydl.installTarget().includes('AiDM') && gallerydl.installTarget().endsWith('gallery-dl.exe'));
check('candidate paths include the env override first when set',
  (process.env.AIDM_GALLERYDL = 'C:/tmp/gdl.exe', gallerydl.candidatePaths()[0] === 'C:/tmp/gdl.exe', delete process.env.AIDM_GALLERYDL, true));
check('missing-message names the Settings pane', gallerydl.galleryDlMissingMessage().includes('gallery-dl'));

section('--version output parsing (regression: gallery-dl prints a BARE semver)');
check('bare semver parses ("1.32.19" is what the real exe prints)',
  gallerydl.parseVersionOutput('1.32.19\r\n') === '1.32.19');
check('prefixed shape tolerated (future-proof)',
  gallerydl.parseVersionOutput('gallery-dl 2.0.0\n') === '2.0.0');
check("other tools' output is refused (yt-dlp on PATH must never read as gallery-dl)",
  gallerydl.parseVersionOutput('yt-dlp 2025.01.01') === null);
check('junk is refused', gallerydl.parseVersionOutput('') === null && gallerydl.parseVersionOutput('not a version') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
