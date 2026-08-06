import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RuntimeControlFailureCodes,
  RuntimeControlFailurePhases,
  canonicalJson,
  canonicalSha256,
  signProtocolDocument,
  verifyRuntimeControlFailure,
} from '../runtime/protocol.mjs';
import {
  SupervisorHandlerError,
  createSupervisorHandlerFactory,
} from '../runtime/supervisor-handler.mjs';

const HASH = (character) => character.repeat(64);
const HMAC_KEY = Buffer.alloc(32, 0x41);
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const RESERVE_BYTES = 256 * 1024 * 1024;

function privateDaemonFailureEffects(lifecycle, remoteDetail) {
  return {
    async inspectPlatform() {
      lifecycle.push('inspectPlatform');
      return {
        platform: 'linux',
        effectiveUid: 0,
        sandboxId: 'sandbox-1',
        sandboxBootId: 'boot-1',
        supervisorExecutableHash: HASH('5'),
        cgroupVersion: 2,
        cgroupDelegated: true,
        filesystem: {
          sandboxRootId: 'bounded-fs',
          sandboxRootBytes: TEN_GIB,
          boundedRootId: 'bounded-fs',
          boundedRootBytes: TEN_GIB,
          defaultDockerRootId: 'forbidden-host-fs',
          privateDaemonDataRoot: '/engineer-bounded/docker',
        },
        identities: {
          supervisorUid: 0,
          runnerUid: 2001,
          runnerGid: 2001,
          brokerUid: 2002,
          brokerGid: 2002,
          brokerClientGid: 2003,
        },
        controlChannel: { kind: 'inherited-pipe', authenticated: true, open: true },
        providerCredentialsAbsent: true,
        daytonaCredentialsAbsent: true,
        custody: {
          coreDumpsDisabled: true,
          evidenceStoreOwnerUid: 0,
          evidenceStoreMode: 0o700,
          evidenceRetentionDays: 30,
          snapshotCredentialExclusion: true,
        },
      };
    },
    async inspectProviderKeyFd() { return { kind: 'pipe', open: true }; },
    async reserveEvidenceHeadroom() {
      lifecycle.push('reserveEvidenceHeadroom');
      return { bytes: RESERVE_BYTES, filesystemId: 'bounded-fs', protectedFromRunner: true };
    },
    async startPrivateDaemon() {
      lifecycle.push('startPrivateDaemon');
      throw new Error(remoteDetail);
    },
    async startDockerProxy() { throw new Error('not reached'); },
    async startProviderBroker() { throw new Error('not reached'); },
    async closeInheritedFd() { lifecycle.push('closeInheritedFd'); return { closed: true }; },
    async inspectReadiness() { throw new Error('not reached'); },
    installControlChannelLossHandler() { return () => {}; },
    async launchRunner() { throw new Error('not reached'); },
    async collectFinalEvidence() { throw new Error('not reached'); },
    async killTrialCgroup() { lifecycle.push('killTrialCgroup'); return { killed: true }; },
    async shutdown() { lifecycle.push('shutdown'); return { completed: true }; },
  };
}

function factoryHarness(overrides = {}) {
  const calls = [];
  const factory = createSupervisorHandlerFactory({
    effects: overrides.effects ?? {},
    dockerPolicy: { policyId: 'docker-policy-v1' },
    brokerPolicy: { policyId: 'broker-policy-v1' },
    runner: {
      argv: ['/opt/engineer/bin/eval-runner'],
      cwd: '/engineer-bounded/work',
      env: { LANG: 'C.UTF-8' },
      timeoutMs: 60_000,
    },
    keyId: 'supervisor-key-1',
    expectedControllerKeyId: 'controller-key-1',
    openProviderKeyFd: async () => { calls.push(['openProviderKeyFd']); return 7; },
    closeProviderKeyFd: async (fd) => { calls.push(['closeProviderKeyFd', fd]); },
    inspectBinding: async (binding) => ({
      allocationId: binding.allocationId,
      taskArchive: structuredClone(binding.taskArchive),
      runtimeBindings: {
        sandboxBootId: 'boot-1',
        daemonId: 'daemon-1',
        daemonRootHash: HASH('2'),
        cgroupId: 'cgroup-1',
        cgroupPathHash: HASH('3'),
      },
    }),
    inspectTrialOutput: async () => ({ kind: 'trial-output', byteLength: 1, sha256: HASH('4') }),
    supervisorFactory: overrides.realSupervisor
      ? undefined
      : overrides.supervisorFactory ?? (() => ({
      async prepare(input) { calls.push(['prepare', structuredClone(input)]); throw new Error('stop after binding assertion'); },
      async run() { throw new Error('not reached'); },
      async finalize() { throw new Error('not reached'); },
      async failStop(reason) { calls.push(['failStop', reason]); },
      async controlChannelLost(reason) { calls.push(['controlChannelLost', reason]); },
      })),
    clock: { now: () => new Date('2026-08-04T16:00:00.000Z') },
  });
  return { factory, calls };
}

function bindingFields() {
  return {
    releaseSha: HASH('a'),
    profileId: 'zero-provider-canary',
    taskId: 'task-1',
    taskLockHash: HASH('b'),
    bundleHash: HASH('c'),
    condition: 'generic',
    imageDigest: `sha256:${HASH('d')}`,
    sandboxId: 'sandbox-1',
    sandboxBootId: 'boot-1',
    daemonId: 'daemon-1',
    daemonRootHash: HASH('2'),
    cgroupId: 'cgroup-1',
    cgroupPathHash: HASH('3'),
    budgetId: 'budget-1',
    budgetPolicyHash: HASH('e'),
    brokerPolicyHash: HASH('f'),
    supervisorExecutableHash: HASH('5'),
    runnerExecutableHash: HASH('6'),
    harborExecutableHash: HASH('7'),
  };
}

function signedRequest(executionMode) {
  const zero = executionMode === 'zero-provider-canary';
  return signProtocolDocument({
    schema: 'engineer-runtime-trial-request.v1',
    protocolVersion: 1,
    sessionId: 'session-1',
    trialId: 'trial-1',
    sequence: 1,
    nonce: HASH('8'),
    issuedAt: '2026-08-04T15:59:00.000Z',
    expiresAt: '2026-08-04T16:30:00.000Z',
    previousTrialChainHash: HASH('0'),
    executionMode,
    bindings: bindingFields(),
    budget: {
      currency: 'USD',
      trialCeilingMicrousd: zero ? 0 : 1,
      sessionCeilingMicrousd: zero ? 0 : 1,
      sessionCommittedMicrousd: zero ? 0 : 1,
    },
  }, HMAC_KEY, { keyId: 'controller-key-1' });
}

function frame(operation, sequence, previousControlHash, body) {
  return Buffer.from(canonicalJson({
    schema: 'engineer-runtime-control-request.v1',
    protocolVersion: 1,
    operation,
    sessionId: 'session-1',
    trialId: 'trial-1',
    allocationId: 'sandbox-1',
    controlSequence: sequence,
    previousControlHash,
    body,
  }));
}

async function bind(handler, executionMode) {
  const result = await handler.handleFrame(frame('bind', 1, HASH('0'), {
    trial: {
      trialId: 'trial-1',
      taskId: 'task-1',
      condition: 'generic',
      imageDigest: `sha256:${HASH('d')}`,
      trialCeilingMicrousd: executionMode === 'zero-provider-canary' ? 0 : 1,
      supervisorExecutableHash: HASH('5'),
      runnerExecutableHash: HASH('6'),
      harborExecutableHash: HASH('7'),
    },
    taskArchive: { kind: 'task-input', byteLength: 1, sha256: HASH('9') },
  }));
  return canonicalSha256(JSON.parse(result.response.toString('utf8')));
}

test('authenticated handler enforces exact mode-specific provider-key custody', async () => {
  const { factory, calls } = factoryHarness();

  await assert.rejects(factory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: 'controlled-provider',
  }), SupervisorHandlerError);
  await assert.rejects(factory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: 'zero-provider-canary',
    providerKey: Buffer.from('must-not-be-accepted'),
  }), SupervisorHandlerError);
  const hiddenProvider = {
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: 'zero-provider-canary',
  };
  Object.defineProperty(hiddenProvider, 'providerKey', {
    value: Buffer.from('hidden-provider-bytes'),
    enumerable: false,
  });
  await assert.rejects(factory(hiddenProvider), SupervisorHandlerError);

  const zero = await factory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: 'zero-provider-canary',
  });
  assert.equal(calls.some(([name]) => name === 'openProviderKeyFd'), false);
  await zero.close({ reason: 'complete' });
  assert.equal(calls.some(([name]) => name === 'closeProviderKeyFd'), false);

  const controlled = await factory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: 'controlled-provider',
    providerKey: Buffer.from('provider-key-bytes'),
  });
  assert.equal(calls.filter(([name]) => name === 'openProviderKeyFd').length, 1);
  await controlled.close({ reason: 'complete' });
  assert.deepEqual(calls.filter(([name]) => name === 'closeProviderKeyFd').at(-1), ['closeProviderKeyFd', 7]);
});

test('handler rejects a signed request whose execution mode differs from its authenticated channel', async () => {
  const { factory, calls } = factoryHarness();
  const handler = await factory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: 'zero-provider-canary',
  });
  const previous = await bind(handler, 'zero-provider-canary');
  await assert.rejects(handler.handleFrame(frame('readiness', 2, previous, {
    request: signedRequest('controlled-provider'),
  })), /bound|mode|control/i);
  assert.equal(calls.some(([name]) => name === 'prepare'), false);
  assert.equal(calls.some(([name]) => name === 'openProviderKeyFd'), false);
});

test('handler gives the supervisor an exact mode-specific prepare payload', async () => {
  for (const executionMode of ['controlled-provider', 'zero-provider-canary']) {
    const { factory, calls } = factoryHarness();
    const handler = await factory({
      hmacKey: Buffer.from(HMAC_KEY),
      executionMode,
      ...(executionMode === 'controlled-provider'
        ? { providerKey: Buffer.from('provider-key-bytes') }
        : {}),
    });
    const previous = await bind(handler, executionMode);
    const readinessFrame = frame('readiness', 2, previous, {
      request: signedRequest(executionMode),
    });
    await assert.rejects(handler.handleFrame(readinessFrame), /control operation failed/i);

    const prepared = calls.find(([name]) => name === 'prepare')?.[1];
    assert.deepEqual(Object.keys(prepared).sort(), executionMode === 'controlled-provider'
      ? ['brokerPolicy', 'dockerPolicy', 'executionMode', 'providerKeyFd', 'request', 'runner']
      : ['dockerPolicy', 'executionMode', 'request', 'runner']);
    assert.equal(prepared.executionMode, executionMode);
    assert.equal(Object.hasOwn(prepared, 'providerKeyFd'), executionMode === 'controlled-provider');
    assert.equal(Object.hasOwn(prepared, 'brokerPolicy'), executionMode === 'controlled-provider');
    await handler.close({ reason: 'test-complete' });
  }
});

test('handler reports only the allowlisted effect phase after fail-stop completes', async () => {
  const lifecycle = [];
  const remoteDetail = 'sk-or-v1-private-daemon-sensitive-detail';
  const { factory } = factoryHarness({
    effects: privateDaemonFailureEffects(lifecycle, remoteDetail),
    realSupervisor: true,
  });
  const handler = await factory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: 'zero-provider-canary',
  });
  const previous = await bind(handler, 'zero-provider-canary');
  const readinessFrame = frame('readiness', 2, previous, {
    request: signedRequest('zero-provider-canary'),
  });

  const result = await handler.handleFrame(readinessFrame);
  const envelope = JSON.parse(readinessFrame.toString('utf8'));
  const failure = verifyRuntimeControlFailure(result.response, HMAC_KEY, {
    operation: 'readiness',
    sessionId: envelope.sessionId,
    trialId: envelope.trialId,
    allocationId: envelope.allocationId,
    controlSequence: envelope.controlSequence,
    requestHash: canonicalSha256(envelope),
  });

  assert.equal(result.done, true);
  assert.equal(failure.phase, RuntimeControlFailurePhases.START_PRIVATE_DAEMON);
  assert.equal(failure.code, RuntimeControlFailureCodes.START_PRIVATE_DAEMON);
  assert.match(failure.detailSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.response.includes(Buffer.from(remoteDetail)), false);
  assert.deepEqual(lifecycle, [
    'inspectPlatform',
    'reserveEvidenceHeadroom',
    'startPrivateDaemon',
    'killTrialCgroup',
    'shutdown',
  ]);
  await handler.close({ reason: 'complete' });
});

test('handler emits no diagnostic for an unauthenticated readiness request', async () => {
  const { factory, calls } = factoryHarness();
  const handler = await factory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: 'zero-provider-canary',
  });
  const previous = await bind(handler, 'zero-provider-canary');
  const tampered = signedRequest('zero-provider-canary');
  tampered.authentication.signature = HASH('f');

  await assert.rejects(
    handler.handleFrame(frame('readiness', 2, previous, { request: tampered })),
    /signed|structurally|control/i,
  );
  assert.equal(calls.some(([name]) => name === 'prepare'), false);
  await handler.close({ reason: 'failure' });
});
