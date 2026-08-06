import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
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

function runHarness(args) {
  return spawnSync(process.execPath, [binPath, ...args], { cwd: packageRoot, encoding: 'utf8' });
}

// --- registration -----------------------------------------------------

test('the three P1.1 pilots are registered', () => {
  for (const name of PILOTS) {
    assert.equal(hasCommand(name), true, `${name} should be registered`);
    assert.ok(getCommand(name), `${name} entry should be retrievable`);
  }
  assert.deepEqual(listCommands(), PILOTS);
});

test('non-pilot commands are not registered and fall through untouched', () => {
  for (const name of ['doctor', 'install', 'upgrade', 'events', 'consolidate', 'gate', 'verify', 'recall', 'help']) {
    assert.equal(hasCommand(name), false, `${name} must not be registered in P1.1`);
    assert.equal(getCommand(name), null);
    assert.equal(describeCommand(name), null);
  }
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

test('describeAll lists exactly the registered pilots', () => {
  const all = describeAll();
  assert.deepEqual(all.map((d) => d.name), PILOTS);
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

test('CLI: a non-registered command still falls through to the existing switch untouched', () => {
  const workspace = tempDir('registry-fallthrough-ws-');
  const result = runHarness(['events', '--workspace', workspace, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok('count' in body);
});

test('CLI: a genuinely unknown top-level command still hits the switch default case', () => {
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

test('CLI repro 1: a negative-number --min-score value reaches parseMinScore unchanged (E_UNEXPECTED, exit 1)', () => {
  const workspace = tempDir('registry-repro1-ws-');
  const copilotHome = tempDir('registry-repro1-home-');
  const result = runHarness(['orient', '--min-score', '-0.5', '--json', '--workspace', workspace, '--copilot-home', copilotHome]);

  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_UNEXPECTED');
  assert.match(body.error.message, /invalid --min-score: "-0\.5" — must be a number between 0 and 1/);
  assert.equal(body.error.exit, 1);
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
