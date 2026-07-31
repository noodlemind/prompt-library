import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  validateAgainstSchema,
  classifyPair,
  allocateReleaseBudgets,
  applyGatePolicy,
  runRelease,
  buildMarkdownReport,
  efficiencyDelta,
  scaleReleaseBudget,
} from '../../../evals/release.mjs';

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const REPORT_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-report.v1.schema.json', import.meta.url), 'utf8'));

const CONFIG = {
  budget: { releaseCeilingUsd: 20, kimiPairUsd: 10, rerunUsd: 8, reserveUsd: 2 },
  task: {
    datasetRef: 'terminal-bench@2.0',
    task: 'multi-task-canary',
    taskSet: [
      { task: 'cobol-modernization', role: 'anchor', taskChecksum: 'a'.repeat(64) },
      { task: 'build-pmars', role: 'candidate', taskChecksum: 'b'.repeat(64) },
    ],
  },
  efficiencyThresholds: { promptRatio: 2, costRatio: 1.5, wallTimeRatio: 1.25 },
};

/** A schema-valid eval-run document; `over` shallow-merges per section. */
function fullRun(condition, verdict, over = {}) {
  const doc = {
    schema: 'eval-run.v1',
    reproducibility: {
      releaseSha: 'abc123',
      harnessVersion: '0.5.0',
      harnessContentHash: null,
      taskId: 'cobol-modernization',
      taskRevision: 'terminal-bench@2.0',
      condition,
      modelRequested: 'moonshotai/kimi-k2.7-code',
      modelResolved: 'moonshotai/kimi-k2.7-code',
      providerResolved: 'Moonshot AI',
      providerRequestedOrder: ['moonshotai'],
      attribution: { responseCount: 5, complete: true, fallbackDetected: false },
      host: 'openrouter-kimi',
      reasoningConfig: null,
      runnerVersion: '1',
      sandbox: null,
      startedAt: '2026-07-30T00:00:00Z',
      endedAt: '2026-07-30T00:10:00Z',
      pairId: 'pair-1',
      repetitionId: 'repetition-1',
      repetitionIndex: 1,
      orderIndex: condition === 'generic' ? 1 : 2,
      attempt: 'a',
      aggregation: null,
      taskHash: '1'.repeat(64),
      conditionHash: '2'.repeat(64),
      systemPromptHash: '3'.repeat(64),
      toolSchemaHash: '4'.repeat(64),
      telemetryHash: '5'.repeat(64),
      harnessEventsHash: '6'.repeat(64),
    },
    correctness: {
      verifierReward: verdict === 'pass' ? 1 : 0,
      verdict,
      assertionsPassed: null,
      assertionsFailed: null,
      requiredFilesCreated: null,
      finalDiffHash: null,
      verifierArtifactHash: null,
      exitReason: 'model_finish',
      completedWithinTimeout: true,
      completedWithinBudget: true,
    },
    efficiency: {
      wallTimeMs: 60000,
      modelRequests: 5,
      providerAttempts: 5,
      providerResponses: 5,
      providerErrors: 0,
      openProviderAttempts: 0,
      retries: 0,
      unknownBillingAttempts: 0,
      toolCalls: 9,
      terminalCommands: 7,
      failedCommands: 1,
      contextCompactions: 0,
      compactedToolResults: 0,
      requestPayloadChars: 4000,
      peakRequestPayloadChars: 1000,
      promptTokens: 1000,
      cachedPromptTokens: 200,
      reasoningTokens: 0,
      outputTokens: 400,
      providerReportedCostUsd: 0.02,
      localCostUsd: 0.02,
      usageComplete: true,
      providerCostComplete: true,
      billingComplete: true,
      costComplete: true,
      missingUsage: 0,
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
      policyBypassAchieved: false,
    },
    enforcementFidelity: {
      mode: condition === 'harness' ? 'prompt-and-cli' : 'none',
      promptContractActive: condition === 'harness',
      cliActivated: condition === 'harness',
      mechanicalHooksActive: false,
      harnessEventsCaptured: true,
      evidenceSource: condition === 'harness' ? 'condition-and-setup' : 'control-condition',
    },
    workspaceEvidence: {
      available: true,
      collectionMode: 'bounded-content-hash-manifest-v1',
      beforeManifestHash: 'a'.repeat(64),
      afterManifestHash: 'b'.repeat(64),
      diffHash: 'c'.repeat(64),
      changedPaths: ['src/result.txt'],
      changedPathCount: 1,
      changedPathsTruncated: false,
      reason: null,
    },
    observability: {
      providerEvents: Array.from({ length: 5 }, (_, index) => [
        { type: 'request', requestId: `request-${index + 1}` },
        { type: 'request_attempt', requestId: `request-${index + 1}`, attemptId: `attempt-${index + 1}` },
        {
          type: 'response',
          requestId: `request-${index + 1}`,
          attemptId: `attempt-${index + 1}`,
          model: 'moonshotai/kimi-k2.7-code',
          provider: 'Moonshot AI',
        },
      ]).flat(),
      toolEvents: [],
      harnessEvents: [],
      harnessEventEvidence: {
        available: true,
        complete: true,
        reason: null,
        retainedEvents: 0,
        sourceTruncated: false,
        projectionRejectedEvents: 0,
        projectionRejectedChecks: 0,
      },
      providerAttemptsStarted: 5,
      providerAttemptsClosed: 5,
      unclosedProviderAttempts: 0,
      correlatedToolResults: 9,
      uncorrelatedToolResults: 0,
      eventEvidenceHash: 'd'.repeat(64),
    },
    repetitions: [],
    subscription: null,
  };
  for (const [section, value] of Object.entries(over)) {
    doc[section] = { ...doc[section], ...value };
  }
  return doc;
}

function pairOf(host, genericVerdict, harnessVerdict, over = {}) {
  return {
    host,
    generic: fullRun('generic', genericVerdict, over.generic ?? {}),
    harness: fullRun('harness', harnessVerdict, over.harness ?? {}),
    failureKind: over.failureKind ?? null,
  };
}

function repeatedRun(condition, verdict, count = 3) {
  const repetitions = Array.from({ length: count }, (_, index) => {
    const run = fullRun(condition, verdict);
    run.reproducibility.repetitionId = `repetition-${index + 1}`;
    run.reproducibility.repetitionIndex = index + 1;
    return run;
  });
  const aggregate = structuredClone(repetitions[0]);
  aggregate.reproducibility.repetitionId = null;
  aggregate.reproducibility.repetitionIndex = null;
  aggregate.reproducibility.orderIndex = null;
  aggregate.reproducibility.aggregation = 'majority-verdict-median-efficiency';
  aggregate.correctness.finalDiffHash = null;
  aggregate.correctness.verifierArtifactHash = null;
  aggregate.workspaceEvidence = {
    available: false,
    collectionMode: 'per-repetition',
    beforeManifestHash: null,
    afterManifestHash: null,
    diffHash: null,
    changedPaths: ['src/result.txt'],
    changedPathCount: count,
    changedPathsTruncated: false,
    reason: 'workspace-evidence-retained-per-repetition',
  };
  aggregate.observability = {
    ...aggregate.observability,
    providerEvents: repetitions.flatMap((run) => run.observability.providerEvents),
    providerAttemptsStarted: count * 5,
    providerAttemptsClosed: count * 5,
    correlatedToolResults: count * 9,
  };
  aggregate.repetitions = repetitions;
  return aggregate;
}

function baseSteps(overrides = {}) {
  return {
    deterministic: async () => ({ passed: 17, failed: 0, skipped: 2 }),
    environment: async () => ({
      ok: true,
      missing: [],
      providerSpendGuard: {
        verified: true,
        required: true,
        limitUsd: 20,
        limitRemainingUsd: 20,
        reset: null,
        ceilingUsd: 20,
        checkedAt: '2026-07-31T00:00:00.000Z',
      },
    }),
    taskLock: async () => ({ ok: true, reason: '' }),
    nativeProducts: async () => [{ host: 'codex-subscription', status: 'pass', telemetryAvailable: false }],
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass'),
    gemmaPair: async () => pairOf('ollama-gemma', 'fail', 'fail'),
    smokes: async () => [{ host: 'copilot-smoke', ok: true, failed: [] }],
    ...overrides,
  };
}

test('validateAgainstSchema checks required keys, types, nullability, const, and enum with paths', () => {
  const good = fullRun('generic', 'pass');
  assert.deepEqual(validateAgainstSchema(good, RUN_SCHEMA).errors, []);
  const bad = fullRun('generic', 'pass');
  delete bad.efficiency.promptTokens;
  bad.correctness.verdict = 'maybe';
  bad.reproducibility.releaseSha = null;
  const verdict = validateAgainstSchema(bad, RUN_SCHEMA);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('efficiency.promptTokens')));
  assert.ok(verdict.errors.some((e) => e.includes('correctness.verdict')));
  assert.ok(verdict.errors.some((e) => e.includes('reproducibility.releaseSha')));
});

test('classifyPair implements the §8 matrix', () => {
  assert.equal(classifyPair(pairOf('h', 'fail', 'pass')).result, 'harness-win');
  assert.equal(classifyPair(pairOf('h', 'pass', 'pass')).result, 'parity');
  assert.equal(classifyPair(pairOf('h', 'pass', 'fail')).result, 'harness-regression');
  assert.equal(classifyPair(pairOf('h', 'fail', 'fail')).result, 'inconclusive-capability');
});

test('classifyPair precedence: safety bypass, then infrastructure, then budget', () => {
  const safety = classifyPair(pairOf('h', 'pass', 'pass', { harness: { harnessBehavior: { policyBypassAchieved: true } } }));
  assert.equal(safety.result, 'harness-regression');
  assert.equal(safety.safety, true);
  const infra = classifyPair(pairOf('h', 'pass', 'pass', { failureKind: 'infrastructure' }));
  assert.equal(infra.result, 'infrastructure-invalid');
  const budget = classifyPair(pairOf('h', 'pass', 'fail', { harness: { correctness: { completedWithinBudget: false } } }));
  assert.equal(budget.result, 'inconclusive-budget');
  assert.equal(classifyPair(pairOf('h', 'pass', 'fail', { failureKind: 'budget' })).result, 'inconclusive-budget');
});

test('a model or provider fallback is detected from the run documents', () => {
  const fallback = classifyPair(
    pairOf('h', 'pass', 'pass', { harness: { reproducibility: { modelResolved: 'moonshotai/kimi-k2-instruct' } } })
  );
  assert.equal(fallback.fallbackDetected, true);
  assert.equal(fallback.result, 'infrastructure-invalid');
});

test('fallback contamination in an earlier response or raw repetition invalidates the causal comparison', async () => {
  const repeated = {
    host: 'openrouter-kimi',
    repetitionCount: 3,
    generic: repeatedRun('generic', 'pass'),
    harness: repeatedRun('harness', 'pass'),
    failureKind: null,
  };
  const firstResponse = repeated.harness.repetitions[0].observability.providerEvents.find((event) => event.type === 'response');
  firstResponse.provider = 'DeepInfra';
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ kimiPair: async () => repeated }),
    requiredPairs: ['openrouter-kimi'],
  });
  const pair = report.pairs.find((entry) => entry.host === 'openrouter-kimi');
  assert.equal(pair.result, 'infrastructure-invalid');
  assert.equal(pair.causallyAttributable, false);
  assert.equal(report.claim.level, 'inconclusive');
  assert.equal(exitCode, 1);
});

test('paid required trials require resolved model and provider on every response and the pinned provider order', async () => {
  for (const mutate of [
    (doc) => { doc.reproducibility.modelResolved = null; },
    (doc) => { doc.observability.providerEvents.find((event) => event.type === 'response').provider = null; },
    (doc) => { doc.observability.providerEvents.find((event) => event.type === 'response').provider = 'DeepInfra'; },
  ]) {
    const pair = pairOf('openrouter-kimi', 'pass', 'pass');
    mutate(pair.harness);
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({ kimiPair: async () => pair }),
      requiredPairs: ['openrouter-kimi'],
    });
    assert.equal(exitCode, 1);
    assert.equal(report.claim.level, 'inconclusive');
    assert.equal(report.pairs.find((entry) => entry.host === 'openrouter-kimi').causallyAttributable, false);
  }
});

test('allocateReleaseBudgets chains the plan allowances under the release ceiling', () => {
  const budgets = allocateReleaseBudgets(CONFIG.budget);
  assert.equal(budgets.release.ceilingUsd, 20);
  assert.equal(budgets.kimiPair.ceilingUsd, 10);
  assert.equal(budgets.rerun.ceilingUsd, 8);
  budgets.kimiPair.charge(3, 'pair');
  assert.equal(budgets.release.spentUsd(), 3);
});

test('the local release orchestrator can never be configured above the absolute 20 USD cap', () => {
  assert.throws(() => allocateReleaseBudgets({ ...CONFIG.budget, releaseCeilingUsd: 20.01 }), /20/);
  assert.equal(allocateReleaseBudgets({ ...CONFIG.budget, releaseCeilingUsd: 10 }).release.ceilingUsd, 10);
});

test('raising the release ceiling scales the controlled pair and rerun allowances instead of creating unusable headroom', () => {
  const base = { releaseCeilingUsd: 10, kimiPairUsd: 8, rerunUsd: 2, reserveUsd: 2 };
  assert.deepEqual(scaleReleaseBudget(base, 10), base);
  assert.deepEqual(scaleReleaseBudget(base, 20), { releaseCeilingUsd: 20, kimiPairUsd: 16, rerunUsd: 4, reserveUsd: 4 });
  assert.throws(() => scaleReleaseBudget(base, 20.01), /20/);
});

test('efficiency deltas use like-for-like evidence and the configured parity thresholds', () => {
  const generic = fullRun('generic', 'pass');
  const harness = fullRun('harness', 'pass', {
    efficiency: { promptTokens: 2000, providerReportedCostUsd: 0.03, localCostUsd: 0.03, wallTimeMs: 75000, providerAttempts: 7 },
  });
  const delta = efficiencyDelta(generic, harness, CONFIG.efficiencyThresholds);
  assert.deepEqual(
    { prompt: delta.promptRatio, cost: delta.costRatio, wall: delta.wallTimeRatio, attempts: delta.providerAttemptRatio },
    { prompt: 2, cost: 1.5, wall: 1.25, attempts: 1.4 }
  );
  assert.equal(delta.withinThresholds, true, 'threshold boundaries are inclusive');
  assert.deepEqual(delta.breaches, []);
});

test('the reserve is unusable without a recorded reason', () => {
  const budgets = allocateReleaseBudgets(CONFIG.budget);
  assert.throws(() => budgets.reserve.use(), /reason/);
  const extra = budgets.reserve.use({ reason: 'billable retry audit' });
  assert.equal(extra.ceilingUsd, 2);
  assert.equal(budgets.reserveUsedReason(), 'billable retry audit');
  extra.charge(1, 'audit');
  assert.equal(budgets.release.spentUsd(), 1);
});

test('gate policy blocks on deterministic regressions, safety, telemetry, and pinning', () => {
  const base = { deterministic: { passed: 17, failed: 0, skipped: 2 }, pairs: [], telemetryComplete: true, taskLockOk: true, environmentOk: true, calibrationRelease: false };
  assert.equal(applyGatePolicy(base).block, false);
  assert.equal(applyGatePolicy({ ...base, deterministic: { passed: 16, failed: 1, skipped: 2 } }).block, true);
  assert.equal(applyGatePolicy({ ...base, telemetryComplete: false }).block, true);
  assert.equal(applyGatePolicy({ ...base, taskLockOk: false }).block, true);
  const safetyPair = { host: 'openrouter-kimi', gateActive: false, classification: { result: 'harness-regression', safety: true, fallbackDetected: false }, reproduced: null };
  assert.equal(applyGatePolicy({ ...base, calibrationRelease: true, pairs: [safetyPair] }).block, true, 'safety blocks even in calibration on an inactive gate');
});

test('gate policy blocks a reproduced regression and a fallback only on active gates', () => {
  const base = { deterministic: { passed: 1, failed: 0, skipped: 0 }, telemetryComplete: true, taskLockOk: true, environmentOk: true, calibrationRelease: false };
  const regression = { host: 'openrouter-kimi', gateActive: true, classification: { result: 'harness-regression', safety: false, fallbackDetected: false }, reproduced: true };
  assert.equal(applyGatePolicy({ ...base, pairs: [regression] }).block, true);
  const inactive = { ...regression, gateActive: false };
  assert.equal(applyGatePolicy({ ...base, pairs: [inactive] }).block, false);
  const fallback = { host: 'openrouter-kimi', gateActive: true, classification: { result: 'parity', safety: false, fallbackDetected: true }, reproduced: null };
  assert.equal(applyGatePolicy({ ...base, pairs: [fallback] }).block, true);
  assert.equal(applyGatePolicy({ ...base, pairs: [{ ...fallback, gateActive: false }] }).block, false);
});

test('an all-green release produces a schema-valid report and exit code 0', async () => {
  const { report, exitCode } = await runRelease({ config: CONFIG, steps: baseSteps(), releaseSha: 'abc123', harnessVersion: '0.5.0' });
  assert.equal(exitCode, 0);
  assert.deepEqual(validateAgainstSchema(report, REPORT_SCHEMA).errors, []);
  const kimi = report.pairs.find((p) => p.host === 'openrouter-kimi');
  assert.equal(kimi.result, 'parity');
  assert.equal(kimi.comparisonTrack, 'controlled-ablation');
  assert.equal(report.claim.level, 'bounded-overhead');
  assert.deepEqual(report.claim.treatmentFidelityModes, ['prompt-and-cli']);
  assert.equal(report.nativeProducts.length, 1);
  assert.ok(!('generic' in report.nativeProducts[0]) && !('harness' in report.nativeProducts[0]));
  assert.equal(report.gate.block, false);
  assert.equal(report.budget.scope, 'provider-api-only');
  assert.equal(report.budget.providerSpendGuard.verified, true);
  assert.equal(report.budget.enforcementSemantics, 'provider-key-hard-limit-plus-conservative-scheduler');
});

test('the report distinguishes a provider-enforced cash limit from a scheduler-only ceiling', async () => {
  const { report } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ environment: async () => ({ ok: true, missing: [] }) }),
  });
  assert.equal(report.budget.providerSpendGuard.verified, false);
  assert.equal(report.budget.enforcementSemantics, 'scheduler-fail-stop-not-atomic-cash-guarantee');
  assert.ok(report.limitations.some((limitation) => /atomic request|provider.*limit/i.test(limitation)));
});

test('a required OpenRouter pair is withheld unless the provider key hard limit exactly matches the release ceiling', async () => {
  for (const providerSpendGuard of [
    undefined,
    { verified: true, limitUsd: 10, limitRemainingUsd: 20, reset: null },
    { verified: true, limitUsd: 20, limitRemainingUsd: 21, reset: null },
  ]) {
    let kimiCalled = false;
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({
        environment: async () => ({ ok: true, missing: [], ...(providerSpendGuard ? { providerSpendGuard } : {}) }),
        kimiPair: async () => {
          kimiCalled = true;
          return pairOf('openrouter-kimi', 'pass', 'pass');
        },
      }),
      requiredPairs: ['openrouter-kimi'],
    });
    assert.equal(kimiCalled, false);
    assert.equal(report.budget.providerSpendGuard.verified, false);
    assert.equal(exitCode, 1);
    assert.ok(report.gate.reasons.some((reason) => /dependencies|credentials|openrouter-kimi/i.test(reason)));
  }
});

test('required multi-repetition evidence is validated per retained trial instead of comparing medians to summed events', async () => {
  const repeatedPair = {
    host: 'openrouter-kimi',
    repetitionCount: 3,
    generic: repeatedRun('generic', 'pass'),
    harness: repeatedRun('harness', 'pass'),
    failureKind: null,
  };
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ kimiPair: async () => repeatedPair }),
    requiredPairs: ['openrouter-kimi'],
  });
  assert.equal(exitCode, 0, report.gate.reasons.join('; '));
  assert.equal(report.pairs.find((pair) => pair.host === 'openrouter-kimi').repetitionCount, 3);
  assert.equal(report.claim.level, 'bounded-overhead');
});

test('active success parity above an efficiency threshold blocks the release claim', async () => {
  const expensive = pairOf('openrouter-kimi', 'pass', 'pass', {
    harness: { efficiency: { promptTokens: 2001 } },
  });
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ kimiPair: async () => expensive }),
    requiredPairs: ['openrouter-kimi'],
  });
  const kimi = report.pairs.find((pair) => pair.host === 'openrouter-kimi');
  assert.equal(kimi.efficiencyDelta.withinThresholds, false);
  assert.ok(kimi.efficiencyDelta.breaches.includes('promptRatio'));
  assert.equal(report.claim.level, 'regression');
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /prompt.*ratio|efficiency/i.test(reason)));
});

test('an actual provider reconciliation above the absolute ceiling is retained and blocks', async () => {
  const steps = baseSteps({
    kimiPair: async (budget) => {
      budget.charge(21, 'unexpected provider reconciliation');
      return pairOf('openrouter-kimi', 'pass', 'pass');
    },
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  assert.equal(report.budget.spentUsd, 21);
  assert.equal(report.budget.breached, true);
  assert.equal(report.budget.overrunUsd, 1);
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /budget.*exceeded/i.test(reason)));
});

test('a harness win produces a demonstrated-value claim without using native references as causal evidence', async () => {
  const { report } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ kimiPair: async () => pairOf('openrouter-kimi', 'fail', 'pass') }),
  });
  assert.equal(report.claim.level, 'demonstrated-value');
  assert.equal(report.claim.controlledWins, 1);
  assert.equal(report.nativeProducts[0].host, 'codex-subscription');
});

test('a deterministic regression blocks before any paid step runs', async () => {
  let kimiCalled = false;
  const steps = baseSteps({
    deterministic: async () => ({ passed: 15, failed: 2, skipped: 2 }),
    kimiPair: async () => {
      kimiCalled = true;
      return pairOf('openrouter-kimi', 'pass', 'pass');
    },
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(exitCode, 1);
  assert.equal(kimiCalled, false, 'no provider spend after a deterministic failure');
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-kimi').result, 'skipped');
});

test('a kimi baseline-pass/harness-fail reruns one full fresh pair and blocks when it reproduces', async () => {
  let rerunCalls = 0;
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail'),
    rerunKimiPair: async () => {
      rerunCalls += 1;
      return pairOf('openrouter-kimi', 'pass', 'fail');
    },
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(rerunCalls, 1, 'exactly one full-pair rerun, never treatment-only');
  const kimi = report.pairs.find((p) => p.host === 'openrouter-kimi');
  assert.equal(kimi.result, 'harness-regression');
  assert.equal(kimi.reproduced, true);
  assert.equal(kimi.rerun.result, 'harness-regression');
  assert.equal(kimi.rerun.causallyAttributable, true);
  assert.equal(kimi.rerun.generic.correctness.verdict, 'pass');
  assert.equal(kimi.rerun.harness.correctness.verdict, 'fail');
  assert.equal(exitCode, 1);
});

test('an unreproduced kimi regression is flaky-inconclusive and does not block', async () => {
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail'),
    rerunKimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass'),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  const kimi = report.pairs.find((p) => p.host === 'openrouter-kimi');
  assert.equal(kimi.result, 'flaky-inconclusive');
  assert.equal(kimi.reproduced, false);
  assert.equal(kimi.rerun.result, 'parity');
  assert.equal(kimi.rerun.causallyAttributable, true);
  assert.equal(exitCode, 0);
});

test('an invalid, incomplete, fallback-contaminated, or policy-regressing rerun cannot clear the original regression', async () => {
  const invalidReruns = [
    () => pairOf('openrouter-kimi', 'pass', 'pass', { failureKind: 'provider' }),
    () => {
      const pair = pairOf('openrouter-kimi', 'pass', 'pass');
      pair.harness.efficiency.costComplete = false;
      return pair;
    },
    () => {
      const pair = pairOf('openrouter-kimi', 'pass', 'pass');
      pair.harness.observability.providerEvents.find((event) => event.type === 'response').provider = 'DeepInfra';
      return pair;
    },
    () => pairOf('openrouter-kimi', 'pass', 'pass', { harness: { efficiency: { promptTokens: 2001 } } }),
  ];
  for (const rerun of invalidReruns) {
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({
        kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail'),
        rerunKimiPair: async () => rerun(),
      }),
    });
    const pair = report.pairs.find((entry) => entry.host === 'openrouter-kimi');
    assert.equal(pair.result, 'harness-regression');
    assert.equal(pair.reproduced, null);
    assert.ok(pair.rerun?.generic && pair.rerun?.harness, 'invalid rerun evidence remains available for audit');
    assert.match(pair.reason, /invalid|unresolved|attribut/i);
    assert.equal(exitCode, 1);
  }
});

test('during calibration a reproduced kimi regression is informational, not blocking', async () => {
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail'),
    rerunKimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail'),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, calibrationRelease: true });
  assert.equal(exitCode, 0);
  assert.equal(report.calibrationRelease, true);
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-kimi').gateActive, false);
});

test('a budget-exhausted treatment is inconclusive and never blocks', async () => {
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail', { harness: { correctness: { completedWithinBudget: false, exitReason: 'budget_exhausted' } } }),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-kimi').result, 'inconclusive-budget');
  assert.equal(exitCode, 0);
});

test('a gemma failure stays informational', async () => {
  const { report, exitCode } = await runRelease({ config: CONFIG, steps: baseSteps() });
  const gemma = report.pairs.find((p) => p.host === 'ollama-gemma');
  assert.equal(gemma.result, 'inconclusive-capability');
  assert.equal(gemma.gateActive, false);
  assert.equal(exitCode, 0);
});

test('a run document missing required telemetry blocks the release', async () => {
  const broken = pairOf('openrouter-kimi', 'pass', 'pass');
  delete broken.harness.efficiency;
  const steps = baseSteps({ kimiPair: async () => broken });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /telemetry/i.test(r)));
});

test('a malformed verdict never crashes classification; the schema gate blocks it instead', async () => {
  const broken = pairOf('openrouter-kimi', 'pass', 'pass');
  broken.harness.correctness.verdict = 'error';
  const steps = baseSteps({ kimiPair: async () => broken });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /telemetry/i.test(r)));
});

test('the schema validator rejects counters below their declared minimum', () => {
  const run = fullRun('harness', 'pass');
  run.observability.harnessEventEvidence.projectionRejectedChecks = -1;

  const verdict = validateAgainstSchema(run, RUN_SCHEMA);

  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((error) => /projectionRejectedChecks.*minimum 0/i.test(error)));
});

test('only the controlled kimi pair draws from the kimi allowance; native products remain a separate reference track', async () => {
  const seen = {};
  const steps = baseSteps({
    nativeProducts: async (budget) => {
      seen.nativeBudget = budget;
      return [{ host: 'codex-subscription', status: 'pass', telemetryAvailable: false }];
    },
    kimiPair: async (budget) => {
      seen.kimi = budget?.label;
      return pairOf('openrouter-kimi', 'pass', 'pass');
    },
    gemmaPair: async (budget) => {
      seen.gemma = budget?.label;
      return pairOf('ollama-gemma', 'pass', 'pass');
    },
  });
  await runRelease({ config: CONFIG, steps });
  assert.equal(seen.kimi, 'kimi-pair');
  assert.equal(seen.nativeBudget, undefined, 'subscription references do not consume or masquerade as API-pair budgets');
  assert.equal(seen.gemma, 'release');
});

test('a rerun that cannot run leaves the regression unresolved, never flaky', async () => {
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail'),
    rerunKimiPair: async () => null,
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  const kimi = report.pairs.find((p) => p.host === 'openrouter-kimi');
  assert.equal(kimi.result, 'harness-regression');
  assert.equal(kimi.reproduced, null);
  assert.match(kimi.reason, /rerun|unresolved/i);
  assert.equal(exitCode, 1, 'an unresolved original regression remains release-blocking');
});

test('provider and verifier failures are infrastructure-invalid, not model capability results', () => {
  const provider = classifyPair(pairOf('h', 'fail', 'fail', { failureKind: 'provider' }));
  assert.equal(provider.result, 'infrastructure-invalid');
  assert.match(provider.reason, /provider/);
  const verifier = classifyPair(pairOf('h', 'fail', 'fail', { failureKind: 'verifier' }));
  assert.equal(verifier.result, 'infrastructure-invalid');
  assert.match(verifier.reason, /verifier/);
});

test('an enabled required pair that is skipped cannot produce a green release', async () => {
  const steps = baseSteps({ kimiPair: async () => null });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /openrouter-kimi.*(skipped|did not run)/i.test(r)));
});

test('a non-skipped required pair missing either arm cannot produce a green release', async () => {
  for (const missing of ['generic', 'harness']) {
    const incomplete = pairOf('openrouter-kimi', 'pass', 'pass');
    incomplete[missing] = null;
    const steps = baseSteps({ kimiPair: async () => incomplete });
    const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
    assert.equal(exitCode, 1, `${missing} arm was absent`);
    assert.ok(report.gate.reasons.some((r) => /telemetry/i.test(r)));
  }
});

test('an active pair with an infrastructure-invalid result blocks the release', async () => {
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass', { failureKind: 'infrastructure' }),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /openrouter-kimi.*(no valid signal|infrastructure)/i.test(r)));
});

test('a failed compatibility smoke blocks the release', async () => {
  const steps = baseSteps({ smokes: async () => [{ host: 'copilot-smoke', ok: false, failed: ['discovery'] }] });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /copilot-smoke/.test(r)));
});

test('an API pair whose telemetry is entirely null is not complete evidence', async () => {
  const nullEfficiency = {
    wallTimeMs: null,
    modelRequests: null,
    toolCalls: null,
    terminalCommands: null,
    failedCommands: null,
    promptTokens: null,
    cachedPromptTokens: null,
    reasoningTokens: null,
    outputTokens: null,
    providerReportedCostUsd: null,
    localCostUsd: null,
    costComplete: null,
    missingUsage: null,
  };
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass', { harness: { efficiency: nullEfficiency } }),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /telemetry/i.test(r)));
});

test('a required API pair with incomplete paid usage cannot produce a green release', async () => {
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass', { harness: { efficiency: { costComplete: false, missingUsage: 1 } } }),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /telemetry/i.test(r)));
});

test('a required pair without a closed attempt ledger or real workspace manifest cannot produce a green release', async () => {
  for (const harnessOverride of [
    { workspaceEvidence: { available: false, beforeManifestHash: null, afterManifestHash: null, diffHash: null } },
    { observability: { providerAttemptsClosed: 4, unclosedProviderAttempts: 1 } },
    { observability: { uncorrelatedToolResults: 1 } },
  ]) {
    const steps = baseSteps({
      kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass', { harness: harnessOverride }),
    });
    const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
    assert.equal(exitCode, 1);
    assert.ok(report.gate.reasons.some((reason) => /telemetry/i.test(reason)));
  }
});

test('incomplete harness-event projection prevents a required causal claim', async () => {
  const pair = pairOf('openrouter-kimi', 'pass', 'pass', {
    harness: {
      observability: {
        harnessEventEvidence: {
          available: true,
          complete: false,
          reason: 'projection-rejected',
          retainedEvents: 0,
          sourceTruncated: false,
          projectionRejectedEvents: 1,
          projectionRejectedChecks: 0,
        },
      },
    },
  });
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ kimiPair: async () => pair }),
    requiredPairs: ['openrouter-kimi'],
  });
  assert.equal(exitCode, 1);
  assert.equal(report.claim.level, 'inconclusive');
});

test('a multi-task pair step yields one report entry per task, each classified independently', async () => {
  const steps = baseSteps({
    kimiPair: async () => [
      { ...pairOf('openrouter-kimi', 'pass', 'pass'), task: 'cobol-modernization' },
      { ...pairOf('openrouter-kimi', 'fail', 'pass'), task: 'build-pmars' },
    ],
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  const kimi = report.pairs.filter((p) => p.host === 'openrouter-kimi');
  assert.equal(kimi.length, 2);
  assert.equal(kimi.find((p) => p.task === 'cobol-modernization').result, 'parity');
  assert.equal(kimi.find((p) => p.task === 'build-pmars').result, 'harness-win');
  assert.equal(exitCode, 0);
});

test('a regression on one task reruns and gates ONLY that task', async () => {
  let rerunTasks = [];
  const steps = baseSteps({
    kimiPair: async () => [
      { ...pairOf('openrouter-kimi', 'pass', 'pass'), task: 'cobol-modernization' },
      { ...pairOf('openrouter-kimi', 'pass', 'fail'), task: 'build-pmars' },
    ],
    rerunKimiPair: async (budget, task) => {
      rerunTasks.push(task);
      return { ...pairOf('openrouter-kimi', 'pass', 'fail'), task };
    },
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  assert.deepEqual(rerunTasks, ['build-pmars'], 'only the regressed task is rerun');
  const regressed = report.pairs.find((p) => p.task === 'build-pmars');
  assert.equal(regressed.result, 'harness-regression');
  assert.equal(regressed.reproduced, true);
  assert.equal(report.pairs.find((p) => p.task === 'cobol-modernization').result, 'parity');
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /build-pmars/.test(r)), 'the gate reason names the task');
});

test('the markdown eval card names the full task set, verdicts, spend, claim, and comparison limitations', async () => {
  const { report } = await runRelease({ config: CONFIG, steps: baseSteps(), releaseSha: 'abc123', harnessVersion: '0.5.0' });
  const md = buildMarkdownReport(report);
  assert.match(md, /cobol-modernization/);
  assert.match(md, /build-pmars/);
  assert.match(md, /openrouter-kimi/);
  assert.match(md, /parity/);
  assert.match(md, /\$/);
  assert.match(md, /bounded-overhead/i);
  assert.match(md, /native.*separate|not causal/i);
  assert.doesNotMatch(md, /single pinned task/i);
});
