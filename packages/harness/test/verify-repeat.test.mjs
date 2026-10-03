import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listLearnings, storeDir } from '../lib/knowledge/store.mjs';
import { binPath, runHarness } from './helpers/cli.mjs';
import { initGit, recordSuccessfulEdit, writeChecks, writeVersionedPlan } from './helpers/cli-fixtures.mjs';
import { trackWorkspaceSolutions } from './helpers/workspace.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = path.resolve(packageRoot, '../../.github/hooks/require-verification.mjs');
const CLAIM = 'raw concatenation';
const TRIGGER = 'raw concatenation';
const APPLIES = 'The handler builds sql.';
const DOES_NOT = 'A billing pdf stays plain.';
const WHY = 'a joined string builds the query';
const BAD = 'export const value = 1;\n// handler uses Raw Concatenation today\n';
const CLEAR = 'export const value = 1;\n// uses parameterized queries\n';

function ctx() {
  const ws = trackWorkspaceSolutions(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repeat-ws-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repeat-home-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repeat-hh-'));
  writeChecks(ws, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  const plan = writeVersionedPlan(ws);
  initGit(ws);
  return { ws, home, harnessHome, plan };
}

function harness(c, args) {
  return runHarness(
    [...args, '--workspace', c.ws, '--copilot-home', c.home, '--harness-home', c.harnessHome, '--json', '--no-events'],
    { env: { HARNESS_HOME: c.harnessHome, COPILOT_HOME: c.home, HARNESS_NO_EVENTS: '1' } },
  );
}

function teach(c) {
  const enabled = harness(c, ['knowledge', 'on']);
  assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  const taught = harness(c, [
    'correct', CLAIM,
    '--trigger', TRIGGER,
    '--why', WHY,
    '--applies', APPLIES,
    '--does-not-apply', DOES_NOT,
    '--authority', 'correction',
    '--domain', 'sql',
  ]);
  assert.equal(taught.status, 0, taught.stderr + taught.stdout);
  const learning = listLearnings(storeDir(c.ws, { home: c.harnessHome })).find((row) => row.id === 'sql/raw-concatenation');
  assert.ok(learning, taught.stdout);
  return fs.readFileSync(learning.file);
}

function orient(c) {
  const res = harness(c, ['orient', '--query', TRIGGER]);
  assert.equal(res.status, 0, res.stderr + res.stdout);
}

function verify(c) {
  return harness(c, ['verify', '--plan', c.plan, '--base', 'HEAD']);
}

function stop(c, enforcement) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: c.ws,
    input: JSON.stringify({ cwd: c.ws, workspace: c.ws, hook_event_name: 'Stop', stop_hook_active: false }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_BIN: binPath,
      HARNESS_HOME: c.harnessHome,
      COPILOT_HOME: c.home,
      HARNESS_ENFORCEMENT: enforcement,
      HARNESS_NO_EVENTS: '1',
    },
  });
}

function stopJson(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(line);
}

test('verify marks repeated-mistake from the diff tokens and leaves the lesson file untouched', () => {
  const c = ctx();
  const before = teach(c);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), BAD);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  orient(c);
  const repeated = verify(c);
  assert.equal(repeated.status, 2, repeated.stderr + repeated.stdout);
  assert.equal(JSON.parse(repeated.stdout).outcome, 'repeated-mistake');
  const learning = listLearnings(storeDir(c.ws, { home: c.harnessHome })).find((row) => row.id === 'sql/raw-concatenation');
  assert.equal(fs.readFileSync(learning.file).equals(before), true);

  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), CLEAR);
  const passed = verify(c);
  assert.equal(passed.status, 0, passed.stderr + passed.stdout);
  assert.equal(JSON.parse(passed.stdout).outcome, 'passed');
  assert.equal(fs.readFileSync(learning.file).equals(before), true);
});

test('stop blocks repeated-mistake under enforce and names harness correct', () => {
  const c = ctx();
  teach(c);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), BAD);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  orient(c);
  const blocked = stopJson(stop(c, 'enforce'));
  assert.equal(blocked.hookSpecificOutput.decision, 'block');
  assert.match(blocked.hookSpecificOutput.reason, /harness correct/);
  assert.match(blocked.hookSpecificOutput.reason, /repeated-mistake/);
});

test('stop warns and continues when repeated-mistake meets warn enforcement', () => {
  const c = ctx();
  teach(c);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), BAD);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  orient(c);
  const warned = stopJson(stop(c, 'warn'));
  assert.equal(warned.continue, true);
  assert.match(warned.systemMessage, /repeated-mistake/);
});

test('a served lesson the diff did not use still stops cleanly', () => {
  const c = ctx();
  teach(c);
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), CLEAR);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  orient(c);
  const allowed = stopJson(stop(c, 'enforce'));
  assert.equal(allowed.continue, true);
});

test('a stop with no fresh passing evidence does not complete', () => {
  const c = ctx();
  fs.rmSync(path.join(c.ws, '.github', 'harness', 'checks.yaml'));
  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), CLEAR);
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  const blocked = stopJson(stop(c, 'enforce'));
  assert.equal(blocked.hookSpecificOutput.decision, 'block');
  const evidenceDir = path.join(c.ws, '.harness', 'evidence');
  assert.equal(fs.existsSync(evidenceDir), true);
});
