import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  runZeroProviderEvidenceCheck,
  runZeroProviderEvidenceCli,
  validateZeroProviderEvidenceForCommit,
  zeroProviderEvidencePath,
} from '../verify-zero-provider-daytona.mjs';
import { createZeroProviderGateReport } from '../runtime/zero-provider-gate.mjs';
import { canonicalSha256, protocolDocumentHash } from '../runtime/protocol.mjs';
import {
  MAX_ZERO_PROVIDER_DURABLE_EVIDENCE_BYTES,
  serializeZeroProviderDurableEvidence,
} from '../zero-provider-daytona.mjs';
import { createGenuineRuntimeSession } from './support/runtime-session-fixture.mjs';

const HASH = (character) => character.repeat(64);
const RELEASE_SHA = 'a'.repeat(40);
const REPOSITORY = path.resolve('zero-provider-evidence-repository');
const TASK_ID = 'cobol-modernization';
const EXECUTION_MODE = 'zero-provider-canary';

function evidence(releaseSha = RELEASE_SHA) {
  return {
    schema: 'engineer-zero-provider-daytona-evidence.v1',
    operatorTrustModel: 'trusted-local-owner',
    artifactHashSemantics: 'canonical-content-integrity-only',
    runtimeRun: {
      report: {
        bindings: { releaseSha },
      },
    },
  };
}

function validateRuntimeRun(value) {
  assert.equal(value?.report?.bindings?.releaseSha?.length, 40);
  return structuredClone(value);
}

function canonicalArtifactJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalArtifactJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalArtifactJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalArtifactHash(value) {
  return crypto.createHash('sha256').update(canonicalArtifactJson(value)).digest('hex');
}

async function retainedRuntimeRun({ sessionId }) {
  const genuine = await createGenuineRuntimeSession({
    releaseSha: RELEASE_SHA,
    sessionId,
    executionMode: EXECUTION_MODE,
    providerSpendMicrousd: 0,
  });
  const sessionFinalAttestation = genuine.controller.finalize();
  const protocolTrials = genuine.protocolTrials.map((trial) => {
    const payload = Buffer.from(`retained-output-${trial.condition}`);
    return {
      ...trial,
      outputArchiveReceipt: {
        sha256: crypto.createHash('sha256').update(payload).digest('hex'),
        byteLength: payload.length,
      },
    };
  });
  const report = createZeroProviderGateReport({
    releaseSha: RELEASE_SHA,
    snapshotBuildHash: HASH('4'),
    taskLockHash: HASH('1'),
    bundleHash: HASH('2'),
    gateDefinitionHash: HASH('e'),
    profileId: 'economical-small-model',
    taskId: TASK_ID,
    startedAt: '2026-08-04T20:00:00.000Z',
    completedAt: '2026-08-04T20:01:00.000Z',
    trials: protocolTrials.map((trial) => ({
      condition: trial.condition,
      trialId: trial.runtimeRequest.trialId,
      sandboxId: trial.runtimeRequest.bindings.sandboxId,
      sandboxBootId: trial.runtimeRequest.bindings.sandboxBootId,
      readinessLeaseHash: protocolDocumentHash(trial.readinessLease),
      outputArchiveHash: trial.outputArchiveReceipt.sha256,
      trialAttestationHash: protocolDocumentHash(trial.trialAttestation),
      deletionReceiptHash: canonicalSha256(trial.deletionReceipt),
      harborCompleted: true,
      finalEvidenceComplete: true,
      deleted: true,
      absentAfterDelete: true,
      providerAttempts: 0,
      providerCalls: 0,
      providerSpendMicrousd: 0,
      verifierReward: null,
    })),
    sessionFinalAttestationHash: protocolDocumentHash(sessionFinalAttestation),
  });
  const protocolEvidence = {
    schema: 'engineer-zero-provider-daytona-protocol-evidence.v1',
    sessionFinalAttestation,
    trials: protocolTrials,
  };
  const lifecycleHash = canonicalSha256({
    schema: 'engineer-zero-provider-daytona-lifecycle.v1',
    executionMode: EXECUTION_MODE,
    reportHash: report.reportHash,
    sessionFinalAttestationHash: report.sessionFinalAttestationHash,
    trialAttestationHashes: report.trials.map(({ trialAttestationHash }) => trialAttestationHash),
    deletionReceiptHashes: report.trials.map(({ deletionReceiptHash }) => deletionReceiptHash),
    readinessLeaseHashes: report.trials.map(({ readinessLeaseHash }) => readinessLeaseHash),
    outputArchiveHashes: protocolTrials.map(({ outputArchiveReceipt }) => outputArchiveReceipt.sha256),
  });
  const unsigned = {
    schema: 'engineer-zero-provider-daytona-run.v1',
    executionMode: EXECUTION_MODE,
    evidenceClass: 'infrastructure-validation',
    releaseEligible: false,
    authenticationScope: 'in-process-hmac-validated',
    standaloneSignatureVerifiable: false,
    report,
    protocolEvidence,
    lifecycleHash,
  };
  return { ...unsigned, artifactHash: canonicalArtifactHash(unsigned) };
}

function completeEvidence(runtimeRun) {
  return {
    schema: 'engineer-zero-provider-daytona-evidence.v1',
    operatorTrustModel: 'trusted-local-owner',
    artifactHashSemantics: 'canonical-content-integrity-only',
    runtimeRun,
  };
}

function productionVerifierDependencies(value) {
  return {
    releaseRepository: () => REPOSITORY,
    currentGitReleaseSha: () => RELEASE_SHA,
    assertCleanLiveReleaseSource: () => {},
    readPrivateEvidenceFile: () => serializeZeroProviderDurableEvidence(value),
  };
}

test('zero-provider durable evidence exposes one canonical byte contract', () => {
  const value = evidence();
  const bytes = serializeZeroProviderDurableEvidence(value);
  try {
    assert.equal(MAX_ZERO_PROVIDER_DURABLE_EVIDENCE_BYTES, 8 * 1024 * 1024);
    assert.deepEqual(bytes, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  } finally {
    bytes.fill(0);
  }
});

test('zero-provider evidence path is private-state scoped and commit-specific', () => {
  assert.equal(
    zeroProviderEvidencePath(REPOSITORY, RELEASE_SHA),
    path.join(REPOSITORY, '.harness', 'private-evidence', `zero-provider-daytona-${RELEASE_SHA}.json`),
  );
  assert.throws(() => zeroProviderEvidencePath(REPOSITORY, '../escape'), /release SHA/i);
});

test('zero-provider evidence validation binds the complete durable envelope to current HEAD', () => {
  const validated = validateZeroProviderEvidenceForCommit(evidence(), {
    releaseSha: RELEASE_SHA,
    validateRuntimeRun,
  });
  assert.equal(validated.runtimeRun.report.bindings.releaseSha, RELEASE_SHA);

  assert.throws(
    () => validateZeroProviderEvidenceForCommit(evidence('b'.repeat(40)), {
      releaseSha: RELEASE_SHA,
      validateRuntimeRun,
    }),
    /current git HEAD/i,
  );
});

test('configured check rejects a complete artifact-hash transplant with its production validator', async () => {
  const donorRun = await retainedRuntimeRun({ sessionId: 'evidence-hash-donor' });
  const recipientRun = await retainedRuntimeRun({ sessionId: 'evidence-hash-recipient' });
  const donorEvidence = completeEvidence(donorRun);
  const recipientEvidence = completeEvidence(recipientRun);

  assert.equal(runZeroProviderEvidenceCheck({
    stdout: () => {},
    dependencies: productionVerifierDependencies(donorEvidence),
  }).exitCode, 0);
  assert.equal(runZeroProviderEvidenceCheck({
    stdout: () => {},
    dependencies: productionVerifierDependencies(recipientEvidence),
  }).exitCode, 0);
  assert.notEqual(donorRun.artifactHash, recipientRun.artifactHash);

  const tamperedEvidence = completeEvidence({
    ...recipientRun,
    artifactHash: donorRun.artifactHash,
  });
  assert.throws(
    () => runZeroProviderEvidenceCheck({
      stdout: () => {},
      dependencies: productionVerifierDependencies(tamperedEvidence),
    }),
    /retained artifact hash drifted/i,
  );
});

test('configured check reads only the commit-specific owner-private artifact and emits content-free evidence', () => {
  const expectedPath = zeroProviderEvidencePath(REPOSITORY, RELEASE_SHA);
  const bytes = Buffer.from(`${JSON.stringify(evidence(), null, 2)}\n`);
  const output = [];
  const calls = [];
  let observedRead;

  const result = runZeroProviderEvidenceCheck({
    stdout: (line) => output.push(line),
    dependencies: {
      releaseRepository: () => {
        calls.push('repository');
        return REPOSITORY;
      },
      currentGitReleaseSha: () => {
        calls.push('head');
        return RELEASE_SHA;
      },
      assertCleanLiveReleaseSource: () => calls.push('clean'),
      readPrivateEvidenceFile: (file, label, limits) => {
        calls.push('read');
        observedRead = { file, label, limits };
        return Buffer.from(bytes);
      },
      validateRuntimeRun,
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ['repository', 'head', 'clean', 'read']);
  assert.equal(result.reportFile, expectedPath);
  assert.deepEqual(observedRead, {
    file: expectedPath,
    label: 'zero-provider Daytona evidence',
    limits: { maximumBytes: MAX_ZERO_PROVIDER_DURABLE_EVIDENCE_BYTES },
  });
  assert.equal(output.length, 1);
  assert.match(output[0], /^zero-provider Daytona evidence passed for [a-f0-9]{40}; sha256:[a-f0-9]{64}$/);
  assert.equal(output[0].includes('runtimeRun'), false);
});

test('configured check rejects dirty source before reading retained evidence', () => {
  for (const sourceState of ['modified', 'staged', 'untracked']) {
    let evidenceRead = false;
    assert.throws(
      () => runZeroProviderEvidenceCheck({
        dependencies: {
          releaseRepository: () => REPOSITORY,
          currentGitReleaseSha: () => RELEASE_SHA,
          assertCleanLiveReleaseSource: () => {
            throw new Error(`live release evaluation requires a clean git working tree: ${sourceState}`);
          },
          readPrivateEvidenceFile: () => {
            evidenceRead = true;
            return Buffer.from(`${JSON.stringify(evidence(), null, 2)}\n`);
          },
          validateRuntimeRun,
        },
      }),
      /clean git working tree/i,
      sourceState,
    );
    assert.equal(evidenceRead, false, `${sourceState} source must be rejected before evidence is read`);
  }
});

test('configured check rejects malformed JSON and noncanonical durable bytes', () => {
  const base = {
    releaseRepository: () => REPOSITORY,
    currentGitReleaseSha: () => RELEASE_SHA,
    assertCleanLiveReleaseSource: () => {},
    validateRuntimeRun,
  };

  assert.throws(
    () => runZeroProviderEvidenceCheck({
      dependencies: {
        ...base,
        readPrivateEvidenceFile: () => Buffer.from('{'),
      },
    }),
    /valid JSON/i,
  );

  assert.throws(
    () => runZeroProviderEvidenceCheck({
      dependencies: {
        ...base,
        readPrivateEvidenceFile: () => Buffer.from(JSON.stringify(evidence())),
      },
    }),
    /canonical durable writer/i,
  );
});

test('CLI accepts no arguments and maps verifier errors to exit 2', () => {
  const bytes = Buffer.from(`${JSON.stringify(evidence(), null, 2)}\n`);
  const stdout = [];
  const stderr = [];
  const success = runZeroProviderEvidenceCli({
    argv: [],
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    dependencies: {
      releaseRepository: () => REPOSITORY,
      currentGitReleaseSha: () => RELEASE_SHA,
      assertCleanLiveReleaseSource: () => {},
      readPrivateEvidenceFile: () => Buffer.from(bytes),
      validateRuntimeRun,
    },
  });
  assert.equal(success.exitCode, 0);
  assert.equal(stdout.length, 1);
  assert.deepEqual(stderr, []);

  const failure = runZeroProviderEvidenceCli({
    argv: [],
    stderr: (line) => stderr.push(line),
    dependencies: {
      releaseRepository: () => {
        throw new Error('expected verifier failure');
      },
    },
  });
  assert.equal(failure.exitCode, 2);
  assert.match(stderr.at(-1), /expected verifier failure/i);
});

test('direct CLI rejects every argument before verifier work', () => {
  let verifierTouched = false;
  const stderr = [];
  const result = runZeroProviderEvidenceCli({
    argv: ['--report-file', path.resolve('unexpected.json')],
    stderr: (line) => stderr.push(line),
    dependencies: {
      releaseRepository: () => {
        verifierTouched = true;
        return REPOSITORY;
      },
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(verifierTouched, false);
  assert.match(stderr.join('\n'), /accepts no arguments/i);

  const script = fileURLToPath(new URL('../verify-zero-provider-daytona.mjs', import.meta.url));
  const subprocess = spawnSync(process.execPath, [script, '--unexpected'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(subprocess.status, 2, subprocess.stderr || subprocess.stdout);
  assert.match(subprocess.stderr, /accepts no arguments/i);
  assert.equal(subprocess.stdout, '');
});
