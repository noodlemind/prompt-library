import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  CREDENTIAL_SCAN_TAIL_BYTES,
  findCredentialMarkerRanges,
  hasCredentialMarker,
  MAX_CREDENTIAL_MARKER_RANGES,
} from './credential-material.mjs';
import { verifyDeterministicUstarCredentialRanges } from './deterministic-ustar-verifier.mjs';
import {
  DAYTONA_DIND_EXECUTABLE_SHA256,
  DAYTONA_EXECUTABLE_PATHS,
} from './daytona-topology.mjs';
import {
  snapshotBuildManifestHash,
  validateSnapshotBuildManifest,
} from './snapshot-build-manifest.mjs';

export const DAYTONA_SNAPSHOT_CLI_VERSION = 'v0.203.0';
export const DAYTONA_SNAPSHOT_RECEIPT_SCHEMA = 'engineer-daytona-snapshot-lifecycle-receipt.v1';

const EXACT_VERSION_OUTPUT = `Daytona CLI version ${DAYTONA_SNAPSHOT_CLI_VERSION}\n`;
const PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 64;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DOCKERFILE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
const SELFTEST = '/opt/engineer/bin/engineer-snapshot-selftest';
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9_./:+-]+$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const ATTESTED_USTAR_EXECUTABLE_DIGESTS = Object.freeze(Object.fromEntries(
  Object.entries(DAYTONA_DIND_EXECUTABLE_SHA256).map(([name, digest]) => [
    DAYTONA_EXECUTABLE_PATHS[name].slice(1),
    digest,
  ]),
));
const SNAPSHOT_CONTEXT_POLICY = Object.freeze({
  runtime: Object.freeze({ encoding: 'ustar', fileName: 'runtime.tar' }),
  harbor: Object.freeze({ encoding: 'ustar', fileName: 'harbor.tar' }),
  node: Object.freeze({ encoding: 'ustar', fileName: 'node.tar' }),
  native: Object.freeze({ encoding: 'ustar', fileName: 'native.tar' }),
  manifest: Object.freeze({ encoding: 'snapshot-manifest', fileName: 'build-manifest.json' }),
});
const SNAPSHOT_CONTEXT_KINDS = Object.freeze(Object.keys(SNAPSHOT_CONTEXT_POLICY));
const CUSTODY_FILE_NAMES = Object.freeze([
  'Dockerfile',
  ...Object.values(SNAPSHOT_CONTEXT_POLICY).map((policy) => policy.fileName),
].sort());

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

function noFollowFlag() {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    fail('no-follow file custody is unavailable', 'ERR_SNAPSHOT_PLATFORM');
  }
  return fs.constants.O_NOFOLLOW;
}

function directoryFlag() {
  if (!Number.isInteger(fs.constants.O_DIRECTORY)) {
    fail('directory-handle custody is unavailable', 'ERR_SNAPSHOT_PLATFORM');
  }
  return fs.constants.O_DIRECTORY;
}

function effectiveUid() {
  if (typeof process.geteuid !== 'function') {
    fail('POSIX custody ownership checks are unavailable', 'ERR_SNAPSHOT_PLATFORM');
  }
  return BigInt(process.geteuid());
}

function boundedStatSize(stat, maximumBytes, label) {
  if (typeof stat.size !== 'bigint' || stat.size < 1n || stat.size > BigInt(maximumBytes)) {
    fail(`${label} must be a bounded regular file`, 'ERR_SNAPSHOT_FILE');
  }
  return Number(stat.size);
}

function capturedIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode &&
    left.nlink === right.nlink && left.uid === right.uid && left.gid === right.gid;
}

function sameDirectoryAnchor(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid;
}

async function copyStableRegularFile(sourcePath, destinationPath, maximumBytes, label) {
  let before;
  try {
    before = await fs.promises.lstat(sourcePath, { bigint: true });
  } catch {
    fail(`${label} is not an accessible regular file`, 'ERR_SNAPSHOT_FILE');
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    fail(`${label} must be a bounded regular file`, 'ERR_SNAPSHOT_FILE');
  }
  const sourceSize = boundedStatSize(before, maximumBytes, label);
  const noFollow = noFollowFlag();
  let source;
  let destination;
  let destinationIdentity = null;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let copied = 0;
  let operationError = null;
  try {
    source = await fs.promises.open(sourcePath, fs.constants.O_RDONLY | noFollow);
    const opened = await source.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      fail(`${label} changed before it could be copied`, 'ERR_SNAPSHOT_FILE_RACE');
    }
    destination = await fs.promises.open(
      destinationPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o400,
    );
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      copied += bytesRead;
      if (copied > maximumBytes) fail(`${label} exceeds its byte bound`, 'ERR_SNAPSHOT_FILE');
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null);
        if (result.bytesWritten === 0) fail(`${label} custody copy stopped early`, 'ERR_SNAPSHOT_FILE');
        written += result.bytesWritten;
      }
    }
    const after = await source.stat({ bigint: true });
    const namedAfter = await fs.promises.lstat(sourcePath, { bigint: true });
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, namedAfter) ||
        copied !== sourceSize) {
      fail(`${label} changed while it was copied`, 'ERR_SNAPSHOT_FILE_RACE');
    }
    await destination.sync();
    const copiedStat = await destination.stat({ bigint: true });
    const namedDestination = await fs.promises.lstat(destinationPath, { bigint: true });
    if (!copiedStat.isFile() || copiedStat.size !== BigInt(copied) ||
        !sameFileIdentity(copiedStat, namedDestination)) {
      fail(`${label} custody copy is incomplete`, 'ERR_SNAPSHOT_FILE');
    }
    destinationIdentity = capturedIdentity(copiedStat);
  } catch (error) {
    operationError = error instanceof DaytonaSnapshotControllerError
      ? error
      : new DaytonaSnapshotControllerError(
        `${label} could not be copied into controller custody`,
        'ERR_SNAPSHOT_FILE',
      );
  } finally {
    buffer.fill(0);
  }
  if (destination && destinationIdentity === null) {
    try {
      const opened = await destination.stat({ bigint: true });
      const named = await fs.promises.lstat(destinationPath, { bigint: true });
      if (opened.isFile() && !named.isSymbolicLink() && sameFileIdentity(opened, named)) {
        destinationIdentity = capturedIdentity(opened);
      }
    } catch {
      // An unprovable partial destination is quarantined below.
    }
  }
  let closeFailed = false;
  for (const handle of [source, destination]) {
    if (!handle) continue;
    try { await handle.close(); } catch { closeFailed = true; }
  }
  if (closeFailed) {
    fail(`${label} copy handles did not close cleanly`, 'ERR_SNAPSHOT_CUSTODY_HANDLE');
  }
  if (operationError) {
    if (destination && destinationIdentity !== null) {
      let named;
      try { named = await fs.promises.lstat(destinationPath, { bigint: true }); } catch {
        fail(`${label} partial custody identity is unavailable`, 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
      }
      if (!named.isFile() || named.isSymbolicLink() ||
          !sameFileIdentity(destinationIdentity, named)) {
        fail(`${label} partial custody identity changed`, 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
      }
      try { await fs.promises.unlink(destinationPath); } catch {
        fail(`${label} partial custody file could not be removed`, 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
      }
    } else if (destination) {
      fail(`${label} partial custody identity is unavailable`, 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
    }
    throw operationError;
  }
  return Object.freeze({ path: destinationPath, identity: destinationIdentity });
}

async function closeHandleOrFail(handle, label) {
  try {
    await handle.close();
  } catch {
    fail(`${label} handle did not close cleanly`, 'ERR_SNAPSHOT_CUSTODY_HANDLE');
  }
}

async function inspectRegularFile(filePath, {
  expectedHash = null,
  maximumBytes,
  label,
  allowedUstarExecutableDigests = null,
}) {
  let before;
  try {
    before = await fs.promises.lstat(filePath, { bigint: true });
  } catch {
    fail(`${label} is not an accessible regular file`, 'ERR_SNAPSHOT_FILE');
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    fail(`${label} must be a bounded regular file`, 'ERR_SNAPSHOT_FILE');
  }
  const expectedSize = boundedStatSize(before, maximumBytes, label);

  const noFollow = noFollowFlag();
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
  const credentialRanges = [];
  let semanticUstar = null;
  try {
    opened = await handle.stat({ bigint: true });
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
      const chunkStart = bytesReadTotal - bytesRead;
      const scannedStart = chunkStart - tail.length;
      let observedRanges;
      try {
        observedRanges = findCredentialMarkerRanges(scanned, scannedStart);
      } catch {
        fail(`${label} contains credential material`, 'ERR_SNAPSHOT_CREDENTIAL');
      }
      for (const range of observedRanges) {
        if (range.end <= chunkStart) continue;
        if (allowedUstarExecutableDigests === null) {
          fail(`${label} contains credential material`, 'ERR_SNAPSHOT_CREDENTIAL');
        }
        const previous = credentialRanges.at(-1);
        if (previous?.start === range.start && previous?.end === range.end) continue;
        credentialRanges.push(range);
        if (credentialRanges.length > MAX_CREDENTIAL_MARKER_RANGES) {
          fail(`${label} contains credential material`, 'ERR_SNAPSHOT_CREDENTIAL');
        }
      }
      tail = Buffer.from(scanned.subarray(Math.max(0, scanned.length - CREDENTIAL_SCAN_TAIL_BYTES)));
    }
    if (allowedUstarExecutableDigests !== null) {
      let verified = false;
      try {
        semanticUstar = await verifyDeterministicUstarCredentialRanges({
          handle,
          byteLength: expectedSize,
          credentialRanges,
          allowedExecutableDigests: allowedUstarExecutableDigests,
        });
        verified = true;
      } catch {
        // Verification errors are intentionally collapsed so paths and bytes never reach logs.
      }
      if (!verified) fail(`${label} contains credential material`, 'ERR_SNAPSHOT_CREDENTIAL');
    }
    after = await handle.stat({ bigint: true });
  } catch (error) {
    await closeHandleOrFail(handle, label);
    throw error;
  } finally {
    buffer.fill(0);
    tail.fill(0);
  }
  if (!sameFileIdentity(opened, after) || bytesReadTotal !== expectedSize) {
    await closeHandleOrFail(handle, label);
    fail(`${label} changed while it was being verified`, 'ERR_SNAPSHOT_FILE_RACE');
  }
  const observedHash = digest.digest('hex');
  if (expectedHash !== null && observedHash !== expectedHash) {
    await closeHandleOrFail(handle, label);
    fail(`${label} digest does not match its declared content identity`, 'ERR_SNAPSHOT_DIGEST');
  }
  return Object.freeze({
    path: filePath,
    sha256: observedHash,
    byteLength: bytesReadTotal,
    identity: capturedIdentity(after),
    handle,
    semanticUstar,
  });
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

async function createCustodyDirectory() {
  let directory;
  let handle;
  try {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engineer-snapshot-custody-'));
    await fs.promises.chmod(directory, 0o700);
    const canonical = await fs.promises.realpath(directory);
    handle = await fs.promises.open(
      canonical,
      fs.constants.O_RDONLY | noFollowFlag() | directoryFlag(),
    );
    const stat = await fs.promises.lstat(canonical, { bigint: true });
    const opened = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(stat, opened) ||
        (stat.mode & 0o777n) !== 0o700n || stat.uid !== effectiveUid()) {
      fail('snapshot custody directory is not owner-private', 'ERR_SNAPSHOT_CUSTODY');
    }
    return Object.freeze({
      path: canonical,
      handle,
      initialIdentity: capturedIdentity(opened),
    });
  } catch (error) {
    let closeFailed = false;
    if (handle) {
      try { await handle.close(); } catch { closeFailed = true; }
    }
    let removalFailed = false;
    if (directory && !closeFailed) {
      try { await fs.promises.rmdir(directory); } catch { removalFailed = true; }
    }
    if (closeFailed || removalFailed) {
      fail('snapshot custody directory creation cleanup was incomplete',
        'ERR_SNAPSHOT_CUSTODY_CLEANUP');
    }
    if (error instanceof DaytonaSnapshotControllerError) throw error;
    fail('snapshot custody directory could not be created', 'ERR_SNAPSHOT_CUSTODY');
  }
}

async function hashOpenFile(handle, byteLength) {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    while (offset < byteLength) {
      const requested = Math.min(buffer.length, byteLength - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead === 0) fail('custodied file ended before its bound', 'ERR_SNAPSHOT_CUSTODY');
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return digest.digest('hex');
  } finally {
    buffer.fill(0);
  }
}

async function readOpenFile(handle, byteLength, maximumBytes, label) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > maximumBytes) {
    fail(`${label} exceeds its byte bound`, 'ERR_SNAPSHOT_MANIFEST');
  }
  const bytes = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  try {
    while (offset < byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, byteLength - offset, offset);
      if (bytesRead === 0) fail(`${label} ended before its bound`, 'ERR_SNAPSHOT_MANIFEST');
      offset += bytesRead;
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

async function revalidateCustodiedFile(record, label, { verifyHash = true } = {}) {
  let named;
  let opened;
  try {
    named = await fs.promises.lstat(record.path, { bigint: true });
    opened = await record.handle.stat({ bigint: true });
  } catch {
    fail(`${label} custody identity is unavailable`, 'ERR_SNAPSHOT_CUSTODY');
  }
  if (!named.isFile() || named.isSymbolicLink() || !sameFileIdentity(record.identity, named) ||
      !sameFileIdentity(record.identity, opened)) {
    fail(`${label} custody identity changed`, 'ERR_SNAPSHOT_CUSTODY');
  }
  if (verifyHash) {
    const observedHash = await hashOpenFile(record.handle, record.byteLength);
    if (observedHash !== record.sha256) {
      fail(`${label} custody content changed`, 'ERR_SNAPSHOT_CUSTODY');
    }
    let namedAfter;
    let openedAfter;
    try {
      namedAfter = await fs.promises.lstat(record.path, { bigint: true });
      openedAfter = await record.handle.stat({ bigint: true });
    } catch {
      fail(`${label} custody identity is unavailable after hashing`, 'ERR_SNAPSHOT_CUSTODY');
    }
    if (!namedAfter.isFile() || namedAfter.isSymbolicLink() ||
        !sameFileIdentity(record.identity, namedAfter) ||
        !sameFileIdentity(record.identity, openedAfter)) {
      fail(`${label} custody identity changed while hashing`, 'ERR_SNAPSHOT_CUSTODY');
    }
  }
}

function assertCustodiedFileIdentity(record, label) {
  const identity = record.identity;
  if ((identity.mode & 0o777n) !== 0o400n || identity.nlink !== 1n ||
      identity.uid !== effectiveUid()) {
    fail(`${label} custody permissions or ownership drifted`, 'ERR_SNAPSHOT_CUSTODY');
  }
}

async function revalidateCustodyDirectory(prepared) {
  let named;
  let opened;
  let canonical;
  let entries;
  try {
    named = await fs.promises.lstat(prepared.custodyDirectory, { bigint: true });
    opened = await prepared.custodyHandle.stat({ bigint: true });
    canonical = await fs.promises.realpath(prepared.custodyDirectory);
    entries = (await fs.promises.readdir(prepared.custodyDirectory)).sort();
  } catch {
    fail('snapshot custody directory identity is unavailable', 'ERR_SNAPSHOT_CUSTODY');
  }
  if (!named.isDirectory() || named.isSymbolicLink() || !opened.isDirectory() ||
      canonical !== prepared.custodyDirectory || (named.mode & 0o777n) !== 0o500n ||
      !sameFileIdentity(prepared.custodyIdentity, named) ||
      !sameFileIdentity(prepared.custodyIdentity, opened) ||
      entries.length !== CUSTODY_FILE_NAMES.length ||
      entries.some((entry, index) => entry !== CUSTODY_FILE_NAMES[index])) {
    fail('snapshot custody directory identity changed', 'ERR_SNAPSHOT_CUSTODY');
  }
}

async function validateMutableCustodyPath(prepared, expectedNames) {
  let named;
  let opened;
  let canonical;
  let entries;
  try {
    named = await fs.promises.lstat(prepared.custodyDirectory, { bigint: true });
    opened = await prepared.custodyHandle.stat({ bigint: true });
    canonical = await fs.promises.realpath(prepared.custodyDirectory);
    entries = (await fs.promises.readdir(prepared.custodyDirectory)).sort();
  } catch {
    fail('snapshot custody path cannot be mutated safely', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
  const expected = [...expectedNames].sort();
  if (!named.isDirectory() || named.isSymbolicLink() || !opened.isDirectory() ||
      canonical !== prepared.custodyDirectory || !sameDirectoryAnchor(prepared.custodyAnchor, named) ||
      !sameDirectoryAnchor(prepared.custodyAnchor, opened) || !sameDirectoryAnchor(named, opened) ||
      (named.mode & 0o777n) !== 0o700n || entries.length !== expected.length ||
      entries.some((entry, index) => entry !== expected[index])) {
    fail('snapshot custody path cannot be mutated safely', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
}

async function validatePartialCustodyPath(prepared, allowedNames) {
  let named;
  let opened;
  let canonical;
  let entries;
  try {
    named = await fs.promises.lstat(prepared.custodyDirectory, { bigint: true });
    opened = await prepared.custodyHandle.stat({ bigint: true });
    canonical = await fs.promises.realpath(prepared.custodyDirectory);
    entries = (await fs.promises.readdir(prepared.custodyDirectory)).sort();
  } catch {
    fail('partial snapshot custody path cannot be mutated safely', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
  const allowed = new Set(allowedNames);
  const mode = named.mode & 0o777n;
  if (!named.isDirectory() || named.isSymbolicLink() || !opened.isDirectory() ||
      canonical !== prepared.custodyDirectory || !sameDirectoryAnchor(prepared.custodyAnchor, named) ||
      !sameDirectoryAnchor(prepared.custodyAnchor, opened) || !sameDirectoryAnchor(named, opened) ||
      ![0o500n, 0o700n].includes(mode) || entries.some((entry) => !allowed.has(entry))) {
    fail('partial snapshot custody path cannot be mutated safely', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
  return entries;
}

async function validateClosedCustodiedFile(record, label) {
  let named;
  try {
    named = await fs.promises.lstat(record.path, { bigint: true });
  } catch {
    fail(`${label} cannot be removed safely`, 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
  if (!named.isFile() || named.isSymbolicLink() || !sameFileIdentity(record.identity, named)) {
    fail(`${label} cannot be removed safely`, 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
}

async function validatePartialCustodyEntry(record) {
  let named;
  try {
    named = await fs.promises.lstat(record.path, { bigint: true });
  } catch {
    fail('partial snapshot custody entry cannot be removed safely',
      'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
  if (!named.isFile() || named.isSymbolicLink() ||
      !sameFileIdentity(record.identity, named)) {
    fail('partial snapshot custody entry cannot be removed safely',
      'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
}

async function revalidatePartialCustody(prepared) {
  const expectedNames = prepared.copies.map((record) => path.basename(record.path)).sort();
  const entries = await validatePartialCustodyPath(prepared, expectedNames);
  if (entries.length !== expectedNames.length ||
      entries.some((entry, index) => entry !== expectedNames[index])) {
    fail('partial snapshot custody inventory changed', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
  for (const record of prepared.copies) {
    await validatePartialCustodyEntry(record);
  }
  if (prepared.dockerfile) {
    await revalidateCustodiedFile(prepared.dockerfile, 'partial Dockerfile', { verifyHash: false });
  }
  for (let index = 0; index < prepared.archives.length; index += 1) {
    await revalidateCustodiedFile(
      prepared.archives[index],
      `partial deterministic context ${index + 1}`,
      { verifyHash: false },
    );
  }
  return entries;
}

async function revalidatePreparedFiles(prepared) {
  await revalidateCustodyDirectory(prepared);
  await revalidateCustodiedFile(prepared.dockerfile, 'Dockerfile');
  for (let index = 0; index < prepared.archives.length; index += 1) {
    await revalidateCustodiedFile(prepared.archives[index], `deterministic context ${index + 1}`);
  }
  await revalidateCustodyDirectory(prepared);
}

async function revalidatePreparedIdentities(prepared) {
  await revalidateCustodyDirectory(prepared);
  await revalidateCustodiedFile(prepared.dockerfile, 'Dockerfile', { verifyHash: false });
  for (let index = 0; index < prepared.archives.length; index += 1) {
    await revalidateCustodiedFile(
      prepared.archives[index],
      `deterministic context ${index + 1}`,
      { verifyHash: false },
    );
  }
}

async function disposePreparedFiles(prepared) {
  if (!prepared) return;
  const records = [prepared.dockerfile, ...prepared.archives].filter(Boolean);
  let integrityError = null;
  try { await revalidatePreparedIdentities(prepared); } catch (error) { integrityError = error; }
  let closeFailed = false;
  for (const record of records) {
    try { await record.handle?.close(); } catch { closeFailed = true; }
  }
  if (integrityError || closeFailed) {
    await closeHandleOrFail(prepared.custodyHandle, 'snapshot custody directory');
    if (integrityError) throw integrityError;
    fail('snapshot custody handles did not close cleanly', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
  try {
    await prepared.custodyHandle.chmod(0o700);
    await validateMutableCustodyPath(prepared, CUSTODY_FILE_NAMES);
  } catch (error) {
    await closeHandleOrFail(prepared.custodyHandle, 'snapshot custody directory');
    if (error instanceof DaytonaSnapshotControllerError) throw error;
    fail('snapshot custody directory could not be unlocked safely', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
  const errors = [];
  const remainingNames = records.map((record) => path.basename(record.path)).sort();
  for (const record of records) {
    try {
      await validateMutableCustodyPath(prepared, remainingNames);
      await validateClosedCustodiedFile(record, 'snapshot custody entry');
      await fs.promises.unlink(record.path);
      remainingNames.splice(remainingNames.indexOf(path.basename(record.path)), 1);
    } catch {
      errors.push('unlink');
      break;
    }
  }
  if (errors.length === 0) {
    try { await validateMutableCustodyPath(prepared, []); } catch { errors.push('identity'); }
  }
  try { await prepared.custodyHandle.close(); } catch { errors.push('close'); }
  if (errors.length === 0) {
    try { await fs.promises.rmdir(prepared.custodyDirectory); } catch { errors.push('rmdir'); }
  }
  if (errors.length > 0) {
    fail('snapshot custody cleanup was not complete', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
  }
}

function contextMatchesManifest(observed, declared, kind) {
  if (declared.kind !== kind || declared.encoding !== 'ustar' ||
      declared.byteLength !== observed.byteLength || declared.sha256 !== observed.sha256 ||
      !Array.isArray(declared.entries) || declared.entries.length !== observed.semanticUstar.entries.length) {
    return false;
  }
  return declared.entries.every((entry, index) => {
    const actual = observed.semanticUstar.entries[index];
    return entry.path === actual.path && entry.type === actual.type && entry.mode === actual.mode &&
      entry.byteLength === actual.byteLength && entry.sha256 === actual.sha256;
  });
}

async function validateCustodiedManifest(identity, dockerfile, archives) {
  const manifestRecord = archives.find((record) => record.kind === 'manifest');
  if (!manifestRecord || manifestRecord.sha256 !== identity.buildHash) {
    fail('snapshot manifest does not match the requested build identity', 'ERR_SNAPSHOT_MANIFEST');
  }
  const bytes = await readOpenFile(
    manifestRecord.handle,
    manifestRecord.byteLength,
    MAX_MANIFEST_BYTES,
    'snapshot manifest',
  );
  try {
    let parsed;
    try {
      parsed = JSON.parse(UTF8.decode(bytes));
    } catch {
      fail('snapshot manifest is not canonical JSON', 'ERR_SNAPSHOT_MANIFEST');
    }
    let manifest;
    try {
      manifest = validateSnapshotBuildManifest(parsed);
    } catch {
      fail('snapshot manifest failed its exact schema', 'ERR_SNAPSHOT_MANIFEST');
    }
    if (snapshotBuildManifestHash(manifest) !== identity.buildHash ||
        manifest.dockerfile.byteLength !== dockerfile.byteLength ||
        manifest.dockerfile.sha256 !== dockerfile.sha256) {
      fail('snapshot manifest build binding drifted', 'ERR_SNAPSHOT_MANIFEST');
    }
    for (const kind of SNAPSHOT_CONTEXT_KINDS.filter((value) => value !== 'manifest')) {
      const observed = archives.find((record) => record.kind === kind);
      if (!observed || !contextMatchesManifest(observed, manifest.contexts[kind], kind)) {
        fail('snapshot manifest context binding drifted', 'ERR_SNAPSHOT_MANIFEST');
      }
    }
    const definition = archives.find((record) => record.kind === 'runtime')
      ?.semanticUstar.entries.find((entry) =>
        entry.path === 'opt/engineer/snapshot/snapshot-definition.json');
    if (!definition || definition.byteLength !== manifest.definition.byteLength ||
        definition.sha256 !== manifest.definition.sha256) {
      fail('snapshot manifest definition binding drifted', 'ERR_SNAPSHOT_MANIFEST');
    }
  } finally {
    bytes.fill(0);
  }
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
  if (!Array.isArray(input.archives) || input.archives.length !== SNAPSHOT_CONTEXT_KINDS.length) {
    fail('archives must contain the exact deterministic snapshot context inventory', 'ERR_SNAPSHOT_INPUT');
  }

  const declared = input.archives.map((archive) => {
    exactKeys(archive, ['path', 'sha256', 'kind', 'encoding'], 'archive record');
    const archivePath = safeAbsolutePath(archive.path, 'archive path');
    if (typeof archive.sha256 !== 'string' || !HASH.test(archive.sha256)) {
      fail('archive sha256 must be a lowercase digest', 'ERR_SNAPSHOT_INPUT');
    }
    const policy = SNAPSHOT_CONTEXT_POLICY[archive.kind];
    if (!policy || archive.encoding !== policy.encoding) {
      fail('archive kind or encoding is not an approved snapshot context', 'ERR_SNAPSHOT_INPUT');
    }
    return { path: archivePath, sha256: archive.sha256, kind: archive.kind, encoding: archive.encoding };
  }).sort((left, right) => {
    const leftName = SNAPSHOT_CONTEXT_POLICY[left.kind].fileName;
    const rightName = SNAPSHOT_CONTEXT_POLICY[right.kind].fileName;
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  const declaredKinds = new Set(declared.map((record) => record.kind));
  if (declaredKinds.size !== SNAPSHOT_CONTEXT_KINDS.length ||
      SNAPSHOT_CONTEXT_KINDS.some((kind) => !declaredKinds.has(kind))) {
    fail('archives contain a duplicate or missing snapshot context kind', 'ERR_SNAPSHOT_INPUT');
  }
  if (new Set(declared.map((record) => record.path)).size !== declared.length) {
    fail('archives contain a duplicate deterministic file', 'ERR_SNAPSHOT_INPUT');
  }
  const manifestDeclaration = declared.find((record) => record.kind === 'manifest');
  if (manifestDeclaration.sha256 !== input.identity.buildHash) {
    fail('snapshot manifest digest does not match buildHash', 'ERR_SNAPSHOT_INPUT');
  }

  const custody = await createCustodyDirectory();
  const custodyDirectory = custody.path;
  const partial = {
    custodyDirectory,
    custodyHandle: custody.handle,
    custodyAnchor: custody.initialIdentity,
    dockerfile: null,
    archives: [],
    copies: [],
  };
  try {
    const custodyDockerfilePath = path.join(custodyDirectory, 'Dockerfile');
    partial.copies.push(await copyStableRegularFile(
      dockerfilePath,
      custodyDockerfilePath,
      Math.min(maximumFileBytes, MAX_DOCKERFILE_BYTES),
      'Dockerfile',
    ));
    partial.dockerfile = await inspectRegularFile(custodyDockerfilePath, {
      maximumBytes: Math.min(maximumFileBytes, MAX_DOCKERFILE_BYTES),
      label: 'Dockerfile',
    });
    assertCustodiedFileIdentity(partial.dockerfile, 'Dockerfile');

    let totalBytes = 0;
    for (const archive of declared) {
      const ordinal = partial.archives.length + 1;
      const policy = SNAPSHOT_CONTEXT_POLICY[archive.kind];
      const custodyPath = path.join(custodyDirectory, policy.fileName);
      const contextMaximum = archive.kind === 'manifest'
        ? Math.min(maximumFileBytes, MAX_MANIFEST_BYTES)
        : maximumFileBytes;
      partial.copies.push(await copyStableRegularFile(
        archive.path,
        custodyPath,
        contextMaximum,
        `deterministic context ${ordinal}`,
      ));
      const inspected = await inspectRegularFile(custodyPath, {
        expectedHash: archive.sha256,
        maximumBytes: contextMaximum,
        label: `deterministic context ${ordinal}`,
        allowedUstarExecutableDigests: archive.encoding === 'ustar'
          ? ATTESTED_USTAR_EXECUTABLE_DIGESTS
          : null,
      });
      const record = Object.freeze({
        ...inspected,
        kind: archive.kind,
        encoding: archive.encoding,
      });
      partial.archives.push(record);
      assertCustodiedFileIdentity(record, `deterministic context ${ordinal}`);
      totalBytes += inspected.byteLength;
      if (totalBytes > MAX_TOTAL_ARCHIVE_BYTES) {
        fail('deterministic contexts exceed their aggregate byte bound', 'ERR_SNAPSHOT_FILE');
      }
    }
    await validateCustodiedManifest(input.identity, partial.dockerfile, partial.archives);
    await partial.custodyHandle.chmod(0o500);
    const custodyStat = await partial.custodyHandle.stat({ bigint: true });
    const namedCustodyStat = await fs.promises.lstat(custodyDirectory, { bigint: true });
    const custodyEntries = (await fs.promises.readdir(custodyDirectory)).sort();
    if (!custodyStat.isDirectory() || !namedCustodyStat.isDirectory() ||
        namedCustodyStat.isSymbolicLink() || !sameFileIdentity(custodyStat, namedCustodyStat) ||
        (custodyStat.mode & 0o777n) !== 0o500n ||
        custodyEntries.length !== CUSTODY_FILE_NAMES.length ||
        custodyEntries.some((entry, index) => entry !== CUSTODY_FILE_NAMES[index])) {
      fail('snapshot custody directory could not be sealed', 'ERR_SNAPSHOT_CUSTODY');
    }
    const prepared = Object.freeze({
      identity: Object.freeze({ ...input.identity }),
      dockerfile: partial.dockerfile,
      archives: Object.freeze(partial.archives),
      custodyDirectory,
      custodyHandle: partial.custodyHandle,
      custodyAnchor: partial.custodyAnchor,
      custodyIdentity: capturedIdentity(custodyStat),
    });
    await revalidatePreparedIdentities(prepared);
    return prepared;
  } catch (error) {
    let integrityError = null;
    let entries = null;
    try { entries = await revalidatePartialCustody(partial); } catch (caught) {
      integrityError = caught;
    }
    let closeFailed = false;
    for (const record of [partial.dockerfile, ...partial.archives]) {
      try { await record?.handle?.close(); } catch { closeFailed = true; }
    }
    const quarantineRequired = integrityError || closeFailed ||
      error?.code === 'ERR_SNAPSHOT_CUSTODY_HANDLE' ||
      error?.code === 'ERR_SNAPSHOT_CUSTODY_CLEANUP';
    if (quarantineRequired) {
      await closeHandleOrFail(partial.custodyHandle, 'partial snapshot custody directory');
      if (integrityError) throw integrityError;
      if (error?.code === 'ERR_SNAPSHOT_CUSTODY_HANDLE' ||
          error?.code === 'ERR_SNAPSHOT_CUSTODY_CLEANUP') throw error;
      fail('partial snapshot custody handles did not close cleanly', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
    }
    try {
      await partial.custodyHandle.chmod(0o700);
      await validateMutableCustodyPath(partial, entries);
    } catch (cleanupError) {
      await closeHandleOrFail(partial.custodyHandle, 'partial snapshot custody directory');
      if (cleanupError instanceof DaytonaSnapshotControllerError) throw cleanupError;
      fail('partial snapshot custody could not be unlocked safely', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
    }
    const cleanupErrors = [];
    const remainingEntries = [...entries];
    const recordsByName = new Map(partial.copies.map((record) => [path.basename(record.path), record]));
    for (const entry of entries) {
      try {
        await validateMutableCustodyPath(partial, remainingEntries);
        const record = recordsByName.get(entry);
        if (!record) fail('partial snapshot custody inventory changed', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
        await validatePartialCustodyEntry(record);
        await fs.promises.unlink(record.path);
        remainingEntries.splice(remainingEntries.indexOf(entry), 1);
      } catch {
        cleanupErrors.push('unlink');
        break;
      }
    }
    if (cleanupErrors.length === 0) {
      try { await validateMutableCustodyPath(partial, []); } catch { cleanupErrors.push('identity'); }
    }
    try { await partial.custodyHandle.close(); } catch { cleanupErrors.push('close'); }
    if (cleanupErrors.length === 0) {
      try { await fs.promises.rmdir(custodyDirectory); } catch { cleanupErrors.push('rmdir'); }
    }
    if (cleanupErrors.length > 0) {
      fail('snapshot custody preparation failed and cleanup was not complete',
        'ERR_SNAPSHOT_CUSTODY_CLEANUP');
    }
    throw error;
  }
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

  async function rollbackSnapshot(snapshotId) {
    safeRemoteId(snapshotId, 'owned snapshot id');
    try {
      await invokeRaw(['snapshot', 'delete', snapshotId]);
    } catch {
      // Absence is authoritative; a lost delete response is tolerated only when every page proves absence.
    }
    for (let attempt = 0; attempt < cleanupPollAttempts; attempt += 1) {
      try {
        const records = await listSnapshots();
        const present = records.some((record) => record.id === snapshotId);
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
    const sandboxName = `${prepared.identity.name}-selftest-${crypto.randomBytes(16).toString('hex')}`;
    safeRemoteId(sandboxName, 'validation sandbox name');
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
    let prepared = null;
    let result = null;
    let operationError = null;
    let ownedSnapshotId = null;
    try {
      try {
        prepared = await prepareRequest(input, maxFileBytes);
        await verifyVersion();
        const existing = findSnapshot(await listSnapshots(), prepared);
        if (existing) {
          const validation = await validateCreatedSnapshot(prepared);
          result = lifecycleReceipt(existing, prepared, false, validation);
        } else {
          try {
            await revalidatePreparedFiles(prepared);
            let invocationError = null;
            try {
              await invoke([
                'snapshot', 'create', prepared.identity.name,
                '--dockerfile', prepared.dockerfile.path,
                ...prepared.archives.flatMap((archive) => ['--context', archive.path]),
                '--cpu', '2', '--memory', '4', '--disk', '10', '--region', 'us',
                '--sandbox-class', 'container',
              ], 'Daytona snapshot creation');
            } catch (error) {
              invocationError = error;
            }
            if (invocationError) {
              await revalidatePreparedFiles(prepared);
              const appeared = findSnapshot(await listSnapshots(), prepared);
              if (!appeared) throw invocationError;
              const validation = await validateCreatedSnapshot(prepared);
              result = lifecycleReceipt(appeared, prepared, false, validation);
            } else {
              const created = findSnapshot(await listSnapshots(), prepared);
              if (!created) fail('new Daytona snapshot is absent from the complete paginated list',
                'ERR_SNAPSHOT_RECORD_MISSING');
              ownedSnapshotId = created.id;
              await revalidatePreparedFiles(prepared);
              const validation = await validateCreatedSnapshot(prepared);
              result = lifecycleReceipt(created, prepared, true, validation);
            }
          } catch (error) {
            if (ownedSnapshotId) {
              try {
                await rollbackSnapshot(ownedSnapshotId);
                ownedSnapshotId = null;
              } catch {
                fail('snapshot lifecycle failed and rollback absence was not proven', 'ERR_SNAPSHOT_ROLLBACK');
              }
            }
            throw error;
          }
        }
      } catch (error) {
        operationError = error;
      }

      let custodyError = null;
      try {
        await disposePreparedFiles(prepared);
      } catch (error) {
        custodyError = error;
      }
      if (custodyError && ownedSnapshotId) {
        try {
          await rollbackSnapshot(ownedSnapshotId);
          ownedSnapshotId = null;
        } catch {
          fail('snapshot custody failed and rollback absence was not proven', 'ERR_SNAPSHOT_ROLLBACK');
        }
      }
      if (operationError) {
        if (custodyError) {
          fail('snapshot lifecycle and custody cleanup both failed', 'ERR_SNAPSHOT_CUSTODY_CLEANUP');
        }
        throw operationError;
      }
      if (custodyError) throw custodyError;
      if (!result) {
        fail('snapshot lifecycle completed without a receipt', 'ERR_SNAPSHOT_RECORD_MISSING');
      }
      return result;
    } finally {
      busy = false;
    }
  }

  return Object.freeze({ ensureSnapshot });
}
