# Changelog — modernization cycles

## v5.7.0 (2026-10-25) — "Pulse Flow" animation redesign (user-requested)

Second, deeper research pass over premium download animations — App Store
button (state continuity: states morph, never jump), Chrome's download bubble
/ Telegram radial arc (SVG ring, pathLength=100, dashoffset = 100−pct, round
caps, M3 determinate+indeterminate pairing), motion principles (perceived
speed, deterministic feedback), and 2025 spring physics via native CSS
`linear()` easing (Josh Comeau / Carmen Ansio — Chromium 113+, Electron 45 ✓).
What the Liquid Glow layer lacked vs. those references: a progress ring,
state continuity, and springs. The redesign adds exactly those:

1. **Icon progress ring** (App Store / Chrome-bubble pattern): a determinate
   arc at the REAL percent around the file icon while downloading, plus a
   rotating comet arc; comet-only while connecting (honest — no percent
   exists yet); nothing otherwise. The patch path moves only the arc's
   `stroke-dashoffset` (transition-smoothed) — states morph, never jump.
   The old icon opacity-pulse retired (two movers on a 30px target = noise).
2. **Flowing current**: three bright dashes traverse the active fill by
   percentage (works at any width), speed driven by the SAME measured
   data-glow tier as the halo — one cause, two effects.
3. **Segment landing springs**: a BlockGrid cell that just flipped to done
   pops on a sampled `linear()` overshoot curve (`--spring-pop`) — bytes
   landing, not just a colour change. `renderSegments` caches per-cell
   states and marks `.just-done` cells on re-render.
4. **Completion ripple**: one expanding success ring behind the icon, joining
   the drawn tick + particle burst.

All on the unchanged house rules: transform/opacity-only motion (the tiny
ring dashoffset is the one paint-based transition, same as the done-ring),
honest decoration, bounded counts (1 ring + 3 dashes per row), and
reduced-motion removes every mover while keeping the static arc/fill/percent
information.

Files: `ui/download-viz.js` (`iconRingState`, `currentHtml`, `justDone`
marking), `ui/app.js` (`iconRingHtml`, `syncIconRing`, `syncCurrent`,
`segStatesCache`, ripple), `ui/styles.css` (Pulse Flow layer + spring var +
reduced-motion extension). `test/download-animation.js` grew 40→63 checks
(ring math incl. clamping and percent-fallback honesty, comet-only
connecting, current bounds, just-done precision, CSS guards incl.
linear() spring and tier-driven durations, stale source-guards re-pinned).
Verified: suite 63/63, legacy viz 76/76, offscreen render `05-row-pulseflow`
shows ring + current + BlockGrid on a real Electron 45 render.

## v5.6.2 (2026-10-25, same cycle) — the real name now reaches the DIALOG

User re-report with screenshots: the dialog still showed the placeholder +
"Fetching file info…" while Chrome's own download card showed the real name
(`सुचना (1)-1.docx`). The 5.6.1 fix renamed the file MID-DOWNLOAD — after the
dialog had closed. The dialog-time gap: for single-use URLs the probe is
skipped by design, so nothing ever fetched the name BEFORE approval.

Fix — **one header-only naming fetch** (`_probeGmailHeaders`): a plain GET
with `redirect: 'follow'` whose body is cancelled the moment the response
headers arrive. The Gmail entry URL (both `mail.google.com/…view=att` and the
`mail-attachment.googleusercontent.com/attachment/…` CDN form) mints a FRESH
one-shot redirect target per request — the codebase's own documented behavior —
so this spends nothing for the real download, which re-requests the entry and
mints its own target. The headers carry the real name (RFC 5987 UTF-8
included), size and mime; they flow through the standard
`_applyProbeResult` pipeline → row renamed, category fixed, size exact, and
the open dialog patches itself via the existing `download-updated` plumbing —
BEFORE the user clicks Start. If the fetch fails, the branch falls back to the
exact synthetic contract the pure single-use path returns (pinned by
`test/single-use-token.js`, harness updated with the new stubbed layer).

Verified: `test/response-name.js` now 19 checks — the naming fetch against a
Gmail-shaped 302 chain returns `सुचना (1).docx` + exact size + mime in ONE
entry request, and the full manager path renames the pending row pre-approval
with a stubbed fetch. Full suite **76/76 in 57.6s**.

## v5.6.1 (2026-10-25, same cycle) — Gmail attachment names (user re-report)

The user's screenshot showed the location dialog offering **"7"** for a Gmail
attachment — the numeric user-id segment of
`mail-attachment.googleusercontent.com/attachment/u/7/?ui=2&...`. This is a
DIFFERENT path from the cycle-2 Content-Disposition fix: single-use-token
downloads skip the probe entirely (the probe would spend the one-shot token),
so the real name existed ONLY in the response of the one plain GET AiDM itself
performs — and nothing read it. Root causes, both fixed:

1. `_extractFilename` happily reported the URL's last path segment (`7`) as a
   file name. Gmail CDN/entry URLs now derive the honest placeholder
   **"Gmail attachment"** (new `isGmailAttachmentCdnUrl` in url-hygiene.js).
2. The engine's single plain GET receives `Content-Disposition` but nothing
   consumed it. Now: `worker.js` captures it into the segment result →
   `task.js` emits `name` + retargets the final file (the `.part` keeps its
   provisional name until the final rename — no open-handle risk) →
   `download-engine.js` forwards `download-name` → the manager renames the
   row + open dialog live. A name the user typed in the dialog
   (`approveDownload`) is marked `_userNamed` and never overridden.

Verified: new end-to-end suite `test/response-name.js` (local Gmail-shaped
302 → one-shot with `Content-Disposition: Invoice Q4 2026.pdf` → file lands
byte-exact under the real name, 8 checks) + `test/filename-exact.js`
extensions (25 checks). Full suite **76/76 in 68.0s**.

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
