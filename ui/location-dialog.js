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

  const CAT_LABEL = {
    video: '🎬 Video', audio: '🎵 Music', document: '📄 Document',
    archive: '📦 Archive', software: '💿 Software', image: '🖼️ Image', other: '📁 Other',
  };

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
    filenameEl.focus();
    selectStem();
    setHint('Pasted — press Enter or Start Download.');
  });

  el('ld-reset').addEventListener('click', () => {
    filenameEl.value = payload ? (payload.filename || '') : '';
    filenameEl.focus();
    selectStem();
    setHint('Restored the detected file name.');
  });

  filenameEl.addEventListener('focus', selectStem);
  filenameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  });
  savePathEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  // ── Data from the main process ────────────────────────────────────────────
  api.init((data) => {
    payload = data || {};
    catEl.textContent = CAT_LABEL[payload.category] || '📁 File';
    filenameEl.value = payload.filename || '';
    savePathEl.value = payload.suggestedPath || payload.savePath || '';
    rememberEl.checked = false;
    el('ld-badge').textContent = 'AiDM · waiting for a location';
    setHint('Renaming is applied before the first byte is written.');
    // Focus the file name so typing works immediately (no focus-stealing loop:
    // this happens once, when the dialog is created).
    setTimeout(() => { filenameEl.focus(); selectStem(); }, 30);
  });
})();
