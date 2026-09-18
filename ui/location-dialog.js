/* Renderer for the topmost "Choose Download Location" window.
 * The window is a real top-level OS window created by the main process, so it
 * can be pinned topmost without making the whole AiDM main window topmost.
 */
(function () {
  'use strict';

  const api = window.aidmLocation;
  if (!api) return;

  const el = (id) => document.getElementById(id);
  const filenameEl = el('ld-filename');
  const savePathEl = el('ld-savepath');
  const rememberEl = el('ld-remember');
  const hintEl = el('ld-hint');
  const catEl = el('ld-category');

  let payload = null;      // { id, filename, category, suggestedPath }
  let settled = false;     // guard: never answer twice
  let userEditedName = false;
  let userEditedPath = false;

  const CAT_LABEL = {
    video: '🎬 Video', audio: '🎵 Music', document: '📄 Document',
    archive: '📦 Archive', software: '💿 Software', image: '🖼️ Image', other: '📁 Other',
  };

  /** IDM-style size rendering: exact bytes, ~estimate, or fetching state. */
  function formatBytes(n) {
    if (n == null || !(n > 0)) return null;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n, u = -1;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[u];
  }

  function typeLabel() {
    const name = (payload && payload.filename) || '';
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
    const ext = m ? m[1].toUpperCase() : null;
    const ct = payload && payload.contentType;
    if (ext && ct && /^video\//i.test(ct)) return ext + ' Video';
    if (ext && ct && /^audio\//i.test(ct)) return ext + ' Audio';
    return ext ? ext + ' File' : null;
  }

  /** Render the URL + size block from the current payload. */
  function updateInfo() {
    const urlEl = el('ld-url');
    const sizeEl = el('ld-size');
    const typeEl = el('ld-type');
    if (urlEl) {
      const u = (payload && payload.url) || '';
      urlEl.textContent = u || '…';
      urlEl.title = u;
    }
    if (sizeEl) {
      const n = payload && payload.totalSize;
      const text = formatBytes(n);
      if (text) {
        sizeEl.textContent = '📦 ' + (payload.sizeEstimated ? '~' : '') + text;
        sizeEl.classList.remove('fetching');
        sizeEl.title = payload.sizeEstimated ? 'Estimated size' : 'Exact file size from the server';
      } else {
        sizeEl.textContent = 'Fetching file info…';
        sizeEl.classList.add('fetching');
        sizeEl.title = '';
      }
    }
    if (typeEl) {
      const t = typeLabel();
      if (t) { typeEl.textContent = t; typeEl.style.display = ''; }
      else typeEl.style.display = 'none';
    }
  }

  function setHint(msg, warn) {
    hintEl.textContent = msg || '';
    hintEl.classList.toggle('warn', !!warn);
  }

  function selectStem() {
    const v = filenameEl.value || '';
    const dot = v.lastIndexOf('.');
    try {
      filenameEl.setSelectionRange(0, dot > 0 ? dot : v.length);
    } catch (e) { /* no-op */ }
  }

  async function confirm() {
    if (settled || !payload) return;
    const savePath = (savePathEl.value || '').trim();
    if (!savePath) {
      setHint('Choose a folder first (or press Cancel).', true);
      savePathEl.focus();
      return;
    }
    let filename = (filenameEl.value || '').trim();
    if (!filename) {
      filename = payload.filename || '';
      filenameEl.value = filename;
      if (!filename) { setHint('A file name is required.', true); return; }
      setHint('File name was empty — using the detected name.', true);
    }
    settled = true;
    try {
      await api.confirm({
        id: payload.id,
        savePath,
        filename,
        remember: !!rememberEl.checked,
        category: payload.category || '',
      });
    } catch (e) { /* main process owns the outcome */ }
  }

  function cancel() {
    if (settled) return;
    settled = true;
    try { api.cancel(); } catch (e) { /* no-op */ }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  el('ld-ok').addEventListener('click', confirm);
  el('ld-cancel').addEventListener('click', cancel);
  el('ld-close').addEventListener('click', cancel);

  el('ld-browse').addEventListener('click', async () => {
    try {
      const folder = await api.browse();
      if (folder) {
        savePathEl.value = folder;
        setHint('Folder selected.');
      }
    } catch (e) {
      setHint('Could not open the folder picker.', true);
    }
  });

  el('ld-paste').addEventListener('click', async () => {
    let text = '';
    try { text = (await api.readClipboard()) || ''; } catch (e) { text = ''; }
    text = String(text).trim();
    if (!text) { setHint('Clipboard is empty or holds no text.', true); return; }
    const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    if (slash >= 0) text = text.slice(slash + 1);
    const q = text.indexOf('?');
    if (q > 0) text = text.slice(0, q);
    try { text = decodeURIComponent(text); } catch (e) { /* keep as pasted */ }
    if (!text) { setHint('Clipboard is empty or holds no text.', true); return; }
    filenameEl.value = text;
    userEditedName = true;
    filenameEl.focus();
    selectStem();
    setHint('Pasted — press Enter or Start Download.');
  });

  el('ld-reset').addEventListener('click', () => {
    filenameEl.value = payload ? (payload.filename || '') : '';
    userEditedName = false;
    filenameEl.focus();
    selectStem();
    setHint('Restored the detected file name.');
  });

  el('ld-default').addEventListener('click', () => {
    if (payload && payload.defaultPath) {
      savePathEl.value = payload.defaultPath;
      userEditedPath = false;
      setPathHint();
      setHint('Reset to the default download location.');
    }
  });

  filenameEl.addEventListener('focus', selectStem);
  filenameEl.addEventListener('input', () => { userEditedName = true; });
  filenameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  });
  savePathEl.addEventListener('input', () => { userEditedPath = true; });
  savePathEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  function setPathHint() {
    const isDefault = !userEditedPath &&
      payload && payload.defaultPath && savePathEl.value === payload.defaultPath;
    el('ld-pathhint').textContent = isDefault
      ? 'Default download location — change it only if you want to.'
      : 'Pick a different folder with Browse…, or ↺ Default.';
  }
  savePathEl.addEventListener('input', setPathHint);

  // A patch can land before `location-init` (probe won beat the window load).
  // Buffer it so the initial render still picks it up instead of dropping it.
  let pendingPatch = null;

  // ── Data from the main process ────────────────────────────────────────────
  api.init((data) => {
    payload = data || {};
    catEl.textContent = CAT_LABEL[payload.category] || '📁 File';
    filenameEl.value = payload.filename || '';
    savePathEl.value = payload.suggestedPath || payload.savePath || payload.defaultPath || '';
    rememberEl.checked = false;
    updateInfo();
    el('ld-badge').textContent = 'AiDM · waiting for a location';
    setHint('Renaming is applied before the first byte is written.');
    setPathHint();
    if (pendingPatch && pendingPatch.id === payload.id) {
      const buffered = pendingPatch;
      pendingPatch = null;
      applyPatch(buffered);
    }
    // Focus the file name so typing works immediately (no focus-stealing loop:
    // this happens once, when the dialog is created).
    setTimeout(() => { filenameEl.focus(); selectStem(); }, 30);
  });

  // Live field updates (e.g. the file name/size learned from the server after
  // the dialog was requested). Never overwrite what the user has already typed.
  function applyPatch(patch_) {
    if (patch_.filename && !userEditedName) {
      filenameEl.value = patch_.filename;
      payload.filename = patch_.filename;
      setHint('File name detected from the source.');
      updateInfo(); // type badge derives from the extension
      setTimeout(() => filenameEl.focus() && selectStem(), 0);
    }
    if (patch_.savePath && !userEditedPath) {
      savePathEl.value = patch_.savePath;
      setPathHint();
    }
    // Live file-info refinement (size probe landed after the dialog opened).
    // Size is never user-edited, so it always applies.
    let infoChanged = false;
    if (typeof patch_.totalSize === 'number' && patch_.totalSize > 0) {
      payload.totalSize = patch_.totalSize;
      infoChanged = true;
    }
    if (typeof patch_.sizeEstimated === 'boolean') {
      payload.sizeEstimated = patch_.sizeEstimated;
      infoChanged = true;
    }
    if (typeof patch_.contentType === 'string' && patch_.contentType) {
      payload.contentType = patch_.contentType;
      infoChanged = true;
    }
    if (infoChanged) updateInfo();
  }

  api.onPatch((patch_) => {
    if (!patch_) return;
    if (!payload || !payload.id) { pendingPatch = patch_; return; }
    if (patch_.id !== payload.id) return;
    applyPatch(patch_);
  });
})();
