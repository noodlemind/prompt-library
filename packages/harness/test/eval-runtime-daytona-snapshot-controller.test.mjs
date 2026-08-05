import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createDaytonaSnapshotController,
} from '../../../evals/runtime/daytona-snapshot-controller.mjs';

const BUILD_HASH = 'a'.repeat(64);
const SNAPSHOT_NAME = `engineer-eval-${BUILD_HASH.slice(0, 32)}`;
const SANDBOX_NAME = `${SNAPSHOT_NAME}-selftest`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function files(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daytona-snapshot-controller-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dockerfilePath = path.join(directory, 'Dockerfile');
  const firstPath = path.join(directory, 'a-runtime.tar');
  const secondPath = path.join(directory, 'z-native.tar');
  const dockerfile = overrides.dockerfile ?? 'FROM scratch\nCOPY a-runtime.tar /runtime.tar\n';
  const first = overrides.first ?? 'deterministic runtime archive';
  const second = overrides.second ?? 'deterministic native archive';
  fs.writeFileSync(dockerfilePath, dockerfile);
  fs.writeFileSync(firstPath, first);
  fs.writeFileSync(secondPath, second);
  return {
    dockerfile,
    dockerfilePath,
    archives: [
      { path: secondPath, sha256: sha256(second) },
      { path: firstPath, sha256: sha256(first) },
    ],
    orderedArchives: [firstPath, secondPath],
    orderedHashes: [sha256(first), sha256(second)],
  };
}

function snapshotRecord(input, overrides = {}) {
  return {
    id: `snapshot-${BUILD_HASH.slice(0, 16)}`,
    name: SNAPSHOT_NAME,
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

function sandboxRecord(overrides = {}) {
  return {
    id: 'sandbox-validation-0001',
    name: SANDBOX_NAME,
    snapshot: SNAPSHOT_NAME,
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
  selfTestStdout = `ENGINEER-SNAPSHOT/1 ${BUILD_HASH}\n`,
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
        const index = snapshots.findIndex((entry) => entry.name === args[2]);
        if (index >= 0) snapshots.splice(index, 1);
      }
      if (mode === 'snapshot-cleanup-command') {
        return { code: 70, stdout: '', stderr: 'delete request lost' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }

    if (args[0] === 'create') {
      sandbox = sandboxRecord();
      if (mode === 'sandbox-create') return { code: 70, stdout: '', stderr: 'partial sandbox failure' };
      return { code: 0, stdout: '', stderr: '' };
    }

    if (args[0] === 'exec') {
      if (mode === 'selftest') return { code: 70, stdout: 'failed detail', stderr: 'selftest failure' };
      if (mode === 'selftest-secret') return { code: 0, stdout: 'sk-or-v1-never-retain-this', stderr: '' };
      if (mode === 'selftest-mismatch') return { code: 0, stdout: `ENGINEER-SNAPSHOT/1 ${'b'.repeat(64)}\n`, stderr: '' };
      return { code: 0, stdout: selfTestStdout, stderr: '' };
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
          ? sandboxRecord({ snapshot: 'wrong-snapshot' })
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
    identity: { name: SNAPSHOT_NAME, buildHash: BUILD_HASH },
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
  assert.deepEqual(fake.calls[2], [
    'snapshot', 'create', SNAPSHOT_NAME,
    '--dockerfile', input.dockerfilePath,
    '--context', input.orderedArchives[0],
    '--context', input.orderedArchives[1],
    '--cpu', '2',
    '--memory', '4',
    '--disk', '10',
    '--region', 'us',
    '--sandbox-class', 'container',
  ]);
  assert.deepEqual(fake.calls[3], ['snapshot', 'list', '--format', 'json', '--limit', '200', '--page', '1']);
  assert.deepEqual(fake.calls[4], [
    'create', '--name', SANDBOX_NAME, '--snapshot', SNAPSHOT_NAME,
    '--cpu', '2', '--memory', '4096', '--disk', '10', '--target', 'us',
    '--network-block-all', '--auto-stop', '0', '--ttl', '30',
  ]);
  assert.deepEqual(fake.calls[5], [
    'exec', SANDBOX_NAME, '--',
    '/opt/engineer/bin/engineer-snapshot-selftest', '--expected-build-hash', BUILD_HASH,
  ]);
  assert.deepEqual(fake.calls[6], ['info', SANDBOX_NAME, '--format', 'json']);
  assert.deepEqual(fake.calls[7], ['delete', 'sandbox-validation-0001']);
  assert.deepEqual(fake.calls[8], ['info', 'sandbox-validation-0001', '--format', 'json']);
  assert.equal(fake.calls.some((args) => args[0] === 'snapshot' && args[1] === 'delete'), false);

  assert.deepEqual(receipt, {
    schema: 'engineer-daytona-snapshot-lifecycle-receipt.v1',
    name: SNAPSHOT_NAME,
    snapshotId: `snapshot-${BUILD_HASH.slice(0, 16)}`,
    buildHash: BUILD_HASH,
    status: 'active',
    created: true,
    retained: true,
    archiveCount: 2,
    validation: {
      performed: true,
      sandboxId: 'sandbox-validation-0001',
      networkBlocked: true,
      selfTestExitCode: 0,
      selfTestStdoutBytes: Buffer.byteLength(`ENGINEER-SNAPSHOT/1 ${BUILD_HASH}\n`),
      selfTestStdoutSha256: sha256(`ENGINEER-SNAPSHOT/1 ${BUILD_HASH}\n`),
      selfTestStderrBytes: 0,
      selfTestStderrSha256: sha256(''),
      sandboxDeleted: true,
    },
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(input.dockerfile), false);
  assert.equal(input.orderedArchives.some((archivePath) => serialized.includes(archivePath)), false);
});

test('paginates and revalidates an exact active content-addressed snapshot before reuse', async (t) => {
  const input = files(t);
  const records = Array.from({ length: 200 }, (_, index) => fillerRecord(index));
  records.push(snapshotRecord(input));
  const fake = fakeDaytona(input, { initialSnapshots: records });

  const receipt = await controller(fake).ensureSnapshot(request(input));

  assert.deepEqual(fake.calls, [
    ['--version'],
    ['snapshot', 'list', '--format', 'json', '--limit', '200', '--page', '1'],
    ['snapshot', 'list', '--format', 'json', '--limit', '200', '--page', '2'],
    [
      'create', '--name', SANDBOX_NAME, '--snapshot', SNAPSHOT_NAME,
      '--cpu', '2', '--memory', '4096', '--disk', '10', '--target', 'us',
      '--network-block-all', '--auto-stop', '0', '--ttl', '30',
    ],
    [
      'exec', SANDBOX_NAME, '--',
      '/opt/engineer/bin/engineer-snapshot-selftest', '--expected-build-hash', BUILD_HASH,
    ],
    ['info', SANDBOX_NAME, '--format', 'json'],
    ['delete', 'sandbox-validation-0001'],
    ['info', 'sandbox-validation-0001', '--format', 'json'],
  ]);
  assert.equal(receipt.created, false);
  assert.equal(receipt.retained, true);
  assert.equal(receipt.validation.performed, true);
  assert.equal(receipt.validation.networkBlocked, true);
  assert.equal(receipt.validation.sandboxDeleted, true);
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

test('every failure after a possible snapshot create deletes it and proves absence', async (t) => {
  const input = files(t);
  for (const mode of [
    'snapshot-create',
    'post-create-command',
    'post-create-malformed',
    'sandbox-create',
    'selftest',
    'selftest-mismatch',
    'sandbox-info-command',
    'sandbox-info-malformed',
    'sandbox-inspect',
    'sandbox-delete',
    'not-found-drift',
  ]) {
    const fake = fakeDaytona(input, { mode });
    await assert.rejects(controller(fake).ensureSnapshot(request(input)), undefined, mode);
    assert.equal(fake.snapshotDeleteAttempted, true, `${mode} must request snapshot rollback`);
    assert.equal(fake.snapshots.some((entry) => entry.name === SNAPSHOT_NAME), false,
      `${mode} must leave no failed release snapshot`);
    const deleteIndex = fake.calls.findIndex((args) => args[0] === 'snapshot' && args[1] === 'delete');
    assert.ok(deleteIndex >= 0, `${mode} must call snapshot delete`);
    assert.ok(fake.calls.slice(deleteIndex + 1).some((args) =>
      args[0] === 'snapshot' && args[1] === 'list' && args.includes('--page')),
    `${mode} must prove absence with the paginated list API`);
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

test('rollback tolerates a lost snapshot-delete response only after all pages prove absence', async (t) => {
  const input = files(t);
  const initialSnapshots = Array.from({ length: 201 }, (_, index) => fillerRecord(index));
  const fake = fakeDaytona(input, { initialSnapshots, mode: 'selftest' });
  const original = fake.runCommand;
  let deleteResponseLost = false;
  fake.runCommand = async (args) => {
    if (args[0] === 'snapshot' && args[1] === 'delete') {
      await original(args);
      deleteResponseLost = true;
      return { code: 75, stdout: '', stderr: 'response lost' };
    }
    return original(args);
  };

  await assert.rejects(controller(fake).ensureSnapshot(request(input)), /self-test/i);
  assert.equal(deleteResponseLost, true);
  const deleteIndex = fake.calls.findIndex((args) => args[0] === 'snapshot' && args[1] === 'delete');
  const cleanupPages = fake.calls.slice(deleteIndex + 1)
    .filter((args) => args[0] === 'snapshot' && args[1] === 'list')
    .map((args) => args[args.indexOf('--page') + 1]);
  assert.deepEqual(cleanupPages, ['1', '2']);
  assert.equal(fake.snapshots.some((entry) => entry.name === SNAPSHOT_NAME), false);
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
  const attempts = [
    request(input, { identity: { name: 'operator-selected', buildHash: BUILD_HASH } }),
    request(input, { archives: [{ path: path.dirname(input.dockerfilePath), sha256: '0'.repeat(64) }] }),
    request(input, { archives: [{ ...input.archives[0], sha256: '0'.repeat(64) }] }),
    { ...request(input), apiKey: 'sk-or-v1-forbidden' },
  ];
  for (const attempt of attempts) {
    const fake = fakeDaytona(input);
    await assert.rejects(controller(fake).ensureSnapshot(attempt), /name|regular file|digest|unexpected field/i);
    assert.equal(fake.calls.length, 0);
  }

  const secretInput = files(t, { first: 'archive contains sk-or-v1-forbidden-provider-key' });
  const secretFake = fakeDaytona(secretInput);
  const secretError = await rejected(controller(secretFake).ensureSnapshot(request(secretInput)));
  assert.match(secretError.message, /credential/i);
  assert.doesNotMatch(secretError.message, /sk-or-v1-forbidden-provider-key/);
  assert.equal(secretFake.calls.length, 0);
});

test('secret-bearing command output is never returned or echoed and still triggers complete rollback', async (t) => {
  const input = files(t);
  const fake = fakeDaytona(input, { mode: 'selftest-secret' });
  const error = await rejected(controller(fake).ensureSnapshot(request(input)));
  assert.match(error.message, /credential/i);
  assert.doesNotMatch(error.message, /sk-or-v1-never-retain-this/);
  assert.equal(fake.snapshots.some((entry) => entry.name === SNAPSHOT_NAME), false);
  assert.equal(fake.sandbox, null);
});
