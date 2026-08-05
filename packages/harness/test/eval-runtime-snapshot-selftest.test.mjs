import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  buildSnapshotBuildManifest,
} from '../../../evals/runtime/snapshot-build-manifest.mjs';
import {
  SnapshotSelfTestError,
  parseSnapshotSelfTestFailure,
  runSnapshotSelfTestMain,
  runSnapshotSelfTestCli,
} from '../../../evals/runtime/snapshot-selftest.mjs';
import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
  DAYTONA_NODE_RUNTIME_IMAGE,
  DAYTONA_NODE_RUNTIME_IMAGE_DIGEST,
  DAYTONA_NODE_USTAR_ATTESTATION,
  DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256,
} from '../../../evals/runtime/daytona-topology.mjs';

const HASH = (character) => character.repeat(64);
const DAYTONA_METADATA = Object.freeze({
  DAYTONA_ORGANIZATION_ID: '123e4567-e89b-42d3-a456-426614174000',
  DAYTONA_OTEL_ENDPOINT: 'https://telemetry.daytona.invalid/v1/traces',
  DAYTONA_REGION_ID: 'us',
  DAYTONA_SANDBOX_ID: '8d2890a2-57ef-4d75-91d5-2b0a81256b89',
  DAYTONA_SANDBOX_SNAPSHOT: `ghcr.io/daytonaio/runtime@sha256:${HASH('a')}`,
  DAYTONA_SANDBOX_USER: 'root',
});

function context(kind, entries) {
  return {
    kind,
    encoding: 'ustar',
    byteLength: 1024,
    sha256: HASH(kind === 'runtime' ? '1' : kind === 'harbor' ? '2' : kind === 'node' ? '3' : '4'),
    entries,
  };
}

function fixture() {
  const executableHashes = {
    supervisor: HASH('a'),
    snapshotSelfTest: HASH('b'),
    node: DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256.node,
    harbor: HASH('d'),
    taskIsolationProbe: HASH('f'),
    readinessDenialProbe: HASH('9'),
  };
  const runtimeEntries = [
    { path: 'opt/engineer/bin/engineer-runtime-supervisor', type: 'file', mode: 0o555, byteLength: 12, sha256: executableHashes.supervisor },
    { path: 'opt/engineer/bin/engineer-snapshot-selftest', type: 'file', mode: 0o555, byteLength: 13, sha256: executableHashes.snapshotSelfTest },
  ];
  const harborEntries = [
    { path: 'opt/engineer/bin/harbor', type: 'file', mode: 0o555, byteLength: 14, sha256: executableHashes.harbor },
  ];
  const nodeEntries = [
    { path: 'usr/local/bin/node', type: 'file', mode: 0o555, byteLength: 15, sha256: executableHashes.node },
  ];
  const nativeEntries = [
    { path: 'opt/engineer/bin/engineer-cgroup-exec', type: 'file', mode: 0o555, byteLength: 16, sha256: HASH('e') },
    { path: 'opt/engineer/bin/engineer-task-isolation-probe', type: 'file', mode: 0o555, byteLength: 17, sha256: executableHashes.taskIsolationProbe },
    { path: 'opt/engineer/bin/engineer-readiness-denial-probe', type: 'file', mode: 0o555, byteLength: 18, sha256: executableHashes.readinessDenialProbe },
  ];
  const artifact = buildSnapshotBuildManifest({
    dockerfile: { byteLength: 100, sha256: HASH('5') },
    definition: { byteLength: 101, sha256: HASH('6') },
    contexts: {
      runtime: context('runtime', runtimeEntries),
      harbor: context('harbor', harborEntries),
      node: context('node', nodeEntries),
      native: context('native', nativeEntries),
    },
    executables: {
      supervisor: {
        path: '/opt/engineer/bin/engineer-runtime-supervisor',
        sha256: executableHashes.supervisor,
        context: 'runtime',
        sourcePath: runtimeEntries[0].path,
      },
      snapshotSelfTest: {
        path: '/opt/engineer/bin/engineer-snapshot-selftest',
        sha256: executableHashes.snapshotSelfTest,
        context: 'runtime',
        sourcePath: runtimeEntries[1].path,
      },
      node: {
        path: '/usr/local/bin/node',
        sha256: executableHashes.node,
        context: 'node',
        sourcePath: nodeEntries[0].path,
      },
      harbor: {
        path: '/opt/engineer/bin/harbor',
        sha256: executableHashes.harbor,
        context: 'harbor',
        sourcePath: harborEntries[0].path,
      },
      cgroupExec: {
        path: '/opt/engineer/bin/engineer-cgroup-exec',
        sha256: HASH('e'),
        context: 'native',
        sourcePath: nativeEntries[0].path,
      },
      taskIsolationProbe: {
        path: '/opt/engineer/bin/engineer-task-isolation-probe',
        sha256: executableHashes.taskIsolationProbe,
        context: 'native',
        sourcePath: nativeEntries[1].path,
      },
      readinessDenialProbe: {
        path: '/opt/engineer/bin/engineer-readiness-denial-probe',
        sha256: executableHashes.readinessDenialProbe,
        context: 'native',
        sourcePath: nativeEntries[2].path,
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
        compilerImage: `gcc:14.2.0-bookworm@sha256:${HASH('f')}`,
        compilerImageDigest: `sha256:${HASH('f')}`,
        binarySha256: HASH('e'),
      },
      taskIsolationProbe: {
        sourceSha256: HASH('a'),
        compilerImage: `gcc:14.2.0-bookworm@sha256:${HASH('f')}`,
        compilerImageDigest: `sha256:${HASH('f')}`,
        binarySha256: executableHashes.taskIsolationProbe,
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-task-isolation-probe',
      },
      readinessDenialProbe: {
        sourceSha256: HASH('b'),
        compilerImage: `gcc:14.2.0-bookworm@sha256:${HASH('f')}`,
        compilerImageDigest: `sha256:${HASH('f')}`,
        binarySha256: executableHashes.readinessDenialProbe,
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-readiness-denial-probe',
      },
    },
    bindings: {
      releaseSha: 'a'.repeat(40),
      taskLockHash: HASH('1'),
      bundleHash: HASH('2'),
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
  });
  const bytes = Buffer.from(artifact.canonicalJson);
  const inspections = new Map(Object.values(artifact.manifest.executables).map((entry) => [
    entry.path,
    { type: 'file', uid: 0, mode: 0o555, byteLength: 32, sha256: entry.sha256 },
  ]));
  for (const entry of DAYTONA_NODE_USTAR_ATTESTATION.entries) {
    inspections.set(`/${entry.path}`, {
      type: entry.type,
      uid: 0,
      mode: entry.mode,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    });
  }
  const primitives = {
    async platform() { return 'linux'; },
    async effectiveUid() { return 0; },
    async readManifest() { return bytes; },
    async inspectExecutable({ file }) { return inspections.get(file); },
    async runCommand(file, args) {
      if (file === '/usr/local/bin/node') return { code: 0, stdout: 'v22.17.1\n', stderr: '' };
      if (file === '/opt/engineer/bin/harbor') return { code: 0, stdout: '0.20.0\n', stderr: '' };
      throw new Error(`unexpected command ${file} ${args.join(' ')}`);
    },
  };
  return { artifact, bytes, primitives, inspections };
}

function sink() {
  let value = '';
  return { output: { write(chunk) { value += chunk; } }, read: () => value };
}

test('the production snapshot self-test hard-kills bounded version probes', () => {
  const source = fs.readFileSync(
    new URL('../../../evals/runtime/snapshot-selftest.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function runFixedCommand(');
  const end = source.indexOf('\n}\n\nexport function createNodeSnapshotSelfTestPrimitives', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const implementation = source.slice(start, end);
  assert.match(implementation, /timeout:\s*30_000/);
  assert.match(implementation, /killSignal:\s*'SIGKILL'/);
});

test('attests the canonical embedded manifest, every executable, and exact Harbor/Node closures', async () => {
  const input = fixture();
  const target = sink();
  const code = await runSnapshotSelfTestCli({
    argv: ['--expected-build-hash', input.artifact.buildHash],
    environment: {},
    output: target.output,
    primitives: input.primitives,
  });

  assert.equal(code, 0);
  assert.equal(target.read(), `ENGINEER-SNAPSHOT/1 ${input.artifact.buildHash}\n`);
});

test('scrubs live-shaped Daytona platform metadata in place before strict validation', async () => {
  const input = fixture();
  const target = sink();
  const environment = { PATH: '/usr/bin', ...DAYTONA_METADATA };
  const code = await runSnapshotSelfTestCli({
    argv: ['--expected-build-hash', input.artifact.buildHash],
    environment,
    output: target.output,
    primitives: input.primitives,
  });

  assert.equal(code, 0);
  assert.deepEqual(environment, { PATH: '/usr/bin' });
  assert.equal(target.read(), `ENGINEER-SNAPSHOT/1 ${input.artifact.buildHash}\n`);
});

test('rejects unknown Daytona names and invalid or opaque known metadata', async () => {
  const opaque = {};
  Object.defineProperty(opaque, 'DAYTONA_SANDBOX_ID', {
    configurable: false,
    enumerable: true,
    value: '8d2890a2-57ef-4d75-91d5-2b0a81256b89',
    writable: true,
  });
  const mixedInvalid = {
    ...DAYTONA_METADATA,
    DAYTONA_SANDBOX_USER: 'invalid user',
  };
  for (const environment of [
    { DAYTONA_UNKNOWN: 'unknown-platform-authority' },
    mixedInvalid,
    opaque,
  ]) {
    const input = fixture();
    await assert.rejects(
      runSnapshotSelfTestCli({
        argv: ['--expected-build-hash', input.artifact.buildHash],
        environment,
        output: sink().output,
        primitives: input.primitives,
      }),
      (error) => error instanceof SnapshotSelfTestError
        && error.code === 'ERR_SNAPSHOT_SELFTEST_ENVIRONMENT',
    );
  }
  assert.equal(Object.hasOwn(mixedInvalid, 'DAYTONA_ORGANIZATION_ID'), true,
    'invalid metadata is rejected before any known field is deleted');
});

test('fails closed on manifest, executable, platform, identity, version, environment, and argv drift', async () => {
  const cases = [
    { mutate: (value) => { value.argv = ['--expected-build-hash', HASH('0')]; }, expected: /build identity|hash/i },
    { mutate: (value) => { value.primitives = { ...value.primitives, platform: async () => 'darwin' }; }, expected: /linux/i },
    { mutate: (value) => { value.primitives = { ...value.primitives, effectiveUid: async () => 2001 }; }, expected: /root|uid/i },
    { mutate: (value) => { value.primitives = { ...value.primitives, readManifest: async () => Buffer.from('{}') }; }, expected: /manifest|schema|canonical/i },
    { mutate: (value) => {
      const inspections = new Map(value.inspections);
      inspections.set('/usr/local/bin/node', { ...inspections.get('/usr/local/bin/node'), sha256: HASH('0') });
      value.primitives = { ...value.primitives, inspectExecutable: async ({ file }) => inspections.get(file) };
    }, expected: /executable|digest|hash/i },
    { mutate: (value) => {
      const inspections = new Map(value.inspections);
      inspections.delete('/usr/lib/libgcc_s.so.1');
      value.primitives = { ...value.primitives, inspectExecutable: async ({ file }) => inspections.get(file) };
    }, expected: /runtime|closure|file|digest|hash/i },
    { mutate: (value) => {
      const inspections = new Map(value.inspections);
      inspections.set('/usr/lib/libstdc++.so.6', {
        ...inspections.get('/usr/lib/libstdc++.so.6'),
        mode: 0o644,
      });
      value.primitives = { ...value.primitives, inspectExecutable: async ({ file }) => inspections.get(file) };
    }, expected: /runtime|closure|mode|file/i },
    { mutate: (value) => { value.primitives = { ...value.primitives, runCommand: async () => ({ code: 0, stdout: 'wrong\n', stderr: '' }) }; }, expected: /version|closure/i },
    { mutate: (value) => { value.environment = { OPENROUTER_API_KEY: 'forbidden' }; }, expected: /environment|credential/i },
    { mutate: (value) => { value.argv = []; }, expected: /invocation|argv/i },
  ];
  for (const entry of cases) {
    const value = { ...fixture(), environment: {}, argv: null };
    value.argv = ['--expected-build-hash', value.artifact.buildHash];
    entry.mutate(value);
    await assert.rejects(
      runSnapshotSelfTestCli({
        argv: value.argv,
        environment: value.environment,
        output: sink().output,
        primitives: value.primitives,
      }),
      entry.expected,
    );
  }
});

test('the process entry point emits only an authenticated content-free failure code', async () => {
  const input = fixture();
  const target = sink();
  const secret = 'sk-or-v1-never-emit-this-provider-key';

  const code = await runSnapshotSelfTestMain({
    argv: ['--expected-build-hash', input.artifact.buildHash],
    environment: { OPENROUTER_API_KEY: secret },
    output: target.output,
    primitives: input.primitives,
  });

  assert.equal(code, 70);
  assert.equal(target.read(),
    'ENGINEER-SNAPSHOT-FAILURE/1 ERR_SNAPSHOT_SELFTEST_ENVIRONMENT\n');
  assert.equal(parseSnapshotSelfTestFailure(target.read()),
    'ERR_SNAPSHOT_SELFTEST_ENVIRONMENT');
  assert.equal(target.read().includes(secret), false);
  assert.equal(parseSnapshotSelfTestFailure(
    'ENGINEER-SNAPSHOT-FAILURE/1 ERR_SNAPSHOT_SELFTEST_NOT_AUTHENTICATED\n'), null);

  const unexpected = sink();
  const unexpectedCode = await runSnapshotSelfTestMain({
    argv: ['--expected-build-hash', input.artifact.buildHash],
    environment: {},
    output: unexpected.output,
    primitives: {
      ...input.primitives,
      async platform() { throw new Error(secret); },
    },
  });
  assert.equal(unexpectedCode, 70);
  assert.equal(unexpected.read(), 'ENGINEER-SNAPSHOT-FAILURE/1 ERR_SNAPSHOT_SELFTEST\n');
  assert.equal(unexpected.read().includes(secret), false);
});
