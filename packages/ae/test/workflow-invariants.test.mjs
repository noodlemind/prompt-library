import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers/temp.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const helper = path.join(root, '.cursor/skills/verify-harness/scripts/prove-workflow-invariants.mjs');
const guard = path.join(root, 'packages/ae/lib/intent-sources.mjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function drive(t, args = [], extraEnv = {}) {
  const artifacts = tempDir('workflow-invariants-evidence-');
  t.after(() => fs.rmSync(artifacts, { recursive: true, force: true }));
  const env = { ...process.env, HARNESS_CHECK_ARTIFACT_DIR: artifacts, ...extraEnv };
  const result = spawnSync(process.execPath, [helper, ...args], { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  return { result, artifacts };
}

test('workflow invariant drive proves real failed and successful delivery boundaries', t => {
  const { result, artifacts } = drive(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.passed, true);
  assert.deepEqual(receipt.invariantIds, ['AE-I1', 'AE-I2', 'AE-I3']);
  for (const stage of ['read-without-plan', 'ungated-edit', 'changed-intent', 'recovery-read', 'mixed-recovery', 'compound-before-proof', 'failed-behavior', 'compound-after-failure', 'compound-stale-proof', 'completion-stop']) {
    assert.ok(receipt.steps.some(step => step.stage === stage), stage);
  }
  const observed = stage => receipt.steps.find(step => step.stage === stage).observation;
  assert.equal(observed('read-without-plan').continue, true);
  assert.equal(observed('ungated-edit').hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(observed('changed-intent').checks.find(check => check.id === 'C-intent-sources').pass, false);
  assert.equal(observed('recovery-read').continue, true);
  assert.equal(observed('mixed-recovery').hookSpecificOutput.permissionDecision, 'deny');
  for (const stage of ['compound-before-proof', 'compound-after-failure', 'compound-stale-proof']) assert.equal(observed(stage).pass, false, stage);
  assert.equal(observed('failed-behavior').checks.find(check => check.id === 'behavior').status, 'failed');
  assert.equal(observed('incomplete-stop').hookSpecificOutput.decision, 'block');
  assert.equal(observed('completion-stop').continue, true);
  assert.equal(receipt.lifecycle.outcome, 'passed');
  assert.equal(receipt.lifecycle.cleaned, true);
  for (const owned of receipt.lifecycle.resources) assert.equal(fs.existsSync(owned), false, owned);
  const saved = path.join(artifacts, 'workflow-invariants/drive.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(saved)), receipt);
});

test('negative control detects a real copied guard bypass and preserves original enforcement', t => {
  const original = hash(guard);
  const { result, artifacts } = drive(t, ['--negative-control']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.detected, true);
  assert.equal(receipt.control.baselineBlocked, true);
  assert.equal(receipt.control.unexpectedAllow, true);
  assert.notEqual(receipt.control.acceptedHash, receipt.control.currentHash);
  assert.notEqual(receipt.mutation.originalSha256, receipt.mutation.mutatedSha256);
  const gates = ['control-baseline-blocked', 'control-unexpected-allow'].map(stage => receipt.steps.find(step => step.stage === stage));
  assert.deepEqual(gates.map(step => step.exitCode), [1, 0]);
  assert.deepEqual(gates.map(step => step.observation.checks.find(check => check.id === 'C-intent-sources').pass), [false, true]);
  assert.equal(hash(guard), original);
  assert.equal(receipt.lifecycle.cleaned, true);
  for (const owned of receipt.lifecycle.resources) assert.equal(fs.existsSync(owned), false, owned);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(artifacts, 'workflow-invariants-negative/drive.json'))), receipt);
});

test('negative control cannot report detection when readiness fails', t => {
  const emptyPath = tempDir('workflow-invariants-no-tools-');
  t.after(() => fs.rmSync(emptyPath, { recursive: true, force: true }));
  // Windows environment names are case-insensitive; remove every inherited spelling.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const artifacts = tempDir('workflow-invariants-failed-evidence-');
  t.after(() => fs.rmSync(artifacts, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [helper, '--negative-control'], { cwd: root, env: { ...cleanEnv, PATH: emptyPath, HARNESS_CHECK_ARTIFACT_DIR: artifacts }, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.detected, false);
  assert.equal(receipt.lifecycle.outcome, 'failed');
  assert.equal(receipt.lifecycle.cleaned, true);
  assert.equal(receipt.error.stage, 'doctor');
});
