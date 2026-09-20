// Jev-powered engine upgrade decisions (TypeSafe AI System One).
// Reads TYPESAFE_API_KEY from the environment; never prints it.
// Run: node tools/jev-engine-decisions.js
'use strict';

const STATE = `
AUDIT — AiDM download engine today (Electron/Node.js, src/engine/*):
- IDM-style dynamic segmentation: file starts as 1 segment; when a connection frees up, the LARGEST in-flight segment is split in half (minSplitSize 1 MiB). Piece selection: 'largest' or 'inorder'. Adaptive connection count steps up/down every 2s based on throughput deltas (+5% up, -15% down), with cooldowns; backs off on 429/503.
- aria2-style feedback mirror selection: untested mirrors probed first, fastest speed-EMA mirror wins, per-mirror connection cap (default 8), ban after 3 consecutive non-retryable failures.
- Transport: Node http/https with manual redirect following, shared cookie jar across redirect hops, DNS-over-HTTPS fallback after OS-DNS failure, insecure-TLS retry, 30s timeouts. NO keep-alive/agent reuse: every segment request opens a fresh TCP+TLS connection. NO HTTP/2. NO proxy support.
- Reliability: If-Range/ETag/Last-Modified validation, Content-Range cross-checks, incomplete-response detection (bytes promised vs received), gap/overlap repair on resume, .part.meta control file saved every 2s, sparse preallocation, positional writes, sha256 verification, retry with exponential backoff + Retry-After, slow-connection drop when other connections exist.
- Manager: FIFO queue (no priorities), maxConcurrent downloads, global TokenBucket speed limit, per-download limit, HLS engine with AES-128 + live refresh + resume cursor. NO time-based schedule windows. NO per-host cross-download connection cap (two downloads to the same CDN can each open 8 connections). Split size and connection counts are hardcoded, not user-configurable.

RESEARCH — top-5 managers' engine techniques (sources: IDM segmentation docs, aria2 manual + AdaptiveURISelector.cc, FDM features, AB Download Manager repo/issues, AntDM):
F1 keep-alive connection pooling — IDM's headline claim: "full reuse of connections without additional connect and login stages". AiDM pays TCP+TLS handshake per segment request today.
F2 proxy support (HTTP/SOCKS) — supported by IDM, FDM, Motrix, aria2; absent in AiDM.
F3 cross-download per-host connection cap — aria2 --max-connection-per-server enforced globally; AiDM only caps within one task.
F4 user-configurable split size / connections (aria2 -k, -x, -s) — AiDM hardcodes 1 MiB / 8 / 32.
F5 priority queue + per-download bandwidth allocation — FDM traffic modes, AB queues.
F6 time-based scheduler windows (FDM scheduler: start/pause at set times) — AiDM has none.
F7 HTTP/2 multiplexing — modern CDNs; aria2/Motrix benefit; Node http2 API is immature for streaming ranges.
F8 in-order/geom piece selection for preview-while-downloading (aria2 stream-piece-selector) — AiDM has 'inorder' already.
F9 marginal-speed adaptive threading (AB DM issue #275: divide speed delta by added connections) — AiDM's adapt uses raw throughput deltas with cooldowns.
F10 disk full-preallocation option + periodic fsync (aria2 --file-allocation) — AiDM has sparse only.
`;

const QUESTIONS = {
  // One Choice + one Score per candidate feature (evaluated in parallel).
  ...Object.fromEntries(['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10'].flatMap((f) => [
    [`${f}_decision`, {
      type: 'choice',
      instructions: `Should AiDM implement ${f} in this release, given its audit and the top-5 research? adopt = clear win worth shipping now; defer = valuable but not now; skip = low value or already covered.`,
      criteria: { adopt: 'implement in this release', defer: 'worth doing later', skip: 'not worth doing' },
    }],
    [`${f}_impact`, {
      type: 'score',
      instructions: `Rate the DOWNLOAD-SPEED/RELIABILITY impact of implementing ${f} for AiDM's users (0 = negligible, 1 = minor, 2 = noticeable, 3 = significant, 4 = major, 5 = transformative).`,
      criteria: ['0 negligible', '1 minor', '2 noticeable', '3 significant', '4 major', '5 transformative'],
    }],
  ])),
  biggest_bottleneck: {
    type: 'choice',
    instructions: 'Which single weakness most limits AiDM download speed today?',
    criteria: {
      f1_no_keepalive: 'fresh TCP+TLS handshake per segment request',
      f3_host_cap: 'no cross-download per-host connection cap',
      f4_fixed_splits: 'hardcoded split/connection counts',
      f9_adapt: 'adaptive-connection logic too coarse',
      none: 'engine is already near parity',
    },
  },
  segmentation_parity: {
    type: 'noul',
    instructions: 'Does AiDM already implement IDM-style dynamic segmentation (largest-segment halving with connection reuse semantics) as described in the audit?',
  },
  risk_matrix: {
    type: 'score',
    instructions: 'Rate the regression RISK of changing the engine transport in this release (0 = trivial, 5 = likely to break working downloads).',
    criteria: ['0 trivial', '1 low', '2 moderate', '3 elevated', '4 high', '5 severe'],
  },
};

async function main() {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) { console.error('TYPESAFE_API_KEY missing'); process.exit(2); }
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: STATE, model: 'jev-latest', questions: QUESTIONS }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    console.error('Jev API error', res.status, (await res.text()).slice(0, 400));
    process.exit(1);
  }
  const data = await res.json();
  // Confidence-gated routing (TypeSafe pattern): act only on confident decisions.
  const CONF = 0.55;
  const out = { model: data.model, usage: data.usage, confidenceGate: CONF, decisions: {} };
  for (const f of ['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10']) {
    const d = data.answers[`${f}_decision`];
    const i = data.answers[`${f}_impact`];
    const acted = d.confidence >= CONF;
    const decision = acted ? d.choice : 'defer';
    out.decisions[f] = {
      raw: d.choice,
      confidence: d.confidence,
      acted,
      impact: i.score,
      impactConfidence: i.confidence,
      final: decision,
    };
  }
  out.biggest_bottleneck = data.answers.biggest_bottleneck;
  out.segmentation_parity = data.answers.segmentation_parity;
  out.risk_matrix = data.answers.risk_matrix;
  require('fs').writeFileSync(__dirname + '/../docs/jev-engine-decisions.json', JSON.stringify(out, null, 2));
  for (const [f, d] of Object.entries(out.decisions)) {
    console.log(`${f}: ${String(d.final).padEnd(6)} impact=${d.impact} conf=${d.confidence.toFixed(2)}${d.acted ? '' : ' (below gate -> defer)'}`);
  }
  console.log('bottleneck:', out.biggest_bottleneck.choice, `(${out.biggest_bottleneck.confidence.toFixed(2)})`);
  console.log('segmentation_parity:', out.segmentation_parity.noul);
  console.log('transport regression risk:', out.risk_matrix.score);
  console.log('usage:', JSON.stringify(data.usage));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
