import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSnapshotBuildManifest,
  snapshotBuildManifestHash,
  validateSnapshotBuildManifest,
} from '../runtime/snapshot-build-manifest.mjs';
import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
  DAYTONA_NODE_RUNTIME_IMAGE,
  DAYTONA_NODE_RUNTIME_IMAGE_DIGEST,
  DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256,
} from '../runtime/daytona-topology.mjs';

const HASH = (character) => character.repeat(64);

const entries = (prefix, hashCharacter) => [
  {
    path: `${prefix}/bin/tool`,
    type: 'file',
    mode: 0o755,
    byteLength: 17,
    sha256: HASH(hashCharacter),
  },
];

function closure(kind, hashCharacter) {
  return {
    kind,
    encoding: 'ustar',
    byteLength: 1024,
    sha256: HASH(hashCharacter),
    entries: entries(kind, hashCharacter),
  };
}

function input(overrides = {}) {
  return {
    dockerfile: {
      byteLength: 512,
      sha256: HASH('1'),
    },
    definition: {
      byteLength: 300,
      sha256: HASH('2'),
    },
    contexts: {
      runtime: closure('runtime', '3'),
      harbor: closure('harbor', '4'),
      node: closure('node', '5'),
      native: closure('native', '6'),
    },
    executables: {
      supervisor: {
        path: '/opt/engineer/bin/engineer-runtime-supervisor',
        sha256: HASH('3'),
        context: 'runtime',
        sourcePath: 'runtime/bin/tool',
      },
      snapshotSelfTest: {
        path: '/opt/engineer/bin/engineer-snapshot-selftest',
        sha256: HASH('6'),
        context: 'native',
        sourcePath: 'native/bin/tool',
      },
      taskIsolationProbe: {
        path: '/opt/engineer/bin/engineer-task-isolation-probe',
        sha256: HASH('6'),
        context: 'native',
        sourcePath: 'native/bin/tool',
      },
      readinessDenialProbe: {
        path: '/opt/engineer/bin/engineer-readiness-denial-probe',
        sha256: HASH('6'),
        context: 'native',
        sourcePath: 'native/bin/tool',
      },
    },
    provenance: {
      baseImage: {
        reference: DAYTONA_DIND_BASE_IMAGE,
        digest: DAYTONA_DIND_BASE_IMAGE_DIGEST,
      },
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
        compilerImage: `alpine:3.22@sha256:${HASH('b')}`,
        compilerImageDigest: `sha256:${HASH('b')}`,
        binarySha256: HASH('6'),
      },
      taskIsolationProbe: {
        sourceSha256: HASH('a'),
        compilerImage: `alpine:3.22@sha256:${HASH('b')}`,
        compilerImageDigest: `sha256:${HASH('b')}`,
        binarySha256: HASH('6'),
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-task-isolation-probe',
      },
      readinessDenialProbe: {
        sourceSha256: HASH('a'),
        compilerImage: `alpine:3.22@sha256:${HASH('b')}`,
        compilerImageDigest: `sha256:${HASH('b')}`,
        binarySha256: HASH('6'),
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-readiness-denial-probe',
      },
    },
    bindings: {
      releaseSha: 'c'.repeat(40),
      taskLockHash: HASH('c'),
      bundleHash: HASH('d'),
      budgetPolicyHash: HASH('e'),
      brokerPolicyHash: HASH('f'),
      profileId: 'kimi-k2.7-code',
      sessionCeilingMicrousd: 1_300_000,
    },
    taskImages: {
      'cobol-modernization': {
        immutableImage: `alexgshaw/cobol-modernization@sha256:${HASH('f')}`,
        imageId: `sha256:${HASH('e')}`,
        platform: 'linux/amd64',
        cpus: 1,
        memoryMb: 2048,
        storageMb: 10240,
      },
    },
    ...overrides,
  };
}

test('snapshot build identity covers Dockerfile, all closures, definition, provenance, bindings, and immutable tasks', () => {
  const artifact = buildSnapshotBuildManifest(input());

  assert.equal(artifact.manifest.schema, 'engineer-daytona-snapshot-build-manifest.v1');
  assert.equal(artifact.buildHash, snapshotBuildManifestHash(artifact.manifest));
  assert.equal(artifact.snapshotName, `engineer-eval-${artifact.buildHash.slice(0, 32)}`);
  assert.deepEqual(JSON.parse(artifact.canonicalJson), artifact.manifest);
  assert.equal(Object.isFrozen(artifact.manifest.contexts.runtime.entries), true);

  const mutations = [
    { dockerfile: { ...input().dockerfile, sha256: HASH('0') } },
    { definition: { ...input().definition, sha256: HASH('0') } },
    { contexts: { ...input().contexts, harbor: closure('harbor', '0') } },
    { provenance: { ...input().provenance, harbor: { ...input().provenance.harbor, lockSha256: HASH('0') } } },
    { bindings: { ...input().bindings, bundleHash: HASH('0') } },
    { taskImages: { ...input().taskImages, 'cobol-modernization': {
      ...input().taskImages['cobol-modernization'],
      immutableImage: `alexgshaw/cobol-modernization@sha256:${HASH('0')}`,
    } } },
    { taskImages: { ...input().taskImages, 'cobol-modernization': {
      ...input().taskImages['cobol-modernization'],
      imageId: `sha256:${HASH('1')}`,
    } } },
  ];
  for (const mutation of mutations) {
    assert.notEqual(buildSnapshotBuildManifest(input(mutation)).buildHash, artifact.buildHash);
  }
});

test('snapshot manifest rejects unbound executable hashes and malformed task identities', () => {
  const badExecutable = structuredClone(input());
  badExecutable.executables.supervisor.sha256 = HASH('0');
  assert.throws(() => buildSnapshotBuildManifest(badExecutable), /executable.*closure|source.*hash/i);

  const badImage = structuredClone(input());
  badImage.taskImages['cobol-modernization'].imageId = `sha256:${HASH('A')}`;
  assert.throws(() => buildSnapshotBuildManifest(badImage), /image id|imageId|digest/i);

  const bareImage = structuredClone(input());
  bareImage.taskImages['cobol-modernization'].immutableImage = `sha256:${HASH('f')}`;
  assert.throws(() => buildSnapshotBuildManifest(bareImage), /immutableImage|immutable image/i);
});

test('Node provenance rejects the multi-platform index and every Alpine runtime identity drift', () => {
  const expected = input().provenance.node;
  assert.deepEqual(expected, {
    version: 'v22.17.1',
    platform: 'linux/amd64-musl',
    runtimeImage: DAYTONA_NODE_RUNTIME_IMAGE,
    runtimeImageDigest: DAYTONA_NODE_RUNTIME_IMAGE_DIGEST,
    binarySha256: DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256.node,
  });

  for (const replacement of [
    { runtimeImage: `node:22.17.1-alpine3.22@sha256:${HASH('0')}` },
    { runtimeImageDigest: 'sha256:5539840ce9d013fa13e3b9814c9353024be7ac75aca5db6d039504a56c04ea59' },
    { version: 'v22.17.2' },
    { platform: 'linux/amd64' },
    { binarySha256: HASH('0') },
  ]) {
    const candidate = structuredClone(input());
    Object.assign(candidate.provenance.node, replacement);
    assert.throws(() => buildSnapshotBuildManifest(candidate), /Node provenance|Alpine-compatible/i);
  }
});

test('snapshot manifest is exact, bounded, credential-free, and binds required context kinds', () => {
  const artifact = buildSnapshotBuildManifest(input());
  const unknown = structuredClone(artifact.manifest);
  unknown.extra = true;
  assert.throws(() => validateSnapshotBuildManifest(unknown), /unexpected field/i);

  const secret = structuredClone(input());
  secret.bindings.profileId = 'Bearer secret-material';
  assert.throws(() => buildSnapshotBuildManifest(secret), /credential|profileId/i);

  const missing = structuredClone(input());
  delete missing.contexts.native;
  assert.throws(() => buildSnapshotBuildManifest(missing), /native|context/i);

  const duplicatePath = structuredClone(input());
  duplicatePath.contexts.runtime.entries.push({ ...duplicatePath.contexts.runtime.entries[0] });
  assert.throws(() => buildSnapshotBuildManifest(duplicatePath), /duplicate.*path/i);

  const sensitivePath = structuredClone(input());
  sensitivePath.contexts.harbor.entries[0].path = 'credentials.json';
  assert.throws(() => buildSnapshotBuildManifest(sensitivePath), /relative path|credential|sensitive/i);

  const sensitiveDirectory = structuredClone(input());
  sensitiveDirectory.contexts.harbor.entries[0].path = '.env/payload';
  assert.throws(() => buildSnapshotBuildManifest(sensitiveDirectory), /relative path|credential|sensitive/i);
});
