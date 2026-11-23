#!/usr/bin/env node
'use strict';

/**
 * `aidm-mcp` — the MCP server an AI assistant starts.
 *
 * An MCP client (Claude Desktop, Claude Code, Cursor, VS Code…) launches this
 * program with pipes on its standard input and output, and talks to it in
 * JSON-RPC. This process then asks the RUNNING AiDM app to carry out the
 * calls, over a token-protected loopback channel.
 *
 * Two rules for this file:
 *   - Standard output carries the protocol and NOTHING else. Every note,
 *     warning and error goes to standard error, because a stray line on
 *     stdout breaks the client's parser.
 *   - The program never starts the app. If AiDM is not running, it says so
 *     and stops.
 *
 * Usage:
 *   node tools/aidm-mcp.js [--level look|standard|full] [--read-only]
 */

const path = require('path');

const { connectBridge } = require('../src/mcp/bridge-client');
const { createStdioServer } = require('../src/mcp/stdio-server');
const { bridgeFile } = require('../src/mcp/paths');
const { normalizeLevel } = require('../src/mcp/safety');

const USAGE = [
  'AiDM MCP server — lets an AI assistant work with your downloads.',
  '',
  'Usage:',
  '  node tools/aidm-mcp.js [options]',
  '',
  'Options:',
  '      --level <level>      look | standard | full (default: standard).',
  '                           look     — read the list and the status only.',
  '                           standard — add, pause, resume, cancel downloads.',
  '                           full     — also take a row off the list.',
  '                           The app can only LOWER this, never raise it.',
  '      --read-only          Same as --level look.',
  '      --bridge <file>      The app\'s connection file (default: the usual place).',
  '  -h, --help               Show this text.',
  '',
  'AiDM must be running, with "AI assistants (MCP)" turned on in Settings.',
].join('\n');

/**
 * Parse the command line.
 * @param {string[]} argv
 * @returns {{ level: string, bridge: string, help: boolean, unknown: string[] }}
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let level = 'standard';
  let bridge = bridgeFile();
  let help = false;
  /** @type {string[]} */
  const unknown = [];

  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] || '').trim();
    if (!arg) continue;
    const lower = arg.toLowerCase();
    if (lower === '-h' || lower === '--help') { help = true; continue; }
    if (lower === '--read-only') { level = 'look'; continue; }
    if (lower === '--level') {
      const value = String(args[++i] || '').trim().toLowerCase();
      if (!value) { unknown.push('--level needs a value'); continue; }
      if (!['look', 'standard', 'full'].includes(value)) {
        unknown.push(`"--level ${value}" is not one of look, standard, full`);
        continue;
      }
      level = value;
      continue;
    }
    if (lower.startsWith('--level=')) {
      const value = arg.slice('--level='.length).trim().toLowerCase();
      if (!['look', 'standard', 'full'].includes(value)) {
        unknown.push(`"--level ${value}" is not one of look, standard, full`);
        continue;
      }
      level = value;
      continue;
    }
    if (lower === '--bridge') {
      const value = String(args[++i] || '').trim();
      if (value) bridge = path.resolve(value);
      else unknown.push('--bridge needs a path');
      continue;
    }
    if (lower.startsWith('--bridge=')) {
      const value = arg.slice('--bridge='.length).trim();
      if (value) bridge = path.resolve(value);
      else unknown.push('--bridge needs a path');
      continue;
    }
    unknown.push(arg);
  }

  return { level: normalizeLevel(level, 'standard'), bridge, help, unknown };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stderr.write(USAGE + '\n');
    process.exit(0);
  }
  if (parsed.unknown.length) {
    process.stderr.write(`aidm-mcp: ${parsed.unknown.join('; ')}\n\n${USAGE}\n`);
    process.exit(2);
  }

  let bridge;
  try {
    bridge = await connectBridge({ file: parsed.bridge, level: parsed.level });
  } catch (e) {
    process.stderr.write(
      `aidm-mcp: ${(e && e.message) || 'could not reach AiDM'}.\n`
      + 'Start AiDM and turn on "AI assistants (MCP)" in Settings › General.\n',
    );
    process.exit(2);
    return;
  }

  createStdioServer({
    input: process.stdin,
    output: process.stdout,
    level: bridge.level,
    call: (cmd, args) => bridge.call(cmd, args),
    onError: (err) => {
      process.stderr.write(`aidm-mcp: ${(err && err.message) || 'connection closed'}\n`);
      try { bridge.close(); } catch (e) { /* already gone */ }
      process.exit(0);
    },
  });

  process.stdin.resume();
}

main().catch((err) => {
  process.stderr.write(`aidm-mcp: ${(err && err.message) || 'failed to start'}\n`);
  process.exit(2);
});
