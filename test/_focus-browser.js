// Real-Chromium fixture for AUD-015 (focus rings, target sizes, keyboard
// column sizing, narrow layouts).
//
// Run through the Playwright MCP `browser_run_code_unsafe` { code } argument
// while test/_settings-server.js serves the real renderer on
// http://127.0.0.1:18923/. Excluded from the plain-Node runner by its
// underscore prefix.
async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  const p = await context.newPage();
  const errors = [], checks = [];
  const check = (n, ok, d) => checks.push({ n, pass: !!ok, d: d || '' });
  p.on('pageerror', e => errors.push(e.message));

  const rows = [
    { id: 'r1', url: 'https://cdn.example.test/Adobe_Photoshop_2026_Setup.exe', filename: 'Adobe_Photoshop_2026_Setup.exe', category: 'software', status: 'downloading', downloaded: 762000000, totalSize: 2100000000, speed: 24117248, percent: 36.3, savePath: 'D:\\Downloads' },
    { id: 'r2', url: 'https://cdn.example.test/The.Bear.S03E04.mkv', filename: 'The.Bear.S03E04.mkv', category: 'video', status: 'completed', downloaded: 5872025600, totalSize: 5872025600, speed: 0, percent: 100, savePath: 'D:\\Downloads' },
  ];

  const mockApi = () => {
    const settings = { defaultSavePath: 'D:\\Downloads', defaultSegments: 8, maxConcurrentDownloads: 3, categoryPaths: {}, fileHosts: {}, aiEnabled: false, clipboardMonitor: false, trustedExtensionOrigins: [] };
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
      addDownload: async () => ({ id: 'x' }),
      saveSettings: async (n) => n,
      selectFolder: async () => 'D:\\F',
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
    await p.addInitScript(mockApi);
    await p.addInitScript(list => { window.fixtureRows = list; }, rows);
    await p.goto('http://127.0.0.1:18923/', { waitUntil: 'load' });
    await p.waitForFunction(() => document.querySelector('#boot-state')?.dataset.state === 'ready');
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.waitForTimeout(200);

    const sizeOf = (sel) => p.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }, sel);

    const rowCb = await sizeOf('#download-list input[type=checkbox]');
    const selectAll = await sizeOf('#select-all');
    check('row checkbox >= 16px', rowCb && rowCb.w >= 16 && rowCb.h >= 16, JSON.stringify(rowCb));
    check('select-all checkbox >= 16px', selectAll && selectAll.w >= 16, JSON.stringify(selectAll));

    await p.fill('#search-input', 'abc');
    await p.waitForTimeout(100);
    const clear = await sizeOf('#search-clear');
    check('search clear >= 24px', clear && clear.w >= 24 && clear.h >= 24, JSON.stringify(clear));

    const resizer = await sizeOf('.col-resizer');
    check('resizer grab strip >= 14px', resizer && resizer.w >= 14, JSON.stringify(resizer));

    // focus ring on the search clear (keyboard)
    await p.evaluate(() => document.querySelector('#search-input').focus());
    await p.keyboard.press('Tab');
    const clearFocus = await p.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { id: el.id, fv: el.matches(':focus-visible'), style: cs.outlineStyle, color: cs.outlineColor };
    });
    check('search clear shows a keyboard focus ring',
      clearFocus.id === 'search-clear' && clearFocus.fv && clearFocus.style === 'solid', JSON.stringify(clearFocus));

    // settings switch: size + focus ring (the specificity trap)
    await p.locator('#btn-settings').click();
    await p.waitForTimeout(150);
    const toggle = await sizeOf('#setting-ask-location');
    check('settings switch >= 24px tall', toggle && toggle.h >= 24, JSON.stringify(toggle));
    await p.evaluate(() => document.querySelector('#setting-ask-location').focus());
    await p.keyboard.press('Tab');
    await p.keyboard.press('Shift+Tab');
    const toggleFocus = await p.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { id: el.id, fv: el.matches(':focus-visible'), style: cs.outlineStyle, color: cs.outlineColor };
    });
    check('switch shows a keyboard focus ring',
      toggleFocus.id === 'setting-ask-location' && toggleFocus.fv && toggleFocus.style === 'solid', JSON.stringify(toggleFocus));
    await p.locator('#btn-cancel-settings').click();

    // keyboard column sizing
    const before = await p.evaluate(() => Math.round(document.querySelector('th[data-col="size"]').getBoundingClientRect().width));
    await p.locator('th[data-col="size"] .col-resizer').focus();
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('ArrowRight');
    const after = await p.evaluate(() => Math.round(document.querySelector('th[data-col="size"]').getBoundingClientRect().width));
    check('ArrowRight widens the column by 32px', after - before === 32, `${before}→${after}`);
    await p.keyboard.press('Shift+ArrowRight');
    const wide = await p.evaluate(() => Math.round(document.querySelector('th[data-col="size"]').getBoundingClientRect().width));
    check('Shift+ArrowRight uses a coarse step', wide - after === 48, `${after}→${wide}`);
    const resizerFocus = await p.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { fv: el.matches(':focus-visible'), style: cs.outlineStyle };
    });
    check('resizer shows a focus ring', resizerFocus.fv && resizerFocus.style === 'solid', JSON.stringify(resizerFocus));
    await p.keyboard.press('Home');
    const reset = await p.evaluate(() => Math.round(document.querySelector('th[data-col="size"]').getBoundingClientRect().width));
    check('Home restores the default width', reset === before, `${before}→${reset}`);

    // narrow layouts: no page-level horizontal scrollbar
    for (const width of [1280, 900, 700]) {
      await p.setViewportSize({ width, height: 700 });
      await p.waitForTimeout(150);
      const m = await p.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        win: window.innerWidth,
      }));
      check(`no page overflow at ${width}px`, m.doc <= m.win + 1 && m.body <= m.win + 1, JSON.stringify(m));
    }
    await p.setViewportSize({ width: 900, height: 600 });
    await p.waitForTimeout(150);
    await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p2-narrow-900.png' });

    check('no page errors', errors.length === 0, errors.join('; '));
    return { checks, errors };
  } finally {
    await context.close();
  }
}
