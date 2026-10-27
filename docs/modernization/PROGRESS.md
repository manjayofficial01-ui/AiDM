# PROGRESS — modernization cycles

Last updated: 2026-10-27 (v5.7.2 cycle)

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

User installs `dist/AiDM-Setup-5.7.2.exe` (or restarts the dev copy — it
runs from source) and retries the rename that failed. If a rename still
reverts, capture the URL type + resulting filename; the next investigation
starts from `_applyProbeResult` (2942) and `_startDownload` (2255).
