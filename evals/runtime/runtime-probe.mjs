#!/usr/local/bin/node

/**
 * Fixed, content-free readiness helper for the privileged Linux runtime.
 *
 * Policy and collection are deliberately separated. The exported collector
 * accepts narrow observation primitives so the contract can be tested on a
 * non-Linux host without touching Docker, cgroups, credentials, or networks.
 * The production defaults only implement observations Node can make without
 * side effects; unavailable active probes fail closed.
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  validateRuntimeNetworkPolicyReceipt,
  validateRuntimeNetworkRuleInventory,
} from './runtime-evidence.mjs';

export const RUNTIME_PROBE_EXECUTABLE = '/opt/engineer/bin/engineer-runtime-probe';
export const RUNTIME_PROBE_HANDOFF_FD = 3;
export const RUNTIME_PROBE_HANDOFF_SCHEMA = 'engineer-runtime-probe-handoff.v1';

const TEN_GIB = 10 * 1024 * 1024 * 1024;
const MAX_ARG_BYTES = 8 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_HANDOFF_BYTES = 32 * 1024;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 2_048;
const RUNNER_UID = 2001;
const BROKER_UID = 2002;
const BROKER_GID = 2002;
const BROKER_CLIENT_GID = 2003;
const FIXED_IPTABLES = '/usr/sbin/iptables';
const FIXED_IP6TABLES = '/usr/sbin/ip6tables';
const FIXED_SUPERVISOR = '/opt/engineer/bin/engineer-runtime-supervisor';
const NETWORK_CHAIN_V4 = 'ENGINEER_EGRESS_V4';
const NETWORK_CHAIN_V6 = 'ENGINEER_EGRESS_V6';
const MAX_KERNEL_FILE_BYTES = 1024 * 1024;
const MAX_NETWORK_OUTPUT_BYTES = 64 * 1024;
const MAX_PROC_SCAN = 32_768;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const CREDENTIAL_NAME = /(?:^DAYTONA(?:_|$)|OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|GROQ|XAI|MISTRAL|COHERE|TOGETHER|FIREWORKS|DEEPSEEK|CEREBRAS|PERPLEXITY|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const CREDENTIAL_VALUE = /(?:Bearer\s+|sk-(?:or|ant|proj)-|github_pat_|ghp_|xox[baprs]-|hf_[A-Za-z0-9])/i;
const SAFE_ENVIRONMENT = Object.freeze({
  LANG: new Set(['C.UTF-8']),
  PATH: new Set(['/usr/bin:/bin', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']),
});
const REQUIRED_FLAGS = Object.freeze([
  '--phase',
  '--sandbox-root',
  '--daemon-socket',
  '--proxy-socket',
  '--broker-socket',
  '--cgroup',
  '--image-digest',
]);
const FIXED_PATHS = Object.freeze({
  sandboxRoot: '/engineer-bounded',
  daemonSocket: '/run/engineer/private-docker.sock',
  proxySocket: '/run/engineer/harbor-docker.sock',
  brokerSocket: '/run/engineer/provider/provider.sock',
  runner: '/opt/engineer/bin/engineer-eval-runner',
  harbor: '/opt/engineer/bin/harbor',
});
const REQUIRED_PRIMITIVES = Object.freeze([
  'platform',
  'effectiveUid',
  'readHandoff',
  'inspectCgroup',
  'inspectNoProviderProbe',
  'inspectStorage',
  'inspectRunner',
  'inspectTask',
  'inspectBroker',
  'hashExecutable',
]);
const HANDOFF_INPUT_FIELDS = Object.freeze([
  'requestHash',
  'phase',
  'observedAt',
  'brokerInstalled',
  'topology',
  'paths',
  'resources',
  'networkPolicy',
]);
const HANDOFF_FIELDS = Object.freeze([
  'schema',
  ...HANDOFF_INPUT_FIELDS,
  'noProviderProbeBindingHash',
  'handoffHash',
]);

export class RuntimeProbeError extends Error {
  constructor(message, code = 'ERR_RUNTIME_PROBE', { diagnosticHash = null } = {}) {
    super(message);
    this.name = 'RuntimeProbeError';
    this.code = code;
    if (diagnosticHash !== null) this.diagnosticHash = diagnosticHash;
  }
}

function fail(message, code = 'ERR_RUNTIME_PROBE_POLICY') {
  throw new RuntimeProbeError(message, code);
}

function diagnosticHash(error) {
  const descriptor = [error?.name, error?.code, error?.message]
    .map((value) => typeof value === 'string' ? value.slice(0, 4_096) : '')
    .join('\0');
  return crypto.createHash('sha256').update(descriptor).digest('hex');
}

function sanitizedFailure(error, label) {
  if (error instanceof RuntimeProbeError) return error;
  return new RuntimeProbeError(
    `${label} failed closed`,
    'ERR_RUNTIME_PROBE_OBSERVATION',
    { diagnosticHash: diagnosticHash(error) },
  );
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains an unknown field`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) fail(`${label} is incomplete`);
  }
}

function boundedString(value, label, maximum = 256) {
  if (typeof value !== 'string'
      || value.length === 0
      || Buffer.byteLength(value, 'utf8') > maximum
      || value.includes('\0')) {
    fail(`${label} is not a bounded string`);
  }
  return value;
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is outside its integer bound`);
  }
  return value;
}

function boolean(value, label, expected) {
  if (typeof value !== 'boolean' || (expected !== undefined && value !== expected)) {
    fail(`${label} failed closed`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} is not a SHA-256 digest`);
  return value;
}

function safeId(value, label) {
  boundedString(value, label, 192);
  if (!SAFE_ID.test(value)) fail(`${label} is not a safe identifier`);
  return value;
}

function instant(value, label) {
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    fail(`${label} is not a canonical UTC instant`);
  }
  if (typeof value !== 'string' || canonical !== value) fail(`${label} is not a canonical UTC instant`);
  return Date.parse(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function handoffDigest(unsigned) {
  return crypto.createHash('sha256')
    .update(`${RUNTIME_PROBE_HANDOFF_SCHEMA}\0`)
    .update(canonicalJson(unsigned))
    .digest('hex');
}

function noProviderBindingHash(unsigned) {
  const projection = {
    requestHash: unsigned.requestHash,
    phase: unsigned.phase,
    brokerInstalled: unsigned.brokerInstalled,
    imageDigest: unsigned.topology.imageDigest,
    runnerUid: unsigned.topology.runnerUid,
    sandboxRoot: unsigned.paths.sandboxRoot,
    proxySocket: unsigned.paths.proxySocket,
    brokerSocket: unsigned.paths.brokerSocket,
    cgroup: unsigned.paths.cgroup,
    networkRuleOrderHash: unsigned.networkPolicy.ruleOrderHash,
    networkProducerExecutableHash: unsigned.networkPolicy.producerExecutableHash,
    sandboxBootId: unsigned.networkPolicy.sandboxBootId,
    trialId: unsigned.networkPolicy.trialId,
    producerSessionId: unsigned.networkPolicy.producerSessionId,
  };
  return crypto.createHash('sha256')
    .update('engineer-runtime-no-provider-probe-binding.v1\0')
    .update(canonicalJson(projection))
    .digest('hex');
}

function credentialFree(value, label) {
  const visit = (current) => {
    if (typeof current === 'string') {
      if (CREDENTIAL_VALUE.test(current)) fail(`${label} contains forbidden material`, 'ERR_RUNTIME_PROBE_SECRET');
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (CREDENTIAL_NAME.test(key)
          && !['providerCredentialAbsent', 'providerCredentialsAbsent', 'daytonaCredentialsAbsent'].includes(key)) {
        fail(`${label} contains a forbidden field`, 'ERR_RUNTIME_PROBE_SECRET');
      }
      visit(item);
    }
  };
  visit(value);
}

function boundedClone(value, label, maximum = MAX_EVIDENCE_BYTES) {
  let nodes = 0;
  const ancestors = new WeakSet();
  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail(`${label} exceeds its structure bound`);
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) fail(`${label} contains an unsafe number`);
      return current;
    }
    if (typeof current !== 'object' || ancestors.has(current)) fail(`${label} contains unsafe data`);
    ancestors.add(current);
    try {
      if (Object.getOwnPropertySymbols(current).length !== 0) fail(`${label} contains symbol data`);
      if (Array.isArray(current)) {
        const clone = [];
        if (Object.getOwnPropertyNames(current).length !== current.length + 1) {
          fail(`${label} contains non-JSON array data`);
        }
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
            fail(`${label} contains an unsafe array field`);
          }
          clone.push(visit(descriptor.value, depth + 1));
        }
        return clone;
      }
      if (!plainObject(current)) fail(`${label} contains a non-plain object`);
      const keys = Object.keys(current);
      if (Object.getOwnPropertyNames(current).length !== keys.length) {
        fail(`${label} contains non-enumerable data`);
      }
      const clone = {};
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
          fail(`${label} contains an unsafe object field`);
        }
        clone[key] = visit(descriptor.value, depth + 1);
      }
      return clone;
    } finally {
      ancestors.delete(current);
    }
  };
  const clone = visit(value, 0);
  const encoded = canonicalJson(clone);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maximum) {
    fail(`${label} exceeds its byte bound`);
  }
  credentialFree(clone, label);
  return clone;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function safeArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== REQUIRED_FLAGS.length * 2
      || Object.getOwnPropertyNames(argv).length !== argv.length + 1) {
    fail('runtime probe invocation has the wrong arity', 'ERR_RUNTIME_PROBE_INVOCATION');
  }
  let bytes = 0;
  return argv.map((_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      fail('runtime probe invocation contains an unsafe argument', 'ERR_RUNTIME_PROBE_INVOCATION');
    }
    const value = boundedString(descriptor.value, 'runtime probe argument', 1_024);
    bytes += Buffer.byteLength(value, 'utf8') + 1;
    if (bytes > MAX_ARG_BYTES) fail('runtime probe invocation exceeds its byte bound', 'ERR_RUNTIME_PROBE_INVOCATION');
    return value;
  });
}

function canonicalPath(value, label, { below = null, exact = null, maximum = 512 } = {}) {
  boundedString(value, label, maximum);
  if (!path.posix.isAbsolute(value)
      || path.posix.normalize(value) !== value
      || value.includes('//')
      || value.endsWith('/')) {
    fail(`${label} is not a canonical absolute path`, 'ERR_RUNTIME_PROBE_INVOCATION');
  }
  if (exact !== null && value !== exact) fail(`${label} drifted from the fixed runtime`, 'ERR_RUNTIME_PROBE_INVOCATION');
  if (below !== null && !value.startsWith(`${below}/`)) {
    fail(`${label} escaped its fixed root`, 'ERR_RUNTIME_PROBE_INVOCATION');
  }
  return value;
}

/** Parse the seven exact readiness flags. Flag order is immaterial; repetition is forbidden. */
export function parseRuntimeProbeArgs(argv) {
  const safe = safeArgv(argv);
  const values = new Map();
  const permitted = new Set(REQUIRED_FLAGS);
  for (let index = 0; index < safe.length; index += 2) {
    const flag = safe[index];
    if (!permitted.has(flag) || values.has(flag)) {
      fail('runtime probe invocation contains an unknown or duplicate flag', 'ERR_RUNTIME_PROBE_INVOCATION');
    }
    values.set(flag, safe[index + 1]);
  }
  if (values.size !== REQUIRED_FLAGS.length) {
    fail('runtime probe invocation is incomplete', 'ERR_RUNTIME_PROBE_INVOCATION');
  }
  const phase = values.get('--phase');
  if (!['pre-broker', 'post-broker'].includes(phase)) {
    fail('runtime probe phase is invalid', 'ERR_RUNTIME_PROBE_INVOCATION');
  }
  const imageDigest = values.get('--image-digest');
  if (!IMAGE_DIGEST.test(imageDigest)) fail('runtime probe image digest is invalid', 'ERR_RUNTIME_PROBE_INVOCATION');
  return deepFreeze({
    phase,
    sandboxRoot: canonicalPath(values.get('--sandbox-root'), 'sandbox root', { exact: FIXED_PATHS.sandboxRoot }),
    daemonSocket: canonicalPath(values.get('--daemon-socket'), 'daemon socket', { exact: FIXED_PATHS.daemonSocket, maximum: 104 }),
    proxySocket: canonicalPath(values.get('--proxy-socket'), 'proxy socket', { exact: FIXED_PATHS.proxySocket, maximum: 104 }),
    brokerSocket: canonicalPath(values.get('--broker-socket'), 'broker socket', { exact: FIXED_PATHS.brokerSocket, maximum: 104 }),
    cgroup: canonicalPath(values.get('--cgroup'), 'trial cgroup', { below: '/sys/fs/cgroup', maximum: 512 }),
    imageDigest,
  });
}

export const parseRuntimeProbeArgv = parseRuntimeProbeArgs;

function validateHandoffTopology(value) {
  exactKeys(value, [
    'imageDigest',
    'filesystemId',
    'filesystemBytes',
    'cgroupId',
    'cgroupPathHash',
    'runnerUid',
    'brokerUid',
    'runnerExecutableHash',
    'harborExecutableHash',
  ], 'probe handoff topology');
  if (!IMAGE_DIGEST.test(String(value.imageDigest))) fail('probe handoff image digest is invalid');
  safeId(value.filesystemId, 'probe handoff filesystem id');
  integer(value.filesystemBytes, 'probe handoff filesystem size', TEN_GIB, TEN_GIB);
  safeId(value.cgroupId, 'probe handoff cgroup id');
  digest(value.cgroupPathHash, 'probe handoff cgroup path hash');
  integer(value.runnerUid, 'probe handoff runner uid', RUNNER_UID, RUNNER_UID);
  integer(value.brokerUid, 'probe handoff broker uid', BROKER_UID, BROKER_UID);
  digest(value.runnerExecutableHash, 'probe handoff runner executable hash');
  digest(value.harborExecutableHash, 'probe handoff Harbor executable hash');
}

function validateHandoffPaths(value) {
  exactKeys(value, [
    'sandboxRoot', 'daemonSocket', 'proxySocket', 'brokerSocket', 'cgroup', 'evidenceReserve',
  ], 'probe handoff paths');
  canonicalPath(value.sandboxRoot, 'probe handoff sandbox root', { exact: FIXED_PATHS.sandboxRoot });
  canonicalPath(value.daemonSocket, 'probe handoff daemon socket', { exact: FIXED_PATHS.daemonSocket, maximum: 104 });
  canonicalPath(value.proxySocket, 'probe handoff proxy socket', { exact: FIXED_PATHS.proxySocket, maximum: 104 });
  canonicalPath(value.brokerSocket, 'probe handoff broker socket', { exact: FIXED_PATHS.brokerSocket, maximum: 104 });
  canonicalPath(value.cgroup, 'probe handoff cgroup', { below: '/sys/fs/cgroup', maximum: 512 });
  canonicalPath(value.evidenceReserve, 'probe handoff evidence reserve', {
    exact: '/engineer-bounded/evidence/.reserve', maximum: 104,
  });
}

function validateHandoffResources(value) {
  exactKeys(value, ['evidenceReserveBytes', 'cpuMax', 'memoryMax', 'pidsMax'], 'probe handoff resources');
  integer(value.evidenceReserveBytes, 'probe handoff evidence reserve', 64 * 1024 * 1024, TEN_GIB - 1);
  boundedString(value.cpuMax, 'probe handoff CPU limit', 64);
  if (!/^[1-9][0-9]{0,15} [1-9][0-9]{0,15}$/.test(value.cpuMax)) fail('probe handoff CPU limit is invalid');
  integer(value.memoryMax, 'probe handoff memory limit', 64 * 1024 * 1024, TEN_GIB);
  integer(value.pidsMax, 'probe handoff PID limit', 16, 65_535);
}

function unsignedProbeHandoff(input) {
  exactKeys(input, HANDOFF_INPUT_FIELDS, 'runtime probe handoff input');
  const value = boundedClone(input, 'runtime probe handoff input', MAX_HANDOFF_BYTES);
  digest(value.requestHash, 'probe handoff request hash');
  if (!['pre-broker', 'post-broker'].includes(value.phase)) fail('probe handoff phase is invalid');
  instant(value.observedAt, 'probe handoff observedAt');
  boolean(value.brokerInstalled, 'probe handoff broker state', value.phase === 'post-broker');
  validateHandoffTopology(value.topology);
  validateHandoffPaths(value.paths);
  validateHandoffResources(value.resources);
  let networkPolicy;
  try { networkPolicy = validateRuntimeNetworkPolicyReceipt(value.networkPolicy); } catch {
    fail('probe handoff network policy receipt drifted');
  }
  if (networkPolicy.requestHash !== value.requestHash) {
    fail('probe handoff network policy lifecycle binding drifted');
  }
  if (value.topology.cgroupId !== path.posix.basename(value.paths.cgroup)) {
    fail('probe handoff topology identity drifted');
  }
  return value;
}

/** Create the exact content-free handoff written to inherited FD 3. */
export function createRuntimeProbeHandoff(input) {
  const unsigned = unsignedProbeHandoff(input);
  const documentWithoutHash = {
    schema: RUNTIME_PROBE_HANDOFF_SCHEMA,
    ...unsigned,
    noProviderProbeBindingHash: noProviderBindingHash(unsigned),
  };
  return deepFreeze({
    ...documentWithoutHash,
    handoffHash: handoffDigest(documentWithoutHash),
  });
}

export function validateRuntimeProbeHandoff(input) {
  const value = boundedClone(input, 'runtime probe handoff', MAX_HANDOFF_BYTES);
  exactKeys(value, HANDOFF_FIELDS, 'runtime probe handoff');
  if (value.schema !== RUNTIME_PROBE_HANDOFF_SCHEMA) fail('runtime probe handoff schema drifted');
  digest(value.noProviderProbeBindingHash, 'no-provider probe binding hash');
  digest(value.handoffHash, 'runtime probe handoff hash');
  const unsigned = unsignedProbeHandoff(Object.fromEntries(
    HANDOFF_INPUT_FIELDS.map((field) => [field, value[field]]),
  ));
  if (value.noProviderProbeBindingHash !== noProviderBindingHash(unsigned)) {
    fail('no-provider probe binding hash drifted');
  }
  const withoutHash = {
    schema: value.schema,
    ...unsigned,
    noProviderProbeBindingHash: value.noProviderProbeBindingHash,
  };
  const expected = handoffDigest(withoutHash);
  if (!crypto.timingSafeEqual(Buffer.from(value.handoffHash, 'hex'), Buffer.from(expected, 'hex'))) {
    fail('runtime probe handoff hash drifted');
  }
  return deepFreeze(value);
}

/** Canonical handoff bytes intentionally contain no trailing newline. */
export function encodeRuntimeProbeHandoff(input) {
  const value = Object.hasOwn(input ?? {}, 'handoffHash')
    ? validateRuntimeProbeHandoff(input)
    : createRuntimeProbeHandoff(input);
  return Buffer.from(canonicalJson(value), 'utf8');
}

/** Canonical framing rejects duplicate object keys, whitespace, and trailing bytes. */
export function parseRuntimeProbeHandoff(input) {
  let bytes;
  try {
    bytes = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(String(input ?? ''), 'utf8');
  } catch {
    fail('runtime probe handoff is not bounded bytes', 'ERR_RUNTIME_PROBE_HANDOFF');
  }
  try {
    if (bytes.length < 2 || bytes.length > MAX_HANDOFF_BYTES || bytes.includes(0)) {
      fail('runtime probe handoff exceeds its framing bound', 'ERR_RUNTIME_PROBE_HANDOFF');
    }
    const raw = bytes.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('runtime probe handoff is not canonical JSON', 'ERR_RUNTIME_PROBE_HANDOFF');
    }
    if (canonicalJson(parsed) !== raw) {
      fail('runtime probe handoff contains duplicate keys or trailing bytes', 'ERR_RUNTIME_PROBE_HANDOFF');
    }
    return validateRuntimeProbeHandoff(parsed);
  } finally {
    bytes.fill(0);
  }
}

function readFdBounded(fd, maximum) {
  const buffer = Buffer.allocUnsafe(maximum + 1);
  let used = 0;
  try {
    while (used < buffer.length) {
      const read = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (read === 0) break;
      used += read;
    }
    if (used > maximum) fail('runtime probe handoff exceeds its byte bound', 'ERR_RUNTIME_PROBE_HANDOFF');
    return Buffer.from(buffer.subarray(0, used));
  } finally {
    buffer.fill(0);
  }
}

/** Read and close the one fixed inherited descriptor exactly once. */
export function readRuntimeProbeHandoff({
  fd = RUNTIME_PROBE_HANDOFF_FD,
  read = readFdBounded,
  inspect = (descriptor) => fs.fstatSync(descriptor),
  close = (descriptor) => fs.closeSync(descriptor),
} = {}) {
  if (fd !== RUNTIME_PROBE_HANDOFF_FD) fail('runtime probe handoff descriptor drifted', 'ERR_RUNTIME_PROBE_HANDOFF');
  if (typeof read !== 'function' || typeof inspect !== 'function' || typeof close !== 'function') {
    throw new TypeError('runtime probe handoff descriptor primitives are incomplete');
  }
  let bytes;
  try {
    const stat = inspect(fd);
    if (!stat || typeof stat.isFIFO !== 'function' || typeof stat.isSocket !== 'function'
        || (!stat.isFIFO() && !stat.isSocket())) {
      fail('runtime probe handoff is not an inherited pipe or socket', 'ERR_RUNTIME_PROBE_HANDOFF');
    }
    bytes = read(fd, MAX_HANDOFF_BYTES);
    if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') {
      fail('runtime probe handoff reader returned invalid bytes', 'ERR_RUNTIME_PROBE_HANDOFF');
    }
    return parseRuntimeProbeHandoff(bytes);
  } catch (error) {
    throw sanitizedFailure(error, 'runtime probe handoff');
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    try { close(fd); } catch { /* descriptor custody remains fail-closed */ }
  }
}

function validateEnvironment(environment) {
  if (!environment || typeof environment !== 'object') {
    fail('runtime probe environment is invalid', 'ERR_RUNTIME_PROBE_ENVIRONMENT');
  }
  let names;
  try {
    names = Object.keys(environment);
  } catch {
    fail('runtime probe environment is invalid', 'ERR_RUNTIME_PROBE_ENVIRONMENT');
  }
  if (names.length > Object.keys(SAFE_ENVIRONMENT).length
      || names.some((name) => !Object.hasOwn(SAFE_ENVIRONMENT, name))) {
    // Unknown values are deliberately never read. The helper receives only a
    // code-owned support environment from the privileged supervisor.
    fail('runtime probe environment is not the fixed support allowlist', 'ERR_RUNTIME_PROBE_ENVIRONMENT');
  }
  for (const name of names) {
    const value = environment[name];
    if (typeof value !== 'string'
        || !SAFE_ENVIRONMENT[name].has(value)) {
      fail('runtime probe support environment drifted', 'ERR_RUNTIME_PROBE_ENVIRONMENT');
    }
  }
}

function validatePrimitives(primitives) {
  if (!plainObject(primitives)) throw new TypeError('runtime probe primitives must be a plain object');
  for (const name of REQUIRED_PRIMITIVES) {
    if (typeof primitives[name] !== 'function') throw new TypeError(`runtime probe primitive ${name} is required`);
  }
  return primitives;
}

function fixedSpec(value) {
  return deepFreeze({ ...value, shell: false });
}

async function invoke(primitives, name, spec = undefined) {
  try {
    const value = spec === undefined
      ? await primitives[name]()
      : await primitives[name](fixedSpec(spec));
    return boundedClone(value, `${name} evidence`);
  } catch (error) {
    throw sanitizedFailure(error, `${name} observation`);
  }
}

function validateCgroup(value, options, handoff) {
  exactKeys(value, ['id', 'pathHash', 'populated', 'controllersEnforced', 'runnerUid'], 'cgroup readiness');
  safeId(value.id, 'cgroup id');
  digest(value.pathHash, 'cgroup path hash');
  if (value.id !== path.posix.basename(options.cgroup)
      || value.id !== handoff.topology.cgroupId
      || value.pathHash !== handoff.topology.cgroupPathHash) {
    fail('cgroup identity drifted');
  }
  boolean(value.populated, 'cgroup population', true);
  boolean(value.controllersEnforced, 'cgroup controllers', true);
  integer(value.runnerUid, 'cgroup runner uid', RUNNER_UID, RUNNER_UID);
}

function validateNoProvider(value, options, handoff) {
  exactKeys(value, [
    'completed', 'imageDigest', 'genericMountPassed', 'harnessMountPassed',
    'providerCalls', 'providerCredentialAbsent', 'bindingHash',
  ], 'no-provider probe');
  if (value.imageDigest !== options.imageDigest
      || value.bindingHash !== handoff.noProviderProbeBindingHash) {
    fail('no-provider probe binding drifted');
  }
  boolean(value.completed, 'no-provider completion', true);
  boolean(value.genericMountPassed, 'generic mount probe', true);
  boolean(value.harnessMountPassed, 'harness mount probe', true);
  integer(value.providerCalls, 'no-provider call count', 0, 0);
  boolean(value.providerCredentialAbsent, 'no-provider credential absence', true);
  return {
    completed: value.completed,
    imageDigest: value.imageDigest,
    genericMountPassed: value.genericMountPassed,
    harnessMountPassed: value.harnessMountPassed,
    providerCalls: value.providerCalls,
    providerCredentialAbsent: value.providerCredentialAbsent,
  };
}

function validateStorage(value, handoff) {
  exactKeys(value, ['filesystemId', 'totalBytes', 'enospcObserved', 'evidenceHeadroomRecovered'], 'storage probe');
  safeId(value.filesystemId, 'bounded filesystem id');
  integer(value.totalBytes, 'bounded filesystem size', TEN_GIB, TEN_GIB);
  if (value.filesystemId !== handoff.topology.filesystemId
      || value.totalBytes !== handoff.topology.filesystemBytes) {
    fail('storage probe filesystem identity drifted');
  }
  boolean(value.enospcObserved, 'storage ENOSPC observation', true);
  boolean(value.evidenceHeadroomRecovered, 'evidence headroom recovery', true);
}

function validateRunner(value) {
  exactKeys(value, [
    'uid', 'effectiveCapabilities', 'privateDaemonDenied', 'realDaemonDenied',
    'alternateDaemonDenied', 'mountDenied', 'ptraceDenied', 'providerEgressDenied',
    'metadataDenied', 'daytonaCredentialsAbsent', 'providerCredentialsAbsent',
  ], 'runner readiness');
  integer(value.uid, 'runner uid', RUNNER_UID, RUNNER_UID);
  integer(value.effectiveCapabilities, 'runner effective capabilities', 0, 0);
  for (const field of [
    'privateDaemonDenied', 'realDaemonDenied', 'alternateDaemonDenied', 'mountDenied',
    'ptraceDenied', 'providerEgressDenied', 'metadataDenied', 'daytonaCredentialsAbsent',
    'providerCredentialsAbsent',
  ]) boolean(value[field], `runner ${field}`, true);
}

function validateTask(value) {
  exactKeys(value, [
    'networkNone', 'readOnlyRoot', 'capabilitiesDropped', 'noNewPrivileges',
    'brokerReachable', 'brokerSocketMounted', 'brokerClientGidPresent',
  ], 'task readiness');
  for (const field of ['networkNone', 'readOnlyRoot', 'capabilitiesDropped', 'noNewPrivileges']) {
    boolean(value[field], `task ${field}`, true);
  }
  for (const field of ['brokerReachable', 'brokerSocketMounted', 'brokerClientGidPresent']) {
    boolean(value[field], `task ${field}`, false);
  }
}

function validateBroker(value, phase) {
  exactKeys(value, ['uid', 'onlyProviderEgress'], 'broker readiness');
  integer(value.uid, 'broker uid', BROKER_UID, BROKER_UID);
  boolean(value.onlyProviderEgress, 'broker-only egress', phase === 'post-broker');
}

/**
 * Collect and validate exactly the readiness document consumed by supervisor.mjs.
 */
export async function collectRuntimeProbe({
  argv = process.argv.slice(2),
  environment = process.env,
  primitives = createNodeRuntimeProbePrimitives(),
} = {}) {
  const options = parseRuntimeProbeArgs(argv);
  validateEnvironment(environment);
  const source = validatePrimitives(primitives);
  const [platform, effectiveUid] = await Promise.all([
    invoke(source, 'platform'),
    invoke(source, 'effectiveUid'),
  ]);
  if (platform !== 'linux') fail('runtime probe requires Linux', 'ERR_RUNTIME_PROBE_PLATFORM');
  if (effectiveUid !== 0) fail('runtime probe requires effective root', 'ERR_RUNTIME_PROBE_PLATFORM');

  const handoff = validateRuntimeProbeHandoff(await invoke(source, 'readHandoff', {
    fd: RUNTIME_PROBE_HANDOFF_FD,
    maxBytes: MAX_HANDOFF_BYTES,
  }));
  if (handoff.phase !== options.phase
      || handoff.brokerInstalled !== (options.phase === 'post-broker')
      || handoff.topology.imageDigest !== options.imageDigest
      || handoff.paths.sandboxRoot !== options.sandboxRoot
      || handoff.paths.daemonSocket !== options.daemonSocket
      || handoff.paths.proxySocket !== options.proxySocket
      || handoff.paths.brokerSocket !== options.brokerSocket
      || handoff.paths.cgroup !== options.cgroup) {
    fail('runtime probe handoff identity drifted');
  }

  const common = {
    handoff,
    phase: options.phase,
    sandboxRoot: options.sandboxRoot,
    daemonSocket: options.daemonSocket,
    proxySocket: options.proxySocket,
    brokerSocket: options.brokerSocket,
    cgroup: options.cgroup,
    imageDigest: options.imageDigest,
    runnerUid: RUNNER_UID,
    brokerUid: BROKER_UID,
    maxOutputBytes: MAX_EVIDENCE_BYTES,
  };
  const [cgroup, noProviderProbe, storageProbe, runner, task, broker, runnerHash, harborHash] = await Promise.all([
    invoke(source, 'inspectCgroup', common),
    invoke(source, 'inspectNoProviderProbe', common),
    invoke(source, 'inspectStorage', common),
    invoke(source, 'inspectRunner', common),
    invoke(source, 'inspectTask', common),
    invoke(source, 'inspectBroker', common),
    invoke(source, 'hashExecutable', {
      role: 'runner', file: FIXED_PATHS.runner, maxBytes: MAX_EXECUTABLE_BYTES,
    }),
    invoke(source, 'hashExecutable', {
      role: 'harbor', file: FIXED_PATHS.harbor, maxBytes: MAX_EXECUTABLE_BYTES,
    }),
  ]);

  validateCgroup(cgroup, options, handoff);
  const noProvider = validateNoProvider(noProviderProbe, options, handoff);
  validateStorage(storageProbe, handoff);
  validateRunner(runner);
  validateTask(task);
  validateBroker(broker, options.phase);
  digest(runnerHash, 'runner executable hash');
  digest(harborHash, 'Harbor executable hash');
  if (runnerHash !== handoff.topology.runnerExecutableHash
      || harborHash !== handoff.topology.harborExecutableHash) {
    fail('trusted executable identity drifted');
  }

  const result = {
    cgroup,
    noProviderProbe: noProvider,
    storageProbe,
    runner,
    task,
    broker,
    executables: {
      runnerExecutableHash: runnerHash,
      harborExecutableHash: harborHash,
    },
  };
  const encoded = canonicalJson(result);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_EVIDENCE_BYTES) fail('runtime probe evidence exceeds its byte bound');
  return deepFreeze(result);
}

function missingProbeProducer(name, message) {
  throw new RuntimeProbeError(message, `ERR_RUNTIME_PROBE_MISSING_${name}`);
}

function sameInode(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function readBoundKernelFile(directory, name, maximum = MAX_KERNEL_FILE_BYTES) {
  if (!path.posix.isAbsolute(directory)
      || path.posix.normalize(directory) !== directory
      || !/^[A-Za-z0-9._-]+$/.test(name)
      || !Number.isSafeInteger(maximum)
      || maximum < 1
      || maximum > MAX_KERNEL_FILE_BYTES) {
    throw new Error('kernel evidence path escaped its fixed bound');
  }
  const directoryFd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let fileFd;
  const bytes = Buffer.allocUnsafe(maximum + 1);
  try {
    const directoryStat = fs.fstatSync(directoryFd);
    if (!directoryStat.isDirectory() || fs.realpathSync.native(directory) !== directory) {
      throw new Error('kernel evidence directory is not a stable real directory');
    }
    fileFd = fs.openSync(
      `/proc/self/fd/${directoryFd}/${name}`,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const before = fs.fstatSync(fileFd);
    if (!before.isFile()) throw new Error('kernel evidence entry is not a file');
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fileFd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > maximum) throw new Error('kernel evidence entry exceeded its byte bound');
    const after = fs.fstatSync(fileFd);
    if (!sameInode(before, after)) throw new Error('kernel evidence entry changed identity');
    const text = bytes.subarray(0, used).toString('utf8');
    if (text.includes('\0')) throw new Error('kernel evidence entry contains a NUL byte');
    return text;
  } finally {
    bytes.fill(0);
    if (fileFd !== undefined) fs.closeSync(fileFd);
    fs.closeSync(directoryFd);
  }
}

function inspectRealPath(target) {
  let parentFd;
  try {
    const parent = path.posix.dirname(target);
    parentFd = fs.openSync(
      parent,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const parentStat = fs.fstatSync(parentFd);
    if (!parentStat.isDirectory()
        || fs.realpathSync.native(parent) !== parent
        || (parentStat.mode & 0o022) !== 0) {
      throw new Error('runtime evidence parent is not protected');
    }
    const bound = `/proc/self/fd/${parentFd}/${path.posix.basename(target)}`;
    const before = fs.lstatSync(bound);
    const real = fs.realpathSync.native(bound);
    const after = fs.lstatSync(bound);
    if (real !== target || before.isSymbolicLink() || !sameInode(before, after)) {
      throw new Error('runtime evidence path changed identity');
    }
    return {
      exists: true,
      real: true,
      kind: before.isSocket() ? 'socket'
        : before.isDirectory() ? 'directory'
          : before.isFile() ? 'file' : 'other',
      ownerUid: before.uid,
      groupGid: before.gid,
      mode: before.mode & 0o7777,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  } finally {
    if (parentFd !== undefined) fs.closeSync(parentFd);
  }
}

function parseSingleInteger(text, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const value = String(text).trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is not an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} is outside its bound`);
  }
  return number;
}

function parseKeyValueLines(text, label) {
  const result = {};
  for (const line of String(text).trim().split('\n').filter(Boolean)) {
    const match = line.match(/^([a-z0-9_.-]+)\s+([0-9]+)$/);
    if (!match || Object.hasOwn(result, match[1])) throw new Error(`${label} is malformed`);
    result[match[1]] = parseSingleInteger(match[2], label);
  }
  return result;
}

function parseProcessStatus(pid, text) {
  const uid = String(text).match(/^Uid:\s+([0-9]+)\s/m);
  const gid = String(text).match(/^Gid:\s+([0-9]+)\s/m);
  const groups = String(text).match(/^Groups:\s*([0-9 ]*)$/m);
  const capabilities = String(text).match(/^CapEff:\s+([a-fA-F0-9]+)$/m);
  const noNewPrivileges = String(text).match(/^NoNewPrivs:\s+([01])$/m);
  if (!uid || !gid || !groups || !capabilities || !noNewPrivileges) {
    throw new Error('runtime process status is incomplete');
  }
  return {
    pid,
    uid: parseSingleInteger(uid[1], 'process uid', 0, 65_535),
    gid: parseSingleInteger(gid[1], 'process gid', 0, 65_535),
    supplementaryGids: groups[1].trim() === '' ? [] : groups[1].trim().split(/\s+/).map((value) =>
      parseSingleInteger(value, 'process supplementary gid', 0, 65_535)),
    effectiveCapabilities: /^0+$/.test(capabilities[1]) ? 0 : 1,
    noNewPrivileges: noNewPrivileges[1] === '1',
  };
}

function observeCgroup(pathname, maximum) {
  const directory = inspectRealPath(pathname);
  if (!directory.exists || directory.kind !== 'directory') throw new Error('trial cgroup is unavailable');
  const events = parseKeyValueLines(readBoundKernelFile(pathname, 'cgroup.events', maximum), 'cgroup events');
  const processText = readBoundKernelFile(pathname, 'cgroup.procs', maximum).trim();
  const processIds = processText === '' ? [] : processText.split('\n').map((value) =>
    parseSingleInteger(value, 'cgroup process id', 1, 4_194_304));
  if (processIds.length > 4_096 || new Set(processIds).size !== processIds.length) {
    throw new Error('cgroup process inventory is unbounded or duplicated');
  }
  const processes = processIds.map((pid) =>
    parseProcessStatus(pid, readBoundKernelFile(`/proc/${pid}`, 'status', maximum)));
  const cpuMax = readBoundKernelFile(pathname, 'cpu.max', maximum).trim();
  const memoryMax = parseSingleInteger(readBoundKernelFile(pathname, 'memory.max', maximum), 'memory.max');
  const pidsMax = parseSingleInteger(readBoundKernelFile(pathname, 'pids.max', maximum), 'pids.max');
  return {
    real: true,
    id: path.posix.basename(pathname),
    populated: events.populated === 1,
    processIds,
    processes,
    cpuMax,
    memoryMax,
    pidsMax,
  };
}

function runFixedCommand({ file, args, timeoutMs, maxOutputBytes }) {
  if (![FIXED_IPTABLES, FIXED_IP6TABLES].includes(file)
      || !Array.isArray(args)
      || args.some((value) => typeof value !== 'string' || value.includes('\0'))
      || !Number.isSafeInteger(timeoutMs)
      || !Number.isSafeInteger(maxOutputBytes)) {
    throw new Error('read-only network command escaped its fixed contract');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: '/',
      env: { LANG: 'C.UTF-8' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    let bytes = 0;
    let overflow = false;
    let timer;
    for (const [stream, retain] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          overflow = true;
          child.kill('SIGKILL');
        } else if (retain) stdout.push(Buffer.from(chunk));
      });
    }
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error('read-only network output exceeded its byte bound'));
      resolve({ exitCode: code, signal: signal ?? 'none', stdout: Buffer.concat(stdout).toString('utf8') });
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('read-only network command timed out'));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function observeNetworkPolicy(receipt, runCommand = runFixedCommand) {
  const families = [
    { key: 'ipv4', file: FIXED_IPTABLES, chain: NETWORK_CHAIN_V4 },
    { key: 'ipv6', file: FIXED_IP6TABLES, chain: NETWORK_CHAIN_V6 },
  ];
  const evidence = [];
  for (const family of families) {
    const base = { file: family.file, timeoutMs: 5_000, maxOutputBytes: MAX_NETWORK_OUTPUT_BYTES };
    const [outputRules, chainRules] = await Promise.all([
      runCommand({ ...base, args: ['--wait', '5', '--list-rules', 'OUTPUT'], shell: false }),
      runCommand({ ...base, args: ['--wait', '5', '--list-rules', family.chain], shell: false }),
    ]);
    if (outputRules.exitCode !== 0 || chainRules.exitCode !== 0) {
      throw new Error('network policy inventory command failed');
    }
    evidence.push({ key: family.key, file: family.file, output: outputRules.stdout, chain: chainRules.stdout });
  }
  validateRuntimeNetworkRuleInventory(receipt, Object.fromEntries(
    evidence.map(({ key, output, chain }) => [key, { output, chain }]),
  ));
  return {
    runnerEgressDenied: true,
    brokerOnlyEgress: true,
    metadataDenied: true,
    rawSocketDenied: true,
    evidenceHash: crypto.createHash('sha256')
      .update('engineer-runtime-network-rules.v1\0')
      .update(canonicalJson(evidence))
      .digest('hex'),
  };
}

function processStartTime(pid) {
  const stat = readBoundKernelFile(`/proc/${pid}`, 'stat', MAX_KERNEL_FILE_BYTES).trim();
  const match = stat.match(/^[1-9][0-9]* \(.*\) [A-Za-z] (.+)$/);
  const fields = match?.[1].split(/\s+/);
  const startTimeTicks = fields?.[18];
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(startTimeTicks))) {
    throw new Error('runtime process start identity is malformed');
  }
  return startTimeTicks;
}

function scanSocketOwners(target) {
  const processEntries = fs.readdirSync('/proc', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name));
  if (processEntries.length > MAX_PROC_SCAN) {
    throw new Error('process inventory exceeded its scan bound');
  }
  const pids = processEntries
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right);
  const owners = [];
  for (const pid of pids) {
    let entries;
    try { entries = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    if (entries.length > 4_096) throw new Error('process descriptor inventory exceeded its scan bound');
    let owns = false;
    for (const entry of entries) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${entry}`) === target) { owns = true; break; }
      } catch { /* process or descriptor exited during the bounded scan */ }
    }
    if (owns) owners.push({
      ...parseProcessStatus(pid, readBoundKernelFile(`/proc/${pid}`, 'status')),
      startTimeTicks: processStartTime(pid),
    });
  }
  return owners;
}

function socketTarget(socketPath) {
  const unix = readBoundKernelFile(`/proc/${process.pid}/net`, 'unix', MAX_KERNEL_FILE_BYTES);
  const matching = unix.split('\n').slice(1).map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 8 && fields.slice(7).join(' ') === socketPath);
  if (matching.length !== 1 || !/^[0-9]+$/.test(matching[0][6])) {
    throw new Error('broker socket inode is not unique');
  }
  return `socket:[${matching[0][6]}]`;
}

function observeSocketProcess(socketPath) {
  const target = socketTarget(socketPath);
  const owners = scanSocketOwners(target);
  if (owners.length !== 1) throw new Error('broker socket process is not uniquely owned');
  const confirmed = scanSocketOwners(target);
  if (socketTarget(socketPath) !== target
      || canonicalJson(confirmed) !== canonicalJson(owners)) {
    throw new Error('broker socket ownership changed during observation');
  }
  return owners[0];
}

function openThroughStableParent(target) {
  const parent = path.posix.dirname(target);
  const basename = path.posix.basename(target);
  const parentFd = fs.openSync(
    parent,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(parentFd);
    if (!stat.isDirectory()
        || fs.realpathSync.native(parent) !== parent
        || stat.uid !== 0
        || (stat.mode & 0o022) !== 0) {
      throw new Error('trusted executable parent custody drifted');
    }
    const descriptor = fs.openSync(
      `/proc/self/fd/${parentFd}/${basename}`,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    return { descriptor, parentFd };
  } catch (error) {
    fs.closeSync(parentFd);
    throw error;
  }
}

function hashProtectedExecutable(file, maxBytes) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink()
      || !before.isFile()
      || before.uid !== 0
      || (before.mode & 0o111) === 0
      || (before.mode & 0o022) !== 0
      || before.size < 1
      || before.size > maxBytes) {
    throw new Error('trusted executable custody drifted');
  }
  const { descriptor, parentFd } = openThroughStableParent(file);
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameInode(before, opened) || opened.size !== before.size) throw new Error('trusted executable raced before hashing');
    const hash = crypto.createHash('sha256');
    let offset = 0;
    while (offset < opened.size) {
      const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
      if (count === 0) throw new Error('trusted executable changed while hashing');
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (!sameInode(opened, after) || after.size !== opened.size) throw new Error('trusted executable raced while hashing');
    return hash.digest('hex');
  } finally {
    chunk.fill(0);
    fs.closeSync(descriptor);
    fs.closeSync(parentFd);
  }
}

function nodeProbeSystem(overrides) {
  if (!plainObject(overrides)) throw new TypeError('runtime probe system overrides must be a plain object');
  const system = {
    async observeCgroup({ path: pathname, maxBytes }) { return observeCgroup(pathname, maxBytes); },
    async observeNetworkPolicy({ receipt }) { return observeNetworkPolicy(receipt); },
    async inspectPath({ path: pathname }) { return inspectRealPath(pathname); },
    async observeSocketProcess({ socketPath }) { return observeSocketProcess(socketPath); },
    async hashExecutable({ file, maxBytes }) { return hashProtectedExecutable(file, maxBytes); },
    async readBootId() { return readBoundKernelFile('/proc/sys/kernel/random', 'boot_id', 128).trim(); },
    ...overrides,
  };
  for (const name of [
    'observeCgroup', 'observeNetworkPolicy', 'inspectPath', 'observeSocketProcess',
    'hashExecutable', 'readBootId',
  ]) {
    if (typeof system[name] !== 'function') throw new TypeError(`runtime probe system method ${name} is required`);
  }
  return system;
}

/**
 * Production readiness primitives. Kernel and firewall facts are observed
 * read-only. Active denial/canary history remains fail-closed until its
 * dedicated producer emits an authenticated receipt.
 */
export function createNodeRuntimeProbePrimitives({ system: overrides = {} } = {}) {
  const system = nodeProbeSystem(overrides);
  return {
    async platform() { return process.platform; },
    async effectiveUid() { return process.geteuid?.() ?? process.getuid?.() ?? -1; },
    async readHandoff({ fd }) { return readRuntimeProbeHandoff({ fd }); },
    async inspectCgroup(spec) {
      const observed = await system.observeCgroup({
        path: spec.cgroup,
        maxBytes: spec.maxOutputBytes,
        shell: false,
      });
      const expected = spec.handoff.resources;
      if (!plainObject(observed)
          || observed.real !== true
          || observed.id !== spec.handoff.topology.cgroupId
          || observed.populated !== true
          || !Array.isArray(observed.processIds)
          || observed.processIds.length < 1
          || !Array.isArray(observed.processes)
          || observed.processes.length !== observed.processIds.length
          || observed.processes.some((entry) => !plainObject(entry)
            || entry.uid !== spec.runnerUid
            || entry.effectiveCapabilities !== 0
            || entry.noNewPrivileges !== true)
          || observed.cpuMax !== expected.cpuMax
          || observed.memoryMax !== expected.memoryMax
          || observed.pidsMax !== expected.pidsMax) {
        fail('kernel cgroup readiness evidence drifted');
      }
      return {
        id: observed.id,
        pathHash: spec.handoff.topology.cgroupPathHash,
        populated: true,
        controllersEnforced: true,
        runnerUid: spec.runnerUid,
      };
    },
    async inspectNoProviderProbe() {
      missingProbeProducer(
        'NO_PROVIDER_CANARY_RECEIPT',
        'the no-provider canary has no authenticated receipt producer',
      );
    },
    async inspectStorage() {
      missingProbeProducer(
        'STORAGE_ENOSPC_RECEIPT',
        'the ENOSPC and recovered-headroom probe has no authenticated receipt producer',
      );
    },
    async inspectRunner() {
      missingProbeProducer(
        'RUNNER_DENIAL_RECEIPT',
        'runner mount, ptrace, socket, egress, and credential denials have no authenticated receipt producer',
      );
    },
    async inspectTask() {
      missingProbeProducer(
        'TASK_CANARY_RECEIPT',
        'task namespace and broker-isolation facts have no authenticated canary receipt producer',
      );
    },
    async inspectBroker(spec) {
      const policy = validateRuntimeNetworkPolicyReceipt(spec.handoff.networkPolicy);
      const [network, iptablesHash, ip6tablesHash, supervisorHash, bootId] = await Promise.all([
        system.observeNetworkPolicy({
          files: [FIXED_IPTABLES, FIXED_IP6TABLES],
          chains: [NETWORK_CHAIN_V4, NETWORK_CHAIN_V6],
          receipt: policy,
          maxBytes: spec.maxOutputBytes,
          shell: false,
        }),
        system.hashExecutable({ file: FIXED_IPTABLES, maxBytes: MAX_EXECUTABLE_BYTES, shell: false }),
        system.hashExecutable({ file: FIXED_IP6TABLES, maxBytes: MAX_EXECUTABLE_BYTES, shell: false }),
        system.hashExecutable({ file: FIXED_SUPERVISOR, maxBytes: MAX_EXECUTABLE_BYTES, shell: false }),
        system.readBootId({ file: '/proc/sys/kernel/random/boot_id', maxBytes: 128, shell: false }),
      ]);
      if (!plainObject(network)
          || network.runnerEgressDenied !== true
          || network.brokerOnlyEgress !== true
          || network.metadataDenied !== true
          || network.rawSocketDenied !== true
          || iptablesHash !== policy.iptablesExecutableHash
          || ip6tablesHash !== policy.ip6tablesExecutableHash
          || supervisorHash !== policy.producerExecutableHash
          || bootId !== policy.sandboxBootId) {
        fail('broker-only kernel network policy drifted');
      }
      const socket = await system.inspectPath({
        path: spec.brokerSocket,
        kind: 'socket',
        maxBytes: spec.maxOutputBytes,
        shell: false,
      });
      if (spec.phase === 'pre-broker') {
        if (socket?.exists !== false) fail('broker socket exists before broker installation');
        return { uid: spec.brokerUid, onlyProviderEgress: false };
      }
      if (!plainObject(socket)
          || socket.exists !== true
          || socket.real !== true
          || socket.kind !== 'socket'
          || socket.ownerUid !== BROKER_UID
          || socket.groupGid !== BROKER_CLIENT_GID
          || socket.mode !== 0o660) {
        fail('broker socket custody drifted');
      }
      const owner = await system.observeSocketProcess({
        socketPath: spec.brokerSocket,
        maxPids: MAX_PROC_SCAN,
        maxBytes: spec.maxOutputBytes,
        shell: false,
      });
      if (!plainObject(owner)
          || owner.uid !== BROKER_UID
          || owner.gid !== BROKER_GID
          || !Array.isArray(owner.supplementaryGids)
          || !owner.supplementaryGids.includes(BROKER_CLIENT_GID)
          || owner.effectiveCapabilities !== 0
          || owner.noNewPrivileges !== true
          || !/^(?:0|[1-9][0-9]*)$/.test(String(owner.startTimeTicks))) {
        fail('broker process privilege identity drifted');
      }
      return { uid: BROKER_UID, onlyProviderEgress: true };
    },
    async hashExecutable({ file, maxBytes }) {
      return system.hashExecutable({ file, maxBytes, shell: false });
    },
  };
}

function validateOutput(output) {
  if (!output || typeof output.write !== 'function') throw new TypeError('runtime probe output must be writable');
  return output;
}

/** Exact snapshot entrypoint installed at /opt/engineer/bin/engineer-runtime-probe. */
export async function runRuntimeProbeCli({
  executablePath = process.argv[1] ?? '',
  argv = process.argv.slice(2),
  environment = process.env,
  output = process.stdout,
  primitives,
} = {}) {
  if (executablePath !== RUNTIME_PROBE_EXECUTABLE) {
    fail('runtime probe executable invocation drifted', 'ERR_RUNTIME_PROBE_INVOCATION');
  }
  const evidence = await collectRuntimeProbe({
    argv,
    environment,
    ...(primitives === undefined ? {} : { primitives }),
  });
  const serialized = `${canonicalJson(evidence)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) fail('runtime probe output exceeds its byte bound');
  validateOutput(output).write(serialized);
  return 0;
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
  runRuntimeProbeCli().then(
    (code) => { process.exitCode = code; },
    (error) => {
      const code = error instanceof RuntimeProbeError ? error.code : 'ERR_RUNTIME_PROBE';
      process.stderr.write(`engineer runtime probe failed: ${code}\n`);
      process.exitCode = error?.code === 'ERR_RUNTIME_PROBE_INVOCATION' ? 64 : 70;
    },
  );
}
