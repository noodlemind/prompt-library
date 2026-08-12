/**
 * Local fixtures shared by split harness CLI domain tests.
 * Extracted from harness-cli.test.mjs (Phase 2 hygiene).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHarness, packageRoot } from './cli.mjs';

export function writeKnowledgeSolution(copilotHome, {
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

export function runIndex(workspace, copilotHome) {
  const result = runHarness(['index', '--workspace', workspace, '--copilot-home', copilotHome]);
  assert.equal(result.status, 0, result.stderr);
}

export function writeProductSolution(workspace, {
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

export function writeChecks(workspace, checks) {
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'checks.yaml'),
    `version: 1\nchecks:\n${Object.entries(checks)
      .map(
        ([name, check]) => {
          const timeout = check.timeout_seconds === undefined ? '' : `\n    timeout_seconds: ${check.timeout_seconds}`;
          return `  ${name}:\n    command: ${JSON.stringify(check.command)}${timeout}`;
        }
      )
      .join('\n')}\n`,
    'utf8'
  );
}

export function writeVersionedPlan(workspace, {
  name = '2026-07-13-feat-verify-plan.md',
  required = ['unit-tests'],
  criteria = { AC1: ['unit-tests'] },
  impacted = ['src/example.js'],
  extraFrontmatter = '',
  taskChecked = true,
  skillsUsed = ['engineer'],
  technicalNotes = 'No additional technical notes.',
  intent = 'Verify safely',
} = {}) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const rel = `docs/plans/${name}`;
  const criterionYaml = Object.entries(criteria)
    .map(([id, checks]) => `    ${id}: ${JSON.stringify(checks)}`)
    .join('\n');
  fs.writeFileSync(
    path.join(workspace, rel),
    `---
plan_schema: 1
title: "Verify example"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: ${JSON.stringify(intent)}
expected_outputs:
  - "verified change"
success_criteria:
  - "AC1 Example works"
verification:
  required: ${JSON.stringify(required)}
  criteria:
${criterionYaml}
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
skills_used: ${JSON.stringify(skillsUsed)}
${extraFrontmatter}---

# Verify example

## Overview

Verify the example.

## Intent Contract

- **Goal:** Verify safely.
- **Expected outputs:** verified change.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1 — Implement

- [${taskChecked ? 'x' : ' '}] Implement the example.

## Impacted Files

${impacted.map((file) => `- \`${file}\``).join('\n')}

## Technical Notes

${technicalNotes}

## Verification Plan

Run trusted named checks.

## Risk & Review Routing

No required specialist review.

## Review Findings

No open findings.

## Activity

- Work recorded.
`,
    'utf8'
  );
  return rel;
}

export function initGit(workspace) {
  const run = (args) =>
    spawnSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  assert.equal(run(['init', '-q']).status, 0);
  assert.equal(run(['config', 'user.email', 'harness@example.test']).status, 0);
  assert.equal(run(['config', 'user.name', 'Harness Test']).status, 0);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 1;\n');
  assert.equal(run(['add', '.']).status, 0);
  assert.equal(run(['commit', '-qm', 'baseline']).status, 0);
}

export function runHook(name, workspace, toolInput = {}) {
  return spawnSync(process.execPath, [path.join(packageRoot, '../../.github/hooks', name)], {
    cwd: workspace,
    input: JSON.stringify({ workspace, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });
}

export function runHookWithPolicy(name, workspace, toolInput = {}) {
  const env = { ...process.env };
  delete env.HARNESS_ENFORCEMENT;
  return spawnSync(process.execPath, [path.join(packageRoot, '../../.github/hooks', name)], {
    cwd: workspace,
    input: JSON.stringify({ workspace, tool_input: toolInput }),
    encoding: 'utf8',
    env,
  });
}

export function hookResponse(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

export function assertHookBlocked(result, pattern) {
  const response = hookResponse(result);
  const hook = response.hookSpecificOutput || {};
  assert.ok(hook.permissionDecision === 'deny' || hook.decision === 'block', result.stdout);
  const reason = hook.permissionDecisionReason || hook.reason || response.reason || '';
  if (pattern) assert.match(reason, pattern);
  return response;
}

export function recordSuccessfulEdit(workspace, toolInput) {
  return hookResponse(runHook('record-successful-edit.mjs', workspace, toolInput));
}

/** Shared technical notes for primitive-path gate tests. */
export const primitiveAnalysis = `
- Primitive classification: modify the existing skill because it owns the workflow.
- Existing-capability overlap analysis: reuse the Existing /java skill and Existing /aws skill instead of duplicating them.
- Intended artifact structure: keep the procedure in SKILL.md and dense guidance in a reference.
- Trigger and negative-trigger implications: route migration delivery here; exclude one-off API questions.
- Verification expectations: run prompt, host, and built-asset contracts.
- Registry and documentation impact: update them only if a new skill is justified.
`.trim();

