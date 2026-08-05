import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  READINESS_PREFLIGHT_PATH,
  ReadinessPreflightError,
  consumeReadinessPreflightReceipt,
  createReadinessPreflightReceipt,
  publishReadinessPreflightReceipt,
  runReadinessPreflight,
  validateReadinessPreflightReceipt,
} from '../../../evals/runtime/readiness-preflight.mjs';
import { createRuntimeNetworkPolicyReceipt } from '../../../evals/runtime/runtime-evidence.mjs';

const TEN_GIB = 10 * 1024 * 1024 * 1024;
const HASH = (character) => character.repeat(64);
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function networkPolicy() {
  return createRuntimeNetworkPolicyReceipt({
    runnerUid: 2001,
    brokerUid: 2002,
    providerHostname: 'openrouter.ai',
    providerHttpsPort: 443,
    providerAddresses: { ipv4: ['104.18.2.10'], ipv6: [] },
    dnsServers: [{ address: '10.0.0.2', family: 4, port: 53 }],
    metadataCidrs: ['169.254.0.0/16', '100.100.100.200/32', 'fe80::/10', 'fd00:ec2::254/128'],
    iptablesExecutableHash: HASH('a'),
    ip6tablesExecutableHash: HASH('b'),
    producerExecutableHash: HASH('2'),
    sandboxId: 'sandbox-1',
    sandboxBootId: '11111111-2222-3333-4444-555555555555',
    requestHash: HASH('1'),
    trialId: 'trial-1',
    producerSessionId: HASH('5'),
  });
}

function input(overrides = {}) {
  const base = {
    requestHash: HASH('1'),
    releaseSha: '1'.repeat(40),
    taskLockHash: HASH('6'),
    bundleHash: HASH('7'),
    executionMode: 'zero-provider-canary',
    condition: 'generic',
    imageDigest: `sha256:${HASH('d')}`,
    sandboxId: 'sandbox-1',
    sandboxBootId: '11111111-2222-3333-4444-555555555555',
    trialId: 'trial-1',
    cgroup: { id: 'trial-cgroup-1', pathHash: HASH('f') },
    filesystem: {
      id: 'dev:feed',
      bytes: TEN_GIB,
      evidenceReserveBytes: 256 * 1024 * 1024,
    },
    networkPolicy: networkPolicy(),
    materialization: {
      trialId: 'trial-1',
      imageDigest: `sha256:${HASH('d')}`,
      workspaceFilesystemId: 'dev:feed',
      receiptHash: HASH('8'),
    },
    executables: {
      producerExecutableHash: HASH('2'),
      readinessProbeExecutableHash: HASH('3'),
      runnerExecutableHash: HASH('4'),
      harborExecutableHash: HASH('9'),
      storageAllocatorExecutableHash: HASH('d'),
      taskIsolationProbeExecutableHash: HASH('e'),
      readinessDenialProbeExecutableHash: HASH('a'),
    },
  };
  return {
    ...base,
    ...overrides,
    cgroup: { ...base.cgroup, ...overrides.cgroup },
    filesystem: { ...base.filesystem, ...overrides.filesystem },
    networkPolicy: overrides.networkPolicy ?? base.networkPolicy,
    materialization: { ...base.materialization, ...overrides.materialization },
    executables: { ...base.executables, ...overrides.executables },
  };
}

function observations(condition = 'generic') {
  return {
    conditionMount: {
      condition,
      passed: true,
      inventoryHash: HASH('a'),
    },
    noProvider: {
      completed: true,
      providerCalls: 0,
      providerCredentialAbsent: true,
      brokerSocketAbsent: true,
      proofHash: HASH('b'),
    },
    storage: {
      schema: 'engineer-readiness-storage-observation.v2',
      filesystemId: 'dev:feed',
      totalBytes: TEN_GIB,
      preallocationRequestedBytes: 8 * 1024 * 1024 * 1024,
      allocatedBytesObserved: 8 * 1024 * 1024 * 1024,
      writeAttemptLimitBytes: 64 * 1024 * 1024,
      bytesWrittenBeforeEnospc: 0,
      availableBytesAfterCleanup: 512 * 1024 * 1024,
      enospcObserved: true,
      evidenceHeadroomRecovered: true,
      proofHash: HASH('c'),
    },
    runner: {
      uid: 2001,
      effectiveCapabilities: 0,
      privateDaemonDenied: true,
      realDaemonDenied: true,
      alternateDaemonDenied: true,
      mountDenied: true,
      ptraceDenied: true,
      providerEgressDenied: true,
      metadataDenied: true,
      daytonaCredentialsAbsent: true,
      providerCredentialsAbsent: true,
      proofHash: HASH('d'),
    },
    task: {
      networkNone: true,
      readOnlyRoot: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      brokerReachable: false,
      brokerSocketMounted: false,
      brokerClientGidPresent: false,
      observationHash: HASH('e'),
    },
  };
}

function receipt() {
  return createReadinessPreflightReceipt({
    bindings: input(),
    observations: observations(),
    producedAt: '2026-08-04T16:00:00.000Z',
    expiresAt: '2026-08-04T16:01:00.000Z',
    producerNonce: HASH('f'),
  });
}

function secureAttestation(document, overrides = {}) {
  const bytes = Buffer.from(canonicalJson(document));
  const common = {
    path: READINESS_PREFLIGHT_PATH,
    kind: 'regular-file',
    real: true,
    symlink: false,
    ownerUid: 0,
    ownerGid: 0,
    mode: 0o600,
    nlink: 1,
    dev: '11',
    ino: '22',
    byteLength: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  return { ...common, ...overrides };
}

test('receipt is exact, hash-bound, zero-provider-only, and condition-scoped', () => {
  const document = receipt();
  assert.equal(document.bindings.executionMode, 'zero-provider-canary');
  assert.equal(document.bindings.condition, 'generic');
  assert.equal(document.observations.conditionMount.condition, 'generic');
  assert.equal(document.observations.conditionMount.passed, true);
  assert.match(document.bindingHash, /^[a-f0-9]{64}$/);
  assert.match(document.receiptHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateReadinessPreflightReceipt(document, {
    expectedBindings: document.bindings,
    observedAt: '2026-08-04T16:00:30.000Z',
  }), document);

  assert.throws(() => createReadinessPreflightReceipt({
    bindings: input({ executionMode: 'controlled-provider' }),
    observations: observations(),
    producedAt: '2026-08-04T16:00:00.000Z',
    expiresAt: '2026-08-04T16:01:00.000Z',
    producerNonce: HASH('f'),
  }), /zero-provider/i);
  assert.throws(() => createReadinessPreflightReceipt({
    bindings: input(),
    observations: observations('harness'),
    producedAt: '2026-08-04T16:00:00.000Z',
    expiresAt: '2026-08-04T16:01:00.000Z',
    producerNonce: HASH('f'),
  }), /condition/i);
});

test('rejects unknown fields, tamper, replay binding, stale boot, and stale time', () => {
  const document = receipt();
  for (const candidate of [
    { ...document, extra: true },
    { ...document, receiptHash: HASH('0') },
    { ...document, bindings: { ...document.bindings, sandboxBootId: 'boot-replayed' } },
    { ...document, observations: {
      ...document.observations,
      runner: { ...document.observations.runner, mountDenied: false },
    } },
  ]) assert.throws(() => validateReadinessPreflightReceipt(candidate, {
    expectedBindings: document.bindings,
    observedAt: '2026-08-04T16:00:30.000Z',
  }), ReadinessPreflightError);

  assert.throws(() => validateReadinessPreflightReceipt(document, {
    expectedBindings: { ...document.bindings, requestHash: HASH('0') },
    observedAt: '2026-08-04T16:00:30.000Z',
  }), /binding|replay/i);
  assert.throws(() => validateReadinessPreflightReceipt(document, {
    expectedBindings: document.bindings,
    observedAt: '2026-08-04T16:01:00.001Z',
  }), /stale|window/i);
});

test('publishes without overwrite and consumes once with stable root custody', () => {
  const document = receipt();
  const writes = [];
  const publication = publishReadinessPreflightReceipt(document, {
    store: {
      publishExclusive(spec) {
        writes.push(spec);
        return secureAttestation(document, {
          byteLength: spec.bytes.length,
          sha256: crypto.createHash('sha256').update(spec.bytes).digest('hex'),
        });
      },
    },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, READINESS_PREFLIGHT_PATH);
  assert.equal(writes[0].mode, 0o600);
  assert.equal(publication.receiptHash, document.receiptHash);
  assert.deepEqual(publication.bindings, document.bindings);

  const bytes = Buffer.from(canonicalJson(document));
  const attestation = secureAttestation(document);
  let consumed = 0;
  const value = consumeReadinessPreflightReceipt(publication, {
    observedAt: '2026-08-04T16:00:30.000Z',
    store: {
      consumeOnce(spec) {
        consumed += 1;
        assert.equal(spec.path, READINESS_PREFLIGHT_PATH);
        return {
          bytes: Buffer.from(bytes),
          parent: { real: true, symlink: false, kind: 'directory', ownerUid: 0, ownerGid: 0, mode: 0o700 },
          before: attestation,
          after: { ...attestation },
          removed: true,
        };
      },
    },
  });
  assert.equal(consumed, 1);
  assert.deepEqual(value, document);
  bytes.fill(0);

  for (const drift of [
    { before: { ownerUid: 2001 } },
    { after: { ino: '23' } },
    { parent: { mode: 0o755 } },
    { removed: false },
  ]) {
    assert.throws(() => consumeReadinessPreflightReceipt(publication, {
      observedAt: '2026-08-04T16:00:30.000Z',
      store: {
        consumeOnce() {
          return {
            bytes: Buffer.from(canonicalJson(document)),
            parent: { real: true, symlink: false, kind: 'directory', ownerUid: 0, ownerGid: 0, mode: 0o700, ...drift.parent },
            before: { ...attestation, ...drift.before },
            after: { ...attestation, ...drift.after },
            removed: drift.removed ?? true,
          };
        },
      },
    }), /custody|identity|one-time/i);
  }
});

test('producer publishes only after all active probes pass and fails closed on missing pinned denial helper', async () => {
  const calls = [];
  const probeValues = observations();
  const publication = await runReadinessPreflight(input(), {
    clock: () => new Date('2026-08-04T16:00:00.000Z'),
    nonce: () => HASH('f'),
    probes: {
      async inspectProducer(spec) {
        calls.push(['inspectProducer', spec]);
        return {
          platform: 'linux',
          effectiveUid: 0,
          sandboxBootId: spec.bindings.sandboxBootId,
          executableHashes: {
            producerExecutableHash: spec.bindings.producerExecutableHash,
            readinessProbeExecutableHash: spec.bindings.readinessProbeExecutableHash,
            runnerExecutableHash: spec.bindings.runnerExecutableHash,
            harborExecutableHash: spec.bindings.harborExecutableHash,
            storageAllocatorExecutableHash:
              spec.bindings.storageAllocatorExecutableHash,
            taskIsolationProbeExecutableHash: spec.bindings.taskIsolationProbeExecutableHash,
            readinessDenialProbeExecutableHash:
              spec.bindings.readinessDenialProbeExecutableHash,
          },
        };
      },
      async probeConditionMount() { calls.push(['condition']); return probeValues.conditionMount; },
      async probeProviderAbsence() { calls.push(['provider']); return probeValues.noProvider; },
      async probeStorage() { calls.push(['storage']); return probeValues.storage; },
      async probeRunnerDenials() { calls.push(['runner']); return probeValues.runner; },
      async probeTaskIsolation() { calls.push(['task']); return probeValues.task; },
    },
    store: {
      publishExclusive(spec) {
        const document = JSON.parse(spec.bytes.toString('utf8'));
        return secureAttestation(document, {
          byteLength: spec.bytes.length,
          sha256: crypto.createHash('sha256').update(spec.bytes).digest('hex'),
        });
      },
    },
  });
  assert.deepEqual(calls.map(([name]) => name), [
    'inspectProducer', 'condition', 'provider', 'storage', 'runner', 'task',
  ]);
  assert.equal(publication.bindings.condition, 'generic');

  const missing = new ReadinessPreflightError(
    'pinned canary must attempt mount and ptrace denials',
    'ERR_READINESS_PREFLIGHT_MISSING_PINNED_DENIAL_HELPER',
  );
  await assert.rejects(runReadinessPreflight(input(), {
    probes: {
      async inspectProducer({ bindings }) {
        return {
          platform: 'linux', effectiveUid: 0, sandboxBootId: bindings.sandboxBootId,
          executableHashes: {
            producerExecutableHash: bindings.producerExecutableHash,
            readinessProbeExecutableHash: bindings.readinessProbeExecutableHash,
            runnerExecutableHash: bindings.runnerExecutableHash,
            harborExecutableHash: bindings.harborExecutableHash,
            storageAllocatorExecutableHash: bindings.storageAllocatorExecutableHash,
            taskIsolationProbeExecutableHash: bindings.taskIsolationProbeExecutableHash,
            readinessDenialProbeExecutableHash:
              bindings.readinessDenialProbeExecutableHash,
          },
        };
      },
      async probeConditionMount() { throw missing; },
      async probeProviderAbsence() { throw missing; },
      async probeStorage() { throw missing; },
      async probeRunnerDenials() { throw missing; },
      async probeTaskIsolation() { throw missing; },
    },
  }), (error) => {
    assert.equal(error instanceof ReadinessPreflightError, true);
    assert.equal(error.code, 'ERR_READINESS_PREFLIGHT_MISSING_PINNED_DENIAL_HELPER');
    assert.match(error.message, /mount.*ptrace|ptrace.*mount/i);
    return true;
  });
});
