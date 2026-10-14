import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildStructuralIndex, readStructuralIndex, structuralIndexDir } from '../lib/repo-map/structural-index.mjs';
import { readStructuralIndex as readShapeIndex } from '../lib/structural/shape.mjs';
import { lexicalV2 } from '../lib/repo-map/treesitter-extractor.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-snapshot-'));
  const workspace = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) {
    const r = spawnSync('git', args, { cwd: workspace, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull } });
    assert.equal(r.status, 0);
  }
  fs.writeFileSync(path.join(workspace, 'a.mjs'), 'export function alpha() {}\n');
  for (const args of [['add', '.'], ['commit', '-qm', 'fixture']]) assert.equal(spawnSync('git', args, { cwd: workspace }).status, 0);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { workspace, home, extractor: { tier: 'lexical', extract: lexicalV2 } };
}

test('a manifest selects immutable tables and repeated builds retain at most two generations', async (t) => {
  const f = fixture(t);
  const root = structuralIndexDir(f.workspace, f);
  const snapshots = [];
  for (const name of ['alpha', 'bravo', 'delta', 'gamma']) {
    fs.writeFileSync(path.join(f.workspace, 'a.mjs'), `export function ${name}() {}\n`);
    const built = await buildStructuralIndex(f);
    assert.equal(built.written, true);
    snapshots.push(readStructuralIndex(f.workspace, f));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
  assert.equal(manifest.generation, snapshots[3].generation);
  assert.equal(new Set(snapshots.map(row => row.dir)).size, 4);
  assert.deepEqual(readShapeIndex(f.workspace, f).files['a.mjs'].symbols, ['gamma']);
  assert.equal(fs.readdirSync(path.join(root, 'generations')).length, 2);
  assert.equal(fs.existsSync(snapshots[2].dir), true);
  assert.equal(fs.existsSync(snapshots[0].dir), false);
});

for (const [name, reader] of [['raw', readStructuralIndex], ['normalized', readShapeIndex]]) {
  test(`${name} reader cannot mix metadata and tables when a writer arrives between reads`, async (t) => {
    const f = fixture(t);
    await buildStructuralIndex(f);
    const before = readStructuralIndex(f.workspace, f);
    fs.writeFileSync(path.join(f.workspace, 'a.mjs'), 'export function bravo() {}\n');
    const original = fs.existsSync;
    let pending;
    let triggered = false;
    let observed;
    try {
      fs.existsSync = (file) => {
        if (!triggered && file === path.join(before.dir, 'files.json')) {
          triggered = true;
          pending = buildStructuralIndex(f);
        }
        return original(file);
      };
      observed = reader(f.workspace, f);
    } finally {
      fs.existsSync = original;
    }
    assert.equal(triggered, true);
    assert.deepEqual(observed.files['a.mjs'].symbols, ['alpha']);
    const refused = await pending;
    assert.equal(refused.written, false);
    const retry = await buildStructuralIndex(f);
    assert.equal(retry.written, true);
    assert.deepEqual(reader(f.workspace, f).files['a.mjs'].symbols, ['bravo']);
  });
}

test('valid JSON with changed table bytes is rejected by both readers', async (t) => {
  const f = fixture(t);
  await buildStructuralIndex(f);
  const before = readStructuralIndex(f.workspace, f);
  fs.writeFileSync(path.join(before.dir, 'files.json'), JSON.stringify({ 'a.mjs': { symbols: ['fabricated'], imports: [] } }));
  const broken = readStructuralIndex(f.workspace, f);
  assert.match(broken.unreadable.join(' '), /integrity/);
  assert.equal(readShapeIndex(f.workspace, f).present, false);
  assert.equal((await buildStructuralIndex(f)).written, true);
  assert.deepEqual(readStructuralIndex(f.workspace, f).files['a.mjs'].symbols, ['alpha']);
});

test('unsafe manifest generation paths cannot escape the structural cache', async (t) => {
  const f = fixture(t);
  const root = structuralIndexDir(f.workspace, f);
  await buildStructuralIndex(f);
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ version: 1, generation: '../../outside', tables: {} }));
  assert.equal(readShapeIndex(f.workspace, f).present, false);
  assert.equal(readStructuralIndex(f.workspace, f), null);
});

test('a dead owner recovers while live and ownerless locks preserve the prior generation', async (t) => {
  const f = fixture(t);
  const root = structuralIndexDir(f.workspace, f);
  await buildStructuralIndex(f);
  const before = readStructuralIndex(f.workspace, f).generation;
  const lock = path.join(root, '.snapshot-lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ token: 'live', pid: process.pid }));
  fs.writeFileSync(path.join(f.workspace, 'a.mjs'), 'export function bravo() {}\n');
  assert.equal((await buildStructuralIndex(f)).written, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'current.json'))).generation, before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).token, 'live');
  fs.unlinkSync(path.join(lock, 'owner.json'));
  assert.equal((await buildStructuralIndex(f)).written, false);
  assert.equal(fs.existsSync(lock), true);
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ token: 'dead', pid: child.pid }));
  assert.equal((await buildStructuralIndex(f)).written, true);
  assert.deepEqual(readStructuralIndex(f.workspace, f).files['a.mjs'].symbols, ['bravo']);
  assert.equal(fs.existsSync(lock), false);
});

test('failed manifest publication keeps the selected generation readable', async (t) => {
  const f = fixture(t);
  const root = structuralIndexDir(f.workspace, f);
  await buildStructuralIndex(f);
  const before = readStructuralIndex(f.workspace, f).generation;
  fs.writeFileSync(path.join(f.workspace, 'a.mjs'), 'export function bravo() {}\n');
  const original = fs.renameSync;
  let attempted = false;
  let result;
  try {
    fs.renameSync = (from, to) => {
      if (to === path.join(root, 'current.json')) {
        attempted = true;
        throw new Error('injected publication failure');
      }
      return original(from, to);
    };
    result = await buildStructuralIndex(f);
  } finally {
    fs.renameSync = original;
  }
  assert.equal(attempted, true);
  assert.equal(result.written, false);
  assert.equal(readStructuralIndex(f.workspace, f).generation, before);
  assert.deepEqual(readStructuralIndex(f.workspace, f).files['a.mjs'].symbols, ['alpha']);
});

for (const missing of ['files.json', 'symbols.json', 'graph.json']) {
  test(`a legacy snapshot missing ${missing} is incomplete for both readers`, async (t) => {
    const f = fixture(t);
    const root = structuralIndexDir(f.workspace, f);
    await buildStructuralIndex(f);
    const snapshot = readStructuralIndex(f.workspace, f);
    for (const name of ['meta.json', 'files.json', 'symbols.json', 'graph.json']) {
      if (name !== missing) fs.copyFileSync(path.join(snapshot.dir, name), path.join(root, name));
    }
    fs.unlinkSync(path.join(root, 'current.json'));
    const raw = readStructuralIndex(f.workspace, f);
    assert.ok(raw.unreadable.some(error => error.includes(`${missing} is missing`)));
    assert.equal(readShapeIndex(f.workspace, f).present, false);
    assert.equal((await buildStructuralIndex(f)).written, true);
    assert.deepEqual(readStructuralIndex(f.workspace, f).files['a.mjs'].symbols, ['alpha']);
  });
}
