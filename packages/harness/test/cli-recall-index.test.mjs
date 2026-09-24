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
import { resolveIndexDir } from '../lib/recall-config.mjs';
import { tempDir, runHarness, writePlan, packageRoot, binPath, cliHarnessHome } from './helpers/index.mjs';
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

test('recall positional query excludes option values', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const result = runHarness([
    'recall',
    'orders timeout',
    '--limit',
    '3',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).query, 'orders timeout');
});

test('index writes enriched manifest fields and postings index', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome);

  const result = runHarness(['index', '--workspace', workspace, '--copilot-home', copilotHome, '--json']);
  assert.equal(result.status, 0, result.stderr);

  const manifest = fs.readFileSync(path.join(copilotHome, 'knowledge', 'manifest.yaml'), 'utf8');
  assert.match(manifest, /symptom:/);
  assert.match(manifest, /module:/);
  assert.match(manifest, /excerpt:/);
  assert.match(manifest, /docid:/);
  const indexDir = path.join(cliHarnessHome(), 'index');
  const posting = fs.readdirSync(indexDir, { recursive: true }).map(String).find((name) => name.endsWith(`${path.sep}knowledge${path.sep}postings.json`) || name.endsWith('/knowledge/postings.json'));
  assert.ok(posting, 'postings live under the harness home');
});

test('--harness-home puts knowledge postings under that root, ahead of HARNESS_HOME', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const flagHome = tempDir('harness-flag-');
  const envHome = tempDir('harness-env-');
  writeKnowledgeSolution(copilotHome);

  const result = runHarness(
    ['index', '--workspace', workspace, '--copilot-home', copilotHome, '--harness-home', flagHome, '--json'],
    { env: { HARNESS_HOME: envHome } },
  );
  assert.equal(result.status, 0, result.stderr);
  const indexDir = resolveIndexDir(copilotHome, workspace, flagHome);
  assert.ok(fs.existsSync(path.join(indexDir, 'postings.json')), indexDir);
  assert.equal(fs.existsSync(path.join(envHome, 'index')), false, 'env home must not receive the index');
  assert.equal(fs.existsSync(path.join(copilotHome, 'knowledge', '.harness-index')), false);
  const manifest = path.join(copilotHome, 'knowledge', 'manifest.yaml');
  assert.ok(fs.existsSync(manifest), 'manifest stays in the Copilot knowledge home');
});

test('BM25 recall ranks symptom match above title-only match', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, {
    slug: 'orders-timeout',
    symptom: 'checkout requests hang after 30 seconds',
    title: 'Orders API timeout',
  });
  writeKnowledgeSolution(copilotHome, {
    category: 'misc',
    slug: 'unrelated',
    title: 'checkout dashboard',
    symptom: 'unrelated issue',
    body: '## Problem\n\nUnrelated content.',
  });
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'recall',
    'checkout hang',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.recall.length >= 1);
  assert.equal(body.recall[0].docid, 'global-api-orders-timeout');
  assert.equal(body.recall[0].ranker, 'bm25');
  assert.ok(body.recall[0].snippet.length > 0);
});

test('synonym expansion improves recall for aliased query', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, {
    symptom: 'requests hit deadline after 30 seconds',
    title: 'Deadline issue',
    tags: 'commerce, checkout',
  });
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'recall',
    'timeout',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.recall.length >= 1);
  assert.ok(body.recall[0].score > 0);
});

test('collection filter excludes non-matching scope', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, { slug: 'global-one', symptom: 'shared timeout symptom' });
  writeProductSolution(workspace, { slug: 'prod-one', symptom: 'shared timeout symptom' });
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'recall',
    'timeout symptom',
    '-c',
    'product',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.recall.length, 1);
  assert.match(body.recall[0].path, /docs\/solutions/);
});

test('min-score filters low-scoring recall hits', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, { symptom: 'very specific database deadlock symptom' });
  runIndex(workspace, copilotHome);

  const baseline = runHarness([
    'recall',
    'database',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);
  assert.equal(baseline.status, 0, baseline.stderr);
  const baselineBody = JSON.parse(baseline.stdout);
  assert.ok(baselineBody.recall.length > 0, 'baseline recall should return hits');
  const hitScore = baselineBody.recall[0].score;

  const result = runHarness([
    'recall',
    'database',
    '--min-score',
    String(Math.min(hitScore + 0.001, 1)),
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).recall.length, 0);
});

test('get returns bounded excerpt by docid', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  const docid = writeKnowledgeSolution(copilotHome);
  runIndex(workspace, copilotHome);

  const result = runHarness([
    'get',
    '--docid',
    docid,
    '--lines',
    '10',
    '--max-bytes',
    '500',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.docid, docid);
  assert.ok(body.excerpt.includes('Problem'));
  assert.ok(body.bytes <= 500);
});

test('recall falls back to overlap ranker when postings index missing', () => {
  const workspace = tempDir('harness-workspace-');
  const copilotHome = tempDir('harness-copilot-');
  writeKnowledgeSolution(copilotHome, { symptom: 'timeout on checkout path' });
  runIndex(workspace, copilotHome);
  fs.rmSync(resolveIndexDir(copilotHome, workspace, cliHarnessHome()), { recursive: true, force: true });

  const result = runHarness([
    'recall',
    'checkout timeout',
    '--workspace',
    workspace,
    '--copilot-home',
    copilotHome,
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(body.recall.length >= 1);
  assert.equal(body.recall[0].ranker, 'overlap');
});
