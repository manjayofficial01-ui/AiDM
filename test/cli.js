// Tests for src/cli.js (argv intake) + the IPCServer.addUrl delegation contract.
// Run: node test/cli.js
const fs = require('fs');
const path = require('path');
const cli = require('../src/cli');
const { IPCServer } = require('../src/server');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra === undefined ? '' : extra); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}

// Injected IO keeps the parser pure — no real filesystem touched.
function io(files = {}) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT');
      return files[p];
    },
  };
}

console.log('── isAllowedUrl (scheme allowlist) ──');
check('https accepted', cli.isAllowedUrl('https://example.com/a.zip'));
check('http accepted', cli.isAllowedUrl('http://example.com/a.zip'));
check('ftp accepted', cli.isAllowedUrl('ftp://example.com/a.iso'));
check('magnet accepted', cli.isAllowedUrl('magnet:?xt=urn:btih:abc'));
check('quoted URL accepted', cli.isAllowedUrl('"https://example.com/a.zip"'));
check('Windows path is NOT a url', cli.isAllowedUrl('C:\\Users\\x\\a.zip') === false);
check('bare filename is NOT a url', cli.isAllowedUrl('movie.mp4') === false);
check('file:// is refused', cli.isAllowedUrl('file:///C:/x/a.zip') === false);
check('javascript: is refused', cli.isAllowedUrl('javascript:alert(1)') === false);
check('empty refused', cli.isAllowedUrl('') === false);
check('URL with a space refused', cli.isAllowedUrl('https://example.com/a b.zip') === false);

console.log('\n── parseArgs: URLs ──');
{
  const r = cli.parseArgs(['https://a.test/1.zip', 'https://a.test/2.zip'], io());
  check('two URLs queued', r.urls.length === 2, r.urls.join(' '));
  check('no flags set', !r.hidden && !r.minimized && !r.version && !r.help);
  check('nothing unknown', r.unknown.length === 0, JSON.stringify(r.unknown));
}
{
  const r = cli.parseArgs(['https://a.test/x.zip', 'https://a.test/x.zip'], io());
  check('duplicates collapse', r.urls.length === 1);
}
{
  const r = cli.parseArgs(['"https://a.test/quoted.zip"'], io());
  check('surrounding quotes stripped', r.urls[0] === 'https://a.test/quoted.zip', r.urls[0]);
}
{
  const r = cli.parseArgs(['C:\\Users\\me\\file.zip', 'not-a-url'], io());
  check('a bare path is never queued', r.urls.length === 0);
  check('bare paths are reported as unknown', r.unknown.length === 2, JSON.stringify(r.unknown));
}

console.log('\n── parseArgs: flags ──');
check('--hidden', cli.parseArgs(['--hidden'], io()).hidden === true);
check('-hidden (single dash)', cli.parseArgs(['-hidden'], io()).hidden === true);
check('--minimized', cli.parseArgs(['--minimized'], io()).minimized === true);
check('-m alias', cli.parseArgs(['-m'], io()).minimized === true);
check('--version', cli.parseArgs(['--version'], io()).version === true);
check('-v alias', cli.parseArgs(['-v'], io()).version === true);
check('--help', cli.parseArgs(['--help'], io()).help === true);
check('-h alias', cli.parseArgs(['-h'], io()).help === true);
check('unknown flag is reported', cli.parseArgs(['--nope'], io()).unknown.includes('--nope'));
check('flags and URLs combine', (() => {
  const r = cli.parseArgs(['--hidden', 'https://a.test/x.zip'], io());
  return r.hidden === true && r.urls.length === 1;
})());

console.log('\n── parseArgs: --add-file ──');
{
  const r = cli.parseArgs(['--add-file', 'links.txt'], io({
    'links.txt': '# my links\nhttps://a.test/1.zip\n\nhttps://a.test/2.zip\n',
  }));
  check('list file read', r.files.length === 1 && r.files[0] === 'links.txt');
  check('two URLs from the list', r.urls.length === 2, r.urls.join(' '));
  check('comments and blanks skipped', !r.urls.some((u) => u.includes('#')));
}
{
  const r = cli.parseArgs(['--add-file=links.txt'], io({
    'links.txt': 'https://a.test/eq.zip',
  }));
  check('--flag=value form works', r.urls[0] === 'https://a.test/eq.zip', r.urls.join(' '));
}
{
  const r = cli.parseArgs(['--add-file', 'missing.txt'], io({}));
  check('missing list file is an error, not a crash', r.errors.length === 1 && r.errors[0].error === 'not found');
  check('missing list file queues nothing', r.urls.length === 0);
}
{
  const r = cli.parseArgs(['--add-file'], io({}));
  check('--add-file with no value is unknown', r.unknown.includes('--add-file'));
}
{
  const r = cli.parseArgs(['list.txt'], io({ 'list.txt': 'https://a.test/pos.zip' }));
  check('positional list file is parsed', r.urls.length === 1 && r.files.length === 1);
}
{
  const r = cli.parseArgs(['--add-file', 'many.json'], io({
    'many.json': JSON.stringify([{ url: 'https://a.test/j1.zip' }, 'https://a.test/j2.zip']),
  }));
  check('JSON array of objects/strings', r.urls.length === 2, r.urls.join(' '));
}
{
  const r = cli.parseArgs(['--add-file', 'dl.json'], io({
    'dl.json': JSON.stringify({ downloads: [{ url: 'https://a.test/d1.zip' }] }),
  }));
  check('{downloads:[{url}]} shape', r.urls[0] === 'https://a.test/d1.zip', r.urls.join(' '));
}
{
  const r = cli.parseArgs(['--add-file', 'bad.json'], io({ 'bad.json': '{not json' }));
  check('malformed JSON falls back to line parsing', r.urls.length === 0 && r.errors.length === 0);
}

console.log('\n── parseUrlList ──');
check('tab-separated export keeps the URL only',
  cli.parseUrlList('https://a.test/x.zip\tfile.zip')[0] === 'https://a.test/x.zip');
check('semicolon comments skipped', cli.parseUrlList('; comment\nhttps://a.test/y.zip').length === 1);
check('slash comments skipped', cli.parseUrlList('// comment\nhttps://a.test/z.zip').length === 1);
check('invalid lines dropped', cli.parseUrlList('hello\nworld').length === 0);
check('order preserved', cli.parseUrlList('https://a.test/1.zip\nhttps://a.test/2.zip')
  .join(',') === 'https://a.test/1.zip,https://a.test/2.zip');
check('empty input is empty', cli.parseUrlList('').length === 0);
check('undefined input is empty', cli.parseUrlList(undefined).length === 0);

console.log('\n── usage text ──');
check('USAGE documents --add-file', /--add-file/.test(cli.USAGE));
check('USAGE documents --hidden', /--hidden/.test(cli.USAGE));
check('USAGE documents --version', /--version/.test(cli.USAGE));
check('USAGE shows an example', /AiDM\.exe https:\/\//.test(cli.USAGE));

(async () => {
  console.log('\n── IPCServer.addUrl delegation ──');
  check('addUrl exists', typeof IPCServer.prototype.addUrl === 'function');
  {
    // Delegation contract: addUrl must hand the URL to _routeDownload, which is
    // the same path POST /api/download uses (resolvers + the addDownload door).
    let seen = null;
    const stub = { _routeDownload: (data) => { seen = data; return Promise.resolve({ statusCode: 200, body: { success: true } }); } };
    const out = await IPCServer.prototype.addUrl.call(stub, 'https://a.test/x.zip', { cookies: 'a=1' });
    check('delegates to _routeDownload', seen && seen.url === 'https://a.test/x.zip');
    check('passes options through', seen && seen.cookies === 'a=1');
    check('returns the routed result', out.statusCode === 200 && out.body.success === true);
  }
  {
    const stub = { _routeDownload: () => { throw new Error('should not route an empty url'); } };
    const out = await IPCServer.prototype.addUrl.call(stub, '');
    check('empty URL is refused before routing', out.statusCode === 400);
  }

  console.log('\n── main.js wiring (source guard) ──');
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check('main.js requires src/cli', /require\('\.\/src\/cli'\)/.test(mainSrc));
    check('main.js dispatches through ipcServer.addUrl', /ipcServer\.addUrl\(/.test(mainSrc));
    check('second-instance parses its own argv', /second-instance[\s\S]{0,400}cli\.parseArgs/.test(mainSrc));
    check('cold start queues LAUNCH_INTAKE urls', /LAUNCH_INTAKE\.urls\.length[\s\S]{0,200}queueLaunchUrls/.test(mainSrc));
    check('--version exits before the instance lock', /LAUNCH_INTAKE\.version[\s\S]{0,300}process\.exit\(0\)/.test(mainSrc));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
