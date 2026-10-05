#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertEqual,
  assertMatch,
  cleanup,
  git,
  initWorkspace,
  runHarness,
  writeEvidence,
} from './lib.mjs';

const temps = [];
let worktreePath = null;

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} stdout was not JSON: ${result.stdout}\n${result.stderr}`);
  }
}

function writePlan(ws) {
  const rel = 'docs/plans/2026-10-05-feat-worktree-plan.md';
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    `---
plan_schema: 1
title: Worktree
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: Isolate issue work
expected_outputs: ["isolated"]
success_criteria: ["AC1"]
verification:
  required: ["unit-tests"]
  criteria:
    AC1: ["unit-tests"]
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
skills_used: ["engineer"]
intent_sources: []
---

# Worktree

## Overview

Isolate issue work.

## Intent Contract

- Goal: Isolate issue work

## Acceptance Criteria

- [x] **AC1** Isolated.

## Plan

### Phase 1

- [x] Isolated.

## Impacted Files

- \`src/example.js\`

## Verification Plan

- unit-tests

## Risk & Review Routing

- Green.

## Review Findings

- None.

## Activity

- Seeded for worktree proof.
`
  );
  return rel;
}

try {
  const ctx = initWorkspace();
  temps.push(ctx.ws, ctx.home, ctx.copilotHome);
  const branch = git(ctx.ws, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim() || 'master';
  const sha = git(ctx.ws, ['rev-parse', 'HEAD']).stdout.trim();
  git(ctx.ws, ['update-ref', `refs/remotes/origin/${branch}`, sha]);
  git(ctx.ws, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]);
  const plan = writePlan(ctx.ws);

  const blocked = runHarness(['gate', '--phase', 'implement', '--plan', plan], ctx);
  assertEqual(blocked.status, 1, `blocked gate exit (${blocked.stderr} ${blocked.stdout})`);
  const blockedCheck = parseJson(blocked, 'blocked-gate').checks.find((item) => item.id === 'C-worktree');
  assertEqual(blockedCheck.pass, false, 'C-worktree on primary default branch');
  assertMatch(blockedCheck.message, /harness worktree/, 'C-worktree names worktree');

  const added = runHarness(['worktree', '--slug', 'checkout-retry'], ctx);
  assertEqual(added.status, 0, `worktree add exit (${added.stderr})`);
  const tree = parseJson(added, 'worktree');
  assertEqual(tree.branch, 'harness/checkout-retry', 'worktree branch');
  assertEqual(tree.created, true, 'worktree created');
  assertEqual(tree.isolated, true, 'worktree isolated');
  assertEqual(fs.lstatSync(path.join(tree.path, '.git')).isFile(), true, 'linked worktree .git is a file');
  worktreePath = tree.path;

  const srcGithub = path.join(ctx.ws, '.github');
  if (fs.existsSync(srcGithub)) fs.cpSync(srcGithub, path.join(tree.path, '.github'), { recursive: true });
  const isolatedPlan = writePlan(tree.path);
  const isolated = runHarness(['gate', '--phase', 'implement', '--plan', isolatedPlan], {
    ...ctx,
    ws: tree.path,
  });
  assertEqual(isolated.status, 0, `isolated gate exit (${isolated.stderr} ${isolated.stdout})`);
  const isolatedCheck = parseJson(isolated, 'isolated-gate').checks.find((item) => item.id === 'C-worktree');
  assertEqual(isolatedCheck.pass, true, 'C-worktree in linked worktree');

  const ci = runHarness(['gate', '--phase', 'implement', '--plan', plan], { ...ctx, env: { CI: 'true' } });
  assertEqual(ci.status, 0, `CI gate exit (${ci.stderr})`);
  const ciCheck = parseJson(ci, 'ci-gate').checks.find((item) => item.id === 'C-worktree');
  assertEqual(ciCheck.pass, true, 'C-worktree skipped in CI');

  const evidence = writeEvidence('issue-worktree', {
    feature: 'issue-worktree',
    steps: [
      { command: 'gate on primary default branch', exit: blocked.status, check: blockedCheck },
      {
        command: 'worktree --slug checkout-retry',
        exit: added.status,
        branch: tree.branch,
        created: tree.created,
        isolated: tree.isolated,
      },
      { command: 'gate in linked worktree', exit: isolated.status, check: isolatedCheck },
      { command: 'gate with CI=true', exit: ci.status, check: ciCheck },
    ],
  });
  process.stdout.write(`prove-issue-worktree passed\n${evidence.dest}\n${evidence.copied || ''}\n`);
} finally {
  if (worktreePath) {
    spawnSync('git', ['-C', temps[0], 'worktree', 'remove', '--force', worktreePath], { encoding: 'utf8' });
  }
  cleanup(temps);
}
