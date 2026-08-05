/**
 * Concrete privileged Linux/DIND effects for the runtime supervisor.
 *
 * The supervisor owns protocol policy. This adapter owns the operating-system
 * boundary: a bounded private daemon, an allowlisted Docker proxy, a one-shot
 * provider broker, cgroup-v2 custody, an unprivileged runner, and complete
 * cleanup evidence. The narrow driver seam lets contract tests run on macOS;
 * the default driver performs the Linux operations without a shell.
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createDockerPolicyProxy } from './docker-proxy.mjs';
import { providerBrokerStaticPolicyHash } from './provider-broker.mjs';
import { createTrialSecurityContract } from './trial-security-contract.mjs';
import { archivedConditionReadOnlyBindVariants } from './trial-archive.mjs';
import {
  TRIAL_SECURITY_MATERIALIZATION_SCHEMA,
  materializeTrialSecurity,
} from './trial-security-materializer.mjs';
import {
  TASK_ISOLATION_RECEIPT_PATH,
  TASK_MOUNT_RECEIPT_PATH,
  createTaskRuntimeReceipts,
  observeLiveTaskContainer,
  publishTaskRuntimeReceipts,
} from './task-container-observer.mjs';
import {
  createRuntimeProbeHandoff,
  encodeRuntimeProbeHandoff,
} from './runtime-probe.mjs';
import {
  createRuntimeNetworkPolicyReceipt,
  createRuntimeEvidenceHandoff,
  encodeRuntimeEvidenceHandoff,
} from './runtime-evidence.mjs';
import {
  DAEMON_ADOPTION_RECEIPT_PATH,
  attestDaemonAdoptionReceipt,
} from './snapshot-manager.mjs';

const TEN_GIB = 10 * 1024 * 1024 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const MAX_HELPER_HANDOFF_BYTES = 32 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const PINNED_HARBOR = '/opt/engineer/bin/harbor';
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ENV = /(?:OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|GROQ|XAI|MISTRAL|COHERE|TOGETHER|FIREWORKS|DEEPSEEK|CEREBRAS|PERPLEXITY|API_KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const SENSITIVE_FIELD = /(^|[_-])(api[_-]?key|authorization|credential|password|secret|token)($|[_-])/i;
const SECRET_VALUE = /(?:Bearer\s+|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,})/i;
const SAFE_PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SUPPORT_ENV = Object.freeze({ LANG: 'C.UTF-8', PATH: SAFE_PATH_ENV });
const EXACT_PROVIDER_HOSTNAME = 'openrouter.ai';
const EXACT_PROVIDER_HTTPS_PORT = 443;
const MAX_PROVIDER_ADDRESSES_PER_FAMILY = 16;
const MAX_CONFIGURED_DNS_SERVERS = 8;
const NETWORK_POLICY_CHAIN_V4 = 'ENGINEER_EGRESS_V4';
const NETWORK_POLICY_CHAIN_V6 = 'ENGINEER_EGRESS_V6';
const EXACT_METADATA_CIDRS = Object.freeze([
  '169.254.0.0/16',
  '100.100.100.200/32',
  'fe80::/10',
  'fd00:ec2::254/128',
]);
const RUNTIME_RUNNER_ENV = new Set([
  'DOCKER_HOST',
  'ENGINEER_PROVIDER_BROKER_SOCKET',
  'ENGINEER_PROVIDER_LEASE_ID',
  'ENGINEER_PROVIDER_TRIAL_ID',
  'ENGINEER_PROVIDER_LEASE_DIGEST',
  'ENGINEER_PROVIDER_LEASE_SEQUENCE',
  'ENGINEER_RUNTIME_LEASE_HASH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'PYTHONUNBUFFERED',
  'SHELL',
  'TMPDIR',
  'TZ',
  'USER',
]);
const REQUIRED_DRIVER = Object.freeze([
  'inspectHost',
  'inspectDescriptor',
  'hashExecutable',
  'reserveEvidence',
  'ensureCgroup',
  'prepareDirectory',
  'inspectPath',
  'installNetworkPolicy',
  'writePolicy',
  'spawnProcess',
  'waitForSocket',
  'inspectSocket',
  'setSocketPolicy',
  'runReadinessProbe',
  'waitProcess',
  'collectEvidence',
  'closeDescriptor',
  'installChannelLossHandler',
  'terminateProcess',
  'killCgroup',
  'removeRuntimeArtifacts',
  'releaseEvidence',
  'inspectShutdown',
  'now',
]);

export class LinuxRuntimeEffectsError extends Error {
  constructor(message, code = 'ERR_LINUX_RUNTIME_EFFECT') {
    super(message);
    this.name = 'LinuxRuntimeEffectsError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new LinuxRuntimeEffectsError(message, code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > maximum || value.includes('\0')) {
    fail(`${label} must be a bounded string`, 'ERR_LINUX_RUNTIME_CONFIG');
  }
  return value;
}

function safeId(value, label) {
  boundedString(value, label, 128);
  if (!SAFE_ID.test(value)) fail(`${label} must be a safe identifier`, 'ERR_LINUX_RUNTIME_CONFIG');
  return value;
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is outside its integer bound`, 'ERR_LINUX_RUNTIME_CONFIG');
  }
  return value;
}

function absolute(value, label, { below = null, maximum = 512 } = {}) {
  boundedString(value, label, maximum);
  if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.includes('//')) {
    fail(`${label} must be a normalized absolute path`, 'ERR_LINUX_RUNTIME_CONFIG');
  }
  if (below && value !== below && !value.startsWith(`${below}/`)) {
    fail(`${label} escaped its approved root`, 'ERR_LINUX_RUNTIME_CONFIG');
  }
  return value;
}

function sha(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`, 'ERR_LINUX_RUNTIME_CONFIG');
  }
  return value;
}

function clone(value, label = 'runtime evidence') {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(`${label} is not JSON evidence`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) {
    fail(`${label} exceeds its byte bound`);
  }
  return JSON.parse(serialized);
}

function credentialFree(value, label) {
  const visit = (current) => {
    if (typeof current === 'string') {
      if (SECRET_VALUE.test(current)) fail(`${label} contains credential material`, 'ERR_LINUX_RUNTIME_SECRET');
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (SENSITIVE_FIELD.test(key) && !key.startsWith('ENGINEER_PROVIDER_')) {
        fail(`${label} contains a secret-bearing field`, 'ERR_LINUX_RUNTIME_SECRET');
      }
      visit(item);
    }
  };
  visit(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function evidenceHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sameJson(left, right) {
  return evidenceHash(left) === evidenceHash(right);
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
  if (net.isIPv6(address)) {
    // Provider IPv6 destinations must be ordinary global-unicast addresses.
    // This excludes loopback, link-local, ULA, multicast, documentation, and
    // IPv4-mapped/transitional destinations without maintaining a broad allow.
    return ipv6CidrContains(address, '2000::', 3)
      && !ipv6CidrContains(address, '2001:db8::', 32);
  }
  return false;
}

function metadataDestination(address) {
  return net.isIPv4(address)
    ? ipv4CidrContains(address, '169.254.0.0', 16) || address === '100.100.100.200'
    : ipv6CidrContains(address, 'fe80::', 10) || ipv6CidrContains(address, 'fd00:ec2::254', 128);
}

function exactMetadataCidrs(value) {
  if (!Array.isArray(value)
      || value.length !== EXACT_METADATA_CIDRS.length
      || !sameJson([...new Set(value)].sort(), [...EXACT_METADATA_CIDRS].sort())) {
    fail('metadata deny destinations drifted', 'ERR_LINUX_RUNTIME_NETWORK');
  }
  return value;
}

function exactDnsServer(server) {
  if (!plainObject(server)
      || ![4, 6].includes(server.family)
      || net.isIP(server.address) !== server.family
      || server.address.includes('%')
      || server.port !== 53
      || metadataDestination(server.address)) {
    fail('configured DNS destination is not an exact safe resolver', 'ERR_LINUX_RUNTIME_NETWORK');
  }
  return { address: server.address, family: server.family, port: server.port };
}

function networkRule(file, args) {
  return Object.freeze({ file, args: Object.freeze(args) });
}

/**
 * Construct the only accepted host OUTPUT policy for a paid release trial.
 *
 * The policy is deliberately L3/L4 and short-lived: the code-owned broker
 * separately pins the HTTPS hostname, path, model, provider and request body.
 * DNS answers are resolved before this plan is installed, so a later DNS
 * change can only make the broker fail; it cannot widen the destination set.
 */
export function planLinuxNetworkPolicy(spec) {
  if (!plainObject(spec)) fail('network policy specification is required', 'ERR_LINUX_RUNTIME_NETWORK');
  absolute(spec.iptables, 'network policy iptables');
  absolute(spec.ip6tables, 'network policy ip6tables');
  if (spec.runnerUid !== 2001 || spec.brokerUid !== 2002) {
    fail('network policy runtime identities drifted', 'ERR_LINUX_RUNTIME_NETWORK');
  }
  if (spec.providerHostname !== EXACT_PROVIDER_HOSTNAME
      || spec.providerHttpsPort !== EXACT_PROVIDER_HTTPS_PORT) {
    fail('network policy provider destination drifted', 'ERR_LINUX_RUNTIME_NETWORK');
  }
  exactMetadataCidrs(spec.metadataCidrs);
  if (!plainObject(spec.providerAddresses)
      || !Array.isArray(spec.providerAddresses.ipv4)
      || !Array.isArray(spec.providerAddresses.ipv6)
      || spec.providerAddresses.ipv4.length > MAX_PROVIDER_ADDRESSES_PER_FAMILY
      || spec.providerAddresses.ipv6.length > MAX_PROVIDER_ADDRESSES_PER_FAMILY) {
    fail('resolved provider destinations are required', 'ERR_LINUX_RUNTIME_NETWORK');
  }
  const ipv4 = [...new Set(spec.providerAddresses.ipv4)].sort();
  const ipv6 = [...new Set(spec.providerAddresses.ipv6)].sort();
  if (ipv4.length + ipv6.length < 1
      || ipv4.some((address) => !net.isIPv4(address) || !globallyRoutableProviderAddress(address))
      || ipv6.some((address) => !net.isIPv6(address) || !globallyRoutableProviderAddress(address))) {
    fail('provider resolution did not produce exact global destinations', 'ERR_LINUX_RUNTIME_NETWORK');
  }
  if (!Array.isArray(spec.dnsServers)
      || spec.dnsServers.length < 1
      || spec.dnsServers.length > MAX_CONFIGURED_DNS_SERVERS) {
    fail('configured DNS destinations are required', 'ERR_LINUX_RUNTIME_NETWORK');
  }
  const dnsServers = spec.dnsServers.map(exactDnsServer);
  const commands = [];
  const families = [
    {
      file: spec.iptables,
      chain: NETWORK_POLICY_CHAIN_V4,
      metadata: spec.metadataCidrs.filter((cidr) => net.isIPv4(cidr.split('/')[0])),
      providers: ipv4,
      resolvers: dnsServers.filter(({ family }) => family === 4),
    },
    {
      file: spec.ip6tables,
      chain: NETWORK_POLICY_CHAIN_V6,
      metadata: spec.metadataCidrs.filter((cidr) => net.isIPv6(cidr.split('/')[0])),
      providers: ipv6,
      resolvers: dnsServers.filter(({ family }) => family === 6),
    },
  ];
  for (const family of families) {
    const prefix = ['--wait', '5'];
    commands.push(networkRule(family.file, [...prefix, '--new-chain', family.chain]));
    for (const destination of family.metadata) {
      commands.push(networkRule(family.file, [...prefix, '--append', family.chain,
        '--destination', destination, '--jump', 'REJECT']));
    }
    commands.push(networkRule(family.file, [...prefix, '--append', family.chain,
      '--out-interface', 'lo', '--jump', 'ACCEPT']));
    commands.push(networkRule(family.file, [...prefix, '--append', family.chain,
      '--match', 'conntrack', '--ctstate', 'ESTABLISHED', '--jump', 'ACCEPT']));
    for (const destination of family.providers) {
      commands.push(networkRule(family.file, [...prefix, '--append', family.chain,
        '--match', 'owner', '--uid-owner', String(spec.brokerUid),
        '--protocol', 'tcp', '--destination', destination,
        '--match', 'tcp', '--dport', String(spec.providerHttpsPort),
        '--match', 'conntrack', '--ctstate', 'NEW', '--jump', 'ACCEPT']));
    }
    for (const resolver of family.resolvers) {
      for (const protocol of ['udp', 'tcp']) {
        commands.push(networkRule(family.file, [...prefix, '--append', family.chain,
          '--match', 'owner', '--uid-owner', String(spec.brokerUid),
          '--protocol', protocol, '--destination', resolver.address,
          '--match', protocol, '--dport', String(resolver.port),
          '--match', 'conntrack', '--ctstate', 'NEW', '--jump', 'ACCEPT']));
      }
    }
    commands.push(networkRule(family.file, [...prefix, '--append', family.chain,
      '--match', 'owner', '--uid-owner', String(spec.runnerUid), '--jump', 'REJECT']));
    commands.push(networkRule(family.file, [...prefix, '--append', family.chain,
      '--match', 'owner', '--uid-owner', String(spec.brokerUid), '--jump', 'REJECT']));
    commands.push(networkRule(family.file, [...prefix, '--append', family.chain, '--jump', 'REJECT']));
    // Attach the complete chain last. A construction error therefore never
    // leaves a partially permissive policy advertised as active.
    commands.push(networkRule(family.file, [...prefix, '--insert', 'OUTPUT', '1', '--jump', family.chain]));
  }
  return Object.freeze(commands);
}

function parseConfiguredDnsServer(value) {
  boundedString(value, 'configured DNS server', 128);
  if (net.isIP(value)) return exactDnsServer({ address: value, family: net.isIP(value), port: 53 });
  const bracketed = value.match(/^\[([^\]]+)]:(\d+)$/);
  if (bracketed && net.isIPv6(bracketed[1])) {
    return exactDnsServer({ address: bracketed[1], family: 6, port: Number(bracketed[2]) });
  }
  const ipv4WithPort = value.match(/^([^:]+):(\d+)$/);
  if (ipv4WithPort && net.isIPv4(ipv4WithPort[1])) {
    return exactDnsServer({ address: ipv4WithPort[1], family: 4, port: Number(ipv4WithPort[2]) });
  }
  fail('configured DNS server is not an exact IP destination', 'ERR_LINUX_RUNTIME_NETWORK');
}

async function resolveExactProviderNetwork(hostname) {
  if (hostname !== EXACT_PROVIDER_HOSTNAME) {
    fail('provider hostname drifted before resolution', 'ERR_LINUX_RUNTIME_NETWORK');
  }
  const configured = dns.getServers();
  if (!Array.isArray(configured) || configured.length < 1) {
    fail('no configured DNS resolver is available', 'ERR_LINUX_RUNTIME_NETWORK');
  }
  const resolver = new dns.promises.Resolver();
  resolver.setServers(configured);
  const resolve = async (method) => {
    try {
      return await resolver[method](hostname);
    } catch (error) {
      if (['ENODATA', 'ENOTFOUND', 'ENONAME', 'NOTFOUND'].includes(error?.code)) return [];
      throw error;
    }
  };
  const [ipv4, ipv6] = await Promise.all([resolve('resolve4'), resolve('resolve6')]);
  return {
    providerAddresses: { ipv4, ipv6 },
    dnsServers: configured.map(parseConfiguredDnsServer),
  };
}

function validateTopology(input) {
  if (!plainObject(input)) fail('Linux runtime topology is required', 'ERR_LINUX_RUNTIME_CONFIG');
  const topology = input;
  safeId(topology.sandboxId, 'sandboxId');
  safeId(topology.sandboxBootId, 'sandboxBootId');
  safeId(topology.daemonId, 'daemonId');
  for (const field of ['filesystem', 'paths', 'executables', 'hashes', 'identities', 'cgroup', 'custody', 'timeouts']) {
    if (!plainObject(topology[field])) fail(`topology.${field} is required`, 'ERR_LINUX_RUNTIME_CONFIG');
  }
  absolute(topology.filesystem.sandboxRoot, 'filesystem.sandboxRoot');
  absolute(topology.filesystem.boundedRoot, 'filesystem.boundedRoot');
  absolute(topology.filesystem.defaultDockerRoot, 'filesystem.defaultDockerRoot');
  if (topology.filesystem.sandboxRoot !== topology.filesystem.boundedRoot
      || topology.filesystem.expectedBytes !== TEN_GIB) {
    fail('topology requires one exact 10-GiB bounded sandbox root', 'ERR_LINUX_RUNTIME_CONFIG');
  }
  safeId(topology.filesystem.id, 'filesystem.id');
  safeId(topology.filesystem.defaultDockerRootId, 'filesystem.defaultDockerRootId');
  if (topology.filesystem.id === topology.filesystem.defaultDockerRootId) {
    fail('default Docker root must not alias bounded runtime storage', 'ERR_LINUX_RUNTIME_CONFIG');
  }
  for (const [name, value] of Object.entries(topology.paths)) {
    absolute(value, `paths.${name}`, { maximum: 104 });
  }
  for (const field of ['evidenceDirectory', 'evidenceReserve', 'workspace', 'daemonDataRoot', 'brokerPolicyDirectory', 'brokerPolicy']) {
    absolute(topology.paths[field], `paths.${field}`, { below: topology.filesystem.boundedRoot });
  }
  if (path.posix.dirname(topology.paths.brokerPolicy) !== topology.paths.brokerPolicyDirectory) {
    fail('broker policy must live in its dedicated bounded directory', 'ERR_LINUX_RUNTIME_CONFIG');
  }
  if (topology.paths.daemonDataRoot !== '/engineer-bounded/docker'
      || topology.paths.daemonDataRoot === topology.filesystem.defaultDockerRoot
      || topology.paths.daemonSocket === '/var/run/docker.sock') {
    fail('private Docker daemon paths are not the approved bounded topology', 'ERR_LINUX_RUNTIME_CONFIG');
  }
  for (const field of [
    'dockerd', 'cgroupExec', 'iptables', 'ip6tables', 'supervisor', 'providerBroker', 'readinessProbe',
    'taskIsolationProbe', 'evidenceCollector', 'runner', 'harbor', 'sentinel',
  ]) absolute(topology.executables[field], `executables.${field}`);
  if (topology.executables.harbor !== PINNED_HARBOR) {
    fail('Harbor executable drifted from the fixed runtime', 'ERR_LINUX_RUNTIME_CONFIG');
  }
  for (const field of [
    'supervisor', 'dockerd', 'cgroupExec', 'iptables', 'ip6tables', 'sentinel',
    'taskIsolationProbe', 'providerBroker', 'readinessProbe', 'evidenceCollector', 'runner', 'harbor', 'daemonRoot',
  ]) sha(topology.hashes[field], `hashes.${field}`);
  const identities = topology.identities;
  for (const field of ['supervisorUid', 'runnerUid', 'runnerGid', 'brokerUid', 'brokerGid', 'brokerClientGid']) {
    integer(identities[field], `identities.${field}`, 0, 65_535);
  }
  if (identities.supervisorUid !== 0
      || identities.runnerUid !== 2001
      || identities.runnerGid !== 2001
      || identities.brokerUid !== 2002
      || identities.brokerGid !== 2002
      || identities.brokerClientGid === 0
      || identities.brokerClientGid === identities.brokerGid) {
    fail('runtime identities must be root/2001/2002 with a distinct broker-client group', 'ERR_LINUX_RUNTIME_CONFIG');
  }
  safeId(topology.cgroup.id, 'cgroup.id');
  absolute(topology.cgroup.path, 'cgroup.path', { below: '/sys/fs/cgroup' });
  sha(topology.cgroup.pathHash, 'cgroup.pathHash');
  boundedString(topology.cgroup.cpuMax, 'cgroup.cpuMax', 64);
  integer(topology.cgroup.memoryMax, 'cgroup.memoryMax', 64 * 1024 * 1024, TEN_GIB);
  integer(topology.cgroup.pidsMax, 'cgroup.pidsMax', 16, 65_535);
  integer(topology.custody.evidenceRetentionDays, 'custody.evidenceRetentionDays', 1, 30);
  for (const field of ['daemonReadyMs', 'brokerReadyMs', 'helperMs', 'shutdownMs']) {
    integer(topology.timeouts[field], `timeouts.${field}`, 1_000, 60_000);
  }
  if (typeof topology.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(topology.imageDigest)) {
    fail('imageDigest must be immutable', 'ERR_LINUX_RUNTIME_CONFIG');
  }
  return topology;
}

function validateDriver(driver) {
  if (!plainObject(driver)) fail('Linux runtime driver is required', 'ERR_LINUX_RUNTIME_CONFIG');
  for (const method of REQUIRED_DRIVER) {
    if (typeof driver[method] !== 'function') fail(`Linux runtime driver is missing ${method}`, 'ERR_LINUX_RUNTIME_CONFIG');
  }
  return driver;
}

function validateSocket(observation, expected, label) {
  if (!plainObject(observation)
      || observation.path !== expected.path
      || observation.kind !== 'socket'
      || observation.real !== true
      || observation.ownerUid !== expected.uid
      || observation.groupGid !== expected.gid
      || observation.mode !== expected.mode) {
    fail(`${label} socket identity or access policy drifted`, 'ERR_LINUX_RUNTIME_SOCKET');
  }
  return observation;
}

function validatePlatform(observed, topology) {
  if (!plainObject(observed)
      || observed.platform !== 'linux'
      || observed.effectiveUid !== 0
      || observed.sandboxId !== topology.sandboxId
      || observed.sandboxBootId !== topology.sandboxBootId
      || observed.supervisorExecutableHash !== topology.hashes.supervisor
      || observed.cgroupVersion !== 2
      || observed.cgroupDelegated !== true) {
    fail('Linux/root/cgroup/sandbox identity is not trusted', 'ERR_LINUX_RUNTIME_PLATFORM');
  }
  const storage = observed.filesystem;
  if (!plainObject(storage)
      || storage.sandboxRootId !== topology.filesystem.id
      || storage.boundedRootId !== topology.filesystem.id
      || storage.sandboxRootBytes !== TEN_GIB
      || storage.boundedRootBytes !== TEN_GIB
      || storage.defaultDockerRootId !== topology.filesystem.defaultDockerRootId
      || storage.defaultDockerRootId === storage.boundedRootId
      || storage.privateDaemonDataRoot !== topology.paths.daemonDataRoot) {
    fail('private daemon storage is not the exact bounded filesystem', 'ERR_LINUX_RUNTIME_STORAGE');
  }
  if (!sameJson(observed.identities, topology.identities)
      || !['inherited-pipe', 'inherited-socket'].includes(observed.controlChannel?.kind)
      || observed.controlChannel.authenticated !== true
      || observed.controlChannel.open !== true
      || observed.providerCredentialsAbsent !== true
      || observed.daytonaCredentialsAbsent !== true) {
    fail('privilege or credential custody drifted', 'ERR_LINUX_RUNTIME_CUSTODY');
  }
  if (observed.custody?.coreDumpsDisabled !== true
      || observed.custody.evidenceStoreOwnerUid !== 0
      || observed.custody.evidenceStoreMode !== 0o700
      || observed.custody.evidenceRetentionDays !== topology.custody.evidenceRetentionDays
      || observed.custody.snapshotCredentialExclusion !== true) {
    fail('evidence custody drifted', 'ERR_LINUX_RUNTIME_CUSTODY');
  }
  return clone(observed, 'platform observation');
}

function validateReadiness(value, topology, { phase, baseline }) {
  credentialFree(value, 'readiness observation');
  const trueFields = [
    value.cgroup?.populated,
    value.cgroup?.controllersEnforced,
    value.noProviderProbe?.completed,
    value.noProviderProbe?.genericMountPassed,
    value.noProviderProbe?.harnessMountPassed,
    value.noProviderProbe?.providerCredentialAbsent,
    value.storageProbe?.enospcObserved,
    value.storageProbe?.evidenceHeadroomRecovered,
    value.runner?.privateDaemonDenied,
    value.runner?.realDaemonDenied,
    value.runner?.alternateDaemonDenied,
    value.runner?.mountDenied,
    value.runner?.ptraceDenied,
    value.runner?.providerEgressDenied,
    value.runner?.metadataDenied,
    value.runner?.daytonaCredentialsAbsent,
    value.runner?.providerCredentialsAbsent,
    value.task?.networkNone,
    value.task?.readOnlyRoot,
    value.task?.capabilitiesDropped,
    value.task?.noNewPrivileges,
  ];
  if (trueFields.some((field) => field !== true)
      || value.cgroup?.id !== topology.cgroup.id
      || value.cgroup?.pathHash !== topology.cgroup.pathHash
      || value.cgroup?.runnerUid !== topology.identities.runnerUid
      || value.noProviderProbe?.imageDigest !== topology.imageDigest
      || value.noProviderProbe?.providerCalls !== 0
      || value.storageProbe?.filesystemId !== topology.filesystem.id
      || value.storageProbe?.totalBytes !== TEN_GIB
      || value.runner?.uid !== topology.identities.runnerUid
      || value.runner?.effectiveCapabilities !== 0
      || value.task?.brokerReachable !== false
      || value.task?.brokerSocketMounted !== false
      || value.task?.brokerClientGidPresent !== false
      || value.executables?.runnerExecutableHash !== topology.hashes.runner
      || value.executables?.harborExecutableHash !== topology.hashes.harbor) {
    fail(`${phase} readiness probe failed closed`, 'ERR_LINUX_RUNTIME_READINESS');
  }
  if (phase === 'post-broker'
      && (value.broker?.uid !== topology.identities.brokerUid
        || value.broker?.onlyProviderEgress !== true)) {
    fail('post-broker egress identity drifted', 'ERR_LINUX_RUNTIME_READINESS');
  }
  if (baseline && (!sameJson(value.noProviderProbe, baseline.noProviderProbe)
      || !sameJson(value.storageProbe, baseline.storageProbe)
      || !sameJson(value.task, baseline.task)
      || !sameJson(value.executables, baseline.executables))) {
    fail('post-broker readiness drifted from the pre-broker observation', 'ERR_LINUX_RUNTIME_READINESS');
  }
  return clone(value, 'readiness observation');
}

function validateFinalEvidence(value, topology) {
  credentialFree(value, 'final runtime evidence');
  const docker = value?.docker;
  const mounts = value?.mounts;
  const cgroup = value?.cgroup;
  const resources = value?.resources;
  const network = value?.network;
  const provider = value?.provider;
  const cleanup = value?.cleanup;
  for (const digest of [docker?.eventsHash, docker?.containerIdHash, mounts?.inventoryHash,
    cgroup?.evidenceHash, resources?.evidenceHash, network?.evidenceHash,
    provider?.usageHash, provider?.identityHash]) {
    if (!HASH.test(String(digest))) fail('final evidence contains an invalid digest', 'ERR_LINUX_RUNTIME_EVIDENCE');
  }
  if (value.harbor?.completed !== true
      || value.harbor?.executableHash !== topology.hashes.harbor
      || docker?.eventsComplete !== true
      || docker?.policyCompliant !== true
      || docker?.imageDigest !== topology.imageDigest
      || docker?.containersRemaining !== 0
      || docker?.networksRemaining !== 0
      || docker?.volumesRemaining !== 0
      || mounts?.policyCompliant !== true
      || mounts?.outsideAllowedWrites !== false
      || mounts?.daemonRootFilesystemId !== topology.filesystem.id
      || mounts?.workspaceFilesystemId !== topology.filesystem.id
      || cgroup?.id !== topology.cgroup.id
      || cgroup?.pathHash !== topology.cgroup.pathHash
      || cgroup?.populated !== false
      || cgroup?.processesRemaining !== 0
      || cgroup?.limitsEnforced !== true
      || resources?.cpuWithinLimit !== true
      || resources?.memoryWithinLimit !== true
      || resources?.pidsWithinLimit !== true
      || resources?.oomKilled !== false
      || network?.taskNetworkNone !== true
      || network?.runnerEgressDenied !== true
      || network?.brokerOnlyEgress !== true
      || network?.metadataDenied !== true
      || network?.rawSocketDenied !== true
      || provider?.billingCertain !== true
      || provider?.budgetComplete !== true
      || provider?.withinTrialCeiling !== true
      || cleanup?.completed !== true
      || cleanup?.containersRemaining !== 0
      || cleanup?.networksRemaining !== 0
      || cleanup?.volumesRemaining !== 0
      || cleanup?.processesRemaining !== 0
      || cleanup?.cgroupPopulated !== false) {
    fail('final runtime event or inventory evidence is incomplete', 'ERR_LINUX_RUNTIME_EVIDENCE');
  }
  return clone(value, 'final runtime evidence');
}

function canonicalInstant(value, label) {
  try {
    const instant = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    if (!instant || instant === 'Invalid Date') throw new Error('invalid instant');
    return instant;
  } catch {
    fail(`${label} is not a canonical runtime instant`, 'ERR_LINUX_RUNTIME_EVIDENCE');
  }
}

function proxyHandoffObservation(instance, topology) {
  if (!instance || typeof instance.auditSnapshot !== 'function') {
    fail('Docker proxy audit evidence is unavailable', 'ERR_LINUX_RUNTIME_EVIDENCE');
  }
  const audit = clone(instance.auditSnapshot(), 'Docker proxy audit evidence');
  credentialFree(audit, 'Docker proxy audit evidence');
  if (audit.complete !== true
      || !HASH.test(String(audit.evidenceHash))
      || !Array.isArray(audit.events)
      || !plainObject(audit.state)
      || audit.state.cleanupComplete !== true
      || audit.state.containerBound !== false
      || audit.state.createPending !== false
      || audit.state.execBindingCount !== 0
      || audit.state.leaseTerminated !== true) {
    fail('Docker proxy audit is incomplete', 'ERR_LINUX_RUNTIME_EVIDENCE');
  }
  const bound = audit.events
    .filter((event) => event?.phase === 'state' && event.action === 'container-bound')
    .map((event) => event.bindingHash);
  const cleaned = audit.events
    .filter((event) => event?.phase === 'state' && event.action === 'container-cleaned')
    .map((event) => event.bindingHash);
  const identities = [...new Set([...bound, ...cleaned])];
  if (bound.length !== 1
      || cleaned.length !== 1
      || identities.length !== 1
      || !HASH.test(String(identities[0]))) {
    fail('Docker proxy container identity evidence is incomplete', 'ERR_LINUX_RUNTIME_EVIDENCE');
  }
  return {
    eventsHash: audit.evidenceHash,
    eventsComplete: true,
    containerIdHash: identities[0],
    imageDigest: topology.imageDigest,
    policyCompliant: true,
  };
}

function validateTrialMaterialization(value, contract, topology) {
  const receipt = clone(value, 'trial security materialization');
  const expectedFields = [
    'schema', 'trialId', 'runtimeRoot', 'contractHash', 'composeHash', 'imageDigest',
    'seedContainerIdHash', 'workspaceInventoryHash', 'workspaceFilesystemId',
    'workspaceFileCount', 'workspaceContentBytes', 'writableRootsHash',
    'observedPolicy', 'receiptHash',
  ];
  if (!plainObject(receipt)
      || Object.keys(receipt).length !== expectedFields.length
      || expectedFields.some((field) => !Object.prototype.hasOwnProperty.call(receipt, field))) {
    fail('trial security materialization schema drifted', 'ERR_LINUX_RUNTIME_MATERIALIZATION');
  }
  const { receiptHash, ...unsigned } = receipt;
  if (receipt.schema !== TRIAL_SECURITY_MATERIALIZATION_SCHEMA
      || receipt.trialId !== contract.identity.trialId
      || receipt.runtimeRoot !== contract.identity.runtimeRoot
      || receipt.contractHash !== evidenceHash(contract)
      || receipt.composeHash !== contract.composeHash
      || receipt.imageDigest !== topology.imageDigest
      || receipt.workspaceFilesystemId !== topology.filesystem.id
      || receipt.receiptHash !== evidenceHash(unsigned)
      || !Number.isSafeInteger(receipt.workspaceFileCount)
      || receipt.workspaceFileCount < 1
      || !Number.isSafeInteger(receipt.workspaceContentBytes)
      || receipt.workspaceContentBytes < 1
      || !plainObject(receipt.observedPolicy)
      || !sameJson(receipt.observedPolicy, {
        pullPolicy: 'never',
        platform: 'linux/amd64',
        networkMode: 'none',
        readOnlyRootfs: true,
        containerStarted: false,
      })) {
    fail('trial security materialization identity drifted', 'ERR_LINUX_RUNTIME_MATERIALIZATION');
  }
  for (const field of [
    'contractHash', 'composeHash', 'seedContainerIdHash', 'workspaceInventoryHash',
    'writableRootsHash', 'receiptHash',
  ]) sha(receipt[field], `trial materialization ${field}`);
  return receipt;
}

async function guarded(label, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LinuxRuntimeEffectsError) throw error;
    throw new LinuxRuntimeEffectsError(`${label} failed closed`);
  }
}

function executableHashMap(topology) {
  return new Map([
    [topology.executables.supervisor, topology.hashes.supervisor],
    [topology.executables.dockerd, topology.hashes.dockerd],
    [topology.executables.cgroupExec, topology.hashes.cgroupExec],
    [topology.executables.taskIsolationProbe, topology.hashes.taskIsolationProbe],
    [topology.executables.iptables, topology.hashes.iptables],
    [topology.executables.ip6tables, topology.hashes.ip6tables],
    [topology.executables.sentinel, topology.hashes.sentinel],
    [topology.executables.providerBroker, topology.hashes.providerBroker],
    [topology.executables.readinessProbe, topology.hashes.readinessProbe],
    [topology.executables.evidenceCollector, topology.hashes.evidenceCollector],
    [topology.executables.runner, topology.hashes.runner],
    [topology.executables.harbor, topology.hashes.harbor],
  ]);
}

/**
 * Build the effect object consumed directly by createRuntimeSupervisor().
 */
export function createLinuxRuntimeEffects({
  topology: rawTopology,
  driver: suppliedDriver,
  dockerProxyFactory = createDockerPolicyProxy,
  taskSecurityMaterializer = materializeTrialSecurity,
  taskContainerObserver = observeLiveTaskContainer,
  taskReceiptPublisher = publishTaskRuntimeReceipts,
} = {}) {
  const topology = validateTopology(rawTopology);
  const driver = validateDriver(suppliedDriver ?? createNodeLinuxDriver(topology));
  if (typeof dockerProxyFactory !== 'function') fail('Docker proxy factory is required', 'ERR_LINUX_RUNTIME_CONFIG');
  if (typeof taskSecurityMaterializer !== 'function') {
    fail('trial security materializer is required', 'ERR_LINUX_RUNTIME_CONFIG');
  }
  if (typeof taskContainerObserver !== 'function' || typeof taskReceiptPublisher !== 'function') {
    fail('task namespace evidence producers are required', 'ERR_LINUX_RUNTIME_CONFIG');
  }

  let platform;
  let reserve;
  let daemonHandle;
  let sentinelHandle;
  let proxyInstance;
  let brokerHandle;
  let runnerHandle;
  let daemonObservation;
  let proxyObservation;
  let securityMaterialization;
  let securityContract;
  let liveTaskObservation;
  let taskReceiptPublication;
  let brokerObservation;
  let installedNetworkPolicy;
  let networkPolicyObservation;
  let preBrokerReadiness;
  let providerFd = null;
  let providerFdClosed = false;
  let runnerResult;
  let detachLossHandler;
  let shutdownStarted = false;
  let controlChannel;
  let activeTrialId = null;
  let activeRequestHash = null;
  let lifecycleEpoch = 0;
  let lifecycleInvalidated = false;
  let activeLifecycleTransition = null;
  const producerSessionId = crypto.randomBytes(32).toString('hex');

  function bindTrial(trialId) {
    safeId(trialId, 'trialId');
    if (activeTrialId === null) activeTrialId = trialId;
    if (trialId !== activeTrialId) {
      fail('runtime trial lifecycle binding drifted', 'ERR_LINUX_RUNTIME_LIFECYCLE');
    }
  }

  function bindRequest(requestHash) {
    sha(requestHash, 'requestHash');
    if (activeRequestHash === null) activeRequestHash = requestHash;
    if (requestHash !== activeRequestHash) {
      fail('runtime request lifecycle binding drifted', 'ERR_LINUX_RUNTIME_LIFECYCLE');
    }
  }

  function guardedLifecycleTransition(label, operation) {
    if (lifecycleInvalidated || shutdownStarted || activeLifecycleTransition) {
      fail('runtime lifecycle transition is unavailable', 'ERR_LINUX_RUNTIME_LIFECYCLE');
    }
    const claim = { epoch: lifecycleEpoch };
    const transition = { claim, promise: null };
    activeLifecycleTransition = transition;
    const promise = guarded(label, () => operation(claim)).finally(() => {
      if (activeLifecycleTransition === transition) activeLifecycleTransition = null;
    });
    transition.promise = promise;
    return promise;
  }

  function assertLifecycleTransition(claim) {
    if (lifecycleInvalidated
        || shutdownStarted
        || activeLifecycleTransition?.claim !== claim
        || claim.epoch !== lifecycleEpoch) {
      fail('runtime lifecycle transition lost custody', 'ERR_LINUX_RUNTIME_LIFECYCLE');
    }
  }

  function invalidateLifecycle() {
    if (lifecycleInvalidated) return;
    lifecycleInvalidated = true;
    lifecycleEpoch += 1;
  }

  async function drainLifecycleTransition() {
    const transition = activeLifecycleTransition;
    if (!transition?.promise) return;
    try { await transition.promise; } catch { /* fail-stop continues after the transition drains */ }
  }

  async function bindControlChannel(value) {
    return guarded('control channel binding', async () => {
      if (controlChannel || platform || !plainObject(value)) {
        fail('control channel lifecycle is invalid', 'ERR_LINUX_RUNTIME_CONTROL_CHANNEL');
      }
      const expected = new Set([
        'schema', 'kind', 'kernelBound', 'authenticated', 'open', 'receiptHash',
        'inputDescriptorHash', 'outputDescriptorHash', 'stream',
      ]);
      const keys = Object.keys(value);
      if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
          value.schema !== 'engineer-authenticated-control-channel.v1' ||
          !['inherited-pipe', 'inherited-socket'].includes(value.kind) ||
          value.kernelBound !== true || value.authenticated !== true || value.open !== true ||
          !value.stream || typeof value.stream.once !== 'function' || value.stream.destroyed === true) {
        fail('control channel is not a live authenticated inherited transport',
          'ERR_LINUX_RUNTIME_CONTROL_CHANNEL');
      }
      for (const field of ['receiptHash', 'inputDescriptorHash', 'outputDescriptorHash']) {
        sha(value[field], `control channel ${field}`);
      }
      controlChannel = value;
      return {
        schema: value.schema,
        kind: value.kind,
        authenticated: true,
        receiptHash: value.receiptHash,
      };
    });
  }

  async function inspectPlatform() {
    return guarded('platform inspection', async () => {
      if (!controlChannel) {
        fail('live control channel must be bound before platform inspection',
          'ERR_LINUX_RUNTIME_CONTROL_CHANNEL');
      }
      const observed = validatePlatform(await driver.inspectHost({ topology, controlChannel }), topology);
      for (const [file, expected] of executableHashMap(topology)) {
        const actual = await driver.hashExecutable(file);
        if (actual !== expected) fail('trusted runtime executable identity drifted', 'ERR_LINUX_RUNTIME_EXECUTABLE');
      }
      platform = observed;
      return clone(observed, 'platform observation');
    });
  }

  async function inspectProviderKeyFd(fd) {
    return guarded('provider descriptor inspection', async () => {
      integer(fd, 'provider key descriptor', 3, 1_048_575);
      const observation = await driver.inspectDescriptor(fd);
      if (!plainObject(observation)
          || !['pipe', 'socket'].includes(observation.kind)
          || observation.open !== true) {
        fail('provider key descriptor is not an inherited pipe or socket', 'ERR_LINUX_RUNTIME_DESCRIPTOR');
      }
      providerFd = fd;
      providerFdClosed = false;
      return { kind: observation.kind, open: true };
    });
  }

  async function reserveEvidenceHeadroom({ bytes, filesystemId, trialId }) {
    return guarded('evidence reservation', async () => {
      if (!platform) fail('platform must be inspected before reserving evidence');
      integer(bytes, 'evidence reserve bytes', 64 * 1024 * 1024, TEN_GIB - 1);
      if (filesystemId !== topology.filesystem.id) fail('evidence reserve filesystem drifted');
      bindTrial(trialId);
      const directory = await driver.prepareDirectory({
        path: topology.paths.evidenceDirectory,
        uid: 0,
        gid: 0,
        mode: 0o700,
      });
      if (directory?.real !== true || directory.ownerUid !== 0 || directory.mode !== 0o700) {
        fail('evidence directory is not root-owned and private');
      }
      const observation = await driver.reserveEvidence({
        path: topology.paths.evidenceReserve,
        bytes,
        filesystemId,
        uid: 0,
        gid: 0,
        mode: 0o600,
        trialId,
      });
      if (observation?.bytes < bytes
          || observation.filesystemId !== topology.filesystem.id
          || observation.protectedFromRunner !== true) {
        fail('evidence headroom was not physically reserved on bounded storage');
      }
      reserve = { ...observation, path: topology.paths.evidenceReserve };
      return {
        bytes: observation.bytes,
        filesystemId: observation.filesystemId,
        protectedFromRunner: true,
      };
    });
  }

  async function startPrivateDaemon(options) {
    return guarded('private daemon startup', async () => {
      if (!platform || !reserve) fail('private daemon prerequisites are incomplete');
      if (!plainObject(options)
          || options.dataRoot !== topology.paths.daemonDataRoot
          || options.expectedDaemonId !== topology.daemonId
          || options.expectedFilesystemId !== topology.filesystem.id
          || options.sandboxId !== topology.sandboxId) {
        fail('private daemon signed binding drifted');
      }
      bindTrial(options.trialId);
      const runtimeDirectory = await driver.prepareDirectory({
        path: topology.paths.runtimeDirectory,
        uid: 0,
        gid: topology.identities.brokerClientGid,
        mode: 0o710,
      });
      if (runtimeDirectory?.real !== true
          || runtimeDirectory.ownerUid !== 0
          || runtimeDirectory.groupGid !== topology.identities.brokerClientGid
          || runtimeDirectory.mode !== 0o710) {
        fail('runtime socket parent is not narrowly traversable by the shared client group');
      }
      await driver.prepareDirectory({ path: topology.paths.daemonDataRoot, uid: 0, gid: 0, mode: 0o700 });
      const cgroup = await driver.ensureCgroup({
        ...topology.cgroup,
        ownerUid: 0,
        ownerGid: 0,
        runnerUid: topology.identities.runnerUid,
      });
      if (cgroup?.id !== topology.cgroup.id
          || cgroup.pathHash !== topology.cgroup.pathHash
          || cgroup.limitsEnforced !== true
          || cgroup.writableByRunner !== false) {
        fail('cgroup v2 custody or limits drifted', 'ERR_LINUX_RUNTIME_CGROUP');
      }
      const networkPolicy = await driver.installNetworkPolicy({
        runnerUid: topology.identities.runnerUid,
        brokerUid: topology.identities.brokerUid,
        iptables: topology.executables.iptables,
        ip6tables: topology.executables.ip6tables,
        providerHostname: EXACT_PROVIDER_HOSTNAME,
        providerHttpsPort: EXACT_PROVIDER_HTTPS_PORT,
        metadataCidrs: [...EXACT_METADATA_CIDRS],
      });
      if (networkPolicy?.runnerEgressDenied !== true
          || networkPolicy.metadataDenied !== true
          || networkPolicy.rawSocketDenied !== true
          || networkPolicy.brokerOnlyEgress !== true) {
        fail('broker-only network policy was not installed', 'ERR_LINUX_RUNTIME_NETWORK');
      }
      installedNetworkPolicy = clone({
        providerAddresses: networkPolicy.providerAddresses,
        dnsServers: networkPolicy.dnsServers,
      }, 'installed network policy destinations');
      sentinelHandle = await driver.spawnProcess({
        role: 'cgroup-sentinel',
        file: topology.executables.sentinel,
        args: ['86400'],
        cwd: '/',
        env: SUPPORT_ENV,
        uid: topology.identities.runnerUid,
        gid: topology.identities.runnerGid,
        supplementaryGids: [],
        cgroupPath: topology.cgroup.path,
        inheritedFds: [],
        maxOutputBytes: 0,
        shell: false,
      });
      if (typeof driver.adoptPrivateDaemon === 'function') {
        const adopted = await driver.adoptPrivateDaemon({
          daemonId: topology.daemonId,
          sandboxBootId: topology.sandboxBootId,
          filesystemId: topology.filesystem.id,
          defaultDockerRootId: topology.filesystem.defaultDockerRootId,
          dataRoot: topology.paths.daemonDataRoot,
          socketPath: topology.paths.daemonSocket,
          dockerdPath: topology.executables.dockerd,
          dockerdSha256: topology.hashes.dockerd,
        });
        if (!plainObject(adopted) || !plainObject(adopted.handle) ||
            adopted.daemonId !== topology.daemonId ||
            adopted.sandboxBootId !== topology.sandboxBootId ||
            adopted.filesystemId !== topology.filesystem.id ||
            adopted.defaultDockerRootId !== topology.filesystem.defaultDockerRootId ||
            adopted.dataRoot !== topology.paths.daemonDataRoot ||
            adopted.socketPath !== topology.paths.daemonSocket ||
            adopted.socketOwnerUid !== 0 || adopted.socketOwnerGid !== 0 ||
            adopted.socketMode !== 0o600 || adopted.exclusive !== true) {
          fail('private daemon adoption receipt drifted', 'ERR_LINUX_RUNTIME_DAEMON');
        }
        daemonHandle = adopted.handle;
      } else {
        const args = [
          '--host', `unix://${topology.paths.daemonSocket}`,
          '--data-root', topology.paths.daemonDataRoot,
          '--exec-root', topology.paths.daemonExecRoot,
          '--pidfile', topology.paths.daemonPidFile,
          '--bridge', 'none',
          '--iptables=false',
          '--ip-forward=false',
          '--ip-masq=false',
          '--userland-proxy=false',
          '--log-level', 'error',
        ];
        daemonHandle = await driver.spawnProcess({
          role: 'private-daemon',
          file: topology.executables.dockerd,
          args,
          cwd: '/',
          env: SUPPORT_ENV,
          uid: 0,
          gid: 0,
          supplementaryGids: [],
          cgroupPath: null,
          inheritedFds: [],
          maxOutputBytes: MAX_CHILD_OUTPUT_BYTES,
          shell: false,
        });
        await driver.waitForSocket({
          path: topology.paths.daemonSocket,
          process: daemonHandle,
          timeoutMs: topology.timeouts.daemonReadyMs,
        });
      }
      await driver.setSocketPolicy({ path: topology.paths.daemonSocket, uid: 0, gid: 0, mode: 0o600 });
      validateSocket(await driver.inspectSocket(topology.paths.daemonSocket), {
        path: topology.paths.daemonSocket, uid: 0, gid: 0, mode: 0o600,
      }, 'private daemon');
      daemonObservation = {
        daemonId: topology.daemonId,
        dataRootHash: topology.hashes.daemonRoot,
        filesystemId: topology.filesystem.id,
        socketPath: topology.paths.daemonSocket,
        socketOwnerUid: 0,
        socketGroupGid: 0,
        socketMode: 0o600,
        exclusive: true,
      };
      return clone(daemonObservation);
    });
  }

  async function startDockerProxy(options) {
    return guarded('Docker policy proxy startup', async () => {
      if (!daemonObservation || proxyInstance) fail('Docker proxy lifecycle is invalid');
      if (!plainObject(options)
          || options.upstreamSocketPath !== topology.paths.daemonSocket
          || options.runnerUid !== topology.identities.runnerUid
          || options.runnerGid !== topology.identities.runnerGid) {
        fail('Docker proxy identity binding drifted');
      }
      bindTrial(options.trialId);
      bindRequest(options.requestHash);
      credentialFree(options.policy, 'Docker proxy policy');
      const contract = createTrialSecurityContract({
        trialId: options.trialId,
        immutableImage: options.policy?.pinnedImage,
        cpus: options.policy?.resources?.nanoCpus / 1_000_000_000,
        memoryMb: options.policy?.resources?.memoryBytes / (1024 * 1024),
        pidsLimit: options.policy?.resources?.pidsLimit,
      });
      const allowedBindSets = archivedConditionReadOnlyBindVariants(options.condition).map((variant) => [
        ...contract.docker.allowedBinds,
        ...variant.map((mount) => `${mount.source}:${mount.target}:ro`),
      ]);
      for (const field of [
        'leaseId', 'composeProject', 'containerName', 'leaseLabel', 'pinnedImage',
        'resources', 'requireReadOnlyRootfs', 'allowedBinds', 'allowedMounts',
      ]) {
        if (!sameJson(options.policy?.[field], contract.docker[field])) {
          fail('Docker proxy policy drifted from the trial security contract',
            'ERR_LINUX_RUNTIME_MATERIALIZATION');
        }
      }
      if (!sameJson(options.policy?.allowedBindSets, allowedBindSets)
          || !sameJson(options.policy?.allowedArchivePaths, ['/app', '/tests', '/tmp'])) {
        fail('Docker proxy policy drifted from the trial security contract',
          'ERR_LINUX_RUNTIME_MATERIALIZATION');
      }
      if (!installedNetworkPolicy) fail('network policy lifecycle is incomplete', 'ERR_LINUX_RUNTIME_NETWORK');
      networkPolicyObservation = createRuntimeNetworkPolicyReceipt({
        runnerUid: topology.identities.runnerUid,
        brokerUid: topology.identities.brokerUid,
        providerHostname: EXACT_PROVIDER_HOSTNAME,
        providerHttpsPort: EXACT_PROVIDER_HTTPS_PORT,
        providerAddresses: installedNetworkPolicy.providerAddresses,
        dnsServers: installedNetworkPolicy.dnsServers,
        metadataCidrs: [...EXACT_METADATA_CIDRS],
        iptablesExecutableHash: topology.hashes.iptables,
        ip6tablesExecutableHash: topology.hashes.ip6tables,
        producerExecutableHash: topology.hashes.supervisor,
        sandboxId: platform.sandboxId,
        sandboxBootId: platform.sandboxBootId,
        requestHash: activeRequestHash,
        trialId: activeTrialId,
        producerSessionId,
      });
      validateSocket(await driver.inspectSocket(topology.paths.daemonSocket), {
        path: topology.paths.daemonSocket, uid: 0, gid: 0, mode: 0o600,
      }, 'private daemon');
      securityMaterialization = validateTrialMaterialization(
        taskSecurityMaterializer(contract),
        contract,
        topology,
      );
      securityContract = contract;
      proxyInstance = dockerProxyFactory({
        listenSocketPath: topology.paths.proxySocket,
        upstreamSocketPath: topology.paths.daemonSocket,
        policy: options.policy,
        onContainerStarted: async ({ containerId, containerBindingHash } = {}) => {
          if (!securityContract || !securityMaterialization || liveTaskObservation
              || !brokerObservation || !networkPolicyObservation) {
            fail('live task observation occurred outside the broker-bound trial lifecycle',
              'ERR_LINUX_RUNTIME_EVIDENCE');
          }
          liveTaskObservation = await taskContainerObserver({
            containerId,
            containerBindingHash,
            contract: securityContract,
            allowedBindSets: options.policy.allowedBindSets ?? [options.policy.allowedBinds ?? []],
            materialization: securityMaterialization,
            imageDigest: topology.imageDigest,
            probeExecutableHash: topology.hashes.taskIsolationProbe,
          });
          credentialFree(liveTaskObservation, 'live task observation');
        },
      });
      if (!proxyInstance || typeof proxyInstance.start !== 'function' || typeof proxyInstance.close !== 'function') {
        fail('Docker proxy factory returned an invalid boundary');
      }
      await proxyInstance.start();
      await driver.setSocketPolicy({
        path: topology.paths.proxySocket,
        uid: 0,
        gid: topology.identities.runnerGid,
        mode: 0o660,
      });
      validateSocket(await driver.inspectSocket(topology.paths.proxySocket), {
        path: topology.paths.proxySocket,
        uid: 0,
        gid: topology.identities.runnerGid,
        mode: 0o660,
      }, 'Docker proxy');
      proxyObservation = {
        socketPath: topology.paths.proxySocket,
        socketOwnerUid: 0,
        socketGroupGid: topology.identities.runnerGid,
        socketMode: 0o660,
        policyHash: evidenceHash(options.policy),
        nonBypassable: true,
        realDaemonDenied: true,
      };
      return clone(proxyObservation);
    });
  }

  async function inspectReadiness(options) {
    return guarded(`${options?.phase ?? 'unknown'} readiness`, async () => {
      if (!platform || !daemonObservation || !proxyObservation) fail('readiness prerequisites are incomplete');
      if (!plainObject(options) || !['pre-broker', 'post-broker'].includes(options.phase)) {
        fail('readiness phase is invalid');
      }
      bindRequest(options.requestHash);
      bindTrial(networkPolicyObservation.trialId);
      validateSocket(await driver.inspectSocket(topology.paths.daemonSocket), {
        path: topology.paths.daemonSocket, uid: 0, gid: 0, mode: 0o600,
      }, 'private daemon');
      validateSocket(await driver.inspectSocket(topology.paths.proxySocket), {
        path: topology.paths.proxySocket, uid: 0, gid: topology.identities.runnerGid, mode: 0o660,
      }, 'Docker proxy');
      if (options.phase === 'post-broker') {
        if (!brokerObservation) fail('post-broker readiness has no broker');
        const parent = await driver.inspectPath(topology.paths.brokerDirectory);
        const policyParent = await driver.inspectPath(topology.paths.brokerPolicyDirectory);
        const policyFile = await driver.inspectPath(topology.paths.brokerPolicy);
        if (parent?.kind !== 'directory'
            || parent.real !== true
            || parent.ownerUid !== topology.identities.brokerUid
            || parent.groupGid !== topology.identities.brokerClientGid
            || parent.mode !== 0o2710
            || policyParent?.kind !== 'directory'
            || policyParent.real !== true
            || policyParent.ownerUid !== topology.identities.brokerUid
            || policyParent.groupGid !== topology.identities.brokerGid
            || policyParent.mode !== 0o700
            || policyFile?.kind !== 'file'
            || policyFile.real !== true
            || policyFile.ownerUid !== topology.identities.brokerUid
            || policyFile.groupGid !== topology.identities.brokerGid
            || policyFile.mode !== 0o600) {
          fail('post-broker directory or policy custody drifted', 'ERR_LINUX_RUNTIME_SOCKET');
        }
        validateSocket(await driver.inspectSocket(topology.paths.brokerSocket), {
          path: topology.paths.brokerSocket,
          uid: topology.identities.brokerUid,
          gid: topology.identities.brokerClientGid,
          mode: 0o660,
        }, 'provider broker');
      }
      const handoff = createRuntimeProbeHandoff({
        requestHash: options.requestHash,
        phase: options.phase,
        observedAt: canonicalInstant(driver.now(), 'readiness handoff observation'),
        brokerInstalled: options.phase === 'post-broker',
        topology: {
          imageDigest: topology.imageDigest,
          filesystemId: topology.filesystem.id,
          filesystemBytes: topology.filesystem.expectedBytes,
          cgroupId: topology.cgroup.id,
          cgroupPathHash: topology.cgroup.pathHash,
          runnerUid: topology.identities.runnerUid,
          brokerUid: topology.identities.brokerUid,
          runnerExecutableHash: topology.hashes.runner,
          harborExecutableHash: topology.hashes.harbor,
        },
        paths: {
          sandboxRoot: topology.filesystem.boundedRoot,
          daemonSocket: topology.paths.daemonSocket,
          proxySocket: topology.paths.proxySocket,
          brokerSocket: topology.paths.brokerSocket,
          cgroup: topology.cgroup.path,
          evidenceReserve: topology.paths.evidenceReserve,
        },
        resources: {
          evidenceReserveBytes: reserve.bytes,
          cpuMax: topology.cgroup.cpuMax,
          memoryMax: topology.cgroup.memoryMax,
          pidsMax: topology.cgroup.pidsMax,
        },
        networkPolicy: clone(networkPolicyObservation, 'network policy observation'),
      });
      const observation = await driver.runReadinessProbe({
        file: topology.executables.readinessProbe,
        args: [
          '--phase', options.phase,
          '--sandbox-root', topology.filesystem.boundedRoot,
          '--daemon-socket', topology.paths.daemonSocket,
          '--proxy-socket', topology.paths.proxySocket,
          '--broker-socket', topology.paths.brokerSocket,
          '--cgroup', topology.cgroup.path,
          '--image-digest', topology.imageDigest,
        ],
        env: SUPPORT_ENV,
        timeoutMs: topology.timeouts.helperMs,
        maxOutputBytes: MAX_HELPER_OUTPUT_BYTES,
        handoff,
        shell: false,
      });
      const verified = validateReadiness(observation, topology, {
        phase: options.phase,
        baseline: options.phase === 'post-broker' ? preBrokerReadiness : null,
      });
      if (options.phase === 'pre-broker') preBrokerReadiness = verified;
      return clone(verified);
    });
  }

  async function startProviderBroker(options) {
    return guardedLifecycleTransition('provider broker startup', async (transition) => {
      if (!preBrokerReadiness || brokerHandle || providerFd === null || providerFdClosed) {
        fail('provider broker one-shot prerequisites are incomplete');
      }
      if (!plainObject(options)
          || options.providerKeyFd !== providerFd
          || options.brokerUid !== topology.identities.brokerUid
          || options.brokerGid !== topology.identities.brokerGid
          || options.sharedGid !== topology.identities.brokerClientGid) {
        fail('provider broker privilege binding drifted');
      }
      sha(options.leaseHash, 'leaseHash');
      bindRequest(options.requestHash);
      safeId(options.leaseId, 'leaseId');
      bindTrial(options.trialId);
      integer(options.leaseSequence, 'leaseSequence', 1, 1_000_000);
      credentialFree(options.policy, 'provider broker policy');
      const binding = options.policy?.trials?.[0];
      if (!plainObject(binding)
          || options.policy.trials.length !== 1
          || binding.leaseId !== options.leaseId
          || binding.leaseDigest !== options.leaseHash
          || binding.leaseSequence !== options.leaseSequence
          || binding.trialId !== options.trialId) {
        fail('provider broker final lease digest binding drifted');
      }
      const parent = await driver.prepareDirectory({
        path: topology.paths.brokerDirectory,
        uid: topology.identities.brokerUid,
        gid: topology.identities.brokerClientGid,
        mode: 0o2710,
      });
      if (parent?.real !== true
          || parent.ownerUid !== topology.identities.brokerUid
          || parent.groupGid !== topology.identities.brokerClientGid
          || parent.mode !== 0o2710) {
        fail('provider broker socket parent policy drifted');
      }
      const policyParent = await driver.prepareDirectory({
        path: topology.paths.brokerPolicyDirectory,
        uid: topology.identities.brokerUid,
        gid: topology.identities.brokerGid,
        mode: 0o700,
      });
      if (policyParent?.real !== true
          || policyParent.ownerUid !== topology.identities.brokerUid
          || policyParent.groupGid !== topology.identities.brokerGid
          || policyParent.mode !== 0o700) {
        fail('provider broker policy parent custody drifted');
      }
      const written = await driver.writePolicy({
        path: topology.paths.brokerPolicy,
        value: clone(options.policy, 'provider broker policy'),
        uid: topology.identities.brokerUid,
        gid: topology.identities.brokerGid,
        mode: 0o600,
      });
      if (written?.path !== topology.paths.brokerPolicy
          || written.ownerUid !== topology.identities.brokerUid
          || written.mode !== 0o600
          || written.hash !== evidenceHash(options.policy)) {
        fail('provider broker policy file custody drifted');
      }
      assertLifecycleTransition(transition);
      brokerHandle = await driver.spawnProcess({
        role: 'provider-broker',
        file: topology.executables.providerBroker,
        args: [
          '--socket', topology.paths.brokerSocket,
          '--policy', topology.paths.brokerPolicy,
          '--key-fd', '3',
          '--client-gid', String(topology.identities.brokerClientGid),
        ],
        cwd: '/',
        env: SUPPORT_ENV,
        uid: topology.identities.brokerUid,
        gid: topology.identities.brokerGid,
        supplementaryGids: [topology.identities.brokerClientGid],
        cgroupPath: null,
        inheritedFds: [{ source: providerFd, target: 3 }],
        maxOutputBytes: MAX_CHILD_OUTPUT_BYTES,
        shell: false,
      });
      assertLifecycleTransition(transition);
      await driver.waitForSocket({
        path: topology.paths.brokerSocket,
        process: brokerHandle,
        timeoutMs: topology.timeouts.brokerReadyMs,
      });
      assertLifecycleTransition(transition);
      await driver.setSocketPolicy({
        path: topology.paths.brokerSocket,
        uid: topology.identities.brokerUid,
        gid: topology.identities.brokerClientGid,
        mode: 0o660,
      });
      validateSocket(await driver.inspectSocket(topology.paths.brokerSocket), {
        path: topology.paths.brokerSocket,
        uid: topology.identities.brokerUid,
        gid: topology.identities.brokerClientGid,
        mode: 0o660,
      }, 'provider broker');
      brokerObservation = {
        socketPath: topology.paths.brokerSocket,
        socketOwnerUid: topology.identities.brokerUid,
        socketGroupGid: topology.identities.brokerClientGid,
        socketMode: 0o660,
        socketParentOwnerUid: topology.identities.brokerUid,
        socketParentGroupGid: topology.identities.brokerClientGid,
        socketParentMode: 0o2710,
        policyHash: providerBrokerStaticPolicyHash(options.policy),
        bindingPolicyHash: evidenceHash(options.policy),
        leaseId: options.leaseId,
        leaseDigest: options.leaseHash,
        leaseSequence: options.leaseSequence,
        trialId: options.trialId,
        keyFdConsumed: true,
        credentialInEnvironment: false,
        credentialPersisted: false,
        egressRestricted: true,
        taskReachable: false,
      };
      return clone(brokerObservation);
    });
  }

  async function closeInheritedFd(fd) {
    return guarded('provider descriptor closure', async () => {
      if (fd !== providerFd || providerFdClosed) fail('provider descriptor is not the active one-shot descriptor');
      await driver.closeDescriptor(fd);
      providerFdClosed = true;
      providerFd = null;
      return { closed: true };
    });
  }

  function installControlChannelLossHandler(handler) {
    if (typeof handler !== 'function' || detachLossHandler) fail('control-channel loss handler is invalid');
    if (!controlChannel) fail('live control channel is not bound', 'ERR_LINUX_RUNTIME_CONTROL_CHANNEL');
    const detach = driver.installChannelLossHandler((reason) => handler(
      typeof reason === 'string' ? reason : 'controller-channel-closed'
    ), { controlChannel });
    if (typeof detach !== 'function') fail('control-channel loss handler was not installed');
    detachLossHandler = () => {
      try { detach(); } finally { detachLossHandler = null; }
    };
    return detachLossHandler;
  }

  async function launchRunner(options) {
    return guardedLifecycleTransition('runner launch', async (transition) => {
      if (!brokerObservation || !providerFdClosed || runnerHandle) fail('runner prerequisites are incomplete');
      if (!plainObject(options)
          || options.uid !== topology.identities.runnerUid
          || options.gid !== topology.identities.runnerGid
          || !sameJson(options.supplementaryGids, [topology.identities.brokerClientGid])
          || !Array.isArray(options.inheritedFds)
          || options.inheritedFds.length !== 0
          || !Array.isArray(options.argv)
          || options.argv[0] !== topology.executables.runner
          || options.cwd !== topology.paths.workspace
          || options.leaseHash !== brokerObservation.leaseDigest) {
        fail('runner identity, cgroup, or executable binding drifted', 'ERR_LINUX_RUNTIME_RUNNER');
      }
      integer(options.timeoutMs, 'runner timeoutMs', 1_000, 4 * 60 * 60 * 1_000);
      bindRequest(options.requestHash);
      sha(options.leaseHash, 'leaseHash');
      bindTrial(brokerObservation.trialId);
      if (!plainObject(options.env)) fail('runner environment is invalid');
      for (const [name, value] of Object.entries(options.env)) {
        if (!RUNTIME_RUNNER_ENV.has(name)
            || typeof value !== 'string'
            || value.includes('\0')
            || SECRET_VALUE.test(value)
            || (PROVIDER_ENV.test(name) && !name.startsWith('ENGINEER_PROVIDER_'))) {
          fail('runner environment contains credential or command drift', 'ERR_LINUX_RUNTIME_SECRET');
        }
      }
      if (options.env.DOCKER_HOST !== `unix://${topology.paths.proxySocket}`
          || options.env.ENGINEER_PROVIDER_BROKER_SOCKET !== topology.paths.brokerSocket
          || options.env.ENGINEER_PROVIDER_LEASE_ID !== brokerObservation.leaseId
          || options.env.ENGINEER_PROVIDER_TRIAL_ID !== brokerObservation.trialId
          || options.env.ENGINEER_PROVIDER_LEASE_DIGEST !== brokerObservation.leaseDigest
          || options.env.ENGINEER_PROVIDER_LEASE_SEQUENCE !== String(brokerObservation.leaseSequence)
          || options.env.ENGINEER_RUNTIME_LEASE_HASH !== brokerObservation.leaseDigest) {
        fail('runner lease environment drifted', 'ERR_LINUX_RUNTIME_RUNNER');
      }
      if (sentinelHandle) {
        await driver.terminateProcess(sentinelHandle, { reason: 'runner-start', timeoutMs: 5_000 });
        sentinelHandle = null;
      }
      try {
        assertLifecycleTransition(transition);
        runnerHandle = await driver.spawnProcess({
          role: 'runner',
          file: options.argv[0],
          args: options.argv.slice(1),
          cwd: options.cwd,
          env: clone(options.env, 'runner environment'),
          uid: topology.identities.runnerUid,
          gid: topology.identities.runnerGid,
          supplementaryGids: [topology.identities.brokerClientGid],
          cgroupPath: topology.cgroup.path,
          inheritedFds: [],
          timeoutMs: options.timeoutMs,
          maxOutputBytes: MAX_CHILD_OUTPUT_BYTES,
          shell: false,
        });
        assertLifecycleTransition(transition);
        const result = await driver.waitProcess(runnerHandle, {
          timeoutMs: options.timeoutMs,
          maxOutputBytes: MAX_CHILD_OUTPUT_BYTES,
        });
        assertLifecycleTransition(transition);
        if (!plainObject(result)
            || result.cgroupPath !== topology.cgroup.path
            || !Number.isSafeInteger(result.exitCode)
            || typeof result.signal !== 'string'
            || !Number.isSafeInteger(result.outputBytes)
            || result.outputBytes > MAX_CHILD_OUTPUT_BYTES) {
          fail('runner escaped cgroup custody or returned incomplete evidence', 'ERR_LINUX_RUNTIME_CGROUP');
        }
        runnerResult = {
          exitCode: result.exitCode,
          signal: result.signal,
          startedAt: result.startedAt,
          endedAt: result.endedAt,
        };
        runnerHandle = null;
        return clone(runnerResult, 'runner result');
      } catch (error) {
        try { await driver.killCgroup({ path: topology.cgroup.path, reason: 'runner-failure' }); } catch { /* fail closed */ }
        throw error;
      }
    });
  }

  async function collectFinalEvidence(options) {
    return guarded('final evidence collection', async () => {
      if (!runnerResult || runnerHandle || !brokerObservation || !networkPolicyObservation
          || !liveTaskObservation || !securityContract || !securityMaterialization
          || taskReceiptPublication) {
        fail('final evidence prerequisites are incomplete');
      }
      if (!plainObject(options)
          || options.requestHash == null
          || options.leaseHash !== brokerObservation.leaseDigest) {
        fail('final evidence lease binding drifted');
      }
      bindRequest(options.requestHash);
      sha(options.leaseHash, 'leaseHash');
      bindTrial(brokerObservation.trialId);
      if (sentinelHandle) {
        const stopped = await driver.terminateProcess(sentinelHandle, {
          reason: 'final-evidence',
          timeoutMs: topology.timeouts.shutdownMs,
        });
        if (stopped !== true) fail('cgroup sentinel did not stop before final evidence');
        sentinelHandle = null;
      }
      const proxyEvidence = proxyHandoffObservation(proxyInstance, topology);
      const receipts = createTaskRuntimeReceipts({
        observation: liveTaskObservation,
        requestHash: options.requestHash,
        leaseHash: options.leaseHash,
        proxyEventsHash: proxyEvidence.eventsHash,
        producerExecutableHash: topology.hashes.supervisor,
        sandboxBootId: topology.sandboxBootId,
        trialId: activeTrialId,
        producerSessionId,
        daemonRootFilesystemId: topology.filesystem.id,
      });
      taskReceiptPublication = await taskReceiptPublisher(receipts);
      if (!plainObject(taskReceiptPublication)
          || taskReceiptPublication.mountPath !== TASK_MOUNT_RECEIPT_PATH
          || taskReceiptPublication.isolationPath !== TASK_ISOLATION_RECEIPT_PATH
          || !HASH.test(String(taskReceiptPublication.mountHash ?? ''))
          || !HASH.test(String(taskReceiptPublication.isolationHash ?? ''))) {
        fail('task namespace receipt publication drifted', 'ERR_LINUX_RUNTIME_EVIDENCE');
      }
      const handoff = createRuntimeEvidenceHandoff({
        requestHash: options.requestHash,
        leaseHash: options.leaseHash,
        observedAt: canonicalInstant(driver.now(), 'final evidence handoff observation'),
        runnerResult: clone(runnerResult, 'runner result'),
        topology: {
          imageDigest: topology.imageDigest,
          filesystemId: topology.filesystem.id,
          cgroupId: topology.cgroup.id,
          cgroupPathHash: topology.cgroup.pathHash,
          harborExecutableHash: topology.hashes.harbor,
          cpuMax: topology.cgroup.cpuMax,
          memoryMax: topology.cgroup.memoryMax,
          pidsMax: topology.cgroup.pidsMax,
        },
        proxy: proxyEvidence,
        networkPolicy: clone(networkPolicyObservation, 'network policy observation'),
        broker: {
          leaseId: brokerObservation.leaseId,
          leaseDigest: brokerObservation.leaseDigest,
          leaseSequence: brokerObservation.leaseSequence,
          trialId: brokerObservation.trialId,
          policyHash: brokerObservation.policyHash,
          bindingPolicyHash: brokerObservation.bindingPolicyHash,
        },
      });
      const evidence = await driver.collectEvidence({
        file: topology.executables.evidenceCollector,
        args: [
          '--request-hash', options.requestHash,
          '--lease-hash', options.leaseHash,
          '--daemon-socket', topology.paths.daemonSocket,
          '--proxy-socket', topology.paths.proxySocket,
          '--broker-socket', topology.paths.brokerSocket,
          '--broker-policy', topology.paths.brokerPolicy,
          '--cgroup', topology.cgroup.path,
          '--workspace', securityContract.writablePaths.workspace,
        ],
        env: SUPPORT_ENV,
        timeoutMs: topology.timeouts.helperMs,
        maxOutputBytes: MAX_HELPER_OUTPUT_BYTES,
        handoff,
        shell: false,
      });
      return validateFinalEvidence(evidence, topology);
    });
  }

  async function killTrialCgroup({ reason } = {}) {
    return guarded('trial cgroup fail-stop', async () => {
      invalidateLifecycle();
      const safeReason = typeof reason === 'string' && SAFE_ID.test(reason) ? reason : 'runtime-fail-stop';
      const sweep = async () => {
        for (const handle of [runnerHandle, sentinelHandle]) {
          if (!handle) continue;
          try { await driver.terminateProcess(handle, { reason: safeReason, timeoutMs: 5_000 }); } catch { /* cgroup.kill follows */ }
        }
        runnerHandle = null;
        sentinelHandle = null;
        const result = await driver.killCgroup({ path: topology.cgroup.path, reason: safeReason });
        if (result?.populated !== false || result.processesRemaining !== 0) {
          fail('trial cgroup remains populated', 'ERR_LINUX_RUNTIME_CGROUP');
        }
      };
      await sweep();
      await drainLifecycleTransition();
      await sweep();
      return { killed: true, populated: false };
    });
  }

  async function shutdown({ reason = 'runtime-fail-stop', failClosed = true } = {}) {
    return guarded('runtime shutdown', async () => {
      if (shutdownStarted) fail('runtime shutdown is one-shot');
      shutdownStarted = true;
      invalidateLifecycle();
      const failures = [];
      try { await killTrialCgroup({ reason }); } catch { failures.push('cgroup'); }
      try { await proxyInstance?.close(); } catch { failures.push('proxy'); }
      proxyInstance = null;
      for (const [name, handle] of [['broker', brokerHandle], ['daemon', daemonHandle]]) {
        if (!handle) continue;
        try {
          await driver.terminateProcess(handle, { reason, timeoutMs: topology.timeouts.shutdownMs });
        } catch {
          failures.push(name);
        }
      }
      brokerHandle = null;
      daemonHandle = null;
      try {
        await driver.removeRuntimeArtifacts({
          sockets: [topology.paths.brokerSocket, topology.paths.proxySocket, topology.paths.daemonSocket],
          files: [
            topology.paths.brokerPolicy,
            topology.paths.daemonPidFile,
            DAEMON_ADOPTION_RECEIPT_PATH,
            TASK_MOUNT_RECEIPT_PATH,
            TASK_ISOLATION_RECEIPT_PATH,
          ],
          directories: [
            topology.paths.brokerDirectory,
            topology.paths.brokerPolicyDirectory,
            topology.paths.daemonExecRoot,
            ...(securityMaterialization?.runtimeRoot ? [securityMaterialization.runtimeRoot] : []),
          ],
        });
      } catch {
        failures.push('artifacts');
      }
      let released = false;
      try {
        const release = reserve
          ? await driver.releaseEvidence({ path: topology.paths.evidenceReserve, bytes: reserve.bytes })
          : { released: true };
        released = release?.released === true;
      } catch {
        failures.push('headroom');
      }
      reserve = null;
      securityMaterialization = null;
      securityContract = null;
      liveTaskObservation = null;
      taskReceiptPublication = null;
      const inventory = await driver.inspectShutdown({
        cgroupPath: topology.cgroup.path,
        sockets: [topology.paths.brokerSocket, topology.paths.proxySocket, topology.paths.daemonSocket],
        processes: [],
      });
      if (failures.length
          || inventory?.processesRemaining !== 0
          || inventory?.socketsRemaining !== 0
          || inventory?.cgroupPopulated !== false
          || !released) {
        fail('runtime shutdown left an orphan or incomplete custody evidence', 'ERR_LINUX_RUNTIME_ORPHAN');
      }
      try { detachLossHandler?.(); } catch { /* cleanup is otherwise complete */ }
      detachLossHandler = null;
      const endedAt = driver.now();
      const instant = endedAt instanceof Date ? endedAt.toISOString() : new Date(endedAt).toISOString();
      return {
        completed: true,
        processesRemaining: 0,
        socketsRemaining: 0,
        evidenceHeadroomReleased: true,
        endedAt: instant,
      };
    });
  }

  return Object.freeze({
    bindControlChannel,
    inspectPlatform,
    inspectProviderKeyFd,
    reserveEvidenceHeadroom,
    startPrivateDaemon,
    startDockerProxy,
    inspectReadiness,
    startProviderBroker,
    closeInheritedFd,
    installControlChannelLossHandler,
    launchRunner,
    collectFinalEvidence,
    killTrialCgroup,
    shutdown,
  });
}

function statFilesystem(target) {
  const stat = fs.statSync(target, { bigint: true });
  const filesystem = fs.statfsSync(target, { bigint: true });
  const bytes = filesystem.bsize * filesystem.blocks;
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('filesystem size exceeds safe evidence bounds');
  return { id: `dev:${stat.dev.toString(16)}`, bytes: Number(bytes) };
}

function statMode(target) {
  const stat = fs.lstatSync(target);
  return {
    ownerUid: stat.uid,
    groupGid: stat.gid,
    mode: stat.mode & 0o7777,
    real: !stat.isSymbolicLink(),
    kind: stat.isSocket() ? 'socket' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
  };
}

function hashFile(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('trusted executable is not a bounded regular file');
    return crypto.createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function boundedChild(child, maximum) {
  let outputBytes = 0;
  let overflow = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maximum && !overflow) {
        overflow = true;
        child.kill('SIGKILL');
      }
    });
  }
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, outputBytes, overflow }));
  });
  return { completion, get outputBytes() { return outputBytes; } };
}

function signalExitCode(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return 128 + (numbers[signal] ?? 0);
}

function parseCgroupEvents(text) {
  return Object.fromEntries(String(text).trim().split('\n').filter(Boolean).map((line) => {
    const [key, value] = line.split(/\s+/, 2);
    return [key, Number(value)];
  }));
}

function childArgv(topology, spec) {
  if (spec.uid === 0 && !spec.cgroupPath) return { file: spec.file, args: spec.args };
  const args = [
    '--uid', String(spec.uid),
    '--gid', String(spec.gid),
    '--groups', spec.supplementaryGids.join(','),
    ...(spec.cgroupPath ? ['--cgroup', spec.cgroupPath] : []),
    '--no-new-privileges',
    '--clear-capabilities',
    '--',
    spec.file,
    ...spec.args,
  ];
  return { file: topology.executables.cgroupExec, args };
}

/** Default Node/Linux driver used in the Daytona DIND snapshot. */
export function createNodeLinuxDriver(topology) {
  const handles = new Set();
  const adoptedHandles = new Set();
  const knownSockets = new Set();
  let activeControlChannel;

  function processStartTime(pid) {
    try {
      const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = value.lastIndexOf(')');
      if (close < 2) throw new Error('process stat is malformed');
      const fields = value.slice(close + 2).trim().split(/\s+/);
      if (fields.length < 20 || !/^[1-9][0-9]*$/.test(fields[19])) {
        throw new Error('process start time is malformed');
      }
      return fields[19];
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function spawnProcess(spec) {
    const hasHandoff = spec.handoffBytes !== undefined;
    if (spec.shell !== false
        || !path.posix.isAbsolute(spec.file)
        || spec.inheritedFds.some(({ source, target }) =>
          !Number.isSafeInteger(source) || source < 3 || !Number.isSafeInteger(target) || target < 3)
        || (hasHandoff && (!Buffer.isBuffer(spec.handoffBytes)
          || spec.handoffBytes.length < 2
          || spec.handoffBytes.length > MAX_HELPER_HANDOFF_BYTES
          || spec.inheritedFds.some(({ target }) => target === 3)))) {
      throw new Error('process specification escaped its exact execution contract');
    }
    credentialFree(spec.env, 'child environment');
    const command = childArgv(topology, spec);
    const stdio = ['ignore', 'pipe', 'pipe'];
    for (const mapping of spec.inheritedFds) {
      while (stdio.length <= mapping.target) stdio.push('ignore');
      stdio[mapping.target] = mapping.source;
    }
    if (hasHandoff) {
      while (stdio.length <= 3) stdio.push('ignore');
      stdio[3] = 'pipe';
    }
    const child = spawn(command.file, command.args, {
      shell: false,
      cwd: spec.cwd,
      env: { ...spec.env },
      stdio,
      windowsHide: true,
    });
    const bounded = boundedChild(child, spec.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES);
    let handoffCompletion = Promise.resolve();
    if (hasHandoff) {
      const stream = child.stdio[3];
      if (!stream || typeof stream.end !== 'function') {
        child.kill('SIGKILL');
        throw new Error('helper handoff pipe was not created');
      }
      handoffCompletion = new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          stream.off('error', onError);
          callback();
        };
        const onError = () => finish(() => reject(new Error('helper handoff transfer failed')));
        stream.once('error', onError);
        stream.end(spec.handoffBytes, () => finish(resolve));
      });
    }
    const handle = {
      child,
      bounded,
      role: spec.role,
      cgroupPath: spec.cgroupPath,
      startedAt: new Date().toISOString(),
      handoffCompletion,
    };
    handles.add(handle);
    void bounded.completion.then(
      () => handles.delete(handle),
      () => handles.delete(handle)
    );
    return handle;
  }

  async function waitProcess(handle, { timeoutMs }) {
    let timer;
    try {
      const [completion] = await Promise.all([
        Promise.race([
          handle.bounded.completion,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              handle.child.kill('SIGKILL');
              const error = new Error('child timed out');
              error.code = 'ETIMEDOUT';
              reject(error);
            }, timeoutMs);
            timer.unref?.();
          }),
        ]),
        handle.handoffCompletion,
      ]);
      if (completion.overflow) throw new Error('child output exceeded its byte bound');
      return {
        exitCode: Number.isInteger(completion.code) ? completion.code : signalExitCode(completion.signal),
        signal: completion.signal ?? 'none',
        startedAt: handle.startedAt,
        endedAt: new Date().toISOString(),
        cgroupPath: handle.cgroupPath,
        outputBytes: completion.outputBytes,
      };
    } catch (error) {
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        handle.child.kill('SIGKILL');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runJsonHelper(spec, { role, encodeHandoff }) {
    let handoffBytes;
    try {
      handoffBytes = encodeHandoff(spec.handoff);
      const handle = await spawnProcess({
        role,
        file: spec.file,
        args: spec.args,
        cwd: '/',
        env: spec.env,
        uid: 0,
        gid: 0,
        supplementaryGids: [],
        cgroupPath: null,
        inheritedFds: [],
        handoffBytes,
        maxOutputBytes: spec.maxOutputBytes,
        shell: false,
      });
      const chunks = [];
      let bytes = 0;
      handle.child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= spec.maxOutputBytes) chunks.push(Buffer.from(chunk));
      });
      const result = await waitProcess(handle, { timeoutMs: spec.timeoutMs });
      if (result.exitCode !== 0 || bytes > spec.maxOutputBytes) throw new Error('trusted evidence helper failed');
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      credentialFree(parsed, 'trusted evidence helper output');
      return parsed;
    } finally {
      handoffBytes?.fill(0);
    }
  }

  return {
    async adoptPrivateDaemon(spec) {
      const adoption = await attestDaemonAdoptionReceipt();
      if (adoption.daemon.daemonId !== spec.daemonId ||
          adoption.sandboxBootId !== spec.sandboxBootId ||
          adoption.filesystem.boundedRootId !== spec.filesystemId ||
          adoption.filesystem.defaultDockerRootId !== spec.defaultDockerRootId ||
          adoption.daemon.dataRoot !== spec.dataRoot ||
          adoption.daemon.socketPath !== spec.socketPath ||
          adoption.daemon.executablePath !== spec.dockerdPath ||
          adoption.daemon.executableSha256 !== spec.dockerdSha256) {
        throw new Error('private daemon adoption binding drifted');
      }
      const handle = {
        adopted: true,
        pid: adoption.daemon.pid,
        startTimeTicks: adoption.daemon.startTimeTicks,
        executablePath: adoption.daemon.executablePath,
        executableSha256: adoption.daemon.executableSha256,
        receiptSha256: adoption.receiptSha256,
      };
      adoptedHandles.add(handle);
      return {
        handle,
        daemonId: adoption.daemon.daemonId,
        sandboxBootId: adoption.sandboxBootId,
        filesystemId: adoption.filesystem.boundedRootId,
        defaultDockerRootId: adoption.filesystem.defaultDockerRootId,
        dataRoot: adoption.daemon.dataRoot,
        socketPath: adoption.daemon.socketPath,
        socketOwnerUid: adoption.daemon.socketOwnerUid,
        socketOwnerGid: adoption.daemon.socketOwnerGid,
        socketMode: adoption.daemon.socketMode,
        exclusive: true,
      };
    },
    async inspectHost({ controlChannel } = {}) {
      if (!plainObject(controlChannel) || controlChannel.kernelBound !== true ||
          controlChannel.authenticated !== true || controlChannel.open !== true ||
          !controlChannel.stream || controlChannel.stream.destroyed === true) {
        throw new Error('live control channel binding is unavailable');
      }
      activeControlChannel = controlChannel;
      const bounded = statFilesystem(topology.filesystem.boundedRoot);
      const sandbox = statFilesystem(topology.filesystem.sandboxRoot);
      const defaultRoot = statFilesystem(topology.filesystem.defaultDockerRoot);
      const evidence = statMode(topology.paths.evidenceDirectory);
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const limits = fs.readFileSync('/proc/self/limits', 'utf8');
      const credentialNames = Object.keys(process.env).filter((name) => PROVIDER_ENV.test(name));
      const daytonaNames = Object.keys(process.env).filter((name) => /^DAYTONA_/i.test(name));
      return {
        platform: process.platform,
        effectiveUid: process.geteuid?.() ?? process.getuid?.(),
        sandboxId: topology.sandboxId,
        sandboxBootId: boot,
        supervisorExecutableHash: hashFile(topology.executables.supervisor),
        cgroupVersion: fs.existsSync('/sys/fs/cgroup/cgroup.controllers') ? 2 : 1,
        cgroupDelegated: fs.existsSync('/sys/fs/cgroup/cgroup.kill'),
        filesystem: {
          sandboxRootId: sandbox.id,
          sandboxRootBytes: sandbox.bytes,
          boundedRootId: bounded.id,
          boundedRootBytes: bounded.bytes,
          defaultDockerRootId: defaultRoot.id,
          privateDaemonDataRoot: topology.paths.daemonDataRoot,
        },
        identities: { ...topology.identities },
        controlChannel: {
          kind: controlChannel.kind,
          authenticated: true,
          open: controlChannel.stream.destroyed !== true,
        },
        providerCredentialsAbsent: credentialNames.length === 0,
        daytonaCredentialsAbsent: daytonaNames.length === 0,
        custody: {
          coreDumpsDisabled: /^Max core file size\s+0\s+0\s+/m.test(limits),
          evidenceStoreOwnerUid: evidence.ownerUid,
          evidenceStoreMode: evidence.mode,
          evidenceRetentionDays: topology.custody.evidenceRetentionDays,
          snapshotCredentialExclusion: topology.snapshotCredentialExclusion === true,
        },
      };
    },
    async inspectDescriptor(fd) {
      const stat = fs.fstatSync(fd);
      return { kind: stat.isFIFO() ? 'pipe' : stat.isSocket() ? 'socket' : 'file', open: true };
    },
    async hashExecutable(file) { return hashFile(file); },
    async reserveEvidence(spec) {
      const descriptor = fs.openSync(spec.path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), spec.mode);
      const block = Buffer.alloc(1024 * 1024);
      try {
        let remaining = spec.bytes;
        while (remaining > 0) {
          const length = Math.min(block.length, remaining);
          const written = fs.writeSync(descriptor, block, 0, length, null);
          if (written !== length) throw new Error('evidence reserve write was incomplete');
          remaining -= written;
        }
        fs.fchmodSync(descriptor, spec.mode);
        fs.fchownSync(descriptor, spec.uid, spec.gid);
        fs.fsyncSync(descriptor);
      } finally {
        block.fill(0);
        fs.closeSync(descriptor);
      }
      const stat = fs.statSync(spec.path);
      const filesystem = statFilesystem(spec.path);
      if (stat.blocks * 512 < spec.bytes) throw new Error('evidence reserve is sparse');
      return { bytes: stat.blocks * 512, filesystemId: filesystem.id, protectedFromRunner: stat.uid === 0 && (stat.mode & 0o077) === 0 };
    },
    async ensureCgroup(spec) {
      fs.mkdirSync(spec.path, { recursive: false, mode: 0o755 });
      fs.writeFileSync(path.join(spec.path, 'cpu.max'), `${spec.cpuMax}\n`);
      fs.writeFileSync(path.join(spec.path, 'memory.max'), `${spec.memoryMax}\n`);
      fs.writeFileSync(path.join(spec.path, 'pids.max'), `${spec.pidsMax}\n`);
      const limitsEnforced = fs.readFileSync(path.join(spec.path, 'cpu.max'), 'utf8').trim() === spec.cpuMax
        && fs.readFileSync(path.join(spec.path, 'memory.max'), 'utf8').trim() === String(spec.memoryMax)
        && fs.readFileSync(path.join(spec.path, 'pids.max'), 'utf8').trim() === String(spec.pidsMax);
      return { id: spec.id, pathHash: spec.pathHash, limitsEnforced, writableByRunner: (fs.statSync(spec.path).mode & 0o022) !== 0 };
    },
    async prepareDirectory(spec) {
      fs.mkdirSync(spec.path, { recursive: true, mode: spec.mode });
      const resolved = fs.realpathSync(spec.path);
      if (resolved !== spec.path) throw new Error('runtime directory resolved through a link');
      fs.chownSync(spec.path, spec.uid, spec.gid);
      fs.chmodSync(spec.path, spec.mode);
      return { path: spec.path, ...statMode(spec.path) };
    },
    async inspectPath(target) { return { path: target, ...statMode(target) }; },
    async installNetworkPolicy(spec) {
      const resolved = await resolveExactProviderNetwork(spec.providerHostname);
      const commands = planLinuxNetworkPolicy({ ...spec, ...resolved });
      for (const { file, args } of commands) {
        const handle = await spawnProcess({
          role: 'network-policy', file, args, cwd: '/', env: SUPPORT_ENV,
          uid: 0, gid: 0, supplementaryGids: [], cgroupPath: null,
          inheritedFds: [], maxOutputBytes: 8 * 1024, shell: false,
        });
        const result = await waitProcess(handle, { timeoutMs: 10_000 });
        if (result.exitCode !== 0) throw new Error('network policy command failed');
      }
      return {
        runnerEgressDenied: true,
        metadataDenied: true,
        rawSocketDenied: true,
        brokerOnlyEgress: true,
        providerAddresses: {
          ipv4: [...new Set(resolved.providerAddresses.ipv4)].sort(),
          ipv6: [...new Set(resolved.providerAddresses.ipv6)].sort(),
        },
        dnsServers: resolved.dnsServers.map((server) => ({ ...server })),
      };
    },
    async writePolicy(spec) {
      const temporary = `${spec.path}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      const bytes = Buffer.from(JSON.stringify(spec.value));
      if (bytes.length > 128 * 1024) throw new Error('provider policy is oversized');
      const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), spec.mode);
      try {
        fs.writeFileSync(descriptor, bytes);
        fs.fchmodSync(descriptor, spec.mode);
        fs.fchownSync(descriptor, spec.uid, spec.gid);
        fs.fsyncSync(descriptor);
      } finally {
        bytes.fill(0);
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, spec.path);
      return { path: spec.path, ownerUid: spec.uid, mode: spec.mode, hash: evidenceHash(spec.value) };
    },
    spawnProcess,
    async waitForSocket({ path: socketPath, process: handle, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (handle.child.exitCode !== null || handle.child.signalCode !== null) throw new Error('runtime process exited before socket readiness');
        try {
          if (fs.lstatSync(socketPath).isSocket()) {
            knownSockets.add(socketPath);
            return true;
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('runtime socket readiness timed out');
    },
    async inspectSocket(socketPath) { return { path: socketPath, ...statMode(socketPath) }; },
    async setSocketPolicy(spec) {
      fs.chownSync(spec.path, spec.uid, spec.gid);
      fs.chmodSync(spec.path, spec.mode);
      return true;
    },
    async runReadinessProbe(spec) {
      return runJsonHelper(spec, {
        role: 'readiness-helper',
        encodeHandoff: encodeRuntimeProbeHandoff,
      });
    },
    waitProcess,
    async collectEvidence(spec) {
      return runJsonHelper(spec, {
        role: 'evidence-helper',
        encodeHandoff: encodeRuntimeEvidenceHandoff,
      });
    },
    async closeDescriptor(fd) { fs.closeSync(fd); return true; },
    installChannelLossHandler(handler, { controlChannel } = {}) {
      const stream = (activeControlChannel ?? controlChannel)?.stream;
      if (!stream || stream.destroyed === true) throw new Error('live control channel is unavailable');
      const onLoss = () => handler('controller-channel-closed');
      stream.once('end', onLoss);
      stream.once('close', onLoss);
      stream.once('error', onLoss);
      return () => {
        stream.off('end', onLoss);
        stream.off('close', onLoss);
        stream.off('error', onLoss);
      };
    },
    async terminateProcess(handle, { timeoutMs = 5_000 }) {
      if (handle?.adopted === true) {
        const adoption = await attestDaemonAdoptionReceipt();
        if (adoption.daemon.pid !== handle.pid ||
            adoption.daemon.startTimeTicks !== handle.startTimeTicks ||
            adoption.daemon.executablePath !== handle.executablePath ||
            adoption.daemon.executableSha256 !== handle.executableSha256 ||
            adoption.receiptSha256 !== handle.receiptSha256) {
          throw new Error('adopted private daemon identity drifted before termination');
        }
        process.kill(handle.pid, 'SIGTERM');
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && processStartTime(handle.pid) === handle.startTimeTicks) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (processStartTime(handle.pid) === handle.startTimeTicks) {
          process.kill(handle.pid, 'SIGKILL');
          const killDeadline = Date.now() + 2_000;
          while (Date.now() < killDeadline && processStartTime(handle.pid) === handle.startTimeTicks) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        if (processStartTime(handle.pid) === handle.startTimeTicks) {
          throw new Error('adopted private daemon survived termination');
        }
        adoptedHandles.delete(handle);
        return true;
      }
      if (!handle || handle.child.exitCode !== null || handle.child.signalCode !== null) return true;
      handle.child.kill('SIGTERM');
      let timer;
      try {
        const completed = await Promise.race([
          handle.bounded.completion,
          new Promise((resolve) => {
            timer = setTimeout(() => { handle.child.kill('SIGKILL'); resolve(null); }, timeoutMs);
            timer.unref?.();
          }),
        ]);
        if (completed === null) {
          let killTimer;
          try {
            await Promise.race([
              handle.bounded.completion,
              new Promise((_, reject) => {
                killTimer = setTimeout(() => reject(new Error('child survived SIGKILL')), 2_000);
                killTimer.unref?.();
              }),
            ]);
          } finally {
            clearTimeout(killTimer);
          }
        }
      } finally {
        clearTimeout(timer);
      }
      return true;
    },
    async killCgroup(spec) {
      try { fs.writeFileSync(path.join(spec.path, 'cgroup.kill'), '1\n'); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const events = fs.existsSync(path.join(spec.path, 'cgroup.events'))
        ? parseCgroupEvents(fs.readFileSync(path.join(spec.path, 'cgroup.events'), 'utf8'))
        : { populated: 0 };
      const processes = fs.existsSync(path.join(spec.path, 'cgroup.procs'))
        ? fs.readFileSync(path.join(spec.path, 'cgroup.procs'), 'utf8').trim().split('\n').filter(Boolean)
        : [];
      return { killed: true, populated: events.populated !== 0, processesRemaining: processes.length };
    },
    async removeRuntimeArtifacts(spec) {
      for (const target of [...spec.sockets, ...spec.files]) {
        try { fs.unlinkSync(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        knownSockets.delete(target);
      }
      for (const directory of spec.directories) {
        try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error; }
      }
      return true;
    },
    async releaseEvidence(spec) {
      fs.unlinkSync(spec.path);
      return { released: true };
    },
    async inspectShutdown(spec) {
      const childProcesses = [...handles].filter((handle) =>
        handle.child.exitCode === null && handle.child.signalCode === null).length;
      const adoptedProcesses = [...adoptedHandles].filter((handle) =>
        processStartTime(handle.pid) === handle.startTimeTicks).length;
      const processesRemaining = childProcesses + adoptedProcesses;
      const socketsRemaining = spec.sockets.filter((target) => fs.existsSync(target)).length;
      const eventsPath = path.join(spec.cgroupPath, 'cgroup.events');
      const cgroupPopulated = fs.existsSync(eventsPath)
        && parseCgroupEvents(fs.readFileSync(eventsPath, 'utf8')).populated !== 0;
      return { processesRemaining, socketsRemaining, cgroupPopulated };
    },
    now() { return new Date(); },
  };
}
