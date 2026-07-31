import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { validateAgainstSchema } from '../../../evals/release.mjs';

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const REPORT_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../../evals/schema/eval-report.v1.schema.json', import.meta.url), 'utf8'));

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
