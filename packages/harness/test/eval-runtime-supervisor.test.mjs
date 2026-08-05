import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalSha256,
  protocolDocumentHash,
  signProtocolDocument,
  verifyProtocolDocument,
  verifyReadinessLeaseForRequest,
  verifyTrialAttestationForLease,
} from '../../../evals/runtime/protocol.mjs';
import {
  RuntimeSupervisorError,
  createRuntimeSupervisor,
} from '../../../evals/runtime/supervisor.mjs';
import { providerBrokerStaticPolicyHash } from '../../../evals/runtime/provider-broker.mjs';

const HASH = (character) => character.repeat(64);
const KEY = Buffer.alloc(32, 0x5a);
const NOW = Date.parse('2026-08-04T16:00:00.000Z');
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const RESERVE_BYTES = 256 * 1024 * 1024;
const CONTROLLED_PROVIDER = 'controlled-provider';
const ZERO_PROVIDER_CANARY = 'zero-provider-canary';

function providerPolicy(overrides = {}) {
  return {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'moonshotai/kimi-k2.7-code-20260612',
    provider: {
      order: ['moonshotai/int4'],
      expectedResolvedNames: ['Moonshot AI'],
      allowFallbacks: false,
    },
    settings: { temperature: null, reasoning: null, toolChoice: 'auto' },
    maxTokens: 100,
    pricing: { inputPerM: 0.95, cachedInputPerM: 0.19, outputPerM: 4 },
    sessionCeilingUsd: 1.3,
    trials: [{
      leaseId: 'lease-trial-1',
      leaseDigest: HASH('0'),
      trialId: 'trial-1',
      leaseSequence: 2,
      ceilingUsd: 0.65,
    }],
    ...overrides,
  };
}

function bindings(overrides = {}) {
  return {
    releaseSha: HASH('a'),
    profileId: 'openrouter-controlled',
    taskId: 'cobol-modernization',
    taskLockHash: HASH('b'),
    bundleHash: HASH('c'),
    condition: 'generic',
    imageDigest: `sha256:${HASH('d')}`,
    sandboxId: 'sandbox-1',
    sandboxBootId: 'boot-1',
    daemonId: 'private-daemon-1',
    daemonRootHash: HASH('e'),
    cgroupId: 'trial-cgroup-1',
    cgroupPathHash: HASH('f'),
    budgetId: 'release-budget-1',
    budgetPolicyHash: HASH('1'),
    brokerPolicyHash: providerBrokerStaticPolicyHash(providerPolicy()),
    supervisorExecutableHash: HASH('2'),
    runnerExecutableHash: HASH('3'),
    harborExecutableHash: HASH('4'),
    ...overrides,
  };
}

function signedRequest(overrides = {}) {
  const request = {
    schema: 'engineer-runtime-trial-request.v1',
    protocolVersion: 1,
    sessionId: 'session-1',
    trialId: 'trial-1',
    sequence: 1,
    nonce: HASH('5'),
    issuedAt: '2026-08-04T15:59:00.000Z',
    expiresAt: '2026-08-04T16:30:00.000Z',
    previousTrialChainHash: HASH('0'),
    executionMode: CONTROLLED_PROVIDER,
    bindings: bindings(),
    budget: {
      currency: 'USD',
      trialCeilingMicrousd: 650_000,
      sessionCeilingMicrousd: 1_300_000,
      sessionCommittedMicrousd: 1_300_000,
    },
    ...overrides,
  };
  return signProtocolDocument(request, KEY, { keyId: 'controller-1' });
}

function zeroProviderRequest(overrides = {}) {
  return signedRequest({
    executionMode: ZERO_PROVIDER_CANARY,
    bindings: bindings({ brokerPolicyHash: HASH('0') }),
    budget: {
      currency: 'USD',
      trialCeilingMicrousd: 0,
      sessionCeilingMicrousd: 0,
      sessionCommittedMicrousd: 0,
    },
    ...overrides,
  });
}

function platformObservation(overrides = {}) {
  return {
    platform: 'linux',
    effectiveUid: 0,
    sandboxId: 'sandbox-1',
    sandboxBootId: 'boot-1',
    supervisorExecutableHash: HASH('2'),
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
    controlChannel: {
      kind: 'inherited-pipe',
      authenticated: true,
      open: true,
    },
    providerCredentialsAbsent: true,
    daytonaCredentialsAbsent: true,
    custody: {
      coreDumpsDisabled: true,
      evidenceStoreOwnerUid: 0,
      evidenceStoreMode: 0o700,
      evidenceRetentionDays: 30,
      snapshotCredentialExclusion: true,
    },
    ...overrides,
  };
}

function readinessObservation() {
  return {
    cgroup: {
      id: 'trial-cgroup-1',
      pathHash: HASH('f'),
      populated: true,
      controllersEnforced: true,
      runnerUid: 2001,
    },
    noProviderProbe: {
      completed: true,
      imageDigest: `sha256:${HASH('d')}`,
      genericMountPassed: true,
      harnessMountPassed: true,
      providerCalls: 0,
      providerCredentialAbsent: true,
    },
    storageProbe: {
      filesystemId: 'bounded-fs',
      totalBytes: TEN_GIB,
      enospcObserved: true,
      evidenceHeadroomRecovered: true,
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
    },
    task: {
      networkNone: true,
      readOnlyRoot: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      brokerReachable: false,
      brokerSocketMounted: false,
      brokerClientGidPresent: false,
    },
    broker: {
      uid: 2002,
      onlyProviderEgress: true,
    },
    executables: {
      runnerExecutableHash: HASH('3'),
      harborExecutableHash: HASH('4'),
    },
  };
}

function daemonObservation(overrides = {}) {
  return {
    daemonId: 'private-daemon-1',
    dataRootHash: HASH('e'),
    filesystemId: 'bounded-fs',
    socketPath: '/run/engineer/private-docker.sock',
    socketOwnerUid: 0,
    socketGroupGid: 0,
    socketMode: 0o600,
    exclusive: true,
    ...overrides,
  };
}

function proxyObservation(overrides = {}) {
  return {
    socketPath: '/run/engineer/harbor-docker.sock',
    socketOwnerUid: 0,
    socketGroupGid: 2001,
    socketMode: 0o660,
    policyHash: HASH('e'),
    nonBypassable: true,
    realDaemonDenied: true,
    ...overrides,
  };
}

function brokerObservation(overrides = {}) {
  return {
    socketPath: '/run/engineer/provider.sock',
    socketOwnerUid: 2002,
    socketGroupGid: 2003,
    socketMode: 0o660,
    socketParentOwnerUid: 2002,
    socketParentGroupGid: 2003,
    socketParentMode: 0o2710,
    policyHash: providerBrokerStaticPolicyHash(providerPolicy()),
    bindingPolicyHash: HASH('f'),
    leaseId: 'lease-trial-1',
    leaseDigest: HASH('0'),
    leaseSequence: 2,
    trialId: 'trial-1',
    keyFdConsumed: true,
    credentialInEnvironment: false,
    credentialPersisted: false,
    egressRestricted: true,
    taskReachable: false,
    ...overrides,
  };
}

function finalEvidence(overrides = {}) {
  return {
    startedAt: '2026-08-04T16:00:02.000Z',
    endedAt: '2026-08-04T16:00:08.000Z',
    harbor: {
      completed: true,
      exitCode: 0,
      executableHash: HASH('4'),
    },
    docker: {
      eventsHash: HASH('6'),
      eventsComplete: true,
      containerIdHash: HASH('7'),
      imageDigest: `sha256:${HASH('d')}`,
      policyCompliant: true,
      containersRemaining: 0,
      networksRemaining: 0,
      volumesRemaining: 0,
    },
    mounts: {
      inventoryHash: HASH('8'),
      policyCompliant: true,
      outsideAllowedWrites: false,
      daemonRootFilesystemId: 'bounded-fs',
      workspaceFilesystemId: 'bounded-fs',
    },
    cgroup: {
      evidenceHash: HASH('9'),
      id: 'trial-cgroup-1',
      pathHash: HASH('f'),
      populated: false,
      processesRemaining: 0,
      limitsEnforced: true,
    },
    resources: {
      evidenceHash: HASH('a'),
      cpuWithinLimit: true,
      memoryWithinLimit: true,
      pidsWithinLimit: true,
      oomKilled: false,
    },
    network: {
      evidenceHash: HASH('b'),
      taskNetworkNone: true,
      runnerEgressDenied: true,
      brokerOnlyEgress: true,
      metadataDenied: true,
      rawSocketDenied: true,
    },
    provider: {
      usageHash: HASH('c'),
      identityHash: HASH('d'),
      spendMicrousd: 100,
      billingCertain: true,
      budgetComplete: true,
      withinTrialCeiling: true,
      attempts: 1,
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

function zeroProviderFinalEvidence({ leaseHash = HASH('8'), ...overrides } = {}) {
  const requestHash = protocolDocumentHash(zeroProviderRequest());
  return finalEvidence({
    network: {
      ...finalEvidence().network,
      brokerOnlyEgress: true,
    },
    provider: {
      mode: 'not-exercised',
      requestHash,
      leaseHash,
      usageHash: canonicalSha256({
        schema: 'engineer-runtime-zero-provider-usage.v1',
        executionMode: ZERO_PROVIDER_CANARY,
        attempts: 0,
        calls: 0,
        spendMicrousd: 0,
      }),
      identityHash: canonicalSha256({
        schema: 'engineer-runtime-zero-provider-identity.v1',
        executionMode: ZERO_PROVIDER_CANARY,
        requestHash,
        leaseHash,
        brokerAbsent: true,
      }),
      spendMicrousd: 0,
      billingCertain: true,
      budgetComplete: true,
      withinTrialCeiling: true,
      attempts: 0,
      calls: 0,
      brokerAbsent: true,
    },
    ...overrides,
  });
}

function createEffects(overrides = {}) {
  const calls = [];
  let lossHandler = null;
  const effects = {
    calls,
    async inspectPlatform() {
      calls.push(['inspectPlatform']);
      return platformObservation();
    },
    async inspectProviderKeyFd(fd) {
      calls.push(['inspectProviderKeyFd', fd]);
      return { kind: 'pipe', open: true };
    },
    async reserveEvidenceHeadroom({ bytes }) {
      calls.push(['reserveEvidenceHeadroom', bytes]);
      return {
        bytes,
        filesystemId: 'bounded-fs',
        protectedFromRunner: true,
      };
    },
    async startPrivateDaemon(options) {
      calls.push(['startPrivateDaemon', options]);
      return daemonObservation();
    },
    async startDockerProxy(options) {
      calls.push(['startDockerProxy', options]);
      return proxyObservation();
    },
    async startProviderBroker(options) {
      calls.push(['startProviderBroker', options]);
      return brokerObservation({
        leaseId: options.leaseId,
        leaseDigest: options.leaseHash,
        leaseSequence: options.leaseSequence,
        trialId: options.trialId,
      });
    },
    async closeInheritedFd(fd) {
      calls.push(['closeInheritedFd', fd]);
      return { closed: true };
    },
    async inspectReadiness() {
      calls.push(['inspectReadiness']);
      return readinessObservation();
    },
    installControlChannelLossHandler(handler) {
      calls.push(['installControlChannelLossHandler']);
      lossHandler = handler;
      return () => { lossHandler = null; };
    },
    async launchRunner(options) {
      calls.push(['launchRunner', options]);
      return {
        exitCode: 0,
        signal: 'none',
        startedAt: '2026-08-04T16:00:02.000Z',
        endedAt: '2026-08-04T16:00:07.000Z',
      };
    },
    async collectFinalEvidence() {
      calls.push(['collectFinalEvidence']);
      return finalEvidence();
    },
    async killTrialCgroup(options) {
      calls.push(['killTrialCgroup', options]);
      return { killed: true, populated: false };
    },
    async shutdown(options) {
      calls.push(['shutdown', options]);
      return {
        completed: true,
        processesRemaining: 0,
        socketsRemaining: 0,
        evidenceHeadroomReleased: true,
        endedAt: '2026-08-04T16:00:09.000Z',
      };
    },
    emitChannelLoss(reason = 'controller-channel-closed') {
      return lossHandler?.(reason);
    },
    ...overrides,
  };
  return effects;
}

function supervisor(effects, overrides = {}) {
  let nonce = 8;
  return createRuntimeSupervisor({
    signingKey: KEY,
    keyId: 'supervisor-1',
    expectedControllerKeyId: 'controller-1',
    effects,
    clock: { now: () => NOW + (nonce - 8) * 1_000 },
    nonceFactory: () => HASH(String(nonce++)),
    ...overrides,
  });
}

const prepareInput = (request = signedRequest()) => ({
  executionMode: CONTROLLED_PROVIDER,
  request,
  providerKeyFd: 7,
  dockerPolicy: { policyId: 'harbor-offline-v1' },
  brokerPolicy: providerPolicy(),
  runner: {
    argv: ['/usr/local/bin/engineer-eval-runner', '--mode', 'controlled'],
    cwd: '/workspace/eval',
    env: { LANG: 'C.UTF-8' },
    timeoutMs: 30 * 60 * 1_000,
  },
});

const zeroProviderPrepareInput = (request = zeroProviderRequest()) => ({
  executionMode: ZERO_PROVIDER_CANARY,
  request,
  dockerPolicy: { policyId: 'harbor-offline-v1' },
  runner: {
    argv: ['/usr/local/bin/engineer-eval-runner', '--mode', 'canary'],
    cwd: '/workspace/eval',
    env: { LANG: 'C.UTF-8' },
    timeoutMs: 30 * 60 * 1_000,
  },
});

test('zero-provider canary issues a bound lease and runs Harbor without credential, broker, or broker group capability', async () => {
  let leaseHash;
  const request = zeroProviderRequest();
  const requestHash = protocolDocumentHash(request);
  const effects = createEffects({
    async inspectReadiness(options) {
      effects.calls.push(['inspectReadiness', options]);
      return {
        ...readinessObservation(),
        broker: { installed: false, socketAbsent: true, policyAbsent: true },
      };
    },
    async collectFinalEvidence(options) {
      effects.calls.push(['collectFinalEvidence', options]);
      return zeroProviderFinalEvidence({ leaseHash });
    },
  });
  const runtime = supervisor(effects);

  const lease = await runtime.prepare(zeroProviderPrepareInput(request));
  leaseHash = protocolDocumentHash(lease);
  assert.equal(lease.executionMode, ZERO_PROVIDER_CANARY);
  assert.equal(lease.readiness.brokerPolicyHash, HASH('0'));
  assert.equal(verifyReadinessLeaseForRequest(lease, request), true);
  assert.equal(effects.calls.some(([name]) => name === 'inspectProviderKeyFd'), false);
  assert.equal(effects.calls.some(([name]) => name === 'startProviderBroker'), false);
  assert.equal(effects.calls.some(([name]) => name === 'closeInheritedFd'), false);
  const proxyCall = effects.calls.find(([name]) => name === 'startDockerProxy')[1];
  assert.equal(proxyCall.executionMode, ZERO_PROVIDER_CANARY);
  assert.equal(proxyCall.releaseSha, request.bindings.releaseSha);
  assert.equal(proxyCall.taskLockHash, request.bindings.taskLockHash);
  assert.equal(proxyCall.bundleHash, request.bindings.bundleHash);

  await runtime.run();
  const runnerCall = effects.calls.find(([name]) => name === 'launchRunner')[1];
  assert.equal(runnerCall.executionMode, ZERO_PROVIDER_CANARY);
  assert.deepEqual(runnerCall.supplementaryGids, []);
  assert.equal(runnerCall.env.DOCKER_HOST, 'unix:///run/engineer/harbor-docker.sock');
  assert.equal(runnerCall.env.ENGINEER_RUNTIME_LEASE_HASH, leaseHash);
  assert.equal(runnerCall.env.ENGINEER_RUNTIME_EXECUTION_MODE, ZERO_PROVIDER_CANARY);
  assert.equal(Object.keys(runnerCall.env).some((name) => name.includes('PROVIDER') || name.includes('BROKER')), false);

  const attestation = await runtime.finalize({ outcome: { status: 'succeeded', exitReason: 'completed' } });
  assert.equal(attestation.executionMode, ZERO_PROVIDER_CANARY);
  assert.equal(attestation.outcome.providerSpendMicrousd, 0);
  assert.equal(attestation.outcome.providerUsageHash, zeroProviderFinalEvidence({ leaseHash }).provider.usageHash);
  assert.equal(verifyTrialAttestationForLease(attestation, lease, request), true);
  const finalCall = effects.calls.find(([name]) => name === 'collectFinalEvidence')[1];
  assert.equal(finalCall.executionMode, ZERO_PROVIDER_CANARY);
  assert.equal(finalCall.broker, null);
  assert.equal(finalCall.requestHash, requestHash);
});

test('zero-provider canary rejects a provider descriptor, broker policy, mode mismatch, and nonzero provider evidence', async (t) => {
  for (const [name, mutate] of [
    ['provider descriptor', (input) => { input.providerKeyFd = 7; }],
    ['broker policy', (input) => { input.brokerPolicy = providerPolicy(); }],
    ['authenticated mode mismatch', (input) => { input.executionMode = CONTROLLED_PROVIDER; }],
  ]) {
    await t.test(name, async () => {
      const input = zeroProviderPrepareInput();
      mutate(input);
      const effects = createEffects();
      await assert.rejects(supervisor(effects).prepare(input), /failed closed/i);
      assert.equal(effects.calls.some(([method]) => method === 'startProviderBroker'), false);
    });
  }

  for (const [name, providerDrift] of [
    ['provider attempt', { attempts: 1 }],
    ['provider call', { calls: 1 }],
    ['provider spend', { spendMicrousd: 1 }],
    ['broker present', { brokerAbsent: false }],
  ]) {
    await t.test(name, async () => {
      let leaseHash;
      const effects = createEffects({
        async inspectReadiness(options) {
          effects.calls.push(['inspectReadiness', options]);
          return { ...readinessObservation(), broker: { installed: false, socketAbsent: true, policyAbsent: true } };
        },
        async collectFinalEvidence(options) {
          effects.calls.push(['collectFinalEvidence', options]);
          return zeroProviderFinalEvidence({
            leaseHash,
            provider: { ...zeroProviderFinalEvidence({ leaseHash }).provider, ...providerDrift },
          });
        },
      });
      const runtime = supervisor(effects);
      const lease = await runtime.prepare(zeroProviderPrepareInput());
      leaseHash = protocolDocumentHash(lease);
      await runtime.run();
      await assert.rejects(runtime.finalize({ outcome: { status: 'succeeded', exitReason: 'completed' } }), /failed closed/i);
    });
  }
});

test('issues readiness only after observed controls, launches an unprivileged secret-free runner, and signs final evidence', async () => {
  const effects = createEffects();
  const runtime = supervisor(effects);
  const request = signedRequest();

  const lease = await runtime.prepare(prepareInput(request));
  assert.equal(verifyProtocolDocument(lease, KEY, { expectedKeyId: 'supervisor-1', now: new Date(NOW) }).trialId, 'trial-1');
  assert.equal(verifyReadinessLeaseForRequest(lease, request), true);
  assert.deepEqual(lease.readiness, {
    noProviderProbeHash: canonicalSha256(readinessObservation().noProviderProbe),
    dockerProxyPolicyHash: HASH('e'),
    brokerPolicyHash: providerBrokerStaticPolicyHash(providerPolicy()),
    storageProbeHash: canonicalSha256(readinessObservation().storageProbe),
    privateDaemonBounded: true,
    realDaemonDenied: true,
    taskNetworkNone: true,
    brokerOnlyEgress: true,
    cgroupDelegated: true,
    evidenceHeadroomReserved: true,
  });

  await runtime.run();
  const runnerCall = effects.calls.find(([name]) => name === 'launchRunner')[1];
  assert.equal(runnerCall.uid, 2001);
  assert.equal(runnerCall.gid, 2001);
  assert.deepEqual(runnerCall.supplementaryGids, [2003]);
  assert.deepEqual(runnerCall.inheritedFds, []);
  assert.equal(runnerCall.env.DOCKER_HOST, 'unix:///run/engineer/harbor-docker.sock');
  assert.equal(runnerCall.env.ENGINEER_PROVIDER_BROKER_SOCKET, '/run/engineer/provider.sock');
  assert.equal(runnerCall.env.ENGINEER_PROVIDER_LEASE_ID, 'lease-trial-1');
  assert.equal(runnerCall.env.ENGINEER_PROVIDER_TRIAL_ID, 'trial-1');
  assert.equal(runnerCall.env.ENGINEER_RUNTIME_LEASE_HASH, protocolDocumentHash(lease));
  assert.equal(JSON.stringify(runnerCall).includes('providerKeyFd'), false);
  assert.equal(JSON.stringify(runnerCall).includes('OPENROUTER_API_KEY'), false);

  const attestation = await runtime.finalize({ outcome: { status: 'succeeded', exitReason: 'completed' } });
  assert.equal(verifyProtocolDocument(attestation, KEY, { expectedKeyId: 'supervisor-1', now: new Date(NOW + 3_000) }).trialId, 'trial-1');
  assert.equal(verifyTrialAttestationForLease(attestation, lease, request), true);
  assert.equal(attestation.outcome.providerSpendMicrousd, 100);
  assert.equal(attestation.outcome.providerUsageHash, HASH('c'));
  assert.equal(attestation.runtimeEvidence.dockerEventsHash, HASH('6'));
  assert.equal(attestation.runtimeEvidence.mountInventoryHash, HASH('8'));
  assert.equal(attestation.runtimeEvidence.evidenceHash, canonicalSha256({
    evidence: finalEvidence(),
    shutdown: {
      completed: true,
      processesRemaining: 0,
      socketsRemaining: 0,
      evidenceHeadroomReleased: true,
      endedAt: '2026-08-04T16:00:09.000Z',
    },
  }));
  assert.equal(attestation.runtimeEvidence.endedAt, '2026-08-04T16:00:09.000Z');
  assert.equal(attestation.runtimeEvidence.cgroupEvidenceHash, canonicalSha256({
    cgroup: finalEvidence().cgroup,
    resources: finalEvidence().resources,
  }));
  assert.deepEqual(attestation.cleanup, finalEvidence().cleanup);
  assert.deepEqual(runtime.snapshot(), {
    state: 'finalized',
    sessionId: 'session-1',
    trialId: 'trial-1',
    readinessLeaseHash: protocolDocumentHash(lease),
    finalAttestationHash: protocolDocumentHash(attestation),
    providerKeyFdRetained: false,
    controlChannelOpen: false,
  });

  assert.deepEqual(effects.calls.map(([name]) => name), [
    'installControlChannelLossHandler',
    'inspectPlatform',
    'inspectProviderKeyFd',
    'reserveEvidenceHeadroom',
    'startPrivateDaemon',
    'startDockerProxy',
    'inspectReadiness',
    'startProviderBroker',
    'closeInheritedFd',
    'inspectReadiness',
    'launchRunner',
    'collectFinalEvidence',
    'shutdown',
  ]);
  const brokerCall = effects.calls.find(([name]) => name === 'startProviderBroker')[1];
  assert.equal(brokerCall.leaseHash, protocolDocumentHash(lease));
  assert.equal(brokerCall.policy.trials[0].leaseDigest, protocolDocumentHash(lease));
  assert.equal(brokerCall.policy.trials[0].trialId, 'trial-1');
});

test('fails closed before a lease for every privileged readiness drift', async (t) => {
  const drifts = [
    ['non-Linux host', { platform: 'darwin' }],
    ['non-root supervisor', { effectiveUid: 501 }],
    ['cgroup v1', { cgroupVersion: 1 }],
    ['undelegated cgroup', { cgroupDelegated: false }],
    ['wrong sandbox', { sandboxId: 'sandbox-other' }],
    ['wrong boot', { sandboxBootId: 'boot-other' }],
    ['wrong supervisor executable', { supervisorExecutableHash: HASH('9') }],
    ['provider key in environment', { providerCredentialsAbsent: false }],
    ['Daytona credential in environment', { daytonaCredentialsAbsent: false }],
    ['unauthenticated control channel', {
      controlChannel: { kind: 'inherited-pipe', authenticated: false, open: true },
    }],
    ['unbounded root', {
      filesystem: { ...platformObservation().filesystem, sandboxRootBytes: TEN_GIB - 1 },
    }],
    ['daemon root on another filesystem', {
      filesystem: { ...platformObservation().filesystem, boundedRootId: 'other-fs' },
    }],
    ['default Docker root on bounded filesystem', {
      filesystem: { ...platformObservation().filesystem, defaultDockerRootId: 'bounded-fs' },
    }],
    ['same broker and runner uid', {
      identities: { ...platformObservation().identities, brokerUid: 2001 },
    }],
    ['broker client group equals broker primary group', {
      identities: { ...platformObservation().identities, brokerClientGid: 2002 },
    }],
    ['core dumps enabled', {
      custody: { ...platformObservation().custody, coreDumpsDisabled: false },
    }],
    ['evidence retained too long', {
      custody: { ...platformObservation().custody, evidenceRetentionDays: 31 },
    }],
  ];

  for (const [name, drift] of drifts) {
    await t.test(name, async () => {
      const effects = createEffects({ inspectPlatform: async () => platformObservation(drift) });
      const runtime = supervisor(effects);
      await assert.rejects(runtime.prepare(prepareInput()), RuntimeSupervisorError);
      assert.equal(runtime.snapshot().state, 'failed');
      assert.equal(effects.calls.some(([method]) => method === 'startProviderBroker'), false);
      assert.equal(effects.calls.some(([method]) => method === 'shutdown'), true);
    });
  }
});

test('rejects root primary groups for the runner and provider broker before privileged startup', async (t) => {
  for (const [name, identityDrift] of [
    ['runner', { runnerGid: 0 }],
    ['provider broker', { brokerGid: 0 }],
  ]) {
    await t.test(name, async () => {
      const identities = { ...platformObservation().identities, ...identityDrift };
      const effects = createEffects({
        inspectPlatform: async () => platformObservation({ identities }),
        startDockerProxy: async (options) => {
          effects.calls.push(['startDockerProxy', options]);
          return proxyObservation({ socketGroupGid: identities.runnerGid });
        },
      });
      const runtime = supervisor(effects);
      await assert.rejects(runtime.prepare(prepareInput()), RuntimeSupervisorError);
      assert.equal(effects.calls.some(([method]) => method === 'startPrivateDaemon'), false);
    });
  }
});

test('withholds readiness for every daemon, socket, isolation, and broker-binding drift', async (t) => {
  const readiness = readinessObservation();
  const brokerDrift = (options, overrides) => brokerObservation({
    leaseId: options.leaseId,
    leaseDigest: options.leaseHash,
    leaseSequence: options.leaseSequence,
    trialId: options.trialId,
    ...overrides,
  });
  const drifts = [
    ['headroom reserve is too small', 'reserveEvidenceHeadroom', () => ({
      bytes: RESERVE_BYTES - 1,
      filesystemId: 'bounded-fs',
      protectedFromRunner: true,
    })],
    ['daemon data root binding changed', 'startPrivateDaemon', () => daemonObservation({ dataRootHash: HASH('9') })],
    ['daemon socket group changed', 'startPrivateDaemon', () => daemonObservation({ socketGroupGid: 2001 })],
    ['Docker proxy became bypassable', 'startDockerProxy', () => proxyObservation({ nonBypassable: false })],
    ['Docker proxy group changed', 'startDockerProxy', () => proxyObservation({ socketGroupGid: 2003 })],
    ['broker did not consume inherited key fd', 'startProviderBroker', (options) => brokerDrift(options, { keyFdConsumed: false })],
    ['broker persisted the credential', 'startProviderBroker', (options) => brokerDrift(options, { credentialPersisted: true })],
    ['broker shared group changed', 'startProviderBroker', (options) => brokerDrift(options, { socketGroupGid: 2002 })],
    ['broker socket parent lost setgid policy', 'startProviderBroker', (options) => brokerDrift(options, { socketParentMode: 0o710 })],
    ['broker bound another lease digest', 'startProviderBroker', (options) => brokerDrift(options, { leaseDigest: HASH('0') })],
    ['no-provider probe made a provider call', 'inspectReadiness', () => ({
      ...readiness,
      noProviderProbe: { ...readiness.noProviderProbe, providerCalls: 1 },
    })],
    ['no-provider probe saw the provider credential', 'inspectReadiness', () => ({
      ...readiness,
      noProviderProbe: { ...readiness.noProviderProbe, providerCredentialAbsent: false },
    })],
    ['runner retained a capability', 'inspectReadiness', () => ({
      ...readiness,
      runner: { ...readiness.runner, effectiveCapabilities: 1 },
    })],
    ['task received broker client group', 'inspectReadiness', () => ({
      ...readiness,
      task: { ...readiness.task, brokerClientGidPresent: true },
    })],
    ['task received broker socket mount', 'inspectReadiness', () => ({
      ...readiness,
      task: { ...readiness.task, brokerSocketMounted: true },
    })],
  ];

  for (const [name, method, result] of drifts) {
    await t.test(name, async () => {
      const effects = createEffects();
      effects[method] = async (options) => {
        effects.calls.push([method, options]);
        return result(options);
      };
      const runtime = supervisor(effects);
      await assert.rejects(runtime.prepare(prepareInput()), /failed closed/i);
      assert.equal(runtime.snapshot().state, 'failed');
      assert.equal(effects.calls.some(([called]) => called === 'launchRunner'), false);
      assert.equal(effects.calls.some(([called]) => called === 'shutdown'), true);
    });
  }
});

test('does not disclose the signed candidate when one-shot broker launch or post-broker re-observation fails', async (t) => {
  await t.test('control channel is already closed at handler installation', async () => {
    const effects = createEffects();
    effects.installControlChannelLossHandler = (handler) => {
      effects.calls.push(['installControlChannelLossHandler']);
      void handler('controller-channel-closed');
      return () => {};
    };
    const runtime = supervisor(effects);
    await assert.rejects(runtime.prepare(prepareInput()), /failed closed/i);
    assert.equal(runtime.snapshot().state, 'failed');
    assert.equal(effects.calls.some(([name]) => name === 'inspectPlatform'), false);
  });

  await t.test('broker launch failure', async () => {
    const effects = createEffects();
    effects.startProviderBroker = async (options) => {
      effects.calls.push(['startProviderBroker', options]);
      throw new Error('one-shot broker failed');
    };
    const runtime = supervisor(effects);
    await assert.rejects(runtime.prepare(prepareInput()), /failed closed/i);
    assert.equal(runtime.snapshot().state, 'failed');
    assert.equal(effects.calls.filter(([name]) => name === 'startProviderBroker').length, 1);
    assert.equal(effects.calls.some(([name]) => name === 'closeInheritedFd'), true);
    assert.equal(effects.calls.some(([name]) => name === 'installControlChannelLossHandler'), true);
  });

  await t.test('post-broker probe changed', async () => {
    const effects = createEffects();
    let inspections = 0;
    effects.inspectReadiness = async (options) => {
      effects.calls.push(['inspectReadiness', options]);
      inspections += 1;
      const observation = readinessObservation();
      if (inspections === 2) {
        observation.storageProbe.evidenceHeadroomRecovered = false;
      }
      return observation;
    };
    const runtime = supervisor(effects);
    await assert.rejects(runtime.prepare(prepareInput()), /failed closed/i);
    assert.equal(inspections, 2);
    assert.equal(effects.calls.filter(([name]) => name === 'startProviderBroker').length, 1);
    assert.equal(effects.calls.some(([name]) => name === 'installControlChannelLossHandler'), true);
    assert.equal(runtime.snapshot().state, 'failed');
  });

  await t.test('control channel closes during broker launch', async () => {
    const effects = createEffects();
    effects.startProviderBroker = async (options) => {
      effects.calls.push(['startProviderBroker', options]);
      void effects.emitChannelLoss();
      return brokerObservation({
        leaseId: options.leaseId,
        leaseDigest: options.leaseHash,
        leaseSequence: options.leaseSequence,
        trialId: options.trialId,
      });
    };
    const runtime = supervisor(effects);
    await assert.rejects(runtime.prepare(prepareInput()), /failed closed/i);
    assert.equal(runtime.snapshot().state, 'failed');
    assert.equal(effects.calls.filter(([name]) => name === 'startProviderBroker').length, 1);
    assert.equal(effects.calls.filter(([name]) => name === 'inspectReadiness').length, 1);
  });
});

test('rejects forged requests, unsafe runner launch data, and non-pipe key descriptors without starting paid capability', async (t) => {
  await t.test('forged request', async () => {
    const effects = createEffects();
    const request = signedRequest();
    request.budget.trialCeilingMicrousd += 1;
    await assert.rejects(supervisor(effects).prepare(prepareInput(request)), /failed closed/i);
    assert.equal(effects.calls.some(([method]) => method === 'startProviderBroker'), false);
  });

  await t.test('relative executable', async () => {
    const effects = createEffects();
    const input = prepareInput();
    input.runner.argv[0] = 'engineer-eval-runner';
    await assert.rejects(supervisor(effects).prepare(input), /failed closed/i);
    assert.equal(effects.calls.some(([method]) => method === 'inspectPlatform'), false);
  });

  await t.test('credential-shaped runner environment', async () => {
    const effects = createEffects();
    const input = prepareInput();
    input.runner.env.OPENROUTER_API_KEY = 'must-not-propagate';
    await assert.rejects(supervisor(effects).prepare(input), /failed closed/i);
    assert.equal(effects.calls.some(([method]) => method === 'inspectPlatform'), false);
  });

  await t.test('credential embedded in broker policy', async () => {
    const effects = createEffects();
    const input = prepareInput();
    input.brokerPolicy.apiKey = 'sk-or-v1-must-not-cross-the-fd-boundary';
    await assert.rejects(supervisor(effects).prepare(input), /failed closed/i);
    assert.equal(effects.calls.some(([method]) => method === 'inspectPlatform'), false);
  });

  await t.test('broker budget binding differs from signed trial budget', async () => {
    const effects = createEffects();
    const input = prepareInput();
    input.brokerPolicy.trials[0].ceilingUsd = 0.64;
    await assert.rejects(supervisor(effects).prepare(input), /failed closed/i);
    assert.equal(effects.calls.some(([method]) => method === 'startProviderBroker'), false);
    assert.equal(effects.calls.some(([method]) => method === 'closeInheritedFd'), true);
  });

  await t.test('regular-file provider fd', async () => {
    const effects = createEffects({
      async inspectProviderKeyFd(fd) {
        effects.calls.push(['inspectProviderKeyFd', fd]);
        return { kind: 'file', open: true };
      },
    });
    await assert.rejects(supervisor(effects).prepare(prepareInput()), /failed closed/i);
    assert.equal(effects.calls.some(([method]) => method === 'startProviderBroker'), false);
  });
});

test('never signs final evidence when any post-run custody or reconciliation fact is incomplete', async (t) => {
  const drifts = [
    ['Harbor incomplete', { harbor: { ...finalEvidence().harbor, completed: false } }],
    ['Docker event loss', { docker: { ...finalEvidence().docker, eventsComplete: false } }],
    ['orphan container', { docker: { ...finalEvidence().docker, containersRemaining: 1 } }],
    ['mount escape', { mounts: { ...finalEvidence().mounts, outsideAllowedWrites: true } }],
    ['cgroup still populated', { cgroup: { ...finalEvidence().cgroup, populated: true } }],
    ['resource drift', { resources: { ...finalEvidence().resources, memoryWithinLimit: false } }],
    ['task network drift', { network: { ...finalEvidence().network, taskNetworkNone: false } }],
    ['billing uncertainty', { provider: { ...finalEvidence().provider, billingCertain: false } }],
    ['budget overrun', { provider: { ...finalEvidence().provider, spendMicrousd: 650_001 } }],
    ['cleanup incomplete', { cleanup: { ...finalEvidence().cleanup, completed: false } }],
    ['future-dated runtime evidence', { endedAt: '2026-08-04T17:00:00.000Z' }],
  ];

  for (const [name, drift] of drifts) {
    await t.test(name, async () => {
      const effects = createEffects({
        async collectFinalEvidence() {
          effects.calls.push(['collectFinalEvidence']);
          return finalEvidence(drift);
        },
      });
      const runtime = supervisor(effects);
      await runtime.prepare(prepareInput());
      await runtime.run();
      await assert.rejects(
        runtime.finalize({ outcome: { status: 'succeeded', exitReason: 'completed' } }),
        /failed closed/i
      );
      assert.equal(runtime.snapshot().state, 'failed');
      assert.equal(runtime.snapshot().finalAttestationHash, undefined);
      assert.equal(effects.calls.some(([method]) => method === 'killTrialCgroup'), true);
    });
  }
});

test('withholds final attestation when supervisor shutdown cannot prove zero processes, sockets, and released headroom', async () => {
  const effects = createEffects({
    async shutdown(options) {
      effects.calls.push(['shutdown', options]);
      return {
        completed: true,
        processesRemaining: 0,
        socketsRemaining: 1,
        evidenceHeadroomReleased: true,
        endedAt: '2026-08-04T16:00:09.000Z',
      };
    },
  });
  const runtime = supervisor(effects);
  await runtime.prepare(prepareInput());
  await runtime.run();
  await assert.rejects(
    runtime.finalize({ outcome: { status: 'succeeded', exitReason: 'completed' } }),
    /failed closed/i
  );
  assert.equal(runtime.snapshot().state, 'failed');
  assert.equal(runtime.snapshot().finalAttestationHash, undefined);
});

test('control-channel loss transitions synchronously to fail-stop, kills the cgroup, and makes finalization impossible', async () => {
  let resolveRunner;
  const runnerPending = new Promise((resolve) => { resolveRunner = resolve; });
  const effects = createEffects({
    async launchRunner(options) {
      effects.calls.push(['launchRunner', options]);
      return runnerPending;
    },
  });
  const runtime = supervisor(effects);
  await runtime.prepare(prepareInput());
  const run = runtime.run();
  assert.equal(runtime.snapshot().state, 'running');

  const stopping = effects.emitChannelLoss();
  assert.equal(runtime.snapshot().state, 'fail-stopping');
  resolveRunner({
    exitCode: 137,
    signal: 'SIGKILL',
    startedAt: '2026-08-04T16:00:02.000Z',
    endedAt: '2026-08-04T16:00:03.000Z',
  });
  await stopping;
  await assert.rejects(run, /failed closed/i);
  assert.equal(runtime.snapshot().state, 'failed');
  assert.equal(effects.calls.findIndex(([name]) => name === 'killTrialCgroup')
    < effects.calls.findIndex(([name]) => name === 'shutdown'), true);
  await assert.rejects(
    runtime.finalize({ outcome: { status: 'failed', exitReason: 'controller-channel-closed' } }),
    /invalid supervisor lifecycle/i
  );
});

test('bounds public state and errors so effect secrets and raw evidence cannot escape', async () => {
  const secret = 'sk-or-v1-never-return-this-value';
  const effects = createEffects({
    async startPrivateDaemon() {
      throw new Error(`daemon failed with ${secret}`);
    },
  });
  const runtime = supervisor(effects);
  let observedError;
  try {
    await runtime.prepare(prepareInput());
  } catch (error) {
    observedError = error;
  }
  assert.equal(String(observedError).includes(secret), false);
  assert.equal(JSON.stringify(runtime.snapshot()).includes(secret), false);

  const evidenceEffects = createEffects({
    async collectFinalEvidence() {
      evidenceEffects.calls.push(['collectFinalEvidence']);
      return { ...finalEvidence(), rawLogs: secret };
    },
  });
  const evidenceRuntime = supervisor(evidenceEffects);
  await evidenceRuntime.prepare(prepareInput());
  await evidenceRuntime.run();
  await assert.rejects(
    evidenceRuntime.finalize({ outcome: { status: 'succeeded', exitReason: 'completed' } }),
    /failed closed/i
  );
  assert.equal(JSON.stringify(evidenceRuntime.snapshot()).includes(secret), false);

  const channelEffects = createEffects();
  const channelRuntime = supervisor(channelEffects);
  await channelRuntime.prepare(prepareInput());
  await channelRuntime.controlChannelLost(secret);
  const killCall = channelEffects.calls.find(([name]) => name === 'killTrialCgroup');
  assert.equal(killCall[1].reason, 'runtime-fail-stop');
  assert.equal(JSON.stringify(channelEffects.calls).includes(secret), false);
});

test('enforces a one-way lifecycle and one-use request/credential channel', async () => {
  const effects = createEffects();
  const runtime = supervisor(effects);
  await assert.rejects(runtime.run(), /invalid supervisor lifecycle/i);
  await runtime.prepare(prepareInput());
  await assert.rejects(runtime.prepare(prepareInput()), /invalid supervisor lifecycle/i);
  await assert.rejects(
    runtime.finalize({ outcome: { status: 'succeeded', exitReason: 'completed' } }),
    /invalid supervisor lifecycle/i
  );
  await runtime.run();
  await runtime.finalize({ outcome: { status: 'succeeded', exitReason: 'completed' } });
  await assert.rejects(runtime.run(), /invalid supervisor lifecycle/i);
  assert.equal(effects.calls.filter(([name]) => name === 'startProviderBroker').length, 1);
  assert.equal(effects.calls.filter(([name]) => name === 'closeInheritedFd').length, 1);
});
