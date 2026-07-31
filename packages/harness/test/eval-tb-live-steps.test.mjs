import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AGENT_REF, buildLiveSteps } from '../../../evals/external/terminal_bench/live-steps.mjs';
import { BUNDLE_MOUNT_TARGET, harnessWrapperScript, activationCommands } from '../../../evals/external/terminal_bench/provision.mjs';
import { stampTaskLock } from '../../../evals/external/terminal_bench/harbor-adapter.mjs';
import { validateAgainstSchema, runRelease } from '../../../evals/release.mjs';
import { createBudget } from '../../../evals/lib/budget.mjs';

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const BASE_LOCK = JSON.parse(fs.readFileSync(new URL('../../../evals/external/terminal_bench/task-lock.json', import.meta.url), 'utf8'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-live-'));
}

/** A fixture dataset root with the anchor task, plus a lock stamped against it. */
function fixtureTask() {
  const datasetDir = tmpdir();
  const taskDir = path.join(datasetDir, 'cobol-modernization');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'instruction.md'), 'Modernize the COBOL program.');
  fs.mkdirSync(path.join(taskDir, 'tests'));
  fs.writeFileSync(path.join(taskDir, 'tests', 'test.sh'), 'pytest');
  return { datasetDir, taskDir, lock: stampTaskLock(taskDir, BASE_LOCK, 'cobol-modernization') };
}

/**
 * A fake harbor: `--version` succeeds; `run` writes the job's verifier reward
 * and the bridge done-file exactly where the real pipeline would.
 */
function fakeHarborSpawn({ reward = 1, exitCode = 0, writeTelemetry = true, providerCostUsd = 0.02 } = {}) {
  const invocations = [];
  return {
    invocations,
    spawnImpl: (cmd, args) => {
      invocations.push({ cmd, args });
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
        const verifierDir = path.join(jobsDir, jobName, 'trial-0', 'artifacts', 'logs', 'verifier');
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

function liveSteps({ datasetDir, taskDir, lock, spawnImpl, apiKey = 'test-key' }) {
  return buildLiveSteps({
    config: { execution: { environment: 'docker' } },
    lock,
    workDir: tmpdir(),
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
    assert.equal(doc.reproducibility.modelResolved, 'moonshotai/kimi-k2.7-code');
  }
  assert.ok(Math.abs(budget.spentUsd() - 0.04) < 1e-12, 'provider-reported cost is the ledger of record');
  const runs = invocations.filter((i) => i.args[0] === 'run');
  assert.equal(runs.length, 2, 'one fresh sandboxed run per condition');
  assert.ok(runs.every((i) => i.args.includes('--mounts')), 'the harness bundle is mounted in both conditions');
});

test('the remaining pair allowance caps each trial ceiling written to the bridge', async () => {
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
  assert.equal(ceilings[0], 5, 'first trial uses the profile ceiling');
  assert.equal(ceilings[1], 4, 'second trial is capped by what the pair has left ($7 - $3)');
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
