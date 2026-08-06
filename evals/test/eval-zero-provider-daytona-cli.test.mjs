import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  ZERO_PROVIDER_ARTIFACT_HASH_SEMANTICS,
  ZERO_PROVIDER_DURABLE_EVIDENCE_SCHEMA,
  ZERO_PROVIDER_OPERATOR_TRUST_MODEL,
  ZERO_PROVIDER_QUALIFICATION_TASK,
  runZeroProviderDaytonaCli,
  validateZeroProviderDurableEvidence,
  writeZeroProviderDurableEvidence,
} from '../zero-provider-daytona.mjs';
import { createZeroProviderGateReport } from '../runtime/zero-provider-gate.mjs';
import { canonicalSha256, protocolDocumentHash } from '../runtime/protocol.mjs';
import { createGenuineRuntimeSession } from './support/runtime-session-fixture.mjs';

const HASH = (character) => character.repeat(64);
const RELEASE_SHA = 'a'.repeat(40);
const roots = new Set();

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporaryRoot(prefix = 'zero-provider-cli-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  roots.add(root);
  return fs.realpathSync.native(root);
}

function sourceLock() {
  return JSON.parse(fs.readFileSync(
    new URL('../external/terminal_bench/task-lock.json', import.meta.url),
    'utf8',
  ));
}

function releaseCanary() {
  return {
    profile: 'release-canary',
    task: { lockFile: 'evals/external/terminal_bench/task-lock.json' },
    controlledLane: { host: 'openrouter-controlled', profileId: 'kimi-k2.7-code' },
    budget: {
      releaseCeilingUsd: 10,
      controlledPairUsd: 8.4,
      rerunUsd: 1.6,
      qualificationPairUsd: 1.3,
      calibrationCeilingUsd: 18.7,
      providerHardLimitUsd: 20,
      controlledArmCeilingUsd: 0.65,
    },
    claimPolicy: {
      mode: 'initial-user-ship',
      qualificationTask: ZERO_PROVIDER_QUALIFICATION_TASK,
    },
  };
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

async function fakeRuntimeRun({ taskLockHash, bundleHash, gateDefinitionHash, profileId }) {
  const genuine = await createGenuineRuntimeSession({
    releaseSha: RELEASE_SHA,
    profileId,
    taskLockHash,
    bundleHash,
    executionMode: 'zero-provider-canary',
    providerSpendMicrousd: 0,
  });
  const sessionFinalAttestation = genuine.controller.finalize();
  const protocolTrials = genuine.protocolTrials.map((trial) => {
    const output = Buffer.from(`retained-output-${trial.condition}`);
    return {
      ...trial,
      outputArchiveReceipt: {
        sha256: crypto.createHash('sha256').update(output).digest('hex'),
        byteLength: output.length,
      },
    };
  });
  const report = createZeroProviderGateReport({
    releaseSha: RELEASE_SHA,
    snapshotBuildHash: HASH('8'),
    taskLockHash,
    bundleHash,
    gateDefinitionHash,
    profileId,
    taskId: ZERO_PROVIDER_QUALIFICATION_TASK,
    startedAt: '2026-08-04T12:00:00.000Z',
    completedAt: '2026-08-04T12:01:00.000Z',
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
    executionMode: 'zero-provider-canary',
    reportHash: report.reportHash,
    sessionFinalAttestationHash: report.sessionFinalAttestationHash,
    trialAttestationHashes: report.trials.map(({ trialAttestationHash }) => trialAttestationHash),
    deletionReceiptHashes: report.trials.map(({ deletionReceiptHash }) => deletionReceiptHash),
    readinessLeaseHashes: report.trials.map(({ readinessLeaseHash }) => readinessLeaseHash),
    outputArchiveHashes: protocolTrials.map(({ outputArchiveReceipt }) => outputArchiveReceipt.sha256),
  });
  const unsignedRun = {
    schema: 'engineer-zero-provider-daytona-run.v1',
    executionMode: 'zero-provider-canary',
    evidenceClass: 'infrastructure-validation',
    releaseEligible: false,
    authenticationScope: 'in-process-hmac-validated',
    standaloneSignatureVerifiable: false,
    report,
    protocolEvidence,
    lifecycleHash,
  };
  return { ...unsignedRun, artifactHash: canonicalArtifactHash(unsignedRun) };
}

function fixture({
  runGate,
  validateRuntimeRun,
  writeEvidence,
  disposeArtifacts,
  removeWorkRoot,
} = {}) {
  const root = temporaryRoot();
  const repository = path.join(root, 'repository');
  const reportParent = path.join(root, 'reports');
  const workRoot = path.join(root, 'work');
  fs.mkdirSync(repository, { mode: 0o700 });
  fs.mkdirSync(reportParent, { mode: 0o700 });
  const reportFile = path.join(reportParent, 'gate.json');
  const completeLock = sourceLock();
  const derivedLock = structuredClone(completeLock);
  derivedLock.datasetRef = 'terminal-bench-derived-offline@53ff2b87d621';
  for (const [index, task] of derivedLock.tasks.entries()) {
    task.taskChecksum = String(index + 1).repeat(64);
  }
  const calls = [];
  let gateInput;
  let artifactInput;
  let runtimeRun;
  const dependencies = {
    releaseRepository: () => repository,
    currentGitReleaseSha: () => RELEASE_SHA,
    assertCleanLiveReleaseSource: () => calls.push('clean'),
    assertTrustedLauncherEnvironment: (environment) => {
      assert.equal(environment.SAFE_VALUE, 'yes');
      calls.push('environment');
    },
    loadYamlConfig: (profile, options) => {
      assert.equal(profile, 'release-canary');
      assert.deepEqual(options, { attestCommit: true });
      calls.push('profile');
      return releaseCanary();
    },
    resolveDefaultLockFile: (file, options) => {
      assert.equal(file, 'evals/external/terminal_bench/task-lock.json');
      assert.deepEqual(options, { attestCommit: true });
      calls.push('lock');
      return { path: path.join(repository, file), bytes: Buffer.from(JSON.stringify(completeLock)) };
    },
    readHarnessVersion: () => '0.5.0',
    makeWorkRoot: () => {
      fs.mkdirSync(workRoot, { mode: 0o700 });
      calls.push('work-created');
      return workRoot;
    },
    removeWorkRoot: removeWorkRoot ?? ((directory) => {
      calls.push('work-removed');
      fs.rmSync(directory, { recursive: true, force: false });
    }),
    buildOfflineDataset: async (input) => {
      calls.push('offline');
      assert.equal(input.repoRoot, repository);
      assert.deepEqual(input.taskLock.tasks.map(({ task }) => task), completeLock.tasks.map(({ task }) => task));
      return {
        artifactId: HASH('3'),
        artifactDir: path.join(workRoot, 'offline', HASH('3')),
        datasetDir: path.join(workRoot, 'offline', HASH('3'), 'dataset'),
        lockPath: path.join(workRoot, 'offline', HASH('3'), 'offline-task-lock.json'),
        attestationPath: path.join(workRoot, 'offline', HASH('3'), 'offline-attestation.json'),
        taskLockHash: canonicalSha256(derivedLock),
        taskLock: derivedLock,
        attestation: { schema: 'engineer-terminal-bench-offline-dataset-attestation.v1' },
        datasetTreeHash: HASH('4'),
      };
    },
    validateOfflineDataset: (value, context) => {
      calls.push('offline-validated');
      assert.equal(context.workDir, workRoot);
      assert.equal(context.sourceLock.tasks.length, 4);
      return value;
    },
    prepareRuntimeArtifacts: async (input) => {
      calls.push('artifacts');
      artifactInput = structuredClone(input);
      const bundle = { bundleDir: path.join(workRoot, 'bundle'), manifestHash: HASH('7') };
      return {
        bundle,
        daytonaPath: '/opt/homebrew/bin/daytona',
        runtimeProjection: {
          bindings: {
            releaseSha: input.releaseSha,
            taskLockHash: input.taskLockHash,
            bundleHash: bundle.manifestHash,
            budgetPolicyHash: input.budgetPolicyHash,
            brokerPolicyHash: input.brokerPolicyHash,
            profileId: input.profileId,
            sessionCeilingMicrousd: input.sessionCeilingMicrousd,
          },
          snapshot: { name: `engineer-eval-${HASH('8').slice(0, 32)}`, buildHash: HASH('8') },
        },
        dispose: disposeArtifacts ?? (async () => calls.push('artifacts-disposed')),
      };
    },
    runGate: runGate ?? (async (input) => {
      calls.push('gate');
      gateInput = input;
      runtimeRun = await fakeRuntimeRun({
        taskLockHash: artifactInput.taskLockHash,
        bundleHash: HASH('7'),
        gateDefinitionHash: input.gateDefinitionHash,
        profileId: artifactInput.profileId,
      });
      return runtimeRun;
    }),
    validateRuntimeRun: validateRuntimeRun ?? ((run, options) => {
      calls.push('run-validated');
      assert.deepEqual(options, { requireInProcessBrand: true });
      return structuredClone(run);
    }),
    writeDurableEvidence: writeEvidence ?? (({ destination, evidence }) => {
      calls.push('evidence-written');
      assert.equal(destination, reportFile);
      assert.equal(fs.existsSync(workRoot), false, 'work must be removed before publication');
      fs.writeFileSync(destination, `${JSON.stringify(evidence)}\n`, { flag: 'wx', mode: 0o600 });
      return evidence;
    }),
  };
  return {
    root,
    repository,
    reportFile,
    workRoot,
    calls,
    dependencies,
    get gateInput() { return gateInput; },
    get artifactInput() { return artifactInput; },
    get runtimeRun() { return runtimeRun; },
  };
}

test('runs the exact committed COBOL qualification projection without provider authority and disposes before reporting', async () => {
  const state = fixture();
  const result = await runZeroProviderDaytonaCli({
    argv: ['--report-file', state.reportFile],
    env: { SAFE_VALUE: 'yes' },
    stdout: () => {},
    dependencies: state.dependencies,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.reportFile, state.reportFile);
  assert.equal(result.report.executionMode, 'zero-provider-canary');
  assert.equal(result.evidence.schema, ZERO_PROVIDER_DURABLE_EVIDENCE_SCHEMA);
  assert.equal(result.evidence.operatorTrustModel, ZERO_PROVIDER_OPERATOR_TRUST_MODEL);
  assert.equal(result.evidence.artifactHashSemantics, ZERO_PROVIDER_ARTIFACT_HASH_SEMANTICS);
  assert.equal(result.evidence.runtimeRun.protocolEvidence.trials.length, 2);
  assert.equal(result.evidence.runtimeRun.artifactHash, result.runtimeArtifactHash);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.reportFile, 'utf8')), result.evidence);
  assert.deepEqual(state.artifactInput.taskLock.tasks.map(({ task }) => task), [ZERO_PROVIDER_QUALIFICATION_TASK]);
  assert.equal(Object.hasOwn(state.artifactInput.taskLock.tasks[0].sandbox, 'sourceImage'), false);
  assert.equal(typeof state.gateInput.taskLock.tasks[0].sandbox.sourceImage, 'string');
  assert.equal(state.artifactInput.taskLockHash, canonicalSha256(state.artifactInput.taskLock));
  assert.notEqual(canonicalSha256(state.gateInput.taskLock), state.artifactInput.taskLockHash);
  assert.equal(state.artifactInput.profileId, 'kimi-k2.7-code');
  assert.equal(state.artifactInput.sessionCeilingMicrousd, 1_300_000);
  assert.match(state.artifactInput.budgetPolicyHash, /^[a-f0-9]{64}$/);
  assert.match(state.artifactInput.brokerPolicyHash, /^[a-f0-9]{64}$/);
  assert.equal(state.gateInput.taskId, ZERO_PROVIDER_QUALIFICATION_TASK);
  assert.equal(state.gateInput.bundle.manifestHash, HASH('7'));
  assert.deepEqual(state.gateInput.taskLock.tasks.map(({ task }) => task), [ZERO_PROVIDER_QUALIFICATION_TASK]);
  assert.deepEqual(state.gateInput.env, { SAFE_VALUE: 'yes' });
  assert.doesNotMatch(JSON.stringify(state.gateInput), /providerKey|providerKeyFd|credentialCustodian|OPENROUTER_API_KEY/i);
  assert.deepEqual(result.report.trials.map(({ condition }) => condition), ['generic', 'harness']);
  assert.deepEqual(state.calls, [
    'environment', 'clean', 'profile', 'lock', 'work-created', 'offline', 'offline-validated',
    'artifacts', 'gate', 'run-validated', 'artifacts-disposed', 'work-removed', 'evidence-written',
  ]);
});

test('ships an exact durable-envelope schema that states the trusted-owner and digest limits', () => {
  const schema = JSON.parse(fs.readFileSync(
    new URL('../schema/runtime-zero-provider-daytona-evidence.v1.schema.json', import.meta.url),
    'utf8',
  ));
  assert.equal(schema.$id, ZERO_PROVIDER_DURABLE_EVIDENCE_SCHEMA);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.operatorTrustModel.const, ZERO_PROVIDER_OPERATOR_TRUST_MODEL);
  assert.equal(schema.properties.artifactHashSemantics.const, ZERO_PROVIDER_ARTIFACT_HASH_SEMANTICS);
  assert.equal(schema.$defs.runtimeRun.properties.standaloneSignatureVerifiable.const, false);
  assert.equal(schema.$defs.protocolEvidence.type, 'object');
});

test('durable-envelope validation rejects drifted trust and digest semantics', async () => {
  const state = fixture();
  const result = await runZeroProviderDaytonaCli({
    argv: ['--report-file', state.reportFile],
    env: { SAFE_VALUE: 'yes' },
    stdout: () => {},
    dependencies: state.dependencies,
  });
  const options = { validateRuntimeRun: (run) => structuredClone(run) };
  assert.deepEqual(validateZeroProviderDurableEvidence(result.evidence, options), result.evidence);
  for (const [field, value] of [
    ['operatorTrustModel', 'untrusted-operator'],
    ['artifactHashSemantics', 'signature'],
  ]) {
    assert.throws(
      () => validateZeroProviderDurableEvidence({ ...result.evidence, [field]: value }, options),
      /trust|digest|semantics/i,
    );
  }
});

test('requires the in-process runtime brand before publishing durable evidence', async () => {
  const state = fixture({
    validateRuntimeRun: () => { throw new Error('in-process validated run capability is missing'); },
  });
  await assert.rejects(
    runZeroProviderDaytonaCli({
      argv: ['--report-file', state.reportFile],
      env: { SAFE_VALUE: 'yes' },
      stdout: () => {},
      dependencies: state.dependencies,
    }),
    /in-process|capability|validated run/i,
  );
  assert.equal(fs.existsSync(state.reportFile), false);
  assert.equal(state.calls.includes('evidence-written'), false);
  assert.equal(state.calls.includes('artifacts-disposed'), true);
  assert.equal(state.calls.includes('work-removed'), true);
});

test('dependency overrides cannot mint durable evidence through the production writer', async () => {
  const state = fixture({ writeEvidence: writeZeroProviderDurableEvidence });
  await assert.rejects(
    runZeroProviderDaytonaCli({
      argv: ['--report-file', state.reportFile],
      env: { SAFE_VALUE: 'yes' },
      stdout: () => {},
      dependencies: state.dependencies,
    }),
    /in-process|capability|publication/i,
  );
  const reconstructed = {
    schema: ZERO_PROVIDER_DURABLE_EVIDENCE_SCHEMA,
    operatorTrustModel: ZERO_PROVIDER_OPERATOR_TRUST_MODEL,
    artifactHashSemantics: ZERO_PROVIDER_ARTIFACT_HASH_SEMANTICS,
    runtimeRun: state.runtimeRun,
  };
  assert.deepEqual(validateZeroProviderDurableEvidence(reconstructed), reconstructed,
    'the crafted run is structurally valid; only the missing production capability blocks writing');
  assert.equal(fs.existsSync(state.reportFile), false);
  assert.equal(state.calls.includes('artifacts-disposed'), true);
  assert.equal(state.calls.includes('work-removed'), true);
});

test('accepts exactly one report argument and rejects provider environment before source or cloud work', async (t) => {
  for (const argv of [
    [],
    ['--report-file'],
    ['--report-file', '/tmp/a', '--provider-key-fd', '3'],
    ['--profile', 'release-canary', '--report-file', '/tmp/a'],
    ['--report-file', 'relative.json'],
  ]) {
    await t.test(JSON.stringify(argv), async () => {
      const state = fixture();
      await assert.rejects(
        runZeroProviderDaytonaCli({ argv, env: { SAFE_VALUE: 'yes' }, dependencies: state.dependencies }),
        /exactly|report-file|absolute|unsupported/i,
      );
      assert.deepEqual(state.calls, []);
    });
  }

  const state = fixture();
  state.dependencies.assertTrustedLauncherEnvironment = () => {
    throw new Error('ambient raw provider credentials are forbidden');
  };
  await assert.rejects(
    runZeroProviderDaytonaCli({
      argv: ['--report-file', state.reportFile],
      env: { OPENROUTER_API_KEY: 'must-not-enter-zero-gate' },
      dependencies: state.dependencies,
    }),
    /provider credentials/i,
  );
  assert.deepEqual(state.calls, []);
});

test('fails closed on qualification-policy drift before artifacts are prepared', async (t) => {
  for (const mutate of [
    (config) => { config.claimPolicy.qualificationTask = 'cancel-async-tasks'; },
    (config) => { config.budget.qualificationPairUsd = 1.31; },
    (config) => { config.budget.controlledArmCeilingUsd = 0.66; },
    (config) => { config.controlledLane.host = 'another-host'; },
  ]) {
    await t.test(mutate.toString(), async () => {
      const state = fixture();
      state.dependencies.loadYamlConfig = () => {
        const config = releaseCanary();
        mutate(config);
        return config;
      };
      await assert.rejects(
        runZeroProviderDaytonaCli({
          argv: ['--report-file', state.reportFile],
          env: { SAFE_VALUE: 'yes' },
          dependencies: state.dependencies,
        }),
        /qualification|budget|controlled|profile|task/i,
      );
      assert.equal(state.calls.includes('artifacts'), false);
      assert.equal(fs.existsSync(state.workRoot), false);
    });
  }
});

test('disposes artifacts and local work without publishing when the Daytona gate fails', async () => {
  const state = fixture({
    runGate: async () => { throw new Error('Daytona gate failed'); },
  });
  await assert.rejects(
    runZeroProviderDaytonaCli({
      argv: ['--report-file', state.reportFile],
      env: { SAFE_VALUE: 'yes' },
      dependencies: state.dependencies,
    }),
    /Daytona gate failed/i,
  );
  assert.equal(fs.existsSync(state.workRoot), false);
  assert.equal(fs.existsSync(state.reportFile), false);
  assert.equal(state.calls.includes('artifacts-disposed'), true);
  assert.equal(state.calls.includes('work-removed'), true);
  assert.equal(state.calls.includes('evidence-written'), false);
});

test('retries artifact cleanup after a transient success-path failure without publishing evidence', async () => {
  let disposalAttempts = 0;
  const state = fixture({
    disposeArtifacts: async () => {
      disposalAttempts += 1;
      if (disposalAttempts === 1) throw new Error('transient artifact cleanup failure');
    },
  });

  await assert.rejects(
    runZeroProviderDaytonaCli({
      argv: ['--report-file', state.reportFile],
      env: { SAFE_VALUE: 'yes' },
      dependencies: state.dependencies,
    }),
    /transient artifact cleanup failure/i,
  );
  assert.equal(disposalAttempts, 2);
  assert.equal(state.calls.includes('work-removed'), true);
  assert.equal(state.calls.includes('evidence-written'), false);
  assert.equal(fs.existsSync(state.reportFile), false);
});

test('retries work-root cleanup after a transient success-path failure without publishing evidence', async () => {
  let removalAttempts = 0;
  const state = fixture({
    removeWorkRoot: (directory) => {
      removalAttempts += 1;
      if (removalAttempts === 1) throw new Error('transient work cleanup failure');
      fs.rmSync(directory, { recursive: true, force: false });
    },
  });

  await assert.rejects(
    runZeroProviderDaytonaCli({
      argv: ['--report-file', state.reportFile],
      env: { SAFE_VALUE: 'yes' },
      dependencies: state.dependencies,
    }),
    /transient work cleanup failure/i,
  );
  assert.equal(removalAttempts, 2);
  assert.equal(state.calls.includes('artifacts-disposed'), true);
  assert.equal(state.calls.includes('evidence-written'), false);
  assert.equal(fs.existsSync(state.reportFile), false);
});

test('rejects runtime-projection binding tampering before a Daytona sandbox starts', async () => {
  const state = fixture();
  const prepare = state.dependencies.prepareRuntimeArtifacts;
  state.dependencies.prepareRuntimeArtifacts = async (input) => {
    const artifacts = await prepare(input);
    artifacts.runtimeProjection.bindings.taskLockHash = HASH('f');
    return artifacts;
  };
  await assert.rejects(
    runZeroProviderDaytonaCli({
      argv: ['--report-file', state.reportFile],
      env: { SAFE_VALUE: 'yes' },
      dependencies: state.dependencies,
    }),
    /taskLockHash binding drifted/i,
  );
  assert.equal(state.calls.includes('gate'), false);
  assert.equal(state.calls.includes('artifacts-disposed'), true);
  assert.equal(state.calls.includes('work-removed'), true);
  assert.equal(fs.existsSync(state.reportFile), false);
});

test('refuses an existing report without starting artifact or cloud work', async () => {
  const state = fixture();
  fs.writeFileSync(state.reportFile, 'existing\n', { mode: 0o600 });
  await assert.rejects(
    runZeroProviderDaytonaCli({
      argv: ['--report-file', state.reportFile],
      env: { SAFE_VALUE: 'yes' },
      dependencies: state.dependencies,
    }),
    /already exists|overwrite|new report/i,
  );
  assert.equal(state.calls.includes('artifacts'), false);
});
