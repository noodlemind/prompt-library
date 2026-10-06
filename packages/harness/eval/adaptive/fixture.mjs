/**
 * Temp workspace, copilot home, and harness home for one ladder rung.
 * Spawns bin/harness.mjs. Does not approve trust and does not call a model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

export const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
export const hooksRoot = path.join(packageRoot, 'corpus', 'hooks');

function realTemp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function createFixture(prefix, homes = {}) {
  const workspace = realTemp(`adaptive-${prefix}-ws-`);
  const ownsCopilotHome = !homes.copilotHome;
  const ownsHarnessHome = !homes.harnessHome;
  const copilotHome = homes.copilotHome || realTemp(`adaptive-${prefix}-copilot-`);
  const harnessHome = homes.harnessHome || realTemp(`adaptive-${prefix}-home-`);
  return {
    workspace,
    copilotHome,
    harnessHome,
    cleanup() {
      fs.rmSync(workspace, { recursive: true, force: true });
      if (ownsCopilotHome) fs.rmSync(copilotHome, { recursive: true, force: true });
      if (ownsHarnessHome) fs.rmSync(harnessHome, { recursive: true, force: true });
    },
  };
}

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Harness Test',
    GIT_AUTHOR_EMAIL: 'harness@example.test',
    GIT_COMMITTER_NAME: 'Harness Test',
    GIT_COMMITTER_EMAIL: 'harness@example.test',
  };
}

export function git(fx, args) {
  return spawnSync('git', args, { cwd: fx.workspace, encoding: 'utf8', env: gitEnv() });
}

export function writeChecks(fx, checks) {
  const configDir = path.join(fx.workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'checks.yaml'), YAML.stringify({ version: 1, checks }));
}

export function writePolicy(fx, enforcement) {
  const configDir = path.join(fx.workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'policy.yaml'), YAML.stringify({ version: 1, enforcement }));
}

export function writeRouting(fx, body = 'version: 1\n') {
  const configDir = path.join(fx.workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'routing.yaml'), body);
}

export function writePlan(fx, { required = ['unit-tests'], impacted = ['src/example.js'] } = {}) {
  const plansDir = path.join(fx.workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const rel = 'docs/plans/2026-10-04-feat-adaptive-ladder-plan.md';
  const criteria = `    AC1: ${JSON.stringify(required)}`;
  fs.writeFileSync(
    path.join(fx.workspace, rel),
    `---
plan_schema: 1
title: "Adaptive ladder"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Prove the harness CLI"
expected_outputs:
  - "verified change"
success_criteria:
  - "AC1 Example works"
verification:
  required: ${JSON.stringify(required)}
  criteria:
${criteria}
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
skills_used: ["engineer"]
---

# Adaptive ladder

## Overview

Prove the harness CLI.

## Intent Contract

- **Goal:** Prove the harness CLI.
- **Expected outputs:** verified change.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1 — Implement

- [x] Implement the example.

## Impacted Files

${impacted.map((file) => `- \`${file}\``).join('\n')}

## Technical Notes

No additional technical notes.

## Verification Plan

Run trusted named checks.

## Risk & Review Routing

No required specialist review.

## Review Findings

No open findings.

## Activity

- Work recorded.
`,
  );
  return rel;
}

export function initRepo(fx, files = {}) {
  const src = path.join(fx.workspace, 'src');
  fs.mkdirSync(src, { recursive: true });
  const seeded = {
    'src/example.js': 'export const value = 1;\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(seeded)) {
    const full = path.join(fx.workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const init = git(fx, ['init', '-q', '-b', 'main']);
  if (init.status !== 0) throw new Error(init.stderr || 'git init failed');
  for (const key of ['user.email', 'user.name']) {
    const value = key === 'user.email' ? 'harness@example.test' : 'Harness Test';
    const set = git(fx, ['config', key, value]);
    if (set.status !== 0) throw new Error(set.stderr || `git config ${key} failed`);
  }
  const add = git(fx, ['add', '.']);
  if (add.status !== 0) throw new Error(add.stderr || 'git add failed');
  const commit = git(fx, ['commit', '-qm', 'baseline']);
  if (commit.status !== 0) throw new Error(commit.stderr || 'git commit failed');
}

export function head(fx) {
  const result = git(fx, ['rev-parse', 'HEAD']);
  if (result.status !== 0) throw new Error(result.stderr || 'git rev-parse failed');
  return result.stdout.trim();
}

function lastJson(text) {
  const lines = String(text || '').split(/\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // A later line may be the envelope.
    }
  }
  return null;
}

export function parseBody(result) {
  return lastJson(result.stdout) || lastJson(result.stderr);
}

const CHILD_TIMEOUT_MS = 90_000;

function childFailure(result, label) {
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const detail = timedOut ? `timed out after ${CHILD_TIMEOUT_MS}ms` : `exit ${result.status}`;
  const error = new Error(`${label}: ${detail}\n${result.stdout || ''}\n${result.stderr || ''}`);
  error.evidence = { stdout: result.stdout, stderr: result.stderr, error: result.error?.message || null };
  return error;
}

function harnessEnv(fx, enforcement) {
  const env = {
    ...process.env,
    HARNESS_HOME: fx.harnessHome,
    COPILOT_HOME: fx.copilotHome,
    HARNESS_NO_EVENTS: '1',
    HARNESS_BIN: binPath,
  };
  if (enforcement) env.HARNESS_ENFORCEMENT = enforcement;
  else delete env.HARNESS_ENFORCEMENT;
  return env;
}

export function harness(fx, args, { enforcement } = {}) {
  return spawnSync(process.execPath, [
    binPath,
    ...args,
    '--json',
    '--no-events',
    '--workspace',
    fx.workspace,
    '--copilot-home',
    fx.copilotHome,
    '--harness-home',
    fx.harnessHome,
  ], {
    cwd: fx.workspace,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    env: harnessEnv(fx, enforcement),
  });
}

export function expectExit(result, status, label) {
  if (result.error) throw childFailure(result, label);
  if (result.status === status) return parseBody(result);
  throw childFailure(result, `${label}, expected ${status}`);
}

export function hook(fx, name, payload) {
  return spawnSync(process.execPath, [path.join(hooksRoot, name)], {
    cwd: fx.workspace,
    input: JSON.stringify({ workspace: fx.workspace, cwd: fx.workspace, ...payload }),
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    env: harnessEnv(fx, 'enforce'),
  });
}

export function hookBody(result) {
  if (result.error || result.status !== 0) throw childFailure(result, 'hook');
  const body = parseBody(result);
  if (!body) {
    const error = new Error(`hook returned no JSON\n${result.stdout}\n${result.stderr}`);
    error.evidence = { stdout: result.stdout, stderr: result.stderr };
    throw error;
  }
  return body;
}

export function readSession(fx) {
  const sessionPath = path.join(fx.workspace, '.harness', 'session.json');
  if (!fs.existsSync(sessionPath)) return null;
  return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
}

export function exists(fx, rel) {
  return fs.existsSync(path.join(fx.workspace, rel));
}
