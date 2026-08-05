import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
  buildDaytonaTopologyManifest,
  daytonaTopologyManifestHash,
  projectDaytonaReleaseRuntime,
  resolveDaytonaTaskImage,
  validateDaytonaTopologyManifest,
} from '../../../evals/runtime/daytona-topology.mjs';

const HASH = (character) => character.repeat(64);

const EXECUTABLE_HASHES = Object.freeze({
  node: HASH('1'),
  supervisor: HASH('2'),
  archiveBridge: HASH('3'),
  runner: HASH('4'),
  harbor: HASH('5'),
  providerBroker: HASH('6'),
  readinessProbe: HASH('7'),
  evidenceCollector: HASH('8'),
  cgroupExec: HASH('9'),
  taskIsolationProbe: HASH('e'),
  imageProvisioner: HASH('0'),
  snapshotSelfTest: HASH('1'),
  dockerd: HASH('a'),
  docker: HASH('2'),
  iptables: HASH('b'),
  ip6tables: HASH('c'),
  sentinel: HASH('d'),
});

const TASK_IMAGES = Object.freeze({
  'cobol-modernization': {
    immutableImage: `example.invalid/cobol-modernization@sha256:${HASH('b')}`,
    imageId: `sha256:${HASH('b')}`,
    platform: 'linux/amd64', cpus: 1, memoryMb: 2048, storageMb: 10240,
  },
  'gate-heavy-repair': {
    immutableImage: `example.invalid/gate-heavy-repair@sha256:${HASH('c')}`,
    imageId: `sha256:${HASH('c')}`,
    platform: 'linux/amd64', cpus: 1, memoryMb: 2048, storageMb: 10240,
  },
  'large-repo-orientation': {
    immutableImage: `example.invalid/large-repo-orientation@sha256:${HASH('d')}`,
    imageId: `sha256:${HASH('d')}`,
    platform: 'linux/amd64', cpus: 1, memoryMb: 2048, storageMb: 10240,
  },
  'legacy-data-lineage': {
    immutableImage: `example.invalid/legacy-data-lineage@sha256:${HASH('e')}`,
    imageId: `sha256:${HASH('e')}`,
    platform: 'linux/amd64', cpus: 1, memoryMb: 2048, storageMb: 10240,
  },
});

function options(overrides = {}) {
  return {
    releaseSha: 'e'.repeat(40),
    taskLockHash: HASH('f'),
    bundleHash: HASH('0'),
    budgetPolicyHash: HASH('a'),
    brokerPolicyHash: HASH('f'),
    profileId: 'openrouter-kimi-controlled',
    sessionCeilingMicrousd: 1_300_000,
    snapshotIdentity: {
      name: `engineer-eval-${HASH('9').slice(0, 32)}`,
      buildHash: HASH('9'),
    },
    taskImages: { ...TASK_IMAGES },
    executableHashes: { ...EXECUTABLE_HASHES },
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

function setAt(value, path, replacement) {
  const copy = clone(value);
  const parts = path.split('.');
  let cursor = copy;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  cursor[parts.at(-1)] = replacement;
  return copy;
}

test('builds the exact approved per-trial Daytona topology as a content-addressed manifest', () => {
  const artifact = buildDaytonaTopologyManifest(options());
  const { manifest } = artifact;

  assert.equal(manifest.daytona.cliVersion, 'v0.203.0');
  assert.equal(manifest.daytona.sandboxClass, 'container');
  assert.equal(manifest.daytona.rootDiskBytes, 10 * 1024 * 1024 * 1024);
  assert.equal(manifest.daytona.public, false);
  assert.equal(manifest.daytona.environment, 'empty');
  assert.equal(manifest.daytona.volumes, 'empty');

  assert.equal(manifest.execution.freshSandboxPerPaidTrial, true);
  assert.equal(manifest.execution.sandboxReuse, false);
  assert.equal(manifest.execution.maxConcurrentPaidTrials, 1);
  assert.equal(manifest.execution.maxActiveTaskContainers, 1);
  assert.equal(manifest.execution.taskNetworkMode, 'none');

  assert.equal(manifest.identities.runnerUid, 2001);
  assert.equal(manifest.identities.brokerUid, 2002);
  assert.equal(manifest.identities.sharedBrokerClientGid, 2003);
  assert.equal(manifest.docker.privateDaemon, true);
  assert.equal(manifest.docker.dataRoot, '/engineer-bounded/docker');
  assert.deepEqual(manifest.docker.forbiddenDataRoots, ['/var/lib/docker']);
  assert.equal(manifest.docker.hostSocketMountAllowed, false);

  assert.equal(manifest.snapshot.baseImage.reference, DAYTONA_DIND_BASE_IMAGE);
  assert.equal(manifest.snapshot.baseImage.digest, DAYTONA_DIND_BASE_IMAGE_DIGEST);
  assert.equal(manifest.snapshot.harbor.version, 'v0.20.0');
  assert.equal(manifest.snapshot.harbor.commit, '459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc');
  assert.deepEqual(manifest.snapshot.identity, options().snapshotIdentity);
  assert.deepEqual(manifest.snapshot.nodeProtection, {
    path: '/usr/local/bin/node',
    kind: 'regular-file',
    symlinkAllowed: false,
    ownerUid: 0,
    executable: true,
    groupOrOtherWritable: false,
  });

  assert.equal(manifest.executables.supervisor.path, '/opt/engineer/bin/engineer-runtime-supervisor');
  assert.equal(manifest.executables.archiveBridge.path, '/opt/engineer/bin/engineer-archive-bridge');
  assert.equal(manifest.executables.runner.path, '/opt/engineer/bin/engineer-eval-runner');
  assert.equal(manifest.executables.harbor.path, '/opt/engineer/bin/harbor');
  assert.deepEqual(manifest.executables.taskIsolationProbe, {
    path: '/opt/engineer/bin/engineer-task-isolation-probe',
    sha256: EXECUTABLE_HASHES.taskIsolationProbe,
  });
  assert.equal(manifest.executables.node.sha256, EXECUTABLE_HASHES.node);
  assert.deepEqual(manifest.snapshot.taskImages, TASK_IMAGES);

  assert.match(artifact.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(artifact.manifestHash, daytonaTopologyManifestHash(manifest));
  assert.equal(artifact.snapshotName, options().snapshotIdentity.name);
  assert.deepEqual(JSON.parse(artifact.canonicalJson), manifest);
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(manifest.executables), true);
});

test('canonical hashing is deterministic and binds release, task, bundle, budget, profile, ceiling, images, and executables', () => {
  const first = buildDaytonaTopologyManifest(options());
  const reorderedHashes = Object.fromEntries(Object.entries(EXECUTABLE_HASHES).reverse());
  const second = buildDaytonaTopologyManifest(options({ executableHashes: reorderedHashes }));
  assert.equal(second.manifestHash, first.manifestHash);
  assert.equal(second.canonicalJson, first.canonicalJson);

  const mutations = [
    { releaseSha: 'd'.repeat(40) },
    { taskLockHash: HASH('1') },
    { bundleHash: HASH('2') },
    { budgetPolicyHash: HASH('3') },
    { brokerPolicyHash: HASH('4') },
    { profileId: 'openrouter-kimi-other' },
    { sessionCeilingMicrousd: 1_299_999 },
    { snapshotIdentity: { name: `engineer-eval-${HASH('8').slice(0, 32)}`, buildHash: HASH('8') } },
    { taskImages: { ...TASK_IMAGES, 'cobol-modernization': {
      ...TASK_IMAGES['cobol-modernization'],
      immutableImage: `example.invalid/cobol-modernization@sha256:${HASH('4')}`,
      imageId: `sha256:${HASH('4')}`,
    } } },
    { executableHashes: { ...EXECUTABLE_HASHES, runner: HASH('e') } },
  ];
  for (const mutation of mutations) {
    assert.notEqual(buildDaytonaTopologyManifest(options(mutation)).manifestHash, first.manifestHash,
      JSON.stringify(Object.keys(mutation)));
  }
});

test('validation rejects drift from every load-bearing topology control', () => {
  const manifest = buildDaytonaTopologyManifest(options()).manifest;
  const mutations = [
    ['daytona.cliVersion', 'v0.204.0'],
    ['daytona.rootDiskBytes', 100 * 1024 * 1024 * 1024],
    ['daytona.public', true],
    ['daytona.environment', 'inherited'],
    ['execution.freshSandboxPerPaidTrial', false],
    ['execution.sandboxReuse', true],
    ['execution.maxConcurrentPaidTrials', 2],
    ['execution.maxActiveTaskContainers', 2],
    ['execution.taskNetworkMode', 'bridge'],
    ['identities.runnerUid', 0],
    ['identities.brokerUid', 2001],
    ['identities.sharedBrokerClientGid', 2002],
    ['docker.privateDaemon', false],
    ['docker.dataRoot', '/var/lib/docker'],
    ['docker.forbiddenDataRoots', []],
    ['docker.hostSocketMountAllowed', true],
    ['snapshot.baseImage.reference', 'docker:latest'],
    ['snapshot.baseImage.digest', `sha256:${HASH('0')}`],
    ['snapshot.harbor.version', 'v0.21.0'],
    ['snapshot.harbor.commit', '0'.repeat(40)],
    ['snapshot.identity.buildHash', HASH('0')],
    ['snapshot.nodeProtection.path', '/usr/bin/node'],
    ['snapshot.nodeProtection.kind', 'symlink'],
    ['snapshot.nodeProtection.symlinkAllowed', true],
    ['snapshot.nodeProtection.groupOrOtherWritable', true],
    ['executables.supervisor.path', '/tmp/supervisor'],
    ['executables.runner.sha256', 'not-a-hash'],
    ['paths.workspace', '/tmp/work'],
  ];

  for (const [path, replacement] of mutations) {
    assert.throws(() => validateDaytonaTopologyManifest(setAt(manifest, path, replacement)),
      /approved|drift|exact|topology|manifest/i, path);
  }
});

test('validation is closed to unknown or credential-bearing input and can pin expected release bindings', () => {
  const artifact = buildDaytonaTopologyManifest(options());
  const expectedBindings = { ...artifact.manifest.bindings };
  assert.deepEqual(validateDaytonaTopologyManifest(artifact.manifest, { expectedBindings }), artifact.manifest);

  const unknown = clone(artifact.manifest);
  unknown.OPENROUTER_API_KEY = 'must-never-enter-a-manifest';
  assert.throws(() => validateDaytonaTopologyManifest(unknown), /unexpected field|secret/i);
  assert.throws(() => buildDaytonaTopologyManifest({
    ...options(),
    DAYTONA_API_KEY: 'must-never-enter-a-builder',
  }), /unexpected field|secret/i);
  assert.throws(() => buildDaytonaTopologyManifest(options({ profileId: 'Bearer forbidden' })), /profileId|credential/i);

  const mismatched = { ...expectedBindings, bundleHash: HASH('9') };
  assert.throws(() => validateDaytonaTopologyManifest(artifact.manifest, { expectedBindings: mismatched }),
    /binding.*bundleHash|bundleHash.*binding/i);
  assert.equal(artifact.canonicalJson.includes('must-never-enter'), false);
});

test('release-runtime projection exposes only stable identities and resolves the full locked task image set', () => {
  const artifact = buildDaytonaTopologyManifest(options());
  const projection = projectDaytonaReleaseRuntime(artifact.manifest);

  assert.deepEqual(projection, {
    schema: 'engineer-daytona-release-runtime-projection.v1',
    topologyManifest: {
      schema: 'engineer-daytona-topology-manifest.v1',
      hash: artifact.manifestHash,
    },
    snapshot: {
      name: artifact.snapshotName,
      buildHash: options().snapshotIdentity.buildHash,
    },
    bindings: { ...artifact.manifest.bindings },
    executables: {
      supervisor: { ...artifact.manifest.executables.supervisor },
      runner: { ...artifact.manifest.executables.runner },
      harbor: { ...artifact.manifest.executables.harbor },
      imageProvisioner: { ...artifact.manifest.executables.imageProvisioner },
    },
    taskImages: { ...TASK_IMAGES },
  });
  assert.deepEqual(resolveDaytonaTaskImage(artifact.manifest, 'large-repo-orientation'), TASK_IMAGES['large-repo-orientation']);
  assert.throws(() => resolveDaytonaTaskImage(artifact.manifest, 'not-in-task-lock'), /locked task image/i);
  assert.equal(Object.isFrozen(projection.taskImages), true);
});

test('invalid binding and hash inputs fail before an artifact can be named or trusted', () => {
  for (const mutation of [
    { releaseSha: 'not-a-release' },
    { taskLockHash: HASH('A') },
    { taskImages: { ...TASK_IMAGES, 'cobol-modernization': { ...TASK_IMAGES['cobol-modernization'], immutableImage: HASH('b') } } },
    { taskImages: Object.fromEntries([...Object.entries(TASK_IMAGES), ['constructor', TASK_IMAGES['cobol-modernization']]]) },
    { snapshotIdentity: { name: 'operator-selected', buildHash: HASH('9') } },
    { sessionCeilingMicrousd: 20_000_001 },
    { sessionCeilingMicrousd: 0 },
    { executableHashes: { ...EXECUTABLE_HASHES, node: 'not-a-hash' } },
    { executableHashes: { ...EXECUTABLE_HASHES, extra: HASH('e') } },
  ]) {
    assert.throws(() => buildDaytonaTopologyManifest(options(mutation)),
      /releaseSha|hash|digest|ceiling|unexpected field|reserved taskId/i, JSON.stringify(mutation));
  }

  assert.throws(() => daytonaTopologyManifestHash({}), /manifest|schema|required/i);
});
