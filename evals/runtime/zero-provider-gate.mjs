import crypto from 'node:crypto';

import { billingProfileHash } from '../lib/model-profiles.mjs';

export const ZERO_PROVIDER_GATE_SCHEMA = 'engineer-zero-provider-daytona-gate.v1';
export const ZERO_PROVIDER_EXECUTION_MODE = 'zero-provider-canary';
export const ZERO_PROVIDER_QUALIFICATION_PROFILE = 'release-canary';
export const ZERO_PROVIDER_QUALIFICATION_TASK = 'cobol-modernization';
export const ZERO_PROVIDER_QUALIFICATION_SESSION_MICROUSD = 1_300_000;
export const ZERO_PROVIDER_QUALIFICATION_ARM_MICROUSD = 650_000;

const HASH = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const INPUT_FIELDS = Object.freeze([
  'releaseSha', 'snapshotBuildHash', 'taskLockHash', 'bundleHash',
  'gateDefinitionHash', 'profileId', 'taskId', 'startedAt', 'completedAt',
  'trials', 'sessionFinalAttestationHash',
]);
const TRIAL_FIELDS = Object.freeze([
  'condition', 'trialId', 'sandboxId', 'sandboxBootId', 'readinessLeaseHash',
  'outputArchiveHash', 'trialAttestationHash', 'deletionReceiptHash',
  'harborCompleted', 'finalEvidenceComplete', 'deleted', 'absentAfterDelete',
  'providerAttempts', 'providerCalls', 'providerSpendMicrousd', 'verifierReward',
]);
const REPORT_FIELDS = Object.freeze([
  'schema', 'executionMode', 'evidenceClass', 'releaseEligible', 'bindings',
  'timing', 'trials', 'provider', 'cleanup', 'sessionFinalAttestationHash',
  'reportHash',
]);

export class ZeroProviderGateError extends Error {
  constructor(message, code = 'ERR_ZERO_PROVIDER_GATE') {
    super(message);
    this.name = 'ZeroProviderGateError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ZeroProviderGateError(message, code);
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const expected = new Set(fields);
  if (Object.keys(value).length !== expected.size
      || Object.keys(value).some((field) => !expected.has(field))) {
    fail(`${label} contains an unexpected field`);
  }
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} must be a safe identifier`);
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a SHA-256 hash`);
  return value;
}

function instant(value, label) {
  let canonical;
  try { canonical = new Date(value).toISOString(); } catch { fail(`${label} must be a canonical instant`); }
  if (value !== canonical) fail(`${label} must be a canonical instant`);
  return Date.parse(value);
}

function zero(value, label) {
  if (!Number.isSafeInteger(value) || value !== 0) fail(`${label} must be zero in a zero-provider gate`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function clone(value, label) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail(`${label} must contain JSON data only`); }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) {
    fail(`${label} exceeds its byte bound`);
  }
  return JSON.parse(serialized);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateTrial(input) {
  const value = clone(input, 'zero-provider trial');
  exactKeys(value, TRIAL_FIELDS, 'zero-provider trial');
  if (!['generic', 'harness'].includes(value.condition)) fail('zero-provider trial condition is invalid');
  safeId(value.trialId, 'zero-provider trialId');
  safeId(value.sandboxId, 'zero-provider sandboxId');
  safeId(value.sandboxBootId, 'zero-provider sandboxBootId');
  for (const field of [
    'readinessLeaseHash', 'outputArchiveHash', 'trialAttestationHash', 'deletionReceiptHash',
  ]) hash(value[field], `zero-provider ${field}`);
  for (const field of [
    'harborCompleted', 'finalEvidenceComplete', 'deleted', 'absentAfterDelete',
  ]) {
    if (value[field] !== true) fail(`zero-provider lifecycle requires ${field}`);
  }
  zero(value.providerAttempts, 'provider attempts');
  zero(value.providerCalls, 'provider calls');
  zero(value.providerSpendMicrousd, 'provider spend');
  if (value.verifierReward !== null
      && (typeof value.verifierReward !== 'number'
        || !Number.isFinite(value.verifierReward)
        || value.verifierReward < 0
        || value.verifierReward > 1)) {
    fail('zero-provider verifier reward must be null or a number between zero and one');
  }
  return value;
}

function validatedTrials(input) {
  if (!Array.isArray(input) || input.length !== 2) {
    fail('zero-provider gate requires exactly two condition trials');
  }
  const trials = input.map(validateTrial).sort((left, right) =>
    ['generic', 'harness'].indexOf(left.condition) - ['generic', 'harness'].indexOf(right.condition));
  if (trials[0].condition !== 'generic' || trials[1].condition !== 'harness') {
    fail('zero-provider gate requires one generic and one harness condition');
  }
  for (const field of ['trialId', 'sandboxId', 'sandboxBootId']) {
    if (trials[0][field] === trials[1][field]) {
      fail(`zero-provider gate requires distinct ${field} values for fresh sandboxes`);
    }
  }
  return trials;
}

function unsignedReport(input) {
  exactKeys(input, INPUT_FIELDS, 'zero-provider gate input');
  if (typeof input.releaseSha !== 'string' || !RELEASE_SHA.test(input.releaseSha)) {
    fail('zero-provider releaseSha must be a full lowercase commit identity');
  }
  for (const field of ['snapshotBuildHash', 'taskLockHash', 'bundleHash', 'gateDefinitionHash']) {
    hash(input[field], `zero-provider ${field}`);
  }
  safeId(input.profileId, 'zero-provider profileId');
  safeId(input.taskId, 'zero-provider taskId');
  const started = instant(input.startedAt, 'zero-provider startedAt');
  const completed = instant(input.completedAt, 'zero-provider completedAt');
  if (completed < started) fail('zero-provider completion precedes its start');
  const trials = validatedTrials(input.trials);
  hash(input.sessionFinalAttestationHash, 'zero-provider session final attestation');
  return {
    schema: ZERO_PROVIDER_GATE_SCHEMA,
    executionMode: ZERO_PROVIDER_EXECUTION_MODE,
    evidenceClass: 'infrastructure-validation',
    releaseEligible: false,
    bindings: {
      releaseSha: input.releaseSha,
      snapshotBuildHash: input.snapshotBuildHash,
      taskLockHash: input.taskLockHash,
      bundleHash: input.bundleHash,
      gateDefinitionHash: input.gateDefinitionHash,
      profileId: input.profileId,
      taskId: input.taskId,
    },
    timing: { startedAt: input.startedAt, completedAt: input.completedAt },
    trials,
    provider: {
      mode: 'not-exercised',
      credentialPresent: false,
      attempts: 0,
      calls: 0,
      spendMicrousd: 0,
    },
    cleanup: { allSandboxesDeleted: true, allSandboxesAbsent: true },
    sessionFinalAttestationHash: input.sessionFinalAttestationHash,
  };
}

export function createZeroProviderGateReport(input) {
  const unsigned = unsignedReport(clone(input, 'zero-provider gate input'));
  return deepFreeze({ ...unsigned, reportHash: canonicalHash(unsigned) });
}

export function validateZeroProviderGateReport(input) {
  const value = clone(input, 'zero-provider gate report');
  exactKeys(value, REPORT_FIELDS, 'zero-provider gate report');
  if (value.schema !== ZERO_PROVIDER_GATE_SCHEMA
      || value.executionMode !== ZERO_PROVIDER_EXECUTION_MODE
      || value.evidenceClass !== 'infrastructure-validation'
      || value.releaseEligible !== false) {
    fail('zero-provider report is not validation-only evidence');
  }
  exactKeys(value.bindings, [
    'releaseSha', 'snapshotBuildHash', 'taskLockHash', 'bundleHash',
    'gateDefinitionHash', 'profileId', 'taskId',
  ], 'zero-provider report bindings');
  exactKeys(value.timing, ['startedAt', 'completedAt'], 'zero-provider report timing');
  exactKeys(value.provider, [
    'mode', 'credentialPresent', 'attempts', 'calls', 'spendMicrousd',
  ], 'zero-provider report provider evidence');
  exactKeys(value.cleanup, [
    'allSandboxesDeleted', 'allSandboxesAbsent',
  ], 'zero-provider report cleanup evidence');
  const rebuilt = createZeroProviderGateReport({
    ...value.bindings,
    ...value.timing,
    trials: value.trials,
    sessionFinalAttestationHash: value.sessionFinalAttestationHash,
  });
  if (value.provider.mode !== 'not-exercised'
      || value.provider.credentialPresent !== false
      || value.provider.attempts !== 0
      || value.provider.calls !== 0
      || value.provider.spendMicrousd !== 0
      || value.cleanup.allSandboxesDeleted !== true
      || value.cleanup.allSandboxesAbsent !== true) {
    fail('zero-provider report contains provider activity or incomplete cleanup');
  }
  hash(value.reportHash, 'zero-provider report hash');
  if (!crypto.timingSafeEqual(
    Buffer.from(value.reportHash, 'hex'),
    Buffer.from(rebuilt.reportHash, 'hex'),
  )) fail('zero-provider report hash drifted');
  return deepFreeze(value);
}

/**
 * Canonical, provider-free projection of the paid release qualification.
 *
 * Keeping this constructor below both launchers lets the zero-provider gate
 * and the paid release path recompute the same identity without either CLI
 * importing the other (which would create an initialization cycle).
 */
export function buildZeroProviderQualificationDefinition({
  profileId,
  taskLockHash,
  budgetPolicyHash,
  brokerPolicyHash,
} = {}) {
  for (const [field, value] of Object.entries({ taskLockHash, budgetPolicyHash, brokerPolicyHash })) {
    hash(value, field);
  }
  safeId(profileId, 'profileId');
  return deepFreeze({
    schema: 'engineer-zero-provider-daytona-gate-definition.v1',
    executionMode: ZERO_PROVIDER_EXECUTION_MODE,
    evidenceClass: 'infrastructure-validation',
    releaseEligible: false,
    conditions: ['generic', 'harness'],
    paidQualificationProjection: {
      profile: ZERO_PROVIDER_QUALIFICATION_PROFILE,
      profileId,
      profileHash: billingProfileHash(profileId),
      taskId: ZERO_PROVIDER_QUALIFICATION_TASK,
      taskCount: 1,
      repetitions: 1,
      sessionCeilingMicrousd: ZERO_PROVIDER_QUALIFICATION_SESSION_MICROUSD,
      controlledPairCeilingMicrousd: ZERO_PROVIDER_QUALIFICATION_SESSION_MICROUSD,
      rerunCeilingMicrousd: 0,
      controlledArmCeilingMicrousd: ZERO_PROVIDER_QUALIFICATION_ARM_MICROUSD,
      taskLockHash,
      budgetPolicyHash,
      brokerPolicyHash,
    },
    providerExecution: {
      authorized: false,
      credentialPresent: false,
      reservationMicrousd: 0,
      spendMicrousd: 0,
    },
  });
}
