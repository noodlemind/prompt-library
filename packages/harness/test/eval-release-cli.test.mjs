import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stampTaskLock } from '../../../evals/external/terminal_bench/harbor-adapter.mjs';
import { prepareHarnessBundle } from '../../../evals/external/terminal_bench/provision.mjs';

/**
 * True end-to-end: `node evals/release.mjs` in release-candidate mode against
 * a fake harbor CLI on PATH. No injected steps — this exercises main(), flag
 * parsing, live-step wiring, task verification, budget accounting, and the
 * gate, exactly as an operator would run it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASE_LOCK = JSON.parse(fs.readFileSync(path.join(repoRoot, 'evals', 'external', 'terminal_bench', 'task-lock.json'), 'utf8'));
const SENTINEL_PROVIDER_KEY = 'sentinel-openrouter-secret-do-not-persist';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-'));
}

function filesUnder(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function setupFixture({ taskNames = ['cobol-modernization'] } = {}) {
  const datasetDir = tmpdir();
  for (const taskName of taskNames) {
    const taskDir = path.join(datasetDir, taskName);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'instruction.md'), `Complete ${taskName}.`);
  }
  const lockFile = path.join(tmpdir(), 'lock.json');
  let selectedLock = { ...BASE_LOCK, tasks: BASE_LOCK.tasks.filter((entry) => taskNames.includes(entry.task)) };
  for (const taskName of taskNames) {
    selectedLock = stampTaskLock(path.join(datasetDir, taskName), selectedLock, taskName);
  }
  fs.writeFileSync(lockFile, JSON.stringify(selectedLock));

  const binDir = tmpdir();
  const auditFile = path.join(binDir, 'harbor-audit.jsonl');
  const fakeHarbor = path.join(binDir, 'fake-harbor.mjs');
  fs.writeFileSync(
    fakeHarbor,
    `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.20.0'); process.exit(0); }
if (args[0] !== 'run') process.exit(0);
const jobsDir = args[args.indexOf('--jobs-dir') + 1];
const jobName = args[args.indexOf('--job-name') + 1];
const agentEnv = {};
args.forEach((a, i) => { if (a === '--ae') { const [k, ...r] = args[i + 1].split('='); agentEnv[k] = r.join('='); } });
const providerKey = process.env.OPENROUTER_API_KEY;
const githubTokenPresent = Object.hasOwn(process.env, 'GITHUB_TOKEN');
const secretInArgv = Boolean(providerKey && args.some((arg) => arg.includes(providerKey)));
const providerKeyInAgentEnv = Object.hasOwn(agentEnv, 'OPENROUTER_API_KEY');
fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({
  providerKeyPresent: Boolean(providerKey),
  githubTokenPresent,
  secretInArgv,
  providerKeyInAgentEnv,
  conditionPath: agentEnv.HARNESS_EVAL_TB_CONDITION,
  telemetryFile: agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE,
  jobName,
  jobsDir,
}) + '\\n');
if (!providerKey || secretInArgv || providerKeyInAgentEnv) {
  console.error('unsafe provider credential delivery');
  process.exit(86);
}
const verifierDir = path.join(jobsDir, jobName, 'trial-0', 'verifier');
fs.mkdirSync(verifierDir, { recursive: true });
fs.writeFileSync(path.join(verifierDir, 'reward.json'), '{"reward": 1}');
fs.writeFileSync(agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE, JSON.stringify({
  type: 'done', answer: 'ok', stopReason: 'model_finish', steps: 6,
  workspaceEvidence: {
    available: true,
    collectionMode: 'bounded-content-manifest-v1',
    beforeManifestHash: 'a'.repeat(64),
    afterManifestHash: 'b'.repeat(64),
    diffHash: 'c'.repeat(64),
    changedPaths: ['src/result.txt'],
    changedPathCount: 1,
    changedPathsTruncated: false,
  },
  harnessEvents: [],
  harnessEventEvidence: { available: true, complete: true, reason: null, retainedEvents: 0, sourceTruncated: false, projectionRejectedEvents: 0, projectionRejectedChecks: 0 },
  enforcement: { hooksActive: false, policyBypassAchieved: false },
  telemetry: {
    totals: { requests: 4, modelRequests: 4, providerAttempts: 4, providerResponses: 4, providerErrors: 0, retries: 0, openAttempts: 0, unknownBillingAttempts: 0, missingUsage: 0, promptTokens: 3000, cachedTokens: 500, reasoningTokens: 0, outputTokens: 700, localCostUsd: 0.015, providerCostUsd: 0.02, usageComplete: true, providerCostComplete: true, billingComplete: true, costComplete: true },
    events: Array.from({ length: 4 }, (_, index) => [
      { seq: index * 3, type: 'request', requestId: 'r' + (index + 1) },
      { seq: index * 3 + 1, type: 'request_attempt', requestId: 'r' + (index + 1), attemptId: 'a' + (index + 1) },
      { seq: index * 3 + 2, type: 'response', requestId: 'r' + (index + 1), attemptId: 'a' + (index + 1), model: 'moonshotai/kimi-k2.7-code', provider: 'Moonshot AI', generationId: 'g' + (index + 1) },
    ]).flat(),
  },
}));
process.exit(0);
`
  );
  fs.writeFileSync(path.join(binDir, 'harbor'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeHarbor)} "$@"\n`, { mode: 0o755 });
  const fetchPreload = path.join(binDir, 'provider-key-fetch-preload.mjs');
  fs.writeFileSync(
    fetchPreload,
    `globalThis.fetch = async (url) => {
      if (String(url) !== 'https://openrouter.ai/api/v1/key') throw new Error('unexpected network request');
      return { ok: true, status: 200, json: async () => ({ data: { limit: 10, limit_remaining: 10, limit_reset: null } }) };
    };\n`
  );
  const bundleFixtureRoot = tmpdir();
  fs.mkdirSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(bundleFixtureRoot, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.writeFileSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'package.json'), JSON.stringify({ name: '@fixture/harness' }));
  fs.writeFileSync(path.join(bundleFixtureRoot, 'packages', 'harness', 'bin', 'harness.mjs'), 'process.stdout.write("ok\\n")');
  fs.writeFileSync(path.join(bundleFixtureRoot, 'evals', 'external', 'terminal_bench', 'evidence-probe.mjs'), 'process.stdout.write("{}\\n")');
  fs.writeFileSync(path.join(bundleFixtureRoot, 'evals', 'external', 'terminal_bench', 'bounded-exec.mjs'), 'process.stdout.write("{}\\n")');
  const bundleDir = path.join(tmpdir(), 'bundle');
  const prepared = prepareHarnessBundle({
    bundleDir,
    repoRoot: bundleFixtureRoot,
    nodeTarballs: { x64: '/unused/node-x64.tar.gz', arm64: null },
    spawnImpl: (command, args) => {
      if (command === 'cp') fs.cpSync(args[1], args[2], { recursive: true });
      if (command === 'tar') {
        const destination = args[args.indexOf('-C') + 1];
        fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(destination, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
      }
      return { status: 0, stderr: '' };
    },
  });
  return { datasetDir, lockFile, binDir, bundleDir, bundleHash: prepared.manifestHash, auditFile, fetchPreload };
}

function runCli({ datasetDir, lockFile, binDir, bundleDir, bundleHash, auditFile, fetchPreload, withKey = true, task = null, omitTaskValue = false }) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    HARNESS_EVAL_TB_DATASET_DIR: datasetDir,
    HARNESS_EVAL_TB_BUNDLE_DIR: bundleDir,
    HARNESS_EVAL_TB_BUNDLE_SHA256: bundleHash,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${fetchPreload}`.trim(),
    GITHUB_TOKEN: 'sentinel-unrelated-ci-token',
  };
  if (withKey) env.OPENROUTER_API_KEY = SENTINEL_PROVIDER_KEY;
  else delete env.OPENROUTER_API_KEY;
  const args = ['evals/release.mjs', '--profile', 'release-canary', '--json', '--lock-file', lockFile];
  if (omitTaskValue) args.push('--task');
  else if (task !== null) args.push('--task', task);
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 600_000,
  });
}

test('release-candidate mode runs a live kimi pair end to end through the CLI', () => {
  const fixture = setupFixture();
  const result = runCli(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes(SENTINEL_PROVIDER_KEY), 'CLI output and errors must not echo the provider key');
  const report = JSON.parse(result.stdout);
  assert.match(report.releaseSha, /^[a-f0-9]{40,64}$/, 'normal live commands derive a real HEAD identity for order balancing');
  const kimi = report.pairs.find((p) => p.host === 'openrouter-kimi');
  assert.equal(kimi.generic.reproducibility.releaseSha, report.releaseSha);
  assert.equal(kimi.harness.reproducibility.releaseSha, report.releaseSha);
  assert.equal(kimi.result, 'parity');
  assert.equal(kimi.generic.correctness.verdict, 'pass');
  assert.equal(kimi.harness.correctness.verdict, 'pass');
  assert.equal(kimi.generic.efficiency.promptTokens, 3000, 'live docs carry real metered telemetry');
  assert.ok(Math.abs(report.budget.spentUsd - 0.04) < 1e-12, 'provider-reported spend reaches the release ledger');
  assert.equal(report.gate.block, false);
  assert.ok(!JSON.stringify(report).includes(SENTINEL_PROVIDER_KEY), 'the persisted/reportable result must not contain the provider key');

  const audits = fs
    .readFileSync(fixture.auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(audits.length, 2, 'generic and harness both reached fake Harbor');
  assert.ok(audits.every((audit) => audit.providerKeyPresent), 'real spawned Harbor receives the key through its process environment');
  assert.ok(audits.every((audit) => !audit.githubTokenPresent), 'unrelated ambient CI credentials are excluded from Harbor');
  assert.ok(audits.every((audit) => !audit.secretInArgv && !audit.providerKeyInAgentEnv), 'neither argv nor --ae receives the key');
  const artifactRoots = new Set([
    fixture.datasetDir,
    path.dirname(fixture.lockFile),
    fixture.binDir,
    fixture.bundleDir,
  ]);
  for (const root of artifactRoots) {
    for (const artifact of filesUnder(root)) {
      assert.ok(!fs.readFileSync(artifact, 'utf8').includes(SENTINEL_PROVIDER_KEY), `the key must not be persisted in ${path.basename(artifact)}`);
    }
  }
  assert.ok(
    audits.every((audit) => !fs.existsSync(path.dirname(audit.conditionPath))),
    'the release work directory, including read-only verified snapshots, is removed after the run'
  );
});

test('release-candidate mode without credentials blocks instead of greening', () => {
  const fixture = setupFixture();
  const result = runCli({ ...fixture, withKey: false });
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.gate.reasons.some((r) => /dependencies or credentials/i.test(r)));
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-kimi').result, 'skipped');
});

test('--task selects exactly one pinned task for metadata, validation, budgeting, and Harbor execution', () => {
  const fixture = setupFixture({ taskNames: ['cobol-modernization', 'cancel-async-tasks'] });
  const result = runCli({ ...fixture, task: 'cancel-async-tasks' });
  assert.ok([0, 1].includes(result.status), result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.task.task, 'cancel-async-tasks');
  assert.deepEqual(report.task.taskSet.map((entry) => entry.task), ['cancel-async-tasks']);
  assert.deepEqual(report.coverage.expectedTasks, ['cancel-async-tasks']);
  assert.equal(report.coverage.complete, true);
  const audits = fs.readFileSync(fixture.auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audits.length, 2, 'one selected task runs exactly one generic and one harness arm');
  assert.ok(audits.every((audit) => audit.jobName.includes('cancel-async-tasks')));
});

test('--task rejects an unknown task before environment preflight or paid Harbor execution', () => {
  const fixture = setupFixture({ taskNames: ['cobol-modernization', 'cancel-async-tasks'] });
  const result = runCli({ ...fixture, task: 'not-in-lock' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not-in-lock.*pinned task|unknown.*task/i);
  assert.equal(fs.existsSync(fixture.auditFile), false, 'Harbor must not run for an invalid selection');
});

test('--task requires a nonempty value instead of silently running every paid task', () => {
  for (const selection of [{ omitTaskValue: true }, { task: '' }]) {
    const fixture = setupFixture({ taskNames: ['cobol-modernization', 'cancel-async-tasks'] });
    const result = runCli({ ...fixture, ...selection });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--task.*nonempty|requires.*value/i);
    assert.equal(fs.existsSync(fixture.auditFile), false, 'Harbor must not run for a missing task value');
  }
});
