// @ts-check
/**
 * Session cookie vault — restores authenticated rows after a restart.
 *
 * Cookies are live credentials: they are NEVER written into
 * `.aidm_downloads.json`. When Electron `safeStorage` is available (Windows
 * DPAPI / macOS Keychain), the vault encrypts them into a sidecar file so
 * `needsSession` rows can auto-resume instead of sitting 403-forever.
 *
 * Without safeStorage the vault is a no-op: callers keep the old behavior
 * (cookies live only for the process lifetime).
 *
 * Fail-open everywhere: a corrupt vault or decrypt failure returns null and
 * the row simply stays paused.
 */

const fs = require('fs');
const path = require('path');

const VAULT_NAME = '.aidm_session_vault.json';
const VAULT_VERSION = 1;

/**
 * @param {{ encrypt: (s: string) => Buffer, decrypt: (b: Buffer) => string, isEncryptionAvailable: () => boolean }} [safe]
 * @param {string} [dir] directory for the vault file (defaults to $HOME)
 */
function createSessionVault(safe, dir) {
  const baseDir = dir || (process.env.USERPROFILE || process.env.HOME || '');
  const vaultPath = path.join(baseDir, VAULT_NAME);

  function available() {
    try {
      return !!(safe && typeof safe.encrypt === 'function' && typeof safe.decrypt === 'function' &&
        (!safe.isEncryptionAvailable || safe.isEncryptionAvailable()));
    } catch (e) {
      return false;
    }
  }

  function readVault() {
    try {
      if (!fs.existsSync(vaultPath)) return { version: VAULT_VERSION, entries: {} };
      const raw = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || !raw.entries) return { version: VAULT_VERSION, entries: {} };
      return raw;
    } catch (e) {
      return { version: VAULT_VERSION, entries: {} };
    }
  }

  function writeVault(vault) {
    try {
      const tmp = vaultPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(vault));
      fs.renameSync(tmp, vaultPath);
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    path: vaultPath,
    available,

    /**
     * Remember cookies for a download id (overwrites prior entry).
     * @param {string} id
     * @param {string|null} cookies
     */
    save(id, cookies) {
      if (!available() || !id) return false;
      const vault = readVault();
      if (!cookies) {
        delete vault.entries[id];
        return writeVault(vault);
      }
      try {
        const box = safe.encrypt(String(cookies));
        vault.entries[id] = {
          box: Buffer.from(box).toString('base64'),
          savedAt: Date.now(),
        };
        return writeVault(vault);
      } catch (e) {
        return false;
      }
    },

    /**
     * @param {string} id
     * @returns {string|null} decrypted cookies, or null
     */
    load(id) {
      if (!available() || !id) return null;
      try {
        const vault = readVault();
        const entry = vault.entries[id];
        if (!entry || !entry.box) return null;
        return safe.decrypt(Buffer.from(entry.box, 'base64'));
      } catch (e) {
        return null;
      }
    },

    forget(id) {
      if (!available() || !id) return false;
      const vault = readVault();
      if (!(id in vault.entries)) return true;
      delete vault.entries[id];
      return writeVault(vault);
    },

    /** Drop entries older than maxAgeMs (default 7 days). */
    prune(maxAgeMs = 7 * 24 * 3600 * 1000) {
      if (!available()) return 0;
      const vault = readVault();
      const now = Date.now();
      let dropped = 0;
      for (const [id, entry] of Object.entries(vault.entries)) {
        if (!entry || !entry.savedAt || now - entry.savedAt > maxAgeMs) {
          delete vault.entries[id];
          dropped++;
        }
      }
      if (dropped) writeVault(vault);
      return dropped;
    },
  };
}

module.exports = { createSessionVault, VAULT_NAME };
