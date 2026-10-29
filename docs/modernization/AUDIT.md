# Audit — AiDM v5.8.0 modernization baseline

Baseline static review and local checks performed 2026-10-28; evidence below describes that baseline unless a remediation status says otherwise. Remediation tests on 2026-10-29 use inert metadata and execution flags inside isolated local fixtures only. No credential access, external scanning, or live-service testing was performed. Runtime consequences marked derived/inferred are not live exploit claims.

## P0 — release-blocking trust boundaries

### AUD-001 [P0] Untrusted quality metadata becomes renderer HTML
- Area: security / injection (OWASP A05), Electron privilege boundary.
- Evidence: **observed** — `/api/video-detected` forwards caller-supplied objects after only a YouTube CDN filter (`src/server.js:370-395`); the picker interpolates `video.quality` and `formatText` into `innerHTML` without escaping (`ui/app.js:1877-1884`, `ui/app.js:1939-1951`); no CSP is declared (`ui/index.html:3-8`).
- Risk: **derived** — attacker-influenced markup can create executable renderer content, exposing the privileged preload bridge.
- Fix: construct picker DOM with text nodes or escape every dynamic field; add a restrictive CSP compatible with the existing renderer.
- Verify: regression tests prove markup-like metadata renders as text and no privileged action can be triggered by it; full suite and offscreen render pass.
- Remediation 2026-10-29: **observed fixed for the reported sinks** — metadata is normalized at picker intake and escaped at both text sinks (`ui/app.js:1722`, `ui/app.js:1895`, `ui/app.js:1954`). Real Chromium checks cover literal markup, no injected elements/dialog execution, numeric metadata, selection/deduplication and submission/error flows with mocked desktop APIs. CSP remains an unimplemented defense-in-depth recommendation; this does not assert the entire renderer is injection-free.

### AUD-002 [P0] IPC download writes are not confined to AiDM save roots
- Area: security / broken access control, file integrity.
- Evidence: **observed** — HTTP requests receive path checks, but IPC add/approve/queue/import paths forward caller paths directly (`main.js:543-652`, `main.js:671-672`, `main.js:958-960`, `main.js:1066-1068`); `addDownload` accepts `savePath` and `approveDownload` joins the supplied path without containment (`src/download-manager.js:1081-1084`, `src/download-manager.js:1238-1260`).
- Risk: **derived** — a compromised renderer can write downloaded content outside configured roots.
- Fix: centralize save-path authorization in the main/manager boundary for every intake route, with an explicit user-approved location path for the location dialog.
- Verify: tests cover every IPC intake and reject outside-root paths without writing; approved dialog locations still succeed.
- Remediation 2026-10-29: **observed fixed for the reported IPC paths** — `src/save-paths.js` canonicalizes existing links and new descendants before containment checks; `main.js` guards add/approve/queue/import and settings-root edits before manager mutation. Native Browse grants are scoped to the requesting sender; approval requires an explicit path. All 20 path/IPC checks pass, including junction escapes, cancelled Browse, sender isolation, and settings-root bypass attempts. Chromium verifies visible rejection and Browse recovery with mocked desktop APIs. Native location-dialog code remains unchanged; actual desktop interaction and atomic protection against concurrent local link replacement are not verified.

### AUD-003 [P0] Page-controlled JavaScript is evaluated in the extension content script
- Area: security / injection, extension privilege boundary.
- Evidence: **observed** — KVS flashvars parsing falls back to `new Function` on inline script text (`chrome-extension/content.js:990-1009`) during normal scans; the content script is installed broadly (`chrome-extension/manifest.json:36-45`).
- Risk: **derived** — page-controlled code can execute with content-script messaging privileges rather than remaining inert page data.
- Fix: remove evaluation; parse only a strict data subset and reject anything that is not valid data.
- Verify: tests accept supported flashvars and reject functions, getters, calls, and malformed input without execution.
- Remediation 2026-10-29: **observed fixed** — `parseKvsFlashvars` in `chrome-extension/content.js` replaces evaluation with bounded data parsing. All 20 tests execute the shipped parser/extractor and cover supported literals, escapes, comments, trailing commas, inert prototype-like keys, executable constructs, malformed input, depth/size bounds, and small literals followed by unrelated large scripts. Execution flags remain unchanged; no `new Function` or `eval` remains in the content script. Live-site and signed-in extension compatibility remain untested.

## P1 — core security, reliability, and access

### AUD-004 [P1] Credential-bearing settings are exposed wholesale to the renderer
- Evidence: **observed** — `get-settings` returns the complete settings object (`main.js:924-925`), which includes AI, file-host, and proxy credentials (`src/download-manager.js:590-619`, `src/download-manager.js:662-664`).
- Risk: **derived** — renderer compromise immediately exposes reusable secrets.
- Fix: return a redacted renderer settings DTO; preserve secrets through write-only/update semantics.
- Verify: secret fields never leave main-process reads, while legitimate settings edits persist.
- Remediation 2026-10-29: **observed fixed** — `src/settings-view.js` `publicSettings()` returns a structuredClone with `aiApiKey` removed, host `password`/`cookie` cleared, proxy userinfo redacted, plus presence flags only. `main.js` wraps get/save/import/export; portable export removes credentials entirely. 10/10 settings-privacy checks; Chromium verifies redacted display and presence hints.

### AUD-005 [P1] Authorization values survive scrubbing and persistence
- Evidence: **observed** — API sanitization removes cookies but not `headers.authorization` (`src/server.js:59-75`); export and persistence use the same cookie-only approach (`src/download-manager.js:1403-1413`, `src/download-manager.js:3115-3131`).
- Risk: **derived** — bearer credentials can leak into history responses, exports, and plaintext state.
- Fix: centralize case-insensitive cookie/authorization scrubbing for all row boundaries.
- Verify: nested header variants are absent from API responses, exports, and persisted state; required in-memory replay still works.
- Remediation 2026-10-29: **observed fixed** — `src/download-privacy.js` `sanitizeDownloadPayload()` recursively removes `Cookie|Cookies|Authorization|Proxy-Authorization` (case-insensitive) from exports, the API payload, persisted state, and the rotated `.bak`. Live rows and the encrypted session vault are untouched. 10/10 download-privacy checks (13 key variants, nested metadata arrays, detached copies).

### AUD-006 [P1] Core filtering, sorting, and quality selection are pointer-only
- Evidence: **observed** — category rows are non-focusable `div` elements (`ui/index.html:110-160`); quality options are clickable `div` cards (`ui/app.js:1877-1880`, `ui/app.js:1953-1958`); sortable headers register click-only behavior.
- Risk: **inferred** — keyboard users cannot complete core journeys.
- Fix: use native buttons/radios or equivalent semantics, focus behavior, and keyboard handlers.
- Verify: keyboard-only tests traverse category, sort, and quality flows with visible focus.
- Remediation 2026-10-29: **observed fixed for the reported controls** — categories are `<button>` with `aria-pressed`; sortable `<th>` are focusable (`tabindex=0`) with `aria-sort` and Enter/Space; the quality picker is a `radiogroup` of `role=radio` options with roving tabindex and arrow keys; `:focus-visible` rings added. 19/19 contracts and 34/34 real-Chromium checks, including arrow-key selection and sort state. A screen-reader session and automated axe scan were not run.

### AUD-007 [P1] Dialogs, form labels, and feedback lack complete accessible semantics
- Evidence: **observed** — unassociated form labels (`ui/index.html:236-278`), unnamed selection checkboxes (`ui/index.html:186`), incomplete dialog semantics (`ui/index.html:229-230`), and `openOverlay` does not move initial focus (`ui/app.js:933-940`). Toasts are not live regions and vanish after 4.2 seconds.
- Risk: **inferred** — assistive-technology users may miss field names, dialog context, and failure recovery information.
- Fix: associate labels, name controls, add dialog/tab semantics and initial focus, and provide persistent error details plus polite status announcements.
- Verify: automated accessibility scan plus manual keyboard/screen-reader-oriented DOM assertions.

### AUD-008 [P1] Startup can leave an uninitialized shell with a false empty state
- Evidence: **observed** — initial IPC calls are unguarded and must resolve before listeners/rendering initialize (`ui/app.js:25-37`), while markup already says “No downloads yet” (`ui/index.html:198-205`).
- Risk: **inferred** — slow or failed IPC is indistinguishable from an empty library and can disable controls.
- Fix: explicit loading, loaded-empty, and recoverable error states; initialize shell controls independently.
- Verify: delayed, rejected, and empty IPC renders are tested offscreen.
- Remediation 2026-10-29: **observed fixed** — `setBootState(loading/ready/error)`; listeners attach before any await; the table and empty state start hidden; Retry and a successful refresh recover; a failed refresh reports an error toast. 7/7 contracts and 34/34 Chromium checks. The fixture caught a real defect (empty state re-shown after a failed load) which was fixed and re-verified.

### AUD-009 [P1] Late probe failures can leave an active transfer after the row errors
- Evidence: **observed** — late-probe guard handling marks errors without cancelling the engine task (`src/download-manager.js:2908-2950`, `src/download-manager.js:3003-3031`); `_startAborted` does not include error status (`src/download-manager.js:1466-1469`).
- Risk: **derived** — transfer state and UI state can diverge and concurrency can be exceeded.
- Fix: make terminal-error transition cancel/await the active task exactly once before advancing the queue.
- Verify: delayed dead-link/auth probes leave no active writer and no extra queue slot.
- Remediation 2026-10-29: **observed fixed** — `_failRow` cancels the engine writer (deleting junk partials), persists, emits one `download-error` and advances the queue once; terminal rows are never re-failed; `_startAborted` covers error/cancelled. 9/9 late-probe-cancel checks.

### AUD-010 [P1] Persistence is synchronous and reports success after disk failure
- Evidence: **observed** — full-list pretty serialization and synchronous writes run in the main process (`src/download-manager.js:3109-3151`); persistence and settings catches suppress all errors (`src/download-manager.js:3165`, `src/download-manager.js:3356-3364`).
- Risk: **derived** — large histories can stall IPC/UI, while disk/full/permission failures can silently lose resume state or settings.
- Fix: surface persistence failure and reduce forced main-thread writes without changing resume semantics.
- Verify: injected write failures reach the UI/log, and progress persistence is bounded and recoverable.
- Remediation 2026-10-29: **observed fixed** — non-forced writes coalesce (1.5 s floor + unref'd trailing flush), state JSON is compact, and disk failures emit `persist-error` once per streak with `persist-recovered` on recovery; the renderer shows a persistent status-bar warning. 4/4 contracts and Chromium warning/recovery. Settings-file write failures remain logged only (not surfaced) — follow-up.

### AUD-011 [P1] Archive extraction permits multi-gigabyte main-process allocation
- Evidence: **observed** — defaults allow 2 GB per entry/8 GB total (`src/archive-extract.js:38-40`), with whole-entry allocation and synchronous inflation (`src/archive-extract.js:429-450`).
- Risk: **derived** — enabled auto-extract can stall or exhaust the Electron main process before output limits help.
- Fix: stream decompression to disk with enforced byte limits and cancellation.
- Verify: oversized/compression-bomb fixtures fail within bounded memory and the app remains responsive.
- Remediation 2026-10-29: **observed fixed** — entries stream through `zlib.createInflateRaw` to a file stream with incremental CRC-32, a per-entry byte cap enforced mid-stream, and no partial file on failure; an EEXIST collision never deletes the existing file. 60/60 archive checks; a 1 KB-declared/64 MB zip bomb is refused at a 1 MB cap with a 0.9 MiB RSS delta. The default caps (2 GB/8 GB) are unchanged, so a legitimate 2 GB entry is still accepted — streamed, not buffered.

## P2 — important follow-ups

### AUD-012 [P2] Local API trusts every browser-extension origin
- Evidence: **observed** — any `chrome-extension://` or `moz-extension://` origin passes (`src/server.js:79-101`) and can access state-changing routes.
- Risk: **derived** — another installed extension with localhost permission can read/control AiDM.
- Fix: authenticate the intended extension or require a per-install pairing token without breaking recovery.
- Remediation 2026-10-29: **observed fixed** — extension trust is now an exact origin the user explicitly allows once (native Allow/Block prompt). The server holds the requesting call for the decision so "Allow" completes the action; denials are session-scoped (no permanent lockout); approvals persist to `settings.trustedExtensionOrigins` and are revocable in Settings › Browser; settings import never imports trust; malformed ids never prompt; a 60 s unanswered prompt returns 403 without blocking the origin. 52 checks cover the pure rules and a live server (approve/deny/cache/concurrency/preflight/unpersisted approval), plus 6 Chromium revocation checks. Limits: requests with NO Origin header remain trusted by design (CLI/second-instance depend on it), and the real signed-in extension was not exercised.

### AUD-013 [P2] Webhook delivery has no deadline or backlog bound
- Evidence: **observed** — fetch has no abort signal and retries immediately (`src/webhooks.js:92-120`).
- Risk: **derived** — stalled endpoints can accumulate pending deliveries.
- Fix: timeout, bounded concurrency/backlog, and backoff with tests.
- Remediation 2026-10-29: **observed fixed** — each attempt carries an AbortController deadline (default 10 s); transient failures (network, 408, 429, 5xx) retry with exponential backoff (1 s, 2 s, 4 s, capped) instead of immediately, while other 4xx responses are not retried; a single worker drains a bounded queue (default 100 pending) dropping the OLDEST entry and counting it; `close()` aborts in-flight attempts and timers and is called on app quit; `emit()` enqueues without blocking the download and `flush()` awaits delivery for tests. 26 checks cover every branch.

### AUD-014 [P2] Empty/filter states and required-field feedback are misleading
- Evidence: **observed** — all zero-result renders use “No downloads yet”; empty URL submissions return silently; refresh failure uses a success-style toast.
- Risk: **inferred** — users cannot distinguish no history, no filter matches, invalid input, or failure.
- Fix: state-specific copy, inline validation, and error styling/live feedback.
- Remediation 2026-10-29: **observed fixed** — `renderEmptyState()` separates empty-library, no-search-match and empty-category copy, with a Clear filters action that resets both inputs and a live-region container. Add URL shows an announced `aria-invalid` inline error (empty, or a non-link line with a scheme hint), keeps the dialog open, never calls IPC, and clears on edit; refresh failures use an error toast. 17 contracts + 21 Chromium checks; captures `evidence/p2-after-*.png`.

### AUD-015 [P2] Focus visibility, target size, and narrow-layout behavior need remediation
- Evidence: **observed** — custom toggles remove outlines without a replacement (`ui/styles.css:755-767`); small checkbox/clear targets and pointer-only column resizing exist; narrow overflow was not measured.
- Risk: **inferred** — focus tracking and precise pointer use are harder; responsive behavior remains partly unknown.
- Fix: visible `:focus-visible`, WCAG 2.2 target treatment, keyboard alternatives, and measured narrow-window layouts.
- Remediation 2026-10-29: **observed fixed for the reported controls** — a shared `:focus-visible` ring covers switches, checkboxes/radios, text fields, the search clear button, modal close, action buttons, context-menu items, the sidebar collapse and the column resizers; the switch re-declares its outline because its `outline: none` had higher specificity (found by the browser check). Switch is 40×24, checkboxes 16 px in spaced cells, search clear 26×26, resizer grab strip 14 px. Column resizing is now keyboard-operable (Arrow 16 px, Shift 48 px, Home resets) through labelled `<button>` handles. Narrow layouts measured at 1280/900/700 px: no page-level horizontal scroll; the table scrolls inside its container. 13 contracts + 15 Chromium checks.

### AUD-016 [P2] One baseline test depends on real machine state
- Evidence: **observed** — `test/yt-dlp-install.js:79-90` expects a real quarantine remnant that is currently absent; the full suite stops at 78/80.
- Fix: inject temp search directories into the missing-message assertion instead of reading the developer machine.
- Verify: test passes with both present and absent injected remnants from a clean environment.
- Remediation 2026-10-29: **observed fixed** — `ytdlpMissingMessage(dirs)` forwards injected directories to the existing detector; production callers retain the default search behavior. `test/yt-dlp-install.js` uses checkout-local temporary fixtures for clean/present/unrelated-remnant cases and removes the real-machine assumption. All 35 checks pass; the full suite now completes with 82/82 passing in 68.6s (`evidence/p0-full-suite.log`).

### AUD-017 [P2] Design tokens and state variants drift across app and extension
- Evidence: **observed** — centralized renderer tokens exist, but state colors bypass them and popup/capsule maintain separate hard-coded palettes; scheduler rows reuse quality-selection styling for enablement.
- Risk: **inferred** — redesign and theme changes will produce inconsistent states.
- Fix: capture a small shared token contract and semantic state variants before visual polish.
- Remediation 2026-10-29: **observed fixed for state colors** — `--state-*` (with `-bg`/`-border`) plus `--elevation-1/2`, `--focus-ring` and `--radius-sm` are defined in both desktop themes; badges and connection/network chips read them; the popup and capsule declare the same token names with surface-appropriate values. `test/ui-states.js` pins the names and the no-raw-color rules. The scheduler-row reuse of quality-selection styling is unchanged (behavioral, not a color), and typography/spacing tokens were not unified in this pass.

## Not run / unknown

- Qoder Security scan: unavailable in the listed skills; not substituted with a claim of safety.
- Full native interactive app, browser extension in a signed-in browser, screen reader, contrast measurement, narrow-window runtime rendering, live external downloads, multi-day purge, and installer-over-installer testing.
- Old technology and large modules are not defects by themselves; no broad engine/module rewrite is justified by this audit alone.
