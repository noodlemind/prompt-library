import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planContractText } from '../../.github/hooks/lib/evidence-binding.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const hooksRoot = path.join(repoRoot, '.github', 'hooks');

/** Fresh, isolated fixture workspace. Callers reset by removing it after a run. */
export function makeWorkspace(prefix = 'harness-eval-') {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.github', 'harness', 'policy.yaml'),
    'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n'
  );
  return ws;
}

/** Invoke a real hook script against a payload; returns exit status + parsed decision. */
export function runHook(name, workspace, payload) {
  const result = spawnSync(process.execPath, [path.join(hooksRoot, name)], {
    cwd: workspace,
    input: JSON.stringify({ cwd: workspace, session_id: 'eval-session', ...payload }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });
  let output = {};
  try {
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    output = line ? JSON.parse(line) : {};
  } catch {
    output = {};
  }
  const denied =
    result.status === 2 ||
    output.permissionDecision === 'deny' ||
    output.hookSpecificOutput?.permissionDecision === 'deny' ||
    output.decision === 'block' ||
    output.hookSpecificOutput?.decision === 'block';
  return { status: result.status, stdout: result.stdout, output, denied };
}

export function readEvents(workspace) {
  const file = path.join(workspace, '.harness', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Activity-stripped plan digest — must match the gate/hook rule. */
export function planDigest(planText) {
  return crypto.createHash('sha256').update(planContractText(planText)).digest('hex');
}

export function writeSession(workspace, session) {
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

export function readSession(workspace) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Materialize a locked, in-progress fixture plan and return its relative path. */
export function writeFixturePlan(workspace, rel = 'docs/plans/2026-01-01-feat-eval-fixture-plan.md') {
  const full = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    `---
plan_schema: 1
title: "Eval fixture"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Exercise the harness lifecycle in an eval fixture"
expected_outputs: ["fixture"]
success_criteria: ["fixture passes"]
verification:
  required: [harness-tests]
  criteria: {AC1: [harness-tests]}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [engineer]
capability_gaps: []
---

# Eval fixture

## Overview

Fixture plan for the native eval runner.

## Intent Contract

- Goal: Exercise the harness lifecycle.

## Acceptance Criteria

- [x] **AC1** Fixture passes.

## Plan

### Phase 1

- [x] Exercise the lifecycle.

## Impacted Files

- \`src/schema.json\`

## Verification Plan

- Run the trusted check.

## Risk & Review Routing

- Green.

## Review Findings

- None.

## Activity

- Fixture created.
`
  );
  return rel;
}
