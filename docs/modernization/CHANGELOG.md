# Changelog — modernization cycles

## Cycle 1 — v5.3.3 → v5.4.0 (2026-10-25)

Baseline before work: `npm test` → **67/67 suites, 84.1s**, clean tree at v5.3.3.
After: **73/73 suites, 103.1s** (6 new suites, no regressions).

### Added

| Area | Change | Files |
|---|---|---|
| Archive auto-extract | Dependency-free ZIP reader (central directory + `zlib.inflateRawSync`, Zip64, CRC-verified), zip-slip and symlink hardening, entry/byte caps; wired into the completion pipeline before the post-download command | `src/archive-extract.js` (new), `src/download-manager.js`, `ui/index.html`, `ui/app.js`, `ui/styles.css` |
| CLI intake | `AiDM.exe <url>…`, `--add-file`, `--hidden`, `--minimized`, `--version`, `--help`; second-instance forwards its argv to the running app; dispatch reuses `IPCServer.addUrl()` so resolvers apply | `src/cli.js` (new), `main.js`, `src/server.js`, `preload.js` |
| Sleep inhibition | Suspension blocker held exactly while transfers are live or a scheduler session runs; released on idle and on quit | `src/keep-awake.js` (new), `main.js`, `src/download-manager.js`, `ui/` |
| Site grabber | Recursive same-origin crawler with depth/page/file/time caps, robots.txt, off-site file flagging, progress events; UI overlay that queues through `batchUrls` | `src/site-grabber.js` (new), `main.js`, `preload.js`, `ui/index.html`, `ui/app.js`, `ui/styles.css` |
| Checksum | Algorithm inference from digest length, tolerant parsing (`sha256:`, `SHA-256 `, `0x`, grouped, uppercase), hard error on wrong-length digests | `src/engine/checksum.js` |

### Changed

- `IPCServer` gained a public `addUrl()` so non-HTTP callers (CLI, second launch) share
  the exact routing of `POST /api/download` instead of duplicating it.
- `DownloadManager._finishRow()` chain is now
  `probeMedia → _ensureAudio → _maybeAiSummarize → _maybeAutoExtract → _runPostDownloadAction`.
- Version bumped to **5.4.0** in `package.json` and `chrome-extension/manifest.json`
  (kept in sync — guarded by `test/extension-dimensions.js`).

### New settings

| Key | Default | Meaning |
|---|---|---|
| `autoExtract` | `false` | Unpack finished ZIPs beside the archive |
| `autoExtractDelete` | `false` | Remove the archive after a fully clean extraction |
| `preventSleep` | `true` | Hold the suspension blocker during transfers |

### Tests added

| Suite | Checks | Focus |
|---|---|---|
| `test/archive-extract.js` | 49 | Format sniffing, zip-slip/UNC/symlink/CRC attacks, caps, collisions |
| `test/auto-extract.js` | 19 | Real HTTP download → real completion chain → files on disk |
| `test/cli.js` | 60 | argv parsing, list files, scheme allowlist, `addUrl` delegation |
| `test/keep-awake.js` | 52 | Policy truth table, blocker idempotence, release safety |
| `test/checksum.js` | 56 | Inference, tolerant forms, length errors, real-file verification |
| `test/site-grabber.js` | 96 | Link extraction, robots rules, live crawl, caps, wiring guards |
| `test/_zip-fixture.js` | — | Shared real-ZIP writer (underscore = not a suite) |

### Built

- `npm run dist` → `dist/AiDM-Setup-5.4.0.exe` (104,995,225 B) + blockmap, 2m12s, exit 0.
- `node tools/refresh-latest-yml.js` → recomputed sha512 matches the installer;
  `latest.yml` describes 5.4.0 with a fresh `releaseDate`.
- Packaged content verified by parsing `app.asar`: all four new modules present and
  byte-identical to the working tree; packed `package.json` reports 5.4.0.
- Packaged runtime verified: `--version` → 5.4.0; cold-start URL intake; second-instance
  argv forwarding into a running instance.

### Not done (recorded, not hidden)

- **Not installed** over the existing copy (an installed v5.3.2 was running during the
  build and was left untouched), so elevation/shortcut/uninstall behaviour is untested
  for 5.4.0.
- Queue-scoped scheduling, app-aware throttling, portable mode, winget/scoop manifests,
  auto-purge of completed rows: deferred to cycle 2 (see `MODERNIZATION_ROADMAP.md`).
