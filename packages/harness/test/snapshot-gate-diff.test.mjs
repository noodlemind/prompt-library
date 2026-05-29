import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runSnapshot } from '../lib/snapshot.mjs';
import { runGate } from '../lib/gate.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(workspace, cmd) {
  execSync(`git ${cmd}`, { cwd: workspace, stdio: 'pipe', env: gitEnv });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHarness(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
}

function writeLockedPlan(workspace, extraFm = '', impacted = '- src/example.ts') {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, '2026-05-29-test-plan.md'),
    `---
title: "Test plan"
status: in-progress
plan_lock: true
phase: 1
intent: "Test"
expected_outputs: ["fix"]
success_criteria: ["tests pass"]
edit_strategy: patch
max_lines_changed: 5
${extraFm}
---

# Test

## Overview

Test.

## Acceptance Criteria

- [ ] Done

## Impacted Files

${impacted}

## Activity

- Started
`,
    'utf8'
  );
}

test('runSnapshot writes codebase map', () => {
  const workspace = tempDir('harness-snap-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Demo\n\nHello.\n', 'utf8');
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { test: 'node test.js' } }),
    'utf8'
  );

  const result = runSnapshot({ workspace, flags: {} });
  assert.ok(fs.existsSync(path.join(workspace, result.out)));
  const body = fs.readFileSync(path.join(workspace, result.out), 'utf8');
  assert.match(body, /Codebase Map/);
  assert.match(body, /demo/);
  assert.ok(result.tokenEstimate > 0);
});

test('harness snapshot CLI', () => {
  const workspace = tempDir('harness-snap-cli-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  const result = runHarness(['snapshot', '--workspace', workspace, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.ok(fs.existsSync(path.join(workspace, '.harness', 'codebase-map.md')));
});

test('gate E1 warns when diff exceeds max_lines_changed', () => {
  const workspace = tempDir('harness-e1-');
  writeLockedPlan(workspace);
  git(workspace, 'init');
  git(workspace, 'add .');
  git(workspace, 'commit -m init');
  const target = path.join(workspace, 'src', 'example.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n', 'utf8');
  git(workspace, 'add .');
  git(workspace, 'commit -m add');
  fs.writeFileSync(target, 'changed\n'.repeat(10), 'utf8');

  const result = runGate({ workspace, flags: { phase: 'implement' }, query: '' });
  const e1 = result.checks.find((c) => c.id === 'E1');
  assert.ok(e1);
  assert.equal(e1.pass, false);
  assert.equal(result.exitCode, 2);
});

test('gate E1 fails under strict autonomy', () => {
  const workspace = tempDir('harness-e1-strict-');
  writeLockedPlan(workspace);
  git(workspace, 'init');
  git(workspace, 'add .');
  git(workspace, 'commit -m init');
  const target = path.join(workspace, 'src', 'example.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'a\nb\nc\nd\ne\n', 'utf8');
  git(workspace, 'add .');
  git(workspace, 'commit -m add');
  fs.writeFileSync(target, 'x\n'.repeat(20), 'utf8');

  const result = runGate({
    workspace,
    flags: { phase: 'implement', autonomy: 'strict' },
    query: '',
  });
  const e1 = result.checks.find((c) => c.id === 'E1');
  assert.equal(e1.pass, false);
  assert.equal(e1.severity, 'fail');
  assert.equal(result.pass, false);
  assert.equal(result.exitCode, 1);
});

test('init-repo --snapshot creates map', () => {
  const workspace = tempDir('harness-init-snap-');
  const result = runHarness(['init-repo', '--workspace', workspace, '--snapshot', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.stats.snapshot);
  assert.ok(fs.existsSync(path.join(workspace, '.harness', 'codebase-map.md')));
});
