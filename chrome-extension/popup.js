/**
 * AiDM Chrome Extension - Popup v2
 * Shows detected videos with quality/resolution/size info
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('status-dot');
  const connectionStatus = document.getElementById('connection-status');
  const interceptCount = document.getElementById('intercept-count');
  const urlInput = document.getElementById('url-input');
  const btnDownload = document.getElementById('btn-download');
  const btnScan = document.getElementById('btn-scan');
  const mediaList = document.getElementById('media-list');
  const mediaCount = document.getElementById('media-count');
  const scanStatus = document.getElementById('scan-status');

  // ── Check Connection ─────────────────────────────────────────────────────────

  chrome.runtime.sendMessage({ action: 'check-connection' }, (response) => {
    if (response && response.connected) {
      statusDot.classList.add('connected');
      statusDot.title = 'Connected to AiDM';
      connectionStatus.textContent = 'Connected';
      interceptCount.textContent = response.intercepted || 0;
    } else {
      statusDot.classList.remove('connected');
      connectionStatus.textContent = 'Disconnected';
    }
  });

  // ── Download URL ─────────────────────────────────────────────────────────────

  btnDownload.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) return;
    btnDownload.disabled = true;
    btnDownload.textContent = '⏳ Sending...';

    chrome.runtime.sendMessage({ action: 'single-download', url }, (response) => {
      btnDownload.disabled = false;
      btnDownload.textContent = '⬇️ Download';
      if (response && response.success) {
        urlInput.value = '';
        showStatus('Download sent to AiDM!', 'success');
      } else {
        showStatus('Failed. Is AiDM running?', 'error');
      }
    });
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnDownload.click();
  });

  // ── Scan Page ────────────────────────────────────────────────────────────────

  btnScan.addEventListener('click', async () => {
    btnScan.disabled = true;
    btnScan.textContent = '🔍 Scanning...';
    scanStatus.classList.add('active');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    chrome.tabs.sendMessage(tab.id, { action: 'scan-page' }, (response) => {
      btnScan.disabled = false;
      btnScan.textContent = '🔍 Scan Page';
      scanStatus.classList.remove('active');

      if (chrome.runtime.lastError) {
        mediaList.innerHTML = '<div class="empty">Could not scan this page</div>';
        mediaCount.textContent = '0';
        return;
      }

      if (!response) {
        mediaList.innerHTML = '<div class="empty">No response from page</div>';
        mediaCount.textContent = '0';
        return;
      }

      const allMedia = [];

      // Videos with quality info
      if (response.videos && response.videos.length > 0) {
        response.videos.forEach(v => allMedia.push({ ...v, type: 'video' }));
      }

      // Download links
      if (response.links && response.links.length > 0) {
        response.links.forEach(url => {
          // Don't duplicate if already in videos
          if (!allMedia.some(m => m.url === url)) {
            allMedia.push({ url, type: 'link', quality: 'unknown' });
          }
        });
      }

      mediaCount.textContent = allMedia.length;

      if (allMedia.length === 0) {
        mediaList.innerHTML = '<div class="empty">No downloadable media found on this page</div>';
        return;
      }

      // Hide anything already sent to AiDM — no double offers
      chrome.runtime.sendMessage({ action: 'get-panel-data', tabId: tab.id }, (pd) => {
        let items = allMedia;
        if (pd && !chrome.runtime.lastError && pd.sent && pd.sent.length) {
          const exact = new Set(pd.sent);
          const norm = new Set(pd.sent.map(normalizeInline).filter(Boolean));
          items = allMedia.filter(m => !exact.has(m.url) && !norm.has(normalizeInline(m.url)));
        }
        mediaCount.textContent = items.length;
        if (items.length === 0) {
          mediaList.innerHTML = '<div class="empty">No new media — everything found is already in AiDM</div>';
          return;
        }
        renderMediaList(items, tab);
      });
    });
  });

  // ── Grab Video (deep scan of active tab, with diagnostics) ─────────────────────
  const btnGrab = document.getElementById('btn-grab');
  btnGrab.addEventListener('click', async () => {
    btnGrab.disabled = true;
    btnGrab.textContent = '🎬 Grabbing...';
    scanStatus.classList.add('active');
    scanStatus.textContent = '🎬 Deep-scanning active tab for video…';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 1) Force a hard re-scan of the page (catches late-injected players)
    const grab = await new Promise(res => {
      chrome.tabs.sendMessage(tab.id, { action: 'force-grab' }, (r) => res(r || null));
    });

    // 2) Pull diagnostics so we can tell the user exactly what's on the page
    const diag = await new Promise(res => {
      chrome.tabs.sendMessage(tab.id, { action: 'get-diagnostics' }, (r) => res(r || null));
    });

    btnGrab.disabled = false;
    btnGrab.textContent = '🎬 Grab Video (active tab)';
    scanStatus.classList.remove('active');

    const videos = (grab && grab.videos) || (diag && diag.detectedVideos) || [];
    if (videos.length) {
      renderMediaList(videos.map(v => ({ ...v, type: 'video' })), tab);
      mediaCount.textContent = videos.length;
      showStatus(`Found ${videos.length} video source(s)`, 'success');
      return;
    }

    // Nothing detected — show what we DID see so the user can report it
    const videoEls = (diag && diag.videoElements) || [];
    const lines = [];
    lines.push(`Host: ${diag ? diag.url : tab.url}`);
    lines.push(`<video> elements: ${videoEls.length}`);
    videoEls.slice(0, 4).forEach((v, i) => {
      lines.push(`  #${i + 1} src="${v.src || '(none)'}" w/h=${v.videoWidth}x${v.videoHeight} sources=${v.hasSourceChildren} rs=${v.readyState} ns=${v.networkState}`);
    });
    lines.push(`flashvars present: ${diag ? diag.hasFlashvars : 'unknown'}`);
    lines.push(`detected links: ${diag ? (diag.detectedLinks || []).length : '?'}`);
    mediaList.innerHTML = '<div class="empty">' +
      lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>') +
      '<br><br>If the real URL is here, send it to us — otherwise try playing the video first, then Grab again.</div>';
    mediaCount.textContent = '0';
  });

  // ── Render Media List ────────────────────────────────────────────────────────

  function renderMediaList(mediaItems, tab) {
    mediaList.innerHTML = '';

    // Sort: videos with quality first, then by quality tier
    const tierOrder = { '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, '360p': 0 };
    mediaItems.sort((a, b) => {
      if (a.type === 'video' && b.type !== 'video') return -1;
      if (a.type !== 'video' && b.type === 'video') return 1;
      return (tierOrder[b.quality] || -1) - (tierOrder[a.quality] || -1);
    });

    mediaItems.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'media-item';

      let name = 'File';
      try {
        const pathname = new URL(item.url).pathname;
        name = decodeURIComponent(pathname.split('/').pop()) || 'File';
        if (name.length > 50) name = name.substring(0, 47) + '...';
      } catch {
        name = item.url.substring(0, 50) + '...';
      }

      const icon = item.type === 'video' ? '🎬' :
                   /\.(mp3|wav|flac|aac)/i.test(item.url) ? '🎵' :
                   /\.(jpg|png|gif|webp)/i.test(item.url) ? '🖼️' :
                   /\.(zip|rar|7z)/i.test(item.url) ? '📦' :
                   /\.(exe|msi)/i.test(item.url) ? '💿' : '📄';

      const qualityText = item.quality && item.quality !== 'unknown'
        ? item.quality.toUpperCase()
        : (item.resolution || '');

      const sizeText = item.size ? formatBytes(item.size) : '';
      const formatText = item.format ? item.format.toUpperCase() : '';

      // Build quality badge
      let qualityBadge = '';
      if (qualityText) {
        qualityBadge = `<span class="quality-badge">${escapeHtml(qualityText)}</span>`;
      }

      el.innerHTML = `
        <div class="media-icon">${icon}</div>
        <div class="media-info">
          <span class="media-name" title="${escapeHtml(item.url)}">${escapeHtml(name)}</span>
          <div class="media-meta">
            ${qualityBadge}
            ${sizeText ? `<span class="size-badge">${sizeText}</span>` : ''}
            ${formatText ? `<span class="format-badge">${formatText}</span>` : ''}
          </div>
        </div>
        <button class="media-btn" data-idx="${i}">Download</button>
      `;

      el.querySelector('.media-btn').addEventListener('click', () => {
        const btn = el.querySelector('.media-btn');
        btn.disabled = true;
        btn.textContent = '⏳';

        chrome.runtime.sendMessage({
          action: 'single-download',
          url: item.url,
          opts: {
            quality: item.quality,
            meta: {
              resolution: item.resolution,
              format: item.format,
              size: item.size,
              pageTitle: tab.title,
              pageUrl: tab.url,
            },
          },
        }, (resp) => {
          if (resp && resp.success) {
            btn.textContent = resp.duplicate ? '✓ In AiDM' : '✓ Sent';
            btn.classList.add('sent');
          } else {
            btn.textContent = '✗ Failed';
            btn.disabled = false;
          }
        });
      });

      mediaList.appendChild(el);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // Token-insensitive URL compare so rotated signed URLs still match sent ones
  const TOKEN_KEYS = new Set(['token', 'tokens', 'sig', 'signature', 'sign', 'expires', 'expiry', 'exp', 'e', 'h', 'hdnea', 'hdntl', 'hdnts', 'st', 'key', 'auth', 'authkey', 'wmsauthsign', 'mst', 'access_token', 'token_expires', 'session', 'sid', 'policy', 'token_hash', 'verify', 'md5', 't', 'ts', '_']);
  function normalizeInline(u) {
    try {
      const x = new URL(String(u || '').trim());
      x.hash = '';
      x.hostname = x.hostname.toLowerCase();
      const params = Array.from(x.searchParams.entries()).filter(([k]) => !TOKEN_KEYS.has(k.toLowerCase()));
      params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const qs = new URLSearchParams();
      params.forEach(([k, v]) => qs.append(k, v));
      x.search = qs.toString();
      return x.toString();
    } catch {
      return null;
    }
  }

  function showStatus(text, type) {
    const existing = document.querySelector('.status-msg');
    if (existing) existing.remove();

    const msg = document.createElement('div');
    msg.className = 'status-msg';
    msg.style.cssText = `
      padding: 6px 12px; margin-top: 8px; border-radius: 4px;
      font-size: 11px; text-align: center;
      background: ${type === 'success' ? '#dcfce7' : '#fee2e2'};
      color: ${type === 'success' ? '#15803d' : '#b91c1c'};
      border: 1px solid ${type === 'success' ? '#86efac' : '#fca5a5'};
    `;
    msg.textContent = text;
    document.querySelector('.body').appendChild(msg);
    setTimeout(() => msg.remove(), 3000);
  }
});
