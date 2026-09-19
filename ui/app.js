/**
 * AiDM v2 — UI Controller
 * Features: Video quality picker, per-category paths, ask-every-time, auto-detection
 */

let downloads = [];
let settings = {};
let activeCategory = 'all';
let selectedIds = new Set();
let contextTarget = null;
let marqueeEndTime = 0; // timestamp of last marquee drag — suppresses stray clicks

const downloadList = document.getElementById('download-list');
const emptyState = document.getElementById('empty-state');
const totalSpeed = document.getElementById('total-speed');
const activeCount = document.getElementById('active-count');
const searchInput = document.getElementById('search-input');

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  downloads = await window.aidm.getDownloads();
  settings = await window.aidm.getSettings();
  setupEventListeners();
  setupIPCListeners();
  renderDownloads();
  updateStats();
  updateExtensionStatus();
  loadAppVersion();
  // Poll extension connectivity every 30s so the status bar stays honest
  setInterval(updateExtensionStatus, 30000);
});

/** Show the app version in the title bar (e.g. "v3.0.0"). */
async function loadAppVersion() {
  try {
    const v = await window.aidm.getAppVersion();
    const el = document.getElementById('app-version');
    if (el && v) el.textContent = 'v' + v;
  } catch (e) { /* older preload — hide the badge */ }
}

/** Hit the local API server to see if the extension path is alive. */
async function updateExtensionStatus() {
  const el = document.getElementById('status-connection');
  if (!el) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch('http://127.0.0.1:18765/api/status', { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      el.innerHTML = '🔌 Extension: <span style="color:var(--success)">Connected</span>';
    } else {
      el.innerHTML = '🔌 Extension: <span style="color:var(--warning)">Degraded</span>';
    }
  } catch {
    el.innerHTML = '🔌 Extension: <span style="color:var(--error)">Disconnected</span>';
  }
}

// ── Render Downloads ──────────────────────────────────────────────────────────

// Progress events arrive up to ~5x/sec per active download (throttled in the
// engine). Rebuilding the whole table for each one froze the UI with several
// active rows — coalesce them into at most one render every 250ms. Events that
// change row state (added/removed/paused/error/complete) still render at once.
let progressRenderPending = false;
function scheduleProgressRender() {
  if (progressRenderPending) return;
  progressRenderPending = true;
  setTimeout(() => {
    progressRenderPending = false;
    renderDownloads();
    updateSpeedDisplay();
  }, 250);
}

function renderDownloads() {
  const filtered = filterDownloads(downloads);
  downloadList.innerHTML = '';

  if (filtered.length === 0) {
    emptyState.style.display = 'flex';
    return;
  }
  emptyState.style.display = 'none';

  filtered.forEach(dl => {
    try {
      renderDownloadRow(dl);
    } catch (err) {
      console.error('Failed to render download row, skipping:', dl && dl.id, err);
    }
  });
}

// ── True media geometry on a row (v4.5) ──────────────────────────────────────
//
// `dl.media` holds the REAL width/height read out of the finished file by
// src/media-probe.js. It is filled asynchronously (after a download completes,
// and lazily after a restart), so a row can legitimately have no geometry yet.
// Rules: proven geometry wins; `quality.resolution` is shown but flagged as not
// verified; and a resolution is NEVER derived from `quality.label` (assuming
// 16:9 turned a 360p file into "2160p" — the bug this fixes).

const QUALITY_TIER_ORDER = { '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, '360p': 0 };

/**
 * Dimensions for a row.
 * @returns {{text:string, proven:boolean}|null} null when nothing is known.
 */
function dimensionInfo(dl) {
  const m = dl && dl.media;
  if (m && Number(m.width) > 0 && Number(m.height) > 0) {
    return { text: `${Math.round(Number(m.width))}×${Math.round(Number(m.height))}`, proven: true };
  }
  const q = dl && dl.quality;
  const res = (q && typeof q === 'object') ? q.resolution : null;
  if (typeof res === 'string' && res.trim()) {
    const pair = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(res);
    return pair ? { text: `${pair[1]}×${pair[2]}`, proven: false } : { text: res.trim(), proven: false };
  }
  return null;
}

/** Compact human duration: "0:45", "12:03", "1:02:03". */
function formatDuration(sec) {
  const s = Number(sec);
  if (!isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** Tooltip for a proven row: duration, video codec, audio codec, container. */
function mediaTooltip(media) {
  const m = media || {};
  const bits = [];
  const dur = formatDuration(m.durationSec);
  if (dur) bits.push('Duration ' + dur);
  bits.push('video ' + (m.vcodec || 'unknown'));
  bits.push(m.acodec ? 'audio ' + m.acodec : 'no audio track');
  if (m.container) bits.push(String(m.container).toUpperCase());
  return bits.join(' · ');
}

/** escapeHtml() plus quotes — safe inside title="…" attributes. */
function escapeAttr(str) { return escapeHtml(str).replace(/"/g, '&quot;'); }

/**
 * HTML for the row's media cell: the dimension readout plus the "no audio
 * track" badge. Returns '' when there is nothing true to say — an empty cell
 * beats a fabricated resolution.
 */
function formatRowMeta(dl) {
  const out = [];
  const info = dimensionInfo(dl);
  if (info) {
    const tip = info.proven
      ? mediaTooltip(dl.media)
      : 'Not verified yet — AiDM measures the finished file after the download.';
    out.push(`<span class="dim-readout ${info.proven ? 'proven' : 'guessed'}" title="${escapeAttr(tip)}">${escapeHtml(info.text)}</span>`);
  }
  // The download itself succeeded — this is a heads-up, not an error state.
  if (dl && dl.audioMissing === true) {
    out.push('<span class="audio-missing-badge" title="This video has no audio track">🔇</span>');
  }
  return out.join(' ');
}

/** Quality badge beside the file name. Label only — never a guessed geometry. */
function qualityBadgeHtml(dl) {
  const q = dl && dl.quality;
  if (!q) return '';
  if (typeof q === 'string') return q !== 'unknown' ? `<span class="file-quality-badge">${escapeHtml(q)}</span>` : '';
  return q.label ? `<span class="file-quality-badge">${escapeHtml(q.label)}</span>` : '';
}

/** Real height of a quality-picker variant, or null when unknown. */
function qualityHeight(video) {
  const v = video || {};
  const h = Number(v.height);
  if (isFinite(h) && h > 0) return h;
  const pair = /(\d{2,5})\s*[x×]\s*(\d{2,5})/i.exec(String(v.resolution || ''));
  if (pair) { const hh = Number(pair[2]); if (isFinite(hh) && hh > 0) return hh; }
  return null;
}

/** Picker sort: real height first (highest first), then the quality-tier map. */
function qualityVideoCompare(a, b, tierOrder) {
  const tiers = tierOrder || QUALITY_TIER_ORDER;
  const ha = qualityHeight(a), hb = qualityHeight(b);
  if (ha !== null && hb !== null && ha !== hb) return hb - ha;
  if (ha !== null && hb === null) return -1;
  if (ha === null && hb !== null) return 1;
  return (tiers[b.quality] || -1) - (tiers[a.quality] || -1);
}

/** Resolution line for a picker variant: proven geometry vs a site claim. */
function pickerResolutionInfo(video) {
  const v = video || {};
  if (Number(v.width) > 0 && Number(v.height) > 0) {
    return { text: `${Math.round(Number(v.width))}×${Math.round(Number(v.height))}`, proven: true };
  }
  if (v.resolution) return { text: String(v.resolution), proven: false };
  if (v.quality) return { text: String(v.quality), proven: false };
  return { text: 'Unknown quality', proven: false };
}

function renderDownloadRow(dl) {
    const tr = document.createElement('tr');
    tr.dataset.id = dl.id;
    tr.className = selectedIds.has(dl.id) ? 'selected' : '';

    const percent = dl.percent || (dl.totalSize > 0 ? (dl.downloaded / dl.totalSize * 100).toFixed(1) : 0);
    const icon = getFileIcon(dl.filename);
    const speedStr = formatSpeed(dl.speed);
    const estPrefix = dl.sizeEstimated ? '~' : '';
    const sizeStr = dl.totalSize > 0
      ? estPrefix + formatBytes(dl.totalSize)
      : (dl.quality?.size ? formatBytes(dl.quality.size) : 'Unknown');
    const downloadedStr = formatBytes(dl.downloaded);
    const etaStr = formatEta(dl.eta);

    // Quality badge (from video detection) — label only, never a resolution
    const qualityBadge = qualityBadgeHtml(dl);
    // True dimensions + silent-audio badge (see dimensionInfo/formatRowMeta)
    const mediaMeta = formatRowMeta(dl);

    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" ${selectedIds.has(dl.id) ? 'checked' : ''} /></td>
      <td class="col-name">
        <div class="file-info">
          <div class="file-icon">${icon}</div>
          <div class="file-details">
            <span class="file-name" title="${escapeHtml(dl.filename)}">${escapeHtml(dl.filename)}${qualityBadge}</span>
            <span class="file-url" title="${escapeHtml(dl.url)}">${escapeHtml(truncateUrl(dl.url))}</span>
          </div>
        </div>
      </td>
      <td class="col-size">
        <div>${sizeStr}</div>
        <div style="font-size:10px;color:var(--text-muted)">${downloadedStr}</div>
      </td>
      <td class="col-dims">${mediaMeta}</td>
      <td class="col-progress">
        <div class="progress-cell">
          <div class="progress-bar">
            <div class="progress-fill" style="width:${percent}%"></div>
          </div>
          <span class="progress-text">${percent}%</span>
        </div>
        ${etaStr ? `<div class="eta-text">ETA ${etaStr}</div>` : ''}
        ${renderSegments(dl.segmentDetails || dl.segments)}
      </td>
      <td class="col-speed">
        <span class="speed-cell ${dl.speed > 0 ? '' : 'zero'}">${speedStr}</span>
      </td>
      <td class="col-status">
        <span class="status-badge ${dl.status}">${formatStatus(dl.status)}</span>
      </td>
      <td class="col-actions">
        <div class="action-btns">
          ${dl.status === 'downloading' ? `<button class="action-btn" data-action="pause" title="Pause">⏸</button>` : ''}
          ${dl.status === 'paused' || dl.status === 'error' ? `<button class="action-btn" data-action="resume" title="Resume">▶</button>` : ''}
          ${dl.status === 'pending-approval' ? `<button class="action-btn" data-action="approve" title="Choose folder">📁</button>` : ''}
          ${dl.status === 'completed' ? `<button class="action-btn" data-action="open-file" title="Open">📂</button>` : ''}
          ${dl.status === 'completed' ? `<button class="action-btn" data-action="open-folder" title="Open Folder">📁</button>` : ''}
          ${dl.status === 'error' && dl.ytLogPath ? `<button class="action-btn" data-action="open-log" title="Open error log">📋</button>` : ''}
          <button class="action-btn danger" data-action="remove" title="Remove">🗑</button>
        </div>
      </td>
    `;

    tr.addEventListener('click', (e) => {
      if (Date.now() - marqueeEndTime < 350) return; // marquee drag just ended — ignore the trailing click
      if (e.target.type === 'checkbox' || e.target.closest('.action-btn')) return;
      if (e.ctrlKey || e.metaKey) {
        selectedIds.has(dl.id) ? selectedIds.delete(dl.id) : selectedIds.add(dl.id);
      } else {
        selectedIds.clear();
        selectedIds.add(dl.id);
      }
      renderDownloads();
    });

    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextTarget = dl.id;
      showContextMenu(e.clientX, e.clientY, dl);
    });

    tr.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
      if (Date.now() - marqueeEndTime < 350) { e.target.checked = !e.target.checked; return; }
      e.target.checked ? selectedIds.add(dl.id) : selectedIds.delete(dl.id);
    });

    tr.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleAction(btn.dataset.action, dl.id);
      });
    });

    downloadList.appendChild(tr);
}

function renderSegments(segments) {
  // Fresh downloads carry a plain segment COUNT (number) until the engine
  // emits progress; only render the bar for a real per-segment array.
  if (!Array.isArray(segments) || segments.length <= 1) return '';
  return `<div class="segments-bar">
    ${segments.map(s => `
      <div class="segment ${s.status}" title="Segment ${s.index + 1}: ${s.status}">
        <div class="segment-fill" style="width:${s.status === 'completed' ? 100 : (s.downloaded > 0 ? 50 : 0)}%"></div>
      </div>
    `).join('')}
  </div>`;
}

function formatStatus(status) {
  const labels = {
    'downloading': 'Downloading',
    'completed': 'Completed',
    'paused': 'Paused',
    'error': 'Error',
    'queued': 'Queued',
    'queued-paused': 'Queued',
    'connecting': 'Connecting',
    'pending-approval': 'Pending',
  };
  return labels[status] || status;
}

function filterDownloads(list) {
  let filtered = [...list];
  switch (activeCategory) {
    case 'all': break; // show everything: downloading, completed, queued, pending, errors
    case 'downloading': filtered = filtered.filter(d => d.status === 'downloading' || d.status === 'connecting'); break;
    case 'completed': filtered = filtered.filter(d => d.status === 'completed'); break;
    case 'queued': filtered = filtered.filter(d => d.status === 'queued' || d.status === 'queued-paused'); break;
    case 'pending': filtered = filtered.filter(d => d.status === 'pending-approval'); break;
    case 'error': filtered = filtered.filter(d => d.status === 'error'); break;
    case 'video': filtered = filtered.filter(d => d.category === 'video' || /\.(mp4|mkv|avi|mov|wmv|webm|flv|m4v)/i.test(d.filename || '')); break;
    case 'audio': filtered = filtered.filter(d => d.category === 'audio' || /\.(mp3|wav|flac|aac|ogg|wma|m4a)/i.test(d.filename || '')); break;
    case 'document': filtered = filtered.filter(d => d.category === 'document' || /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv)/i.test(d.filename || '')); break;
    case 'archive': filtered = filtered.filter(d => d.category === 'archive' || /\.(zip|rar|7z|tar|gz|bz2)/i.test(d.filename || '')); break;
    case 'software': filtered = filtered.filter(d => d.category === 'software' || /\.(exe|msi|dmg|deb|rpm|apk)/i.test(d.filename || '')); break;
    case 'image': filtered = filtered.filter(d => d.category === 'image' || /\.(jpg|jpeg|png|gif|bmp|svg|webp|psd|ico)/i.test(d.filename || '')); break;
    case 'other': filtered = filtered.filter(d => (d.category || 'other') === 'other'); break;
    default: break; // unknown category → show all rather than nothing
  }
  const query = searchInput.value.toLowerCase().trim();
  if (query) filtered = filtered.filter(d => (d.filename || '').toLowerCase().includes(query) || (d.url || '').toLowerCase().includes(query));
  return filtered;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function handleAction(action, id) {
  switch (action) {
    case 'pause': await window.aidm.pauseDownload(id); break;
    case 'resume': await window.aidm.resumeDownload(id); break;
    case 'cancel': await window.aidm.cancelDownload(id); break;
    case 'approve': {
      const dl = downloads.find(d => d.id === id);
      if (dl) showApprovalModal(dl);
      break;
    }
    case 'remove':
      // List-only removal (IDM "Remove"). File stays on disk.
      await window.aidm.removeDownload(id);
      downloads = downloads.filter(d => d.id !== id);
      selectedIds.delete(id);
      renderDownloads();
      updateStats();
      break;
    case 'delete-file':
      // Opens the confirm dialog with the "delete from disk" checkbox.
      showDeleteModal([id]);
      break;
    case 'open-file': {
      const dl = downloads.find(d => d.id === id);
      if (dl) window.aidm.openFile(dl.filepath);
      break;
    }
    case 'open-folder': {
      const dl = downloads.find(d => d.id === id);
      if (dl) window.aidm.openFolder(dl.savePath);
      break;
    }
    case 'open-log': {
      // Redacted yt-dlp log for a failed YouTube download.
      window.aidm.openDownloadLog(id).then((ok) => {
        if (ok === false) showNotification('The error log is no longer available.');
      });
      break;
    }
    case 'copy-url': {
      const dl = downloads.find(d => d.id === id);
      if (dl) navigator.clipboard.writeText(dl.url);
      break;
    }
    case 'copy-hash': {
      const dl = downloads.find(d => d.id === id);
      if (dl && dl.sha256) {
        navigator.clipboard.writeText(dl.sha256);
        showNotification('SHA-256 copied to clipboard');
      } else {
        showNotification('Hash not ready yet (or file incomplete)', 'warn');
      }
      break;
    }
  }
}

// ── Delete modal (IDM-style Remove vs Delete File) ────────────────────────────
// "Remove from list" just drops the row. "Delete file…" opens this dialog with
// a checkbox that also unlinks the file from disk (restricted to AiDM save
// paths by the main process).

let deleteTargetIds = [];

function showDeleteModal(ids) {
  deleteTargetIds = ids.filter(id => downloads.some(d => d.id === id));
  if (deleteTargetIds.length === 0) return;

  const names = deleteTargetIds.map(id => downloads.find(d => d.id === id)?.filename).filter(Boolean);
  const msg = document.getElementById('delete-msg');
  const checkbox = document.getElementById('delete-from-disk');

  if (deleteTargetIds.length === 1) {
    msg.textContent = `Delete "${names[0]}"?`;
  } else {
    msg.textContent = `Delete ${deleteTargetIds.length} selected downloads?`;
  }

  // Only completed/paused downloads have a file on disk worth offering to delete
  const hasFiles = deleteTargetIds.some(id => {
    const dl = downloads.find(d => d.id === id);
    return dl && (dl.status === 'completed' || dl.status === 'paused') && dl.filepath;
  });
  checkbox.checked = hasFiles;
  checkbox.disabled = !hasFiles;
  document.getElementById('delete-hint').textContent = hasFiles
    ? 'Uncheck to remove only from the AiDM list — files stay on disk.'
    : 'No completed file on disk — the list entry will be removed.';

  document.getElementById('delete-overlay').style.display = 'flex';
}

function hideDeleteModal() {
  document.getElementById('delete-overlay').style.display = 'none';
  deleteTargetIds = [];
}

/** True when any modal overlay is visible (so Delete key doesn't fight with inputs). */
function isAnyModalOpen() {
  return ['modal-overlay', 'quality-overlay', 'settings-overlay', 'scheduler-overlay', 'ai-overlay', 'delete-overlay']
    .some(id => {
      const el = document.getElementById(id);
      return el && el.style.display !== 'none' && el.style.display !== '';
    });
}

async function confirmDeleteModal() {
  const fromDisk = document.getElementById('delete-from-disk').checked;
  const ids = [...deleteTargetIds];
  hideDeleteModal();

  let deletedFiles = 0;
  for (const id of ids) {
    const dl = downloads.find(d => d.id === id);
    if (!dl) continue;
    if (fromDisk && dl.filepath) {
      try {
        const ok = await window.aidm.deleteFileFromDisk(dl.filepath);
        if (ok) deletedFiles++;
      } catch (e) { /* keep going */ }
    }
    try { await window.aidm.removeDownload(id); } catch (e) {}
  }

  downloads = downloads.filter(d => !ids.includes(d.id));
  ids.forEach(id => selectedIds.delete(id));
  renderDownloads();
  updateStats();

  if (fromDisk && deletedFiles > 0) {
    showNotification(`Removed ${ids.length} item(s), deleted ${deletedFiles} file(s) from disk`);
  } else {
    showNotification(`Removed ${ids.length} item(s) from list`);
  }
}

// ── Context Menu ──────────────────────────────────────────────────────────────

function showContextMenu(x, y, dl) {
  const menu = document.getElementById('context-menu');
  menu.style.display = 'block';
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 280)}px`;
  menu.querySelectorAll('.ctx-item').forEach(item => {
    const a = item.dataset.action;
    item.style.display = '';
    if (a === 'pause' && dl.status !== 'downloading') item.style.display = 'none';
    if (a === 'resume' && dl.status !== 'paused' && dl.status !== 'error') item.style.display = 'none';
    if (a === 'open-file' && dl.status !== 'completed') item.style.display = 'none';
    if (a === 'open-folder' && dl.status !== 'completed') item.style.display = 'none';
    if (a === 'copy-hash' && !dl.sha256) item.style.display = 'none';
    // "Delete file…" only makes sense when there is a file on disk
    if (a === 'delete-file' && dl.status !== 'completed' && dl.status !== 'paused') item.style.display = 'none';
  });
}
function hideContextMenu() { document.getElementById('context-menu').style.display = 'none'; }

// ── Marquee (rubber-band) selection ───────────────────────────────────────────
// Press left button on empty space (or a row) and drag: a blue rectangle
// follows the pointer and every row it touches becomes selected — like the
// Photoshop marquee tool. Plain clicks keep their normal behavior.
// Hold Ctrl to ADD to the existing selection instead of replacing it.

function setupMarquee() {
  const container = document.querySelector('.download-table-container');
  if (!container) return;

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left button only
    if (e.target.closest('.action-btn') || e.target.closest('.col-resizer') || e.target.type === 'checkbox' || e.target.closest('a')) return;

    const startX = e.clientX, startY = e.clientY;
    const addMode = e.ctrlKey || e.metaKey;
    let rectEl = null, active = false, rect = null;

    const onMove = (ev) => {
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      if (!active) {
        active = true;
        rectEl = document.createElement('div');
        rectEl.className = 'marquee-rect';
        container.appendChild(rectEl);
      }
      // Rectangle in client coords (for hit-testing rows)…
      const cx1 = Math.min(startX, ev.clientX), cy1 = Math.min(startY, ev.clientY);
      const cx2 = Math.max(startX, ev.clientX), cy2 = Math.max(startY, ev.clientY);
      rect = { left: cx1, top: cy1, right: cx2, bottom: cy2 };
      // …but positioned in container coords (accounts for scrolling)
      const c = container.getBoundingClientRect();
      rectEl.style.left = (cx1 - c.left + container.scrollLeft) + 'px';
      rectEl.style.top = (cy1 - c.top + container.scrollTop) + 'px';
      rectEl.style.width = (cx2 - cx1) + 'px';
      rectEl.style.height = (cy2 - cy1) + 'px';
      // Auto-scroll when dragging near the top/bottom edge
      const edge = 28, speed = 14;
      if (ev.clientY > c.bottom - edge) container.scrollTop += speed;
      else if (ev.clientY < c.top + edge) container.scrollTop -= speed;
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (active && rect) {
        marqueeEndTime = Date.now();
        applyMarqueeSelection(rect, addMode);
        if (rectEl) rectEl.remove();
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function applyMarqueeSelection(rect, addMode) {
  if (!addMode) selectedIds.clear();
  downloadList.querySelectorAll('tr[data-id]').forEach(tr => {
    const r = tr.getBoundingClientRect();
    if (r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top) {
      selectedIds.add(tr.dataset.id);
    }
  });
  renderDownloads();
}

// ── Resizable table columns ───────────────────────────────────────────────────
// Drag a header's right-edge handle to expand/shrink the column.
// Widths persist in localStorage; double-click a handle to reset it.

const COL_MIN_WIDTH = { name: 140, size: 70, dims: 70, progress: 110, speed: 70, status: 80, actions: 80 };

function loadColWidths() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('aidm-col-widths') || '{}'); } catch (e) {}
  document.querySelectorAll('#download-table th[data-col]').forEach(th => {
    const w = saved[th.dataset.col];
    if (w && w >= (COL_MIN_WIDTH[th.dataset.col] || 60)) th.style.width = w + 'px';
  });
}

function saveColWidths() {
  const out = {};
  document.querySelectorAll('#download-table th[data-col]').forEach(th => {
    out[th.dataset.col] = Math.round(th.getBoundingClientRect().width);
  });
  try { localStorage.setItem('aidm-col-widths', JSON.stringify(out)); } catch (e) {}
}

function setupColResize() {
  document.querySelectorAll('#download-table .col-resizer').forEach(handle => {
    const th = handle.parentElement;
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = th.offsetWidth;
      const minW = COL_MIN_WIDTH[th.dataset.col] || 60;
      handle.classList.add('dragging');
      const onMove = (ev) => {
        th.style.width = Math.max(minW, startW + ev.clientX - startX) + 'px';
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        handle.classList.remove('dragging');
        saveColWidths();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    // Double-click resets the column to its default width
    handle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      th.style.width = '';
      saveColWidths();
    });
  });
}

// ── Sidebar collapse (v4.3.4) ───────────────────────────────────────────────

function toggleSidebar() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  const btn = document.getElementById('btn-sidebar-collapse');
  if (btn) {
    btn.textContent = collapsed ? '▶' : '◀';
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }
}

// ── IPC Listeners ─────────────────────────────────────────────────────────────

function setupIPCListeners() {
  window.aidm.onDownloadAdded((data) => {
    if (!downloads.find(d => d.id === data.id)) downloads.push(data);
    renderDownloads();
    updateStats();
  });

  window.aidm.onDownloadProgress((data) => {
    const dl = downloads.find(d => d.id === data.id);
    if (dl) {
      dl.downloaded = data.downloaded; dl.totalSize = data.totalSize;
      dl.speed = data.speed; dl.percent = data.percent;
      // `segments` is the count; the live per-segment array is `segmentDetails`
      if (Array.isArray(data.segments)) dl.segmentDetails = data.segments;
      dl.status = 'downloading';
      if (typeof data.eta === 'number' || data.eta === null) dl.eta = data.eta;
    }
    scheduleProgressRender();
  });

  window.aidm.onDownloadComplete((data) => {
    const dl = downloads.find(d => d.id === data.id);
    if (dl) {
      dl.status = 'completed';
      dl.completedAt = Date.now();
      // Zero the speed and snap downloaded to the real total — otherwise the
      // last progress tick's rate stayed baked into the row forever and the
      // aggregate "network speed" figure never returned to zero.
      dl.speed = 0;
      if (typeof data.totalSize === 'number' && data.totalSize > 0) {
        dl.totalSize = data.totalSize;
        dl.downloaded = data.totalSize;
        dl.percent = 100;
      } else if (dl.totalSize > 0) {
        dl.downloaded = dl.totalSize;
        dl.percent = 100;
      }
      if (data.filepath) dl.filepath = data.filepath;
      if (Array.isArray(data.segments)) dl.segmentDetails = data.segments;
    }
    renderDownloads();
    updateStats();
    showNotification(`Download complete: ${dl?.filename || 'File'}`);
  });

  window.aidm.onDownloadError((data) => {
    const dl = downloads.find(d => d.id === data.id);
    if (dl) { dl.status = 'error'; dl.error = data.error; dl.speed = 0; }
    renderDownloads();
    updateStats();
    showNotification(`Download failed: ${data.error || 'unknown error'}`, 'error');
  });

  window.aidm.onDownloadPaused((data) => {
    const dl = downloads.find(d => d.id === data.id);
    if (dl) { dl.status = 'paused'; dl.speed = 0; }
    renderDownloads();
    updateStats();
  });

  window.aidm.onDownloadResumed((data) => {
    const dl = downloads.find(d => d.id === data.id);
    if (dl) dl.status = 'downloading';
    renderDownloads();
    updateStats();
  });

  window.aidm.onDownloadRemoved((data) => {
    downloads = downloads.filter(d => d.id !== data.id);
    renderDownloads();
    updateStats();
  });

  // File name/path refined (e.g. learned from the server before download):
  // refresh the matching row so the title and any pending badge stay right.
  window.aidm.onDownloadUpdated((data) => {
    const dl = downloads.find(d => d.id === data.id);
    if (dl) {
      dl.filename = data.filename || dl.filename;
      dl.category = data.category || dl.category;
      dl.savePath = data.savePath || dl.savePath;
      dl.filepath = data.filepath || dl.filepath;
      // Size resolved during the pre-download probe (direct Content-Length or
      // HLS playlist total) so the row stops showing "Unknown".
      if (typeof data.totalSize === 'number' && data.totalSize > 0) dl.totalSize = data.totalSize;
      if (typeof data.sizeEstimated === 'boolean') dl.sizeEstimated = data.sizeEstimated;
      // The post-download probe lands asynchronously: merge the proven
      // geometry and the missing-audio flag so the row repaints with the truth
      // (quality.label/resolution are rewritten by the probe too).
      if (data.media !== undefined) dl.media = data.media;
      if (typeof data.audioMissing === 'boolean') dl.audioMissing = data.audioMissing;
      if (data.quality && typeof data.quality === 'object') dl.quality = { ...(dl.quality || {}), ...data.quality };
    }
    renderDownloads();
    updateStats();
  });

  window.aidm.onClipboardLink((url) => {
    document.getElementById('input-url').value = url;
    showAddModal();
  });

  // ── New: Ask-every-time approval ──────────────────────────────────────────
  window.aidm.onDownloadAskLocation(async (data) => {
    // The topmost location dialog is opened by the main process. The list only
    // needs to catch up so the row shows "Pending" while it is being answered.
    try {
      downloads = await window.aidm.getDownloads();
      renderDownloads();
      updateStats();
    } catch (e) { /* no-op */ }
  });

  // ── New: Video quality detected ──────────────────────────────────────────
  window.aidm.onVideoDetected((data) => {
    showQualityPicker(data);
  });

  // ── New: scheduler events (v4.3.0) ───────────────────────────────────────
  if (window.aidm.onSchedulerEvent) {
    window.aidm.onSchedulerEvent((data) => {
      if (data && data.message) showNotification(data.message);
      try {
        if (document.getElementById('scheduler-overlay').style.display !== 'none') {
          loadSchedules();
        }
      } catch (e) { /* modal closed — nothing to refresh */ }
    });
  }

  // SHA-256 arrives asynchronously after completion — refresh the row so the
  // hash is available via the context menu / file title tooltip.
  if (window.aidm.onDownloadHash) {
    window.aidm.onDownloadHash((data) => {
      const dl = downloads.find(d => d.id === data.id);
      if (dl) {
        dl.sha256 = data.sha256;
        renderDownloads();
      }
    });
  }
}

// ── Event Listeners ───────────────────────────────────────────────────────────

function setupEventListeners() {
  // Window controls
  document.getElementById('btn-minimize').addEventListener('click', () => window.aidm.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.aidm.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.aidm.close());

  // Toolbar
  document.getElementById('btn-add-url').addEventListener('click', showAddModal);
  document.getElementById('btn-pause-all').addEventListener('click', pauseAll);
  document.getElementById('btn-resume-all').addEventListener('click', resumeAll);
  document.getElementById('btn-delete').addEventListener('click', removeSelectedFromList);
  document.getElementById('btn-delete-all').addEventListener('click', deleteSelectedOrAll);
  document.getElementById('btn-refresh').addEventListener('click', refreshList);
  document.getElementById('btn-settings').addEventListener('click', showSettingsModal);
  document.getElementById('btn-scheduler').addEventListener('click', showSchedulerModal);
  document.getElementById('btn-sidebar-collapse').addEventListener('click', toggleSidebar);
  document.getElementById('btn-ai-assistant').addEventListener('click', showAiModal);

  // Sidebar
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      activeCategory = item.dataset.category;
      renderDownloads();
    });
  });

  searchInput.addEventListener('input', () => renderDownloads());

  document.getElementById('select-all').addEventListener('change', (e) => {
    e.target.checked ? downloads.forEach(d => selectedIds.add(d.id)) : selectedIds.clear();
    renderDownloads();
  });

  // Context menu
  document.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', () => {
      if (contextTarget) handleAction(item.dataset.action, contextTarget);
      hideContextMenu();
    });
  });
  document.addEventListener('click', hideContextMenu);

  // Photoshop-style marquee selection on the download list
  setupMarquee();

  // Resizable columns (widths restored from previous session)
  loadColWidths();
  setupColResize();

  // Add URL modal
  document.getElementById('modal-close').addEventListener('click', hideAddModal);
  document.getElementById('btn-cancel-add').addEventListener('click', hideAddModal);
  document.getElementById('btn-start-download').addEventListener('click', startNewDownload);
  document.getElementById('btn-ai-filename').addEventListener('click', suggestAiFilename);
  document.getElementById('btn-browse').addEventListener('click', async () => {
    const f = await window.aidm.selectFolder();
    if (f) document.getElementById('input-savepath').value = f;
  });

  // Quality picker modal
  document.getElementById('quality-close').addEventListener('click', hideQualityPicker);
  document.getElementById('btn-cancel-quality').addEventListener('click', hideQualityPicker);
  document.getElementById('btn-download-quality').addEventListener('click', downloadSelectedQuality);

  // Settings modal
  document.getElementById('settings-close').addEventListener('click', hideSettingsModal);
  document.getElementById('btn-cancel-settings').addEventListener('click', hideSettingsModal);
  document.getElementById('scheduler-close').addEventListener('click', hideSchedulerModal);
  document.getElementById('btn-sched-cancel').addEventListener('click', hideSchedulerModal);
  document.getElementById('btn-sched-save').addEventListener('click', saveSchedulerForm);
  document.getElementById('btn-sched-clear').addEventListener('click', clearSchedulerForm);
  document.getElementById('sched-type').addEventListener('change', updateSchedulerFormVisibility);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-ai-test').addEventListener('click', testAiConnection);
  document.getElementById('btn-browse-settings').addEventListener('click', async () => {
    const f = await window.aidm.selectFolder();
    if (f) document.getElementById('setting-savepath').value = f;
  });

  // Category path browse buttons
  document.querySelectorAll('.btn-browse-cat').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cat = btn.dataset.cat;
      const f = await window.aidm.selectFolder();
      if (f) document.getElementById(`cat-path-${cat}`).value = f;
    });
  });

  // AI Assistant modal
  document.getElementById('ai-close').addEventListener('click', hideAiModal);
  document.getElementById('btn-ai-close2').addEventListener('click', hideAiModal);
  document.getElementById('btn-ai-send').addEventListener('click', sendAiMessage);
  document.getElementById('ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendAiMessage();
  });

  // Delete modal (IDM-style Remove / Delete File)
  document.getElementById('delete-close').addEventListener('click', hideDeleteModal);
  document.getElementById('btn-cancel-delete').addEventListener('click', hideDeleteModal);
  document.getElementById('btn-confirm-delete').addEventListener('click', confirmDeleteModal);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); showAddModal(); }
    if (e.key === 'F5') { e.preventDefault(); refreshList(); }
    if (e.key === 'Escape') { hideAddModal(); hideSettingsModal(); hideQualityPicker(); hideContextMenu(); hideAiModal(); hideDeleteModal(); }
    // Delete key opens the delete dialog (with disk checkbox) for the selection
    if (e.key === 'Delete' && selectedIds.size > 0 && !isAnyModalOpen()) {
      showDeleteModal([...selectedIds]);
    }
  });

  // ── Drag-and-drop URLs onto the window ─────────────────────────────────────
  // Drop a URL (or a .url/.txt file containing one) anywhere on the app to
  // open the Add Download modal pre-filled. Prevents the browser default
  // "open file" behaviour.
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    // 1) Plain-text URL dropped directly
    const text = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim();
    if (text && /^https?:\/\//i.test(text)) {
      document.getElementById('input-url').value = text.split('\n')[0].trim();
      showAddModal();
      return;
    }
    // 2) A dropped file — try to read its first line as a URL
    const file = dt.files && dt.files[0];
    if (file && /\.(txt|url|desktop)$/i.test(file.name)) {
      try {
        const content = await file.text();
        const line = content.split(/\r?\n/).find(l => /^https?:\/\//i.test(l.trim()));
        if (line) {
          document.getElementById('input-url').value = line.trim();
          showAddModal();
          return;
        }
      } catch (err) { /* ignore unreadable files */ }
    }
    showNotification('Drop a URL (text) or a .txt/.url file containing one', 'warn');
  });
}

// ── Add Download Modal ────────────────────────────────────────────────────────

function showAddModal() { document.getElementById('modal-overlay').style.display = 'flex'; document.getElementById('input-url').focus(); }
function hideAddModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('input-url').value = '';
  document.getElementById('input-filename').value = '';
  document.getElementById('input-savepath').value = '';
  document.getElementById('input-category').value = 'auto';
}

async function startNewDownload() {
  const url = document.getElementById('input-url').value.trim();
  if (!url) return;

  const filename = document.getElementById('input-filename').value.trim() || undefined;
  const savePath = document.getElementById('input-savepath').value.trim() || undefined;
  const segments = parseInt(document.getElementById('input-segments').value) || 8;
  const category = document.getElementById('input-category').value;

  // Pass explicit category so the manager can override auto-detect when the
  // user picked one (it only affects save-path routing, not detection).
  const opts = { url, filename, savePath, segments };
  if (category && category !== 'auto') opts.category = category;

  const result = await window.aidm.addDownload(opts);
  // A page URL whose resolver failed (embed changed, page unreachable…)
  // reports back instead of saving the page HTML as a file: keep the dialog
  // open and show the reason so the user can retry or pick another quality.
  if (result && result.resolveFailed) {
    showNotification(`Could not resolve video: ${result.error || 'unknown error'}`, 'error');
    return;
  }
  hideAddModal();
}

// ── Quality Picker Modal ──────────────────────────────────────────────────────

let qualityVideos = [];
let qualitySelectedIdx = -1;
let qualityContext = null; // { pageUrl, pageTitle, cookies } from video-detected

function showQualityPicker(data) {
  qualityVideos = data.videos || [];
  qualitySelectedIdx = -1;
  qualityContext = {
    pageUrl: data.pageUrl || data.url || '',
    pageTitle: data.pageTitle || '',
    cookies: data.cookies || null,
  };

  if (qualityVideos.length === 0) return;

  document.getElementById('quality-page-title').textContent = data.pageTitle || 'Video detected';
  document.getElementById('quality-page-url').textContent = data.pageUrl || '';

  const list = document.getElementById('quality-list');
  list.innerHTML = '';

  // Sort by REAL height when the resolver measured the variant, otherwise by
  // quality tier (highest first). A lying "2160p" label can no longer outrank
  // a variant that is actually taller.
  qualityVideos.sort((a, b) => qualityVideoCompare(a, b, QUALITY_TIER_ORDER));

  // Token-normalized dedup: one file, one row — rotated CDN signatures and
  // repeated segment-style URLs previously stacked as false "qualities".
  const _seenQ = new Set();
  qualityVideos = qualityVideos.filter(v => {
    if (!v || !v.url) return false;
    if (/\.m4s($|\?|#|;)/i.test(v.url)) return false;
    if (/\.ts($|\?|#|;)/i.test(v.url) && /seg|chunk|frag|part|range|hls|dash|playlist|media|sq_|index|seq/i.test(v.url)) return false;
    if (/seg-?\d+|chunklist|fragment|frag-?\d+|\/range\//i.test(v.url)) return false;
    let n = null;
    try {
      const x = new URL(String(v.url));
      x.hash = '';
      n = x.toString();
    } catch (e) { n = v.url; }
    if (_seenQ.has(n)) return false;
    _seenQ.add(n);
    return true;
  });

  qualityVideos.forEach((video, i) => {
    const opt = document.createElement('div');
    opt.className = 'quality-option';
    opt.dataset.idx = i;

    const qualityIcon = video.quality === '2160p' ? '🎬' :
                        video.quality === '1080p' ? '📺' :
                        video.quality === '720p' ? '🖥️' :
                        video.quality === '480p' ? '📱' : '📼';

    const sizeText = video.size ? formatBytes(video.size) : '';
    const formatText = video.format ? video.format.toUpperCase() : '';
    // Proven geometry (width/height) reads solid; anything the site merely
    // claims is dimmed and tagged, and a label-only variant shows just "720p"
    // instead of a fabricated "1280x720".
    const resInfo = pickerResolutionInfo(video);
    // Real filename next to resolution/size — without it every quality row
    // looks identical and users download the wrong video. Hostname-derived
    // ("mydaddy.cc [1080p].mp4") and rendition-only ("1080.mp4") names are
    // rejected; per-video titles win over the page title. (Pure logic mirrors
    // aidm/src/titles.js — keep in sync.)
    const _looksHost = (s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(s || '').trim());
    const _isRealTitle = (t) => {
      const s = String(t == null ? '' : t).trim().replace(/\s+/g, ' ');
      if (!s || s.length < 2 || _looksHost(s)) return false;
      if (/^(video|watch|play|player|home|index|untitled|download|downloads|media|clip|embed|empty|blank|no\s*title)$/i.test(s)) return false;
      // A bare domain with an affix ("mydaddy.cc - Home") is still not a title.
      const core = s
        .replace(/\s*[-|–—:|]\s*[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*$/i, '')
        .replace(/^[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*[-|–—:|]\s*/i, '')
        .trim();
      if (!core || _looksHost(core)) return false;
      if (/^(video|watch|play|player|home|index|untitled|download|downloads|media|clip|embed|empty|blank|no\s*title)$/i.test(core)) return false;
      return true;
    };
    const _isGeneric = (name, url) => {
      const s = String(name || '').trim();
      if (!s) return true;
      let host = '';
      try { host = new URL(String(url || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) {}
      const stem = s.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      if (!stem) return true;
      const low = stem.toLowerCase();
      if (host && (low === host || low === host.replace(/^www\./, ''))) return true;
      if (_looksHost(stem) || /^\d{3,4}p?$/i.test(stem) || /^download_\d+$/.test(stem)) return true;
      if (/^(videoplayback|watch|video|play|index|download|media|get_file|dwnl|file|stream|content|player|embed)$/i.test(stem)) return true;
      if (stem.length >= 12 && /^[0-9a-f]+$/i.test(stem)) return true;
      return false;
    };
    const _realTitle = (() => {
      const cand = (video.title && _isRealTitle(video.title)) ? video.title
        : ((qualityContext?.pageTitle && _isRealTitle(qualityContext.pageTitle)) ? qualityContext.pageTitle
        : ((data.pageTitle && _isRealTitle(data.pageTitle)) ? data.pageTitle : null));
      return cand ? String(cand).trim().replace(/\s+/g, ' ').slice(0, 80) : null;
    })();
    const fileName = (!_isGeneric(video.filename, video.url) && video.filename) ||
      (() => {
        try {
          const base = decodeURIComponent(new URL(video.url).pathname.split('/').filter(Boolean).pop() || '');
          if (base && /\.[A-Za-z0-9]{2,4}$/.test(base) && !_isGeneric(base, video.url)) return base;
        } catch (e) {}
        return null;
      })() ||
      `${_realTitle || 'video'} [${video.quality || 'auto'}].${(video.format || 'mp4').toLowerCase()}`;

    opt.innerHTML = `
      <div class="quality-icon">${qualityIcon}</div>
      <div class="quality-info">
        <div class="quality-label">${video.quality?.toUpperCase() || 'Unknown'}</div>
        <div class="quality-filename" title="${escapeHtml(video.url)}">📄 ${escapeHtml(fileName)}</div>
        <div class="quality-resolution ${resInfo.proven ? 'proven' : 'guessed'}" title="${escapeAttr(resInfo.proven ? 'Measured from the file' : 'Claimed by the site — not measured')}">${escapeHtml(resInfo.text)}${resInfo.proven ? '' : ' <span class="quality-res-flag">unverified</span>'}</div>
        <div class="quality-meta">
          ${sizeText ? `<span class="quality-size">📦 ${sizeText}</span>` : ''}
          ${formatText ? `<span class="quality-format">🎞️ ${formatText}</span>` : ''}
        </div>
      </div>
      <div class="quality-radio"></div>
    `;

    opt.addEventListener('click', () => {
      list.querySelectorAll('.quality-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      qualitySelectedIdx = i;
      document.getElementById('btn-download-quality').disabled = false;
    });

    list.appendChild(opt);
  });

  // Auto-select highest quality
  if (qualityVideos.length > 0) {
    list.querySelector('.quality-option')?.click();
  }

  document.getElementById('quality-overlay').style.display = 'flex';
}

function hideQualityPicker() {
  document.getElementById('quality-overlay').style.display = 'none';
  qualityVideos = [];
  qualitySelectedIdx = -1;
}

async function downloadSelectedQuality() {
  if (qualitySelectedIdx < 0 || qualitySelectedIdx >= qualityVideos.length) return;
  const video = qualityVideos[qualitySelectedIdx];

  // KVS /get_file/ and many CDNs reject requests without a matching Referer
  // and session cookies. The extension attached both to the video-detected
  // payload — replay them here so the quality-picker path works like the
  // capsule "Download" button.
  const headers = {};
  const pageUrl = qualityContext?.pageUrl || video.pageUrl || '';
  if (pageUrl) headers.Referer = pageUrl;
  headers['User-Agent'] = navigator.userAgent;

  await window.aidm.addDownload({
    url: video.url,
    // Twitter's own filenames are opaque hashes; the resolver suggests a
    // readable one (twitter_<author>_<id>_<720p>.mp4) when it has one.
    filename: video.filename || undefined,
    quality: {
      label: video.quality?.toUpperCase() || 'Unknown',
      resolution: video.resolution,
      size: video.size,
      format: video.format,
    },
    meta: { ...video, pageUrl, pageTitle: qualityContext?.pageTitle || '' },
    headers,
    cookies: qualityContext?.cookies || null,
  });

  hideQualityPicker();
  showNotification('Video download started');
}

// ── Download-location dialog (Ask Every Time) ─────────────────────────────────
//
// The prompt is a dedicated, topmost window owned by the main process (see
// main.js → showLocationDialog). It is NOT an in-page overlay any more, so it
// can be raised above other applications while AiDM itself stays a normal
// window. The renderer only asks the main process to open it.

function showApprovalModal(dl) {
  if (!dl || !dl.id) return;
  try { window.aidm.requestLocation(dl.id); } catch (e) { /* no-op */ }
}

// ── Settings Modal ────────────────────────────────────────────────────────────

async function showSettingsModal() {
  settings = await window.aidm.getSettings();
  document.getElementById('setting-concurrent').value = settings.maxConcurrentDownloads;
  document.getElementById('setting-segments').value = settings.defaultSegments;
  document.getElementById('setting-savepath').value = settings.defaultSavePath;
  document.getElementById('setting-speed-limit').value = Math.round((settings.speedLimit || 0) / 1024);
  document.getElementById('setting-speed-rules').value = settings.speedRules || '';
  document.getElementById('setting-intercept-all').checked = settings.interceptAll !== false;
  document.getElementById('setting-intercept-types').value = (settings.interceptFileTypes || []).join(', ');
  document.getElementById('setting-excluded-sites').value = (settings.excludedSites || []).join(', ');
  document.getElementById('setting-force-key').value = settings.forceTakeoverKey || 'Shift';
  document.getElementById('setting-clipboard').checked = settings.clipboardMonitor;
  document.getElementById('setting-browser').checked = settings.browserIntegration;
  document.getElementById('setting-notifications').checked = settings.notifications;
  document.getElementById('setting-ask-location').checked = settings.askLocationEveryTime || false;
  document.getElementById('setting-launch-startup').checked = settings.launchAtStartup !== false;
  document.getElementById('setting-minimize-tray').checked = settings.minimizeToTray !== false;
  document.getElementById('setting-autoresume').checked = settings.autoResume !== false;
  // AI (TokenHarbor) — never display existing key back in full; show placeholder only
  document.getElementById('setting-ai-enabled').checked = settings.aiEnabled !== false;
  document.getElementById('setting-ai-baseurl').value = settings.aiBaseURL || 'https://tokenharbor.ai/v1';
  document.getElementById('setting-ai-key').value = '';
  document.getElementById('setting-ai-key').placeholder = settings.aiApiKey ? '•••••• (saved — leave empty to keep)' : 'thk_live_… or set TOKENHARBOR_API_KEY env var';
  document.getElementById('setting-ai-primary').value = settings.aiPrimaryModel || 'mimo-v2.5:free';
  document.getElementById('setting-ai-fallback').value = settings.aiFallbackModel || 'deepseek-v4-flash:free';
  document.getElementById('ai-status-hint').textContent = 'Key is stored locally only. Env var takes precedence when set.';

  // File hosts (v4.5.0) — never echo a saved password back; placeholder only.
  const rg = settings.fileHosts?.rapidgator || {};
  document.getElementById('setting-rg-user').value = rg.user || '';
  document.getElementById('setting-rg-pass').value = '';
  document.getElementById('setting-rg-pass').placeholder = rg.password ? '•••••• (saved — leave empty to keep)' : 'stored only in the local settings file';
  document.getElementById('setting-rg-cookie').value = '';
  document.getElementById('setting-rg-cookie').placeholder = rg.cookie ? '•••••• (saved — leave empty to keep)' : 'PHPSESSID=… ; user__=…';
  document.getElementById('rg-status-hint').textContent = (rg.user || rg.cookie)
    ? 'Saved — Rapidgator links will use this account.'
    : 'Leave both empty to use the free flow (wait required).';

  // YouTube signed-in access (v4.5.0) — opt-in browser cookie store.
  const ytBrowserSelect = document.getElementById('setting-yt-cookies-browser');
  if (ytBrowserSelect) ytBrowserSelect.value = String(settings.youtubeCookiesFromBrowser || '');

  // Category paths
  const cats = ['video', 'audio', 'document', 'archive', 'software', 'image'];
  cats.forEach(cat => {
    const el = document.getElementById(`cat-path-${cat}`);
    if (el) el.value = settings.categoryPaths?.[cat] || '';
  });

  document.getElementById('settings-overlay').style.display = 'flex';
}

function hideSettingsModal() { document.getElementById('settings-overlay').style.display = 'none'; }

async function saveSettings() {
  const cats = ['video', 'audio', 'document', 'archive', 'software', 'image'];
  const categoryPaths = {};
  cats.forEach(cat => {
    const el = document.getElementById(`cat-path-${cat}`);
    if (el) categoryPaths[cat] = el.value.trim();
  });

  const aiKeyInput = document.getElementById('setting-ai-key').value.trim();
  const splitList = (id) => document.getElementById(id).value.split(/[,;\s]+/)
    .map(t => t.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(t => t.length > 0);
  settings = {
    maxConcurrentDownloads: parseInt(document.getElementById('setting-concurrent').value) || 3,
    defaultSegments: parseInt(document.getElementById('setting-segments').value) || 8,
    defaultSavePath: document.getElementById('setting-savepath').value,
    speedLimit: (parseInt(document.getElementById('setting-speed-limit').value, 10) || 0) * 1024,
    speedRules: document.getElementById('setting-speed-rules').value,
    interceptAll: document.getElementById('setting-intercept-all').checked,
    interceptFileTypes: splitList('setting-intercept-types'),
    excludedSites: splitList('setting-excluded-sites'),
    forceTakeoverKey: document.getElementById('setting-force-key').value.trim().slice(0, 12) || 'Shift',
    clipboardMonitor: document.getElementById('setting-clipboard').checked,
    browserIntegration: document.getElementById('setting-browser').checked,
    notifications: document.getElementById('setting-notifications').checked,
    askLocationEveryTime: document.getElementById('setting-ask-location').checked,
    launchAtStartup: document.getElementById('setting-launch-startup').checked,
    minimizeToTray: document.getElementById('setting-minimize-tray').checked,
    autoResume: document.getElementById('setting-autoresume').checked,
    categoryPaths,
    // File hosts (v4.5.0): only overwrite a stored secret when the user typed
    // a new one, so opening Settings and saving never wipes the account.
    fileHosts: {
      rapidgator: {
        user: document.getElementById('setting-rg-user').value.trim(),
        ...(document.getElementById('setting-rg-pass').value ? { password: document.getElementById('setting-rg-pass').value } : {}),
        ...(document.getElementById('setting-rg-cookie').value.trim() ? { cookie: document.getElementById('setting-rg-cookie').value.trim() } : {}),
      },
    },
    youtubeCookiesFromBrowser: (document.getElementById('setting-yt-cookies-browser')?.value || '').trim(),
    aiEnabled: document.getElementById('setting-ai-enabled').checked,
    aiBaseURL: document.getElementById('setting-ai-baseurl').value.trim() || 'https://tokenharbor.ai/v1',
    aiPrimaryModel: document.getElementById('setting-ai-primary').value,
    aiFallbackModel: document.getElementById('setting-ai-fallback').value,
    // Only overwrite stored key when user typed a new one
    ...(aiKeyInput ? { aiApiKey: aiKeyInput } : {}),
  };
  await window.aidm.saveSettings(settings);
  hideSettingsModal();
  showNotification('Settings saved');
}

// ── Download Scheduler (v4.3.0) ─────────────────────────────────────────────

let schedules = [];

async function showSchedulerModal() {
  await loadSchedules();
  clearSchedulerForm();
  document.getElementById('scheduler-overlay').style.display = 'flex';
}

function hideSchedulerModal() { document.getElementById('scheduler-overlay').style.display = 'none'; }

async function loadSchedules() {
  try { schedules = await window.aidm.getSchedules() || []; }
  catch (e) { schedules = []; }
  renderSchedulerList();
  refreshSchedulerNext();
}

async function refreshSchedulerNext() {
  const el = document.getElementById('scheduler-next');
  try {
    const runs = await window.aidm.schedulerNext() || [];
    if (!runs.length) { el.textContent = 'No upcoming runs.'; return; }
    const first = runs[0];
    el.textContent = `Next: ${first.name} — ${new Date(first.at).toLocaleString()}` +
      (runs.length > 1 ? ` (+${runs.length - 1} more)` : '');
  } catch (e) { el.textContent = 'No upcoming runs.'; }
}

function schedSummary(s) {
  const bits = [];
  if (s.type === 'once') bits.push(`Once ${s.date || ''} ${s.time || ''}`.trim());
  else if (s.type === 'daily') bits.push(`Daily at ${s.time || ''}`);
  else if (s.type === 'weekly') {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = (s.days || []).map(Number).filter(d => d >= 0 && d <= 6).sort((a, b) => a - b);
    bits.push(`Weekly ${days.length ? days.map(d => names[d]).join(', ') : '—'} at ${s.time || ''}`);
  }
  if (s.stopAfterMinutes) bits.push(`stops after ${s.stopAfterMinutes} min`);
  if (s.speedLimitKBs !== null && s.speedLimitKBs !== undefined && s.speedLimitKBs !== '') {
    bits.push(Number(s.speedLimitKBs) === 0 ? 'unlimited speed' : `${s.speedLimitKBs} KB/s`);
  }
  if (s.retryFailed) bits.push('retries failed');
  if (s.onComplete && s.onComplete !== 'none') bits.push(`then ${s.onComplete}`);
  if (s.enabled === false) bits.push('disabled');
  return bits.join(' · ');
}

function renderSchedulerList() {
  const list = document.getElementById('scheduler-list');
  list.innerHTML = '';
  if (!schedules.length) {
    list.innerHTML = '<div class="aidm-cap-empty">No schedules yet — add one below.</div>';
    return;
  }
  schedules.forEach((s) => {
    const opt = document.createElement('div');
    opt.className = 'quality-option' + (s.enabled === false ? '' : ' selected');
    opt.innerHTML = `
      <div class="quality-info sched-info">
        <div class="sched-name">${escapeHtml(s.name || 'Untitled schedule')}</div>
        <div class="sched-detail">${escapeHtml(schedSummary(s))}</div>
      </div>
      <div class="sched-actions">
        <button class="tool-btn small" data-act="toggle" title="${s.enabled === false ? 'Enable' : 'Disable'}">${s.enabled === false ? '▶' : '⏸'}</button>
        <button class="tool-btn small" data-act="edit" title="Edit">✏️</button>
        <button class="tool-btn small" data-act="del" title="Delete">🗑</button>
      </div>`;
    opt.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      s.enabled = s.enabled === false ? true : false;
      await persistSchedules();
    });
    opt.querySelector('[data-act="edit"]').addEventListener('click', () => fillSchedulerForm(s));
    opt.querySelector('[data-act="del"]').addEventListener('click', async () => {
      schedules = schedules.filter(x => x.id !== s.id);
      await persistSchedules();
    });
    list.appendChild(opt);
  });
}

async function persistSchedules() {
  try {
    schedules = await window.aidm.saveSchedules(schedules) || schedules;
    renderSchedulerList();
    refreshSchedulerNext();
    showNotification('Schedules saved');
  } catch (e) {
    showNotification(`Could not save schedules: ${(e && e.message) || e}`, 'error');
    await loadSchedules();
  }
}

function updateSchedulerFormVisibility() {
  const type = document.getElementById('sched-type').value;
  document.getElementById('sched-date-row').style.display = type === 'once' ? '' : 'none';
  document.getElementById('sched-days-row').style.display = type === 'weekly' ? '' : 'none';
}

function clearSchedulerForm() {
  document.getElementById('sched-id').value = '';
  document.getElementById('sched-name').value = '';
  document.getElementById('sched-type').value = 'daily';
  document.getElementById('sched-time').value = '02:00';
  document.getElementById('sched-date').value = '';
  document.querySelectorAll('#sched-days input[type="checkbox"]').forEach(c => { c.checked = true; });
  document.getElementById('sched-stop-after').value = '';
  document.getElementById('sched-speed').value = '';
  document.getElementById('sched-retry').checked = true;
  document.getElementById('sched-action').value = 'none';
  document.getElementById('sched-enabled').checked = true;
  document.getElementById('scheduler-form-title').textContent = 'New schedule';
  updateSchedulerFormVisibility();
}

function fillSchedulerForm(s) {
  document.getElementById('sched-id').value = s.id || '';
  document.getElementById('sched-name').value = s.name || '';
  document.getElementById('sched-type').value = s.type || 'daily';
  document.getElementById('sched-time').value = s.time || '02:00';
  document.getElementById('sched-date').value = s.date || '';
  const days = new Set((s.days || [0, 1, 2, 3, 4, 5, 6]).map(Number));
  document.querySelectorAll('#sched-days input[type="checkbox"]').forEach(c => {
    c.checked = days.has(Number(c.value));
  });
  document.getElementById('sched-stop-after').value = s.stopAfterMinutes != null ? s.stopAfterMinutes : '';
  document.getElementById('sched-speed').value = s.speedLimitKBs != null ? s.speedLimitKBs : '';
  document.getElementById('sched-retry').checked = !!s.retryFailed;
  document.getElementById('sched-action').value = s.onComplete || 'none';
  document.getElementById('sched-enabled').checked = s.enabled !== false;
  document.getElementById('scheduler-form-title').textContent = 'Edit schedule';
  updateSchedulerFormVisibility();
  document.getElementById('sched-name').focus();
}

async function saveSchedulerForm() {
  const days = Array.from(document.querySelectorAll('#sched-days input[type="checkbox"]:checked'))
    .map(c => Number(c.value));
  const entry = {
    id: document.getElementById('sched-id').value || undefined,
    name: document.getElementById('sched-name').value.trim(),
    enabled: document.getElementById('sched-enabled').checked,
    type: document.getElementById('sched-type').value,
    time: document.getElementById('sched-time').value,
    date: document.getElementById('sched-date').value || null,
    days,
    stopAfterMinutes: document.getElementById('sched-stop-after').value === ''
      ? null : Number(document.getElementById('sched-stop-after').value),
    retryFailed: document.getElementById('sched-retry').checked,
    speedLimitKBs: document.getElementById('sched-speed').value === ''
      ? null : Number(document.getElementById('sched-speed').value),
    onComplete: document.getElementById('sched-action').value,
  };
  if (entry.id) {
    const i = schedules.findIndex(x => x.id === entry.id);
    if (i >= 0) schedules[i] = entry; else schedules.push(entry);
  } else {
    schedules.push(entry);
  }
  await persistSchedules();
  clearSchedulerForm();
}

// ── AI Assistant (TokenHarbor) ────────────────────────────────────────────────

let aiHistory = [];

function showAiModal() {
  if (settings && settings.aiEnabled === false) {
    showNotification('AI features are disabled in Settings', 'warn');
    return;
  }
  document.getElementById('ai-overlay').style.display = 'flex';
  document.getElementById('ai-input').focus();
}
function hideAiModal() { document.getElementById('ai-overlay').style.display = 'none'; }

function appendAiMessage(role, text) {
  const box = document.getElementById('ai-history');
  const div = document.createElement('div');
  div.style.cssText = role === 'user'
    ? 'align-self:flex-end;background:#1c6fce;color:#fff;padding:8px 12px;border-radius:10px;max-width:85%;font-size:13px;'
    : 'align-self:flex-start;background:#ffffff;border:1px solid #a9c2e2;color:#1a2b4a;padding:8px 12px;border-radius:10px;max-width:85%;font-size:13px;white-space:pre-wrap;';
  div.textContent = (role === 'user' ? '🧑 ' : '✨ ') + text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendAiMessage() {
  const input = document.getElementById('ai-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendAiMessage('user', text);
  aiHistory.push({ role: 'user', content: text });
  // Keep context window small
  if (aiHistory.length > 20) aiHistory = aiHistory.slice(-20);
  appendAiMessage('assistant', '…thinking…');
  try {
    const context = [
      { role: 'system', content: 'You are the AiDM download-manager assistant. Help with downloads, filenames, categories, and error troubleshooting. Be concise.' },
      ...aiHistory,
    ];
    const res = await window.aidm.aiChat(context, { max_tokens: 600, temperature: 0.4 });
    // replace "thinking" bubble
    const box = document.getElementById('ai-history');
    box.lastChild.remove();
    appendAiMessage('assistant', res.content || '(empty response)');
    aiHistory.push({ role: 'assistant', content: res.content || '' });
    if (res.fallbackUsed) showNotification(`AI fallback used (${res.model})`);
  } catch (err) {
    const box = document.getElementById('ai-history');
    box.lastChild.remove();
    appendAiMessage('assistant', `⚠️ AI error: ${err.message || err}`);
  }
}

async function suggestAiFilename() {
  const url = document.getElementById('input-url').value.trim();
  if (!url) { showNotification('Paste a URL first'); return; }
  const btn = document.getElementById('btn-ai-filename');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const { filename } = await window.aidm.aiSmartFilename(url);
    if (filename) document.getElementById('input-filename').value = filename;
    else showNotification('AI could not suggest a filename');
  } catch (err) {
    showNotification(`AI filename failed: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨';
  }
}

async function testAiConnection() {
  const hint = document.getElementById('ai-status-hint');
  hint.textContent = 'Testing…';
  try {
    // Save current form values first so test uses them (without persisting key display)
    const aiKeyInput = document.getElementById('setting-ai-key').value.trim();
    const draft = {
      ...settings,
      aiBaseURL: document.getElementById('setting-ai-baseurl').value.trim() || 'https://tokenharbor.ai/v1',
      aiPrimaryModel: document.getElementById('setting-ai-primary').value,
      aiFallbackModel: document.getElementById('setting-ai-fallback').value,
      ...(aiKeyInput ? { aiApiKey: aiKeyInput } : {}),
    };
    await window.aidm.saveSettings(draft);
    settings = draft;
    const r = await window.aidm.aiHealth();
    hint.textContent = r.ok ? `✅ Connected (${r.model}, ${r.latencyMs}ms${r.fallbackUsed ? ', via fallback' : ''})` : '⚠️ Unexpected reply';
  } catch (err) {
    hint.textContent = `❌ ${err.message || err}`;
  }
}

// ── Batch Actions ─────────────────────────────────────────────────────────────

async function pauseAll() {
  for (const dl of downloads) if (dl.status === 'downloading') await window.aidm.pauseDownload(dl.id);
}
async function resumeAll() {
  for (const dl of downloads) if (dl.status === 'paused' || dl.status === 'error') await window.aidm.resumeDownload(dl.id);
}

// ── Delete / Refresh ──────────────────────────────────────────────────────────
// "Remove" = list only (IDM). "Delete" = confirm dialog with disk checkbox.

/** List-only removal of the current selection (IDM "Remove from list"). */
async function removeSelectedFromList() {
  if (selectedIds.size === 0) {
    showNotification('Nothing selected — click a row or tick its checkbox first');
    return;
  }
  const ids = [...selectedIds];
  for (const id of ids) {
    try { await window.aidm.removeDownload(id); } catch (e) {}
  }
  downloads = downloads.filter(d => !ids.includes(d.id));
  ids.forEach(id => selectedIds.delete(id));
  renderDownloads();
  updateStats();
  showNotification(`Removed ${ids.length} item(s) from list`);
}

/** Open the delete dialog for the selection, or the whole list if nothing is selected. */
function deleteSelectedOrAll() {
  if (selectedIds.size > 0) {
    showDeleteModal([...selectedIds]);
  } else if (downloads.length > 0) {
    showDeleteModal(downloads.map(d => d.id));
  } else {
    showNotification('List is already empty');
  }
}

async function refreshList() {
  try {
    downloads = await window.aidm.getDownloads();
    // Drop selections that no longer exist
    const alive = new Set(downloads.map(d => d.id));
    [...selectedIds].forEach(id => { if (!alive.has(id)) selectedIds.delete(id); });
    renderDownloads();
    updateStats();
    showNotification('List refreshed');
  } catch (err) {
    showNotification(`Refresh failed: ${err.message || err}`);
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function updateStats() {
  const all = downloads.length;
  const active = downloads.filter(d => d.status === 'downloading').length;
  const completed = downloads.filter(d => d.status === 'completed').length;
  const queued = downloads.filter(d => d.status === 'queued').length;
  const pending = downloads.filter(d => d.status === 'pending-approval').length;
  const errors = downloads.filter(d => d.status === 'error').length;

  document.getElementById('count-all').textContent = all;
  document.getElementById('count-active').textContent = active;
  document.getElementById('count-completed').textContent = completed;
  document.getElementById('count-queued').textContent = queued;
  document.getElementById('count-pending').textContent = pending;
  document.getElementById('count-error').textContent = errors;

  activeCount.textContent = active;
  document.getElementById('status-total').textContent = `Total: ${all} files`;
  document.getElementById('status-downloaded').textContent = `Completed: ${completed}`;
  updateSpeedDisplay();
}

function updateSpeedDisplay() {
  let total = 0;
  downloads.forEach(d => { if (d.status === 'downloading') total += d.speed || 0; });
  totalSpeed.textContent = formatSpeed(total);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  // Clamp: a corrupt/huge value must not index past the unit table.
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function formatSpeed(bytes) { return !bytes ? '0 B/s' : formatBytes(bytes) + '/s'; }

/** Format ETA seconds into a compact human string: "45s", "3m 12s", "1h 05m". */
function formatEta(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return Math.ceil(sec) + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + String(Math.floor(sec % 60)).padStart(2, '0') + 's';
  return Math.floor(sec / 3600) + 'h ' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + 'm';
}

function getFileIcon(filename) {
  if (/\.(mp4|mkv|avi|mov|wmv|webm|flv|m4v)/i.test(filename)) return '🎬';
  if (/\.(mp3|wav|flac|aac|ogg|wma|m4a)/i.test(filename)) return '🎵';
  if (/\.(jpg|jpeg|png|gif|bmp|svg|webp|psd)/i.test(filename)) return '🖼️';
  if (/\.(pdf)/i.test(filename)) return '📕';
  if (/\.(doc|docx|txt|rtf)/i.test(filename)) return '📄';
  if (/\.(xls|xlsx|csv)/i.test(filename)) return '📊';
  if (/\.(zip|rar|7z|tar|gz)/i.test(filename)) return '📦';
  if (/\.(exe|msi)/i.test(filename)) return '💿';
  if (/\.(iso|img|dmg)/i.test(filename)) return '💽';
  return '📄';
}

function truncateUrl(url) {
  try { const u = new URL(url); return u.hostname + u.pathname.substring(0, 40) + (u.pathname.length > 40 ? '...' : ''); }
  catch { return url.substring(0, 60); }
}
function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

// ── Test surface ─────────────────────────────────────────────────────────────
// The renderer is sandboxed with no module system, so the pure helpers above
// are published on `window` for test/ui-dimensions.js to assert on.
if (typeof window !== 'undefined') {
  window.__aidmTest = {
    dimensionInfo, formatRowMeta, qualityBadgeHtml, mediaTooltip, formatDuration,
    pickerResolutionInfo, qualityHeight, qualityVideoCompare,
  };
}

function showNotification(text, type) {
  // Honor the "Desktop Notifications" toggle — when off, suppress toasts.
  if (settings && settings.notifications === false) return;
  const t = document.createElement('div');
  const isError = type === 'error' || type === 'warn';
  t.style.cssText = `position:fixed;bottom:40px;right:20px;padding:12px 20px;background:var(--bg-surface);border:1px solid ${isError ? 'var(--error)' : 'var(--success)'};border-radius:8px;color:var(--text-primary);font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,.4);z-index:9999;`;
  t.textContent = (isError ? '⚠️ ' : '✅ ') + text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
