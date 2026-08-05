import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
  runReleaseCli,
  releaseTrustVerdict,
  releaseRuntimeArmingVerdict,
  runtimeReadinessVerdict,
  providerReconciliationVerdict,
  canonicalReleaseRuntimeTaskLock,
  validateOfflineReleaseDataset,
  releaseBudgetPolicyHash,
  prepareReleaseRuntimeArtifacts,
  calibrationBaselineVerdict,
  validateReleasePolicyConfig,
  releaseInvocationPolicy,
  releaseMinimumCalibrationRepetitions,
  releaseRepetitionCount,
  releaseScheduledExposure,
  scaleReleaseBudget,
  controlledLaneOf,
  qualificationBaselineVerdict,
  makeReleaseTreeRemovable,
  reservePrivateReport,
  writeReservedPrivateReport,
  closePrivateReportReservation,
  shouldRetainReleaseWorkDir,
  writePrivateReport,
  readPrivateEvidenceFile,
} from '../../../evals/release.mjs';
import { billingProfileHash, getProfile } from '../../../evals/lib/model-profiles.mjs';
import {
  evaluateProviderSpendEvidence,
  resolveProviderSpendPolicy,
} from '../../../evals/lib/provider-spend-policy.mjs';
import {
  canonicalJson,
  canonicalSha256,
  protocolDocumentHash,
} from '../../../evals/runtime/protocol.mjs';
import { controlledProviderBrokerStaticPolicyHash } from '../../../evals/runtime/controlled-provider-policy.mjs';
import { createGenuineRuntimeSession } from './support/runtime-session-fixture.mjs';

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const REPORT_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-report.v2.schema.json', import.meta.url), 'utf8'));
const YAML = createRequire(import.meta.url)('yaml');

test('provider spend policy normalization has one explicit legacy boundary', () => {
  const legacy = resolveProviderSpendPolicy({
    evaluationMode: 'calibration',
    ceilingUsd: 18.7,
    configuredHardLimitUsd: null,
  });
  assert.equal(legacy.evaluationMode, 'release');
  assert.equal(legacy.hardLimitUsd, 18.7);
  assert.equal(legacy.hardLimitSource, 'legacy-release-ceiling');
  assert.equal(legacy.compatibilityFallback, true);

  const qualification = resolveProviderSpendPolicy({
    evaluationMode: 'qualification',
    ceilingUsd: 1.3,
    configuredHardLimitUsd: 20,
  });
  assert.equal(qualification.evaluationMode, 'qualification');
  assert.equal(qualification.hardLimitUsd, 20);
  assert.equal(qualification.hardLimitSource, 'configured');
  assert.equal(qualification.compatibilityFallback, false);

  const calibration = resolveProviderSpendPolicy({
    evaluationMode: 'calibration',
    ceilingUsd: 18.7,
    configuredHardLimitUsd: 20,
    expectedQualificationFingerprint: '9'.repeat(64),
  });
  assert.equal(calibration.evaluationMode, 'calibration');
  assert.equal(calibration.requireFreshAllowance, false);
  assert.equal(calibration.ok, true);

  const calibrationWithoutFingerprint = resolveProviderSpendPolicy({
    evaluationMode: 'calibration',
    ceilingUsd: 18.7,
    configuredHardLimitUsd: 20,
  });
  assert.equal(calibrationWithoutFingerprint.ok, false);
  assert.ok(
    calibrationWithoutFingerprint.errors.some((reason) => /qualification credential fingerprint.*missing/i.test(reason))
  );
  assert.equal(evaluateProviderSpendEvidence({
    policy: calibrationWithoutFingerprint,
    keyFingerprint: '8'.repeat(64),
    observed: { limitUsd: 20, limitRemainingUsd: 18.7, reset: null },
  }).ok, false, 'an observed credential cannot replace the accepted qualification fingerprint');

  const insufficient = resolveProviderSpendPolicy({
    evaluationMode: 'release',
    ceilingUsd: 10,
    configuredHardLimitUsd: 9,
  });
  assert.equal(insufficient.ok, false);
  assert.ok(insufficient.errors.some((reason) => /below the scheduled ceiling/i.test(reason)));
  assert.equal(evaluateProviderSpendEvidence({
    policy: insufficient,
    observed: { limitUsd: 9, limitRemainingUsd: 9, reset: null },
  }).ok, false);

  const invalidMode = resolveProviderSpendPolicy({
    evaluationMode: 'preview',
    ceilingUsd: 1.3,
    configuredHardLimitUsd: 20,
  });
  assert.equal(invalidMode.ok, false);
  assert.ok(invalidMode.errors.some((reason) => /evaluation mode.*invalid|unsupported/i.test(reason)));
});

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

test('imported baseline evidence must remain a private singly linked file owned by the operator', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-private-evidence-'));
  const report = path.join(root, 'qualification.json');
  fs.writeFileSync(report, '{"schema":"fixture"}\n', { mode: 0o600 });
  assert.equal(readPrivateEvidenceFile(report, 'qualification baseline').toString('utf8'), '{"schema":"fixture"}\n');

  fs.chmodSync(report, 0o644);
  assert.throws(
    () => readPrivateEvidenceFile(report, 'qualification baseline'),
    /must not be accessible by group or other users/i
  );
  fs.chmodSync(report, 0o600);

  const alias = path.join(root, 'qualification-alias.json');
  fs.linkSync(report, alias);
  assert.throws(
    () => readPrivateEvidenceFile(report, 'qualification baseline'),
    /singly linked/i
  );
  fs.unlinkSync(alias);

  const symbolic = path.join(root, 'qualification-symlink.json');
  fs.symlinkSync(report, symbolic);
  assert.throws(
    () => readPrivateEvidenceFile(symbolic, 'qualification baseline'),
    /non-symlink regular file/i
  );
  fs.unlinkSync(symbolic);
  fs.unlinkSync(report);
  fs.rmdirSync(root);
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
  controlledLane: { host: 'openrouter-controlled', profileId: 'kimi-k2.7-code' },
  evaluationScope: TRUSTED_SCOPE,
  budget: { releaseCeilingUsd: 10, controlledPairUsd: 8, rerunUsd: 2 },
  task: {
    datasetRef: 'terminal-bench@2.0',
    verifierPassingReward: 1,
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

const CONTROLLED_CONFIG = {
  ...CONFIG,
  controlledLane: { host: 'openrouter-controlled', profileId: 'kimi-k2.7-code' },
  budget: { releaseCeilingUsd: 10, controlledPairUsd: 8.4, rerunUsd: 1.6 },
};

const LEGACY_KIMI_CONFIG = {
  ...CONFIG,
  controlledLane: { host: 'openrouter-kimi', profileId: 'kimi-k2.7-code' },
  budget: { releaseCeilingUsd: 10, kimiPairUsd: 8, rerunUsd: 2 },
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

function completeEconomicsFor(efficiency) {
  const totals = {
    logicalRequests: efficiency.modelRequests,
    usageRecords: efficiency.providerResponses,
    promptTokens: efficiency.promptTokens,
    cachedPromptTokens: efficiency.cachedPromptTokens,
    reasoningTokens: efficiency.reasoningTokens,
    outputTokens: efficiency.outputTokens,
    localCostUsd: efficiency.localCostUsd,
    providerReportedCostUsd: efficiency.providerReportedCostUsd,
    reconciledCostUsd: efficiency.reconciledCostUsd,
    promptTokensComplete: true,
    cachedPromptTokensComplete: true,
    reasoningTokensComplete: true,
    outputTokensComplete: true,
    localCostUsdComplete: true,
    providerReportedCostUsdComplete: true,
    reconciledCostUsdComplete: true,
  };
  const emptyPhase = {
    status: 'not_exercised',
    logicalRequests: 0,
    usageRecords: 0,
    promptTokens: null,
    cachedPromptTokens: null,
    reasoningTokens: null,
    outputTokens: null,
    localCostUsd: null,
    providerReportedCostUsd: null,
    reconciledCostUsd: null,
    promptTokensComplete: false,
    cachedPromptTokensComplete: false,
    reasoningTokensComplete: false,
    outputTokensComplete: false,
    localCostUsdComplete: false,
    providerReportedCostUsdComplete: false,
    reconciledCostUsdComplete: false,
  };
  const phaseNames = [
    'memory-retrieval', 'memory-construction', 'memory-consolidation', 'guidance',
    'planning-and-gate', 'verification', 'orientation', 'implementation',
    'finalization', 'uncategorized', 'mixed', 'unknown',
  ];
  const taskPhaseNames = phaseNames.filter((name) => !name.startsWith('memory-'));
  const phases = Object.fromEntries(phaseNames.map((name) => [name, structuredClone(emptyPhase)]));
  phases.finalization = { status: 'measured', ...totals };
  return {
    coverage: {
      status: 'complete',
      complete: true,
      requestEvents: efficiency.modelRequests,
      usageEvents: efficiency.providerResponses,
      matchedUsageEvents: efficiency.providerResponses,
      reason: null,
    },
    prompt: {
      manifest: {
        schema: 'prompt-component-manifest.v1',
        complete: true,
        separator: '\n\n',
        systemPromptChars: 1,
        systemPromptBytes: 1,
        systemPromptHash: '3'.repeat(64),
        components: [{
          id: 'neutral-system', ordinal: 0, startChar: 0, endChar: 1,
          chars: 1, bytes: 1, sha256: '3'.repeat(64),
        }],
      },
      coverage: {
        complete: true,
        requests: efficiency.modelRequests,
        requestsWithCompleteBuckets: efficiency.modelRequests,
      },
      cumulative: {
        payloadChars: efficiency.requestPayloadChars,
        baseSystemChars: 1000,
        instructionChars: 500,
        durableStateChars: 0,
        assistantHistoryChars: 1000,
        toolResultHistoryChars: 500,
        otherMessageChars: 0,
        messageEnvelopeChars: 200,
        toolSchemaChars: 400,
        payloadEnvelopeChars: 400,
        toolResultHistoryBySource: {},
      },
    },
    phases,
    rollups: { 'task-execution': { status: 'measured', ...totals, derivedFrom: taskPhaseNames } },
    totals,
    reconciliation: {
      complete: true,
      checks: {
        modelRequests: true,
        promptTokens: true,
        cachedPromptTokens: true,
        outputTokens: true,
        localCostUsd: true,
        providerReportedCostUsd: true,
        reconciledCostUsd: true,
      },
      reason: null,
    },
  };
}

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
      pricingCatalogCheckedAt: '2026-08-05',
      modelRequested: 'moonshotai/kimi-k2.7-code',
      modelResolved: 'moonshotai/kimi-k2.7-code-20260612',
      providerResolved: 'Moonshot AI',
      providerRequestedOrder: ['moonshotai/int4'],
      providerExpectedResolvedNames: ['Moonshot AI'],
      attribution: { responseCount: 5, complete: true, fallbackDetected: false },
      host: 'openrouter-controlled',
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
    trialValidity: { valid: true, failureKind: null },
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
  if (!Object.hasOwn(over, 'economics')) doc.economics = completeEconomicsFor(doc.efficiency);
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
  doc.economics = completeEconomicsFor(doc.efficiency);
  return doc;
}

function asLocalGemmaRun(doc) {
  const profile = getProfile('gemma-4-26b-local');
  doc.reproducibility = {
    ...doc.reproducibility,
    modelProfileId: profile.id,
    billingProfileHash: billingProfileHash(profile.id),
    pricingCatalogCheckedAt: profile.catalogPin?.checkedAt ?? null,
    modelRequested: profile.model,
    modelResolved: profile.model,
    providerResolved: null,
    providerRequestedOrder: null,
    providerExpectedResolvedNames: null,
    host: 'ollama-gemma',
    reasoningConfig: profile.reasoning,
  };
  for (const event of doc.observability.providerEvents) {
    if (event.type !== 'response') continue;
    event.model = profile.model;
    event.provider = null;
    event.billingStatus = 'confirmed_unbilled';
    event.usage.localCostUsd = 0;
    event.usage.reconciledCostUsd = 0;
    delete event.usage.providerCostUsd;
  }
  doc.efficiency = {
    ...doc.efficiency,
    providerReportedCostUsd: null,
    localCostUsd: 0,
    reconciledCostUsd: 0,
    providerCostComplete: true,
    billingComplete: true,
    costComplete: true,
    billingUncertain: false,
  };
  doc.economics = completeEconomicsFor(doc.efficiency);
  for (const bucket of [
    doc.economics.totals,
    doc.economics.phases.finalization,
    doc.economics.rollups['task-execution'],
  ]) {
    bucket.providerReportedCostUsd = null;
    bucket.providerReportedCostUsdComplete = false;
  }
  delete doc.economics.reconciliation.checks.providerReportedCostUsd;
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

function repeatedPairOf(host, genericVerdict, harnessVerdict, count = 1, over = {}) {
  const pair = pairOf(host, genericVerdict, harnessVerdict, { ...over, repetitionCount: count });
  for (const [condition, verdict] of [['generic', genericVerdict], ['harness', harnessVerdict]]) {
    const aggregate = repeatedRun(condition, verdict, count);
    for (const document of [aggregate, ...aggregate.repetitions]) {
      document.reproducibility.host = host;
      document.reproducibility.taskId = pair.task;
      document.reproducibility.pairId = pair.pairId;
      document.reproducibility.attempt = over.attempt ?? 'a';
    }
    pair[condition] = aggregate;
  }
  return pair;
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
        limitUsd: 10,
        limitRemainingUsd: 10,
        reset: null,
        ceilingUsd: 10,
        checkedAt: '2026-07-31T00:00:00.000Z',
      },
    }),
    taskLock: async () => ({ ok: true, reason: '' }),
    nativeProducts: async () => [{ host: 'codex-subscription', status: 'pass', telemetryAvailable: false }],
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass'),
    gemmaPair: async () => pairOf('ollama-gemma', 'fail', 'fail'),
    smokes: async () => [{ host: 'copilot-smoke', ok: true, failed: [] }],
    ...overrides,
  };
  const retainedCost = (result) => (Array.isArray(result) ? result : [result])
    .filter(Boolean)
    .flatMap((pair) => [pair.generic, pair.harness])
    .filter(Boolean)
    .flatMap((doc) => Array.isArray(doc.repetitions) && doc.repetitions.length ? doc.repetitions : [doc])
    .reduce((total, doc) => total + (
      Number.isSafeInteger(doc.observability?.runtimeTrustEvidence?.providerSpendMicrousd)
        ? doc.observability.runtimeTrustEvidence.providerSpendMicrousd / 1_000_000
        : Number.isFinite(doc.efficiency?.reconciledCostUsd)
          ? doc.efficiency.reconciledCostUsd
          : 0
    ), 0);
  for (const name of ['controlledPair', 'rerunControlledPair', 'kimiPair', 'rerunKimiPair']) {
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

test('correction-effort vocabulary: nullable fields validate, wrong types fail, absence stays legal', () => {
  // AC3 schema half: autonomous canary trials record null for every field;
  // subscription-host A/Bs and future session telemetry fill them in without
  // needing a schema v2. Never estimated — null or measured, nothing between.
  const doc = fullRun('generic', 'pass');
  doc.correctionEffort = { humanInterventions: null, correctionTurns: null, interventionTokens: null };
  assert.deepEqual(validateAgainstSchema(doc, RUN_SCHEMA).errors, []);

  doc.correctionEffort = { humanInterventions: 2, correctionTurns: 5, interventionTokens: 1200 };
  assert.deepEqual(validateAgainstSchema(doc, RUN_SCHEMA).errors, [], 'measured values validate');

  doc.correctionEffort = { humanInterventions: 'several', correctionTurns: null, interventionTokens: null };
  const invalid = validateAgainstSchema(doc, RUN_SCHEMA);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((e) => e.includes('correctionEffort.humanInterventions')));

  const legacy = fullRun('generic', 'pass');
  delete legacy.correctionEffort;
  assert.deepEqual(validateAgainstSchema(legacy, RUN_SCHEMA).errors, [], 'pre-vocabulary documents remain valid');
});

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

test('economics schema rejects incomplete nested evidence while legacy documents remain readable', () => {
  const complete = fullRun('generic', 'pass');
  assert.equal(validateAgainstSchema(complete, RUN_SCHEMA).ok, true);

  for (const mutate of [
    (run) => { delete run.economics.phases; },
    (run) => { delete run.economics.prompt.coverage.requests; },
    (run) => { run.economics.phases.finalization.promptTokensComplete = 'yes'; },
  ]) {
    const malformed = fullRun('generic', 'pass');
    mutate(malformed);
    const verdict = validateAgainstSchema(malformed, RUN_SCHEMA);
    assert.equal(verdict.ok, false, verdict.errors.join('; '));
  }

  const legacy = fullRun('generic', 'pass');
  delete legacy.economics;
  assert.equal(validateAgainstSchema(legacy, RUN_SCHEMA).ok, true, 'economics stays optional for stored v1 compatibility');
});

test('release trust requires branded runtime evidence in addition to configured intent', async () => {
  const capabilityNames = [
    'fullHarborRuntimeClosureAttested',
    'keyBearingToolchainIsolated',
    'sandboxEntryChainAttested',
    'mountsObservedFromTrustedSupervisor',
    'escapedProcessesAndContainersReaped',
    'imageResourcesAndNetworkObserved',
  ];
  const all = Object.fromEntries(capabilityNames.map((name) => [name, true]));
  const releaseSha = 'a'.repeat(40);
  const genuine = await createGenuineRuntimeSession({ releaseSha });
  const evidence = genuine.controller.finalize();

  assert.equal(releaseTrustVerdict({ releaseTrust: { status: 'blocked', capabilities: all } }, evidence).ok, false);
  assert.equal(releaseTrustVerdict({ releaseTrust: { status: 'attested', capabilities: all } }).ok, false,
    'YAML booleans alone are never an attestation');
  const verdict = releaseTrustVerdict(
    { releaseTrust: { status: 'attested', capabilities: all } },
    evidence,
    { releaseSha, expectedTrialHashes: genuine.attestationHashes }
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.evidenceHash, protocolDocumentHash(evidence));
  assert.equal(
    releaseTrustVerdict(
      { releaseTrust: { status: 'attested', capabilities: all } },
      structuredClone(evidence),
      { releaseSha, expectedTrialHashes: genuine.attestationHashes }
    ).ok,
    false,
    'copying valid JSON does not preserve the private runtime brand'
  );

  for (const missingCapability of capabilityNames) {
    const partial = { ...all, [missingCapability]: false };
    const partialVerdict = releaseTrustVerdict(
      { releaseTrust: { status: 'attested', capabilities: partial } },
      evidence,
      { releaseSha, expectedTrialHashes: genuine.attestationHashes }
    );
    assert.equal(partialVerdict.ok, false, missingCapability);
    assert.deepEqual(partialVerdict.missingCapabilities, [missingCapability]);
  }
});

test('runtime arming is code-owned configuration intent, never initial final trust', () => {
  const releaseTrust = {
    status: 'attested',
    capabilities: Object.fromEntries([
      'fullHarborRuntimeClosureAttested',
      'keyBearingToolchainIsolated',
      'sandboxEntryChainAttested',
      'mountsObservedFromTrustedSupervisor',
      'escapedProcessesAndContainersReaped',
      'imageResourcesAndNetworkObserved',
    ].map((name) => [name, true])),
  };
  const configured = { releaseTrust };
  assert.equal(releaseRuntimeArmingVerdict(configured).ok, true);
  assert.equal(releaseRuntimeArmingVerdict(configured).status, 'armed');
  assert.equal(releaseTrustVerdict(configured, null).ok, false);
  assert.equal(releaseTrustVerdict(configured, null).status, 'blocked');
});

test('the canonical release runtime lock drops sourceImage without weakening the exact sandbox contract', () => {
  const original = {
    schema: 'terminal-bench-task-lock.v1',
    datasetRef: 'terminal-bench@2.0',
    verifier: { passingReward: 1 },
    tasks: [{
      task: 'cobol-modernization',
      role: 'anchor',
      taskChecksum: 'a'.repeat(64),
      sandbox: { ...SANDBOX_LOCK },
    }],
  };
  const projected = canonicalReleaseRuntimeTaskLock(original);
  assert.deepEqual(Object.keys(projected.tasks[0].sandbox).sort(), [
    'cpus', 'imageId', 'immutableImage', 'memoryMb', 'platform', 'storageMb',
  ]);
  assert.equal(Object.hasOwn(projected.tasks[0].sandbox, 'sourceImage'), false);
  assert.equal(original.tasks[0].sandbox.sourceImage, SANDBOX_LOCK.sourceImage, 'projection does not mutate the lock');
});

test('release budget identity is independent and changes only with its economic policy inputs', () => {
  const input = {
    evaluationMode: 'release',
    controlledLane: { host: 'openrouter-controlled', profileId: 'kimi-k2.7-code' },
    budget: {
      releaseCeilingUsd: 10,
      controlledPairUsd: 8,
      rerunUsd: 2,
      controlledArmCeilingUsd: 0.65,
      providerHardLimitUsd: 10,
    },
    repetitions: 1,
    taskCount: 4,
  };
  const first = releaseBudgetPolicyHash(input);
  const same = releaseBudgetPolicyHash(structuredClone(input));
  const changed = releaseBudgetPolicyHash({
    ...input,
    budget: { ...input.budget, rerunUsd: 1.9 },
  });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, changed);
});

test('controller readiness can arm per-trial execution but can never stand in for final release trust', async () => {
  const releaseSha = 'a'.repeat(40);
  const configured = {
    releaseTrust: {
      status: 'attested',
      capabilities: Object.fromEntries([
        'fullHarborRuntimeClosureAttested',
        'keyBearingToolchainIsolated',
        'sandboxEntryChainAttested',
        'mountsObservedFromTrustedSupervisor',
        'escapedProcessesAndContainersReaped',
        'imageResourcesAndNetworkObserved',
      ].map((name) => [name, true])),
    },
  };
  const genuine = await createGenuineRuntimeSession({ releaseSha });
  const readiness = genuine.controller.readiness();
  assert.equal(runtimeReadinessVerdict(configured, readiness, { releaseSha }).ok, true);
  assert.equal(releaseTrustVerdict(configured, readiness).ok, false, 'controller readiness is never final evidence');
  assert.equal(runtimeReadinessVerdict(configured, structuredClone(readiness), { releaseSha }).ok, false,
    'a plain JSON projection cannot arm provider execution');
  const wrongIdentity = await createGenuineRuntimeSession({ releaseSha: 'b'.repeat(40), sessionId: 'wrong-release' });
  assert.equal(runtimeReadinessVerdict(configured, wrongIdentity.controller.readiness(), { releaseSha }).ok, false);
});

function runtimeSecuredConfig(overrides = {}) {
  const capabilities = Object.fromEntries([
    'fullHarborRuntimeClosureAttested',
    'keyBearingToolchainIsolated',
    'sandboxEntryChainAttested',
    'mountsObservedFromTrustedSupervisor',
    'escapedProcessesAndContainersReaped',
    'imageResourcesAndNetworkObserved',
  ].map((name) => [name, true]));
  return {
    ...CONFIG,
    runtimeTrustRequired: true,
    releaseTrust: { status: 'attested', capabilities },
    ...overrides,
  };
}

function reconciledProviderEvidence(sessionSpentMicrousd = 200) {
  return {
    schema: 'engineer-release-provider-reconciliation.v1',
    verified: true,
    keyFingerprint: 'f'.repeat(64),
    preflightRemainingMicrousd: 20_000_000,
    postflightRemainingMicrousd: 20_000_000 - sessionSpentMicrousd,
    observedAllowanceDeltaMicrousd: sessionSpentMicrousd,
    sessionSpentMicrousd,
    differenceMicrousd: 0,
    toleranceMicrousd: 2,
  };
}

test('provider postflight evidence is recomputed from retained integer allowance facts', () => {
  const valid = reconciledProviderEvidence(200);
  assert.equal(providerReconciliationVerdict(valid, { expectedSessionSpentMicrousd: 200 }).verified, true);
  const splitLedger = providerReconciliationVerdict(valid, {
    runtimeSessionSpentMicrousd: 200,
    retainedTrialSpentMicrousd: 199,
    schedulerSpentMicrousd: 200,
  });
  assert.equal(splitLedger.verified, false);
  assert.equal(splitLedger.runtimeRetainedSchedulerMatched, false);
  assert.equal(splitLedger.reason, 'session-spend-mismatch');
  assert.equal(providerReconciliationVerdict(
    { ...valid, observedAllowanceDeltaMicrousd: 199 },
    { expectedSessionSpentMicrousd: 200 }
  ).reason, 'allowance-arithmetic-mismatch');
  assert.equal(providerReconciliationVerdict(
    { ...valid, sessionSpentMicrousd: 199, differenceMicrousd: 1 },
    { expectedSessionSpentMicrousd: 200 }
  ).reason, 'session-spend-mismatch');
  assert.equal(providerReconciliationVerdict(
    { ...valid, postflightRemainingMicrousd: 19_999_797, observedAllowanceDeltaMicrousd: 203,
      differenceMicrousd: 3 },
    { expectedSessionSpentMicrousd: 200 }
  ).reason, 'tolerance-exceeded');
});

test('final release trust compares every session identity and the exact session ceiling', async () => {
  const releaseSha = 'a'.repeat(40);
  const runtime = await createGenuineRuntimeSession({ releaseSha, sessionId: 'all-final-bindings' });
  const evidence = runtime.controller.finalize();
  const config = runtimeSecuredConfig();
  const expected = {
    releaseSha,
    profileId: 'economical-small-model',
    taskLockHash: '1'.repeat(64),
    bundleHash: '2'.repeat(64),
    budgetId: 'qualification-budget-1',
    budgetPolicyHash: '3'.repeat(64),
    brokerPolicyHash: '0'.repeat(64),
  };
  const options = {
    releaseSha,
    expectedTrialHashes: runtime.attestationHashes,
    expectedSessionId: 'all-final-bindings',
    expectedBindings: expected,
    expectedSessionCeilingMicrousd: 1_300_000,
  };
  assert.equal(releaseTrustVerdict(config, evidence, options).ok, true);
  for (const field of Object.keys(expected)) {
    const drifted = {
      ...options,
      expectedBindings: { ...expected, [field]: field === 'releaseSha' ? 'b'.repeat(40) : `wrong-${field}` },
    };
    const verdict = releaseTrustVerdict(config, evidence, drifted);
    assert.equal(verdict.ok, false, field);
    assert.equal(verdict.bindingsMatched, false, field);
  }
  assert.equal(releaseTrustVerdict(config, evidence, {
    ...options,
    expectedSessionId: 'another-session',
  }).sessionIdMatched, false);
  assert.equal(releaseTrustVerdict(config, evidence, {
    ...options,
    expectedSessionCeilingMicrousd: 1_299_999,
  }).sessionBudgetMatched, false);
});

function pairWithRuntimeEvidence(hashes, generic = 'pass', harness = 'pass', {
  reconciledCostUsd = 0.0001,
  providerSpendMicrousd = 100,
} = {}) {
  const pair = pairOf('openrouter-controlled', generic, harness);
  for (const [doc, evidenceHash] of [[pair.generic, hashes[0]], [pair.harness, hashes[1]]]) {
    const responses = doc.observability.providerEvents.filter((event) => event.type === 'response');
    for (const response of responses) {
      response.usage.localCostUsd = reconciledCostUsd / responses.length;
      response.usage.providerCostUsd = reconciledCostUsd / responses.length;
      response.usage.reconciledCostUsd = reconciledCostUsd / responses.length;
    }
    doc.efficiency.localCostUsd = reconciledCostUsd;
    doc.efficiency.providerReportedCostUsd = reconciledCostUsd;
    doc.efficiency.reconciledCostUsd = reconciledCostUsd;
    doc.economics = completeEconomicsFor(doc.efficiency);
    doc.observability ??= {};
    doc.observability.runtimeTrustEvidence = {
      schema: 'engineer-runtime-trial-final-attestation.v1',
      evidenceHash,
      providerSpendMicrousd,
    };
  }
  return pair;
}

test('runRelease separates a pre-spend readiness lease from post-cleanup release trust', async () => {
  const releaseSha = 'a'.repeat(40);
  const runtime = await createGenuineRuntimeSession({ releaseSha });
  const events = [];
  let finalEvidence;
  const steps = baseSteps({
    runtimeSession: {
      readiness: async () => { events.push('readiness'); return runtime.controller.readiness(); },
      finalize: async () => { events.push('finalize'); finalEvidence = runtime.controller.finalize(); return finalEvidence; },
      providerEvidence: async () => { events.push('reconcile'); return reconciledProviderEvidence(); },
    },
    controlledPair: async () => { events.push('pair'); return pairWithRuntimeEvidence(runtime.attestationHashes); },
  });
  const { report } = await runRelease({
    config: runtimeSecuredConfig(),
    steps,
    releaseSha,
    harnessVersion: '0.5.0',
  });
  assert.deepEqual(events, ['readiness', 'pair', 'finalize', 'reconcile']);
  assert.equal(report.preflight.runtimeReadiness.ok, true);
  assert.equal(report.evaluationScope.trust.ok, true);
  assert.equal(report.evaluationScope.trust.evidenceHash, protocolDocumentHash(finalEvidence));
  assert.deepEqual(report.runtimeTrust.finalization.orderedTrialHashes, runtime.attestationHashes);
  assert.equal(report.runtimeTrust.finalization.trialEvidenceMatched, true);
  assert.match(report.runtimeTrust.finalization.evidenceArchiveHash, /^[a-f0-9]{64}$/);
  assert.equal(report.runtimeTrust.providerReconciliation.verified, true);
  assert.equal(report.runtimeTrust.providerReconciliation.sessionSpentMicrousd, 200);
  assert.equal(validateAgainstSchema(report, REPORT_SCHEMA).ok, true);
});

test('fractional-microusd trial costs reconcile through one attested integer ledger', async () => {
  const releaseSha = 'a'.repeat(40);
  const runtime = await createGenuineRuntimeSession({ releaseSha, providerSpendMicrousd: 100 });
  const steps = baseSteps({
    runtimeSession: {
      readiness: async () => runtime.controller.readiness(),
      finalize: async () => runtime.controller.finalize(),
      providerEvidence: async () => reconciledProviderEvidence(200),
    },
    controlledPair: async () => pairWithRuntimeEvidence(
      runtime.attestationHashes,
      'pass',
      'pass',
      { reconciledCostUsd: 0.00009995, providerSpendMicrousd: 100 },
    ),
  });

  const { report } = await runRelease({
    config: runtimeSecuredConfig(),
    steps,
    releaseSha,
    harnessVersion: '0.5.0',
  });

  assert.equal(report.runtimeTrust.providerReconciliation.verified, true);
  assert.equal(report.runtimeTrust.providerReconciliation.retainedTrialSpentMicrousd, 200);
  assert.equal(report.runtimeTrust.providerReconciliation.schedulerSpentMicrousd, 200);
});

test('a branded session final cannot attest unrelated retained trial documents', async () => {
  const releaseSha = 'a'.repeat(40);
  const runtime = await createGenuineRuntimeSession({ releaseSha, sessionId: 'mismatched-trials' });
  const mismatchedHashes = [runtime.attestationHashes[0], 'f'.repeat(64)];
  const { report } = await runRelease({
    config: runtimeSecuredConfig(),
    releaseSha,
    steps: baseSteps({
      runtimeSession: {
        readiness: async () => runtime.controller.readiness(),
        finalize: async () => runtime.controller.finalize(),
        providerEvidence: async () => reconciledProviderEvidence(),
      },
      controlledPair: async () => pairWithRuntimeEvidence(mismatchedHashes),
    }),
  });
  assert.equal(report.evaluationScope.trust.ok, false);
  assert.equal(report.evaluationScope.trust.trialEvidenceMatched, false);
  assert.equal(report.gate.block, true);
});

test('invalid readiness withholds provider work; invalid final attestation blocks retained results', async () => {
  const releaseSha = 'a'.repeat(40);
  const invalidReadinessRuntime = await createGenuineRuntimeSession({ releaseSha });
  let providerCalls = 0;
  let finalizeCalls = 0;
  const blocked = await runRelease({
    config: runtimeSecuredConfig(),
    releaseSha,
    steps: baseSteps({
      runtimeSession: {
        readiness: async () => structuredClone(invalidReadinessRuntime.controller.readiness()),
        finalize: async () => { finalizeCalls += 1; return invalidReadinessRuntime.controller.finalize(); },
        providerEvidence: async () => reconciledProviderEvidence(),
      },
      controlledPair: async () => { providerCalls += 1; return pairOf('openrouter-controlled', 'pass', 'pass'); },
    }),
  });
  assert.equal(providerCalls, 0);
  assert.equal(finalizeCalls, 0);
  assert.equal(blocked.report.preflight.runtimeReadiness.ok, false);
  assert.equal(blocked.report.evaluationScope.trust.ok, false);

  const invalidFinalRuntime = await createGenuineRuntimeSession({ releaseSha, sessionId: 'invalid-final' });
  const finalInvalid = await runRelease({
    config: runtimeSecuredConfig(),
    releaseSha,
    steps: baseSteps({
      runtimeSession: {
        readiness: async () => invalidFinalRuntime.controller.readiness(),
        finalize: async () => structuredClone(invalidFinalRuntime.controller.finalize()),
        providerEvidence: async () => reconciledProviderEvidence(),
      },
      controlledPair: async () => {
        providerCalls += 1;
        return pairWithRuntimeEvidence(invalidFinalRuntime.attestationHashes);
      },
    }),
  });
  assert.equal(providerCalls, 1);
  assert.equal(finalInvalid.report.evaluationScope.trust.ok, false);
  assert.equal(finalInvalid.report.gate.block, true);
  assert.ok(finalInvalid.report.gate.reasons.some((reason) => /release trust|attest/i.test(reason)));
});

test('a signed session final without postflight provider reconciliation remains blocked', async () => {
  const releaseSha = 'a'.repeat(40);
  const runtime = await createGenuineRuntimeSession({ releaseSha, sessionId: 'missing-provider-postflight' });
  const { report } = await runRelease({
    config: runtimeSecuredConfig(),
    releaseSha,
    steps: baseSteps({
      runtimeSession: {
        readiness: async () => runtime.controller.readiness(),
        finalize: async () => runtime.controller.finalize(),
      },
      controlledPair: async () => pairWithRuntimeEvidence(runtime.attestationHashes),
    }),
  });
  assert.equal(report.runtimeTrust.finalization.finalizedTrialsAttested, true);
  assert.equal(report.runtimeTrust.providerReconciliation.verified, false);
  assert.equal(report.runtimeTrust.finalization.complete, false);
  assert.equal(report.evaluationScope.trust.ok, false);
  assert.equal(report.gate.block, true);
});

const CLI_RELEASE_CAPABILITIES = [
  'fullHarborRuntimeClosureAttested',
  'keyBearingToolchainIsolated',
  'sandboxEntryChainAttested',
  'mountsObservedFromTrustedSupervisor',
  'escapedProcessesAndContainersReaped',
  'imageResourcesAndNetworkObserved',
];

function releaseCliRawConfig({ armed = true, qualification = false } = {}) {
  return {
    profile: 'release-fixture',
    releaseTrust: {
      status: armed ? 'attested' : 'blocked',
      capabilities: Object.fromEntries(CLI_RELEASE_CAPABILITIES.map((name) => [name, armed])),
    },
    task: { lockFile: 'code-owned-task-lock.json' },
    controlledLane: { host: 'openrouter-controlled', profileId: 'kimi-k2.7-code' },
    budget: {
      releaseCeilingUsd: 10,
      controlledPairUsd: 8,
      rerunUsd: 2,
      providerHardLimitUsd: qualification ? 20 : 10,
      controlledArmCeilingUsd: 0.65,
      ...(qualification ? { qualificationPairUsd: 1.3, calibrationCeilingUsd: 18.7 } : {}),
    },
    efficiencyThresholds: { promptRatio: 2, costRatio: 1.5, wallTimeRatio: 1.25 },
    valueThresholds: {
      maxIncrementalApiCostPerAdditionalSuccessUsd: 2,
      maxIncrementalWallTimePerAdditionalSuccessMs: 600_000,
    },
    claimPolicy: qualification
      ? {
          mode: 'initial-user-ship',
          minimumHarnessSolvedTasks: 1,
          requireCalibrationBaseline: false,
          requireQualificationBaseline: true,
          qualificationTask: 'cobol-modernization',
        }
      : {
          mode: 'regression-gate',
          requireCalibrationBaseline: false,
          requireQualificationBaseline: false,
        },
    repetitions: { routine: 1 },
    nativeProductRotation: [],
  };
}

function releaseCliTaskLock({ multiple = false } = {}) {
  return {
    schema: 'terminal-bench-task-lock.v1',
    datasetRef: 'terminal-bench@2.0',
    verifier: { passingReward: 1 },
    tasks: [{
      task: 'cobol-modernization',
      role: 'anchor',
      taskChecksum: 'a'.repeat(64),
      sandbox: { ...SANDBOX_LOCK },
    }, ...(multiple ? [{
      task: 'second-release-task',
      role: 'stress',
      taskChecksum: 'd'.repeat(64),
      sandbox: { ...SANDBOX_LOCK },
    }] : [])],
  };
}

function makeReleaseCliFixture({
  armed = true,
  qualification = false,
  multiTaskLock = false,
  artifactDisposeError = null,
  runtimeDisposeError = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cli-wiring-'));
  const reportFile = path.join(root, 'report.json');
  const bundleDir = path.join(root, 'bundle');
  const releaseSha = 'a'.repeat(40);
  const harnessVersion = '0.5.0';
  const raw = releaseCliRawConfig({ armed, qualification });
  const suppliedRaw = structuredClone(raw);
  const lock = releaseCliTaskLock({ multiple: multiTaskLock });
  const events = [];
  const writes = [];
  const captured = {};
  const providerControl = { id: 'provider-control' };
  const trialExecutor = async () => ({ ok: true });
  const runtimeSession = { id: 'runtime-session' };
  const dependencies = {
    releaseRepository: () => process.cwd(),
    currentGitReleaseSha: () => releaseSha,
    assertCleanLiveReleaseSource: () => {},
    loadYamlConfig: () => suppliedRaw,
    resolveDefaultLockFile: () => ({
      path: path.join(process.cwd(), 'code-owned-task-lock.json'),
      bytes: Buffer.from(JSON.stringify(lock)),
    }),
    readHarnessVersion: () => harnessVersion,
    loadDeterministicRunner: async () => ({
      runEvals: async () => [],
      summarize: () => ({ passed: 1, failed: 0, infrastructureErrors: 0, skipped: 0 }),
    }),
    loadTaskLockValidator: async () => ({
      validateTaskLock: () => ({ ok: true, errors: [] }),
    }),
    buildOfflineDataset: async ({ outputRoot, taskLock }) => {
      events.push('offline-dataset');
      captured.offlineSourceTaskNames = taskLock.tasks.map(({ task }) => task);
      const derivedLock = {
        ...structuredClone(taskLock),
        datasetRef: 'terminal-bench-derived-offline@53ff2b87d621',
        tasks: taskLock.tasks.map((entry) => ({ ...entry, taskChecksum: 'c'.repeat(64) })),
      };
      const taskLockHash = canonicalSha256(derivedLock);
      const attestation = {
        schema: 'engineer-terminal-bench-offline-dataset-attestation.v1',
        label: 'private-terminal-bench-derived-offline',
        publicLeaderboardEligible: false,
        networkRequiredAtTrial: false,
        taskLock: { sha256: taskLockHash },
      };
      const artifactId = canonicalSha256(attestation);
      const artifactDir = path.join(outputRoot, artifactId);
      const datasetDir = path.join(artifactDir, 'dataset');
      fs.mkdirSync(datasetDir, { recursive: true, mode: 0o700 });
      const lockPath = path.join(artifactDir, 'offline-task-lock.json');
      const attestationPath = path.join(artifactDir, 'offline-dataset-attestation.json');
      fs.writeFileSync(lockPath, canonicalJson(derivedLock), { mode: 0o400 });
      fs.writeFileSync(attestationPath, canonicalJson(attestation), { mode: 0o400 });
      fs.chmodSync(datasetDir, 0o555);
      fs.chmodSync(artifactDir, 0o555);
      return {
        artifactId,
        artifactDir,
        datasetDir,
        lockPath,
        attestationPath,
        taskLockHash,
        taskLock: derivedLock,
        attestation,
        datasetTreeHash: 'd'.repeat(64),
      };
    },
    runtimeArtifactFactory: async (context) => {
      events.push('artifacts');
      captured.artifactContext = context;
      assert.deepEqual(Object.keys(context).sort(), [
        'brokerPolicyHash', 'budgetPolicyHash', 'profileId', 'releaseSha', 'repoRoot', 'sessionCeilingMicrousd',
        'sourceIdentity', 'taskLock', 'taskLockHash',
      ]);
      assert.deepEqual(context.sourceIdentity, { releaseSha, harnessVersion });
      assert.equal(Object.hasOwn(context.taskLock.tasks[0].sandbox, 'sourceImage'), false);
      const bundleHash = 'b'.repeat(64);
      return {
        bundle: { bundleDir, manifestHash: bundleHash },
        runtimeProjection: {
          snapshot: { buildHash: 'e'.repeat(64) },
          bindings: {
            releaseSha,
            taskLockHash: context.taskLockHash,
            bundleHash,
            budgetPolicyHash: context.budgetPolicyHash,
            brokerPolicyHash: context.brokerPolicyHash,
            profileId: context.profileId,
            sessionCeilingMicrousd: context.sessionCeilingMicrousd,
          },
        },
        daytonaPath: '/usr/bin/true',
        dispose: async () => {
          events.push('artifact-dispose');
          if (artifactDisposeError) throw artifactDisposeError;
        },
      };
    },
    createReleaseRuntime: async (input) => {
      events.push('runtime');
      captured.runtimeInput = input;
      return {
        providerControl,
        trialExecutor,
        runtimeSession,
        dispose: async () => {
          events.push('runtime-dispose');
          const error = typeof runtimeDisposeError === 'function'
            ? runtimeDisposeError()
            : runtimeDisposeError;
          if (error) throw error;
        },
      };
    },
    loadLiveSteps: async () => ({
      buildLiveSteps: (input) => {
        events.push('live');
        captured.liveInput = input;
        return {
          environment: async () => ({ ok: true, missing: [] }),
          taskLock: async () => ({ ok: true, reason: '' }),
          controlledPair: async () => null,
        };
      },
    }),
    loadZeroProviderBaselineSupport: async () => ({
      validateZeroProviderDaytonaRun: (value) => {
        events.push('zero-baseline-validate');
        return structuredClone(value);
      },
      buildZeroProviderQualificationDefinition: (value) => ({
        schema: 'fixture-zero-provider-gate-definition.v1',
        ...structuredClone(value),
      }),
    }),
    runRelease: async (input) => {
      events.push('run');
      captured.runInput = input;
      return {
        report: { schema: 'fixture-report', evaluationScope: { trust: { ok: true } } },
        exitCode: 0,
      };
    },
    validateReport: () => ({ ok: true, errors: [] }),
    reservePrivateReport: (destination) => {
      events.push('reserve');
      return { destination, writeAttempted: false, written: false };
    },
    writeReservedPrivateReport: (reservation, report) => {
      events.push(report.schema === 'eval-emergency.v1' ? 'write-emergency' : 'write-trusted');
      reservation.writeAttempted = true;
      reservation.written = true;
      writes.push(structuredClone(report));
    },
    closePrivateReportReservation: (reservation) => {
      if (reservation) events.push('close');
    },
    makeReleaseWorkDir: () => {
      events.push('workdir');
      return fs.mkdtempSync(path.join(root, 'work-'));
    },
    removeReleaseWorkDir: (workDir) => {
      if (!workDir) return;
      events.push('remove-workdir');
      makeReleaseTreeRemovable(workDir);
      fs.rmSync(workDir, { recursive: true, force: true });
    },
    now: () => new Date('2026-08-04T20:00:00.000Z'),
  };
  return {
    root,
    reportFile,
    releaseSha,
    raw: suppliedRaw,
    events,
    writes,
    captured,
    controls: { providerControl, trialExecutor, runtimeSession },
    dependencies,
    cleanup: () => {
      makeReleaseTreeRemovable(root);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function qualificationBaselineFixture(fixture, mutation = () => {}) {
  const taskLock = releaseCliTaskLock();
  const derivedLock = {
    ...structuredClone(taskLock),
    datasetRef: 'terminal-bench-derived-offline@53ff2b87d621',
    tasks: taskLock.tasks.map((entry) => ({ ...entry, taskChecksum: 'c'.repeat(64) })),
  };
  const taskLockHash = canonicalSha256(canonicalReleaseRuntimeTaskLock(derivedLock));
  const qualificationBudget = {
    releaseCeilingUsd: 1.3,
    controlledPairUsd: 1.3,
    rerunUsd: 0,
    controlledArmCeilingUsd: 0.65,
    qualificationPairUsd: 1.3,
    calibrationCeilingUsd: 18.7,
    providerHardLimitUsd: 20,
  };
  const budgetPolicyHash = releaseBudgetPolicyHash({
    evaluationMode: 'qualification',
    controlledLane: { host: 'openrouter-controlled', profileId: 'kimi-k2.7-code' },
    budget: qualificationBudget,
    repetitions: 1,
    taskCount: 1,
  });
  const brokerPolicyHash = controlledProviderBrokerStaticPolicyHash({
    profileId: 'kimi-k2.7-code',
    sessionCeilingMicrousd: 1_300_000,
  });
  const gateDefinition = {
    schema: 'fixture-zero-provider-gate-definition.v1',
    profileId: 'kimi-k2.7-code',
    taskLockHash,
    budgetPolicyHash,
    brokerPolicyHash,
  };
  const run = {
    schema: 'engineer-zero-provider-daytona-run.v1',
    report: {
      bindings: {
        releaseSha: fixture.releaseSha,
        profileId: 'kimi-k2.7-code',
        taskId: 'cobol-modernization',
        taskLockHash,
        bundleHash: 'b'.repeat(64),
        snapshotBuildHash: 'e'.repeat(64),
        gateDefinitionHash: canonicalSha256(gateDefinition),
      },
      timing: {
        startedAt: '2026-08-04T19:50:00.000Z',
        completedAt: '2026-08-04T19:59:00.000Z',
      },
      reportHash: '1'.repeat(64),
    },
    protocolEvidence: {
      sessionFinalAttestation: {
        issuedAt: '2026-08-04T19:58:00.000Z',
        expiresAt: '2026-08-04T20:58:00.000Z',
      },
    },
    lifecycleHash: '2'.repeat(64),
    artifactHash: '3'.repeat(64),
  };
  mutation(run);
  const envelope = {
    schema: 'engineer-zero-provider-daytona-evidence.v1',
    operatorTrustModel: 'trusted-local-owner',
    artifactHashSemantics: 'canonical-content-integrity-only',
    runtimeRun: run,
  };
  const file = path.join(fixture.root, 'zero-provider-baseline.json');
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { file, bytes, envelope, run };
}

test('the injectable artifact preparer disposes malformed code-owned output', async () => {
  let disposed = false;
  const context = {
    releaseSha: 'a'.repeat(40),
    taskLockHash: '1'.repeat(64),
    budgetPolicyHash: '2'.repeat(64),
    brokerPolicyHash: '3'.repeat(64),
    profileId: 'kimi-k2.7-code',
    sessionCeilingMicrousd: 10_000_000,
  };
  await assert.rejects(
    prepareReleaseRuntimeArtifacts(context, {
      artifactFactory: async () => ({
        bundle: { bundleDir: '/private/code-owned-bundle', manifestHash: 'not-a-hash' },
        runtimeProjection: { bindings: {} },
        daytonaPath: '/usr/bin/true',
        dispose: async () => { disposed = true; },
      }),
    }),
    /manifest hash/i
  );
  assert.equal(disposed, true);
});

test('armed release fixtures produce a self-consistent offline dataset identity', async () => {
  const fixture = makeReleaseCliFixture();
  const workDir = fixture.dependencies.makeReleaseWorkDir();
  try {
    const dataset = await fixture.dependencies.buildOfflineDataset({
      outputRoot: path.join(workDir, 'offline-terminal-bench'),
      taskLock: releaseCliTaskLock(),
    });
    const validated = validateOfflineReleaseDataset(dataset, {
      sourceLock: releaseCliTaskLock(),
      workDir,
    });
    assert.equal(validated.artifactId, dataset.artifactId);
  } finally {
    fixture.cleanup();
  }
});

test('runReleaseCli reserves, constructs, injects, disposes, then publishes one armed release', async () => {
  const fixture = makeReleaseCliFixture();
  const stdout = [];
  try {
    const result = await runReleaseCli({
      argv: ['--provider-key-fd', '9', '--report-file', fixture.reportFile, '--json'],
      env: { PATH: process.env.PATH ?? '/usr/bin' },
      stdout: (value) => { fixture.events.push('stdout'); stdout.push(value); },
      stderr: () => {},
      dependencies: fixture.dependencies,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.runtimeArming.ok, true);
    assert.deepEqual(fixture.events, [
      'reserve', 'workdir', 'offline-dataset', 'artifacts', 'runtime', 'live', 'run',
      'runtime-dispose', 'artifact-dispose', 'write-trusted', 'stdout', 'close', 'remove-workdir',
    ]);
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0].schema, 'fixture-report');
    assert.equal(stdout.length, 1);

    const { config, steps } = fixture.captured.runInput;
    assert.equal(config.evaluationScope.trust.ok, false, 'final trust starts blocked');
    assert.equal(config.runtimeTrustRequired, true);
    assert.deepEqual(config.releaseTrust, fixture.raw.releaseTrust);
    assert.notEqual(config.releaseTrust, fixture.raw.releaseTrust, 'releaseTrust is copied from raw configuration');
    assert.deepEqual(config.runtimeTrustBindings, {
      releaseSha: fixture.releaseSha,
      profileId: 'kimi-k2.7-code',
      taskLockHash: fixture.captured.artifactContext.taskLockHash,
      bundleHash: 'b'.repeat(64),
      budgetId: `release-release-${fixture.captured.artifactContext.budgetPolicyHash.slice(0, 24)}`,
      budgetPolicyHash: fixture.captured.artifactContext.budgetPolicyHash,
      brokerPolicyHash: fixture.captured.artifactContext.brokerPolicyHash,
      sessionCeilingMicrousd: 10_000_000,
    });
    assert.equal(steps.runtimeSession, fixture.controls.runtimeSession);
    assert.equal(fixture.captured.liveInput.providerControl, fixture.controls.providerControl);
    assert.equal(fixture.captured.liveInput.trialExecutor, fixture.controls.trialExecutor);
    assert.match(fixture.captured.liveInput.lock.datasetRef, /^terminal-bench-derived-offline@/);
    assert.match(fixture.captured.liveInput.env.HARNESS_EVAL_TB_DATASET_DIR, /offline-terminal-bench/);
    assert.equal(fixture.captured.runtimeInput.providerKeyFd, 9);
    assert.equal(fixture.captured.runtimeInput.bundle.bundleDir, path.join(fixture.root, 'bundle'));
    assert.equal(fixture.captured.runtimeInput.taskLock.tasks[0].sandbox.sourceImage, undefined);
    assert.match(fixture.captured.runtimeInput.taskLock.datasetRef, /^terminal-bench-derived-offline@/);
  } finally {
    fixture.cleanup();
  }
});

test('armed qualification consumes one current owner-private zero-provider baseline before runtime custody', async () => {
  const fixture = makeReleaseCliFixture({ qualification: true, multiTaskLock: true });
  const baseline = qualificationBaselineFixture(fixture);
  try {
    await runReleaseCli({
      argv: [
        '--qualification',
        '--zero-provider-baseline', baseline.file,
        '--provider-key-fd', '9',
        '--report-file', fixture.reportFile,
        '--json',
      ],
      env: { PATH: process.env.PATH ?? '/usr/bin' },
      stdout: () => {},
      stderr: () => {},
      dependencies: fixture.dependencies,
    });
    assert.ok(fixture.events.indexOf('zero-baseline-validate') < fixture.events.indexOf('artifacts'));
    assert.ok(fixture.events.indexOf('artifacts') < fixture.events.indexOf('runtime'));
    assert.deepEqual(fixture.captured.offlineSourceTaskNames, [
      'cobol-modernization', 'second-release-task',
    ], 'the immutable offline dataset is built from the complete release lock');
    assert.deepEqual(fixture.captured.runtimeInput.taskLock.tasks.map(({ task }) => task), [
      'cobol-modernization',
    ], 'only the qualification task enters the paid runtime projection');
    assert.deepEqual(fixture.captured.runInput.config.zeroProviderBaseline, {
      byteSha256: crypto.createHash('sha256').update(baseline.bytes).digest('hex'),
      reportHash: baseline.run.report.reportHash,
      lifecycleHash: baseline.run.lifecycleHash,
      artifactHash: baseline.run.artifactHash,
    });
    assert.equal(fixture.captured.runInput.config.evaluationScope.releaseEligible, false,
      'zero-provider evidence can never make qualification release-eligible');
    assert.equal(fixture.captured.runInput.config.evaluationScope.trust.ok, false,
      'the trusted-owner receipt cannot create runtime or release trust');
  } finally {
    fixture.cleanup();
  }
});

test('zero-provider qualification baseline is mandatory only for armed qualification and must be absolute', async () => {
  const missing = makeReleaseCliFixture({ qualification: true });
  try {
    await assert.rejects(
      runReleaseCli({
        argv: ['--qualification', '--provider-key-fd', '9', '--report-file', missing.reportFile],
        env: { PATH: '/usr/bin' },
        dependencies: missing.dependencies,
      }),
      /qualification requires exactly one --zero-provider-baseline/i,
    );
    assert.equal(missing.events.includes('artifacts'), false);
    assert.equal(missing.events.includes('runtime'), false);
  } finally {
    missing.cleanup();
  }

  const outside = makeReleaseCliFixture();
  const baseline = qualificationBaselineFixture(outside);
  try {
    await assert.rejects(
      runReleaseCli({
        argv: ['--zero-provider-baseline', baseline.file, '--provider-key-fd', '9', '--report-file', outside.reportFile],
        env: { PATH: '/usr/bin' },
        dependencies: outside.dependencies,
      }),
      /--zero-provider-baseline.*only.*--qualification/i,
    );
    assert.equal(outside.events.includes('zero-baseline-validate'), false);
    assert.equal(outside.events.includes('runtime'), false);
  } finally {
    outside.cleanup();
  }

  const relative = makeReleaseCliFixture({ qualification: true });
  try {
    await assert.rejects(
      runReleaseCli({
        argv: [
          '--qualification', '--zero-provider-baseline', 'relative.json',
          '--provider-key-fd', '9', '--report-file', relative.reportFile,
        ],
        env: { PATH: '/usr/bin' },
        dependencies: relative.dependencies,
      }),
      /zero-provider-baseline.*absolute/i,
    );
    assert.equal(relative.events.includes('zero-baseline-validate'), false);
    assert.equal(relative.events.includes('runtime'), false);
  } finally {
    relative.cleanup();
  }

  const exposed = makeReleaseCliFixture({ qualification: true });
  const exposedBaseline = qualificationBaselineFixture(exposed);
  fs.chmodSync(exposedBaseline.file, 0o644);
  try {
    await assert.rejects(
      runReleaseCli({
        argv: [
          '--qualification', '--zero-provider-baseline', exposedBaseline.file,
          '--provider-key-fd', '9', '--report-file', exposed.reportFile,
        ],
        env: { PATH: '/usr/bin' },
        dependencies: exposed.dependencies,
      }),
      /zero-provider baseline.*must not be accessible by group or other users/i,
    );
    assert.equal(exposed.events.includes('zero-baseline-validate'), false);
    assert.equal(exposed.events.includes('runtime'), false);
  } finally {
    exposed.cleanup();
  }

  const forgedTrust = makeReleaseCliFixture({ qualification: true });
  const forgedBaseline = qualificationBaselineFixture(forgedTrust);
  const forgedEnvelope = JSON.parse(forgedBaseline.bytes.toString('utf8'));
  forgedEnvelope.operatorTrustModel = 'standalone-authenticated';
  fs.writeFileSync(forgedBaseline.file, `${JSON.stringify(forgedEnvelope)}\n`, { mode: 0o600 });
  try {
    await assert.rejects(
      runReleaseCli({
        argv: [
          '--qualification', '--zero-provider-baseline', forgedBaseline.file,
          '--provider-key-fd', '9', '--report-file', forgedTrust.reportFile,
        ],
        env: { PATH: '/usr/bin' },
        dependencies: forgedTrust.dependencies,
      }),
      /durable evidence trust or digest semantics are invalid/i,
    );
    assert.equal(forgedTrust.events.includes('zero-baseline-validate'), false);
    assert.equal(forgedTrust.events.includes('runtime'), false);
  } finally {
    forgedTrust.cleanup();
  }
});

test('qualification rejects every stale zero-provider binding before provider runtime construction', async () => {
  const cases = [
    ['releaseSha', (run) => { run.report.bindings.releaseSha = 'f'.repeat(40); }],
    ['profileId', (run) => { run.report.bindings.profileId = 'other-profile'; }],
    ['taskId', (run) => { run.report.bindings.taskId = 'other-task'; }],
    ['taskLockHash', (run) => { run.report.bindings.taskLockHash = '4'.repeat(64); }],
    ['bundleHash', (run) => { run.report.bindings.bundleHash = '5'.repeat(64); }],
    ['snapshotBuildHash', (run) => { run.report.bindings.snapshotBuildHash = '6'.repeat(64); }],
    ['gateDefinitionHash', (run) => { run.report.bindings.gateDefinitionHash = '7'.repeat(64); }],
  ];
  for (const [field, mutate] of cases) {
    const fixture = makeReleaseCliFixture({ qualification: true });
    const baseline = qualificationBaselineFixture(fixture, mutate);
    try {
      await assert.rejects(
        runReleaseCli({
          argv: [
            '--qualification', '--zero-provider-baseline', baseline.file,
            '--provider-key-fd', '9', '--report-file', fixture.reportFile,
          ],
          env: { PATH: '/usr/bin' },
          dependencies: fixture.dependencies,
        }),
        ['releaseSha', 'profileId', 'taskId'].includes(field)
          ? new RegExp(`zero-provider baseline.*${field}`, 'i')
          : /release evaluation failed unexpectedly/i,
        field,
      );
      assert.equal(fixture.events.includes('runtime'), false, `${field} drift must precede runtime construction`);
    } finally {
      fixture.cleanup();
    }
  }
});

test('qualification rejects stale, future-dated, and expired zero-provider receipts before provider custody', async () => {
  const cases = [
    ['stale', (run) => {
      run.report.timing.completedAt = '2026-08-04T18:59:59.999Z';
      run.protocolEvidence.sessionFinalAttestation.issuedAt = '2026-08-04T18:58:00.000Z';
      run.protocolEvidence.sessionFinalAttestation.expiresAt = '2026-08-04T21:00:00.000Z';
    }, /older than the 60-minute qualification window/i],
    ['future', (run) => {
      run.report.timing.completedAt = '2026-08-04T20:01:00.000Z';
      run.protocolEvidence.sessionFinalAttestation.issuedAt = '2026-08-04T20:00:00.000Z';
      run.protocolEvidence.sessionFinalAttestation.expiresAt = '2026-08-04T21:00:00.000Z';
    }, /future-dated/i],
    ['expired', (run) => {
      run.protocolEvidence.sessionFinalAttestation.expiresAt = '2026-08-04T20:00:00.000Z';
    }, /session evidence has expired/i],
  ];
  for (const [label, mutate, expected] of cases) {
    const fixture = makeReleaseCliFixture({ qualification: true });
    const baseline = qualificationBaselineFixture(fixture, mutate);
    try {
      await assert.rejects(
        runReleaseCli({
          argv: [
            '--qualification', '--zero-provider-baseline', baseline.file,
            '--provider-key-fd', '9', '--report-file', fixture.reportFile,
          ],
          env: { PATH: '/usr/bin' },
          dependencies: fixture.dependencies,
        }),
        expected,
        label,
      );
      assert.equal(fixture.events.includes('artifacts'), false, `${label} evidence must fail before artifacts`);
      assert.equal(fixture.events.includes('runtime'), false, `${label} evidence must fail before provider runtime`);
    } finally {
      fixture.cleanup();
    }
  }

  const agedDuringPreparation = makeReleaseCliFixture({ qualification: true });
  const baseline = qualificationBaselineFixture(agedDuringPreparation);
  let nowCalls = 0;
  agedDuringPreparation.dependencies.now = () => new Date(
    nowCalls++ === 0 ? '2026-08-04T20:00:00.000Z' : '2026-08-04T21:01:00.000Z'
  );
  try {
    await assert.rejects(
      runReleaseCli({
        argv: [
          '--qualification', '--zero-provider-baseline', baseline.file,
          '--provider-key-fd', '9', '--report-file', agedDuringPreparation.reportFile,
        ],
        env: { PATH: '/usr/bin' },
        dependencies: agedDuringPreparation.dependencies,
      }),
      /release evaluation failed unexpectedly/i,
    );
    assert.equal(agedDuringPreparation.events.includes('artifacts'), true);
    assert.equal(agedDuringPreparation.events.includes('artifact-dispose'), true);
    assert.equal(agedDuringPreparation.events.includes('runtime'), false,
      'freshness is rechecked after artifact preparation and before provider FD consumption');
  } finally {
    agedDuringPreparation.cleanup();
  }
});

test('armed CLI rejects duplicate or noncanonical custody/report channels and ambient injection', async () => {
  const cases = [
    {
      argv: [],
      env: { PATH: '/usr/bin' },
      expected: /exactly one --provider-key-fd/i,
    },
    {
      argv: ['--provider-key-fd', '9'],
      env: { PATH: '/usr/bin' },
      expected: /exactly one --report-file/i,
    },
    {
      argv: ['--provider-key-fd', '9', '--provider-key-fd', '10'],
      env: { PATH: '/usr/bin' },
      expected: /at most once/i,
    },
    {
      argv: ['--provider-key-fd', '09'],
      env: { PATH: '/usr/bin' },
      expected: /canonical inherited descriptor/i,
      includeReport: true,
    },
    {
      argv: ['--provider-key-fd', '9'],
      env: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'raw-secret' },
      expected: /raw provider credentials/i,
      includeReport: true,
    },
    {
      argv: ['--provider-key-fd', '9'],
      env: { PATH: '/usr/bin', node_options: '' },
      expected: /NODE_OPTIONS/i,
      includeReport: true,
    },
    {
      argv: ['--provider-key-fd', '9'],
      env: { PATH: '/usr/bin', HARNESS_EVAL_TB_BUNDLE_DIR: '/tmp/operator-bundle' },
      expected: /code-owned.*environment/i,
      includeReport: true,
    },
    {
      argv: ['--provider-key-fd', '9'],
      env: { PATH: '/usr/bin', HARNESS_EVAL_HARBOR_BIN: '/tmp/operator-harbor' },
      expected: /code-owned.*environment/i,
      includeReport: true,
    },
    {
      argv: ['--provider-key-fd', '9'],
      env: { PATH: '/usr/bin', HARNESS_EVAL_TB_ENV: 'operator-topology' },
      expected: /code-owned.*environment/i,
      includeReport: true,
    },
  ];
  for (const item of cases) {
    const fixture = makeReleaseCliFixture();
    try {
      const argv = item.includeReport ? [...item.argv, '--report-file', fixture.reportFile] : item.argv;
      await assert.rejects(
        runReleaseCli({ argv, env: item.env, dependencies: fixture.dependencies }),
        item.expected
      );
      assert.equal(fixture.events.includes('artifacts'), false);
      assert.equal(fixture.events.includes('runtime'), false);
    } finally {
      fixture.cleanup();
    }
  }

  await assert.rejects(
    runReleaseCli({ argv: ['--daytona-path', '/tmp/daytona'] }),
    /runtime artifact paths.*argv/i
  );
  await assert.rejects(
    runReleaseCli({ argv: ['--provider-api-key', 'raw-secret'] }),
    /inherited --provider-key-fd/i
  );
  const positionalSecret = 'sentinel-provider-secret-must-not-echo';
  await assert.rejects(
    runReleaseCli({ argv: [positionalSecret] }),
    (error) => /unsupported release argument/i.test(error.message) && !error.message.includes(positionalSecret)
  );
});

test('deterministic and red-trust diagnostics reject provider custody and never construct a runtime', async () => {
  for (const deterministicOnly of [true, false]) {
    const fixture = makeReleaseCliFixture({ armed: deterministicOnly });
    try {
      await assert.rejects(
        runReleaseCli({
          argv: [
            ...(deterministicOnly ? ['--deterministic-only'] : []),
            '--provider-key-fd', '9',
          ],
          env: { PATH: '/usr/bin' },
          dependencies: fixture.dependencies,
        }),
        /forbidden for deterministic or unarmed/i
      );
      assert.equal(fixture.events.includes('runtime'), false);
    } finally {
      fixture.cleanup();
    }
  }

  for (const deterministicOnly of [true, false]) {
    const fixture = makeReleaseCliFixture({ armed: deterministicOnly });
    const stdout = [];
    fixture.dependencies.runRelease = async ({ config, steps }) => {
      fixture.events.push('run');
      assert.equal(config.evaluationScope.trust.ok, false);
      assert.equal(steps.runtimeSession, undefined);
      assert.equal(steps.controlledPair, null);
      if (deterministicOnly) assert.deepEqual(await steps.deterministic(), { passed: 1, failed: 0, skipped: 0 });
      return {
        report: { schema: 'diagnostic-report', evaluationScope: { trust: { ok: false } } },
        exitCode: 1,
      };
    };
    try {
      const result = await runReleaseCli({
        argv: [...(deterministicOnly ? ['--deterministic-only'] : []), '--json'],
        env: { PATH: '/usr/bin' },
        stdout: (value) => stdout.push(value),
        dependencies: fixture.dependencies,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(fixture.events.includes('artifacts'), false);
      assert.equal(fixture.events.includes('runtime'), false);
      assert.equal(stdout.length, 1);
    } finally {
      fixture.cleanup();
    }
  }
});

test('runReleaseCli disposes runtime and artifacts before archiving an execution failure', async () => {
  const fixture = makeReleaseCliFixture();
  let stdoutCalls = 0;
  fixture.dependencies.runRelease = async () => {
    fixture.events.push('run');
    throw new Error('simulated release execution failure');
  };
  try {
    await assert.rejects(
      runReleaseCli({
        argv: ['--provider-key-fd', '9', '--report-file', fixture.reportFile, '--json'],
        env: { PATH: '/usr/bin' },
        stdout: () => { stdoutCalls += 1; },
        dependencies: fixture.dependencies,
      }),
      /release evaluation failed unexpectedly/i
    );
    assert.equal(stdoutCalls, 0);
    assert.deepEqual(fixture.events, [
      'reserve', 'workdir', 'offline-dataset', 'artifacts', 'runtime', 'live', 'run',
      'runtime-dispose', 'artifact-dispose', 'write-emergency', 'close', 'remove-workdir',
    ]);
    assert.equal(fixture.writes[0].schema, 'eval-emergency.v1');
  } finally {
    fixture.cleanup();
  }
});

test('runtime construction failure still disposes prepared artifacts before emergency archival', async () => {
  const fixture = makeReleaseCliFixture();
  fixture.dependencies.createReleaseRuntime = async () => {
    fixture.events.push('runtime');
    throw new Error('simulated runtime construction failure');
  };
  try {
    await assert.rejects(
      runReleaseCli({
        argv: ['--provider-key-fd', '9', '--report-file', fixture.reportFile, '--json'],
        env: { PATH: '/usr/bin' },
        stdout: () => { throw new Error('stdout must remain suppressed'); },
        dependencies: fixture.dependencies,
      }),
      /release evaluation failed unexpectedly/i
    );
    assert.deepEqual(fixture.events, [
      'reserve', 'workdir', 'offline-dataset', 'artifacts', 'runtime',
      'artifact-dispose', 'write-emergency', 'close', 'remove-workdir',
    ]);
    assert.equal(fixture.writes[0].schema, 'eval-emergency.v1');
  } finally {
    fixture.cleanup();
  }
});

test('artifact disposal failure suppresses trusted archival and stdout after runtime shutdown', async () => {
  const fixture = makeReleaseCliFixture({ artifactDisposeError: new Error('artifact cleanup failed') });
  let stdoutCalls = 0;
  try {
    await assert.rejects(
      runReleaseCli({
        argv: ['--provider-key-fd', '9', '--report-file', fixture.reportFile, '--json'],
        env: { PATH: '/usr/bin' },
        stdout: () => { stdoutCalls += 1; },
        dependencies: fixture.dependencies,
      }),
      /release evaluation failed unexpectedly/i
    );
    assert.equal(stdoutCalls, 0);
    assert.deepEqual(fixture.events.slice(0, 11), [
      'reserve', 'workdir', 'offline-dataset', 'artifacts', 'runtime', 'live', 'run',
      'runtime-dispose', 'artifact-dispose', 'artifact-dispose', 'write-emergency',
    ]);
    assert.equal(fixture.events.includes('write-trusted'), false);
    assert.equal(fixture.writes[0].schema, 'eval-emergency.v1');
  } finally {
    fixture.cleanup();
  }
});

test('runtime disposal failure cannot skip artifact disposal or publish trusted output', async () => {
  const fixture = makeReleaseCliFixture({ runtimeDisposeError: new Error('runtime cleanup failed') });
  let stdoutCalls = 0;
  try {
    await assert.rejects(
      runReleaseCli({
        argv: ['--provider-key-fd', '9', '--report-file', fixture.reportFile, '--json'],
        env: { PATH: '/usr/bin' },
        stdout: () => { stdoutCalls += 1; },
        dependencies: fixture.dependencies,
      }),
      /release evaluation failed unexpectedly/i
    );
    assert.equal(stdoutCalls, 0);
    assert.ok(fixture.events.indexOf('artifact-dispose') > fixture.events.indexOf('runtime-dispose'));
    assert.equal(fixture.events.includes('write-trusted'), false);
    assert.equal(fixture.writes[0].schema, 'eval-emergency.v1');
  } finally {
    fixture.cleanup();
  }
});

test('a transient runtime disposal failure is retried by the catch path without publishing trusted output', async () => {
  let runtimeDisposeAttempts = 0;
  const fixture = makeReleaseCliFixture({
    runtimeDisposeError: () => {
      runtimeDisposeAttempts += 1;
      return runtimeDisposeAttempts === 1 ? new Error('transient runtime cleanup failure') : null;
    },
  });
  let stdoutCalls = 0;
  try {
    await assert.rejects(
      runReleaseCli({
        argv: ['--provider-key-fd', '9', '--report-file', fixture.reportFile, '--json'],
        env: { PATH: '/usr/bin' },
        stdout: () => { stdoutCalls += 1; },
        dependencies: fixture.dependencies,
      }),
      /release evaluation failed unexpectedly/i
    );
    assert.equal(stdoutCalls, 0);
    assert.equal(runtimeDisposeAttempts, 2, 'the catch path retries rejected runtime teardown');
    assert.equal(
      fixture.events.filter((event) => event === 'runtime-dispose').length,
      2
    );
    assert.equal(
      fixture.events.filter((event) => event === 'artifact-dispose').length,
      1,
      'successful artifact teardown remains terminal while runtime teardown retries'
    );
    assert.equal(fixture.events.includes('write-trusted'), false);
    assert.deepEqual(fixture.writes.map(({ schema }) => schema), ['eval-emergency.v1']);
  } finally {
    fixture.cleanup();
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
        controlledPair: async () => {
          providerCalls.push('called');
          return pairOf('openrouter-controlled', 'pass', 'pass');
        },
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(report.preflight.ok, false);
    assert.equal(report.evaluationScope.releaseEligible, entry.expectedReleaseEligible);
    assert.equal(report.pairs.find((pair) => pair.host === 'openrouter-controlled').required, undefined,
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
    { ...CONFIG, budget: { releaseCeilingUsd: 10, controlledPairUsd: 9, rerunUsd: 2 } },
    {
      ...CONTROLLED_CONFIG,
      claimPolicy: { mode: 'initial-user-ship', minimumHarnessSolvedTasks: 1 },
      budget: {
        ...CONTROLLED_CONFIG.budget,
        qualificationPairUsd: 1.3,
        calibrationCeilingUsd: 19,
      },
    },
    {
      ...CONTROLLED_CONFIG,
      claimPolicy: { mode: 'initial-user-ship', minimumHarnessSolvedTasks: 1 },
      budget: {
        ...CONTROLLED_CONFIG.budget,
        qualificationPairUsd: 1.31,
        calibrationCeilingUsd: 18.69,
        providerHardLimitUsd: 20,
      },
    },
    {
      ...CONTROLLED_CONFIG,
      claimPolicy: { mode: 'regression-gate' },
      budget: { ...CONTROLLED_CONFIG.budget, releaseCeilingUsd: 10.01, providerHardLimitUsd: 10.01 },
    },
  ]) {
    const verdict = validateReleasePolicyConfig(invalid);
    assert.equal(verdict.ok, false);
    await assert.rejects(
      runRelease({ config: invalid, steps: baseSteps() }),
      /invalid release evaluation policy/i
    );
  }
});

test('initial calibration and post-calibration routine profiles encode different ship decisions', async () => {
  const calibrationProfile = YAML.parse(fs.readFileSync(
    new URL('../../../evals/config/release-canary.yaml', import.meta.url),
    'utf8'
  ));
  const routineProfile = YAML.parse(fs.readFileSync(
    new URL('../../../evals/config/release-routine.yaml', import.meta.url),
    'utf8'
  ));
  assert.equal(calibrationProfile.claimPolicy.mode, 'initial-user-ship');
  assert.equal(calibrationProfile.claimPolicy.requireQualificationBaseline, true);
  assert.equal(calibrationProfile.claimPolicy.qualificationTask, 'cobol-modernization');
  assert.equal(calibrationProfile.repetitions.calibration, 3);
  assert.equal(calibrationProfile.budget.qualificationPairUsd, 1.3);
  assert.equal(calibrationProfile.budget.calibrationCeilingUsd, 18.7);
  assert.equal(calibrationProfile.budget.providerHardLimitUsd, 20);
  assert.ok(
    calibrationProfile.budget.qualificationPairUsd + calibrationProfile.budget.calibrationCeilingUsd <= 20,
    'qualification and calibration share the absolute initial-evidence ceiling'
  );
  assert.equal(routineProfile.claimPolicy.mode, 'regression-gate');
  assert.equal(routineProfile.claimPolicy.requireCalibrationBaseline, true);
  assert.equal(routineProfile.claimPolicy.requireQualificationBaseline, true);
  assert.equal(routineProfile.repetitions.routine, 1);
  assert.equal(routineProfile.budget.releaseCeilingUsd, 10);
  assert.equal(routineProfile.budget.providerHardLimitUsd, 10);
  assert.equal(validateReleasePolicyConfig({ ...routineProfile, task: CONFIG.task }).ok, true);

  const routineConfigWithoutBaseline = {
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
  let controlledCalled = false;
  const missingBaseline = await runRelease({
    config: routineConfigWithoutBaseline,
    steps: baseSteps({
      environment: routineEnvironment,
      controlledPair: async () => {
        controlledCalled = true;
        return pairOf('openrouter-controlled', 'pass', 'pass');
      },
    }),
  });
  assert.equal(controlledCalled, false, 'routine spend is withheld before initial calibration provenance is accepted');
  assert.equal(missingBaseline.report.readiness.ready, false);
  assert.equal(missingBaseline.exitCode, 1);

  const routineConfig = {
    ...routineConfigWithoutBaseline,
    calibrationBaseline: {
      valid: true,
      evidenceHash: 'f'.repeat(64),
      releaseSha: '1'.repeat(40),
      harnessVersion: '0.5.0',
      minimumRepetitions: 3,
      controlledWins: 1,
      harnessSolvedTasks: 2,
      providerKeyFingerprint: '9'.repeat(64),
      reasons: [],
    },
  };
  const { report, exitCode } = await runRelease({
    config: routineConfig,
    steps: baseSteps({ environment: routineEnvironment }),
  });
  assert.equal(report.readiness.policy, 'regression-gate');
  assert.equal(report.readiness.ready, true);
  assert.equal(report.readiness.calibrationBaseline.evidenceHash, 'f'.repeat(64));
  assert.equal(report.claim.level, 'bounded-overhead');
  assert.equal(exitCode, 0, 'one-repetition post-calibration parity can pass the routine gate');

  const allFail = await runRelease({
    config: routineConfig,
    steps: baseSteps({
      environment: routineEnvironment,
      controlledPair: async () => pairOf('openrouter-controlled', 'fail', 'fail'),
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
    qualificationRelease: true,
    trustOk: true,
  }).ok, true, 'the dedicated one-task capability qualification is an allowed non-release run');
  assert.equal(releaseInvocationPolicy({
    claimMode: 'initial-user-ship',
    qualificationRelease: true,
    diagnosticScope: true,
  }).ok, false, 'qualification cannot consume a diagnostic lock or partial denominator');
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
    pairOf('h', 'pass', 'pass', { harness: { reproducibility: { modelResolved: 'moonshotai/kimi-k2.7-code' } } })
  );
  assert.equal(fallback.fallbackDetected, true);
  assert.equal(fallback.result, 'infrastructure-invalid');
});

test('fallback contamination in an earlier response or raw repetition invalidates the causal comparison', async () => {
  const repeated = {
    host: 'openrouter-controlled',
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
    steps: baseSteps({ controlledPair: async () => repeated }),
    requiredPairs: ['openrouter-controlled'],
  });
  const pair = report.pairs.find((entry) => entry.host === 'openrouter-controlled');
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
    const pair = pairOf('openrouter-controlled', 'pass', 'pass');
    mutate(pair.harness);
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({ controlledPair: async () => pair }),
      requiredPairs: ['openrouter-controlled'],
    });
    assert.equal(exitCode, 1);
    assert.equal(report.claim.level, 'inconclusive');
    assert.equal(report.pairs.find((entry) => entry.host === 'openrouter-controlled').causallyAttributable, false);
  }

  const incomplete = pairOf('openrouter-controlled', 'pass', 'pass');
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
    const pair = pairOf('openrouter-controlled', 'pass', 'pass');
    mutate(pair.harness);
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({ controlledPair: async () => pair }),
      requiredPairs: ['openrouter-controlled'],
    });
    const result = report.pairs.find((entry) => entry.host === 'openrouter-controlled');
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
    const pair = pairOf('openrouter-controlled', 'pass', 'pass');
    mutate(pair);
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({ controlledPair: async () => pair }),
      requiredPairs: ['openrouter-controlled'],
    });
    assert.equal(report.pairs[0].causallyAttributable, false);
    assert.equal(report.claim.level, 'inconclusive');
    assert.equal(exitCode, 1);
  }
});

test('controlled identity remains invariant across repetitions and matches the declared count', () => {
  const repeated = {
    host: 'openrouter-controlled',
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
  const armDrift = pairOf('openrouter-controlled', 'pass', 'pass', {
    generic: { reproducibility: { sandbox: SANDBOX_ATTESTATION } },
    harness: {
      reproducibility: {
        sandbox: { ...SANDBOX_ATTESTATION, executionTaskHash: '4'.repeat(64) },
      },
    },
  });
  const armResult = await runRelease({
    config: SANDBOX_CONFIG,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => armDrift }),
  });
  assert.equal(armResult.report.pairs[0].result, 'infrastructure-invalid');
  assert.equal(armResult.report.pairs[0].causallyAttributable, false);
  assert.match(armResult.report.pairs[0].reason, /sandbox/i);

  const repeated = {
    host: 'openrouter-controlled',
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
    host: 'openrouter-controlled',
    expectedTask: 'cobol-modernization',
    expectedTaskRevision: 'terminal-bench@2.0',
    expectedTaskHash: 'a'.repeat(64),
    expectedSandbox: SANDBOX_LOCK,
  });
  assert.equal(drifted.result, 'infrastructure-invalid');
  assert.match(drifted.reason, /cross-repetition-sandbox/i);
});

test('a rerun with sandbox identity drift cannot confirm or clear a primary result', async () => {
  const primary = pairOf('openrouter-controlled', 'fail', 'pass', {
    generic: { reproducibility: { sandbox: SANDBOX_ATTESTATION } },
    harness: { reproducibility: { sandbox: SANDBOX_ATTESTATION } },
  });
  const rerun = rerunPairOf('openrouter-controlled', 'fail', 'pass', {
    generic: { reproducibility: { sandbox: { ...SANDBOX_ATTESTATION, executionTaskHash: '4'.repeat(64) } } },
    harness: { reproducibility: { sandbox: { ...SANDBOX_ATTESTATION, executionTaskHash: '4'.repeat(64) } } },
  });
  const { report, exitCode } = await runRelease({
    config: SANDBOX_CONFIG,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => primary, rerunControlledPair: async () => rerun }),
  });
  const pair = report.pairs[0];
  assert.equal(pair.rerun.causallyAttributable, false);
  assert.match(pair.rerun.reason, /rerun.*sandbox/i);
  assert.notEqual(pair.reproduced, true);
  assert.equal(exitCode, 1);
});

test('allocateReleaseBudgets chains the plan allowances under the release ceiling', () => {
  const budgets = allocateReleaseBudgets(CONFIG.budget);
  assert.equal(budgets.release.ceilingUsd, 10);
  assert.equal(budgets.controlledPair.ceilingUsd, 8);
  assert.equal(budgets.rerun.ceilingUsd, 2);
  budgets.controlledPair.charge(3, 'pair');
  assert.equal(budgets.release.spentUsd(), 3);
});

test('release budgets fail closed when an operational allocation is omitted', () => {
  const missingControlled = { releaseCeilingUsd: 10, rerunUsd: 2 };
  assert.throws(
    () => allocateReleaseBudgets(missingControlled),
    /controlledPairUsd is required/i
  );
  assert.equal(validateReleasePolicyConfig({ ...CONTROLLED_CONFIG, budget: missingControlled }).ok, false);
  assert.throws(
    () => allocateReleaseBudgets({ controlledPairUsd: 8, rerunUsd: 2 }),
    /releaseCeilingUsd.*explicitly configured/i
  );
  assert.throws(
    () => allocateReleaseBudgets({ releaseCeilingUsd: 10, controlledPairUsd: 8 }),
    /rerunUsd.*explicitly configured/i
  );
});

test('the controlled release lane is model-agnostic while legacy Kimi configuration remains readable', () => {
  assert.deepEqual(controlledLaneOf(LEGACY_KIMI_CONFIG), {
    host: 'openrouter-kimi',
    profileId: 'kimi-k2.7-code',
  });
  assert.deepEqual(controlledLaneOf(CONTROLLED_CONFIG), {
    host: 'openrouter-controlled',
    profileId: 'kimi-k2.7-code',
  });
  assert.throws(() => controlledLaneOf({}), /controlledLane.*required/i);
  assert.equal(validateReleasePolicyConfig(CONTROLLED_CONFIG).ok, true);
  assert.equal(validateReleasePolicyConfig(LEGACY_KIMI_CONFIG).ok, true);
  assert.equal(validateReleasePolicyConfig({
    ...CONTROLLED_CONFIG,
    controlledLane: { host: 'openrouter-controlled' },
  }).ok, false);
  assert.equal(validateReleasePolicyConfig({
    ...CONTROLLED_CONFIG,
    controlledLane: { host: 'openrouter-controlled', profileId: 'gemma-4-26b-local' },
  }).ok, false);
  assert.equal(validateReleasePolicyConfig({
    ...CONTROLLED_CONFIG,
    budget: { ...CONTROLLED_CONFIG.budget, kimiPairUsd: 8.4 },
  }).ok, false, 'ambiguous legacy and neutral allowances fail closed');
});

test('qualification exposure reserves only the primary pair when reruns are disabled', () => {
  assert.deepEqual(releaseScheduledExposure({
    taskCount: 1,
    repetitions: 1,
    controlledArmCeilingUsd: 0.65,
    rerunEnabled: false,
  }), {
    primaryExposureUsd: 1.3,
    rerunExposureUsd: 0,
  });
});

test('neutral controlled budgets preserve a legacy alias without Kimi-specific labels', () => {
  const budgets = allocateReleaseBudgets(CONTROLLED_CONFIG.budget);
  assert.equal(budgets.controlledPair.ceilingUsd, 8.4);
  assert.equal(budgets.controlledPair.label, 'controlled-pair');
  assert.equal(budgets.kimiPair, budgets.controlledPair, 'historical callers share the same allowance');
  assert.equal(budgets.rerun.label, 'controlled-rerun');
  assert.deepEqual(
    scaleReleaseBudget(CONTROLLED_CONFIG.budget, 18.7),
    { releaseCeilingUsd: 18.7, controlledPairUsd: 15.708, rerunUsd: 2.992 }
  );
});

test('runRelease schedules the configured controlled host and records its profile identity', async () => {
  const steps = baseSteps({
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass'),
  });
  const { report } = await runRelease({ config: CONTROLLED_CONFIG, steps });
  assert.deepEqual(report.controlledLane, {
    host: 'openrouter-controlled',
    profileId: 'kimi-k2.7-code',
    billingProfileHash: billingProfileHash('kimi-k2.7-code'),
  });
  assert.ok(report.pairs.some((pair) => pair.host === 'openrouter-controlled'));
  assert.equal(report.budget.allocations.controlledPairUsd, 8.4);
});

test('qualification evidence blocks an all-fail model but accepts either-arm capability', async () => {
  const zeroProviderBaseline = {
    byteSha256: '1'.repeat(64),
    reportHash: '2'.repeat(64),
    lifecycleHash: '3'.repeat(64),
    artifactHash: '4'.repeat(64),
  };
  const qualificationConfig = {
    ...CONTROLLED_CONFIG,
    zeroProviderBaseline,
    evaluationScope: { ...TRUSTED_SCOPE, mode: 'qualification', releaseEligible: false },
    budget: {
      releaseCeilingUsd: 1.3,
      controlledPairUsd: 1.3,
      rerunUsd: 0,
      providerHardLimitUsd: 20,
      controlledArmCeilingUsd: 0.65,
      qualificationPairUsd: 1.3,
      calibrationCeilingUsd: 18.7,
    },
    claimPolicy: {
      mode: 'initial-user-ship',
      minimumHarnessSolvedTasks: 2,
      qualificationTask: 'cobol-modernization',
    },
  };
  const makeReport = async (generic, harness) => (await runRelease({
    config: qualificationConfig,
    releaseSha: 'abc123',
    harnessVersion: '0.5.0',
    steps: baseSteps({
      environment: async () => ({
        ok: true,
        missing: [],
        providerSpendGuard: {
          verified: true,
          required: true,
          limitUsd: 20,
          limitRemainingUsd: 20,
          reset: null,
          ceilingUsd: 1.3,
          hardLimitUsd: 20,
          keyFingerprint: '9'.repeat(64),
          checkedAt: '2026-07-31T00:00:00.000Z',
        },
      }),
      controlledPair: async () => repeatedPairOf('openrouter-controlled', generic, harness),
      rerunControlledPair: null,
    }),
  })).report;
  const options = {
    evidenceHash: 'f'.repeat(64),
    releaseSha: 'abc123',
    harnessVersion: '0.5.0',
    controlledLane: CONTROLLED_CONFIG.controlledLane,
    qualificationTask: 'cobol-modernization',
    requiredTaskSet: qualificationConfig.task.taskSet,
    maximumQualificationUsd: 1.3,
    controlledArmCeilingUsd: 0.65,
    expectedProviderHardLimitUsd: 20,
  };

  const allFail = qualificationBaselineVerdict(await makeReport('fail', 'fail'), options);
  assert.equal(allFail.valid, false);
  assert.equal(allFail.capability, 'inconclusive');
  assert.ok(allFail.reasons.some((reason) => /neither arm.*verifier pass/i.test(reason)));

  const harnessPass = qualificationBaselineVerdict(await makeReport('fail', 'pass'), options);
  assert.equal(harnessPass.valid, true, harnessPass.reasons.join('; '));
  assert.equal(harnessPass.capability, 'qualified');
  assert.equal(harnessPass.passingArm, 'harness');
  assert.equal(harnessPass.providerKeyFingerprint, '9'.repeat(64));
  assert.deepEqual(harnessPass.zeroProviderBaseline, zeroProviderBaseline,
    'later calibration retains the exact zero-provider evidence chain');
  assert.deepEqual((await makeReport('fail', 'pass')).zeroProviderBaseline, zeroProviderBaseline,
    'the paid qualification report records the exact durable-evidence hashes');

  const missingZeroChain = structuredClone(await makeReport('fail', 'pass'));
  missingZeroChain.zeroProviderBaseline = null;
  const missingZeroChainVerdict = qualificationBaselineVerdict(missingZeroChain, {
    ...options,
    requireZeroProviderBaseline: true,
  });
  assert.equal(missingZeroChainVerdict.valid, false,
    'an older qualification artifact cannot unlock a new calibration');
  assert.ok(missingZeroChainVerdict.reasons.some((reason) =>
    /zero-provider baseline chain is missing or malformed/i.test(reason)));
  assert.match(
    buildMarkdownReport(await makeReport('fail', 'pass')),
    /\| calibration prerequisite \|/i,
    'the required capability gate must not be mislabeled as a merely informational pair'
  );

  const missingRawEvidence = structuredClone(await makeReport('fail', 'pass'));
  for (const arm of ['generic', 'harness']) missingRawEvidence.pairs[0][arm].repetitions = [];
  missingRawEvidence.pairs[0].harness.correctness.verdict = 'pass';
  missingRawEvidence.pairs[0].harness.correctness.verifierReward = 1;
  const missingRawVerdict = qualificationBaselineVerdict(missingRawEvidence, options);
  assert.equal(missingRawVerdict.valid, false);
  assert.ok(missingRawVerdict.reasons.some((reason) => /retained raw repetition/i.test(reason)));

  const unsafeRawEvidence = structuredClone(await makeReport('fail', 'pass'));
  unsafeRawEvidence.pairs[0].harness.repetitions[0].harnessBehavior.policyBypassAchieved = true;
  const unsafeRawVerdict = qualificationBaselineVerdict(unsafeRawEvidence, options);
  assert.equal(unsafeRawVerdict.valid, false);
  assert.ok(unsafeRawVerdict.reasons.some((reason) => /safety|policy bypass/i.test(reason)));

  const missingValidity = structuredClone(await makeReport('fail', 'pass'));
  delete missingValidity.pairs[0].harness.repetitions[0].trialValidity;
  const missingValidityVerdict = qualificationBaselineVerdict(missingValidity, options);
  assert.equal(missingValidityVerdict.valid, false);
  assert.ok(missingValidityVerdict.reasons.some((reason) => /same-model controlled comparison|validity/i.test(reason)));

  const forgedReward = structuredClone(await makeReport('fail', 'pass'));
  forgedReward.pairs[0].harness.repetitions[0].correctness.verifierReward = 0.1;
  const forgedRewardVerdict = qualificationBaselineVerdict(forgedReward, options);
  assert.equal(forgedRewardVerdict.valid, false);
  assert.ok(forgedRewardVerdict.reasons.some((reason) => /locked passing reward/i.test(reason)));

  const taskIdentityDrift = structuredClone(await makeReport('fail', 'pass'));
  taskIdentityDrift.task.taskSet[0].taskChecksum = 'b'.repeat(64);
  taskIdentityDrift.task.requiredTaskSet[0].taskChecksum = 'b'.repeat(64);
  for (const arm of ['generic', 'harness']) {
    const document = taskIdentityDrift.pairs[0][arm];
    const trials = document.repetitions.length > 0 ? document.repetitions : [document];
    for (const trial of trials) {
      trial.reproducibility.taskHash = 'b'.repeat(64);
    }
  }
  const driftedTask = qualificationBaselineVerdict(taskIdentityDrift, options);
  assert.equal(driftedTask.valid, false);
  assert.ok(driftedTask.reasons.some((reason) => /task identities do not match/i.test(reason)));

  const armCeilingDrift = structuredClone(await makeReport('fail', 'pass'));
  armCeilingDrift.pairs[0].harness.repetitions[0].reproducibility.trialCeilingUsd = 0.5;
  const driftedCeiling = qualificationBaselineVerdict(armCeilingDrift, options);
  assert.equal(driftedCeiling.valid, false);
  assert.ok(driftedCeiling.reasons.some((reason) => /per-arm ceiling/i.test(reason)));

  const aggregateContradictsRaw = structuredClone(await makeReport('fail', 'fail'));
  const retainedGeneric = structuredClone(aggregateContradictsRaw.pairs[0].generic);
  retainedGeneric.repetitions = [];
  aggregateContradictsRaw.pairs[0].generic.repetitions = [retainedGeneric];
  aggregateContradictsRaw.pairs[0].generic.correctness.verdict = 'pass';
  aggregateContradictsRaw.pairs[0].generic.correctness.verifierReward = 1;
  aggregateContradictsRaw.qualification = {
    capability: 'qualified',
    passingArm: 'generic',
    task: 'cobol-modernization',
    reason: 'forged aggregate',
  };
  const contradictory = qualificationBaselineVerdict(aggregateContradictsRaw, options);
  assert.equal(contradictory.valid, false);
  assert.ok(contradictory.reasons.some((reason) => /retained verifier pass|neither arm/i.test(reason)));

  const understatedBudget = structuredClone(await makeReport('fail', 'pass'));
  understatedBudget.budget.spentUsd = 0;
  understatedBudget.budget.knownReconciledSpendUsd = 0;
  understatedBudget.budget.retainedReconciledSpendUsd = 0;
  understatedBudget.budget.accountedExposureUsd = 0;
  understatedBudget.budget.chargeLedgerMatchesRetainedEvidence = true;
  const understated = qualificationBaselineVerdict(understatedBudget, options);
  assert.equal(understated.valid, false);
  assert.ok(understated.reasons.some((reason) => /retained.*cost|exposure.*reconcile/i.test(reason)));

  const switchedKey = structuredClone(await makeReport('fail', 'pass'));
  switchedKey.budget.providerSpendGuard.keyFingerprint = '8'.repeat(64);
  const switchedKeyVerdict = qualificationBaselineVerdict(switchedKey, {
    ...options,
    expectedProviderKeyFingerprint: '9'.repeat(64),
  });
  assert.equal(switchedKeyVerdict.valid, false);
  assert.ok(switchedKeyVerdict.reasons.some((reason) => /provider key|credential/i.test(reason)));
});

test('qualification honors a non-default verifier threshold end to end', async () => {
  const passingReward = 0.5;
  const qualificationConfig = {
    ...CONTROLLED_CONFIG,
    evaluationScope: { ...TRUSTED_SCOPE, mode: 'qualification', releaseEligible: false },
    task: { ...CONTROLLED_CONFIG.task, verifierPassingReward: passingReward },
    budget: {
      releaseCeilingUsd: 1.3,
      controlledPairUsd: 1.3,
      rerunUsd: 0,
      providerHardLimitUsd: 20,
      controlledArmCeilingUsd: 0.65,
      qualificationPairUsd: 1.3,
      calibrationCeilingUsd: 18.7,
    },
    claimPolicy: {
      mode: 'initial-user-ship',
      minimumHarnessSolvedTasks: 2,
      qualificationTask: 'cobol-modernization',
    },
  };
  const { report, exitCode } = await runRelease({
    config: qualificationConfig,
    releaseSha: 'abc123',
    harnessVersion: '0.5.0',
    steps: baseSteps({
      environment: async () => ({
        ok: true,
        missing: [],
        providerSpendGuard: {
          verified: true,
          required: true,
          limitUsd: 20,
          limitRemainingUsd: 20,
          reset: null,
          ceilingUsd: 1.3,
          hardLimitUsd: 20,
          keyFingerprint: '9'.repeat(64),
          checkedAt: '2026-07-31T00:00:00.000Z',
        },
      }),
      controlledPair: async () => {
        const pair = repeatedPairOf('openrouter-controlled', 'fail', 'pass');
        for (const document of [pair.harness, ...pair.harness.repetitions]) {
          document.correctness.verifierReward = 0.75;
        }
        return pair;
      },
      rerunControlledPair: null,
    }),
  });
  assert.equal(report.qualification.capability, 'qualified');
  assert.equal(report.qualification.passingArm, 'harness');
  assert.equal(report.telemetryComplete, true);
  assert.equal(report.pairs[0].efficiencyDelta.pairedRepetitions, 1);
  assert.equal(exitCode, 1, 'qualification establishes capability but cannot green a release');
  assert.ok(report.gate.reasons.some((reason) => /qualification.*cannot green/i.test(reason)));
  const baseline = qualificationBaselineVerdict(report, {
    evidenceHash: 'f'.repeat(64),
    releaseSha: 'abc123',
    harnessVersion: '0.5.0',
    controlledLane: qualificationConfig.controlledLane,
    qualificationTask: 'cobol-modernization',
    requiredTaskSet: qualificationConfig.task.taskSet,
    maximumQualificationUsd: 1.3,
    controlledArmCeilingUsd: 0.65,
    expectedProviderHardLimitUsd: 20,
    verifierPassingReward: passingReward,
  });
  assert.equal(baseline.valid, true, baseline.reasons.join('; '));
});

test('controlled evidence is bound to the selected profile routing, not only same across arms', async () => {
  const pair = pairOf('openrouter-controlled', 'pass', 'pass');
  for (const doc of [pair.generic, pair.harness]) {
    doc.reproducibility.providerRequestedOrder = ['attacker/route'];
    doc.reproducibility.providerExpectedResolvedNames = ['Attacker Route'];
    doc.reproducibility.providerResolved = 'Attacker Route';
    for (const event of doc.observability.providerEvents.filter((entry) => entry.type === 'response')) {
      event.provider = 'Attacker Route';
    }
  }
  const { report } = await runRelease({
    config: CONTROLLED_CONFIG,
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
      controlledPair: async () => pair,
    }),
  });
  const controlled = report.pairs.find((entry) => entry.host === 'openrouter-controlled');
  assert.equal(controlled.causallyAttributable, false);
  assert.match(controlled.classification.reason, /profile|provider.*order|identity mismatch/i);
});

test('one release evaluation stays below the 18.70 USD calibration cap while staged evidence stays below 20 USD', () => {
  assert.throws(() => allocateReleaseBudgets({ ...CONFIG.budget, releaseCeilingUsd: 20.01 }), /18\.7/);
  assert.equal(allocateReleaseBudgets({ ...CONFIG.budget, releaseCeilingUsd: 10 }).release.ceilingUsd, 10);
  assert.equal(validateReleasePolicyConfig({
    ...CONTROLLED_CONFIG,
    budget: { ...CONTROLLED_CONFIG.budget, providerHardLimitUsd: 9 },
  }).ok, false, 'the provider hard cap cannot be lower than scheduled release exposure');
  assert.equal(validateReleasePolicyConfig({
    ...CONTROLLED_CONFIG,
    budget: {
      ...CONTROLLED_CONFIG.budget,
      providerHardLimitUsd: 19,
      qualificationPairUsd: 1.3,
      calibrationCeilingUsd: 18.7,
    },
  }).ok, false, 'the staged initial evidence ceilings must fit the shared provider hard cap');
});

test('raising the release ceiling cannot exceed the single-run calibration cap', () => {
  const base = { releaseCeilingUsd: 10, controlledPairUsd: 8, rerunUsd: 2 };
  assert.deepEqual(scaleReleaseBudget(base, 10), base);
  assert.deepEqual(scaleReleaseBudget(base, 18.7), { releaseCeilingUsd: 18.7, controlledPairUsd: 14.96, rerunUsd: 3.74 });
  assert.throws(() => scaleReleaseBudget(base, 18.71), /18\.7/);
  assert.deepEqual(
    scaleReleaseBudget({ ...base, providerHardLimitUsd: 20 }, 18.7),
    { releaseCeilingUsd: 18.7, controlledPairUsd: 14.96, rerunUsd: 3.74, providerHardLimitUsd: 20 },
    'scheduler allocations scale while the shared initial-evidence cash cap remains fixed'
  );
  assert.deepEqual(
    scaleReleaseBudget(LEGACY_KIMI_CONFIG.budget, 10),
    LEGACY_KIMI_CONFIG.budget,
    'legacy budget input is normalized only at the compatibility boundary'
  );
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

test('efficiency evidence uses the locked verifier threshold and accepts rewards above it', async () => {
  const aboveThresholdGeneric = fullRun('generic', 'pass');
  const aboveThresholdHarness = fullRun('harness', 'pass');
  aboveThresholdGeneric.correctness.verifierReward = 0.75;
  aboveThresholdHarness.correctness.verifierReward = 0.75;
  const aboveThreshold = efficiencyDelta(
    aboveThresholdGeneric,
    aboveThresholdHarness,
    CONFIG.efficiencyThresholds,
    CONFIG.valueThresholds,
    0.5
  );
  assert.equal(aboveThreshold.pairedRepetitions, 1,
    '0.75 passes the locked 0.5 threshold even though it would fail the default threshold of 1');

  const passingReward = 100;
  const pair = pairOf('openrouter-controlled', 'pass', 'pass');
  for (const document of [pair.generic, pair.harness]) {
    document.correctness.verifierReward = passingReward;
  }
  const rewardConfig = {
    ...CONFIG,
    task: { ...CONFIG.task, verifierPassingReward: passingReward },
  };
  const { report, exitCode } = await runRelease({
    config: rewardConfig,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => pair }),
  });
  const controlled = report.pairs.find((entry) => entry.host === 'openrouter-controlled');
  assert.equal(controlled.efficiencyDelta.pairedRepetitions, 1);
  assert.equal(controlled.efficiencyDelta.evidenceComplete, true);
  assert.equal(exitCode, 0, report.gate.reasons.join('; '));

  const belowConfiguredThreshold = pairOf('openrouter-controlled', 'pass', 'pass');
  const strictConfig = {
    ...CONFIG,
    task: { ...CONFIG.task, verifierPassingReward: 2 },
  };
  const strict = await runRelease({
    config: strictConfig,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => belowConfiguredThreshold }),
  });
  assert.equal(strict.report.telemetryComplete, false,
    'reward 1 must fail the configured threshold of 2 even though it passes the default threshold');
  assert.equal(strict.exitCode, 1);
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
  const expensiveWin = pairOf('openrouter-controlled', 'fail', 'pass', {
    harness: {
      efficiency: {
        wallTimeMs: 660_001,
      },
    },
  });
  setProviderReportedCost(expensiveWin.harness, 2.03);
  const { report, exitCode } = await runRelease({
    config: valueConfig,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({
      controlledPair: async () => expensiveWin,
      rerunControlledPair: async () => {
        rerunCalls += 1;
        return rerunPairOf('openrouter-controlled', 'fail', 'pass');
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
      requiredPairs: ['openrouter-controlled'],
      steps: baseSteps({
        controlledPair: async () => pairOf('openrouter-controlled', 'fail', 'pass'),
        rerunControlledPair: async () => rerunPairOf('openrouter-controlled', 'fail', 'pass', {
          harness: { efficiency: harnessEfficiency },
        }),
      }),
    });
    const pair = report.pairs.find((entry) => entry.host === 'openrouter-controlled');
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
  budgets.controlledPair.charge(10, 'primary');
  budgets.rerun.charge(8, 'fresh pair');
  assert.equal(budgets.release.spentUsd(), 18);
});

test('gate policy blocks on deterministic regressions, safety, telemetry, and pinning', () => {
  const base = { deterministic: { passed: 17, failed: 0, skipped: 2 }, pairs: [], telemetryComplete: true, taskLockOk: true, environmentOk: true, calibrationRelease: false };
  assert.equal(applyGatePolicy(base).block, false);
  assert.equal(applyGatePolicy({ ...base, deterministic: { passed: 16, failed: 1, skipped: 2 } }).block, true);
  assert.equal(applyGatePolicy({ ...base, telemetryComplete: false }).block, true);
  assert.equal(applyGatePolicy({ ...base, taskLockOk: false }).block, true);
  const safetyPair = { host: 'openrouter-controlled', gateActive: false, classification: { result: 'harness-regression', safety: true, fallbackDetected: false }, reproduced: null };
  assert.equal(applyGatePolicy({ ...base, calibrationRelease: true, pairs: [safetyPair] }).block, true, 'safety blocks even in calibration on an inactive gate');
});

test('gate policy blocks a reproduced regression and a fallback only on active gates', () => {
  const base = { deterministic: { passed: 1, failed: 0, skipped: 0 }, telemetryComplete: true, taskLockOk: true, environmentOk: true, calibrationRelease: false };
  const regression = { host: 'openrouter-controlled', gateActive: true, classification: { result: 'harness-regression', safety: false, fallbackDetected: false }, reproduced: true };
  assert.equal(applyGatePolicy({ ...base, pairs: [regression] }).block, true);
  const inactive = { ...regression, gateActive: false };
  assert.equal(applyGatePolicy({ ...base, pairs: [inactive] }).block, false);
  const fallback = { host: 'openrouter-controlled', gateActive: true, classification: { result: 'parity', safety: false, fallbackDetected: true }, reproduced: null };
  assert.equal(applyGatePolicy({ ...base, pairs: [fallback] }).block, true);
  assert.equal(applyGatePolicy({ ...base, pairs: [{ ...fallback, gateActive: false }] }).block, false);
});

test('an all-green release produces a schema-valid report and exit code 0', async () => {
  const { report, exitCode } = await runRelease({ config: CONFIG, steps: baseSteps(), releaseSha: 'abc123', harnessVersion: '0.5.0' });
  assert.equal(exitCode, 0);
  assert.deepEqual(validateAgainstSchema(report, REPORT_SCHEMA).errors, []);
  const controlled = report.pairs.find((p) => p.host === 'openrouter-controlled');
  assert.equal(controlled.result, 'parity');
  assert.equal(controlled.comparisonTrack, 'controlled-ablation');
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
    ['budget.providerSpendGuard.hardLimitUsd', '20'],
    ['budget.providerSpendGuard.keyFingerprint', 20],
    ['budget.providerSpendGuard.observedKeyConsumedUsd', -1],
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

  const zeroChain = {
    byteSha256: '1'.repeat(64),
    reportHash: '2'.repeat(64),
    lifecycleHash: '3'.repeat(64),
    artifactHash: '4'.repeat(64),
  };
  const chained = structuredClone(report);
  chained.zeroProviderBaseline = zeroChain;
  chained.qualificationBaseline = {
    valid: true,
    capability: 'qualified',
    passingArm: 'harness',
    evidenceHash: '5'.repeat(64),
    task: 'cobol-modernization',
    accountedExposureUsd: 0.5,
    providerKeyFingerprint: '6'.repeat(64),
    zeroProviderBaseline: zeroChain,
    reasons: [],
  };
  assert.equal(validateAgainstSchema(chained, REPORT_SCHEMA).ok, true);
  for (const location of ['zeroProviderBaseline', 'qualificationBaseline.zeroProviderBaseline']) {
    const malformed = structuredClone(chained);
    const target = location === 'zeroProviderBaseline'
      ? malformed.zeroProviderBaseline
      : malformed.qualificationBaseline.zeroProviderBaseline;
    target.byteSha256 = 7;
    const verdict = validateAgainstSchema(malformed, REPORT_SCHEMA);
    assert.equal(verdict.ok, false, `${location}.byteSha256 must be a SHA-256 string`);
    assert.ok(verdict.errors.some((error) => error.includes(`${location}.byteSha256`)));
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
    let controlledCalled = false;
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({
        environment: async () => ({ ok: true, missing: [], ...(providerSpendGuard ? { providerSpendGuard } : {}) }),
        controlledPair: async () => {
          controlledCalled = true;
          return pairOf('openrouter-controlled', 'pass', 'pass');
        },
      }),
      requiredPairs: ['openrouter-controlled'],
    });
    assert.equal(controlledCalled, false);
    assert.equal(report.budget.providerSpendGuard.verified, false);
    assert.equal(exitCode, 1);
    assert.ok(report.gate.reasons.some((reason) => /dependencies|credentials|openrouter-controlled/i.test(reason)));
  }
});

test('calibration independently enforces the shared 20 USD key identity and remaining allowance', async () => {
  const fingerprint = '9'.repeat(64);
  const config = {
    ...CONTROLLED_CONFIG,
    evaluationScope: { ...TRUSTED_SCOPE, mode: 'calibration', releaseEligible: true },
    budget: {
      releaseCeilingUsd: 18.7,
      controlledPairUsd: 17,
      rerunUsd: 1.6,
      providerHardLimitUsd: 20,
      controlledArmCeilingUsd: 0.65,
      qualificationPairUsd: 1.3,
      calibrationCeilingUsd: 18.7,
    },
    claimPolicy: {
      mode: 'initial-user-ship',
      minimumHarnessSolvedTasks: 1,
      requireQualificationBaseline: true,
      qualificationTask: 'cobol-modernization',
    },
    qualificationBaseline: {
      valid: true,
      providerKeyFingerprint: fingerprint,
      reasons: [],
    },
  };
  const providerSpendGuard = (providerKeyFingerprint, limitRemainingUsd = 18.9) => ({
    verified: true,
    required: true,
    limitUsd: 20,
    limitRemainingUsd,
    reset: null,
    ceilingUsd: 18.7,
    hardLimitUsd: 20,
    keyFingerprint: providerKeyFingerprint,
    checkedAt: '2026-07-31T00:00:00.000Z',
  });

  let controlledCalled = false;
  const accepted = await runRelease({
    config,
    calibrationRelease: true,
    steps: baseSteps({
      environment: async () => ({
        ok: true,
        missing: [],
        providerSpendGuard: providerSpendGuard(fingerprint),
      }),
      controlledPair: async () => {
        controlledCalled = true;
        return pairOf('openrouter-controlled', 'pass', 'pass');
      },
    }),
  });
  assert.equal(controlledCalled, true);
  assert.equal(accepted.report.budget.providerSpendGuard.verified, true);
  assert.equal(accepted.report.budget.providerSpendGuard.keyFingerprint, fingerprint);

  for (const guard of [
    providerSpendGuard('8'.repeat(64)),
    providerSpendGuard(fingerprint, 18.69),
  ]) {
    let attempted = false;
    const rejected = await runRelease({
      config,
      calibrationRelease: true,
      steps: baseSteps({
        environment: async () => ({ ok: true, missing: [], providerSpendGuard: guard }),
        controlledPair: async () => {
          attempted = true;
          return pairOf('openrouter-controlled', 'pass', 'pass');
        },
      }),
    });
    assert.equal(attempted, false);
    assert.equal(rejected.report.budget.providerSpendGuard.verified, false);
  }
});

test('required multi-repetition evidence is validated per retained trial instead of comparing medians to summed events', async () => {
  const repeatedPair = {
    host: 'openrouter-controlled',
    task: 'cobol-modernization',
    pairId: 'pair-1',
    repetitionCount: 3,
    generic: repeatedRun('generic', 'pass'),
    harness: repeatedRun('harness', 'pass'),
    failureKind: null,
  };
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ controlledPair: async () => repeatedPair }),
    requiredPairs: ['openrouter-controlled'],
  });
  assert.equal(exitCode, 0, report.gate.reasons.join('; '));
  assert.equal(report.pairs.find((pair) => pair.host === 'openrouter-controlled').repetitionCount, 3);
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
    host: 'openrouter-controlled',
    task: 'cobol-modernization',
    pairId: 'pair-1',
    repetitionCount: 3,
    generic: withVerdicts('generic', ['fail', 'fail', 'pass']),
    harness: withVerdicts('harness', ['pass', 'fail', 'pass']),
    failureKind: null,
  };
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => mixed }),
  });
  const pair = report.pairs.find((entry) => entry.host === 'openrouter-controlled');
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
    host: 'openrouter-controlled',
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
  const expensive = pairOf('openrouter-controlled', 'pass', 'pass', {
    harness: { efficiency: { promptTokens: 2001 } },
  });
  expensive.harness.observability.providerEvents
    .find((event) => event.type === 'response').usage.promptTokens += 1001;
  const changedUsage = expensive.harness.observability.providerEvents
    .find((event) => event.type === 'response').usage;
  changedUsage.localCostUsd += (1001 * 0.95) / 1_000_000;
  expensive.harness.efficiency.localCostUsd += (1001 * 0.95) / 1_000_000;
  expensive.harness.economics = completeEconomicsFor(expensive.harness.efficiency);
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ controlledPair: async () => expensive }),
    requiredPairs: ['openrouter-controlled'],
  });
  const controlled = report.pairs.find((pair) => pair.host === 'openrouter-controlled');
  assert.equal(controlled.efficiencyDelta.withinThresholds, false);
  assert.ok(controlled.efficiencyDelta.breaches.includes('promptRatio'));
  assert.equal(report.claim.level, 'regression');
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /prompt.*ratio|efficiency/i.test(reason)));
});

test('an actual provider reconciliation above the absolute ceiling is retained and blocks', async () => {
  const steps = baseSteps({
    controlledPair: async (budget) => {
      budget.charge(11, 'unexpected provider reconciliation');
      return pairOf('openrouter-controlled', 'pass', 'pass');
    },
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
  assert.equal(report.budget.spentUsd, 11);
  assert.equal(report.budget.breached, true);
  assert.equal(report.budget.overrunUsd, 1);
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /budget.*exceeded/i.test(reason)));
});

test('unknown billing is reported as reserved exposure rather than known spend', async () => {
  const steps = baseSteps({
    controlledPair: async (budget) => {
      budget.charge(0.25, 'known response');
      budget.reserve(4.75, 'ambiguous response');
      return pairOf('openrouter-controlled', 'pass', 'pass', {
        failureKind: 'provider',
        harness: { efficiency: { billingUncertain: true, billingComplete: false, costComplete: false } },
      });
    },
  });
  const { report } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
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
    steps: baseSteps({ controlledPair: async () => pairOf('openrouter-controlled', 'fail', 'pass') }),
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
      controlledPair: async () => pairOf('openrouter-controlled', 'fail', 'pass'),
      rerunControlledPair: async () => {
        rerunCalls += 1;
        return rerunPairOf('openrouter-controlled', 'fail', 'pass');
      },
    }),
  });
  assert.equal(rerunCalls, 1);
  assert.equal(report.claim.level, 'demonstrated-value');
  assert.equal(report.claim.controlledWins, 1);
  assert.equal(report.claim.confirmedWins, 1);
  assert.equal(report.pairs.find((pair) => pair.host === 'openrouter-controlled').reproduced, true);
});

test('win confirmation shares the hard ten-dollar release ceiling', async () => {
  const routineConfig = {
    ...CONFIG,
    budget: { releaseCeilingUsd: 10, controlledPairUsd: 8, rerunUsd: 2, reserveUsd: 2 },
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
      controlledPair: async (budget) => {
        budget.charge(8, 'all primary arms');
        const pair = pairOf('openrouter-controlled', 'fail', 'pass');
        setProviderReportedCost(pair.generic, 4);
        setProviderReportedCost(pair.harness, 4);
        return pair;
      },
      rerunControlledPair: async (budget) => {
        budget.charge(2, 'fresh paired confirmation');
        const pair = rerunPairOf('openrouter-controlled', 'fail', 'pass');
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
  let controlledCalled = false;
  const steps = baseSteps({
    deterministic: async () => ({ passed: 15, failed: 2, skipped: 2 }),
    controlledPair: async () => {
      controlledCalled = true;
      return pairOf('openrouter-controlled', 'pass', 'pass');
    },
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(exitCode, 1);
  assert.equal(controlledCalled, false, 'no provider spend after a deterministic failure');
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-controlled').result, 'skipped');
});

test('a controlled baseline-pass/harness-fail reruns one full fresh pair and blocks when it reproduces', async () => {
  let rerunCalls = 0;
  const steps = baseSteps({
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'fail'),
    rerunControlledPair: async () => {
      rerunCalls += 1;
      return rerunPairOf('openrouter-controlled', 'pass', 'fail');
    },
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(rerunCalls, 1, 'exactly one full-pair rerun, never treatment-only');
  const controlled = report.pairs.find((p) => p.host === 'openrouter-controlled');
  assert.equal(controlled.result, 'harness-regression');
  assert.equal(controlled.reproduced, true);
  assert.equal(controlled.rerun.result, 'harness-regression');
  assert.equal(controlled.rerun.causallyAttributable, true);
  assert.equal(controlled.rerun.generic.correctness.verdict, 'pass');
  assert.equal(controlled.rerun.harness.correctness.verdict, 'fail');
  assert.equal(exitCode, 1);
});

test('an unreproduced controlled regression is flaky-inconclusive and does not block', async () => {
  const steps = baseSteps({
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'fail'),
    rerunControlledPair: async () => rerunPairOf('openrouter-controlled', 'pass', 'pass'),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  const controlled = report.pairs.find((p) => p.host === 'openrouter-controlled');
  assert.equal(controlled.result, 'flaky-inconclusive');
  assert.equal(controlled.reproduced, false);
  assert.equal(controlled.rerun.result, 'parity');
  assert.equal(controlled.rerun.causallyAttributable, true);
  assert.equal(exitCode, 0);
});

test('an invalid, incomplete, fallback-contaminated, or policy-regressing rerun cannot clear the original regression', async () => {
  const invalidReruns = [
    () => rerunPairOf('openrouter-controlled', 'pass', 'pass', { failureKind: 'provider' }),
    () => {
      const pair = rerunPairOf('openrouter-controlled', 'pass', 'pass');
      pair.harness.efficiency.costComplete = false;
      return pair;
    },
    () => {
      const pair = rerunPairOf('openrouter-controlled', 'pass', 'pass');
      pair.harness.observability.providerEvents.find((event) => event.type === 'response').provider = 'DeepInfra';
      return pair;
    },
    () => rerunPairOf('openrouter-controlled', 'pass', 'pass', { harness: { efficiency: { promptTokens: 2001 } } }),
  ];
  for (const rerun of invalidReruns) {
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({
        controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'fail'),
        rerunControlledPair: async () => rerun(),
      }),
    });
    const pair = report.pairs.find((entry) => entry.host === 'openrouter-controlled');
    assert.equal(pair.result, 'harness-regression');
    assert.equal(pair.reproduced, null);
    assert.ok(pair.rerun?.generic && pair.rerun?.harness, 'invalid rerun evidence remains available for audit');
    assert.match(pair.reason, /invalid|unresolved|attribut/i);
    assert.equal(exitCode, 1);
  }
});

test('a rerun for another task or without a fresh attempt identity cannot clear a regression', async () => {
  const invalidReruns = [
    rerunPairOf('openrouter-controlled', 'pass', 'pass', {
      task: 'build-pmars',
      generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
      harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
    }),
    pairOf('openrouter-controlled', 'pass', 'pass'),
    rerunPairOf('openrouter-controlled', 'pass', 'pass', { pairId: 'pair-1' }),
    rerunPairOf('openrouter-controlled', 'pass', 'pass', {
      harness: { reproducibility: { conditionHash: 'f'.repeat(64) } },
    }),
  ];

  for (const rerun of invalidReruns) {
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({
        controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'fail'),
        rerunControlledPair: async () => rerun,
      }),
    });
    const pair = report.pairs.find((entry) => entry.host === 'openrouter-controlled');
    assert.equal(pair.result, 'harness-regression');
    assert.equal(pair.reproduced, null);
    assert.equal(pair.rerun.causallyAttributable, false);
    assert.match(pair.rerun.reason, /identity/i);
    assert.equal(exitCode, 1);
  }
});

test('calibration keeps pair gates informational but can never green a release', async () => {
  const steps = baseSteps({
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'fail'),
    rerunControlledPair: async () => rerunPairOf('openrouter-controlled', 'pass', 'fail'),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, calibrationRelease: true });
  assert.equal(exitCode, 1);
  assert.equal(report.calibrationRelease, true);
  assert.equal(report.evaluationScope.mode, 'calibration');
  assert.equal(report.evaluationScope.releaseEligible, false);
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-controlled').gateActive, false);
  assert.ok(report.gate.reasons.some((reason) => /calibration.*not eligible/i.test(reason)));
});

test('a calibration baseline is recomputed from raw paired evidence and must demonstrate policy-clean value', async () => {
  const calibrationConfig = {
    ...CONFIG,
    evaluationScope: { ...TRUSTED_SCOPE, mode: 'calibration', releaseEligible: true },
    budget: {
      ...CONFIG.budget,
      controlledArmCeilingUsd: 0.65,
      qualificationPairUsd: 1.3,
      calibrationCeilingUsd: 18.7,
    },
    claimPolicy: {
      mode: 'initial-user-ship',
      minimumHarnessSolvedTasks: 1,
      requireCalibrationBaseline: false,
      minimumCalibrationRepetitions: 3,
    },
    repetitions: { calibration: 3, routine: 1 },
  };
  const calibrationPair = {
    host: 'openrouter-controlled',
    task: 'cobol-modernization',
    pairId: 'pair-1',
    repetitionCount: 3,
    generic: repeatedRun('generic', 'fail'),
    harness: repeatedRun('harness', 'pass'),
    failureKind: null,
  };
  const { report } = await runRelease({
    config: calibrationConfig,
    calibrationRelease: true,
    releaseSha: 'abc123',
    harnessVersion: '0.5.0',
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => calibrationPair }),
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

  const strictVerifier = calibrationBaselineVerdict(report, {
    ...options,
    verifierPassingReward: 2,
  });
  assert.equal(strictVerifier.valid, false,
    'retained reward 1 must fail a locked threshold of 2 instead of falling back to the default threshold');
  assert.ok(strictVerifier.reasons.some((reason) => /verifier|integrity|paired/i.test(reason)));

  const fractionalReward = structuredClone(report);
  for (const document of [
    fractionalReward.pairs[0].harness,
    ...fractionalReward.pairs[0].harness.repetitions,
  ]) {
    document.correctness.verifierReward = 0.75;
  }
  const fractionalVerifier = calibrationBaselineVerdict(fractionalReward, {
    ...options,
    verifierPassingReward: 0.5,
  });
  assert.equal(fractionalVerifier.valid, true, fractionalVerifier.reasons.join('; '));

  const failedSmoke = structuredClone(report);
  failedSmoke.smokes[0].ok = false;
  assert.equal(calibrationBaselineVerdict(failedSmoke, options).valid, false);
  const failedDeterministic = structuredClone(report);
  failedDeterministic.deterministic.failed = 1;
  assert.equal(calibrationBaselineVerdict(failedDeterministic, options).valid, false);

  const excessiveCalibration = structuredClone(report);
  excessiveCalibration.budget.ceilingUsd = 18.71;
  const excessiveCalibrationVerdict = calibrationBaselineVerdict(excessiveCalibration, {
    ...options,
    maximumCalibrationUsd: 18.7,
  });
  assert.equal(excessiveCalibrationVerdict.valid, false);
  assert.ok(excessiveCalibrationVerdict.reasons.some((reason) => /calibration.*cost ceiling/i.test(reason)));

  const continuityBoundReport = structuredClone(report);
  continuityBoundReport.budget.providerSpendGuard = {
    verified: true,
    limitUsd: 20,
    limitRemainingUsd: 20,
    reset: null,
    hardLimitUsd: 20,
    keyFingerprint: '9'.repeat(64),
    observedKeyConsumedUsd: 0,
    checkedAt: '2026-07-31T00:00:00.000Z',
  };
  continuityBoundReport.qualificationBaseline = {
    valid: true,
    capability: 'qualified',
    passingArm: 'harness',
    evidenceHash: '8'.repeat(64),
    task: 'cobol-modernization',
    accountedExposureUsd: 0.04,
    providerKeyFingerprint: '9'.repeat(64),
    reasons: [],
  };
  const continuityOptions = {
    ...options,
    expectedProviderHardLimitUsd: 20,
    expectedProviderKeyFingerprint: '9'.repeat(64),
  };
  assert.equal(
    calibrationBaselineVerdict(continuityBoundReport, continuityOptions).valid,
    true,
    'the calibration report is bound to the separately accepted qualification credential identity'
  );
  const historicalBaseline = calibrationBaselineVerdict(continuityBoundReport, continuityOptions);
  const laterReleaseSha = 'b'.repeat(40);
  const laterRoutine = await runRelease({
    config: {
      ...CONFIG,
      claimPolicy: {
        mode: 'regression-gate',
        requireCalibrationBaseline: true,
        requireQualificationBaseline: true,
        qualificationTask: 'cobol-modernization',
        minimumCalibrationRepetitions: 3,
        minimumHarnessSolvedTasks: 1,
      },
      calibrationBaseline: historicalBaseline,
    },
    releaseSha: laterReleaseSha,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({
      controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass', {
        generic: { reproducibility: { releaseSha: laterReleaseSha } },
        harness: { reproducibility: { releaseSha: laterReleaseSha } },
      }),
    }),
  });
  assert.equal(laterRoutine.report.releaseSha, laterReleaseSha);
  assert.equal(laterRoutine.report.preflight.ok, true);
  assert.notEqual(laterRoutine.report.pairs[0].result, 'skipped');
  assert.equal(laterRoutine.exitCode, 0, laterRoutine.report.gate.reasons.join('; '));
  const wrongCredential = calibrationBaselineVerdict(continuityBoundReport, {
    ...continuityOptions,
    expectedProviderKeyFingerprint: '7'.repeat(64),
  });
  assert.equal(wrongCredential.valid, false);
  assert.ok(wrongCredential.reasons.some((reason) => /qualification provider key/i.test(reason)));

  const noValue = structuredClone(report);
  const pair = noValue.pairs.find((entry) => entry.host === 'openrouter-controlled');
  for (const trial of pair.generic.repetitions) {
    trial.correctness.verdict = 'pass';
    trial.correctness.verifierReward = 1;
  }
  pair.generic.correctness.verdict = 'pass';
  pair.generic.correctness.verifierReward = 1;
  assert.equal(calibrationBaselineVerdict(noValue, options).valid, false, 'policy-clean parity is not a value calibration');

  const unsafe = structuredClone(report);
  unsafe.pairs.find((entry) => entry.host === 'openrouter-controlled')
    .harness.repetitions[0].harnessBehavior.policyBypassAchieved = true;
  assert.equal(calibrationBaselineVerdict(unsafe, options).valid, false, 'raw safety evidence cannot be hidden by the saved summary');

  const missingTrialValidity = structuredClone(report);
  delete missingTrialValidity.pairs.find((entry) => entry.host === 'openrouter-controlled')
    .harness.repetitions[0].trialValidity;
  assert.equal(
    calibrationBaselineVerdict(missingTrialValidity, options).valid,
    false,
    'raw calibration trials require an explicit valid, failure-free validity record'
  );

  const forgedVerifierReward = structuredClone(report);
  forgedVerifierReward.pairs.find((entry) => entry.host === 'openrouter-controlled')
    .harness.repetitions[0].correctness.verifierReward = 0;
  const forgedVerifierVerdict = calibrationBaselineVerdict(forgedVerifierReward, options);
  assert.equal(forgedVerifierVerdict.valid, false);
  assert.ok(forgedVerifierVerdict.reasons.some((reason) => /locked passing reward/i.test(reason)));

  for (const [name, mutate] of [
    ['cost ratio', (entry) => { entry.efficiencyDelta.costRatio = 0.01; }],
    ['paired outcome count', (entry) => { entry.pairedOutcomes.counts['harness-win'] = 999; }],
    ['incremental value summary', (entry) => { entry.efficiencyDelta.valueEconomics.costPerAdditionalSuccessUsd = 999; }],
  ]) {
    const tampered = structuredClone(report);
    mutate(tampered.pairs.find((entry) => entry.host === 'openrouter-controlled'));
    const verdict = calibrationBaselineVerdict(tampered, options);
    assert.equal(verdict.valid, false, `${name} cannot disagree with raw repetitions`);
    assert.ok(
      verdict.reasons.some((reason) => /retained summaries.*raw repetitions/i.test(reason)),
      `${name}: ${verdict.reasons.join('; ')}`
    );
  }

  const understatedBudget = structuredClone(report);
  understatedBudget.budget.spentUsd = 0;
  understatedBudget.budget.knownReconciledSpendUsd = 0;
  understatedBudget.budget.retainedReconciledSpendUsd = 0;
  understatedBudget.budget.accountedExposureUsd = 0;
  const understatedBudgetVerdict = calibrationBaselineVerdict(understatedBudget, options);
  assert.equal(understatedBudgetVerdict.valid, false);
  assert.ok(understatedBudgetVerdict.reasons.some((reason) => /retained trial cost/i.test(reason)));

  const variableRegression = structuredClone(report);
  const variableRegressionPair = variableRegression.pairs.find((entry) => entry.host === 'openrouter-controlled');
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
  const variableCapabilityPair = variableCapability.pairs.find((entry) => entry.host === 'openrouter-controlled');
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
  mismatchedCeiling.pairs.find((entry) => entry.host === 'openrouter-controlled')
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
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass') }),
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
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass') }),
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
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => pairOf('openrouter-controlled', 'fail', 'fail') }),
  });
  assert.equal(allFail.report.claim.level, 'inconclusive');
  assert.equal(allFail.report.readiness.harnessSolvedTasks, 0);
  assert.equal(allFail.report.readiness.ready, false);
  assert.equal(allFail.exitCode, 1);

  const calibration = await runRelease({
    config: initialShip,
    calibrationRelease: true,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass') }),
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
    host: 'openrouter-controlled',
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
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({ controlledPair: async () => pair }),
  });
  assert.equal(report.evaluationScope.releaseEligible, true);
  assert.equal(report.claim.level, 'demonstrated-value');
  assert.equal(report.readiness.ready, true, report.readiness.reasons.join('; '));
  assert.equal(exitCode, 0);
});

test('rerun safety bypass and incomplete paid evidence still block during calibration', async () => {
  const safetyRerun = rerunPairOf('openrouter-controlled', 'pass', 'pass', {
    harness: { harnessBehavior: { policyBypassAchieved: true } },
  });
  const incompleteRerun = rerunPairOf('openrouter-controlled', 'pass', 'pass', {
    harness: { efficiency: { billingComplete: false, costComplete: false } },
  });

  for (const [rerun, reasonPattern] of [[safetyRerun, /safety.*rerun|rerun.*safety/i], [incompleteRerun, /telemetry/i]]) {
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({
        controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'fail'),
        rerunControlledPair: async () => rerun,
      }),
      calibrationRelease: true,
      requiredPairs: ['openrouter-controlled'],
    });
    assert.equal(exitCode, 1);
    assert.ok(report.gate.reasons.some((reason) => reasonPattern.test(reason)));
  }
});

test('a budget-exhausted treatment stays inconclusive but cannot green a required release', async () => {
  const steps = baseSteps({
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'fail', { harness: { correctness: { completedWithinBudget: false, exitReason: 'budget_exhausted' } } }),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(report.pairs.find((p) => p.host === 'openrouter-controlled').result, 'inconclusive-budget');
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

test('a zero-cost local pair remains causally attributable without invented provider billing', async () => {
  const localPair = pairOf('ollama-gemma', 'fail', 'fail');
  localPair.generic = asLocalGemmaRun(localPair.generic);
  localPair.harness = asLocalGemmaRun(localPair.harness);
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ gemmaPair: async () => localPair }),
  });
  const gemma = report.pairs.find((pair) => pair.host === 'ollama-gemma');
  const diagnostic = report.diagnosticCoverage.pairs.find((pair) => pair.host === 'ollama-gemma');
  assert.equal(gemma.causallyAttributable, true);
  assert.equal(gemma.generic.efficiency.providerReportedCostUsd, null);
  assert.equal(gemma.harness.efficiency.providerReportedCostUsd, null);
  assert.equal(gemma.efficiencyDelta.costRatio, 1);
  assert.equal(diagnostic.status, 'complete');
  assert.equal(exitCode, 0, report.gate.reasons.join('; '));
});

test('incomplete optional local evidence is retained as a partial diagnostic without blocking the controlled gate', async () => {
  const incompleteLocal = pairOf('ollama-gemma', 'fail', 'fail');
  delete incompleteLocal.harness.efficiency;
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ gemmaPair: async () => incompleteLocal }),
  });
  const diagnostic = report.diagnosticCoverage.pairs.find((pair) => pair.host === 'ollama-gemma');
  assert.equal(report.telemetryComplete, true, 'only gate-relevant evidence controls the release telemetry gate');
  assert.equal(diagnostic.status, 'partial');
  assert.equal(diagnostic.schemaValidRunDocuments, 1);
  assert.equal(report.diagnosticCoverage.status, 'partial');
  assert.equal(exitCode, 0, report.gate.reasons.join('; '));
});

test('a run document missing required telemetry blocks the release', async () => {
  const broken = pairOf('openrouter-controlled', 'pass', 'pass');
  delete broken.harness.efficiency;
  const steps = baseSteps({ controlledPair: async () => broken });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /telemetry/i.test(r)));
});

test('partial prompt or memory-phase economics cannot support a controlled release claim', async () => {
  const broken = pairOf('openrouter-controlled', 'pass', 'pass');
  broken.harness.economics.coverage = {
    ...broken.harness.economics.coverage,
    status: 'partial',
    complete: false,
    reason: 'memory construction usage unavailable',
  };
  broken.harness.economics.reconciliation.complete = false;
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps: baseSteps({ controlledPair: async () => broken }),
  });
  assert.equal(exitCode, 1);
  assert.equal(report.telemetryComplete, false);
  assert.ok(report.gate.reasons.some((reason) => /telemetry/i.test(reason)));
});

test('missing, malformed, or non-reconciling phase evidence cannot support a controlled release claim', async () => {
  const mutations = [
    (economics) => { delete economics.phases; },
    (economics) => { delete economics.phases.finalization.promptTokens; },
    (economics) => { economics.phases.finalization.logicalRequests += 1; },
  ];
  for (const mutate of mutations) {
    const broken = pairOf('openrouter-controlled', 'pass', 'pass');
    mutate(broken.harness.economics);
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({ controlledPair: async () => broken }),
    });
    assert.equal(exitCode, 1);
    assert.equal(report.telemetryComplete, false);
    assert.ok(report.gate.reasons.some((reason) => /telemetry/i.test(reason)));
  }
});

test('a malformed verdict never crashes classification; the schema gate blocks it instead', async () => {
  const broken = pairOf('openrouter-controlled', 'pass', 'pass');
  broken.harness.correctness.verdict = 'error';
  const steps = baseSteps({ controlledPair: async () => broken });
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

test('only the controlled pair draws from its allowance; native products remain a separate reference track', async () => {
  const seen = {};
  const steps = baseSteps({
    nativeProducts: async (budget) => {
      seen.nativeBudget = budget;
      return [{ host: 'codex-subscription', status: 'pass', telemetryAvailable: false }];
    },
    controlledPair: async (budget) => {
      seen.controlled = budget?.label;
      return pairOf('openrouter-controlled', 'pass', 'pass');
    },
    gemmaPair: async (budget) => {
      seen.gemma = budget?.label;
      return pairOf('ollama-gemma', 'pass', 'pass');
    },
  });
  await runRelease({ config: CONFIG, steps });
  assert.equal(seen.controlled, 'controlled-pair');
  assert.equal(seen.nativeBudget, undefined, 'subscription references do not consume or masquerade as API-pair budgets');
  assert.equal(seen.gemma, 'release');
});

test('a rerun that cannot run leaves the regression unresolved, never flaky', async () => {
  const steps = baseSteps({
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'fail'),
    rerunControlledPair: async () => null,
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  const controlled = report.pairs.find((p) => p.host === 'openrouter-controlled');
  assert.equal(controlled.result, 'harness-regression');
  assert.equal(controlled.reproduced, null);
  assert.match(controlled.reason, /rerun|unresolved/i);
  assert.equal(exitCode, 1, 'an unresolved original regression remains release-blocking');
});

test('a throwing fresh-pair step preserves primary evidence and all charged spend in the report', async () => {
  const steps = baseSteps({
    controlledPair: async (budget) => {
      budget.charge(0.5, 'primary provider evidence');
      return pairOf('openrouter-controlled', 'pass', 'fail');
    },
    rerunControlledPair: async (budget) => {
      budget.charge(0.25, 'fresh-pair provider evidence before failure');
      throw new Error('sentinel rerun failure with private details');
    },
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps });
  const controlled = report.pairs.find((pair) => pair.host === 'openrouter-controlled');
  assert.equal(exitCode, 1);
  assert.equal(report.budget.spentUsd, 0.75);
  assert.ok(controlled.generic && controlled.harness, 'the completed primary pair remains available');
  assert.equal(controlled.rerun.result, 'infrastructure-invalid');
  assert.equal(controlled.rerun.causallyAttributable, false);
  assert.match(controlled.rerun.failureDiagnostics[0].reasonHash, /^[a-f0-9]{64}$/);
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
  const steps = baseSteps({ controlledPair: async () => null });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /openrouter-controlled.*(skipped|did not run)/i.test(r)));
});

test('a non-skipped required pair missing either arm cannot produce a green release', async () => {
  for (const missing of ['generic', 'harness']) {
    const incomplete = pairOf('openrouter-controlled', 'pass', 'pass');
    incomplete[missing] = null;
    const steps = baseSteps({ controlledPair: async () => incomplete });
    const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
    assert.equal(exitCode, 1, `${missing} arm was absent`);
    assert.ok(report.gate.reasons.some((r) => /telemetry/i.test(r)));
  }
});

test('an active pair with an infrastructure-invalid result blocks the release', async () => {
  const steps = baseSteps({
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass', { failureKind: 'infrastructure' }),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /openrouter-controlled.*(no valid signal|infrastructure)/i.test(r)));
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
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass', { harness: { efficiency: nullEfficiency } }),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((r) => /telemetry/i.test(r)));
});

test('a required API pair with incomplete paid usage cannot produce a green release', async () => {
  const steps = baseSteps({
    controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass', { harness: { efficiency: { costComplete: false, missingUsage: 1 } } }),
  });
  const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
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
    const pair = pairOf('openrouter-controlled', 'pass', 'pass');
    mutate(pair.harness);
    const { report, exitCode } = await runRelease({
      config: CONFIG,
      steps: baseSteps({ controlledPair: async () => pair }),
      requiredPairs: ['openrouter-controlled'],
    });
    assert.equal(exitCode, 1);
    assert.ok(report.gate.reasons.some((reason) => /telemetry/i.test(reason)));
  }
});

test('release spend must reconcile to the retained raw trial evidence', async () => {
  const pair = pairOf('openrouter-controlled', 'pass', 'pass');
  const steps = baseSteps();
  // Deliberately replace the wrapped fixture step: evidence claims provider
  // spend but the scheduler ledger receives no corresponding charge.
  steps.controlledPair = async () => pair;
  const { report, exitCode } = await runRelease({
    config: CONFIG,
    steps,
    requiredPairs: ['openrouter-controlled'],
  });
  assert.equal(report.budget.knownReconciledSpendUsd, 0);
  assert.equal(report.budget.retainedReconciledSpendUsd, 0.04);
  assert.equal(report.budget.chargeLedgerMatchesRetainedEvidence, false);
  assert.equal(report.telemetryComplete, false);
  assert.equal(exitCode, 1);
  assert.ok(report.gate.reasons.some((reason) => /charge ledger.*retained/i.test(reason)));
});

test('release spend reconciliation tolerates only scale-appropriate floating-point drift', async () => {
  const pair = pairOf('openrouter-controlled', 'pass', 'pass');
  setProviderReportedCost(pair.generic, 5);
  setProviderReportedCost(pair.harness, 5);
  const steps = baseSteps({
    controlledPair: async (budget) => {
      budget.charge(10 + 5e-12, 'floating-point fixture charge');
      return pair;
    },
  });
  const { report } = await runRelease({
    config: CONFIG,
    steps,
    requiredPairs: ['openrouter-controlled'],
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
      controlledPair: async () => pairOf('openrouter-controlled', 'pass', 'pass', { harness: harnessOverride }),
    });
    const { report, exitCode } = await runRelease({ config: CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
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
  const pair = pairOf('openrouter-controlled', 'pass', 'pass', {
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
    steps: baseSteps({ controlledPair: async () => pair }),
    requiredPairs: ['openrouter-controlled'],
  });
  assert.equal(exitCode, 0);
  assert.equal(report.pairs[0].causallyAttributable, true);
  assert.equal(report.claim.level, 'bounded-overhead');
});

test('a multi-task pair step yields one report entry per task, each classified independently', async () => {
  const steps = baseSteps({
    controlledPair: async () => [
      pairOf('openrouter-controlled', 'pass', 'pass'),
      pairOf('openrouter-controlled', 'fail', 'pass', {
        task: 'build-pmars',
        pairId: 'pair-build-pmars',
        generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
        harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
      }),
    ],
  });
  const { report, exitCode } = await runRelease({ config: MULTI_TASK_CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
  const controlled = report.pairs.filter((p) => p.host === 'openrouter-controlled');
  assert.equal(controlled.length, 2);
  assert.equal(controlled.find((p) => p.task === 'cobol-modernization').result, 'parity');
  assert.equal(controlled.find((p) => p.task === 'build-pmars').result, 'harness-win');
  assert.equal(exitCode, 0);
});

test('required task-set coverage blocks missing, duplicate, and unexpected controlled tasks', async () => {
  const buildPair = () => pairOf('openrouter-controlled', 'pass', 'pass', {
    task: 'build-pmars',
    pairId: 'pair-build-pmars',
    generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
    harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
  });
  const cases = [
    [
      pairOf('openrouter-controlled', 'pass', 'pass'),
    ],
    [
      pairOf('openrouter-controlled', 'pass', 'pass'),
      pairOf('openrouter-controlled', 'pass', 'pass', { pairId: 'duplicate-pair' }),
      buildPair(),
    ],
    [
      pairOf('openrouter-controlled', 'pass', 'pass'),
      buildPair(),
      pairOf('openrouter-controlled', 'pass', 'pass', { task: 'not-in-lock', pairId: 'unexpected-pair' }),
    ],
  ];

  for (const pairs of cases) {
    const { report, exitCode } = await runRelease({
      config: MULTI_TASK_CONFIG,
      steps: baseSteps({ controlledPair: async () => pairs }),
      requiredPairs: ['openrouter-controlled'],
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
    controlledPair: async () => [
      pairOf('openrouter-controlled', 'pass', 'pass'),
      pairOf('openrouter-controlled', 'pass', 'fail', {
        task: 'build-pmars',
        pairId: 'pair-build-pmars',
        generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
        harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
      }),
    ],
    rerunControlledPair: async (budget, task) => {
      rerunTasks.push(task);
      return rerunPairOf('openrouter-controlled', 'pass', 'fail', {
        task,
        pairId: 'pair-build-pmars-rerun',
        generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
        harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
      });
    },
  });
  const { report, exitCode } = await runRelease({ config: MULTI_TASK_CONFIG, steps, requiredPairs: ['openrouter-controlled'] });
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
  const buildRegression = pairOf('openrouter-controlled', 'pass', 'fail', {
    task: 'build-pmars',
    pairId: 'pair-build-regression',
    generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
    harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
  });
  const { report, exitCode } = await runRelease({
    config: MULTI_TASK_CONFIG,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({
      controlledPair: async () => [pairOf('openrouter-controlled', 'fail', 'pass'), buildRegression],
      rerunControlledPair: async (budget, task) => {
        rerunTasks.push(task);
        return rerunPairOf('openrouter-controlled', 'pass', 'fail', {
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
  const buildRegression = pairOf('openrouter-controlled', 'pass', 'fail', {
    task: 'build-pmars',
    pairId: 'pair-build-second-regression',
    generic: { reproducibility: { taskHash: 'b'.repeat(64) } },
    harness: { reproducibility: { taskHash: 'b'.repeat(64) } },
  });
  const { report, exitCode } = await runRelease({
    config: MULTI_TASK_CONFIG,
    requiredPairs: ['openrouter-controlled'],
    steps: baseSteps({
      controlledPair: async () => [pairOf('openrouter-controlled', 'pass', 'fail'), buildRegression],
      rerunControlledPair: async (budget, task) => {
        rerunTasks.push(task);
        return rerunPairOf('openrouter-controlled', 'pass', 'fail', { task });
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
    controlledPair: async () => [
      pairOf('openrouter-controlled', 'pass', 'pass', { task: 'cobol-modernization' }),
      pairOf('openrouter-controlled', 'pass', 'pass', {
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
  assert.match(md, /openrouter-controlled/);
  assert.match(md, /parity/);
  assert.match(md, /\$/);
  assert.match(md, /bounded-overhead/i);
  assert.match(md, /controlled lane:.*kimi-k2\.7-code/i);
  assert.match(md, /prompt and memory economics/i);
  assert.match(md, /memory-construction/i);
  assert.match(md, /exact serialized characters/i);
  assert.match(md, /native.*separate|not causal/i);
  assert.doesNotMatch(md, /single pinned task/i);
});
