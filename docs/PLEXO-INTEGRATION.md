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

- `test/download-viz.js` — 49 checks (incl. `blockGridHtml` markup).
- `test/network-interfaces.js` — 40 checks.
- `test/engine-network-bind.js` — 9 checks, including a real multi-connection
  spread download (1.5 MB) that completes byte-correct (sha256), proof that
  `localAddress` is honored, and `EADDRNOTAVAIL` for an unassigned address.
- `test/plexo-ui-wiring.js` — 38 checks over the shipped files: the viz
  module loads before `app.js`, the sparkline is the SVG (no canvas left),
  BlockGrid/chips/settings/bridge wiring, and the manager's gating.

## Deliberately conservative

- Combine networks is **off by default** and capability-gated; nothing changes
  on a single-NIC host.
- No native modules, no new dependencies, no build step — the portable
  no-native-build installer goal is untouched.
- The chunk→NIC mapping is per-connection round-robin, not per-chunk
  scheduling; Plexo's traffic-shaping polish (per-network ETA weighting) is a
  possible follow-up, not a correctness requirement.
