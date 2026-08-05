#!/usr/local/bin/node

/**
 * Fixed final-evidence helper for the privileged Linux runtime.
 *
 * Mutable in-process facts cross the process boundary once through inherited
 * FD 3 as a canonical, hash-bound, content-free handoff. Everything else is
 * obtained through injected read-only observation primitives. No argv or
 * environment value can select an executable, provider, or remote endpoint.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  providerBrokerEvidenceHash,
  providerBrokerStaticPolicyHash,
  requestProviderBrokerEvidence,
} from './provider-broker.mjs';

export const RUNTIME_EVIDENCE_EXECUTABLE = '/opt/engineer/bin/engineer-runtime-evidence';
export const RUNTIME_EVIDENCE_HANDOFF_FD = 3;
export const RUNTIME_EVIDENCE_HANDOFF_SCHEMA = 'engineer-runtime-evidence-handoff.v1';

const MAX_ARG_BYTES = 8 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_HANDOFF_BYTES = 32 * 1024;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 4_096;
const MAX_RUNTIME_MS = 4 * 60 * 60 * 1_000 + 30_000;
const MAX_OBSERVATION_SKEW_MS = 30_000;
const RUNNER_UID = 2001;
const RUNNER_GID = 2001;
const BROKER_UID = 2002;
const BROKER_GID = 2002;
const BROKER_CLIENT_GID = 2003;
const FIXED_DOCKER = '/usr/local/bin/docker';
const FIXED_HARBOR = '/opt/engineer/bin/harbor';
const FIXED_IPTABLES = '/usr/sbin/iptables';
const FIXED_IP6TABLES = '/usr/sbin/ip6tables';
const FIXED_SUPERVISOR = '/opt/engineer/bin/engineer-runtime-supervisor';
const NETWORK_CHAIN_V4 = 'ENGINEER_EGRESS_V4';
const NETWORK_CHAIN_V6 = 'ENGINEER_EGRESS_V6';
export const RUNTIME_NETWORK_POLICY_RECEIPT_SCHEMA = 'engineer-runtime-network-policy-receipt.v1';
export const RUNTIME_TASK_MOUNT_RECEIPT_SCHEMA = 'engineer-runtime-task-mount-receipt.v1';
export const RUNTIME_TASK_ISOLATION_RECEIPT_SCHEMA = 'engineer-runtime-task-isolation-receipt.v1';
const EXACT_PROVIDER_HOSTNAME = 'openrouter.ai';
const EXACT_PROVIDER_HTTPS_PORT = 443;
const EXACT_METADATA_CIDRS = Object.freeze([
  '169.254.0.0/16',
  '100.100.100.200/32',
  'fe80::/10',
  'fd00:ec2::254/128',
]);
const DAEMON_DATA_ROOT = '/engineer-bounded/docker';
const TASK_MOUNT_RECEIPT = '/engineer-bounded/evidence/task-mount-receipt.json';
const TASK_ISOLATION_RECEIPT = '/engineer-bounded/evidence/task-isolation-receipt.json';
const MAX_KERNEL_FILE_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_POLICY_BYTES = 128 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_PROC_SCAN = 32_768;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_SIGNAL = /^(?:none|SIG[A-Z0-9]{1,24})$/;
const CONTROLLED_PROVIDER = 'controlled-provider';
const ZERO_PROVIDER_CANARY = 'zero-provider-canary';
const CREDENTIAL_NAME = /(?:^DAYTONA(?:_|$)|OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|GROQ|XAI|MISTRAL|COHERE|TOGETHER|FIREWORKS|DEEPSEEK|CEREBRAS|PERPLEXITY|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const CREDENTIAL_VALUE = /(?:Bearer\s+|sk-(?:or|ant|proj)-|github_pat_|ghp_|xox[baprs]-|hf_[A-Za-z0-9])/i;
const SAFE_ENVIRONMENT = Object.freeze({
  LANG: new Set(['C.UTF-8']),
  PATH: new Set(['/usr/bin:/bin', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']),
});
const REQUIRED_FLAGS = Object.freeze([
  '--request-hash',
  '--lease-hash',
  '--daemon-socket',
  '--proxy-socket',
  '--broker-socket',
  '--broker-policy',
  '--cgroup',
  '--workspace',
]);
const FIXED_PATHS = Object.freeze({
  daemonSocket: '/run/engineer/private-docker.sock',
  proxySocket: '/run/engineer/harbor-docker.sock',
  brokerSocket: '/run/engineer/provider/provider.sock',
  brokerPolicy: '/engineer-bounded/broker/provider-policy.json',
});
const REQUIRED_PRIMITIVES = Object.freeze([
  'platform',
  'effectiveUid',
  'readHandoff',
  'inspectDaemonCustody',
  'inspectHarbor',
  'inspectDocker',
  'inspectMounts',
  'inspectCgroup',
  'inspectResources',
  'inspectNetwork',
  'inspectProvider',
  'inspectCleanup',
  'now',
]);
const HANDOFF_INPUT_FIELDS = Object.freeze([
  'executionMode',
  'trialId',
  'requestHash',
  'leaseHash',
  'observedAt',
  'runnerResult',
  'topology',
  'proxy',
  'networkPolicy',
  'broker',
]);
const HANDOFF_FIELDS = Object.freeze([
  'schema',
  ...HANDOFF_INPUT_FIELDS,
  'handoffHash',
]);

export class RuntimeEvidenceError extends Error {
  constructor(message, code = 'ERR_RUNTIME_EVIDENCE', { diagnosticHash = null } = {}) {
    super(message);
    this.name = 'RuntimeEvidenceError';
    this.code = code;
    if (diagnosticHash !== null) this.diagnosticHash = diagnosticHash;
  }
}

function fail(message, code = 'ERR_RUNTIME_EVIDENCE_POLICY') {
  throw new RuntimeEvidenceError(message, code);
}

function missingEvidenceProducer(name, message) {
  throw new RuntimeEvidenceError(message, `ERR_RUNTIME_EVIDENCE_MISSING_${name}`);
}

function failureHash(error) {
  const descriptor = [error?.name, error?.code, error?.message]
    .map((value) => typeof value === 'string' ? value.slice(0, 4_096) : '')
    .join('\0');
  return crypto.createHash('sha256').update(descriptor).digest('hex');
}

function sanitizedFailure(error, label) {
  if (error instanceof RuntimeEvidenceError) return error;
  return new RuntimeEvidenceError(
    `${label} failed closed`,
    'ERR_RUNTIME_EVIDENCE_OBSERVATION',
    { diagnosticHash: failureHash(error) },
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

function executionMode(value) {
  if (![CONTROLLED_PROVIDER, ZERO_PROVIDER_CANARY].includes(value)) {
    fail('runtime execution mode is invalid');
  }
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function handoffDigest(unsigned) {
  return crypto.createHash('sha256')
    .update(`${RUNTIME_EVIDENCE_HANDOFF_SCHEMA}\0`)
    .update(canonicalJson(unsigned))
    .digest('hex');
}

function credentialFree(value, label) {
  const permittedAbsenceFields = new Set([
    'providerCredentialsAbsent', 'daytonaCredentialsAbsent', 'providerCredentialAbsent',
  ]);
  const visit = (current) => {
    if (typeof current === 'string') {
      if (CREDENTIAL_VALUE.test(current)) fail(`${label} contains forbidden material`, 'ERR_RUNTIME_EVIDENCE_SECRET');
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      const safeTokenCount = [
        'maxTokens', 'promptTokens', 'cachedTokens', 'reasoningTokens', 'outputTokens',
      ].includes(key) && (item === null || (Number.isSafeInteger(item) && item >= 0));
      const safeTokenCompleteness = [
        'cachedTokensComplete', 'reasoningTokensComplete',
      ].includes(key) && typeof item === 'boolean';
      if (CREDENTIAL_NAME.test(key)
          && !permittedAbsenceFields.has(key)
          && !safeTokenCount
          && !safeTokenCompleteness) {
        fail(`${label} contains a forbidden field`, 'ERR_RUNTIME_EVIDENCE_SECRET');
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
        if (Object.getOwnPropertyNames(current).length !== current.length + 1) {
          fail(`${label} contains non-JSON array data`);
        }
        const clone = [];
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
    fail('runtime evidence invocation has the wrong arity', 'ERR_RUNTIME_EVIDENCE_INVOCATION');
  }
  let bytes = 0;
  return argv.map((_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      fail('runtime evidence invocation contains an unsafe argument', 'ERR_RUNTIME_EVIDENCE_INVOCATION');
    }
    const value = boundedString(descriptor.value, 'runtime evidence argument', 1_024);
    bytes += Buffer.byteLength(value, 'utf8') + 1;
    if (bytes > MAX_ARG_BYTES) fail('runtime evidence invocation exceeds its byte bound', 'ERR_RUNTIME_EVIDENCE_INVOCATION');
    return value;
  });
}

function canonicalPath(value, label, { below = null, exact = null, maximum = 512 } = {}) {
  boundedString(value, label, maximum);
  if (!path.posix.isAbsolute(value)
      || path.posix.normalize(value) !== value
      || value.includes('//')
      || value.endsWith('/')) {
    fail(`${label} is not a canonical absolute path`, 'ERR_RUNTIME_EVIDENCE_INVOCATION');
  }
  if (exact !== null && value !== exact) fail(`${label} drifted from the fixed runtime`, 'ERR_RUNTIME_EVIDENCE_INVOCATION');
  if (below !== null && !value.startsWith(`${below}/`)) {
    fail(`${label} escaped its fixed root`, 'ERR_RUNTIME_EVIDENCE_INVOCATION');
  }
  return value;
}

/** Parse the eight exact final-evidence flags; unknown and repeated flags fail closed. */
export function parseRuntimeEvidenceArgs(argv) {
  const safe = safeArgv(argv);
  const values = new Map();
  const allowed = new Set(REQUIRED_FLAGS);
  for (let index = 0; index < safe.length; index += 2) {
    const flag = safe[index];
    if (!allowed.has(flag) || values.has(flag)) {
      fail('runtime evidence invocation contains an unknown or duplicate flag', 'ERR_RUNTIME_EVIDENCE_INVOCATION');
    }
    values.set(flag, safe[index + 1]);
  }
  if (values.size !== REQUIRED_FLAGS.length) {
    fail('runtime evidence invocation is incomplete', 'ERR_RUNTIME_EVIDENCE_INVOCATION');
  }
  digest(values.get('--request-hash'), 'request hash');
  digest(values.get('--lease-hash'), 'lease hash');
  if (values.get('--request-hash') === values.get('--lease-hash')) {
    fail('request and lease hashes must be distinct', 'ERR_RUNTIME_EVIDENCE_INVOCATION');
  }
  return deepFreeze({
    requestHash: values.get('--request-hash'),
    leaseHash: values.get('--lease-hash'),
    daemonSocket: canonicalPath(values.get('--daemon-socket'), 'daemon socket', { exact: FIXED_PATHS.daemonSocket, maximum: 104 }),
    proxySocket: canonicalPath(values.get('--proxy-socket'), 'proxy socket', { exact: FIXED_PATHS.proxySocket, maximum: 104 }),
    brokerSocket: canonicalPath(values.get('--broker-socket'), 'broker socket', { exact: FIXED_PATHS.brokerSocket, maximum: 104 }),
    brokerPolicy: canonicalPath(values.get('--broker-policy'), 'broker policy', { exact: FIXED_PATHS.brokerPolicy, maximum: 104 }),
    cgroup: canonicalPath(values.get('--cgroup'), 'trial cgroup', { below: '/sys/fs/cgroup', maximum: 512 }),
    workspace: canonicalPath(values.get('--workspace'), 'runtime workspace', { below: '/engineer-bounded', maximum: 512 }),
  });
}

export const parseRuntimeEvidenceArgv = parseRuntimeEvidenceArgs;

function validateEnvironment(environment) {
  if (!environment || typeof environment !== 'object') {
    fail('runtime evidence environment is invalid', 'ERR_RUNTIME_EVIDENCE_ENVIRONMENT');
  }
  let names;
  try {
    names = Object.keys(environment);
  } catch {
    fail('runtime evidence environment is invalid', 'ERR_RUNTIME_EVIDENCE_ENVIRONMENT');
  }
  if (names.length > Object.keys(SAFE_ENVIRONMENT).length
      || names.some((name) => !Object.hasOwn(SAFE_ENVIRONMENT, name))) {
    // Do not touch unknown values: production receives only the supervisor's
    // fixed support environment, and any extra name fails before value access.
    fail('runtime evidence environment is not the fixed support allowlist', 'ERR_RUNTIME_EVIDENCE_ENVIRONMENT');
  }
  for (const name of names) {
    const value = environment[name];
    if (typeof value !== 'string'
        || !SAFE_ENVIRONMENT[name].has(value)) {
      fail('runtime evidence support environment drifted', 'ERR_RUNTIME_EVIDENCE_ENVIRONMENT');
    }
  }
}

function validateRunnerResult(value) {
  exactKeys(value, ['exitCode', 'signal', 'startedAt', 'endedAt'], 'handoff runner result');
  integer(value.exitCode, 'runner exit code', 0, 255);
  boundedString(value.signal, 'runner signal', 32);
  if (!SAFE_SIGNAL.test(value.signal)) fail('runner signal is invalid');
  const started = instant(value.startedAt, 'runner startedAt');
  const ended = instant(value.endedAt, 'runner endedAt');
  if (ended < started || ended - started > MAX_RUNTIME_MS) fail('runner time window drifted');
  return { started, ended };
}

function validateTopology(value) {
  exactKeys(value, [
    'imageDigest', 'filesystemId', 'cgroupId', 'cgroupPathHash', 'harborExecutableHash',
    'cpuMax', 'memoryMax', 'pidsMax',
  ], 'handoff topology');
  if (!IMAGE_DIGEST.test(String(value.imageDigest))) fail('handoff image digest is invalid');
  safeId(value.filesystemId, 'handoff filesystem id');
  safeId(value.cgroupId, 'handoff cgroup id');
  digest(value.cgroupPathHash, 'handoff cgroup path hash');
  digest(value.harborExecutableHash, 'handoff Harbor executable hash');
  boundedString(value.cpuMax, 'handoff CPU limit', 64);
  if (!/^[1-9][0-9]{0,15} [1-9][0-9]{0,15}$/.test(value.cpuMax)) fail('handoff CPU limit is invalid');
  integer(value.memoryMax, 'handoff memory limit', 64 * 1024 * 1024, 10 * 1024 * 1024 * 1024);
  integer(value.pidsMax, 'handoff PID limit', 16, 65_535);
}

function validateProxy(value, topology) {
  exactKeys(value, [
    'eventsHash', 'eventsComplete', 'containerIdHash', 'imageDigest', 'policyCompliant',
  ], 'handoff proxy observation');
  digest(value.eventsHash, 'handoff Docker events hash');
  digest(value.containerIdHash, 'handoff container identity hash');
  if (value.imageDigest !== topology.imageDigest) fail('handoff proxy image identity drifted');
  boolean(value.eventsComplete, 'handoff Docker event completeness', true);
  boolean(value.policyCompliant, 'handoff Docker policy compliance', true);
}

function ipv4Integer(address) {
  if (!net.isIPv4(address)) return null;
  return address.split('.').reduce((value, octet) => ((value * 256) + Number(octet)) >>> 0, 0);
}

function ipv4CidrContains(address, network, bits) {
  const value = ipv4Integer(address);
  const base = ipv4Integer(network);
  if (value === null || base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6Integer(address) {
  if (!net.isIPv6(address) || address.includes('%')) return null;
  let source = address.toLowerCase();
  const embeddedV4 = source.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedV4) {
    const value = ipv4Integer(embeddedV4);
    if (value === null) return null;
    source = `${source.slice(0, -embeddedV4.length)}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[a-f0-9]{1,4}$/.test(word))) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function ipv6CidrContains(address, network, bits) {
  const value = ipv6Integer(address);
  const base = ipv6Integer(network);
  if (value === null || base === null || !Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  if (bits === 0) return true;
  const shift = BigInt(128 - bits);
  return (value >> shift) === (base >> shift);
}

function globallyRoutableProviderAddress(address) {
  if (net.isIPv4(address)) {
    const reserved = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return reserved.every(([network, bits]) => !ipv4CidrContains(address, network, bits));
  }
  return net.isIPv6(address)
    && ipv6CidrContains(address, '2000::', 3)
    && !ipv6CidrContains(address, '2001:db8::', 32);
}

function metadataDestination(address) {
  return net.isIPv4(address)
    ? ipv4CidrContains(address, '169.254.0.0', 16) || address === '100.100.100.200'
    : ipv6CidrContains(address, 'fe80::', 10) || ipv6CidrContains(address, 'fd00:ec2::254', 128);
}

function canonicalNetworkAddress(address) {
  if (net.isIPv4(address)) return address;
  const value = ipv6Integer(address);
  return value === null ? address : value.toString(16).padStart(32, '0');
}

function networkRuleSemantics(value) {
  const families = [
    {
      family: 4,
      chain: NETWORK_CHAIN_V4,
      metadata: value.metadataCidrs.filter((cidr) => net.isIPv4(cidr.split('/')[0])),
      providers: value.providerAddresses.ipv4,
      resolvers: value.dnsServers.filter(({ family }) => family === 4),
    },
    {
      family: 6,
      chain: NETWORK_CHAIN_V6,
      metadata: value.metadataCidrs.filter((cidr) => net.isIPv6(cidr.split('/')[0])),
      providers: value.providerAddresses.ipv6,
      resolvers: value.dnsServers.filter(({ family }) => family === 6),
    },
  ];
  return families.map((family) => ({
    family: family.family,
    chain: family.chain,
    rules: [
      ...family.metadata.map((cidr) => `reject-destination:${cidr}`),
      'accept-loopback',
      'accept-established',
      ...family.providers.map((address) =>
        `accept-provider:${value.brokerUid}:tcp:${canonicalNetworkAddress(address)}:${value.providerHttpsPort}:NEW`),
      ...family.resolvers.flatMap(({ address, port }) => ['udp', 'tcp'].map((protocol) =>
        `accept-dns:${value.brokerUid}:${protocol}:${canonicalNetworkAddress(address)}:${port}:NEW`)),
      `reject-owner:${value.runnerUid}`,
      `reject-owner:${value.brokerUid}`,
      'reject-all',
    ],
  }));
}

function networkRuleOrderHash(value) {
  return sha256(`engineer-runtime-network-rule-order.v1\0${canonicalJson(networkRuleSemantics(value))}`);
}

const NETWORK_POLICY_INPUT_FIELDS = Object.freeze([
  'runnerUid', 'brokerUid', 'providerHostname', 'providerHttpsPort',
  'providerAddresses', 'dnsServers', 'metadataCidrs', 'iptablesExecutableHash',
  'ip6tablesExecutableHash', 'producerExecutableHash', 'sandboxId', 'sandboxBootId',
  'requestHash', 'trialId', 'producerSessionId',
]);

function validateNetworkPolicyInput(input) {
  exactKeys(input, NETWORK_POLICY_INPUT_FIELDS, 'runtime network policy receipt input');
  const value = boundedClone(input, 'runtime network policy receipt input', MAX_HANDOFF_BYTES);
  if (value.runnerUid !== RUNNER_UID || value.brokerUid !== BROKER_UID
      || value.providerHostname !== EXACT_PROVIDER_HOSTNAME
      || value.providerHttpsPort !== EXACT_PROVIDER_HTTPS_PORT) {
    fail('runtime network policy identity drifted');
  }
  exactKeys(value.providerAddresses, ['ipv4', 'ipv6'], 'runtime network provider addresses');
  for (const [name, family] of [['ipv4', 4], ['ipv6', 6]]) {
    const addresses = value.providerAddresses[name];
    if (!Array.isArray(addresses)
        || addresses.length > 16
        || addresses.some((address) => net.isIP(address) !== family || !globallyRoutableProviderAddress(address))
        || new Set(addresses.map(canonicalNetworkAddress)).size !== addresses.length
        || canonicalJson(addresses) !== canonicalJson([...new Set(addresses)].sort())) {
      fail('runtime network provider destinations drifted');
    }
  }
  if (value.providerAddresses.ipv4.length + value.providerAddresses.ipv6.length < 1) {
    fail('runtime network provider destinations are empty');
  }
  if (!Array.isArray(value.dnsServers) || value.dnsServers.length < 1 || value.dnsServers.length > 8) {
    fail('runtime network DNS destinations drifted');
  }
  for (const server of value.dnsServers) {
    exactKeys(server, ['address', 'family', 'port'], 'runtime network DNS destination');
    if (![4, 6].includes(server.family)
        || net.isIP(server.address) !== server.family
        || server.address.includes('%')
        || server.port !== 53
        || metadataDestination(server.address)) {
      fail('runtime network DNS destination drifted');
    }
  }
  if (new Set(value.dnsServers.map((server) =>
    `${server.family}:${canonicalNetworkAddress(server.address)}:${server.port}`)).size !== value.dnsServers.length) {
    fail('runtime network DNS destinations are duplicated');
  }
  if (!Array.isArray(value.metadataCidrs)
      || canonicalJson(value.metadataCidrs) !== canonicalJson(EXACT_METADATA_CIDRS)) {
    fail('runtime network metadata destinations drifted');
  }
  for (const field of ['iptablesExecutableHash', 'ip6tablesExecutableHash', 'producerExecutableHash']) {
    digest(value[field], `runtime network ${field}`);
  }
  safeId(value.sandboxId, 'runtime network sandbox id');
  safeId(value.sandboxBootId, 'runtime network sandbox boot id');
  digest(value.requestHash, 'runtime network request hash');
  safeId(value.trialId, 'runtime network trial id');
  digest(value.producerSessionId, 'runtime network producer session id');
  return value;
}

export function createRuntimeNetworkPolicyReceipt(input) {
  const value = validateNetworkPolicyInput(input);
  return deepFreeze({
    schema: RUNTIME_NETWORK_POLICY_RECEIPT_SCHEMA,
    ...value,
    ruleOrderHash: networkRuleOrderHash(value),
  });
}

export function validateRuntimeNetworkPolicyReceipt(input) {
  const value = boundedClone(input, 'runtime network policy receipt', MAX_HANDOFF_BYTES);
  exactKeys(value, [
    'schema', ...NETWORK_POLICY_INPUT_FIELDS, 'ruleOrderHash',
  ], 'runtime network policy receipt');
  if (value.schema !== RUNTIME_NETWORK_POLICY_RECEIPT_SCHEMA) fail('runtime network policy receipt schema drifted');
  digest(value.ruleOrderHash, 'runtime network rule order hash');
  const unsigned = validateNetworkPolicyInput(Object.fromEntries(
    NETWORK_POLICY_INPUT_FIELDS.map((field) => [field, value[field]]),
  ));
  if (value.ruleOrderHash !== networkRuleOrderHash(unsigned)) {
    fail('runtime network rule order receipt drifted');
  }
  return deepFreeze(value);
}

function validateBroker(value, leaseHash, trialId) {
  exactKeys(value, [
    'leaseId', 'leaseDigest', 'leaseSequence', 'trialId', 'policyHash', 'bindingPolicyHash',
  ], 'handoff broker observation');
  safeId(value.leaseId, 'handoff broker lease id');
  digest(value.leaseDigest, 'handoff broker lease digest');
  integer(value.leaseSequence, 'handoff broker lease sequence', 1, 1_000_000);
  safeId(value.trialId, 'handoff broker trial id');
  digest(value.policyHash, 'handoff broker policy hash');
  digest(value.bindingPolicyHash, 'handoff broker binding policy hash');
  if (value.leaseDigest !== leaseHash || value.trialId !== trialId) {
    fail('handoff broker lease identity drifted');
  }
}

function unsignedHandoff(input) {
  exactKeys(input, HANDOFF_INPUT_FIELDS, 'runtime evidence handoff input');
  const value = boundedClone(input, 'runtime evidence handoff input', MAX_HANDOFF_BYTES);
  executionMode(value.executionMode);
  safeId(value.trialId, 'handoff trial id');
  digest(value.requestHash, 'handoff request hash');
  digest(value.leaseHash, 'handoff lease hash');
  if (value.requestHash === value.leaseHash) fail('handoff request and lease hashes must be distinct');
  const observed = instant(value.observedAt, 'handoff observedAt');
  const runner = validateRunnerResult(value.runnerResult);
  if (observed < runner.ended || observed - runner.ended > MAX_OBSERVATION_SKEW_MS) {
    fail('handoff observation falls outside the active runtime window');
  }
  validateTopology(value.topology);
  validateProxy(value.proxy, value.topology);
  const networkPolicy = validateRuntimeNetworkPolicyReceipt(value.networkPolicy);
  if (value.executionMode === CONTROLLED_PROVIDER) {
    validateBroker(value.broker, value.leaseHash, value.trialId);
  } else if (value.broker !== null) {
    fail('zero-provider handoff must prove no broker binding');
  }
  if (networkPolicy.requestHash !== value.requestHash
      || networkPolicy.trialId !== value.trialId) {
    fail('handoff network policy lifecycle binding drifted');
  }
  return value;
}

/** Create a canonical, hash-bound document suitable for inherited FD 3. */
export function createRuntimeEvidenceHandoff(input) {
  const unsigned = unsignedHandoff(input);
  const document = {
    schema: RUNTIME_EVIDENCE_HANDOFF_SCHEMA,
    ...unsigned,
    handoffHash: handoffDigest({ schema: RUNTIME_EVIDENCE_HANDOFF_SCHEMA, ...unsigned }),
  };
  return deepFreeze(document);
}

export function validateRuntimeEvidenceHandoff(input) {
  const value = boundedClone(input, 'runtime evidence handoff', MAX_HANDOFF_BYTES);
  exactKeys(value, HANDOFF_FIELDS, 'runtime evidence handoff');
  if (value.schema !== RUNTIME_EVIDENCE_HANDOFF_SCHEMA) fail('runtime evidence handoff schema drifted');
  digest(value.handoffHash, 'runtime evidence handoff hash');
  const unsigned = unsignedHandoff(Object.fromEntries(
    HANDOFF_INPUT_FIELDS.map((field) => [field, value[field]]),
  ));
  const expected = handoffDigest({ schema: value.schema, ...unsigned });
  if (!crypto.timingSafeEqual(Buffer.from(value.handoffHash, 'hex'), Buffer.from(expected, 'hex'))) {
    fail('runtime evidence handoff hash drifted');
  }
  return deepFreeze(value);
}

/** Canonical handoff bytes intentionally contain no trailing newline. */
export function encodeRuntimeEvidenceHandoff(input) {
  const value = Object.hasOwn(input ?? {}, 'handoffHash')
    ? validateRuntimeEvidenceHandoff(input)
    : createRuntimeEvidenceHandoff(input);
  return Buffer.from(canonicalJson(value), 'utf8');
}

/**
 * Requiring byte-for-byte canonical JSON rejects duplicate object keys,
 * alternate encodings, insignificant whitespace, and every trailing byte.
 */
export function parseRuntimeEvidenceHandoff(input) {
  const bytes = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(String(input ?? ''), 'utf8');
  try {
    if (bytes.length < 2 || bytes.length > MAX_HANDOFF_BYTES || bytes.includes(0)) {
      fail('runtime evidence handoff exceeds its framing bound', 'ERR_RUNTIME_EVIDENCE_HANDOFF');
    }
    const raw = bytes.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('runtime evidence handoff is not canonical JSON', 'ERR_RUNTIME_EVIDENCE_HANDOFF');
    }
    if (canonicalJson(parsed) !== raw) {
      fail('runtime evidence handoff contains duplicate keys or trailing bytes', 'ERR_RUNTIME_EVIDENCE_HANDOFF');
    }
    return validateRuntimeEvidenceHandoff(parsed);
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
    if (used > maximum) fail('runtime evidence handoff exceeds its byte bound', 'ERR_RUNTIME_EVIDENCE_HANDOFF');
    return Buffer.from(buffer.subarray(0, used));
  } finally {
    buffer.fill(0);
  }
}

/** Read and close the one fixed inherited descriptor exactly once. */
export function readRuntimeEvidenceHandoff({
  fd = RUNTIME_EVIDENCE_HANDOFF_FD,
  read = readFdBounded,
  inspect = (descriptor) => fs.fstatSync(descriptor),
  close = (descriptor) => fs.closeSync(descriptor),
} = {}) {
  if (fd !== RUNTIME_EVIDENCE_HANDOFF_FD) fail('runtime evidence handoff descriptor drifted', 'ERR_RUNTIME_EVIDENCE_HANDOFF');
  if (typeof read !== 'function' || typeof inspect !== 'function' || typeof close !== 'function') {
    throw new TypeError('runtime evidence handoff descriptor primitives are incomplete');
  }
  let bytes;
  try {
    const stat = inspect(fd);
    if (!stat || typeof stat.isFIFO !== 'function' || typeof stat.isSocket !== 'function'
        || (!stat.isFIFO() && !stat.isSocket())) {
      fail('runtime evidence handoff is not an inherited pipe or socket', 'ERR_RUNTIME_EVIDENCE_HANDOFF');
    }
    bytes = read(fd, MAX_HANDOFF_BYTES);
    if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') {
      fail('runtime evidence handoff reader returned invalid bytes', 'ERR_RUNTIME_EVIDENCE_HANDOFF');
    }
    return parseRuntimeEvidenceHandoff(bytes);
  } catch (error) {
    throw sanitizedFailure(error, 'runtime evidence handoff');
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    try { close(fd); } catch { /* descriptor custody remains fail-closed */ }
  }
}

function validatePrimitives(primitives) {
  if (!plainObject(primitives)) throw new TypeError('runtime evidence primitives must be a plain object');
  for (const name of REQUIRED_PRIMITIVES) {
    if (typeof primitives[name] !== 'function') throw new TypeError(`runtime evidence primitive ${name} is required`);
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

async function observeNow(primitives) {
  try {
    const raw = await primitives.now();
    const milliseconds = raw instanceof Date
      ? raw.getTime()
      : typeof raw === 'number'
        ? raw
        : Date.parse(String(raw));
    if (!Number.isFinite(milliseconds)) fail('runtime evidence clock is invalid');
    return new Date(Math.trunc(milliseconds)).toISOString();
  } catch (error) {
    throw sanitizedFailure(error, 'runtime evidence clock');
  }
}

function validateDaemonCustody(value, mode) {
  exactKeys(value, ['daemon', 'proxy', 'broker', 'brokerPolicy'], 'daemon custody evidence');
  const expected = {
    daemon: { kind: 'socket', ownerUid: 0, groupGid: 0, mode: 0o600 },
    proxy: { kind: 'socket', ownerUid: 0, groupGid: RUNNER_GID, mode: 0o660 },
    broker: { kind: 'socket', ownerUid: BROKER_UID, groupGid: BROKER_CLIENT_GID, mode: 0o660 },
    brokerPolicy: { kind: 'file', ownerUid: BROKER_UID, groupGid: BROKER_GID, mode: 0o600 },
  };
  for (const [name, policy] of Object.entries(expected)) {
    if (mode === ZERO_PROVIDER_CANARY && ['broker', 'brokerPolicy'].includes(name)) {
      exactKeys(value[name], ['exists'], `${name} absence`);
      boolean(value[name].exists, `${name} absence`, false);
      continue;
    }
    exactKeys(value[name], ['kind', 'real', 'ownerUid', 'groupGid', 'mode'], `${name} custody`);
    if (value[name].kind !== policy.kind
        || value[name].ownerUid !== policy.ownerUid
        || value[name].groupGid !== policy.groupGid
        || value[name].mode !== policy.mode) {
      fail('runtime daemon custody identity drifted');
    }
    boolean(value[name].real, `${name} path identity`, true);
  }
}

function validateHarbor(value, handoff) {
  exactKeys(value, ['completed', 'exitCode', 'executableHash'], 'Harbor evidence');
  boolean(value.completed, 'Harbor completion', true);
  integer(value.exitCode, 'Harbor exit code', 0, 255);
  digest(value.executableHash, 'Harbor executable hash');
  if (value.exitCode !== handoff.runnerResult.exitCode
      || value.executableHash !== handoff.topology.harborExecutableHash) {
    fail('Harbor evidence identity drifted');
  }
}

function validateDocker(value, handoff) {
  exactKeys(value, [
    'eventsHash', 'eventsComplete', 'containerIdHash', 'imageDigest', 'policyCompliant',
    'containersRemaining', 'networksRemaining', 'volumesRemaining',
  ], 'Docker evidence');
  digest(value.eventsHash, 'Docker events hash');
  digest(value.containerIdHash, 'Docker container identity hash');
  if (value.eventsHash !== handoff.proxy.eventsHash
      || value.containerIdHash !== handoff.proxy.containerIdHash
      || value.imageDigest !== handoff.topology.imageDigest
      || value.imageDigest !== handoff.proxy.imageDigest) {
    fail('Docker evidence identity drifted');
  }
  boolean(value.eventsComplete, 'Docker event completeness', true);
  boolean(value.policyCompliant, 'Docker policy compliance', true);
  if (value.eventsComplete !== handoff.proxy.eventsComplete
      || value.policyCompliant !== handoff.proxy.policyCompliant) {
    fail('Docker proxy evidence drifted');
  }
  for (const field of ['containersRemaining', 'networksRemaining', 'volumesRemaining']) {
    integer(value[field], `Docker ${field}`, 0, 0);
  }
}

function validateMounts(value, handoff) {
  exactKeys(value, [
    'inventoryHash', 'policyCompliant', 'outsideAllowedWrites',
    'daemonRootFilesystemId', 'workspaceFilesystemId',
  ], 'mount evidence');
  digest(value.inventoryHash, 'mount inventory hash');
  boolean(value.policyCompliant, 'mount policy compliance', true);
  boolean(value.outsideAllowedWrites, 'outside-allowlist writes', false);
  if (value.daemonRootFilesystemId !== handoff.topology.filesystemId
      || value.workspaceFilesystemId !== handoff.topology.filesystemId) {
    fail('mount filesystem identity drifted');
  }
}

function validateCgroup(value, handoff, options) {
  exactKeys(value, [
    'evidenceHash', 'id', 'pathHash', 'populated', 'processesRemaining', 'limitsEnforced',
  ], 'cgroup evidence');
  digest(value.evidenceHash, 'cgroup evidence hash');
  if (value.id !== handoff.topology.cgroupId
      || value.id !== path.posix.basename(options.cgroup)
      || value.pathHash !== handoff.topology.cgroupPathHash) {
    fail('cgroup final identity drifted');
  }
  digest(value.pathHash, 'cgroup path hash');
  boolean(value.populated, 'cgroup population', false);
  integer(value.processesRemaining, 'cgroup processes remaining', 0, 0);
  boolean(value.limitsEnforced, 'cgroup limits', true);
}

function validateResources(value) {
  exactKeys(value, [
    'evidenceHash', 'cpuWithinLimit', 'memoryWithinLimit', 'pidsWithinLimit', 'oomKilled',
  ], 'resource evidence');
  digest(value.evidenceHash, 'resource evidence hash');
  for (const field of ['cpuWithinLimit', 'memoryWithinLimit', 'pidsWithinLimit']) {
    boolean(value[field], `resource ${field}`, true);
  }
  boolean(value.oomKilled, 'resource OOM state', false);
}

function validateNetwork(value) {
  exactKeys(value, [
    'evidenceHash', 'taskNetworkNone', 'runnerEgressDenied', 'brokerOnlyEgress',
    'metadataDenied', 'rawSocketDenied',
  ], 'network evidence');
  digest(value.evidenceHash, 'network evidence hash');
  for (const field of [
    'taskNetworkNone', 'runnerEgressDenied', 'brokerOnlyEgress', 'metadataDenied', 'rawSocketDenied',
  ]) boolean(value[field], `network ${field}`, true);
}

function validateProvider(value, handoff, options) {
  if (handoff.executionMode === ZERO_PROVIDER_CANARY) {
    exactKeys(value, [
      'mode', 'requestHash', 'leaseHash', 'usageHash', 'identityHash', 'spendMicrousd',
      'billingCertain', 'budgetComplete', 'withinTrialCeiling', 'attempts', 'calls',
      'brokerAbsent',
    ], 'zero-provider evidence');
    if (value.mode !== 'not-exercised'
        || value.requestHash !== options.requestHash
        || value.requestHash !== handoff.requestHash
        || value.leaseHash !== options.leaseHash
        || value.leaseHash !== handoff.leaseHash
        || handoff.broker !== null) {
      fail('zero-provider evidence binding drifted');
    }
    const expectedUsageHash = sha256(canonicalJson({
      schema: 'engineer-runtime-zero-provider-usage.v1',
      executionMode: ZERO_PROVIDER_CANARY,
      attempts: 0,
      calls: 0,
      spendMicrousd: 0,
    }));
    const expectedIdentityHash = sha256(canonicalJson({
      schema: 'engineer-runtime-zero-provider-identity.v1',
      executionMode: ZERO_PROVIDER_CANARY,
      requestHash: value.requestHash,
      leaseHash: value.leaseHash,
      brokerAbsent: true,
    }));
    if (value.usageHash !== expectedUsageHash || value.identityHash !== expectedIdentityHash) {
      fail('zero-provider evidence identity drifted');
    }
    integer(value.spendMicrousd, 'zero-provider spend', 0, 0);
    integer(value.attempts, 'zero-provider attempt count', 0, 0);
    integer(value.calls, 'zero-provider call count', 0, 0);
    boolean(value.brokerAbsent, 'zero-provider broker absence', true);
    for (const field of ['billingCertain', 'budgetComplete', 'withinTrialCeiling']) {
      boolean(value[field], `zero-provider ${field}`, true);
    }
    return;
  }

  exactKeys(value, [
    'requestHash', 'leaseHash', 'usageHash', 'identityHash', 'spendMicrousd',
    'billingCertain', 'budgetComplete', 'withinTrialCeiling', 'attempts',
  ], 'provider evidence');
  if (value.requestHash !== options.requestHash
      || value.requestHash !== handoff.requestHash
      || value.leaseHash !== options.leaseHash
      || value.leaseHash !== handoff.leaseHash
      || value.leaseHash !== handoff.broker.leaseDigest) {
    fail('provider evidence binding drifted');
  }
  digest(value.usageHash, 'provider usage hash');
  digest(value.identityHash, 'provider identity hash');
  integer(value.spendMicrousd, 'provider spend', 0, 20_000_000);
  integer(value.attempts, 'provider attempt count', 0, 100_000);
  if (value.spendMicrousd > 0 && value.attempts === 0) fail('provider spend has no attempt evidence');
  for (const field of ['billingCertain', 'budgetComplete', 'withinTrialCeiling']) {
    boolean(value[field], `provider ${field}`, true);
  }
}

function validateCleanup(value, docker, cgroup) {
  exactKeys(value, [
    'completed', 'containersRemaining', 'networksRemaining', 'volumesRemaining',
    'processesRemaining', 'cgroupPopulated',
  ], 'cleanup evidence');
  boolean(value.completed, 'cleanup completion', true);
  boolean(value.cgroupPopulated, 'cleanup cgroup population', false);
  for (const field of [
    'containersRemaining', 'networksRemaining', 'volumesRemaining', 'processesRemaining',
  ]) integer(value[field], `cleanup ${field}`, 0, 0);
  if (value.containersRemaining !== docker.containersRemaining
      || value.networksRemaining !== docker.networksRemaining
      || value.volumesRemaining !== docker.volumesRemaining
      || value.processesRemaining !== cgroup.processesRemaining
      || value.cgroupPopulated !== cgroup.populated) {
    fail('cleanup evidence disagrees with runtime inventories');
  }
}

/** Collect exactly the final evidence shape validated by supervisor.mjs. */
export async function collectRuntimeEvidence({
  argv = process.argv.slice(2),
  environment = process.env,
  primitives = createNodeRuntimeEvidencePrimitives(),
} = {}) {
  const options = parseRuntimeEvidenceArgs(argv);
  validateEnvironment(environment);
  const source = validatePrimitives(primitives);
  const [platform, effectiveUid] = await Promise.all([
    invoke(source, 'platform'),
    invoke(source, 'effectiveUid'),
  ]);
  if (platform !== 'linux') fail('runtime evidence requires Linux', 'ERR_RUNTIME_EVIDENCE_PLATFORM');
  if (effectiveUid !== 0) fail('runtime evidence requires effective root', 'ERR_RUNTIME_EVIDENCE_PLATFORM');

  const rawHandoff = await invoke(source, 'readHandoff', {
    fd: RUNTIME_EVIDENCE_HANDOFF_FD,
    maxBytes: MAX_HANDOFF_BYTES,
  });
  const handoff = validateRuntimeEvidenceHandoff(rawHandoff);
  if (handoff.requestHash !== options.requestHash || handoff.leaseHash !== options.leaseHash) {
    fail('runtime evidence handoff binding drifted');
  }
  if (handoff.topology.cgroupId !== path.posix.basename(options.cgroup)) {
    fail('runtime evidence cgroup identity drifted');
  }

  const common = {
    ...options,
    handoff,
    runnerUid: RUNNER_UID,
    runnerGid: RUNNER_GID,
    brokerUid: BROKER_UID,
    brokerGid: BROKER_GID,
    brokerClientGid: BROKER_CLIENT_GID,
    maxOutputBytes: MAX_EVIDENCE_BYTES,
  };
  const [daemonCustody, harbor, docker, mounts, cgroup, resources, network, provider, endedAt] = await Promise.all([
    invoke(source, 'inspectDaemonCustody', common),
    invoke(source, 'inspectHarbor', common),
    invoke(source, 'inspectDocker', common),
    invoke(source, 'inspectMounts', common),
    invoke(source, 'inspectCgroup', common),
    invoke(source, 'inspectResources', common),
    invoke(source, 'inspectNetwork', common),
    invoke(source, 'inspectProvider', common),
    observeNow(source),
  ]);

  validateDaemonCustody(daemonCustody, handoff.executionMode);
  validateHarbor(harbor, handoff);
  validateDocker(docker, handoff);
  validateMounts(mounts, handoff);
  validateCgroup(cgroup, handoff, options);
  validateResources(resources);
  validateNetwork(network);
  validateProvider(provider, handoff, options);
  const cleanup = await invoke(source, 'inspectCleanup', { ...common, docker, cgroup });
  validateCleanup(cleanup, docker, cgroup);
  const observedAt = instant(handoff.observedAt, 'handoff observedAt');
  const ended = instant(endedAt, 'runtime evidence endedAt');
  if (ended < observedAt || ended - observedAt > MAX_OBSERVATION_SKEW_MS) {
    fail('runtime evidence collection fell outside the active observation window');
  }

  const result = {
    startedAt: handoff.runnerResult.startedAt,
    endedAt,
    harbor,
    docker,
    mounts,
    cgroup,
    resources,
    network,
    provider: handoff.executionMode === ZERO_PROVIDER_CANARY
      ? { ...provider }
      : {
        usageHash: provider.usageHash,
        identityHash: provider.identityHash,
        spendMicrousd: provider.spendMicrousd,
        billingCertain: provider.billingCertain,
        budgetComplete: provider.budgetComplete,
        withinTrialCeiling: provider.withinTrialCeiling,
        attempts: provider.attempts,
      },
    cleanup,
  };
  const encoded = canonicalJson(result);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_EVIDENCE_BYTES) fail('runtime evidence output exceeds its byte bound');
  credentialFree(result, 'runtime evidence output');
  return deepFreeze(result);
}

function sameInode(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
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

function readProtectedCanonicalReceipt(target, maximum = MAX_KERNEL_FILE_BYTES) {
  if (![TASK_MOUNT_RECEIPT, TASK_ISOLATION_RECEIPT].includes(target)
      || !Number.isSafeInteger(maximum) || maximum < 2 || maximum > MAX_KERNEL_FILE_BYTES) {
    throw new Error('task receipt path escaped its fixed bound');
  }
  const directory = path.posix.dirname(target);
  const name = path.posix.basename(target);
  const directoryFd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let fileFd;
  let bytes;
  try {
    const directoryStat = fs.fstatSync(directoryFd);
    if (!directoryStat.isDirectory()
        || fs.realpathSync.native(directory) !== directory
        || directoryStat.uid !== 0 || directoryStat.gid !== 0
        || (directoryStat.mode & 0o777) !== 0o700) {
      throw new Error('task receipt directory custody drifted');
    }
    fileFd = fs.openSync(
      `/proc/self/fd/${directoryFd}/${name}`,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const before = fs.fstatSync(fileFd, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.gid !== 0n
        || (Number(before.mode) & 0o777) !== 0o600 || before.nlink !== 1n
        || before.size < 2n || before.size > BigInt(maximum)) {
      throw new Error('task receipt file custody drifted');
    }
    bytes = Buffer.alloc(Number(before.size));
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fileFd, bytes, used, bytes.length - used, used);
      if (count < 1) throw new Error('task receipt ended during its bound read');
      used += count;
    }
    const after = fs.fstatSync(fileFd, { bigint: true });
    if (!sameInode(before, after) || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('task receipt changed during its bound read');
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0')) {
      throw new Error('task receipt is not canonical UTF-8');
    }
    const parsed = JSON.parse(text);
    if (!plainObject(parsed) || canonicalJson(parsed) !== text) {
      throw new Error('task receipt is not canonical JSON');
    }
    credentialFree(parsed, 'task receipt');
    return parsed;
  } finally {
    bytes?.fill(0);
    if (fileFd !== undefined) fs.closeSync(fileFd);
    fs.closeSync(directoryFd);
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
  const cpuMax = readBoundKernelFile(pathname, 'cpu.max', maximum).trim();
  const memoryMax = parseSingleInteger(readBoundKernelFile(pathname, 'memory.max', maximum), 'memory.max');
  const memoryPeak = parseSingleInteger(readBoundKernelFile(pathname, 'memory.peak', maximum), 'memory.peak');
  const pidsMax = parseSingleInteger(readBoundKernelFile(pathname, 'pids.max', maximum), 'pids.max');
  const pidsPeak = parseSingleInteger(readBoundKernelFile(pathname, 'pids.peak', maximum), 'pids.peak');
  const memoryEvents = parseKeyValueLines(readBoundKernelFile(pathname, 'memory.events', maximum), 'memory events');
  const cpuStat = parseKeyValueLines(readBoundKernelFile(pathname, 'cpu.stat', maximum), 'CPU statistics');
  return {
    real: true,
    id: path.posix.basename(pathname),
    populated: events.populated === 1,
    processIds,
    cpuMax,
    memoryMax,
    memoryPeak,
    pidsMax,
    pidsPeak,
    oomKills: memoryEvents.oom_kill ?? 0,
    cpuUsageUsec: cpuStat.usage_usec ?? 0,
  };
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

function statFilesystem(target) {
  let inspectedTarget = target;
  try {
    const identity = inspectRealPath(inspectedTarget);
    if (!identity.exists || !['directory', 'file'].includes(identity.kind)) throw new Error('filesystem target is unavailable');
  } catch (error) {
    if (error?.code !== 'ENOENT' && target !== '/engineer-bounded/work') throw error;
    if (target !== '/engineer-bounded/work') throw error;
    inspectedTarget = '/engineer-bounded';
    const parent = inspectRealPath(inspectedTarget);
    if (!parent.exists || parent.kind !== 'directory') throw new Error('bounded workspace parent is unavailable');
  }
  const stat = fs.statSync(inspectedTarget, { bigint: true });
  const filesystem = fs.statfsSync(inspectedTarget, { bigint: true });
  const bytes = filesystem.bsize * filesystem.blocks;
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('filesystem size exceeds evidence bounds');
  return { id: `dev:${stat.dev.toString(16)}`, bytes: Number(bytes), real: true };
}

function openThroughStableParent(target, expectedParentUid) {
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
        || stat.uid !== expectedParentUid
        || (stat.mode & 0o022) !== 0) {
      throw new Error('protected runtime parent custody drifted');
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

function readProtectedRegularFile(target, { maximum, uid, gid, mode }) {
  const before = fs.lstatSync(target);
  if (fs.realpathSync.native(target) !== target
      || before.isSymbolicLink()
      || !before.isFile()
      || before.uid !== uid
      || before.gid !== gid
      || (before.mode & 0o7777) !== mode
      || before.size < 1
      || before.size > maximum) {
    throw new Error('protected runtime file custody drifted');
  }
  const { descriptor, parentFd } = openThroughStableParent(target, uid);
  const bytes = Buffer.alloc(before.size);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameInode(before, opened) || opened.size !== before.size) throw new Error('protected runtime file raced before reading');
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('protected runtime file changed while reading');
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (!sameInode(opened, after) || after.size !== opened.size) throw new Error('protected runtime file raced while reading');
    return bytes;
  } finally {
    fs.closeSync(descriptor);
    fs.closeSync(parentFd);
  }
}

function attestBrokerPolicy(target) {
  const bytes = readProtectedRegularFile(target, {
    maximum: MAX_POLICY_BYTES,
    uid: BROKER_UID,
    gid: BROKER_GID,
    mode: 0o600,
  });
  try {
    const policy = JSON.parse(bytes.toString('utf8'));
    const cloned = boundedClone(policy, 'broker policy', MAX_POLICY_BYTES);
    return {
      policyHash: providerBrokerStaticPolicyHash(cloned),
      bindingPolicyHash: sha256(canonicalJson(cloned)),
      policy: cloned,
    };
  } finally {
    bytes.fill(0);
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
  const { descriptor, parentFd } = openThroughStableParent(file, 0);
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

function runFixedCommand({ file, args, timeoutMs, maxOutputBytes }) {
  if (![FIXED_DOCKER, FIXED_IPTABLES, FIXED_IP6TABLES].includes(file)
      || !Array.isArray(args)
      || args.length > 32
      || args.some((value) => typeof value !== 'string' || value.length > 512 || value.includes('\0'))
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > 10_000
      || !Number.isSafeInteger(maxOutputBytes)
      || maxOutputBytes < 1
      || maxOutputBytes > MAX_COMMAND_BYTES) {
    throw new Error('read-only inventory command escaped its fixed contract');
  }
  const result = spawnSync(file, args, {
    cwd: '/',
    env: { LANG: 'C.UTF-8' },
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error('read-only inventory command failed');
  if (typeof result.stdout !== 'string'
      || Buffer.byteLength(result.stdout, 'utf8') > maxOutputBytes
      || typeof result.stderr !== 'string'
      || Buffer.byteLength(result.stderr, 'utf8') > maxOutputBytes) {
    throw new Error('read-only inventory output exceeded its byte bound');
  }
  return { exitCode: result.status, signal: result.signal ?? 'none', stdout: result.stdout };
}

function outputLines(text, label, maximum = MAX_COMMAND_BYTES) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maximum || text.includes('\0')) {
    throw new Error(`${label} exceeded its byte bound`);
  }
  const lines = text.trim() === '' ? [] : text.trim().split('\n');
  if (lines.length > 4_096 || lines.some((line) => line.length > 2_048)) {
    throw new Error(`${label} exceeded its structure bound`);
  }
  return lines;
}

function normalizeNetworkRuleTokens(line) {
  const aliases = new Map([
    ['--destination', '-d'], ['--jump', '-j'], ['--match', '-m'],
    ['--out-interface', '-o'], ['--protocol', '-p'],
  ]);
  return line.trim().split(/\s+/).map((token) => aliases.get(token) ?? token);
}

function normalizeObservedDestination(value) {
  if (net.isIP(value)) return canonicalNetworkAddress(value);
  const match = String(value).match(/^(.+)\/(32|128)$/);
  if (match && ((match[2] === '32' && net.isIPv4(match[1])) || (match[2] === '128' && net.isIPv6(match[1])))) {
    return canonicalNetworkAddress(match[1]);
  }
  return value;
}

function parseObservedNetworkRule(line, chain) {
  const tokens = normalizeNetworkRuleTokens(line);
  if (tokens[0] !== '-A' || tokens[1] !== chain) throw new Error('network policy contains a foreign rule');
  const rest = tokens.slice(2);
  if (canonicalJson(rest) === canonicalJson(['-o', 'lo', '-j', 'ACCEPT'])) return 'accept-loopback';
  if (canonicalJson(rest) === canonicalJson(['-j', 'REJECT'])) return 'reject-all';

  const values = { modules: [] };
  const single = new Set();
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (value === undefined || !['-m', '-p', '-d', '--uid-owner', '--dport', '--ctstate', '-j'].includes(option)) {
      throw new Error('network policy rule escaped its exact grammar');
    }
    if (option === '-m') {
      if (!['owner', 'tcp', 'udp', 'conntrack'].includes(value) || values.modules.includes(value)) {
        throw new Error('network policy module inventory drifted');
      }
      values.modules.push(value);
    } else {
      if (single.has(option)) throw new Error('network policy rule duplicated an option');
      single.add(option);
      values[option] = value;
    }
  }
  const modules = [...values.modules].sort();
  const rawDestination = values['-d'];
  const destination = normalizeObservedDestination(rawDestination);
  const only = (...keys) => [...single].every((key) => keys.includes(key));
  if (values['-j'] === 'REJECT'
      && modules.length === 0
      && only('-d', '-j')
      && rawDestination !== undefined) {
    return `reject-destination:${rawDestination}`;
  }
  if (values['-j'] === 'ACCEPT'
      && canonicalJson(modules) === canonicalJson(['conntrack'])
      && values['--ctstate'] === 'ESTABLISHED'
      && only('--ctstate', '-j')) {
    return 'accept-established';
  }
  if (values['-j'] === 'REJECT'
      && canonicalJson(modules) === canonicalJson(['owner'])
      && /^(?:2001|2002)$/.test(String(values['--uid-owner']))
      && only('--uid-owner', '-j')) {
    return `reject-owner:${values['--uid-owner']}`;
  }
  const protocol = values['-p'];
  const expectedModules = ['conntrack', 'owner', protocol].sort();
  if (values['-j'] !== 'ACCEPT'
      || !['tcp', 'udp'].includes(protocol)
      || canonicalJson(modules) !== canonicalJson(expectedModules)
      || values['--uid-owner'] !== String(BROKER_UID)
      || values['--ctstate'] !== 'NEW'
      || destination === undefined
      || !only('-p', '-d', '--uid-owner', '--dport', '--ctstate', '-j')) {
    throw new Error('network policy contains an unrecognized verdict rule');
  }
  if (protocol === 'tcp' && values['--dport'] === String(EXACT_PROVIDER_HTTPS_PORT)) {
    return `accept-provider:${BROKER_UID}:tcp:${destination}:${EXACT_PROVIDER_HTTPS_PORT}:NEW`;
  }
  if (values['--dport'] === '53') {
    return `accept-dns:${BROKER_UID}:${protocol}:${destination}:53:NEW`;
  }
  throw new Error('network policy contains an unapproved destination');
}

export function validateRuntimeNetworkRuleInventory(receiptInput, inventoryInput) {
  const receipt = validateRuntimeNetworkPolicyReceipt(receiptInput);
  const inventory = boundedClone(inventoryInput, 'runtime network rule inventory', MAX_COMMAND_BYTES * 4);
  exactKeys(inventory, ['ipv4', 'ipv6'], 'runtime network rule inventory');
  const expected = networkRuleSemantics(receipt);
  const observed = expected.map((family) => {
    const key = family.family === 4 ? 'ipv4' : 'ipv6';
    exactKeys(inventory[key], ['output', 'chain'], `runtime network ${key} inventory`);
    const output = outputLines(inventory[key].output, `${key} OUTPUT rules`);
    const outputRules = output.filter((line) => line.startsWith('-A OUTPUT '));
    const attachment = `-A OUTPUT -j ${family.chain}`;
    if (outputRules[0] !== attachment || outputRules.filter((line) => line === attachment).length !== 1) {
      throw new Error('network policy chain is not the first unique OUTPUT verdict');
    }
    const chainLines = outputLines(inventory[key].chain, `${key} policy chain`);
    if (chainLines.some((line) => line !== `-N ${family.chain}` && !line.startsWith(`-A ${family.chain} `))) {
      throw new Error('network policy chain inventory contains an unknown line');
    }
    const rules = chainLines
      .filter((line) => line.startsWith(`-A ${family.chain} `))
      .map((line) => parseObservedNetworkRule(line, family.chain));
    return { family: family.family, chain: family.chain, rules };
  });
  if (canonicalJson(observed) !== canonicalJson(expected)
      || networkRuleOrderHash(receipt) !== receipt.ruleOrderHash) {
    throw new Error('network policy rule order or destination set drifted');
  }
  return deepFreeze(observed);
}

async function observeNetworkPolicy(receiptInput, runCommand = runFixedCommand) {
  const receipt = validateRuntimeNetworkPolicyReceipt(receiptInput);
  const families = [
    { key: 'ipv4', file: FIXED_IPTABLES, chain: NETWORK_CHAIN_V4 },
    { key: 'ipv6', file: FIXED_IP6TABLES, chain: NETWORK_CHAIN_V6 },
  ];
  const inventory = [];
  for (const family of families) {
    const base = { file: family.file, timeoutMs: 5_000, maxOutputBytes: MAX_COMMAND_BYTES, shell: false };
    const output = await runCommand({ ...base, args: ['--wait', '5', '--list-rules', 'OUTPUT'] });
    const chain = await runCommand({ ...base, args: ['--wait', '5', '--list-rules', family.chain] });
    if (output.exitCode !== 0 || chain.exitCode !== 0) throw new Error('network policy inventory command failed');
    inventory.push({ key: family.key, file: family.file, output: output.stdout, chain: chain.stdout });
  }
  validateRuntimeNetworkRuleInventory(receipt, Object.fromEntries(
    inventory.map(({ key, output, chain }) => [key, { output, chain }]),
  ));
  return {
    evidenceHash: sha256(`engineer-runtime-network-rules.v1\0${canonicalJson(inventory)}`),
    runnerEgressDenied: true,
    brokerOnlyEgress: true,
    metadataDenied: true,
    rawSocketDenied: true,
  };
}

function nodeEvidenceSystem(overrides) {
  if (!plainObject(overrides)) throw new TypeError('runtime evidence system overrides must be a plain object');
  const system = {
    async inspectPath({ path: target }) { return inspectRealPath(target); },
    async attestBrokerPolicy({ path: target }) { return attestBrokerPolicy(target); },
    async hashExecutable({ file, maxBytes }) { return hashProtectedExecutable(file, maxBytes); },
    async runCommand(spec) { return runFixedCommand(spec); },
    async statFilesystem({ path: target }) { return statFilesystem(target); },
    async readTaskMountReceipt({ file, maxBytes }) {
      try {
        return readProtectedCanonicalReceipt(file, maxBytes);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        missingEvidenceProducer(
          'TASK_MOUNT_RECEIPT',
          `the task mount namespace has no authenticated receipt producer at ${TASK_MOUNT_RECEIPT}`,
        );
      }
    },
    async readTaskIsolationReceipt({ file, maxBytes }) {
      try {
        return readProtectedCanonicalReceipt(file, maxBytes);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        missingEvidenceProducer(
          'TASK_ISOLATION_RECEIPT',
          `the task network namespace and raw-socket canary have no authenticated receipt producer at ${TASK_ISOLATION_RECEIPT}`,
        );
      }
    },
    async readBootId() { return readBoundKernelFile('/proc/sys/kernel/random', 'boot_id', 128).trim(); },
    async observeCgroup({ path: target, maxBytes }) { return observeCgroup(target, maxBytes); },
    async observeNetworkPolicy({ receipt }) { return observeNetworkPolicy(receipt); },
    async observeSocketProcess({ socketPath }) { return observeSocketProcess(socketPath); },
    async requestBrokerEvidence({ socketPath, timeoutMs, maxFrameBytes }) {
      return requestProviderBrokerEvidence({ socketPath, timeoutMs, maxFrameBytes });
    },
    ...overrides,
  };
  for (const name of [
    'inspectPath', 'attestBrokerPolicy', 'hashExecutable', 'runCommand', 'statFilesystem',
    'readTaskMountReceipt', 'readTaskIsolationReceipt', 'readBootId', 'observeCgroup',
    'observeNetworkPolicy', 'observeSocketProcess',
    'requestBrokerEvidence',
  ]) {
    if (typeof system[name] !== 'function') throw new TypeError(`runtime evidence system method ${name} is required`);
  }
  return system;
}

function inventoryCount(output, label, pattern) {
  const lines = outputLines(output, label);
  if (new Set(lines).size !== lines.length || lines.some((line) => !pattern.test(line))) {
    throw new Error(`${label} contains malformed or duplicate identities`);
  }
  return lines.length;
}

function validateObservedCgroup(observed, spec) {
  const topology = spec.handoff.topology;
  if (!plainObject(observed)
      || observed.real !== true
      || observed.id !== topology.cgroupId
      || observed.populated !== false
      || !Array.isArray(observed.processIds)
      || observed.processIds.length !== 0
      || observed.cpuMax !== topology.cpuMax
      || observed.memoryMax !== topology.memoryMax
      || observed.pidsMax !== topology.pidsMax
      || !Number.isSafeInteger(observed.memoryPeak)
      || observed.memoryPeak < 0
      || !Number.isSafeInteger(observed.pidsPeak)
      || observed.pidsPeak < 0
      || !Number.isSafeInteger(observed.oomKills)
      || observed.oomKills < 0
      || !Number.isSafeInteger(observed.cpuUsageUsec)
      || observed.cpuUsageUsec < 0) {
    fail('final kernel cgroup inventory drifted');
  }
  return observed;
}

function usdPico(value, label, maximumUsd = 20) {
  if (typeof value !== 'number'
      || !Number.isFinite(value)
      || Object.is(value, -0)
      || value < 0
      || value > maximumUsd) {
    fail(`${label} is outside its USD bound`);
  }
  const fixed = value.toFixed(12);
  if (Number(fixed) !== value) fail(`${label} exceeds twelve-decimal USD precision`);
  const [whole, fraction] = fixed.split('.');
  return BigInt(whole) * 1_000_000_000_000n + BigInt(fraction);
}

function roundPositiveRatio(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function pricedTokenCostPico({ inputTokens, cachedTokens, outputTokens }, pricing) {
  const inputPrice = usdPico(pricing.inputPerM, 'provider input price', 1_000);
  const cachedPrice = usdPico(pricing.cachedInputPerM, 'provider cached-input price', 1_000);
  const outputPrice = usdPico(pricing.outputPerM, 'provider output price', 1_000);
  const numerator = BigInt(inputTokens - cachedTokens) * inputPrice
    + BigInt(cachedTokens) * cachedPrice
    + BigInt(outputTokens) * outputPrice;
  return roundPositiveRatio(numerator, 1_000_000n);
}

function reconcileProviderEvidence(evidence, spec, rawTrustedPolicy) {
  if (!plainObject(evidence)
      || !HASH.test(String(evidence.snapshotHash))
      || !plainObject(evidence.snapshot)) {
    fail('provider broker evidence response is malformed');
  }
  const snapshot = boundedClone(evidence.snapshot, 'provider broker snapshot', MAX_EVIDENCE_BYTES);
  if (providerBrokerEvidenceHash(snapshot) !== evidence.snapshotHash) {
    fail('provider broker evidence hash drifted');
  }
  const trustedPolicy = boundedClone(rawTrustedPolicy, 'protected provider policy', MAX_POLICY_BYTES);
  let trustedStaticHash;
  try { trustedStaticHash = providerBrokerStaticPolicyHash(trustedPolicy); } catch {
    fail('protected provider policy is malformed');
  }
  const trustedBindingHash = sha256(canonicalJson(trustedPolicy));
  exactKeys(snapshot, ['version', 'state', 'policy', 'session', 'trials', 'attempts'], 'provider broker snapshot');
  if (snapshot.version !== 1 || snapshot.state !== 'running'
      || !plainObject(snapshot.policy)
      || trustedStaticHash !== spec.handoff.broker.policyHash
      || trustedBindingHash !== spec.handoff.broker.bindingPolicyHash
      || snapshot.policy.policyHash !== trustedStaticHash
      || snapshot.policy.bindingPolicyHash !== trustedBindingHash
      || !plainObject(snapshot.session)
      || !Array.isArray(snapshot.trials)
      || snapshot.trials.length !== 1
      || !Array.isArray(snapshot.attempts)
      || snapshot.attempts.length > 100_000) {
    fail('provider broker snapshot identity drifted');
  }
  exactKeys(snapshot.policy, [
    'policyHash', 'bindingPolicyHash', 'endpointHash', 'model', 'providerEndpointTag',
    'expectedResolvedProvider', 'settings', 'maxTokens', 'pricing',
  ], 'provider broker policy evidence');
  digest(snapshot.policy.endpointHash, 'provider endpoint hash');
  boundedString(snapshot.policy.model, 'provider model', 256);
  boundedString(snapshot.policy.providerEndpointTag, 'provider endpoint tag', 128);
  boundedString(snapshot.policy.expectedResolvedProvider, 'resolved provider identity', 128);
  integer(snapshot.policy.maxTokens, 'provider max tokens', 1, 1_000_000);
  if (!plainObject(snapshot.policy.settings)
      || !plainObject(snapshot.policy.pricing)
      || snapshot.policy.endpointHash !== sha256(trustedPolicy.endpoint)
      || snapshot.policy.model !== trustedPolicy.model
      || snapshot.policy.providerEndpointTag !== trustedPolicy.provider?.order?.[0]
      || snapshot.policy.expectedResolvedProvider !== trustedPolicy.provider?.expectedResolvedNames?.[0]
      || snapshot.policy.maxTokens !== trustedPolicy.maxTokens
      || canonicalJson(snapshot.policy.settings) !== canonicalJson(trustedPolicy.settings)
      || canonicalJson(snapshot.policy.pricing) !== canonicalJson(trustedPolicy.pricing)) {
    fail('provider policy metadata is malformed');
  }
  exactKeys(snapshot.session, [
    'ceilingUsd', 'knownActualUsd', 'uncertainReservedUsd', 'activeReservedUsd',
    'accountedExposureUsd', 'breached', 'blocked',
  ], 'provider broker session evidence');
  const trial = snapshot.trials[0];
  const trustedTrial = Array.isArray(trustedPolicy.trials) && trustedPolicy.trials.length === 1
    ? trustedPolicy.trials[0]
    : null;
  if (!plainObject(trial)
      || !plainObject(trustedTrial)
      || trial.leaseId !== spec.handoff.broker.leaseId
      || trial.leaseDigest !== spec.leaseHash
      || trial.trialId !== spec.handoff.broker.trialId
      || trial.leaseSequence !== spec.handoff.broker.leaseSequence
      || canonicalJson({
        leaseId: trial.leaseId,
        leaseDigest: trial.leaseDigest,
        trialId: trial.trialId,
        leaseSequence: trial.leaseSequence,
        ceilingUsd: trial.ceilingUsd,
      }) !== canonicalJson(trustedTrial)) {
    fail('provider broker trial binding drifted');
  }
  exactKeys(trial, [
    'leaseId', 'leaseDigest', 'trialId', 'leaseSequence', 'ceilingUsd', 'nextSequence',
    'knownActualUsd', 'uncertainReservedUsd', 'activeReservedUsd', 'accountedExposureUsd',
    'breached', 'blocked',
  ], 'provider broker trial evidence');
  const session = snapshot.session;
  const trialCeiling = usdPico(trial.ceilingUsd, 'trial ceiling');
  const sessionCeiling = usdPico(session.ceilingUsd, 'session ceiling');
  if (trialCeiling !== usdPico(trustedTrial.ceilingUsd, 'protected trial ceiling')
      || sessionCeiling !== usdPico(trustedPolicy.sessionCeilingUsd, 'protected session ceiling')
      || sessionCeiling < trialCeiling) {
    fail('provider billing ceilings drifted from protected policy');
  }
  const runnerStarted = Date.parse(spec.handoff.runnerResult.startedAt);
  const runnerEnded = Date.parse(spec.handoff.runnerResult.endedAt);
  const attemptIds = new Set();
  let attemptTotal = 0n;
  let previousCompleted = runnerStarted;
  const allowedDispatchedOutcomes = new Set(['accepted', 'rejected-partial-completion']);
  for (const [index, attempt] of snapshot.attempts.entries()) {
    exactKeys(attempt, [
      'ordinal', 'attemptId', 'leaseId', 'leaseDigest', 'trialId', 'leaseSequence',
      'sequence', 'state', 'outcome', 'startedAt', 'completedAt', 'model',
      'providerEndpointTag', 'expectedResolvedProvider', 'maxTokens',
      'requestPayloadBytes', 'reservedUsd', 'usage', 'actualCostUsd',
      'reservationUnderestimated', 'budgetBreached',
    ], 'provider attempt evidence');
    safeId(attempt.attemptId, 'provider attempt id');
    integer(attempt.requestPayloadBytes, 'provider request payload bytes', 1, 8 * 1024 * 1024);
    if (attempt.ordinal !== index + 1
        || attempt.sequence !== index + 1
        || attemptIds.has(attempt.attemptId)
        || attempt.leaseId !== trial.leaseId
        || attempt.leaseDigest !== trial.leaseDigest
        || attempt.trialId !== trial.trialId
        || attempt.leaseSequence !== trial.leaseSequence
        || attempt.state !== 'completed'
        || !Number.isSafeInteger(attempt.startedAt)
        || !Number.isSafeInteger(attempt.completedAt)
        || attempt.startedAt < runnerStarted
        || attempt.startedAt < previousCompleted
        || attempt.completedAt < attempt.startedAt
        || attempt.completedAt > runnerEnded
        || attempt.model !== snapshot.policy.model
        || attempt.providerEndpointTag !== snapshot.policy.providerEndpointTag
        || attempt.expectedResolvedProvider !== snapshot.policy.expectedResolvedProvider
        || attempt.maxTokens !== snapshot.policy.maxTokens) {
      fail('provider attempt identity or sequence drifted');
    }
    attemptIds.add(attempt.attemptId);
    previousCompleted = attempt.completedAt;
    const reserved = usdPico(attempt.reservedUsd, 'provider attempt reservation');
    const expectedReserved = pricedTokenCostPico({
      inputTokens: attempt.requestPayloadBytes,
      cachedTokens: 0,
      outputTokens: trustedPolicy.maxTokens,
    }, trustedPolicy.pricing);
    if (reserved !== expectedReserved) fail('provider attempt reservation drifted');
    const reservedExposure = attemptTotal + reserved;
    if (reservedExposure > trialCeiling + 1n || reservedExposure > sessionCeiling + 1n) {
      fail('provider attempt reservation exceeded its remaining protected ceiling');
    }

    let actual;
    if (attempt.outcome === 'rejected-disconnected-before-dispatch') {
      actual = usdPico(attempt.actualCostUsd, 'disconnected provider attempt cost');
      if (attempt.usage !== null
          || actual !== 0n
          || attempt.reservationUnderestimated !== false
          || attempt.budgetBreached !== false) {
        fail('pre-dispatch provider rejection contains billing drift');
      }
    } else {
      if (!allowedDispatchedOutcomes.has(attempt.outcome)) {
        fail('provider attempt outcome cannot produce clean final evidence');
      }
      exactKeys(attempt.usage, [
        'promptTokens', 'cachedTokens', 'cachedTokensComplete', 'reasoningTokens',
        'reasoningTokensComplete', 'outputTokens', 'localCostUsd', 'providerCostUsd',
        'reconciledCostUsd',
      ], 'provider attempt usage');
      integer(attempt.usage.promptTokens, 'provider prompt tokens', 0, 1_000_000_000);
      integer(attempt.usage.outputTokens, 'provider output tokens', 0, 1_000_000_000);
      boolean(attempt.usage.cachedTokensComplete, 'cached-token completeness');
      boolean(attempt.usage.reasoningTokensComplete, 'reasoning-token completeness');
      const cached = attempt.usage.cachedTokensComplete
        ? integer(attempt.usage.cachedTokens, 'provider cached tokens', 0, attempt.usage.promptTokens)
        : 0;
      const reasoning = attempt.usage.reasoningTokensComplete
        ? integer(attempt.usage.reasoningTokens, 'provider reasoning tokens', 0, attempt.usage.outputTokens)
        : 0;
      if ((!attempt.usage.cachedTokensComplete && attempt.usage.cachedTokens !== null)
          || (!attempt.usage.reasoningTokensComplete && attempt.usage.reasoningTokens !== null)
          || reasoning > attempt.usage.outputTokens) {
        fail('provider token detail completeness drifted');
      }
      const local = usdPico(attempt.usage.localCostUsd, 'provider local cost');
      const provider = usdPico(attempt.usage.providerCostUsd, 'provider reported cost');
      const reconciled = usdPico(attempt.usage.reconciledCostUsd, 'provider reconciled cost');
      actual = usdPico(attempt.actualCostUsd, 'provider actual cost');
      const expectedLocal = pricedTokenCostPico({
        inputTokens: attempt.usage.promptTokens,
        cachedTokens: cached,
        outputTokens: attempt.usage.outputTokens,
      }, trustedPolicy.pricing);
      const expectedReconciled = expectedLocal > provider ? expectedLocal : provider;
      const underestimated = expectedReconciled > reserved + 1n;
      const runningActual = attemptTotal + expectedReconciled;
      const breached = runningActual > trialCeiling + 1n
        || runningActual > sessionCeiling + 1n
        || underestimated;
      if (local !== expectedLocal
          || reconciled !== expectedReconciled
          || actual !== expectedReconciled
          || attempt.reservationUnderestimated !== underestimated
          || attempt.budgetBreached !== breached
          || underestimated
          || breached) {
        fail('provider attempt billing arithmetic drifted');
      }
    }
    attemptTotal += actual;
  }
  integer(trial.nextSequence, 'provider next sequence', snapshot.attempts.length + 1, snapshot.attempts.length + 1);
  const trialKnown = usdPico(trial.knownActualUsd, 'trial actual spend');
  const sessionKnown = usdPico(session.knownActualUsd, 'session actual spend');
  const trialUncertain = usdPico(trial.uncertainReservedUsd, 'trial uncertain reserve');
  const trialActive = usdPico(trial.activeReservedUsd, 'trial active reserve');
  const sessionUncertain = usdPico(session.uncertainReservedUsd, 'session uncertain reserve');
  const sessionActive = usdPico(session.activeReservedUsd, 'session active reserve');
  const accounted = usdPico(trial.accountedExposureUsd, 'trial accounted exposure');
  const sessionAccounted = usdPico(session.accountedExposureUsd, 'session accounted exposure');
  const derivedTrialExposure = trialKnown + trialUncertain + trialActive;
  const derivedSessionExposure = sessionKnown + sessionUncertain + sessionActive;
  const trialBreached = derivedTrialExposure > trialCeiling + 1n;
  const sessionBreached = derivedSessionExposure > sessionCeiling + 1n;
  if (trialKnown !== attemptTotal
      || sessionKnown !== attemptTotal
      || trialUncertain !== 0n
      || trialActive !== 0n
      || sessionUncertain !== 0n
      || sessionActive !== 0n
      || accounted !== derivedTrialExposure
      || sessionAccounted !== derivedSessionExposure
      || accounted !== sessionAccounted
      || trial.breached !== trialBreached
      || session.breached !== sessionBreached
      || trial.blocked !== (trialBreached || trialUncertain > 0n)
      || session.blocked !== (sessionBreached || sessionUncertain > 0n)
      || trial.breached !== false
      || session.breached !== false
      || trial.blocked !== false
      || session.blocked !== false
      || accounted > trialCeiling + 1n
      || sessionAccounted > sessionCeiling + 1n) {
    fail('provider billing reconciliation is incomplete');
  }
  const spendMicrousd = Number((attemptTotal + 999_999n) / 1_000_000n);
  if (!Number.isSafeInteger(spendMicrousd) || spendMicrousd < 0 || spendMicrousd > 20_000_000) {
    fail('provider spend cannot be represented in microusd');
  }
  const identityProjection = {
    requestHash: spec.requestHash,
    leaseHash: spec.leaseHash,
    leaseId: trial.leaseId,
    trialId: trial.trialId,
    leaseSequence: trial.leaseSequence,
    policyHash: snapshot.policy.policyHash,
    bindingPolicyHash: snapshot.policy.bindingPolicyHash,
    endpointHash: snapshot.policy.endpointHash,
    model: snapshot.policy.model,
    providerEndpointTag: snapshot.policy.providerEndpointTag,
    expectedResolvedProvider: snapshot.policy.expectedResolvedProvider,
  };
  return {
    requestHash: spec.requestHash,
    leaseHash: spec.leaseHash,
    usageHash: evidence.snapshotHash,
    identityHash: sha256(`engineer-runtime-provider-identity.v1\0${canonicalJson(identityProjection)}`),
    spendMicrousd,
    billingCertain: true,
    budgetComplete: true,
    withinTrialCeiling: true,
    attempts: snapshot.attempts.length,
  };
}

/** Production read-only Linux evidence primitives for the fixed Daytona DIND snapshot. */
export function createNodeRuntimeEvidencePrimitives({ system: overrides = {} } = {}) {
  const system = nodeEvidenceSystem(overrides);
  return {
    async platform() { return process.platform; },
    async effectiveUid() { return process.geteuid?.() ?? process.getuid?.() ?? -1; },
    async readHandoff({ fd }) { return readRuntimeEvidenceHandoff({ fd }); },
    async inspectDaemonCustody(spec) {
      const targets = {
        daemon: spec.daemonSocket,
        proxy: spec.proxySocket,
        broker: spec.brokerSocket,
        brokerPolicy: spec.brokerPolicy,
      };
      const entries = Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([name, target]) => [
        name,
        await system.inspectPath({ path: target, maxBytes: spec.maxOutputBytes, shell: false }),
      ])));
      if (spec.handoff.executionMode === ZERO_PROVIDER_CANARY) {
        if (entries.broker?.exists !== false || entries.brokerPolicy?.exists !== false) {
          fail('zero-provider daemon custody did not prove broker absence');
        }
        return {
          daemon: {
            kind: entries.daemon.kind,
            real: entries.daemon.real,
            ownerUid: entries.daemon.ownerUid,
            groupGid: entries.daemon.groupGid,
            mode: entries.daemon.mode,
          },
          proxy: {
            kind: entries.proxy.kind,
            real: entries.proxy.real,
            ownerUid: entries.proxy.ownerUid,
            groupGid: entries.proxy.groupGid,
            mode: entries.proxy.mode,
          },
          broker: { exists: false },
          brokerPolicy: { exists: false },
        };
      }
      const policy = await system.attestBrokerPolicy({
        path: spec.brokerPolicy,
        maxBytes: MAX_POLICY_BYTES,
        shell: false,
      });
      if (policy?.policyHash !== spec.handoff.broker.policyHash
          || policy?.bindingPolicyHash !== spec.handoff.broker.bindingPolicyHash) {
        fail('provider broker policy attestation drifted');
      }
      return Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, {
        kind: entry.kind,
        real: entry.real,
        ownerUid: entry.ownerUid,
        groupGid: entry.groupGid,
        mode: entry.mode,
      }]));
    },
    async inspectHarbor(spec) {
      const executableHash = await system.hashExecutable({
        file: FIXED_HARBOR,
        maxBytes: MAX_EXECUTABLE_BYTES,
        shell: false,
      });
      if (spec.handoff.runnerResult.signal !== 'none') fail('Harbor runner ended by signal');
      return {
        completed: true,
        exitCode: spec.handoff.runnerResult.exitCode,
        executableHash,
      };
    },
    async inspectDocker(spec) {
      const base = {
        file: FIXED_DOCKER,
        env: { LANG: 'C.UTF-8' },
        timeoutMs: 5_000,
        maxOutputBytes: MAX_COMMAND_BYTES,
        shell: false,
      };
      const host = `unix://${spec.daemonSocket}`;
      const [containers, networks, volumes] = await Promise.all([
        system.runCommand({ ...base, args: ['--host', host, 'container', 'ls', '--all', '--quiet', '--no-trunc'] }),
        system.runCommand({ ...base, args: ['--host', host, 'network', 'ls', '--filter', 'type=custom', '--quiet', '--no-trunc'] }),
        system.runCommand({ ...base, args: ['--host', host, 'volume', 'ls', '--quiet'] }),
      ]);
      if ([containers, networks, volumes].some((result) => result?.exitCode !== 0)) {
        fail('private Docker inventory command failed');
      }
      return {
        eventsHash: spec.handoff.proxy.eventsHash,
        eventsComplete: spec.handoff.proxy.eventsComplete,
        containerIdHash: spec.handoff.proxy.containerIdHash,
        imageDigest: spec.handoff.topology.imageDigest,
        policyCompliant: spec.handoff.proxy.policyCompliant,
        containersRemaining: inventoryCount(containers.stdout, 'container inventory', /^[a-f0-9]{64}$/),
        networksRemaining: inventoryCount(networks.stdout, 'network inventory', /^[a-f0-9]{64}$/),
        volumesRemaining: inventoryCount(volumes.stdout, 'volume inventory', /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/),
      };
    },
    async inspectMounts(spec) {
      const receipt = await system.readTaskMountReceipt({
        file: TASK_MOUNT_RECEIPT,
        maxBytes: MAX_KERNEL_FILE_BYTES,
        shell: false,
      });
      exactKeys(receipt, [
        'schema', 'requestHash', 'leaseHash', 'proxyEventsHash', 'containerIdHash',
        'mountNamespaceIdentityHash', 'bindInventoryHash', 'writableMountInventoryHash',
        'inventoryHash', 'producerExecutableHash', 'sandboxBootId',
        'trialId', 'producerSessionId',
        'policyCompliant', 'outsideAllowedWrites',
        'daemonRootFilesystemId', 'workspaceFilesystemId',
      ], 'task mount receipt');
      if (receipt.schema !== RUNTIME_TASK_MOUNT_RECEIPT_SCHEMA
          || receipt.requestHash !== spec.requestHash
          || receipt.leaseHash !== spec.leaseHash
          || receipt.proxyEventsHash !== spec.handoff.proxy.eventsHash
          || receipt.containerIdHash !== spec.handoff.proxy.containerIdHash
          || receipt.producerExecutableHash !== spec.handoff.networkPolicy.producerExecutableHash
          || receipt.sandboxBootId !== spec.handoff.networkPolicy.sandboxBootId
          || receipt.trialId !== spec.handoff.networkPolicy.trialId
          || receipt.producerSessionId !== spec.handoff.networkPolicy.producerSessionId) {
        fail('task mount receipt binding drifted');
      }
      for (const field of [
        'mountNamespaceIdentityHash', 'bindInventoryHash', 'writableMountInventoryHash',
        'inventoryHash', 'producerExecutableHash', 'producerSessionId',
      ]) digest(receipt[field], `task mount receipt ${field}`);
      safeId(receipt.trialId, 'task mount receipt trial id');
      boolean(receipt.policyCompliant, 'task mount receipt policy compliance', true);
      boolean(receipt.outsideAllowedWrites, 'task mount receipt outside writes', false);
      const [daemon, workspace] = await Promise.all([
        system.statFilesystem({ path: DAEMON_DATA_ROOT, shell: false }),
        system.statFilesystem({ path: spec.workspace, absentParent: '/engineer-bounded', shell: false }),
      ]);
      if (daemon?.real !== true
          || workspace?.real !== true
          || daemon.id !== receipt.daemonRootFilesystemId
          || workspace.id !== receipt.workspaceFilesystemId
          || daemon.id !== spec.handoff.topology.filesystemId
          || workspace.id !== spec.handoff.topology.filesystemId) {
        fail('task mount receipt filesystem identity drifted');
      }
      return {
        inventoryHash: receipt.inventoryHash,
        policyCompliant: receipt.policyCompliant,
        outsideAllowedWrites: receipt.outsideAllowedWrites,
        daemonRootFilesystemId: daemon.id,
        workspaceFilesystemId: workspace.id,
      };
    },
    async inspectCgroup(spec) {
      const observed = validateObservedCgroup(await system.observeCgroup({
        path: spec.cgroup,
        maxBytes: spec.maxOutputBytes,
        shell: false,
      }), spec);
      return {
        evidenceHash: sha256(`engineer-runtime-cgroup-inventory.v1\0${canonicalJson(observed)}`),
        id: observed.id,
        pathHash: spec.handoff.topology.cgroupPathHash,
        populated: false,
        processesRemaining: 0,
        limitsEnforced: true,
      };
    },
    async inspectResources(spec) {
      const observed = validateObservedCgroup(await system.observeCgroup({
        path: spec.cgroup,
        maxBytes: spec.maxOutputBytes,
        shell: false,
      }), spec);
      return {
        evidenceHash: sha256(`engineer-runtime-resource-inventory.v1\0${canonicalJson({
          cpuMax: observed.cpuMax,
          cpuUsageUsec: observed.cpuUsageUsec,
          memoryMax: observed.memoryMax,
          memoryPeak: observed.memoryPeak,
          pidsMax: observed.pidsMax,
          pidsPeak: observed.pidsPeak,
          oomKills: observed.oomKills,
        })}`),
        cpuWithinLimit: observed.cpuMax === spec.handoff.topology.cpuMax,
        memoryWithinLimit: observed.memoryPeak <= spec.handoff.topology.memoryMax,
        pidsWithinLimit: observed.pidsPeak <= spec.handoff.topology.pidsMax,
        oomKilled: observed.oomKills !== 0,
      };
    },
    async inspectNetwork(spec) {
      const policy = validateRuntimeNetworkPolicyReceipt(spec.handoff.networkPolicy);
      const taskReceipt = await system.readTaskIsolationReceipt({
        file: TASK_ISOLATION_RECEIPT,
        maxBytes: MAX_KERNEL_FILE_BYTES,
        shell: false,
      });
      const brokerObservation = spec.handoff.executionMode === CONTROLLED_PROVIDER
        ? system.observeSocketProcess({
          socketPath: spec.brokerSocket,
          maxPids: MAX_PROC_SCAN,
          maxBytes: spec.maxOutputBytes,
          shell: false,
        })
        : Promise.all([
          system.inspectPath({ path: spec.brokerSocket, maxBytes: spec.maxOutputBytes, shell: false }),
          system.inspectPath({ path: spec.brokerPolicy, maxBytes: spec.maxOutputBytes, shell: false }),
        ]).then(([socket, policyPath]) => ({ socket, policyPath }));
      const [observed, broker, iptablesHash, ip6tablesHash, supervisorHash, bootId] = await Promise.all([
        system.observeNetworkPolicy({
          files: [FIXED_IPTABLES, FIXED_IP6TABLES],
          chains: [NETWORK_CHAIN_V4, NETWORK_CHAIN_V6],
          receipt: policy,
          maxBytes: spec.maxOutputBytes,
          shell: false,
        }),
        brokerObservation,
        system.hashExecutable({ file: FIXED_IPTABLES, maxBytes: MAX_EXECUTABLE_BYTES, shell: false }),
        system.hashExecutable({ file: FIXED_IP6TABLES, maxBytes: MAX_EXECUTABLE_BYTES, shell: false }),
        system.hashExecutable({ file: FIXED_SUPERVISOR, maxBytes: MAX_EXECUTABLE_BYTES, shell: false }),
        system.readBootId({ file: '/proc/sys/kernel/random/boot_id', maxBytes: 128, shell: false }),
      ]);
      exactKeys(taskReceipt, [
        'schema', 'requestHash', 'leaseHash', 'proxyEventsHash', 'containerIdHash',
        'imageDigest', 'networkNamespaceIdentityHash', 'interfaceInventoryHash',
        'rawSocketCanaryHash', 'producerExecutableHash', 'sandboxBootId',
        'trialId', 'producerSessionId', 'networkMode',
        'effectiveCapabilities', 'noNewPrivileges', 'taskNetworkNone', 'rawSocketDenied',
      ], 'task isolation receipt');
      for (const field of [
        'networkNamespaceIdentityHash', 'interfaceInventoryHash', 'rawSocketCanaryHash',
        'producerExecutableHash', 'producerSessionId',
      ]) digest(taskReceipt[field], `task isolation ${field}`);
      safeId(taskReceipt.trialId, 'task isolation trial id');
      const brokerCompliant = spec.handoff.executionMode === CONTROLLED_PROVIDER
        ? plainObject(broker)
          && broker.uid === BROKER_UID
          && broker.gid === BROKER_GID
          && Array.isArray(broker.supplementaryGids)
          && broker.supplementaryGids.includes(BROKER_CLIENT_GID)
          && broker.effectiveCapabilities === 0
          && broker.noNewPrivileges === true
          && /^(?:0|[1-9][0-9]*)$/.test(String(broker.startTimeTicks))
        : plainObject(broker)
          && broker.socket?.exists === false
          && broker.policyPath?.exists === false;
      if (!plainObject(observed)
          || !HASH.test(String(observed.evidenceHash))
          || observed.runnerEgressDenied !== true
          || observed.brokerOnlyEgress !== true
          || observed.metadataDenied !== true
          || observed.rawSocketDenied !== true
          || !brokerCompliant
          || iptablesHash !== policy.iptablesExecutableHash
          || ip6tablesHash !== policy.ip6tablesExecutableHash
          || supervisorHash !== policy.producerExecutableHash
          || bootId !== policy.sandboxBootId
          || taskReceipt.schema !== RUNTIME_TASK_ISOLATION_RECEIPT_SCHEMA
          || taskReceipt.requestHash !== spec.requestHash
          || taskReceipt.leaseHash !== spec.leaseHash
          || taskReceipt.proxyEventsHash !== spec.handoff.proxy.eventsHash
          || taskReceipt.containerIdHash !== spec.handoff.proxy.containerIdHash
          || taskReceipt.imageDigest !== spec.handoff.topology.imageDigest
          || taskReceipt.producerExecutableHash !== policy.producerExecutableHash
          || taskReceipt.sandboxBootId !== policy.sandboxBootId
          || taskReceipt.trialId !== policy.trialId
          || taskReceipt.producerSessionId !== policy.producerSessionId
          || taskReceipt.networkMode !== 'none'
          || taskReceipt.effectiveCapabilities !== 0
          || taskReceipt.noNewPrivileges !== true
          || taskReceipt.taskNetworkNone !== true
          || taskReceipt.rawSocketDenied !== true
          || spec.handoff.proxy.policyCompliant !== true) {
        fail('final network policy inventory drifted');
      }
      return {
        evidenceHash: observed.evidenceHash,
        taskNetworkNone: taskReceipt.taskNetworkNone,
        runnerEgressDenied: true,
        brokerOnlyEgress: true,
        metadataDenied: true,
        rawSocketDenied: taskReceipt.rawSocketDenied,
      };
    },
    async inspectProvider(spec) {
      if (spec.handoff.executionMode === ZERO_PROVIDER_CANARY) {
        const [socket, policyPath] = await Promise.all([
          system.inspectPath({ path: spec.brokerSocket, maxBytes: spec.maxOutputBytes, shell: false }),
          system.inspectPath({ path: spec.brokerPolicy, maxBytes: spec.maxOutputBytes, shell: false }),
        ]);
        if (socket?.exists !== false || policyPath?.exists !== false || spec.handoff.broker !== null) {
          fail('zero-provider broker custody is not absent');
        }
        const usage = {
          schema: 'engineer-runtime-zero-provider-usage.v1',
          executionMode: ZERO_PROVIDER_CANARY,
          attempts: 0,
          calls: 0,
          spendMicrousd: 0,
        };
        const identity = {
          schema: 'engineer-runtime-zero-provider-identity.v1',
          executionMode: ZERO_PROVIDER_CANARY,
          requestHash: spec.requestHash,
          leaseHash: spec.leaseHash,
          brokerAbsent: true,
        };
        return {
          mode: 'not-exercised',
          requestHash: spec.requestHash,
          leaseHash: spec.leaseHash,
          usageHash: sha256(canonicalJson(usage)),
          identityHash: sha256(canonicalJson(identity)),
          spendMicrousd: 0,
          billingCertain: true,
          budgetComplete: true,
          withinTrialCeiling: true,
          attempts: 0,
          calls: 0,
          brokerAbsent: true,
        };
      }
      const [evidence, protectedPolicy] = await Promise.all([
        system.requestBrokerEvidence({
          socketPath: spec.brokerSocket,
          timeoutMs: 5_000,
          maxFrameBytes: spec.maxOutputBytes,
          shell: false,
        }),
        system.attestBrokerPolicy({
          path: spec.brokerPolicy,
          maxBytes: MAX_POLICY_BYTES,
          shell: false,
        }),
      ]);
      if (protectedPolicy?.policyHash !== spec.handoff.broker.policyHash
          || protectedPolicy?.bindingPolicyHash !== spec.handoff.broker.bindingPolicyHash) {
        fail('protected provider policy drifted during reconciliation');
      }
      return reconcileProviderEvidence(evidence, spec, protectedPolicy.policy);
    },
    async inspectCleanup(spec) {
      if (!plainObject(spec.docker) || !plainObject(spec.cgroup)) {
        fail('cleanup inventory requires bound Docker and cgroup observations');
      }
      return {
        completed: spec.docker.containersRemaining === 0
          && spec.docker.networksRemaining === 0
          && spec.docker.volumesRemaining === 0
          && spec.cgroup.processesRemaining === 0
          && spec.cgroup.populated === false,
        containersRemaining: spec.docker.containersRemaining,
        networksRemaining: spec.docker.networksRemaining,
        volumesRemaining: spec.docker.volumesRemaining,
        processesRemaining: spec.cgroup.processesRemaining,
        cgroupPopulated: spec.cgroup.populated,
      };
    },
    async now() { return new Date(); },
  };
}

function validateOutput(output) {
  if (!output || typeof output.write !== 'function') throw new TypeError('runtime evidence output must be writable');
  return output;
}

/** Exact snapshot entrypoint installed at /opt/engineer/bin/engineer-runtime-evidence. */
export async function runRuntimeEvidenceCli({
  executablePath = process.argv[1] ?? '',
  argv = process.argv.slice(2),
  environment = process.env,
  output = process.stdout,
  primitives,
} = {}) {
  if (executablePath !== RUNTIME_EVIDENCE_EXECUTABLE) {
    fail('runtime evidence executable invocation drifted', 'ERR_RUNTIME_EVIDENCE_INVOCATION');
  }
  const evidence = await collectRuntimeEvidence({
    argv,
    environment,
    ...(primitives === undefined ? {} : { primitives }),
  });
  const serialized = `${canonicalJson(evidence)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) fail('runtime evidence output exceeds its byte bound');
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
  runRuntimeEvidenceCli().then(
    (code) => { process.exitCode = code; },
    (error) => {
      const code = error instanceof RuntimeEvidenceError ? error.code : 'ERR_RUNTIME_EVIDENCE';
      process.stderr.write(`engineer runtime evidence failed: ${code}\n`);
      process.exitCode = error?.code === 'ERR_RUNTIME_EVIDENCE_INVOCATION' ? 64 : 70;
    },
  );
}
