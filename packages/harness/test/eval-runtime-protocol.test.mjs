import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  GENESIS_CHAIN_HASH,
  MAX_PROTOCOL_BYTES,
  ProtocolReplayGuard,
  appendTrialHashChain,
  canonicalJson,
  generateNonce,
  sha256Hex,
  signProtocolDocument,
  validateProtocolDocument,
  verifyProtocolDocument,
  verifyReadinessLeaseForRequest,
  verifySessionTrialHashChain,
  verifyTrialAttestationForLease,
} from '../../../evals/runtime/protocol.mjs';

const KEY = Buffer.alloc(32, 0x41);
const NOW = new Date('2026-08-04T20:00:00.000Z');
const HOUR_LATER = '2026-08-04T21:00:00.000Z';
const DAY_LATER = '2026-08-05T20:00:00.000Z';
const HASH = (character) => character.repeat(64);

const bindings = Object.freeze({
  releaseSha: 'a'.repeat(40),
  profileId: 'economical-small-model',
  taskId: 'cobol-modernization',
  taskLockHash: HASH('b'),
  bundleHash: HASH('c'),
  condition: 'generic',
  imageDigest: `sha256:${HASH('d')}`,
  sandboxId: 'daytona-sandbox-1',
  sandboxBootId: 'boot-1',
  daemonId: 'private-daemon-1',
  daemonRootHash: HASH('e'),
  cgroupId: 'trial-cgroup-1',
  cgroupPathHash: HASH('f'),
  budgetId: 'qualification-budget-1',
  budgetPolicyHash: HASH('1'),
  brokerPolicyHash: HASH('0'),
  supervisorExecutableHash: HASH('2'),
  runnerExecutableHash: HASH('3'),
  harborExecutableHash: HASH('4'),
});

const budget = Object.freeze({
  currency: 'USD',
  trialCeilingMicrousd: 650_000,
  sessionCeilingMicrousd: 1_300_000,
  sessionCommittedMicrousd: 650_000,
});

function trialRequest(overrides = {}) {
  return {
    schema: 'engineer-runtime-trial-request.v1',
    protocolVersion: 1,
    sessionId: 'session-1',
    trialId: 'trial-1',
    sequence: 1,
    nonce: HASH('5'),
    issuedAt: NOW.toISOString(),
    expiresAt: HOUR_LATER,
    previousTrialChainHash: GENESIS_CHAIN_HASH,
    bindings: { ...bindings },
    budget: { ...budget },
    ...overrides,
  };
}

function readiness(request, overrides = {}) {
  return {
    schema: 'engineer-runtime-readiness-lease.v1',
    protocolVersion: 1,
    sessionId: request.sessionId,
    trialId: request.trialId,
    sequence: 2,
    nonce: HASH('6'),
    issuedAt: NOW.toISOString(),
    expiresAt: '2026-08-04T20:05:00.000Z',
    requestHash: sha256Hex(canonicalJson(request)),
    requestNonce: request.nonce,
    previousTrialChainHash: request.previousTrialChainHash,
    bindings: { ...request.bindings },
    budget: { ...request.budget },
    readiness: {
      noProviderProbeHash: HASH('7'),
      dockerProxyPolicyHash: HASH('8'),
      brokerPolicyHash: request.bindings.brokerPolicyHash,
      storageProbeHash: HASH('a'),
      privateDaemonBounded: true,
      realDaemonDenied: true,
      taskNetworkNone: true,
      brokerOnlyEgress: true,
      cgroupDelegated: true,
      evidenceHeadroomReserved: true,
    },
    ...overrides,
  };
}

function finalAttestation(request, lease, overrides = {}) {
  return {
    schema: 'engineer-runtime-trial-final-attestation.v1',
    protocolVersion: 1,
    sessionId: request.sessionId,
    trialId: request.trialId,
    sequence: 3,
    nonce: HASH('b'),
    issuedAt: '2026-08-04T20:10:00.000Z',
    expiresAt: DAY_LATER,
    requestHash: sha256Hex(canonicalJson(request)),
    readinessLeaseHash: sha256Hex(canonicalJson(lease)),
    previousTrialChainHash: request.previousTrialChainHash,
    bindings: { ...request.bindings },
    budget: { ...request.budget },
    outcome: {
      status: 'succeeded',
      exitReason: 'verified',
      providerSpendMicrousd: 125_000,
      providerUsageHash: HASH('c'),
    },
    runtimeEvidence: {
      evidenceHash: HASH('d'),
      dockerEventsHash: HASH('e'),
      mountInventoryHash: HASH('f'),
      cgroupEvidenceHash: HASH('1'),
      networkEvidenceHash: HASH('2'),
      budgetEvidenceHash: HASH('3'),
      startedAt: '2026-08-04T20:01:00.000Z',
      endedAt: '2026-08-04T20:09:00.000Z',
    },
    cleanup: {
      completed: true,
      containersRemaining: 0,
      networksRemaining: 0,
      volumesRemaining: 0,
      processesRemaining: 0,
      cgroupPopulated: false,
    },
    ...overrides,
  };
}

function deletionReceipt(attestation, overrides = {}) {
  return {
    trialId: attestation.trialId,
    sandboxId: attestation.bindings.sandboxId,
    deletionRequestId: 'daytona-delete-1',
    deletionRequestedAt: '2026-08-04T20:11:00.000Z',
    observedAbsentAt: '2026-08-04T20:12:00.000Z',
    platformEvidenceHash: HASH('4'),
    ...overrides,
  };
}

test('canonical JSON is deterministic, recursive, and rejects values JSON would erase or blur', () => {
  assert.equal(
    canonicalJson({ z: [3, { b: true, a: 'x' }], a: 1 }),
    '{"a":1,"z":[3,{"a":"x","b":true}]}'
  );
  assert.equal(sha256Hex('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
  assert.throws(() => canonicalJson({ absent: undefined }), /undefined|unsupported/i);
  assert.throws(() => canonicalJson({ nil: null }), /null/i);
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /finite/i);
  assert.throws(() => canonicalJson({ negativeZero: -0 }), /negative zero/i);
  assert.throws(() => canonicalJson(Object.assign(Object.create(null), { ok: true })), /plain object/i);
  assert.throws(() => canonicalJson(new Array(1)), /sparse/i);
  assert.throws(() => canonicalJson({ [Symbol('hidden')]: true }), /symbol/i);
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'mutable' });
  assert.throws(() => canonicalJson(accessor), /data field/i);
});

test('all four additive schemas are strict, versioned, and share the runtime identifier bound', () => {
  for (const file of [
    'runtime-trial-request.v1.schema.json',
    'runtime-readiness-lease.v1.schema.json',
    'runtime-trial-final-attestation.v1.schema.json',
    'runtime-session-final-attestation.v1.schema.json',
  ]) {
    const schema = JSON.parse(fs.readFileSync(new URL(`../../../evals/schema/${file}`, import.meta.url), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.protocolVersion.const, 1);
    assert.ok(schema.maxProperties > 0);
    assert.equal(schema.$defs.id.maxLength, 128);
  }

  const maximumId = 'a'.repeat(128);
  assert.doesNotThrow(() => validateProtocolDocument(
    trialRequest({ sessionId: maximumId }),
    { requireAuthentication: false },
  ));
  assert.throws(
    () => validateProtocolDocument(
      trialRequest({ sessionId: `${maximumId}a` }),
      { requireAuthentication: false },
    ),
    /sessionId.*1-128 UTF-8 bytes/i,
  );
});

test('nonces are exactly 32 cryptographically random bytes rendered as lowercase hex', () => {
  const values = new Set(Array.from({ length: 16 }, () => generateNonce()));
  assert.equal(values.size, 16);
  for (const value of values) assert.match(value, /^[a-f0-9]{64}$/);
  assert.throws(() => validateProtocolDocument(trialRequest({ nonce: 'short' }), { requireAuthentication: false }), /nonce/i);
});

test('signed documents authenticate canonical bytes and bind every requested runtime identity', () => {
  const request = trialRequest();
  const signed = signProtocolDocument(request, KEY, { keyId: 'runtime-key-1' });
  assert.equal(signed.authentication.algorithm, 'HMAC-SHA256');
  assert.equal(signed.authentication.payloadSha256, sha256Hex(canonicalJson(request)));
  assert.deepEqual(
    verifyProtocolDocument(JSON.stringify(signed), KEY, { expectedKeyId: 'runtime-key-1', now: NOW }),
    signed
  );

  const tampered = structuredClone(signed);
  tampered.bindings.imageDigest = `sha256:${HASH('e')}`;
  assert.throws(() => verifyProtocolDocument(tampered, KEY, { now: NOW }), /authentication failed/i);
  assert.throws(() => verifyProtocolDocument(signed, Buffer.alloc(32, 0x42), { now: NOW }), /authentication failed/i);
});

test('strict parsing fails closed on malformed, duplicate, oversized, nil, and unknown fields', () => {
  const signed = signProtocolDocument(trialRequest(), KEY, { keyId: 'runtime-key-1' });
  const duplicate = JSON.stringify(signed).replace('"sequence":1', '"sequence":1,"sequence":1');
  assert.throws(() => verifyProtocolDocument('{', KEY), /malformed/i);
  assert.throws(() => verifyProtocolDocument(duplicate, KEY), /duplicate/i);
  assert.throws(
    () => verifyProtocolDocument('{"__proto__":{"polluted":true}}', KEY),
    /unknown|schema/i
  );
  assert.equal({}.polluted, undefined);
  assert.throws(() => verifyProtocolDocument(Buffer.from([0xff]), KEY), /UTF-8/i);
  assert.throws(() => verifyProtocolDocument(' '.repeat(MAX_PROTOCOL_BYTES + 1), KEY), /size|large/i);
  assert.throws(() => validateProtocolDocument({ ...trialRequest(), unexpected: true }, { requireAuthentication: false }), /unknown/i);
  assert.throws(() => validateProtocolDocument({ ...trialRequest(), trialId: null }, { requireAuthentication: false }), /null|trialId/i);
  assert.throws(() => validateProtocolDocument(undefined, { requireAuthentication: false }), /required|object|unsupported/i);
});

test('expiry and key identifiers are enforced before a lease can authorize work', () => {
  const signed = signProtocolDocument(trialRequest(), KEY, { keyId: 'runtime-key-1' });
  assert.throws(
    () => verifyProtocolDocument(signed, KEY, { now: new Date(HOUR_LATER) }),
    /expired/i
  );
  assert.throws(
    () => verifyProtocolDocument(signed, KEY, { expectedKeyId: 'different-key', now: NOW }),
    /key/i
  );
  assert.throws(
    () => signProtocolDocument(trialRequest({ expiresAt: '2026-08-04T22:00:00.000Z' }), KEY),
    /lifetime|expiry/i
  );
});

test('readiness and final evidence must match the exact request, lease, binding, and budget', () => {
  const request = trialRequest();
  const lease = readiness(request);
  assert.doesNotThrow(() => verifyReadinessLeaseForRequest(lease, request));
  assert.throws(
    () => verifyReadinessLeaseForRequest({ ...lease, bindings: { ...lease.bindings, condition: 'harness' } }, request),
    /binding/i
  );

  const attestation = finalAttestation(request, lease);
  assert.doesNotThrow(() => verifyTrialAttestationForLease(attestation, lease, request));
  assert.throws(
    () => verifyTrialAttestationForLease({ ...attestation, outcome: { ...attestation.outcome, providerSpendMicrousd: 650_001 } }, lease, request),
    /budget/i
  );
  assert.throws(
    () => validateProtocolDocument({ ...attestation, cleanup: { ...attestation.cleanup, processesRemaining: 1 } }, { requireAuthentication: false }),
    /cleanup/i
  );
});

test('replay guard requires an exact monotonic sequence and globally unique 32-byte nonces', () => {
  const guard = new ProtocolReplayGuard({ initialSequence: 0 });
  const request = trialRequest();
  const lease = readiness(request);
  guard.accept(request, { now: NOW });
  guard.accept(lease, { now: NOW });
  assert.throws(() => guard.accept(lease, { now: NOW }), /sequence|replay/i);
  assert.throws(
    () => guard.accept({ ...finalAttestation(request, lease), sessionId: 'other-session' }, { now: new Date('2026-08-04T20:10:00.000Z') }),
    /session/i
  );
  const finalNow = new Date('2026-08-04T20:10:00.000Z');
  assert.throws(() => guard.accept({ ...finalAttestation(request, lease), sequence: 4 }, { now: finalNow }), /sequence/i);
  assert.throws(
    () => guard.accept({ ...finalAttestation(request, lease), nonce: request.nonce }, { now: finalNow }),
    /nonce|replay/i
  );
});

test('ordered hash chain binds final attestations and whole-sandbox deletion receipts', () => {
  const request = trialRequest();
  const lease = readiness(request);
  const attestation = finalAttestation(request, lease);
  const first = appendTrialHashChain({
    order: 1,
    previousChainHash: GENESIS_CHAIN_HASH,
    trialAttestation: attestation,
    deletionReceipt: deletionReceipt(attestation),
  });
  const session = {
    schema: 'engineer-runtime-session-final-attestation.v1',
    protocolVersion: 1,
    sessionId: request.sessionId,
    sequence: 4,
    nonce: HASH('f'),
    issuedAt: '2026-08-04T20:13:00.000Z',
    expiresAt: DAY_LATER,
    sessionBindings: {
      releaseSha: request.bindings.releaseSha,
      profileId: request.bindings.profileId,
      taskLockHash: request.bindings.taskLockHash,
      bundleHash: request.bindings.bundleHash,
      budgetId: request.bindings.budgetId,
      budgetPolicyHash: request.bindings.budgetPolicyHash,
      brokerPolicyHash: request.bindings.brokerPolicyHash,
    },
    trials: [first],
    chainHead: first.chainHash,
    budget: {
      currency: 'USD',
      sessionCeilingMicrousd: budget.sessionCeilingMicrousd,
      sessionCommittedMicrousd: budget.sessionCommittedMicrousd,
      sessionSpentMicrousd: attestation.outcome.providerSpendMicrousd,
    },
    evidenceArchiveHash: HASH('a'),
  };

  assert.doesNotThrow(() => verifySessionTrialHashChain(session, [attestation]));
  assert.throws(
    () => verifySessionTrialHashChain({ ...session, trials: [{ ...first, deletionReceipt: { ...first.deletionReceipt, sandboxId: 'other' } }] }, [attestation]),
    /deletion|chain|sandbox/i
  );
  assert.throws(
    () => validateProtocolDocument({ ...session, chainHead: GENESIS_CHAIN_HASH }, { requireAuthentication: false }),
    /chain/i
  );
  assert.throws(
    () => verifySessionTrialHashChain({ ...session, sequence: 5 }, [attestation]),
    /sequence/i
  );
});
