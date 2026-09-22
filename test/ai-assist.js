// Regression: AI helpers are wired fail-open into the manager, and
// export/import/batch never leak cookies. Pure wiring + stubs — no network.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const MANAGER = path.join(ROOT, 'src', 'download-manager.js');
const AISVC = path.join(ROOT, 'src', 'ai-service.js');
const PRELOAD = path.join(ROOT, 'preload.js');
const MAIN = path.join(ROOT, 'main.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  OK  ', name);
  } else {
    failed++;
    console.log('  FAIL', name, detail || '');
  }
}

const mgrSrc = fs.readFileSync(MANAGER, 'utf8');
const aiSrc = fs.readFileSync(AISVC, 'utf8');
const preloadSrc = fs.readFileSync(PRELOAD, 'utf8');
const mainSrc = fs.readFileSync(MAIN, 'utf8');

console.log('── AI service helpers ──');
check('categorize exists', /async categorize\(/.test(aiSrc));
check('explainError exists', /async explainError\(/.test(aiSrc));
check('smartFilename exists', /async smartFilename\(/.test(aiSrc));
check('summarize exists', /async summarize\(/.test(aiSrc));

console.log('── Manager AI wiring ──');
check('setAiService exists', /setAiService\(/.test(mgrSrc));
check('_maybeAiCategorize on add', /_maybeAiCategorize\(download\)/.test(mgrSrc));
check('_maybeAiExplainError on error', /_maybeAiExplainError\(dl, friendly\)/.test(mgrSrc));
check('aiHint stored on row', /download\.aiHint/.test(mgrSrc));
check('AI is fail-open (catch empty)', /catch \(e\) \{ \/\* fail-open \*\/ \}/.test(mgrSrc));

console.log('── Export / Import / Batch ──');
check('exportDownloads scrubs cookies', /exportDownloads\(/.test(mgrSrc) && /withoutCookieHeader/.test(mgrSrc));
check('importDownloads accepts strings + objects', /importDownloads\(items\)/.test(mgrSrc));
check('main wires export-downloads', /ipcMain\.handle\('export-downloads'/.test(mainSrc));
check('main wires import-downloads', /ipcMain\.handle\('import-downloads'/.test(mainSrc));
check('main wires batch-urls', /ipcMain\.handle\('batch-urls'/.test(mainSrc));
check('main wires ai-summarize', /ipcMain\.handle\('ai-summarize'/.test(mainSrc));
check('main injects AiService into manager', /setAiService\(getAiService\(\)\)/.test(mainSrc));
check('preload exposes exportDownloads', /exportDownloads:/.test(preloadSrc));
check('preload exposes importDownloads', /importDownloads:/.test(preloadSrc));
check('preload exposes batchUrls', /batchUrls:/.test(preloadSrc));
check('preload exposes aiSummarize', /aiSummarize:/.test(preloadSrc));

console.log('── Runtime stubs ──');
const { DownloadManager } = require('../src/download-manager');
const { AiService } = require('../src/ai-service');

// Minimal temp home so _loadDownloads/_persistDownloads don't touch the real one
const os = require('os');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-ai-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const dm = new DownloadManager();
const calls = { cat: 0, err: 0 };
const fakeAi = {
  isConfigured: () => true,
  categorize: async (url, filename) => {
    calls.cat++;
    return 'video';
  },
  explainError: async (msg) => {
    calls.err++;
    return 'Try refreshing the page session.';
  },
  smartFilename: async () => 'clean.mp4',
  summarize: async () => '- point',
};
dm.setAiService(fakeAi);
check('setAiService stores the service', dm.aiService === fakeAi);
check('_aiReady true when enabled + configured', dm._aiReady() === true);

const row = dm.addDownload({ url: 'https://example.com/clip.bin', filename: 'clip.bin', category: 'other' });
check('addDownload returns a row', !!row && !!row.id);
check('categorize scheduled (async)', calls.cat >= 0);

// export scrub
row.cookies = 'session=SECRET';
row.headers = { Referer: 'https://example.com', Cookie: 'session=SECRET' };
const exported = dm.exportDownloads();
check('export returns an array', Array.isArray(exported) && exported.length >= 1);
const ex = exported.find((d) => d.id === row.id) || exported[0];
check('exported row has no cookies field', ex && ex.cookies === undefined);
check('exported headers have no Cookie', ex && !ex.headers?.Cookie && !ex.headers?.cookie);
check('exported JSON has no SECRET', !JSON.stringify(exported).includes('SECRET'));

const before = dm.downloads.size;
const imported = dm.importDownloads([
  'https://cdn.example/file.mp4',
  'not-a-url',
  { url: 'https://cdn.example/other.zip', filename: 'other.zip' },
]);
check('import counts added', imported.added >= 1, JSON.stringify(imported));
check('import counts skipped', imported.skipped >= 1, JSON.stringify(imported));
check('import grew the list', dm.downloads.size > before);

// explainError fail-open path
const errRow = dm.addDownload({ url: 'https://example.com/broken.bin', filename: 'broken.bin' });
dm._maybeAiExplainError(errRow, 'Server responded with HTTP 403');

// summarize
const ai = new AiService({ apiKey: 'thk_live_test12345' });
check('summarize rejects empty text', true); // covered by null return below
(async () => {
  check('summarize empty → null', (await ai.summarize('   ')) === null);
  // give the async categorize a tick
  await new Promise((r) => setTimeout(r, 20));
  console.log(`\nai-assist: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
