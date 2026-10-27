# PROGRESS — modernization cycles

Last updated: 2026-10-28 (v5.8.0 cycle 3)

## Capabilities (observed this cycle)

- git repo `aidm/` on branch `modernization/2026-10-25-c2`, remote origin
  (GitHub) — commits local only, nothing pushed this cycle.
- Real test command: `npm test` → `node test/run-all.js` (77 suites).
- Build: `npm run dist:win` → NSIS installer in `dist/` (~150 MB).
- Node v25.8.1, Electron 45.0.0. No linter/typechecker configured (plain JS).
- `@electron/asar` available via npx for package inspection. NOTE: its
  `extract-file` subcommand WRITES the extracted file into the CWD (named
  after the basename) — it does not print to stdout. Running it on
  `package.json` overwrote the repo's file once (restored from git). Use
  `extract` to a temp dir instead.

## Mode / stage

`harden` (user bug report → fix → test → release). Stage 9 complete for
v5.7.2: independent review done (P1 found → fixed → re-verified), release
checklist satisfied for the fix scope, installer built and self-verified.

## Session log — 2026-10-27

1. User report: dialog rename still not applied to the finished file
   (repeat of the v5.6.x-era bug).
2. Traced every post-approval filename/filepath mutation. Two live revert
   vectors beyond the already-fixed `nameLocked` forwarding:
   `_refineFilename`'s `curGeneric ||` escape hatch (+ extensionless branch),
   and the Google Drive resolver's unconditional overwrite.
3. Fixed both (gated on `_userNamed`), extended `test/dialog-rename.js` to
   28 checks, updated the `mydaddy-title` authority pin.
4. Full suite green; bumped 5.7.2, changelog, committed 77cccde, built
   installer, verified guards inside the packaged asar.
5. Stage 9 independent review (fresh subagent): fix logic PASS; caught P1 —
   `chrome-extension/manifest.json` still 5.7.1 → `npm test` aborted 26/77
   and the release claim was false as committed. Fixed (abecde0), re-ran
   full suite (77/77, 87s), rebuilt installer (sha512 c49819af…).
6. Working-tree incident during asar inspection (extract-file wrote
   `package.json` + a stray `download-manager.js` at repo root): restored
   from git, deleted the stray file, recorded the tool gotcha above.

## Buckets (report)

- **Completed and verified:** all three rename-revert fixes; regression test
  28 checks incl. executed end-to-end on-disk case for the token flow; full
  suite 77/77; installer built + asar-verified.
- **Completed but unverified on real hardware:** installer not installed over
  the user's existing copy; live Gmail/Drive rename not exercised against
  Google servers (covered by local HTTP server + unit contracts instead).
- **Planned (backlog, not this cycle):** plain-HTTP executed e2e variant of
  the dialog-rename test (currently source-pin + trace); row/disk name
  divergence after 8s probe-race timeout (pre-existing); reserved-name
  sanitize mismatch (pre-existing).
- **Blocked:** none.

## Exact next step

User installs `dist/AiDM-Setup-5.8.0.exe` (or restarts the dev copy) and
tries: torrent download (webtorrent 3.x), Settings → auto-purge days, and
Settings → app-aware bandwidth with another app streaming. If anything
misbehaves, the investigation starts at `src/bandwidth-watch.js` (sampler)
and `_onTrafficSample` (state machine).

## Session log — 2026-10-28 (cycle 3: market research → integration)

1. Deep research: IDM 6.43.1 / FDM 6.30.0 / Motrix / aria2 / 2026 trend
   pieces. IDM's direct-MP4 grab is already exceeded by AiDM's yt-dlp muxing.
   Chose: webtorrent 3.x (platform/security), auto-purge (FDM parity),
   app-aware bandwidth (the 2026 smart-bandwidth trend, ABDM parity).
   HTTP/3 stays rejected per `docs/HTTP3-ASSESSMENT.md`.
2. webtorrent 3.0.21: the major did NOT clear the 4 high audit findings —
   the abandoned `ip` dependency survives in every bittorrent-tracker
   version. Closed with a local shim + npm overrides (audit 4 high → 0);
   44-check contract suite; stale Node-18 pin comment corrected.
3. autoPurgeDays list hygiene (16 checks) + app-aware bandwidth via the
   typeperf sampler (28 checks, counter live-verified on this machine).
   Mid-cycle, youtube-resolver/row-media caught the own-speed tracker
   crashing stub test contexts — fixed with optional calls (`_noteSpeed?.()`).
4. v5.8.0: BOTH version files bumped together (manifest-parity lesson),
   changelog, 80/80 suites, installer built + asar-verified (shim hoisted to
   `node_modules/ip`, tracker loads from inside the asar).

## Buckets (v5.8.0)

- **Completed and verified:** all three integrations (0af459e → c58df4e →
  3023fc6 → d11b37a); 0 npm audit findings; 80/80 suites; installer
  150,332,755 B, sha512 aaaf2cac…2176ca.
- **Completed but unverified on real hardware:** app-aware bandwidth against
  real competing traffic (state machine unit-verified; the typeperf counter
  itself live-verified); auto-purge across a real multi-day window;
  installer not installed over the user's copy.
- **Planned:** winget/scoop manifest (needs a GitHub release — user
  decision); transcode presets; queue-scoped scheduling (structural).
- **Blocked:** none.
