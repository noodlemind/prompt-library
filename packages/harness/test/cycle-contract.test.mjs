import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { test } from 'node:test';
import { validateEvidenceBinding } from '../../../.github/hooks/lib/evidence-binding.mjs';
import { runNamedCheck, validateCommand } from '../lib/checks.mjs';
import { createEvidenceBinding } from '../lib/evidence.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { approveProject } from '../lib/trust.mjs';
import { behavioralProof, runVerify } from '../lib/verify.mjs';
import { tempDir } from './helpers/index.mjs';
import { initGit, writeChecks, writeVersionedPlan } from './helpers/cli-fixtures.mjs';

test('validateCommand accepts type-check and rejects any other proof', () => {
  assert.equal(validateCommand('tsc', { command: ['tsc', '--noEmit'], proof: 'type-check' }), null);
  const rejected = validateCommand('tsc', { command: ['tsc', '--noEmit'], proof: 'lint' });
  assert.equal(typeof rejected, 'string');
  assert.match(rejected, /proof/);
});

test('behavioralProof classifies passed type-check and behavior checks', () => {
  assert.equal(behavioralProof([{ id: 'tsc', status: 'passed', proof: 'type-check' }]), 'type-check-only');
  assert.equal(
    behavioralProof([
      { id: 'tests', status: 'passed', proof: 'behavior' },
      { id: 'tsc', status: 'passed', proof: 'type-check' },
    ]),
    'behavior',
  );
  assert.equal(behavioralProof([]), 'unproven');
});

test('stop-hook binding accepts evidence version 3 and rejects a different head', () => {
  const workspace = tempDir('harness-workspace-');
  const planPath = writeVersionedPlan(workspace);
  initGit(workspace);
  const plan = loadPlan(workspace, planPath);
  const binding = createEvidenceBinding({ workspace, plan, base: 'HEAD', changedFiles: [] });
  const evidence = {
    version: 3,
    plan: plan.path,
    outcome: 'passed',
    verifiedAt: new Date().toISOString(),
    binding,
  };
  assert.equal(
    validateEvidenceBinding({ workspace, planPath: plan.path, evidence, maxAgeHours: 24 }),
    null,
  );
  const moved = validateEvidenceBinding({
    workspace,
    planPath: plan.path,
    evidence: { ...evidence, binding: { ...binding, head: 'a'.repeat(40) } },
    maxAgeHours: 24,
  });
  assert.match(moved, /different head/i);
});

test('verify refuses a pass when the git head changes during checks', async () => {
  const workspace = tempDir('harness-head-drift-');
  const home = tempDir('harness-head-drift-home-');
  const plan = writeVersionedPlan(workspace, {
    required: ['move-head'],
    criteria: { AC1: ['move-head'] },
  });
  writeChecks(workspace, {
    'move-head': { command: ['git', 'commit', '--allow-empty', '-m', 'drift'] },
  });
  initGit(workspace);
  approveProject({ workspace, copilotHome: home });
  const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).stdout.trim();

  const result = await runVerify({
    workspace,
    flags: { plan, base: 'HEAD', dryRun: false, enforcement: 'enforce', workspace, copilotHome: home },
  });

  const after = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).stdout.trim();
  assert.notEqual(after, before);
  const moved = result.checks.find((check) => check.id === 'move-head');
  assert.equal(moved.status, 'passed', moved.message);
  const stability = result.checks.find((check) => check.id === 'workspace-stability');
  assert.equal(stability.status, 'failed');
  assert.match(stability.message, /different head/i);
  assert.notEqual(result.outcome, 'passed');
});

test('runNamedCheck copies proof onto the result without spawning tsc', async () => {
  const typed = await runNamedCheck(os.tmpdir(), 'tsc', { command: [], proof: 'type-check' });
  assert.equal(typed.status, 'unavailable');
  assert.equal(typed.proof, 'type-check');

  const omitted = await runNamedCheck(os.tmpdir(), 'tsc', { command: [] });
  assert.equal(omitted.status, 'unavailable');
  assert.equal(omitted.proof, 'behavior');
});
