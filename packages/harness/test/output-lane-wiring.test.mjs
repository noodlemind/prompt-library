/**
 * Regression coverage for the CLI-wiring seam added in P1.2 — the part
 * `test/envelope.test.mjs` and `test/agent-lane.test.mjs` deliberately don't
 * exercise, because they only test the pure library modules directly.
 *
 * Covers:
 *   - bin/harness.mjs's `extractOutputLane` end to end through the real CLI
 *     (`--output json-envelope|agent`, the `--output=value` equals-form, a
 *     missing value, an unrecognized value).
 *   - The exact Critical repro from fix round 1: `--output` appearing AFTER
 *     a literal `--` boundary must never be treated as the lane flag — the
 *     legacy `--json` output must stay byte-shape-identical (no envelope
 *     wrapper).
 *   - lib/registry.mjs's `dispatch`/`dispatchLane` ctx.output branching
 *     directly (faster, more precise than spawning the CLI for every case),
 *     including the Important-1 regression: the error-path agent-lane
 *     rendering must honor `entry.agentBudgetBytes`, same as the success path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { dispatch, registerCommand } from '../lib/registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHarness(args) {
  return spawnSync(process.execPath, [binPath, ...args], { cwd: packageRoot, encoding: 'utf8' });
}

/** Capture everything written to stdout during `fn()` (covers both
 * `console.log` and a direct `process.stdout.write` — dispatchLane uses both). */
async function withCapturedStdout(fn) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => {
    captured += chunk.toString();
    return true;
  };
  try {
    const code = await fn();
    return { code, stdout: captured };
  } finally {
    process.stdout.write = originalWrite;
  }
}

// --- CLI-level: bin/harness.mjs's extractOutputLane -----------------------

test('CLI: --output json-envelope produces the versioned envelope for a registered pilot', () => {
  const copilotHome = tempDir('lane-json-home-');
  const result = runHarness(['status', '--copilot-home', copilotHome, '--output', 'json-envelope']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schema, 1);
  assert.equal(body.command, 'status');
  assert.equal(body.status, 'ok');
  assert.ok('packageVersion' in body);
});

test('CLI: --output agent produces budgeted plain text, not JSON', () => {
  const copilotHome = tempDir('lane-agent-home-');
  const result = runHarness(['status', '--copilot-home', copilotHome, '--output', 'agent']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^\s*\{/);
  assert.match(result.stdout, /^schema 1/);
  assert.match(result.stdout, /command status/);
});

test('CLI: --output=agent (equals-form) is honored, matching the rest of the harness flag vocabulary', () => {
  const copilotHome = tempDir('lane-eq-agent-home-');
  const result = runHarness(['status', '--copilot-home', copilotHome, '--output=agent']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^schema 1/);
  assert.match(result.stdout, /command status/);
});

test('CLI: --output=json-envelope (equals-form) is honored', () => {
  const copilotHome = tempDir('lane-eq-json-home-');
  const result = runHarness(['status', '--copilot-home', copilotHome, '--output=json-envelope']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schema, 1);
});

test('CLI: --output with a missing value is a structured usage error, exit 2', () => {
  const copilotHome = tempDir('lane-missing-home-');
  const result = runHarness(['status', '--copilot-home', copilotHome, '--output']);
  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid --output: \(missing\)/);
});

test('CLI: --output with an unrecognized value is a structured usage error, exit 2', () => {
  const copilotHome = tempDir('lane-bogus-home-');
  const result = runHarness(['status', '--copilot-home', copilotHome, '--output', 'bogus']);
  assert.equal(result.status, EXIT.usage);
  assert.match(result.stderr, /invalid --output: "bogus"/);
});

// --- CRITICAL repro (fix round 1): the `--` literal-argument boundary -----

test('CLI: --output after a literal `--` is inert free-text content — legacy --json stays byte-shape-identical (no envelope wrapper)', () => {
  const workspace = tempDir('lane-boundary-ws-');
  const copilotHome = tempDir('lane-boundary-home-');

  const withBoundary = runHarness([
    'orient',
    '--json',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--',
    '--output',
    'agent',
  ]);
  assert.equal(withBoundary.status, 0, withBoundary.stderr);
  const body = JSON.parse(withBoundary.stdout);
  // The legacy shape has no schema/command/status envelope wrapper at all —
  // this is the exact property that regressed pre-fix (the run silently
  // switched to the agent lane and discarded --json).
  assert.ok(!('schema' in body), 'the legacy --json shape must never gain an envelope wrapper');
  assert.ok(!('status' in body), 'the raw orient result has no top-level status field — an envelope would add one');
  assert.ok('contextPack' in body);
  assert.ok('gateStatus' in body);
  assert.ok('recall' in body);
});

test('CLI: --output before a literal `--` still works, proving the boundary check is positional, not blanket-disabling --output', () => {
  const copilotHome = tempDir('lane-boundary-ok-home-');
  const result = runHarness(['status', '--copilot-home', copilotHome, '--output', 'agent', '--', 'ignored-literal']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^schema 1/);
});

// --- lib/registry.mjs: dispatch/dispatchLane ctx.output branching ---------

test('dispatch: ctx.output "json" renders the versioned envelope via dispatchLane, bypassing the legacy handler', async () => {
  const copilotHome = tempDir('dispatch-json-home-');
  const { code, stdout } = await withCapturedStdout(() => dispatch(['status', '--copilot-home', copilotHome], { output: 'json' }));
  assert.equal(code, 0);
  const body = JSON.parse(stdout.trim());
  assert.equal(body.schema, 1);
  assert.equal(body.command, 'status');
});

test('dispatch: ctx.output "agent" renders budgeted plain text via dispatchLane', async () => {
  const copilotHome = tempDir('dispatch-agent-home-');
  const { code, stdout } = await withCapturedStdout(() => dispatch(['status', '--copilot-home', copilotHome], { output: 'agent' }));
  assert.equal(code, 0);
  assert.match(stdout, /^schema 1/);
});

test('dispatch: ctx.output omitted (or "ledger") runs the legacy handler untouched — every pre-P1.2 caller is unaffected', async () => {
  const copilotHome = tempDir('dispatch-ledger-home-');
  const codeNoCtx = await dispatch(['status', '--copilot-home', copilotHome, '--json'], {});
  assert.equal(codeNoCtx, 0);
  const copilotHome2 = tempDir('dispatch-ledger-home2-');
  const codeExplicitLedger = await dispatch(['status', '--copilot-home', copilotHome2, '--json'], { output: 'ledger' });
  assert.equal(codeExplicitLedger, 0);
});

// --- Important-1 regression: error-path agent-lane rendering must be budgeted too ---

test('dispatchLane error path honors entry.agentBudgetBytes, same as the success path (regression: budget was previously dropped on error)', async () => {
  const budgetBytes = 40; // deliberately tiny — an unbudgeted render would blow past this immediately
  registerCommand({
    name: '__test-lane-error-budget',
    summary: 'test fixture for the error-path agent-lane budget regression',
    sideEffect: 'read',
    agentBudgetBytes: budgetBytes,
    args: { flags: [], positionals: [] },
    handler: async () => 0,
    resultOf: async () => {
      throw Object.assign(new Error('x'.repeat(500)), { code: 'E_TEST_FIXTURE', exit: 1 });
    },
  });

  const { code, stdout } = await withCapturedStdout(() => dispatch(['__test-lane-error-budget'], { output: 'agent' }));
  assert.equal(code, 1);
  // dispatchLane appends exactly one trailing '\n' after the budgeted text —
  // strip it before measuring so this checks the RENDERED budget itself.
  const rendered = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  assert.ok(
    Buffer.byteLength(rendered, 'utf8') <= budgetBytes,
    `error-path agent-lane output (${Buffer.byteLength(rendered, 'utf8')} bytes) must honor agentBudgetBytes (${budgetBytes})`
  );
});
