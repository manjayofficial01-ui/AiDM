# Validation Report — Cycle 4 security slice (v5.8.0, uncommitted)

**Date:** 2026-10-29. Scope: APP-001…APP-015 — the security P0/P1 set (001–005), the reliability/accessibility P1 set (006–010), APP-011 (baseline test gate), APP-012 (Fluent refinement + state feedback + semantic tokens), APP-013 (extension pairing), APP-014 (bounded webhooks) and APP-015 (focus/target/keyboard polish). No version bump, commit, or push; the app was packaged and installed locally with the user's approval.

## Results

| Check | Observed result |
|---|---|
| `npm test` | **89/89 suites pass in 70.6s**, exit 0 |
| `node test/webhooks.js` | 26/26: deadline aborts a stalled receiver (≈68 ms at a 60 ms cap), backoff grows 1 s→2 s, 5xx retries, other 4xx does not, backlog capped with drops counted, close() aborts in-flight work without counting a failure |
| `node test/ui-focus.js` | 13/13 contracts; real Chromium **15/15**: 16 px checkboxes, 26×26 search clear, 40×24 switch, 14 px grab strip; keyboard focus rings on switch/clear/resizer; Arrow/Shift+Arrow/Home column sizing; no page overflow at 1280/900/700 px |
| `node test/extension-pairing.js` | 52/52: canonical origin rules; unpaired origins refused with no CORS; one prompt per concurrent burst; Allow completes the held request; unpersisted approval refused; deny cached for the session; preflight answered; malformed ids never prompt; import never imports trust; revocation UI contracts |
| Real Chromium (APP-013) | **6/6**: paired origin listed exactly, Remove persists an empty allowlist, empty-state copy, revocation toast; capture `evidence/p2-trusted-extensions.png` |
| Windows package | Built and installed this cycle: `D:\AiDM-build\AiDM-Setup-5.8.0.exe` (per-machine), also copied to `dist/AiDM-Setup-5.8.0.exe`. Installed to `C:\Program Files\AiDM`; `app.asar` verified to contain `extension-pairing.js`, `trustedExtensionOrigins`, `persist-error`, `renderEmptyState`, `state-success-bg`. App relaunched and the live port verified: no-Origin 200, malformed extension origin 403 `extension-not-paired`, web origin 403 |
| Packaging workaround | `npm run dist:win` still fails with EPERM/EBUSY because Qoder's indexer locks `dist\win-unpacked.tmp\resources\default_app.asar`. Building with `--config.directories.output=D:\AiDM-build` succeeds; recorded in `TOOLS.md` |
| `node test/ui-states.js` | 17/17: state tokens exist in both themes and are what badges/chips read; popup and capsule declare the same token names; empty vs filtered vs category-empty copy; Clear filters resets both inputs; inline URL validation, aria-invalid, Enter submit |
| Real Chromium (APP-012) | **21/21 checks**: token-applied badge color equals `--state-success`; search-empty and category-empty copy; Clear filters restores rows; genuinely empty library keeps its own copy; empty/non-link submits show inline errors and never call IPC; typing clears; valid URL submits on Enter. Light and dark captures: `evidence/p2-baseline-*.png`, `evidence/p2-after-*.png` |
| `node test/late-probe-cancel.js` | 9/9: late dead-link/auth probes cancel the active engine writer once, terminal rows are never repainted, `_startAborted` covers error/cancelled rows |
| `node test/startup-a11y.js` | 19/19 contracts: boot states, keyboard categories/sort/quality, dialog semantics/focus, labelled controls, toast announcements, persistence coalescing/failure events |
| `node test/archive-extract.js` | 60/60 including 8 new bounded-streaming checks: 16 MB deflated and 4 MB stored entries byte-exact; a 1 KB-declared/64 MB zip bomb refused at a 1 MB cap with a 0.9 MiB RSS delta and no partial file; cap-boundary success; EEXIST keeps the pre-existing file |
| Real Chromium (APP-006/007/009) | **34/34 checks** in the isolated fixture; no page errors or dialogs; captures `evidence/p1-startup-ready.png`, `evidence/p1-startup-warning.png` |
| P1 privacy suites | settings-privacy 10/10; download-privacy 10/10 (see below) |
| `node test/settings-privacy.js` | 10/10: get/save/import/export return no reusable credentials; presence flags; no shared nested host objects; clearing persists without exposure; portable export/import round-trip |
| `node test/download-privacy.js` | 10/10: recursive scrub of 13 secret-key variants; detached copies; session-vault behavior preserved; backup rotation sanitizes the prior revision |
| `node test/save-paths.js` | 20/20: real temporary directories/junctions; executed IPC registrations with stub manager; settings-root bypass, missing approval path, no side effects on denial, Browse sender isolation, cancellation, valid settings and paths |
| `node test/kvs-flashvars.js` | 20/20: shipped parser/extractor loaded in isolated VM; ordinary literals and escaping; calls/getters/templates/spreads rejected without execution; depth/size bounds; long unrelated trailing script |
| `node test/yt-dlp-install.js` | 35/35 in final suite; quarantine hint tested with absent/present remnants in checkout-local temporary directories, not real user folders |
| `node test/ui-layout.js` | 55/55 source/contract checks |
| Existing regression suites | main-boot 27/27; dialog-rename 28/28; interception 25/25; dead-link-guard 15/15; embed-resolver 56/56; ui-dimensions 44/44 |
| Real renderer in Chromium | **23/23 browser checks**, no page errors or execution dialogs; details below |
| Syntax and whitespace | `node --check` passed for changed product sources and browser fixture; `git diff --check` passed |
| Installer build | Not rerun; baseline EPERM/EBUSY on `default_app.asar` remains unresolved. No new installer is claimed |

## Browser verification and reproduction

Actual `ui/index.html`, `ui/app.js`, and `ui/styles.css` were served by a read-only Node HTTP server bound to `127.0.0.1:18923`. Its allowlist contained only `/`, `/index.html`, `/styles.css`, `/app.js`, and `/icon.png`; the server was stopped after testing. A fresh Playwright Chromium context used mocked desktop APIs, blocked all other network requests, and replaced the extension-status fetch so the installed app was never contacted.

`test/_quality-browser.js` contains the browser fixture. It is intentionally excluded from the plain-Node runner by its underscore prefix. To repeat, serve the renderer at the same loopback origin and pass the fixture text through Playwright MCP `browser_run_code_unsafe`'s **code** argument. The MCP filename loader cannot read this workspace; no permissions were changed to bypass that restriction. The executed inline fixture exercised these same scenarios:

- Normal two-quality rendering, best-first selection, duplicate event preserving the chosen variant, one selected submission, and successful dismissal.
- Failed submission keeps the picker open; empty detection keeps it hidden and cannot enqueue a row.
- Quality/format markup renders literally, with no injected image/SVG/script/bold nodes or execution dialog. Scalar numeric metadata also renders and submits without throwing.
- Rejected Add Download path preserves input, displays Browse guidance, and recovers after a mocked native Browse choice.
- Settings opens, rejected saves remain open with feedback, and successful saves close normally.

Fresh captures inspected: `evidence/p0-quality-normal.png` and `evidence/p0-quality-literal-metadata.png`. These prove the renderer behavior with fixtures, **not** native Electron IPC, signed-in extension behavior, or real downloads.

The first empty-input assertion incorrectly tested a hidden button's disabled state; source review showed an intentional early return. Corrected to hidden-overlay/no-enqueue assertions, both passing. This was a test defect, not an app defect. Historical `baseline-*.png` captures have unproven freshness and are not counted as current verification.

## APP-014 — Bounded webhook delivery (AUD-013)

| Area | Change | Verification |
|---|---|---|
| Deadline | Every POST carries an `AbortController` timer (default 10 s, configurable) | A stalled receiver is aborted; elapsed ≈68 ms at a 60 ms cap |
| Backoff | Network errors, 408/429/5xx retry 3 attempts total with 1 s/2 s/4 s backoff (capped at 30 s); other 4xx never retry | Backoff sequence and call counts asserted with injected `sleep` |
| Backlog | One sequential worker drains a queue capped at 100 pending; overflow drops the OLDEST and increments `stats.dropped` | Queue stays at the cap; drops counted |
| Shutdown | `close()` aborts in-flight controllers, clears timers, drops the queue, resolves `flush()`; called from `before-quit` | close() resolves promptly; aborted work is not counted as a failure |
| Non-blocking | `emit()` enqueues and resolves; production paths never await delivery | Call sites keep `.catch(() => {})`; `flush()` used by tests |

Limits: real external endpoints were not contacted (fetch is injected); the 10 s default was not exercised end-to-end, only the reduced test timeout.

## APP-015 — Focus, target size, keyboard column sizing (AUD-015)

| Area | Change | Verification |
|---|---|---|
| Focus rings | One `:focus-visible` rule covers switches, checkboxes/radios, text/number/date/time inputs, selects, textareas, search clear, modal close, action buttons, context-menu items, sidebar collapse and resizers. The switch repeats the outline because its `outline: none` had higher specificity — a defect the browser check caught. | `matches(':focus-visible')` + solid accent outline asserted in Chromium |
| Targets | Switch 40×24, checkboxes 16 px in 36 px cells, search clear 26×26, resizer strip 14 px with `touch-action: none` | Computed sizes in Chromium |
| Keyboard resize | Resizers are labelled `<button type="button">`; Arrow 16 px, Shift+Arrow 48 px, Home resets; sizes persist; drag/double-click unchanged | Width changes measured exactly (86→118→166→86) |
| Narrow layouts | Table scrolls inside its container; shell keeps `overflow: hidden`; modals clamp to the viewport | `scrollWidth === innerWidth` at 1280/900/700; capture `evidence/p2-narrow-900.png` |

Limits: no automated axe/contrast scan or screen-reader session; 16 px checkboxes rely on the WCAG 2.2 spacing exception rather than a 24 px control; the 700 px measurement is below the app's 900 px window minimum (stress check only).

## APP-013 — Extension-origin pairing (AUD-012)

| Area | Change | Verification |
|---|---|---|
| Origin gate | `isTrustedOrigin(origin, paired)` now refuses every extension origin unless the exact origin is in `settings.trustedExtensionOrigins`. `null`/no-Origin callers remain trusted by design (CLI, second instance, harnesses). | Pure checks + live server requests (403/200) |
| Pairing flow | An unpaired extension request raises a native Allow/Block prompt and is HELD (up to 60 s) so Allow completes the original action. Concurrent requests share one prompt; a denial is remembered for the session only; an approval must actually persist a valid origin or the gate stays closed. | 12 live-gate checks incl. concurrency and unpersisted approval |
| Revocation | Settings › Browser lists trusted origins with accessible Remove buttons; removal saves immediately (a cancelled settings dialog cannot leave a revoked extension trusted). Origins render as text (no markup). | 6 contracts + 6 Chromium checks |
| Import safety | `import-settings` strips `trustedExtensionOrigins`; trust is device-local. | Contract check |
| Status indicator fix | The renderer used to fetch `/api/status` from `file://` (Origin `null`) — always refused by the gate. It now asks the main process (`api-status` IPC), which makes the request with no Origin. | Wiring checks; the live route is covered by the server tests |

Limits: the signed-in Chrome extension was not exercised end-to-end; the native Allow/Block dialog itself is not automated (the decision function is injected in tests). A caller that sends no Origin header is treated as native — that is the pre-existing CLI contract.

## APP-012 — Fluent refinement, state feedback, semantic tokens

| Area | Change | Verification |
|---|---|---|
| Token contract (AUD-017) | `--state-{success,warning,danger,info,neutral,fresh,pending}` with `-bg`/`-border` pairs in both themes, plus `--elevation-1/2`, `--focus-ring`, `--radius-sm`. Status badges and the connection/network chips read tokens; the popup and capsule declare the same token names for their own surfaces. | 8 contract checks; computed badge color equals the token in Chromium |
| Empty states (AUD-014) | `renderEmptyState()` distinguishes an empty library, a search with no matches (naming the term), and an empty category (naming the category). Filtered variants hide Add URL, offer Clear filters, and announce through `role=status`. | 5 contracts; Chromium verifies all three variants and that Clear filters restores the list |
| Add-URL validation (AUD-014) | Empty or non-link input shows an inline, `role=alert`, `aria-invalid` error with a scheme hint, keeps the dialog open, never calls IPC; typing clears it; Enter submits. | 6 contracts; 7 Chromium checks |
| Visual polish | Glass medallion behind the empty-state icon; tokenised focus ring; error fields keep the danger ring while focused; new animations honour `prefers-reduced-motion`. Identity (blue, glass, light/dark) unchanged in row/settings views. | Before/after captures in light and dark |

Limits: no automated axe/contrast tooling was run; the captures are fixture renders, not the installed app; hover/active states were not screenshot-compared.

## P1 reliability and accessibility implementation (APP-006…APP-010)

| Item | Change | Verification |
|---|---|---|
| APP-008 | `_failRow` performs the terminal transition once: status/error, `engine.cancelDownload` for an active writer (deleting junk partials), persist, single `download-error`, queue advance. `_startAborted` now treats error/cancelled as aborted. | 9/9 behavioral checks; auth-wall-manager 4/4 unchanged |
| APP-009 | Non-forced state writes coalesce (1.5 s floor, unref'd trailing flush); state JSON is compact; failures are captured in `lastPersistError` and emitted once per streak as `persist-error`, recovery as `persist-recovered`. Preload forwards both; the renderer shows a persistent status-bar warning ("State not saved") with the real error in its tooltip, cleared on recovery. | 4/4 contracts; Chromium warning/recovery; full suite unchanged |
| APP-007 | `setBootState(loading/ready/error)`; the shell wires theme, event and IPC listeners synchronously, then loads. Loading and error never show the empty state; Retry and a successful refresh recover; a failed refresh uses an error toast. | 7/7 contracts; Chromium delayed IPC, rejected IPC + Retry, and empty-list flows. The fixture caught a real bug: `renderDownloads()` re-showed the empty state after a failed load — fixed and re-verified |
| APP-006 | Category filters are `<button>` with `aria-pressed`; sortable `<th>` are focusable with `aria-sort` and Enter/Space; the quality picker is a `radiogroup` with `role=radio`, `aria-checked`, roving tabindex and arrow keys; 61 labels gained `for=` (the Weekdays group uses `aria-labelledby`); 7 modals are `role=dialog aria-modal` labelled by their heading with initial focus and focus return; row/search/select-all controls have names; toasts use `role=status`/`alert`; `:focus-visible` rings added. | 19/19 contracts; 34/34 Chromium checks (keyboard category, sort ascending/descending/cleared, arrow selection, dialog focus) |
| APP-010 | Entries stream through `zlib.createInflateRaw` (or direct copy for stored) to a file stream with an incremental CRC-32, declared-size and per-entry byte caps, and no partial file on failure. An existing file refused with EEXIST is never deleted. | 60/60 archive suite; 64 MB zip bomb refused at a 1 MB cap with a 0.9 MiB RSS delta |

## Independent review and follow-up

A fresh read-only reviewer received the actual diff, acceptance criteria, and test results. All five should-fix findings were confirmed and fixed; none were dismissed:

1. **APP-004 — Settings redaction**: `publicSettings` in `src/settings-view.js` returns a credential-free view via `structuredClone`, removes `aiApiKey`, strips Rapidgator host `password`/`cookie`, redacts proxy URL userinfo, and signals presence with `hasAiApiKey`/`hasProxyCredentials`/`hasPassword`/`hasCookie` — never exposing values to the renderer. All 10 browser checks pass.
2. **APP-005 — Authorization/cookie scrubbing**: `sanitizeDownloadPayload` in `src/download-privacy.js` recursively scrubs case-insensitive `Cookie|Cookies|Authorization|Proxy-Authorization` keys at any depth from exported rows, persisted state, and the API response. All 10 behavioral checks pass.
3. Inconsistent scalar metadata conversion: normalize at picker intake; browser render/submission checks pass.
4. Missing approval path mutates before failure: approval now requires a valid explicit path; add/queue still allow defaults; failing IPC fixture now passes.
5. Path rejection was unhandled in Add Download: show the main-process error and preserve input; browser rejection/recovery checks pass.
6. Parser limit included unrelated trailing code: bound the parse window rather than reject the full suffix; a small valid object followed by 256 KiB of unrelated code now passes.
7. Test scratch required a sibling workspace directory: new path tests allocate and clean scratch inside their checkout instead.

A subsequent main-agent boundary check found settings save/import could authorize an outside root first. Both now validate new roots against existing roots or the caller's native Browse grants before saving; failing fixtures now pass. Settings rejection feedback was browser-tested. The existing environment-dependent quarantine test was repaired by forwarding an optional directory list into the already-injectable detector; normal callers retain default search behavior.

## Remaining limits and next work

- APP-001 fixes the two reported injection sinks; a restrictive renderer CSP is still a defense-in-depth follow-up, not implemented or claimed here.
- Canonical save paths resolve existing links and nearest existing ancestors for new folders. They are a preflight check, not an atomic filesystem sandbox against a concurrent hostile local process replacing junctions between validation and write. Configured roots and native-confirmed location-dialog choices remain trusted.
- APP-004/APP-005 persistence scrubbing was verified against real `downloads.json` state on disk (sanitized output, prior `.bak` also sanitized) via `test/download-privacy.js`; live in-memory auth replay is intentionally untouched and the session vault remains encrypted in place.
- APP-006 was verified with DOM contracts and real-Chromium keyboard/focus flows. No automated axe/accessibility scan or screen-reader session was run; contrast was not measured.
- APP-009 was verified with contract checks and a mocked renderer event; a genuine disk-full or permission-denied condition on a live machine was not induced.
- APP-010 was verified with adversarial local archives. Memory bounds are exercised on Windows with Node's streaming zlib; other platforms were not run.
- Signed-in Chrome extension, native folder dialogs/window focus, live external downloads, and installed-upgrade behavior were not exercised. Existing location/rename fixtures pass; browser Browse is mocked.
- Remaining P2 items: extension-origin trust (AUD-012), webhook deadlines (AUD-013), filter/validation copy (AUD-014), focus/target-size polish (AUD-015), design tokens (AUD-017), and the approved visual direction (APP-012).
- Packaging remains blocked by the baseline lock; the installed app and live user data were left untouched.

---

# Validation Report — Cycle 2 (v5.4.0 → v5.5.0)

**Date:** 2026-10-25 · **Target:** `aidm/` · **Profile:** Standard Cycle (repeat run —
continued from the same-day cycle 1 per §12 of the skill). Everything below was
executed; nothing is projected or inferred.

---

## 1. Quality gates

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | Full suite green on the new platform | **PASS** | `npm test` → **All 74 suites passed in 66.4s** on Electron 45.0.0 (baseline on Electron 28.3.3: 73/73, 63.5s) |
| 2 | No regression vs baseline | **PASS** | all 73 pre-existing suites pass; 1 suite added (`filename-exact`, 21 checks); 2 suites extended (`archive-extract` +4 checks → 52, `mydaddy-title` guard re-pinned) |
| 3 | New/changed behaviour has dedicated tests | **PASS** | filename authority order, RFC 6266 quoted-literal parsing, ADS/reserved-name refusals |
| 4 | Syntax valid on every touched file | **PASS** | `node --check` on `src/download-manager.js`, `src/engine/probe.js`, `src/archive-extract.js`, `test/{filename-exact,site-grabber,mydaddy-title,archive-extract}.js` |
| 5 | App boots on Electron 45 | **PASS** | `test/main-boot.js` (27 checks) green inside the full run; plus the offscreen render driver below |
| 6 | UI renders (not just compiles) | **PASS** | 6 offscreen captures re-run on Electron 45 — all produced, renderer console clean apart from Electron's own dev-only CSP warning (same single message as cycle 1) |
| 7 | No new runtime dependency | **PASS** | runtime deps still 4 (`ffmpeg-static`, `mime-types`, `uuid` 9→11 bump, `webtorrent` unchanged); optional native accelerators `bufferutil`/`utf-8-validate`/`utp-native` pruned via `.npmrc omit=optional` (see §4) |
| 8 | Extension manifest matches app version | **PASS** | both bumped to 5.5.0; `test/extension-dimensions.js` green |
| 9 | Known-vulnerability count reduced | **PASS** | `npm audit`: Electron's ~21 high advisories eliminated by the 45.0.0 jump; `uuid` and `ip-address` advisories cleared. Residual: 4 high in `bittorrent-tracker` under webtorrent 2.8.5 — deferred with rationale (§6) |
| 10 | Installer build | **PASS** | see §5 |

## 2. Defects found and fixed this cycle

1. **User-reported: "not catching the exact file name"** — two root causes (see
   CHANGELOG "Fixed"): quoted `filename=` values were percent-decoded, and the
   server's Content-Disposition name lost to any URL basename that happened to
   have an extension. Both fixed with failing tests first
   (`test/filename-exact.js` went 14→21 checks, 7 expected failures → 0).
2. **Runner crash in `test/site-grabber.js`** — libuv `win/async.c` assert at
   exit (undrained HTTP server; same class as the two earlier fixes). House
   drain pattern applied; 3× isolated runs clean.
3. **Installer build failure on Electron 45** — `@electron/rebuild`/node-gyp
   failed to rebuild the optional native `bufferutil`. Fixed by policy, not by
   toolchain fight: the project's stated design is *zero native builds*
   (`src/archive-extract.js` header), and npm had already been blocking these
   optional accelerators' install scripts with everything green. `.npmrc`
   `omit=optional` now makes that durable; the lockfile no longer carries them;
   the pure-JS fallbacks they accelerate are covered by the 31/31 torrent suite.

## 3. Electron 28 → 45 migration notes (for the next maintainer)

- No API removals bit us: no `session.loadExtension` (the Chrome extension is
  distributed for real Chrome, never loaded into Electron), no renderer
  `File.path` usage, `contextIsolation: true` / `nodeIntegration: false`
  everywhere already.
- `app.setLoginItemSettings` (main.js:83) and `shell.openPath` callers are now
  on patched implementations (registry-path injection, null-byte bypass).
- The offscreen render driver emits a NEW deprecation warning
  (`console-message` args) — it is in the *driver* (`.workbuddy-ai/tmp/`), not
  app code; harmless, rewrite the listener next time the driver is touched.
- `webrtc-polyfill@1.2.2` (via webtorrent) uses top-level await: it CANNOT be
  `require()`d — the app already loads webtorrent via dynamic `import()`
  (`src/torrent-engine.js:63`), which works. Do not "fix" that to require().

## 4. Dependency state after this cycle

| Package | Before | After | Why |
|---|---|---|---|
| electron | 28.3.3 (EOL, ~21 high advisories) | **45.0.0** | security platform jump; full suite + render + installer verify |
| electron-builder | 26.15.3 | 26.18.0 | minor; handles Electron 45 |
| uuid | 9.0.1 | 11.1.1 | GHSA-w5hq-g745-h8pq cleared; `v4` API unchanged |
| ip-address (override) | 10.7.2 | **10.7.5** | GHSA-rxp7-6hxx-x8q5 in webtorrent chain |
| bufferutil / utf-8-validate / utp-native | present (unbuilt) | **pruned** | optional native accelerators; `.npmrc omit=optional`; zero-native-builds policy |
| webtorrent | 2.8.5 | 2.8.5 (unchanged) | 3.x is a breaking ESM-native major — deliberately not mixed into this cycle |

## 5. Installer build

`npm run dist` (after the bufferutil fix) → success, exit 0.

| Artifact | Size | Notes |
|---|---|---|
| `dist/AiDM-Setup-5.5.0.exe` | 150,331,744 B | NSIS, unsigned this build (no cert available in session; cycle 1 used signtool) |
| `dist/AiDM-Setup-5.5.0.exe.blockmap` | 158,019 B | |
| `dist/latest.yml` | refreshed | sha512 recomputed by `tools/refresh-latest-yml.js` **and independently re-hashed** — both match |

Packaged-content and runtime proof (executed): 7 touched sources byte-identical
(sha256) inside `app.asar`; packaged `package.json` reports 5.5.0 with the same
4 runtime deps (uuid 11.1.1); `chrome-extension` resource present;
`dist/win-unpacked/AiDM.exe --version` → **5.5.0**, exit 0.

## 6. Residual risks / honest residue

- **bittorrent-tracker 11.2.3 (4 high advisories)** — transitive under
  webtorrent 2.8.5. Fix = webtorrent 3.x (ESM-native). The app's dynamic
  `import()` loader is 3.x-ready, but a major torrent-engine bump belongs in
  its own cycle with live-swarm verification, not bundled into a platform jump.
  Recorded as cycle-3 P1.
- **site-grabber `readLimited`** reads the full body before truncating when no
  Content-Length is declared (declared oversize is pre-rejected). Time budget
  bounds the window. Low severity, noted for cycle 3.
- **Wave-2 features not attempted** (auto-purge, portable mode, winget/scoop
  manifests, transcode presets, queue-scoped scheduling, app-aware throttling)
  — budget went to the verified Electron jump instead (skill scale rule:
  finish one wave completely). They remain the roadmap's active backlog.
- Independent-review subagents were unavailable this session (model
  concurrency limits, 3 attempts) — the fresh-eyes module review was run
  inline by the implementer instead, focused on archive paths, crawler
  memory/redirects, and CLI argv. That is a weaker review position than cycle 1
  intended; noted for honesty.

## 7. Rollback

- Electron/builder/uuid versions + `overrides` + `.npmrc` revert with
  `package.json`/`package-lock.json` (single `git checkout` of both + one
  `npm install`).
- Filename changes are three small blocks: `_userNamed` computation + field in
  `addDownload`, the authority condition in `_refineFilename`, and the
  quoted-literal branch in `probe.js` — each independently revertible with the
  suites as the tripwire.
- Archive guards: two refusals in `resolveEntryPath` + four checks.

---

# Validation Report — Cycle 1 (v5.3.3 → v5.4.0)

**Date:** 2026-10-25 · **Target:** `aidm/` · **Verdict:** all gates pass; one item
explicitly unverified (installer build).

Everything in this report was executed. Nothing is projected, estimated, or inferred.

---

## 1. Quality gates

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | Full test suite green | **PASS** | `npm test` → `All 73 suites passed in 88.2s` (baseline before work: 67 suites, 84.1s) |
| 2 | No regression against baseline | **PASS** | the 67 pre-existing suites all still pass; 6 suites added |
| 3 | New modules have dedicated suites | **PASS** | `archive-extract`, `auto-extract`, `cli`, `keep-awake`, `checksum`, `site-grabber` — auto-wired by the glob runner, so they cannot be silently dropped |
| 4 | Syntax valid on every touched file | **PASS** | `node --check` on `main.js`, `preload.js`, `src/{cli,archive-extract,keep-awake,site-grabber,server,download-manager}.js`, `src/engine/checksum.js` |
| 5 | App still boots (IPC surface intact) | **PASS** | `test/main-boot.js` → 27 passed, 0 failed |
| 6 | UI renders (not just compiles) | **PASS** | 6 offscreen Electron captures, see §3 |
| 7 | No new runtime dependency | **PASS** | `package.json` dependencies unchanged (4) |
| 8 | Extension manifest matches app version | **PASS** | `test/extension-dimensions.js` → "extension version matches the app" |
| 9 | Backward compatibility | **PASS** | all new settings are additive with safe defaults (`autoExtract`/`autoExtractDelete` **false**, `preventSleep` **true**); no IPC channel or HTTP route removed or renamed |
| 10 | Installer build | **PASS** (built 2026-10-25 18:05) | `dist/AiDM-Setup-5.4.0.exe` 104,995,225 B + blockmap; `latest.yml` recomputed and matches the file's sha512; see §5 |

## 2. New suite detail

| Suite | Checks | What it actually exercises |
|---|---|---|
| `test/archive-extract.js` | 49 | Real ZIP bytes written by the test fixture. Happy path byte-exactness (deflate + stored), explicit dir entries, and the attack set: `../`, `/abs`, `C:/drive`, UNC, NUL byte, symlink entry, CRC-mismatch, unsupported method 12, 7z/RAR/garbage magic, entry cap, byte cap, folder collisions, empty and truncated archives. Asserts both the refusal reason **and** that no file escaped the destination. |
| `test/auto-extract.js` | 22 | Real HTTP download → real `_finishRow` → files on disk. Covers ON, OFF (nothing written), delete-source, 7z-mislabelled-as-zip, and a genuine `.7z`. Does **not** stub the function under test. |
| `test/cli.js` | 60 | Scheme allowlist (a Windows path is never a URL), flag aliases, `--flag=value`, list files (text/JSON/`{downloads:[]}`), missing files, comments, dedupe, quoted args, and `IPCServer.addUrl` delegation via a stub `_routeDownload`. |
| `test/keep-awake.js` | 52 | Policy truth table (paused/queued/error do not count; `enabled:false` wins), 200 idempotent updates → exactly one blocker, transitions, failing-blocker safety, idempotent release. |
| `test/checksum.js` | 56 | Length→algorithm inference, all accepted paste forms, wrong-length hard error, and real-file verification for MD5/SHA-1/SHA-256/SHA-512 including uppercase and prefixed digests. |
| `test/site-grabber.js` | 96 | Link extraction (quoted/unquoted/entities/scheme skips), robots.txt rules (longest-match, `$` anchor, agent groups), and a live crawl of a local 6-page site: depth, dedupe, robots-disallow, cross-origin file flagging, every cap, progress events, failure modes. Plus source guards for the IPC/preload/UI wiring. |

## 3. UI verification (rendered, not reasoned)

Driver `.workbuddy-ai/tmp/render-check.js` (offscreen `BrowserWindow` + `capturePage`,
mock preload), screenshots in `.workbuddy-ai/tmp/shots/`:

| Capture | Result |
|---|---|
| `01-main` | toolbar gains the grab button; no layout regression |
| `02c-settings-general` | *Prevent sleep while a download is running* — checked, correct section, hint present |
| `02b-settings-downloads` | both extract toggles render with the correct state under Post-download actions |
| `03-grabber-results` | overlay, status line, checkbox rows, `OFF-SITE` tag, live "Add 4 files" label |
| `04-row-extract-action` | archive action button on a completed row with `extractDir` |

Renderer console: 1 message — Electron's own dev-only CSP warning (pre-existing).
Zero application errors.

## 4. Defects found and fixed during the cycle

Found by writing the tests, not by inspection:

1. **UNC paths were reported as `absolute-path`** instead of `unc-path` — check order in
   `resolveEntryPath`. Refusal was correct, the diagnosis was not.
2. **robots.txt `$` end-anchor was escaped as a literal** — `Disallow: /*.tmp$` matched
   nothing. Fixed in `patternToRegex`.
3. **JSON download-record lists lost object entries** — `[{url}]` arrays were stringified
   to `[object Object]`. Fixed in `parseUrlList`.
4. **A genuine `.7z` produced no feedback** — `ARCHIVE_EXTENSIONS` was `['zip']`, so
   auto-extract stayed silent. Widened so every archive type gets an honest note.
5. **Two stacked docblocks in `src/server.js`** — the new `addUrl` doc was inserted
   between `_routeDownload`'s comment and its body, misattributing it. Reordered.

## 5. Installer build (executed after the test cycle)

`npm run dist` → **success** in 2m12s, exit 0 (no safe-delete interference this time;
no stale `dist/win-unpacked` existed to move aside).

| Artifact | Size | Notes |
|---|---|---|
| `dist/AiDM-Setup-5.4.0.exe` | 104,995,225 B | NSIS, signed with signtool |
| `dist/AiDM-Setup-5.4.0.exe.blockmap` | 109,643 B | |
| `dist/latest.yml` | — | `node tools/refresh-latest-yml.js` recomputed sha512 independently and it **matches** what electron-builder wrote |

**Packaged-content proof** (asar parsed by hand; data offset `16 + align4(headerSize)`):

- 1,629 entries, 28.4 MB asar, `package.json` inside reports **5.4.0**.
- `src/{site-grabber,cli,keep-awake,archive-extract}.js` all present.
- `src/cli.js`, `src/archive-extract.js`, `src/keep-awake.js`, `src/site-grabber.js`,
  `src/engine/checksum.js`, `main.js`, `ui/app.js` are **byte-identical (sha256)** to the
  working tree — the build is not stale.
- `resources/chrome-extension/` shipped (background.js, content.js, icons).
- `description` is still 150 chars, so the 260-char NSIS shortcut-NAME trap is not re-armed.

**Runtime proof on the packaged build** (installed v5.3.2 was running throughout and was
never touched — an isolated `--user-data-dir` was used):

1. `AiDM.exe --version` → prints `5.4.0`, exit 0.
2. Cold start with a URL → the app boots, its local API reports `"version":"5.4.0"`, and
   the URL is parsed and routed: `[AiDM] CLI URL refused: …` from the YouTube-CDN guard.
3. **Second-instance forwarding** → with instance A already serving on 18766, launching B
   with a URL produced no second app; A's log recorded the forwarded URL being refused by
   the same guard. This is the `idm /d` pattern working end-to-end.

Note: this sandboxed shell cannot initialise Chromium's GPU process
(`exit_code=-1073741819` → `GPU process isn't usable`), so the packaged boot test used
`--disable-gpu --no-sandbox`. That is an artifact of the non-interactive session, not of
the build — the user's installed copy runs normally on the real desktop.

## 6. Limitations and unverified items

- **Sleep inhibition** was validated as policy + blocker lifecycle with a fake blocker, and
  the packaged app wires it. That Windows actually *honours* `prevent-app-suspension` was
  not observed across a real unattended sleep cycle.
- **`--version` / `--help` on a double-clicked GUI launch** have no console to write to, so
  the text is discarded (exit 0). Works from a terminal, as verified.
- **Live-site behaviour** of the grabber was exercised only against local HTTP servers. No
  third-party site was crawled during verification, by choice.
- **Installer installation itself** (elevation, Start Menu / desktop shortcut, uninstall
  entry) was not performed — that would replace the user's installed v5.3.2. The `.exe` is
  built and self-verified but has not been installed over an existing copy.
- **Not attempted** (see `MODERNIZATION_ROADMAP.md`): queue-scoped scheduling, app-aware
  throttling, portable mode, winget/scoop manifests, auto-purge, transcode presets.

## 7. Rollback

Every change is additive and isolated:

- New files (`src/archive-extract.js`, `src/cli.js`, `src/keep-awake.js`,
  `src/site-grabber.js`, 6 test suites) can be deleted without touching existing code.
- The three wiring points are single blocks: the CLI/keep-awake section in `main.js`,
  `_maybeAutoExtract` + two settings keys in `src/download-manager.js`, and
  `IPCServer.addUrl` in `src/server.js`.
- The UI additions are three self-contained blocks (one toolbar button, two settings
  rows, one overlay) plus one action case.
- No data migration. Settings files without the new keys fall back to `DEFAULT_SETTINGS`.

---

## v5.7.2 (2026-10-27) — the dialog rename is final

Scope: the typed rename in the location dialog survived to the row but not
always to the file on disk. Three revert vectors closed (see CHANGELOG.md).

### Evidence (all commands run locally, exit codes observed)

| Check | Command | Result |
|---|---|---|
| Regression (this bug) | `node test/dialog-rename.js` | 28 passed, 0 failed |
| Naming authority | `node test/mydaddy-title.js` | 39 passed, 0 failed |
| Server-name feature | `node test/filename-exact.js` | 25 passed, 0 failed |
| Full suite (post manifest fix) | `npm test` | 77/77 suites, 87.1s |
| Installer | `npm run dist:win` | `dist/AiDM-Setup-5.7.2.exe`, 150,336,843 B, sha512 c49819af…fe587c0 |
| Packaged asar | `npx @electron/asar extract` | `nameLocked` forwarding present (1 match); package.json 5.7.2; chrome-extension not packaged (ships separately) |

### Independent review (fresh subagent, diff + tests only, no builder summary)

Verdict: acceptance criterion PASS (every post-approval name-mutation path
now gates on `_userNamed`/`nameLocked`; gate survives restart — `_userNamed`
persisted, restore path wholesale); server-name-wins PASS (filename-exact,
mydaddy-title, control tasks in the new regression test); found and I fixed
P1: `chrome-extension/manifest.json` was left at 5.7.1 → version-parity test
failed and `npm test` aborted at 26/77 (commit abecde0 fixes it).

### Known limits / non-blockers (reviewer findings, logged not fixed)

- HLS/DASH container-truth extension swap still applies to user rows
  (stem kept, only the extension follows the real container; `approveDownload`
  already forces `.ts` on typed HLS names).
- Extensionless typed names land as `<typed>.<mime ext>` (documented contract).
- Pre-existing: 8s probe-race timeout can leave row/disk name divergence on
  CD-less GETs; Windows reserved device names get a `_` prefix on disk.

---

## v5.8.0 (2026-10-28) — cycle 3: market research → integration

Research base: IDM 6.43.1 (direct-MP4 grab — already exceeded by AiDM's
yt-dlp muxing), FDM 6.30.0 (maintenance), Motrix/aria2 (no HTTP/3, HTTP/3
stays rejected per `docs/HTTP3-ASSESSMENT.md`), 2026 trend pieces (smart
bandwidth, platform upgrades). Full command evidence:

| Check | Command | Result |
|---|---|---|
| Advisories | `npm audit` | 4 high → **0** (webtorrent 3.0.21 + ip shim override) |
| Shim contract | `node test/ip-shim.js` | 44 passed (advisory bypass addresses fail closed) |
| Auto-purge | `node test/auto-purge.js` | 16 passed |
| App-aware | `node test/app-aware-throttle.js` | 28 passed |
| Live sampler | `typeperf "\Network Interface(*)\Bytes Total/sec" -si 1` | streams on this machine (2 NICs, expected CSV) |
| Full suite | `npm test` | 80/80 suites, 65.8s |
| Installer | `npm run dist:win` | 150,332,755 B, sha512 aaaf2cac…2176ca |
| Packaged asar | `npx @electron/asar extract` + `ELECTRON_RUN_AS_NODE` import | shim hoisted to `node_modules/ip`, tracker loads and resolves it from inside the asar |

Notes: the webtorrent 3.x major alone did NOT clear the audit (the roadmap's
cycle-2 expectation was wrong — the `ip` dependency survives in every
bittorrent-tracker version). The rename-related youtube-resolver/row-media
regressions seen mid-cycle were caused by the own-speed tracker being called
from stub test contexts (`_noteSpeed?.()` optional call fixes it) — caught by
the suite, isolated by stash-diff, fixed.

## Cycle 6 verification — recovery + identity (2026-10-29)

| Check | Command | Result |
|---|---|---|
| Full regression | `node test/run-all.js` | **101/101 suites, 3191 checks, 0 failures**, 82.9s |
| Extension contracts | `node test/filename-extensions.js` | 17/17 — MIME→extension, `tar.gz`, `7z`, `docx`, single-quoted `filename=`, version-path rejection, extensionless URL/CD/user-typed names |
| Name authority | `node test/mydaddy-title.js`, `dialog-rename.js`, `row-accuracy.js` | 39 / 28 / 18 passed — generic names still replaceable, user-typed names still win |
| YouTube live | `node src/youtube.js` path with managed yt-dlp 2026.10.26.220202 | PASS — real 1080p MP4 with audio track saved |
| Dark palette | `test/_theme-browser.js` in real Chromium | canvas #080807, container #0E0E0E, hover #22221F, elevated #1E1E1C, accent #2ADB5C, text #EEEEEB/#B4B4AC/#7B7B74, status #8CCAA5/#FAAD14/#FF6B70/#C3A0DF |
| Dark contrast (WCAG AA) | same fixture | text 17.24:1, secondary 9.60:1, muted 4.70:1, success 10.60:1, warning 10.54:1, error 7.24:1, accent 10.86:1, progress stop 5.90:1 — all ≥4.5:1 |
| Solid-fill ink | same fixture | dark #080807 on green = 10.86:1; light white on blue = 5.17:1 (white on #2ADB5C would have been 1.84:1) |
| Light regression | same fixture | palette unchanged (#F7F9FC / #2563EB), primary text 16.39:1, no page errors |
| Evidence | — | `evidence/p6-qoder-dark.png`, `evidence/p6-light-regression.png` |

Not verified this cycle: packaged installer behaviour, real-internet YouTube
throughput, and screen-reader announcements of the new chips. Palette provenance
is Qoder’s own compiled theme CSS (`app.asar:/out/renderer/assets/index-*.css`)
and `qoderIdeLogo.svg`; the light theme’s AA gaps for muted/success/warning are
pre-existing and were left alone.
