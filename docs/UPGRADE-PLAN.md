# AiDM ← FluxDown Upgrade Plan & Integration Log

**Scope:** Faithfully port FluxDown's *download-engine brain* and missing
features into AiDM v5.1.5, modernize the UI in its design language, and ship
everything with tests. No rewrites, no framework swaps — low-risk additive
changes only.

**Status:** ✅ Complete (engine + features + UI polish + docs + tests).

---

## Phase 0 — Audit (done)
Read both codebases. Confirmed AiDM is already mature: adaptive connections,
token bucket, IDM-style split-in-half segmentation, mirrors, host gate, a
scheduler with a speed timetable, an HTTP server, and settings persistence.
Conclusion: the highest-value work was porting FluxDown's *segmentation brain*
(adaptive ramp + per-domain conn-cap learning + collapse rollback, tail
micro-split, dynamic min-split) and adding the missing **webhooks** + UI
modernization — not a rewrite.

## Phase 1 — Segment advisor (done)
Port `segment_advisor.rs` → `src/engine/segment-advisor.js`.
- `advise_static(total, {cpuCores})` and `advise_with_bandwidth(total, bw)`.
- All constants exported for parity (`MIN/MAX_SEGMENTS`, bandwidth buckets).
- `availableParallelism()` uses `os.availableParallelism` with a fallback of 4.

## Phase 2 — Adaptive ramp controller (done)
Port `segment_coordinator.rs` ramp logic → `src/engine/ramp-controller.js`.
- Exports every `RAMP_*` constant for fidelity.
- `rampVerdict(pre, cur)`, `isTail(...)`, `dynamicMinSplitBytes(bw)`,
  `shouldShrink`, `shouldExpand`, `initialAllowedWorkers`, `hintUncapCeiling`.
- `RampController`: `tick({throughputBps, alive, remaining, total, now})` →
  `{action, target, collapsedTo, connSensitive}`; drives expand / freeze /
  soft-probe / hard-freeze / collapse-rollback / shrink.
- `markConnSensitive(rolledBackTo)` for 429/503 push-back.
- `DomainConnCaps`: per-host hint + negative cap, `recordSuccess`,
  `recordCollapse`, `getHint`, `getNegative`, JSON serialize/restore, optional
  `persist` callback.

## Phase 3 — SegmentManager enhancements (done)
Edited `src/engine/segments.js`:
- New opts `dynamicMinSplit`, `tailMicroSplit`; `get currentMinSplit`.
- Refactored `splitCandidate`/`split` to share `trySplitLargest(threshold)`.
- Added `microSplitCandidate()` / `microSplit()` (FluxDown tail micro-split at
  64KB) with the straggler guard (`max_remaining >= 2*TAIL_MIN_SPLIT_BYTES`).
- `claim()` falls back to a tagged micro-split when a normal split fails and
  `tailMicroSplit !== false`.
- Tail segments are tagged (`seg.tail = true`) and surfaced in `snapshot()` so
  the UI can render them distinctly.

## Phase 4 — Task wiring (done)
Edited `src/engine/task.js`:
- Builds a `RampController` per task in `prepare()` from `domainConnCaps`
  (host hint → starting connections).
- `adapt(now)` calls `ramp.tick(...)`, handles collapse (records negative cap,
  sets `cooldownUntil`), records success hints on expand, applies
  `dynamicMinSplitBytes(speed)` to `segments.opts.dynamicMinSplit`, and refills
  on expand.
- `backOffConnections(err)` calls `ramp.markConnSensitive(next)` and
  `domainConnCaps.recordCollapse(host, next)`.
- `segmentOptions()` returns `dynamicMinSplit` and `tailMicroSplit`
  (on when adaptive connections are enabled and not forced single-connection).

## Phase 5 — Webhooks feature (done)
New `src/webhooks.js` + `download-engine.js` integration:
- `WebhookManager`: lenient endpoint parsing (skips non-objects, requires
  `^https?://`, defaults events), HMAC-SHA256 `X-AiDM-Signature: sha256=…`
  header, one retry on 5xx/throw, best-effort (never throws into the engine).
- `WEBHOOK_EVENTS = [started, completed, error, paused, resumed]`;
  `DEFAULT_EVENTS = [completed, error]`.
- Engine persists config (`~/.aidm_webhooks.json`), exposes `setWebhooks`,
  and emits at the real state transitions (including the first `downloading`
  transition via `task.on('state')`).

## Phase 6 — UI / UX modernization (done)
- ✅ Confirmed `ui/app.js` already wires `#btn-theme` to cycle
  dark → light → auto with `localStorage` persistence and `prefers-color-scheme`
  follow. No change needed; verified.
- 🐞 **Fixed segment visualization:** `renderSegments` and `segmentSignature`
  read `s.status`, but snapshots expose `s.state`. This made the bar static and
  never green-on-completion. Realigned to `state`, show a real fill fraction,
  and colour tail micro-split segments distinctly (violet).
- ➕ **Added a live adaptive-connection chip** (`active/target ×`) on each row —
  the FluxDown-style live worker count, patched in place every 250ms.

## Phase 7 — Docs & verification (done)
- `docs/FLUXDOWN-RESEARCH.md` — deep research + gap analysis.
- `docs/UPGRADE-PLAN.md` — this file.
- New tests: `segment-advisor` (12), `ramp-controller` (20), `segments-v2` (9),
  `engine-ramp` (9), `webhooks` (11).
- Regression spot-check: `engine-v4`, `engine-reliability`, `response-integrity`,
  `engine-agents`, `torrent`, `http2-transport`, `auth-wall`, `browser-engine`
  — all green (232 assertions, 0 failures).

---

## How to extend later (not done — different architecture)
1. **Multi-queue model** (`main`/`later` + per-queue speed limits). AiDM today
   uses one list + a scheduler + a global speed timetable. Folding this in is a
   structural change; recommended as a follow-up if users ask for queue
   segregation.
2. **HTTP/3 / QUIC.** Blocked by Electron's no-native-build goal — see
   `HTTP3-ASSESSMENT.md`.

## Running the tests
```bash
node test/segment-advisor.js && node test/ramp-controller.js && \
node test/segments-v2.js && node test/engine-ramp.js && node test/webhooks.js
```

---

## Chrome extension — the pill + video detection are core (v5.2.0)
A "thin companion" restructure was attempted (strip everything that looked
app-like) and then **reverted**: it removed the floating "capsule" pill and the
Facebook / Twitter video detection, which are core extension UX (IDM has them),
not app-duplicating extras. The extension is back to its full IDM-style feature
set: desktop discovery (`127.0.0.1:18765..+8`), `chrome.webRequest` media
sniffing (required — FB/TW serve video over blob/MSE, so DOM scanning alone
cannot see the real CDN URL), the capsule pill + per-video panel, DOM + network +
FB/TW detection, quality labels, native-download interception
(`chrome.downloads.onDeterminingFilename` + `shouldTakeOver`), and URL hand-off
to `POST /api/download` (plus `/api/resolve-*` delegation to the app).

Still genuinely app-duplicating and removable on request (kept for now): the
site crawler (`grabSite`/`grabFilter`/`anchorUrlsFromHtml`) and the embed/KVS/
mydaddy resolver (`resolveEmbedViaBrowser` + parsers in background.js,
`requestPlayerExtraction`/`extractKvsFlashvars` in content.js).

Full `npm test` chain is green. The extension ships via electron-builder
`extraResources`; its manifest version must equal `package.json`'s.
