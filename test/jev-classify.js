// Regression harness: Jev (TypeSafe System One) link-triage integration.
//
// Jev helps the engine find downloadable video/image/file links that the
// static clipboard regexes miss. These tests pin the contract that the AI
// path is strictly ADDITIVE and FAIL-OPEN: no key, network errors, bad
// responses, or a "webpage" verdict must all behave exactly like the old
// regex-only monitor.
//
// Run: node test/jev-classify.js
'use strict';
const assert = require('assert');
const jev = require('../src/jev');
const { ClipboardMonitor } = require('../src/clipboard-monitor');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

const GOOD_ANSWERS = {
  answers: {
    kind: { type: 'choice', choice: 'video', confidence: 0.91, probabilities: { video: 0.91 } },
    downloadable: { type: 'noul', noul: 0.93, confidence: 0.9 },
  },
};
const PAGE_ANSWERS = {
  answers: {
    kind: { type: 'choice', choice: 'webpage', confidence: 0.88, probabilities: { webpage: 0.88 } },
    downloadable: { type: 'noul', noul: 0.05, confidence: 0.9 },
  },
};

function makeMonitor(envKey) {
  const original = process.env.TYPESAFE_API_KEY;
  if (envKey === null) delete process.env.TYPESAFE_API_KEY;
  else if (envKey !== undefined) process.env.TYPESAFE_API_KEY = envKey;
  const seen = [];
  let responder = () => GOOD_ANSWERS;
  jev.setFetchImpl(async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => responder() };
  });
  const monitor = new ClipboardMonitor({
    // Simulate the live settings gate (on).
    jevAssist: () => monitor.settingsOn !== false,
  });
  const cleanup = () => {
    if (envKey === null) delete process.env.TYPESAFE_API_KEY;
    else if (envKey !== undefined && original === undefined) delete process.env.TYPESAFE_API_KEY;
    else if (envKey !== undefined) process.env.TYPESAFE_API_KEY = original;
    jev.setFetchImpl(null);
    jev.resetJev();
  };
  return { monitor, seen, setResponder: (r) => { responder = r; }, cleanup };
}

function waitFor(fn, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      try { const v = fn(); v ? resolve(v) : setTimeout(tick, 25); }
      catch (e) { reject(e); }
      if (Date.now() - t0 > ms) { clearInterval(); }
    };
    tick();
    setTimeout(() => reject(new Error('waitFor timeout')), ms);
  });
}

async function main() {
  // ── 1. no API key → immediate null, zero network ─────────────────────────
  {
    const { monitor, seen, cleanup } = makeMonitor(null);
    const verdict = await jev.classifyLink('https://cdn.example.com/get/abc123');
    check('no key → fail-open null', verdict === null);
    check('no key → no network call', seen.length === 0);
    // Clipboard path with no key: URL that matches NO pattern is not emitted.
    const emitted = [];
    monitor.on('link-found', (u) => emitted.push(u));
    monitor._check = monitor._check.bind(monitor);
    monitor._getClipboard = () => 'https://weird-host.example/get/xyz789';
    monitor._check();
    await new Promise((r) => setTimeout(r, 50));
    check('clipboard: no key → no emission', emitted.length === 0);
    cleanup();
  }

  // ── 2. confident "downloadable" verdict promotes a regex-missed URL ──────
  {
    const { monitor, seen, cleanup } = makeMonitor('test-key');
    const emitted = [];
    monitor.on('link-found', (u) => emitted.push(u));
    monitor._getClipboard = () => 'https://weird-host.example/get/xyz789';
    monitor._check();
    await waitFor(() => emitted.length === 1);
    check('clipboard: Jev rescue emits regex-missed URL', emitted[0] === 'https://weird-host.example/get/xyz789');
    check('classify sends choice+noul questions',
      seen.length === 1 &&
      seen[0].body.questions.kind.type === 'choice' &&
      seen[0].body.questions.downloadable.type === 'noul' &&
      seen[0].body.model === 'jev-latest');
    check('request carries Authorization header only (no key in body)',
      !JSON.stringify(seen[0].body).includes('test-key'));

    // Caching: same URL again must not hit the network a second time.
    const before = seen.length;
    const v2 = await jev.classifyLink('https://weird-host.example/get/xyz789');
    check('identical classify is served from cache', v2 && seen.length === before);
    cleanup();
  }

  // ── 3. "webpage" verdict stays silent ─────────────────────────────────────
  {
    const { monitor, setResponder, cleanup } = makeMonitor('test-key');
    jev.resetJev();
    setResponder(() => PAGE_ANSWERS);
    const emitted = [];
    monitor.on('link-found', (u) => emitted.push(u));
    monitor._getClipboard = () => 'https://social.example/feed';
    monitor._check();
    await new Promise((r) => setTimeout(r, 80));
    check('clipboard: webpage verdict not emitted', emitted.length === 0);
    cleanup();
  }

  // ── 4. API failure is fail-open (no emission, no crash) ──────────────────
  {
    const { monitor, setResponder, cleanup } = makeMonitor('test-key');
    jev.resetJev();
    setResponder(() => { throw new Error('boom'); });
    const emitted = [];
    monitor.on('link-found', (u) => emitted.push(u));
    monitor._getClipboard = () => 'https://fail.example/a';
    monitor._check();
    await new Promise((r) => setTimeout(r, 80));
    check('clipboard: Jev failure → silent fallback', emitted.length === 0);
    const nullVerdict = await jev.classifyLink('https://fail.example/b');
    check('classify: fetch throw → null', nullVerdict === null);
    cleanup();
  }

  // ── 5. non-2xx response is fail-open ─────────────────────────────────────
  {
    const { monitor, setResponder, cleanup } = makeMonitor('test-key');
    jev.resetJev();
    setResponder(null);
    jev.setFetchImpl(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const verdict = await jev.classifyLink('https://x.example/c');
    check('classify: HTTP 503 → null', verdict === null);
    void monitor; void setResponder;
    cleanup();
  }

  // ── 6. settings gate off → Jev never consulted ────────────────────────────
  {
    const { monitor, seen, cleanup } = makeMonitor('test-key');
    jev.resetJev();
    monitor.settingsOn = false;
    const emitted = [];
    monitor.on('link-found', (u) => emitted.push(u));
    monitor._getClipboard = () => 'https://gated.example/d';
    monitor._check();
    await new Promise((r) => setTimeout(r, 80));
    check('settings toggle off → no network, no emission', seen.length === 0 && emitted.length === 0);
    cleanup();
  }

  // ── 7. regex hits still short-circuit (Jev not consulted) ────────────────
  {
    const { monitor, seen, cleanup } = makeMonitor('test-key');
    jev.resetJev();
    const emitted = [];
    monitor.on('link-found', (u) => emitted.push(u));
    monitor._getClipboard = () => 'https://mirror.example/files/setup.zip';
    monitor._check();
    await new Promise((r) => setTimeout(r, 80));
    check('regex hit → immediate emission', emitted.length === 1);
    check('regex hit → Jev not called', seen.length === 0);
    cleanup();
  }

  // ── 8. URL anatomy description ────────────────────────────────────────────
  {
    const d = jev.describeUrl('https://cdn.ex.com/v/abc/file?token=zzz');
    check('describeUrl extracts host/path/extension', d.includes('host: cdn.ex.com') && d.includes('path: /v/abc/file') && d.includes('extension: none'));
    check('describeUrl handles garbage', jev.describeUrl('::::').includes('not a valid'));
  }

  console.log(`\njev-classify: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
