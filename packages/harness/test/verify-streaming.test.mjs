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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  runVerify,
  exitCodeForOutcome,
  statusForVerifyResult,
  unifiedStatusForCheck,
  createCheckOutputStreamer,
} from '../lib/verify.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { approveProject } from '../lib/trust.mjs';

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

// One isolated user scope for this whole file. Set as COPILOT_HOME so every
// in-process `runVerify` AND every spawned CLI call resolves here instead of
// the developer's real ~/.copilot — which, now that trust lives there, would
// make the suite's behavior depend on the machine running it.
const FIXTURE_COPILOT_HOME = tempDir('vstream-home-');
process.env.COPILOT_HOME = FIXTURE_COPILOT_HOME;

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
  // P3AC6: named checks execute repo-authored argv and are gated on trust.
  // These fixtures test STREAMING, not the gate — `test/trust.test.mjs` owns
  // that — so the workspace is approved as soon as it exists.
  approveProject({ workspace, copilotHome: FIXTURE_COPILOT_HOME });
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

// A stream that emitted `start` must always emit a terminal `result` row
// (lib/envelope.mjs's contract). `jsonl.start(...)` is written before
// runVerify, so a throwing runVerify used to leave the error on stderr and the
// stdout stream unterminated — a consumer reading rows waited forever. The
// failure here is real and reachable: `.harness/evidence` occupied by a FILE
// makes writeEvidence's mkdir throw from inside runVerify (the same shape as a
// read-only or full filesystem).
test('verify --output jsonl still terminates the stream with a result row when runVerify throws', () => {
  const workspace = tempDir('verify-stream-jsonl-throw-');
  const plan = writeVersionedPlan(workspace, { required: ['unit-tests'] });
  writeChecks(workspace, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  initGit(workspace);
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.harness', 'evidence'), 'not a directory\n');

  const res = spawnSync(
    process.execPath,
    [binPath, 'verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--output', 'jsonl'],
    { encoding: 'utf8' }
  );
  assert.notEqual(res.status, 0, 'the run still fails — only the stream framing changes');
  const rows = res.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows[0]?.event, 'start');
  const terminal = rows.at(-1);
  assert.equal(terminal.event, 'result', `the stream must terminate, got: ${res.stdout}`);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.outcome, 'inconclusive');
  assert.match(terminal.message, /evidence/, 'the terminal row carries the failure reason');
  assert.match(res.stderr, /EEXIST|ENOTDIR|evidence/, 'the human/JSON error surface on stderr is unchanged');
});

test('verify --output jsonl reports a timed-out check as a distinct row and terminal status, and exits 8', () => {
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
  // Fix-wave Important #5: a genuinely timed-out run must exit EXIT.timedOut
  // (8) — pre-fix it fell through to outcome inconclusive -> exit 2 while
  // the terminal row said timed-out, so the exit code and the stream
  // contradicted each other.
  assert.equal(res.status, 8, `expected EXIT.timedOut (8), got ${res.status}. stdout: ${res.stdout} stderr: ${res.stderr}`);
  const rows = res.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const checkRow = rows.find((r) => r.event === 'row' && r.check === 'slow-check' && r.status);
  assert.ok(checkRow, `expected a 'row' event for slow-check: ${res.stdout}`);
  assert.equal(checkRow.status, 'timeout');
  assert.equal(checkRow.unifiedStatus, 'timed-out');
  const terminal = rows.at(-1);
  assert.equal(terminal.event, 'result');
  assert.equal(terminal.status, 'timed-out');
  assert.equal(terminal.outcome, 'inconclusive');
  assert.equal(terminal.exitCode, 8, 'the terminal row must carry the same exit code the process actually exits with');
});

// --- Fix-wave Important #5: exit-code precedence for a timed-out run -------

test('CLI: a timed-out verify run (plain ledger path) exits 8 and records command.result.status === "timed-out"', () => {
  const workspace = tempDir('verify-timeout-exit8-');
  const plan = writeVersionedPlan(workspace, { required: ['slow-check'] });
  writeChecks(workspace, {
    'slow-check': { command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], timeout_seconds: 1 },
  });
  initGit(workspace);

  const res = spawnSync(
    process.execPath,
    [binPath, 'verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 8, `expected EXIT.timedOut (8), got ${res.status}. stdout: ${res.stdout} stderr: ${res.stderr}`);

  const events = readEventsRaw(workspace);
  const commandResult = events.find((e) => e.type === 'command.result');
  assert.ok(commandResult, `expected a command.result event: ${JSON.stringify(events)}`);
  assert.equal(commandResult.status, 'timed-out', 'timed-out command telemetry must not be lost');
  assert.equal(commandResult.exitCode, 8);
  assert.equal(commandResult.result, 'warn', 'legacyResultForStatus: timed-out -> warn, never pass/fail');
});

test('statusForVerifyResult precedence: a hard FAILED outcome stays "failed" even when another check timed out', () => {
  const result = {
    outcome: 'failed',
    checks: [
      { id: 'a', status: 'failed' },
      { id: 'b', status: 'timeout' },
    ],
  };
  assert.equal(statusForVerifyResult(result), 'failed', 'a real failure verdict must never be masked by a neighboring timeout');
  assert.equal(
    statusForVerifyResult({ outcome: 'inconclusive', checks: [{ id: 'b', status: 'timeout' }] }),
    'timed-out'
  );
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
//
// Signal DELIVERY is the only part of this that is not portable; every
// assertion below is identical on both platforms.
//
// POSIX: `child.kill('SIGINT')` delivers a real SIGINT, and the harness's
// `process.once('SIGINT', () => controller.abort())` bridge
// (bin/harness.mjs) turns it into the AbortSignal that cancels the run.
//
// win32: there is no POSIX signal delivery. libuv's uv__kill() maps
// SIGINT/SIGTERM/SIGKILL onto TerminateProcess() (src/win/process.c), so
// `child.kill('SIGINT')` destroys the harness outright — no handler runs, and
// the parent sees exit code `null` with signal 'SIGINT' instead of 130. That
// is a limitation of the DELIVERY mechanism, not a harness gap: a genuine
// console Ctrl-C on Windows does reach Node, via the console control handler
// dispatching CTRL_C_EVENT -> uv__signal_dispatch(SIGINT) -> Node emitting
// 'SIGINT' on `process`. The win32 branch reproduces exactly that terminal
// in-process dispatch through a NODE_OPTIONS `--import` preload, so the
// harness's real Ctrl-C contract stays covered on Windows rather than
// skipped. The preload only fires once bin/harness.mjs has actually installed
// its listener, so a harness that stopped registering one would never be
// interrupted, run its 5s check to completion, and fail the exit-130
// assertion. The win32-only companion test after this one pins the kill()
// semantics that force the split.

const isWindows = process.platform === 'win32';

/** Environment for the harness child that arranges SIGINT delivery. POSIX
 * needs nothing (the test calls child.kill). win32 gets a preload that emits
 * the signal in-process — see the block comment above. */
function sigintDeliveryEnv() {
  if (!isWindows) return process.env;
  const preload = path.join(tempDir('verify-cancel-preload-'), 'emit-sigint.mjs');
  fs.writeFileSync(
    preload,
    // Wait for bin/harness.mjs to install its SIGINT listener, then let the
    // first named check actually get in flight before interrupting, so this
    // cancels real work rather than racing process startup (same intent as
    // the POSIX 300ms delay). Unref'd: this must never keep a process alive,
    // including the check subprocesses that inherit NODE_OPTIONS and never
    // register a SIGINT listener at all.
    [
      "const poll = setInterval(() => {",
      "  if (process.listenerCount('SIGINT') === 0) return;",
      '  clearInterval(poll);',
      "  setTimeout(() => process.emit('SIGINT'), 250);",
      '}, 25);',
      'poll.unref();',
      '',
    ].join('\n'),
    'utf8'
  );
  const importFlag = `--import "${pathToFileURL(preload).href}"`;
  return { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${importFlag}`.trim() };
}

test('CLI: Ctrl-C (SIGINT) during `harness verify` (plain ledger path, no --output) exits 130, skips evidence, and records a command.result event mapped to result:"warn"', async () => {
  const workspace = tempDir('verify-cancel-cli-');
  const plan = writeVersionedPlan(workspace, { required: ['slow-check'] });
  writeChecks(workspace, { 'slow-check': { command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] } });
  initGit(workspace);

  const child = spawn(process.execPath, [binPath, 'verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sigintDeliveryEnv(),
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  if (!isWindows) {
    // Give the child a moment to spawn node and start the named check before
    // interrupting it — this is a real cancellation of work in flight, not a
    // race against process startup.
    await delay(300);
    child.kill('SIGINT');
  }
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

// Pins the win32 platform behaviour that forces the delivery split above. If a
// future Node/libuv ever delivers a graceful SIGINT to a child on Windows,
// this test fails and the preload in sigintDeliveryEnv() should be dropped in
// favour of the plain POSIX `child.kill('SIGINT')` path.
test(
  'CLI (win32): child.kill("SIGINT") force-terminates the harness — the platform reason SIGINT delivery differs there',
  { skip: isWindows ? false : 'win32-only: pins Windows TerminateProcess-based kill() semantics' },
  async () => {
    const workspace = tempDir('verify-cancel-win32-kill-');
    const plan = writeVersionedPlan(workspace, { required: ['slow-check'] });
    writeChecks(workspace, { 'slow-check': { command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] } });
    initGit(workspace);

    const child = spawn(process.execPath, [binPath, 'verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    await delay(300);
    child.kill('SIGINT');
    const { code, signal } = await exitPromise;

    assert.equal(code, null, 'win32 kill() goes through TerminateProcess — the harness never reaches its own exit path, so 130 is unobservable this way');
    assert.equal(signal, 'SIGINT', 'libuv records the requested signum as the term signal even though it terminated the process outright');
    assert.equal(
      fs.existsSync(path.join(workspace, '.harness', 'evidence')),
      false,
      'a hard-killed verify must still leave no evidence behind'
    );
  }
);

// --- Fix-wave Important #9 (AC8): check output IS streamed, redacted -------
//
// Pre-fix, runNamedCheck supplied no onStdout/onStderr to the runner, so
// `verify --output jsonl` emitted a start marker and then only the terminal
// status — a long-running check produced no output rows at all, violating
// AC8's live-streaming requirement.

test('verify --output jsonl streams a check\'s stdout/stderr as bounded, REDACTED output rows', () => {
  const workspace = tempDir('verify-stream-output-rows-');
  const plan = writeVersionedPlan(workspace, { required: ['chatty-check'] });
  writeChecks(workspace, {
    'chatty-check': {
      command: [
        process.execPath,
        '-e',
        "console.log('building things'); console.log('token=abcdef1234567890'); console.error('warn line'); process.exit(0)",
      ],
    },
  });
  initGit(workspace);

  const res = spawnSync(
    process.execPath,
    [binPath, 'verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--output', 'jsonl'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, /abcdef1234567890/, 'a secret in check output must never reach the stream raw');

  const rows = res.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const outputRows = rows.filter((r) => r.event === 'row' && r.check === 'chatty-check' && r.stream);
  assert.ok(outputRows.length >= 3, `expected streamed output rows, got: ${res.stdout}`);
  const stdoutLines = outputRows.filter((r) => r.stream === 'stdout').map((r) => r.line);
  const stderrLines = outputRows.filter((r) => r.stream === 'stderr').map((r) => r.line);
  assert.ok(stdoutLines.includes('building things'), `plain output must stream verbatim: ${JSON.stringify(stdoutLines)}`);
  assert.ok(stdoutLines.includes('token=«redacted:kv-secret»'), `secret-bearing output must stream masked: ${JSON.stringify(stdoutLines)}`);
  assert.ok(stderrLines.includes('warn line'), `stderr must stream too: ${JSON.stringify(stderrLines)}`);

  // Ordering: output rows land between the check's progress marker and its
  // status row — live streaming, not an after-the-fact dump.
  const progressIdx = rows.findIndex((r) => r.event === 'progress' && r.check === 'chatty-check');
  const statusIdx = rows.findIndex((r) => r.event === 'row' && r.check === 'chatty-check' && r.status);
  const firstOutputIdx = rows.findIndex((r) => r.event === 'row' && r.stream);
  assert.ok(progressIdx < firstOutputIdx && firstOutputIdx < statusIdx, 'output rows must sit between progress and the status row');
});

test('createCheckOutputStreamer: a secret split across two chunks WITHIN one line is reassembled and redacted (carry buffer)', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  const streamer = createCheckOutputStreamer({ check: 'c', onEvent: (event, fields) => events.push({ event, ...fields }), redactText });

  // The secret straddles the chunk boundary — neither fragment alone matches
  // the kv-secret pattern.
  streamer.onStdout('prefix token=abcdef');
  streamer.onStdout('1234567890 suffix\n');
  streamer.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].line, 'prefix token=«redacted:kv-secret» suffix');
  assert.ok(!JSON.stringify(events).includes('abcdef1234567890'), 'no fragment recombination may leak the raw secret');
});

test('createCheckOutputStreamer: flush() redacts a trailing partial line (no newline before process exit)', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  const streamer = createCheckOutputStreamer({ check: 'c', onEvent: (event, fields) => events.push({ event, ...fields }), redactText });
  streamer.onStdout('tail token=abcdef12345');
  streamer.onStdout('67890');
  streamer.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].line, 'tail token=«redacted:kv-secret»');
});

test('createCheckOutputStreamer: output is bounded — one truncated marker row, then silence', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  // The budget counts each row's FULL serialized width — line content plus the
  // JSON envelope — and reserves the truncation marker up front, so the bytes
  // actually written never exceed maxBytes. One 'a'*25 row serializes to 92
  // bytes and the marker to 74: a budget of 200 admits one such row (92 + 74 =
  // 166) and truncates at the second (184 + 74 = 258).
  const streamer = createCheckOutputStreamer({
    check: 'c',
    onEvent: (event, fields) => events.push({ event, ...fields }),
    redactText,
    maxBytes: 200,
    maxLineBytes: 30,
  });
  streamer.onStdout('a'.repeat(25) + '\n'); // 92 serialized bytes, + 74 reserved marker
  streamer.onStdout('b'.repeat(25) + '\n'); // would exceed 200 -> truncation marker
  streamer.onStdout('c'.repeat(25) + '\n'); // after truncation: dropped silently
  streamer.flush();

  const lines = events.filter((e) => e.line !== undefined);
  const markers = events.filter((e) => e.truncated === true);
  assert.equal(lines.length, 1, 'only the first row fits the byte budget once envelope overhead counts');
  assert.equal(markers.length, 1, 'exactly one truncation marker row');
  assert.equal(events.at(-1).truncated, true, 'the marker is the last thing emitted');
});

// Codex P2: the budget priced a row as `raw line bytes + an envelope measured
// around an EMPTY line`, counting every character JSON escaping expands at its
// PRE-escape width. Backslash-heavy output therefore wrote roughly twice the
// cap while the counter still read comfortably under budget.
test('createCheckOutputStreamer: escaped characters are budgeted at their serialized width, not their raw width', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  const maxBytes = 2048;
  const streamer = createCheckOutputStreamer({
    check: 'c',
    onEvent: (event, fields) => events.push({ event, ...fields }),
    redactText,
    maxBytes,
    maxLineBytes: 512,
  });
  // Every one of these bytes doubles under JSON.stringify (`\` -> `\\`).
  for (let i = 0; i < 40; i += 1) streamer.onStdout('\\'.repeat(200) + '\n');
  streamer.flush();

  const written = events.reduce(
    (sum, { event, ...fields }) => sum + Buffer.byteLength(JSON.stringify({ schema: 1, event: 'row', ...fields }), 'utf8') + 1,
    0,
  );
  assert.ok(written > 0, 'the streamer emitted something to measure');
  assert.ok(written <= maxBytes, `bytes actually written (${written}) must stay inside the ${maxBytes} budget`);
  assert.equal(events.at(-1).truncated, true, 'the cut is still marked');
});

// Codex P2: splitting only on \n left the CR of every CRLF pair on the line, so
// the same check produced different JSONL rows on Windows than on POSIX.
test('createCheckOutputStreamer: a CRLF delimiter never leaves its CR on the row', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  const streamer = createCheckOutputStreamer({ check: 'c', onEvent: (event, fields) => events.push({ event, ...fields }), redactText });
  streamer.onStdout('first line\r\nsecond line\r\n');
  streamer.flush();
  assert.deepEqual(
    events.map((e) => e.line),
    ['first line', 'second line'],
    'rows must be byte-identical to the same output written with bare LF',
  );
});

test('createCheckOutputStreamer: only the delimiter CR is stripped — a CR inside the line survives', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  const streamer = createCheckOutputStreamer({ check: 'c', onEvent: (event, fields) => events.push({ event, ...fields }), redactText });
  streamer.onStdout('a\rb\r\n');
  streamer.flush();
  assert.deepEqual(events.map((e) => e.line), ['a\rb'], 'an interior CR is content, not a delimiter');
});

test('createCheckOutputStreamer: a single overlong line is clipped AFTER redaction, never exposing a cut secret', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  const streamer = createCheckOutputStreamer({
    check: 'c',
    onEvent: (event, fields) => events.push({ event, ...fields }),
    redactText,
    maxLineBytes: 24,
  });
  streamer.onStdout('token=abcdef1234567890 and much more trailing text\n');
  streamer.flush();
  assert.equal(events.length, 1);
  assert.ok(!events[0].line.includes('abcdef'), 'clipping must happen after masking');
  assert.ok(Buffer.byteLength(events[0].line, 'utf8') <= 24);
});

// --- Fix-wave P1: multi-line PEM blocks stream masked, not line-by-line raw --
//
// verify.mjs split check output into lines BEFORE redaction, so redact.mjs's
// whole-block PEM pattern never matched — a 3-line dummy key emitted raw as 3
// JSONL rows. The streamer is now block-aware: it holds every line from a
// BEGIN…PRIVATE KEY opener to its END footer (bounded) and masks the block as
// one row.

const PEM_KEY_LINES = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Q',
  'uKUpRKfFLfRYC9AIKjbJTWit+CqvjSFmk/8CAwEAAQ==',
  '-----END RSA PRIVATE KEY-----',
];

test('createCheckOutputStreamer: a multi-line PEM block streamed across chunks is masked as one row, never leaked line-by-line', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  const streamer = createCheckOutputStreamer({ check: 'c', onEvent: (event, fields) => events.push({ event, ...fields }), redactText });
  const pem = PEM_KEY_LINES.join('\n') + '\n';
  // Split mid-block across chunk boundaries to stress line reassembly + hold.
  streamer.onStdout(pem.slice(0, 40));
  streamer.onStdout(pem.slice(40));
  streamer.flush();

  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('MIIBOgIBAA'), 'no raw key body may stream');
  assert.ok(!serialized.includes('BEGIN RSA PRIVATE KEY'), 'the raw BEGIN marker line must not stream either');
  const lines = events.filter((e) => e.line !== undefined).map((e) => e.line);
  assert.ok(lines.includes('«redacted:private-key»'), `the block must collapse to one masked row: ${JSON.stringify(lines)}`);
});

test('createCheckOutputStreamer: an UNTERMINATED PEM block (BEGIN, no END) is masked at flush, never leaked', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  const streamer = createCheckOutputStreamer({ check: 'c', onEvent: (event, fields) => events.push({ event, ...fields }), redactText });
  streamer.onStdout('-----BEGIN OPENSSH PRIVATE KEY-----\n');
  streamer.onStdout('c3NoLXJzYQAAAB3NlY3JldGJvZHk=\n'); // key body, no END ever arrives
  streamer.flush();
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('c3NoLXJzYQAAAB'), 'the held key body must never be emitted raw');
  const lines = events.filter((e) => e.line !== undefined).map((e) => e.line);
  assert.ok(lines.includes('«redacted:private-key»'), `an unterminated block must still be masked: ${JSON.stringify(lines)}`);
});

test('verify --output jsonl: a check emitting a multi-line PEM key streams it masked, never as raw rows', () => {
  const workspace = tempDir('verify-stream-pem-');
  const plan = writeVersionedPlan(workspace, { required: ['leaky-key-check'] });
  const script = `console.log(${JSON.stringify(PEM_KEY_LINES.join('\n'))}); process.exit(0);`;
  writeChecks(workspace, { 'leaky-key-check': { command: [process.execPath, '-e', script] } });
  initGit(workspace);

  const res = spawnSync(
    process.execPath,
    [binPath, 'verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--output', 'jsonl'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, /MIIBOgIBAA/, 'the raw key body must never reach the stream');
  assert.doesNotMatch(res.stdout, /BEGIN RSA PRIVATE KEY/, 'the raw BEGIN marker must not stream either');
  assert.match(res.stdout, /«redacted:private-key»/, 'the multi-line key must stream masked');
});

// --- Fix-wave P2: UTF-8 clipping is O(n), not O(n²) -------------------------
//
// clipToBytes removed one UTF-16 unit and recomputed Buffer.byteLength each
// iteration (~78ms for a 64 KiB newline-free chunk, blocking streaming and
// cancellation). It now walks code points once and slices on a byte-accurate
// boundary.

test('createCheckOutputStreamer: clipping a huge newline-free chunk is O(n), not O(n²)', () => {
  const events = [];
  const { redactText } = createRedactor({ env: {} });
  const streamer = createCheckOutputStreamer({ check: 'c', onEvent: (event, fields) => events.push({ event, ...fields }), redactText });
  const chunk = 'a'.repeat(256 * 1024); // 256 KiB, no newline -> carry-cap force-flush -> one big clip
  const start = process.hrtime.bigint();
  streamer.onStdout(chunk);
  streamer.flush();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `clipping 256 KiB took ${ms.toFixed(1)}ms — the quadratic clip regressed (pre-fix this is seconds)`);
  const rows = events.filter((e) => e.line !== undefined);
  assert.ok(rows.length >= 1, 'the flood must still emit a clipped row');
  assert.ok(Buffer.byteLength(rows[0].line, 'utf8') <= 512, 'clipped to the default per-row cap');
});
