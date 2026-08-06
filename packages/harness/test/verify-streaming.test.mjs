/**
 * P1.6 (AC8) — verify streams and cancels.
 *
 * Covers what no other test file does: lib/runner.mjs actually wired into
 * lib/verify.mjs's named-check execution path (replacing blocking
 * spawnSync), `verify --output jsonl` streaming row-per-event, a per-check
 * timeout reporting `timed-out` distinctly from a generic failure, and
 * Ctrl-C (SIGINT -> AbortSignal) cancellation: status `cancelled`, exit
 * 130, evidence never written, and (via the widened event wiring) a
 * `command.result` event carrying `result: 'warn'` (legacyResultForStatus).
 *
 * Every test here is designed to resolve in well under 5s — cancellation
 * tests abort a plain, handler-less sleeping child, which dies to SIGTERM
 * almost immediately (no need to wait out the runner's 2s SIGKILL grace).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runVerify, exitCodeForOutcome, statusForVerifyResult, unifiedStatusForCheck } from '../lib/verify.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeChecks(workspace, checks) {
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'checks.yaml'),
    `version: 1\nchecks:\n${Object.entries(checks)
      .map(([name, check]) => {
        const timeout = check.timeout_seconds === undefined ? '' : `\n    timeout_seconds: ${check.timeout_seconds}`;
        return `  ${name}:\n    command: ${JSON.stringify(check.command)}${timeout}`;
      })
      .join('\n')}\n`,
    'utf8'
  );
}

function writeVersionedPlan(workspace, { required = ['slow-check'] } = {}) {
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const rel = 'docs/plans/2026-07-29-feat-verify-streaming-plan.md';
  fs.writeFileSync(
    path.join(workspace, rel),
    `---
plan_schema: 1
title: "Verify streaming example"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Verify streaming and cancellation"
expected_outputs:
  - "verified change"
success_criteria:
  - "AC1 Example works"
verification:
  required: ${JSON.stringify(required)}
  criteria:
    AC1: ${JSON.stringify(required)}
reviews:
  required: []
  completed: []
  critical_open: []
capability_gaps: []
skills_used: ["engineer"]
---

# Verify streaming example

## Overview

Verify streaming/cancel behavior.

## Intent Contract

- **Goal:** Verify streaming and cancellation work.
- **Expected outputs:** verified change.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Example works.

## Plan

### Phase 1 — Implement

- [x] Implement the example.

## Impacted Files

- \`src/example.js\`

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
    'utf8'
  );
  return rel;
}

function initGit(workspace) {
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

function readEventsRaw(workspace) {
  const p = path.join(workspace, '.harness', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// --- runNamedCheck actually runs through lib/runner.mjs (not spawnSync) ---

test('runVerify (async) still passes a real check through the async runner, byte-identical legacy shape', async () => {
  const workspace = tempDir('verify-stream-pass-');
  const plan = writeVersionedPlan(workspace, { required: ['unit-tests'] });
  writeChecks(workspace, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  initGit(workspace);

  const result = await runVerify({ workspace, flags: { plan, base: 'HEAD', dryRun: false, enforcement: 'enforce', workspace } });
  assert.equal(result.outcome, 'passed');
  const check = result.checks.find((c) => c.id === 'unit-tests');
  assert.equal(check.status, 'passed');
  assert.equal(check.exitCode, 0);
  assert.equal(typeof check.durationMs, 'number');
  assert.equal(exitCodeForOutcome(result.outcome, 'enforce'), 0);
  assert.equal(statusForVerifyResult(result), 'ok');
});

// --- Critical regression: evidence artifacts must redact check output -----
//
// lib/evidence.mjs#writeEvidence persisted `result` (including every named
// check's raw stdout/stderr) to `.harness/evidence/*.json` with no
// redaction — a durable, on-disk artifact, unlike a terminal scrollback.
// A check that echoes a secret-shaped value (a misconfigured tool leaking a
// token into its own output, for instance) landed verbatim in that file.

test('writeEvidence redacts a secret-shaped check stdout before persisting to .harness/evidence/*.json', async () => {
  const workspace = tempDir('verify-stream-evidence-redact-');
  const plan = writeVersionedPlan(workspace, { required: ['leaky-check'] });
  writeChecks(workspace, {
    'leaky-check': { command: [process.execPath, '-e', "console.log('token=abcdef1234567890'); process.exit(0)"] },
  });
  initGit(workspace);

  const result = await runVerify({ workspace, flags: { plan, base: 'HEAD', dryRun: false, enforcement: 'enforce', workspace } });
  assert.equal(result.outcome, 'passed');
  const check = result.checks.find((c) => c.id === 'leaky-check');
  // The in-memory result (what a live `verify`/`verify --json` process
  // renders to its own stdout) is deliberately left unredacted here — this
  // Critical fix's scope is the PERSISTED artifact, not the live process's
  // own console output, which is unaffected by this change.
  assert.match(check.stdout, /token=abcdef1234567890/, 'precondition: the raw secret really was captured in memory');

  assert.ok(result.evidencePath, 'runVerify must have written evidence for a passed, non-cancelled run');
  const evidenceFull = path.join(workspace, result.evidencePath);
  assert.ok(fs.existsSync(evidenceFull), 'evidence file must exist on disk');
  const onDisk = fs.readFileSync(evidenceFull, 'utf8');
  assert.doesNotMatch(onDisk, /abcdef1234567890/, 'the raw secret must never be persisted to the evidence artifact');
  assert.match(onDisk, /«redacted:kv-secret»/, 'the evidence artifact must carry the redaction mask instead');

  const persistedCheck = JSON.parse(onDisk).checks.find((c) => c.id === 'leaky-check');
  assert.match(persistedCheck.stdout, /^token=«redacted:kv-secret»/);
});

// --- AC8: per-check timeout is distinct from a generic failure ------------

test('a per-check timeout reports the legacy "timeout" status AND the unified "timed-out" status distinctly from "failed"', async () => {
  const workspace = tempDir('verify-stream-timeout-');
  const plan = writeVersionedPlan(workspace, { required: ['slow-check'] });
  writeChecks(workspace, {
    'slow-check': { command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], timeout_seconds: 1 },
  });
  initGit(workspace);

  const result = await runVerify({ workspace, flags: { plan, base: 'HEAD', dryRun: false, enforcement: 'enforce', workspace } });
  assert.equal(result.outcome, 'inconclusive');
  const check = result.checks.find((c) => c.id === 'slow-check');
  assert.equal(check.status, 'timeout', 'legacy per-check status vocabulary is unchanged');
  assert.equal(unifiedStatusForCheck(check), 'timed-out', 'AC8: timeout maps to the unified status distinctly, never "failed"');
  assert.notEqual(unifiedStatusForCheck(check), 'failed');
  // AC8: the whole run's terminal status also reports timed-out distinctly
  // (not a generic "failed") when a check timeout is what kept it from passing.
  assert.equal(statusForVerifyResult(result), 'timed-out');
});

// --- AC8: verify --output jsonl streams row-per-event ----------------------

test('verify --output jsonl streams start/progress/row events plus a terminal result row with the unified status', () => {
  const workspace = tempDir('verify-stream-jsonl-');
  const plan = writeVersionedPlan(workspace, { required: ['unit-tests'] });
  writeChecks(workspace, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  initGit(workspace);

  const res = spawnSync(
    process.execPath,
    [binPath, 'verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--output', 'jsonl'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const rows = res.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(rows.length >= 3, `expected at least start/progress-or-row/result, got ${rows.length}: ${res.stdout}`);
  for (const row of rows) {
    assert.equal(row.schema, 1);
    assert.ok(['start', 'progress', 'row', 'result'].includes(row.event));
  }
  assert.equal(rows[0].event, 'start');
  assert.equal(rows[0].command, 'verify');
  const checkRow = rows.find((r) => r.event === 'row' && r.check === 'unit-tests');
  assert.ok(checkRow, `expected a 'row' event for unit-tests: ${res.stdout}`);
  assert.equal(checkRow.status, 'passed');
  assert.equal(checkRow.unifiedStatus, 'ok');
  const terminal = rows.at(-1);
  assert.equal(terminal.event, 'result');
  assert.equal(terminal.status, 'ok');
  assert.equal(terminal.outcome, 'passed');
  assert.equal(terminal.exitCode, 0);
});

test('verify --output jsonl reports a timed-out check as a distinct row and terminal status', () => {
  const workspace = tempDir('verify-stream-jsonl-timeout-');
  const plan = writeVersionedPlan(workspace, { required: ['slow-check'] });
  writeChecks(workspace, {
    'slow-check': { command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], timeout_seconds: 1 },
  });
  initGit(workspace);

  const res = spawnSync(
    process.execPath,
    [binPath, 'verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--output', 'jsonl'],
    { encoding: 'utf8' }
  );
  const rows = res.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const checkRow = rows.find((r) => r.event === 'row' && r.check === 'slow-check');
  assert.ok(checkRow, `expected a 'row' event for slow-check: ${res.stdout}`);
  assert.equal(checkRow.status, 'timeout');
  assert.equal(checkRow.unifiedStatus, 'timed-out');
  const terminal = rows.at(-1);
  assert.equal(terminal.event, 'result');
  assert.equal(terminal.status, 'timed-out');
  assert.equal(terminal.outcome, 'inconclusive');
});

// --- AC8: cancellation (AbortSignal, unit-level, fast) ----------------------

test('runVerify: an AbortSignal fired mid-check cancels the run, skips evidence, and stops running further checks', async () => {
  const workspace = tempDir('verify-cancel-unit-');
  const plan = writeVersionedPlan(workspace, { required: ['slow-check', 'never-runs'] });
  writeChecks(workspace, {
    'slow-check': { command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] },
    'never-runs': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);

  const controller = new AbortController();
  const resultPromise = runVerify({
    workspace,
    flags: { plan, base: 'HEAD', dryRun: false, enforcement: 'enforce', workspace },
    signal: controller.signal,
  });
  // Give slow-check a moment to actually spawn before cancelling — proves a
  // check genuinely in flight is interrupted, not just a pre-aborted no-op.
  await delay(150);
  controller.abort();
  const result = await resultPromise;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.evidencePath, null, 'AC8: evidence must never be written for a cancelled run');
  assert.equal(statusForVerifyResult(result), 'cancelled');
  const checkIds = result.checks.map((c) => c.id);
  assert.ok(checkIds.includes('slow-check'));
  assert.ok(!checkIds.includes('never-runs'), 'a later check must never start once cancellation is observed');
  assert.equal(fs.existsSync(path.join(workspace, '.harness', 'evidence')), false, 'no evidence directory at all for a cancelled run');

  // Minor fix: the aborted-in-flight check's own jsonl row must report the
  // unified 'cancelled' status, not the generic 'failed' every other
  // 'unavailable' reason falls through to — it was interrupted, not failed.
  const slowCheck = result.checks.find((c) => c.id === 'slow-check');
  assert.equal(slowCheck.status, 'unavailable', 'legacy per-check status vocabulary is unchanged');
  assert.equal(unifiedStatusForCheck(slowCheck), 'cancelled');
  assert.notEqual(unifiedStatusForCheck(slowCheck), 'failed');
});

test('unifiedStatusForCheck: an "unavailable" check that was NOT cancelled still reports "failed" (no over-broad match)', () => {
  assert.equal(unifiedStatusForCheck({ status: 'unavailable', message: 'Named check is not configured: x' }), 'failed');
  assert.equal(unifiedStatusForCheck({ status: 'unavailable', message: 'Cancelled — verification was interrupted' }), 'failed', 'message text alone must not trigger the cancelled mapping — only the explicit cancelled:true marker does');
  assert.equal(unifiedStatusForCheck({ status: 'unavailable', cancelled: true }), 'cancelled');
});

// --- AC8: full CLI SIGINT -> exit 130, event telemetry, no evidence -------

test('CLI: Ctrl-C (SIGINT) during `harness verify` (plain ledger path, no --output) exits 130, skips evidence, and records a command.result event mapped to result:"warn"', async () => {
  const workspace = tempDir('verify-cancel-cli-');
  const plan = writeVersionedPlan(workspace, { required: ['slow-check'] });
  writeChecks(workspace, { 'slow-check': { command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] } });
  initGit(workspace);

  const child = spawn(process.execPath, [binPath, 'verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  // Give the child a moment to spawn node and start the named check before
  // interrupting it — this is a real cancellation of work in flight, not a
  // race against process startup.
  await delay(300);
  child.kill('SIGINT');
  const code = await exitPromise;

  assert.equal(code, 130, `expected exit 130 (EXIT.cancelled/interrupted), got ${code}. stdout: ${stdout}`);
  assert.match(stdout, /cancelled/i);
  assert.equal(fs.existsSync(path.join(workspace, '.harness', 'evidence')), false, 'no evidence directory for a Ctrl-C-cancelled run');

  const events = readEventsRaw(workspace);
  const commandResult = events.find((e) => e.type === 'command.result');
  assert.ok(commandResult, `expected a command.result event: ${JSON.stringify(events)}`);
  assert.equal(commandResult.status, 'cancelled');
  assert.equal(commandResult.exitCode, 130);
  // legacyResultForStatus (lib/registry.mjs): cancelled -> 'warn', never 'pass'/'fail'.
  assert.equal(commandResult.result, 'warn');

  const verifyEvent = events.find((e) => e.type === 'verify');
  assert.ok(verifyEvent, `expected the verify command's own lifecycle event: ${JSON.stringify(events)}`);
  assert.equal(verifyEvent.result, 'warn');
});
