import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function git(workspace, args, options = {}) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 5000, ...options });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function experimentFixture(t, budget = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'experiment-state-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const primary = path.join(dir, 'primary');
  const workspace = path.join(dir, 'issue');
  const home = path.join(dir, 'home');
  fs.mkdirSync(primary);
  git(primary, ['init', '-b', 'main']);
  git(primary, ['config', 'user.name', 'Experiment']);
  git(primary, ['config', 'user.email', 'experiment@example.invalid']);
  fs.mkdirSync(path.join(primary, 'config'));
  fs.writeFileSync(path.join(primary, 'config/weights.json'), '{"version":1,"weights":[0,0]}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(primary, 'other.txt'), 'original\n');
  fs.writeFileSync(path.join(primary, 'workload.json'), '{"version":1,"rows":[]}\n');
  git(primary, ['add', '.']);
  git(primary, ['commit', '-m', 'Initial']);
  git(primary, ['worktree', 'add', '-b', 'feature/experiment', workspace]);
  fs.chmodSync(path.join(workspace, 'config/weights.json'), 0o600);
  fs.mkdirSync(home);
  const fullPath = path.join(home, 'plan.hplan');
  fs.writeFileSync(fullPath, 'accepted plan');
  const plan = { fullPath, path: fullPath, fm: { plan_id: 'ff4975d3-c9c2-4e26-a6ce-8b1c061ee655', experiment: { candidate: 'config/weights.json', editable_files: ['config/weights.json'], metric: { direction: 'minimize' }, protocol: { minimum_improvement: 0.25 }, target: 0.5, budget: { max_invocations: 8, max_seconds: 300, timeout_seconds: 10, max_repair_reruns: 2, ...budget } } } };
  const acceptedInputs = { version: 1, planId: plan.fm.plan_id, frozenDigest: 'a'.repeat(64), candidate: { path: 'config/weights.json', dimensions: 2 }, workload: { path: 'workload.json' } };
  return { dir, primary, workspace, home, plan, acceptedInputs, write(value, mode = 0o600) { fs.writeFileSync(path.join(workspace, 'config/weights.json'), JSON.stringify({ version: 1, weights: value }) + '\n'); fs.chmodSync(path.join(workspace, 'config/weights.json'), mode); } };
}
