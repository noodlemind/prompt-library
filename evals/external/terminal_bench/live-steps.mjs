/**
 * Live release steps: the callable implementation of the Kimi A/B pair.
 *
 * `buildLiveSteps` returns the step functions `runRelease` schedules. The
 * flow per trial: verify the pinned task bytes (before any provider work),
 * write the condition file (with the trial ceiling capped by the pair's
 * remaining allowance), invoke `harbor run` with a deterministic job
 * identity and the mounted harness bundle, then read the official verifier
 * evidence and the bridge's done-file to build a schema-valid eval-run
 * document. Provider-reported cost is the ledger of record — every child
 * charge lands on the release-side budget chain.
 *
 * Everything external (harbor, filesystem layout, bundle prep) is injected
 * so the whole path is testable without a container or a provider.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost as createKimiHost } from '../../hosts/openrouter-kimi.mjs';
import { buildHarborRunArgs, jobDirFor, runHarbor, verifyTaskAgainstLock, classifyFailure, tasksOf } from './harbor-adapter.mjs';
import { collectVerifierEvidence, verdictFromReward } from './verifier.mjs';
import { buildGenericCondition } from './generic-condition.mjs';
import { buildHarnessCondition } from './harness-condition.mjs';
import { engineerContract, buildGuidance } from '../../lib/scenario.mjs';
import { prepareHarnessBundle, bundleMount } from './provision.mjs';

export const AGENT_REF = 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent';

// harbor resolves --agent with plain importlib: the repo root must be on
// PYTHONPATH for evals.external.terminal_bench.harbor_agent to import.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const harborSpawnEnv = () => ({
  ...process.env,
  PYTHONPATH: process.env.PYTHONPATH ? `${repoRoot}${path.delimiter}${process.env.PYTHONPATH}` : repoRoot,
});

// Harbor delivers the real instruction to the agent at runtime; the condition
// object still requires one for prompt assembly parity checks.
const INSTRUCTION_PLACEHOLDER = '(the task instruction is supplied by Harbor at runtime)';

/**
 * Collapse one condition's seed documents into a single schema-valid document:
 * majority verdict over ALL attempted seeds (a null-reward seed can never
 * count toward a pass), median reward over valid seeds, median per numeric
 * efficiency field. Budget charging is untouched — every seed trial charges
 * as it runs; the aggregate represents a typical trial, not the sum.
 */
export function aggregateSeedDocs(docs) {
  if (docs.length === 1) return docs[0];
  const median = (values) => {
    const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  };
  const valid = docs.filter((d) => d.correctness?.verifierReward != null);
  const passes = docs.filter((d) => d.correctness?.verdict === 'pass').length;
  const base = structuredClone(valid[0] ?? docs[0]);
  base.correctness.verdict = passes >= Math.ceil(docs.length / 2) ? 'pass' : 'fail';
  base.correctness.verifierReward = median(valid.map((d) => d.correctness.verifierReward));
  base.correctness.exitReason = `seed-aggregate(n=${docs.length})`;
  base.correctness.completedWithinTimeout = docs.every((d) => d.correctness?.completedWithinTimeout !== false);
  base.correctness.completedWithinBudget = docs.every((d) => d.correctness?.completedWithinBudget !== false);
  for (const key of Object.keys(base.efficiency ?? {})) {
    base.efficiency[key] = median(docs.map((d) => d.efficiency?.[key]));
  }
  base.reproducibility.startedAt = docs[0].reproducibility?.startedAt ?? base.reproducibility.startedAt;
  base.reproducibility.endedAt = docs.at(-1).reproducibility?.endedAt ?? base.reproducibility.endedAt;
  return base;
}

/** One trial's eval-run.v1 document, from harbor + verifier + bridge evidence. */
export function buildRunDoc({ condition, task, evidence, done, run, profile, lock, releaseSha, harnessVersion, startedAt, endedAt }) {
  const totals = done?.telemetry?.totals ?? null;
  const lastResponse = (done?.telemetry?.events ?? []).filter((e) => e.type === 'response').at(-1) ?? null;
  const stopReason = done?.stopReason ?? (run.timedOut ? 'timeout' : 'unknown');
  return {
    schema: 'eval-run.v1',
    reproducibility: {
      releaseSha,
      harnessVersion,
      harnessContentHash: null,
      taskId: task,
      taskRevision: lock.datasetRef,
      condition,
      modelRequested: profile.model,
      modelResolved: lastResponse?.model ?? null,
      providerResolved: lastResponse?.provider ?? null,
      host: 'openrouter-kimi',
      reasoningConfig: profile.reasoning,
      runnerVersion: '1',
      sandbox: null,
      startedAt,
      endedAt,
    },
    correctness: {
      verifierReward: evidence.reward,
      verdict: verdictFromReward(evidence.reward, { passingReward: lock.verifier.passingReward }),
      assertionsPassed: evidence.pytest?.passed ?? null,
      assertionsFailed: evidence.pytest?.failed ?? null,
      requiredFilesCreated: null,
      finalDiffHash: evidence.treeHash,
      exitReason: stopReason,
      completedWithinTimeout: !run.timedOut,
      completedWithinBudget: stopReason !== 'budget_exhausted',
    },
    efficiency: {
      wallTimeMs: startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null,
      timeToFirstTerminalActionMs: null,
      timeToFirstEditMs: null,
      timeFromFinalEditToVerificationMs: null,
      modelRequests: totals?.requests ?? null,
      toolCalls: done?.steps ?? null,
      terminalCommands: done?.steps ?? null,
      failedCommands: null,
      testExecutions: null,
      failedTests: null,
      retries: null,
      promptTokens: totals?.promptTokens ?? null,
      cachedPromptTokens: totals?.cachedTokens ?? null,
      reasoningTokens: totals?.reasoningTokens ?? null,
      outputTokens: totals?.outputTokens ?? null,
      providerReportedCostUsd: totals?.providerCostUsd ?? null,
      localCostUsd: totals?.localCostUsd ?? null,
    },
    harnessBehavior: {
      orientInvoked: null,
      planCreatedOrSelected: null,
      gateAttempts: null,
      gateDenials: null,
      outOfScopeMutationAttempts: null,
      dangerousCommandAttempts: null,
      verificationAfterFinalMutation: null,
      prematureFinishAttempts: null,
      completionBlockedForVerification: null,
      reviewPerformed: null,
      policyBypassAttempted: null,
      policyBypassAchieved: null,
    },
    subscription: null,
  };
}

export function buildLiveSteps({
  config,
  lock,
  workDir,
  env = process.env,
  releaseSha = 'workdir',
  harnessVersion = 'unknown',
  spawnImpl,
  now = () => new Date().toISOString(),
  prepareBundle = prepareHarnessBundle,
  seeds = 1,
}) {
  // ?? null: an absent key must NOT fall back to the process environment —
  // the injected env is the whole truth for credential decisions here.
  const host = createKimiHost({ apiKey: env.OPENROUTER_API_KEY ?? null });
  const profile = host.profile;
  const limits = {
    maxSteps: 60,
    timeoutMs: profile.timeoutMs,
    maxOutputTokens: profile.maxTokens,
    trialCeilingUsd: profile.trialCeilingUsd,
  };
  let datasetDir = null;
  let bundle = null;

  function environment() {
    const missing = [];
    const probe = runHarbor({ args: ['--version'], cwd: workDir, spawnImpl, timeoutMs: 60_000, spawnEnv: spawnImpl ? undefined : harborSpawnEnv() });
    if (probe.spawnError || probe.code !== 0) missing.push('harbor CLI');
    missing.push(...host.validateCredentials().missing);
    return { ok: missing.length === 0, missing };
  }

  /** Locate (or download) the pinned dataset and verify EVERY pinned task's bytes BEFORE any paid step. */
  function taskLock() {
    if (!datasetDir) {
      if (env.HARNESS_EVAL_TB_DATASET_DIR) {
        datasetDir = env.HARNESS_EVAL_TB_DATASET_DIR;
      } else {
        const dest = path.join(workDir, 'dataset');
        const download = runHarbor({
          args: ['download', lock.datasetRef, '-o', dest, '--export'],
          cwd: workDir,
          spawnImpl,
          timeoutMs: 10 * 60_000,
          spawnEnv: spawnImpl ? undefined : harborSpawnEnv(),
        });
        if (download.spawnError || download.code !== 0) {
          return { ok: false, reason: `task download failed: ${download.spawnError ?? download.stderr}` };
        }
        datasetDir = path.join(dest, lock.datasetRef.split('@')[0]);
      }
    }
    for (const entry of tasksOf(lock)) {
      const verdict = verifyTaskAgainstLock(path.join(datasetDir, entry.task), lock, entry.task);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
    }
    return { ok: true, reason: '' };
  }

  function runTrial({ condition, budget, label, task }) {
    const conditionPath = path.join(workDir, `${task}-${label}.condition.json`);
    const telemetryFile = path.join(workDir, `${task}-${label}.done.json`);
    const trialCeilingUsd = Math.min(profile.trialCeilingUsd, budget.remainingUsd());
    fs.writeFileSync(
      conditionPath,
      JSON.stringify(
        { ...condition, profileId: profile.id, apiKeyEnv: 'OPENROUTER_API_KEY', limits: { ...condition.limits, trialCeilingUsd } },
        null,
        2
      )
    );
    const jobName = `kimi-${task}-${label}`;
    const jobsDir = path.join(workDir, 'jobs');
    const startedAt = now();
    const run = runHarbor({
      args: buildHarborRunArgs({
        lock,
        task,
        agentRef: AGENT_REF,
        model: profile.model,
        envName: env.HARNESS_EVAL_TB_ENV ?? config.execution?.environment ?? 'docker',
        jobName,
        jobsDir,
        mounts: [bundle.mount],
        agentEnv: {
          HARNESS_EVAL_TB_CONDITION: conditionPath,
          HARNESS_EVAL_TB_TELEMETRY_FILE: telemetryFile,
          OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
        },
      }),
      cwd: workDir,
      spawnImpl,
      timeoutMs: profile.timeoutMs + 10 * 60_000,
      spawnEnv: spawnImpl ? undefined : harborSpawnEnv(),
    });
    const endedAt = now();
    const jobDir = jobDirFor({ jobsDir, jobName });
    const jobDirCreated = fs.existsSync(jobDir);
    const evidence = jobDirCreated
      ? collectVerifierEvidence(jobDir)
      : { reward: null, rewardPath: null, metrics: null, pytest: null, treeHash: null };
    let done = null;
    try {
      done = JSON.parse(fs.readFileSync(telemetryFile, 'utf8'));
    } catch {
      done = null;
    }
    const totals = done?.telemetry?.totals ?? null;
    // Provider-reported spend is the ledger of record; locally calculated
    // cost is the fallback. A missing ledger charges nothing and instead
    // fails the release through the metered-telemetry gate.
    budget.charge(totals?.providerCostUsd ?? totals?.localCostUsd ?? null, `kimi ${label}`);
    const failureKind = classifyFailure({
      run,
      reward: evidence.reward,
      providerFailure: done?.stopReason === 'provider_error',
      jobDirCreated,
      passed: verdictFromReward(evidence.reward, { passingReward: lock.verifier.passingReward }) === 'pass',
    });
    const doc = buildRunDoc({ condition: condition.id, task, evidence, done, run, profile, lock, releaseSha, harnessVersion, startedAt, endedAt });
    return { doc, failureKind };
  }

  function taskPair({ task, budget, attempt, n = seeds }) {
    const seedRuns = [];
    for (let seed = 1; seed <= n; seed += 1) {
      const suffix = n > 1 ? `${attempt}${seed}` : attempt;
      const generic = runTrial({ condition: buildGenericCondition({ instruction: INSTRUCTION_PLACEHOLDER, limits }), budget, label: `generic-${suffix}`, task });
      const harness = runTrial({
        condition: buildHarnessCondition({ instruction: INSTRUCTION_PLACEHOLDER, limits, engineerContract, guidance: buildGuidance() }),
        budget,
        label: `harness-${suffix}`,
        task,
      });
      seedRuns.push({ generic, harness });
    }
    // A pair is invalid only when a majority of its seeds failed to produce a
    // valid trial; otherwise the surviving seeds carry the verdict.
    const kinds = seedRuns.map((r) => r.generic.failureKind ?? r.harness.failureKind);
    const validSeeds = kinds.filter((k) => !k).length;
    let failureKind = null;
    if (validSeeds < Math.ceil(kinds.length / 2)) {
      const counts = {};
      for (const kind of kinds.filter(Boolean)) counts[kind] = (counts[kind] ?? 0) + 1;
      failureKind = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    return {
      host: host.id,
      task,
      seedCount: n,
      generic: aggregateSeedDocs(seedRuns.map((r) => r.generic.doc)),
      harness: aggregateSeedDocs(seedRuns.map((r) => r.harness.doc)),
      failureKind,
    };
  }

  function ensureBundle() {
    // A pre-built bundle (offline releases, tests) short-circuits preparation.
    bundle ??= env.HARNESS_EVAL_TB_BUNDLE_DIR
      ? { bundleDir: env.HARNESS_EVAL_TB_BUNDLE_DIR, mount: bundleMount(env.HARNESS_EVAL_TB_BUNDLE_DIR) }
      : prepareBundle({ bundleDir: path.join(workDir, 'harness-bundle'), spawnImpl });
  }

  return {
    environment,
    taskLock,
    /** One fresh generic+harness pair per pinned task. */
    kimiPair: async (budget) => {
      if (!host.validateCredentials().ok) return null;
      ensureBundle();
      return tasksOf(lock).map((entry) => taskPair({ task: entry.task, budget, attempt: 'a' }));
    },
    /** §9 conditional rerun: ONE complete fresh pair for ONE regressed task (never seed-multiplied). */
    rerunKimiPair: async (budget, task) => {
      if (!host.validateCredentials().ok) return null;
      ensureBundle();
      return taskPair({ task: task ?? tasksOf(lock)[0].task, budget, attempt: 'b', n: 1 });
    },
    frontierPair: null,
    gemmaPair: null,
    smokes: null,
  };
}
