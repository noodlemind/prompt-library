#!/usr/local/bin/node

/**
 * Root-only task-image preload for one fresh Daytona sandbox.
 *
 * The provisioner deliberately completes before provider-key handoff. It talks
 * directly to the private daemon, verifies the content identity, and publishes
 * one fixed owner-only marker. Harbor later receives only the policy proxy.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

import {
  RUNTIME_TOPOLOGY_RECEIPT_PATH,
  publishProvisionedRuntimeTopologyReceipt,
  removeProvisionedRuntimeTopologyReceipt,
} from './runtime-definition.mjs';
import {
  scrubDaytonaPlatformMetadata,
  scrubDaytonaPlatformMetadataInPlace,
} from './platform-environment.mjs';

export const PRIVATE_DOCKER_SOCKET = '/run/engineer/private-docker.sock';
export const TASK_IMAGE_PRELOAD_MARKER_PATH = '/engineer-bounded/evidence/task-image-preload.json';
export const TASK_IMAGE_PRELOAD_MARKER_SCHEMA = 'engineer-task-image-preload-marker.v1';
export const TASK_IMAGE_PROVISION_RESULT_SCHEMA = 'engineer-task-image-provision-result.v2';
export const TASK_IMAGE_CLEANUP_RESULT_SCHEMA = 'engineer-task-image-cleanup-result.v2';

const CLI_FAILURE_SCHEMA = 'engineer-task-image-provision-cli-failure.v1';
const DEFAULT_DOCKER_PATH = '/usr/local/bin/docker';
const PRIVATE_DOCKER_HOST = `unix://${PRIVATE_DOCKER_SOCKET}`;
const MARKER_MAX_BYTES = 8 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REPOSITORY_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
const PROVIDER_ENVIRONMENT_NAME = /(?:^DAYTONA(?:_|$)|OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|GROQ|XAI|MISTRAL|COHERE|TOGETHER|FIREWORKS|DEEPSEEK|CEREBRAS|PERPLEXITY|AWS_(?:ACCESS|SECRET|SESSION)|AZURE_(?:CLIENT|TENANT)|GOOGLE_APPLICATION_CREDENTIALS|GITHUB_TOKEN|COPILOT|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const SECRET_VALUE = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{4,}|gh[pousr]_[A-Za-z0-9]{4,}|xox[baprs]-[A-Za-z0-9-]{4,}|hf_[A-Za-z0-9]{4,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,})/i;
const SECRET_FIELD_OUTPUT = /(?:api[_-]?key|authorization|credential|password|secret|token)\s*[=:]\s*["']?[^\s"',}\]]{4,}/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/run/engineer/task-image-provisioner',
  DOCKER_CONFIG: '/run/engineer/task-image-provisioner/docker-config',
});

const INSPECT_FORMAT =
  '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"repoDigests":{{json .RepoDigests}}}';

export class TaskImageProvisionerError extends Error {
  constructor(message, code = 'ERR_TASK_IMAGE_PROVISION') {
    super(message);
    this.name = 'TaskImageProvisionerError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_TASK_IMAGE_PROVISION') {
  throw new TaskImageProvisionerError(message, code);
}

function sanitized(error, message, code) {
  if (error instanceof TaskImageProvisionerError) return error;
  return new TaskImageProvisionerError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label, code = 'ERR_TASK_IMAGE_PROVISION_ARGUMENTS') {
  if (!plainObject(value)) fail(`${label} must be a plain object`, code);
  const allowed = new Set(expected);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
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
  if (depth > 16 || nodes.count > 512) {
    fail('provision evidence exceeds its structural bound', 'ERR_TASK_IMAGE_PROVISION_EVIDENCE');
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
  fail('provision evidence contains a non-canonical value', 'ERR_TASK_IMAGE_PROVISION_EVIDENCE');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalSha256(value) {
  return sha256(canonicalJson(value));
}

function secretBearing(value) {
  const text = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value).toString('utf8')
    : String(value);
  return SECRET_VALUE.test(text) || SECRET_FIELD_OUTPUT.test(text);
}

function assertSecretFree(value, label, code = 'ERR_TASK_IMAGE_PROVISION_SECRET_OUTPUT') {
  if (secretBearing(value)) fail(`${label} is secret-bearing`, code);
}

function assertCredentialFreeEnvironment(environment) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('ambient environment must be an object', 'ERR_TASK_IMAGE_PROVISION_ENVIRONMENT');
  }
  let names;
  try {
    names = Object.keys(environment);
  } catch {
    fail('ambient environment cannot be inspected', 'ERR_TASK_IMAGE_PROVISION_ENVIRONMENT');
  }
  for (const name of names) {
    if (PROVIDER_ENVIRONMENT_NAME.test(name)) {
      fail('ambient provider credential variables are forbidden', 'ERR_TASK_IMAGE_PROVISION_ENVIRONMENT');
    }
    let value;
    try {
      value = environment[name];
    } catch {
      fail('ambient environment cannot be inspected', 'ERR_TASK_IMAGE_PROVISION_ENVIRONMENT');
    }
    if (typeof value === 'string' && secretBearing(value)) {
      fail('ambient provider credential material is forbidden', 'ERR_TASK_IMAGE_PROVISION_ENVIRONMENT');
    }
  }
}

function repositoryName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || value.includes('\0')) {
    fail('immutable image repository is invalid', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0)) {
    fail('immutable image repository is invalid', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  let first = parts[0];
  if (first.includes(':')) {
    if (parts.length < 2) {
      fail('mutable image tags are forbidden', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
    }
    const hostAndPort = /^([^:]+):([1-9][0-9]{0,4})$/.exec(first);
    const port = Number(hostAndPort?.[2]);
    if (!hostAndPort || !Number.isSafeInteger(port) || port > 65_535) {
      fail('immutable image registry port is invalid', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
    }
    first = hostAndPort[1];
    parts[0] = first;
  }
  if (parts.some((part) => !REPOSITORY_COMPONENT.test(part))) {
    fail('immutable image repository is invalid', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  return value;
}

function immutableIdentity(value) {
  if (typeof value !== 'string' || value.length > 327 || value.includes('\0')) {
    fail('immutableImage must be a bounded repository digest', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  assertSecretFree(value, 'immutable image identity', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  const match = /^(.+)@sha256:([a-f0-9]{64})$/.exec(value);
  if (!match || match[1].includes('@')) {
    fail('immutableImage must be repository@sha256:<64 lowercase hex>',
      'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  repositoryName(match[1]);
  return value;
}

function sandboxIdentity(value) {
  if (typeof value !== 'string' || !SANDBOX_ID.test(value)) {
    fail('sandboxId must be a bounded safe identifier', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  assertSecretFree(value, 'sandbox identity', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  return value;
}

function validateProvisionRequest(value) {
  exactKeys(value, ['sandboxId', 'immutableImage', 'imageId', 'platform'], 'provision request');
  const sandboxId = sandboxIdentity(value.sandboxId);
  const immutableImage = immutableIdentity(value.immutableImage);
  if (typeof value.imageId !== 'string' || !IMAGE_ID.test(value.imageId)) {
    fail('imageId digest must be sha256:<64 lowercase hex>', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  if (value.platform !== 'linux/amd64') {
    fail('platform must be exactly linux/amd64', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  return deepFreeze({
    sandboxId,
    immutableImage,
    imageId: value.imageId,
    platform: value.platform,
  });
}

/** Parse the one fixed production entrypoint shape; ordering is intentional. */
export function parseTaskImageProvisionerArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 8 ||
      argv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
    fail('entrypoint requires exactly eight NUL-free arguments', 'ERR_TASK_IMAGE_PROVISION_ARGUMENTS');
  }
  const expectedFlags = ['--sandbox-id', '--immutable-image', '--image-id', '--platform'];
  for (let index = 0; index < expectedFlags.length; index += 1) {
    if (argv[index * 2] !== expectedFlags[index] || argv[index * 2 + 1].startsWith('--')) {
      fail('entrypoint arguments must use the exact fixed flag sequence',
        'ERR_TASK_IMAGE_PROVISION_ARGUMENTS');
    }
  }
  return validateProvisionRequest({
    sandboxId: argv[1],
    immutableImage: argv[3],
    imageId: argv[5],
    platform: argv[7],
  });
}

function outputBytes(value, label, maximum) {
  let bytes;
  if (typeof value === 'string') bytes = Buffer.from(value);
  else if (Buffer.isBuffer(value) || value instanceof Uint8Array) bytes = Buffer.from(value);
  else fail(`${label} must be bytes`, 'ERR_TASK_IMAGE_PROVISION_COMMAND');
  if (bytes.length > maximum) {
    bytes.fill(0);
    fail(`${label} exceeds its byte bound`, 'ERR_TASK_IMAGE_PROVISION_COMMAND');
  }
  return bytes;
}

function commandReceipt(code, stdout, stderr) {
  return deepFreeze({
    exitCode: code,
    stdoutBytes: stdout.length,
    stdoutSha256: sha256(stdout),
    stderrBytes: stderr.length,
    stderrSha256: sha256(stderr),
  });
}

function parseInspect(stdout, expected) {
  let text;
  try {
    text = UTF8.decode(stdout).trim();
  } catch {
    fail('Docker image inspect returned invalid UTF-8', 'ERR_TASK_IMAGE_PROVISION_INSPECT');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('Docker image inspect returned malformed JSON', 'ERR_TASK_IMAGE_PROVISION_INSPECT');
  }
  exactKeys(value, ['id', 'os', 'architecture', 'repoDigests'], 'Docker image inspection',
    'ERR_TASK_IMAGE_PROVISION_INSPECT');
  if (value.id !== expected.imageId) {
    fail('Docker image content identity does not match the approved image ID',
      'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  if (value.os !== 'linux' || value.architecture !== 'amd64') {
    fail('Docker image platform does not match linux/amd64', 'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
  if (!Array.isArray(value.repoDigests) || value.repoDigests.length < 1 || value.repoDigests.length > 64 ||
      value.repoDigests.some((entry) => typeof entry !== 'string' || entry.length > 327 || secretBearing(entry)) ||
      !value.repoDigests.includes(expected.immutableImage)) {
    fail('Docker image repository digest does not match the immutable reference',
      'ERR_TASK_IMAGE_PROVISION_IDENTITY');
  }
}

function validateWriterReceipt(value) {
  exactKeys(value, ['path', 'atomic'], 'marker writer receipt', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  if (value.path !== TASK_IMAGE_PRELOAD_MARKER_PATH || value.atomic !== true) {
    fail('marker writer path or atomicity drifted', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  }
}

function validateMarkerAttestation(value, expected) {
  exactKeys(value, [
    'path', 'kind', 'real', 'symlink', 'ownerUid', 'ownerGid', 'mode', 'byteLength', 'sha256',
  ], 'marker attestation', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  if (value.path !== TASK_IMAGE_PRELOAD_MARKER_PATH ||
      value.kind !== 'regular-file' || value.real !== true || value.symlink !== false ||
      value.ownerUid !== 0 || value.ownerGid !== 0 || value.mode !== 0o600 ||
      value.byteLength !== expected.byteLength || value.sha256 !== expected.sha256) {
    fail('marker attestation custody or content drifted', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  }
  return deepFreeze({
    path: value.path,
    sha256: value.sha256,
    byteLength: value.byteLength,
    ownerUid: value.ownerUid,
    ownerGid: value.ownerGid,
    mode: value.mode,
  });
}

function validateRuntimeTopologyAttestation(value) {
  exactKeys(value, [
    'path', 'kind', 'real', 'symlink', 'ownerUid', 'ownerGid', 'mode',
    'byteLength', 'sha256', 'receiptNonce',
  ], 'runtime topology attestation', 'ERR_TASK_IMAGE_PROVISION_TOPOLOGY');
  if (value.path !== RUNTIME_TOPOLOGY_RECEIPT_PATH || value.kind !== 'regular-file' ||
      value.real !== true || value.symlink !== false || value.ownerUid !== 0 || value.ownerGid !== 0 ||
      value.mode !== 0o600 || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 ||
      value.byteLength > 64 * 1024 || !HASH.test(String(value.sha256)) ||
      !HASH.test(String(value.receiptNonce))) {
    fail('runtime topology receipt custody or identity drifted',
      'ERR_TASK_IMAGE_PROVISION_TOPOLOGY');
  }
  return deepFreeze({ ...value });
}

function validateRemoveReceipt(value) {
  exactKeys(value, ['path', 'absent'], 'marker removal receipt', 'ERR_TASK_IMAGE_PROVISION_CLEANUP');
  if (value.path !== TASK_IMAGE_PRELOAD_MARKER_PATH || value.absent !== true) {
    fail('marker removal path or absence attestation drifted', 'ERR_TASK_IMAGE_PROVISION_CLEANUP');
  }
}

function validateTopologyRemoveReceipt(value) {
  exactKeys(value, ['path', 'absent'], 'runtime topology removal receipt',
    'ERR_TASK_IMAGE_PROVISION_CLEANUP');
  if (value.path !== RUNTIME_TOPOLOGY_RECEIPT_PATH || value.absent !== true) {
    fail('runtime topology removal path or absence attestation drifted',
      'ERR_TASK_IMAGE_PROVISION_CLEANUP');
  }
}

function defaultRunCommand(file, args, options) {
  const result = spawnSync(file, args, {
    shell: false,
    encoding: null,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    code: Number.isInteger(result.status) ? result.status : null,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    error: result.error ?? null,
  };
}

async function defaultWriteMarkerAtomic({
  path: target,
  bytes,
  mode,
  ownerUid,
  ownerGid,
}) {
  if (target !== TASK_IMAGE_PRELOAD_MARKER_PATH || mode !== 0o600 || ownerUid !== 0 || ownerGid !== 0 ||
      (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) || bytes.byteLength > MARKER_MAX_BYTES) {
    fail('marker write request drifted', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  }
  const parent = path.posix.dirname(target);
  let parentStat;
  try {
    parentStat = await fsp.lstat(parent);
  } catch {
    fail('marker parent is unavailable', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== 0 ||
      (parentStat.mode & 0o022) !== 0) {
    fail('marker parent custody drifted', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  }
  try {
    await fsp.lstat(target);
    fail('marker path already exists', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  } catch (error) {
    if (error instanceof TaskImageProvisionerError) throw error;
    if (error?.code !== 'ENOENT') {
      fail('marker path cannot be inspected', 'ERR_TASK_IMAGE_PROVISION_MARKER');
    }
  }

  const suffix = crypto.randomBytes(16).toString('hex');
  const temporary = `${target}.tmp-${process.pid}-${suffix}`;
  let handle;
  try {
    const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fsp.open(temporary, flags, 0o600);
    await handle.writeFile(Buffer.from(bytes));
    await handle.chmod(0o600);
    await handle.chown(0, 0);
    await handle.sync();
    await handle.close();
    handle = null;
    // link() publishes without replacing a raced or attacker-created target.
    await fsp.link(temporary, target);
    await fsp.unlink(temporary);
    const directory = await fsp.open(parent, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try { await directory.sync(); } finally { await directory.close(); }
    return { path: target, atomic: true };
  } catch (error) {
    if (error instanceof TaskImageProvisionerError) throw error;
    fail('atomic marker publication failed', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  } finally {
    let cleanupFailed = false;
    try { await handle?.close(); } catch { cleanupFailed = true; }
    try { await fsp.unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') cleanupFailed = true; }
    if (cleanupFailed) {
      fail('temporary marker cleanup failed', 'ERR_TASK_IMAGE_PROVISION_MARKER');
    }
  }
}

async function defaultAttestMarker({ path: target, expectedSha256, maxBytes }) {
  if (target !== TASK_IMAGE_PRELOAD_MARKER_PATH || !HASH.test(String(expectedSha256)) ||
      maxBytes !== MARKER_MAX_BYTES) {
    fail('marker attestation request drifted', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  }
  let handle;
  let bytes = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fsp.open(target, flags);
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink?.() || before.size < 1 || before.size > maxBytes) {
      fail('marker is not a bounded regular file', 'ERR_TASK_IMAGE_PROVISION_MARKER');
    }
    bytes = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used !== before.size || used > maxBytes || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('marker changed while it was attested', 'ERR_TASK_IMAGE_PROVISION_MARKER');
    }
    const contentHash = sha256(bytes.subarray(0, used));
    if (contentHash !== expectedSha256) {
      fail('marker content hash drifted', 'ERR_TASK_IMAGE_PROVISION_MARKER');
    }
    return {
      path: target,
      kind: 'regular-file',
      real: true,
      symlink: false,
      ownerUid: before.uid,
      ownerGid: before.gid,
      mode: before.mode & 0o777,
      byteLength: used,
      sha256: contentHash,
    };
  } catch (error) {
    throw sanitized(error, 'marker attestation failed', 'ERR_TASK_IMAGE_PROVISION_MARKER');
  } finally {
    bytes?.fill(0);
    try { await handle?.close(); } catch { /* attestation is already failed/complete */ }
  }
}

async function defaultRemoveMarker({ path: target }) {
  if (target !== TASK_IMAGE_PRELOAD_MARKER_PATH) {
    fail('marker cleanup path drifted', 'ERR_TASK_IMAGE_PROVISION_CLEANUP');
  }
  try {
    await fsp.unlink(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      fail('marker cleanup failed', 'ERR_TASK_IMAGE_PROVISION_CLEANUP');
    }
  }
  try {
    await fsp.lstat(target);
    fail('marker cleanup did not make the path absent', 'ERR_TASK_IMAGE_PROVISION_CLEANUP');
  } catch (error) {
    if (error instanceof TaskImageProvisionerError) throw error;
    if (error?.code !== 'ENOENT') {
      fail('marker cleanup absence cannot be attested', 'ERR_TASK_IMAGE_PROVISION_CLEANUP');
    }
  }
  return { path: target, absent: true };
}

/**
 * Construct one fail-stop, one-image lifecycle. No socket, marker path, host,
 * platform, or child environment is caller-configurable.
 */
export function createTaskImageProvisioner(options = {}) {
  if (!plainObject(options)) {
    fail('provisioner options must be a plain object', 'ERR_TASK_IMAGE_PROVISION_CONFIG');
  }
  const allowedOptions = new Set([
    'runCommand', 'writeMarkerAtomic', 'attestMarker', 'removeMarker',
    'publishRuntimeTopologyReceipt', 'removeRuntimeTopologyReceipt', 'baseEnv',
  ]);
  if (Object.keys(options).some((key) => !allowedOptions.has(key))) {
    fail('provisioner options contain an unexpected field', 'ERR_TASK_IMAGE_PROVISION_CONFIG');
  }
  const runCommand = options.runCommand ?? defaultRunCommand;
  const writeMarkerAtomic = options.writeMarkerAtomic ?? defaultWriteMarkerAtomic;
  const attestMarker = options.attestMarker ?? defaultAttestMarker;
  const removeMarker = options.removeMarker ?? defaultRemoveMarker;
  const publishRuntimeTopologyReceipt = options.publishRuntimeTopologyReceipt ??
    publishProvisionedRuntimeTopologyReceipt;
  const removeRuntimeTopologyReceipt = options.removeRuntimeTopologyReceipt ??
    removeProvisionedRuntimeTopologyReceipt;
  const baseEnv = options.baseEnv ?? process.env;
  if ([
    runCommand, writeMarkerAtomic, attestMarker, removeMarker,
    publishRuntimeTopologyReceipt, removeRuntimeTopologyReceipt,
  ]
    .some((implementation) => typeof implementation !== 'function')) {
    fail('provisioner effects must be functions', 'ERR_TASK_IMAGE_PROVISION_CONFIG');
  }
  let scrubbedBaseEnv;
  try {
    scrubbedBaseEnv = scrubDaytonaPlatformMetadata(baseEnv);
  } catch {
    fail('ambient Daytona platform metadata is invalid', 'ERR_TASK_IMAGE_PROVISION_ENVIRONMENT');
  }
  assertCredentialFreeEnvironment(scrubbedBaseEnv);

  let state = 'idle';
  let identity = null;
  let provisionEvidence = null;
  let cleanupEvidence = null;
  let markerMayExist = false;
  let markerRemoved = false;
  let runtimeTopologyMayExist = false;
  let runtimeTopologyRemoved = false;
  let imageMayExist = false;
  let imageRemoved = false;

  async function invoke(args, label) {
    if (!Array.isArray(args) || args.length < 1 || args.length > 16 ||
        args.some((argument) => typeof argument !== 'string' || argument.length < 1 ||
          argument.length > 1_024 || argument.includes('\0') || secretBearing(argument))) {
      fail(`${label} argv is invalid`, 'ERR_TASK_IMAGE_PROVISION_COMMAND');
    }
    let result;
    try {
      result = await runCommand(DEFAULT_DOCKER_PATH, args.slice(), {
        shell: false,
        env: { ...COMMAND_ENVIRONMENT },
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      });
    } catch {
      fail(`${label} failed`, 'ERR_TASK_IMAGE_PROVISION_COMMAND');
    }
    if (!plainObject(result)) fail(`${label} returned an invalid result`, 'ERR_TASK_IMAGE_PROVISION_COMMAND');
    const stdout = outputBytes(result.stdout ?? '', `${label} stdout`, MAX_COMMAND_OUTPUT_BYTES);
    const stderr = outputBytes(result.stderr ?? '', `${label} stderr`, MAX_COMMAND_OUTPUT_BYTES);
    try {
      if (secretBearing(stdout) || secretBearing(stderr) ||
          (result.error != null && secretBearing(String(result.error?.message ?? result.error)))) {
        fail(`${label} output is secret-bearing`, 'ERR_TASK_IMAGE_PROVISION_SECRET_OUTPUT');
      }
      if (!Number.isInteger(result.code) || result.code < 0 || result.code > 255 ||
          result.code !== 0 || result.error != null) {
        fail(`${label} failed`, 'ERR_TASK_IMAGE_PROVISION_COMMAND');
      }
      return { stdout, receipt: commandReceipt(result.code, stdout, stderr) };
    } catch (error) {
      stdout.fill(0);
      throw error;
    } finally {
      stderr.fill(0);
    }
  }

  function cleanupResult() {
    if (!provisionEvidence) return null;
    if (cleanupEvidence) return cleanupEvidence;
    const unsigned = {
      schema: TASK_IMAGE_CLEANUP_RESULT_SCHEMA,
      sandboxId: identity.sandboxId,
      preloadEvidenceHash: provisionEvidence.evidenceHash,
      markerSha256: provisionEvidence.marker.sha256,
      runtimeTopologySha256: provisionEvidence.runtimeTopology.sha256,
      runtimeTopologyRemoved: true,
      markerRemoved: true,
      imageRemoved: true,
    };
    cleanupEvidence = deepFreeze({ ...unsigned, evidenceHash: canonicalSha256(unsigned) });
    return cleanupEvidence;
  }

  async function cleanupResources() {
    const failures = [];
    if (runtimeTopologyMayExist && !runtimeTopologyRemoved) {
      try {
        const receipt = await removeRuntimeTopologyReceipt();
        validateTopologyRemoveReceipt(receipt);
        runtimeTopologyRemoved = true;
        runtimeTopologyMayExist = false;
      } catch {
        failures.push('runtime-topology');
      }
    }
    if (markerMayExist && !markerRemoved) {
      try {
        const receipt = await removeMarker({ path: TASK_IMAGE_PRELOAD_MARKER_PATH });
        validateRemoveReceipt(receipt);
        markerRemoved = true;
        markerMayExist = false;
      } catch {
        failures.push('marker');
      }
    }
    if (imageMayExist && !imageRemoved) {
      try {
        const removed = await invoke([
          '--host', PRIVATE_DOCKER_HOST,
          'image', 'rm', '--force', identity.immutableImage,
        ], 'Docker image cleanup');
        removed.stdout.fill(0);
        imageRemoved = true;
        imageMayExist = false;
      } catch {
        failures.push('image');
      }
    }
    if (failures.length > 0) {
      fail('task image cleanup failed closed', 'ERR_TASK_IMAGE_PROVISION_CLEANUP');
    }
    return cleanupResult();
  }

  async function provision(requestInput) {
    if (state !== 'idle') {
      fail('task image provisioner is one-shot', 'ERR_TASK_IMAGE_PROVISION_LIFECYCLE');
    }
    const request = validateProvisionRequest(requestInput);
    identity = request;
    state = 'provisioning';
    let primaryFailure = null;
    try {
      imageMayExist = true;
      const pulled = await invoke([
        '--host', PRIVATE_DOCKER_HOST,
        'image', 'pull', '--quiet', '--platform', request.platform, request.immutableImage,
      ], 'Docker image pull');
      const pullReceiptHash = canonicalSha256(pulled.receipt);
      pulled.stdout.fill(0);

      const inspected = await invoke([
        '--host', PRIVATE_DOCKER_HOST,
        'image', 'inspect', '--format', INSPECT_FORMAT, request.immutableImage,
      ], 'Docker image inspect');
      const inspectReceiptHash = canonicalSha256(inspected.receipt);
      try {
        parseInspect(inspected.stdout, request);
      } finally {
        inspected.stdout.fill(0);
      }

      const marker = deepFreeze({
        schema: TASK_IMAGE_PRELOAD_MARKER_SCHEMA,
        sandboxId: request.sandboxId,
        immutableImage: request.immutableImage,
        imageId: request.imageId,
        platform: request.platform,
        pullReceiptHash,
        inspectReceiptHash,
      });
      const markerCanonical = canonicalJson(marker);
      const markerBytes = Buffer.from(markerCanonical);
      if (markerBytes.length < 1 || markerBytes.length > MARKER_MAX_BYTES) {
        markerBytes.fill(0);
        fail('preload marker exceeds its byte bound', 'ERR_TASK_IMAGE_PROVISION_MARKER');
      }
      const markerSha256 = sha256(markerBytes);
      markerMayExist = true;
      try {
        let writerReceipt;
        try {
          writerReceipt = await writeMarkerAtomic({
            path: TASK_IMAGE_PRELOAD_MARKER_PATH,
            bytes: markerBytes,
            mode: 0o600,
            ownerUid: 0,
            ownerGid: 0,
          });
        } catch (error) {
          throw sanitized(error, 'atomic marker publication failed', 'ERR_TASK_IMAGE_PROVISION_MARKER');
        }
        validateWriterReceipt(writerReceipt);
        let rawAttestation;
        try {
          rawAttestation = await attestMarker({
            path: TASK_IMAGE_PRELOAD_MARKER_PATH,
            expectedSha256: markerSha256,
            maxBytes: MARKER_MAX_BYTES,
          });
        } catch (error) {
          throw sanitized(error, 'marker attestation failed', 'ERR_TASK_IMAGE_PROVISION_MARKER');
        }
        const markerAttestation = validateMarkerAttestation(rawAttestation, {
          byteLength: markerBytes.length,
          sha256: markerSha256,
        });
        const preload = {
          sandboxId: request.sandboxId,
          immutableImage: request.immutableImage,
          imageId: request.imageId,
          platform: request.platform,
          pullReceiptHash,
          inspectReceiptHash,
          markerSha256,
        };
        runtimeTopologyMayExist = true;
        let rawRuntimeTopology;
        try {
          rawRuntimeTopology = await publishRuntimeTopologyReceipt({
            request: { ...request },
            preload,
          });
        } catch (error) {
          throw sanitized(error, 'runtime topology receipt publication failed',
            'ERR_TASK_IMAGE_PROVISION_TOPOLOGY');
        }
        const runtimeTopology = validateRuntimeTopologyAttestation(rawRuntimeTopology);
        const unsigned = {
          schema: TASK_IMAGE_PROVISION_RESULT_SCHEMA,
          sandboxId: request.sandboxId,
          immutableImage: request.immutableImage,
          imageId: request.imageId,
          platform: request.platform,
          daemonSocketHash: sha256(PRIVATE_DOCKER_SOCKET),
          pullReceiptHash,
          inspectReceiptHash,
          marker: markerAttestation,
          runtimeTopology,
        };
        provisionEvidence = deepFreeze({ ...unsigned, evidenceHash: canonicalSha256(unsigned) });
        if (Buffer.byteLength(canonicalJson(provisionEvidence)) > MARKER_MAX_BYTES) {
          fail('provision result exceeds its byte bound', 'ERR_TASK_IMAGE_PROVISION_EVIDENCE');
        }
      } finally {
        markerBytes.fill(0);
      }
      state = 'verified';
      return provisionEvidence;
    } catch (error) {
      primaryFailure = sanitized(
        error,
        'task image provisioning failed',
        'ERR_TASK_IMAGE_PROVISION'
      );
      state = 'failed-dirty';
      try {
        await cleanupResources();
        state = 'failed-clean';
      } catch {
        fail('task image provisioning cleanup failed closed', 'ERR_TASK_IMAGE_PROVISION_CLEANUP');
      }
      throw primaryFailure;
    }
  }

  async function stop() {
    if (state === 'provisioning') {
      fail('task image provisioner cannot stop during provisioning', 'ERR_TASK_IMAGE_PROVISION_LIFECYCLE');
    }
    if (state === 'cleaned' || state === 'failed-clean') return cleanupEvidence;
    if (state === 'idle') {
      state = 'cleaned';
      return null;
    }
    try {
      const result = await cleanupResources();
      state = provisionEvidence ? 'cleaned' : 'failed-clean';
      return result;
    } catch (error) {
      state = 'failed-dirty';
      throw sanitized(error, 'task image cleanup failed closed', 'ERR_TASK_IMAGE_PROVISION_CLEANUP');
    }
  }

  function snapshot() {
    return deepFreeze({
      schema: 'engineer-task-image-provisioner-snapshot.v1',
      state,
      sandboxIdHash: identity ? sha256(identity.sandboxId) : null,
      immutableImageHash: identity ? sha256(identity.immutableImage) : null,
      imageIdHash: identity ? sha256(identity.imageId) : null,
      platformHash: identity ? sha256(identity.platform) : null,
      markerSha256: provisionEvidence?.marker.sha256 ?? null,
      runtimeTopologySha256: provisionEvidence?.runtimeTopology.sha256 ?? null,
      provisionEvidenceHash: provisionEvidence?.evidenceHash ?? null,
      cleanupEvidenceHash: cleanupEvidence?.evidenceHash ?? null,
    });
  }

  return Object.freeze({
    provision,
    start: provision,
    stop,
    cleanup: stop,
    snapshot,
  });
}

function writableStream(value, label) {
  if (!value || typeof value.write !== 'function') {
    fail(`${label} must expose write()`, 'ERR_TASK_IMAGE_PROVISION_CLI');
  }
  return value;
}

function boundedCliJson(value) {
  const encoded = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(encoded) > MARKER_MAX_BYTES || secretBearing(encoded)) {
    fail('CLI evidence is oversized or secret-bearing', 'ERR_TASK_IMAGE_PROVISION_EVIDENCE');
  }
  return encoded;
}

/** Execute the fixed entrypoint without terminating the embedding process. */
export async function runTaskImageProvisionerCli({
  argv = process.argv.slice(2),
  provisioner: suppliedProvisioner = null,
  provisionerOptions = {},
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const output = writableStream(stdout, 'stdout');
  const errors = writableStream(stderr, 'stderr');
  let provisioner = suppliedProvisioner;
  try {
    try {
      scrubDaytonaPlatformMetadataInPlace(process.env);
    } catch {
      fail('ambient Daytona platform metadata is invalid', 'ERR_TASK_IMAGE_PROVISION_ENVIRONMENT');
    }
    assertCredentialFreeEnvironment(process.env);
    const request = parseTaskImageProvisionerArgs(argv);
    provisioner ??= createTaskImageProvisioner(provisionerOptions);
    if (!provisioner || typeof provisioner.provision !== 'function' || typeof provisioner.stop !== 'function') {
      fail('CLI provisioner is invalid', 'ERR_TASK_IMAGE_PROVISION_CLI');
    }
    const evidence = await provisioner.provision(request);
    output.write(boundedCliJson(evidence));
    return 0;
  } catch (error) {
    try { await provisioner?.stop?.(); } catch { /* failure response remains fail-closed */ }
    const code = error instanceof TaskImageProvisionerError &&
      /^ERR_TASK_IMAGE_PROVISION(?:_[A-Z]+)*$/.test(error.code)
      ? error.code
      : 'ERR_TASK_IMAGE_PROVISION_FAILED';
    errors.write(`${JSON.stringify({ schema: CLI_FAILURE_SCHEMA, code })}\n`);
    return 70;
  }
}

const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await runTaskImageProvisionerCli();
