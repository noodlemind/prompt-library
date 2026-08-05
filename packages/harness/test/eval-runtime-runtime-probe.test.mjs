import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  RUNTIME_PROBE_EXECUTABLE,
  RUNTIME_PROBE_HANDOFF_FD,
  RUNTIME_PROBE_HANDOFF_SCHEMA,
  RuntimeProbeError,
  collectRuntimeProbe,
  createNodeRuntimeProbePrimitives,
  createRuntimeProbeHandoff,
  encodeRuntimeProbeHandoff,
  parseRuntimeProbeArgs,
  parseRuntimeProbeHandoff,
  readRuntimeProbeHandoff,
  runRuntimeProbeCli,
} from '../../../evals/runtime/runtime-probe.mjs';
import { createRuntimeNetworkPolicyReceipt } from '../../../evals/runtime/runtime-evidence.mjs';
import {
  READINESS_PREFLIGHT_PATH,
  READINESS_PREFLIGHT_PUBLICATION_SCHEMA,
  createReadinessPreflightReceipt,
} from '../../../evals/runtime/readiness-preflight.mjs';

const TEN_GIB = 10 * 1024 * 1024 * 1024;
const HASH = (character) => character.repeat(64);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function networkPolicy() {
  return createRuntimeNetworkPolicyReceipt({
    runnerUid: 2001,
    brokerUid: 2002,
    providerHostname: 'openrouter.ai',
    providerHttpsPort: 443,
    providerAddresses: { ipv4: ['104.18.2.10'], ipv6: [] },
    dnsServers: [{ address: '10.0.0.2', family: 4, port: 53 }],
    metadataCidrs: ['169.254.0.0/16', '100.100.100.200/32', 'fe80::/10', 'fd00:ec2::254/128'],
    iptablesExecutableHash: HASH('a'),
    ip6tablesExecutableHash: HASH('b'),
    producerExecutableHash: HASH('2'),
    sandboxId: 'sandbox-1',
    sandboxBootId: '11111111-2222-3333-4444-555555555555',
    requestHash: HASH('1'),
    trialId: 'trial-1',
    producerSessionId: HASH('5'),
  });
}

const PROBE_ARGV = Object.freeze([
  '--phase', 'post-broker',
  '--sandbox-root', '/engineer-bounded',
  '--daemon-socket', '/run/engineer/private-docker.sock',
  '--proxy-socket', '/run/engineer/harbor-docker.sock',
  '--broker-socket', '/run/engineer/provider/provider.sock',
  '--cgroup', '/sys/fs/cgroup/engineer/trial-1',
  '--image-digest', `sha256:${HASH('d')}`,
]);

function handoff(overrides = {}) {
  const base = {
    requestHash: HASH('1'),
    phase: 'post-broker',
    observedAt: '2026-08-04T16:00:01.000Z',
    brokerInstalled: true,
    topology: {
      imageDigest: `sha256:${HASH('d')}`,
      filesystemId: 'dev:feed',
      filesystemBytes: TEN_GIB,
      cgroupId: 'trial-1',
      cgroupPathHash: sha256('/sys/fs/cgroup/engineer/trial-1'),
      runnerUid: 2001,
      brokerUid: 2002,
      runnerExecutableHash: HASH('3'),
      harborExecutableHash: HASH('4'),
    },
    paths: {
      sandboxRoot: '/engineer-bounded',
      daemonSocket: '/run/engineer/private-docker.sock',
      proxySocket: '/run/engineer/harbor-docker.sock',
      brokerSocket: '/run/engineer/provider/provider.sock',
      cgroup: '/sys/fs/cgroup/engineer/trial-1',
      evidenceReserve: '/engineer-bounded/evidence/.reserve',
    },
    resources: {
      evidenceReserveBytes: 256 * 1024 * 1024,
      cpuMax: '200000 100000',
      memoryMax: 4 * 1024 * 1024 * 1024,
      pidsMax: 512,
    },
    networkPolicy: networkPolicy(),
  };
  return createRuntimeProbeHandoff({
    ...base,
    ...overrides,
    topology: { ...base.topology, ...overrides.topology },
    paths: { ...base.paths, ...overrides.paths },
    resources: { ...base.resources, ...overrides.resources },
    networkPolicy: overrides.networkPolicy ?? base.networkPolicy,
  });
}

function zeroProviderReceipt() {
  return createReadinessPreflightReceipt({
    bindings: {
      requestHash: HASH('1'),
      releaseSha: '1'.repeat(40),
      taskLockHash: HASH('6'),
      bundleHash: HASH('7'),
      executionMode: 'zero-provider-canary',
      condition: 'generic',
      imageDigest: `sha256:${HASH('d')}`,
      sandboxId: 'sandbox-1',
      sandboxBootId: '11111111-2222-3333-4444-555555555555',
      trialId: 'trial-1',
      cgroup: { id: 'trial-1', pathHash: sha256('/sys/fs/cgroup/engineer/trial-1') },
      filesystem: {
        id: 'dev:feed', bytes: TEN_GIB, evidenceReserveBytes: 256 * 1024 * 1024,
      },
      networkPolicy: networkPolicy(),
      materialization: {
        trialId: 'trial-1', imageDigest: `sha256:${HASH('d')}`,
        workspaceFilesystemId: 'dev:feed', receiptHash: HASH('8'),
      },
      executables: {
        producerExecutableHash: HASH('2'),
        readinessProbeExecutableHash: HASH('6'),
        runnerExecutableHash: HASH('3'),
        harborExecutableHash: HASH('4'),
        taskIsolationProbeExecutableHash: HASH('e'),
        readinessDenialProbeExecutableHash: HASH('f'),
      },
    },
    observations: {
      conditionMount: { condition: 'generic', passed: true, inventoryHash: HASH('a') },
      noProvider: {
        completed: true, providerCalls: 0, providerCredentialAbsent: true,
        brokerSocketAbsent: true, proofHash: HASH('b'),
      },
      storage: {
        filesystemId: 'dev:feed', totalBytes: TEN_GIB,
        bytesWritten: 8 * 1024 * 1024 * 1024,
        availableBytesAfterCleanup: 512 * 1024 * 1024,
        enospcObserved: true, evidenceHeadroomRecovered: true, proofHash: HASH('c'),
      },
      runner: {
        uid: 2001, effectiveCapabilities: 0, privateDaemonDenied: true,
        realDaemonDenied: true, alternateDaemonDenied: true, mountDenied: true,
        ptraceDenied: true, providerEgressDenied: true, metadataDenied: true,
        daytonaCredentialsAbsent: true, providerCredentialsAbsent: true,
        proofHash: HASH('d'),
      },
      task: {
        networkNone: true, readOnlyRoot: true, capabilitiesDropped: true,
        noNewPrivileges: true, brokerReachable: false, brokerSocketMounted: false,
        brokerClientGidPresent: false, observationHash: HASH('e'),
      },
    },
    producedAt: '2026-08-04T16:00:00.000Z',
    expiresAt: '2026-08-04T16:01:00.000Z',
    producerNonce: HASH('f'),
  });
}

function zeroProviderHandoff() {
  const receipt = zeroProviderReceipt();
  const readinessPreflight = {
    schema: READINESS_PREFLIGHT_PUBLICATION_SCHEMA,
    path: READINESS_PREFLIGHT_PATH,
    receiptHash: receipt.receiptHash,
    bindingHash: receipt.bindingHash,
    bindings: receipt.bindings,
  };
  return {
    receipt,
    document: handoff({
      phase: 'zero-provider',
      brokerInstalled: false,
      readinessPreflight,
    }),
  };
}

function fakePrimitives(overrides = {}) {
  const calls = [];
  const primitives = {
    calls,
    async platform() { calls.push(['platform']); return 'linux'; },
    async effectiveUid() { calls.push(['effectiveUid']); return 0; },
    async readHandoff(spec) { calls.push(['readHandoff', spec]); return handoff(); },
    async inspectCgroup(spec) {
      calls.push(['inspectCgroup', spec]);
      return {
        id: 'trial-1',
        pathHash: sha256('/sys/fs/cgroup/engineer/trial-1'),
        populated: true,
        controllersEnforced: true,
        runnerUid: 2001,
      };
    },
    async inspectNoProviderProbe(spec) {
      calls.push(['inspectNoProviderProbe', spec]);
      return {
        completed: true,
        imageDigest: `sha256:${HASH('d')}`,
        genericMountPassed: true,
        harnessMountPassed: true,
        providerCalls: 0,
        providerCredentialAbsent: true,
        bindingHash: spec.handoff.noProviderProbeBindingHash,
      };
    },
    async inspectStorage(spec) {
      calls.push(['inspectStorage', spec]);
      return {
        filesystemId: 'dev:feed',
        totalBytes: TEN_GIB,
        enospcObserved: true,
        evidenceHeadroomRecovered: true,
      };
    },
    async inspectRunner(spec) {
      calls.push(['inspectRunner', spec]);
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
      };
    },
    async inspectTask(spec) {
      calls.push(['inspectTask', spec]);
      return {
        networkNone: true,
        readOnlyRoot: true,
        capabilitiesDropped: true,
        noNewPrivileges: true,
        brokerReachable: false,
        brokerSocketMounted: false,
        brokerClientGidPresent: false,
      };
    },
    async inspectBroker(spec) {
      calls.push(['inspectBroker', spec]);
      return { uid: 2002, onlyProviderEgress: true };
    },
    async hashExecutable(spec) {
      calls.push(['hashExecutable', spec]);
      return new Map([
        ['runner', HASH('3')],
        ['harbor', HASH('4')],
        ['producer', HASH('2')],
        ['readiness-probe', HASH('6')],
        ['task-isolation-probe', HASH('e')],
        ['readiness-denial-probe', HASH('f')],
      ]).get(spec.role);
    },
    ...overrides,
  };
  return primitives;
}

test('FD-3 probe handoff is separate, canonical, hash-bound, and one-shot', () => {
  const document = handoff();
  const encoded = encodeRuntimeProbeHandoff(document);
  assert.equal(document.schema, RUNTIME_PROBE_HANDOFF_SCHEMA);
  assert.match(document.noProviderProbeBindingHash, /^[a-f0-9]{64}$/);
  assert.match(document.handoffHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(parseRuntimeProbeHandoff(encoded), document);
  assert.equal(encoded.at(-1), '}'.charCodeAt(0));
  assert.throws(() => handoff({ requestHash: HASH('9') }), /lifecycle|binding/i);

  const text = encoded.toString('utf8');
  const duplicate = text.replace('{', `{"schema":"${RUNTIME_PROBE_HANDOFF_SCHEMA}",`);
  for (const malformed of [
    `${text}\n`,
    duplicate,
    text.replace(HASH('1'), HASH('0')),
    `{"schema":"${RUNTIME_PROBE_HANDOFF_SCHEMA}","padding":"${'x'.repeat(40_000)}"}`,
  ]) assert.throws(() => parseRuntimeProbeHandoff(malformed), RuntimeProbeError);

  const calls = [];
  const read = (fd, maximum) => {
    calls.push(['read', fd, maximum]);
    return Buffer.from(encoded);
  };
  const inspect = (fd) => {
    calls.push(['inspect', fd]);
    return { isFIFO: () => true, isSocket: () => false };
  };
  const close = (fd) => calls.push(['close', fd]);
  assert.deepEqual(readRuntimeProbeHandoff({
    fd: RUNTIME_PROBE_HANDOFF_FD, read, inspect, close,
  }), document);
  assert.deepEqual(calls.map(([name]) => name), ['inspect', 'read', 'close']);
  assert.throws(() => readRuntimeProbeHandoff({ fd: 4, read, inspect, close }), /descriptor/i);
});

test('collects the supervisor readiness shape through fixed, content-free primitive requests', async () => {
  const primitives = fakePrimitives();
  const observation = await collectRuntimeProbe({
    argv: [...PROBE_ARGV],
    environment: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    primitives,
  });

  assert.deepEqual(observation, {
    cgroup: {
      id: 'trial-1',
      pathHash: sha256('/sys/fs/cgroup/engineer/trial-1'),
      populated: true,
      controllersEnforced: true,
      runnerUid: 2001,
    },
    noProviderProbe: {
      completed: true,
      imageDigest: `sha256:${HASH('d')}`,
      genericMountPassed: true,
      harnessMountPassed: true,
      providerCalls: 0,
      providerCredentialAbsent: true,
    },
    storageProbe: {
      filesystemId: 'dev:feed',
      totalBytes: TEN_GIB,
      enospcObserved: true,
      evidenceHeadroomRecovered: true,
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
    broker: { uid: 2002, onlyProviderEgress: true },
    executables: {
      runnerExecutableHash: HASH('3'),
      harborExecutableHash: HASH('4'),
    },
  });
  assert.equal(Object.isFrozen(observation), true);

  const hashCalls = primitives.calls.filter(([name]) => name === 'hashExecutable');
  assert.deepEqual(hashCalls, [
    ['hashExecutable', {
      role: 'runner',
      file: '/opt/engineer/bin/engineer-eval-runner',
      maxBytes: 128 * 1024 * 1024,
      shell: false,
    }],
    ['hashExecutable', {
      role: 'harbor',
      file: '/opt/engineer/bin/harbor',
      maxBytes: 128 * 1024 * 1024,
      shell: false,
    }],
  ]);
  for (const [, spec] of primitives.calls.filter(([, spec]) => spec && typeof spec === 'object')) {
    assert.equal(Object.isFrozen(spec), true);
    assert.equal(Object.hasOwn(spec, 'env'), false, 'ambient environment is never forwarded');
  }
});

test('collects one condition-scoped zero-provider readiness shape with no broker', async () => {
  const { document } = zeroProviderHandoff();
  const primitives = fakePrimitives({
    async readHandoff() { return document; },
    async inspectNoProviderProbe(spec) {
      return {
        completed: true,
        imageDigest: `sha256:${HASH('d')}`,
        condition: 'generic',
        conditionMountPassed: true,
        providerCalls: 0,
        providerCredentialAbsent: true,
        bindingHash: spec.handoff.noProviderProbeBindingHash,
      };
    },
    async inspectBroker() {
      return { installed: false, socketAbsent: true, policyAbsent: true };
    },
  });
  const argv = [...PROBE_ARGV];
  argv[1] = 'zero-provider';
  const observation = await collectRuntimeProbe({ argv, environment: {}, primitives });
  assert.deepEqual(observation.noProviderProbe, {
    completed: true,
    imageDigest: `sha256:${HASH('d')}`,
    condition: 'generic',
    conditionMountPassed: true,
    providerCalls: 0,
    providerCredentialAbsent: true,
  });
  assert.deepEqual(observation.broker, {
    installed: false,
    socketAbsent: true,
    policyAbsent: true,
  });
});

test('parser accepts the exact set once and rejects malformed, duplicate, unknown, and oversized argv', () => {
  const parsed = parseRuntimeProbeArgs([...PROBE_ARGV]);
  assert.equal(parsed.phase, 'post-broker');
  assert.equal(parsed.cgroup, '/sys/fs/cgroup/engineer/trial-1');
  const zeroProvider = [...PROBE_ARGV];
  zeroProvider[1] = 'zero-provider';
  assert.equal(parseRuntimeProbeArgs(zeroProvider).phase, 'zero-provider');

  const malformed = [
    PROBE_ARGV.slice(0, -2),
    [...PROBE_ARGV, '--phase', 'post-broker'],
    [...PROBE_ARGV.slice(0, -2), '--unknown', 'value'],
    [...PROBE_ARGV.slice(0, -1), 'sha256:not-a-digest'],
    [...PROBE_ARGV.slice(0, 3), '/tmp/escape', ...PROBE_ARGV.slice(4)],
    [...PROBE_ARGV.slice(0, 11), '/sys/fs/cgroup/../escape', ...PROBE_ARGV.slice(12)],
    [...PROBE_ARGV.slice(0, -1), `sha256:${'a'.repeat(8_192)}`],
  ];
  for (const argv of malformed) {
    assert.throws(() => parseRuntimeProbeArgs(argv), RuntimeProbeError);
  }
});

test('fails closed on platform, root, identity, capability, credential, and secret drift', async () => {
  const cases = [
    fakePrimitives({ async platform() { return 'darwin'; } }),
    fakePrimitives({ async effectiveUid() { return 501; } }),
    fakePrimitives({
      async inspectCgroup() {
        return {
          id: 'trial-1',
          pathHash: sha256('/sys/fs/cgroup/engineer/trial-1'),
          populated: true,
          controllersEnforced: true,
          runnerUid: 0,
        };
      },
    }),
    fakePrimitives({
      async inspectRunner() {
        return {
          ...(await fakePrimitives().inspectRunner({})),
          effectiveCapabilities: 1,
        };
      },
    }),
    fakePrimitives({
      async inspectStorage() {
        return {
          filesystemId: 'dev:feed',
          totalBytes: TEN_GIB,
          enospcObserved: false,
          evidenceHeadroomRecovered: true,
        };
      },
    }),
    fakePrimitives({
      async inspectBroker() {
        return { uid: 2002, onlyProviderEgress: false };
      },
    }),
  ];
  for (const primitives of cases) {
    await assert.rejects(collectRuntimeProbe({
      argv: [...PROBE_ARGV], environment: {}, primitives,
    }), RuntimeProbeError);
  }

  await assert.rejects(collectRuntimeProbe({
    argv: [...PROBE_ARGV],
    environment: { OPENROUTER_API_KEY: 'must-not-be-read' },
    primitives: fakePrimitives(),
  }), /credential|environment/i);
  const unreadProbeEnvironment = {};
  Object.defineProperty(unreadProbeEnvironment, 'OPENROUTER_API_KEY', {
    enumerable: true,
    get() { throw new Error('secret value was inspected'); },
  });
  await assert.rejects(collectRuntimeProbe({
    argv: [...PROBE_ARGV], environment: unreadProbeEnvironment, primitives: fakePrimitives(),
  }), RuntimeProbeError);

  const secretPrimitives = fakePrimitives({
    async inspectStorage() {
      return {
        filesystemId: 'Bearer must-not-escape',
        totalBytes: TEN_GIB,
        enospcObserved: true,
        evidenceHeadroomRecovered: true,
      };
    },
  });
  await assert.rejects(collectRuntimeProbe({
    argv: [...PROBE_ARGV], environment: {}, primitives: secretPrimitives,
  }), (error) => {
    assert.equal(error instanceof RuntimeProbeError, true);
    assert.doesNotMatch(error.message, /Bearer|must-not-escape/);
    return true;
  });
});

test('bounds observations and hashes variable primitive failures instead of exposing diagnostics', async () => {
  const oversized = fakePrimitives({
    async inspectStorage() {
      return {
        filesystemId: 'x'.repeat(70_000),
        totalBytes: TEN_GIB,
        enospcObserved: true,
        evidenceHeadroomRecovered: true,
      };
    },
  });
  await assert.rejects(collectRuntimeProbe({
    argv: [...PROBE_ARGV], environment: {}, primitives: oversized,
  }), /bound|evidence/i);

  const secret = 'sk-proj-primitive-secret';
  const failed = fakePrimitives({
    async inspectTask() { throw new Error(`failure at /private/path with ${secret}`); },
  });
  await assert.rejects(collectRuntimeProbe({
    argv: [...PROBE_ARGV], environment: {}, primitives: failed,
  }), (error) => {
    assert.equal(error instanceof RuntimeProbeError, true);
    assert.match(error.diagnosticHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(`${error.message} ${error.stack}`, /primitive-secret|\/private\/path/);
    return true;
  });
});

test('CLI is pinned to engineer-runtime-probe and writes one bounded canonical JSON record', async () => {
  let output = '';
  const status = await runRuntimeProbeCli({
    executablePath: RUNTIME_PROBE_EXECUTABLE,
    argv: [...PROBE_ARGV],
    environment: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    output: { write(chunk) { output += chunk; return true; } },
    primitives: fakePrimitives(),
  });
  assert.equal(status, 0);
  assert.equal(output.endsWith('\n'), true);
  assert.equal(output.trim(), canonicalJson(JSON.parse(output)));
  assert.ok(Buffer.byteLength(output) < 64 * 1024);

  await assert.rejects(runRuntimeProbeCli({
    executablePath: '/tmp/engineer-runtime-probe',
    argv: [...PROBE_ARGV],
    environment: {},
    output: { write() { throw new Error('must not write'); } },
    primitives: fakePrimitives(),
  }), /invocation|executable/i);
});

test('production probe collectors bind cgroup and broker observations to fixed read-only system facts', async () => {
  const document = handoff();
  const calls = [];
  const system = {
    async observeCgroup(spec) {
      calls.push(['observeCgroup', spec]);
      return {
        real: true,
        id: 'trial-1',
        populated: true,
        processIds: [41],
        processes: [{ pid: 41, uid: 2001, effectiveCapabilities: 0, noNewPrivileges: true }],
        cpuMax: '200000 100000',
        memoryMax: 4 * 1024 * 1024 * 1024,
        pidsMax: 512,
      };
    },
    async observeNetworkPolicy(spec) {
      calls.push(['observeNetworkPolicy', spec]);
      return {
        runnerEgressDenied: true,
        brokerOnlyEgress: true,
        metadataDenied: true,
        rawSocketDenied: true,
        evidenceHash: HASH('a'),
      };
    },
    async inspectPath(spec) {
      calls.push(['inspectPath', spec]);
      return {
        exists: true,
        kind: 'socket',
        real: true,
        ownerUid: 2002,
        groupGid: 2003,
        mode: 0o660,
      };
    },
    async observeSocketProcess(spec) {
      calls.push(['observeSocketProcess', spec]);
      return {
        uid: 2002,
        gid: 2002,
        supplementaryGids: [2003],
        effectiveCapabilities: 0,
        noNewPrivileges: true,
        startTimeTicks: '12345',
      };
    },
    async hashExecutable(spec) {
      calls.push(['hashExecutable', spec]);
      return new Map([
        ['/usr/sbin/iptables', HASH('a')],
        ['/usr/sbin/ip6tables', HASH('b')],
        ['/opt/engineer/bin/engineer-runtime-supervisor', HASH('2')],
      ]).get(spec.file);
    },
    async readBootId(spec) {
      calls.push(['readBootId', spec]);
      return '11111111-2222-3333-4444-555555555555';
    },
  };
  const primitives = createNodeRuntimeProbePrimitives({ system });
  const common = {
    handoff: document,
    phase: 'post-broker',
    brokerSocket: document.paths.brokerSocket,
    cgroup: document.paths.cgroup,
    runnerUid: 2001,
    brokerUid: 2002,
    maxOutputBytes: 64 * 1024,
  };

  assert.deepEqual(await primitives.inspectCgroup(common), {
    id: 'trial-1',
    pathHash: document.topology.cgroupPathHash,
    populated: true,
    controllersEnforced: true,
    runnerUid: 2001,
  });
  assert.deepEqual(await primitives.inspectBroker(common), {
    uid: 2002,
    onlyProviderEgress: true,
  });
  assert.deepEqual(calls[0], ['observeCgroup', {
    path: '/sys/fs/cgroup/engineer/trial-1',
    maxBytes: 64 * 1024,
    shell: false,
  }]);
  assert.equal(calls.some(([name]) => name === 'observeNetworkPolicy'), true);
  assert.equal(calls.some(([, spec]) => spec?.shell !== false), false);
});

test('production probe collectors require one zero-provider preflight instead of fabricating success', async () => {
  const primitives = createNodeRuntimeProbePrimitives({ system: {} });
  const document = handoff();
  const spec = { handoff: document, phase: 'post-broker', shell: false };
  for (const method of [
    'inspectNoProviderProbe', 'inspectStorage', 'inspectRunner', 'inspectTask',
  ]) {
    await assert.rejects(
      primitives[method](spec),
      (error) => error instanceof RuntimeProbeError
        && error.code.includes('ZERO_PROVIDER_READINESS_PREFLIGHT'),
    );
  }
});

test('production collectors consume one condition-scoped receipt and attest no broker', async () => {
  const { document, receipt } = zeroProviderHandoff();
  let consumes = 0;
  const system = {
    async consumeReadinessPreflight(spec) {
      consumes += 1;
      assert.deepEqual(spec.publication, document.readinessPreflight);
      assert.equal(spec.observedAt, document.observedAt);
      return receipt;
    },
    async observeCgroup() { throw new Error('not used'); },
    async observeNetworkPolicy() {
      return {
        runnerEgressDenied: true, brokerOnlyEgress: true,
        metadataDenied: true, rawSocketDenied: true, evidenceHash: HASH('a'),
      };
    },
    async inspectPath() { return { exists: false }; },
    async observeSocketProcess() { throw new Error('not used'); },
    async hashExecutable({ file }) {
      return new Map([
        ['/usr/sbin/iptables', HASH('a')],
        ['/usr/sbin/ip6tables', HASH('b')],
        ['/opt/engineer/bin/engineer-runtime-supervisor', HASH('2')],
      ]).get(file);
    },
    async readBootId() { return '11111111-2222-3333-4444-555555555555'; },
  };
  const primitives = createNodeRuntimeProbePrimitives({ system });
  const spec = {
    handoff: document,
    phase: 'zero-provider',
    brokerSocket: document.paths.brokerSocket,
    maxOutputBytes: 64 * 1024,
  };
  const [noProvider, storage, runner, task, broker] = await Promise.all([
    primitives.inspectNoProviderProbe(spec),
    primitives.inspectStorage(spec),
    primitives.inspectRunner(spec),
    primitives.inspectTask(spec),
    primitives.inspectBroker(spec),
  ]);
  assert.equal(consumes, 1);
  assert.deepEqual(noProvider, {
    completed: true,
    imageDigest: `sha256:${HASH('d')}`,
    condition: 'generic',
    conditionMountPassed: true,
    providerCalls: 0,
    providerCredentialAbsent: true,
    bindingHash: document.noProviderProbeBindingHash,
  });
  assert.equal(storage.enospcObserved, true);
  assert.equal(runner.ptraceDenied, true);
  assert.equal(task.brokerReachable, false);
  assert.deepEqual(broker, { installed: false, socketAbsent: true, policyAbsent: true });
});
