import {
  GENESIS_CHAIN_HASH,
  ProtocolReplayGuard,
  appendTrialHashChain,
  canonicalSha256,
  generateNonce,
  protocolDocumentHash,
  sha256Hex,
  signProtocolDocument,
  verifyProtocolDocument,
  verifyReadinessLeaseForRequest,
  verifySessionTrialHashChain,
  verifyTrialAttestationForLease,
} from './protocol.mjs';

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DAYTONA_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_MICROUSD = 20_000_000;
const MAX_REQUEST_LIFETIME_MS = 60 * 60 * 1_000;
const MAX_FINAL_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TRANSPORT_TIMEOUT_MS = 10 * 60 * 1_000;

const controllerReadinessBrand = new WeakSet();
const sessionFinalBrand = new WeakSet();

const SESSION_FIELDS = Object.freeze([
  'sessionId',
  'releaseSha',
  'profileId',
  'taskLockHash',
  'bundleHash',
  'budgetId',
  'budgetPolicyHash',
  'brokerPolicyHash',
  'sessionCeilingMicrousd',
]);

const TRIAL_FIELDS = Object.freeze([
  'trialId',
  'taskId',
  'condition',
  'imageDigest',
  'trialCeilingMicrousd',
  'supervisorExecutableHash',
  'runnerExecutableHash',
  'harborExecutableHash',
]);

const RUNTIME_BINDING_FIELDS = Object.freeze([
  'sandboxBootId',
  'daemonId',
  'daemonRootHash',
  'cgroupId',
  'cgroupPathHash',
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value, fields, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const expected = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${label} contains unknown field ${key}`);
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new TypeError(`${label} is missing required field ${field}`);
    }
  }
  return value;
}

function safeId(value, label, maximum = 128) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must be a safe identifier`);
  }
  return value;
}

function daytonaId(value, label) {
  if (typeof value !== 'string' || !DAYTONA_ID.test(value)) {
    throw new TypeError(`${label} must be a Daytona-safe identifier`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new TypeError(`${label} must be a SHA-256 hash`);
  return value;
}

function microusd(value, label, { positive = false } = {}) {
  const minimum = positive ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_MICROUSD) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${MAX_MICROUSD}`);
  }
  return value;
}

function normalizedKey(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be supplied as bytes`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length < 32 || bytes.length > 128) {
    bytes.fill(0);
    throw new TypeError(`${label} must contain 32-128 bytes`);
  }
  return bytes;
}

function keyId(value, label) {
  if (typeof value !== 'string' || value.length > 64 || !KEY_ID.test(value)) {
    throw new TypeError(`${label} must be a safe key identifier`);
  }
  return value;
}

function positiveDuration(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function currentDate(now) {
  const observed = now();
  const value = observed instanceof Date ? new Date(observed.getTime()) : new Date(observed);
  if (!Number.isFinite(value.getTime())) throw new Error('runtime controller clock returned an invalid instant');
  return value;
}

function expiresAt(issued, lifetimeMs) {
  return new Date(issued.getTime() + lifetimeMs).toISOString();
}

function errorHash(error) {
  const name = typeof error?.name === 'string' ? error.name.slice(0, 128) : 'Error';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 4_096) : 'runtime failure';
  return sha256Hex(`${name}\0${message}`);
}

function dollarsToMicrousd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Daytona reservation total is invalid');
  }
  const converted = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(converted) || Math.abs(value - converted / 1_000_000) > 1e-12) {
    throw new Error('Daytona reservation total is not exactly representable in microusd');
  }
  return converted;
}

function validateSession(input) {
  const value = structuredClone(exactObject(input, SESSION_FIELDS, 'session'));
  safeId(value.sessionId, 'session.sessionId');
  if (typeof value.releaseSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.releaseSha)) {
    throw new TypeError('session.releaseSha must be a full hexadecimal commit identity');
  }
  safeId(value.profileId, 'session.profileId');
  hash(value.taskLockHash, 'session.taskLockHash');
  hash(value.bundleHash, 'session.bundleHash');
  safeId(value.budgetId, 'session.budgetId');
  hash(value.budgetPolicyHash, 'session.budgetPolicyHash');
  hash(value.brokerPolicyHash, 'session.brokerPolicyHash');
  microusd(value.sessionCeilingMicrousd, 'session.sessionCeilingMicrousd', { positive: true });
  return deepFreeze(value);
}

function validateTrialSpec(input) {
  const value = structuredClone(exactObject(input, TRIAL_FIELDS, 'trial'));
  daytonaId(value.trialId, 'trial.trialId');
  daytonaId(value.taskId, 'trial.taskId');
  if (!['generic', 'harness'].includes(value.condition)) {
    throw new TypeError('trial.condition must be generic or harness');
  }
  if (typeof value.imageDigest !== 'string' || !IMAGE_DIGEST.test(value.imageDigest)) {
    throw new TypeError('trial.imageDigest must be a pinned SHA-256 image digest');
  }
  microusd(value.trialCeilingMicrousd, 'trial.trialCeilingMicrousd', { positive: true });
  hash(value.supervisorExecutableHash, 'trial.supervisorExecutableHash');
  hash(value.runnerExecutableHash, 'trial.runnerExecutableHash');
  hash(value.harborExecutableHash, 'trial.harborExecutableHash');
  return deepFreeze(value);
}

function validateRuntimeBindings(input) {
  const value = structuredClone(exactObject(input, RUNTIME_BINDING_FIELDS, 'runtime bindings'));
  safeId(value.sandboxBootId, 'runtimeBindings.sandboxBootId', 192);
  safeId(value.daemonId, 'runtimeBindings.daemonId', 192);
  hash(value.daemonRootHash, 'runtimeBindings.daemonRootHash');
  safeId(value.cgroupId, 'runtimeBindings.cgroupId', 192);
  hash(value.cgroupPathHash, 'runtimeBindings.cgroupPathHash');
  return deepFreeze(value);
}

function validateDependencies(daytonaController, transport) {
  const daytonaMethods = ['beginTrial', 'completeTrial', 'abortTrial', 'finalizeSession', 'snapshot'];
  const transportMethods = ['prepareTrial', 'requestReadiness', 'requestFinal', 'closeTrial'];
  if (!daytonaController || daytonaMethods.some((name) => typeof daytonaController[name] !== 'function')) {
    throw new TypeError(`daytonaController must implement ${daytonaMethods.join(', ')}`);
  }
  if (!transport || transportMethods.some((name) => typeof transport[name] !== 'function')) {
    throw new TypeError(`transport must implement ${transportMethods.join(', ')}`);
  }
}

/** Only in-process values issued by this module can satisfy this predicate. */
export function isRuntimeControllerReadiness(value) {
  return isPlainObject(value) && controllerReadinessBrand.has(value);
}

/** Only an authenticated, reconciled, and finalized in-process session can satisfy this predicate. */
export function isRuntimeSessionFinal(value) {
  return isPlainObject(value) && sessionFinalBrand.has(value);
}

export function createRuntimeSessionController({
  daytonaController,
  transport,
  session: sessionInput,
  controllerKey: controllerKeyInput,
  controllerKeyId = 'runtime-controller-hmac-1',
  supervisorKey: supervisorKeyInput,
  supervisorKeyId = 'runtime-supervisor-hmac-1',
  now = () => new Date(),
  nonceGenerator = generateNonce,
  requestLifetimeMs = MAX_REQUEST_LIFETIME_MS,
  finalLifetimeMs = 24 * 60 * 60 * 1_000,
  transportTimeoutMs = 5 * 60 * 1_000,
} = {}) {
  validateDependencies(daytonaController, transport);
  const session = validateSession(sessionInput);
  let controllerKey;
  let supervisorKey;
  try {
    controllerKey = normalizedKey(controllerKeyInput, 'controllerKey');
    supervisorKey = normalizedKey(supervisorKeyInput, 'supervisorKey');
    keyId(controllerKeyId, 'controllerKeyId');
    keyId(supervisorKeyId, 'supervisorKeyId');
    if (typeof now !== 'function' || typeof nonceGenerator !== 'function') {
      throw new TypeError('now and nonceGenerator must be functions');
    }
    positiveDuration(requestLifetimeMs, 'requestLifetimeMs', MAX_REQUEST_LIFETIME_MS);
    positiveDuration(finalLifetimeMs, 'finalLifetimeMs', MAX_FINAL_LIFETIME_MS);
    positiveDuration(transportTimeoutMs, 'transportTimeoutMs', MAX_TRANSPORT_TIMEOUT_MS);
  } catch (error) {
    controllerKey?.fill(0);
    supervisorKey?.fill(0);
    throw error;
  }

  const replayGuard = new ProtocolReplayGuard({ sessionId: session.sessionId });
  const handles = new WeakSet();
  const seenTrialIds = new Set();
  const trials = [];
  let active;
  let committedMicrousd = 0;
  let spentMicrousd = 0;
  let chainHead = GENESIS_CHAIN_HASH;
  let beginning = false;
  let failStopped = false;
  let failureDigest;
  let finalized = false;
  let disposed = false;
  let disposalPromise;
  let beginSettlement = Promise.resolve();
  let disposedProvisioningDeleted = false;
  let cleanupIncomplete = false;
  let keyMaterialDisposed = false;

  function disposeKeyMaterial() {
    if (keyMaterialDisposed) return;
    controllerKey.fill(0);
    supervisorKey.fill(0);
    keyMaterialDisposed = true;
  }

  const controllerReadiness = deepFreeze({
    schema: 'engineer-runtime-controller-readiness.v1',
    protocolVersion: 1,
    source: 'external-controller',
    sessionId: session.sessionId,
    releaseSha: session.releaseSha,
    runtimeAttested: false,
    providerAuthorized: false,
    perTrialSandboxRequired: true,
    wholeSandboxDeletionRequired: true,
    authenticatedSupervisorEvidenceRequired: true,
    exactBudgetReconciliationRequired: true,
  });
  controllerReadinessBrand.add(controllerReadiness);

  function ensureOpen() {
    if (disposed) throw new Error('runtime session is disposed');
    if (finalized) throw new Error('runtime session is finalized');
    if (failStopped) throw new Error('runtime session is fail-stopped after compromised runtime evidence');
  }

  function freshNonce() {
    const nonce = nonceGenerator();
    return hash(nonce, 'protocol nonce');
  }

  async function callTransport(method, payload) {
    const abort = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`runtime transport ${method} timed out`));
      }, transportTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        Promise.resolve(transport[method]({ ...payload, signal: abort.signal })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function markFailStopped(error) {
    failStopped = true;
    if (!failureDigest) failureDigest = errorHash(error);
    disposeKeyMaterial();
  }

  async function closeTransport(record, reasonHash) {
    if (record.transportClosed || !record.channelReady) return;
    await callTransport('closeTrial', {
      channel: record.channel,
      trialId: record.spec.trialId,
      reasonHash,
    });
    record.transportClosed = true;
    record.channelReady = false;
    record.channel = undefined;
  }

  function cleanupRecord(record, reasonHash) {
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = (async () => {
      const failureHashes = [];
      try {
        await closeTransport(record, reasonHash);
      } catch (error) {
        failureHashes.push(errorHash(error));
      }
      try {
        await daytonaController.abortTrial({
          trialId: record.spec.trialId,
          reason: `runtime-fail-stop:${reasonHash}`,
        });
      } catch (error) {
        failureHashes.push(errorHash(error));
      } finally {
        record.channel = undefined;
        record.channelReady = false;
        if (active === record) active = undefined;
      }
      return deepFreeze({
        deleted: failureHashes.length === 0,
        failureHashes,
      });
    })();
    return record.cleanupPromise;
  }

  async function cleanupFailedActive(error, label) {
    markFailStopped(error);
    const record = active;
    if (!record) throw error;
    const reasonHash = errorHash(error);
    const cleanup = await cleanupRecord(record, reasonHash);
    if (!cleanup.deleted) {
      cleanupIncomplete = true;
      throw new Error(`${label} failed and cleanup was incomplete`);
    }
    throw error;
  }

  function requireActive(handle, phases) {
    if (!isPlainObject(handle) || !handles.has(handle) || !active || active.handle !== handle) {
      throw new Error('trial handle is not the active runtime allocation');
    }
    if (!phases.includes(active.phase)) throw new Error(`trial is not in the required ${phases.join('/')} phase`);
    return active;
  }

  function buildRequest(record, prepared) {
    const issued = currentDate(now);
    const request = {
      schema: 'engineer-runtime-trial-request.v1',
      protocolVersion: 1,
      sessionId: session.sessionId,
      trialId: record.spec.trialId,
      sequence: replayGuard.lastSequence + 1,
      nonce: freshNonce(),
      issuedAt: issued.toISOString(),
      expiresAt: expiresAt(issued, requestLifetimeMs),
      previousTrialChainHash: chainHead,
      bindings: {
        releaseSha: session.releaseSha,
        profileId: session.profileId,
        taskId: record.spec.taskId,
        taskLockHash: session.taskLockHash,
        bundleHash: session.bundleHash,
        condition: record.spec.condition,
        imageDigest: record.spec.imageDigest,
        sandboxId: safeId(record.opened.allocation.id, 'Daytona allocation id'),
        sandboxBootId: prepared.runtimeBindings.sandboxBootId,
        daemonId: prepared.runtimeBindings.daemonId,
        daemonRootHash: prepared.runtimeBindings.daemonRootHash,
        cgroupId: prepared.runtimeBindings.cgroupId,
        cgroupPathHash: prepared.runtimeBindings.cgroupPathHash,
        budgetId: session.budgetId,
        budgetPolicyHash: session.budgetPolicyHash,
        brokerPolicyHash: session.brokerPolicyHash,
        supervisorExecutableHash: record.spec.supervisorExecutableHash,
        runnerExecutableHash: record.spec.runnerExecutableHash,
        harborExecutableHash: record.spec.harborExecutableHash,
      },
      budget: {
        currency: 'USD',
        trialCeilingMicrousd: record.spec.trialCeilingMicrousd,
        sessionCeilingMicrousd: session.sessionCeilingMicrousd,
        sessionCommittedMicrousd: committedMicrousd + record.spec.trialCeilingMicrousd,
      },
    };
    const signed = signProtocolDocument(request, controllerKey, { keyId: controllerKeyId });
    return verifyProtocolDocument(signed, controllerKey, {
      expectedKeyId: controllerKeyId,
      now: issued,
      replayGuard,
    });
  }

  async function beginTrial(input) {
    ensureOpen();
    if (active || beginning) throw new Error('the runtime session permits only one active per-trial sandbox');
    const spec = validateTrialSpec(input);
    if (seenTrialIds.has(spec.trialId)) throw new Error(`trialId was already used: ${spec.trialId}`);
    if (committedMicrousd + spec.trialCeilingMicrousd > session.sessionCeilingMicrousd) {
      throw new Error('trial reservation exceeds the external session budget');
    }

    let opened;
    let settleBeginning;
    beginSettlement = new Promise((resolve) => { settleBeginning = resolve; });
    beginning = true;
    try {
      opened = await daytonaController.beginTrial({
        trialId: spec.trialId,
        task: spec.taskId,
        condition: spec.condition,
        reservedUsd: spec.trialCeilingMicrousd / 1_000_000,
      });
      if (disposed) {
        let deleted = false;
        try {
          await daytonaController.abortTrial({
            trialId: spec.trialId,
            reason: `runtime-fail-stop:${sha256Hex('runtime-session-disposed')}`,
          });
          deleted = true;
          disposedProvisioningDeleted = true;
        } catch {
          // The public disposal path reports only a content-free cleanup failure.
        }
        if (!deleted) {
          cleanupIncomplete = true;
          throw new Error('runtime session disposal cleanup failed');
        }
        throw new Error('runtime session is disposed');
      }
    } catch (error) {
      markFailStopped(error);
      if (disposed) {
        if (cleanupIncomplete) throw new Error('runtime session disposal cleanup failed');
        throw new Error('runtime session is disposed');
      }
      throw error;
    } finally {
      beginning = false;
      settleBeginning();
    }

    const record = {
      spec,
      opened,
      phase: 'provisioning',
      channel: undefined,
      channelReady: false,
      transportClosed: false,
    };
    active = record;
    try {
      const preparedInput = await callTransport('prepareTrial', {
        allocation: structuredClone(opened.allocation),
        provisioning: structuredClone(opened.readiness),
        spec: structuredClone(spec),
      });
      ensureOpen();
      const prepared = exactObject(preparedInput, ['channel', 'runtimeBindings'], 'prepared trial');
      if (prepared.channel === undefined || prepared.channel === null) {
        throw new Error('prepared trial is missing its inherited supervisor channel');
      }
      record.channel = prepared.channel;
      record.channelReady = true;
      const verifiedPreparation = {
        runtimeBindings: validateRuntimeBindings(prepared.runtimeBindings),
      };
      record.request = buildRequest(record, verifiedPreparation);
      committedMicrousd += spec.trialCeilingMicrousd;
      seenTrialIds.add(spec.trialId);
      record.phase = 'requested';
      const handle = deepFreeze({
        schema: 'engineer-runtime-trial-handle.v1',
        sessionId: session.sessionId,
        trialId: spec.trialId,
        request: structuredClone(record.request),
      });
      handles.add(handle);
      record.handle = handle;
      return handle;
    } catch (error) {
      return cleanupFailedActive(error, 'trial request provisioning');
    }
  }

  async function verifyTrialReadiness(handle) {
    ensureOpen();
    const record = requireActive(handle, ['requested']);
    record.phase = 'readiness-pending';
    try {
      const candidate = await callTransport('requestReadiness', {
        channel: record.channel,
        request: structuredClone(record.request),
      });
      ensureOpen();
      const lease = verifyProtocolDocument(candidate, supervisorKey, {
        expectedKeyId: supervisorKeyId,
        now: currentDate(now),
        replayGuard,
      });
      verifyReadinessLeaseForRequest(lease, record.request);
      if (lease.readiness.brokerPolicyHash !== session.brokerPolicyHash) {
        throw new Error('readiness broker static policy hash does not match the signed session broker policy');
      }
      record.readinessLease = lease;
      record.phase = 'authorized';
      return deepFreeze({
        schema: 'engineer-runtime-trial-authorization.v1',
        sessionId: session.sessionId,
        trialId: record.spec.trialId,
        providerAuthorized: true,
        readinessLeaseHash: protocolDocumentHash(lease),
        readinessLease: structuredClone(lease),
      });
    } catch (error) {
      return cleanupFailedActive(error, 'runtime readiness verification');
    }
  }

  function deletionReceipt(record, platformReceipt, deletionRequestedAt) {
    if (!isPlainObject(platformReceipt)
        || platformReceipt.deleted !== true
        || platformReceipt.trialId !== record.spec.trialId
        || platformReceipt.sandboxId !== record.request.bindings.sandboxId
        || typeof platformReceipt.deletedAt !== 'string') {
      throw new Error('Daytona whole-sandbox deletion receipt is invalid or mismatched');
    }
    return {
      trialId: record.spec.trialId,
      sandboxId: record.request.bindings.sandboxId,
      deletionRequestId: `daytona-delete-${trials.length + 1}-${canonicalSha256(record.spec.trialId).slice(0, 24)}`,
      deletionRequestedAt,
      observedAbsentAt: platformReceipt.deletedAt,
      platformEvidenceHash: canonicalSha256(platformReceipt),
    };
  }

  async function completeTrial(handle) {
    ensureOpen();
    const record = requireActive(handle, ['authorized']);
    record.phase = 'finalizing';
    try {
      const candidate = await callTransport('requestFinal', {
        channel: record.channel,
        request: structuredClone(record.request),
        readinessLease: structuredClone(record.readinessLease),
      });
      ensureOpen();
      const attestation = verifyProtocolDocument(candidate, supervisorKey, {
        expectedKeyId: supervisorKeyId,
        now: currentDate(now),
        replayGuard,
      });
      verifyTrialAttestationForLease(attestation, record.readinessLease, record.request);
      if (spentMicrousd + attestation.outcome.providerSpendMicrousd > committedMicrousd) {
        throw new Error('attested provider spend exceeds the exact committed session budget');
      }

      await closeTransport(record, protocolDocumentHash(attestation));
      ensureOpen();
      const requestedAt = currentDate(now).toISOString();
      const platformReceipt = await daytonaController.completeTrial({
        trialId: record.spec.trialId,
        evidence: { evidenceHash: protocolDocumentHash(attestation) },
      });
      ensureOpen();
      const receipt = deletionReceipt(record, platformReceipt, requestedAt);
      const chainEntry = appendTrialHashChain({
        order: trials.length + 1,
        previousChainHash: chainHead,
        trialAttestation: attestation,
        deletionReceipt: receipt,
      });
      const retained = {
        request: record.request,
        readinessLease: record.readinessLease,
        attestation,
        deletionReceipt: receipt,
        chainEntry,
      };
      trials.push(retained);
      chainHead = chainEntry.chainHash;
      spentMicrousd += attestation.outcome.providerSpendMicrousd;
      record.channel = undefined;
      active = undefined;
      return {
        attestation: structuredClone(attestation),
        deletionReceipt: structuredClone(receipt),
        chainEntry: structuredClone(chainEntry),
      };
    } catch (error) {
      return cleanupFailedActive(error, 'trial finalization');
    }
  }

  async function abortTrial(handle, reason = 'trial aborted') {
    ensureOpen();
    requireActive(handle, ['requested', 'authorized']);
    const error = new Error('runtime trial was aborted');
    const suppliedReasonHash = sha256Hex(String(reason).slice(0, 4_096));
    error.reasonHash = suppliedReasonHash;
    try {
      await cleanupFailedActive(error, 'runtime trial abort');
    } catch (failure) {
      if (failure === error) {
        return deepFreeze({
          schema: 'engineer-runtime-trial-abort.v1',
          trialId: handle.trialId,
          reasonHash: suppliedReasonHash,
          deleted: true,
        });
      }
      throw failure;
    }
    throw new Error('unreachable runtime abort state');
  }

  async function runTrial(spec, executeProviderWork) {
    if (typeof executeProviderWork !== 'function') throw new TypeError('executeProviderWork must be a function');
    const handle = await beginTrial(spec);
    let authorization;
    try {
      authorization = await verifyTrialReadiness(handle);
      const result = await executeProviderWork({ handle, authorization });
      const completed = await completeTrial(handle);
      return { result, ...completed };
    } catch (error) {
      if (active?.handle === handle) {
        return cleanupFailedActive(error, 'provider execution');
      }
      throw error;
    }
  }

  function finalize() {
    ensureOpen();
    if (active || beginning) throw new Error('cannot finalize a runtime session with an active trial');
    if (trials.length === 0) throw new Error('cannot finalize a runtime session without completed trials');
    try {
      const platform = daytonaController.finalizeSession();
      if (!isPlainObject(platform)
          || platform.deleted !== true
          || !Array.isArray(platform.trials)
          || platform.trials.length !== trials.length
          || dollarsToMicrousd(platform.reservedUsd) !== committedMicrousd) {
        throw new Error('Daytona session deletion evidence does not reconcile exactly');
      }
      for (let index = 0; index < trials.length; index += 1) {
        const expected = trials[index];
        const observed = platform.trials[index];
        if (!isPlainObject(observed)
            || observed.deleted !== true
            || observed.trialId !== expected.attestation.trialId
            || observed.sandboxId !== expected.attestation.bindings.sandboxId
            || observed.evidenceHash !== protocolDocumentHash(expected.attestation)) {
          throw new Error('Daytona ordered deletion evidence does not match authenticated trial evidence');
        }
      }

      const evidenceArchiveHash = canonicalSha256({
        schema: 'engineer-runtime-evidence-archive-manifest.v1',
        sessionId: session.sessionId,
        requests: trials.map((entry) => canonicalSha256(entry.request)),
        readinessLeases: trials.map((entry) => canonicalSha256(entry.readinessLease)),
        trialAttestations: trials.map((entry) => canonicalSha256(entry.attestation)),
        deletionReceipts: trials.map((entry) => canonicalSha256(entry.deletionReceipt)),
        daytonaDeletionSummary: canonicalSha256(platform),
      });
      const issued = currentDate(now);
      const unsigned = {
        schema: 'engineer-runtime-session-final-attestation.v1',
        protocolVersion: 1,
        sessionId: session.sessionId,
        sequence: replayGuard.lastSequence + 1,
        nonce: freshNonce(),
        issuedAt: issued.toISOString(),
        expiresAt: expiresAt(issued, finalLifetimeMs),
        sessionBindings: {
          releaseSha: session.releaseSha,
          profileId: session.profileId,
          taskLockHash: session.taskLockHash,
          bundleHash: session.bundleHash,
          budgetId: session.budgetId,
          budgetPolicyHash: session.budgetPolicyHash,
          brokerPolicyHash: session.brokerPolicyHash,
        },
        trials: trials.map((entry) => structuredClone(entry.chainEntry)),
        chainHead,
        budget: {
          currency: 'USD',
          sessionCeilingMicrousd: session.sessionCeilingMicrousd,
          sessionCommittedMicrousd: committedMicrousd,
          sessionSpentMicrousd: spentMicrousd,
        },
        evidenceArchiveHash,
      };
      const signed = signProtocolDocument(unsigned, controllerKey, { keyId: controllerKeyId });
      const verified = verifyProtocolDocument(signed, controllerKey, {
        expectedKeyId: controllerKeyId,
        now: issued,
        replayGuard,
      });
      verifySessionTrialHashChain(verified, trials.map((entry) => entry.attestation));
      deepFreeze(verified);
      sessionFinalBrand.add(verified);
      finalized = true;
      disposeKeyMaterial();
      return verified;
    } catch (error) {
      markFailStopped(error);
      throw error;
    }
  }

  function readiness() {
    ensureOpen();
    return controllerReadiness;
  }

  function dispose() {
    if (disposalPromise) return disposalPromise;
    disposed = true;
    if (!finalized) {
      failStopped = true;
      if (!failureDigest) failureDigest = sha256Hex('runtime-session-disposed');
    }
    disposeKeyMaterial();

    disposalPromise = (async () => {
      await beginSettlement;
      let activeTrialDeleted = disposedProvisioningDeleted;
      const record = active;
      if (record) {
        const cleanup = await cleanupRecord(record, sha256Hex('runtime-session-disposed'));
        activeTrialDeleted = cleanup.deleted;
        if (!cleanup.deleted) cleanupIncomplete = true;
      }
      if (cleanupIncomplete) {
        throw new Error('runtime session disposal cleanup failed');
      }
      return deepFreeze({
        schema: 'engineer-runtime-session-disposal.v1',
        sessionId: session.sessionId,
        disposed: true,
        activeTrialDeleted,
      });
    })();
    return disposalPromise;
  }

  function snapshot() {
    return {
      schema: 'engineer-runtime-session-snapshot.v1',
      sessionId: session.sessionId,
      releaseSha: session.releaseSha,
      sessionCeilingMicrousd: session.sessionCeilingMicrousd,
      committedMicrousd,
      spentMicrousd,
      chainHead,
      failStopped,
      finalized,
      disposed,
      keyMaterialDisposed,
      ...(failureDigest ? { failureHash: failureDigest } : {}),
      ...(active ? {
        activeTrial: {
          trialId: active.spec.trialId,
          phase: active.phase,
          sandboxId: active.opened.allocation.id,
        },
      } : {}),
      trials: trials.map((entry, index) => ({
        order: index + 1,
        trialId: entry.attestation.trialId,
        condition: entry.attestation.bindings.condition,
        attestationHash: protocolDocumentHash(entry.attestation),
        deletionReceiptHash: entry.chainEntry.deletionReceiptHash,
        chainHash: entry.chainEntry.chainHash,
        providerSpendMicrousd: entry.attestation.outcome.providerSpendMicrousd,
      })),
    };
  }

  return Object.freeze({
    readiness,
    beginTrial,
    verifyTrialReadiness,
    completeTrial,
    abortTrial,
    runTrial,
    finalize,
    dispose,
    snapshot,
  });
}
