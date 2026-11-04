// Regression harness: "Download failed: An object could not be cloned."
//
// Rows carry live scratch fields, and `_probePromise` is a real Promise —
// structured clone (Electron's IPC serializer) can never serialize a
// Promise, so every IPC payload that touched a probed row failed wholesale:
// intermittent "Download failed" toasts on add (the add-download handler
// returns the row), and a permanently dead list after F5 / window reload
// mid-session (get-downloads boot fetch). The UI hid most of it because
// progress flows through push events, but any refresh hit the wall.
//
// Fix under test: download-manager.rowForIpc() — the single sanitizer every
// row-shaped IPC boundary (get-downloads, add-download return, pause/resume/
// approve returns, the main.js event forwarder) now applies. The live row
// must come out untouched so authenticated replay keeps working.
//
// Run: node test/ipc-row-sanitize.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// DownloadManager reads/writes settings + state under USERPROFILE — point it
// at a scratch dir BEFORE requiring the module.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-ipc-row-profile-'));
process.env.USERPROFILE = PROFILE;
process.env.HOME = PROFILE;

const { DownloadManager } = require('../src/download-manager');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const mgr = new DownloadManager();

// A row in the exact state that used to break IPC: probe in flight (Promise
// attached), session cookies + replay headers present, speed samples live.
const live = {
  id: 'row-1',
  url: 'https://cdn.example.com/video/1080.mp4',
  filename: 'video_1080.mp4',
  status: 'downloading',
  category: 'video',
  savePath: path.join(PROFILE, 'Downloads'),
  filepath: path.join(PROFILE, 'Downloads', 'video_1080.mp4'),
  totalSize: 12345678,
  downloaded: 42,
  cookies: { sid: 'session-secret' },
  headers: { Cookie: 'sid=session-secret', Referer: 'https://cdn.example.com/' },
  meta: { contentType: 'video/mp4', cookies: { inner: 'secret' } },
  _probe: { contentType: 'video/mp4' },
  _normUrl: 'https://cdn.example.com/video/1080.mp4',
  _nameResolved: true,
  _customPath: null,
  _speedSamples: [1, 2, 3],
  _probePromise: Promise.resolve({ kind: 'file', meta: null, hlsSize: null }),
};

console.log('── rowForIpc ──');
const view = mgr.rowForIpc(live);

// THE regression: the sanitized view must survive a structured clone —
// Electron's IPC does exactly this on every handler return / send.
let cloned = null, cloneErr = null;
try { cloned = structuredClone(view); } catch (e) { cloneErr = e; }
check('sanitized view survives structuredClone', !!cloned, cloneErr ? cloneErr.message : '');

check('live Promise stripped (_probePromise)', view._probePromise === undefined && !('_probePromise' in view));
check('probe scratch stripped (_probe)', view._probe === undefined);
check('norm-url scratch stripped (_normUrl)', view._normUrl === undefined);
check('speed samples stripped (_speedSamples)', view._speedSamples === undefined);
check('session cookies stripped (top level)', view.cookies === undefined);
check('Cookie header stripped, benign header kept',
  view.headers && !view.headers.Cookie && view.headers.Referer === 'https://cdn.example.com/');
check('cookies scrubbed inside nested meta',
  view.meta && !view.meta.cookies && view.meta.contentType === 'video/mp4');
check('public fields preserved',
  view.id === 'row-1' && view.url === live.url && view.filename === 'video_1080.mp4'
    && view.status === 'downloading' && view.totalSize === 12345678);
check('headers/meta survive as objects (null, not missing)',
  typeof view.headers === 'object' && typeof view.meta === 'object');

console.log('── live row untouched ──');
check('live row keeps its cookies (authenticated replay)', live.cookies && live.cookies.sid === 'session-secret');
check('live row keeps its Promise', typeof live._probePromise.then === 'function');
check('live row keeps scratch fields', live._speedSamples.length === 3 && live._normUrl === live.url);

console.log('── edge cases ──');
check('primitive passthrough: null', mgr.rowForIpc(null) === null);
check('primitive passthrough: string', mgr.rowForIpc('id-only') === 'id-only');
check('resolveFailed-style plain object untouched by row guard shape',
  mgr.rowForIpc({ resolveFailed: true, error: 'no file' }).resolveFailed === true);

// A get-downloads-shaped mapping of many rows must clone wholesale.
let listCloneErr = null;
try { structuredClone([mgr.rowForIpc(live), mgr.rowForIpc({ ...live, id: 'row-2', _probePromise: null })]); }
catch (e) { listCloneErr = e; }
check('list mapping survives structuredClone', !listCloneErr, listCloneErr ? listCloneErr.message : '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
