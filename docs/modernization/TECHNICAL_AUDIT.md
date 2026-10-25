# Technical Audit — AiDM v5.3.3 (baseline)

Measured on 2026-10-25 against a clean working tree at `v5.3.3`, before any change
in this cycle. Everything below was verified by reading or running the code, not
by reading the README.

## 1. Stack and shape

| Aspect | Finding |
|---|---|
| Runtime | Electron 28.3.3, Node 22 (managed runtime), Windows-first |
| Language | CommonJS JavaScript, no bundler, no TypeScript build step (`// @ts-check` annotations only) |
| Renderer | Vanilla JS + hand-written CSS variables; no framework |
| Size | **34,342 lines** across `main.js`, `preload*.js`, `src/**`, `ui/**`, `chrome-extension/**` |
| Runtime deps | 4 only: `ffmpeg-static`, `mime-types`, `uuid`, `webtorrent` |
| Tests | 67 plain-Node suites, glob-discovered by `test/run-all.js`, **67/67 green in 84.1s** |

Largest units (maintainability hotspots, unchanged this cycle):

| File | Lines |
|---|---|
| `chrome-extension/content.js` | 4,368 |
| `src/download-manager.js` | 3,033 |
| `ui/app.js` | 2,745 |
| `chrome-extension/background.js` | 2,669 |
| `src/download-engine.js` | 2,140 |
| `src/engine/task.js` | 1,157 |

These are cohesive but oversized; splitting them is a real refactor with real
regression risk and is deliberately **not** attempted here.

## 2. Security posture (verified)

Checked by grep + reading the call sites:

- **No shell execution hazards found.** Zero `shell: true`, zero `child_process.exec`,
  zero `eval(` in `src/`, `main.js`, `ui/`, `chrome-extension/`. Post-download commands
  use `spawn` with `shell: false` and a tokenizer.
- **Local API is not open.** `src/server.js` gates on `isTrustedOrigin()` (extension /
  localhost / no-Origin) *and* `isLocalHost()` (DNS-rebinding defence on the Host
  header) before routing; ACAO is not `*`.
- **Path confinement exists.** `_isAllowedSavePath()` (HTTP) and `isAiOwnedPath()`
  (IPC) restrict writes/opens to configured roots.
- **Credentials are stripped from API payloads** (`sanitizeApiPayload` drops
  `cookie`/`authorization`).

Residual risks noted, not changed: the local API authenticates by *origin* rather
than a token (fine for a desktop app, insufficient for a remote/headless mode);
`MAX_BODY_BYTES` is 128 MB, which a local hostile page could use to pressure memory.

## 3. Confirmed functional gaps (all since addressed)

| # | Finding | Evidence | Severity |
|---|---|---|---|
| 1 | `powerSaveBlocker` never referenced → an idle-sleep timer silently kills long transfers | grep across the whole tree returned nothing | High |
| 2 | No archive handling anywhere; a finished `.zip` is left as a `.zip` | no extractor module, no `unzip`/`7z`/`Expand-Archive` call | Medium |
| 3 | argv read only for `--hidden`/`--minimized`; `second-instance` ignored its argv entirely | `main.js:40`, `main.js:1095` | Medium |
| 4 | `normalizeChecksum` lowercased (so FDM's case bug is absent) but accepted any digest length and required the caller to name the algorithm | `src/engine/checksum.js` | Medium |
| 5 | No crawler of any kind | no `src/*grab*` / crawl loop | Medium |

## 4. Deliberate non-goals

- **Splitting the 3–4k-line modules.** Real value, but a multi-cycle refactor.
- **Queue-scoped scheduling.** Requires changing the single-list model; cannot be
  verified to this cycle's standard.
- **Captcha solving / link containers (DLC) / ed2k.** ToS, licensing and cost exposure
  respectively; excluded by policy, not by difficulty.
- **New runtime dependencies.** ZIP extraction was written against the standard library
  (`zlib.inflateRawSync`) specifically to avoid one.

## 5. Verification standard used this cycle

Every change had to be provable without the internet and without the GUI:

1. a dedicated `test/*.js` suite (auto-wired by the glob runner), and
2. for the two new attack surfaces (archive extraction, crawler), adversarial inputs
   — zip-slip, symlink entries, CRC corruption, robots-disallow, cross-origin links,
   self-referential link graphs — not just the happy path, and
3. for every new UI surface, an actual offscreen Electron render
   (`.workbuddy-ai/tmp/render-check.js` → PNG) rather than CSS reasoning.
