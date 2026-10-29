# AiDM download engine — 2026 state-of-the-art research

**Date:** 2026-10-29  
**Scope:** research and implementation recommendations only. No source, dependency, installer, or version changes were made in this pass.  
**Method:** inspect the current engine, then compare it with primary documentation for IDM, FDM, aria2, Gopeed, Motrix, AB Download Manager, WebTorrent, and the HTTP/Metalink standards.

## Executive decision

AiDM does **not** need a new download engine or a Rust/Go/aria2 rewrite. Its HTTP engine already contains the techniques most closely associated with premium download managers: dynamic in-flight segmentation, adaptive connection ramping, tail micro-splitting, per-host connection learning, mirror feedback, keep-alive connection reuse, bounded retries, HTTP/2, DoH fallback, multi-NIC routing, app-aware throttling, speed schedules, and byte-accurate resume. It also has a separate WebTorrent engine and a yt-dlp/FFmpeg media pipeline.

The next competitive advantage is to make that engine **more measurable, fair, integrity-aware, and efficient under many simultaneous transfers**:

1. **Build a reproducible engine benchmark and fail closed on TLS.** Do not optimize against marketing claims or silently weaken certificate validation.
2. **Add a work-conserving, weighted global scheduler.** Coordinate task priority, per-task limits, global connection budgets, and per-host budgets across HTTP and torrent transfers.
3. **Persist server performance profiles.** Extend AiDM's per-task mirror EMA into an aria2-style cross-task profile with latency, throughput, failures, and decay.
4. **Add bounded disk-write coalescing.** Reduce small positional writes without weakening the existing fsync-before-checkpoint crash guarantee.
5. **Add piece-level verification and repair through Metalink v4 / Metalink-HTTP.** This is the clearest missing robustness feature in the established download-engine world.
6. **Expose the advanced BitTorrent controls WebTorrent already provides.** Selective files/priorities, peer and piece telemetry, tracker policy, upload limits, and seeding rules are a larger real gap than another HTTP transport.
7. **Keep HTTP/3 deferred.** It requires a native QUIC dependency, and its principal multiplexing benefits do not automatically improve an already segmented large-file transfer.

The recommended implementation order is **measurement → transport safety → scheduler/server learning → disk I/O → integrity/multi-source → torrent controls**. Protocol breadth (FTP/SFTP), hedged tail requests, and native QUIC are lower-value follow-ups.

## Implementation status — same day

ENG-001, ENG-002, ENG-003, ENG-004, ENG-006, and ENG-007 were subsequently
implemented. The full regression suite is green at **99/99 suites**, with new
coverage for telemetry, TLS fail-closed behavior, persistent server profiles,
weighted scheduling, Metalink, piece repair, and torrent controls.

ENG-005 was evaluated against the benchmark and deliberately not implemented:
the current writer already performs comparatively large positional writes while
preserving immediate error propagation, backpressure, and the established
flush → sync → checkpoint ordering. No measured I/O overhead justified adding a
buffering layer and its crash-visibility risks.

These results verify the source behavior in this workspace. They do not verify
real-network throughput, a currently installed binary, native file dialogs, or
screen-reader behavior.

---

## 1. What AiDM already has — verified in source

This table is a source audit, not a feature-list comparison. Line numbers refer to the tree inspected on 2026-10-29.

| Capability | Current evidence | Assessment |
|---|---|---|
| Adaptive connection ramp | `src/engine/ramp-controller.js:206`, driven by `src/engine/task.js:988` | Already advanced; rivals often use fixed part counts |
| Dynamic in-flight splitting | `src/engine/segments.js:292` | Present |
| Tail micro-split with straggler guard | `src/engine/segments.js:335`, `src/engine/segments.js:349` | Present; specifically addresses the end-of-file slowdown |
| Per-domain connection learning | `src/engine/ramp-controller.js:140` | Present for concurrency hints and collapse caps |
| Mirror feedback and per-host caps | `src/engine/mirrors.js:36`, `src/engine/mirrors.js:94` | Present per task; profile is not retained across tasks |
| Keep-alive HTTP connection pooling | `src/engine/agents.js:44` | Present; IDM-style connection reuse is not missing |
| HTTP/2 with HTTP/1.1 fallback | `src/engine/http2-fetch.js:142`, `src/engine/http2-fetch.js:305` | Present, optional and off by default |
| DoH fallback | `src/download-engine.js:63`, `src/download-engine.js:90` | Present after OS-DNS failure; currently IPv4-only |
| Multi-NIC connection spreading | `src/engine/task.js:788` | Present; rare even among desktop managers |
| Global and per-task token buckets | `src/engine/rate-limiter.js:11`, `src/engine/task.js:121` | Primitive exists; public per-task control and fair scheduling do not |
| App-aware throttling | `src/bandwidth-watch.js:24`, `src/download-manager.js:546` | Already implemented on Windows through `typeperf`; not a new gap |
| Scheduled starts and speed timetable | `src/download-manager.js:572` | Present |
| Retry with exponential backoff, jitter, Retry-After | `src/engine/retry.js:11` | Present |
| Slow-connection detection | `src/engine/worker.js:7`, `src/engine/task.js:925` | Present |
| Resume validators and exact segment maps | `src/engine/task.js:481`, `src/engine/task.js:1115` | Present |
| Crash-safe segment checkpoints | `src/engine/control-file.js:21`, `src/engine/task.js:1060` | Present; writer sync precedes progress checkpoint |
| Whole-file checksum verification | `src/engine/checksum.js:182` | Present, including normalization and algorithm inference |
| Sparse/full preallocation and positional writes | `src/engine/file-writer.js:29`, `src/engine/file-writer.js:54` | Present; no write coalescing layer |
| Torrent/magnet | `src/torrent-engine.js:52` | Present through WebTorrent 3.x; control surface is basic |
| HLS/DASH and YouTube | `src/download-manager.js:2202`, `src/download-manager.js:2303` | Present through native HLS and yt-dlp/FFmpeg paths |
| FTP, SFTP, Metalink, piece-hash repair | No implementation found in `src/` | Genuine protocol/integrity gaps |
| Queue priorities / weighted fairness | `_processQueue` at `src/download-manager.js:2629` walks FIFO order | Genuine scheduling gap |
| Conditional re-download (`If-Modified-Since` / `If-None-Match`) | No conditional-GET implementation found | Genuine refresh/update gap, not a raw-speed gap |

### Important correction to earlier competitive assumptions

Two features that might otherwise be proposed as “new” are already present:

- **Connection reuse:** `src/engine/agents.js` pools sockets with keep-alive.
- **App-aware throttling:** `src/bandwidth-watch.js` subtracts AiDM's own speed from total NIC throughput and applies a polite cap only while other traffic is active.

Rebuilding either would be churn.

---

## 2. What the current leaders actually teach

### IDM: dynamic segmentation and reuse, not magic throughput

The [official IDM feature page](https://www.internetdownloadmanager.com/features.html) advertises smart dynamic segmentation, reuse of available connections, resume, scheduling, quotas, HTTP/FTP/HTTPS/MMS, proxies, and a site grabber. Its “up to 8 times” statement is a vendor marketing claim, not a reproducible guarantee.

**AiDM conclusion:** the two central engine ideas are already implemented. Further increasing a fixed connection count is not the lesson; better adaptation and measurement are.

### FDM: breadth and traffic management

The [official FDM feature page](https://www.freedownloadmanager.org/features.htm) documents splitting files into sections, simultaneous downloading, resume, BitTorrent, scheduling, and bandwidth/traffic modes.

**AiDM conclusion:** HTTP acceleration and scheduling are already at parity. Torrent lifecycle/control depth and integrity-aware multi-source support are more useful next steps.

### aria2: the strongest model for engine robustness

The [aria2 manual](https://aria2.github.io/manual/en/html/aria2c.html) documents:

- segmented downloads with `--split`, `--min-split-size`, and per-server caps;
- per-download and overall rate limits, plus lowest-speed disconnect;
- persistent server performance profiles (`--server-stat-of` / `--server-stat-if`) and feedback/adaptive URI selection;
- conditional GET, asynchronous DNS, disk cache, and file allocation;
- whole-file and real-time chunk verification;
- HTTP(S), FTP, SFTP, BitTorrent, and Metalink;
- DHT, peer exchange, web seeding, and selective downloads.

The [aria2 README](https://github.com/aria2/aria2) also lists persistent connections, HTTP proxy support, IPv6 with Happy Eyeballs, and disk caching.

**AiDM conclusion:** copy the *ideas* of persistent host learning, piece verification, and bounded I/O—not the process architecture. Embedding aria2 would duplicate AiDM's adaptive engine and complicate the UI contract.

### Gopeed and Motrix: protocol breadth and BitTorrent control

The [Gopeed repository](https://github.com/GopeedLab/gopeed) documents multi-connection HTTP, DHT, uTP, Web Seeds, selective file downloads, tracker management, and peer/piece statistics. The [Motrix repository](https://github.com/agalwood/Motrix) documents HTTP/FTP/BitTorrent/magnet support, up to 64 threads per task, tracker updating, UPnP/NAT-PMP, and speed limits.

**AiDM conclusion:** “64 connections” is a configuration ceiling, not evidence of superior performance. AiDM's adaptive cap is a better default. The actionable gap is torrent control and observability, not matching a connection-count label.

### AB Download Manager: adaptive bandwidth is now established

The [AB Download Manager releases](https://github.com/amir1376/ab-download-manager/releases) record built-in DoH in v1.10.2 and an option to limit download speed while using other apps in v1.11.0.

**AiDM conclusion:** both ideas already exist here. The next step is fair allocation *within* AiDM, which app-aware throttling does not solve.

### WebTorrent: much of the missing torrent control is already in the dependency

The [WebTorrent documentation](https://webtorrent.io/docs) documents `urlList`, `maxWebConns`, download/upload limits, connection limits, tracker/DHT/LSD/ut_PEX options, `torrent.select`, and `file.select`. The [WebTorrent README](https://github.com/webtorrent/webtorrent) documents TCP/UDP in Node, WebRTC in the browser, magnet metadata, DHT, trackers, LSD, and peer exchange.

**AiDM conclusion:** expose and test these controls before considering another torrent library or native uTP/UPnP work.

---

## 3. Highest-value upgrade program

### ENG-001 — Reproducible benchmark and telemetry foundation

**Priority: P0. Effort: M. Risk: low.**

There is currently no basis for an honest “fastest engine” claim. Build a deterministic local fixture plus an opt-in real-network benchmark that records:

- total throughput and time to first byte;
- time to reach stable throughput;
- active/target connections over time;
- time spent in the final 5% and final 1%;
- retries, reconnects, 429/503 responses, and slow-worker drops;
- per-mirror throughput and failure rate;
- disk-write count, bytes per write, queue delay, and sync latency;
- per-task share when several tasks run together;
- RSS and CPU while idle, ramping, and finishing.

The local fixture should emulate Range/No-Range, chunked/unknown length, throttled connections, stalls, 416/400/401/403, Retry-After, changing ETags, short reads, mirrors with different speeds, and crash/restart. Real-network tests must be explicitly opt-in and must never be presented as deterministic CI.

**Exit criterion:** a repeatable baseline exists before and after every performance slice; regressions report throughput, tail time, fairness, and resource use separately.

### ENG-002 — Fail closed on TLS and unify transport policy

**Priority: P0. Effort: S–M. Risk: behavior change on broken TLS hosts.**

`robustFetch` currently retries with `rejectUnauthorized: false` after a TLS-class error (`src/download-engine.js:281`). `_openRequestAuto` has a similar fallback (`src/download-engine.js:1121`). A robust modern engine must not silently turn a certificate failure into an unauthenticated transfer.

Recommended behavior:

- certificate validation stays enabled by default;
- TLS failures produce a clear, actionable error;
- any insecure mode is an explicit, narrow, visible user decision—not an automatic retry;
- HTTP/1.1 and HTTP/2 share redirect credential stripping, proxy policy, DNS policy, connect/read deadlines, and telemetry;
- HTTP/2 remains a negotiated optimization with clean HTTP/1.1 fallback, not a separate weaker trust path.

Node's [net documentation](https://nodejs.org/api/net.html) shows Happy Eyeballs-style family autodetection is already enabled by default in supported Node lines, but is bypassed when `localAddress` is set. Preserve the intentional NIC binding behavior and document/test that exception rather than adding a second hand-rolled family racer.

**Exit criterion:** no automatic certificate-verification bypass; equivalent redirects, deadlines, proxy behavior, and sensitive-header handling across transports.

### ENG-003 — Work-conserving weighted scheduler

**Priority: P0/P1. Effort: L. Risk: high; touches concurrency.**

The current manager starts up to `maxConcurrentDownloads` rows in FIFO order. The global token bucket limits bytes but does not guarantee a fair or priority-weighted share, and a single task can consume many connections while another waits.

Build the scheduler around the **actual** `DownloadManager` lifecycle rather than reviving the partially unused coordinator facade in `src/engine/engine.js`.

Required behavior:

- task priorities (for example high/normal/low plus manual reorder);
- work conservation: unused capacity is immediately available to runnable tasks;
- weighted bandwidth sharing under a global cap, without idle quanta when only one task is active;
- optional per-task speed limits using the existing task bucket;
- global, per-host, and per-task connection budgets;
- no starvation: aging eventually lets low-priority work run;
- consistent accounting for HTTP, yt-dlp, HLS, and torrent rows;
- deterministic pause/resume/cancel and no queue loss on non-starting rows.

**Exit criterion:** two or more tasks receive the configured shares under saturation; one task still receives the full available budget; host caps and pause/cancel invariants remain green.

### ENG-004 — Persistent server performance profiles

**Priority: P1. Effort: M. Risk: medium.**

`MirrorPool` already ranks mirrors by per-task speed EMA, while `DomainConnCaps` persists concurrency hints. Combine the concepts into a bounded host-profile store containing:

- throughput EMA and confidence/sample count;
- connect latency and time to first byte;
- failure/rate-limit/collapse history;
- Range and HTTP/2 capability observations;
- last-used timestamp and time decay;
- separate entries by scheme/host/port and, where needed, proxy/route class.

Use the profile to choose initial mirrors and connection hints, but keep probing untested mirrors so one historical result cannot permanently blacklist a recovered server. Bound entries and persistence churn. Never store URLs, cookies, authorization headers, signed query strings, or response bodies in this profile.

This is the AiDM-native equivalent of aria2's server-stat/feedback model.

**Exit criterion:** a later task prefers a historically faster healthy mirror, recovers from stale profiles, respects collapse history, and persists no credentials.

### ENG-005 — Bounded write coalescing and backpressure

**Priority: P1 after benchmark. Effort: M. Risk: medium-high for crash correctness.**

Each network chunk currently becomes positional `FileHandle.write` work. On high-throughput or slower-disk systems this can create unnecessary I/O overhead. Add a writer layer with:

- per-segment contiguous-run coalescing;
- a global memory ceiling and per-task ceilings;
- adaptive buffer targets based on measured disk latency, not unbounded “disk cache”;
- explicit backpressure to network readers;
- ordered flush on pause, cancel, finalize, checkpoint, and shutdown;
- no dropping non-contiguous ranges or writing beyond validated segment bounds.

The existing invariant in `src/engine/task.js:1060` must remain: **flush writes → sync file → persist checkpoint**. A checkpoint must never claim bytes that exist only in RAM.

**Exit criterion:** fewer syscalls under the benchmark, bounded RSS, identical bytes after random pause/crash injection, and no checkpoint-ahead-of-data regression.

### ENG-006 — Metalink and piece-level repair

**Priority: P1/P2. Effort: L. Risk: medium-high (untrusted metadata and new sources).**

[RFC 5854](https://www.rfc-editor.org/rfc/rfc5854) defines Metalink mirror lists, whole-file hashes, piece hashes, and signatures. [RFC 6249](https://www.rfc-editor.org/rfc/rfc6249) defines HTTP Link/Digest mechanisms for mirrors and instance/partial digests.

Add support in two stages:

1. `.meta4` / `.metalink` ingestion with safe XML parsing, size/schema limits, mirror priorities, and whole-file hashes.
2. Piece hashes and real-time verification so a corrupt range is re-fetched from a healthy mirror instead of failing only after the entire file finishes.

Security invariants:

- only approved schemes; no `file:`, `javascript:`, or credential-bearing mirror URLs;
- do not forward cookies or authorization across origins;
- cap XML size, mirror count, piece count, and expanded resource use;
- verify the final size and whole-file hash even when every piece passed;
- never treat metadata alone as proof that a mirror is trustworthy.

[RFC 9110 §14](https://www.rfc-editor.org/rfc/rfc9110#section-14) remains the Range/206/416/If-Range contract. Existing response-integrity and resource-change tests must apply to every new source.

**Exit criterion:** corrupted-piece fixtures repair only the bad ranges; mirror failover retains integrity; malicious metadata cannot inject schemes, credentials, paths, or unbounded work.

### ENG-007 — BitTorrent control-plane upgrade

**Priority: P1/P2. Effort: M–L. Risk: medium.**

The HTTP engine is substantially more adaptive than the current torrent wrapper. Expose documented WebTorrent capabilities incrementally:

- file selection and file/piece priorities;
- selective-download progress based on selected bytes, not the whole torrent;
- per-torrent and global download/upload limits;
- seed ratio / seed-time / stop-after-done policy;
- tracker add/remove and clear status;
- peer count, peer addresses only where privacy policy permits, piece completion, and web-seed stats;
- DHT/LSD/PEX controls with safe defaults;
- correct multi-file resume and selected-file changes across restarts.

Keep uTP and UPnP/NAT-PMP as separate feasibility items. They are not prerequisites for a major improvement, and native networking dependencies would conflict with the current portable packaging model.

**Exit criterion:** selective downloads complete honestly, upload/seeding limits hold, resume preserves selection, and progress never reports unselected bytes as required work.

### ENG-008 — Conditional refresh and generic signed-URL re-resolution

**Priority: P2. Effort: M. Risk: medium.**

Two different features are useful but should not be conflated:

- **Conditional GET:** for a completed local file, use `If-Modified-Since` or `If-None-Match` and honor 304 rather than downloading an unchanged resource again (aria2 exposes a conditional-get mode).
- **Re-resolution:** for an expiring CDN URL, call the owning resolver again on authentication/expiry failure, then resume only if size and strong validators prove it is the same entity. YouTube and Drive already have dedicated re-resolution flows; this would generalize the pattern.

Never resume a refreshed URL solely because the filename matches.

---

## 4. Features deliberately deferred or rejected

| Feature | Decision | Reason |
|---|---|---|
| HTTP/3 / QUIC | **Defer** | No built-in Node HTTP/3 client; serious QUIC clients require native modules. Segmented HTTP already supplies parallel streams. Revisit only with a maintained pure-JS client, built-in runtime support, or a demonstrated host that requires it. See `docs/HTTP3-ASSESSMENT.md`. |
| Rewrite in Rust/Go or embed aria2 | **Reject** | Duplicates a sophisticated existing engine, risks regressions, and does not itself create throughput. Port proven algorithms instead. |
| Raise every task to 32/64 fixed connections | **Reject** | Increases server pressure and can trigger rate limiting. AiDM's measured ramp/collapse behavior is the better default. |
| AI/reinforcement-learning congestion control | **Reject for production** | Unnecessary complexity and difficult to validate. Deterministic throughput feedback already drives the ramp controller. |
| Hedged/duplicate tail requests | **Experiment only** | Can reduce a slow final range but duplicates traffic and server load. Consider only after tail benchmarks, with strict spare-capacity and near-EOF gates. |
| FTP/FTPS/SFTP | **P3 / demand-driven** | Useful for compatibility, not a modern HTTP performance upgrade. Adds protocol, credential, resume, and test surface. |
| Native uTP or UPnP/NAT-PMP | **P3** | Potential torrent connectivity benefit, but secondary to exposing existing WebTorrent controls; native dependency and network-permission costs must be assessed separately. |
| ed2k, captcha solving, DRM/access-control bypass | **Reject** | Niche protocol cost or explicit legal/ToS/security exposure; unrelated to engine performance. |

---

## 5. Proposed target shape

```text
DownloadManager (single lifecycle owner)
  └─ Global weighted scheduler
       ├─ task priority + aging
       ├─ global/per-task/per-host connection budgets
       └─ global/per-task bandwidth budgets
            │
            ├─ HTTP task
            │    ├─ adaptive ramp + dynamic/tail splitting (keep)
            │    ├─ persistent host profiles + mirror feedback
            │    ├─ validated HTTP/1.1 ↔ HTTP/2 transport policy
            │    ├─ optional piece-hash verification/repair
            │    └─ bounded coalescing writer → sync → checkpoint
            │
            ├─ Torrent task
            │    └─ WebTorrent selection, tracker, limits, telemetry, seeding
            │
            └─ Media task
                 └─ HLS / yt-dlp progress + the same scheduler accounting
```

This is an evolution of the current engine, not a second engine beside it.

---

## 6. Recommended delivery sequence

| Slice | Contents | Why this order |
|---|---|---|
| 0 | ENG-001 benchmark + current-baseline evidence | Establishes what actually needs optimization |
| 1 | ENG-002 TLS/transport policy hardening | Robustness and trust before more concurrency |
| 2 | ENG-004 host profiles + ENG-003 scheduler in small steps | Highest cross-task throughput and reliability value |
| 3 | ENG-005 bounded writer, gated by benchmark results | Attacks measured I/O overhead without weakening crash safety |
| 4 | ENG-006 Metalink/piece repair | Largest remaining HTTP integrity/multi-source feature |
| 5 | ENG-007 torrent controls | Large feature gain using the existing dependency |
| 6 | ENG-008 and demand-led protocol work | Useful breadth after the core is proven |

ENG-003 and ENG-004 can be developed independently but must be integrated behind one scheduler/accounting model. ENG-005 should not ship on intuition alone; keep it only if benchmarks improve without durability regressions.

## 7. Verification standard for every engine slice

1. Existing plain-Node suites remain green.
2. New deterministic contract tests cover success, retry, stall, pause, cancel, crash, and hostile input.
3. Performance claims include before/after logs on the same fixture and machine.
4. A real UI run verifies row state, pause/resume, queue behavior, and error reporting.
5. Memory ceilings are measured with multiple large files and many segments.
6. No credentials, signed URLs, or sensitive headers enter profiles, logs, benchmarks, or webhooks.
7. Any item not run is reported as **not verified**, not implied by unit-test coverage.

## 8. Research limitations

- No live internet throughput benchmark was run in this research pass; no “X times faster” claim is made.
- Competitor behavior is based on official documentation, not reverse engineering or independent measurements of proprietary engines.
- WebTorrent opportunities are based on its documented API; each control still needs an integration test in Electron.
- Actual gains from write coalescing, mirror learning, and scheduling depend on host, disk, network, and server behavior and must be measured locally.

## Sources

- [IDM — official features](https://www.internetdownloadmanager.com/features.html)
- [FDM — official features](https://www.freedownloadmanager.org/features.htm)
- [aria2 — official manual](https://aria2.github.io/manual/en/html/aria2c.html)
- [aria2 — official repository](https://github.com/aria2/aria2)
- [Gopeed — official repository](https://github.com/GopeedLab/gopeed)
- [Motrix — official repository](https://github.com/agalwood/Motrix)
- [AB Download Manager — official releases](https://github.com/amir1376/ab-download-manager/releases)
- [WebTorrent — official API documentation](https://webtorrent.io/docs)
- [WebTorrent — official repository](https://github.com/webtorrent/webtorrent)
- [RFC 9110 — HTTP Semantics, including Range Requests](https://www.rfc-editor.org/rfc/rfc9110#section-14)
- [RFC 5854 — Metalink Download Description Format](https://www.rfc-editor.org/rfc/rfc5854)
- [RFC 6249 — Metalink/HTTP](https://www.rfc-editor.org/rfc/rfc6249)
- [RFC 9114 — HTTP/3](https://www.rfc-editor.org/rfc/rfc9114)
- [Node.js net documentation — family autodetection](https://nodejs.org/api/net.html)
