import crypto from 'node:crypto';
import fs, { constants as FS_CONSTANTS } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { validateRuntimeNetworkPolicyReceipt } from './runtime-evidence.mjs';

export const READINESS_PREFLIGHT_SCHEMA = 'engineer-runtime-readiness-preflight.v1';
export const READINESS_PREFLIGHT_PUBLICATION_SCHEMA =
  'engineer-runtime-readiness-preflight-publication.v1';
export const READINESS_PREFLIGHT_PATH =
  '/engineer-bounded/evidence/readiness-preflight.json';

const ZERO_PROVIDER_MODE = 'zero-provider-canary';
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_RECEIPT_LIFETIME_MS = 60_000;
const HASH = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^[a-f0-9]{40,64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const PRODUCER_INPUT_FIELDS = Object.freeze([
  'requestHash', 'releaseSha', 'taskLockHash', 'bundleHash', 'executionMode',
  'condition', 'imageDigest', 'sandboxId', 'sandboxBootId', 'trialId',
  'cgroup', 'filesystem', 'networkPolicy', 'materialization', 'executables',
]);
const BINDING_FIELDS = Object.freeze([
  'requestHash', 'releaseSha', 'taskLockHash', 'bundleHash', 'executionMode',
  'condition', 'imageDigest', 'sandboxId', 'sandboxBootId', 'trialId',
  'cgroupId', 'cgroupPathHash', 'filesystemId', 'filesystemBytes',
  'evidenceReserveBytes', 'networkPolicyHash', 'networkProducerSessionId',
  'materializationReceiptHash', 'workspaceFilesystemId',
  'producerExecutableHash', 'readinessProbeExecutableHash',
  'runnerExecutableHash', 'harborExecutableHash',
  'storageAllocatorExecutableHash',
  'taskIsolationProbeExecutableHash', 'readinessDenialProbeExecutableHash',
]);
const RECEIPT_FIELDS = Object.freeze([
  'schema', 'bindings', 'bindingHash', 'observations', 'producedAt',
  'expiresAt', 'producerNonce', 'receiptHash',
]);
const PUBLICATION_FIELDS = Object.freeze([
  'schema', 'path', 'receiptHash', 'bindingHash', 'bindings',
]);
const RUNNER_FIELDS = Object.freeze([
  'uid', 'effectiveCapabilities', 'privateDaemonDenied', 'realDaemonDenied',
  'alternateDaemonDenied', 'mountDenied', 'ptraceDenied',
  'providerEgressDenied', 'metadataDenied', 'daytonaCredentialsAbsent',
  'providerCredentialsAbsent', 'proofHash',
]);
const TASK_FIELDS = Object.freeze([
  'networkNone', 'readOnlyRoot', 'capabilitiesDropped', 'noNewPrivileges',
  'brokerReachable', 'brokerSocketMounted', 'brokerClientGidPresent',
  'observationHash',
]);

export class ReadinessPreflightError extends Error {
  constructor(message, code = 'ERR_READINESS_PREFLIGHT') {
    super(message);
    this.name = 'ReadinessPreflightError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_READINESS_PREFLIGHT') {
  throw new ReadinessPreflightError(message, code);
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const expected = new Set(fields);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((field) => !expected.has(field))) {
    fail(`${label} contains an unknown or missing field`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalClone(value, label, maximum = MAX_RECEIPT_BYTES) {
  let encoded;
  try { encoded = canonicalJson(value); } catch { fail(`${label} is not canonical JSON`); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > maximum) {
    fail(`${label} exceeds its byte bound`);
  }
  return JSON.parse(encoded);
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} is not a SHA-256 digest`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} is not a safe identifier`);
  return value;
}

function boolean(value, label, expected) {
  if (typeof value !== 'boolean' || (expected !== undefined && value !== expected)) {
    fail(`${label} failed closed`);
  }
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is outside its integer bound`);
  }
  return value;
}

function instant(value, label) {
  let canonical;
  try { canonical = new Date(value).toISOString(); } catch { fail(`${label} is not a UTC instant`); }
  if (typeof value !== 'string' || canonical !== value) fail(`${label} is not a canonical UTC instant`);
  return Date.parse(value);
}

function bindingDigest(value) {
  return sha256(`engineer-runtime-readiness-preflight-binding.v1\0${canonicalJson(value)}`);
}

function receiptDigest(value) {
  return sha256(`engineer-runtime-readiness-preflight-receipt.v1\0${canonicalJson(value)}`);
}

function networkPolicyDigest(value) {
  return sha256(`engineer-runtime-readiness-preflight-network.v1\0${canonicalJson(value)}`);
}

export function readinessPreflightNetworkPolicyHash(input) {
  let policy;
  try { policy = validateRuntimeNetworkPolicyReceipt(input); } catch {
    fail('readiness preflight network policy is invalid');
  }
  return networkPolicyDigest(policy);
}

function validateBindings(value, label = 'readiness preflight bindings') {
  const bindings = canonicalClone(value, label);
  exactKeys(bindings, BINDING_FIELDS, label);
  digest(bindings.requestHash, `${label}.requestHash`);
  if (typeof bindings.releaseSha !== 'string' || !RELEASE_SHA.test(bindings.releaseSha)) {
    fail(`${label}.releaseSha is not a full release identity`);
  }
  for (const field of [
    'taskLockHash', 'bundleHash', 'cgroupPathHash', 'networkPolicyHash',
    'networkProducerSessionId', 'materializationReceiptHash',
    'producerExecutableHash', 'readinessProbeExecutableHash',
    'runnerExecutableHash', 'harborExecutableHash',
    'storageAllocatorExecutableHash',
    'taskIsolationProbeExecutableHash', 'readinessDenialProbeExecutableHash',
  ]) digest(bindings[field], `${label}.${field}`);
  if (bindings.executionMode !== ZERO_PROVIDER_MODE) {
    fail(`${label}.executionMode must be zero-provider-canary`);
  }
  if (!['generic', 'harness'].includes(bindings.condition)) {
    fail(`${label}.condition is invalid`);
  }
  if (typeof bindings.imageDigest !== 'string' || !IMAGE_DIGEST.test(bindings.imageDigest)) {
    fail(`${label}.imageDigest is not immutable`);
  }
  for (const field of ['sandboxId', 'sandboxBootId', 'trialId', 'cgroupId', 'filesystemId']) {
    safeId(bindings[field], `${label}.${field}`);
  }
  safeId(bindings.workspaceFilesystemId, `${label}.workspaceFilesystemId`);
  integer(bindings.filesystemBytes, `${label}.filesystemBytes`, TEN_GIB, TEN_GIB);
  integer(
    bindings.evidenceReserveBytes,
    `${label}.evidenceReserveBytes`,
    64 * 1024 * 1024,
    TEN_GIB - 1,
  );
  return bindings;
}

function normalizeProducerInput(input) {
  const value = canonicalClone(input, 'readiness preflight producer input');
  exactKeys(value, PRODUCER_INPUT_FIELDS, 'readiness preflight producer input');
  exactKeys(value.cgroup, ['id', 'pathHash'], 'readiness preflight cgroup binding');
  exactKeys(value.filesystem, [
    'id', 'bytes', 'evidenceReserveBytes',
  ], 'readiness preflight filesystem binding');
  exactKeys(value.materialization, [
    'trialId', 'imageDigest', 'workspaceFilesystemId', 'receiptHash',
  ], 'readiness preflight materialization binding');
  exactKeys(value.executables, [
    'producerExecutableHash', 'readinessProbeExecutableHash',
    'runnerExecutableHash', 'harborExecutableHash',
    'storageAllocatorExecutableHash',
    'taskIsolationProbeExecutableHash', 'readinessDenialProbeExecutableHash',
  ], 'readiness preflight executable binding');
  let networkPolicy;
  try { networkPolicy = validateRuntimeNetworkPolicyReceipt(value.networkPolicy); } catch {
    fail('readiness preflight network policy binding drifted');
  }
  if (networkPolicy.requestHash !== value.requestHash
      || networkPolicy.sandboxId !== value.sandboxId
      || networkPolicy.sandboxBootId !== value.sandboxBootId
      || networkPolicy.trialId !== value.trialId
      || networkPolicy.producerExecutableHash !== value.executables.producerExecutableHash
      || value.materialization.trialId !== value.trialId
      || value.materialization.imageDigest !== value.imageDigest
      || value.materialization.workspaceFilesystemId !== value.filesystem.id) {
    fail('readiness preflight lifecycle binding drifted');
  }
  return validateBindings({
    requestHash: value.requestHash,
    releaseSha: value.releaseSha,
    taskLockHash: value.taskLockHash,
    bundleHash: value.bundleHash,
    executionMode: value.executionMode,
    condition: value.condition,
    imageDigest: value.imageDigest,
    sandboxId: value.sandboxId,
    sandboxBootId: value.sandboxBootId,
    trialId: value.trialId,
    cgroupId: value.cgroup.id,
    cgroupPathHash: value.cgroup.pathHash,
    filesystemId: value.filesystem.id,
    filesystemBytes: value.filesystem.bytes,
    evidenceReserveBytes: value.filesystem.evidenceReserveBytes,
    networkPolicyHash: readinessPreflightNetworkPolicyHash(networkPolicy),
    networkProducerSessionId: networkPolicy.producerSessionId,
    materializationReceiptHash: value.materialization.receiptHash,
    workspaceFilesystemId: value.materialization.workspaceFilesystemId,
    ...value.executables,
  });
}

function validateObservations(input, bindings) {
  const value = canonicalClone(input, 'readiness preflight observations');
  exactKeys(value, [
    'conditionMount', 'noProvider', 'storage', 'runner', 'task',
  ], 'readiness preflight observations');
  exactKeys(value.conditionMount, [
    'condition', 'passed', 'inventoryHash',
  ], 'condition mount observation');
  if (value.conditionMount.condition !== bindings.condition) {
    fail('condition mount observation drifted from its one condition binding');
  }
  boolean(value.conditionMount.passed, 'condition mount observation', true);
  digest(value.conditionMount.inventoryHash, 'condition mount inventory hash');

  exactKeys(value.noProvider, [
    'completed', 'providerCalls', 'providerCredentialAbsent',
    'brokerSocketAbsent', 'proofHash',
  ], 'no-provider observation');
  boolean(value.noProvider.completed, 'no-provider completion', true);
  integer(value.noProvider.providerCalls, 'provider call count', 0, 0);
  boolean(value.noProvider.providerCredentialAbsent, 'provider credential absence', true);
  boolean(value.noProvider.brokerSocketAbsent, 'provider broker socket absence', true);
  digest(value.noProvider.proofHash, 'no-provider proof hash');

  exactKeys(value.storage, [
    'schema', 'filesystemId', 'totalBytes', 'preallocationRequestedBytes',
    'allocatedBytesObserved', 'writeAttemptLimitBytes', 'bytesWrittenBeforeEnospc',
    'availableBytesAfterCleanup',
    'enospcObserved', 'evidenceHeadroomRecovered', 'proofHash',
  ], 'storage observation');
  if (value.storage.schema !== 'engineer-readiness-storage-observation.v2'
      || value.storage.filesystemId !== bindings.filesystemId
      || value.storage.totalBytes !== bindings.filesystemBytes) {
    fail('storage observation filesystem binding drifted');
  }
  integer(
    value.storage.preallocationRequestedBytes,
    'storage canary preallocation bytes',
    1,
    bindings.filesystemBytes,
  );
  integer(
    value.storage.allocatedBytesObserved,
    'storage canary allocated bytes',
    value.storage.preallocationRequestedBytes,
    bindings.filesystemBytes,
  );
  integer(
    value.storage.writeAttemptLimitBytes,
    'storage canary write limit',
    64 * 1024 * 1024,
    64 * 1024 * 1024,
  );
  integer(
    value.storage.bytesWrittenBeforeEnospc,
    'storage canary bytes written before ENOSPC',
    0,
    value.storage.writeAttemptLimitBytes - 1,
  );
  integer(
    value.storage.availableBytesAfterCleanup,
    'storage recovered bytes',
    bindings.evidenceReserveBytes,
    bindings.filesystemBytes,
  );
  boolean(value.storage.enospcObserved, 'storage ENOSPC observation', true);
  boolean(value.storage.evidenceHeadroomRecovered, 'storage headroom recovery', true);
  digest(value.storage.proofHash, 'storage proof hash');

  exactKeys(value.runner, RUNNER_FIELDS, 'runner denial observation');
  integer(value.runner.uid, 'runner uid', 2001, 2001);
  integer(value.runner.effectiveCapabilities, 'runner effective capabilities', 0, 0);
  for (const field of RUNNER_FIELDS.slice(2, -1)) {
    boolean(value.runner[field], `runner ${field}`, true);
  }
  digest(value.runner.proofHash, 'runner denial proof hash');

  exactKeys(value.task, TASK_FIELDS, 'task isolation observation');
  for (const field of TASK_FIELDS.slice(0, 4)) boolean(value.task[field], `task ${field}`, true);
  for (const field of TASK_FIELDS.slice(4, 7)) boolean(value.task[field], `task ${field}`, false);
  digest(value.task.observationHash, 'task isolation observation hash');
  return value;
}

export function createReadinessPreflightReceipt(input) {
  exactKeys(input, [
    'bindings', 'observations', 'producedAt', 'expiresAt', 'producerNonce',
  ], 'readiness preflight receipt input');
  const bindings = Object.hasOwn(input.bindings ?? {}, 'cgroup')
    ? normalizeProducerInput(input.bindings)
    : validateBindings(input.bindings);
  const observations = validateObservations(input.observations, bindings);
  const produced = instant(input.producedAt, 'readiness preflight producedAt');
  const expires = instant(input.expiresAt, 'readiness preflight expiresAt');
  if (expires <= produced || expires - produced > MAX_RECEIPT_LIFETIME_MS) {
    fail('readiness preflight freshness window is invalid');
  }
  digest(input.producerNonce, 'readiness preflight producer nonce');
  const documentWithoutHash = {
    schema: READINESS_PREFLIGHT_SCHEMA,
    bindings,
    bindingHash: bindingDigest(bindings),
    observations,
    producedAt: input.producedAt,
    expiresAt: input.expiresAt,
    producerNonce: input.producerNonce,
  };
  return Object.freeze({
    ...documentWithoutHash,
    receiptHash: receiptDigest(documentWithoutHash),
  });
}

export function validateReadinessPreflightReceipt(input, {
  expectedBindings,
  observedAt,
} = {}) {
  const value = canonicalClone(input, 'readiness preflight receipt');
  exactKeys(value, RECEIPT_FIELDS, 'readiness preflight receipt');
  if (value.schema !== READINESS_PREFLIGHT_SCHEMA) fail('readiness preflight schema drifted');
  const bindings = validateBindings(value.bindings);
  const expected = validateBindings(expectedBindings);
  const bindingHash = bindingDigest(bindings);
  digest(value.bindingHash, 'readiness preflight binding hash');
  if (canonicalJson(bindings) !== canonicalJson(expected)
      || value.bindingHash !== bindingHash) {
    fail('readiness preflight replay binding drifted');
  }
  const observations = validateObservations(value.observations, bindings);
  const produced = instant(value.producedAt, 'readiness preflight producedAt');
  const expires = instant(value.expiresAt, 'readiness preflight expiresAt');
  const observed = instant(observedAt, 'readiness preflight observedAt');
  if (expires <= produced || expires - produced > MAX_RECEIPT_LIFETIME_MS
      || observed < produced || observed > expires) {
    fail('readiness preflight receipt is stale or outside its observation window');
  }
  digest(value.producerNonce, 'readiness preflight producer nonce');
  digest(value.receiptHash, 'readiness preflight receipt hash');
  const withoutHash = {
    schema: value.schema,
    bindings,
    bindingHash: value.bindingHash,
    observations,
    producedAt: value.producedAt,
    expiresAt: value.expiresAt,
    producerNonce: value.producerNonce,
  };
  if (!crypto.timingSafeEqual(
    Buffer.from(value.receiptHash, 'hex'),
    Buffer.from(receiptDigest(withoutHash), 'hex'),
  )) fail('readiness preflight receipt hash drifted');
  return Object.freeze(value);
}

export function validateReadinessPreflightPublication(input) {
  const value = canonicalClone(input, 'readiness preflight publication');
  exactKeys(value, PUBLICATION_FIELDS, 'readiness preflight publication');
  if (value.schema !== READINESS_PREFLIGHT_PUBLICATION_SCHEMA
      || value.path !== READINESS_PREFLIGHT_PATH) {
    fail('readiness preflight publication identity drifted');
  }
  const bindings = validateBindings(value.bindings);
  digest(value.receiptHash, 'readiness preflight publication receipt hash');
  digest(value.bindingHash, 'readiness preflight publication binding hash');
  if (value.bindingHash !== bindingDigest(bindings)) {
    fail('readiness preflight publication binding drifted');
  }
  return Object.freeze(value);
}

function attestation(value, label) {
  exactKeys(value, [
    'path', 'kind', 'real', 'symlink', 'ownerUid', 'ownerGid', 'mode', 'nlink',
    'dev', 'ino', 'byteLength', 'sha256',
  ], label);
  if (value.path !== READINESS_PREFLIGHT_PATH
      || value.kind !== 'regular-file'
      || value.real !== true
      || value.symlink !== false
      || value.ownerUid !== 0
      || value.ownerGid !== 0
      || value.mode !== 0o600
      || value.nlink !== 1
      || !/^(?:0|[1-9][0-9]*)$/.test(String(value.dev))
      || !/^(?:0|[1-9][0-9]*)$/.test(String(value.ino))) {
    fail(`${label} custody drifted`, 'ERR_READINESS_PREFLIGHT_CUSTODY');
  }
  integer(value.byteLength, `${label}.byteLength`, 2, MAX_RECEIPT_BYTES);
  digest(value.sha256, `${label}.sha256`);
  return value;
}

function fileAttestation(stat, bytes) {
  return {
    path: READINESS_PREFLIGHT_PATH,
    kind: stat.isFile() ? 'regular-file' : 'other',
    real: true,
    symlink: stat.isSymbolicLink?.() ?? false,
    ownerUid: stat.uid,
    ownerGid: stat.gid,
    mode: stat.mode & 0o777,
    nlink: stat.nlink,
    dev: String(stat.dev),
    ino: String(stat.ino),
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
}

function protectedParent() {
  const directory = path.dirname(READINESS_PREFLIGHT_PATH);
  const stat = fs.lstatSync(directory);
  if (fs.realpathSync.native(directory) !== directory
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.uid !== 0
      || stat.gid !== 0
      || (stat.mode & 0o777) !== 0o700) {
    fail('readiness preflight parent custody drifted', 'ERR_READINESS_PREFLIGHT_CUSTODY');
  }
  return { directory, stat };
}

function defaultStore() {
  return {
    publishExclusive({ path: destination, bytes, mode }) {
      if (destination !== READINESS_PREFLIGHT_PATH || mode !== 0o600 || !Buffer.isBuffer(bytes)) {
        fail('readiness preflight publication escaped its fixed path');
      }
      const { directory } = protectedParent();
      const temporary = path.join(
        directory,
        `.readiness-preflight.${process.pid}.${crypto.randomBytes(16).toString('hex')}.tmp`,
      );
      let descriptor;
      let linked = false;
      try {
        descriptor = fs.openSync(
          temporary,
          FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL |
            (FS_CONSTANTS.O_NOFOLLOW ?? 0),
          mode,
        );
        fs.writeFileSync(descriptor, bytes);
        fs.fchmodSync(descriptor, mode);
        fs.fchownSync(descriptor, 0, 0);
        fs.fsyncSync(descriptor);
        const opened = fs.fstatSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(temporary, destination);
        linked = true;
        fs.unlinkSync(temporary);
        const final = fs.lstatSync(destination);
        const evidence = fileAttestation(final, bytes);
        if (opened.dev !== final.dev || opened.ino !== final.ino) {
          fail('readiness preflight publication identity drifted', 'ERR_READINESS_PREFLIGHT_CUSTODY');
        }
        const parent = fs.openSync(directory, FS_CONSTANTS.O_RDONLY);
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
        return evidence;
      } catch (error) {
        try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch { /* fail closed */ }
        try { fs.unlinkSync(linked ? destination : temporary); } catch { /* no overwrite remains authoritative */ }
        if (error instanceof ReadinessPreflightError) throw error;
        fail(
          error?.code === 'EEXIST'
            ? 'readiness preflight receipt already exists'
            : 'readiness preflight publication failed closed',
          'ERR_READINESS_PREFLIGHT_CUSTODY',
        );
      }
    },
    consumeOnce({ path: source, maxBytes }) {
      if (source !== READINESS_PREFLIGHT_PATH || maxBytes !== MAX_RECEIPT_BYTES) {
        fail('readiness preflight consumption escaped its fixed path');
      }
      const { directory, stat: parentStat } = protectedParent();
      const parentFd = fs.openSync(
        directory,
        FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY ?? 0) |
          (FS_CONSTANTS.O_NOFOLLOW ?? 0),
      );
      let descriptor;
      const scratch = Buffer.allocUnsafe(maxBytes + 1);
      try {
        descriptor = fs.openSync(
          `/proc/self/fd/${parentFd}/${path.basename(source)}`,
          FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0),
        );
        const beforeStat = fs.fstatSync(descriptor);
        let used = 0;
        while (used < scratch.length) {
          const count = fs.readSync(descriptor, scratch, used, scratch.length - used, null);
          if (count === 0) break;
          used += count;
        }
        if (used > maxBytes) fail('readiness preflight receipt exceeds its byte bound');
        const bytes = Buffer.from(scratch.subarray(0, used));
        const afterStat = fs.fstatSync(descriptor);
        const before = fileAttestation(beforeStat, bytes);
        const after = fileAttestation(afterStat, bytes);
        const named = fs.lstatSync(source);
        if (String(named.dev) !== before.dev || String(named.ino) !== before.ino) {
          bytes.fill(0);
          fail('readiness preflight receipt raced before one-time removal',
            'ERR_READINESS_PREFLIGHT_CUSTODY');
        }
        fs.unlinkSync(source);
        const parent = fs.openSync(directory, FS_CONSTANTS.O_RDONLY);
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
        return {
          bytes,
          parent: {
            real: true,
            symlink: false,
            kind: 'directory',
            ownerUid: parentStat.uid,
            ownerGid: parentStat.gid,
            mode: parentStat.mode & 0o777,
          },
          before,
          after,
          removed: !fs.existsSync(source),
        };
      } finally {
        scratch.fill(0);
        if (descriptor !== undefined) fs.closeSync(descriptor);
        fs.closeSync(parentFd);
      }
    },
  };
}

function checkedStore(store) {
  if (!plainObject(store)) throw new TypeError('readiness preflight store must be a plain object');
  return store;
}

export function publishReadinessPreflightReceipt(input, { store = defaultStore() } = {}) {
  const document = Object.hasOwn(input ?? {}, 'receiptHash')
    ? validateReadinessPreflightReceipt(input, {
      expectedBindings: input.bindings,
      observedAt: input.producedAt,
    })
    : createReadinessPreflightReceipt(input);
  const bytes = Buffer.from(canonicalJson(document), 'utf8');
  try {
    const target = checkedStore(store);
    if (typeof target.publishExclusive !== 'function') {
      throw new TypeError('readiness preflight store.publishExclusive is required');
    }
    const evidence = attestation(target.publishExclusive({
      path: READINESS_PREFLIGHT_PATH,
      bytes,
      mode: 0o600,
    }), 'readiness preflight publication');
    if (evidence.byteLength !== bytes.length || evidence.sha256 !== sha256(bytes)) {
      fail('readiness preflight publication content drifted', 'ERR_READINESS_PREFLIGHT_CUSTODY');
    }
    return Object.freeze({
      schema: READINESS_PREFLIGHT_PUBLICATION_SCHEMA,
      path: READINESS_PREFLIGHT_PATH,
      receiptHash: document.receiptHash,
      bindingHash: document.bindingHash,
      bindings: document.bindings,
    });
  } finally {
    bytes.fill(0);
  }
}

export function consumeReadinessPreflightReceipt(publicationInput, {
  observedAt,
  store = defaultStore(),
} = {}) {
  const publication = validateReadinessPreflightPublication(publicationInput);
  const target = checkedStore(store);
  if (typeof target.consumeOnce !== 'function') {
    throw new TypeError('readiness preflight store.consumeOnce is required');
  }
  const consumed = target.consumeOnce({
    path: READINESS_PREFLIGHT_PATH,
    maxBytes: MAX_RECEIPT_BYTES,
  });
  if (!plainObject(consumed)) fail('readiness preflight one-time read failed closed');
  exactKeys(consumed, [
    'bytes', 'parent', 'before', 'after', 'removed',
  ], 'readiness preflight one-time read');
  if (!Buffer.isBuffer(consumed.bytes)) fail('readiness preflight store returned invalid bytes');
  const bytes = consumed.bytes;
  try {
    exactKeys(consumed.parent, [
      'real', 'symlink', 'kind', 'ownerUid', 'ownerGid', 'mode',
    ], 'readiness preflight parent');
    if (consumed.parent.real !== true
        || consumed.parent.symlink !== false
        || consumed.parent.kind !== 'directory'
        || consumed.parent.ownerUid !== 0
        || consumed.parent.ownerGid !== 0
        || consumed.parent.mode !== 0o700) {
      fail('readiness preflight parent custody drifted', 'ERR_READINESS_PREFLIGHT_CUSTODY');
    }
    const before = attestation(consumed.before, 'readiness preflight before-read');
    const after = attestation(consumed.after, 'readiness preflight after-read');
    for (const field of [
      'path', 'kind', 'real', 'symlink', 'ownerUid', 'ownerGid', 'mode', 'nlink',
      'dev', 'ino', 'byteLength', 'sha256',
    ]) {
      if (before[field] !== after[field]) {
        fail('readiness preflight file identity changed during read',
          'ERR_READINESS_PREFLIGHT_CUSTODY');
      }
    }
    if (before.byteLength !== bytes.length || before.sha256 !== sha256(bytes)) {
      fail('readiness preflight bytes drifted from their file attestation',
        'ERR_READINESS_PREFLIGHT_CUSTODY');
    }
    boolean(consumed.removed, 'readiness preflight one-time removal', true);
    const raw = bytes.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail('readiness preflight receipt is malformed JSON'); }
    if (canonicalJson(parsed) !== raw) {
      fail('readiness preflight receipt framing is not canonical');
    }
    const document = validateReadinessPreflightReceipt(parsed, {
      expectedBindings: publication.bindings,
      observedAt,
    });
    if (document.receiptHash !== publication.receiptHash
        || document.bindingHash !== publication.bindingHash) {
      fail('readiness preflight publication replayed a different receipt');
    }
    return document;
  } finally {
    bytes.fill(0);
  }
}

function missingPinnedDenialHelper() {
  fail(
    'a pinned unprivileged canary must actively attempt condition mounts, mount and ptrace denials, socket and egress denials, and task isolation before readiness',
    'ERR_READINESS_PREFLIGHT_MISSING_PINNED_DENIAL_HELPER',
  );
}

function defaultProbes() {
  return {
    async inspectProducer({ bindings }) {
      let bootId = '';
      try { bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch {
        bootId = '';
      }
      return {
        platform: process.platform,
        effectiveUid: process.geteuid?.() ?? process.getuid?.() ?? -1,
        sandboxBootId: bootId,
        executableHashes: {
          producerExecutableHash: bindings.producerExecutableHash,
          readinessProbeExecutableHash: bindings.readinessProbeExecutableHash,
          runnerExecutableHash: bindings.runnerExecutableHash,
          harborExecutableHash: bindings.harborExecutableHash,
          storageAllocatorExecutableHash: bindings.storageAllocatorExecutableHash,
          taskIsolationProbeExecutableHash: bindings.taskIsolationProbeExecutableHash,
          readinessDenialProbeExecutableHash: bindings.readinessDenialProbeExecutableHash,
        },
      };
    },
    async probeConditionMount() { missingPinnedDenialHelper(); },
    async probeProviderAbsence() { missingPinnedDenialHelper(); },
    async probeStorage() { missingPinnedDenialHelper(); },
    async probeRunnerDenials() { missingPinnedDenialHelper(); },
    async probeTaskIsolation() { missingPinnedDenialHelper(); },
  };
}

function checkedProbes(probes) {
  if (!plainObject(probes)) throw new TypeError('readiness preflight probes must be a plain object');
  for (const method of [
    'inspectProducer', 'probeConditionMount', 'probeProviderAbsence',
    'probeStorage', 'probeRunnerDenials', 'probeTaskIsolation',
  ]) {
    if (typeof probes[method] !== 'function') {
      throw new TypeError(`readiness preflight probe ${method} is required`);
    }
  }
  return probes;
}

export async function runReadinessPreflight(input, {
  probes = defaultProbes(),
  store = defaultStore(),
  clock = () => new Date(),
  nonce = () => crypto.randomBytes(32).toString('hex'),
} = {}) {
  const bindings = normalizeProducerInput(input);
  const source = checkedProbes(probes);
  try {
    const producer = await source.inspectProducer(Object.freeze({ bindings }));
    exactKeys(producer, [
      'platform', 'effectiveUid', 'sandboxBootId', 'executableHashes',
    ], 'readiness preflight producer observation');
    if (producer.platform !== 'linux'
        || producer.effectiveUid !== 0
        || producer.sandboxBootId !== bindings.sandboxBootId) {
      fail('readiness preflight requires the bound Linux root and current sandbox boot',
        'ERR_READINESS_PREFLIGHT_PLATFORM');
    }
    exactKeys(producer.executableHashes, [
      'producerExecutableHash', 'readinessProbeExecutableHash',
      'runnerExecutableHash', 'harborExecutableHash',
      'storageAllocatorExecutableHash',
      'taskIsolationProbeExecutableHash', 'readinessDenialProbeExecutableHash',
    ], 'readiness preflight executable observation');
    for (const [field, actual] of Object.entries(producer.executableHashes)) {
      if (actual !== bindings[field]) fail('readiness preflight executable identity drifted');
    }
    const probeSpec = Object.freeze({ bindings });
    // These probes are deliberately sequential. Storage exhaustion and task
    // creation mutate bounded kernel state and must never overlap each other.
    const conditionMount = await source.probeConditionMount(probeSpec);
    const noProvider = await source.probeProviderAbsence(probeSpec);
    const storage = await source.probeStorage(probeSpec);
    const runner = await source.probeRunnerDenials(probeSpec);
    const task = await source.probeTaskIsolation(probeSpec);
    const producedDate = clock();
    if (!(producedDate instanceof Date) || Number.isNaN(producedDate.getTime())) {
      fail('readiness preflight clock returned an invalid instant');
    }
    const producedAt = producedDate.toISOString();
    const expiresAt = new Date(producedDate.getTime() + MAX_RECEIPT_LIFETIME_MS).toISOString();
    const document = createReadinessPreflightReceipt({
      bindings,
      observations: { conditionMount, noProvider, storage, runner, task },
      producedAt,
      expiresAt,
      producerNonce: nonce(),
    });
    return publishReadinessPreflightReceipt(document, { store });
  } catch (error) {
    if (error instanceof ReadinessPreflightError) throw error;
    fail('readiness preflight active probe failed closed');
  }
}
