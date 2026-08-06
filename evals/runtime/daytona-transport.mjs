import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';

import {
  TASK_INPUT_ARCHIVE_LIMITS,
  archiveLimitsForKind,
} from './archive-limits.mjs';

export const ARCHIVE_BOOTSTRAP =
  'if [ -t 0 ]; then stty -echo || exit 70; fi; ulimit -c 0 || exit 70; exec /opt/engineer/bin/engineer-archive-bridge --stdio';
export const SUPERVISOR_BOOTSTRAP =
  'if [ -t 0 ]; then stty -echo || exit 70; fi; ulimit -c 0 || exit 70; exec /opt/engineer/bin/engineer-runtime-supervisor --control-stdio';

const ARCHIVE_READY = 'ENGINEER-ARCHIVE/1 READY';
const SUPERVISOR_READY = 'ENGINEER-SUPERVISOR/1 READY';
const ARCHIVE_REQUEST_SCHEMA = 'engineer-daytona-archive-request.v1';
const ARCHIVE_RESULT_SCHEMA = 'engineer-daytona-archive-result.v1';
const SECRET_RESULT_SCHEMA = 'engineer-supervisor-secret-accepted.v1';
const COMMAND_RECEIPT_SCHEMA = 'engineer-daytona-command-receipt.v1';
const CONTROLLED_SECRET_FRAME_MAGIC = 'EHS1';
const ZERO_PROVIDER_SECRET_FRAME_MAGIC = 'EHZ1';
const CONTROLLED_PROVIDER = 'controlled-provider';
const ZERO_PROVIDER_CANARY = 'zero-provider-canary';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_ARG = /^[A-Za-z0-9_./:@=,+%-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MAX_JSON_FRAME_BYTES = 8 * 1024;
const MAX_PROTOCOL_FRAME_BYTES = 64 * 1024;
const MAX_SECRET_FRAME_BYTES = 1_024;
const MAX_BOOTSTRAP_LINE_BYTES = 512;
const DEFAULT_CONTROL_CHANNEL_TIMEOUT_MS = 40 * 60_000;
const MAX_CONTROL_CHANNEL_TIMEOUT_MS = 60 * 60_000;
const ALLOWED_SSH_STDERR = Object.freeze([
  Buffer.from('Pseudo-terminal will not be allocated because stdin is not a terminal.\n'),
  Buffer.from('Pseudo-terminal will not be allocated because stdin is not a terminal.\r\n'),
]);

const ARCHIVE_PATHS = Object.freeze({
  'task-input': '/engineer-bounded/transport/task-input.tar',
  'trial-output': '/engineer-bounded/transport/trial-output.tar',
});

const DAYTONA_ENV_ALLOWLIST = Object.freeze(new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'LC_TIME', 'LC_NUMERIC', 'LC_MONETARY', 'LC_COLLATE', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS',
  'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION', 'TERM', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'DAYTONA_API_URL', 'DAYTONA_API_KEY', 'DAYTONA_CONFIG_DIR', 'DAYTONA_CONFIG_FILE',
]));
const CREDENTIAL_MARKERS = Object.freeze([
  Buffer.from('sk-or-', 'ascii'),
  Buffer.from('sk-ant-', 'ascii'),
  Buffer.from('sk-proj-', 'ascii'),
  Buffer.from('ghp_', 'ascii'),
  Buffer.from('github_pat_', 'ascii'),
  Buffer.from('xoxb-', 'ascii'),
  Buffer.from('hf_', 'ascii'),
]);

class TransportError extends Error {
  constructor(message, code = 'ERR_DAYTONA_TRANSPORT') {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new TransportError(message, code);
}

function isPlainObject(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`, 'ERR_TRANSPORT_FRAME');
  const expected = new Set(keys);
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    fail(`${label} contains an unexpected field`, 'ERR_TRANSPORT_FRAME');
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
    fail(
      'execution mode must be controlled-provider or zero-provider-canary',
      'ERR_TRANSPORT_CONTROL'
    );
  }
  return value;
}

function safeAbsoluteExecutable(value, label) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 512 || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute NUL-free executable path`);
  }
  if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.split('/').includes('..')) {
    throw new TypeError(`${label} must be an absolute normalized executable path`);
  }
  if (!/^\/[A-Za-z0-9_./:+-]+$/.test(value)) {
    throw new TypeError(`${label} contains unsafe executable characters`);
  }
  return value;
}

function safeSandboxId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError('sandboxId must be a safe identifier');
  }
  return value;
}

function safeRemoteArg(value, index) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > 512 || !SAFE_ARG.test(value)) {
    throw new TypeError(`remote argument ${index} must be a bounded safe token`);
  }
  return value;
}

function safeCwd(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 512 || value.includes('\0')) {
    throw new TypeError('remote cwd must be a bounded absolute path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || !(value === '/engineer-bounded' || value.startsWith('/engineer-bounded/'))) {
    throw new TypeError('remote cwd must be a normalized path below /engineer-bounded');
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function timingSafeHexEqual(left, right) {
  if (!SHA256_HEX.test(String(left)) || !SHA256_HEX.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function asBoundedBuffer(value, label, maximum) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be bytes`);
  }
  if (value.byteLength > maximum) fail(`${label} exceeds its byte bound`, 'ERR_TRANSPORT_OVERSIZED');
  return Buffer.from(value);
}

function scrubEnvironment(baseEnv) {
  if (baseEnv == null || typeof baseEnv !== 'object' || Array.isArray(baseEnv)) {
    throw new TypeError('baseEnv must be an environment object');
  }
  const env = {};
  for (const [key, rawValue] of Object.entries(baseEnv)) {
    if (typeof rawValue !== 'string' || rawValue.includes('\0')) continue;
    if (!DAYTONA_ENV_ALLOWLIST.has(key) || Buffer.byteLength(rawValue) > 16 * 1024) continue;
    env[key] = rawValue;
  }
  return env;
}

function containsCredentialMarker(value) {
  const ownsBytes = !Buffer.isBuffer(value);
  const bytes = ownsBytes ? Buffer.from(value) : value;
  try {
    return CREDENTIAL_MARKERS.some((marker) => bytes.indexOf(marker) !== -1);
  } finally {
    if (ownsBytes) bytes.fill(0);
  }
}

class SecretScanner {
  constructor(secrets = []) {
    this.secrets = secrets
      .filter((value) => Buffer.isBuffer(value) || value instanceof Uint8Array)
      .map((value) => Buffer.from(value))
      .filter((value) => value.length > 0);
    this.maximumLength = this.secrets.reduce((maximum, value) => Math.max(maximum, value.length), 0);
    this.tail = Buffer.alloc(0);
  }

  assertClean(value, label = 'transport output') {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    for (const secret of this.secrets) {
      if (bytes.indexOf(secret) !== -1) fail(`${label} contained secret material`, 'ERR_TRANSPORT_SECRET');
    }
  }

  assertCleanChunk(value, label = 'transport output') {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const previousTail = this.tail;
    const joined = previousTail.length ? Buffer.concat([previousTail, bytes]) : bytes;
    try {
      this.assertClean(joined, label);
      const retained = Math.max(0, this.maximumLength - 1);
      this.tail = retained > 0
        ? Buffer.from(joined.subarray(Math.max(0, joined.length - retained)))
        : Buffer.alloc(0);
    } finally {
      previousTail.fill(0);
      if (joined !== bytes) joined.fill(0);
    }
  }

  dispose() {
    for (const secret of this.secrets) secret.fill(0);
    this.tail.fill(0);
    this.secrets = [];
    this.tail = Buffer.alloc(0);
  }
}

function outputBuffer(value, label, maximum) {
  if (value == null) return Buffer.alloc(0);
  if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail(`${label} has an invalid type`, 'ERR_TRANSPORT_OUTPUT');
  }
  const bytes = Buffer.from(value);
  if (bytes.length > maximum) fail(`${label} exceeds its byte bound`, 'ERR_TRANSPORT_OVERSIZED');
  return bytes;
}

function defaultRunCommand(file, args, { env, timeoutMs, maxOutputBytes }) {
  const result = spawnSync(file, args, {
    shell: false,
    windowsHide: true,
    encoding: null,
    env,
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
  });
  return {
    code: Number.isInteger(result.status) ? result.status : null,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    error: result.error ?? null,
  };
}

function defaultSpawnChannel(file, args, { env }) {
  return spawn(file, args, {
    shell: false,
    windowsHide: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

class ProcessChannel {
  constructor(child, { timeoutMs, secrets, maxBufferedBytes }) {
    if (!child || !child.stdin || !child.stdout || !child.stderr || typeof child.on !== 'function') {
      fail('Daytona SSH did not return a private duplex channel', 'ERR_TRANSPORT_CHANNEL');
    }
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.inputScanner = new SecretScanner(secrets);
    this.stdoutScanner = new SecretScanner(secrets);
    this.stderrScanner = new SecretScanner(secrets);
    this.maxBufferedBytes = maxBufferedBytes;
    this.buffer = Buffer.alloc(0);
    this.stderrBuffer = Buffer.alloc(0);
    this.stderrNoticeAccepted = false;
    this.waiters = new Set();
    this.closed = false;
    this.closing = false;
    this.fatal = null;

    child.stdout.on('data', (chunk) => {
      if (this.closing || this.fatal) return;
      try {
        const bytes = Buffer.from(chunk);
        if (bytes.length > this.maxBufferedBytes || this.buffer.length + bytes.length > this.maxBufferedBytes) {
          fail('Daytona SSH output exceeds its channel byte bound', 'ERR_TRANSPORT_OVERSIZED');
        }
        this.stdoutScanner.assertCleanChunk(bytes, 'Daytona SSH output');
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
      } catch (error) {
        this.fatal = error;
      }
      this.#notify();
    });
    child.stderr.on('data', (chunk) => {
      if (this.closing || this.fatal) return;
      let bytes;
      try {
        bytes = Buffer.from(chunk);
        if (bytes.length > this.maxBufferedBytes
            || this.stderrBuffer.length + bytes.length > this.maxBufferedBytes) {
          fail('Daytona SSH stderr exceeds its channel byte bound', 'ERR_TRANSPORT_OVERSIZED');
        }
        this.stderrScanner.assertCleanChunk(bytes, 'Daytona SSH stderr');
        if (this.stderrNoticeAccepted) {
          fail('Daytona SSH emitted unexpected stderr', 'ERR_TRANSPORT_STDERR');
        }
        const observed = this.stderrBuffer.length === 0
          ? bytes
          : Buffer.concat([this.stderrBuffer, bytes]);
        this.stderrBuffer.fill(0);
        this.stderrBuffer = Buffer.alloc(0);
        const candidates = ALLOWED_SSH_STDERR.filter((notice) =>
          observed.length <= notice.length
          && notice.subarray(0, observed.length).equals(observed));
        if (candidates.length === 0) {
          observed.fill(0);
          fail('Daytona SSH emitted unexpected stderr', 'ERR_TRANSPORT_STDERR');
        }
        if (candidates.some((notice) => notice.length === observed.length)) {
          observed.fill(0);
          this.stderrNoticeAccepted = true;
        } else {
          this.stderrBuffer = observed;
        }
      } catch (error) {
        this.fatal = error;
      } finally {
        if (bytes !== this.stderrBuffer) bytes?.fill(0);
      }
      this.#notify();
    });
    child.on('error', () => {
      if (!this.closing) this.fatal = new TransportError('Daytona SSH channel failed', 'ERR_TRANSPORT_CHANNEL');
      this.#notify();
    });
    child.on('close', () => {
      this.closed = true;
      this.#notify();
    });
  }

  #notify() {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  setIdleTimeoutMs(timeoutMs) {
    if (this.closed || this.closing || this.fatal) {
      fail('Daytona SSH channel cannot change its idle bound', 'ERR_TRANSPORT_CHANNEL');
    }
    this.timeoutMs = timeoutMs;
  }

  async #waitForNotification(timeoutMs, timeoutError) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(wake);
        callback();
      };
      const wake = () => finish(resolve);
      const timer = setTimeout(() => finish(() => reject(timeoutError)), timeoutMs);
      timer.unref?.();
      this.waiters.add(wake);
    });
  }

  async #wait() {
    if (this.fatal) throw this.fatal;
    if (this.buffer.length > 0) return;
    if (this.closed) fail('Daytona SSH channel closed before the framed exchange completed', 'ERR_TRANSPORT_CHANNEL');
    await this.#waitForNotification(
      this.timeoutMs,
      new TransportError('Daytona SSH channel timed out', 'ERR_TRANSPORT_TIMEOUT')
    );
    if (this.fatal) throw this.fatal;
    if (this.buffer.length === 0 && this.closed) {
      fail('Daytona SSH channel closed before the framed exchange completed', 'ERR_TRANSPORT_CHANNEL');
    }
  }

  async readExact(length) {
    const chunks = [];
    let total = 0;
    while (total < length) {
      if (this.fatal) throw this.fatal;
      if (this.buffer.length === 0) await this.#wait();
      const take = Math.min(length - total, this.buffer.length);
      chunks.push(this.buffer.subarray(0, take));
      this.buffer = this.buffer.subarray(take);
      total += take;
    }
    return chunks.length === 1 ? Buffer.from(chunks[0]) : Buffer.concat(chunks, length);
  }

  async readLine(maximum = MAX_BOOTSTRAP_LINE_BYTES) {
    for (;;) {
      if (this.fatal) throw this.fatal;
      const newline = this.buffer.indexOf(0x0a);
      if (newline !== -1) {
        if (newline > maximum) fail('Daytona SSH bootstrap line is oversized', 'ERR_TRANSPORT_OVERSIZED');
        const line = Buffer.from(this.buffer.subarray(0, newline));
        this.buffer = this.buffer.subarray(newline + 1);
        if (line.at(-1) === 0x0d) return line.subarray(0, -1);
        return line;
      }
      if (this.buffer.length > maximum) fail('Daytona SSH bootstrap line is oversized', 'ERR_TRANSPORT_OVERSIZED');
      await this.#wait();
    }
  }

  async readFrame(maximum) {
    const header = await this.readExact(4);
    const length = header.readUInt32BE(0);
    if (length < 1 || length > maximum) {
      fail('Daytona SSH frame exceeds its byte bound', 'ERR_TRANSPORT_OVERSIZED');
    }
    return this.readExact(length);
  }

  async #assertStderrSettled() {
    await new Promise((resolve) => setImmediate(resolve));
    if (this.fatal) throw this.fatal;
    const deadline = Date.now() + this.timeoutMs;
    while (this.stderrBuffer.length !== 0) {
      if (this.closed) fail('Daytona SSH emitted incomplete stderr', 'ERR_TRANSPORT_STDERR');
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail('Daytona SSH stderr did not complete', 'ERR_TRANSPORT_STDERR');
      await this.#waitForNotification(
        remaining,
        new TransportError('Daytona SSH stderr did not complete', 'ERR_TRANSPORT_STDERR')
      );
      if (this.fatal) throw this.fatal;
    }
  }

  async writeRaw(value, { allowSecret = false } = {}) {
    if (this.closed || this.closing) fail('Daytona SSH channel is closed', 'ERR_TRANSPORT_CHANNEL');
    await this.#assertStderrSettled();
    if (this.closed || this.closing) fail('Daytona SSH channel is closed', 'ERR_TRANSPORT_CHANNEL');
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!allowSecret) this.inputScanner.assertClean(bytes, 'Daytona SSH input');
    await new Promise((resolve, reject) => {
      this.child.stdin.write(bytes, (error) => {
        if (error) reject(new TransportError('Daytona SSH channel write failed', 'ERR_TRANSPORT_CHANNEL'));
        else resolve();
      });
    });
  }

  async writeFrame(payload, options = {}) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    await this.writeRaw(header);
    await this.writeRaw(payload, options);
  }

  async assertNoExtraOutput({ requireOpen = false } = {}) {
    await this.#assertStderrSettled();
    if (this.fatal) throw this.fatal;
    if (this.buffer.length !== 0) fail('Daytona SSH emitted unexpected extra output', 'ERR_TRANSPORT_EXTRA_OUTPUT');
    if (requireOpen && this.closed) fail('Daytona SSH control channel closed after acknowledgement', 'ERR_TRANSPORT_CHANNEL');
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      this.child.stdin.end();
    } catch {
      // The channel is already fail-closed.
    }
    try {
      this.child.kill?.('SIGTERM');
    } catch {
      // The remote side is already gone.
    }
    this.inputScanner.dispose();
    this.stdoutScanner.dispose();
    this.stderrScanner.dispose();
    this.buffer.fill(0);
    this.buffer = Buffer.alloc(0);
    this.stderrBuffer.fill(0);
    this.stderrBuffer = Buffer.alloc(0);
    this.#notify();
  }
}

function parseJsonFrame(bytes, label) {
  let text;
  let value;
  try {
    text = UTF8.decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail(`${label} is malformed`, 'ERR_TRANSPORT_FRAME');
  }
  if (!isPlainObject(value)) fail(`${label} must be an object`, 'ERR_TRANSPORT_FRAME');
  return value;
}

function encodeJson(value, label) {
  let encoded;
  try {
    encoded = Buffer.from(JSON.stringify(value));
  } catch {
    fail(`${label} is not serializable`, 'ERR_TRANSPORT_FRAME');
  }
  if (encoded.length < 1 || encoded.length > MAX_JSON_FRAME_BYTES) {
    fail(`${label} exceeds its byte bound`, 'ERR_TRANSPORT_OVERSIZED');
  }
  return encoded;
}

function validateArchiveReceipt(value, expected) {
  exactKeys(value, ['schema', 'operation', 'kind', 'path', 'byteLength', 'sha256', 'status'], 'archive response');
  if (value.schema !== ARCHIVE_RESULT_SCHEMA
    || value.operation !== expected.operation
    || value.kind !== expected.kind
    || value.path !== expected.path
    || value.byteLength !== expected.byteLength
    || value.status !== 'accepted'
    || !timingSafeHexEqual(value.sha256, expected.sha256)) {
    fail('archive response does not match the bounded request', 'ERR_TRANSPORT_ARCHIVE');
  }
  return Object.freeze({
    schema: value.schema,
    operation: value.operation,
    kind: value.kind,
    path: value.path,
    byteLength: value.byteLength,
    sha256: value.sha256,
    status: value.status,
  });
}

function validateSecretReceipt(value, expectedMode, expectedHash, expectedBytes) {
  exactKeys(
    value,
    ['schema', 'status', 'executionMode', 'frameSha256', 'byteLength'],
    'supervisor secret response'
  );
  if (value.schema !== SECRET_RESULT_SCHEMA
    || value.status !== 'accepted'
    || value.executionMode !== expectedMode
    || value.byteLength !== expectedBytes
    || !timingSafeHexEqual(value.frameSha256, expectedHash)) {
    fail('supervisor secret response does not match the transmitted frame', 'ERR_TRANSPORT_CONTROL');
  }
  return Object.freeze({
    schema: value.schema,
    status: value.status,
    executionMode: value.executionMode,
    frameSha256: value.frameSha256,
    byteLength: value.byteLength,
  });
}

function secretBytes(value, label, minimum, maximum) {
  const bytes = asBoundedBuffer(value, label, maximum);
  if (bytes.length < minimum) {
    bytes.fill(0);
    throw new TypeError(`${label} must contain at least ${minimum} bytes`);
  }
  return bytes;
}

export function createDaytonaTransport({
  daytonaPath,
  runCommand = defaultRunCommand,
  spawnChannel = defaultSpawnChannel,
  baseEnv = process.env,
  commandTimeoutMs = 180_000,
  channelTimeoutMs = 30_000,
  controlChannelTimeoutMs = DEFAULT_CONTROL_CHANNEL_TIMEOUT_MS,
  maxCommandOutputBytes = 1024 * 1024,
  maxArchiveBytes = TASK_INPUT_ARCHIVE_LIMITS.compressedBytes,
} = {}) {
  const executable = safeAbsoluteExecutable(daytonaPath, 'daytonaPath');
  if (typeof runCommand !== 'function' || typeof spawnChannel !== 'function') {
    throw new TypeError('runCommand and spawnChannel must be functions');
  }
  boundedInteger(commandTimeoutMs, 'commandTimeoutMs', 1, 10 * 60_000);
  boundedInteger(channelTimeoutMs, 'channelTimeoutMs', 1, 10 * 60_000);
  boundedInteger(
    controlChannelTimeoutMs,
    'controlChannelTimeoutMs',
    1,
    MAX_CONTROL_CHANNEL_TIMEOUT_MS,
  );
  boundedInteger(maxCommandOutputBytes, 'maxCommandOutputBytes', 1, 16 * 1024 * 1024);
  boundedInteger(
    maxArchiveBytes,
    'maxArchiveBytes',
    1,
    TASK_INPUT_ARCHIVE_LIMITS.compressedBytes,
  );
  const commandEnv = scrubEnvironment(baseEnv);
  const activeChannels = new Set();
  let disposed = false;

  function assertActive() {
    if (disposed) fail('Daytona transport is disposed', 'ERR_TRANSPORT_DISPOSED');
  }

  function commandEnvironment() {
    assertActive();
    return { ...commandEnv };
  }

  async function releaseChannel(channel) {
    if (!channel) return;
    activeChannels.delete(channel);
    await channel.close();
  }

  async function openBootstrappedChannel({
    sandboxId,
    bootstrap,
    ready,
    secrets = [],
    maxBufferedBytes = MAX_PROTOCOL_FRAME_BYTES + MAX_JSON_FRAME_BYTES + MAX_BOOTSTRAP_LINE_BYTES,
  }) {
    assertActive();
    safeSandboxId(sandboxId);
    const env = commandEnvironment();
    const child = spawnChannel(executable, ['ssh', sandboxId, '--expires', '5'], {
      shell: false,
      windowsHide: true,
      env,
      timeoutMs: channelTimeoutMs,
    });
    const channel = new ProcessChannel(child, { timeoutMs: channelTimeoutMs, secrets, maxBufferedBytes });
    activeChannels.add(channel);
    try {
      await channel.writeRaw(Buffer.from(`${bootstrap}\n`));
      let line = await channel.readLine();
      const bootstrapBytes = Buffer.from(bootstrap);
      if (line.equals(bootstrapBytes)) line = await channel.readLine();
      if (!line.equals(Buffer.from(ready))) {
        fail('Daytona SSH bootstrap produced unexpected output', 'ERR_TRANSPORT_BOOTSTRAP');
      }
      return channel;
    } catch (error) {
      await releaseChannel(channel);
      throw error;
    }
  }

  async function runRemote({ sandboxId, executable: remoteExecutable, args = [], cwd = null } = {}) {
    assertActive();
    safeSandboxId(sandboxId);
    safeAbsoluteExecutable(remoteExecutable, 'remote executable');
    if (!Array.isArray(args) || args.length > 128) throw new TypeError('remote args must be an array of at most 128 tokens');
    const safeArgs = args.map(safeRemoteArg);
    if (safeArgs.some((value) => containsCredentialMarker(value))) {
      fail('remote argument resembles forbidden credential material', 'ERR_TRANSPORT_SECRET');
    }
    const remoteCwd = safeCwd(cwd);
    const daytonaArgs = ['exec', sandboxId, '--timeout', String(Math.ceil(commandTimeoutMs / 1_000))];
    if (remoteCwd) daytonaArgs.push('--cwd', remoteCwd);
    daytonaArgs.push('--', remoteExecutable, ...safeArgs);
    const result = await runCommand(executable, daytonaArgs, {
      shell: false,
      windowsHide: true,
      env: commandEnvironment(),
      timeoutMs: commandTimeoutMs,
      maxOutputBytes: maxCommandOutputBytes,
    });
    if (!result || !Number.isInteger(result.code)) {
      fail('Daytona remote command failed without a bounded result', 'ERR_TRANSPORT_COMMAND');
    }
    const stdout = outputBuffer(result.stdout, 'Daytona command stdout', maxCommandOutputBytes);
    const stderr = outputBuffer(result.stderr, 'Daytona command stderr', maxCommandOutputBytes);
    if (stdout.length + stderr.length > maxCommandOutputBytes) {
      fail('Daytona command output exceeds its combined byte bound', 'ERR_TRANSPORT_OVERSIZED');
    }
    const receipt = Object.freeze({
      schema: COMMAND_RECEIPT_SCHEMA,
      exitCode: result.code,
      stdoutBytes: stdout.length,
      stdoutSha256: sha256(stdout),
      stderrBytes: stderr.length,
      stderrSha256: sha256(stderr),
    });
    stdout.fill(0);
    stderr.fill(0);
    if (result.code !== 0 || result.error) {
      fail(`Daytona remote command failed (receipt sha256:${sha256(JSON.stringify(receipt)).slice(0, 16)})`, 'ERR_TRANSPORT_COMMAND');
    }
    return receipt;
  }

  async function uploadArchive({ sandboxId, kind, bytes, sha256: expectedSha256 } = {}) {
    assertActive();
    const remotePath = ARCHIVE_PATHS[kind];
    if (!remotePath) throw new TypeError('archive kind must be task-input or trial-output');
    const operationLimit = Math.min(maxArchiveBytes, archiveLimitsForKind(kind).compressedBytes);
    const archive = asBoundedBuffer(bytes, 'archive', operationLimit);
    if (archive.length < 1) {
      archive.fill(0);
      throw new TypeError('archive must not be empty');
    }
    const expected = assertSha256(expectedSha256, 'archive sha256');
    if (!timingSafeHexEqual(sha256(archive), expected)) {
      archive.fill(0);
      fail('archive digest does not match before upload', 'ERR_TRANSPORT_DIGEST');
    }
    const request = {
      schema: ARCHIVE_REQUEST_SCHEMA,
      operation: 'upload',
      kind,
      path: remotePath,
      byteLength: archive.length,
      sha256: expected,
    };
    const metadata = encodeJson(request, 'archive request');
    let channel;
    try {
      channel = await openBootstrappedChannel({
        sandboxId,
        bootstrap: ARCHIVE_BOOTSTRAP,
        ready: ARCHIVE_READY,
        maxBufferedBytes: operationLimit + MAX_JSON_FRAME_BYTES + MAX_BOOTSTRAP_LINE_BYTES + 16,
      });
      await channel.writeFrame(metadata);
      await channel.writeFrame(archive);
      const response = parseJsonFrame(await channel.readFrame(MAX_JSON_FRAME_BYTES), 'archive response');
      const receipt = validateArchiveReceipt(response, request);
      await channel.assertNoExtraOutput();
      return receipt;
    } finally {
      metadata.fill(0);
      archive.fill(0);
      await releaseChannel(channel);
    }
  }

  async function downloadArchive({ sandboxId, kind, expectedSha256, expectedBytes } = {}) {
    assertActive();
    const remotePath = ARCHIVE_PATHS[kind];
    if (!remotePath) throw new TypeError('archive kind must be task-input or trial-output');
    const operationLimit = Math.min(maxArchiveBytes, archiveLimitsForKind(kind).compressedBytes);
    const expected = assertSha256(expectedSha256, 'expectedSha256');
    boundedInteger(expectedBytes, 'expectedBytes', 1, operationLimit);
    const request = {
      schema: ARCHIVE_REQUEST_SCHEMA,
      operation: 'download',
      kind,
      path: remotePath,
      byteLength: expectedBytes,
      sha256: expected,
    };
    const metadata = encodeJson(request, 'archive request');
    let channel;
    try {
      channel = await openBootstrappedChannel({
        sandboxId,
        bootstrap: ARCHIVE_BOOTSTRAP,
        ready: ARCHIVE_READY,
        maxBufferedBytes: operationLimit + MAX_JSON_FRAME_BYTES + MAX_BOOTSTRAP_LINE_BYTES + 16,
      });
      await channel.writeFrame(metadata);
      const response = parseJsonFrame(await channel.readFrame(MAX_JSON_FRAME_BYTES), 'archive response');
      const receipt = validateArchiveReceipt(response, request);
      const archive = await channel.readFrame(operationLimit);
      if (archive.length !== expectedBytes || !timingSafeHexEqual(sha256(archive), expected)) {
        archive.fill(0);
        fail('downloaded archive digest or size does not match', 'ERR_TRANSPORT_DIGEST');
      }
      await channel.assertNoExtraOutput();
      return { bytes: archive, receipt };
    } finally {
      metadata.fill(0);
      await releaseChannel(channel);
    }
  }

  async function openSupervisorControl(input = {}) {
    assertActive();
    if (!isPlainObject(input)) {
      fail('supervisor control input must be an object', 'ERR_TRANSPORT_CONTROL');
    }
    const mode = validateExecutionMode(input.executionMode);
    const controlledProvider = mode === CONTROLLED_PROVIDER;
    exactKeys(
      input,
      controlledProvider
        ? ['sandboxId', 'hmacKey', 'executionMode', 'providerKey']
        : ['sandboxId', 'hmacKey', 'executionMode'],
      'supervisor control input'
    );
    const { sandboxId, hmacKey, providerKey } = input;
    const hmac = secretBytes(hmacKey, 'hmacKey', 32, 32);
    let provider;
    if (controlledProvider) {
      try {
        provider = secretBytes(providerKey, 'providerKey', 8, 512);
      } catch (error) {
        hmac.fill(0);
        throw error;
      }
    }
    const providerLength = provider?.length ?? 0;
    const payloadLength = 8 + hmac.length + providerLength;
    if (payloadLength > MAX_SECRET_FRAME_BYTES) {
      hmac.fill(0);
      provider?.fill(0);
      fail('supervisor secret frame exceeds its byte bound', 'ERR_TRANSPORT_OVERSIZED');
    }
    const payload = Buffer.alloc(payloadLength);
    payload.write(
      controlledProvider ? CONTROLLED_SECRET_FRAME_MAGIC : ZERO_PROVIDER_SECRET_FRAME_MAGIC,
      0,
      'ascii'
    );
    payload.writeUInt16BE(hmac.length, 4);
    payload.writeUInt16BE(providerLength, 6);
    hmac.copy(payload, 8);
    provider?.copy(payload, 8 + hmac.length);
    const payloadHash = sha256(payload);
    let channel;
    try {
      channel = await openBootstrappedChannel({
        sandboxId,
        bootstrap: SUPERVISOR_BOOTSTRAP,
        ready: SUPERVISOR_READY,
        secrets: controlledProvider ? [hmac, provider] : [hmac],
      });
      await channel.writeFrame(payload, { allowSecret: true });
      payload.fill(0);
      hmac.fill(0);
      provider?.fill(0);
      const response = parseJsonFrame(await channel.readFrame(MAX_JSON_FRAME_BYTES), 'supervisor secret response');
      const receipt = validateSecretReceipt(response, mode, payloadHash, payloadLength);
      await channel.assertNoExtraOutput({ requireOpen: true });
      channel.setIdleTimeoutMs(controlChannelTimeoutMs);

      let controlClosed = false;
      const control = Object.freeze({
        async sendFrame(value) {
          if (controlClosed) fail('supervisor control channel is closed', 'ERR_TRANSPORT_CHANNEL');
          const frameBytes = asBoundedBuffer(value, 'supervisor protocol frame', MAX_PROTOCOL_FRAME_BYTES);
          try {
            await channel.writeFrame(frameBytes);
          } finally {
            frameBytes.fill(0);
          }
        },
        async receiveFrame() {
          if (controlClosed) fail('supervisor control channel is closed', 'ERR_TRANSPORT_CHANNEL');
          return channel.readFrame(MAX_PROTOCOL_FRAME_BYTES);
        },
        async close() {
          if (controlClosed) return;
          controlClosed = true;
          await releaseChannel(channel);
        },
      });
      return Object.freeze({ receipt, control });
    } catch (error) {
      await releaseChannel(channel);
      throw error;
    } finally {
      payload.fill(0);
      hmac.fill(0);
      provider?.fill(0);
    }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const key of Object.keys(commandEnv)) delete commandEnv[key];
    const channels = [...activeChannels];
    activeChannels.clear();
    await Promise.all(channels.map(async (channel) => {
      try {
        await channel.close();
      } catch {
        // Disposal is fail-closed even when a channel already failed.
      }
    }));
  }

  return Object.freeze({
    runRemote,
    uploadArchive,
    downloadArchive,
    openSupervisorControl,
    dispose,
  });
}
