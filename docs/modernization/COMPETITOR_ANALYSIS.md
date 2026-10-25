# Competitive Analysis — AiDM v5.3.3

**Cycle:** 1 · **Research date:** 2026-10-25 · **Method:** five parallel researchers, official
sources first (vendor sites, GitHub repos/releases/issues, vendor KB), user pain points from
public issue trackers and reviews. Every claim below carries a source; anything a researcher
could not confirm is marked `UNVERIFIED` in the original briefs and excluded from decisions.

**Baseline measured before any change:** `npm test` → **67/67 suites green in 84.1s**,
working tree clean at `v5.3.3`.

---

## 1. The five competitors

| # | Product | Why it is in the set | License / stack |
|---|---------|----------------------|-----------------|
| 1 | **Internet Download Manager (IDM)** 6.43 B16 (2026-10-23) | The reference product the category is defined against | Closed, Windows-only |
| 2 | **Free Download Manager (FDM)** 6.35.2 (2026-10-23) | Free, cross-platform, torrent + media in one DM | Closed (3.9 line was GPL) |
| 3 | **JDownloader 2** (Java 25 builds, Sep 2026) | The host/decrypter + automation benchmark | Open source, Java |
| 4 | **AB Download Manager** 1.11.1 (2026-10-14) | Closest modern open-source rival; fastest cadence | Apache-2.0, Kotlin/Compose |
| 5 | **Gopeed** 2.0.0-beta.3 (2026-09-18) + **Motrix** 2.0.1 (2026-10-25) | Modern cross-platform pair; API/plugin/headless model | Open source, Go+Flutter / Electron+aria2 |

## 2. What each one is actually good at

- **IDM** — dynamic segmentation with connection reuse (the one claim rivals rarely match);
  OS-level interception from *any* application, not just browsers; recursive **site grabber**;
  FTP + NTLM/Kerberos/ISA proxies for corporate networks; lifetime licence. Ships ~12
  "403 Forbidden" fixes per 24 months — its changelog is a site-breakage treadmill.
- **FDM** — one binary family across Windows/macOS/Linux/Android; libtorrent-based torrents;
  pre-completion media preview + post-download transcode; **partial ZIP extraction** (3.9 line);
  HTML spider; sleep inhibition while a schedule is armed.
- **JDownloader 2** — link containers (DLC/CCF/RSDF/Metalink); hundreds of host plugins with
  silent independent updates; **auto-extract with password lists + CRC/SFV**; captcha pipeline
  with paid solvers; reconnect recorder; Event Scripter (JS automation).
- **AB Download Manager** — queue-first model (schedule + concurrency attach to queues);
  localhost REST API with a headless add endpoint; **app-aware throttling** ("limit only when
  other apps need bandwidth"); DoH resolver; portable mode; winget/scoop/brew packaging.
- **Gopeed / Motrix** — REST API + CLI + Docker/headless web UI (Gopeed even ships an MCP
  endpoint); JS **site-resolver extension system**; ed2k (Gopeed); aria2-grade checkpointing (Motrix).

## 3. Documented weaknesses worth attacking

| Product | Weakness | Source |
|---|---|---|
| IDM | Windows-only; **no torrent/magnet** (refused "for legal reasons"); extension unlisted in the Chrome Web Store; speed limiter is per-download only (N downloads = N × limit); dated UI | internetdownloadmanager.com FAQ (`functions2/4/8/11.html`) |
| FDM | Official Linux download page compromised 2020–2022 serving a malicious `.deb`; redesign drew a 46-reply complaint thread and needed a "classic UI" escape hatch; **hash compare is case-sensitive** (uppercase digest → false "Verification Failed", ticket #272855); macOS Safari extension breaks video playback | freedownloadmanager.org blog `?p=664`; forum `t=19012`; MacUpdate reviews |
| JDownloader | Ad-bundled default installer; JRE burden (separate installers per Java/x86/arm64); **MV3 broke its browser extension** (KB article still being updated 2026-10-23); no torrent client; JS-only automation with permission dialogs | jdownloader.org; support KB |
| ABDM | **No torrent, no yt-dlp** (maintainer: *"I don't have any plans to add ytdlp to the core app!"* #1303); "slows to 99% then errors" open ~2 years (#238); memory complaints (#123); no download-list backup (#64) | github.com/amir1376/ab-download-manager issues |
| Gopeed | Extension runtime immaturity (handlers that never settle, filed 2026-10-24); no aria2-compatible RPC; stuck at 80–90% reports | github.com/GopeedLab/gopeed issues |
| Motrix | ~5-year gap between v1.6.9 (2021) and v2.0.0 (2026); speed collapse in final 10%; unsigned Windows installers | github.com/agalwood/Motrix issues/releases |

## 4. Where AiDM already leads (verified in code, not marketing)

Checked directly against the source tree during the audit:

- **Torrent + magnet inside the DM** (`src/torrent-engine.js`, WebTorrent 2.x) — ABDM and IDM have none.
- **yt-dlp HLS/DASH pipeline** (`src/yt-dlp.js`, `src/youtube-resolver.js`) — ABDM explicitly refuses it.
- **Adaptive connection ramp + dynamic in-flight splitting** (`src/engine/ramp-controller.js`,
  `src/engine/segment-advisor.js`) — rivals ship fixed part counts.
- **aria2-style mirror pool with per-host caps** (`src/engine/mirrors.js`).
- **DoH fallback resolver** (`resolveDohIPv4` / `createDohFallbackLookup` in `src/download-engine.js`) —
  parity with ABDM 1.10.2, already present here.
- **HMAC-signed webhooks** (`src/webhooks.js`), **encrypted cookie vault** (`src/session-vault.js`),
  **checksum verification** (`src/engine/checksum.js`), **post-download command hooks**.
- **Origin + Host gating** on the local API (`isTrustedOrigin` / `isLocalHost` in `src/server.js`) —
  stronger than a bare 127.0.0.1 bind.
- **Speed timetable** (`speedRules`) — finer than rivals' flat caps or binary schedulers.

## 5. Converged gaps (≥2 independent competitors offer it, AiDM does not)

These are the only gaps that survived cross-checking, i.e. a real category expectation rather
than one vendor's quirk:

| Gap | Offered by | Verified absent in AiDM |
|---|---|---|
| **Archive auto-extract after download** | JDownloader (password lists + CRC), Gopeed (v1.9.0), FDM | no extractor anywhere in `src/` |
| **Command-line / argv URL intake** | IDM (`idman /d`), Motrix (`@motrix/cli`), Gopeed (CLI), ABDM (REST `/add`) | `main.js` only reads `--hidden`/`--minimized`; `second-instance` ignores argv |
| **Sleep inhibition while transfers/schedules are live** | FDM ("disable sleep while a download is scheduled") | `powerSaveBlocker` never referenced |
| **Recursive site grabber** | IDM (site grabber), FDM (HTML spider) | no crawler in `src/` |
| **Queue-scoped scheduling** | ABDM, FDM, IDM named queues | single list + global scheduler |
| **App-aware throttling** | ABDM 1.11.0 | flat global cap only |

## 6. Chosen attack surface for this cycle

Priority went to gaps that are (a) offered by ≥2 rivals, (b) implementable without touching the
engine's concurrency model, and (c) provable with the existing test harness. That yields the
five items in `MODERNIZATION_ROADMAP.md`. Queue-scoped scheduling and app-aware throttling are
deliberately deferred: both require restructuring the single-list model and cannot be verified
to the same standard inside one cycle.

**Anti-goals:** no competitor branding or assets, no proprietary implementation copying, no
captcha-solving pipeline (ToS risk), no ed2k (niche, protocol cost), no "AI feature" added just
to match a competitor — AiDM's AI layer has no rival counterpart and already differentiates.
