import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { canonicalSha256, protocolDocumentHash } from '../runtime/protocol.mjs';
import {
  isZeroProviderDaytonaRun,
  runZeroProviderDaytonaGate,
  validateZeroProviderDaytonaRun,
  writeZeroProviderDaytonaRun,
} from '../runtime/zero-provider-daytona.mjs';
import {
  createZeroProviderGateReport,
  validateZeroProviderGateReport,
} from '../runtime/zero-provider-gate.mjs';
import { createGenuineRuntimeSession } from './support/runtime-session-fixture.mjs';

const HASH = (character) => character.repeat(64);
const RELEASE_SHA = 'a'.repeat(40);
const TASK_ID = 'cobol-modernization';
const MANIFEST_DIGEST = `sha256:${HASH('6')}`;
const IMAGE_ID = `sha256:${HASH('7')}`;
const EXECUTION_MODE = 'zero-provider-canary';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-provider-daytona-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const datasetPath = path.join(root, 'dataset');
  const bundleDir = path.join(root, 'bundle');
  const workRoot = path.join(root, 'work');
  for (const directory of [datasetPath, bundleDir, workRoot]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  const taskLock = {
    schema: 'terminal-bench-task-lock.v1',
    datasetRef: 'terminal-bench@v0.1.1',
    tasks: [{
      task: TASK_ID,
      sandbox: {
        immutableImage: `example.invalid/cobol@${MANIFEST_DIGEST}`,
        imageId: IMAGE_ID,
        platform: 'linux/amd64',
        cpus: 1,
        memoryMb: 2048,
        storageMb: 10240,
      },
    }],
  };
  const bundle = { bundleDir, manifestHash: HASH('2') };
  const runtimeProjection = {
    schema: 'engineer-daytona-release-runtime-projection.v1',
    topologyManifest: {
      schema: 'engineer-daytona-topology-manifest.v1',
      hash: HASH('0'),
    },
    snapshot: {
      name: 'engineer-eval-44444444444444444444444444444444',
      buildHash: HASH('4'),
    },
    bindings: {
      releaseSha: RELEASE_SHA,
      taskLockHash: canonicalSha256(taskLock),
      bundleHash: bundle.manifestHash,
      budgetPolicyHash: HASH('3'),
      brokerPolicyHash: HASH('5'),
      profileId: 'kimi-k2.7-code',
      sessionCeilingMicrousd: 1_300_000,
    },
    executables: {
      supervisor: { path: '/opt/engineer/bin/engineer-runtime-supervisor', sha256: HASH('7') },
      runner: { path: '/opt/engineer/bin/engineer-eval-runner', sha256: HASH('8') },
      harbor: { path: '/opt/engineer/bin/harbor', sha256: HASH('9') },
      imageProvisioner: { path: '/opt/engineer/bin/engineer-task-image-provision', sha256: HASH('b') },
    },
    taskImages: {
      [TASK_ID]: { ...taskLock.tasks[0].sandbox },
    },
  };
  return { root, datasetPath, bundle, workRoot, taskLock, runtimeProjection };
}

function fakeComponents({
  providerAttempts = 0,
  providerSpendMicrousd = 0,
  capturedTaskLockOk = true,
} = {}) {
  const calls = [];
  const archiveBuffers = [];
  const outputBuffers = [];
  const deletedSandboxes = [];
  let daytonaOptions;
  let trialTransportOptions;
  let sessionOptions;
  let transportDisposed = false;
  let sessionDisposed = false;

  const daytonaTransport = {
    async runRemote(input) {
      calls.push(['provision-image', structuredClone(input)]);
      return {
        schema: 'engineer-daytona-command-receipt.v1',
        exitCode: 0,
        stdoutBytes: 0,
        stdoutSha256: HASH('0'),
        stderrBytes: 0,
        stderrSha256: HASH('0'),
      };
    },
    async dispose() { transportDisposed = true; },
  };
  const daytonaController = {
    snapshot() { return { activeTrial: null, receipts: [] }; },
  };
  const trialTransport = {
    async executeTrial({ handle, authorization }) {
      assert.equal(authorization.executionMode, EXECUTION_MODE);
      assert.equal(authorization.providerAuthorized, false);
      const archive = await trialTransportOptions.taskInputArchive({
        allocation: { id: handle.request.bindings.sandboxId },
        provisioning: {},
        spec: handle.spec,
      });
      archive.fill(0);
      const secrets = await trialTransportOptions.takeTrialSecrets({
        sessionId: trialTransportOptions.sessionId,
        trialId: handle.spec.trialId,
        allocationId: handle.request.bindings.sandboxId,
      });
      calls.push(['secret-shape', Object.keys(secrets).sort()]);
      assert.deepEqual(Object.keys(secrets), ['hmacKey']);
      secrets.hmacKey.fill(0);
      const bytes = Buffer.from(`output:${handle.spec.condition}`);
      outputBuffers.push(bytes);
      return {
        outputArchive: {
          bytes,
          byteLength: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
      };
    },
  };
  const sessionController = {
    async runTrial(spec, execute) {
      calls.push(['run-trial', structuredClone(spec)]);
      const sequence = calls.filter(([name]) => name === 'run-trial').length;
      const sandboxId = `sandbox-${spec.condition}-${sequence}`;
      const sandboxBootId = `boot-${spec.condition}-${sequence}`;
      await daytonaOptions.provisionTrial({
        allocation: { id: sandboxId },
        trial: {
          trialId: spec.trialId,
          task: spec.taskId,
          condition: spec.condition,
          reservedUsd: 0,
          sequence,
        },
      });
      const request = {
        schema: 'engineer-runtime-trial-request.v1',
        sessionId: sessionOptions.session.sessionId,
        trialId: spec.trialId,
        executionMode: EXECUTION_MODE,
        bindings: { condition: spec.condition, sandboxId, sandboxBootId },
      };
      const readinessLease = {
        schema: 'engineer-runtime-readiness-lease.v1',
        sessionId: request.sessionId,
        trialId: spec.trialId,
        executionMode: EXECUTION_MODE,
      };
      const handle = { spec, request };
      try {
        const result = await execute({
          handle,
          authorization: {
            executionMode: EXECUTION_MODE,
            providerAuthorized: false,
            readinessLease,
          },
        });
        const attestation = {
          schema: 'engineer-runtime-trial-final-attestation.v1',
          sessionId: request.sessionId,
          trialId: spec.trialId,
          executionMode: EXECUTION_MODE,
          bindings: { condition: spec.condition, sandboxId, sandboxBootId },
          outcome: { providerSpendMicrousd },
        };
        const deletionReceipt = {
          trialId: spec.trialId,
          sandboxId,
          deletionRequestedAt: '2026-08-04T20:00:02.000Z',
          observedAbsentAt: '2026-08-04T20:00:03.000Z',
          platformEvidenceHash: HASH(sequence === 1 ? 'c' : 'd'),
        };
        deletedSandboxes.push(sandboxId);
        return {
          result,
          attestation,
          deletionReceipt,
          chainEntry: { deletionReceiptHash: canonicalSha256(deletionReceipt) },
        };
      } catch (error) {
        deletedSandboxes.push(sandboxId);
        throw error;
      }
    },
    finalize() {
      return {
        schema: 'engineer-runtime-session-final-attestation.v1',
        sessionId: sessionOptions.session.sessionId,
        sessionBindings: {
          profileId: sessionOptions.session.profileId,
          executionMode: EXECUTION_MODE,
        },
        budget: {
          sessionCeilingMicrousd: 0,
          sessionCommittedMicrousd: 0,
          sessionSpentMicrousd: 0,
        },
      };
    },
    snapshot() {
      return {
        executionMode: EXECUTION_MODE,
        sessionCeilingMicrousd: 0,
        committedMicrousd: 0,
        spentMicrousd: 0,
        finalized: true,
      };
    },
    async dispose() { sessionDisposed = true; },
  };

  return {
    calls,
    archiveBuffers,
    outputBuffers,
    deletedSandboxes,
    get disposed() { return { transportDisposed, sessionDisposed }; },
    components: {
      buildZeroProviderCanaryTrialRequest(input) {
        calls.push(['build-request', input.condition, input.trialId, input.workDir]);
        return {
          trial: {
            trialId: input.trialId,
            task: input.taskId,
            condition: input.condition,
            executionMode: EXECUTION_MODE,
            identity: { gate: 'zero-provider-daytona', condition: input.condition },
            ceilingUsd: 0,
            profileId: 'zero-provider-canary',
          },
          harbor: {
            executable: '/opt/engineer/controller/harbor',
            args: [],
            cwd: input.workDir,
            timeoutMs: 60_000,
            spawnEnv: { LANG: 'C.UTF-8' },
          },
        };
      },
      createDaytonaTransport(options) {
        calls.push(['create-transport', { daytonaPath: options.daytonaPath }]);
        return daytonaTransport;
      },
      createDaytonaSessionController(options) {
        daytonaOptions = options;
        calls.push(['create-daytona', {
          executionMode: options.executionMode,
          sessionBudgetUsd: options.sessionBudgetUsd,
        }]);
        return daytonaController;
      },
      createRuntimeTrialTransport(options) {
        trialTransportOptions = options;
        calls.push(['create-trial-transport', { executionMode: options.executionMode }]);
        return trialTransport;
      },
      createRuntimeSessionController(options) {
        sessionOptions = options;
        calls.push(['create-session', structuredClone(options.session)]);
        return sessionController;
      },
      createTrialInputArchive(request) {
        calls.push(['create-archive', request.trial.condition]);
        const bytes = Buffer.from(`archive:${request.trial.condition}`);
        archiveBuffers.push(bytes);
        return {
          bytes,
          manifest: {
            kind: 'task-input',
            encoding: 'tar+gzip',
            byteLength: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          },
          materialization: {
            schema: 'engineer-trial-output-materialization.v1',
            trialId: request.trial.trialId,
          },
        };
      },
      verifyTaskAgainstLock() {
        calls.push(['verify-captured-task']);
        return capturedTaskLockOk
          ? { ok: true, reason: '', checksum: HASH('a') }
          : { ok: false, reason: 'task checksum drifted', checksum: HASH('b') };
      },
      applyTrialOutputArchive(input) {
        calls.push(['apply-output', input.materialization.trialId]);
        return {
          code: 0,
          signal: null,
          timedOut: false,
          spawnError: null,
          containmentComplete: true,
        };
      },
      inspectMaterializedEvidence({ run }) {
        return {
          harborCompleted: run.code === 0,
          providerAttempts,
          providerCalls: 0,
          verifierReward: null,
        };
      },
      trialEvidenceHash: canonicalSha256,
    },
  };
}

function randomBytes(size) {
  return Buffer.alloc(size, size === 32 ? 0x41 : 0x42);
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

async function retainedRuntimeRun({ sessionId = 'retained-zero-provider-run' } = {}) {
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

function input(t, fake) {
  const fx = fixture(t);
  return {
    taskLock: fx.taskLock,
    bundle: fx.bundle,
    datasetPath: fx.datasetPath,
    workRoot: fx.workRoot,
    runtimeProjection: fx.runtimeProjection,
    gateDefinitionHash: HASH('e'),
    releaseSha: RELEASE_SHA,
    taskId: TASK_ID,
    daytonaPath: '/opt/daytona',
    env: { PATH: '/usr/bin:/bin', DAYTONA_API_KEY: 'controller-login-only' },
    now: (() => {
      let milliseconds = Date.parse('2026-08-04T20:00:00.000Z');
      return () => new Date(milliseconds++);
    })(),
    randomBytes,
    components: fake.components,
  };
}

test('runs exact generic then harness zero-provider sandboxes and returns report-grade evidence', async (t) => {
  const fake = fakeComponents();
  const result = await runZeroProviderDaytonaGate(input(t, fake));

  assert.equal(result.schema, 'engineer-zero-provider-daytona-run.v1');
  assert.equal(result.executionMode, EXECUTION_MODE);
  assert.deepEqual(fake.calls.filter(([name]) => name === 'build-request').map((call) => call[1]), [
    'generic',
    'harness',
  ]);
  assert.deepEqual(fake.calls.find(([name]) => name === 'create-daytona')[1], {
    executionMode: EXECUTION_MODE,
    sessionBudgetUsd: 0,
  });
  const signedSession = fake.calls.find(([name]) => name === 'create-session')[1];
  assert.equal(signedSession.executionMode, EXECUTION_MODE);
  assert.equal(signedSession.sessionCeilingMicrousd, 0);
  assert.equal(signedSession.profileId, 'kimi-k2.7-code');
  assert.equal(signedSession.taskLockHash, result.report.bindings.taskLockHash);
  assert.ok(fake.calls.filter(([name]) => name === 'secret-shape')
    .every(([, fields]) => JSON.stringify(fields) === JSON.stringify(['hmacKey'])));
  assert.deepEqual(fake.calls.filter(([name]) => name === 'run-trial').map(([, spec]) => [
    spec.condition,
    spec.trialCeilingMicrousd,
  ]), [['generic', 0], ['harness', 0]]);
  assert.equal(new Set(fake.deletedSandboxes).size, 2);
  assert.deepEqual(fake.disposed, { transportDisposed: true, sessionDisposed: true });
  assert.ok(fake.archiveBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
  assert.ok(fake.outputBuffers.every((bytes) => bytes.every((byte) => byte === 0)));

  assert.equal(result.report.bindings.profileId, 'kimi-k2.7-code');
  assert.deepEqual(result.report.trials.map(({ condition }) => condition), ['generic', 'harness']);
  assert.ok(result.report.trials.every((trial) =>
    trial.providerAttempts === 0
      && trial.providerCalls === 0
      && trial.providerSpendMicrousd === 0
      && trial.deleted === true
      && trial.absentAfterDelete === true));
  assert.deepEqual(validateZeroProviderGateReport(result.report), result.report);
  assert.equal(result.protocolEvidence.sessionFinalAttestation.budget.sessionSpentMicrousd, 0);
  assert.equal(result.protocolEvidence.trials.length, 2);
  assert.match(result.lifecycleHash, /^[a-f0-9]{64}$/);
  assert.match(result.artifactHash, /^[a-f0-9]{64}$/);
  assert.equal(result.authenticationScope, 'in-process-hmac-validated');
  assert.equal(result.standaloneSignatureVerifiable, false);
  assert.equal(isZeroProviderDaytonaRun(result), false,
    'component-injected unit fixtures must not mint a production publication capability');
});

test('production publication capability excludes component, clock, and entropy injection seams', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../runtime/zero-provider-daytona.mjs'),
    'utf8',
  );
  assert.match(source, /!Object\.hasOwn\(input, 'components'\)/);
  assert.match(source, /!Object\.hasOwn\(input, 'now'\)/);
  assert.match(source, /!Object\.hasOwn\(input, 'randomBytes'\)/);
  assert.match(source, /if \(productionComposition\) zeroProviderRunBrand\.add\(result\)/);
});

test('validates a complete retained protocol chain and refuses to publish an unbranded reconstruction', async (t) => {
  const reconstructed = await retainedRuntimeRun();

  assert.deepEqual(validateZeroProviderDaytonaRun(reconstructed), reconstructed);
  assert.equal(isZeroProviderDaytonaRun(reconstructed), false);
  const destination = path.join(fixture(t).root, 'untrusted-run.json');
  assert.throws(
    () => writeZeroProviderDaytonaRun({ destination, run: reconstructed }),
    /in-process|capability|publication/i,
  );
});

test('rejects an artifact hash transplanted between independently valid retained runs', async () => {
  const donor = await retainedRuntimeRun({ sessionId: 'artifact-hash-donor' });
  const recipient = await retainedRuntimeRun({ sessionId: 'artifact-hash-recipient' });

  assert.deepEqual(validateZeroProviderDaytonaRun(donor), donor);
  assert.deepEqual(validateZeroProviderDaytonaRun(recipient), recipient);
  assert.notEqual(donor.artifactHash, recipient.artifactHash);

  assert.throws(
    () => validateZeroProviderDaytonaRun({
      ...recipient,
      artifactHash: donor.artifactHash,
    }),
    /retained artifact hash drifted/i,
  );
});

test('fails closed on provider drift and still disposes the created sandbox', async (t) => {
  const fake = fakeComponents({ providerAttempts: 1 });
  await assert.rejects(
    runZeroProviderDaytonaGate(input(t, fake)),
    /provider.*zero|provider activity|zero-provider/i,
  );
  assert.deepEqual(fake.deletedSandboxes, ['sandbox-generic-1']);
  assert.deepEqual(fake.disposed, { transportDisposed: true, sessionDisposed: true });
});

test('an execution failure retries transient runtime disposal exactly once without publishing success', async (t) => {
  const fake = fakeComponents();
  const createSession = fake.components.createRuntimeSessionController;
  const createTransport = fake.components.createDaytonaTransport;
  let sessionDisposals = 0;
  let transportDisposals = 0;
  fake.components.createRuntimeSessionController = (options) => {
    const controller = createSession(options);
    return {
      ...controller,
      async runTrial() {
        throw new Error('primary zero-provider execution failure');
      },
      async dispose() {
        sessionDisposals += 1;
        if (sessionDisposals === 1) throw new Error('transient session cleanup failure');
        return controller.dispose();
      },
    };
  };
  fake.components.createDaytonaTransport = (options) => {
    const transport = createTransport(options);
    return {
      ...transport,
      async dispose() {
        transportDisposals += 1;
        return transport.dispose();
      },
    };
  };

  await assert.rejects(
    runZeroProviderDaytonaGate(input(t, fake)),
    (error) => {
      assert.equal(error.code, 'ERR_ZERO_PROVIDER_DAYTONA_EXECUTION');
      assert.match(error.message, /primary zero-provider execution failure/i);
      assert.doesNotMatch(error.message, /transient session cleanup failure/i);
      return true;
    },
  );

  assert.equal(sessionDisposals, 2);
  assert.equal(transportDisposals, 2);
  assert.deepEqual(fake.disposed, { transportDisposed: true, sessionDisposed: true });
  assert.ok(fake.archiveBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
});

test('an execution failure remains fail-closed after two unsuccessful disposal attempts', async (t) => {
  const fake = fakeComponents();
  const createSession = fake.components.createRuntimeSessionController;
  const createTransport = fake.components.createDaytonaTransport;
  let sessionDisposals = 0;
  let transportDisposals = 0;
  fake.components.createRuntimeSessionController = (options) => {
    const controller = createSession(options);
    return {
      ...controller,
      async runTrial() {
        throw new Error('persistent-path primary execution failure');
      },
      async dispose() {
        sessionDisposals += 1;
        throw new Error('secret-shaped dependency cleanup detail');
      },
    };
  };
  fake.components.createDaytonaTransport = (options) => {
    const transport = createTransport(options);
    return {
      ...transport,
      async dispose() {
        transportDisposals += 1;
        return transport.dispose();
      },
    };
  };

  await assert.rejects(
    runZeroProviderDaytonaGate(input(t, fake)),
    (error) => {
      assert.equal(error.code, 'ERR_ZERO_PROVIDER_DAYTONA_CLEANUP');
      assert.match(error.message, /persistent-path primary execution failure/i);
      assert.match(error.message, /runtime disposal was incomplete/i);
      assert.equal(error.message.includes('secret-shaped dependency cleanup detail'), false);
      return true;
    },
  );

  assert.equal(sessionDisposals, 2);
  assert.equal(transportDisposals, 2);
  assert.deepEqual(fake.disposed, { transportDisposed: true, sessionDisposed: false });
  assert.ok(fake.archiveBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
});

test('rejects ambient provider credentials and operator-supplied trial routes before cloud effects', async (t) => {
  const fake = fakeComponents();
  const base = input(t, fake);
  await assert.rejects(
    runZeroProviderDaytonaGate({
      ...base,
      env: { ...base.env, OPENROUTER_API_KEY: 'forbidden' },
    }),
    /ambient|provider credential|OPENROUTER/i,
  );
  await assert.rejects(
    runZeroProviderDaytonaGate({ ...base, trials: [] }),
    /unexpected|operator|trial/i,
  );
  assert.equal(fake.calls.length, 0);
});

test('rejects nonzero signed spend after deletion and never emits a gate report', async (t) => {
  const fake = fakeComponents({ providerSpendMicrousd: 1 });
  await assert.rejects(
    runZeroProviderDaytonaGate(input(t, fake)),
    /provider spend|spend.*zero|zero-provider/i,
  );
  assert.deepEqual(fake.deletedSandboxes, ['sandbox-generic-1']);
  assert.deepEqual(fake.disposed, { transportDisposed: true, sessionDisposed: true });
});

test('rejects task-tree drift after archive capture before creating any cloud transport', async (t) => {
  const fake = fakeComponents({ capturedTaskLockOk: false });
  await assert.rejects(
    runZeroProviderDaytonaGate(input(t, fake)),
    /captured.*archive|task lock|checksum/i,
  );
  assert.equal(fake.calls.some(([name]) => name === 'create-transport'), false);
  assert.ok(fake.archiveBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
});
