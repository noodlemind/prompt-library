import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { applyRetired, syncAssetsToTarget } from '../lib/sync.mjs';
import { parsePlanFrontmatter } from '../lib/plan-parse.mjs';
import { scanPlansForGate } from '../lib/gate.mjs';
import { CONTEXT_PACK_MAX_BYTES, buildContextPack } from '../lib/context-pack.mjs';
import { extractGoalFromPlan } from '../lib/plan-goal.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { createEvidenceBinding, readEvidence, validateEvidence, writeEvidence } from '../lib/evidence.mjs';
import { ensureHarnessDir } from '../lib/session.mjs';
import { installGlobalHarnessShim, globalHarnessShimPath, INSTALL_FIX_HINT } from '../lib/global-bin.mjs';
import { harnessRunnerSource, RUNNER_VERSION, writeHarnessRunner } from '../lib/resolve-harness-bin.mjs';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { recordSkillUsage } from '../lib/telemetry.mjs';
import { mergeVSCodeSettings, parseVSCodeSettings } from '../lib/vscode-settings.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { validatePlanScope } from '../lib/plan-scope.mjs';
import { listCommands } from '../lib/registry.mjs';
import { HELP_COMMAND_ORDER } from '../bin/harness.mjs';
import YAML from 'yaml';
import { approveProject } from '../lib/trust.mjs';
import { tempDir, runHarness, writePlan, packageRoot, binPath } from './helpers/index.mjs';
import {
  writeKnowledgeSolution,
  runIndex,
  writeProductSolution,
  writeChecks,
  writeVersionedPlan,
  initGit,
  runHook,
  runHookWithPolicy,
  hookResponse,
  assertHookBlocked,
  recordSuccessfulEdit,
} from './helpers/cli-fixtures.mjs';

function readEvents(workspace) {
  const eventsPath = path.join(workspace, '.harness', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('orient context-pack includes Goal Intent Contract from active plan', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });

  const result = runHarness([
    'orient',
    '--query',
    'fix example',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.planGoal);
  assert.equal(body.planGoal.intent, 'Fix example safely');
  assert.deepEqual(body.planGoal.success_criteria, ['tests pass']);

  const pack = fs.readFileSync(path.join(workspace, '.harness', 'context-pack.md'), 'utf8');
  assert.match(pack, /## Goal \(Intent Contract\)/);
  assert.match(pack, /Fix example safely/);
  assert.match(pack, /Intent Contract \(excerpt\)/);
});

test('extractGoalFromPlan reads intent contract and frontmatter', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  const plan = loadPlan(workspace, 'docs/plans/2026-05-22-fix-example-plan.md');
  const goal = extractGoalFromPlan(plan);
  assert.equal(goal.planPath, 'docs/plans/2026-05-22-fix-example-plan.md');
  assert.equal(goal.intent, 'Fix example safely');
  assert.deepEqual(goal.success_criteria, ['tests pass']);
  assert.ok(goal.intentContractExcerpt.includes('Fix example'));
});

test('context pack stays within byte budget cap', () => {
  const recall = Array.from({ length: 20 }, (_, i) => ({
    title: `Solution ${i}`,
    path: `knowledge/solutions/cat/s-${i}.md`,
    score: 0.9,
    summary: 'x'.repeat(200),
  }));
  const body = buildContextPack({
    query: 'a'.repeat(500),
    recall,
    plans: Array.from({ length: 10 }, (_, i) => ({
      path: `docs/plans/plan-${i}.md`,
      status: 'in-progress',
      plan_lock: true,
      score: 0.5,
    })),
    activePlan: {
      path: 'docs/plans/active.md',
      status: 'in-progress',
      plan_lock: true,
      phase: 1,
      memoryExcerpt: 'y'.repeat(1500),
    },
    gatePreview: { pass: false, blockedReason: 'blocked'.repeat(50) },
    nextTools: ['harness gate'],
  });
  assert.ok(Buffer.byteLength(body, 'utf8') <= CONTEXT_PACK_MAX_BYTES);
  assert.match(body, /truncated to 2KB budget/);
});

test('context pack truncation never splits a multibyte character, whatever the cut point', () => {
    const multibyte = 'é'.repeat(300) + '✓'.repeat(300) + '€'.repeat(300) + '🎉'.repeat(300);
    for (let pad = 0; pad < 16; pad++) {
    const body = buildContextPack({ query: 'a'.repeat(pad) + multibyte, recall: [], plans: [], learnings: [] });
    assert.ok(
      Buffer.byteLength(body, 'utf8') <= CONTEXT_PACK_MAX_BYTES,
      `pad=${pad}: byte length must stay within the budget`
    );
    assert.ok(!body.includes('�'), `pad=${pad}: no replacement character from a split multibyte sequence`);
  }
});
