# Modernization Roadmap — Cycle 1

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
