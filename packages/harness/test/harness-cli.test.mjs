import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { syncAssetsToTarget } from '../lib/sync.mjs';
import { parsePlanFrontmatter } from '../lib/plan-parse.mjs';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHarness(args, options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
}

function writePlan(workspace, { frontmatter = '', activity = '- Plan created.' } = {}) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, '2026-05-22-fix-example-plan.md');
  fs.writeFileSync(
    planPath,
    `---
title: "Fix example"
status: in-progress
plan_lock: true
phase: 1
${frontmatter}---

# Fix example

## Overview

Do the work.

## Acceptance Criteria

- [ ] Example is fixed.

## Verification Plan

Run the relevant test command.

## Activity

${activity}
`,
    'utf8'
  );
  return planPath;
}

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

test('help works from a clean repo checkout without installed package deps', () => {
  const result = runHarness(['help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test('recall positional query excludes option values', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const result = runHarness([
    'recall',
    'orders timeout',
    '--limit',
    '3',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).query, 'orders timeout');
});

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

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.equal(body.exitCode, 2);
  assert.equal(body.checks.find((check) => check.id === 'V1')?.pass, false);
});

test('verify gate accepts executed verification evidence in activity', () => {
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

- [x] Example is fixed.

## Verification Plan

Run the relevant test command.

## Activity

- Verification: npm test passed.
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

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.checks.find((check) => check.id === 'V1')?.pass, true);
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

test('orient gate and recall append structured events', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });

  assert.equal(
    runHarness(['orient', '--query', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json']).status,
    0
  );
  assert.equal(runHarness(['gate', '--workspace', workspace, '--json']).status, 0);
  assert.equal(
    runHarness(['recall', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json']).status,
    0
  );

  const events = readEvents(workspace);
  assert.deepEqual(events.map((event) => event.type), ['orient', 'gate', 'recall']);
  for (const event of events) {
    assert.equal(event.version, 1);
    assert.match(event.id, /.+/);
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(['pass', 'warn', 'fail'].includes(event.result));
  }
});

test('event logging can be disabled', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');

  const noEventsResult = runHarness([
    'recall',
    'orders timeout',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--no-events',
    '--json',
  ]);
  const envResult = runHarness(
    ['recall', 'checkout timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json'],
    { env: { HARNESS_NO_EVENTS: '1' } }
  );

  assert.equal(noEventsResult.status, 0, noEventsResult.stderr);
  assert.equal(envResult.status, 0, envResult.stderr);
  assert.deepEqual(readEvents(workspace), []);
});

test('events command returns aggregate json output', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });
  runHarness(['gate', '--workspace', workspace, '--json']);

  const result = runHarness(['events', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.count, 1);
  assert.equal(body.summary.total, 1);
  assert.equal(body.summary.lastActivePlan, 'docs/plans/2026-05-22-fix-example-plan.md');
  assert.equal(body.events[0].type, 'gate');
});

test('events omit prompt and query content entirely', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const query = `${'x'.repeat(130)}SECRET-TAIL`;

  const result = runHarness(['recall', query, '--workspace', workspace, '--copilot-home', copilotHome, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const raw = fs.readFileSync(path.join(workspace, '.harness', 'events.jsonl'), 'utf8');
  const [event] = readEvents(workspace);
  assert.equal(Object.hasOwn(event, 'queryPreview'), false);
  assert.equal(Object.hasOwn(event, 'queryHash'), false);
  assert.equal(raw.includes('orders timeout'), false);
  assert.equal(raw.includes('SECRET-TAIL'), false);
  assert.equal(raw.includes('## Overview'), false);
});

test('preserved knowledge files are not reported as harness-owned', () => {
  const assetsRoot = tempDir('harness-assets-');
  const targetRoot = tempDir('harness-target-');
  const rel = path.join('knowledge', 'solutions', '.gitkeep');
  fs.mkdirSync(path.dirname(path.join(assetsRoot, rel)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(targetRoot, rel)), { recursive: true });
  fs.writeFileSync(path.join(assetsRoot, rel), '', 'utf8');
  fs.writeFileSync(path.join(targetRoot, rel), '', 'utf8');

  const stats = syncAssetsToTarget(
    assetsRoot,
    targetRoot,
    {
      dryRun: false,
      preserveKnowledge: true,
      verbose: false,
    },
    () => {}
  );

  assert.equal(stats.skipped, 1);
  assert.deepEqual(stats.files, []);
});
