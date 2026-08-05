import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  prepareHarnessBundle,
  validatePrebuiltBundle,
} from '../external/terminal_bench/provision.mjs';
import {
  buildDaytonaTopologyManifest,
  projectDaytonaReleaseRuntime,
} from './daytona-topology.mjs';
import { canonicalSha256 } from './protocol.mjs';

const INPUT_FIELDS = Object.freeze([
  'repoRoot',
  'releaseSha',
  'sourceIdentity',
  'taskLock',
  'taskLockHash',
  'budgetPolicyHash',
  'brokerPolicyHash',
  'profileId',
  'sessionCeilingMicrousd',
]);
const SANDBOX_RUNTIME_FIELDS = Object.freeze([
  'immutableImage', 'imageId', 'platform', 'cpus', 'memoryMb', 'storageMb',
]);
const HASH = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;
const OWNER_MARKER = '.engineer-release-artifacts-owner';
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

const NODE_RUNTIME = Object.freeze({
  version: 'v22.17.1',
  url: 'https://nodejs.org/dist/v22.17.1/node-v22.17.1-linux-x64.tar.gz',
  sha256: 'cfb6ac0cf339825fe36efd1f18a79016b02aca19fbfa6c9547c57e27dc09f6ea',
});

const DAYTONA_CANDIDATES = Object.freeze({
  'darwin-arm64': Object.freeze([{
    path: '/opt/homebrew/bin/daytona',
    sha256: '5f6f6fc8668419064df5b35bd7b482ac895fdf39ad32068998a4e12bb718da47',
  }]),
});

export class ReleaseArtifactError extends Error {
  constructor(message, code = 'ERR_RELEASE_ARTIFACT') {
    super(message);
    this.name = 'ReleaseArtifactError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_RELEASE_ARTIFACT_CONFIG') {
  throw new ReleaseArtifactError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const allowed = new Set(fields);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    fail(`${label} contains an unexpected or missing field`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function absolute(value, label) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value) ||
      path.normalize(value) !== value) fail(`${label} must be an absolute normalized path`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a SHA-256 digest`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} must be a safe identifier`);
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function sameHash(left, right) {
  if (!HASH.test(String(left)) || !HASH.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function assertRegularFileHash(file, expectedHash, maximumBytes = MAX_DOWNLOAD_BYTES) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumBytes) {
    fail('artifact must be a bounded regular file', 'ERR_RELEASE_ARTIFACT_FILE');
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      fail('artifact identity changed before hashing', 'ERR_RELEASE_ARTIFACT_FILE');
    }
    const observed = crypto.createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex');
    const after = fs.fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || !sameHash(observed, expectedHash)) {
      fail('artifact digest or identity drifted', 'ERR_RELEASE_ARTIFACT_DIGEST');
    }
    return observed;
  } finally {
    fs.closeSync(descriptor);
  }
}

async function downloadPinnedFile({ url, sha256, destination, fetchImpl = fetch }) {
  if (typeof fetchImpl !== 'function') fail('pinned download transport is unavailable');
  const expected = new URL(url);
  if (expected.protocol !== 'https:' || expected.username || expected.password || expected.hash) {
    fail('pinned download URL is invalid');
  }
  const response = await fetchImpl(expected, { redirect: 'error' });
  if (!response || response.status !== 200 || response.url !== expected.href || !response.body) {
    fail('pinned download failed closed', 'ERR_RELEASE_ARTIFACT_DOWNLOAD');
  }
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && (declaredLength < 1 || declaredLength > MAX_DOWNLOAD_BYTES)) {
    fail('pinned download exceeds its byte bound', 'ERR_RELEASE_ARTIFACT_DOWNLOAD');
  }
  const handle = fs.openSync(destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o600);
  const hash = crypto.createHash('sha256');
  let total = 0;
  try {
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) fail('pinned download exceeds its byte bound', 'ERR_RELEASE_ARTIFACT_DOWNLOAD');
      hash.update(chunk);
      fs.writeSync(handle, chunk);
      chunk.fill(0);
    }
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  if (total < 1 || !sameHash(hash.digest('hex'), sha256)) {
    fail('pinned download digest drifted', 'ERR_RELEASE_ARTIFACT_DIGEST');
  }
  assertRegularFileHash(destination, sha256);
  return destination;
}

function makeOwnedWorkspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engineer-release-artifacts-'));
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync.native(directory);
}

function claimWorkspace(directory) {
  absolute(directory, 'artifact workspace');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      fs.readdirSync(directory).length !== 0) {
    fail('artifact workspace must be a fresh owner-only directory', 'ERR_RELEASE_ARTIFACT_WORKSPACE');
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(directory, OWNER_MARKER), `${nonce}\n`, { flag: 'wx', mode: 0o600 });
  return nonce;
}

function removeOwnedWorkspace(directory, nonce) {
  const marker = path.join(directory, OWNER_MARKER);
  let observed;
  try {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    observed = fs.readFileSync(marker, 'utf8');
  } catch {
    return false;
  }
  if (observed !== `${nonce}\n`) return false;
  fs.rmSync(directory, { recursive: true, force: false });
  return true;
}

function resolvePinnedDaytonaExecutable() {
  const candidates = DAYTONA_CANDIDATES[`${process.platform}-${process.arch}`] ?? [];
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync.native(candidate.path);
      assertRegularFileHash(real, candidate.sha256, 256 * 1024 * 1024);
      return real;
    } catch {
      // Try the next code-owned candidate; never consult PATH or an operator path.
    }
  }
  fail('the pinned Daytona v0.203.0 executable is unavailable', 'ERR_RELEASE_ARTIFACT_DAYTONA');
}

async function prepareCodeOwnedBundle({ bundleDir, workspace, repoRoot, sourceIdentity }) {
  const nodeArchive = path.join(workspace, 'node-v22.17.1-linux-x64.tar.gz');
  await downloadPinnedFile({
    url: NODE_RUNTIME.url,
    sha256: NODE_RUNTIME.sha256,
    destination: nodeArchive,
  });
  try {
    return prepareHarnessBundle({
      bundleDir,
      repoRoot,
      sourceIdentity,
      nodeTarballs: { x64: nodeArchive },
      nodeTarballHashes: { x64: NODE_RUNTIME.sha256 },
      ambientEnv: {},
    });
  } finally {
    fs.rmSync(nodeArchive, { force: true });
  }
}

async function prepareCodeOwnedRuntimeSnapshot(request) {
  const { prepareRuntimeSnapshotArtifacts } = await import('./runtime-snapshot-artifacts.mjs');
  return prepareRuntimeSnapshotArtifacts(request);
}

const DEFAULT_COMPONENTS = Object.freeze({
  makeWorkspace: makeOwnedWorkspace,
  resolveDaytonaPath: resolvePinnedDaytonaExecutable,
  prepareBundle: prepareCodeOwnedBundle,
  validateBundle: validatePrebuiltBundle,
  prepareRuntimeSnapshot: prepareCodeOwnedRuntimeSnapshot,
});

function validateComponents(components) {
  if (!plainObject(components)) fail('artifact components must be a plain object');
  exactKeys(components, Object.keys(DEFAULT_COMPONENTS), 'artifact components');
  for (const [name, implementation] of Object.entries(components)) {
    if (typeof implementation !== 'function') fail(`${name} must be a function`);
  }
  return components;
}

function runtimeSandbox(sandbox, task) {
  exactKeys(sandbox, SANDBOX_RUNTIME_FIELDS, `task ${task} sandbox`);
  if (typeof sandbox.immutableImage !== 'string' || !IMMUTABLE_IMAGE.test(sandbox.immutableImage) ||
      typeof sandbox.imageId !== 'string' || !IMAGE_ID.test(sandbox.imageId) ||
      !sandbox.immutableImage.endsWith(`@${sandbox.imageId}`)) {
    fail(`task ${task} must use one matching immutable image identity`);
  }
  if (sandbox.platform !== 'linux/amd64') fail(`task ${task} must target linux/amd64`);
  boundedInteger(sandbox.cpus, `task ${task} cpus`, 1, 2);
  boundedInteger(sandbox.memoryMb, `task ${task} memoryMb`, 256, 4096);
  boundedInteger(sandbox.storageMb, `task ${task} storageMb`, 256, 10240);
  return Object.fromEntries(SANDBOX_RUNTIME_FIELDS.map((field) => [field, sandbox[field]]));
}

export function projectRuntimeTaskLock(taskLock) {
  if (!plainObject(taskLock) || !Array.isArray(taskLock.tasks) || taskLock.tasks.length < 1 ||
      taskLock.tasks.length > 64) fail('task lock must contain 1-64 tasks');
  const seen = new Set();
  const tasks = taskLock.tasks.map((entry) => {
    if (!plainObject(entry)) fail('task lock contains a malformed task');
    const task = safeId(entry.task, 'task name');
    if (seen.has(task)) fail(`task lock contains duplicate task ${task}`);
    seen.add(task);
    return { task, sandbox: runtimeSandbox(entry.sandbox, task) };
  });
  return deepFreeze({ tasks });
}

function validateInput(input) {
  exactKeys(input, INPUT_FIELDS, 'release artifact input');
  absolute(input.repoRoot, 'repoRoot');
  if (typeof input.releaseSha !== 'string' || !RELEASE_SHA.test(input.releaseSha)) {
    fail('releaseSha must be a full lowercase release identity');
  }
  exactKeys(input.sourceIdentity, ['releaseSha', 'harnessVersion'], 'source identity');
  if (input.sourceIdentity.releaseSha !== input.releaseSha ||
      typeof input.sourceIdentity.harnessVersion !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.sourceIdentity.harnessVersion)) {
    fail('source identity drifted from the release');
  }
  digest(input.taskLockHash, 'taskLockHash');
  const observedTaskLockHash = canonicalSha256(input.taskLock);
  if (!sameHash(observedTaskLockHash, input.taskLockHash)) fail('task lock hash drifted');
  digest(input.budgetPolicyHash, 'budgetPolicyHash');
  digest(input.brokerPolicyHash, 'brokerPolicyHash');
  safeId(input.profileId, 'profileId');
  boundedInteger(input.sessionCeilingMicrousd, 'sessionCeilingMicrousd', 1, 20_000_000);
  const projectedTaskLock = projectRuntimeTaskLock(input.taskLock);
  const taskImages = Object.fromEntries(projectedTaskLock.tasks.map(({ task, sandbox }) => [task, sandbox]));
  return deepFreeze({ ...input, projectedTaskLock, taskImages });
}

function validatePreparedBundle(prepared, validated, expectedDirectory) {
  if (!plainObject(prepared) || !plainObject(validated)) fail('bundle preparation or attestation failed');
  digest(prepared.manifestHash, 'prepared bundle manifestHash');
  digest(validated.manifestHash, 'validated bundle manifestHash');
  if (prepared.bundleDir !== expectedDirectory || validated.bundleDir !== expectedDirectory ||
      !sameHash(prepared.manifestHash, validated.manifestHash)) {
    fail('bundle path or attestation drifted', 'ERR_RELEASE_ARTIFACT_BUNDLE');
  }
  return deepFreeze({ bundleDir: expectedDirectory, manifestHash: prepared.manifestHash });
}

function validateSnapshotArtifact(value) {
  if (!plainObject(value)) fail('runtime snapshot artifact is malformed');
  exactKeys(value, ['identity', 'executableHashes', 'receipt'], 'runtime snapshot artifact');
  exactKeys(value.identity, ['name', 'buildHash'], 'runtime snapshot identity');
  digest(value.identity.buildHash, 'runtime snapshot buildHash');
  if (value.identity.name !== `engineer-eval-${value.identity.buildHash.slice(0, 32)}`) {
    fail('runtime snapshot name drifted from its content identity');
  }
  if (!plainObject(value.receipt) ||
      value.receipt.schema !== 'engineer-daytona-snapshot-lifecycle-receipt.v1' ||
      value.receipt.name !== value.identity.name || value.receipt.buildHash !== value.identity.buildHash ||
      value.receipt.status !== 'active' || value.receipt.retained !== true) {
    fail('runtime snapshot receipt does not prove an active retained snapshot');
  }
  if (!plainObject(value.executableHashes)) fail('runtime executable inventory is missing');
  for (const [name, observed] of Object.entries(value.executableHashes)) digest(observed, `${name} executable hash`);
  return value;
}

/**
 * Prepare the release bundle and content-addressed Daytona snapshot without
 * accepting operator-selected runtime paths. Tests may inject the complete
 * component set; the production CLI always uses the code-owned defaults.
 */
export async function prepareReleaseRuntimeArtifacts(input, { components = DEFAULT_COMPONENTS } = {}) {
  const validated = validateInput(input);
  const implementation = validateComponents(components);
  const workspace = absolute(implementation.makeWorkspace(), 'artifact workspace');
  const ownerNonce = claimWorkspace(workspace);
  let handedOff = false;
  try {
    const daytonaPath = absolute(implementation.resolveDaytonaPath(), 'Daytona executable');
    const bundleDir = path.join(workspace, 'bundle');
    const prepared = await implementation.prepareBundle({
      bundleDir,
      workspace,
      repoRoot: validated.repoRoot,
      sourceIdentity: validated.sourceIdentity,
    });
    const attested = implementation.validateBundle(bundleDir, {
      expectedManifestHash: prepared?.manifestHash,
      expectedSourceIdentity: validated.sourceIdentity,
      repoRoot: validated.repoRoot,
    });
    const bundle = validatePreparedBundle(prepared, attested, bundleDir);
    const bindings = deepFreeze({
      releaseSha: validated.releaseSha,
      taskLockHash: validated.taskLockHash,
      bundleHash: bundle.manifestHash,
      budgetPolicyHash: validated.budgetPolicyHash,
      brokerPolicyHash: validated.brokerPolicyHash,
      profileId: validated.profileId,
      sessionCeilingMicrousd: validated.sessionCeilingMicrousd,
    });
    const snapshot = validateSnapshotArtifact(await implementation.prepareRuntimeSnapshot({
      workspace,
      repoRoot: validated.repoRoot,
      daytonaPath,
      bundle,
      bindings,
      taskImages: validated.taskImages,
    }));
    const topology = buildDaytonaTopologyManifest({
      releaseSha: bindings.releaseSha,
      taskLockHash: bindings.taskLockHash,
      bundleHash: bindings.bundleHash,
      budgetPolicyHash: bindings.budgetPolicyHash,
      brokerPolicyHash: bindings.brokerPolicyHash,
      profileId: bindings.profileId,
      sessionCeilingMicrousd: bindings.sessionCeilingMicrousd,
      snapshotIdentity: snapshot.identity,
      taskImages: validated.taskImages,
      executableHashes: snapshot.executableHashes,
    });
    const runtimeProjection = projectDaytonaReleaseRuntime(topology.manifest);
    let disposed = false;
    const dispose = async () => {
      if (disposed) fail('release artifacts are one-shot and already disposed', 'ERR_RELEASE_ARTIFACT_DISPOSED');
      disposed = true;
      if (!removeOwnedWorkspace(workspace, ownerNonce)) {
        fail('release artifact cleanup custody could not be proven', 'ERR_RELEASE_ARTIFACT_CLEANUP');
      }
    };
    handedOff = true;
    return Object.freeze({ bundle, runtimeProjection, daytonaPath, dispose });
  } finally {
    if (!handedOff && !removeOwnedWorkspace(workspace, ownerNonce)) {
      fail('release artifact failure cleanup could not be proven', 'ERR_RELEASE_ARTIFACT_CLEANUP');
    }
  }
}
