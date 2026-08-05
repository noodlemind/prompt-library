/**
 * Production builder for the private, offline Terminal-Bench release dataset.
 *
 * All network inputs are code-owned and digest-pinned. Network access is used
 * only while constructing the artifact; each derived verifier contains its
 * own immutable Python closure and therefore performs no resolution at trial
 * time. The resulting directory name is the SHA-256 of its canonical
 * attestation and is suitable for passing directly to Harbor with `--path`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DERIVED_MANIFEST_FILENAME,
  OFFLINE_RUNTIME_SCHEMA,
  buildOfflineTerminalBenchDerivative,
} from './offline-derivative.mjs';
import { hashTree } from './verifier.mjs';
import { validateTaskLock } from './harbor-adapter.mjs';

export const OFFLINE_DATASET_ATTESTATION = 'engineer-terminal-bench-offline-dataset-attestation.v1';
export const OFFLINE_DATASET_LOCK = 'engineer-terminal-bench-offline-task-lock.v1';
export const OFFLINE_ATTESTATION_FILENAME = 'offline-dataset-attestation.json';
export const OFFLINE_TASK_LOCK_FILENAME = 'offline-task-lock.json';

const REQUIRED_TASKS = Object.freeze([
  'cobol-modernization',
  'cancel-async-tasks',
  'git-leak-recovery',
  'custom-memory-heap-crash',
]);
const REQUIREMENTS_RELATIVE = 'evals/external/terminal_bench';
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const OWNER_MARKER = '.engineer-offline-artifact-owner';

const GCC_BUILDER_IMAGE =
  'gcc:14.2.0-bookworm@sha256:82549aa8f90ada3236a8be70c74543132a76662ef33f0c3271ed802b81584a82';

export const PINNED_OFFLINE_INPUTS = Object.freeze({
  source: Object.freeze({
    kind: 'terminal-bench-source',
    commit: '53ff2b87d621bdb97b455671f2bd9728b7d86c11',
    url: 'https://codeload.github.com/harbor-framework/terminal-bench-2/tar.gz/53ff2b87d621bdb97b455671f2bd9728b7d86c11',
    sha256: '4d46ed1b5a2dde59377de1714d535568ecc9b4692f81a15a6bab039bd3abc5c9',
  }),
  python: Object.freeze({
    kind: 'python-build-standalone',
    version: '3.13.5',
    build: '20250723',
    platform: 'linux/amd64',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20250723/cpython-3.13.5%2B20250723-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',
    sha256: 'f7ac16748be2674ec14df532a3e48d0c6f215017b537f14ca3feb837dbe86292',
  }),
  requirements: Object.freeze({
    inputSha256: '72eb7ad9565d88c776b28e42da7abf48bd92e32d81ae1160f0f1cb3a526a1060',
    lockSha256: '9d24f5bf46abd2288f1d4464012eeaf1e2124e538d0bfd67c863d521574f9bf1',
    pytest: '8.4.1',
    'pytest-json-ctrf': '0.3.5',
  }),
  builder: Object.freeze({ image: GCC_BUILDER_IMAGE, platform: 'linux/amd64' }),
  expected: Object.freeze({
    runtimeTreeHash: '4c2c4b65ffdd548cc733982a08601add96e532f657801d9d8b13b07f431e470e',
    taskLockHash: 'eebd5217b1831cbe869c0e7ddf75e696ccd662deaff17f61ed62042a27c9181d',
    artifactId: '8c05bb07e04843f3bc570ad84da17ee826817cb106f1aaee7b5442730a73b368',
    datasetTreeHash: 'c5e6b78bfbb2f91b4538e7531d106705b3538ebe599db1e58d6f5251e63be875',
  }),
});

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

export class OfflineArtifactError extends Error {
  constructor(message, code = 'ERR_TB_OFFLINE_ARTIFACT') {
    super(message);
    this.name = 'OfflineArtifactError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_TB_OFFLINE_ARTIFACT') {
  throw new OfflineArtifactError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function canonicalJson(value, depth = 0, nodes = { count: 0 }) {
  nodes.count += 1;
  if (depth > 64 || nodes.count > 100_000) fail('canonical artifact metadata exceeds structural bounds');
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1, nodes)).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, nodes)}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))) {
    return JSON.stringify(value);
  }
  fail('canonical artifact metadata contains an unsupported value');
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sameHash(left, right) {
  return HASH.test(String(left)) && HASH.test(String(right)) &&
    crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function absolute(value, label) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label} must be an absolute normalized path`, 'ERR_TB_OFFLINE_PATH');
  }
  return value;
}

function readRegular(file, maximumBytes, label) {
  const named = fs.lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink() || named.size < 1 || named.size > maximumBytes) {
    fail(`${label} must be a bounded regular file`, 'ERR_TB_OFFLINE_FILE');
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino ||
        before.size !== named.size || before.mtimeMs !== named.mtimeMs) {
      fail(`${label} identity changed before reading`, 'ERR_TB_OFFLINE_FILE');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs) {
      bytes.fill(0);
      fail(`${label} changed while reading`, 'ERR_TB_OFFLINE_FILE');
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertRegularHash(file, expected, label, maximumBytes = MAX_ARCHIVE_BYTES) {
  const bytes = readRegular(file, maximumBytes, label);
  const observed = sha256(bytes);
  bytes.fill(0);
  if (!sameHash(observed, expected)) fail(`${label} digest drifted`, 'ERR_TB_OFFLINE_DIGEST');
  return observed;
}

function writeExclusive(file, bytes, mode = 0o600) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode });
}

async function defaultDownloadPinned({ artifact, destination }) {
  const expected = new URL(artifact.url);
  if (expected.protocol !== 'https:' || expected.username || expected.password || expected.hash) {
    fail('pinned archive URL is invalid', 'ERR_TB_OFFLINE_NETWORK');
  }
  const response = await fetch(expected, { redirect: artifact.kind === 'python-build-standalone' ? 'follow' : 'error' });
  const finalUrl = new URL(response.url);
  if (response.status !== 200 || !response.ok || finalUrl.protocol !== 'https:' ||
      (artifact.kind === 'terminal-bench-source' && response.url !== expected.href)) {
    fail(`pinned ${artifact.kind} download failed closed`, 'ERR_TB_OFFLINE_NETWORK');
  }
  const declaredHeader = response.headers.get('content-length');
  const declared = declaredHeader == null ? null : Number(declaredHeader);
  if (declaredHeader != null && (!Number.isFinite(declared) || declared < 1 || declared > MAX_ARCHIVE_BYTES)) {
    fail(`pinned ${artifact.kind} download exceeds its byte bound`, 'ERR_TB_OFFLINE_NETWORK');
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    fail(`pinned ${artifact.kind} download has no bounded stream`, 'ERR_TB_OFFLINE_NETWORK');
  }
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const digest = crypto.createHash('sha256');
  let total = 0;
  try {
    for await (const raw of response.body) {
      const chunk = Buffer.from(raw);
      total += chunk.length;
      if (total > MAX_ARCHIVE_BYTES) {
        chunk.fill(0);
        fail(`pinned ${artifact.kind} download exceeds its byte bound`, 'ERR_TB_OFFLINE_NETWORK');
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(descriptor, chunk, offset, chunk.length - offset);
      chunk.fill(0);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (total < 1 || !sameHash(digest.digest('hex'), artifact.sha256)) {
    fail(`pinned ${artifact.kind} download digest drifted`, 'ERR_TB_OFFLINE_DIGEST');
  }
}

function resolvePinnedDocker() {
  for (const candidate of DOCKER_CANDIDATES[`${process.platform}-${process.arch}`] ?? []) {
    try {
      const real = fs.realpathSync.native(candidate.path);
      assertRegularHash(real, candidate.sha256, 'Docker executable');
      if ((fs.lstatSync(real).mode & 0o022) === 0) return real;
    } catch {
      // Try the next code-owned path; never consult PATH.
    }
  }
  fail('pinned Docker executable is unavailable', 'ERR_TB_OFFLINE_BUILDER');
}

const BUILD_SCRIPT = String.raw`set -eu
umask 077
test "$(sha256sum /work/terminal-bench.tar.gz | cut -d ' ' -f 1)" = "$SOURCE_SHA256"
test "$(sha256sum /work/python.tar.gz | cut -d ' ' -f 1)" = "$PYTHON_SHA256"
test "$(sha256sum /work/requirements.txt | cut -d ' ' -f 1)" = "$REQUIREMENTS_SHA256"
mkdir /work/source-extracted /work/runtime-build
tar --no-same-owner --same-permissions -xzf /work/terminal-bench.tar.gz -C /work/source-extracted
tar --no-same-owner --same-permissions -xzf /work/python.tar.gz -C /work/runtime-build
test -x /work/runtime-build/python/bin/python3
/work/runtime-build/python/bin/python3 -m pip install \
  --require-hashes --only-binary=:all: --no-compile --no-cache-dir \
  --disable-pip-version-check --target /work/runtime-build/python/lib/python3.13/site-packages \
  -r /work/requirements.txt
find /work/runtime-build/python -type d -name __pycache__ -prune -exec rm -rf '{}' ';'
find /work/runtime-build/python -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
test -d "/work/source-extracted/terminal-bench-2-$SOURCE_COMMIT"
`;

function defaultMaterializePinnedInputs({ workspace, pins }) {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const relation = path.relative(temporaryRoot, workspace);
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation) ||
      workspace.includes(',') || workspace.includes(':') || /[\0\r\n]/.test(workspace)) {
    fail('offline builder workspace is not safe to mount', 'ERR_TB_OFFLINE_BUILDER');
  }
  const docker = resolvePinnedDocker();
  const dockerHome = path.join(workspace, 'docker-home');
  const dockerConfig = path.join(dockerHome, 'config');
  fs.mkdirSync(dockerConfig, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dockerConfig, 'config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  const result = spawnSync(docker, [
    'run', '--rm', '--platform', pins.builder.platform,
    '--network', 'bridge',
    '--mount', `type=bind,src=${workspace},dst=/work`,
    '--env', `SOURCE_SHA256=${pins.source.sha256}`,
    '--env', `PYTHON_SHA256=${pins.python.sha256}`,
    '--env', `REQUIREMENTS_SHA256=${pins.requirements.lockSha256}`,
    '--env', `SOURCE_COMMIT=${pins.source.commit}`,
    '--entrypoint', '/bin/sh',
    pins.builder.image,
    '-ceu', BUILD_SCRIPT,
  ], {
    encoding: 'utf8',
    env: {
      HOME: dockerHome,
      DOCKER_CONFIG: dockerConfig,
      PATH: '/usr/bin:/bin',
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    fail(`pinned offline builder failed: ${result.error?.code ?? result.status ?? 'spawn'}`, 'ERR_TB_OFFLINE_BUILDER');
  }
  return {
    sourceRoot: path.join(workspace, 'source-extracted', `terminal-bench-2-${pins.source.commit}`),
    runtimeSourceDir: path.join(workspace, 'runtime-build', 'python'),
  };
}

function normalizeRuntimeTree(sourceRoot, destinationRoot) {
  const source = fs.realpathSync.native(sourceRoot);
  if (!fs.lstatSync(source).isDirectory()) fail('runtime source must be a directory', 'ERR_TB_OFFLINE_RUNTIME');
  fs.mkdirSync(destinationRoot, { recursive: false, mode: 0o700 });
  const visit = (current, relative) => {
    const named = fs.lstatSync(current);
    if (named.isDirectory()) {
      if (relative) {
        const target = path.join(destinationRoot, ...relative.split('/'));
        fs.mkdirSync(target, { mode: 0o755 });
        fs.chmodSync(target, 0o755);
      }
      for (const name of fs.readdirSync(current).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
        visit(path.join(current, name), path.posix.join(relative, name));
      }
      return;
    }
    let resolved = current;
    if (named.isSymbolicLink()) {
      resolved = fs.realpathSync.native(current);
      const relation = path.relative(source, resolved);
      if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
        fail(`runtime link escapes its closure: ${relative}`, 'ERR_TB_OFFLINE_RUNTIME');
      }
    }
    const actual = fs.lstatSync(resolved);
    if (!actual.isFile()) fail(`runtime contains an unsupported node: ${relative}`, 'ERR_TB_OFFLINE_RUNTIME');
    const target = path.join(destinationRoot, ...relative.split('/'));
    fs.copyFileSync(resolved, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, (actual.mode & 0o111) === 0 ? 0o444 : 0o555);
    if (fs.lstatSync(target).nlink !== 1) fail(`runtime hardlink normalization failed: ${relative}`, 'ERR_TB_OFFLINE_RUNTIME');
  };
  for (const name of fs.readdirSync(source).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    visit(path.join(source, name), name);
  }
  // Directory write permission is retained only in this runner-owned staging
  // closure because the derivative copier must populate descendants. The
  // published content-addressed artifact is recursively sealed read-only.
  fs.chmodSync(destinationRoot, 0o755);
  return destinationRoot;
}

function makeRuntimeManifest(runtimeDir) {
  return {
    schema: OFFLINE_RUNTIME_SCHEMA,
    platform: 'linux/amd64',
    immutable: true,
    python: { executable: 'bin/python3', version: '3.13' },
    packages: { pytest: '8.4.1', 'pytest-json-ctrf': '0.3.5' },
    treeHash: hashTree(runtimeDir),
  };
}

function validateInput({ repoRoot, outputRoot, taskLock }) {
  absolute(repoRoot, 'repoRoot');
  absolute(outputRoot, 'outputRoot');
  const verdict = validateTaskLock(taskLock);
  if (!verdict.ok) fail(`source task lock is invalid: ${verdict.errors.join('; ')}`, 'ERR_TB_OFFLINE_LOCK');
  const names = taskLock.tasks.map(({ task }) => task);
  if (names.length !== REQUIRED_TASKS.length || names.some((name, index) => name !== REQUIRED_TASKS[index])) {
    fail('source task lock must contain the exact four release tasks in release order', 'ERR_TB_OFFLINE_LOCK');
  }
  if (!fs.lstatSync(repoRoot).isDirectory()) fail('repoRoot must be a directory', 'ERR_TB_OFFLINE_PATH');
  if (fs.existsSync(outputRoot) && !fs.lstatSync(outputRoot).isDirectory()) fail('outputRoot must be a directory', 'ERR_TB_OFFLINE_PATH');
  return { repoRoot, outputRoot, taskLock: structuredClone(taskLock) };
}

function assertRequirements(repoRoot, pins) {
  const root = path.join(repoRoot, REQUIREMENTS_RELATIVE);
  const input = path.join(root, 'offline-verifier-requirements.in');
  const lock = path.join(root, 'offline-verifier-requirements.txt');
  assertRegularHash(input, pins.requirements.inputSha256, 'requirements input', 1024 * 1024);
  assertRegularHash(lock, pins.requirements.lockSha256, 'requirements lock', 4 * 1024 * 1024);
  const lockText = fs.readFileSync(lock, 'utf8');
  for (const [name, version] of [['pytest', '8.4.1'], ['pytest-json-ctrf', '0.3.5']]) {
    const matches = [...lockText.matchAll(new RegExp(`^${name.replace('-', '[-_]')}==([^ \\\\n]+)`, 'gmi'))];
    if (matches.length !== 1 || matches[0][1] !== version) fail(`requirements lock drifted for ${name}`, 'ERR_TB_OFFLINE_LOCK');
  }
  if (lockText.split('\n').filter((line) => /^(?:[A-Za-z0-9_.-]+)==/.test(line)).some((line) => !line.includes('=='))) {
    fail('requirements lock contains an unpinned distribution', 'ERR_TB_OFFLINE_LOCK');
  }
  return { input, lock };
}

function makeOwnedWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'engineer-offline-dataset-'));
  fs.chmodSync(workspace, 0o700);
  const nonce = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(workspace, OWNER_MARKER), `${nonce}\n`, { flag: 'wx', mode: 0o600 });
  return { workspace: fs.realpathSync.native(workspace), nonce };
}

function disposeOwnedWorkspace(workspace, nonce) {
  try {
    const marker = path.join(workspace, OWNER_MARKER);
    if (fs.readFileSync(marker, 'utf8') !== `${nonce}\n`) return false;
    makeWritableForRemoval(workspace);
    fs.rmSync(workspace, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function makeReadOnly(root) {
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('published artifact contains an unsupported node');
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) visit(path.join(current, name));
    fs.chmodSync(current, stat.isDirectory() || (stat.mode & 0o111) !== 0 ? 0o555 : 0o444);
  };
  visit(root);
}

function parseCanonicalFile(file, label) {
  const bytes = readRegular(file, 4 * 1024 * 1024, label);
  const text = bytes.toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { fail(`${label} is not JSON`); }
  if (canonicalJson(value) !== text) fail(`${label} is not canonical JSON`);
  return { value, text };
}

export function verifyOfflineTerminalBenchDataset({ artifactDir, expectedPins = PINNED_OFFLINE_INPUTS }) {
  absolute(artifactDir, 'artifactDir');
  const artifactId = path.basename(artifactDir);
  if (!HASH.test(artifactId)) fail('offline artifact directory is not content-addressed');
  if (expectedPins.expected != null && artifactId !== expectedPins.expected.artifactId) {
    fail('offline artifact identity drifted from the code-owned expected output');
  }
  const attested = parseCanonicalFile(path.join(artifactDir, OFFLINE_ATTESTATION_FILENAME), 'offline attestation');
  if (sha256(attested.text) !== artifactId) fail('offline artifact content address drifted');
  const lock = parseCanonicalFile(path.join(artifactDir, OFFLINE_TASK_LOCK_FILENAME), 'offline task lock');
  const attestation = attested.value;
  if (attestation.schema !== OFFLINE_DATASET_ATTESTATION || attestation.label !== 'private-terminal-bench-derived-offline' ||
      attestation.publicLeaderboardEligible !== false || attestation.networkRequiredAtTrial !== false ||
      attestation.taskLock?.schema !== OFFLINE_DATASET_LOCK || sha256(lock.text) !== attestation.taskLock.sha256) {
    fail('offline dataset trust labels or lock identity drifted');
  }
  if (canonicalJson(attestation.source) !== canonicalJson(expectedPins.source) ||
      canonicalJson(attestation.python) !== canonicalJson(expectedPins.python) ||
      canonicalJson(attestation.requirements) !== canonicalJson(expectedPins.requirements) ||
      canonicalJson(attestation.builder) !== canonicalJson(expectedPins.builder)) {
    fail('offline dataset code-owned input identity drifted');
  }
  const lockVerdict = validateTaskLock(lock.value);
  if (!lockVerdict.ok) fail(`offline task lock is invalid: ${lockVerdict.errors.join('; ')}`);
  const datasetDir = path.join(artifactDir, 'dataset');
  if (expectedPins.expected != null && (
    attestation.runtime?.treeHash !== expectedPins.expected.runtimeTreeHash ||
    attestation.taskLock?.sha256 !== expectedPins.expected.taskLockHash ||
    hashTree(datasetDir) !== expectedPins.expected.datasetTreeHash
  )) {
    fail('offline artifact runtime, task lock, or dataset tree drifted from the code-owned expected output');
  }
  const expected = new Set(REQUIRED_TASKS);
  const actual = fs.readdirSync(datasetDir);
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) fail('offline dataset task inventory drifted');
  if (!Array.isArray(attestation.tasks) || attestation.tasks.length !== REQUIRED_TASKS.length ||
      attestation.tasks.some((record, index) => record?.task !== REQUIRED_TASKS[index]) ||
      lock.value.datasetRef !== `terminal-bench-derived-offline@${expectedPins.source.commit.slice(0, 12)}`) {
    fail('offline dataset attested task order or dataset identity drifted');
  }
  for (const record of attestation.tasks) {
    const locked = lock.value.tasks.find(({ task }) => task === record.task);
    if (!locked || locked.taskChecksum !== record.derivedChecksum || hashTree(path.join(datasetDir, record.task)) !== record.derivedChecksum) {
      fail(`offline dataset checksum drifted for ${record.task}`);
    }
    const manifest = parseCanonicalFile(
      path.join(datasetDir, record.task, DERIVED_MANIFEST_FILENAME),
      `offline derivative manifest for ${record.task}`,
    );
    if (manifest.value.label !== 'terminal-bench-derived-offline' || manifest.value.publicLeaderboardEligible !== false ||
        manifest.value.networkRequired !== false || sha256(manifest.text) !== record.derivativeManifestSha256 ||
        manifest.value.assertions?.inventoryHash !== record.assertionInventoryHash ||
        manifest.value.runtimeTreeHash !== attestation.runtime?.treeHash ||
        manifest.value.runtime?.treeHash !== attestation.runtime?.manifest?.treeHash) {
      fail(`offline derivative attestation drifted for ${record.task}`);
    }
  }
  return { ok: true, artifactId, artifactDir, datasetDir, attestation, taskLock: lock.value };
}

/**
 * Build the production artifact. The second argument is an explicit test seam;
 * release code calls this function with one argument and therefore always uses
 * the pinned downloader and pinned linux/amd64 builder above.
 */
export async function buildOfflineTerminalBenchDataset(input, dependencies = {}) {
  const validated = validateInput(input);
  const pins = dependencies.pins ?? PINNED_OFFLINE_INPUTS;
  const downloadPinned = dependencies.downloadPinned ?? defaultDownloadPinned;
  const materializePinnedInputs = dependencies.materializePinnedInputs ?? defaultMaterializePinnedInputs;
  const requirements = assertRequirements(validated.repoRoot, pins);
  fs.mkdirSync(validated.outputRoot, { recursive: true, mode: 0o700 });
  const owned = makeOwnedWorkspace();
  let published = null;
  try {
    const sourceArchive = path.join(owned.workspace, 'terminal-bench.tar.gz');
    const pythonArchive = path.join(owned.workspace, 'python.tar.gz');
    await downloadPinned({ artifact: pins.source, destination: sourceArchive });
    await downloadPinned({ artifact: pins.python, destination: pythonArchive });
    assertRegularHash(sourceArchive, pins.source.sha256, 'Terminal-Bench source archive');
    assertRegularHash(pythonArchive, pins.python.sha256, 'Python standalone archive');
    fs.copyFileSync(requirements.lock, path.join(owned.workspace, 'requirements.txt'), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(owned.workspace, 'requirements.txt'), 0o400);

    const materialized = await materializePinnedInputs({
      workspace: owned.workspace,
      sourceArchive,
      pythonArchive,
      requirementsLock: path.join(owned.workspace, 'requirements.txt'),
      pins,
    });
    if (!plainObject(materialized)) fail('offline input materializer returned an invalid result');
    const sourceRoot = fs.realpathSync.native(absolute(materialized.sourceRoot, 'materialized sourceRoot'));
    const runtimeSourceDir = fs.realpathSync.native(absolute(materialized.runtimeSourceDir, 'materialized runtimeSourceDir'));
    const runtimeDir = path.join(owned.workspace, 'runtime-normalized');
    normalizeRuntimeTree(runtimeSourceDir, runtimeDir);
    const runtimeManifest = makeRuntimeManifest(runtimeDir);
    if (pins.expected != null && runtimeManifest.treeHash !== pins.expected.runtimeTreeHash) {
      fail('portable verifier runtime drifted from the code-owned expected output', 'ERR_TB_OFFLINE_RUNTIME');
    }

    const staging = path.join(owned.workspace, 'artifact-staging');
    const datasetStaging = path.join(staging, 'dataset');
    fs.mkdirSync(datasetStaging, { recursive: true, mode: 0o700 });
    const taskRecords = [];
    const derivedEntries = [];
    for (const entry of validated.taskLock.tasks) {
      const sourceTaskDir = path.join(sourceRoot, entry.task);
      const outputDir = path.join(datasetStaging, entry.task);
      const built = buildOfflineTerminalBenchDerivative({
        sourceTaskDir,
        lockedSourceChecksum: entry.taskChecksum,
        runtimeDir,
        runtimeManifest,
        outputDir,
      });
      const manifestBytes = fs.readFileSync(built.manifestPath);
      taskRecords.push({
        task: entry.task,
        role: entry.role,
        sourceChecksum: entry.taskChecksum,
        derivedChecksum: built.taskTreeHash,
        derivativeManifestSha256: sha256(manifestBytes),
        assertionInventoryHash: built.manifest.assertions.inventoryHash,
      });
      derivedEntries.push({ ...entry, taskChecksum: built.taskTreeHash });
    }

    const offlineLock = {
      ...validated.taskLock,
      datasetRef: `terminal-bench-derived-offline@${pins.source.commit.slice(0, 12)}`,
      registryUrl: pins.source.url,
      stampedFrom: `private offline derivative of terminal-bench-2 commit ${pins.source.commit}`,
      tasks: derivedEntries,
    };
    const lockVerdict = validateTaskLock(offlineLock);
    if (!lockVerdict.ok) fail(`derived task lock is invalid: ${lockVerdict.errors.join('; ')}`);
    const lockText = canonicalJson(offlineLock);
    const taskLockHash = sha256(lockText);
    if (pins.expected != null && taskLockHash !== pins.expected.taskLockHash) {
      fail('derived task lock drifted from the code-owned expected output', 'ERR_TB_OFFLINE_LOCK');
    }
    const attestation = {
      schema: OFFLINE_DATASET_ATTESTATION,
      label: 'private-terminal-bench-derived-offline',
      publicLeaderboardEligible: false,
      networkRequiredAtTrial: false,
      source: structuredClone(pins.source),
      python: structuredClone(pins.python),
      requirements: structuredClone(pins.requirements),
      builder: structuredClone(pins.builder),
      runtime: { treeHash: runtimeManifest.treeHash, manifest: runtimeManifest },
      taskLock: { schema: OFFLINE_DATASET_LOCK, sha256: taskLockHash },
      tasks: taskRecords,
    };
    const attestationText = canonicalJson(attestation);
    const artifactId = sha256(attestationText);
    const datasetTreeHash = hashTree(datasetStaging);
    if (pins.expected != null && (
      artifactId !== pins.expected.artifactId || datasetTreeHash !== pins.expected.datasetTreeHash
    )) {
      fail('offline artifact content identity drifted from the code-owned expected output');
    }
    const artifactDir = path.join(validated.outputRoot, artifactId);
    if (fs.existsSync(artifactDir)) fail('content-addressed offline artifact already exists', 'ERR_TB_OFFLINE_COLLISION');
    writeExclusive(path.join(staging, OFFLINE_TASK_LOCK_FILENAME), Buffer.from(lockText), 0o400);
    writeExclusive(path.join(staging, OFFLINE_ATTESTATION_FILENAME), Buffer.from(attestationText), 0o400);
    fs.renameSync(staging, artifactDir);
    published = artifactDir;
    verifyOfflineTerminalBenchDataset({ artifactDir, expectedPins: pins });
    makeReadOnly(artifactDir);
    return {
      artifactId,
      artifactDir,
      datasetDir: path.join(artifactDir, 'dataset'),
      lockPath: path.join(artifactDir, OFFLINE_TASK_LOCK_FILENAME),
      attestationPath: path.join(artifactDir, OFFLINE_ATTESTATION_FILENAME),
      taskLockHash,
      taskLock: offlineLock,
      attestation,
      datasetTreeHash,
    };
  } catch (error) {
    if (published) {
      makeWritableForRemoval(published);
      fs.rmSync(published, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (!disposeOwnedWorkspace(owned.workspace, owned.nonce)) {
      fail('offline artifact temporary workspace cleanup failed', 'ERR_TB_OFFLINE_CLEANUP');
    }
  }
}

function makeWritableForRemoval(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) makeWritableForRemoval(path.join(root, name));
  } else if (stat.isFile()) fs.chmodSync(root, 0o600);
}
