'use strict';
/**
 * JavaScript runtime discovery for yt-dlp's YouTube extractor.
 *
 * WHY THIS EXISTS
 * ---------------
 * YouTube signs its streams and gates them behind a JS challenge (`nsig` /
 * `sig`) plus PO-token ("proof of origin") generation. Older yt-dlp builds
 * carried a small built-in JS interpreter, so none of this was the user's
 * problem. That interpreter is gone: current builds delegate to an EXTERNAL
 * runtime and say so themselves —
 *
 *   WARNING: [youtube] No supported JavaScript runtime could be found. Only
 *   deno is enabled by default; ... YouTube extraction without a JS runtime
 *   has been deprecated, and some formats may be missing.
 *
 * AiDM used to pass no runtime at all, so every YouTube job ran in that
 * degraded mode: the JS challenge could not be solved and the GVS PO token
 * could not be minted ("Unable to fetch GVS PO Token for web client: Missing
 * required Visitor Data"), which is exactly the class of failure that shows up
 * as "Sign in to confirm you're not a bot" / missing qualities.
 *
 * This module finds a usable runtime the same way `yt-dlp.js` finds the yt-dlp
 * binary: an explicit setting wins, then AiDM's own bin dir, then PATH, then
 * the usual per-user install locations — and EVERY candidate is verified by
 * actually running `--version` before it is trusted.
 *
 * Design rules (mirrors yt-dlp.js):
 *   • Never fatal. No runtime simply means no `--js-runtimes` argument, which
 *     is the old behaviour — the app must keep working.
 *   • Windows first, argv only, no shell.
 *   • Detection is cached; `detectJsRuntime(true)` re-checks after an install.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// The runtime names yt-dlp accepts after `--js-runtimes`. Order is the
// preference order used when several are installed: deno is yt-dlp's own
// default and the best-tested, then bun, then node (ubiquitous), then quickjs.
const SUPPORTED = ['deno', 'bun', 'node', 'quickjs'];

// Runtime name → executable basename. `quickjs` ships as `qjs`.
const EXE = {
  deno: 'deno',
  bun: 'bun',
  node: 'node',
  quickjs: 'qjs',
};

function exeName(runtime) {
  const base = EXE[runtime] || runtime;
  return IS_WIN ? base + '.exe' : base;
}

/** Directory AiDM owns for its own tools (same one yt-dlp is installed into). */
function aidmBinDir() {
  if (IS_WIN) {
    if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'AiDM', 'bin');
    return null;
  }
  const base = process.env.XDG_DATA_HOME || (process.env.HOME && path.join(process.env.HOME, '.local', 'share'));
  return base ? path.join(base, 'aidm', 'bin') : null;
}

/**
 * Well-known install locations, checked when the runtime is not on PATH.
 * Only the standard per-machine/per-user spots — no directory walking.
 */
function commonDirs(runtime) {
  const dirs = [];
  if (!IS_WIN) {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin');
    if (process.env.HOME) dirs.push(path.join(process.env.HOME, '.deno', 'bin'), path.join(process.env.HOME, '.bun', 'bin'));
    return dirs;
  }
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  if (runtime === 'node') {
    dirs.push(path.join(pf, 'nodejs'), path.join(pf86, 'nodejs'));
    if (local) dirs.push(path.join(local, 'Programs', 'nodejs'));
  } else if (runtime === 'deno') {
    if (local) dirs.push(path.join(local, 'deno'), path.join(local, 'Programs', 'deno'));
    if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, '.deno', 'bin'));
  } else if (runtime === 'bun') {
    if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, '.bun', 'bin'));
    if (local) dirs.push(path.join(local, 'Programs', 'bun'));
  }
  return dirs;
}

/** Run `<bin> --version` and return the version string, or null. */
function probeVersion(binPath) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(binPath, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { finish(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} finish(null); }, 8000);
    child.stdout.on('data', (d) => { if (out.length < 4096) out += d.toString(); });
    child.stderr.on('data', (d) => { if (out.length < 4096) out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      const m = /(\d+\.\d+[\w.\-]*)/.exec(out);
      finish(m ? m[1] : (out.trim().split('\n')[0] || 'unknown'));
    });
  });
}

/**
 * Every plausible (runtime, path) pair, in preference order.
 * @param {{ explicit?: string }} [o] explicit = a user-configured path OR
 *        runtime name (`deno`) OR `name:path` pair, exactly as yt-dlp takes it.
 */
function candidates(o = {}) {
  const out = [];
  const seen = new Set();
  const add = (runtime, p) => {
    if (!runtime || !p) return;
    const key = runtime + '|' + String(p).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ runtime, path: p });
  };

  // 1. Explicit setting. Accepts "deno", "deno:C:\path\deno.exe", or a bare
  //    path (the runtime name is then inferred from the executable name).
  const explicit = String(o.explicit || process.env.AIDM_JS_RUNTIME || '').trim();
  if (explicit) {
    if (explicit.includes(':')) {
      // Careful: a bare Windows path "C:\..." also contains a colon, so only
      // treat it as name:path when the prefix is a KNOWN runtime name.
      const i = explicit.indexOf(':');
      const head = explicit.slice(0, i).toLowerCase();
      if (SUPPORTED.includes(head)) add(head, explicit.slice(i + 1));
      else add(inferRuntime(explicit), explicit);
    } else if (SUPPORTED.includes(explicit.toLowerCase())) {
      // A bare runtime name → search for it below, but try it first on PATH.
      add(explicit.toLowerCase(), exeName(explicit.toLowerCase()));
    } else {
      add(inferRuntime(explicit), explicit);
    }
  }

  for (const runtime of SUPPORTED) {
    const bin = exeName(runtime);
    // 2. AiDM's own bin dir (where a bundled/installed runtime would live).
    const dir = aidmBinDir();
    if (dir) add(runtime, path.join(dir, bin));
    // 3. PATH (bare name — the OS resolves it).
    add(runtime, bin);
    // 4. Standard install locations.
    for (const d of commonDirs(runtime)) add(runtime, path.join(d, bin));
  }
  return out;
}

function inferRuntime(p) {
  const base = path.basename(String(p || '')).toLowerCase();
  if (base.startsWith('deno')) return 'deno';
  if (base.startsWith('bun')) return 'bun';
  if (base.startsWith('qjs') || base.includes('quickjs')) return 'quickjs';
  return 'node';
}

let cache;              // { runtime, path, version } | null
let cacheMissAt = 0;
let pending = null;

/**
 * Find a working JS runtime. Cached; a MISS is cached briefly so a runtime
 * installed while AiDM runs is picked up without a restart.
 * @param {boolean} force re-check
 * @param {{ explicit?: string }} [o]
 * @returns {Promise<{runtime:string, path:string, version:string}|null>}
 */
function detectJsRuntime(force = false, o = {}) {
  const explicit = String(o.explicit || '').trim();
  if (!force && !explicit && cache) return Promise.resolve(cache);
  if (!force && !explicit && cache === null && Date.now() - cacheMissAt < 60000) return Promise.resolve(null);
  if (pending && !force) return pending;
  pending = (async () => {
    try {
      for (const c of candidates(o)) {
        // A bare name with no separator is resolved by the OS; a path must exist.
        if (/[\\/]/.test(c.path) && !fs.existsSync(c.path)) continue;
        const version = await probeVersion(c.path);
        if (version) {
          cache = { runtime: c.runtime, path: c.path, version };
          return cache;
        }
      }
      cache = null;
      cacheMissAt = Date.now();
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** yt-dlp argv for a detected runtime. Empty when there is none (old behaviour). */
function jsRuntimeArgs(rt) {
  if (!rt || !rt.runtime || !rt.path) return [];
  if (!SUPPORTED.includes(rt.runtime)) return [];
  return ['--js-runtimes', rt.runtime + ':' + rt.path];
}

/** Sync peek at the last detection result (never triggers a probe). */
function cachedJsRuntime() {
  return cache || null;
}

/** Human-readable status for Settings. */
function describeJsRuntime(rt) {
  if (!rt) return 'Not found — YouTube extraction runs in a degraded (no-JS) mode.';
  return rt.runtime + ' ' + rt.version + ' (' + rt.path + ')';
}

/** Where an installed runtime would be looked for first. */
function installDir() {
  return aidmBinDir();
}

module.exports = {
  SUPPORTED,
  detectJsRuntime,
  cachedJsRuntime,
  jsRuntimeArgs,
  describeJsRuntime,
  inferRuntime,
  candidates,
  installDir,
};
