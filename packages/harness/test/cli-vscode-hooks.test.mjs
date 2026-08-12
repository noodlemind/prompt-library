import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { applyRetired, syncAssetsToTarget } from '../lib/sync.mjs';
import { parsePlanFrontmatter } from '../lib/plan-parse.mjs';
import { scanPlansForGate } from '../lib/gate.mjs';
import { CONTEXT_PACK_MAX_BYTES, buildContextPack } from '../lib/context-pack.mjs';
import { extractGoalFromPlan } from '../lib/plan-goal.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { createEvidenceBinding, readEvidence, validateEvidence, writeEvidence } from '../lib/evidence.mjs';
import { ensureHarnessDir } from '../lib/session.mjs';
import { installGlobalHarnessShim, globalHarnessShimPath, INSTALL_FIX_HINT } from '../lib/global-bin.mjs';
import { harnessRunnerSource, RUNNER_VERSION, writeHarnessRunner } from '../lib/resolve-harness-bin.mjs';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { recordSkillUsage } from '../lib/telemetry.mjs';
import { mergeVSCodeSettings, parseVSCodeSettings } from '../lib/vscode-settings.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { validatePlanScope } from '../lib/plan-scope.mjs';
import { listCommands } from '../lib/registry.mjs';
import { HELP_COMMAND_ORDER } from '../bin/harness.mjs';
import YAML from 'yaml';
import { approveProject } from '../lib/trust.mjs';
import { tempDir, runHarness, writePlan, packageRoot, binPath } from './helpers/index.mjs';
import {
  writeKnowledgeSolution,
  runIndex,
  writeProductSolution,
  writeChecks,
  writeVersionedPlan,
  initGit,
  runHook,
  runHookWithPolicy,
  hookResponse,
  assertHookBlocked,
  recordSuccessfulEdit,
} from './helpers/cli-fixtures.mjs';

function readEvents(workspace) {
  const eventsPath = path.join(workspace, '.harness', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('VS Code configuration explicitly discovers hydrated user hooks', () => {
  const settings = mergeVSCodeSettings({ 'chat.hookFilesLocations': { 'custom/hooks': true } });
  assert.equal(settings['chat.hookFilesLocations']['custom/hooks'], true);
  assert.equal(settings['chat.hookFilesLocations']['~/.copilot/hooks'], true);
});

test('VS Code settings parser preserves URL strings and accepts JSONC comments', () => {
  const settings = parseVSCodeSettings(`{
    // User setting
    "service.url": "https://example.test/path", // inline comment
    /* existing hook */
    "chat.hookFilesLocations": {"custom/hooks": true,},
  }`);
  assert.equal(settings['service.url'], 'https://example.test/path');
  assert.equal(settings['chat.hookFilesLocations']['custom/hooks'], true);
});

test('VS Code doctor proves discovery, gate, post-tool, and completion behavior', async () => {
  const copilotHome = tempDir('harness-copilot-');
  const assetsRoot = tempDir('harness-assets-');
  const workspace = tempDir('harness-workspace-');
  const sourceHooks = path.resolve(packageRoot, '../../.github/hooks');
  fs.cpSync(sourceHooks, path.join(assetsRoot, 'hooks'), { recursive: true });
  syncAssetsToTarget(assetsRoot, copilotHome, { dryRun: false, preserveKnowledge: true, verbose: false }, () => {});
  const settingsPath = path.join(tempDir('harness-vscode-'), 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(mergeVSCodeSettings({})));

  const result = await runDoctor({
    copilotHome,
    assetsRoot,
    pkgRoot: packageRoot,
    flags: { workspace, host: 'vscode' },
    vscodeSettingsPaths: [settingsPath],
  });
  const hostChecks = result.checks.filter((check) => /^V\d+$/.test(check.id));

  assert.deepEqual(hostChecks.map((check) => check.id), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9']);
  assert.ok(hostChecks.every((check) => check.pass), JSON.stringify(hostChecks, null, 2));
});

test('pre-edit hook fails closed on malformed input payloads', () => {
  const workspace = tempDir('harness-workspace-');
  const result = spawnSync(process.execPath, [path.join(packageRoot, '../../.github/hooks', 'require-plan-gate.mjs')], {
    cwd: workspace,
    input: '{not-json',
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce' },
  });

  assertHookBlocked(result, /payload/i);
});

test('hooks honor repository enforcement and freshness policy', () => {
  const workspace = tempDir('harness-workspace-');
  const configDir = path.join(workspace, '.github', 'harness');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'policy.yaml'),
    'version: 1\nenforcement: warn\ngate_ttl_minutes: 1\nevidence_ttl_hours: 1\n',
    'utf8'
  );

  const warning = runHookWithPolicy('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  const warningResponse = hookResponse(warning);
  assert.match(warningResponse.systemMessage, /missing-implement-gate/i);

  const plan = writeVersionedPlan(workspace);
  assert.equal(runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.lastGateAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  fs.writeFileSync(
    path.join(configDir, 'policy.yaml'),
    'version: 1\nenforcement: enforce\ngate_ttl_minutes: 1\nevidence_ttl_hours: 1\n',
    'utf8'
  );

  const stale = runHookWithPolicy('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  assertHookBlocked(stale, /stale/i);
});

test('pre-edit hook requires an explicit passed gate and planned scope', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const blocked = runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  assertHookBlocked(blocked, /missing-implement-gate/i);

  const gate = runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']);
  assert.equal(gate.status, 0, gate.stderr);
  const allowed = runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  assert.equal(allowed.status, 0, allowed.stderr);
  const outside = runHook('require-plan-gate.mjs', workspace, { file_path: 'src/outside.js' });
  assertHookBlocked(outside, /outside the plan/i);

  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.lastGateAt = 'not-a-date';
  fs.writeFileSync(sessionPath, JSON.stringify(session), 'utf8');
  const invalidTimestamp = runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' });
  assertHookBlocked(invalidTimestamp, /timestamp/i);
});

test('Bash file mutations require planned scope and create pending verification state', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const readOnly = runHook('require-plan-gate.mjs', workspace, { command: 'rg -n TODO src' });
  assert.equal(readOnly.status, 0, readOnly.stderr);

  const blocked = runHook('require-plan-gate.mjs', workspace, { command: 'printf changed > src/example.js' });
  assertHookBlocked(blocked, /missing-implement-gate/i);

  assert.equal(runHarness(['gate', '--phase', 'implement', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  const outside = runHook('require-plan-gate.mjs', workspace, { command: 'printf changed > src/outside.js' });
  assertHookBlocked(outside, /outside the plan/i);

  const hiddenOutside = runHook('require-plan-gate.mjs', workspace, {
    command: 'cp src/example.js src/outside.js > src/example.js',
  });
  assertHookBlocked(hiddenOutside, /src\/outside\.js/);

  for (const command of [
    'mv src/outside.js src/example.js',
    'ln src/outside.js src/example.js',
    'git -C . checkout -- src/outside.js',
    'sed --in-place s/old/new/ src/outside.js',
    'git reset --hard HEAD',
    'git stash pop',
  ]) {
    const scoped = runHook('require-plan-gate.mjs', workspace, { command });
    assertHookBlocked(scoped, /src\/outside\.js|target could not be resolved/i);
  }

  const allowed = runHook('require-plan-gate.mjs', workspace, { command: 'printf changed > src/example.js' });
  assert.equal(allowed.status, 0, allowed.stderr);
  recordSuccessfulEdit(workspace, { command: 'printf changed > src/example.js' });
  const pending = runHook('require-verification.mjs', workspace);
  assertHookBlocked(pending, /verify has not run/i);
});

test('completion hook bypasses read-only work and enforces each new recorded edit', () => {
  const readOnlyWorkspace = tempDir('harness-workspace-');
  assert.equal(runHook('require-verification.mjs', readOnlyWorkspace).status, 0);

  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  assert.equal(runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  assert.equal(runHook('require-verification.mjs', workspace).status, 0, 'a gated but unedited session is read-only');

  assert.equal(runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' }).status, 0);
  recordSuccessfulEdit(workspace, { file_path: 'src/example.js' });
  const unverified = runHook('require-verification.mjs', workspace);
  assertHookBlocked(unverified, /verify has not run/i);

  assert.equal(runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']).status, 0);
  const sessionPath = path.join(workspace, '.harness', 'session.json');
  let session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const evidencePath = path.join(workspace, session.lastEvidencePath);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const originalVerifiedAt = evidence.verifiedAt;
  evidence.verifiedAt = new Date(Date.parse(session.lastEditAt) - 1000).toISOString();
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const evidenceBeforeEdit = runHook('require-verification.mjs', workspace);
  assertHookBlocked(evidenceBeforeEdit, /changed after/i);
  evidence.verifiedAt = originalVerifiedAt;
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));

  const originalLastVerifyAt = session.lastVerifyAt;
  session.lastVerifyAt = 'invalid';
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  const invalidSessionTimestamp = runHook('require-verification.mjs', workspace);
  assertHookBlocked(invalidSessionTimestamp, /timestamp.*invalid/i);
  session.lastVerifyAt = originalLastVerifyAt;
  fs.writeFileSync(sessionPath, JSON.stringify(session));

  assert.equal(runHook('require-verification.mjs', workspace).status, 0);
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert.equal(session.lastCompletedEditAt, session.lastEditAt);
  assert.equal(runHook('require-verification.mjs', workspace).status, 0, 'later read-only stops reuse the completed marker');

  assert.equal(runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' }).status, 0);
  recordSuccessfulEdit(workspace, { file_path: 'src/example.js' });
  session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    session.lastEditAt = new Date(
    Math.max(Date.parse(session.lastCompletedEditAt), Date.parse(session.lastVerifyAt)) + 1000
  ).toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  const changedAfter = runHook('require-verification.mjs', workspace);
  assertHookBlocked(changedAfter, /changed after/i);
});

test('completion hook rejects failed and inconclusive evidence for a pending edit', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(1)'] },
  });
  initGit(workspace);
  assert.equal(runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  assert.equal(runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' }).status, 0);
  recordSuccessfulEdit(workspace, { file_path: 'src/example.js' });
  assert.equal(runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']).status, 1);

  const failed = runHook('require-verification.mjs', workspace);
  assertHookBlocked(failed, /outcome is failed/i);

  const session = JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8'));
  const evidencePath = path.join(workspace, session.lastEvidencePath);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  evidence.outcome = 'inconclusive';
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const inconclusive = runHook('require-verification.mjs', workspace);
  assertHookBlocked(inconclusive, /outcome is inconclusive/i);
});

test('completion hook normalizes Windows-style plan paths', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  assert.equal(runHarness(['gate', '--plan', plan, '--workspace', workspace, '--json']).status, 0);
  assert.equal(runHook('require-plan-gate.mjs', workspace, { file_path: 'src/example.js' }).status, 0);
  recordSuccessfulEdit(workspace, { file_path: 'src/example.js' });
  assert.equal(runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']).status, 0);

  const sessionPath = path.join(workspace, '.harness', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const evidencePath = path.join(workspace, session.lastEvidencePath);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  session.activePlan = session.activePlan.replace(/\//g, '\\');
  evidence.plan = evidence.plan.replace(/\//g, '\\');
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));

  const completion = runHook('require-verification.mjs', workspace);
  assert.equal(completion.status, 0, completion.stderr);
});
