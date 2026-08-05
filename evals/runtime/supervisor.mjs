import path from 'node:path';
import {
  RuntimeProtocolSchemas,
  canonicalJson,
  canonicalSha256,
  generateNonce,
  protocolDocumentHash,
  signProtocolDocument,
  verifyProtocolDocument,
  verifyReadinessLeaseForRequest,
  verifyTrialAttestationForLease,
} from './protocol.mjs';
import { providerBrokerStaticPolicyHash } from './provider-broker.mjs';

const TEN_GIB = 10 * 1024 * 1024 * 1024;
const DEFAULT_EVIDENCE_RESERVE_BYTES = 256 * 1024 * 1024;
const MAX_OPAQUE_BYTES = 64 * 1024;
const MAX_OPAQUE_DEPTH = 20;
const MAX_OPAQUE_NODES = 8_192;
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_REASON = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const FORBIDDEN_ENV_NAME = /(KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|AUTH|DAYTONA|OPENROUTER|ANTHROPIC|OPENAI|GITHUB|COPILOT|DOCKER_HOST|ENGINEER_)/;
const ALLOWED_RUNNER_ENV = new Set([
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
const FORBIDDEN_BOOTSTRAP_NAMES = new Set(['bash', 'dash', 'env', 'sh', 'sudo', 'zsh']);
const REQUIRED_EFFECTS = Object.freeze([
  'inspectPlatform',
  'inspectProviderKeyFd',
  'reserveEvidenceHeadroom',
  'startPrivateDaemon',
  'startDockerProxy',
  'startProviderBroker',
  'closeInheritedFd',
  'inspectReadiness',
  'installControlChannelLossHandler',
  'launchRunner',
  'collectFinalEvidence',
  'killTrialCgroup',
  'shutdown',
]);

export class RuntimeSupervisorError extends Error {
  constructor(message, code = 'ERR_RUNTIME_SUPERVISOR') {
    super(message);
    this.name = 'RuntimeSupervisorError';
    this.code = code;
  }
}

function invalid(message, code = 'ERR_RUNTIME_SUPERVISOR_POLICY') {
  throw new RuntimeSupervisorError(message, code);
}

function lifecycle(state, expected) {
  invalid(
    `invalid supervisor lifecycle: expected ${expected}, observed ${state}`,
    'ERR_RUNTIME_SUPERVISOR_LIFECYCLE'
  );
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) invalid(`${label} contains an unknown field`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalid(`${label} is incomplete`);
  }
}

function assertBoolean(value, label, expected) {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  if (expected !== undefined && value !== expected) invalid(`${label} failed closed`);
}

function assertInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is outside its integer bound`);
  }
}

function assertString(value, label, maximum = 256) {
  if (typeof value !== 'string'
      || value.length === 0
      || Buffer.byteLength(value, 'utf8') > maximum
      || value.includes('\0')) {
    invalid(`${label} is not a bounded string`);
  }
}

function assertSafeId(value, label, maximum = 192) {
  assertString(value, label, maximum);
  if (!SAFE_ID.test(value)) invalid(`${label} is not a safe identifier`);
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) invalid(`${label} is not a SHA-256 digest`);
}

function assertAbsolutePath(value, label, maximum = 512) {
  assertString(value, label, maximum);
  if (!path.posix.isAbsolute(value)
      || path.posix.normalize(value) !== value
      || value.includes('//')) {
    invalid(`${label} must be a normalized absolute path`);
  }
}

function instantMs(value, label) {
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    invalid(`${label} must be a canonical UTC instant`);
  }
  if (typeof value !== 'string' || canonical !== value) {
    invalid(`${label} must be a canonical UTC instant`);
  }
  return Date.parse(value);
}

function nowMs(clock) {
  const value = clock.now();
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) invalid('runtime clock returned an invalid instant');
  return Math.trunc(milliseconds);
}

function canonicalClone(value, label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch {
    invalid(`${label} is not bounded canonical evidence`);
  }
}

function cloneOpaqueJson(value, label) {
  let nodes = 0;
  const ancestors = new WeakSet();

  function visit(current, depth) {
    nodes += 1;
    if (nodes > MAX_OPAQUE_NODES || depth > MAX_OPAQUE_DEPTH) {
      invalid(`${label} exceeds its structure bound`);
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) invalid(`${label} contains an unsafe number`);
      return current;
    }
    if (typeof current !== 'object' || ancestors.has(current)) invalid(`${label} contains unsafe data`);
    ancestors.add(current);
    try {
      if (Object.getOwnPropertySymbols(current).length > 0) invalid(`${label} contains symbol data`);
      if (Array.isArray(current)) {
        const clone = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
            invalid(`${label} contains an unsafe array field`);
          }
          clone.push(visit(descriptor.value, depth + 1));
        }
        if (Object.getOwnPropertyNames(current).length !== current.length + 1) {
          invalid(`${label} contains non-JSON array data`);
        }
        return clone;
      }
      if (!isPlainObject(current)) invalid(`${label} must contain only plain objects`);
      const clone = {};
      const keys = Object.keys(current);
      if (Object.getOwnPropertyNames(current).length !== keys.length) {
        invalid(`${label} contains non-enumerable data`);
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
          invalid(`${label} contains an unsafe object field`);
        }
        clone[key] = visit(descriptor.value, depth + 1);
      }
      return clone;
    } finally {
      ancestors.delete(current);
    }
  }

  const clone = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(clone), 'utf8') > MAX_OPAQUE_BYTES) {
    invalid(`${label} exceeds its byte bound`);
  }
  return clone;
}

function assertCredentialFree(value, label) {
  const sensitiveField = /(^|[_-])(api[_-]?key|authorization|auth|credential|password|secret|token)($|[_-])/i;
  const credentialValue = /^(Bearer\s+|sk-[A-Za-z0-9_-]{8,})/i;
  function visit(current) {
    if (typeof current === 'string') {
      if (credentialValue.test(current)) invalid(`${label} contains credential material`);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (sensitiveField.test(key)) invalid(`${label} contains a credential field`);
      visit(item);
    }
  }
  visit(value);
}

function validateRunner(input) {
  const runner = cloneOpaqueJson(input, 'runner specification');
  exactKeys(runner, ['argv', 'cwd', 'env', 'timeoutMs'], 'runner specification');
  if (!Array.isArray(runner.argv) || runner.argv.length < 1 || runner.argv.length > 128) {
    invalid('runner argv is outside its item bound');
  }
  let argvBytes = 0;
  runner.argv.forEach((argument, index) => {
    assertString(argument, `runner argv ${index}`, 4_096);
    if (/^(Bearer\s+|sk-[A-Za-z0-9_-]{8,})/i.test(argument)) {
      invalid('runner argv contains credential material');
    }
    argvBytes += Buffer.byteLength(argument, 'utf8');
  });
  if (argvBytes > 32 * 1024) invalid('runner argv exceeds its byte bound');
  assertAbsolutePath(runner.argv[0], 'runner executable');
  if (FORBIDDEN_BOOTSTRAP_NAMES.has(path.posix.basename(runner.argv[0]))) {
    invalid('runner executable must be a direct trusted bootstrap');
  }
  assertAbsolutePath(runner.cwd, 'runner cwd');
  if (!isPlainObject(runner.env) || Object.keys(runner.env).length > 32) {
    invalid('runner environment is outside its field bound');
  }
  for (const [name, value] of Object.entries(runner.env)) {
    if (!SAFE_ENV_NAME.test(name)
        || FORBIDDEN_ENV_NAME.test(name)
        || !ALLOWED_RUNNER_ENV.has(name)) {
      invalid('runner environment contains a forbidden name');
    }
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4_096 || value.includes('\0')) {
      invalid('runner environment contains an unsafe value');
    }
  }
  assertInteger(runner.timeoutMs, 'runner timeout', 1_000, 4 * 60 * 60 * 1_000);
  return runner;
}

function validatePlatform(value, request, limits) {
  exactKeys(value, [
    'platform',
    'effectiveUid',
    'sandboxId',
    'sandboxBootId',
    'supervisorExecutableHash',
    'cgroupVersion',
    'cgroupDelegated',
    'filesystem',
    'identities',
    'controlChannel',
    'providerCredentialsAbsent',
    'daytonaCredentialsAbsent',
    'custody',
  ], 'platform observation');
  if (value.platform !== 'linux') invalid('supervisor requires Linux');
  if (value.effectiveUid !== 0) invalid('supervisor requires effective root');
  if (value.cgroupVersion !== 2) invalid('supervisor requires cgroup v2');
  assertBoolean(value.cgroupDelegated, 'cgroup delegation', true);
  if (value.sandboxId !== request.bindings.sandboxId
      || value.sandboxBootId !== request.bindings.sandboxBootId) {
    invalid('sandbox identity does not match the signed request');
  }
  if (value.supervisorExecutableHash !== request.bindings.supervisorExecutableHash) {
    invalid('supervisor executable does not match the signed request');
  }
  assertBoolean(value.providerCredentialsAbsent, 'provider credential absence', true);
  assertBoolean(value.daytonaCredentialsAbsent, 'Daytona credential absence', true);

  exactKeys(value.filesystem, [
    'sandboxRootId',
    'sandboxRootBytes',
    'boundedRootId',
    'boundedRootBytes',
    'defaultDockerRootId',
    'privateDaemonDataRoot',
  ], 'filesystem observation');
  for (const field of ['sandboxRootId', 'boundedRootId', 'defaultDockerRootId']) {
    assertSafeId(value.filesystem[field], `filesystem ${field}`);
  }
  if (value.filesystem.sandboxRootBytes !== limits.requiredFilesystemBytes
      || value.filesystem.boundedRootBytes !== limits.requiredFilesystemBytes
      || value.filesystem.sandboxRootId !== value.filesystem.boundedRootId
      || value.filesystem.defaultDockerRootId === value.filesystem.boundedRootId
      || value.filesystem.privateDaemonDataRoot !== limits.privateDaemonDataRoot) {
    invalid('private daemon storage is not the exact bounded sandbox filesystem');
  }

  exactKeys(value.identities, [
    'supervisorUid',
    'runnerUid',
    'runnerGid',
    'brokerUid',
    'brokerGid',
    'brokerClientGid',
  ], 'runtime identities');
  for (const field of [
    'supervisorUid',
    'runnerUid',
    'runnerGid',
    'brokerUid',
    'brokerGid',
    'brokerClientGid',
  ]) {
    assertInteger(value.identities[field], `runtime identity ${field}`, 0, 65_535);
  }
  if (value.identities.supervisorUid !== 0
      || value.identities.runnerUid === 0
      || value.identities.runnerGid === 0
      || value.identities.brokerUid === 0
      || value.identities.brokerGid === 0
      || value.identities.runnerUid === value.identities.brokerUid
      || value.identities.runnerGid === value.identities.brokerGid
      || value.identities.brokerClientGid === 0
      || value.identities.brokerClientGid === value.identities.brokerGid) {
    invalid('runtime identities are not privilege-separated');
  }

  exactKeys(value.controlChannel, ['kind', 'authenticated', 'open'], 'control channel observation');
  if (!['inherited-pipe', 'inherited-socket'].includes(value.controlChannel.kind)) {
    invalid('control channel is not inherited');
  }
  assertBoolean(value.controlChannel.authenticated, 'control channel authentication', true);
  assertBoolean(value.controlChannel.open, 'control channel state', true);

  exactKeys(value.custody, [
    'coreDumpsDisabled',
    'evidenceStoreOwnerUid',
    'evidenceStoreMode',
    'evidenceRetentionDays',
    'snapshotCredentialExclusion',
  ], 'evidence custody');
  assertBoolean(value.custody.coreDumpsDisabled, 'core dump suppression', true);
  if (value.custody.evidenceStoreOwnerUid !== 0 || value.custody.evidenceStoreMode !== 0o700) {
    invalid('evidence store is not root-owned and private');
  }
  assertInteger(value.custody.evidenceRetentionDays, 'evidence retention days', 1, 30);
  assertBoolean(value.custody.snapshotCredentialExclusion, 'snapshot credential exclusion', true);
}

function validateProviderFd(value) {
  exactKeys(value, ['kind', 'open'], 'provider key descriptor observation');
  if (!['pipe', 'socket'].includes(value.kind)) invalid('provider key descriptor is not an inherited pipe or socket');
  assertBoolean(value.open, 'provider key descriptor state', true);
}

function validateHeadroom(value, platform, limits) {
  exactKeys(value, ['bytes', 'filesystemId', 'protectedFromRunner'], 'evidence headroom observation');
  if (value.bytes < limits.evidenceReserveBytes
      || value.filesystemId !== platform.filesystem.boundedRootId) {
    invalid('evidence headroom is not reserved on bounded storage');
  }
  assertBoolean(value.protectedFromRunner, 'evidence headroom protection', true);
}

function validateDaemon(value, platform, request, limits) {
  exactKeys(value, [
    'daemonId',
    'dataRootHash',
    'filesystemId',
    'socketPath',
    'socketOwnerUid',
    'socketGroupGid',
    'socketMode',
    'exclusive',
  ], 'private daemon observation');
  if (value.daemonId !== request.bindings.daemonId
      || value.dataRootHash !== request.bindings.daemonRootHash
      || value.filesystemId !== platform.filesystem.boundedRootId) {
    invalid('private daemon identity does not match the signed request');
  }
  assertAbsolutePath(value.socketPath, 'private daemon socket', 104);
  if (value.socketPath === '/var/run/docker.sock'
      || value.socketOwnerUid !== 0
      || value.socketGroupGid !== 0
      || value.socketMode !== 0o600) {
    invalid('private daemon socket is not supervisor-exclusive');
  }
  assertBoolean(value.exclusive, 'private daemon exclusivity', true);
  if (platform.filesystem.privateDaemonDataRoot !== limits.privateDaemonDataRoot) {
    invalid('private daemon data root drifted');
  }
}

function validateProxy(value, daemon, platform) {
  exactKeys(value, [
    'socketPath',
    'socketOwnerUid',
    'socketGroupGid',
    'socketMode',
    'policyHash',
    'nonBypassable',
    'realDaemonDenied',
  ], 'Docker proxy observation');
  assertAbsolutePath(value.socketPath, 'Docker proxy socket', 104);
  assertHash(value.policyHash, 'Docker proxy policy hash');
  if (value.socketPath === daemon.socketPath
      || value.socketOwnerUid !== 0
      || value.socketGroupGid !== platform.identities.runnerGid
      || value.socketMode !== 0o660) {
    invalid('Docker proxy socket policy drifted');
  }
  assertBoolean(value.nonBypassable, 'Docker proxy bypass resistance', true);
  assertBoolean(value.realDaemonDenied, 'real Docker daemon denial', true);
}

function validateBroker(value, platform, daemon, proxy, expected) {
  exactKeys(value, [
    'socketPath',
    'socketOwnerUid',
    'socketGroupGid',
    'socketMode',
    'socketParentOwnerUid',
    'socketParentGroupGid',
    'socketParentMode',
    'policyHash',
    'bindingPolicyHash',
    'leaseId',
    'leaseDigest',
    'leaseSequence',
    'trialId',
    'keyFdConsumed',
    'credentialInEnvironment',
    'credentialPersisted',
    'egressRestricted',
    'taskReachable',
  ], 'provider broker observation');
  assertAbsolutePath(value.socketPath, 'provider broker socket', 104);
  assertHash(value.policyHash, 'provider broker policy hash');
  assertHash(value.bindingPolicyHash, 'provider broker binding policy hash');
  assertSafeId(value.leaseId, 'provider broker lease id');
  assertHash(value.leaseDigest, 'provider broker lease digest');
  assertInteger(value.leaseSequence, 'provider broker lease sequence', 1, 1_000_000);
  assertSafeId(value.trialId, 'provider broker trial id');
  if (value.socketPath === daemon.socketPath
      || value.socketPath === proxy.socketPath
      || value.socketOwnerUid !== platform.identities.brokerUid
      || value.socketGroupGid !== platform.identities.brokerClientGid
      || value.socketMode !== 0o660
      || value.socketParentOwnerUid !== platform.identities.brokerUid
      || value.socketParentGroupGid !== platform.identities.brokerClientGid
      || value.socketParentMode !== 0o2710
      || value.policyHash !== expected.policyHash
      || value.leaseId !== expected.leaseId
      || value.leaseDigest !== expected.leaseDigest
      || value.leaseSequence !== expected.leaseSequence
      || value.trialId !== expected.trialId) {
    invalid('provider broker socket or identity policy drifted');
  }
  assertBoolean(value.keyFdConsumed, 'provider key descriptor consumption', true);
  assertBoolean(value.credentialInEnvironment, 'provider credential environment isolation', false);
  assertBoolean(value.credentialPersisted, 'provider credential persistence', false);
  assertBoolean(value.egressRestricted, 'provider broker egress restriction', true);
  assertBoolean(value.taskReachable, 'task broker reachability', false);
}

function validateReadiness(value, platform, request, { brokerInstalled = true } = {}) {
  exactKeys(value, [
    'cgroup',
    'noProviderProbe',
    'storageProbe',
    'runner',
    'task',
    'broker',
    'executables',
  ], 'readiness observation');
  exactKeys(value.cgroup, ['id', 'pathHash', 'populated', 'controllersEnforced', 'runnerUid'], 'cgroup readiness');
  if (value.cgroup.id !== request.bindings.cgroupId
      || value.cgroup.pathHash !== request.bindings.cgroupPathHash
      || value.cgroup.runnerUid !== platform.identities.runnerUid) {
    invalid('cgroup readiness identity drifted');
  }
  assertBoolean(value.cgroup.populated, 'trial cgroup population', true);
  assertBoolean(value.cgroup.controllersEnforced, 'trial cgroup controls', true);

  exactKeys(value.noProviderProbe, [
    'completed',
    'imageDigest',
    'genericMountPassed',
    'harnessMountPassed',
    'providerCalls',
    'providerCredentialAbsent',
  ], 'no-provider probe');
  if (value.noProviderProbe.imageDigest !== request.bindings.imageDigest
      || value.noProviderProbe.providerCalls !== 0) {
    invalid('no-provider probe identity or call count drifted');
  }
  for (const field of ['completed', 'genericMountPassed', 'harnessMountPassed']) {
    assertBoolean(value.noProviderProbe[field], `no-provider probe ${field}`, true);
  }
  assertBoolean(
    value.noProviderProbe.providerCredentialAbsent,
    'no-provider probe credential absence',
    true
  );

  exactKeys(value.storageProbe, [
    'filesystemId',
    'totalBytes',
    'enospcObserved',
    'evidenceHeadroomRecovered',
  ], 'storage probe');
  if (value.storageProbe.filesystemId !== platform.filesystem.boundedRootId
      || value.storageProbe.totalBytes !== platform.filesystem.boundedRootBytes) {
    invalid('storage probe is not bound to the sandbox filesystem');
  }
  assertBoolean(value.storageProbe.enospcObserved, 'storage ENOSPC observation', true);
  assertBoolean(value.storageProbe.evidenceHeadroomRecovered, 'evidence headroom recovery', true);

  exactKeys(value.runner, [
    'uid',
    'effectiveCapabilities',
    'privateDaemonDenied',
    'realDaemonDenied',
    'alternateDaemonDenied',
    'mountDenied',
    'ptraceDenied',
    'providerEgressDenied',
    'metadataDenied',
    'daytonaCredentialsAbsent',
    'providerCredentialsAbsent',
  ], 'runner readiness');
  if (value.runner.uid !== platform.identities.runnerUid || value.runner.effectiveCapabilities !== 0) {
    invalid('runner identity or capability policy drifted');
  }
  for (const field of [
    'privateDaemonDenied',
    'realDaemonDenied',
    'alternateDaemonDenied',
    'mountDenied',
    'ptraceDenied',
    'providerEgressDenied',
    'metadataDenied',
    'daytonaCredentialsAbsent',
    'providerCredentialsAbsent',
  ]) assertBoolean(value.runner[field], `runner ${field}`, true);

  exactKeys(value.task, [
    'networkNone',
    'readOnlyRoot',
    'capabilitiesDropped',
    'noNewPrivileges',
    'brokerReachable',
    'brokerSocketMounted',
    'brokerClientGidPresent',
  ], 'task readiness');
  for (const field of ['networkNone', 'readOnlyRoot', 'capabilitiesDropped', 'noNewPrivileges']) {
    assertBoolean(value.task[field], `task ${field}`, true);
  }
  if (brokerInstalled) {
    assertBoolean(value.task.brokerReachable, 'task broker reachability', false);
    assertBoolean(value.task.brokerSocketMounted, 'task broker socket mount', false);
    assertBoolean(value.task.brokerClientGidPresent, 'task broker client group', false);
  }

  exactKeys(value.broker, ['uid', 'onlyProviderEgress'], 'broker readiness');
  if (brokerInstalled) {
    if (value.broker.uid !== platform.identities.brokerUid) invalid('broker UID drifted');
    assertBoolean(value.broker.onlyProviderEgress, 'broker-only egress', true);
  }

  exactKeys(value.executables, ['runnerExecutableHash', 'harborExecutableHash'], 'executable readiness');
  if (value.executables.runnerExecutableHash !== request.bindings.runnerExecutableHash
      || value.executables.harborExecutableHash !== request.bindings.harborExecutableHash) {
    invalid('trusted executable identity drifted');
  }
}

function bindBrokerPolicy(policy, request, leaseSequence, leaseDigest) {
  let policyHash;
  try {
    policyHash = providerBrokerStaticPolicyHash(policy);
  } catch {
    invalid('provider broker policy is invalid');
  }
  if (!Array.isArray(policy.trials) || policy.trials.length !== 1) {
    invalid('per-trial sandbox broker policy must contain exactly one trial binding');
  }
  const binding = policy.trials[0];
  if (!isPlainObject(binding)
      || binding.trialId !== request.trialId
      || binding.leaseSequence !== leaseSequence
      || Math.round(binding.ceilingUsd * 1_000_000) !== request.budget.trialCeilingMicrousd
      || Math.round(policy.sessionCeilingUsd * 1_000_000) !== request.budget.sessionCeilingMicrousd) {
    invalid('provider broker trial or budget binding drifted');
  }
  assertSafeId(binding.leaseId, 'provider broker lease id');
  const bound = cloneOpaqueJson({
    ...policy,
    trials: [{ ...binding, leaseDigest }],
  }, 'bound provider broker policy');
  let reboundHash;
  try {
    reboundHash = providerBrokerStaticPolicyHash(bound);
  } catch {
    invalid('bound provider broker policy is invalid');
  }
  if (reboundHash !== policyHash) invalid('provider broker static policy changed during lease binding');
  return {
    policy: bound,
    policyHash,
    leaseId: binding.leaseId,
    leaseDigest,
    leaseSequence,
    trialId: request.trialId,
  };
}

function validateRunnerResult(value, { lease, observedAt, timeoutMs }) {
  exactKeys(value, ['exitCode', 'signal', 'startedAt', 'endedAt'], 'runner result');
  assertInteger(value.exitCode, 'runner exit code', 0, 255);
  assertSafeId(value.signal, 'runner signal', 32);
  const started = instantMs(value.startedAt, 'runner startedAt');
  const ended = instantMs(value.endedAt, 'runner endedAt');
  if (ended < started) invalid('runner completion predates its start');
  if (started < instantMs(lease.issuedAt, 'readiness lease issuedAt')
      || ended > observedAt + 30_000
      || ended - started > timeoutMs + 30_000) {
    invalid('runner lifetime falls outside its signed lease or observation window');
  }
}

function validateShutdown(value) {
  exactKeys(value, [
    'completed',
    'processesRemaining',
    'socketsRemaining',
    'evidenceHeadroomReleased',
    'endedAt',
  ], 'supervisor shutdown');
  assertBoolean(value.completed, 'supervisor shutdown completion', true);
  assertInteger(value.processesRemaining, 'shutdown processes remaining', 0, 0);
  assertInteger(value.socketsRemaining, 'shutdown sockets remaining', 0, 0);
  assertBoolean(value.evidenceHeadroomReleased, 'evidence headroom release', true);
  return instantMs(value.endedAt, 'shutdown endedAt');
}

function validateFinalEvidence(value, context, outcome) {
  exactKeys(value, [
    'startedAt',
    'endedAt',
    'harbor',
    'docker',
    'mounts',
    'cgroup',
    'resources',
    'network',
    'provider',
    'cleanup',
  ], 'final runtime evidence');
  const started = instantMs(value.startedAt, 'runtime evidence startedAt');
  const ended = instantMs(value.endedAt, 'runtime evidence endedAt');
  if (started !== instantMs(context.runnerResult.startedAt, 'runner result startedAt')
      || ended < instantMs(context.runnerResult.endedAt, 'runner result endedAt')) {
    invalid('runtime evidence does not cover the runner lifetime');
  }

  exactKeys(value.harbor, ['completed', 'exitCode', 'executableHash'], 'Harbor evidence');
  assertBoolean(value.harbor.completed, 'Harbor completion', true);
  assertInteger(value.harbor.exitCode, 'Harbor exit code', 0, 255);
  if (value.harbor.exitCode !== context.runnerResult.exitCode
      || value.harbor.executableHash !== context.request.bindings.harborExecutableHash) {
    invalid('Harbor evidence does not match the trusted runner result');
  }

  exactKeys(value.docker, [
    'eventsHash',
    'eventsComplete',
    'containerIdHash',
    'imageDigest',
    'policyCompliant',
    'containersRemaining',
    'networksRemaining',
    'volumesRemaining',
  ], 'Docker evidence');
  assertHash(value.docker.eventsHash, 'Docker event hash');
  assertHash(value.docker.containerIdHash, 'Docker container identity hash');
  if (value.docker.imageDigest !== context.request.bindings.imageDigest) invalid('Docker image identity drifted');
  assertBoolean(value.docker.eventsComplete, 'Docker event completeness', true);
  assertBoolean(value.docker.policyCompliant, 'Docker policy compliance', true);
  for (const field of ['containersRemaining', 'networksRemaining', 'volumesRemaining']) {
    assertInteger(value.docker[field], `Docker ${field}`, 0, 0);
  }

  exactKeys(value.mounts, [
    'inventoryHash',
    'policyCompliant',
    'outsideAllowedWrites',
    'daemonRootFilesystemId',
    'workspaceFilesystemId',
  ], 'mount evidence');
  assertHash(value.mounts.inventoryHash, 'mount inventory hash');
  assertBoolean(value.mounts.policyCompliant, 'mount policy compliance', true);
  assertBoolean(value.mounts.outsideAllowedWrites, 'outside-allowlist mount writes', false);
  if (value.mounts.daemonRootFilesystemId !== context.platform.filesystem.boundedRootId
      || value.mounts.workspaceFilesystemId !== context.platform.filesystem.boundedRootId) {
    invalid('mutable paths escaped the bounded filesystem');
  }

  exactKeys(value.cgroup, [
    'evidenceHash',
    'id',
    'pathHash',
    'populated',
    'processesRemaining',
    'limitsEnforced',
  ], 'cgroup evidence');
  assertHash(value.cgroup.evidenceHash, 'cgroup evidence hash');
  if (value.cgroup.id !== context.request.bindings.cgroupId
      || value.cgroup.pathHash !== context.request.bindings.cgroupPathHash) {
    invalid('cgroup final identity drifted');
  }
  assertBoolean(value.cgroup.populated, 'cgroup populated state', false);
  assertInteger(value.cgroup.processesRemaining, 'cgroup processes remaining', 0, 0);
  assertBoolean(value.cgroup.limitsEnforced, 'cgroup limit enforcement', true);

  exactKeys(value.resources, [
    'evidenceHash',
    'cpuWithinLimit',
    'memoryWithinLimit',
    'pidsWithinLimit',
    'oomKilled',
  ], 'resource evidence');
  assertHash(value.resources.evidenceHash, 'resource evidence hash');
  for (const field of ['cpuWithinLimit', 'memoryWithinLimit', 'pidsWithinLimit']) {
    assertBoolean(value.resources[field], `resource ${field}`, true);
  }
  assertBoolean(value.resources.oomKilled, 'resource OOM state', false);

  exactKeys(value.network, [
    'evidenceHash',
    'taskNetworkNone',
    'runnerEgressDenied',
    'brokerOnlyEgress',
    'metadataDenied',
    'rawSocketDenied',
  ], 'network evidence');
  assertHash(value.network.evidenceHash, 'network evidence hash');
  for (const field of [
    'taskNetworkNone',
    'runnerEgressDenied',
    'brokerOnlyEgress',
    'metadataDenied',
    'rawSocketDenied',
  ]) assertBoolean(value.network[field], `network ${field}`, true);

  exactKeys(value.provider, [
    'usageHash',
    'identityHash',
    'spendMicrousd',
    'billingCertain',
    'budgetComplete',
    'withinTrialCeiling',
    'attempts',
  ], 'provider evidence');
  assertHash(value.provider.usageHash, 'provider usage hash');
  assertHash(value.provider.identityHash, 'provider identity hash');
  assertInteger(value.provider.spendMicrousd, 'provider spend', 0, context.request.budget.trialCeilingMicrousd);
  assertInteger(value.provider.attempts, 'provider attempts', 0, 100_000);
  if (value.provider.spendMicrousd > 0 && value.provider.attempts === 0) {
    invalid('provider spend has no attempt evidence');
  }
  for (const field of ['billingCertain', 'budgetComplete', 'withinTrialCeiling']) {
    assertBoolean(value.provider[field], `provider ${field}`, true);
  }

  exactKeys(value.cleanup, [
    'completed',
    'containersRemaining',
    'networksRemaining',
    'volumesRemaining',
    'processesRemaining',
    'cgroupPopulated',
  ], 'cleanup evidence');
  assertBoolean(value.cleanup.completed, 'cleanup completion', true);
  assertBoolean(value.cleanup.cgroupPopulated, 'cleanup cgroup population', false);
  for (const field of [
    'containersRemaining',
    'networksRemaining',
    'volumesRemaining',
    'processesRemaining',
  ]) assertInteger(value.cleanup[field], `cleanup ${field}`, 0, 0);
  if (value.cleanup.containersRemaining !== value.docker.containersRemaining
      || value.cleanup.networksRemaining !== value.docker.networksRemaining
      || value.cleanup.volumesRemaining !== value.docker.volumesRemaining
      || value.cleanup.processesRemaining !== value.cgroup.processesRemaining
      || value.cleanup.cgroupPopulated !== value.cgroup.populated) {
    invalid('cleanup evidence disagrees with runtime inventories');
  }
  if (outcome.status === 'succeeded'
      && (context.runnerResult.exitCode !== 0 || value.harbor.exitCode !== 0)) {
    invalid('successful outcome contradicts the observed exit status');
  }
  return { started, ended };
}

function validateOutcome(value) {
  const outcome = cloneOpaqueJson(value, 'runtime outcome');
  exactKeys(outcome, ['status', 'exitReason'], 'runtime outcome');
  if (!['succeeded', 'failed', 'invalid'].includes(outcome.status)) invalid('runtime outcome status is invalid');
  if (typeof outcome.exitReason !== 'string' || !SAFE_REASON.test(outcome.exitReason)) {
    invalid('runtime outcome exit reason is not allowlisted');
  }
  return outcome;
}

function normalizeReason(value) {
  const allowed = new Set([
    'control-channel-loss',
    'controller-channel-closed',
    'finalization-failure',
    'operator-requested',
    'prepare-failure',
    'runner-failure',
    'runtime-fail-stop',
  ]);
  return typeof value === 'string' && SAFE_REASON.test(value) && allowed.has(value)
    ? value
    : 'runtime-fail-stop';
}

/**
 * Privileged one-sandbox/one-trial supervisor state machine.
 *
 * Effects are injected intentionally: production supplies Linux/cgroup/Docker
 * operations, while unit tests can prove policy and ordering without pretending
 * that a macOS process is a Linux trust boundary.
 */
export function createRuntimeSupervisor({
  signingKey,
  controllerVerificationKey = signingKey,
  keyId = 'runtime-supervisor-1',
  expectedControllerKeyId,
  effects,
  clock = { now: () => Date.now() },
  nonceFactory,
  limits: rawLimits = {},
} = {}) {
  if ((!Buffer.isBuffer(signingKey) && !(signingKey instanceof Uint8Array))
      || signingKey.length < 32
      || signingKey.length > 128
      || (!Buffer.isBuffer(controllerVerificationKey) && !(controllerVerificationKey instanceof Uint8Array))
      || controllerVerificationKey.length < 32
      || controllerVerificationKey.length > 128) {
    invalid('runtime supervisor requires bounded HMAC key bytes', 'ERR_RUNTIME_SUPERVISOR_CONFIG');
  }
  assertSafeId(keyId, 'supervisor key id', 64);
  assertSafeId(expectedControllerKeyId, 'controller key id', 64);
  if (!effects || typeof effects !== 'object') invalid('runtime effects are required', 'ERR_RUNTIME_SUPERVISOR_CONFIG');
  for (const method of REQUIRED_EFFECTS) {
    if (typeof effects[method] !== 'function') {
      invalid('runtime effects are incomplete', 'ERR_RUNTIME_SUPERVISOR_CONFIG');
    }
  }
  if (!clock || typeof clock.now !== 'function') invalid('runtime clock is invalid', 'ERR_RUNTIME_SUPERVISOR_CONFIG');
  if (nonceFactory !== undefined && typeof nonceFactory !== 'function') {
    invalid('runtime nonce factory is invalid', 'ERR_RUNTIME_SUPERVISOR_CONFIG');
  }
  if (!isPlainObject(rawLimits)) invalid('runtime limits are invalid', 'ERR_RUNTIME_SUPERVISOR_CONFIG');
  const limits = {
    requiredFilesystemBytes: rawLimits.requiredFilesystemBytes ?? TEN_GIB,
    evidenceReserveBytes: rawLimits.evidenceReserveBytes ?? DEFAULT_EVIDENCE_RESERVE_BYTES,
    privateDaemonDataRoot: rawLimits.privateDaemonDataRoot ?? '/engineer-bounded/docker',
  };
  assertInteger(limits.requiredFilesystemBytes, 'required filesystem bytes', TEN_GIB, TEN_GIB);
  assertInteger(limits.evidenceReserveBytes, 'evidence reserve bytes', 64 * 1024 * 1024, TEN_GIB - 1);
  assertAbsolutePath(limits.privateDaemonDataRoot, 'private daemon data root');

  const signingBytes = Buffer.from(signingKey);
  const verificationBytes = Buffer.from(controllerVerificationKey);
  const nextNonce = nonceFactory ?? generateNonce;
  let state = 'created';
  let sessionId;
  let trialId;
  let request = null;
  let lease = null;
  let runnerSpec = null;
  let runnerResult = null;
  let platform = null;
  let daemon = null;
  let proxy = null;
  let broker = null;
  let providerKeyFd = null;
  let providerFdOpen = false;
  let readinessLeaseHash;
  let finalAttestationHash;
  let controlChannelOpen = false;
  let detachChannelLoss = null;
  let failPromise = null;

  function wipeKeys() {
    signingBytes.fill(0);
    verificationBytes.fill(0);
  }

  function assertState(expected) {
    if (state !== expected) lifecycle(state, expected);
  }

  async function safeEffect(method, argument) {
    const operationState = state;
    try {
      const result = await effects[method](argument);
      if (['preparing', 'running', 'finalizing'].includes(operationState)
          && state !== operationState) {
        invalid('runtime operation lost control-channel custody');
      }
      return result;
    } catch {
      invalid(`privileged runtime effect ${method} failed`, 'ERR_RUNTIME_SUPERVISOR_EFFECT');
    }
  }

  function beginFailClosed(reason = 'runtime-fail-stop') {
    if (state === 'finalized') {
      return Promise.reject(new RuntimeSupervisorError(
        'invalid supervisor lifecycle: finalized evidence cannot re-enter fail-stop',
        'ERR_RUNTIME_SUPERVISOR_LIFECYCLE'
      ));
    }
    if (failPromise) return failPromise;
    if (state === 'failed') return Promise.resolve();
    const safeReason = normalizeReason(reason);
    state = 'fail-stopping';
    controlChannelOpen = false;
    try { detachChannelLoss?.(); } catch { /* the runtime still fails closed */ }
    detachChannelLoss = null;
    failPromise = (async () => {
      try { await effects.killTrialCgroup({ reason: safeReason }); } catch { /* continue fail-stop */ }
      if (providerFdOpen && providerKeyFd !== null) {
        try { await effects.closeInheritedFd(providerKeyFd); } catch { /* shutdown remains mandatory */ }
        providerFdOpen = false;
        providerKeyFd = null;
      }
      try { await effects.shutdown({ reason: safeReason, failClosed: true }); } catch { /* final state stays failed */ }
      runnerSpec = null;
      runnerResult = null;
      daemon = null;
      proxy = null;
      broker = null;
      request = null;
      lease = null;
      state = 'failed';
      wipeKeys();
    })();
    return failPromise;
  }

  async function failedClosed(reason) {
    await beginFailClosed(reason);
    throw new RuntimeSupervisorError('runtime supervisor failed closed', 'ERR_RUNTIME_SUPERVISOR_FAILED_CLOSED');
  }

  async function prepare(input) {
    assertState('created');
    state = 'preparing';
    try {
      const prepared = cloneOpaqueJson(input, 'supervisor prepare input');
      exactKeys(prepared, [
        'request',
        'providerKeyFd',
        'dockerPolicy',
        'brokerPolicy',
        'runner',
      ], 'supervisor prepare input');
      runnerSpec = validateRunner(prepared.runner);
      assertInteger(prepared.providerKeyFd, 'provider key descriptor', 3, 1_048_575);
      providerKeyFd = prepared.providerKeyFd;
      providerFdOpen = true;
      const dockerPolicy = cloneOpaqueJson(prepared.dockerPolicy, 'Docker proxy policy');
      const brokerPolicy = cloneOpaqueJson(prepared.brokerPolicy, 'provider broker policy');
      assertCredentialFree(dockerPolicy, 'Docker proxy policy');
      assertCredentialFree(brokerPolicy, 'provider broker policy');
      request = verifyProtocolDocument(prepared.request, verificationBytes, {
        expectedKeyId: expectedControllerKeyId,
        now: new Date(nowMs(clock)),
      });
      if (request.schema !== RuntimeProtocolSchemas.request) invalid('supervisor expected a trial request');
      sessionId = request.sessionId;
      trialId = request.trialId;
      const requestHash = protocolDocumentHash(request);

      controlChannelOpen = true;
      const installedDetach = effects.installControlChannelLossHandler((reason) => beginFailClosed(reason));
      if (typeof installedDetach !== 'function') invalid('control channel loss handler was not installed');
      if (state !== 'preparing') {
        try { installedDetach(); } catch { /* fail-stop is already in progress */ }
        return failedClosed('control-channel-loss');
      }
      detachChannelLoss = installedDetach;

      platform = canonicalClone(await safeEffect('inspectPlatform'), 'platform observation');
      validatePlatform(platform, request, limits);
      const fdObservation = canonicalClone(
        await safeEffect('inspectProviderKeyFd', providerKeyFd),
        'provider key descriptor observation'
      );
      validateProviderFd(fdObservation);
      const headroom = canonicalClone(await safeEffect('reserveEvidenceHeadroom', {
        bytes: limits.evidenceReserveBytes,
        filesystemId: platform.filesystem.boundedRootId,
        trialId: request.trialId,
      }), 'evidence headroom observation');
      validateHeadroom(headroom, platform, limits);

      daemon = canonicalClone(await safeEffect('startPrivateDaemon', {
        dataRoot: limits.privateDaemonDataRoot,
        expectedDaemonId: request.bindings.daemonId,
        expectedFilesystemId: platform.filesystem.boundedRootId,
        sandboxId: request.bindings.sandboxId,
        trialId: request.trialId,
      }), 'private daemon observation');
      validateDaemon(daemon, platform, request, limits);

      proxy = canonicalClone(await safeEffect('startDockerProxy', {
        policy: dockerPolicy,
        requestHash,
        trialId: request.trialId,
        condition: request.bindings.condition,
        runnerUid: platform.identities.runnerUid,
        runnerGid: platform.identities.runnerGid,
        upstreamSocketPath: daemon.socketPath,
      }), 'Docker proxy observation');
      validateProxy(proxy, daemon, platform);

      const preBrokerReadiness = canonicalClone(
        await safeEffect('inspectReadiness', {
          phase: 'pre-broker',
          requestHash,
          daemon,
          proxy,
          broker: {},
        }),
        'pre-broker readiness observation'
      );
      validateReadiness(preBrokerReadiness, platform, request, { brokerInstalled: false });

      let brokerStaticPolicyHash;
      try {
        brokerStaticPolicyHash = providerBrokerStaticPolicyHash(brokerPolicy);
      } catch {
        invalid('provider broker static policy is invalid');
      }

      const issuedMs = Math.max(nowMs(clock), instantMs(request.issuedAt, 'request issuedAt'));
      const expiryMs = Math.min(issuedMs + 5 * 60 * 1_000, instantMs(request.expiresAt, 'request expiresAt'));
      if (expiryMs <= issuedMs) invalid('signed request has no readiness lease lifetime remaining');
      const nonce = nextNonce();
      if (nonce === request.nonce) invalid('readiness nonce repeats the request nonce');
      const unsignedLease = {
        schema: RuntimeProtocolSchemas.readiness,
        protocolVersion: 1,
        sessionId: request.sessionId,
        trialId: request.trialId,
        sequence: request.sequence + 1,
        nonce,
        issuedAt: new Date(issuedMs).toISOString(),
        expiresAt: new Date(expiryMs).toISOString(),
        requestHash,
        requestNonce: request.nonce,
        previousTrialChainHash: request.previousTrialChainHash,
        bindings: request.bindings,
        budget: request.budget,
        readiness: {
          noProviderProbeHash: canonicalSha256(preBrokerReadiness.noProviderProbe),
          dockerProxyPolicyHash: proxy.policyHash,
          brokerPolicyHash: brokerStaticPolicyHash,
          storageProbeHash: canonicalSha256(preBrokerReadiness.storageProbe),
          privateDaemonBounded: true,
          realDaemonDenied: true,
          taskNetworkNone: true,
          brokerOnlyEgress: true,
          cgroupDelegated: true,
          evidenceHeadroomReserved: true,
        },
      };
      lease = signProtocolDocument(unsignedLease, signingBytes, { keyId });
      verifyReadinessLeaseForRequest(lease, request);
      readinessLeaseHash = protocolDocumentHash(lease);
      const brokerBinding = bindBrokerPolicy(
        brokerPolicy,
        request,
        lease.sequence,
        readinessLeaseHash
      );
      broker = canonicalClone(await safeEffect('startProviderBroker', {
        policy: brokerBinding.policy,
        providerKeyFd,
        leaseHash: readinessLeaseHash,
        leaseId: brokerBinding.leaseId,
        leaseSequence: brokerBinding.leaseSequence,
        requestHash,
        trialId: request.trialId,
        brokerUid: platform.identities.brokerUid,
        brokerGid: platform.identities.brokerGid,
        sharedGid: platform.identities.brokerClientGid,
        budget: request.budget,
      }), 'provider broker observation');
      validateBroker(broker, platform, daemon, proxy, brokerBinding);
      const closeResult = canonicalClone(
        await safeEffect('closeInheritedFd', providerKeyFd),
        'provider key descriptor close result'
      );
      exactKeys(closeResult, ['closed'], 'provider key descriptor close result');
      assertBoolean(closeResult.closed, 'provider key descriptor closure', true);
      providerFdOpen = false;
      providerKeyFd = null;

      const observedReadiness = canonicalClone(
        await safeEffect('inspectReadiness', {
          phase: 'post-broker',
          requestHash,
          daemon,
          proxy,
          broker,
        }),
        'post-broker readiness observation'
      );
      validateReadiness(observedReadiness, platform, request);
      if (canonicalSha256(observedReadiness.noProviderProbe) !== lease.readiness.noProviderProbeHash
          || canonicalSha256(observedReadiness.storageProbe) !== lease.readiness.storageProbeHash
          || broker.policyHash !== lease.readiness.brokerPolicyHash) {
        invalid('post-broker readiness drifted from the undisclosed signed candidate');
      }

      if (state !== 'preparing') return failedClosed('control-channel-loss');
      state = 'prepared';
      return canonicalClone(lease, 'readiness lease');
    } catch {
      return failedClosed('prepare-failure');
    }
  }

  async function run() {
    assertState('prepared');
    state = 'running';
    try {
      const launched = await safeEffect('launchRunner', {
        uid: platform.identities.runnerUid,
        gid: platform.identities.runnerGid,
        supplementaryGids: [platform.identities.brokerClientGid],
        argv: [...runnerSpec.argv],
        cwd: runnerSpec.cwd,
        env: {
          ...runnerSpec.env,
          DOCKER_HOST: `unix://${proxy.socketPath}`,
          ENGINEER_PROVIDER_BROKER_SOCKET: broker.socketPath,
          ENGINEER_PROVIDER_LEASE_ID: broker.leaseId,
          ENGINEER_PROVIDER_TRIAL_ID: request.trialId,
          ENGINEER_PROVIDER_LEASE_DIGEST: readinessLeaseHash,
          ENGINEER_PROVIDER_LEASE_SEQUENCE: String(broker.leaseSequence),
          ENGINEER_RUNTIME_LEASE_HASH: readinessLeaseHash,
        },
        inheritedFds: [],
        timeoutMs: runnerSpec.timeoutMs,
        requestHash: protocolDocumentHash(request),
        leaseHash: readinessLeaseHash,
      });
      if (state !== 'running') return failedClosed('control-channel-loss');
      runnerResult = canonicalClone(launched, 'runner result');
      validateRunnerResult(runnerResult, {
        lease,
        observedAt: nowMs(clock),
        timeoutMs: runnerSpec.timeoutMs,
      });
      state = 'exited';
      return canonicalClone(runnerResult, 'runner result');
    } catch {
      return failedClosed('runner-failure');
    }
  }

  async function finalize(input) {
    assertState('exited');
    state = 'finalizing';
    try {
      const finalInput = cloneOpaqueJson(input, 'supervisor finalization input');
      exactKeys(finalInput, ['outcome'], 'supervisor finalization input');
      const outcome = validateOutcome(finalInput.outcome);
      const collected = await safeEffect('collectFinalEvidence', {
        requestHash: protocolDocumentHash(request),
        leaseHash: readinessLeaseHash,
        runnerResult,
        daemon,
        proxy,
        broker,
      });
      const shutdown = canonicalClone(await safeEffect('shutdown', {
        reason: 'finalize',
        failClosed: false,
      }), 'supervisor shutdown');
      if (state !== 'finalizing') return failedClosed('control-channel-loss');
      const evidence = canonicalClone(collected, 'final runtime evidence');
      const evidenceObservedAt = nowMs(clock);
      const coverage = validateFinalEvidence(evidence, {
        request,
        runnerResult,
        platform,
      }, outcome);
      const shutdownEnded = validateShutdown(shutdown);
      if (coverage.started < instantMs(lease.issuedAt, 'readiness lease issuedAt')
          || coverage.ended > shutdownEnded
          || shutdownEnded > evidenceObservedAt + 30_000) {
        invalid('final runtime evidence falls outside its signed lease or observation window');
      }
      const issuedMs = Math.max(evidenceObservedAt, shutdownEnded);
      const nonce = nextNonce();
      if (!nonce || nonce === request.nonce || nonce === lease.nonce) invalid('final attestation nonce is missing or repeated');
      const unsignedAttestation = {
        schema: RuntimeProtocolSchemas.trialFinal,
        protocolVersion: 1,
        sessionId: request.sessionId,
        trialId: request.trialId,
        sequence: lease.sequence + 1,
        nonce,
        issuedAt: new Date(issuedMs).toISOString(),
        expiresAt: new Date(issuedMs + 24 * 60 * 60 * 1_000).toISOString(),
        requestHash: protocolDocumentHash(request),
        readinessLeaseHash,
        previousTrialChainHash: request.previousTrialChainHash,
        bindings: request.bindings,
        budget: request.budget,
        outcome: {
          status: outcome.status,
          exitReason: outcome.exitReason,
          providerSpendMicrousd: evidence.provider.spendMicrousd,
          providerUsageHash: evidence.provider.usageHash,
        },
        runtimeEvidence: {
          evidenceHash: canonicalSha256({ evidence, shutdown }),
          dockerEventsHash: evidence.docker.eventsHash,
          mountInventoryHash: evidence.mounts.inventoryHash,
          cgroupEvidenceHash: canonicalSha256({
            cgroup: evidence.cgroup,
            resources: evidence.resources,
          }),
          networkEvidenceHash: canonicalSha256(evidence.network),
          budgetEvidenceHash: canonicalSha256(evidence.provider),
          startedAt: new Date(coverage.started).toISOString(),
          endedAt: new Date(shutdownEnded).toISOString(),
        },
        cleanup: evidence.cleanup,
      };
      const attestation = signProtocolDocument(unsignedAttestation, signingBytes, { keyId });
      verifyTrialAttestationForLease(attestation, lease, request);
      finalAttestationHash = protocolDocumentHash(attestation);
      controlChannelOpen = false;
      try { detachChannelLoss?.(); } catch { /* attestation is already complete */ }
      detachChannelLoss = null;
      state = 'finalized';
      request = null;
      lease = null;
      runnerSpec = null;
      runnerResult = null;
      daemon = null;
      proxy = null;
      broker = null;
      wipeKeys();
      return canonicalClone(attestation, 'trial final attestation');
    } catch {
      return failedClosed('finalization-failure');
    }
  }

  async function failStop(reason = 'operator-requested') {
    await beginFailClosed(reason);
    return snapshot();
  }

  function controlChannelLost(reason = 'controller-channel-closed') {
    return beginFailClosed(reason);
  }

  function snapshot() {
    const value = {
      state,
      sessionId,
      trialId,
      readinessLeaseHash,
      finalAttestationHash,
      providerKeyFdRetained: providerFdOpen,
      controlChannelOpen,
    };
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  }

  return Object.freeze({
    prepare,
    run,
    finalize,
    failStop,
    controlChannelLost,
    snapshot,
  });
}
