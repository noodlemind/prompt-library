import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runGate } from '../lib/gate.mjs';
import { runOrient } from '../lib/orient.mjs';
import { CONTEXT_PACK_MAX_BYTES } from '../lib/context-pack.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = path.join(packageRoot, 'test', 'fixtures');
const goldenDir = path.join(fixturesRoot, 'golden');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function loadGolden(name) {
  return JSON.parse(fs.readFileSync(path.join(goldenDir, name), 'utf8'));
}

function normalizeGate(result) {
  return {
    pass: result.pass,
    phase: result.phase,
    exitCode: result.exitCode,
    checkIds: (result.checks || []).map((c) => ({
      id: c.id,
      pass: c.pass,
      severity: c.severity,
    })),
    autonomy: result.autonomy,
  };
}

function normalizeOrient(result) {
  return {
    gateStatus: result.gateStatus,
    contextPack: result.contextPack,
    nextTools: result.nextTools,
    activePlan: result.activePlan,
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(workspace, cmd) {
  execSync(`git ${cmd}`, { cwd: workspace, stdio: 'pipe', env: gitEnv });
}

function writeLockedPlan(workspace, { maxLines = 5, impacted = '- src/example.ts' } = {}) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-05-29-eval-plan.md'),
    `---
title: "Eval plan"
status: in-progress
plan_lock: true
phase: 1
intent: "Eval"
expected_outputs: ["fix"]
success_criteria: ["tests pass"]
edit_strategy: patch
max_lines_changed: ${maxLines}
---

# Eval

## Overview

Eval fixture.

## Acceptance Criteria

- [ ] Done

## Impacted Files

${impacted}

## Edit Scope

- \`src/example.ts\` lines 1-20

## Activity

- Started
`,
    'utf8'
  );
}

test('golden: gate C1 fails with no plan', () => {
  const workspace = tempDir('harness-eval-c1-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  const result = runGate({ workspace, flags: { phase: 'implement', autonomy: 'balanced' } });
  const norm = normalizeGate(result);
  const golden = loadGolden('gate-c1-no-plan.json');
  assert.deepEqual(norm, golden);
});

test('golden: gate E1 advisory under balanced autonomy', () => {
  const workspace = tempDir('harness-eval-e1-');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'example.ts'), 'line1\n', 'utf8');
  git(workspace, 'init');
  git(workspace, 'add -A');
  git(workspace, 'commit -m "init"');
  fs.appendFileSync(
    path.join(workspace, 'src', 'example.ts'),
    'line2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n',
    'utf8'
  );
  writeLockedPlan(workspace, { maxLines: 5 });
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(
    sessionPath,
    JSON.stringify({ activePlan: 'docs/plans/2026-05-29-eval-plan.md' }),
    'utf8'
  );

  const result = runGate({
    workspace,
    flags: { phase: 'implement', autonomy: 'balanced' },
  });
  const norm = normalizeGate(result);
  const golden = loadGolden('gate-e1-warn-balanced.json');
  assert.equal(norm.exitCode, golden.exitCode);
  assert.equal(norm.pass, golden.pass);
  assert.equal(norm.autonomy, golden.autonomy);
  const e1 = norm.checkIds.find((c) => c.id === 'E1');
  assert.ok(e1, 'E1 check present');
  assert.equal(e1.pass, false);
  assert.equal(e1.severity, 'warn');
});

test('golden: orient blocked routes /ensure-plan', () => {
  const workspace = tempDir('harness-eval-orient-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  const copilotHome = tempDir('harness-eval-copilot-');
  const result = runOrient({
    workspace,
    copilotHome,
    flags: { dryRun: true, autonomy: 'balanced' },
    query: 'eval fixture',
  });
  const norm = normalizeOrient(result);
  const golden = loadGolden('orient-blocked-c1.json');
  assert.deepEqual(norm, golden);
});

test('golden: context-pack stays within byte budget after orient', () => {
  const workspace = tempDir('harness-eval-pack-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  const copilotHome = tempDir('harness-eval-copilot2-');
  runOrient({
    workspace,
    copilotHome,
    flags: { autonomy: 'balanced' },
    query: 'pack budget',
  });
  const packPath = path.join(workspace, '.harness', 'context-pack.md');
  assert.ok(fs.existsSync(packPath));
  const size = Buffer.byteLength(fs.readFileSync(packPath, 'utf8'), 'utf8');
  assert.ok(size <= CONTEXT_PACK_MAX_BYTES, `pack ${size} > ${CONTEXT_PACK_MAX_BYTES}`);
});
