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

// Neutralize host git config, same as every other suite.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function initRepo(ws) {
  fs.mkdirSync(ws, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: ws, env: GIT_ENV });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: ws, env: GIT_ENV });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: ws, env: GIT_ENV });
}

function commitAll(ws, message) {
  execFileSync('git', ['add', '-A'], { cwd: ws, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', message], { cwd: ws, env: GIT_ENV });
}

test('builder output round-trips through shape reader into the expectations check', async (t) => {
  const extractor = await createTreesitterExtract();
  // Call edges come only from the AST tier; another grammar can set the tier
  // while .mjs still falls back to lexical, so gate on the language itself.
  if (!extractor.available.includes('javascript')) {
    t.skip('javascript tree-sitter grammar not installed — call-edge round-trip needs the AST tier');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'struct-compat-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
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

  // Remove an exported symbol with a surviving caller.
  fs.writeFileSync(path.join(ws, 'a.mjs'), 'export function alpha() { return 1; }\n');
  // Allowlist via the shape parseImpactedFiles actually consumes
  // (plan.sections.impactedFiles) — a.mjs is planned, so no
  // unplanned-symbol-change may fire; only the caller finding is expected.
  const plan = { fm: {}, sections: { impactedFiles: '- `a.mjs`\n' } };

  // A treesitter-tier baseline entry is honestly SKIPPED per file: the current
  // side is always lexical, so a cross-tier diff would fabricate findings —
  // the check passes with an informational tier-mismatch-skipped note instead.
  const skipped = runStructuralExpectations({ workspace: ws, plan, changedFiles: ['a.mjs'], home });
  assert.equal(skipped.status, 'passed', `tier-mismatched file must skip, got ${skipped.status}: ${skipped.message}`);
  assert.deepEqual(skipped.findings, []);
  assert.ok(
    skipped.informational.some((n) => n.type === 'tier-mismatch-skipped' && n.file === 'a.mjs' && n.tier === 'treesitter'),
    `tier mismatch surfaces as informational: ${JSON.stringify(skipped.informational)}`
  );

  // To prove the DOWNSTREAM seam (builder-written symbol rows and call edges
  // flowing into survivingCallers), restamp a.mjs's per-file tier as lexical —
  // a pure test-side patch of the generation stamp; the tables stay
  // builder-written.
  const filesPath = path.join(structuralIndexDir(ws, { home }), 'files.json');
  const filesTable = JSON.parse(fs.readFileSync(filesPath, 'utf8'));
  filesTable['a.mjs'].tier = 'lexical';
  fs.writeFileSync(filesPath, JSON.stringify(filesTable) + '\n');

  const result = runStructuralExpectations({ workspace: ws, plan, changedFiles: ['a.mjs'], home });
  assert.equal(result.status, 'failed', `expected structural findings, got ${result.status}: ${result.message}`);
  assert.ok(
    result.findings.some((f) => f.type === 'removed-symbol-with-callers' && f.symbol === 'beta'),
    'removed exported symbol with a surviving caller is flagged'
  );
  assert.ok(
    !result.findings.some((f) => f.type === 'unplanned-symbol-change'),
    `planned file must not raise unplanned-symbol-change: ${JSON.stringify(result.findings)}`
  );
});
