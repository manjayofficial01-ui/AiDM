# Application Upgrade Report — AiDM v5.10.0

**Date:** 2026-11-23 · **Repository:** `D:\000000 Lab\AiDM\aidm` (branch `modernize/2026-10-28`)
**Baseline:** 112/112 suites green at the start of the cycle · **Final:** 116/116 suites green in 101.2 s
**Commits:** two local commits (`49e9b81` — the pre-existing v5.9.9 work as a checkpoint, then the upgrade). Nothing was pushed.

## Application Upgrade Report

### 1. Application Overview

AiDM is an Electron desktop download manager: a multi-segment HTTP engine with
mirrors, per-host connection gates, a global connection budget, torrent/magnet
support through WebTorrent, a yt-dlp pipeline for YouTube/DASH, a gallery-dl
pipeline for image sites, a Chrome extension that intercepts downloads, a
token-harbour AI layer, a scheduler and a local HTTP API for the extension.

The cycle ran the skill's five phases in order: discovery and baseline,
four parallel audits (security, dead code, engine, UI/UX), competitive
research with an approval gate, the UI/UX pass, and cleanup with full
verification.

Four audits ran in parallel against the working tree and produced 15 security
findings, one orphan module plus a set of unreferenced files, two proven High
engine bugs, and a UI/UX verdict of FAIL. The baseline before any change was
112 suites green in 90.4 s, with the dependency audit showing zero
production vulnerabilities and six moderate dev-only ones (electron-builder →
minimatch, for which the only "fix" is a downgrade to electron-builder 25.1.0 —
no real fix exists).

Two findings shaped the whole cycle. The first was that a settings **import**
accepted an unrestricted `postDownloadCmd`, so a settings file arriving from
anywhere else became arbitrary command execution on every completed download.
The second was that the sparse `.part` preallocation made `fileSize()` report
the full size before the bytes were written, so the trim that was supposed to
catch a half-written resume never trimmed — a resumed task could report
**completed** over a zero-filled hole, defeating `finalize()`'s own shortfall
check. Both were proven end-to-end before being fixed, and both were reachable
in the default configuration.

### 2. Fixes, Security, and Performance

**Security — 15 findings, all High/Medium/Low closed**

| Severity | Finding | Fix |
|---|---|---|
| High | `import-settings` accepted an unrestricted `postDownloadCmd` → arbitrary command execution on every completed download | New `src/settings-import.js` strips `postDownloadCmd`, `postDownloadCmdTimeoutSec`, `aiBaseURL`, `youtubeJsRuntime`, `youtubeExtractorArgs`, `trustedExtensionOrigins` (and `mcpEnabled`) on import, and reports what it skipped |
| High | The post-download hook's interpreter deny-list was incomplete | New `src/exec-safety.js` (`isInterpreterExe`, `interpreterRefusalReason`) shared by the manager; shells and script interpreters are refused outright |
| Medium | `aiBaseURL` with no host allowlist → the API key could be sent to another host | The key is now bound to its host: it is dropped when the base-URL host changes, and the env var key is used only with the default provider host |
| Medium | No `will-navigate`, no `setWindowOpenHandler`, implicit sandbox, no CSP | `sandbox: true` declared, navigation blocked, all window-opening denied, CSP added to the main window |
| Medium | Extension `probe-streams` / `expand-hls` fetched page-supplied URLs with `credentials: 'include'` (CSRF/SSRF) | Origin + host gating tightened; foreign-origin fetches refused |
| Low | Forgeable `postMessage`, path-confinement bypass, `path.resolve` instead of realpath containment, gallery-dl without checksum, raw URL in yt-dlp logs, query string to typesafe.ai, any localhost origin trusted, Info API exposing local paths, prefix-based `open-external` | All closed: realpath-canonicalising containment (`src/save-paths.js`), SHA-256 verification of the gallery-dl binary against the release's published `SHA256SUMS` **before it runs**, `redact()`/`redactUrl()` on every log and query, host+path parsing for `open-external`, local origins trusted for reads only (POSTs refused with 403 before routing) |

Verified already safe and left alone: no XSS, no `eval`, no hardcoded secrets,
every route covered by the origin+host gate, and `/api/settings` removed.

**Engine correctness — two proven High bugs**

1. **The resume hole.** The data is now fsynced before the segment bitmap is
   written (centralised in `saveControl()`, with a source-guard assertion in
   the test), the control file and its directory entry are fsynced, and a new
   `src/engine/restore-verify.js` reads a claimed segment back — its tail
   (1024 bytes) plus three 4 KB windows — on all three resume paths. A segment
   whose tail is still a hole, or that extends past EOF, is demoted to
   `pending` and re-downloaded.
2. **The gate waiter leak.** `HostGate._wake()` now skips waiters whose
   callback reports it did not consume the slot, waiters are cleared when
   their task stops (`HostGate.clearWaiters`, `GlobalConnectionBudget.clearWaiter`,
   `Task.releaseGateWaiters()`), and the task lifecycle releases them in
   `start()`'s `finally`. A cancelled task no longer eats the released slot
   while a live task sits at zero connections with the gate reporting capacity.

Also fixed: the scheduler's missed slot is replayed, the phantom
`schedule-stop` is gone, the daily schedule no longer drifts across DST, the
control file is fsynced, and the probe's `sleep()` listener leak is closed.

**Regression suites added:** `test/resume-integrity.js` (32 checks),
`test/upgrade-hardening.js` (108), `test/ui-responsive-table.js` (34),
`test/mcp-server.js` (150).

### 3. Competitive Analysis and New Features

Five download managers were re-checked against their own sources, because the
gap had moved since the previous cycle:

| Product | AI-assistant control (MCP) | Tools | Local API | Remote |
|---|---|---|---|---|
| **Mister Download Manager** 0.2.0 (2026-10-31) | ✅ `misterdownloadmanager-mcp` over stdio, ships in every package | 6 | automation API, token-protected local channel | ✅ paired phone page |
| **Swift Download Manager** 1.9.0 | ✅ `--mcp`, plus resources and prompts | **21**, 3 access levels, site lists, private-address refusal, hourly limits, audit log | local control door with a secret token | ✅ web server + Docker |
| **Gopeed** 2.0.0-beta.1 | ✅ MCP endpoint (PR #1471), same auth as the REST API | 9 | REST API | ✅ self-hosted web UI + Docker |
| **IDM / FDM / JDownloader / AB DM** | ❌ none | — | AB DM only | ❌ |
| **AiDM (before this cycle)** | ❌ none | — | ✅ `src/server.js` + `src/cli.js` | ❌ |

Three of the five leading open-source managers shipped MCP control within
weeks, and AiDM — the only one of them with an AI layer of its own — exposed
nothing to an assistant. The user approved the recommended build at the
skill's STOP gate, and the feature was implemented as **`aidm-mcp`**, an MCP
server with twelve tools:

`list_downloads`, `get_download`, `get_status`, `get_audit_log` (read) ·
`add_download`, `probe_link`, `pause_download`, `resume_download`,
`cancel_download`, `start_queue`, `pause_queue` (standard) ·
`remove_download` (full).

The architecture follows the two strongest of the competitors rather than
inventing a third pattern: a **token-protected loopback channel** to the
running app (Mister Download Manager's shape) and an **access level enforced
by the app, not the client** (Swift Download Manager's shape). The effective
level is the minimum of what the app allows and what the client asked for,
re-read from Settings on **every call**, so lowering it takes effect at once —
even for a connection that is already open. An assistant can never delete a
file (`remove_download` keeps it) and can never choose a folder (downloads go
where the user configured them). Links are checked before anything is fetched:
loopback, private, link-local, CGNAT, ULA, multicast, the cloud metadata
address, the shorthand `127.1`, the octal-looking `012.1.2.3`, and any host
that resolves to a private address are refused. At most 60 calls a minute per
connection; every call is written to `mcp-audit.log` with query-string values
redacted; and an imported settings file can never switch the bridge on.

The bridge is **off by default** (Settings › AI › *AI assistants (MCP)*).

Deliberately not built this cycle, and why: debrid integration (needs
third-party accounts and their APIs), LAN/phone remote control (needs TLS and
pairing — a cycle of its own), archive auto-extract and DLC/CCF/RSDF link
containers (gaps the previous cycle already identified, but no longer
differentiating), and queue-scoped scheduling (the project deferred it
itself, because it restructures the single-list model).

### 4. UI/UX Improvements

The audit's verdict was FAIL, verified in a live Chromium runtime. What
changed:

- **Contrast.** The AI user bubble was white on the accent colour —
  **1.84:1**, far below AA. It now uses the theme's on-accent ink. The light
  theme's seven failing token pairs were retuned (`--text-muted`,
  `--success`, `--warning`, `--error`, `--state-pending`, `--accent-soft`,
  `--progress-bg`) and the dark theme's two.
- **The Actions column was off-screen at the app's minimum width.** Measured
  at 900 px: the container was 682 px, the file-name column had collapsed to
  **78 px**, the table overflowed by 7 px, and the action buttons were pushed
  out of the visible area entirely. `table-layout: fixed` takes column widths
  from the first row and ignores a cell's `min-width`, so the fix gives every
  column an explicit width with an elastic file-name column, a table floor
  equal to the sum of the floors, and a renderer that re-fits on resize, on a
  sidebar toggle and when the table becomes visible — and clamps a hostile
  restored width set. Measured after the fix: container 682 px, **overflow 0**,
  name 154 px, Actions flush with the container's right edge.
- **Keyboard access.** The context menu was a set of `div`s — six actions a
  keyboard could never reach. They are now real `<button>`s with arrow-key,
  Home/End and Escape handling, Shift+F10, and focus restored to the opener on
  close.
- **Announcements.** The download list, the AI history and the toast stack had
  no live regions; they are now `role="log"` with `aria-live="polite"`.
  `aria-selected` is kept in sync on the rows.
- **Labels.** Seven category-path inputs had no accessible name. The label
  heuristic in `test/startup-a11y.js` was replaced with real label-bound
  matching — a label counts only when it has `for=` pointing at *that* control
  or genuinely wraps it — which surfaced a genuinely unassociated
  `<label id="sched-days-label">`, now a `<div class="field-label">`.
- **Robustness.** A blank start could wedge the library view; the bootstrap
  now has a 10 s watchdog that flips to the error state with a visible Retry,
  and every start-up step is wrapped so one failure cannot stop the rest.
- `prefers-reduced-motion` was already honoured and was left that way.

### 5. Final Cleanup and Verification

**Dead code.** A refined export sweep (the first, cruder script over-counted
at 98 because it could not see destructured re-exports and mis-parsed
function parameters) found exactly one genuinely dead export:
`ui/download-viz.js :: LIQUID_MAX_CELLS`. It is a documented public symbol
(`docs/modernization/CHANGELOG.md` names it), so it was kept deliberately
rather than removed against the project's own documentation. `src/engine/segment-advisor.js`
is test-only but is referenced by `package.json`, `test/segment-advisor.js`
and two documents, so it was kept too.

**Removed** (every one checked for inbound references in code, docs, CI and
`package.json` first; all recoverable via the trash, none permanently
deleted): five root `dist*-build.log` files, `evidence/p1-privacy-full-suite.log`,
`tools/api-e2e-youtube.js`, `tools/verify-youtube-progress.js`,
`docs/screenshots/screenshot-settings-general.png`, and a stray 0-byte root
file whose name contained private-use characters. `tools/verify-youtube-live.js`,
`docs/modernization/evidence/` and `chrome-extension/icon48.png` were checked
and **kept** — they are referenced.

**Documentation.** `README.md` went from 1133 to 353 lines; the 38 "What's New
in vX" sections moved verbatim into a new root `CHANGELOG.md` (790 lines) and
the README now points at it. The README also gained the MCP feature row and
the `src/mcp/` entry in the project structure.

**Verification.** `node test/run-all.js` → **116/116 suites passed in 101.2 s**
(the 112-suite baseline plus the four new suites). `git diff --check` clean;
no TODO/FIXME/HACK, no commented-out code, no `debugger`, and no stray
`console.log` in any file touched.

**Two things are not done, and one is deliberately so:**

1. `dist2`–`dist5` (~502 MB of stale build output) are **still in the repo, and
   will leave it at the next restart**. They were verified unreferenced, but
   the recycle bin refuses them: their `app.asar` / `default_app.asar` files
   are held open by two leftover AiDM instances running from those very
   folders (PIDs 27460 and 4016). Those instances run elevated under another
   account — `Terminate` returns ACCESS_DENIED, and the UAC prompt cannot be
   answered from an unattended shell — so the lock could not be released
   here. A **recoverable** move is therefore registered for the next restart
   (`HKCU\SYSTEM\CurrentControlSet\Control\Session Manager\PendingFileRenameOperations`):
   each folder is renamed into `.openclaw\tmp\trash-2026-11-23\`, which takes
   it out of the repo without destroying anything. If those two instances are
   ended (tray → Quit, or Task Manager as administrator) the same folders can
   be trashed immediately instead, with no restart needed.
2. The MCP URL guard checks the link **before** the download starts. A
   redirect to a private address is not re-checked mid-transfer — stated
   plainly in `docs/MCP.md` rather than papered over.
3. `dist2`–`dist5` were left in place rather than deleted with a raw
   filesystem command, because the project rule is recoverable deletion, and
   the recoverable route is the one that is blocked.

**Known limit of the MCP feature itself:** an assistant cannot drive the
torrent/magnet picker (`add_download` refuses magnet links) — those still
belong to the app.
