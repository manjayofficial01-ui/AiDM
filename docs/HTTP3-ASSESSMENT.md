# HTTP/3 / QUIC — Integration Assessment

**Decision: NOT integrated. Documented, not built.**

## Why not

HTTP/3 runs over QUIC (UDP), not TCP. Node.js has **no built-in HTTP/3
client** — `require('http2')` exists (used by `src/engine/http2-fetch.js`), but
there is no `http3` core module, and Node has never shipped one. `undici` (the
engine behind `globalThis.fetch` and our `robustFetch`) supports HTTP/1.1 and
HTTP/2 only — it does not speak QUIC.

The only way to get HTTP/3 in Node/Electron today is a **native QUIC
implementation**:

| Option | Reality |
| --- | --- |
| `@cloudflare/quiche` | Native (Rust → N-API). Not even published under that name on npm anymore; requires compiling/linking against Electron's ABI via `electron-rebuild`. |
| `ngtcp2` / `lsquic` bindings | Native C libraries, same ABI/rebuild problem. |
| Pure-JS QUIC | None maintained. QUIC's ACK/congestion-control/crypto (TLS 1.3) is too heavy to implement reliably in userland JS; every serious implementation is native. |

## Conflict with project constraints

This app ships a **portable Electron installer with no post-install native
build step**. Adding a native QUIC dependency would mean:

- Per-platform prebuilt binaries for Windows/macOS/Linux against Electron 28's
  Node 18 ABI, or a `electron-rebuild` step in CI that currently does not exist.
- A fragile dependency that breaks the build whenever Electron bumps its ABI
  (exactly the kind of breakage the WebTorrent 2.x choice avoided — WebTorrent
  is pure-JS and needs no rebuild).

That risk is not worth taking for a feature with no throughput upside here
(see below).

## Throughput argument (even if it were free)

For a **segmented** download manager, the benefit of HTTP/3's single multiplexed
connection is already captured by opening N parallel HTTP/2 (or HTTP/1.1)
connections to the same host — which is what the engine does today. HTTP/3's
headline wins (avoiding TCP head-of-line blocking, 0-RTT, one congestion
window) matter for *many small concurrent requests*, not for *one big file split
into ranges*. aria2's own HTTP/2 request has been open since ~2015 and still
unshipped; IDM is the only manager that even mentions HTTP/2, and none of the
mainstream managers (FDM, Motrix, XDM) ship HTTP/3. There is no real-world
throughput gain for segmented downloads to justify a native dependency.

## When to revisit

Re-evaluate if **any** of these change:

1. Electron ships a Node version with a built-in HTTP/3 client (none as of
   Electron 28 / Node 18).
2. A maintained, **pure-JS** QUIC client appears on npm.
3. A concrete host is found that serves a large segmented file *only* over
   HTTP/3 (no HTTP/2 fallback) — none observed in 2025-26.

## What was built instead (related transports)

- **HTTP/2**: `src/engine/http2-fetch.js` — fetch-compatible client over
  built-in `http2`, gated by the `engineHttp2` setting (default **off**),
  selected per-request via `makeH2AwareFetch`. Falls back to HTTP/1.1
  transparently when ALPN answers http/1.1 or the URL is plain http. Covered by
  `test/http2-transport.js`.
- **Torrent/magnet**: `src/torrent-engine.js` (WebTorrent 2.x, pure-JS).
