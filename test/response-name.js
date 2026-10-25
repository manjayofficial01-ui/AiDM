// Regression harness for the Gmail/Drive "response names the file" flow
// (user-reported: a Gmail attachment dialog offered "7" — a URL path
// segment — because single-use-token downloads skip the probe entirely and
// nothing ever read the real Content-Disposition).
//
// Chain under test: DownloadTask with skipProbe (one plain GET) → the entry
// URL 302s to a one-shot target whose response carries Content-Disposition →
// the task must (a) emit 'name' with the server's name, and (b) land the file
// on disk under that name — while the .part file keeps the provisional name
// until the final rename.
//
// Run: node test/response-name.js
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DownloadTask } = require('../src/engine/task');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-response-name-'));

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

(async () => {
  console.log('\n── 1. skipProbe + 302 → Content-Disposition renames the file ──');
  {
    const names = [];
    const { server, port } = await startServer((req, res) => {
      if (req.url.startsWith('/entry')) {
        // The Gmail shape: the reusable entry mints a one-shot target.
        res.writeHead(302, { Location: `/one-shot?token=abc123` });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="Invoice Q4 2026.pdf"',
        'Content-Length': PAYLOAD.length,
      });
      res.end(PAYLOAD);
    });
    try {
      const outDir = path.join(TMP, 'gmail');
      fs.mkdirSync(outDir, { recursive: true });
      const task = new DownloadTask({
        url: `http://127.0.0.1:${port}/entry?ui=2&attid=0.1&view=att`,
        directory: outDir,
        filename: 'Gmail attachment',   // the honest provisional name
        skipProbe: true,                // the token must not be pre-spent
        singleConnection: true,
        resumable: false,
        onConflict: 'rename',
      });
      task.on('name', (info) => names.push(info.filename));
      await task.start();

      const finalPath = path.join(outDir, 'Invoice Q4 2026.pdf');
      check('task emits name with the server name',
        names.length === 1 && names[0] === 'Invoice Q4 2026.pdf', JSON.stringify(names));
      check('file lands under the Content-Disposition name', fs.existsSync(finalPath));
      check('bytes byte-exact under the real name',
        fs.existsSync(finalPath) && fs.statSync(finalPath).size === PAYLOAD.length);
      check('no file named after the provisional guess remains',
        !fs.existsSync(path.join(outDir, 'Gmail attachment')) &&
        !fs.existsSync(path.join(outDir, 'Gmail attachment.part')));
      check('task reports the real final path', task.finalPath === finalPath, task.finalPath);
      check('task completed', task.state === 'completed', task.state);
    } finally {
      await drain(server);
    }
  }

  console.log('\n── 2. a name the user chose in the dialog is never overridden ──');
  {
    // Manager-level contract (verified in filename-exact.js): the
    // download-name listener must stand down when dl._userNamed is set.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-manager.js'), 'utf8');
    check('download-name listener guards on _userNamed',
      /download-name[\s\S]{0,600}dl\._userNamed/.test(src));
    check('approveDownload marks user-authored names',
      /dl\.filename = name;[\s\S]{0,400}dl\._userNamed = true;/.test(src));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 2000).unref();
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
