import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  DaytonaSnapshotControllerError,
  createDaytonaSnapshotController,
} from '../../../evals/runtime/daytona-snapshot-controller.mjs';
import { hasCredentialMarker } from '../../../evals/runtime/credential-material.mjs';
import { buildDeterministicUstar } from '../../../evals/runtime/deterministic-ustar.mjs';
import { buildSnapshotBuildManifest } from '../../../evals/runtime/snapshot-build-manifest.mjs';
import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
} from '../../../evals/runtime/daytona-topology.mjs';

const HASH = (character) => character.repeat(64);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function removeQuarantinedCustody(directory) {
  if (!directory || !fs.existsSync(directory)) return;
  assert.match(path.basename(directory), /^engineer-snapshot-custody-[A-Za-z0-9]+$/);
  fs.chmodSync(directory, 0o700);
  fs.rmSync(directory, { recursive: true, force: false });
}

function files(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daytona-snapshot-controller-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dockerfilePath = path.join(directory, 'Dockerfile');
  const dockerfile = overrides.dockerfile ?? [
    'FROM scratch',
    'ADD runtime.tar /',
    'ADD harbor.tar /',
    'ADD node.tar /',
    'ADD native.tar /',
    'COPY build-manifest.json /opt/engineer/snapshot/build-manifest.json',
    '',
  ].join('\n');
  const first = overrides.first ?? 'deterministic runtime archive';
  const second = overrides.second ?? 'deterministic native archive';
  fs.writeFileSync(dockerfilePath, dockerfile);

  const definition = Buffer.from('{"schema":"test-runtime-definition"}\n');
  const contextInputs = {
    runtime: [
      ['opt/engineer/snapshot/snapshot-definition.json', definition, false],
      ['runtime/bin/tool', first, true],
    ],
    harbor: [['harbor/bin/tool', 'harbor', true]],
    node: [['node/bin/tool', 'node', true]],
    native: [['native/bin/tool', second, true]],
  };
  const contexts = {};
  const archiveRecords = [];
  for (const [kind, entries] of Object.entries(contextInputs)) {
    const root = path.join(directory, `source-${kind}`);
    const exemptions = [];
    for (const [relative, content, executable] of entries) {
      const target = path.join(root, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      fs.chmodSync(target, executable ? 0o755 : 0o644);
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      if (executable && hasCredentialMarker(bytes)) {
        exemptions.push({ path: relative, sha256: sha256(bytes) });
      }
    }
    const built = buildDeterministicUstar({
      kind,
      root,
      ...(exemptions.length > 0 ? { credentialScanExemptions: exemptions } : {}),
    });
    const archivePath = path.join(directory, `${kind}.tar`);
    fs.writeFileSync(archivePath, built.bytes);
    contexts[kind] = built.context;
    archiveRecords.push({
      path: archivePath,
      sha256: built.context.sha256,
      kind,
      encoding: 'ustar',
    });
  }

  const runtimeTool = contexts.runtime.entries.find((entry) => entry.path === 'runtime/bin/tool');
  const nativeTool = contexts.native.entries.find((entry) => entry.path === 'native/bin/tool');
  const artifact = buildSnapshotBuildManifest({
    dockerfile: { byteLength: Buffer.byteLength(dockerfile), sha256: sha256(dockerfile) },
    definition: { byteLength: definition.length, sha256: sha256(definition) },
    contexts,
    executables: {
      supervisor: {
        path: '/opt/engineer/bin/engineer-runtime-supervisor',
        sha256: runtimeTool.sha256,
        context: 'runtime',
        sourcePath: runtimeTool.path,
      },
      snapshotSelfTest: {
        path: '/opt/engineer/bin/engineer-snapshot-selftest',
        sha256: nativeTool.sha256,
        context: 'native',
        sourcePath: nativeTool.path,
      },
      taskIsolationProbe: {
        path: '/opt/engineer/bin/engineer-task-isolation-probe',
        sha256: nativeTool.sha256,
        context: 'native',
        sourcePath: nativeTool.path,
      },
      readinessDenialProbe: {
        path: '/opt/engineer/bin/engineer-readiness-denial-probe',
        sha256: nativeTool.sha256,
        context: 'native',
        sourcePath: nativeTool.path,
      },
    },
    provenance: {
      baseImage: { reference: DAYTONA_DIND_BASE_IMAGE, digest: DAYTONA_DIND_BASE_IMAGE_DIGEST },
      harbor: {
        version: 'v0.20.0',
        commit: '459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc',
        lockSha256: HASH('7'),
      },
      node: { version: 'v22.17.1', platform: 'linux-x64', archiveSha256: HASH('8') },
      nativeHelper: {
        sourceSha256: HASH('9'),
        compilerImage: `alpine:3.22@sha256:${HASH('b')}`,
        compilerImageDigest: `sha256:${HASH('b')}`,
        binarySha256: nativeTool.sha256,
      },
      taskIsolationProbe: {
        sourceSha256: HASH('a'),
        compilerImage: `alpine:3.22@sha256:${HASH('b')}`,
        compilerImageDigest: `sha256:${HASH('b')}`,
        binarySha256: nativeTool.sha256,
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-task-isolation-probe',
      },
      readinessDenialProbe: {
        sourceSha256: HASH('a'),
        compilerImage: `alpine:3.22@sha256:${HASH('b')}`,
        compilerImageDigest: `sha256:${HASH('b')}`,
        binarySha256: nativeTool.sha256,
        platform: 'linux/amd64',
        artifactPath: '/opt/engineer/bin/engineer-readiness-denial-probe',
      },
    },
    bindings: {
      releaseSha: 'c'.repeat(40), taskLockHash: HASH('c'), bundleHash: HASH('d'),
      budgetPolicyHash: HASH('e'), brokerPolicyHash: HASH('f'),
      profileId: 'kimi-k2.7-code', sessionCeilingMicrousd: 1_300_000,
    },
    taskImages: {
      'cobol-modernization': {
        immutableImage: `alexgshaw/cobol-modernization@sha256:${HASH('f')}`,
        imageId: `sha256:${HASH('f')}`,
        platform: 'linux/amd64', cpus: 1, memoryMb: 2048, storageMb: 10240,
      },
    },
  });
  const manifestPath = path.join(directory, 'build-manifest.json');
  fs.writeFileSync(manifestPath, artifact.canonicalJson);
  archiveRecords.push({
    path: manifestPath,
    sha256: artifact.buildHash,
    kind: 'manifest',
    encoding: 'snapshot-manifest',
  });
  const orderedArchives = [...archiveRecords]
    .sort((left, right) => path.basename(left.path).localeCompare(path.basename(right.path)))
    .map((record) => record.path);
  return {
    dockerfile,
    dockerfilePath,
    archives: archiveRecords,
    orderedArchives,
    identity: { name: artifact.snapshotName, buildHash: artifact.buildHash },
    sandboxNamePrefix: `${artifact.snapshotName}-selftest-`,
  };
}

function snapshotRecord(input, overrides = {}) {
  return {
    id: `snapshot-${input.identity.buildHash.slice(0, 16)}`,
    name: input.identity.name,
    state: 'active',
    cpu: 2,
    mem: 4,
    disk: 10,
    gpu: 0,
    general: false,
    sandboxClass: 'container',
    regionIds: ['us'],
    skipValidation: false,
    errorReason: null,
    ...overrides,
  };
}

function fillerRecord(index) {
  return {
    id: `filler-${String(index).padStart(4, '0')}`,
    name: `unrelated-${String(index).padStart(4, '0')}`,
    state: 'active',
  };
}

function sandboxRecord(input, overrides = {}) {
  return {
    id: 'sandbox-validation-0001',
    name: input.sandboxName,
    snapshot: input.identity.name,
    state: 'started',
    desiredState: 'started',
    target: 'us',
    sandboxClass: 'container',
    cpu: 2,
    memory: 4096,
    disk: 10,
    networkBlockAll: true,
    env: {},
    volumes: [],
    public: false,
    ...overrides,
  };
}

function exactNotFound(identity) {
  return {
    code: 1,
    stdout: '',
    stderr: `time="2026-08-04T20:00:00Z" level=fatal msg="Not Found: Sandbox with ID or name ${identity} not found"\n`,
  };
}

function fakeDaytona(input, {
  initialSnapshots = [],
  mode = null,
  sandboxOverrides = {},
  selfTestStdout = null,
} = {}) {
  const calls = [];
  const snapshots = [...initialSnapshots];
  let sandbox = null;
  let snapshotCreateAttempted = false;
  let snapshotDeleteAttempted = false;
  let sandboxDeleteAttempted = false;

  const runCommand = async (args) => {
    assert.equal(Object.isFrozen(args), true, 'the injected runner receives immutable argv');
    calls.push([...args]);

    if (args[0] === '--version') {
      if (mode === 'version') return { code: 0, stdout: 'Daytona CLI version v0.204.0\n', stderr: '' };
      return { code: 0, stdout: 'Daytona CLI version v0.203.0\n', stderr: '' };
    }

    if (args[0] === 'snapshot' && args[1] === 'list') {
      const page = Number(args[args.indexOf('--page') + 1]);
      const phase = snapshotDeleteAttempted ? 'cleanup' : snapshotCreateAttempted ? 'post-create' : 'initial';
      if (mode === `${phase}-command`) return { code: 75, stdout: '', stderr: 'provider failure' };
      if (mode === `${phase}-malformed`) return { code: 0, stdout: '{not-json', stderr: '' };
      const pageRecords = snapshots.slice((page - 1) * 200, page * 200);
      return { code: 0, stdout: JSON.stringify(pageRecords), stderr: '' };
    }

    if (args[0] === 'snapshot' && args[1] === 'create') {
      snapshotCreateAttempted = true;
      snapshots.push(snapshotRecord(input));
      if (mode === 'snapshot-create') return { code: 70, stdout: '', stderr: 'partial build failure' };
      return { code: 0, stdout: 'snapshot build complete\n', stderr: '' };
    }

    if (args[0] === 'snapshot' && args[1] === 'delete') {
      snapshotDeleteAttempted = true;
      if (mode !== 'snapshot-cleanup-stuck') {
        const index = snapshots.findIndex((entry) => entry.id === args[2] || entry.name === args[2]);
        if (index >= 0) snapshots.splice(index, 1);
      }
      if (mode === 'snapshot-cleanup-command') {
        return { code: 70, stdout: '', stderr: 'delete request lost' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }

    if (args[0] === 'create') {
      sandbox = sandboxRecord(input, {
        name: args[args.indexOf('--name') + 1],
        ...sandboxOverrides,
      });
      if (mode === 'sandbox-create') return { code: 70, stdout: '', stderr: 'partial sandbox failure' };
      return { code: 0, stdout: '', stderr: '' };
    }

    if (args[0] === 'exec') {
      if (mode === 'selftest') return { code: 70, stdout: 'failed detail', stderr: 'selftest failure' };
      if (mode === 'selftest-secret') return { code: 0, stdout: 'sk-or-v1-never-retain-this', stderr: '' };
      if (mode === 'selftest-mismatch') return { code: 0, stdout: `ENGINEER-SNAPSHOT/1 ${'b'.repeat(64)}\n`, stderr: '' };
      return {
        code: 0,
        stdout: selfTestStdout ?? `ENGINEER-SNAPSHOT/1 ${input.identity.buildHash}\n`,
        stderr: '',
      };
    }

    if (args[0] === 'info') {
      if (sandbox) {
        if (mode === 'sandbox-info-command') {
          return { code: 75, stdout: '', stderr: 'inspection unavailable' };
        }
        if (mode === 'sandbox-info-malformed') {
          return { code: 0, stdout: '{not-json', stderr: '' };
        }
        const observed = mode === 'sandbox-inspect'
          ? { ...sandbox, snapshot: 'wrong-snapshot' }
          : sandbox;
        return { code: 0, stdout: JSON.stringify(observed), stderr: '' };
      }
      if (mode === 'not-found-drift' && sandboxDeleteAttempted) {
        return { code: 1, stdout: '', stderr: 'Not Found\n' };
      }
      return exactNotFound(args[1]);
    }

    if (args[0] === 'delete') {
      sandboxDeleteAttempted = true;
      sandbox = null;
      if (mode === 'sandbox-delete') return { code: 70, stdout: '', stderr: 'delete response lost' };
      return { code: 0, stdout: '', stderr: '' };
    }

    throw new Error(`unexpected fake argv: ${args.join(' ')}`);
  };

  return {
    calls,
    runCommand,
    snapshots,
    get sandbox() { return sandbox; },
    get snapshotDeleteAttempted() { return snapshotDeleteAttempted; },
  };
}

function controller(fake, overrides = {}) {
  return createDaytonaSnapshotController({
    runCommand: fake.runCommand,
    cleanupPollAttempts: 3,
    cleanupPollIntervalMs: 0,
    ...overrides,
  });
}

function request(input, overrides = {}) {
  return {
    identity: input.identity,
    dockerfilePath: input.dockerfilePath,
    archives: input.archives,
    ...overrides,
  };
}

async function rejected(promise) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, 'operation must reject');
  return error;
}

test('creates, validates, and retains one content-addressed snapshot with exact direct argv', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input);
  const receipt = await controller(fake).ensureSnapshot(request(input));

  assert.deepEqual(fake.calls[0], ['--version']);
  assert.deepEqual(fake.calls[1], ['snapshot', 'list', '--format', 'json', '--limit', '200', '--page', '1']);
  const createCall = fake.calls[2];
  assert.deepEqual(createCall.slice(0, 3), ['snapshot', 'create', input.identity.name]);
  const dockerfileArgument = createCall[createCall.indexOf('--dockerfile') + 1];
  assert.equal(path.basename(dockerfileArgument), 'Dockerfile');
  assert.notEqual(dockerfileArgument, input.dockerfilePath);
  const contextArguments = createCall.flatMap((value, index) =>
    createCall[index - 1] === '--context' ? [value] : []);
  assert.deepEqual(contextArguments.map((value) => path.basename(value)), [
    'build-manifest.json', 'harbor.tar', 'native.tar', 'node.tar', 'runtime.tar',
  ]);
  assert.equal(contextArguments.some((value) => input.orderedArchives.includes(value)), false);
  assert.deepEqual(createCall.slice(-10), [
    '--cpu', '2', '--memory', '4', '--disk', '10', '--region', 'us',
    '--sandbox-class', 'container',
  ]);
  assert.deepEqual(fake.calls[3], ['snapshot', 'list', '--format', 'json', '--limit', '200', '--page', '1']);
  const sandboxName = fake.calls[4][2];
  assert.match(sandboxName, new RegExp(`^${input.sandboxNamePrefix}[a-f0-9]{32}$`));
  assert.deepEqual(fake.calls[4], [
    'create', '--name', sandboxName, '--snapshot', input.identity.name,
    '--target', 'us', '--network-block-all', '--auto-stop', '0', '--ttl', '30',
  ]);
  assert.equal(['--cpu', '--memory', '--disk'].some((flag) => fake.calls[4].includes(flag)), false,
    'a sandbox created from a resource-bound snapshot must not restate resource flags');
  assert.deepEqual(fake.calls[5], [
    'exec', sandboxName, '--',
    '/opt/engineer/bin/engineer-snapshot-selftest', '--expected-build-hash', input.identity.buildHash,
  ]);
  assert.deepEqual(fake.calls[6], ['info', sandboxName, '--format', 'json']);
  assert.deepEqual(fake.calls[7], ['delete', 'sandbox-validation-0001']);
  assert.deepEqual(fake.calls[8], ['info', 'sandbox-validation-0001', '--format', 'json']);
  assert.equal(fake.calls.some((args) => args[0] === 'snapshot' && args[1] === 'delete'), false);

  assert.deepEqual(receipt, {
    schema: 'engineer-daytona-snapshot-lifecycle-receipt.v1',
    name: input.identity.name,
    snapshotId: `snapshot-${input.identity.buildHash.slice(0, 16)}`,
    buildHash: input.identity.buildHash,
    status: 'active',
    created: true,
    retained: true,
    archiveCount: 5,
    validation: {
      performed: true,
      sandboxId: 'sandbox-validation-0001',
      networkBlocked: true,
      selfTestExitCode: 0,
      selfTestStdoutBytes: Buffer.byteLength(`ENGINEER-SNAPSHOT/1 ${input.identity.buildHash}\n`),
      selfTestStdoutSha256: sha256(`ENGINEER-SNAPSHOT/1 ${input.identity.buildHash}\n`),
      selfTestStderrBytes: 0,
      selfTestStderrSha256: sha256(''),
      sandboxDeleted: true,
    },
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(input.dockerfile), false);
  assert.equal(input.orderedArchives.some((archivePath) => serialized.includes(archivePath)), false);
});

test('custodies verified files through snapshot creation instead of reopening caller paths', async (t) => {
  const input = files(t);
  const original = fs.readFileSync(input.orderedArchives[0]);
  const fake = fakeDaytona(input);
  const originalRun = fake.runCommand;
  let custodyPaths = [];
  fake.runCommand = async (args) => {
    if (args[0] === 'snapshot' && args[1] === 'create') {
      custodyPaths = args.flatMap((value, index) => args[index - 1] === '--context' ? [value] : []);
      assert.equal(custodyPaths.includes(input.orderedArchives[0]), false);
      fs.writeFileSync(input.orderedArchives[0], 'replacement contains sk-proj-abcdefghijklmnop');
      assert.deepEqual(fs.readFileSync(custodyPaths[0]), original);
    }
    return originalRun(args);
  };

  await controller(fake).ensureSnapshot(request(input));
  assert.ok(custodyPaths.length > 0);
  assert.equal(custodyPaths.every((file) => !fs.existsSync(file)), true);
});

test('detects custody mutation during snapshot upload, rolls back, and quarantines custody', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input);
  const originalRun = fake.runCommand;
  let mutatedPath = null;
  t.after(() => removeQuarantinedCustody(mutatedPath && path.dirname(mutatedPath)));
  fake.runCommand = async (args) => {
    const result = await originalRun(args);
    if (args[0] === 'snapshot' && args[1] === 'create') {
      mutatedPath = args[args.indexOf('--context') + 1];
      fs.chmodSync(mutatedPath, 0o600);
      fs.writeFileSync(mutatedPath, 'changed during upload');
    }
    return result;
  };

  await assert.rejects(
    controller(fake).ensureSnapshot(request(input)),
    /custody|changed|rollback/i,
  );
  assert.equal(fake.snapshotDeleteAttempted, true);
  assert.ok(mutatedPath);
  assert.equal(fs.existsSync(path.dirname(mutatedPath)), true);
});

test('does not follow a substituted custody directory during rollback cleanup', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input);
  const originalRun = fake.runCommand;
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-cleanup-victim-'));
  const sentinel = path.join(victim, 'sentinel');
  fs.writeFileSync(sentinel, 'retain');
  let custodyDirectory = null;
  let retainedDirectory = null;
  t.after(() => {
    if (custodyDirectory && fs.lstatSync(custodyDirectory, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.unlinkSync(custodyDirectory);
    }
    if (retainedDirectory && fs.existsSync(retainedDirectory)) {
      fs.chmodSync(retainedDirectory, 0o700);
      fs.rmSync(retainedDirectory, { recursive: true, force: true });
    }
    fs.rmSync(victim, { recursive: true, force: true });
  });
  fake.runCommand = async (args) => {
    const result = await originalRun(args);
    if (args[0] === 'snapshot' && args[1] === 'create') {
      custodyDirectory = path.dirname(args[args.indexOf('--context') + 1]);
      retainedDirectory = `${custodyDirectory}-retained`;
      fs.renameSync(custodyDirectory, retainedDirectory);
      fs.symlinkSync(victim, custodyDirectory, 'dir');
    }
    return result;
  };

  await assert.rejects(
    controller(fake).ensureSnapshot(request(input)),
    /custody|changed|rollback|cleanup/i,
  );
  assert.equal(fake.snapshotDeleteAttempted, true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'retain');
  assert.equal(fs.lstatSync(custodyDirectory).isSymbolicLink(), true);
  assert.equal(fs.existsSync(retainedDirectory), true);
});

test('revalidates custody immediately before upload and starts no snapshot after earlier drift', async (t) => {
  const input = files(t);
  const existingCustody = new Set(fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('engineer-snapshot-custody-')));
  const fake = fakeDaytona(input);
  const originalRun = fake.runCommand;
  let custodyDirectory = null;
  t.after(() => removeQuarantinedCustody(custodyDirectory));
  fake.runCommand = async (args) => {
    if (args[0] === 'snapshot' && args[1] === 'list' && custodyDirectory === null) {
      const candidate = fs.readdirSync(os.tmpdir())
        .find((name) => name.startsWith('engineer-snapshot-custody-') && !existingCustody.has(name));
      assert.ok(candidate);
      custodyDirectory = path.join(os.tmpdir(), candidate);
      fs.chmodSync(custodyDirectory, 0o700);
      const runtime = path.join(custodyDirectory, 'runtime.tar');
      fs.chmodSync(runtime, 0o600);
      fs.writeFileSync(runtime, 'changed before upload');
    }
    return originalRun(args);
  };

  await assert.rejects(
    controller(fake).ensureSnapshot(request(input)),
    /custody|changed|lifecycle/i,
  );
  assert.equal(fake.calls.some((args) => args[0] === 'snapshot' && args[1] === 'create'), false);
  assert.ok(custodyDirectory);
  assert.equal(fs.existsSync(custodyDirectory), true);
});

test('rejects a marker-free malformed archive before Daytona', async (t) => {
  const input = files(t);
  const runtime = input.archives.find((record) => record.kind === 'runtime');
  const corrupted = fs.readFileSync(runtime.path);
  corrupted[0] ^= 0x01;
  fs.writeFileSync(runtime.path, corrupted);
  runtime.sha256 = sha256(corrupted);
  const fake = fakeDaytona(input);
  await assert.rejects(
    controller(fake).ensureSnapshot(request(input)),
    /archive|ustar|deterministic|credential/i,
  );
  assert.equal(fake.calls.length, 0);
});

test('removes a partial custody inventory when preparation fails', async (t) => {
  const input = files(t);
  const before = new Set(fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('engineer-snapshot-custody-')));
  const malformedArchives = input.archives.map((record) => record.kind === 'node'
    ? { ...record, path: path.dirname(input.dockerfilePath) }
    : record);
  const fake = fakeDaytona(input);
  await assert.rejects(
    controller(fake).ensureSnapshot(request(input, { archives: malformedArchives })),
    /regular file|custody|context/i,
  );
  const after = fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('engineer-snapshot-custody-') && !before.has(name));
  assert.deepEqual(after, []);
  assert.equal(fake.calls.length, 0);
});

test('paginates and revalidates an exact active content-addressed snapshot before reuse', async (t) => {
  const input = files(t);
  const records = Array.from({ length: 200 }, (_, index) => fillerRecord(index));
  records.push(snapshotRecord(input));
  const fake = fakeDaytona(input, { initialSnapshots: records });

  const receipt = await controller(fake).ensureSnapshot(request(input));

  const sandboxName = fake.calls[3][2];
  assert.match(sandboxName, new RegExp(`^${input.sandboxNamePrefix}[a-f0-9]{32}$`));
  assert.deepEqual(fake.calls, [
    ['--version'],
    ['snapshot', 'list', '--format', 'json', '--limit', '200', '--page', '1'],
    ['snapshot', 'list', '--format', 'json', '--limit', '200', '--page', '2'],
    [
      'create', '--name', sandboxName, '--snapshot', input.identity.name,
      '--target', 'us', '--network-block-all', '--auto-stop', '0', '--ttl', '30',
    ],
    [
      'exec', sandboxName, '--',
      '/opt/engineer/bin/engineer-snapshot-selftest', '--expected-build-hash', input.identity.buildHash,
    ],
    ['info', sandboxName, '--format', 'json'],
    ['delete', 'sandbox-validation-0001'],
    ['info', 'sandbox-validation-0001', '--format', 'json'],
  ]);
  assert.equal(receipt.created, false);
  assert.equal(receipt.retained, true);
  assert.equal(receipt.validation.performed, true);
  assert.equal(receipt.validation.networkBlocked, true);
  assert.equal(receipt.validation.sandboxDeleted, true);
});

test('accepts slash-bearing Daytona names only as unrelated bounded list data', async (t) => {
  const input = files(t);
  const upstream = {
    ...fillerRecord(0),
    name: 'daytona/default-runtime',
  };
  const owned = snapshotRecord(input);
  const fake = fakeDaytona(input, { initialSnapshots: [upstream, owned] });

  const receipt = await controller(fake).ensureSnapshot(request(input));

  assert.equal(receipt.created, false);
  assert.equal(receipt.name, input.identity.name);
  assert.equal(receipt.snapshotId, owned.id);
  assert.equal(fake.calls.some((args) =>
    args[0] === 'snapshot' && args[1] === 'create'), false);
  const sandboxCreate = fake.calls.find(([command]) => command === 'create');
  assert.equal(sandboxCreate[sandboxCreate.indexOf('--snapshot') + 1], input.identity.name);
  assert.equal(fake.calls.some((args) => args.includes(upstream.name)), false,
    'an unrelated list name must never become a command argument');
});

test('keeps slash-bearing command identities and unsafe list names fail-closed', async (t) => {
  const input = files(t);
  const invalidRecords = [
    { ...fillerRecord(0), id: 'tenant/snapshot-id' },
    { ...fillerRecord(0), name: '/leading' },
    { ...fillerRecord(0), name: 'trailing/' },
    { ...fillerRecord(0), name: 'tenant//snapshot' },
    { ...fillerRecord(0), name: 'tenant/../snapshot' },
    { ...fillerRecord(0), name: 'tenant\\snapshot' },
    { ...fillerRecord(0), name: 'tenant snapshot' },
    { ...fillerRecord(0), name: 'tenant/snäpshot' },
    { ...fillerRecord(0), name: `tenant/${'a'.repeat(193)}` },
    { ...fillerRecord(0), name: 'tenant/sk-or-v1-forbidden-provider-key' },
  ];

  for (const record of invalidRecords) {
    const fake = fakeDaytona(input, { initialSnapshots: [record] });
    await assert.rejects(controller(fake).ensureSnapshot(request(input)),
      /snapshot|credential|malformed/i);
    assert.equal(fake.calls.some((args) =>
      args[0] === 'create' || args[0] === 'delete' ||
      args[0] === 'snapshot' && ['create', 'delete'].includes(args[1])), false);
  }
});

test('fails closed on malformed pages, duplicate identities, and mismatched matching records', async (t) => {
  const input = files(t);

  const malformed = fakeDaytona(input, { mode: 'initial-malformed' });
  await assert.rejects(controller(malformed).ensureSnapshot(request(input)), /snapshot list.*malformed/i);
  assert.equal(malformed.calls.some((args) => args[0] === 'snapshot' && args[1] === 'create'), false);

  const duplicateId = fillerRecord(0);
  const firstPage = Array.from({ length: 200 }, (_, index) => fillerRecord(index));
  const duplicates = fakeDaytona(input, {
    initialSnapshots: [...firstPage, { ...fillerRecord(200), id: duplicateId.id }],
  });
  await assert.rejects(controller(duplicates).ensureSnapshot(request(input)), /duplicate.*snapshot/i);

  const slashName = 'daytona/default-runtime';
  const slashFirstPage = [
    { ...fillerRecord(0), name: slashName },
    ...Array.from({ length: 199 }, (_, index) => fillerRecord(index + 1)),
  ];
  const duplicateSlashName = fakeDaytona(input, {
    initialSnapshots: [...slashFirstPage, { ...fillerRecord(200), name: slashName }],
  });
  await assert.rejects(
    controller(duplicateSlashName).ensureSnapshot(request(input)),
    /duplicate.*snapshot/i,
  );

  for (const mutation of [
    { state: 'building' },
    { mem: 8 },
    { regionIds: ['eu'] },
    { sandboxClass: 'linux-vm' },
    { general: true },
    { skipValidation: true },
  ]) {
    const mismatch = fakeDaytona(input, { initialSnapshots: [snapshotRecord(input, mutation)] });
    await assert.rejects(controller(mismatch).ensureSnapshot(request(input)), /snapshot record.*match/i,
      JSON.stringify(mutation));
    assert.equal(mismatch.snapshotDeleteAttempted, false, 'an existing mismatched resource is never deleted');
  }
});

test('version and initial-list failures stop before any resource-changing command', async (t) => {
  const input = files(t);
  for (const mode of ['version', 'initial-command']) {
    const fake = fakeDaytona(input, { mode });
    await assert.rejects(controller(fake).ensureSnapshot(request(input)), /version|snapshot list/i, mode);
    assert.equal(fake.calls.some((args) =>
      args[0] === 'create' || args[0] === 'delete' ||
      args[0] === 'snapshot' && ['create', 'delete'].includes(args[1])), false, mode);
  }
});

test('rejects every mismatched resource inherited by a snapshot validation sandbox', async (t) => {
  const input = files(t);
  for (const sandboxOverrides of [
    { cpu: 1 },
    { memory: 2048 },
    { disk: 9 },
  ]) {
    const fake = fakeDaytona(input, { sandboxOverrides });
    const error = await rejected(controller(fake).ensureSnapshot(request(input)));

    assert.equal(error.code, 'ERR_SNAPSHOT_SANDBOX_MISMATCH', JSON.stringify(sandboxOverrides));
    assert.equal(fake.sandbox, null, 'the mismatched validation sandbox must be deleted');
    assert.equal(fake.snapshotDeleteAttempted, true,
      'a newly created snapshot with mismatched inherited resources must be rolled back');
    assert.equal(fake.snapshots.some((entry) => entry.name === input.identity.name), false,
      'the rejected release snapshot must be absent after rollback');
  }
});

test('every failure after snapshot ownership is proven deletes the exact id and proves absence', async (t) => {
  const input = files(t);
  for (const mode of [
    'sandbox-create',
    'selftest',
    'selftest-mismatch',
    'sandbox-info-command',
    'sandbox-info-malformed',
    'sandbox-inspect',
    'not-found-drift',
  ]) {
    const fake = fakeDaytona(input, { mode });
    await assert.rejects(controller(fake).ensureSnapshot(request(input)), undefined, mode);
    assert.equal(fake.snapshotDeleteAttempted, true, `${mode} must request snapshot rollback`);
    assert.equal(fake.snapshots.some((entry) => entry.name === input.identity.name), false,
      `${mode} must leave no failed release snapshot`);
    const deleteIndex = fake.calls.findIndex((args) => args[0] === 'snapshot' && args[1] === 'delete');
    assert.ok(deleteIndex >= 0, `${mode} must call snapshot delete`);
    assert.equal(fake.calls[deleteIndex][2], snapshotRecord(input).id,
      `${mode} must delete only the observed owned snapshot id`);
    assert.ok(fake.calls.slice(deleteIndex + 1).some((args) =>
      args[0] === 'snapshot' && args[1] === 'list' && args.includes('--page')),
    `${mode} must prove absence with the paginated list API`);
  }
});

test('a lost sandbox-delete response is accepted only after exact absence is proven', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, {
    initialSnapshots: [snapshotRecord(input)],
    mode: 'sandbox-delete',
  });

  const receipt = await controller(fake).ensureSnapshot(request(input));

  assert.equal(receipt.validation.sandboxDeleted, true);
  const deleteIndex = fake.calls.findIndex((args) => args[0] === 'delete');
  assert.ok(deleteIndex >= 0);
  assert.equal(fake.calls.slice(deleteIndex + 1).some((args) => args[0] === 'info'), true,
    'exact absence is observed after the lost delete response');
});

test('ambiguous creation adopts a valid shared snapshot and never deletes an unowned identity', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { mode: 'snapshot-create' });

  const receipt = await controller(fake).ensureSnapshot(request(input));

  assert.equal(receipt.created, false);
  assert.equal(receipt.snapshotId, snapshotRecord(input).id);
  assert.equal(fake.snapshotDeleteAttempted, false);
  assert.equal(fake.snapshots.some((entry) => entry.id === receipt.snapshotId), true);
});

test('post-create observation failure never deletes a snapshot whose id was not proven', async (t) => {
  const input = files(t);
  for (const mode of ['post-create-command', 'post-create-malformed']) {
    const fake = fakeDaytona(input, { mode });
    await assert.rejects(controller(fake).ensureSnapshot(request(input)), /snapshot list|malformed/i, mode);
    assert.equal(fake.snapshotDeleteAttempted, false, `${mode} must not delete by shared name`);
    assert.equal(fake.snapshots.some((entry) => entry.name === input.identity.name), true);
  }
});

test('an existing same-name snapshot is accepted only after its embedded build identity passes self-test', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, {
    initialSnapshots: [snapshotRecord(input)],
    mode: 'selftest-mismatch',
  });

  await assert.rejects(controller(fake).ensureSnapshot(request(input)), /content identity|self-test|build hash/i);
  assert.equal(fake.snapshotDeleteAttempted, false, 'a pre-existing mismatched snapshot is not deleted implicitly');
  assert.equal(fake.sandbox, null, 'the validation sandbox is still deleted');
});

test('validation uses an attempt-unique name and never deletes a stale deterministic sandbox', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { initialSnapshots: [snapshotRecord(input)] });
  const original = fake.runCommand;
  const staleName = `${input.identity.name}-selftest`;
  const staleId = 'sandbox-stale-validation-0001';
  let staleDeleted = false;
  fake.runCommand = async (args) => {
    if (args[0] === 'delete' && [staleName, staleId].includes(args[1])) staleDeleted = true;
    return original(args);
  };

  const receipt = await controller(fake).ensureSnapshot(request(input));
  const attemptedName = fake.calls.find((args) => args[0] === 'create')[2];

  assert.match(attemptedName, new RegExp(`^${input.sandboxNamePrefix}[a-f0-9]{32}$`));
  assert.notEqual(attemptedName, staleName);
  assert.equal(staleDeleted, false);
  assert.equal(receipt.validation.sandboxDeleted, true);
});

test('the production cleanup bound survives Daytona deletion visibility beyond twenty observations', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { initialSnapshots: [snapshotRecord(input)] });
  const original = fake.runCommand;
  let deletionRequested = false;
  let deletionObservations = 0;
  fake.runCommand = async (args) => {
    if (args[0] === 'delete') {
      deletionRequested = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (deletionRequested && args[0] === 'info') {
      deletionObservations += 1;
      if (deletionObservations > 20) return exactNotFound(args[1]);
    }
    return original(args);
  };

  const receipt = await createDaytonaSnapshotController({
    runCommand: fake.runCommand,
    cleanupPollIntervalMs: 0,
  }).ensureSnapshot(request(input));

  assert.equal(deletionObservations, 21);
  assert.equal(receipt.validation.sandboxDeleted, true);
});

test('a dual validation and cleanup failure retains only stable causal error codes', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { mode: 'selftest-mismatch' });
  const original = fake.runCommand;
  let deletionRequested = false;
  fake.runCommand = async (args) => {
    if (args[0] === 'delete') {
      deletionRequested = true;
      return { code: 70, stdout: '', stderr: 'sandbox deletion pending' };
    }
    if (deletionRequested && args[0] === 'info') return original(args);
    return original(args);
  };

  const error = await rejected(controller(fake).ensureSnapshot(request(input)));

  assert.equal(error.code, 'ERR_SNAPSHOT_SANDBOX_CLEANUP');
  assert.match(error.message,
    /ERR_SNAPSHOT_SELFTEST_IDENTITY.*ERR_SNAPSHOT_SANDBOX_CLEANUP/);
  assert.doesNotMatch(error.message, /sandbox deletion pending/);
  assert.equal(fake.snapshotDeleteAttempted, true);
  assert.equal(fake.snapshots.some((entry) => entry.name === input.identity.name), false);
});

test('dual-failure diagnostics never execute or trust adversarial error-code properties', async (t) => {
  const credential = 'sk-or-v1-never-emit-from-an-error-code';
  let rotatingReads = 0;
  const rotating = Object.create(DaytonaSnapshotControllerError.prototype);
  Object.defineProperty(rotating, 'code', {
    configurable: true,
    get() {
      rotatingReads += 1;
      return rotatingReads < 3 ? 'ERR_SNAPSHOT_COMMAND' : credential;
    },
  });
  const throwing = Object.create(DaytonaSnapshotControllerError.prototype);
  Object.defineProperty(throwing, 'code', {
    configurable: true,
    get() { throw new Error('error-code getter executed'); },
  });
  const inherited = Object.create(new DaytonaSnapshotControllerError(
    'inherited controller error',
    'ERR_SNAPSHOT_COMMAND',
  ));
  const trapped = new Proxy(Object.create(DaytonaSnapshotControllerError.prototype), {
    getPrototypeOf() { throw new Error('error prototype trap executed'); },
  });

  for (const [label, lifecycleError] of [
    ['rotating accessor', rotating],
    ['throwing accessor', throwing],
    ['inherited code', inherited],
    ['proxy trap', trapped],
    ['primitive', 7],
    ['unknown code', Object.assign(new Error('unknown'), { code: 'ERR_NOT_REVIEWED' })],
  ]) {
    await t.test(label, async (subtest) => {
      const input = files(subtest);
      const fake = fakeDaytona(input, { initialSnapshots: [snapshotRecord(input)] });
      const original = fake.runCommand;
      let deletionRequested = false;
      fake.runCommand = async (args, commandOptions) => {
        if (args[0] === 'exec') {
          return new Proxy({}, {
            getPrototypeOf() { throw lifecycleError; },
          });
        }
        if (args[0] === 'delete') {
          deletionRequested = true;
          return { code: 70, stdout: '', stderr: 'sandbox deletion pending' };
        }
        if (deletionRequested && args[0] === 'info') return original(args, commandOptions);
        return original(args, commandOptions);
      };

      const error = await rejected(controller(fake).ensureSnapshot(request(input)));

      assert.equal(error.code, 'ERR_SNAPSHOT_SANDBOX_CLEANUP');
      assert.match(error.message,
        /ERR_SNAPSHOT_RUNNER_RESULT.*ERR_SNAPSHOT_SANDBOX_CLEANUP/);
      assert.equal(hasCredentialMarker(Buffer.from(error.message)), false);
      assert.doesNotMatch(error.message, /getter executed|prototype trap|ERR_NOT_REVIEWED/);
    });
  }
  assert.equal(rotatingReads, 0, 'an accessor-backed code is rejected without invocation');
});

test('a hostile returned runner value is collapsed before successful cleanup can rethrow it', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { initialSnapshots: [snapshotRecord(input)] });
  const original = fake.runCommand;
  const credential = 'sk-or-v1-never-escape-a-runner-result';
  const authenticatedTrapError = new DaytonaSnapshotControllerError(
    credential,
    'ERR_SNAPSHOT_COMMAND',
  );
  fake.runCommand = async (args, commandOptions) => {
    if (args[0] === 'exec') {
      return new Proxy({}, {
        getPrototypeOf() { throw authenticatedTrapError; },
      });
    }
    return original(args, commandOptions);
  };

  const error = await rejected(controller(fake).ensureSnapshot(request(input)));

  assert.equal(error.code, 'ERR_SNAPSHOT_RUNNER_RESULT');
  assert.equal(error.message, 'Daytona command runner returned an unsafe result');
  assert.equal(hasCredentialMarker(Buffer.from(error.message)), false);
  assert.equal(fake.sandbox, null, 'the temporary validation sandbox is still deleted');
});

test('controller errors expose only immutable authenticated codes', () => {
  const error = new DaytonaSnapshotControllerError('unknown', 'ERR_NOT_REVIEWED');
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');

  assert.equal(error.code, 'ERR_DAYTONA_SNAPSHOT_CONTROLLER');
  assert.deepEqual(descriptor, {
    configurable: false,
    enumerable: true,
    value: 'ERR_DAYTONA_SNAPSHOT_CONTROLLER',
    writable: false,
  });
  assert.throws(() => { error.code = 'ERR_SNAPSHOT_COMMAND'; }, TypeError);
  assert.throws(() => createDaytonaSnapshotController({
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    cleanupDeadlineMs: 10,
    cleanupCommandTimeoutMs: 11,
  }), /must not exceed/i);
});

test('cleanup is bounded by elapsed time and passes only the remaining budget to commands', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { initialSnapshots: [snapshotRecord(input)] });
  const original = fake.runCommand;
  const cleanupTimeouts = [];
  let nowMs = 0;
  let deletionRequested = false;
  fake.runCommand = async (args, commandOptions) => {
    if (args[0] === 'delete') {
      deletionRequested = true;
      cleanupTimeouts.push(commandOptions?.timeoutMs);
      nowMs += 15;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (deletionRequested && args[0] === 'info') {
      cleanupTimeouts.push(commandOptions?.timeoutMs);
      nowMs += 15;
      return original(args, commandOptions);
    }
    return original(args, commandOptions);
  };

  const error = await rejected(createDaytonaSnapshotController({
    runCommand: fake.runCommand,
    cleanupPollAttempts: 100,
    cleanupPollIntervalMs: 0,
    cleanupDeadlineMs: 30,
    cleanupCommandTimeoutMs: 20,
    monotonicNow: () => nowMs,
  }).ensureSnapshot(request(input)));

  assert.equal(error.code, 'ERR_SNAPSHOT_SANDBOX_CLEANUP');
  assert.deepEqual(cleanupTimeouts, [20, 15]);
  assert.equal(fake.calls.filter((args) => args[0] === 'info').length, 2,
    'one validation inspection and one bounded cleanup inspection occurred');
});

test('sandbox cleanup retries one transient command timeout and trusts later exact absence', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { initialSnapshots: [snapshotRecord(input)] });
  const original = fake.runCommand;
  let deletionRequested = false;
  let cleanupInspections = 0;
  fake.runCommand = async (args, commandOptions) => {
    if (args[0] === 'delete') {
      deletionRequested = true;
      return { code: 0, stdout: '', stderr: '', error: null };
    }
    if (deletionRequested && args[0] === 'info') {
      cleanupInspections += 1;
      if (cleanupInspections === 1) {
        return {
          code: null,
          stdout: '',
          stderr: '',
          error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
        };
      }
      return exactNotFound(args[1]);
    }
    return original(args, commandOptions);
  };

  const receipt = await controller(fake).ensureSnapshot(request(input));

  assert.equal(cleanupInspections, 2);
  assert.equal(receipt.validation.sandboxDeleted, true);
});

test('a production-shaped cleanup timeout retains its authenticated command cause', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { initialSnapshots: [snapshotRecord(input)] });
  const original = fake.runCommand;
  let deletionRequested = false;
  fake.runCommand = async (args, commandOptions) => {
    if (args[0] === 'delete') {
      deletionRequested = true;
      return { code: 0, stdout: '', stderr: '', error: null };
    }
    if (deletionRequested && args[0] === 'info') {
      return {
        code: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      };
    }
    return original(args, commandOptions);
  };

  const error = await rejected(controller(fake).ensureSnapshot(request(input)));

  assert.equal(error.code, 'ERR_SNAPSHOT_SANDBOX_CLEANUP');
  assert.match(error.message, /last cause ERR_SNAPSHOT_COMMAND/);
  assert.doesNotMatch(error.message, /ETIMEDOUT|timed out/);
});

test('rollback tolerates a lost snapshot-delete response only after all pages prove absence', async (t) => {
  const input = files(t);
  const initialSnapshots = Array.from({ length: 201 }, (_, index) => fillerRecord(index));
  const fake = fakeDaytona(input, { initialSnapshots, mode: 'selftest' });
  const original = fake.runCommand;
  const observedCalls = [];
  let nowMs = 0;
  let deleteResponseLost = false;
  fake.runCommand = async (args, commandOptions) => {
    observedCalls.push({ args: [...args], cleanupPhase: deleteResponseLost, commandOptions });
    if (args[0] === 'snapshot' && args[1] === 'delete') {
      await original(args, commandOptions);
      deleteResponseLost = true;
      nowMs += 7;
      return { code: 75, stdout: '', stderr: 'response lost' };
    }
    if (deleteResponseLost && args[0] === 'snapshot' && args[1] === 'list') nowMs += 7;
    return original(args, commandOptions);
  };

  await assert.rejects(controller(fake, {
    cleanupDeadlineMs: 30,
    cleanupCommandTimeoutMs: 20,
    monotonicNow: () => nowMs,
  }).ensureSnapshot(request(input)), /self-test/i);
  assert.equal(deleteResponseLost, true);
  const deleteIndex = fake.calls.findIndex((args) => args[0] === 'snapshot' && args[1] === 'delete');
  const cleanupPages = fake.calls.slice(deleteIndex + 1)
    .filter((args) => args[0] === 'snapshot' && args[1] === 'list')
    .map((args) => args[args.indexOf('--page') + 1]);
  assert.deepEqual(cleanupPages, ['1', '2']);
  const cleanupExecutions = observedCalls.filter(({ args, cleanupPhase }) =>
    args[0] === 'snapshot' && (args[1] === 'delete' || cleanupPhase && args[1] === 'list'));
  assert.equal(cleanupExecutions.length, 3);
  assert.deepEqual(cleanupExecutions.map(({ commandOptions }) => commandOptions.timeoutMs),
    [20, 20, 16], 'one rollback deadline shrinks across delete and every pagination page');
  assert.equal(cleanupExecutions.every(({ commandOptions }) => Object.isFrozen(commandOptions)), true);
  const ordinarySnapshotLists = observedCalls.filter(({ args, commandOptions }) =>
    args[0] === 'snapshot' && args[1] === 'list' && commandOptions === undefined);
  assert.equal(ordinarySnapshotLists.length > 0, true,
    'ordinary lifecycle listing does not inherit the cleanup timeout');
  assert.equal(fake.snapshots.some((entry) => entry.name === input.identity.name), false);
});

test('rollback stops pagination when its shared elapsed deadline expires', async (t) => {
  const input = files(t);
  const initialSnapshots = Array.from({ length: 201 }, (_, index) => fillerRecord(index));
  const fake = fakeDaytona(input, { initialSnapshots, mode: 'selftest' });
  const original = fake.runCommand;
  let cleanupPhase = false;
  let nowMs = 0;
  fake.runCommand = async (args, commandOptions) => {
    if (args[0] === 'snapshot' && args[1] === 'delete') {
      cleanupPhase = true;
      await original(args, commandOptions);
      nowMs += 5;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cleanupPhase && args[0] === 'snapshot' && args[1] === 'list') nowMs += 15;
    return original(args, commandOptions);
  };

  const error = await rejected(controller(fake, {
    cleanupDeadlineMs: 20,
    cleanupCommandTimeoutMs: 10,
    monotonicNow: () => nowMs,
  }).ensureSnapshot(request(input)));

  const deleteIndex = fake.calls.findIndex((args) => args[0] === 'snapshot' && args[1] === 'delete');
  const cleanupPages = fake.calls.slice(deleteIndex + 1)
    .filter((args) => args[0] === 'snapshot' && args[1] === 'list')
    .map((args) => args[args.indexOf('--page') + 1]);
  assert.equal(error.code, 'ERR_SNAPSHOT_ROLLBACK');
  assert.deepEqual(cleanupPages, ['1']);
});

test('cleanup fails closed when the new snapshot cannot be proven absent', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { mode: 'snapshot-cleanup-stuck' });
  const error = await rejected(controller(fake).ensureSnapshot({
    ...request(input),
    archives: input.archives.map((entry, index) => index === 0 ? { ...entry, sha256: 'b'.repeat(64) } : entry),
  }));
  assert.match(error.message, /digest/i);
  assert.equal(fake.calls.length, 0, 'invalid local input fails before a snapshot can exist');

  const stuck = fakeDaytona(input, { mode: 'selftest' });
  const originalDelete = stuck.runCommand;
  let deletingSnapshot = false;
  stuck.runCommand = async (args) => {
    if (args[0] === 'snapshot' && args[1] === 'delete') deletingSnapshot = true;
    if (deletingSnapshot && args[0] === 'snapshot' && args[1] === 'list') {
      return { code: 0, stdout: JSON.stringify([snapshotRecord(input)]), stderr: '' };
    }
    return originalDelete(args);
  };
  const result = await rejected(controller(stuck).ensureSnapshot(request(input)));
  assert.match(result.message, /rollback|absence|cleanup/i);
});

test('rejects wrong names, non-files, digest drift, credentials, and extra input before Daytona', async (t) => {
  const input = files(t);
  for (const injectedOptions of [
    { allowedExecutableDigests: {} },
    { credentialRanges: [] },
  ]) {
    assert.throws(
      () => createDaytonaSnapshotController({
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
        ...injectedOptions,
      }),
      /unexpected field/i,
    );
  }
  const attempts = [
    request(input, { identity: { name: 'operator-selected', buildHash: input.identity.buildHash } }),
    request(input, {
      identity: { name: `${input.identity.name}/alias`, buildHash: input.identity.buildHash },
    }),
    request(input, {
      archives: input.archives.map((entry, index) => index === 0
        ? { ...entry, path: path.dirname(input.dockerfilePath) }
        : entry),
    }),
    request(input, {
      archives: input.archives.map((entry, index) => index === 0
        ? { ...entry, sha256: '0'.repeat(64) }
        : entry),
    }),
    { ...request(input), apiKey: 'sk-or-v1-forbidden' },
    { ...request(input), allowedExecutableDigests: {} },
    { ...request(input), credentialRanges: [] },
    {
      ...request(input),
      archives: input.archives.map((entry, index) => index === 0
        ? { ...entry, credentialScanExemptions: [] }
        : entry),
    },
    {
      ...request(input),
      archives: input.archives.map((entry, index) => index === 0
        ? { ...entry, allowedExecutableDigests: {} }
        : entry),
    },
  ];
  for (const attempt of attempts) {
    const fake = fakeDaytona(input);
    await assert.rejects(
      controller(fake).ensureSnapshot(attempt),
      /name|regular file|digest|unexpected field|inventory/i,
    );
    assert.equal(fake.calls.length, 0);
  }

  const taskNameInput = files(t, {
    first: 'ordinary task-proj-artifact-content-that-is-not-a-token',
  });
  const taskNameFake = fakeDaytona(taskNameInput);
  const taskNameResult = await controller(taskNameFake).ensureSnapshot(request(taskNameInput));
  assert.equal(taskNameResult.retained, true);

  const secretInput = files(t, { first: 'archive contains sk-or-v1-forbidden-provider-key' });
  const secretFake = fakeDaytona(secretInput);
  const secretError = await rejected(controller(secretFake).ensureSnapshot(request(secretInput)));
  assert.match(secretError.message, /credential/i);
  assert.match(secretError.message, /context 5/i);
  assert.doesNotMatch(secretError.message, /sk-or-v1-forbidden-provider-key/);
  assert.equal(secretFake.calls.length, 0);

  const legacySecretInput = files(t, {
    first: 'archive contains (sk-abcdefghijklmnop) legacy provider key',
  });
  const legacySecretFake = fakeDaytona(legacySecretInput);
  const legacySecretError = await rejected(
    controller(legacySecretFake).ensureSnapshot(request(legacySecretInput)),
  );
  assert.match(legacySecretError.message, /credential/i);
  assert.doesNotMatch(legacySecretError.message, /sk-abcdefghijklmnop/);
  assert.equal(legacySecretFake.calls.length, 0);

  const boundarySecretInput = files(t, {
    first: Buffer.concat([
      Buffer.alloc((64 * 1024) - 5, 0x78),
      Buffer.from('\n(sk-abcdefghijklmnop)'),
    ]),
  });
  const boundarySecretFake = fakeDaytona(boundarySecretInput);
  const boundarySecretError = await rejected(
    controller(boundarySecretFake).ensureSnapshot(request(boundarySecretInput)),
  );
  assert.match(boundarySecretError.message, /credential/i);
  assert.equal(boundarySecretFake.calls.length, 0);
});

test('secret-bearing command output is never returned or echoed and still triggers complete rollback', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { mode: 'selftest-secret' });
  const error = await rejected(controller(fake).ensureSnapshot(request(input)));
  assert.match(error.message, /credential/i);
  assert.doesNotMatch(error.message, /sk-or-v1-never-retain-this/);
  assert.equal(fake.snapshots.some((entry) => entry.name === input.identity.name), false);
  assert.equal(fake.sandbox, null);
});
