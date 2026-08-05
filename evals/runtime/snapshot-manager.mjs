/**
 * PID-1 manager for the immutable Daytona runtime snapshot.
 *
 * The manager starts the only private Docker daemon before provisioning, then
 * publishes a root-owned adoption receipt. The trial supervisor independently
 * re-attests the live manager, daemon, argv, pidfile, socket, executable bytes,
 * boot identity, and bounded filesystem before it adopts the daemon. Stopping
 * the daemon does not stop PID 1, so final evidence can still be exported before
 * the external controller deletes the whole Daytona sandbox.
 */
import crypto from 'node:crypto';
import fs, { constants as FS_CONSTANTS } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

import { scrubDaytonaPlatformMetadataInPlace } from './platform-environment.mjs';

export const DAEMON_ADOPTION_RECEIPT_PATH =
  '/engineer-bounded/evidence/daemon-adoption-receipt.json';
export const DAEMON_ADOPTION_RECEIPT_SCHEMA = 'engineer-daemon-adoption-receipt.v1';

const MANAGER_MODULE_PATH = '/opt/engineer/runtime/snapshot-manager.mjs';
const NODE_PATH = '/usr/local/bin/node';
const DOCKERD_PATH = '/usr/local/bin/dockerd';
const DOCKER_PATH = '/usr/local/bin/docker';
const DAEMON_SOCKET = '/run/engineer/private-docker.sock';
const DAEMON_HOST = `unix://${DAEMON_SOCKET}`;
const DAEMON_PID_FILE = '/run/engineer/private-docker.pid';
const DAEMON_DATA_ROOT = '/engineer-bounded/docker';
const DAEMON_EXEC_ROOT = '/run/engineer/docker-exec';
const BOUNDED_ROOT = '/engineer-bounded';
const DEFAULT_DOCKER_ROOT = '/var/lib/docker';
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_MODULE_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,31}$/;
const CREDENTIAL_ENV = /(?:^DAYTONA(?:_|$)|OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|GROQ|XAI|MISTRAL|COHERE|TOGETHER|FIREWORKS|DEEPSEEK|CEREBRAS|PERPLEXITY|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const SECRET_VALUE = /(?:Bearer\s+|sk-(?:or|ant|proj)-|github_pat_|gh[pousr]_|xox[baprs]-|hf_[A-Za-z0-9])/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export const SNAPSHOT_MANAGER_DOCKERD_ARGV = Object.freeze([
  '--host', DAEMON_HOST,
  '--data-root', DAEMON_DATA_ROOT,
  '--exec-root', DAEMON_EXEC_ROOT,
  '--pidfile', DAEMON_PID_FILE,
  '--storage-driver', 'vfs',
  '--bridge', 'none',
  '--iptables=false',
  '--ip-forward=false',
  '--ip-masq=false',
  '--userland-proxy=false',
  '--log-level', 'error',
]);
const EXPECTED_DOCKERD_ARGV_SHA256 = sha256(Buffer.from(
  `${[DOCKERD_PATH, ...SNAPSHOT_MANAGER_DOCKERD_ARGV].join('\0')}\0`
));

const RECEIPT_FIELDS = Object.freeze([
  'schema', 'receiptVersion', 'sandboxBootId', 'sandboxKernelIdentityHash',
  'sessionNonce', 'manager', 'daemon', 'filesystem', 'createdAt',
]);

export class SnapshotManagerError extends Error {
  constructor(message, code = 'ERR_SNAPSHOT_MANAGER') {
    super(message);
    this.name = 'SnapshotManagerError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_SNAPSHOT_MANAGER') {
  throw new SnapshotManagerError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`, 'ERR_SNAPSHOT_MANAGER_SCHEMA');
  const expected = new Set(fields);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    fail(`${label} contains an unexpected or missing field`, 'ERR_SNAPSHOT_MANAGER_SCHEMA');
  }
}

function canonicalJson(value, depth = 0, nodes = { count: 0 }) {
  nodes.count += 1;
  if (depth > 16 || nodes.count > 512) fail('daemon adoption receipt exceeds its structure bound');
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, depth + 1, nodes)).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, nodes)}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))) {
    return JSON.stringify(value);
  }
  fail('daemon adoption receipt contains a non-canonical value', 'ERR_SNAPSHOT_MANAGER_SCHEMA');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a SHA-256 digest`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || SECRET_VALUE.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`${label} is invalid`);
  return value;
}

function positiveDecimal(value, label) {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL.test(value)) fail(`${label} is invalid`);
  return value;
}

function canonicalInstant(value, label) {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  let parsed;
  try { parsed = new Date(value).toISOString(); } catch { fail(`${label} is invalid`); }
  if (parsed !== value) fail(`${label} is invalid`);
  return value;
}

function absolute(value, expected, label) {
  if (value !== expected) fail(`${label} drifted`);
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateDaemonAdoptionReceipt(value) {
  exactKeys(value, RECEIPT_FIELDS, 'daemon adoption receipt');
  if (value.schema !== DAEMON_ADOPTION_RECEIPT_SCHEMA || value.receiptVersion !== 1) {
    fail('daemon adoption receipt schema drifted');
  }
  if (typeof value.sandboxBootId !== 'string' || !BOOT_ID.test(value.sandboxBootId)) {
    fail('daemon adoption boot identity is invalid');
  }
  hash(value.sandboxKernelIdentityHash, 'sandbox kernel identity');
  hash(value.sessionNonce, 'daemon adoption session nonce');

  exactKeys(value.manager, [
    'pid', 'startTimeTicks', 'executablePath', 'executableSha256', 'moduleSha256',
  ], 'snapshot manager identity');
  positiveInteger(value.manager.pid, 'snapshot manager pid');
  positiveDecimal(value.manager.startTimeTicks, 'snapshot manager start time');
  absolute(value.manager.executablePath, NODE_PATH, 'snapshot manager executable');
  hash(value.manager.executableSha256, 'snapshot manager executable hash');
  hash(value.manager.moduleSha256, 'snapshot manager module hash');

  exactKeys(value.daemon, [
    'pid', 'startTimeTicks', 'executablePath', 'executableSha256', 'argvSha256',
    'daemonId', 'pidFilePath', 'pidFileSha256', 'socketPath', 'socketDevice',
    'socketInode', 'socketMode', 'socketOwnerUid', 'socketOwnerGid', 'dataRoot',
  ], 'private daemon identity');
  positiveInteger(value.daemon.pid, 'private daemon pid');
  positiveDecimal(value.daemon.startTimeTicks, 'private daemon start time');
  absolute(value.daemon.executablePath, DOCKERD_PATH, 'private daemon executable');
  hash(value.daemon.executableSha256, 'private daemon executable hash');
  hash(value.daemon.argvSha256, 'private daemon argv hash');
  if (value.daemon.argvSha256 !== EXPECTED_DOCKERD_ARGV_SHA256) {
    fail('private daemon argv drifted');
  }
  safeId(value.daemon.daemonId, 'private daemon id');
  absolute(value.daemon.pidFilePath, DAEMON_PID_FILE, 'private daemon pidfile');
  hash(value.daemon.pidFileSha256, 'private daemon pidfile hash');
  absolute(value.daemon.socketPath, DAEMON_SOCKET, 'private daemon socket');
  positiveDecimal(value.daemon.socketDevice, 'private daemon socket device');
  positiveDecimal(value.daemon.socketInode, 'private daemon socket inode');
  if (value.daemon.socketMode !== 0o600 || value.daemon.socketOwnerUid !== 0 ||
      value.daemon.socketOwnerGid !== 0) {
    fail('private daemon socket custody drifted');
  }
  absolute(value.daemon.dataRoot, DAEMON_DATA_ROOT, 'private daemon data root');

  exactKeys(value.filesystem, [
    'boundedRootId', 'boundedRootBytes', 'defaultDockerRootId',
  ], 'private daemon filesystem');
  safeId(value.filesystem.boundedRootId, 'bounded filesystem id');
  safeId(value.filesystem.defaultDockerRootId, 'default Docker filesystem id');
  if (value.filesystem.boundedRootId === value.filesystem.defaultDockerRootId ||
      value.filesystem.boundedRootBytes !== TEN_GIB) {
    fail('private daemon filesystem is not the bounded Daytona root');
  }
  canonicalInstant(value.createdAt, 'daemon adoption creation time');
  return deepFreeze(structuredClone(value));
}

export function createDaemonAdoptionReceipt(observation) {
  const receipt = validateDaemonAdoptionReceipt({
    schema: DAEMON_ADOPTION_RECEIPT_SCHEMA,
    receiptVersion: 1,
    ...structuredClone(observation),
  });
  const encoded = canonicalJson(receipt);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RECEIPT_BYTES) fail('daemon adoption receipt exceeds its byte bound');
  return deepFreeze({
    receiptPath: DAEMON_ADOPTION_RECEIPT_PATH,
    receipt,
    canonicalJson: encoded,
    sha256: sha256(encoded),
  });
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function hashProtectedFile(file, maximum, { executable = false } = {}) {
  let descriptor;
  try {
    const real = fs.realpathSync.native(file);
    const named = fs.lstatSync(file, { bigint: true });
    if (real !== file || named.isSymbolicLink() || !named.isFile() || Number(named.uid) !== 0 ||
        (Number(named.mode) & 0o022) !== 0 || (executable && (Number(named.mode) & 0o111) === 0) ||
        named.size < 1n || named.size > BigInt(maximum)) {
      fail('protected runtime file custody drifted', 'ERR_SNAPSHOT_MANAGER_FILE');
    }
    descriptor = fs.openSync(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(named, opened)) fail('protected runtime file identity changed');
    const bytes = fs.readFileSync(descriptor);
    try {
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!sameStat(opened, after)) fail('protected runtime file changed while hashing');
      return sha256(bytes);
    } finally {
      bytes.fill(0);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readProcessIdentity(pid) {
  positiveInteger(pid, 'process pid');
  let statText;
  try { statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch {
    fail('adopted runtime process is not live', 'ERR_SNAPSHOT_MANAGER_PROCESS');
  }
  const close = statText.lastIndexOf(')');
  if (close < 2) fail('adopted runtime process stat is malformed');
  const fields = statText.slice(close + 2).trim().split(/\s+/);
  if (fields.length < 20 || !POSITIVE_DECIMAL.test(fields[19])) {
    fail('adopted runtime process start time is malformed');
  }
  let executablePath;
  try { executablePath = fs.realpathSync.native(`/proc/${pid}/exe`); } catch {
    fail('adopted runtime process executable is unavailable');
  }
  return { pid, startTimeTicks: fields[19], executablePath };
}

function readCmdline(pid) {
  const bytes = fs.readFileSync(`/proc/${pid}/cmdline`);
  try {
    if (bytes.length < 2 || bytes.at(-1) !== 0) fail('private daemon argv is malformed');
    const values = bytes.subarray(0, -1).toString('utf8').split('\0');
    if (values.length !== SNAPSHOT_MANAGER_DOCKERD_ARGV.length + 1 ||
        values[0] !== DOCKERD_PATH ||
        values.slice(1).some((value, index) => value !== SNAPSHOT_MANAGER_DOCKERD_ARGV[index])) {
      fail('private daemon argv drifted');
    }
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

function statFilesystem(target) {
  const named = fs.statSync(target, { bigint: true });
  const filesystem = fs.statfsSync(target, { bigint: true });
  const bytes = filesystem.bsize * filesystem.blocks;
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) fail('runtime filesystem exceeds its evidence bound');
  return { id: `dev:${named.dev.toString(16)}`, bytes: Number(bytes) };
}

function inspectSocket() {
  const named = fs.lstatSync(DAEMON_SOCKET, { bigint: true });
  if (named.isSymbolicLink() || !named.isSocket()) fail('private daemon socket is unavailable');
  return {
    socketDevice: named.dev.toString(10),
    socketInode: named.ino.toString(10),
    socketMode: Number(named.mode) & 0o777,
    socketOwnerUid: Number(named.uid),
    socketOwnerGid: Number(named.gid),
  };
}

function inspectDaemonId() {
  const result = spawnSync(DOCKER_PATH, [
    '--host', DAEMON_HOST, 'system', 'info', '--format', '{{json .ID}}',
  ], {
    shell: false,
    encoding: 'utf8',
    env: {
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/run/engineer/snapshot-manager',
      DOCKER_CONFIG: '/run/engineer/snapshot-manager/docker-config',
    },
    timeout: 5_000,
    maxBuffer: 8 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0 || result.signal !== null || result.error != null ||
      typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 512 ||
      SECRET_VALUE.test(`${result.stdout}${result.stderr ?? ''}`)) {
    fail('private daemon identity is unavailable');
  }
  let value;
  try { value = JSON.parse(result.stdout.trim()); } catch { fail('private daemon identity is malformed'); }
  return safeId(value, 'private daemon identity');
}

function readPidFile() {
  const bytes = fs.readFileSync(DAEMON_PID_FILE);
  try {
    if (bytes.length < 1 || bytes.length > 64) fail('private daemon pidfile is malformed');
    const text = UTF8.decode(bytes).trim();
    if (!POSITIVE_DECIMAL.test(text)) fail('private daemon pidfile is malformed');
    const pid = Number(text);
    positiveInteger(pid, 'private daemon pid');
    return { pid, sha256: sha256(bytes) };
  } finally {
    bytes.fill(0);
  }
}

function kernelIdentity() {
  const sandboxBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!BOOT_ID.test(sandboxBootId)) fail('sandbox boot identity is invalid');
  const hostname = os.hostname();
  if (typeof hostname !== 'string' || hostname.length < 1 || hostname.length > 255 || hostname.includes('\0')) {
    fail('sandbox kernel hostname is invalid');
  }
  return {
    sandboxBootId,
    sandboxKernelIdentityHash: sha256(`engineer-sandbox-kernel.v1\0${sandboxBootId}\0${hostname}`),
  };
}

function liveObservation({ managerPid, sessionNonce, createdAt }) {
  const manager = readProcessIdentity(managerPid);
  const pidfile = readPidFile();
  const daemon = readProcessIdentity(pidfile.pid);
  if (manager.executablePath !== NODE_PATH || daemon.executablePath !== DOCKERD_PATH) {
    fail('manager or private daemon executable path drifted');
  }
  const bounded = statFilesystem(BOUNDED_ROOT);
  const defaultRoot = statFilesystem(DEFAULT_DOCKER_ROOT);
  return {
    ...kernelIdentity(),
    sessionNonce,
    manager: {
      ...manager,
      executableSha256: hashProtectedFile(NODE_PATH, MAX_EXECUTABLE_BYTES, { executable: true }),
      moduleSha256: hashProtectedFile(MANAGER_MODULE_PATH, MAX_MODULE_BYTES),
    },
    daemon: {
      ...daemon,
      executableSha256: hashProtectedFile(DOCKERD_PATH, MAX_EXECUTABLE_BYTES, { executable: true }),
      argvSha256: readCmdline(pidfile.pid),
      daemonId: inspectDaemonId(),
      pidFilePath: DAEMON_PID_FILE,
      pidFileSha256: pidfile.sha256,
      socketPath: DAEMON_SOCKET,
      ...inspectSocket(),
      dataRoot: DAEMON_DATA_ROOT,
    },
    filesystem: {
      boundedRootId: bounded.id,
      boundedRootBytes: bounded.bytes,
      defaultDockerRootId: defaultRoot.id,
    },
    createdAt,
  };
}

async function inspectReceiptParent() {
  const parent = path.posix.dirname(DAEMON_ADOPTION_RECEIPT_PATH);
  const [real, stat] = await Promise.all([fsp.realpath(parent), fsp.lstat(parent)]);
  if (real !== parent || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0) {
    fail('daemon adoption receipt parent custody drifted');
  }
  return parent;
}

async function writeReceiptExclusive(built) {
  const parent = await inspectReceiptParent();
  const bytes = Buffer.from(built.canonicalJson);
  const temporary = `${DAEMON_ADOPTION_RECEIPT_PATH}.tmp-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
  let handle;
  try {
    try { await fsp.lstat(DAEMON_ADOPTION_RECEIPT_PATH); fail('daemon adoption receipt already exists'); }
    catch (error) {
      if (error instanceof SnapshotManagerError) throw error;
      if (error?.code !== 'ENOENT') fail('daemon adoption receipt path cannot be inspected');
    }
    handle = await fsp.open(temporary,
      FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_WRONLY |
        (FS_CONSTANTS.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.chown(0, 0);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.link(temporary, DAEMON_ADOPTION_RECEIPT_PATH);
    await fsp.unlink(temporary);
    const directory = await fsp.open(parent, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY ?? 0));
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    bytes.fill(0);
    try { await handle?.close(); } catch { /* fail closed */ }
    try { await fsp.unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

async function readReceiptProtected() {
  await inspectReceiptParent();
  let handle;
  let bytes;
  try {
    const [real, named] = await Promise.all([
      fsp.realpath(DAEMON_ADOPTION_RECEIPT_PATH),
      fsp.lstat(DAEMON_ADOPTION_RECEIPT_PATH, { bigint: true }),
    ]);
    if (real !== DAEMON_ADOPTION_RECEIPT_PATH || named.isSymbolicLink() || !named.isFile() ||
        Number(named.uid) !== 0 || Number(named.gid) !== 0 || (Number(named.mode) & 0o777) !== 0o600 ||
        named.size < 1n || named.size > BigInt(MAX_RECEIPT_BYTES)) {
      fail('daemon adoption receipt custody drifted');
    }
    handle = await fsp.open(DAEMON_ADOPTION_RECEIPT_PATH,
      FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameStat(named, opened)) fail('daemon adoption receipt changed before reading');
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameStat(opened, after) || BigInt(bytes.length) !== opened.size) {
      fail('daemon adoption receipt changed while reading');
    }
    let text;
    let parsed;
    try { text = UTF8.decode(bytes); parsed = JSON.parse(text); } catch {
      fail('daemon adoption receipt is malformed');
    }
    const receipt = validateDaemonAdoptionReceipt(parsed);
    if (canonicalJson(receipt) !== text) fail('daemon adoption receipt is not canonical');
    return { receipt, sha256: sha256(bytes) };
  } finally {
    bytes?.fill(0);
    await handle?.close();
  }
}

/** Independently re-attest the persistent PID-1/private-daemon adoption receipt. */
export async function attestDaemonAdoptionReceipt() {
  const loaded = await readReceiptProtected();
  const live = createDaemonAdoptionReceipt(liveObservation({
    managerPid: loaded.receipt.manager.pid,
    sessionNonce: loaded.receipt.sessionNonce,
    createdAt: loaded.receipt.createdAt,
  }));
  if (live.canonicalJson !== canonicalJson(loaded.receipt)) {
    fail('live manager or private daemon drifted from the adoption receipt',
      'ERR_SNAPSHOT_MANAGER_ADOPTION_DRIFT');
  }
  return deepFreeze({
    receiptPath: DAEMON_ADOPTION_RECEIPT_PATH,
    receiptSha256: loaded.sha256,
    manager: structuredClone(loaded.receipt.manager),
    daemon: structuredClone(loaded.receipt.daemon),
    filesystem: structuredClone(loaded.receipt.filesystem),
    sandboxBootId: loaded.receipt.sandboxBootId,
    sandboxKernelIdentityHash: loaded.receipt.sandboxKernelIdentityHash,
    sessionNonceHash: sha256(loaded.receipt.sessionNonce),
  });
}

export function assertSnapshotManagerEnvironment(environment) {
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (CREDENTIAL_ENV.test(name)
        || (typeof value === 'string' && SECRET_VALUE.test(value))) {
      fail('snapshot manager forbids ambient cloud or provider credentials',
        'ERR_SNAPSHOT_MANAGER_ENVIRONMENT');
    }
  }
}

async function waitForDaemonReady(child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) fail('private daemon exited before readiness');
    try {
      if (fs.lstatSync(DAEMON_SOCKET).isSocket()) {
        fs.chownSync(DAEMON_SOCKET, 0, 0);
        fs.chmodSync(DAEMON_SOCKET, 0o600);
        inspectDaemonId();
        return;
      }
    } catch (error) {
      if (error instanceof SnapshotManagerError && error.message !== 'private daemon identity is unavailable') throw error;
      if (!(error instanceof SnapshotManagerError) && error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail('private daemon readiness timed out');
}

export function waitForManagedDaemonStop(child, {
  isStopping,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof child?.once !== 'function' || typeof isStopping !== 'function'
      || typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') {
    throw new TypeError('managed daemon stop dependencies are invalid');
  }
  return new Promise((resolve) => {
    let poll;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (poll !== undefined) clearIntervalFn(poll);
      resolve();
    };
    child.once('error', () => {});
    child.once('exit', () => {
      if (isStopping()) settle();
    });
    poll = setIntervalFn(() => {
      if (isStopping() && child.exitCode !== null) settle();
    }, 50);
    if (settled) clearIntervalFn(poll);
  });
}

/** Production PID-1 entrypoint. It accepts no caller-controlled configuration. */
export async function runSnapshotManagerCli({ argv = process.argv.slice(2) } = {}) {
  try {
    scrubDaytonaPlatformMetadataInPlace(process.env);
  } catch {
    fail('ambient Daytona platform metadata is invalid', 'ERR_SNAPSHOT_MANAGER_ENVIRONMENT');
  }
  if (!Array.isArray(argv) || argv.length !== 0) fail('snapshot manager accepts no arguments');
  assertSnapshotManagerEnvironment(process.env);
  if (process.platform !== 'linux' || (process.geteuid?.() ?? process.getuid?.()) !== 0) {
    fail('snapshot manager requires Linux root');
  }
  for (const [directory, mode] of [
    ['/engineer-bounded/evidence', 0o700],
    [DAEMON_DATA_ROOT, 0o700],
    [DAEMON_EXEC_ROOT, 0o700],
    ['/run/engineer/snapshot-manager/docker-config', 0o700],
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode });
    fs.chownSync(directory, 0, 0);
    fs.chmodSync(directory, mode);
  }
  const child = spawn(DOCKERD_PATH, [...SNAPSHOT_MANAGER_DOCKERD_ARGV], {
    shell: false,
    cwd: '/',
    env: {
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/run/engineer/snapshot-manager',
      DOCKER_CONFIG: '/run/engineer/snapshot-manager/docker-config',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  const spawnFailure = new Promise((_, reject) => {
    child.once('error', () => reject(new SnapshotManagerError(
      'private daemon process could not be started',
      'ERR_SNAPSHOT_MANAGER_DAEMON'
    )));
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    try { child.kill('SIGTERM'); } catch { /* sandbox deletion continues */ }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await Promise.race([waitForDaemonReady(child), spawnFailure]);
    const built = createDaemonAdoptionReceipt(liveObservation({
      managerPid: process.pid,
      sessionNonce: crypto.randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    }));
    await writeReceiptExclusive(built);
    // PID 1 deliberately remains available after the daemon is stopped so the
    // supervisor can export final evidence and the controller can delete the sandbox.
    // An unexpected post-adoption exit leaves the receipt stale. PID 1 remains
    // available until shutdown, when either the exit event or poll settles once.
    await waitForManagedDaemonStop(child, { isStopping: () => stopping });
    return 0;
  } catch (error) {
    try { child.kill('SIGKILL'); } catch { /* startup is already failed */ }
    try { await fsp.unlink(DAEMON_ADOPTION_RECEIPT_PATH); } catch { /* no trusted receipt remains */ }
    throw error;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try { return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url; }
  catch { return false; }
}

if (isDirectInvocation()) {
  runSnapshotManagerCli().then(
    (code) => { process.exitCode = code; },
    (error) => {
      const code = error instanceof SnapshotManagerError ? error.code : 'ERR_SNAPSHOT_MANAGER';
      process.stderr.write(`engineer snapshot manager failed: ${code}\n`);
      process.exitCode = 70;
    }
  );
}
