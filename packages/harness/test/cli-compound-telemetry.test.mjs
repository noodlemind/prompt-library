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

test('compound indexes only after harness verify passes', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  const verify = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);
  assert.equal(verify.status, 0, verify.stderr);

  const result = runHarness([
    'compound',
    '--plan',
    plan,
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.ok(body.indexed);
  const usagePath = path.join(copilotHome, 'knowledge', 'skill-usage.yaml');
  assert.equal(fs.existsSync(usagePath), true);
  const usage = YAML.parse(fs.readFileSync(usagePath, 'utf8'));
  assert.equal(usage.skills.engineer.usage_count, 1);
  assert.equal(usage.skills.engineer.outcomes.passed, 1);
  assert.equal(readEvents(workspace).some((e) => e.type === 'compound'), true);
});

test('compound blocks when passed harness evidence is absent', () => {
  const workspace = tempDir('harness-workspace-');
  const plan = writeVersionedPlan(workspace);

  const result = runHarness(['compound', '--plan', plan, '--workspace', workspace, '--json']);

  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, false);
  assert.equal(body.exitCode, 2);
});

test('compound preserves malformed telemetry and still records session state', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const plan = writeVersionedPlan(workspace);
  writeChecks(workspace, {
    'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
  });
  initGit(workspace);
  const verify = runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']);
  assert.equal(verify.status, 0, verify.stderr);

  const knowledge = path.join(copilotHome, 'knowledge');
  const usagePath = path.join(knowledge, 'skill-usage.yaml');
  fs.mkdirSync(knowledge, { recursive: true });
  fs.writeFileSync(usagePath, 'skills: [unterminated', 'utf8');

  const result = runHarness([
    'compound',
    '--plan',
    plan,
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.pass, true);
  assert.deepEqual(body.telemetry.updated, []);
  assert.match(body.telemetry.error, /invalid skill usage telemetry/i);
  assert.equal(fs.readFileSync(usagePath, 'utf8'), 'skills: [unterminated');
  assert.ok(JSON.parse(fs.readFileSync(path.join(workspace, '.harness', 'session.json'), 'utf8')).lastCompoundAt);
});

test('gate and compound reject evidence after the plan or scoped workspace changes', () => {
  for (const mutation of ['plan', 'workspace']) {
    const workspace = tempDir('harness-workspace-');
    const copilotHome = tempDir('harness-copilot-');
    const plan = writeVersionedPlan(workspace);
    writeChecks(workspace, {
      'unit-tests': { command: [process.execPath, '-e', 'process.exit(0)'] },
    });
    initGit(workspace);
    fs.writeFileSync(path.join(workspace, 'src', 'example.js'), 'export const value = 2;\n');
    assert.equal(runHarness(['verify', '--plan', plan, '--base', 'HEAD', '--workspace', workspace, '--json']).status, 0);

    const target = mutation === 'plan' ? path.join(workspace, plan) : path.join(workspace, 'src', 'example.js');
    fs.appendFileSync(target, `\n// ${mutation} changed after verification\n`, 'utf8');

    const gate = runHarness(['gate', '--phase', 'verify', '--plan', plan, '--workspace', workspace, '--json']);
    assert.equal(gate.status, 1, gate.stderr);
    assert.equal(JSON.parse(gate.stdout).pass, false);

    const compound = runHarness([
      'compound',
      '--plan',
      plan,
      '--workspace',
      workspace,
      '--copilot-home',
      copilotHome,
      '--json',
    ]);
    assert.notEqual(compound.status, 0, compound.stderr);
    assert.equal(JSON.parse(compound.stdout).pass, false);
  }
});

test('telemetry preserves malformed history instead of overwriting it', () => {
  const copilotHome = tempDir('harness-copilot-');
  const knowledge = path.join(copilotHome, 'knowledge');
  const usagePath = path.join(knowledge, 'skill-usage.yaml');
  fs.mkdirSync(knowledge, { recursive: true });
  fs.writeFileSync(usagePath, 'skills: [unterminated', 'utf8');

  const invalidYaml = recordSkillUsage({
    copilotHome,
    plan: { path: 'docs/plans/x.md', fm: { skills_used: ['engineer'] } },
    evidence: { outcome: 'passed' },
  });
  assert.deepEqual(invalidYaml.updated, []);
  assert.match(invalidYaml.error, /invalid skill usage telemetry/i);
  assert.equal(fs.readFileSync(usagePath, 'utf8'), 'skills: [unterminated');

  const malformedEntry = 'skills:\n  engineer:\n    usage_count: many\n    outcomes: passed\n';
  fs.writeFileSync(usagePath, malformedEntry, 'utf8');
  const invalidEntry = recordSkillUsage({
    copilotHome,
    plan: { path: 'docs/plans/x.md', fm: { skills_used: ['engineer'] } },
    evidence: { outcome: 'passed' },
  });
  assert.deepEqual(invalidEntry.updated, []);
  assert.match(invalidEntry.error, /invalid skill usage telemetry/i);
  assert.equal(fs.readFileSync(usagePath, 'utf8'), malformedEntry);
});

test('telemetry serializes concurrent updates without losing counts', async () => {
  const copilotHome = tempDir('harness-copilot-');
  const moduleUrl = pathToFileURL(path.join(packageRoot, 'lib', 'telemetry.mjs')).href;
  const script = `
    import { recordSkillUsage } from ${JSON.stringify(moduleUrl)};
    recordSkillUsage({
      copilotHome: process.argv[1],
      plan: { path: 'docs/plans/x.md', fm: { skills_used: ['engineer'] } },
      evidence: { outcome: 'passed' }
    });
  `;
  const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, copilotHome], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`))));
  }));

  await Promise.all(runs);
  const usagePath = path.join(copilotHome, 'knowledge', 'skill-usage.yaml');
  const usage = YAML.parse(fs.readFileSync(usagePath, 'utf8'));
  assert.equal(usage.skills.engineer.usage_count, 6);
  assert.equal(usage.skills.engineer.outcomes.passed, 6);
  assert.equal(fs.existsSync(`${usagePath}.lock`), false);
});
