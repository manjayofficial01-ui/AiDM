# PROGRESS — modernization cycles

Last updated: 2026-10-29 (cycle 6 — YouTube recovery, filename extensions, Qoder dark theme)

## Capabilities (observed this cycle)

- git repo `aidm/` on new branch `modernize/2026-10-28`; no push or commit.
- Node v25.8.1, npm 11.19.0, Electron 45.0.0; no linter/typechecker or CI found.
- Baseline `npm test`: 79 passing suites and 1 failing suite including the separately executed final suite. Final run after security fixes and quarantine-test isolation: **82/82 suites pass in 68.6s**, exit 0; raw output in `evidence/p0-full-suite.log`.
- `npm run dist:win` and a separate temp-output build both fail on an
  EPERM/EBUSY lock for `resources/default_app.asar`; installer build unverified.
- `npm audit --json`: 0 known vulnerabilities; registry/outdated checks worked.
- Existing baseline mock screenshots inspected; their freshness was not proven. Fresh Playwright Chromium verification on 2026-10-29 exercised the real renderer with mocked desktop APIs: 23 checks passed; no page errors/dialog execution. Native app and signed-in extension remain untested.
- Subagents, SearchWorkspace, canvas, browser-use and Playwright MCP available. Playwright's filename loader cannot read this workspace; the same fixture was supplied through its supported code argument.
- Qoder Security skill and REA CLI not present; no security-scan claim made.

## Mode / stage

`modernize`, full sequential cycle. User approved the concept, existing-blue Fluent-inspired direction, and security-first implementation on 2026-10-28. APP-001…003 and the APP-011 validation-gate repair are complete and verified within the fixture coverage below. Independent-review findings were confirmed, fixed, and retested by the main agent; no second independent approval is claimed. Remaining P1 security/reliability work precedes UI redesign or additional features. This is not a release-ready or installed build.

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

## Session log — 2026-10-28 (cycle 4: baseline → concept gate)

1. Created clean branch `modernize/2026-10-28` from `0c1eb70`; re-mapped the
   Electron main/preload/renderer/extension architecture and core journeys.
2. Re-ran the real checks: 79 suites pass and `yt-dlp-install.js` fails one
   machine-dependent quarantine-message assertion; both installer build
   attempts fail on `default_app.asar` EPERM/EBUSY. npm audit reports zero.
3. Re-verified prior audit claims against current source. New P0s: quality
   metadata HTML injection, unconfined IPC save paths, extension `new Function`.
   P1s include credential exposure, Authorization scrubbing, keyboard/dialog/
   startup accessibility-reliability gaps, late-probe cancellation, persistence,
   and archive memory bounds. Evidence and unknowns recorded in `AUDIT.md`.
4. Invoked the offscreen driver and inspected/copied existing empty/main, active-row, settings, and grabber images. Capture freshness was not established; those baseline images are historical visual references, not current runtime proof.
5. Wrote `BASELINE.md`, `AUDIT.md`, and `CONCEPT.md`; no product code changed.

## Session log — 2026-10-29 (cycle 4: approved security slice)

1. APP-001: escaped quality/format metadata and normalized scalar values at
   picker intake; verified rendering, selection, deduplication, submission,
   and error recovery in real Chromium with mocked desktop APIs.
2. APP-002: authorized explicit IPC save paths before manager mutation,
   including settings-root edits. Added canonical link-aware containment,
   sender-scoped native Browse grants, required approval paths, and visible
   download/settings rejection feedback. All 20 path/IPC checks pass.
3. APP-003: replaced extension flashvars evaluation with a bounded data-only
   parser. All 20 shipped-extractor checks pass, including executable-input
   rejection, parser limits, and supported literal compatibility.
4. Fresh independent review returned five should-fix findings: inconsistent
   scalar coercion, missing approval paths, invisible Add Download rejection,
   parser limits counting unrelated code, and non-checkout-local test scratch.
   All five were reproduced and fixed; none rejected. Main-agent regression
   checks also closed the settings-root authorization bypass. No second
   independent-review verdict is claimed.
5. Brought APP-011 forward to repair the baseline validation gate. The missing
   yt-dlp message now accepts injected search directories; both absent/present
   quarantine fixtures pass without depending on real machine state (35/35).
6. Final `npm test`: 82/82 suites pass in 68.6s, exit 0. The isolated Chromium
   fixture passes 23 checks with no page errors or execution dialogs. Syntax
   checks and `git diff --check` pass. Full output and fresh screenshots are
   in `evidence/`; detailed scope is in `VALIDATION_REPORT.md`.
7. Stopped the temporary loopback renderer server. No commits, pushes,
   dependency/version changes, installer replacement, installed-app changes,
   live downloads, or signed-in browser actions were performed.

## Session log — 2026-10-29 (cycle 4: remaining P1 slice)

1. APP-004: shared `src/settings-view.js` redacts AI key, file-host password/
   cookie and proxy userinfo before any renderer/IPC read; presence flags
   replace the values. 10/10 boundary checks; real-Chromium redaction display.
2. APP-005: `src/download-privacy.js` scrubs cookie/authorization keys
   case-insensitively at every row boundary and sanitizes the rotated `.bak`
   too. 10/10 behavioral checks.
3. APP-008: late probes now funnel through `_failRow`, which cancels the
   active engine writer exactly once and never repaints terminal rows. 9/9.
4. APP-009: persistence coalesces non-forced writes (1.5 s floor + unref'd
   trailing flush), writes compact JSON, captures disk failures once per
   streak, and emits `persist-error`/`persist-recovered` to a persistent
   status-bar warning. 4/4 contracts + browser warning/recovery.
5. APP-007: boot state machine (loading/ready/error) renders before any IPC
   await; empty state is only shown after a proven-empty load; Retry and a
   successful refresh recover. The browser fixture caught a real bug where
   `renderDownloads()` re-showed the empty state after a failed load.
6. APP-006: category rows became real buttons (aria-pressed), sortable
   headers are focusable with aria-sort and Enter/Space, the quality picker
   is a radio group with arrow-key navigation, all 71 labels/controls are
   associated (61 added), 7 modals are labelled dialogs with initial focus
   and focus return, toasts are announced, and focus-visible rings exist.
7. APP-010: archive entries stream through `zlib.createInflateRaw` to disk
   with a per-entry cap, incremental CRC and size verification; a lying zip
   bomb (1 KB declared, 64 MB real) is refused with a 0.9 MiB RSS delta.
8. Final `npm test`: **86/86 suites pass in 67.8 s**, exit 0. Real Chromium:
   **34/34 checks** (startup states, keyboard journeys, persistence warning,
   dialog focus), no page errors or dialogs. No commit, push, version bump,
   installer, or dependency change.

## Session log — 2026-10-29 (cycle 4: APP-012 visual refinement)

1. Baseline captured with five representative rows, an empty Add dialog and
   a no-match search (`evidence/p2-baseline-*.png`): confirmed the filtered
   empty state said "No downloads yet" and an empty submit was silent.
2. Semantic token contract: `--state-{success,warning,danger,info,neutral,
   fresh,pending}` with `-bg`/`-border` pairs in both themes, plus
   `--elevation-1/2`, `--focus-ring`, `--radius-sm`. Status badges and the
   connection/network chips now read tokens instead of per-rule rgba values;
   the popup and capsule declare the SAME token names for their own surfaces.
3. State feedback: `renderEmptyState()` distinguishes "library empty" from
   "search matched nothing" and "nothing in this category", with a Clear
   filters action that resets both the search box and the category; Add URL
   now shows an inline, announced, aria-invalid error for an empty or
   non-link value, clears it on edit, and submits on Enter.
4. Fluent polish: empty canvas icon sits in a glass medallion, focus rings
   are tokenised, error fields keep the danger ring under focus, and both new
   animations honour `prefers-reduced-motion`.
5. Verification: `test/ui-states.js` 17/17 contracts; a real-Chromium fixture
   (21 checks) proves token application, both filtered-empty variants, a
   genuine empty library, and the full validation cycle; captures
   `evidence/p2-after-*.png` in light and dark. Full suite 87/87.

## Session log — 2026-10-29 (cycle 4: AUD-012 extension-origin trust)

1. `src/extension-pairing.js` canonicalises chrome (32×[a-p]) and moz (UUID)
   origins and owns the allowlist rules; malformed ids can never pair.
2. `src/server.js`: extension origins pass only when exactly paired. An
   unpaired request raises a native Allow/Block prompt and is HELD up to 60 s
   so Allow finishes the action; concurrent requests share one prompt; a
   denial is session-scoped; an approval must persist a valid origin or the
   gate stays shut. Preflight is answered without a prompt; unpaired
   responses carry no CORS reflection.
3. `main.js`: the prompt shows the exact origin and saves the approval;
   imports strip `trustedExtensionOrigins` (trust is device-local). Settings ›
   Browser lists trusted origins with accessible Remove buttons (immediate).
4. Fixed a related pre-existing defect: the renderer polled `/api/status`
   from `file://` (Origin `null`) and could only read "Degraded"; it now uses
   a main-process `api-status` IPC request.
5. Verification: `test/extension-pairing.js` 52/52 (pure rules + a live
   server: approve/deny/cache/concurrency/preflight/unpersisted approval),
   six Chromium revocation checks, full suite 88/88. No version bump, commit,
   push, or installer.

## Session log — 2026-10-29 (deployment)

1. The user saw no changes because the running app was the installed build
   from `C:\Program Files\AiDM` (started 12:10), not the working tree.
2. `npm run dist:win` still fails on the workspace-locked
   `dist\win-unpacked.tmp\resources\default_app.asar`; building with
   `--config.directories.output=D:\AiDM-build` succeeded.
3. The first installer defaulted to per-user while the existing install is
   per-machine (`/allusers`); rebuilt with `nsis.perMachine=true` so it
   replaces the existing install instead of creating a second copy.
4. Closed AiDM, installed 5.8.0 to `C:\Program Files\AiDM` (app.asar
   29,784,798 B, replaced 12:40), verified the asar contains the new modules,
   and relaunched. The live port now enforces the gate: no-Origin 200,
   malformed extension origin 403 `extension-not-paired`, web origin 403.
5. Recorded the environment gotchas in `TOOLS.md`: build outside the
   workspace, per-machine packaging, and the agent shell's
   `ELECTRON_RUN_AS_NODE=1` (which makes Electron launches exit silently).

## Session log — 2026-10-29 (cycle 4: AUD-013 + AUD-015, final P2s)

1. Webhooks are bounded: per-attempt AbortController deadline, exponential
   backoff (1 s/2 s/4 s) for network/408/429/5xx with no retry for other 4xx,
   a sequential worker over a 100-entry queue that drops the oldest and
   counts drops, and `close()` on quit that aborts in-flight work. `emit()`
   enqueues (never blocks a download); `flush()` is for tests. 26/26 checks.
2. Focus/target polish: shared `:focus-visible` ring across custom and native
   controls; the switch's `outline: none` needed a same-specificity override
   (caught in Chromium); switch 40×24, checkboxes 16 px, search clear 26×26;
   column resizers are labelled buttons with Arrow/Shift+Arrow/Home support;
   no page-level horizontal scroll at 1280/900/700 px. 13 contracts + 15
   Chromium checks; `evidence/p2-narrow-900.png`.
3. Fixed a recurring test flake: `row-media.js` temp-dir cleanup now retries
   and never fails the suite on a Windows handle race.
4. Full suite **89/89**. Also removed the `--disable-blink-features=
   AutomationControlled` infobar the user saw: it belonged to the Playwright
   MCP's headed Chrome, not AiDM; the connector now launches `--headless`
   (plugin config backed up beside it).

## Current buckets (cycle 4)

- **Completed and verified:** APP-001…APP-015 within the regression/browser
  fixture coverage above; packaged, installed, and live-verified on this
  machine; documentation synchronized.
- **Completed but unverified in native/live operation:** actual native Browse
  and location-dialog interaction, signed-in extension and live-site parsing,
  real downloads, screen-reader output, contrast measurement, and the
  packaged/installed security and accessibility changes.
- **Planned:** CSP remains a defense-in-depth follow-up; preflight path
  checks are not an atomic sandbox against concurrent local junction
  replacement. No audit findings remain open at P0/P1 and the P2 list is
  cleared (AUD-012…AUD-015 done in this cycle; AUD-016/AUD-017 done earlier).
- **Blocked:** none. Packaging works when output is outside the indexed
  workspace (see `TOOLS.md`).

## Exact next step

The user validates the installed build: the extension's first request raises
the Allow/Block prompt once (AUD-012), Settings › Browser lists the paired
extension with a Remove action, a no-match search says "no downloads match",
an empty Add-URL submit shows an inline error, and column edges can be sized
with Tab → Arrow keys. No commit or push has been made — the branch
`modernize/2026-10-28` is still uncommitted.

## Session log — 2026-10-29 (cycle 5: engine upgrade implementation)

1. Added production engine telemetry and a repeatable loopback benchmark. The
   task exposes first-byte, 5%/1% tail, connection, retry, ramp, mirror and
   writer statistics. `test/engine-telemetry.js` proves the fixture and contract
   without claiming real-network speed. Baseline and post-slice evidence:
   `evidence/engine-post-slices.json`.
2. Removed all automatic TLS-certificate bypasses from the segment transport,
   probe transport, URL fetch, and HTTPS proxy connector. `test/transport-tls.js`
   generates a self-signed server and proves every path fails closed.
3. Added persistent server-performance profiles. Mirror scores survive
   downloads, use origin-only keys, age out, quarantine permanently failed
   origins, and expose no paths, tokens, or credentials in telemetry or the
   persisted file (`~/.aidm_server_profiles.json`).
4. Added work-conserving weighted scheduling: high/normal/low priorities,
   10-minute aging, per-task speed limits, capped-share redistribution, live
   queue selection, and IPC/preload control seams. Shares are applied through
   the existing task and global token buckets; torrent and yt-dlp paths retain
   their own global throttles.
5. Added Metalink v3/v4 expansion. `.meta4` and `.metalink` rows now yield real
   file URLs, mirror priorities, sizes, checksums and piece manifests. Parser
   caps, DTD/entity rejection, unsafe-URL rejection and path sanitization are
   covered by 17 checks; manager expansion by 11 checks.
6. Added piece-range verification and targeted repair. A deliberately corrupt
   first download is detected after transfer, re-fetched only for the failed
   byte ranges, and then completes byte-correct. Repair passes are capped at
   two per task.
7. Upgraded WebTorrent control: selective files and priorities, sanitized
   tracker/web-seed lists, selected-byte progress/completion, upload cap, peer
   and ratio telemetry, live selection API, seed-policy API, and client settings
   for max connections/DHT/LSD/PEX. Existing mock compatibility is preserved.
8. Exposed the engine controls in the actual UI: priority context actions,
   HIGH/CAP row chips, and a labelled Download Options modal for per-task rate,
   torrent file selection, and seed policy. The real Chromium journey passed
   13 checks, opened the modal from both row and context controls, persisted
   KB/s → bytes/sec, changed live selection, and produced no page errors.
   Evidence: `evidence/p5-http-options.png` and
   `evidence/p5-torrent-options.png`.
9. Full suite: **100/100 suites passed**. Tests were run in this workspace; no
   packaged install was replaced during this cycle, so these results prove the
   source behavior, not the currently installed binary.

## Current buckets (cycle 5)

- **Completed and source-verified:** ENG-001, ENG-002, ENG-003, ENG-004,
  ENG-006 (Metalink intake plus piece repair), and ENG-007 (torrent control
  plane), each with deterministic tests and the full regression suite green.
- **Completed and browser-verified:** UI control surfaces for priority,
  per-task speed, torrent file selection, seed policy, chips, modal focus,
  context-menu visibility, and keyboard dismissal.
- **Benchmark-gated, deliberately not shipped:** ENG-005 bounded write
  coalescing. The current positional writer already produces large write calls
  (18 writes for the 2 MB fixture) while preserving immediate error
  propagation/backpressure; buffering would add crash-visibility risk without a
  measured win.
- **Not verified:** real internet throughput, mirror failover on live hosts,
  signed URL re-resolution, actual screen-reader behavior, native extension
  prompts, and packaged/installer operation. No live Metalink corpus was
  fetched.
- **Blocked:** none.
- **No commit, push, dependency change, version bump, or installer replacement
  was performed in this cycle.**

## Cycle 6 session log — recovery + identity (2026-10-29)

- **YouTube repaired, not re-architected.** The failure was extractor drift, not
  the pipeline: the managed binary was 3 days behind. Updated to
  2026.10.26.220202 via `tools/fetch-yt-dlp.js`; a live run produced a 1080p MP4
  with audio. Restart required for a running app to pick up the new binary.
- **Extension loss fixed at the source of truth.** `src/engine/probe.js` now owns
  MIME→extension, `hasFilenameExtension()` and `ensureExtension()`; the manager,
  engine finalisation, approval dialog and Chrome handover all read them instead
  of each guessing. 17 new checks in `test/filename-extensions.js`.
- **Qoder IDE dark theme applied.** Palette and status ramp were read out of
  Qoder’s own compiled theme CSS inside `app.asar` (not guessed from marketing
  screenshots); the brand green came from `qoderIdeLogo.svg`. 26 hard-coded
  colour sites in `ui/styles.css` plus 3 in `ui/location-dialog.html` now read
  theme tokens. Light theme intentionally unchanged.
- **Accessibility side-effect worth keeping:** a bright green accent makes white
  button ink illegible (1.84:1), so solid fills now use `--on-accent`
  (#080807 in dark = 10.86:1, white in light = 5.17:1).
- **Verification:** `node test/run-all.js` → 101/101 suites, 3191 checks, 0
  failures. Real Chromium theme fixture → 13/13, no page errors, all dark
  text/status colours ≥4.5:1 on the canvas.
- **Known light-theme debt (pre-existing, untouched):** `--text-muted` 4.04:1,
  `--success` 3.57:1 and `--warning` 3.02:1 on the light canvas fail AA for
  small text. Dark has no such gap.
- **No commit, push, version bump or installer replacement in this cycle.** The
  yt-dlp binary update is the only on-disk change outside this repository.
