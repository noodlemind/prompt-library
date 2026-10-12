import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import YAML from 'yaml';
import { tempDir } from './helpers/temp.mjs';
import { packageRoot } from './helpers/cli.mjs';

const root = path.resolve(packageRoot, '../..');
const recipes = ['intent-lock', 'prepare', 'issue-worktree'];

for (const feature of recipes) {
  for (const fail of [false, true]) {
    test(`${feature} drive preserves evidence and cleans its fixtures on ${fail ? 'failure' : 'success'}`, t => {
      const evidenceRoot = tempDir('recipe-evidence-');
      t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
      const result = spawnSync(process.execPath, [`.cursor/skills/verify-harness/scripts/prove-${feature}.mjs`], {
        cwd: root,
        encoding: 'utf8',
        timeout: 40_000,
        env: { ...process.env, HARNESS_DRIVE_EVIDENCE_ROOT: evidenceRoot, HARNESS_DRIVE_FAIL_AFTER: fail ? '1' : '' },
      });
      assert.equal(result.status, fail ? 1 : 0, result.stderr);
      const dir = path.join(evidenceRoot, feature);
      const files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
      assert.equal(files.length, 1);
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      assert.equal(receipt.feature, feature);
      assert.equal(receipt.lifecycle.outcome, fail ? 'failed' : 'passed');
      assert.equal(receipt.lifecycle.doctor.exitCode, 0);
      assert.ok(receipt.lifecycle.commands.length > 0);
      assert.ok(receipt.lifecycle.resources.length >= 3);
      for (const resource of receipt.lifecycle.resources) assert.equal(fs.existsSync(resource), false, resource);
      assert.equal(receipt.lifecycle.cleaned, true);
      if (!fail && feature === 'intent-lock') {
        const drift = receipt.steps.find(step => step.command === 'gate --phase implement after spec rewrite');
        assert.equal(drift.exit, 1);
        assert.equal(drift.check.pass, false);
        assert.ok(receipt.steps.some(step => step.command === 'accepted source amendment' && step.exit === 0));
      }
    });
  }
}

test('each verification recipe is a configured behavioral named check', () => {
  const checks = YAML.parse(fs.readFileSync(path.join(root, '.github/harness/checks.yaml'), 'utf8')).checks;
  for (const feature of recipes) {
    const check = checks[`verify-${feature}`];
    assert.ok(check, feature);
    assert.deepEqual(check.command, ['node', `.cursor/skills/verify-harness/scripts/prove-${feature}.mjs`]);
    assert.equal(check.proof, 'behavior');
  }
});

test('an interrupted drive cancels its child and preserves cleanup evidence', async t => {
  const evidenceRoot = tempDir('recipe-interrupt-');
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['.cursor/skills/verify-harness/scripts/prove-prepare.mjs'], {
    cwd: root,
    env: { ...process.env, HARNESS_DRIVE_EVIDENCE_ROOT: evidenceRoot, HARNESS_DRIVE_PAUSE_AFTER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const closed = once(child, 'close');
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
  t.after(() => clearTimeout(watchdog));
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('verification-ready')) resolve();
    });
    child.once('close', () => reject(new Error('drive exited before its cancellable child started')));
  });
  child.kill('SIGTERM');
  await closed;
  const dir = path.join(evidenceRoot, 'prepare');
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
  assert.equal(receipt.lifecycle.outcome, 'cancelled');
  assert.equal(receipt.lifecycle.cleaned, true);
  for (const resource of receipt.lifecycle.resources) assert.equal(fs.existsSync(resource), false);
});
