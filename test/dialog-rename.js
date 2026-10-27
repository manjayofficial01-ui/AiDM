// Regression harness for the user report:
// "i can't rename the downloading file at downloading dialogue window."
//
// The dialog's rename itself always flowed (approveDownload → _userNamed →
// the row is renamed before the first byte is written). What silently
// UN-did it: downloads that learn the real name from the response itself
// (single-use-token Gmail/Drive attachment flows, skipProbe) had the
// engine's finalize step apply the response's Content-Disposition name
// UNCONDITIONALLY — after the user had already chosen a name in the dialog,
// the file on disk was retargeted back to the server's name while the row
// kept the user's choice. To the user that is exactly "I can't rename".
//
// Fix under test: the manager forwards `nameLocked` for _userNamed rows; the
// engine task then never applies its _responseName (task.js finalize). The
// 'name' event still fires — the manager's download-name listener already
// stands down for _userNamed rows, so row and file stay consistent.
//
// Run: node test/dialog-rename.js
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// DownloadManager reads/writes settings + state under USERPROFILE — point it
// at a scratch dir BEFORE requiring the module.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-dialog-rename-profile-'));
process.env.USERPROFILE = PROFILE;
process.env.HOME = PROFILE;

const { DownloadTask } = require('../src/engine/task');
const { DownloadManager } = require('../src/download-manager');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-dialog-rename-'));

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function drain(server) {
  return new Promise((r) => {
    server.close();
    server.closeAllConnections?.();
    server.once('close', r);
  });
}

const PAYLOAD = Buffer.alloc(180 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i & 0xFF;
const CD_NAME = 'Invoice Q4 2026.pdf';

(async () => {
  console.log('\n── 1. the dialog rename sticks (manager contract, pure) ──');
  {
    const mgr = new DownloadManager();
    // The ask-every-time flow is what raises the location dialog.
    mgr.settings.askLocationEveryTime = true;
    const dl = mgr.addDownload({ url: 'https://cdn.test/files/report.pdf' });
    check('row waits for a location', dl.status === 'pending-approval', dl.status);
    const chosenDir = path.join(TMP, 'chosen');
    fs.mkdirSync(chosenDir, { recursive: true });
    mgr.approveDownload(dl.id, chosenDir, 'My Exact Name.pdf');
    check('row renamed to the typed name', dl.filename === 'My Exact Name.pdf', dl.filename);
    check('row marked user-named', dl._userNamed === true);
    check('filepath follows the rename',
      dl.filepath === path.join(chosenDir, 'My Exact Name.pdf'), dl.filepath);
    check('category follows the rename', dl.category === 'pdf', dl.category);
    // Authority contract: the server's Content-Disposition must not override
    // an explicitly chosen name.
    mgr._refineFilename(dl, { suggestedFilename: CD_NAME, contentType: 'application/pdf' });
    check('server name never overrides the typed name', dl.filename === 'My Exact Name.pdf', dl.filename);
    // A typed name that LOOKS generic ("video.mp4") is still the user's
    // choice — the probe's refine used to replace it with the server's name
    // (the curGeneric escape hatch), which reverted the dialog rename.
    const dlGen = mgr.addDownload({ url: 'https://cdn.test/files/gen.pdf' });
    mgr.approveDownload(dlGen.id, chosenDir, 'video.mp4');
    check('typed generic name is marked user-named', dlGen._userNamed === true);
    mgr._refineFilename(dlGen, { suggestedFilename: CD_NAME, contentType: 'application/pdf' });
    check('server name never overrides a generic-looking typed name',
      dlGen.filename === 'video.mp4', dlGen.filename);
    // A typed name with no extension keeps its stem; only the container the
    // server reported may be appended (never the server's full name).
    const dlBare = mgr.addDownload({ url: 'https://cdn.test/files/bare.pdf' });
    mgr.approveDownload(dlBare.id, chosenDir, 'My Holiday Video');
    mgr._refineFilename(dlBare, { suggestedFilename: CD_NAME, contentType: 'application/pdf' });
    check('extensionless typed name keeps its stem',
      dlBare.filename === 'My Holiday Video.pdf', dlBare.filename);
    // Without a user choice, the generic-name replacement still applies (the
    // v5.6.x "real server name wins" feature this guard must not break).
    const dlAuto = mgr.addDownload({ url: 'https://cdn.test/files/videoplayback' });
    check('auto generic row is not user-named', !dlAuto._userNamed);
    mgr._refineFilename(dlAuto, { suggestedFilename: CD_NAME, contentType: 'application/pdf' });
    check('server name still refines a generic auto row',
      dlAuto.filename === CD_NAME, dlAuto.filename);
    // The lock survives persistence (a restart + resume keeps it).
    mgr._persistDownloads(true);
    const saved = JSON.parse(fs.readFileSync(mgr._getStatePath(), 'utf8'));
    const row = Array.isArray(saved) && saved.find((d) => d.id === dl.id);
    check('the lock is persisted (survives a restart)', !!(row && row._userNamed === true));
    // Confirming the DETECTED name unchanged leaves refinement allowed (the
    // v5.6.x feature: the real Gmail name reaches the dialog and is applied).
    const dl2 = mgr.addDownload({ url: 'https://cdn.test/files/other.pdf' });
    mgr.approveDownload(dl2.id, chosenDir, dl2.filename);
    check('unchanged confirmation keeps refinement allowed', dl2._userNamed !== true);
    mgr.removeAllListeners?.();
  }

  console.log('\n── 2. nameLocked: the engine never retargets a user-chosen file ──');
  {
    const names = [];
    const { server, port } = await startServer((req, res) => {
      if (req.url.startsWith('/entry')) {
        res.writeHead(302, { Location: '/one-shot?t=3' });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="' + CD_NAME + '"',
        'Content-Length': PAYLOAD.length,
      });
      res.end(PAYLOAD);
    });
    try {
      const outDir = path.join(TMP, 'locked');
      fs.mkdirSync(outDir, { recursive: true });
      const task = new DownloadTask({
        url: `http://127.0.0.1:${port}/entry?ui=2&attid=0.1&view=att`,
        directory: outDir,
        filename: 'My Renamed File.pdf',   // what the user typed in the dialog
        skipProbe: true,                   // the single-use-token flow
        singleConnection: true,
        resumable: false,
        nameLocked: true,                  // the manager sets this for _userNamed rows
        onConflict: 'rename',
      });
      task.on('name', (info) => names.push(info.filename));
      await task.start();

      const userPath = path.join(outDir, 'My Renamed File.pdf');
      const cdPath = path.join(outDir, CD_NAME);
      check("the file lands under the user's name", fs.existsSync(userPath));
      check("no second file under the server's name", !fs.existsSync(cdPath));
      check("bytes intact under the user's name",
        fs.existsSync(userPath) && fs.statSync(userPath).size === PAYLOAD.length);
      check("task reports the user's path", task.finalPath === userPath, task.finalPath);
      check('the name event still fires (row/dialog may show it)',
        names.length === 1 && names[0] === CD_NAME, JSON.stringify(names));
      check('task completed', task.state === 'completed', task.state);

      // Control (same server, no lock): the response name still applies —
      // that is the v5.6.x feature this guard must NOT break.
      const outDir2 = path.join(TMP, 'unlocked');
      fs.mkdirSync(outDir2, { recursive: true });
      const task2 = new DownloadTask({
        url: `http://127.0.0.1:${port}/entry?ui=2&attid=0.2&view=att`,
        directory: outDir2,
        filename: 'Gmail attachment',       // the honest placeholder
        skipProbe: true,
        singleConnection: true,
        resumable: false,
        onConflict: 'rename',
      });
      await task2.start();
      check('without the lock the response name still applies',
        fs.existsSync(path.join(outDir2, CD_NAME)) &&
        task2.finalPath === path.join(outDir2, CD_NAME), task2.finalPath);
    } finally {
      await drain(server);
    }
  }

  console.log('\n── 3. wiring: the lock reaches the engine ──');
  {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
    const mgrSrc = read('download-manager.js');
    check('manager forwards nameLocked for user-named rows',
      /nameLocked:\s*download\._userNamed\s*===\s*true/.test(mgrSrc));
    check('approveDownload marks user-authored names',
      /dl\._userNamed\s*=\s*true;/.test(mgrSrc));
    const engSrc = read('download-engine.js');
    check('engine wrapper threads nameLocked into the task',
      /nameLocked:\s*nameLocked\s*===\s*true/.test(engSrc));
    const taskSrc = read(path.join('engine', 'task.js'));
    check('task finalize stands down when the name is locked',
      /this\._responseName\s*&&\s*!this\.config\.nameLocked/.test(taskSrc));
    check('task config parses nameLocked',
      /nameLocked:\s*merged\.nameLocked\s*===\s*true/.test(taskSrc));
    const dlgSrc = read('location-dialog.js');
    check('the dialog confirm still carries the edited filename',
      /approveDownload\(item\.id,\s*result\.savePath,\s*result\.filename\)/.test(dlgSrc));
    const mgrSrc2 = read('download-manager.js');
    check('Drive resolver stands down for user-named rows',
      /resolved\.filename && !download\._userNamed/.test(mgrSrc2));
    check('refine never lets the server name through for user-named rows',
      /cdUsable && !dl\._userNamed/.test(mgrSrc2) &&
      !/curGeneric \|\| !dl\._userNamed/.test(mgrSrc2));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 2000).unref();
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
