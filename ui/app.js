/**
 * AiDM v2 — UI Controller
 * Features: Video quality picker, per-category paths, ask-every-time, auto-detection
 */

let downloads = [];
let settings = {};
let activeCategory = 'all';
let selectedIds = new Set();
let contextTarget = null;
let selectedQuality = null;  // for quality picker modal
let pendingApprovalId = null; // for folder approval modal
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
});

// ── Render Downloads ──────────────────────────────────────────────────────────

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

function renderDownloadRow(dl) {
    const tr = document.createElement('tr');
    tr.dataset.id = dl.id;
    tr.className = selectedIds.has(dl.id) ? 'selected' : '';

    const percent = dl.percent || (dl.totalSize > 0 ? (dl.downloaded / dl.totalSize * 100).toFixed(1) : 0);
    const icon = getFileIcon(dl.filename);
    const speedStr = formatSpeed(dl.speed);
    const sizeStr = dl.totalSize > 0 ? formatBytes(dl.totalSize) : (dl.quality?.size ? formatBytes(dl.quality.size) : 'Unknown');
    const downloadedStr = formatBytes(dl.downloaded);

    // Quality badge (from video detection)
    let qualityBadge = '';
    if (dl.quality && dl.quality.label) {
      qualityBadge = `<span class="file-quality-badge">${escapeHtml(dl.quality.label)}</span>`;
    } else if (dl.quality && dl.quality !== 'unknown') {
      qualityBadge = `<span class="file-quality-badge">${escapeHtml(String(dl.quality))}</span>`;
    }

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
      <td class="col-progress">
        <div class="progress-cell">
          <div class="progress-bar">
            <div class="progress-fill" style="width:${percent}%"></div>
          </div>
          <span class="progress-text">${percent}%</span>
        </div>
        ${renderSegments(dl.segments)}
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
      await window.aidm.removeDownload(id);
      downloads = downloads.filter(d => d.id !== id);
      selectedIds.delete(id);
      renderDownloads();
      updateStats();
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
    case 'copy-url': {
      const dl = downloads.find(d => d.id === id);
      if (dl) navigator.clipboard.writeText(dl.url);
      break;
    }
  }
}

// ── Context Menu ──────────────────────────────────────────────────────────────

function showContextMenu(x, y, dl) {
  const menu = document.getElementById('context-menu');
  menu.style.display = 'block';
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 250)}px`;
  menu.querySelectorAll('.ctx-item').forEach(item => {
    const a = item.dataset.action;
    item.style.display = '';
    if (a === 'pause' && dl.status !== 'downloading') item.style.display = 'none';
    if (a === 'resume' && dl.status !== 'paused' && dl.status !== 'error') item.style.display = 'none';
    if (a === 'open-file' && dl.status !== 'completed') item.style.display = 'none';
    if (a === 'open-folder' && dl.status !== 'completed') item.style.display = 'none';
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

const COL_MIN_WIDTH = { name: 140, size: 70, progress: 110, speed: 70, status: 80, actions: 80 };

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
      dl.segments = data.segments; dl.status = 'downloading';
    }
    renderDownloads();
    updateSpeedDisplay();
  });

  window.aidm.onDownloadComplete((data) => {
    const dl = downloads.find(d => d.id === data.id);
    if (dl) { dl.status = 'completed'; dl.completedAt = Date.now(); }
    renderDownloads();
    updateStats();
    showNotification(`Download complete: ${dl?.filename || 'File'}`);
  });

  window.aidm.onDownloadError((data) => {
    const dl = downloads.find(d => d.id === data.id);
    if (dl) { dl.status = 'error'; dl.error = data.error; }
    renderDownloads();
    updateStats();
  });

  window.aidm.onDownloadPaused((data) => {
    const dl = downloads.find(d => d.id === data.id);
    if (dl) dl.status = 'paused';
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

  window.aidm.onClipboardLink((url) => {
    document.getElementById('input-url').value = url;
    showAddModal();
  });

  // ── New: Ask-every-time approval ──────────────────────────────────────────
  window.aidm.onDownloadAskLocation((data) => {
    // Fall back to the event payload: the row may not have reached the
    // renderer's local list yet, and the prompt must never be skipped.
    const dl = downloads.find(d => d.id === data.id) || data;
    showApprovalModal(dl);
  });

  // ── New: Video quality detected ──────────────────────────────────────────
  window.aidm.onVideoDetected((data) => {
    showQualityPicker(data);
  });
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
  document.getElementById('btn-delete').addEventListener('click', deleteSelected);
  document.getElementById('btn-delete-all').addEventListener('click', deleteAllDownloads);
  document.getElementById('btn-refresh').addEventListener('click', refreshList);
  document.getElementById('btn-settings').addEventListener('click', showSettingsModal);
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

  // Approval modal
  document.getElementById('approval-close').addEventListener('click', hideApprovalModal);
  document.getElementById('btn-reject-approval').addEventListener('click', () => {
    if (pendingApprovalId) window.aidm.rejectDownload(pendingApprovalId);
    hideApprovalModal();
  });
  document.getElementById('btn-approve').addEventListener('click', approveDownload);
  document.getElementById('btn-browse-approval').addEventListener('click', async () => {
    const f = await window.aidm.selectFolder();
    if (f) document.getElementById('approval-savepath').value = f;
  });

  // Editable file name: paste from clipboard, reset to the detected name,
  // and Enter to confirm (standard Ctrl+V / right-click also work).
  document.getElementById('btn-approval-paste').addEventListener('click', pasteApprovalFilename);
  document.getElementById('btn-approval-reset').addEventListener('click', () => {
    const el = document.getElementById('approval-filename');
    el.value = approvalOriginalFilename;
    el.focus();
    selectFilenameStem();
    setApprovalHint('Restored the detected file name.');
  });
  document.getElementById('approval-filename').addEventListener('focus', selectFilenameStem);
  document.getElementById('approval-filename').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); approveDownload(); }
  });

  // Settings modal
  document.getElementById('settings-close').addEventListener('click', hideSettingsModal);
  document.getElementById('btn-cancel-settings').addEventListener('click', hideSettingsModal);
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

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); showAddModal(); }
    if (e.key === 'F5') { e.preventDefault(); refreshList(); }
    if (e.key === 'Escape') { hideAddModal(); hideSettingsModal(); hideQualityPicker(); hideApprovalModal(); hideContextMenu(); hideAiModal(); }
    if (e.key === 'Delete' && selectedIds.size > 0) selectedIds.forEach(id => handleAction('remove', id));
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

  await window.aidm.addDownload({ url, filename, savePath, segments });
  hideAddModal();
}

// ── Quality Picker Modal ──────────────────────────────────────────────────────

let qualityVideos = [];
let qualitySelectedIdx = -1;

function showQualityPicker(data) {
  qualityVideos = data.videos || [];
  qualitySelectedIdx = -1;

  if (qualityVideos.length === 0) return;

  document.getElementById('quality-page-title').textContent = data.pageTitle || 'Video detected';
  document.getElementById('quality-page-url').textContent = data.pageUrl || '';

  const list = document.getElementById('quality-list');
  list.innerHTML = '';

  // Sort by quality tier (highest first)
  const tierOrder = { '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, '360p': 0 };
  qualityVideos.sort((a, b) => (tierOrder[b.quality] || -1) - (tierOrder[a.quality] || -1));

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
    const resolutionText = video.resolution || video.quality || 'Unknown quality';

    opt.innerHTML = `
      <div class="quality-icon">${qualityIcon}</div>
      <div class="quality-info">
        <div class="quality-label">${video.quality?.toUpperCase() || 'Unknown'}</div>
        <div class="quality-resolution">${escapeHtml(resolutionText)}</div>
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
    meta: video,
  });

  hideQualityPicker();
  showNotification('Video download started');
}

// ── Approval Modal (Ask Every Time) ───────────────────────────────────────────

let approvalOriginalFilename = '';

/** Select the name without its extension, like Windows' rename does. */
function selectFilenameStem() {
  const el = document.getElementById('approval-filename');
  if (!el) return;
  const v = el.value;
  const dot = v.lastIndexOf('.');
  try {
    el.focus();
    el.setSelectionRange(0, dot > 0 ? dot : v.length);
  } catch (e) { el.select(); }
}

function setApprovalHint(msg, warn) {
  const el = document.getElementById('approval-filename-hint');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('warn', !!warn);
}

function showApprovalModal(dl) {
  pendingApprovalId = dl.id;
  approvalOriginalFilename = dl.filename || '';
  document.getElementById('approval-filename').value = approvalOriginalFilename;
  setApprovalHint('Renaming is applied before the first byte is written.');
  const catLabel = { video: '🎬 Video', audio: '🎵 Music', document: '📄 Document',
    archive: '📦 Archive', software: '💿 Software', image: '🖼️ Image', other: '📁 Other' };
  document.getElementById('approval-category').textContent = catLabel[dl.category] || '📁 File';
  document.getElementById('approval-savepath').value =
    dl.savePath || dl.suggestedPath || settings.defaultSavePath || '';
  document.getElementById('approval-remember').checked = false;
  document.getElementById('approval-overlay').style.display = 'flex';
  // Keep AiDM above every other window until the location is answered.
  try { window.aidm.setAlwaysOnTop(true); } catch (e) {}
  selectFilenameStem();
}

function hideApprovalModal() {
  document.getElementById('approval-overlay').style.display = 'none';
  pendingApprovalId = null;
  approvalOriginalFilename = '';
  setApprovalHint('');
  try { window.aidm.setAlwaysOnTop(false); } catch (e) {}
}

async function pasteApprovalFilename() {
  const el = document.getElementById('approval-filename');
  let text = '';
  try { text = (await window.aidm.readClipboard()) || ''; } catch (e) {}
  text = String(text).trim();
  if (!text) { setApprovalHint('Clipboard is empty or holds no text.', true); return; }
  // A pasted URL/path — keep only the last segment.
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  if (slash >= 0) text = text.slice(slash + 1);
  const q = text.indexOf('?');
  if (q > 0) text = text.slice(0, q);
  try { text = decodeURIComponent(text); } catch (e) {}
  if (!text) { setApprovalHint('Clipboard is empty or holds no text.', true); return; }
  el.value = text;
  el.focus();
  setApprovalHint('Pasted — press Enter or Start Download.');
}

async function approveDownload() {
  if (!pendingApprovalId) return;
  const savePath = document.getElementById('approval-savepath').value.trim();
  if (!savePath) return;

  const filenameEl = document.getElementById('approval-filename');
  const rawName = (filenameEl.value || '').trim();
  // Never start a download with an empty name — restore the detected one.
  let filename = rawName;
  if (!filename) {
    filename = approvalOriginalFilename;
    filenameEl.value = filename;
    setApprovalHint('File name was empty — using the detected name.', true);
  }

  // If "remember" is checked, save this path for the category
  if (document.getElementById('approval-remember').checked) {
    const dl = downloads.find(d => d.id === pendingApprovalId);
    if (dl && dl.category) {
      const newSettings = { ...settings, categoryPaths: { ...settings.categoryPaths, [dl.category]: savePath } };
      await window.aidm.saveSettings(newSettings);
      settings = newSettings;
    }
  }

  await window.aidm.approveDownload(pendingApprovalId, savePath, filename);
  hideApprovalModal();
  // The row may have been renamed, so re-read the authoritative list.
  downloads = await window.aidm.getDownloads();
  renderDownloads();
  updateStats();
}

// ── Settings Modal ────────────────────────────────────────────────────────────

async function showSettingsModal() {
  settings = await window.aidm.getSettings();
  document.getElementById('setting-concurrent').value = settings.maxConcurrentDownloads;
  document.getElementById('setting-segments').value = settings.defaultSegments;
  document.getElementById('setting-savepath').value = settings.defaultSavePath;
  document.getElementById('setting-clipboard').checked = settings.clipboardMonitor;
  document.getElementById('setting-browser').checked = settings.browserIntegration;
  document.getElementById('setting-notifications').checked = settings.notifications;
  document.getElementById('setting-ask-location').checked = settings.askLocationEveryTime || false;
  document.getElementById('setting-launch-startup').checked = settings.launchAtStartup !== false;
  document.getElementById('setting-minimize-tray').checked = settings.minimizeToTray !== false;
  // AI (TokenHarbor) — never display existing key back in full; show placeholder only
  document.getElementById('setting-ai-enabled').checked = settings.aiEnabled !== false;
  document.getElementById('setting-ai-baseurl').value = settings.aiBaseURL || 'https://tokenharbor.ai/v1';
  document.getElementById('setting-ai-key').value = '';
  document.getElementById('setting-ai-key').placeholder = settings.aiApiKey ? '•••••• (saved — leave empty to keep)' : 'thk_live_… or set TOKENHARBOR_API_KEY env var';
  document.getElementById('setting-ai-primary').value = settings.aiPrimaryModel || 'mimo-v2.5:free';
  document.getElementById('setting-ai-fallback').value = settings.aiFallbackModel || 'deepseek-v4-flash:free';
  document.getElementById('ai-status-hint').textContent = 'Key is stored locally only. Env var takes precedence when set.';

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
  settings = {
    maxConcurrentDownloads: parseInt(document.getElementById('setting-concurrent').value) || 3,
    defaultSegments: parseInt(document.getElementById('setting-segments').value) || 8,
    defaultSavePath: document.getElementById('setting-savepath').value,
    clipboardMonitor: document.getElementById('setting-clipboard').checked,
    browserIntegration: document.getElementById('setting-browser').checked,
    notifications: document.getElementById('setting-notifications').checked,
    askLocationEveryTime: document.getElementById('setting-ask-location').checked,
    launchAtStartup: document.getElementById('setting-launch-startup').checked,
    minimizeToTray: document.getElementById('setting-minimize-tray').checked,
    categoryPaths,
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

// ── AI Assistant (TokenHarbor) ────────────────────────────────────────────────

let aiHistory = [];

function showAiModal() {
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
// Note: these remove entries from the AiDM list only; files already saved on
// disk are left untouched.

async function deleteSelected() {
  if (selectedIds.size === 0) {
    showNotification('Nothing selected — click a row or tick its checkbox first');
    return;
  }
  const ids = [...selectedIds];
  if (ids.length > 1 && !confirm(`Remove ${ids.length} selected downloads from the list?\n(Files already on disk are kept.)`)) return;
  for (const id of ids) {
    try { await window.aidm.removeDownload(id); } catch (e) {}
  }
  downloads = downloads.filter(d => !selectedIds.has(d.id));
  selectedIds.clear();
  renderDownloads();
  updateStats();
}

async function deleteAllDownloads() {
  if (downloads.length === 0) {
    showNotification('List is already empty');
    return;
  }
  if (!confirm(`Remove ALL ${downloads.length} downloads from the list?\n(Files already on disk are kept. This cannot be undone.)`)) return;
  for (const dl of [...downloads]) {
    try { await window.aidm.removeDownload(dl.id); } catch (e) {}
  }
  downloads = [];
  selectedIds.clear();
  renderDownloads();
  updateStats();
  showNotification('All downloads removed from list');
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
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function formatSpeed(bytes) { return !bytes ? '0 B/s' : formatBytes(bytes) + '/s'; }

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

function showNotification(text) {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:40px;right:20px;padding:12px 20px;background:var(--bg-surface);border:1px solid var(--success);border-radius:8px;color:var(--text-primary);font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,.4);z-index:9999;`;
  t.textContent = `✅ ${text}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
