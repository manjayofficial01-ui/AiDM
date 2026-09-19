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

      // Hide anything already sent to AiDM — no double offers.
      // Also enrich rows with sniffed Content-Disposition filenames/sizes.
      // No `since`: the popup has no page clock — the background falls back
      // to the tab's recorded last-navigation time.
      chrome.runtime.sendMessage({ action: 'get-panel-data', tabId: tab.id }, (pd) => {
        let items = allMedia;
        let metaMap = null;
        if (pd && !chrome.runtime.lastError) {
          if (pd.sent && pd.sent.length) {
            const exact = new Set(pd.sent);
            const norm = new Set(pd.sent.map(normalizeInline).filter(Boolean));
            items = allMedia.filter(m => !exact.has(m.url) && !norm.has(normalizeInline(m.url)));
          }
          metaMap = pd.meta || null;
          // Fill missing filename/size from sniffed response headers.
          if (metaMap) {
            items.forEach(m => {
              const meta = metaMap[m.url] || (normalizeInline(m.url) && Object.entries(metaMap).find(([k]) => normalizeInline(k) === normalizeInline(m.url))?.[1]);
              if (meta) {
                if (!m.filename && meta.filename) m.filename = meta.filename;
                if (!m.size && meta.size) m.size = meta.size;
              }
            });
          }
        }
        const deduped = dedupeMedia(items);
        mediaCount.textContent = deduped.length;
        if (deduped.length === 0) {
          mediaList.innerHTML = '<div class="empty">No new media — everything found is already in AiDM</div>';
          return;
        }
        renderMediaList(deduped, tab, metaMap);
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
      const pd = await new Promise(res => {
        try {
          chrome.runtime.sendMessage({ action: 'get-panel-data', tabId: tab.id }, (r) => res(r || null));
        } catch (e) { res(null); }
      });
      const metaMap = (pd && pd.meta) || null;
      if (metaMap) {
        videos.forEach(v => {
          const meta = metaMap[v.url];
          if (meta) {
            if (!v.filename && meta.filename) v.filename = meta.filename;
            if (!v.size && meta.size) v.size = meta.size;
          }
        });
      }
      const deduped = dedupeMedia(videos.map(v => ({ ...v, type: 'video' })));
      renderMediaList(deduped, tab, metaMap);
      mediaCount.textContent = deduped.length;
      showStatus(`Found ${deduped.length} video source(s)`, 'success');
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

  // ── Resolve Page Video (browser-stack embed fallback) ─────────────────────
  const btnResolve = document.getElementById('btn-resolve');
  btnResolve.addEventListener('click', async () => {
    btnResolve.disabled = true;
    btnResolve.textContent = '🔗 Resolving...';
    scanStatus.classList.add('active');
    scanStatus.textContent = '🔗 Resolving the embedded player…';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.runtime.sendMessage({ action: 'resolve-embed', url: tab.url }, (resp) => {
      btnResolve.disabled = false;
      btnResolve.textContent = '🔗 Resolve Page Video';
      scanStatus.classList.remove('active');

      if (chrome.runtime.lastError || !resp) {
        showStatus('Could not resolve this page', 'error');
        return;
      }
      if (!resp.success) {
        showStatus('Resolve failed: ' + (resp.error || 'unknown error'), 'error');
        return;
      }
      showStatus(`Resolved "${resp.title}" — ${resp.count} qualit${resp.count === 1 ? 'y' : 'ies'}, pick one in AiDM!`, 'success');
    });
  });

  // ── Grab Site (same-origin crawl, v4.3.0) ─────────────────────────────────
  const btnGrabSite = document.getElementById('btn-grab-site');
  btnGrabSite.addEventListener('click', async () => {
    btnGrabSite.disabled = true;
    btnGrabSite.textContent = '🕸 Grabbing...';
    scanStatus.classList.add('active');
    scanStatus.textContent = '🕸 Crawling this site for downloadable files…';

    const depthEl = document.getElementById('grab-depth');
    const typesEl = document.getElementById('grab-types');
    const depth = depthEl ? (parseInt(depthEl.value, 10) || 1) : 1;
    const types = typesEl
      ? typesEl.value.split(/[,;\s]+/).map(t => t.trim().toLowerCase().replace(/^\.+/, '')).filter(t => /^[a-z0-9]{1,10}$/.test(t))
      : [];

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'grab-site', opts: { depth, types } }, (resp) => {
      btnGrabSite.disabled = false;
      btnGrabSite.textContent = '🕸 Grab Site';
      scanStatus.classList.remove('active');

      if (chrome.runtime.lastError || !resp) {
        showStatus('Could not grab this page', 'error');
        return;
      }
      if (!resp.success) {
        showStatus('Grab failed: ' + (resp.message || 'unknown error'), 'error');
        return;
      }
      if (!resp.count) {
        showStatus(`Scanned ${resp.pages || 0} page(s) — no downloadable files found`, 'error');
        return;
      }
      showStatus(`Sent ${resp.count} file(s) from ${resp.pages || 0} page(s) to AiDM!`, 'success');
    });
  });

  // ── Render Media List ────────────────────────────────────────────────────────

  // Filter raw segments + collapse token-rotated duplicates before render.
  function dedupeMedia(items) {
    const seen = new Set();
    const out = [];
    for (const m of items || []) {
      if (!m || !m.url || !/^https?:/i.test(m.url)) continue;
      // Twitter/X encrypted HLS playlists are never downloadable (the desktop
      // syndication resolver supplies the real MP4s) — drop them so one video
      // never renders as 100+ identical rows. Same for chunks/thumbs: only
      // direct …/pu/vid/….mp4 variants are offered.
      if (/video\.twimg\.com|pbs\.twimg\.com|t\.twimg\.com/i.test(m.url)) {
        if (!(/\.mp4(\?|#|$)/i.test(m.url) && /\/vid\/|ext_tw_video|amplify_video/i.test(m.url))) continue;
      }
      if (/\.m4s($|\?|#|;)/i.test(m.url)) continue;
      if (/\.ts($|\?|#|;)/i.test(m.url) && /seg|chunk|frag|part|range|hls|dash|playlist|media|sq_|index|seq/i.test(m.url)) continue;
      if (/seg-?\d+|chunklist|fragment|frag-?\d+|\/range\//i.test(m.url)) continue;
      const n = normalizeInline(m.url) || m.url;
      if (seen.has(n)) {
        const prev = out.find(o => (normalizeInline(o.url) || o.url) === n);
        if (prev) {
          if (m.playing) prev.playing = true;
          if (!prev.filename && m.filename) prev.filename = m.filename;
          if (!prev.size && m.size) prev.size = m.size;
        }
        continue;
      }
      seen.add(n);
      out.push(m);
    }
    // Same-file rows (token rotation, player re-fetches) collapse so one
    // Facebook video never renders as dozens of identical rows. Pure helper
    // below; test/facebook-panel.js asserts parity with the other copies.
    const collapsed = new Map();
    for (const m of out) {
      const k = collapseRowKeyInline(m);
      const prev = collapsed.get(k);
      if (!prev) { collapsed.set(k, m); continue; }
      if (m.playing) prev.playing = true;
      if (!prev.filename && m.filename) prev.filename = m.filename;
      if (!prev.size && m.size) prev.size = m.size;
      if ((!prev.quality || prev.quality === 'unknown') && m.quality && m.quality !== 'unknown') {
        prev.quality = m.quality;
        if (m.resolution) prev.resolution = m.resolution;
      }
      if (!prev.resolution && m.resolution) prev.resolution = m.resolution;
    }
    return [...collapsed.values()];
  }

  /** Canonical path identity of a Facebook media object (query-immune). */
  function fbPathKeyInline(u) {
    try {
      const x = new URL(String(u || ''));
      if (!FB_INLINE_RE.test(x.hostname)) return null;
      return 'fbpath:' + fbCanonHostInline(x.hostname) + x.pathname;
    } catch (e) { return null; }
  }

  /** Stable rendition tag of a Facebook URL ('' when absent/unparseable). */
  function fbEfgTagOfUrlInline(u) {
    try {
      const efg = new URL(String(u || '')).searchParams.get('efg');
      return fbEfgTagInline(efg) || '';
    } catch (e) { return ''; }
  }

  /**
   * Presentation collapse key (mirrors collapseRowKey in content.js and
   * background.js — keep the three in sync). Non-Facebook URLs keep
   * exact-key semantics.
   */
  function collapseRowKeyInline(v) {
    const url = String((v && v.url) || '');
    if (!fbPathKeyInline(url)) return 'u:' + (normalizeInline(url) || url);
    // No `size` in the key — mirrors content.js/background.js.
    const q = (v && v.quality && v.quality !== 'unknown') ? v.quality : '?';
    const res = (v && v.resolution) || '?';
    return fbPathKeyInline(url) + '|' + fbEfgTagOfUrlInline(url) + '|' + q + '|' + res;
  }

  /**
   * Not-a-video verdict (mirrors dropVideoCandidate in content.js and
   * background.js — keep the three in sync; test/facebook-junk.js asserts
   * parity).
   */
  function dropVideoCandidateInline(o) {
    const ct = String((o && o.contentType) || '');
    if (/^audio\//i.test(ct)) return 'audio';
    if (o && o.probed) {
      if (!o.hasVideo) return 'audio';
      const dur = Number(o.durationSec) || 0;
      const size = Number(o.sizeBytes) || 0;
      if (dur > 0 && dur < 2 && size > 0 && size < 1048576) return 'preview';
    }
    return null;
  }

  // Title helpers (pure logic mirrors aidm/src/titles.js — keep in sync).
  // Hostname-like placeholders ("mydaddy.cc") and rendition-only basenames
  // ("1080.mp4") are never shown as the file name.
  function looksLikeHostnameInline(s) {
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(s || '').trim());
  }
  function isRealTitleInline(t) {
    const s = String(t == null ? '' : t).trim().replace(/\s+/g, ' ');
    if (!s || s.length < 2) return false;
    if (looksLikeHostnameInline(s)) return false;
    if (/^(video|watch|play|player|home|index|untitled|download|downloads|media|clip|embed|empty|blank|no\s*title)$/i.test(s)) return false;
    // A bare domain with an affix ("mydaddy.cc - Home") is still not a title.
    const core = s
      .replace(/\s*[-|–—:|]\s*[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*$/i, '')
      .replace(/^[\w.-]+\.(cc|com|net|org|io|tv|xxx|porn|sex|video)\s*[-|–—:|]\s*/i, '')
      .trim();
    if (!core || looksLikeHostnameInline(core)) return false;
    if (/^(video|watch|play|player|home|index|untitled|download|downloads|media|clip|embed|empty|blank|no\s*title)$/i.test(core)) return false;
    return true;
  }
  function isGenericNameInline(name, url) {
    const s = String(name || '').trim();
    if (!s || s === 'download') return true;
    let host = '';
    try { host = new URL(String(url || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) {}
    const stem = s.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    if (!stem) return true;
    const low = stem.toLowerCase();
    if (host && (low === host || low === host.replace(/^www\./, ''))) return true;
    if (looksLikeHostnameInline(stem)) return true;
    if (/^\d{3,4}p?$/i.test(stem)) return true;
    if (/^(videoplayback|watch|video|play|index|download|media|get_file|dwnl|file|stream|content|player|embed)$/i.test(stem)) return true;
    if (/^download_\d+$/.test(stem)) return true;
    if (stem.length >= 12 && /^[0-9a-f]+$/i.test(stem)) return true;
    return false;
  }

  function resolveDisplayName(item, metaMap) {
    // Real filename first: explicit > sniffed Content-Disposition > page title.
    if (item.filename && !isGenericNameInline(item.filename, item.url)) return item.filename;
    try {
      const meta = (metaMap && (metaMap[item.url] || metaMap[normalizeInline(item.url)])) || null;
      if (meta && meta.filename && !isGenericNameInline(meta.filename, item.url)) return meta.filename;
    } catch (e) {}
    try {
      const pathname = new URL(item.url).pathname;
      let base = decodeURIComponent(pathname.split('/').pop()) || '';
      // Extensionless CDN/videoplayback hashes and rendition-only labels
      // ("1080.mp4") are not real names — fall back to the video title +
      // quality so rows are distinguishable.
      if (base && /\.[A-Za-z0-9]{2,4}$/.test(base) && !isGenericNameInline(base, item.url)) return base;
    } catch (e) {}
    const q = (item.quality && item.quality !== 'unknown') ? ` [${item.quality}]` : '';
    // Per-video title first, then the page title — but only when REAL. A bare
    // hostname ("mydaddy.cc") or other placeholder falls through to "video".
    let page = 'video';
    try {
      const cand = (item.title && isRealTitleInline(item.title)) ? String(item.title).trim().replace(/\s+/g, ' ').slice(0, 80)
        : (isRealTitleInline(item.pageTitle) ? String(item.pageTitle).trim().replace(/\s+/g, ' ').slice(0, 80) : null);
      if (cand) page = cand;
    } catch (e) {}
    const ext = (item.format || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
    return `${page}${q}.${ext}`;
  }

  function renderMediaList(mediaItems, tab, metaMap) {
    mediaList.innerHTML = '';
    mediaItems = dedupeMedia(mediaItems);

    // Sort: videos with quality first, then by quality tier
    const tierOrder = { '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, '360p': 0 };
    mediaItems.sort((a, b) => {
      if (a.type === 'video' && b.type !== 'video') return -1;
      if (a.type !== 'video' && b.type === 'video') return 1;
      return (tierOrder[b.quality] || -1) - (tierOrder[a.quality] || -1);
    });

    // Not-a-video filter (mirrors the capsule): sniffed audio responses are
    // DASH audio slices, not the video — drop them instead of offering junk.
    try {
      mediaItems = mediaItems.filter((m) => {
        if (!m || !m.url) return false;
        let ct = null;
        try {
          const meta = (metaMap && (metaMap[m.url] || metaMap[normalizeInline(m.url)])) || null;
          ct = meta && meta.contentType;
        } catch (e) {}
        return !dropVideoCandidateInline({ contentType: ct });
      });
    } catch (e) {}

    // True-dimensions probes queued while rows build (Twitter files whose
    // URLs carry no rendition marker show the scanned element's size for
    // every variant otherwise — see content.js probeVideoMeta).
    const popupMetaRuns = [];
    mediaItems.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'media-item';

      let name = resolveDisplayName(item, metaMap);
      const shortName = name.length > 60 ? name.substring(0, 57) + '...' : name;

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

      el.innerHTML = `
        <div class="media-icon">${icon}</div>
        <div class="media-info">
          <span class="media-name" title="${escapeHtml(name)}&#10;${escapeHtml(item.url)}">${escapeHtml(shortName)}</span>
          <div class="media-meta">
            ${metaBadgesHtml(item)}
          </div>
        </div>
        <button class="media-btn" data-idx="${i}">Download</button>
      `;

      // Verify every video-container row carries a real video track
      // (audio-only slices drop out); repaint geometry only for rows the
      // URL didn't describe. Bounded per render; cached while open.
      const probeCandidateUrl = item.url || '';
      // Facebook split-AV video tracks are DASH fragments, not standalone
      // files: a <video> probe reports 0x0 even though the track is real, so
      // probing used to delete every Facebook row. Exempt them (mirrors the
      // content.js probe gate).
      const isFbSplitVideo = FB_INLINE_RE.test(probeCandidateUrl) &&
        fbTrackKindOfUrlInline(probeCandidateUrl) === 'video';
      if (!isFbSplitVideo &&
          popupMetaRuns.length < POPUP_META_PROBE_MAX &&
          /^https?:/i.test(probeCandidateUrl) &&
          /\.(mp4|m4v|webm|mkv|mov|avi)(\?|#|$)/i.test(probeCandidateUrl)) {
        const hadDims = /\/vid\/\d{2,5}x\d{2,5}/i.test(probeCandidateUrl) || !!item.resolution;
        popupMetaRuns.push(() => {
          probePopupMeta(item.url).then((file) => {
            if (!file || !el.isConnected) return;
            if (!file.width || !file.height) {
              try { el.remove(); } catch (e) {}
              try {
                const mc = document.getElementById('media-count');
                if (mc) mc.textContent = String(document.querySelectorAll('.media-item').length);
              } catch (e) {}
              return;
            }
            if (hasDims) return;
            item.resolution = file.width + 'x' + file.height;
            item.quality = popupQualityForHeight(file.height);
            const box = el.querySelector('.media-meta');
            if (box) box.innerHTML = metaBadgesHtml(item);
          }).catch(() => {});
        });
      }

      el.querySelector('.media-btn').addEventListener('click', () => {
        const btn = el.querySelector('.media-btn');
        btn.disabled = true;
        btn.textContent = '⏳';

        chrome.runtime.sendMessage({
          action: 'single-download',
          url: item.url,
          opts: {
            audioUrl: item.audioUrl || undefined,
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

    if (popupMetaRuns.length) {
      try {
        popupMetaRuns.forEach((run) => { try { run(); } catch (e) {} });
      } catch (e) {}
    }
  }

  /** Quality/resolution/size badges for one row (re-rendered after probing). */
  function metaBadgesHtml(item) {
    const qualityText = item.quality && item.quality !== 'unknown'
      ? item.quality.toUpperCase()
      : (item.resolution || '');
    const sizeText = item.size ? formatBytes(item.size) : '';
    const formatText = item.format ? item.format.toUpperCase() : '';
    return (item.playing && item.type === 'video' ? '<span class="quality-badge playing-badge">▶ NOW PLAYING</span>' : '') +
      (qualityText ? `<span class="quality-badge">${escapeHtml(qualityText)}</span>` : '') +
      (item.resolution ? `<span class="size-badge">${escapeHtml(item.resolution)}</span>` : '') +
      (sizeText ? `<span class="size-badge">${sizeText}</span>` : '') +
      (formatText ? `<span class="format-badge">${formatText}</span>` : '');
  }

  function popupQualityForHeight(h) {
    h = Number(h) || 0;
    if (h >= 2160) return '2160p';
    if (h >= 1440) return '1440p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h >= 480) return '480p';
    if (h >= 360) return '360p';
    return h + 'p';
  }

  // True file dimensions via a metadata-only video load (mirrors
  // probeVideoMeta in content.js — keep the two in sync).
  const popupMetaCache = new Map(); // url -> Promise<{width,height}|null>
  const POPUP_META_PROBE_MAX = 6;
  function probePopupMeta(url) {
    if (popupMetaCache.has(url)) return popupMetaCache.get(url);
    const p = new Promise((resolve) => {
      let done = false;
      const finish = (out) => { if (!done) { done = true; resolve(out); } };
      try {
        const el = document.createElement('video');
        el.preload = 'metadata';
        el.muted = true;
        const timer = setTimeout(() => {
          try { el.removeAttribute('src'); el.load(); } catch (e) {}
          finish(null);
        }, 8000);
        el.onloadedmetadata = () => {
          clearTimeout(timer);
          const w = el.videoWidth || 0, h = el.videoHeight || 0;
          let d = 0;
          try { d = Number(el.duration) || 0; } catch (e) {}
          try { el.removeAttribute('src'); el.load(); } catch (e) {}
          finish({ width: w, height: h, durationSec: Number.isFinite(d) ? d : 0 });
        };
        el.onerror = () => { clearTimeout(timer); finish(null); };
        el.src = url;
      } catch (e) { finish(null); }
    });
    popupMetaCache.set(url, p);
    if (popupMetaCache.size > 60) popupMetaCache.delete(popupMetaCache.keys().next().value);
    return p;
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
  // (Facebook ?oh=/&oe= rotate per request — same video must still match).
  const TOKEN_KEYS = new Set(['token', 'tokens', 'sig', 'signature', 'sign', 'expires', 'expiry', 'exp', 'e', 'h', 'hdnea', 'hdntl', 'hdnts', 'st', 'key', 'auth', 'authkey', 'wmsauthsign', 'mst', 'access_token', 'token_expires', 'session', 'sid', 'policy', 'token_hash', 'verify', 'md5', 't', 'ts', '_', 'oh', 'oe', 'dl', 'rl', 'vabr', 'efg', 'bytestart', 'byteend', '_nc_ht', '_nc_cat', '_nc_ohc', '_nc_rid', '_nc_sid', 'ccb', 'tag', 'container', 'containers']);
  function fbCanonHostInline(h) {
    try {
      h = String(h || '').toLowerCase().replace(/\.$/, '');
      if (/\.fbcdn\.net$/i.test(h)) return 'fbcdn.net';
      if (/cdninstagram\.com$/i.test(h)) return 'cdninstagram.com';
      return h;
    } catch { return String(h || '').toLowerCase(); }
  }
  // Only PER-RENDITION fields of efg (bhak rotates per request — the raw
  // blob is what exploded one video into 99+ rows). Must stay byte-identical
  // to fbFileKey in content.js/background.js so the sent-matching aligns.
  function fbEfgTagInline(efg) {
    try {
      const s = String(efg);
      let obj = null;
      if (s.charAt(0) === '{') { try { obj = JSON.parse(s); } catch (e) {} }
      if (!obj) {
        let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        try { obj = JSON.parse(atob(b64)); } catch (e) { obj = null; }
      }
      if (!obj || typeof obj !== 'object') return null;
      const bits = [];
      if (obj.encode_tag != null) bits.push('tag:' + obj.encode_tag);
      if (obj.itag != null) bits.push('itag:' + obj.itag);
      if (obj.xw != null && obj.yh != null) bits.push('res:' + obj.xw + 'x' + obj.yh);
      return bits.length ? bits.join(',') : null;
    } catch (e) { return null; }
  }
  // Facebook split-AV (mirrors fbTrackKindOfUrl/fbVideoIdOfUrl in content.js).
  // Audio-only DASH track → 'audio'; video-only DASH track → 'video'.
  function fbEfgObjInline(efg) {
    try {
      const s = String(efg);
      let obj = null;
      if (s.charAt(0) === '{') { try { obj = JSON.parse(s); } catch (e) {} }
      if (!obj) {
        let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        try { obj = JSON.parse(atob(b64)); } catch (e) { obj = null; }
      }
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) { return null; }
  }
  function fbTrackKindOfUrlInline(u) {
    try {
      const efg = new URL(String(u || '')).searchParams.get('efg');
      const obj = fbEfgObjInline(efg);
      if (!obj) return null;
      const tag = String(obj.encode_tag || '');
      if (!tag) return null;
      return /audio/i.test(tag) ? 'audio' : 'video';
    } catch (e) { return null; }
  }
  function fbVideoIdOfUrlInline(u) {
    try {
      const efg = new URL(String(u || '')).searchParams.get('efg');
      const obj = fbEfgObjInline(efg);
      return (obj && obj.video_id != null) ? String(obj.video_id) : null;
    } catch (e) { return null; }
  }
  function fbKeyInline(u) {
    try {
      const x = new URL(String(u || '').trim());
      x.hash = '';
      x.hostname = fbCanonHostInline(x.hostname);
      let tail = x.pathname || '';
      const efg = x.searchParams.get('efg');
      if (efg) {
        const parsedEfg = fbEfgTagInline(efg);
        if (parsedEfg) tail += '|efg=' + parsedEfg;
      }
      if (/fbcdn\.net$/i.test(x.hostname) || /cdninstagram\.com$/i.test(x.hostname)) {
        const q = x.searchParams.get('vabr') || x.searchParams.get('rl') || '';
        if (q) tail += '|q=' + q;
      }
      return x.protocol + '//' + x.hostname + tail;
    } catch { return null; }
  }
  const FB_INLINE_RE = /fbcdn\.net|scontent\.|facebook\.com|fb\.com|instagram\.com|cdninstagram\.com/i;
  function normalizeInline(u) {
    try {
      if (FB_INLINE_RE.test(String(u || ''))) {
        const fk = fbKeyInline(u);
        if (fk) return 'fb:' + fk;
      }
    } catch {}
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
