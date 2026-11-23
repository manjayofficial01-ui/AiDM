// Test suite for AiDM's MCP server (Model Context Protocol).
//
// The feature this covers is the competitive gap found in the 2026-11-23
// upgrade cycle: three of the five leading open-source download managers now
// ship an MCP server, and AiDM — the only one of them with an AI layer of
// its own — did not.
//
// An MCP client is an AI assistant. Everything it sends is text a model
// produced, so the rules that keep it harmless are the whole point of this
// suite:
//
//  1. ACCESS LEVELS  — a connection may do at most what the app allows AND
//     what it asked for. A client can lower its own level, never raise it.
//  2. THE URL GUARD  — a link may not point at this machine, the LAN or a
//     cloud metadata address, in every shape an address can take.
//  3. TEXT HYGIENE  — remote-supplied text is stripped of control characters
//     and capped; a file name is never a path.
//  4. NEVER DELETE   — no assistant action can delete a file or choose a
//     folder.
//  5. THE TOKEN      — the bridge refuses a connection without the token,
//     and the access level is enforced by the APP, not by the client.
//  6. THE AUDIT LOG  — every call leaves a record, with secrets redacted.
//  7. THE PROTOCOL   — the MCP handshake, tools/list and tools/call behave
//     as a client expects.
//
// Run: node test/mcp-server.js
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const safety = require('../src/mcp/safety');
const protocol = require('../src/mcp/protocol');
const tools = require('../src/mcp/tools');
const { AuditLog, redactUrl } = require('../src/mcp/audit');
const { BridgeServer } = require('../src/mcp/bridge-server');
const { connectBridge } = require('../src/mcp/bridge-client');
const { createStdioServer } = require('../src/mcp/stdio-server');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function section(title) {
  console.log(`\n── ${title} ──`);
}

/** A DNS stub that resolves every host to a public address. */
const publicLookup = async () => [{ address: '93.184.216.34' }];

/** A DNS stub that resolves every host to a private address. */
const privateLookup = async () => [{ address: '10.1.2.3' }];

// ── 1. Access levels ─────────────────────────────────────────────────────────

section('1. Access levels');

eq('an unknown level falls back to standard', safety.normalizeLevel('wat'), 'standard');
eq('a level is case-insensitive', safety.normalizeLevel('LOOK'), 'look');
eq('look is the weakest', safety.levelRank('look'), 0);
eq('full is the strongest', safety.levelRank('full'), 2);
eq('a client cannot raise the app\'s level',
  safety.effectiveLevel('standard', 'full'), 'standard');
eq('a client may lower its own level',
  safety.effectiveLevel('full', 'look'), 'look');
eq('the app wins when both agree',
  safety.effectiveLevel('standard', 'standard'), 'standard');
check('look may not do standard work', !safety.levelAllows('look', 'standard'));
check('full may do standard work', safety.levelAllows('full', 'standard'));
check('standard may not do full work', !safety.levelAllows('standard', 'full'));

// ── 2. The URL guard ─────────────────────────────────────────────────────────

section('2. The URL guard (SSRF)');

eq('8.8.8.8 is public', safety.classifyIPv4Host('8.8.8.8'), 'public');
eq('127.0.0.1 is private', safety.classifyIPv4Host('127.0.0.1'), 'private');
eq('10.0.0.1 is private', safety.classifyIPv4Host('10.0.0.1'), 'private');
eq('192.168.1.1 is private', safety.classifyIPv4Host('192.168.1.1'), 'private');
eq('172.16.0.1 is private', safety.classifyIPv4Host('172.16.0.1'), 'private');
eq('172.32.0.1 is public', safety.classifyIPv4Host('172.32.0.1'), 'public');
eq('the cloud metadata address is private',
  safety.classifyIPv4Host('169.254.169.254'), 'private');
eq('100.64.0.1 (CGNAT) is private', safety.classifyIPv4Host('100.64.0.1'), 'private');
eq('0.0.0.0 is private', safety.classifyIPv4Host('0.0.0.0'), 'private');
eq('224.0.0.1 (multicast) is private', safety.classifyIPv4Host('224.0.0.1'), 'private');
eq('127.1 (shorthand) is ambiguous', safety.classifyIPv4Host('127.1'), 'ambiguous');
eq('012.1.2.3 (octal-looking) is ambiguous',
  safety.classifyIPv4Host('012.1.2.3'), 'ambiguous');
eq('0x7f000001 (hex) is ambiguous', safety.classifyIPv4Host('0x7f000001'), 'ambiguous');
eq('2130706433 (decimal) is ambiguous', safety.classifyIPv4Host('2130706433'), 'ambiguous');
eq('example.com is not an address', safety.classifyIPv4Host('example.com'), 'not-ip');

eq('::1 is private', safety.classifyIPv6Host('::1'), 'private');
eq(':: is private', safety.classifyIPv6Host('::'), 'private');
eq('fc00::1 (ULA) is private', safety.classifyIPv6Host('fc00::1'), 'private');
eq('fe80::1 (link-local) is private', safety.classifyIPv6Host('fe80::1'), 'private');
eq('a public v6 address is public',
  safety.classifyIPv6Host('2606:4700:4700::1111'), 'public');
eq('::ffff:127.0.0.1 is private', safety.classifyIPv6Host('::ffff:127.0.0.1'), 'private');
eq('::ffff:8.8.8.8 is public', safety.classifyIPv6Host('::ffff:8.8.8.8'), 'public');

check('localhost is blocked', safety.isBlockedHostName('localhost'));
check('a .local host is blocked', safety.isBlockedHostName('printer.local'));
check('the metadata host is blocked',
  safety.isBlockedHostName('metadata.google.internal'));
check('a normal host is not blocked', !safety.isBlockedHostName('example.com'));

(async () => {
  const loopback = await safety.checkUrl('http://127.0.0.1/x', { lookup: publicLookup });
  check('a loopback link is refused', !loopback.ok, loopback.reason);

  const local = await safety.checkUrl('http://localhost/x', { lookup: publicLookup });
  check('a localhost link is refused', !local.ok, local.reason);

  const metadata = await safety.checkUrl('http://169.254.169.254/latest/meta-data/',
    { lookup: publicLookup });
  check('the cloud metadata link is refused', !metadata.ok, metadata.reason);

  const shorthand = await safety.checkUrl('http://127.1/x', { lookup: publicLookup });
  check('a shorthand loopback link is refused', !shorthand.ok, shorthand.reason);

  const fileScheme = await safety.checkUrl('file:///C:/Windows/System32/config/SAM',
    { lookup: publicLookup });
  check('a file: link is refused', !fileScheme.ok, fileScheme.reason);

  const magnet = await safety.checkUrl('magnet:?xt=urn:btih:abc', { lookup: publicLookup });
  check('a magnet link is refused (it names no host)', !magnet.ok, magnet.reason);

  const dnsToPrivate = await safety.checkUrl('https://evil.example/file.zip',
    { lookup: privateLookup });
  check('a host that resolves to a private address is refused',
    !dnsToPrivate.ok, dnsToPrivate.reason);

  const good = await safety.checkUrl('https://example.com/file.zip', { lookup: publicLookup });
  check('a normal public link passes', good.ok, good.url);

  const garbage = await safety.checkUrl('not a url', { lookup: publicLookup });
  check('garbage is refused', !garbage.ok);

  // ── 3. Text hygiene ───────────────────────────────────────────────────────

  section('3. Text hygiene');

  eq('control characters are stripped',
    safety.sanitizeText('a\u0000b\u0007c'), 'abc');
  eq('newlines survive but are capped',
    safety.sanitizeText('a\n\n\n\nb'), 'a\n\nb');
  eq('long text is capped', safety.sanitizeText('x'.repeat(900), 50).length, 50);
  eq('a name is never a path',
    safety.sanitizeFileName('../../etc/passwd'), '.. .. etc passwd');
  eq('a name keeps no reserved character',
    safety.sanitizeFileName('a<b>c:d"e|f?g*h'), 'a b c d e f g h');
  eq('a name is not ".."', safety.sanitizeFileName('..'), '');
  eq('a name loses its trailing dot',
    safety.sanitizeFileName('report.'), 'report');
  check('a long name is capped', safety.sanitizeFileName('n'.repeat(400)).length <= 120);

  // ── 4. The rate limiter ───────────────────────────────────────────────────

  section('4. The rate limiter');

  const limiter = new safety.RateLimiter({ limit: 2, windowMs: 1000 });
  check('the first call passes', limiter.allow(0).ok);
  check('the second call passes', limiter.allow(10).ok);
  const rateDenied = limiter.allow(20);
  check('the third call is refused', !rateDenied.ok);
  check('the refusal says how long to wait', rateDenied.retryAfterMs > 0);
  check('the window slides', limiter.allow(2000).ok);

  // ── 5. The tool catalog ───────────────────────────────────────────────────

  section('5. The tool catalog');

  const lookTools = tools.toolCatalog('look').map((t) => t.name);
  const standardTools = tools.toolCatalog('standard').map((t) => t.name);
  const fullTools = tools.toolCatalog('full').map((t) => t.name);

  check('look sees the list', lookTools.includes('list_downloads'));
  check('look does NOT see add_download', !lookTools.includes('add_download'));
  check('look does NOT see remove_download', !lookTools.includes('remove_download'));
  check('standard sees add_download', standardTools.includes('add_download'));
  check('standard does NOT see remove_download', !standardTools.includes('remove_download'));
  check('full sees remove_download', fullTools.includes('remove_download'));
  check('full is a superset of standard',
    standardTools.every((n) => fullTools.includes(n)));

  check('every tool has a description',
    tools.TOOLS.every((t) => typeof t.description === 'string' && t.description.length > 30));
  check('every tool has an input schema',
    tools.TOOLS.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  check('no tool is called delete',
    !tools.TOOL_NAMES.some((n) => /delete|remove_file/.test(n)));
  check('remove_download says the file is kept',
    tools.findTool('remove_download').description.includes('FILE IS KEPT'));

  // ── 6. Argument checks ────────────────────────────────────────────────────

  section('6. Argument checks');

  const listTool = tools.findTool('list_downloads');
  eq('a status filter is lower-cased', listTool.build({ status: 'DOWNLOADING' }).status, 'downloading');
  eq('an absurd row limit is refused', (() => {
    try { listTool.build({ limit: 9999 }); return 'no error'; } catch (e) { return e.message; }
  })(), '"limit" must be between 1 and 200');
  eq('the row limit has a floor', (() => {
    try { listTool.build({ limit: 0 }); return 'no error'; } catch (e) { return e.message; }
  })(), '"limit" must be between 1 and 200');
  eq('a sensible row limit passes', listTool.build({ limit: 25 }).limit, 25);

  const addTool = tools.findTool('add_download');
  eq('the url is required', (() => {
    try { addTool.build({}); return 'no error'; } catch (e) { return e.message; }
  })(), '"url" is required');
  eq('a suggested name is cleaned',
    addTool.build({ url: 'https://example.com/a.zip', filename: '../../evil.sh' }).filename,
    '.. .. evil.sh');
  eq('a suggested name never becomes a path',
    addTool.build({ url: 'https://example.com/a.zip', filename: 'C:\\Windows\\evil.exe' }).filename,
    'C Windows evil.exe');
  eq('start defaults to true', addTool.build({ url: 'https://example.com/a.zip' }).start, true);
  eq('start can be turned off',
    addTool.build({ url: 'https://example.com/a.zip', start: false }).start, false);

  const pauseTool = tools.findTool('pause_download');
  eq('a download id is required', (() => {
    try { pauseTool.build({}); return 'no error'; } catch (e) { return e.message; }
  })(), '"id" is required');
  eq('a junk id is refused', (() => {
    try { pauseTool.build({ id: '../../etc/passwd' }); return 'no error'; } catch (e) { return e.message; }
  })(), '"id" is not a download id');

  // ── 7. The protocol ────────────────────────────────────────────────────────

  section('7. The protocol');

  const parsed = protocol.parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  check('a valid message parses', parsed.ok && parsed.message.method === 'tools/list');
  check('broken JSON is refused', !protocol.parseMessage('{oops').ok);
  check('a non-object is refused', !protocol.parseMessage('[1,2,3]').ok);
  check('a message without a method is refused',
    !protocol.parseMessage('{"jsonrpc":"2.0","id":1}').ok);
  check('an oversized message is refused',
    !protocol.parseMessage(JSON.stringify({ method: 'x', pad: 'y'.repeat(70000) })).ok);
  eq('a success response carries the id',
    protocol.okResponse(7, { a: 1 }).id, 7);
  eq('an error response carries the code',
    protocol.errorResponse(7, -32601, 'nope').error.code, -32601);
  eq('the protocol version is negotiated',
    protocol.negotiateProtocolVersion('2024-11-05'), '2024-11-05');
  check('an unknown protocol version gets the newest',
    protocol.negotiateProtocolVersion('1999-01-01') === protocol.LATEST_PROTOCOL_VERSION);

  // ── 8. The audit log ──────────────────────────────────────────────────────

  section('8. The audit log');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-mcp-'));
  const auditFile = path.join(tmp, 'logs', 'mcp-audit.log');
  const audit = new AuditLog({ file: auditFile });
  audit.append({ tool: 'add_download', level: 'standard', outcome: 'ok', detail: 'https://example.com/a.zip?token=secret' });
  audit.append({ tool: 'remove_download', level: 'full', outcome: 'denied' });
  const entries = audit.read(10);
  eq('two entries were written', entries.length, 2);
  eq('the tool is recorded', entries[0].tool, 'add_download');
  check('the secret in the query string is redacted',
    !String(entries[0].detail).includes('secret'), entries[0].detail);
  check('the parameter name is kept',
    String(entries[0].detail).includes('token'), entries[0].detail);
  eq('a refusal is recorded', entries[1].outcome, 'denied');
  check('the log file exists', fs.existsSync(auditFile));
  eq('redactUrl keeps the path', redactUrl('https://example.com/a/b.zip?x=1&y=2'),
    'https://example.com/a/b.zip?x&y=REDACTED');

  // ── 9. The bridge ──────────────────────────────────────────────────────────

  section('9. The bridge');

  /** A stand-in for the DownloadManager. */
  function makeManager(overrides = {}) {
    const calls = [];
    const rows = [
      {
        id: '11111111-2222-3333-4444-555555555555',
        url: 'https://example.com/file.zip',
        filename: 'file.zip',
        status: 'downloading',
        totalSize: 1000,
        downloaded: 250,
        speed: 100,
        percent: 25,
        savePath: 'C:\\Downloads\\AiDM',
        filepath: 'C:\\Downloads\\AiDM\\file.zip',
        addedAt: 1700000000000,
        cookies: 'session=secret',
        headers: { Cookie: 'session=secret' },
      },
    ];
    const manager = {
      calls,
      rows,
      appLevel: 'full',
      getSettings: () => ({
        defaultSavePath: 'C:\\Downloads\\AiDM',
        categoryPaths: {},
        mcpAccessLevel: manager.appLevel,
        ...(overrides.settings || {}),
      }),
      getAllDownloads: () => manager.rows.slice(),
      addDownload: (opts) => {
        calls.push(['addDownload', opts]);
        const row = { ...rows[0], id: 'new-row', filename: opts.filename || 'file.zip', status: 'queued' };
        manager.rows.push(row);
        return row;
      },
      queueDownload: (opts) => {
        calls.push(['queueDownload', opts]);
        const row = { ...rows[0], id: 'queued-row', filename: opts.filename || 'file.zip', status: 'queued' };
        manager.rows.push(row);
        return row;
      },
      pauseDownload: (id) => { calls.push(['pauseDownload', id]); return true; },
      resumeDownload: (id) => { calls.push(['resumeDownload', id]); return true; },
      cancelDownload: (id) => { calls.push(['cancelDownload', id]); return true; },
      removeDownload: (id, opts) => { calls.push(['removeDownload', id, opts]); return true; },
      startQueue: () => { calls.push(['startQueue']); return true; },
      pauseQueue: () => { calls.push(['pauseQueue']); return true; },
    };
    return manager;
  }

  const bridgeFile = path.join(tmp, 'mcp-bridge.json');
  const manager = makeManager();
  const bridge = new BridgeServer({
    manager,
    level: 'standard',
    audit: new AuditLog({ file: path.join(tmp, 'bridge-audit.log') }),
    file: bridgeFile,
    lookup: publicLookup,
    rateLimit: { limit: 100, windowMs: 60000 },
  });
  await bridge.start();

  check('the connection file was written', fs.existsSync(bridgeFile));
  const connection = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
  check('the connection file carries a token', typeof connection.token === 'string' && connection.token.length >= 32);
  check('the connection file carries the port', connection.port === bridge.port);
  check('the connection file carries the app\'s level', connection.level === 'full',
    connection.level);

  // A client whose token is wrong is refused.
  const doctoredFile = path.join(tmp, 'doctored-bridge.json');
  fs.writeFileSync(doctoredFile, JSON.stringify({ ...connection, token: 'not-the-token' }));
  const badToken = await connectBridge({ file: doctoredFile, level: 'standard' })
    .then(() => null, (e) => e);
  check('a client with the wrong token is refused', !!badToken, badToken && badToken.message);

  // A client with the right token gets in.
  const client = await connectBridge({ file: bridgeFile, level: 'look' });
  eq('the connection level is the minimum of app and client', client.level, 'look');

  const listResult = await client.call('list_downloads', {});
  eq('the list comes back', listResult.downloads.length, 1);
  eq('the row carries its id', listResult.downloads[0].id, '11111111-2222-3333-4444-555555555555');
  eq('the row carries its progress', listResult.downloads[0].percent, 25);
  check('the row carries no cookies', !('cookies' in listResult.downloads[0]));
  check('the row carries no headers', !('headers' in listResult.downloads[0]));

  const status = await client.call('get_status', {});
  eq('the status counts the running download', status.downloading, 1);
  eq('the status reports the level', status.accessLevel, 'look');

  const denied = await client.call('add_download', { url: 'https://example.com/a.zip' })
    .then(() => null, (e) => e);
  check('a look connection may not add a download', !!denied, denied && denied.message);
  eq('the refusal names the access level', denied && denied.code, 'access-denied');

  const unknown = await client.call('not_a_command', {}).then(() => null, (e) => e);
  eq('an unknown command is refused', unknown && unknown.code, 'unknown-command');

  // A standard connection may add, but not remove.
  const standard = await connectBridge({ file: bridgeFile, level: 'standard' });
  eq('a standard connection keeps its level', standard.level, 'standard');
  const added = await standard.call('add_download', { url: 'https://example.com/a.zip' });
  check('the download was added', added && added.download && added.download.id === 'new-row');
  const addCall = manager.calls.find((c) => c[0] === 'addDownload');
  check('the app chose the folder, not the assistant',
    addCall && addCall[1].savePath === 'C:\\Downloads\\AiDM', addCall && addCall[1].savePath);
  check('the assistant never supplied a folder', !('folder' in (addCall ? addCall[1] : {})));

  const removeDenied = await standard.call('remove_download',
    { id: '11111111-2222-3333-4444-555555555555' }).then(() => null, (e) => e);
  check('a standard connection may not remove a row', !!removeDenied);

  // A full connection may remove — and the files are kept.
  const full = await connectBridge({ file: bridgeFile, level: 'full' });
  eq('a full connection keeps its level', full.level, 'full');
  await full.call('remove_download', { id: '11111111-2222-3333-4444-555555555555' });
  const removeCall = manager.calls.find((c) => c[0] === 'removeDownload');
  check('the removal was told to keep the files',
    removeCall && removeCall[2] && removeCall[2].keepFiles === true, removeCall && JSON.stringify(removeCall[2]));

  // A link to this machine is refused by the APP, not by the client.
  const s = await standard.call('add_download', { url: 'http://127.0.0.1/secret' })
    .then(() => null, (e) => e);
  check('the app refuses a loopback link', !!s, s && s.message);
  eq('the refusal is a refusal', s && s.code, 'refused');

  // Lowering the level in Settings takes effect at once, even for a
  // connection that is already open.
  manager.appLevel = 'look';
  const afterDowngrade = await full.call('remove_download',
    { id: '11111111-2222-3333-4444-555555555555' }).then(() => null, (e) => e);
  check('lowering the level in Settings reaches a live connection',
    !!afterDowngrade, afterDowngrade && afterDowngrade.message);
  eq('the live connection is now held to the lower level',
    afterDowngrade && afterDowngrade.code, 'access-denied');
  manager.appLevel = 'full';

  // ── 10. The stdio server ───────────────────────────────────────────────────

  section('10. The stdio server');

  const input = new PassThrough();
  const output = new PassThrough();
  /** @type {any[]} */
  const replies = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });

  createStdioServer({
    input,
    output,
    level: 'standard',
    call: (cmd, args) => client.call(cmd, args),
  });

  input.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  }) + '\n');
  await new Promise((r) => setTimeout(r, 60));
  const init = replies.find((m) => m.id === 1);
  check('initialize is answered', !!init && !!init.result);
  eq('the server names itself', init && init.result.serverInfo.name, 'aidm');
  eq('the protocol version is answered', init && init.result.protocolVersion, '2025-06-18');
  check('the server says what it can do',
    init && typeof init.result.instructions === 'string' && init.result.instructions.length > 40);

  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await new Promise((r) => setTimeout(r, 60));
  const listed = replies.find((m) => m.id === 2);
  const names = listed && listed.result.tools.map((t) => t.name);
  check('tools/list answers', !!listed);
  check('a standard connection is offered add_download', names && names.includes('add_download'));
  check('a standard connection is NOT offered remove_download',
    names && !names.includes('remove_download'));
  check('every advertised tool carries a schema',
    listed && listed.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));

  input.write(JSON.stringify({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'list_downloads', arguments: { limit: 5 } },
  }) + '\n');
  await new Promise((r) => setTimeout(r, 120));
  const called = replies.find((m) => m.id === 3);
  check('tools/call answers', !!called && !!called.result);
  check('the answer is text', called && called.result.content[0].type === 'text');
  check('the answer carries the rows', called && called.result.content[0].text.includes('file.zip'));

  input.write(JSON.stringify({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'no_such_tool', arguments: {} },
  }) + '\n');
  await new Promise((r) => setTimeout(r, 60));
  const unknownTool = replies.find((m) => m.id === 4);
  check('an unknown tool is an error result', unknownTool && unknownTool.result.isError === true);

  input.write(JSON.stringify({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'pause_download', arguments: { id: 'not-an-id' } },
  }) + '\n');
  await new Promise((r) => setTimeout(r, 60));
  const badId = replies.find((m) => m.id === 5);
  check('a bad id is an error result', badId && badId.result.isError === true);
  check('the error explains itself',
    badId && badId.result.content[0].text.includes('not a download id'));

  input.write(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'no/such/method' }) + '\n');
  await new Promise((r) => setTimeout(r, 60));
  const noMethod = replies.find((m) => m.id === 6);
  check('an unknown method is a JSON-RPC error',
    noMethod && noMethod.error && noMethod.error.code === protocol.ERROR_CODES.METHOD_NOT_FOUND);

  input.write('{not json}\n');
  await new Promise((r) => setTimeout(r, 60));
  const broken = replies.find((m) => m.error && m.error.code === protocol.ERROR_CODES.PARSE_ERROR);
  check('broken JSON is a parse error', !!broken);

  // ── 11. The rate limit, at the bridge ──────────────────────────────────────

  section('11. The rate limit');

  const limited = new BridgeServer({
    manager: makeManager(),
    level: 'full',
    audit: new AuditLog({ file: path.join(tmp, 'limited-audit.log') }),
    file: path.join(tmp, 'limited-bridge.json'),
    lookup: publicLookup,
    rateLimit: { limit: 2, windowMs: 60000 },
  });
  await limited.start();
  const limitedClient = await connectBridge({ file: path.join(tmp, 'limited-bridge.json'), level: 'full' });
  await limitedClient.call('get_status', {});
  await limitedClient.call('get_status', {});
  const throttled = await limitedClient.call('get_status', {}).then(() => null, (e) => e);
  check('the third call in a minute is refused', !!throttled, throttled && throttled.message);
  eq('the refusal is a rate limit', throttled && throttled.code, 'rate-limited');
  await limited.stop();

  // ── 12. The bridge stops cleanly ───────────────────────────────────────────

  section('12. Shutting down');

  await bridge.stop();
  check('the connection file is gone after the stop', !fs.existsSync(bridgeFile));
  const afterStop = await connectBridge({ file: bridgeFile, level: 'standard' })
    .then(() => null, (e) => e);
  check('a client cannot reach a stopped bridge', !!afterStop);

  // ── 13. The source contract ────────────────────────────────────────────────

  section('13. The source contract');

  const repoRoot = path.join(__dirname, '..');
  const mainSrc = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(repoRoot, 'preload.js'), 'utf8');
  const managerSrc = fs.readFileSync(path.join(repoRoot, 'src', 'download-manager.js'), 'utf8');
  const importSrc = fs.readFileSync(path.join(repoRoot, 'src', 'settings-import.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(repoRoot, 'ui', 'index.html'), 'utf8');

  check('main.js starts the bridge', mainSrc.includes('syncMcpBridge'));
  check('main.js stops the bridge on quit', mainSrc.includes('bridge.stop()'));
  check('the preload exposes the bridge status', preloadSrc.includes('getMcpStatus'));
  check('the manager can remove a row without touching the files',
    managerSrc.includes('keepFiles'));
  check('an import cannot switch the bridge on',
    importSrc.includes('mcpEnabled'));
  check('the settings pane has the toggle',
    indexHtml.includes('setting-mcp-enabled') && indexHtml.includes('setting-mcp-level'));
  check('the MCP entry point exists',
    fs.existsSync(path.join(repoRoot, 'tools', 'aidm-mcp.js')));

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) { /* the temp folder is disposable */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('\nMCP suite crashed:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
