import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { binPath, runHarness } from './helpers/cli.mjs';
import { initGit, recordSuccessfulEdit, writeChecks, writeVersionedPlan, writeNoLearningDecision } from './helpers/cli-fixtures.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const editHook = path.join(repoRoot, 'packages', 'harness', 'corpus', 'hooks', 'require-plan-gate.mjs');
const stopHook = path.join(repoRoot, 'packages', 'harness', 'corpus', 'hooks', 'require-verification.mjs');

function normalizedDiff(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => !/^index [0-9a-f]+\.\.[0-9a-f]+(?:\s|$)/.test(line))
    .join('\n');
}

function ctx() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'unchanged-retry-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unchanged-retry-home-'));
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'unchanged-retry-hh-'));
  writeChecks(ws, { 'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] } });
  const plan = writeVersionedPlan(ws);
  initGit(ws);
  fs.writeFileSync(path.join(ws, 'src', 'example.js'), 'export const value = 2;\n');
  return { ws, home, harnessHome, plan };
}

function harness(c, args) {
  return runHarness(
    [...args, '--workspace', c.ws, '--copilot-home', c.home, '--harness-home', c.harnessHome, '--json', '--no-events'],
    { env: { HARNESS_HOME: c.harnessHome, COPILOT_HOME: c.home, HARNESS_NO_EVENTS: '1' } },
  );
}

function hookEnv(c) {
  return {
    ...process.env,
    HARNESS_BIN: binPath,
    HARNESS_HOME: c.harnessHome,
    COPILOT_HOME: c.home,
    HARNESS_ENFORCEMENT: 'enforce',
    HARNESS_NO_EVENTS: '1',
  };
}

function edit(c, file) {
  return spawnSync(process.execPath, [editHook], {
    cwd: c.ws,
    input: JSON.stringify({
      cwd: c.ws,
      session_id: 'vscode-session',
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: file },
    }),
    encoding: 'utf8',
    env: hookEnv(c),
  });
}

function stop(c) {
  return spawnSync(process.execPath, [stopHook], {
    cwd: c.ws,
    input: JSON.stringify({ cwd: c.ws, workspace: c.ws, hook_event_name: 'Stop', stop_hook_active: false }),
    encoding: 'utf8',
    env: hookEnv(c),
  });
}

function jsonLine(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(line);
}

function sessionOf(c) {
  return JSON.parse(fs.readFileSync(path.join(c.ws, '.harness', 'session.json'), 'utf8'));
}

test('verify stores the normalized diff and the next unchanged edit is unchanged-retry', () => {
  const c = ctx();
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);

  const first = jsonLine(edit(c, 'src/example.js'));
  assert.equal(first.continue, true);
  assert.equal(Object.hasOwn(sessionOf(c), 'diffFingerprint'), false);

  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  const verified = harness(c, ['verify', '--plan', c.plan, '--base', 'HEAD']);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(JSON.parse(verified.stdout).outcome, 'passed');
  assert.equal(Object.hasOwn(JSON.parse(verified.stdout), 'diffFingerprint'), false);

  const raw = spawnSync('git', ['diff', '--no-ext-diff', 'HEAD'], { cwd: c.ws, encoding: 'utf8' });
  assert.equal(raw.status, 0, raw.stderr);
  assert.match(raw.stdout, /^index [0-9a-f]+\.\.[0-9a-f]+/m);
  const fingerprint = normalizedDiff(raw.stdout);
  assert.equal(fingerprint.includes('\nindex '), false);
  assert.equal(sessionOf(c).diffFingerprint, fingerprint);

  const again = harness(c, ['verify', '--plan', c.plan, '--base', 'HEAD']);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(JSON.parse(again.stdout).outcome, 'passed');
  assert.equal(harness(c, ['compound', '--plan', c.plan, '--learning-decision', writeNoLearningDecision(c.ws)]).status, 0);
  const completed = harness(c, ['plan-update', '--plan', c.plan, '--status', 'done']);
  assert.equal(completed.status, 0, completed.stdout + completed.stderr);

  const stopped = jsonLine(stop(c));
  assert.equal(stopped.continue, true);
  assert.match(stopped.systemMessage, /Fresh passed Harness verification permits completion/);
  assert.equal(JSON.stringify(stopped).includes('unchanged-retry'), false);

  const blocked = jsonLine(edit(c, 'src/example.js'));
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /^unchanged-retry\b/);

  fs.writeFileSync(path.join(c.ws, 'src', 'example.js'), 'export const value = 3;\n');
  const changed = jsonLine(edit(c, 'src/example.js'));
  assert.equal(changed.continue, true);
});

test('an edit that supplies different bytes is allowed after verify', () => {
  const c = ctx();
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  recordSuccessfulEdit(c.ws, { file_path: 'src/example.js' });
  const verified = harness(c, ['verify', '--plan', c.plan, '--base', 'HEAD']);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const blocked = jsonLine(edit(c, 'src/example.js'));
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  const revised = jsonLine(spawnSync(process.execPath, [editHook], {
    cwd: c.ws,
    input: JSON.stringify({
      cwd: c.ws,
      session_id: 'vscode-session',
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: {
        filePath: 'src/example.js',
        old_string: 'export const value = 2;\n',
        new_string: 'export const value = 3;\n',
      },
    }),
    encoding: 'utf8',
    env: hookEnv(c),
  }));
  assert.equal(revised.continue, true);
});

test('the edit hook denies when the current diff cannot be read', () => {
  const c = ctx();
  const gate = harness(c, ['gate', '--plan', c.plan, '--phase', 'implement']);
  assert.equal(gate.status, 0, gate.stderr + gate.stdout);
  const sessionPath = path.join(c.ws, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.diffFingerprint = 'diff --git a/src/example.js\n';
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  const unavailableGitEnv = hookEnv(c);
  for (const key of Object.keys(unavailableGitEnv)) {
    if (key.toUpperCase() === 'PATH') delete unavailableGitEnv[key];
  }
  unavailableGitEnv.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'unchanged-retry-no-git-'));
  assert.equal(spawnSync('git', ['--version'], { env: unavailableGitEnv }).error?.code, 'ENOENT');
  const denied = jsonLine(spawnSync(process.execPath, [editHook], {
    cwd: c.ws,
    input: JSON.stringify({
      cwd: c.ws,
      session_id: 'vscode-session',
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'src/example.js' },
    }),
    encoding: 'utf8',
    env: unavailableGitEnv,
  }));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^unreadable-diff\b/);
});
