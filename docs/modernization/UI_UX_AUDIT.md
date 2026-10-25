# UI/UX Audit — AiDM v5.3.3 → v5.4.0

Verified by **rendering the real interface** offscreen in Electron and inspecting the
captures, not by reading CSS. Driver: `.workbuddy-ai/tmp/render-check.js`
(`electron.exe` + offscreen `BrowserWindow` + `capturePage`), screenshots in
`.workbuddy-ai/tmp/shots/`.

## 1. Design system as found

- Token-based theming: `--bg-*`, `--text-*`, `--accent*`, `--border*`, `--radius*`,
  `--shadow`, `--glass*` in `ui/styles.css`, with a **dark default and a light twin**
  selected by `html[data-theme]`; the app follows the OS in `auto` mode.
- Surfaces are glass panels with 10–14 px radii; icon chrome is inline SVG from one
  sprite (`#i-*`), never image files.
- Overlay plumbing is centralised: `openOverlay`/`closeOverlay` handle focus restore,
  `setupOverlayPlumbing()` handles backdrop click and the Tab focus trap, and one
  `Escape` handler closes everything.
- Accessibility already present: `aria-label` on every icon-only button, focus traps,
  `prefers-reduced-motion` block that stops (not removes) looping animations.

## 2. What this cycle added, and why it matches

| Surface | Placement | Rationale |
|---|---|---|
| **Grab site** toolbar button | Immediately after *Add URL* | Same mental model as adding a URL — it is the bulk version of it |
| **Grab site** overlay | Reuses `.modal-overlay` / `.modal settings-modal` / `.form-row` | Zero new visual language; inherits the focus trap, backdrop close and Escape automatically (registered in `OVERLAY_IDS`, `OVERLAY_HIDE`, `isAnyModalOpen` and the Escape list) |
| Results list | `.grab-list` / `.grab-row`, checkbox + monospace URL + `OFF-SITE` tag | Every row states *why* it is there before anything is queued; the Add button counts the selection live |
| **Extract ZIP** toggles | Settings › Downloads, under *Post-download actions* | That section already owns "what happens when a download finishes" |
| **Prevent sleep** toggle | Settings › General, under *Auto-Resume on Restart* | Both are transfer-lifecycle behaviours |
| **Extracted folder** action | New archive-icon button on completed rows, after *Open Folder* | One click to the payload; tooltip carries the extraction note |

## 3. Verified by render (not assumed)

| Screenshot | What it proves |
|---|---|
| `01-main` | Toolbar now has the link icon; layout unchanged, no overflow |
| `02c-settings-general` | *Prevent sleep while a download is running* renders checked, with its explanatory hint, in the correct section |
| `02b-settings-downloads` | Both extract toggles render with correct state under Post-download actions |
| `03-grabber-results` | Overlay, status line ("Found 4 files across 1 page · 1.2s"), checkbox rows, `OFF-SITE` tag on the CDN row, and the live "Add 4 files" label all render correctly |
| `04-row-extract-action` | The archive action button appears on a completed row with `extractDir` set |

Console output during the render: **one** message, Electron's own dev-only CSP warning
(pre-existing, dev builds only). No renderer errors.

## 4. Remaining UX gaps (not addressed)

- The grabber has no keyboard shortcut (every other toolbar action does).
- Results are capped at 500 rows and not virtualised — acceptable at that cap, but a
  "grab the whole site" run on a large archive would need paging.
- The extraction note is only visible as a button tooltip; a dedicated status column
  would be better once more than one post-processing feature reports state.
- No localisation anywhere in the app.
