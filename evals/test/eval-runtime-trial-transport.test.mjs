import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { test } from 'node:test';

import {
  RuntimeControlFailureCodes,
  RuntimeControlFailurePhases,
  canonicalJson,
  protocolDocumentHash,
  signRuntimeControlFailure,
  signProtocolDocument,
} from '../runtime/protocol.mjs';
import {
  CONTROL_GENESIS_HASH,
  createRuntimeTrialTransport,
} from '../runtime/trial-transport.mjs';
import {
  createSupervisorHandlerFactory,
} from '../runtime/supervisor-handler.mjs';

const HASH = (character) => character.repeat(64);
const SESSION_ID = 'release-session-1';
const TRIAL_ID = 'cobol-modernization-generic-1';
const ALLOCATION_ID = 'sandbox-release-1';
const HMAC_KEY = Buffer.alloc(32, 0x41);
const PROVIDER_KEY = Buffer.from('sk-or-v1-one-shot-provider-key');

function gzipTarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  const writeOctal = (value, offset, length) => {
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  };
  writeOctal(0o600, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(content.length, 124, 12);
  writeOctal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  const raw = Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
  try {
    return zlib.gzipSync(raw, { level: 9, mtime: 0 });
  } finally {
    raw.fill(0);
  }
}

const TASK_ARCHIVE = gzipTarEntry(
  'work/payload.txt',
  Buffer.from('content-addressed source with the noncredential scanner prefix sk-or-'),
);
const OUTPUT_ARCHIVE = Buffer.from('content-addressed trial output');
const NOW = '2026-08-04T20:00:00.000Z';
const CONTROLLED_PROVIDER = 'controlled-provider';
const ZERO_PROVIDER_CANARY = 'zero-provider-canary';
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const RESERVE_BYTES = 256 * 1024 * 1024;

const RUNTIME_BINDINGS = Object.freeze({
  sandboxBootId: 'sandbox-boot-1',
  daemonId: 'private-daemon-1',
  daemonRootHash: HASH('4'),
  cgroupId: 'trial-cgroup-1',
  cgroupPathHash: HASH('5'),
});

const SPEC = Object.freeze({
  trialId: TRIAL_ID,
  taskId: 'cobol-modernization',
  condition: 'generic',
  imageDigest: `sha256:${HASH('6')}`,
  trialCeilingMicrousd: 650_000,
  supervisorExecutableHash: HASH('7'),
  runnerExecutableHash: HASH('8'),
  harborExecutableHash: HASH('9'),
});

const ALLOCATION = Object.freeze({
  id: ALLOCATION_ID,
  labels: Object.freeze({ 'trial-id': TRIAL_ID }),
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function resignControlFailure(value, overrides) {
  const { authentication: _authentication, ...unsigned } = value;
  return signRuntimeControlFailure({ ...unsigned, ...overrides }, HMAC_KEY);
}

function request(overrides = {}) {
  const unsigned = {
    schema: 'engineer-runtime-trial-request.v1',
    protocolVersion: 1,
    sessionId: SESSION_ID,
    trialId: TRIAL_ID,
    sequence: 1,
    nonce: HASH('a'),
    issuedAt: NOW,
    expiresAt: '2026-08-04T20:30:00.000Z',
    previousTrialChainHash: HASH('0'),
    executionMode: CONTROLLED_PROVIDER,
    bindings: {
      releaseSha: 'b'.repeat(40),
      profileId: 'economical-small-model',
      taskId: SPEC.taskId,
      taskLockHash: HASH('1'),
      bundleHash: HASH('2'),
      condition: SPEC.condition,
      imageDigest: SPEC.imageDigest,
      sandboxId: ALLOCATION_ID,
      ...RUNTIME_BINDINGS,
      budgetId: 'qualification-budget-1',
      budgetPolicyHash: HASH('3'),
      brokerPolicyHash: HASH('4'),
      supervisorExecutableHash: SPEC.supervisorExecutableHash,
      runnerExecutableHash: SPEC.runnerExecutableHash,
      harborExecutableHash: SPEC.harborExecutableHash,
    },
    budget: {
      currency: 'USD',
      trialCeilingMicrousd: SPEC.trialCeilingMicrousd,
      sessionCeilingMicrousd: 1_300_000,
      sessionCommittedMicrousd: 650_000,
    },
    ...overrides,
  };
  return signProtocolDocument(unsigned, HMAC_KEY, { keyId: 'controller-key-1' });
}

function readinessLease(signedRequest) {
  return {
    schema: 'engineer-runtime-readiness-lease.v1',
    protocolVersion: 1,
    sessionId: signedRequest.sessionId,
    trialId: signedRequest.trialId,
    sequence: 2,
    nonce: HASH('c'),
    issuedAt: NOW,
    expiresAt: '2026-08-04T20:05:00.000Z',
    requestHash: protocolDocumentHash(signedRequest),
    requestNonce: signedRequest.nonce,
    previousTrialChainHash: signedRequest.previousTrialChainHash,
    executionMode: signedRequest.executionMode,
    bindings: structuredClone(signedRequest.bindings),
    budget: structuredClone(signedRequest.budget),
    readiness: {
      noProviderProbeHash: HASH('a'),
      dockerProxyPolicyHash: HASH('b'),
      brokerPolicyHash: signedRequest.bindings.brokerPolicyHash,
      storageProbeHash: HASH('d'),
      privateDaemonBounded: true,
      realDaemonDenied: true,
      taskNetworkNone: true,
      brokerOnlyEgress: true,
      cgroupDelegated: true,
      evidenceHeadroomReserved: true,
    },
    authentication: {
      algorithm: 'HMAC-SHA256',
      keyId: 'supervisor-key-1',
      payloadSha256: HASH('e'),
      signature: HASH('f'),
    },
  };
}

function finalAttestation(signedRequest, lease) {
  return {
    schema: 'engineer-runtime-trial-final-attestation.v1',
    protocolVersion: 1,
    sessionId: signedRequest.sessionId,
    trialId: signedRequest.trialId,
    sequence: 3,
    nonce: HASH('d'),
    issuedAt: '2026-08-04T20:00:09.000Z',
    expiresAt: '2026-08-05T20:00:09.000Z',
    requestHash: protocolDocumentHash(signedRequest),
    readinessLeaseHash: protocolDocumentHash(lease),
    previousTrialChainHash: signedRequest.previousTrialChainHash,
    executionMode: signedRequest.executionMode,
    bindings: structuredClone(signedRequest.bindings),
    budget: structuredClone(signedRequest.budget),
    outcome: {
      status: 'succeeded',
      exitReason: 'verified',
      providerSpendMicrousd: 100_000,
      providerUsageHash: HASH('e'),
    },
    runtimeEvidence: {
      evidenceHash: HASH('f'),
      dockerEventsHash: HASH('1'),
      mountInventoryHash: HASH('2'),
      cgroupEvidenceHash: HASH('3'),
      networkEvidenceHash: HASH('4'),
      budgetEvidenceHash: HASH('5'),
      startedAt: NOW,
      endedAt: '2026-08-04T20:00:09.000Z',
    },
    cleanup: {
      completed: true,
      containersRemaining: 0,
      networksRemaining: 0,
      volumesRemaining: 0,
      processesRemaining: 0,
      cgroupPopulated: false,
    },
    authentication: {
      algorithm: 'HMAC-SHA256',
      keyId: 'supervisor-key-1',
      payloadSha256: HASH('6'),
      signature: HASH('7'),
    },
  };
}

function fakeSupervisorHarness(overrides = {}) {
  const calls = [];
  let signedRequest;
  let lease;
  let lost = 0;
  let stopped = 0;
  const supervisorFactory = (options) => {
    calls.push(['factory', {
      signingKey: Buffer.from(options.signingKey),
      controllerVerificationKey: Buffer.from(options.controllerVerificationKey),
      keyId: options.keyId,
      expectedControllerKeyId: options.expectedControllerKeyId,
    }]);
    return {
      async prepare(input) {
        calls.push(['prepare', structuredClone(input)]);
        signedRequest = input.request;
        lease = readinessLease(signedRequest);
        return lease;
      },
      async run() {
        calls.push(['run']);
        return {
          exitCode: 0,
          signal: 'none',
          startedAt: NOW,
          endedAt: '2026-08-04T20:00:08.000Z',
        };
      },
      async finalize(input) {
        calls.push(['finalize', structuredClone(input)]);
        return finalAttestation(signedRequest, lease);
      },
      async failStop(reason) {
        calls.push(['failStop', reason]);
        stopped += 1;
      },
      async controlChannelLost(reason) {
        calls.push(['controlChannelLost', reason]);
        lost += 1;
      },
    };
  };
  return {
    calls,
    get lost() { return lost; },
    get stopped() { return stopped; },
    supervisorFactory: overrides.supervisorFactory ?? supervisorFactory,
  };
}

function remoteHandler(overrides = {}) {
  const supervisor = overrides.supervisor ?? fakeSupervisorHarness();
  const openedProviderKeys = [];
  const closedFds = [];
  const handlerFactory = createSupervisorHandlerFactory({
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
    supervisorFactory: overrides.useRuntimeSupervisor ? undefined : supervisor.supervisorFactory,
    openProviderKeyFd: overrides.openProviderKeyFd ?? (async (bytes) => {
      openedProviderKeys.push(Buffer.from(bytes));
      return 7;
    }),
    closeProviderKeyFd: overrides.closeProviderKeyFd ?? (async (fd) => { closedFds.push(fd); }),
    inspectBinding: overrides.inspectBinding ?? (async (binding) => ({
      allocationId: binding.allocationId,
      taskArchive: structuredClone(binding.taskArchive),
      runtimeBindings: structuredClone(RUNTIME_BINDINGS),
    })),
    inspectTrialOutput: overrides.inspectTrialOutput ?? (async () => ({
      kind: 'trial-output',
      byteLength: OUTPUT_ARCHIVE.length,
      sha256: sha256(OUTPUT_ARCHIVE),
    })),
    clock: { now: () => new Date(NOW) },
  });
  return { handlerFactory, supervisor, openedProviderKeys, closedFds };
}

function phaseFailureRemote(remoteDetail = 'sk-or-v1-private-daemon-sensitive-detail') {
  const lifecycle = [];
  const remote = remoteHandler({
    effects: {
      async inspectPlatform() {
        lifecycle.push('inspectPlatform');
        return {
          platform: 'linux',
          effectiveUid: 0,
          sandboxId: ALLOCATION_ID,
          sandboxBootId: RUNTIME_BINDINGS.sandboxBootId,
          supervisorExecutableHash: SPEC.supervisorExecutableHash,
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
    },
    useRuntimeSupervisor: true,
  });
  return { remote, remoteDetail, lifecycle };
}

function fakeDaytonaTransport(remote, overrides = {}) {
  const calls = [];
  let handler;
  let pending;
  let closeCalls = 0;
  const control = {
    async sendFrame(bytes) {
      calls.push(['sendFrame', Buffer.from(bytes)]);
      pending = await handler.handleFrame(Buffer.from(bytes));
    },
    async receiveFrame() {
      const result = pending;
      pending = undefined;
      if (overrides.transformResponse) {
        return Buffer.from(canonicalJson(overrides.transformResponse(
          JSON.parse(result.response.toString()),
          calls.filter(([name]) => name === 'sendFrame').length
        )));
      }
      return Buffer.from(result.response);
    },
    async close() {
      closeCalls += 1;
      await handler?.close?.({ reason: 'complete' });
    },
  };
  return {
    calls,
    get closeCalls() { return closeCalls; },
    async uploadArchive(input) {
      calls.push(['uploadArchive', {
        ...input,
        bytes: Buffer.from(input.bytes),
      }]);
      if (overrides.uploadFailure) throw new Error(overrides.uploadFailure);
      return {
        schema: 'engineer-daytona-archive-result.v1',
        operation: 'upload',
        kind: 'task-input',
        path: '/engineer-bounded/transport/task-input.tar',
        byteLength: input.bytes.length,
        sha256: input.sha256,
        status: 'accepted',
      };
    },
    async openSupervisorControl(input) {
      calls.push(['openSupervisorControl', {
        sandboxId: input.sandboxId,
        executionMode: input.executionMode,
        hmacKey: Buffer.from(input.hmacKey),
        providerKey: Buffer.from(input.providerKey),
      }]);
      if (overrides.openFailure) throw new Error(overrides.openFailure);
      handler = await remote.handlerFactory({
        hmacKey: Buffer.from(input.hmacKey),
        executionMode: input.executionMode,
        providerKey: Buffer.from(input.providerKey),
      });
      return { receipt: { status: 'accepted' }, control };
    },
    async downloadArchive(input) {
      calls.push(['downloadArchive', structuredClone(input)]);
      if (overrides.downloadFailure) throw new Error(overrides.downloadFailure);
      const bytes = overrides.outputBytes ?? OUTPUT_ARCHIVE;
      return {
        bytes: Buffer.from(bytes),
        receipt: {
          schema: 'engineer-daytona-archive-result.v1',
          operation: 'download',
          kind: 'trial-output',
          path: '/engineer-bounded/transport/trial-output.tar',
          byteLength: input.expectedBytes,
          sha256: input.expectedSha256,
          status: 'accepted',
        },
      };
    },
  };
}

function externalHarness(overrides = {}) {
  const remote = overrides.remote ?? remoteHandler(overrides.remoteOptions);
  const daytona = overrides.daytona ?? fakeDaytonaTransport(remote, overrides.daytonaOptions);
  const secretBuffers = [];
  const archiveBuffers = [];
  const value = createRuntimeTrialTransport({
    daytonaTransport: daytona,
    sessionId: SESSION_ID,
    executionMode: CONTROLLED_PROVIDER,
    taskInputArchive: async () => {
      const bytes = Buffer.from(TASK_ARCHIVE);
      archiveBuffers.push(bytes);
      return bytes;
    },
    takeTrialSecrets: async () => {
      const hmacKey = Buffer.from(HMAC_KEY);
      const providerKey = Buffer.from(PROVIDER_KEY);
      secretBuffers.push(hmacKey, providerKey);
      return { hmacKey, providerKey };
    },
  });
  return { value, remote, daytona, secretBuffers, archiveBuffers };
}

async function preparedTrial(harness) {
  return harness.value.prepareTrial({
    allocation: structuredClone(ALLOCATION),
    provisioning: { schema: 'daytona-provisioning.v1' },
    spec: structuredClone(SPEC),
  });
}

test('one trial stages one input, hands off byte secrets once, runs once, and downloads one output', async () => {
  const harness = externalHarness();
  const prepared = await preparedTrial(harness);
  assert.deepEqual(prepared.runtimeBindings, RUNTIME_BINDINGS);
  assert.equal(harness.daytona.calls.filter(([name]) => name === 'uploadArchive').length, 1);
  assert.equal(harness.daytona.calls.filter(([name]) => name === 'openSupervisorControl').length, 1);
  assert.equal(
    harness.daytona.calls.find(([name]) => name === 'openSupervisorControl')[1].executionMode,
    CONTROLLED_PROVIDER
  );
  assert.deepEqual(harness.archiveBuffers[0], Buffer.alloc(TASK_ARCHIVE.length));
  for (const secret of harness.secretBuffers) assert.deepEqual(secret, Buffer.alloc(secret.length));
  assert.deepEqual(harness.remote.openedProviderKeys, [PROVIDER_KEY]);
  await assert.rejects(preparedTrial(harness), /already staged/i);
  assert.equal(
    harness.daytona.calls.filter(([name]) => name === 'uploadArchive').length,
    1,
    'a duplicate trial never uploads a second archive'
  );

  const signedRequest = request();
  const lease = await harness.value.requestReadiness({
    channel: prepared.channel,
    request: signedRequest,
  });
  assert.equal(lease.schema, 'engineer-runtime-readiness-lease.v1');

  const authorization = {
    schema: 'engineer-runtime-trial-authorization.v1',
    sessionId: SESSION_ID,
    trialId: TRIAL_ID,
    providerAuthorized: true,
    readinessLeaseHash: protocolDocumentHash(lease),
    readinessLease: lease,
  };
  const executed = await harness.value.executeTrial({
    handle: { sessionId: SESSION_ID, trialId: TRIAL_ID, request: signedRequest },
    authorization,
  });
  assert.deepEqual(executed.outputArchive.bytes, OUTPUT_ARCHIVE);
  assert.equal(executed.outputArchive.sha256, sha256(OUTPUT_ARCHIVE));
  assert.equal(harness.daytona.calls.filter(([name]) => name === 'downloadArchive').length, 1);
  assert.equal(JSON.stringify(executed).includes(PROVIDER_KEY.toString()), false);

  const final = await harness.value.requestFinal({
    channel: prepared.channel,
    request: signedRequest,
    readinessLease: lease,
  });
  assert.equal(final.schema, 'engineer-runtime-trial-final-attestation.v1');
  await harness.value.closeTrial({
    channel: prepared.channel,
    trialId: TRIAL_ID,
    reasonHash: protocolDocumentHash(final),
  });
  assert.equal(harness.daytona.closeCalls, 1);

  const remoteOperations = harness.daytona.calls
    .filter(([name]) => name === 'sendFrame')
    .map(([, bytes]) => JSON.parse(bytes.toString()).operation);
  assert.deepEqual(remoteOperations, ['bind', 'readiness', 'run', 'final']);
  const sequences = harness.daytona.calls
    .filter(([name]) => name === 'sendFrame')
    .map(([, bytes]) => JSON.parse(bytes.toString()).controlSequence);
  assert.deepEqual(sequences, [1, 2, 3, 4]);
});

test('the runtime transport rejects the exact one-shot credential bytes before archive upload', async () => {
  const remote = remoteHandler();
  const daytona = fakeDaytonaTransport(remote);
  const captured = Buffer.concat([
    Buffer.from('legitimate source plus an accidentally captured credential: '),
    PROVIDER_KEY,
  ]);
  const taskArchive = gzipTarEntry('work/captured-credential.txt', captured);
  captured.fill(0);
  const hmacKey = Buffer.from(HMAC_KEY);
  const providerKey = Buffer.from(PROVIDER_KEY);
  const value = createRuntimeTrialTransport({
    daytonaTransport: daytona,
    sessionId: SESSION_ID,
    executionMode: CONTROLLED_PROVIDER,
    taskInputArchive: async () => taskArchive,
    takeTrialSecrets: async () => ({ hmacKey, providerKey }),
  });

  await assert.rejects(preparedTrial({ value }), /archive.*credential|credential.*archive/i);
  assert.equal(daytona.calls.some(([name]) => name === 'uploadArchive'), false);
  assert.equal(daytona.calls.some(([name]) => name === 'openSupervisorControl'), false);
  assert.deepEqual(taskArchive, Buffer.alloc(taskArchive.length));
  assert.deepEqual(hmacKey, Buffer.alloc(hmacKey.length));
  assert.deepEqual(providerKey, Buffer.alloc(providerKey.length));
});

test('zero-provider transport takes only an HMAC key and rejects signed-request mode drift', async () => {
  const calls = [];
  let pending;
  const daytona = {
    async uploadArchive(input) {
      calls.push(['uploadArchive', { ...input, bytes: Buffer.from(input.bytes) }]);
      return {
        schema: 'engineer-daytona-archive-result.v1',
        operation: 'upload',
        kind: 'task-input',
        path: '/engineer-bounded/transport/task-input.tar',
        byteLength: input.bytes.length,
        sha256: input.sha256,
        status: 'accepted',
      };
    },
    async openSupervisorControl(input) {
      calls.push(['openSupervisorControl', {
        keys: Object.keys(input).sort(),
        sandboxId: input.sandboxId,
        executionMode: input.executionMode,
        hmacKey: Buffer.from(input.hmacKey),
      }]);
      return {
        receipt: { status: 'accepted' },
        control: {
          async sendFrame(bytes) {
            const outbound = JSON.parse(bytes.toString());
            pending = Buffer.from(canonicalJson({
              schema: 'engineer-runtime-control-response.v1',
              protocolVersion: 1,
              operation: outbound.operation,
              sessionId: outbound.sessionId,
              trialId: outbound.trialId,
              allocationId: outbound.allocationId,
              controlSequence: outbound.controlSequence,
              requestHash: crypto.createHash('sha256')
                .update(canonicalJson(outbound)).digest('hex'),
              body: {
                status: 'bound',
                taskArchive: structuredClone(outbound.body.taskArchive),
                runtimeBindings: structuredClone(RUNTIME_BINDINGS),
              },
            }));
          },
          async receiveFrame() { return pending; },
          async close() {},
        },
      };
    },
    async downloadArchive() { assert.fail('zero-provider trial was not authorized to run'); },
  };
  const retainedHmac = Buffer.from(HMAC_KEY);
  const value = createRuntimeTrialTransport({
    daytonaTransport: daytona,
    sessionId: SESSION_ID,
    executionMode: ZERO_PROVIDER_CANARY,
    taskInputArchive: async () => Buffer.from(TASK_ARCHIVE),
    takeTrialSecrets: async () => ({ hmacKey: retainedHmac }),
  });
  const prepared = await value.prepareTrial({
    allocation: structuredClone(ALLOCATION),
    provisioning: { schema: 'daytona-provisioning.v1' },
    spec: { ...structuredClone(SPEC), trialCeilingMicrousd: 0 },
  });
  assert.equal(prepared.channel.executionMode, ZERO_PROVIDER_CANARY);
  const opened = calls.find(([name]) => name === 'openSupervisorControl')[1];
  assert.deepEqual(opened.keys, ['executionMode', 'hmacKey', 'sandboxId']);
  assert.equal(opened.executionMode, ZERO_PROVIDER_CANARY);
  assert.equal(Object.prototype.hasOwnProperty.call(opened, 'providerKey'), false);
  assert.deepEqual(retainedHmac, Buffer.alloc(32));

  await assert.rejects(
    value.requestReadiness({ channel: prepared.channel, request: request() }),
    /execution mode|identity.*drift/i
  );

  const withProvider = createRuntimeTrialTransport({
    daytonaTransport: daytona,
    sessionId: 'release-session-zero-provider-extra',
    executionMode: ZERO_PROVIDER_CANARY,
    taskInputArchive: async () => Buffer.from(TASK_ARCHIVE),
    takeTrialSecrets: async () => ({
      hmacKey: Buffer.from(HMAC_KEY),
      providerKey: Buffer.from(PROVIDER_KEY),
    }),
  });
  await assert.rejects(withProvider.prepareTrial({
    allocation: { id: 'sandbox-zero-provider-extra', labels: { 'trial-id': 'trial-zero-provider-extra' } },
    provisioning: { schema: 'daytona-provisioning.v1' },
    spec: {
      ...structuredClone(SPEC),
      trialId: 'trial-zero-provider-extra',
      trialCeilingMicrousd: 0,
    },
  }), /secret|provider|unexpected field/i);
});

test('remote handler rejects replay, out-of-order operations, extra fields, and secret-bearing payloads', async () => {
  const remote = remoteHandler();
  const handler = await remote.handlerFactory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: CONTROLLED_PROVIDER,
    providerKey: Buffer.from(PROVIDER_KEY),
  });
  const bind = {
    schema: 'engineer-runtime-control-request.v1',
    protocolVersion: 1,
    operation: 'bind',
    sessionId: SESSION_ID,
    trialId: TRIAL_ID,
    allocationId: ALLOCATION_ID,
    controlSequence: 1,
    previousControlHash: CONTROL_GENESIS_HASH,
    body: {
      trial: structuredClone(SPEC),
      taskArchive: {
        kind: 'task-input',
        byteLength: TASK_ARCHIVE.length,
        sha256: sha256(TASK_ARCHIVE),
      },
    },
  };
  const bindBytes = Buffer.from(canonicalJson(bind));
  await handler.handleFrame(bindBytes);
  await assert.rejects(handler.handleFrame(bindBytes), /lifecycle|sequence|replay|order/i);

  for (const bad of [
    { ...bind, extra: true },
    { ...bind, body: { ...bind.body, providerKey: PROVIDER_KEY.toString() } },
    { ...bind, controlSequence: 3 },
  ]) {
    const fresh = await remote.handlerFactory({
      hmacKey: Buffer.from(HMAC_KEY),
      executionMode: CONTROLLED_PROVIDER,
      providerKey: Buffer.from(PROVIDER_KEY),
    });
    await assert.rejects(
      fresh.handleFrame(Buffer.from(canonicalJson(bad))),
      /field|secret|credential|sequence|order/i
    );
    await fresh.close({ reason: 'failure' });
  }
});

test('remote handler rejects identity drift, signed-request binding drift, and task digest drift', async () => {
  const digestDrift = remoteHandler({
    inspectBinding: async (binding) => ({
      allocationId: binding.allocationId,
      taskArchive: { ...binding.taskArchive, sha256: HASH('f') },
      runtimeBindings: structuredClone(RUNTIME_BINDINGS),
    }),
  });
  const harness = externalHarness({ remote: digestDrift });
  await assert.rejects(preparedTrial(harness), /failed/i);

  for (const transform of [
    (value) => ({ ...value, trialId: 'other-trial' }),
    (value) => ({
      ...value,
      bindings: { ...value.bindings, sandboxId: 'other-allocation' },
    }),
  ]) {
    const next = externalHarness();
    const prepared = await preparedTrial(next);
    await assert.rejects(next.value.requestReadiness({
      channel: prepared.channel,
      request: transform(request()),
    }), /drift|failed/i);
  }
});

test('response operation and identity tampering fail closed without returning remote diagnostics', async () => {
  for (const transformResponse of [
    (response) => ({ ...response, operation: 'run' }),
    (response) => ({ ...response, trialId: 'other-trial' }),
    (response) => ({ ...response, requestHash: HASH('f') }),
  ]) {
    const remote = remoteHandler();
    const daytona = fakeDaytonaTransport(remote, { transformResponse });
    const harness = externalHarness({ remote, daytona });
    await assert.rejects(preparedTrial(harness), /drift|failed/i);
    assert.equal(daytona.closeCalls, 1);
  }

  const remote = remoteHandler();
  const daytona = fakeDaytonaTransport(remote, {
    openFailure: `raw remote ${PROVIDER_KEY.toString()} diagnostic`,
  });
  const harness = externalHarness({ remote, daytona });
  let failure;
  try {
    await preparedTrial(harness);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.message.includes(PROVIDER_KEY.toString()), false);
  assert.match(failure.message, /detail sha256/i);
});

test('authenticated remote failure exposes only its bounded phase, code, and detail hash', async () => {
  const failureRemote = phaseFailureRemote();
  const harness = externalHarness({ remote: failureRemote.remote });
  const prepared = await preparedTrial(harness);
  let failure;

  try {
    await harness.value.requestReadiness({ channel: prepared.channel, request: request() });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.equal(failure.code, 'ERR_RUNTIME_TRIAL_TRANSPORT_REMOTE_FAILURE');
  assert.match(
    failure.message,
    new RegExp(`remote phase:${RuntimeControlFailurePhases.START_PRIVATE_DAEMON} code:${RuntimeControlFailureCodes.START_PRIVATE_DAEMON} detail sha256:[a-f0-9]{64}`),
  );
  assert.equal(failure.message.includes(failureRemote.remoteDetail), false);
  assert.deepEqual(failureRemote.lifecycle, [
    'inspectPlatform',
    'reserveEvidenceHeadroom',
    'startPrivateDaemon',
    'killTrialCgroup',
    'closeInheritedFd',
    'shutdown',
  ]);
  assert.equal(harness.daytona.closeCalls, 1);
});

test('tampered or non-exact remote failure frames retain the generic transport error', async () => {
  const mutations = [
    (value) => resignControlFailure(value, { operation: 'run' }),
    (value) => resignControlFailure(value, { sessionId: 'other-session' }),
    (value) => resignControlFailure(value, { trialId: 'other-trial' }),
    (value) => resignControlFailure(value, { allocationId: 'other-allocation' }),
    (value) => resignControlFailure(value, { requestHash: HASH('f') }),
    (value) => resignControlFailure(value, { controlSequence: 3 }),
    (value) => ({ ...value, phase: 'arbitrary-remote-phase' }),
    (value) => ({ ...value, code: RuntimeControlFailureCodes.INSPECT_PLATFORM }),
    (value) => ({ ...value, unexpected: true }),
    (value) => ({
      ...value,
      authentication: { ...value.authentication, signature: HASH('f') },
    }),
  ];

  for (const mutation of mutations) {
    const failureRemote = phaseFailureRemote();
    const daytona = fakeDaytonaTransport(failureRemote.remote, {
      transformResponse(response, exchangeCount) {
        return exchangeCount === 2 ? mutation(response) : response;
      },
    });
    const harness = externalHarness({ remote: failureRemote.remote, daytona });
    const prepared = await preparedTrial(harness);
    let failure;
    try {
      await harness.value.requestReadiness({ channel: prepared.channel, request: request() });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.code, 'ERR_RUNTIME_TRIAL_TRANSPORT_REMOTE');
    assert.match(failure.message, /^runtime trial transport readiness failed \(detail sha256:[a-f0-9]{16}\)$/);
    assert.equal(failure.message.includes('remote phase:'), false);
    assert.equal(daytona.closeCalls, 1);
  }
});

test('channel loss invokes supervisor fail-stop and closes an unclaimed provider descriptor', async () => {
  const remote = remoteHandler();
  const handler = await remote.handlerFactory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: CONTROLLED_PROVIDER,
    providerKey: Buffer.from(PROVIDER_KEY),
  });
  await handler.channelLost();
  assert.equal(remote.supervisor.lost, 1);
  assert.deepEqual(remote.closedFds, [7]);
  await handler.close({ reason: 'channel-loss' });
  assert.equal(remote.supervisor.stopped, 1);
  assert.deepEqual(remote.closedFds, [7], 'unclaimed descriptor is closed exactly once');
});

test('an invalid provider descriptor is closed before handler construction fails', async () => {
  const closedFds = [];
  const remote = remoteHandler({
    openProviderKeyFd: async () => 2,
    closeProviderKeyFd: async (fd) => { closedFds.push(fd); },
  });
  await assert.rejects(remote.handlerFactory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: CONTROLLED_PROVIDER,
    providerKey: Buffer.from(PROVIDER_KEY),
  }), /descriptor|handoff/i);
  assert.deepEqual(closedFds, [2]);
});

test('oversized, noncanonical, duplicate, and output-digest-invalid exchanges are rejected', async () => {
  const remote = remoteHandler();
  const handler = await remote.handlerFactory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: CONTROLLED_PROVIDER,
    providerKey: Buffer.from(PROVIDER_KEY),
  });
  await assert.rejects(handler.handleFrame(Buffer.alloc(65_537, 0x20)), /bound|size|frame/i);
  await handler.close({ reason: 'failure' });

  const noncanonical = await remote.handlerFactory({
    hmacKey: Buffer.from(HMAC_KEY),
    executionMode: CONTROLLED_PROVIDER,
    providerKey: Buffer.from(PROVIDER_KEY),
  });
  await assert.rejects(
    noncanonical.handleFrame(Buffer.from('{ "schema": "drift" }')),
    /canonical|field|schema/i
  );
  await noncanonical.close({ reason: 'failure' });

  const harness = externalHarness({
    daytonaOptions: { outputBytes: Buffer.from('wrong output') },
  });
  const prepared = await preparedTrial(harness);
  const signedRequest = request();
  const lease = await harness.value.requestReadiness({ channel: prepared.channel, request: signedRequest });
  const authorization = {
    schema: 'engineer-runtime-trial-authorization.v1',
    sessionId: SESSION_ID,
    trialId: TRIAL_ID,
    providerAuthorized: true,
    readinessLeaseHash: protocolDocumentHash(lease),
    readinessLease: lease,
  };
  await assert.rejects(harness.value.executeTrial({
    handle: { sessionId: SESSION_ID, trialId: TRIAL_ID, request: signedRequest },
    authorization,
  }), /digest|failed/i);
  assert.equal(harness.daytona.calls.filter(([name]) => name === 'downloadArchive').length, 1);
  await assert.rejects(harness.value.executeTrial({
    handle: { sessionId: SESSION_ID, trialId: TRIAL_ID, request: signedRequest },
    authorization,
  }), /lifecycle|failed|not ready/i);
});
