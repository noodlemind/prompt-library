import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { binPath } from './helpers/cli.mjs';
import { tempDir } from './helpers/temp.mjs';
import { initGit, writeChecks, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { repoId, storeDir, storeDirForId } from '../lib/knowledge/store.mjs';
import { externalPlansDir } from '../lib/project-layout.mjs';
import { externalPlansDir as hookPlansDir } from '../corpus/hooks/lib/external-plans.mjs';

function fixture() {
  const ws = tempDir('storage-alias-workspace-');
  const home = tempDir('storage-alias-home-');
  initGit(ws);
  writeChecks(ws, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  const fromId = 'local-123456789abc';
  const knowledge = path.join(home, 'knowledge', fromId);
  const plans = path.join(home, 'projects', fromId, 'plans');
  fs.mkdirSync(knowledge, { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'consolidated.jsonl'), 'saved ledger\n');
  const rel = writeVersionedPlan(ws);
  const plan = path.join(plans, path.basename(rel));
  fs.renameSync(path.join(ws, rel), plan);
  return { ws, home, fromId, knowledge, plans, plan };
}

function run(c, args) {
  return spawnSync(process.execPath, [binPath, ...args, '--workspace', c.ws, '--harness-home', c.home, '--json', '--no-events'], {
    encoding: 'utf8', env: { ...process.env, HARNESS_HOME: c.home },
  });
}

test('migrate-store adopts old local knowledge and plans without an origin or moving their bytes', () => {
  const c = fixture();
  const saved = fs.readFileSync(c.plan);
  const migrated = run(c, ['knowledge', 'migrate-store', '--from-id', c.fromId]);
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
  assert.equal(JSON.parse(migrated.stdout).preservedInPlace, true);
  assert.equal(storeDir(c.ws, { home: c.home }), c.knowledge);
  assert.equal(storeDirForId(repoId(c.ws), { home: c.home }), c.knowledge);
  assert.equal(externalPlansDir(c.ws, { home: c.home }), c.plans);
  assert.deepEqual(fs.readFileSync(c.plan), saved);
  assert.equal(fs.readFileSync(path.join(c.knowledge, 'consolidated.jsonl'), 'utf8'), 'saved ledger\n');
  const gate = run(c, ['gate', '--plan', c.plan, '--phase', 'implement', '--allow-inplace']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  const previousHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = c.home;
  try { assert.equal(hookPlansDir(c.ws), c.plans); } finally {
    if (previousHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previousHome;
  }
  const linked = path.join(tempDir('storage-alias-linked-'), 'checkout');
  const added = spawnSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: c.ws, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  try {
    assert.equal(repoId(linked), repoId(c.ws));
    assert.equal(storeDir(linked, { home: c.home }), c.knowledge);
    assert.equal(externalPlansDir(linked, { home: c.home }), c.plans);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd: c.ws });
  }
  const replay = run(c, ['knowledge', 'migrate-store', '--from-id', c.fromId]);
  assert.equal(replay.status, 0, replay.stdout + replay.stderr);
});

test('Windows path aliases find old records before adoption and preserve canonical worktree identity', { skip: process.platform !== 'win32' }, () => {
  const c = fixture();
  const aliased = c.ws.toUpperCase();
  const oldId = `local-${crypto.createHash('sha256').update(fs.realpathSync(aliased)).digest('hex').slice(0, 12)}`;
  assert.notEqual(oldId, repoId(aliased), 'fixture must exercise an actual legacy ID change');
  const knowledge = path.join(c.home, 'knowledge', oldId);
  const project = path.join(c.home, 'projects', oldId);
  fs.renameSync(c.knowledge, knowledge);
  fs.renameSync(path.dirname(c.plans), project);
  assert.equal(storeDir(aliased, { home: c.home }), knowledge);
  assert.equal(externalPlansDir(aliased, { home: c.home }), path.join(project, 'plans'));
  const health = run({ ...c, ws: aliased }, ['doctor']);
  const k4 = JSON.parse(health.stdout).checks.find((check) => check.id === 'K4');
  assert.equal(k4.pass, false);
  assert.match(k4.hint, new RegExp(oldId));
  const migrated = run({ ...c, ws: aliased }, ['knowledge', 'migrate-store']);
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
  assert.equal(storeDir(fs.realpathSync.native(c.ws), { home: c.home }), knowledge);
  assert.equal(fs.readFileSync(path.join(knowledge, 'consolidated.jsonl'), 'utf8'), 'saved ledger\n');
});

test('storage adoption supports plans alone and refuses replacement or corrupt bindings', () => {
  const c = fixture();
  fs.rmSync(c.knowledge, { recursive: true });
  const migrated = run(c, ['knowledge', 'migrate-store', `--from-id=${c.fromId}`]);
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
  assert.equal(externalPlansDir(c.ws, { home: c.home }), c.plans);
  const other = 'local-fedcba987654';
  fs.mkdirSync(path.join(c.home, 'projects', other), { recursive: true });
  fs.writeFileSync(path.join(c.home, 'projects', other, 'keep.txt'), 'other bytes\n');
  const replaced = run(c, ['knowledge', 'migrate-store', '--from-id', other]);
  assert.equal(replaced.status, 1, replaced.stdout + replaced.stderr);
  assert.equal(externalPlansDir(c.ws, { home: c.home }), c.plans);
  const binding = path.join(c.home, 'storage-aliases', `${repoId(c.ws)}.json`);
  fs.writeFileSync(binding, '{broken');
  assert.throws(() => externalPlansDir(c.ws, { home: c.home }), /invalid or unreadable storage alias/);
  const invalid = run(c, ['knowledge', 'migrate-store', '--from-id', c.fromId]);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.equal(fs.existsSync(c.plan), true);
});

test('storage adoption refuses symlinked stores and canonical data appearing after adoption', () => {
  const c = fixture();
  const outside = tempDir('storage-alias-outside-');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside bytes\n');
  fs.rmSync(c.knowledge, { recursive: true });
  fs.symlinkSync(outside, c.knowledge, process.platform === 'win32' ? 'junction' : 'dir');
  const unsafe = run(c, ['knowledge', 'migrate-store', '--from-id', c.fromId]);
  assert.equal(unsafe.status, 1, unsafe.stdout + unsafe.stderr);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside bytes\n');
  fs.rmSync(c.knowledge);
  assert.equal(run(c, ['knowledge', 'migrate-store', '--from-id', c.fromId]).status, 0);
  const canonical = path.join(c.home, 'knowledge', repoId(c.ws));
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'keep.txt'), 'new canonical bytes\n');
  assert.throws(() => storeDir(c.ws, { home: c.home }), /non-empty/);
  assert.equal(fs.readFileSync(path.join(canonical, 'keep.txt'), 'utf8'), 'new canonical bytes\n');
  assert.equal(fs.existsSync(c.plan), true);
});

test('concurrent adoption publishes one immutable binding without changing either source', async () => {
  const c = fixture();
  const other = 'local-fedcba987654';
  const otherDir = path.join(c.home, 'projects', other);
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'keep.txt'), 'other bytes\n');
  const adopt = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, 'knowledge', 'migrate-store', '--from-id', id,
      '--workspace', c.ws, '--harness-home', c.home, '--json', '--no-events'], { env: { ...process.env, HARNESS_HOME: c.home } });
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout }));
  });
  const results = await Promise.all([adopt(c.fromId), adopt(other)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 1], JSON.stringify(results));
  const successful = JSON.parse(results.find((result) => result.status === 0).stdout);
  assert.equal(storeDir(c.ws, { home: c.home }), path.join(c.home, 'knowledge', successful.fromId));
  assert.equal(fs.readFileSync(path.join(c.knowledge, 'consolidated.jsonl'), 'utf8'), 'saved ledger\n');
  assert.equal(fs.readFileSync(path.join(otherDir, 'keep.txt'), 'utf8'), 'other bytes\n');
  assert.equal(fs.existsSync(c.plan), true);
});

test('migrate-store refuses canonical data conflicts and source IDs that escape the home', () => {
  const c = fixture();
  const current = path.join(c.home, 'projects', repoId(c.ws));
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, 'keep.txt'), 'canonical bytes\n');
  const conflict = run(c, ['knowledge', 'migrate-store', '--from-id', c.fromId]);
  assert.equal(conflict.status, 1, conflict.stdout + conflict.stderr);
  assert.equal(fs.readFileSync(path.join(current, 'keep.txt'), 'utf8'), 'canonical bytes\n');
  assert.equal(fs.readFileSync(path.join(c.knowledge, 'consolidated.jsonl'), 'utf8'), 'saved ledger\n');
  assert.equal(fs.existsSync(c.plan), true);
  for (const fromId of ['../escape', 'remote-store', 'local-123456789abg']) {
    const invalid = run(c, ['knowledge', 'migrate-store', '--from-id', fromId]);
    assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
  }
});
