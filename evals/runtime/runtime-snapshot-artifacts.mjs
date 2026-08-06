import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { daytonaCliEnvironment } from './daytona-controller.mjs';
import { createDaytonaSnapshotController } from './daytona-snapshot-controller.mjs';
import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
  DAYTONA_EXECUTABLE_PATHS,
  DAYTONA_NODE_RUNTIME_IMAGE,
  DAYTONA_NODE_RUNTIME_IMAGE_DIGEST,
  DAYTONA_NODE_USTAR_ATTESTATION,
  DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256,
} from './daytona-topology.mjs';
import { buildDeterministicUstar } from './deterministic-ustar.mjs';
import { buildSnapshotBuildManifest } from './snapshot-build-manifest.mjs';

const INPUT_FIELDS = Object.freeze([
  'workspace', 'repoRoot', 'daytonaPath', 'bundle', 'bindings', 'taskImages',
]);
const CLOSURE_FIELDS = Object.freeze([
  'dockerfilePath', 'definitionPath', 'roots', 'executables', 'provenance',
]);
const CONTEXT_KINDS = Object.freeze(['runtime', 'harbor', 'node', 'native']);
const HASH = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^[a-f0-9]{40,64}$/;
const MAX_DEFINITION_BYTES = 4 * 1024 * 1024;
const MAX_DOCKERFILE_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_DOWNLOAD_ELAPSED_MS = 5 * 60_000;
const DOWNLOAD_CLEANUP_TIMEOUT_MS = 10_000;
const BUILDER_CLEANUP_DEADLINE_MS = 60_000;
const BUILDER_CLEANUP_COMMAND_TIMEOUT_MS = 10_000;
const BUILDER_CLEANUP_ATTEMPTS = 8;
const BUILDER_CLEANUP_ABSENCE_CONFIRMATIONS = 3;
const BUILDER_CLEANUP_BACKOFF_BASE_MS = 100;
const BUILDER_CLEANUP_BACKOFF_MAX_MS = 5_000;
const DOCKER_HOST = 'unix:///var/run/docker.sock';
const PINNED_SOURCE_HELPER = fileURLToPath(new URL('./pinned-snapshot-source.mjs', import.meta.url));
const PINNED_SOURCE_SUCCESS = 'ENGINEER-PINNED-SOURCE/1';
const PINNED_SOURCE_ABSENT = 'ENGINEER-PINNED-SOURCE-ABSENT/1\n';
const PINNED_SOURCE_ATTEMPT_PREFIX = '.engineer-pinned-source-';
const PINNED_SOURCE_ATTEMPT_TOKEN = /^[a-f0-9]{32}$/;
const PINNED_SOURCE_PARTIAL_NAME = 'source.partial';
const BUILDER_OWNER_LABEL = 'io.noodlemind.engineer.eval.builder';
const BUILDER_ID_LABEL = 'io.noodlemind.engineer.eval.builder-id';
const BUILDER_OWNER = 'runtime-snapshot-artifacts.v1';

const HARBOR_SOURCE = Object.freeze({
  version: 'v0.20.0',
  commit: '459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc',
  url: 'https://codeload.github.com/laude-institute/harbor/tar.gz/459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc',
  sha256: '271bf10888e9d3e8d0ff2cd1fcda79624e150fe426342c231df54b83de0671a1',
  lockSha256: '3a2a76d7d000544dfebc91f566187750eee5a452e27899b27e4905cfa6691388',
});
const PYTHON_BUILDER_IMAGE =
  'python:3.13.5-alpine3.22@sha256:f1a962d8ffa50b2006b72b4713a09a89e57def2d28ac28a36900bc070a00db61';
const UV_BUILDER_IMAGE =
  'ghcr.io/astral-sh/uv:0.9.5@sha256:0f419824ea1810fe2a47af12aef8e8c39eabae8d19c728cd9612d18e17a98d17';
const NATIVE_COMPILER_IMAGE =
  'gcc:14.2.0-bookworm@sha256:82549aa8f90ada3236a8be70c74543132a76662ef33f0c3271ed802b81584a82';
const NATIVE_COMPILER_DIGEST =
  'sha256:82549aa8f90ada3236a8be70c74543132a76662ef33f0c3271ed802b81584a82';
const NODE_RUNTIME_FILES = Object.freeze(DAYTONA_NODE_USTAR_ATTESTATION.entries.map((entry) =>
  Object.freeze({
    source: `/${entry.path}`,
    path: entry.path,
    mode: entry.mode,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
  })));

const DOCKER_CANDIDATES = Object.freeze({
  'darwin-arm64': Object.freeze([
    Object.freeze({
      path: '/opt/homebrew/bin/docker',
      sha256: 'eade1c3a5dda47534dc776f2f534c99cc94cfcf9ce07c4bf09e98258d13e7d7a',
    }),
    Object.freeze({
      path: '/usr/local/bin/docker',
      sha256: '4cac4d8522a8a7ce29e4dfec74e9a5fa822f54ef6dd96557c2973316fcbd2566',
    }),
  ]),
});

const BASE_EXECUTABLE_SOURCES = Object.freeze({
  dockerd: '/usr/local/bin/dockerd',
  docker: '/usr/local/bin/docker',
  storageAllocator: '/bin/busybox',
  iptables: '/usr/sbin/iptables',
  ip6tables: '/usr/sbin/ip6tables',
  sentinel: '/bin/sleep',
});
const CREDENTIAL_SCAN_ATTESTED_BINARY_NAMES = Object.freeze(
  Object.keys(DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256),
);

export class RuntimeSnapshotArtifactError extends Error {
  constructor(message, code = 'ERR_RUNTIME_SNAPSHOT_ARTIFACT') {
    super(message);
    this.name = 'RuntimeSnapshotArtifactError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_RUNTIME_SNAPSHOT_ARTIFACT') {
  throw new RuntimeSnapshotArtifactError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`, 'ERR_RUNTIME_SNAPSHOT_SCHEMA');
  const allowed = new Set(fields);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    fail(`${label} contains an unexpected or missing field`, 'ERR_RUNTIME_SNAPSHOT_SCHEMA');
  }
}

function canonicalJson(value, depth = 0, nodes = { count: 0 }) {
  nodes.count += 1;
  if (depth > 32 || nodes.count > 100_000) fail('snapshot input exceeds structural bounds');
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, depth + 1, nodes)).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, nodes)}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))) {
    return JSON.stringify(value);
  }
  fail('snapshot input contains a non-canonical value', 'ERR_RUNTIME_SNAPSHOT_SCHEMA');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameHash(left, right) {
  if (!HASH.test(String(left)) || !HASH.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function absolute(value, label) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label} must be an absolute normalized path`, 'ERR_RUNTIME_SNAPSHOT_PATH');
  }
  return value;
}

function inside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} must be a strict child of the release artifact workspace`, 'ERR_RUNTIME_SNAPSHOT_PATH');
  }
  return candidate;
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a SHA-256 digest`);
  return value;
}

function readRegular(file, maximumBytes, label) {
  const named = fs.lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink() || named.size < 1 || named.size > maximumBytes) {
    fail(`${label} must be a bounded regular file`, 'ERR_RUNTIME_SNAPSHOT_FILE');
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino ||
        before.size !== named.size || before.mtimeMs !== named.mtimeMs) {
      fail(`${label} identity changed before reading`, 'ERR_RUNTIME_SNAPSHOT_FILE');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`${label} changed while reading`, 'ERR_RUNTIME_SNAPSHOT_FILE');
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs) {
      bytes.fill(0);
      fail(`${label} changed while reading`, 'ERR_RUNTIME_SNAPSHOT_FILE');
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeExclusive(file, bytes, mode = 0o600) {
  const descriptor = fs.openSync(file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    mode);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateInput(input) {
  exactKeys(input, INPUT_FIELDS, 'runtime snapshot input');
  const workspace = fs.realpathSync.native(absolute(input.workspace, 'workspace'));
  const workspaceStat = fs.lstatSync(workspace);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink() || (workspaceStat.mode & 0o077) !== 0) {
    fail('workspace must be a real owner-only directory', 'ERR_RUNTIME_SNAPSHOT_PATH');
  }
  absolute(input.repoRoot, 'repoRoot');
  absolute(input.daytonaPath, 'daytonaPath');
  exactKeys(input.bundle, ['bundleDir', 'manifestHash'], 'bundle');
  absolute(input.bundle.bundleDir, 'bundle.bundleDir');
  digest(input.bundle.manifestHash, 'bundle.manifestHash');
  exactKeys(input.bindings, [
    'releaseSha', 'taskLockHash', 'bundleHash', 'budgetPolicyHash', 'brokerPolicyHash', 'profileId',
    'sessionCeilingMicrousd',
  ], 'bindings');
  if (typeof input.bindings.releaseSha !== 'string' || !RELEASE_SHA.test(input.bindings.releaseSha)) {
    fail('bindings.releaseSha must be a full lowercase identity');
  }
  for (const field of ['taskLockHash', 'bundleHash', 'budgetPolicyHash', 'brokerPolicyHash']) {
    digest(input.bindings[field], `bindings.${field}`);
  }
  if (!sameHash(input.bindings.bundleHash, input.bundle.manifestHash)) fail('bundle binding drifted');
  if (typeof input.bindings.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(input.bindings.profileId)) {
    fail('bindings.profileId is malformed');
  }
  if (!Number.isSafeInteger(input.bindings.sessionCeilingMicrousd) ||
      input.bindings.sessionCeilingMicrousd < 1 || input.bindings.sessionCeilingMicrousd > 20_000_000) {
    fail('bindings.sessionCeilingMicrousd is outside its bound');
  }
  if (!plainObject(input.taskImages) || Object.keys(input.taskImages).length < 1) fail('taskImages are required');
  canonicalJson(input.taskImages);
  return { ...input, workspace };
}

function validateClosures(value, workspace) {
  exactKeys(value, CLOSURE_FIELDS, 'prepared runtime closures');
  const dockerfilePath = inside(workspace, absolute(value.dockerfilePath, 'dockerfilePath'), 'dockerfilePath');
  const definitionPath = inside(workspace, absolute(value.definitionPath, 'definitionPath'), 'definitionPath');
  exactKeys(value.roots, CONTEXT_KINDS, 'closure roots');
  const roots = {};
  for (const kind of CONTEXT_KINDS) {
    const root = fs.realpathSync.native(inside(workspace, absolute(value.roots[kind], `${kind} root`), `${kind} root`));
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${kind} closure root must be a real directory`);
    roots[kind] = root;
  }
  exactKeys(value.executables, Object.keys(DAYTONA_EXECUTABLE_PATHS), 'closure executables');
  for (const [name, approvedPath] of Object.entries(DAYTONA_EXECUTABLE_PATHS)) {
    const executable = value.executables[name];
    exactKeys(executable, ['path', 'sha256', 'context', 'sourcePath'], `executables.${name}`);
    if (executable.path !== approvedPath || executable.context !== executableContext(name) ||
        executable.sourcePath !== approvedPath.slice(1) ||
        path.posix.normalize(executable.sourcePath) !== executable.sourcePath) {
      fail(`executable ${name} path or closure binding drifted`);
    }
    digest(executable.sha256, `executables.${name}.sha256`);
  }
  if (!plainObject(value.provenance)) fail('closure provenance is required');
  return { ...value, dockerfilePath, definitionPath, roots };
}

function validateReceipt(receipt, identity) {
  if (!plainObject(receipt) || receipt.schema !== 'engineer-daytona-snapshot-lifecycle-receipt.v1' ||
      receipt.name !== identity.name || receipt.buildHash !== identity.buildHash ||
      receipt.status !== 'active' || receipt.retained !== true) {
    fail('Daytona snapshot receipt does not bind the active retained content identity',
      'ERR_RUNTIME_SNAPSHOT_RECEIPT');
  }
  return receipt;
}

export function runDaytonaSnapshotCliCommand(
  daytonaPath,
  args,
  commandOptions = undefined,
  spawnImpl = spawnSync,
) {
  if (commandOptions !== undefined &&
      (!plainObject(commandOptions) || Object.keys(commandOptions).length !== 1 ||
       !Object.hasOwn(commandOptions, 'timeoutMs'))) {
    fail('Daytona cleanup command options violate their reviewed contract');
  }
  const requestedTimeout = commandOptions?.timeoutMs;
  if (requestedTimeout !== undefined &&
      (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > 60_000)) {
    fail('Daytona cleanup command timeout is outside its reviewed bound');
  }
  const timeout = requestedTimeout ??
    (args[0] === 'snapshot' && args[1] === 'create' ? 30 * 60_000 : 5 * 60_000);
  if (typeof spawnImpl !== 'function') fail('Daytona command runner must be a function');
  const result = spawnImpl(daytonaPath, args, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    env: daytonaCliEnvironment(process.env),
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_COMMAND_BYTES,
  });
  return {
    code: Number.isInteger(result.status) ? result.status : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

async function ensureCodeOwnedSnapshot(request) {
  const controller = createDaytonaSnapshotController({
    runCommand: async (args, commandOptions) =>
      runDaytonaSnapshotCliCommand(request.daytonaPath, args, commandOptions),
  });
  return controller.ensureSnapshot({
    identity: request.identity,
    dockerfilePath: request.dockerfilePath,
    archives: request.archives,
  });
}

function hashRegularFile(file, maximumBytes, label) {
  const bytes = readRegular(file, maximumBytes, label);
  try {
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

function resolvePinnedDocker() {
  const candidates = DOCKER_CANDIDATES[`${process.platform}-${process.arch}`] ?? [];
  for (const candidate of candidates) {
    try {
      const executable = fs.realpathSync.native(candidate.path);
      if (sameHash(hashRegularFile(executable, 256 * 1024 * 1024, 'Docker CLI'), candidate.sha256)) {
        return executable;
      }
    } catch {
      // Try the next reviewed candidate. PATH and operator-selected binaries are never consulted.
    }
  }
  fail('the pinned local Docker CLI is unavailable', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
}

function safeCommandResult(result, label, { maximumBytes = MAX_COMMAND_BYTES } = {}) {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (typeof stdout !== 'string' || typeof stderr !== 'string' ||
      Buffer.byteLength(stdout) > maximumBytes || Buffer.byteLength(stderr) > maximumBytes) {
    fail(`${label} returned malformed or oversized output`, 'ERR_RUNTIME_SNAPSHOT_COMMAND');
  }
  if (result.error || result.status !== 0 || result.signal != null || stderr !== '') {
    const detail = sha256(`${result.status}\0${result.signal}\0${stdout}\0${stderr}\0${result.error?.code ?? ''}`).slice(0, 16);
    fail(`${label} failed (detail sha256:${detail})`, 'ERR_RUNTIME_SNAPSHOT_COMMAND');
  }
  return stdout;
}

export function runRuntimeSnapshotArtifactCommand(file, args, {
  cwd,
  env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  timeoutMs = 5 * 60_000,
  maximumBytes = MAX_COMMAND_BYTES,
} = {}, spawnImpl = spawnSync) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 256 ||
      args.some((value) => typeof value !== 'string' || value.length < 1 || value.includes('\0') ||
        Buffer.byteLength(value) > 4096)) {
    fail('code-owned command arguments drifted', 'ERR_RUNTIME_SNAPSHOT_COMMAND');
  }
  if (typeof spawnImpl !== 'function') {
    fail('code-owned command runner must be a function', 'ERR_RUNTIME_SNAPSHOT_COMMAND');
  }
  return safeCommandResult(spawnImpl(file, args, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    cwd,
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: maximumBytes,
  }), path.basename(file), { maximumBytes });
}

const runFixed = runRuntimeSnapshotArtifactCommand;

function assertDockerSocket() {
  let target;
  try {
    target = fs.realpathSync.native('/var/run/docker.sock');
    if (!fs.lstatSync(target).isSocket()) throw new Error('not a socket');
  } catch {
    fail('the fixed local Docker socket is unavailable', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
  }
  return target;
}

function createDockerRunner(workspace) {
  const dockerPath = resolvePinnedDocker();
  assertDockerSocket();
  const dockerConfig = path.join(workspace, 'docker-config-empty');
  fs.mkdirSync(dockerConfig, { mode: 0o700 });
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: dockerConfig,
    DOCKER_CONFIG: dockerConfig,
    LANG: 'C',
    LC_ALL: 'C',
  };
  return (args, options = {}) => runFixed(dockerPath, [
    '--host', DOCKER_HOST,
    ...args,
  ], { env, timeoutMs: options.timeoutMs ?? 10 * 60_000 });
}

function cancelWithoutWaiting(target, method, argument) {
  if (!target || typeof target[method] !== 'function') return;
  try {
    const result = target[method](argument);
    if (result && typeof result.then === 'function') void result.catch(() => {});
  } catch {
    // Cancellation is best effort after the stable primary failure has already been selected.
  }
}

export async function downloadPinnedSnapshotSourceWithFetch({ url, expectedSha256, destination }, {
  fetchImpl = fetch,
  deadlineMs = MAX_DOWNLOAD_ELAPSED_MS,
  monotonicNow = () => performance.now(),
} = {}) {
  const expected = new URL(url);
  if (expected.protocol !== 'https:' || expected.username || expected.password || expected.hash) {
    fail('pinned source URL is invalid', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  if (typeof fetchImpl !== 'function' || typeof monotonicNow !== 'function' ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DOWNLOAD_ELAPSED_MS) {
    fail('pinned source download deadline is outside its reviewed bound',
      'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }

  const abortController = new AbortController();
  const timeoutError = new RuntimeSnapshotArtifactError(
    'pinned source download exceeded its elapsed-time deadline',
    'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_TIMEOUT',
  );
  let expired = false;
  let rejectDeadline;
  const deadline = new Promise((_resolve, reject) => { rejectDeadline = reject; });
  void deadline.catch(() => {});
  const markExpired = () => {
    if (expired) return;
    expired = true;
    rejectDeadline(timeoutError);
    abortController.abort(timeoutError);
  };
  const readClock = () => {
    let observed;
    try {
      observed = monotonicNow();
    } catch {
      fail('pinned source download monotonic clock is unavailable',
        'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
    if (typeof observed !== 'number' || !Number.isFinite(observed) || observed < 0 ||
        observed > Number.MAX_SAFE_INTEGER - deadlineMs) {
      fail('pinned source download monotonic clock is invalid',
        'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
    return observed;
  };
  const startedAt = readClock();
  let lastObservedAt = startedAt;
  const assertActive = () => {
    if (expired) throw timeoutError;
    const observed = readClock();
    if (observed < lastObservedAt) {
      fail('pinned source download monotonic clock moved backwards',
        'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
    lastObservedAt = observed;
    if (observed - startedAt >= deadlineMs) {
      markExpired();
      throw timeoutError;
    }
  };
  const timeout = setTimeout(markExpired, deadlineMs);
  const withinDeadline = async (operation) => {
    if (typeof operation !== 'function') {
      fail('pinned source download operation is invalid', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
    assertActive();
    const pending = Promise.resolve().then(operation);
    const result = await Promise.race([pending, deadline]);
    assertActive();
    return result;
  };
  let response;
  let iterator;
  let descriptor;
  let created = false;
  let succeeded = false;
  try {
    response = await withinDeadline(() => fetchImpl(expected, {
      redirect: 'error',
      signal: abortController.signal,
    }));
    if (!response || response.status !== 200 || response.url !== expected.href || !response.body) {
      fail('pinned source download failed closed', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
    const declaredHeader = response.headers?.get?.('content-length');
    const declared = declaredHeader == null ? null : Number(declaredHeader);
    if (declaredHeader != null &&
        (!Number.isFinite(declared) || declared < 1 || declared > MAX_DOWNLOAD_BYTES)) {
      fail('pinned source download exceeds its byte bound', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
    iterator = response.body[Symbol.asyncIterator]?.();
    if (!iterator || typeof iterator.next !== 'function') {
      fail('pinned source download failed closed', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
    descriptor = fs.openSync(destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o400);
    created = true;
    const hash = crypto.createHash('sha256');
    let total = 0;
    while (true) {
      const next = await withinDeadline(() => iterator.next());
      if (!plainObject(next) || typeof next.done !== 'boolean') {
        fail('pinned source download failed closed', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
      }
      if (next.done) break;
      const rawChunk = next.value;
      const chunk = Buffer.from(rawChunk);
      try {
        assertActive();
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) {
          fail('pinned source download exceeds its byte bound', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
        }
        hash.update(chunk);
        assertActive();
        let offset = 0;
        while (offset < chunk.length) {
          const written = fs.writeSync(descriptor, chunk, offset, chunk.length - offset);
          if (written < 1) {
            fail('pinned source download write stopped early', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
          }
          offset += written;
          assertActive();
        }
      } finally {
        chunk.fill(0);
      }
    }
    assertActive();
    fs.fsyncSync(descriptor);
    assertActive();
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertActive();
    const streamedHash = hash.digest('hex');
    assertActive();
    const retainedHash = hashRegularFile(destination, MAX_DOWNLOAD_BYTES, 'pinned source');
    assertActive();
    if (total < 1 || !sameHash(streamedHash, expectedSha256) ||
        !sameHash(retainedHash, expectedSha256)) {
      fail('pinned source digest drifted', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
    succeeded = true;
  } catch (error) {
    if (expired) throw timeoutError;
    if (error instanceof RuntimeSnapshotArtifactError) throw error;
    fail('pinned source download failed closed', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  } finally {
    clearTimeout(timeout);
    if (!succeeded) {
      abortController.abort(timeoutError);
      cancelWithoutWaiting(iterator, 'return');
      cancelWithoutWaiting(response?.body, 'cancel', timeoutError);
      let cleanupFailed = false;
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { cleanupFailed = true; }
      }
      if (created) {
        try { fs.rmSync(destination, { force: true }); } catch { cleanupFailed = true; }
        try {
          fs.lstatSync(destination);
          cleanupFailed = true;
        } catch (error) {
          if (error?.code !== 'ENOENT') cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        throw new RuntimeSnapshotArtifactError(
          'pinned source download failed and residue cleanup was not proved',
          'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_CLEANUP',
        );
      }
    }
  }
}

function pinnedSourceProcessResult(result) {
  if (!plainObject(result)) return null;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (typeof stdout !== 'string' || typeof stderr !== 'string' ||
      Buffer.byteLength(stdout) > 8 * 1024 || Buffer.byteLength(stderr) > 8 * 1024) {
    return null;
  }
  return {
    status: Number.isInteger(result.status) ? result.status : null,
    signal: typeof result.signal === 'string' ? result.signal : null,
    errorCode: typeof result.error?.code === 'string' ? result.error.code : null,
    stdout,
    stderr,
  };
}

function runPinnedSourceHelper(args, timeoutMs, spawnImpl) {
  if (typeof spawnImpl !== 'function' || !Array.isArray(args) ||
      args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    fail('pinned source helper invocation is invalid', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  return pinnedSourceProcessResult(spawnImpl(process.execPath, [PINNED_SOURCE_HELPER, ...args], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function provePinnedPathAbsent(file, label) {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    fail(`${label} absence could not be proved`, 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  fail(`${label} must be absent before download`, 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
}

function pinnedSourceTarget(destination) {
  const requested = absolute(destination, 'pinned source destination');
  let parent;
  let parentStat;
  try {
    parent = fs.realpathSync.native(path.dirname(requested));
    parentStat = fs.lstatSync(parent);
  } catch {
    fail('pinned source parent custody could not be proved', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  const effectiveUid = process.geteuid?.();
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
      !Number.isInteger(effectiveUid) || parentStat.uid !== effectiveUid ||
      (parentStat.mode & 0o077) !== 0 || (parentStat.mode & 0o700) !== 0o700) {
    fail('pinned source parent must be an owner-private directory',
      'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  return path.join(parent, path.basename(requested));
}

function createPinnedSourceAttempt(target, randomBytes) {
  if (typeof randomBytes !== 'function') {
    fail('pinned source attempt entropy is unavailable', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  provePinnedPathAbsent(target, 'pinned source destination');
  let entropy;
  try {
    entropy = randomBytes(16);
  } catch {
    fail('pinned source attempt entropy is unavailable', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  if (!Buffer.isBuffer(entropy) || entropy.length !== 16) {
    fail('pinned source attempt entropy is malformed', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  const token = entropy.toString('hex');
  entropy.fill(0);
  if (!PINNED_SOURCE_ATTEMPT_TOKEN.test(token)) {
    fail('pinned source attempt identity is malformed', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  const directory = path.join(path.dirname(target), `${PINNED_SOURCE_ATTEMPT_PREFIX}${token}`);
  try {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      fail('pinned source attempt custody could not be proved',
        'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
  } catch (error) {
    if (error instanceof RuntimeSnapshotArtifactError) throw error;
    fail('pinned source attempt could not be created exclusively',
      'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  return {
    token,
    directory,
    partial: path.join(directory, PINNED_SOURCE_PARTIAL_NAME),
  };
}

function pinnedSourceAttemptAbsent(attempt) {
  try {
    fs.lstatSync(attempt.directory);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function validatePinnedSourcePartial(attempt, expectedSha256) {
  let stat;
  try {
    stat = fs.lstatSync(attempt.partial);
  } catch {
    fail('pinned source helper did not retain its attempt-owned result',
      'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  const effectiveUid = process.geteuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 ||
      stat.size > MAX_DOWNLOAD_BYTES || !Number.isInteger(effectiveUid) ||
      stat.uid !== effectiveUid || (stat.mode & 0o077) !== 0 ||
      !sameHash(hashRegularFile(attempt.partial, MAX_DOWNLOAD_BYTES, 'pinned source partial'),
        expectedSha256)) {
    fail('pinned source helper result failed ownership or digest validation',
      'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  return stat;
}

function publishPinnedSource(attempt, target, expectedSha256) {
  const partialStat = validatePinnedSourcePartial(attempt, expectedSha256);
  provePinnedPathAbsent(target, 'pinned source destination');
  try {
    fs.linkSync(attempt.partial, target);
    const published = fs.lstatSync(target);
    if (!published.isFile() || published.isSymbolicLink() || published.dev !== partialStat.dev ||
        published.ino !== partialStat.ino || published.nlink !== 2 ||
        published.uid !== partialStat.uid || published.size !== partialStat.size) {
      fail('pinned source publication identity drifted', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
    }
  } catch (error) {
    try {
      const published = fs.lstatSync(target);
      if (published.dev === partialStat.dev && published.ino === partialStat.ino) {
        fs.unlinkSync(target);
      }
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        throw new RuntimeSnapshotArtifactError(
          'pinned source publication failed and rollback was not proved',
          'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_CLEANUP',
        );
      }
    }
    if (error instanceof RuntimeSnapshotArtifactError) throw error;
    fail('pinned source publication failed closed', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  return partialStat;
}

export async function downloadPinnedSnapshotSource({ url, expectedSha256, destination }, {
  spawnImpl = spawnSync,
  randomBytes = crypto.randomBytes,
} = {}) {
  let expected;
  try {
    expected = new URL(url);
  } catch {
    fail('pinned source URL is invalid', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  if (expected.protocol !== 'https:' || expected.username || expected.password || expected.hash ||
      !HASH.test(String(expectedSha256))) {
    fail('pinned source URL or digest is invalid', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  const target = pinnedSourceTarget(destination);
  const attempt = createPinnedSourceAttempt(target, randomBytes);
  const expectedSuccess = `${PINNED_SOURCE_SUCCESS} ${expectedSha256}\n`;
  const result = runPinnedSourceHelper([
    '--download',
    '--url', expected.href,
    '--expected-sha256', expectedSha256,
    '--destination', target,
    '--attempt-token', attempt.token,
  ], MAX_DOWNLOAD_ELAPSED_MS, spawnImpl);
  let publishedStat = null;
  let primaryCode;
  if (result?.status === 0 && result.signal === null && result.errorCode === null &&
      result.stdout === expectedSuccess && result.stderr === '') {
    try {
      publishedStat = publishPinnedSource(attempt, target, expectedSha256);
    } catch (error) {
      primaryCode = error?.code === 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_CLEANUP'
        ? 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_CLEANUP'
        : 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD';
    }
  }
  primaryCode ??= result?.errorCode === 'ETIMEDOUT' || result?.signal === 'SIGKILL'
    ? 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_TIMEOUT'
    : 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD';
  const cleanup = runPinnedSourceHelper([
    '--cleanup',
    '--destination', target,
    '--attempt-token', attempt.token,
  ], DOWNLOAD_CLEANUP_TIMEOUT_MS, spawnImpl);
  if (cleanup?.status !== 0 || cleanup.signal !== null || cleanup.errorCode !== null ||
      cleanup.stdout !== PINNED_SOURCE_ABSENT || cleanup.stderr !== '' ||
      !pinnedSourceAttemptAbsent(attempt)) {
    throw new RuntimeSnapshotArtifactError(
      `pinned source download cleanup was not proved after ${primaryCode}`,
      'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_CLEANUP',
    );
  }
  if (publishedStat != null) {
    const retained = fs.lstatSync(target);
    if (!retained.isFile() || retained.isSymbolicLink() || retained.dev !== publishedStat.dev ||
        retained.ino !== publishedStat.ino || retained.nlink !== 1 ||
        !sameHash(hashRegularFile(target, MAX_DOWNLOAD_BYTES, 'pinned source'), expectedSha256)) {
      throw new RuntimeSnapshotArtifactError(
        'pinned source publication verification failed after cleanup',
        'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_CLEANUP',
      );
    }
    return;
  }
  throw new RuntimeSnapshotArtifactError(
    primaryCode === 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_TIMEOUT'
      ? 'pinned source download exceeded its elapsed-time deadline'
      : 'pinned source download failed closed',
    primaryCode,
  );
}

function copyRegular(source, destination, mode) {
  const bytes = readRegular(source, 512 * 1024 * 1024, 'closure source');
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    writeExclusive(destination, bytes, mode);
    fs.chmodSync(destination, mode);
  } finally {
    bytes.fill(0);
  }
}

export function normalizeTrackedNativeSource(root) {
  if (typeof root !== 'string' || root.length < 1 || root.includes('\0')) {
    fail('tracked native source path is invalid', 'ERR_RUNTIME_SNAPSHOT_SOURCE');
  }
  const resolved = path.resolve(root);
  let entries = 0;
  const visit = (current, depth) => {
    if (depth > 4 || entries >= 64) {
      fail('tracked native source exceeds its reviewed bounds', 'ERR_RUNTIME_SNAPSHOT_SOURCE');
    }
    entries += 1;
    const stat = fs.lstatSync(current);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const names = fs.readdirSync(current)
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      for (const name of names) visit(path.join(current, name), depth + 1);
      // Keep owner write permission so the owner-verified outer workspace can
      // still be removed after build failure; Docker only needs read/traverse.
      fs.chmodSync(current, 0o755);
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) {
      fail('tracked native source contains an unsupported entry', 'ERR_RUNTIME_SNAPSHOT_SOURCE');
    }
    fs.chmodSync(current, 0o444);
  };
  visit(resolved, 0);
  return resolved;
}

function snapshotTrackedRuntime({ repoRoot, releaseSha, destination, workspace }) {
  const trackedArchive = path.join(workspace, 'tracked-runtime.tar');
  const extracted = path.join(workspace, 'tracked-runtime');
  fs.mkdirSync(extracted, { mode: 0o700 });
  runFixed('/usr/bin/git', [
    '-C', repoRoot,
    '-c', 'core.fsmonitor=false',
    'archive', '--format=tar', `--output=${trackedArchive}`, releaseSha, '--', 'evals/runtime',
  ], { cwd: repoRoot });
  runFixed('/usr/bin/tar', ['-xf', trackedArchive, '-C', extracted]);
  const source = path.join(extracted, 'evals', 'runtime');
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) fail('tracked runtime snapshot is malformed');
  const target = path.join(destination, 'opt', 'engineer', 'runtime');
  fs.mkdirSync(target, { recursive: true, mode: 0o755 });
  const names = fs.readdirSync(source).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  let copied = 0;
  for (const name of names) {
    if (!name.endsWith('.mjs')) continue;
    const file = path.join(source, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('tracked runtime contains a non-regular module');
    copyRegular(file, path.join(target, name), 0o444);
    copied += 1;
  }
  if (copied < 20 || !fs.existsSync(path.join(target, 'remote-supervisor.mjs')) ||
      !fs.existsSync(path.join(target, 'snapshot-selftest.mjs'))) {
    fail('tracked runtime snapshot is incomplete', 'ERR_RUNTIME_SNAPSHOT_SOURCE');
  }
  const nativeSource = path.join(source, 'native');
  if (!fs.lstatSync(nativeSource).isDirectory()) fail('tracked native helper source is missing');
  return { nativeSource: normalizeTrackedNativeSource(nativeSource) };
}

const WRAPPERS = Object.freeze({
  supervisor: `#!/usr/local/bin/node
import { runRemoteSupervisorCli, terminateRemoteSupervisorProcess } from '/opt/engineer/runtime/remote-supervisor.mjs';
try { await runRemoteSupervisorCli(); } catch (error) { terminateRemoteSupervisorProcess(error); }
`,
  archiveBridge: `#!/usr/local/bin/node
import { runRemoteBridgeCli } from '/opt/engineer/runtime/remote-bridge.mjs';
try { await runRemoteBridgeCli({ executableName: 'engineer-archive-bridge' }); } catch { process.exitCode = 70; }
`,
  runner: `#!/usr/local/bin/node
import { runArchivedTrialCli } from '/opt/engineer/runtime/trial-runner.mjs';
process.exitCode = await runArchivedTrialCli();
`,
  providerBroker: `#!/usr/local/bin/node
import { runProviderBrokerCli } from '/opt/engineer/runtime/provider-broker.mjs';
try { await runProviderBrokerCli(); } catch { process.exitCode = 70; }
`,
  readinessProbe: `#!/usr/local/bin/node
import { runRuntimeProbeCli } from '/opt/engineer/runtime/runtime-probe.mjs';
try { process.exitCode = await runRuntimeProbeCli({ executablePath: '/opt/engineer/bin/engineer-runtime-probe' }); } catch { process.exitCode = 70; }
`,
  evidenceCollector: `#!/usr/local/bin/node
import { runRuntimeEvidenceCli } from '/opt/engineer/runtime/runtime-evidence.mjs';
try { process.exitCode = await runRuntimeEvidenceCli({ executablePath: '/opt/engineer/bin/engineer-runtime-evidence' }); } catch { process.exitCode = 70; }
`,
  imageProvisioner: `#!/usr/local/bin/node
import { runTaskImageProvisionerCli } from '/opt/engineer/runtime/task-image-provisioner.mjs';
process.exitCode = await runTaskImageProvisionerCli();
`,
  snapshotSelfTest: `#!/usr/local/bin/node
import { runSnapshotSelfTestMain } from '/opt/engineer/runtime/snapshot-selftest.mjs';
try { process.exitCode = await runSnapshotSelfTestMain(); } catch { process.exitCode = 70; }
`,
});

function materializeWrappers(runtimeRoot, harborRoot) {
  const wrapperFiles = {};
  for (const [name, source] of Object.entries(WRAPPERS)) {
    const destination = path.join(runtimeRoot, ...DAYTONA_EXECUTABLE_PATHS[name].slice(1).split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    writeExclusive(destination, Buffer.from(source), 0o555);
    wrapperFiles[name] = destination;
  }
  const harborWrapper = path.join(harborRoot, ...DAYTONA_EXECUTABLE_PATHS.harbor.slice(1).split('/'));
  fs.mkdirSync(path.dirname(harborWrapper), { recursive: true, mode: 0o755 });
  writeExclusive(harborWrapper, Buffer.from(`#!/opt/engineer/harbor/source/.venv/bin/python
from harbor.cli.main import app
app()
`), 0o555);
  wrapperFiles.harbor = harborWrapper;
  return wrapperFiles;
}

export function pullExactImages(runDocker) {
  for (const reference of [
    DAYTONA_DIND_BASE_IMAGE,
    DAYTONA_NODE_RUNTIME_IMAGE,
    NATIVE_COMPILER_IMAGE,
    PYTHON_BUILDER_IMAGE,
    UV_BUILDER_IMAGE,
  ]) {
    runDocker(['pull', '--platform', 'linux/amd64', reference], { timeoutMs: 20 * 60_000 });
    const platform = runDocker([
      'image', 'inspect', '--platform', 'linux/amd64',
      '--format', '{{.Os}}/{{.Architecture}}', reference,
    ]);
    if (platform !== 'linux/amd64\n') fail('pinned builder image platform drifted', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
  }
}

function builderRecord(runDocker, identity, commandOptions = undefined) {
  const output = runDocker([
    'container', 'ls', '--all', '--no-trunc',
    '--filter', `name=^/${identity.name}$`,
    '--format', `{{.ID}}\t{{.Names}}\t{{.Label "${BUILDER_OWNER_LABEL}"}}\t{{.Label "${BUILDER_ID_LABEL}"}}`,
  ], commandOptions);
  if (output === '') return null;
  const lines = output.endsWith('\n') ? output.slice(0, -1).split('\n') : [];
  if (lines.length !== 1) {
    fail('Docker builder ownership lookup returned malformed output', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
  }
  const [containerId, name, owner, token, ...extra] = lines[0].split('\t');
  if (extra.length !== 0 || !/^[a-f0-9]{64}$/.test(containerId) || name !== identity.name) {
    fail('Docker builder ownership lookup returned malformed output', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
  }
  return { containerId, name, owner, token };
}

function defaultBuilderCleanupWait(milliseconds) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function builderCleanupBackoffMs(identity, attempt) {
  const base = Math.min(
    BUILDER_CLEANUP_BACKOFF_MAX_MS,
    BUILDER_CLEANUP_BACKOFF_BASE_MS * (2 ** attempt),
  );
  const offset = (attempt * 2) % identity.token.length;
  const jitterByte = Number.parseInt(identity.token.slice(offset, offset + 2), 16);
  return Math.min(
    BUILDER_CLEANUP_BACKOFF_MAX_MS,
    base + Math.floor((base * jitterByte) / (255 * 4)),
  );
}

function reconcileBuilderAbsence(runDocker, identity, monotonicNow, wait) {
  if (typeof monotonicNow !== 'function' || typeof wait !== 'function') {
    fail('Docker builder cleanup monotonic clock is unavailable', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
  }
  const readClock = () => {
    let observed;
    try { observed = monotonicNow(); } catch {
      fail('Docker builder cleanup monotonic clock is unavailable', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
    }
    if (typeof observed !== 'number' || !Number.isFinite(observed) || observed < 0 ||
        observed > Number.MAX_SAFE_INTEGER - BUILDER_CLEANUP_DEADLINE_MS) {
      fail('Docker builder cleanup monotonic clock is invalid', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
    }
    return observed;
  };
  let lastObservedAt = readClock();
  const deadlineAt = lastObservedAt + BUILDER_CLEANUP_DEADLINE_MS;
  const remainingMs = () => {
    const observed = readClock();
    if (observed < lastObservedAt) {
      fail('Docker builder cleanup monotonic clock moved backwards', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
    }
    lastObservedAt = observed;
    const remaining = Math.floor(deadlineAt - observed);
    if (remaining < 1) {
      fail('Docker builder cleanup exceeded its elapsed-time deadline',
        'ERR_RUNTIME_SNAPSHOT_DOCKER');
    }
    return remaining;
  };
  const commandOptions = () => {
    const remaining = remainingMs();
    return Object.freeze({
      timeoutMs: Math.min(BUILDER_CLEANUP_COMMAND_TIMEOUT_MS, remaining),
    });
  };
  const runCleanup = (args) => {
    const result = runDocker(args, commandOptions());
    commandOptions();
    return result;
  };
  const waitBeforeRetry = (attempt) => {
    const remaining = remainingMs();
    const milliseconds = Math.min(builderCleanupBackoffMs(identity, attempt), remaining - 1);
    if (milliseconds < 1) {
      fail('Docker builder cleanup exceeded its elapsed-time deadline',
        'ERR_RUNTIME_SNAPSHOT_DOCKER');
    }
    try {
      const result = wait(milliseconds);
      if (result && typeof result.then === 'function') {
        fail('Docker builder cleanup wait must be synchronous',
          'ERR_RUNTIME_SNAPSHOT_DOCKER');
      }
    } catch (error) {
      if (error instanceof RuntimeSnapshotArtifactError) throw error;
      fail('Docker builder cleanup wait failed', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
    }
    remainingMs();
  };

  let lastCleanupError = null;
  let consecutiveAbsenceObservations = 0;
  for (let attempt = 0; attempt < BUILDER_CLEANUP_ATTEMPTS; attempt += 1) {
    let record;
    try {
      record = builderRecord(runDocker, identity, commandOptions());
      commandOptions();
    } catch (error) {
      lastCleanupError = error;
      consecutiveAbsenceObservations = 0;
      if (attempt + 1 < BUILDER_CLEANUP_ATTEMPTS) waitBeforeRetry(attempt);
      continue;
    }
    if (record === null) {
      consecutiveAbsenceObservations += 1;
      if (consecutiveAbsenceObservations >= BUILDER_CLEANUP_ABSENCE_CONFIRMATIONS) return;
      if (attempt + 1 < BUILDER_CLEANUP_ATTEMPTS) waitBeforeRetry(attempt);
      continue;
    }
    consecutiveAbsenceObservations = 0;
    if (record.owner !== BUILDER_OWNER || record.token !== identity.token) {
      fail('Docker builder ownership could not be proved; refusing cleanup',
        'ERR_RUNTIME_SNAPSHOT_DOCKER');
    }
    try {
      runCleanup(['rm', '-f', record.containerId]);
    } catch (error) {
      lastCleanupError = error;
    }
    // A lost remove response is ambiguous. Re-observe the exact owned name before deciding
    // whether another remove is necessary or absence has already been achieved.
    if (attempt + 1 < BUILDER_CLEANUP_ATTEMPTS) waitBeforeRetry(attempt);
  }
  const cause = lastCleanupError instanceof RuntimeSnapshotArtifactError
    ? lastCleanupError.code
    : 'ERR_UNKNOWN';
  fail(`Docker builder container absence was not proved (last cause ${cause})`,
    'ERR_RUNTIME_SNAPSHOT_DOCKER');
}

export function withBuilderContainer(runDocker, createArgs, operation, {
  monotonicNow = () => performance.now(),
  wait = defaultBuilderCleanupWait,
} = {}) {
  if (typeof runDocker !== 'function' || typeof operation !== 'function') {
    fail('Docker builder callbacks must be functions', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
  }
  const token = crypto.randomBytes(16).toString('hex');
  const identity = Object.freeze({
    name: `engineer-eval-builder-${token}`,
    token,
  });
  let rawId;
  try {
    rawId = runDocker([
      'create',
      '--name', identity.name,
      '--label', `${BUILDER_OWNER_LABEL}=${BUILDER_OWNER}`,
      '--label', `${BUILDER_ID_LABEL}=${identity.token}`,
      ...createArgs,
    ]).trim();
    if (!/^[a-f0-9]{64}$/.test(rawId)) {
      fail('Docker returned a malformed builder container identity', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
    }
    const created = builderRecord(runDocker, identity);
    if (created === null || created.owner !== BUILDER_OWNER || created.token !== identity.token ||
        created.containerId !== rawId) {
      fail('Docker builder container identity was not proved', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
    }
  } catch (primaryError) {
    try {
      reconcileBuilderAbsence(runDocker, identity, monotonicNow, wait);
    } catch (cleanupError) {
      throw new AggregateError([primaryError, cleanupError],
        'builder create failed and cleanup was not confirmed');
    }
    throw primaryError;
  }
  let primaryError;
  try {
    return operation(rawId);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      reconcileBuilderAbsence(runDocker, identity, monotonicNow, wait);
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], 'builder failed and cleanup was not confirmed');
      throw cleanupError;
    }
  }
}

function extractBaseExecutables(runDocker, runtimeRoot, workspace) {
  withBuilderContainer(runDocker, [
    '--platform', 'linux/amd64', DAYTONA_DIND_BASE_IMAGE, '/bin/true',
  ], (containerId) => {
    for (const [name, source] of Object.entries(BASE_EXECUTABLE_SOURCES)) {
      const temporary = path.join(workspace, `base-${name}`);
      runDocker(['cp', '-L', `${containerId}:${source}`, temporary]);
      const destination = path.join(runtimeRoot, ...DAYTONA_EXECUTABLE_PATHS[name].slice(1).split('/'));
      copyRegular(temporary, destination, 0o555);
      fs.rmSync(temporary);
    }
  });
}

function assertStaticLinuxAmd64Elf(file, label) {
  const bytes = readRegular(file, 64 * 1024 * 1024, label);
  try {
    if (bytes.length < 64 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c ||
        bytes[3] !== 0x46 || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) {
      fail(`${label} is not a linux/amd64 ELF64 executable`, 'ERR_RUNTIME_SNAPSHOT_NATIVE');
    }
    const programOffset = bytes.readBigUInt64LE(32);
    const entryBytes = bytes.readUInt16LE(54);
    const entryCount = bytes.readUInt16LE(56);
    if (programOffset > BigInt(Number.MAX_SAFE_INTEGER) || entryBytes < 56 || entryCount < 1 ||
        entryCount > 256 || Number(programOffset) + (entryBytes * entryCount) > bytes.length) {
      fail(`${label} has a malformed ELF program table`, 'ERR_RUNTIME_SNAPSHOT_NATIVE');
    }
    for (let index = 0; index < entryCount; index += 1) {
      const offset = Number(programOffset) + (index * entryBytes);
      if (bytes.readUInt32LE(offset) === 3) {
        fail(`${label} is dynamically interpreted instead of static`, 'ERR_RUNTIME_SNAPSHOT_NATIVE');
      }
    }
  } finally {
    bytes.fill(0);
  }
}

function compileNativeArtifacts(runDocker, nativeSource, nativeRoot, workspace) {
  const helperSourceSha256 = hashRegularFile(
    path.join(nativeSource, 'engineer-cgroup-exec.c'), 4 * 1024 * 1024, 'native helper source');
  const probeSourceSha256 = hashRegularFile(
    path.join(nativeSource, 'engineer-task-isolation-probe.c'), 4 * 1024 * 1024,
    'task isolation probe source');
  const denialProbeSourceSha256 = hashRegularFile(
    path.join(nativeSource, 'engineer-readiness-denial-probe.c'), 4 * 1024 * 1024,
    'readiness denial probe source');
  const helperOutput = path.join(nativeRoot, ...DAYTONA_EXECUTABLE_PATHS.cgroupExec.slice(1).split('/'));
  const probeOutput = path.join(nativeRoot,
    ...DAYTONA_EXECUTABLE_PATHS.taskIsolationProbe.slice(1).split('/'));
  const denialProbeOutput = path.join(nativeRoot,
    ...DAYTONA_EXECUTABLE_PATHS.readinessDenialProbe.slice(1).split('/'));
  fs.mkdirSync(path.dirname(helperOutput), { recursive: true, mode: 0o755 });
  withBuilderContainer(runDocker, [
    '--platform', 'linux/amd64',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--workdir', '/src',
    NATIVE_COMPILER_IMAGE,
    'make', 'OUTPUT=/out/engineer-cgroup-exec',
    'PROBE_OUTPUT=/out/engineer-task-isolation-probe',
    'DENIAL_PROBE_OUTPUT=/out/engineer-readiness-denial-probe',
    'alpine-static', 'task-isolation-probe-static', 'readiness-denial-probe-static',
  ], (containerId) => {
    runDocker(['cp', `${nativeSource}/.`, `${containerId}:/src`]);
    runDocker(['start', '-a', containerId]);
    for (const [name, output] of [
      ['engineer-cgroup-exec', helperOutput],
      ['engineer-task-isolation-probe', probeOutput],
      ['engineer-readiness-denial-probe', denialProbeOutput],
    ]) {
      const temporary = path.join(workspace, `${name}.compiled`);
      runDocker(['cp', `${containerId}:/out/${name}`, temporary]);
      copyRegular(temporary, output, 0o555);
      fs.rmSync(temporary);
    }
  });
  return {
    nativeHelper: {
      sourceSha256: helperSourceSha256,
      compilerImage: NATIVE_COMPILER_IMAGE,
      compilerImageDigest: NATIVE_COMPILER_DIGEST,
      binarySha256: hashRegularFile(helperOutput, 64 * 1024 * 1024, 'native helper binary'),
    },
    taskIsolationProbe: {
      sourceSha256: probeSourceSha256,
      compilerImage: NATIVE_COMPILER_IMAGE,
      compilerImageDigest: NATIVE_COMPILER_DIGEST,
      binarySha256: hashRegularFile(probeOutput, 64 * 1024 * 1024,
        'task isolation probe binary'),
      platform: 'linux/amd64',
      artifactPath: DAYTONA_EXECUTABLE_PATHS.taskIsolationProbe,
    },
    readinessDenialProbe: {
      sourceSha256: denialProbeSourceSha256,
      compilerImage: NATIVE_COMPILER_IMAGE,
      compilerImageDigest: NATIVE_COMPILER_DIGEST,
      binarySha256: hashRegularFile(denialProbeOutput, 64 * 1024 * 1024,
        'readiness denial probe binary'),
      platform: 'linux/amd64',
      artifactPath: DAYTONA_EXECUTABLE_PATHS.readinessDenialProbe,
    },
  };
}

function verifyHarborLock(archive, workspace) {
  const extracted = runFixed('/usr/bin/tar', [
    '-xOf', archive, `harbor-${HARBOR_SOURCE.commit}/uv.lock`,
  ], { maximumBytes: 16 * 1024 * 1024 });
  if (!sameHash(sha256(extracted), HARBOR_SOURCE.lockSha256)) {
    fail('Harbor uv.lock digest drifted', 'ERR_RUNTIME_SNAPSHOT_SOURCE');
  }
  const marker = path.join(workspace, 'harbor-lock-sha256');
  writeExclusive(marker, Buffer.from(`${HARBOR_SOURCE.lockSha256}\n`), 0o400);
}

export function smokeNodeRuntimeClosure(runDocker, nodeRoot) {
  if (typeof runDocker !== 'function') {
    fail('Node runtime smoke runner must be a function', 'ERR_RUNTIME_SNAPSHOT_NODE_ABI');
  }
  const closureRoot = absolute(nodeRoot, 'Node runtime closure root');
  const mounts = NODE_RUNTIME_FILES.flatMap((record) => [
    '--mount',
    `type=bind,src=${path.join(closureRoot, ...record.path.split('/'))},dst=/${record.path},readonly`,
  ]);
  const version = runDocker([
    'run', '--rm', '--pull', 'never', '--platform', 'linux/amd64', '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...mounts,
    '--entrypoint', DAYTONA_EXECUTABLE_PATHS.node,
    DAYTONA_DIND_BASE_IMAGE,
    '--version',
  ]);
  if (version !== 'v22.17.1\n') {
    fail('pinned Node runtime is not executable in the DIND base', 'ERR_RUNTIME_SNAPSHOT_NODE_ABI');
  }
}

function materializeNode(runDocker, nodeRoot, workspace) {
  const probeRoot = path.join(workspace, 'node-runtime-abi');
  fs.mkdirSync(probeRoot, { mode: 0o700 });
  withBuilderContainer(runDocker, [
    '--platform', 'linux/amd64', '--entrypoint', '/bin/true', DAYTONA_NODE_RUNTIME_IMAGE,
  ], (containerId) => {
    for (const [index, record] of NODE_RUNTIME_FILES.entries()) {
      const target = path.join(probeRoot, `runtime-${index}`);
      runDocker(['cp', '-L', `${containerId}:${record.source}`, target]);
      const bytes = readRegular(target, 512 * 1024 * 1024, 'Node runtime file');
      try {
        if (bytes.length !== record.byteLength || !sameHash(sha256(bytes), record.sha256)) {
          fail('pinned Node runtime image contents drifted', 'ERR_RUNTIME_SNAPSHOT_NODE_ABI');
        }
      } finally {
        bytes.fill(0);
      }
      const destination = path.join(nodeRoot, ...record.path.split('/'));
      copyRegular(target, destination, record.mode);
      const copied = fs.lstatSync(destination);
      if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== record.byteLength ||
          (copied.mode & 0o777) !== record.mode) {
        fail('pinned Node runtime image contents drifted', 'ERR_RUNTIME_SNAPSHOT_NODE_ABI');
      }
      fs.rmSync(target);
    }
  });
  smokeNodeRuntimeClosure(runDocker, nodeRoot);
  fs.rmdirSync(probeRoot);
  return path.join(nodeRoot, ...DAYTONA_EXECUTABLE_PATHS.node.slice(1).split('/'));
}

function materializeHarborSource(harborRoot, downloaded) {
  const destination = path.join(harborRoot, 'opt', 'engineer', 'build', 'harbor-source.tar.gz');
  copyRegular(downloaded, destination, 0o444);
  return destination;
}

function executableInventory(roots) {
  const inventory = {};
  for (const [name, approvedPath] of Object.entries(DAYTONA_EXECUTABLE_PATHS)) {
    const context = executableContext(name);
    const sourcePath = approvedPath.slice(1);
    const file = path.join(roots[context], ...sourcePath.split('/'));
    inventory[name] = {
      path: approvedPath,
      sha256: hashRegularFile(file, 512 * 1024 * 1024, `protected executable ${name}`),
      context,
      sourcePath,
    };
  }
  return inventory;
}

function executableContext(name) {
  if (name === 'node') return 'node';
  if (name === 'harbor') return 'harbor';
  if (['cgroupExec', 'taskIsolationProbe', 'readinessDenialProbe'].includes(name)) return 'native';
  return 'runtime';
}

function snapshotDockerfile() {
  return [
    `FROM ${UV_BUILDER_IMAGE} AS uv-runtime`,
    `FROM ${PYTHON_BUILDER_IMAGE} AS harbor-build`,
    'COPY --from=uv-runtime /uv /usr/local/bin/uv',
    'ADD harbor.tar /',
    'ENV UV_NO_PROGRESS=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1',
    `RUN mkdir -p /opt/engineer/harbor/source && tar -xzf /opt/engineer/build/harbor-source.tar.gz -C /opt/engineer/harbor/source --strip-components=1 && cd /opt/engineer/harbor/source && /usr/local/bin/uv sync --frozen --no-dev --no-editable --python /usr/local/bin/python3 && rm -rf /root/.cache /tmp/*`,
    `FROM ${DAYTONA_DIND_BASE_IMAGE}`,
    'COPY --from=harbor-build /usr/local /usr/local',
    'COPY --from=harbor-build /opt/engineer/harbor /opt/engineer/harbor',
    'COPY --from=harbor-build /opt/engineer/bin/harbor /opt/engineer/bin/harbor',
    'ADD runtime.tar /',
    'ADD node.tar /',
    'ADD native.tar /',
    'COPY build-manifest.json /opt/engineer/snapshot/build-manifest.json',
    'RUN addgroup -S -g 2001 engineer-runner && addgroup -S -g 2002 engineer-broker && addgroup -S -g 2003 engineer-client && adduser -S -D -H -u 2001 -G engineer-runner engineer-runner && adduser -S -D -H -u 2002 -G engineer-broker engineer-broker && addgroup engineer-runner engineer-client && mkdir -p /engineer-bounded/transport /engineer-bounded/work /engineer-bounded/evidence /engineer-bounded/broker /engineer-bounded/docker /engineer-bounded/.readiness-denial-mount /run/engineer && chown 2001:2001 /engineer-bounded/work && chown 2002:2002 /engineer-bounded/broker && chmod 0755 /engineer-bounded /engineer-bounded/transport /engineer-bounded/docker /run/engineer && chmod 0555 /engineer-bounded/.readiness-denial-mount && chmod 0700 /engineer-bounded/work /engineer-bounded/evidence /engineer-bounded/broker && chmod -R go-w /opt/engineer /usr/local/bin/node /usr/local/bin/docker /usr/local/bin/dockerd /usr/sbin/iptables /usr/sbin/ip6tables /usr/bin/sleep /usr/lib/libgcc_s.so.1 /usr/lib/libstdc++.so.6',
    'ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PYTHONDONTWRITEBYTECODE=1',
    'ENTRYPOINT ["/usr/local/bin/node","/opt/engineer/runtime/snapshot-manager.mjs"]',
    '',
  ].join('\n');
}

async function prepareCodeOwnedClosures({
  workspace,
  repoRoot,
  bindings,
  taskImages,
}) {
  const roots = Object.fromEntries(CONTEXT_KINDS.map((kind) => {
    const root = path.join(workspace, `closure-${kind}`);
    fs.mkdirSync(root, { mode: 0o700 });
    return [kind, root];
  }));
  const tracked = snapshotTrackedRuntime({
    repoRoot,
    releaseSha: bindings.releaseSha,
    destination: roots.runtime,
    workspace,
  });
  const wrappers = materializeWrappers(roots.runtime, roots.harbor);
  if (Object.keys(wrappers).length !== Object.keys(WRAPPERS).length + 1) fail('runtime wrapper inventory is incomplete');

  const harborDownload = path.join(workspace, 'harbor-source.tar.gz');
  await downloadPinnedSnapshotSource({
    url: HARBOR_SOURCE.url,
    expectedSha256: HARBOR_SOURCE.sha256,
    destination: harborDownload,
  });
  verifyHarborLock(harborDownload, workspace);
  materializeHarborSource(roots.harbor, harborDownload);

  const runDocker = createDockerRunner(workspace);
  pullExactImages(runDocker);
  materializeNode(runDocker, roots.node, workspace);
  extractBaseExecutables(runDocker, roots.runtime, workspace);
  const native = compileNativeArtifacts(runDocker, tracked.nativeSource, roots.native, workspace);
  assertStaticLinuxAmd64Elf(
    path.join(roots.native, ...DAYTONA_EXECUTABLE_PATHS.taskIsolationProbe.slice(1).split('/')),
    'task isolation probe binary',
  );
  assertStaticLinuxAmd64Elf(
    path.join(roots.native, ...DAYTONA_EXECUTABLE_PATHS.readinessDenialProbe.slice(1).split('/')),
    'readiness denial probe binary',
  );
  const executables = executableInventory(roots);
  for (const [name, expectedSha256] of Object.entries(DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256)) {
    if (!sameHash(executables[name].sha256, expectedSha256)) {
      fail('credential-bearing executable identity drifted from its code-owned pin');
    }
  }
  if (!sameHash(executables.cgroupExec.sha256, native.nativeHelper.binarySha256)) {
    fail('native helper binary identity drifted after materialization');
  }
  if (!sameHash(executables.taskIsolationProbe.sha256, native.taskIsolationProbe.binarySha256)) {
    fail('task isolation probe binary identity drifted after materialization');
  }
  if (!sameHash(executables.readinessDenialProbe.sha256,
    native.readinessDenialProbe.binarySha256)) {
    fail('readiness denial probe binary identity drifted after materialization');
  }

  const definitionPath = path.join(roots.runtime, 'opt', 'engineer', 'snapshot', 'snapshot-definition.json');
  fs.mkdirSync(path.dirname(definitionPath), { recursive: true, mode: 0o755 });
  const definition = Buffer.from(canonicalJson({
    schema: 'engineer-snapshot-runtime-definition.v1',
    manifestVersion: 1,
    bindings,
    taskImages,
    executablePaths: DAYTONA_EXECUTABLE_PATHS,
    executableHashes: Object.fromEntries(Object.entries(executables).map(([name, value]) => [name, value.sha256])),
    providerCredentialPresent: false,
  }));
  try {
    writeExclusive(definitionPath, definition, 0o400);
  } finally {
    definition.fill(0);
  }
  const dockerfilePath = path.join(workspace, 'Dockerfile.snapshot');
  writeExclusive(dockerfilePath, Buffer.from(snapshotDockerfile()), 0o400);
  return {
    dockerfilePath,
    definitionPath,
    roots,
    executables,
    provenance: {
      baseImage: {
        reference: DAYTONA_DIND_BASE_IMAGE,
        digest: DAYTONA_DIND_BASE_IMAGE_DIGEST,
      },
      harbor: {
        version: HARBOR_SOURCE.version,
        commit: HARBOR_SOURCE.commit,
        lockSha256: HARBOR_SOURCE.lockSha256,
      },
      node: {
        version: 'v22.17.1',
        platform: 'linux/amd64-musl',
        runtimeImage: DAYTONA_NODE_RUNTIME_IMAGE,
        runtimeImageDigest: DAYTONA_NODE_RUNTIME_IMAGE_DIGEST,
        binarySha256: DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256.node,
      },
      ...native,
    },
  };
}

const DEFAULT_COMPONENTS = Object.freeze({
  prepareClosures: prepareCodeOwnedClosures,
  ensureSnapshot: ensureCodeOwnedSnapshot,
});

function validateComponents(components) {
  exactKeys(components, Object.keys(DEFAULT_COMPONENTS), 'runtime snapshot components');
  for (const [name, implementation] of Object.entries(components)) {
    if (typeof implementation !== 'function') fail(`${name} must be a function`);
  }
  return components;
}

export async function prepareRuntimeSnapshotArtifacts(input, { components = DEFAULT_COMPONENTS } = {}) {
  const validated = validateInput(input);
  const implementation = validateComponents(components);
  const outputDirectory = path.join(validated.workspace, 'runtime-snapshot');
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const closures = validateClosures(await implementation.prepareClosures({
    workspace: outputDirectory,
    repoRoot: validated.repoRoot,
    daytonaPath: validated.daytonaPath,
    bundle: validated.bundle,
    bindings: validated.bindings,
    taskImages: validated.taskImages,
  }), outputDirectory);

  const contexts = {};
  const archives = [];
  for (const kind of CONTEXT_KINDS) {
    const credentialScanExemptions = Object.entries(closures.executables)
      .filter(([name, executable]) =>
        CREDENTIAL_SCAN_ATTESTED_BINARY_NAMES.includes(name) && executable.context === kind &&
        sameHash(executable.sha256, DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256[name]))
      .map(([name, executable]) => ({
        path: executable.sourcePath,
        sha256: DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256[name],
      }));
    const built = buildDeterministicUstar({
      kind,
      root: closures.roots[kind],
      credentialScanExemptions,
    });
    if (kind === DAYTONA_NODE_USTAR_ATTESTATION.kind &&
        sameHash(closures.executables.node.sha256,
          DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256.node)) {
      const expected = DAYTONA_NODE_USTAR_ATTESTATION;
      const exactEntries = built.context.entries.length === expected.entries.length &&
        built.context.entries.every((entry, index) => {
          const attested = expected.entries[index];
          return entry.path === attested.path && entry.type === attested.type &&
            entry.mode === attested.mode && entry.byteLength === attested.byteLength &&
            entry.sha256 === attested.sha256;
        });
      if (built.context.kind !== expected.kind || built.context.encoding !== 'ustar' ||
          built.context.sha256 !== expected.archiveSha256 ||
          built.context.byteLength !== expected.byteLength || !exactEntries) {
        fail('Node USTAR identity drifted from its code-owned pin');
      }
    }
    const archivePath = path.join(outputDirectory, `${kind}.tar`);
    try {
      writeExclusive(archivePath, built.bytes);
    } finally {
      built.bytes.fill(0);
    }
    contexts[kind] = built.context;
    archives.push({
      path: archivePath,
      sha256: built.context.sha256,
      kind,
      encoding: 'ustar',
    });
  }

  const dockerfileBytes = readRegular(closures.dockerfilePath, MAX_DOCKERFILE_BYTES, 'snapshot Dockerfile');
  const definitionBytes = readRegular(closures.definitionPath, MAX_DEFINITION_BYTES, 'runtime definition');
  let artifact;
  try {
    artifact = buildSnapshotBuildManifest({
      dockerfile: { byteLength: dockerfileBytes.length, sha256: sha256(dockerfileBytes) },
      definition: { byteLength: definitionBytes.length, sha256: sha256(definitionBytes) },
      contexts,
      executables: closures.executables,
      provenance: closures.provenance,
      bindings: validated.bindings,
      taskImages: validated.taskImages,
    });
  } finally {
    dockerfileBytes.fill(0);
    definitionBytes.fill(0);
  }
  const manifestPath = path.join(outputDirectory, 'build-manifest.json');
  const manifestBytes = Buffer.from(artifact.canonicalJson);
  try {
    if (!sameHash(sha256(manifestBytes), artifact.buildHash)) fail('snapshot build manifest identity drifted');
    writeExclusive(manifestPath, manifestBytes, 0o400);
  } finally {
    manifestBytes.fill(0);
  }
  archives.push({
    path: manifestPath,
    sha256: artifact.buildHash,
    kind: 'manifest',
    encoding: 'snapshot-manifest',
  });
  const identity = Object.freeze({ name: artifact.snapshotName, buildHash: artifact.buildHash });
  const receipt = validateReceipt(await implementation.ensureSnapshot({
    daytonaPath: validated.daytonaPath,
    identity,
    dockerfilePath: closures.dockerfilePath,
    archives: Object.freeze(archives.map((entry) => Object.freeze({ ...entry }))),
  }), identity);
  const executableHashes = Object.freeze(Object.fromEntries(
    Object.entries(closures.executables).map(([name, value]) => [name, value.sha256]),
  ));
  return Object.freeze({ identity, executableHashes, receipt });
}
