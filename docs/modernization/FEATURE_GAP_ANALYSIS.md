# Feature Gap Analysis — AiDM v5.3.3

Evidence base: `COMPETITOR_ANALYSIS.md`. Each row is scored for user value, competitive value,
effort and risk. `Status` describes AiDM **as verified in source**, not as described in README.

## Scored matrix

| # | Capability | Rivals | AiDM status | User value | Comp. value | Effort | Risk | Priority |
|---|---|---|---|---|---|---|---|---|
| 1 | Archive auto-extract on completion | JD2, Gopeed, FDM | **missing** | high — multi-part archives are a daily flow | high | M | M (new attack surface) | **P1** |
| 2 | CLI + argv URL intake | IDM, Motrix, Gopeed, ABDM | **partial** — argv only read for `--hidden` | high — scripted/batch use, "open with" | high | S | low | **P1** |
| 3 | Sleep inhibition during transfers | FDM | **missing** — `powerSaveBlocker` unused | high — overnight schedules silently die | med | S | low | **P1** |
| 4 | Recursive site grabber | IDM, FDM | **missing** | med-high — archival/bulk fetch | high | M | M (crawler safety) | **P1** |
| 5 | Checksum input normalization | FDM (broken), JD2 | **partial** — lowercases, but no length/algorithm validation | med — silent false mismatches | med | S | low | **P1** |
| 6 | Queue-scoped scheduling | ABDM, FDM, IDM | **missing** | high | med | L | high (restructures list model) | P2 — deferred |
| 7 | App-aware throttling | ABDM 1.11.0 | **missing** | med | med | M | med | P2 — deferred |
| 8 | Portable mode | ABDM, FDM 3.9 | **missing** | low-med | low | S | low | P2 |
| 9 | Partial ZIP extraction (single entry) | FDM 3.9 | **missing** | low-med | low | M | med | P3 |
| 10 | Link containers (.dlc/.ccf/.metalink) | JD2 | **missing** | low (DLC is a closed format) | low | M | legal/ToS | P3 — rejected |
| 11 | Captcha solver pipeline | JD2 | **missing** | low for a general DM | low | L | high (ToS, cost) | P3 — rejected |
| 12 | ed2k | Gopeed | **missing** | low | low | L | med | P3 — rejected |
| 13 | winget/scoop manifest | ABDM | **missing** | med (install funnel) | med | S | low | P2 |
| 14 | Auto-purge completed after N days | FDM | **missing** | med (list hygiene) | low | S | low | P2 |
| 15 | Post-download transcode presets | FDM | **missing** (ffmpeg already bundled) | med | low | M | low | P2 |

## Already at or above parity (do not rebuild)

Verified present, so excluded from the backlog: torrent/magnet, HLS/DASH via yt-dlp, HTTP/2,
adaptive ramp + dynamic splitting, mirror pool, DoH fallback, HMAC webhooks, encrypted cookie
vault, checksum hashing, post-download command hook, speed timetable, scheduler, proxy
(CONNECT + SOCKS5), browser MV3 extension with media sniffing, AI layer (categorize / explain /
NL commands / summarize).

## Selection rule applied

A gap entered this cycle's scope only if **all four** held:

1. ≥2 independent competitors ship it (category expectation, not a vendor quirk).
2. It does not require changing the engine's concurrency or the single-list queue model.
3. It can be proven by a deterministic test in the existing plain-Node harness.
4. It has no ToS, licensing, or legal exposure.

Items 1–5 satisfy all four → this cycle. Items 6–7 fail rule 2. Items 10–12 fail rule 4.
Items 8, 13–15 pass but rank below the top five on value/effort and are recorded as next-cycle work.
