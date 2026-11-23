// @ts-check
'use strict';

/**
 * The client half of the bridge: the process that connects to the running
 * AiDM app over the loopback socket and asks it to do things.
 *
 * The client never touches the app's internals — it can only send the
 * commands the bridge answers, and the bridge decides what those mean.
 */

const net = require('net');
const fs = require('fs');

/** How long to wait for the app to answer. */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Read the connection file the app wrote.
 * @param {string} file
 * @returns {{ port: number, token: string, level: string, pid: number }}
 */
function readConnectionFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const info = JSON.parse(text);
  if (!info || typeof info !== 'object') throw new Error('the connection file is not readable');
  if (!info.port || !info.token) throw new Error('the connection file is incomplete');
  return info;
}

/**
 * Connect to the running app.
 * @param {{ file: string, level?: string, timeoutMs?: number }} options
 * @returns {Promise<{ call: (cmd: string, args?: any) => Promise<any>, level: string, close: () => void }>}
 */
function connectBridge(options) {
  const file = options.file;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  /** @type {{ port: number, token: string, level: string, pid: number }} */
  let info;
  try {
    info = readConnectionFile(file);
  } catch (e) {
    // The app is not running, or it is running without the bridge on. Say so
    // in one sentence instead of a stack trace.
    return Promise.reject(new Error(
      `AiDM is not reachable (${(e && e.message) || 'no connection file'}). `
      + 'Start AiDM and turn on "AI assistants (MCP)" in Settings.',
    ));
  }

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: info.port });
    socket.setNoDelay(true);
    /** @type {string} */
    let buffer = '';
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
    const pending = new Map();
    let nextId = 1;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) { /* already gone */ }
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error('AiDM did not answer in time.')), 10000);
    timer.unref?.();

    socket.on('error', (err) => fail(new Error(`Could not reach AiDM: ${err.message}`)));

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (message.type === 'hello-ok') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            level: String(message.level || 'look'),
            close: () => {
              try { socket.destroy(); } catch (e) { /* already gone */ }
            },
            call: (cmd, args) => new Promise((res, rej) => {
              const id = nextId++;
              const callTimer = setTimeout(() => {
                pending.delete(id);
                rej(new Error(`AiDM did not answer "${cmd}" in time.`));
              }, timeoutMs);
              callTimer.unref?.();
              pending.set(id, { resolve: res, reject: rej, timer: callTimer });
              try {
                socket.write(JSON.stringify({ id, cmd, args: args || {} }) + '\n');
              } catch (e) {
                clearTimeout(callTimer);
                pending.delete(id);
                rej(new Error(`Could not send "${cmd}" to AiDM: ${e.message}`));
              }
            }),
          });
          return;
        }
        if (message.type === 'hello-error') {
          fail(new Error(String(message.error || 'AiDM refused the connection.')));
          return;
        }
        if (message.id !== undefined && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.ok) entry.resolve(message.result);
          else {
            const err = new Error(String((message.error && message.error.message) || 'the command failed'));
            if (message.error && message.error.code) err.code = message.error.code;
            entry.reject(err);
          }
        }
      }
    });

    socket.on('close', () => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('AiDM closed the connection.'));
      }
      pending.clear();
      if (!settled) fail(new Error('AiDM closed the connection.'));
    });

    socket.on('connect', () => {
      socket.write(JSON.stringify({
        type: 'hello',
        token: info.token,
        level: options.level || 'look',
      }) + '\n');
    });
  });
}

module.exports = { connectBridge, readConnectionFile, DEFAULT_TIMEOUT_MS };
