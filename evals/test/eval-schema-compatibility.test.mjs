import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { validateAgainstSchema } from '../release.mjs';

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('../schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const REPORT_SCHEMA = JSON.parse(fs.readFileSync(new URL('../schema/eval-report.v1.schema.json', import.meta.url), 'utf8'));
const REPORT_V2_SCHEMA = JSON.parse(fs.readFileSync(new URL('../schema/eval-report.v2.schema.json', import.meta.url), 'utf8'));
const TREATMENT_SCHEMA = REPORT_V2_SCHEMA.properties.treatmentArtifact;

function treatmentArtifact() {
  return {
    schema: 'engineer-harness-treatment-artifact.v1',
    bundleManifestHash: '1'.repeat(64),
    harnessPackage: {
      name: '@dev-kit/harness',
      version: '0.5.0',
      sha256: '2'.repeat(64),
      integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
      packedSize: 12_345,
      unpackedSize: 67_890,
      fileCount: 321,
      lockfileSha256: '4'.repeat(64),
    },
    conditionExposure: { generic: false, harness: true },
  };
}

test('schema validation enforces string patterns and fails closed on an invalid pattern', () => {
  assert.deepEqual(validateAgainstSchema('abc123', { type: 'string', pattern: '^[a-z]+[0-9]+$' }).errors, []);
  assert.match(
    validateAgainstSchema('not-a-digest', { type: 'string', pattern: '^[a-f0-9]{64}$' }).errors[0],
    /does not match pattern/i,
  );
  assert.match(
    validateAgainstSchema('anything', { type: 'string', pattern: '[' }).errors[0],
    /invalid schema pattern/i,
  );
});

test('eval-report.v2 treatment identity schema rejects malformed and incomplete evidence', () => {
  assert.deepEqual(validateAgainstSchema(treatmentArtifact(), TREATMENT_SCHEMA).errors, []);
  const mutations = [
    ['bundle digest', (value) => { value.bundleManifestHash = 'not-a-digest'; }],
    ['package digest', (value) => { value.harnessPackage.sha256 = 'not-a-digest'; }],
    ['package integrity', (value) => { value.harnessPackage.integrity = 'sha512-not base64'; }],
    ['lockfile digest', (value) => { value.harnessPackage.lockfileSha256 = 'not-a-digest'; }],
    ['packed size', (value) => { value.harnessPackage.packedSize = 0; }],
    ['unpacked size', (value) => { value.harnessPackage.unpackedSize = 0; }],
    ['file count', (value) => { value.harnessPackage.fileCount = 0; }],
    ['package extra key', (value) => { value.harnessPackage.unexpected = true; }],
    ['artifact extra key', (value) => { value.unexpected = true; }],
    ['generic exposure', (value) => { value.conditionExposure.generic = true; }],
    ['Harness exposure', (value) => { value.conditionExposure.harness = false; }],
    ['missing package identity', (value) => { delete value.harnessPackage.sha256; }],
  ];

  for (const [label, mutate] of mutations) {
    const candidate = treatmentArtifact();
    mutate(candidate);
    assert.equal(
      validateAgainstSchema(candidate, TREATMENT_SCHEMA).ok,
      false,
      `${label} must fail schema validation`,
    );
  }
});

test('eval-run.v1 continues to validate the original v1 contract while newer evidence remains optional', () => {
  const legacy = {
    schema: 'eval-run.v1',
    reproducibility: {
      releaseSha: 'abc123',
      harnessVersion: '0.1.0',
      harnessContentHash: null,
      taskId: 'legacy-task',
      taskRevision: 'terminal-bench@2.0',
      condition: 'generic',
      modelRequested: 'legacy-model',
      modelResolved: null,
      providerResolved: null,
      host: 'legacy-host',
      reasoningConfig: null,
      runnerVersion: '1',
      sandbox: null,
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: null,
    },
    correctness: {
      verifierReward: 1,
      verdict: 'pass',
      exitReason: 'model_finish',
      completedWithinTimeout: true,
      completedWithinBudget: true,
    },
    efficiency: {
      wallTimeMs: 1,
      modelRequests: 1,
      toolCalls: 1,
      terminalCommands: 1,
      failedCommands: 0,
      promptTokens: 1,
      cachedPromptTokens: 0,
      reasoningTokens: 0,
      outputTokens: 1,
      providerReportedCostUsd: 0,
      localCostUsd: 0,
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
  assert.deepEqual(validateAgainstSchema(legacy, RUN_SCHEMA).errors, []);
});

test('eval-report.v1 continues to validate the original v1 report contract', () => {
  const legacy = {
    schema: 'eval-report.v1',
    harnessVersion: '0.1.0',
    releaseSha: 'abc123',
    task: { datasetRef: 'terminal-bench@2.0', task: 'legacy-task', taskChecksum: null },
    calibrationRelease: true,
    deterministic: { passed: 1, failed: 0, skipped: 0 },
    pairs: [{ host: 'legacy-host', result: 'parity', reason: 'legacy result', gateActive: false, generic: null, harness: null }],
    smokes: [{ host: 'legacy-smoke', ok: true, failed: [] }],
    budget: { ceilingUsd: 10, spentUsd: 1, exhausted: false, reserveUsed: null },
    gate: { block: false, reasons: [] },
  };
  assert.deepEqual(validateAgainstSchema(legacy, REPORT_SCHEMA).errors, []);
});

test('legacy eval-report.v2 remains readable without exact treatment evidence', () => {
  assert.equal(REPORT_V2_SCHEMA.required.includes('treatmentArtifact'), false);
  const legacy = {
    schema: 'eval-report.v2',
    harnessVersion: '0.4.0',
    releaseSha: 'abc123',
    task: {
      datasetRef: 'terminal-bench@2.0',
      task: 'legacy-task',
      taskChecksum: null,
      taskSet: [],
      requiredTaskSet: [],
    },
    evaluationScope: {
      mode: 'deterministic-only',
      releaseEligible: false,
      selectedTasks: [],
      requiredTasks: [],
      trust: null,
    },
    calibrationRelease: false,
    preflight: {
      ok: true,
      environment: { ok: true, missing: [] },
      taskLock: { ok: true, reason: null },
    },
    deterministic: { passed: 1, failed: 0, skipped: 0 },
    telemetryComplete: true,
    coverage: {
      complete: true,
      requiredHosts: [],
      expectedTasks: [],
      observed: [],
      missing: [],
      duplicates: [],
      unexpected: [],
      reason: null,
    },
    pairs: [],
    nativeProducts: [],
    smokes: [],
    budget: {
      scope: 'provider-api-only',
      ceilingUsd: 0,
      spentUsd: 0,
      knownReconciledSpendUsd: 0,
      retainedReconciledSpendUsd: 0,
      chargeLedgerMatchesRetainedEvidence: true,
      uncertainReservedUsd: 0,
      accountedExposureUsd: 0,
      exhausted: false,
      breached: false,
      overrunUsd: 0,
      providerSpendGuard: {
        verified: false,
        limitUsd: null,
        limitRemainingUsd: null,
        reset: null,
        checkedAt: null,
      },
      billingUncertain: false,
      enforcementSemantics: 'scheduler-fail-stop-not-atomic-cash-guarantee',
      requestEstimateSemantics: 'utf8-byte-prompt-token-upper-bound-plus-max-output-at-pinned-rates',
      allocations: { controlledPairUsd: 0, regressionRerunUsd: 0, controlledArmCeilingUsd: null },
    },
    gate: { block: false, reasons: [] },
    claim: {
      level: 'inconclusive',
      statement: 'legacy report',
      controlledPairs: 0,
      controlledWins: 0,
      confirmedWins: 0,
      regressions: 0,
      treatmentFidelityModes: [],
    },
    readiness: {
      policy: 'regression-gate',
      ready: null,
      reasons: [],
      minimumHarnessSolvedTasks: null,
      harnessSolvedTasks: null,
      calibrationRequired: false,
      calibrationBaseline: null,
    },
    limitations: [],
  };
  assert.deepEqual(validateAgainstSchema(legacy, REPORT_V2_SCHEMA).errors, []);
  assert.equal(Object.hasOwn(legacy, 'treatmentArtifact'), false);
});
