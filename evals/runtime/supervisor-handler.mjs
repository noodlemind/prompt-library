import { TextDecoder } from 'node:util';

import { archiveLimitsForKind } from './archive-limits.mjs';
import {
  MAX_PROTOCOL_BYTES,
  RuntimeControlFailureSchema,
  RuntimeExecutionModes,
  canonicalJson,
  canonicalSha256,
  protocolDocumentHash,
  signRuntimeControlFailure,
  validateProtocolDocument,
  verifyProtocolDocument,
} from './protocol.mjs';
import {
  createRuntimeSupervisor,
  readRuntimeSupervisorFailureDiagnostic,
} from './supervisor.mjs';

const CONTROL_GENESIS_HASH = '0'.repeat(64);
const CONTROL_REQUEST_SCHEMA = 'engineer-runtime-control-request.v1';
const CONTROL_RESPONSE_SCHEMA = 'engineer-runtime-control-response.v1';
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SECRET_FIELD = /^(?:api[_-]?key|authorization|credential|hmac[_-]?key|password|provider[_-]?key|secret|token)$/i;
const SECRET_VALUE = /^(?:Bearer\s+|sk-[A-Za-z0-9_-]{8,})/i;

export class SupervisorHandlerError extends Error {
  constructor(message, code = 'ERR_RUNTIME_SUPERVISOR_HANDLER') {
    super(message);
    this.name = 'SupervisorHandlerError';
    this.code = code;
  }
}

function invalid(message, code = 'ERR_RUNTIME_SUPERVISOR_HANDLER_POLICY') {
  throw new SupervisorHandlerError(message, code);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, fields, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const expected = new Set(fields);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    invalid(`${label} contains an unexpected field`);
  }
}

function exactDataKeys(value, fields, label) {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(`${label} must be a plain data object`);
  }
  const names = Object.getOwnPropertyNames(value);
  const expected = new Set(fields);
  if (names.length !== expected.size || names.some((name) => !expected.has(name))) {
    invalid(`${label} contains an unexpected field`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) {
      invalid(`${label} contains an unsafe field`);
    }
  }
}

function safeId(value, label, maximum = 192) {
  if (typeof value !== 'string'
      || Buffer.byteLength(value, 'utf8') < 1
      || Buffer.byteLength(value, 'utf8') > maximum
      || !SAFE_ID.test(value)) {
    invalid(`${label} must be a bounded safe identifier`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) invalid(`${label} must be a SHA-256 digest`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is outside its integer bound`);
  }
  return value;
}

function executionMode(value) {
  if (!Object.values(RuntimeExecutionModes).includes(value)) {
    invalid('execution mode must be controlled-provider or zero-provider-canary');
  }
  return value;
}

function credentialFree(value, label) {
  let nodes = 0;
  function visit(current, depth) {
    nodes += 1;
    if (nodes > 8_192 || depth > 24) invalid(`${label} exceeds its structure bound`);
    if (typeof current === 'string') {
      if (SECRET_VALUE.test(current)) invalid(`${label} contains secret material`);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (SECRET_FIELD.test(key)) invalid(`${label} contains a secret-bearing field`);
      visit(entry, depth + 1);
    }
  }
  visit(value, 0);
}

function cloneBoundedJson(value, label) {
  const ancestors = new WeakSet();
  let nodes = 0;
  function visit(current, depth) {
    nodes += 1;
    if (nodes > 8_192 || depth > 24) invalid(`${label} exceeds its structure bound`);
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) invalid(`${label} contains an unsafe number`);
      return current;
    }
    if (typeof current !== 'object' || ancestors.has(current)) invalid(`${label} contains unsafe data`);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const output = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
            invalid(`${label} contains an unsafe array field`);
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        if (Object.getOwnPropertyNames(current).length !== current.length + 1) {
          invalid(`${label} contains non-JSON array data`);
        }
        return output;
      }
      if (!isPlainObject(current)) invalid(`${label} must contain only plain objects`);
      const output = {};
      const keys = Object.keys(current);
      if (Object.getOwnPropertyNames(current).length !== keys.length) {
        invalid(`${label} contains non-enumerable data`);
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
          invalid(`${label} contains an unsafe object field`);
        }
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  }
  const clone = visit(value, 0);
  const encoded = JSON.stringify(clone);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROTOCOL_BYTES) invalid(`${label} exceeds its byte bound`);
  credentialFree(clone, label);
  return clone;
}

function parseFrame(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) invalid('control frame must be bytes');
  const bytes = Buffer.from(input);
  if (bytes.length < 1 || bytes.length > MAX_PROTOCOL_BYTES) {
    bytes.fill(0);
    invalid('control frame exceeds its byte bound');
  }
  let text;
  let value;
  try {
    text = UTF8.decode(bytes);
    value = JSON.parse(text);
    if (!isPlainObject(value) || canonicalJson(value) !== text) {
      invalid('control frame must use exact canonical JSON');
    }
    credentialFree(value, 'control frame');
    return value;
  } catch (error) {
    if (error instanceof SupervisorHandlerError) throw error;
    invalid('control frame is malformed or noncanonical');
  } finally {
    bytes.fill(0);
  }
}

function encodeFrame(value) {
  let bytes;
  try {
    credentialFree(value, 'control response');
    bytes = Buffer.from(canonicalJson(value));
  } catch (error) {
    if (error instanceof SupervisorHandlerError) throw error;
    invalid('control response is not bounded canonical JSON');
  }
  if (bytes.length < 1 || bytes.length > MAX_PROTOCOL_BYTES) {
    bytes.fill(0);
    invalid('control response exceeds its byte bound');
  }
  return bytes;
}

function validateRuntimeBindings(value) {
  exactKeys(value, [
    'sandboxBootId',
    'daemonId',
    'daemonRootHash',
    'cgroupId',
    'cgroupPathHash',
  ], 'runtime bindings');
  safeId(value.sandboxBootId, 'sandbox boot id');
  safeId(value.daemonId, 'daemon id');
  hash(value.daemonRootHash, 'daemon root hash');
  safeId(value.cgroupId, 'cgroup id');
  hash(value.cgroupPathHash, 'cgroup path hash');
  return Object.freeze(structuredClone(value));
}

function validateTrial(value, mode) {
  exactKeys(value, [
    'trialId',
    'taskId',
    'condition',
    'imageDigest',
    'trialCeilingMicrousd',
    'supervisorExecutableHash',
    'runnerExecutableHash',
    'harborExecutableHash',
  ], 'bound trial');
  safeId(value.trialId, 'trial id');
  safeId(value.taskId, 'task id');
  if (!['generic', 'harness'].includes(value.condition)) invalid('trial condition is invalid');
  if (typeof value.imageDigest !== 'string' || !IMAGE_DIGEST.test(value.imageDigest)) {
    invalid('trial image digest is invalid');
  }
  integer(
    value.trialCeilingMicrousd,
    'trial ceiling',
    mode === RuntimeExecutionModes.ZERO_PROVIDER_CANARY ? 0 : 1,
    20_000_000,
  );
  if (mode === RuntimeExecutionModes.ZERO_PROVIDER_CANARY && value.trialCeilingMicrousd !== 0) {
    invalid('zero-provider-canary trial ceiling must be zero');
  }
  hash(value.supervisorExecutableHash, 'supervisor executable hash');
  hash(value.runnerExecutableHash, 'runner executable hash');
  hash(value.harborExecutableHash, 'Harbor executable hash');
  return Object.freeze(structuredClone(value));
}

function validateArchiveManifest(value, kind) {
  exactKeys(value, ['kind', 'byteLength', 'sha256'], `${kind} archive manifest`);
  if (value.kind !== kind) invalid(`${kind} archive kind drifted`);
  integer(value.byteLength, `${kind} archive bytes`, 1, archiveLimitsForKind(kind).compressedBytes);
  hash(value.sha256, `${kind} archive digest`);
  return Object.freeze(structuredClone(value));
}

function validateBindingObservation(value, expected) {
  exactKeys(value, ['allocationId', 'taskArchive', 'runtimeBindings'], 'binding observation');
  if (value.allocationId !== expected.allocationId) invalid('observed allocation identity drifted');
  const archive = validateArchiveManifest(value.taskArchive, 'task-input');
  if (archive.sha256 !== expected.taskArchive.sha256
      || archive.byteLength !== expected.taskArchive.byteLength) {
    invalid('observed task archive digest drifted');
  }
  return {
    allocationId: value.allocationId,
    taskArchive: archive,
    runtimeBindings: validateRuntimeBindings(value.runtimeBindings),
  };
}

function verificationNow(clock) {
  const value = clock?.now?.() ?? Date.now();
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) invalid('runtime verification clock is invalid');
  return new Date(milliseconds);
}

function validateRequestBinding(request, binding, mode, verification) {
  let validated;
  try {
    validated = verifyProtocolDocument(request, verification.key, {
      expectedKeyId: verification.expectedKeyId,
      now: verification.now,
    });
  } catch {
    invalid('signed trial request is unauthenticated or structurally invalid');
  }
  if (validated.schema !== 'engineer-runtime-trial-request.v1'
      || validated.executionMode !== mode
      || validated.sessionId !== binding.sessionId
      || validated.trialId !== binding.trialId
      || validated.bindings.sandboxId !== binding.allocationId
      || validated.bindings.taskId !== binding.trial.taskId
      || validated.bindings.condition !== binding.trial.condition
      || validated.bindings.imageDigest !== binding.trial.imageDigest
      || validated.bindings.supervisorExecutableHash !== binding.trial.supervisorExecutableHash
      || validated.bindings.runnerExecutableHash !== binding.trial.runnerExecutableHash
      || validated.bindings.harborExecutableHash !== binding.trial.harborExecutableHash
      || validated.budget.trialCeilingMicrousd !== binding.trial.trialCeilingMicrousd) {
    invalid('signed trial request identity drifted from the bound sandbox');
  }
  for (const [field, expected] of Object.entries(binding.runtimeBindings)) {
    if (validated.bindings[field] !== expected) invalid('signed runtime binding drifted');
  }
  return validated;
}

function validateRunnerResult(value) {
  exactKeys(value, ['exitCode', 'signal', 'startedAt', 'endedAt'], 'runner result');
  integer(value.exitCode, 'runner exit code', 0, 255);
  safeId(value.signal, 'runner signal', 32);
  for (const field of ['startedAt', 'endedAt']) {
    if (typeof value[field] !== 'string'
        || new Date(value[field]).toISOString() !== value[field]) {
      invalid(`runner ${field} is not a canonical instant`);
    }
  }
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) invalid('runner completion predates its start');
  return Object.freeze(structuredClone(value));
}

async function resolveConfiguration(value, context, label) {
  const resolved = typeof value === 'function' ? await value(context) : value;
  return cloneBoundedJson(resolved, label);
}

function validateFactoryOptions(options) {
  const requiredFunctions = [
    'openProviderKeyFd',
    'closeProviderKeyFd',
    'inspectBinding',
    'inspectTrialOutput',
    'supervisorFactory',
  ];
  for (const name of requiredFunctions) {
    if (typeof options[name] !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!options.effects || typeof options.effects !== 'object') throw new TypeError('effects must be an object');
  safeId(options.keyId, 'supervisor key id', 64);
  safeId(options.expectedControllerKeyId, 'controller key id', 64);
}

/**
 * Creates the handler factory consumed by runSupervisorControlBridge.
 * The bridge owns and scrubs the secret buffers after this factory returns;
 * this layer converts the provider key to a one-shot inherited descriptor and
 * lets createRuntimeSupervisor make its own bounded HMAC copies.
 */
export function createSupervisorHandlerFactory({
  effects,
  dockerPolicy,
  brokerPolicy,
  runner,
  keyId = 'runtime-supervisor-hmac-1',
  expectedControllerKeyId = 'runtime-controller-hmac-1',
  openProviderKeyFd,
  closeProviderKeyFd,
  inspectBinding,
  inspectTrialOutput,
  supervisorFactory = createRuntimeSupervisor,
  clock,
  nonceFactory,
  limits,
} = {}) {
  const options = {
    effects,
    dockerPolicy,
    brokerPolicy,
    runner,
    keyId,
    expectedControllerKeyId,
    openProviderKeyFd,
    closeProviderKeyFd,
    inspectBinding,
    inspectTrialOutput,
    supervisorFactory,
  };
  validateFactoryOptions(options);

  return async function supervisorHandlerFactory(input = {}) {
    if (!isPlainObject(input)) invalid('supervisor secret handoff must be a plain object');
    const modeDescriptor = Object.getOwnPropertyDescriptor(input, 'executionMode');
    if (!modeDescriptor?.enumerable || modeDescriptor.get || modeDescriptor.set) {
      invalid('supervisor secret handoff execution mode is unsafe');
    }
    executionMode(modeDescriptor.value);
    exactDataKeys(
      input,
      modeDescriptor.value === RuntimeExecutionModes.CONTROLLED_PROVIDER
        ? ['hmacKey', 'executionMode', 'providerKey']
        : ['hmacKey', 'executionMode'],
      'supervisor secret handoff',
    );
    const { hmacKey, providerKey } = input;
    const mode = modeDescriptor.value;
    if ((!Buffer.isBuffer(hmacKey) && !(hmacKey instanceof Uint8Array)) || hmacKey.byteLength !== 32) {
      invalid('supervisor HMAC key must be exactly 32 bytes');
    }
    if (mode === RuntimeExecutionModes.CONTROLLED_PROVIDER) {
      if ((!Buffer.isBuffer(providerKey) && !(providerKey instanceof Uint8Array))
          || providerKey.byteLength < 8
          || providerKey.byteLength > 512) {
        invalid('provider key must be bounded bytes');
      }
    }

    const diagnosticKey = Buffer.from(hmacKey);
    let diagnosticKeyWiped = false;
    function wipeDiagnosticKey() {
      if (diagnosticKeyWiped) return;
      diagnosticKeyWiped = true;
      diagnosticKey.fill(0);
    }

    let supervisor;
    let providerKeyFd;
    let providerFdClosed = mode === RuntimeExecutionModes.ZERO_PROVIDER_CANARY;
    try {
      const supervisedEffects = {
        ...effects,
        async closeInheritedFd(fd) {
          const result = await effects.closeInheritedFd(fd);
          if (fd === providerKeyFd) providerFdClosed = true;
          return result;
        },
      };
      supervisor = supervisorFactory({
        signingKey: hmacKey,
        controllerVerificationKey: hmacKey,
        keyId,
        expectedControllerKeyId,
        effects: supervisedEffects,
        ...(clock === undefined ? {} : { clock }),
        ...(nonceFactory === undefined ? {} : { nonceFactory }),
        ...(limits === undefined ? {} : { limits }),
      });
      if (!supervisor || ['prepare', 'run', 'finalize', 'failStop', 'controlChannelLost']
        .some((method) => typeof supervisor[method] !== 'function')) {
        invalid('runtime supervisor factory returned an invalid supervisor');
      }
      if (mode === RuntimeExecutionModes.CONTROLLED_PROVIDER) {
        providerKeyFd = await openProviderKeyFd(providerKey);
        integer(providerKeyFd, 'provider key descriptor', 3, 1_048_575);
      }
    } catch (error) {
      try { await supervisor?.failStop?.('prepare-failure'); } catch { /* construction is already fail-closed */ }
      if (!providerFdClosed && Number.isSafeInteger(providerKeyFd)) {
        providerFdClosed = true;
        try { await closeProviderKeyFd(providerKeyFd); } catch { /* construction remains fail-closed */ }
      }
      wipeDiagnosticKey();
      throw error instanceof SupervisorHandlerError
        ? error
        : new SupervisorHandlerError('supervisor secret handoff failed');
    }

    let state = 'awaiting-bind';
    let nextSequence = 1;
    let previousResponseHash = CONTROL_GENESIS_HASH;
    let binding;
    let request;
    let requestHash;
    let readinessLease;
    let readinessLeaseHash;
    let runnerResult;
    let lifecycleClosed = false;
    let channelLossHandled = false;

    async function closeUnclaimedFd() {
      if (providerFdClosed) return;
      providerFdClosed = true;
      await closeProviderKeyFd(providerKeyFd);
    }

    function expectedOperation() {
      return {
        'awaiting-bind': 'bind',
        'awaiting-readiness': 'readiness',
        'awaiting-run': 'run',
        'awaiting-final': 'final',
      }[state];
    }

    function validateEnvelope(value) {
      exactKeys(value, [
        'schema',
        'protocolVersion',
        'operation',
        'sessionId',
        'trialId',
        'allocationId',
        'controlSequence',
        'previousControlHash',
        'body',
      ], 'control request');
      if (value.schema !== CONTROL_REQUEST_SCHEMA || value.protocolVersion !== 1) {
        invalid('control request schema or version is invalid');
      }
      const operation = expectedOperation();
      if (!operation || value.operation !== operation) invalid('control lifecycle operation is out of order');
      if (value.controlSequence !== nextSequence) invalid('control sequence is replayed or out of order');
      if (value.previousControlHash !== previousResponseHash) invalid('control response-chain digest drifted');
      safeId(value.sessionId, 'control session id');
      safeId(value.trialId, 'control trial id');
      safeId(value.allocationId, 'control allocation id');
      if (binding && (value.sessionId !== binding.sessionId
          || value.trialId !== binding.trialId
          || value.allocationId !== binding.allocationId)) {
        invalid('control operation identity drifted');
      }
      return value;
    }

    function responseFor(envelope, body) {
      const response = {
        schema: CONTROL_RESPONSE_SCHEMA,
        protocolVersion: 1,
        operation: envelope.operation,
        sessionId: envelope.sessionId,
        trialId: envelope.trialId,
        allocationId: envelope.allocationId,
        controlSequence: envelope.controlSequence,
        requestHash: canonicalSha256(envelope),
        body,
      };
      const bytes = encodeFrame(response);
      previousResponseHash = canonicalSha256(response);
      nextSequence += 1;
      return bytes;
    }

    function failureResponseFor(envelope, diagnostic) {
      const signingKey = Buffer.from(diagnosticKey);
      try {
        return encodeFrame(signRuntimeControlFailure({
          schema: RuntimeControlFailureSchema,
          protocolVersion: 1,
          operation: envelope.operation,
          sessionId: envelope.sessionId,
          trialId: envelope.trialId,
          allocationId: envelope.allocationId,
          controlSequence: envelope.controlSequence,
          requestHash: canonicalSha256(envelope),
          phase: diagnostic.phase,
          code: diagnostic.code,
          detailSha256: diagnostic.detailSha256,
        }, signingKey));
      } finally {
        signingKey.fill(0);
        wipeDiagnosticKey();
      }
    }

    async function bind(envelope, authorizeDiagnostic) {
      exactKeys(envelope.body, ['trial', 'taskArchive'], 'bind request body');
      const trial = validateTrial(envelope.body.trial, mode);
      if (trial.trialId !== envelope.trialId) invalid('bound trial identity drifted');
      const taskArchive = validateArchiveManifest(envelope.body.taskArchive, 'task-input');
      authorizeDiagnostic();
      const observed = validateBindingObservation(await inspectBinding({
        sessionId: envelope.sessionId,
        trialId: envelope.trialId,
        allocationId: envelope.allocationId,
        controlSequence: envelope.controlSequence,
        trial: structuredClone(trial),
        taskArchive: structuredClone(taskArchive),
      }), {
        allocationId: envelope.allocationId,
        taskArchive,
      });
      binding = Object.freeze({
        sessionId: envelope.sessionId,
        trialId: envelope.trialId,
        allocationId: envelope.allocationId,
        trial,
        taskArchive,
        runtimeBindings: observed.runtimeBindings,
      });
      state = 'awaiting-readiness';
      return responseFor(envelope, {
        status: 'bound',
        taskArchive: structuredClone(taskArchive),
        runtimeBindings: structuredClone(observed.runtimeBindings),
      });
    }

    async function prepare(envelope, authorizeDiagnostic) {
      exactKeys(envelope.body, ['request'], 'readiness request body');
      request = validateRequestBinding(envelope.body.request, binding, mode, {
        key: diagnosticKey,
        expectedKeyId: expectedControllerKeyId,
        now: verificationNow(clock),
      });
      requestHash = protocolDocumentHash(request);
      authorizeDiagnostic();
      const context = Object.freeze({
        sessionId: binding.sessionId,
        trialId: binding.trialId,
        allocationId: binding.allocationId,
        request: structuredClone(request),
        requestHash,
        executionMode: mode,
        trial: structuredClone(binding.trial),
        taskArchive: structuredClone(binding.taskArchive),
      });
      const configurations = await Promise.all([
        resolveConfiguration(dockerPolicy, context, 'Docker policy'),
        ...(mode === RuntimeExecutionModes.CONTROLLED_PROVIDER
          ? [resolveConfiguration(brokerPolicy, context, 'provider broker policy')]
          : []),
        resolveConfiguration(runner, context, 'runner configuration'),
      ]);
      const resolvedDockerPolicy = configurations[0];
      const resolvedBrokerPolicy = mode === RuntimeExecutionModes.CONTROLLED_PROVIDER
        ? configurations[1]
        : null;
      const resolvedRunner = configurations.at(-1);
      readinessLease = await supervisor.prepare(mode === RuntimeExecutionModes.CONTROLLED_PROVIDER
        ? {
          executionMode: mode,
          request: structuredClone(request),
          providerKeyFd,
          dockerPolicy: resolvedDockerPolicy,
          brokerPolicy: resolvedBrokerPolicy,
          runner: resolvedRunner,
        }
        : {
          executionMode: mode,
          request: structuredClone(request),
          dockerPolicy: resolvedDockerPolicy,
          runner: resolvedRunner,
        });
      try {
        validateProtocolDocument(readinessLease, { requireAuthentication: true });
        readinessLeaseHash = protocolDocumentHash(readinessLease);
      } catch {
        invalid('supervisor returned an invalid readiness lease');
      }
      if (readinessLease.schema !== 'engineer-runtime-readiness-lease.v1'
          || readinessLease.executionMode !== mode
          || readinessLease.sessionId !== binding.sessionId
          || readinessLease.trialId !== binding.trialId
          || readinessLease.requestHash !== requestHash) {
        invalid('supervisor readiness lease identity drifted');
      }
      state = 'awaiting-run';
      return responseFor(envelope, {
        status: 'ready',
        requestHash,
        readinessLease: structuredClone(readinessLease),
      });
    }

    async function run(envelope, authorizeDiagnostic) {
      exactKeys(envelope.body, ['requestHash', 'readinessLeaseHash'], 'run request body');
      if (envelope.body.requestHash !== requestHash
          || envelope.body.readinessLeaseHash !== readinessLeaseHash) {
        invalid('run request digest drifted');
      }
      authorizeDiagnostic();
      runnerResult = validateRunnerResult(await supervisor.run());
      const outputArchive = validateArchiveManifest(await inspectTrialOutput({
        sessionId: binding.sessionId,
        trialId: binding.trialId,
        allocationId: binding.allocationId,
        requestHash,
        readinessLeaseHash,
        runnerResult: structuredClone(runnerResult),
      }), 'trial-output');
      state = 'awaiting-final';
      return responseFor(envelope, {
        status: 'exited',
        requestHash,
        readinessLeaseHash,
        runnerResult: structuredClone(runnerResult),
        outputArchive: structuredClone(outputArchive),
      });
    }

    async function finalize(envelope, authorizeDiagnostic) {
      exactKeys(envelope.body, ['requestHash', 'readinessLeaseHash'], 'final request body');
      if (envelope.body.requestHash !== requestHash
          || envelope.body.readinessLeaseHash !== readinessLeaseHash) {
        invalid('final request digest drifted');
      }
      authorizeDiagnostic();
      const attestation = await supervisor.finalize({
        outcome: runnerResult.exitCode === 0
          ? { status: 'succeeded', exitReason: 'verified' }
          : { status: 'failed', exitReason: 'runner-failure' },
      });
      try {
        validateProtocolDocument(attestation, { requireAuthentication: true });
      } catch {
        invalid('supervisor returned an invalid final attestation');
      }
      if (attestation.schema !== 'engineer-runtime-trial-final-attestation.v1'
          || attestation.executionMode !== mode
          || attestation.sessionId !== binding.sessionId
          || attestation.trialId !== binding.trialId
          || attestation.requestHash !== requestHash
          || attestation.readinessLeaseHash !== readinessLeaseHash) {
        invalid('supervisor final attestation identity drifted');
      }
      state = 'complete';
      return responseFor(envelope, {
        status: 'finalized',
        requestHash,
        readinessLeaseHash,
        trialFinalAttestation: structuredClone(attestation),
      });
    }

    async function handleFrame(frameBytes) {
      if (lifecycleClosed || state === 'failed' || state === 'complete') {
        invalid('control lifecycle does not permit another frame');
      }
      let envelope;
      let diagnosticAuthorized = false;
      const authorizeDiagnostic = () => { diagnosticAuthorized = true; };
      try {
        envelope = validateEnvelope(parseFrame(frameBytes));
        const response = envelope.operation === 'bind'
          ? await bind(envelope, authorizeDiagnostic)
          : envelope.operation === 'readiness'
            ? await prepare(envelope, authorizeDiagnostic)
            : envelope.operation === 'run'
              ? await run(envelope, authorizeDiagnostic)
              : await finalize(envelope, authorizeDiagnostic);
        if (state === 'complete') wipeDiagnosticKey();
        return { response, done: state === 'complete' };
      } catch (error) {
        state = 'failed';
        const diagnostic = envelope && diagnosticAuthorized
          ? readRuntimeSupervisorFailureDiagnostic(error)
          : null;
        if (diagnostic) {
          try {
            return { response: failureResponseFor(envelope, diagnostic), done: true };
          } catch {
            // A diagnostic that cannot be encoded remains a generic fail-closed error.
          }
        }
        wipeDiagnosticKey();
        throw error instanceof SupervisorHandlerError
          ? error
          : new SupervisorHandlerError('supervisor control operation failed');
      }
    }

    async function channelLost() {
      if (channelLossHandled || state === 'complete') return;
      channelLossHandled = true;
      state = 'failed';
      try {
        await supervisor.controlChannelLost('controller-channel-closed');
      } finally {
        try {
          await closeUnclaimedFd();
        } finally {
          wipeDiagnosticKey();
        }
      }
    }

    async function close({ reason } = {}) {
      if (lifecycleClosed) return;
      lifecycleClosed = true;
      try {
        if (state !== 'complete') {
          state = 'failed';
          await supervisor.failStop(
            reason === 'channel-loss' ? 'control-channel-loss' : 'runtime-fail-stop'
          );
        }
      } finally {
        try {
          await closeUnclaimedFd();
        } finally {
          wipeDiagnosticKey();
        }
      }
    }

    return Object.freeze({ handleFrame, channelLost, close });
  };
}
