// Unit tests for the webhooks feature (bounded delivery, AUD-013).
// Run: node test/webhooks.js
const { WebhookManager, WEBHOOK_EVENTS, DEFAULT_EVENTS } = require('../src/webhooks');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

async function main() {
  console.log('── parsing + routing ──');
  const mgr = new WebhookManager({ fetchImpl: async () => ({ ok: true }) });
  mgr.setEndpoints([
    { url: 'https://hooks.example.com/a', events: ['download_completed'] },
    'not an object',
    { noUrl: true },
    { url: 'ftp://bad/x' },
    { url: 'https://hooks.example.com/b' },
  ]);
  check('lenient parse keeps 2 valid endpoints', mgr.endpoints.length === 2, `n=${mgr.endpoints.length}`);
  check('explicit events preserved', mgr.endpoints[0].events.join() === 'download_completed');
  check('missing events default to completed+error', mgr.endpoints[1].events.join() === DEFAULT_EVENTS.join());

  const received = [];
  const mgr2 = new WebhookManager({
    fetchImpl: async (u, opts) => {
      received.push({ url: u, body: JSON.parse(opts.body), sig: opts.headers['X-AiDM-Signature'] });
      return { ok: true };
    },
  });
  mgr2.setEndpoints([{ url: 'https://hooks.example.com/a', events: ['download_completed'] }]);
  await mgr2.emit('download_started', { id: 'x' });
  await mgr2.flush();
  check('non-matching event not delivered', received.length === 0, `n=${received.length}`);
  await mgr2.emit('download_completed', { id: 'x', totalSize: 100 });
  await mgr2.flush();
  check('matching event delivered', received.length === 1, `n=${received.length}`);
  check('payload carries event+data', received[0].body.event === 'download_completed' && received[0].body.data.id === 'x');
  check('timestamp present', typeof received[0].body.timestamp === 'number');

  const received3 = [];
  const mgr3 = new WebhookManager({
    fetchImpl: async (u, opts) => { received3.push({ sig: opts.headers['X-AiDM-Signature'] }); return { ok: true }; },
  });
  mgr3.setEndpoints([{ url: 'https://hooks.example.com/a', events: ['download_completed'], secret: 'topsecret' }]);
  await mgr3.emit('download_completed', { id: 'y' });
  await mgr3.flush();
  const sig = received3[0] && received3[0].sig;
  check('HMAC signature header present with secret', typeof sig === 'string' && sig.startsWith('sha256='), String(sig));

  const mgr4 = new WebhookManager({ fetchImpl: async () => ({ ok: true }) });
  mgr4.setEndpoints([{ url: 'https://hooks.example.com/a', events: ['download_error'], secret: 's' }]);
  const restored = new WebhookManager({ fetchImpl: async () => ({ ok: true }) });
  restored.load(mgr4.toJSON());
  check('webhook config round-trips', restored.endpoints.length === 1 && restored.endpoints[0].events.join() === 'download_error', JSON.stringify(restored.endpoints));

  console.log('\n── deadline, backoff, bounded backlog (AUD-013) ──');
  // 1. A stalled receiver is aborted by the per-attempt deadline.
  {
    let aborted = false;
    const stalled = new WebhookManager({
      timeoutMs: 60,
      maxAttempts: 1,
      fetchImpl: (u, opts) => new Promise((resolve) => {
        opts.signal.addEventListener('abort', () => { aborted = true; resolve({ ok: false, status: 0 }); });
      }),
    });
    stalled.setEndpoints([{ url: 'https://slow.example/hook', events: ['download_completed'] }]);
    const started = Date.now();
    await stalled.emit('download_completed', { id: 'slow' });
    await stalled.flush();
    const elapsed = Date.now() - started;
    check('a stalled request is aborted by the deadline', aborted === true);
    check('the deadline is honoured in time', elapsed < 3000, `${elapsed}ms`);
    check('a timed-out delivery is counted as failed', stalled.stats.failed === 1, JSON.stringify(stalled.stats));
  }

  // 2. Transient failures retry with exponential backoff (injected sleep).
  {
    const delays = [];
    let calls = 0;
    const flaky = new WebhookManager({
      backoffMs: 1000,
      maxAttempts: 3,
      sleep: async (ms) => { delays.push(ms); },
      fetchImpl: async () => {
        calls++;
        if (calls < 3) throw new Error('ECONNRESET');
        return { ok: true, status: 200 };
      },
    });
    flaky.setEndpoints([{ url: 'https://flaky.example/hook', events: ['download_completed'] }]);
    await flaky.emit('download_completed', { id: 'f' });
    await flaky.flush();
    check('transient failures retry until success', calls === 3 && flaky.stats.delivered === 1, `calls=${calls} ${JSON.stringify(flaky.stats)}`);
    check('backoff grows (1s, 2s)', delays.join(',') === '1000,2000', delays.join(','));
    check('retries are counted', flaky.stats.retried === 2);
  }

  // 3. 5xx retries; 4xx does not.
  {
    let calls = 0;
    const srvErr = new WebhookManager({
      maxAttempts: 2, sleep: async () => {},
      fetchImpl: async () => { calls++; return { ok: false, status: 503 }; },
    });
    srvErr.setEndpoints([{ url: 'https://err.example/hook', events: ['download_completed'] }]);
    await srvErr.emit('download_completed', {});
    await srvErr.flush();
    check('5xx is retried then reported failed', calls === 2 && srvErr.stats.failed === 1, `calls=${calls} ${JSON.stringify(srvErr.stats)}`);

    let calls4 = 0;
    const clientErr = new WebhookManager({
      maxAttempts: 3, sleep: async () => {},
      fetchImpl: async () => { calls4++; return { ok: false, status: 400 }; },
    });
    clientErr.setEndpoints([{ url: 'https://err.example/hook', events: ['download_completed'] }]);
    await clientErr.emit('download_completed', {});
    await clientErr.flush();
    check('4xx is not retried', calls4 === 1 && clientErr.stats.failed === 1, `calls=${calls4}`);
  }

  // 4. Backlog is bounded: the OLDEST queued delivery is dropped.
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const bounded = new WebhookManager({
      maxPending: 1,
      timeoutMs: 60000,
      fetchImpl: (u, opts) => gate.then(() => ({ ok: true })),
    });
    bounded.setEndpoints([{ url: 'https://busy.example/hook', events: ['download_completed'] }]);
    await bounded.emit('download_completed', { id: 'first' }); // goes in-flight
    await bounded.emit('download_completed', { id: 'second' });
    await bounded.emit('download_completed', { id: 'third' });
    await bounded.emit('download_completed', { id: 'fourth' });
    check('queue never exceeds the cap', bounded.pending === 1, `pending=${bounded.pending}`);
    check('overflow is counted as dropped', bounded.stats.dropped === 2, JSON.stringify(bounded.stats));
    bounded.close();
    release();
    await bounded.flush();
    check('close() drains without delivering the backlog', bounded.stats.delivered <= 1, JSON.stringify(bounded.stats));
  }

  // 5. close() aborts an in-flight attempt and resolves flush().
  {
    const inFlight = new WebhookManager({
      timeoutMs: 60000,
      fetchImpl: (u, opts) => new Promise((resolve) => {
        opts.signal.addEventListener('abort', () => resolve({ ok: false, status: 0 }));
      }),
    });
    inFlight.setEndpoints([{ url: 'https://hang.example/hook', events: ['download_completed'] }]);
    await inFlight.emit('download_completed', {});
    inFlight.close();
    const t0 = Date.now();
    await inFlight.flush();
    check('close() resolves a pending flush promptly', Date.now() - t0 < 1000);
    check('an aborted close is not counted as a failure', inFlight.stats.failed === 0, JSON.stringify(inFlight.stats));
  }

  // 6. Disabled / no endpoints / unknown events are inert.
  {
    const disabled = new WebhookManager({ enabled: false, fetchImpl: async () => { throw new Error('should not be called'); } });
    disabled.setEndpoints([{ url: 'https://x.example/h', events: ['download_completed'] }]);
    await disabled.emit('download_completed', {});
    await disabled.flush();
    check('disabled manager sends nothing', disabled.stats.delivered === 0 && disabled.stats.failed === 0);
    const empty = new WebhookManager({ fetchImpl: async () => ({ ok: true }) });
    await empty.emit('download_completed', {});
    await empty.flush();
    check('no endpoints is inert', empty.stats.delivered === 0);
    const unknown = new WebhookManager({ fetchImpl: async () => ({ ok: true }) });
    unknown.setEndpoints([{ url: 'https://x.example/h' }]);
    await unknown.emit('not_an_event', {});
    await unknown.flush();
    check('unknown event kind is ignored', unknown.stats.delivered === 0);
  }

  check('event kind is valid', WEBHOOK_EVENTS.includes('download_completed'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log('  FAIL', e && e.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
});
