import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildStructuralIndex, readStructuralIndex } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2, createTreesitterExtract, packageGrammarRoots } from '../lib/repo-map/treesitter-extractor.mjs';
import { queryGraph } from '../lib/graph.mjs';
import { parseGraphArguments } from '../lib/graph-cmd.mjs';
import { readStructuralIndex as readShapeIndex } from '../lib/structural/shape.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-graph-evidence-'));
  const workspace = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (file, text) => fs.writeFileSync(path.join(workspace, file), text);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  write('a.mjs', "import { b } from './b.mjs';\nexport function a() { return b(); }\n");
  write('b.mjs', "import { c } from './c.mjs';\nexport function b() { return c(); }\n");
  write('c.mjs', 'export function c() { return 1; }\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { workspace, home, root, write, git, extractor: { tier: 'lexical', extract: lexicalV2 } };
}

test('explain preserves directed path evidence and impact is bounded reverse reachability', async t => {
  const f = fixture(t);
  await buildStructuralIndex(f);
  const explanation = queryGraph({ ...f, operation: 'explain', files: ['a.mjs', 'c.mjs'] });
  assert.deepEqual(explanation.path, ['a.mjs', 'b.mjs', 'c.mjs']);
  assert.equal(explanation.scope, 'git-tracked-source');
  assert.equal(explanation.coverage.semanticCompleteness, 'unverified');
  assert.equal(explanation.explanation.length, 2);
  assert.equal(explanation.explanation[0].authority, 'descriptive-context');
  const impact = queryGraph({ ...f, operation: 'impact', files: ['c.mjs'], depth: 2 });
  assert.deepEqual(impact.affected.map(row => [row.file, row.distance]), [['b.mjs', 1], ['a.mjs', 2]]);
  assert.equal(impact.authority, 'descriptive-context');
});

test('named generations query immutable facts without claiming current source', async t => {
  const f = fixture(t);
  const first = await buildStructuralIndex(f);
  f.write('a.mjs', "import { c } from './c.mjs';\n");
  await buildStructuralIndex(f);
  const historic = queryGraph({ ...f, operation: 'deps', files: ['a.mjs'], generation: first.meta.generation });
  assert.deepEqual(historic.edges.map(row => row.to), ['b.mjs']);
  assert.equal(historic.source, 'snapshot');
  assert.equal(historic.generation, first.meta.generation);
  assert.deepEqual(historic.freshness, { state: 'historical', liveValidated: false });
  f.write('a.mjs', 'unrelated changed bytes');
  assert.deepEqual(queryGraph({ ...f, operation: 'deps', files: ['a.mjs'], generation: first.meta.generation }), historic);
});

test('selected generation validates its own table hashes and never falls back to live bytes', async t => {
  const f = fixture(t);
  const first = await buildStructuralIndex(f);
  f.write('a.mjs', "import { c } from './c.mjs';\n");
  await buildStructuralIndex(f);
  fs.appendFileSync(path.join(first.dir, 'graph.json'), ' ');
  assert.throws(() => queryGraph({ ...f, operation: 'deps', files: ['a.mjs'], generation: first.meta.generation }), { code: 'E_GRAPH_SNAPSHOT' });
});

test('unavailable, retired and unsafe generation identifiers fail explicitly', async t => {
  const f = fixture(t);
  const first = await buildStructuralIndex(f);
  await buildStructuralIndex(f);
  await buildStructuralIndex(f);
  for (const generation of [first.meta.generation, 'f'.repeat(32)]) {
    assert.throws(() => queryGraph({ ...f, files: ['a.mjs'], generation }), { code: 'E_GRAPH_SNAPSHOT' });
  }
  for (const generation of ['../outside', '', 'A'.repeat(32)]) {
    assert.throws(() => queryGraph({ ...f, files: ['a.mjs'], generation }), { code: 'E_USAGE' });
  }
});

test('published graph adjacency has stable forward and reverse edge references', async t => {
  const f = fixture(t);
  await buildStructuralIndex(f);
  const index = readStructuralIndex(f.workspace, f);
  assert.equal(index.graph.adjacency.version, 1);
  assert.deepEqual(index.graph.adjacency.forward['a.mjs'], [0]);
  assert.deepEqual(index.graph.adjacency.reverse['c.mjs'], [1]);
  const result = queryGraph({ ...f, files: ['a.mjs'] });
  assert.equal(result.cache.adjacencyReused, true);
});

test('generation parser consumes its value separately from positional files', () => {
  const generation = 'a'.repeat(32);
  const parsed = parseGraphArguments(['explain', 'a.mjs', 'b.mjs', '--generation', generation]);
  assert.deepEqual(parsed.files, ['a.mjs', 'b.mjs']);
  assert.equal(parsed.generation, generation);
});

test('incremental graph output equals a clean rebuild after source and candidate inventory changes', async t => {
  const f = fixture(t);
  await buildStructuralIndex(f);
  f.write('a.mjs', "import { c } from './c.mjs';\n");
  f.write('d.mjs', "import { c } from './c.mjs';\n");
  f.git('add', 'd.mjs');
  const incremental = await buildStructuralIndex(f);
  const incrementalGraph = readStructuralIndex(f.workspace, f).graph;
  const cleanHome = path.join(f.root, 'clean-home');
  await buildStructuralIndex({ ...f, home: cleanHome });
  assert.deepEqual(readStructuralIndex(f.workspace, { home: cleanHome }).graph, incrementalGraph);
  assert.equal(incremental.reparsed, 2);
});

test('explicit bindings narrow same-name call candidates and keep call-site uncertainty', async t => {
  const f = fixture(t);
  f.write('a.mjs', "import { run } from './b.mjs';\nexport function a() { return run(); }\n");
  f.write('b.mjs', 'export function run() {}\n');
  f.write('c.mjs', 'export function run() {}\n');
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  await buildStructuralIndex({ ...f, extractor });
  const index = readStructuralIndex(f.workspace, f);
  const candidate = index.graph.calls.find(row => row.from === 'a.mjs' && row.symbol === 'run');
  assert.deepEqual(candidate.to, ['b.mjs']);
  assert.equal(candidate.relation, 'call-candidate');
  assert.equal(candidate.resolutionStatus, 'candidate');
  assert.equal(candidate.reason, 'explicit-import-binding');
  assert.equal(candidate.evidence[0].path, 'a.mjs');
  const explanation = queryGraph({ ...f, operation: 'explain', files: ['a.mjs', 'b.mjs'] });
  assert.equal(explanation.explanation[0].evidence[0].range.startLine, 1);
  assert.equal(explanation.explanation[0].evidence[0].sha256, index.files['a.mjs'].hash);
  const normalized = readShapeIndex(f.workspace, f).graph.calls.find(row => row.from === 'a.mjs#run');
  assert.equal(normalized.relation, 'call-candidate');
  assert.equal(normalized.resolutionStatus, 'candidate');
  assert.equal(normalized.evidence[0].path, 'a.mjs');
});

test('configuration-only alias changes invalidate graph snapshot identity', async t => {
  const f = fixture(t);
  f.write('alias.ts', "import { run } from '@target';\n");
  f.write('left.ts', 'export function run() {}\n');
  f.write('right.ts', 'export function run() {}\n');
  f.write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@target': ['./left.ts'] } } }));
  f.git('add', '.');
  await buildStructuralIndex(f);
  const before = queryGraph({ ...f, files: ['alias.ts'] });
  f.write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@target': ['./right.ts'] } } }));
  await buildStructuralIndex(f);
  const after = queryGraph({ ...f, files: ['alias.ts'] });
  assert.deepEqual(before.edges.map(edge => edge.to), ['left.ts']);
  assert.deepEqual(after.edges.map(edge => edge.to), ['right.ts']);
  assert.notEqual(after.snapshot, before.snapshot);
});

test('type-only bindings never become same-name global call candidates', async t => {
  const f = fixture(t);
  f.write('a.ts', "import type { run } from './b.ts';\n");
  f.write('b.ts', 'export function run() {}\n');
  f.git('add', '.');
  await buildStructuralIndex(f);
  const index = readStructuralIndex(f.workspace, f);
  assert.deepEqual(index.graph.calls.filter(row => row.from === 'a.ts'), []);
  assert.ok(index.graph.unresolvedCalls.some(row => row.from === 'a.ts' && row.reason === 'type-only-import'));
});

test('renamed imports retain the actual target declaration identity in normalized candidates', async t => {
  const f = fixture(t);
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  assert.ok(extractor.available.includes('javascript'), 'the shipped JavaScript grammar is available');
  f.write('a.mjs', "import { run as execute } from './b.mjs';\nexport function a() { return execute(); }\n");
  f.write('b.mjs', 'export function run() {}\n');
  await buildStructuralIndex({ ...f, extractor });
  const index = readStructuralIndex(f.workspace, f);
  const candidate = index.graph.calls.find(row => row.from === 'a.mjs' && row.symbol === 'execute');
  assert.equal(candidate.candidates[0].name, 'run');
  assert.match(candidate.candidates[0].id, /^b\.mjs#run@/);
  const normalized = readShapeIndex(f.workspace, f).graph.calls.find(row => row.from === 'a.mjs#execute');
  assert.equal(normalized.to, 'b.mjs#run');
  assert.equal(normalized.candidates[0].name, 'run');
});

test('AST call candidates require an unshadowed import and a supported direct named export', async t => {
  const f = fixture(t);
  const extractor = await createTreesitterExtract({ grammarRoots: packageGrammarRoots() });
  f.write('a.mjs', "import { execute, hidden, step, DefaultName } from './b.mjs';\nimport * as api from './b.mjs';\nexport function shadow(execute) { execute(); }\nexport function live() { execute(); hidden(); step(); DefaultName(); api.execute(); }\n");
  f.write('b.mjs', 'export function execute() {}\nfunction hidden() {}\nexport class Controller { step() {} }\nexport default function DefaultName() {}\n');
  await buildStructuralIndex({ ...f, extractor });
  const index = readStructuralIndex(f.workspace, f);
  const calls = index.graph.calls.filter(row => row.from === 'a.mjs');
  assert.equal(calls.filter(row => row.symbol === 'execute').length, 2);
  assert.ok(calls.every(row => row.evidence[0].range.startLine === 4));
  assert.equal(calls.some(row => ['hidden', 'step', 'DefaultName'].includes(row.symbol)), false);
  const unresolved = index.graph.unresolvedCalls.filter(row => row.from === 'a.mjs');
  assert.ok(unresolved.some(row => row.symbol === 'execute' && row.reason === 'shadowed-import-binding'));
  for (const name of ['hidden', 'step', 'DefaultName']) assert.ok(unresolved.some(row => row.symbol === name && row.reason === 'unsupported-export-binding'));
});
