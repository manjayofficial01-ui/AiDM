// @ts-check
'use strict';

/**
 * The tools AiDM exposes to an MCP client.
 *
 * Each tool is a promise to an assistant: "you may ask for this, and this is
 * what you get back". The descriptions are therefore written for a model,
 * not for a human: they say what the tool does, when to use it, and what it
 * will NOT do (an assistant that guesses wrong here is the whole risk).
 *
 * Three rules shape the list:
 *
 *   - A tool never deletes a file. `remove_download` takes the ROW off the
 *     list and leaves the file on disk.
 *   - A tool never chooses a folder. The save path is the app's own default.
 *   - Every tool declares the access level it needs. The bridge enforces it.
 *
 * The handlers here validate the arguments and then hand a command to the
 * bridge, which runs inside the app. Nothing in this file touches the disk
 * or the network.
 */

const { sanitizeFileName, sanitizeText, LEVEL_RANK } = require('./safety');

/** Thrown when the arguments an assistant sent do not fit the tool. */
class ToolInputError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** A download id as AiDM writes it (a uuid). */
const ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

/**
 * Read a string argument.
 * @param {any} args
 * @param {string} key
 * @param {{ required?: boolean, max?: number }} [opts]
 * @returns {string|undefined}
 */
function readString(args, key, opts = {}) {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (opts.required) throw new ToolInputError(`"${key}" is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string`);
  const text = value.trim();
  if (!text) {
    if (opts.required) throw new ToolInputError(`"${key}" is required`);
    return undefined;
  }
  const max = opts.max || 2048;
  if (text.length > max) throw new ToolInputError(`"${key}" is longer than ${max} characters`);
  return text;
}

/**
 * Read a boolean argument.
 * @param {any} args
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
function readBoolean(args, key, fallback) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ToolInputError(`"${key}" must be true or false`);
}

/**
 * Read a bounded number argument.
 * @param {any} args
 * @param {string} key
 * @param {{ fallback: number, min: number, max: number }} opts
 * @returns {number}
 */
function readNumber(args, key, opts) {
  const value = args[key];
  if (value === undefined || value === null || value === '') return opts.fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ToolInputError(`"${key}" must be a number`);
  if (n < opts.min || n > opts.max) {
    throw new ToolInputError(`"${key}" must be between ${opts.min} and ${opts.max}`);
  }
  return Math.floor(n);
}

/**
 * Read a download id.
 * @param {any} args
 * @returns {string}
 */
function readId(args) {
  const id = readString(args, 'id', { required: true, max: 64 });
  if (!ID_PATTERN.test(id)) throw new ToolInputError('"id" is not a download id');
  return id;
}

/**
 * The tool catalog. `level` is the access level a connection needs; `command`
 * is what the bridge is asked to do.
 * @type {Array<{ name: string, level: string, command: string, description: string, inputSchema: object, build: (args: any) => object }>}
 */
const TOOLS = [
  {
    name: 'list_downloads',
    level: 'look',
    command: 'list_downloads',
    description:
      'List the downloads AiDM knows about, newest first. Each row carries its id, file name, ' +
      'address, status, size, how much is done and the current speed. Use "status" to filter ' +
      '(queued, downloading, paused, completed, error) and "text" to match names or addresses. ' +
      'This tool only reads the list — it never changes anything.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['queued', 'downloading', 'paused', 'completed', 'error', 'all'],
          description: 'Only rows in this state. Omit for every row.',
        },
        text: {
          type: 'string',
          description: 'Only rows whose name or address contains this text.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          description: 'How many rows to return at most (default 50).',
        },
      },
      additionalProperties: false,
    },
    build: (args) => {
      const out = {};
      const status = readString(args, 'status', { max: 20 });
      if (status && status !== 'all') out.status = status.toLowerCase();
      const text = readString(args, 'text', { max: 200 });
      if (text) out.text = sanitizeText(text, 200);
      out.limit = readNumber(args, 'limit', { fallback: 50, min: 1, max: 200 });
      return out;
    },
  },
  {
    name: 'get_download',
    level: 'look',
    command: 'get_download',
    description:
      'Show one download in full: its id, name, address, status, size, progress, speed, ' +
      'target folder and the last error. Use list_downloads to find an id first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The download id.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    build: (args) => ({ id: readId(args) }),
  },
  {
    name: 'get_status',
    level: 'look',
    command: 'get_status',
    description:
      'A one-glance summary of AiDM: how many downloads are running, queued, paused, ' +
      'finished or failed, and whether the download queue is paused.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({}),
  },
  {
    name: 'get_audit_log',
    level: 'look',
    command: 'audit_log',
    description:
      'Read the audit log: what an AI assistant asked AiDM to do, and what happened. ' +
      'Useful when a user asks "what did you just download?" or "did something else ' +
      'control my downloads?".',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          description: 'How many of the newest entries to return (default 50).',
        },
      },
      additionalProperties: false,
    },
    build: (args) => ({ limit: readNumber(args, 'limit', { fallback: 50, min: 1, max: 200 }) }),
  },
  {
    name: 'add_download',
    level: 'standard',
    command: 'add_download',
    description:
      'Queue a download. Give an http, https or ftp address; AiDM works out the file name ' +
      'and the folder itself (the assistant may suggest a name, never a folder). Set ' +
      '"start" to false to add it to the list without starting it. A magnet link is not ' +
      'accepted here — use the app for those.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http, https or ftp address to download.' },
        filename: {
          type: 'string',
          description: 'Optional file name. Never a path — AiDM ignores any folder in it.',
        },
        start: {
          type: 'boolean',
          description: 'Start the download now (default true). False queues it.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    build: (args) => {
      const out = { url: readString(args, 'url', { required: true, max: 4096 }) };
      const filename = sanitizeFileName(readString(args, 'filename', { max: 200 }));
      if (filename) out.filename = filename;
      out.start = readBoolean(args, 'start', true);
      return out;
    },
  },
  {
    name: 'probe_link',
    level: 'standard',
    command: 'probe_link',
    description:
      'Look at a link before downloading it: does the server answer, how big is the file, ' +
      'what is its name and type, can it be resumed. Nothing is downloaded.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The address to look at.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    build: (args) => ({ url: readString(args, 'url', { required: true, max: 4096 }) }),
  },
  {
    name: 'pause_download',
    level: 'standard',
    command: 'pause_download',
    description: 'Pause one download. Its partial file is kept so it can resume later.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The download id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    build: (args) => ({ id: readId(args) }),
  },
  {
    name: 'resume_download',
    level: 'standard',
    command: 'resume_download',
    description: 'Resume a paused, queued or failed download.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The download id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    build: (args) => ({ id: readId(args) }),
  },
  {
    name: 'cancel_download',
    level: 'standard',
    command: 'cancel_download',
    description:
      'Cancel one running download. The partial file is left on disk so it can be resumed ' +
      'later; nothing is deleted.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The download id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    build: (args) => ({ id: readId(args) }),
  },
  {
    name: 'start_queue',
    level: 'standard',
    command: 'start_queue',
    description: 'Start the download queue, so queued downloads begin.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({}),
  },
  {
    name: 'pause_queue',
    level: 'standard',
    command: 'pause_queue',
    description:
      'Pause the whole queue: nothing new starts, and running downloads keep running. ' +
      'Use pause_download to stop a single download.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({}),
  },
  {
    name: 'remove_download',
    level: 'full',
    command: 'remove_download',
    description:
      'Take one download off the list. The FILE IS KEPT — this never deletes anything on ' +
      'disk, and the assistant cannot ask for that.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The download id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    build: (args) => ({ id: readId(args) }),
  },
];

/** Tool names, for a quick lookup. */
const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * Find a tool by name.
 * @param {string} name
 * @returns {typeof TOOLS[number]|undefined}
 */
function findTool(name) {
  const wanted = String(name || '').trim();
  return TOOLS.find((t) => t.name === wanted);
}

/**
 * The tools a connection at `level` may see and use. A tool the connection
 * may not use is not even advertised — an assistant should not be offered a
 * button it will be refused.
 * @param {string} level
 * @returns {typeof TOOLS}
 */
function toolCatalog(level) {
  const rank = LEVEL_RANK[level] === undefined ? 1 : LEVEL_RANK[level];
  return TOOLS.filter((t) => LEVEL_RANK[t.level] <= rank);
}

/**
 * The MCP wire shape of a tool.
 * @param {typeof TOOLS[number]} tool
 * @returns {object}
 */
function toolDescriptor(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

module.exports = {
  TOOLS,
  TOOL_NAMES,
  ToolInputError,
  findTool,
  toolCatalog,
  toolDescriptor,
  readString,
  readBoolean,
  readNumber,
  readId,
  ID_PATTERN,
};
