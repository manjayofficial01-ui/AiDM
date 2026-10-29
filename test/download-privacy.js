'use strict';
// Exercise the real boundary methods without constructors, services or home reads.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBoundaryModule(filename) {
  const file = path.join(__dirname, '..', 'src', filename);
  const sandbox = {
    module: { exports: {} },
    require(name) {
      if (['fs', 'path', 'events'].includes(name)) return require(name);
      if (name === './scheduler') return { DEFAULT_INTERCEPT_TYPES: [] };
      if (name === './download-privacy') return require('../src/download-privacy');
      return {}; // Engines/resolvers are not needed at these data boundaries.
    },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}

const { DownloadManager } = loadBoundaryModule('download-manager.js');
const { sanitizeApiPayload } = loadBoundaryModule('server.js');
const json = value => JSON.parse(JSON.stringify(value));
const secretNames = [
  'Cookie', 'cookie', 'cOoKiE', 'Cookies', 'COOKIES', 'cOoKiEs',
  'Authorization', 'authorization', 'aUtHoRiZaTiOn',
  'Proxy-Authorization', 'proxy-authorization', 'pRoXy-AuThOrIzAtIoN',
];
const benignHeaders = {
  Referer: 'https://example.test/watch', Origin: 'https://example.test',
  'User-Agent': 'fixture-agent', 'Accept-Language': 'en',
};
function credentials() {
  return Object.fromEntries(secretNames.map(key => [key, 'SYNTHETIC_PRIVATE_VALUE']));
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function fixture() {
  return freeze({
    id: 'private-row', url: 'https://example.test/file.bin', filename: 'file.bin',
    status: 'downloading', downloaded: 42, _segProgress: [12, 30],
    ...credentials(), cookies: 'SYNTHETIC_VAULT_COOKIE',
    headers: { ...benignHeaders, ...credentials() },
    meta: {
      title: 'Keep this title', ...credentials(),
      headers: { ...benignHeaders, ...credentials() },
      media: [{
        ...credentials(), headers: { ...benignHeaders, ...credentials() },
        nested: [{ ...credentials(), keep: [null, false, 0, 'plain text'] }],
      }],
      cookiePolicy: 'keep', authorizationType: 'keep',
    },
  });
}
function assertClean(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert(!/^(cookies?|authorization|proxy-authorization)$/i.test(key), `private key survived: ${key}`);
    assertClean(item);
  }
}
function assertDetached(copy, original) {
  if (!copy || typeof copy !== 'object') return;
  assert.notStrictEqual(copy, original);
  for (const key of Object.keys(copy)) assertDetached(copy[key], original[key]);
}
function assertBenign(row) {
  assert.deepStrictEqual(json(row.headers), benignHeaders);
  assert.deepStrictEqual(json(row.meta.headers), benignHeaders);
  assert.deepStrictEqual(json(row.meta.media[0].headers), benignHeaders);
  assert.deepStrictEqual(json(row.meta.media[0].nested), [{ keep: [null, false, 0, 'plain text'] }]);
  assert.strictEqual(row.meta.title, 'Keep this title');
  assert.strictEqual(row.meta.cookiePolicy, 'keep');
  assert.strictEqual(row.meta.authorizationType, 'keep');
  assert.strictEqual(row.downloaded, 42);
  assert.deepStrictEqual(json(row._segProgress), [12, 30]);
}
function manager(rows) {
  const dm = Object.create(DownloadManager.prototype);
  dm.downloads = new Map(rows.map(row => [row.id, row]));
  return dm;
}
function withState(rows, run) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.download-privacy-'));
  try {
    const statePath = path.join(dir, 'downloads.json');
    const dm = manager(rows);
    dm._getStatePath = () => statePath;
    dm._getLegacyStatePaths = () => [];
    run(dm, statePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
let passed = 0, failed = 0;
function test(name, run) {
  try { run(); passed++; console.log('OK  ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}

for (const [name, transform] of [
  ['export', row => manager([row]).exportDownloads()[0]],
  ['API', row => sanitizeApiPayload({ downloads: [row] }).downloads[0]],
]) {
  test(name + ' removes all private key variants recursively, preserving benign data', () => {
    const row = fixture();
    const before = JSON.stringify(row);
    const result = transform(row);
    assertClean(result);
    assertBenign(result);
    assert.strictEqual(result.status, 'downloading');
    assert.strictEqual(JSON.stringify(row), before);
    assertDetached(result, row);
  });
  test(name + ' returns a detached copy without changing authenticated replay data', () => {
    const row = fixture();
    const before = JSON.stringify(row);
    const result = transform(row);
    assert.strictEqual(JSON.stringify(row), before);
    assertDetached(result, row);
  });
}

test('persistence scrubs disk JSON, preserves live rows/vault inputs, and pauses active rows', () => {
  const row = fixture();
  const before = JSON.stringify(row);
  withState([row], (dm, statePath) => {
    const saved = [];
    dm.sessionVault = { save: (...args) => saved.push(args), forget: () => assert.fail('unexpected forget') };
    dm._persistDownloads(true);
    const output = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepStrictEqual(saved, [[row.id, row.cookies]]);
    assert.strictEqual(JSON.stringify(row), before);
    assert.strictEqual(output[0].status, 'paused');
    assertClean(output);
    assertBenign(output[0]);
    assert(!fs.existsSync(statePath + '.tmp'));
  });
});

test('vault save/forget behavior and non-downloading statuses are unchanged', () => {
  const rows = [
    { id: 'completed', status: 'completed' },
    { id: 'cancelled', status: 'cancelled' },
    { id: 'paused', status: 'paused' },
    { id: 'queued', status: 'queued' },
    { id: 'completed-session', status: 'completed', cookies: 'SYNTHETIC_VAULT_COOKIE' },
  ];
  withState(rows, (dm, statePath) => {
    const calls = [];
    dm.sessionVault = {
      save: (...args) => calls.push(['save', ...args]),
      forget: (...args) => calls.push(['forget', ...args]),
    };
    dm._persistDownloads(true);
    assert.deepStrictEqual(calls, [
      ['forget', 'completed'], ['forget', 'cancelled'],
      ['save', 'completed-session', rows[4].cookies],
    ]);
    const output = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepStrictEqual(output.map(row => row.status), rows.map(row => row.status));
    assertClean(output);
  });
});

test('internal scratch is removed before recursive copying', () => {
  const cycle = {};
  cycle.self = cycle;
  const scratch = ['_probe', '_normUrl', '_probePromise', '_customPath', '_speedSamples'];
  const row = { id: 'scratch', status: 'downloading', _segProgress: [42] };
  scratch.forEach(key => { row[key] = cycle; });
  const output = manager([row]).exportDownloads()[0];
  scratch.forEach(key => assert(!Object.hasOwn(output, key)));
  row._nameResolved = cycle;
  withState([row], (dm, statePath) => {
    dm._persistDownloads(true);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))[0];
    [...scratch, '_nameResolved'].forEach(key => assert(!Object.hasOwn(persisted, key)));
    assert.deepStrictEqual(persisted._segProgress, [42]);
  });
});

test('array metadata and null/absent optional fields retain JSON shapes', () => {
  const rows = [
    { id: 'array', meta: [{ ...credentials(), keep: [null, false, 1] }], headers: {} },
    { id: 'null', meta: null, headers: null },
    { id: 'absent' },
  ];
  const expected = [
    { id: 'array', meta: [{ keep: [null, false, 1] }], headers: {} },
    { id: 'null', meta: null, headers: null },
    { id: 'absent', meta: null, headers: null },
  ];
  assert.deepStrictEqual(json(manager(rows).exportDownloads()), expected);
  withState(rows, (dm, statePath) => {
    dm._persistDownloads(true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), expected);
  });
});

test('API preserves JSON scalars, arrays and own __proto__ data without pollution', () => {
  const input = JSON.parse('{"__proto__":{"keep":1,"Authorization":"SYNTHETIC"},"items":[null,false,0,"",{"Cookie":"SYNTHETIC","keep":2}]}');
  const output = sanitizeApiPayload(input);
  assertClean(output);
  assert.deepStrictEqual(json(output), { ...JSON.parse('{"__proto__":{"keep":1}}'), items: [null, false, 0, '', { keep: 2 }] });
  assert.strictEqual(Object.prototype.keep, undefined);
  for (const scalar of [null, false, 0, '', 'text']) assert.strictEqual(sanitizeApiPayload(scalar), scalar);
});

test('backup rotation sanitizes prior state without losing the previous revision', () => {
  withState([fixture()], (dm, statePath) => {
    const prior = JSON.stringify([{ id: 'previous', downloaded: 12, headers: { Authorization: 'SYNTHETIC_OLD_BACKUP', Referer: 'https://example.test/' } }]);
    fs.writeFileSync(statePath, prior);
    dm._persistDownloads(true);
    const backup = JSON.parse(fs.readFileSync(statePath + '.bak', 'utf8'));
    assertClean(backup);
    assert.deepStrictEqual(backup, [{ id: 'previous', downloaded: 12, headers: { Referer: 'https://example.test/' } }]);
    assertClean(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  });
});

console.log(`download-privacy: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
