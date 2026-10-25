# Changelog — modernization cycles

## Cycle 2 — v5.4.0 → v5.5.0 (2026-10-25)

Baseline before work: `npm test` → **74/73→73/73 suites** (re-measured 73/73 in
63.5s on the untouched v5.4.0 tree). After: **74/74 suites in 66.4s**
(one new suite; no regressions).

### Security (the headline of this cycle)

| Change | Why | Evidence |
|---|---|---|
| **Electron 28.3.3 → 45.0.0** (17 majors) + electron-builder 26.15.3 → 26.18.0 | 28.3.3 carries ~21 known high advisories; directly relevant here: `shell.openPath` null-byte bypass (AiDM opens download folders), Windows registry key injection in `app.setAsDefaultProtocolClient` (protocol registration), use-after-free in the download **save dialog** (AiDM's own flow), ASAR integrity bypass, `setLoginItemSettings` unquoted-path (AiDM calls it at main.js:83) | `npm audit` before/after; full suite green on 45; offscreen render check green |
| `uuid` 9.0.1 → 11.1.1 | GHSA-w5hq-g745-h8pq (moderate). AiDM only uses `v4` (advisory affects v3/v5/v6 with `buf`), so impact was nil — bumped anyway to clear the flag; `require('uuid').v4` API unchanged | `require('uuid').v4()` verified |
| `ip-address` override → 10.7.5 | GHSA-rxp7-6hxx-x8q5 (quadratic ReDoS in IPv6 zone parsing) ships via webtorrent's `load-ip-set`/`torrent-discovery`; torrent peers are untrusted input | `node_modules/ip-address` = 10.7.5; torrent suite 31/31 |
| archive-extract hardening | Two Windows edge cases found in the cycle-2 fresh-eyes pass: NTFS alternate-data-stream entry names (`readme.txt:zone.identifier`) and DOS reserved device names (`CON`, `NUL.txt`) were not refused — both stay inside the extraction root, so severity low, but hidden/odd targets | 4 new checks in `test/archive-extract.js` (52/52) |

### Fixed (user-reported)

- **"The file name is not catching the exact file name"** — two defects:
  1. `filenameFromContentDisposition` (src/engine/probe.js) percent-decoded
     *quoted* `filename="…"` values, which are literal per RFC 6266 — a real
     name like `Report%202026.pdf` silently became `Report 2026.pdf`.
     Quoted values are now literal; bare tokens keep the tolerant decode.
  2. `_refineFilename` (src/download-manager.js) only applied the server's
     Content-Disposition name when the current name was generic or
     extension-less, so a URL basename like `9f8e7d.zip` beat the server's
     exact `Monthly Report.zip`. The server name now wins over URL-derived
     guesses (browser parity) but never over an explicitly provided name
     (`_userNamed`, set in `addDownload`). New suite
     `test/filename-exact.js` (21 checks); the mydaddy-title source guard was
     updated to pin the new condition.

### Test-infrastructure fixes

- `test/site-grabber.js` crashed the runner with the libuv `win/async.c`
  assert (same class as the engine-network-bind / response-integrity fixes of
  previous cycles): the live-crawl HTTP server was not drained before exit.
  Now uses the house pattern (`close()` + `closeAllConnections?.()` + await
  close, `process.exitCode` + unref'd 2s force-exit). 3× isolated runs clean.
- `test/mydaddy-title.js` guard `generic names yield to Content-Disposition`
  updated to the new authority condition.

### Dependency notes (recorded honestly)

- `npm audit fix` was run for the dev-tooling transitive chain
  (brace-expansion, undici via electron-builder→node-gyp). Build-time only.
- **Remaining residue, deferred:** 4 high advisories in `bittorrent-tracker`
  11.2.3 (transitive under webtorrent 2.8.5). The fix is webtorrent 3.x,
  which is ESM-native; `src/torrent-engine.js` loads webtorrent via dynamic
  `import()` (verified working), but the major bump needs verification against
  live swarms and is deferred to cycle 3. Not silently ignored — see
  VALIDATION_REPORT §residual.
- webtorrent intentionally stays 2.8.5 (2.8.5 is CJS-loadable and verified by
  the torrent suite; 3.0.21 is a breaking major).

### Built

- `npm run dist` → **success, exit 0** (after the optional-native pruning below)
  → `dist/AiDM-Setup-5.5.0.exe` **150,331,744 B** + blockmap 158,019 B.
  Bigger than 5.4.0's 104.9 MB: Electron 45's runtime is larger than 28's.
- **v5.6.0 rebuild** (after the Liquid Glow feature): `npm run dist` → exit 0 →
  `dist/AiDM-Setup-5.6.0.exe` **150,335,764 B** + blockmap; `latest.yml`
  refreshed and sha512 independently re-verified; the three animation files
  (`ui/download-viz.js`, `ui/app.js`, `ui/styles.css`) byte-identical inside
  the asar; packaged `--version` → 5.6.0.
- `node tools/refresh-latest-yml.js` → sha512 independently recomputed and
  **matches** electron-builder's value; `latest.yml` describes 5.5.0,
  `releaseDate` 2026-10-25T15:05:15.943Z.
- Packaged content verified: 7 touched sources (`probe`, `archive-extract`,
  `download-manager`, `main`, `ui/app`, `cli`, `site-grabber`) **byte-identical
  (sha256)** inside `app.asar`; packaged `package.json` reports 5.5.0; runtime
  deps inside the asar are the same 4 (uuid now 11.1.1).
- Packaged runtime proof: `AiDM.exe --version` → **5.5.0**, exit 0.
- No signing certificate configured this build (cycle 1 signed via signtool;
  the cert was not available in this session) — installer is unsigned,
  recorded honestly.

### Added (same cycle, follow-up feature)

- **"Liquid Glow" download-animation layer** (v5.6.0), built from a research
  pass on 2025–26 progress-animation patterns (liquid/wave fill, glow rings,
  completion bursts, check-draw micro-interactions):
  1. *Liquid crest* on active fills — two translucent SVG waves, exactly two
     wavelengths wide (λ must divide 100 or the −50% CSS loop jumps — caught
     by the suite), translating transform-only for a seamless GPU loop; two
     layers at different speeds for depth. Embedded via `DownloadViz.liquidHtml()`
     into the byte map and BlockGrid cells (budget: first 16 active cells per
     row; beyond that the shimmer carries the motion).
  2. *Speed-reactive glow* — `DownloadViz.speedGlowTier(measured B/s)` → row
     `data-glow` 0–3 → halo opacity over the main bar (opacity-only
     transitions; tier 0 = no glow without speed; honest decoration).
  3. *Completion flourish* — a success ring draws itself around the file icon
     (stroke-dashoffset → 0) plus a 12-particle transform/opacity burst from
     the fill's leading edge; once per completion (`completionFxIds`), reset
     on resume, self-cleaning timers, skipped under reduced motion.
  Files: `ui/download-viz.js` (`liquidHtml`, `speedGlowTier`, `wavePathD`,
  `LIQUID_MAX_CELLS`), `ui/app.js` (`motionOk`, `syncMapWave`, `syncSpeedGlow`,
  `fireCompletionFx` + hooks in patch/render/IPC paths), `ui/styles.css`
  (animation layer + reduced-motion removal), `test/download-animation.js`
  (40 checks). Verified: suite 40/40; offscreen renders `05-row-liquid` /
  `06-row-burst` show crest, glow sheen and the drawn ring on real Electron.

### Toolchain changes this cycle

- `.npmrc` with `omit=optional`: prunes `bufferutil`, `utf-8-validate`,
  `utp-native` (optional native accelerators whose Electron-45 rebuild broke
  the packaging). The app's zero-native-builds design already runs without
  them (pure-JS fallbacks; torrent suite 31/31).

### Not done (recorded, not hidden)

- Wave-2 features (auto-purge, portable mode, winget/scoop manifests, transcode
  presets, queue-scoped scheduling, app-aware throttling): **not attempted this
  cycle** — the Electron 17-major jump + verification consumed the cycle budget;
  they remain the top of the roadmap for cycle 3. A verified platform/security
  jump beat an unverified feature batch (skill scale rule).

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
