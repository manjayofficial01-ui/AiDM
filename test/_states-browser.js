// Real-Chromium fixture for APP-012 (semantic state tokens + honest states).
//
// Run through the Playwright MCP `browser_run_code_unsafe` { code } argument
// while test/_settings-server.js serves the real renderer on
// http://127.0.0.1:18923/. Excluded from the plain-Node runner by its
// underscore prefix (same convention as _startup-browser.js).
async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  const p = await context.newPage();
  const errors = [], dialogs = [], checks = [];
  const check = (n, ok, d) => checks.push({ n, pass: !!ok, d: d || '' });
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });

  const rows = [
    { id: 'r1', url: 'https://cdn.example.test/Adobe_Photoshop_2026_Setup.exe', filename: 'Adobe_Photoshop_2026_Setup.exe', category: 'software', status: 'downloading', downloaded: 762000000, totalSize: 2100000000, speed: 24117248, percent: 36.3, savePath: 'D:\\Downloads', segmentDetails: [{}, {}, {}, {}, {}, {}, {}, {}], connections: 8, targetConnections: 8 },
    { id: 'r2', url: 'https://cdn.example.test/The.Bear.S03E04.1080p.WEB-DL.mkv', filename: 'The.Bear.S03E04.1080p.WEB-DL.mkv', category: 'video', status: 'completed', downloaded: 5872025600, totalSize: 5872025600, speed: 0, percent: 100, savePath: 'D:\\Downloads', media: { width: 1920, height: 1080, hasVideo: true, hasAudio: true }, quality: { label: '1080p', resolution: '1920x1080' } },
    { id: 'r3', url: 'https://files.example.test/report-2026.pdf', filename: 'report-2026.pdf', category: 'pdf', status: 'error', error: 'The server refused this download request (HTTP 403).', downloaded: 0, totalSize: 1048576, speed: 0, percent: 0, savePath: 'D:\\Downloads' },
    { id: 'r4', url: 'https://cdn.example.test/album-lossless.zip', filename: 'album-lossless.zip', category: 'archive', status: 'paused', downloaded: 104857600, totalSize: 734003200, speed: 0, percent: 14.3, savePath: 'D:\\Downloads' },
    { id: 'r5', url: 'https://cdn.example.test/ambient-mix.mp3', filename: 'ambient-mix.mp3', category: 'audio', status: 'queued', downloaded: 0, totalSize: 0, speed: 0, percent: 0, savePath: 'D:\\Downloads' },
  ];

  const mockApi = () => {
    window.fixtureCalls = [];
    window.fixtureEvents = {};
    const settings = { defaultSavePath: 'D:\\Downloads', defaultSegments: 8, maxConcurrentDownloads: 3, categoryPaths: {}, fileHosts: {}, aiEnabled: false, clipboardMonitor: false };
    const api = {
      getSettings: async () => settings,
      getDownloads: async () => JSON.parse(JSON.stringify(window.fixtureRows || [])),
      getSchedules: async () => [],
      getNetworkInterfaces: async () => [],
      getAppVersion: async () => '5.8.0-isolated-test',
      getAutostart: async () => false,
      readClipboard: async () => '',
      aiStatus: async () => ({ enabled: false }),
      ytDlpStatus: async () => ({ found: false, jsRuntime: { found: true, name: 'node' } }),
      addDownload: async o => { window.fixtureCalls.push(o); return { id: 'new' }; },
      batchUrls: async list => { window.fixtureCalls.push({ batch: list }); return { added: list.length, skipped: 0 }; },
      saveSettings: async n => n,
      selectFolder: async () => 'D:\\Fixture',
    };
    window.aidm = new Proxy(api, {
      get(t, n) {
        if (n in t) return t[n];
        if (String(n).startsWith('on')) return cb => { fixtureEvents[n] = cb; };
        return async () => null;
      },
    });
    window.fetch = async () => { throw new Error('offline fixture'); };
  };

  try {
    await context.route('**/*', r => r.request().url().startsWith('http://127.0.0.1:18923/') ? r.continue() : r.abort());
    await p.addInitScript(mockApi);
    await p.addInitScript(list => { window.fixtureRows = list; }, rows);
    await p.goto('http://127.0.0.1:18923/', { waitUntil: 'load' });
    await p.waitForFunction(() => document.querySelector('#boot-state')?.dataset.state === 'ready');
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await p.waitForTimeout(250);
    await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p2-after-rows-light.png' });

    const badge = await p.evaluate(() => {
      const el = document.querySelector('#download-list .status-badge.completed');
      const cs = getComputedStyle(el);
      const token = getComputedStyle(document.documentElement).getPropertyValue('--state-success').trim();
      const rgb = token.startsWith('#')
        ? (() => { const n = parseInt(token.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; })()
        : token;
      return { color: cs.color, token, rgb };
    });
    check('completed badge uses --state-success', badge.color === badge.rgb, JSON.stringify(badge));

    await p.fill('#search-input', 'zzz-no-match');
    await p.waitForTimeout(200);
    check('search-empty title is specific', (await p.locator('#empty-title').textContent()) === 'No downloads match your search');
    check('search-empty hint names the term', (await p.locator('#empty-hint').textContent()).includes('zzz-no-match'));
    check('Add URL hidden while filtered', !(await p.locator('#btn-empty-add').isVisible()));
    check('Clear filters offered', await p.locator('#btn-empty-clear').isVisible());
    await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p2-after-filtered-empty.png' });
    await p.locator('#btn-empty-clear').click();
    await p.waitForTimeout(150);
    check('Clear filters restores rows', await p.locator('#download-list tr').count() === 5);
    check('Clear filters empties the search box', (await p.inputValue('#search-input')) === '');

    await p.locator('.sidebar-item[data-category="document"]').click();
    await p.waitForTimeout(150);
    check('category-empty title is specific', (await p.locator('#empty-title').textContent()) === 'Nothing in this category');
    check('category-empty names the category', (await p.locator('#empty-hint').textContent()).toLowerCase().includes('documents'));
    await p.locator('#btn-empty-clear').click();

    await p.evaluate(() => { window.fixtureRows = []; });
    await p.evaluate(() => refreshList());
    await p.waitForTimeout(200);
    check('truly-empty keeps the original copy', (await p.locator('#empty-title').textContent()) === 'No downloads yet');
    check('Add URL is offered when truly empty', await p.locator('#btn-empty-add').isVisible());

    await p.locator('#btn-empty-add').click();
    await p.locator('#btn-start-download').click();
    await p.waitForTimeout(120);
    check('empty submit shows inline error', await p.locator('#input-url-error').isVisible());
    check('empty submit keeps the dialog open', await p.locator('#modal-overlay').isVisible());
    check('field is marked invalid', await p.evaluate(() => document.querySelector('#input-url').getAttribute('aria-invalid') === 'true'));
    check('addDownload was NOT called on empty submit', await p.evaluate(() => fixtureCalls.length === 0));
    await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p2-after-add-error.png' });
    await p.fill('#input-url', 'not a link');
    await p.waitForTimeout(60);
    check('typing clears the error', !(await p.locator('#input-url-error').isVisible()));
    await p.locator('#btn-start-download').click();
    await p.waitForTimeout(120);
    check('non-link text is rejected inline', (await p.locator('#input-url-error').textContent()).includes('doesn’t look like a link'));
    await p.fill('#input-url', 'https://example.test/file.zip');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(150);
    check('valid URL submits via Enter', await p.evaluate(() => fixtureCalls.length === 1 && fixtureCalls[0].url === 'https://example.test/file.zip'));
    check('valid submit closes the dialog', !(await p.locator('#modal-overlay').isVisible()));

    // Dark-theme capture with the rows restored (the validation submit above
    // ran against an empty fixture library).
    await p.evaluate(list => { window.fixtureRows = list; refreshList(); }, rows);
    await p.waitForTimeout(200);
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.waitForTimeout(200);
    await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p2-after-rows-dark.png' });

    check('no injected dialog ran', dialogs.length === 0);
    check('no page errors', errors.length === 0, errors.join('; '));
    return { checks, errors };
  } finally {
    await context.close();
  }
}
