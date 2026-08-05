#!/usr/local/bin/node

import crypto from 'node:crypto';
import fs, { constants as FS_CONSTANTS } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  TASK_INPUT_ARCHIVE_LIMITS,
  TRIAL_OUTPUT_ARCHIVE_LIMITS,
} from './archive-limits.mjs';
import {
  TrialArchiveError,
  createTrialOutputArchive,
  extractTrialInputArchive,
  inspectTrialArchive,
} from './trial-archive.mjs';

export const PINNED_HARBOR_EXECUTABLE = '/opt/engineer/bin/harbor';
export const PINNED_NODE_EXECUTABLE = '/usr/local/bin/node';
export const DEFAULT_TRIAL_INPUT_PATH = '/engineer-bounded/transport/task-input.tar';
export const DEFAULT_TRIAL_OUTPUT_PATH = '/engineer-bounded/transport/trial-output.tar';
export const TRIAL_INPUT_ARCHIVE_FD = 3;
export const TRIAL_OUTPUT_ARCHIVE_FD = 4;

const LOGICAL_ROOT = '/engineer-bounded/work';
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const CONTROLLED_PROVIDER = 'controlled-provider';
const ZERO_PROVIDER_CANARY = 'zero-provider-canary';
const EXECUTION_MODE_ENV = 'ENGINEER_RUNTIME_EXECUTION_MODE';
const BROKER_BINDINGS = Object.freeze([
  'ENGINEER_PROVIDER_BROKER_SOCKET',
  'ENGINEER_PROVIDER_LEASE_ID',
  'ENGINEER_PROVIDER_LEASE_DIGEST',
  'ENGINEER_PROVIDER_LEASE_SEQUENCE',
  'ENGINEER_PROVIDER_TRIAL_ID',
]);
const SAFE_SUPPORT_ENV = new Set([
  'DOCKER_HOST', 'ENGINEER_RUNTIME_LEASE_HASH',
  ...BROKER_BINDINGS,
]);
const SECRET_ENV = /(?:OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const SECRET_VALUE = /(?:Bearer\s+|sk-[A-Za-z0-9_-]{8,})/i;
const ZERO_PROVIDER_ENV = /(?:PROVIDER|BROKER|OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const HARBOR_STDIO = Object.freeze(['ignore', 'pipe', 'pipe']);

export class TrialRunnerError extends Error {
  constructor(message, code = 'ERR_TRIAL_RUNNER') {
    super(message);
    this.name = 'TrialRunnerError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new TrialRunnerError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeAbsolute(value, label) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 1_024 || value.includes('\0')
      || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label} must be a normalized absolute path`, 'ERR_TRIAL_RUNNER_PATH');
  }
  return value;
}

function below(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readBoundedRegularFile(file, label) {
  safeAbsolute(file, label);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`${label} is unavailable`, 'ERR_TRIAL_RUNNER_PATH');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1
      || stat.size > TASK_INPUT_ARCHIVE_LIMITS.compressedBytes) {
    fail(`${label} must be a bounded regular non-symlink file`, 'ERR_TRIAL_RUNNER_PATH');
  }
  const descriptor = fs.openSync(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const count = fs.readSync(descriptor, bytes, position, bytes.length - position, position);
      if (count === 0) fail(`${label} changed while being read`, 'ERR_TRIAL_RUNNER_RACE');
      position += count;
    }
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      bytes.fill(0);
      fail(`${label} changed while being attested`, 'ERR_TRIAL_RUNNER_RACE');
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateDescriptorOwner(expectedOwnerUid, expectedOwnerGid) {
  if (!Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0 || expectedOwnerUid > 0xffff_ffff
      || !Number.isSafeInteger(expectedOwnerGid) || expectedOwnerGid < 0 || expectedOwnerGid > 0xffff_ffff) {
    fail('archive descriptor owner binding is invalid', 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }
}

function descriptorStat(descriptor, label) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
    fail(`${label} descriptor is invalid`, 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }
  try {
    return fs.fstatSync(descriptor, { bigint: true });
  } catch {
    fail(`${label} descriptor is unavailable`, 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }
}

function validateProtectedRegularDescriptor(stat, label, expectedOwnerUid, expectedOwnerGid) {
  if (!stat.isFile() || stat.nlink !== 1n
      || stat.uid !== BigInt(expectedOwnerUid) || stat.gid !== BigInt(expectedOwnerGid)
      || (stat.mode & 0o7777n) !== 0o600n) {
    fail(`${label} descriptor must be a protected owner-only regular file`, 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }
}

function sameDescriptorIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}

function sameDescriptorAttestation(left, right) {
  return sameDescriptorIdentity(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readBoundedRegularDescriptor(descriptor, label, expectedOwnerUid, expectedOwnerGid) {
  const before = descriptorStat(descriptor, label);
  validateProtectedRegularDescriptor(before, label, expectedOwnerUid, expectedOwnerGid);
  if (before.size < 1n || before.size > BigInt(TASK_INPUT_ARCHIVE_LIMITS.compressedBytes)) {
    fail(`${label} descriptor must contain one bounded archive`, 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }

  try {
    fs.writeSync(descriptor, Buffer.alloc(0), 0, 0, 0);
    fail(`${label} descriptor must be read-only`, 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  } catch (error) {
    if (error instanceof TrialRunnerError) throw error;
    if (error?.code !== 'EBADF') {
      fail(`${label} descriptor access mode could not be attested`, 'ERR_TRIAL_RUNNER_DESCRIPTOR');
    }
  }

  const bytes = Buffer.alloc(Number(before.size));
  try {
    let position = 0;
    while (position < bytes.length) {
      let count;
      try {
        count = fs.readSync(descriptor, bytes, position, bytes.length - position, position);
      } catch {
        fail(`${label} descriptor could not be read`, 'ERR_TRIAL_RUNNER_DESCRIPTOR');
      }
      if (count === 0) fail(`${label} changed while being read`, 'ERR_TRIAL_RUNNER_RACE');
      position += count;
    }
    const after = descriptorStat(descriptor, label);
    if (!sameDescriptorAttestation(before, after)) {
      fail(`${label} changed while being attested`, 'ERR_TRIAL_RUNNER_RACE');
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

function prepareOutputDescriptor(descriptor, expectedOwnerUid, expectedOwnerGid) {
  const label = 'trial output archive';
  const before = descriptorStat(descriptor, label);
  validateProtectedRegularDescriptor(before, label, expectedOwnerUid, expectedOwnerGid);
  if (before.size !== 0n) {
    fail('trial output archive descriptor must be precreated and empty', 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }
  try {
    fs.ftruncateSync(descriptor, 0);
  } catch {
    fail('trial output archive descriptor must be writable', 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }
  const after = descriptorStat(descriptor, label);
  validateProtectedRegularDescriptor(after, label, expectedOwnerUid, expectedOwnerGid);
  if (!sameDescriptorIdentity(before, after) || after.size !== 0n) {
    fail('trial output archive descriptor changed while being prepared', 'ERR_TRIAL_RUNNER_RACE');
  }
  return after;
}

function writeOwnerOnlyDescriptor(descriptor, bytes, prepared, expectedOwnerUid, expectedOwnerGid) {
  const label = 'trial output archive';
  if (!Buffer.isBuffer(bytes) || bytes.length < 1
      || bytes.length > TRIAL_OUTPUT_ARCHIVE_LIMITS.compressedBytes) {
    fail('trial output archive exceeds its descriptor bound', 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }
  const before = descriptorStat(descriptor, label);
  validateProtectedRegularDescriptor(before, label, expectedOwnerUid, expectedOwnerGid);
  if (!sameDescriptorAttestation(prepared, before) || before.size !== 0n) {
    fail('trial output archive descriptor changed before publication', 'ERR_TRIAL_RUNNER_RACE');
  }
  try {
    fs.ftruncateSync(descriptor, 0);
    let position = 0;
    while (position < bytes.length) {
      const count = fs.writeSync(descriptor, bytes, position, bytes.length - position, position);
      if (count < 1) fail('trial output archive descriptor write was incomplete', 'ERR_TRIAL_RUNNER_DESCRIPTOR');
      position += count;
    }
    fs.ftruncateSync(descriptor, bytes.length);
    fs.fsyncSync(descriptor);
  } catch (error) {
    try {
      fs.ftruncateSync(descriptor, 0);
      fs.fsyncSync(descriptor);
    } catch { /* the original fail-closed write error remains authoritative */ }
    if (error instanceof TrialRunnerError) throw error;
    fail('trial output archive descriptor write failed', 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }
  const after = descriptorStat(descriptor, label);
  validateProtectedRegularDescriptor(after, label, expectedOwnerUid, expectedOwnerGid);
  if (!sameDescriptorIdentity(before, after) || after.size !== BigInt(bytes.length)) {
    fail('trial output archive descriptor changed during publication', 'ERR_TRIAL_RUNNER_RACE');
  }
}

function defaultHashExecutable(file) {
  if (file !== PINNED_NODE_EXECUTABLE) fail('runtime Node executable path drifted', 'ERR_TRIAL_RUNNER_EXECUTABLE');
  let stat;
  let real;
  try {
    stat = fs.lstatSync(file);
    real = fs.realpathSync.native(file);
  } catch {
    fail('pinned runtime Node executable is unavailable', 'ERR_TRIAL_RUNNER_EXECUTABLE');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || real !== file || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0
      || stat.size > 256 * 1024 * 1024) {
    fail('pinned runtime Node executable is not a protected regular file', 'ERR_TRIAL_RUNNER_EXECUTABLE');
  }
  const descriptor = fs.openSync(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (count === 0) fail('runtime Node executable changed while being read', 'ERR_TRIAL_RUNNER_RACE');
      digest.update(chunk.subarray(0, count));
      position += count;
    }
    chunk.fill(0);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('runtime Node executable changed while being attested', 'ERR_TRIAL_RUNNER_RACE');
    }
    return digest.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function defaultRunCommand(file, args, options) {
  return spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    encoding: null,
    shell: false,
    windowsHide: true,
    stdio: options.stdio,
  });
}

function validateRuntimeBindings(inheritedEnv, trial) {
  if (!plainObject(inheritedEnv)) fail('inherited runner environment is invalid', 'ERR_TRIAL_RUNNER_BINDING');
  if (![CONTROLLED_PROVIDER, ZERO_PROVIDER_CANARY].includes(trial.executionMode)) {
    fail('archived execution mode is invalid', 'ERR_TRIAL_RUNNER_BINDING');
  }
  for (const [name, value] of Object.entries(inheritedEnv)) {
    if ((SECRET_ENV.test(name) && !name.startsWith('ENGINEER_PROVIDER_')) || SECRET_VALUE.test(String(value ?? ''))) {
      fail('runner environment contains raw provider or secret material', 'ERR_TRIAL_RUNNER_SECRET');
    }
  }
  if (trial.executionMode === ZERO_PROVIDER_CANARY) {
    if (inheritedEnv[EXECUTION_MODE_ENV] !== ZERO_PROVIDER_CANARY) {
      fail('zero-provider execution mode binding is missing or drifted', 'ERR_TRIAL_RUNNER_BINDING');
    }
    for (const name of Object.keys(inheritedEnv)) {
      if (name !== EXECUTION_MODE_ENV && ZERO_PROVIDER_ENV.test(name)) {
        fail('zero-provider runner environment contains a provider or broker binding', 'ERR_TRIAL_RUNNER_SECRET');
      }
    }
    for (const name of ['DOCKER_HOST', 'ENGINEER_RUNTIME_LEASE_HASH']) {
      if (!Object.hasOwn(inheritedEnv, name)
          || typeof inheritedEnv[name] !== 'string'
          || inheritedEnv[name].includes('\0')) {
        fail(`runtime binding is missing or malformed: ${name}`, 'ERR_TRIAL_RUNNER_BINDING');
      }
    }
    if (!HASH.test(inheritedEnv.ENGINEER_RUNTIME_LEASE_HASH)) {
      fail('runtime lease binding drifted', 'ERR_TRIAL_RUNNER_BINDING');
    }
    validateDockerHost(inheritedEnv.DOCKER_HOST);
    return Object.freeze({
      executionMode: ZERO_PROVIDER_CANARY,
      bindings: Object.freeze({
        DOCKER_HOST: inheritedEnv.DOCKER_HOST,
        ENGINEER_RUNTIME_LEASE_HASH: inheritedEnv.ENGINEER_RUNTIME_LEASE_HASH,
      }),
    });
  }
  if (Object.hasOwn(inheritedEnv, EXECUTION_MODE_ENV)) {
    fail('controlled-provider runner received an unexpected execution mode override', 'ERR_TRIAL_RUNNER_BINDING');
  }
  for (const name of [...BROKER_BINDINGS, 'DOCKER_HOST', 'ENGINEER_RUNTIME_LEASE_HASH']) {
    if (!Object.hasOwn(inheritedEnv, name) || typeof inheritedEnv[name] !== 'string' || inheritedEnv[name].includes('\0')) {
      fail(`broker binding is missing or malformed: ${name}`, 'ERR_TRIAL_RUNNER_BINDING');
    }
  }
  const socket = inheritedEnv.ENGINEER_PROVIDER_BROKER_SOCKET;
  if (!path.posix.isAbsolute(socket) || path.posix.normalize(socket) !== socket
      || !(socket === '/run/engineer/provider.sock' || socket.startsWith('/run/engineer/'))) {
    fail('broker socket binding is invalid', 'ERR_TRIAL_RUNNER_BINDING');
  }
  if (!SAFE_ID.test(inheritedEnv.ENGINEER_PROVIDER_LEASE_ID)
      || !HASH.test(inheritedEnv.ENGINEER_PROVIDER_LEASE_DIGEST)
      || !/^[1-9][0-9]{0,8}$/.test(inheritedEnv.ENGINEER_PROVIDER_LEASE_SEQUENCE)
      || inheritedEnv.ENGINEER_PROVIDER_TRIAL_ID !== trial.trialId
      || !HASH.test(inheritedEnv.ENGINEER_RUNTIME_LEASE_HASH)
      || inheritedEnv.ENGINEER_RUNTIME_LEASE_HASH !== inheritedEnv.ENGINEER_PROVIDER_LEASE_DIGEST) {
    fail('broker lease or trial binding drifted', 'ERR_TRIAL_RUNNER_BINDING');
  }
  validateDockerHost(inheritedEnv.DOCKER_HOST);
  const selected = {};
  for (const name of SAFE_SUPPORT_ENV) selected[name] = inheritedEnv[name];
  return Object.freeze({
    executionMode: CONTROLLED_PROVIDER,
    bindings: Object.freeze(selected),
  });
}

function validateDockerHost(dockerHost) {
  const dockerSocket = dockerHost.startsWith('unix://') ? dockerHost.slice('unix://'.length) : '';
  if (!dockerHost.startsWith('unix:///run/engineer/') || !dockerHost.endsWith('.sock') || dockerHost.includes('\0')
      || !path.posix.isAbsolute(dockerSocket) || path.posix.normalize(dockerSocket) !== dockerSocket) {
    fail('private Docker proxy binding is invalid', 'ERR_TRIAL_RUNNER_BINDING');
  }
}

function physicalPath(value, boundedRoot) {
  if (typeof value !== 'string') return value;
  const workRoot = path.join(boundedRoot, 'work');
  return value.split(LOGICAL_ROOT).join(workRoot);
}

function rewriteRuntimeArgs(document, boundedRoot, nodeHash, runtime) {
  if (!Array.isArray(document.harbor.args) || document.harbor.executable !== PINNED_HARBOR_EXECUTABLE
      || document.harbor.cwd !== LOGICAL_ROOT) {
    fail('archived Harbor launch identity drifted', 'ERR_TRIAL_RUNNER_ARGV');
  }
  const args = document.harbor.args.map((argument) => physicalPath(argument, boundedRoot));
  const nodeDigestPrefix = 'HARNESS_EVAL_HOST_NODE_SHA256=';
  const nodeMatches = args.map((argument, index) => argument.startsWith(nodeDigestPrefix) ? index : -1).filter((index) => index >= 0);
  if (nodeMatches.length !== 1 || args[nodeMatches[0]] !== `${nodeDigestPrefix}${'0'.repeat(64)}`) {
    fail('archived runtime Node digest placeholder drifted', 'ERR_TRIAL_RUNNER_ARGV');
  }
  args[nodeMatches[0]] = `${nodeDigestPrefix}${nodeHash}`;
  if (runtime.executionMode === ZERO_PROVIDER_CANARY
      && args.some((argument) => /(?:ENGINEER_PROVIDER_|OPENROUTER|API[_-]?KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i.test(argument))) {
    fail('archived zero-provider Harbor argv contains provider material', 'ERR_TRIAL_RUNNER_ARGV');
  }
  for (const name of BROKER_BINDINGS) {
    if (args.some((argument) => argument.startsWith(`${name}=`))) {
      fail('archived Harbor argv contains a broker binding before readiness', 'ERR_TRIAL_RUNNER_ARGV');
    }
    if (runtime.executionMode === CONTROLLED_PROVIDER) {
      args.push('--ae', `${name}=${runtime.bindings[name]}`);
    }
  }
  if (args.some((argument) => argument.startsWith('ENGINEER_RUNTIME_LEASE_HASH='))) {
    fail('archived Harbor argv contains a runtime lease binding before readiness', 'ERR_TRIAL_RUNNER_ARGV');
  }
  args.push('--ae', `ENGINEER_RUNTIME_LEASE_HASH=${runtime.bindings.ENGINEER_RUNTIME_LEASE_HASH}`);
  if (args.length > 128 || args.reduce((total, value) => total + Buffer.byteLength(value), 0) > 64 * 1024) {
    fail('rewritten Harbor argv exceeds its bound', 'ERR_TRIAL_RUNNER_ARGV');
  }
  return args;
}

function strictCommandEnv(document, boundedRoot, runtime, nodeHash) {
  if (!plainObject(document.harbor.baseEnv)) fail('archived Harbor base env is invalid', 'ERR_TRIAL_RUNNER_ENV');
  const env = {};
  for (const [name, value] of Object.entries(document.harbor.baseEnv)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || typeof value !== 'string' || value.includes('\0')
        || SECRET_ENV.test(name) || SECRET_VALUE.test(value)) {
      fail('archived Harbor base env contains an unsafe field', 'ERR_TRIAL_RUNNER_ENV');
    }
    env[name] = physicalPath(value, boundedRoot);
  }
  if (env.HARNESS_EVAL_HOST_NODE !== PINNED_NODE_EXECUTABLE
      || env.HARNESS_EVAL_HOST_NODE_SHA256 !== '0'.repeat(64)) {
    fail('archived Harbor Node environment drifted', 'ERR_TRIAL_RUNNER_ENV');
  }
  env.HARNESS_EVAL_HOST_NODE_SHA256 = nodeHash;
  for (const [name, value] of Object.entries(runtime.bindings)) env[name] = value;
  return Object.freeze(env);
}

function runtimeBindingHash(runtime) {
  const fields = runtime.executionMode === CONTROLLED_PROVIDER
    ? [...BROKER_BINDINGS, 'ENGINEER_RUNTIME_LEASE_HASH']
    : ['DOCKER_HOST', 'ENGINEER_RUNTIME_LEASE_HASH'];
  const ordered = {
    ...(runtime.executionMode === ZERO_PROVIDER_CANARY
      ? { executionMode: runtime.executionMode }
      : {}),
    ...Object.fromEntries(fields.map((name) => [name, runtime.bindings[name]])),
  };
  return sha256(JSON.stringify(ordered));
}

function ensureBoundedRoot(root) {
  safeAbsolute(root, 'bounded runtime root');
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    fail('bounded runtime root is unavailable', 'ERR_TRIAL_RUNNER_PATH');
  }
  // The root entry itself cannot be a symlink. An OS-owned parent alias such
  // as macOS /var is acceptable and does not let archive data select a path.
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('bounded runtime root must be a real non-symlink directory', 'ERR_TRIAL_RUNNER_PATH');
  }
  return root;
}

function writeOwnerOnlyAtomic(target, bytes, boundedRoot) {
  safeAbsolute(target, 'trial output archive path');
  if (!below(boundedRoot, target) || path.basename(target) !== 'trial-output.tar') {
    fail('trial output archive escaped its fixed bounded path', 'ERR_TRIAL_RUNNER_PATH');
  }
  const directory = path.dirname(target);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('trial output directory is unsafe', 'ERR_TRIAL_RUNNER_PATH');
  if (fs.existsSync(target)) fail('trial output archive already exists', 'ERR_TRIAL_RUNNER_PATH');
  const temporary = path.join(directory, `.trial-output.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  let linked = false;
  const descriptor = fs.openSync(temporary, FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | (FS_CONSTANTS.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, target);
    linked = true;
  } finally {
    fs.unlinkSync(temporary);
    if (!linked && fs.existsSync(target)) fail('trial output archive publication raced', 'ERR_TRIAL_RUNNER_PATH');
  }
}

function cleanupFreshWorkRoot(workRoot, boundedRoot) {
  if (path.dirname(workRoot) !== boundedRoot || path.basename(workRoot) !== 'work') {
    fail('refusing to clean an unbounded work root', 'ERR_TRIAL_RUNNER_PATH');
  }
  if (fs.existsSync(workRoot)) fs.rmSync(workRoot, { recursive: true, force: true });
}

export async function runArchivedTrial({
  inputArchivePath = null,
  inputBytes = null,
  inputArchiveFd = null,
  expectedInputSha256,
  boundedRoot = '/engineer-bounded',
  outputArchivePath = null,
  outputArchiveFd = null,
  expectedDescriptorOwnerUid = 0,
  expectedDescriptorOwnerGid = 0,
  inheritedEnv = process.env,
  hashExecutable = defaultHashExecutable,
  runCommand = defaultRunCommand,
} = {}) {
  const descriptorMode = inputArchiveFd != null || outputArchiveFd != null;
  if (descriptorMode) {
    if (inputArchiveFd == null
        || outputArchiveFd == null
        || inputArchivePath != null
        || inputBytes != null
        || outputArchivePath != null) {
      fail('inherited archive descriptors must be provided as an unmixed input-output pair', 'ERR_TRIAL_RUNNER_INPUT');
    }
  } else if ([inputArchivePath, inputBytes].filter((source) => source != null).length !== 1) {
    fail('provide exactly one task input archive source', 'ERR_TRIAL_RUNNER_INPUT');
  }
  if (inputArchiveFd != null && inputArchiveFd === outputArchiveFd) {
    fail('task input and trial output descriptors must be distinct', 'ERR_TRIAL_RUNNER_DESCRIPTOR');
  }
  if (!HASH.test(String(expectedInputSha256 ?? ''))) fail('expected task input digest is invalid', 'ERR_TRIAL_RUNNER_INPUT');
  if (typeof hashExecutable !== 'function' || typeof runCommand !== 'function') {
    throw new TypeError('hashExecutable and runCommand must be functions');
  }
  validateDescriptorOwner(expectedDescriptorOwnerUid, expectedDescriptorOwnerGid);
  const root = ensureBoundedRoot(boundedRoot);
  const workRoot = path.join(root, 'work');
  const outputPath = outputArchiveFd == null
    ? outputArchivePath ?? (root === '/engineer-bounded'
      ? DEFAULT_TRIAL_OUTPUT_PATH
      : path.join(root, 'transport', 'trial-output.tar'))
    : null;
  const outputDescriptorAttestation = outputArchiveFd == null
    ? null
    : prepareOutputDescriptor(
      outputArchiveFd,
      expectedDescriptorOwnerUid,
      expectedDescriptorOwnerGid,
    );
  let archive = inputArchiveFd != null
    ? readBoundedRegularDescriptor(
      inputArchiveFd,
      'task input archive',
      expectedDescriptorOwnerUid,
      expectedDescriptorOwnerGid,
    )
    : inputArchivePath == null
      ? Buffer.from(inputBytes)
      : readBoundedRegularFile(inputArchivePath, 'task input archive');
  let inspected;
  let extracted = false;
  try {
    if (archive.length < 1 || archive.length > TASK_INPUT_ARCHIVE_LIMITS.compressedBytes
        || sha256(archive) !== expectedInputSha256) {
      fail('task input archive digest or size drifted', 'ERR_TRIAL_RUNNER_DIGEST');
    }
    inspected = inspectTrialArchive(archive, { kind: 'task-input' });
    const document = inspected.document;
    const runtime = validateRuntimeBindings(inheritedEnv, document.trial);
    const observedNodeHash = await hashExecutable(PINNED_NODE_EXECUTABLE);
    if (!HASH.test(String(observedNodeHash ?? ''))) fail('runtime Node attestation returned an invalid digest', 'ERR_TRIAL_RUNNER_EXECUTABLE');
    const args = rewriteRuntimeArgs(document, root, observedNodeHash, runtime);
    const env = strictCommandEnv(document, root, runtime, observedNodeHash);
    for (const entry of inspected.entries) entry.bytes.fill(0);
    inspected = null;
    extractTrialInputArchive(archive, { destination: workRoot, expectedSha256: expectedInputSha256 });
    extracted = true;

    let commandResult;
    try {
      commandResult = await runCommand(PINNED_HARBOR_EXECUTABLE, args, {
        cwd: workRoot,
        env,
        timeoutMs: document.harbor.timeoutMs,
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        shell: false,
        stdio: HARBOR_STDIO,
      });
    } catch (error) {
      commandResult = {
        status: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: { code: `ERR_${sha256(`${error?.name ?? 'Error'}\0${error?.message ?? ''}`).slice(0, 16).toUpperCase()}` },
      };
    }
    const bindingHash = runtimeBindingHash(runtime);
    const output = createTrialOutputArchive({
      workRoot,
      inputArchiveSha256: expectedInputSha256,
      trialId: document.trial.trialId,
      jobName: document.output.jobName,
      executionMode: runtime.executionMode,
      runtimeBindingHash: bindingHash,
      brokerBindingHash: runtime.executionMode === CONTROLLED_PROVIDER ? bindingHash : null,
      commandResult,
    });
    if (outputArchiveFd == null) {
      writeOwnerOnlyAtomic(outputPath, output.bytes, root);
    } else {
      writeOwnerOnlyDescriptor(
        outputArchiveFd,
        output.bytes,
        outputDescriptorAttestation,
        expectedDescriptorOwnerUid,
        expectedDescriptorOwnerGid,
      );
    }
    return output;
  } catch (error) {
    if (error instanceof TrialRunnerError || error instanceof TrialArchiveError) throw error;
    fail('archived trial failed closed', 'ERR_TRIAL_RUNNER_REMOTE');
  } finally {
    if (inspected) for (const entry of inspected.entries) entry.bytes.fill(0);
    archive.fill(0);
    if (extracted || fs.existsSync(workRoot)) cleanupFreshWorkRoot(workRoot, root);
  }
}

/**
 * Minimal snapshot entrypoint. The control-plane-selected input digest is the
 * only CLI datum; inherited archive descriptors and executable identities stay
 * code-owned.
 * It intentionally emits no process output because remote command receipts are
 * hash-only and the supervisor owns diagnostics.
 */
export async function runArchivedTrialCli({
  argv = process.argv.slice(2),
  env = process.env,
  runTrial = runArchivedTrial,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--input-sha256' || !HASH.test(String(argv[1] ?? ''))) {
    return 64;
  }
  try {
    const result = await runTrial({
      inputArchiveFd: TRIAL_INPUT_ARCHIVE_FD,
      expectedInputSha256: argv[1],
      boundedRoot: '/engineer-bounded',
      outputArchiveFd: TRIAL_OUTPUT_ARCHIVE_FD,
      expectedDescriptorOwnerUid: 0,
      expectedDescriptorOwnerGid: 0,
      inheritedEnv: env,
    });
    const code = Number.isInteger(result.run.code)
      ? result.run.code
      : result.run.timedOut ? 124 : 70;
    result.bytes.fill(0);
    return code;
  } catch {
    return 70;
  }
}

const invokedPath = process.argv[1];
if (typeof invokedPath === 'string' && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url) {
  process.exitCode = await runArchivedTrialCli();
}
