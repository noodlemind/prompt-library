import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  TASK_CONTAINER_OBSERVATION_SCHEMA,
  TASK_ISOLATION_RECEIPT_PATH,
  TASK_MOUNT_RECEIPT_PATH,
  createTaskRuntimeReceipts,
  observeLiveTaskContainer,
  publishTaskRuntimeReceipts,
  writeReceiptExclusive,
} from '../../../evals/runtime/task-container-observer.mjs';
import {
  TASK_ISOLATION_PROBE_PATH,
  createTrialSecurityContract,
} from '../../../evals/runtime/trial-security-contract.mjs';

const HASH = (character) => character.repeat(64);
const IMAGE = `registry.example.invalid/task@sha256:${HASH('a')}`;
const IMAGE_ID = `sha256:${HASH('d')}`;
const CONTAINER = HASH('b');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function containerBindingHash(value) {
  return crypto.createHash('sha256')
    .update('engineer-harness/docker-binding/v1\0')
    .update(value)
    .digest('hex');
}

function fixture({
  probeOverrides = {},
  mountOverrides = null,
  containerOverrides = {},
  nativeMountShape = true,
  mountFieldOverrides = {},
} = {}) {
  const contract = createTrialSecurityContract({
    trialId: 'pair-1-repetition-1-generic-1',
    immutableImage: IMAGE,
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 256,
  });
  const common = '/engineer-bounded/work/mounts/000:/opt/eval-runtime/node-x64:ro';
  const allowedBindSets = [[...contract.docker.allowedBinds, common]];
  const mounts = (mountOverrides ?? allowedBindSets[0]).map((bind) => {
    const parts = bind.split(':');
    const mode = parts.pop();
    const destination = parts.pop();
    return nativeMountShape
      ? {
        Type: 'bind',
        Source: parts.join(':'),
        Destination: destination,
        Mode: '',
        RW: mode === 'rw',
        Propagation: 'rprivate',
        ...mountFieldOverrides,
      }
      : { type: 'bind', source: parts.join(':'), destination, rw: mode === 'rw' };
  });
  const materialization = {
    schema: 'engineer-trial-security-materialization.v1',
    trialId: contract.identity.trialId,
    runtimeRoot: contract.identity.runtimeRoot,
    composeHash: contract.composeHash,
    imageDigest: IMAGE_ID,
    workspaceFilesystemId: 'bounded-fs',
    receiptHash: HASH('c'),
  };
  const calls = [];
  const ok = (stdout) => ({
    exitCode: 0,
    signal: null,
    stdout: `${JSON.stringify(stdout)}\n`,
    stderrHash: sha256(''),
    spawnError: null,
  });
  const runDocker = (args) => {
    calls.push(args);
    if (args.includes('inspect')) return ok({
      capDrop: ['ALL'],
      configImage: IMAGE,
      id: CONTAINER,
      image: IMAGE_ID,
      mounts,
      networkMode: 'none',
      readonlyRootfs: true,
      running: true,
      securityOpt: ['no-new-privileges:true'],
      ...containerOverrides,
    });
    if (args.includes('exec')) return ok({
      schema: 'engineer-task-isolation-observation.v1',
      networkNamespaceIdentity: 'dev:4:ino:100',
      mountNamespaceIdentity: 'dev:4:ino:101',
      interfaceInventory: ['1:lo'],
      effectiveCapabilities: 0,
      noNewPrivileges: true,
      rawSocketDenied: true,
      ...probeOverrides,
    });
    throw new Error('unexpected Docker operation');
  };
  return { contract, allowedBindSets, materialization, calls, runDocker };
}

test('observes exact live binds and runs the static canary inside the started task container', () => {
  const fx = fixture();
  const observation = observeLiveTaskContainer({
    containerId: CONTAINER,
    containerBindingHash: containerBindingHash(CONTAINER),
    contract: fx.contract,
    allowedBindSets: fx.allowedBindSets,
    materialization: fx.materialization,
    imageDigest: IMAGE_ID,
    probeExecutableHash: HASH('d'),
  }, { runDocker: fx.runDocker });
  assert.equal(observation.schema, TASK_CONTAINER_OBSERVATION_SCHEMA);
  assert.equal(observation.policyCompliant, true);
  assert.equal(observation.outsideAllowedWrites, false);
  assert.equal(observation.rawSocketDenied, true);
  assert.match(observation.observationHash, /^[a-f0-9]{64}$/);
  const command = fx.calls.flat().join('\0');
  assert.match(command, /container\0exec\0--privileged=false/);
  assert.match(command, new RegExp(TASK_ISOLATION_PROBE_PATH));
  assert.doesNotMatch(command, /\/bin\/sh|-c\0/);
});

test('accepts Docker native mount fields and rejects the fixture-only lowercase shape', () => {
  const lowercase = fixture({ nativeMountShape: false });
  assert.throws(() => observeLiveTaskContainer({
    containerId: CONTAINER,
    containerBindingHash: containerBindingHash(CONTAINER),
    contract: lowercase.contract,
    allowedBindSets: lowercase.allowedBindSets,
    materialization: lowercase.materialization,
    imageDigest: IMAGE_ID,
    probeExecutableHash: HASH('d'),
  }, { runDocker: lowercase.runDocker }), /mount.*(?:invalid|unexpected|missing)/i);
});

test('rejects bind mode and propagation drift even when source, destination, and RW match', () => {
  for (const mountFieldOverrides of [
    { Propagation: 'rshared' },
    { Mode: 'z' },
    { Mode: 'ro', RW: true },
    { Mode: 'rw', RW: false },
  ]) {
    const drifted = fixture({ mountFieldOverrides });
    assert.throws(() => observeLiveTaskContainer({
      containerId: CONTAINER,
      containerBindingHash: containerBindingHash(CONTAINER),
      contract: drifted.contract,
      allowedBindSets: drifted.allowedBindSets,
      materialization: drifted.materialization,
      imageDigest: IMAGE_ID,
      probeExecutableHash: HASH('d'),
    }, { runDocker: drifted.runDocker }), /invalid bind/i);
  }
});

test('rejects writable-probe, treatment, namespace, capability, and raw-socket drift', () => {
  const cases = [
    { probeOverrides: { effectiveCapabilities: 1 }, expected: /sandbox state/i },
    { probeOverrides: { noNewPrivileges: false }, expected: /sandbox state/i },
    { probeOverrides: { rawSocketDenied: false }, expected: /sandbox state/i },
    { probeOverrides: { interfaceInventory: ['1:lo', '2:eth0'] }, expected: /sandbox state/i },
  ];
  for (const item of cases) {
    const fx = fixture(item);
    assert.throws(() => observeLiveTaskContainer({
      containerId: CONTAINER,
      containerBindingHash: containerBindingHash(CONTAINER),
      contract: fx.contract,
      allowedBindSets: fx.allowedBindSets,
      materialization: fx.materialization,
      imageDigest: IMAGE_ID,
      probeExecutableHash: HASH('d'),
    }, { runDocker: fx.runDocker }), item.expected);
  }
  const base = fixture();
  const writableProbe = base.allowedBindSets[0].map((bind) =>
    bind.includes(TASK_ISOLATION_PROBE_PATH) ? bind.replace(/:ro$/, ':rw') : bind
  );
  const drifted = fixture({ mountOverrides: writableProbe });
  assert.throws(() => observeLiveTaskContainer({
    containerId: CONTAINER,
    containerBindingHash: containerBindingHash(CONTAINER),
    contract: drifted.contract,
    allowedBindSets: drifted.allowedBindSets,
    materialization: drifted.materialization,
    imageDigest: IMAGE_ID,
    probeExecutableHash: HASH('d'),
  }, { runDocker: drifted.runDocker }), /bind inventory|read-only protected bind/i);
});

test('binds content-free mount and isolation receipts to the final proxy lifecycle', () => {
  const fx = fixture();
  const observation = observeLiveTaskContainer({
    containerId: CONTAINER,
    containerBindingHash: containerBindingHash(CONTAINER),
    contract: fx.contract,
    allowedBindSets: fx.allowedBindSets,
    materialization: fx.materialization,
    imageDigest: IMAGE_ID,
    probeExecutableHash: HASH('d'),
  }, { runDocker: fx.runDocker });
  const receipts = createTaskRuntimeReceipts({
    observation,
    requestHash: HASH('1'),
    leaseHash: HASH('2'),
    proxyEventsHash: HASH('3'),
    producerExecutableHash: HASH('4'),
    sandboxBootId: 'boot-1',
    trialId: fx.contract.identity.trialId,
    producerSessionId: HASH('5'),
    daemonRootFilesystemId: 'bounded-fs',
  });
  assert.equal(receipts.mount.schema, 'engineer-runtime-task-mount-receipt.v1');
  assert.equal(receipts.isolation.schema, 'engineer-runtime-task-isolation-receipt.v1');
  assert.equal(receipts.mount.proxyEventsHash, HASH('3'));
  assert.equal(receipts.isolation.containerIdHash, observation.containerIdHash);
  const writes = [];
  const published = publishTaskRuntimeReceipts(receipts, {
    writeReceipt: (file, document) => writes.push([file, structuredClone(document)]),
  });
  assert.deepEqual(writes.map(([file]) => file), [
    TASK_MOUNT_RECEIPT_PATH,
    TASK_ISOLATION_RECEIPT_PATH,
  ]);
  assert.match(published.mountHash, /^[a-f0-9]{64}$/);
  assert.match(published.isolationHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(writes).includes(CONTAINER), false);
});

test('rejects live container drift from either pinned image identity', () => {
  for (const containerOverrides of [
    { configImage: `registry.example.invalid/other@sha256:${HASH('a')}` },
    { image: `sha256:${HASH('a')}` },
  ]) {
    const fx = fixture({ containerOverrides });
    assert.throws(() => observeLiveTaskContainer({
      containerId: CONTAINER,
      containerBindingHash: containerBindingHash(CONTAINER),
      contract: fx.contract,
      allowedBindSets: fx.allowedBindSets,
      materialization: fx.materialization,
      imageDigest: IMAGE_ID,
      probeExecutableHash: HASH('d'),
    }, { runDocker: fx.runDocker }), /container policy/i);
  }
});

test('removes a renamed receipt when final custody durability fails', () => {
  const file = '/engineer-bounded/evidence/test-receipt.json';
  const directory = '/engineer-bounded/evidence';
  const unlinked = [];
  let renamed = false;
  const filesystem = {
    realpathSync: { native: (target) => target },
    lstatSync(target) {
      if (target === directory) {
        return { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o700 };
      }
      assert.equal(target, file);
      assert.equal(renamed, true);
      return {
        isFile: () => true, isSymbolicLink: () => false,
        uid: 0, gid: 0, mode: 0o600, nlink: 1,
      };
    },
    existsSync: () => false,
    openSync(target) { return target === directory ? 12 : 11; },
    writeFileSync() {},
    fsyncSync(descriptor) {
      if (descriptor === 12) throw new Error('simulated directory fsync failure');
    },
    closeSync() {},
    renameSync() { renamed = true; },
    unlinkSync(target) { unlinked.push(target); },
  };

  assert.throws(
    () => writeReceiptExclusive(file, { schema: 'test' }, { filesystem }),
    /publication failed/i
  );
  assert.deepEqual(unlinked, [file]);
});
