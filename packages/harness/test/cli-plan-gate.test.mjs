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
  primitiveAnalysis,
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

test('plan frontmatter parser handles strings and inline arrays', () => {
  const fm = parsePlanFrontmatter(`---
title: "Fix example"
intent: "Make intent parseable"
expected_outputs: ["gate warning", "event log"]
success_criteria: [tests pass, "json output"]
verification_commands: []
org_objectives: ["platform reliability"]
---
`);

  assert.equal(fm.intent, 'Make intent parseable');
  assert.deepEqual(fm.expected_outputs, ['gate warning', 'event log']);
  assert.deepEqual(fm.success_criteria, ['tests pass', 'json output']);
  assert.deepEqual(fm.verification_commands, []);
  assert.deepEqual(fm.org_objectives, ['platform reliability']);
});

test('validate-plan reports malformed YAML frontmatter as a schema failure', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('title: "Verify example"', 'title: [unterminated'));

  const result = runHarness(['validate-plan', '--plan', plan, '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.match(body.checks.find((check) => check.id === 'P-schema')?.message || '', /Invalid YAML frontmatter/i);
});

test('gate rejects malformed policy files and invalid enforcement overrides', () => {
  const workspace = tempDir('harness-workspace-');
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'policy.yaml'), 'version: 1\nenforcement: [unterminated\n', 'utf8');

  const malformed = runHarness(['gate', '--workspace', workspace, '--json']);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Invalid harness policy/i);

  fs.writeFileSync(path.join(configDir, 'policy.yaml'), 'enforcement: enforce\n', 'utf8');
  const missingVersion = runHarness(['gate', '--workspace', workspace, '--json']);
  assert.equal(missingVersion.status, 1);
  assert.match(missingVersion.stderr, /expected version 1/i);

  fs.writeFileSync(path.join(configDir, 'policy.yaml'), 'version: 1\nenforcement: enforce\n', 'utf8');
  const invalidOverride = runHarness(['gate', '--enforcement=warn=typo', '--workspace', workspace, '--json']);
  assert.equal(invalidOverride.status, 1);
  assert.match(invalidOverride.stderr, /Invalid enforcement mode: warn=typo/i);
});

test('gate scan skips malformed plan frontmatter and continues to a locked plan', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'a-malformed.md'), '---\ntitle: [unterminated\n---\n', 'utf8');
  fs.writeFileSync(path.join(plansDir, 'b-locked.md'), '---\nplan_lock: true\n---\n', 'utf8');

  assert.equal(scanPlansForGate(workspace), 'docs/plans/b-locked.md');
});

test('harness artifact paths do not collide for same-named plans in different directories', () => {
  const workspace = tempDir('harness-workspace-');
  const first = writeEvidence(workspace, { plan: 'docs/plans/team-a/change.md', outcome: 'passed', checks: [] });
  const second = writeEvidence(workspace, { plan: 'docs/plans/team-b/change.md', outcome: 'failed', checks: [] });

  assert.notEqual(first, second);
  assert.equal(readEvidence(workspace, 'docs/plans/team-a/change.md')?.outcome, 'passed');
  assert.equal(readEvidence(workspace, 'docs/plans/team-b/change.md')?.outcome, 'failed');
});

test('harness gitignore matching uses complete lines and preserves missing newline boundaries', () => {
  const workspace = tempDir('harness-workspace-');
  const harnessDir = path.join(workspace, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(path.join(harnessDir, '.gitignore'), '# evidence/ is documented here\ncontext-pack.md', 'utf8');

  ensureHarnessDir(workspace, false);

  const lines = fs.readFileSync(path.join(harnessDir, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(lines.includes('context-pack.md'));
  assert.ok(lines.includes('events.jsonl'));
  assert.ok(lines.includes('evidence/'));
  assert.ok(lines.includes('session.json'));
});

test('gate rejects unsupported phases instead of bypassing lifecycle checks', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const result = runHarness(['gate', '--phase', 'typo', '--plan', plan, '--workspace', workspace, '--json']);

    assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /invalid --phase/i);
});

test('implement gate rejects a terminal explicit plan', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  const full = path.join(workspace, plan);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('status: in-progress', 'status: done'), 'utf8');

  const result = runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']);

  assert.equal(result.status, 1, result.stderr);
  assert.match(JSON.parse(result.stdout).blockedReason, /not implementable/i);
});

test('gate warns by default when locked plan lacks intent contract', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace);

  const result = runHarness(['gate', '--workspace', workspace, '--json']);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.equal(body.exitCode, 2);
  assert.equal(body.checks.find((check) => check.id === 'I1')?.severity, 'warn');
  assert.equal(body.checks.find((check) => check.id === 'I2')?.severity, 'warn');
  assert.equal(body.checks.find((check) => check.id === 'I3')?.severity, 'warn');
});

test('gate strict intent fails when locked plan lacks intent contract', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace);

  const result = runHarness(['gate', '--workspace', workspace, '--strict-intent', '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.checks.find((check) => check.id === 'I1')?.severity, 'fail');
});

test('gate passes intent checks when locked plan has intent contract', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });

  const result = runHarness(['gate', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'I1')?.pass, true);
  assert.equal(body.checks.find((check) => check.id === 'I2')?.pass, true);
  assert.equal(body.checks.find((check) => check.id === 'I3')?.pass, true);
});

test('gate directs a planned plan through in-progress and a fresh gate before edits', () => {
  const workspace = tempDir('harness-workspace-');
  const planPath = writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace('status: in-progress', 'status: planned'));

  const result = runHarness(['gate', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.match(body.nextTools[0], /status to in-progress/i);
  assert.match(body.nextTools[1], /harness gate --phase implement/i);
  assert.match(body.nextTools[2], /only after the fresh gate passes/i);
});

test('validate-plan strict-intent fails locked plan with empty intent contract', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, 'empty-intent-plan.md'),
    `---
title: "Empty intent"
status: planned
plan_lock: true
phase: 1
intent: "Do something"
success_criteria: ["done"]
expected_outputs: ["change"]
---

# Empty intent

## Overview

Overview text.

## Intent Contract

- **Goal:**
- **Expected outputs:**
- **Success criteria:**

## Acceptance Criteria

- [ ] Done.

## Verification Plan

Run tests.

## Impacted Files

- src/example.ts

## Activity

- Created.
`,
    'utf8'
  );

  const result = runHarness([
    'validate-plan',
    '--plan',
    'docs/plans/empty-intent-plan.md',
    '--workspace',
    workspace,
    '--strict-intent',
    '--json',
  ]);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.checks.find((c) => c.id === 'S5')?.pass, false);
});

test('validate-plan fails when required sections missing', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, 'bad-plan.md'),
    `---
title: "Bad"
status: open
plan_lock: false
---

# Bad

## Overview

Only overview.
`,
    'utf8'
  );

  const result = runHarness([
    'validate-plan',
    '--plan',
    'docs/plans/bad-plan.md',
    '--workspace',
    workspace,
    '--json',
  ]);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.checks.find((c) => c.id === 'P-schema')?.pass, false);
  assert.equal(body.checks.find((c) => c.id === 'S2')?.pass, false);
});

test('validate-plan passes a complete versioned locked plan', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const result = runHarness(['validate-plan', '--plan', plan, '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.equal(body.checks.find((c) => c.id === 'S4')?.pass, true);
});

test('validate-plan and gate reject pre-completed planned work and output-irrelevant checks', () => {
  const workspace = tempDir('harness-workspace-');
  const sentinel = path.join(workspace, 'schema-check-ran');
  const plan = writeVersionedPlan(workspace, {
    required: ['schema-validation'],
    criteria: { AC1: ['schema-validation'] },
    impacted: ['docs/upgrade-guide.md'],
  });
  writeChecks(workspace, {
    'fixture-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
    'schema-validation': { command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`] },
  });
  const full = path.join(workspace, plan);
  fs.writeFileSync(
    full,
    fs
      .readFileSync(full, 'utf8')
      .replace('status: in-progress', 'status: planned')
      .replace('  - "verified change"', '  - "docs/upgrade-guide.md"'),
    'utf8'
  );

  const invalid = runHarness(['validate-plan', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(invalid.status, 1, invalid.stderr);
  const invalidBody = JSON.parse(invalid.stdout);
  assert.match(invalidBody.blockedReason, /planned plan cannot claim completed work/i);
  assert.match(invalidBody.blockedReason, /schema-focused check schema-validation is not relevant/i);

  const invalidGate = runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(invalidGate.status, 1, invalidGate.stderr);
  assert.match(JSON.parse(invalidGate.stdout).blockedReason, /schema-focused check schema-validation is not relevant/i);

  const invalidVerify = runHarness(['verify', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(invalidVerify.status, 1, invalidVerify.stderr);
  const invalidVerifyBody = JSON.parse(invalidVerify.stdout);
  assert.equal(invalidVerifyBody.checks.find((check) => check.id === 'plan-readiness')?.status, 'failed');
  assert.equal(fs.existsSync(sentinel), false, 'irrelevant named check must not execute');

  fs.writeFileSync(
    full,
    fs
      .readFileSync(full, 'utf8')
      .replaceAll('schema-validation', 'fixture-tests')
      .replace('- [x] **AC1**', '- [ ] **AC1**')
      .replace('- [x] Implement the example.', '- [ ] Implement the example.'),
    'utf8'
  );
  const valid = runHarness(['validate-plan', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).pass, true);
  const validGate = runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(validGate.status, 0, validGate.stderr);
  assert.equal(JSON.parse(validGate.stdout).pass, true);
});

test('scope treats the active plan as governance metadata while enforcing product paths', () => {
  const workspace = tempDir('harness-workspace-');
  initGit(workspace);
  const planPath = writeVersionedPlan(workspace, { impacted: ['src/example.js'] });
  fs.appendFileSync(path.join(workspace, 'src', 'example.js'), 'export const changed = true;\n');
  const plan = loadPlan(workspace, planPath);

  const scope = validatePlanScope({ workspace, plan, base: 'HEAD' });

  assert.equal(scope.status, 'passed');
  assert.ok(scope.changedFiles.includes(planPath));
  assert.deepEqual(scope.violations, []);
});

test('implement gate requires create-primitive and plan analysis for primitive paths', () => {
  const workspace = tempDir('harness-workspace-');
  let plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
  });
  let result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 1, result.stderr);
  let body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'PR1')?.pass, false);

  plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
  });
  result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 1, result.stderr);
  body = JSON.parse(result.stdout);
  assert.ok(body.checks.some((check) => check.id.startsWith('PR') && !check.pass));

  plan = writeVersionedPlan(workspace, {
    impacted: ['.github/skills/example/SKILL.md'],
    skillsUsed: ['engineer', 'create-primitive'],
    technicalNotes: primitiveAnalysis,
  });
  result = runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(result.status, 0, result.stderr);
  body = JSON.parse(result.stdout);
  assert.ok(body.checks.filter((check) => check.id.startsWith('PR')).every((check) => check.pass));
});

test('plan parser uses YAML semantics for block arrays and nested mappings', () => {
  const fm = parsePlanFrontmatter(`---
plan_schema: 1
expected_outputs:
  - first output
  - second output
verification:
  required:
    - unit-tests
  criteria:
    AC1: [unit-tests]
---
`);

  assert.equal(fm.plan_schema, 1);
  assert.deepEqual(fm.expected_outputs, ['first output', 'second output']);
  assert.deepEqual(fm.verification.required, ['unit-tests']);
  assert.deepEqual(fm.verification.criteria.AC1, ['unit-tests']);
});

test('gate honors an explicit plan instead of stale session state', () => {
  const workspace = tempDir('harness-workspace-');
  const first = writeVersionedPlan(workspace, { name: 'first-plan.md' });
  const second = writeVersionedPlan(workspace, { name: 'second-plan.md' });
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify({ activePlan: first }));

  const result = runHarness(['gate', '--plan', second, '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).plan.path, second);
});

test('automatic plan selection ignores terminal session state', () => {
  const workspace = tempDir('harness-workspace-');
  const stale = writeVersionedPlan(workspace, { name: 'a-stale-plan.md' });
  const active = writeVersionedPlan(workspace, { name: 'z-active-plan.md' });
  const stalePath = path.join(workspace, stale);
  fs.writeFileSync(stalePath, fs.readFileSync(stalePath, 'utf8').replace('status: in-progress', 'status: done'), 'utf8');
  const activePath = path.join(workspace, active);
  fs.writeFileSync(activePath, fs.readFileSync(activePath, 'utf8').replace('status: in-progress', 'status: review'), 'utf8');
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify({ activePlan: stale }), 'utf8');

  const result = runHarness(['validate-plan', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).plan.path, active);
});

test('plan loading rejects symlinks that escape docs/plans', () => {
  const workspace = tempDir('harness-workspace-');
  const outside = path.join(workspace, 'outside-plan.md');
  fs.writeFileSync(outside, '# outside\n', 'utf8');
  const plans = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plans, { recursive: true });
  fs.symlinkSync(outside, path.join(plans, 'escape.md'));

  assert.equal(loadPlan(workspace, 'docs/plans/escape.md'), null);

  fs.mkdirSync(path.join(plans, 'directory.md'));
  assert.equal(loadPlan(workspace, 'docs/plans/directory.md'), null);
});

test('warn and observe enforcement preserve failed outcome without blocking rollout', () => {
  for (const enforcement of ['warn', 'observe']) {
    const workspace = tempDir('harness-workspace-');
    const plan = writeVersionedPlan(workspace);
    writeChecks(workspace, {
      'unit-tests': { command: [process.execPath, '-e', 'process.exit(9)'] },
    });
    initGit(workspace);

    const result = runHarness([
      'verify',
      '--plan',
      plan,
      '--base',
      'HEAD',
      '--enforcement',
      enforcement,
      '--workspace',
      workspace,
      '--json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.outcome, 'failed');
    assert.equal(body.enforcement, enforcement);
  }
});

test('warn and observe enforcement preserve gate and plan-validation failures without blocking rollout', () => {
  for (const enforcement of ['warn', 'observe']) {
    const workspace = tempDir('harness-workspace-');
    const gate = runHarness(['gate', '--enforcement', enforcement, '--workspace', workspace, '--json']);
    assert.equal(gate.status, 0, gate.stderr);
    const gateBody = JSON.parse(gate.stdout);
    assert.equal(gateBody.pass, false);
    assert.equal(gateBody.enforcement, enforcement);

    const validate = runHarness(['validate-plan', '--enforcement', enforcement, '--workspace', workspace, '--json']);
    assert.equal(validate.status, 0, validate.stderr);
    const validateBody = JSON.parse(validate.stdout);
    assert.equal(validateBody.pass, false);
    assert.equal(validateBody.enforcement, enforcement);
  }
});
