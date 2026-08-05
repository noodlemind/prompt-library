import crypto from 'node:crypto';
import fs, { constants as FS_CONSTANTS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

import {
  TASK_INPUT_ARCHIVE_LIMITS,
  archiveLimitsForKind,
} from './archive-limits.mjs';

export const ARCHIVE_READY_LINE = 'ENGINEER-ARCHIVE/1 READY';
export const SUPERVISOR_READY_LINE = 'ENGINEER-SUPERVISOR/1 READY';

const ARCHIVE_REQUEST_SCHEMA = 'engineer-daytona-archive-request.v1';
const ARCHIVE_RESULT_SCHEMA = 'engineer-daytona-archive-result.v1';
const SECRET_RESULT_SCHEMA = 'engineer-supervisor-secret-accepted.v1';
const CONTROL_CHANNEL_SCHEMA = 'engineer-authenticated-control-channel.v1';
const CONTROLLED_SECRET_FRAME_MAGIC = 'EHS1';
const ZERO_PROVIDER_SECRET_FRAME_MAGIC = 'EHZ1';
const CONTROLLED_PROVIDER = 'controlled-provider';
const ZERO_PROVIDER_CANARY = 'zero-provider-canary';
const DEFAULT_TRANSPORT_DIRECTORY = '/engineer-bounded/transport';
const MAX_JSON_FRAME_BYTES = 8 * 1024;
const MAX_SECRET_FRAME_BYTES = 1_024;
const MAX_PROTOCOL_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = TASK_INPUT_ARCHIVE_LIMITS.compressedBytes;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const ARCHIVES = Object.freeze({
  'task-input': Object.freeze({
    operation: 'upload',
    logicalPath: '/engineer-bounded/transport/task-input.tar',
    filename: 'task-input.tar',
  }),
  'trial-output': Object.freeze({
    operation: 'download',
    logicalPath: '/engineer-bounded/transport/trial-output.tar',
    filename: 'trial-output.tar',
  }),
});

export class RemoteBridgeError extends Error {
  constructor(message, code = 'ERR_REMOTE_BRIDGE') {
    super(message);
    this.name = 'RemoteBridgeError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new RemoteBridgeError(message, code);
}

function sanitized(error, message, code) {
  if (error instanceof RemoteBridgeError) return error;
  return new RemoteBridgeError(message, code);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`, 'ERR_REMOTE_SCHEMA');
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    fail(`${label} contains an unexpected field`, 'ERR_REMOTE_SCHEMA');
  }
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateExecutionMode(value) {
  if (value !== CONTROLLED_PROVIDER && value !== ZERO_PROVIDER_CANARY) {
    fail('execution mode is invalid', 'ERR_REMOTE_SECRET_FRAME');
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))) {
    return JSON.stringify(value);
  }
  fail('control channel receipt contains a non-canonical value', 'ERR_REMOTE_CHANNEL_IDENTITY');
}

function descriptorIdentity(stream, expected, label) {
  if (stream !== expected || !Number.isSafeInteger(stream?.fd)) return null;
  let stat;
  try { stat = fs.fstatSync(stream.fd, { bigint: true }); } catch {
    fail(`${label} descriptor cannot be inspected`, 'ERR_REMOTE_CHANNEL_IDENTITY');
  }
  const kind = stat.isFIFO() ? 'pipe' : stat.isSocket() ? 'socket' : null;
  if (kind === null || Number(stat.uid) !== (process.geteuid?.() ?? process.getuid?.())) {
    fail(`${label} is not an inherited owner-bound pipe or socket`,
      'ERR_REMOTE_CHANNEL_IDENTITY');
  }
  return {
    fd: stream.fd,
    kind,
    device: stat.dev.toString(10),
    inode: stat.ino.toString(10),
    mode: Number(stat.mode) & 0o7777,
    ownerUid: Number(stat.uid),
    ownerGid: Number(stat.gid),
  };
}

function inspectInheritedControlChannel(input, output) {
  const inputDescriptor = descriptorIdentity(input, process.stdin, 'control input');
  const outputDescriptor = descriptorIdentity(output, process.stdout, 'control output');
  if (inputDescriptor === null || outputDescriptor === null) {
    return {
      kind: 'unbound-stream',
      kernelBound: false,
      inputDescriptor: null,
      outputDescriptor: null,
    };
  }
  const kinds = new Set([inputDescriptor.kind, outputDescriptor.kind]);
  if (kinds.size !== 1) fail('control descriptors use mismatched kernel transports',
    'ERR_REMOTE_CHANNEL_IDENTITY');
  return {
    kind: inputDescriptor.kind === 'pipe' ? 'inherited-pipe' : 'inherited-socket',
    kernelBound: true,
    inputDescriptor,
    outputDescriptor,
  };
}

function createAuthenticatedControlChannel({
  hmacKey,
  executionMode,
  frameSha256,
  input,
  output,
  inspectControlChannel,
}) {
  const inspected = inspectControlChannel(input, output);
  if (!isPlainObject(inspected)) fail('control channel inspection is invalid',
    'ERR_REMOTE_CHANNEL_IDENTITY');
  const unsigned = {
    schema: CONTROL_CHANNEL_SCHEMA,
    kind: inspected.kind,
    kernelBound: inspected.kernelBound,
    executionMode: validateExecutionMode(executionMode),
    frameSha256,
    inputDescriptor: inspected.inputDescriptor,
    outputDescriptor: inspected.outputDescriptor,
  };
  const canonical = canonicalJson(unsigned);
  const authenticationTag = crypto.createHmac('sha256', hmacKey).update(canonical).digest('hex');
  const receiptHash = sha256(canonicalJson({ ...unsigned, authenticationTag }));
  return Object.freeze({
    ...unsigned,
    authenticationTag,
    receiptHash,
    open: input.destroyed !== true && output.destroyed !== true,
    stream: input,
  });
}

/** Verify that a live kernel descriptor receipt was authenticated by this handshake key. */
export function verifyAuthenticatedControlChannel(value, hmacKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('authenticated control channel is missing', 'ERR_REMOTE_CHANNEL_IDENTITY');
  }
  const expected = new Set([
    'schema', 'kind', 'kernelBound', 'executionMode', 'frameSha256', 'inputDescriptor',
    'outputDescriptor', 'authenticationTag', 'receiptHash', 'open', 'stream',
  ]);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
      value.schema !== CONTROL_CHANNEL_SCHEMA ||
      !['inherited-pipe', 'inherited-socket'].includes(value.kind) ||
      ![CONTROLLED_PROVIDER, ZERO_PROVIDER_CANARY].includes(value.executionMode) ||
      value.kernelBound !== true || value.open !== true ||
      !SHA256_HEX.test(String(value.frameSha256)) ||
      !SHA256_HEX.test(String(value.authenticationTag)) ||
      !SHA256_HEX.test(String(value.receiptHash)) ||
      !value.stream || typeof value.stream.once !== 'function' || value.stream.destroyed === true) {
    fail('authenticated control channel is not a live kernel-bound transport',
      'ERR_REMOTE_CHANNEL_IDENTITY');
  }
  for (const [label, descriptor, expectedKind] of [
    ['input', value.inputDescriptor, value.kind === 'inherited-pipe' ? 'pipe' : 'socket'],
    ['output', value.outputDescriptor, value.kind === 'inherited-pipe' ? 'pipe' : 'socket'],
  ]) {
    exactKeys(descriptor, ['fd', 'kind', 'device', 'inode', 'mode', 'ownerUid', 'ownerGid'],
      `${label} control descriptor`);
    if (!Number.isSafeInteger(descriptor.fd) || descriptor.fd < 0 ||
        descriptor.kind !== expectedKind || !/^(?:0|[1-9][0-9]*)$/.test(descriptor.device) ||
        !/^[1-9][0-9]*$/.test(descriptor.inode) ||
        !Number.isSafeInteger(descriptor.mode) || !Number.isSafeInteger(descriptor.ownerUid) ||
        !Number.isSafeInteger(descriptor.ownerGid)) {
      fail(`${label} control descriptor identity drifted`, 'ERR_REMOTE_CHANNEL_IDENTITY');
    }
  }
  if ((!Buffer.isBuffer(hmacKey) && !(hmacKey instanceof Uint8Array)) || hmacKey.byteLength !== 32) {
    fail('control channel authentication key is invalid', 'ERR_REMOTE_CHANNEL_IDENTITY');
  }
  const unsigned = {
    schema: value.schema,
    kind: value.kind,
    kernelBound: value.kernelBound,
    executionMode: value.executionMode,
    frameSha256: value.frameSha256,
    inputDescriptor: value.inputDescriptor,
    outputDescriptor: value.outputDescriptor,
  };
  const expectedTag = crypto.createHmac('sha256', hmacKey)
    .update(canonicalJson(unsigned)).digest('hex');
  const expectedReceiptHash = sha256(canonicalJson({ ...unsigned, authenticationTag: expectedTag }));
  if (!timingSafeHexEqual(value.authenticationTag, expectedTag) ||
      !timingSafeHexEqual(value.receiptHash, expectedReceiptHash)) {
    fail('control channel handshake authentication drifted', 'ERR_REMOTE_CHANNEL_IDENTITY');
  }
  return Object.freeze({
    schema: value.schema,
    kind: value.kind,
    kernelBound: true,
    executionMode: value.executionMode,
    authenticated: true,
    open: true,
    receiptHash: value.receiptHash,
    inputDescriptorHash: sha256(canonicalJson(value.inputDescriptor)),
    outputDescriptorHash: sha256(canonicalJson(value.outputDescriptor)),
    stream: value.stream,
  });
}

function timingSafeHexEqual(left, right) {
  if (!SHA256_HEX.test(String(left)) || !SHA256_HEX.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function asBytes(value, label, maximum) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail(`${label} must be bytes`, 'ERR_REMOTE_FRAME');
  }
  if (value.byteLength < 1 || value.byteLength > maximum) {
    fail(`${label} exceeds its byte bound`, 'ERR_REMOTE_FRAME');
  }
  return Buffer.from(value);
}

function parseJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    fail(`${label} is malformed`, 'ERR_REMOTE_SCHEMA');
  }
  if (!isPlainObject(value)) fail(`${label} must be an object`, 'ERR_REMOTE_SCHEMA');
  return value;
}

function encodeJson(value, label) {
  let bytes;
  try {
    bytes = Buffer.from(JSON.stringify(value));
  } catch {
    fail(`${label} is not serializable`, 'ERR_REMOTE_SCHEMA');
  }
  if (bytes.length < 1 || bytes.length > MAX_JSON_FRAME_BYTES) {
    bytes?.fill(0);
    fail(`${label} exceeds its byte bound`, 'ERR_REMOTE_FRAME');
  }
  return bytes;
}

class BoundedFrameReader {
  constructor(input, maximumBufferedBytes) {
    if (!input || typeof input[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('input must be an async byte stream');
    }
    this.input = input;
    this.iterator = input[Symbol.asyncIterator]();
    this.maximumBufferedBytes = maximumBufferedBytes;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }

  async #pull() {
    if (this.ended) fail('control channel closed before the exchange completed', 'ERR_REMOTE_CHANNEL_LOSS');
    let next;
    try {
      next = await this.iterator.next();
    } catch {
      fail('control channel failed before the exchange completed', 'ERR_REMOTE_CHANNEL_LOSS');
    }
    if (next.done) {
      this.ended = true;
      fail('control channel closed before the exchange completed', 'ERR_REMOTE_CHANNEL_LOSS');
    }
    if (!Buffer.isBuffer(next.value) && !(next.value instanceof Uint8Array) && typeof next.value !== 'string') {
      fail('control channel emitted invalid bytes', 'ERR_REMOTE_FRAME');
    }
    const chunk = Buffer.from(next.value);
    if (chunk.length === 0) return;
    if (chunk.length > this.maximumBufferedBytes || this.buffer.length + chunk.length > this.maximumBufferedBytes) {
      chunk.fill(0);
      fail('control channel exceeds its byte bound', 'ERR_REMOTE_FRAME');
    }
    const combined = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    this.buffer.fill(0);
    chunk.fill(0);
    this.buffer = combined;
  }

  async readExact(length) {
    const result = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      if (this.buffer.length === 0) await this.#pull();
      const take = Math.min(length - offset, this.buffer.length);
      this.buffer.copy(result, offset, 0, take);
      const remainder = Buffer.from(this.buffer.subarray(take));
      this.buffer.fill(0);
      this.buffer = remainder;
      offset += take;
    }
    return result;
  }

  async readFrame(maximum) {
    const header = await this.readExact(4);
    const length = header.readUInt32BE(0);
    header.fill(0);
    if (length < 1 || length > maximum) {
      fail('framed input exceeds its byte bound', 'ERR_REMOTE_FRAME');
    }
    return this.readExact(length);
  }

  assertNoBufferedInput() {
    if (this.buffer.length !== 0 || Number(this.input.readableLength ?? 0) !== 0) {
      fail('framed input contains trailing data', 'ERR_REMOTE_FRAME');
    }
  }

  dispose() {
    this.buffer.fill(0);
    this.buffer = Buffer.alloc(0);
  }
}

async function writeRaw(output, value) {
  if (!output || typeof output.write !== 'function') {
    throw new TypeError('output must be a writable byte stream');
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      output.off?.('error', onError);
      callback();
    };
    const onError = () => finish(() => reject(
      new RemoteBridgeError('control channel write failed', 'ERR_REMOTE_CHANNEL_LOSS')
    ));
    output.once?.('error', onError);
    try {
      output.write(bytes, (error) => {
        if (error) onError();
        else finish(resolve);
      });
    } catch {
      onError();
    }
  });
}

async function writeFrame(output, payload, maximum = MAX_PROTOCOL_FRAME_BYTES) {
  const bytes = asBytes(payload, 'outbound frame', maximum);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  try {
    await writeRaw(output, header);
    await writeRaw(output, bytes);
  } finally {
    header.fill(0);
    bytes.fill(0);
  }
}

function validateTransportDirectory(value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.posix.isAbsolute(value)) {
    throw new TypeError('transportDirectory must be an absolute path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) throw new TypeError('transportDirectory must be normalized');
  return normalized;
}

async function inspectTransportDirectory(directory) {
  let resolved;
  let stat;
  try {
    [resolved, stat] = await Promise.all([fsp.realpath(directory), fsp.lstat(directory)]);
  } catch (error) {
    throw sanitized(error, 'archive path is unavailable', 'ERR_REMOTE_ARCHIVE_PATH');
  }
  if (resolved !== directory || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('archive path must be a real directory', 'ERR_REMOTE_ARCHIVE_PATH');
  }
  if ((stat.mode & 0o022) !== 0) {
    fail('archive path must not be group or world writable', 'ERR_REMOTE_ARCHIVE_PATH');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('archive path must be owned by the bridge user', 'ERR_REMOTE_ARCHIVE_PATH');
  }
}

async function inspectTarget(target, { allowMissing = false, expectedBytes = null } = {}) {
  let stat;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw sanitized(error, 'archive target is unavailable', 'ERR_REMOTE_ARCHIVE_PATH');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('archive target must be a regular file', 'ERR_REMOTE_ARCHIVE_PATH');
  }
  if ((stat.mode & 0o077) !== 0) {
    fail('archive target must have owner-only permissions', 'ERR_REMOTE_ARCHIVE_PATH');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('archive target must be owned by the bridge user', 'ERR_REMOTE_ARCHIVE_PATH');
  }
  if (expectedBytes !== null && stat.size !== expectedBytes) {
    fail('archive target size does not match the request', 'ERR_REMOTE_ARCHIVE_DIGEST');
  }
  return stat;
}

async function writeAtomicOwnerOnly(directory, filename, bytes) {
  const target = path.join(directory, filename);
  await inspectTarget(target, { allowMissing: true });
  const temporary = path.join(
    directory,
    `.${filename}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`
  );
  let handle;
  let renamed = false;
  try {
    const flags = FS_CONSTANTS.O_WRONLY
      | FS_CONSTANTS.O_CREAT
      | FS_CONSTANTS.O_EXCL
      | (FS_CONSTANTS.O_NOFOLLOW ?? 0);
    handle = await fsp.open(temporary, flags, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await inspectTarget(target, { allowMissing: true });
    await fsp.rename(temporary, target);
    renamed = true;
    const written = await inspectTarget(target, { expectedBytes: bytes.length });
    if (!written) fail('archive write did not produce a regular file', 'ERR_REMOTE_ARCHIVE_IO');
  } catch (error) {
    throw sanitized(error, 'archive write failed', 'ERR_REMOTE_ARCHIVE_IO');
  } finally {
    try {
      await handle?.close();
    } catch {
      // The operation is already fail-closed.
    }
    if (!renamed) {
      try {
        await fsp.unlink(temporary);
      } catch {
        // The exclusive temporary file may never have been created.
      }
    }
  }
}

async function readBoundedOwnerOnly(target, expectedBytes) {
  const before = await inspectTarget(target, { expectedBytes });
  let handle;
  let bytes = Buffer.alloc(expectedBytes);
  try {
    const flags = FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0);
    handle = await fsp.open(target, flags);
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.size !== expectedBytes) {
      fail('archive target changed during verification', 'ERR_REMOTE_ARCHIVE_PATH');
    }
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) fail('archive target ended before its declared size', 'ERR_REMOTE_ARCHIVE_DIGEST');
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    const afterEnd = await handle.read(extra, 0, 1, expectedBytes);
    extra.fill(0);
    if (afterEnd.bytesRead !== 0) fail('archive target exceeds its declared size', 'ERR_REMOTE_ARCHIVE_DIGEST');
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== expectedBytes) {
      fail('archive target changed during verification', 'ERR_REMOTE_ARCHIVE_PATH');
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    bytes = null;
    throw sanitized(error, 'archive read failed', 'ERR_REMOTE_ARCHIVE_IO');
  } finally {
    try {
      await handle?.close();
    } catch {
      // The operation is already fail-closed.
    }
  }
}

function validateArchiveRequest(value, maximumArchiveBytes) {
  exactKeys(value, ['schema', 'operation', 'kind', 'path', 'byteLength', 'sha256'], 'archive metadata');
  const definition = ARCHIVES[value.kind];
  if (value.schema !== ARCHIVE_REQUEST_SCHEMA
    || !definition
    || value.operation !== definition.operation
    || value.path !== definition.logicalPath) {
    fail('archive metadata does not match a fixed operation', 'ERR_REMOTE_ARCHIVE_METADATA');
  }
  const operationLimit = definition == null
    ? 0
    : Math.min(maximumArchiveBytes, archiveLimitsForKind(value.kind).compressedBytes);
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 1
      || value.byteLength > operationLimit) {
    fail('archive metadata byte length exceeds its bound', 'ERR_REMOTE_ARCHIVE_METADATA');
  }
  if (typeof value.sha256 !== 'string' || !SHA256_HEX.test(value.sha256)) {
    fail('archive metadata digest is invalid', 'ERR_REMOTE_ARCHIVE_METADATA');
  }
  return Object.freeze({
    schema: value.schema,
    operation: value.operation,
    kind: value.kind,
    path: value.path,
    byteLength: value.byteLength,
    sha256: value.sha256,
    filename: definition.filename,
  });
}

function archiveReceipt(request) {
  return Object.freeze({
    schema: ARCHIVE_RESULT_SCHEMA,
    operation: request.operation,
    kind: request.kind,
    path: request.path,
    byteLength: request.byteLength,
    sha256: request.sha256,
    status: 'accepted',
  });
}

export async function runArchiveBridge({
  input = process.stdin,
  output = process.stdout,
  transportDirectory = DEFAULT_TRANSPORT_DIRECTORY,
  maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
} = {}) {
  const directory = validateTransportDirectory(transportDirectory);
  boundedInteger(
    maxArchiveBytes,
    'maxArchiveBytes',
    1,
    TASK_INPUT_ARCHIVE_LIMITS.compressedBytes,
  );
  await inspectTransportDirectory(directory);
  const reader = new BoundedFrameReader(input, maxArchiveBytes + MAX_JSON_FRAME_BYTES + 16);
  let metadataBytes;
  let archiveBytes;
  let responseBytes;
  try {
    await writeRaw(output, Buffer.from(`${ARCHIVE_READY_LINE}\n`));
    metadataBytes = await reader.readFrame(MAX_JSON_FRAME_BYTES);
    const request = validateArchiveRequest(parseJson(metadataBytes, 'archive metadata'), maxArchiveBytes);
    const operationLimit = Math.min(
      maxArchiveBytes,
      archiveLimitsForKind(request.kind).compressedBytes,
    );
    const target = path.join(directory, request.filename);
    const receipt = archiveReceipt(request);

    if (request.operation === 'upload') {
      archiveBytes = await reader.readFrame(operationLimit);
      if (archiveBytes.length !== request.byteLength
        || !timingSafeHexEqual(sha256(archiveBytes), request.sha256)) {
        fail('archive digest or size does not match the request', 'ERR_REMOTE_ARCHIVE_DIGEST');
      }
      reader.assertNoBufferedInput();
      await writeAtomicOwnerOnly(directory, request.filename, archiveBytes);
      responseBytes = encodeJson(receipt, 'archive receipt');
      await writeFrame(output, responseBytes);
      return receipt;
    }

    archiveBytes = await readBoundedOwnerOnly(target, request.byteLength);
    if (!timingSafeHexEqual(sha256(archiveBytes), request.sha256)) {
      fail('archive digest does not match the request', 'ERR_REMOTE_ARCHIVE_DIGEST');
    }
    reader.assertNoBufferedInput();
    responseBytes = encodeJson(receipt, 'archive receipt');
    await writeFrame(output, responseBytes);
    await writeFrame(output, archiveBytes, operationLimit);
    return receipt;
  } catch (error) {
    throw sanitized(error, 'archive bridge failed', 'ERR_REMOTE_ARCHIVE');
  } finally {
    metadataBytes?.fill(0);
    archiveBytes?.fill(0);
    responseBytes?.fill(0);
    reader.dispose();
  }
}

function parseSecretFrame(payload) {
  if (payload.length < 8) {
    fail('supervisor secret frame is malformed', 'ERR_REMOTE_SECRET_FRAME');
  }
  const magic = payload.subarray(0, 4).toString('ascii');
  const executionMode = magic === CONTROLLED_SECRET_FRAME_MAGIC
    ? CONTROLLED_PROVIDER
    : magic === ZERO_PROVIDER_SECRET_FRAME_MAGIC
      ? ZERO_PROVIDER_CANARY
      : null;
  if (executionMode === null) {
    fail('supervisor secret frame is malformed', 'ERR_REMOTE_SECRET_FRAME');
  }
  const hmacLength = payload.readUInt16BE(4);
  const providerLength = payload.readUInt16BE(6);
  const controlledProvider = executionMode === CONTROLLED_PROVIDER;
  if (hmacLength !== 32
    || (controlledProvider
      ? providerLength < 8 || providerLength > 512
      : providerLength !== 0)
    || payload.length !== 8 + hmacLength + providerLength) {
    fail('supervisor secret frame has invalid bounds', 'ERR_REMOTE_SECRET_FRAME');
  }
  const result = {
    hmacKey: Buffer.from(payload.subarray(8, 8 + hmacLength)),
    executionMode,
  };
  if (controlledProvider) {
    result.providerKey = Buffer.from(payload.subarray(8 + hmacLength));
  }
  return result;
}

function secretFingerprints(secrets) {
  return secrets.map((secret) => {
    let rolling = 0;
    let leadingPower = 1;
    for (let index = 0; index < secret.length; index += 1) {
      rolling = (Math.imul(rolling, 257) + secret[index]) >>> 0;
      if (index < secret.length - 1) leadingPower = Math.imul(leadingPower, 257) >>> 0;
    }
    return Object.freeze({
      length: secret.length,
      rolling,
      leadingPower,
      sha256: sha256(secret),
    });
  });
}

class SecretEchoGuard {
  constructor(fingerprints) {
    this.fingerprints = fingerprints;
    this.maximumLength = fingerprints.reduce(
      (maximum, fingerprint) => Math.max(maximum, fingerprint.length),
      0
    );
    this.tail = Buffer.alloc(0);
  }

  assertClean(bytes) {
    const joined = this.tail.length ? Buffer.concat([this.tail, bytes]) : Buffer.from(bytes);
    try {
      for (const fingerprint of this.fingerprints) {
        if (joined.length < fingerprint.length) continue;
        let rolling = 0;
        for (let index = 0; index < fingerprint.length; index += 1) {
          rolling = (Math.imul(rolling, 257) + joined[index]) >>> 0;
        }
        for (let offset = 0; offset <= joined.length - fingerprint.length; offset += 1) {
          if (rolling === fingerprint.rolling
            && timingSafeHexEqual(
              sha256(joined.subarray(offset, offset + fingerprint.length)),
              fingerprint.sha256
            )) {
            fail('supervisor handler response contains secret material', 'ERR_REMOTE_SECRET_ECHO');
          }
          if (offset < joined.length - fingerprint.length) {
            const withoutLeading = (
              rolling - Math.imul(joined[offset], fingerprint.leadingPower)
            ) >>> 0;
            rolling = (
              Math.imul(withoutLeading, 257) + joined[offset + fingerprint.length]
            ) >>> 0;
          }
        }
      }
      const retained = Math.min(joined.length, Math.max(0, this.maximumLength - 1));
      const nextTail = retained > 0
        ? Buffer.from(joined.subarray(joined.length - retained))
        : Buffer.alloc(0);
      this.tail.fill(0);
      this.tail = nextTail;
    } finally {
      joined.fill(0);
    }
  }

  dispose() {
    this.tail.fill(0);
    this.tail = Buffer.alloc(0);
  }
}

function validateHandler(handler) {
  if (!handler || typeof handler !== 'object' || typeof handler.handleFrame !== 'function') {
    fail('supervisor handler factory returned an invalid handler', 'ERR_REMOTE_HANDLER');
  }
  for (const method of ['close', 'channelLost']) {
    if (handler[method] !== undefined && typeof handler[method] !== 'function') {
      fail('supervisor handler contains an invalid lifecycle hook', 'ERR_REMOTE_HANDLER');
    }
  }
  return handler;
}

function validateHandlerResult(result) {
  exactKeys(result, ['response', 'done'], 'supervisor handler result');
  if (typeof result.done !== 'boolean') {
    fail('supervisor handler result has an invalid completion flag', 'ERR_REMOTE_HANDLER');
  }
  return {
    response: asBytes(result.response, 'supervisor handler response', MAX_PROTOCOL_FRAME_BYTES),
    done: result.done,
  };
}

async function invokeLifecycle(handler, method, argument) {
  if (typeof handler?.[method] !== 'function') return;
  try {
    await handler[method](argument);
  } catch {
    fail('supervisor handler lifecycle hook failed', 'ERR_REMOTE_HANDLER');
  }
}

export async function runSupervisorControlBridge({
  input = process.stdin,
  output = process.stdout,
  handlerFactory,
  controlChannelInspector = inspectInheritedControlChannel,
} = {}) {
  if (typeof handlerFactory !== 'function') {
    throw new TypeError('handlerFactory must be a function');
  }
  const reader = new BoundedFrameReader(
    input,
    MAX_PROTOCOL_FRAME_BYTES + MAX_SECRET_FRAME_BYTES + 16
  );
  let payload;
  let hmacKey;
  let providerKey;
  let executionMode;
  let handler;
  let fingerprints;
  let echoGuard;
  let completed = false;
  let failureReason = 'failure';
  try {
    await writeRaw(output, Buffer.from(`${SUPERVISOR_READY_LINE}\n`));
    payload = await reader.readFrame(MAX_SECRET_FRAME_BYTES);
    const frameSha256 = sha256(payload);
    const frameByteLength = payload.length;
    ({ hmacKey, executionMode, providerKey } = parseSecretFrame(payload));
    const controlChannel = createAuthenticatedControlChannel({
      hmacKey,
      executionMode,
      frameSha256,
      input,
      output,
      inspectControlChannel: controlChannelInspector,
    });
    fingerprints = secretFingerprints(
      executionMode === CONTROLLED_PROVIDER ? [hmacKey, providerKey] : [hmacKey]
    );
    echoGuard = new SecretEchoGuard(fingerprints);
    payload.fill(0);
    payload = null;
    try {
      handler = validateHandler(await handlerFactory({
        hmacKey,
        executionMode,
        ...(executionMode === CONTROLLED_PROVIDER ? { providerKey } : {}),
        controlChannel,
      }));
    } catch (error) {
      throw sanitized(error, 'supervisor handler factory failed', 'ERR_REMOTE_HANDLER');
    } finally {
      hmacKey?.fill(0);
      providerKey?.fill(0);
    }

    const receipt = {
      schema: SECRET_RESULT_SCHEMA,
      status: 'accepted',
      executionMode,
      frameSha256,
      byteLength: frameByteLength,
    };
    const receiptBytes = encodeJson(receipt, 'supervisor secret receipt');
    try {
      await writeFrame(output, receiptBytes);
    } finally {
      receiptBytes.fill(0);
    }

    while (!completed) {
      let request;
      let response;
      try {
        request = await reader.readFrame(MAX_PROTOCOL_FRAME_BYTES);
        let rawResult;
        try {
          rawResult = await handler.handleFrame(request);
        } catch {
          fail('supervisor handler failed', 'ERR_REMOTE_HANDLER');
        }
        const result = validateHandlerResult(rawResult);
        response = result.response;
        echoGuard.assertClean(response);
        await writeFrame(output, response);
        completed = result.done;
      } catch (error) {
        if (error?.code === 'ERR_REMOTE_CHANNEL_LOSS' || error?.code === 'ERR_REMOTE_FRAME') {
          failureReason = 'channel-loss';
          await invokeLifecycle(handler, 'channelLost');
        }
        throw error;
      } finally {
        request?.fill(0);
        response?.fill(0);
      }
    }
    reader.assertNoBufferedInput();
    await invokeLifecycle(handler, 'close', { reason: 'complete' });
    return Object.freeze({ schema: 'engineer-supervisor-control-complete.v1', status: 'complete' });
  } catch (error) {
    if (handler) {
      try {
        await invokeLifecycle(handler, 'close', { reason: failureReason });
      } catch {
        // Preserve the original sanitized failure.
      }
    }
    throw sanitized(error, 'supervisor control bridge failed', 'ERR_REMOTE_CONTROL');
  } finally {
    payload?.fill(0);
    hmacKey?.fill(0);
    providerKey?.fill(0);
    echoGuard?.dispose();
    reader.dispose();
  }
}

export async function runRemoteBridgeCli({
  executableName = path.basename(process.argv[1] ?? ''),
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  transportDirectory = DEFAULT_TRANSPORT_DIRECTORY,
  maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
  handlerFactory,
} = {}) {
  if (executableName === 'engineer-archive-bridge'
    && Array.isArray(argv)
    && argv.length === 1
    && argv[0] === '--stdio') {
    return runArchiveBridge({ input, output, transportDirectory, maxArchiveBytes });
  }
  if (executableName === 'engineer-runtime-supervisor'
    && Array.isArray(argv)
    && argv.length === 1
    && argv[0] === '--control-stdio') {
    return runSupervisorControlBridge({ input, output, handlerFactory });
  }
  fail('remote bridge invocation does not match a fixed route', 'ERR_REMOTE_INVOCATION');
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
  runRemoteBridgeCli().catch((error) => {
    const code = error instanceof RemoteBridgeError ? error.code : 'ERR_REMOTE_BRIDGE';
    process.stderr.write(`engineer remote bridge failed: ${code}\n`);
    process.exitCode = 70;
  });
}
