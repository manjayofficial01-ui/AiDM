'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');
const { robustFetch, DownloadEngine } = require('../src/download-engine');
const { destroyAgents } = require('../src/engine/agents');
const { connectToProxyServer, parseProxyUrl } = require('../src/engine/proxy');

const WORKSPACE_TMP = path.join(__dirname, '..', '.openclaw', 'tmp');
const engineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-engine.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, condition, extra) {
  if (condition) {
    pass++;
    console.log('  OK  ', name, extra === undefined ? '' : `(${extra})`);
  } else {
    fail++;
    console.log('  FAIL', name, extra === undefined ? '' : `(${extra})`);
  }
}

async function expectCertificateFailure(name, operation) {
  try {
    await operation();
    check(name, false, 'operation unexpectedly succeeded');
    return null;
  } catch (err) {
    const code = String(err && err.code || '');
    check(name, /SELF_SIGNED|CERT|UNABLE_TO_VERIFY|ALTNAME/i.test(code || err.message || ''), code || err.message);
    return err;
  }
}

function isCertificateError(err) {
  return /SELF_SIGNED|CERT|UNABLE_TO_VERIFY|ALTNAME/i.test(String(err && (err.code || err.message) || ''));
}

async function main() {
  fs.mkdirSync(WORKSPACE_TMP, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(WORKSPACE_TMP, 'transport-tls-'));
  const keyPath = path.join(tmp, 'key.pem');
  const certPath = path.join(tmp, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });

  const requests = [];
  const server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (req, res) => {
      requests.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('must never be accepted with certificate validation disabled');
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `https://127.0.0.1:${server.address().port}/file`;

  try {
    await expectCertificateFailure('robustFetch rejects an untrusted certificate', () => robustFetch(url));
    await expectCertificateFailure('probe request rejects an untrusted certificate', () => {
      const engine = new DownloadEngine();
      return engine._openRequest(url, { method: 'HEAD' });
    });
    await expectCertificateFailure('URL fetch rejects an untrusted certificate', () => {
      const engine = new DownloadEngine();
      return engine._fetchUrl(url);
    });
    await expectCertificateFailure('HTTPS proxy handshake rejects an untrusted certificate', () => {
      return connectToProxyServer(parseProxyUrl(`https://localhost:${server.address().port}`));
    });

    check('certificate failure was not recovered by a second successful request', requests.length <= 1, `requests=${requests.length}`);
    check('download engine has no TLS-error retry predicate', !engineSource.includes('isTlsError'));
    check('download engine contains no insecure fallback call', !/\binsecure:\s*true\b|\bdoRequest\(true\b|\ballowInsecure\b/.test(engineSource));
    check('proxy connector does not disable certificate validation', !fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'proxy.js'), 'utf8').includes('rejectUnauthorized: false'));
  } finally {
    destroyAgents();
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  console.log(`\ntransport-tls: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('  FAIL', err && err.stack || err);
  if (isCertificateError(err)) console.error('certificate helper unexpectedly produced:', err);
  process.exitCode = 1;
});
