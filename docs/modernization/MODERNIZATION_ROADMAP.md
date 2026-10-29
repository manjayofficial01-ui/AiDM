# Modernization Roadmap — Cycle 1

> **Cycle 2 status (2026-10-25, later):** executed as a security/platform cycle —
> Electron 28.3.3→45.0.0, exact-filename fix (user-reported), dependency
> hardening, archive ADS/reserved-name guards. 74/74 suites, installer rebuilt,
> v5.5.0. See `CHANGELOG.md` / `VALIDATION_REPORT.md` cycle-2 sections.
> **The Wave-2 backlog below is untouched and remains the active plan for cycle 3,
> joined by two new items:** webtorrent 2.8.5→3.x migration (clears the 4
> bittorrent-tracker advisories; loader already ESM-ready) and a streaming cap
> in site-grabber `readLimited`.

**Target:** `aidm/` (Electron desktop app) · **Baseline:** v5.3.3, 67/67 suites green (84.1s)
**Constraint:** additive, low-risk changes. No engine rewrite, no framework swap, no
dependency added for anything the standard library can do.

## Execution waves

### Wave 1 — Correctness & platform maturity (this cycle)

| ID | Task | Files | Acceptance criteria |
|---|---|---|---|
| P1-1 | Archive auto-extract, zip-slip hardened | `src/archive-extract.js` (new), `src/download-manager.js`, `ui/` settings | Extracts a valid ZIP byte-exactly; refuses `../`, absolute, drive-letter and symlink entries; bails cleanly on 7z/rar/encrypted with a recorded reason; never throws into the completion path |
| P1-2 | CLI + argv intake, second-instance forwarding | `src/cli.js` (new), `main.js` | `AiDM.exe <url> [<url>…]`, `--add-file <txt>`, `--hidden`, `--version`; a second launch hands URLs to the running instance and exits |
| P1-3 | Sleep inhibition | `src/keep-awake.js` (new), `main.js` | `powerSaveBlocker` held exactly while a transfer is active or a schedule is armed; released on idle/quit |
| P1-4 | Checksum input hardening | `src/engine/checksum.js` | Rejects wrong-length digests with a clear error; auto-detects algorithm from digest length; accepts `sha256:<hex>`, `SHA-256 <hex>`, `0x<hex>` |
| P1-5 | Site grabber | `src/site-grabber.js` (new), `main.js`, `ui/` | Same-origin crawl, depth/page caps, extension allowlist, robots.txt honoured, dedupe, progress; results queue through `addDownload` |

### Wave 2 — Deferred (next cycle, needs a structural change)

- Queue-scoped scheduling and per-queue concurrency (restructures the single-list model).
- App-aware throttling ("only limit when another app needs bandwidth").
- Portable mode, winget/scoop manifests, auto-purge completed, transcode presets.

## Quality gates for this cycle

1. `npm test` — every suite green, no regression from the 67/67 baseline.
2. Each new module has a dedicated suite in `test/` (auto-wired by `test/run-all.js`).
3. New attack surfaces (archive extraction, crawler) tested with adversarial inputs, not just happy paths.
4. No new runtime dependency.
5. Anything that could not be executed is reported `UNVERIFIED` in `VALIDATION_REPORT.md`.

## File ownership (single agent, sequential — no concurrent edits)

`src/download-manager.js` is touched by P1-1 only. `main.js` is touched by P1-2 and P1-3 —
sequenced, never concurrently. `ui/index.html` + `ui/app.js` are touched by P1-1 (settings) and
P1-5 (overlay) — sequenced.

## Cycle 5 — engine modernization (executed 2026-10-29)

| ID | Task | Files | Status |
|---|---|---|---|
| ENG-001 | Reproducible telemetry and loopback benchmark | `tools/engine-benchmark.js`, `src/engine/task.js`, `src/engine/file-writer.js` | Complete: 12 contract checks |
| ENG-002 | TLS fail-closed transport | `src/download-engine.js`, `src/engine/proxy.js` | Complete: self-signed rejection tests |
| ENG-003 | Weighted priority scheduler | `src/engine/bandwidth-scheduler.js`, `src/download-manager.js` | Complete: priority, aging, fair redistribution |
| ENG-004 | Persistent server-performance profiles | `src/engine/server-profiles.js`, mirrors, engine | Complete: origin-only, decay, quarantine, flush |
| ENG-005 | Bounded disk-write coalescing | benchmark evidence | Not shipped: no measured win; risks crash visibility |
| ENG-006 | Metalink and piece repair | `src/metalink.js`, engine, manager, checksum | Complete: v3/v4, mirrors, checksums, targeted repair |
| ENG-007 | BitTorrent control plane | `src/torrent-engine.js`, manager, IPC, `ui/` | Complete: selective files, tracker/web-seed settings, upload and seed policy, UI controls |
| ENG-008 | Generic signed-URL re-resolution and conditional GET | — | Planned follow-up; not started |

Full suite: **99/99 suites**. No dependency, version, commit, push, packaging,
or installer replacement occurred in this cycle.
