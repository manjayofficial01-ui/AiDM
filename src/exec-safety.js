'use strict';

/**
 * Execution safety for the post-download command hook.
 *
 * The hook runs a user-configured executable on a finished file. A finished
 * file can carry ANY name the server chose (Content-Disposition), so the
 * executable must never be something that *interprets* its argument — a shell
 * or a script host would run attacker-chosen code.
 *
 * This module is the single source of truth for that decision. It lives apart
 * from the manager so the rule can be unit-tested without booting Electron.
 */

const path = require('path');

/**
 * Interpreters that execute an argument by association.
 *
 * `spawn("cmd.exe", ["…\\evil.bat"])` runs the batch file;
 * `spawn("powershell.exe", ["-File", "…\\evil.ps1"])` runs the script. The
 * hook exists for DIRECT tools (an antivirus scanner that takes a file path
 * as data), so every interpreter family is refused.
 */
const INTERPRETER_NAMES = new Set([
  // Windows shells
  'cmd', 'command', 'cmd32', 'cmd64', 'powershell', 'powershell_ise', 'pwsh',
  // POSIX shells / WSL
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'busybox', 'wsl',
  // Windows script hosts
  'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'wmic', 'msiexec',
  'forfiles', 'reg', 'ovpncmd',
  // Language runtimes
  'python', 'python3', 'pythonw', 'py', 'node', 'nodejs', 'deno', 'bun',
  'perl', 'ruby', 'php', 'java', 'javaw', 'jscript', 'vbs', 'vbscript',
  'pws', 'script', 'dotnet', 'msbuild', 'nuget',
  // Fetchers that take a URL (a remote payload is still code)
  'curl', 'wget', 'bitsadmin', 'certutil', 'bits',
]);

/**
 * Script file extensions. Running one IS executing code, whatever the host
 * is — a `.bat` passed to `spawn` runs directly on Windows.
 */
const SCRIPT_EXTENSIONS = new Set([
  '.bat', '.cmd', '.com', '.ps1', '.psm1', '.psd1', '.vbs', '.vbe', '.js',
  '.jse', '.wsf', '.wsh', '.hta', '.py', '.pyw', '.pl', '.pm', '.rb', '.sh',
  '.bash', '.zsh', '.ksh', '.csh', '.fish', '.command', '.lnk', '.msc', '.reg',
  '.inf', '.sct', '.application', '.appx', '.msi',
]);

/**
 * Is this executable a shell or script interpreter?
 *
 * The base name is compared case-insensitively, with or without an
 * extension. A script file extension is refused on its own — the file IS the
 * program.
 *
 * @param {string} exe path or command name
 * @returns {boolean}
 */
function isInterpreterExe(exe) {
  const raw = String(exe == null ? '' : exe).trim();
  if (!raw) return false;
  const base = path.basename(raw).toLowerCase();
  if (!base) return false;
  // A script file is code whatever it is named.
  if (SCRIPT_EXTENSIONS.has(path.extname(base))) return true;
  const stem = base.replace(/\.(exe|com|bat|cmd)$/, '');
  return INTERPRETER_NAMES.has(base) || INTERPRETER_NAMES.has(stem);
}

/**
 * A short, human-readable reason for the refusal — shown on the row so the
 * user knows WHY their hook did not run.
 * @param {string} exe
 * @returns {string}
 */
function interpreterRefusalReason(exe) {
  const base = path.basename(String(exe == null ? '' : exe)).toLowerCase();
  return 'Refused: the post-download command may not be a shell or script interpreter (' +
    `${base}) — a downloaded file could carry an attacker-chosen name.`;
}

module.exports = {
  isInterpreterExe,
  interpreterRefusalReason,
  INTERPRETER_NAMES,
  SCRIPT_EXTENSIONS,
};
