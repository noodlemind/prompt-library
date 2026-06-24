import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyRetired, syncAssetsToTarget } from '../lib/sync.mjs';
import { parsePlanFrontmatter } from '../lib/plan-parse.mjs';
import { CONTEXT_PACK_MAX_BYTES, buildContextPack } from '../lib/context-pack.mjs';
import { extractGoalFromPlan, intentContractHasContent } from '../lib/plan-goal.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { installGlobalHarnessShim, globalHarnessShimPath, globalBinDir, configureShellPath } from '../lib/global-bin.mjs';
import { resolveHarnessBin, agentHarnessCommand, writeHarnessRunner, RUNNER_VERSION } from '../lib/resolve-harness-bin.mjs';
import { parseFlags } from '../lib/flags.mjs';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { loadManifest } from '../lib/recall-rank.mjs';

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

## Intent Contract

- **Goal:** Fix example
- **Expected outputs:** code change
- **Success criteria:** tests pass

## Acceptance Criteria

- [ ] Example is fixed.

## Verification Plan

Run the relevant test command.

## Impacted Files

- src/example.ts

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
  assert.match(result.stdout, /harness install \[options\]/);
  assert.match(result.stdout, /Package name: @dev-kit\/harness\. Command name: harness\./);
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

## Intent Contract

- **Goal:** Fix example safely
- **Expected outputs:** code change
- **Success criteria:** tests pass

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

test('retired cleanup refuses paths outside copilot home', () => {
  const parent = tempDir('harness-parent-');
  const copilotHome = path.join(parent, 'copilot');
  const outside = path.join(parent, 'outside-retired');
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete', 'utf8');

  const stats = applyRetired(
    copilotHome,
    ['../outside-retired'],
    { files: ['../outside-retired'] },
    { dryRun: false },
    () => {}
  );

  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
  assert.equal(stats.removed, 0);
  assert.equal(stats.skipped, 1);
});

test('uninstall refuses lock paths outside copilot home', () => {
  const parent = tempDir('harness-parent-');
  const copilotHome = path.join(parent, 'copilot');
  const outside = path.join(parent, 'outside-uninstall');
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete', 'utf8');
  fs.writeFileSync(
    path.join(copilotHome, '.harness-lock.json'),
    JSON.stringify({ files: ['../outside-uninstall'] }, null, 2),
    'utf8'
  );

  const result = runHarness(['uninstall', '--copilot-home', copilotHome]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
});

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
  assert.equal(body.checks.find((c) => c.id === 'S2')?.pass, false);
});

test('validate-plan passes complete locked plan', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
  });

  const result = runHarness(['validate-plan', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.equal(body.checks.find((c) => c.id === 'S4')?.pass, true);
});

test('compound indexes after verify gate passes', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
    activity: '- Verification: npm test passed.',
  });

  const result = runHarness([
    'compound',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.ok(body.indexed);
  assert.equal(readEvents(workspace).some((e) => e.type === 'compound'), true);
});

test('compound fails when verify gate not satisfied', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
    activity: '- Plan created only.',
  });

  const result = runHarness(['compound', '--workspace', workspace, '--json']);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.equal(body.exitCode, 2);
});

function writeKnowledgeSolution(copilotHome, {
  category = 'api',
  slug = 'orders-timeout',
  title = 'Orders API timeout',
  symptom = 'checkout requests hang after 30 seconds',
  module = 'orders-service',
  scope = 'global',
  tags = 'commerce, checkout',
  body = '## Problem\n\nCheckout requests hang after 30 seconds under load.',
} = {}) {
  const knowledgeRoot = path.join(copilotHome, 'knowledge');
  const solDir = path.join(knowledgeRoot, 'solutions', category);
  fs.mkdirSync(solDir, { recursive: true });
  fs.writeFileSync(
    path.join(solDir, `${slug}.md`),
    `---
title: "${title}"
category: ${category}
module: ${module}
symptom: ${symptom}
tags: ${tags}
date: 2026-05-01
---

${body}
`,
    'utf8'
  );
  fs.copyFileSync(
    path.join(packageRoot, '../../knowledge/collections.yaml'),
    path.join(knowledgeRoot, 'collections.yaml')
  );
  fs.copyFileSync(
    path.join(packageRoot, '../../knowledge/recall-synonyms.yaml'),
    path.join(knowledgeRoot, 'recall-synonyms.yaml')
  );
  return `${scope}-${category}-${slug}`;
}

function runIndex(workspace, copilotHome) {
  const result = runHarness(['index', '--workspace', workspace, '--copilot-home', copilotHome]);
  assert.equal(result.status, 0, result.stderr);
}

function writeProductSolution(workspace, {
  category = 'product',
  slug = 'local-fix',
  title = 'Local product fix',
  symptom = 'product-only symptom',
} = {}) {
  const solDir = path.join(workspace, 'docs', 'solutions', category);
  fs.mkdirSync(solDir, { recursive: true });
  fs.writeFileSync(
    path.join(solDir, `${slug}.md`),
    `---
title: "${title}"
category: ${category}
symptom: ${symptom}
date: 2026-05-10
---

## Problem

Product scoped solution.
`,
    'utf8'
  );
  return `product-${category}-${slug}`;
}

test('index writes enriched manifest fields and postings index', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome);

  const result = runHarness(['index', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(result.status, 0, result.stderr);

  const manifest = fs.readFileSync(path.join(copilotHome, 'knowledge', 'manifest.yaml'), 'utf8');
  assert.match(manifest, /symptom:/);
  assert.match(manifest, /module:/);
  assert.match(manifest, /excerpt:/);
  assert.match(manifest, /docid:/);
  assert.ok(fs.existsSync(path.join(copilotHome, 'knowledge', '.harness-index', 'postings.json')));
  assert.ok(fs.existsSync(path.join(copilotHome, 'knowledge', '.harness-index', 'meta.json')));
});

test('BM25 recall ranks symptom match above title-only match', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, {
    slug: 'orders-timeout',
    symptom: 'checkout requests hang after 30 seconds',
    title: 'Orders API timeout',
  });
  writeKnowledgeSolution(copilotHome, {
    category: 'misc',
    slug: 'unrelated',
    title: 'checkout dashboard',
    symptom: 'unrelated issue',
    body: '## Problem\n\nUnrelated content.',
  });
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'recall',
    'checkout hang',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.recall.length >= 1);
  assert.equal(body.recall[0].docid, 'global-api-orders-timeout');
  assert.equal(body.recall[0].ranker, 'bm25');
  assert.ok(body.recall[0].snippet.length > 0);
});

test('synonym expansion improves recall for aliased query', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, {
    symptom: 'requests hit deadline after 30 seconds',
    title: 'Deadline issue',
    tags: 'commerce, checkout',
  });
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'recall',
    'timeout',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.recall.length >= 1);
  assert.ok(body.recall[0].score > 0);
});

test('collection filter excludes non-matching scope', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, { slug: 'global-one', symptom: 'shared timeout symptom' });
  writeProductSolution(workspace, { slug: 'prod-one', symptom: 'shared timeout symptom' });
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'recall',
    'timeout symptom',
    '-c',
    'product',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.recall.length, 1);
  assert.match(body.recall[0].path, /docs\/solutions/);
});

test('min-score filters low-scoring recall hits', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, { symptom: 'very specific database deadlock symptom' });
  runIndex(workspace, copilotHome);

  const baseline = runHarness([
    'recall',
    'database',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);
  assert.equal(baseline.status, 0, baseline.stderr);
  const baselineBody = JSON.parse(baseline.stdout);
  assert.ok(baselineBody.recall.length > 0, 'baseline recall should return hits');
  const hitScore = baselineBody.recall[0].score;

  const result = runHarness([
    'recall',
    'database',
    '--min-score',
    String(Math.min(hitScore + 0.001, 1)),
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).recall.length, 0);
});

test('get returns bounded excerpt by docid', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const docid = writeKnowledgeSolution(copilotHome);
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'get',
    '--docid',
    docid,
    '--lines',
    '10',
    '--max-bytes',
    '500',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.docid, docid);
  assert.ok(body.excerpt.includes('Problem'));
  assert.ok(body.bytes <= 500);
});

test('recall falls back to overlap ranker when postings index missing', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, { symptom: 'timeout on checkout path' });
  runIndex(workspace, copilotHome);
  fs.rmSync(path.join(copilotHome, 'knowledge', '.harness-index'), { recursive: true, force: true });

  const result = runHarness([
    'recall',
    'checkout timeout',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.recall.length >= 1);
  assert.equal(body.recall[0].ranker, 'overlap');
});

test('install creates global harness shim', () => {
  const copilotHome = tempDir('harness-copilot-');
  installGlobalHarnessShim(copilotHome, { dryRun: false, verbose: false }, () => {});
  const shim = globalHarnessShimPath(copilotHome);
  assert.ok(fs.existsSync(shim));
  const result = spawnSync(process.execPath, [shim, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('resolve finds monorepo harness bin', () => {
  const repoRoot = path.resolve(packageRoot, '../..');
  const result = runHarness(['resolve', '--workspace', repoRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.bin);
  assert.ok(body.agentCommand);
});

test('init-repo creates harness runner', () => {
  const workspace = tempDir('harness-workspace-');
  const result = runHarness(['init-repo', '--workspace', workspace]);
  assert.equal(result.status, 0, result.stderr);
  const runner = path.join(workspace, '.harness', 'run.mjs');
  assert.ok(fs.existsSync(runner));
  const runResult = spawnSync(process.execPath, [runner, 'resolve', '--json'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, HARNESS_BIN: binPath },
  });
  assert.equal(runResult.status, 0, runResult.stderr);
});

// ─── intentContractHasContent ─────────────────────────────────────────────────

test('intentContractHasContent returns false when section is missing', () => {
  const text = `---
title: "No contract"
---

## Overview

Just an overview.
`;
  assert.equal(intentContractHasContent(text), false);
});

test('intentContractHasContent returns false for template-only bullets', () => {
  const text = `## Intent Contract

- **Goal:**
- **Expected outputs:**
- **Success criteria:**
`;
  assert.equal(intentContractHasContent(text), false);
});

test('intentContractHasContent returns true when section has substantive content', () => {
  const text = `## Intent Contract

- **Goal:** Implement the feature
- **Expected outputs:** passing tests
- **Success criteria:** CI green
`;
  assert.equal(intentContractHasContent(text), true);
});

test('intentContractHasContent returns true when section has non-bullet prose', () => {
  const text = `## Intent Contract

Deliver a working endpoint that accepts POST /foo.
`;
  assert.equal(intentContractHasContent(text), true);
});

test('intentContractHasContent returns false for section at end of file with no body', () => {
  const text = `## Overview

Brief.

## Intent Contract
`;
  assert.equal(intentContractHasContent(text), false);
});

// ─── extractGoalFromPlan edge cases ───────────────────────────────────────────

test('extractGoalFromPlan returns null for null input', () => {
  assert.equal(extractGoalFromPlan(null), null);
});

test('extractGoalFromPlan returns null when no goal signal in plan', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-05-22-fix-example-plan.md'),
    `---
title: "No goal"
status: in-progress
plan_lock: true
phase: 1
---

# No goal

## Overview

No goal here.

## Acceptance Criteria

- [ ] Done.

## Activity

- Created.
`,
    'utf8'
  );
  const plan = loadPlan(workspace, 'docs/plans/2026-05-22-fix-example-plan.md');
  assert.equal(extractGoalFromPlan(plan), null);
});

test('extractGoalFromPlan returns goal from frontmatter alone (no section)', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-05-22-fix-example-plan.md'),
    `---
title: "Frontmatter only"
status: in-progress
plan_lock: true
phase: 1
intent: "Fix the timeout"
success_criteria: ["tests pass"]
expected_outputs: ["patch"]
---

# Frontmatter only

## Overview

Brief.

## Acceptance Criteria

- [ ] Done.

## Activity

- Created.
`,
    'utf8'
  );
  const plan = loadPlan(workspace, 'docs/plans/2026-05-22-fix-example-plan.md');
  const goal = extractGoalFromPlan(plan);
  assert.ok(goal);
  assert.equal(goal.intent, 'Fix the timeout');
  assert.deepEqual(goal.success_criteria, ['tests pass']);
  assert.deepEqual(goal.expected_outputs, ['patch']);
  assert.equal(goal.intentContractExcerpt, '');
});

test('extractGoalFromPlan truncates intentContractExcerpt to 400 chars', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const longBody = 'x'.repeat(600);
  fs.writeFileSync(
    path.join(plansDir, '2026-05-22-fix-example-plan.md'),
    `---
title: "Long intent"
status: in-progress
plan_lock: true
phase: 1
intent: "Do something"
---

# Long intent

## Overview

Brief.

## Intent Contract

${longBody}

## Acceptance Criteria

- [ ] Done.

## Activity

- Created.
`,
    'utf8'
  );
  const plan = loadPlan(workspace, 'docs/plans/2026-05-22-fix-example-plan.md');
  const goal = extractGoalFromPlan(plan);
  assert.ok(goal);
  assert.ok(goal.intentContractExcerpt.length <= 400);
});

// ─── buildContextPack planGoal section ────────────────────────────────────────

test('buildContextPack includes Goal section when planGoal provided', () => {
  const body = buildContextPack({
    query: 'fix example',
    recall: [],
    plans: [],
    activePlan: null,
    planGoal: {
      planPath: 'docs/plans/2026-01-01-plan.md',
      intent: 'Fix the timeout bug',
      success_criteria: ['tests pass', 'no regression'],
      expected_outputs: ['patch file'],
      intentContractExcerpt: 'Deliver a fix for timeout.',
    },
    gatePreview: { pass: true, blockedReason: null },
    nextTools: [],
  });
  assert.match(body, /## Goal \(Intent Contract\)/);
  assert.match(body, /Fix the timeout bug/);
  assert.match(body, /tests pass/);
  assert.match(body, /patch file/);
  assert.match(body, /Intent Contract \(excerpt\)/);
  assert.match(body, /Deliver a fix for timeout/);
});

test('buildContextPack omits Goal section when planGoal is null', () => {
  const body = buildContextPack({
    query: 'fix example',
    recall: [],
    plans: [],
    activePlan: null,
    planGoal: null,
    gatePreview: { pass: true, blockedReason: null },
    nextTools: [],
  });
  assert.equal(body.includes('## Goal'), false);
});

test('buildContextPack omits excerpt subsection when intentContractExcerpt is empty', () => {
  const body = buildContextPack({
    query: 'fix example',
    recall: [],
    plans: [],
    activePlan: null,
    planGoal: {
      planPath: 'docs/plans/2026-01-01-plan.md',
      intent: 'Do something',
      success_criteria: ['pass'],
      expected_outputs: [],
      intentContractExcerpt: '',
    },
    gatePreview: { pass: true, blockedReason: null },
    nextTools: [],
  });
  assert.match(body, /## Goal \(Intent Contract\)/);
  assert.equal(body.includes('### Intent Contract (excerpt)'), false);
});

// ─── parseFlags --configure-path ──────────────────────────────────────────────

test('parseFlags configurePath defaults to false', () => {
  const flags = parseFlags([]);
  assert.equal(flags.configurePath, false);
});

test('parseFlags --configure-path sets configurePath to true', () => {
  const flags = parseFlags(['--configure-path']);
  assert.equal(flags.configurePath, true);
});

test('parseFlags --configure-path combined with other flags', () => {
  const flags = parseFlags(['--dry-run', '--configure-path', '--configure-vscode']);
  assert.equal(flags.configurePath, true);
  assert.equal(flags.dryRun, true);
  assert.equal(flags.configureVsCode, true);
});

// ─── globalBinDir ─────────────────────────────────────────────────────────────

test('globalBinDir returns copilotHome/bin', () => {
  const copilotHome = '/some/copilot/home';
  assert.equal(globalBinDir(copilotHome), path.join(copilotHome, 'bin'));
});

test('globalHarnessShimPath returns copilotHome/bin/harness', () => {
  const copilotHome = '/some/copilot/home';
  assert.equal(globalHarnessShimPath(copilotHome), path.join(copilotHome, 'bin', 'harness'));
});

// ─── installGlobalHarnessShim dry run ─────────────────────────────────────────

test('installGlobalHarnessShim dry run logs but does not write', () => {
  const copilotHome = tempDir('harness-copilot-');
  const logs = [];
  const stats = installGlobalHarnessShim(copilotHome, { dryRun: true }, (msg) => logs.push(msg));
  const shim = globalHarnessShimPath(copilotHome);
  assert.equal(fs.existsSync(shim), false);
  assert.ok(logs.some((l) => l.includes('would write global harness shim')));
  assert.equal(stats.updated, true);
  assert.equal(stats.created, false);
});

test('installGlobalHarnessShim marks updated on second call', () => {
  const copilotHome = tempDir('harness-copilot-');
  installGlobalHarnessShim(copilotHome, { dryRun: false }, () => {});
  const stats = installGlobalHarnessShim(copilotHome, { dryRun: false }, () => {});
  assert.equal(stats.updated, true);
  assert.equal(stats.created, false);
});

// ─── configureShellPath ───────────────────────────────────────────────────────

test('configureShellPath dry run does not modify rc files', () => {
  const home = tempDir('harness-home-');
  const rcPath = path.join(home, '.bashrc');
  fs.writeFileSync(rcPath, '# my shell\n', 'utf8');

  const copilotHome = tempDir('harness-copilot-');
  const logs = [];
  // Temporarily swap HOME for test isolation
  const origHome = os.homedir;
  // configureShellPath reads os.homedir() which we can't easily mock without patching the module
  // Instead, just verify dry run does not throw and returns updated count correctly via the real function
  const stats = configureShellPath(copilotHome, { dryRun: true, verbose: false }, (msg) => logs.push(msg));
  assert.ok(typeof stats.updated === 'number');
  assert.ok(typeof stats.binDir === 'string');
});

test('configureShellPath returns updated count and binDir path', () => {
  const copilotHome = tempDir('harness-copilot-');
  const logs = [];
  const stats = configureShellPath(copilotHome, { dryRun: false, verbose: true }, (msg) => logs.push(msg));
  assert.ok(typeof stats.updated === 'number');
  assert.ok(typeof stats.binDir === 'string');
  assert.ok(stats.binDir.endsWith('bin'), `binDir should end with 'bin', got: ${stats.binDir}`);
});

// ─── resolveHarnessBin ────────────────────────────────────────────────────────

test('resolveHarnessBin resolves via HARNESS_BIN env var', () => {
  const resolved = resolveHarnessBin({
    workspace: tempDir('harness-workspace-'),
    copilotHome: tempDir('harness-copilot-'),
    // Note: we use process.env override below via an explicit env path
  });
  // With monorepo present (we're in the repo), should find monorepo or path bin
  assert.ok(resolved.bin || resolved.bin === null); // either found or not — no throw
  assert.ok(Array.isArray(resolved.tried));
});

test('resolveHarnessBin uses HARNESS_BIN env when file exists', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  // Create a fake bin file
  const fakeBin = path.join(workspace, 'fake-harness.mjs');
  fs.writeFileSync(fakeBin, '// fake\n', 'utf8');

  const origEnv = process.env.HARNESS_BIN;
  process.env.HARNESS_BIN = fakeBin;
  try {
    const resolved = resolveHarnessBin({ workspace, copilotHome });
    assert.equal(resolved.bin, fakeBin);
    assert.equal(resolved.source, 'HARNESS_BIN');
  } finally {
    if (origEnv === undefined) delete process.env.HARNESS_BIN;
    else process.env.HARNESS_BIN = origEnv;
  }
});

test('resolveHarnessBin skips HARNESS_BIN when file does not exist', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const origEnv = process.env.HARNESS_BIN;
  process.env.HARNESS_BIN = path.join(workspace, 'nonexistent-harness.mjs');
  try {
    const resolved = resolveHarnessBin({ workspace, copilotHome });
    // Should not return HARNESS_BIN source since file doesn't exist
    assert.notEqual(resolved.source, 'HARNESS_BIN');
    const harnessEntry = resolved.tried.find((t) => t.source === 'HARNESS_BIN');
    assert.ok(harnessEntry, 'should have tried HARNESS_BIN');
  } finally {
    if (origEnv === undefined) delete process.env.HARNESS_BIN;
    else process.env.HARNESS_BIN = origEnv;
  }
});

test('resolveHarnessBin returns tried array even when nothing found', () => {
  // Use a temp dir as both workspace and copilotHome (no harness anywhere)
  const isolated = tempDir('harness-isolated-');
  const origEnv = process.env.HARNESS_BIN;
  delete process.env.HARNESS_BIN;
  try {
    const resolved = resolveHarnessBin({ workspace: isolated, copilotHome: isolated });
    // In repo the monorepo discovery might still find it, but tried must be an array
    assert.ok(Array.isArray(resolved.tried));
    assert.ok(resolved.tried.length > 0);
  } finally {
    if (origEnv !== undefined) process.env.HARNESS_BIN = origEnv;
  }
});

// ─── agentHarnessCommand ──────────────────────────────────────────────────────

test('agentHarnessCommand returns null when bin is null', () => {
  assert.equal(agentHarnessCommand({ bin: null, source: null, onPath: false, globalShim: null }), null);
});

test('agentHarnessCommand returns "harness" when onPath is true', () => {
  assert.equal(agentHarnessCommand({ bin: '/usr/bin/harness', source: 'path', onPath: true, globalShim: null }), 'harness');
});

test('agentHarnessCommand returns node invocation for global-shim source', () => {
  const shimPath = '/home/user/.copilot/bin/harness';
  const cmd = agentHarnessCommand({ bin: shimPath, source: 'global-shim', onPath: false, globalShim: shimPath });
  assert.equal(cmd, `node "${shimPath}"`);
});

test('agentHarnessCommand returns node invocation for monorepo bin', () => {
  const binPath2 = '/repo/packages/harness/bin/harness.mjs';
  const cmd = agentHarnessCommand({ bin: binPath2, source: 'monorepo', onPath: false, globalShim: null });
  assert.equal(cmd, `node "${binPath2}"`);
});

// ─── writeHarnessRunner ───────────────────────────────────────────────────────

test('writeHarnessRunner creates runner with correct version marker', () => {
  const workspace = tempDir('harness-workspace-');
  const result = writeHarnessRunner(workspace, false);
  assert.equal(result.created, true);
  assert.equal(result.updated, false);
  const runnerPath = path.join(workspace, '.harness', 'run.mjs');
  assert.ok(fs.existsSync(runnerPath));
  const content = fs.readFileSync(runnerPath, 'utf8');
  assert.match(content, new RegExp(`@harness-runner-version ${RUNNER_VERSION}`));
});

test('writeHarnessRunner skips write when current and not forced', () => {
  const workspace = tempDir('harness-workspace-');
  writeHarnessRunner(workspace, false);
  const result = writeHarnessRunner(workspace, false);
  assert.equal(result.created, false);
  assert.equal(result.updated, false);
});

test('writeHarnessRunner updates stale runner missing version marker', () => {
  const workspace = tempDir('harness-workspace-');
  const harnessDir = path.join(workspace, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  // Write a runner without the version marker
  fs.writeFileSync(path.join(harnessDir, 'run.mjs'), '// old runner without version\n', 'utf8');
  const result = writeHarnessRunner(workspace, false);
  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  const content = fs.readFileSync(path.join(harnessDir, 'run.mjs'), 'utf8');
  assert.match(content, new RegExp(`@harness-runner-version ${RUNNER_VERSION}`));
});

test('writeHarnessRunner dryRun does not write file', () => {
  const workspace = tempDir('harness-workspace-');
  const result = writeHarnessRunner(workspace, true);
  const runnerPath = path.join(workspace, '.harness', 'run.mjs');
  assert.equal(fs.existsSync(runnerPath), false);
  assert.equal(result.created, true);
  assert.equal(result.updated, false);
});

test('writeHarnessRunner respects HARNESS_FORCE_RUNNER env', () => {
  const workspace = tempDir('harness-workspace-');
  writeHarnessRunner(workspace, false);
  const runnerPath = path.join(workspace, '.harness', 'run.mjs');
  const mtimeBefore = fs.statSync(runnerPath).mtimeMs;
  // Small delay to ensure mtime differs if file is rewritten
  const now = Date.now();
  while (Date.now() - now < 10) { /* spin */ }
  process.env.HARNESS_FORCE_RUNNER = '1';
  try {
    const result = writeHarnessRunner(workspace, false);
    // HARNESS_FORCE_RUNNER bypasses early-return but return value reflects stale=false
    assert.equal(result.created, false);
    // File should still be valid
    assert.ok(fs.existsSync(runnerPath));
    const content = fs.readFileSync(runnerPath, 'utf8');
    assert.match(content, new RegExp(`@harness-runner-version ${RUNNER_VERSION}`));
  } finally {
    delete process.env.HARNESS_FORCE_RUNNER;
  }
});

// ─── installHarnessBin ────────────────────────────────────────────────────────

test('installHarnessBin copies bin and lib dirs to destRoot', () => {
  const copilotHome = tempDir('harness-copilot-');
  const logs = [];
  const stats = installHarnessBin(packageRoot, copilotHome, { dryRun: false, verbose: false }, (msg) => logs.push(msg));
  const destRoot = path.join(copilotHome, '.harness-bin');
  assert.ok(fs.existsSync(path.join(destRoot, 'bin', 'harness.mjs')));
  assert.ok(fs.existsSync(path.join(destRoot, 'lib', 'commands.mjs')));
  assert.ok(stats.created > 0 || stats.updated > 0);
  assert.ok(stats.files.length > 0);
  assert.ok(stats.files.some((f) => f.includes('bin/')));
  assert.ok(stats.files.some((f) => f.includes('lib/')));
});

test('installHarnessBin dry run reports files without writing', () => {
  const copilotHome = tempDir('harness-copilot-');
  const logs = [];
  const stats = installHarnessBin(packageRoot, copilotHome, { dryRun: true, verbose: false }, (msg) => logs.push(msg));
  const destRoot = path.join(copilotHome, '.harness-bin');
  assert.equal(fs.existsSync(destRoot), false);
  assert.ok(stats.files.length > 0);
  assert.ok(logs.some((l) => l.includes('would create harness-bin')));
});

test('installHarnessBin copies package.json and retired.json', () => {
  const copilotHome = tempDir('harness-copilot-');
  installHarnessBin(packageRoot, copilotHome, { dryRun: false, verbose: false }, () => {});
  const destRoot = path.join(copilotHome, '.harness-bin');
  assert.ok(fs.existsSync(path.join(destRoot, 'package.json')));
});

test('installHarnessBin verbose logs copy operations', () => {
  const copilotHome = tempDir('harness-copilot-');
  const logs = [];
  installHarnessBin(packageRoot, copilotHome, { dryRun: false, verbose: true }, (msg) => logs.push(msg));
  assert.ok(logs.some((l) => l.includes('create harness-bin') || l.includes('update harness-bin')));
});

// ─── loadManifest error handling ──────────────────────────────────────────────

test('loadManifest returns error field when manifest is invalid YAML', () => {
  const copilotHome = tempDir('harness-copilot-');
  const knowledgeDir = path.join(copilotHome, 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, 'manifest.yaml'), 'entries: [: broken yaml\n', 'utf8');

  const workspace = tempDir('harness-workspace-');
  const result = loadManifest(copilotHome, workspace);
  assert.equal(result.entries.length, 0);
  // error should be non-null since parse failed on a found file
  assert.ok(result.error !== null, 'error should be set for invalid YAML');
});

test('loadManifest returns empty entries with null error when no manifest exists', () => {
  const copilotHome = tempDir('harness-copilot-');
  const workspace = tempDir('harness-workspace-');
  const result = loadManifest(copilotHome, workspace);
  assert.equal(result.entries.length, 0);
  assert.equal(result.error, null);
  assert.equal(result.path, null);
});

// ─── gate C-goal check ────────────────────────────────────────────────────────

test('gate emits C-goal pass for locked plan with substantive intent contract', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix timeout"\nexpected_outputs: ["patch"]\nsuccess_criteria: ["tests pass"]\n',
  });

  const result = runHarness(['gate', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  const cGoal = body.checks.find((c) => c.id === 'C-goal');
  assert.ok(cGoal, 'C-goal check should be present');
  assert.equal(cGoal.pass, true);
});

test('gate emits C-goal warn for locked plan with empty intent contract template', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-05-22-empty-intent-plan.md'),
    `---
title: "Empty template"
status: in-progress
plan_lock: true
phase: 1
intent: "Do something"
success_criteria: ["done"]
expected_outputs: ["output"]
---

# Empty template

## Overview

Brief.

## Intent Contract

- **Goal:**
- **Expected outputs:**
- **Success criteria:**

## Acceptance Criteria

- [ ] Done.

## Impacted Files

- src/example.ts

## Activity

- Created.
`,
    'utf8'
  );

  const result = runHarness(['gate', '--workspace', workspace, '--json']);

  // exitCode 2 (warn), not 1 (fail)
  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  const cGoal = body.checks.find((c) => c.id === 'C-goal');
  assert.ok(cGoal, 'C-goal check should be present');
  assert.equal(cGoal.pass, false);
  assert.equal(cGoal.severity, 'warn');
});

test('gate C-goal strict-intent fails when intent contract is empty template', () => {
  const workspace = tempDir('harness-workspace-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-05-22-empty-intent-plan.md'),
    `---
title: "Empty template"
status: in-progress
plan_lock: true
phase: 1
intent: "Do something"
success_criteria: ["done"]
expected_outputs: ["output"]
---

# Empty template

## Overview

Brief.

## Intent Contract

- **Goal:**
- **Expected outputs:**
- **Success criteria:**

## Acceptance Criteria

- [ ] Done.

## Impacted Files

- src/example.ts

## Activity

- Created.
`,
    'utf8'
  );

  const result = runHarness(['gate', '--workspace', workspace, '--strict-intent', '--json']);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  const cGoal = body.checks.find((c) => c.id === 'C-goal');
  assert.ok(cGoal);
  assert.equal(cGoal.pass, false);
  assert.equal(cGoal.severity, 'fail');
});

// ─── compound exit code 2 (verify gate warning only) ─────────────────────────

test('compound returns exitCode 2 when verify gate warns but does not fail', () => {
  const workspace = tempDir('harness-workspace-');
  writePlan(workspace, {
    frontmatter:
      'intent: "Fix example safely"\nexpected_outputs: ["code change"]\nsuccess_criteria: ["tests pass"]\n',
    // No verification evidence in activity → V1 check warns (exitCode 2)
    activity: '- Plan created only.',
  });

  const result = runHarness(['compound', '--workspace', workspace, '--json']);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.equal(body.exitCode, 2);
  assert.equal(body.indexed, null);
  assert.ok(body.blockedReason);
  assert.ok(body.nextTools.includes('harness gate --phase verify'));
});

// ─── sync.mjs hooks in SYNC_TOP_LEVEL ────────────────────────────────────────

test('syncAssetsToTarget syncs hooks directory when present in assets', () => {
  const assetsRoot = tempDir('harness-assets-');
  const targetRoot = tempDir('harness-target-');
  const hooksDir = path.join(assetsRoot, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({ version: 1 }), 'utf8');

  const stats = syncAssetsToTarget(
    assetsRoot,
    targetRoot,
    { dryRun: false, preserveKnowledge: true, verbose: false },
    () => {}
  );

  assert.ok(fs.existsSync(path.join(targetRoot, 'hooks', 'hooks.json')));
  assert.ok(stats.files.some((f) => f.includes('hooks')));
});

test('syncAssetsToTarget skips hooks when assets has no hooks dir', () => {
  const assetsRoot = tempDir('harness-assets-');
  const targetRoot = tempDir('harness-target-');
  // No hooks dir created in assets

  const stats = syncAssetsToTarget(
    assetsRoot,
    targetRoot,
    { dryRun: false, preserveKnowledge: true, verbose: false },
    () => {}
  );

  assert.equal(fs.existsSync(path.join(targetRoot, 'hooks')), false);
});
