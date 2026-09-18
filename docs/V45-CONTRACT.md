# AiDM v4.5.0 — shared contract for the parallel fix teams

Every team MUST read this file before touching code. It defines the exact
shapes each module must expose so the pieces snap together without one team
editing another team's files.

## Repo layout (Electron desktop app, `aidm/`)

- `main.js` — Electron main process, IPC handlers. **OWNER: lead**
- `src/download-manager.js` — row lifecycle, queue, persistence. **OWNER: team F**
- `src/download-engine.js`, `src/engine/*` — HTTP/HLS segment engine. **OWNER: team E**
- `src/youtube-resolver.js`, `src/yt-dlp.js` — YouTube. **OWNER: team C**
- `src/resolvers.js` — resolver registry. **OWNER: lead**
- `src/server.js` — localhost IPC HTTP server. **OWNER: lead**
- `ui/app.js`, `ui/index.html`, `ui/styles.css` — renderer. **OWNER: team D**
- `src/media-probe.js` — **NEW, OWNER: team A**
- `src/filehost-resolver.js` — **NEW, OWNER: team B**
- `test/*.js` — plain Node scripts, no test framework. Style: `node:assert`,
  print `  OK   <name>` / `  FAIL <name>`, end with
  `console.log('<name>: N passed, M failed')` and `process.exit(failed ? 1 : 0)`.
  See `test/youtube-resolver.js` for the house style. Test entry points are
  added to `package.json` scripts by the lead — do not edit `package.json`.

Run tests with: `cd /d/000000\ Lab/AiDM/aidm && node test/<your-file>.js`

## 1. `src/media-probe.js` (team A) — TRUE media geometry

Purpose: read the ACTUAL width/height/duration/audio-track presence out of a
media file or buffer. AiDM today guesses dimensions from quality labels, URL
text and the playing `<video>` element size, which is why a 360p file displays
as 2160p and why every row on a page shows the same resolution.

Exports (exact names, CommonJS):

```js
module.exports = {
  probeFile,        // (filePath, { maxBytes = 12MB } = {}) => Promise<MediaInfo|null>
  probeBuffer,      // (Buffer) => MediaInfo|null            (pure, sync)
  probeUrl,         // (url, { headers, fetchBytes, timeoutMs }) => Promise<MediaInfo|null>
  parseMp4,         // (Buffer) => MediaInfo|null   ISO-BMFF / MOV / fMP4
  parseMatroska,    // (Buffer) => MediaInfo|null   MKV / WebM
  parseMpegTs,      // (Buffer) => MediaInfo|null   MPEG-TS
  resolutionOf,     // (MediaInfo|null) => '1920x1080' | null
  labelForHeight,   // (h:number) => '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p' | h+'p'
  resolutionForLabel, // ('720p') => '1280x720' | null   (16:9 table)
  hasAudio,         // (MediaInfo|null) => boolean
  hasVideo,         // (MediaInfo|null) => boolean
};
```

`MediaInfo` shape:

```js
{
  width: number,        // 0 when unknown
  height: number,       // 0 when unknown
  durationSec: number,  // 0 when unknown
  hasVideo: boolean,
  hasAudio: boolean,
  vcodec: string|null,  // 'h264' | 'h265' | 'av1' | 'vp9' | 'mpeg4' | null
  acodec: string|null,  // 'aac' | 'mp3' | 'opus' | 'vorbis' | 'ac3' | null
  container: string|null, // 'mp4' | 'mov' | 'mkv' | 'webm' | 'ts' | 'flv' | null
  bitrateKbps: number,  // 0 when unknown
}
```

Rules:
- `parseMp4` MUST walk the real box tree (`ftyp`/`moov`/`trak`/`mdia`/`minf`/
  `stbl`/`stsd`). Read `tkhd` width/height as 16.16 fixed point and prefer
  `stsd` visual-sample width/height when present. Detect an audio track by a
  `stsd` entry of `mp4a`/`ac-3`/`ec-3`/`Opus`/`.mp3`/`alac` and a video track
  by `avc1`/`avc3`/`hev1`/`hvc1`/`av01`/`vp09`/`mp4v`. Handle `moov` at the
  END of the file (fragmented/streamed MP4) by scanning for the `moov` box
  anywhere in the buffer, and handle `mvhd` duration/timescale.
- `parseMatroska` MUST parse EBML: read `Segment/Info/Duration` (scaled ns),
  `Segment/Tracks/TrackEntry/Video/DisplayWidth|PixelWidth`, and detect
  `TrackType` 1 (video) vs 2 (audio) plus `CodecID` (`V_MPEG4/ISO/AVC`,
  `A_AAC`, `A_OPUS`, `V_VP9`, …).
- `parseMpegTs` MUST scan for a PAT/PMT and report stream types 0x1b/0x24/0x21
  (video) and 0x0f/0x03/0x04/0x81 (audio). Width/height usually unknown → 0.
- `probeUrl` fetches ONLY the first bytes (range request `bytes=0-N`,
  default N = 512 KB, retry with 4 MB if `moov` not found, hard cap 12 MB),
  never the whole file. It accepts an injected `fetchBytes(url, headers, from, to)`
  so it can be unit-tested without network.
- Fallback: when the pure parsers find nothing and `ffmpeg-static` is
  available (`require('./media-mux').resolveFfmpeg()`), run
  `ffmpeg -hide_banner -i <file>` and parse `Stream #0:x: Video: … WxH` /
  `Audio: …` from stderr. This fallback is for `probeFile` only.
- NEVER throw. Return `null` on anything unusable. A wrong dimension is worse
  than none: if geometry cannot be proven, return `width: 0, height: 0`.
- `labelForHeight` buckets: >=2160→'2160p', >=1440→'1440p', >=1080→'1080p',
  >=720→'720p', >=480→'480p', >=360→'360p', >=240→'240p', else `h+'p'`.
- `resolutionForLabel` maps: 2160→3840x2160, 1440→2560x1440, 1080→1920x1080,
  720→1280x720, 480→854x480, 360→640x360, 240→426x240, 144→256x144.

Team A also writes `test/media-probe.js` covering: a synthetic MP4 built inline
(moov before and after mdat), audio-only M4A, MKV header, TS with only video
(→ hasVideo true / hasAudio false), garbage buffer (→ null), and `labelForHeight`
/ `resolutionForLabel`. Generate fixtures in a temp dir with `node:fs`.

## 2. `src/filehost-resolver.js` (team B) — Rapidgator (and file-hoster framework)

Exports:

```js
module.exports = {
  isFileHostUrl,      // (url) => boolean
  parseFileHostUrl,   // (url) => { host:'rapidgator', fileId, fileName } | null
  resolveFileHost,    // (url, { credentials, cookie, fetchImpl, onWait }) => Promise<Result>
  toPickerVideos,     // (Result) => picker array
  fileHostMediaResolver, // { name:'filehost', supports(url), resolve(url, opts) }
  HOSTS,              // { rapidgator: {...} }
};
```

`Result` shape (same contract as every other resolver — see `src/resolvers.js`):

```js
{
  provider: 'rapidgator',
  id, title, thumbnail, duration, canonicalUrl, referer,
  media: [{ type:'file', url, mime, filename, size, width:0, height:0,
            headers, singleConnection: true, resumable: false }],
  pickerVideos: [{ url, quality, resolution, size, format, filename,
                   provider, headers, singleConnection, pageUrl }],
  requiresCredentials?: boolean,
  waitSeconds?: number,
}
```

Rules:
- Support `rapidgator.net/file/<id>/<slug>.html`, `…/file/<id>`, `rapidgator.net/<hash>`,
  and `rapidgator.net/download/<hash>` style URLs. Parse ONLY the identifier.
- Never become a generic fetcher: keep a host allowlist
  (`rapidgator.net`, `www.rapidgator.net`, plus the download/CDN hosts it
  redirects to, e.g. `*.rapidgator.net`, `rg.to`). Refuse anything else.
- Free-user flow: `GET` the file page with a Chrome UA → find the download
  link/POST form → follow it → the direct file URL. Free accounts are forced
  through a wait + captcha: do NOT attempt to bypass captcha or the wait.
  When a wait is required, return `{ waitSeconds }` and a clear
  `requiresCredentials` hint telling the user that a premium account (or a
  logged-in session cookie) removes the wait.
- Premium/session flow: if `credentials.cookie` (a pasted `PHPSESSID`/`user__`)
  or `credentials.user` + `credentials.password` is present, use the Rapidgator
  API: `POST https://rapidgator.net/api/user/login` → token →
  `GET https://rapidgator.net/api/file/download?file_id=<id>&token=<token>`
  → JSON with `response.download_url`. Replay the session cookie on the
  download itself.
- The resolved DIRECT url must be flagged `singleConnection: true` and
  `resumable: false` in `media[]`/`pickerVideos` — Rapidgator free/premium
  links frequently reject `Range`, and multi-segment requests produce corrupt
  files. The manager (team F) reads those flags.
- Attach replay headers (`Referer`, `Cookie`, `User-Agent`) into
  `media[].headers` and `pickerVideos[].headers`.
- Credentials come from `settings.fileHosts = { rapidgator: { user, password, cookie } }`
  (lead adds defaults). `resolveFileHost` accepts them as `credentials`.
- NEVER throw an unhandled rejection. Throw `Error` with human-readable text
  (e.g. "This Rapidgator file requires a premium account or a logged-in
  session cookie — add one in Settings › File hosts").
- Include a pure (no-network) surface so it is testable: `parseFileHostUrl`,
  `extractDownloadUrlFromPage(html)`, `extractApiDownloadUrl(json)`.

Team B also writes `test/filehost-resolver.js` with pure-parser tests only
(no network): URL parsing, page-link extraction from fixture HTML, API JSON
parsing, allowlist refusal, and credential-error messaging.

## 3. Row fields the manager (team F) will persist — every team must match these

```js
download.media = {           // real geometry, proven by src/media-probe.js
  width, height, durationSec, hasVideo, hasAudio,
  vcodec, acodec, container, probedAt
} | null
download.quality = { label, resolution, size, format }   // resolution now
                                                          // comes from the probe
download.audioMissing = boolean   // true when hasVideo && !hasAudio
download.audioUrl = string|null   // paired audio track to mux in
download.singleConnection = boolean
download.resumable = boolean      // default true
```

The UI (team D) reads `dl.media`, `dl.quality`, `dl.audioMissing`.

## 4. Rules for ALL teams

- Do not edit files you do not own (see the owner table at the top).
- Do not edit `package.json`, `src/resolvers.js`, `src/server.js` or `main.js`.
- Keep every function defensive: never throw into the Electron main process.
- Preserve existing exported names — other code and the test suite depend on
  them. Add new exports; do not remove or rename.
- After finishing, run `node test/smoke.js`, `node test/youtube-resolver.js`,
  `node test/embed-resolver.js`, `node test/row-accuracy.js` and your own test
  file; they must all pass.
- Report back in under 250 words: files changed, what was fixed, test results.
