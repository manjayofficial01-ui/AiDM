async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
  const p = await context.newPage();
  const errors = [], dialogs = [], checks = [], observations = [];
  const check = (name, ok) => { checks.push({ name, pass: !!ok }); };
  p.on('pageerror', error => errors.push(error.message));
  p.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  try {
    await context.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:18923/') ? route.continue() : route.abort());
    await p.addInitScript(() => {
      window.fixtureCalls = [];
      window.fixtureEvents = {};
      window.fixtureResult = { id: 'fixture-download' };
      const settings = { defaultSavePath: 'D:\\Fixture Downloads', defaultSegments: 8, maxConcurrentDownloads: 3, categoryPaths: {}, fileHosts: {}, aiEnabled: false, clipboardMonitor: false };
      const api = {
        getSettings: async () => settings,
        getDownloads: async () => [],
        getSchedules: async () => [],
        getNetworkInterfaces: async () => [],
        getAppVersion: async () => '5.8.0-isolated-test',
        getAutostart: async () => false,
        readClipboard: async () => '',
        aiStatus: async () => ({ enabled: false }),
        ytDlpStatus: async () => ({ found: false, jsRuntime: { found: true, name: 'node' } }),
        addDownload: async opts => {
          if (window.fixtureError) throw new Error(fixtureError);
          fixtureCalls.push(opts);
          return fixtureResult;
        },
        saveSettings: async next => {
          if (window.fixtureSettingsError) throw new Error(fixtureSettingsError);
          return next;
        },
        selectFolder: async () => 'D:\\Fixture Chosen Folder',
      };
      window.aidm = new Proxy(api, {
        get(target, name) {
          if (name in target) return target[name];
          if (String(name).startsWith('on')) return callback => { fixtureEvents[name] = callback; };
          return async () => null;
        },
      });
      window.fetch = async () => { throw new Error('Network disabled in isolated UI fixture'); };
    });
    await p.goto('http://127.0.0.1:18923/', { waitUntil: 'load' });
    await p.waitForFunction(() => document.querySelector('#app-version').textContent.includes('isolated-test'));
    check('renderer initializes without errors', errors.length === 0);
    const normal = {
      pageUrl: 'https://example.test/watch/fixture', pageTitle: 'Sample video',
      videos: [
        { url: 'https://cdn.example.test/movie1080.mp4', quality: '1080p', format: 'mp4', filename: 'Sample 1080.mp4', width: 1920, height: 1080, size: 1048576 },
        { url: 'https://cdn.example.test/movie720.mp4', quality: '720p', format: 'mp4', filename: 'Sample 720.mp4' },
      ],
    };
    await p.evaluate(data => showQualityPicker(data), normal);
    check('two normal quality options render', await p.locator('.quality-option').count() === 2);
    check('best quality is initially selected', (await p.locator('.quality-option.selected .quality-label').textContent()) === '1080P');
    await p.locator('.quality-option').nth(1).click();
    await p.evaluate(data => showQualityPicker(data), normal);
    check('duplicate detection preserves chosen quality', (await p.locator('.quality-option.selected .quality-label').textContent()) === '720P');
    await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p0-quality-normal.png' });
    await p.locator('#btn-download-quality').click();
    check('confirm submits selected variant once', await p.evaluate(() => fixtureCalls.length === 1 && fixtureCalls[0].url.endsWith('movie720.mp4')));
    check('successful submit closes picker', !(await p.locator('#quality-overlay').isVisible()));
    await p.evaluate(data => { fixtureResult = { success: false, error: 'Fixture rejection' }; showQualityPicker(data); }, { ...normal, pageUrl: 'https://example.test/watch/error' });
    await p.locator('#btn-download-quality').click();
    check('rejected submission keeps picker open', await p.locator('#quality-overlay').isVisible());
    await p.locator('#btn-cancel-quality').click();
    const markup = '<img src=x onerror="&#97;&#108;&#101;&#114;&#116;(1)">';
    await p.evaluate(({ markup }) => showQualityPicker({
      pageUrl: 'https://example.test/watch/markup', pageTitle: 'Literal metadata test',
      videos: [{ url: 'https://cdn.example.test/markup.mp4', quality: markup, format: markup, filename: 'Literal <b>filename</b>.mp4', resolution: '<svg onload=alert(1)>' }],
    }), { markup });
    check('quality markup is literal text', (await p.locator('.quality-label').textContent()) === markup.toUpperCase());
    check('format markup is literal text', (await p.locator('.quality-format').textContent()) === markup.toUpperCase());
    check('metadata creates no injected elements', await p.locator('#quality-list img, #quality-list svg, #quality-list script, #quality-list b').count() === 0);
    check('metadata executes no dialog', dialogs.length === 0);
    await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p0-quality-literal-metadata.png' });
    await p.locator('#quality-close').click();
    await p.evaluate(() => showQualityPicker({ pageUrl: 'https://example.test/watch/empty', videos: [] }));
    const countBefore = await p.evaluate(() => fixtureCalls.length);
    check('empty detection keeps picker hidden', !(await p.locator('#quality-overlay').isVisible()));
    await p.evaluate(() => downloadSelectedQuality());
    check('empty picker cannot enqueue a download', (await p.evaluate(() => fixtureCalls.length)) === countBefore);
    await p.evaluate(() => {
      fixtureResult = { id: 'numeric-fixture' };
      showQualityPicker({ pageUrl: 'https://example.test/numeric', videos: [{ url: 'https://example.test/720.mp4', quality: 720, format: 42 }] });
    });
    check('scalar metadata renders without crashing', (await p.locator('.quality-label').textContent()) === '720' && (await p.locator('.quality-format').textContent()) === '42');
    await p.locator('#btn-download-quality').click();
    check('scalar metadata survives submission', await p.evaluate(() => fixtureCalls.at(-1).quality.label === '720' && fixtureCalls.at(-1).quality.format === '42'));
    await p.locator('#btn-add-url').click();
    await p.locator('#input-url').fill('https://example.test/file.mp4');
    await p.locator('#input-savepath').fill('D:\\Unapproved');
    await p.evaluate(() => { fixtureError = 'savePath is outside the configured AiDM save folders. Use Browse to approve a different folder.'; });
    await p.locator('#btn-start-download').click();
    check('path rejection preserves the input and dialog', await p.locator('#modal-overlay').isVisible() && (await p.locator('#input-savepath').inputValue()) === 'D:\\Unapproved');
    check('path rejection shows Browse guidance', await p.getByText('Download failed: savePath is outside the configured AiDM save folders. Use Browse to approve a different folder.', { exact: true }).isVisible());
    await p.evaluate(() => { fixtureError = null; });
    await p.locator('#btn-browse').click();
    check('Add Download preserves Browse result', (await p.locator('#input-savepath').inputValue()) === 'D:\\Fixture Chosen Folder');
    await p.locator('#btn-start-download').click();
    check('Browse recovery submits and closes dialog', !(await p.locator('#modal-overlay').isVisible()) && await p.evaluate(() => fixtureCalls.at(-1).savePath === 'D:\\Fixture Chosen Folder'));
    await p.locator('#btn-settings').click();
    check('settings still opens', await p.locator('#settings-overlay').isVisible());
    await p.evaluate(() => { fixtureSettingsError = 'Use Browse to approve a different folder.'; });
    await p.evaluate(() => saveSettings());
    check('rejected settings stay open with feedback', await p.locator('#settings-overlay').isVisible() && await p.getByText('Settings not saved: Use Browse to approve a different folder.', { exact: true }).isVisible());
    await p.evaluate(() => { fixtureSettingsError = null; });
    await p.evaluate(() => saveSettings());
    check('valid settings close normally', !(await p.locator('#settings-overlay').isVisible()));
    check('no browser errors across exercised flows', errors.length === 0);
    return { checks, observations, errors, dialogs, testedWith: 'real renderer, isolated Chromium, mocked desktop APIs; external and installed-app requests blocked' };
  } finally { await context.close(); }
}
