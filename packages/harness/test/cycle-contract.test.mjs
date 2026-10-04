import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { validateEvidenceBinding } from '../../../.github/hooks/lib/evidence-binding.mjs';
import { runNamedCheck, validateCommand } from '../lib/checks.mjs';
import { createEvidenceBinding } from '../lib/evidence.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { behavioralProof } from '../lib/verify.mjs';
import { tempDir } from './helpers/index.mjs';
import { initGit, writeVersionedPlan } from './helpers/cli-fixtures.mjs';

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

test('runNamedCheck copies proof onto the result without spawning tsc', async () => {
  const typed = await runNamedCheck(os.tmpdir(), 'tsc', { command: [], proof: 'type-check' });
  assert.equal(typed.status, 'unavailable');
  assert.equal(typed.proof, 'type-check');

  const omitted = await runNamedCheck(os.tmpdir(), 'tsc', { command: [] });
  assert.equal(omitted.status, 'unavailable');
  assert.equal(omitted.proof, 'behavior');
});
