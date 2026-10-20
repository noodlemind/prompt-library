import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildStructuralIndex, readStructuralIndexIfCurrent, structuralIndexDir } from '../lib/repo-map/structural-index.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';
import { readStructuralIndex } from '../lib/structural/shape.mjs';
import { structuralIndexStatus } from '../lib/index-status.mjs';
import { buildNeighborhood } from '../lib/repo-map/index.mjs';
import { runSearch } from '../lib/retrieval/search.mjs';
import { captureWorkingSources } from '../lib/repo-map/working-sources.mjs';
import { MAX_FILES_SCANNED } from '../lib/repo-map/scan.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-freshness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (rel, text) => fs.writeFileSync(path.join(workspace, rel), text);
  write('a.mjs', "import { b } from './b.mjs';\nexport function oldName() { return b; }\n");
  write('b.mjs', 'export const b = 1;\n');
  write('c.mjs', 'export const c = 1;\n');
  write('package.json', '{"type":"module"}\n');
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const extractor = { tier: 'lexical', extract: lexicalV2 };
  const build = (options = {}) => buildStructuralIndex({ workspace, home, extractor, ...options });
  return { workspace, home, git, write, build };
}

test('dirty bytes invalidate current readers, status and symbol search while historical reads remain available', async (t) => {
  const f = fixture(t);
  await f.build();
  assert.ok(readStructuralIndexIfCurrent(f.workspace, { home: f.home }));
  f.write('a.mjs', "import { c } from './c.mjs';\nexport function newName() { return c; }\n");
  assert.equal(readStructuralIndexIfCurrent(f.workspace, { home: f.home }), null);
  assert.equal(structuralIndexStatus(f.workspace, { home: f.home }).stale, true);
  assert.match(structuralIndexStatus(f.workspace, { home: f.home }).recommendation, /source.*changed/i);
  assert.equal(readStructuralIndex(f.workspace, { home: f.home, requireCurrent: true }).present, false);
  assert.equal(readStructuralIndex(f.workspace, { home: f.home }).present, true);
  const result = runSearch({ workspace: f.workspace, copilotHome: f.home, home: f.home, query: 'oldName', mode: 'symbol', sources: ['code'] });
  assert.equal(result.results.length, 0);
  assert.match(result.sources[0].reason, /stale|changed/i);
  const neighborhood = buildNeighborhood({ workspace: f.workspace, home: f.home, files: ['a.mjs'] });
  assert.deepEqual(neighborhood.files.map((file) => file.rel), ['a.mjs', 'c.mjs']);
});

test('resolver files beyond the scan budget cannot be reported as validated', (t) => {
  const f = fixture(t);
  for (let i = 0; i <= MAX_FILES_SCANNED; i++) {
    fs.mkdirSync(path.join(f.workspace, `module-${i}`));
    f.write(`module-${i}/package.json`, '{}');
  }
  f.git('add', '.');
  const snapshot = captureWorkingSources(f.workspace);
  assert.equal(snapshot.valid, false);
  assert.match(snapshot.reason, /resolver.*budget/i);
  assert.ok(Object.keys(snapshot.entries).length <= MAX_FILES_SCANNED + snapshot.files.length);
});

test('an incremental rebuild hashes bytes even when size and timestamp are restored', async (t) => {
  const f = fixture(t);
  await f.build();
  const full = path.join(f.workspace, 'a.mjs');
  const before = fs.statSync(full);
  f.write('a.mjs', "import { c } from './c.mjs';\nexport function newName() { return c; }\n");
  fs.utimesSync(full, before.atime, before.mtime);
  await f.build({ since: f.git('rev-parse', 'HEAD') });
  const index = readStructuralIndexIfCurrent(f.workspace, { home: f.home });
  assert.deepEqual(index.files['a.mjs'].imports, ['./c.mjs']);
  assert.ok(index.symbols.newName);
  assert.equal(index.symbols.oldName, undefined);
});

test('staging additions, renames and deletions invalidate the source set', async (t) => {
  for (const action of ['add', 'rename', 'delete']) {
    const f = fixture(t);
    await f.build();
    if (action === 'add') { f.write('new.mjs', 'export const added = 1;'); f.git('add', 'new.mjs'); }
    if (action === 'rename') f.git('mv', 'b.mjs', 'renamed.mjs');
    if (action === 'delete') fs.unlinkSync(path.join(f.workspace, 'b.mjs'));
    assert.equal(readStructuralIndexIfCurrent(f.workspace, { home: f.home }), null, action);
  }
});

test('resolver configuration changes invalidate an otherwise unchanged index', async (t) => {
  const f = fixture(t);
  await f.build();
  f.write('package.json', '{"type":"commonjs"}\n');
  assert.equal(readStructuralIndexIfCurrent(f.workspace, { home: f.home }), null);
});

test('a source edit during extraction prevents publication', async (t) => {
  const f = fixture(t);
  const result = await f.build({ extractor: { tier: 'lexical', extract(rel, content) {
    if (rel === 'a.mjs') f.write('a.mjs', 'export const replacement = 1;');
    return lexicalV2(rel, content);
  } } });
  assert.equal(result.written, false);
  assert.equal(readStructuralIndexIfCurrent(f.workspace, { home: f.home }), null);
});

test('a missing index table cannot be reported current', async (t) => {
  const f = fixture(t);
  await f.build();
  fs.unlinkSync(path.join(structuralIndexDir(f.workspace, { home: f.home }), 'symbols.json'));
  assert.equal(readStructuralIndexIfCurrent(f.workspace, { home: f.home }), null);
  assert.equal(readStructuralIndex(f.workspace, { home: f.home, requireCurrent: true }).present, false);
});

test('requested new files supply facts without discovering unrelated untracked files', (t) => {
  const f = fixture(t);
  f.write('new.mjs', "import { c } from './c.mjs';\nexport const fresh = c;\n");
  f.write('unrelated.mjs', 'export const unrelated = 1;');
  const result = buildNeighborhood({ workspace: f.workspace, files: ['new.mjs', 'gone.mjs', '../outside.mjs'] });
  assert.deepEqual(result.files.map((file) => file.rel), ['c.mjs', 'new.mjs']);
  assert.deepEqual(result.files.find((file) => file.rel === 'new.mjs').symbols, ['fresh']);
  assert.deepEqual(result.missing, ['gone.mjs']);
  assert.equal(result.inputs.find((input) => input.rel === 'new.mjs').state, 'new');
  assert.equal(result.inputs.find((input) => input.rel === '../outside.mjs').state, 'excluded');
});
