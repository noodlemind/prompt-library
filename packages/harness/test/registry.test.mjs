import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { approveProject } from '../lib/trust.mjs';
import {
  dispatch,
  hasCommand,
  getCommand,
  listCommands,
  describeCommand,
  describeAll,
  validateArgs,
} from '../lib/registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const PILOTS = ['orient', 'learnings', 'status'];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Spawn the CLI against a fixture that behaves like a project the user set
 * up: an isolated `--copilot-home` (so the suite never reads the developer's
 * real one) and an approved workspace (P3AC6 gates named-check execution on
 * trust; `test/trust.test.mjs` owns the gate itself). */
function runHarness(args) {
  const full = [...args];
  const workspace = valueOf(full, '--workspace');
  let copilotHome = valueOf(full, '--copilot-home');
  if (!copilotHome && workspace) {
    copilotHome = tempDir('registry-home-');
    full.push('--copilot-home', copilotHome);
  }
  if (workspace && copilotHome) {
    try {
      approveProject({ workspace, copilotHome });
    } catch { /* a fixture with no writable home does not need trust */ }
  }
  return spawnSync(process.execPath, [binPath, ...full], { cwd: packageRoot, encoding: 'utf8' });
}

function valueOf(argv, name) {
  const eq = argv.find((a) => typeof a === 'string' && a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
}

// --- registration -----------------------------------------------------

test('the three P1.1 pilots are registered', () => {
  for (const name of PILOTS) {
    assert.equal(hasCommand(name), true, `${name} should be registered`);
    assert.ok(getCommand(name), `${name} entry should be retrievable`);
  }
  // P1.6 migrated every remaining command onto the same registry — the
  // pilots are no longer the ONLY entries, just three among many; the
  // command-count assertion moved to test/prompt-library-contracts.test.mjs
  // ('single-entry' style coverage is out of scope here).
  for (const name of PILOTS) assert.ok(listCommands().includes(name));
});

// P1.6: every command formerly reached through bin/harness.mjs's
// hand-written switch is now registered too — the switch itself is deleted
// (AC1). `help`/`--help`/`-h` is the one deliberate exception: it isn't a
// command with a side-effect class of its own, so bin/harness.mjs handles it
// directly rather than registering it (see bin/harness.mjs's own comment).
test('every migrated command is registered; help stays a dedicated non-command branch', () => {
  for (const name of [
    'doctor', 'install', 'upgrade', 'uninstall', 'init-repo', 'index', 'plan-new',
    'events', 'consolidate', 'gate', 'verify', 'recall', 'get', 'validate-plan',
    'compound', 'report', 'knowledge', 'remember', 'learning', 'eval-knowledge', 'resolve',
  ]) {
    assert.equal(hasCommand(name), true, `${name} should be registered (P1.6 migration)`);
    assert.ok(getCommand(name), `${name} entry should be retrievable`);
    assert.ok(describeCommand(name), `${name} should have help data`);
  }
  assert.equal(hasCommand('help'), false, 'help is not a registered command');
  assert.equal(getCommand('help'), null);
  assert.equal(describeCommand('help'), null);
});

// --- side-effect metadata -----------------------------------------------

test('every pilot entry declares read-only side-effect metadata', () => {
  for (const name of PILOTS) {
    const entry = getCommand(name);
    assert.equal(entry.sideEffect, 'read', `${name} is a read path — recall/get/status convention`);
    assert.ok(Array.isArray(entry.capabilities));
    assert.deepEqual(entry.outputModes, ['ledger', 'json']);
    assert.equal(typeof entry.handler, 'function');
  }
});

// P1.6 requirement #7: every migrated command's sideEffect classification is
// asserted, not just declared — read | mutate | execute per the registry's
// own enum (lib/registry.mjs's assertValidEntry already rejects anything
// else at registration time; this pins the actual classification per
// command against the brief's read/mutate/execute judgment).
test('P1.6 migrated commands carry the correct sideEffect classification', () => {
  const expected = {
    // read
    doctor: 'read',
    'validate-plan': 'read',
    recall: 'read',
    get: 'read',
    events: 'read',
    'eval-knowledge': 'read',
    resolve: 'read',
    // mutate — classified by mutating CAPABILITY, not default-invocation
    // behavior: consolidate/gate/plan-new/index are mutate even though their
    // default invocation is read-only; report is mutate for the same reason
    // — `--sync` performs real writes to the global ~/.harness telemetry
    // store (lib/telemetry-store.mjs), just as install/upgrade write to the
    // equally-global ~/.copilot.
    install: 'mutate',
    upgrade: 'mutate',
    uninstall: 'mutate',
    'init-repo': 'mutate',
    index: 'mutate',
    'plan-new': 'mutate',
    gate: 'mutate',
    compound: 'mutate',
    report: 'mutate',
    knowledge: 'mutate',
    consolidate: 'mutate',
    remember: 'mutate',
    learning: 'mutate',
    // execute — spawns arbitrary trusted commands via lib/runner.mjs
    verify: 'execute',
  };
  for (const [name, sideEffect] of Object.entries(expected)) {
    const entry = getCommand(name);
    assert.ok(entry, `${name} must be registered`);
    assert.equal(entry.sideEffect, sideEffect, `${name} sideEffect classification`);
    assert.equal(['read', 'mutate', 'execute'].includes(entry.sideEffect), true);
  }
});

// P1.6 requirement #7: registry-level dispatch tests for at least the
// mutate/execute-class commands — `dispatch()` called directly (not the CLI
// process), proving the real handler runs and the side-effect actually
// happens, not just that the entry is data-registered.
test('dispatch: a mutate-class command (gate) actually mutates session state through the real handler', async () => {
  const workspace = tempDir('registry-mutate-gate-');
  fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  assert.equal(fs.existsSync(sessionPath), false, 'precondition: no session yet');

  const code = await dispatch(['gate', '--workspace', workspace, '--json'], {});
  // No locked plan present -> gate blocks, but it still WRITES session state
  // (gateStatus, lastGateAt) regardless of pass/fail — that write is the
  // mutate-class side effect under test here, not the exit code.
  assert.ok(Number.isInteger(code));
  assert.equal(fs.existsSync(sessionPath), true, 'gate must have written .harness/session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.match(session.lastGateAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(getCommand('gate').sideEffect, 'mutate');
});

test('dispatch: an execute-class command (verify) is registered as execute and actually spawns a trusted check via the real handler', async () => {
  assert.equal(getCommand('verify').sideEffect, 'execute');

  const workspace = tempDir('registry-execute-verify-');
  const plansDir = path.join(workspace, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const rel = 'docs/plans/2026-07-29-feat-registry-verify-plan.md';
  fs.writeFileSync(
    path.join(workspace, rel),
    `---
plan_schema: 1
title: "Registry verify example"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "registry-level execute dispatch"
expected_outputs: ["verified change"]
success_criteria: ["AC1 Example works"]
verification:
  required: [unit-tests]
  criteria:
    AC1: [unit-tests]
reviews: {required: [], completed: [], critical_open: []}
capability_gaps: []
skills_used: ["engineer"]
---

# Registry verify example

## Overview

Registry-level execute dispatch.

## Intent Contract

- **Goal:** Prove verify executes a trusted check via dispatch().
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

None.

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
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'checks.yaml'),
    `version: 1\nchecks:\n  unit-tests:\n    command: ${JSON.stringify([process.execPath, '-e', 'process.exit(0)'])}\n`
  );
  const git = (args) =>
    spawnSync('git', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  assert.equal(git(['init', '-q']).status, 0);
  git(['config', 'user.email', 'harness@example.test']);
  git(['config', 'user.name', 'Harness Test']);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 1;\n');
  git(['add', '.']);
  assert.equal(git(['commit', '-qm', 'baseline']).status, 0);

  // "a trusted check", literally: P3AC6 gates named-check execution on trust,
  // and this test dispatches directly rather than through `runHarness`, so it
  // states the approval itself against its own throwaway home.
  const copilotHome = tempDir('registry-execute-home-');
  approveProject({ workspace, copilotHome });

  const code = await dispatch(['verify', '--plan', rel, '--base', 'HEAD', '--workspace', workspace, '--copilot-home', copilotHome, '--json'], {});
  assert.equal(code, 0, 'the trusted check actually ran (exit 0) through the real handler, not a stub');
  assert.ok(fs.existsSync(path.join(workspace, '.harness', 'evidence')), 'verify wrote evidence — the real cmdVerify ran, not a mock');
});

// --- help data generation -------------------------------------------------

test('describeCommand produces help data shaped for the existing renderer', () => {
  const orient = describeCommand('orient');
  assert.equal(orient.name, 'orient');
  assert.match(orient.summary, /context pack/);
  assert.equal(orient.group, 'engineer loop');
  assert.equal(orient.sideEffect, 'read');
  assert.ok(Array.isArray(orient.options));
  assert.ok(orient.options.some(([label]) => label.includes('--query')));
  assert.ok(orient.options.some(([label]) => label.includes('--collection') && label.includes('-c')));
  assert.match(orient.usage, /\[query\]/);

  const learnings = describeCommand('learnings');
  assert.ok(learnings.options.some(([label, desc]) => label.includes('--why') && /provenance/.test(desc)));
  assert.match(learnings.usage, /\[domain\]/);

  const status = describeCommand('status');
  assert.deepEqual(status.options, []);
});

test('describeAll lists every registered command, pilots included', () => {
  const all = describeAll();
  const names = all.map((d) => d.name);
  for (const name of PILOTS) assert.ok(names.includes(name));
  // P1.6: no longer "exactly the pilots" — every migrated command is here too.
  assert.ok(names.length > PILOTS.length, 'describeAll must include the P1.6-migrated commands, not just the pilots');
  for (const d of all) {
    assert.equal(typeof d.summary, 'string');
    assert.ok(d.summary.length > 0);
  }
});

// --- strict arg validation -------------------------------------------------

test('validateArgs accepts every documented flag for each pilot, including global flags', () => {
  assert.doesNotThrow(() =>
    validateArgs(getCommand('orient'), ['--query', 'text', '--limit', '3', '-c', 'sql', '--min-score', '0.2', '--explain'])
  );
  assert.doesNotThrow(() => validateArgs(getCommand('orient'), ['--workspace', '/tmp/x', '--json', '--no-events']));
  assert.doesNotThrow(() => validateArgs(getCommand('learnings'), ['sql', '--why', 'sql/some-id']));
  assert.doesNotThrow(() => validateArgs(getCommand('status'), ['--copilot-home', '/tmp/y', '--verbose', '-v']));
});

test('validateArgs rejects an unknown flag with a structured E_USAGE error naming the flag', () => {
  assert.throws(
    () => validateArgs(getCommand('orient'), ['--not-a-real-flag']),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, EXIT.usage);
      assert.equal(err.exit, 2);
      assert.match(err.message, /--not-a-real-flag/);
      return true;
    }
  );
  assert.throws(
    () => validateArgs(getCommand('status'), ['--host', 'vscode']),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /--host/);
      return true;
    }
  );
});

test('validateArgs treats a flag-shaped next token as a missing value, not a swallowed one', () => {
  // Mirrors the existing --why precedent (lib/flags.mjs): an unknown flag
  // must never hide in another flag's value slot.
  assert.throws(
    () => validateArgs(getCommand('learnings'), ['--why', '--bogus']),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /--bogus/);
      return true;
    }
  );
  // A trailing bare value-flag (no following token at all) must not throw
  // at the registry layer — cmdLearnings owns that usage message itself.
  assert.doesNotThrow(() => validateArgs(getCommand('learnings'), ['--why']));
});

// Regression (fix round 1): only a *double*-dash token is a flag boundary —
// matching lib/flags.mjs's own `next.startsWith('--')` check (e.g. --why at
// flags.mjs:176) — so single-dash-shaped values (negative numbers,
// dash-prefixed free text or ids) are still consumed as the preceding
// flag's value, exactly like the pre-registry parsing behind the handler.
// The earlier `!(next.startsWith('-') && next !== '-')` heuristic treated
// ANY single-dash token as a flag boundary too, which wrongly rejected
// these as "unknown flag" before the handler ever ran.
test('validateArgs consumes a negative-number value for a numeric flag, not as a flag boundary', () => {
  assert.doesNotThrow(() => validateArgs(getCommand('orient'), ['--min-score', '-0.5', '--json']));
  assert.doesNotThrow(() => validateArgs(getCommand('orient'), ['--limit', '-3']));
});

test('validateArgs consumes a single-dash-prefixed string value, not as a flag boundary', () => {
  assert.doesNotThrow(() => validateArgs(getCommand('orient'), ['--query', '-explain-mode', '--json']));
  assert.doesNotThrow(() => validateArgs(getCommand('learnings'), ['--why', '-weird-id', '--json']));
});

// --- dispatch: resolves pilots, rejects unknown commands/flags ------------

test('dispatch resolves a registered pilot and runs its existing handler', async () => {
  const workspace = tempDir('registry-ws-');
  const copilotHome = tempDir('registry-home-');
  const code = await dispatch(['status', '--workspace', workspace, '--copilot-home', copilotHome, '--json'], {});
  assert.equal(code, 0);
});

test('dispatch rejects an unregistered command with a structured E_USAGE error', async () => {
  await assert.rejects(
    () => dispatch(['definitely-not-a-command'], {}),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, EXIT.usage);
      assert.match(err.message, /definitely-not-a-command/);
      return true;
    }
  );
});

test('dispatch rejects an unknown flag before the handler runs (no side effect)', async () => {
  const workspace = tempDir('registry-noop-');
  const copilotHome = tempDir('registry-noop-home-');
  await assert.rejects(
    () => dispatch(['orient', '--workspace', workspace, '--copilot-home', copilotHome, '--totally-bogus'], {}),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.equal(err.exit, 2);
      assert.match(err.message, /--totally-bogus/);
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(workspace, '.harness')), false, 'orient must not have run');
});

// --- end-to-end CLI wiring --------------------------------------------------

test('CLI: registry-dispatched orient produces the same JSON envelope shape as before', () => {
  const workspace = tempDir('registry-e2e-ws-');
  const copilotHome = tempDir('registry-e2e-home-');
  const result = runHarness(['orient', '--query', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok('contextPack' in body);
  assert.ok('recall' in body);
  assert.ok('plans' in body);
  assert.ok('gateStatus' in body);
});

test('CLI: registry-dispatched learnings rejects an unknown flag with exit 2 and a structured JSON error', () => {
  const workspace = tempDir('registry-e2e-ws2-');
  const copilotHome = tempDir('registry-e2e-home2-');
  const result = runHarness(['learnings', '--workspace', workspace, '--copilot-home', copilotHome, '--json', '--not-a-flag']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.match(body.error.message, /--not-a-flag/);
  assert.equal(body.error.exit, 2);
});

test('CLI: registry-dispatched status still renders the human ledger line unchanged', () => {
  const copilotHome = tempDir('registry-e2e-home3-');
  const result = runHarness(['status', '--copilot-home', copilotHome]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /harness\s+\d+\.\d+\.\d+/);
  assert.match(result.stdout, /home\s+/);
});

// P1.6: the switch this test's name originally referenced is deleted (AC1) —
// `events` is itself a registered command now, dispatched through the same
// `dispatch()` every other command uses. Kept (renamed) as a plain
// behavioral regression check: a command outside this file's own pilot set
// still produces its documented shape end to end.
test('CLI: a non-pilot registered command (events) dispatches through the registry end to end', () => {
  const workspace = tempDir('registry-fallthrough-ws-');
  const result = runHarness(['events', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok('count' in body);
});

// P1.6: no switch/default case remains — bin/harness.mjs's `else` branch
// (unregistered, non-'help' command name) produces the same structured
// E_USAGE shape the switch's `default:` case used to.
test('CLI: a genuinely unknown top-level command produces a structured E_USAGE error', () => {
  const result = runHarness(['this-command-does-not-exist']);

  assert.equal(result.status, EXIT.usage);
  assert.match(result.stderr, /unknown command: this-command-does-not-exist/);
});

// --- Regression (fix round 1): dash-shaped values must reach the handler --
// The reviewer reproduced three cases where the registry's value-lookahead
// treated a single-dash-prefixed next token as a flag boundary and rejected
// it as "unknown flag" before the handler ever ran, diverging from the
// pre-registry (parseFlags-driven) behavior below. Each assertion pins the
// exact pre-registry outcome.

// What this pins is ROUTING: the dash-shaped value must reach parseMinScore and
// be rejected on its own terms, rather than being swallowed by the registry's
// value-lookahead as an "unknown flag" before the handler ever runs. The error's
// classification is incidental to that and has since been corrected — a
// malformed flag value is caller misuse, so it reports E_USAGE/exit 2 like every
// other usage error instead of the E_UNEXPECTED/exit 1 a bare Error produced.
test('CLI repro 1: a negative-number --min-score value reaches parseMinScore unchanged (E_USAGE, exit 2)', () => {
  const workspace = tempDir('registry-repro1-ws-');
  const copilotHome = tempDir('registry-repro1-home-');
  const result = runHarness(['orient', '--min-score', '-0.5', '--json', '--workspace', workspace, '--copilot-home', copilotHome]);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.match(body.error.message, /invalid --min-score: "-0\.5" — must be a number between 0 and 1/);
  assert.equal(body.error.exit, 2);
});

test('CLI repro 2: a dash-prefixed --query value is consumed as free text, not rejected (exit 0)', () => {
  const workspace = tempDir('registry-repro2-ws-');
  const copilotHome = tempDir('registry-repro2-home-');
  const result = runHarness(['orient', '--query', '-explain-mode', '--json', '--workspace', workspace, '--copilot-home', copilotHome]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.gateStatus, 'blocked');
  assert.ok('contextPack' in body);
});

test('CLI repro 3: a dash-prefixed --why id is consumed as the lookup id, not rejected (E_TARGET, exit 1)', () => {
  const workspace = tempDir('registry-repro3-ws-');
  const copilotHome = tempDir('registry-repro3-home-');
  const result = runHarness(['learnings', '--why', '-weird-id', '--json', '--workspace', workspace, '--copilot-home', copilotHome]);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.id, '-weird-id');
  assert.equal(body.blockedReason, 'E_TARGET: no learning -weird-id');
});

// --- requireArgs: a missing REQUIRED argument is E_USAGE/exit 2, never
// E_UNEXPECTED/exit 1 ---------------------------------------------------
// Pre-fix, recall/get/plan-new each threw a bare `new Error(...)` (no
// `.code`/`.exit`) for a missing required argument — bin/harness.mjs's
// catch-all then classified it as E_UNEXPECTED/exit 1, the same shape as a
// genuine harness FAULT, indistinguishable from caller misuse by a
// programmatic caller. lib/registry.mjs's `requireArgs` entries (recall,
// get, plan-new) now catch this before the handler runs and throw the same
// structured E_USAGE/exit-2 shape an unknown flag already used. Message
// text is unchanged byte-for-byte — only classification and exit change.

test('CLI: recall without a query is E_USAGE/exit 2 with the original message (was E_UNEXPECTED/exit 1)', () => {
  const workspace = tempDir('registry-recall-usage-ws-');
  const copilotHome = tempDir('registry-recall-usage-home-');
  const result = runHarness(['recall', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'recall requires a query string, e.g. harness recall "orders timeout"');
  assert.equal(body.error.exit, 2);
});

test('CLI: get without --docid or --path is E_USAGE/exit 2 with the original message (was E_UNEXPECTED/exit 1)', () => {
  const workspace = tempDir('registry-get-usage-ws-');
  const copilotHome = tempDir('registry-get-usage-home-');
  const result = runHarness(['get', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'get requires --docid <id> or --path <relative-path>');
  assert.equal(body.error.exit, 2);
});

test('CLI: plan-new without --slug is E_USAGE/exit 2 with the original message (was E_UNEXPECTED/exit 1)', () => {
  const workspace = tempDir('registry-plannew-slug-usage-ws-');
  const result = runHarness(['plan-new', '--type', 'feat', '--intent', 'do the thing', '--workspace', workspace, '--dry-run', '--json']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)');
  assert.equal(body.error.exit, 2);
});

test('CLI: plan-new without --intent is E_USAGE/exit 2 with the original message (was E_UNEXPECTED/exit 1)', () => {
  const workspace = tempDir('registry-plannew-intent-usage-ws-');
  const result = runHarness(['plan-new', '--type', 'feat', '--slug', 'my-fine-slug', '--workspace', workspace, '--dry-run', '--json']);

  assert.equal(result.status, EXIT.usage);
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'plan-new: --intent is required');
  assert.equal(body.error.exit, 2);
});

// A malformed --slug (present but not lowercase-hyphen) is the SAME message
// as a missing one (buildPlanSkeleton's own guard covers both) — pin that
// the "invalid", not just "missing", half of the same guard is also E_USAGE.
test('CLI: plan-new with a malformed --slug is E_USAGE/exit 2 with the original message', () => {
  const workspace = tempDir('registry-plannew-badslug-usage-ws-');
  const result = runHarness([
    'plan-new', '--type', 'feat', '--slug', 'Not A Slug!', '--intent', 'do the thing',
    '--workspace', workspace, '--dry-run', '--json',
  ]);

  assert.equal(result.status, EXIT.usage);
  const body = JSON.parse(result.stderr);
  assert.equal(body.error.code, 'E_USAGE');
  assert.equal(body.error.message, 'plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)');
});

// --- requireArgs: a correctly-invoked call is unaffected -------------------

test('CLI: a correctly-invoked recall/get/plan-new is unaffected by requireArgs', () => {
  const workspace = tempDir('registry-requireargs-ok-ws-');
  const copilotHome = tempDir('registry-requireargs-ok-home-');

  const recall = runHarness(['recall', 'orders timeout', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(recall.status, 0, recall.stderr);
  assert.deepEqual(JSON.parse(recall.stdout), { query: 'orders timeout', recall: [], plans: [] });

  const docPath = path.join(workspace, 'notes.md');
  fs.writeFileSync(docPath, '# notes\n\nhello\n');
  const get = runHarness(['get', '--path', 'notes.md', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(get.status, 0, get.stderr);
  const getBody = JSON.parse(get.stdout);
  assert.equal(getBody.path, 'notes.md');
  assert.match(getBody.excerpt, /hello/);

  const planWorkspace = tempDir('registry-requireargs-ok-plan-ws-');
  const planNew = runHarness([
    'plan-new', '--type', 'feat', '--slug', 'my-fine-slug', '--intent', 'do the thing',
    '--workspace', planWorkspace, '--dry-run', '--json',
  ]);
  assert.equal(planNew.status, 0, planNew.stderr);
  assert.equal(JSON.parse(planNew.stdout).created, false);
});
