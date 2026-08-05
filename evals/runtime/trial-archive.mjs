import crypto from 'node:crypto';
import fs, { constants as FS_CONSTANTS } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  TASK_SECURITY_COMPOSE_PATH,
  createTrialSecurityContract,
  deriveTrialRuntimeIdentity,
} from './trial-security-contract.mjs';

export const TRIAL_ARCHIVE_ENCODING = 'tar+gzip';
export const TRIAL_INPUT_MANIFEST_PATH = 'work/.engineer/input-manifest.json';
export const TRIAL_OUTPUT_RECEIPT_PATH = 'work/.engineer/runner-receipt.json';

const REMOTE_ROOT = '/engineer-bounded/work';
const REMOTE_HARBOR = '/opt/engineer/bin/harbor';
const REMOTE_NODE = '/usr/local/bin/node';
const ZERO_HASH = '0'.repeat(64);
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_JOB = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}@sha256:[a-f0-9]{64}$/;
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;
const MAX_CONTENT_BYTES = 48 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 4_096;
const MAX_ARCHIVE_PATH_BYTES = 240;
const MAX_JSON_BYTES = 512 * 1024;
const BLOCK = 512;
const SECRET_NAME = /(?:^|_)(?:OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)(?:_|$)/i;
const SECRET_VALUE = /(?:Bearer\s+|sk-[A-Za-z0-9_-]{8,})/i;
const SPAWN_ENV_ALLOWLIST = new Set([
  'LANG', 'LC_ALL', 'TERM', 'PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'TMPDIR', 'DOCKER_CONFIG', 'PYTHONPATH', 'PYTHONNOUSERSITE', 'PYTHONSAFEPATH',
  'PYTHONDONTWRITEBYTECODE', 'HARNESS_EVAL_HOST_NODE', 'HARNESS_EVAL_HOST_NODE_SHA256',
  'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
const REQUIRED_AGENT_ENV = Object.freeze([
  'HARNESS_EVAL_TB_CONDITION',
  'HARNESS_EVAL_TB_TELEMETRY_FILE',
  'HARNESS_EVAL_HOST_NODE',
  'HARNESS_EVAL_HOST_NODE_SHA256',
]);
const COMMON_MOUNT_TAIL = Object.freeze([
  '/opt/eval-runtime/evidence-probe',
  '/opt/eval-runtime/evidence-probe.mjs',
  '/opt/eval-runtime/bounded-exec',
  '/opt/eval-runtime/bounded-exec.mjs',
]);
const TREATMENT_MOUNT_TARGETS = Object.freeze([
  '/opt/harness-bundle/harness',
  '/opt/harness-bundle/harness-cli',
]);

export function archivedConditionReadOnlyBindVariants(condition) {
  if (!['generic', 'harness'].includes(condition)) {
    fail('condition-specific read-only mount condition is invalid', 'ERR_TRIAL_ARCHIVE_SECURITY');
  }
  const commonVariants = [
    ['/opt/eval-runtime/node-x64', ...COMMON_MOUNT_TAIL],
    ['/opt/eval-runtime/node-arm64', ...COMMON_MOUNT_TAIL],
    ['/opt/eval-runtime/node-x64', '/opt/eval-runtime/node-arm64', ...COMMON_MOUNT_TAIL],
  ];
  return Object.freeze(commonVariants.map((common) => Object.freeze(
    [...common, ...(condition === 'harness' ? TREATMENT_MOUNT_TARGETS : [])]
      .map((target, index) => Object.freeze({
        type: 'bind',
        source: `${REMOTE_ROOT}/mounts/${String(index).padStart(3, '0')}`,
        target,
        read_only: true,
      })),
  )));
}

export class TrialArchiveError extends Error {
  constructor(message, code = 'ERR_TRIAL_ARCHIVE') {
    super(message);
    this.name = 'TrialArchiveError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new TrialArchiveError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!plainObject(value)) fail(`${label} must be an object`, 'ERR_TRIAL_ARCHIVE_SCHEMA');
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    fail(`${label} contains an unexpected field`, 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || !['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
    fail('archive metadata is not canonical JSON', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  return encoded;
}

function cloneCanonical(value, label) {
  let text;
  try {
    text = canonicalJson(value);
  } catch (error) {
    if (error instanceof TrialArchiveError) throw error;
    fail(`${label} is not JSON`, 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) fail(`${label} exceeds its byte bound`, 'ERR_TRIAL_ARCHIVE_BOUND');
  const clone = JSON.parse(text);
  scanCredentialMetadata(clone, label);
  return clone;
}

function scanCredentialMetadata(value, label, depth = 0) {
  if (depth > 24) fail(`${label} exceeds its depth bound`, 'ERR_TRIAL_ARCHIVE_BOUND');
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) fail(`${label} contains secret material`, 'ERR_TRIAL_ARCHIVE_SECRET');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) scanCredentialMetadata(item, label, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_NAME.test(key)) fail(`${label} contains a secret-bearing field`, 'ERR_TRIAL_ARCHIVE_SECRET');
    scanCredentialMetadata(item, label, depth + 1);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeId(value, label, pattern = SAFE_ID) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} must be a safe identifier`, 'ERR_TRIAL_ARCHIVE_SCHEMA');
  return value;
}

function boundedString(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > maximum) {
    fail(`${label} must be a bounded NUL-free string`, 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is outside its integer bound`, 'ERR_TRIAL_ARCHIVE_BOUND');
  }
  return value;
}

function normalizedAbsolute(value, label) {
  boundedString(value, label, 1_024);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label} must be a normalized absolute path`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  return value;
}

function below(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertRealDirectory(directory, label) {
  normalizedAbsolute(directory, label);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(directory);
    real = fs.realpathSync.native(directory);
  } catch {
    fail(`${label} is unavailable`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  // A parent component may be an OS-owned compatibility alias (macOS /var ->
  // /private/var). The named directory itself must not be a symlink; callers
  // use the returned canonical path for every subsequent containment check.
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a real non-symlink directory`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  return real;
}

function assertRealMountSource(source, label) {
  normalizedAbsolute(source, label);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(source);
    real = fs.realpathSync.native(source);
  } catch {
    fail(`${label} is unavailable`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    fail(`${label} must be a real non-symlink file or directory`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  const realStat = fs.lstatSync(real);
  const kind = stat.isDirectory() ? 'directory' : 'file';
  if (realStat.isSymbolicLink() || (kind === 'directory' ? !realStat.isDirectory() : !realStat.isFile())) {
    fail(`${label} canonical identity drifted`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  return { source: real, kind };
}

function safeArchivePath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    fail('tar entry path is invalid', 'ERR_TRIAL_ARCHIVE_TAR');
  }
  const trimmed = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  if (trimmed.length === 0 || path.posix.isAbsolute(trimmed) || path.posix.normalize(trimmed) !== trimmed
      || trimmed.split('/').some((part) => part === '' || part === '.' || part === '..')
      || Buffer.byteLength(trimmed) > MAX_ARCHIVE_PATH_BYTES
      || /[\x00-\x1f\x7f]/.test(trimmed)) {
    fail('tar entry escaped its bounded relative namespace', 'ERR_TRIAL_ARCHIVE_TAR');
  }
  return trimmed;
}

function safeRelativeName(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')
      || path.posix.normalize(value) !== value || path.posix.isAbsolute(value)
      || value.split('/').some((part) => part === '' || part === '.' || part === '..')
      || /[\x00-\x1f\x7f]/.test(value)) {
    fail(`${label} is not a safe relative path`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  return value;
}

function octal(value, length) {
  const text = value.toString(8);
  if (text.length > length - 1) fail('tar integer exceeds its field', 'ERR_TRIAL_ARCHIVE_TAR');
  return `${text.padStart(length - 1, '0')}\0`;
}

function splitTarPath(name) {
  const bytes = Buffer.byteLength(name);
  if (bytes <= 100) return { name, prefix: '' };
  for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) {
    const prefix = name.slice(0, index);
    const suffix = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) return { name: suffix, prefix };
  }
  fail('tar entry path cannot be encoded as ustar', 'ERR_TRIAL_ARCHIVE_TAR');
}

function tarHeader(entry) {
  const header = Buffer.alloc(BLOCK);
  const encodedPath = splitTarPath(entry.path);
  header.write(encodedPath.name, 0, 100, 'utf8');
  header.write(octal(entry.mode, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(entry.type === 'file' ? entry.bytes.length : 0, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = entry.type === 'directory' ? 0x35 : 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (encodedPath.prefix) header.write(encodedPath.prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumField = `${checksum.toString(8).padStart(6, '0')}\0 `;
  header.write(checksumField, 148, 8, 'ascii');
  return header;
}

function encodeTar(entries) {
  const ordered = entries.slice().sort((left, right) => compareText(left.path, right.path));
  const parts = [];
  let total = BLOCK * 2;
  let contentTotal = 0;
  if (ordered.length > MAX_FILES) fail('tar archive contains too many entries', 'ERR_TRIAL_ARCHIVE_BOUND');
  for (const entry of ordered) {
    const header = tarHeader(entry);
    parts.push(header);
    total += BLOCK;
    if (entry.type === 'file') {
      contentTotal += entry.bytes.length;
      if (contentTotal > MAX_CONTENT_BYTES) fail('tar contents exceed their byte bound', 'ERR_TRIAL_ARCHIVE_BOUND');
      parts.push(entry.bytes);
      total += entry.bytes.length;
      const padding = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
      if (padding) {
        parts.push(Buffer.alloc(padding));
        total += padding;
      }
    }
    if (total > MAX_UNCOMPRESSED_BYTES) fail('tar archive exceeds its byte bound', 'ERR_TRIAL_ARCHIVE_BOUND');
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  const raw = Buffer.concat(parts, total);
  const compressed = zlib.gzipSync(raw, { level: 9, mtime: 0 });
  raw.fill(0);
  if (compressed.length > MAX_COMPRESSED_BYTES) {
    compressed.fill(0);
    fail('compressed trial archive exceeds its byte bound', 'ERR_TRIAL_ARCHIVE_BOUND');
  }
  return compressed;
}

function parseOctal(field, label) {
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text || '0')) fail(`${label} is not octal`, 'ERR_TRIAL_ARCHIVE_TAR');
  const value = Number.parseInt(text || '0', 8);
  if (!Number.isSafeInteger(value)) fail(`${label} exceeds its bound`, 'ERR_TRIAL_ARCHIVE_TAR');
  return value;
}

function parseTar(archiveBytes) {
  if (!Buffer.isBuffer(archiveBytes) && !(archiveBytes instanceof Uint8Array)) {
    fail('archive must be supplied as bytes', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  const compressed = Buffer.from(archiveBytes);
  if (compressed.length < 20 || compressed.length > MAX_COMPRESSED_BYTES || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    fail('trial archive must be a bounded gzip stream', 'ERR_TRIAL_ARCHIVE_TAR');
  }
  let raw;
  try {
    raw = zlib.gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch {
    fail('trial gzip archive is malformed or oversized', 'ERR_TRIAL_ARCHIVE_TAR');
  }
  if (raw.length < BLOCK * 2 || raw.length % BLOCK !== 0) {
    raw.fill(0);
    fail('tar archive has an invalid block boundary', 'ERR_TRIAL_ARCHIVE_TAR');
  }
  const entries = [];
  const names = new Set();
  let offset = 0;
  let zeroBlocks = 0;
  let contentBytes = 0;
  try {
    while (offset + BLOCK <= raw.length) {
      const header = raw.subarray(offset, offset + BLOCK);
      offset += BLOCK;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) break;
        continue;
      }
      if (zeroBlocks !== 0) fail('tar archive contains data after one end block', 'ERR_TRIAL_ARCHIVE_TAR');
      const storedChecksum = parseOctal(header.subarray(148, 156), 'tar checksum');
      let computed = 0;
      for (let index = 0; index < BLOCK; index += 1) {
        computed += index >= 148 && index < 156 ? 0x20 : header[index];
      }
      if (computed !== storedChecksum) fail('tar header checksum is invalid', 'ERR_TRIAL_ARCHIVE_TAR');
      if (header.subarray(257, 263).toString('ascii') !== 'ustar\0'
          || header.subarray(263, 265).toString('ascii') !== '00') {
        fail('tar entry is not portable ustar', 'ERR_TRIAL_ARCHIVE_TAR');
      }
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
      const typeFlag = header[156];
      if (![0, 0x30, 0x35].includes(typeFlag)) {
        fail('tar links, devices, and extension entries are forbidden', 'ERR_TRIAL_ARCHIVE_TAR');
      }
      const type = typeFlag === 0x35 ? 'directory' : 'file';
      const archivePath = safeArchivePath(prefix ? `${prefix}/${name}` : name, { directory: type === 'directory' });
      if (names.has(archivePath)) fail('tar archive contains a duplicate entry', 'ERR_TRIAL_ARCHIVE_TAR');
      names.add(archivePath);
      const mode = parseOctal(header.subarray(100, 108), 'tar mode');
      const uid = parseOctal(header.subarray(108, 116), 'tar uid');
      const gid = parseOctal(header.subarray(116, 124), 'tar gid');
      const size = parseOctal(header.subarray(124, 136), 'tar size');
      const mtime = parseOctal(header.subarray(136, 148), 'tar mtime');
      if (uid !== 0 || gid !== 0 || mtime !== 0 || (type === 'directory' && size !== 0)
          || ![0o600, 0o700].includes(mode)) {
        fail('tar metadata violates the portable archive policy', 'ERR_TRIAL_ARCHIVE_TAR');
      }
      boundedInteger(size, 'tar file size', 0, MAX_FILE_BYTES);
      if (offset + size > raw.length) fail('tar entry is truncated', 'ERR_TRIAL_ARCHIVE_TAR');
      const bytes = type === 'file' ? Buffer.from(raw.subarray(offset, offset + size)) : Buffer.alloc(0);
      contentBytes += bytes.length;
      if (contentBytes > MAX_CONTENT_BYTES || entries.length + 1 > MAX_FILES) {
        bytes.fill(0);
        fail('tar contents exceed their bound', 'ERR_TRIAL_ARCHIVE_BOUND');
      }
      entries.push({ path: archivePath, type, mode, bytes });
      offset += Math.ceil(size / BLOCK) * BLOCK;
    }
    if (zeroBlocks !== 2 || raw.subarray(offset).some((byte) => byte !== 0)) {
      fail('tar archive is missing its exact zero terminator', 'ERR_TRIAL_ARCHIVE_TAR');
    }
    const sorted = entries.map((entry) => entry.path).slice().sort(compareText);
    if (entries.some((entry, index) => entry.path !== sorted[index])) {
      fail('tar entries must be in deterministic lexical order', 'ERR_TRIAL_ARCHIVE_TAR');
    }
    return entries;
  } catch (error) {
    for (const entry of entries) entry.bytes.fill(0);
    throw error;
  } finally {
    raw.fill(0);
  }
}

function addDirectory(entries, seen, archivePath) {
  const safe = safeArchivePath(archivePath, { directory: true });
  if (seen.has(safe)) return;
  seen.add(safe);
  entries.push({ path: safe, type: 'directory', mode: 0o700, bytes: Buffer.alloc(0) });
}

function addFile(entries, seen, archivePath, bytes, mode = 0o600) {
  const safe = safeArchivePath(archivePath);
  if (seen.has(safe)) fail(`duplicate archive path: ${safe}`, 'ERR_TRIAL_ARCHIVE_PATH');
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) fail(`archive file exceeds its bound: ${safe}`, 'ERR_TRIAL_ARCHIVE_BOUND');
  seen.add(safe);
  entries.push({ path: safe, type: 'file', mode: mode === 0o700 ? 0o700 : 0o600, bytes: Buffer.from(bytes) });
}

function readAttestedFile(file, expectedRoot, label) {
  let lstat;
  let real;
  try {
    lstat = fs.lstatSync(file);
    real = fs.realpathSync.native(file);
  } catch {
    fail(`${label} is unavailable`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync.native(expectedRoot);
  } catch {
    fail(`${label} attestation root is unavailable`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  if (lstat.isSymbolicLink() || !lstat.isFile() || !below(canonicalRoot, real)) {
    fail(`${label} must be an attested regular non-symlink input`, 'ERR_TRIAL_ARCHIVE_PATH');
  }
  const descriptor = fs.openSync(real, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) fail(`${label} exceeds its file bound`, 'ERR_TRIAL_ARCHIVE_BOUND');
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const count = fs.readSync(descriptor, bytes, position, bytes.length - position, position);
      if (count === 0) fail(`${label} changed while being read`, 'ERR_TRIAL_ARCHIVE_RACE');
      position += count;
    }
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      bytes.fill(0);
      fail(`${label} changed while being attested`, 'ERR_TRIAL_ARCHIVE_RACE');
    }
    return { bytes, mode: (before.mode & 0o111) === 0 ? 0o600 : 0o700 };
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateConditionExecutionMode(bytes, trial) {
  if (!['controlled-provider', 'zero-provider-canary'].includes(trial.executionMode)) {
    fail(
      'trial execution mode must be controlled-provider or zero-provider-canary',
      'ERR_TRIAL_ARCHIVE_SCHEMA',
    );
  }
  let condition;
  try {
    condition = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('condition file is not valid JSON', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  if (!plainObject(condition) || condition.id !== trial.condition) {
    fail('condition file identity drifted from the trial', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  const runtime = plainObject(condition.runtime) ? condition.runtime : null;
  const scripted = runtime?.driverMode === 'scripted-canary';
  if (trial.executionMode === 'zero-provider-canary') {
    if (!scripted) {
      fail(
        'zero-provider trial requires the archive-bound scripted-canary driver mode',
        'ERR_TRIAL_ARCHIVE_SECURITY',
      );
    }
    for (const field of ['profileId', 'providerUrl', 'apiKeyEnv']) {
      if (Object.hasOwn(condition, field)) {
        fail(
          'zero-provider condition contains provider configuration',
          'ERR_TRIAL_ARCHIVE_SECURITY',
        );
      }
    }
  } else if (scripted) {
    fail(
      'controlled-provider trial cannot select the scripted-canary driver mode',
      'ERR_TRIAL_ARCHIVE_SECURITY',
    );
  }
}

function addTree(entries, seen, sourceDirectory, archiveDirectory) {
  const root = assertRealDirectory(sourceDirectory, `archive source ${sourceDirectory}`);
  const visit = (current, relative) => {
    const archivePath = relative ? `${archiveDirectory}/${relative}` : archiveDirectory;
    addDirectory(entries, seen, archivePath);
    let children;
    try {
      children = fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => compareText(left.name, right.name));
    } catch {
      fail(`archive source cannot be enumerated: ${archivePath}`, 'ERR_TRIAL_ARCHIVE_PATH');
    }
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      safeRelativeName(childRelative, 'archive source entry');
      const sourcePath = path.join(current, child.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) fail(`archive source contains a symlink: ${childRelative}`, 'ERR_TRIAL_ARCHIVE_PATH');
      if (stat.isDirectory()) {
        const real = fs.realpathSync.native(sourcePath);
        if (!below(root, real)) fail('archive directory escaped its attested root', 'ERR_TRIAL_ARCHIVE_PATH');
        visit(real, childRelative);
      } else if (stat.isFile()) {
        const read = readAttestedFile(sourcePath, root, `archive source file ${childRelative}`);
        addFile(entries, seen, `${archiveDirectory}/${childRelative}`, read.bytes, read.mode);
        read.bytes.fill(0);
      } else {
        fail(`archive source contains a non-regular input: ${childRelative}`, 'ERR_TRIAL_ARCHIVE_PATH');
      }
      if (entries.length > MAX_FILES) fail('archive contains too many files', 'ERR_TRIAL_ARCHIVE_BOUND');
    }
  };
  visit(root, '');
}

function addMountSource(entries, seen, source, archivePath, kind) {
  if (kind === 'directory') {
    addTree(entries, seen, source, archivePath);
    return;
  }
  if (kind !== 'file') fail('archive mount source kind is invalid', 'ERR_TRIAL_ARCHIVE_PATH');
  const read = readAttestedFile(source, path.dirname(source), `archive mount source ${source}`);
  addFile(entries, seen, archivePath, read.bytes, read.mode);
  read.bytes.fill(0);
}

function validateSpawnEnv(value) {
  if (!plainObject(value) || Object.keys(value).length > 32) fail('Harbor spawn env is invalid', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  for (const [name, item] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || !SPAWN_ENV_ALLOWLIST.has(name)
        || SECRET_NAME.test(name) || name.startsWith('ENGINEER_PROVIDER_')
        || typeof item !== 'string' || item.includes('\0') || Buffer.byteLength(item) > 4_096
        || SECRET_VALUE.test(item)) {
      fail(`Harbor spawn env contains a provider, secret, or unsupported field: ${name}`, 'ERR_TRIAL_ARCHIVE_SECRET');
    }
  }
  const bridge = normalizedAbsolute(value.PYTHONPATH, 'Harbor PYTHONPATH');
  if (bridge.includes(path.delimiter)) fail('Harbor PYTHONPATH must name one attested bridge directory', 'ERR_TRIAL_ARCHIVE_PATH');
  return { bridge: assertRealDirectory(bridge, 'Harbor bridge directory') };
}

function parseHarborArgs(args, cwd, executionMode) {
  if (!Array.isArray(args) || args.length < 30 || args.length > 96) fail('Harbor argv is outside its bound', 'ERR_TRIAL_ARCHIVE_ARGV');
  const values = args.map((value, index) => boundedString(value, `Harbor argument ${index}`, 8_192));
  let index = 0;
  const literal = (expected) => {
    if (values[index] !== expected) fail(`Harbor argv expected ${expected}`, 'ERR_TRIAL_ARCHIVE_ARGV');
    index += 1;
  };
  const field = (flag) => {
    literal(flag);
    if (index >= values.length) fail(`Harbor argv is missing ${flag}`, 'ERR_TRIAL_ARCHIVE_ARGV');
    return values[index++];
  };
  let launch;
  let dataset;
  let task;
  let trialName = null;
  let jobName;
  let jobsDirectory;
  if (values[index] === 'run') {
    launch = 'job';
    literal('run');
    dataset = normalizedAbsolute(field('-p'), 'Harbor dataset path');
    task = safeId(field('--include-task-name'), 'Harbor task', SAFE_JOB);
  } else {
    launch = 'trial';
    literal('trial');
    literal('start');
    const taskPath = normalizedAbsolute(field('--path'), 'Harbor task path');
    task = safeId(path.basename(taskPath), 'Harbor task', SAFE_JOB);
    dataset = path.dirname(taskPath);
    if (path.join(dataset, task) !== taskPath) {
      fail('Harbor task path is not one direct dataset child', 'ERR_TRIAL_ARCHIVE_PATH');
    }
    trialName = safeId(field('--trial-name'), 'Harbor trial name', SAFE_JOB);
    const trialsDirectory = normalizedAbsolute(field('--trials-dir'), 'Harbor trials directory');
    jobName = safeId(path.basename(trialsDirectory), 'Harbor job name', SAFE_JOB);
    jobsDirectory = path.dirname(trialsDirectory);
    const expectedJobs = path.join(cwd, 'jobs');
    if (jobsDirectory !== expectedJobs || trialsDirectory !== path.join(expectedJobs, jobName)) {
      fail('Harbor trials directory escaped the controller jobs root', 'ERR_TRIAL_ARCHIVE_PATH');
    }
  }
  const agent = field('--agent');
  const expectedAgent = executionMode === 'zero-provider-canary'
    ? 'evals.external.terminal_bench.harbor_agent:ScriptedCanaryAgent'
    : 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent';
  if (agent !== expectedAgent) fail('Harbor agent reference drifted from the authenticated execution mode', 'ERR_TRIAL_ARCHIVE_ARGV');
  const model = field('--model');
  if (model.startsWith('-')) fail('Harbor model is invalid', 'ERR_TRIAL_ARCHIVE_ARGV');
  const environment = field('--env');
  if (environment !== 'docker') fail('Harbor environment must use the private Docker path', 'ERR_TRIAL_ARCHIVE_ARGV');
  if (launch === 'job' && (field('--n-attempts') !== '1' || field('--n-concurrent') !== '1')) {
    fail('Harbor argv must run one serial attempt', 'ERR_TRIAL_ARCHIVE_ARGV');
  }
  const resources = {};
  for (const [flag, key] of [
    ['--override-cpus', 'cpus'],
    ['--override-memory-mb', 'memoryMb'],
    ['--override-storage-mb', 'storageMb'],
  ]) {
    const number = Number(field(flag));
    boundedInteger(number, `Harbor ${flag}`, 1, flag === '--override-cpus' ? 64 : 1_048_576);
    resources[key] = number;
  }
  if (launch === 'job') {
    literal('-y');
    jobName = safeId(field('--job-name'), 'Harbor job name', SAFE_JOB);
    jobsDirectory = normalizedAbsolute(field('--jobs-dir'), 'Harbor jobs directory');
    const expectedJobs = path.join(cwd, 'jobs');
    if (jobsDirectory !== expectedJobs) fail('Harbor jobs directory escaped the controller work root', 'ERR_TRIAL_ARCHIVE_PATH');
  }
  let securityCompose = null;
  if (launch === 'trial') {
    securityCompose = normalizedAbsolute(field('--extra-docker-compose'), 'Harbor security Compose path');
    const expectedCompose = path.join(cwd, 'control', 'security-compose.json');
    if (securityCompose !== expectedCompose) {
      fail('Harbor security Compose path drifted from the controller work root', 'ERR_TRIAL_ARCHIVE_PATH');
    }
  }
  let mounts;
  try {
    mounts = JSON.parse(field('--mounts'));
  } catch {
    fail('Harbor mounts argument is not JSON', 'ERR_TRIAL_ARCHIVE_ARGV');
  }
  if (!Array.isArray(mounts) || mounts.length < 1 || mounts.length > 16) fail('Harbor mounts are outside their item bound', 'ERR_TRIAL_ARCHIVE_ARGV');
  const mountTargets = new Set();
  const parsedMounts = mounts.map((mount, mountIndex) => {
    exactKeys(mount, ['type', 'source', 'target', 'read_only'], `Harbor mount ${mountIndex}`);
    if (mount.type !== 'bind' || mount.read_only !== true) fail('Harbor mount must be a read-only bind', 'ERR_TRIAL_ARCHIVE_ARGV');
    const sourceIdentity = assertRealMountSource(
      normalizedAbsolute(mount.source, `Harbor mount ${mountIndex} source`),
      `Harbor mount ${mountIndex} source`,
    );
    const target = normalizedAbsolute(mount.target, `Harbor mount ${mountIndex} target`);
    if (target === '/' || mountTargets.has(target)) fail('Harbor mount target is duplicated or unsafe', 'ERR_TRIAL_ARCHIVE_ARGV');
    mountTargets.add(target);
    return { source: sourceIdentity.source, sourceKind: sourceIdentity.kind, target };
  });
  const agentEnv = {};
  while (index < values.length) {
    const assignment = field('--ae');
    const separator = assignment.indexOf('=');
    if (separator < 1) fail('Harbor agent environment assignment is invalid', 'ERR_TRIAL_ARCHIVE_ARGV');
    const name = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    if (!REQUIRED_AGENT_ENV.includes(name) || Object.hasOwn(agentEnv, name)) {
      fail('Harbor argv contains an unsupported or duplicate agent environment field', 'ERR_TRIAL_ARCHIVE_ARGV');
    }
    agentEnv[name] = value;
  }
  if (Object.keys(agentEnv).length !== REQUIRED_AGENT_ENV.length) fail('Harbor argv is missing required agent environment', 'ERR_TRIAL_ARCHIVE_ARGV');
  const condition = normalizedAbsolute(agentEnv.HARNESS_EVAL_TB_CONDITION, 'condition path');
  const telemetry = normalizedAbsolute(agentEnv.HARNESS_EVAL_TB_TELEMETRY_FILE, 'telemetry path');
  if (!below(cwd, condition) || !below(cwd, telemetry) || condition === telemetry) {
    fail('condition or telemetry path escaped the controller work root', 'ERR_TRIAL_ARCHIVE_PATH');
  }
  if (!HASH.test(agentEnv.HARNESS_EVAL_HOST_NODE_SHA256)) fail('host Node digest is invalid', 'ERR_TRIAL_ARCHIVE_ARGV');
  normalizedAbsolute(agentEnv.HARNESS_EVAL_HOST_NODE, 'host Node path');
  return {
    values,
    launch,
    dataset,
    task,
    trialName,
    model,
    jobName,
    jobsDirectory,
    securityCompose,
    resources,
    mounts: parsedMounts,
    agentEnv,
    condition,
    telemetry,
  };
}

function validateConditionMountTargets(mounts, condition, { archived = false } = {}) {
  if (!Array.isArray(mounts)) fail('condition mount inventory is invalid', 'ERR_TRIAL_ARCHIVE_SECURITY');
  const expected = archivedConditionReadOnlyBindVariants(condition).some((variant) =>
    canonicalJson(mounts.map((mount) => mount.target)) ===
      canonicalJson(variant.map((mount) => mount.target))
  );
  if (!expected) {
    fail('condition-specific read-only mount targets drifted', 'ERR_TRIAL_ARCHIVE_SECURITY');
  }
  if (archived) {
    mounts.forEach((mount, index) => {
      exactKeys(mount, ['type', 'source', 'target', 'read_only'], `archived Harbor mount ${index}`);
      const expectedSource = `${REMOTE_ROOT}/mounts/${String(index).padStart(3, '0')}`;
      if (mount.type !== 'bind' || mount.read_only !== true || mount.source !== expectedSource) {
        fail('archived read-only mount source ordinal drifted', 'ERR_TRIAL_ARCHIVE_SECURITY');
      }
    });
  }
}

function lockedTaskSecurity(taskRoot, parsed, trialId) {
  const taskConfig = path.join(taskRoot, 'task.toml');
  const config = readAttestedFile(taskConfig, taskRoot, 'task configuration');
  let source;
  try {
    source = config.bytes.toString('utf8');
  } finally {
    config.bytes.fill(0);
  }
  const assignments = (field, grammar) => [...source.matchAll(
    new RegExp(`^${field}\\s*=\\s*${grammar}\\s*$`, 'gm')
  )];
  const images = assignments('docker_image', '"([^"\\r\\n]+)"');
  const cpus = assignments('cpus', '(\\d+)');
  const memory = assignments('memory', '"(\\d+)G"');
  const storage = assignments('storage', '"(\\d+)G"');
  if (images.length !== 1 || !IMMUTABLE_IMAGE.test(images[0][1])
      || cpus.length !== 1 || Number(cpus[0][1]) !== parsed.resources.cpus
      || memory.length !== 1 || Number(memory[0][1]) * 1024 !== parsed.resources.memoryMb
      || storage.length !== 1 || Number(storage[0][1]) * 1024 !== parsed.resources.storageMb) {
    fail('task configuration drifted from its immutable image or Harbor resource lock',
      'ERR_TRIAL_ARCHIVE_SECURITY');
  }
  const contract = createTrialSecurityContract({
    trialId,
    immutableImage: images[0][1],
    cpus: parsed.resources.cpus,
    memoryMb: parsed.resources.memoryMb,
    pidsLimit: 256,
  });
  const binding = {
    schema: contract.schema,
    composePath: contract.composePath,
    composeHash: contract.composeHash,
    identity: contract.identity,
    immutableImage: contract.docker.pinnedImage,
    resources: {
      cpus: parsed.resources.cpus,
      memoryMb: parsed.resources.memoryMb,
      storageMb: parsed.resources.storageMb,
      pidsLimit: contract.docker.resources.pidsLimit,
    },
    writablePaths: contract.writablePaths,
  };
  return { contract, binding: { ...binding, bindingHash: sha256(canonicalJson(binding)) } };
}

function replaceArgAfter(args, flag, value) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) fail(`Harbor argv is missing ${flag}`, 'ERR_TRIAL_ARCHIVE_ARGV');
  args[index + 1] = value;
}

function replaceAgentEnv(args, name, value) {
  const prefix = `${name}=`;
  const matches = args.map((item, index) => item.startsWith(prefix) ? index : -1).filter((index) => index >= 0);
  if (matches.length !== 1) fail(`Harbor argv agent environment drifted for ${name}`, 'ERR_TRIAL_ARCHIVE_ARGV');
  args[matches[0]] = `${name}=${value}`;
}

function archiveManifest(bytes, kind) {
  return Object.freeze({
    kind,
    encoding: TRIAL_ARCHIVE_ENCODING,
    byteLength: bytes.length,
    sha256: sha256(bytes),
  });
}

function contentManifest(entries, excludedPath) {
  return entries
    .filter((entry) => entry.type === 'file' && entry.path !== excludedPath)
    .map((entry) => ({ path: entry.path, byteLength: entry.bytes.length, sha256: sha256(entry.bytes), mode: entry.mode }))
    .sort((left, right) => compareText(left.path, right.path));
}

function validateContentManifest(entries, document, excludedPath, field) {
  if (!Array.isArray(document[field])) fail(`archive ${field} is invalid`, 'ERR_TRIAL_ARCHIVE_SCHEMA');
  const observed = contentManifest(entries, excludedPath);
  if (canonicalJson(observed) !== canonicalJson(document[field])) {
    fail(`archive ${field} digest inventory drifted`, 'ERR_TRIAL_ARCHIVE_DIGEST');
  }
}

export function createTrialInputArchive(request) {
  exactKeys(request, ['trial', 'harbor'], 'trial archive request');
  if (!plainObject(request.trial) || !plainObject(request.harbor)) fail('trial and Harbor specifications are required', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  const trial = cloneCanonical(request.trial, 'trial specification');
  safeId(trial.trialId, 'trial id');
  safeId(trial.task, 'trial task', SAFE_JOB);
  if (!['generic', 'harness'].includes(trial.condition)) fail('trial condition is invalid', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  if (!['controlled-provider', 'zero-provider-canary'].includes(trial.executionMode)) {
    fail('trial execution mode must be controlled-provider or zero-provider-canary', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  exactKeys(request.harbor, ['executable', 'args', 'cwd', 'timeoutMs', 'spawnEnv'], 'Harbor request');
  normalizedAbsolute(request.harbor.executable, 'controller Harbor executable');
  const requestedCwd = normalizedAbsolute(request.harbor.cwd, 'controller work root');
  const cwd = assertRealDirectory(requestedCwd, 'controller work root');
  boundedInteger(request.harbor.timeoutMs, 'Harbor timeout', 1_000, 4 * 60 * 60 * 1_000);
  const spawn = validateSpawnEnv(request.harbor.spawnEnv);
  const parsed = parseHarborArgs(request.harbor.args, requestedCwd, trial.executionMode);
  if (parsed.task !== trial.task) fail('trial task and Harbor argv drifted', 'ERR_TRIAL_ARCHIVE_ARGV');
  if (parsed.launch === 'trial') {
    validateConditionMountTargets(parsed.mounts, trial.condition);
    let expectedTrialName;
    try {
      expectedTrialName = deriveTrialRuntimeIdentity(trial.trialId).trialName;
    } catch {
      fail('Harbor trial identity could not be derived', 'ERR_TRIAL_ARCHIVE_ARGV');
    }
    if (parsed.trialName !== expectedTrialName) {
      fail('Harbor trial name drifted from the authenticated trial identity', 'ERR_TRIAL_ARCHIVE_ARGV');
    }
  }
  if (request.harbor.spawnEnv.HARNESS_EVAL_HOST_NODE !== parsed.agentEnv.HARNESS_EVAL_HOST_NODE
      || request.harbor.spawnEnv.HARNESS_EVAL_HOST_NODE_SHA256 !== parsed.agentEnv.HARNESS_EVAL_HOST_NODE_SHA256) {
    fail('host Node attestation drifted between Harbor env and argv', 'ERR_TRIAL_ARCHIVE_ARGV');
  }

  let security = null;
  if (parsed.launch === 'trial') {
    const taskRoot = assertRealDirectory(path.join(parsed.dataset, parsed.task), 'Harbor task root');
    const material = lockedTaskSecurity(taskRoot, parsed, trial.trialId);
    security = material.binding;
    if (material.contract.composePath !== TASK_SECURITY_COMPOSE_PATH) {
      fail('code-owned security Compose path drifted', 'ERR_TRIAL_ARCHIVE_SECURITY');
    }
  }

  const entries = [];
  const seen = new Set();
  for (const directory of [
    'work', 'work/.engineer', 'work/control', 'work/jobs', 'work/telemetry',
    'work/.home', 'work/.home/xdg-config', 'work/.home/xdg-cache', 'work/.home/tmp', 'work/.home/docker',
    'work/mounts',
  ]) addDirectory(entries, seen, directory);
  addTree(entries, seen, parsed.dataset, 'work/dataset');
  addTree(entries, seen, spawn.bridge, 'work/bridge');
  parsed.mounts.forEach((mount, index) => addMountSource(
    entries,
    seen,
    mount.source,
    `work/mounts/${String(index).padStart(3, '0')}`,
    mount.sourceKind,
  ));
  const condition = readAttestedFile(parsed.condition, cwd, 'condition file');
  validateConditionExecutionMode(condition.bytes, trial);
  addFile(entries, seen, 'work/control/condition.json', condition.bytes, 0o600);
  condition.bytes.fill(0);
  if (security !== null) {
    const contract = createTrialSecurityContract({
      trialId: trial.trialId,
      immutableImage: security.immutableImage,
      cpus: security.resources.cpus,
      memoryMb: security.resources.memoryMb,
      pidsLimit: security.resources.pidsLimit,
    });
    const composeBytes = Buffer.from(contract.canonicalCompose);
    addFile(entries, seen, 'work/control/security-compose.json', composeBytes, 0o600);
    composeBytes.fill(0);
  }

  const rewritten = parsed.values.slice();
  if (parsed.launch === 'trial') {
    replaceArgAfter(rewritten, '--path', `${REMOTE_ROOT}/dataset/${parsed.task}`);
    replaceArgAfter(rewritten, '--trials-dir', `${REMOTE_ROOT}/jobs/${parsed.jobName}`);
    replaceArgAfter(rewritten, '--extra-docker-compose', TASK_SECURITY_COMPOSE_PATH);
  } else {
    replaceArgAfter(rewritten, '-p', `${REMOTE_ROOT}/dataset`);
    replaceArgAfter(rewritten, '--jobs-dir', `${REMOTE_ROOT}/jobs`);
  }
  const remoteMounts = parsed.mounts.map((mount, index) => ({
    type: 'bind',
    source: `${REMOTE_ROOT}/mounts/${String(index).padStart(3, '0')}`,
    target: mount.target,
    read_only: true,
  }));
  replaceArgAfter(rewritten, '--mounts', canonicalJson(remoteMounts));
  replaceAgentEnv(rewritten, 'HARNESS_EVAL_TB_CONDITION', `${REMOTE_ROOT}/control/condition.json`);
  replaceAgentEnv(rewritten, 'HARNESS_EVAL_TB_TELEMETRY_FILE', `${REMOTE_ROOT}/telemetry/done.json`);
  replaceAgentEnv(rewritten, 'HARNESS_EVAL_HOST_NODE', REMOTE_NODE);
  replaceAgentEnv(rewritten, 'HARNESS_EVAL_HOST_NODE_SHA256', ZERO_HASH);
  const baseEnv = {
    DOCKER_CONFIG: `${REMOTE_ROOT}/.home/docker`,
    HARNESS_EVAL_HOST_NODE: REMOTE_NODE,
    HARNESS_EVAL_HOST_NODE_SHA256: ZERO_HASH,
    HOME: `${REMOTE_ROOT}/.home`,
    LANG: request.harbor.spawnEnv.LANG ?? 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    PYTHONNOUSERSITE: '1',
    PYTHONPATH: `${REMOTE_ROOT}/bridge`,
    PYTHONSAFEPATH: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    TMPDIR: `${REMOTE_ROOT}/.home/tmp`,
    XDG_CACHE_HOME: `${REMOTE_ROOT}/.home/xdg-cache`,
    XDG_CONFIG_HOME: `${REMOTE_ROOT}/.home/xdg-config`,
  };
  if (request.harbor.spawnEnv.LC_ALL) baseEnv.LC_ALL = request.harbor.spawnEnv.LC_ALL;

  const document = {
    schema: 'engineer-trial-input.v1',
    archiveEncoding: TRIAL_ARCHIVE_ENCODING,
    logicalRoot: REMOTE_ROOT,
    trial,
    security,
    harbor: {
      executable: REMOTE_HARBOR,
      args: rewritten,
      cwd: REMOTE_ROOT,
      timeoutMs: request.harbor.timeoutMs,
      baseEnv,
      runtimeNodeAttestation: { executable: REMOTE_NODE, digestPlaceholder: ZERO_HASH },
    },
    output: {
      jobsPath: `${REMOTE_ROOT}/jobs`,
      telemetryPath: `${REMOTE_ROOT}/telemetry/done.json`,
      jobName: parsed.jobName,
    },
    content: contentManifest(entries, TRIAL_INPUT_MANIFEST_PATH),
  };
  const manifestBytes = Buffer.from(canonicalJson(document));
  addFile(entries, seen, TRIAL_INPUT_MANIFEST_PATH, manifestBytes, 0o600);
  manifestBytes.fill(0);
  const bytes = encodeTar(entries);
  const manifest = archiveManifest(bytes, 'task-input');
  for (const entry of entries) entry.bytes.fill(0);
  const telemetryRelativePath = path.relative(requestedCwd, parsed.telemetry);
  return Object.freeze({
    bytes,
    manifest,
    materialization: Object.freeze({
      schema: 'engineer-trial-output-materialization.v1',
      inputArchiveSha256: manifest.sha256,
      controllerWorkRoot: cwd,
      jobsDirectory: cwd,
      jobsRelativePath: path.relative(requestedCwd, parsed.jobsDirectory),
      telemetryRelativePath,
      jobName: parsed.jobName,
      trialId: trial.trialId,
    }),
  });
}

function parseDocumentEntry(entries, documentPath) {
  const matches = entries.filter((entry) => entry.path === documentPath && entry.type === 'file');
  if (matches.length !== 1 || matches[0].bytes.length < 2 || matches[0].bytes.length > MAX_JSON_BYTES) {
    fail('archive control document is missing or oversized', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  let document;
  try {
    const text = matches[0].bytes.toString('utf8');
    document = JSON.parse(text);
    if (!plainObject(document) || canonicalJson(document) !== text) throw new Error('noncanonical');
  } catch {
    fail('archive control document is malformed or noncanonical', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  return document;
}

function validateInputDocument(document, entries) {
  exactKeys(document, ['schema', 'archiveEncoding', 'logicalRoot', 'trial', 'security', 'harbor', 'output', 'content'], 'trial input manifest');
  if (document.schema !== 'engineer-trial-input.v1' || document.archiveEncoding !== TRIAL_ARCHIVE_ENCODING
      || document.logicalRoot !== REMOTE_ROOT) fail('trial input manifest identity drifted', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  validateContentManifest(entries, document, TRIAL_INPUT_MANIFEST_PATH, 'content');
  if (!plainObject(document.trial) || !plainObject(document.harbor) || !plainObject(document.output)) {
    fail('trial input manifest sections are invalid', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  safeId(document.trial.trialId, 'trial id');
  if (document.harbor.executable !== REMOTE_HARBOR || document.harbor.cwd !== REMOTE_ROOT
      || !Array.isArray(document.harbor.args) || !plainObject(document.harbor.baseEnv)
      || document.output.jobsPath !== `${REMOTE_ROOT}/jobs`
      || document.output.telemetryPath !== `${REMOTE_ROOT}/telemetry/done.json`) {
    fail('trial input runtime paths drifted', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  const securityComposeArguments = document.harbor.args.filter((value) => value === '--extra-docker-compose');
  if (document.security === null) {
    if (securityComposeArguments.length !== 0) {
      fail('unbound security Compose argument is present', 'ERR_TRIAL_ARCHIVE_SECURITY');
    }
  } else {
    exactKeys(document.security, [
      'schema', 'composePath', 'composeHash', 'identity', 'immutableImage',
      'resources', 'writablePaths', 'bindingHash',
    ], 'trial security binding');
    exactKeys(document.security.resources,
      ['cpus', 'memoryMb', 'storageMb', 'pidsLimit'], 'trial security resources');
    const contract = createTrialSecurityContract({
      trialId: document.trial.trialId,
      immutableImage: document.security.immutableImage,
      cpus: document.security.resources.cpus,
      memoryMb: document.security.resources.memoryMb,
      pidsLimit: document.security.resources.pidsLimit,
    });
    const { bindingHash, ...unsigned } = document.security;
    if (bindingHash !== sha256(canonicalJson(unsigned))
        || document.security.schema !== contract.schema
        || document.security.composePath !== TASK_SECURITY_COMPOSE_PATH
        || document.security.composeHash !== contract.composeHash
        || canonicalJson(document.security.identity) !== canonicalJson(contract.identity)
        || canonicalJson(document.security.writablePaths) !== canonicalJson(contract.writablePaths)
        || securityComposeArguments.length !== 1) {
      fail('trial security binding drifted', 'ERR_TRIAL_ARCHIVE_SECURITY');
    }
    const flagIndex = document.harbor.args.indexOf('--extra-docker-compose');
    if (document.harbor.args[flagIndex + 1] !== TASK_SECURITY_COMPOSE_PATH) {
      fail('trial security Compose argument drifted', 'ERR_TRIAL_ARCHIVE_SECURITY');
    }
    const mountFlags = document.harbor.args.map((value, index) => value === '--mounts' ? index : -1)
      .filter((index) => index >= 0);
    let archivedMounts;
    try {
      if (mountFlags.length !== 1) throw new Error('mount flag count');
      archivedMounts = JSON.parse(document.harbor.args[mountFlags[0] + 1]);
    } catch {
      fail('archived condition mount inventory is malformed', 'ERR_TRIAL_ARCHIVE_SECURITY');
    }
    validateConditionMountTargets(archivedMounts, document.trial.condition, { archived: true });
    const compose = entries.filter((entry) => entry.type === 'file'
      && entry.path === 'work/control/security-compose.json');
    if (compose.length !== 1 || sha256(compose[0].bytes) !== contract.composeHash
        || compose[0].bytes.toString('utf8') !== contract.canonicalCompose) {
      fail('trial security Compose content drifted', 'ERR_TRIAL_ARCHIVE_SECURITY');
    }
  }
  const allowedRoots = [
    'work/.engineer', 'work/control', 'work/jobs', 'work/telemetry', 'work/.home',
    'work/mounts', 'work/dataset', 'work/bridge',
  ];
  if (entries.some((entry) => entry.path !== 'work'
      && !allowedRoots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`)))) {
    fail('trial input contains an entry outside its fixed layout', 'ERR_TRIAL_ARCHIVE_PATH');
  }
  scanCredentialMetadata(document, 'trial input manifest');
}

function validateOutputDocument(document, entries) {
  exactKeys(document, [
    'schema', 'archiveEncoding', 'inputArchiveSha256', 'trialId', 'jobName',
    'executionMode', 'runtimeBindingHash', 'brokerBindingHash', 'harbor', 'payload',
  ], 'trial output receipt');
  if (document.schema !== 'engineer-trial-runner-receipt.v1' || document.archiveEncoding !== TRIAL_ARCHIVE_ENCODING
      || !HASH.test(document.inputArchiveSha256) || !HASH.test(document.runtimeBindingHash)) {
    fail('trial output receipt identity drifted', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  if (!['controlled-provider', 'zero-provider-canary'].includes(document.executionMode)) {
    fail('trial output receipt execution mode is invalid', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  if (document.executionMode === 'controlled-provider') {
    if (!HASH.test(String(document.brokerBindingHash ?? ''))
        || document.brokerBindingHash !== document.runtimeBindingHash) {
      fail('controlled trial output must bind one exact provider broker runtime', 'ERR_TRIAL_ARCHIVE_DIGEST');
    }
  } else if (document.brokerBindingHash !== null) {
    fail('zero-provider trial output cannot contain a provider broker binding', 'ERR_TRIAL_ARCHIVE_DIGEST');
  }
  safeId(document.trialId, 'output trial id');
  safeId(document.jobName, 'output job name', SAFE_JOB);
  exactKeys(document.harbor, [
    'code', 'signal', 'timedOut', 'spawnError', 'stdoutBytes', 'stdoutSha256', 'stderrBytes', 'stderrSha256',
  ], 'Harbor runner receipt');
  if (document.harbor.code !== null) boundedInteger(document.harbor.code, 'Harbor exit code', 0, 255);
  if (document.harbor.signal !== null) safeId(document.harbor.signal, 'Harbor signal', /^[A-Z][A-Z0-9]{0,31}$/);
  if (typeof document.harbor.timedOut !== 'boolean'
      || document.harbor.spawnError !== null && !/^[A-Z0-9_:-]{1,80}$/.test(document.harbor.spawnError)
      || !HASH.test(document.harbor.stdoutSha256) || !HASH.test(document.harbor.stderrSha256)) {
    fail('Harbor runner receipt is invalid', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  boundedInteger(document.harbor.stdoutBytes, 'Harbor stdout bytes', 0, 1024 * 1024);
  boundedInteger(document.harbor.stderrBytes, 'Harbor stderr bytes', 0, 1024 * 1024);
  validateContentManifest(entries, document, TRIAL_OUTPUT_RECEIPT_PATH, 'payload');
  if (entries.some((entry) => !(entry.path === 'work'
      || entry.path === 'work/.engineer'
      || entry.path === TRIAL_OUTPUT_RECEIPT_PATH
      || entry.path === 'work/jobs'
      || entry.path === `work/jobs/${document.jobName}`
      || entry.path.startsWith(`work/jobs/${document.jobName}/`)
      || entry.path === 'work/telemetry'
      || entry.path === 'work/telemetry/done.json'))) {
    fail('trial output contains an entry outside jobs or telemetry', 'ERR_TRIAL_ARCHIVE_PATH');
  }
  for (const item of document.payload) {
    if (!(item.path === 'work/telemetry/done.json'
        || item.path.startsWith(`work/jobs/${document.jobName}/`))) {
      fail('trial output contains a path outside jobs or telemetry', 'ERR_TRIAL_ARCHIVE_PATH');
    }
  }
  scanCredentialMetadata(document, 'trial output receipt');
}

export function inspectTrialArchive(bytes, { kind } = {}) {
  if (!['task-input', 'trial-output'].includes(kind)) fail('archive kind is invalid', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  const entries = parseTar(bytes);
  try {
    if (entries.some((entry) => !(entry.path === 'work' || entry.path.startsWith('work/')))) {
      fail('archive entry escaped the fixed work root', 'ERR_TRIAL_ARCHIVE_PATH');
    }
    const controlPath = kind === 'task-input' ? TRIAL_INPUT_MANIFEST_PATH : TRIAL_OUTPUT_RECEIPT_PATH;
    const document = parseDocumentEntry(entries, controlPath);
    if (kind === 'task-input') validateInputDocument(document, entries);
    else validateOutputDocument(document, entries);
    return { entries, document, manifest: archiveManifest(Buffer.from(bytes), kind) };
  } catch (error) {
    for (const entry of entries) entry.bytes.fill(0);
    throw error;
  }
}

function ensureFreshDestination(destination) {
  normalizedAbsolute(destination, 'archive extraction destination');
  const parent = path.dirname(destination);
  assertRealDirectory(parent, 'archive extraction parent');
  try {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(destination).length !== 0) {
      fail('archive extraction root must be a fresh non-symlink directory', 'ERR_TRIAL_ARCHIVE_PATH');
    }
    fs.chmodSync(destination, 0o700);
  } catch (error) {
    if (error instanceof TrialArchiveError) throw error;
    if (error?.code !== 'ENOENT') fail('archive extraction root is unavailable', 'ERR_TRIAL_ARCHIVE_PATH');
    fs.mkdirSync(destination, { mode: 0o700 });
  }
}

function writeEntries(entries, destination, prefix = 'work') {
  ensureFreshDestination(destination);
  const relevant = entries.filter((entry) => entry.path === prefix || entry.path.startsWith(`${prefix}/`));
  for (const entry of relevant) {
    const relative = entry.path === prefix ? '' : entry.path.slice(prefix.length + 1);
    if (relative === '') continue;
    safeRelativeName(relative, 'extracted archive path');
    const target = path.join(destination, ...relative.split('/'));
    if (!below(destination, target)) fail('archive extraction escaped its destination', 'ERR_TRIAL_ARCHIVE_PATH');
    if (entry.type === 'directory') {
      fs.mkdirSync(target, { mode: 0o700 });
      fs.chmodSync(target, 0o700);
    } else {
      const parent = path.dirname(target);
      const parentStat = fs.lstatSync(parent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail('archive extraction parent is unsafe', 'ERR_TRIAL_ARCHIVE_PATH');
      const descriptor = fs.openSync(target, FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | (FS_CONSTANTS.O_NOFOLLOW ?? 0), entry.mode);
      try {
        fs.writeFileSync(descriptor, entry.bytes);
        fs.fchmodSync(descriptor, entry.mode);
      } finally {
        fs.closeSync(descriptor);
      }
    }
  }
}

export function extractTrialInputArchive(bytes, { destination, expectedSha256 } = {}) {
  if (!HASH.test(String(expectedSha256 ?? '')) || sha256(bytes) !== expectedSha256) {
    fail('task input archive digest drifted', 'ERR_TRIAL_ARCHIVE_DIGEST');
  }
  const inspected = inspectTrialArchive(bytes, { kind: 'task-input' });
  try {
    writeEntries(inspected.entries, destination);
    return Object.freeze(structuredClone(inspected.document));
  } finally {
    for (const entry of inspected.entries) entry.bytes.fill(0);
  }
}

function sanitizeCommandResult(result) {
  if (!plainObject(result)) fail('Harbor command result is invalid', 'ERR_TRIAL_ARCHIVE_RUNNER');
  const stdout = Buffer.from(result.stdout ?? '');
  const stderr = Buffer.from(result.stderr ?? '');
  if (stdout.length > 1024 * 1024 || stderr.length > 1024 * 1024) fail('Harbor output exceeds its receipt bound', 'ERR_TRIAL_ARCHIVE_BOUND');
  const errorCode = result.error?.code == null ? null : String(result.error.code);
  const spawnError = errorCode == null
    ? null
    : /^[A-Z0-9_:-]{1,80}$/.test(errorCode) ? errorCode : `ERR_${sha256(errorCode).slice(0, 16).toUpperCase()}`;
  const status = Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : null;
  const signal = result.signal == null ? null : String(result.signal);
  if (signal !== null && !/^[A-Z][A-Z0-9]{0,31}$/.test(signal)) fail('Harbor signal is invalid', 'ERR_TRIAL_ARCHIVE_RUNNER');
  const receipt = {
    code: status,
    signal,
    timedOut: errorCode === 'ETIMEDOUT',
    spawnError: errorCode === 'ETIMEDOUT' ? null : spawnError,
    stdoutBytes: stdout.length,
    stdoutSha256: sha256(stdout),
    stderrBytes: stderr.length,
    stderrSha256: sha256(stderr),
  };
  stdout.fill(0);
  stderr.fill(0);
  return receipt;
}

export function createTrialOutputArchive({
  workRoot,
  inputArchiveSha256,
  trialId,
  jobName,
  executionMode,
  runtimeBindingHash,
  brokerBindingHash,
  commandResult,
} = {}) {
  assertRealDirectory(workRoot, 'remote work root');
  if (!HASH.test(String(inputArchiveSha256 ?? '')) || !HASH.test(String(runtimeBindingHash ?? ''))) {
    fail('output receipt digest binding is invalid', 'ERR_TRIAL_ARCHIVE_DIGEST');
  }
  if (!['controlled-provider', 'zero-provider-canary'].includes(executionMode)) {
    fail('output receipt execution mode is invalid', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  if (executionMode === 'controlled-provider') {
    if (!HASH.test(String(brokerBindingHash ?? '')) || brokerBindingHash !== runtimeBindingHash) {
      fail('controlled output receipt requires one exact provider broker binding', 'ERR_TRIAL_ARCHIVE_DIGEST');
    }
  } else if (brokerBindingHash !== null) {
    fail('zero-provider output receipt must not contain a provider broker binding', 'ERR_TRIAL_ARCHIVE_DIGEST');
  }
  safeId(trialId, 'output trial id');
  safeId(jobName, 'output job name', SAFE_JOB);
  const entries = [];
  const seen = new Set();
  for (const directory of ['work', 'work/.engineer']) addDirectory(entries, seen, directory);
  const jobsRoot = path.join(workRoot, 'jobs');
  if (fs.existsSync(jobsRoot)) {
    assertRealDirectory(jobsRoot, 'remote jobs root');
    const jobEntries = fs.readdirSync(jobsRoot, { withFileTypes: true });
    if (jobEntries.some((entry) => entry.name !== jobName)) fail('remote jobs root contains an unexpected job', 'ERR_TRIAL_ARCHIVE_PATH');
    const jobRoot = path.join(jobsRoot, jobName);
    if (fs.existsSync(jobRoot)) {
      addDirectory(entries, seen, 'work/jobs');
      addTree(entries, seen, jobRoot, `work/jobs/${jobName}`);
    }
  }
  const telemetry = path.join(workRoot, 'telemetry', 'done.json');
  if (fs.existsSync(telemetry)) {
    addDirectory(entries, seen, 'work/telemetry');
    const read = readAttestedFile(telemetry, workRoot, 'remote telemetry');
    addFile(entries, seen, 'work/telemetry/done.json', read.bytes, 0o600);
    read.bytes.fill(0);
  }
  const harbor = sanitizeCommandResult(commandResult);
  const receipt = {
    schema: 'engineer-trial-runner-receipt.v1',
    archiveEncoding: TRIAL_ARCHIVE_ENCODING,
    inputArchiveSha256,
    trialId,
    jobName,
    executionMode,
    runtimeBindingHash,
    brokerBindingHash,
    harbor,
    payload: contentManifest(entries, TRIAL_OUTPUT_RECEIPT_PATH),
  };
  const receiptBytes = Buffer.from(canonicalJson(receipt));
  addFile(entries, seen, TRIAL_OUTPUT_RECEIPT_PATH, receiptBytes, 0o600);
  receiptBytes.fill(0);
  const bytes = encodeTar(entries);
  for (const entry of entries) entry.bytes.fill(0);
  return Object.freeze({
    bytes,
    manifest: archiveManifest(bytes, 'trial-output'),
    receipt: Object.freeze(receipt),
    run: Object.freeze({
      code: harbor.code,
      signal: harbor.signal,
      stdout: '',
      stderr: '',
      timedOut: harbor.timedOut,
      spawnError: harbor.spawnError,
      containmentComplete: true,
    }),
  });
}

function ensureMaterialization(value) {
  exactKeys(value, [
    'schema', 'inputArchiveSha256', 'controllerWorkRoot', 'jobsDirectory', 'jobsRelativePath',
    'telemetryRelativePath', 'jobName', 'trialId',
  ], 'trial output materialization');
  if (value.schema !== 'engineer-trial-output-materialization.v1' || !HASH.test(value.inputArchiveSha256)) {
    fail('trial output materialization identity drifted', 'ERR_TRIAL_ARCHIVE_SCHEMA');
  }
  const root = assertRealDirectory(value.controllerWorkRoot, 'controller work root');
  if (value.jobsDirectory !== root) fail('materialization jobs root drifted', 'ERR_TRIAL_ARCHIVE_PATH');
  safeRelativeName(value.jobsRelativePath, 'jobs relative path');
  safeRelativeName(value.telemetryRelativePath, 'telemetry relative path');
  safeId(value.jobName, 'materialization job name', SAFE_JOB);
  safeId(value.trialId, 'materialization trial id');
  return { ...value, controllerWorkRoot: root };
}

function ensureDirectoryChain(root, relative) {
  let current = root;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('materialization parent is unsafe', 'ERR_TRIAL_ARCHIVE_PATH');
    } catch (error) {
      if (error instanceof TrialArchiveError) throw error;
      if (error?.code !== 'ENOENT') fail('materialization parent is unavailable', 'ERR_TRIAL_ARCHIVE_PATH');
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  return current;
}

export function applyTrialOutputArchive({
  bytes,
  expectedSha256,
  expectedByteLength,
  materialization: inputMaterialization,
} = {}) {
  if (!HASH.test(String(expectedSha256 ?? '')) || sha256(bytes) !== expectedSha256
      || !Number.isSafeInteger(expectedByteLength) || Buffer.byteLength(bytes) !== expectedByteLength) {
    fail('trial output archive digest or size drifted', 'ERR_TRIAL_ARCHIVE_DIGEST');
  }
  const materialization = ensureMaterialization(inputMaterialization);
  const inspected = inspectTrialArchive(bytes, { kind: 'trial-output' });
  const stage = fs.mkdtempSync(path.join(materialization.controllerWorkRoot, '.engineer-trial-output-'));
  fs.chmodSync(stage, 0o700);
  let telemetryInstalled = false;
  let installedTelemetry = null;
  try {
    const receipt = inspected.document;
    if (receipt.inputArchiveSha256 !== materialization.inputArchiveSha256
        || receipt.trialId !== materialization.trialId || receipt.jobName !== materialization.jobName) {
      fail('trial output receipt does not bind the requested trial', 'ERR_TRIAL_ARCHIVE_DIGEST');
    }
    writeEntries(inspected.entries, path.join(stage, 'payload'));
    const stagedRoot = path.join(stage, 'payload');
    const stagedJob = path.join(stagedRoot, 'jobs', materialization.jobName);
    const stagedTelemetry = path.join(stagedRoot, 'telemetry', 'done.json');
    const jobsRoot = ensureDirectoryChain(materialization.controllerWorkRoot, materialization.jobsRelativePath);
    const jobTarget = path.join(jobsRoot, materialization.jobName);
    const telemetryTarget = path.join(materialization.controllerWorkRoot, ...materialization.telemetryRelativePath.split('/'));
    if (fs.existsSync(jobTarget) || fs.existsSync(telemetryTarget)) {
      fail('trial output would overwrite existing controller evidence', 'ERR_TRIAL_ARCHIVE_PATH');
    }
    ensureDirectoryChain(materialization.controllerWorkRoot, path.posix.dirname(materialization.telemetryRelativePath) === '.'
      ? '' : path.posix.dirname(materialization.telemetryRelativePath));
    if (fs.existsSync(stagedTelemetry)) {
      fs.linkSync(stagedTelemetry, telemetryTarget);
      fs.chmodSync(telemetryTarget, 0o600);
      installedTelemetry = telemetryTarget;
      telemetryInstalled = true;
    }
    if (fs.existsSync(stagedJob)) fs.renameSync(stagedJob, jobTarget);
    return Object.freeze({
      code: receipt.harbor.code,
      signal: receipt.harbor.signal,
      stdout: '',
      stderr: '',
      timedOut: receipt.harbor.timedOut,
      spawnError: receipt.harbor.spawnError,
      containmentComplete: true,
    });
  } catch (error) {
    if (telemetryInstalled && installedTelemetry) {
      try { fs.unlinkSync(installedTelemetry); } catch { /* remove only the file this call linked */ }
    }
    throw error;
  } finally {
    for (const entry of inspected.entries) entry.bytes.fill(0);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
