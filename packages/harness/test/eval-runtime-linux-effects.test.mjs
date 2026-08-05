import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  LinuxRuntimeEffectsError,
  planLinuxNetworkPolicy,
  createLinuxRuntimeEffects,
  createNodeLinuxDriver,
} from '../../../evals/runtime/linux-effects.mjs';
import { providerBrokerStaticPolicyHash } from '../../../evals/runtime/provider-broker.mjs';
import { createTrialSecurityContract } from '../../../evals/runtime/trial-security-contract.mjs';
import { archivedConditionReadOnlyBindVariants } from '../../../evals/runtime/trial-archive.mjs';
import {
  createRuntimeProbeHandoff,
  validateRuntimeProbeHandoff,
} from '../../../evals/runtime/runtime-probe.mjs';
import {
  READINESS_PREFLIGHT_PATH,
  READINESS_PREFLIGHT_PUBLICATION_SCHEMA,
  createReadinessPreflightReceipt,
} from '../../../evals/runtime/readiness-preflight.mjs';
import {
  createRuntimeEvidenceHandoff,
  createRuntimeNetworkPolicyReceipt,
  validateRuntimeEvidenceHandoff,
} from '../../../evals/runtime/runtime-evidence.mjs';

const TEN_GIB = 10 * 1024 * 1024 * 1024;
const HASH = (character) => character.repeat(64);

function nodeDriverMethodSource(name, nextName) {
  const source = fs.readFileSync(new URL('../../../evals/runtime/linux-effects.mjs', import.meta.url), 'utf8');
  const start = source.indexOf(`async ${name}(spec)`);
  const end = source.indexOf(`async ${nextName}(spec)`, start);
  assert.ok(start >= 0 && end > start, `${name} source is missing`);
  return source.slice(start, end);
}

function stableHash(value) {
  const canonical = (current) => {
    if (Array.isArray(current)) return `[${current.map(canonical).join(',')}]`;
    if (current && typeof current === 'object') {
      return `{${Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${canonical(current[key])}`).join(',')}}`;
    }
    return JSON.stringify(current);
  };
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

test('readiness canary cleanup cannot replace its primary failure', () => {
  for (const method of [
    nodeDriverMethodSource('runStorageReadinessCanary', 'runReadinessDenialProbe'),
    nodeDriverMethodSource('runTaskIsolationCanary', 'runReadinessProbe'),
  ]) {
    assert.match(method, /let primaryError;/);
    assert.match(method, /let cleanupError;/);
    assert.match(method, /primaryError = error;/);
    assert.match(method, /if \(primaryError\) throw primaryError;/);
    assert.match(method, /if \(cleanupError\) throw cleanupError;/);
    const finallyBlocks = method.match(/finally\s*\{[\s\S]*?\n\s*\}/g) ?? [];
    assert.equal(finallyBlocks.some((block) => /\bthrow\b/.test(block)), false);
  }
});

test('task-isolation canary bounds its trusted timeout before Docker work', () => {
  const source = nodeDriverMethodSource('runTaskIsolationCanary', 'runReadinessProbe');
  assert.match(source, /Number\.isSafeInteger\(spec\.timeoutMs\)/);
  assert.match(source, /spec\.timeoutMs < 1_000/);
  assert.match(source, /spec\.timeoutMs > 60_000/);
});

function topology(overrides = {}) {
  const base = {
    sandboxId: 'sandbox-1',
    sandboxBootId: 'boot-1',
    daemonId: 'private-daemon-1',
    filesystem: {
      sandboxRoot: '/engineer-bounded',
      boundedRoot: '/engineer-bounded',
      defaultDockerRoot: '/var/lib/docker',
      expectedBytes: TEN_GIB,
      id: 'bounded-fs',
      defaultDockerRootId: 'forbidden-host-fs',
    },
    paths: {
      runtimeDirectory: '/run/engineer',
      evidenceDirectory: '/engineer-bounded/evidence',
      evidenceReserve: '/engineer-bounded/evidence/.reserve',
      workspace: '/engineer-bounded/workspace',
      daemonDataRoot: '/engineer-bounded/docker',
      daemonExecRoot: '/run/engineer/docker-exec',
      daemonPidFile: '/run/engineer/private-docker.pid',
      daemonSocket: '/run/engineer/private-docker.sock',
      proxySocket: '/run/engineer/harbor-docker.sock',
      brokerDirectory: '/run/engineer/provider',
      brokerSocket: '/run/engineer/provider/provider.sock',
      brokerPolicyDirectory: '/engineer-bounded/broker',
      brokerPolicy: '/engineer-bounded/broker/provider-policy.json',
    },
    executables: {
      dockerd: '/usr/local/bin/dockerd',
      cgroupExec: '/opt/engineer/bin/engineer-cgroup-exec',
      taskIsolationProbe: '/opt/engineer/bin/engineer-task-isolation-probe',
      readinessDenialProbe: '/opt/engineer/bin/engineer-readiness-denial-probe',
      iptables: '/usr/sbin/iptables',
      ip6tables: '/usr/sbin/ip6tables',
      supervisor: '/opt/engineer/bin/engineer-runtime-supervisor',
      providerBroker: '/opt/engineer/bin/engineer-provider-broker',
      readinessProbe: '/opt/engineer/bin/engineer-runtime-probe',
      evidenceCollector: '/opt/engineer/bin/engineer-runtime-evidence',
      runner: '/opt/engineer/bin/engineer-eval-runner',
      harbor: '/opt/engineer/bin/harbor',
      sentinel: '/usr/bin/sleep',
    },
    hashes: {
      supervisor: HASH('2'),
      dockerd: HASH('8'),
      cgroupExec: HASH('9'),
      taskIsolationProbe: HASH('1'),
      readinessDenialProbe: HASH('0'),
      iptables: HASH('a'),
      ip6tables: HASH('b'),
      sentinel: HASH('c'),
      providerBroker: HASH('5'),
      readinessProbe: HASH('6'),
      evidenceCollector: HASH('7'),
      runner: HASH('3'),
      harbor: HASH('4'),
      daemonRoot: HASH('e'),
    },
    identities: {
      supervisorUid: 0,
      runnerUid: 2001,
      runnerGid: 2001,
      brokerUid: 2002,
      brokerGid: 2002,
      brokerClientGid: 2003,
    },
    cgroup: {
      id: 'trial-cgroup-1',
      path: '/sys/fs/cgroup/engineer/trial-cgroup-1',
      pathHash: HASH('f'),
      cpuMax: '200000 100000',
      memoryMax: 4 * 1024 * 1024 * 1024,
      pidsMax: 512,
    },
    imageDigest: `sha256:${HASH('d')}`,
    custody: { evidenceRetentionDays: 30 },
    timeouts: {
      daemonReadyMs: 30_000,
      brokerReadyMs: 30_000,
      helperMs: 30_000,
      shutdownMs: 30_000,
    },
  };
  return {
    ...base,
    ...overrides,
    filesystem: { ...base.filesystem, ...overrides.filesystem },
    paths: { ...base.paths, ...overrides.paths },
    executables: { ...base.executables, ...overrides.executables },
    hashes: { ...base.hashes, ...overrides.hashes },
    identities: { ...base.identities, ...overrides.identities },
    cgroup: { ...base.cgroup, ...overrides.cgroup },
    custody: { ...base.custody, ...overrides.custody },
    timeouts: { ...base.timeouts, ...overrides.timeouts },
  };
}

function brokerPolicy(overrides = {}) {
  return {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'moonshotai/kimi-k2.7-code-20260612',
    provider: {
      order: ['moonshotai/int4'],
      expectedResolvedNames: ['Moonshot AI'],
      allowFallbacks: false,
    },
    settings: { temperature: null, reasoning: null, toolChoice: 'auto' },
    maxTokens: 100,
    pricing: { inputPerM: 0.95, cachedInputPerM: 0.19, outputPerM: 4 },
    sessionCeilingUsd: 1.3,
    trials: [{
      leaseId: 'lease-trial-1',
      leaseDigest: HASH('a'),
      trialId: 'trial-1',
      leaseSequence: 2,
      ceilingUsd: 0.65,
    }],
    ...overrides,
  };
}

function readiness(topo = topology(), overrides = {}) {
  const base = {
    cgroup: {
      id: topo.cgroup.id,
      pathHash: topo.cgroup.pathHash,
      populated: true,
      controllersEnforced: true,
      runnerUid: topo.identities.runnerUid,
    },
    noProviderProbe: {
      completed: true,
      imageDigest: topo.imageDigest,
      genericMountPassed: true,
      harnessMountPassed: true,
      providerCalls: 0,
      providerCredentialAbsent: true,
    },
    storageProbe: {
      filesystemId: topo.filesystem.id,
      totalBytes: topo.filesystem.expectedBytes,
      enospcObserved: true,
      evidenceHeadroomRecovered: true,
    },
    runner: {
      uid: topo.identities.runnerUid,
      effectiveCapabilities: 0,
      privateDaemonDenied: true,
      realDaemonDenied: true,
      alternateDaemonDenied: true,
      mountDenied: true,
      ptraceDenied: true,
      providerEgressDenied: true,
      metadataDenied: true,
      daytonaCredentialsAbsent: true,
      providerCredentialsAbsent: true,
    },
    task: {
      networkNone: true,
      readOnlyRoot: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      brokerReachable: false,
      brokerSocketMounted: false,
      brokerClientGidPresent: false,
    },
    broker: { uid: topo.identities.brokerUid, onlyProviderEgress: true },
    executables: {
      runnerExecutableHash: topo.hashes.runner,
      harborExecutableHash: topo.hashes.harbor,
    },
  };
  return { ...base, ...overrides };
}

function finalEvidence(topo = topology(), overrides = {}) {
  const base = {
    startedAt: '2026-08-04T16:00:02.000Z',
    endedAt: '2026-08-04T16:00:08.000Z',
    harbor: { completed: true, exitCode: 0, executableHash: topo.hashes.harbor },
    docker: {
      eventsHash: HASH('6'),
      eventsComplete: true,
      containerIdHash: HASH('7'),
      imageDigest: topo.imageDigest,
      policyCompliant: true,
      containersRemaining: 0,
      networksRemaining: 0,
      volumesRemaining: 0,
    },
    mounts: {
      inventoryHash: HASH('8'),
      policyCompliant: true,
      outsideAllowedWrites: false,
      daemonRootFilesystemId: topo.filesystem.id,
      workspaceFilesystemId: topo.filesystem.id,
    },
    cgroup: {
      evidenceHash: HASH('9'),
      id: topo.cgroup.id,
      pathHash: topo.cgroup.pathHash,
      populated: false,
      processesRemaining: 0,
      limitsEnforced: true,
    },
    resources: {
      evidenceHash: HASH('a'),
      cpuWithinLimit: true,
      memoryWithinLimit: true,
      pidsWithinLimit: true,
      oomKilled: false,
    },
    network: {
      evidenceHash: HASH('b'),
      taskNetworkNone: true,
      runnerEgressDenied: true,
      brokerOnlyEgress: true,
      metadataDenied: true,
      rawSocketDenied: true,
    },
    provider: {
      usageHash: HASH('c'),
      identityHash: HASH('d'),
      spendMicrousd: 100,
      billingCertain: true,
      budgetComplete: true,
      withinTrialCeiling: true,
      attempts: 1,
    },
    cleanup: {
      completed: true,
      containersRemaining: 0,
      networksRemaining: 0,
      volumesRemaining: 0,
      processesRemaining: 0,
      cgroupPopulated: false,
    },
  };
  return { ...base, ...overrides };
}

function taskObservation(topo, input) {
  const unsigned = {
    schema: 'engineer-live-task-container-observation.v1',
    trialId: input.contract.identity.trialId,
    containerIdHash: input.containerBindingHash,
    imageDigest: topo.imageDigest,
    materializationReceiptHash: input.materialization.receiptHash,
    probeExecutableHash: topo.hashes.taskIsolationProbe,
    mountNamespaceIdentityHash: HASH('1'),
    networkNamespaceIdentityHash: HASH('2'),
    bindInventoryHash: HASH('3'),
    writableMountInventoryHash: HASH('4'),
    interfaceInventoryHash: HASH('5'),
    rawSocketCanaryHash: HASH('6'),
    workspaceFilesystemId: topo.filesystem.id,
    networkMode: 'none',
    effectiveCapabilities: 0,
    noNewPrivileges: true,
    taskNetworkNone: true,
    rawSocketDenied: true,
    policyCompliant: true,
    outsideAllowedWrites: false,
  };
  return { ...unsigned, observationHash: stableHash(unsigned) };
}

function preflightPublication(topo, bindings) {
  const receipt = createReadinessPreflightReceipt({
    bindings,
    observations: {
      conditionMount: {
        condition: bindings.condition,
        passed: true,
        inventoryHash: HASH('a'),
      },
      noProvider: {
        completed: true,
        providerCalls: 0,
        providerCredentialAbsent: true,
        brokerSocketAbsent: true,
        proofHash: HASH('b'),
      },
      storage: {
        filesystemId: topo.filesystem.id,
        totalBytes: topo.filesystem.expectedBytes,
        bytesWritten: 8 * 1024 * 1024 * 1024,
        availableBytesAfterCleanup: 512 * 1024 * 1024,
        enospcObserved: true,
        evidenceHeadroomRecovered: true,
        proofHash: HASH('c'),
      },
      runner: {
        uid: 2001,
        effectiveCapabilities: 0,
        privateDaemonDenied: true,
        realDaemonDenied: true,
        alternateDaemonDenied: true,
        mountDenied: true,
        ptraceDenied: true,
        providerEgressDenied: true,
        metadataDenied: true,
        daytonaCredentialsAbsent: true,
        providerCredentialsAbsent: true,
        proofHash: HASH('d'),
      },
      task: {
        networkNone: true,
        readOnlyRoot: true,
        capabilitiesDropped: true,
        noNewPrivileges: true,
        brokerReachable: false,
        brokerSocketMounted: false,
        brokerClientGidPresent: false,
        observationHash: HASH('e'),
      },
    },
    producedAt: '2026-08-04T16:00:00.000Z',
    expiresAt: '2026-08-04T16:01:00.000Z',
    producerNonce: HASH('f'),
  });
  return {
    schema: READINESS_PREFLIGHT_PUBLICATION_SCHEMA,
    path: READINESS_PREFLIGHT_PATH,
    receiptHash: receipt.receiptHash,
    bindingHash: receipt.bindingHash,
    bindings: receipt.bindings,
  };
}

function socket(path, uid, gid, mode) {
  return { path, kind: 'socket', ownerUid: uid, groupGid: gid, mode, real: true };
}

function liveControlChannel(stream = new EventEmitter(), executionMode = 'controlled-provider') {
  return {
    schema: 'engineer-authenticated-control-channel.v1',
    kind: 'inherited-socket',
    kernelBound: true,
    executionMode,
    authenticated: true,
    open: true,
    receiptHash: HASH('1'),
    inputDescriptorHash: HASH('2'),
    outputDescriptorHash: HASH('3'),
    stream,
  };
}

function fakeDriver(topo = topology(), overrides = {}) {
  const calls = [];
  const channel = new EventEmitter();
  const handles = new Map();
  let processId = 100;
  const driver = {
    calls,
    channel,
    async inspectHost() {
      calls.push(['inspectHost']);
      return {
        platform: 'linux',
        effectiveUid: 0,
        sandboxId: topo.sandboxId,
        sandboxBootId: topo.sandboxBootId,
        supervisorExecutableHash: topo.hashes.supervisor,
        cgroupVersion: 2,
        cgroupDelegated: true,
        filesystem: {
          sandboxRootId: topo.filesystem.id,
          sandboxRootBytes: topo.filesystem.expectedBytes,
          boundedRootId: topo.filesystem.id,
          boundedRootBytes: topo.filesystem.expectedBytes,
          defaultDockerRootId: topo.filesystem.defaultDockerRootId,
          privateDaemonDataRoot: topo.paths.daemonDataRoot,
        },
        identities: { ...topo.identities },
        controlChannel: { kind: 'inherited-socket', authenticated: true, open: true },
        providerCredentialsAbsent: true,
        daytonaCredentialsAbsent: true,
        custody: {
          coreDumpsDisabled: true,
          evidenceStoreOwnerUid: 0,
          evidenceStoreMode: 0o700,
          evidenceRetentionDays: topo.custody.evidenceRetentionDays,
          snapshotCredentialExclusion: true,
        },
      };
    },
    async inspectDescriptor(fd) {
      calls.push(['inspectDescriptor', fd]);
      return { kind: 'pipe', open: true };
    },
    async hashExecutable(file) {
      calls.push(['hashExecutable', file]);
      const entries = Object.entries(topo.executables);
      const name = entries.find(([, executable]) => executable === file)?.[0];
      if (name === 'providerBroker') return topo.hashes.providerBroker;
      if (name === 'supervisor') return topo.hashes.supervisor;
      if (name === 'dockerd') return topo.hashes.dockerd;
      if (name === 'cgroupExec') return topo.hashes.cgroupExec;
      if (name === 'taskIsolationProbe') return topo.hashes.taskIsolationProbe;
      if (name === 'readinessDenialProbe') return topo.hashes.readinessDenialProbe;
      if (name === 'iptables') return topo.hashes.iptables;
      if (name === 'ip6tables') return topo.hashes.ip6tables;
      if (name === 'sentinel') return topo.hashes.sentinel;
      if (name === 'readinessProbe') return topo.hashes.readinessProbe;
      if (name === 'evidenceCollector') return topo.hashes.evidenceCollector;
      if (name === 'runner') return topo.hashes.runner;
      if (name === 'harbor') return topo.hashes.harbor;
      return null;
    },
    async reserveEvidence(spec) {
      calls.push(['reserveEvidence', spec]);
      return { bytes: spec.bytes, filesystemId: topo.filesystem.id, protectedFromRunner: true };
    },
    async ensureCgroup(spec) {
      calls.push(['ensureCgroup', spec]);
      return { id: topo.cgroup.id, pathHash: topo.cgroup.pathHash, limitsEnforced: true, writableByRunner: false };
    },
    async prepareDirectory(spec) {
      calls.push(['prepareDirectory', spec]);
      return { path: spec.path, ownerUid: spec.uid, groupGid: spec.gid, mode: spec.mode, real: true };
    },
    async inspectPath(path) {
      calls.push(['inspectPath', path]);
      if (path === topo.paths.brokerDirectory) {
        return { path, kind: 'directory', ownerUid: topo.identities.brokerUid, groupGid: topo.identities.brokerClientGid, mode: 0o2710, real: true };
      }
      if (path === topo.paths.brokerPolicyDirectory) {
        return { path, kind: 'directory', ownerUid: topo.identities.brokerUid, groupGid: topo.identities.brokerGid, mode: 0o700, real: true };
      }
      if (path === topo.paths.brokerPolicy) {
        return { path, kind: 'file', ownerUid: topo.identities.brokerUid, groupGid: topo.identities.brokerGid, mode: 0o600, real: true };
      }
      throw new Error('unexpected path');
    },
    async installNetworkPolicy(spec) {
      calls.push(['installNetworkPolicy', spec]);
      return {
        runnerEgressDenied: true,
        metadataDenied: true,
        rawSocketDenied: true,
        brokerOnlyEgress: true,
        providerAddresses: { ipv4: ['104.18.2.10'], ipv6: [] },
        dnsServers: [{ address: '10.0.0.2', family: 4, port: 53 }],
      };
    },
    async writePolicy(spec) {
      calls.push(['writePolicy', spec]);
      return { path: spec.path, ownerUid: spec.uid, mode: spec.mode, hash: stableHash(spec.value) };
    },
    async spawnProcess(spec) {
      calls.push(['spawnProcess', spec]);
      const handle = { id: ++processId, role: spec.role, alive: true, spec };
      handles.set(spec.role, handle);
      return handle;
    },
    async waitForSocket(spec) {
      calls.push(['waitForSocket', spec]);
      return true;
    },
    async inspectSocket(path) {
      calls.push(['inspectSocket', path]);
      if (path === topo.paths.daemonSocket) return socket(path, 0, 0, 0o600);
      if (path === topo.paths.proxySocket) return socket(path, 0, topo.identities.runnerGid, 0o660);
      if (path === topo.paths.brokerSocket) return socket(path, topo.identities.brokerUid, topo.identities.brokerClientGid, 0o660);
      throw new Error('unexpected socket');
    },
    async setSocketPolicy(spec) {
      calls.push(['setSocketPolicy', spec]);
      return true;
    },
    async inspectZeroProviderAbsence(spec) {
      calls.push(['inspectZeroProviderAbsence', spec]);
      return { socketAbsent: true, policyAbsent: true };
    },
    async runStorageReadinessCanary(spec) {
      calls.push(['runStorageReadinessCanary', spec]);
      const proof = {
        schema: 'engineer-readiness-storage-observation.v1',
        filesystemId: topo.filesystem.id,
        totalBytes: topo.filesystem.expectedBytes,
        bytesWritten: 8 * 1024 * 1024 * 1024,
        availableBytesAfterCleanup: 512 * 1024 * 1024,
        enospcObserved: true,
        evidenceHeadroomRecovered: true,
      };
      return { ...proof, proofHash: stableHash(proof) };
    },
    async runReadinessDenialProbe(spec) {
      calls.push(['runReadinessDenialProbe', spec]);
      return {
        uid: 2001,
        effectiveCapabilities: 0,
        privateDaemonDenied: true,
        realDaemonDenied: true,
        alternateDaemonDenied: true,
        mountDenied: true,
        ptraceDenied: true,
        providerEgressDenied: true,
        metadataDenied: true,
        daytonaCredentialsAbsent: true,
        providerCredentialsAbsent: true,
        proofHash: HASH('d'),
      };
    },
    async runTaskIsolationCanary(spec) {
      calls.push(['runTaskIsolationCanary', spec]);
      return {
        conditionMount: {
          condition: spec.condition,
          passed: true,
          inventoryHash: HASH('a'),
        },
        task: {
          networkNone: true,
          readOnlyRoot: true,
          capabilitiesDropped: true,
          noNewPrivileges: true,
          brokerReachable: false,
          brokerSocketMounted: false,
          brokerClientGidPresent: false,
          observationHash: HASH('e'),
        },
      };
    },
    async runReadinessProbe(spec) {
      calls.push(['runReadinessProbe', spec]);
      if (spec.handoff.phase === 'zero-provider') {
        return readiness(topo, {
          noProviderProbe: {
            completed: true,
            imageDigest: topo.imageDigest,
            condition: spec.handoff.readinessPreflight.bindings.condition,
            conditionMountPassed: true,
            providerCalls: 0,
            providerCredentialAbsent: true,
          },
          broker: { installed: false, socketAbsent: true, policyAbsent: true },
        });
      }
      return readiness(topo);
    },
    async waitProcess(handle, spec) {
      calls.push(['waitProcess', handle.role, spec]);
      if (handle.role === 'runner' && typeof driver.onContainerStarted === 'function') {
        const observe = driver.onContainerStarted;
        driver.onContainerStarted = null;
        await observe({ containerId: HASH('f'), containerBindingHash: HASH('7') });
      }
      handle.alive = false;
      return {
        exitCode: 0,
        signal: 'none',
        startedAt: '2026-08-04T16:00:02.000Z',
        endedAt: '2026-08-04T16:00:07.000Z',
        cgroupPath: topo.cgroup.path,
        outputBytes: 0,
      };
    },
    async collectEvidence(spec) {
      calls.push(['collectEvidence', spec]);
      return finalEvidence(topo);
    },
    async closeDescriptor(fd) {
      calls.push(['closeDescriptor', fd]);
      return true;
    },
    installChannelLossHandler(handler) {
      calls.push(['installChannelLossHandler']);
      channel.on('loss', handler);
      return () => channel.off('loss', handler);
    },
    async terminateProcess(handle, spec) {
      calls.push(['terminateProcess', handle?.role, spec]);
      if (handle) handle.alive = false;
      return true;
    },
    async killCgroup(spec) {
      calls.push(['killCgroup', spec]);
      for (const handle of handles.values()) {
        if (handle.spec.cgroupPath === topo.cgroup.path) handle.alive = false;
      }
      return { killed: true, populated: false, processesRemaining: 0 };
    },
    async removeRuntimeArtifacts(spec) {
      calls.push(['removeRuntimeArtifacts', spec]);
      return true;
    },
    async releaseEvidence(spec) {
      calls.push(['releaseEvidence', spec]);
      return { released: true };
    },
    async inspectShutdown() {
      calls.push(['inspectShutdown']);
      return { processesRemaining: 0, socketsRemaining: 0, cgroupPopulated: false };
    },
    now() {
      return new Date('2026-08-04T16:00:09.000Z');
    },
    ...overrides,
  };
  return driver;
}

function fakeProxyFactory(topo, driver) {
  return (options) => {
    driver.calls.push(['createDockerProxy', options]);
    driver.onContainerStarted = options.onContainerStarted;
    return {
      async start() { driver.calls.push(['proxy.start']); },
      async close() { driver.calls.push(['proxy.close']); },
      auditSnapshot() {
        driver.calls.push(['proxy.auditSnapshot']);
        return {
          complete: true,
          evidenceHash: HASH('6'),
          events: [
            { phase: 'state', action: 'container-bound', bindingHash: HASH('7') },
            { phase: 'state', action: 'container-cleaned', bindingHash: HASH('7') },
          ],
          state: {
            cleanupComplete: true,
            containerBound: false,
            containerBindingHash: null,
            createPending: false,
            execBindingCount: 0,
            execBindingHashes: [],
            leaseTerminated: true,
          },
        };
      },
    };
  };
}

async function preparedEffects({
  topo = topology(),
  driver = fakeDriver(topo),
  mutateDockerPolicy = (policy) => policy,
  executionMode = 'controlled-provider',
  readinessPreflightProducer,
} = {}) {
  const effects = createLinuxRuntimeEffects({
    topology: topo,
    driver,
    dockerProxyFactory: fakeProxyFactory(topo, driver),
    taskSecurityMaterializer(contract) {
      driver.calls.push(['materializeTrialSecurity', structuredClone(contract)]);
      const unsigned = {
        schema: 'engineer-trial-security-materialization.v1',
        trialId: contract.identity.trialId,
        runtimeRoot: contract.identity.runtimeRoot,
        contractHash: stableHash(contract),
        composeHash: contract.composeHash,
        imageDigest: topo.imageDigest,
        seedContainerIdHash: HASH('2'),
        workspaceInventoryHash: HASH('3'),
        workspaceFilesystemId: topo.filesystem.id,
        workspaceFileCount: 3,
        workspaceContentBytes: 128,
        writableRootsHash: HASH('4'),
        observedPolicy: {
          pullPolicy: 'never', platform: 'linux/amd64', networkMode: 'none',
          readOnlyRootfs: true, containerStarted: false,
        },
      };
      return { ...unsigned, receiptHash: stableHash(unsigned) };
    },
    taskContainerObserver(input) {
      driver.calls.push(['observeLiveTaskContainer', structuredClone(input)]);
      return taskObservation(topo, input);
    },
    taskReceiptPublisher(receipts) {
      driver.calls.push(['publishTaskRuntimeReceipts', structuredClone(receipts)]);
      return {
        mountPath: '/engineer-bounded/evidence/task-mount-receipt.json',
        mountHash: stableHash(receipts.mount),
        isolationPath: '/engineer-bounded/evidence/task-isolation-receipt.json',
        isolationHash: stableHash(receipts.isolation),
      };
    },
    ...(readinessPreflightProducer === undefined ? {} : { readinessPreflightProducer }),
  });
  await effects.bindControlChannel(liveControlChannel(driver.channel, executionMode));
  effects.installControlChannelLossHandler(() => {});
  await effects.inspectPlatform();
  if (executionMode === 'controlled-provider') await effects.inspectProviderKeyFd(7);
  await effects.reserveEvidenceHeadroom({ bytes: 256 * 1024 * 1024, filesystemId: topo.filesystem.id, trialId: 'trial-1' });
  const daemon = await effects.startPrivateDaemon({
    dataRoot: topo.paths.daemonDataRoot,
    expectedDaemonId: topo.daemonId,
    expectedFilesystemId: topo.filesystem.id,
    sandboxId: topo.sandboxId,
    trialId: 'trial-1',
  });
  const contract = createTrialSecurityContract({
    trialId: 'trial-1',
    immutableImage: `fixture@${topo.imageDigest}`,
    cpus: 2,
    memoryMb: 1024,
    pidsLimit: 256,
  });
  const dockerPolicy = mutateDockerPolicy({
    ...structuredClone(contract.docker),
    allowedBindSets: archivedConditionReadOnlyBindVariants('generic').map((variant) => [
      ...contract.docker.allowedBinds,
      ...variant.map((mount) => `${mount.source}:${mount.target}:ro`),
    ]),
    allowedArchivePaths: ['/app', '/tests', '/tmp'],
    execUser: null,
  });
  const proxy = await effects.startDockerProxy({
    policy: dockerPolicy,
    requestHash: HASH('1'),
    trialId: 'trial-1',
    condition: 'generic',
    executionMode,
    ...(executionMode === 'zero-provider-canary' ? {
      releaseSha: '1'.repeat(40),
      taskLockHash: HASH('6'),
      bundleHash: HASH('7'),
    } : {}),
    runnerUid: topo.identities.runnerUid,
    runnerGid: topo.identities.runnerGid,
    upstreamSocketPath: topo.paths.daemonSocket,
  });
  if (executionMode === 'zero-provider-canary') {
    const zeroReadiness = await effects.inspectReadiness({
      phase: 'zero-provider',
      requestHash: HASH('1'),
      daemon,
      proxy,
      broker: null,
      executionMode,
    });
    return { effects, driver, topo, daemon, proxy, broker: null, policy: null, zeroReadiness };
  }
  await effects.inspectReadiness({ phase: 'pre-broker', requestHash: HASH('1'), daemon, proxy, broker: {} });
  const policy = brokerPolicy();
  const broker = await effects.startProviderBroker({
    policy,
    providerKeyFd: 7,
    leaseHash: HASH('a'),
    leaseId: 'lease-trial-1',
    leaseSequence: 2,
    requestHash: HASH('1'),
    trialId: 'trial-1',
    brokerUid: topo.identities.brokerUid,
    brokerGid: topo.identities.brokerGid,
    sharedGid: topo.identities.brokerClientGid,
    budget: { trialCeilingMicrousd: 650_000, sessionCeilingMicrousd: 1_300_000 },
  });
  await effects.closeInheritedFd(7);
  await effects.inspectReadiness({ phase: 'post-broker', requestHash: HASH('1'), daemon, proxy, broker });
  return { effects, driver, topo, daemon, proxy, broker, policy };
}

test('does not classify the task-isolation-probe bind as provider credential material', async () => {
  const { driver, topo } = await preparedEffects();
  const [, proxyOptions] = driver.calls.find(([name]) => name === 'createDockerProxy');

  assert.equal(
    JSON.stringify(proxyOptions.policy).includes(topo.executables.taskIsolationProbe),
    true,
  );
});

test('zero-provider readiness is condition-scoped and produced after materialization without a broker', async () => {
  const topo = topology();
  const driver = fakeDriver(topo);
  const producer = async (bindings, { probes }) => {
    driver.calls.push(['runReadinessPreflight', structuredClone(bindings)]);
    for (const name of [
      'inspectProducer', 'probeConditionMount', 'probeProviderAbsence',
      'probeStorage', 'probeRunnerDenials', 'probeTaskIsolation',
    ]) assert.equal(typeof probes[name], 'function');
    const publication = preflightPublication(topo, bindings);
    const spec = Object.freeze({ bindings: publication.bindings });
    await probes.inspectProducer(spec);
    await probes.probeConditionMount(spec);
    await probes.probeProviderAbsence(spec);
    await probes.probeStorage(spec);
    await probes.probeRunnerDenials(spec);
    await probes.probeTaskIsolation(spec);
    return publication;
  };
  const { zeroReadiness } = await preparedEffects({
    topo,
    driver,
    executionMode: 'zero-provider-canary',
    readinessPreflightProducer: producer,
  });

  assert.deepEqual(zeroReadiness.noProviderProbe, {
    completed: true,
    imageDigest: topo.imageDigest,
    condition: 'generic',
    conditionMountPassed: true,
    providerCalls: 0,
    providerCredentialAbsent: true,
  });
  assert.deepEqual(zeroReadiness.broker, {
    installed: false,
    socketAbsent: true,
    policyAbsent: true,
  });
  assert.equal(driver.calls.some(([name]) => name === 'inspectDescriptor'), false);
  assert.equal(driver.calls.some(([name, spec]) =>
    name === 'spawnProcess' && spec.role === 'provider-broker'), false);

  const materialized = driver.calls.findIndex(([name]) => name === 'materializeTrialSecurity');
  const proxyStarted = driver.calls.findIndex(([name]) => name === 'proxy.start');
  const preflight = driver.calls.findIndex(([name]) => name === 'runReadinessPreflight');
  const readinessProbe = driver.calls.findIndex(([name]) => name === 'runReadinessProbe');
  assert.ok(materialized >= 0 && materialized < proxyStarted);
  assert.ok(proxyStarted < preflight && preflight < readinessProbe);
  assert.equal(driver.calls.some(([name]) => name === 'runTaskIsolationCanary'), true);
  assert.equal(driver.calls.some(([name]) => name === 'runReadinessDenialProbe'), true);
  assert.equal(driver.calls.some(([name]) => name === 'runStorageReadinessCanary'), true);

  const [, probeSpec] = driver.calls.find(([name]) => name === 'runReadinessProbe');
  const handoff = validateRuntimeProbeHandoff(probeSpec.handoff);
  assert.equal(handoff.phase, 'zero-provider');
  assert.equal(handoff.brokerInstalled, false);
  assert.equal(handoff.readinessPreflight.bindings.executionMode, 'zero-provider-canary');
  assert.equal(handoff.readinessPreflight.bindings.condition, 'generic');
});

test('zero-provider Linux lifecycle launches, observes, evidences, and shuts down without broker capability', async () => {
  const topo = topology();
  let evidenceSpec;
  const driver = fakeDriver(topo, { async collectEvidence(spec) {
    evidenceSpec = spec;
    return finalEvidence(topo, {
      provider: {
        mode: 'not-exercised',
        requestHash: spec.handoff.requestHash,
        leaseHash: spec.handoff.leaseHash,
        usageHash: HASH('c'),
        identityHash: HASH('d'),
        spendMicrousd: 0,
        billingCertain: true,
        budgetComplete: true,
        withinTrialCeiling: true,
        attempts: 0,
        calls: 0,
        brokerAbsent: true,
      },
    });
  } });
  const prepared = await preparedEffects({
    topo,
    driver,
    executionMode: 'zero-provider-canary',
    readinessPreflightProducer: async (bindings) => preflightPublication(topo, bindings),
  });
  const { effects, daemon, proxy } = prepared;
  const leaseHash = HASH('a');
  const launchInput = {
    executionMode: 'zero-provider-canary',
    uid: topo.identities.runnerUid,
    gid: topo.identities.runnerGid,
    supplementaryGids: [],
    argv: [topo.executables.runner, '--mode', 'canary'],
    cwd: topo.paths.workspace,
    env: {
      LANG: 'C.UTF-8',
      DOCKER_HOST: `unix://${topo.paths.proxySocket}`,
      ENGINEER_RUNTIME_EXECUTION_MODE: 'zero-provider-canary',
      ENGINEER_RUNTIME_LEASE_HASH: leaseHash,
    },
    inheritedFds: [],
    timeoutMs: 30_000,
    requestHash: HASH('1'),
    leaseHash,
  };
  const result = await effects.launchRunner(launchInput);
  assert.equal(result.exitCode, 0);
  const runnerSpawn = driver.calls.find(([name, spec]) => name === 'spawnProcess' && spec.role === 'runner')[1];
  assert.deepEqual(runnerSpawn.supplementaryGids, []);
  assert.equal(Object.keys(runnerSpawn.env).some((name) => name.startsWith('ENGINEER_PROVIDER_')), false);

  const evidence = await effects.collectFinalEvidence({
    executionMode: 'zero-provider-canary',
    requestHash: HASH('1'),
    leaseHash,
    runnerResult: result,
    daemon,
    proxy,
    broker: null,
  });
  assert.equal(evidence.provider.mode, 'not-exercised');
  assert.equal(evidence.provider.spendMicrousd, 0);
  const handoff = validateRuntimeEvidenceHandoff(
    evidenceSpec.handoff,
  );
  assert.equal(handoff.executionMode, 'zero-provider-canary');
  assert.equal(handoff.broker, null);

  const shutdown = await effects.shutdown({ reason: 'finalize', failClosed: false });
  assert.equal(shutdown.completed, true);
});

test('implements the exact privileged effect contract without exposing a provider credential', async () => {
  const { effects, driver, topo, daemon, proxy, broker, policy } = await preparedEffects();

  assert.equal(daemon.socketPath, topo.paths.daemonSocket);
  assert.equal(proxy.nonBypassable, true);
  assert.equal(broker.policyHash, providerBrokerStaticPolicyHash(policy));
  assert.equal(broker.leaseDigest, HASH('a'));

  const materializationIndex = driver.calls.findIndex(([name]) => name === 'materializeTrialSecurity');
  const proxyStartIndex = driver.calls.findIndex(([name]) => name === 'proxy.start');
  assert.ok(materializationIndex >= 0 && materializationIndex < proxyStartIndex);
  assert.equal(driver.calls[materializationIndex][1].identity.trialId, 'trial-1');

  const readinessCalls = driver.calls.filter(([name]) => name === 'runReadinessProbe');
  assert.equal(readinessCalls.length, 2);
  for (const [index, [, spec]] of readinessCalls.entries()) {
    const handoff = validateRuntimeProbeHandoff(spec.handoff);
    assert.equal(handoff.phase, index === 0 ? 'pre-broker' : 'post-broker');
    assert.equal(handoff.brokerInstalled, index === 1);
    assert.equal(handoff.requestHash, HASH('1'));
    assert.equal(handoff.topology.imageDigest, topo.imageDigest);
    assert.equal(handoff.topology.filesystemId, topo.filesystem.id);
    assert.equal(handoff.topology.cgroupPathHash, topo.cgroup.pathHash);
    assert.equal(handoff.resources.evidenceReserveBytes, 256 * 1024 * 1024);
    assert.equal(handoff.paths.evidenceReserve, topo.paths.evidenceReserve);
    assert.equal(handoff.networkPolicy.producerExecutableHash, topo.hashes.supervisor);
    assert.equal(handoff.networkPolicy.sandboxBootId, topo.sandboxBootId);
    assert.equal(handoff.networkPolicy.requestHash, HASH('1'));
    assert.equal(handoff.networkPolicy.trialId, 'trial-1');
    assert.match(handoff.networkPolicy.producerSessionId, /^[a-f0-9]{64}$/);
  }
  assert.equal(
    readinessCalls[0][1].handoff.networkPolicy.producerSessionId,
    readinessCalls[1][1].handoff.networkPolicy.producerSessionId,
  );

  const daemonSpawn = driver.calls.find(([name, spec]) => name === 'spawnProcess' && spec.role === 'private-daemon')[1];
  assert.equal(daemonSpawn.file, topo.executables.dockerd);
  assert.deepEqual(daemonSpawn.args, [
    '--host', `unix://${topo.paths.daemonSocket}`,
    '--data-root', topo.paths.daemonDataRoot,
    '--exec-root', topo.paths.daemonExecRoot,
    '--pidfile', topo.paths.daemonPidFile,
    '--bridge', 'none',
    '--iptables=false',
    '--ip-forward=false',
    '--ip-masq=false',
    '--userland-proxy=false',
    '--log-level', 'error',
  ]);
  assert.deepEqual(daemonSpawn.env, { LANG: 'C.UTF-8', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' });

  const networkPolicy = driver.calls.find(([name]) => name === 'installNetworkPolicy')[1];
  assert.deepEqual(networkPolicy, {
    runnerUid: 2001,
    brokerUid: 2002,
    iptables: topo.executables.iptables,
    ip6tables: topo.executables.ip6tables,
    providerHostname: 'openrouter.ai',
    providerHttpsPort: 443,
    metadataCidrs: ['169.254.0.0/16', '100.100.100.200/32', 'fe80::/10', 'fd00:ec2::254/128'],
  });

  const brokerSpawn = driver.calls.find(([name, spec]) => name === 'spawnProcess' && spec.role === 'provider-broker')[1];
  assert.equal(brokerSpawn.file, topo.executables.providerBroker);
  assert.deepEqual(brokerSpawn.args, [
    '--socket', topo.paths.brokerSocket,
    '--policy', topo.paths.brokerPolicy,
    '--key-fd', '3',
    '--client-gid', '2003',
  ]);
  assert.deepEqual(brokerSpawn.inheritedFds, [{ source: 7, target: 3 }]);
  assert.equal(JSON.stringify(brokerSpawn).includes('sk-or'), false);

  const result = await effects.launchRunner({
    executionMode: 'controlled-provider',
    uid: 2001,
    gid: 2001,
    supplementaryGids: [2003],
    argv: [topo.executables.runner, '--mode', 'controlled'],
    cwd: topo.paths.workspace,
    env: {
      LANG: 'C.UTF-8',
      DOCKER_HOST: `unix://${topo.paths.proxySocket}`,
      ENGINEER_PROVIDER_BROKER_SOCKET: topo.paths.brokerSocket,
      ENGINEER_PROVIDER_LEASE_ID: 'lease-trial-1',
      ENGINEER_PROVIDER_TRIAL_ID: 'trial-1',
      ENGINEER_PROVIDER_LEASE_DIGEST: HASH('a'),
      ENGINEER_PROVIDER_LEASE_SEQUENCE: '2',
      ENGINEER_RUNTIME_LEASE_HASH: HASH('a'),
    },
    inheritedFds: [],
    timeoutMs: 30_000,
    requestHash: HASH('1'),
    leaseHash: HASH('a'),
  });
  assert.equal(result.exitCode, 0);
  const runnerSpawn = driver.calls.find(([name, spec]) => name === 'spawnProcess' && spec.role === 'runner')[1];
  assert.equal(runnerSpawn.file, topo.executables.runner);
  assert.equal(runnerSpawn.cgroupPath, topo.cgroup.path);
  assert.deepEqual(runnerSpawn.inheritedFds, []);

  const evidence = await effects.collectFinalEvidence({
    executionMode: 'controlled-provider',
    requestHash: HASH('1'),
    leaseHash: HASH('a'),
    runnerResult: result,
    daemon,
    proxy,
    broker,
  });
  assert.equal(evidence.docker.eventsComplete, true);
  const sentinelStop = driver.calls.findIndex(([name, role]) => name === 'terminateProcess' && role === 'cgroup-sentinel');
  const evidenceIndex = driver.calls.findIndex(([name]) => name === 'collectEvidence');
  assert.ok(sentinelStop >= 0, 'final evidence stops and awaits the cgroup sentinel');
  assert.ok(sentinelStop < evidenceIndex, 'the sentinel is gone before kernel inventories are collected');
  const evidenceCall = driver.calls.find(([name]) => name === 'collectEvidence');
  const evidenceHandoff = validateRuntimeEvidenceHandoff(evidenceCall[1].handoff);
  assert.deepEqual(evidenceHandoff.runnerResult, result);
  assert.deepEqual(evidenceHandoff.topology, {
    imageDigest: topo.imageDigest,
    filesystemId: topo.filesystem.id,
    cgroupId: topo.cgroup.id,
    cgroupPathHash: topo.cgroup.pathHash,
    harborExecutableHash: topo.hashes.harbor,
    cpuMax: topo.cgroup.cpuMax,
    memoryMax: topo.cgroup.memoryMax,
    pidsMax: topo.cgroup.pidsMax,
  });
  assert.deepEqual(evidenceHandoff.proxy, {
    eventsHash: HASH('6'),
    eventsComplete: true,
    containerIdHash: HASH('7'),
    imageDigest: topo.imageDigest,
    policyCompliant: true,
  });
  assert.equal(evidenceHandoff.networkPolicy.iptablesExecutableHash, topo.hashes.iptables);
  assert.equal(evidenceHandoff.networkPolicy.ip6tablesExecutableHash, topo.hashes.ip6tables);
  assert.deepEqual(evidenceHandoff.networkPolicy.providerAddresses, {
    ipv4: ['104.18.2.10'], ipv6: [],
  });
  assert.equal(
    evidenceHandoff.networkPolicy.producerSessionId,
    readinessCalls[0][1].handoff.networkPolicy.producerSessionId,
  );
  assert.deepEqual(evidenceHandoff.broker, {
    leaseId: broker.leaseId,
    leaseDigest: broker.leaseDigest,
    leaseSequence: broker.leaseSequence,
    trialId: broker.trialId,
    policyHash: broker.policyHash,
    bindingPolicyHash: broker.bindingPolicyHash,
  });
  const shutdown = await effects.shutdown({ reason: 'finalize', failClosed: false });
  assert.deepEqual(shutdown, {
    completed: true,
    processesRemaining: 0,
    socketsRemaining: 0,
    evidenceHeadroomReleased: true,
    endedAt: '2026-08-04T16:00:09.000Z',
  });
});

test('production-shaped effects adopt the PID-1 private daemon instead of starting a second daemon', async () => {
  const topo = topology();
  const driver = fakeDriver(topo, {
    async adoptPrivateDaemon(spec) {
      driver.calls.push(['adoptPrivateDaemon', spec]);
      const adoptedHandle = { adopted: true, id: 'adopted-daemon' };
      return {
        handle: adoptedHandle,
        daemonId: topo.daemonId,
        sandboxBootId: topo.sandboxBootId,
        filesystemId: topo.filesystem.id,
        defaultDockerRootId: topo.filesystem.defaultDockerRootId,
        dataRoot: topo.paths.daemonDataRoot,
        socketPath: topo.paths.daemonSocket,
        socketOwnerUid: 0,
        socketOwnerGid: 0,
        socketMode: 0o600,
        exclusive: true,
      };
    },
  });

  const { effects } = await preparedEffects({ topo, driver });
  assert.equal(driver.calls.filter(([name]) => name === 'adoptPrivateDaemon').length, 1);
  assert.equal(driver.calls.some(([name, spec]) =>
    name === 'spawnProcess' && spec.role === 'private-daemon'), false);

  await effects.shutdown({ reason: 'test-complete', failClosed: false });
  assert.equal(driver.calls.some(([name, role]) =>
    name === 'terminateProcess' && role === undefined), true);
});

test('pins one immutable trial, request, and producer session across the runtime lifecycle', async (t) => {
  await t.test('rejects trial drift before installing runtime controls', async () => {
    const topo = topology();
    const driver = fakeDriver(topo);
    const effects = createLinuxRuntimeEffects({
      topology: topo,
      driver,
      dockerProxyFactory: fakeProxyFactory(topo, driver),
    });
    await effects.bindControlChannel(liveControlChannel(driver.channel));
    await effects.inspectPlatform();
    await effects.reserveEvidenceHeadroom({
      bytes: 256 * 1024 * 1024,
      filesystemId: topo.filesystem.id,
      trialId: 'trial-1',
    });
    await assert.rejects(effects.startPrivateDaemon({
      dataRoot: topo.paths.daemonDataRoot,
      expectedDaemonId: topo.daemonId,
      expectedFilesystemId: topo.filesystem.id,
      sandboxId: topo.sandboxId,
      trialId: 'trial-2',
    }), (error) => {
      assert.equal(error.code, 'ERR_LINUX_RUNTIME_LIFECYCLE');
      return true;
    });
    assert.equal(driver.calls.some(([name]) => name === 'installNetworkPolicy'), false);
  });

  await t.test('rejects cross-request final-evidence rebinding before collection', async () => {
    const { effects, driver, topo, daemon, proxy, broker } = await preparedEffects();
    const result = await effects.launchRunner({
      executionMode: 'controlled-provider',
      uid: 2001,
      gid: 2001,
      supplementaryGids: [2003],
      argv: [topo.executables.runner, '--mode', 'controlled'],
      cwd: topo.paths.workspace,
      env: {
        LANG: 'C.UTF-8',
        DOCKER_HOST: `unix://${topo.paths.proxySocket}`,
        ENGINEER_PROVIDER_BROKER_SOCKET: topo.paths.brokerSocket,
        ENGINEER_PROVIDER_LEASE_ID: 'lease-trial-1',
        ENGINEER_PROVIDER_TRIAL_ID: 'trial-1',
        ENGINEER_PROVIDER_LEASE_DIGEST: HASH('a'),
        ENGINEER_PROVIDER_LEASE_SEQUENCE: '2',
        ENGINEER_RUNTIME_LEASE_HASH: HASH('a'),
      },
      inheritedFds: [],
      timeoutMs: 30_000,
      requestHash: HASH('1'),
      leaseHash: HASH('a'),
    });
    await assert.rejects(effects.collectFinalEvidence({
      executionMode: 'controlled-provider',
      requestHash: HASH('9'),
      leaseHash: HASH('a'),
      runnerResult: result,
      daemon,
      proxy,
      broker,
    }), (error) => {
      assert.equal(error.code, 'ERR_LINUX_RUNTIME_LIFECYCLE');
      return true;
    });
    assert.equal(driver.calls.some(([name]) => name === 'collectEvidence'), false);
  });
});

test('fail-stop drains a suspended runner transition before proving shutdown', async () => {
  const topo = topology();
  const driver = fakeDriver(topo);
  const originalTerminate = driver.terminateProcess;
  let releaseRunnerStart;
  let runnerStartBlocked;
  const blocked = new Promise((resolve) => { runnerStartBlocked = resolve; });
  const release = new Promise((resolve) => { releaseRunnerStart = resolve; });
  driver.terminateProcess = async (handle, spec) => {
    if (handle?.role === 'cgroup-sentinel' && spec.reason === 'runner-start') {
      driver.calls.push(['terminateProcess', handle.role, spec]);
      runnerStartBlocked();
      await release;
      handle.alive = false;
      return true;
    }
    return originalTerminate(handle, spec);
  };
  const { effects } = await preparedEffects({ topo, driver });
  const launch = effects.launchRunner({
    executionMode: 'controlled-provider',
    uid: 2001,
    gid: 2001,
    supplementaryGids: [2003],
    argv: [topo.executables.runner, '--mode', 'controlled'],
    cwd: topo.paths.workspace,
    env: {
      LANG: 'C.UTF-8',
      DOCKER_HOST: `unix://${topo.paths.proxySocket}`,
      ENGINEER_PROVIDER_BROKER_SOCKET: topo.paths.brokerSocket,
      ENGINEER_PROVIDER_LEASE_ID: 'lease-trial-1',
      ENGINEER_PROVIDER_TRIAL_ID: 'trial-1',
      ENGINEER_PROVIDER_LEASE_DIGEST: HASH('a'),
      ENGINEER_PROVIDER_LEASE_SEQUENCE: '2',
      ENGINEER_RUNTIME_LEASE_HASH: HASH('a'),
    },
    inheritedFds: [],
    timeoutMs: 30_000,
    requestHash: HASH('1'),
    leaseHash: HASH('a'),
  });
  await blocked;
  const shutdown = effects.shutdown({ reason: 'controller-channel-closed', failClosed: true });
  releaseRunnerStart();
  await assert.rejects(launch, (error) => {
    assert.equal(error.code, 'ERR_LINUX_RUNTIME_LIFECYCLE');
    return true;
  });
  assert.equal((await shutdown).completed, true);
  assert.equal(driver.calls.some(([name, spec]) => name === 'spawnProcess' && spec?.role === 'runner'), false);
});

test('rejects statfs, default-root, descriptor, and executable identity drift before paid capability', async (t) => {
  const harborDrift = topology({ executables: { harbor: '/opt/harbor/bin/harbor' } });
  assert.throws(() => createLinuxRuntimeEffects({
    topology: harborDrift,
    driver: fakeDriver(harborDrift),
  }), /Harbor executable|fixed runtime/i);
  for (const topo of [
    topology({ executables: { taskIsolationProbe: undefined } }),
    topology({ hashes: { taskIsolationProbe: undefined } }),
  ]) {
    assert.throws(() => createLinuxRuntimeEffects({ topology: topo, driver: fakeDriver(topo) }),
      /taskIsolationProbe|absolute path|SHA-256/i);
  }

  const cases = [
    ['bounded filesystem size', {
      inspectHost: async () => ({
        ...(await fakeDriver().inspectHost()),
        filesystem: { ...(await fakeDriver().inspectHost()).filesystem, boundedRootBytes: TEN_GIB - 1 },
      }),
    }],
    ['default Docker root alias', {
      inspectHost: async () => ({
        ...(await fakeDriver().inspectHost()),
        filesystem: { ...(await fakeDriver().inspectHost()).filesystem, defaultDockerRootId: 'bounded-fs' },
      }),
    }],
    ['regular-file key descriptor', { inspectDescriptor: async () => ({ kind: 'file', open: true }) }],
    ['broker executable hash', { hashExecutable: async (file) => file.endsWith('engineer-provider-broker') ? HASH('9') : null }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const topo = topology();
      const base = fakeDriver(topo);
      const driver = { ...base, ...overrides };
      const effects = createLinuxRuntimeEffects({ topology: topo, driver, dockerProxyFactory: fakeProxyFactory(topo, driver) });
      await effects.bindControlChannel(liveControlChannel(driver.channel));
      effects.installControlChannelLossHandler(() => {});
      if (name.includes('descriptor')) {
        await effects.inspectPlatform();
        await assert.rejects(effects.inspectProviderKeyFd(7), LinuxRuntimeEffectsError);
      } else if (name.includes('executable')) {
        await assert.rejects(effects.inspectPlatform(), LinuxRuntimeEffectsError);
      } else {
        await assert.rejects(effects.inspectPlatform(), LinuxRuntimeEffectsError);
      }
      assert.equal(driver.calls.some(([called]) => called === 'spawnProcess'), false);
    });
  }
});

test('rejects widening condition bind alternatives or archive paths beyond the code-owned policy', async (t) => {
  await t.test('bind alternatives', async () => {
    await assert.rejects(preparedEffects({
      mutateDockerPolicy: (policy) => ({
        ...policy,
        allowedBindSets: policy.allowedBindSets.map((set, index) => index === 0
          ? [...set, '/engineer-bounded/work/extra:/root:ro']
          : set),
      }),
    }), /Docker proxy policy drifted/i);
  });
  await t.test('archive paths', async () => {
    await assert.rejects(preparedEffects({
      mutateDockerPolicy: (policy) => ({
        ...policy,
        allowedArchivePaths: [...policy.allowedArchivePaths, '/root'],
      }),
    }), /Docker proxy policy drifted/i);
  });
});

test('rejects exact daemon, proxy, broker socket and command drift', async (t) => {
  const cases = [
    ['daemon socket mode', topology().paths.daemonSocket, { mode: 0o660 }],
    ['proxy socket group', topology().paths.proxySocket, { groupGid: 2003 }],
    ['broker socket owner', topology().paths.brokerSocket, { ownerUid: 0 }],
  ];
  for (const [name, target, drift] of cases) {
    await t.test(name, async () => {
      const topo = topology();
      const base = fakeDriver(topo);
      const original = base.inspectSocket;
      base.inspectSocket = async (path) => ({ ...(await original(path)), ...(path === target ? drift : {}) });
      await assert.rejects(preparedEffects({ topo, driver: base }), LinuxRuntimeEffectsError);
      assert.equal(base.calls.some(([called, spec]) => called === 'spawnProcess' && spec?.shell === true), false);
    });
  }

  await t.test('driver reports argv drift', async () => {
    const topo = topology();
    const base = fakeDriver(topo);
    const original = base.spawnProcess;
    base.spawnProcess = async (spec) => {
      if (spec.role === 'private-daemon') {
        assert.deepEqual(spec.args.slice(0, 2), ['--host', `unix://${topo.paths.daemonSocket}`]);
        throw new Error('production launcher rejected argv drift');
      }
      return original(spec);
    };
    await assert.rejects(preparedEffects({ topo, driver: base }), LinuxRuntimeEffectsError);
  });
});

test('re-observes post-broker controls and rejects readiness drift', async () => {
  const topo = topology();
  const driver = fakeDriver(topo);
  let probes = 0;
  driver.runReadinessProbe = async (spec) => {
    driver.calls.push(['runReadinessProbe', spec]);
    probes += 1;
    const value = readiness(topo);
    if (probes === 2) value.storageProbe.evidenceHeadroomRecovered = false;
    return value;
  };
  await assert.rejects(preparedEffects({ topo, driver }), LinuxRuntimeEffectsError);
  assert.equal(probes, 2);
});

test('rejects runner cgroup escape, launch timeout, and secret propagation', async (t) => {
  await t.test('cgroup escape', async () => {
    const topo = topology();
    const driver = fakeDriver(topo, {
      async waitProcess(handle, spec) {
        driver.calls.push(['waitProcess', handle.role, spec]);
        return {
          exitCode: 0,
          signal: 'none',
          startedAt: '2026-08-04T16:00:02.000Z',
          endedAt: '2026-08-04T16:00:07.000Z',
          cgroupPath: '/sys/fs/cgroup/escaped',
          outputBytes: 0,
        };
      },
    });
    const { effects } = await preparedEffects({ topo, driver });
    await assert.rejects(effects.launchRunner({
      executionMode: 'controlled-provider',
      uid: 2001, gid: 2001, supplementaryGids: [2003],
      argv: [topo.executables.runner], cwd: topo.paths.workspace,
      env: {
        DOCKER_HOST: `unix://${topo.paths.proxySocket}`,
        ENGINEER_PROVIDER_BROKER_SOCKET: topo.paths.brokerSocket,
        ENGINEER_PROVIDER_LEASE_ID: 'lease-trial-1',
        ENGINEER_PROVIDER_TRIAL_ID: 'trial-1',
        ENGINEER_PROVIDER_LEASE_DIGEST: HASH('a'),
        ENGINEER_PROVIDER_LEASE_SEQUENCE: '2',
        ENGINEER_RUNTIME_LEASE_HASH: HASH('a'),
      }, inheritedFds: [], timeoutMs: 30_000, requestHash: HASH('1'), leaseHash: HASH('a'),
    }), LinuxRuntimeEffectsError);
    assert.equal(driver.calls.some(([name]) => name === 'killCgroup'), true);
  });

  await t.test('timeout kills custody cgroup', async () => {
    const topo = topology();
    const driver = fakeDriver(topo, {
      async waitProcess() { const error = new Error('timed out'); error.code = 'ETIMEDOUT'; throw error; },
    });
    const { effects } = await preparedEffects({ topo, driver });
    await assert.rejects(effects.launchRunner({
      executionMode: 'controlled-provider',
      uid: 2001, gid: 2001, supplementaryGids: [2003], argv: [topo.executables.runner],
      cwd: topo.paths.workspace,
      env: {
        DOCKER_HOST: `unix://${topo.paths.proxySocket}`,
        ENGINEER_PROVIDER_BROKER_SOCKET: topo.paths.brokerSocket,
        ENGINEER_PROVIDER_LEASE_ID: 'lease-trial-1',
        ENGINEER_PROVIDER_TRIAL_ID: 'trial-1',
        ENGINEER_PROVIDER_LEASE_DIGEST: HASH('a'),
        ENGINEER_PROVIDER_LEASE_SEQUENCE: '2',
        ENGINEER_RUNTIME_LEASE_HASH: HASH('a'),
      }, inheritedFds: [], timeoutMs: 1_000, requestHash: HASH('1'), leaseHash: HASH('a'),
    }), LinuxRuntimeEffectsError);
    assert.equal(driver.calls.some(([name]) => name === 'killCgroup'), true);
  });

  await t.test('credential-like runner value never reaches a child', async () => {
    const { effects, driver, topo } = await preparedEffects();
    await assert.rejects(effects.launchRunner({
      executionMode: 'controlled-provider',
      uid: 2001, gid: 2001, supplementaryGids: [2003], argv: [topo.executables.runner],
      cwd: topo.paths.workspace,
      env: {
        DOCKER_HOST: `unix://${topo.paths.proxySocket}`,
        ENGINEER_PROVIDER_BROKER_SOCKET: topo.paths.brokerSocket,
        ENGINEER_PROVIDER_LEASE_ID: 'lease-trial-1',
        ENGINEER_PROVIDER_TRIAL_ID: 'trial-1',
        ENGINEER_PROVIDER_LEASE_DIGEST: HASH('a'),
        ENGINEER_PROVIDER_LEASE_SEQUENCE: '2',
        ENGINEER_RUNTIME_LEASE_HASH: HASH('a'),
        OPENROUTER_API_KEY: 'sk-or-v1-must-never-cross',
      }, inheritedFds: [], timeoutMs: 30_000, requestHash: HASH('1'), leaseHash: HASH('a'),
    }), LinuxRuntimeEffectsError);
    assert.equal(JSON.stringify(driver.calls).includes('sk-or-v1-must-never-cross'), false);
  });
});

test('rejects incomplete events and inventories, then removes orphans during fail-stop shutdown', async (t) => {
  const cases = [
    ['event stream', { docker: { ...finalEvidence().docker, eventsComplete: false } }],
    ['container inventory', { docker: { ...finalEvidence().docker, containersRemaining: 1 } }],
    ['cgroup population', { cgroup: { ...finalEvidence().cgroup, populated: true, processesRemaining: 1 } }],
    ['mount inventory', { mounts: { ...finalEvidence().mounts, outsideAllowedWrites: true } }],
  ];
  for (const [name, drift] of cases) {
    await t.test(name, async () => {
      const topo = topology();
      const driver = fakeDriver(topo, { async collectEvidence() { return finalEvidence(topo, drift); } });
      const { effects, daemon, proxy, broker } = await preparedEffects({ topo, driver });
      await assert.rejects(effects.collectFinalEvidence({
        executionMode: 'controlled-provider',
        requestHash: HASH('1'), leaseHash: HASH('a'),
        runnerResult: { exitCode: 0, signal: 'none', startedAt: '2026-08-04T16:00:02.000Z', endedAt: '2026-08-04T16:00:07.000Z' },
        daemon, proxy, broker,
      }), LinuxRuntimeEffectsError);
    });
  }

  await t.test('shutdown refuses an orphan after attempting every cleanup', async () => {
    const topo = topology();
    const driver = fakeDriver(topo, {
      async inspectShutdown() { return { processesRemaining: 1, socketsRemaining: 0, cgroupPopulated: false }; },
    });
    const { effects } = await preparedEffects({ topo, driver });
    await assert.rejects(effects.shutdown({ reason: 'runtime-fail-stop', failClosed: true }), LinuxRuntimeEffectsError);
    assert.equal(driver.calls.some(([name]) => name === 'killCgroup'), true);
    assert.equal(driver.calls.some(([name]) => name === 'removeRuntimeArtifacts'), true);
    assert.equal(driver.calls.some(([name]) => name === 'releaseEvidence'), true);
  });
});

test('control-channel loss is synchronous and triggers the supervisor fail-stop callback', async () => {
  const topo = topology();
  const driver = fakeDriver(topo);
  const effects = createLinuxRuntimeEffects({ topology: topo, driver, dockerProxyFactory: fakeProxyFactory(topo, driver) });
  await effects.bindControlChannel(liveControlChannel(driver.channel));
  let reason;
  const detach = effects.installControlChannelLossHandler((value) => { reason = value; });
  driver.channel.emit('loss', 'controller-channel-closed');
  assert.equal(reason, 'controller-channel-closed');
  detach();
});

test('production network plan is broker-only and default-deny for IPv4 and IPv6', () => {
  const commands = planLinuxNetworkPolicy({
    iptables: '/usr/sbin/iptables',
    ip6tables: '/usr/sbin/ip6tables',
    brokerUid: 2002,
    runnerUid: 2001,
    providerHostname: 'openrouter.ai',
    providerHttpsPort: 443,
    providerAddresses: {
      ipv4: ['104.18.2.10', '104.18.3.10'],
      ipv6: ['2606:4700::6812:20a'],
    },
    dnsServers: [
      { address: '10.0.0.2', family: 4, port: 53 },
      { address: '2001:4860:4860::8888', family: 6, port: 53 },
    ],
    metadataCidrs: [
      '169.254.0.0/16',
      '100.100.100.200/32',
      'fe80::/10',
      'fd00:ec2::254/128',
    ],
  });

  for (const [binary, chain, providerAddresses, dnsAddress] of [
    ['/usr/sbin/iptables', 'ENGINEER_EGRESS_V4', ['104.18.2.10', '104.18.3.10'], '10.0.0.2'],
    ['/usr/sbin/ip6tables', 'ENGINEER_EGRESS_V6', ['2606:4700::6812:20a'], '2001:4860:4860::8888'],
  ]) {
    const providerAddress = providerAddresses[0];
    const family = commands.filter((command) => command.file === binary);
    assert.deepEqual(family[0].args, ['--wait', '5', '--new-chain', chain]);
    assert.deepEqual(family.at(-1).args, ['--wait', '5', '--insert', 'OUTPUT', '1', '--jump', chain]);

    const metadataIndex = family.findIndex(({ args }) => args.includes('169.254.0.0/16') || args.includes('fe80::/10'));
    const loopbackIndex = family.findIndex(({ args }) => args.includes('--out-interface') && args.includes('lo'));
    const establishedIndex = family.findIndex(({ args }) => args.includes('--ctstate') && args.includes('ESTABLISHED'));
    assert.ok(metadataIndex > 0 && metadataIndex < loopbackIndex);
    assert.ok(loopbackIndex < establishedIndex, 'loopback and existing controller traffic remain available');

    const provider = family.find(({ args }) => args.includes(providerAddress));
    assert.ok(provider);
    assert.ok(provider.args.includes('--uid-owner') && provider.args.includes('2002'));
    assert.ok(provider.args.includes('--protocol') && provider.args.includes('tcp'));
    assert.ok(provider.args.includes('--dport') && provider.args.includes('443'));
    assert.ok(provider.args.includes('--ctstate') && provider.args.includes('NEW'));
    assert.equal(provider.args.at(-1), 'ACCEPT');

    const dns = family.filter(({ args }) => args.includes(dnsAddress));
    assert.equal(dns.length, 2, 'configured DNS is limited to TCP and UDP');
    assert.ok(dns.every(({ args }) => args.includes('--uid-owner') && args.includes('2002')));
    assert.ok(dns.every(({ args }) => args.includes('--dport') && args.includes('53')));

    const brokerReject = family.find(({ args }) => args.includes('--uid-owner') && args.includes('2002') && args.at(-1) === 'REJECT');
    assert.ok(brokerReject, 'broker cannot reach a non-provider or non-DNS destination');
    assert.deepEqual(family.at(-2).args, ['--wait', '5', '--append', chain, '--jump', 'REJECT']);
    assert.equal(family.some(({ args }) => args.at(-1) === 'ACCEPT' && (args.includes('0.0.0.0/0') || args.includes('::/0'))), false);
    assert.equal(family.some(({ args }) => args.includes('RELATED')), false, 'related flows cannot open a side channel');
    for (const { args } of family.filter(({ args }) => args.at(-1) === 'ACCEPT')) {
      const isLoopback = args.includes('--out-interface') && args.includes('lo');
      const isEstablished = args.includes('--ctstate') && args.includes('ESTABLISHED');
      const isExactBrokerDestination = args.includes('--uid-owner') && args.includes('2002')
        && args.includes('--destination') && ([...providerAddresses, dnsAddress].some((address) => args.includes(address)));
      assert.equal(isLoopback || isEstablished || isExactBrokerDestination, true);
    }
  }
});

test('production network plan fails closed on unresolved, non-global, or mutable provider destinations', () => {
  const base = {
    iptables: '/usr/sbin/iptables',
    ip6tables: '/usr/sbin/ip6tables',
    brokerUid: 2002,
    runnerUid: 2001,
    providerHostname: 'openrouter.ai',
    providerHttpsPort: 443,
    providerAddresses: { ipv4: ['104.18.2.10'], ipv6: [] },
    dnsServers: [{ address: '10.0.0.2', family: 4, port: 53 }],
    metadataCidrs: ['169.254.0.0/16', '100.100.100.200/32', 'fe80::/10', 'fd00:ec2::254/128'],
  };
  for (const drift of [
    { providerHostname: 'example.com' },
    { providerHttpsPort: 8443 },
    { providerAddresses: { ipv4: [], ipv6: [] } },
    { providerAddresses: { ipv4: ['127.0.0.1'], ipv6: [] } },
    { providerAddresses: { ipv4: [], ipv6: ['fe80::1'] } },
    { providerAddresses: { ipv4: Array(17).fill('104.18.2.10'), ipv6: [] } },
    { dnsServers: [{ address: '169.254.169.254', family: 4, port: 53 }] },
    { dnsServers: [{ address: '10.0.0.2', family: 4, port: 5353 }] },
    { dnsServers: Array(9).fill({ address: '10.0.0.2', family: 4, port: 53 }) },
  ]) {
    assert.throws(() => planLinuxNetworkPolicy({ ...base, ...drift }), LinuxRuntimeEffectsError);
  }
});

test('default Linux driver transfers each canonical helper handoff through one inherited FD 3 pipe', async () => {
  const topo = topology();
  const driver = createNodeLinuxDriver(topo);
  const supportEnv = { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' };
  const helper = async (kind, handoff, moduleName, exportedReader) => {
    const moduleUrl = new URL(`../../../evals/runtime/${moduleName}`, import.meta.url).href;
    const script = [
      `const m=await import(${JSON.stringify(moduleUrl)});`,
      `const value=m.${exportedReader}();`,
      'process.stdout.write(JSON.stringify({schema:value.schema,handoffHash:value.handoffHash}));',
    ].join('');
    const spec = {
      file: process.execPath,
      args: ['--input-type=module', '--eval', script],
      env: supportEnv,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      handoff,
      shell: false,
    };
    return kind === 'probe'
      ? driver.runReadinessProbe(spec)
      : driver.collectEvidence(spec);
  };

  const probe = createRuntimeProbeHandoff({
    requestHash: HASH('1'),
    phase: 'post-broker',
    observedAt: '2026-08-04T16:00:01.000Z',
    brokerInstalled: true,
    topology: {
      imageDigest: topo.imageDigest,
      filesystemId: topo.filesystem.id,
      filesystemBytes: TEN_GIB,
      cgroupId: topo.cgroup.id,
      cgroupPathHash: topo.cgroup.pathHash,
      runnerUid: 2001,
      brokerUid: 2002,
      runnerExecutableHash: topo.hashes.runner,
      harborExecutableHash: topo.hashes.harbor,
    },
    paths: {
      sandboxRoot: topo.filesystem.boundedRoot,
      daemonSocket: topo.paths.daemonSocket,
      proxySocket: topo.paths.proxySocket,
      brokerSocket: topo.paths.brokerSocket,
      cgroup: topo.cgroup.path,
      evidenceReserve: topo.paths.evidenceReserve,
    },
    resources: {
      evidenceReserveBytes: 256 * 1024 * 1024,
      cpuMax: topo.cgroup.cpuMax,
      memoryMax: topo.cgroup.memoryMax,
      pidsMax: topo.cgroup.pidsMax,
    },
    networkPolicy: createRuntimeNetworkPolicyReceipt({
      runnerUid: topo.identities.runnerUid,
      brokerUid: topo.identities.brokerUid,
      providerHostname: 'openrouter.ai',
      providerHttpsPort: 443,
      providerAddresses: { ipv4: ['104.18.2.10'], ipv6: [] },
      dnsServers: [{ address: '10.0.0.2', family: 4, port: 53 }],
      metadataCidrs: ['169.254.0.0/16', '100.100.100.200/32', 'fe80::/10', 'fd00:ec2::254/128'],
      iptablesExecutableHash: topo.hashes.iptables,
      ip6tablesExecutableHash: topo.hashes.ip6tables,
      producerExecutableHash: topo.hashes.supervisor,
      sandboxId: topo.sandboxId,
      sandboxBootId: topo.sandboxBootId,
      requestHash: HASH('1'),
      trialId: 'trial-1',
      producerSessionId: HASH('5'),
    }),
  });
  assert.deepEqual(await helper(
    'probe', probe, 'runtime-probe.mjs', 'readRuntimeProbeHandoff',
  ), { schema: probe.schema, handoffHash: probe.handoffHash });

  const evidence = createRuntimeEvidenceHandoff({
    executionMode: 'controlled-provider',
    trialId: 'trial-1',
    requestHash: HASH('1'),
    leaseHash: HASH('2'),
    observedAt: '2026-08-04T16:00:07.500Z',
    runnerResult: {
      exitCode: 0,
      signal: 'none',
      startedAt: '2026-08-04T16:00:02.000Z',
      endedAt: '2026-08-04T16:00:07.000Z',
    },
    topology: {
      imageDigest: topo.imageDigest,
      filesystemId: topo.filesystem.id,
      cgroupId: topo.cgroup.id,
      cgroupPathHash: topo.cgroup.pathHash,
      harborExecutableHash: topo.hashes.harbor,
      cpuMax: topo.cgroup.cpuMax,
      memoryMax: topo.cgroup.memoryMax,
      pidsMax: topo.cgroup.pidsMax,
    },
    proxy: {
      eventsHash: HASH('6'),
      eventsComplete: true,
      containerIdHash: HASH('7'),
      imageDigest: topo.imageDigest,
      policyCompliant: true,
    },
    networkPolicy: createRuntimeNetworkPolicyReceipt({
      runnerUid: topo.identities.runnerUid,
      brokerUid: topo.identities.brokerUid,
      providerHostname: 'openrouter.ai',
      providerHttpsPort: 443,
      providerAddresses: { ipv4: ['104.18.2.10'], ipv6: [] },
      dnsServers: [{ address: '10.0.0.2', family: 4, port: 53 }],
      metadataCidrs: ['169.254.0.0/16', '100.100.100.200/32', 'fe80::/10', 'fd00:ec2::254/128'],
      iptablesExecutableHash: topo.hashes.iptables,
      ip6tablesExecutableHash: topo.hashes.ip6tables,
      producerExecutableHash: topo.hashes.supervisor,
      sandboxId: topo.sandboxId,
      sandboxBootId: topo.sandboxBootId,
      requestHash: HASH('1'),
      trialId: 'trial-1',
      producerSessionId: HASH('5'),
    }),
    broker: {
      leaseId: 'lease-1',
      leaseDigest: HASH('2'),
      leaseSequence: 2,
      trialId: 'trial-1',
      policyHash: HASH('8'),
      bindingPolicyHash: HASH('9'),
    },
  });
  assert.deepEqual(await helper(
    'evidence', evidence, 'runtime-evidence.mjs', 'readRuntimeEvidenceHandoff',
  ), { schema: evidence.schema, handoffHash: evidence.handoffHash });
});

test('real Linux integration preconditions are explicit', { skip: process.platform !== 'linux' }, () => {
  assert.equal(process.platform, 'linux');
  assert.equal(typeof process.getuid, 'function');
});
