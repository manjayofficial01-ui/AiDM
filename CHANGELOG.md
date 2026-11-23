# Changelog — AiDM

All releases, newest first. The README describes what AiDM *is*; this file
records what changed in each version.

## What's New in v6.0.0 — AI assistants (MCP), plus a hardening and layout pass

**AiDM 6.0.0** — the first major release of the upgrade cycle. It carries a
new capability (the MCP server below), the security and data-integrity fixes
that came out of the five-surface audit, and a layout pass that puts the
download table's actions back on screen at the app's minimum width. The
upgrade's own report is in `docs/UPGRADE-REPORT-2026-11-23.md`.

**New — an MCP server, so an AI assistant can work your downloads.** Mister
Download Manager (v0.2.0, 2026-10-31), Swift Download Manager (v1.9.0) and
Gopeed (v2.0.0-beta.1) all shipped Model Context Protocol control in the
last few weeks; AiDM now joins them — and is the only one of them with an AI
layer of its own. An assistant (Claude Desktop, Claude Code, Cursor, VS Code)
can list the downloads, add one, pause one, resume one, cancel one, run the
queue, and read the audit log. Twelve tools, over a token-protected loopback
channel to the running app.

**It is off until you turn it on** (Settings › AI › *AI assistants (MCP)*),
and the rules are the app's, not the client's:

- The effective access level is the **lower** of what the app allows and what
  the client asked for — `look` (read), `standard` (add/pause/resume/cancel)
  or `full` (also take a row off the list). The app re-reads its ceiling on
  every call, so lowering it in Settings takes effect immediately, even for a
  connection that is already open.
- **Nothing an assistant asks for can delete a file**, and it can never choose
  a folder — downloads go where you configured them.
- A link may not point at this machine, the LAN or a cloud metadata address,
  in any of the shapes an address can take (loopback, private, link-local,
  CGNAT, ULA, multicast, the shorthand `127.1`, the octal-looking `012.1.2.3`,
  and a host that resolves to a private address).
- At most 60 calls a minute per connection, and every call is written to
  `mcp-audit.log` with query-string values redacted.
- An imported settings file can never switch the bridge on.

Full guide: **[docs/MCP.md](docs/MCP.md)**.

**Fixed — an imported settings file could run a command on every completed
download.** `import-settings` accepted `postDownloadCmd` without limits, so a
settings file that arrived from somewhere else became remote code execution
on the next finished download. Imports now strip the command, the AI base URL
(which decides which host receives your API key), the yt-dlp interpreter and
its flags, the trusted extension origins — and the MCP switch — and the
dialog says what it skipped. The post-download hook itself now refuses shells
and script interpreters outright.

**Fixed — a key could follow the base URL to another host.** The AI API key
was stored next to the base URL and used wherever that URL pointed, so
retargeting the client silently handed the key to a different host. The key
is now bound to the host it was issued for and dropped when the host changes.

**Fixed — a resumed download could report itself finished with a hole in the
file.** The `.part` file is preallocated sparsely, so its *apparent* size
says "complete" long before the bytes are there. The trim that was supposed
to catch this trusted the size and did nothing, and a resumed task could then
report "completed" over a zero-filled gap. The segment bitmap is now written
only after the data is flushed to disk, the control file is fsynced, and every
resume path reads the bytes back (the segment's tail plus sampled windows) and
re-downloads anything that is still a hole.

**Fixed — a cancelled task could hold the connection gate hostage.** A waiter
whose task had stopped stayed in the queue, so the released slot went to
nobody while a live task sat at zero connections with the gate reporting
capacity. Waiters are now dropped when their task stops.

**Fixed — the Actions column was off-screen at the app's minimum width.** At
900 px the file-name column collapsed to 78 px and the action buttons were
pushed out of the visible area entirely. Every column now has an explicit
width with an elastic file-name column, and the renderer re-fits the table on
resize, on a sidebar toggle and when the table becomes visible — so the
buttons are always reachable.

**Also fixed, in the same pass:** the AI bubble's text was white on the
accent colour (1.84:1 — now AA); the context menu was a set of `div`s that a
keyboard could never reach (now real buttons with arrow-key navigation,
Shift+F10, and focus restored on close); the download list, the AI history
and the toast stack had no live regions; seven category-path inputs had no
label; the light theme failed WCAG AA on seven token pairs; the download
list could wedge on a blank start; a local web page could POST to the app's
API (it may now read, not write); `open-external` matched a URL by string
prefix instead of by parsed host and path; `gallery-dl` now verifies the
binary against the release's published `SHA256SUMS` before it runs; and
signed URLs, session tokens and query secrets are redacted from the logs.

New regression suites: `test/mcp-server.js` (150 checks), `test/resume-integrity.js`
(32), `test/upgrade-hardening.js` (108), `test/ui-responsive-table.js` (34).
Full suite: **116/116**.

## What's New in v5.9.9 — Facebook / Twitter / every non-HLS site lists links again

**Fixed — "badge 3 · 0 downloadable links" on Facebook, Twitter and other
sites while YouTube kept working.** The HLS family canonicalization added in
the HLS integration returned its *input array* when a page had no HLS
playlists (the common case: Facebook progressive MP4s, Twitter MP4 variants,
plain MP4 pages). The panel caller then clears `cands` and refills it from
that result — with result === `cands`, the clear emptied the very list being
iterated, so every row vanished. YouTube (canonical watch row) and HLS-only
sites (fresh output array) were unaffected, which is exactly the reported
split. `canonicalizeHlsFamilies` now returns a copy; the pill badge and the
panel agree again.

- New executed regression suite `test/hls-canonical-purity.js`: runs the
  SHIPPED canonicalizer plus the SHIPPED caller clear+refill pattern against
  Facebook-shaped (extensionless fbcdn + `bytestart`), Twitter-shaped
  (`pu/vid/….mp4`) and plain-MP4 candidates, and asserts HLS master/variant
  collapse still works. Fails on the pre-fix code, passes after.
- Live before/after on a real playing-video page in a real Chromium runtime:
  panel pipeline `cands/rows/ordered` went 0/0/0 → 1/1/1 with the correct row.
- Full suite: 112/112.

**If links still look missing after updating:** reload the unpacked extension
in `chrome://extensions` (⟳) and refresh the video tab — an unpacked extension
never picks up file changes on its own.

## What's New in v5.9.8 — the reload banner actually renders + stale-tab guidance

**Fixed — "can't download Twitter/Facebook/YouTube anymore" AND an empty
capsule, with no explanation.** Live research (real YouTube page in a real
Chromium runtime + the running app) proved the detection pipeline and the
extension→app chain healthy: the pill offers the canonical link, the service
worker connects, resolvers answer. The failure state is the browser keeping a
DEAD extension registration after the unpacked extension's files changed
mid-edit ("Service worker registration failed. Status code: 15") — unpacked
extensions do not auto-reload, so only a manual ⟳ in chrome://extensions
revives it. v5.9.7 shipped guidance for exactly this state, but two defects
kept it invisible:

- **The reload banner never rendered.** It read `pd` before the `let pd`
  declaration inside `buildCapsulePanel` — a temporal-dead-zone ReferenceError
  swallowed by the surrounding try/catch. The banner now renders after the
  panel-data round-trip, verified live in a reproduced dead-SW registration
  (banner shown, download rows still offered) and silent with a live worker.
- **A silently dead message port showed no guidance.** Some runtimes never set
  `chrome.runtime.lastError` for a dead worker — the panel-data request just
  times out. The 1.5 s timeout now reports `bgDead` too (a live worker answers
  this handler in milliseconds), so the banner appears in that case as well.
- **Stale tabs after a reload** ("Extension context invalidated") now get the
  same "⚠ Reload extension" guidance on pill buttons and popup rows instead of
  a bare "Failed".

Locked by test/panel-freshness.js (19 checks, incl. EXECUTED shipped-code
regression: the fixed segment renders the banner, the old order provably
renders nothing); full suite 111/111.

**If downloads or the pill ever stop working everywhere at once:** open
chrome://extensions, press ⟳ on AiDM (or remove + re-load unpacked from
`aidm/chrome-extension`), then refresh the video tab. The app itself is fine.

## What's New in v5.9.7 — dead-extension detection ("can't download anything")

**Fixed — downloads failing everywhere with no explanation.** Research against
the live app proved the resolver stack healthy (YouTube resolve returned 10
qualities; Twitter/Facebook dispatch responded; yt-dlp 2026.10.26 healthy) and
the extension→app chain intact — the actual culprit class is a Chrome service
worker that failed to REGISTRATION (e.g. the unpacked extension was reloaded
while its files were being updated), which kills every click silently: the pill
still renders, every button says "Failed", and zero rows reach the app. The
extension now tells you: `chrome.runtime.lastError` ("Receiving end does not
exist") is surfaced as **"⚠ Reload extension"** on every pill button and popup
row, and an open pill panel shows a banner — *"AiDM extension background is not
responding — reload it in chrome://extensions (⟳)"* — instead of failing
invisibly. Locked by test/panel-freshness.js (12 checks incl. the three new
dead-SW wiring checks); full suite 111/111.
## What's New in v5.9.6 — pill panel fix + HLS download hardening

**Fixed — the floating pill counted links but the panel was empty**
("badge 6 · 0 downloadable links", members.nubiles-porn.com class of sites):
mindgeek-family CDNs ship HLS playlists with the legacy Apple content type
`audio/x-mpegurl`, and the not-a-video filter classified every master/variant
manifest as an audio-only file and deleted it from the panel — while the pill
badge (which never consults content types) kept counting the same links. All
three dropVideoCandidate copies (capsule, background picker payload, popup)
now exempt playlist URLs from the audio verdict, and the panel gained two
fail-open guards: an empty expansion result re-surfaces the canonical
candidates, and per-video scoping can no longer leave an open panel with zero
rows while rows exist.

**Fixed — junk init-segment rows next to the real qualities**: fMP4 init
segments carry rendition suffixes on these CDNs (`init-v1-a1.mp4`), which
slipped past the old `init.mp4` segment filter and surfaced as bogus rows.
Segment detection now matches `init[-_]*.mp4` (real files like
`initial-cut.mp4` are untouched) in all three copies.

**Fixed — HLS links routing to Chrome's native downloader saved the manifest
TEXT as "video.mp4"**: the Cloudflare-wall pre-flight now skips playlist URLs
entirely — the desktop engine owns `.m3u8`/`.mpd` (it expands master →
variant → segments with the captured browser headers), so an HLS click always
produces an assembled video, never a 300-byte text file.

Locked by `test/hls-master.js` (61 checks incl. the new section 8) and
`test/facebook-junk.js` (38 checks incl. three-copy playlist-exemption
parity); full suite 111/111.
## What's New in v5.9.5 — HLS master detection + protected-CDN downloads

**Fixed — player-based HLS sites only showed fragments, never the real video**
(mindgeek SPA sites: the deliverable is a tokened `master.m3u8`, hls.js then
fetches variant playlists + segments). Four detection gaps closed:

- The capsule no longer discards the background webRequest sniffer's `.m3u8`/
  `.mpd` captures — previously the ONLY copy of the master was thrown away
  whenever the in-page interceptor missed the player's own XHR.
- **Master canonicalization**: playlists group by release root
  (`…/<hash>.mp4/`); one master per video replaces the master+variant
  "fragment" stack, and a master is *reconstructed* from a lone child
  playlist (same release root, signed query preserved) and validated against
  the live CDN before being offered.
- **CORS-free quality expansion**: master expansion moved to the service
  worker — a page-context fetch is bound by the page's CORS policy, so
  private-CDN masters never expanded into per-quality rows (1080p/720p/…).
- SPA data-API JSON bodies are scanned for embedded manifests — the master
  URL is caught at the API layer, before the player fetches anything.

**Fixed — "HTTP 403" on Cloudflare-walled hosts** (mediaboxplayer.com case):
the browser's partitioned (CHIPS) cookie jars are now read for downloads, a
service-worker pre-flight detects challenge-walled hosts, and those files are
handed to Chrome's own downloader (its TLS fingerprint + cookies pass where a
non-browser client cannot).

**Fixed — "HTTP 474" on tokened stream CDNs**: relative child URIs (variants,
segments, init maps, AES-128 key URIs) inherit the parent playlist's signed
query when it is token-gated; 470–479 rejections now explain that a bare
pasted link cannot carry the browser context the CDN checks — re-detect from
the page via the extension instead.

Locked by `test/hls-master.js` (61 checks on real URL shapes); full suite
111/111.

## What's New in v5.9.4 — re-download fix + application identity

**Fixed — second download of the same file never started.**
`findDuplicate()` matched ANY row sharing the URL — including rows already
completed, errored or cancelled — so re-adding a finished link was bounced off
the dead row with "Already in the download list" and nothing downloaded. Now
only LIVE rows (queued / pending approval / connecting / downloading / paused /
muxing) dedupe, which keeps the site-button + extension-capsule double-fire
protection. A finished download's URL is a fresh request: the new copy lands
alongside the first as `name (1).ext` (the engine's onConflict:'rename' —
nothing is ever overwritten). HLS re-downloads previously truncated the old
recording (they open the output with `'w'` and have no `.part` staging); fresh
HLS starts onto an existing file now retarget the same way. Locked by 18
checks in `test/re-download.js`.

**Added — application identity (author / publisher / website / license).**
- Author, Publisher: **Manjay Dongol** — package metadata, the Windows binary
  version resource (CompanyName/LegalCopyright), the NSIS installer and the
  Add/Remove Programs entry now all carry it.
- Publisher website: <https://github.com/manjayofficial01-ui/AiDM> — wired as
  the app homepage (uninstaller support/about links) and shown clickable in a
  new Settings › General › About panel (links open in the user's browser via
  an allowlisted `open-external` IPC — only the project's own GitHub pages).
- MIT license: full license text shown on its own installer page
  (`build/license.txt`), stated in the binary's LegalTrademarks, and visible
  in the About panel.

## What's New in v5.9.3 — capsule Download button fix

v5.9.2's closed shadow root (so the page can no longer reach the download
buttons) had a side effect: the capsule panel's own "close on outside click"
guard could no longer see the panel's internals in `composedPath()` either —
every press inside the panel was classified as *outside*, the panel closed on
pointerdown, and the Download button could never be clicked (reported on
Twitter/X video pages; it affected the capsule on every site).

**Fixed — extension capsule:**
- The outside-click close guard now recognizes the panel by its shadow HOST
  (the one node a closed shadow tree still exposes to document listeners);
  genuine outside presses still close the panel. Verified with trusted clicks
  in a live Chromium: a press inside yields a path containing the host and no
  internals, a press outside contains neither.
- The open panel no longer rebuilds on every `playing` media event. It
  rebuilds only when detection data actually changed (a new media URL, a
  grown Twitter variant bucket, a size probe resolving) and defers even that
  while the cursor is over the panel — looping players (Twitter/X fires
  `playing` every few seconds) previously wiped the Download button out from
  under the cursor mid-click.
- 11 new regression checks in `test/capsule.js`; the `youtube-extension`
  suite's multi-line source anchors are now CRLF-tolerant (they false-failed
  7 checks on Windows `core.autocrlf=true` checkouts).

## What's New in v5.9.2 — security audit release

A five-surface defensive audit (local HTTP API, renderer + extension XSS,
filesystem write paths, subprocess/SSRF/secrets, Chrome extension) produced a
fix list of 19 confirmed issues, all fixed and locked by a new
`test/security-hardening.js` suite (40 checks, including a live loopback
redirect test). The audit **confirmed the core is sound** — the origin/Host
gates block drive-by CSRF and DNS rebinding, zip extraction refuses every
slip shape, all subprocess spawns are argv-only with `--` separators, the
cookie vault is DPAPI-encrypted, and exported/persisted data is
credential-scrubbed.

**Fixed — credential forwarding:**
- The default file probe (`_probeFileOnce`) forwarded `Cookie`/`Authorization`
  to whatever host a 302 pointed at — the one transport that had missed the
  cross-domain credential stripping the other three apply. Redirect hops now
  strip credentials and drop the cookie jar when the hop leaves the row's
  registrable domain (live-tested: `127.0.0.1 → localhost` strips, same-host
  CDN hops keep working).
- Metalink mirrors and imported mirror lists inherited the row's full
  credential set. Both metalink expansion and the engine's per-mirror request
  headers (`headersForTarget`) now attach cookies only to mirrors sharing the
  row's registrable domain.
- A forged Drive "confirm form" could aim the cookie-carrying follow-up
  anywhere; the action URL is now pinned to Google hosts.
- The audio-mux fetch no longer replays row cookies/Referer to an audioUrl on
  a foreign registrable domain.

**Fixed — XSS:**
- The extension popup escaped `&<>` but not quotes inside a `title="…"`
  attribute — a server-chosen Content-Disposition filename or URL basename
  could inject markup into the popup (UI spoofing in a privileged context).
  `escapeHtml` now escapes quotes; the format badge is escaped too.
- Imported download lists could smuggle a `segments` array with an attacker
  `state` string into `class="…"` in the row renderer and the block-grid —
  renderer XSS with full IPC access. Imports now reduce `segments` to a sane
  connection count, and both renderers validate the state token.
- Status badges/labels harden their class + fallback paths the same way.

**Fixed — extension hardening:**
- Click-to-download auto-send and the takeover hotkeys accepted **synthetic**
  (page-dispatched) events; a hostile page could queue downloads (triggering
  cookie capture) and flip takeover state with no user gesture. Both now
  require `event.isTrusted`.
- The extension only sent http(s) URLs to the desktop; `file:`/`ftp:`/`data:`
  garbage is refused before the local API call.
- The floating capsule's shadow root is now **closed** (the page could read
  row metadata and click its buttons), the `get-panel-data` handler locks
  content scripts to their own tab's sniffed history, and the DNR Referer
  rewrite rule is confined to the requesting tab instead of being
  browser-global for its TTL.

**Fixed — local API & desktop:**
- Rate limiters on `/api/video-detected` (each call popped the modal quality
  picker) and the approve/remove/cancel/reject endpoints.
- The extension-pairing dialog now defaults to **Block** — Enter no longer
  grants an extension the full API.
- The post-download command hook refuses shell/script interpreters
  (cmd/wscript/cscript/mshta/rundll32/regsvr32): a downloaded file can carry
  any server-chosen name, and `cmd.exe evil.bat` executes it.
- Imported settings cannot smuggle that class of command either; the hook's
  refusal is recorded on the row.
- `~/.aidm_settings.json` (AI key + file-host credentials) is written `0600`
  and tightened on load.
- Windows reserved device names (`NUL`, `CON`, `COM1`…) are neutralized in
  row names — writing `NUL.ts` targeted the NUL device (silent data loss).
- gallery-dl stderr (full tokenized URLs) is redacted before it reaches row
  errors, the UI and the state file.

**Known limitations (documented, by design):** the local API does not
authenticate native processes (no-Origin requests are trusted — CLI/harness
surface); the extension authenticates the desktop by pairing, not by shared
secret, so a local process that squats the port before AiDM starts could
receive extension POST bodies; the gallery-dl installer validates its
downloaded binary by executing it (no published checksums exist upstream).

---

## What's New in v5.9.1

**Fixed: "An object could not be cloned" breaking adds and list refresh.** Every
download row carries live scratch fields — including `_probePromise`, a real
Promise, which Electron's IPC serializer (structured clone) can never
serialize. Any IPC payload touching a probed row failed wholesale:
`add-download` intermittently returned "Download failed: An object could not
be cloned." (the race depended on when the probe started), and `get-downloads`
was permanently broken for the rest of the session once any row had probed —
surfacing as "Could not load your downloads" after F5 or a window reload
mid-session. The UI hid most of it because live progress flows through push
events, but every refresh path hit the wall.

- **One sanitizer at every row-shaped IPC boundary** — `downloadManager.rowForIpc()`
  strips the live scratch fields and scrubs session cookies exactly like the
  persisted state does, and is now applied to `get-downloads`, the
  `add-download` / `pause` / `resume` / `cancel` / `approve` / `reject` /
  priority / speed-limit handler returns, and the main-process event forwarder.
  Non-row payloads (progress deltas, `video-detected`, plain ids) pass through
  untouched, so the quality picker's cookie flow is unaffected.
- **The live row is never modified** — authenticated replay (cookies, headers)
  keeps working exactly as before.
- Locked by new suite `test/ipc-row-sanitize.js` (17 checks, including a
  `structuredClone` round-trip of the sanitized view and a list mapping).

## What's New in v5.9.0

- **gallery-dl engine (250+ gallery sites)** | Pixiv, danbooru-family, kemono, Patreon and more route through the official gallery-dl subprocess (the yt-dlp pattern: external GPL-2.0 tool, never bundled, SHA-verified installer offered in-app from Settings › gallery-dl). Direct file URLs are never stolen by the routing, and a per-URL `--download-archive` gives pause/resume/dedupe for free.
- **Global connection budget** | A fair-share cap (default 24, 0 = off) on total connections across **all** running downloads — running many downloads at max connections each no longer slows every one of them; each download grows back as another finishes. Settings › Network.
- **Udemy course downloads** | A course URL is a curriculum, not a file: yt-dlp extracts the whole playlist into a per-course folder. DRM-protected content is refused with a clear `drm` error, never half-downloaded.

---

## What's New in v5.4.0

The **automation and follow-through** release. Five capabilities that every serious
competitor ships and AiDM did not, each with a dedicated test suite and adversarial
coverage for the two that touch untrusted input.

### New: archive auto-extract (Settings › Downloads)
A finished ZIP is unpacked into a folder beside it, so a multi-part release is ready to
use the moment the download completes — the JDownloader/Gopeed/FDM behaviour.
- **Dependency-free ZIP reader** (`src/archive-extract.js`): reads the central directory
  directly and inflates with the standard library. Zip64 archives are supported.
- **Every entry is CRC-verified.** A truncated or patched archive produces a *skipped*
  entry, never a file that looks fine and is corrupt.
- **Zip-slip hardened.** Absolute paths, drive letters, UNC paths, `..` segments, NUL
  bytes and symlink entries are all refused, and the resolved path must still be inside
  the destination after resolution. Refusals are reported on the row.
- **Honest about what it cannot do:** 7z, RAR and password-protected archives are
  reported as such instead of failing silently. The source archive is only deleted when
  you opt in *and* every entry extracted cleanly.
- Off by default. Extraction runs before your post-download command, so an antivirus
  hook sees the unpacked payload rather than the wrapper.

### New: command line + "Open with AiDM"
`AiDM.exe <url> [<url> …]` now queues downloads, and a second launch forwards its
arguments to the running instance instead of being ignored (IDM's `/d` pattern).
- `--add-file <list.txt|.json|.csv>` queues a whole list; `--hidden` / `--minimized`
  still work; `--version` / `--help` answer without opening a window.
- URLs go through **the same resolver routing as the browser extension**, so a YouTube
  or Twitter page URL opens the normal quality picker.
- A bare path is never treated as a URL — only `http`/`https`/`ftp`/`magnet` are
  accepted, and anything unrecognised is reported rather than guessed at.

### New: sleep inhibition while a download is running
An idle-sleep timer used to silently kill long transfers overnight. A suspension
blocker is now held exactly while bytes are moving (or a scheduler session is running)
and released the moment nothing is transferring. The display is never kept on, and a
machine that is already asleep is not woken. Toggle in Settings › General.

### New: grab every file on a site
A recursive site grabber — point it at a page and it collects every downloadable link.
- Same-origin crawling with depth/page/file/time caps; off-site *file* links are listed
  (that is how CDNs and mirrors serve downloads) but off-site pages are never crawled.
- **robots.txt is honoured** by default, with a polite delay between requests.
- Results are checkboxes: nothing downloads until you press Add, and then it goes
  through the normal `addDownload()` door.

### Improved: checksum input handling
- The algorithm is now **inferred from the digest length** (32/40/64/128 → MD5/SHA-1/
  SHA-256/SHA-512), so a bare digest verifies without being labelled.
- Accepts `sha256:<hex>`, `SHA-256 <hex>`, `0x<hex>`, uppercase, and colon/dash-grouped
  digests — the class of input that makes FDM report "Verification Failed" on a good
  file (their ticket #272855).
- A digest of the **wrong length is now a clear error** instead of a mismatch that
  blamed the downloaded file.

### Tests
6 new suites (`archive-extract`, `auto-extract`, `cli`, `keep-awake`, `checksum`,
`site-grabber`) — **73/73 suites green**, up from 67. The archive and crawler suites
assert the attack cases, not just the happy path; `auto-extract` drives the real
completion pipeline against a real HTTP download rather than stubbing it.

---

## What's New in v5.0.0

The proxy release — plus a deep audit that fixed over 30 correctness, security and performance bugs across the engine, server, UI and Chrome extension.

### New: Full proxy support
- **HTTP / HTTPS CONNECT tunnels and SOCKS5 / SOCKS5h** (RFC 1928), with **RFC 1929 username/password** auth and credentials embedded in the URL (`http://user:pass@proxy:8080`). SOCKS5h delegates DNS to the proxy.
- Wired through the **entire stack**: pooled keep-alive download connections (sockets stay keyed by target origin, so reuse works exactly like the direct path), plain-HTTP absolute-URI relay, TLS-over-tunnel with correct SNI, and **yt-dlp subprocesses** (`--proxy`) for YouTube and generic probes.
- Configured live in **Settings → Network**; changing it rebuilds the socket pool. Covered by 45 loopback checks in `test/engine-proxy.js` against in-process fake CONNECT proxies, dual relays and a spec-correct SOCKS5 server.

### New: Network & engine controls (Settings → Network)
- **Max connections per download** (1–32, hard cap), **min split size (KB)**, and **disk pre-allocation** — sparse or aria2-style full zero-fill.
- **Per-host connection cap** (0–64, default 16) — a new cross-download `HostGate` limits total simultaneous connections to one host, parking tasks on a waiter callback (no polling) and waking them exactly as slots free.

### New: Long-tail video sites (Vimeo • TikTok • Reddit • Twitch clips)
- A generic yt-dlp resolver registered **last** in the provider registry: a strict host+path allowlist (never a blanket "try yt-dlp on every URL"), it refuses file-extension URLs, prefers **progressive single-file MP4** with an HLS m3u8 fallback, and feeds the existing quality picker. DASH-only catalogs get a clean explanation instead of a silent-video file.

### Extension: never "not connected" again
- **Port auto-discovery** — when the health check fails, the extension sweeps 18765–18772 (the server auto-increments above 18765 when the port is taken) instead of giving up.
- 16 further fixes: MV3 service-worker suspension amnesia (live state now persisted in `chrome.storage.session` and rehydrated), `chrome.alarms` replaces `setInterval`, SPA-navigation detection relayed from the MAIN world, DNR rule-id collisions after SW restarts, self-download re-interception loops, token-stripping narrowed to per-CDN hosts, unhandled promise rejections in the Chrome-fallback path, `lastError` handled at every messaging call site, visibility/idle gating for polling, shared debounced scan scheduler, and dead code + redundant manifest entries removed.

### Security hardening
- **`GET /api/settings` removed** — it leaked file-host passwords and the AI key to any web page that hit the local port; origins are now gated by an explicit trust check (403) and ACAO is no longer `*`.
- **Command injection fixed** — post-download actions ran through `spawn` with a shell; a filename like `x & calc.exe &.mp4` executed code. Now `shell:false` with a quote-aware tokenizer.
- `export-settings` redacts secrets; save paths are confined to the configured folders; batch bodies capped at 32 MB; `_readBody` no longer corrupts UTF-8 or degrades O(n²); yt-dlp partial cleanup/adoption now matches strict job-name patterns and can no longer delete or rename unrelated user files.

### Engine correctness (critical bug fixes)
- **Split-vs-completion race** — a shrunk in-flight segment produced a phantom "Incomplete response" → 416 → full restart from zero. Re-evaluated against the current segment end.
- **Pause/cancel hang** when every segment sat in retry backoff (`_settleIdleLoop` resolves the loop now).
- **Unbounded RAM** on slow origins — `robustFetch` now honours backpressure (pull-based pause/resume, zero-copy enqueue); one failed HLS segment no longer buffers sibling downloads unboundedly.
- **Speed limit was double-charged** (exactly half the configured rate).
- **HLS fd leak** kept cancelled files undeletable on Windows; `fsync` ordering fixed under sparse pre-allocation; resume of unknown-size downloads no longer persists `NaN` segment ranges; rate-limiter `sleep()` is abortable; fetch timeout is per-task instead of hardcoded 30s.
- **Keep-alive pool**: changing `maxSockets` now rebuilds pooled agents (it used to be first-wins).

### App / resolver fixes
- Scheduler time commands actually fire (validated `{type,time,date,days}` shape); `activate` no longer re-created handlers and a second engine; `.bak` progress-flush throttle restored (a 5 s reset made every tick forced); AI-judgment cache gained a size cap + eviction; quality picker could pick a **watch-page URL** as the "best MP4" (now `directUrl`-filtered); mp3 mime corrected; yt-dlp stderr re-split inflated progress ("finished" replayed); media-probe TS/MKV fallbacks and a PAT/PMT CRC off-by fixed; Facebook page scan went from O(n²) to a single regex; ffmpeg mux timeout raised 300s→900s for re-encode fallbacks.

### UI/UX (15 fixes + 3 features)
- XSS-safe attribute escaping on rows and the quality picker; Escape closes the scheduler; Delete no longer fires while typing; sidebar badges and select-all finally match the active filter; progress percent clamped and falsy-zero fixed; **all six overlays gained focus traps**, backdrop close and focus restore; the 250 ms refresh patches rows in place instead of rebuilding the table.
- **Auto theme** (light/dark/auto, follows the OS, persists), **Ctrl+F** search focus with clear button, **"Clear completed"** toolbar action, and arrow-key row navigation with Enter.

### Tests
- New suites wired into `npm test`: `test/engine-proxy.js` (45 checks) and `test/generic-resolver.js` (22 checks); the full chain is green.

---

## What's New in v4.9.0

Deep modernization pass: download-engine hardening, AI-era features, and a full UI redesign.

### Fixed (download blockers & bugs)
- **HLS probe field contract** — `probeHlsSize` now returns `totalSize` / `isLive` / `container` (was `size` only), so HLS rows get real sizes, live caps, and `.mp4` vs `.ts` correctly; unknown-size HLS can auto-resume after restart.
- **Redirect hop cap** on `robustFetch` (max 10) — redirect loops no longer hang segment workers.
- **HTTP 501 is permanent** — no more full retry budget burn on method-blocked CDNs; mid-stream 401/403/501 get the same friendly guidance as the probe path.
- **Probe race no longer drops late meta** — name/size/dead-link guards still apply when the soft 8s timeout loses the race.
- **Resume offsets** work when `totalSize` is unknown (segment map present).
- **`toDownloadError` defaults non-retryable** for non-network faults (stops retry storms).
- **Incomplete finals** are renamed to `.part` instead of sitting as a corrupt completed file.
- **Tiny yt-dlp outputs** — empty or HTML/error-page stubs are rejected; tiny legitimate media containers (ftyp/mkv/ID3/…) are kept.
- **DASH (`.mpd`)** routes through yt-dlp instead of a hard "not supported" reject.
- **Auto-resume** also covers unknown-size rows; still skips `needsSession` rows.

### AI-era
- Auto **categorize** on add (fail-open) and **explainError** hints on failed rows (`aiHint`).
- **AI summarize** helper for transcripts/subtitles (`ai-summarize` IPC) and **post-download summary** when a `.srt`/`.vtt` sidecar exists (`<name>.summary.txt`).
- **Export / import** download list (cookies scrubbed) + plain URL list import.
- **Batch URL paste** in the Add dialog (one URL per line).
- **Natural-language queue commands** in the AI assistant: `download <urls>`, `limit speed to 512 KB/s`, `schedule daily at 22:00`, `pause all` / `resume all` — parsed locally, no model round-trip.

### Session resume + file hosts
- **Encrypted cookie vault** (Electron safeStorage / DPAPI) restores session cookies so `needsSession` rows can auto-resume after a restart. Cookies never sit in plaintext in the downloads JSON.
- **Free-host wait auto-retry** — Rapidgator-style wait timers retry automatically after the countdown (captcha is never bypassed).

### UI/UX (dark glass redesign)
- Premium dark-first glass (Arc/Linear) with **light theme twin** + titlebar theme toggle.
- SVG icon chrome, selection action bar, settings left-nav tabs, sortable columns, live **speed sparkline**, stacked toasts, empty-state CTA, type-filter counts.

## What's New in v4.8.3

**Facebook videos still downloading silent — the remaining root cause.** v4.8.1 fixed four split-AV pairing gaps, but one detection bug survived: Facebook tags many audio-only DASH renditions with a **codec fingerprint instead of the word "audio"** (`dash_ln_heaac_vbr3`, `dash_aac_lc`, `dash_mp4a.40.2`, `dash_ln_heaacv3`). The track classifier only matched `/audio/i`, so those audio renditions were misclassified as **video** rows — the real video then shipped with no `audioUrl` and downloaded silent.

### Fixed
- **Audio-codec fingerprints are now recognized.** `efgIsAudio` (desktop resolver) and `fbTrackKindOfUrl` (extension content + background) match `audio` **or** an audio codec tag (`heaac`, `aac[_-]`, `mp4a`, `opus`, `vorbis`) — while never misclassifying video codecs (`vp9`/`av1`/`avc1`/`hev1`). Also reads `vencode_tag` as a secondary descriptor.
- The audio codec-fingerprint regex shape was routed through **Jev triage** (TypeSafe System One) to pick the precise, non-over-broad pattern.

**Tests:** `facebook-resolver` grew 54 → **58** checks — codec-tagged audio is detected as audio, video codecs never misclassified, and an end-to-end codec-tagged page still pairs audio onto the video row (never silent, audio never listed as a video).

---

## What's New in v4.8.2

**Faster engine + smarter link capture.** The download engine now reuses pooled keep-alive connections across segment and probe requests (IDM's headline technique — no fresh TCP+TLS handshake per request), and copied URLs the static patterns can't classify get a second opinion from Jev (TypeSafe System One) link triage instead of being silently dropped.

### New
- **Keep-alive connection pooling** | One shared `http`/`https` agent per mode (secure / insecure-TLS / plain HTTP, LIFO, 64-socket cap) across all three request paths; probe bodies drain reuse-friendly so sockets return to the pool. Measured: 6 probe requests over 4 connections (was 6/6); segment GETs fully reuse. Pooled sockets are released on app quit.
- **Jev link-triage fallback** | When clipboard capture meets a URL no static pattern recognizes, `src/jev.js` asks Jev (Choice: video/audio/image/file/webpage + Noul: downloadable?) with URL-anatomy state, 4 s timeout, 10-min cache, circuit breaker and fail-open everywhere. Confident downloadable verdicts surface as links; pages stay ignored. Toggle: the `jevAssist` setting (default on), gated live at call time. Key comes only from `TYPESAFE_API_KEY` — never logged, never stored.

**Tests:** new `jev-classify` (16) and `engine-agents` (11) suites, both wired into `npm test`.

---

## What's New in v4.8.1

**Facebook/Instagram videos used to download with no sound.** Facebook serves some videos as *split DASH* renditions — the picture and the sound are two separate URLs that share an `efg` video_id. The desktop muxes them back together after download, but four gaps could leave a video row without its audio counterpart, producing a silent file.

### Fixed
- **Extensionless audio renditions were dropped.** Audio harvesting ran *after* the `.mp4`/`.m3u8` extension gate, so an audio-only DASH URL with no extension was discarded and the video row shipped with no `audioUrl` → silent. Audio is now classified first, regardless of extension.
- **Audio-specific page keys were never scanned.** Added `audio_url`, `dash_audio`, `audio_browser_native_hd/sd_url`, `playable_audio_url` patterns (previously only the video keys were read).
- **Duplicate audio entries broke the single-audio fallback.** The same audio surfacing under two keys was harvested twice, so the sole-audio pairing path never fired. Audio URLs are now deduped.
- **Id-less video rows never paired.** Added a page-identity fallback so a progressive row with an opaque hash filename still pairs with the page video's audio.
- **`queueDownload` silently dropped `audioUrl`** (only `addDownload` kept it).
- **Re-adding a duplicate lost a newly-found audio track** — the live row (and a already-completed file) now gets the audio attached and re-muxed instead of staying silent.
- **Audio recovery picked the wrong track** when several qualities re-resolved — now prefers the audio matching the downloaded variant (exact URL → same video id/dir → first).

**Tests:** `facebook-resolver` (54) and `av-tracks` (34) gained regression coverage for extensionless audio, `audio_url` keys, dedupe, `queueDownload` audio preservation and duplicate re-add attach.

---

## What's New in v4.8.0

Deep-audit release: 15+ bugs and dead-code findings fixed across the engine, manager, UI and extension — headlined by **per-video link scoping**: the capsule pill (and its badge) now shows only the playing video's own download links on every site, not every link detected anywhere on the page.

### New
- **Per-video link scoping (every site)** | Generalizes Facebook's exact per-video path family to all sites: `mediaPathKey()` builds a query-immune canonical family for any media URL, and `elementMediaKeys()` collects the playing element's own file paths (blob: resolved through the interceptor map). Capsule rows from a *different* video's path family now rank under the "Other videos on this page" divider instead of polluting this pill, and the pill's badge counts only this video's links. Nothing is ever hidden — a wrong guess can never cause a wrong-video download.
- **Post-download actions (AV hook)** | Settings › Post-download actions: run a command on every finished download with `{file}` substituted — the IDM/AntDM antivirus pattern (e.g. Windows Defender `MpCmdRun.exe -Scan -ScanType 3 -File "{file}"`). Runs once per row, after the audio-mux step so the final file is what gets scanned; result recorded on the row.
- **HLS resume now actually resumes** | The engine's HLS write cursor (`hlsResumeIndex`/`hlsResumeBytes`) is persisted with the row and fed back after an app restart — restarted HLS downloads no longer start from zero.

### Fixed (desktop)
- UI progress handler no longer flips a just-paused row back to "Downloading" (same overridable-status guard as the manager).
- `approve-download` IPC silently dropped the rename argument (`filename` now flows through preload → main → manager).
- Extension-status check hardcoded port 18765 while the server auto-increments on conflict — the UI now probes the port actually in use.
- `_persistDownloads` copied the whole `.bak` file on every 5 s progress tick (main-thread stall on large lists) — the backup now refreshes at most every 60 s on the tick, and immediately at state boundaries.
- yt-dlp `download()` used an `async` Promise executor — any early rejection would hang the caller; restructured to settle every path.
- Cancel context-menu item is hidden for finished/failed rows (it was a duplicate of Remove).
- Clipboard status dot reflects the real setting instead of always showing "active"; scheduler empty-state class styled.

### Fixed (extension)
- **SPA state leaks**: `clearPageDetections()` now also resets `detectedLinks`, `twitterVariants`, `metaProbeCache`, `hlsExpandCache`, `audioPlaylistPaths` and `pageScanComplete` — the previous page's links and tweet variants no longer resurface after an in-app navigation.
- **Stale page-HTML race**: an in-flight page fetch that resolves after an SPA navigation can no longer plant the previous page's links into the new page's registry.
- **Interceptor dedup reset**: `sentUrls` clears on pushState/replaceState/popstate, so re-fetched identical URLs on the new page are not silently swallowed.
- **Popup Grab path parity**: "Grab Video" now hides already-sent rows and enriches filename/size via token-insensitive meta lookup, exactly like "Scan Page".
- **Background map hygiene**: tab close now clears `tabNavAt`/`tabYtPage`, and the `resolvedTweets`/`resolvedFbPages`/`resolvedYtPages` retry maps are TTL-pruned.
- Sniffed HLS playlist URLs no longer enter the capsule candidate stream (masters expand via the HLS engine only); images are never counted in the badge.

### Removed (dead code)
- `AiService.summarize`, `pickBestVariant`, `resolutionOf` alias, `fbVideoIdOfUrlInline`, unused popup badge locals, `.quality-select` CSS, `FB_VIDEO_PATH_RE`, the `interceptor-ready` handshake with no listener, and the approval-modal CSS for a modal that no longer exists.

**Tests:** 33 suites, all green — new `popup-video-scope` (22 checks) locks the generalized scoping, SPA resets, interceptor dedup reset and background hygiene.

---

## What's New in v4.7.0

Popup release: the playing video sorts first and gets its own section — and the popup keeps showing every downloadable file type (zip/rar/7z, pdf, exe/msi, doc/docx, ppt/pptx, xlsx, csv, html/css/js, torrent, dmg, iso, images, audio, video).

### New
- **Playing-first sort**: the playing video's rows always sort first, then video type, then quality tier (2160p→360p).
- **"▶ NOW PLAYING" divider**: a green section divider heads the playing video's rows in the popup (capsule keeps its green chip).

### Fixed
- **Duplicate `el` declaration** in the popup render path removed.

**Tests:** 32 suites green (incl. `playing-now` 31 checks for the playing-flag propagation).

---

## What's New in v4.6.0

Reliability + truth-in-UI release: 18 bugs fixed across the engine, manager, server and extension; dead code removed; and a new **"Playing now"** badge that marks the exact video variant the player is rendering (its quality label is the live-measured one — no more guessing which row is the real 1080p).

### New
- **▶ NOW PLAYING badge** (capsule panel + extension popup): rows for the variant actually playing carry a green badge; blob/MSE players map their playing `<video>` to the real CDN URL and tag that row too.
- **Auto-resume setting wired up**: the "Auto-resume downloads on startup" checkbox in Settings was decorative — now it is saved and honored.
- **Atomic state files**: the downloads list and settings are now written tmp+rename with a `.bak` copy; a crash mid-write can no longer wipe your history.

### Fixed (desktop)
- HLS resume after an app restart always re-downloaded from 0% — the persisted resume point is now fed back into the engine.
- Cancel/pause during an HLS stream could leave ghost writers flushing into the deleted/reopened file (generation-token guard).
- HLS failures emitted two `download-error` events (UI flashed two error states).
- Corrupt state JSON silently reset the download list; now falls back to the last good backup.
- Restart no longer resurrects failed downloads as "paused" (auto-resume would retry dismissed errors).
- Rows needing session cookies are never auto-resumed after a restart (cookies are intentionally not persisted — the resume would 401/403).
- `/api/resolve-twitter` bypassed the strict URL registry (a 19-digit media-CDN id could be mistaken for a tweet id); it now routes through the same resolver registry as everything else, and per-endpoint rate limiters stop one runaway tab from starving the others.
- `open-file`/`open-folder` IPC only checked path existence — now restricted to AiDM's own downloads, save folders and logs.
- Settings no longer lose `minimizeToTray`-adjacent toggles; yt-dlp cookie file no longer leaks when spawn fails; ffmpeg stdout can no longer deadlock the mux; scheduler stop windows now fire even if the exact minute is missed, and old fired-keys are pruned.
- UI: completed rows zero their speed and snap to 100%, the aggregate speed counter returns to 0 after finishes, and `formatBytes` can't NaN on corrupt sizes.

### Fixed (extension)
- **SPA navigation staleness**: history.pushState navigations (X, Facebook, Instagram, YouTube) now clear both the background's per-tab stream cache and the page's detection caches — the previous video's links no longer haunt the next one.
- **True sizes only**: rows no longer stamp `performance.transferSize`/`decodedBodySize` (bytes-so-far or compressed bytes) as file size — sizes come from Content-Length/Content-Range probes only. One file can no longer split into "known size"/"unknown size" twin rows either.
- Unbounded caches capped and cleared on navigation; dead `storage`/`activeTab`/`downloads.open`/`declarativeNetRequestWithHostAccess` permissions removed.

| Change | Impact |
|--------|--------|
| **True video dimensions** (`src/media-probe.js`, new) | Resolutions are now *proven*, not guessed. AiDM reads the real width/height/duration/audio-track presence straight out of the container bytes (ISO-BMFF box walk incl. trailing `moov`, EBML/Matroska, MPEG-TS PAT/PMT, `ffmpeg -i` fallback). The old code guessed from quality labels, URL regexes and the playing `<video>` element's *current render size* — which is why a 360p file displayed as 2160p and why every variant on a page showed the same resolution. A new **Dimensions** column in the download list shows `640×360` (solid, with a codec/duration tooltip) for proven geometry, dimmed+italic for a not-yet-verified value, and nothing at all when unknown. No 16:9 is ever fabricated from a height. |
| **Downloads always have audio** | Hard invariant: no non-audio-only choice can ever reach yt-dlp as a bare video format id — `ensureAudioChoice()` rewrites any audio-less DASH choice to `<id>+bestaudio/best`, and `buildFormatSpec()` repairs stale persisted rows too. A merge with no FFmpeg now fails fast and clearly instead of leaving a silent file, partial tracks are cleaned up on failure, and the produced file is probed so a video-without-audio result is rejected rather than reported as success. Split-AV sources (Facebook et al.) are muxed by a generalised `_ensureAudio()` that works for any provider and restores the original on failure. Every row now carries `media.hasAudio`, and `audioMissing` shows a 🔇 badge so a silent file is visible instead of mysterious. |
| **Rapidgator support** (`src/filehost-resolver.js`, new) | Hoster links used to download the page HTML. Rapidgator file pages now resolve to a real download URL via the hoster API when you save an account (**Settings › File hosts**; premium or a session cookie removes the wait), or via the free page flow, which honestly reports the mandatory wait instead of bypassing the captcha. Hoster rows are marked `singleConnection: true, resumable: false` because these links reject `Range` — multi-segment requests were producing corrupt files. Host allowlist, 2 MB body cap, same-family redirects only. |
| **Hardened transfer engine** | `startDownload` no longer forces `onConflict: 'overwrite'`, which silently deleted a finished file of the same name. Truncated/short bodies and 200-responses-to-ranged-requests are now detected instead of being written and reported complete; range-hostile servers collapse to a single connection from the worker path (not just the probe); a restart no longer reuses an already-aborted controller; segment restore clamps past-EOF ends; HLS picks an **audio-carrying** variant instead of blindly taking the top-bitrate one, and reports the real width/height; a short output raises `download-error` instead of a false `download-complete`. |
| **Extension: no more identical dimensions** | The desktop side stopped guessing, but `chrome-extension/content.js` was still stamping `video.videoWidth/videoHeight` onto **every** candidate from a player — so a page offering 360p/720p/1080p `<source>` variants reported one identical resolution for all of them, and on a DASH player the value was just the current adaptive rendition. The element's intrinsic size is now applied only to the variant that element is actually playing; everything else stays unknown and is proven from the file after download. Locked by `test/extension-dimensions.js`. |
| **YouTube: your session is actually used** | yt-dlp runs as a child process and cannot see your browser's login, so cookies AiDM already had were forwarded for direct HTTP downloads but *silently dropped* on the YouTube path — a video you can watch while signed in (private, members-only, age-confirmed) failed with "Sign in to confirm you're not a bot". Cookies the extension captures are now written to a throwaway Netscape cookie file and passed to yt-dlp, for the **probe as well as the download** (otherwise the picker comes back empty). Secrets go through a `0600` file, never an argv entry, and the file is deleted when the job ends. Optional **Settings › YouTube › Read cookies from browser** (`chrome`/`edge`/`firefox`…) lets yt-dlp read that browser's own store — opt-in, off by default. |

Also: `tools/refresh-latest-yml.js` now follows `package.json` instead of re-hashing the previous installer, so updater metadata no longer stays a release behind.

**Tests:** 32 suites, **1,262 assertions, 0 failures** (new: `media-probe` 131, `filehost-resolver` 102, `youtube-audio` 64, `row-media` 59, `engine-reliability` 50, `ui-dimensions` 44, `yt-dlp-cookies` 51, `extension-dimensions` 13, `main-boot` 18).

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
