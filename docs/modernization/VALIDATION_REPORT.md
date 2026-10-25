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
