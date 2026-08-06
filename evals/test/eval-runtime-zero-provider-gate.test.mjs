import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildZeroProviderQualificationDefinition,
  createZeroProviderGateReport,
  validateZeroProviderGateReport,
} from '../runtime/zero-provider-gate.mjs';

const HASH = (char) => char.repeat(64);

function trial(condition, char, overrides = {}) {
  return {
    condition,
    trialId: `${condition}-trial`,
    sandboxId: `${condition}-sandbox`,
    sandboxBootId: `${condition}-boot`,
    readinessLeaseHash: HASH(char),
    outputArchiveHash: HASH(char === 'a' ? 'b' : 'c'),
    trialAttestationHash: HASH(char === 'a' ? 'd' : 'e'),
    deletionReceiptHash: HASH(char === 'a' ? 'f' : '1'),
    harborCompleted: true,
    finalEvidenceComplete: true,
    deleted: true,
    absentAfterDelete: true,
    providerAttempts: 0,
    providerCalls: 0,
    providerSpendMicrousd: 0,
    verifierReward: null,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    releaseSha: 'a'.repeat(40),
    snapshotBuildHash: HASH('2'),
    taskLockHash: HASH('3'),
    bundleHash: HASH('4'),
    gateDefinitionHash: HASH('5'),
    profileId: 'release-canary',
    taskId: 'cobol-modernization',
    startedAt: '2026-08-05T00:00:00.000Z',
    completedAt: '2026-08-05T00:10:00.000Z',
    trials: [trial('generic', 'a'), trial('harness', '6')],
    sessionFinalAttestationHash: HASH('7'),
    ...overrides,
  };
}

test('builds validation-only evidence from one fresh zero-provider sandbox per condition', () => {
  const report = createZeroProviderGateReport(input());
  assert.equal(report.schema, 'engineer-zero-provider-daytona-gate.v1');
  assert.equal(report.executionMode, 'zero-provider-canary');
  assert.equal(report.evidenceClass, 'infrastructure-validation');
  assert.equal(report.releaseEligible, false);
  assert.deepEqual(report.trials.map((entry) => entry.condition), ['generic', 'harness']);
  assert.equal(report.provider.attempts, 0);
  assert.equal(report.provider.calls, 0);
  assert.equal(report.provider.spendMicrousd, 0);
  assert.equal(report.cleanup.allSandboxesAbsent, true);
  assert.match(report.reportHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateZeroProviderGateReport(report), report);
  assert.equal(Object.isFrozen(report), true);
});

test('builds one neutral identity for the zero gate and paid qualification projection', () => {
  const definition = buildZeroProviderQualificationDefinition({
    profileId: 'kimi-k2.7-code',
    taskLockHash: HASH('1'),
    budgetPolicyHash: HASH('2'),
    brokerPolicyHash: HASH('3'),
  });
  assert.equal(definition.schema, 'engineer-zero-provider-daytona-gate-definition.v1');
  assert.equal(definition.executionMode, 'zero-provider-canary');
  assert.equal(definition.releaseEligible, false);
  assert.deepEqual(definition.conditions, ['generic', 'harness']);
  assert.equal(definition.paidQualificationProjection.profile, 'release-canary');
  assert.equal(definition.paidQualificationProjection.taskId, 'cobol-modernization');
  assert.equal(definition.paidQualificationProjection.sessionCeilingMicrousd, 1_300_000);
  assert.equal(definition.paidQualificationProjection.controlledArmCeilingMicrousd, 650_000);
  assert.equal(definition.providerExecution.credentialPresent, false);
  assert.equal(Object.isFrozen(definition.paidQualificationProjection), true);
  assert.throws(() => buildZeroProviderQualificationDefinition({
    profileId: 'kimi-k2.7-code',
    taskLockHash: 'not-a-hash',
    budgetPolicyHash: HASH('2'),
    brokerPolicyHash: HASH('3'),
  }), /hash/i);
});

test('ships an exact JSON schema that cannot represent paid or single-sandbox evidence', () => {
  const schemaPath = path.resolve(
    import.meta.dirname,
    '../schema/runtime-zero-provider-gate.v1.schema.json',
  );
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.$id, 'engineer-zero-provider-daytona-gate.v1');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.releaseEligible.const, false);
  assert.equal(schema.properties.executionMode.const, 'zero-provider-canary');
  assert.equal(schema.properties.trials.minItems, 2);
  assert.equal(schema.properties.trials.maxItems, 2);
  assert.equal(schema.$defs.genericTrial.allOf[1].properties.condition.const, 'generic');
  assert.equal(schema.$defs.harnessTrial.allOf[1].properties.condition.const, 'harness');
  assert.equal(schema.$defs.provider.properties.spendMicrousd.const, 0);
});

test('fails closed on sandbox reuse, incomplete lifecycle evidence, or any provider activity', () => {
  const cases = [
    input({ trials: [trial('generic', 'a'), trial('harness', '6', { sandboxId: 'generic-sandbox' })] }),
    input({ trials: [trial('generic', 'a'), trial('harness', '6', { sandboxBootId: 'generic-boot' })] }),
    input({ trials: [trial('generic', 'a'), trial('generic', '6')] }),
    input({ trials: [trial('generic', 'a'), trial('harness', '6', { harborCompleted: false })] }),
    input({ trials: [trial('generic', 'a'), trial('harness', '6', { finalEvidenceComplete: false })] }),
    input({ trials: [trial('generic', 'a'), trial('harness', '6', { absentAfterDelete: false })] }),
    input({ trials: [trial('generic', 'a'), trial('harness', '6', { providerAttempts: 1 })] }),
    input({ trials: [trial('generic', 'a'), trial('harness', '6', { providerCalls: 1 })] }),
    input({ trials: [trial('generic', 'a'), trial('harness', '6', { providerSpendMicrousd: 1 })] }),
  ];
  for (const candidate of cases) {
    assert.throws(() => createZeroProviderGateReport(candidate), /zero-provider|condition|sandbox|lifecycle|provider/i);
  }
});

test('rejects unknown fields, a forged release claim, and report-hash tampering', () => {
  const report = createZeroProviderGateReport(input());
  assert.throws(
    () => validateZeroProviderGateReport({ ...report, releaseEligible: true }),
    /releaseEligible|validation/i,
  );
  assert.throws(
    () => validateZeroProviderGateReport({ ...report, unexpected: true }),
    /unexpected field/i,
  );
  assert.throws(
    () => validateZeroProviderGateReport({ ...report, reportHash: HASH('9') }),
    /hash/i,
  );
});
