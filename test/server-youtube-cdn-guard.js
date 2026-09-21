// Regression: a sniffed googlevideo URL must never become a download row.
//
// YouTube serves picture and sound as SEPARATE signed DASH tracks from
// googlevideo.com/videoplayback. They expire in minutes and need the player's
// own context, so replaying one through the native engine saves ~31 bytes and
// reports it as "100% complete" — the "AiDM downloaded my video but the file
// is 31 bytes" bug. The same googlevideo host also serves /generate_204
// (the player's connectivity probe — returns HTTP 204, 0 bytes when fetched
// naively), /initplayback, and any other player endpoint; none of them are
// files. `POST /api/download` must now reroute (watch page → yt-dlp → real
// merged qualities) or refuse, for the WHOLE googlevideo.com host. It must
// never add a plain row.
//
// Only the refuse path is exercised over HTTP — the reroute path needs the
// network and yt-dlp, and belongs to the live check, not the suite.
// Run: node test/server-youtube-cdn-guard.js
'use strict';
const http = require('http');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const server = require('../src/server.js');
const { isYouTubeMediaUrl, youtubePageUrlFor } = server;

// ── isYouTubeMediaUrl ───────────────────────────────────────────────────────
console.log('── isYouTubeMediaUrl ──');
check('a real DASH track is caught',
  isYouTubeMediaUrl('https://rr11--sn-fap3ox25a-3uhy.googlevideo.com/videoplayback?expire=1&ei=x') === true);
check('the redirector path is caught too',
  isYouTubeMediaUrl('https://rr1---sn-abc.googlevideo.com/videoplayback/') === true);
// The user-visible bug: a sniffed /generate_204 reaches /api/download with
// a pageUrl, the OLD guard missed it because it only matched /videoplayback,
// addDownload created a row, the engine returned HTTP 204, the row errored.
// The new guard must catch it.
check('the /generate_204 connectivity probe is caught',
  isYouTubeMediaUrl('https://rr11---sn-fapo3ox25a-3uhy.googlevideo.com/generate_204?foo=bar') === true);
check('the /initplayback endpoint is caught',
  isYouTubeMediaUrl('https://rr1---sn-abc.googlevideo.com/initplayback') === true);
check('any path on googlevideo.com is caught',
  isYouTubeMediaUrl('https://rr1---sn-abc.googlevideo.com/whatever/else') === true);
check('subdomain look-alikes are NOT caught (player-endpoint impersonation)',
  isYouTubeMediaUrl('https://googlevideo.com.evil.example/x') === false);
check('a WATCH page is NOT a CDN url (it must resolve, not download)',
  isYouTubeMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === false);
check('youtu.be is NOT a CDN url', isYouTubeMediaUrl('https://youtu.be/dQw4w9WgXcQ') === false);
check('an ordinary file CDN is untouched',
  isYouTubeMediaUrl('https://cdn.example.com/video.mp4') === false);
check('garbage does not throw', isYouTubeMediaUrl('not a url') === false);
check('empty does not throw', isYouTubeMediaUrl('') === false);

// ── youtubePageUrlFor ───────────────────────────────────────────────────────
console.log('── youtubePageUrlFor ──');
check('pageUrl wins',
  youtubePageUrlFor({ pageUrl: 'https://www.youtube.com/watch?v=abc12345678' }, {}) === 'https://www.youtube.com/watch?v=abc12345678');
check('meta.pageUrl is used',
  youtubePageUrlFor({ meta: { pageUrl: 'https://youtu.be/abc12345678' } }, {}) === 'https://youtu.be/abc12345678');
check('captured Referer is used',
  youtubePageUrlFor({}, { Referer: 'https://www.youtube.com/watch?v=xyz12345678' }) === 'https://www.youtube.com/watch?v=xyz12345678');
check('a bare CDN origin Referer resolves nothing (not resolvable)',
  youtubePageUrlFor({}, { Referer: 'https://www.youtube.com/' }) === null);
check('nothing usable → null', youtubePageUrlFor({}, {}) === null);
check('a non-YouTube pageUrl → null', youtubePageUrlFor({ pageUrl: 'https://example.com/v/1' }, {}) === null);
check('null body does not throw', youtubePageUrlFor(null, null) === null);

// ── POST /api/download refuses a CDN url ────────────────────────────────────
console.log('── POST /api/download refuses a googlevideo url ──');

const added = [];
const emitted = [];
const stubDm = {
  downloads: new Map(),
  getSettings: () => ({}),
  emit: (event, payload) => { emitted.push({ event, payload }); },
  addDownload: (opts) => { added.push(opts); return { id: 'stub', duplicate: false }; },
};

function post(port, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/download', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Generic POST helper for endpoints other than /api/download.
function postJson(port, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw: out });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  const srv = new server.IPCServer(stubDm);
  // Step off the default port so a running AiDM is never disturbed.
  srv.port = 19765;
  await new Promise((resolve, reject) => {
    srv.start();
    setTimeout(resolve, 400); // let listen() settle
    setTimeout(() => reject(new Error('server did not start')), 4000);
  });

  try {
    // The bug: a googlevideo track with no page to fall back on.
    const r1 = await post(srv.port, {
      url: 'https://rr11--sn-fap3ox25a-3uhy.googlevideo.com/videoplayback?expire=1',
      filename: 'rr11--sn-fap3ox25a-3uhy.mp4',
    });
    check('no download row is created', added.length === 0, 'added=' + added.length);
    check('the caller is told it failed', r1.body && r1.body.success === false);
    check('the response flags it as a YouTube CDN url', r1.body && r1.body.youtubeCdn === true);
    check('the message explains what is wrong',
      !!(r1.body && /31-byte|YouTube media stream/i.test(r1.body.error || '')),
      JSON.stringify(r1.body && r1.body.error));

    // The same bug class, a different googlevideo path: /generate_204 (the
    // player's connectivity probe). The OLD guard missed this because it only
    // matched /videoplayback; addDownload created a row, the engine got 204,
// the row errored. With the broadened guard:
    const r1b_noPage = await post(srv.port, {
      url: 'https://rr11---sn-fapo3ox25a-3uhy.googlevideo.com/generate_204',
      filename: 'generate_204',
    });
    check('no row is created for /generate_204 (no page url)', added.length === 0, 'added=' + added.length);
    check('/generate_204 without a page is refused outright',
      r1b_noPage.body && r1b_noPage.body.success === false && r1b_noPage.body.youtubeCdn === true);
    // With the page url the reroute path is the right answer — the broken
    // /generate_204 url is silently turned into a real quality list from
    // yt-dlp, never a plain row.
    const r1b_page = await post(srv.port, {
      url: 'https://rr11---sn-fapo3ox25a-3uhy.googlevideo.com/generate_204',
      filename: 'generate_204',
      meta: { pageUrl: 'https://www.youtube.com/watch?v=feWb9vUUlKU' },
    });
    check('/generate_204 + pageUrl reroutes to the quality picker (never a row)',
      r1b_page.body && r1b_page.body.success === true && r1b_page.body.rerouted === 'youtube');
    check('still no plain row was created from /generate_204', added.length === 0, 'added=' + added.length);

    // A normal file must still go straight through — the guard is not a
    // blanket block on /api/download.
    const r2 = await post(srv.port, { url: 'https://cdn.example.com/video.mp4', filename: 'v.mp4' });
    check('a normal url still downloads', r2.body && r2.body.success === true);
    check('exactly one row was added', added.length === 1, 'added=' + added.length);
    check('it is the normal url', added[0] && added[0].url === 'https://cdn.example.com/video.mp4');

    // ── Page URL routing (closes the "two dialogs for one click" gap) ──────
    // The HTTP API must route a YouTube page URL through the resolver
    // instead of saving the page HTML as a row, matching main.js's
    // add-download IPC. Otherwise the extension's auto-resolve and a
    // same-time POST both fire: one opens the quality picker, the other
    // creates a row that opens the location dialog — two dialogs, one click.

    // Mark the existing rows/emits so the page-URL assertions are local.
    const baseAdded = added.length;
    const baseEmits = emitted.length;
    const lastEmitted = (name) => {
      for (let i = emitted.length - 1; i >= 0; i--) {
        if (emitted[i].event === name) return emitted[i].payload;
      }
      return null;
    };

    // Page URL without ytFormat → resolve + emit video-detected, NO row.
    // We mock the resolver by temporarily hijacking it: not easy without
    // touching internals. Instead, use a URL that the resolver registry
    // recognises but that resolveMedia can't extract — the empty-qualities
    // branch.
    const r3 = await post(srv.port, {
      url: 'https://twitter.com/whatever/status/1234567890123456789',
      filename: 'tweet.html',
    });
    check('a Twitter page URL never becomes a plain row (no save-as-html)',
      added.length === baseAdded,
      'added delta=' + (added.length - baseAdded));
    check('either it resolved (emitted video-detected) or returned resolveFailed',
      (lastEmitted('video-detected') !== null) ||
      (r3.body && r3.body.resolveFailed === true));

    // Page URL WITH ytFormat → caller picked a quality; addDownload row.
    const r4 = await post(srv.port, {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      filename: 'rick.mp4',
      meta: {
        ytUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ytFormat: { formatId: '22', audioFormatId: '140', progressive: true },
        pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        provider: 'youtube',
      },
    });
    check('a page URL with ytFormat falls through to addDownload',
      r4.body && r4.body.success === true);
    check('exactly one new row was added for the ytFormat request',
      added.length === baseAdded + 1, 'added delta=' + (added.length - baseAdded));
    check('the new row carries the chosen ytFormat',
      added[added.length - 1] &&
      added[added.length - 1].meta &&
      added[added.length - 1].meta.ytFormat &&
      added[added.length - 1].meta.ytFormat.formatId === '22');
    // video-detected should NOT have been emitted for the ytFormat request
    // (caller picked already — emitting would open a SECOND picker for the
    // same row).
    const videoDetectedAfterYtFormat = emitted.slice(baseEmits).filter(e => e.event === 'video-detected');
    check('no spurious video-detected after the ytFormat row was created',
      videoDetectedAfterYtFormat.length === 0,
      'emitted=' + videoDetectedAfterYtFormat.length);

    // ── /api/batch must apply the SAME routing per URL ──────────────────────
    // The extension's collect-links and grab-site flows post a batch of
    // detected URLs to /api/batch. Without per-URL routing, a googlevideo
    // or YouTube-page URL in the batch becomes a plain row — exactly the
    // bug class the single endpoint already guards against.
    function postBatch(port, urls) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify({ urls });
        const req = http.request({
          host: '127.0.0.1', port, path: '/api/batch', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
          let out = '';
          res.on('data', (d) => { out += d.toString(); });
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(out) }); } catch (e) { resolve({ status: res.statusCode, body: null, raw: out }); }
          });
        });
        req.on('error', reject);
        req.end(data);
      });
    }
    const batchBeforeAdded = added.length;
    const rb = await postBatch(srv.port, [
      'https://rr11---sn-fapo3ox25a-3uhy.googlevideo.com/generate_204?foo',     // googlevideo → refused
      'https://cdn.example.com/legit.zip',                                       // plain file → row
      'https://cdn.example.com/legit2.zip',                                      // plain file → row
    ]);
    check('/api/batch returns one result per URL', rb.body && Array.isArray(rb.body.downloads) && rb.body.downloads.length === 3);
    check('googlevideo URL in a batch is refused (no row)',
      rb.body.downloads[0] && rb.body.downloads[0].youtubeCdn === true);
    check('plain files in a batch each create a row',
      added.length === batchBeforeAdded + 2, 'added delta=' + (added.length - batchBeforeAdded));
    check('batch success is reported at the envelope level',
      rb.body && rb.body.success === true);

    // ── /api/video-detected must filter googlevideo variants ────────────────
    // The extension forwards raw variant lists here. A googlevideo entry in
    // the picker is a dead click, so it is dropped — and a list that is
    // nothing but googlevideo must not open an empty picker at all.
    function postDetected(port, payload) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const req = http.request({
          host: '127.0.0.1', port, path: '/api/video-detected', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
          let out = '';
          res.on('data', (d) => { out += d.toString(); });
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(out) }); } catch (e) { resolve({ status: res.statusCode, body: null }); }
          });
        });
        req.on('error', reject);
        req.end(data);
      });
    }
    const emitsBeforeDetected = emitted.length;
    const rd = await postDetected(srv.port, {
      pageTitle: 't', pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      videos: [
        { url: 'https://rr11---sn-fapo3ox25a-3uhy.googlevideo.com/generate_204?foo', quality: '720p' },
        { url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?itag=137', quality: '1080p' },
        { url: 'https://cdn.example.com/real.mp4', quality: '480p' },
      ],
    });
    check('googlevideo variants are filtered out of video-detected',
      rd.body && rd.body.count === 1, 'count=' + (rd.body && rd.body.count));
    const detPayload = emitted.slice(emitsBeforeDetected).filter(e => e.event === 'video-detected').pop();
    check('the emitted payload keeps only the real file',
      detPayload && detPayload.payload && detPayload.payload.videos.length === 1 &&
      detPayload.payload.videos[0].url === 'https://cdn.example.com/real.mp4');

    const rd2 = await postDetected(srv.port, {
      pageTitle: 't', pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      videos: [
        { url: 'https://rr11---sn-fapo3ox25a-3uhy.googlevideo.com/generate_204?foo', quality: '720p' },
      ],
    });
    check('an all-googlevideo list yields count 0 (no empty picker)',
      rd2.body && rd2.body.count === 0, 'count=' + (rd2.body && rd2.body.count));
    check('and reports how many were filtered',
      rd2.body && rd2.body.filtered === 1);
  } finally {
    try { srv.stop(); } catch (e) { /* best effort */ }
  }

  // ── 7. POST /api/remove exists and clears a row by id ────────────────────
  // Without this endpoint, an extension or automated harness cannot clean
  // up rows it created — leaving stale "pending-approval" entries that
  // hold the location dialog open across restarts. The IPC has
  // remove-download, but the HTTP API did not.
  console.log('\nCleanup endpoints exist');
  {
    const dmStub = {
      downloads: new Map(),
      getSettings: () => ({}),
      emit: () => {},
      addDownload: () => ({ id: 'stub', duplicate: false }),
      removeDownload: function (id) { this.downloads.delete(id); return true; },
      cancelDownload: function (id) { return this.downloads.get(id) || null; },
      rejectDownload: function (id) { this.downloads.delete(id); },
    };
    const srv2 = new server.IPCServer(dmStub);
    // Step off the default port so the live AiDM on 18765 is never disturbed.
    srv2.port = 19766;
    await new Promise((resolve, reject) => {
      srv2.start();
      setTimeout(resolve, 400);
      setTimeout(() => reject(new Error('cleanup server did not start')), 4000);
    });
    try {
      dmStub.downloads.set('row-a', { id: 'row-a', filename: 'old.mp4' });
      dmStub.downloads.set('row-b', { id: 'row-b', filename: 'stale.pdf' });
      const r1 = await postJson(srv2.port, '/api/remove', { id: 'row-a' });
      check('POST /api/remove returns 200 + success',
        r1.status === 200 && r1.body && r1.body.success === true,
        'status=' + r1.status);
      check('the targeted row is gone from the manager',
        !dmStub.downloads.has('row-a') && dmStub.downloads.has('row-b'));
      const rMissing = await postJson(srv2.port, '/api/remove', { id: 'does-not-exist' });
      check('removing an unknown id is a clean no-op, not an error',
        rMissing.status === 200 && rMissing.body && rMissing.body.success === true);
      const rBad = await postJson(srv2.port, '/api/remove', {});
      check('a request without id is rejected with 400',
        rBad.status === 400 && rBad.body && /Missing id/.test(rBad.body.error || ''),
        'status=' + rBad.status);

      const rCancel = await postJson(srv2.port, '/api/cancel', { id: 'row-b' });
      check('POST /api/cancel returns 200 + success',
        rCancel.status === 200 && rCancel.body && rCancel.body.success === true);
      const rReject = await postJson(srv2.port, '/api/reject', { id: 'row-b' });
      check('POST /api/reject returns 200 + success',
        rReject.status === 200 && rReject.body && rReject.body.success === true);
    } finally {
      try { srv2.stop(); } catch (e) { /* best effort */ }
    }
  }

  console.log('\nserver-youtube-cdn-guard: ' + pass + ' passed, ' + fail + ' failed');
})().catch((e) => {
  console.log('  FAIL harness: ' + (e && e.message));
  process.exit(1);
});
