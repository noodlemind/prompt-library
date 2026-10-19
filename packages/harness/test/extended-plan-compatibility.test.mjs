import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';

const fixtureDir = path.join(import.meta.dirname, 'fixtures');
const artifact = path.join(fixtureDir, 'prior-harness-0.10.0-af448f3.tgz');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function priorPackage(t) {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prior-compat-'));
  const root = fs.realpathSync(rawRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = JSON.parse(fs.readFileSync(artifact.replace(/\.tgz$/, '.json'), 'utf8'));
  assert.equal(metadata.sourceCommit, 'af448f395493eb5ef5cc20c84221e67d0f4fc0ae');
  assert.equal(metadata.packageVersion, '0.10.0');
  assert.equal(digest(fs.readFileSync(artifact)), '4fd0e5075a18e53a02c45a59347ccb24a6ce4853808831e46c70f78dd3bd2bb9');
  assert.equal(spawnSync('tar', ['-xzf', artifact, '-C', root]).status, 0);
  const bin = path.join(root, 'package/bin/harness.mjs');
  const workspace = path.join(root, 'product');
  fs.mkdirSync(workspace);
  initGit(workspace);
  const env = { ...process.env, HARNESS_HOME: path.join(root, 'home'), COPILOT_HOME: path.join(root, 'copilot'), HARNESS_NO_EVENTS: '1' };
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--workspace', workspace, '--json'], { env, cwd: workspace, encoding: 'utf8', timeout: 15_000 });
  assert.equal(cli('--version').stdout.trim(), '0.10.0');
  return { root, rawRoot, workspace, cli };
}

test('the packaged prior reader has a live legacy mutation path for unsupported Markdown schemas', t => {
  const f = priorPackage(t);
  const rel = writeVersionedPlan(f.workspace);
  const full = path.join(f.workspace, rel);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('plan_schema: 1', 'plan_schema: 3'));
  const before = fs.readFileSync(full);
  const result = f.cli('plan-update', '--plan', full, '--activity', 'compatibility canary');
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(digest(fs.readFileSync(full)), digest(before), 'control must demonstrate why a schema field alone is insufficient');
});

for (const schema of [3, 4]) test(`the prior packaged CLI refuses every work-bearing path for extended schema ${schema}`, t => {
  const f = priorPackage(t);
  const rel = writeVersionedPlan(f.workspace, { name: `2026-10-12-feat-extended-${schema}-plan.hplan` });
  const full = path.join(f.workspace, rel);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('plan_schema: 1', `plan_schema: ${schema}`).replace('plan_lock: true', 'plan_lock: false'));
  const before = fs.readFileSync(full);
  const decision = path.join(f.root, 'decision.json');
  fs.writeFileSync(decision, JSON.stringify({ version: 1, id: `unsupported-${schema}`, expect: digest(before), action: 'amend', rationale: 'Canary.', changes: { notes: { context: 'Should never publish.' } } }));
  const commands = [
    ['plan-update', '--plan', full, '--activity', 'should not appear'],
    ['plan-update', '--plan', full, '--status', 'planned'],
    ['plan-update', '--plan', full, '--lock', 'true'],
    ['plan-update', '--plan', full, '--file', decision],
    ['plan-new', '--from', full],
    ['gate', '--plan', full, '--phase', 'implement'],
    ['verify', '--plan', full, '--base', 'HEAD'],
  ];
  for (const args of commands) {
    const result = f.cli(...args);
    assert.notEqual(result.status, 0, `${args[0]} unexpectedly accepted the extended plan: ${result.stdout} ${result.stderr}`);
    assert.deepEqual(fs.readFileSync(full), before, `${args[0]} mutated an unsupported guarantee`);
  }
});

for (const schema of [99, 3, 4]) test(`the current CLI refuses schema ${schema} through canonical and alias legacy from flags`, t => {
  const f = priorPackage(t);
  const rel = writeVersionedPlan(f.workspace, { name: '2026-10-12-feat-future-contract-plan.hplan' });
  const full = path.join(f.workspace, rel);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('plan_schema: 1', `plan_schema: ${schema}`).replace('plan_lock: true', 'plan_lock: false'));
  const before = fs.readFileSync(full);
  const currentBin = path.resolve(import.meta.dirname, '../bin/harness.mjs');
  const paths = new Set([full, fs.realpathSync.native(full), path.join(f.rawRoot, 'product', rel)]);
  for (const planPath of paths) {
    const result = spawnSync(process.execPath, [currentBin, 'plan-new', '--from', planPath, '--workspace', f.workspace, '--harness-home', path.join(f.root, 'current-home'), '--copilot-home', path.join(f.root, 'current-copilot'), '--json', '--no-events'], { encoding: 'utf8', timeout: 15_000 });
    assert.deepEqual(fs.readFileSync(full), before);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /extended plans require an authored plan-update --file decision/i);
  }
});
