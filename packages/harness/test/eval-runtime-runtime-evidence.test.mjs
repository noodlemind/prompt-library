import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  RUNTIME_EVIDENCE_EXECUTABLE,
  RUNTIME_EVIDENCE_HANDOFF_FD,
  RUNTIME_EVIDENCE_HANDOFF_SCHEMA,
  RuntimeEvidenceError,
  collectRuntimeEvidence,
  createNodeRuntimeEvidencePrimitives,
  createRuntimeEvidenceHandoff,
  createRuntimeNetworkPolicyReceipt,
  encodeRuntimeEvidenceHandoff,
  parseRuntimeEvidenceArgs,
  parseRuntimeEvidenceHandoff,
  readRuntimeEvidenceHandoff,
  runRuntimeEvidenceCli,
  validateRuntimeNetworkRuleInventory,
} from '../../../evals/runtime/runtime-evidence.mjs';
import {
  providerBrokerEvidenceHash,
  providerBrokerStaticPolicyHash,
} from '../../../evals/runtime/provider-broker.mjs';

const HASH = (character) => character.repeat(64);
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function protectedBrokerPolicy() {
  return {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openai/gpt-5-nano',
    provider: {
      order: ['OpenAI'],
      expectedResolvedNames: ['openai'],
      allowFallbacks: false,
    },
    settings: { temperature: 0, reasoning: null, toolChoice: 'auto' },
    maxTokens: 4096,
    pricing: { inputPerM: 1, cachedInputPerM: 1, outputPerM: 1 },
    sessionCeilingUsd: 10,
    trials: [{
      leaseId: 'lease-1',
      leaseDigest: HASH('2'),
      trialId: 'trial-1',
      leaseSequence: 2,
      ceilingUsd: 1,
    }],
  };
}

const PROTECTED_POLICY = protectedBrokerPolicy();
const PROTECTED_POLICY_HASH = providerBrokerStaticPolicyHash(PROTECTED_POLICY);
const PROTECTED_BINDING_HASH = sha256(canonicalJson(PROTECTED_POLICY));

const EVIDENCE_ARGV = Object.freeze([
  '--request-hash', HASH('1'),
  '--lease-hash', HASH('2'),
  '--daemon-socket', '/run/engineer/private-docker.sock',
  '--proxy-socket', '/run/engineer/harbor-docker.sock',
  '--broker-socket', '/run/engineer/provider/provider.sock',
  '--broker-policy', '/engineer-bounded/broker/provider-policy.json',
  '--cgroup', '/sys/fs/cgroup/engineer/trial-1',
  '--workspace', '/engineer-bounded/work',
]);

function networkPolicy(overrides = {}) {
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
    ...overrides,
  });
}

function providerSnapshot(overrides = {}) {
  const base = {
    version: 1,
    state: 'running',
    policy: {
      policyHash: PROTECTED_POLICY_HASH,
      bindingPolicyHash: PROTECTED_BINDING_HASH,
      endpointHash: sha256(PROTECTED_POLICY.endpoint),
      model: PROTECTED_POLICY.model,
      providerEndpointTag: PROTECTED_POLICY.provider.order[0],
      expectedResolvedProvider: PROTECTED_POLICY.provider.expectedResolvedNames[0],
      settings: structuredClone(PROTECTED_POLICY.settings),
      maxTokens: PROTECTED_POLICY.maxTokens,
      pricing: structuredClone(PROTECTED_POLICY.pricing),
    },
    session: {
      ceilingUsd: 10,
      knownActualUsd: 0.0001,
      uncertainReservedUsd: 0,
      activeReservedUsd: 0,
      accountedExposureUsd: 0.0001,
      breached: false,
      blocked: false,
    },
    trials: [{
      leaseId: 'lease-1',
      leaseDigest: HASH('2'),
      trialId: 'trial-1',
      leaseSequence: 2,
      ceilingUsd: 1,
      nextSequence: 2,
      knownActualUsd: 0.0001,
      uncertainReservedUsd: 0,
      activeReservedUsd: 0,
      accountedExposureUsd: 0.0001,
      breached: false,
      blocked: false,
    }],
    attempts: [{
      ordinal: 1,
      attemptId: 'attempt-1',
      leaseId: 'lease-1',
      leaseDigest: HASH('2'),
      trialId: 'trial-1',
      leaseSequence: 2,
      sequence: 1,
      state: 'completed',
      outcome: 'accepted',
      startedAt: Date.parse('2026-08-04T16:00:03.000Z'),
      completedAt: Date.parse('2026-08-04T16:00:04.000Z'),
      model: PROTECTED_POLICY.model,
      providerEndpointTag: PROTECTED_POLICY.provider.order[0],
      expectedResolvedProvider: PROTECTED_POLICY.provider.expectedResolvedNames[0],
      maxTokens: PROTECTED_POLICY.maxTokens,
      requestPayloadBytes: 1024,
      reservedUsd: 0.00512,
      usage: {
        promptTokens: 10,
        cachedTokens: 0,
        cachedTokensComplete: true,
        reasoningTokens: 0,
        reasoningTokensComplete: true,
        outputTokens: 5,
        localCostUsd: 0.000015,
        providerCostUsd: 0.0001,
        reconciledCostUsd: 0.0001,
      },
      actualCostUsd: 0.0001,
      reservationUnderestimated: false,
      budgetBreached: false,
    }],
  };
  return {
    ...base,
    ...overrides,
    policy: { ...base.policy, ...overrides.policy },
    session: { ...base.session, ...overrides.session },
    trials: overrides.trials ?? base.trials,
    attempts: overrides.attempts ?? base.attempts,
  };
}

function mutateProviderSnapshot(mutate) {
  const snapshot = structuredClone(providerSnapshot());
  mutate(snapshot);
  return snapshot;
}

async function reconcileSnapshot(snapshot, { policy = PROTECTED_POLICY } = {}) {
  const policyHash = providerBrokerStaticPolicyHash(policy);
  const bindingPolicyHash = sha256(canonicalJson(policy));
  const boundSnapshot = structuredClone(snapshot);
  boundSnapshot.policy.policyHash = policyHash;
  boundSnapshot.policy.bindingPolicyHash = bindingPolicyHash;
  const primitives = createNodeRuntimeEvidencePrimitives({
    system: {
      async requestBrokerEvidence() {
        return { snapshotHash: providerBrokerEvidenceHash(boundSnapshot), snapshot: boundSnapshot };
      },
      async attestBrokerPolicy() {
        return { policyHash, bindingPolicyHash, policy: structuredClone(policy) };
      },
    },
  });
  return primitives.inspectProvider({
    requestHash: HASH('1'),
    leaseHash: HASH('2'),
    brokerSocket: '/run/engineer/provider/provider.sock',
    brokerPolicy: '/engineer-bounded/broker/provider-policy.json',
    handoff: handoff({ broker: { policyHash, bindingPolicyHash } }),
    maxOutputBytes: 64 * 1024,
  });
}

function handoff(overrides = {}) {
  const base = {
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
      imageDigest: `sha256:${HASH('d')}`,
      filesystemId: 'dev:feed',
      cgroupId: 'trial-1',
      cgroupPathHash: HASH('f'),
      harborExecutableHash: HASH('4'),
      cpuMax: '200000 100000',
      memoryMax: 4 * 1024 * 1024 * 1024,
      pidsMax: 512,
    },
    proxy: {
      eventsHash: HASH('6'),
      eventsComplete: true,
      containerIdHash: HASH('7'),
      imageDigest: `sha256:${HASH('d')}`,
      policyCompliant: true,
    },
    networkPolicy: networkPolicy(),
    broker: {
      leaseId: 'lease-1',
      leaseDigest: HASH('2'),
      leaseSequence: 2,
      trialId: 'trial-1',
      policyHash: PROTECTED_POLICY_HASH,
      bindingPolicyHash: PROTECTED_BINDING_HASH,
    },
  };
  return createRuntimeEvidenceHandoff({
    ...base,
    ...overrides,
    runnerResult: { ...base.runnerResult, ...overrides.runnerResult },
    topology: { ...base.topology, ...overrides.topology },
    proxy: { ...base.proxy, ...overrides.proxy },
    networkPolicy: overrides.networkPolicy ?? base.networkPolicy,
    broker: { ...base.broker, ...overrides.broker },
  });
}

function fakePrimitives(overrides = {}) {
  const calls = [];
  return {
    calls,
    async platform() { calls.push(['platform']); return 'linux'; },
    async effectiveUid() { calls.push(['effectiveUid']); return 0; },
    async readHandoff(spec) { calls.push(['readHandoff', spec]); return handoff(); },
    async inspectDaemonCustody(spec) {
      calls.push(['inspectDaemonCustody', spec]);
      return {
        daemon: { kind: 'socket', real: true, ownerUid: 0, groupGid: 0, mode: 0o600 },
        proxy: { kind: 'socket', real: true, ownerUid: 0, groupGid: 2001, mode: 0o660 },
        broker: { kind: 'socket', real: true, ownerUid: 2002, groupGid: 2003, mode: 0o660 },
        brokerPolicy: { kind: 'file', real: true, ownerUid: 2002, groupGid: 2002, mode: 0o600 },
      };
    },
    async inspectHarbor(spec) {
      calls.push(['inspectHarbor', spec]);
      return { completed: true, exitCode: 0, executableHash: HASH('4') };
    },
    async inspectDocker(spec) {
      calls.push(['inspectDocker', spec]);
      return {
        eventsHash: HASH('6'),
        eventsComplete: true,
        containerIdHash: HASH('7'),
        imageDigest: `sha256:${HASH('d')}`,
        policyCompliant: true,
        containersRemaining: 0,
        networksRemaining: 0,
        volumesRemaining: 0,
      };
    },
    async inspectMounts(spec) {
      calls.push(['inspectMounts', spec]);
      return {
        inventoryHash: HASH('8'),
        policyCompliant: true,
        outsideAllowedWrites: false,
        daemonRootFilesystemId: 'dev:feed',
        workspaceFilesystemId: 'dev:feed',
      };
    },
    async inspectCgroup(spec) {
      calls.push(['inspectCgroup', spec]);
      return {
        evidenceHash: HASH('9'),
        id: 'trial-1',
        pathHash: HASH('f'),
        populated: false,
        processesRemaining: 0,
        limitsEnforced: true,
      };
    },
    async inspectResources(spec) {
      calls.push(['inspectResources', spec]);
      return {
        evidenceHash: HASH('a'),
        cpuWithinLimit: true,
        memoryWithinLimit: true,
        pidsWithinLimit: true,
        oomKilled: false,
      };
    },
    async inspectNetwork(spec) {
      calls.push(['inspectNetwork', spec]);
      return {
        evidenceHash: HASH('b'),
        taskNetworkNone: true,
        runnerEgressDenied: true,
        brokerOnlyEgress: true,
        metadataDenied: true,
        rawSocketDenied: true,
      };
    },
    async inspectProvider(spec) {
      calls.push(['inspectProvider', spec]);
      return {
        requestHash: HASH('1'),
        leaseHash: HASH('2'),
        usageHash: HASH('c'),
        identityHash: HASH('d'),
        spendMicrousd: 100,
        billingCertain: true,
        budgetComplete: true,
        withinTrialCeiling: true,
        attempts: 1,
      };
    },
    async inspectCleanup(spec) {
      calls.push(['inspectCleanup', spec]);
      return {
        completed: true,
        containersRemaining: 0,
        networksRemaining: 0,
        volumesRemaining: 0,
        processesRemaining: 0,
        cgroupPopulated: false,
      };
    },
    async now() { calls.push(['now']); return new Date('2026-08-04T16:00:08.000Z'); },
    ...overrides,
  };
}

function networkRuleInventory(overrides = {}) {
  const ipv4 = {
    output: '-P OUTPUT ACCEPT\n-A OUTPUT -j ENGINEER_EGRESS_V4\n',
    chain: [
      '-N ENGINEER_EGRESS_V4',
      '-A ENGINEER_EGRESS_V4 -d 169.254.0.0/16 -j REJECT',
      '-A ENGINEER_EGRESS_V4 -d 100.100.100.200/32 -j REJECT',
      '-A ENGINEER_EGRESS_V4 -o lo -j ACCEPT',
      '-A ENGINEER_EGRESS_V4 -m conntrack --ctstate ESTABLISHED -j ACCEPT',
      '-A ENGINEER_EGRESS_V4 -p tcp -m owner --uid-owner 2002 -d 104.18.2.10/32 -m tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT',
      '-A ENGINEER_EGRESS_V4 -p udp -m owner --uid-owner 2002 -d 10.0.0.2/32 -m udp --dport 53 -m conntrack --ctstate NEW -j ACCEPT',
      '-A ENGINEER_EGRESS_V4 -p tcp -m owner --uid-owner 2002 -d 10.0.0.2/32 -m tcp --dport 53 -m conntrack --ctstate NEW -j ACCEPT',
      '-A ENGINEER_EGRESS_V4 -m owner --uid-owner 2001 -j REJECT',
      '-A ENGINEER_EGRESS_V4 -m owner --uid-owner 2002 -j REJECT',
      '-A ENGINEER_EGRESS_V4 -j REJECT',
    ].join('\n') + '\n',
  };
  const ipv6 = {
    output: '-P OUTPUT ACCEPT\n-A OUTPUT -j ENGINEER_EGRESS_V6\n',
    chain: [
      '-N ENGINEER_EGRESS_V6',
      '-A ENGINEER_EGRESS_V6 -d fe80::/10 -j REJECT',
      '-A ENGINEER_EGRESS_V6 -d fd00:ec2::254/128 -j REJECT',
      '-A ENGINEER_EGRESS_V6 -o lo -j ACCEPT',
      '-A ENGINEER_EGRESS_V6 -m conntrack --ctstate ESTABLISHED -j ACCEPT',
      '-A ENGINEER_EGRESS_V6 -m owner --uid-owner 2001 -j REJECT',
      '-A ENGINEER_EGRESS_V6 -m owner --uid-owner 2002 -j REJECT',
      '-A ENGINEER_EGRESS_V6 -j REJECT',
    ].join('\n') + '\n',
  };
  return {
    ipv4: { ...ipv4, ...overrides.ipv4 },
    ipv6: { ...ipv6, ...overrides.ipv6 },
  };
}

test('network policy receipt binds exact destination sets, first OUTPUT attachment, and ordered verdicts', () => {
  const receipt = networkPolicy();
  assert.equal(validateRuntimeNetworkRuleInventory(receipt, networkRuleInventory()).length, 2);

  const permissive = networkRuleInventory();
  permissive.ipv4.chain = permissive.ipv4.chain.replace(
    '-A ENGINEER_EGRESS_V4 -j REJECT\n',
    '-A ENGINEER_EGRESS_V4 -p tcp -m owner --uid-owner 2002 -d 203.0.113.1/32 -m tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT\n-A ENGINEER_EGRESS_V4 -j REJECT\n',
  );
  assert.throws(() => validateRuntimeNetworkRuleInventory(receipt, permissive), /order|destination|drift/i);

  const bypass = networkRuleInventory({
    ipv4: { output: '-P OUTPUT ACCEPT\n-A OUTPUT -j ACCEPT\n-A OUTPUT -j ENGINEER_EGRESS_V4\n' },
  });
  assert.throws(() => validateRuntimeNetworkRuleInventory(receipt, bypass), /first|OUTPUT|verdict/i);
});

test('FD-3 handoff is exact, versioned, bounded, canonical, hash-bound, and one-shot', () => {
  const document = handoff();
  const encoded = encodeRuntimeEvidenceHandoff(document);
  assert.equal(document.schema, RUNTIME_EVIDENCE_HANDOFF_SCHEMA);
  assert.match(document.handoffHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(parseRuntimeEvidenceHandoff(encoded), document);
  assert.equal(encoded.at(-1), '}'.charCodeAt(0), 'canonical handoff has no trailing newline');
  assert.throws(() => handoff({ requestHash: HASH('9') }), /lifecycle|binding/i);
  assert.throws(() => handoff({ broker: { trialId: 'trial-2' } }), /lifecycle|binding/i);

  const text = encoded.toString('utf8');
  const duplicate = text.replace('{', `{"schema":"${RUNTIME_EVIDENCE_HANDOFF_SCHEMA}",`);
  for (const malformed of [
    `${text}\n`,
    duplicate,
    text.replace(HASH('1'), HASH('0')),
    `{"schema":"${RUNTIME_EVIDENCE_HANDOFF_SCHEMA}","padding":"${'x'.repeat(40_000)}"}`,
    JSON.stringify({ ...document, providerSecret: 'Bearer must-not-escape' }),
  ]) {
    assert.throws(() => parseRuntimeEvidenceHandoff(malformed), RuntimeEvidenceError);
  }

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
  assert.deepEqual(readRuntimeEvidenceHandoff({
    fd: RUNTIME_EVIDENCE_HANDOFF_FD, read, inspect, close,
  }), document);
  assert.deepEqual(calls.map(([name]) => name), ['inspect', 'read', 'close']);
  assert.throws(() => readRuntimeEvidenceHandoff({ fd: 4, read, inspect, close }), /descriptor/i);
});

test('collects only the final evidence fields accepted by the supervisor', async () => {
  const primitives = fakePrimitives();
  const evidence = await collectRuntimeEvidence({
    argv: [...EVIDENCE_ARGV],
    environment: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    primitives,
  });

  assert.deepEqual(evidence, {
    startedAt: '2026-08-04T16:00:02.000Z',
    endedAt: '2026-08-04T16:00:08.000Z',
    harbor: { completed: true, exitCode: 0, executableHash: HASH('4') },
    docker: {
      eventsHash: HASH('6'),
      eventsComplete: true,
      containerIdHash: HASH('7'),
      imageDigest: `sha256:${HASH('d')}`,
      policyCompliant: true,
      containersRemaining: 0,
      networksRemaining: 0,
      volumesRemaining: 0,
    },
    mounts: {
      inventoryHash: HASH('8'),
      policyCompliant: true,
      outsideAllowedWrites: false,
      daemonRootFilesystemId: 'dev:feed',
      workspaceFilesystemId: 'dev:feed',
    },
    cgroup: {
      evidenceHash: HASH('9'),
      id: 'trial-1',
      pathHash: HASH('f'),
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
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.deepEqual(Object.keys(evidence), [
    'startedAt', 'endedAt', 'harbor', 'docker', 'mounts', 'cgroup',
    'resources', 'network', 'provider', 'cleanup',
  ]);
  for (const [, spec] of primitives.calls.filter(([, spec]) => spec && typeof spec === 'object')) {
    assert.equal(Object.isFrozen(spec), true);
    assert.equal(spec.shell, false);
    assert.equal(Object.hasOwn(spec, 'env'), false, 'ambient environment is never forwarded');
  }
});

test('parser rejects missing, unknown, duplicate, non-canonical, and oversized arguments', () => {
  assert.equal(parseRuntimeEvidenceArgs([...EVIDENCE_ARGV]).workspace, '/engineer-bounded/work');
  const malformed = [
    EVIDENCE_ARGV.slice(0, -2),
    [...EVIDENCE_ARGV, '--lease-hash', HASH('2')],
    [...EVIDENCE_ARGV.slice(0, -2), '--unknown', '/engineer-bounded/work'],
    [...EVIDENCE_ARGV.slice(0, 1), 'nope', ...EVIDENCE_ARGV.slice(2)],
    [...EVIDENCE_ARGV.slice(0, 13), '/sys/fs/cgroup/../escape', ...EVIDENCE_ARGV.slice(14)],
    [...EVIDENCE_ARGV.slice(0, 15), '/tmp/work'],
    [...EVIDENCE_ARGV.slice(0, -1), `/engineer-bounded/${'x'.repeat(8_192)}`],
  ];
  for (const argv of malformed) assert.throws(() => parseRuntimeEvidenceArgs(argv), RuntimeEvidenceError);
});

test('fails closed on environment, Linux/root, handoff binding, and runtime identity drift', async () => {
  await assert.rejects(collectRuntimeEvidence({
    argv: [...EVIDENCE_ARGV],
    environment: { DAYTONA_API_KEY: 'not-readable' },
    primitives: fakePrimitives(),
  }), /credential|environment/i);
  const unreadEvidenceEnvironment = {};
  Object.defineProperty(unreadEvidenceEnvironment, 'DAYTONA_API_KEY', {
    enumerable: true,
    get() { throw new Error('secret value was inspected'); },
  });
  await assert.rejects(collectRuntimeEvidence({
    argv: [...EVIDENCE_ARGV], environment: unreadEvidenceEnvironment, primitives: fakePrimitives(),
  }), RuntimeEvidenceError);

  const cases = [
    fakePrimitives({ async platform() { return 'darwin'; } }),
    fakePrimitives({ async effectiveUid() { return 501; } }),
    fakePrimitives({ async readHandoff() { return handoff({ leaseHash: HASH('0') }); } }),
    fakePrimitives({ async readHandoff() { return handoff({ runnerResult: { exitCode: 7 } }); } }),
    fakePrimitives({
      async inspectDaemonCustody() {
        const value = await fakePrimitives().inspectDaemonCustody({});
        return { ...value, daemon: { ...value.daemon, ownerUid: 2001 } };
      },
    }),
    fakePrimitives({
      async inspectDocker() {
        const value = await fakePrimitives().inspectDocker({});
        return { ...value, imageDigest: `sha256:${HASH('0')}` };
      },
    }),
    fakePrimitives({
      async inspectCgroup() {
        const value = await fakePrimitives().inspectCgroup({});
        return { ...value, processesRemaining: 1 };
      },
    }),
    fakePrimitives({
      async inspectProvider() {
        const value = await fakePrimitives().inspectProvider({});
        return { ...value, leaseHash: HASH('0') };
      },
    }),
  ];
  for (const primitives of cases) {
    await assert.rejects(collectRuntimeEvidence({
      argv: [...EVIDENCE_ARGV], environment: {}, primitives,
    }), RuntimeEvidenceError);
  }
});

test('rejects malformed, oversized, and secret-bearing evidence without returning sensitive diagnostics', async () => {
  const malformed = fakePrimitives({
    async inspectNetwork() {
      return {
        evidenceHash: HASH('b'),
        taskNetworkNone: true,
        runnerEgressDenied: true,
        brokerOnlyEgress: true,
        metadataDenied: true,
        rawSocketDenied: true,
        extra: true,
      };
    },
  });
  await assert.rejects(collectRuntimeEvidence({
    argv: [...EVIDENCE_ARGV], environment: {}, primitives: malformed,
  }), /unknown|field|evidence/i);

  const oversized = fakePrimitives({
    async inspectMounts() {
      return {
        inventoryHash: HASH('8'),
        policyCompliant: true,
        outsideAllowedWrites: false,
        daemonRootFilesystemId: 'x'.repeat(70_000),
        workspaceFilesystemId: 'dev:feed',
      };
    },
  });
  await assert.rejects(collectRuntimeEvidence({
    argv: [...EVIDENCE_ARGV], environment: {}, primitives: oversized,
  }), /bound|evidence/i);

  const secret = 'Bearer primitive-secret';
  const secretBearing = fakePrimitives({
    async inspectProvider() {
      return {
        requestHash: HASH('1'),
        leaseHash: HASH('2'),
        usageHash: HASH('c'),
        identityHash: HASH('d'),
        spendMicrousd: 0,
        billingCertain: true,
        budgetComplete: true,
        withinTrialCeiling: true,
        attempts: 0,
        diagnostic: secret,
      };
    },
  });
  await assert.rejects(collectRuntimeEvidence({
    argv: [...EVIDENCE_ARGV], environment: {}, primitives: secretBearing,
  }), (error) => {
    assert.doesNotMatch(`${error.message} ${error.stack}`, /primitive-secret|Bearer/);
    return error instanceof RuntimeEvidenceError;
  });

  const failed = fakePrimitives({
    async inspectDocker() { throw new Error('sk-proj-secret at /private/docker.sock'); },
  });
  await assert.rejects(collectRuntimeEvidence({
    argv: [...EVIDENCE_ARGV], environment: {}, primitives: failed,
  }), (error) => {
    assert.match(error.diagnosticHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(`${error.message} ${error.stack}`, /sk-proj-secret|\/private\/docker/);
    return error instanceof RuntimeEvidenceError;
  });
});

test('CLI is pinned to engineer-runtime-evidence and emits exactly one canonical bounded record', async () => {
  let output = '';
  const status = await runRuntimeEvidenceCli({
    executablePath: RUNTIME_EVIDENCE_EXECUTABLE,
    argv: [...EVIDENCE_ARGV],
    environment: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    output: { write(chunk) { output += chunk; return true; } },
    primitives: fakePrimitives(),
  });
  assert.equal(status, 0);
  assert.equal(output.endsWith('\n'), true);
  assert.ok(Buffer.byteLength(output) < 64 * 1024);
  assert.deepEqual(Object.keys(JSON.parse(output)), [
    'cgroup', 'cleanup', 'docker', 'endedAt', 'harbor', 'mounts',
    'network', 'provider', 'resources', 'startedAt',
  ]);

  await assert.rejects(runRuntimeEvidenceCli({
    executablePath: '/tmp/engineer-runtime-evidence',
    argv: [...EVIDENCE_ARGV],
    environment: {},
    output: { write() { throw new Error('must not write'); } },
    primitives: fakePrimitives(),
  }), /invocation|executable/i);
});

test('production evidence collectors use fixed read-only inventories and authenticated broker reconciliation', async () => {
  const document = handoff();
  const calls = [];
  const pathFacts = new Map([
    ['/run/engineer/private-docker.sock', { kind: 'socket', real: true, ownerUid: 0, groupGid: 0, mode: 0o600 }],
    ['/run/engineer/harbor-docker.sock', { kind: 'socket', real: true, ownerUid: 0, groupGid: 2001, mode: 0o660 }],
    ['/run/engineer/provider/provider.sock', { kind: 'socket', real: true, ownerUid: 2002, groupGid: 2003, mode: 0o660 }],
    ['/engineer-bounded/broker/provider-policy.json', { kind: 'file', real: true, ownerUid: 2002, groupGid: 2002, mode: 0o600 }],
  ]);
  const system = {
    async inspectPath(spec) {
      calls.push(['inspectPath', spec]);
      return { exists: true, ...pathFacts.get(spec.path) };
    },
    async attestBrokerPolicy(spec) {
      calls.push(['attestBrokerPolicy', spec]);
      return {
        policyHash: PROTECTED_POLICY_HASH,
        bindingPolicyHash: PROTECTED_BINDING_HASH,
        policy: structuredClone(PROTECTED_POLICY),
      };
    },
    async hashExecutable(spec) {
      calls.push(['hashExecutable', spec]);
      return new Map([
        ['/opt/engineer/bin/harbor', HASH('4')],
        ['/usr/sbin/iptables', HASH('a')],
        ['/usr/sbin/ip6tables', HASH('b')],
        ['/opt/engineer/bin/engineer-runtime-supervisor', HASH('2')],
      ]).get(spec.file);
    },
    async runCommand(spec) {
      calls.push(['runCommand', spec]);
      if (spec.args.includes('container')) return { exitCode: 0, stdout: '' };
      if (spec.args.includes('network')) return { exitCode: 0, stdout: '' };
      if (spec.args.includes('volume')) return { exitCode: 0, stdout: '' };
      throw new Error('unexpected command');
    },
    async statFilesystem(spec) {
      calls.push(['statFilesystem', spec]);
      return { id: 'dev:feed', bytes: 10 * 1024 * 1024 * 1024, real: true };
    },
    async readTaskMountReceipt(spec) {
      calls.push(['readTaskMountReceipt', spec]);
      return {
        schema: 'engineer-runtime-task-mount-receipt.v1',
        requestHash: HASH('1'),
        leaseHash: HASH('2'),
        proxyEventsHash: HASH('6'),
        containerIdHash: HASH('7'),
        mountNamespaceIdentityHash: HASH('5'),
        bindInventoryHash: HASH('6'),
        writableMountInventoryHash: HASH('7'),
        inventoryHash: HASH('8'),
        producerExecutableHash: HASH('2'),
        sandboxBootId: '11111111-2222-3333-4444-555555555555',
        trialId: 'trial-1',
        producerSessionId: HASH('5'),
        policyCompliant: true,
        outsideAllowedWrites: false,
        daemonRootFilesystemId: 'dev:feed',
        workspaceFilesystemId: 'dev:feed',
      };
    },
    async readBootId(spec) {
      calls.push(['readBootId', spec]);
      return '11111111-2222-3333-4444-555555555555';
    },
    async readTaskIsolationReceipt(spec) {
      calls.push(['readTaskIsolationReceipt', spec]);
      return {
        schema: 'engineer-runtime-task-isolation-receipt.v1',
        requestHash: HASH('1'),
        leaseHash: HASH('2'),
        proxyEventsHash: HASH('6'),
        containerIdHash: HASH('7'),
        imageDigest: `sha256:${HASH('d')}`,
        networkNamespaceIdentityHash: HASH('9'),
        interfaceInventoryHash: HASH('a'),
        rawSocketCanaryHash: HASH('b'),
        producerExecutableHash: HASH('2'),
        sandboxBootId: '11111111-2222-3333-4444-555555555555',
        trialId: 'trial-1',
        producerSessionId: HASH('5'),
        networkMode: 'none',
        effectiveCapabilities: 0,
        noNewPrivileges: true,
        taskNetworkNone: true,
        rawSocketDenied: true,
      };
    },
    async observeCgroup(spec) {
      calls.push(['observeCgroup', spec]);
      return {
        real: true,
        id: 'trial-1',
        populated: false,
        processIds: [],
        cpuMax: '200000 100000',
        memoryMax: 4 * 1024 * 1024 * 1024,
        memoryPeak: 512 * 1024 * 1024,
        pidsMax: 512,
        pidsPeak: 16,
        oomKills: 0,
        cpuUsageUsec: 12_000,
      };
    },
    async observeNetworkPolicy(spec) {
      calls.push(['observeNetworkPolicy', spec]);
      return {
        evidenceHash: HASH('b'),
        runnerEgressDenied: true,
        brokerOnlyEgress: true,
        metadataDenied: true,
        rawSocketDenied: true,
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
    async requestBrokerEvidence(spec) {
      calls.push(['requestBrokerEvidence', spec]);
      const snapshot = providerSnapshot();
      return { snapshotHash: providerBrokerEvidenceHash(snapshot), snapshot };
    },
  };
  const primitives = createNodeRuntimeEvidencePrimitives({ system });
  const common = {
    requestHash: HASH('1'),
    leaseHash: HASH('2'),
    daemonSocket: '/run/engineer/private-docker.sock',
    proxySocket: '/run/engineer/harbor-docker.sock',
    brokerSocket: '/run/engineer/provider/provider.sock',
    brokerPolicy: '/engineer-bounded/broker/provider-policy.json',
    cgroup: '/sys/fs/cgroup/engineer/trial-1',
    workspace: '/engineer-bounded/work',
    handoff: document,
    maxOutputBytes: 64 * 1024,
  };

  assert.deepEqual(await primitives.inspectDaemonCustody(common), {
    daemon: { kind: 'socket', real: true, ownerUid: 0, groupGid: 0, mode: 0o600 },
    proxy: { kind: 'socket', real: true, ownerUid: 0, groupGid: 2001, mode: 0o660 },
    broker: { kind: 'socket', real: true, ownerUid: 2002, groupGid: 2003, mode: 0o660 },
    brokerPolicy: { kind: 'file', real: true, ownerUid: 2002, groupGid: 2002, mode: 0o600 },
  });
  assert.equal((await primitives.inspectHarbor(common)).executableHash, HASH('4'));
  const docker = await primitives.inspectDocker(common);
  assert.equal(docker.containersRemaining, 0);
  assert.equal((await primitives.inspectMounts(common)).outsideAllowedWrites, false);
  const cgroup = await primitives.inspectCgroup(common);
  const resources = await primitives.inspectResources(common);
  const network = await primitives.inspectNetwork(common);
  const provider = await primitives.inspectProvider(common);
  assert.equal(cgroup.processesRemaining, 0);
  assert.equal(resources.oomKilled, false);
  assert.equal(network.brokerOnlyEgress, true);
  assert.equal(provider.spendMicrousd, 100);
  assert.match(provider.usageHash, /^[a-f0-9]{64}$/);
  assert.match(provider.identityHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await primitives.inspectCleanup({ ...common, docker, cgroup }), {
    completed: true,
    containersRemaining: 0,
    networksRemaining: 0,
    volumesRemaining: 0,
    processesRemaining: 0,
    cgroupPopulated: false,
  });

  const commands = calls.filter(([name]) => name === 'runCommand').map(([, spec]) => spec);
  assert.equal(commands.length, 3);
  for (const command of commands) {
    assert.equal(command.file, '/usr/local/bin/docker');
    assert.equal(command.args[0], '--host');
    assert.equal(command.args[1], 'unix:///run/engineer/private-docker.sock');
    assert.equal(command.shell, false);
    assert.deepEqual(command.env, { LANG: 'C.UTF-8' });
  }
  assert.deepEqual(calls.find(([name]) => name === 'requestBrokerEvidence')[1], {
    socketPath: '/run/engineer/provider/provider.sock',
    timeoutMs: 5_000,
    maxFrameBytes: 64 * 1024,
    shell: false,
  });
  assert.equal(calls.some(([, spec]) => spec?.shell !== false), false);
  assert.notEqual(crypto.createHash('sha256').update('identity').digest('hex'), provider.identityHash);

  const replayedMount = createNodeRuntimeEvidencePrimitives({
    system: {
      ...system,
      async readTaskMountReceipt(spec) {
        return { ...(await system.readTaskMountReceipt(spec)), producerSessionId: HASH('9') };
      },
    },
  });
  await assert.rejects(replayedMount.inspectMounts(common), /binding/i);

  const replayedIsolation = createNodeRuntimeEvidencePrimitives({
    system: {
      ...system,
      async readTaskIsolationReceipt(spec) {
        return { ...(await system.readTaskIsolationReceipt(spec)), producerSessionId: HASH('9') };
      },
    },
  });
  await assert.rejects(replayedIsolation.inspectNetwork(common), /drift|binding/i);
});

test('provider reconciliation derives exact ledger arithmetic from protected policy and attempts', async (t) => {
  await t.test('accepted, partial, disconnected, and one-pico spend branches', async () => {
    assert.equal((await reconcileSnapshot(providerSnapshot())).spendMicrousd, 100);

    const partial = mutateProviderSnapshot((snapshot) => {
      snapshot.attempts[0].outcome = 'rejected-partial-completion';
    });
    assert.equal((await reconcileSnapshot(partial)).spendMicrousd, 100);

    const disconnected = mutateProviderSnapshot((snapshot) => {
      Object.assign(snapshot.attempts[0], {
        outcome: 'rejected-disconnected-before-dispatch',
        usage: null,
        actualCostUsd: 0,
      });
      for (const ledger of [snapshot.session, snapshot.trials[0]]) {
        ledger.knownActualUsd = 0;
        ledger.accountedExposureUsd = 0;
      }
    });
    assert.equal((await reconcileSnapshot(disconnected)).spendMicrousd, 0);

    const twoAttempts = structuredClone(disconnected);
    twoAttempts.attempts.push({
      ...structuredClone(twoAttempts.attempts[0]),
      ordinal: 2,
      attemptId: 'attempt-2',
      sequence: 2,
      startedAt: Date.parse('2026-08-04T16:00:05.000Z'),
      completedAt: Date.parse('2026-08-04T16:00:06.000Z'),
    });
    twoAttempts.trials[0].nextSequence = 3;
    assert.equal((await reconcileSnapshot(twoAttempts)).attempts, 2);

    const duplicateAttempt = structuredClone(twoAttempts);
    duplicateAttempt.attempts[1].attemptId = 'attempt-1';
    await assert.rejects(reconcileSnapshot(duplicateAttempt), RuntimeEvidenceError);

    const pico = mutateProviderSnapshot((snapshot) => {
      Object.assign(snapshot.attempts[0].usage, {
        promptTokens: 0,
        cachedTokens: null,
        cachedTokensComplete: false,
        reasoningTokens: null,
        reasoningTokensComplete: false,
        outputTokens: 0,
        localCostUsd: 0,
        providerCostUsd: 0.000000000001,
        reconciledCostUsd: 0.000000000001,
      });
      snapshot.attempts[0].actualCostUsd = 0.000000000001;
      for (const ledger of [snapshot.session, snapshot.trials[0]]) {
        ledger.knownActualUsd = 0.000000000001;
        ledger.accountedExposureUsd = 0.000000000001;
      }
    });
    assert.equal((await reconcileSnapshot(pico)).spendMicrousd, 1);
  });

  await t.test('enforces broker-equivalent reservation admission at the one-pico boundary', async () => {
    const allowedPolicy = protectedBrokerPolicy();
    allowedPolicy.sessionCeilingUsd = 0.005119999999;
    allowedPolicy.trials[0].ceilingUsd = 0.005119999999;
    const allowed = providerSnapshot();
    allowed.session.ceilingUsd = allowedPolicy.sessionCeilingUsd;
    allowed.trials[0].ceilingUsd = allowedPolicy.trials[0].ceilingUsd;
    allowed.attempts[0].usage.providerCostUsd = 0.00512;
    allowed.attempts[0].usage.reconciledCostUsd = 0.00512;
    allowed.attempts[0].actualCostUsd = 0.00512;
    for (const ledger of [allowed.session, allowed.trials[0]]) {
      ledger.knownActualUsd = 0.00512;
      ledger.accountedExposureUsd = 0.00512;
    }
    assert.equal((await reconcileSnapshot(allowed, { policy: allowedPolicy })).spendMicrousd, 5_120);

    const deniedPolicy = protectedBrokerPolicy();
    deniedPolicy.sessionCeilingUsd = 0.005119999998;
    deniedPolicy.trials[0].ceilingUsd = 0.005119999998;
    const denied = providerSnapshot();
    denied.session.ceilingUsd = deniedPolicy.sessionCeilingUsd;
    denied.trials[0].ceilingUsd = deniedPolicy.trials[0].ceilingUsd;
    await assert.rejects(reconcileSnapshot(denied, { policy: deniedPolicy }), RuntimeEvidenceError);
  });

  await t.test('rejects a later reservation that exceeds remaining cumulative exposure', async () => {
    const policy = protectedBrokerPolicy();
    policy.sessionCeilingUsd = 0.01;
    policy.trials[0].ceilingUsd = 0.01;
    const snapshot = providerSnapshot();
    snapshot.session.ceilingUsd = policy.sessionCeilingUsd;
    snapshot.trials[0].ceilingUsd = policy.trials[0].ceilingUsd;
    snapshot.attempts[0].usage.providerCostUsd = 0.005;
    snapshot.attempts[0].usage.reconciledCostUsd = 0.005;
    snapshot.attempts[0].actualCostUsd = 0.005;
    for (const ledger of [snapshot.session, snapshot.trials[0]]) {
      ledger.knownActualUsd = 0.005;
      ledger.accountedExposureUsd = 0.005;
    }
    snapshot.attempts.push({
      ...structuredClone(snapshot.attempts[0]),
      ordinal: 2,
      attemptId: 'attempt-2',
      sequence: 2,
      outcome: 'rejected-disconnected-before-dispatch',
      startedAt: Date.parse('2026-08-04T16:00:05.000Z'),
      completedAt: Date.parse('2026-08-04T16:00:06.000Z'),
      usage: null,
      actualCostUsd: 0,
      reservationUnderestimated: false,
      budgetBreached: false,
    });
    snapshot.trials[0].nextSequence = 3;
    await assert.rejects(reconcileSnapshot(snapshot, { policy }), RuntimeEvidenceError);
  });

  const corruptions = [
    ['accounted exposure', (snapshot) => { snapshot.trials[0].accountedExposureUsd = 0; }],
    ['attempt total', (snapshot) => { snapshot.trials[0].knownActualUsd = 0.0002; }],
    ['session ledger', (snapshot) => { snapshot.session.knownActualUsd = 0.0002; }],
    ['forged ceiling', (snapshot) => { snapshot.trials[0].ceilingUsd = 20; }],
    ['protected pricing', (snapshot) => { snapshot.policy.pricing.outputPerM = 0; }],
    ['reservation', (snapshot) => { snapshot.attempts[0].reservedUsd = 0.001; }],
    ['local cost', (snapshot) => { snapshot.attempts[0].usage.localCostUsd = 0; }],
    ['reconciled cost', (snapshot) => { snapshot.attempts[0].usage.reconciledCostUsd = 0.00001; }],
    ['actual cost', (snapshot) => { snapshot.attempts[0].actualCostUsd = 0.00001; }],
    ['unknown outcome', (snapshot) => { snapshot.attempts[0].outcome = 'operator-approved'; }],
    ['provider drift', (snapshot) => { snapshot.attempts[0].outcome = 'rejected-provider-drift'; }],
    ['cost overrun', (snapshot) => { snapshot.attempts[0].outcome = 'rejected-cost-overrun'; }],
    ['null dispatched usage', (snapshot) => { snapshot.attempts[0].usage = null; }],
    ['next sequence', (snapshot) => { snapshot.trials[0].nextSequence = 3; }],
    ['attempt sequence', (snapshot) => { snapshot.attempts[0].sequence = 2; }],
    ['attempt time', (snapshot) => { snapshot.attempts[0].completedAt = Date.parse('2026-08-04T16:00:08.000Z'); }],
    ['cached completeness', (snapshot) => {
      snapshot.attempts[0].usage.cachedTokensComplete = false;
    }],
    ['uncertain reserve', (snapshot) => {
      snapshot.trials[0].uncertainReservedUsd = 0.1;
      snapshot.trials[0].accountedExposureUsd = 0.1001;
      snapshot.trials[0].blocked = true;
      snapshot.session.uncertainReservedUsd = 0.1;
      snapshot.session.accountedExposureUsd = 0.1001;
      snapshot.session.blocked = true;
    }],
  ];
  for (const [name, mutate] of corruptions) {
    await t.test(name, async () => {
      await assert.rejects(reconcileSnapshot(mutateProviderSnapshot(mutate)), RuntimeEvidenceError);
    });
  }

  await t.test('protected policy projection cannot be replaced behind copied hashes', async () => {
    const policy = protectedBrokerPolicy();
    policy.pricing.outputPerM = 2;
    await assert.rejects(reconcileSnapshot(providerSnapshot(), { policy }), RuntimeEvidenceError);
  });
});

test('production task isolation collection fails closed until namespace receipt producers exist', async () => {
  const primitives = createNodeRuntimeEvidencePrimitives();
  await assert.rejects(primitives.inspectMounts({
    requestHash: HASH('1'),
    leaseHash: HASH('2'),
    workspace: '/engineer-bounded/work',
    handoff: handoff(),
  }), (error) => {
    assert.equal(error.code, 'ERR_RUNTIME_EVIDENCE_MISSING_TASK_MOUNT_RECEIPT');
    assert.match(error.message, /task mount namespace|receipt producer/i);
    return true;
  });
  await assert.rejects(primitives.inspectNetwork({
    requestHash: HASH('1'),
    leaseHash: HASH('2'),
    brokerSocket: '/run/engineer/provider/provider.sock',
    handoff: handoff(),
    maxOutputBytes: 64 * 1024,
  }), (error) => {
    assert.equal(error.code, 'ERR_RUNTIME_EVIDENCE_MISSING_TASK_ISOLATION_RECEIPT');
    assert.match(error.message, /network namespace|raw-socket|receipt producer/i);
    return true;
  });
});

test('production evidence collectors reject cgroup and authenticated broker reconciliation drift', async () => {
  const document = handoff();
  const common = {
    requestHash: HASH('1'),
    leaseHash: HASH('2'),
    brokerSocket: '/run/engineer/provider/provider.sock',
    brokerPolicy: '/engineer-bounded/broker/provider-policy.json',
    cgroup: '/sys/fs/cgroup/engineer/trial-1',
    handoff: document,
    maxOutputBytes: 64 * 1024,
  };
  const driftedCgroup = createNodeRuntimeEvidencePrimitives({
    system: {
      async observeCgroup() {
        return {
          real: true,
          id: 'trial-1',
          populated: false,
          processIds: [],
          cpuMax: '100000 100000',
          memoryMax: document.topology.memoryMax,
          memoryPeak: 1,
          pidsMax: document.topology.pidsMax,
          pidsPeak: 1,
          oomKills: 0,
          cpuUsageUsec: 1,
        };
      },
    },
  });
  await assert.rejects(driftedCgroup.inspectCgroup(common), RuntimeEvidenceError);

  const brokerDrift = createNodeRuntimeEvidencePrimitives({
    system: {
      async requestBrokerEvidence() {
        return { snapshotHash: HASH('c'), snapshot: { version: 1 } };
      },
      async attestBrokerPolicy() {
        return {
          policyHash: PROTECTED_POLICY_HASH,
          bindingPolicyHash: PROTECTED_BINDING_HASH,
          policy: structuredClone(PROTECTED_POLICY),
        };
      },
    },
  });
  await assert.rejects(brokerDrift.inspectProvider(common), RuntimeEvidenceError);
});
