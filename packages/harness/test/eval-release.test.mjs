import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  validateAgainstSchema,
  classifyPair,
  allocateReleaseBudgets,
  applyGatePolicy,
  runRelease,
  buildMarkdownReport,
  efficiencyDelta,
  overheadAttribution,
  releaseTrustVerdict,
  calibrationBaselineVerdict,
  validateReleasePolicyConfig,
  releaseInvocationPolicy,
  releaseMinimumCalibrationRepetitions,
  releaseRepetitionCount,
  scaleReleaseBudget,
  makeReleaseTreeRemovable,
  reservePrivateReport,
  writeReservedPrivateReport,
  closePrivateReportReservation,
  shouldRetainReleaseWorkDir,
  writePrivateReport,
} from '../../../evals/release.mjs';
import { billingProfileHash } from '../../../evals/lib/model-profiles.mjs';

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const REPORT_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-report.v2.schema.json', import.meta.url), 'utf8'));
const YAML = createRequire(import.meta.url)('yaml');

test('release cleanup never chmods an outside inode through an untrusted hard link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cleanup-hardlink-'));
  const outside = path.join(os.tmpdir(), `eval-cleanup-outside-${process.pid}-${Date.now()}`);
  fs.writeFileSync(outside, 'outside bytes', { mode: 0o444 });
  fs.linkSync(outside, path.join(root, 'untrusted-hardlink'));
  makeReleaseTreeRemovable(root);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o444);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside bytes');
  fs.unlinkSync(path.join(root, 'untrusted-hardlink'));
  fs.rmdirSync(root);
  fs.unlinkSync(outside);
});

test('sanitized reports can be retained only in a new private file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-private-report-'));
  const destination = path.join(root, 'report.json');
  writePrivateReport(destination, { schema: 'fixture', value: 1 });
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), { schema: 'fixture', value: 1 });
  assert.throws(() => writePrivateReport(destination, { value: 2 }), /new protected file/i);
});

test('private report cleanup removes partial output without masking a close failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-private-report-partial-'));
  const destination = path.join(root, 'report.json');
  const reservation = reservePrivateReport(destination);
  fs.writeSync(reservation.handle, '{');
  reservation.writeAttempted = true;

  // Simulate a descriptor already closed by a failing archival path. Cleanup
  // must still remove the invalid JSON and must not throw over the root cause.
  fs.closeSync(reservation.handle);
  assert.doesNotThrow(() => closePrivateReportReservation(reservation, { removeIncomplete: true }));
  assert.equal(reservation.closed, true);
  assert.equal(reservation.closeError?.code, 'EBADF');
  assert.equal(fs.existsSync(destination), false);
  fs.rmdirSync(root);
});

test('private report reservation rejects a group- or world-writable parent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-private-report-parent-'));
  fs.chmodSync(root, 0o777);
  assert.throws(
    () => reservePrivateReport(path.join(root, 'report.json')),
    /parent must not be writable by group or other users/i
  );
  fs.chmodSync(root, 0o700);
  fs.rmdirSync(root);
});

test('private report writer detects pathname replacement and never unlinks the replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-private-report-replaced-'));
  const destination = path.join(root, 'report.json');
  const displaced = path.join(root, 'displaced.json');
  const reservation = reservePrivateReport(destination);
  fs.renameSync(destination, displaced);
  fs.writeFileSync(destination, '{"forged":true}\n', { mode: 0o600 });

  assert.throws(
    () => writeReservedPrivateReport(reservation, { genuine: true }),
    /no longer bound to its reserved inode/i
  );
  closePrivateReportReservation(reservation, { removeIncomplete: true });
  assert.equal(fs.readFileSync(destination, 'utf8'), '{"forged":true}\n');

  fs.unlinkSync(destination);
  fs.unlinkSync(displaced);
  fs.rmdirSync(root);
});

test('a failed report fsync removes partial JSON and retains trusted live evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-private-report-fsync-'));
  const destination = path.join(root, 'report.json');
  const reservation = reservePrivateReport(destination);
  const archivalError = Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
  assert.throws(
    () => writeReservedPrivateReport(reservation, { schema: 'fixture' }, {
      fsyncImpl: () => { throw archivalError; },
    }),
    /simulated disk failure/
  );
  closePrivateReportReservation(reservation, { removeIncomplete: true });
  assert.equal(fs.existsSync(destination), false);
  assert.equal(shouldRetainReleaseWorkDir({
    releaseTrustOk: true,
    workDir: '/private/trusted-eval-work',
    archivalError,
  }), true);
  assert.equal(shouldRetainReleaseWorkDir({
    releaseTrustOk: false,
    workDir: '/private/untrusted-eval-work',
    archivalError,
  }), false);
  fs.rmdirSync(root);
});

const TRUSTED_SCOPE = {
  mode: 'release',
  releaseEligible: true,
  trust: {
    ok: true,
    status: 'attested',
    configuredStatus: 'attested',
    evidenceSource: 'runtime-observed',
    evidenceHash: 'e'.repeat(64),
    requiredCapabilities: [
      'fullHarborRuntimeClosureAttested',
      'keyBearingToolchainIsolated',
      'sandboxEntryChainAttested',
      'mountsObservedFromTrustedSupervisor',
      'escapedProcessesAndContainersReaped',
      'imageResourcesAndNetworkObserved',
    ],
    missingCapabilities: [],
  },
};

const CONFIG = {
  evaluationScope: TRUSTED_SCOPE,
  budget: { releaseCeilingUsd: 20, kimiPairUsd: 10, rerunUsd: 8 },
  task: {
    datasetRef: 'terminal-bench@2.0',
    task: 'cobol-modernization',
    taskChecksum: 'a'.repeat(64),
    taskSet: [{ task: 'cobol-modernization', role: 'anchor', taskChecksum: 'a'.repeat(64) }],
  },
  efficiencyThresholds: { promptRatio: 2, costRatio: 1.5, wallTimeRatio: 1.25 },
  valueThresholds: {
    maxIncrementalApiCostPerAdditionalSuccessUsd: 2,
    maxIncrementalWallTimePerAdditionalSuccessMs: 600_000,
  },
};

const SANDBOX_LOCK = {
  sourceImage: 'example/task:20260731',
  immutableImage: 'example/task@sha256:' + '1'.repeat(64),
  imageId: 'sha256:' + '1'.repeat(64),
  platform: 'linux/amd64',
  cpus: 1,
  memoryMb: 2048,
  storageMb: 10240,
};
const SANDBOX_ATTESTATION = {
  ...SANDBOX_LOCK,
  dockerExecutableHash: '2'.repeat(64),
  observedImageId: SANDBOX_LOCK.imageId,
  observedPlatform: SANDBOX_LOCK.platform,
  executionTaskHash: '3'.repeat(64),
  identityAttested: true,
};
const SANDBOX_CONFIG = {
  ...CONFIG,
  task: {
    ...CONFIG.task,
    taskSet: CONFIG.task.taskSet.map((entry) => ({ ...entry, sandbox: SANDBOX_LOCK })),
  },
};

const MULTI_TASK_CONFIG = {
  ...CONFIG,
  task: {
    datasetRef: 'terminal-bench@2.0',
    task: 'multi-task-canary',
    taskChecksum: null,
    taskSet: [
      { task: 'cobol-modernization', role: 'anchor', taskChecksum: 'a'.repeat(64) },
      { task: 'build-pmars', role: 'candidate', taskChecksum: 'b'.repeat(64) },
    ],
  },
};

/** A schema-valid eval-run document; `over` shallow-merges per section. */
function fullRun(condition, verdict, over = {}) {
  const doc = {
    schema: 'eval-run.v1',
    reproducibility: {
      releaseSha: 'abc123',
      harnessVersion: '0.5.0',
      harnessContentHash: condition === 'harness' ? '3'.repeat(64) : null,
      taskId: 'cobol-modernization',
      taskRevision: 'terminal-bench@2.0',
      condition,
      modelProfileId: 'kimi-k2.7-code',
      billingProfileHash: billingProfileHash('kimi-k2.7-code'),
      pricingCatalogCheckedAt: '2026-07-31',
      modelRequested: 'moonshotai/kimi-k2.7-code-20260612',
      modelResolved: 'moonshotai/kimi-k2.7-code-20260612',
      providerResolved: 'Moonshot AI',
      providerRequestedOrder: ['moonshotai/int4'],
      providerExpectedResolvedNames: ['Moonshot AI'],
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
      trialCeilingUsd: 0.65,
      taskHash: 'a'.repeat(64),
      bundleManifestHash: '7'.repeat(64),
      conditionHash: '2'.repeat(64),
      systemPromptHash: '3'.repeat(64),
      instructionHash: '8'.repeat(64),
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
      cachedPromptTokensComplete: true,
      reasoningTokensComplete: true,
      outputTokens: 400,
      providerReportedCostUsd: 0.02,
      localCostUsd: 0.002398,
      reconciledCostUsd: 0.02,
      usageComplete: true,
      providerCostComplete: true,
      billingComplete: true,
      costComplete: true,
      billingUncertain: false,
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
        {
          type: 'request',
          requestId: `request-${index + 1}`,
          systemPromptHash: '3'.repeat(64),
          instructionHash: '8'.repeat(64),
          systemMessageCount: 1,
          instructionMessageCount: 1,
          toolSchemaHash: '4'.repeat(64),
          toolCount: 2,
          toolMode: 'full',
          postVerify: false,
        },
        { type: 'request_attempt', requestId: `request-${index + 1}`, attemptId: `attempt-${index + 1}` },
        {
          type: 'response',
          requestId: `request-${index + 1}`,
          attemptId: `attempt-${index + 1}`,
          model: 'moonshotai/kimi-k2.7-code-20260612',
          provider: 'Moonshot AI',
          billingStatus: 'reported',
          usage: {
            promptTokens: 200,
            cachedTokens: 40,
            cachedTokensComplete: true,
            reasoningTokens: 0,
            reasoningTokensComplete: true,
            outputTokens: 80,
            localCostUsd: 0.0004796,
            providerCostUsd: 0.004,
            reconciledCostUsd: 0.004,
          },
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
      uncorrelatedProviderTerminals: 0,
      duplicateProviderAttemptIdentities: 0,
      duplicateProviderTerminalIdentities: 0,
      invalidProviderEventIdentities: 0,
      correlatedToolResults: 9,
      uncorrelatedToolResults: 0,
      unclosedToolCalls: 0,
      duplicateToolCallIdentities: 0,
      duplicateToolResultIdentities: 0,
      invalidToolEventIdentities: 0,
      malformedToolCallEvidence: 0,
      malformedToolResultEvidence: 0,
      invalidToolArguments: 0,
      incompleteToolContainment: 0,
      controlContaminationDetected: false,
      runtimeContractEvidence: {
        complete: true,
        matchesExpected: true,
        expectedSystemPromptHash: '3'.repeat(64),
        actualSystemPromptHash: '3'.repeat(64),
        expectedToolSchemaHash: '4'.repeat(64),
        actualToolSchemaHash: '4'.repeat(64),
        expectedToolCount: 2,
        actualToolCount: 2,
        expectedFinishToolSchemaHash: '9'.repeat(64),
        expectedFinishToolCount: 1,
        requestContractsChecked: 5,
        postVerifyRequestContracts: 0,
        requestPromptMismatches: 0,
        requestContractMismatches: 0,
        expectedInstructionHash: '8'.repeat(64),
        actualInstructionHash: '8'.repeat(64),
        instructionHash: '8'.repeat(64),
        reason: null,
      },
      mountPolicyEvidence: {
        version: 'eval-mount-policy.v1',
        source: 'sandbox-observed',
        observed: true,
        complete: true,
        matchesCondition: true,
        structurallyIsolated: true,
        effectiveTargets: condition === 'harness'
          ? ['/opt/eval-runtime', '/opt/harness-bundle/harness']
          : ['/opt/eval-runtime'],
        commonTargets: ['/opt/eval-runtime'],
        treatmentOnlyTargets: ['/opt/harness-bundle/harness'],
        reason: null,
      },
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

function setProviderReportedCost(doc, totalUsd) {
  const responses = doc.observability.providerEvents.filter((event) => event.type === 'response');
  const perResponse = totalUsd / responses.length;
  for (const response of responses) {
    response.usage.providerCostUsd = perResponse;
    response.usage.reconciledCostUsd = Math.max(response.usage.localCostUsd, perResponse);
  }
  doc.efficiency.providerReportedCostUsd = totalUsd;
  doc.efficiency.reconciledCostUsd = responses.reduce(
    (total, response) => total + response.usage.reconciledCostUsd,
    0
  );
  return doc;
}

function pairOf(host, genericVerdict, harnessVerdict, over = {}) {
  const task = over.task ?? over.generic?.reproducibility?.taskId ?? over.harness?.reproducibility?.taskId ?? 'cobol-modernization';
  const pairId = over.pairId ?? over.generic?.reproducibility?.pairId ?? over.harness?.reproducibility?.pairId ?? 'pair-1';
  const attempt = over.attempt ?? over.generic?.reproducibility?.attempt ?? over.harness?.reproducibility?.attempt ?? 'a';
  const generic = fullRun('generic', genericVerdict, over.generic ?? {});
  const harness = fullRun('harness', harnessVerdict, over.harness ?? {});
  for (const doc of [generic, harness]) {
    doc.reproducibility.host = host;
    doc.reproducibility.taskId = task;
    doc.reproducibility.pairId = pairId;
    doc.reproducibility.attempt = attempt;
  }
  return {
    host,
    task,
    pairId,
    repetitionCount: over.repetitionCount ?? 1,
    generic,
    harness,
    failureKind: over.failureKind ?? null,
  };
}

function rerunPairOf(host, genericVerdict, harnessVerdict, over = {}) {
  const pair = pairOf(host, genericVerdict, harnessVerdict, {
    ...over,
    pairId: over.pairId ?? 'pair-2',
    attempt: over.attempt ?? 'b',
  });
  for (const doc of [pair.generic, pair.harness]) {
    doc.reproducibility.repetitionId = over.repetitionId ?? 'rerun-repetition-1';
  }
  return pair;
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
  const steps = {
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
  const retainedCost = (result) => (Array.isArray(result) ? result : [result])
    .filter(Boolean)
    .flatMap((pair) => [pair.generic, pair.harness])
    .filter(Boolean)
    .flatMap((doc) => Array.isArray(doc.repetitions) && doc.repetitions.length ? doc.repetitions : [doc])
    .reduce((total, doc) => total + (Number.isFinite(doc.efficiency?.reconciledCostUsd)
      ? doc.efficiency.reconciledCostUsd
      : 0), 0);
  for (const name of ['kimiPair', 'rerunKimiPair']) {
    if (typeof steps[name] !== 'function') continue;
    const original = steps[name];
    steps[name] = async (budget, ...args) => {
      const before = budget.knownReconciledSpendUsd();
      const result = await original(budget, ...args);
      if (Math.abs(budget.knownReconciledSpendUsd() - before) <= 1e-12) {
        budget.charge(retainedCost(result), `test fixture ${name} retained evidence`);
      }
      return result;
    };
  }
  return steps;
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

test('release trust requires runtime-observed evidence in addition to configured intent', () => {
  const capabilityNames = [
    'fullHarborRuntimeClosureAttested',
    'keyBearingToolchainIsolated',
    'sandboxEntryChainAttested',
    'mountsObservedFromTrustedSupervisor',
    'escapedProcessesAndContainersReaped',
    'imageResourcesAndNetworkObserved',
  ];
  const all = Object.fromEntries(capabilityNames.map((name) => [name, true]));
  const evidence = { source: 'runtime-observed', evidenceHash: 'e'.repeat(64), capabilities: all };

  assert.equal(releaseTrustVerdict({ releaseTrust: { status: 'blocked', capabilities: all } }, evidence).ok, false);
  assert.equal(releaseTrustVerdict({ releaseTrust: { status: 'attested', capabilities: all } }).ok, false,
    'YAML booleans alone are never an attestation');
  assert.equal(releaseTrustVerdict({ releaseTrust: { status: 'attested', capabilities: all } }, evidence).ok, true);

  for (const missingCapability of capabilityNames) {
    const partial = { ...all, [missingCapability]: false };
    const verdict = releaseTrustVerdict(
      { releaseTrust: { status: 'attested', capabilities: all } },
      { ...evidence, capabilities: partial }
    );
    assert.equal(verdict.ok, false, missingCapability);
    assert.deepEqual(verdict.missingCapabilities, [missingCapability]);
  }
});

test('runRelease cannot green or spend when trust or preflight evidence is absent', async () => {
  const providerCalls = [];
  const goodEnvironment = async () => ({
    ok: true,
    missing: [],
    providerSpendGuard: {
      verified: true,
      limitUsd: 20,
      limitRemainingUsd: 20,
      reset: null,
      checkedAt: '2026-07-31T00:00:00.000Z',
    },
  });
  const cases = [
    {
      config: { ...CONFIG, evaluationScope: undefined },
      expectedReleaseEligible: false,
      steps: {
        deterministic: async () => ({ passed: 17, failed: 0, skipped: 2 }),
        environment: goodEnvironment,
        taskLock: async () => ({ ok: true, reason: '' }),
      },
    },
    {
      config: CONFIG,
      expectedReleaseEligible: true,
      steps: { deterministic: async () => ({ passed: 17, failed: 0, skipped: 2 }) },
    },
    {
      config: CONFIG,
      expectedReleaseEligible: true,
      steps: {
        deterministic: async () => ({ passed: '17', failed: 0, skipped: 2 }),
        environment: goodEnvironment,
        taskLock: async () => ({ ok: true, reason: '' }),
      },
    },
  ];

  for (const entry of cases) {
    const { report, exitCode } = await runRelease({
      ...entry,
      requiredPairs: [],
      steps: {
        ...entry.steps,
        kimiPair: async () => {
          providerCalls.push('called');
          return pairOf('openrouter-kimi', 'pass', 'pass');
        },
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(report.preflight.ok, false);
    assert.equal(report.evaluationScope.releaseEligible, entry.expectedReleaseEligible);
    assert.equal(report.pairs.find((pair) => pair.host === 'openrouter-kimi').required, undefined,
      'internal required state is not serialized');
    assert.ok(report.gate.block);
  }
  assert.deepEqual(providerCalls, [], 'an empty caller list cannot erase the mandatory paid denominator');
});

test('preflight diagnostics are bounded to one terminal-safe line', async () => {
  const { report } = await runRelease({
    config: CONFIG,
    requiredPairs: [],
    steps: baseSteps({
      environment: async () => ({ ok: false, missing: ['first\nsecond\tthird\r\u0007fourth'] }),
    }),
  });
  assert.equal(report.preflight.environment.missing[0], 'first second third fourth');
});

test('release policy validation fails closed on partial economics and unknown claim modes', async () => {
  assert.equal(validateReleasePolicyConfig(CONFIG).ok, true);
  for (const invalid of [
    { ...CONFIG, valueThresholds: { maxIncrementalApiCostPerAdditionalSuccessUsd: 2 } },
    { ...CONFIG, claimPolicy: { mode: 'typo-policy' } },
    { ...CONFIG, claimPolicy: { mode: 'initial-user-ship', minimumHarnessSolvedTasks: 0 } },
    { ...CONFIG, budget: { releaseCeilingUsd: 10, kimiPairUsd: 9, rerunUsd: 2 } },
  ]) {
    const verdict = validateReleasePolicyConfig(invalid);
    assert.equal(verdict.ok, false);
    await assert.rejects(
      runRelease({ config: invalid, steps: baseSteps() }),
      /invalid release evaluation policy/i
    );
  }
});

test('initial calibration and post-qualification routine profiles encode different ship decisions', async () => {
  const calibrationProfile = YAML.parse(fs.readFileSync(
    new URL('../../../evals/config/release-canary.yaml', import.meta.url),
    'utf8'
  ));
  const routineProfile = YAML.parse(fs.readFileSync(
    new URL('../../../evals/config/release-routine.yaml', import.meta.url),
    'utf8'
  ));
  assert.equal(calibrationProfile.claimPolicy.mode, 'initial-user-ship');
  assert.equal(calibrationProfile.repetitions.calibration, 3);
  assert.equal(routineProfile.claimPolicy.mode, 'regression-gate');
  assert.equal(routineProfile.repetitions.routine, 1);
  assert.equal(routineProfile.budget.releaseCeilingUsd, 10);
  assert.equal(validateReleasePolicyConfig({ ...routineProfile, task: CONFIG.task }).ok, true);

  const routineConfig = {
    ...CONFIG,
    claimPolicy: routineProfile.claimPolicy,
    repetitions: routineProfile.repetitions,
    budget: routineProfile.budget,
  };
  const routineEnvironment = async () => ({
    ok: true,
    missing: [],
    providerSpendGuard: {
      verified: true,
      limitUsd: 10,
      limitRemainingUsd: 10,
      reset: null,
      checkedAt: '2026-07-31T00:00:00.000Z',
    },
  });
  const { report, exitCode } = await runRelease({
    config: routineConfig,
    steps: baseSteps({ environment: routineEnvironment }),
  });
  assert.equal(report.readiness.policy, 'regression-gate');
  assert.equal(report.readiness.ready, null);
  assert.equal(report.claim.level, 'bounded-overhead');
  assert.equal(exitCode, 0, 'one-repetition post-qualification parity can pass the routine gate');

  const allFail = await runRelease({
    config: routineConfig,
    steps: baseSteps({
      environment: routineEnvironment,
      kimiPair: async () => pairOf('openrouter-kimi', 'fail', 'fail'),
    }),
  });
  assert.equal(allFail.report.claim.level, 'inconclusive');
  assert.equal(allFail.exitCode, 1, 'routine mode cannot green after losing all established capability');
  assert.ok(allFail.report.gate.reasons.some((reason) => /neither controlled arm solved/i.test(reason)));
});

test('release repetition selection preserves the legacy seeds fallback for every release mode', () => {
  assert.equal(releaseRepetitionCount({ repetitions: { calibration: 3, routine: 1 } }, true), 3);
  assert.equal(releaseRepetitionCount({ repetitions: { calibration: 3, routine: 1 } }, false), 1);
  assert.equal(releaseRepetitionCount({ seeds: { calibration: 5, routine: 2 } }, true), 5);
  assert.equal(releaseRepetitionCount({ seeds: { calibration: 5, routine: 2 } }, false), 2);
  assert.equal(releaseRepetitionCount({}, true), 3);
  assert.equal(releaseRepetitionCount({}, false), 1);
  assert.throws(
    () => releaseRepetitionCount({ seeds: { calibration: 'many' } }, true),
    /calibration repetitions must be a positive integer/i
  );
  assert.equal(releaseMinimumCalibrationRepetitions({ repetitions: { calibration: 3 } }), 3);
  assert.throws(
    () => releaseMinimumCalibrationRepetitions({
      repetitions: { calibration: 3 },
      claimPolicy: { minimumCalibrationRepetitions: 'three' },
    }),
    /minimumCalibrationRepetitions must be an integer >= 2/i
  );
});

test('release invocation policy rejects guaranteed-to-block paid mode combinations', () => {
  assert.equal(releaseInvocationPolicy({
    claimMode: 'regression-gate',
    calibrationRelease: true,
  }).ok, false, 'routine profiles cannot spend on a calibration that is ineligible by policy');
  assert.equal(releaseInvocationPolicy({
    claimMode: 'initial-user-ship',
    calibrationRelease: false,
    trustOk: true,
  }).ok, false, 'a trusted full initial-ship run must use the qualifying calibration');
  assert.equal(releaseInvocationPolicy({
    claimMode: 'initial-user-ship',
    calibrationRelease: true,
    diagnosticScope: true,
  }).ok, false, 'a calibration cannot use a partial diagnostic denominator');
  assert.equal(releaseInvocationPolicy({
    claimMode: 'initial-user-ship',
    calibrationRelease: false,
    trustOk: false,
  }).ok, true, 'the zero-spend diagnostic-trust report remains available while trust is red');
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
    task: 'cobol-modernization',
    pairId: 'pair-1',
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

  const incomplete = pairOf('openrouter-kimi', 'pass', 'pass');
  incomplete.harness.reproducibility.providerRequestedOrder = null;
  const classification = classifyPair(incomplete);
  assert.equal(classification.result, 'infrastructure-invalid');
  assert.equal(classification.fallbackDetected, false, 'missing provider metadata is incomplete evidence, not a false fallback claim');
});

test('controlled arms are infrastructure-invalid unless every causal identity field aligns', async () => {
  const cases = [
    ['model request', (doc) => { doc.reproducibility.modelRequested = 'different/model'; }],
    ['provider policy', (doc) => { doc.reproducibility.providerRequestedOrder = ['different-provider']; }],
    ['task hash', (doc) => { doc.reproducibility.taskHash = 'f'.repeat(64); }],
    ['bundle manifest', (doc) => { doc.reproducibility.bundleManifestHash = 'e'.repeat(64); }],
    ['pair id', (doc) => { doc.reproducibility.pairId = 'different-pair'; }],
    ['repetition id', (doc) => { doc.reproducibility.repetitionId = 'different-repetition'; }],
    ['attempt', (doc) => { doc.reproducibility.attempt = 'b'; }],
    ['reasoning configuration', (doc) => { doc.reproducibility.reasoningConfig = { effort: 'high' }; }],
  ];

  for (const [label, mutate] of cases) {
    const pair = pairOf('openrouter-kimi', 'pass', 'pass');
    mutate(pair.harness);
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({ kimiPair: async () => pair }),
      requiredPairs: ['openrouter-kimi'],
    });
    const result = report.pairs.find((entry) => entry.host === 'openrouter-kimi');
    assert.equal(result.result, 'infrastructure-invalid', label);
    assert.equal(result.causallyAttributable, false, label);
    assert.match(result.reason, /identity/i, label);
    assert.equal(exitCode, 1, label);
  }
});

test('controlled claims require a present bundle hash and the configured task checksum', async () => {
  for (const mutate of [
    (pair) => {
      pair.generic.reproducibility.bundleManifestHash = null;
      pair.harness.reproducibility.bundleManifestHash = null;
    },
    (pair) => {
      pair.generic.reproducibility.taskHash = 'f'.repeat(64);
      pair.harness.reproducibility.taskHash = 'f'.repeat(64);
    },
  ]) {
    const pair = pairOf('openrouter-kimi', 'pass', 'pass');
    mutate(pair);
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({ kimiPair: async () => pair }),
      requiredPairs: ['openrouter-kimi'],
    });
    assert.equal(report.pairs[0].causallyAttributable, false);
    assert.equal(report.claim.level, 'inconclusive');
    assert.equal(exitCode, 1);
  }
});

test('controlled identity remains invariant across repetitions and matches the declared count', () => {
  const repeated = {
    host: 'openrouter-kimi',
    task: 'cobol-modernization',
    pairId: 'pair-1',
    repetitionCount: 3,
    generic: repeatedRun('generic', 'pass'),
    harness: repeatedRun('harness', 'pass'),
    failureKind: null,
  };
  repeated.generic.repetitions[1].reproducibility.bundleManifestHash = 'e'.repeat(64);
  repeated.harness.repetitions[1].reproducibility.bundleManifestHash = 'e'.repeat(64);
  const drifted = classifyPair(repeated);
  assert.equal(drifted.result, 'infrastructure-invalid');
  assert.match(drifted.reason, /cross-repetition.*bundle/i);

  repeated.generic.repetitions[1].reproducibility.bundleManifestHash = '7'.repeat(64);
  repeated.harness.repetitions[1].reproducibility.bundleManifestHash = '7'.repeat(64);
  repeated.repetitionCount = 2;
  const miscounted = classifyPair(repeated);
  assert.equal(miscounted.result, 'infrastructure-invalid');
  assert.match(miscounted.reason, /repetition-count/i);

  repeated.repetitionCount = 3;
  repeated.generic.repetitions[1].reproducibility.repetitionId = 'repetition-1';
  repeated.harness.repetitions[1].reproducibility.repetitionId = 'repetition-1';
  const duplicated = classifyPair(repeated);
  assert.equal(duplicated.result, 'infrastructure-invalid');
  assert.match(duplicated.reason, /repetition-id-uniqueness/i);

  repeated.generic.repetitions[1].reproducibility.repetitionId = 'repetition-2';
  repeated.harness.repetitions[1].reproducibility.repetitionId = 'repetition-2';
  repeated.generic.repetitions[2].reproducibility.repetitionIndex = 4;
  repeated.harness.repetitions[2].reproducibility.repetitionIndex = 4;
  const noncontiguous = classifyPair(repeated);
  assert.equal(noncontiguous.result, 'infrastructure-invalid');
  assert.match(noncontiguous.reason, /repetition-index-sequence/i);

  repeated.generic.repetitions[2].reproducibility.repetitionIndex = 3;
  repeated.harness.repetitions[2].reproducibility.repetitionIndex = 3;
  repeated.harness.repetitions[1].reproducibility.conditionHash = 'f'.repeat(64);
  const treatmentDrift = classifyPair(repeated);
  assert.equal(treatmentDrift.result, 'infrastructure-invalid');
  assert.match(treatmentDrift.reason, /cross-repetition-harness-conditionHash/i);
});

test('sandbox identity drift across arms and repetitions invalidates causal evidence', async () => {
  const armDrift = pairOf('openrouter-kimi', 'pass', 'pass', {
    generic: { reproducibility: { sandbox: SANDBOX_ATTESTATION } },
    harness: {
      reproducibility: {
        sandbox: { ...SANDBOX_ATTESTATION, executionTaskHash: '4'.repeat(64) },
      },
    },
  });
  const armResult = await runRelease({
    config: SANDBOX_CONFIG,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({ kimiPair: async () => armDrift }),
  });
  assert.equal(armResult.report.pairs[0].result, 'infrastructure-invalid');
  assert.equal(armResult.report.pairs[0].causallyAttributable, false);
  assert.match(armResult.report.pairs[0].reason, /sandbox/i);

  const repeated = {
    host: 'openrouter-kimi',
    task: 'cobol-modernization',
    pairId: 'pair-1',
    repetitionCount: 3,
    generic: repeatedRun('generic', 'pass'),
    harness: repeatedRun('harness', 'pass'),
    failureKind: null,
  };
  for (const doc of [...repeated.generic.repetitions, ...repeated.harness.repetitions]) {
    doc.reproducibility.sandbox = structuredClone(SANDBOX_ATTESTATION);
  }
  repeated.generic.repetitions[1].reproducibility.sandbox.executionTaskHash = '4'.repeat(64);
  repeated.harness.repetitions[1].reproducibility.sandbox.executionTaskHash = '4'.repeat(64);
  const drifted = classifyPair(repeated, {
    host: 'openrouter-kimi',
    expectedTask: 'cobol-modernization',
    expectedTaskRevision: 'terminal-bench@2.0',
    expectedTaskHash: 'a'.repeat(64),
    expectedSandbox: SANDBOX_LOCK,
  });
  assert.equal(drifted.result, 'infrastructure-invalid');
  assert.match(drifted.reason, /cross-repetition-sandbox/i);
});

test('a rerun with sandbox identity drift cannot confirm or clear a primary result', async () => {
  const primary = pairOf('openrouter-kimi', 'fail', 'pass', {
    generic: { reproducibility: { sandbox: SANDBOX_ATTESTATION } },
    harness: { reproducibility: { sandbox: SANDBOX_ATTESTATION } },
  });
  const rerun = rerunPairOf('openrouter-kimi', 'fail', 'pass', {
    generic: { reproducibility: { sandbox: { ...SANDBOX_ATTESTATION, executionTaskHash: '4'.repeat(64) } } },
    harness: { reproducibility: { sandbox: { ...SANDBOX_ATTESTATION, executionTaskHash: '4'.repeat(64) } } },
  });
  const { report, exitCode } = await runRelease({
    config: SANDBOX_CONFIG,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({ kimiPair: async () => primary, rerunKimiPair: async () => rerun }),
  });
  const pair = report.pairs[0];
  assert.equal(pair.rerun.causallyAttributable, false);
  assert.match(pair.rerun.reason, /rerun.*sandbox/i);
  assert.notEqual(pair.reproduced, true);
  assert.equal(exitCode, 1);
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
  const base = { releaseCeilingUsd: 10, kimiPairUsd: 8, rerunUsd: 2 };
  assert.deepEqual(scaleReleaseBudget(base, 10), base);
  assert.deepEqual(scaleReleaseBudget(base, 20), { releaseCeilingUsd: 20, kimiPairUsd: 16, rerunUsd: 4 });
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

test('efficiency deltas compare the same conservative reconciled cost charged by execution', () => {
  const generic = fullRun('generic', 'pass', {
    efficiency: { providerReportedCostUsd: 0.02, localCostUsd: 0.02, reconciledCostUsd: 0.02 },
  });
  const harness = fullRun('harness', 'pass', {
    efficiency: { providerReportedCostUsd: 0.02, localCostUsd: 0.02, reconciledCostUsd: 0.04 },
  });

  const delta = efficiencyDelta(generic, harness, CONFIG.efficiencyThresholds);

  assert.equal(delta.costRatio, 2);
  assert.equal(delta.withinThresholds, false);
  assert.ok(delta.breaches.includes('costRatio'));
});

test('efficiency deltas exclude billing-uncertain cost from comparable evidence', () => {
  const generic = fullRun('generic', 'pass');
  const harness = fullRun('harness', 'pass', {
    efficiency: { billingUncertain: true },
  });

  const delta = efficiencyDelta(generic, harness, CONFIG.efficiencyThresholds);

  assert.equal(delta.costRatio, null);
  assert.equal(delta.evidenceComplete, false);
  assert.equal(delta.withinThresholds, false);
});

test('prompt overhead attribution exactly separates request-count and request-size effects', () => {
  const request = (payloadChars, components, charsByRole) => ({
    type: 'request',
    payloadChars,
    baseSystemChars: components.base,
    instructionChars: components.instruction,
    toolSchemaChars: components.tools,
    durableStateChars: components.state,
    charsByRole,
  });
  const generic = {
    observability: {
      providerEvents: Array.from({ length: 2 }, () =>
        request(100, { base: 10, instruction: 20, tools: 10, state: 5 }, { system: 20, user: 30, assistant: 10 })
      ),
    },
  };
  const harness = {
    observability: {
      providerEvents: Array.from({ length: 3 }, () =>
        request(150, { base: 20, instruction: 30, tools: 20, state: 10 }, { system: 40, user: 40, assistant: 20 })
      ),
    },
  };

  const attribution = overheadAttribution(generic, harness);
  assert.equal(attribution.complete, true);
  assert.equal(attribution.delta.payloadChars, 250);
  assert.equal(attribution.delta.requestCountEffectChars, 100);
  assert.equal(attribution.delta.requestSizeEffectChars, 150);
  assert.equal(
    attribution.delta.requestCountEffectChars + attribution.delta.requestSizeEffectChars,
    attribution.delta.payloadChars
  );
  assert.equal(attribution.generic.recurringStaticChars, 80);
  assert.equal(attribution.harness.recurringStaticChars, 210);
  assert.equal(attribution.generic.dynamicAndFramingChars, 120);
  assert.equal(attribution.harness.dynamicAndFramingChars, 240);
  assert.equal(attribution.generic.dynamicExcludingDurableChars, 110);
  assert.equal(attribution.harness.dynamicExcludingDurableChars, 210);
  assert.equal(attribution.harness.durableStateChars, 30);
  assert.deepEqual({
    baseSystemChars: attribution.delta.baseSystemChars,
    instructionChars: attribution.delta.instructionChars,
    toolSchemaChars: attribution.delta.toolSchemaChars,
    durableStateChars: attribution.delta.durableStateChars,
    dynamicExcludingDurableChars: attribution.delta.dynamicExcludingDurableChars,
  }, {
    baseSystemChars: 40,
    instructionChars: 50,
    toolSchemaChars: 40,
    durableStateChars: 20,
    dynamicExcludingDurableChars: 100,
  });
  assert.deepEqual(attribution.harness.charsByRole, { assistant: 60, system: 120, user: 120 });

  delete harness.observability.providerEvents[0].toolSchemaChars;
  assert.equal(overheadAttribution(generic, harness).complete, false);
  const noBaseline = overheadAttribution({ observability: { providerEvents: [] } }, harness);
  assert.equal(noBaseline.delta.requestCountEffectChars, null);
  assert.equal(noBaseline.delta.requestSizeEffectChars, null);
});

test('incremental value economics use net added success and enforce cost/time boundaries', () => {
  const generic = fullRun('generic', 'fail', {
    efficiency: { wallTimeMs: 60_000, providerReportedCostUsd: 0.02, localCostUsd: 0.02, reconciledCostUsd: 0.02 },
  });
  const harness = fullRun('harness', 'pass', {
    efficiency: { wallTimeMs: 660_000, providerReportedCostUsd: 2.02, localCostUsd: 2.02, reconciledCostUsd: 2.02 },
  });
  const policy = {
    maxIncrementalApiCostPerAdditionalSuccessUsd: 2,
    maxIncrementalWallTimePerAdditionalSuccessMs: 600_000,
  };

  const delta = efficiencyDelta(generic, harness, CONFIG.efficiencyThresholds, policy);
  assert.equal(delta.valueEconomics.additionalSuccesses, 1);
  assert.equal(delta.valueEconomics.incrementalApiCostUsd, 2);
  assert.equal(delta.valueEconomics.incrementalWallTimeMs, 600_000);
  assert.equal(delta.valueEconomics.costPerAdditionalSuccessUsd, 2);
  assert.equal(delta.valueEconomics.wallTimePerAdditionalSuccessMs, 600_000);
  assert.equal(delta.valueEconomics.policyConfigured, true);
  assert.equal(delta.valueEconomics.evidenceComplete, true);
  assert.equal(delta.valueEconomics.withinThresholds, true, 'thresholds are inclusive');
});

test('an uneconomic primary win blocks and does not spend the confirmation allowance', async () => {
  let rerunCalls = 0;
  const valueConfig = {
    ...CONFIG,
    valueThresholds: {
      maxIncrementalApiCostPerAdditionalSuccessUsd: 2,
      maxIncrementalWallTimePerAdditionalSuccessMs: 600_000,
    },
  };
  const expensiveWin = pairOf('openrouter-kimi', 'fail', 'pass', {
    harness: {
      efficiency: {
        wallTimeMs: 660_001,
      },
    },
  });
  setProviderReportedCost(expensiveWin.harness, 2.03);
  const { report, exitCode } = await runRelease({
    config: valueConfig,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({
      kimiPair: async () => expensiveWin,
      rerunKimiPair: async () => {
        rerunCalls += 1;
        return rerunPairOf('openrouter-kimi', 'fail', 'pass');
      },
    }),
  });

  assert.equal(rerunCalls, 0);
  assert.equal(report.claim.confirmedWins, 0);
  assert.notEqual(report.claim.level, 'demonstrated-value');
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /incremental cost\/time value limits/i.test(reason)));
});

test('an uneconomic or incomplete fresh win cannot confirm demonstrated value', async () => {
  const valueConfig = {
    ...CONFIG,
    valueThresholds: {
      maxIncrementalApiCostPerAdditionalSuccessUsd: 2,
      maxIncrementalWallTimePerAdditionalSuccessMs: 600_000,
    },
  };
  for (const harnessEfficiency of [
    { wallTimeMs: 700_001, providerReportedCostUsd: 2.03, localCostUsd: 2.03, reconciledCostUsd: 2.03 },
    { wallTimeMs: null, costComplete: false },
  ]) {
    const { report, exitCode } = await runRelease({
      config: valueConfig,
      requiredPairs: ['openrouter-kimi'],
      steps: baseSteps({
        kimiPair: async () => pairOf('openrouter-kimi', 'fail', 'pass'),
        rerunKimiPair: async () => rerunPairOf('openrouter-kimi', 'fail', 'pass', {
          harness: { efficiency: harnessEfficiency },
        }),
      }),
    });
    const pair = report.pairs.find((entry) => entry.host === 'openrouter-kimi');
    assert.notEqual(pair.reproduced, true);
    assert.equal(report.claim.confirmedWins, 0);
    assert.notEqual(report.claim.level, 'demonstrated-value');
    assert.equal(exitCode, 1);
    assert.ok(report.gate.reasons.some((reason) => /win confirmation.*incremental cost\/time|telemetry/i.test(reason)));
  }
});

test('there is no decorative reserve outside the primary and fresh-pair allowances', () => {
  const budgets = allocateReleaseBudgets(CONFIG.budget);
  assert.equal('reserve' in budgets, false);
  budgets.kimiPair.charge(10, 'primary');
  budgets.rerun.charge(8, 'fresh pair');
  assert.equal(budgets.release.spentUsd(), 18);
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

test('the report schema rejects malformed release decisions and economic evidence', async () => {
  const { report } = await runRelease({
    config: CONFIG,
    steps: baseSteps(),
    releaseSha: 'abc123',
    harnessVersion: '0.5.0',
  });
  const mutations = [
    ['budget.providerSpendGuard', 'forged'],
    ['budget.enforcementSemantics', 'forged'],
    ['budget.requestEstimateSemantics', 'forged'],
    ['budget.allocations.controlledPairUsd', '8'],
    ['claim.level', 'forged'],
    ['claim.confirmedWins', -1],
    ['deterministic.passed', 0.5],
    ['deterministic.failed', 0.5],
    ['deterministic.skipped', 0.5],
    ['pairs.0.repetitionCount', 0.5],
    ['claim.controlledPairs', 0.5],
    ['claim.controlledWins', 0.5],
    ['claim.confirmedWins', 0.5],
    ['claim.regressions', 0.5],
    ['readiness.minimumHarnessSolvedTasks', 0.5],
    ['readiness.harnessSolvedTasks', 0.5],
    ['readiness.policy', 'forged'],
    ['readiness.ready', 'yes'],
    ['readiness.calibrationRequired', 'yes'],
    ['readiness.calibrationBaseline', {}],
    ['pairs.0.result', 'forged'],
    ['evaluationScope.trust.evidenceSource', null],
    ['evaluationScope.trust.evidenceHash', null],
  ];

  for (const [field, value] of mutations) {
    const malformed = structuredClone(report);
    const segments = field.split('.');
    const leaf = segments.pop();
    let cursor = malformed;
    for (const segment of segments) cursor = cursor[Number.isInteger(Number(segment)) ? Number(segment) : segment];
    cursor[leaf] = value;
    const verdict = validateAgainstSchema(malformed, REPORT_SCHEMA);
    assert.equal(verdict.ok, false, `${field} must be validated`);
    assert.ok(verdict.errors.some((error) => error.includes(field)), `${field}: ${verdict.errors.join('; ')}`);
  }

  const validBaseline = {
    valid: true,
    evidenceHash: 'f'.repeat(64),
    minimumRepetitions: 3,
    controlledWins: 1,
    harnessSolvedTasks: 1,
    reasons: [],
  };
  for (const field of ['minimumRepetitions', 'controlledWins', 'harnessSolvedTasks']) {
    const malformed = structuredClone(report);
    malformed.readiness.calibrationBaseline = { ...validBaseline, [field]: 0.5 };
    const verdict = validateAgainstSchema(malformed, REPORT_SCHEMA);
    assert.equal(verdict.ok, false, `readiness.calibrationBaseline.${field} must be an integer`);
    assert.ok(
      verdict.errors.some((error) => error.includes(`readiness.calibrationBaseline.${field}`)),
      verdict.errors.join('; ')
    );
  }
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
    task: 'cobol-modernization',
    pairId: 'pair-1',
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

test('multi-repetition classification uses aligned paired outcomes, not marginal arm majorities', async () => {
  const withVerdicts = (condition, verdicts) => {
    const aggregate = repeatedRun(condition, verdicts[0], verdicts.length);
    for (const [index, verdict] of verdicts.entries()) {
      aggregate.repetitions[index].correctness.verdict = verdict;
      aggregate.repetitions[index].correctness.verifierReward = verdict === 'pass' ? 1 : 0;
    }
    // Reproduce the old misleading marginals: generic majority-fail and
    // Harness majority-pass, even though no paired outcome has a majority.
    aggregate.correctness.verdict = verdicts.filter((value) => value === 'pass').length > verdicts.length / 2 ? 'pass' : 'fail';
    return aggregate;
  };
  const mixed = {
    host: 'openrouter-kimi',
    task: 'cobol-modernization',
    pairId: 'pair-1',
    repetitionCount: 3,
    generic: withVerdicts('generic', ['fail', 'fail', 'pass']),
    harness: withVerdicts('harness', ['pass', 'fail', 'pass']),
    failureKind: null,
  };
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({ kimiPair: async () => mixed }),
  });
  const pair = report.pairs.find((entry) => entry.host === 'openrouter-kimi');
  assert.equal(pair.result, 'mixed-inconclusive');
  assert.deepEqual(pair.pairedOutcomes.counts, {
    'harness-win': 1,
    parity: 1,
    'harness-regression': 0,
    'inconclusive-capability': 1,
  });
  assert.equal(report.claim.level, 'inconclusive');
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /paired outcome variance/i.test(reason)));

  mixed.generic.repetitions[2].correctness.verdict = 'fail';
  mixed.generic.repetitions[2].correctness.verifierReward = 0;
  const confirmed = classifyPair(mixed);
  assert.equal(confirmed.result, 'harness-win');
  assert.equal(confirmed.pairedOutcomes.counts['harness-win'], 2);
});

test('efficiency uses median paired ratios rather than a ratio of independent medians', () => {
  const generic = repeatedRun('generic', 'pass');
  const harness = repeatedRun('harness', 'pass');
  const genericPrompt = [1, 100, 100];
  const harnessPrompt = [2, 100, 200];
  for (let index = 0; index < 3; index += 1) {
    generic.repetitions[index].efficiency.promptTokens = genericPrompt[index];
    harness.repetitions[index].efficiency.promptTokens = harnessPrompt[index];
  }
  // Independent medians would be 100/100=1; aligned ratios are 2,1,2.
  const delta = efficiencyDelta(generic, harness, CONFIG.efficiencyThresholds);
  assert.equal(delta.promptRatio, 2);
  assert.deepEqual(delta.ratioDistribution.promptRatio.values, [2, 1, 2]);
  assert.equal(delta.pairedStatistic, 'median-of-aligned-repetition-ratios');
});

test('release efficiency gates the worst aligned repetition, not only the median', () => {
  const generic = repeatedRun('generic', 'pass');
  const harness = repeatedRun('harness', 'pass');
  for (let index = 0; index < 3; index += 1) {
    generic.repetitions[index].efficiency.promptTokens = 100;
    harness.repetitions[index].efficiency.promptTokens = [100, 100, 10_000][index];
  }
  const delta = efficiencyDelta(generic, harness, CONFIG.efficiencyThresholds);
  assert.equal(delta.promptRatio, 1, 'the median remains the reported point estimate');
  assert.equal(delta.ratioDistribution.promptRatio.max, 100);
  assert.equal(delta.gatingStatistic, 'maximum-of-aligned-repetition-ratios');
  assert.equal(delta.withinThresholds, false, 'one extreme repetition breaks the consistency bar');
  assert.ok(delta.breaches.includes('promptRatio'));
});

test('paired classification and efficiency exclude explicitly invalid retained repetitions', () => {
  const generic = repeatedRun('generic', 'fail');
  const harness = repeatedRun('harness', 'pass');
  const genericVerdicts = ['fail', 'pass', 'fail'];
  const harnessVerdicts = ['pass', 'pass', 'pass'];
  const genericPrompts = [100, 100, 1];
  const harnessPrompts = [200, 100, 1000];
  for (let index = 0; index < 3; index += 1) {
    for (const [doc, verdict] of [
      [generic.repetitions[index], genericVerdicts[index]],
      [harness.repetitions[index], harnessVerdicts[index]],
    ]) {
      doc.correctness.verdict = verdict;
      doc.correctness.verifierReward = verdict === 'pass' ? 1 : 0;
      doc.trialValidity = { valid: index !== 2, failureKind: index === 2 ? 'infrastructure' : null };
    }
    generic.repetitions[index].efficiency.promptTokens = genericPrompts[index];
    harness.repetitions[index].efficiency.promptTokens = harnessPrompts[index];
  }
  const pair = {
    host: 'openrouter-kimi',
    task: 'cobol-modernization',
    pairId: 'pair-1',
    repetitionCount: 3,
    generic,
    harness,
    failureKind: null,
  };

  const classification = classifyPair(pair);
  const delta = efficiencyDelta(generic, harness, CONFIG.efficiencyThresholds);
  assert.equal(classification.result, 'mixed-inconclusive', 'the invalid apparent second win cannot create a majority');
  assert.equal(classification.pairedOutcomes.pairedRepetitions, 2);
  assert.deepEqual(classification.pairedOutcomes.counts, {
    'harness-win': 1,
    parity: 1,
    'harness-regression': 0,
    'inconclusive-capability': 0,
  });
  assert.equal(delta.pairedRepetitions, 2);
  assert.equal(delta.promptRatio, 1.5, 'only valid ratios 2 and 1 contribute; the invalid 1000x ratio is retained only for audit');
});

test('active success parity above an efficiency threshold blocks the release claim', async () => {
  const expensive = pairOf('openrouter-kimi', 'pass', 'pass', {
    harness: { efficiency: { promptTokens: 2001 } },
  });
  expensive.harness.observability.providerEvents
    .find((event) => event.type === 'response').usage.promptTokens += 1001;
  const changedUsage = expensive.harness.observability.providerEvents
    .find((event) => event.type === 'response').usage;
  changedUsage.localCostUsd += (1001 * 0.95) / 1_000_000;
  expensive.harness.efficiency.localCostUsd += (1001 * 0.95) / 1_000_000;
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

test('unknown billing is reported as reserved exposure rather than known spend', async () => {
  const steps = baseSteps({
    kimiPair: async (budget) => {
      budget.charge(0.25, 'known response');
      budget.reserve(4.75, 'ambiguous response');
      return pairOf('openrouter-kimi', 'pass', 'pass', {
        failureKind: 'provider',
        harness: { efficiency: { billingUncertain: true, billingComplete: false, costComplete: false } },
      });
    },
  });
  const { report } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  // `spentUsd` keeps its v1 meaning — TOTAL accounted exposure — so a v1-era
  // consumer can never read $0.25 while $4.75 of uncertain billing is
  // reserved; the reconciled/uncertain split lives in the explicit fields.
  assert.equal(report.budget.spentUsd, 5);
  assert.equal(report.budget.knownReconciledSpendUsd, 0.25);
  assert.equal(report.budget.uncertainReservedUsd, 4.75);
  assert.equal(report.budget.accountedExposureUsd, 5);
  assert.match(buildMarkdownReport(report), /reserved allowance is exposure, not known spend/i);
});

test('a one-shot harness win remains directional until independently confirmed', async () => {
  const { report } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ kimiPair: async () => pairOf('openrouter-kimi', 'fail', 'pass') }),
  });
  assert.equal(report.claim.level, 'inconclusive');
  assert.equal(report.claim.controlledWins, 1);
  assert.equal(report.claim.confirmedWins, 0);
  assert.equal(report.nativeProducts[0].host, 'codex-subscription');
});

test('a fresh same-task paired win confirms demonstrated value within the rerun allowance', async () => {
  let rerunCalls = 0;
  const { report } = await runRelease({
    config: CONFIG,
    steps: baseSteps({
      kimiPair: async () => pairOf('openrouter-kimi', 'fail', 'pass'),
      rerunKimiPair: async () => {
        rerunCalls += 1;
        return rerunPairOf('openrouter-kimi', 'fail', 'pass');
      },
    }),
  });
  assert.equal(rerunCalls, 1);
  assert.equal(report.claim.level, 'demonstrated-value');
  assert.equal(report.claim.controlledWins, 1);
  assert.equal(report.claim.confirmedWins, 1);
  assert.equal(report.pairs.find((pair) => pair.host === 'openrouter-kimi').reproduced, true);
});

test('win confirmation shares the hard ten-dollar release ceiling', async () => {
  const routineConfig = {
    ...CONFIG,
    budget: { releaseCeilingUsd: 10, kimiPairUsd: 8, rerunUsd: 2, reserveUsd: 2 },
  };
  const { report } = await runRelease({
    config: routineConfig,
    steps: baseSteps({
      environment: async () => ({
        ok: true,
        missing: [],
        providerSpendGuard: {
          verified: true,
          limitUsd: 10,
          limitRemainingUsd: 10,
          reset: null,
          checkedAt: '2026-07-31T00:00:00.000Z',
        },
      }),
      kimiPair: async (budget) => {
        budget.charge(8, 'all primary arms');
        const pair = pairOf('openrouter-kimi', 'fail', 'pass');
        setProviderReportedCost(pair.generic, 4);
        setProviderReportedCost(pair.harness, 4);
        return pair;
      },
      rerunKimiPair: async (budget) => {
        budget.charge(2, 'fresh paired confirmation');
        const pair = rerunPairOf('openrouter-kimi', 'fail', 'pass');
        setProviderReportedCost(pair.generic, 1);
        setProviderReportedCost(pair.harness, 1);
        return pair;
      },
    }),
  });
  assert.equal(report.budget.spentUsd, 10);
  assert.equal(report.budget.breached, false);
  assert.equal(report.claim.level, 'demonstrated-value');
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
      return rerunPairOf('openrouter-kimi', 'pass', 'fail');
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
    rerunKimiPair: async () => rerunPairOf('openrouter-kimi', 'pass', 'pass'),
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
    () => rerunPairOf('openrouter-kimi', 'pass', 'pass', { failureKind: 'provider' }),
    () => {
      const pair = rerunPairOf('openrouter-kimi', 'pass', 'pass');
      pair.harness.efficiency.costComplete = false;
      return pair;
    },
    () => {
      const pair = rerunPairOf('openrouter-kimi', 'pass', 'pass');
      pair.harness.observability.providerEvents.find((event) => event.type === 'response').provider = 'DeepInfra';
      return pair;
    },
    () => rerunPairOf('openrouter-kimi', 'pass', 'pass', { harness: { efficiency: { promptTokens: 2001 } } }),
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

test('a rerun for another task or without a fresh attempt identity cannot clear a regression', async () => {
  const invalidReruns = [
    rerunPairOf('openrouter-kimi', 'pass', 'pass', {
      task: 'build-pmars',
      generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
      harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
    }),
    pairOf('openrouter-kimi', 'pass', 'pass'),
    rerunPairOf('openrouter-kimi', 'pass', 'pass', { pairId: 'pair-1' }),
    rerunPairOf('openrouter-kimi', 'pass', 'pass', {
      harness: { reproducibility: { conditionHash: 'f'.repeat(64) } },
    }),
  ];

  for (const rerun of invalidReruns) {
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({
        kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail'),
        rerunKimiPair: async () => rerun,
      }),
    });
    const pair = report.pairs.find((entry) => entry.host === 'openrouter-kimi');
    assert.equal(pair.result, 'harness-regression');
    assert.equal(pair.reproduced, null);
    assert.equal(pair.rerun.causallyAttributable, false);
    assert.match(pair.rerun.reason, /identity/i);
    assert.equal(exitCode, 1);
  }
});

test('calibration keeps pair gates informational but can never green a release', async () => {
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail'),
    rerunKimiPair: async () => rerunPairOf('openrouter-kimi', 'pass', 'fail'),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, calibrationRelease: true });
  assert.equal(exitCode, 1);
  assert.equal(report.calibrationRelease, true);
  assert.equal(report.evaluationScope.mode, 'calibration');
  assert.equal(report.evaluationScope.releaseEligible, false);
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-kimi').gateActive, false);
  assert.ok(report.gate.reasons.some((reason) => /calibration.*not eligible/i.test(reason)));
});

test('a calibration baseline is recomputed from raw paired evidence and must demonstrate policy-clean value', async () => {
  const calibrationPair = {
    host: 'openrouter-kimi',
    task: 'cobol-modernization',
    pairId: 'pair-1',
    repetitionCount: 3,
    generic: repeatedRun('generic', 'fail'),
    harness: repeatedRun('harness', 'pass'),
    failureKind: null,
  };
  const { report } = await runRelease({
    config: CONFIG,
    calibrationRelease: true,
    releaseSha: 'abc123',
    harnessVersion: '0.5.0',
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({ kimiPair: async () => calibrationPair }),
  });
  report.evaluationScope.trust = {
    ok: true,
    status: 'attested',
    configuredStatus: 'attested',
    evidenceSource: 'runtime-observed',
    evidenceHash: 'e'.repeat(64),
    requiredCapabilities: [
      'fullHarborRuntimeClosureAttested',
      'keyBearingToolchainIsolated',
      'sandboxEntryChainAttested',
      'mountsObservedFromTrustedSupervisor',
      'escapedProcessesAndContainersReaped',
      'imageResourcesAndNetworkObserved',
    ],
    missingCapabilities: [],
  };
  const options = {
    evidenceHash: 'f'.repeat(64),
    releaseSha: 'abc123',
    harnessVersion: '0.5.0',
    requiredTaskSet: CONFIG.task.taskSet,
    minimumRepetitions: 3,
    minimumHarnessSolvedTasks: 1,
    efficiencyThresholds: CONFIG.efficiencyThresholds,
    valueThresholds: CONFIG.valueThresholds,
    controlledArmCeilingUsd: 0.65,
  };
  const valid = calibrationBaselineVerdict(report, options);
  assert.equal(valid.valid, true, valid.reasons.join('; '));
  assert.equal(valid.controlledWins, 1);

  const noValue = structuredClone(report);
  const pair = noValue.pairs.find((entry) => entry.host === 'openrouter-kimi');
  for (const trial of pair.generic.repetitions) {
    trial.correctness.verdict = 'pass';
    trial.correctness.verifierReward = 1;
  }
  pair.generic.correctness.verdict = 'pass';
  pair.generic.correctness.verifierReward = 1;
  assert.equal(calibrationBaselineVerdict(noValue, options).valid, false, 'policy-clean parity is not a value calibration');

  const unsafe = structuredClone(report);
  unsafe.pairs.find((entry) => entry.host === 'openrouter-kimi')
    .harness.repetitions[0].harnessBehavior.policyBypassAchieved = true;
  assert.equal(calibrationBaselineVerdict(unsafe, options).valid, false, 'raw safety evidence cannot be hidden by the saved summary');

  const variableRegression = structuredClone(report);
  const variableRegressionPair = variableRegression.pairs.find((entry) => entry.host === 'openrouter-kimi');
  variableRegressionPair.generic.repetitions[0].correctness = {
    ...variableRegressionPair.generic.repetitions[0].correctness,
    verdict: 'pass',
    verifierReward: 1,
  };
  variableRegressionPair.harness.repetitions[0].correctness = {
    ...variableRegressionPair.harness.repetitions[0].correctness,
    verdict: 'fail',
    verifierReward: 0,
  };
  const regressionVerdict = calibrationBaselineVerdict(variableRegression, options);
  assert.equal(regressionVerdict.valid, false, 'a majority must not hide a treatment-only calibration failure');
  assert.ok(regressionVerdict.reasons.some((reason) => /pass every Harness repetition/i.test(reason)));

  const variableCapability = structuredClone(report);
  const variableCapabilityPair = variableCapability.pairs.find((entry) => entry.host === 'openrouter-kimi');
  variableCapabilityPair.harness.repetitions[0].correctness = {
    ...variableCapabilityPair.harness.repetitions[0].correctness,
    verdict: 'fail',
    verifierReward: 0,
  };
  assert.equal(
    calibrationBaselineVerdict(variableCapability, options).valid,
    false,
    'initial-user calibration requires the Harness arm to pass every retained repetition'
  );

  const mismatchedCeiling = structuredClone(report);
  mismatchedCeiling.pairs.find((entry) => entry.host === 'openrouter-kimi')
    .harness.repetitions[0].reproducibility.trialCeilingUsd = 0.5;
  assert.equal(
    calibrationBaselineVerdict(mismatchedCeiling, options).valid,
    false,
    'calibration must use the same per-arm stopping budget as the routine condition'
  );

  const malformedTasks = structuredClone(report);
  malformedTasks.task.requiredTaskSet = [null, 'primitive-task-entry'];
  let malformedTaskVerdict;
  assert.doesNotThrow(() => {
    malformedTaskVerdict = calibrationBaselineVerdict(malformedTasks, options);
  });
  assert.equal(malformedTaskVerdict.valid, false);
  assert.ok(malformedTaskVerdict.reasons.some((reason) => /task identities do not match/i.test(reason)));
});

test('initial-user-ship readiness requires enough attributable Harness-solved tasks', async () => {
  const initialShip = {
    ...CONFIG,
    claimPolicy: { mode: 'initial-user-ship', minimumHarnessSolvedTasks: 2 },
  };
  const { report, exitCode } = await runRelease({
    config: initialShip,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({ kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass') }),
  });
  assert.equal(report.claim.level, 'bounded-overhead');
  assert.equal(report.readiness.ready, false);
  assert.equal(report.readiness.harnessSolvedTasks, 1);
  assert.equal(report.readiness.minimumHarnessSolvedTasks, 2);
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /does not establish demonstrated pre-user value/i.test(reason)));
  assert.ok(report.gate.reasons.some((reason) => /Harness solved 1.*2 required/i.test(reason)));
});

test('initial-user-ship parity is bounded overhead, not demonstrated user value', async () => {
  const initialShip = {
    ...CONFIG,
    claimPolicy: { mode: 'initial-user-ship', minimumHarnessSolvedTasks: 1 },
  };
  const { report, exitCode } = await runRelease({
    config: initialShip,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({ kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass') }),
  });
  assert.equal(report.claim.level, 'bounded-overhead');
  assert.equal(report.readiness.harnessSolvedTasks, 1);
  assert.equal(report.readiness.ready, false);
  assert.equal(exitCode, 1);
  assert.ok(report.readiness.reasons.some((reason) => /does not establish demonstrated pre-user value/i.test(reason)));
});

test('initial-user-ship all-fail and calibration evidence remain explicitly not ready', async () => {
  const initialShip = {
    ...CONFIG,
    claimPolicy: { mode: 'initial-user-ship', minimumHarnessSolvedTasks: 1 },
  };
  const allFail = await runRelease({
    config: initialShip,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({ kimiPair: async () => pairOf('openrouter-kimi', 'fail', 'fail') }),
  });
  assert.equal(allFail.report.claim.level, 'inconclusive');
  assert.equal(allFail.report.readiness.harnessSolvedTasks, 0);
  assert.equal(allFail.report.readiness.ready, false);
  assert.equal(allFail.exitCode, 1);

  const calibration = await runRelease({
    config: initialShip,
    calibrationRelease: true,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({ kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass') }),
  });
  assert.equal(calibration.report.evaluationScope.releaseEligible, true);
  assert.equal(calibration.report.readiness.ready, false);
  assert.ok(calibration.report.readiness.reasons.some((reason) => /fewer than 3 aligned calibration repetitions/i.test(reason)));
  assert.equal(calibration.exitCode, 1);
});

test('one qualifying three-repetition calibration is the initial ship decision within one release budget', async () => {
  const initialShip = {
    ...CONFIG,
    claimPolicy: {
      mode: 'initial-user-ship',
      minimumHarnessSolvedTasks: 1,
      requireCalibrationBaseline: false,
      minimumCalibrationRepetitions: 3,
    },
  };
  const pair = {
    host: 'openrouter-kimi',
    task: 'cobol-modernization',
    pairId: 'pair-1',
    repetitionCount: 3,
    generic: repeatedRun('generic', 'fail'),
    harness: repeatedRun('harness', 'pass'),
    failureKind: null,
  };
  const { report, exitCode } = await runRelease({
    config: initialShip,
    calibrationRelease: true,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({ kimiPair: async () => pair }),
  });
  assert.equal(report.evaluationScope.releaseEligible, true);
  assert.equal(report.claim.level, 'demonstrated-value');
  assert.equal(report.readiness.ready, true, report.readiness.reasons.join('; '));
  assert.equal(exitCode, 0);
});

test('rerun safety bypass and incomplete paid evidence still block during calibration', async () => {
  const safetyRerun = rerunPairOf('openrouter-kimi', 'pass', 'pass', {
    harness: { harnessBehavior: { policyBypassAchieved: true } },
  });
  const incompleteRerun = rerunPairOf('openrouter-kimi', 'pass', 'pass', {
    harness: { efficiency: { billingComplete: false, costComplete: false } },
  });

  for (const [rerun, reasonPattern] of [[safetyRerun, /safety.*rerun|rerun.*safety/i], [incompleteRerun, /telemetry/i]]) {
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({
        kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail'),
        rerunKimiPair: async () => rerun,
      }),
      calibrationRelease: true,
      requiredPairs: ['openrouter-kimi'],
    });
    assert.equal(exitCode, 1);
    assert.ok(report.gate.reasons.some((reason) => reasonPattern.test(reason)));
  }
});

test('a budget-exhausted treatment stays inconclusive but cannot green a required release', async () => {
  const steps = baseSteps({
    kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'fail', { harness: { correctness: { completedWithinBudget: false, exitReason: 'budget_exhausted' } } }),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-kimi').result, 'inconclusive-budget');
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /telemetry|required pair/i.test(reason)));
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

test('a throwing fresh-pair step preserves primary evidence and all charged spend in the report', async () => {
  const steps = baseSteps({
    kimiPair: async (budget) => {
      budget.charge(0.5, 'primary provider evidence');
      return pairOf('openrouter-kimi', 'pass', 'fail');
    },
    rerunKimiPair: async (budget) => {
      budget.charge(0.25, 'fresh-pair provider evidence before failure');
      throw new Error('sentinel rerun failure with private details');
    },
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  const kimi = report.pairs.find((pair) => pair.host === 'openrouter-kimi');
  assert.equal(exitCode, 1);
  assert.equal(report.budget.spentUsd, 0.75);
  assert.ok(kimi.generic && kimi.harness, 'the completed primary pair remains available');
  assert.equal(kimi.rerun.result, 'infrastructure-invalid');
  assert.equal(kimi.rerun.causallyAttributable, false);
  assert.match(kimi.rerun.failureDiagnostics[0].reasonHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(report).includes('private details'));
  assert.equal(validateAgainstSchema(report, REPORT_SCHEMA).ok, true);
});

test('provider and verifier failures are infrastructure-invalid, not model capability results', () => {
  const provider = classifyPair(pairOf('h', 'fail', 'fail', { failureKind: 'provider' }));
  assert.equal(provider.result, 'infrastructure-invalid');
  assert.match(provider.reason, /provider/);
  const verifier = classifyPair(pairOf('h', 'fail', 'fail', { failureKind: 'verifier' }));
  assert.equal(verifier.result, 'infrastructure-invalid');
  assert.match(verifier.reason, /verifier/);
});

test('zero aligned valid repetitions are infrastructure-invalid rather than ordinary variance', () => {
  const pair = pairOf('h', 'pass', 'pass');
  pair.generic.trialValidity = { valid: false, failureKind: 'infrastructure' };
  pair.harness.trialValidity = { valid: false, failureKind: 'infrastructure' };

  const classification = classifyPair(pair);
  assert.equal(classification.pairedOutcomes.pairedRepetitions, 0);
  assert.equal(classification.result, 'infrastructure-invalid');
  assert.match(classification.reason, /no valid aligned paired repetition evidence/i);
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

test('paid totals must reconcile exactly to retained response usage events', async () => {
  for (const mutate of [
    (doc) => { doc.efficiency.promptTokens += 1; },
    (doc) => { doc.efficiency.providerReportedCostUsd = null; },
    (doc) => { doc.efficiency.reconciledCostUsd = 0.001; },
    (doc) => { delete doc.efficiency.billingUncertain; },
    (doc) => { doc.observability.providerEvents.find((event) => event.type === 'response').usage.promptTokens += 1; },
    (doc) => {
      const usage = doc.observability.providerEvents.find((event) => event.type === 'response').usage;
      usage.localCostUsd += 0.0001;
      doc.efficiency.localCostUsd += 0.0001;
    },
    (doc) => { doc.reproducibility.billingProfileHash = 'f'.repeat(64); },
    (doc) => { doc.reproducibility.pricingCatalogCheckedAt = '1999-01-01'; },
  ]) {
    const pair = pairOf('openrouter-kimi', 'pass', 'pass');
    mutate(pair.harness);
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({ kimiPair: async () => pair }),
      requiredPairs: ['openrouter-kimi'],
    });
    assert.equal(exitCode, 1);
    assert.ok(report.gate.reasons.some((reason) => /telemetry/i.test(reason)));
  }
});

test('release spend must reconcile to the retained raw trial evidence', async () => {
  const pair = pairOf('openrouter-kimi', 'pass', 'pass');
  const steps = baseSteps();
  // Deliberately replace the wrapped fixture step: evidence claims provider
  // spend but the scheduler ledger receives no corresponding charge.
  steps.kimiPair = async () => pair;
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps,
    requiredPairs: ['openrouter-kimi'],
  });
  assert.equal(report.budget.knownReconciledSpendUsd, 0);
  assert.equal(report.budget.retainedReconciledSpendUsd, 0.04);
  assert.equal(report.budget.chargeLedgerMatchesRetainedEvidence, false);
  assert.equal(report.telemetryComplete, false);
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /charge ledger.*retained/i.test(reason)));
});

test('release spend reconciliation tolerates only scale-appropriate floating-point drift', async () => {
  const pair = pairOf('openrouter-kimi', 'pass', 'pass');
  setProviderReportedCost(pair.generic, 5);
  setProviderReportedCost(pair.harness, 5);
  const steps = baseSteps({
    kimiPair: async (budget) => {
      budget.charge(10 + 5e-12, 'floating-point fixture charge');
      return pair;
    },
  });
  const { report } = await runRelease({
    config: CONFIG,
    steps,
    requiredPairs: ['openrouter-kimi'],
  });
  assert.equal(report.budget.retainedReconciledSpendUsd, 10);
  assert.ok(Math.abs(report.budget.knownReconciledSpendUsd - 10) > 1e-12);
  assert.equal(report.budget.chargeLedgerMatchesRetainedEvidence, true);
});

test('a required pair without a closed attempt ledger or real workspace manifest cannot produce a green release', async () => {
  for (const harnessOverride of [
    { workspaceEvidence: { available: false, beforeManifestHash: null, afterManifestHash: null, diffHash: null } },
    { workspaceEvidence: { changedPaths: undefined, changedPathCount: 1 } },
    { observability: { providerAttemptsClosed: 4, unclosedProviderAttempts: 1 } },
    { observability: { uncorrelatedProviderTerminals: 1 } },
    { observability: { duplicateProviderAttemptIdentities: 1 } },
    { observability: { duplicateProviderTerminalIdentities: 1 } },
    { observability: { invalidProviderEventIdentities: 1 } },
    { observability: { uncorrelatedToolResults: 1 } },
    { observability: { unclosedToolCalls: 1 } },
    { observability: { duplicateToolCallIdentities: 1 } },
    { observability: { malformedToolCallEvidence: 1 } },
    { observability: { malformedToolResultEvidence: 1 } },
    { observability: { incompleteToolContainment: 1 } },
    { observability: { runtimeContractEvidence: { complete: true, matchesExpected: false } } },
  ]) {
    const steps = baseSteps({
      kimiPair: async () => pairOf('openrouter-kimi', 'pass', 'pass', { harness: harnessOverride }),
    });
    const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
    assert.equal(exitCode, 1);
    assert.ok(report.gate.reasons.some((reason) => /telemetry/i.test(reason)));
  }
});

test('the markdown renderer remains safe for a schema-valid legacy budget', () => {
  const report = {
    harnessVersion: '0.1.0',
    releaseSha: 'abc123',
    task: { datasetRef: 'terminal-bench@2.0', task: 'legacy-task' },
    calibrationRelease: false,
    deterministic: { passed: 1, failed: 0, skipped: 0 },
    coverage: { complete: true },
    pairs: [],
    nativeProducts: [],
    smokes: [],
    budget: { ceilingUsd: 10, spentUsd: 1, exhausted: false, reserveUsed: null },
    claim: { level: 'inconclusive', statement: 'legacy evidence' },
    gate: { block: false, reasons: [] },
    limitations: [],
  };
  const markdown = buildMarkdownReport(report);
  assert.match(markdown, /Cash-control semantics: legacy-unspecified/);
  assert.doesNotMatch(markdown, /BREACHED/);
});

test('agent-writable harness-event projection cannot select the causal denominator', async () => {
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
  assert.equal(exitCode, 0);
  assert.equal(report.pairs[0].causallyAttributable, true);
  assert.equal(report.claim.level, 'bounded-overhead');
});

test('a multi-task pair step yields one report entry per task, each classified independently', async () => {
  const steps = baseSteps({
    kimiPair: async () => [
      pairOf('openrouter-kimi', 'pass', 'pass'),
      pairOf('openrouter-kimi', 'fail', 'pass', {
        task: 'build-pmars',
        pairId: 'pair-build-pmars',
        generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
        harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
      }),
    ],
  });
  const { report, exitCode } = await runRelease({ config: MULTI_TASK_CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  const kimi = report.pairs.filter((p) => p.host === 'openrouter-kimi');
  assert.equal(kimi.length, 2);
  assert.equal(kimi.find((p) => p.task === 'cobol-modernization').result, 'parity');
  assert.equal(kimi.find((p) => p.task === 'build-pmars').result, 'harness-win');
  assert.equal(exitCode, 0);
});

test('required task-set coverage blocks missing, duplicate, and unexpected controlled tasks', async () => {
  const buildPair = () => pairOf('openrouter-kimi', 'pass', 'pass', {
    task: 'build-pmars',
    pairId: 'pair-build-pmars',
    generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
    harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
  });
  const cases = [
    [
      pairOf('openrouter-kimi', 'pass', 'pass'),
    ],
    [
      pairOf('openrouter-kimi', 'pass', 'pass'),
      pairOf('openrouter-kimi', 'pass', 'pass', { pairId: 'duplicate-pair' }),
      buildPair(),
    ],
    [
      pairOf('openrouter-kimi', 'pass', 'pass'),
      buildPair(),
      pairOf('openrouter-kimi', 'pass', 'pass', { task: 'not-in-lock', pairId: 'unexpected-pair' }),
    ],
  ];

  for (const pairs of cases) {
    const { report, exitCode } = await runRelease({
      config: MULTI_TASK_CONFIG,
      steps: baseSteps({ kimiPair: async () => pairs }),
      requiredPairs: ['openrouter-kimi'],
    });
    assert.equal(report.coverage.complete, false);
    assert.equal(report.claim.level, 'inconclusive');
    assert.ok(report.gate.reasons.some((reason) => /coverage/i.test(reason)));
    assert.equal(exitCode, 1);
  }
});

test('a regression on one task reruns and gates ONLY that task', async () => {
  let rerunTasks = [];
  const steps = baseSteps({
    kimiPair: async () => [
      pairOf('openrouter-kimi', 'pass', 'pass'),
      pairOf('openrouter-kimi', 'pass', 'fail', {
        task: 'build-pmars',
        pairId: 'pair-build-pmars',
        generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
        harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
      }),
    ],
    rerunKimiPair: async (budget, task) => {
      rerunTasks.push(task);
      return rerunPairOf('openrouter-kimi', 'pass', 'fail', {
        task,
        pairId: 'pair-build-pmars-rerun',
        generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
        harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
      });
    },
  });
  const { report, exitCode } = await runRelease({ config: MULTI_TASK_CONFIG, steps, requiredPairs: ['openrouter-kimi'] });
  assert.deepEqual(rerunTasks, ['build-pmars'], 'only the regressed task is rerun');
  const regressed = report.pairs.find((p) => p.task === 'build-pmars');
  assert.equal(regressed.result, 'harness-regression');
  assert.equal(regressed.reproduced, true);
  assert.equal(report.pairs.find((p) => p.task === 'cobol-modernization').result, 'parity');
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /build-pmars/.test(r)), 'the gate reason names the task');
});

test('a later regression has rerun priority over an earlier directional win', async () => {
  const rerunTasks = [];
  const buildRegression = pairOf('openrouter-kimi', 'pass', 'fail', {
    task: 'build-pmars',
    pairId: 'pair-build-regression',
    generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
    harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
  });
  const { report, exitCode } = await runRelease({
    config: MULTI_TASK_CONFIG,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({
      kimiPair: async () => [pairOf('openrouter-kimi', 'fail', 'pass'), buildRegression],
      rerunKimiPair: async (budget, task) => {
        rerunTasks.push(task);
        return rerunPairOf('openrouter-kimi', 'pass', 'fail', {
          task,
          pairId: 'pair-build-regression-rerun',
          generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
          harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
        });
      },
    }),
  });
  assert.deepEqual(rerunTasks, ['build-pmars']);
  assert.equal(report.pairs.find((pair) => pair.task === 'cobol-modernization').reproduced, null);
  assert.equal(report.claim.level, 'regression');
  assert.equal(exitCode, 1);
});

test('multiple regressions share one exceptional fresh-pair allowance', async () => {
  const rerunTasks = [];
  const buildRegression = pairOf('openrouter-kimi', 'pass', 'fail', {
    task: 'build-pmars',
    pairId: 'pair-build-second-regression',
    generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
    harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
  });
  const { report, exitCode } = await runRelease({
    config: MULTI_TASK_CONFIG,
    requiredPairs: ['openrouter-kimi'],
    steps: baseSteps({
      kimiPair: async () => [pairOf('openrouter-kimi', 'pass', 'fail'), buildRegression],
      rerunKimiPair: async (budget, task) => {
        rerunTasks.push(task);
        return rerunPairOf('openrouter-kimi', 'pass', 'fail', { task });
      },
    }),
  });
  assert.deepEqual(rerunTasks, ['cobol-modernization']);
  const second = report.pairs.find((pair) => pair.task === 'build-pmars');
  assert.equal(second.result, 'harness-regression');
  assert.equal(second.reproduced, null);
  assert.match(second.reason, /one exceptional rerun allowance was already used/i);
  assert.equal(report.claim.regressions, 2);
  assert.equal(exitCode, 1);
});

test('the markdown eval card names the full task set, verdicts, spend, claim, and comparison limitations', async () => {
  const steps = baseSteps({
    kimiPair: async () => [
      pairOf('openrouter-kimi', 'pass', 'pass', { task: 'cobol-modernization' }),
      pairOf('openrouter-kimi', 'pass', 'pass', {
        task: 'build-pmars',
        pairId: 'pair-build-pmars',
        generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
        harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
      }),
    ],
  });
  const { report } = await runRelease({ config: MULTI_TASK_CONFIG, steps, releaseSha: 'abc123', harnessVersion: '0.5.0' });
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
