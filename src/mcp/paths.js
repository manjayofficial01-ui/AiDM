// @ts-check
'use strict';

/**
 * Where AiDM keeps the files the MCP server needs: the connection file that
 * points an assistant at the running app, and the audit log.
 *
 * The layout follows the rest of the app (see `logsDir` in
 * src/download-manager.js): `%LOCALAPPDATA%\AiDM` on Windows, and the same
 * shape under the user's home elsewhere.
 */

const path = require('path');

/**
 * The app's own data folder.
 * @returns {string}
 */
function appDataDir() {
  const base = process.env.LOCALAPPDATA
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'AppData', 'Local');
  return path.join(base, process.platform === 'win32' ? 'AiDM' : 'aidm');
}

/**
 * The folder that holds the app's logs.
 * @returns {string}
 */
function logDir() {
  return path.join(appDataDir(), 'logs');
}

/**
 * The file the MCP server writes so a client can find the running app.
 * @returns {string}
 */
function bridgeFile() {
  return path.join(appDataDir(), 'mcp-bridge.json');
}

/**
 * The audit log of everything an assistant asked the app to do.
 * @returns {string}
 */
function auditLogFile() {
  return path.join(logDir(), 'mcp-audit.log');
}

module.exports = {
  appDataDir,
  logDir,
  bridgeFile,
  auditLogFile,
};
