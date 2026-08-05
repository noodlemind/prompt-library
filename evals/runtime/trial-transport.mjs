import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';

import {
  TASK_INPUT_ARCHIVE_LIMITS,
  TRIAL_OUTPUT_ARCHIVE_LIMITS,
  archiveLimitsForKind,
} from './archive-limits.mjs';
import {
  MAX_PROTOCOL_BYTES,
  RuntimeExecutionModes,
  canonicalJson,
  canonicalSha256,
  protocolDocumentHash,
} from './protocol.mjs';
import { trialArchiveContainsExactBytes } from './trial-archive.mjs';

export const CONTROL_GENESIS_HASH = '0'.repeat(64);

const CONTROL_REQUEST_SCHEMA = 'engineer-runtime-control-request.v1';
const CONTROL_RESPONSE_SCHEMA = 'engineer-runtime-control-response.v1';
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SECRET_FIELD = /^(?:api[_-]?key|authorization|credential|hmac[_-]?key|password|provider[_-]?key|secret|token)$/i;
const SECRET_VALUE = /^(?:Bearer\s+|sk-[A-Za-z0-9_-]{8,})/i;

export class RuntimeTrialTransportError extends Error {
  constructor(message, code = 'ERR_RUNTIME_TRIAL_TRANSPORT') {
    super(message);
    this.name = 'RuntimeTrialTransportError';
    this.code = code;
  }
}

function invalid(message, code = 'ERR_RUNTIME_TRIAL_TRANSPORT_POLICY') {
  throw new RuntimeTrialTransportError(message, code);
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

function asOwnedBytes(value, label, minimum, maximum) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    invalid(`${label} must be supplied as bytes`);
  }
  if (value.byteLength < minimum || value.byteLength > maximum) {
    invalid(`${label} is outside its byte bound`);
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
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

function cloneCanonical(value, label) {
  let source;
  try {
    source = canonicalJson(value);
  } catch {
    invalid(`${label} is not bounded canonical JSON`);
  }
  const clone = JSON.parse(source);
  credentialFree(clone, label);
  return clone;
}

function encodeFrame(value, label) {
  const canonical = cloneCanonical(value, label);
  const bytes = Buffer.from(canonicalJson(canonical));
  if (bytes.length < 1 || bytes.length > MAX_PROTOCOL_BYTES) {
    bytes.fill(0);
    invalid(`${label} exceeds its frame bound`);
  }
  return bytes;
}

function parseFrame(input, label) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    invalid(`${label} must be bytes`);
  }
  const bytes = Buffer.from(input);
  if (bytes.length < 1 || bytes.length > MAX_PROTOCOL_BYTES) {
    bytes.fill(0);
    invalid(`${label} exceeds its frame bound`);
  }
  let text;
  let parsed;
  try {
    text = UTF8.decode(bytes);
    parsed = JSON.parse(text);
    if (!isPlainObject(parsed) || canonicalJson(parsed) !== text) {
      invalid(`${label} must use exact canonical JSON`);
    }
    credentialFree(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof RuntimeTrialTransportError) throw error;
    invalid(`${label} is malformed or noncanonical`);
  } finally {
    bytes.fill(0);
  }
}

function validateRuntimeBindings(value) {
  exactKeys(value, [
    'sandboxBootId',
    'daemonId',
    'daemonRootHash',
    'cgroupId',
    'cgroupPathHash',
  ], 'runtime bindings');
  safeId(value.sandboxBootId, 'runtime sandbox boot id');
  safeId(value.daemonId, 'runtime daemon id');
  hash(value.daemonRootHash, 'runtime daemon root hash');
  safeId(value.cgroupId, 'runtime cgroup id');
  hash(value.cgroupPathHash, 'runtime cgroup path hash');
  return Object.freeze(structuredClone(value));
}

function validateTrialSpec(value, mode) {
  exactKeys(value, [
    'trialId',
    'taskId',
    'condition',
    'imageDigest',
    'trialCeilingMicrousd',
    'supervisorExecutableHash',
    'runnerExecutableHash',
    'harborExecutableHash',
  ], 'trial specification');
  safeId(value.trialId, 'trial id');
  safeId(value.taskId, 'task id');
  if (!['generic', 'harness'].includes(value.condition)) invalid('trial condition is invalid');
  if (typeof value.imageDigest !== 'string' || !IMAGE_DIGEST.test(value.imageDigest)) {
    invalid('trial image digest is invalid');
  }
  integer(
    value.trialCeilingMicrousd,
    'trial budget',
    mode === RuntimeExecutionModes.ZERO_PROVIDER_CANARY ? 0 : 1,
    20_000_000
  );
  if (mode === RuntimeExecutionModes.ZERO_PROVIDER_CANARY
      && value.trialCeilingMicrousd !== 0) {
    invalid('zero-provider-canary trial budget must be zero');
  }
  hash(value.supervisorExecutableHash, 'supervisor executable hash');
  hash(value.runnerExecutableHash, 'runner executable hash');
  hash(value.harborExecutableHash, 'Harbor executable hash');
  return Object.freeze(structuredClone(value));
}

function validateAllocation(value, trialId) {
  if (!isPlainObject(value)) invalid('Daytona allocation must be a plain object');
  const allocationId = safeId(value.id, 'Daytona allocation id');
  if (!isPlainObject(value.labels) || value.labels['trial-id'] !== trialId) {
    invalid('Daytona allocation trial identity drifted');
  }
  return allocationId;
}

function taskArchiveManifest(bytes) {
  return Object.freeze({
    kind: 'task-input',
    byteLength: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

function validateArchiveManifest(value, kind) {
  exactKeys(value, ['kind', 'byteLength', 'sha256'], `${kind} archive manifest`);
  if (value.kind !== kind) invalid(`${kind} archive kind drifted`);
  integer(value.byteLength, `${kind} archive bytes`, 1, archiveLimitsForKind(kind).compressedBytes);
  hash(value.sha256, `${kind} archive digest`);
  return Object.freeze(structuredClone(value));
}

function validateUploadReceipt(value, expected) {
  exactKeys(value, ['schema', 'operation', 'kind', 'path', 'byteLength', 'sha256', 'status'], 'upload receipt');
  if (value.schema !== 'engineer-daytona-archive-result.v1'
      || value.operation !== 'upload'
      || value.kind !== 'task-input'
      || value.path !== '/engineer-bounded/transport/task-input.tar'
      || value.byteLength !== expected.byteLength
      || value.sha256 !== expected.sha256
      || value.status !== 'accepted') {
    invalid('task input upload receipt drifted');
  }
}

function validateDownload(value, expected) {
  exactKeys(value, ['bytes', 'receipt'], 'trial output download');
  const bytes = asOwnedBytes(
    value.bytes,
    'trial output archive',
    1,
    TRIAL_OUTPUT_ARCHIVE_LIMITS.compressedBytes,
  );
  try {
    if (bytes.length !== expected.byteLength
        || crypto.createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      invalid('trial output archive digest or size drifted');
    }
    exactKeys(value.receipt, [
      'schema', 'operation', 'kind', 'path', 'byteLength', 'sha256', 'status',
    ], 'trial output receipt');
    if (value.receipt.schema !== 'engineer-daytona-archive-result.v1'
        || value.receipt.operation !== 'download'
        || value.receipt.kind !== 'trial-output'
        || value.receipt.path !== '/engineer-bounded/transport/trial-output.tar'
        || value.receipt.byteLength !== expected.byteLength
        || value.receipt.sha256 !== expected.sha256
        || value.receipt.status !== 'accepted') {
      invalid('trial output download receipt drifted');
    }
    return {
      bytes: Buffer.from(bytes),
      receipt: Object.freeze(structuredClone(value.receipt)),
    };
  } finally {
    bytes.fill(0);
  }
}

function sanitizedFailure(error, operation) {
  if (error instanceof RuntimeTrialTransportError) return error;
  const detail = crypto.createHash('sha256')
    .update(String(error?.name ?? 'Error'))
    .update('\0')
    .update(String(error?.message ?? 'runtime transport failure').slice(0, 4_096))
    .digest('hex')
    .slice(0, 16);
  return new RuntimeTrialTransportError(
    `runtime trial transport ${operation} failed (detail sha256:${detail})`,
    'ERR_RUNTIME_TRIAL_TRANSPORT_REMOTE'
  );
}

function validateDependencies(daytonaTransport, taskInputArchive, takeTrialSecrets) {
  const methods = ['uploadArchive', 'downloadArchive', 'openSupervisorControl'];
  if (!daytonaTransport || methods.some((method) => typeof daytonaTransport[method] !== 'function')) {
    throw new TypeError(`daytonaTransport must implement ${methods.join(', ')}`);
  }
  if (typeof taskInputArchive !== 'function' || typeof takeTrialSecrets !== 'function') {
    throw new TypeError('taskInputArchive and takeTrialSecrets must be functions');
  }
}

function responseBody(value, operation) {
  if (operation === 'bind') {
    exactKeys(value, ['status', 'taskArchive', 'runtimeBindings'], 'bind response body');
    if (value.status !== 'bound') invalid('remote binding was not accepted');
    return {
      taskArchive: validateArchiveManifest(value.taskArchive, 'task-input'),
      runtimeBindings: validateRuntimeBindings(value.runtimeBindings),
    };
  }
  if (operation === 'readiness') {
    exactKeys(value, ['status', 'requestHash', 'readinessLease'], 'readiness response body');
    if (value.status !== 'ready') invalid('remote readiness was not accepted');
    hash(value.requestHash, 'readiness request hash');
    return value;
  }
  if (operation === 'run') {
    exactKeys(value, [
      'status', 'requestHash', 'readinessLeaseHash', 'runnerResult', 'outputArchive',
    ], 'run response body');
    if (value.status !== 'exited') invalid('remote runner did not exit cleanly');
    hash(value.requestHash, 'run request hash');
    hash(value.readinessLeaseHash, 'run lease hash');
    exactKeys(value.runnerResult, ['exitCode', 'signal', 'startedAt', 'endedAt'], 'runner result');
    integer(value.runnerResult.exitCode, 'runner exit code', 0, 255);
    safeId(value.runnerResult.signal, 'runner signal', 32);
    return {
      ...value,
      outputArchive: validateArchiveManifest(value.outputArchive, 'trial-output'),
    };
  }
  if (operation === 'final') {
    exactKeys(value, [
      'status', 'requestHash', 'readinessLeaseHash', 'trialFinalAttestation',
    ], 'final response body');
    if (value.status !== 'finalized') invalid('remote finalization was not accepted');
    hash(value.requestHash, 'final request hash');
    hash(value.readinessLeaseHash, 'final lease hash');
    return value;
  }
  invalid('unknown control operation');
}

export function createRuntimeTrialTransport({
  daytonaTransport,
  sessionId,
  executionMode: executionModeInput,
  taskInputArchive,
  takeTrialSecrets,
} = {}) {
  validateDependencies(daytonaTransport, taskInputArchive, takeTrialSecrets);
  safeId(sessionId, 'runtime session id');
  const mode = executionMode(executionModeInput);

  const handles = new WeakSet();
  const records = new WeakMap();
  const activeByTrial = new Map();
  const seenTrialIds = new Set();

  function recordFor(channel) {
    if (!isPlainObject(channel) || !handles.has(channel)) invalid('runtime control handle is invalid');
    const record = records.get(channel);
    if (!record) invalid('runtime control handle is no longer active');
    return record;
  }

  function assertSignal(signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    if (signal?.aborted) invalid('runtime control operation was aborted', 'ERR_RUNTIME_TRIAL_TRANSPORT_ABORTED');
  }

  async function closeRecord(record) {
    if (record.closed) return;
    record.closed = true;
    activeByTrial.delete(record.trialId);
    try {
      await record.control?.close();
    } catch (error) {
      throw sanitizedFailure(error, 'close');
    }
  }

  async function failClosedRecord(record, error, operation) {
    record.failed = true;
    try { await closeRecord(record); } catch { /* preserve the evidence-validation failure */ }
    throw sanitizedFailure(error, operation);
  }

  async function exchange(record, operation, body, signal) {
    assertSignal(signal);
    if (record.closed || record.failed) invalid('runtime control channel is closed or failed');
    const expectedOperation = ['bind', 'readiness', 'run', 'final'][record.nextSequence - 1];
    if (operation !== expectedOperation) {
      invalid(`runtime control lifecycle requires ${expectedOperation ?? 'no further operation'}`);
    }
    const envelope = {
      schema: CONTROL_REQUEST_SCHEMA,
      protocolVersion: 1,
      operation,
      sessionId,
      trialId: record.trialId,
      allocationId: record.allocationId,
      controlSequence: record.nextSequence,
      previousControlHash: record.previousResponseHash,
      body: cloneCanonical(body, `${operation} request body`),
    };
    const requestHash = canonicalSha256(envelope);
    const outbound = encodeFrame(envelope, `${operation} control request`);
    let inbound;
    try {
      await record.control.sendFrame(outbound);
      assertSignal(signal);
      inbound = await record.control.receiveFrame();
      assertSignal(signal);
      const response = parseFrame(inbound, `${operation} control response`);
      exactKeys(response, [
        'schema',
        'protocolVersion',
        'operation',
        'sessionId',
        'trialId',
        'allocationId',
        'controlSequence',
        'requestHash',
        'body',
      ], `${operation} control response`);
      if (response.schema !== CONTROL_RESPONSE_SCHEMA
          || response.protocolVersion !== 1
          || response.operation !== operation
          || response.sessionId !== sessionId
          || response.trialId !== record.trialId
          || response.allocationId !== record.allocationId
          || response.controlSequence !== record.nextSequence
          || response.requestHash !== requestHash) {
        invalid(`${operation} control response identity or digest drifted`);
      }
      const validatedBody = responseBody(response.body, operation);
      record.previousResponseHash = canonicalSha256(response);
      record.nextSequence += 1;
      return validatedBody;
    } catch (error) {
      record.failed = true;
      try { await closeRecord(record); } catch { /* the original failure remains authoritative */ }
      throw sanitizedFailure(error, operation);
    } finally {
      outbound.fill(0);
      if (Buffer.isBuffer(inbound)) inbound.fill(0);
    }
  }

  async function prepareTrial({ allocation, provisioning, spec: specInput, signal } = {}) {
    assertSignal(signal);
    const spec = validateTrialSpec(specInput, mode);
    const allocationId = validateAllocation(allocation, spec.trialId);
    if (seenTrialIds.has(spec.trialId)) invalid('trial input archive or trial identity was already staged');
    if (activeByTrial.size !== 0) invalid('runtime trial transport permits only one active trial');
    seenTrialIds.add(spec.trialId);

    let archive;
    let secrets;
    let hmacKey;
    let providerKey;
    let opened;
    let record;
    try {
      archive = asOwnedBytes(
        await taskInputArchive({
          allocation: structuredClone(allocation),
          provisioning: structuredClone(provisioning),
          spec: structuredClone(spec),
        }),
        'task input archive',
        1,
        TASK_INPUT_ARCHIVE_LIMITS.compressedBytes
      );
      const manifest = taskArchiveManifest(archive);
      secrets = await takeTrialSecrets({
        sessionId,
        trialId: spec.trialId,
        allocationId,
      });
      const controlledProvider = mode === RuntimeExecutionModes.CONTROLLED_PROVIDER;
      exactKeys(
        secrets,
        controlledProvider ? ['hmacKey', 'providerKey'] : ['hmacKey'],
        'trial secrets'
      );
      hmacKey = asOwnedBytes(secrets.hmacKey, 'runtime HMAC key', 32, 32);
      providerKey = controlledProvider
        ? asOwnedBytes(secrets.providerKey, 'provider key', 8, 512)
        : undefined;
      if (trialArchiveContainsExactBytes(archive, {
        kind: 'task-input',
        needles: providerKey === undefined ? [hmacKey] : [hmacKey, providerKey],
      })) {
        invalid('task input archive contains runtime credential bytes', 'ERR_RUNTIME_TRIAL_TRANSPORT_SECRET');
      }
      const upload = await daytonaTransport.uploadArchive({
        sandboxId: allocationId,
        kind: 'task-input',
        bytes: archive,
        sha256: manifest.sha256,
      });
      validateUploadReceipt(upload, manifest);
      archive.fill(0);
      archive = undefined;
      try {
        opened = await daytonaTransport.openSupervisorControl({
          sandboxId: allocationId,
          hmacKey,
          executionMode: mode,
          ...(controlledProvider ? { providerKey } : {}),
        });
      } finally {
        hmacKey.fill(0);
        providerKey?.fill(0);
        secrets.hmacKey.fill(0);
        secrets.providerKey?.fill(0);
      }
      if (!isPlainObject(opened) || !opened.control
          || typeof opened.control.sendFrame !== 'function'
          || typeof opened.control.receiveFrame !== 'function'
          || typeof opened.control.close !== 'function') {
        invalid('Daytona supervisor control channel is invalid');
      }
      record = {
        sessionId,
        trialId: spec.trialId,
        allocationId,
        executionMode: mode,
        spec,
        manifest,
        control: opened.control,
        nextSequence: 1,
        previousResponseHash: CONTROL_GENESIS_HASH,
        failed: false,
        closed: false,
        downloaded: false,
      };
      const channel = Object.freeze({
        schema: 'engineer-runtime-control-handle.v1',
        sessionId,
        trialId: spec.trialId,
        allocationId,
        executionMode: mode,
      });
      handles.add(channel);
      records.set(channel, record);
      activeByTrial.set(spec.trialId, record);
      record.channel = channel;
      const bound = await exchange(record, 'bind', {
        trial: structuredClone(spec),
        taskArchive: structuredClone(manifest),
      }, signal);
      if (bound.taskArchive.sha256 !== manifest.sha256
          || bound.taskArchive.byteLength !== manifest.byteLength) {
        invalid('remote task input archive digest drifted');
      }
      return Object.freeze({ channel, runtimeBindings: bound.runtimeBindings });
    } catch (error) {
      archive?.fill(0);
      hmacKey?.fill(0);
      providerKey?.fill(0);
      if (isPlainObject(secrets)) {
        if (Buffer.isBuffer(secrets.hmacKey) || secrets.hmacKey instanceof Uint8Array) secrets.hmacKey.fill(0);
        if (Buffer.isBuffer(secrets.providerKey) || secrets.providerKey instanceof Uint8Array) secrets.providerKey.fill(0);
      }
      if (record) {
        if (!record.closed) {
          try { await closeRecord(record); } catch { /* preserve the provisioning failure */ }
        }
      } else if (opened?.control) {
        try { await opened.control.close(); } catch { /* preserve the provisioning failure */ }
      }
      throw sanitizedFailure(error, 'prepare');
    }
  }

  async function requestReadiness({ channel, request, signal } = {}) {
    const record = recordFor(channel);
    if (!isPlainObject(request)
        || request.sessionId !== sessionId
        || request.trialId !== record.trialId
        || request.executionMode !== record.executionMode
        || request.bindings?.sandboxId !== record.allocationId) {
      invalid('signed trial request identity drifted');
    }
    const body = await exchange(record, 'readiness', { request }, signal);
    try {
      const requestHash = protocolDocumentHash(request);
      const leaseHash = protocolDocumentHash(body.readinessLease);
      if (body.requestHash !== requestHash
          || body.readinessLease.schema !== 'engineer-runtime-readiness-lease.v1'
          || body.readinessLease.sessionId !== sessionId
          || body.readinessLease.trialId !== record.trialId
          || body.readinessLease.executionMode !== record.executionMode
          || body.readinessLease.requestHash !== requestHash) {
        invalid('readiness lease identity or request digest drifted');
      }
      record.request = structuredClone(request);
      record.requestHash = requestHash;
      record.readinessLease = structuredClone(body.readinessLease);
      record.readinessLeaseHash = leaseHash;
      return Object.freeze(structuredClone(body.readinessLease));
    } catch (error) {
      return failClosedRecord(record, error, 'readiness-evidence');
    }
  }

  async function executeTrial({ handle, authorization, signal } = {}) {
    assertSignal(signal);
    if (!isPlainObject(handle)
        || handle.sessionId !== sessionId
        || typeof handle.trialId !== 'string') {
      invalid('runtime trial execution handle is invalid');
    }
    const record = activeByTrial.get(handle.trialId);
    if (!record || !record.request || record.failed || record.closed) {
      invalid('runtime trial is not ready for execution');
    }
    if (!isPlainObject(authorization)
        || authorization.sessionId !== sessionId
        || authorization.trialId !== record.trialId
        || authorization.providerAuthorized
          !== (record.executionMode === RuntimeExecutionModes.CONTROLLED_PROVIDER)
        || authorization.readinessLeaseHash !== record.readinessLeaseHash
        || protocolDocumentHash(authorization.readinessLease) !== record.readinessLeaseHash
        || protocolDocumentHash(handle.request) !== record.requestHash) {
      invalid('runtime trial authorization drifted');
    }
    if (record.downloaded) invalid('trial output archive was already downloaded');
    const body = await exchange(record, 'run', {
      requestHash: record.requestHash,
      readinessLeaseHash: record.readinessLeaseHash,
    }, signal);
    if (body.requestHash !== record.requestHash
        || body.readinessLeaseHash !== record.readinessLeaseHash) {
      return failClosedRecord(
        record,
        new RuntimeTrialTransportError('runner response binding drifted'),
        'run-evidence'
      );
    }
    let downloaded;
    try {
      downloaded = validateDownload(await daytonaTransport.downloadArchive({
        sandboxId: record.allocationId,
        kind: 'trial-output',
        expectedSha256: body.outputArchive.sha256,
        expectedBytes: body.outputArchive.byteLength,
      }), body.outputArchive);
      record.downloaded = true;
      return Object.freeze({
        schema: 'engineer-runtime-executed-trial.v1',
        sessionId,
        trialId: record.trialId,
        runnerResult: Object.freeze(structuredClone(body.runnerResult)),
        outputArchive: Object.freeze({
          kind: 'trial-output',
          byteLength: body.outputArchive.byteLength,
          sha256: body.outputArchive.sha256,
          bytes: downloaded.bytes,
          receipt: downloaded.receipt,
        }),
      });
    } catch (error) {
      record.failed = true;
      try { await closeRecord(record); } catch { /* preserve the archive failure */ }
      throw sanitizedFailure(error, 'download');
    }
  }

  async function requestFinal({ channel, request, readinessLease, signal } = {}) {
    const record = recordFor(channel);
    if (!record.downloaded || record.failed || record.closed) invalid('runtime trial has not completed execution');
    const requestHash = protocolDocumentHash(request);
    const leaseHash = protocolDocumentHash(readinessLease);
    if (requestHash !== record.requestHash || leaseHash !== record.readinessLeaseHash) {
      invalid('finalization request or readiness digest drifted');
    }
    const body = await exchange(record, 'final', {
      requestHash,
      readinessLeaseHash: leaseHash,
    }, signal);
    try {
      protocolDocumentHash(body.trialFinalAttestation);
      if (body.requestHash !== requestHash
          || body.readinessLeaseHash !== leaseHash
          || body.trialFinalAttestation.schema !== 'engineer-runtime-trial-final-attestation.v1'
          || body.trialFinalAttestation.sessionId !== sessionId
          || body.trialFinalAttestation.trialId !== record.trialId
          || body.trialFinalAttestation.executionMode !== record.executionMode
          || body.trialFinalAttestation.requestHash !== requestHash
          || body.trialFinalAttestation.readinessLeaseHash !== leaseHash) {
        invalid('final attestation response binding drifted');
      }
      record.finalized = true;
      return Object.freeze(structuredClone(body.trialFinalAttestation));
    } catch (error) {
      return failClosedRecord(record, error, 'final-evidence');
    }
  }

  async function closeTrial({ channel, trialId, reasonHash, signal } = {}) {
    assertSignal(signal);
    const record = recordFor(channel);
    if (trialId !== record.trialId) invalid('closed trial identity drifted');
    hash(reasonHash, 'trial close reason hash');
    await closeRecord(record);
  }

  return Object.freeze({
    prepareTrial,
    requestReadiness,
    executeTrial,
    requestFinal,
    closeTrial,
  });
}
