# ⚡ AiDM - AI-Powered Download Manager v4.5.2

> Classic IDM-style download manager with next-generation modular download engine, dynamic in-flight segment splitting, positional random-access disk I/O, multi-mirror failover, atomic `.part.meta` crash recovery, Chrome browser integration, video quality detection, smart per-category file organization, ETA, dual-layer speed limiting, streaming multi-algorithm checksum verification, and a yt-dlp + FFmpeg extraction engine for YouTube.

---

## What's New in v4.5.2

Four user-reported defects, one fix each — plus the same dimension bug found still live in the browser extension, and the browser session that was never reaching yt-dlp.

> **Why the 4.5.x patch numbers?** The first 4.5.0 installer was built before the extension dimension fix and the yt-dlp cookie fix, and 4.5.1 was built before the local API endpoints forwarded the session. A rebuilt binary carrying the same version string is invisible to the in-app updater, so each rebuild that changes the binary gets a new patch number — anyone who installed an earlier 4.5.x gets the later fixes automatically.

| Change | Impact |
|--------|--------|
| **True video dimensions** (`src/media-probe.js`, new) | Resolutions are now *proven*, not guessed. AiDM reads the real width/height/duration/audio-track presence straight out of the container bytes (ISO-BMFF box walk incl. trailing `moov`, EBML/Matroska, MPEG-TS PAT/PMT, `ffmpeg -i` fallback). The old code guessed from quality labels, URL regexes and the playing `<video>` element's *current render size* — which is why a 360p file displayed as 2160p and why every variant on a page showed the same resolution. A new **Dimensions** column in the download list shows `640×360` (solid, with a codec/duration tooltip) for proven geometry, dimmed+italic for a not-yet-verified value, and nothing at all when unknown. No 16:9 is ever fabricated from a height. |
| **Downloads always have audio** | Hard invariant: no non-audio-only choice can ever reach yt-dlp as a bare video format id — `ensureAudioChoice()` rewrites any audio-less DASH choice to `<id>+bestaudio/best`, and `buildFormatSpec()` repairs stale persisted rows too. A merge with no FFmpeg now fails fast and clearly instead of leaving a silent file, partial tracks are cleaned up on failure, and the produced file is probed so a video-without-audio result is rejected rather than reported as success. Split-AV sources (Facebook et al.) are muxed by a generalised `_ensureAudio()` that works for any provider and restores the original on failure. Every row now carries `media.hasAudio`, and `audioMissing` shows a 🔇 badge so a silent file is visible instead of mysterious. |
| **Rapidgator support** (`src/filehost-resolver.js`, new) | Hoster links used to download the page HTML. Rapidgator file pages now resolve to a real download URL via the hoster API when you save an account (**Settings › File hosts**; premium or a session cookie removes the wait), or via the free page flow, which honestly reports the mandatory wait instead of bypassing the captcha. Hoster rows are marked `singleConnection: true, resumable: false` because these links reject `Range` — multi-segment requests were producing corrupt files. Host allowlist, 2 MB body cap, same-family redirects only. |
| **Hardened transfer engine** | `startDownload` no longer forces `onConflict: 'overwrite'`, which silently deleted a finished file of the same name. Truncated/short bodies and 200-responses-to-ranged-requests are now detected instead of being written and reported complete; range-hostile servers collapse to a single connection from the worker path (not just the probe); a restart no longer reuses an already-aborted controller; segment restore clamps past-EOF ends; HLS picks an **audio-carrying** variant instead of blindly taking the top-bitrate one, and reports the real width/height; a short output raises `download-error` instead of a false `download-complete`. |
| **Extension: no more identical dimensions** | The desktop side stopped guessing, but `chrome-extension/content.js` was still stamping `video.videoWidth/videoHeight` onto **every** candidate from a player — so a page offering 360p/720p/1080p `<source>` variants reported one identical resolution for all of them, and on a DASH player the value was just the current adaptive rendition. The element's intrinsic size is now applied only to the variant that element is actually playing; everything else stays unknown and is proven from the file after download. Locked by `test/extension-dimensions.js`. |
| **YouTube: your session is actually used** | yt-dlp runs as a child process and cannot see your browser's login, so cookies AiDM already had were forwarded for direct HTTP downloads but *silently dropped* on the YouTube path — a video you can watch while signed in (private, members-only, age-confirmed) failed with "Sign in to confirm you're not a bot". Cookies the extension captures are now written to a throwaway Netscape cookie file and passed to yt-dlp, for the **probe as well as the download** (otherwise the picker comes back empty). Secrets go through a `0600` file, never an argv entry, and the file is deleted when the job ends. Optional **Settings › YouTube › Read cookies from browser** (`chrome`/`edge`/`firefox`…) lets yt-dlp read that browser's own store — opt-in, off by default. |

Also: `tools/refresh-latest-yml.js` now follows `package.json` instead of re-hashing the previous installer, so updater metadata no longer stays a release behind.

**Tests:** 31 suites, **1,242 assertions, 0 failures** (new: `media-probe` 131, `filehost-resolver` 102, `youtube-audio` 64, `row-media` 59, `engine-reliability` 50, `ui-dimensions` 44, `yt-dlp-cookies` 51, `extension-dimensions` 13).

---

## What's New in v4.4.0

| Change | Impact |
|--------|--------|
| **YouTube extraction engine (yt-dlp + FFmpeg)** | A pasted `youtube.com/watch?v=…` (or `youtu.be`, `/shorts/`, `/embed/`, `/live/`) URL used to be downloaded as page HTML. It is now resolved into real media: the picker lists every available height with size, and the download extracts, fetches and merges in one pass — with sound, even at 1080p where YouTube serves picture and sound as separate DASH tracks |
| **Only the video id reaches the extractor** | Strict normalisation keeps the 11-character id and rebuilds `https://www.youtube.com/watch?v=<id>`; host, query, fragment, credentials and port are discarded (SSRF guard), and a sniffed `googlevideo.com` stream URL is deliberately *not* claimed by the resolver |
| **Best of both engines** | A fresh *progressive* (single-file) URL keeps AiDM's native multi-segment engine — fast, resumable, speed-limited. Everything else (DASH picture+sound, expired or restored rows) is handed to yt-dlp, which re-extracts fresh signed URLs and merges with the bundled FFmpeg |
| **Redacted error logs on demand** | Failed YouTube rows grow a 📋 button that opens that job's diagnostic log — the extractor's own words with every signature and token stripped. Logs live in `%LOCALAPPDATA%\AiDM\logs` (never next to your videos), keep the newest 20 for 24 h, and the handler only ever opens the path recorded on that row |
| **Audio-only downloads** | Every resolve offers a final "Audio" choice (best M4A/AAC) named `.m4a`, so it lands in the Music category. Whatever container yt-dlp actually produces wins — the row is renamed to match instead of saving an mkv/m4a under a `.mp4` name |
| **A blocked preview never blocks the download** | YouTube refuses the metadata probe far more often than the media, so a refused preview now yields a single "Best available" row (`bestvideo+bestaudio/best`) instead of nothing. Genuine access failures (private, members-only, age-restricted, removed) stay errors |
| **Every quality is its own row** | Rows store the watch URL (stream URLs expire), so duplicate detection now compares the chosen format too — picking 720p after 1080p used to be reported as a duplicate and silently return the first row |
| **Bounded and rate-limited** | At most `youtubeMaxConcurrent` yt-dlp jobs run at once (default 2; extra rows re-queue), and the global/scheduled speed cap is forwarded to yt-dlp, so the scheduler's limit applies to YouTube too |
| **Browser hand-off, not sniffed links** | The extension sends the *watch page* to the desktop (like it already does for tweets and Facebook) instead of the player's own `googlevideo` DASH urls, and those sniffed rows are hidden on YouTube — otherwise the capsule would offer picture-only links that save a silent file |
| **Honest failures, no bypassing** | Private, members-only, age-restricted, bot-checked, removed and live videos are reported as errors. No cookies, no login extraction, no proxy evasion, no DRM/payment circumvention |
| **`node tools/fetch-yt-dlp.js`** | One-command install of the official yt-dlp release into a per-user folder (no admin), SHA-256 verified against the published `SHA2-256SUMS`. AiDM never bundles yt-dlp |

See [`docs/YOUTUBE-ENGINE.md`](docs/YOUTUBE-ENGINE.md) for the design, the analysis behind it and the known limits.

---

## What's New in v4.3.9

| Change | Impact |
|--------|--------|
| **Facebook split-AV audio pairing** | Facebook serves picture and sound as two separate DASH renditions sharing an efg `video_id` (one video-only `.mp4`, one audio-only `.mp4`). The video row now carries the paired audio URL as `audioUrl`; the desktop downloads both and remuxes them with FFmpeg into a single file with sound |
| **`ffmpeg-static` bundled** | FFmpeg ships as an `asarUnpack` extra-resource so the desktop mux step runs without a system install |

---

## What's New in v4.3.8

| Change | Impact |
|--------|--------|
| **Split A/V adaptations no longer offered as videos** | HLS audio-group playlists (EXT-X-MEDIA TYPE=AUDIO) named by a master are denied as candidates, so they can't download as sound-without-picture |
| **Every video row verified to carry a video track** | All video-container rows (not just ones missing dimensions) are metadata-checked; trackless files drop out of the capsule and popup instead of completing as unplayable "videos". Geometry repaints stay limited to undescribed rows |

---

## What's New in v4.3.7

| Change | Impact |
|--------|--------|
| **"Downloaded but no video" junk filtered** | One Facebook video could offer 16 rows that all COMPLETE yet contain nothing playable (DASH audio slices served as `.mp4`, sub-second previews). Audio-typed responses, probed trackless files, and tiny sub-second previews are now dropped in the capsule, the desktop-bound payload, and the popup — with identical verdicts tested across all three |
| **Honest DASH-protected state** | A blob-playing video with segment traffic but no direct file now shows a "DASH · Protected stream" row instead of junk rows or a bare spinner |

---

## What's New in v4.3.6

| Change | Impact |
|--------|--------|
| **True per-row dimensions on Twitter** | Variant URLs that encode no rendition used to all display the playing element's size (five rows of identical "1440p · 3412x1970"). Rows without URL-derived geometry now read each file's own metadata and repaint badge, resolution, filename and click payload in place (bounded, cached, URL-described rows untouched) |
| **Facebook ranked sections instead of hard filtering** | Per-video scoping could hide the right video when blob attribution guessed wrong, so downloads landed on unknown random videos. Candidates are now ranked — this video first, the rest under an "Other videos on this page" divider — and never dropped |

---

## What's New in v4.3.5

| Change | Impact |
|--------|--------|
| **Facebook "72 links" panel explosion fixed** | Two compounding causes: same-file re-requests with rotated tokens (vabr/rl/oh/oe churn) produced distinct rows, and feed/watch pages merged every related video's URLs into every pill. Rows now collapse on canonical path + rendition tag + quality + resolution + size, and the panel/badge scope to the playing video's own path family when attributable (global fallback otherwise) |
| **Same fix in popup + quality picker** | The desktop-bound variant list and the extension popup collapse with the same key (parity-tested across all three copies), so all three surfaces agree |
| **URL-level keys untouched** | `normalizeStreamUrl`/`fbFileKey`/sent-tracking and every `fb-dedup.js` assertion are byte-identical — the fix layers presentation collapse + scoping on top instead |

---

## What's New in v4.3.4

| Change | Impact |
|--------|--------|
| **Icon-only toolbar** | The nine toolbar actions are compact icon squares now (names live in tooltips + ARIA labels) — the bar fits narrow windows instead of pushing buttons off-screen |
| **Layout follows window resizes** | Toolbar wraps, the download area actually shrinks (`min-width: 0`), the table scrolls both axes instead of clipping, file names fill their cell, modals cap to the viewport, the status bar and modal form rows wrap, and narrow windows shed subtitle/label chrome via media query |
| **Collapsible sidebar** | New ◀ toggle parks the sidebar as a 54px icon rail (tooltips preserved) for small windows |

---

## What's New in v4.3.3

| Change | Impact |
|--------|--------|
| **Pill no longer sticks to the cursor** | Ending a drag used to depend only on `pointerup`/`pointercancel` reaching the page — releasing outside the window or frame, Alt+Tab mid-drag, or dragging out of an iframe document (hqporner/mydaddy embeds) leaked the move listener so the pill followed the cursor forever. Drags now end on pointerup, cancel, capture loss, document leave, window blur, button-less moves, and Escape, with pointer capture and single-flight gestures |
| **Pill parks anywhere in view** | Positioning is clamped only to the viewport (never the player) via the tested `clampCapsulePos` helper, so a dropped pill stays where it was dropped |
| **Glassmorphism pill** | Translucent blurred glass look (backdrop blur + saturation, glass border, layered inset/outset shadows, press/drag states) plus `touch-action: none` so touch drags aren't hijacked by scrolling |

---

## What's New in v4.3.2

| Change | Impact |
|--------|--------|
| **Exact browser-header replay** | The extension now captures the *exact* Cookie/Referer/Origin/UA the browser used while a video played (`webRequest.onBeforeSendHeaders`) and replays that set verbatim on the desktop download — passing multi-layer anti-hotlink checks that guessed headers fail |
| **Fresh URL at Download-click** | Signed CDN links expire within minutes; the capsule re-resolves the player's current same-file URL at click time instead of trusting the row's possibly stale link |
| **🌐 Download with browser (fallback)** | Right-click menu + `native-download` path: Chrome fetches the file itself (correct SameSite cookies, Sec-Fetch-*, TLS fingerprint) with the page Referer injected via a short-lived session rule — for strict CDNs that refuse the desktop engine while the browser plays fine |
| **HTTP 501 fast-fail** | Servers that reject download-manager requests outright now fail immediately with a message pointing at the browser fallback, instead of looping through segment retries |

---

## What's New in v4.3.1

| Change | Impact |
|--------|--------|
| **hqporner/mydaddy: resolve failures surface honestly** | A page URL whose resolver fails used to fall through and save the page HTML as a file (e.g. an hqporner page stored as `..._kidnapped_body_heat.html`), which looks exactly like "can't download the video". Failed resolutions now return the reason to the Add-URL dialog instead |
| **HLS variants + DASH-aware errors in the embed resolver** | mydaddy player pages are scanned for HLS masters (`.m3u8`, downloaded by the HLS engine) as well as MP4s, MP4s still sort first, and a DASH-only page reports itself as unsupported instead of "no video found" |
| **🔗 Resolve Page Video (extension fallback)** | When the desktop's own page fetch is bot-walled, the popup resolves the mydaddy/hqporner embed with the real browser network stack (Chrome TLS fingerprint, user cookies) and opens the normal quality picker. Service-worker parsers are parity-tested against the desktop copies |

---

## What's New in v4.3.0

| Change | Impact |
|--------|--------|
| **Download scheduler (⏰ toolbar)** | One-time, daily, and weekly queue runs with optional stop-after, per-run speed limit, retry-failed-first, and a when-drained action (nothing / notify / shut down / hibernate — power actions always ask first). Missed runs never fire retroactively. New `npm run test:scheduler` covers next-run math, validation, and tick semantics |
| **Timetabled speed limits** | Optional rules like `22:00-07:00=1024` (one per line, overnight wraps allowed) in Settings — full speed at night, polite limits while you work. Precedence: schedule run > timetable > default limit |
| **Browser-takeover controls** | Take over every download (classic behavior, still the default), or only listed file types; never take over from excluded sites. Holding **Alt** while clicking always lets the browser handle it; a configurable force-takeover key (default Shift) grabs even unlisted types. Explicit pill/popup/menu clicks are never gated. New `npm run test:interception` |
| **Site grabber (🕸 Grab Site)** | Extension popup crawls the current site (same-origin, up to 2 hops, capped pages/time) for downloadable files with an optional type filter, and hands matches to the normal batch flow. New `npm run test:grabber` |

> Roadmap (not in this release): per-site login manager, antivirus-scan hook on completion, multiple named queues.

---

## What's New in v4.2.1

| Change | Impact |
|--------|--------|
| **Dead CDN links are never offered (probe-before-offer)** | Sites like mydaddy.cc put short-lived links on the page; by download time they were already dead (HTTP 404) and every click produced a 0% "DOWNLOADING" row that later failed with "Server responded with HTTP 404". The capsule now live-probes every candidate link (1-byte Range GET with the same cookies + Referer the desktop would send): 404/410 rows are dropped, real sizes from Content-Range fill the "Unknown size" rows, and same-quality+same-size duplicates collapse to one row |
| **Instant, honest failure on the desktop** | If a link dies between detection and download, the manager now fails at ADD time with "This link has expired on the site's CDN (HTTP 404) … open the video page again, let AiDM re-detect it, and click Download on the fresh link" instead of a stuck 0% row. Mid-stream 404/410 failures get the same message |
| **KVS/CDN path quality labels** | Player variants like `…/pubs/<id>/1080.mp4` now show as 1080P/720P/480P with resolutions instead of unlabeled "VIDEO · unknown size" rows — so the real playable variants are identifiable and get picked |
| **Regression-tested** | New `npm run test:dead-link-guard` extracts the shipped `deadLinkMessage` / `isDeadProbeStatus` / `detectQuality` and asserts 404/410 handling, the add-time guard wiring, the probe message plumbing, and path-quality detection |

---

## What's New in v4.2.0

| Change | Impact |
|--------|--------|
| **Stale "hardcoded" video links fixed** | Sniffed media URLs were kept per browser tab for 10 minutes and only cleared when the tab closed — never on navigation. After playing a video on one site (e.g. mydaddy.cc), that site's tokenized CDN link kept resurfacing as the one offered download on every OTHER site opened in the same tab; clicking it always failed (rotated signature / wrong Referer), which looked like "AiDM can't download anymore". Tab streams are now cleared at every navigation AND panel data is scoped to the current page load (`since` = navigation start), so a capsule can only ever offer links its own page produced |
| **Regression-tested** | New `npm run test:panel-freshness` extracts the shipped `filterTabStreams` from background.js and asserts stale/keep-window/since-boundary behavior, plus that the navigation-clear and `since` wiring exist in the shipped files |

---

## What's New in v4.1.2

| Change | Impact |
|--------|--------|
| **"99+ video download links" on Facebook fixed** | The dedup key kept the raw `efg` param, whose `bhak` field is a per-request nonce — every player re-fetch (seek / rebuffer / quality poll) minted a "new" link. The key now keeps only stable rendition fields (`encode_tag`/`itag`/resolution) in all four copies (content, background, popup, main-process manager); `video-*` and `scontent-*` edges of the same file merge to one row, while SD/HD/quality variants stay distinct. Regression test `npm run test:fb-dedup` simulates 96 requests → 8 rows |

---

## What's New in v4.1.1

| Change | Impact |
|--------|--------|
| **Facebook: one video, one playable row** | `?bytestart=N` range-slices are rewritten to the full progressive MP4 before dedup/download (a saved slice is missing its MP4 header — that was the "downloaded but won't play" bug); `vabr` added to token-strip; rotating fbcdn edge-pool hosts collapse to a service class while `efg`/`rl` still keep SD vs HD distinct; quality labels now come from `browser_native_hd/sd_url` + `hd_src/sd_src` instead of guessing "1080p" from the player size |

---

## What's New in v4.1.0

| Change | Impact |
|--------|--------|
| **No more `.aidm_downloads` on Desktop** | Download-list state moved from `<savePath>/.aidm_downloads.json` to `~/.aidm_downloads.json` (next to settings) with one-time migration + cleanup of legacy Desktop/Downloads dotfiles |
| **Real filename next to resolution/size** | Quality picker, extension popup, and video capsule now show the sniffed `Content-Disposition` filename per variant so identical-looking qualities are distinguishable |
| **Duplicate download links fixed** | Raw DASH/HLS segments (`.m4s`, chunk/fragment/range URLs) are never offered; token-normalized dedup (incl. Facebook `oh`/`oe`) collapses one video to one row |
| **Facebook videos work again** | fbcdn/scontent/Instagram detection, extensionless `/v/` URL support, `playable_url` / `browser_native_hd/sd_url` page-JSON extractor, and blob+MSE playback-gate fix restore the download pill on facebook.com |

---

## What's New in v4.0.0

| Change | Impact |
|--------|--------|
| **Modular Next-Gen Engine** | Full architecture upgrade ported from `lib/download-engine/` into modular components (`src/engine/`): task lifecycle, worker threads, rate limiters, probe, control files, and mirror pools |
| **Dynamic In-Flight Segment Splitting** | IDM-style dynamic segment reallocation (`SegmentManager`). When connections finish early, the largest remaining incomplete segment is dynamically bisected and assigned to free workers without restarting |
| **Positional Random-Access I/O** | `SegmentFileWriter` writes segments directly to their exact byte offsets in the target file using positional file descriptors (`fs.write(fd, buf, 0, len, pos)`), eliminating expensive post-download concatenation |
| **Atomic Crash Recovery (`.part.meta`)** | Download state, completed ranges, and per-segment byte offsets are atomically synchronized to binary-safe `.part.meta` control files. Any interrupted download resumes without losing a single downloaded block |
| **Multi-Mirror Pools & Failover** | `MirrorPool` manages fallback mirror URLs with dynamic health scoring, latency tracking, error backoff, and automatic seamless failover when primary hosts stall or fail |
| **Multi-Algorithm Checksums** | Streaming hash verification supporting MD5, SHA-1, SHA-256, and SHA-512, verified automatically in real-time or post-download |
| **Dual-Layer Token-Bucket Limiting** | Hierarchical bandwidth management with per-task limits and a global pool limiter ensuring smooth, jitter-free throttling across parallel segments |
| **Expanded Test Suites** | 3 comprehensive test suites covering 110+ assertions across smoke tests, integration tests, and engine v4 unit/integration tests |

---

## What's New in v3.5.0

| Change | Impact |
|--------|--------|
| **Provider-neutral resolver API** | New `POST /api/resolve` returns `{ provider, id, title, thumbnail, duration, media[] }` for any registered provider — the queue/engine/UI never know which site a link came from |
| **Strict identifier-only URL parsing** | Only clean `x.com/twitter.com/mobile.twitter.com` post URLs are resolved; `/status/123abc` and 19-digit media ids can never be mistaken for a post |
| **Richer metadata** | Tweet text (title), poster frame (thumbnail) and video duration now flow into the quality picker and resolve responses |
| **`bestMP4()` selection** | Provider-independent progressive-MP4 preference (resolution → bitrate); the winner is flagged `preferred` in `/api/resolve` |
| **Resolve rate limiting** | 30 resolutions/minute across the resolve endpoints — a runaway tab can't hammer the metadata source |
| **SSRF hardening** | The syndication client refuses redirects to any host other than `cdn.syndication.twimg.com` (depth-capped at 3) |

---

## What's New in v3.0.0

| Change | Impact |
|--------|--------|
| **Byte-accurate segment resume** | Retry/restart continues from the last written byte — no more corrupted files or wasted bandwidth |
| **Instantaneous speed (3s rolling window)** | Speed readout reacts to stalls and recoveries instead of freezing at lifetime average |
| **ETA display** | Every active download shows estimated time remaining |
| **Global speed limit** | Token-bucket throttle in Settings → KB/s (0 = unlimited) |
| **Auto-resume on restart** | Incomplete downloads continue automatically when `autoResume` is on |
| **SHA-256 verification** | Hash computed in the background after completion; copy from right-click menu |
| **Drag-and-drop URLs** | Drop a URL or `.txt`/`.url` file onto the window to start a download |
| **CORS lockdown** | Local API only accepts requests from browser extensions and localhost |
| **No cookie persistence** | Session cookies never written to disk |
| **Clipboard first-line only** | Multi-line clipboard content no longer treated as a URL |
| **Path validation** | `open-file`/`open-folder` refuse non-existent / traversal paths |
| **Category override** | The Add Download dialog's category dropdown now actually works |
| **Honest status bar** | Extension connectivity is polled live, not hardcoded |

---

## 📊 Research: Top 5 Download Managers Analyzed

AiDM was built by analyzing and combining the best technologies from the world's top download managers:

### 1. 🏆 Internet Download Manager (IDM)
- **Dynamic File Segmentation** — Splits files into multiple segments and downloads them in parallel
- **Smart Connection Reuse** — Keeps HTTP connections alive to avoid handshake overhead
- **Browser Integration** — Native extension intercepts all browser downloads automatically
- **Resume Capability** — Full resume support via HTTP Range headers

### 2. 🆓 Free Download Manager (FDM)
- **Modern Electron UI** — Clean, responsive interface built on web technologies
- **Smart File Management** — Automatic categorization by file type
- **Traffic Shaping** — Bandwidth allocation and speed limiting per download

### 3. 📋 JDownloader 2
- **Clipboard Monitoring** — Automatically detects download URLs copied to clipboard
- **Link Grabber** — Extracts all downloadable links from any webpage
- **Batch Processing** — Download entire link lists with one click

### 4. 🎬 Xtreme Download Manager (XDM)
- **Video Stream Detection** — Detects and downloads streaming video (HLS, DASH, progressive)
- **Video Sniffer** — Monitors network traffic for video streams in real-time

### 5. ⚡ Motrix
- **Electron architecture** — Cross-platform desktop app
- **Local API server** — HTTP API for extension ↔ app communication

---

## 🔧 AiDM Features

| Feature | Inspired By | Implementation |
|---------|-------------|----------------|
| Multi-segment downloading | IDM | 1-32 parallel segments with dynamic allocation |
| Byte-accurate resume | IDM | Per-segment offset tracking across retries and restarts |
| Intercept ALL downloads | IDM | Every browser download routes to AiDM automatically |
| Video quality detection | XDM | Detects resolution, quality (4K/1080p/720p), file size |
| Quality picker | XDM | Choose video quality before downloading |
| Per-category paths | FDM | Auto-save Videos→Videos/, Music→Music/, etc. |
| Ask location every time | IDM | Optional folder picker for each download |
| Clipboard monitoring | JDownloader | Auto-detects URLs copied to clipboard |
| Video stream detection | XDM | Content script monitors page resources in real-time |
| Link grabber | JDownloader | Scans pages for all downloadable links |
| Batch downloads | JDownloader | Download multiple URLs at once |
| SHA-256 verification | — | Background hash after completion |
| Speed limiting | FDM | Token-bucket global throttle |
| ETA | IDM | Estimated time remaining per download |
| Drag-and-drop | — | Drop URLs/files onto the window |
| Local API server | Motrix | HTTP API on port 18765 for extension ↔ app |

---

## 📁 Project Structure

```
aidm/
├── main.js                    # Electron main process
├── preload.js                 # Secure IPC bridge
├── preload-location.js        # IPC bridge for the location dialog
├── package.json               # Dependencies & build config
├── src/
│   ├── download-engine.js     # Unified download engine API (v4 modular + legacy compat)
│   ├── download-manager.js    # Queue, scheduling, categories, approval flow
│   ├── clipboard-monitor.js   # Clipboard URL detection
│   ├── server.js              # Local HTTP API for Chrome extension
│   ├── ai-service.js          # TokenHarbor AI integration
│   ├── resolvers.js           # Media resolver registry & base provider
│   ├── twitter-resolver.js    # Twitter/X syndication video resolver
│   ├── youtube-resolver.js    # YouTube URL normalisation + yt-dlp format mapping
│   ├── yt-dlp.js              # yt-dlp runner (detect, probe, download, merge, kill)
│   ├── media-mux.js           # FFmpeg (ffmpeg-static) remux helper
│   ├── location-dialog.js     # Topmost save-location window controller
│   └── engine/                # Next-Gen Modular Engine Core
│       ├── types.js           # Type definitions & engine defaults
│       ├── errors.js          # DownloadError classification & HTTP mappings
│       ├── utils.js           # Math, deferred promises, safe paths
│       ├── checksum.js        # Streaming multi-hash verifier (MD5, SHA1, SHA256, SHA512)
│       ├── control-file.js    # Atomic crash recovery (.part.meta)
│       ├── file-writer.js     # Positional random-access SegmentFileWriter
│       ├── rate-limiter.js    # Token-bucket rate limiter with burst control
│       ├── retry.js           # Exponential backoff with jitter & Retry-After
│       ├── speed.js           # Sliding-window & EMA speed calculations + ETA
│       ├── mirrors.js         # MirrorPool failover & speed scoring
│       ├── probe.js           # Remote HTTP/HTTPS HEAD & Range probe
│       ├── segments.js        # SegmentManager with dynamic in-flight splitting
│       ├── worker.js          # Positional byte stream segment worker
│       ├── task.js            # DownloadTask lifecycle coordinator
│       └── engine.js          # Multi-download DownloadEngine coordinator
├── ui/
│   ├── index.html             # Main window
│   ├── styles.css             # IDM-inspired light-blue theme
│   ├── app.js                 # UI controller
│   ├── location-dialog.html   # Save-location dialog markup
│   └── location-dialog.js     # Save-location dialog renderer
├── chrome-extension/
│   ├── manifest.json          # Extension manifest (MV3)
│   ├── background.js          # Service worker — intercepts ALL downloads
│   ├── interceptor.js         # MAIN-world media URL hooks
│   ├── content.js             # Video detection + floating capsule
│   ├── popup.html / popup.js  # Extension popup
│   └── icon*.png              # Extension icons
├── test/
│   ├── smoke.js               # Core unit tests (60 assertions)
│   ├── integration.js         # Live multi-segment, pause, resume & restart tests (13 assertions)
│   └── engine-v4.js           # Next-gen engine unit & integration tests (37 assertions)
└── README.md
```

---

## 🚀 Installation & Running

### Prerequisites
- Node.js 18+ and npm
- Google Chrome (for extension)

### Desktop App
```bash
cd aidm
npm install
npm start
```

Or double-click **`Run-AiDM.bat`** from the workspace root.

### Chrome Extension
1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `chrome-extension/` folder
5. The AiDM icon appears in your toolbar
6. **After every AiDM update:** hit ⟳ Reload on the extension, then reload open video tabs

### Usage
1. **Start AiDM** desktop app first
2. **Install Chrome extension** (loads unpacked)
3. **Download files:**
   - Click "Add URL" in the app (or press `Ctrl+N`)
   - Drop a URL onto the window
   - Right-click any link → "Download with AiDM"
   - Copy a URL — clipboard monitor detects it
   - Use the extension popup to paste URLs
   - Click "Scan Page" to find all media on a page

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│              Chrome Browser                   │
│  ┌─────────────────────────────────────┐    │
│  │     AiDM Chrome Extension           │    │
│  │  • Download interceptor             │    │
│  │  • Context menu handler             │    │
│  │  • Video/media scanner              │    │
│  │  • Link grabber                     │    │
│  └──────────────┬──────────────────────┘    │
└─────────────────┼───────────────────────────┘
                  │ HTTP API (localhost:18765)
┌─────────────────┼───────────────────────────┐
│  AiDM Desktop App (Electron)                │
│  ┌──────────────┴──────────────────────┐    │
│  │         Local API Server            │    │
│  └──────────────┬──────────────────────┘    │
│  ┌──────────────┴──────────────────────┐    │
│  │       Download Manager              │    │
│  │  • Queue management                 │    │
│  │  • Settings persistence             │    │
│  │  • ETA + SHA-256 tracking           │    │
│  └──────────────┬──────────────────────┘    │
│  ┌──────────────┴──────────────────────┐    │
│  │     Multi-Segment Engine            │    │
│  │  • Parallel segment downloading     │    │
│  │  • Byte-accurate resume             │    │
│  │  • Token-bucket speed limit         │    │
│  │  • Rolling-window speed             │    │
│  │  • Background SHA-256               │    │
│  └─────────────────────────────────────┘    │
│  ┌─────────────────────────────────────┐    │
│  │      Clipboard Monitor              │    │
│  │  • URL pattern detection            │    │
│  └─────────────────────────────────────┘    │
│  ┌─────────────────────────────────────┐    │
│  │         IDM-Style UI                │    │
│  │  • Light-blue theme                 │    │
│  │  • Category sidebar                 │    │
│  │  • Progress + ETA + segment viz     │    │
│  │  • Context menus                    │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

---

## ⚙️ Technical Deep Dive

### Multi-Segment Engine
Files are split into N segments (default 8, max 32). Each segment downloads independently via a separate HTTP connection with its own `Range` header. On failure or pause, each segment resumes from its last written byte — the `Range` header is recomputed on every attempt.

### Video Quality Detection
The Chrome extension content script performs multi-layer video scanning:
1. `<video>` element scanning — Reads `videoWidth`/`videoHeight`
2. URL parameter parsing — Extracts quality from URL params
3. YouTube itag mapping — Recognizes 20+ itag values
4. Network resource monitoring — Uses Performance API
5. HLS master playlist expansion — Per-variant quality rows
6. KVS player flashvars extraction

### Per-Category Save Paths
Files are automatically categorized by extension:
- Videos → `~/Downloads/AiDM/Videos/`
- Music → `~/Downloads/AiDM/Music/`
- Documents → `~/Downloads/AiDM/Documents/`
- Archives → `~/Downloads/AiDM/Archives/`
- Software → `~/Downloads/AiDM/Software/`
- Images → `~/Downloads/AiDM/Images/`

### Browser Integration
The Chrome extension uses Manifest V3 with:
- `downloads.onDeterminingFilename` — Intercepts ALL Chrome downloads
- Context menus — Right-click to download any link/media
- Content script — Scans pages for video/audio sources
- Floating capsule — IDM-style download pill on playing videos

### Local API Server
HTTP API on `localhost:18765` (CORS restricted to extensions + localhost):
- `GET /api/status` — Health check and stats
- `POST /api/download` — Submit a new download
- `POST /api/batch` — Submit multiple URLs at once
- `GET /api/downloads` — List all downloads
- `POST /api/resolve` — **Provider-neutral resolver** (see below)
- `POST /api/resolve-twitter` — Legacy tweet → MP4 variants (still supported)

#### `POST /api/resolve`
```json
{ "url": "https://x.com/user/status/123456789" }
```
Response:
```json
{
  "success": true,
  "provider": "twitter",
  "id": "123456789",
  "username": "user",
  "title": "First line of the post",
  "thumbnail": "https://pbs.twimg.com/…",
  "duration": 18.4,
  "canonicalUrl": "https://x.com/user/status/123456789",
  "media": [
    { "type": "video", "url": "https://video.twimg.com/…", "mime": "video/mp4",
      "width": 1280, "height": 720, "bitrate": 2176000, "quality": "720p",
      "format": "mp4", "filename": "twitter_user_123456789_720p.mp4", "preferred": true }
  ]
}
```
The metadata source lives behind the `MediaResolver` interface (`src/resolvers.js`),
so new providers plug in with `registerResolver()` while everything downstream
(queue, retries, pause/resume, filenames, progress) stays provider-independent.
Resolution is rate-limited (30/min) and only clean post URLs are ever resolved.

---

## 🧪 Tests

AiDM v4 includes three comprehensive test suites (110+ passing assertions):

```bash
cd aidm

# Run all test suites
npm test

# Suite 1: Core Unit Tests (60 tests)
# Covers HLS parsing, Content-Disposition, MIME mapping, tweet URL detection, 
# category detection, URL normalization, AI service config, and clipboard patterns.
npm run test:smoke

# Suite 2: Integration Tests (13 tests)
# Covers live multi-segment downloads, pause, resume, cancel cleanup, 
# and state persistence across application restarts.
npm run test:integration

# Suite 3: Next-Gen Engine Tests (37 tests)
# Covers dynamic in-flight segment splitting, MirrorPool failover, 
# TokenBucket rate limiting, positional SegmentFileWriter, and atomic .part.meta recovery.
npm run test:engine-v4

# YouTube engine (104 tests) — offline, no yt-dlp required
# Covers strict URL normalisation & SSRF rejection, signed-URL expiry,
# progressive vs DASH mapping, native-engine vs yt-dlp handoff, progress
# parsing, log redaction, error classification and row wiring.
npm run test:youtube
```

---

## 📝 License

MIT — Free and open source. Inspired by the best, built for the future.
