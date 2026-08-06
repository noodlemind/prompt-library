import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { canonicalJson } from '../../../evals/runtime/protocol.mjs';

import {
  RemoteSupervisorEntrypointError,
  createProviderKeyDescriptorCustody,
  createRemoteSupervisorEntrypoint,
  inspectBoundArchive,
  runRemoteSupervisorCli,
  terminateRemoteSupervisorProcess,
} from '../../../evals/runtime/remote-supervisor.mjs';

const HASH = (character) => character.repeat(64);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const CONTROLLED_PROVIDER = 'controlled-provider';
const ZERO_PROVIDER_CANARY = 'zero-provider-canary';
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

function authenticatedControlChannel(hmacKey, executionMode) {
  const unsigned = {
    schema: 'engineer-authenticated-control-channel.v1',
    kind: 'inherited-pipe',
    kernelBound: true,
    executionMode,
    frameSha256: HASH('1'),
    inputDescriptor: {
      fd: 0,
      kind: 'pipe',
      device: '1',
      inode: '2',
      mode: 0o600,
      ownerUid: 0,
      ownerGid: 0,
    },
    outputDescriptor: {
      fd: 1,
      kind: 'pipe',
      device: '1',
      inode: '3',
      mode: 0o600,
      ownerUid: 0,
      ownerGid: 0,
    },
  };
  const authenticationTag = crypto.createHmac('sha256', hmacKey)
    .update(canonicalJson(unsigned)).digest('hex');
  return {
    ...unsigned,
    authenticationTag,
    receiptHash: sha256(canonicalJson({ ...unsigned, authenticationTag })),
    open: true,
    stream: { destroyed: false, once() {} },
  };
}

function topology(overrides = {}) {
  const base = {
    sandboxId: 'sandbox-1',
    sandboxBootId: 'boot-1',
    daemonId: 'private-daemon-1',
    imageDigest: `sha256:${HASH('d')}`,
    paths: {
      workspace: '/engineer-bounded/workspace',
      proxySocket: '/run/engineer/harbor-docker.sock',
      brokerSocket: '/run/engineer/provider/provider.sock',
    },
    executables: {
      runner: '/opt/engineer/bin/engineer-eval-runner',
    },
    hashes: {
      supervisor: HASH('2'),
      runner: HASH('3'),
      harbor: HASH('4'),
      daemonRoot: HASH('e'),
    },
    identities: {
      supervisorUid: 0,
      runnerUid: 2001,
      runnerGid: 2001,
      brokerClientGid: 2003,
    },
    cgroup: {
      id: 'trial-cgroup-1',
      pathHash: HASH('f'),
    },
  };
  return {
    ...base,
    ...overrides,
    paths: { ...base.paths, ...overrides.paths },
    executables: { ...base.executables, ...overrides.executables },
    hashes: { ...base.hashes, ...overrides.hashes },
    identities: { ...base.identities, ...overrides.identities },
    cgroup: { ...base.cgroup, ...overrides.cgroup },
  };
}

async function ownerOnlyFixture(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'engineer-remote-supervisor-'));
  const directory = await fs.realpath(created);
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const taskBytes = Buffer.from('bound-task-archive');
  const outputBytes = Buffer.from('bound-output-archive');
  await fs.writeFile(path.join(directory, 'task-input.tar'), taskBytes, { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'trial-output.tar'), outputBytes, { mode: 0o600 });
  return { directory, taskBytes, outputBytes };
}

function fakeCustody() {
  const calls = [];
  return {
    calls,
    async open() { calls.push(['open']); return 17; },
    async close(fd) { calls.push(['close', fd]); },
    async releaseAfterExternalClose(fd) { calls.push(['released', fd]); },
    async dispose() { calls.push(['dispose']); },
  };
}

test('composes the fixed supervisor route, archive bindings, policies, and exact runner command', async (t) => {
  const fixture = await ownerOnlyFixture(t);
  const topo = topology();
  const captured = {};
  const custody = fakeCustody();
  const rawEffects = {
    async bindControlChannel(value) {
      captured.boundControlChannel = value;
      return { bound: true };
    },
    async closeInheritedFd(fd) {
      captured.closedByEffects = fd;
      return { closed: true };
    },
  };
  const buildDockerPolicy = (context) => ({ kind: 'docker', trialId: context.trialId });
  const buildBrokerPolicy = (context) => ({ kind: 'broker', requestHash: context.requestHash });
  const entrypoint = createRemoteSupervisorEntrypoint({
    topology: topo,
    buildDockerPolicy,
    buildBrokerPolicy,
    runnerTimeoutMs: 90_000,
    dependencies: {
      platform: 'linux',
      environment: { PATH: '/usr/bin' },
      transportDirectory: fixture.directory,
      createEffects(options) {
        captured.effectsOptions = options;
        return rawEffects;
      },
      createHandlerFactory(options) {
        captured.handlerOptions = options;
        return async (input) => {
          captured.handlerInput = input;
          return ({
          async handleFrame() { return { response: Buffer.from('{}'), done: true }; },
          });
        };
      },
      createCustody() { return custody; },
      async bridgeCli(options) {
        captured.bridgeOptions = options;
        const hmacKey = Buffer.alloc(32, 0xa1);
        await options.handlerFactory({
          hmacKey,
          executionMode: CONTROLLED_PROVIDER,
          providerKey: Buffer.from('provider-key'),
          controlChannel: authenticatedControlChannel(hmacKey, CONTROLLED_PROVIDER),
        });
        return { status: 'complete' };
      },
    },
  });

  const result = await entrypoint.run({
    argv: ['--control-stdio'],
    input: { name: 'input' },
    output: { name: 'output' },
  });
  assert.deepEqual(result, { status: 'complete' });
  assert.equal(captured.effectsOptions.topology, topo);
  assert.deepEqual(captured.bridgeOptions.argv, ['--control-stdio']);
  assert.equal(captured.bridgeOptions.executableName, 'engineer-runtime-supervisor');
  assert.equal(typeof captured.bridgeOptions.handlerFactory, 'function');
  assert.deepEqual(Object.keys(captured.handlerInput).sort(), [
    'executionMode',
    'hmacKey',
    'providerKey',
  ]);
  assert.equal(captured.handlerInput.executionMode, CONTROLLED_PROVIDER);
  assert.deepEqual(captured.handlerInput.providerKey, Buffer.from('provider-key'));
  assert.deepEqual(custody.calls, [['dispose']]);

  const taskManifest = {
    kind: 'task-input',
    byteLength: fixture.taskBytes.length,
    sha256: sha256(fixture.taskBytes),
  };
  const binding = await captured.handlerOptions.inspectBinding({
    sessionId: 'session-1',
    trialId: 'trial-1',
    allocationId: topo.sandboxId,
    controlSequence: 1,
    trial: {
      trialId: 'trial-1',
      taskId: 'task-1',
      condition: 'generic',
      imageDigest: topo.imageDigest,
      trialCeilingMicrousd: 650_000,
      supervisorExecutableHash: topo.hashes.supervisor,
      runnerExecutableHash: topo.hashes.runner,
      harborExecutableHash: topo.hashes.harbor,
    },
    taskArchive: taskManifest,
  });
  assert.deepEqual(binding, {
    allocationId: topo.sandboxId,
    taskArchive: taskManifest,
    runtimeBindings: {
      sandboxBootId: topo.sandboxBootId,
      daemonId: topo.daemonId,
      daemonRootHash: topo.hashes.daemonRoot,
      cgroupId: topo.cgroup.id,
      cgroupPathHash: topo.cgroup.pathHash,
    },
  });

  const output = await captured.handlerOptions.inspectTrialOutput({
    sessionId: 'session-1',
    trialId: 'trial-1',
    allocationId: topo.sandboxId,
    requestHash: HASH('6'),
    readinessLeaseHash: HASH('7'),
    runnerResult: {
      exitCode: 0,
      signal: 'none',
      startedAt: '2026-08-04T16:00:00.000Z',
      endedAt: '2026-08-04T16:00:01.000Z',
    },
  });
  assert.deepEqual(output, {
    kind: 'trial-output',
    byteLength: fixture.outputBytes.length,
    sha256: sha256(fixture.outputBytes),
  });

  const context = {
    trialId: 'trial-1',
    requestHash: HASH('8'),
    taskArchive: taskManifest,
  };
  assert.deepEqual(await captured.handlerOptions.dockerPolicy(context), buildDockerPolicy(context));
  assert.deepEqual(await captured.handlerOptions.brokerPolicy(context), buildBrokerPolicy(context));
  assert.deepEqual(await captured.handlerOptions.runner(context), {
    argv: [
      '/opt/engineer/bin/engineer-eval-runner',
      '--input-sha256',
      taskManifest.sha256,
    ],
    cwd: topo.paths.workspace,
    env: { LANG: 'C.UTF-8' },
    timeoutMs: 90_000,
  });

  const descriptor = await captured.handlerOptions.openProviderKeyFd(Buffer.from('provider-key'));
  assert.equal(descriptor, 17);
  await captured.handlerOptions.effects.closeInheritedFd(descriptor);
  assert.equal(captured.closedByEffects, 17);
  assert.deepEqual(custody.calls.slice(-1), [['released', 17]]);
});

test('zero-provider bridge mode reaches the handler without provider bytes or FIFO handoff', async () => {
  const captured = {};
  const custody = fakeCustody();
  const entrypoint = createRemoteSupervisorEntrypoint({
    topology: topology(),
    buildDockerPolicy: () => ({}),
    buildBrokerPolicy: () => ({}),
    dependencies: {
      platform: 'linux',
      environment: {},
      createEffects: () => ({
        async bindControlChannel(value) { captured.bound = value; },
        async closeInheritedFd() { assert.fail('zero-provider mode has no provider descriptor'); },
      }),
      createHandlerFactory: () => async (input) => {
        captured.handlerInput = input;
        return { async handleFrame() { return { response: Buffer.from('{}'), done: true }; } };
      },
      createCustody: () => custody,
      async bridgeCli({ handlerFactory }) {
        const hmacKey = Buffer.alloc(32, 0xb2);
        await handlerFactory({
          hmacKey,
          executionMode: ZERO_PROVIDER_CANARY,
          controlChannel: authenticatedControlChannel(hmacKey, ZERO_PROVIDER_CANARY),
        });
        await assert.rejects(handlerFactory({
          hmacKey,
          executionMode: ZERO_PROVIDER_CANARY,
          providerKey: Buffer.from('forbidden-provider-key'),
          controlChannel: authenticatedControlChannel(hmacKey, ZERO_PROVIDER_CANARY),
        }), /provider|execution mode|control/i);
        await assert.rejects(handlerFactory({
          hmacKey,
          executionMode: CONTROLLED_PROVIDER,
          controlChannel: authenticatedControlChannel(hmacKey, CONTROLLED_PROVIDER),
        }), /provider|execution mode|control/i);
        return { status: 'complete' };
      },
    },
  });

  assert.deepEqual(await entrypoint.run({ argv: ['--control-stdio'] }), { status: 'complete' });
  assert.deepEqual(Object.keys(captured.handlerInput).sort(), ['executionMode', 'hmacKey']);
  assert.equal(captured.handlerInput.executionMode, ZERO_PROVIDER_CANARY);
  assert.equal(Object.prototype.hasOwnProperty.call(captured.handlerInput, 'providerKey'), false);
  assert.equal(captured.bound.executionMode, ZERO_PROVIDER_CANARY);
  assert.deepEqual(custody.calls, [['dispose']], 'provider custody is never opened in zero-provider mode');
});

test('fails closed on ambient provider or Daytona credentials, non-Linux defaults, and route drift', async () => {
  const definition = {
    topology: topology(),
    buildDockerPolicy: () => ({}),
    buildBrokerPolicy: () => ({}),
  };
  assert.doesNotThrow(() => createRemoteSupervisorEntrypoint({
    ...definition,
    dependencies: {
      platform: 'linux',
      environment: { PATH: '/usr/bin', ...DAYTONA_METADATA },
      createEffects: () => ({
        bindControlChannel: async () => ({ bound: true }),
        closeInheritedFd: async () => ({ closed: true }),
      }),
      createCustody: fakeCustody,
    },
  }));
  for (const environment of [
    { OPENROUTER_API_KEY: 'redacted' },
    { DAYTONA_API_KEY: 'redacted' },
    { DAYTONA_UNKNOWN: 'redacted' },
    { ANTHROPIC_AUTH_TOKEN: 'redacted' },
    { AWS_SECRET_ACCESS_KEY: 'redacted' },
  ]) {
    assert.throws(
      () => createRemoteSupervisorEntrypoint({
        ...definition,
        dependencies: { platform: 'linux', environment },
      }),
      (error) => error instanceof RemoteSupervisorEntrypointError
        && error.code === 'ERR_REMOTE_SUPERVISOR_ENVIRONMENT'
        && !error.message.includes('redacted')
    );
  }
  assert.throws(
    () => createRemoteSupervisorEntrypoint({
      ...definition,
      dependencies: { platform: 'darwin', environment: {} },
    }),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_PLATFORM'
  );
  await assert.rejects(
    runRemoteSupervisorCli(),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_DEFINITION'
  );

  const custody = fakeCustody();
  const entrypoint = createRemoteSupervisorEntrypoint({
    ...definition,
    dependencies: {
      platform: 'linux',
      environment: {},
      createEffects: () => ({
        bindControlChannel: async () => ({ bound: true }),
        closeInheritedFd: async () => ({ closed: true }),
      }),
      createHandlerFactory: () => async () => ({}),
      createCustody: () => custody,
      bridgeCli: async () => assert.fail('drifted route reached the bridge'),
    },
  });
  await assert.rejects(
    entrypoint.run({ argv: ['--control-stdio', '--extra'] }),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_INVOCATION'
  );
  assert.deepEqual(custody.calls, []);

  const disposalFailure = createRemoteSupervisorEntrypoint({
    ...definition,
    dependencies: {
      platform: 'linux',
      environment: {},
      createEffects: () => ({
        bindControlChannel: async () => ({ bound: true }),
        closeInheritedFd: async () => ({ closed: true }),
      }),
      createHandlerFactory: () => async () => ({}),
      createCustody: () => ({
        async open() { return 17; },
        async close() {},
        async releaseAfterExternalClose() {},
        async dispose() { throw new Error('sk-cleanup-secret'); },
      }),
      bridgeCli: async () => ({ status: 'complete' }),
    },
  });
  await assert.rejects(
    disposalFailure.run({ argv: ['--control-stdio'] }),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_CLEANUP'
      && !error.message.includes('sk-cleanup-secret')
  );
});

test('direct CLI loads the one code-owned definition when no embedding definition is supplied', async () => {
  let loads = 0;
  const custody = fakeCustody();
  const result = await runRemoteSupervisorCli({
    definitionLoader: async () => {
      loads += 1;
      return {
        topology: topology(),
        buildDockerPolicy: () => ({}),
        buildBrokerPolicy: () => ({}),
      };
    },
    argv: ['--control-stdio'],
    dependencies: {
      platform: 'linux',
      environment: {},
      createEffects: () => ({
        bindControlChannel: async () => ({ bound: true }),
        closeInheritedFd: async () => ({ closed: true }),
      }),
      createHandlerFactory: () => async () => ({}),
      createCustody: () => custody,
      bridgeCli: async () => ({ status: 'complete' }),
    },
  });
  assert.equal(loads, 1);
  assert.deepEqual(result, { status: 'complete' });
  assert.deepEqual(custody.calls, [['dispose']]);

  await assert.rejects(
    runRemoteSupervisorCli({
      definitionLoader: async () => ({
        topology: { suppliedByOperator: true },
        buildDockerPolicy: null,
        buildBrokerPolicy: null,
      }),
      argv: ['--control-stdio'],
      dependencies: { platform: 'linux', environment: {} },
    }),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_DEFINITION'
  );
});

test('direct CLI closes a resumed control pipe after a sanitized fatal failure', () => {
  const writes = [];
  let destroyed = 0;
  const previousExitCode = process.exitCode;
  try {
    terminateRemoteSupervisorProcess(new Error('sk-private-failure'), {
      input: { destroy() { destroyed += 1; } },
      errorOutput: { write(bytes) { writes.push(String(bytes)); } },
    });
    assert.equal(destroyed, 1);
    assert.deepEqual(writes, ['engineer remote supervisor failed: ERR_REMOTE_SUPERVISOR\n']);
    assert.equal(process.exitCode, 70);
    assert.equal(writes.join('').includes('sk-private-failure'), false);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('fatal direct process exits while its parent keeps the resumed stdin pipe open', async () => {
  const moduleUrl = new URL('../../../evals/runtime/remote-supervisor.mjs', import.meta.url).href;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      `import { terminateRemoteSupervisorProcess } from ${JSON.stringify(moduleUrl)};`,
      'process.stdin.resume();',
      "setImmediate(() => terminateRemoteSupervisorProcess(new Error('sk-private-child-failure')));",
    ].join('\n'),
  ], {
    env: { LANG: 'C.UTF-8', PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdin.destroy();
      child.kill('SIGKILL');
      reject(new Error('fatal direct process did not close its resumed stdin pipe'));
    }, 1_000);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(result, { code: 70, signal: null });
  assert.equal(Buffer.concat(stdout).length, 0);
  assert.equal(
    Buffer.concat(stderr).toString('utf8'),
    'engineer remote supervisor failed: ERR_REMOTE_SUPERVISOR\n',
  );
  assert.equal(Buffer.concat(stderr).includes(Buffer.from('sk-private-child-failure')), false);
});

test('production remote CLI deletes Daytona metadata before definition loading', async () => {
  await withLiveDaytonaMetadata(async () => {
    let loadedAfterScrub = false;
    await assert.rejects(
      runRemoteSupervisorCli({
        definitionLoader: async () => {
          loadedAfterScrub = Object.keys(DAYTONA_METADATA)
            .every((name) => !Object.hasOwn(process.env, name));
          throw new Error('definition unavailable after observation');
        },
      }),
      (error) => error.code === 'ERR_REMOTE_SUPERVISOR_DEFINITION',
    );
    assert.equal(loadedAfterScrub, true);
  });
});

test('serialized topology cannot spoof a live authenticated control-channel observation', () => {
  for (const spoof of [
    { controlChannelAuthenticated: true },
    { controlChannelKind: 'inherited-pipe' },
    { controlChannelReceipt: { authenticated: true, peerUid: 0 } },
    { controlChannelStream: { destroyed: false } },
  ]) {
    assert.throws(
      () => createRemoteSupervisorEntrypoint({
        topology: topology(spoof),
        buildDockerPolicy: () => ({}),
        buildBrokerPolicy: () => ({}),
        dependencies: { platform: 'linux', environment: {} },
      }),
      (error) => error instanceof RemoteSupervisorEntrypointError &&
        error.code === 'ERR_REMOTE_SUPERVISOR_DEFINITION'
    );
  }
});

test('attests owner-only regular archives and rejects digest, permission, and symlink drift', async (t) => {
  const fixture = await ownerOnlyFixture(t);
  const file = path.join(fixture.directory, 'task-input.tar');
  assert.deepEqual(await inspectBoundArchive({
    file,
    kind: 'task-input',
    expectedByteLength: fixture.taskBytes.length,
    expectedSha256: sha256(fixture.taskBytes),
  }), {
    kind: 'task-input',
    byteLength: fixture.taskBytes.length,
    sha256: sha256(fixture.taskBytes),
  });
  await assert.rejects(
    inspectBoundArchive({ file, kind: 'trial-output' }),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH'
  );
  await assert.rejects(
    inspectBoundArchive({
      file: path.join(fixture.directory, 'trial-output.tar'),
      kind: 'task-input',
    }),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH'
  );
  await assert.rejects(
    inspectBoundArchive({
      file,
      kind: 'task-input',
      expectedByteLength: fixture.taskBytes.length,
      expectedSha256: HASH('0'),
    }),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_ARCHIVE_DIGEST'
  );
  await fs.chmod(file, 0o644);
  await assert.rejects(
    inspectBoundArchive({ file, kind: 'task-input' }),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH'
  );
  await fs.chmod(file, 0o600);
  const linked = path.join(fixture.directory, 'linked.tar');
  await fs.symlink(file, linked);
  await assert.rejects(
    inspectBoundArchive({ file: linked, kind: 'task-input' }),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_ARCHIVE_PATH'
  );
});

test('uses an owner-only FIFO descriptor, unlinks it after handoff, and cleans every failure path', async () => {
  const calls = [];
  const pipeDriver = {
    async inspectParent(spec) {
      calls.push(['parent', spec]);
      return { real: true, directory: true, ownerUid: 0, mode: 0o700 };
    },
    async ensureAbsent(spec) { calls.push(['absent', spec]); return true; },
    async createFifo(spec) { calls.push(['fifo', spec]); return true; },
    async inspectFifo(spec) {
      calls.push(['inspect', spec]);
      return { fifo: true, ownerUid: 0, mode: 0o600 };
    },
    async openFifo(spec) { calls.push(['open', spec]); return { readFd: 23, writeFd: 24 }; },
    async inspectDescriptor(fd) { calls.push(['descriptor', fd]); return { fifo: true, ownerUid: 0, mode: 0o600 }; },
    async writeAll(fd, bytes) { calls.push(['write', fd, Buffer.from(bytes)]); },
    async unlink(spec) { calls.push(['unlink', spec]); },
    async close(fd) { calls.push(['close', fd]); },
  };
  const custody = createProviderKeyDescriptorCustody({
    pipePath: '/engineer-bounded/transport/provider-key.pipe',
    platform: 'linux',
    expectedOwnerUid: 0,
    driver: pipeDriver,
  });
  const secret = Buffer.from('sk-provider-private');
  assert.equal(await custody.open(secret), 23);
  assert.equal(secret.toString(), 'sk-provider-private');
  const create = calls.find(([name]) => name === 'fifo')[1];
  assert.equal(create.file, '/usr/bin/mkfifo');
  assert.deepEqual(create.args, ['--mode=600', '--', '/engineer-bounded/transport/provider-key.pipe']);
  assert.equal(create.shell, false);
  assert.equal(create.timeoutMs, 5_000);
  assert.deepEqual(create.env, { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' });
  assert.equal(JSON.stringify(create).includes('sk-provider-private'), false);
  assert.equal(calls.filter(([name]) => name === 'unlink').length, 1);
  await custody.releaseAfterExternalClose(23);
  await custody.dispose();
  assert.deepEqual(calls.filter(([name]) => name === 'close'), [['close', 24]]);

  const failingCalls = [];
  const failed = createProviderKeyDescriptorCustody({
    pipePath: '/engineer-bounded/transport/provider-key.pipe',
    platform: 'linux',
    expectedOwnerUid: 0,
    driver: {
      ...pipeDriver,
      async ensureAbsent() { return true; },
      async createFifo() { return true; },
      async inspectFifo() { return { fifo: true, ownerUid: 0, mode: 0o600 }; },
      async openFifo() { return { readFd: 29, writeFd: 30 }; },
      async inspectDescriptor() { return { fifo: true, ownerUid: 0, mode: 0o600 }; },
      async writeAll() { throw new Error('sk-provider-private must never escape'); },
      async unlink() { failingCalls.push('unlink'); },
      async close(fd) { failingCalls.push(['close', fd]); },
    },
  });
  await assert.rejects(
    failed.open(secret),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_CREDENTIAL'
      && !error.message.includes('sk-provider-private')
  );
  assert.deepEqual(failingCalls, [['close', 30], ['close', 29], 'unlink']);

  let readCloseAttempts = 0;
  const retryClose = createProviderKeyDescriptorCustody({
    pipePath: '/engineer-bounded/transport/provider-key.pipe',
    platform: 'linux',
    expectedOwnerUid: 0,
    driver: {
      ...pipeDriver,
      async ensureAbsent() { return true; },
      async createFifo() { return true; },
      async inspectFifo() { return { fifo: true, ownerUid: 0, mode: 0o600 }; },
      async openFifo() { return { readFd: 31, writeFd: 32 }; },
      async inspectDescriptor() { return { fifo: true, ownerUid: 0, mode: 0o600 }; },
      async writeAll() {},
      async unlink() {},
      async close(fd) {
        if (fd === 31 && readCloseAttempts++ === 0) throw new Error('sk-close-secret');
      },
    },
  });
  assert.equal(await retryClose.open(secret), 31);
  await assert.rejects(
    retryClose.close(31),
    (error) => error.code === 'ERR_REMOTE_SUPERVISOR_CREDENTIAL'
      && !error.message.includes('sk-close-secret')
  );
  assert.equal(readCloseAttempts, 2);
});
