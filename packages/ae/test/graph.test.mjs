import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildStructuralIndex, readStructuralIndex, readStructuralIndexIfCurrent } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';
import { structuralIndexStatus } from '../lib/index-status.mjs';
import { structuralCacheDir } from '../lib/structural/shape.mjs';
import { publishSnapshot } from '../lib/structural/snapshot.mjs';
import { contentHash } from '../lib/repo-map/facts.mjs';
import { queryGraph } from '../lib/graph.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-graph-'));
  const workspace = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (rel, content) => {
    const full = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { workspace, home, root, git, write, extractor: { tier: 'lexical', extract: lexicalV2 } };
}

test('stored imports resolve explicit paths and count one edge per importing file', async (t) => {
  const f = fixture(t, {
    'src/main.mjs': "import { util } from '../left/util.mjs';\nimport { other } from '../left/util.mjs';\nexport function main() { return util(); }\n",
    'left/util.mjs': 'export function util() {}\nexport function other() {}\n',
    'right/util.mjs': 'export function util() {}\n',
  });
  await buildStructuralIndex(f);
  const graph = readStructuralIndex(f.workspace, f).graph;
  assert.deepEqual(graph.modules.map(({ from, to }) => ({ from, to })), [{ from: 'src/main.mjs', to: 'left/util.mjs' }]);
  assert.equal(graph.modules[0].resolution, 'relative');
});

test('ambiguous bare imports retain their reason without fabricated module edges', async (t) => {
  const f = fixture(t, {
    'src/main.mjs': "import { helper } from 'helper';\n",
    'left/helper.mjs': 'export function helper() {}\n',
    'right/helper.mjs': 'export function helper() {}\n',
  });
  await buildStructuralIndex(f);
  const graph = readStructuralIndex(f.workspace, f).graph;
  assert.deepEqual(graph.modules, []);
  assert.deepEqual(graph.unresolvedImports, [{ from: 'src/main.mjs', import: 'helper', reason: 'ambiguous' }]);
});

test('a rebuild detects changed content even when size and mtime are unchanged', async (t) => {
  const f = fixture(t, { 'src/main.mjs': 'export function alpha() {}\n' });
  await buildStructuralIndex(f);
  const full = path.join(f.workspace, 'src/main.mjs');
  const old = fs.statSync(full);
  f.write('src/main.mjs', 'export function bravo() {}\n');
  fs.utimesSync(full, old.atime, old.mtime);
  const result = await buildStructuralIndex(f);
  assert.deepEqual(readStructuralIndex(f.workspace, f).files['src/main.mjs'].symbols, ['bravo']);
  assert.equal(result.reparsed, 1);
});

test('current structural graphs reject dirty contents while tolerant baseline reads remain available', async (t) => {
  const f = fixture(t, { 'src/main.mjs': 'export function alpha() {}\n' });
  await buildStructuralIndex(f);
  assert.deepEqual(readStructuralIndexIfCurrent(f.workspace, f).files['src/main.mjs'].symbols, ['alpha']);
  f.write('src/main.mjs', 'export function bravo() {}\n');
  assert.equal(readStructuralIndexIfCurrent(f.workspace, f), null);
  assert.equal(structuralIndexStatus(f.workspace, f).stale, true);
  assert.deepEqual(readStructuralIndex(f.workspace, f).files['src/main.mjs'].symbols, ['alpha']);
});

test('a changed extractor configuration reparses unchanged source', async (t) => {
  const f = fixture(t, { 'src/main.mjs': 'export function alpha() {}\n' });
  await buildStructuralIndex(f);
  const extractor = { ...f.extractor, grammarVersions: { javascript: 'new-parser' }, extract: (rel, content) => ({ ...lexicalV2(rel, content), symbols: ['newParserResult'] }) };
  const result = await buildStructuralIndex({ ...f, extractor });
  assert.equal(result.reparsed, 1);
  assert.deepEqual(readStructuralIndex(f.workspace, f).files['src/main.mjs'].symbols, ['newParserResult']);
});

test('old file facts cannot hide dynamic imports in live queries or incremental rebuilds', async (t) => {
  const f = fixture(t, {
    'a.mjs': "export const load = () => import('./b.mjs');\n",
    'b.mjs': 'export const b = 1;\n',
  });
  await buildStructuralIndex(f);
  const prior = readStructuralIndex(f.workspace, f);
  prior.files['a.mjs'].imports = [];
  prior.meta.fileFactsVersion = 2;
  prior.meta.extractorSignature = contentHash(JSON.stringify({ version: 2, tier: 'lexical', webTreeSitter: null, grammarVersions: {} }));
  const published = publishSnapshot(structuralCacheDir(f.workspace, f), [
    ['meta.json', prior.meta], ['files.json', prior.files], ['symbols.json', prior.symbols], ['graph.json', prior.graph],
  ]);
  assert.equal(published.ok, true);
  const current = queryGraph({ ...f, operation: 'path', files: ['a.mjs', 'b.mjs'] });
  assert.deepEqual(current.path, ['a.mjs', 'b.mjs']);
  assert.equal(current.cache.reused, 0);
  const rebuilt = await buildStructuralIndex(f);
  assert.equal(rebuilt.reparsed, 2);
  assert.equal(rebuilt.reused, 0);
  assert.deepEqual(readStructuralIndex(f.workspace, f).files['a.mjs'].imports, ['./b.mjs']);
});

for (const change of ['missing source state', 'extractor revision', 'resolver configuration']) {
  test(`live graph refreshes cached facts after ${change} changes`, async t => {
    const f = fixture(t, {
      'a.mjs': "export const load = () => import('./b.mjs');\n",
      'b.mjs': 'export const b = 1;\n',
      'package.json': '{"type":"module"}\n',
    });
    await buildStructuralIndex(f);
    const prior = readStructuralIndex(f.workspace, f);
    prior.files['a.mjs'].imports = [];
    if (change === 'missing source state') delete prior.meta.sourceState;
    if (change === 'extractor revision') {
      prior.meta.sourceState.extractorRevision = 'f'.repeat(64);
      prior.meta.sourceState.digest = 'e'.repeat(64);
    }
    assert.equal(publishSnapshot(structuralCacheDir(f.workspace, f), [
      ['meta.json', prior.meta], ['files.json', prior.files], ['symbols.json', prior.symbols], ['graph.json', prior.graph],
    ]).ok, true);
    if (change === 'resolver configuration') f.write('package.json', '{"type":"commonjs"}\n');
    const current = queryGraph({ ...f, operation: 'path', files: ['a.mjs', 'b.mjs'] });
    assert.deepEqual(current.path, ['a.mjs', 'b.mjs']);
    assert.equal(current.cache.reused, 0);
  });
}

test('a source change during extraction refuses publication and preserves the previous snapshot', async (t) => {
  const f = fixture(t, { 'src/main.mjs': 'export function alpha() {}\n' });
  await buildStructuralIndex(f);
  f.write('src/main.mjs', 'export function bravo() {}\n');
  const extractor = {
    tier: 'lexical',
    extract(rel, content) {
      f.write(rel, 'export function delta() {}\n');
      return lexicalV2(rel, content);
    },
  };
  const result = await buildStructuralIndex({ ...f, extractor });
  assert.equal(result.written, false);
  assert.equal(result.sourceChanged, true);
  assert.deepEqual(readStructuralIndex(f.workspace, f).files['src/main.mjs'].symbols, ['alpha']);
});

test('a tracked file removed before its scan turn refuses publication', async (t) => {
  const f = fixture(t, { 'a.mjs': 'export function alpha() {}\n', 'z.mjs': 'export function z() {}\n' });
  await buildStructuralIndex(f);
  const before = readStructuralIndex(f.workspace, f).generation;
  f.write('a.mjs', 'export function bravo() {}\n');
  const extractor = {
    tier: 'lexical',
    extract(rel, content) {
      if (rel === 'a.mjs') fs.unlinkSync(path.join(f.workspace, 'z.mjs'));
      return lexicalV2(rel, content);
    },
  };
  const result = await buildStructuralIndex({ ...f, extractor });
  assert.equal(result.written, false);
  assert.equal(result.sourceChanged, true);
  assert.equal(readStructuralIndex(f.workspace, f).generation, before);
});
