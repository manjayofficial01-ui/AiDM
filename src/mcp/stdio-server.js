// @ts-check
'use strict';

/**
 * The MCP server AiDM speaks over stdio.
 *
 * This is the half an assistant actually talks to. It reads JSON-RPC 2.0
 * messages (one JSON object per line) from standard input and answers on
 * standard output. It owns:
 *
 *   - the MCP handshake and the tools/call round trip,
 *   - the access level this connection runs at,
 *   - the argument checks, so a malformed request never reaches the app,
 *   - the answer shape an assistant reads (text plus a machine-readable
 *     copy).
 *
 * The heavy lifting happens in the bridge, inside the app; this module is
 * the protocol, nothing else.
 */

const {
  ERROR_CODES,
  encodeMessage,
  parseMessage,
  okResponse,
  errorResponse,
  notification,
  negotiateProtocolVersion,
  LATEST_PROTOCOL_VERSION,
} = require('./protocol');
const { findTool, toolCatalog, toolDescriptor, ToolInputError } = require('./tools');
const { levelAllows, sanitizeText } = require('./safety');

/**
 * Build the answer to a tool call.
 * @param {string} name
 * @param {any} rawArgs
 * @param {{ level: string, call: (cmd: string, args?: any) => Promise<any> }} ctx
 * @returns {Promise<object>}
 */
async function runTool(name, rawArgs, ctx) {
  const tool = findTool(name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `AiDM has no tool called "${String(name).slice(0, 60)}".` }],
      isError: true,
    };
  }
  if (!levelAllows(ctx.level, tool.level)) {
    return {
      content: [{
        type: 'text',
        text: `The "${tool.name}" tool needs the "${tool.level}" access level. This connection runs at "${ctx.level}".`,
      }],
      isError: true,
    };
  }
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  let built;
  try {
    built = tool.build(args);
  } catch (e) {
    if (e instanceof ToolInputError) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
    throw e;
  }
  const result = await ctx.call(tool.command, built);
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return {
    content: [{ type: 'text', text: sanitizeText(text, 20000) }],
    structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : undefined,
  };
}

/**
 * Create the stdio MCP server.
 * @param {{
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   level?: string,
 *   call: (cmd: string, args?: any) => Promise<any>,
 *   onError?: (err: Error) => void,
 * }} options
 */
function createStdioServer(options) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const level = options.level || 'look';
  const call = options.call;

  /** @type {string} */
  let buffer = '';
  let initialized = false;

  const send = (message) => {
    try {
      output.write(encodeMessage(message) + '\n');
    } catch (e) {
      if (options.onError) options.onError(e);
    }
  };

  const handle = async (message) => {
    const id = message.id === undefined ? null : message.id;
    const method = String(message.method || '');

    switch (method) {
      case 'initialize': {
        initialized = true;
        const params = message.params && typeof message.params === 'object' ? message.params : {};
        return okResponse(id, {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aidm', version: '1.0.0' },
          instructions:
            'AiDM is a download manager. Use list_downloads to see the list, add_download to start a ' +
            'download, and pause_download / resume_download / cancel_download to steer one. ' +
            'Downloads are saved to the folder the user configured — you cannot choose a folder, ' +
            'and nothing you ask for will delete a file.',
        });
      }
      case 'notifications/initialized':
      case 'initialized':
        return null;                                  // a notification: no answer
      case 'ping':
        return okResponse(id, {});
      case 'tools/list':
        return okResponse(id, { tools: toolCatalog(level).map(toolDescriptor) });
      case 'tools/call': {
        const params = message.params && typeof message.params === 'object' ? message.params : {};
        const name = String(params.name || '');
        try {
          const result = await runTool(name, params.arguments, { level, call });
          return okResponse(id, result);
        } catch (e) {
          return okResponse(id, {
            content: [{ type: 'text', text: sanitizeText((e && e.message) || 'the tool failed', 500) }],
            isError: true,
          });
        }
      }
      case 'resources/list':
        return okResponse(id, { resources: [] });
      case 'resources/templates/list':
        return okResponse(id, { resourceTemplates: [] });
      case 'prompts/list':
        return okResponse(id, { prompts: [] });
      case 'logging/setLevel':
        return okResponse(id, {});
      case 'shutdown':
        return okResponse(id, {});
      default:
        if (method.startsWith('notifications/')) return null;
        return errorResponse(id, ERROR_CODES.METHOD_NOT_FOUND, `AiDM does not answer "${method}".`);
    }
  };

  input.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 1024 * 1024) {
      buffer = '';
      send(errorResponse(null, ERROR_CODES.INVALID_REQUEST, 'message too large'));
      return;
    }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const parsed = parseMessage(line);
      if (!parsed.ok) {
        send(errorResponse(null, parsed.code, parsed.error));
        continue;
      }
      Promise.resolve(handle(parsed.message))
        .then((response) => {
          if (response) send(response);
        })
        .catch((err) => {
          const id = parsed.message.id === undefined ? null : parsed.message.id;
          send(errorResponse(id, ERROR_CODES.INTERNAL_ERROR, (err && err.message) || 'internal error'));
        });
    }
  });

  input.on('end', () => {
    if (options.onError) options.onError(new Error('the client closed the connection'));
  });

  return {
    level,
    get initialized() { return initialized; },
    /** The protocol version this build speaks. */
    protocolVersion: LATEST_PROTOCOL_VERSION,
  };
}

module.exports = { createStdioServer, runTool };
