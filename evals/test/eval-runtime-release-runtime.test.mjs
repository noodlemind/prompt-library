import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { canonicalSha256 } from '../runtime/protocol.mjs';
import { createReleaseRuntime } from '../runtime/release-runtime.mjs';

const HASH = (character) => character.repeat(64);
const RELEASE_SHA = 'a'.repeat(40);
const TASK_ID = 'cobol-modernization';
const MANIFEST_DIGEST = `sha256:${HASH('6')}`;
const IMMUTABLE_IMAGE = `example.invalid/cobol-modernization@${MANIFEST_DIGEST}`;
const IMAGE_ID = `sha256:${HASH('7')}`;
const TASK_IMAGE = Object.freeze({
  immutableImage: IMMUTABLE_IMAGE,
  imageId: IMAGE_ID,
  platform: 'linux/amd64',
  cpus: 1,
  memoryMb: 2048,
  storageMb: 10240,
});

function fixture() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-runtime-'));
  const bundleDir = path.join(workDir, 'bundle');
  fs.mkdirSync(bundleDir);
  const taskLock = {
    schema: 'terminal-bench-task-lock.v1',
    datasetRef: 'terminal-bench@v0.1.1',
    tasks: [{ task: TASK_ID, sandbox: { ...TASK_IMAGE } }],
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
      brokerPolicyHash: HASH('a'),
      profileId: 'economical-small-model',
      sessionCeilingMicrousd: 1_300_000,
    },
    executables: {
      supervisor: {
        path: '/opt/engineer/bin/engineer-runtime-supervisor',
        sha256: HASH('7'),
      },
      runner: {
        path: '/opt/engineer/bin/engineer-eval-runner',
        sha256: HASH('8'),
      },
      harbor: {
        path: '/opt/engineer/bin/harbor',
        sha256: HASH('9'),
      },
      imageProvisioner: {
        path: '/opt/engineer/bin/engineer-task-image-provision',
        sha256: HASH('5'),
      },
    },
    taskImages: { [TASK_ID]: { ...TASK_IMAGE } },
  };
  return { workDir, bundle, taskLock, runtimeProjection };
}

function fakeComponents({ sessionDisposeFailures = 0, transportDisposeFailures = 0 } = {}) {
  const calls = [];
  const issued = [];
  const archiveBuffers = [];
  const outputBuffers = [];
  let custodianDisposed = false;
  let transportDisposed = false;
  let sessionDisposed = false;
  let preflightCalls = 0;
  let postflightCalls = 0;
  let sessionDisposeCalls = 0;
  let transportDisposeCalls = 0;
  let trialTransportOptions;
  let daytonaControllerOptions;

  const custodian = {
    keyFingerprint: () => HASH('f'),
    async preflight() {
      preflightCalls += 1;
      return {
        schema: 'engineer-openrouter-key-metadata.v1',
        phase: 'preflight',
        checkedAt: '2026-08-04T20:00:00.000Z',
        limitMicrousd: 20_000_000,
        limitRemainingMicrousd: 20_000_000,
        reset: null,
      };
    },
    issueTrialCredential(trialId) {
      issued.push(trialId);
      return Buffer.from('one-shot-provider-key');
    },
    async postflight({ sessionSpentMicrousd }) {
      postflightCalls += 1;
      calls.push(['postflight', sessionSpentMicrousd]);
      return {
        schema: 'engineer-openrouter-allowance-reconciliation.v1',
        verified: true,
        preflightRemainingMicrousd: 20_000_000,
        postflightRemainingMicrousd: 19_900_000,
        observedAllowanceDeltaMicrousd: 100_000,
        sessionSpentMicrousd,
        differenceMicrousd: 0,
        toleranceMicrousd: 2,
      };
    },
    snapshot() {
      return {
        schema: 'engineer-provider-credential-custodian-snapshot.v1',
        state: custodianDisposed ? 'disposed' : postflightCalls ? 'reconciled' : 'ready',
        releaseSha: RELEASE_SHA,
        keyFingerprint: HASH('f'),
        keyMaterialDisposed: custodianDisposed,
        issuedTrialCount: issued.length,
        preflight: preflightCalls ? { limitRemainingMicrousd: 20_000_000 } : null,
        postflight: postflightCalls ? { limitRemainingMicrousd: 19_900_000 } : null,
        reconciliation: postflightCalls ? { verified: true, sessionSpentMicrousd: 100_000 } : null,
      };
    },
    dispose() { custodianDisposed = true; },
  };

  const daytonaTransport = {
    async runRemote(input) {
      calls.push(['run-remote', structuredClone(input)]);
      return {
        schema: 'engineer-daytona-command-receipt.v1',
        exitCode: 0,
        stdoutBytes: 0,
        stdoutSha256: HASH('0'),
        stderrBytes: 0,
        stderrSha256: HASH('0'),
      };
    },
    async dispose() {
      transportDisposeCalls += 1;
      if (transportDisposeCalls <= transportDisposeFailures) {
        throw new Error('transient transport disposal failure');
      }
      transportDisposed = true;
    },
  };
  const daytonaController = {
    snapshot: () => ({ activeTrial: null, receipts: [] }),
  };
  const trialTransport = {
    async executeTrial({ handle, authorization }) {
      const archive = await trialTransportOptions.taskInputArchive({
        allocation: { id: 'sandbox-1' },
        provisioning: {},
        spec: handle.spec,
      });
      calls.push(['archive-consumed', crypto.createHash('sha256').update(archive).digest('hex')]);
      archive.fill(0);
      const secrets = await trialTransportOptions.takeTrialSecrets({
        sessionId: trialTransportOptions.sessionId,
        trialId: handle.spec.trialId,
        allocationId: 'sandbox-1',
      });
      calls.push(['secret-handoff', secrets.hmacKey.length, secrets.providerKey.length, authorization.ok]);
      secrets.hmacKey.fill(0);
      secrets.providerKey.fill(0);
      const bytes = Buffer.from('trusted-output-archive');
      outputBuffers.push(bytes);
      return {
        outputArchive: {
          bytes,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          byteLength: bytes.length,
        },
      };
    },
  };
  const sessionController = {
    readiness: () => ({
      schema: 'engineer-runtime-controller-readiness.v1',
      source: 'external-controller',
      sessionId: 'release-session-test',
      releaseSha: RELEASE_SHA,
    }),
    async runTrial(spec, execute) {
      calls.push(['runTrial', structuredClone(spec)]);
      await daytonaControllerOptions.provisionTrial({
        allocation: { id: 'sandbox-1' },
        trial: {
          trialId: spec.trialId,
          task: spec.taskId,
          condition: spec.condition,
          reservedUsd: spec.trialCeilingMicrousd / 1_000_000,
          sequence: 1,
        },
      });
      const result = await execute({ handle: { spec }, authorization: { ok: true } });
      return {
        result,
        attestation: {
          schema: 'engineer-runtime-trial-final-attestation.v1',
          sessionId: 'release-session-test',
          trialId: spec.trialId,
          evidence: HASH('e'),
          outcome: { providerSpendMicrousd: 100_000 },
        },
      };
    },
    finalize() {
      calls.push(['session-finalize']);
      return {
        schema: 'engineer-runtime-session-final-attestation.v1',
        sessionId: 'release-session-test',
        budget: { sessionSpentMicrousd: 100_000 },
      };
    },
    snapshot: () => ({ schema: 'engineer-runtime-session-snapshot.v1', disposed: sessionDisposed }),
    async dispose() {
      sessionDisposeCalls += 1;
      if (sessionDisposeCalls <= sessionDisposeFailures) {
        throw new Error('transient session disposal failure');
      }
      sessionDisposed = true;
    },
  };

  return {
    calls,
    issued,
    archiveBuffers,
    outputBuffers,
    get preflightCalls() { return preflightCalls; },
    get postflightCalls() { return postflightCalls; },
    get disposalCalls() { return { sessionDisposeCalls, transportDisposeCalls }; },
    get disposed() { return { custodianDisposed, transportDisposed, sessionDisposed }; },
    components: {
      createProviderCredentialCustodian(options) {
        calls.push(['custodian', { keyFd: options.keyFd, releaseSha: options.releaseSha }]);
        return custodian;
      },
      createDaytonaTransport(options) {
        calls.push(['daytona-transport', { daytonaPath: options.daytonaPath }]);
        return daytonaTransport;
      },
      createDaytonaSessionController(options) {
        daytonaControllerOptions = options;
        calls.push(['daytona-controller', {
          snapshot: options.snapshot,
          releaseSha: options.releaseSha,
          executionMode: options.executionMode,
          sessionBudgetUsd: options.sessionBudgetUsd,
        }]);
        return daytonaController;
      },
      createRuntimeTrialTransport(options) {
        trialTransportOptions = options;
        calls.push(['trial-transport', {
          sessionId: options.sessionId,
          executionMode: options.executionMode,
        }]);
        return trialTransport;
      },
      createRuntimeSessionController(options) {
        assert.equal(options.controllerKey.equals(options.supervisorKey), true);
        calls.push(['session-controller', {
          session: structuredClone(options.session),
          keyLength: options.controllerKey.length,
        }]);
        return sessionController;
      },
      createTrialInputArchive(request) {
        calls.push(['create-archive', structuredClone(request.trial)]);
        const bytes = Buffer.from(`archive:${request.trial.trialId}`);
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
      applyTrialOutputArchive(options) {
        calls.push(['apply-output', {
          sha256: options.expectedSha256,
          byteLength: options.expectedByteLength,
          trialId: options.materialization.trialId,
        }]);
        return {
          code: 0,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: null,
          containmentComplete: true,
        };
      },
      trialEvidenceHash: canonicalSha256,
    },
  };
}

function randomBytes(size) {
  return Buffer.alloc(size, size === 32 ? 0x41 : 0x42);
}

function harborRequest(workDir, trialId = 'pair-r0-generic-a') {
  return {
    trial: {
      trialId,
      task: TASK_ID,
      condition: 'generic',
      identity: { pairId: 'pair-r0' },
      ceilingUsd: 0.65,
      profileId: 'economical-small-model',
    },
    harbor: {
      executable: '/usr/local/bin/harbor',
      args: ['run'],
      cwd: workDir,
      timeoutMs: 60_000,
      spawnEnv: { LANG: 'C.UTF-8' },
    },
  };
}

async function runtime(overrides = {}) {
  const input = fixture();
  const { fakeOptions, ...runtimeOverrides } = overrides;
  const fake = fakeComponents(fakeOptions);
  const value = await createReleaseRuntime({
    releaseSha: RELEASE_SHA,
    profileId: 'economical-small-model',
    taskLock: input.taskLock,
    bundle: input.bundle,
    budgetId: 'qualification-budget-1',
    budgetPolicyHash: HASH('3'),
    brokerPolicyHash: HASH('a'),
    sessionCeilingMicrousd: 1_300_000,
    providerKeyFd: 9,
    daytonaPath: '/opt/daytona',
    runtimeProjection: input.runtimeProjection,
    env: { PATH: '/usr/bin:/bin', DAYTONA_API_KEY: 'controller-login-only' },
    randomBytes,
    components: fake.components,
    ...runtimeOverrides,
  });
  return { ...input, fake, runtime: value };
}

test('release runtime consumes provider custody immediately and exposes exact sanitized preflight evidence', async () => {
  const { fake, runtime: value } = await runtime();
  assert.deepEqual(fake.calls[0], ['custodian', { keyFd: 9, releaseSha: RELEASE_SHA }]);
  assert.equal(value.providerControl.available, true);
  assert.deepEqual(fake.calls.find(([name]) => name === 'daytona-controller')[1], {
    snapshot: 'engineer-eval-44444444444444444444444444444444',
    releaseSha: RELEASE_SHA,
    executionMode: 'controlled-provider',
    sessionBudgetUsd: 1.3,
  });
  assert.equal(
    fake.calls.find(([name]) => name === 'session-controller')[1].session.executionMode,
    'controlled-provider',
  );

  const first = await value.providerControl.preflight();
  const second = await value.providerControl.preflight();
  assert.deepEqual(first, {
    schema: 'engineer-provider-preflight-observation.v1',
    keyFingerprint: HASH('f'),
    limitMicrousd: 20_000_000,
    limitRemainingMicrousd: 20_000_000,
    reset: null,
    checkedAt: '2026-08-04T20:00:00.000Z',
  });
  assert.deepEqual(second, first);
  assert.equal(fake.preflightCalls, 1);
  assert.equal(JSON.stringify(value.snapshot()).includes('controller-login-only'), false);
  await value.dispose();
});

test('one paid trial is archived, lease-authorized, materialized, and returned with final runtime evidence', async () => {
  const { workDir, fake, runtime: value } = await runtime();
  await value.providerControl.preflight();
  const result = await value.trialExecutor(harborRequest(workDir));

  assert.equal(result.run.code, 0);
  assert.deepEqual(result.runtimeEvidence, {
    schema: 'engineer-runtime-trial-final-attestation.v1',
    evidenceHash: canonicalSha256({
      schema: 'engineer-runtime-trial-final-attestation.v1',
      sessionId: 'release-session-test',
      trialId: 'pair-r0-generic-a',
      evidence: HASH('e'),
      outcome: { providerSpendMicrousd: 100_000 },
    }),
    providerSpendMicrousd: 100_000,
  });
  assert.deepEqual(fake.issued, ['pair-r0-generic-a']);
  const spec = fake.calls.find(([name]) => name === 'runTrial')[1];
  assert.deepEqual(spec, {
    trialId: 'pair-r0-generic-a',
    taskId: TASK_ID,
    condition: 'generic',
    imageDigest: IMAGE_ID,
    trialCeilingMicrousd: 650_000,
    supervisorExecutableHash: HASH('7'),
    runnerExecutableHash: HASH('8'),
    harborExecutableHash: HASH('9'),
  });
  assert.deepEqual(fake.calls.find(([name]) => name === 'run-remote')[1], {
    sandboxId: 'sandbox-1',
    executable: '/opt/engineer/bin/engineer-task-image-provision',
    args: [
      '--sandbox-id', 'sandbox-1',
      '--immutable-image', IMMUTABLE_IMAGE,
      '--image-id', IMAGE_ID,
      '--platform', 'linux/amd64',
    ],
  });
  assert.ok(
    fake.calls.findIndex(([name]) => name === 'run-remote')
      < fake.calls.findIndex(([name]) => name === 'secret-handoff'),
    'image preload completes before provider-secret handoff'
  );
  assert.ok(fake.archiveBuffers.every((buffer) => buffer.every((byte) => byte === 0)));
  assert.ok(fake.outputBuffers.every((buffer) => buffer.every((byte) => byte === 0)));
  await value.dispose();
});

test('final runtime trust is returned only after allowance reconciliation and all custody is disposable', async () => {
  const { workDir, fake, runtime: value } = await runtime();
  await value.providerControl.preflight();
  await value.trialExecutor(harborRequest(workDir));
  const final = await value.runtimeSession.finalize();

  assert.equal(final.schema, 'engineer-runtime-session-final-attestation.v1');
  assert.equal(fake.postflightCalls, 1);
  assert.deepEqual(fake.calls.slice(-2), [
    ['session-finalize'],
    ['postflight', 100_000],
  ]);
  assert.deepEqual(value.runtimeSession.providerEvidence(), {
    schema: 'engineer-release-provider-reconciliation.v1',
    verified: true,
    keyFingerprint: HASH('f'),
    preflightRemainingMicrousd: 20_000_000,
    postflightRemainingMicrousd: 19_900_000,
    observedAllowanceDeltaMicrousd: 100_000,
    sessionSpentMicrousd: 100_000,
    differenceMicrousd: 0,
    toleranceMicrousd: 2,
  });

  await value.dispose();
  await value.dispose();
  assert.deepEqual(fake.disposed, {
    custodianDisposed: true,
    transportDisposed: true,
    sessionDisposed: true,
  });
  assert.equal(value.snapshot().disposed, true);
});

test('a failed disposal attempt can be retried after transient session and transport cleanup failures', async () => {
  const { fake, runtime: value } = await runtime({
    fakeOptions: { sessionDisposeFailures: 1, transportDisposeFailures: 1 },
  });

  await assert.rejects(
    value.dispose(),
    (error) => error?.code === 'ERR_RELEASE_RUNTIME_DISPOSAL',
  );
  assert.deepEqual(fake.disposed, {
    custodianDisposed: true,
    transportDisposed: false,
    sessionDisposed: false,
  });

  await value.dispose();
  assert.deepEqual(fake.disposalCalls, {
    sessionDisposeCalls: 2,
    transportDisposeCalls: 2,
  });
  assert.deepEqual(fake.disposed, {
    custodianDisposed: true,
    transportDisposed: true,
    sessionDisposed: true,
  });
});

test('a trial ceiling above the signed session ceiling fails before allocation', async () => {
  const { workDir, fake, runtime: value } = await runtime();
  await value.providerControl.preflight();
  const request = harborRequest(workDir);
  request.trial.ceilingUsd = 1.300001;

  await assert.rejects(value.trialExecutor(request), /trial.*session.*ceiling|session.*budget/i);
  assert.equal(fake.calls.some(([name]) => name === 'runTrial'), false);
  await value.dispose();
});

test('ambient provider credentials and projection drift fail before the inherited descriptor is consumed', async () => {
  const input = fixture();
  const fake = fakeComponents();
  await assert.rejects(
    createReleaseRuntime({
      releaseSha: RELEASE_SHA,
      profileId: 'economical-small-model',
      taskLock: input.taskLock,
      bundle: input.bundle,
      budgetId: 'qualification-budget-1',
      budgetPolicyHash: HASH('3'),
      brokerPolicyHash: HASH('a'),
      sessionCeilingMicrousd: 1_300_000,
      providerKeyFd: 9,
      daytonaPath: '/opt/daytona',
      runtimeProjection: input.runtimeProjection,
      env: { OPENROUTER_API_KEY: 'forbidden' },
      randomBytes,
      components: fake.components,
    }),
    /ambient.*OPENROUTER_API_KEY|provider credential/i
  );
  assert.equal(fake.calls.length, 0);

  const drifted = structuredClone(input.runtimeProjection);
  drifted.bindings.bundleHash = HASH('4');
  await assert.rejects(
    createReleaseRuntime({
      releaseSha: RELEASE_SHA,
      profileId: 'economical-small-model',
      taskLock: input.taskLock,
      bundle: input.bundle,
      budgetId: 'qualification-budget-1',
      budgetPolicyHash: HASH('3'),
      brokerPolicyHash: HASH('a'),
      sessionCeilingMicrousd: 1_300_000,
      providerKeyFd: 9,
      daytonaPath: '/opt/daytona',
      runtimeProjection: drifted,
      env: {},
      randomBytes,
      components: fake.components,
    }),
    /bundle.*binding|projection.*drift/i
  );
  assert.equal(fake.calls.length, 0);

  await assert.rejects(
    createReleaseRuntime({
      releaseSha: RELEASE_SHA,
      profileId: 'economical-small-model',
      taskLock: input.taskLock,
      bundle: input.bundle,
      budgetId: 'qualification-budget-1',
      budgetPolicyHash: HASH('4'),
      brokerPolicyHash: HASH('a'),
      sessionCeilingMicrousd: 1_300_000,
      providerKeyFd: 9,
      daytonaPath: '/opt/daytona',
      runtimeProjection: input.runtimeProjection,
      env: {},
      randomBytes,
      components: fake.components,
    }),
    /budget policy.*drift|budgetPolicyHash.*drift/i
  );
  assert.equal(fake.calls.length, 0);
});
