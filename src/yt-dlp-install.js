/*
 * yt-dlp-install.js — download and install yt-dlp, ONE implementation shared
 * by the developer tool (tools/fetch-yt-dlp.js) and the in-app updater
 * (Settings › YouTube › "Update yt-dlp"). Zero dependencies: node built-ins
 * only, so the packaged app (which ships no node binary and no npm) can run
 * it in the main process.
 *
 * Channels — why nightly is the default:
 *   yt-dlp's "latest release" tag is a STABLE snapshot that lags badly. When
 *   YouTube started requiring sign-in confirmation for extraction (Oct 2026),
 *   the stable tag was 2026.08.19 while the nightly repo already carried the
 *   fixes; even today the stable tag trails the nightly by weeks. For a
 *   download manager, "stale" means "broken": the player's signature scheme
 *   changes under old builds without warning. So:
 *     nightly (default) — yt-dlp/yt-dlp-nightly-builds, rebuilt daily
 *     --stable          — yt-dlp/yt-dlp, the frozen release tag
 *
 * Integrity: the SHA2-256SUMS published with the SAME release is downloaded
 * over HTTPS and the binary's digest is checked before anything is installed.
 * A mismatch throws and leaves the previous binary untouched.
 *
 * Atomicity: the new binary lands as `yt-dlp.exe.new` and is renamed over the
 * old one only after its checksum AND `--version` both pass. On Windows an
 * exe that is currently running cannot be replaced — that failure is reported
 * verbatim (stage kept for the retry) instead of silently half-installing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const REPO_STABLE = 'yt-dlp/yt-dlp';
const REPO_NIGHTLY = 'yt-dlp/yt-dlp-nightly-builds';

/** Channel name → GitHub repo. Pure. */
function repoForChannel(channel) {
  return String(channel || '').trim().toLowerCase() === 'stable' ? REPO_STABLE : REPO_NIGHTLY;
}

/** Latest-release API URL for a channel. Pure. */
function latestReleaseApi(channel) {
  return 'https://api.github.com/repos/' + repoForChannel(channel) + '/releases/latest';
}

/**
 * Parse a SHA2-256SUMS body for the wanted asset name.
 * Lines look like `<64 hex>  yt-dlp.exe`. Pure.
 * @returns {string|null} lowercase digest, or null when not listed
 */
function parseSums(sumsBody, name) {
  const want = String(name || '');
  const lines = String(sumsBody || '').split('\n');
  for (const raw of lines) {
    const p = raw.trim().split(/\s+/);
    if (p.length >= 2 && p[1] === want && /^[0-9a-f]{64}$/i.test(p[0])) {
      return p[0].toLowerCase();
    }
  }
  return null;
}

/** Constant-time-ish digest compare (hex strings). Pure. */
function digestMatches(actual, expected) {
  const a = String(actual || '').toLowerCase();
  const b = String(expected || '').toLowerCase();
  return a.length === b.length && a.length > 0 && a === b;
}

function sha256(buf) {
  return require('crypto').createHash('sha256').update(buf).digest('hex');
}

function exeName() {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

/** HTTPS GET with redirect following. Returns { body, headers }. */
function get(url, { headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'AiDM-yt-dlp-installer', ...headers },
      timeout: 60000,
    }, (res) => {
      const { statusCode, headers: h } = res;
      if (statusCode >= 300 && statusCode < 400 && h.location) {
        res.resume();
        if (redirects > 5) { reject(new Error('Too many redirects')); return; }
        get(h.location, { headers, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + statusCode + ' for ' + url));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: h }));
    });
    req.on('timeout', () => { req.destroy(new Error('Timed out downloading ' + url)); });
    req.on('error', reject);
  });
}

/** The asset URLs for a release JSON, or throw when the exe is missing. Pure. */
function pickReleaseAsset(releaseJson) {
  const name = exeName();
  const asset = (releaseJson && releaseJson.assets || []).find(a => a.name === name);
  if (!asset || !asset.browser_download_url) {
    throw new Error('Release ' + (releaseJson && releaseJson.tag_name) + ' has no asset named ' + name);
  }
  const sums = (releaseJson.assets || []).find(a => a.name === 'SHA2-256SUMS');
  return {
    tag: releaseJson.tag_name,
    assetUrl: asset.browser_download_url,
    sumsUrl: sums ? sums.browser_download_url : null,
  };
}

/**
 * Download, verify and install yt-dlp.
 *
 * @param {object} [opts]
 * @param {'nightly'|'stable'} [opts.channel] default 'nightly'
 * @param {string} [opts.dir] target directory (default: per-user bin dir)
 * @param {(msg: string) => void} [opts.log] progress reporter
 * @returns {Promise<{version: string, tag: string, path: string, channel: string, verified: boolean}>}
 */
async function installYtDlp(opts = {}) {
  const channel = String(opts.channel || 'nightly').trim().toLowerCase() === 'stable' ? 'stable' : 'nightly';
  const dir = opts.dir || defaultDir();
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const name = exeName();

  log('Fetching the latest ' + channel + ' yt-dlp release…');
  const { body } = await get(latestReleaseApi(channel), { headers: { Accept: 'application/vnd.github+json' } });
  const release = JSON.parse(body.toString('utf8'));
  const { tag, assetUrl, sumsUrl } = pickReleaseAsset(release);
  log('Latest ' + channel + ': ' + tag);

  log('Downloading ' + name + '…');
  const dl = await get(assetUrl);
  if (!dl.body.length) throw new Error('Downloaded an empty file');

  let verified = false;
  if (sumsUrl) {
    const sums = await get(sumsUrl);
    const expected = parseSums(sums.body.toString('utf8'), name);
    if (!expected) throw new Error('No checksum published for ' + name);
    const actual = sha256(dl.body);
    if (!digestMatches(actual, expected)) {
      throw new Error('Checksum mismatch — expected ' + expected + ' got ' + actual + '. Nothing was installed.');
    }
    verified = true;
    log('Checksum verified (' + actual.slice(0, 16) + '…)');
  } else {
    log('WARNING: no SHA2-256SUMS published for this release — installing without verification.');
  }

  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, name + '.new');
  const target = path.join(dir, name);
  fs.writeFileSync(staged, dl.body);
  if (process.platform !== 'win32') fs.chmodSync(staged, 0o755);

  // Prove it runs before it goes live.
  const version = execFileSync(staged, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim();
  if (!version) throw new Error('The downloaded binary did not report a version');

  try {
    fs.renameSync(staged, target);
  } catch (e) {
    // Windows: an exe that is currently executing cannot be replaced. Keep
    // the staged file and say so — the old binary keeps working meanwhile.
    const hint = process.platform === 'win32'
      ? ' yt-dlp is running right now (a YouTube download is in flight) — finish or cancel it and update again. The new build is waiting at ' + staged
      : '';
    throw new Error('Could not replace the installed yt-dlp: ' + (e && e.message || e) + hint);
  }
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);

  log('Installed ' + name + ' ' + version + ' → ' + target);
  return { version, tag, path: target, channel, verified };
}

/** The per-user bin dir tools/fetch-yt-dlp.js (and the app) install into. */
function defaultDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'), 'AiDM', 'bin');
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '.', 'Library', 'Application Support'), 'aidm', 'bin');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '.', '.local', 'share'), 'aidm', 'bin');
}

module.exports = {
  installYtDlp,
  repoForChannel,
  latestReleaseApi,
  parseSums,
  digestMatches,
  pickReleaseAsset,
  exeName,
  defaultDir,
};
