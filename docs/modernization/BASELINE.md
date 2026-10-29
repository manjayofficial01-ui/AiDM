# Baseline — AiDM v5.8.0

Measured 2026-10-28 on branch `modernize/2026-10-28`, starting from commit `0c1eb70`. The working tree was clean before the branch was created.

## Product and architecture

- Windows-first Electron 45 desktop app, CommonJS JavaScript, vanilla renderer, no bundler, linter, or typechecker. `package.json:1-99`.
- Main entry `main.js`; renderer `ui/index.html`, `ui/app.js`, `ui/styles.css`; restricted preload bridges in `preload.js` and `preload-location.js`.
- `src/download-manager.js` owns queue/state; `src/download-engine.js` and `src/engine/` own transfers; resolver, torrent, scheduler, archive, local API, AI, and webhook modules sit around that core.
- `chrome-extension/` captures browser downloads and media and communicates with the loopback API in `src/server.js`.
- Tests are plain Node suites auto-discovered by `test/run-all.js`; Windows NSIS packaging uses electron-builder. No CI workflow was found.

## Capability probe

| Capability | Observed result |
|---|---|
| git / network | git 2.56.0 available; npm registry audit/outdated queries completed |
| Runtime | Node 25.8.1, npm 11.19.0, Electron 45.0.0 |
| Test / build | Real commands found and executed; results below |
| UI rendering | Existing mock-preload Electron screenshots inspected; driver invoked but capture freshness was not established |
| Subagents / workspace search | `Explore`, `Plan`, `general-purpose`, and `SearchWorkspace` available |
| Browser automation | `browser-use` MCP resolved; `list_pages` returned a blank Qoder browser page |
| MCP | browser-use, node-repl, Sites, Repo Wiki, QMind, settings, builtin, GitHub listed |
| Canvas | `present_visualization` available |
| Repo knowledge | No project knowledge overview was present; architecture mapped from source |
| Qoder Security | `security-scan` skill not listed; ecosystem audit fallback used |
| REA | No `rea` executable on PATH; no teardown required for this baseline |
| Computer Use | Not enabled or tested; native interactive desktop verification remains unknown |

## Command results

| Check | Result | Evidence label |
|---|---|---|
| `npm test` | **Failed.** 78/80 suites passed before `yt-dlp-install.js` exited 1; that suite had 33 passes and 1 failure. | observed |
| `node test/yt-dlp-output.js` | 23/23 checks passed. This suite was not reached by the fail-fast full run, so the combined baseline is 79 passing suites, 1 failing suite. | observed |
| Failing assertion | `test/yt-dlp-install.js:87-90` expects a real machine quarantine remnant. Direct inspection returned `remnant: null`, `hasQuarantine: false`; the injected-directory detector checks passed. | observed |
| `npm audit --json` | 0 known vulnerabilities across 456 dependencies at check time. | observed |
| `npm outdated --json` | Electron 45.0.0 → 45.1.0; mime-types 2.1.35 → 3.0.2; uuid 11.1.1 → 14.0.3. No upgrade was attempted. | observed |
| `npm run dist:win` | Failed with EPERM/EBUSY moving `win-unpacked.tmp`; `resources/default_app.asar` was locked. | observed |
| Build to separate temp output | Failed with the same EPERM/EBUSY on `default_app.asar`, so this is not specific to the existing `dist/` folder. Installer build remains unverified. | observed |
| Offscreen renderer | Four existing mock-renderer images were inspected and copied under `docs/modernization/evidence/baseline-*.png`. Driver output did not establish that these captures were newly generated; they are visual references, not proof of the current build. | limited evidence |
| Full app / live external services | Not exercised. Installed AiDM processes were left running and untouched. Live downloads, native window behavior, and installer-over-installer behavior are unknown. | unknown |

## Baseline conclusions

- Do not describe the starting point as green or release-ready: one suite fails and the installer cannot currently be built in this environment.
- The failing quarantine assertion is environment-dependent; the test comment explicitly expects machine state that is no longer present. It is a test-reliability issue, not evidence that quarantine detection itself is broken.
- Existing features are broad enough that this cycle should prioritize trust boundaries, reliable core journeys, and accessibility over adding more surface area.
