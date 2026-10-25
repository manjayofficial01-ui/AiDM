// Tests for src/site-grabber.js — link extraction, robots.txt, and a real
// crawl against a local server. Run: node test/site-grabber.js
const http = require('http');
const {
  grabSite, extractLinks, hasWantedExtension, parseRobots, robotsAllows,
  toExtensionSet, decodeEntities, DEFAULT_EXTENSIONS,
} = require('../src/site-grabber');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra === undefined ? '' : extra); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}

console.log('── extractLinks ──');
{
  const html = `
    <a href="/a.html">a</a>
    <a href='b.html'>b</a>
    <a href=/c.html>c</a>
    <a href="https://other.test/x.zip">ext</a>
    <a href="#top">anchor</a>
    <a href="mailto:x@y.z">mail</a>
    <a href="javascript:void(0)">js</a>
    <a href="data:text/plain,hi">data</a>
    <a href="/d.zip#frag">frag</a>
    <a href="/a.html">dup</a>
    <img src="/img/pic.png">
    <video src="/v/clip.mp4"></video>
    <source src='/v/clip2.webm'>
    <a href="/q?a=1&amp;b=2">entity</a>
  `;
  const links = extractLinks(html, 'https://site.test/dir/page.html');
  const urls = links.map((l) => l.url);
  check('absolute path resolved', urls.includes('https://site.test/a.html'));
  check('relative path resolved against the page dir', urls.includes('https://site.test/dir/b.html'));
  check('unquoted attribute parsed', urls.includes('https://site.test/c.html'));
  check('single-quoted attribute parsed', urls.includes('https://site.test/v/clip2.webm'));
  check('cross-origin link kept as a link', urls.includes('https://other.test/x.zip'));
  check('mailto skipped', !urls.some((u) => u.startsWith('mailto:')));
  check('javascript: skipped', !urls.some((u) => u.startsWith('javascript:')));
  check('data: skipped', !urls.some((u) => u.startsWith('data:')));
  check('fragment-only link skipped', !urls.includes('https://site.test/dir/page.html#top'));
  check('fragment stripped from a file URL', urls.includes('https://site.test/d.zip'));
  check('duplicates removed', urls.filter((u) => u === 'https://site.test/a.html').length === 1);
  check('&amp; decoded in a query string', urls.includes('https://site.test/q?a=1&b=2'));
  check('img src captured as an asset', links.some((l) => l.url.endsWith('pic.png') && l.kind === 'asset'));
  check('video src captured as an asset', links.some((l) => l.url.endsWith('clip.mp4') && l.kind === 'asset'));
  check('anchor href captured as a page', links.some((l) => l.url.endsWith('a.html') && l.kind === 'page'));
}
check('empty html yields nothing', extractLinks('', 'https://x.test/').length === 0);
check('non-string html yields nothing', extractLinks(null, 'https://x.test/').length === 0);
check('bad base url yields nothing', extractLinks('<a href="/a">x</a>', 'not a url').length === 0);
check('decodeEntities handles &amp;', decodeEntities('a&amp;b') === 'a&b');

console.log('\n── hasWantedExtension ──');
const exts = new Set(['zip', 'pdf', 'mp4']);
check('plain match', hasWantedExtension('https://x.test/a.zip', exts) === true);
check('uppercase extension matches', hasWantedExtension('https://x.test/A.ZIP', exts) === true);
check('query string ignored', hasWantedExtension('https://x.test/a.zip?token=1', exts) === true);
check('wrong type', hasWantedExtension('https://x.test/a.txt', exts) === false);
check('no extension', hasWantedExtension('https://x.test/page', exts) === false);
check('directory-like path', hasWantedExtension('https://x.test/a/', exts) === false);
check('dotfile is not an extension', hasWantedExtension('https://x.test/.zip', exts) === false);
check('malformed url', hasWantedExtension('::::', exts) === false);

console.log('\n── robots.txt ──');
{
  const rules = parseRobots(`
    # comment
    User-agent: *
    Disallow: /private
    Allow: /private/public
    Disallow: /*.tmp$
    User-agent: googlebot
    Disallow: /only-google
  `);
  check('disallow prefix blocks', robotsAllows(rules, '/private/secret.html') === false);
  check('longer allow wins', robotsAllows(rules, '/private/public/x.html') === true);
  check('wildcard suffix blocks', robotsAllows(rules, '/a/b.tmp') === false);
  check('unrelated path allowed', robotsAllows(rules, '/files/x.zip') === true);
  check('other-agent group ignored', robotsAllows(rules, '/only-google') === true);
  check('empty rules allow everything', robotsAllows([], '/anything') === true);
  check('empty robots allows everything', parseRobots('').length === 0);
  check('Disallow: with no value is not a block', parseRobots('User-agent: *\nDisallow:').length === 0);
}
{
  const rules = parseRobots('User-agent: aidm\nDisallow: /nope\n');
  check('a group naming our agent applies', robotsAllows(rules, '/nope/x') === false);
}
{
  // Longest match wins even when the longer one is a Disallow.
  const rules = parseRobots('User-agent: *\nAllow: /a\nDisallow: /a/b\n');
  check('longer disallow beats shorter allow', robotsAllows(rules, '/a/b/c') === false);
  check('shorter allow still applies elsewhere', robotsAllows(rules, '/a/x') === true);
}

console.log('\n── toExtensionSet ──');
check('array normalised', toExtensionSet(['.ZIP', 'PDF']).has('zip'));
check('comma string normalised', toExtensionSet('zip, .pdf; mp4').has('pdf'));
check('empty array falls back to defaults', toExtensionSet([]).has('zip'));
check('undefined falls back to defaults', toExtensionSet().has('pdf'));
check('Set input honoured', toExtensionSet(new Set(['7z'])).has('7z'));
check('default list covers archives + media',
  DEFAULT_EXTENSIONS.includes('zip') && DEFAULT_EXTENSIONS.includes('mp4') && DEFAULT_EXTENSIONS.includes('pdf'));

// ── Crawl against a local site ──────────────────────────────────────────────
const PAGES = {
  '/': `<html><body>
      <a href="/a.html">a</a>
      <a href="/sub/b.html">b</a>
      <a href="/files/one.zip">one</a>
      <a href="/files/two.pdf">two</a>
      <a href="/files/skip.txt">skip</a>
      <a href="https://evil.test/remote.zip">remote</a>
      <a href="/private/secret.html">private</a>
    </body></html>`,
  '/a.html': `<a href="/files/three.zip">three</a>`,
  '/sub/b.html': `<a href="/files/one.zip">dupe</a><a href="/sub/c.html">c</a>`,
  '/sub/c.html': `<a href="/files/four.7z">four</a>`,
  '/private/secret.html': `<a href="/files/forbidden.zip">forbidden</a>`,
  '/robots.txt': 'User-agent: *\nDisallow: /private\n',
};

function startSite() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    seen.push(pathname);
    if (pathname === '/direct.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(Buffer.from([1, 2, 3]));
    }
    const body = PAGES[pathname];
    if (body === undefined) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': pathname === '/robots.txt' ? 'text/plain' : 'text/html' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

(async () => {
  const { server, port, seen } = await startSite();
  const base = `http://127.0.0.1:${port}`;
  const fetchImpl = (url, init) => fetch(url, init);

  console.log('\n── grabSite: full crawl ──');
  {
    const r = await grabSite(`${base}/`, { fetchImpl, delayMs: 0 });
    const urls = r.files.map((f) => f.url);
    check('crawl reports ok', r.ok === true, r.reason || '');
    check('found one.zip', urls.some((u) => u.endsWith('/files/one.zip')));
    check('found two.pdf', urls.some((u) => u.endsWith('/files/two.pdf')));
    check('found three.zip (depth 1)', urls.some((u) => u.endsWith('/files/three.zip')));
    check('found four.7z (depth 2)', urls.some((u) => u.endsWith('/files/four.7z')));
    check('unwanted .txt not collected', !urls.some((u) => u.endsWith('skip.txt')));
    // Off-site FILE links are collected (that is how CDNs/mirrors serve
    // downloads) but flagged, and off-site PAGES are never crawled.
    check('cross-origin file collected', urls.some((u) => u.includes('evil.test')));
    check('cross-origin file is flagged', r.files.some((f) => f.crossOrigin === true));
    check('same-origin files are not flagged',
      r.files.filter((f) => f.url.includes('127.0.0.1')).every((f) => f.crossOrigin === false));
    check('cross-origin page never fetched', !seen.some((p) => p.includes('evil.test')));
    check('duplicate file listed once', urls.filter((u) => u.endsWith('/files/one.zip')).length === 1);
    check('robots-disallowed page not fetched', !seen.includes('/private/secret.html'));
    check('robots-disallowed file not collected', !urls.some((u) => u.includes('forbidden')));
    check('robots-disallow recorded as skipped',
      r.skipped.some((s) => s.url.includes('/private/secret.html') && s.reason === 'robots-disallow'));
    check('pages visited include the sub page', r.pages.some((p) => p.endsWith('/sub/b.html')));
    check('origin reported', r.origin === base);
    check('elapsedMs is a number', typeof r.elapsedMs === 'number' && r.elapsedMs >= 0);
    check('not truncated within the caps', r.truncated === false);
  }

  console.log('\n── grabSite: caps and filters ──');
  {
    const r = await grabSite(`${base}/`, { fetchImpl, delayMs: 0, maxDepth: 1 });
    check('maxDepth 1 excludes depth-2 files', !r.files.some((f) => f.url.endsWith('four.7z')));
    check('maxDepth 1 still finds depth-1 files', r.files.some((f) => f.url.endsWith('three.zip')));
  }
  {
    const r = await grabSite(`${base}/`, { fetchImpl, delayMs: 0, maxPages: 1 });
    check('maxPages 1 stops after one page', r.pages.length === 1, `pages=${r.pages.length}`);
    check('maxPages reports truncation', r.truncated === true);
    check('first page still yields its files', r.files.length >= 2);
  }
  {
    const r = await grabSite(`${base}/`, { fetchImpl, delayMs: 0, extensions: ['pdf'] });
    check('extension filter keeps only pdf', r.files.every((f) => f.url.endsWith('.pdf')), JSON.stringify(r.files.map(f => f.url)));
    check('extension filter still finds one pdf', r.files.length === 1);
  }
  {
    const r = await grabSite(`${base}/`, { fetchImpl, delayMs: 0, respectRobots: false });
    check('respectRobots:false follows the private page', r.pages.some((p) => p.includes('/private/secret.html')));
    check('respectRobots:false collects the private file', r.files.some((f) => f.url.includes('forbidden.zip')));
  }
  {
    const r = await grabSite(`${base}/`, { fetchImpl, delayMs: 0, maxFiles: 1 });
    check('maxFiles caps the result', r.files.length === 1, `files=${r.files.length}`);
    check('maxFiles reports truncation', r.truncated === true);
  }
  {
    const r = await grabSite(`${base}/direct.bin`, { fetchImpl, delayMs: 0, extensions: ['bin'] });
    check('a non-html URL with a wanted extension is kept', r.files.some((f) => f.url.endsWith('direct.bin')));
  }
  {
    const progress = [];
    await grabSite(`${base}/`, { fetchImpl, delayMs: 0, onProgress: (p) => progress.push(p) });
    check('onProgress fired per page', progress.length >= 2, `calls=${progress.length}`);
    check('progress carries counts', typeof progress[0].pages === 'number' && typeof progress[0].files === 'number');
  }

  console.log('\n── grabSite: failure modes ──');
  {
    const r = await grabSite('not a url', { fetchImpl });
    check('invalid URL refused', r.ok === false && r.reason === 'invalid-url');
  }
  {
    const r = await grabSite('ftp://x.test/a', { fetchImpl });
    check('non-http scheme refused', r.ok === false && r.reason === 'unsupported-protocol');
  }
  {
    const r = await grabSite(`${base}/nothing-here`, { fetchImpl, delayMs: 0 });
    check('404 page yields no files', r.ok === false);
    check('404 is recorded', r.skipped.some((s) => s.reason === 'http-404'));
    check('reason explains the miss', r.reason === 'no-pages-fetched', r.reason);
  }
  {
    const r = await grabSite(`${base}/`, { fetchImpl, delayMs: 0, extensions: ['nomatch'] });
    check('no matching files reports a reason', r.ok === false && r.reason === 'no-matching-files', r.reason);
  }
  {
    const r = await grabSite(`${base}/`, { fetchImpl, delayMs: 0, timeBudgetMs: 1000, maxPages: 25 });
    check('a tight time budget still returns', typeof r.ok === 'boolean');
  }

  console.log('\n── app wiring (source guards) ──');
  {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
    const mainSrc = read('main.js');
    const preloadSrc = read('preload.js');
    const html = read(path.join('ui', 'index.html'));
    const appJs = read(path.join('ui', 'app.js'));
    const css = read(path.join('ui', 'styles.css'));

    check('main.js registers the grab-site IPC', /ipcMain\.handle\('grab-site'/.test(mainSrc));
    check('main.js loads the grabber', /require\('\.\/src\/site-grabber'\)/.test(mainSrc));
    check('grab-site streams progress to the window', /grab-progress/.test(mainSrc));
    check('preload exposes grabSite', /grabSite:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('grab-site'/.test(preloadSrc));
    check('preload exposes grab progress', /onGrabProgress:/.test(preloadSrc));
    check('toolbar has the grab button', /id="btn-grab-site"/.test(html));
    check('the overlay exists', /id="grab-overlay"/.test(html));
    check('overlay has URL, depth, pages, extensions, robots controls',
      ['grab-url', 'grab-depth', 'grab-pages', 'grab-exts', 'grab-robots'].every((id) => html.includes(`id="${id}"`)));
    check('overlay is in the shared overlay plumbing', /'grab-overlay': hideGrabModal/.test(appJs));
    check('overlay is in the Escape list', /hideSchedulerModal\(\); hideGrabModal\(\)/.test(appJs));
    check('grabbed files queue through batchUrls',
      /window\.aidm\.batchUrls\(urls\)/.test(appJs));
    check('results render without innerHTML', /list\.textContent = ''/.test(appJs));
    check('styles define the result row', /\.grab-row\b/.test(css));
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
