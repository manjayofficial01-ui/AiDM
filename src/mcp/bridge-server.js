// @ts-check
'use strict';

/**
 * The bridge: the one door between an AI assistant and the running app.
 *
 * AiDM runs as a desktop app; an MCP client is a separate process that speaks
 * JSON-RPC over stdio. Something has to join them. This is that something:
 * a small TCP listener on 127.0.0.1, reachable only with the random token
 * written to the connection file, that carries out commands inside the app.
 *
 * The design follows Mister Download Manager's "token-protected local
 * channel" and Swift Download Manager's "the app enforces the access level,
 * not the client":
 *
 *   - The listener binds to the loopback interface only, on a random port.
 *   - Every connection must present the token before a single command runs.
 *   - The access level is the MINIMUM of what the app allows and what the
 *     client asked for, read from the app's settings on every call — so
 *     lowering the level in Settings takes effect immediately.
 *   - Links are checked against the SSRF guard before anything is fetched.
 *   - Nothing an assistant asks for can delete a file or choose a folder.
 *   - Every call is written to the audit log.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { AuditLog } = require('./audit');
const { checkUrl, effectiveLevel, levelAllows, normalizeLevel, sanitizeText, RateLimiter } = require('./safety');
const { bridgeFile: defaultBridgeFile } = require('./paths');

/** How many calls one connection may make per minute. */
const CALLS_PER_MINUTE = 60;

/** The level each command needs. */
const COMMAND_LEVELS = {
  list_downloads: 'look',
  get_download: 'look',
  get_status: 'look',
  audit_log: 'look',
  add_download: 'standard',
  probe_link: 'standard',
  pause_download: 'standard',
  resume_download: 'standard',
  cancel_download: 'standard',
  start_queue: 'standard',
  pause_queue: 'standard',
  remove_download: 'full',
};

/**
 * The bridge, running inside the app.
 */
class BridgeServer {
  /**
   * @param {{
   *   manager: any,
   *   level?: string,
   *   audit?: AuditLog,
   *   file?: string,
   *   host?: string,
   *   token?: string,
   *   rateLimit?: { limit?: number, windowMs?: number },
   *   lookup?: (h: string) => Promise<Array<{ address: string }>>,
   * }} options
   */
  constructor(options) {
    this.manager = options.manager;
    this.level = normalizeLevel(options.level, 'standard');
    this.audit = options.audit || new AuditLog({});
    this.file = options.file || defaultBridgeFile();
    this.host = options.host || '127.0.0.1';
    this.token = options.token || crypto.randomBytes(32).toString('hex');
    this.rateLimitOptions = options.rateLimit || { limit: CALLS_PER_MINUTE, windowMs: 60000 };
    this.lookup = options.lookup;
    /** @type {import('net').Server|null} */
    this.server = null;
    this.port = 0;
    /** @type {Set<import('net').Socket>} */
    this.sockets = new Set();
  }

  /**
   * The level the APP allows right now. Read live so a Settings change takes
   * effect without a restart.
   * @returns {string}
   */
  appLevel() {
    try {
      const settings = this.manager && this.manager.getSettings ? this.manager.getSettings() : null;
      const wanted = settings && settings.mcpAccessLevel;
      if (wanted) return normalizeLevel(wanted, this.level);
    } catch (e) {
      // A settings read must never widen the door.
    }
    return normalizeLevel(this.level, 'standard');
  }

  /**
   * Start listening and write the connection file.
   * @returns {Promise<{ port: number, file: string, token: string }>}
   */
  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._onConnection(socket));
      server.on('error', (err) => reject(err));
      server.listen(0, this.host, () => {
        const address = server.address();
        this.server = server;
        this.port = address && typeof address === 'object' ? address.port : 0;
        try {
          this._writeConnectionFile();
        } catch (e) {
          this.server.close();
          this.server = null;
          reject(e);
          return;
        }
        resolve({ port: this.port, file: this.file, token: this.token });
      });
    });
  }

  /**
   * Stop listening and remove the connection file.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      for (const socket of this.sockets) {
        try { socket.destroy(); } catch (e) { /* already gone */ }
      }
      this.sockets.clear();
      this._removeConnectionFile();
      if (!this.server) { resolve(); return; }
      const server = this.server;
      this.server = null;
      try { server.close(() => resolve()); } catch (e) { resolve(); }
    });
  }

  /**
   * The connection file's contents.
   * @returns {object}
   */
  connectionInfo() {
    return {
      version: 1,
      app: 'AiDM',
      port: this.port,
      token: this.token,
      pid: process.pid,
      level: this.appLevel(),
      startedAt: new Date().toISOString(),
    };
  }

  /** Write the connection file, readable by this user only. */
  _writeConnectionFile() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = JSON.stringify(this.connectionInfo(), null, 2);
    fs.writeFileSync(this.file, body, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch (e) { /* platform may ignore */ }
  }

  /** Remove the connection file. */
  _removeConnectionFile() {
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    } catch (e) {
      // A stale file is harmless: the client fails to connect and says so.
    }
  }

  /**
   * Serve one client connection.
   * @param {import('net').Socket} socket
   */
  _onConnection(socket) {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    /** @type {string} */
    let buffer = '';
    let authenticated = false;
    /** @type {{ requested: string, limiter: RateLimiter }} */
    let session = { requested: 'look', limiter: new RateLimiter(this.rateLimitOptions) };

    const fail = (message) => {
      try {
        socket.write(JSON.stringify({ type: 'hello-error', error: String(message) }) + '\n');
      } catch (e) {
        // The client may already be gone.
      }
      try { socket.destroy(); } catch (e) { /* already gone */ }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 256 * 1024) {
        fail('message too large');
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (e) {
          fail('not valid JSON');
          return;
        }
        if (!authenticated) {
          const ok = this._authenticate(message, session);
          if (!ok) {
            fail(message && message.error ? message.error : 'the connection was refused');
            return;
          }
          authenticated = true;
          session = ok;
          try {
            socket.write(JSON.stringify({
              type: 'hello-ok',
              app: 'AiDM',
              level: effectiveLevel(this.appLevel(), session.requested),
            }) + '\n');
          } catch (e) {
            try { socket.destroy(); } catch (e2) { /* already gone */ }
          }
          continue;
        }
        this._onCommand(socket, message, session);
      }
    });

    socket.on('error', () => { /* the client vanished; nothing to clean up */ });
    socket.on('close', () => { this.sockets.delete(socket); });
  }

  /**
   * Check the client's token and remember what level it asked for.
   * @param {any} message
   * @param {{ requested: string, limiter: RateLimiter }} session
   * @returns {{ requested: string, limiter: RateLimiter }|null}
   */
  _authenticate(message, session) {
    if (!message || message.type !== 'hello') return null;
    const given = String(message.token || '');
    const expected = Buffer.from(this.token, 'utf8');
    const actual = Buffer.from(given, 'utf8');
    const same = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!same) {
      this.audit.append({ tool: 'hello', level: 'none', outcome: 'denied', detail: 'bad token' });
      return null;
    }
    return {
      requested: normalizeLevel(message.level, 'look'),
      limiter: session.limiter,
    };
  }

  /**
   * Run one command and answer it.
   * @param {import('net').Socket} socket
   * @param {any} message
   * @param {{ level: string, limiter: RateLimiter }} session
   */
  _onCommand(socket, message, session) {
    const id = message && message.id !== undefined ? message.id : null;
    const cmd = String((message && message.cmd) || '');
    const args = (message && message.args && typeof message.args === 'object') ? message.args : {};

    const answer = (payload) => {
      try {
        socket.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        try { socket.destroy(); } catch (e2) { /* already gone */ }
      }
    };

    // The level is settled on EVERY call, not once at connect time: lowering
    // the access level in Settings takes effect at once, even for a
    // connection that is already open.
    const level = effectiveLevel(this.appLevel(), session.requested);

    const required = COMMAND_LEVELS[cmd];
    if (!required) {
      this.audit.append({ tool: cmd, level, outcome: 'unknown-command' });
      answer({ id, ok: false, error: { code: 'unknown-command', message: `AiDM has no command "${cmd}"` } });
      return;
    }
    if (!levelAllows(level, required)) {
      this.audit.append({ tool: cmd, level, outcome: 'denied' });
      answer({
        id,
        ok: false,
        error: {
          code: 'access-denied',
          message: `This connection may not use "${cmd}" — it needs the "${required}" access level, and this one has "${level}".`,
        },
      });
      return;
    }
    const rate = session.limiter.allow();
    if (!rate.ok) {
      this.audit.append({ tool: cmd, level, outcome: 'rate-limited' });
      answer({
        id,
        ok: false,
        error: {
          code: 'rate-limited',
          message: `Too many calls. Try again in ${Math.ceil((rate.retryAfterMs || 1000) / 1000)} second(s).`,
        },
      });
      return;
    }

    this.dispatch(cmd, args, { level })
      .then((result) => {
        this.audit.append({ tool: cmd, level, outcome: 'ok' });
        answer({ id, ok: true, result });
      })
      .catch((err) => {
        this.audit.append({ tool: cmd, level, outcome: 'error', detail: err && err.message });
        answer({
          id,
          ok: false,
          error: {
            code: (err && err.code) || 'failed',
            message: sanitizeText((err && err.message) || 'the command failed', 300),
          },
        });
      });
  }

  /**
   * Run a command against the app.
   * @param {string} cmd
   * @param {any} args
   * @param {{ level: string }} session
   * @returns {Promise<any>}
   */
  async dispatch(cmd, args, session) {
    const manager = this.manager;
    switch (cmd) {
      case 'list_downloads': {
        const rows = manager.getAllDownloads().map((d) => this._row(d));
        const status = args.status ? String(args.status).toLowerCase() : null;
        const text = args.text ? String(args.text).toLowerCase() : null;
        let filtered = rows;
        if (status) filtered = filtered.filter((r) => String(r.status).toLowerCase() === status);
        if (text) {
          filtered = filtered.filter((r) =>
            String(r.name || '').toLowerCase().includes(text)
            || String(r.url || '').toLowerCase().includes(text));
        }
        const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
        const newestFirst = filtered.slice().reverse();
        return { downloads: newestFirst.slice(0, limit), total: filtered.length };
      }
      case 'get_download': {
        const row = this._findRow(String(args.id || ''));
        if (!row) throw Object.assign(new Error('No download with that id.'), { code: 'not-found' });
        return { download: row };
      }
      case 'get_status': {
        const rows = manager.getAllDownloads();
        const counts = { queued: 0, downloading: 0, paused: 0, completed: 0, error: 0, other: 0 };
        for (const d of rows) {
          const s = String(d.status || '').toLowerCase();
          if (s === 'queued' || s === 'queued-paused') counts.queued += 1;
          else if (s === 'downloading' || s === 'connecting') counts.downloading += 1;
          else if (s === 'paused') counts.paused += 1;
          else if (s === 'completed') counts.completed += 1;
          else if (s === 'error') counts.error += 1;
          else counts.other += 1;
        }
        return {
          total: rows.length,
          ...counts,
          queuePaused: !!(manager.queuePaused || (manager.queue && manager.queue.paused)),
          accessLevel: session.level,
        };
      }
      case 'audit_log': {
        const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
        return { entries: this.audit.read(limit) };
      }
      case 'add_download': {
        const url = String(args.url || '');
        const guard = await checkUrl(url, this.lookup ? { lookup: this.lookup } : {});
        if (!guard.ok) {
          throw Object.assign(new Error(guard.reason || 'that link was refused'), { code: 'refused' });
        }
        const settings = manager.getSettings();
        const savePath = this._defaultSavePath(settings);
        if (!savePath) {
          throw Object.assign(
            new Error('AiDM has no default download folder yet. Set one in Settings first.'),
            { code: 'no-save-path' },
          );
        }
        const opts = { url: guard.url, savePath };
        const filename = args.filename ? sanitizeText(String(args.filename), 200) : '';
        if (filename) opts.filename = filename;
        const start = args.start !== false;
        const row = start ? manager.addDownload(opts) : manager.queueDownload(opts);
        if (!row) throw Object.assign(new Error('AiDM refused that link.'), { code: 'refused' });
        return { download: this._row(row), started: start };
      }
      case 'probe_link': {
        const url = String(args.url || '');
        const guard = await checkUrl(url, this.lookup ? { lookup: this.lookup } : {});
        if (!guard.ok) {
          throw Object.assign(new Error(guard.reason || 'that link was refused'), { code: 'refused' });
        }
        const { probeRemote } = require('../engine/probe');
        const { robustFetch } = require('../download-engine');
        const meta = await probeRemote(guard.url, {
          headers: {},
          fetchImpl: robustFetch,
          timeoutMs: 15000,
        });
        return {
          probe: {
            ok: true,
            status: meta && meta.status !== undefined ? meta.status : null,
            size: meta && meta.size !== undefined ? meta.size : null,
            type: meta && meta.type ? sanitizeText(String(meta.type), 60) : null,
            filename: meta && meta.filename ? sanitizeText(String(meta.filename), 200) : null,
            resumable: meta ? meta.resumable !== false : null,
          },
        };
      }
      case 'pause_download': {
        const row = this._findRow(String(args.id || ''));
        if (!row) throw Object.assign(new Error('No download with that id.'), { code: 'not-found' });
        manager.pauseDownload(row.id);
        return { download: this._row(this._live(row.id)) };
      }
      case 'resume_download': {
        const row = this._findRow(String(args.id || ''));
        if (!row) throw Object.assign(new Error('No download with that id.'), { code: 'not-found' });
        manager.resumeDownload(row.id);
        return { download: this._row(this._live(row.id)) };
      }
      case 'cancel_download': {
        const row = this._findRow(String(args.id || ''));
        if (!row) throw Object.assign(new Error('No download with that id.'), { code: 'not-found' });
        manager.cancelDownload(row.id);
        return { cancelled: true, id: row.id, filesKept: true };
      }
      case 'start_queue': {
        manager.startQueue();
        return { queuePaused: false };
      }
      case 'pause_queue': {
        manager.pauseQueue();
        return { queuePaused: true };
      }
      case 'remove_download': {
        const row = this._findRow(String(args.id || ''));
        if (!row) throw Object.assign(new Error('No download with that id.'), { code: 'not-found' });
        // keepFiles: an assistant may take a row off the list, never delete
        // what it downloaded.
        manager.removeDownload(row.id, { keepFiles: true });
        return { removed: true, id: row.id, filesKept: true };
      }
      default:
        throw Object.assign(new Error(`AiDM has no command "${cmd}"`), { code: 'unknown-command' });
    }
  }

  /**
   * The folder a download goes to when the assistant asks for one. The
   * assistant never supplies it — the app's own default is used.
   * @param {any} settings
   * @returns {string}
   */
  _defaultSavePath(settings) {
    if (!settings) return '';
    const category = settings.categoryPaths && typeof settings.categoryPaths === 'object'
      ? settings.categoryPaths
      : {};
    const fromCategory = Object.values(category).find((p) => typeof p === 'string' && p);
    const chosen = fromCategory || settings.defaultSavePath || '';
    return typeof chosen === 'string' ? chosen : '';
  }

  /**
   * The live row with that id.
   * @param {string} id
   * @returns {any}
   */
  _live(id) {
    const rows = this.manager.getAllDownloads();
    return rows.find((d) => d && d.id === id) || null;
  }

  /**
   * The row with that id, as a safe view.
   * @param {string} id
   * @returns {any}
   */
  _findRow(id) {
    const row = this._live(id);
    return row ? this._row(row) : null;
  }

  /**
   * The view of a download an assistant is allowed to see: no cookies, no
   * replay headers, no scratch state, every string cleaned.
   * @param {any} d
   * @returns {object}
   */
  _row(d) {
    if (!d || typeof d !== 'object') return {};
    const size = Number(d.totalSize) || 0;
    const downloaded = Number(d.downloaded) || 0;
    return {
      id: String(d.id || ''),
      name: sanitizeText(d.filename || d.title || '', 200),
      url: sanitizeText(d.url || '', 400),
      status: sanitizeText(d.status || '', 40),
      kind: d.isTorrent ? 'torrent' : 'http',
      size: size || null,
      downloaded,
      percent: typeof d.percent === 'number' ? Math.round(d.percent) : null,
      speed: Number(d.speed) || 0,
      eta: typeof d.eta === 'number' ? Math.round(d.eta) : null,
      folder: sanitizeText(d.savePath || d.filepath || '', 300),
      file: sanitizeText(d.filepath || '', 300),
      error: d.error ? sanitizeText(String(d.error), 300) : null,
      addedAt: d.addedAt || null,
    };
  }
}

module.exports = {
  BridgeServer,
  COMMAND_LEVELS,
  CALLS_PER_MINUTE,
};
