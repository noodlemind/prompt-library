import crypto from 'node:crypto';

import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
} from './daytona-topology.mjs';

export const SNAPSHOT_BUILD_MANIFEST_SCHEMA = 'engineer-daytona-snapshot-build-manifest.v1';

const MAX_CANONICAL_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_CONTEXT_ENTRIES = 32_768;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}@sha256:[a-f0-9]{64}$/;
const RELEASE_SHA = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?$)(?!.*\/\.\.\/)[A-Za-z0-9._/+:-]+$/;
const REQUIRED_CONTEXTS = Object.freeze(['runtime', 'harbor', 'node', 'native']);
const CREDENTIAL_NAME = /(?:^|[_-])(?:api[_-]?key|authorization|credential|password|secret|token)(?:$|[_-])/i;
const CREDENTIAL_VALUE = /(?:Bearer\s+|sk-(?:or|ant|proj)-|github_pat_|ghp_|xox[baprs]-|hf_[A-Za-z0-9])/i;

export class SnapshotBuildManifestError extends Error {
  constructor(message, code = 'ERR_SNAPSHOT_BUILD_MANIFEST') {
    super(message);
    this.name = 'SnapshotBuildManifestError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_SNAPSHOT_BUILD_MANIFEST_SCHEMA') {
  throw new SnapshotBuildManifestError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const allowed = new Set(expected);
  const actual = Object.keys(value);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    fail(`${label} contains an unexpected field or is missing a required field`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function scanCredentialFree(value, label, depth = 0, nodes = { value: 0 }) {
  nodes.value += 1;
  if (nodes.value > 100_000 || depth > 32) fail(`${label} exceeds its structural bound`);
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE.test(value)) fail(`${label} contains credential material`, 'ERR_SNAPSHOT_BUILD_MANIFEST_SECRET');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) scanCredentialFree(child, label, depth + 1, nodes);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_NAME.test(key)) fail(`${label} contains a credential-bearing field`, 'ERR_SNAPSHOT_BUILD_MANIFEST_SECRET');
    scanCredentialFree(child, label, depth + 1, nodes);
  }
}

function canonicalJson(value, depth = 0, nodes = { value: 0 }) {
  nodes.value += 1;
  if (nodes.value > 100_000 || depth > 32) fail('snapshot manifest exceeds its structural bound');
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1, nodes)).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, nodes)}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))) {
    return JSON.stringify(value);
  }
  fail('snapshot manifest contains a non-canonical value');
}

function canonicalClone(value, label) {
  scanCredentialFree(value, label);
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CANONICAL_BYTES) {
    fail(`${label} exceeds its canonical byte bound`, 'ERR_SNAPSHOT_BUILD_MANIFEST_BOUND');
  }
  return { value: JSON.parse(encoded), encoded };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || Buffer.byteLength(value, 'utf8') > 192) {
    fail(`${label} must be a bounded safe identifier`);
  }
  if (CREDENTIAL_VALUE.test(value)) fail(`${label} contains credential material`, 'ERR_SNAPSHOT_BUILD_MANIFEST_SECRET');
  return value;
}

function relativePath(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\0') ||
      value.includes('\\') || !SAFE_RELATIVE.test(value) || value.startsWith('../') || value.includes('/../') ||
      value.includes('//') || value.endsWith('/.') || value.endsWith('/..')) {
    fail(`${label} must be a normalized bounded relative path`);
  }
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 512 || value.includes('\0') ||
      value.includes('//') || value.includes('/../') || value.includes('/./')) {
    fail(`${label} must be a normalized absolute path`);
  }
  return value;
}

function validateBlob(value, label) {
  exactKeys(value, ['byteLength', 'sha256'], label);
  integer(value.byteLength, `${label}.byteLength`, 1, MAX_CONTEXT_BYTES);
  hash(value.sha256, `${label}.sha256`);
  return value;
}

function validateEntry(value, label) {
  exactKeys(value, ['path', 'type', 'mode', 'byteLength', 'sha256'], label);
  relativePath(value.path, `${label}.path`);
  if (value.type !== 'file') fail(`${label}.type must be file`);
  integer(value.mode, `${label}.mode`, 0, 0o777);
  integer(value.byteLength, `${label}.byteLength`, 0, MAX_CONTEXT_BYTES);
  hash(value.sha256, `${label}.sha256`);
  return value;
}

function validateContext(value, name) {
  exactKeys(value, ['kind', 'encoding', 'byteLength', 'sha256', 'entries'], `contexts.${name}`);
  if (value.kind !== name) fail(`contexts.${name}.kind drifted`);
  if (value.encoding !== 'ustar') fail(`contexts.${name}.encoding must be deterministic ustar`);
  integer(value.byteLength, `contexts.${name}.byteLength`, 1, MAX_CONTEXT_BYTES);
  hash(value.sha256, `contexts.${name}.sha256`);
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_CONTEXT_ENTRIES) {
    fail(`contexts.${name}.entries is outside its bound`);
  }
  const paths = new Set();
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = validateEntry(value.entries[index], `contexts.${name}.entries[${index}]`);
    if (paths.has(entry.path)) fail(`contexts.${name} contains a duplicate path`);
    paths.add(entry.path);
  }
  return value;
}

function validateExecutables(value, contexts) {
  if (!plainObject(value) || Object.keys(value).length < 2 || Object.keys(value).length > 64) {
    fail('executables must contain a bounded protected executable map');
  }
  for (const [name, executable] of Object.entries(value)) {
    safeId(name, `executables.${name} name`);
    exactKeys(executable, ['path', 'sha256', 'context', 'sourcePath'], `executables.${name}`);
    absolutePath(executable.path, `executables.${name}.path`);
    hash(executable.sha256, `executables.${name}.sha256`);
    if (!REQUIRED_CONTEXTS.includes(executable.context)) fail(`executables.${name}.context is not a required closure`);
    relativePath(executable.sourcePath, `executables.${name}.sourcePath`);
    const source = contexts[executable.context].entries.find((entry) => entry.path === executable.sourcePath);
    if (!source || source.sha256 !== executable.sha256) {
      fail(`executable ${name} source hash is not bound to its closure`, 'ERR_SNAPSHOT_BUILD_MANIFEST_EXECUTABLE');
    }
  }
  for (const required of [
    'supervisor', 'snapshotSelfTest', 'taskIsolationProbe', 'readinessDenialProbe',
  ]) {
    if (!Object.hasOwn(value, required)) fail(`executables is missing ${required}`);
  }
  const isolationProbe = value.taskIsolationProbe;
  if (isolationProbe.path !== '/opt/engineer/bin/engineer-task-isolation-probe' ||
      isolationProbe.context !== 'native') {
    fail('task isolation probe must use its protected native executable path',
      'ERR_SNAPSHOT_BUILD_MANIFEST_EXECUTABLE');
  }
  const denialProbe = value.readinessDenialProbe;
  if (denialProbe.path !== '/opt/engineer/bin/engineer-readiness-denial-probe' ||
      denialProbe.context !== 'native') {
    fail('readiness denial probe must use its protected native executable path',
      'ERR_SNAPSHOT_BUILD_MANIFEST_EXECUTABLE');
  }
}

function validateProvenance(value) {
  exactKeys(value, [
    'baseImage', 'harbor', 'node', 'nativeHelper', 'taskIsolationProbe', 'readinessDenialProbe',
  ], 'provenance');
  exactKeys(value.baseImage, ['reference', 'digest'], 'provenance.baseImage');
  if (value.baseImage.reference !== DAYTONA_DIND_BASE_IMAGE ||
      value.baseImage.digest !== DAYTONA_DIND_BASE_IMAGE_DIGEST) {
    fail('snapshot base image drifted from the approved DIND digest');
  }
  exactKeys(value.harbor, ['version', 'commit', 'lockSha256'], 'provenance.harbor');
  if (value.harbor.version !== 'v0.20.0' ||
      value.harbor.commit !== '459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc') {
    fail('Harbor provenance drifted from the exact v0.20.0 commit');
  }
  hash(value.harbor.lockSha256, 'provenance.harbor.lockSha256');
  exactKeys(value.node, ['version', 'platform', 'archiveSha256'], 'provenance.node');
  if (typeof value.node.version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(value.node.version) ||
      value.node.platform !== 'linux-x64') fail('Node provenance must pin one linux-x64 release');
  hash(value.node.archiveSha256, 'provenance.node.archiveSha256');
  exactKeys(value.nativeHelper, [
    'sourceSha256', 'compilerImage', 'compilerImageDigest', 'binarySha256',
  ], 'provenance.nativeHelper');
  hash(value.nativeHelper.sourceSha256, 'provenance.nativeHelper.sourceSha256');
  if (typeof value.nativeHelper.compilerImage !== 'string' ||
      !IMMUTABLE_IMAGE.test(value.nativeHelper.compilerImage) ||
      !IMAGE_ID.test(value.nativeHelper.compilerImageDigest) ||
      !value.nativeHelper.compilerImage.endsWith(`@${value.nativeHelper.compilerImageDigest}`)) {
    fail('native helper compiler image must be an immutable digest-qualified image');
  }
  hash(value.nativeHelper.binarySha256, 'provenance.nativeHelper.binarySha256');
  exactKeys(value.taskIsolationProbe, [
    'sourceSha256', 'compilerImage', 'compilerImageDigest', 'binarySha256', 'platform',
    'artifactPath',
  ], 'provenance.taskIsolationProbe');
  hash(value.taskIsolationProbe.sourceSha256, 'provenance.taskIsolationProbe.sourceSha256');
  if (typeof value.taskIsolationProbe.compilerImage !== 'string' ||
      !IMMUTABLE_IMAGE.test(value.taskIsolationProbe.compilerImage) ||
      !IMAGE_ID.test(value.taskIsolationProbe.compilerImageDigest) ||
      !value.taskIsolationProbe.compilerImage.endsWith(`@${value.taskIsolationProbe.compilerImageDigest}`)) {
    fail('task isolation probe compiler image must be an immutable digest-qualified image');
  }
  hash(value.taskIsolationProbe.binarySha256, 'provenance.taskIsolationProbe.binarySha256');
  if (value.taskIsolationProbe.platform !== 'linux/amd64' ||
      value.taskIsolationProbe.artifactPath !== '/opt/engineer/bin/engineer-task-isolation-probe') {
    fail('task isolation probe provenance must bind the protected linux/amd64 artifact');
  }
  exactKeys(value.readinessDenialProbe, [
    'sourceSha256', 'compilerImage', 'compilerImageDigest', 'binarySha256', 'platform',
    'artifactPath',
  ], 'provenance.readinessDenialProbe');
  hash(value.readinessDenialProbe.sourceSha256,
    'provenance.readinessDenialProbe.sourceSha256');
  if (typeof value.readinessDenialProbe.compilerImage !== 'string' ||
      !IMMUTABLE_IMAGE.test(value.readinessDenialProbe.compilerImage) ||
      !IMAGE_ID.test(value.readinessDenialProbe.compilerImageDigest) ||
      !value.readinessDenialProbe.compilerImage.endsWith(
        `@${value.readinessDenialProbe.compilerImageDigest}`)) {
    fail('readiness denial probe compiler image must be an immutable digest-qualified image');
  }
  hash(value.readinessDenialProbe.binarySha256,
    'provenance.readinessDenialProbe.binarySha256');
  if (value.readinessDenialProbe.platform !== 'linux/amd64' ||
      value.readinessDenialProbe.artifactPath !==
        '/opt/engineer/bin/engineer-readiness-denial-probe') {
    fail('readiness denial probe provenance must bind the protected linux/amd64 artifact');
  }
}

function validateBindings(value) {
  exactKeys(value, [
    'releaseSha', 'taskLockHash', 'bundleHash', 'budgetPolicyHash', 'brokerPolicyHash', 'profileId',
    'sessionCeilingMicrousd',
  ], 'bindings');
  if (typeof value.releaseSha !== 'string' || !RELEASE_SHA.test(value.releaseSha)) {
    fail('bindings.releaseSha must be a full lowercase commit/content identity');
  }
  hash(value.taskLockHash, 'bindings.taskLockHash');
  hash(value.bundleHash, 'bindings.bundleHash');
  hash(value.budgetPolicyHash, 'bindings.budgetPolicyHash');
  hash(value.brokerPolicyHash, 'bindings.brokerPolicyHash');
  safeId(value.profileId, 'bindings.profileId');
  integer(value.sessionCeilingMicrousd, 'bindings.sessionCeilingMicrousd', 1, 20_000_000);
}

function validateTaskImages(value) {
  if (!plainObject(value) || Object.keys(value).length < 1 || Object.keys(value).length > 64) {
    fail('taskImages must contain 1-64 locked task images');
  }
  for (const [taskId, image] of Object.entries(value)) {
    safeId(taskId, `taskImages.${taskId} taskId`);
    exactKeys(image, [
      'immutableImage', 'imageId', 'platform', 'cpus', 'memoryMb', 'storageMb',
    ], `taskImages.${taskId}`);
    if (typeof image.immutableImage !== 'string' || !IMMUTABLE_IMAGE.test(image.immutableImage)) {
      fail(`taskImages.${taskId}.immutableImage must be a digest-qualified repository reference`);
    }
    if (typeof image.imageId !== 'string' || !IMAGE_ID.test(image.imageId) ||
        !image.immutableImage.endsWith(`@${image.imageId}`)) {
      fail(`taskImages.${taskId} immutable image digest does not match its image id`);
    }
    if (image.platform !== 'linux/amd64') fail(`taskImages.${taskId}.platform must be linux/amd64`);
    integer(image.cpus, `taskImages.${taskId}.cpus`, 1, 64);
    integer(image.memoryMb, `taskImages.${taskId}.memoryMb`, 64, 1_048_576);
    integer(image.storageMb, `taskImages.${taskId}.storageMb`, 64, 1_048_576);
  }
}

export function validateSnapshotBuildManifest(input) {
  exactKeys(input, [
    'schema', 'manifestVersion', 'dockerfile', 'definition', 'contexts', 'executables',
    'provenance', 'bindings', 'taskImages',
  ], 'snapshot build manifest');
  if (input.schema !== SNAPSHOT_BUILD_MANIFEST_SCHEMA || input.manifestVersion !== 1) {
    fail('snapshot build manifest schema or version drifted');
  }
  validateBlob(input.dockerfile, 'dockerfile');
  validateBlob(input.definition, 'definition');
  exactKeys(input.contexts, REQUIRED_CONTEXTS, 'contexts');
  for (const name of REQUIRED_CONTEXTS) validateContext(input.contexts[name], name);
  validateExecutables(input.executables, input.contexts);
  validateProvenance(input.provenance);
  if (!Object.values(input.executables).some((entry) =>
    entry.context === 'native' && entry.sha256 === input.provenance.nativeHelper.binarySha256)) {
    fail('native helper binary hash is not present in the protected executable inventory');
  }
  if (input.executables.taskIsolationProbe.sha256 !== input.provenance.taskIsolationProbe.binarySha256) {
    fail('task isolation probe binary hash is not bound to its protected executable inventory',
      'ERR_SNAPSHOT_BUILD_MANIFEST_EXECUTABLE');
  }
  if (input.executables.readinessDenialProbe.sha256 !==
      input.provenance.readinessDenialProbe.binarySha256) {
    fail('readiness denial probe binary hash is not bound to its protected executable inventory',
      'ERR_SNAPSHOT_BUILD_MANIFEST_EXECUTABLE');
  }
  validateBindings(input.bindings);
  validateTaskImages(input.taskImages);
  return deepFreeze(canonicalClone(input, 'snapshot build manifest').value);
}

export function snapshotBuildManifestHash(input) {
  const manifest = validateSnapshotBuildManifest(input);
  return sha256(canonicalClone(manifest, 'snapshot build manifest').encoded);
}

export function buildSnapshotBuildManifest(input = {}) {
  exactKeys(input, [
    'dockerfile', 'definition', 'contexts', 'executables', 'provenance', 'bindings', 'taskImages',
  ], 'snapshot build input');
  const manifest = validateSnapshotBuildManifest({
    schema: SNAPSHOT_BUILD_MANIFEST_SCHEMA,
    manifestVersion: 1,
    ...input,
  });
  const { encoded: canonical } = canonicalClone(manifest, 'snapshot build manifest');
  const buildHash = sha256(canonical);
  return deepFreeze({
    manifest,
    canonicalJson: canonical,
    buildHash,
    snapshotName: `engineer-eval-${buildHash.slice(0, 32)}`,
  });
}
