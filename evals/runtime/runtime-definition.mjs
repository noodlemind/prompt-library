/**
 * One-shot, root-owned runtime definition for the per-trial supervisor.
 *
 * The Daytona controller never supplies this definition. The trusted image
 * provisioner publishes one canonical receipt at a fixed path after it has
 * verified the immutable task image. The supervisor consumes (unlinks) that
 * receipt through a no-follow descriptor, re-attests the protected snapshot
 * manifest and live Linux identities, and then adds code-owned policy builder
 * functions. Provider credentials are neither observed nor represented here.
 */
import crypto from 'node:crypto';
import fs, { constants as FS_CONSTANTS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';

import {
  buildControlledProviderBrokerPolicy,
  controlledProviderBrokerStaticPolicyHash,
} from './controlled-provider-policy.mjs';
import { DAYTONA_EXECUTABLE_PATHS } from './daytona-topology.mjs';
import {
  snapshotBuildManifestHash,
  validateSnapshotBuildManifest,
} from './snapshot-build-manifest.mjs';
import { createTrialSecurityContract } from './trial-security-contract.mjs';
import { archivedConditionReadOnlyBindVariants } from './trial-archive.mjs';
import { attestDaemonAdoptionReceipt } from './snapshot-manager.mjs';

export const RUNTIME_TOPOLOGY_RECEIPT_PATH =
  '/engineer-bounded/evidence/runtime-topology-receipt.json';
export const RUNTIME_TOPOLOGY_RECEIPT_SCHEMA = 'engineer-runtime-topology-receipt.v1';

const SNAPSHOT_BUILD_MANIFEST_PATH = '/opt/engineer/snapshot/build-manifest.json';
const TASK_IMAGE_PRELOAD_MARKER_PATH = '/engineer-bounded/evidence/task-image-preload.json';
const PRIVATE_DOCKER_SOCKET = '/run/engineer/private-docker.sock';
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const RECEIPT_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const MARKER_MAX_BYTES = 8 * 1024;
const EXECUTABLE_MAX_BYTES = 128 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}@sha256:[a-f0-9]{64}$/;
const RAW_CREDENTIAL_ENV = /(?:^DAYTONA(?:_|$)|OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|GROQ|XAI|MISTRAL|COHERE|TOGETHER|FIREWORKS|DEEPSEEK|CEREBRAS|PERPLEXITY|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const CREDENTIAL_VALUE = /(?:Bearer\s+|sk-(?:or|ant|proj)-|github_pat_|gh[pousr]_|xox[baprs]-|hf_[A-Za-z0-9])/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const RUNTIME_EXECUTABLE_NAMES = Object.freeze([
  'dockerd', 'cgroupExec', 'taskIsolationProbe', 'iptables', 'ip6tables', 'supervisor',
  'providerBroker', 'readinessProbe', 'evidenceCollector', 'runner', 'harbor', 'sentinel',
]);
const EXECUTABLE_PATHS = Object.freeze(Object.fromEntries(
  RUNTIME_EXECUTABLE_NAMES.map((name) => [name, DAYTONA_EXECUTABLE_PATHS[name]])
));

const FIXED_PATHS = Object.freeze({
  runtimeDirectory: '/run/engineer',
  evidenceDirectory: '/engineer-bounded/evidence',
  evidenceReserve: '/engineer-bounded/evidence/.reserve',
  workspace: '/engineer-bounded/work',
  daemonDataRoot: '/engineer-bounded/docker',
  daemonExecRoot: '/run/engineer/docker-exec',
  daemonPidFile: '/run/engineer/private-docker.pid',
  daemonSocket: PRIVATE_DOCKER_SOCKET,
  proxySocket: '/run/engineer/harbor-docker.sock',
  brokerDirectory: '/run/engineer/provider',
  brokerSocket: '/run/engineer/provider/provider.sock',
  brokerPolicyDirectory: '/engineer-bounded/broker',
  brokerPolicy: '/engineer-bounded/broker/provider-policy.json',
});

const RECEIPT_FIELDS = Object.freeze([
  'schema',
  'receiptVersion',
  'buildManifestHash',
  'receiptNonce',
  'bindings',
  'task',
  'preload',
  'topology',
]);

export class RuntimeDefinitionError extends Error {
  constructor(message, code = 'ERR_RUNTIME_DEFINITION') {
    super(message);
    this.name = 'RuntimeDefinitionError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_RUNTIME_DEFINITION') {
  throw new RuntimeDefinitionError(message, code);
}

function sanitized(error, message, code) {
  if (error instanceof RuntimeDefinitionError) return error;
  return new RuntimeDefinitionError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label, code = 'ERR_RUNTIME_DEFINITION_SCHEMA') {
  if (!plainObject(value)) fail(`${label} must be a plain object`, code);
  const allowed = new Set(expected);
  const actual = Object.keys(value);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    fail(`${label} contains an unexpected or missing field`, code);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value, depth = 0, nodes = { count: 0 }) {
  nodes.count += 1;
  if (depth > 24 || nodes.count > 8_192) {
    fail('runtime topology receipt exceeds its structural bound', 'ERR_RUNTIME_DEFINITION_BOUND');
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1, nodes)).join(',')}]`;
  }
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, nodes)}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))) {
    return JSON.stringify(value);
  }
  fail('runtime topology receipt contains a non-canonical value', 'ERR_RUNTIME_DEFINITION_SCHEMA');
}

function canonicalClone(value, label) {
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > RECEIPT_MAX_BYTES) {
    fail(`${label} exceeds its byte bound`, 'ERR_RUNTIME_DEFINITION_BOUND');
  }
  if (CREDENTIAL_VALUE.test(encoded)) {
    fail(`${label} resembles credential material`, 'ERR_RUNTIME_DEFINITION_SECRET');
  }
  return { value: JSON.parse(encoded), encoded };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digest(value, label, code = 'ERR_RUNTIME_DEFINITION_IDENTITY') {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} is invalid`, code);
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || CREDENTIAL_VALUE.test(value)) {
    fail(`${label} is invalid`, 'ERR_RUNTIME_DEFINITION_IDENTITY');
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is outside its bound`, 'ERR_RUNTIME_DEFINITION_BOUND');
  }
  return value;
}

function assertCredentialFreeEnvironment(environment) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('runtime environment cannot be inspected', 'ERR_RUNTIME_DEFINITION_ENVIRONMENT');
  }
  let names;
  try { names = Object.keys(environment); } catch {
    fail('runtime environment cannot be inspected', 'ERR_RUNTIME_DEFINITION_ENVIRONMENT');
  }
  for (const name of names) {
    if (RAW_CREDENTIAL_ENV.test(name)) {
      fail('ambient cloud or provider credentials are forbidden', 'ERR_RUNTIME_DEFINITION_ENVIRONMENT');
    }
    let value;
    try { value = environment[name]; } catch {
      fail('runtime environment cannot be inspected', 'ERR_RUNTIME_DEFINITION_ENVIRONMENT');
    }
    if (typeof value === 'string' && CREDENTIAL_VALUE.test(value)) {
      fail('ambient cloud or provider credential material is forbidden',
        'ERR_RUNTIME_DEFINITION_ENVIRONMENT');
    }
  }
}

function validateProvisionRequest(value) {
  exactKeys(value, ['sandboxId', 'immutableImage', 'imageId', 'platform'], 'provision request');
  const sandboxId = safeId(value.sandboxId, 'sandbox identity');
  if (typeof value.immutableImage !== 'string' || !IMMUTABLE_IMAGE.test(value.immutableImage) ||
      typeof value.imageId !== 'string' || !IMAGE_ID.test(value.imageId) ||
      !value.immutableImage.endsWith(`@${value.imageId}`)) {
    fail('provision request image identity drifted', 'ERR_RUNTIME_DEFINITION_IDENTITY');
  }
  if (value.platform !== 'linux/amd64') {
    fail('provision request platform drifted', 'ERR_RUNTIME_DEFINITION_IDENTITY');
  }
  return { sandboxId, immutableImage: value.immutableImage, imageId: value.imageId, platform: value.platform };
}

function validatePreload(value, request) {
  exactKeys(value, [
    'sandboxId', 'immutableImage', 'imageId', 'platform',
    'pullReceiptHash', 'inspectReceiptHash', 'markerSha256',
  ], 'preload binding');
  for (const field of ['sandboxId', 'immutableImage', 'imageId', 'platform']) {
    if (value[field] !== request[field]) {
      fail(`preload ${field} drifted`, 'ERR_RUNTIME_DEFINITION_IDENTITY');
    }
  }
  for (const field of ['pullReceiptHash', 'inspectReceiptHash', 'markerSha256']) {
    digest(value[field], `preload ${field}`);
  }
  return { ...value };
}

function resolveTask(buildManifest, request) {
  const matches = Object.entries(buildManifest.taskImages).filter(([, task]) =>
    task.immutableImage === request.immutableImage && task.imageId === request.imageId &&
    task.platform === request.platform);
  if (matches.length !== 1) {
    fail('provisioned image does not identify exactly one snapshot task',
      'ERR_RUNTIME_DEFINITION_IDENTITY');
  }
  const [taskId, task] = matches[0];
  safeId(taskId, 'task identity');
  return { taskId, ...task };
}

function manifestExecutableHashes(buildManifest) {
  const result = {};
  for (const [name, expectedPath] of Object.entries(EXECUTABLE_PATHS)) {
    const executable = buildManifest.executables[name];
    if (!plainObject(executable) || executable.path !== expectedPath) {
      fail(`snapshot manifest is missing fixed executable ${name}`,
        'ERR_RUNTIME_DEFINITION_EXECUTABLE');
    }
    result[name] = digest(executable.sha256, `${name} executable digest`,
      'ERR_RUNTIME_DEFINITION_EXECUTABLE');
  }
  return result;
}

function validateObservation(value, buildManifest, preload) {
  exactKeys(value, [
    'platform', 'effectiveUid', 'sandboxBootId', 'daemonId', 'filesystem',
    'executableHashes', 'preloadMarkerSha256', 'cgroupV2', 'cgroupKillAvailable',
    'providerCredentialsAbsent', 'daytonaCredentialsAbsent',
  ], 'runtime observation');
  if (value.platform !== 'linux' || value.effectiveUid !== 0) {
    fail('runtime observation requires Linux root', 'ERR_RUNTIME_DEFINITION_PLATFORM');
  }
  if (typeof value.sandboxBootId !== 'string' || !BOOT_ID.test(value.sandboxBootId)) {
    fail('runtime boot identity is invalid', 'ERR_RUNTIME_DEFINITION_IDENTITY');
  }
  safeId(value.daemonId, 'private daemon identity');
  exactKeys(value.filesystem, [
    'boundedRootId', 'boundedRootBytes', 'defaultDockerRootId',
  ], 'runtime filesystem observation');
  safeId(value.filesystem.boundedRootId, 'bounded filesystem identity');
  safeId(value.filesystem.defaultDockerRootId, 'default Docker filesystem identity');
  if (value.filesystem.boundedRootId === value.filesystem.defaultDockerRootId ||
      value.filesystem.boundedRootBytes !== TEN_GIB) {
    fail('bounded runtime filesystem identity or size drifted', 'ERR_RUNTIME_DEFINITION_FILESYSTEM');
  }
  exactKeys(value.executableHashes, Object.keys(EXECUTABLE_PATHS), 'runtime executable hashes');
  const expectedHashes = manifestExecutableHashes(buildManifest);
  for (const name of Object.keys(EXECUTABLE_PATHS)) {
    digest(value.executableHashes[name], `${name} observed executable hash`,
      'ERR_RUNTIME_DEFINITION_EXECUTABLE');
    if (value.executableHashes[name] !== expectedHashes[name]) {
      fail(`runtime executable ${name} drifted`, 'ERR_RUNTIME_DEFINITION_EXECUTABLE');
    }
  }
  if (value.preloadMarkerSha256 !== preload.markerSha256) {
    fail('preload marker identity drifted', 'ERR_RUNTIME_DEFINITION_MARKER');
  }
  for (const field of [
    'cgroupV2', 'cgroupKillAvailable', 'providerCredentialsAbsent', 'daytonaCredentialsAbsent',
  ]) {
    if (value[field] !== true) {
      fail(`runtime observation ${field} is not attested`,
        field.includes('Credentials')
          ? 'ERR_RUNTIME_DEFINITION_ENVIRONMENT'
          : 'ERR_RUNTIME_DEFINITION_CGROUP');
    }
  }
  return value;
}

function buildTopology({ request, preload, buildManifest, observation }) {
  const task = resolveTask(buildManifest, request);
  const executableHashes = manifestExecutableHashes(buildManifest);
  validateObservation(observation, buildManifest, preload);
  const cgroupSeed = sha256(`engineer-trial-cgroup.v1\0${request.sandboxId}\0${request.imageId}`);
  const cgroupId = `trial-${cgroupSeed.slice(0, 32)}`;
  const cgroupPath = `/sys/fs/cgroup/engineer/${cgroupId}`;
  const daemonRootHash = sha256(canonicalJson({
    schema: 'engineer-daemon-root-identity.v1',
    path: FIXED_PATHS.daemonDataRoot,
    filesystemId: observation.filesystem.boundedRootId,
  }));
  const topology = {
    sandboxId: request.sandboxId,
    sandboxBootId: observation.sandboxBootId,
    daemonId: observation.daemonId,
    filesystem: {
      sandboxRoot: '/engineer-bounded',
      boundedRoot: '/engineer-bounded',
      defaultDockerRoot: '/var/lib/docker',
      expectedBytes: TEN_GIB,
      id: observation.filesystem.boundedRootId,
      defaultDockerRootId: observation.filesystem.defaultDockerRootId,
    },
    paths: { ...FIXED_PATHS },
    executables: { ...EXECUTABLE_PATHS },
    hashes: { ...executableHashes, daemonRoot: daemonRootHash },
    identities: {
      supervisorUid: 0,
      runnerUid: 2001,
      runnerGid: 2001,
      brokerUid: 2002,
      brokerGid: 2002,
      brokerClientGid: 2003,
    },
    cgroup: {
      id: cgroupId,
      path: cgroupPath,
      pathHash: sha256(cgroupPath),
      cpuMax: `${task.cpus * 100_000} 100000`,
      memoryMax: task.memoryMb * 1024 * 1024,
      pidsMax: 256,
    },
    imageDigest: request.imageId,
    custody: { evidenceRetentionDays: 30 },
    timeouts: {
      daemonReadyMs: 30_000,
      brokerReadyMs: 30_000,
      helperMs: 30_000,
      shutdownMs: 30_000,
    },
    snapshotCredentialExclusion: true,
  };
  return { task, topology };
}

/** Create the exact canonical receipt published by the trusted provisioner. */
export function createRuntimeTopologyReceipt({
  request: requestInput,
  preload: preloadInput,
  buildManifest: manifestInput,
  observation: observationInput,
} = {}) {
  let buildManifest;
  try { buildManifest = validateSnapshotBuildManifest(manifestInput); } catch {
    fail('snapshot build manifest is invalid', 'ERR_RUNTIME_DEFINITION_MANIFEST');
  }
  const request = validateProvisionRequest(requestInput);
  const preload = validatePreload(preloadInput, request);
  const observation = validateObservation(observationInput, buildManifest, preload);
  const { task, topology } = buildTopology({ request, preload, buildManifest, observation });
  const buildManifestHash = snapshotBuildManifestHash(buildManifest);
  const unsigned = {
    schema: RUNTIME_TOPOLOGY_RECEIPT_SCHEMA,
    receiptVersion: 1,
    buildManifestHash,
    bindings: structuredClone(buildManifest.bindings),
    task,
    preload,
    topology,
  };
  const receiptNonce = sha256(`engineer-runtime-topology-receipt.v1\0${canonicalJson(unsigned)}`);
  const receipt = { ...unsigned, receiptNonce };
  // Preserve the explicit schema order in the in-memory result while the byte
  // representation remains recursively key-sorted.
  exactKeys(receipt, RECEIPT_FIELDS, 'runtime topology receipt');
  const { value, encoded } = canonicalClone(receipt, 'runtime topology receipt');
  return deepFreeze({ receipt: value, canonicalJson: encoded, sha256: sha256(encoded) });
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateReceiptDocument(value, { buildManifest, observation }) {
  exactKeys(value, RECEIPT_FIELDS, 'runtime topology receipt', 'ERR_RUNTIME_DEFINITION_RECEIPT');
  if (value.schema !== RUNTIME_TOPOLOGY_RECEIPT_SCHEMA || value.receiptVersion !== 1) {
    fail('runtime topology receipt schema drifted', 'ERR_RUNTIME_DEFINITION_RECEIPT');
  }
  const rebuilt = createRuntimeTopologyReceipt({
    request: {
      sandboxId: value.preload?.sandboxId,
      immutableImage: value.preload?.immutableImage,
      imageId: value.preload?.imageId,
      platform: value.preload?.platform,
    },
    preload: value.preload,
    buildManifest,
    observation,
  });
  if (!sameJson(value, rebuilt.receipt)) {
    fail('runtime topology receipt identity drifted', 'ERR_RUNTIME_DEFINITION_IDENTITY');
  }
  return rebuilt.receipt;
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function inspectParent(target, expectedOwnerUid) {
  const parent = path.posix.dirname(target);
  const [real, stat] = await Promise.all([
    fsp.realpath(parent),
    fsp.lstat(parent, { bigint: true }),
  ]);
  if (real !== parent || !stat.isDirectory() || stat.isSymbolicLink() ||
      Number(stat.uid) !== expectedOwnerUid || (Number(stat.mode) & 0o022) !== 0) {
    fail('runtime topology receipt parent custody drifted', 'ERR_RUNTIME_DEFINITION_RECEIPT');
  }
  return parent;
}

async function readProtectedFile(target, {
  maximum,
  exactMode = null,
  expectedOwnerUid = 0,
  unlinkAfterRead = false,
} = {}) {
  let handle;
  let bytes = null;
  try {
    const parent = await inspectParent(target, expectedOwnerUid);
    const [real, before] = await Promise.all([
      fsp.realpath(target),
      fsp.lstat(target, { bigint: true }),
    ]);
    if (real !== target || before.isSymbolicLink() || !before.isFile() ||
        Number(before.uid) !== expectedOwnerUid ||
        (exactMode == null ? (Number(before.mode) & 0o022) !== 0 :
          (Number(before.mode) & 0o777) !== exactMode) ||
        before.size < 1n || before.size > BigInt(maximum)) {
      fail('protected runtime file custody drifted', 'ERR_RUNTIME_DEFINITION_RECEIPT');
    }
    handle = await fsp.open(target, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) {
      fail('protected runtime file changed before descriptor binding',
        'ERR_RUNTIME_DEFINITION_RECEIPT');
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead < 1) fail('protected runtime file ended during read', 'ERR_RUNTIME_DEFINITION_RECEIPT');
      offset += bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (!sameStat(opened, afterRead)) {
      fail('protected runtime file changed during read', 'ERR_RUNTIME_DEFINITION_RECEIPT');
    }
    if (unlinkAfterRead) {
      const linked = await fsp.lstat(target, { bigint: true });
      if (!sameStat(afterRead, linked)) {
        fail('runtime topology receipt target changed before consumption',
          'ERR_RUNTIME_DEFINITION_RECEIPT');
      }
      await fsp.unlink(target);
      const directory = await fsp.open(parent,
        FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY ?? 0));
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return {
      bytes,
      attestation: {
        path: target,
        kind: 'regular-file',
        real: true,
        symlink: false,
        ownerUid: Number(opened.uid),
        ownerGid: Number(opened.gid),
        mode: Number(opened.mode) & 0o777,
        byteLength: bytes.length,
        sha256: sha256(bytes),
      },
    };
  } catch (error) {
    bytes?.fill(0);
    throw sanitized(error, 'protected runtime file is unavailable', 'ERR_RUNTIME_DEFINITION_RECEIPT');
  } finally {
    try { await handle?.close(); } catch { /* the operation remains fail-closed */ }
  }
}

async function defaultLoadBuildManifest() {
  const inspected = await readProtectedFile(SNAPSHOT_BUILD_MANIFEST_PATH, {
    maximum: MANIFEST_MAX_BYTES,
    expectedOwnerUid: 0,
  });
  try {
    let text;
    try { text = UTF8.decode(inspected.bytes); } catch {
      fail('snapshot build manifest is not canonical UTF-8', 'ERR_RUNTIME_DEFINITION_MANIFEST');
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      fail('snapshot build manifest JSON is malformed', 'ERR_RUNTIME_DEFINITION_MANIFEST');
    }
    if (canonicalJson(parsed) !== text) {
      fail('snapshot build manifest JSON is not canonical', 'ERR_RUNTIME_DEFINITION_MANIFEST');
    }
    try { return validateSnapshotBuildManifest(parsed); } catch {
      fail('snapshot build manifest schema is invalid', 'ERR_RUNTIME_DEFINITION_MANIFEST');
    }
  } finally {
    inspected.bytes.fill(0);
  }
}

function protectedExecutableHash(file) {
  let descriptor;
  try {
    const real = fs.realpathSync.native(file);
    const before = fs.lstatSync(file, { bigint: true });
    if (real !== file || before.isSymbolicLink() || !before.isFile() || Number(before.uid) !== 0 ||
        (Number(before.mode) & 0o022) !== 0 || (Number(before.mode) & 0o111) === 0 ||
        before.size < 1n || before.size > BigInt(EXECUTABLE_MAX_BYTES)) {
      fail('protected runtime executable custody drifted', 'ERR_RUNTIME_DEFINITION_EXECUTABLE');
    }
    descriptor = fs.openSync(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(before, opened)) {
      fail('protected runtime executable changed before hashing',
        'ERR_RUNTIME_DEFINITION_EXECUTABLE');
    }
    const bytes = fs.readFileSync(descriptor);
    try {
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!sameStat(opened, after)) {
        fail('protected runtime executable changed during hashing',
          'ERR_RUNTIME_DEFINITION_EXECUTABLE');
      }
      return sha256(bytes);
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    throw sanitized(error, 'protected runtime executable is unavailable',
      'ERR_RUNTIME_DEFINITION_EXECUTABLE');
  } finally {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch { /* fail closed */ }
  }
}

function statFilesystem(target) {
  const stat = fs.statSync(target, { bigint: true });
  const filesystem = fs.statfsSync(target, { bigint: true });
  const bytes = filesystem.bsize * filesystem.blocks;
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('runtime filesystem exceeds its evidence bound', 'ERR_RUNTIME_DEFINITION_FILESYSTEM');
  }
  return { id: `dev:${stat.dev.toString(16)}`, bytes: Number(bytes) };
}

async function defaultObserveRuntime({ buildManifest }) {
  assertCredentialFreeEnvironment(process.env);
  if (process.platform !== 'linux' || (process.geteuid?.() ?? process.getuid?.()) !== 0) {
    fail('runtime definition observation requires Linux root', 'ERR_RUNTIME_DEFINITION_PLATFORM');
  }
  const bounded = statFilesystem('/engineer-bounded');
  const defaultRoot = statFilesystem('/var/lib/docker');
  const adoption = await attestDaemonAdoptionReceipt();
  if (adoption.sandboxBootId !== fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() ||
      adoption.filesystem.boundedRootId !== bounded.id ||
      adoption.filesystem.boundedRootBytes !== bounded.bytes ||
      adoption.filesystem.defaultDockerRootId !== defaultRoot.id) {
    fail('private daemon adoption identity drifted', 'ERR_RUNTIME_DEFINITION_DAEMON');
  }
  const marker = await readProtectedFile(TASK_IMAGE_PRELOAD_MARKER_PATH, {
    maximum: MARKER_MAX_BYTES,
    exactMode: 0o600,
    expectedOwnerUid: 0,
  });
  try {
    return {
      platform: process.platform,
      effectiveUid: process.geteuid?.() ?? process.getuid?.(),
      sandboxBootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      daemonId: safeId(adoption.daemon.daemonId, 'private daemon identity'),
      filesystem: {
        boundedRootId: bounded.id,
        boundedRootBytes: bounded.bytes,
        defaultDockerRootId: defaultRoot.id,
      },
      executableHashes: Object.fromEntries(Object.entries(EXECUTABLE_PATHS).map(([name, file]) => [
        name,
        protectedExecutableHash(file),
      ])),
      preloadMarkerSha256: marker.attestation.sha256,
      cgroupV2: fs.existsSync('/sys/fs/cgroup/cgroup.controllers'),
      cgroupKillAvailable: fs.existsSync('/sys/fs/cgroup/cgroup.kill'),
      providerCredentialsAbsent: Object.keys(process.env).every((name) => !RAW_CREDENTIAL_ENV.test(name)),
      daytonaCredentialsAbsent: Object.keys(process.env).every((name) => !/^DAYTONA(?:_|$)/i.test(name)),
    };
  } finally {
    marker.bytes.fill(0);
  }
}

function validateReceiptAttestation(value, bytes = null) {
  exactKeys(value, [
    'path', 'kind', 'real', 'symlink', 'ownerUid', 'ownerGid', 'mode', 'byteLength', 'sha256',
  ], 'runtime topology receipt attestation', 'ERR_RUNTIME_DEFINITION_RECEIPT');
  const actualBytes = bytes == null ? null : Buffer.from(bytes);
  try {
    if (value.path !== RUNTIME_TOPOLOGY_RECEIPT_PATH || value.kind !== 'regular-file' ||
        value.real !== true || value.symlink !== false || value.ownerUid !== 0 ||
        value.ownerGid !== 0 || value.mode !== 0o600 || !Number.isSafeInteger(value.byteLength) ||
        value.byteLength < 1 || value.byteLength > RECEIPT_MAX_BYTES ||
        !HASH.test(String(value.sha256)) ||
        (actualBytes != null && (actualBytes.length !== value.byteLength ||
          sha256(actualBytes) !== value.sha256))) {
      fail('runtime topology receipt custody, size, or digest drifted',
        'ERR_RUNTIME_DEFINITION_RECEIPT');
    }
    return { ...value };
  } finally {
    actualBytes?.fill(0);
  }
}

function defaultReceiptStore() {
  return Object.freeze({
    async publish({ bytes, expectedSha256 }) {
      const owned = Buffer.from(bytes ?? []);
      let handle;
      let temporary = null;
      try {
        if (owned.length < 1 || owned.length > RECEIPT_MAX_BYTES || sha256(owned) !== expectedSha256) {
          fail('runtime topology receipt publication bytes drifted', 'ERR_RUNTIME_DEFINITION_RECEIPT');
        }
        const parent = await inspectParent(RUNTIME_TOPOLOGY_RECEIPT_PATH, 0);
        try {
          await fsp.lstat(RUNTIME_TOPOLOGY_RECEIPT_PATH);
          fail('runtime topology receipt already exists', 'ERR_RUNTIME_DEFINITION_RECEIPT');
        } catch (error) {
          if (error instanceof RuntimeDefinitionError) throw error;
          if (error?.code !== 'ENOENT') {
            fail('runtime topology receipt path cannot be inspected',
              'ERR_RUNTIME_DEFINITION_RECEIPT');
          }
        }
        temporary = `${RUNTIME_TOPOLOGY_RECEIPT_PATH}.tmp-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
        handle = await fsp.open(temporary,
          FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_WRONLY |
            (FS_CONSTANTS.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(owned);
        await handle.chmod(0o600);
        await handle.chown(0, 0);
        await handle.sync();
        await handle.close();
        handle = null;
        await fsp.link(temporary, RUNTIME_TOPOLOGY_RECEIPT_PATH);
        await fsp.unlink(temporary);
        temporary = null;
        const directory = await fsp.open(parent,
          FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY ?? 0));
        try { await directory.sync(); } finally { await directory.close(); }
        const inspected = await readProtectedFile(RUNTIME_TOPOLOGY_RECEIPT_PATH, {
          maximum: RECEIPT_MAX_BYTES,
          exactMode: 0o600,
          expectedOwnerUid: 0,
        });
        try { return validateReceiptAttestation(inspected.attestation, inspected.bytes); }
        finally { inspected.bytes.fill(0); }
      } catch (error) {
        throw sanitized(error, 'runtime topology receipt publication failed',
          'ERR_RUNTIME_DEFINITION_RECEIPT');
      } finally {
        owned.fill(0);
        try { await handle?.close(); } catch { /* fail closed */ }
        if (temporary != null) {
          try { await fsp.unlink(temporary); } catch { /* fail closed */ }
        }
      }
    },
    async consume() {
      return readProtectedFile(RUNTIME_TOPOLOGY_RECEIPT_PATH, {
        maximum: RECEIPT_MAX_BYTES,
        exactMode: 0o600,
        expectedOwnerUid: 0,
        unlinkAfterRead: true,
      });
    },
    async remove() {
      await inspectParent(RUNTIME_TOPOLOGY_RECEIPT_PATH, 0);
      try { await fsp.unlink(RUNTIME_TOPOLOGY_RECEIPT_PATH); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      try {
        await fsp.lstat(RUNTIME_TOPOLOGY_RECEIPT_PATH);
        fail('runtime topology receipt removal did not make the path absent',
          'ERR_RUNTIME_DEFINITION_RECEIPT');
      } catch (error) {
        if (error instanceof RuntimeDefinitionError) throw error;
        if (error?.code !== 'ENOENT') {
          fail('runtime topology receipt absence cannot be attested',
            'ERR_RUNTIME_DEFINITION_RECEIPT');
        }
      }
      return { path: RUNTIME_TOPOLOGY_RECEIPT_PATH, absent: true };
    },
  });
}

function resolveDependencies(input = {}) {
  if (!plainObject(input)) fail('runtime definition dependencies are invalid',
    'ERR_RUNTIME_DEFINITION_CONFIG');
  const allowed = new Set(['loadBuildManifest', 'observeRuntime', 'receiptStore']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    fail('runtime definition dependencies contain an unexpected field',
      'ERR_RUNTIME_DEFINITION_CONFIG');
  }
  const loadBuildManifest = input.loadBuildManifest ?? defaultLoadBuildManifest;
  const observeRuntime = input.observeRuntime ?? defaultObserveRuntime;
  const receiptStore = input.receiptStore ?? defaultReceiptStore();
  if (typeof loadBuildManifest !== 'function' || typeof observeRuntime !== 'function' ||
      !plainObject(receiptStore) || ['publish', 'consume', 'remove']
        .some((method) => typeof receiptStore[method] !== 'function')) {
    fail('runtime definition dependencies are incomplete', 'ERR_RUNTIME_DEFINITION_CONFIG');
  }
  return { loadBuildManifest, observeRuntime, receiptStore };
}

async function loadAndValidateManifest(loadBuildManifest) {
  let manifest;
  try { manifest = await loadBuildManifest(); } catch (error) {
    throw sanitized(error, 'snapshot build manifest is unavailable',
      'ERR_RUNTIME_DEFINITION_MANIFEST');
  }
  try { return validateSnapshotBuildManifest(manifest); } catch {
    fail('snapshot build manifest is invalid', 'ERR_RUNTIME_DEFINITION_MANIFEST');
  }
}

async function observeAndValidate(observeRuntime, buildManifest, preload) {
  let observed;
  try { observed = await observeRuntime({ buildManifest }); } catch (error) {
    throw sanitized(error, 'trusted runtime observation failed',
      'ERR_RUNTIME_DEFINITION_OBSERVATION');
  }
  return validateObservation(observed, buildManifest, preload);
}

/** Publish the receipt only after the trusted task-image preload has passed. */
export async function publishProvisionedRuntimeTopologyReceipt({
  request: requestInput,
  preload: preloadInput,
  dependencies: dependencyInput = {},
} = {}) {
  const dependencies = resolveDependencies(dependencyInput);
  const request = validateProvisionRequest(requestInput);
  const preload = validatePreload(preloadInput, request);
  const buildManifest = await loadAndValidateManifest(dependencies.loadBuildManifest);
  const observation = await observeAndValidate(
    dependencies.observeRuntime, buildManifest, preload
  );
  const built = createRuntimeTopologyReceipt({ request, preload, buildManifest, observation });
  const bytes = Buffer.from(built.canonicalJson);
  try {
    let attestation;
    try {
      attestation = await dependencies.receiptStore.publish({
        bytes,
        expectedSha256: built.sha256,
      });
    } catch (error) {
      throw sanitized(error, 'runtime topology receipt publication failed',
        'ERR_RUNTIME_DEFINITION_RECEIPT');
    }
    const checked = validateReceiptAttestation(attestation, bytes);
    return deepFreeze({ ...checked, receiptNonce: built.receipt.receiptNonce });
  } finally {
    bytes.fill(0);
  }
}

/** Remove only the fixed receipt; used by provisioner rollback/cleanup. */
export async function removeProvisionedRuntimeTopologyReceipt({ dependencies: dependencyInput = {} } = {}) {
  const dependencies = resolveDependencies(dependencyInput);
  let receipt;
  try { receipt = await dependencies.receiptStore.remove(); } catch (error) {
    throw sanitized(error, 'runtime topology receipt removal failed',
      'ERR_RUNTIME_DEFINITION_RECEIPT');
  }
  exactKeys(receipt, ['path', 'absent'], 'runtime topology removal receipt',
    'ERR_RUNTIME_DEFINITION_RECEIPT');
  if (receipt.path !== RUNTIME_TOPOLOGY_RECEIPT_PATH || receipt.absent !== true) {
    fail('runtime topology removal receipt drifted', 'ERR_RUNTIME_DEFINITION_RECEIPT');
  }
  return deepFreeze({ ...receipt });
}

function validatePolicyContext(context, receipt) {
  if (!plainObject(context) || !plainObject(context.request) ||
      !plainObject(context.request.bindings) || !plainObject(context.request.budget)) {
    fail('runtime policy context is incomplete', 'ERR_RUNTIME_DEFINITION_POLICY');
  }
  safeId(context.trialId, 'policy trial identity');
  if (context.allocationId !== receipt.topology.sandboxId ||
      context.request.trialId !== context.trialId ||
      context.request.bindings.sandboxId !== receipt.topology.sandboxId ||
      context.request.bindings.imageDigest !== receipt.task.imageId ||
      context.request.bindings.budgetPolicyHash !== receipt.bindings.budgetPolicyHash ||
      context.request.bindings.brokerPolicyHash !== receipt.bindings.brokerPolicyHash ||
      context.request.budget.sessionCeilingMicrousd !== receipt.bindings.sessionCeilingMicrousd) {
    fail('runtime policy context drifted from the trusted receipt',
      'ERR_RUNTIME_DEFINITION_POLICY');
  }
  boundedInteger(context.request.sequence, 'policy request sequence', 1, 1_000_000);
  boundedInteger(context.request.budget.trialCeilingMicrousd,
    'policy trial ceiling', 1, receipt.bindings.sessionCeilingMicrousd);
  return context;
}

function codeOwnedPolicyBuilders(receipt) {
  function trialContract(context) {
    validatePolicyContext(context, receipt);
    return createTrialSecurityContract({
      trialId: context.trialId,
      immutableImage: receipt.task.immutableImage,
      cpus: receipt.task.cpus,
      memoryMb: receipt.task.memoryMb,
      pidsLimit: 256,
    });
  }

  function buildDockerPolicy(context) {
    const contract = trialContract(context);
    const readOnlyVariants = archivedConditionReadOnlyBindVariants(
      context.request.bindings.condition
    );
    return deepFreeze({
      ...structuredClone(contract.docker),
      allowedBindSets: readOnlyVariants.map((variant) => [
        ...contract.docker.allowedBinds,
        ...variant.map((mount) => `${mount.source}:${mount.target}:ro`),
      ]),
      allowedArchivePaths: ['/app', '/tests', '/tmp'],
      execUser: null,
    });
  }

  function buildBrokerPolicy(context) {
    const contract = trialContract(context);
    let policy;
    try {
      policy = buildControlledProviderBrokerPolicy({
        profileId: receipt.bindings.profileId,
        sessionCeilingMicrousd: receipt.bindings.sessionCeilingMicrousd,
        trial: {
        leaseId: contract.identity.leaseId,
        leaseDigest: '0'.repeat(64),
        trialId: context.trialId,
        leaseSequence: context.request.sequence + 1,
          trialCeilingMicrousd: context.request.budget.trialCeilingMicrousd,
        },
      });
    } catch {
      fail('code-owned provider policy is invalid', 'ERR_RUNTIME_DEFINITION_POLICY');
    }
    if (controlledProviderBrokerStaticPolicyHash({
      profileId: receipt.bindings.profileId,
      sessionCeilingMicrousd: receipt.bindings.sessionCeilingMicrousd,
    }) !== receipt.bindings.brokerPolicyHash) {
      fail('provider policy identity does not match the signed broker policy binding',
        'ERR_RUNTIME_DEFINITION_POLICY');
    }
    return deepFreeze(policy);
  }
  return { buildDockerPolicy, buildBrokerPolicy };
}

/** Consume and attest the receipt, then attach only imported policy code. */
export async function loadCodeOwnedRuntimeDefinition({ dependencies: dependencyInput = {} } = {}) {
  const dependencies = resolveDependencies(dependencyInput);
  let consumed;
  try { consumed = await dependencies.receiptStore.consume(); } catch (error) {
    throw sanitized(error, 'runtime topology receipt is unavailable',
      'ERR_RUNTIME_DEFINITION_RECEIPT');
  }
  if (!plainObject(consumed) || !Buffer.isBuffer(consumed.bytes)) {
    fail('runtime topology receipt consumption is invalid', 'ERR_RUNTIME_DEFINITION_RECEIPT');
  }
  const bytes = consumed.bytes;
  try {
    validateReceiptAttestation(consumed.attestation, bytes);
    let text;
    try { text = UTF8.decode(bytes); } catch {
      fail('runtime topology receipt is not canonical UTF-8', 'ERR_RUNTIME_DEFINITION_RECEIPT');
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      fail('runtime topology receipt JSON is malformed', 'ERR_RUNTIME_DEFINITION_RECEIPT');
    }
    if (canonicalJson(parsed) !== text) {
      fail('runtime topology receipt JSON is not canonical', 'ERR_RUNTIME_DEFINITION_RECEIPT');
    }
    const buildManifest = await loadAndValidateManifest(dependencies.loadBuildManifest);
    const preload = plainObject(parsed.preload) ? parsed.preload : {};
    const observation = await observeAndValidate(
      dependencies.observeRuntime, buildManifest, preload
    );
    const receipt = validateReceiptDocument(parsed, { buildManifest, observation });
    const builders = codeOwnedPolicyBuilders(receipt);
    return deepFreeze({
      topology: structuredClone(receipt.topology),
      buildDockerPolicy: builders.buildDockerPolicy,
      buildBrokerPolicy: builders.buildBrokerPolicy,
    });
  } finally {
    bytes.fill(0);
  }
}
