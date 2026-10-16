# Plexo → AiDM integration

Research + integration notes. Source: <https://github.com/anmolkapil/plexo>
(TypeScript / Electron / React + Tailwind v4 + shadcn / Zustand). This repo is
vanilla JS/CSS — no bundler, no React — so the integration ports **concepts and
UX**, not code. Where logic is shared between the renderer and the Node test
suite it lives in one isomorphic module (`ui/download-viz.js`).

## The gap: what Plexo has that AiDM lacked

| Plexo | AiDM before | Verdict |
|---|---|---|
| **Multi-network parallelism** — spread a download's parallel connections across physical NICs (per-connection `localAddress` source-address binding; on Windows/macOS the OS routes by source IP, no `SO_BINDTODEVICE` needed). A single connection's ceiling no longer caps the download. | One default route, however many NICs are up. | **Integrated** ("Combine networks", opt-in) |
| **BlockGrid** — a byte-space map of the download: one cell per chunk, width = the chunk's share of the file, fill = that chunk's progress; started chunks floor to a 6% sliver so the first bytes are visible. | A flat equal-width segment bar (informative but not byte-true; many-connection downloads got 30+ identical slivers). | **Integrated** |
| **ThroughputChart** — a live 60s area chart of total speed, newest at the right. | A tiny canvas sparkline. | **Upgraded** to an SVG area+line chart with a live head dot, same geometry module as the Node tests assert on |
| **CyclableChip / live speed+ETA pills** | Speed + ETA already present (kept) | Already on par |
| `prefers-reduced-motion` respected on every animation | No gate | **Added** (one global CSS gate) |
| Torrent, scheduler, browser integration, queue, … | Already present | No gap |

Not ported (no gap, or wrong fit for the vanilla stack): the shadcn component
library, per-network speed pills (the tooltip on the `NET n×` chip carries the
names instead), and Plexo's `SO_BINDTODEVICE`-style interface pinning — AiDM's
approach is source-address binding, which needs no native code and works on
Windows + macOS + Linux.

## How it works

### 1. `ui/download-viz.js` — one source of truth (isomorphic UMD)

Exports (used by the renderer as `window.DownloadViz`, by tests via
`module.exports`):

- `blocksFromSegments(segs, totalBytes, opts)` — byte-width cells; coalesces to
  `opts.maxBlocks` (default 48) so a 32-connection download doesn't blow up the
  DOM. Merged cells report their range in the tooltip.
- `blockGridHtml(segs, esc)` — the markup, built with the caller's HTML
  escaper injected (no DOM needed under Node).
- `areaPath(values, w, h, pad)` — `{line, area}` SVG path `d` strings.
- `fmtEta(sec)` — Plexo's #149 rule: just under a minute reads "1m 00s",
  never "60s".
- `prefersReducedMotion(mm)`, `assignInterfaces(ifaces, tick)`.

### 2. Combine networks (main process)

- `src/network-interfaces.js` — NIC detection from `os.networkInterfaces()`
  only (no child processes, no native deps): `listActiveInterfaces()`,
  `eligibleForCombine()` (≥2 distinct global addresses, loopback/virtual
  excluded), `classifyInterfaceKind()`, `combineLabel()`.
- `download-manager.js` — setting `combineNetworks` (default **off**).
  `_networkCombine()` (1.5 s cache) returns the NIC pool; spread engages only
  when the user opted in **and** ≥2 interfaces are actually up, so a
  single-network host silently keeps the default route.
- `src/engine/task.js` — `launch()` round-robins each connection's
  `localAddress`/`family` through the pool (`assignInterfaces`), so a
  16-connection download rides every interface. If a bound connection dies
  with a network-class error (`ENETUNREACH`, `EADDRNOTAVAIL`, …) the segment
  is rebound to the default route — a dead NIC can't stall a download.
- `src/download-engine.js` / `src/engine/worker.js` — `robustFetch` threads
  `init.localAddress`/`init.family` into `client.request`.
- The engine's `progress` event now emits `connections`, `targetConnections`,
  `etaSeconds`, `networkSpread`, `networkNames`, `networkCount` (it used to
  drop several of these — a latent bug, now fixed), and segments keep
  `state` + `tail`.

### 3. Renderer

- Row progress cell: `renderSegments()` → `DownloadViz.blockGridHtml()` when
  the engine has emitted a real per-segment array; the old equal-width bar is
  kept as the fallback for count-only rows.
- Status column: live `8/8×` adaptive-connections chip (now created in place
  if it first appears mid-download) and a purple `NET 2×` chip when spreading
  (tooltip lists the NICs). The column widened to 116 px and stacks the chips
  on a second line so the fixed table layout never clips them.
- Status bar: the canvas sparkline became an SVG area+line chart
  (`DownloadViz.areaPath`) with a gradient fill and a pulsing head dot;
  `idle` state recolors it.
- Settings → Network: "Combine networks (multi-NIC)" toggle with a live hint
  ("2 networks available: Wi-Fi + Ethernet." / "Only one usable network
  detected…") fed by `get-network-interfaces`.
- `ui/styles.css`: BlockGrid cells (active blocks keep the shimmer sweep, done
  blocks turn success-green, tail micro-splits stay purple), plus one
  `prefers-reduced-motion` gate that stops every looping animation without
  removing information.

## Tests

- `test/download-viz.js` — 76 checks (incl. `blockGridHtml` markup; the
  byte-map and flow-band sections arrived with the v5.3.1 update below).
- `test/network-interfaces.js` — 40 checks.
- `test/engine-network-bind.js` — 9 checks, including a real multi-connection
  spread download (1.5 MB) that completes byte-correct (sha256), proof that
  `localAddress` is honored, and `EADDRNOTAVAIL` for an unassigned address.
- `test/plexo-ui-wiring.js` — 65 checks over the shipped files (the viz
  module loads before `app.js`, the sparkline is the SVG (no canvas left),
  BlockGrid/chips/settings/bridge wiring, and the manager's gating; the
  YouTube pane + engine wiring arrived with the v5.3.1 update below).

## Update — v5.3.1: every active row animates + the yt-dlp path

User feedback after the first integration: *"I have not got the Plexo style
download animation"* — the BlockGrid only rendered for multi-segment HTTP
downloads, so yt-dlp rows, torrents, single-connection HTTP and any row in the
connecting phase showed the old flat bar (or nothing). Two changes close it.

### Universal animated row map (`ui/download-viz.js` + `ui/app.js`)

`renderRowMap(dl)` now picks the most honest representation:

1. `segments ≥ 2` → the byte-space BlockGrid (multi-connection HTTP).
2. byte truth (`totalSize > 0`, or an engine fragment `percent`) → a
   **single-chunk byte map**: the whole file as one block, filled to the real
   percent (the 6% in-flight sliver floor extends to this map — an active row
   never reads as 0). Fragment-only rows are labeled "byte count unknown".
3. in flight with no truth yet → the **indeterminate flow band**: a sliding
   accent stripe over the empty track. It never invents a percent.
4. otherwise nothing (idle/queued rows stay quiet).

New exports: `byteBlockState(d)`, `byteBlockHtml(d, esc)`,
`flowBandHtml(esc, mm)`. States map to `done` (green), `active` (accent +
shimmer), `paused` (dimmed accent), `stalled` (muted, errors).

Updates: `rowMapSig(dl)` keys the map by **kind**
(`seg:<sig>` | `byte:<status>:b|f` | `flow` | `''`), so `patchRow` only
re-renders when the representation kind changes; byte-map fills are patched
**in place** (same DOM node) so the CSS width transition stays smooth instead
of rebuilding the cell every tick. The flow band animates purely via CSS.
Reduced motion degrades the band to a static wash, same gate as before.

### YouTube: yt-dlp freshness + user cookies (`src/yt-dlp-install.js`)

Root cause of the YouTube regression was two-fold: the shipped stable yt-dlp
(2026.08.19) lags weekly YouTube changes, and since ~Oct 2026 extraction
requires a sign-in ("Sign in to confirm you're not a bot") **even on the
nightly** — `--cookies-from-browser` is defeated by Chromium's app-bound
encryption (DPAPI) on typical machines.

- `src/yt-dlp-install.js` (new, zero deps) — shared installer used by the CLI
  tool and the in-app updater: `nightly` is the default channel
  (`yt-dlp/yt-dlp-nightly-builds`; the last main-repo prerelease was 2022, and
  the stable tag `yt-dlp/yt-dlp` lags weeks — Oct-2026 bot-wall fixes land on
  the nightly first), SHA2-256SUMS verification, staged `.new` write →
  `--version` probe → atomic rename (Windows EBUSY keeps the stage and leaves
  the old binary working). AiDM still never bundles yt-dlp: it installs
  per-user at `%LOCALAPPDATA%\AiDM\bin\` (no elevation).
- `tools/fetch-yt-dlp.js` is now a thin CLI wrapper over the installer
  (`--stable` opts out, `--check` verifies, `--dir` overrides).
- Settings → YouTube: detected yt-dlp version display, an **Update yt-dlp**
  button with live progress, and a **cookies.txt** path (Get cookies.txt with
  the "LOCALLY" browser-export flow). The path is plumbed at every probe and
  download site: `main.js` `youtubeCookieFile()`,
  `server.js` `_youtubeCookieFile()`, `download-manager.js` →
  `ytdlp.resolveUserCookieFile(setting)` → `cookieArgs()`'s `cookieFiles`
  (temp captured cookies + user file are merged; only AiDM's own temp file is
  ever deleted — the user's cookies.txt is never touched). Secrets stay in
  Netscape files (`--cookies <path>`), never on argv.
- Error copy for shipped users now points at **Settings › YouTube** (update
  engine / add cookies.txt) instead of dev-only paths.

## Tests

- `test/download-viz.js` — 76 checks (byte map + flow band sections).
- `test/yt-dlp-install.js` — 30 checks (channel choice, sums parsing, digest
  matching, asset picking, per-user dir).
- `test/yt-dlp-cookies.js` — 61 checks (`cookieFiles[]` merging,
  `resolveUserCookieFile`, "the user cookies.txt is never deleted", manager
  wiring).
- `test/youtube-resolver.js` — 206 checks (Settings › YouTube error copy).
- `test/plexo-ui-wiring.js` — 65 checks over the shipped files (map kinds,
  in-place patching, flow/paused/stalled styles, YouTube pane + engine
  wiring, the 4 server cookie sites).
- `test/main-boot.js` — invokes `yt-dlp-status` / `select-cookie-file` for
  real. Full suite: **64 suites**.

## Deliberately conservative

- Combine networks is **off by default** and capability-gated; nothing changes
  on a single-NIC host.
- No native modules, no new dependencies, no build step — the portable
  no-native-build installer goal is untouched.
- The chunk→NIC mapping is per-connection round-robin, not per-chunk
  scheduling; Plexo's traffic-shaping polish (per-network ETA weighting) is a
  possible follow-up, not a correctness requirement.
- The flow band never renders a fake percent — unknown size stays visually
  indeterminate, and fragment-only rows are labeled as such.
