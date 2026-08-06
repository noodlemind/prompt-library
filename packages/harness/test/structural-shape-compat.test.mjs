// Integration seam test: the structural index the REAL builder writes
// (`buildStructuralIndex`, compact on-disk form) must be readable through
// `readStructuralIndex` and usable by the structural-expectations check —
// the two halves were built independently against one documented contract,
// and this test is the proof they meet. Nothing here hand-edits the tables:
// every assertion is against bytes the builder itself wrote.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildStructuralIndex, structuralIndexDir } from '../lib/repo-map/structural-index.mjs';
import { createTreesitterExtract, lexicalV2, packageGrammarRoots } from '../lib/repo-map/treesitter-extractor.mjs';
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

/** The DEFAULT tier: what every install without the optional grammars uses. */
function lexicalExtractor() {
  return {
    counters: { parseFailures: 0, parsed: 0, errorFiles: 0 },
    tier: 'lexical',
    webTreeSitter: null,
    grammarVersions: {},
    missingGrammars: [],
    integrityFailures: [],
    extract: lexicalV2,
  };
}

function fixtureRepo(t, prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
  return { ws, home };
}

// Allowlist via the shape parseImpactedFiles actually consumes
// (plan.sections.impactedFiles) — a.mjs is planned, so no
// unplanned-symbol-change may fire; only the caller finding is expected.
const PLAN = { fm: {}, sections: { impactedFiles: '- `a.mjs`\n' } };

test('builder output round-trips through the shape reader (AST tier, grammars installed)', async (t) => {
  // Roots scoped to the harness package's own node_modules: hermetic against
  // whatever else lives up the filesystem.
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  // Call edges come only from the AST tier; another grammar can set the tier
  // while .mjs still falls back to lexical, so gate on the language itself.
  if (!extractor.available.includes('javascript')) {
    t.skip('javascript tree-sitter grammar not installed — AST-tier round-trip needs it');
    return;
  }
  const { ws, home } = fixtureRepo(t, 'struct-compat-ast-');

  assert.equal(structuralIndexDir(ws, { home }), structuralDir(ws, { home }), 'builder and reader agree on the index dir');
  await buildStructuralIndex({ workspace: ws, home, extractor });

  const index = readStructuralIndex(ws, { home });
  assert.equal(index.present, true, `index should be readable: ${index.reason}`);
  assert.ok(Object.keys(index.files).length >= 2, 'files map is populated');
  assert.ok(Array.isArray(index.files['a.mjs']?.symbols) && index.files['a.mjs'].symbols.includes('alpha'));
  assert.equal(index.files['a.mjs'].tier, 'treesitter', 'the builder stamps the per-file tier it used');

  const betaRows = index.symbols.filter((row) => row.name === 'beta');
  assert.ok(betaRows.length >= 1, 'symbols normalized into rows');
  assert.equal(betaRows[0].file, 'a.mjs');
  assert.equal(betaRows[0].exported, true, 'AST tier records the real export flag');

  const betaCalls = index.graph.calls.filter((edge) => edge.to === 'a.mjs#beta');
  assert.ok(betaCalls.length >= 1, 'call edges normalized to file#symbol form');

  // Remove an exported symbol with a surviving caller. A treesitter-tier
  // baseline entry is honestly SKIPPED per file: the current side is always
  // lexical, so a cross-tier diff would fabricate findings. Nothing was
  // compared, so the check reports `skipped` — never a green `passed`.
  fs.writeFileSync(path.join(ws, 'a.mjs'), 'export function alpha() { return 1; }\n');
  const skipped = runStructuralExpectations({ workspace: ws, plan: PLAN, changedFiles: ['a.mjs'], home });
  assert.equal(skipped.status, 'skipped', `tier-mismatched file must skip, got ${skipped.status}: ${skipped.message}`);
  assert.deepEqual(skipped.findings, []);
  assert.ok(
    skipped.informational.some((n) => n.type === 'tier-mismatch-skipped' && n.file === 'a.mjs' && n.tier === 'treesitter'),
    `tier mismatch surfaces as informational: ${JSON.stringify(skipped.informational)}`
  );
});

test('removed-symbol-with-callers fires end to end from real builder output in the default lexical tier', async (t) => {
  const { ws, home } = fixtureRepo(t, 'struct-compat-lex-');
  // No grammars needed and no table patched: this is the shape a stock install
  // (optional grammars absent) writes. The lexical tier now records real
  // export flags and explicit named-import references, which is exactly what
  // the caller-side finding is computed from.
  await buildStructuralIndex({ workspace: ws, home, extractor: lexicalExtractor() });

  const index = readStructuralIndex(ws, { home });
  assert.equal(index.present, true, `index should be readable: ${index.reason}`);
  assert.equal(index.files['a.mjs'].tier, 'lexical');
  const beta = index.symbols.find((row) => row.name === 'beta' && row.file === 'a.mjs');
  assert.ok(beta, `beta must be in the symbol rows: ${JSON.stringify(index.symbols)}`);
  assert.equal(beta.exported, true, 'the lexical tier records the export surface');
  assert.ok(
    index.graph.calls.some((edge) => edge.to === 'a.mjs#beta' && edge.from.startsWith('caller.mjs')),
    `the named import is a recorded edge: ${JSON.stringify(index.graph.calls)}`
  );

  fs.writeFileSync(path.join(ws, 'a.mjs'), 'export function alpha() { return 1; }\n');
  const result = runStructuralExpectations({ workspace: ws, plan: PLAN, changedFiles: ['a.mjs'], home });
  assert.equal(result.status, 'failed', `expected structural findings, got ${result.status}: ${result.message}`);
  assert.ok(
    result.findings.some((f) => f.type === 'removed-symbol-with-callers' && f.symbol === 'beta' && f.callers.includes('caller.mjs')),
    `removed exported symbol with a surviving caller is flagged: ${JSON.stringify(result.findings)}`
  );
  assert.ok(
    !result.findings.some((f) => f.type === 'unplanned-symbol-change'),
    `planned file must not raise unplanned-symbol-change: ${JSON.stringify(result.findings)}`
  );
});
