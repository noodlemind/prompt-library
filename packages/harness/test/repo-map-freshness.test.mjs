import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildRepoMap, buildNeighborhood } from '../lib/repo-map/index.mjs';
import { buildStructuralIndex } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-map-freshness-'));
  const ws = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const savedHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  fs.mkdirSync(ws);
  t.after(() => {
    if (savedHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: ws, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'Fixture']);
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(ws, rel), content);
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  return { ws, home, git };
}

test('dirty and staged files refresh both consumers while unchanged indexed rows remain', async (t) => {
  const { ws, home, git } = fixture(t, {
    'a.js': "import { before } from './b.js';\nexport function beforeEdit() {}\n",
    'b.js': 'export function before() {}\n',
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: {
    tier: 'treesitter',
    extract: (rel, content) => ({ ...lexicalV2(rel, content), symbols: rel === 'b.js' ? ['RetainedIndex'] : ['beforeEdit'], tier: 'treesitter' }),
  } });
  for (const staged of [false, true]) {
    fs.writeFileSync(path.join(ws, 'a.js'), 'export function afterEdit() {}\n');
    if (staged) git(['add', 'a.js']);
    const map = buildRepoMap({ workspace: ws });
    assert.match(map.body, /afterEdit/);
    assert.match(map.body, /RetainedIndex/);
    assert.doesNotMatch(map.body, /beforeEdit/);
    assert.deepEqual(buildNeighborhood({ workspace: ws, files: ['a.js'] }).files, [
      { rel: 'a.js', symbols: ['afterEdit'], imports: [], importedBy: [] },
    ]);
    assert.match(map.body, /tree-sitter 1, lexical 1, parse errors 0/);
  }
});

test('deleted, oversized, and symlinked files retain paths without cached symbols or edges', async (t) => {
  const { ws, home } = fixture(t, {
    'a.js': "import { b } from './b.js';\nexport function staleSymbol() {}\n",
    'b.js': 'export function b() {}\n',
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: { tier: 'lexical', extract: lexicalV2 } });
  const outside = path.join(home, 'outside.js');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(outside, 'export function outsideSymbol() {}\n');
  for (const replacement of ['deleted', 'oversized', 'symlink']) {
    fs.rmSync(path.join(ws, 'a.js'), { force: true });
    if (replacement === 'oversized') fs.writeFileSync(path.join(ws, 'a.js'), 'x'.repeat(200_001));
    if (replacement === 'symlink') fs.symlinkSync(outside, path.join(ws, 'a.js'));
    const map = buildRepoMap({ workspace: ws, query: 'a' });
    assert.ok(map.files.includes('a.js'));
    assert.match(map.body, /b\.js.*b/);
    assert.doesNotMatch(map.body, /staleSymbol|outsideSymbol/);
    assert.deepEqual(buildNeighborhood({ workspace: ws, files: ['a.js'] }).files, [
      { rel: 'a.js', symbols: [], imports: [], importedBy: [] },
    ]);
  }
});

test('failed reads cannot reuse a row hashed as empty content', async (t) => {
  const { ws, home } = fixture(t, { 'a.js': '' });
  await buildStructuralIndex({ workspace: ws, home, extractor: {
    tier: 'treesitter', extract: () => ({ symbols: ['CachedEmpty'], imports: [], defs: [], refs: [], tier: 'treesitter' }),
  } });
  assert.match(buildRepoMap({ workspace: ws }).body, /CachedEmpty/);
  fs.unlinkSync(path.join(ws, 'a.js'));
  assert.deepEqual(buildNeighborhood({ workspace: ws, files: ['a.js'] }).files, [
    { rel: 'a.js', symbols: [], imports: [], importedBy: [] },
  ]);
  assert.doesNotMatch(buildRepoMap({ workspace: ws }).body, /CachedEmpty/);
});

test('banner counts effective tiers and parse errors separately, while committed maps stay lexical', async (t) => {
  const { ws, home } = fixture(t, {
    'a.js': 'export function alpha() {}\n',
    'b.py': 'def beta():\n    pass\n',
    'c.js': 'export function broken() {}\n',
  });
  await buildStructuralIndex({ workspace: ws, home, extractor: {
    tier: 'treesitter', extract: (rel, content) => ({ ...lexicalV2(rel, content), tier: rel === 'b.py' ? 'lexical' : 'treesitter', hasErrors: rel === 'c.js' }),
  } });
  const map = buildRepoMap({ workspace: ws });
  assert.match(map.body, /tree-sitter 1, lexical 1, parse errors 1/);
  assert.ok(map.tokens <= 1000);
  const committed = buildRepoMap({ workspace: ws, preferStructural: false });
  assert.match(committed.body, /lexical map/);
  assert.doesNotMatch(committed.body, /tree-sitter|parse errors/);
  const tiny = buildRepoMap({ workspace: ws, maxTokens: 1 });
  assert.equal(tiny.tokens, 0);
  assert.equal(tiny.body, '');
  const longQuery = buildRepoMap({ workspace: ws, query: 'query '.repeat(1200) });
  assert.ok(longQuery.tokens <= 1000);
});
