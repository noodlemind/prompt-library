import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import test from 'node:test';

import {
  DAEMON_ADOPTION_RECEIPT_PATH,
  SNAPSHOT_MANAGER_DOCKERD_ARGV,
  assertSnapshotManagerEnvironment,
  attestDaemonAdoptionReceipt,
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

test('independent adoption attestation observes the protected manager PID, not its caller PID', async (t) => {
  const managerPid = process.pid + 10_000;
  const daemonPid = managerPid + 1;
  const hostname = 'snapshot-sandbox';
  const nodeBytes = Buffer.from('protected-node-runtime');
  const moduleBytes = Buffer.from('protected-snapshot-manager-module');
  const dockerdBytes = Buffer.from('protected-private-dockerd');
  const pidFileBytes = Buffer.from(`${daemonPid}\n`);
  const cmdlineBytes = Buffer.from(
    `${['/usr/local/bin/dockerd', ...SNAPSHOT_MANAGER_DOCKERD_ARGV].join('\0')}\0`
  );
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const live = observation();
  live.sandboxKernelIdentityHash = digest(
    `engineer-sandbox-kernel.v1\0${live.sandboxBootId}\0${hostname}`
  );
  live.manager = {
    ...live.manager,
    pid: managerPid,
    executableSha256: digest(nodeBytes),
    moduleSha256: digest(moduleBytes),
  };
  live.daemon = {
    ...live.daemon,
    pid: daemonPid,
    executableSha256: digest(dockerdBytes),
    argvSha256: digest(cmdlineBytes),
    pidFileSha256: digest(pidFileBytes),
  };
  const built = createDaemonAdoptionReceipt(live);
  const receiptBytes = Buffer.from(built.canonicalJson);
  const receiptParent = '/engineer-bounded/evidence';
  const receiptStat = {
    dev: 1n,
    ino: 2n,
    size: BigInt(receiptBytes.length),
    mode: BigInt(0o100600),
    uid: 0n,
    gid: 0n,
    mtimeNs: 1n,
    ctimeNs: 1n,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const protectedFiles = new Map([
    ['/usr/local/bin/node', { bytes: nodeBytes, executable: true, inode: 10n }],
    ['/opt/engineer/runtime/snapshot-manager.mjs', {
      bytes: moduleBytes,
      executable: false,
      inode: 11n,
    }],
    ['/usr/local/bin/dockerd', { bytes: dockerdBytes, executable: true, inode: 12n }],
  ]);
  for (const entry of protectedFiles.values()) {
    entry.stat = {
      dev: 1n,
      ino: entry.inode,
      size: BigInt(entry.bytes.length),
      mode: BigInt(entry.executable ? 0o100755 : 0o100644),
      uid: 0n,
      gid: 0n,
      mtimeNs: 1n,
      ctimeNs: 1n,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
  }
  const descriptors = new Map();
  const observedProcessPids = [];
  let nextDescriptor = 100;
  const processStat = (pid, name, startTimeTicks) => {
    const fields = Array(20).fill('1');
    fields[0] = 'S';
    fields[19] = startTimeTicks;
    return `${pid} (${name}) ${fields.join(' ')}\n`;
  };

  t.mock.method(fsp, 'realpath', async (target) => target);
  t.mock.method(fsp, 'lstat', async (target) => {
    if (target === receiptParent) {
      return {
        uid: 0,
        mode: 0o40700,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    }
    assert.equal(target, DAEMON_ADOPTION_RECEIPT_PATH);
    return receiptStat;
  });
  t.mock.method(fsp, 'open', async (target) => {
    assert.equal(target, DAEMON_ADOPTION_RECEIPT_PATH);
    return {
      async stat() { return receiptStat; },
      async readFile() { return Buffer.from(receiptBytes); },
      async close() {},
    };
  });
  t.mock.method(fs, 'readFileSync', (target) => {
    if (typeof target === 'number') {
      const entry = descriptors.get(target);
      assert.ok(entry, `unknown protected-file descriptor ${target}`);
      return Buffer.from(entry.bytes);
    }
    const processMatch = /^\/proc\/([1-9][0-9]*)\/stat$/.exec(target);
    if (processMatch) {
      const pid = Number(processMatch[1]);
      observedProcessPids.push(pid);
      if (pid === managerPid) return processStat(pid, 'node', live.manager.startTimeTicks);
      if (pid === daemonPid) return processStat(pid, 'dockerd', live.daemon.startTimeTicks);
      const error = new Error('process is not part of the protected receipt');
      error.code = 'ENOENT';
      throw error;
    }
    if (target === '/run/engineer/private-docker.pid') return Buffer.from(pidFileBytes);
    if (target === `/proc/${daemonPid}/cmdline`) return Buffer.from(cmdlineBytes);
    if (target === '/proc/sys/kernel/random/boot_id') return `${live.sandboxBootId}\n`;
    throw new Error(`unexpected synchronous read: ${target}`);
  });
  t.mock.method(fs.realpathSync, 'native', (target) => {
    if (target === `/proc/${managerPid}/exe`) return '/usr/local/bin/node';
    if (target === `/proc/${daemonPid}/exe`) return '/usr/local/bin/dockerd';
    if (protectedFiles.has(target)) return target;
    throw new Error(`unexpected realpath: ${target}`);
  });
  t.mock.method(fs, 'lstatSync', (target) => {
    if (target === '/run/engineer/private-docker.sock') {
      return {
        dev: BigInt(live.daemon.socketDevice),
        ino: BigInt(live.daemon.socketInode),
        mode: BigInt(0o140600),
        uid: 0n,
        gid: 0n,
        isSocket: () => true,
        isSymbolicLink: () => false,
      };
    }
    const entry = protectedFiles.get(target);
    assert.ok(entry, `unexpected protected file: ${target}`);
    return entry.stat;
  });
  t.mock.method(fs, 'openSync', (target) => {
    const entry = protectedFiles.get(target);
    assert.ok(entry, `unexpected protected file open: ${target}`);
    const descriptor = nextDescriptor;
    nextDescriptor += 1;
    descriptors.set(descriptor, entry);
    return descriptor;
  });
  t.mock.method(fs, 'fstatSync', (descriptor) => {
    const entry = descriptors.get(descriptor);
    assert.ok(entry, `unknown protected-file descriptor ${descriptor}`);
    return entry.stat;
  });
  t.mock.method(fs, 'closeSync', (descriptor) => {
    assert.equal(descriptors.delete(descriptor), true);
  });
  t.mock.method(fs, 'statSync', (target) => {
    if (target === '/engineer-bounded') return { dev: 0x801n };
    if (target === '/var/lib/docker') return { dev: 0x802n };
    throw new Error(`unexpected filesystem stat: ${target}`);
  });
  t.mock.method(fs, 'statfsSync', (target) => {
    if (target === '/engineer-bounded') return { bsize: 4096n, blocks: 2_621_440n };
    if (target === '/var/lib/docker') return { bsize: 4096n, blocks: 5_242_880n };
    throw new Error(`unexpected filesystem statfs: ${target}`);
  });
  t.mock.method(os, 'hostname', () => hostname);

  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = () => ({
    status: 0,
    signal: null,
    error: null,
    stdout: `${JSON.stringify(live.daemon.daemonId)}\n`,
    stderr: '',
  });
  syncBuiltinESMExports();
  try {
    const attested = await attestDaemonAdoptionReceipt();
    assert.equal(attested.manager.pid, managerPid);
    assert.deepEqual(observedProcessPids, [managerPid, daemonPid]);
  } finally {
    t.mock.restoreAll();
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
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
