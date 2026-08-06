// Integration seam test: the structural index the REAL builder writes
// (`buildStructuralIndex`, compact on-disk form) must be readable through
// `readStructuralIndex` and usable by the structural-expectations check —
// the two halves were built independently against one documented contract,
// and this test is the proof they meet.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildStructuralIndex, structuralIndexDir } from '../lib/repo-map/structural-index.mjs';
import { createTreesitterExtract } from '../lib/repo-map/treesitter-extractor.mjs';
import { readStructuralIndex, structuralDir } from '../lib/structural/shape.mjs';
import { runStructuralExpectations } from '../lib/structural/expectations.mjs';

function initRepo(ws) {
  fs.mkdirSync(ws, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: ws });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: ws });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: ws });
}

function commitAll(ws, message) {
  execFileSync('git', ['add', '-A'], { cwd: ws });
  execFileSync('git', ['commit', '-qm', message], { cwd: ws });
}

test('builder output round-trips through shape reader into the expectations check', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'struct-compat-'));
  const ws = path.join(tmp, 'ws');
  const home = path.join(tmp, 'home');
  initRepo(ws);
  fs.writeFileSync(
    path.join(ws, 'a.mjs'),
    'export function alpha() { return beta(); }\nexport function beta() { return 1; }\n'
  );
  fs.writeFileSync(path.join(ws, 'caller.mjs'), "import { beta } from './a.mjs';\nexport const use = () => beta();\n");
  commitAll(ws, 'init');

  assert.equal(structuralIndexDir(ws, { home }), structuralDir(ws, { home }), 'builder and reader agree on the index dir');

  const extractor = await createTreesitterExtract();
  await buildStructuralIndex({ workspace: ws, home, extractor });

  const index = readStructuralIndex(ws, { home });
  assert.equal(index.present, true, `index should be readable: ${index.reason}`);
  assert.ok(Object.keys(index.files).length >= 2, 'files map is populated');
  assert.ok(Array.isArray(index.files['a.mjs']?.symbols) && index.files['a.mjs'].symbols.includes('alpha'));

  const betaRows = index.symbols.filter((row) => row.name === 'beta');
  assert.ok(betaRows.length >= 1, 'symbols normalized into rows');
  assert.equal(betaRows[0].file, 'a.mjs');
  assert.equal(typeof betaRows[0].exported, 'boolean');

  const betaCalls = index.graph.calls.filter((edge) => edge.to === 'a.mjs#beta');
  assert.ok(betaCalls.length >= 1, 'call edges normalized to file#symbol form');

  // Remove an exported symbol with a surviving caller; the check must see it.
  fs.writeFileSync(path.join(ws, 'a.mjs'), 'export function alpha() { return 1; }\n');
  const plan = { fm: {}, body: '## Impacted Files\n\n- `a.mjs`\n' };
  const result = runStructuralExpectations({ workspace: ws, plan, changedFiles: ['a.mjs'], home });
  assert.equal(result.status, 'failed', `expected structural findings, got ${result.status}: ${result.message}`);
  assert.ok(
    result.findings.some((f) => f.type === 'removed-symbol-with-callers' && f.symbol === 'beta'),
    'removed exported symbol with a surviving caller is flagged'
  );
});
