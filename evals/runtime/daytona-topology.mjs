import crypto from 'node:crypto';

export const DAYTONA_TOPOLOGY_SCHEMA = 'engineer-daytona-topology-manifest.v1';
export const DAYTONA_RELEASE_RUNTIME_PROJECTION_SCHEMA = 'engineer-daytona-release-runtime-projection.v1';
export const DAYTONA_DIND_BASE_IMAGE_DIGEST =
  'sha256:a56b3bdde89315ed2cc0e4906e582b5033d93bf20d9cb9510c2cdd4e7f7690b1';
export const DAYTONA_DIND_BASE_IMAGE = `docker:28.3.3-dind@${DAYTONA_DIND_BASE_IMAGE_DIGEST}`;
export const DAYTONA_NODE_RUNTIME_IMAGE_DIGEST =
  'sha256:99351363debf40f3495cb7fc657a777334c3b21143e594dbfcc7de187439633c';
export const DAYTONA_NODE_RUNTIME_IMAGE =
  `node:22.17.1-alpine3.22@${DAYTONA_NODE_RUNTIME_IMAGE_DIGEST}`;
export const DAYTONA_DIND_EXECUTABLE_SHA256 = Object.freeze({
  dockerd: '8d43fc3a858b949fc4e333b1b1d56ffbf579e74fe6ac866b662899f27a6ea74f',
  docker: 'c6a20cf0d5cd2e0efc6dce3aaa9cbd9cd7ef2a98f32aac3bfa7ff976577fab18',
});
export const DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256 = Object.freeze({
  node: '53084676a6082c4a3141ec97a4950decc351c0295c3a83acc04a4a397df35c74',
  ...DAYTONA_DIND_EXECUTABLE_SHA256,
});
export const DAYTONA_NODE_USTAR_ATTESTATION = Object.freeze({
  kind: 'node',
  archiveSha256: 'b97bf72a7b32b94de07503b83a24dac3a819994778bd9c8f4365b17eef1e55e5',
  byteLength: 127_067_136,
  entries: Object.freeze([
    Object.freeze({
      path: 'usr/lib/libgcc_s.so.1',
      type: 'file',
      mode: 0o444,
      byteLength: 173_920,
      sha256: '0cd532bd6739a5419c5a14e8897ad4e9de0df77c9f4e8e6ba202e369a8c8b4e5',
    }),
    Object.freeze({
      path: 'usr/lib/libstdc++.so.6',
      type: 'file',
      mode: 0o444,
      byteLength: 2_771_336,
      sha256: '5d72f927924ae6b0b27febbab7598e0684b3cce9b377ef93315be96e11812f3a',
    }),
    Object.freeze({
      path: 'usr/local/bin/node',
      type: 'file',
      mode: 0o555,
      byteLength: 124_118_992,
      sha256: DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256.node,
    }),
  ]),
});

const TEN_GIB = 10 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;
const RELEASE_SHA = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const RESERVED_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CREDENTIAL_MATERIAL = /(?:Bearer\s+|sk-(?:or|ant|proj)-|github_pat_|ghp_|xox[baprs]-|hf_[A-Za-z0-9])/i;

const BUILD_INPUT_FIELDS = Object.freeze([
  'releaseSha',
  'taskLockHash',
  'bundleHash',
  'budgetPolicyHash',
  'brokerPolicyHash',
  'profileId',
  'sessionCeilingMicrousd',
  'snapshotIdentity',
  'taskImages',
  'executableHashes',
]);

const BINDING_FIELDS = Object.freeze([
  'releaseSha',
  'taskLockHash',
  'bundleHash',
  'budgetPolicyHash',
  'brokerPolicyHash',
  'profileId',
  'sessionCeilingMicrousd',
]);

export const DAYTONA_EXECUTABLE_PATHS = Object.freeze({
  node: '/usr/local/bin/node',
  supervisor: '/opt/engineer/bin/engineer-runtime-supervisor',
  archiveBridge: '/opt/engineer/bin/engineer-archive-bridge',
  runner: '/opt/engineer/bin/engineer-eval-runner',
  harbor: '/opt/engineer/bin/harbor',
  providerBroker: '/opt/engineer/bin/engineer-provider-broker',
  readinessProbe: '/opt/engineer/bin/engineer-runtime-probe',
  evidenceCollector: '/opt/engineer/bin/engineer-runtime-evidence',
  cgroupExec: '/opt/engineer/bin/engineer-cgroup-exec',
  taskIsolationProbe: '/opt/engineer/bin/engineer-task-isolation-probe',
  readinessDenialProbe: '/opt/engineer/bin/engineer-readiness-denial-probe',
  imageProvisioner: '/opt/engineer/bin/engineer-task-image-provision',
  snapshotSelfTest: '/opt/engineer/bin/engineer-snapshot-selftest',
  dockerd: '/usr/local/bin/dockerd',
  docker: '/usr/local/bin/docker',
  iptables: '/usr/sbin/iptables',
  ip6tables: '/usr/sbin/ip6tables',
  sentinel: '/usr/bin/sleep',
});
const EXECUTABLE_PATHS = DAYTONA_EXECUTABLE_PATHS;

const FIXED_PATHS = Object.freeze({
  boundedRoot: '/engineer-bounded',
  runtimeDirectory: '/run/engineer',
  transportDirectory: '/engineer-bounded/transport',
  inputArchive: '/engineer-bounded/transport/task-input.tar',
  outputArchive: '/engineer-bounded/transport/trial-output.tar',
  workspace: '/engineer-bounded/work',
  evidenceDirectory: '/engineer-bounded/evidence',
  brokerPolicyDirectory: '/engineer-bounded/broker',
  brokerPolicy: '/engineer-bounded/broker/provider-policy.json',
});

export class DaytonaTopologyError extends Error {
  constructor(message, code = 'ERR_DAYTONA_TOPOLOGY') {
    super(message);
    this.name = 'DaytonaTopologyError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new DaytonaTopologyError(message, code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`, 'ERR_DAYTONA_TOPOLOGY_SCHEMA');
  const permitted = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      fail(`${label} contains unexpected field ${key}`, 'ERR_DAYTONA_TOPOLOGY_SCHEMA');
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${label} is missing required field ${key}`, 'ERR_DAYTONA_TOPOLOGY_SCHEMA');
    }
  }
}

function exactValue(actual, expected, label) {
  if (actual !== expected) fail(`${label} drifted from the approved topology`, 'ERR_DAYTONA_TOPOLOGY_DRIFT');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isSafeInteger(value))) {
    return JSON.stringify(value);
  }
  fail('manifest contains a non-canonical JSON value', 'ERR_DAYTONA_TOPOLOGY_SCHEMA');
}

function canonicalClone(value) {
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_MANIFEST_BYTES) {
    fail('manifest exceeds its canonical byte bound', 'ERR_DAYTONA_TOPOLOGY_BOUND');
  }
  return { value: JSON.parse(encoded), encoded };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hash`, 'ERR_DAYTONA_TOPOLOGY_HASH');
  }
}

function assertImageId(value, label) {
  if (typeof value !== 'string' || !IMAGE_ID.test(value)) {
    fail(`${label} must be an exact sha256 Docker image ID`, 'ERR_DAYTONA_TOPOLOGY_HASH');
  }
}

function assertSnapshotIdentity(value, label) {
  exactKeys(value, ['name', 'buildHash'], label);
  assertHash(value.buildHash, `${label}.buildHash`);
  const expectedName = `engineer-eval-${value.buildHash.slice(0, 32)}`;
  if (value.name !== expectedName) {
    fail(`${label}.name must be derived from its build hash`, 'ERR_DAYTONA_TOPOLOGY_HASH');
  }
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || Buffer.byteLength(value, 'utf8') > 192) {
    fail(`${label} must be a bounded safe identifier`, 'ERR_DAYTONA_TOPOLOGY_SCHEMA');
  }
  if (CREDENTIAL_MATERIAL.test(value)) {
    fail(`${label} resembles credential material`, 'ERR_DAYTONA_TOPOLOGY_SECRET');
  }
}

function assertBindings(value, label = 'manifest.bindings') {
  exactKeys(value, BINDING_FIELDS, label);
  if (typeof value.releaseSha !== 'string' || !RELEASE_SHA.test(value.releaseSha)) {
    fail(`${label}.releaseSha must be a lowercase 40-64 character commit hash`, 'ERR_DAYTONA_TOPOLOGY_HASH');
  }
  assertHash(value.taskLockHash, `${label}.taskLockHash`);
  assertHash(value.bundleHash, `${label}.bundleHash`);
  assertHash(value.budgetPolicyHash, `${label}.budgetPolicyHash`);
  assertHash(value.brokerPolicyHash, `${label}.brokerPolicyHash`);
  assertSafeId(value.profileId, `${label}.profileId`);
  if (!Number.isSafeInteger(value.sessionCeilingMicrousd)
      || value.sessionCeilingMicrousd < 1
      || value.sessionCeilingMicrousd > 20_000_000) {
    fail(`${label}.sessionCeilingMicrousd must be between 1 and 20000000`, 'ERR_DAYTONA_TOPOLOGY_BUDGET');
  }
}

function assertTaskImages(value, label) {
  if (!plainObject(value)) fail(`${label} must be a task image map`, 'ERR_DAYTONA_TOPOLOGY_SCHEMA');
  const taskIds = Object.keys(value);
  if (taskIds.length < 1 || taskIds.length > 64) {
    fail(`${label} must contain 1-64 locked task images`, 'ERR_DAYTONA_TOPOLOGY_BOUND');
  }
  for (const taskId of taskIds) {
    assertSafeId(taskId, `${label} taskId`);
    if (RESERVED_MAP_KEYS.has(taskId)) {
      fail(`${label} contains a reserved taskId`, 'ERR_DAYTONA_TOPOLOGY_SCHEMA');
    }
    const taskImage = value[taskId];
    exactKeys(taskImage, [
      'immutableImage',
      'imageId',
      'platform',
      'cpus',
      'memoryMb',
      'storageMb',
    ], `${label}.${taskId}`);
    if (typeof taskImage.immutableImage !== 'string' || !IMMUTABLE_IMAGE.test(taskImage.immutableImage)) {
      fail(`${label}.${taskId}.immutableImage must be an immutable repository@sha256 digest`,
        'ERR_DAYTONA_TOPOLOGY_HASH');
    }
    assertImageId(taskImage.imageId, `${label}.${taskId}.imageId`);
    exactValue(taskImage.platform, 'linux/amd64', `${label}.${taskId}.platform`);
    if (!Number.isSafeInteger(taskImage.cpus) || taskImage.cpus < 1 || taskImage.cpus > 2) {
      fail(`${label}.${taskId}.cpus must be between 1 and 2`, 'ERR_DAYTONA_TOPOLOGY_BOUND');
    }
    if (!Number.isSafeInteger(taskImage.memoryMb)
        || taskImage.memoryMb < 256
        || taskImage.memoryMb > 4096) {
      fail(`${label}.${taskId}.memoryMb must be between 256 and 4096`, 'ERR_DAYTONA_TOPOLOGY_BOUND');
    }
    if (!Number.isSafeInteger(taskImage.storageMb)
        || taskImage.storageMb < 256
        || taskImage.storageMb > 10240) {
      fail(`${label}.${taskId}.storageMb must be between 256 and 10240`, 'ERR_DAYTONA_TOPOLOGY_BOUND');
    }
  }
}

function assertExecutableMap(value) {
  exactKeys(value, Object.keys(EXECUTABLE_PATHS), 'manifest.executables');
  for (const [name, approvedPath] of Object.entries(EXECUTABLE_PATHS)) {
    exactKeys(value[name], ['path', 'sha256'], `manifest.executables.${name}`);
    exactValue(value[name].path, approvedPath, `manifest.executables.${name}.path`);
    assertHash(value[name].sha256, `manifest.executables.${name}.sha256`);
  }
}

function assertFixedObject(value, expected, label) {
  exactKeys(value, Object.keys(expected), label);
  for (const [key, approved] of Object.entries(expected)) exactValue(value[key], approved, `${label}.${key}`);
}

function assertExpectedBindings(actual, expected) {
  if (expected == null) return;
  assertBindings(expected, 'expected bindings');
  for (const field of BINDING_FIELDS) {
    if (actual[field] !== expected[field]) {
      fail(`manifest binding ${field} does not match the expected binding`, 'ERR_DAYTONA_TOPOLOGY_BINDING');
    }
  }
}

/**
 * Validate a persisted topology manifest without trusting its insertion order,
 * prototype, or any caller-supplied topology constants.
 */
export function validateDaytonaTopologyManifest(input, { expectedBindings = null } = {}) {
  exactKeys(input, [
    'schema',
    'manifestVersion',
    'daytona',
    'execution',
    'identities',
    'docker',
    'paths',
    'executables',
    'snapshot',
    'bindings',
  ], 'Daytona topology manifest');
  exactValue(input.schema, DAYTONA_TOPOLOGY_SCHEMA, 'manifest.schema');
  exactValue(input.manifestVersion, 1, 'manifest.manifestVersion');

  assertFixedObject(input.daytona, {
    cliVersion: 'v0.203.0',
    sandboxClass: 'container',
    rootDiskBytes: TEN_GIB,
    public: false,
    environment: 'empty',
    volumes: 'empty',
  }, 'manifest.daytona');

  assertFixedObject(input.execution, {
    freshSandboxPerPaidTrial: true,
    sandboxReuse: false,
    maxConcurrentPaidTrials: 1,
    maxActiveTaskContainers: 1,
    taskNetworkMode: 'none',
  }, 'manifest.execution');

  assertFixedObject(input.identities, {
    supervisorUid: 0,
    runnerUid: 2001,
    runnerGid: 2001,
    brokerUid: 2002,
    brokerGid: 2002,
    sharedBrokerClientGid: 2003,
  }, 'manifest.identities');

  exactKeys(input.docker, [
    'privateDaemon',
    'dataRoot',
    'forbiddenDataRoots',
    'daemonSocket',
    'proxySocket',
    'hostSocketMountAllowed',
  ], 'manifest.docker');
  exactValue(input.docker.privateDaemon, true, 'manifest.docker.privateDaemon');
  exactValue(input.docker.dataRoot, '/engineer-bounded/docker', 'manifest.docker.dataRoot');
  if (!Array.isArray(input.docker.forbiddenDataRoots)
      || input.docker.forbiddenDataRoots.length !== 1
      || input.docker.forbiddenDataRoots[0] !== '/var/lib/docker') {
    fail('manifest.docker.forbiddenDataRoots must explicitly forbid /var/lib/docker', 'ERR_DAYTONA_TOPOLOGY_DRIFT');
  }
  exactValue(input.docker.daemonSocket, '/run/engineer/private-docker.sock', 'manifest.docker.daemonSocket');
  exactValue(input.docker.proxySocket, '/run/engineer/harbor-docker.sock', 'manifest.docker.proxySocket');
  exactValue(input.docker.hostSocketMountAllowed, false, 'manifest.docker.hostSocketMountAllowed');

  assertFixedObject(input.paths, FIXED_PATHS, 'manifest.paths');
  assertExecutableMap(input.executables);

  exactKeys(input.snapshot, ['identity', 'baseImage', 'taskImages', 'harbor', 'nodeProtection'], 'manifest.snapshot');
  assertSnapshotIdentity(input.snapshot.identity, 'manifest.snapshot.identity');
  assertFixedObject(input.snapshot.baseImage, {
    reference: DAYTONA_DIND_BASE_IMAGE,
    digest: DAYTONA_DIND_BASE_IMAGE_DIGEST,
  }, 'manifest.snapshot.baseImage');
  assertTaskImages(input.snapshot.taskImages, 'manifest.snapshot.taskImages');
  assertFixedObject(input.snapshot.harbor, {
    version: 'v0.20.0',
    commit: '459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc',
  }, 'manifest.snapshot.harbor');
  assertFixedObject(input.snapshot.nodeProtection, {
    path: '/usr/local/bin/node',
    kind: 'regular-file',
    symlinkAllowed: false,
    ownerUid: 0,
    executable: true,
    groupOrOtherWritable: false,
  }, 'manifest.snapshot.nodeProtection');
  if (input.executables.node.path !== input.snapshot.nodeProtection.path) {
    fail('Node executable path drifted from its protected regular-file policy', 'ERR_DAYTONA_TOPOLOGY_DRIFT');
  }

  assertBindings(input.bindings);
  assertExpectedBindings(input.bindings, expectedBindings);
  const cloned = canonicalClone(input).value;
  return deepFreeze(cloned);
}

/** Build and attest the immutable snapshot specification used by one release. */
export function buildDaytonaTopologyManifest(input = {}) {
  exactKeys(input, BUILD_INPUT_FIELDS, 'Daytona topology build input');
  if (typeof input.releaseSha !== 'string' || !RELEASE_SHA.test(input.releaseSha)) {
    fail('releaseSha must be a lowercase 40-64 character commit hash', 'ERR_DAYTONA_TOPOLOGY_HASH');
  }
  assertHash(input.taskLockHash, 'taskLockHash');
  assertHash(input.bundleHash, 'bundleHash');
  assertHash(input.budgetPolicyHash, 'budgetPolicyHash');
  assertHash(input.brokerPolicyHash, 'brokerPolicyHash');
  assertSafeId(input.profileId, 'profileId');
  assertSnapshotIdentity(input.snapshotIdentity, 'snapshotIdentity');
  if (!Number.isSafeInteger(input.sessionCeilingMicrousd)
      || input.sessionCeilingMicrousd < 1
      || input.sessionCeilingMicrousd > 20_000_000) {
    fail('sessionCeilingMicrousd must be between 1 and 20000000', 'ERR_DAYTONA_TOPOLOGY_BUDGET');
  }
  assertTaskImages(input.taskImages, 'taskImages');
  exactKeys(input.executableHashes, Object.keys(EXECUTABLE_PATHS), 'executableHashes');
  for (const [name, value] of Object.entries(input.executableHashes)) assertHash(value, `executableHashes.${name}`);

  const taskImages = Object.fromEntries(
    Object.keys(input.taskImages).sort().map((taskId) => [taskId, input.taskImages[taskId]])
  );
  const executables = Object.fromEntries(Object.entries(EXECUTABLE_PATHS).map(([name, executablePath]) => [
    name,
    { path: executablePath, sha256: input.executableHashes[name] },
  ]));
  const manifest = validateDaytonaTopologyManifest({
    schema: DAYTONA_TOPOLOGY_SCHEMA,
    manifestVersion: 1,
    daytona: {
      cliVersion: 'v0.203.0',
      sandboxClass: 'container',
      rootDiskBytes: TEN_GIB,
      public: false,
      environment: 'empty',
      volumes: 'empty',
    },
    execution: {
      freshSandboxPerPaidTrial: true,
      sandboxReuse: false,
      maxConcurrentPaidTrials: 1,
      maxActiveTaskContainers: 1,
      taskNetworkMode: 'none',
    },
    identities: {
      supervisorUid: 0,
      runnerUid: 2001,
      runnerGid: 2001,
      brokerUid: 2002,
      brokerGid: 2002,
      sharedBrokerClientGid: 2003,
    },
    docker: {
      privateDaemon: true,
      dataRoot: '/engineer-bounded/docker',
      forbiddenDataRoots: ['/var/lib/docker'],
      daemonSocket: '/run/engineer/private-docker.sock',
      proxySocket: '/run/engineer/harbor-docker.sock',
      hostSocketMountAllowed: false,
    },
    paths: { ...FIXED_PATHS },
    executables,
    snapshot: {
      identity: { ...input.snapshotIdentity },
      baseImage: {
        reference: DAYTONA_DIND_BASE_IMAGE,
        digest: DAYTONA_DIND_BASE_IMAGE_DIGEST,
      },
      taskImages,
      harbor: {
        version: 'v0.20.0',
        commit: '459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc',
      },
      nodeProtection: {
        path: '/usr/local/bin/node',
        kind: 'regular-file',
        symlinkAllowed: false,
        ownerUid: 0,
        executable: true,
        groupOrOtherWritable: false,
      },
    },
    bindings: {
      releaseSha: input.releaseSha,
      taskLockHash: input.taskLockHash,
      bundleHash: input.bundleHash,
      budgetPolicyHash: input.budgetPolicyHash,
      brokerPolicyHash: input.brokerPolicyHash,
      profileId: input.profileId,
      sessionCeilingMicrousd: input.sessionCeilingMicrousd,
    },
  });
  const { encoded: canonical } = canonicalClone(manifest);
  const manifestHash = sha256(canonical);
  return deepFreeze({
    manifest,
    canonicalJson: canonical,
    manifestHash,
    snapshotName: manifest.snapshot.identity.name,
  });
}

/** Hash a validated manifest using its recursively key-sorted canonical JSON. */
export function daytonaTopologyManifestHash(input) {
  const manifest = validateDaytonaTopologyManifest(input);
  return sha256(canonicalClone(manifest).encoded);
}

/** Resolve only images present in the release-locked task set. */
export function resolveDaytonaTaskImage(input, taskId) {
  assertSafeId(taskId, 'taskId');
  const manifest = validateDaytonaTopologyManifest(input);
  if (!Object.prototype.hasOwnProperty.call(manifest.snapshot.taskImages, taskId)) {
    fail(`no locked task image exists for ${taskId}`, 'ERR_DAYTONA_TOPOLOGY_TASK_IMAGE');
  }
  return manifest.snapshot.taskImages[taskId];
}

/** Stable, narrow handoff consumed by release-runtime composition. */
export function projectDaytonaReleaseRuntime(input) {
  const manifest = validateDaytonaTopologyManifest(input);
  const manifestHash = sha256(canonicalClone(manifest).encoded);
  return deepFreeze(canonicalClone({
    schema: DAYTONA_RELEASE_RUNTIME_PROJECTION_SCHEMA,
    topologyManifest: {
      schema: manifest.schema,
      hash: manifestHash,
    },
    snapshot: {
      name: manifest.snapshot.identity.name,
      buildHash: manifest.snapshot.identity.buildHash,
    },
    bindings: { ...manifest.bindings },
    executables: {
      supervisor: { ...manifest.executables.supervisor },
      runner: { ...manifest.executables.runner },
      harbor: { ...manifest.executables.harbor },
      imageProvisioner: { ...manifest.executables.imageProvisioner },
    },
    taskImages: { ...manifest.snapshot.taskImages },
  }).value);
}
