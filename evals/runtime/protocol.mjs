import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';

export const MAX_PROTOCOL_BYTES = 64 * 1024;
export const MAX_PROTOCOL_SEQUENCE = 1_000_000;
export const MAX_SESSION_TRIALS = 64;
export const GENESIS_CHAIN_HASH = '0'.repeat(64);
export const RuntimeExecutionModes = Object.freeze({
  CONTROLLED_PROVIDER: 'controlled-provider',
  ZERO_PROVIDER_CANARY: 'zero-provider-canary',
});
export const RuntimeControlFailureSchema = 'engineer-runtime-control-failure.v1';
export const RuntimeControlFailurePhases = Object.freeze({
  REQUEST_VALIDATION: 'request-validation',
  INSPECT_PLATFORM: 'inspect-platform',
  INSPECT_PROVIDER_KEY: 'inspect-provider-key',
  RESERVE_EVIDENCE_HEADROOM: 'reserve-evidence-headroom',
  START_PRIVATE_DAEMON: 'start-private-daemon',
  START_DOCKER_PROXY: 'start-docker-proxy',
  INSPECT_READINESS: 'inspect-readiness',
  LEASE_SIGNING: 'lease-signing',
  START_PROVIDER_BROKER: 'start-provider-broker',
  CLOSE_PROVIDER_KEY: 'close-provider-key',
  RUN: 'run',
  FINALIZE: 'finalize',
});
export const RuntimeControlFailureCodes = Object.freeze({
  REQUEST_VALIDATION: 'ERR_RUNTIME_CONTROL_REQUEST_VALIDATION',
  INSPECT_PLATFORM: 'ERR_RUNTIME_CONTROL_INSPECT_PLATFORM',
  INSPECT_PROVIDER_KEY: 'ERR_RUNTIME_CONTROL_INSPECT_PROVIDER_KEY',
  RESERVE_EVIDENCE_HEADROOM: 'ERR_RUNTIME_CONTROL_RESERVE_EVIDENCE_HEADROOM',
  START_PRIVATE_DAEMON: 'ERR_RUNTIME_CONTROL_START_PRIVATE_DAEMON',
  START_DOCKER_PROXY: 'ERR_RUNTIME_CONTROL_START_DOCKER_PROXY',
  INSPECT_READINESS: 'ERR_RUNTIME_CONTROL_INSPECT_READINESS',
  LEASE_SIGNING: 'ERR_RUNTIME_CONTROL_LEASE_SIGNING',
  START_PROVIDER_BROKER: 'ERR_RUNTIME_CONTROL_START_PROVIDER_BROKER',
  CLOSE_PROVIDER_KEY: 'ERR_RUNTIME_CONTROL_CLOSE_PROVIDER_KEY',
  RUN: 'ERR_RUNTIME_CONTROL_RUN',
  FINALIZE: 'ERR_RUNTIME_CONTROL_FINALIZE',
});

const HEX_64 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RELEASE_SHA = /^[a-f0-9]{40,64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_MICROUSD = 20_000_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_CANONICAL_DEPTH = 24;
const MAX_CANONICAL_NODES = 8_192;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const SCHEMAS = Object.freeze({
  request: 'engineer-runtime-trial-request.v1',
  readiness: 'engineer-runtime-readiness-lease.v1',
  trialFinal: 'engineer-runtime-trial-final-attestation.v1',
  sessionFinal: 'engineer-runtime-session-final-attestation.v1',
});

const MAX_LIFETIME_MS = Object.freeze({
  [SCHEMAS.request]: 60 * 60 * 1_000,
  [SCHEMAS.readiness]: 5 * 60 * 1_000,
  [SCHEMAS.trialFinal]: 30 * 24 * 60 * 60 * 1_000,
  [SCHEMAS.sessionFinal]: 30 * 24 * 60 * 60 * 1_000,
});

const BASE_FIELDS = Object.freeze([
  'schema',
  'protocolVersion',
  'sessionId',
  'sequence',
  'nonce',
  'issuedAt',
  'expiresAt',
]);

const BINDING_FIELDS = Object.freeze([
  'releaseSha',
  'profileId',
  'taskId',
  'taskLockHash',
  'bundleHash',
  'condition',
  'imageDigest',
  'sandboxId',
  'sandboxBootId',
  'daemonId',
  'daemonRootHash',
  'cgroupId',
  'cgroupPathHash',
  'budgetId',
  'budgetPolicyHash',
  'brokerPolicyHash',
  'supervisorExecutableHash',
  'runnerExecutableHash',
  'harborExecutableHash',
]);

const SESSION_BINDING_FIELDS = Object.freeze([
  'releaseSha',
  'profileId',
  'taskLockHash',
  'bundleHash',
  'executionMode',
  'budgetId',
  'budgetPolicyHash',
  'brokerPolicyHash',
]);

const AUTH_FIELDS = Object.freeze(['algorithm', 'keyId', 'payloadSha256', 'signature']);
const CONTROL_FAILURE_KEY_ID = 'runtime-control-failure-hmac-1';
const CONTROL_FAILURE_FIELDS = Object.freeze([
  'schema',
  'protocolVersion',
  'operation',
  'sessionId',
  'trialId',
  'allocationId',
  'controlSequence',
  'requestHash',
  'phase',
  'code',
  'detailSha256',
]);
const CONTROL_FAILURE_BINDING_FIELDS = Object.freeze([
  'operation',
  'sessionId',
  'trialId',
  'allocationId',
  'controlSequence',
  'requestHash',
]);
export const RuntimeControlFailureCodeByPhase = Object.freeze({
  [RuntimeControlFailurePhases.REQUEST_VALIDATION]: RuntimeControlFailureCodes.REQUEST_VALIDATION,
  [RuntimeControlFailurePhases.INSPECT_PLATFORM]: RuntimeControlFailureCodes.INSPECT_PLATFORM,
  [RuntimeControlFailurePhases.INSPECT_PROVIDER_KEY]: RuntimeControlFailureCodes.INSPECT_PROVIDER_KEY,
  [RuntimeControlFailurePhases.RESERVE_EVIDENCE_HEADROOM]: RuntimeControlFailureCodes.RESERVE_EVIDENCE_HEADROOM,
  [RuntimeControlFailurePhases.START_PRIVATE_DAEMON]: RuntimeControlFailureCodes.START_PRIVATE_DAEMON,
  [RuntimeControlFailurePhases.START_DOCKER_PROXY]: RuntimeControlFailureCodes.START_DOCKER_PROXY,
  [RuntimeControlFailurePhases.INSPECT_READINESS]: RuntimeControlFailureCodes.INSPECT_READINESS,
  [RuntimeControlFailurePhases.LEASE_SIGNING]: RuntimeControlFailureCodes.LEASE_SIGNING,
  [RuntimeControlFailurePhases.START_PROVIDER_BROKER]: RuntimeControlFailureCodes.START_PROVIDER_BROKER,
  [RuntimeControlFailurePhases.CLOSE_PROVIDER_KEY]: RuntimeControlFailureCodes.CLOSE_PROVIDER_KEY,
  [RuntimeControlFailurePhases.RUN]: RuntimeControlFailureCodes.RUN,
  [RuntimeControlFailurePhases.FINALIZE]: RuntimeControlFailureCodes.FINALIZE,
});

export class ProtocolError extends Error {
  constructor(message, code = 'ERR_RUNTIME_PROTOCOL') {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ProtocolError(message, code);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`, 'ERR_PROTOCOL_TYPE');
}

function exactKeys(value, required, label, optional = []) {
  assertPlainObject(value, label);
  const permitted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) fail(`${label} contains unknown field ${key}`, 'ERR_PROTOCOL_UNKNOWN_FIELD');
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${label} is missing required field ${key}`, 'ERR_PROTOCOL_REQUIRED_FIELD');
    }
  }
}

function assertUnicodeScalarString(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${label} contains an unpaired Unicode surrogate`, 'ERR_PROTOCOL_STRING');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${label} contains an unpaired Unicode surrogate`, 'ERR_PROTOCOL_STRING');
    }
  }
}

function assertString(value, label, { minimum = 1, maximum = 256, pattern } = {}) {
  if (typeof value !== 'string') fail(`${label} must be a string`, 'ERR_PROTOCOL_TYPE');
  assertUnicodeScalarString(value, label);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minimum || bytes > maximum) {
    fail(`${label} must contain ${minimum}-${maximum} UTF-8 bytes`, 'ERR_PROTOCOL_BOUNDS');
  }
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`, 'ERR_PROTOCOL_FORMAT');
}

function assertSafeId(value, label, maximum = 128) {
  assertString(value, label, { maximum, pattern: SAFE_ID });
}

function assertHash(value, label) {
  assertString(value, label, { minimum: 64, maximum: 64, pattern: HEX_64 });
}

function assertInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be a safe integer between ${minimum} and ${maximum}`, 'ERR_PROTOCOL_BOUNDS');
  }
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`, 'ERR_PROTOCOL_TYPE');
}

function validateExecutionMode(value, label = 'executionMode') {
  if (!Object.values(RuntimeExecutionModes).includes(value)) {
    fail(
      `${label} must be controlled-provider or zero-provider-canary`,
      'ERR_PROTOCOL_EXECUTION_MODE',
    );
  }
  return value;
}

function instantMs(value, label) {
  assertString(value, label, { minimum: 24, maximum: 24, pattern: ISO_INSTANT });
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(`${label} must be a canonical UTC instant`, 'ERR_PROTOCOL_TIME');
  }
  return milliseconds;
}

function validateLifetime(document) {
  const issued = instantMs(document.issuedAt, 'issuedAt');
  const expires = instantMs(document.expiresAt, 'expiresAt');
  const maximum = MAX_LIFETIME_MS[document.schema];
  if (expires <= issued) fail('expiry must be later than issuance', 'ERR_PROTOCOL_EXPIRY');
  if (!maximum || expires - issued > maximum) {
    fail('document lifetime exceeds the schema expiry limit', 'ERR_PROTOCOL_EXPIRY');
  }
  return { issued, expires };
}

function validateBase(document, schema) {
  if (document.schema !== schema) fail(`expected schema ${schema}`, 'ERR_PROTOCOL_SCHEMA');
  if (document.protocolVersion !== 1) fail('unsupported protocol version', 'ERR_PROTOCOL_VERSION');
  assertSafeId(document.sessionId, 'sessionId');
  assertInteger(document.sequence, 'sequence', { minimum: 1, maximum: MAX_PROTOCOL_SEQUENCE });
  assertHash(document.nonce, 'nonce');
  validateLifetime(document);
}

function validateBindings(value) {
  exactKeys(value, BINDING_FIELDS, 'bindings');
  assertString(value.releaseSha, 'bindings.releaseSha', {
    minimum: 40,
    maximum: 64,
    pattern: RELEASE_SHA,
  });
  assertSafeId(value.profileId, 'bindings.profileId');
  assertSafeId(value.taskId, 'bindings.taskId');
  assertHash(value.taskLockHash, 'bindings.taskLockHash');
  assertHash(value.bundleHash, 'bindings.bundleHash');
  if (!['generic', 'harness'].includes(value.condition)) {
    fail('bindings.condition must be generic or harness', 'ERR_PROTOCOL_CONDITION');
  }
  assertString(value.imageDigest, 'bindings.imageDigest', {
    minimum: 71,
    maximum: 71,
    pattern: IMAGE_DIGEST,
  });
  assertSafeId(value.sandboxId, 'bindings.sandboxId', 192);
  assertSafeId(value.sandboxBootId, 'bindings.sandboxBootId', 192);
  assertSafeId(value.daemonId, 'bindings.daemonId', 192);
  assertHash(value.daemonRootHash, 'bindings.daemonRootHash');
  assertSafeId(value.cgroupId, 'bindings.cgroupId', 192);
  assertHash(value.cgroupPathHash, 'bindings.cgroupPathHash');
  assertSafeId(value.budgetId, 'bindings.budgetId');
  assertHash(value.budgetPolicyHash, 'bindings.budgetPolicyHash');
  assertHash(value.brokerPolicyHash, 'bindings.brokerPolicyHash');
  assertHash(value.supervisorExecutableHash, 'bindings.supervisorExecutableHash');
  assertHash(value.runnerExecutableHash, 'bindings.runnerExecutableHash');
  assertHash(value.harborExecutableHash, 'bindings.harborExecutableHash');
}

function validateSessionBindings(value) {
  exactKeys(value, SESSION_BINDING_FIELDS, 'sessionBindings');
  assertString(value.releaseSha, 'sessionBindings.releaseSha', {
    minimum: 40,
    maximum: 64,
    pattern: RELEASE_SHA,
  });
  assertSafeId(value.profileId, 'sessionBindings.profileId');
  assertHash(value.taskLockHash, 'sessionBindings.taskLockHash');
  assertHash(value.bundleHash, 'sessionBindings.bundleHash');
  validateExecutionMode(value.executionMode, 'sessionBindings.executionMode');
  assertSafeId(value.budgetId, 'sessionBindings.budgetId');
  assertHash(value.budgetPolicyHash, 'sessionBindings.budgetPolicyHash');
  assertHash(value.brokerPolicyHash, 'sessionBindings.brokerPolicyHash');
}

function validateTrialBudget(value, executionMode) {
  exactKeys(value, [
    'currency',
    'trialCeilingMicrousd',
    'sessionCeilingMicrousd',
    'sessionCommittedMicrousd',
  ], 'budget');
  if (value.currency !== 'USD') fail('budget.currency must be USD', 'ERR_PROTOCOL_BUDGET');
  assertInteger(value.trialCeilingMicrousd, 'budget.trialCeilingMicrousd', { maximum: MAX_MICROUSD });
  assertInteger(value.sessionCeilingMicrousd, 'budget.sessionCeilingMicrousd', { maximum: MAX_MICROUSD });
  assertInteger(value.sessionCommittedMicrousd, 'budget.sessionCommittedMicrousd', { maximum: MAX_MICROUSD });
  if (value.trialCeilingMicrousd > value.sessionCeilingMicrousd
      || value.sessionCommittedMicrousd > value.sessionCeilingMicrousd
      || value.trialCeilingMicrousd > value.sessionCommittedMicrousd) {
    fail('budget reservation exceeds its bound session budget', 'ERR_PROTOCOL_BUDGET');
  }
  if (executionMode === RuntimeExecutionModes.ZERO_PROVIDER_CANARY) {
    if (value.trialCeilingMicrousd !== 0
        || value.sessionCeilingMicrousd !== 0
        || value.sessionCommittedMicrousd !== 0) {
      fail('zero-provider-canary budget values must all be zero', 'ERR_PROTOCOL_BUDGET');
    }
  } else if (value.trialCeilingMicrousd === 0
      || value.sessionCeilingMicrousd === 0
      || value.sessionCommittedMicrousd === 0) {
    fail('controlled-provider budget reservations must be positive', 'ERR_PROTOCOL_BUDGET');
  }
}

function validateSessionBudget(value, executionMode) {
  exactKeys(value, [
    'currency',
    'sessionCeilingMicrousd',
    'sessionCommittedMicrousd',
    'sessionSpentMicrousd',
  ], 'budget');
  if (value.currency !== 'USD') fail('budget.currency must be USD', 'ERR_PROTOCOL_BUDGET');
  for (const field of ['sessionCeilingMicrousd', 'sessionCommittedMicrousd', 'sessionSpentMicrousd']) {
    assertInteger(value[field], `budget.${field}`, { maximum: MAX_MICROUSD });
  }
  if (value.sessionSpentMicrousd > value.sessionCommittedMicrousd
      || value.sessionCommittedMicrousd > value.sessionCeilingMicrousd) {
    fail('session budget totals exceed their authorized bounds', 'ERR_PROTOCOL_BUDGET');
  }
  if (executionMode === RuntimeExecutionModes.ZERO_PROVIDER_CANARY) {
    if (value.sessionCeilingMicrousd !== 0
        || value.sessionCommittedMicrousd !== 0
        || value.sessionSpentMicrousd !== 0) {
      fail('zero-provider-canary session budget values must all be zero', 'ERR_PROTOCOL_BUDGET');
    }
  } else if (value.sessionCeilingMicrousd === 0 || value.sessionCommittedMicrousd === 0) {
    fail('controlled-provider session budget reservations must be positive', 'ERR_PROTOCOL_BUDGET');
  }
}

function validateAuthentication(value) {
  exactKeys(value, AUTH_FIELDS, 'authentication');
  if (value.algorithm !== 'HMAC-SHA256') {
    fail('authentication algorithm must be HMAC-SHA256', 'ERR_PROTOCOL_AUTH');
  }
  assertString(value.keyId, 'authentication.keyId', { maximum: 64, pattern: KEY_ID });
  assertHash(value.payloadSha256, 'authentication.payloadSha256');
  assertHash(value.signature, 'authentication.signature');
}

function validateRuntimeControlFailureDocument(document, requireAuthentication) {
  exactKeys(document, [
    ...CONTROL_FAILURE_FIELDS,
    ...(requireAuthentication ? ['authentication'] : []),
  ], 'runtime control failure', requireAuthentication ? [] : ['authentication']);
  if (document.schema !== RuntimeControlFailureSchema) {
    fail('runtime control failure schema is invalid', 'ERR_PROTOCOL_SCHEMA');
  }
  if (document.protocolVersion !== 1) {
    fail('runtime control failure version is invalid', 'ERR_PROTOCOL_VERSION');
  }
  if (!['bind', 'readiness', 'run', 'final'].includes(document.operation)) {
    fail('runtime control failure operation is invalid', 'ERR_PROTOCOL_OPERATION');
  }
  assertSafeId(document.sessionId, 'runtime control failure sessionId');
  assertSafeId(document.trialId, 'runtime control failure trialId');
  assertSafeId(document.allocationId, 'runtime control failure allocationId', 192);
  assertInteger(document.controlSequence, 'runtime control failure controlSequence', {
    minimum: 1,
    maximum: MAX_PROTOCOL_SEQUENCE,
  });
  assertHash(document.requestHash, 'runtime control failure requestHash');
  if (!Object.prototype.hasOwnProperty.call(RuntimeControlFailureCodeByPhase, document.phase)) {
    fail('runtime control failure phase is invalid', 'ERR_PROTOCOL_FAILURE_PHASE');
  }
  if (document.code !== RuntimeControlFailureCodeByPhase[document.phase]) {
    fail('runtime control failure code does not match its phase', 'ERR_PROTOCOL_FAILURE_CODE');
  }
  assertHash(document.detailSha256, 'runtime control failure detailSha256');
  if (document.authentication !== undefined) {
    validateAuthentication(document.authentication);
    if (document.authentication.keyId !== CONTROL_FAILURE_KEY_ID) {
      fail('runtime control failure key id is invalid', 'ERR_PROTOCOL_KEY');
    }
  }
}

function authenticationField(requireAuthentication) {
  return requireAuthentication ? ['authentication'] : [];
}

function validateTrialRequest(document, requireAuthentication) {
  exactKeys(document, [
    ...BASE_FIELDS,
    'trialId',
    'previousTrialChainHash',
    'executionMode',
    'bindings',
    'budget',
    ...authenticationField(requireAuthentication),
  ], 'trial request', requireAuthentication ? [] : ['authentication']);
  validateBase(document, SCHEMAS.request);
  assertSafeId(document.trialId, 'trialId');
  assertHash(document.previousTrialChainHash, 'previousTrialChainHash');
  validateExecutionMode(document.executionMode);
  validateBindings(document.bindings);
  validateTrialBudget(document.budget, document.executionMode);
  if (document.authentication !== undefined) validateAuthentication(document.authentication);
}

function validateReadiness(value) {
  exactKeys(value, [
    'noProviderProbeHash',
    'dockerProxyPolicyHash',
    'brokerPolicyHash',
    'storageProbeHash',
    'privateDaemonBounded',
    'realDaemonDenied',
    'taskNetworkNone',
    'brokerOnlyEgress',
    'cgroupDelegated',
    'evidenceHeadroomReserved',
  ], 'readiness');
  for (const field of [
    'noProviderProbeHash',
    'dockerProxyPolicyHash',
    'brokerPolicyHash',
    'storageProbeHash',
  ]) assertHash(value[field], `readiness.${field}`);
  for (const field of [
    'privateDaemonBounded',
    'realDaemonDenied',
    'taskNetworkNone',
    'brokerOnlyEgress',
    'cgroupDelegated',
    'evidenceHeadroomReserved',
  ]) {
    assertBoolean(value[field], `readiness.${field}`);
    if (value[field] !== true) fail(`readiness.${field} must be true before a lease is issued`, 'ERR_PROTOCOL_READINESS');
  }
}

function validateReadinessLease(document, requireAuthentication) {
  exactKeys(document, [
    ...BASE_FIELDS,
    'trialId',
    'requestHash',
    'requestNonce',
    'previousTrialChainHash',
    'executionMode',
    'bindings',
    'budget',
    'readiness',
    ...authenticationField(requireAuthentication),
  ], 'readiness lease', requireAuthentication ? [] : ['authentication']);
  validateBase(document, SCHEMAS.readiness);
  assertSafeId(document.trialId, 'trialId');
  assertHash(document.requestHash, 'requestHash');
  assertHash(document.requestNonce, 'requestNonce');
  assertHash(document.previousTrialChainHash, 'previousTrialChainHash');
  validateExecutionMode(document.executionMode);
  validateBindings(document.bindings);
  validateTrialBudget(document.budget, document.executionMode);
  validateReadiness(document.readiness);
  if (document.authentication !== undefined) validateAuthentication(document.authentication);
}

function validateOutcome(value, budget, executionMode) {
  exactKeys(value, ['status', 'exitReason', 'providerSpendMicrousd', 'providerUsageHash'], 'outcome');
  if (!['succeeded', 'failed', 'invalid'].includes(value.status)) {
    fail('outcome.status is invalid', 'ERR_PROTOCOL_OUTCOME');
  }
  assertString(value.exitReason, 'outcome.exitReason', { maximum: 256 });
  assertInteger(value.providerSpendMicrousd, 'outcome.providerSpendMicrousd', { maximum: MAX_MICROUSD });
  assertHash(value.providerUsageHash, 'outcome.providerUsageHash');
  if (value.providerSpendMicrousd > budget.trialCeilingMicrousd) {
    fail('outcome provider spend exceeds the trial budget', 'ERR_PROTOCOL_BUDGET');
  }
  if (executionMode === RuntimeExecutionModes.ZERO_PROVIDER_CANARY
      && value.providerSpendMicrousd !== 0) {
    fail('zero-provider-canary outcome provider spend must be zero', 'ERR_PROTOCOL_BUDGET');
  }
}

function validateRuntimeEvidence(value) {
  exactKeys(value, [
    'evidenceHash',
    'dockerEventsHash',
    'mountInventoryHash',
    'cgroupEvidenceHash',
    'networkEvidenceHash',
    'budgetEvidenceHash',
    'startedAt',
    'endedAt',
  ], 'runtimeEvidence');
  for (const field of [
    'evidenceHash',
    'dockerEventsHash',
    'mountInventoryHash',
    'cgroupEvidenceHash',
    'networkEvidenceHash',
    'budgetEvidenceHash',
  ]) assertHash(value[field], `runtimeEvidence.${field}`);
  const started = instantMs(value.startedAt, 'runtimeEvidence.startedAt');
  const ended = instantMs(value.endedAt, 'runtimeEvidence.endedAt');
  if (ended < started) fail('runtime evidence ends before it starts', 'ERR_PROTOCOL_TIME');
}

function validateCleanup(value) {
  exactKeys(value, [
    'completed',
    'containersRemaining',
    'networksRemaining',
    'volumesRemaining',
    'processesRemaining',
    'cgroupPopulated',
  ], 'cleanup');
  assertBoolean(value.completed, 'cleanup.completed');
  assertBoolean(value.cgroupPopulated, 'cleanup.cgroupPopulated');
  for (const field of [
    'containersRemaining',
    'networksRemaining',
    'volumesRemaining',
    'processesRemaining',
  ]) assertInteger(value[field], `cleanup.${field}`, { maximum: 1_000_000 });
  if (!value.completed
      || value.cgroupPopulated
      || value.containersRemaining !== 0
      || value.networksRemaining !== 0
      || value.volumesRemaining !== 0
      || value.processesRemaining !== 0) {
    fail('final attestation requires complete zero-remainder cleanup', 'ERR_PROTOCOL_CLEANUP');
  }
}

function validateTrialFinalAttestation(document, requireAuthentication) {
  exactKeys(document, [
    ...BASE_FIELDS,
    'trialId',
    'requestHash',
    'readinessLeaseHash',
    'previousTrialChainHash',
    'executionMode',
    'bindings',
    'budget',
    'outcome',
    'runtimeEvidence',
    'cleanup',
    ...authenticationField(requireAuthentication),
  ], 'trial final attestation', requireAuthentication ? [] : ['authentication']);
  validateBase(document, SCHEMAS.trialFinal);
  assertSafeId(document.trialId, 'trialId');
  assertHash(document.requestHash, 'requestHash');
  assertHash(document.readinessLeaseHash, 'readinessLeaseHash');
  assertHash(document.previousTrialChainHash, 'previousTrialChainHash');
  validateExecutionMode(document.executionMode);
  validateBindings(document.bindings);
  validateTrialBudget(document.budget, document.executionMode);
  validateOutcome(document.outcome, document.budget, document.executionMode);
  validateRuntimeEvidence(document.runtimeEvidence);
  validateCleanup(document.cleanup);
  if (instantMs(document.issuedAt, 'issuedAt') < instantMs(document.runtimeEvidence.endedAt, 'runtimeEvidence.endedAt')) {
    fail('trial final attestation predates completion of its runtime evidence', 'ERR_PROTOCOL_TIME');
  }
  if (document.authentication !== undefined) validateAuthentication(document.authentication);
}

function validateDeletionReceipt(value) {
  exactKeys(value, [
    'trialId',
    'sandboxId',
    'deletionRequestId',
    'deletionRequestedAt',
    'observedAbsentAt',
    'platformEvidenceHash',
  ], 'deletionReceipt');
  assertSafeId(value.trialId, 'deletionReceipt.trialId');
  assertSafeId(value.sandboxId, 'deletionReceipt.sandboxId', 192);
  assertSafeId(value.deletionRequestId, 'deletionReceipt.deletionRequestId', 192);
  const requested = instantMs(value.deletionRequestedAt, 'deletionReceipt.deletionRequestedAt');
  const absent = instantMs(value.observedAbsentAt, 'deletionReceipt.observedAbsentAt');
  if (absent < requested) fail('sandbox absence predates its deletion request', 'ERR_PROTOCOL_DELETION');
  assertHash(value.platformEvidenceHash, 'deletionReceipt.platformEvidenceHash');
}

function chainLinkCore(entry) {
  return {
    schema: 'engineer-runtime-trial-chain-link.v1',
    order: entry.order,
    previousChainHash: entry.previousChainHash,
    trialId: entry.trialId,
    taskId: entry.taskId,
    condition: entry.condition,
    trialAttestationHash: entry.trialAttestationHash,
    deletionReceiptHash: entry.deletionReceiptHash,
  };
}

function validateChainEntry(value) {
  exactKeys(value, [
    'order',
    'previousChainHash',
    'trialId',
    'taskId',
    'condition',
    'trialAttestationHash',
    'deletionReceipt',
    'deletionReceiptHash',
    'chainHash',
  ], 'trial chain entry');
  assertInteger(value.order, 'trial chain entry order', { minimum: 1, maximum: MAX_SESSION_TRIALS });
  assertHash(value.previousChainHash, 'trial chain entry previousChainHash');
  assertSafeId(value.trialId, 'trial chain entry trialId');
  assertSafeId(value.taskId, 'trial chain entry taskId');
  if (!['generic', 'harness'].includes(value.condition)) fail('trial chain condition is invalid', 'ERR_PROTOCOL_CONDITION');
  assertHash(value.trialAttestationHash, 'trial chain entry trialAttestationHash');
  validateDeletionReceipt(value.deletionReceipt);
  assertHash(value.deletionReceiptHash, 'trial chain entry deletionReceiptHash');
  assertHash(value.chainHash, 'trial chain entry chainHash');
  if (value.deletionReceipt.trialId !== value.trialId) {
    fail('deletion receipt trial identity mismatch', 'ERR_PROTOCOL_DELETION');
  }
  if (!safeHexEqual(value.deletionReceiptHash, canonicalSha256(value.deletionReceipt))) {
    fail('deletion receipt hash mismatch', 'ERR_PROTOCOL_DELETION');
  }
  if (!safeHexEqual(value.chainHash, canonicalSha256(chainLinkCore(value)))) {
    fail('trial chain hash mismatch', 'ERR_PROTOCOL_CHAIN');
  }
}

function validateSessionFinalAttestation(document, requireAuthentication) {
  exactKeys(document, [
    ...BASE_FIELDS,
    'sessionBindings',
    'trials',
    'chainHead',
    'budget',
    'evidenceArchiveHash',
    ...authenticationField(requireAuthentication),
  ], 'session final attestation', requireAuthentication ? [] : ['authentication']);
  validateBase(document, SCHEMAS.sessionFinal);
  validateSessionBindings(document.sessionBindings);
  if (!Array.isArray(document.trials)
      || document.trials.length < 1
      || document.trials.length > MAX_SESSION_TRIALS) {
    fail(`session trials must contain 1-${MAX_SESSION_TRIALS} entries`, 'ERR_PROTOCOL_BOUNDS');
  }
  let previous = GENESIS_CHAIN_HASH;
  const trialIds = new Set();
  const sandboxIds = new Set();
  document.trials.forEach((entry, index) => {
    validateChainEntry(entry);
    if (entry.order !== index + 1) fail('trial hash chain order is not contiguous', 'ERR_PROTOCOL_CHAIN');
    if (!safeHexEqual(entry.previousChainHash, previous)) {
      fail('trial hash chain previous hash mismatch', 'ERR_PROTOCOL_CHAIN');
    }
    if (trialIds.has(entry.trialId)) fail('trial hash chain repeats a trial id', 'ERR_PROTOCOL_REPLAY');
    if (sandboxIds.has(entry.deletionReceipt.sandboxId)) {
      fail('trial hash chain reuses a deleted sandbox', 'ERR_PROTOCOL_REPLAY');
    }
    trialIds.add(entry.trialId);
    sandboxIds.add(entry.deletionReceipt.sandboxId);
    previous = entry.chainHash;
  });
  assertHash(document.chainHead, 'chainHead');
  if (!safeHexEqual(document.chainHead, previous)) fail('session chain head mismatch', 'ERR_PROTOCOL_CHAIN');
  validateSessionBudget(document.budget, document.sessionBindings.executionMode);
  assertHash(document.evidenceArchiveHash, 'evidenceArchiveHash');
  if (document.authentication !== undefined) validateAuthentication(document.authentication);
}

function validateBySchema(document, requireAuthentication) {
  if (!isPlainObject(document)) fail('protocol document must be a plain object', 'ERR_PROTOCOL_TYPE');
  switch (document.schema) {
    case SCHEMAS.request:
      return validateTrialRequest(document, requireAuthentication);
    case SCHEMAS.readiness:
      return validateReadinessLease(document, requireAuthentication);
    case SCHEMAS.trialFinal:
      return validateTrialFinalAttestation(document, requireAuthentication);
    case SCHEMAS.sessionFinal:
      return validateSessionFinalAttestation(document, requireAuthentication);
    default:
      fail('unknown protocol schema', 'ERR_PROTOCOL_SCHEMA');
  }
}

function strictJsonParser(source) {
  let offset = 0;
  let nodes = 0;

  function malformed(message) {
    fail(`malformed protocol JSON at byte ${Buffer.byteLength(source.slice(0, offset), 'utf8')}: ${message}`, 'ERR_PROTOCOL_JSON');
  }

  function whitespace() {
    while (offset < source.length && /[\t\n\r ]/.test(source[offset])) offset += 1;
  }

  function string() {
    if (source[offset] !== '"') malformed('expected string');
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        try {
          const value = JSON.parse(source.slice(start, offset));
          assertUnicodeScalarString(value, 'JSON string');
          return value;
        } catch (error) {
          if (error instanceof ProtocolError) throw error;
          malformed('invalid string escape');
        }
      }
      if (character === '\\') {
        offset += 1;
        if (offset >= source.length || !/["\\/bfnrtu]/.test(source[offset])) malformed('invalid string escape');
        if (source[offset] === 'u') {
          const escape = source.slice(offset + 1, offset + 5);
          if (!/^[a-fA-F0-9]{4}$/.test(escape)) malformed('invalid Unicode escape');
          offset += 4;
        }
      } else if (source.charCodeAt(offset) < 0x20) {
        malformed('unescaped control character');
      }
      offset += 1;
    }
    malformed('unterminated string');
  }

  function value(depth) {
    whitespace();
    if (depth > MAX_CANONICAL_DEPTH) malformed('maximum nesting depth exceeded');
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES) malformed('maximum value count exceeded');
    const character = source[offset];
    if (character === '{') return object(depth + 1);
    if (character === '[') return array(depth + 1);
    if (character === '"') return string();
    if (source.startsWith('true', offset)) { offset += 4; return true; }
    if (source.startsWith('false', offset)) { offset += 5; return false; }
    if (source.startsWith('null', offset)) { offset += 4; return null; }
    const match = source.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) malformed('unexpected token');
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) malformed('number is not finite');
    return number;
  }

  function object(depth) {
    offset += 1;
    whitespace();
    const result = {};
    const keys = new Set();
    if (source[offset] === '}') { offset += 1; return result; }
    while (offset < source.length) {
      whitespace();
      const key = string();
      if (keys.has(key)) fail(`duplicate JSON field ${key}`, 'ERR_PROTOCOL_DUPLICATE_FIELD');
      keys.add(key);
      whitespace();
      if (source[offset] !== ':') malformed('expected colon');
      offset += 1;
      Object.defineProperty(result, key, {
        value: value(depth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      whitespace();
      if (source[offset] === '}') { offset += 1; return result; }
      if (source[offset] !== ',') malformed('expected comma or closing brace');
      offset += 1;
    }
    malformed('unterminated object');
  }

  function array(depth) {
    offset += 1;
    whitespace();
    const result = [];
    if (source[offset] === ']') { offset += 1; return result; }
    while (offset < source.length) {
      result.push(value(depth));
      whitespace();
      if (source[offset] === ']') { offset += 1; return result; }
      if (source[offset] !== ',') malformed('expected comma or closing bracket');
      offset += 1;
    }
    malformed('unterminated array');
  }

  whitespace();
  if (offset === source.length) malformed('empty input');
  const parsed = value(0);
  whitespace();
  if (offset !== source.length) malformed('trailing input');
  return parsed;
}

function parseProtocolInput(input) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    return input;
  }
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.length > MAX_PROTOCOL_BYTES) fail('protocol message exceeds the size limit', 'ERR_PROTOCOL_SIZE');
  let source;
  try {
    source = UTF8.decode(bytes);
  } catch {
    fail('malformed protocol JSON: invalid UTF-8', 'ERR_PROTOCOL_JSON');
  }
  if (source.charCodeAt(0) === 0xfeff) fail('malformed protocol JSON: byte-order mark is forbidden', 'ERR_PROTOCOL_JSON');
  return strictJsonParser(source);
}

/** RFC-8785-style deterministic JSON for the protocol's deliberately narrow data model. */
export function canonicalJson(value) {
  const ancestors = new WeakSet();
  let nodes = 0;

  function encode(current, depth, label) {
    if (depth > MAX_CANONICAL_DEPTH) fail('canonical JSON nesting is too deep', 'ERR_PROTOCOL_BOUNDS');
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES) fail('canonical JSON contains too many values', 'ERR_PROTOCOL_BOUNDS');
    if (current === null) fail(`${label} contains null; nil protocol values are forbidden`, 'ERR_PROTOCOL_NIL');
    if (typeof current === 'string') {
      assertUnicodeScalarString(current, label);
      return JSON.stringify(current);
    }
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(`${label} must contain only finite numbers`, 'ERR_PROTOCOL_NUMBER');
      if (Object.is(current, -0)) fail(`${label} contains negative zero`, 'ERR_PROTOCOL_NUMBER');
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') {
      fail(`${label} contains unsupported ${typeof current}`, 'ERR_PROTOCOL_TYPE');
    }
    if (ancestors.has(current)) fail(`${label} is cyclic`, 'ERR_PROTOCOL_TYPE');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getOwnPropertySymbols(current).length > 0) {
          fail(`${label} contains symbol fields`, 'ERR_PROTOCOL_TYPE');
        }
        const permitted = new Set(['length']);
        const encoded = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            fail(`${label} contains a sparse array`, 'ERR_PROTOCOL_TYPE');
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
            fail(`${label}[${index}] must be an enumerable data field`, 'ERR_PROTOCOL_TYPE');
          }
          permitted.add(String(index));
          encoded.push(encode(descriptor.value, depth + 1, `${label}[${index}]`));
        }
        for (const key of Object.getOwnPropertyNames(current)) {
          if (!permitted.has(key)) fail(`${label} contains a non-JSON array field`, 'ERR_PROTOCOL_TYPE');
        }
        return `[${encoded.join(',')}]`;
      }
      if (!isPlainObject(current)) fail(`${label} must contain only plain objects`, 'ERR_PROTOCOL_TYPE');
      if (Object.getOwnPropertySymbols(current).length > 0) {
        fail(`${label} contains symbol fields`, 'ERR_PROTOCOL_TYPE');
      }
      const keys = Object.keys(current).sort();
      const encoded = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
          fail(`${label}.${key} must be an enumerable data field`, 'ERR_PROTOCOL_TYPE');
        }
        assertUnicodeScalarString(key, `${label} field name`);
        return `${JSON.stringify(key)}:${encode(current[key], depth + 1, `${label}.${key}`)}`;
      });
      if (Object.getOwnPropertyNames(current).length !== keys.length) {
        fail(`${label} contains non-enumerable fields`, 'ERR_PROTOCOL_TYPE');
      }
      return `{${encoded.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  const result = encode(value, 0, 'value');
  if (Buffer.byteLength(result, 'utf8') > MAX_PROTOCOL_BYTES) {
    fail('canonical protocol document exceeds the size limit', 'ERR_PROTOCOL_SIZE');
  }
  return result;
}

export function sha256Hex(bytes) {
  if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail('SHA-256 input must be bytes or a string', 'ERR_PROTOCOL_TYPE');
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function canonicalSha256(value) {
  return sha256Hex(canonicalJson(value));
}

function unsignedDocument(document) {
  const { authentication: _authentication, ...unsigned } = document;
  return unsigned;
}

export function protocolDocumentHash(document) {
  const parsed = parseProtocolInput(document);
  validateProtocolDocument(parsed, { requireAuthentication: false });
  return canonicalSha256(unsignedDocument(parsed));
}

function safeHexEqual(left, right) {
  if (!HEX_64.test(String(left ?? '')) || !HEX_64.test(String(right ?? ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function normalizedKey(key) {
  if (!Buffer.isBuffer(key) && !(key instanceof Uint8Array)) {
    fail('HMAC key must be supplied as bytes', 'ERR_PROTOCOL_KEY');
  }
  const bytes = Buffer.from(key);
  if (bytes.length < 32 || bytes.length > 128) {
    fail('HMAC key must contain 32-128 bytes', 'ERR_PROTOCOL_KEY');
  }
  return bytes;
}

function authBytes(schema, digest) {
  return Buffer.from(`engineer-runtime-protocol.v1\n${schema}\n${digest}`, 'utf8');
}

function runtimeControlFailureAuthBytes(digest) {
  return Buffer.from(
    `engineer-runtime-control-failure-auth.v1\n${RuntimeControlFailureSchema}\n${digest}`,
    'utf8',
  );
}

function runtimeControlFailureKey(key) {
  if (!Buffer.isBuffer(key) && !(key instanceof Uint8Array)) {
    fail('runtime control failure HMAC key must be supplied as bytes', 'ERR_PROTOCOL_KEY');
  }
  if (key.byteLength !== 32) {
    fail('runtime control failure HMAC key must contain exactly 32 bytes', 'ERR_PROTOCOL_KEY');
  }
  return Buffer.from(key);
}

function parseExactRuntimeControlFailureInput(input) {
  const parsed = parseProtocolInput(input);
  const canonical = canonicalJson(parsed);
  if (typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array) {
    let source;
    try {
      source = typeof input === 'string' ? input : UTF8.decode(Buffer.from(input));
    } catch {
      fail('runtime control failure is not valid UTF-8', 'ERR_PROTOCOL_JSON');
    }
    if (source !== canonical) {
      fail('runtime control failure must use exact canonical JSON', 'ERR_PROTOCOL_JSON');
    }
  }
  return strictJsonParser(canonical);
}

function validateRuntimeControlFailureBinding(value) {
  exactKeys(value, CONTROL_FAILURE_BINDING_FIELDS, 'runtime control failure binding');
  if (!['bind', 'readiness', 'run', 'final'].includes(value.operation)) {
    fail('runtime control failure expected operation is invalid', 'ERR_PROTOCOL_OPERATION');
  }
  assertSafeId(value.sessionId, 'runtime control failure expected sessionId');
  assertSafeId(value.trialId, 'runtime control failure expected trialId');
  assertSafeId(value.allocationId, 'runtime control failure expected allocationId', 192);
  assertInteger(value.controlSequence, 'runtime control failure expected controlSequence', {
    minimum: 1,
    maximum: MAX_PROTOCOL_SEQUENCE,
  });
  assertHash(value.requestHash, 'runtime control failure expected requestHash');
  return strictJsonParser(canonicalJson(value));
}

export function validateRuntimeControlFailure(input, { requireAuthentication = true } = {}) {
  const document = parseExactRuntimeControlFailureInput(input);
  validateRuntimeControlFailureDocument(document, requireAuthentication);
  return document;
}

export function signRuntimeControlFailure(input, key) {
  const document = validateRuntimeControlFailure(input, { requireAuthentication: false });
  if (Object.prototype.hasOwnProperty.call(document, 'authentication')) {
    fail('refusing to sign an authenticated runtime control failure', 'ERR_PROTOCOL_AUTH');
  }
  const payloadSha256 = canonicalSha256(document);
  const temporaryKey = runtimeControlFailureKey(key);
  let signature;
  try {
    signature = crypto.createHmac('sha256', temporaryKey)
      .update(runtimeControlFailureAuthBytes(payloadSha256))
      .digest('hex');
  } finally {
    temporaryKey.fill(0);
  }
  const signed = {
    ...document,
    authentication: {
      algorithm: 'HMAC-SHA256',
      keyId: CONTROL_FAILURE_KEY_ID,
      payloadSha256,
      signature,
    },
  };
  return validateRuntimeControlFailure(signed);
}

export function verifyRuntimeControlFailure(input, key, expectedBinding) {
  const document = validateRuntimeControlFailure(input);
  const expected = validateRuntimeControlFailureBinding(expectedBinding);
  const { authentication, ...unsigned } = document;
  const payloadSha256 = canonicalSha256(unsigned);
  const temporaryKey = runtimeControlFailureKey(key);
  let expectedSignature;
  try {
    expectedSignature = crypto.createHmac('sha256', temporaryKey)
      .update(runtimeControlFailureAuthBytes(payloadSha256))
      .digest('hex');
  } finally {
    temporaryKey.fill(0);
  }
  if (!safeHexEqual(authentication.payloadSha256, payloadSha256)
      || !safeHexEqual(authentication.signature, expectedSignature)) {
    fail('runtime control failure authentication failed', 'ERR_PROTOCOL_AUTH');
  }
  for (const field of CONTROL_FAILURE_BINDING_FIELDS) {
    const matches = field === 'requestHash'
      ? safeHexEqual(document[field], expected[field])
      : document[field] === expected[field];
    if (!matches) {
      fail('runtime control failure binding mismatch', 'ERR_PROTOCOL_BINDING');
    }
  }
  return Object.freeze({
    ...document,
    authentication: Object.freeze({ ...document.authentication }),
  });
}

export function generateNonce() {
  const bytes = crypto.randomBytes(32);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail('nonce generator did not return bytes', 'ERR_PROTOCOL_NONCE');
  }
  const normalized = Buffer.from(bytes);
  if (normalized.length !== 32) fail('nonce generator must return exactly 32 bytes', 'ERR_PROTOCOL_NONCE');
  return normalized.toString('hex');
}

export function validateProtocolDocument(input, { requireAuthentication = true } = {}) {
  const parsed = parseProtocolInput(input);
  const document = strictJsonParser(canonicalJson(parsed));
  validateBySchema(document, requireAuthentication);
  return document;
}

export function signProtocolDocument(input, key, { keyId = 'runtime-hmac-1' } = {}) {
  const document = validateProtocolDocument(input, { requireAuthentication: false });
  if (Object.prototype.hasOwnProperty.call(document, 'authentication')) {
    fail('refusing to sign a document that already has authentication', 'ERR_PROTOCOL_AUTH');
  }
  assertString(keyId, 'keyId', { maximum: 64, pattern: KEY_ID });
  const normalized = normalizedKey(key);
  const cloned = strictJsonParser(canonicalJson(document));
  const payloadSha256 = canonicalSha256(cloned);
  const signature = crypto.createHmac('sha256', normalized)
    .update(authBytes(cloned.schema, payloadSha256))
    .digest('hex');
  const signed = {
    ...cloned,
    authentication: {
      algorithm: 'HMAC-SHA256',
      keyId,
      payloadSha256,
      signature,
    },
  };
  validateProtocolDocument(signed);
  return signed;
}

function enforceFreshness(document, now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) fail('verification time is invalid', 'ERR_PROTOCOL_TIME');
  const { issued, expires } = validateLifetime(document);
  if (issued > nowMs + MAX_CLOCK_SKEW_MS) fail('protocol document was issued in the future', 'ERR_PROTOCOL_TIME');
  if (nowMs >= expires) fail('protocol document has expired', 'ERR_PROTOCOL_EXPIRY');
}

export function verifyProtocolDocument(
  input,
  key,
  {
    expectedKeyId,
    now = new Date(),
    replayGuard,
  } = {}
) {
  const document = validateProtocolDocument(input);
  const normalized = normalizedKey(key);
  if (expectedKeyId !== undefined && document.authentication.keyId !== expectedKeyId) {
    fail('authentication key id does not match the trusted key', 'ERR_PROTOCOL_KEY');
  }
  const unsigned = unsignedDocument(document);
  const digest = canonicalSha256(unsigned);
  const expectedSignature = crypto.createHmac('sha256', normalized)
    .update(authBytes(document.schema, digest))
    .digest('hex');
  const digestMatches = safeHexEqual(document.authentication.payloadSha256, digest);
  const signatureMatches = safeHexEqual(document.authentication.signature, expectedSignature);
  if (!(digestMatches && signatureMatches)) fail('protocol authentication failed', 'ERR_PROTOCOL_AUTH');
  enforceFreshness(document, now);
  if (replayGuard !== undefined) {
    if (!(replayGuard instanceof ProtocolReplayGuard)) fail('replayGuard is invalid', 'ERR_PROTOCOL_REPLAY');
    replayGuard.accept(document, { now });
  }
  return document;
}

function sameCanonical(left, right) {
  return safeHexEqual(canonicalSha256(left), canonicalSha256(right));
}

function assertDocumentIdentity(left, right, label) {
  if (left.sessionId !== right.sessionId || left.trialId !== right.trialId) {
    fail(`${label} trial identity mismatch`, 'ERR_PROTOCOL_BINDING');
  }
  if (!sameCanonical(left.bindings, right.bindings)) fail(`${label} binding mismatch`, 'ERR_PROTOCOL_BINDING');
  if (left.executionMode !== right.executionMode) {
    fail(`${label} execution mode binding mismatch`, 'ERR_PROTOCOL_BINDING');
  }
  if (!sameCanonical(left.budget, right.budget)) fail(`${label} budget binding mismatch`, 'ERR_PROTOCOL_BUDGET');
  if (!safeHexEqual(left.previousTrialChainHash, right.previousTrialChainHash)) {
    fail(`${label} previous trial chain binding mismatch`, 'ERR_PROTOCOL_CHAIN');
  }
}

export function verifyReadinessLeaseForRequest(leaseInput, requestInput) {
  const request = validateProtocolDocument(requestInput, { requireAuthentication: false });
  const lease = validateProtocolDocument(leaseInput, { requireAuthentication: false });
  if (request.schema !== SCHEMAS.request || lease.schema !== SCHEMAS.readiness) {
    fail('readiness verification requires a request and a readiness lease', 'ERR_PROTOCOL_SCHEMA');
  }
  assertDocumentIdentity(lease, request, 'readiness lease');
  if (lease.sequence !== request.sequence + 1) fail('readiness lease sequence is not monotonic', 'ERR_PROTOCOL_REPLAY');
  if (!safeHexEqual(lease.requestHash, protocolDocumentHash(request))) {
    fail('readiness lease request hash mismatch', 'ERR_PROTOCOL_BINDING');
  }
  if (!safeHexEqual(lease.requestNonce, request.nonce)) fail('readiness lease request nonce mismatch', 'ERR_PROTOCOL_BINDING');
  if (safeHexEqual(lease.nonce, request.nonce)) fail('readiness lease reuses the request nonce', 'ERR_PROTOCOL_REPLAY');
  const requestTime = validateLifetime(request);
  const leaseTime = validateLifetime(lease);
  if (leaseTime.issued < requestTime.issued || leaseTime.expires > requestTime.expires) {
    fail('readiness lease lifetime escapes the request lifetime', 'ERR_PROTOCOL_EXPIRY');
  }
  return true;
}

export function verifyTrialAttestationForLease(attestationInput, leaseInput, requestInput) {
  const request = validateProtocolDocument(requestInput, { requireAuthentication: false });
  const lease = validateProtocolDocument(leaseInput, { requireAuthentication: false });
  const attestation = validateProtocolDocument(attestationInput, { requireAuthentication: false });
  verifyReadinessLeaseForRequest(lease, request);
  if (attestation.schema !== SCHEMAS.trialFinal) {
    fail('trial final verification requires a final attestation', 'ERR_PROTOCOL_SCHEMA');
  }
  assertDocumentIdentity(attestation, request, 'trial final attestation');
  if (attestation.sequence !== lease.sequence + 1) fail('trial final sequence is not monotonic', 'ERR_PROTOCOL_REPLAY');
  if (!safeHexEqual(attestation.requestHash, protocolDocumentHash(request))) {
    fail('trial final request hash mismatch', 'ERR_PROTOCOL_BINDING');
  }
  if (!safeHexEqual(attestation.readinessLeaseHash, protocolDocumentHash(lease))) {
    fail('trial final readiness lease hash mismatch', 'ERR_PROTOCOL_BINDING');
  }
  if (safeHexEqual(attestation.nonce, lease.nonce) || safeHexEqual(attestation.nonce, request.nonce)) {
    fail('trial final attestation reuses an earlier nonce', 'ERR_PROTOCOL_REPLAY');
  }
  if (instantMs(attestation.issuedAt, 'issuedAt') < instantMs(lease.issuedAt, 'lease.issuedAt')) {
    fail('trial final attestation predates its readiness lease', 'ERR_PROTOCOL_TIME');
  }
  return true;
}

export function appendTrialHashChain({
  order,
  previousChainHash,
  trialAttestation: attestationInput,
  deletionReceipt,
}) {
  const attestation = validateProtocolDocument(attestationInput, { requireAuthentication: false });
  if (attestation.schema !== SCHEMAS.trialFinal) fail('hash chain accepts only trial final attestations', 'ERR_PROTOCOL_SCHEMA');
  assertInteger(order, 'trial chain order', { minimum: 1, maximum: MAX_SESSION_TRIALS });
  assertHash(previousChainHash, 'previousChainHash');
  if (!safeHexEqual(attestation.previousTrialChainHash, previousChainHash)) {
    fail('trial final attestation is bound to a different previous chain hash', 'ERR_PROTOCOL_CHAIN');
  }
  validateDeletionReceipt(deletionReceipt);
  if (deletionReceipt.trialId !== attestation.trialId
      || deletionReceipt.sandboxId !== attestation.bindings.sandboxId) {
    fail('deletion receipt does not match the attested trial sandbox', 'ERR_PROTOCOL_DELETION');
  }
  const deletionReceiptHash = canonicalSha256(deletionReceipt);
  const entry = {
    order,
    previousChainHash,
    trialId: attestation.trialId,
    taskId: attestation.bindings.taskId,
    condition: attestation.bindings.condition,
    trialAttestationHash: protocolDocumentHash(attestation),
    deletionReceipt: strictJsonParser(canonicalJson(deletionReceipt)),
    deletionReceiptHash,
  };
  return {
    ...entry,
    chainHash: canonicalSha256(chainLinkCore(entry)),
  };
}

export function verifySessionTrialHashChain(sessionInput, attestationInputs) {
  const session = validateProtocolDocument(sessionInput, { requireAuthentication: false });
  if (session.schema !== SCHEMAS.sessionFinal) fail('expected a session final attestation', 'ERR_PROTOCOL_SCHEMA');
  if (!Array.isArray(attestationInputs) || attestationInputs.length !== session.trials.length) {
    fail('session trial evidence count does not match its hash chain', 'ERR_PROTOCOL_CHAIN');
  }
  let previous = GENESIS_CHAIN_HASH;
  let spent = 0;
  let lastSequence = 0;
  const nonces = new Set([session.nonce]);
  attestationInputs.forEach((input, index) => {
    const attestation = validateProtocolDocument(input, { requireAuthentication: false });
    const entry = session.trials[index];
    if (attestation.schema !== SCHEMAS.trialFinal) fail('session chain contains non-final evidence', 'ERR_PROTOCOL_SCHEMA');
    if (attestation.sessionId !== session.sessionId) fail('session chain session identity mismatch', 'ERR_PROTOCOL_BINDING');
    if (attestation.sequence <= lastSequence) fail('trial final sequence is not ordered', 'ERR_PROTOCOL_REPLAY');
    if (nonces.has(attestation.nonce)) fail('session chain contains a repeated nonce', 'ERR_PROTOCOL_REPLAY');
    nonces.add(attestation.nonce);
    if (!safeHexEqual(attestation.previousTrialChainHash, previous)) {
      fail('trial attestation previous chain binding mismatch', 'ERR_PROTOCOL_CHAIN');
    }
    if (!safeHexEqual(entry.trialAttestationHash, protocolDocumentHash(attestation))) {
      fail('trial attestation hash mismatch', 'ERR_PROTOCOL_CHAIN');
    }
    if (entry.trialId !== attestation.trialId
        || entry.taskId !== attestation.bindings.taskId
        || entry.condition !== attestation.bindings.condition) {
      fail('trial chain identity mismatch', 'ERR_PROTOCOL_BINDING');
    }
    if (entry.deletionReceipt.trialId !== attestation.trialId
        || entry.deletionReceipt.sandboxId !== attestation.bindings.sandboxId) {
      fail('deletion receipt sandbox binding mismatch', 'ERR_PROTOCOL_DELETION');
    }
    if (instantMs(entry.deletionReceipt.deletionRequestedAt, 'deletionReceipt.deletionRequestedAt')
        < instantMs(attestation.runtimeEvidence.endedAt, 'runtimeEvidence.endedAt')) {
      fail('sandbox deletion predates completion of its trial evidence', 'ERR_PROTOCOL_DELETION');
    }
    if (instantMs(entry.deletionReceipt.observedAbsentAt, 'deletionReceipt.observedAbsentAt')
        > instantMs(session.issuedAt, 'issuedAt')) {
      fail('session final attestation predates observed sandbox deletion', 'ERR_PROTOCOL_DELETION');
    }
    for (const field of SESSION_BINDING_FIELDS) {
      const trialValue = field === 'executionMode'
        ? attestation.executionMode
        : attestation.bindings[field];
      if (session.sessionBindings[field] !== trialValue) {
        fail(`session binding ${field} does not match trial evidence`, 'ERR_PROTOCOL_BINDING');
      }
    }
    spent += attestation.outcome.providerSpendMicrousd;
    previous = entry.chainHash;
    lastSequence = attestation.sequence;
  });
  if (session.sequence !== lastSequence + 1) fail('session final sequence is not monotonic', 'ERR_PROTOCOL_REPLAY');
  if (!Number.isSafeInteger(spent) || spent !== session.budget.sessionSpentMicrousd) {
    fail('session budget does not equal attested trial spend', 'ERR_PROTOCOL_BUDGET');
  }
  if (!safeHexEqual(previous, session.chainHead)) fail('session chain head mismatch', 'ERR_PROTOCOL_CHAIN');
  return true;
}

export class ProtocolReplayGuard {
  #lastSequence;
  #nonces;
  #sessionId;
  #maximumMessages;

  constructor({ initialSequence = 0, sessionId, maximumMessages = 4_096 } = {}) {
    assertInteger(initialSequence, 'initialSequence', { maximum: MAX_PROTOCOL_SEQUENCE });
    assertInteger(maximumMessages, 'maximumMessages', { minimum: 1, maximum: MAX_PROTOCOL_SEQUENCE });
    if (sessionId !== undefined) assertSafeId(sessionId, 'sessionId');
    this.#lastSequence = initialSequence;
    this.#nonces = new Set();
    this.#sessionId = sessionId;
    this.#maximumMessages = maximumMessages;
  }

  get lastSequence() {
    return this.#lastSequence;
  }

  get sessionId() {
    return this.#sessionId;
  }

  accept(input, { now = new Date() } = {}) {
    const document = validateProtocolDocument(input, { requireAuthentication: false });
    enforceFreshness(document, now);
    if (this.#sessionId !== undefined && document.sessionId !== this.#sessionId) {
      fail('replay guard session identity mismatch', 'ERR_PROTOCOL_REPLAY');
    }
    if (document.sequence !== this.#lastSequence + 1) {
      fail('protocol sequence is not the next monotonic value', 'ERR_PROTOCOL_REPLAY');
    }
    if (this.#nonces.has(document.nonce)) fail('protocol nonce replay detected', 'ERR_PROTOCOL_REPLAY');
    if (this.#nonces.size >= this.#maximumMessages) {
      fail('replay guard message bound exceeded', 'ERR_PROTOCOL_BOUNDS');
    }
    if (this.#sessionId === undefined) this.#sessionId = document.sessionId;
    this.#nonces.add(document.nonce);
    this.#lastSequence = document.sequence;
    return true;
  }
}

export const RuntimeProtocolSchemas = SCHEMAS;
