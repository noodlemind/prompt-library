import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  snapshotBuildManifestHash,
  validateSnapshotBuildManifest,
} from './snapshot-build-manifest.mjs';

const MANIFEST_PATH = '/opt/engineer/snapshot/build-manifest.json';
const NODE_PATH = '/usr/local/bin/node';
const HARBOR_PATH = '/opt/engineer/bin/harbor';
const HASH = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const FORBIDDEN_ENV = /(?:^|_)(?:API_?KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)(?:$|_)/i;
const DANGEROUS_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+)$/;
const CREDENTIAL_VALUE = /(?:Bearer\s+|sk-(?:or|ant|proj)-|github_pat_|ghp_|xox[baprs]-|hf_[A-Za-z0-9])/i;

export class SnapshotSelfTestError extends Error {
  constructor(message, code = 'ERR_SNAPSHOT_SELFTEST') {
    super(message);
    this.name = 'SnapshotSelfTestError';
    this.code = code;
  }
}

function fail(message, code = 'ERR_SNAPSHOT_SELFTEST') {
  throw new SnapshotSelfTestError(message, code);
}

function sameHash(left, right) {
  if (!HASH.test(String(left)) || !HASH.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function readRegularFile(file, maximumBytes, label) {
  let descriptor;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumBytes) {
      fail(`${label} must be a bounded regular file`, 'ERR_SNAPSHOT_SELFTEST_FILE');
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      fail(`${label} identity changed before inspection`, 'ERR_SNAPSHOT_SELFTEST_FILE');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`${label} changed while being read`, 'ERR_SNAPSHOT_SELFTEST_FILE');
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs) {
      bytes.fill(0);
      fail(`${label} changed while being read`, 'ERR_SNAPSHOT_SELFTEST_FILE');
    }
    return { bytes, stat: after };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function inspectExecutableFile({ file, maxBytes = MAX_EXECUTABLE_BYTES }) {
  const inspected = readRegularFile(file, maxBytes, 'protected executable');
  try {
    return {
      type: 'file',
      uid: inspected.stat.uid,
      mode: inspected.stat.mode & 0o777,
      byteLength: inspected.stat.size,
      sha256: crypto.createHash('sha256').update(inspected.bytes).digest('hex'),
    };
  } finally {
    inspected.bytes.fill(0);
  }
}

function runFixedCommand(file, args) {
  const result = spawnSync(file, args, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    timeout: 30_000,
    maxBuffer: MAX_COMMAND_BYTES,
  });
  return {
    code: Number.isInteger(result.status) ? result.status : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

export function createNodeSnapshotSelfTestPrimitives() {
  return {
    async platform() { return process.platform; },
    async effectiveUid() { return process.geteuid?.() ?? process.getuid?.() ?? -1; },
    async readManifest() {
      const inspected = readRegularFile(MANIFEST_PATH, MAX_MANIFEST_BYTES, 'snapshot build manifest');
      try {
        if (inspected.stat.uid !== 0 || (inspected.stat.mode & 0o022) !== 0) {
          fail('snapshot build manifest ownership or mode drifted', 'ERR_SNAPSHOT_SELFTEST_FILE');
        }
        return Buffer.from(inspected.bytes);
      } finally {
        inspected.bytes.fill(0);
      }
    },
    async inspectExecutable(request) { return inspectExecutableFile(request); },
    async runCommand(file, args) { return runFixedCommand(file, args); },
  };
}

function assertEnvironment(environment) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('snapshot self-test environment must be an object');
  }
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 16 * 1024) {
      fail('snapshot self-test environment is malformed', 'ERR_SNAPSHOT_SELFTEST_ENVIRONMENT');
    }
    if (FORBIDDEN_ENV.test(name) || DANGEROUS_ENV.test(name) || CREDENTIAL_VALUE.test(value)) {
      fail('snapshot self-test refuses credential-bearing or injectable environment state',
        'ERR_SNAPSHOT_SELFTEST_ENVIRONMENT');
    }
  }
}

function parseExpectedHash(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--expected-build-hash' ||
      typeof argv[1] !== 'string' || !HASH.test(argv[1])) {
    fail('snapshot self-test invocation drifted', 'ERR_SNAPSHOT_SELFTEST_INVOCATION');
  }
  return argv[1];
}

function parseManifest(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail('snapshot build manifest reader returned invalid bytes', 'ERR_SNAPSHOT_SELFTEST_MANIFEST');
  }
  const owned = Buffer.from(bytes);
  try {
    if (owned.length < 1 || owned.length > MAX_MANIFEST_BYTES) {
      fail('snapshot build manifest is missing or oversized', 'ERR_SNAPSHOT_SELFTEST_MANIFEST');
    }
    let parsed;
    try {
      parsed = JSON.parse(UTF8.decode(owned));
    } catch {
      fail('snapshot build manifest is not canonical UTF-8 JSON', 'ERR_SNAPSHOT_SELFTEST_MANIFEST');
    }
    return { manifest: validateSnapshotBuildManifest(parsed), bytes: owned };
  } catch (error) {
    owned.fill(0);
    if (error instanceof SnapshotSelfTestError) throw error;
    fail('snapshot build manifest schema validation failed', 'ERR_SNAPSHOT_SELFTEST_MANIFEST');
  }
}

function validateInspection(value, executable) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.type !== 'file' || value.uid !== 0 || !Number.isSafeInteger(value.mode) ||
      (value.mode & 0o111) === 0 || (value.mode & 0o022) !== 0 ||
      !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 ||
      value.byteLength > MAX_EXECUTABLE_BYTES || !sameHash(value.sha256, executable.sha256)) {
    fail('protected executable ownership, mode, type, size, or digest drifted',
      'ERR_SNAPSHOT_SELFTEST_EXECUTABLE');
  }
}

function exactCommandResult(value, stdout, label) {
  if (value === null || typeof value !== 'object' || value.code !== 0 || value.stdout !== stdout ||
      value.stderr !== '' || value.error != null) {
    fail(`${label} runtime closure or version drifted`, 'ERR_SNAPSHOT_SELFTEST_VERSION');
  }
}

function writable(value) {
  if (!value || typeof value.write !== 'function') throw new TypeError('snapshot self-test output must be writable');
  return value;
}

export async function runSnapshotSelfTestCli({
  argv = process.argv.slice(2),
  environment = process.env,
  output = process.stdout,
  primitives = createNodeSnapshotSelfTestPrimitives(),
} = {}) {
  const expectedBuildHash = parseExpectedHash(argv);
  assertEnvironment(environment);
  if (primitives === null || typeof primitives !== 'object' || Array.isArray(primitives)) {
    throw new TypeError('snapshot self-test primitives must be an object');
  }
  for (const name of ['platform', 'effectiveUid', 'readManifest', 'inspectExecutable', 'runCommand']) {
    if (typeof primitives[name] !== 'function') throw new TypeError(`snapshot self-test primitive ${name} is required`);
  }
  if (await primitives.platform() !== 'linux') fail('snapshot self-test requires Linux', 'ERR_SNAPSHOT_SELFTEST_PLATFORM');
  if (await primitives.effectiveUid() !== 0) fail('snapshot self-test requires root uid', 'ERR_SNAPSHOT_SELFTEST_IDENTITY');

  const parsed = parseManifest(await primitives.readManifest());
  try {
    const byteHash = crypto.createHash('sha256').update(parsed.bytes).digest('hex');
    const semanticHash = snapshotBuildManifestHash(parsed.manifest);
    if (!sameHash(byteHash, expectedBuildHash) || !sameHash(semanticHash, expectedBuildHash)) {
      fail('snapshot build identity does not match the canonical embedded manifest',
        'ERR_SNAPSHOT_SELFTEST_BUILD_IDENTITY');
    }
    for (const executable of Object.values(parsed.manifest.executables)) {
      validateInspection(await primitives.inspectExecutable({
        file: executable.path,
        maxBytes: MAX_EXECUTABLE_BYTES,
      }), executable);
    }
    if (!parsed.manifest.executables.node || parsed.manifest.executables.node.path !== NODE_PATH ||
        !parsed.manifest.executables.harbor || parsed.manifest.executables.harbor.path !== HARBOR_PATH) {
      fail('snapshot manifest is missing the exact Node or Harbor executable',
        'ERR_SNAPSHOT_SELFTEST_EXECUTABLE');
    }
    exactCommandResult(await primitives.runCommand(NODE_PATH, ['--version']), 'v22.17.1\n', 'Node');
    exactCommandResult(await primitives.runCommand(HARBOR_PATH, ['--version']), '0.20.0\n', 'Harbor');
    writable(output).write(`ENGINEER-SNAPSHOT/1 ${expectedBuildHash}\n`);
    return 0;
  } finally {
    parsed.bytes.fill(0);
  }
}

const direct = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (direct) {
  runSnapshotSelfTestCli().catch((error) => {
    const code = error instanceof SnapshotSelfTestError ? error.code : 'ERR_SNAPSHOT_SELFTEST';
    process.stderr.write(`engineer snapshot self-test failed: ${code}\n`);
    process.exitCode = 70;
  });
}
