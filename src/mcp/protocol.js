// @ts-check
'use strict';

/**
 * The wire format of AiDM's MCP server.
 *
 * MCP over stdio is JSON-RPC 2.0 with one JSON object per line. This module
 * owns the framing and the error codes, and nothing else: it never touches
 * the app, so the protocol can be tested on its own.
 *
 * Protocol version: the client states its version in `initialize` and the
 * server answers with the same one when it is known, or with the newest one
 * this build speaks. (The 2024-11-05 shape is accepted because that is what
 * the MCP SDKs shipped in 2024 still send.)
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 error codes, plus the MCP additions we need. */
const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/** A single stdio message may not be bigger than this. */
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Encode one JSON-RPC message as a single line.
 * @param {unknown} message
 * @returns {string}
 */
function encodeMessage(message) {
  return JSON.stringify(message);
}

/**
 * Parse one line into a JSON-RPC message.
 * @param {string} line
 * @returns {{ ok: true, message: any } | { ok: false, error: string, code: number }}
 */
function parseMessage(line) {
  const text = String(line == null ? '' : line).trim();
  if (!text) return { ok: false, error: 'empty message', code: ERROR_CODES.PARSE_ERROR };
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
    return { ok: false, error: 'message too large', code: ERROR_CODES.INVALID_REQUEST };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'not valid JSON', code: ERROR_CODES.PARSE_ERROR };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not a JSON-RPC message', code: ERROR_CODES.INVALID_REQUEST };
  }
  if (typeof parsed.method !== 'string') {
    return { ok: false, error: 'missing method', code: ERROR_CODES.INVALID_REQUEST };
  }
  return { ok: true, message: parsed };
}

/**
 * A successful response.
 * @param {string|number|null} id
 * @param {unknown} result
 * @returns {object}
 */
function okResponse(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

/**
 * A failed response.
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {object}
 */
function errorResponse(id, code, message, data) {
  const error = { code, message: String(message || 'error') };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

/**
 * A notification (no id, no answer expected).
 * @param {string} method
 * @param {unknown} [params]
 * @returns {object}
 */
function notification(method, params) {
  const out = { jsonrpc: '2.0', method };
  if (params !== undefined) out.params = params;
  return out;
}

/**
 * Pick the protocol version to answer with: the client's when we know it,
 * otherwise the newest this build speaks.
 * @param {unknown} requested
 * @returns {string}
 */
function negotiateProtocolVersion(requested) {
  const wanted = String(requested == null ? '' : requested);
  if (PROTOCOL_VERSIONS.includes(wanted)) return wanted;
  return LATEST_PROTOCOL_VERSION;
}

module.exports = {
  PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  ERROR_CODES,
  MAX_MESSAGE_BYTES,
  encodeMessage,
  parseMessage,
  okResponse,
  errorResponse,
  notification,
  negotiateProtocolVersion,
};
