// Unit tests for the webhooks feature. Run: node test/webhooks.js
const { WebhookManager, WEBHOOK_EVENTS, DEFAULT_EVENTS } = require('../src/webhooks');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name, extra || ''); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

console.log('── webhooks (FluxDown-style task-event hooks) ──');

async function main() {
  // Lenient parsing: keep valid, drop invalid, default events.
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

  // emit only fires matching endpoints.
  const received = [];
  const mgr2 = new WebhookManager({
    fetchImpl: async (u, opts) => { received.push({ url: u, body: JSON.parse(opts.body), sig: opts.headers['X-AiDM-Signature'] }); return { ok: true }; },
  });
  mgr2.setEndpoints([{ url: 'https://hooks.example.com/a', events: ['download_completed'] }]);
  await mgr2.emit('download_started', { id: 'x' });
  check('non-matching event not delivered', received.length === 0, `n=${received.length}`);
  await mgr2.emit('download_completed', { id: 'x', totalSize: 100 });
  check('matching event delivered', received.length === 1, `n=${received.length}`);
  check('payload carries event+data', received[0].body.event === 'download_completed' && received[0].body.data.id === 'x');
  check('timestamp present', typeof received[0].body.timestamp === 'number');

  // HMAC signature when secret set.
  const received3 = [];
  const mgr3 = new WebhookManager({
    fetchImpl: async (u, opts) => { received3.push({ sig: opts.headers['X-AiDM-Signature'] }); return { ok: true }; },
  });
  mgr3.setEndpoints([{ url: 'https://hooks.example.com/a', events: ['download_completed'], secret: 'topsecret' }]);
  await mgr3.emit('download_completed', { id: 'y' });
  const sig = received3[0] && received3[0].sig;
  check('HMAC signature header present with secret', typeof sig === 'string' && sig.startsWith('sha256='), String(sig));

  // toJSON / load round-trip.
  const mgr4 = new WebhookManager({ fetchImpl: async () => ({ ok: true }) });
  mgr4.setEndpoints([{ url: 'https://hooks.example.com/a', events: ['download_error'], secret: 's' }]);
  const restored = new WebhookManager({ fetchImpl: async () => ({ ok: true }) });
  restored.load(mgr4.toJSON());
  check('webhook config round-trips', restored.endpoints.length === 1 && restored.endpoints[0].events.join() === 'download_error', JSON.stringify(restored.endpoints));

  // Best-effort: a throwing fetch never rejects emit.
  const boom = new WebhookManager({ fetchImpl: async () => { throw new Error('network down'); } });
  boom.setEndpoints([{ url: 'https://hooks.example.com/a', events: ['download_completed'] }]);
  await boom.emit('download_completed', { id: 'z' });
  check('emit swallows delivery errors', true);

  check('event kind is valid', WEBHOOK_EVENTS.includes('download_completed'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log('  FAIL', e && e.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
});
