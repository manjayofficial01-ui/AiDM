/**
 * AiDM Chrome Extension - Background Service Worker v2
 * Intercepts ALL browser downloads and routes them to AiDM
 * Detects video streams with quality/resolution/size metadata
 */

const AIDM_API = 'http://127.0.0.1:18765';
let isConnected = false;
let interceptedCount = 0;
let settings = { askLocationEveryTime: false, categoryPaths: {} };

// ── Stream sniffing (webRequest) ─────────────────────────────────────────────
// Catches manifests / media that page-level scans miss: players (Nubiles,
// Xtream, …) load .m3u8/.mp4 over XHR/fetch with no plain <video src>.
const STREAM_REQ_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|ts|m4s|key|akamai)($|\?|#)/i;
const STREAM_PATH_RE = /videoplayback|\/live\/|\/movie\/|\/series\/|\/hls\/|\/get_file\/|\/mp4\/|\.akamaihd\.net|\/secure\/|\/videos?\//i;

const tabStreams = new Map(); // tabId -> [{ url, time }]
const STREAM_KEEP_MS = 10 * 60 * 1000;
const STREAM_MAX = 80;

function noteTabStream(tabId, url) {
  if (tabId == null || tabId < 0 || !url || !/^https?:/i.test(url)) return;
  if (url.startsWith(AIDM_API)) return;
  let list = tabStreams.get(tabId);
  if (!list) { list = []; tabStreams.set(tabId, list); }
  if (list.some(e => e.url === url)) return;
  list.unshift({ url, time: Date.now() });
  if (list.length > STREAM_MAX) list.length = STREAM_MAX;
}

try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const u = details.url || '';
      // Capture media resources and anything matching a streaming path.
      if (details.type === 'media' || STREAM_REQ_RE.test(u) || STREAM_PATH_RE.test(u)) {
        noteTabStream(details.tabId, u);
      }
    },
    { urls: ['<all_urls>'] }
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const u = details.url || '';
      if (!u || !/^https?:/i.test(u) || u.startsWith(AIDM_API)) return;
      if (details.responseHeaders) {
        for (const h of details.responseHeaders) {
          if (h.name.toLowerCase() === 'content-type') {
            const ct = (h.value || '').toLowerCase();
            if (ct.startsWith('video/') || ct.startsWith('audio/') ||
                ct.includes('application/vnd.apple.mpegurl') ||
                ct.includes('application/x-mpegurl') ||
                ct.includes('application/dash+xml')) {
              noteTabStream(details.tabId, u);
            }
            break;
          }
        }
      }
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
  );
} catch (e) { /* webRequest unavailable — page scan still works */ }

try {
  chrome.tabs.onRemoved.addListener((tabId) => { tabStreams.delete(tabId); });
} catch (e) {}

function getTabStreams(tabId) {
  const now = Date.now();
  return (tabStreams.get(tabId) || [])
    .filter(e => now - e.time < STREAM_KEEP_MS)
    .map(e => e.url);
}

// ── Already-sent tracking (dedup) ────────────────────────────────────────────
// URLs handed to AiDM (exact + token-normalized) so the capsule/popup stop
// offering them and the manager never stacks a duplicate row.
const TOKEN_PARAMS = new Set([
  'token', 'tokens', 'sig', 'signature', 'sign', 'expires', 'expiry', 'exp',
  'e', 'h', 'hdnea', 'hdntl', 'hdnts', 'st', 'key', 'auth', 'authkey',
  'wmsauthsign', 'mst', 'access_token', 'token_expires', 'session', 'sid',
  'policy', 'token_hash', 'verify', 'md5', 't', 'ts', '_',
]);

function normalizeSentUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    x.hash = '';
    x.hostname = x.hostname.toLowerCase();
    const params = Array.from(x.searchParams.entries())
      .filter(([k]) => !TOKEN_PARAMS.has(k.toLowerCase()));
    params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    const qs = new URLSearchParams();
    params.forEach(([k, v]) => qs.append(k, v));
    x.search = qs.toString();
    return x.toString();
  } catch {
    return null;
  }
}

const sentExact = new Set();
const sentNorm = new Set();
const SENT_MAX = 1000;

function markSent(url) {
  if (!url) return;
  sentExact.add(url);
  const n = normalizeSentUrl(url);
  if (n) sentNorm.add(n);
  if (sentExact.size > SENT_MAX) sentExact.delete(sentExact.values().next().value);
  if (sentNorm.size > SENT_MAX) sentNorm.delete(sentNorm.values().next().value);
}

function isSent(url) {
  if (!url) return false;
  if (sentExact.has(url)) return true;
  const n = normalizeSentUrl(url);
  return !!n && sentNorm.has(n);
}

// ── Connection & Settings ─────────────────────────────────────────────────────

async function checkConnection() {
  try {
    const resp = await fetch(`${AIDM_API}/api/status`, { signal: AbortSignal.timeout(2000) });
    const data = await resp.json();
    isConnected = data.status === 'running';
    if (data.settings) settings = data.settings;
    updateBadge();
    return isConnected;
  } catch {
    isConnected = false;
    updateBadge();
    return false;
  }
}

function updateBadge() {
  if (isConnected) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
  } else {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f87171' });
  }
}

// ── Download to AiDM ──────────────────────────────────────────────────────────

async function sendToAiDM(url, filename, opts = {}) {
  if (!url) return { sent: false, success: false };
  if (isSent(url)) return { sent: false, success: true, duplicate: true };
  try {
    const body = { url, filename, ...opts };
    // Replay headers so anti-hotlink (Referer) checks on the desktop pass
    if (!body.headers) {
      const pageUrl = opts.pageUrl || (opts.meta && opts.meta.pageUrl);
      if (pageUrl) body.headers = { Referer: pageUrl };
    }
    // Attach session cookies for authenticated downloads (KVS /get_file/ etc.)
    if (!body.cookies) {
      try {
        const videoHost = new URL(url).hostname;
        const cookies = await chrome.cookies.getAll({ domain: videoHost });
        if (cookies && cookies.length) {
          body.cookies = cookies.map(c => c.name + '=' + c.value).join('; ');
        }
      } catch (e) { /* cookies API unavailable or blocked */ }
    }
    // Always attach a Referer (anti-hotlink). Prefer page URL, then the media
    // origin itself so the CDN accepts the request.
    if (!body.headers || !body.headers.Referer) {
      const ref = (opts.pageUrl || (opts.meta && opts.meta.pageUrl) ||
                   ((opts.headers && opts.headers.Referer) || new URL(url).origin + '/'));
      body.headers = Object.assign({}, body.headers, { Referer: ref });
    }
    const resp = await fetch(`${AIDM_API}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (data.success) {
      if (!data.duplicate) interceptedCount++;
      markSent(url);
      return { sent: !data.duplicate, success: true, duplicate: !!data.duplicate };
    }
    return { sent: false, success: false };
  } catch {
    return { sent: false, success: false };
  }
}

async function sendBatchToAiDM(urls) {
  try {
    const resp = await fetch(`${AIDM_API}/api/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    (data.downloads || []).forEach(d => { if (d && d.url && !d.error) markSent(d.url); });
    return data.success;
  } catch {
    return false;
  }
}

async function sendVideoDetection(videoData) {
  try {
    const resp = await fetch(`${AIDM_API}/api/video-detected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(videoData),
      signal: AbortSignal.timeout(5000),
    });
    return await resp.json();
  } catch {
    return null;
  }
}

// ── Intercept ALL Chrome Downloads ────────────────────────────────────────────
// This is the key change: intercept every download, not just filtered ones.
// AiDM becomes the system's download manager, just like IDM.

chrome.downloads.onDeterminingFilename.addListener(async (downloadItem, suggest) => {
  if (!isConnected) await checkConnection();

  if (isConnected) {
    // Cancel Chrome's native download and route to AiDM
    chrome.downloads.cancel(downloadItem.id);
    chrome.downloads.erase({ id: downloadItem.id });

    const sent = await sendToAiDM(
      downloadItem.finalUrl || downloadItem.url,
      downloadItem.filename,
      {
        referrer: downloadItem.referrer,
        fileSize: downloadItem.fileSize,
        mime: downloadItem.mime,
      }
    );

    if (sent && sent.sent) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: 'AiDM',
        message: `Download started: ${downloadItem.filename}`,
      });
      return;
    }
    if (sent && sent.duplicate) {
      // Already in the AiDM list — don't stack a duplicate anywhere
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: 'AiDM',
        message: `Already in AiDM: ${downloadItem.filename}`,
      });
      return;
    }
    // If AiDM failed, let Chrome handle it normally
  }

  suggest({ filename: downloadItem.filename });
});

// ── Context Menus ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'aidm-download-link',
    title: '⬇️ Download with AiDM',
    contexts: ['link'],
  });

  chrome.contextMenus.create({
    id: 'aidm-download-video',
    title: '🎬 Download video with AiDM',
    contexts: ['video', 'audio'],
  });

  chrome.contextMenus.create({
    id: 'aidm-download-image',
    title: '🖼️ Download image with AiDM',
    contexts: ['image'],
  });

  chrome.contextMenus.create({
    id: 'aidm-download-all',
    title: '📋 Download all links with AiDM',
    contexts: ['page', 'selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'aidm-download-link') {
    await sendToAiDM(info.linkUrl, extractFilename(info.linkUrl));
  } else if (info.menuItemId === 'aidm-download-video') {
    const url = info.srcUrl || info.linkUrl;
    await sendToAiDM(url, extractFilename(url));
  } else if (info.menuItemId === 'aidm-download-image') {
    await sendToAiDM(info.srcUrl, extractFilename(info.srcUrl));
  } else if (info.menuItemId === 'aidm-download-all') {
    chrome.tabs.sendMessage(tab.id, { action: 'collect-links' });
  }
});

// ── Message Handling ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'batch-download') {
    sendBatchToAiDM(msg.urls).then(success => sendResponse({ success }));
    return true;
  }

  if (msg.action === 'single-download') {
    sendToAiDM(msg.url, msg.filename, msg.opts).then(r => sendResponse({ success: !!(r && r.success), duplicate: !!(r && r.duplicate) }));
    return true;
  }

  if (msg.action === 'check-connection') {
    checkConnection().then(connected => {
      sendResponse({ connected, intercepted: interceptedCount, settings });
    });
    return true;
  }

  if (msg.action === 'video-detected') {
    // Forward video detection with quality metadata to AiDM desktop
    sendVideoDetection(msg.data).then(result => {
      sendResponse({ ok: true, result });
    });
    return true;
  }

  if (msg.action === 'videos-with-quality') {
    // Content script found videos with quality variants
    sendVideoDetection({
      pageTitle: msg.pageTitle,
      pageUrl: msg.pageUrl,
      videos: msg.videos,
    }).then(result => {
      sendResponse({ ok: true, result });
    });
    return true;
  }

  // One round-trip for the capsule/popup: recent tab streams + sent URLs
  if (msg.action === 'get-panel-data') {
    const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
    sendResponse({ streams: getTabStreams(tabId), sent: [...sentExact].slice(-500) });
    return false;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    let name = pathname.split('/').pop();
    if (!name || name === '/') name = 'download';
    return decodeURIComponent(name);
  } catch {
    return 'download';
  }
}

// Periodic connection check
setInterval(checkConnection, 30000);
checkConnection();
