import crypto from 'node:crypto';
import fs, { constants as FS_CONSTANTS } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  TASK_ISOLATION_PROBE_PATH,
  createTrialSecurityContract,
} from './trial-security-contract.mjs';

export const TASK_CONTAINER_OBSERVATION_SCHEMA = 'engineer-live-task-container-observation.v1';
export const TASK_MOUNT_RECEIPT_PATH = '/engineer-bounded/evidence/task-mount-receipt.json';
export const TASK_ISOLATION_RECEIPT_PATH = '/engineer-bounded/evidence/task-isolation-receipt.json';

const TASK_MOUNT_RECEIPT_SCHEMA = 'engineer-runtime-task-mount-receipt.v1';
const TASK_ISOLATION_RECEIPT_SCHEMA = 'engineer-runtime-task-isolation-receipt.v1';
const PROBE_SCHEMA = 'engineer-task-isolation-observation.v1';
const DOCKER = '/usr/local/bin/docker';
const DAEMON_HOST = 'unix:///run/engineer/private-docker.sock';
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const NAMESPACE_ID = /^dev:(?:0|[1-9][0-9]*):ino:(?:0|[1-9][0-9]*)$/;
const INTERFACE = /^(?:0|[1-9][0-9]*):[A-Za-z0-9_.:-]{1,64}$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export class TaskContainerObserverError extends Error {
  constructor(message, code = 'ERR_TASK_CONTAINER_OBSERVER') {
    super(message);
    this.name = 'TaskContainerObserverError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_TASK_CONTAINER_OBSERVER') {
  throw new TaskContainerObserverError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const keys = Object.keys(value);
  const expected = new Set(fields);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    fail(`${label} contains an unexpected or missing field`);
  }
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} is not a SHA-256 digest`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function defaultRunDocker(args) {
  const result = spawnSync(DOCKER, args, {
    env: { LANG: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderrHash: sha256(result.stderr ?? ''),
    spawnError: result.error?.code ?? null,
  };
}

function runChecked(runDocker, args, label) {
  const result = runDocker(['--host', DAEMON_HOST, ...args]);
  if (!plainObject(result) || result.exitCode !== 0 || result.signal !== null
      || result.spawnError !== null || typeof result.stdout !== 'string'
      || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES
      || !HASH.test(String(result.stderrHash ?? ''))) {
    fail(`${label} failed closed`, 'ERR_TASK_CONTAINER_COMMAND');
  }
  return result.stdout.trim();
}

function parseObject(text, label) {
  try {
    const value = JSON.parse(text);
    if (!plainObject(value)) throw new Error('shape');
    return value;
  } catch {
    fail(`${label} returned malformed JSON`, 'ERR_TASK_CONTAINER_COMMAND');
  }
}

function bindingHash(value) {
  return crypto.createHash('sha256')
    .update('engineer-harness/docker-binding/v1\0')
    .update(String(value))
    .digest('hex');
}

function expectedContract(contractInput) {
  if (!plainObject(contractInput) || !plainObject(contractInput.identity)
      || !plainObject(contractInput.docker)) fail('trial security contract is malformed');
  const expected = createTrialSecurityContract({
    trialId: contractInput.identity.trialId,
    immutableImage: contractInput.docker.pinnedImage,
    cpus: contractInput.docker.resources.nanoCpus / 1_000_000_000,
    memoryMb: contractInput.docker.resources.memoryBytes / (1024 * 1024),
    pidsLimit: contractInput.docker.resources.pidsLimit,
  });
  if (canonicalJson(contractInput) !== canonicalJson(expected)) fail('trial security contract drifted');
  return expected;
}

function normalizedMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.length < 4 || mounts.length > 40) {
    fail('live task mount inventory is outside its bound');
  }
  const values = mounts.map((mount) => {
    if (!plainObject(mount) || mount.type !== 'bind'
        || typeof mount.source !== 'string' || !path.posix.isAbsolute(mount.source)
        || path.posix.normalize(mount.source) !== mount.source
        || typeof mount.destination !== 'string' || !path.posix.isAbsolute(mount.destination)
        || path.posix.normalize(mount.destination) !== mount.destination
        || typeof mount.rw !== 'boolean') {
      fail('live task mount inventory contains an invalid bind');
    }
    return `${mount.source}:${mount.destination}:${mount.rw ? 'rw' : 'ro'}`;
  });
  if (new Set(values).size !== values.length) fail('live task mount inventory contains duplicates');
  return values.sort();
}

function validateProbe(value) {
  exactKeys(value, [
    'schema', 'networkNamespaceIdentity', 'mountNamespaceIdentity',
    'interfaceInventory', 'effectiveCapabilities', 'noNewPrivileges', 'rawSocketDenied',
  ], 'task isolation probe');
  if (value.schema !== PROBE_SCHEMA
      || !NAMESPACE_ID.test(String(value.networkNamespaceIdentity ?? ''))
      || !NAMESPACE_ID.test(String(value.mountNamespaceIdentity ?? ''))
      || !Array.isArray(value.interfaceInventory)
      || value.interfaceInventory.length !== 1
      || !INTERFACE.test(String(value.interfaceInventory[0] ?? ''))
      || !value.interfaceInventory[0].endsWith(':lo')
      || value.effectiveCapabilities !== 0
      || value.noNewPrivileges !== true
      || value.rawSocketDenied !== true) {
    fail('task isolation probe did not prove the required sandbox state');
  }
  return value;
}

export function observeLiveTaskContainer(input, { runDocker = defaultRunDocker } = {}) {
  exactKeys(input, [
    'containerId', 'containerBindingHash', 'contract', 'allowedBindSets',
    'materialization', 'imageDigest', 'probeExecutableHash',
  ], 'live task observation input');
  if (typeof runDocker !== 'function') throw new TypeError('runDocker must be a function');
  if (!CONTAINER_ID.test(String(input.containerId ?? ''))
      || input.containerBindingHash !== bindingHash(input.containerId)) {
    fail('live task container identity drifted');
  }
  const contract = expectedContract(input.contract);
  if (!IMAGE_ID.test(String(input.imageDigest ?? ''))
      || input.imageDigest !== contract.docker.pinnedImage.slice(
        contract.docker.pinnedImage.lastIndexOf('@') + 1
      )) fail('live task image identity drifted');
  digest(input.probeExecutableHash, 'task isolation probe executable hash');
  if (!plainObject(input.materialization)
      || input.materialization.trialId !== contract.identity.trialId
      || input.materialization.runtimeRoot !== contract.identity.runtimeRoot
      || input.materialization.composeHash !== contract.composeHash
      || input.materialization.imageDigest !== input.imageDigest
      || !HASH.test(String(input.materialization.receiptHash ?? ''))
      || typeof input.materialization.workspaceFilesystemId !== 'string') {
    fail('task materialization binding drifted');
  }
  if (!Array.isArray(input.allowedBindSets) || input.allowedBindSets.length < 1
      || input.allowedBindSets.length > 8
      || input.allowedBindSets.some((set) => !Array.isArray(set))) {
    fail('condition-specific bind alternatives are invalid');
  }
  const allowed = input.allowedBindSets.map((set) => canonicalJson([...set].sort()));
  if (new Set(allowed).size !== allowed.length) fail('condition-specific bind alternatives are duplicated');

  const inspected = parseObject(runChecked(runDocker, [
    'container', 'inspect', '--format',
    '{"capDrop":{{json .HostConfig.CapDrop}},"configImage":{{json .Config.Image}},"id":{{json .Id}},"image":{{json .Image}},"mounts":{{json .Mounts}},"networkMode":{{json .HostConfig.NetworkMode}},"readonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"running":{{json .State.Running}},"securityOpt":{{json .HostConfig.SecurityOpt}}}',
    input.containerId,
  ], 'live task container inspection'), 'live task container inspection');
  exactKeys(inspected, [
    'capDrop', 'configImage', 'id', 'image', 'mounts', 'networkMode',
    'readonlyRootfs', 'running', 'securityOpt',
  ], 'live task container inspection');
  if (inspected.id !== input.containerId || inspected.image !== input.imageDigest
      || inspected.configImage !== contract.docker.pinnedImage
      || inspected.networkMode !== 'none' || inspected.readonlyRootfs !== true
      || inspected.running !== true
      || canonicalJson(inspected.capDrop) !== canonicalJson(['ALL'])
      || canonicalJson(inspected.securityOpt) !== canonicalJson(['no-new-privileges:true'])) {
    fail('live task container policy drifted');
  }
  const binds = normalizedMounts(inspected.mounts);
  if (!allowed.includes(canonicalJson(binds))) {
    fail('live task bind inventory drifted from the exact condition policy');
  }
  const writable = binds.filter((bind) => bind.endsWith(':rw'));
  const expectedWritable = contract.docker.allowedBinds.filter((bind) => bind.endsWith(':rw')).sort();
  if (canonicalJson(writable) !== canonicalJson(expectedWritable)) {
    fail('live task writable mount inventory escaped the trial roots');
  }
  const probeBind = `${TASK_ISOLATION_PROBE_PATH}:${TASK_ISOLATION_PROBE_PATH}:ro`;
  if (!binds.includes(probeBind)) fail('live task isolation probe is not a read-only protected bind');

  const probe = validateProbe(parseObject(runChecked(runDocker, [
    'container', 'exec', '--privileged=false', input.containerId, TASK_ISOLATION_PROBE_PATH,
  ], 'task isolation probe'), 'task isolation probe'));
  const unsigned = {
    schema: TASK_CONTAINER_OBSERVATION_SCHEMA,
    trialId: contract.identity.trialId,
    containerIdHash: input.containerBindingHash,
    imageDigest: input.imageDigest,
    materializationReceiptHash: input.materialization.receiptHash,
    probeExecutableHash: input.probeExecutableHash,
    mountNamespaceIdentityHash: sha256(probe.mountNamespaceIdentity),
    networkNamespaceIdentityHash: sha256(probe.networkNamespaceIdentity),
    bindInventoryHash: sha256(`engineer-task-bind-inventory.v1\0${canonicalJson(binds)}`),
    writableMountInventoryHash: sha256(
      `engineer-task-writable-mount-inventory.v1\0${canonicalJson(writable)}`
    ),
    interfaceInventoryHash: sha256(
      `engineer-task-interface-inventory.v1\0${canonicalJson(probe.interfaceInventory)}`
    ),
    rawSocketCanaryHash: sha256(`engineer-task-raw-socket-canary.v1\0denied`),
    workspaceFilesystemId: input.materialization.workspaceFilesystemId,
    networkMode: 'none',
    effectiveCapabilities: 0,
    noNewPrivileges: true,
    taskNetworkNone: true,
    rawSocketDenied: true,
    policyCompliant: true,
    outsideAllowedWrites: false,
  };
  return Object.freeze({ ...unsigned, observationHash: sha256(canonicalJson(unsigned)) });
}

function validateLiveObservation(value) {
  exactKeys(value, [
    'schema', 'trialId', 'containerIdHash', 'imageDigest', 'materializationReceiptHash',
    'probeExecutableHash', 'mountNamespaceIdentityHash', 'networkNamespaceIdentityHash',
    'bindInventoryHash', 'writableMountInventoryHash', 'interfaceInventoryHash',
    'rawSocketCanaryHash', 'workspaceFilesystemId', 'networkMode',
    'effectiveCapabilities', 'noNewPrivileges', 'taskNetworkNone', 'rawSocketDenied',
    'policyCompliant', 'outsideAllowedWrites', 'observationHash',
  ], 'live task observation');
  const { observationHash, ...unsigned } = value;
  for (const field of [
    'containerIdHash', 'materializationReceiptHash', 'probeExecutableHash',
    'mountNamespaceIdentityHash', 'networkNamespaceIdentityHash', 'bindInventoryHash',
    'writableMountInventoryHash', 'interfaceInventoryHash', 'rawSocketCanaryHash',
    'observationHash',
  ]) digest(value[field], `live task observation ${field}`);
  safeId(value.trialId, 'live task observation trial id');
  if (value.schema !== TASK_CONTAINER_OBSERVATION_SCHEMA
      || !IMAGE_ID.test(String(value.imageDigest ?? ''))
      || typeof value.workspaceFilesystemId !== 'string'
      || value.networkMode !== 'none' || value.effectiveCapabilities !== 0
      || value.noNewPrivileges !== true || value.taskNetworkNone !== true
      || value.rawSocketDenied !== true || value.policyCompliant !== true
      || value.outsideAllowedWrites !== false
      || observationHash !== sha256(canonicalJson(unsigned))) {
    fail('live task observation drifted before receipt publication');
  }
  return value;
}

export function createTaskRuntimeReceipts(input) {
  exactKeys(input, [
    'observation', 'requestHash', 'leaseHash', 'proxyEventsHash',
    'producerExecutableHash', 'sandboxBootId', 'trialId', 'producerSessionId',
    'daemonRootFilesystemId',
  ], 'task runtime receipt input');
  const observation = validateLiveObservation(input.observation);
  for (const field of [
    'requestHash', 'leaseHash', 'proxyEventsHash', 'producerExecutableHash',
    'producerSessionId',
  ]) digest(input[field], `task runtime receipt ${field}`);
  safeId(input.sandboxBootId, 'task runtime receipt sandbox boot id');
  safeId(input.trialId, 'task runtime receipt trial id');
  if (input.trialId !== observation.trialId || typeof input.daemonRootFilesystemId !== 'string') {
    fail('task runtime receipt lifecycle binding drifted');
  }
  const common = {
    requestHash: input.requestHash,
    leaseHash: input.leaseHash,
    proxyEventsHash: input.proxyEventsHash,
    containerIdHash: observation.containerIdHash,
  };
  const mount = Object.freeze({
    schema: TASK_MOUNT_RECEIPT_SCHEMA,
    ...common,
    mountNamespaceIdentityHash: observation.mountNamespaceIdentityHash,
    bindInventoryHash: observation.bindInventoryHash,
    writableMountInventoryHash: observation.writableMountInventoryHash,
    inventoryHash: sha256(`engineer-task-mount-receipt-inventory.v1\0${observation.observationHash}`),
    producerExecutableHash: input.producerExecutableHash,
    sandboxBootId: input.sandboxBootId,
    trialId: input.trialId,
    producerSessionId: input.producerSessionId,
    policyCompliant: true,
    outsideAllowedWrites: false,
    daemonRootFilesystemId: input.daemonRootFilesystemId,
    workspaceFilesystemId: observation.workspaceFilesystemId,
  });
  const isolation = Object.freeze({
    schema: TASK_ISOLATION_RECEIPT_SCHEMA,
    ...common,
    imageDigest: observation.imageDigest,
    networkNamespaceIdentityHash: observation.networkNamespaceIdentityHash,
    interfaceInventoryHash: observation.interfaceInventoryHash,
    rawSocketCanaryHash: observation.rawSocketCanaryHash,
    producerExecutableHash: input.producerExecutableHash,
    sandboxBootId: input.sandboxBootId,
    trialId: input.trialId,
    producerSessionId: input.producerSessionId,
    networkMode: 'none',
    effectiveCapabilities: 0,
    noNewPrivileges: true,
    taskNetworkNone: true,
    rawSocketDenied: true,
  });
  return Object.freeze({ mount, isolation });
}

function protectedEvidenceDirectory(directory, filesystem = fs) {
  const stat = filesystem.lstatSync(directory);
  const real = filesystem.realpathSync.native(directory);
  if (real !== directory || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) !== 0) {
    fail('runtime evidence directory custody drifted', 'ERR_TASK_RECEIPT_CUSTODY');
  }
}

export function writeReceiptExclusive(file, document, { filesystem = fs } = {}) {
  const directory = path.dirname(file);
  protectedEvidenceDirectory(directory, filesystem);
  if (filesystem.existsSync(file)) fail('runtime task receipt already exists', 'ERR_TASK_RECEIPT_CUSTODY');
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}`,
  );
  let descriptor;
  let renamed = false;
  try {
    descriptor = filesystem.openSync(
      temporary,
      FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL |
        (FS_CONSTANTS.O_NOFOLLOW ?? 0),
      0o600,
    );
    filesystem.writeFileSync(descriptor, canonicalJson(document));
    filesystem.fsyncSync(descriptor);
    filesystem.closeSync(descriptor);
    descriptor = undefined;
    filesystem.renameSync(temporary, file);
    renamed = true;
    const final = filesystem.lstatSync(file);
    if (!final.isFile() || final.isSymbolicLink() || final.uid !== 0 || final.gid !== 0
        || (final.mode & 0o777) !== 0o600 || final.nlink !== 1) {
      fail('runtime task receipt publication custody drifted', 'ERR_TASK_RECEIPT_CUSTODY');
    }
    const parent = filesystem.openSync(directory, FS_CONSTANTS.O_RDONLY);
    try { filesystem.fsyncSync(parent); } finally { filesystem.closeSync(parent); }
  } catch (error) {
    try { if (descriptor !== undefined) filesystem.closeSync(descriptor); } catch { /* fail closed */ }
    try { filesystem.unlinkSync(renamed ? file : temporary); } catch { /* publication remains failed */ }
    if (error instanceof TaskContainerObserverError) throw error;
    fail('runtime task receipt publication failed', 'ERR_TASK_RECEIPT_CUSTODY');
  }
}

export function publishTaskRuntimeReceipts(receipts, { writeReceipt = writeReceiptExclusive } = {}) {
  exactKeys(receipts, ['mount', 'isolation'], 'task runtime receipts');
  if (typeof writeReceipt !== 'function') throw new TypeError('writeReceipt must be a function');
  let mountPublished = false;
  try {
    writeReceipt(TASK_MOUNT_RECEIPT_PATH, receipts.mount);
    mountPublished = true;
    writeReceipt(TASK_ISOLATION_RECEIPT_PATH, receipts.isolation);
    return Object.freeze({
      mountPath: TASK_MOUNT_RECEIPT_PATH,
      mountHash: sha256(canonicalJson(receipts.mount)),
      isolationPath: TASK_ISOLATION_RECEIPT_PATH,
      isolationHash: sha256(canonicalJson(receipts.isolation)),
    });
  } catch (error) {
    if (mountPublished && writeReceipt === writeReceiptExclusive) {
      try { fs.unlinkSync(TASK_MOUNT_RECEIPT_PATH); } catch { /* fail remains authoritative */ }
    }
    throw error;
  }
}
