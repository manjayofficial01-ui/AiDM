#!/usr/bin/env node
'use strict';

/**
 * `aidm-remote` — queue-only control for a headless AiDM node.
 *
 * This client does NOT start the desktop app. It pairs with a running AiDM
 * using a short verification code the user approves in a native dialog, then
 * stores a scope-limited token locally. Every call goes to the loopback HTTP
 * API with `X-AiDM-Token`; the API refuses anything outside the queue scope.
 *
 * Usage:
 *   node tools/aidm-remote.js pair
 *   node tools/aidm-remote.js status
 *   node tools/aidm-remote.js list
 *   node tools/aidm-remote.js add <url>
 *   node tools/aidm-remote.js pause <id>
 *   node tools/aidm-remote.js resume <id>
 *   node tools/aidm-remote.js cancel <id>
 *
 * Options: --port <n> (default 18765), --host <host> (default 127.0.0.1),
 *          --token <token>, --timeout <ms>.
 *
 * Stdout is JSON responses only; all prompts and errors go to stderr, so the
 * tool can be piped into jq or a script.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TOKEN_FILE = path.join(os.homedir(), '.aidm_remote_token');
const usage = [
  'AiDM remote queue client',
  '',
  'Usage:',
  '  node tools/aidm-remote.js pair',
  '  node tools/aidm-remote.js status | list',
  '  node tools/aidm-remote.js add <url>',
  '  node tools/aidm-remote.js pause <id> | resume <id> | cancel <id>',
  '',
  'Options:',
  '  --port <n>      Local API port (default 18765)',
  '  --host <host>   Local API host (default 127.0.0.1)',
  '  --token <hex>   Token to use instead of ~/.aidm_remote_token',
  '  -h, --help      Show this text',
].join('\n');

function parseArgs(argv) {
  const args = { _: [], host: '127.0.0.1', port: 18765, token: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    if (a === '--host' || a === '--port' || a === '--token') {
      const value = argv[++i];
      if (!value) throw new Error(`${a} needs a value`);
      args[a.slice(2)] = a === '--port' ? Number(value) : value;
      continue;
    }
    args._.push(a);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('Invalid --port');
  return args;
}

function request(args, method, route, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers['X-AiDM-Token'] = token;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      host: args.host,
      port: args.port,
      path: route,
      method,
      headers,
      timeout: 10000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text.slice(0, 2000) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Local API timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readToken(args) {
  if (args.token) return args.token.trim();
  if (process.env.AIDM_REMOTE_TOKEN) return process.env.AIDM_REMOTE_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, token + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) { /* Windows may ignore */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pair(args) {
  const started = await request(args, 'POST', '/api/device-code', {});
  if (started.status !== 200 || !started.body || !started.body.code) {
    throw new Error(`Pairing request failed (${started.status}): ${JSON.stringify(started.body)}`);
  }
  console.error(`Approve this code in AiDM: ${started.body.code}`);
  console.error('Waiting for approval… (Ctrl+C to cancel)');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const res = await request(args, 'POST', '/api/device-token', { code: started.body.code });
    if (res.status === 200 && res.body && res.body.token) {
      saveToken(res.body.token);
      console.error(`Paired. Scope: ${res.body.scope || 'queue'}. Token saved to ${TOKEN_FILE}`);
      return;
    }
    if (res.status === 403) throw new Error(`Pairing refused: ${res.body.error || 'denied'}`);
    if (res.status !== 200) throw new Error(`Pairing poll failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  throw new Error('Pairing timed out — the code expired');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) { console.error(usage); process.exitCode = args.help ? 0 : 1; return; }
  const command = args._[0];
  if (command === 'pair') { await pair(args); return; }

  const routes = {
    status: ['GET', '/api/status'],
    list: ['GET', '/api/downloads'],
    add: ['POST', '/api/download'],
    pause: ['POST', '/api/pause'],
    resume: ['POST', '/api/resume'],
    cancel: ['POST', '/api/cancel'],
  };
  const spec = routes[command];
  if (!spec) throw new Error(`Unknown command: ${command}\n${usage}`);
  const token = readToken(args);
  if (!token) throw new Error('No remote token. Run "aidm-remote pair" first, or pass --token.');

  let body;
  if (['add', 'pause', 'resume', 'cancel'].includes(command)) {
    const value = args._[1];
    if (!value) throw new Error(`${command} needs ${command === 'add' ? 'a URL' : 'an id'}`);
    body = command === 'add' ? { url: value } : { id: value };
  }
  const res = await request(args, spec[0], spec[1], body, token);
  if (res.status >= 400) throw new Error(`API ${res.status}: ${JSON.stringify(res.body)}`);
  process.stdout.write(JSON.stringify(res.body, null, 2) + '\n');
}

main().catch((err) => {
  console.error(`aidm-remote: ${(err && err.message) || err}`);
  process.exitCode = 1;
});
