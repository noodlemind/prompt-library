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
  assert.match(result.stdout, /Usage \(binary: harness\):/);
  assert.match(result.stdout, /harness install \[options\]/);
  assert.match(result.stdout, /npm run harness:install/);
  assert.doesNotMatch(result.stdout, /npx @dev-kit\/harness install \[options\]/);
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
