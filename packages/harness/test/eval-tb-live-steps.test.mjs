import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AGENT_REF, buildLiveSteps, aggregateSeedDocs } from '../../../evals/external/terminal_bench/live-steps.mjs';
import { BUNDLE_MOUNT_TARGET, harnessWrapperScript, activationCommands } from '../../../evals/external/terminal_bench/provision.mjs';
import { stampTaskLock } from '../../../evals/external/terminal_bench/harbor-adapter.mjs';
import { validateAgainstSchema, runRelease } from '../../../evals/release.mjs';
import { createBudget } from '../../../evals/lib/budget.mjs';

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const BASE_LOCK = JSON.parse(fs.readFileSync(new URL('../../../evals/external/terminal_bench/task-lock.json', import.meta.url), 'utf8'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-live-'));
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

/** A fixture dataset root with the anchor task, plus a lock pinning ONLY it. */
function fixtureTask() {
  const datasetDir = tmpdir();
  const taskDir = path.join(datasetDir, 'cobol-modernization');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'instruction.md'), 'Modernize the COBOL program.');
  fs.mkdirSync(path.join(taskDir, 'tests'));
  fs.writeFileSync(path.join(taskDir, 'tests', 'test.sh'), 'pytest');
  // Decouple from however many tasks the committed lock pins.
  const singleTaskLock = { ...BASE_LOCK, tasks: BASE_LOCK.tasks.filter((t) => t.task === 'cobol-modernization') };
  return { datasetDir, taskDir, lock: stampTaskLock(taskDir, singleTaskLock, 'cobol-modernization') };
}

/**
 * A fake harbor: `--version` succeeds; `run` writes the job's verifier reward
 * and the bridge done-file exactly where the real pipeline would.
 */
function fakeHarborSpawn({ reward = 1, exitCode = 0, writeTelemetry = true, providerCostUsd = 0.02 } = {}) {
  const invocations = [];
  return {
    invocations,
    spawnImpl: (cmd, args, opts) => {
      invocations.push({ cmd, args, opts });
      if (args[0] === '--version') return { status: 0, stdout: '0.20.0', stderr: '' };
      if (args[0] !== 'run') return { status: 0, stdout: '', stderr: '' };
      const jobsDir = args[args.indexOf('--jobs-dir') + 1];
      const jobName = args[args.indexOf('--job-name') + 1];
      const agentEnv = {};
      args.forEach((a, i) => {
        if (a === '--ae') {
          const [k, ...rest] = args[i + 1].split('=');
          agentEnv[k] = rest.join('=');
        }
      });
      if (exitCode === 0) {
        const verifierDir = path.join(jobsDir, jobName, 'trial-0', 'verifier');
        fs.mkdirSync(verifierDir, { recursive: true });
        fs.writeFileSync(path.join(verifierDir, 'reward.json'), JSON.stringify({ reward }));
        if (writeTelemetry && agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE) {
          fs.writeFileSync(
            agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE,
            JSON.stringify({
              type: 'done',
              answer: 'done',
              stopReason: 'model_finish',
              steps: 7,
              telemetry: {
                totals: {
                  requests: 5,
                  missingUsage: 0,
                  promptTokens: 4000,
                  cachedTokens: 1000,
                  reasoningTokens: 0,
                  outputTokens: 900,
                  localCostUsd: 0.018,
                  providerCostUsd,
                  costComplete: true,
                },
                events: [{ seq: 0, type: 'response', model: 'moonshotai/kimi-k2.7-code', provider: 'Moonshot AI', generationId: 'gen-1' }],
              },
            })
          );
        }
      }
      return { status: exitCode, stdout: '', stderr: exitCode ? 'boom' : '' };
    },
  };
}

function liveSteps({ datasetDir, taskDir, lock, spawnImpl, apiKey = 'test-key', workDir = tmpdir() }) {
  return buildLiveSteps({
    config: { execution: { environment: 'docker' } },
    lock,
    workDir,
    env: { OPENROUTER_API_KEY: apiKey, HARNESS_EVAL_TB_DATASET_DIR: datasetDir ?? path.dirname(taskDir) },
    releaseSha: 'sha1',
    harnessVersion: '0.5.0',
    spawnImpl,
    prepareBundle: ({ bundleDir }) => ({ bundleDir, mount: { source: bundleDir, target: BUNDLE_MOUNT_TARGET, readOnly: true } }),
  });
}

test('the harness wrapper picks the node runtime matching the container architecture', () => {
  const script = harnessWrapperScript();
  assert.match(script, /^#!\/bin\/sh/);
  // The task image arch is the registry's choice (cobol-modernization ships
  // amd64-only even on arm64 hosts) — the wrapper must decide at runtime.
  assert.match(script, /uname -m/);
  assert.ok(script.includes(`${BUNDLE_MOUNT_TARGET}/node-x64/bin/node`));
  assert.ok(script.includes(`${BUNDLE_MOUNT_TARGET}/node-arm64/bin/node`));
  assert.ok(script.includes(`${BUNDLE_MOUNT_TARGET}/harness/bin/harness.mjs`));
  assert.ok(script.includes('"$@"'));
});

test('activation installs the wrapper PATH-proof and proves the CLI answers with a real command', () => {
  const commands = activationCommands();
  assert.ok(commands.some((c) => c.includes('/usr/local/bin/harness')));
  assert.ok(commands.some((c) => c.includes('/usr/bin/harness')), 'a /usr/bin link survives minimal exec PATHs');
  assert.ok(
    commands.some((c) => /harness help/.test(c)),
    'the proof command must exist in the harness CLI (--version does not)'
  );
});

test('the task bytes are verified against the lock before any provider work', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  assert.equal((await steps.taskLock()).ok, true);
  fs.writeFileSync(path.join(taskDir, 'tests', 'test.sh'), 'tampered');
  const tampered = await steps.taskLock();
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /checksum/i);
});

test('a multi-task lock runs a fresh pair per pinned task with per-task job identities', async () => {
  const { taskDir, lock } = fixtureTask();
  // Second pinned task: its own directory and checksum entry.
  const datasetDir = path.dirname(taskDir);
  const secondDir = path.join(datasetDir, 'build-pmars');
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(secondDir, 'instruction.md'), 'Build pMARS.');
  const { stampTaskLock: stamp } = await import('../../../evals/external/terminal_bench/harbor-adapter.mjs');
  const multiLock = stamp(secondDir, lock, 'build-pmars');
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.01 });
  const steps = liveSteps({ taskDir, lock: multiLock, spawnImpl });
  assert.equal((await steps.taskLock()).ok, true, 'every pinned task verifies');
  const budget = createBudget({ ceilingUsd: 10, label: 'kimi-pair' });
  const pairs = await steps.kimiPair(budget);
  assert.equal(pairs.length, 2, 'one pair per pinned task');
  assert.deepEqual(
    pairs.map((p) => p.task),
    ['cobol-modernization', 'build-pmars']
  );
  const runs = invocations.filter((i) => i.args[0] === 'run');
  assert.equal(runs.length, 4, 'generic+harness per task');
  const jobNames = runs.map((i) => i.args[i.args.indexOf('--job-name') + 1]);
  assert.ok(jobNames.every((n, idx) => n.includes(pairs[Math.floor(idx / 2)].task)), 'job identity carries the task name');
  const conditionPaths = runs.map((i) => i.args[i.args.findIndex((a) => typeof a === 'string' && a.startsWith('HARNESS_EVAL_TB_CONDITION='))]);
  const ceilings = conditionPaths.map((kv) => JSON.parse(fs.readFileSync(kv.split('=')[1], 'utf8')).limits.trialCeilingUsd);
  assert.deepEqual(ceilings, [2.5, 2.5, 2.5, 2.5], 'the initial allowance is preallocated equally across every task and arm');
  assert.ok(Math.abs(budget.spentUsd() - 0.04) < 1e-12, 'all four trials charge the pair budget');
});

test('a live kimi pair produces two schema-valid run documents and charges provider-reported cost', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.02 });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  assert.equal((await steps.taskLock()).ok, true);
  const budget = createBudget({ ceilingUsd: 10, label: 'kimi-pair' });
  const [pair] = await steps.kimiPair(budget);
  assert.equal(pair.host, 'openrouter-kimi');
  for (const doc of [pair.generic, pair.harness]) {
    assert.deepEqual(validateAgainstSchema(doc, RUN_SCHEMA).errors, []);
    assert.equal(doc.correctness.verdict, 'pass');
    assert.equal(doc.efficiency.promptTokens, 4000, 'metered telemetry must be non-null');
    assert.equal(doc.efficiency.costComplete, true, 'every paid response was metered');
    assert.equal(doc.efficiency.missingUsage, 0);
    assert.equal(doc.reproducibility.modelResolved, 'moonshotai/kimi-k2.7-code');
  }
  assert.ok(Math.abs(budget.spentUsd() - 0.04) < 1e-12, 'provider-reported cost is the ledger of record');
  const runs = invocations.filter((i) => i.args[0] === 'run');
  assert.equal(runs.length, 2, 'one fresh sandboxed run per condition');
  assert.ok(runs.every((i) => i.args.includes('--mounts')), 'the harness bundle is mounted in both conditions');
  assert.ok(
    runs.every((i) => !i.args.some((arg) => typeof arg === 'string' && arg.startsWith('OPENROUTER_API_KEY='))),
    'the provider credential must never be placed in Harbor --ae arguments'
  );
});

test('the provider credential reaches injected Harbor only through spawn env and is never persisted', async () => {
  const sentinel = 'sentinel-openrouter-secret-do-not-persist';
  const { datasetDir, taskDir, lock } = fixtureTask();
  const workDir = tmpdir();
  const { spawnImpl, invocations } = fakeHarborSpawn();
  const steps = liveSteps({ datasetDir, taskDir, lock, spawnImpl, apiKey: sentinel, workDir });
  assert.equal((await steps.taskLock()).ok, true);
  const [pair] = await steps.kimiPair(createBudget({ ceilingUsd: 10, label: 'credential-boundary' }));

  const runs = invocations.filter((invocation) => invocation.args[0] === 'run');
  assert.equal(runs.length, 2);
  for (const invocation of runs) {
    assert.equal(invocation.opts.env.OPENROUTER_API_KEY, sentinel, 'injected spawns receive the provider key in env');
    assert.ok(!JSON.stringify(invocation.args).includes(sentinel), 'the key value must not enter Harbor argv');
    assert.ok(!invocation.args.some((arg) => String(arg).startsWith('OPENROUTER_API_KEY=')), 'the key must not enter --ae');
  }

  assert.ok(!JSON.stringify(pair).includes(sentinel), 'run documents and failure summaries must not contain the key');
  for (const artifact of filesUnder(workDir)) {
    assert.ok(!fs.readFileSync(artifact, 'utf8').includes(sentinel), `the key must not be persisted in ${path.basename(artifact)}`);
  }
});

test('the pair allowance is preallocated equally across both conditions', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 3 });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 7, label: 'kimi-pair' });
  await steps.kimiPair(budget);
  const conditionPaths = invocations
    .filter((i) => i.args[0] === 'run')
    .map((i) => i.args[i.args.findIndex((a) => typeof a === 'string' && a.startsWith('HARNESS_EVAL_TB_CONDITION=')) ]);
  const ceilings = conditionPaths.map((kv) => JSON.parse(fs.readFileSync(kv.split('=')[1], 'utf8')).limits.trialCeilingUsd);
  assert.deepEqual(ceilings, [3.5, 3.5], 'generic and harness receive identical fixed ceilings');
});

test('a nonzero harbor exit becomes an infrastructure-invalid pair that blocks an active gate', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn({ exitCode: 3 });
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  await steps.taskLock();
  const [pair] = await steps.kimiPair(createBudget({ ceilingUsd: 10, label: 'p' }));
  assert.equal(pair.failureKind, 'infrastructure');
});

test('missing credentials skip the pair without touching harbor run', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn();
  const steps = liveSteps({ taskDir, lock, spawnImpl, apiKey: null });
  const pair = await steps.kimiPair(createBudget({ ceilingUsd: 10, label: 'p' }));
  assert.equal(pair, null);
  assert.equal(invocations.filter((i) => i.args[0] === 'run').length, 0);
});

test('live steps feed runRelease end to end: green pair, valid report, exit 0', async () => {
  const { taskDir, lock } = fixtureTask();
  const { spawnImpl } = fakeHarborSpawn();
  const steps = liveSteps({ taskDir, lock, spawnImpl });
  const config = { budget: { releaseCeilingUsd: 20, kimiPairUsd: 10, rerunUsd: 8, reserveUsd: 2 }, task: { datasetRef: lock.datasetRef, task: lock.task } };
  const { report, exitCode } = await runRelease({
    config,
    steps: { ...steps, deterministic: async () => ({ passed: 17, failed: 0, skipped: 2 }) },
    requiredPairs: ['openrouter-kimi'],
  });
  assert.equal(exitCode, 0, JSON.stringify(report.gate.reasons));
  const kimi = report.pairs.find((p) => p.host === 'openrouter-kimi');
  assert.equal(kimi.result, 'parity');
  assert.ok(Math.abs(report.budget.spentUsd - 0.04) < 1e-12, 'live child charges reach the release report');
});

test('AGENT_REF matches the importable module path', () => {
  assert.equal(AGENT_REF, 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent');
});

function seedDoc({ verdict = 'pass', reward = 1, promptTokens = 1000, costUsd = 0.02, costComplete = true, missingUsage = 0 } = {}) {
  return {
    schema: 'eval-run.v1',
    reproducibility: { condition: 'generic', startedAt: '2026-07-31T00:00:00Z', endedAt: '2026-07-31T00:03:00Z' },
    correctness: { verifierReward: reward, verdict, exitReason: 'model_finish', completedWithinTimeout: true, completedWithinBudget: true },
    efficiency: { promptTokens, outputTokens: 500, modelRequests: 10, localCostUsd: costUsd, providerReportedCostUsd: costUsd, cachedPromptTokens: 0, reasoningTokens: 0, costComplete, missingUsage },
    harnessBehavior: {},
    subscription: null,
  };
}

test('seed aggregation: majority verdict over all seeds, median efficiency over valid ones', () => {
  const agg = aggregateSeedDocs([
    seedDoc({ verdict: 'pass', reward: 1, promptTokens: 100, costUsd: 0.01 }),
    seedDoc({ verdict: 'fail', reward: 0, promptTokens: 200, costUsd: 0.02 }),
    seedDoc({ verdict: 'pass', reward: 1, promptTokens: 400, costUsd: 0.04 }),
  ]);
  assert.equal(agg.correctness.verdict, 'pass', '2/3 passes is a pass');
  assert.equal(agg.correctness.verifierReward, 1, 'median reward');
  assert.equal(agg.efficiency.promptTokens, 200, 'median tokens');
  assert.match(agg.correctness.exitReason, /seed-aggregate\(n=3\)/);
});

test('seed aggregation: a null-reward seed can never count toward a pass', () => {
  const broken = seedDoc({ verdict: 'fail', reward: null });
  const agg = aggregateSeedDocs([seedDoc({ verdict: 'pass' }), broken, broken]);
  assert.equal(agg.correctness.verdict, 'fail', '1 pass of 3 attempted seeds is not a majority');
  assert.equal(agg.correctness.verifierReward, 1, 'median over valid rewards only');
});

test('seed aggregation preserves incomplete-cost evidence from any attempted seed', () => {
  const agg = aggregateSeedDocs([seedDoc(), seedDoc({ costComplete: false, missingUsage: 1 }), seedDoc()]);
  assert.equal(agg.efficiency.costComplete, false);
  assert.equal(agg.efficiency.missingUsage, 1);
});

test('seeds > 1 run per condition per task, all charging the pair budget', async () => {
  const { taskDir, lock, datasetDir } = fixtureTask();
  const { spawnImpl, invocations } = fakeHarborSpawn({ providerCostUsd: 0.01 });
  const steps = buildLiveSteps({
    config: { execution: { environment: 'docker' } },
    lock,
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tb-seeds-')),
    env: { OPENROUTER_API_KEY: 'k', HARNESS_EVAL_TB_DATASET_DIR: datasetDir ?? path.dirname(taskDir) },
    releaseSha: 's',
    harnessVersion: 'v',
    spawnImpl,
    seeds: 2,
    prepareBundle: ({ bundleDir }) => ({ bundleDir, mount: { source: bundleDir, target: BUNDLE_MOUNT_TARGET, readOnly: true } }),
  });
  await steps.taskLock();
  const budget = createBudget({ ceilingUsd: 10, label: 'kimi-pair' });
  const [pair] = await steps.kimiPair(budget);
  assert.equal(pair.seedCount, 2);
  const runs = invocations.filter((i) => i.args[0] === 'run');
  assert.equal(runs.length, 4, '2 seeds × 2 conditions');
  const jobNames = runs.map((i) => i.args[i.args.indexOf('--job-name') + 1]);
  assert.deepEqual(
    jobNames.map((name) => name.match(/(generic|harness)-a\d$/)?.[1]),
    ['generic', 'harness', 'harness', 'generic'],
    'condition order alternates AB then BA across seed repetitions'
  );
  const conditionPaths = runs.map((i) => i.args[i.args.findIndex((a) => typeof a === 'string' && a.startsWith('HARNESS_EVAL_TB_CONDITION='))]);
  const ceilings = conditionPaths.map((kv) => JSON.parse(fs.readFileSync(kv.split('=')[1], 'utf8')).limits.trialCeilingUsd);
  assert.deepEqual(ceilings, [2.5, 2.5, 2.5, 2.5], 'every seed arm receives an equal preallocated ceiling');
  assert.ok(Math.abs(budget.spentUsd() - 0.04) < 1e-12, 'every seed trial charges the pair budget');
  assert.equal(pair.generic.correctness.verdict, 'pass');
  assert.match(pair.generic.correctness.exitReason, /seed-aggregate\(n=2\)/);
});
