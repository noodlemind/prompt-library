import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  DAEMON_ADOPTION_RECEIPT_PATH,
  SNAPSHOT_MANAGER_DOCKERD_ARGV,
  assertSnapshotManagerEnvironment,
  createDaemonAdoptionReceipt,
  runSnapshotManagerCli,
  validateDaemonAdoptionReceipt,
  waitForManagedDaemonStop,
} from '../../../evals/runtime/snapshot-manager.mjs';
import { scrubDaytonaPlatformMetadata } from '../../../evals/runtime/platform-environment.mjs';

const HASH = (character) => character.repeat(64);
const DAYTONA_METADATA = Object.freeze({
  DAYTONA_ORGANIZATION_ID: '123e4567-e89b-42d3-a456-426614174000',
  DAYTONA_OTEL_ENDPOINT: 'https://telemetry.invalid',
  DAYTONA_REGION_ID: 'us',
  DAYTONA_SANDBOX_ID: '8d2890a2-57ef-4d75-91d5-2b0a81256b89',
  DAYTONA_SANDBOX_SNAPSHOT: `ghcr.io/daytonaio/runtime@sha256:${HASH('a')}`,
  DAYTONA_SANDBOX_USER: 'root',
});

async function withLiveDaytonaMetadata(action) {
  const originals = new Map(Object.keys(DAYTONA_METADATA).map((name) => [
    name, Object.getOwnPropertyDescriptor(process.env, name),
  ]));
  Object.assign(process.env, DAYTONA_METADATA);
  try {
    return await action();
  } finally {
    for (const name of Object.keys(DAYTONA_METADATA)) {
      delete process.env[name];
      const descriptor = originals.get(name);
      if (descriptor) Object.defineProperty(process.env, name, descriptor);
    }
  }
}

test('production snapshot CLI deletes Daytona metadata before argument handling', async () => {
  await withLiveDaytonaMetadata(async () => {
    await assert.rejects(runSnapshotManagerCli({ argv: ['unexpected'] }), /accepts no arguments/i);
    for (const name of Object.keys(DAYTONA_METADATA)) {
      assert.equal(Object.hasOwn(process.env, name), false);
    }
  });
});

test('snapshot manager asserts strictly after validated Daytona platform metadata is scrubbed', () => {
  const scrubbed = scrubDaytonaPlatformMetadata({ PATH: '/usr/bin', ...DAYTONA_METADATA });
  assert.deepEqual({ ...scrubbed }, { PATH: '/usr/bin' });
  assert.doesNotThrow(() => assertSnapshotManagerEnvironment(scrubbed));

  for (const name of [
    ...Object.keys(DAYTONA_METADATA),
    'DAYTONA_API_KEY',
    'DAYTONA_TOKEN',
    'DAYTONA_UNKNOWN',
  ]) {
    assert.throws(
      () => assertSnapshotManagerEnvironment({ [name]: 'credential-material' }),
      /forbids ambient cloud or provider credentials/i,
    );
  }
  assert.throws(
    () => assertSnapshotManagerEnvironment({ OPENROUTER_API_KEY: 'provider-key' }),
    /forbids ambient cloud or provider credentials/i,
  );
});

function observation() {
  const argvSha256 = 'bcbc7dee351a5db7c96d37898657d81b07ad39ee53ff4745c6106ee7c72f8916';
  return {
    sandboxBootId: '123e4567-e89b-42d3-a456-426614174000',
    sandboxKernelIdentityHash: HASH('1'),
    sessionNonce: HASH('2'),
    manager: {
      pid: 1,
      startTimeTicks: '12345',
      executablePath: '/usr/local/bin/node',
      executableSha256: HASH('3'),
      moduleSha256: HASH('4'),
    },
    daemon: {
      pid: 42,
      startTimeTicks: '23456',
      executablePath: '/usr/local/bin/dockerd',
      executableSha256: HASH('5'),
      argvSha256,
      daemonId: 'ABCDEF123456',
      pidFilePath: '/run/engineer/private-docker.pid',
      pidFileSha256: HASH('7'),
      socketPath: '/run/engineer/private-docker.sock',
      socketDevice: '2049',
      socketInode: '999',
      socketMode: 0o600,
      socketOwnerUid: 0,
      socketOwnerGid: 0,
      dataRoot: '/engineer-bounded/docker',
    },
    filesystem: {
      boundedRootId: 'dev:801',
      boundedRootBytes: 10 * 1024 * 1024 * 1024,
      defaultDockerRootId: 'dev:802',
    },
    createdAt: '2026-08-04T12:00:00.000Z',
  };
}

test('daemon adoption receipt canonically binds the live manager, daemon, socket, argv, and bounded filesystem', () => {
  const built = createDaemonAdoptionReceipt(observation());

  assert.equal(built.receipt.schema, 'engineer-daemon-adoption-receipt.v1');
  assert.equal(built.receipt.receiptVersion, 1);
  assert.equal(built.receiptPath, DAEMON_ADOPTION_RECEIPT_PATH);
  assert.equal(built.sha256.length, 64);
  assert.deepEqual(JSON.parse(built.canonicalJson), built.receipt);
  assert.deepEqual(validateDaemonAdoptionReceipt(built.receipt), built.receipt);
});

test('daemon adoption receipt rejects process, socket, filesystem, and unknown-field drift', () => {
  const receipt = createDaemonAdoptionReceipt(observation()).receipt;
  for (const mutation of [
    (value) => { value.daemon.argvSha256 = HASH('a'); },
    (value) => { value.daemon.socketMode = 0o660; },
    (value) => { value.filesystem.defaultDockerRootId = value.filesystem.boundedRootId; },
    (value) => { value.manager.pid = 0; },
    (value) => { value.untrusted = true; },
  ]) {
    const changed = structuredClone(receipt);
    mutation(changed);
    assert.throws(() => validateDaemonAdoptionReceipt(changed), /adoption|daemon|manager|socket|filesystem|field/i);
  }
});

test('snapshot manager daemon argv is fixed to the bounded root and non-networked daemon', () => {
  assert.deepEqual(SNAPSHOT_MANAGER_DOCKERD_ARGV, [
    '--host', 'unix:///run/engineer/private-docker.sock',
    '--data-root', '/engineer-bounded/docker',
    '--exec-root', '/run/engineer/docker-exec',
    '--pidfile', '/run/engineer/private-docker.pid',
    '--storage-driver', 'vfs',
    '--bridge', 'none',
    '--iptables=false',
    '--ip-forward=false',
    '--ip-masq=false',
    '--userland-proxy=false',
    '--log-level', 'error',
  ]);
});

test('managed-daemon settlement clears its poll timer when the exit event wins', async () => {
  const child = new EventEmitter();
  child.exitCode = 0;
  const timer = {};
  let cleared = 0;
  const waiting = waitForManagedDaemonStop(child, {
    isStopping: () => true,
    setIntervalFn: () => timer,
    clearIntervalFn: (value) => {
      assert.equal(value, timer);
      cleared += 1;
    },
  });
  child.emit('exit');
  await waiting;
  assert.equal(cleared, 1);
});
