// Real-Chromium fixture for AUD-012 revocation UI (Settings › Browser).
//
// Run through the Playwright MCP `browser_run_code_unsafe` { code } argument
// while test/_settings-server.js serves the real renderer on
// http://127.0.0.1:18923/. Excluded from the plain-Node runner by its
// underscore prefix (same convention as _startup-browser.js).
async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 820 } });
  const p = await context.newPage();
  const errors = [], checks = [];
  const check = (n, ok, d) => checks.push({ n, pass: !!ok, d: d || '' });
  p.on('pageerror', e => errors.push(e.message));
  const PAIRED = 'chrome-extension://' + 'a'.repeat(32);

  const mockApi = (paired) => {
    window.fixtureSaves = [];
    const settings = {
      defaultSavePath: 'D:\\Downloads', defaultSegments: 8, maxConcurrentDownloads: 3,
      categoryPaths: {}, fileHosts: {}, aiEnabled: false, clipboardMonitor: false,
      trustedExtensionOrigins: paired,
    };
    const api = {
      getSettings: async () => JSON.parse(JSON.stringify(settings)),
      getDownloads: async () => [],
      getSchedules: async () => [],
      getNetworkInterfaces: async () => [],
      getAppVersion: async () => '5.8.0-isolated-test',
      getAutostart: async () => false,
      readClipboard: async () => '',
      aiStatus: async () => ({ enabled: false }),
      ytDlpStatus: async () => ({ found: false, jsRuntime: { found: true, name: 'node' } }),
      saveSettings: async (next) => {
        window.fixtureSaves.push(next);
        Object.assign(settings, next);
        return JSON.parse(JSON.stringify(settings));
      },
      selectFolder: async () => 'D:\\Fixture',
    };
    window.aidm = new Proxy(api, {
      get(t, n) {
        if (n in t) return t[n];
        if (String(n).startsWith('on')) return () => {};
        return async () => null;
      },
    });
    window.fetch = async () => { throw new Error('offline fixture'); };
  };

  try {
    await context.route('**/*', r => r.request().url().startsWith('http://127.0.0.1:18923/') ? r.continue() : r.abort());
    await p.addInitScript(mockApi, [PAIRED]);
    await p.goto('http://127.0.0.1:18923/', { waitUntil: 'load' });
    await p.waitForFunction(() => document.querySelector('#boot-state')?.dataset.state === 'ready');
    await p.locator('#btn-settings').click();
    await p.locator('[data-settings-tab="browser"]').click();
    await p.waitForTimeout(200);
    check('paired origin is listed', await p.locator('.trusted-extension-origin').count() === 1);
    check('listed origin is the exact one', (await p.locator('.trusted-extension-origin').textContent()) === PAIRED);
    await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p2-trusted-extensions.png' });
    await p.locator('.trusted-extension-row button').click();
    await p.waitForTimeout(250);
    const saves = await p.evaluate(() => window.fixtureSaves);
    check('removal saves an empty allowlist',
      saves.length === 1 && Array.isArray(saves[0].trustedExtensionOrigins) && saves[0].trustedExtensionOrigins.length === 0,
      JSON.stringify(saves));
    check('list shows the empty copy after removal', (await p.locator('.trusted-extension-empty').textContent()).includes('No extensions are trusted'));
    check('revocation toast is shown', (await p.locator('.toast-stack').textContent()).includes('revoked'));
    check('no page errors', errors.length === 0, errors.join('; '));
    return { checks, errors };
  } finally {
    await context.close();
  }
}
