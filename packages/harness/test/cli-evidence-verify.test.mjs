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

test('evidence metadata is authoritative and malformed hashed evidence falls back to legacy', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = 'docs/plans/change.md';
  const rel = writeEvidence(workspace, {
    version: 999,
    verifiedAt: '2000-01-01T00:00:00.000Z',
    evidencePath: 'caller-controlled.json',
    plan,
    outcome: 'passed',
    checks: [],
  });
  const generated = JSON.parse(fs.readFileSync(path.join(workspace, rel), 'utf8'));
  assert.equal(generated.version, 2);
  assert.notEqual(generated.verifiedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(generated.evidencePath, rel);

  fs.writeFileSync(path.join(workspace, rel), '{malformed', 'utf8');
  const legacy = path.join(workspace, '.harness', 'evidence', 'change.json');
  fs.writeFileSync(legacy, JSON.stringify({ plan, outcome: 'failed' }), 'utf8');
  assert.equal(readEvidence(workspace, plan)?.outcome, 'failed');
});

test('malformed evidence bindings fail closed without crashing validation', () => {
  const workspace = tempDir('harness-workspace-');
  const planPath = writeVersionedPlan(workspace);
  initGit(workspace);
  const plan = loadPlan(workspace, planPath);
  const binding = createEvidenceBinding({ workspace, plan, base: 'HEAD', changedFiles: [] });
  binding.changedFiles = 'not-an-array';

  const result = validateEvidence({
    workspace,
    plan,
    evidence: {
      version: 2,
      plan: planPath,
      outcome: 'passed',
      verifiedAt: new Date().toISOString(),
      binding,
    },
  });

  assert.equal(result.pass, false);
  assert.match(result.message, /not bound|binding.*invalid/i);
});

test('verify gate requires executed verification evidence, not just a plan heading', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-05-22-fix-example-plan.md'),
    `---
title: "Fix example"
status: in-progress
plan_lock: true
phase: 1
intent: "Fix example safely"
expected_outputs: ["code change"]
success_criteria: ["tests pass"]
---

# Fix example

## Overview

Do the work.

## Acceptance Criteria

- [ ] Example is fixed.

## Verification Plan

Run the relevant test command.

## Activity

- Plan created.
`,
    'utf8'
  );

  const result = runHarness([
    'gate',
    '--phase',
    'verify',
    '--workspace',
    workspace,
    '--json',
  ]);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.exitCode, 1);
  assert.equal(body.checks.find((check) => check.id === 'V1')?.pass, false);
  assert.equal(body.nextTools.includes('harness compound'), false);
});

test('verify gate accepts passed harness evidence, not activity prose', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  const verify = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);
  assert.equal(verify.status, 0, verify.stderr);

  const result = runHarness([
    'gate',
    '--phase',
    'verify',
    '--plan',
    plan,
    '--workspace',
    workspace,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'V1')?.pass, true);
});

test('plan readiness surfaces configured-check errors instead of running named checks', async () => {
  const { validatePlanReadiness } = await import('../lib/plan-readiness.mjs');
  const { loadPlan } = await import('../lib/plan-parse.mjs');
  const workspace = tempDir('harness-readiness-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  const plan = loadPlan(workspace, 'docs/plans/2026-05-22-fix-example-plan.md');
  fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });

  fs.writeFileSync(path.join(workspace, '.github', 'harness', 'checks.yaml'), 'version: 2\nchecks: {}\n');
  const wrongVersion = validatePlanReadiness(workspace, plan);
  assert.equal(wrongVersion.pass, false);
  assert.ok(
    wrongVersion.checks.some((check) => !check.pass && /must declare version: 1/.test(check.message)),
    JSON.stringify(wrongVersion.checks)
  );

  fs.writeFileSync(path.join(workspace, '.github', 'harness', 'checks.yaml'), 'version: 1\nchecks: [not: {valid\n');
  const unparseable = validatePlanReadiness(workspace, plan);
  assert.equal(unparseable.pass, false);
  assert.ok(
    unparseable.checks.some((check) => !check.pass && /Invalid \.github\/harness\/checks\.yaml/.test(check.message)),
    JSON.stringify(unparseable.checks)
  );
});

const primitiveAnalysis = `
- Primitive classification: modify the existing skill because it owns the workflow.
- Existing-capability overlap analysis: reuse the Existing /java skill and Existing /aws skill instead of duplicating them.
- Intended artifact structure: keep the procedure in SKILL.md and dense guidance in a reference.
- Trigger and negative-trigger implications: route migration delivery here; exclude one-off API questions.
- Verification expectations: run prompt, host, and built-asset contracts.
- Registry and documentation impact: update them only if a new skill is justified.
`.trim();

test('verification rejects nested skill changes without existing primitive evidence checks', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/references/guide.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: primitiveAnalysis,
    required: ['unit-tests'],
    criteria: { AC1: ['unit-tests'] },
  });
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
    'prompt-contracts': { command: [process.execPath, '-e', 'process.exit(0)'] },
    'host-contracts': { command: [process.execPath, '-e', 'process.exit(0)'] },
    'build-assets': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  const skill = path.join(workspace, '.github', 'skills', 'example', 'references', 'guide.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '# Guide\n');
  initGit(workspace);
  fs.appendFileSync(skill, '\nChanged guidance.\n');

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'primitive-evidence')?.status, 'failed');
  assert.match(body.checks.find((check) => check.id === 'primitive-evidence')?.message, /prompt-contracts|host-contracts|build-assets/);
});

test('product-local skill verification uses configured local evidence when standard primitive checks are absent', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: primitiveAnalysis,
    required: ['fixture-tests'],
    criteria: { AC1: ['fixture-tests'] },
  });
  writeChecks(workspace, {
    'fixture-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  const skill = path.join(workspace, '.github', 'skills', 'example', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '# Skill\n');
  initGit(workspace);
  fs.appendFileSync(skill, '\nChanged guidance.\n');

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  const primitive = body.checks.find((check) => check.id === 'primitive-evidence');
  assert.equal(primitive?.status, 'passed');
  assert.match(primitive?.message || '', /applicable named evidence/i);
});

test('harness verify passes named checks, validates scope, and writes evidence', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 2;\n');

  const result = runHarness([
    'verify',
    '--plan',
    plan,
    '--base',
    'HEAD',
    '--workspace',
    workspace,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'passed');
  assert.equal(body.plan, plan);
  assert.deepEqual(body.unverifiedCriteria, []);
  assert.deepEqual(body.scopeViolations, []);
  assert.deepEqual(body.openHardGaps, []);
  assert.deepEqual(body.requiredReviews, []);
  assert.ok(body.evidencePath);
  assert.equal(fs.existsSync(path.join(workspace, body.evidencePath)), true);

  // Human output ends with an actionable next command on success (AC30).
  const human = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace]);
  assert.match(human.stdout, /^\[ok\]\s+verify\s+passed/m);
  assert.match(human.stdout, /^-> harness compound/m);
});

test('harness verify --learnings drops empty csv entries into a clean array', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 2;\n');

  const result = runHarness([
    'verify',
    '--plan',
    plan,
    '--base',
    'HEAD',
    '--workspace',
    workspace,
    '--learnings',
    'a/b,,c/d,',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const events = fs
    .readFileSync(path.join(workspace, '.harness', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const verifyEvent = events.find((e) => e.type === 'verify');
  assert.ok(verifyEvent, JSON.stringify(events));
  assert.deepEqual(verifyEvent.learnings, ['a/b', 'c/d']);
});

test('harness verify checks only tasks in the current plan phase', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8').replace(
      '## Impacted Files',
      '### Phase 2 — Follow-up\n\n- [ ] Future task that is not active.\n\n## Impacted Files'
    ),
    'utf8'
  );
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const phaseTasks = JSON.parse(result.stdout).checks.find((check) => check.id === 'phase-tasks');
  assert.equal(phaseTasks.status, 'passed');
  assert.deepEqual(phaseTasks.openTasks, []);
});

test('harness verify rejects array-shaped criterion mappings', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8').replace('  criteria:\n    AC1: ["unit-tests"]', '  criteria: ["unit-tests"]'),
    'utf8'
  );
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const planSchema = JSON.parse(result.stdout).checks.find((check) => check.id === 'plan-schema');
  assert.equal(planSchema.status, 'failed');
  assert.match(planSchema.message, /criterion mappings/i);
});

test('harness verify rejects empty named checks and duplicate acceptance IDs', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace, { required: [], criteria: {} });
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8').replace(
      '- [x] **AC1** Example works.',
      '- [x] **AC1** Example works.\n- [x] **AC1** Duplicate identifier.'
    ),
    'utf8'
  );
  writeChecks(workspace, {});
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const message = JSON.parse(result.stdout).checks.find((check) => check.id === 'plan-schema')?.message || '';
  assert.match(message, /non-empty|unique/i);
});

test('harness verify rejects empty intent arrays on locked plans', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8')
      .replace('expected_outputs:\n  - "verified change"', 'expected_outputs: []')
      .replace('success_criteria:\n  - "AC1 Example works"', 'success_criteria: []'),
    'utf8'
  );
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const message = JSON.parse(result.stdout).checks.find((check) => check.id === 'plan-schema')?.message || '';
  assert.match(message, /expected_outputs|success_criteria/i);
});

test('harness verify returns failed when a required named check fails', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(7)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'failed');
  assert.equal(body.checks.find((check) => check.id === 'unit-tests')?.status, 'failed');
});

test('harness verify returns inconclusive for timeout and exits EXIT.timedOut (8)', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': {
      command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
      timeout_seconds: 1,
    },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

    assert.equal(result.status, 8, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'inconclusive');
  assert.equal(body.checks.find((check) => check.id === 'unit-tests')?.status, 'timeout');
});

test('harness verify is inconclusive when plan selection is ambiguous', () => {
  const workspace = tempDir('harness-workspace-');
  writeVersionedPlan(workspace, { name: 'first-plan.md' });
  writeVersionedPlan(workspace, { name: 'second-plan.md' });
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });

  const result = runHarness(['verify', '--workspace', workspace, '--json']);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'inconclusive');
  assert.match(body.checks.find((check) => check.id === 'plan-selection')?.message, /ambiguous/i);
});

test('harness verify never executes commands authored in a plan', () => {
  const workspace = tempDir('harness-workspace-');
  const marker = path.join(workspace, 'plan-command-ran');
  const markerBase64 = Buffer.from(marker).toString('base64');
  const malicious = `${process.execPath} -e "require('fs').writeFileSync(Buffer.from('${markerBase64}', 'base64'), 'bad')"`;
  const plan = writeVersionedPlan(workspace, {
    extraFrontmatter: `verification_commands:\n  - ${JSON.stringify(malicious)}\n`,
  });
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, 'passed');
  assert.equal(fs.existsSync(marker), false);
});

test('harness verify fails files outside the plan-to-diff scope', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  fs.writeFileSync(path.join(workspace, 'outside.js'), 'export const outside = true;\n');

  const result = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.outcome, 'failed');
  assert.deepEqual(body.scopeViolations, ['outside.js']);
});
