// Real-Chromium fixture for the Qoder dark theme (cycle 6).
//
// Start test/_settings-server.js, then run this file through Playwright MCP
// `browser_run_code_unsafe`. The leading underscore keeps it out of the
// plain-Node test runner.
async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  const p = await context.newPage();
  const errors = [];
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, pass: !!ok, detail: detail == null ? '' : String(detail) });
  p.on('pageerror', (e) => errors.push(e.message));

  const rows = [
    { id: 'r1', url: 'https://cdn.example.test/big.zip', filename: 'big.zip', category: 'archive',
      status: 'downloading', priority: 'high', speedLimit: 256000, speed: 3145728,
      downloaded: 2400000, totalSize: 8000000, percent: 30 },
    { id: 'r2', url: 'https://cdn.example.test/movie.mp4', filename: 'movie [1080p].mp4', category: 'video',
      status: 'downloading', priority: 'normal', speedLimit: 0, speed: 1572864,
      downloaded: 63000000, totalSize: 70000000, percent: 90 },
    { id: 'r3', url: 'https://cdn.example.test/done.exe', filename: 'done.exe', category: 'software',
      status: 'completed', priority: 'normal', speedLimit: 0, downloaded: 12000000, totalSize: 12000000, percent: 100 },
    { id: 'r4', url: 'https://cdn.example.test/broken.iso', filename: 'broken.iso', category: 'disc',
      status: 'error', priority: 'low', speedLimit: 0, downloaded: 1000, totalSize: 4000000, percent: 1,
      error: 'TLS certificate could not be verified' },
    { id: 'r5', url: 'magnet:?xt=urn:btih:abc', filename: 'bundle', category: 'other',
      status: 'paused', isTorrent: true, multiFile: true, priority: 'normal', speedLimit: 0,
      seedPolicy: 'unlimited', downloaded: 200, totalSize: 600, percent: 33 },
  ];

  await context.route('**/*', (route) =>
    route.request().url().startsWith('http://127.0.0.1:18923/') ? route.continue() : route.abort());
  await p.addInitScript(() => {
    const settings = { defaultSavePath: 'D:\\Downloads', defaultSegments: 8, maxConcurrentDownloads: 3,
      categoryPaths: {}, fileHosts: {}, aiEnabled: false, clipboardMonitor: false };
    const api = {
      getSettings: async () => settings,
      getDownloads: async () => JSON.parse(JSON.stringify(window.fixtureRows || [])),
      getSchedules: async () => [],
      getNetworkInterfaces: async () => [],
      getAppVersion: async () => '5.8.0-qoder-theme',
      getAutostart: async () => false,
      readClipboard: async () => '',
      aiStatus: async () => ({ enabled: false }),
      ytDlpStatus: async () => ({ found: true, jsRuntime: { found: true, name: 'node' } }),
      getTorrentInfo: async () => ({ files: [] }),
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
  await p.addInitScript((data) => { window.fixtureRows = data.rows; }, { rows });
  await p.goto('http://127.0.0.1:18923/', { waitUntil: 'load' });

  // Settle so transitions and animations cannot smear the sampled colours.
  const readout = async () => {
    await p.waitForTimeout(700);
    return p.evaluate(() => {
      const rgbOf = (v) => {
        const s = String(v || '').trim();
        const hex = /^#([0-9a-f]{6})$/i.exec(s);
        if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
        const nums = (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        return nums.length === 3 ? nums : null;
      };
      const lum = (c) => [0.2126, 0.7152, 0.0722].reduce((a, w, i) =>
        a + w * (c[i] / 255 <= 0.03928 ? c[i] / 255 / 12.92 : Math.pow((c[i] / 255 + 0.055) / 1.055, 2.4)), 0);
      const ratio = (fg, bg) => {
        const a = rgbOf(fg), b = rgbOf(bg);
        if (!a || !b) return 'n/a';
        const l1 = lum(a), l2 = lum(b);
        return ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
      };
      const cs = (el, prop) => getComputedStyle(el).getPropertyValue(prop).trim();
      const root = document.documentElement;
      const vars = ['--bg-primary', '--bg-secondary', '--bg-elevated', '--bg-hover', '--accent',
        '--accent-soft', '--text-primary', '--text-secondary', '--text-muted', '--border',
        '--border-light', '--success', '--warning', '--error', '--state-fresh', '--state-pending',
        '--on-accent'].map((n) => n + '=' + cs(root, n));
      const find = (name) => (vars.find((v) => v.startsWith(name + '=')) || '').split('=')[1] || '';
      const canvas = cs(document.body, 'background-color');
      const primary = document.querySelector('.tool-btn.primary');
      const primaryFill = (cs(primary, 'background-image').match(/rgb\([^)]*\)/g) ||
        [cs(primary, 'background-color')]).pop();
      const progressStops = (cs(root, '--progress-fill').match(/#[0-9a-fA-F]{6}|rgba?\([^)]*\)/g) || []);
      return {
        theme: root.getAttribute('data-theme'),
        vars,
        canvas,
        textOnCanvas: ratio(find('--text-primary'), canvas),
        secondaryOnCanvas: ratio(find('--text-secondary'), canvas),
        mutedOnCanvas: ratio(find('--text-muted'), canvas),
        successOnCanvas: ratio(find('--success'), canvas),
        warningOnCanvas: ratio(find('--warning'), canvas),
        errorOnCanvas: ratio(find('--error'), canvas),
        accentOnCanvas: ratio(find('--accent'), canvas),
        primaryInk: cs(primary, 'color'),
        primaryInkOnFill: ratio(cs(primary, 'color'), primaryFill),
        progressStopOnCanvas: ratio(progressStops[0], canvas),
        progressStops: progressStops.join(' '),
      };
    });
  };

  await p.evaluate(() => localStorage.setItem('aidm-theme', 'dark'));
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => document.querySelector('#boot-state')?.dataset.state === 'ready');
  const dark = await readout();
  const want = (name, value) => dark.vars.includes(name + '=' + value);
  check('dark theme applied', dark.theme === 'dark', dark.theme);
  check('Qoder canvas + surfaces', want('--bg-primary', '#080807') && want('--bg-secondary', '#0E0E0E') &&
    want('--bg-hover', '#22221F') && want('--bg-elevated', '#1E1E1C'), dark.vars.join(' '));
  check('Qoder green accent', want('--accent', '#2ADB5C') && want('--accent-soft', '#8EE5A1'), dark.vars.join(' '));
  check('Qoder neutral text ramp', want('--text-primary', '#EEEEEB') && want('--text-secondary', '#B4B4AC') &&
    want('--text-muted', '#7B7B74'), dark.vars.join(' '));
  check('Qoder dark status colours', want('--warning', '#FAAD14') && want('--error', '#FF6B70') &&
    want('--state-fresh', '#C3A0DF'), dark.vars.join(' '));
  const legible = ['textOnCanvas', 'secondaryOnCanvas', 'mutedOnCanvas', 'successOnCanvas',
    'warningOnCanvas', 'errorOnCanvas', 'accentOnCanvas', 'progressStopOnCanvas'];
  check('every dark text/status colour clears 4.5:1 on the canvas',
    legible.every((k) => Number(dark[k]) >= 4.5), legible.map((k) => k + '=' + dark[k]).join(' '));
  check('dark primary ink is near-black on green (>=7:1)',
    dark.primaryInk === 'rgb(8, 8, 7)' && Number(dark.primaryInkOnFill) >= 7,
    dark.primaryInk + ' on fill = ' + dark.primaryInkOnFill);
  check('all five fixture rows rendered', await p.locator('tbody tr').count() === 5);
  check('no old blue left in dark tokens',
    !/3B82F6|60A5FA|2563EB|93C5FD|0B1220|121A2B|1A2438|E6EDF7/i.test(dark.vars.join(' ')), dark.vars.join(' '));
  await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p6-qoder-dark.png' });

  await p.evaluate(() => localStorage.setItem('aidm-theme', 'light'));
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => document.querySelector('#boot-state')?.dataset.state === 'ready');
  const light = await readout();
  const wantL = (name, value) => light.vars.includes(name + '=' + value);
  check('light theme untouched', light.theme === 'light' && wantL('--bg-primary', '#F7F9FC') &&
    wantL('--accent', '#2563EB'), light.vars.join(' '));
  check('light text clears 4.5:1', Number(light.textOnCanvas) >= 4.5 && Number(light.secondaryOnCanvas) >= 4.5,
    'primary=' + light.textOnCanvas + ' secondary=' + light.secondaryOnCanvas);
  check('light primary button keeps white ink', light.primaryInk === 'rgb(255, 255, 255)' &&
    Number(light.primaryInkOnFill) >= 4.5, light.primaryInk + ' = ' + light.primaryInkOnFill);
  await p.screenshot({ path: 'D:/000000 Lab/AiDM/aidm/docs/modernization/evidence/p6-light-regression.png' });

  check('no page errors', errors.length === 0, errors.join(' | '));
  await context.close();
  return JSON.stringify({
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).map((c) => c.name + ' :: ' + c.detail),
    dark,
    light,
  }, null, 2);
}
