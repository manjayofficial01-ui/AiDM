// Real-Chromium fixture for APP-006 / APP-007 / APP-009.
//
// Run through the Playwright MCP `browser_run_code_unsafe` { code } argument
// while test/_settings-server.js serves the real renderer on
// http://127.0.0.1:18923/. Excluded from the plain-Node runner by its
// underscore prefix (same convention as _quality-browser.js).
async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
  const p = await context.newPage();
  const errors = [], dialogs = [], checks = [];
  const check = (name, ok, detail) => checks.push({ name, pass: !!ok, detail: detail || '' });
  p.on('pageerror', error => errors.push(error.message));
  p.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });

  const mockApi = (mode) => {
    window.fixtureMode = mode; // 'ok' | 'delay' | 'reject'
    window.fixtureEvents = {};
    window.fixtureRetrySucceeds = false;
    const settings = { defaultSavePath: 'D:\\Fixture Downloads', defaultSegments: 8, maxConcurrentDownloads: 3, categoryPaths: {}, fileHosts: {}, aiEnabled: false, clipboardMonitor: false };
    const api = {
      getSettings: async () => settings,
      getDownloads: async () => {
        if (window.fixtureMode === 'reject' && !window.fixtureRetrySucceeds) throw new Error('Fixture IPC failure');
        if (window.fixtureMode === 'delay') await new Promise(r => setTimeout(r, 1200));
        return [];
      },
      getSchedules: async () => [],
      getNetworkInterfaces: async () => [],
      getAppVersion: async () => '5.8.0-isolated-test',
      getAutostart: async () => false,
      readClipboard: async () => '',
      aiStatus: async () => ({ enabled: false }),
      ytDlpStatus: async () => ({ found: false, jsRuntime: { found: true, name: 'node' } }),
      addDownload: async () => ({ id: 'fixture-download' }),
      saveSettings: async next => next,
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
  };

  try {
    await context.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:18923/') ? route.continue() : route.abort());

    // ── A. Loading state: no false empty library while IPC is pending ──
    await p.addInitScript(mockApi, 'delay');
    await p.goto('http://127.0.0.1:18923/', { waitUntil: 'load' });
    await p.waitForSelector('#boot-state', { state: 'visible' });
    check('loading state is visible while IPC is pending', await p.locator('#boot-state').isVisible());
    check('loading copy is explicit', (await p.locator('#boot-text').textContent()).includes('Loading'));
    check('empty state is NOT shown during loading', !(await p.locator('#empty-state').isVisible()));
    check('table is hidden during loading', !(await p.locator('#download-table').isVisible()));
    check('shell controls are usable during loading', await p.locator('#btn-add-url').isEnabled());
    await p.waitForSelector('#boot-state', { state: 'hidden', timeout: 5000 });
    check('loaded-empty shows the empty state', await p.locator('#empty-state').isVisible());
    check('loaded-empty shows the table', await p.locator('#download-table').isVisible());
    check('boot state hidden after ready', !(await p.locator('#boot-state').isVisible()));
    check('no page errors on the happy path', errors.length === 0, errors.join('; '));

    // ── B. Failed startup: recoverable, not a dead shell ──
    const p2 = await context.newPage();
    p2.on('pageerror', error => errors.push(error.message));
    await p2.addInitScript(mockApi, 'reject');
    await p2.goto('http://127.0.0.1:18923/', { waitUntil: 'load' });
    await p2.waitForFunction(() => document.querySelector('#boot-state')?.dataset.state === 'error');
    check('failed load shows the error state', await p2.locator('#boot-state').isVisible());
    check('error copy is explicit', (await p2.locator('#boot-text').textContent()).includes('Could not load'));
    check('empty state is NOT shown on failure', !(await p2.locator('#empty-state').isVisible()));
    check('Retry control is offered', await p2.locator('#btn-boot-retry').isVisible());
    check('shell still usable after failure', await p2.locator('#btn-add-url').isEnabled());
    await p2.evaluate(() => { window.fixtureRetrySucceeds = true; });
    await p2.locator('#btn-boot-retry').click();
    await p2.waitForFunction(() => document.querySelector('#boot-state')?.dataset.state === 'ready');
    check('Retry recovers to ready', await p2.locator('#empty-state').isVisible());
    await p2.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p1-startup-ready.png' });

    // ── C. Keyboard: categories, sorting, quality radio group ──
    const cat = p.locator('.sidebar-item[data-category="completed"]');
    await cat.focus();
    await p.keyboard.press('Enter');
    check('category activates by keyboard (Enter)', await p.evaluate(() =>
      document.querySelector('.sidebar-item[data-category="completed"]').getAttribute('aria-pressed') === 'true'));
    check('previous category is unpressed', await p.evaluate(() =>
      document.querySelector('.sidebar-item[data-category="all"]').getAttribute('aria-pressed') === 'false'));

    const sizeTh = p.locator('th[data-col="size"]');
    await sizeTh.focus();
    await p.keyboard.press('Enter');
    check('sort header activates by keyboard', await p.evaluate(() => document.querySelector('th[data-col="size"]').getAttribute('aria-sort') === 'ascending'));
    await p.keyboard.press('Enter');
    check('second press flips to descending', await p.evaluate(() => document.querySelector('th[data-col="size"]').getAttribute('aria-sort') === 'descending'));
    await p.keyboard.press(' ');
    check('third press clears the sort', await p.evaluate(() => document.querySelector('th[data-col="size"]').getAttribute('aria-sort') === 'none'));

    await p.evaluate(() => showQualityPicker({
      pageUrl: 'https://example.test/watch/kbd', pageTitle: 'Keyboard video',
      videos: [
        { url: 'https://cdn.example.test/a1080.mp4', quality: '1080p', format: 'mp4', filename: 'Keyboard 1080.mp4' },
        { url: 'https://cdn.example.test/a720.mp4', quality: '720p', format: 'mp4', filename: 'Keyboard 720.mp4' },
      ],
    }));
    check('picker exposes a radiogroup', await p.evaluate(() => document.querySelector('#quality-list').getAttribute('role') === 'radiogroup'));
    check('options are radios', await p.evaluate(() => [...document.querySelectorAll('.quality-option')].every(o => o.getAttribute('role') === 'radio')));
    check('initial focus lands inside the dialog', await p.evaluate(() => !!document.activeElement.closest('#quality-overlay')));
    await p.keyboard.press('ArrowDown');
    check('ArrowDown moves selection', await p.evaluate(() => document.querySelector('.quality-option[aria-checked="true"]')?.dataset.idx === '1'));
    check('ArrowDown moves focus', await p.evaluate(() => document.activeElement?.dataset?.idx === '1'));
    await p.keyboard.press('Enter');
    check('Enter keeps the chosen variant', await p.evaluate(() => document.querySelector('.quality-option.selected .quality-label')?.textContent === '720P'));
    await p.locator('#btn-cancel-quality').click();

    // ── D. Persistence warning: persistent status + recovery ──
    await p.evaluate(() => window.fixtureEvents.onPersistError && window.fixtureEvents.onPersistError({ message: 'ENOSPC: no space left on device' }));
    check('persist failure shows the status warning', await p.locator('#persist-status').isVisible());
    check('warning names the real problem', (await p.locator('#persist-status').getAttribute('title')).includes('ENOSPC'));
    check('warning has an accessible role', await p.evaluate(() => document.querySelector('#persist-status').getAttribute('role') === 'status'));
    await p.evaluate(() => window.fixtureEvents.onPersistRecovered && window.fixtureEvents.onPersistRecovered({}));
    check('recovery hides the warning', !(await p.locator('#persist-status').isVisible()));
    await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p1-startup-warning.png' });

    // ── E. Dialogs: semantics + focus ──
    await p.locator('#btn-add-url').click();
    check('add dialog has dialog semantics', await p.evaluate(() => {
      const m = document.querySelector('#add-url-modal');
      return m.getAttribute('role') === 'dialog' && m.getAttribute('aria-modal') === 'true' && m.getAttribute('aria-labelledby') === 'add-url-title';
    }));
    check('opening the dialog focuses the URL field', await p.evaluate(() => document.activeElement?.id === 'input-url'));
    check('dialog metadata executes no dialog', dialogs.length === 0);

    check('no page errors across the run', errors.length === 0, errors.join('; '));
    return { checks, errorCount: errors.length };
  } finally {
    await context.close();
  }
}
