'use strict';

// Single source of truth for `npm test`: every top-level test/*.js runs
// automatically, so a new suite can never be silently dropped from the chain
// (the old hand-maintained &&-chain in package.json had already orphaned 6).
// To park a suite without deleting it, rename it with a leading underscore.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKIP = new Set(['run-all.js']);
const HEAD = ['smoke.js', 'integration.js']; // fast sanity first, fail fast

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) =>
  f.endsWith('.js') && !SKIP.has(f) && !f.startsWith('_') &&
  fs.statSync(path.join(dir, f)).isFile()
);
const ordered = [
  ...HEAD.filter((f) => files.includes(f)),
  ...files.filter((f) => !HEAD.includes(f)),
];

const t0 = Date.now();
let passed = 0;
for (const f of ordered) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nFAIL ${f} (exit ${r.status ?? r.signal}) — ${passed}/${ordered.length} suites passed before failure`);
    process.exit(1);
  }
  passed++;
  console.log(`\n== PASS ${f} (${passed}/${ordered.length}) ==`);
}
console.log(`\nAll ${ordered.length} suites passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
