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
