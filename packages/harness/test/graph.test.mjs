import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildStructuralIndex, readStructuralIndex, readStructuralIndexIfCurrent } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';
import { structuralIndexStatus } from '../lib/index-status.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-graph-'));
  const workspace = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull } });
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
