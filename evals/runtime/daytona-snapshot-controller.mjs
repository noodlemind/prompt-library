import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const DAYTONA_SNAPSHOT_CLI_VERSION = 'v0.203.0';
export const DAYTONA_SNAPSHOT_RECEIPT_SCHEMA = 'engineer-daytona-snapshot-lifecycle-receipt.v1';

const EXACT_VERSION_OUTPUT = `Daytona CLI version ${DAYTONA_SNAPSHOT_CLI_VERSION}\n`;
const PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 64;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DOCKERFILE_BYTES = 1024 * 1024;
const MAX_ARCHIVES = 32;
const MAX_TOTAL_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
const SELFTEST = '/opt/engineer/bin/engineer-snapshot-selftest';
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9_./:+-]+$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const CREDENTIAL_VALUE = /(?:Bearer [A-Za-z0-9._~+/=-]{12,}|sk-(?:or-v1|ant|proj)-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|ghp_[A-Za-z0-9]{16,}|xox[bp]-[A-Za-z0-9-]{12,}|hf_[A-Za-z0-9]{16,})/;
const CREDENTIAL_SCAN_TAIL_BYTES = 256;

export class DaytonaSnapshotControllerError extends Error {
  constructor(message, code = 'ERR_DAYTONA_SNAPSHOT_CONTROLLER') {
    super(message);
    this.name = 'DaytonaSnapshotControllerError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new DaytonaSnapshotControllerError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`, 'ERR_SNAPSHOT_INPUT');
  const allowed = new Set(expected);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    fail(`${label} contains an unexpected field or is missing a required field`, 'ERR_SNAPSHOT_INPUT');
  }
}

function optionKeys(value, expected) {
  if (!plainObject(value)) throw new TypeError('snapshot controller options must be a plain object');
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError('snapshot controller options contain an unexpected field');
  }
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function hasCredentialMarker(bytes) {
  return CREDENTIAL_VALUE.test(bytes.toString('latin1'));
}

function assertCredentialFreeBytes(value, label) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (hasCredentialMarker(bytes)) {
    fail(`${label} contains credential material`, 'ERR_SNAPSHOT_CREDENTIAL');
  }
}

function assertCredentialFreeString(value, label) {
  if (typeof value !== 'string') return;
  assertCredentialFreeBytes(Buffer.from(value), label);
}

function safeAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length < 2 || Buffer.byteLength(value) > 1024 ||
      value.includes('\0') || path.normalize(value) !== value || !path.isAbsolute(value) ||
      !SAFE_ABSOLUTE_PATH.test(value)) {
    fail(`${label} must be a bounded normalized absolute file path`, 'ERR_SNAPSHOT_INPUT');
  }
  assertCredentialFreeString(value, label);
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}

async function inspectRegularFile(filePath, {
  expectedHash = null,
  maximumBytes,
  label,
}) {
  let before;
  try {
    before = await fs.promises.lstat(filePath);
  } catch {
    fail(`${label} is not an accessible regular file`, 'ERR_SNAPSHOT_FILE');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumBytes) {
    fail(`${label} must be a bounded regular file`, 'ERR_SNAPSHOT_FILE');
  }

  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
  } catch {
    fail(`${label} could not be opened as a regular file`, 'ERR_SNAPSHOT_FILE');
  }

  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let tail = Buffer.alloc(0);
  let bytesReadTotal = 0;
  let opened;
  let after;
  try {
    opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      fail(`${label} changed before it could be verified`, 'ERR_SNAPSHOT_FILE_RACE');
    }
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > maximumBytes) fail(`${label} exceeds its byte bound`, 'ERR_SNAPSHOT_FILE');
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      const scanned = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      if (hasCredentialMarker(scanned)) {
        fail(`${label} contains credential material`, 'ERR_SNAPSHOT_CREDENTIAL');
      }
      tail = Buffer.from(scanned.subarray(Math.max(0, scanned.length - CREDENTIAL_SCAN_TAIL_BYTES)));
    }
    after = await handle.stat();
  } finally {
    buffer.fill(0);
    tail.fill(0);
    await handle.close().catch(() => {});
  }
  if (!sameFileIdentity(opened, after) || bytesReadTotal !== opened.size) {
    fail(`${label} changed while it was being verified`, 'ERR_SNAPSHOT_FILE_RACE');
  }
  const observedHash = digest.digest('hex');
  if (expectedHash !== null && observedHash !== expectedHash) {
    fail(`${label} digest does not match its declared content identity`, 'ERR_SNAPSHOT_DIGEST');
  }
  return Object.freeze({ path: filePath, sha256: observedHash, byteLength: bytesReadTotal });
}

function decodeOutput(value, label, maximumBytes) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maximumBytes) {
      fail(`${label} exceeds its byte bound`, 'ERR_SNAPSHOT_OUTPUT_BOUND');
    }
    assertCredentialFreeString(value, label);
    return value;
  }
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail(`${label} has an invalid type`, 'ERR_SNAPSHOT_RUNNER_RESULT');
  }
  const bytes = Buffer.from(value);
  if (bytes.length > maximumBytes) fail(`${label} exceeds its byte bound`, 'ERR_SNAPSHOT_OUTPUT_BOUND');
  assertCredentialFreeBytes(bytes, label);
  try {
    return UTF8.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`, 'ERR_SNAPSHOT_RUNNER_RESULT');
  }
}

function normalizeRunnerResult(value, maximumBytes) {
  if (!plainObject(value)) fail('Daytona command runner returned a malformed result', 'ERR_SNAPSHOT_RUNNER_RESULT');
  const allowed = new Set(['code', 'stdout', 'stderr', 'error']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail('Daytona command runner returned an unexpected field', 'ERR_SNAPSHOT_RUNNER_RESULT');
  }
  if (!Number.isInteger(value.code)) {
    fail('Daytona command runner returned an invalid exit code', 'ERR_SNAPSHOT_RUNNER_RESULT');
  }
  if (value.error != null) {
    const detail = sha256(String(value.error?.message ?? value.error)).slice(0, 16);
    fail(`Daytona command runner failed (detail sha256:${detail})`, 'ERR_SNAPSHOT_COMMAND');
  }
  return Object.freeze({
    code: value.code,
    stdout: decodeOutput(value.stdout ?? '', 'Daytona command stdout', maximumBytes),
    stderr: decodeOutput(value.stderr ?? '', 'Daytona command stderr', maximumBytes),
  });
}

function commandError(label, result) {
  const detail = sha256(`${result.code}\0${result.stdout}\0${result.stderr}`).slice(0, 16);
  return new DaytonaSnapshotControllerError(
    `${label} failed (detail sha256:${detail})`,
    'ERR_SNAPSHOT_COMMAND',
  );
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} JSON is malformed`, 'ERR_SNAPSHOT_JSON');
  }
}

function safeRemoteId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail(`${label} is malformed`, 'ERR_SNAPSHOT_RECORD');
  }
  assertCredentialFreeString(value, label);
  return value;
}

function validateListRecord(value) {
  if (!plainObject(value)) fail('snapshot list contains a malformed record', 'ERR_SNAPSHOT_RECORD');
  safeRemoteId(value.id, 'snapshot record id');
  safeRemoteId(value.name, 'snapshot record name');
  if (typeof value.state !== 'string' || value.state.length < 1 || value.state.length > 64) {
    fail('snapshot list contains a malformed status', 'ERR_SNAPSHOT_RECORD');
  }
  if (Object.hasOwn(value, 'buildHash') && (typeof value.buildHash !== 'string' || !HASH.test(value.buildHash))) {
    fail('snapshot list contains a malformed content identity', 'ERR_SNAPSHOT_RECORD');
  }
  return value;
}

function exactStringArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function snapshotMismatch(record, prepared) {
  if (record.name !== prepared.identity.name || record.state !== 'active' || record.cpu !== 2 ||
      record.mem !== 4 || record.disk !== 10 || record.gpu !== 0 || record.general !== false ||
      record.sandboxClass !== 'container' || !exactStringArray(record.regionIds, ['us']) ||
      record.skipValidation !== false || !(record.errorReason === null || record.errorReason === '')) {
    return true;
  }
  return false;
}

function findSnapshot(records, prepared) {
  const match = records.find((record) => record.name === prepared.identity.name);
  if (!match) return null;
  if (snapshotMismatch(match, prepared)) {
    fail('snapshot record does not exactly match the requested content identity and active topology',
      'ERR_SNAPSHOT_RECORD_MISMATCH');
  }
  return match;
}

function validateSandbox(value) {
  if (!plainObject(value)) fail('Daytona sandbox inspection JSON must be an object', 'ERR_SNAPSHOT_SANDBOX');
  return safeRemoteId(value.id, 'validation sandbox id');
}

function validateExactSandbox(value, expected) {
  const id = validateSandbox(value);
  if (value.name !== expected.name || value.snapshot !== expected.snapshot || value.state !== 'started' ||
      value.desiredState !== 'started' || value.target !== 'us' || value.sandboxClass !== 'container' ||
      value.cpu !== 2 || value.memory !== 4096 || value.disk !== 10 || value.networkBlockAll !== true ||
      value.public !== false || !plainObject(value.env) || Object.keys(value.env).length !== 0 ||
      !Array.isArray(value.volumes) || value.volumes.length !== 0) {
    fail('validation sandbox identity or provider-free status mismatch', 'ERR_SNAPSHOT_SANDBOX_MISMATCH');
  }
  return id;
}

function regexpEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactSandboxNotFound(result, identity) {
  if (result.code !== 1 || result.stdout !== '' || Buffer.byteLength(result.stderr) > 512) return false;
  return new RegExp(
    `^time="[^"\\r\\n]{1,64}" level=fatal msg="Not Found: Sandbox with ID or name ${regexpEscape(identity)} not found"\\n?$`,
  ).test(result.stderr);
}

function lifecycleReceipt(record, prepared, created, validation) {
  return Object.freeze({
    schema: DAYTONA_SNAPSHOT_RECEIPT_SCHEMA,
    name: prepared.identity.name,
    snapshotId: record.id,
    buildHash: prepared.identity.buildHash,
    status: 'active',
    created,
    retained: true,
    archiveCount: prepared.archives.length,
    validation: Object.freeze(validation),
  });
}

async function prepareRequest(input, maximumFileBytes) {
  exactKeys(input, ['identity', 'dockerfilePath', 'archives'], 'snapshot lifecycle request');
  exactKeys(input.identity, ['name', 'buildHash'], 'snapshot identity');
  if (typeof input.identity.buildHash !== 'string' || !HASH.test(input.identity.buildHash)) {
    fail('snapshot buildHash must be a lowercase SHA-256 digest', 'ERR_SNAPSHOT_INPUT');
  }
  const expectedName = `engineer-eval-${input.identity.buildHash.slice(0, 32)}`;
  if (input.identity.name !== expectedName) {
    fail('snapshot name does not match its content buildHash', 'ERR_SNAPSHOT_INPUT');
  }
  safeRemoteId(input.identity.name, 'snapshot name');
  const dockerfilePath = safeAbsolutePath(input.dockerfilePath, 'dockerfilePath');
  if (!Array.isArray(input.archives) || input.archives.length < 1 || input.archives.length > MAX_ARCHIVES) {
    fail(`archives must contain between 1 and ${MAX_ARCHIVES} deterministic files`, 'ERR_SNAPSHOT_INPUT');
  }

  const declared = input.archives.map((archive) => {
    exactKeys(archive, ['path', 'sha256'], 'archive record');
    const archivePath = safeAbsolutePath(archive.path, 'archive path');
    if (typeof archive.sha256 !== 'string' || !HASH.test(archive.sha256)) {
      fail('archive sha256 must be a lowercase digest', 'ERR_SNAPSHOT_INPUT');
    }
    return { path: archivePath, sha256: archive.sha256 };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (let index = 1; index < declared.length; index += 1) {
    if (declared[index - 1].path === declared[index].path) {
      fail('archives contain a duplicate deterministic file', 'ERR_SNAPSHOT_INPUT');
    }
  }

  const dockerfile = await inspectRegularFile(dockerfilePath, {
    maximumBytes: Math.min(maximumFileBytes, MAX_DOCKERFILE_BYTES),
    label: 'Dockerfile',
  });
  const archives = [];
  let totalBytes = 0;
  for (const archive of declared) {
    const inspected = await inspectRegularFile(archive.path, {
      expectedHash: archive.sha256,
      maximumBytes: maximumFileBytes,
      label: 'deterministic archive',
    });
    totalBytes += inspected.byteLength;
    if (totalBytes > MAX_TOTAL_ARCHIVE_BYTES) {
      fail('deterministic archives exceed their aggregate byte bound', 'ERR_SNAPSHOT_FILE');
    }
    archives.push(inspected);
  }
  return Object.freeze({
    identity: Object.freeze({ ...input.identity }),
    dockerfile,
    archives: Object.freeze(archives),
  });
}

export function createDaytonaSnapshotController(options = {}) {
  optionKeys(options, [
    'runCommand', 'cleanupPollAttempts', 'cleanupPollIntervalMs', 'maxPages',
    'maxOutputBytes', 'maxFileBytes',
  ]);
  const {
    runCommand,
    cleanupPollAttempts = 20,
    cleanupPollIntervalMs = 250,
    maxPages = DEFAULT_MAX_PAGES,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  } = options;
  if (typeof runCommand !== 'function') throw new TypeError('runCommand must be an injected fixed-argv function');
  boundedInteger(cleanupPollAttempts, 'cleanupPollAttempts', 1, 100);
  boundedInteger(cleanupPollIntervalMs, 'cleanupPollIntervalMs', 0, 60_000);
  boundedInteger(maxPages, 'maxPages', 1, 1_000);
  boundedInteger(maxOutputBytes, 'maxOutputBytes', 1024, 16 * 1024 * 1024);
  boundedInteger(maxFileBytes, 'maxFileBytes', 1, DEFAULT_MAX_FILE_BYTES);

  let versionVerified = false;
  let busy = false;

  async function invokeRaw(args) {
    if (!Array.isArray(args) || args.length < 1 || args.length > 128 ||
        args.some((arg) => typeof arg !== 'string' || arg.length < 1 || Buffer.byteLength(arg) > 2048 ||
          arg.includes('\0'))) {
      fail('internal Daytona argv violated its fixed-argument contract', 'ERR_SNAPSHOT_ARGV');
    }
    const fixedArgv = Object.freeze([...args]);
    let result;
    try {
      result = await runCommand(fixedArgv);
    } catch (error) {
      const detail = sha256(String(error?.message ?? error)).slice(0, 16);
      fail(`Daytona command runner threw (detail sha256:${detail})`, 'ERR_SNAPSHOT_COMMAND');
    }
    return normalizeRunnerResult(result, maxOutputBytes);
  }

  async function invoke(args, label) {
    const result = await invokeRaw(args);
    if (result.code !== 0 || result.stderr !== '') throw commandError(label, result);
    return result;
  }

  async function verifyVersion() {
    if (versionVerified) return;
    const result = await invokeRaw(['--version']);
    if (result.code !== 0 || result.stdout !== EXACT_VERSION_OUTPUT || result.stderr !== '') {
      fail('Daytona CLI version does not match the exact reviewed v0.203.0 contract',
        'ERR_SNAPSHOT_VERSION');
    }
    versionVerified = true;
  }

  async function listSnapshots() {
    const records = [];
    const ids = new Set();
    const names = new Set();
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await invoke([
        'snapshot', 'list', '--format', 'json', '--limit', String(PAGE_LIMIT), '--page', String(page),
      ], 'Daytona snapshot list');
      const value = parseJson(result.stdout, 'Daytona snapshot list');
      if (!Array.isArray(value) || value.length > PAGE_LIMIT) {
        fail('Daytona snapshot list JSON is malformed or exceeds its page bound', 'ERR_SNAPSHOT_JSON');
      }
      for (const candidate of value) {
        const record = validateListRecord(candidate);
        if (ids.has(record.id) || names.has(record.name)) {
          fail('Daytona snapshot list contains a duplicate snapshot identity', 'ERR_SNAPSHOT_RECORD_DUPLICATE');
        }
        ids.add(record.id);
        names.add(record.name);
        records.push(record);
      }
      if (value.length < PAGE_LIMIT) return records;
    }
    fail('Daytona snapshot pagination exceeded its bounded page count', 'ERR_SNAPSHOT_PAGE_BOUND');
  }

  async function wait() {
    if (cleanupPollIntervalMs === 0) return;
    await new Promise((resolve) => setTimeout(resolve, cleanupPollIntervalMs));
  }

  async function rollbackSnapshot(prepared) {
    try {
      await invokeRaw(['snapshot', 'delete', prepared.identity.name]);
    } catch {
      // Absence is authoritative; a lost delete response is tolerated only when every page proves absence.
    }
    for (let attempt = 0; attempt < cleanupPollAttempts; attempt += 1) {
      try {
        const records = await listSnapshots();
        const present = records.some((record) =>
          record.name === prepared.identity.name || record.buildHash === prepared.identity.buildHash);
        if (!present) return;
      } catch {
        // A malformed or incomplete observation cannot prove cleanup; retry within the fixed bound.
      }
      if (attempt + 1 < cleanupPollAttempts) await wait();
    }
    fail('snapshot rollback could not prove absence across all paginated records', 'ERR_SNAPSHOT_ROLLBACK');
  }

  async function deleteAndConfirmSandbox(identity) {
    let deletionError = null;
    try {
      const deletion = await invokeRaw(['delete', identity]);
      if (deletion.code !== 0 || deletion.stderr !== '') deletionError = commandError('validation sandbox deletion', deletion);
    } catch (error) {
      deletionError = error;
    }

    let absent = false;
    for (let attempt = 0; attempt < cleanupPollAttempts; attempt += 1) {
      let inspected;
      try {
        inspected = await invokeRaw(['info', identity, '--format', 'json']);
      } catch (error) {
        if (!deletionError) deletionError = error;
        break;
      }
      if (exactSandboxNotFound(inspected, identity)) {
        absent = true;
        break;
      }
      if (inspected.code === 0 && inspected.stderr === '') {
        const value = parseJson(inspected.stdout, 'Daytona validation sandbox deletion inspection');
        if (!plainObject(value) || value.id !== identity && value.name !== identity) {
          fail('validation sandbox deletion inspection returned a mismatched identity',
            'ERR_SNAPSHOT_SANDBOX_CLEANUP');
        }
      } else {
        deletionError = commandError('validation sandbox deletion inspection', inspected);
        break;
      }
      if (attempt + 1 < cleanupPollAttempts) await wait();
    }
    if (!absent) {
      fail('validation sandbox deletion did not return the exact Not Found proof',
        'ERR_SNAPSHOT_SANDBOX_CLEANUP');
    }
    if (deletionError) throw deletionError;
  }

  async function validateCreatedSnapshot(prepared) {
    const sandboxName = `${prepared.identity.name}-selftest`;
    let sandboxMayExist = false;
    let cleanupIdentity = sandboxName;
    let lifecycleError = null;
    let validation = null;
    try {
      sandboxMayExist = true;
      await invoke([
        'create', '--name', sandboxName, '--snapshot', prepared.identity.name,
        '--cpu', '2', '--memory', '4096', '--disk', '10', '--target', 'us',
        '--network-block-all', '--auto-stop', '0', '--ttl', '30',
      ], 'Daytona validation sandbox creation');
      const selfTest = await invoke([
        'exec', sandboxName, '--', SELFTEST, '--expected-build-hash', prepared.identity.buildHash,
      ], 'Daytona snapshot self-test');
      const expectedSelfTest = `ENGINEER-SNAPSHOT/1 ${prepared.identity.buildHash}\n`;
      if (selfTest.stdout !== expectedSelfTest || selfTest.stderr !== '') {
        fail('Daytona snapshot self-test did not attest the exact content identity',
          'ERR_SNAPSHOT_SELFTEST_IDENTITY');
      }
      const inspected = await invoke(['info', sandboxName, '--format', 'json'],
        'Daytona validation sandbox inspection');
      const observed = parseJson(inspected.stdout, 'Daytona validation sandbox inspection');
      const sandboxId = validateExactSandbox(observed, {
        name: sandboxName,
        snapshot: prepared.identity.name,
      });
      cleanupIdentity = sandboxId;
      validation = {
        performed: true,
        sandboxId,
        networkBlocked: true,
        selfTestExitCode: selfTest.code,
        selfTestStdoutBytes: Buffer.byteLength(selfTest.stdout),
        selfTestStdoutSha256: sha256(selfTest.stdout),
        selfTestStderrBytes: Buffer.byteLength(selfTest.stderr),
        selfTestStderrSha256: sha256(selfTest.stderr),
        sandboxDeleted: true,
      };
    } catch (error) {
      lifecycleError = error;
    }

    let cleanupError = null;
    if (sandboxMayExist) {
      try {
        await deleteAndConfirmSandbox(cleanupIdentity);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (lifecycleError && cleanupError) {
      fail('snapshot validation failed and temporary sandbox cleanup was not confirmed',
        'ERR_SNAPSHOT_SANDBOX_CLEANUP');
    }
    if (lifecycleError) throw lifecycleError;
    if (cleanupError) throw cleanupError;
    return validation;
  }

  async function ensureSnapshot(input) {
    if (busy) fail('snapshot lifecycle controller is already active', 'ERR_SNAPSHOT_CONCURRENT');
    busy = true;
    try {
      const prepared = await prepareRequest(input, maxFileBytes);
      await verifyVersion();
      const existing = findSnapshot(await listSnapshots(), prepared);
      if (existing) {
        const validation = await validateCreatedSnapshot(prepared);
        return lifecycleReceipt(existing, prepared, false, validation);
      }

      let createAttempted = false;
      try {
        createAttempted = true;
        await invoke([
          'snapshot', 'create', prepared.identity.name,
          '--dockerfile', prepared.dockerfile.path,
          ...prepared.archives.flatMap((archive) => ['--context', archive.path]),
          '--cpu', '2', '--memory', '4', '--disk', '10', '--region', 'us',
          '--sandbox-class', 'container',
        ], 'Daytona snapshot creation');
        const created = findSnapshot(await listSnapshots(), prepared);
        if (!created) fail('new Daytona snapshot is absent from the complete paginated list',
          'ERR_SNAPSHOT_RECORD_MISSING');
        const validation = await validateCreatedSnapshot(prepared);
        return lifecycleReceipt(created, prepared, true, validation);
      } catch (error) {
        if (createAttempted) {
          try {
            await rollbackSnapshot(prepared);
          } catch {
            fail('snapshot lifecycle failed and rollback absence was not proven', 'ERR_SNAPSHOT_ROLLBACK');
          }
        }
        throw error;
      }
    } finally {
      busy = false;
    }
  }

  return Object.freeze({ ensureSnapshot });
}
