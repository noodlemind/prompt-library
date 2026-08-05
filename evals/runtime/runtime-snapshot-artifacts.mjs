import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { daytonaCliEnvironment } from './daytona-controller.mjs';
import { createDaytonaSnapshotController } from './daytona-snapshot-controller.mjs';
import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
  DAYTONA_EXECUTABLE_PATHS,
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
const DOCKER_HOST = 'unix:///var/run/docker.sock';

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
const NODE_ARCHIVE_SHA256 = 'cfb6ac0cf339825fe36efd1f18a79016b02aca19fbfa6c9547c57e27dc09f6ea';

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
  iptables: '/usr/sbin/iptables',
  ip6tables: '/usr/sbin/ip6tables',
  sentinel: '/bin/sleep',
});

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
    if (executable.path !== approvedPath || !CONTEXT_KINDS.includes(executable.context) ||
        typeof executable.sourcePath !== 'string' || executable.sourcePath.startsWith('/') ||
        path.posix.normalize(executable.sourcePath) !== executable.sourcePath || executable.sourcePath.includes('..')) {
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

function defaultRunDaytona(daytonaPath, args) {
  const timeout = args[0] === 'snapshot' && args[1] === 'create' ? 30 * 60_000 : 5 * 60_000;
  const result = spawnSync(daytonaPath, args, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    env: daytonaCliEnvironment(process.env),
    timeout,
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
    runCommand: async (args) => defaultRunDaytona(request.daytonaPath, args),
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

function runFixed(file, args, {
  cwd,
  env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  timeoutMs = 5 * 60_000,
  maximumBytes = MAX_COMMAND_BYTES,
} = {}) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 256 ||
      args.some((value) => typeof value !== 'string' || value.length < 1 || value.includes('\0') ||
        Buffer.byteLength(value) > 4096)) {
    fail('code-owned command arguments drifted', 'ERR_RUNTIME_SNAPSHOT_COMMAND');
  }
  return safeCommandResult(spawnSync(file, args, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: maximumBytes,
  }), path.basename(file), { maximumBytes });
}

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

export async function downloadPinnedSnapshotSource({ url, expectedSha256, destination }, {
  fetchImpl = fetch,
} = {}) {
  const expected = new URL(url);
  if (expected.protocol !== 'https:' || expected.username || expected.password || expected.hash) {
    fail('pinned source URL is invalid', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  const response = await fetchImpl(expected, { redirect: 'error' });
  if (!response || response.status !== 200 || response.url !== expected.href || !response.body) {
    fail('pinned source download failed closed', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  const declaredHeader = response.headers?.get?.('content-length');
  const declared = declaredHeader == null ? null : Number(declaredHeader);
  if (declaredHeader != null &&
      (!Number.isFinite(declared) || declared < 1 || declared > MAX_DOWNLOAD_BYTES)) {
    fail('pinned source download exceeds its byte bound', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
  const descriptor = fs.openSync(destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o400);
  const hash = crypto.createHash('sha256');
  let total = 0;
  try {
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) fail('pinned source download exceeds its byte bound', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(descriptor, chunk, offset, chunk.length - offset);
      chunk.fill(0);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (total < 1 || !sameHash(hash.digest('hex'), expectedSha256) ||
      !sameHash(hashRegularFile(destination, MAX_DOWNLOAD_BYTES, 'pinned source'), expectedSha256)) {
    fail('pinned source digest drifted', 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD');
  }
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
  return { nativeSource };
}

const WRAPPERS = Object.freeze({
  supervisor: `#!/usr/local/bin/node
import { runRemoteSupervisorCli } from '/opt/engineer/runtime/remote-supervisor.mjs';
try { await runRemoteSupervisorCli(); } catch { process.exitCode = 70; }
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
import { runSnapshotSelfTestCli } from '/opt/engineer/runtime/snapshot-selftest.mjs';
try { process.exitCode = await runSnapshotSelfTestCli(); } catch { process.exitCode = 70; }
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
  for (const reference of [DAYTONA_DIND_BASE_IMAGE, NATIVE_COMPILER_IMAGE, PYTHON_BUILDER_IMAGE, UV_BUILDER_IMAGE]) {
    runDocker(['pull', '--platform', 'linux/amd64', reference], { timeoutMs: 20 * 60_000 });
    const platform = runDocker([
      'image', 'inspect', '--platform', 'linux/amd64',
      '--format', '{{.Os}}/{{.Architecture}}', reference,
    ]);
    if (platform !== 'linux/amd64\n') fail('pinned builder image platform drifted', 'ERR_RUNTIME_SNAPSHOT_DOCKER');
  }
}

function removeBuilderContainer(runDocker, containerId) {
  runDocker(['rm', '-f', containerId]);
}

function withBuilderContainer(runDocker, createArgs, operation) {
  const rawId = runDocker(['create', ...createArgs]).trim();
  if (!/^[a-f0-9]{64}$/.test(rawId)) fail('Docker returned a malformed builder container identity');
  let primaryError;
  try {
    return operation(rawId);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      removeBuilderContainer(runDocker, rawId);
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

function materializeNode(bundle, nodeRoot) {
  const source = path.join(bundle.bundleDir, 'node-x64', 'bin', 'node');
  const destination = path.join(nodeRoot, ...DAYTONA_EXECUTABLE_PATHS.node.slice(1).split('/'));
  copyRegular(source, destination, 0o555);
  return destination;
}

function materializeHarborSource(harborRoot, downloaded) {
  const destination = path.join(harborRoot, 'opt', 'engineer', 'build', 'harbor-source.tar.gz');
  copyRegular(downloaded, destination, 0o444);
  return destination;
}

function executableInventory(roots) {
  const inventory = {};
  for (const [name, approvedPath] of Object.entries(DAYTONA_EXECUTABLE_PATHS)) {
    const context = name === 'node' ? 'node' : name === 'harbor' ? 'harbor'
      : ['cgroupExec', 'taskIsolationProbe', 'readinessDenialProbe'].includes(name) ? 'native' : 'runtime';
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
    'RUN addgroup -S -g 2001 engineer-runner && addgroup -S -g 2002 engineer-broker && addgroup -S -g 2003 engineer-client && adduser -S -D -H -u 2001 -G engineer-runner engineer-runner && adduser -S -D -H -u 2002 -G engineer-broker engineer-broker && addgroup engineer-runner engineer-client && mkdir -p /engineer-bounded/transport /engineer-bounded/work /engineer-bounded/evidence /engineer-bounded/broker /engineer-bounded/docker /engineer-bounded/.readiness-denial-mount /run/engineer && chown 2001:2001 /engineer-bounded/work && chown 2002:2002 /engineer-bounded/broker && chmod 0755 /engineer-bounded /engineer-bounded/transport /engineer-bounded/docker /run/engineer && chmod 0555 /engineer-bounded/.readiness-denial-mount && chmod 0700 /engineer-bounded/work /engineer-bounded/evidence /engineer-bounded/broker && chmod -R go-w /opt/engineer /usr/local/bin/node /usr/local/bin/docker /usr/local/bin/dockerd /usr/sbin/iptables /usr/sbin/ip6tables /usr/bin/sleep',
    'ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PYTHONDONTWRITEBYTECODE=1',
    'ENTRYPOINT ["/usr/local/bin/node","/opt/engineer/runtime/snapshot-manager.mjs"]',
    '',
  ].join('\n');
}

async function prepareCodeOwnedClosures({
  workspace,
  repoRoot,
  bundle,
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
  materializeNode(bundle, roots.node);

  const runDocker = createDockerRunner(workspace);
  pullExactImages(runDocker);
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
        platform: 'linux-x64',
        archiveSha256: NODE_ARCHIVE_SHA256,
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
    const built = buildDeterministicUstar({ kind, root: closures.roots[kind] });
    const archivePath = path.join(outputDirectory, `${kind}.tar`);
    try {
      writeExclusive(archivePath, built.bytes);
    } finally {
      built.bytes.fill(0);
    }
    contexts[kind] = built.context;
    archives.push({ path: archivePath, sha256: built.context.sha256 });
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
  archives.push({ path: manifestPath, sha256: artifact.buildHash });
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
