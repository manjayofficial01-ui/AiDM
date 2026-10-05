# FluxDown Deep-Research & Gap Analysis

> Companion to `UPGRADE-PLAN.md`. This document records what the reference
> download manager in `reference download manager/` actually is, how its engine
> works, and where it diverges from AiDM v5.1.5. Everything below was read
> directly from the Rust source (`native/engine/src/*.rs`) — no guesses.

## 1. What the reference manager is

The folder `reference download manager/` is **FluxDown** — a multi-platform
download manager with:

- **Engine:** Rust + Tokio async runtime (`native/engine/`).
- **Desktop:** GPUI (the Zed editor's UI framework).
- **Mobile:** Flutter.
- **Web:** React.

AiDM is **Electron + vanilla JS** with its own mature engine. The two share
*almost none* of the same code, so this work is a **faithful port of algorithms
and design intent**, not a fork. Where FluxDown's ideas were clearly better, we
ported them; where AiDM already had an equivalent, we left it alone.

## 2. FluxDown engine algorithms (the port targets)

### 2.1 Dynamic segment advisor — `segment_advisor.rs`
Chooses how many segments a file *should* have.

| Constant | Value | Meaning |
|---|---|---|
| `MIN_SEGMENTS` | 1 | never go below one |
| `MAX_SEGMENTS` | 64 | hard ceiling |
| `MIN_BYTES_PER_SEGMENT` | 1 MB | a segment smaller than this is pointless |
| `SINGLE_SEGMENT_THRESHOLD` | 2 MB | files ≤ this stay single-segment |
| `BW_LOW` | 512 KB/s | bandwidth floor for the low bucket |
| `BW_MED` | 5 MB/s | |
| `BW_HIGH` | 50 MB/s | at/above this, full segment count |

- `advise_static(total)`: `by_size = total/1MB`, `io_cap = min(cpuCores*4, 64)`,
  `recommended = min(by_size, io_cap)`.
- `advise_with_bandwidth(total, bw)`: scales the static recommendation by a
  bandwidth factor — `0.5` below `BW_LOW`, interpolating to `0.75` then `1.0`
  at/above `BW_HIGH`. Never below 50% of the static pick.

### 2.2 Speed limiter — `speed_limiter.rs`
A **token bucket**: time-based refill every `REFILL_INTERVAL_MS = 50 ms`,
capacity window `CAP_DURATION_MS = 250 ms`, lock-free CAS refill, and
`limit == 0` means *unlimited*. **AiDM already ships an equivalent
`TokenBucket`** in `src/engine/rate-limiter.js`, so this was **not** re-ported.

### 2.3 Adaptive connection ramp — `segment_coordinator.rs`
The heart of FluxDown's "feels fast" behaviour. A per-task controller starts
from `RAMP_INITIAL_WORKERS` connections and, every `RAMP_TICK_SECS` window,
measures total throughput and decides one of three actions.

| Constant | Value |
|---|---|
| `RAMP_INITIAL_WORKERS` | 2 |
| `RAMP_TICK_SECS` | 2 |
| `RAMP_MIN_EVAL_WINDOW_MS` | 500 |
| `RAMP_SOFT_PROBE_COOLDOWN_TICKS` | 15 |
| `RAMP_SOFT_PROBE_MAX_ATTEMPTS` | 2 |
| `RAMP_SOFT_PROBE_TASK_BUDGET` | 6 |
| `HINT_UNCAP_MAX` | 64 |
| `MIN_SPLIT_BYTES` | 2 MB |
| `TAIL_FRACTION_DENOM` | 50 |
| `RAMP_IMPROVE_FACTOR` | 1.05 |
| `RAMP_COLLAPSE_FACTOR` | 0.5 |
| `RAMP_SHRINK_STRIKES` | 2 |
| `RAMP_PEAK_DECAY` | 0.99 |

- `ramp_verdict(pre, cur)`: **improve** if `cur > pre*1.05`, **collapse** if
  `cur < pre*0.5`, else **freeze**.
- `isTail(remaining, workerCap, total)`: true when
  `remaining < workerCap*MIN_SPLIT && remaining < total/TAIL_FRACTION_DENOM`.
- `dynamic_min_split_bytes(bw)`: `<1MB/s → 512KB`, `1–10MB/s → 1MB`,
  `>10MB/s → 2MB`.
- **Tail micro-split** (strategy 3 in `find_next_work`): when a normal split
  fails because the remaining tail is below the dynamic threshold, retry at
  `TAIL_MIN_SPLIT_BYTES = 64KB` so an idle worker can finish a slow straggler
  instead of N workers idling on one segment. A **straggler guard**
  (`max_remaining >= 2*TAIL_MIN_SPLIT_BYTES`) prevents equally-tiny tails from
  cascade-splitting into dust — the visible "99% speed drop" bug.

### 2.4 Per-domain connection-cap learning — `segment_coordinator.rs`
FluxDown remembers, per host, a **hint** (a proven-good connection count) and a
**negative cap** (a count that caused a throughput cliff or a 429/503). A new
task for that host starts at the hint rather than re-probing from 2; a collapse
rolls back and records the negative cap so it is never re-attempted.

### 2.5 Task / queue model — `model.rs`
`TaskInfo` + `QueueInfo`: a status enum (`0=pending … 5=preparing`), built-in
queues `main`/`later`, per-queue speed limits, and scheduled start/stop times.

## 3. Gap analysis vs AiDM v5.1.5

| Capability | FluxDown | AiDM before this work | Action |
|---|---|---|---|
| Segment count advisor | bandwidth-aware | size-only heuristic | ✅ Ported (`segment-advisor.js`) |
| Adaptive connection ramp | yes (improve/freeze/collapse) | yes, but hand-rolled | ✅ Replaced with faithful port (`ramp-controller.js`) |
| Per-domain conn-cap learning | yes (hint + negative) | none | ✅ Added (`DomainConnCaps`) |
| Tail micro-split + straggler guard | yes | none (the 99% drop) | ✅ Added (`SegmentManager`) |
| Dynamic min-split by bandwidth | yes | static `minSplitSize` | ✅ Added (`dynamicMinSplitBytes`) |
| Token-bucket limiter | yes | yes (equivalent) | ➖ Kept existing |
| Task-event webhooks (HMAC) | yes | none | ✅ Added (`webhooks.js`) |
| Multi-queue model (`main`/`later`) | yes | single list + scheduler | ➖ Deferred (different architecture) |
| Per-queue speed limits | yes | global speed timetable | ➖ Deferred |
| GUI framework | GPUI/Flutter/React | Electron + vanilla JS | ➖ Adapted design language only |
| HTTP/3 / QUIC | n/a | n/a | ➖ Not added (see `HTTP3-ASSESSMENT.md`) |

## 4. Deliberately NOT ported (and why)

- **Frontend frameworks.** Porting GPUI/Flutter/React into an Electron/vanilla-JS
  app is a rewrite, not an upgrade. Instead we imported FluxDown's *design
  language*: clean status badges, a live adaptive-connection chip, and an
  honest segment bar.
- **Token bucket.** AiDM's `TokenBucket` is already equivalent; re-porting would
  be churn.
- **Queue model (`main`/`later`, per-queue limits).** AiDM uses a single list
  plus a scheduler and a global speed timetable. Folding FluxDown's queue model
  in would be a structural change — out of scope for this low-risk pass, noted
  as a future enhancement.
- **HTTP/3 / QUIC.** No built-in `http3` in Node core; every QUIC client is a
  native (Rust/C) module that would break AiDM's portable no-native-build
  installer. See `HTTP3-ASSESSMENT.md`.

## 5. Integration summary (what shipped)

Engine (`src/engine/`):
- `segment-advisor.js` — `advise_static`, `advise_with_bandwidth`, `availableParallelism`.
- `ramp-controller.js` — `RampController`, `DomainConnCaps`, `rampVerdict`,
  `isTail`, `dynamicMinSplitBytes`, `shouldShrink`, `shouldExpand`.
- `segments.js` — `dynamicMinSplit`, `tailMicroSplit`, `microSplitCandidate`/
  `microSplit`, `currentMinSplit` getter, tail-segment tagging.
- `task.js` — builds the ramp controller per task, drives `adapt()` from its
  verdicts, records hint/negative caps per host, applies dynamic min-split.
- `download-engine.js` — loads/persists `DomainConnCaps`, owns a `WebhookManager`.

Features:
- `webhooks.js` — HMAC-SHA256 signed, best-effort task-event POSTs
  (`download_started/completed/error/paused/resumed`).

UI (`ui/`):
- Confirmed the light/dark/auto theme toggle + `localStorage` persistence (already present).
- Fixed the segment bar: it read `s.status` but snapshots expose `s.state`, so
  it never updated live and never turned green on completion. Now live + accurate,
  with a distinct colour for tail micro-split segments.
- Added a live adaptive-connection chip (`active/target ×`) on each row —
  the FluxDown-style worker count.

Tests (`test/`): `segment-advisor.js` (12), `ramp-controller.js` (20),
`segments-v2.js` (9), `engine-ramp.js` (9), `webhooks.js` (11) — all green.
