# YouTube engine (yt-dlp + FFmpeg) — design, analysis, limits

AiDM v4.4.0. Implementation: `src/yt-dlp.js`, `src/youtube-resolver.js`,
wiring in `src/resolvers.js` + `src/download-manager.js`, installer
`tools/fetch-yt-dlp.js`, tests `test/youtube-resolver.js` (104 checks, offline).

---

## 1. Why a normal download manager fails on YouTube

| Symptom | Real cause | AiDM's response |
|---|---|---|
| Saves an HTML file | `watch?v=…` is a **web page**; the media URL lives in player-side JS | Resolver turns the page URL into a media list; the page URL is never downloaded as a file |
| Video has no sound | Above ~720p YouTube serves **separate** DASH picture and sound tracks | DASH choices are downloaded and merged (`--merge-output-format mp4`, bundled FFmpeg) |
| A link that worked returns 403 | Stream URLs are **signed and expire** (minutes) | Rows store the *page* URL + format ids; yt-dlp re-extracts fresh URLs on every start |
| Extraction breaks after a site change | Player/n-signature/PO-token logic changed | yt-dlp tracks it; AiDM keeps no extractor of its own |
| "Sign in to confirm you're not a bot" | Anti-abuse challenge on the network/account | Reported as an error — never worked around |
| Age / members / private / rental | Access control | Reported as an error — never worked around |

**The core rule:** never hand a raw stream URL to a download manager and hope.
Extract → download → merge in one pass, so no fragile URL is ever persisted.

---

## 2. Review of the reference FastAPI design (what we kept, fixed and dropped)

The reference implementation was a **single-process Python/FastAPI service on
Linux/macOS**. AiDM is a **Windows-first Electron desktop app with an existing
multi-segment engine, queue, pause/resume and a Chrome extension**. Porting it
literally would have been wrong; here is the diff of decisions.

### Kept (the parts that are genuinely right)

* **yt-dlp + FFmpeg instead of a hand-written extractor.** Correct and the
  single most important decision.
* **Canonicalise the input to `https://www.youtube.com/watch?v=<id>`.**
  Kept, and hardened — see below.
* **Never expose extractor logs or signed URLs to callers.** Kept as `redact()`
  (strips `sig`, `s`, `pot`, `token`, …) and short, classified error messages.
* **Bounded concurrency, hard timeouts, output-size sanity check, cleanup of
  intermediates.** Kept in spirit; the desktop queue and engine already provide
  most of it, and the yt-dlp child gets a wall-clock cap + process-tree kill.
* **Explicit "restricted content returns a failure" policy.** Kept verbatim.

### Fixed (real defects in the sample)

1. **`normalize_video_url()` does not run.** As pasted, the `if VIDEO_ID…` /
   `try:` block is dedented to module level → `IndentationError` before the
   first request. The logic itself (allowlist hosts, drop credentials/port,
   rebuild canonical URL) is sound and is reimplemented in
   `youtube-resolver.js` — with tests for `youtube.com.evil.com`,
   `user:pass@`, `:8443`, `javascript:`, channel/playlist pages and bad ids.
2. **`if os.name != "posix": raise RuntimeError`** would refuse to start on
   Windows — the platform AiDM ships on. Replaced with platform-aware process
   handling: `taskkill /T /F` on Windows (yt-dlp spawns FFmpeg; killing only
   the parent orphans it and leaves a locked output file), POSIX process-group
   kill elsewhere.
3. **Deno required at import time.** `for executable in ("ffmpeg","deno")`
   aborts the whole process if Deno is missing, and `--js-runtimes deno` is not
   accepted by every yt-dlp build. In a desktop app a missing optional runtime
   must not brick the app: AiDM only requires **yt-dlp**, passes the bundled
   `ffmpeg-static` via `--ffmpeg-location`, and reports a missing binary with
   an actionable message instead of throwing at require-time.
4. **No progress reporting at all.** Fatal for a download manager UI: the row
   would sit at 0% for minutes. AiDM drives yt-dlp with `--newline
   --progress-template` and maps bytes/speed/ETA onto the normal row
   (throttled to ≈5 updates/s).
5. **No pause, resume or cancel.** yt-dlp is started with `--continue`, so a
   pause (process killed) leaves a resumable `.part`; resume re-runs and
   continues. Cancel/remove aborts within 400 ms via a polled `shouldAbort`.
6. **Split-stream percentage was misleading.** With two tracks, yt-dlp reports
   each track's own total, so the bar would jump 0→100%→0→100%. AiDM seeds
   `expectedBytes` with the *combined* size from the probe.
7. **Job bookkeeping leaked.** `MAX_JOBS = 20` counted completed-but-retained
   jobs, so the 21st download ever would 429 forever. The desktop queue already
   has real lifecycle/retention semantics; nothing new was added here.
8. **Deletion raced in-flight transfers, no ownership model, one shared API
   key.** Not applicable: AiDM's local server is bound to `127.0.0.1` (localhost
   is the trust boundary) with a header allowlist and a resolve rate limiter,
   rather than a shared secret that a distributed client would have to embed.

### Deliberately dropped

* **The whole HTTP service + API key.** AiDM already resolves page URLs in the
  main process (`add-download` → resolver → quality picker).
* **`--remux-video mp4`.** Combined with `--merge-output-format mp4` it
  double-handles the file. Instead AiDM *selects* MP4/M4A formats up front
  (`bv[ext=mp4]`-style preference in `buildChoices`) and merges to MP4 once.
* **`--max-filesize 1G` as the size policy.** It is per-format, so 900 MB video
  + 200 MB audio passes and then fails the merged file. Disk quota is the
  desktop's business; no fake per-format cap is advertised.
* **A hard-coded "best" format ladder.** YouTube's ladder changes; AiDM reads
  the real format list and lets the user pick a height.

---

## 3. How it fits AiDM

```
pasted/watch URL
      │
      ▼
resolvers.js ── youtube-resolver.supports() ── strict id-only parse
      │                                        (SSRF guard)
      ▼
yt-dlp -J  (probe)  ──►  buildChoices()  ► quality picker (height · size · codec)
      │
      ▼
user picks 1080p → row carries { provider, ytUrl, ytFormat:{formatId, audioFormatId, progressive} }
      │
      ▼
download-manager._startDownload
      │
      ├── fresh PROGRESSIVE url? ──► native multi-segment engine (fast, resumable)
      │
      └── otherwise ───────────────► yt-dlp child: extract → download → merge → rename
                                     progress mapped to the row; pause/cancel kill the tree
```

* **Why the row keeps the page URL, not the stream URL:** signed URLs expire.
  A row restored after a restart, a retry or a long pause is re-resolvable.
* **Why two engines:** a progressive URL *is* a plain file URL — throwing away
  AiDM's multi-segment speed and byte-accurate resume for it would be a
  regression. DASH pairs genuinely need extract+merge, so they go to yt-dlp.
* **Failure isolation:** `require('./yt-dlp')` never throws; every other
  download type is untouched when yt-dlp is absent.
* **Audio-only rows.** Every resolve also offers a final **Audio** choice
  (`bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio`), named `.m4a` so it lands
  in AiDM's audio category. The saved file always keeps the container yt-dlp
  actually produced — the name is corrected rather than lying with a `.mp4`
  suffix if a merge ever falls back to mkv or an audio track is opus.
* **A blocked preview does not block the download.** YouTube refuses the
  metadata probe ("Sign in to confirm you're not a bot") far more often than it
  refuses the media, and the handoff re-extracts at start anyway. When the probe
  fails with a retryable code (`bot-check`, `timeout`, `extract`, `parse`),
  `fallbackPayload()` returns a single **"Best available"** row
  (`bestvideo+bestaudio/best`) so the user can still try, and the reason is kept
  in `probeError`. Genuine access failures — private, members-only,
  age-restricted, removed — are *not* retried: they cannot succeed, so they stay
  errors. Nothing here bypasses anything: no cookies, no auth, no alternative
  player client; the same ordinary yt-dlp call runs at start.

### Browser side (Chrome extension)

`maybeResolveYouTube()` in `chrome-extension/background.js` mirrors the
existing tweet/Facebook hand-off: on `tabs.onUpdated` **and** on
`webNavigation.onHistoryStateUpdated` (YouTube is an SPA — a load event never
fires when you click the next video), it posts the watch page to
`POST /api/resolve-youtube`, rate-limited like every other resolve endpoint.
The server resolves it through the registry and emits `video-detected`, so the
capsule shows the normal picker with real qualities and sizes.

Two deliberate details:

* **No cookies are attached** — resolving with a session cookie would turn a
  bot-check/login wall into a successful download. That is a bypass; AiDM
  reports those videos as errors instead.
* **Sniffed `googlevideo.com/videoplayback` rows are hidden while the tab is on
  YouTube** (`dropYoutubeCdn()`), because they are separate signed DASH tracks —
  picture-only or sound-only — that expire in minutes. Those urls stay visible
  on other sites, where nothing else can resolve them.

---

## 4. Setup

```bash
cd aidm
node tools/fetch-yt-dlp.js          # official release, SHA-256 verified, per-user folder
node tools/fetch-yt-dlp.js --check  # what AiDM detected
```

Install location (no elevation): `%LOCALAPPDATA%\AiDM\bin\yt-dlp.exe` on
Windows, `~/.local/share/aidm/bin/yt-dlp` on Linux,
`~/Library/Application Support/aidm/bin/yt-dlp` on macOS.

Other supported sources, in detection order: `AIDM_YTDLP` (full path),
`AIDM_YTDLP_BIN` (folder), `<app resources>/bin`, `aidm/bin`, the per-user
folder above, `PATH`, then `python -m yt_dlp`. FFmpeg is already bundled
(`ffmpeg-static`) and passed via `--ffmpeg-location`.

AiDM does not bundle or auto-download yt-dlp: an unattended binary download at
runtime is a supply-chain decision for the user, not the app.

---

## 5. Security & legal scope

* **No bypassing.** No cookies, no login/session extraction, no proxy evasion,
  no PO-token solver, no DRM or payment circumvention. Private, members-only,
  age-restricted, bot-checked, region-locked and removed videos return a clear
  error (`classifyError` in `src/yt-dlp.js`).
* **SSRF:** only the 11-character id survives parsing; the canonical URL is
  rebuilt from a fixed host allowlist. A sniffed `googlevideo.com` stream URL is
  intentionally *not* claimed by the resolver (the extension handles those).
* **No shell:** the child is spawned with an argv array and `--` before the URL,
  so a crafted URL cannot inject arguments.
* **Log hygiene:** signatures/tokens are redacted before a line reaches the UI.
* **User responsibility:** this downloads media the user can already watch.
  Downloading content without permission, or where the platform forbids it, is
  the user's responsibility — check local law and the platform's terms.

---

## 6. Known limits

| Area | Behaviour | Production note |
|---|---|---|
| Compatibility | Depends on upstream yt-dlp | Re-run `tools/fetch-yt-dlp.js` after an extraction failure; test against a video you own before shipping |
| Codecs | Output is MP4, but MP4 ≠ H.264 | Devices that need H.264/AAC need an explicit format policy or a transcode step; `buildChoices` already prefers MP4/M4A |
| Pause | Kills the child; the `.part` file resumes | Pause is coarser than the native engine's (no per-segment offsets) |
| Speed | The global/scheduled speed cap is forwarded as `--limit-rate` | No multi-segment acceleration on the handoff path (yt-dlp fetches) |
| Disk | No hard quota on the handoff path | Enforce at the filesystem/container level |
| Live | Refused at resolve time | Recording live streams is not supported |
| Playlists | `--no-playlist` | One video per row, by design |
| Concurrency | Bounded by `settings.youtubeMaxConcurrent` (default 2, min 1); extra rows re-queue and start as slots free | The slot is released in a `finally`, so a failure cannot leak it |
