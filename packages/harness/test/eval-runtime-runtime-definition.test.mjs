import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import * as runtimeDefinition from '../../../evals/runtime/runtime-definition.mjs';
import {
  RUNTIME_TOPOLOGY_RECEIPT_PATH,
  RUNTIME_TOPOLOGY_RECEIPT_SCHEMA,
  RuntimeDefinitionError,
  createRuntimeTopologyReceipt,
  loadCodeOwnedRuntimeDefinition,
  publishProvisionedRuntimeTopologyReceipt,
  removeProvisionedRuntimeTopologyReceipt,
} from '../../../evals/runtime/runtime-definition.mjs';
import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
  DAYTONA_NODE_RUNTIME_IMAGE,
  DAYTONA_NODE_RUNTIME_IMAGE_DIGEST,
  DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256,
} from '../../../evals/runtime/daytona-topology.mjs';
import { getProfile } from '../../../evals/lib/model-profiles.mjs';
import { controlledProviderBrokerStaticPolicyHash } from '../../../evals/runtime/controlled-provider-policy.mjs';
import { providerBrokerStaticPolicyHash } from '../../../evals/runtime/provider-broker.mjs';
import { buildSnapshotBuildManifest } from '../../../evals/runtime/snapshot-build-manifest.mjs';

const HASH = (character) => character.repeat(64);
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const MANIFEST_DIGEST = `sha256:${HASH('d')}`;
const IMMUTABLE_IMAGE = `alexgshaw/cobol-modernization@${MANIFEST_DIGEST}`;
const IMAGE_ID = `sha256:${HASH('e')}`;
const DAYTONA_METADATA = Object.freeze({
  DAYTONA_ORGANIZATION_ID: '123e4567-e89b-42d3-a456-426614174000',
  DAYTONA_OTEL_ENDPOINT: 'https://telemetry.invalid',
  DAYTONA_REGION_ID: 'us',
  DAYTONA_SANDBOX_ID: '8d2890a2-57ef-4d75-91d5-2b0a81256b89',
  DAYTONA_SANDBOX_SNAPSHOT: `ghcr.io/daytonaio/runtime@sha256:${HASH('a')}`,
  DAYTONA_SANDBOX_USER: 'root',
});

const EXECUTABLE_PATHS = Object.freeze({
  dockerd: '/usr/local/bin/dockerd',
  storageAllocator: '/opt/engineer/bin/busybox',
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
});

function snapshotArtifact() {
  const logicalHashes = Object.fromEntries(
    Object.keys(EXECUTABLE_PATHS).map((name, index) => [name, crypto.createHash('sha256')
      .update(`runtime-executable:${index}:${name}`)
      .digest('hex')])
  );
  const runtimeNames = Object.keys(EXECUTABLE_PATHS)
    .filter((name) => ![
      'cgroupExec', 'taskIsolationProbe', 'readinessDenialProbe',
    ].includes(name));
  const runtimeEntries = runtimeNames.map((name) => ({
    path: `runtime/${name}`,
    type: 'file',
    mode: 0o555,
    byteLength: 17,
    sha256: logicalHashes[name],
  }));
  const nativeEntries = [
    {
      path: 'native/engineer-cgroup-exec',
      type: 'file',
      mode: 0o555,
      byteLength: 19,
      sha256: logicalHashes.cgroupExec,
    },
    {
      path: 'native/engineer-task-isolation-probe',
      type: 'file',
      mode: 0o555,
      byteLength: 23,
      sha256: logicalHashes.taskIsolationProbe,
    },
    {
      path: 'native/engineer-readiness-denial-probe',
      type: 'file',
      mode: 0o555,
      byteLength: 24,
      sha256: logicalHashes.readinessDenialProbe,
    },
  ];
  const context = (kind, entries, character) => ({
    kind,
    encoding: 'ustar',
    byteLength: 1024,
    sha256: HASH(character),
    entries,
  });
  const executable = (name) => ({
    path: EXECUTABLE_PATHS[name],
    sha256: logicalHashes[name],
    context: ['cgroupExec', 'taskIsolationProbe', 'readinessDenialProbe'].includes(name)
      ? 'native' : 'runtime',
    sourcePath: name === 'cgroupExec' ? nativeEntries[0].path
      : name === 'taskIsolationProbe' ? nativeEntries[1].path
        : name === 'readinessDenialProbe' ? nativeEntries[2].path : `runtime/${name}`,
  });
  const budgetPolicyHash = HASH('f');
  const brokerPolicyHash = controlledProviderBrokerStaticPolicyHash({
    profileId: 'kimi-k2.7-code',
    sessionCeilingMicrousd: 1_300_000,
  });
  const artifact = buildSnapshotBuildManifest({
    dockerfile: { byteLength: 100, sha256: HASH('1') },
    definition: { byteLength: 101, sha256: HASH('2') },
    contexts: {
      runtime: context('runtime', runtimeEntries, '3'),
      harbor: context('harbor', [{
        path: 'harbor/closure', type: 'file', mode: 0o444, byteLength: 1, sha256: HASH('4'),
      }], '4'),
      node: context('node', [{
        path: 'node/closure', type: 'file', mode: 0o444, byteLength: 1, sha256: HASH('5'),
      }], '5'),
      native: context('native', nativeEntries, '6'),
    },
    executables: {
      ...Object.fromEntries(Object.keys(EXECUTABLE_PATHS).map((name) => [name, executable(name)])),
      snapshotSelfTest: {
        path: '/opt/engineer/bin/engineer-snapshot-selftest',
        sha256: logicalHashes.supervisor,
        context: 'runtime',
        sourcePath: 'runtime/supervisor',
      },
    },
    provenance: {
      baseImage: { reference: DAYTONA_DIND_BASE_IMAGE, digest: DAYTONA_DIND_BASE_IMAGE_DIGEST },
      harbor: {
        version: 'v0.20.0',
        commit: '459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc',
        lockSha256: HASH('7'),
      },
      node: {
        version: 'v22.17.1',
        platform: 'linux/amd64-musl',
        runtimeImage: DAYTONA_NODE_RUNTIME_IMAGE,
        runtimeImageDigest: DAYTONA_NODE_RUNTIME_IMAGE_DIGEST,
        binarySha256: DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256.node,
      },
      nativeHelper: {
        sourceSha256: HASH('9'),
        compilerImage: `gcc:14.2.0-bookworm@sha256:${HASH('a')}`,
        compilerImageDigest: `sha256:${HASH('a')}`,
        binarySha256: logicalHashes.cgroupExec,
      },
      taskIsolationProbe: {
        sourceSha256: HASH('b'),
        compilerImage: `gcc:14.2.0-bookworm@sha256:${HASH('a')}`,
        compilerImageDigest: `sha256:${HASH('a')}`,
        binarySha256: logicalHashes.taskIsolationProbe,
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-task-isolation-probe',
      },
      readinessDenialProbe: {
        sourceSha256: HASH('d'),
        compilerImage: `gcc:14.2.0-bookworm@sha256:${HASH('a')}`,
        compilerImageDigest: `sha256:${HASH('a')}`,
        binarySha256: logicalHashes.readinessDenialProbe,
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-readiness-denial-probe',
      },
    },
    bindings: {
      releaseSha: 'b'.repeat(40),
      taskLockHash: HASH('c'),
      bundleHash: HASH('e'),
      budgetPolicyHash,
      brokerPolicyHash,
      profileId: 'kimi-k2.7-code',
      sessionCeilingMicrousd: 1_300_000,
    },
    taskImages: {
      'cobol-modernization': {
        immutableImage: IMMUTABLE_IMAGE,
        imageId: IMAGE_ID,
        platform: 'linux/amd64',
        cpus: 1,
        memoryMb: 2048,
        storageMb: 10240,
      },
    },
  });
  return { ...artifact, logicalHashes };
}

function request() {
  return {
    sandboxId: 'sandbox-bounded-1',
    immutableImage: IMMUTABLE_IMAGE,
    imageId: IMAGE_ID,
    platform: 'linux/amd64',
  };
}

function preload() {
  return {
    sandboxId: request().sandboxId,
    immutableImage: IMMUTABLE_IMAGE,
    imageId: IMAGE_ID,
    platform: 'linux/amd64',
    pullReceiptHash: HASH('1'),
    inspectReceiptHash: HASH('2'),
    markerSha256: HASH('3'),
  };
}

function observation(artifact = snapshotArtifact()) {
  return {
    platform: 'linux',
    effectiveUid: 0,
    sandboxBootId: '50f04de7-675a-4a71-9af0-1e552eed5192',
    daemonId: 'YQWT:WMR6:ZTQG:ZXKO:4HIY:SQ3M:ZOOB:2RVI:HVYP:DI7T:BAJ6:JXZS',
    filesystem: {
      boundedRootId: 'dev:51',
      boundedRootBytes: TEN_GIB,
      defaultDockerRootId: 'dev:52',
    },
    executableHashes: structuredClone(artifact.logicalHashes),
    preloadMarkerSha256: preload().markerSha256,
    cgroupV2: true,
    cgroupKillAvailable: true,
    providerCredentialsAbsent: true,
    daytonaCredentialsAbsent: true,
  };
}

function memoryStore(overrides = {}) {
  let retained = null;
  let consumed = false;
  const attestation = (bytes, drift = {}) => ({
    path: RUNTIME_TOPOLOGY_RECEIPT_PATH,
    kind: 'regular-file',
    real: true,
    symlink: false,
    ownerUid: 0,
    ownerGid: 0,
    mode: 0o600,
    byteLength: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    ...drift,
  });
  return {
    async publish({ bytes }) {
      if (retained) throw new Error('receipt already exists');
      retained = Buffer.from(bytes);
      consumed = false;
      return attestation(retained, overrides.publishAttestation);
    },
    async consume() {
      if (!retained || consumed) throw new Error('receipt is absent');
      consumed = true;
      const bytes = Buffer.from(retained);
      retained.fill(0);
      retained = null;
      if (overrides.mutateBytes) overrides.mutateBytes(bytes);
      return { bytes, attestation: attestation(bytes, overrides.attestation) };
    },
    async remove() {
      retained?.fill(0);
      retained = null;
      return { path: RUNTIME_TOPOLOGY_RECEIPT_PATH, absent: true };
    },
    present: () => retained != null,
  };
}

function dependencies(artifact, store, observed = observation(artifact)) {
  return {
    loadBuildManifest: async () => artifact.manifest,
    observeRuntime: async () => structuredClone(observed),
    receiptStore: store,
  };
}

test('runtime environment evidence scrubs Daytona metadata before strict credential checks', () => {
  const environment = { PATH: '/usr/bin', ...DAYTONA_METADATA };
  const original = structuredClone(environment);
  const evidence = runtimeDefinition.runtimeEnvironmentCredentialEvidence(environment);

  assert.deepEqual(evidence, {
    providerCredentialsAbsent: true,
    daytonaCredentialsAbsent: true,
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.deepEqual(environment, original, 'runtime environment observation does not mutate its input');

  for (const rejected of [
    { DAYTONA_UNKNOWN: 'unknown-platform-authority' },
    { OPENROUTER_API_KEY: 'provider-key' },
    { INNOCENT_NAME: 'sk-or-v1-provider-key' },
    { DAYTONA_SANDBOX_ID: 'contains\0nul' },
  ]) {
    assert.throws(
      () => runtimeDefinition.runtimeEnvironmentCredentialEvidence(rejected),
      (error) => error instanceof RuntimeDefinitionError
        && error.code === 'ERR_RUNTIME_DEFINITION_ENVIRONMENT'
        && !error.message.includes('provider-key'),
    );
  }
});

test('trusted provisioner publishes one canonical fixed-path receipt and direct loader consumes it once', async () => {
  const artifact = snapshotArtifact();
  const store = memoryStore();
  const deps = dependencies(artifact, store);
  const published = await publishProvisionedRuntimeTopologyReceipt({
    request: request(),
    preload: preload(),
    dependencies: deps,
  });
  assert.equal(published.path, RUNTIME_TOPOLOGY_RECEIPT_PATH);
  assert.equal(published.mode, 0o600);
  assert.equal(published.ownerUid, 0);
  assert.match(published.receiptNonce, /^[a-f0-9]{64}$/);
  assert.equal(store.present(), true);

  const definition = await loadCodeOwnedRuntimeDefinition({ dependencies: deps });
  assert.equal(store.present(), false, 'loading atomically consumes the fixed receipt');
  assert.equal(definition.topology.sandboxId, request().sandboxId);
  assert.equal(definition.topology.sandboxBootId, observation(artifact).sandboxBootId);
  assert.equal(definition.topology.daemonId, observation(artifact).daemonId);
  assert.equal(definition.topology.imageDigest, IMAGE_ID);
  assert.equal(Object.hasOwn(definition.topology, 'controlChannelAuthenticated'), false);
  assert.equal(Object.hasOwn(definition.topology, 'controlChannelReceipt'), false);
  assert.equal(definition.topology.hashes.supervisor, artifact.logicalHashes.supervisor);
  assert.equal(definition.topology.executables.taskIsolationProbe,
    '/opt/engineer/bin/engineer-task-isolation-probe');
  assert.equal(definition.topology.hashes.taskIsolationProbe,
    artifact.logicalHashes.taskIsolationProbe);
  assert.equal(definition.topology.cgroup.memoryMax, 2048 * 1024 * 1024);
  assert.equal(typeof definition.buildDockerPolicy, 'function');
  assert.equal(typeof definition.buildBrokerPolicy, 'function');

  await assert.rejects(
    loadCodeOwnedRuntimeDefinition({ dependencies: deps }),
    (error) => error instanceof RuntimeDefinitionError && error.code === 'ERR_RUNTIME_DEFINITION_RECEIPT'
  );
});

test('code-owned policy builders bind the exact trial contract and pinned OpenRouter profile', async () => {
  const artifact = snapshotArtifact();
  const store = memoryStore();
  const deps = dependencies(artifact, store);
  await publishProvisionedRuntimeTopologyReceipt({ request: request(), preload: preload(), dependencies: deps });
  const definition = await loadCodeOwnedRuntimeDefinition({ dependencies: deps });
  const context = {
    sessionId: 'session-1',
    trialId: 'trial-1',
    allocationId: request().sandboxId,
    request: {
      trialId: 'trial-1',
      sequence: 9,
      executionMode: 'controlled-provider',
      bindings: {
        sandboxId: request().sandboxId,
        imageDigest: IMAGE_ID,
        condition: 'generic',
        budgetPolicyHash: artifact.manifest.bindings.budgetPolicyHash,
        brokerPolicyHash: artifact.manifest.bindings.brokerPolicyHash,
      },
      budget: {
        trialCeilingMicrousd: 650_000,
        sessionCeilingMicrousd: 1_300_000,
      },
    },
  };
  const docker = definition.buildDockerPolicy(context);
  assert.equal(docker.pinnedImage, IMMUTABLE_IMAGE);
  assert.equal(docker.resources.nanoCpus, 1_000_000_000);
  assert.equal(docker.resources.memoryBytes, 2048 * 1024 * 1024);
  assert.equal(docker.resources.pidsLimit, 256);
  assert.deepEqual(docker.allowedArchivePaths, ['/app', '/tests', '/tmp']);
  assert.equal(docker.allowedBindSets.length, 3);
  assert.ok(docker.allowedBindSets.every((binds) =>
    binds.every((bind) => !bind.includes('/opt/harness-bundle/harness'))));
  assert.ok(docker.allowedBindSets.every((binds) =>
    binds.some((bind) => bind.endsWith('/opt/eval-runtime/evidence-probe:ro'))));
  assert.equal(docker.requireReadOnlyRootfs, true);
  assert.equal(docker.containerName.endsWith('-main-1'), true);

  const broker = definition.buildBrokerPolicy(context);
  const profile = getProfile('kimi-k2.7-code');
  assert.equal(broker.endpoint, profile.url);
  assert.equal(broker.model, profile.model);
  assert.deepEqual(broker.provider, profile.provider);
  assert.deepEqual(broker.pricing, profile.pricing);
  assert.equal(broker.sessionCeilingUsd, 1.3);
  assert.deepEqual(broker.trials, [{
    leaseId: docker.leaseId,
    leaseDigest: HASH('0'),
    trialId: 'trial-1',
    leaseSequence: 10,
    ceilingUsd: 0.65,
  }]);
  assert.notEqual(artifact.manifest.bindings.budgetPolicyHash, artifact.manifest.bindings.brokerPolicyHash);
  assert.equal(providerBrokerStaticPolicyHash(broker), artifact.manifest.bindings.brokerPolicyHash);
  assert.throws(() => definition.buildBrokerPolicy({
    ...context,
    request: {
      ...context.request,
      bindings: { ...context.request.bindings, brokerPolicyHash: HASH('0') },
    },
  }), /policy context.*drift/i);

  const zeroContext = {
    ...context,
    request: {
      ...context.request,
      executionMode: 'zero-provider-canary',
      budget: {
        trialCeilingMicrousd: 0,
        sessionCeilingMicrousd: 0,
        sessionCommittedMicrousd: 0,
      },
    },
  };
  const zeroDocker = definition.buildDockerPolicy(zeroContext);
  assert.equal(zeroDocker.pinnedImage, IMMUTABLE_IMAGE);
  assert.throws(
    () => definition.buildBrokerPolicy(zeroContext),
    /zero-provider|broker|not authorized/i,
  );
  for (const drift of [
    { executionMode: 'unknown-mode' },
    {
      executionMode: 'zero-provider-canary',
      budget: { trialCeilingMicrousd: 1, sessionCeilingMicrousd: 0, sessionCommittedMicrousd: 0 },
    },
    {
      executionMode: 'controlled-provider',
      budget: { trialCeilingMicrousd: 0, sessionCeilingMicrousd: 0, sessionCommittedMicrousd: 0 },
    },
  ]) {
    assert.throws(
      () => definition.buildDockerPolicy({
        ...context,
        request: { ...context.request, ...drift },
      }),
      /execution mode|zero-provider|policy context|ceiling/i,
    );
  }
});

test('receipt creation rejects ambiguous task identity and runtime observation drift', () => {
  const artifact = snapshotArtifact();
  const observed = observation(artifact);
  for (const mutation of [
    { request: { ...request(), sandboxId: '../escape' } },
    { request: { ...request(), imageId: `sha256:${HASH('0')}` } },
    { observed: { ...observed, platform: 'darwin' } },
    { observed: { ...observed, effectiveUid: 2001 } },
    { observed: { ...observed, sandboxBootId: 'not-a-boot-id' } },
    { observed: { ...observed, filesystem: { ...observed.filesystem, boundedRootBytes: TEN_GIB - 1 } } },
    { observed: { ...observed, executableHashes: { ...observed.executableHashes, runner: HASH('0') } } },
    { observed: { ...observed, preloadMarkerSha256: HASH('0') } },
    { observed: { ...observed, providerCredentialsAbsent: false } },
  ]) {
    assert.throws(
      () => createRuntimeTopologyReceipt({
        request: mutation.request ?? request(),
        preload: preload(),
        buildManifest: artifact.manifest,
        observation: mutation.observed ?? observed,
      }),
      /identity|runtime|root|filesystem|executable|marker|credential|sandbox|image/i
    );
  }
});

test('loader rejects receipt tamper, oversized content, custody drift, and build/runtime identity drift', async () => {
  const cases = [
    {
      name: 'byte tamper',
      store: memoryStore({ mutateBytes: (bytes) => { bytes[10] ^= 1; } }),
      expected: /digest|canonical|receipt/i,
    },
    {
      name: 'wrong owner',
      store: memoryStore({ attestation: { ownerUid: 2001 } }),
      expected: /custody|owner|receipt/i,
    },
    {
      name: 'wrong mode',
      store: memoryStore({ attestation: { mode: 0o644 } }),
      expected: /custody|mode|receipt/i,
    },
    {
      name: 'symlink',
      store: memoryStore({ attestation: { real: false, symlink: true } }),
      expected: /custody|symlink|receipt/i,
    },
    {
      name: 'oversized',
      store: memoryStore({ attestation: { byteLength: 1024 * 1024 } }),
      expected: /size|bound|receipt/i,
    },
  ];
  for (const current of cases) {
    const artifact = snapshotArtifact();
    const deps = dependencies(artifact, current.store);
    await publishProvisionedRuntimeTopologyReceipt({ request: request(), preload: preload(), dependencies: deps });
    await assert.rejects(
      loadCodeOwnedRuntimeDefinition({ dependencies: deps }),
      current.expected,
      current.name
    );
  }

  const artifact = snapshotArtifact();
  const store = memoryStore();
  const publishedDeps = dependencies(artifact, store);
  await publishProvisionedRuntimeTopologyReceipt({
    request: request(), preload: preload(), dependencies: publishedDeps,
  });
  const driftedArtifact = snapshotArtifact();
  const drifted = {
    ...driftedArtifact,
    manifest: structuredClone(driftedArtifact.manifest),
  };
  drifted.manifest.bindings = {
    ...drifted.manifest.bindings,
    releaseSha: 'f'.repeat(40),
  };
  await assert.rejects(
    loadCodeOwnedRuntimeDefinition({ dependencies: dependencies(drifted, store, observation(artifact)) }),
    /manifest|build|identity|receipt/i
  );
});

test('trusted cleanup removes only the fixed receipt and attests absence', async () => {
  const artifact = snapshotArtifact();
  const store = memoryStore();
  const deps = dependencies(artifact, store);
  await publishProvisionedRuntimeTopologyReceipt({ request: request(), preload: preload(), dependencies: deps });
  assert.equal(store.present(), true);
  assert.deepEqual(await removeProvisionedRuntimeTopologyReceipt({ dependencies: deps }), {
    path: RUNTIME_TOPOLOGY_RECEIPT_PATH,
    absent: true,
  });
  assert.equal(store.present(), false);
});

test('receipt schema is explicit, canonical, bounded, secret-free, and binds preload evidence', () => {
  const artifact = snapshotArtifact();
  const built = createRuntimeTopologyReceipt({
    request: request(),
    preload: preload(),
    buildManifest: artifact.manifest,
    observation: observation(artifact),
  });
  assert.equal(built.receipt.schema, RUNTIME_TOPOLOGY_RECEIPT_SCHEMA);
  assert.equal(built.receipt.preload.markerSha256, preload().markerSha256);
  assert.equal(Object.hasOwn(built.receipt.topology, 'controlChannelAuthenticated'), false);
  assert.equal(Object.hasOwn(built.receipt.topology, 'controlChannelReceipt'), false);
  const rebuilt = createRuntimeTopologyReceipt({
    request: request(),
    preload: preload(),
    buildManifest: artifact.manifest,
    observation: observation(artifact),
  });
  assert.equal(built.canonicalJson, rebuilt.canonicalJson);
  assert.equal(Buffer.byteLength(built.canonicalJson) < 64 * 1024, true);
  assert.equal(/Bearer\s+|sk-(?:or|ant|proj)-|github_pat_|gh[pousr]_|xox[baprs]-|hf_[A-Za-z0-9]/i
    .test(built.canonicalJson), false);
  assert.equal(built.sha256, crypto.createHash('sha256').update(built.canonicalJson).digest('hex'));
});
