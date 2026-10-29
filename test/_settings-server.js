'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { publicSettings } = require('../src/settings-view');
const { DownloadManager } = require('../src/download-manager');
const dm = Object.create(DownloadManager.prototype);
dm.settings = {
  defaultSavePath: path.resolve(__dirname), defaultSegments: 8, maxConcurrentDownloads: 3,
  categoryPaths: {}, aiEnabled: false, clipboardMonitor: false,
  aiApiKey: 'fixture-ai-secret', proxyUrl: 'http://fixture:fixture-proxy-secret@proxy.test:8080',
  fileHosts: { rapidgator: { user: 'fixture-user', password: 'fixture-host-secret', cookie: 'fixture-cookie-secret' } },
};
dm.engine = { setSpeedLimit() {}, setHlsConcurrency() {} };
dm.bandwidthWatch = { stop() {} };
for (const key of ['_applyEngineSettings', '_ensureDirectories', '_saveSettings', '_purgeFinished']) dm[key] = () => {};
let rejected = false, lastUpdate = {};
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'application/javascript']], ['/styles.css', ['styles.css', 'text/css']],
]);
const server = http.createServer(async (req, res) => {
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url === '/fixture/settings' && req.method === 'GET') return json(publicSettings(dm.settings));
  if (req.url === '/fixture/settings' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 65536) { res.writeHead(413); res.end(); return; }
    }
    if (rejected) { res.statusCode = 400; return json({ error: 'Fixture settings rejection' }); }
    lastUpdate = JSON.parse(body);
    return json(publicSettings(dm.saveSettings(lastUpdate)));
  }
  if (req.url === '/fixture/reject' && req.method === 'POST') { rejected = !rejected; return json({ rejected }); }
  if (req.url === '/fixture/status') return json({
    originalProxyPreserved: dm.settings.proxyUrl === 'http://fixture:fixture-proxy-secret@proxy.test:8080',
    proxyCleared: dm.settings.proxyUrl === '',
    replacementProxySaved: dm.settings.proxyUrl === 'socks5://new-user:fixture-new-proxy@proxy.test:1080',
    originalSecretsPreserved: dm.settings.aiApiKey === 'fixture-ai-secret' && dm.settings.fileHosts.rapidgator.password === 'fixture-host-secret' && dm.settings.fileHosts.rapidgator.cookie === 'fixture-cookie-secret',
    replacementSecretsSaved: dm.settings.aiApiKey === 'fixture-new-ai' && dm.settings.fileHosts.rapidgator.password === 'fixture-new-password' && dm.settings.fileHosts.rapidgator.cookie === 'fixture-new-cookie',
    updateHasProxy: Object.hasOwn(lastUpdate, 'proxyUrl'),
  });
  const asset = assets.get(req.url);
  if (!asset || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', asset[1]);
  res.end(fs.readFileSync(path.join(__dirname, '../ui', asset[0])));
});
server.listen(18923, '127.0.0.1', () => console.log('Isolated renderer fixture on 127.0.0.1:18923'));
