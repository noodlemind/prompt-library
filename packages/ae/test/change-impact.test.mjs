import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildChangeImpactContext } from '../lib/change-impact.mjs';
import { buildStructuralIndex, readStructuralIndex } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';
import { ensureStore, serializeLearning } from '../lib/knowledge/store.mjs';

function fixture(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-impact-'));
  const workspace = path.join(root, 'workspace'), home = path.join(root, 'home'), copilotHome = path.join(root, 'copilot');
  fs.mkdirSync(workspace); fs.mkdirSync(copilotHome);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, content) => { const full = path.join(workspace, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  const git = args => { const r = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-q']); git(['config', 'user.name', 'Impact test']); git(['config', 'user.email', 'impact@example.invalid']);
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const build = options => buildChangeImpactContext({ workspace, home, copilotHome, query: 'change retry behavior', ...options });
  return { workspace, home, copilotHome, root, write, git, build };
}

test('change-impact returns bounded reverse paths and current source evidence without check authority', t => {
  const f = fixture(t, {
    'src/processor.mjs': 'export function process() { return 1; }\n',
    'src/service.mjs': "import { process } from './processor.mjs';\nexport function submit() { return process(); }\n",
    'src/controller.mjs': "import { submit } from './service.mjs';\nexport const handle = submit;\n",
    'src/unrelated.mjs': 'export const unrelated = 2;\n',
  });
  const packet = f.build({ files: ['src/processor.mjs'], questionKind: 'change-impact', depth: 3 });
  assert.equal(packet.schema, 'harness.change-impact.v1');
  assert.equal(packet.authority, 'descriptive-context');
  assert.equal(packet.coverage.sourceState, 'validated');
  assert.equal(packet.coverage.semanticCompleteness, 'unverified');
  assert.deepEqual(packet.sources.map(row => row.location).sort(), ['src/controller.mjs', 'src/processor.mjs', 'src/service.mjs']);
  assert.ok(packet.sources.every(row => /^[a-f0-9]{64}$/.test(row.sha256) && row.evidence.reference.endsWith(row.sha256)));
  assert.ok(packet.graphs[0].edges.some(edge => edge.from === 'src/controller.mjs' && edge.to === 'src/service.mjs'));
  assert.equal(Object.hasOwn(packet, 'requiredChecks'), false);
  assert.ok(packet.limitations.some(value => /runtime/.test(value)));
});

test('dependency-path expands the source occurrence instead of the beginning of a long file', t => {
  const prefix = '// deliberately distant import\n'.repeat(80);
  const f = fixture(t, {
    'a.mjs': prefix + "import { item } from './b.mjs';\nexport const value = item;\n",
    'b.mjs': 'export const item = 1;\n',
  });
  const packet = f.build({ files: ['a.mjs', 'b.mjs'], questionKind: 'dependency-path' });
  const occurrence = packet.sources.find(row => row.location === 'a.mjs');
  assert.match(occurrence.excerpt, /import \{ item \}/);
  assert.ok(occurrence.evidence.range.startLine > 40);
});

test('lookup reads an explicit untracked source without requiring a structural graph', t => {
  const f = fixture(t, { 'tracked.mjs': 'export const value = 1;\n' });
  f.write('new.mjs', 'export const newValue = 2;\n');
  const packet = f.build({ files: ['new.mjs'], questionKind: 'lookup' });
  assert.equal(packet.graphs.length, 0);
  assert.equal(packet.coverage.scope, 'explicit-source-selection');
  assert.equal(packet.coverage.sourceState, 'validated');
  assert.deepEqual(packet.sources.map(row => row.location), ['new.mjs']);
});

test('lookup rejects stale explicit source bindings even when the current worktree is stable', t => {
  const f = fixture(t, { 'tracked.mjs': 'export const value = 1;\n' });
  const initial = f.build({ files: ['tracked.mjs'], questionKind: 'lookup' });
  f.write('tracked.mjs', 'export const value = 2;\n');
  const packet = f.build({ files: [`tracked.mjs@sha256:${initial.sources[0].sha256}`], questionKind: 'lookup' });
  assert.equal(packet.coverage.sourceState, 'changed-or-unavailable');
  assert.equal(packet.sources.length, 0);
  assert.ok(packet.gaps.some(gap => gap.kind === 'source-changed'));
});

test('a named historical graph never borrows changed live source as its evidence', async t => {
  const f = fixture(t, { 'a.mjs': "import { item } from './b.mjs';\nexport const value = item;\n", 'b.mjs': 'export const item = 1;\n' });
  await buildStructuralIndex({ workspace: f.workspace, home: f.home, extractor: { tier: 'lexical', extract: lexicalV2 } });
  const generation = readStructuralIndex(f.workspace, { home: f.home }).generation;
  assert.match(generation, /^[a-f0-9]{32}$/);
  f.write('a.mjs', 'export const replacement = 9;\n');
  const packet = f.build({ files: ['b.mjs'], questionKind: 'change-impact', generation });
  assert.equal(packet.coverage.sourceState, 'historical');
  assert.equal(packet.graphs[0].freshness.liveValidated, false);
  assert.equal(packet.sources.some(row => row.location === 'a.mjs'), false);
  assert.ok(packet.gaps.some(gap => gap.kind === 'source-changed' && gap.path === 'a.mjs'));
});

test('the complete serialized packet respects its byte ceiling and reports omissions', t => {
  const files = { 'target.mjs': 'export const target = 1;\n' };
  for (let i = 0; i < 12; i++) files[`caller-${i}.mjs`] = `import { target } from './target.mjs';\nexport const value = target;\n${'// padding\n'.repeat(30)}`;
  const f = fixture(t, files);
  const packet = f.build({ files: ['target.mjs'], questionKind: 'change-impact', maxFiles: 2, maxBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 4096);
  assert.ok(packet.coverage.omittedFiles > 0 || packet.coverage.graphDetailsOmitted > 0);
  assert.ok(packet.sources.length <= 2);
});

test('broad impact packets retain explicit seed evidence before graph detail', t => {
  const files = { 'target.mjs': 'export const target = 1;\n' };
  for (let i = 0; i < 24; i++) files[`caller-${i}.mjs`] = `import { target } from './target.mjs';\nexport const value = target;\n`;
  const f = fixture(t, files);
  const packet = f.build({ files: ['target.mjs'], questionKind: 'change-impact' });
  assert.equal(packet.coverage.sourceState, 'validated');
  assert.ok(packet.sources.some(row => row.location === 'target.mjs' && row.excerpt.includes('export const target = 1')));
  assert.ok(packet.coverage.graphDetailsOmitted > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 16000);
  assert.equal(packet.coverage.bytes, Buffer.byteLength(JSON.stringify(packet)));
  const tight = f.build({ files: ['target.mjs'], questionKind: 'change-impact', maxBytes: 2048 });
  assert.ok(tight.coverage.omittedFiles > packet.coverage.omittedFiles);
  assert.ok(Buffer.byteLength(JSON.stringify(tight)) <= 2048);
  assert.equal(tight.coverage.bytes, Buffer.byteLength(JSON.stringify(tight)));
});

test('packet byte counts stay exact across the 9999 to 10000 boundary before enforcing the ceiling', t => {
  const f = fixture(t, { 'retry.mjs': 'export const retry = 1;\n' });
  const { dir } = ensureStore(f.workspace, { home: f.home });
  const full = path.join(dir, 'learnings', 'python', 'retry.md');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const writeLearning = padding => fs.writeFileSync(full, serializeLearning({ id: 'python/retry', category: 'python', trigger: `retry behavior ${'x'.repeat(padding)}`,
    status: 'provisional', episodes: [{ kind: 'insight', path: 'old.md' }] }, 'Review retry attempts.'));
  const options = { questionKind: 'prior-lesson', maxBytes: 16000 };
  const packetBytes = packet => Buffer.byteLength(JSON.stringify(packet));
  writeLearning(0);
  const baseBytes = packetBytes(f.build(options));
  assert.ok(baseBytes >= 1000 && baseBytes < 9999);
  writeLearning(9999 - baseBytes);
  const below = f.build(options);
  assert.equal(packetBytes(below), 9999);
  assert.equal(below.coverage.bytes, packetBytes(below));
  writeLearning(10000 - baseBytes);
  const above = f.build(options);
  assert.equal(packetBytes(above), 10001);
  assert.equal(above.coverage.bytes, packetBytes(above));
  const bounded = f.build({ ...options, maxBytes: 10000 });
  assert.equal(bounded.coverage.omittedLearnings, 1);
  assert.equal(bounded.coverage.bytes, packetBytes(bounded));
  assert.ok(packetBytes(bounded) <= 10000);
});

test('unresolved dynamic wiring stays a gap rather than absence of runtime dependents', t => {
  const f = fixture(t, { 'service.py': 'from importlib import import_module\nprocessor = import_module(settings.processor)\n', 'settings.py': 'processor = "retail"\n' });
  const packet = f.build({ files: ['service.py'], questionKind: 'change-impact' });
  assert.equal(packet.coverage.semanticCompleteness, 'unverified');
  assert.ok(packet.gaps.some(gap => gap.kind === 'runtime-relationships-unverified'));
  assert.equal(packet.limitations.some(value => /no runtime dependencies/i.test(value)), false);
});

test('prior-lesson routes to existing learning retrieval without creating graph authority', t => {
  const f = fixture(t, { 'retry.py': 'def retry():\n    return 1\n' });
  const { dir } = ensureStore(f.workspace, { home: f.home });
  const full = path.join(dir, 'learnings', 'python', 'retry.md');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, serializeLearning({ id: 'python/retry', category: 'python', trigger: 'retry behavior', status: 'provisional', episodes: [{ kind: 'insight', path: 'old.md' }] }, 'Review retry attempts before applying a timeout.'));
  const packet = f.build({ questionKind: 'prior-lesson' });
  assert.equal(packet.graphs.length, 0);
  assert.equal(packet.sources.length, 0);
  assert.equal(packet.coverage.sourceState, 'not-applicable');
  assert.ok(packet.learnings.some(row => row.id === 'python/retry'));
});

test('input validation rejects unsupported kinds, unsafe selectors, and unbounded requests', t => {
  const f = fixture(t, { 'a.mjs': 'export const a = 1;\n' });
  assert.throws(() => f.build({ questionKind: 'automatically-approve' }), /question kind/);
  assert.throws(() => f.build({ questionKind: 'lookup', files: ['../escape.mjs'] }), /workspace/);
  assert.throws(() => f.build({ files: ['a.mjs'], maxBytes: 128 }), /byte budget/);
  assert.throws(() => f.build({ questionKind: 'dependency-path', files: ['a.mjs'] }), /two/);
});
