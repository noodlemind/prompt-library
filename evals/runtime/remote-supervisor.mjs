#!/usr/local/bin/node

import crypto from 'node:crypto';
import fs, { constants as FS_CONSTANTS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { createLinuxRuntimeEffects } from './linux-effects.mjs';
import {
  runRemoteBridgeCli,
  verifyAuthenticatedControlChannel,
} from './remote-bridge.mjs';
import { loadCodeOwnedRuntimeDefinition } from './runtime-definition.mjs';
import { createSupervisorHandlerFactory } from './supervisor-handler.mjs';

const CONTROL_ROUTE = '--control-stdio';
const EXECUTABLE_NAME = 'engineer-runtime-supervisor';
const DEFAULT_TRANSPORT_DIRECTORY = '/engineer-bounded/transport';
const TASK_ARCHIVE_PATH = `${DEFAULT_TRANSPORT_DIRECTORY}/task-input.tar`;
const OUTPUT_ARCHIVE_PATH = `${DEFAULT_TRANSPORT_DIRECTORY}/trial-output.tar`;
const PROVIDER_PIPE_PATH = `${DEFAULT_TRANSPORT_DIRECTORY}/provider-key.pipe`;
const PINNED_RUNNER = '/opt/engineer/bin/engineer-eval-runner';
const PINNED_MKFIFO = '/usr/bin/mkfifo';
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const RAW_CREDENTIAL_ENV = /(?:^DAYTONA(?:_|$)|OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|GROQ|XAI|MISTRAL|COHERE|TOGETHER|FIREWORKS|DEEPSEEK|CEREBRAS|PERPLEXITY|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const SUPPORT_ENV = Object.freeze({ LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' });
const ARCHIVE_KINDS = new Set(['task-input', 'trial-output']);

export class RemoteSupervisorEntrypointError extends Error {
  constructor(message, code = 'ERR_REMOTE_SUPERVISOR') {
    super(message);
    this.name = 'RemoteSupervisorEntrypointError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new RemoteSupervisorEntrypointError(message, code);
}

function sanitized(error, message, code) {
  if (error instanceof RemoteSupervisorEntrypointError) return error;
  return new RemoteSupervisorEntrypointError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail(`${label} is invalid`, 'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail(`${label} is invalid`, 'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is outside its bound`, 'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  return value;
}

function absolute(value, label) {
  if (typeof value !== 'string'
      || value.length < 2
      || value.length > 1_024
      || value.includes('\0')
      || !path.posix.isAbsolute(value)
      || path.posix.normalize(value) !== value) {
    fail(`${label} is invalid`, 'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  return value;
}

function sameDigest(left, right) {
  if (!HASH.test(String(left)) || !HASH.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function assertCredentialFreeEnvironment(environment) {
  if (!environment || typeof environment !== 'object') {
    fail('runtime environment is invalid', 'ERR_REMOTE_SUPERVISOR_ENVIRONMENT');
  }
  let names;
  try {
    names = Object.keys(environment);
  } catch {
    fail('runtime environment is invalid', 'ERR_REMOTE_SUPERVISOR_ENVIRONMENT');
  }
  if (names.some((name) => RAW_CREDENTIAL_ENV.test(name))) {
    fail('ambient cloud or provider credentials are forbidden', 'ERR_REMOTE_SUPERVISOR_ENVIRONMENT');
  }
}

function assertArchivePath(file) {
  absolute(file, 'archive path');
  const filename = path.posix.basename(file);
  if (!['task-input.tar', 'trial-output.tar'].includes(filename)) {
    fail('archive path is not a fixed runtime artifact', 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH');
  }
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

/**
 * Attest a fixed owner-only archive through one no-follow descriptor. Input
 * archives additionally bind the controller-declared size and digest.
 */
export async function inspectBoundArchive({
  file,
  kind,
  expectedByteLength,
  expectedSha256,
  expectedOwnerUid = typeof process.getuid === 'function' ? process.getuid() : 0,
} = {}) {
  assertArchivePath(file);
  if (!ARCHIVE_KINDS.has(kind)) {
    fail('archive kind is invalid', 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH');
  }
  if (expectedByteLength !== undefined) {
    boundedInteger(expectedByteLength, 'archive byte length', 1, MAX_ARCHIVE_BYTES);
  }
  if (expectedSha256 !== undefined && !HASH.test(String(expectedSha256))) {
    fail('archive digest is invalid', 'ERR_REMOTE_SUPERVISOR_ARCHIVE_DIGEST');
  }
  boundedInteger(expectedOwnerUid, 'archive owner', 0, 65_535);

  let handle;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    const parent = path.posix.dirname(file);
    const [parentReal, parentStat, fileReal, before] = await Promise.all([
      fsp.realpath(parent),
      fsp.lstat(parent, { bigint: true }),
      fsp.realpath(file),
      fsp.lstat(file, { bigint: true }),
    ]);
    if (parentReal !== parent
        || fileReal !== file
        || !parentStat.isDirectory()
        || parentStat.isSymbolicLink()
        || Number(parentStat.uid) !== expectedOwnerUid
        || (Number(parentStat.mode) & 0o022) !== 0
        || before.isSymbolicLink()
        || !before.isFile()
        || Number(before.uid) !== expectedOwnerUid
        || (Number(before.mode) & 0o077) !== 0
        || before.size < 1n
        || before.size > BigInt(MAX_ARCHIVE_BYTES)) {
      fail('archive custody or path identity drifted', 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH');
    }
    const flags = FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0);
    handle = await fsp.open(file, flags);
    const opened = await handle.stat({ bigint: true });
    if (!sameStat(before, opened) || !opened.isFile()) {
      fail('archive changed before descriptor binding', 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH');
    }
    const byteLength = Number(opened.size);
    if (expectedByteLength !== undefined && byteLength !== expectedByteLength) {
      fail('archive size drifted', 'ERR_REMOTE_SUPERVISOR_ARCHIVE_DIGEST');
    }
    const hash = crypto.createHash('sha256');
    let offset = 0;
    while (offset < byteLength) {
      const length = Math.min(chunk.length, byteLength - offset);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead < 1) {
        fail('archive ended during attestation', 'ERR_REMOTE_SUPERVISOR_ARCHIVE_DIGEST');
      }
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStat(opened, after)) {
      fail('archive changed during attestation', 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH');
    }
    const sha256 = hash.digest('hex');
    if (expectedSha256 !== undefined && !sameDigest(sha256, expectedSha256)) {
      fail('archive digest drifted', 'ERR_REMOTE_SUPERVISOR_ARCHIVE_DIGEST');
    }
    return Object.freeze({ kind, byteLength, sha256 });
  } catch (error) {
    throw sanitized(
      error,
      'archive attestation failed',
      error?.code === 'ENOENT'
        ? 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH'
        : 'ERR_REMOTE_SUPERVISOR_ARCHIVE_IO'
    );
  } finally {
    chunk.fill(0);
    try { await handle?.close(); } catch { /* the operation remains fail-closed */ }
  }
}

function inspectProtectedExecutable(file) {
  const stat = fs.lstatSync(file);
  const real = fs.realpathSync.native(file);
  if (real !== file
      || stat.isSymbolicLink()
      || !stat.isFile()
      || stat.uid !== 0
      || (stat.mode & 0o022) !== 0
      || (stat.mode & 0o111) === 0) {
    throw new Error('untrusted executable');
  }
}

function waitChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('trusted helper timed out'));
    }, timeoutMs);
    timer.unref?.();
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.once('error', () => finish(() => reject(new Error('trusted helper failed'))));
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) finish(resolve);
      else finish(() => reject(new Error('trusted helper failed')));
    });
  });
}

function rawOpen(file, flags, mode) {
  return new Promise((resolve, reject) => {
    fs.open(file, flags, mode, (error, fd) => error ? reject(error) : resolve(fd));
  });
}

function rawWrite(fd, bytes, offset) {
  return new Promise((resolve, reject) => {
    fs.write(fd, bytes, offset, bytes.length - offset, null, (error, written) =>
      error ? reject(error) : resolve(written));
  });
}

function rawStat(fd) {
  return new Promise((resolve, reject) => {
    fs.fstat(fd, (error, stat) => error ? reject(error) : resolve(stat));
  });
}

function rawClose(fd) {
  return new Promise((resolve, reject) => {
    fs.close(fd, (error) => error ? reject(error) : resolve());
  });
}

function createNodeFifoDriver() {
  return Object.freeze({
    async inspectParent({ path: parent }) {
      const [real, stat] = await Promise.all([fsp.realpath(parent), fsp.lstat(parent)]);
      return {
        real: real === parent,
        directory: stat.isDirectory() && !stat.isSymbolicLink(),
        ownerUid: stat.uid,
        mode: stat.mode & 0o777,
      };
    },
    async ensureAbsent({ path: target }) {
      try {
        await fsp.lstat(target);
        return false;
      } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
      }
    },
    async createFifo(spec) {
      inspectProtectedExecutable(spec.file);
      if (spec.shell !== false) throw new Error('shell execution is forbidden');
      const child = spawn(spec.file, spec.args, {
        cwd: '/',
        env: { ...spec.env },
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      await waitChild(child, spec.timeoutMs);
      return true;
    },
    async inspectFifo({ path: target }) {
      const [real, stat] = await Promise.all([fsp.realpath(target), fsp.lstat(target)]);
      return {
        fifo: real === target && stat.isFIFO() && !stat.isSymbolicLink(),
        ownerUid: stat.uid,
        mode: stat.mode & 0o777,
      };
    },
    async openFifo({ path: target }) {
      const flags = FS_CONSTANTS.O_NONBLOCK | (FS_CONSTANTS.O_NOFOLLOW ?? 0);
      const readFd = await rawOpen(target, FS_CONSTANTS.O_RDONLY | flags, 0o600);
      try {
        const writeFd = await rawOpen(target, FS_CONSTANTS.O_WRONLY | flags, 0o600);
        return { readFd, writeFd };
      } catch (error) {
        await rawClose(readFd);
        throw error;
      }
    },
    async inspectDescriptor(fd) {
      const stat = await rawStat(fd);
      return { fifo: stat.isFIFO(), ownerUid: stat.uid, mode: stat.mode & 0o777 };
    },
    async writeAll(fd, bytes) {
      let offset = 0;
      while (offset < bytes.length) {
        const written = await rawWrite(fd, bytes, offset);
        if (written < 1) throw new Error('pipe write made no progress');
        offset += written;
      }
    },
    async unlink({ path: target }) {
      try { await fsp.unlink(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    },
    async close(fd) { await rawClose(fd); },
  });
}

function validateFifoDriver(driver) {
  const methods = [
    'inspectParent', 'ensureAbsent', 'createFifo', 'inspectFifo', 'openFifo',
    'inspectDescriptor', 'writeAll', 'unlink', 'close',
  ];
  if (!plainObject(driver) || methods.some((method) => typeof driver[method] !== 'function')) {
    throw new TypeError('provider descriptor driver is incomplete');
  }
  return driver;
}

/**
 * Convert secret bytes to a one-shot FIFO descriptor. The FIFO name is
 * removed before the descriptor is returned, so only the inherited pipe can
 * carry the credential after handoff.
 */
export function createProviderKeyDescriptorCustody({
  pipePath = PROVIDER_PIPE_PATH,
  platform = process.platform,
  expectedOwnerUid = typeof process.getuid === 'function' ? process.getuid() : 0,
  driver: suppliedDriver,
} = {}) {
  if (platform !== 'linux') {
    fail('provider descriptor custody requires Linux', 'ERR_REMOTE_SUPERVISOR_PLATFORM');
  }
  if (pipePath !== PROVIDER_PIPE_PATH) {
    fail('provider descriptor path drifted', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
  }
  boundedInteger(expectedOwnerUid, 'provider descriptor owner', 0, 65_535);
  const driver = validateFifoDriver(suppliedDriver ?? createNodeFifoDriver());
  let activeFd = null;
  let linked = false;

  async function unlinkBestEffort() {
    if (!linked) return;
    linked = false;
    try { await driver.unlink({ path: pipePath }); } catch { /* fail-stop continues */ }
  }

  async function closeBestEffort(fd) {
    try { await driver.close(fd); } catch { /* fail-stop continues */ }
  }

  async function open(providerKey) {
    if ((!Buffer.isBuffer(providerKey) && !(providerKey instanceof Uint8Array))
        || providerKey.byteLength < 8
        || providerKey.byteLength > 512
        || activeFd !== null) {
      fail('provider credential handoff is invalid', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
    }
    const keyBytes = Buffer.from(providerKey);
    let fd = null;
    let writeFd = null;
    try {
      const parent = await driver.inspectParent({ path: path.posix.dirname(pipePath) });
      if (parent?.real !== true
          || parent.directory !== true
          || parent.ownerUid !== expectedOwnerUid
          || (parent.mode & 0o022) !== 0) {
        fail('provider descriptor parent custody drifted', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
      }
      if (await driver.ensureAbsent({ path: pipePath }) !== true) {
        fail('provider descriptor path already exists', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
      }
      const createSpec = {
        file: PINNED_MKFIFO,
        args: ['--mode=600', '--', pipePath],
        cwd: '/',
        env: SUPPORT_ENV,
        shell: false,
        timeoutMs: 5_000,
      };
      if (await driver.createFifo(createSpec) !== true) {
        fail('provider descriptor creation failed', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
      }
      linked = true;
      const fifo = await driver.inspectFifo({ path: pipePath });
      if (fifo?.fifo !== true || fifo.ownerUid !== expectedOwnerUid || fifo.mode !== 0o600) {
        fail('provider descriptor inode custody drifted', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
      }
      const opened = await driver.openFifo({ path: pipePath, mode: 0o600 });
      if (!plainObject(opened)) {
        fail('provider descriptor pair is invalid', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
      }
      fd = opened.readFd;
      writeFd = opened.writeFd;
      boundedInteger(fd, 'provider descriptor', 3, 1_048_575);
      boundedInteger(writeFd, 'provider writer descriptor', 3, 1_048_575);
      if (fd === writeFd) {
        fail('provider descriptor pair must be directional', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
      }
      const descriptor = await driver.inspectDescriptor(fd);
      if (descriptor?.fifo !== true
          || descriptor.ownerUid !== expectedOwnerUid
          || descriptor.mode !== 0o600) {
        fail('provider descriptor identity drifted', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
      }
      await driver.writeAll(writeFd, keyBytes);
      await driver.close(writeFd);
      writeFd = null;
      await driver.unlink({ path: pipePath });
      linked = false;
      activeFd = fd;
      return fd;
    } catch (error) {
      if (Number.isSafeInteger(writeFd)) await closeBestEffort(writeFd);
      if (Number.isSafeInteger(fd)) await closeBestEffort(fd);
      await unlinkBestEffort();
      throw sanitized(
        error,
        'provider credential handoff failed',
        'ERR_REMOTE_SUPERVISOR_CREDENTIAL'
      );
    } finally {
      keyBytes.fill(0);
    }
  }

  async function close(fd) {
    if (fd !== activeFd) {
      fail('provider descriptor is not active', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
    }
    let failure;
    try {
      await driver.close(fd);
    } catch (error) {
      failure = sanitized(error, 'provider descriptor cleanup failed', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
      await closeBestEffort(fd);
    } finally {
      activeFd = null;
      await unlinkBestEffort();
    }
    if (failure) throw failure;
  }

  async function releaseAfterExternalClose(fd) {
    if (fd !== activeFd) {
      fail('provider descriptor is not active', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
    }
    activeFd = null;
    await unlinkBestEffort();
  }

  async function dispose() {
    const fd = activeFd;
    activeFd = null;
    if (Number.isSafeInteger(fd)) await closeBestEffort(fd);
    await unlinkBestEffort();
  }

  return Object.freeze({ open, close, releaseAfterExternalClose, dispose });
}

function validateCompositionTopology(topology) {
  if (!plainObject(topology)
      || !plainObject(topology.paths)
      || !plainObject(topology.executables)
      || !plainObject(topology.hashes)
      || !plainObject(topology.identities)
      || !plainObject(topology.cgroup)) {
    fail('code-owned runtime topology is missing', 'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  for (const field of [
    'controlChannelAuthenticated',
    'controlChannelKind',
    'controlChannelReceipt',
    'controlChannelStream',
  ]) {
    if (Object.prototype.hasOwnProperty.call(topology, field)) {
      fail('serialized topology cannot pre-attest the live control channel',
        'ERR_REMOTE_SUPERVISOR_DEFINITION');
    }
  }
  safeId(topology.sandboxId, 'sandbox identity');
  safeId(topology.sandboxBootId, 'sandbox boot identity');
  safeId(topology.daemonId, 'daemon identity');
  if (topology.executables.runner !== PINNED_RUNNER) {
    fail('runner executable drifted', 'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  absolute(topology.paths.workspace, 'runner workspace');
  digest(topology.hashes.supervisor, 'supervisor digest');
  digest(topology.hashes.runner, 'runner digest');
  digest(topology.hashes.harbor, 'Harbor digest');
  digest(topology.hashes.daemonRoot, 'daemon-root digest');
  safeId(topology.cgroup.id, 'cgroup identity');
  digest(topology.cgroup.pathHash, 'cgroup path digest');
  if (typeof topology.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(topology.imageDigest)) {
    fail('task image identity drifted', 'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  return topology;
}

function archivePaths(transportDirectory) {
  absolute(transportDirectory, 'transport directory');
  return Object.freeze({
    task: path.posix.join(transportDirectory, path.posix.basename(TASK_ARCHIVE_PATH)),
    output: path.posix.join(transportDirectory, path.posix.basename(OUTPUT_ARCHIVE_PATH)),
  });
}

function validateTrialAgainstTopology(trial, topology, allocationId) {
  if (!plainObject(trial)
      || allocationId !== topology.sandboxId
      || trial.imageDigest !== topology.imageDigest
      || trial.supervisorExecutableHash !== topology.hashes.supervisor
      || trial.runnerExecutableHash !== topology.hashes.runner
      || trial.harborExecutableHash !== topology.hashes.harbor) {
    fail('trial binding drifted from the code-owned topology', 'ERR_REMOTE_SUPERVISOR_BINDING');
  }
}

function runtimeBindings(topology) {
  return Object.freeze({
    sandboxBootId: topology.sandboxBootId,
    daemonId: topology.daemonId,
    daemonRootHash: topology.hashes.daemonRoot,
    cgroupId: topology.cgroup.id,
    cgroupPathHash: topology.cgroup.pathHash,
  });
}

/**
 * Compose the production supervisor from code-owned topology and policy
 * callbacks. Nothing in this definition can be supplied through argv or env.
 */
export function createRemoteSupervisorEntrypoint({
  topology: rawTopology,
  buildDockerPolicy,
  buildBrokerPolicy,
  runnerTimeoutMs = 4 * 60 * 60 * 1_000,
  keyId = 'runtime-supervisor-hmac-1',
  expectedControllerKeyId = 'runtime-controller-hmac-1',
  dependencies = {},
} = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'linux') {
    fail('remote supervisor requires Linux', 'ERR_REMOTE_SUPERVISOR_PLATFORM');
  }
  assertCredentialFreeEnvironment(dependencies.environment ?? process.env);
  if (typeof buildDockerPolicy !== 'function' || typeof buildBrokerPolicy !== 'function') {
    fail('code-owned runtime policies are missing', 'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  const topology = validateCompositionTopology(rawTopology);
  boundedInteger(runnerTimeoutMs, 'runner timeout', 1_000, 4 * 60 * 60 * 1_000);
  const paths = archivePaths(dependencies.transportDirectory ?? DEFAULT_TRANSPORT_DIRECTORY);
  const createEffects = dependencies.createEffects ?? createLinuxRuntimeEffects;
  const createHandlerFactory = dependencies.createHandlerFactory ?? createSupervisorHandlerFactory;
  const bridgeCli = dependencies.bridgeCli ?? runRemoteBridgeCli;
  const archiveInspector = dependencies.archiveInspector ?? inspectBoundArchive;
  const createCustody = dependencies.createCustody ?? createProviderKeyDescriptorCustody;
  for (const [label, candidate] of Object.entries({
    createEffects,
    createHandlerFactory,
    bridgeCli,
    archiveInspector,
    createCustody,
  })) {
    if (typeof candidate !== 'function') throw new TypeError(`${label} must be a function`);
  }

  let rawEffects;
  let custody;
  try {
    rawEffects = createEffects({
      topology,
      ...(dependencies.driver === undefined ? {} : { driver: dependencies.driver }),
      ...(dependencies.dockerProxyFactory === undefined
        ? {}
        : { dockerProxyFactory: dependencies.dockerProxyFactory }),
    });
    if (!rawEffects || typeof rawEffects.closeInheritedFd !== 'function' ||
        typeof rawEffects.bindControlChannel !== 'function') {
      fail('runtime effects are incomplete', 'ERR_REMOTE_SUPERVISOR_COMPOSITION');
    }
    custody = createCustody({
      pipePath: PROVIDER_PIPE_PATH,
      platform,
      expectedOwnerUid: topology.identities.supervisorUid ?? 0,
      ...(dependencies.fifoDriver === undefined ? {} : { driver: dependencies.fifoDriver }),
    });
    if (!custody || ['open', 'close', 'releaseAfterExternalClose', 'dispose']
      .some((method) => typeof custody[method] !== 'function')) {
      fail('provider descriptor custody is incomplete', 'ERR_REMOTE_SUPERVISOR_COMPOSITION');
    }
  } catch (error) {
    throw sanitized(error, 'remote supervisor composition failed', 'ERR_REMOTE_SUPERVISOR_COMPOSITION');
  }

  const effects = {
    ...rawEffects,
    async closeInheritedFd(fd) {
      try {
        const result = await rawEffects.closeInheritedFd(fd);
        await custody.releaseAfterExternalClose(fd);
        return result;
      } catch (error) {
        try { await custody.close(fd); } catch { /* supervisor fail-stop continues */ }
        throw sanitized(error, 'provider descriptor closure failed', 'ERR_REMOTE_SUPERVISOR_CREDENTIAL');
      }
    },
  };

  async function inspectBinding({ allocationId, trial, taskArchive } = {}) {
    validateTrialAgainstTopology(trial, topology, allocationId);
    if (!plainObject(taskArchive) || taskArchive.kind !== 'task-input') {
      fail('task archive binding is invalid', 'ERR_REMOTE_SUPERVISOR_BINDING');
    }
    const archive = await archiveInspector({
      file: paths.task,
      kind: 'task-input',
      expectedByteLength: taskArchive.byteLength,
      expectedSha256: taskArchive.sha256,
    });
    return Object.freeze({
      allocationId: topology.sandboxId,
      taskArchive: archive,
      runtimeBindings: runtimeBindings(topology),
    });
  }

  async function inspectTrialOutput({ allocationId } = {}) {
    if (allocationId !== topology.sandboxId) {
      fail('output archive allocation drifted', 'ERR_REMOTE_SUPERVISOR_BINDING');
    }
    return archiveInspector({ file: paths.output, kind: 'trial-output' });
  }

  function runner(context) {
    if (!plainObject(context?.taskArchive)) {
      fail('runner input archive is unbound', 'ERR_REMOTE_SUPERVISOR_BINDING');
    }
    const inputSha256 = digest(context.taskArchive.sha256, 'runner input digest');
    return Object.freeze({
      argv: Object.freeze([PINNED_RUNNER, '--input-sha256', inputSha256]),
      cwd: topology.paths.workspace,
      env: Object.freeze({ LANG: 'C.UTF-8' }),
      timeoutMs: runnerTimeoutMs,
    });
  }

  let handlerFactory;
  try {
    handlerFactory = createHandlerFactory({
      effects,
      dockerPolicy: (context) => buildDockerPolicy(context),
      brokerPolicy: (context) => buildBrokerPolicy(context),
      runner,
      keyId,
      expectedControllerKeyId,
      openProviderKeyFd: (providerKey) => custody.open(providerKey),
      closeProviderKeyFd: (fd) => custody.close(fd),
      inspectBinding,
      inspectTrialOutput,
      ...(dependencies.supervisorFactory === undefined
        ? {}
        : { supervisorFactory: dependencies.supervisorFactory }),
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      ...(dependencies.nonceFactory === undefined
        ? {}
        : { nonceFactory: dependencies.nonceFactory }),
      ...(dependencies.limits === undefined ? {} : { limits: dependencies.limits }),
    });
    if (typeof handlerFactory !== 'function') {
      fail('supervisor handler composition failed', 'ERR_REMOTE_SUPERVISOR_COMPOSITION');
    }
  } catch (error) {
    void custody.dispose();
    throw sanitized(error, 'remote supervisor composition failed', 'ERR_REMOTE_SUPERVISOR_COMPOSITION');
  }

  let lifecycle = 'ready';
  const authenticatedHandlerFactory = async ({ hmacKey, providerKey, controlChannel } = {}) => {
    let verified;
    try {
      verified = verifyAuthenticatedControlChannel(controlChannel, hmacKey);
      await rawEffects.bindControlChannel(verified);
    } catch {
      fail('live control channel authentication failed', 'ERR_REMOTE_SUPERVISOR_CONTROL_CHANNEL');
    }
    return handlerFactory({ hmacKey, providerKey });
  };
  async function run({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout } = {}) {
    if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== CONTROL_ROUTE) {
      fail('remote supervisor invocation drifted', 'ERR_REMOTE_SUPERVISOR_INVOCATION');
    }
    if (lifecycle !== 'ready') {
      fail('remote supervisor process is one-shot', 'ERR_REMOTE_SUPERVISOR_INVOCATION');
    }
    lifecycle = 'running';
    let result;
    let failure;
    try {
      result = await bridgeCli({
        executableName: EXECUTABLE_NAME,
        argv: [CONTROL_ROUTE],
        input,
        output,
        handlerFactory: authenticatedHandlerFactory,
      });
    } catch (error) {
      failure = sanitized(error, 'remote supervisor control failed', 'ERR_REMOTE_SUPERVISOR_CONTROL');
    }
    try {
      await custody.dispose();
    } catch (error) {
      failure ??= sanitized(error, 'remote supervisor cleanup failed', 'ERR_REMOTE_SUPERVISOR_CLEANUP');
    }
    lifecycle = 'complete';
    if (failure) throw failure;
    return result;
  }

  return Object.freeze({ run });
}

export async function runRemoteSupervisorCli({
  definition,
  definitionLoader = loadCodeOwnedRuntimeDefinition,
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  dependencies,
} = {}) {
  if (typeof definitionLoader !== 'function') {
    fail('code-owned runtime definition loader is unavailable',
      'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  let resolvedDefinition = definition;
  if (resolvedDefinition === undefined) {
    try {
      resolvedDefinition = await definitionLoader();
    } catch {
      fail('code-owned runtime definition is unavailable', 'ERR_REMOTE_SUPERVISOR_DEFINITION');
    }
  }
  if (!plainObject(resolvedDefinition)) {
    fail('code-owned runtime definition is unavailable', 'ERR_REMOTE_SUPERVISOR_DEFINITION');
  }
  const entrypoint = createRemoteSupervisorEntrypoint({
    ...resolvedDefinition,
    ...(dependencies === undefined ? {} : { dependencies }),
  });
  return entrypoint.run({ argv, input, output });
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  runRemoteSupervisorCli().catch((error) => {
    const code = error instanceof RemoteSupervisorEntrypointError
      ? error.code
      : 'ERR_REMOTE_SUPERVISOR';
    process.stderr.write(`engineer remote supervisor failed: ${code}\n`);
    process.exitCode = 70;
  });
}
