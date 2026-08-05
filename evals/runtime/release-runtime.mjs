/**
 * Production composition for one externally controlled paid release session.
 *
 * The component modules own their individual trust boundaries. This layer owns
 * their ordering: inherited provider-key custody, preflight, one fresh Daytona
 * sandbox per trial, signed final evidence, allowance reconciliation, and
 * zeroing/disposal on every exit path.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createProviderCredentialCustodian } from './credential-custodian.mjs';
import { createDaytonaSessionController } from './daytona-controller.mjs';
import { createDaytonaTransport } from './daytona-transport.mjs';
import { canonicalSha256, protocolDocumentHash } from './protocol.mjs';
import { createRuntimeSessionController } from './session-controller.mjs';
import { applyTrialOutputArchive, createTrialInputArchive } from './trial-archive.mjs';
import { createRuntimeTrialTransport } from './trial-transport.mjs';

const HASH = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;
const EXPECTED_EXECUTABLES = Object.freeze({
  supervisor: '/opt/engineer/bin/engineer-runtime-supervisor',
  runner: '/opt/engineer/bin/engineer-eval-runner',
  harbor: '/opt/engineer/bin/harbor',
  imageProvisioner: '/opt/engineer/bin/engineer-task-image-provision',
});

const DEFAULT_COMPONENTS = Object.freeze({
  createProviderCredentialCustodian,
  createDaytonaTransport,
  createDaytonaSessionController,
  createRuntimeTrialTransport,
  createRuntimeSessionController,
  createTrialInputArchive,
  applyTrialOutputArchive,
  trialEvidenceHash: protocolDocumentHash,
});

export class ReleaseRuntimeError extends Error {
  constructor(message, code = 'ERR_RELEASE_RUNTIME') {
    super(message);
    this.name = 'ReleaseRuntimeError';
    this.code = code;
  }
}

function invalid(message, code = 'ERR_RELEASE_RUNTIME_CONFIG') {
  throw new ReleaseRuntimeError(message, code);
}

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) invalid(`${label} must be an object`);
  const expected = new Set(fields);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    invalid(`${label} contains an unexpected field`);
  }
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) invalid(`${label} must be a SHA-256 digest`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) invalid(`${label} must be a safe identifier`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function exactMicrousd(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    invalid(`${label} must be a positive finite USD amount`);
  }
  const microusd = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(microusd) || microusd < 1 || microusd > 20_000_000 ||
      Math.abs(value - microusd / 1_000_000) > 1e-12) {
    invalid(`${label} must resolve exactly to bounded integer microusd`);
  }
  return microusd;
}

function absoluteExecutable(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
      value.includes('\0')) invalid(`${label} must be an absolute normalized executable path`);
  return value;
}

function clone(value, label = 'runtime value') {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    invalid(`${label} must contain JSON data only`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateComponents(overrides) {
  if (!plainObject(overrides)) invalid('components must be an object');
  const allowed = new Set(Object.keys(DEFAULT_COMPONENTS));
  if (Object.keys(overrides).some((key) => !allowed.has(key))) {
    invalid('components contains an unexpected field');
  }
  const components = { ...DEFAULT_COMPONENTS, ...overrides };
  for (const [name, implementation] of Object.entries(components)) {
    if (typeof implementation !== 'function') invalid(`${name} must be a function`);
  }
  return Object.freeze(components);
}

function validateTaskLock(taskLock) {
  if (!plainObject(taskLock) || !Array.isArray(taskLock.tasks) || taskLock.tasks.length < 1 ||
      taskLock.tasks.length > 64) invalid('taskLock must contain a bounded task list');
  const images = {};
  for (const entry of taskLock.tasks) {
    if (!plainObject(entry)) invalid('taskLock contains a malformed task');
    const task = safeId(entry.task, 'taskLock task');
    const sandbox = entry.sandbox;
    exactKeys(sandbox, [
      'immutableImage', 'imageId', 'platform', 'cpus', 'memoryMb', 'storageMb',
    ], `taskLock task ${task} sandbox`);
    if (typeof sandbox.immutableImage !== 'string' || !IMMUTABLE_IMAGE.test(sandbox.immutableImage) ||
        typeof sandbox.imageId !== 'string' || !IMAGE_DIGEST.test(sandbox.imageId) ||
        !sandbox.immutableImage.endsWith(`@${sandbox.imageId}`)) {
      invalid(`taskLock task ${task} is missing a matching immutable image reference and ID`);
    }
    if (sandbox.platform !== 'linux/amd64') invalid(`taskLock task ${task} platform must be linux/amd64`);
    integer(sandbox.cpus, `taskLock task ${task} cpus`, 1, 2);
    integer(sandbox.memoryMb, `taskLock task ${task} memoryMb`, 256, 4096);
    integer(sandbox.storageMb, `taskLock task ${task} storageMb`, 256, 10240);
    if (Object.hasOwn(images, task)) invalid(`taskLock contains duplicate task ${task}`);
    images[task] = clone(sandbox, `taskLock task ${task} sandbox`);
  }
  return deepFreeze(images);
}

function validateBundle(bundle) {
  exactKeys(bundle, ['bundleDir', 'manifestHash'], 'prebuilt bundle');
  hash(bundle.manifestHash, 'prebuilt bundle manifestHash');
  if (typeof bundle.bundleDir !== 'string' || !path.isAbsolute(bundle.bundleDir) ||
      path.normalize(bundle.bundleDir) !== bundle.bundleDir || bundle.bundleDir.includes('\0')) {
    invalid('prebuilt bundle directory must be absolute and normalized');
  }
  let stat;
  let canonicalDirectory;
  try {
    stat = fs.lstatSync(bundle.bundleDir);
    canonicalDirectory = fs.realpathSync(bundle.bundleDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !fs.lstatSync(canonicalDirectory).isDirectory()) {
      invalid('prebuilt bundle directory must be a real non-symlink directory');
    }
  } catch (error) {
    if (error instanceof ReleaseRuntimeError) throw error;
    invalid('prebuilt bundle directory is unavailable');
  }
  return deepFreeze({ bundleDir: canonicalDirectory, manifestHash: bundle.manifestHash });
}

function validateProjection(value, expected) {
  exactKeys(value, [
    'schema', 'topologyManifest', 'snapshot', 'bindings', 'executables', 'taskImages',
  ], 'runtime projection');
  if (value.schema !== 'engineer-daytona-release-runtime-projection.v1') {
    invalid('runtime projection schema drifted');
  }
  exactKeys(value.topologyManifest, ['schema', 'hash'], 'runtime topology identity');
  if (value.topologyManifest.schema !== 'engineer-daytona-topology-manifest.v1') {
    invalid('runtime topology manifest schema drifted');
  }
  hash(value.topologyManifest.hash, 'runtime topology manifest hash');
  exactKeys(value.snapshot, ['name', 'buildHash'], 'runtime snapshot');
  safeId(value.snapshot.name, 'runtime snapshot name');
  hash(value.snapshot.buildHash, 'runtime snapshot buildHash');
  if (value.snapshot.name !== `engineer-eval-${value.snapshot.buildHash.slice(0, 32)}`) {
    invalid('runtime snapshot name drifted from its build hash');
  }
  exactKeys(value.bindings, [
    'releaseSha', 'taskLockHash', 'bundleHash', 'budgetPolicyHash', 'profileId',
    'brokerPolicyHash',
    'sessionCeilingMicrousd',
  ], 'runtime release bindings');
  for (const [field, expectedValue] of Object.entries(expected.bindings)) {
    if (value.bindings[field] !== expectedValue) {
      invalid(`runtime projection ${field} binding drifted`);
    }
  }
  exactKeys(value.executables, Object.keys(EXPECTED_EXECUTABLES), 'runtime executables');
  for (const [name, expectedPath] of Object.entries(EXPECTED_EXECUTABLES)) {
    exactKeys(value.executables[name], ['path', 'sha256'], `runtime ${name} executable`);
    if (value.executables[name].path !== expectedPath) invalid(`runtime ${name} executable path drifted`);
    hash(value.executables[name].sha256, `runtime ${name} executable hash`);
  }
  if (!plainObject(value.taskImages) || canonicalSha256(value.taskImages) !== canonicalSha256(expected.taskImages)) {
    invalid('runtime projection locked task images drifted');
  }
  return deepFreeze(clone(value, 'runtime projection'));
}

function validateArchive(value, trialId) {
  if (!plainObject(value) || !Buffer.isBuffer(value.bytes) || !plainObject(value.manifest) ||
      !plainObject(value.materialization)) invalid('trial input archive construction failed');
  exactKeys(value.manifest, ['kind', 'encoding', 'byteLength', 'sha256'], 'trial input archive manifest');
  if (value.manifest.kind !== 'task-input' || value.manifest.encoding !== 'tar+gzip' ||
      value.manifest.byteLength !== value.bytes.length ||
      value.manifest.sha256 !== crypto.createHash('sha256').update(value.bytes).digest('hex')) {
    value.bytes.fill(0);
    invalid('trial input archive digest or size drifted');
  }
  if (value.materialization.trialId !== trialId) {
    value.bytes.fill(0);
    invalid('trial input archive materialization identity drifted');
  }
  return value;
}

function validatePreflight(value, keyFingerprint) {
  if (!plainObject(value) || value.schema !== 'engineer-openrouter-key-metadata.v1' ||
      value.phase !== 'preflight' || !Number.isSafeInteger(value.limitMicrousd) ||
      !Number.isSafeInteger(value.limitRemainingMicrousd) || value.limitMicrousd < 0 ||
      value.limitRemainingMicrousd < 0 || value.limitRemainingMicrousd > value.limitMicrousd ||
      ![null, 'configured'].includes(value.reset) || typeof value.checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.checkedAt))) {
    invalid('provider custodian returned malformed preflight evidence', 'ERR_RELEASE_RUNTIME_PROVIDER');
  }
  return deepFreeze({
    schema: 'engineer-provider-preflight-observation.v1',
    keyFingerprint,
    limitMicrousd: value.limitMicrousd,
    limitRemainingMicrousd: value.limitRemainingMicrousd,
    reset: value.reset,
    checkedAt: value.checkedAt,
  });
}

function validateReconciliation(value, keyFingerprint) {
  if (!plainObject(value) || value.schema !== 'engineer-openrouter-allowance-reconciliation.v1' ||
      value.verified !== true) {
    invalid('provider allowance reconciliation failed', 'ERR_RELEASE_RUNTIME_RECONCILIATION');
  }
  const integerFields = [
    'preflightRemainingMicrousd', 'postflightRemainingMicrousd',
    'observedAllowanceDeltaMicrousd', 'sessionSpentMicrousd', 'differenceMicrousd',
    'toleranceMicrousd',
  ];
  for (const field of integerFields) integer(value[field], `provider reconciliation ${field}`, 0, 10_000_000_000);
  if (value.observedAllowanceDeltaMicrousd !==
      value.preflightRemainingMicrousd - value.postflightRemainingMicrousd ||
      value.differenceMicrousd !== Math.abs(value.observedAllowanceDeltaMicrousd - value.sessionSpentMicrousd) ||
      value.differenceMicrousd > value.toleranceMicrousd) {
    invalid('provider allowance reconciliation arithmetic drifted', 'ERR_RELEASE_RUNTIME_RECONCILIATION');
  }
  return deepFreeze({
    schema: 'engineer-release-provider-reconciliation.v1',
    verified: true,
    keyFingerprint,
    ...Object.fromEntries(integerFields.map((field) => [field, value[field]])),
  });
}

function randomOwned(randomBytes, size, label) {
  const source = randomBytes(size);
  if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) invalid(`${label} source must return bytes`);
  if (source.byteLength !== size) invalid(`${label} source returned the wrong byte length`);
  return Buffer.from(source);
}

function constructionFailure() {
  return new ReleaseRuntimeError(
    'release runtime construction failed after credential custody began',
    'ERR_RELEASE_RUNTIME_CONSTRUCTION'
  );
}

export async function createReleaseRuntime({
  releaseSha,
  profileId,
  taskLock,
  bundle: bundleInput,
  budgetId,
  budgetPolicyHash,
  brokerPolicyHash,
  sessionCeilingMicrousd,
  providerKeyFd,
  daytonaPath,
  runtimeProjection: projectionInput,
  env = process.env,
  randomBytes = crypto.randomBytes,
  components: componentOverrides = {},
} = {}) {
  if (!plainObject(env)) invalid('release runtime environment must be an object');
  if (Object.hasOwn(env, 'OPENROUTER_API_KEY')) {
    invalid('release runtime refuses an ambient OPENROUTER_API_KEY provider credential');
  }
  if (typeof releaseSha !== 'string' || !RELEASE_SHA.test(releaseSha)) {
    invalid('releaseSha must be a lowercase full commit/content digest');
  }
  safeId(profileId, 'profileId');
  safeId(budgetId, 'budgetId');
  hash(budgetPolicyHash, 'budgetPolicyHash');
  hash(brokerPolicyHash, 'brokerPolicyHash');
  integer(sessionCeilingMicrousd, 'sessionCeilingMicrousd', 1, 20_000_000);
  integer(providerKeyFd, 'providerKeyFd', 3, 1_048_575);
  absoluteExecutable(daytonaPath, 'daytonaPath');
  if (typeof randomBytes !== 'function') invalid('randomBytes must be a function');
  const components = validateComponents(componentOverrides);
  const taskImages = validateTaskLock(taskLock);
  const bundle = validateBundle(bundleInput);
  const expectedBindings = {
    releaseSha,
    taskLockHash: canonicalSha256(taskLock),
    bundleHash: bundle.manifestHash,
    budgetPolicyHash,
    brokerPolicyHash,
    profileId,
    sessionCeilingMicrousd,
  };
  hash(expectedBindings.budgetPolicyHash, 'runtime budget policy hash');
  hash(expectedBindings.brokerPolicyHash, 'runtime broker policy hash');
  const runtimeProjection = validateProjection(projectionInput, {
    bindings: expectedBindings,
    taskImages,
  });

  let sessionEntropy;
  let sessionSuffix;
  let rootHmacKey;
  try {
    sessionEntropy = randomOwned(randomBytes, 8, 'session identity entropy');
    sessionSuffix = crypto.createHash('sha256').update(sessionEntropy).digest('hex').slice(0, 24);
    rootHmacKey = randomOwned(randomBytes, 32, 'runtime HMAC key');
  } finally {
    sessionEntropy?.fill?.(0);
  }
  const sessionId = `release-${releaseSha.slice(0, 12)}-${sessionSuffix}`;
  const session = deepFreeze({
    sessionId,
    releaseSha,
    profileId,
    taskLockHash: expectedBindings.taskLockHash,
    bundleHash: expectedBindings.bundleHash,
    executionMode: 'controlled-provider',
    budgetId,
    budgetPolicyHash: expectedBindings.budgetPolicyHash,
    brokerPolicyHash: expectedBindings.brokerPolicyHash,
    sessionCeilingMicrousd,
  });

  let custodian;
  let daytonaTransport;
  let daytonaController;
  let trialTransport;
  let sessionController;
  let disposed = false;
  let disposePromise = null;
  let finalized = false;
  let preflightEvidence = null;
  let providerReconciliation = null;
  const pendingArchives = new Map();
  const boundAllocations = new Map();
  const attemptedTrials = new Set();

  function assertActive() {
    if (disposed) invalid('release runtime is disposed', 'ERR_RELEASE_RUNTIME_DISPOSED');
    if (finalized) invalid('release runtime is finalized', 'ERR_RELEASE_RUNTIME_FINALIZED');
  }

  function wipePendingArchives() {
    for (const entry of pendingArchives.values()) entry.bytes.fill(0);
    pendingArchives.clear();
  }

  async function disposeInternal() {
    if (disposePromise) return disposePromise;
    disposed = true;
    const attempt = (async () => {
      const failures = [];
      wipePendingArchives();
      boundAllocations.clear();
      try { await sessionController?.dispose?.(); } catch { failures.push('session'); }
      try { await daytonaTransport?.dispose?.(); } catch { failures.push('transport'); }
      try { custodian?.dispose?.(); } catch { failures.push('credential'); }
      rootHmacKey?.fill(0);
      if (failures.length > 0) {
        throw new ReleaseRuntimeError('release runtime disposal was incomplete', 'ERR_RELEASE_RUNTIME_DISPOSAL');
      }
    })();
    disposePromise = attempt;
    try {
      await attempt;
    } catch (error) {
      // Disposal is terminal for runtime use, but a transient cleanup failure
      // must not poison the idempotency promise. A later dispose call retries
      // every custodian so incomplete external cleanup can converge.
      if (disposePromise === attempt) disposePromise = null;
      throw error;
    }
  }

  try {
    // This constructor transfers and closes the inherited descriptor before
    // any cloud or provider operation can begin.
    custodian = components.createProviderCredentialCustodian({
      keyFd: providerKeyFd,
      releaseSha,
    });
    const keyFingerprint = custodian.keyFingerprint();
    hash(keyFingerprint, 'provider key fingerprint');

    daytonaTransport = components.createDaytonaTransport({
      daytonaPath,
      baseEnv: env,
    });
    daytonaController = components.createDaytonaSessionController({
      daytonaPath,
      snapshot: runtimeProjection.snapshot.name,
      releaseSha,
      executionMode: 'controlled-provider',
      sessionBudgetUsd: sessionCeilingMicrousd / 1_000_000,
      baseEnv: env,
      async provisionTrial({ allocation, trial }) {
        const taskImage = runtimeProjection.taskImages[trial.task];
        if (!plainObject(taskImage)) invalid('trial task has no locked runtime image');
        const sandboxId = safeId(allocation?.id, 'Daytona allocation id');
        const receipt = await daytonaTransport.runRemote({
          sandboxId,
          executable: runtimeProjection.executables.imageProvisioner.path,
          args: [
            '--sandbox-id', sandboxId,
            '--immutable-image', taskImage.immutableImage,
            '--image-id', taskImage.imageId,
            '--platform', taskImage.platform,
          ],
        });
        exactKeys(receipt, [
          'schema', 'exitCode', 'stdoutBytes', 'stdoutSha256', 'stderrBytes', 'stderrSha256',
        ], 'task image provision receipt');
        if (receipt.schema !== 'engineer-daytona-command-receipt.v1' || receipt.exitCode !== 0) {
          invalid('task image provisioning failed');
        }
        integer(receipt.stdoutBytes, 'task image provision stdout bytes', 0, 1_048_576);
        integer(receipt.stderrBytes, 'task image provision stderr bytes', 0, 1_048_576);
        hash(receipt.stdoutSha256, 'task image provision stdout hash');
        hash(receipt.stderrSha256, 'task image provision stderr hash');
        return deepFreeze({
          schema: 'engineer-daytona-allocation-binding.v1',
          sandboxId,
          trialId: trial.trialId,
          topologyManifestHash: runtimeProjection.topologyManifest.hash,
          snapshotBuildHash: runtimeProjection.snapshot.buildHash,
          taskImageHash: canonicalSha256(taskImage),
          provisionReceiptHash: canonicalSha256(receipt),
        });
      },
    });
    trialTransport = components.createRuntimeTrialTransport({
      daytonaTransport,
      sessionId,
      executionMode: 'controlled-provider',
      async taskInputArchive({ allocation, spec }) {
        const retained = pendingArchives.get(spec?.trialId);
        if (!retained || retained.specHash !== canonicalSha256(spec)) {
          invalid('runtime requested an unregistered or drifted task input archive');
        }
        const allocationId = safeId(allocation?.id, 'Daytona allocation id');
        if (boundAllocations.has(spec.trialId)) invalid('trial allocation was already bound');
        boundAllocations.set(spec.trialId, allocationId);
        pendingArchives.delete(spec.trialId);
        return retained.bytes;
      },
      async takeTrialSecrets({ sessionId: observedSessionId, trialId, allocationId }) {
        if (observedSessionId !== sessionId || !attemptedTrials.has(trialId) ||
            boundAllocations.get(trialId) !== allocationId) {
          invalid('runtime secret handoff identity drifted');
        }
        boundAllocations.delete(trialId);
        const hmacKey = Buffer.from(rootHmacKey);
        let providerKey;
        try {
          providerKey = custodian.issueTrialCredential(trialId);
          if (!Buffer.isBuffer(providerKey)) invalid('credential custodian returned non-owned provider bytes');
          return { hmacKey, providerKey };
        } catch (error) {
          hmacKey.fill(0);
          providerKey?.fill?.(0);
          throw error;
        }
      },
    });
    const controllerKey = Buffer.from(rootHmacKey);
    const supervisorKey = Buffer.from(rootHmacKey);
    try {
      sessionController = components.createRuntimeSessionController({
        daytonaController,
        transport: trialTransport,
        session,
        controllerKey,
        controllerKeyId: 'runtime-controller-hmac-1',
        supervisorKey,
        supervisorKeyId: 'runtime-supervisor-hmac-1',
      });
    } finally {
      controllerKey.fill(0);
      supervisorKey.fill(0);
    }

    const providerControl = Object.freeze({
      available: true,
      async preflight() {
        assertActive();
        if (preflightEvidence) return preflightEvidence;
        let observed;
        try {
          observed = await custodian.preflight();
          preflightEvidence = validatePreflight(observed, keyFingerprint);
          return preflightEvidence;
        } catch {
          try { await disposeInternal(); } catch { /* the preflight failure remains authoritative */ }
          throw new ReleaseRuntimeError('provider custody preflight failed', 'ERR_RELEASE_RUNTIME_PROVIDER');
        }
      },
    });

    async function trialExecutor(request) {
      assertActive();
      if (!preflightEvidence) invalid('provider preflight must complete before a paid trial');
      exactKeys(request, ['trial', 'harbor'], 'isolated trial request');
      if (!plainObject(request.trial) || !plainObject(request.harbor)) {
        invalid('isolated trial request is malformed');
      }
      const trialId = safeId(request.trial.trialId, 'trialId');
      const taskId = safeId(request.trial.task, 'taskId');
      if (!['generic', 'harness'].includes(request.trial.condition)) invalid('trial condition is invalid');
      if (request.trial.profileId !== profileId) invalid('trial profile binding drifted');
      if (attemptedTrials.has(trialId)) invalid('trial identity was already attempted');
      const taskImage = runtimeProjection.taskImages[taskId];
      if (!plainObject(taskImage) || typeof taskImage.imageId !== 'string' || !IMAGE_DIGEST.test(taskImage.imageId)) {
        invalid('trial task has no locked runtime image');
      }
      const trialCeilingMicrousd = exactMicrousd(request.trial.ceilingUsd, 'trial ceiling');
      if (trialCeilingMicrousd > sessionCeilingMicrousd) {
        invalid('trial ceiling exceeds the signed session budget');
      }
      const spec = deepFreeze({
        trialId,
        taskId,
        condition: request.trial.condition,
        imageDigest: taskImage.imageId,
        trialCeilingMicrousd,
        supervisorExecutableHash: runtimeProjection.executables.supervisor.sha256,
        runnerExecutableHash: runtimeProjection.executables.runner.sha256,
        harborExecutableHash: runtimeProjection.executables.harbor.sha256,
      });
      attemptedTrials.add(trialId);
      let prepared;
      try {
        prepared = validateArchive(components.createTrialInputArchive({
          ...request,
          trial: { ...request.trial, executionMode: 'controlled-provider' },
        }), trialId);
        pendingArchives.set(trialId, { bytes: prepared.bytes, specHash: canonicalSha256(spec) });
        const completed = await sessionController.runTrial(spec, async ({ handle, authorization }) => {
          const executed = await trialTransport.executeTrial({ handle, authorization });
          const output = executed?.outputArchive;
          if (!plainObject(output) || !Buffer.isBuffer(output.bytes) ||
              output.byteLength !== output.bytes.length || !HASH.test(String(output.sha256 ?? '')) ||
              crypto.createHash('sha256').update(output.bytes).digest('hex') !== output.sha256) {
            output?.bytes?.fill?.(0);
            invalid('runtime trial output archive is malformed or drifted');
          }
          try {
            return components.applyTrialOutputArchive({
              bytes: output.bytes,
              expectedSha256: output.sha256,
              expectedByteLength: output.byteLength,
              materialization: prepared.materialization,
            });
          } finally {
            output.bytes.fill(0);
          }
        });
        if (!plainObject(completed) || !plainObject(completed.result) || !plainObject(completed.attestation) ||
            completed.attestation.schema !== 'engineer-runtime-trial-final-attestation.v1') {
          invalid('runtime session returned incomplete trial evidence');
        }
        return deepFreeze({
          run: clone(completed.result, 'Harbor run result'),
          runtimeEvidence: {
            schema: completed.attestation.schema,
            evidenceHash: components.trialEvidenceHash(completed.attestation),
            providerSpendMicrousd: completed.attestation.outcome.providerSpendMicrousd,
          },
        });
      } catch (error) {
        const retained = pendingArchives.get(trialId);
        retained?.bytes.fill(0);
        pendingArchives.delete(trialId);
        boundAllocations.delete(trialId);
        throw error instanceof ReleaseRuntimeError
          ? error
          : new ReleaseRuntimeError('isolated paid trial failed closed', 'ERR_RELEASE_RUNTIME_TRIAL');
      }
    }

    const runtimeSession = Object.freeze({
      readiness: () => sessionController.readiness(),
      async finalize() {
        assertActive();
        if (!preflightEvidence) invalid('provider preflight must complete before session finalization');
        if (pendingArchives.size > 0 || boundAllocations.size > 0) {
          invalid('session finalization found an incomplete trial handoff');
        }
        try {
          const final = await sessionController.finalize();
          const spent = final?.budget?.sessionSpentMicrousd;
          integer(spent, 'runtime final session spend', 0, sessionCeilingMicrousd);
          const reconciliation = await custodian.postflight({ sessionSpentMicrousd: spent });
          providerReconciliation = validateReconciliation(reconciliation, keyFingerprint);
          custodian.dispose();
          rootHmacKey.fill(0);
          finalized = true;
          return final;
        } catch {
          try { await disposeInternal(); } catch { /* finalization is already untrusted */ }
          throw new ReleaseRuntimeError(
            'runtime finalization or provider allowance reconciliation failed',
            'ERR_RELEASE_RUNTIME_FINALIZATION'
          );
        }
      },
      providerEvidence: () => providerReconciliation,
    });

    function snapshot() {
      return deepFreeze({
        schema: 'engineer-release-runtime-snapshot.v1',
        sessionId,
        releaseSha,
        profileId,
        topologyManifestHash: runtimeProjection.topologyManifest.hash,
        snapshotBuildHash: runtimeProjection.snapshot.buildHash,
        disposed,
        finalized,
        providerPreflightComplete: preflightEvidence != null,
        providerReconciliation,
        pendingTrialArchives: pendingArchives.size,
        attemptedTrialCount: attemptedTrials.size,
        session: clone(sessionController.snapshot(), 'runtime session snapshot'),
        daytona: clone(daytonaController.snapshot(), 'Daytona session snapshot'),
        credential: clone(custodian.snapshot(), 'credential custodian snapshot'),
      });
    }

    return Object.freeze({
      runtimeSession,
      providerControl,
      trialExecutor,
      snapshot,
      dispose: disposeInternal,
    });
  } catch (error) {
    try { await disposeInternal(); } catch { /* construction remains failed closed */ }
    if (error instanceof ReleaseRuntimeError) throw error;
    throw constructionFailure();
  }
}
