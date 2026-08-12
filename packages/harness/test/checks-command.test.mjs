import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getCommand } from '../lib/registry.mjs';
import { EXIT } from '../lib/style.mjs';
import { loadNamedChecks, validateCommand } from '../lib/checks.mjs';
import { approveProject } from '../lib/trust.mjs';
import { setConfigValue } from '../lib/config.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function workspaceWithChecks(body) {
  const ws = tempDir('checks-ws-');
  fs.mkdirSync(path.join(ws, '.github', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.github', 'harness', 'checks.yaml'), body);
  return ws;
}

/** P3AC6: `checks run` executes repo-authored argv and is gated on trust.
 * These tests are about the verb contract, so the fixture is approved against
 * its own throwaway home; `test/trust.test.mjs` asserts the refusal. */
function run(argv, ws) {
  const copilotHome = tempDir('checks-home-');
  approveProject({ workspace: ws, copilotHome });
  return spawnSync(process.execPath, [binPath, ...argv, '--workspace', ws, '--copilot-home', copilotHome], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
}

const PASSING = `version: 1
checks:
  ok-check:
    command: ["node", "-e", "process.exit(0)"]
    timeout_seconds: 30
  bad-check:
    command: ["node", "-e", "process.exit(3)"]
`;

test('the shared check surface is importable — the whole point of the extraction', () => {
  assert.equal(typeof loadNamedChecks, 'function');
  assert.equal(typeof validateCommand, 'function');
  const ws = workspaceWithChecks(PASSING);
  const { checks, error } = loadNamedChecks(ws);
  assert.equal(error, null);
  assert.deepEqual(Object.keys(checks).sort(), ['bad-check', 'ok-check']);
});

test('checks declares execute as its maximum, with list and show overriding down to read', () => {
  const entry = getCommand('checks');
  assert.equal(entry.sideEffect, 'execute', 'run executes a repo-authored argv, so the maximum is execute');
  const byVerb = Object.fromEntries(entry.verbs.map((v) => [v.verb, v.sideEffect ?? entry.sideEffect]));
  assert.equal(byVerb.list, 'read');
  assert.equal(byVerb.show, 'read');
  assert.equal(byVerb.run, 'execute', 'run inherits the maximum rather than overriding it');
});

test('checks list reports every declared check with its argv and timeout', () => {
  const ws = workspaceWithChecks(PASSING);
  const res = run(['checks', 'list', '--json'], ws);
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  assert.equal(body.checks.length, 2);
  const ok = body.checks.find((c) => c.name === 'ok-check');
  assert.deepEqual(ok.command, ['node', '-e', 'process.exit(0)']);
  assert.equal(ok.timeoutSeconds, 30);
  assert.equal(ok.valid, true);
  // The default is applied on read, not left undefined for the caller to guess.
  assert.equal(body.checks.find((c) => c.name === 'bad-check').timeoutSeconds, 600);
});

test('checks run exits 0 on pass and non-zero on failure, so CI can gate one check', () => {
  const ws = workspaceWithChecks(PASSING);
  const pass = run(['checks', 'run', 'ok-check', '--json'], ws);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).outcome.status, 'passed');

  const fail = run(['checks', 'run', 'bad-check', '--json'], ws);
  assert.notEqual(fail.status, 0, 'a failing check must not report success');
  assert.equal(JSON.parse(fail.stdout).outcome.status, 'failed');
});

test('an unknown check is a not-found that names the checks that exist', () => {
  const ws = workspaceWithChecks(PASSING);
  const res = run(['checks', 'show', 'nope'], ws);
  assert.equal(res.status, EXIT.notFound, res.stderr);
  assert.match(res.stderr, /E_NOT_FOUND/);
  assert.match(res.stderr, /bad-check, ok-check/, 'a typo is recoverable without a second command');
});

test('an unknown verb is a usage error, distinct from an absent check', () => {
  const ws = workspaceWithChecks(PASSING);
  const res = run(['checks', 'teleport'], ws);
  assert.equal(res.status, EXIT.usage, res.stderr);
  assert.match(res.stderr, /E_USAGE/);
});

test('a workspace with no check config reports that, rather than an empty list', () => {
  const ws = tempDir('checks-none-');
  const res = run(['checks', 'list'], ws);
  assert.equal(res.status, EXIT.notFound, res.stderr);
  assert.match(res.stderr, /Trusted check config not found/);
});

test('a malformed check entry is listed and marked invalid, not dropped', () => {
  const ws = workspaceWithChecks(`version: 1
checks:
  broken:
    command: []
`);
  const res = run(['checks', 'list', '--json'], ws);
  assert.equal(res.status, 0, res.stderr);
  const entry = JSON.parse(res.stdout).checks[0];
  assert.equal(entry.name, 'broken');
  assert.equal(entry.valid, false);
  assert.match(entry.invalidReason, /non-empty argv array/);
});

test('checks answers the envelope lane', () => {
  const ws = workspaceWithChecks(PASSING);
  const res = run(['checks', 'list', '--output', 'json-envelope'], ws);
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  assert.equal(body.command, 'checks');
  assert.equal(body.status, 'ok');
});

// --- P3.6: the execution audit for the named-check path ---

test('running a named check writes an execution audit in the same shape exec uses', () => {
  const ws = workspaceWithChecks(PASSING);
  const copilotHome = tempDir('checks-audit-home-');
  approveProject({ workspace: ws, copilotHome });
  spawnSync(process.execPath, [binPath, 'checks', 'run', 'ok-check', '--workspace', ws, '--copilot-home', copilotHome], {
    cwd: packageRoot,
    encoding: 'utf8',
  });

  const events = fs.readFileSync(path.join(ws, '.harness', 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'exec');
  assert.equal(events.length, 1, 'executing a repo-authored argv must leave exactly one execution record');
  const [event] = events;
  assert.equal(event.exec.check, 'ok-check', 'the record must name which check ran');
  assert.deepEqual(event.exec.argv, ['node', '-e', 'process.exit(0)']);
  assert.equal(event.exec.cwd, fs.realpathSync(ws));
  assert.ok(Array.isArray(event.exec.controls) && event.exec.controls.length > 0,
    'a check runs under the same declared controls as any other execution');
  assert.equal(event.status, 'ok');
});

test('checks.env_allowlist is off by default and opt-in-able', () => {
  const ws = workspaceWithChecks(`version: 1
checks:
  echo-env:
    command: ${JSON.stringify([process.execPath, '-e', 'console.log("SEEN=" + String(process.env.MY_CHECK_SECRET))'])}
`);
  const copilotHome = tempDir('checks-env-home-');
  approveProject({ workspace: ws, copilotHome });
  const invoke = () => spawnSync(
    process.execPath,
    [binPath, 'checks', 'run', 'echo-env', '--workspace', ws, '--copilot-home', copilotHome, '--no-events'],
    { cwd: packageRoot, encoding: 'utf8', env: { ...process.env, MY_CHECK_SECRET: 'inherited-value' } },
  );

  assert.match(invoke().stdout, /SEEN=inherited-value/,
    'the default must be what named checks have always done — flipping it silently would break checks that need a variable nobody enumerated');

  setConfigValue({ scope: 'user', key: 'checks.env_allowlist', value: 'true', copilotHome, workspace: ws });
  assert.match(invoke().stdout, /SEEN=undefined/, 'opting in must actually withhold the variable');
});

const FAILING = `version: 1
checks:
  failing:
    command: ["node", "-e", "process.exit(3)"]
  passing:
    command: ["node", "-e", "process.exit(0)"]
`;

for (const lane of [null, 'json-envelope', 'agent']) {
  test(`checks run reports the check's verdict through the exit code on the ${lane || 'ledger'} lane`, () => {
    const ws = workspaceWithChecks(FAILING);
    const copilotHome = tempDir('checks-exit-home-');
    approveProject({ workspace: ws, copilotHome });
    const invoke = (name) => {
      const argv = ['checks', 'run', name, '--workspace', ws, '--copilot-home', copilotHome, '--no-events'];
      if (lane) argv.push('--output', lane);
      return spawnSync(process.execPath, [binPath, ...argv], { cwd: packageRoot, encoding: 'utf8' });
    };
    assert.equal(invoke('failing').status, 1, 'a failing check must be a non-zero exit on every lane');
    assert.equal(invoke('passing').status, EXIT.ok);
  });
}

test('the envelope never reports a status its own outcome contradicts', () => {
  const ws = workspaceWithChecks(FAILING);
  const copilotHome = tempDir('checks-envelope-home-');
  approveProject({ workspace: ws, copilotHome });
  const res = spawnSync(
    process.execPath,
    [binPath, 'checks', 'run', 'failing', '--workspace', ws, '--copilot-home', copilotHome, '--no-events', '--output', 'json-envelope'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  const envelope = JSON.parse(res.stdout);
  assert.equal(envelope.status, 'failed');
  assert.equal(envelope.outcome.status, 'failed');
  assert.equal(res.status, 1, 'the process exit and the envelope must describe the same outcome');
});

test('list and show stay exit 0 — they answer a question rather than run one', () => {
  const ws = workspaceWithChecks(FAILING);
  const copilotHome = tempDir('checks-query-home-');
  approveProject({ workspace: ws, copilotHome });
  for (const argv of [['checks', 'list'], ['checks', 'show', 'failing']]) {
    const res = spawnSync(
      process.execPath,
      [binPath, ...argv, '--workspace', ws, '--copilot-home', copilotHome, '--no-events', '--output', 'json-envelope'],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    assert.equal(res.status, EXIT.ok, `${argv.join(' ')} must not inherit run's verdict`);
  }
});

// --- folded from review souvenirs -----------------------------------------

test('`harness checks --json list` finds its verb', () => {
  const ws = tempDir('checks-json-verb-');
  const res = spawnSync(process.execPath, [binPath, 'checks', '--json', 'list', '--workspace', ws], { encoding: 'utf8' });
  assert.equal(/requires a verb/.test(res.stdout + res.stderr), false, 'the verb must not be eaten by `--json`');
});

test('`harness run --status succeeded list` is not refused as an unknown verb', () => {
  const ws = tempDir('run-status-verb-');
  const res = spawnSync(process.execPath, [binPath, 'run', '--status', 'succeeded', 'list', '--workspace', ws], { encoding: 'utf8' });
  assert.equal(/unknown run verb/.test(res.stdout + res.stderr), false,
    'the gate and the handler must agree on verb scanning');
});

test('a named check refuses to run when the configuration will not parse', async () => {
  const { runNamedCheck } = await import('../lib/checks.mjs');
  const ws = tempDir('checks-badcfg-ws-');
  const home = tempDir('checks-badcfg-home-');
  fs.mkdirSync(path.join(home, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(home, 'harness', 'config.yaml'), '"exec.bash_enabled": definitely-not-false\n');

  const result = await runNamedCheck(ws, 'x', { command: [process.execPath, '-e', '0'] }, { copilotHome: home });
  assert.equal(result.status, 'unavailable',
    'a dropped key can be a control — config errors must fail closed');
  assert.match(result.reason, /configuration has errors/);
});

test('a timed-out check exits with the reserved timed-out code', () => {
  const ws = workspaceWithChecks(`version: 1\nchecks:\n  slow:\n    command: ${JSON.stringify([process.execPath, '-e', 'setTimeout(() => {}, 60000)'])}\n    timeout_seconds: 1\n`);
  const copilotHome = tempDir('checks-timeout-home-');
  approveProject({ workspace: ws, copilotHome });
  const res = spawnSync(
    process.execPath,
    [binPath, 'checks', 'run', 'slow', '--workspace', ws, '--copilot-home', copilotHome, '--no-events', '--output', 'json-envelope'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  assert.equal(res.status, EXIT.timedOut, 'the reported status and the exit code must mean the same thing');
  assert.equal(JSON.parse(res.stdout).status, 'timed-out');
});
