// Real-Chromium fixture for the cycle-5 engine controls.
//
// Start test/_settings-server.js, then run this file through Playwright MCP
// `browser_run_code_unsafe` (workspace filename resolution may be unavailable;
// paste this file's contents into the `code` argument if needed). The leading
// underscore keeps it out of the plain-Node test runner.
async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  const p = await context.newPage();
  const errors = [];
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, pass: !!ok, detail: detail == null ? '' : String(detail) });
  p.on('pageerror', (e) => errors.push(e.message));

  const rows = [
    { id: 'r1', url: 'https://cdn.example.test/big.zip', filename: 'big.zip', category: 'archive', status: 'downloading', priority: 'normal', speedLimit: 0, downloaded: 1000, totalSize: 5000, percent: 20 },
    { id: 'r2', url: 'magnet:?xt=urn:btih:abc', filename: 'bundle', category: 'other', status: 'downloading', isTorrent: true, multiFile: true, priority: 'normal', speedLimit: 0, seedPolicy: 'unlimited', downloaded: 0, totalSize: 0, percent: 0 },
    { id: 'r3', url: 'https://cdn.example.test/done.exe', filename: 'done.exe', category: 'software', status: 'completed', priority: 'normal', speedLimit: 0, downloaded: 100, totalSize: 100, percent: 100 },
  ];
  const torrentInfo = {
    files: [
      { index: 0, name: 'sample.mkv', path: 'bundle/sample.mkv', length: 100, selected: true },
      { index: 1, name: 'subtitles.srt', path: 'bundle/subtitles.srt', length: 200, selected: false },
      { index: 2, name: 'cover.jpg', path: 'bundle/cover.jpg', length: 300, selected: true },
    ],
  };

  await context.route('**/*', (route) => route.request().url().startsWith('http://127.0.0.1:18923/') ? route.continue() : route.abort());
  await p.addInitScript(() => {
    window.fixtureCalls = [];
    const settings = { defaultSavePath: 'D:\\Downloads', defaultSegments: 8, maxConcurrentDownloads: 3, categoryPaths: {}, fileHosts: {}, aiEnabled: false, clipboardMonitor: false };
    const api = {
      getSettings: async () => settings,
      getDownloads: async () => JSON.parse(JSON.stringify(window.fixtureRows || [])),
      getSchedules: async () => [],
      getNetworkInterfaces: async () => [],
      getAppVersion: async () => '5.8.0-options-fixture',
      getAutostart: async () => false,
      readClipboard: async () => '',
      aiStatus: async () => ({ enabled: false }),
      ytDlpStatus: async () => ({ found: false, jsRuntime: { found: true, name: 'node' } }),
      getTorrentInfo: async (id) => { window.fixtureCalls.push({ method: 'getTorrentInfo', id }); return JSON.parse(JSON.stringify(window.fixtureTorrentInfo)); },
      setDownloadPriority: async (id, priority) => { window.fixtureCalls.push({ method: 'priority', id, priority }); return true; },
      setDownloadSpeedLimit: async (id, bytesPerSecond) => { window.fixtureCalls.push({ method: 'rate', id, bytesPerSecond }); return true; },
      setTorrentSelection: async (id, selection) => { window.fixtureCalls.push({ method: 'selection', id, selection }); return true; },
      setTorrentSeedPolicy: async (id, policy) => { window.fixtureCalls.push({ method: 'seed', id, policy }); return true; },
    };
    window.aidm = new Proxy(api, {
      get(target, name) {
        if (name in target) return target[name];
        if (String(name).startsWith('on')) return () => {};
        return async () => null;
      },
    });
    window.fetch = async () => { throw new Error('offline fixture'); };
  });
  await p.addInitScript((data) => { window.fixtureRows = data.rows; window.fixtureTorrentInfo = data.info; }, { rows, info: torrentInfo });
  await p.goto('http://127.0.0.1:18923/', { waitUntil: 'load' });
  await p.waitForFunction(() => document.querySelector('#boot-state')?.dataset.state === 'ready');

  await p.locator('tr[data-id="r1"] button[data-action="options"]').click();
  await p.waitForSelector('#options-overlay', { state: 'visible' });
  check('options modal opens and focuses a priority choice', await p.evaluate(() => document.activeElement?.name === 'option-priority'));
  await p.locator('input[name="option-priority"][value="high"]').check();
  await p.fill('#option-speed-limit', '250');
  await p.locator('#btn-apply-options').click();
  await p.waitForSelector('#options-overlay', { state: 'hidden' });
  check('HTTP options send normalized priority and bytes/sec', await p.evaluate(() => window.fixtureCalls.some((c) => c.method === 'priority' && c.priority === 'high') &&
    window.fixtureCalls.some((c) => c.method === 'rate' && c.bytesPerSecond === 256000)));

  await p.locator('tr[data-id="r2"] button[data-action="options"]').click();
  await p.waitForSelector('#options-overlay', { state: 'visible' });
  const boxes = p.locator('#option-files-list input[type="checkbox"]');
  check('torrent selection renders all files', await boxes.count() === 3);
  await boxes.nth(1).check();
  await boxes.nth(2).uncheck();
  await p.selectOption('#option-seed-policy', 'stop');
  await p.locator('#btn-apply-options').click();
  check('torrent selection and seed policy reach the bridge', await p.evaluate(() => window.fixtureCalls.some((c) => c.method === 'selection' && JSON.stringify(c.selection) === '[true,true,false]') &&
    window.fixtureCalls.some((c) => c.method === 'seed' && c.policy === 'stop')));
  check('fixture page emitted no errors', errors.length === 0, errors.join('; '));
  await context.close();
  return checks;
};
