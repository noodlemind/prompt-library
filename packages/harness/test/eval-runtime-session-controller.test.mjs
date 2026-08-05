import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDaytonaSessionController } from '../../../evals/runtime/daytona-controller.mjs';
import {
  GENESIS_CHAIN_HASH,
  canonicalJson,
  protocolDocumentHash,
  sha256Hex,
  signProtocolDocument,
  verifyProtocolDocument,
  verifySessionTrialHashChain,
} from '../../../evals/runtime/protocol.mjs';
import {
  createRuntimeSessionController,
  isRuntimeControllerReadiness,
  isRuntimeSessionFinal,
} from '../../../evals/runtime/session-controller.mjs';

const NOW = new Date('2026-08-04T20:00:00.000Z');
const CONTROLLER_KEY = Buffer.alloc(32, 0x41);
const SUPERVISOR_KEY = Buffer.alloc(32, 0x42);
const RELEASE_SHA = 'a'.repeat(40);
const HASH = (character) => character.repeat(64);
const SNAPSHOT = 'engineer-eval-dind-release-v1';

const SESSION = Object.freeze({
  sessionId: 'release-session-1',
  releaseSha: RELEASE_SHA,
  profileId: 'economical-small-model',
  taskLockHash: HASH('1'),
  bundleHash: HASH('2'),
  budgetId: 'qualification-budget-1',
  budgetPolicyHash: HASH('3'),
  brokerPolicyHash: HASH('0'),
  sessionCeilingMicrousd: 1_300_000,
});

const RUNTIME_BINDINGS = Object.freeze({
  sandboxBootId: 'sandbox-boot-1',
  daemonId: 'private-daemon-1',
  daemonRootHash: HASH('4'),
  cgroupId: 'trial-cgroup-1',
  cgroupPathHash: HASH('5'),
});

function trialSpec(trialId, condition, overrides = {}) {
  return {
    trialId,
    taskId: 'cobol-modernization',
    condition,
    imageDigest: `sha256:${HASH('6')}`,
    trialCeilingMicrousd: 650_000,
    supervisorExecutableHash: HASH('7'),
    runnerExecutableHash: HASH('8'),
    harborExecutableHash: HASH('9'),
    ...overrides,
  };
}

function allocation(name, trialId) {
  return {
    id: `sandbox-${name}`,
    name,
    state: 'started',
    desiredState: 'started',
    snapshot: SNAPSHOT,
    target: 'us',
    sandboxClass: 'container',
    cpu: 2,
    memory: 4,
    disk: 10,
    env: {},
    volumes: [],
    public: false,
    labels: {
      purpose: 'engineer-release-eval',
      'release-commit': RELEASE_SHA,
      'provider-secret': 'broker-only',
      'trial-id': trialId,
    },
  };
}

function fakeDaytona() {
  const calls = [];
  const sandboxes = new Map();
  const runCommand = async (file, args) => {
    calls.push({ file, args: args.slice() });
    if (args[0] === '--version') {
      return { code: 0, stdout: 'Daytona CLI version v0.203.0\n', stderr: '' };
    }
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const trialLabel = args.find((arg) => arg.startsWith('trial-id='));
      sandboxes.set(name, allocation(name, trialLabel.slice('trial-id='.length)));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'info') {
      const observed = [...sandboxes.values()].find((entry) => entry.name === args[1] || entry.id === args[1]);
      if (!observed) {
        return {
          code: 1,
          stdout: '',
          stderr: `time="2026-08-04T20:00:00Z" level=fatal msg="Not Found: Sandbox with ID or name ${args[1]} not found"\n`,
        };
      }
      return { code: 0, stdout: JSON.stringify(observed), stderr: '' };
    }
    if (args[0] === 'delete') {
      sandboxes.delete(args[1]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'list') {
      return { code: 0, stdout: JSON.stringify({ items: [...sandboxes.values()] }), stderr: '' };
    }
    throw new Error(`unexpected Daytona argv: ${args.join(' ')}`);
  };
  const controller = createDaytonaSessionController({
    daytonaPath: '/opt/daytona',
    snapshot: SNAPSHOT,
    releaseSha: RELEASE_SHA,
    sessionBudgetUsd: 1.3,
    runCommand,
    randomBytes: () => Buffer.alloc(16, 0xab),
    now: () => NOW,
    sleep: async () => {},
  });
  return { calls, controller, sandboxes };
}

function supervisorReadiness(request, overrides = {}) {
  const unsigned = {
    schema: 'engineer-runtime-readiness-lease.v1',
    protocolVersion: 1,
    sessionId: request.sessionId,
    trialId: request.trialId,
    sequence: request.sequence + 1,
    nonce: (request.sequence + 100).toString(16).padStart(64, '0'),
    issuedAt: NOW.toISOString(),
    expiresAt: '2026-08-04T20:05:00.000Z',
    requestHash: protocolDocumentHash(request),
    requestNonce: request.nonce,
    previousTrialChainHash: request.previousTrialChainHash,
    bindings: structuredClone(request.bindings),
    budget: structuredClone(request.budget),
    readiness: {
      noProviderProbeHash: HASH('a'),
      dockerProxyPolicyHash: HASH('b'),
      // Static policy identity only. It deliberately excludes the dynamic
      // readiness-lease digest to avoid an attestation cycle.
      brokerPolicyHash: request.bindings.brokerPolicyHash,
      storageProbeHash: HASH('d'),
      privateDaemonBounded: true,
      realDaemonDenied: true,
      taskNetworkNone: true,
      brokerOnlyEgress: true,
      cgroupDelegated: true,
      evidenceHeadroomReserved: true,
    },
    ...overrides,
  };
  return signProtocolDocument(unsigned, SUPERVISOR_KEY, { keyId: 'supervisor-key-1' });
}

function supervisorFinal(request, lease, spendMicrousd, overrides = {}) {
  const unsigned = {
    schema: 'engineer-runtime-trial-final-attestation.v1',
    protocolVersion: 1,
    sessionId: request.sessionId,
    trialId: request.trialId,
    sequence: lease.sequence + 1,
    nonce: (request.sequence + 200).toString(16).padStart(64, '0'),
    issuedAt: NOW.toISOString(),
    expiresAt: '2026-08-05T20:00:00.000Z',
    requestHash: protocolDocumentHash(request),
    readinessLeaseHash: protocolDocumentHash(lease),
    previousTrialChainHash: request.previousTrialChainHash,
    bindings: structuredClone(request.bindings),
    budget: structuredClone(request.budget),
    outcome: {
      status: 'succeeded',
      exitReason: 'verified',
      providerSpendMicrousd: spendMicrousd,
      providerUsageHash: sha256Hex(`usage:${request.trialId}:${spendMicrousd}`),
    },
    runtimeEvidence: {
      evidenceHash: sha256Hex(`evidence:${request.trialId}`),
      dockerEventsHash: HASH('e'),
      mountInventoryHash: HASH('f'),
      cgroupEvidenceHash: HASH('1'),
      networkEvidenceHash: HASH('2'),
      budgetEvidenceHash: HASH('3'),
      startedAt: NOW.toISOString(),
      endedAt: NOW.toISOString(),
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
  return signProtocolDocument(unsigned, SUPERVISOR_KEY, { keyId: 'supervisor-key-1' });
}

function fakeTransport({ spends = [125_000], readinessTransform, finalTransform, failAt } = {}) {
  const calls = [];
  let finalIndex = 0;
  return {
    calls,
    async prepareTrial(input) {
      calls.push({ name: 'prepareTrial', input });
      if (failAt === 'prepare') throw new Error('supervisor channel closed during prepare');
      return { channel: { id: input.spec.trialId }, runtimeBindings: structuredClone(RUNTIME_BINDINGS) };
    },
    async requestReadiness(input) {
      calls.push({ name: 'requestReadiness', input });
      if (failAt === 'readiness') throw new Error('supervisor channel closed before readiness');
      const lease = supervisorReadiness(input.request);
      return readinessTransform ? readinessTransform(lease, input.request) : lease;
    },
    async requestFinal(input) {
      calls.push({ name: 'requestFinal', input });
      if (failAt === 'final') throw new Error('supervisor channel closed before final evidence');
      const attestation = supervisorFinal(input.request, input.readinessLease, spends[finalIndex++]);
      return finalTransform ? finalTransform(attestation, input.request, input.readinessLease) : attestation;
    },
    async closeTrial(input) {
      calls.push({ name: 'closeTrial', input });
      if (failAt === 'close') throw new Error('supervisor channel closed during close');
    },
  };
}

function nonceSequence() {
  let value = 1;
  return () => (value++).toString(16).padStart(64, '0');
}

function runtime({ daytona = fakeDaytona(), transport = fakeTransport(), overrides = {} } = {}) {
  const controller = createRuntimeSessionController({
    daytonaController: daytona.controller,
    transport,
    session: SESSION,
    controllerKey: CONTROLLER_KEY,
    controllerKeyId: 'controller-key-1',
    supervisorKey: SUPERVISOR_KEY,
    supervisorKeyId: 'supervisor-key-1',
    now: () => NOW,
    nonceGenerator: nonceSequence(),
    transportTimeoutMs: 1_000,
    ...overrides,
  });
  return { controller, daytona, transport };
}

test('controller readiness is code-owned and does not pre-attest a future sandbox', () => {
  const { controller } = runtime();
  const readiness = controller.readiness();
  assert.equal(readiness.schema, 'engineer-runtime-controller-readiness.v1');
  assert.equal(readiness.source, 'external-controller');
  assert.equal(readiness.runtimeAttested, false);
  assert.equal(readiness.providerAuthorized, false);
  assert.equal(readiness.releaseSha, RELEASE_SHA);
  assert.equal(readiness.sessionId, SESSION.sessionId);
  assert.equal(isRuntimeControllerReadiness(readiness), true);
  assert.equal(isRuntimeControllerReadiness(structuredClone(readiness)), false);
  assert.deepEqual(controller.snapshot().trials, []);
  assert.equal(controller.snapshot().keyMaterialDisposed, false);
});

test('two per-trial sandboxes produce one authenticated global sequence, deletion chain, and exact budget', async () => {
  const daytona = fakeDaytona();
  const transport = fakeTransport({ spends: [125_000, 200_000] });
  const { controller } = runtime({ daytona, transport });
  let providerCalls = 0;

  const first = await controller.runTrial(trialSpec('generic-r1', 'generic'), async ({ authorization }) => {
    providerCalls += 1;
    assert.equal(authorization.providerAuthorized, true);
    assert.equal(authorization.readinessLease.sequence, 2);
    return { verifier: 'pass' };
  });
  const second = await controller.runTrial(trialSpec('harness-r1', 'harness'), async ({ authorization }) => {
    providerCalls += 1;
    assert.equal(authorization.readinessLease.sequence, 5);
    return { verifier: 'pass' };
  });
  const final = controller.finalize();

  assert.equal(providerCalls, 2);
  assert.equal(first.attestation.sequence, 3);
  assert.equal(second.attestation.sequence, 6);
  assert.equal(final.sequence, 7);
  assert.equal(final.budget.sessionCommittedMicrousd, 1_300_000);
  assert.equal(final.budget.sessionSpentMicrousd, 325_000);
  assert.equal(final.trials[0].previousChainHash, GENESIS_CHAIN_HASH);
  assert.equal(final.trials[1].previousChainHash, final.trials[0].chainHash);
  assert.equal(final.chainHead, final.trials[1].chainHash);
  assert.equal(controller.snapshot().keyMaterialDisposed, true);
  assert.equal(isRuntimeSessionFinal(final), true);
  assert.equal(isRuntimeSessionFinal(structuredClone(final)), false);
  assert.equal(daytona.sandboxes.size, 0);
  assert.equal(daytona.calls.filter(({ args }) => args[0] === 'create').length, 2);
  assert.equal(daytona.calls.filter(({ args }) => args[0] === 'delete').length, 2);
  assert.doesNotThrow(() => verifyProtocolDocument(final, CONTROLLER_KEY, {
    expectedKeyId: 'controller-key-1',
    now: NOW,
  }));
  assert.doesNotThrow(() => verifySessionTrialHashChain(final, [first.attestation, second.attestation]));
});

test('tampered or replayed readiness never reaches provider work and always deletes the sandbox', async () => {
  for (const [label, readinessTransform] of [
    ['tamper', (lease) => ({ ...lease, requestHash: HASH('f') })],
    ['replay', (lease) => ({
      ...signProtocolDocument({
        ...Object.fromEntries(Object.entries(lease).filter(([key]) => key !== 'authentication')),
        nonce: '1'.padStart(64, '0'),
      }, SUPERVISOR_KEY, { keyId: 'supervisor-key-1' }),
    })],
    ['static-policy', (lease) => signProtocolDocument({
      ...Object.fromEntries(Object.entries(lease).filter(([key]) => key !== 'authentication')),
      readiness: { ...lease.readiness, brokerPolicyHash: HASH('f') },
    }, SUPERVISOR_KEY, { keyId: 'supervisor-key-1' })],
  ]) {
    const daytona = fakeDaytona();
    const transport = fakeTransport({ readinessTransform });
    const { controller } = runtime({ daytona, transport });
    let providerCalls = 0;
    await assert.rejects(
      controller.runTrial(trialSpec(`${label}-r1`, 'generic'), async () => { providerCalls += 1; }),
      /authentication|replay|nonce|protocol|policy/i,
      label
    );
    assert.equal(providerCalls, 0, label);
    assert.equal(daytona.sandboxes.size, 0, label);
    assert.equal(controller.snapshot().failStopped, true, label);
    assert.equal(controller.snapshot().keyMaterialDisposed, true, label);
    assert.throws(() => controller.finalize(), /fail-stopped|compromised/i, label);
  }
});

test('channel loss and invalid final budget evidence fail-stop after external deletion', async () => {
  for (const [label, transport] of [
    ['channel', fakeTransport({ failAt: 'final' })],
    ['budget', fakeTransport({ finalTransform: (attestation, request, lease) => supervisorFinal(
      request,
      lease,
      request.budget.trialCeilingMicrousd,
      { budget: { ...request.budget, sessionCommittedMicrousd: request.budget.sessionCommittedMicrousd + 1 } }
    ) })],
  ]) {
    const daytona = fakeDaytona();
    const { controller } = runtime({ daytona, transport });
    await assert.rejects(
      controller.runTrial(trialSpec(`${label}-r1`, 'generic'), async () => 'provider-result'),
      /channel|budget|binding|protocol/i,
      label
    );
    assert.equal(daytona.sandboxes.size, 0, label);
    assert.equal(daytona.calls.filter(({ args }) => args[0] === 'delete').length, 1, label);
    assert.equal(controller.snapshot().failStopped, true, label);
  }
});

test('an unconfirmed platform deletion prevents a trial chain and green session final', async () => {
  const daytona = fakeDaytona();
  const original = daytona.controller;
  const deletionFailure = {
    beginTrial: original.beginTrial,
    abortTrial: original.abortTrial,
    snapshot: original.snapshot,
    finalizeSession: original.finalizeSession,
    async completeTrial() {
      throw new Error('sandbox deletion receipt is unavailable');
    },
  };
  const { controller } = runtime({ daytona: { ...daytona, controller: deletionFailure } });
  await assert.rejects(
    controller.runTrial(trialSpec('delete-r1', 'generic'), async () => 'provider-result'),
    /deletion receipt|delete|cleanup/i
  );
  assert.equal(controller.snapshot().trials.length, 0);
  assert.equal(controller.snapshot().failStopped, true);
  assert.equal(daytona.sandboxes.size, 0);
  assert.throws(() => controller.finalize(), /fail-stopped|compromised/i);
});

test('unknown secret-bearing trial input is rejected before provisioning and never retained', async () => {
  const daytona = fakeDaytona();
  const { controller } = runtime({ daytona });
  await assert.rejects(
    controller.beginTrial(trialSpec('secret-r1', 'generic', { OPENROUTER_API_KEY: 'do-not-retain' })),
    /unknown|secret|field/i
  );
  assert.equal(daytona.calls.length, 0);
  assert.equal(JSON.stringify(controller.snapshot()).includes('do-not-retain'), false);
  assert.equal(canonicalJson(controller.snapshot()).includes('do-not-retain'), false);
});

test('dispose fail-stops an unused session, zeroes its key copies, and is idempotent', async () => {
  const { controller } = runtime();

  const first = controller.dispose();
  const second = controller.dispose();
  assert.equal(first, second);
  const receipt = await first;

  assert.deepEqual(receipt, {
    schema: 'engineer-runtime-session-disposal.v1',
    sessionId: SESSION.sessionId,
    disposed: true,
    activeTrialDeleted: false,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(controller.snapshot().disposed, true);
  assert.equal(controller.snapshot().failStopped, true);
  assert.equal(controller.snapshot().keyMaterialDisposed, true);
  assert.throws(() => controller.readiness(), /disposed/i);
  await assert.rejects(controller.beginTrial(trialSpec('disposed-r1', 'generic')), /disposed/i);
  await assert.rejects(
    controller.runTrial(trialSpec('disposed-r2', 'generic'), async () => 'provider-result'),
    /disposed/i
  );
  assert.throws(() => controller.finalize(), /disposed/i);
});

test('dispose closes and deletes an active per-trial sandbox before returning', async () => {
  const daytona = fakeDaytona();
  const transport = fakeTransport();
  const { controller } = runtime({ daytona, transport });
  const handle = await controller.beginTrial(trialSpec('dispose-active-r1', 'generic'));

  const receipt = await controller.dispose();

  assert.equal(receipt.activeTrialDeleted, true);
  assert.equal(daytona.sandboxes.size, 0);
  assert.equal(daytona.calls.filter(({ args }) => args[0] === 'delete').length, 1);
  assert.equal(transport.calls.filter(({ name }) => name === 'closeTrial').length, 1);
  assert.equal(controller.snapshot().activeTrial, undefined);
  assert.equal(controller.snapshot().keyMaterialDisposed, true);
  await assert.rejects(controller.verifyTrialReadiness(handle), /disposed/i);
  await assert.rejects(controller.completeTrial(handle), /disposed/i);
  await assert.rejects(controller.abortTrial(handle), /disposed/i);
});

test('dispose waits for in-flight provisioning and deletes any allocation that arrives afterward', async () => {
  const daytona = fakeDaytona();
  const originalBeginTrial = daytona.controller.beginTrial;
  let releaseProvisioning;
  const provisioningGate = new Promise((resolve) => { releaseProvisioning = resolve; });
  const delayedController = {
    ...daytona.controller,
    async beginTrial(input) {
      await provisioningGate;
      return originalBeginTrial(input);
    },
  };
  const { controller } = runtime({ daytona: { ...daytona, controller: delayedController } });

  const beginning = controller.beginTrial(trialSpec('dispose-pending-r1', 'generic'));
  const disposing = controller.dispose();
  releaseProvisioning();

  await assert.rejects(beginning, /disposed/i);
  const receipt = await disposing;
  assert.equal(receipt.activeTrialDeleted, true);
  assert.equal(daytona.sandboxes.size, 0);
  assert.equal(daytona.calls.filter(({ args }) => args[0] === 'delete').length, 1);
  assert.equal(controller.snapshot().keyMaterialDisposed, true);
});

test('dispose exposes no dependency error or secret material when active cleanup fails', async () => {
  const secret = 'do-not-expose-runtime-secret';
  const daytona = fakeDaytona();
  const transport = fakeTransport();
  transport.closeTrial = async (input) => {
    transport.calls.push({ name: 'closeTrial', input });
    throw new Error(`cleanup transport contained ${secret}`);
  };
  const { controller } = runtime({ daytona, transport });
  await controller.beginTrial(trialSpec('dispose-error-r1', 'generic'));

  const disposal = controller.dispose();
  await assert.rejects(disposal, (error) => {
    assert.match(error.message, /disposal cleanup failed/i);
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  await assert.rejects(controller.dispose(), /disposal cleanup failed/i);
  assert.equal(daytona.sandboxes.size, 0);
  assert.equal(JSON.stringify(controller.snapshot()).includes(secret), false);
  assert.equal(controller.snapshot().keyMaterialDisposed, true);
});

test('dispose after finalization remains idempotent without invalidating authenticated final evidence', async () => {
  const { controller } = runtime();
  const completed = await controller.runTrial(
    trialSpec('dispose-final-r1', 'generic'),
    async () => 'provider-result'
  );
  const final = controller.finalize();

  const first = controller.dispose();
  const second = controller.dispose();
  assert.equal(first, second);
  const receipt = await first;

  assert.equal(receipt.activeTrialDeleted, false);
  assert.equal(controller.snapshot().disposed, true);
  assert.equal(controller.snapshot().failStopped, false);
  assert.equal(controller.snapshot().finalized, true);
  assert.equal(controller.snapshot().keyMaterialDisposed, true);
  assert.equal(isRuntimeSessionFinal(final), true);
  assert.doesNotThrow(() => verifySessionTrialHashChain(final, [completed.attestation]));
});

test('dispose after completed trials prevents a later session final and retains no signing keys', async () => {
  const { controller } = runtime();
  await controller.runTrial(
    trialSpec('dispose-completed-r1', 'generic'),
    async () => 'provider-result'
  );

  const receipt = await controller.dispose();

  assert.equal(receipt.activeTrialDeleted, false);
  assert.equal(controller.snapshot().trials.length, 1);
  assert.equal(controller.snapshot().disposed, true);
  assert.equal(controller.snapshot().keyMaterialDisposed, true);
  assert.throws(() => controller.finalize(), /disposed/i);
});
