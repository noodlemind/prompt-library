import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  downloadPinnedSnapshotSource,
  prepareRuntimeSnapshotArtifacts,
  pullExactImages,
} from '../../../evals/runtime/runtime-snapshot-artifacts.mjs';
import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
  DAYTONA_EXECUTABLE_PATHS,
} from '../../../evals/runtime/daytona-topology.mjs';

const HASH = (character) => character.repeat(64);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function input(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-snapshot-artifacts-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return {
    workspace,
    repoRoot: '/repo',
    daytonaPath: '/opt/homebrew/bin/daytona',
    bundle: { bundleDir: '/bundle', manifestHash: HASH('1') },
    bindings: {
      releaseSha: 'a'.repeat(40),
      taskLockHash: HASH('2'),
      bundleHash: HASH('1'),
      budgetPolicyHash: HASH('3'),
      brokerPolicyHash: HASH('4'),
      profileId: 'small-model',
      sessionCeilingMicrousd: 1_300_000,
    },
    taskImages: {
      'cobol-modernization': {
        immutableImage: `alexgshaw/cobol-modernization@sha256:${HASH('4')}`,
        imageId: `sha256:${HASH('4')}`,
        platform: 'linux/amd64',
        cpus: 1,
        memoryMb: 2048,
        storageMb: 10240,
      },
    },
  };
}

function materializedClosures(workspace) {
  const roots = Object.fromEntries(['runtime', 'harbor', 'node', 'native'].map((kind) => {
    const root = path.join(workspace, `closure-${kind}`);
    fs.mkdirSync(root, { recursive: true });
    return [kind, root];
  }));
  const executables = {};
  for (const [name, absolute] of Object.entries(DAYTONA_EXECUTABLE_PATHS)) {
    const context = name === 'node' ? 'node' : name === 'harbor' ? 'harbor'
      : ['cgroupExec', 'taskIsolationProbe', 'readinessDenialProbe'].includes(name)
        ? 'native' : 'runtime';
    const sourcePath = absolute.slice(1);
    const file = path.join(roots[context], ...sourcePath.split('/'));
    const bytes = Buffer.from(`protected executable ${name}\n`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode: 0o555 });
    executables[name] = { path: absolute, sha256: sha256(bytes), context, sourcePath };
  }
  const dockerfilePath = path.join(workspace, 'Dockerfile.snapshot');
  const definitionPath = path.join(workspace, 'runtime-definition.json');
  fs.writeFileSync(dockerfilePath, [
    `FROM ${DAYTONA_DIND_BASE_IMAGE}`,
    'ADD runtime.tar /',
    'ADD harbor.tar /',
    'ADD node.tar /',
    'ADD native.tar /',
    'COPY build-manifest.json /opt/engineer/snapshot/build-manifest.json',
    '',
  ].join('\n'));
  fs.writeFileSync(definitionPath, '{"schema":"fixture-runtime-definition.v1"}');
  return {
    dockerfilePath,
    definitionPath,
    roots,
    executables,
    provenance: {
      baseImage: { reference: DAYTONA_DIND_BASE_IMAGE, digest: DAYTONA_DIND_BASE_IMAGE_DIGEST },
      harbor: {
        version: 'v0.20.0',
        commit: '459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc',
        lockSha256: HASH('5'),
      },
      node: { version: 'v22.17.1', platform: 'linux-x64', archiveSha256: HASH('6') },
      nativeHelper: {
        sourceSha256: HASH('7'),
        compilerImage: `gcc:14.2.0-bookworm@sha256:${HASH('8')}`,
        compilerImageDigest: `sha256:${HASH('8')}`,
        binarySha256: executables.cgroupExec.sha256,
      },
      taskIsolationProbe: {
        sourceSha256: HASH('9'),
        compilerImage: `gcc:14.2.0-bookworm@sha256:${HASH('8')}`,
        compilerImageDigest: `sha256:${HASH('8')}`,
        binarySha256: executables.taskIsolationProbe.sha256,
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-task-isolation-probe',
      },
      readinessDenialProbe: {
        sourceSha256: HASH('a'),
        compilerImage: `gcc:14.2.0-bookworm@sha256:${HASH('8')}`,
        compilerImageDigest: `sha256:${HASH('8')}`,
        binarySha256: executables.readinessDenialProbe.sha256,
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-readiness-denial-probe',
      },
    },
  };
}

function components(captured, overrides = {}) {
  return {
    async prepareClosures(request) {
      captured.closureRequest = request;
      return materializedClosures(request.workspace);
    },
    async ensureSnapshot(request) {
      captured.snapshotRequest = request;
      return {
        schema: 'engineer-daytona-snapshot-lifecycle-receipt.v1',
        name: request.identity.name,
        snapshotId: 'snapshot-1',
        buildHash: request.identity.buildHash,
        status: 'active',
        created: true,
        retained: true,
        archiveCount: request.archives.length,
        validation: { performed: true },
      };
    },
    ...overrides,
  };
}

test('pinned snapshot source accepts an absent Content-Length and enforces the streamed digest', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-snapshot-download-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destination = path.join(workspace, 'source.tar.gz');
  const bytes = Buffer.from('bounded pinned source');
  const url = 'https://example.invalid/source.tar.gz';
  const fetchImpl = async () => ({
    status: 200,
    url,
    headers: { get: () => null },
    body: (async function* body() { yield bytes; })(),
  });

  await downloadPinnedSnapshotSource({
    url,
    expectedSha256: sha256(bytes),
    destination,
  }, { fetchImpl });

  assert.deepEqual(fs.readFileSync(destination), bytes);
});

test('pinned builder platform inspection resolves the requested linux/amd64 manifest', () => {
  const calls = [];
  pullExactImages((args) => {
    calls.push(args);
    return args[0] === 'image' ? 'linux/amd64\n' : '';
  });

  const inspections = calls.filter(([command]) => command === 'image');
  assert.equal(inspections.length, 4);
  for (const args of inspections) {
    assert.deepEqual(args.slice(0, 4), ['image', 'inspect', '--platform', 'linux/amd64']);
    assert.deepEqual(args.slice(4, 6), ['--format', '{{.Os}}/{{.Architecture}}']);
  }
});

test('pinned builder platform inspection rejects an unresolved OCI index', () => {
  assert.throws(
    () => pullExactImages((args) => args[0] === 'image' ? '/\n' : ''),
    (error) => error?.code === 'ERR_RUNTIME_SNAPSHOT_DOCKER' &&
      /platform drifted/i.test(error.message),
  );
});

test('builds four deterministic closures plus a self-authenticating manifest and retains the validated snapshot', async (t) => {
  const request = input(t);
  const captured = {};
  const result = await prepareRuntimeSnapshotArtifacts(request, { components: components(captured) });

  assert.equal(result.identity.name, `engineer-eval-${result.identity.buildHash.slice(0, 32)}`);
  assert.deepEqual(Object.keys(result.executableHashes).sort(), Object.keys(DAYTONA_EXECUTABLE_PATHS).sort());
  assert.equal(result.receipt.buildHash, result.identity.buildHash);
  assert.equal(captured.closureRequest.bindings.bundleHash, request.bundle.manifestHash);
  assert.equal(captured.snapshotRequest.daytonaPath, request.daytonaPath);
  assert.equal(captured.snapshotRequest.archives.length, 5);

  const manifestArchive = captured.snapshotRequest.archives.find((entry) => path.basename(entry.path) === 'build-manifest.json');
  assert.ok(manifestArchive);
  assert.equal(manifestArchive.sha256, result.identity.buildHash);
  const manifest = JSON.parse(fs.readFileSync(manifestArchive.path, 'utf8'));
  assert.equal(manifest.bindings.releaseSha, request.bindings.releaseSha);
  assert.equal(manifest.bindings.taskLockHash, request.bindings.taskLockHash);
  assert.deepEqual(manifest.taskImages, request.taskImages);
  assert.deepEqual(
    Object.fromEntries(Object.entries(manifest.executables).map(([name, value]) => [name, value.sha256])),
    result.executableHashes,
  );
  for (const kind of ['runtime', 'harbor', 'node', 'native']) {
    const archive = captured.snapshotRequest.archives.find((entry) => path.basename(entry.path) === `${kind}.tar`);
    assert.equal(archive.sha256, manifest.contexts[kind].sha256);
    assert.equal(fs.statSync(archive.path).size, manifest.contexts[kind].byteLength);
  }
});

test('identical closures yield one content identity independent of workspace metadata', async (t) => {
  const firstInput = input(t);
  const secondInput = input(t);
  const first = await prepareRuntimeSnapshotArtifacts(firstInput, { components: components({}) });
  const second = await prepareRuntimeSnapshotArtifacts(secondInput, { components: components({}) });
  assert.equal(first.identity.buildHash, second.identity.buildHash);
  assert.deepEqual(first.executableHashes, second.executableHashes);
});

test('fails before Daytona on input, closure, executable, manifest, or receipt drift', async (t) => {
  const base = input(t);
  await assert.rejects(
    prepareRuntimeSnapshotArtifacts({ ...base, providerKey: 'forbidden' }, { components: components({}) }),
    /unexpected/i,
  );

  const badExecutable = components({}, {
    async prepareClosures(request) {
      const closure = materializedClosures(request.workspace);
      closure.executables.node.sha256 = HASH('0');
      return closure;
    },
  });
  await assert.rejects(
    prepareRuntimeSnapshotArtifacts(input(t), { components: badExecutable }),
    /executable|closure|hash|digest/i,
  );

  const redirectedExecutable = components({}, {
    async prepareClosures(request) {
      const closure = materializedClosures(request.workspace);
      closure.executables.node.sourcePath = 'usr/local/bin/not-node';
      return closure;
    },
  });
  await assert.rejects(
    prepareRuntimeSnapshotArtifacts(input(t), { components: redirectedExecutable }),
    /executable|closure|binding|drift/i,
  );

  const redirectedContext = components({}, {
    async prepareClosures(request) {
      const closure = materializedClosures(request.workspace);
      closure.executables.node.context = 'runtime';
      return closure;
    },
  });
  await assert.rejects(
    prepareRuntimeSnapshotArtifacts(input(t), { components: redirectedContext }),
    /executable|closure|binding|drift/i,
  );

  const unlistedCredentialMaterial = components({}, {
    async prepareClosures(request) {
      const closure = materializedClosures(request.workspace);
      fs.writeFileSync(
        path.join(closure.roots.node, 'unlisted-config'),
        `AKIA${'B'.repeat(16)}\n`,
      );
      return closure;
    },
  });
  await assert.rejects(
    prepareRuntimeSnapshotArtifacts(input(t), { components: unlistedCredentialMaterial }),
    (error) => error?.code === 'ERR_DETERMINISTIC_USTAR_SECRET',
  );

  const unpinnedNodeCredentialMaterial = components({}, {
    async prepareClosures(request) {
      const closure = materializedClosures(request.workspace);
      const executable = closure.executables.node;
      const bytes = Buffer.from(`AKIA${'D'.repeat(16)}\n`);
      const file = path.join(closure.roots.node, ...executable.sourcePath.split('/'));
      fs.chmodSync(file, 0o755);
      fs.writeFileSync(file, bytes);
      fs.chmodSync(file, 0o555);
      executable.sha256 = sha256(bytes);
      return closure;
    },
  });
  await assert.rejects(
    prepareRuntimeSnapshotArtifacts(input(t), { components: unpinnedNodeCredentialMaterial }),
    (error) => error?.code === 'ERR_DETERMINISTIC_USTAR_SECRET',
  );

  const textExecutableCredentialMaterial = components({}, {
    async prepareClosures(request) {
      const closure = materializedClosures(request.workspace);
      const executable = closure.executables.supervisor;
      const bytes = Buffer.from(`#!/bin/sh\n# AKIA${'C'.repeat(16)}\n`);
      const file = path.join(closure.roots[executable.context], ...executable.sourcePath.split('/'));
      fs.chmodSync(file, 0o755);
      fs.writeFileSync(file, bytes);
      fs.chmodSync(file, 0o555);
      executable.sha256 = sha256(bytes);
      return closure;
    },
  });
  await assert.rejects(
    prepareRuntimeSnapshotArtifacts(input(t), { components: textExecutableCredentialMaterial }),
    (error) => error?.code === 'ERR_DETERMINISTIC_USTAR_SECRET',
  );

  const badReceipt = components({}, {
    async ensureSnapshot(request) {
      return {
        schema: 'engineer-daytona-snapshot-lifecycle-receipt.v1',
        name: request.identity.name,
        buildHash: HASH('0'),
        status: 'active',
        retained: true,
      };
    },
  });
  await assert.rejects(
    prepareRuntimeSnapshotArtifacts(input(t), { components: badReceipt }),
    /receipt|identity|build/i,
  );
});
