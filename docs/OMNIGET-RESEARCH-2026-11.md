# OmniGet research → AiDM v5.9.0 integration decisions (2026-11-04)

Deep research on https://github.com/OpenSelena/omniget (Tauri 2 + Rust + SvelteKit,
GPL-3.0, ~940★, ~3,000 commits, 4 months old, weekly releases) against a full audit
of AiDM's own capabilities. Three research agents: repo deep-dive, AiDM capability
audit, external-tool fact-check (gallery-dl / yt-dlp / Telegram / Udemy).

## Headline finding

**AiDM's transport core is already ahead of OmniGet's.** Their HTTP engine (8
segments × 4 MiB hint, work-stealing) is simpler than ours (adaptive ramp
controller, per-domain learned caps, mirror pool + server profiles, DoH
fallback, NIC bonding, Metalink piece repair, background SHA-256). Their HLS
downloader is a peer of ours. The real gaps were **site coverage breadth**,
**global connection economics**, and a handful of operational tricks.

## Gap analysis (ranked)

| # | Capability | OmniGet's approach | Decision |
|---|---|---|---|
| 1 | Image galleries (250+ sites) | gallery-dl subprocess, ~26-host route list | **SHIPPED in v5.9.0** — `src/gallery-dl.js` |
| 2 | Global connection budget | AIMD budget (24) split across downloads; benchmark: 8×8 regressed ~2× vs 4×8 | **SHIPPED in v5.9.0** — `src/engine/global-budget.js` |
| 3 | Course platforms | 36 native extractors (≈22 Brazilian; README's "Coursera/Skillshare" not in code) | **SHIPPED (Udemy via yt-dlp)** — playlist route + DRM refusal |
| 4 | yt-dlp hardening | fail-closed SHA2-256SUMS, never-swap-while-running updates, `--print after_move:` | Partial credit — AiDM already has nightly+SHA flow; live-swap guard is a small future add |
| 5 | Extension "deep search" (MAIN-world fetch/XHR/JSON.parse hooks) | ⚠️ their file is GPL-derived from **cat-catch** — clean-room hard-stop | **DEFERRED** — valuable, must be written from scratch |
| 6 | WAL-based queue persistence | append-only JSONL, torn-tail discard | **DEFERRED** to a queue-persistence cycle (touches every `_persistDownloads` site) |
| 7 | aria2c sidecar | `-x16 -s16 -k1M` + progress regex (their whole integration ≈ 158 lines) | **REJECTED** — AiDM's engine already does more (ramp, caps, mirrors); a second transport doubles failure surface. Docs previously rejected embedded aria2; a sidecar adds nothing we lack. |
| 8 | Telegram (tdl), whisper.cpp, MCP server, 158-tool box | tdl AGPL binary; whisper GGML; MCP over local HTTP | **DEFERRED/REJECTED** — login-UX + account-risk scope; transcription/AI tools are not the downloading machine |

## What shipped in v5.9.0

### 1. gallery-dl engine (`src/gallery-dl.js`)
- External GPL-2.0 subprocess, never bundled (same legal pattern as yt-dlp).
- Discovery: `AIDM_GALLERYDL`/`AIDM_GALLERYDL_BIN` → `resources/bin` → dev `bin/`
  → `%LOCALAPPDATA%/AiDM/bin` → PATH; verified by executing `--version`.
- Installer: **Codeberg stable** (`codeberg.org/api/v1/repos/mikf/gallery-dl`)
  with **gdl-org/builds** nightly as a channel. gallery-dl's own `-U` targets
  GitHub stable assets that 404 today — AiDM owns updates. No SHA256SUMS are
  published, so the downloaded binary is validated by EXECUTION (`--version`
  must answer) before it replaces anything, staged under a real `.exe` name
  (Windows CreateProcess refuses `gallery-dl.exe.new`).
- **Version-output gotcha (live-tested):** gallery-dl prints a BARE semver —
  `1.32.19`, no "gallery-dl" prefix, unlike yt-dlp. `parseVersionOutput()`
  accepts both shapes.
- Routing: conservative 30-host list (`GALLERY_HOSTS`); direct-file URLs
  (extension in the last path segment) and unknown hosts NEVER route here.
- Row contract: `multiFile` folder rows, file-count progress (indeterminate
  band), `--download-archive` per URL = pause/resume/dedupe (a resumed run
  only fetches missing files), row cookies → Netscape file (reuse of the
  yt-dlp cookie plumbing), proxy passthrough, exit-code BITMAP → error codes
  (`auth`/`challenge`/`unsupported`/`partial`/`os`/`input`/`generic`),
  `galleryMaxConcurrent` cap (default 2), cookie files deleted after the run.
- Settings › gallery-dl: version display, one-click install/update (progress
  streamed to the hint), opt-in `--cookies-from-browser`.

### 2. Global connection budget (`src/engine/global-budget.js`)
- Clean-room reimplementation of OmniGet's *idea* (their file is GPL).
- Fair share: every active download's ceiling = min(own, floor(budget/active)),
  recomputed on task start/end; each task's OWN ceiling is restored when the
  pool frees (the ramp then grows back through its normal 1.05× probing).
- Hard gate: a HostGate instance keyed on one synthetic host (`*global*`) so
  live connections can never overshoot the budget, wired at fill/launch/finally
  exactly like the per-host gate.
- `setMaxConnections(n)` re-added to DownloadTask **with its caller** —
  satisfying the 2026-10-01 removal note ("re-add WITH a caller").
- Default 24 (3×8 classic behavior untouched; sharing starts at 4+ downloads),
  `0` disables. Setting: `globalConnectionBudget` (Settings › Network).

### 3. Udemy / course rows (via yt-dlp)
- `isCourseUrl` (src/url-hygiene.js): `udemy.com` + `/course|/draft|/learn` paths.
- `_startYoutubeDownload(..., { course: true })`: `--yes-playlist` replaces
  `--no-playlist` (`allowPlaylist` opt in yt-dlp.download), format `best`,
  per-course folder template `%(playlist_title)s/%(playlist_index)03d - %(title)s.ext`,
  row completes as the course FOLDER (`multiFile`, no media probe).
- Auth: the documented extractor path — browser cookies (`access_token` →
  Bearer). DRM'd lectures: yt-dlp refuses; AiDM classifies "DRM protected" as
  a hard `drm` error with an honest message. Enrolled-session only; no
  Widevine, ever.

## License stance (binding for all future work on this repo)

OmniGet is GPL-3.0 → **zero code copied, ever**. External GPL binaries
(gallery-dl GPL-2.0, aria2 GPL-2.0, yt-dlp Unlicense) are invoked as unmodified
separate processes. CLI contracts, exit-code tables, and benchmark numbers are
facts; algorithms are reimplemented clean-room. Their `deep-search.js` is
additionally cat-catch-derived — double reason not to touch it.

## Sources
- Repo deep-dive (cloned, analyzed 2026-11-04): engine wiring, extractors, extension bridge, MCP, queue core, repo health.
- gallery-dl: docs/options.md, exception.py exit codes, Codeberg + gdl-org/builds releases (stable assets 404 on GitHub — verified via API).
- yt-dlp: update.py channels; udemy.py cookie/Bearer/DRM behavior.
- Telegram: Bot API 20 MB limit; iyear/tdl contract (deferred).
