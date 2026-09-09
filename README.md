# ⚡ AiDM - AI-Powered Download Manager v2

> Classic IDM-style download manager with cutting-edge multi-segment technology, Chrome browser integration, video quality detection, and smart per-category file organization.

---

## 📊 Research: Top 5 Download Managers Analyzed

AiDM was built by analyzing and combining the best technologies from the world's top download managers:

### 1. 🏆 Internet Download Manager (IDM)
**Cutting-Edge Tech:**
- **Dynamic File Segmentation** — Splits files into multiple segments and downloads them in parallel
- **Smart Connection Reuse** — Keeps HTTP connections alive to avoid handshake overhead
- **Adaptive Segmentation** — Dynamically adjusts segment count based on connection speed
- **Browser Integration** — Native extension intercepts all browser downloads automatically
- **Resume Capability** — Full resume support via HTTP Range headers
- **Speed:** Up to 5x acceleration through multi-threading

**What AiDM Takes:** Multi-segment engine, dynamic segmentation, browser interception, resume logic

---

### 2. 🆓 Free Download Manager (FDM)
**Cutting-Edge Tech:**
- **BitTorrent Protocol Support** — Built-in torrent client with DHT, PEX, and magnet link support
- **Modern Electron UI** — Clean, responsive interface built on web technologies
- **Remote Control** — Web-based remote management interface
- **Smart File Management** — Automatic categorization by file type
- **Traffic Shaping** — Bandwidth allocation and speed limiting per download

**What AiDM Takes:** Modern web-based UI, file categorization, queue management

---

### 3. 📋 JDownloader 2
**Cutting-Edge Tech:**
- **Clipboard Monitoring** — Automatically detects download URLs copied to clipboard
- **Link Grabber** — Extracts all downloadable links from any webpage
- **Plugin Architecture** — Supports 300+ hosting site plugins
- **Captcha Solver** — Automated CAPTCHA recognition and solving
- **Batch Processing** — Download entire link lists with one click
- **RSDF/CCF/DLC Support** — Encrypted container file support

**What AiDM Takes:** Clipboard monitoring, link grabber, batch downloads, plugin concept

---

### 4. 🎬 Xtreme Download Manager (XDM)
**Cutting-Edge Tech:**
- **Video Stream Detection** — Detects and downloads streaming video (HLS, DASH, progressive)
- **Browser Integration** — Deep integration with all major browsers
- **Video Sniffer** — Monitors network traffic for video streams in real-time
- **Multi-Protocol** — HTTP, HTTPS, FTP, and streaming protocols
- **Smart Scheduler** — Time-based download scheduling with system actions

**What AiDM Takes:** Video detection, resource scanning, network monitoring via content scripts

---

### 5. ⚡ Motrix
**Cutting-Edge Tech:**
- **Aria2 Engine** — Powered by the aria2 download engine for maximum protocol support
- **Electron + Vue.js** — Modern cross-platform architecture
- **Multi-Protocol** — HTTP, FTP, BitTorrent, Magnet links, and Metalink
- **RPC Interface** — JSON-RPC API for external tool integration
- **Minimalist UI** — Clean, distraction-free interface design

**What AiDM Takes:** Electron architecture, local API server for extension communication, clean UI design

---

## 🔧 AiDM Features (Combining the Best)

| Feature | Inspired By | Implementation |
|---------|-------------|----------------|
| Multi-segment downloading | IDM | 1-32 parallel segments with dynamic allocation |
| **Intercept ALL downloads** | IDM | Every browser download routes to AiDM automatically |
| **Video quality detection** | XDM | Detects resolution, quality (4K/1080p/720p), file size |
| **Quality picker** | XDM | Choose video quality before downloading |
| **Per-category paths** | FDM | Auto-save Videos→Videos/, Music→Music/, etc. |
| **Ask location every time** | IDM | Optional folder picker for each download |
| Right-click "Download with AiDM" | IDM | Context menu on links, videos, images |
| Clipboard monitoring | JDownloader | Auto-detects URLs copied to clipboard |
| Video stream detection | XDM | Content script monitors page resources in real-time |
| Link grabber | JDownloader | Scans pages for all downloadable links |
| Batch downloads | JDownloader | Download multiple URLs at once |
| Resume support | IDM/FDM | HTTP Range header resume on restart |
| File categorization | FDM | Auto-detect: video, audio, document, archive, software, image |
| Local API server | Motrix | HTTP API on port 18765 for extension ↔ app |
| Modern UI | Motrix/FDM | Dark theme, IDM-style table with segment visualization |
| Queue management | IDM/FDM | Max concurrent, auto-queue overflow |

---

## 📁 Project Structure

```
aidm/
├── main.js                    # Electron main process
├── preload.js                 # Secure IPC bridge
├── package.json               # Dependencies
├── src/
│   ├── download-engine.js     # Multi-segment download engine
│   ├── download-manager.js    # Queue, scheduling, categories, approval flow
│   ├── clipboard-monitor.js   # Clipboard URL detection
│   └── server.js              # Local HTTP API for Chrome extension
├── ui/
│   ├── index.html             # Main window (with quality picker & approval modals)
│   ├── styles.css             # IDM-inspired dark theme
│   └── app.js                 # UI controller
├── chrome-extension/
│   ├── manifest.json          # Extension manifest (MV3)
│   ├── background.js          # Service worker - intercepts ALL downloads
│   ├── content.js             # Video detection with quality/resolution/size
│   ├── popup.html             # Extension popup with quality badges
│   └── popup.js               # Popup controller
└── README.md                  # This file
```

---

## 🚀 Installation & Running

### Option A — Windows installer (recommended)
1. Run **`dist/AiDM-Setup-2.1.0.exe`** (build with `npm run dist:win`)
2. AiDM installs to Start Menu + Desktop, **starts automatically with Windows** (hidden in the tray), and keeps running when you close the window so clipboard monitoring + browser integration always work
3. Right-click the tray icon → *Quit AiDM* to fully exit; toggles live in Settings → Features

### Option B — Run from source
### Prerequisites
- Node.js 18+ and npm
- Google Chrome (for extension)

### Desktop App
```bash
cd aidm
npm install
npm start
```

### Chrome Extension
1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `chrome-extension/` folder
5. The AiDM icon appears in your toolbar
6. **After every AiDM update: on `chrome://extensions/` hit ⟳ Reload on AiDM, then reload your open video tabs** (Chrome only injects the new content script into freshly loaded pages)

### Usage
1. **Start AiDM** desktop app first
2. **Install Chrome extension** (loads unpacked)
3. **Download files:**
   - Click "Add URL" in the app
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
│  │  • Statistics tracking              │    │
│  └──────────────┬──────────────────────┘    │
│  ┌──────────────┴──────────────────────┐    │
│  │     Multi-Segment Engine            │    │
│  │  • Parallel segment downloading     │    │
│  │  • Dynamic segment allocation       │    │
│  │  • Resume/retry logic               │    │
│  │  • Speed optimization               │    │
│  └─────────────────────────────────────┘    │
│  ┌─────────────────────────────────────┐    │
│  │      Clipboard Monitor              │    │
│  │  • URL pattern detection            │    │
│  │  • Auto-notification                │    │
│  └─────────────────────────────────────┘    │
│  ┌─────────────────────────────────────┐    │
│  │         IDM-Style UI                │    │
│  │  • Dark theme                       │    │
│  │  • Category sidebar                 │    │
│  │  • Progress with segment viz        │    │
│  │  • Context menus                    │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

---

## ⚙️ Technical Deep Dive

### Video Quality Detection (from XDM)
The Chrome extension content script performs multi-layer video scanning:

1. **`<video>` element scanning** — Reads `videoWidth`/`videoHeight` for resolution, maps to quality labels (4K/1080p/720p/480p)
2. **URL parameter parsing** — Extracts quality from URL params (`quality=`, `itag=`, `resolution=`)
3. **YouTube itag mapping** — Recognizes 20+ itag values to exact quality tiers
4. **Quality selector scanning** — Finds download buttons/links with quality labels on video sites
5. **Network resource monitoring** — Uses Performance API to catch dynamically loaded video streams
6. **Size probing** — HEAD requests to get Content-Length for same-origin videos

Results are sent to the desktop app which shows a quality picker modal before downloading.

### Per-Category Save Paths (from FDM)
Files are automatically categorized by extension:
- Videos → `~/Downloads/AiDM/Videos/`
- Music → `~/Downloads/AiDM/Music/`
- Documents → `~/Downloads/AiDM/Documents/`
- Archives → `~/Downloads/AiDM/Archives/`
- Software → `~/Downloads/AiDM/Software/`
- Images → `~/Downloads/AiDM/Images/`

Each category path is configurable in Settings. Leave empty to use the default path.

### Ask Every Time (from IDM)
When enabled in Settings, every download shows a folder picker dialog before starting. The user can:
- Choose any save location
- Check "Remember for this category" to auto-save the choice for future downloads of the same type

### Multi-Segment Engine (from IDM)
The core innovation. Files are split into N segments (default 8, max 32). Each segment downloads independently via a separate HTTP connection with its own `Range` header. The engine:

1. **Probes** the file via HEAD request to determine size and resume support
2. **Pre-allocates** the output file to prevent fragmentation
3. **Launches** N parallel connections, each requesting a byte range
4. **Writes** segments at their correct file offset using random-access writes
5. **Tracks** per-segment speed for potential dynamic reallocation
6. **Retries** failed segments with exponential backoff (up to 5 retries)
7. **Reports** aggregate progress to the UI in real-time

### Browser Integration (from IDM + XDM)
The Chrome extension uses Manifest V3 with:
- `downloads.onDeterminingFilename` — **Intercepts ALL Chrome downloads** (not just filtered ones)
- Context menus — Right-click to download any link/media
- Content script — Scans pages for video/audio sources with quality metadata
- Resource monitoring — Uses Performance API to detect streaming video
- MutationObserver — Catches dynamically loaded content
- Video quality reporting — Sends resolution, format, and size info to desktop app

### IPC Communication (from Motrix)
The desktop app runs a local HTTP API server on `localhost:18765`:
- `GET /api/status` — Health check and stats
- `POST /api/download` — Submit a new download
- `POST /api/batch` — Submit multiple URLs at once
- `GET /api/downloads` — List all downloads

---

## 📝 License

MIT — Free and open source. Inspired by the best, built for the future.
