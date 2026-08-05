import {
  protocolDocumentHash,
  sha256Hex,
  signProtocolDocument,
} from '../../../../evals/runtime/protocol.mjs';
import { createRuntimeSessionController } from '../../../../evals/runtime/session-controller.mjs';

const HASH = (character) => character.repeat(64);
const NOW = new Date('2026-08-04T20:00:00.000Z');
const CONTROLLER_KEY = Buffer.alloc(32, 0x41);
const SUPERVISOR_KEY = Buffer.alloc(32, 0x42);

function readinessFor(request) {
  return signProtocolDocument({
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
      brokerPolicyHash: request.bindings.brokerPolicyHash,
      storageProbeHash: HASH('d'),
      privateDaemonBounded: true,
      realDaemonDenied: true,
      taskNetworkNone: true,
      brokerOnlyEgress: true,
      cgroupDelegated: true,
      evidenceHeadroomReserved: true,
    },
  }, SUPERVISOR_KEY, { keyId: 'supervisor-key-1' });
}

function finalFor(request, readinessLease, providerSpendMicrousd) {
  return signProtocolDocument({
    schema: 'engineer-runtime-trial-final-attestation.v1',
    protocolVersion: 1,
    sessionId: request.sessionId,
    trialId: request.trialId,
    sequence: readinessLease.sequence + 1,
    nonce: (request.sequence + 200).toString(16).padStart(64, '0'),
    issuedAt: NOW.toISOString(),
    expiresAt: '2026-08-05T20:00:00.000Z',
    requestHash: protocolDocumentHash(request),
    readinessLeaseHash: protocolDocumentHash(readinessLease),
    previousTrialChainHash: request.previousTrialChainHash,
    bindings: structuredClone(request.bindings),
    budget: structuredClone(request.budget),
    outcome: {
      status: 'succeeded',
      exitReason: 'verified',
      providerSpendMicrousd,
      providerUsageHash: sha256Hex(`fixture-usage:${request.trialId}`),
    },
    runtimeEvidence: {
      evidenceHash: sha256Hex(`fixture-evidence:${request.trialId}`),
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
  }, SUPERVISOR_KEY, { keyId: 'supervisor-key-1' });
}

export async function createGenuineRuntimeSession({
  releaseSha = 'a'.repeat(40),
  sessionId = 'release-session-fixture',
  conditions = ['generic', 'harness'],
  providerSpendMicrousd = 100,
} = {}) {
  const retained = [];
  const allocations = new Map();
  const daytonaController = {
    async beginTrial({ trialId, reservedUsd }) {
      const allocation = { id: `sandbox-${trialId}` };
      allocations.set(trialId, { allocation, reservedUsd, evidenceHash: null, deleted: false });
      return { allocation, readiness: { bounded: true } };
    },
    async completeTrial({ trialId, evidence }) {
      const record = allocations.get(trialId);
      record.evidenceHash = evidence.evidenceHash;
      record.deleted = true;
      retained.push({
        trialId,
        sandboxId: record.allocation.id,
        evidenceHash: record.evidenceHash,
        deleted: true,
      });
      return {
        trialId,
        sandboxId: record.allocation.id,
        deleted: true,
        deletedAt: NOW.toISOString(),
      };
    },
    async abortTrial({ trialId }) {
      const record = allocations.get(trialId);
      if (record) record.deleted = true;
      return { trialId, sandboxId: record?.allocation.id, deleted: true, deletedAt: NOW.toISOString() };
    },
    finalizeSession() {
      return {
        deleted: retained.length === conditions.length,
        reservedUsd: [...allocations.values()].reduce((sum, entry) => sum + entry.reservedUsd, 0),
        trials: structuredClone(retained),
      };
    },
    snapshot() {
      return { allocations: allocations.size };
    },
  };
  const transport = {
    async prepareTrial({ allocation }) {
      return {
        channel: { sandboxId: allocation.id },
        runtimeBindings: {
          sandboxBootId: `boot-${allocation.id}`,
          daemonId: `daemon-${allocation.id}`,
          daemonRootHash: HASH('4'),
          cgroupId: `cgroup-${allocation.id}`,
          cgroupPathHash: HASH('5'),
        },
      };
    },
    async requestReadiness({ request }) {
      return readinessFor(request);
    },
    async requestFinal({ request, readinessLease }) {
      return finalFor(request, readinessLease, providerSpendMicrousd);
    },
    async closeTrial() {},
  };
  let nonce = 1;
  const controller = createRuntimeSessionController({
    daytonaController,
    transport,
    session: {
      sessionId,
      releaseSha,
      profileId: 'economical-small-model',
      taskLockHash: HASH('1'),
      bundleHash: HASH('2'),
      budgetId: 'qualification-budget-1',
      budgetPolicyHash: HASH('3'),
      brokerPolicyHash: HASH('0'),
      sessionCeilingMicrousd: 1_300_000,
    },
    controllerKey: CONTROLLER_KEY,
    controllerKeyId: 'controller-key-1',
    supervisorKey: SUPERVISOR_KEY,
    supervisorKeyId: 'supervisor-key-1',
    now: () => NOW,
    nonceGenerator: () => (nonce++).toString(16).padStart(64, '0'),
  });
  const attestationHashes = [];
  for (const [index, condition] of conditions.entries()) {
    const completed = await controller.runTrial({
      trialId: `${condition}-${index + 1}`,
      taskId: 'cobol-modernization',
      condition,
      imageDigest: `sha256:${HASH('6')}`,
      trialCeilingMicrousd: 650_000,
      supervisorExecutableHash: HASH('7'),
      runnerExecutableHash: HASH('8'),
      harborExecutableHash: HASH('9'),
    }, async () => ({ verifier: 'pass' }));
    attestationHashes.push(protocolDocumentHash(completed.attestation));
  }
  return { controller, attestationHashes };
}
