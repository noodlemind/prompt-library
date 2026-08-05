import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  downloadPinnedSnapshotSource,
  downloadPinnedSnapshotSourceWithFetch,
  prepareRuntimeSnapshotArtifacts,
  pullExactImages,
  runDaytonaSnapshotCliCommand,
  runRuntimeSnapshotArtifactCommand,
  smokeNodeRuntimeClosure,
  withBuilderContainer,
} from '../../../evals/runtime/runtime-snapshot-artifacts.mjs';
import {
  DAYTONA_DIND_BASE_IMAGE,
  DAYTONA_DIND_BASE_IMAGE_DIGEST,
  DAYTONA_EXECUTABLE_PATHS,
  DAYTONA_NODE_RUNTIME_IMAGE,
  DAYTONA_NODE_RUNTIME_IMAGE_DIGEST,
  DAYTONA_NODE_USTAR_ATTESTATION,
  DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256,
} from '../../../evals/runtime/daytona-topology.mjs';

const HASH = (character) => character.repeat(64);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('bounded production artifact commands always hard-kill at their timeout', () => {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args: [...args], options });
    return { status: 0, stdout: '', stderr: '', error: null };
  };

  runDaytonaSnapshotCliCommand('/opt/daytona', ['delete', 'sandbox-id'],
    { timeoutMs: 1_234 }, spawnImpl);
  runDaytonaSnapshotCliCommand('/opt/daytona', ['snapshot', 'create', 'snapshot-name'],
    undefined, spawnImpl);
  runDaytonaSnapshotCliCommand('/opt/daytona', ['info', 'sandbox-id'], undefined, spawnImpl);

  assert.equal(calls[0].options.timeout, 1_234);
  assert.equal(calls[0].options.killSignal, 'SIGKILL');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[1].options.timeout, 30 * 60_000);
  assert.equal(calls[1].options.killSignal, 'SIGKILL');
  assert.equal(calls[2].options.timeout, 5 * 60_000);
  assert.equal(calls[2].options.killSignal, 'SIGKILL');
  assert.throws(() => runDaytonaSnapshotCliCommand('/opt/daytona', ['delete', 'sandbox-id'],
    { timeoutMs: 0 }, spawnImpl), /timeout.*bound/i);
  assert.throws(() => runDaytonaSnapshotCliCommand('/opt/daytona', ['delete', 'sandbox-id'],
    { timeoutMs: 1_000, extra: true }, spawnImpl), /command options/i);

  runRuntimeSnapshotArtifactCommand('/usr/bin/tool', ['bounded'], {
    timeoutMs: 4_321,
  }, spawnImpl);
  assert.equal(calls[3].options.timeout, 4_321);
  assert.equal(calls[3].options.killSignal, 'SIGKILL');
  assert.equal(calls[3].options.shell, false);
});

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
      node: {
        version: 'v22.17.1',
        platform: 'linux/amd64-musl',
        runtimeImage: DAYTONA_NODE_RUNTIME_IMAGE,
        runtimeImageDigest: DAYTONA_NODE_RUNTIME_IMAGE_DIGEST,
        binarySha256: DAYTONA_USTAR_ATTESTED_EXECUTABLE_SHA256.node,
      },
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

test('production pinned downloads run behind a hard-kill process deadline and prove failed residue absent', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-source-process-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const successCalls = [];
  const bytes = Buffer.from('verified helper result');
  const expectedSha256 = sha256(bytes);
  const successDestination = path.join(workspace, 'harbor-source.tar.gz');
  await downloadPinnedSnapshotSource({
    url: 'https://example.invalid/source.tar.gz',
    expectedSha256,
    destination: successDestination,
  }, {
    spawnImpl(file, args, options) {
      successCalls.push({ file, args, options });
      if (args[1] === '--cleanup') return spawnSync(file, args, options);
      const token = args[args.indexOf('--attempt-token') + 1];
      const partial = path.join(workspace, `.engineer-pinned-source-${token}`, 'source.partial');
      fs.writeFileSync(partial, bytes, { mode: 0o400 });
      return {
        status: 0,
        signal: null,
        error: null,
        stdout: `ENGINEER-PINNED-SOURCE/1 ${expectedSha256}\n`,
        stderr: '',
      };
    },
    randomBytes: () => Buffer.alloc(16, 0x11),
  });
  assert.equal(successCalls.length, 2);
  assert.equal(successCalls[0].args[1], '--download');
  assert.equal(successCalls[0].options.timeout, 5 * 60_000);
  assert.equal(successCalls[0].options.killSignal, 'SIGKILL');
  assert.equal(successCalls[1].args[1], '--cleanup');
  assert.deepEqual(fs.readFileSync(successDestination), bytes);
  assert.equal(fs.existsSync(path.join(workspace, `.engineer-pinned-source-${'11'.repeat(16)}`)), false);

  const failedCalls = [];
  const failedDestination = path.join(workspace, 'failed-source.tar.gz');
  await assert.rejects(downloadPinnedSnapshotSource({
    url: 'https://example.invalid/source.tar.gz',
    expectedSha256,
    destination: failedDestination,
  }, {
    spawnImpl(file, args, options) {
      failedCalls.push({ file, args, options });
      if (args[1] === '--cleanup') return spawnSync(file, args, options);
      return {
        status: null,
        signal: 'SIGKILL',
        error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
        stdout: '',
        stderr: '',
      };
    },
    randomBytes: () => Buffer.alloc(16, 0x22),
  }), (error) => error?.code === 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_TIMEOUT');
  assert.equal(failedCalls.length, 2);
  assert.equal(failedCalls[1].args[1], '--cleanup');
  assert.equal(failedCalls[1].options.timeout, 10_000);
  assert.equal(failedCalls[1].options.killSignal, 'SIGKILL');
  assert.equal(fs.existsSync(failedDestination), false);
  assert.equal(fs.existsSync(path.join(workspace, `.engineer-pinned-source-${'22'.repeat(16)}`)), false);
});

test('the pinned-source helper deletes only a token-bound attempt partial and proves absence', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-source-helper-cleanup-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const helper = fileURLToPath(
    new URL('../../../evals/runtime/pinned-snapshot-source.mjs', import.meta.url),
  );
  const destination = path.join(workspace, 'harbor-source.tar.gz');
  const token = '3'.repeat(32);
  const attemptDirectory = path.join(workspace, `.engineer-pinned-source-${token}`);
  fs.mkdirSync(attemptDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(attemptDirectory, 'source.partial'), 'partial', { mode: 0o400 });

  const cleaned = spawnSync(process.execPath, [
    helper, '--cleanup', '--destination', destination, '--attempt-token', token,
  ], { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL' });
  assert.equal(cleaned.status, 0);
  assert.equal(cleaned.stdout, 'ENGINEER-PINNED-SOURCE-ABSENT/1\n');
  assert.equal(cleaned.stderr, '');
  assert.equal(fs.existsSync(attemptDirectory), false);

  const foreignToken = '4'.repeat(32);
  const foreignAttempt = path.join(workspace, `.engineer-pinned-source-${foreignToken}`);
  fs.mkdirSync(foreignAttempt, { mode: 0o700 });
  const foreignPartial = path.join(foreignAttempt, 'source.partial');
  fs.writeFileSync(foreignPartial, 'foreign-mode', { mode: 0o644 });
  const refused = spawnSync(process.execPath, [
    helper, '--cleanup', '--destination', destination, '--attempt-token', foreignToken,
  ], { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL' });
  assert.equal(refused.status, 70);
  assert.equal(refused.stdout, 'ENGINEER-PINNED-SOURCE-FAILURE/1\n');
  assert.equal(refused.stderr, '');
  assert.equal(fs.existsSync(foreignPartial), true);
});

test('a pre-existing owner-private destination is preserved without starting a helper', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-source-existing-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destination = path.join(workspace, 'harbor-source.tar.gz');
  const existing = Buffer.from('must remain untouched');
  fs.writeFileSync(destination, existing, { mode: 0o400 });
  let spawnCalls = 0;

  await assert.rejects(downloadPinnedSnapshotSource({
    url: 'https://example.invalid/source.tar.gz',
    expectedSha256: HASH('1'),
    destination,
  }, {
    spawnImpl() {
      spawnCalls += 1;
      throw new Error('helper must not start');
    },
    randomBytes: () => Buffer.alloc(16, 0x55),
  }), /destination.*absent|must be absent/i);

  assert.equal(spawnCalls, 0);
  assert.deepEqual(fs.readFileSync(destination), existing);
});

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

  await downloadPinnedSnapshotSourceWithFetch({
    url,
    expectedSha256: sha256(bytes),
    destination,
  }, { fetchImpl });

  assert.deepEqual(fs.readFileSync(destination), bytes);
});

test('pinned snapshot source applies one total deadline and cancels a stalled body without residue', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-snapshot-download-timeout-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destination = path.join(workspace, 'source.tar.gz');
  const url = 'https://example.invalid/source.tar.gz';
  let capturedSignal;
  let returned = false;
  let cancelled = false;
  let reads = 0;
  const body = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      reads += 1;
      if (reads === 1) return Promise.resolve({ done: false, value: Buffer.from('partial') });
      return new Promise(() => {});
    },
    return() {
      returned = true;
      return Promise.resolve({ done: true });
    },
    cancel() {
      cancelled = true;
      return Promise.resolve();
    },
  };
  const fetchImpl = async (_expected, options) => {
    capturedSignal = options.signal;
    return {
      status: 200,
      url,
      headers: { get: () => null },
      body,
    };
  };

  await assert.rejects(downloadPinnedSnapshotSourceWithFetch({
    url,
    expectedSha256: HASH('1'),
    destination,
  }, { fetchImpl, deadlineMs: 20 }), (error) =>
    error?.code === 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_TIMEOUT' &&
      error.message === 'pinned source download exceeded its elapsed-time deadline');

  assert.equal(capturedSignal.aborted, true);
  assert.equal(returned, true);
  assert.equal(cancelled, true);
  assert.equal(fs.existsSync(destination), false);
});

test('pinned snapshot source deadline covers the initial fetch and leaves no destination', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-snapshot-fetch-timeout-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destination = path.join(workspace, 'source.tar.gz');
  let capturedSignal;

  await assert.rejects(downloadPinnedSnapshotSourceWithFetch({
    url: 'https://example.invalid/source.tar.gz',
    expectedSha256: HASH('1'),
    destination,
  }, {
    deadlineMs: 20,
    fetchImpl: async (_expected, options) => {
      capturedSignal = options.signal;
      return new Promise(() => {});
    },
  }), (error) => error?.code === 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_TIMEOUT');

  assert.equal(capturedSignal.aborted, true);
  assert.equal(fs.existsSync(destination), false);
});

test('an immediately resolving large body cannot outrun the total elapsed deadline', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-snapshot-fast-body-timeout-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destination = path.join(workspace, 'source.tar.gz');
  const bytes = Buffer.alloc(32 * 1024 * 1024, 0x61);
  const expectedSha256 = sha256(bytes);

  await assert.rejects(downloadPinnedSnapshotSourceWithFetch({
    url: 'https://example.invalid/source.tar.gz',
    expectedSha256,
    destination,
  }, {
    deadlineMs: 1,
    fetchImpl: async () => ({
      status: 200,
      url: 'https://example.invalid/source.tar.gz',
      headers: { get: () => String(bytes.length) },
      body: (async function* immediateBody() { yield bytes; })(),
    }),
  }), (error) => error?.code === 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_TIMEOUT');

  assert.equal(fs.existsSync(destination), false);
  bytes.fill(0);
});

test('an elapsed precheck starts no fetch and produces no unhandled rejection', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-snapshot-precheck-timeout-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destination = path.join(workspace, 'source.tar.gz');
  const clock = [0, 1];
  let fetchCalls = 0;
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  await assert.rejects(downloadPinnedSnapshotSourceWithFetch({
    url: 'https://example.invalid/source.tar.gz',
    expectedSha256: HASH('1'),
    destination,
  }, {
    deadlineMs: 1,
    monotonicNow: () => clock.shift() ?? 1,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('must never be scheduled');
    },
  }), (error) => error?.code === 'ERR_RUNTIME_SNAPSHOT_DOWNLOAD_TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls, 0);
  assert.deepEqual(unhandled, []);
  assert.equal(fs.existsSync(destination), false);
});

function ownedBuilderFixture({ createFailure = null, createOutput = 'a'.repeat(64), wrongOwner = false,
  removalSticks = true, removeFailure = null } = {}) {
  const calls = [];
  const commandOptions = [];
  let present = false;
  let name;
  let token;
  let removeAttempts = 0;
  const runDocker = (args, options) => {
    calls.push([...args]);
    commandOptions.push(options);
    if (args[0] === 'create') {
      name = args[args.indexOf('--name') + 1];
      const labels = args.filter((_entry, index) => args[index - 1] === '--label');
      token = labels.find((label) => label.startsWith('io.noodlemind.engineer.eval.builder-id='))?.split('=')[1];
      present = createFailure?.created ?? true;
      if (createFailure) throw createFailure.error;
      return createOutput;
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      if (!present) return '';
      return [
        createOutput.trim(),
        name,
        wrongOwner ? 'foreign' : 'runtime-snapshot-artifacts.v1',
        token,
      ].join('\t') + '\n';
    }
    if (args[0] === 'rm') {
      removeAttempts += 1;
      if (removeFailure === 'before' && removeAttempts === 1) {
        throw new Error('remove response lost before effect');
      }
      if (removalSticks) present = false;
      if (removeFailure === 'after' && removeAttempts === 1) {
        throw new Error('remove response lost after effect');
      }
      return createOutput.trim() + '\n';
    }
    throw new Error(`unexpected Docker command: ${args.join(' ')}`);
  };
  return {
    calls,
    commandOptions,
    runDocker,
    state: () => ({ name, token, present, removeAttempts }),
  };
}

test('builder containers carry generated ownership and prove absence after successful work', () => {
  const fixture = ownedBuilderFixture();
  const result = withBuilderContainer(fixture.runDocker, ['pinned-image'], (containerId) => {
    assert.equal(containerId, 'a'.repeat(64));
    return 'built';
  }, { wait: () => {} });

  assert.equal(result, 'built');
  const create = fixture.calls[0];
  const { name, token, present } = fixture.state();
  assert.match(name, /^engineer-eval-builder-[a-f0-9]{32}$/);
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.deepEqual(create.slice(0, 7), [
    'create', '--name', name,
    '--label', 'io.noodlemind.engineer.eval.builder=runtime-snapshot-artifacts.v1',
    '--label', `io.noodlemind.engineer.eval.builder-id=${token}`,
  ]);
  assert.equal(fixture.calls.some((args) => args[0] === 'rm' && args[2] === 'a'.repeat(64)), true);
  assert.equal(fixture.calls.at(-1)[0], 'container');
  assert.equal(present, false);
});

test('ambiguous builder create failure reconciles the owned name and proves absence', () => {
  const primary = new Error('create response lost');
  const fixture = ownedBuilderFixture({ createFailure: { created: true, error: primary } });

  assert.throws(
    () => withBuilderContainer(fixture.runDocker, ['pinned-image'],
      () => assert.fail('must not run'), { wait: () => {} }),
    (error) => error === primary,
  );
  const { name, present } = fixture.state();
  assert.equal(fixture.calls.some((args) => args[0] === 'rm' && args[2] === 'a'.repeat(64)), true);
  assert.equal(fixture.calls.at(-1)[0], 'container');
  assert.equal(present, false);
});

test('ambiguous builder creation requires consecutive absence after delayed visibility', () => {
  const containerId = 'b'.repeat(64);
  let name;
  let token;
  let listCalls = 0;
  let present = false;
  let removeCalls = 0;
  const runDocker = (args) => {
    if (args[0] === 'create') {
      name = args[args.indexOf('--name') + 1];
      token = args.filter((_entry, index) => args[index - 1] === '--label')
        .find((label) => label.startsWith('io.noodlemind.engineer.eval.builder-id='))
        .split('=')[1];
      throw new Error('create response lost before visibility');
    }
    if (args[0] === 'container') {
      listCalls += 1;
      if (listCalls === 2) present = true;
      if (!present) return '';
      return `${containerId}\t${name}\truntime-snapshot-artifacts.v1\t${token}\n`;
    }
    if (args[0] === 'rm') {
      removeCalls += 1;
      assert.equal(args[2], containerId);
      present = false;
      return `${containerId}\n`;
    }
    throw new Error(`unexpected Docker command: ${args.join(' ')}`);
  };

  assert.throws(
    () => withBuilderContainer(runDocker, ['pinned-image'], () => assert.fail('must not run'),
      { wait: () => {} }),
    /create response lost/i,
  );

  assert.equal(removeCalls, 1);
  assert.equal(present, false);
  assert.equal(listCalls, 5,
    'one early absence, one delayed owned observation, then three consecutive absences');
});

test('builder cleanup reconciles lost remove responses before deciding whether to retry', () => {
  for (const removeFailure of ['after', 'before']) {
    const fixture = ownedBuilderFixture({ removeFailure });
    assert.equal(withBuilderContainer(
      fixture.runDocker,
      ['pinned-image'],
      () => 'built',
      { wait: () => {} },
    ), 'built');
    const state = fixture.state();
    assert.equal(state.present, false, removeFailure);
    assert.equal(state.removeAttempts, removeFailure === 'after' ? 1 : 2, removeFailure);
    assert.equal(fixture.calls.at(-1)[0], 'container', removeFailure);
    const cleanupOptions = fixture.commandOptions.filter((value) => value?.timeoutMs != null);
    assert.ok(cleanupOptions.length >= 2, removeFailure);
    assert.ok(cleanupOptions.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 10_000));
  }
});

test('builder cleanup refuses foreign ownership and fails if absence cannot be proved', () => {
  const primary = new Error('create response lost');
  const foreign = ownedBuilderFixture({
    createFailure: { created: true, error: primary },
    wrongOwner: true,
  });
  assert.throws(
    () => withBuilderContainer(foreign.runDocker, ['pinned-image'], () => {}, { wait: () => {} }),
    (error) => error instanceof AggregateError && error.errors[0] === primary,
  );
  assert.equal(foreign.calls.some((args) => args[0] === 'rm'), false);

  const lingering = ownedBuilderFixture({ removalSticks: false });
  assert.throws(
    () => withBuilderContainer(lingering.runDocker, ['pinned-image'],
      () => 'built', { wait: () => {} }),
    /absence|cleanup|owned/i,
  );
  assert.equal(lingering.state().present, true);
});

test('builder cleanup uses bounded backoff until a transient Docker outage recovers', () => {
  const containerId = 'a'.repeat(64);
  let name;
  let token;
  let present = false;
  let cleanupStarted = false;
  let monotonicMs = 0;
  const waits = [];
  const cleanupTimeouts = [];
  const runDocker = (args, options) => {
    if (options?.timeoutMs != null) cleanupTimeouts.push(options.timeoutMs);
    if (args[0] === 'create') {
      name = args[args.indexOf('--name') + 1];
      token = args.filter((_entry, index) => args[index - 1] === '--label')
        .find((label) => label.startsWith('io.noodlemind.engineer.eval.builder-id='))
        .split('=')[1];
      present = true;
      return containerId;
    }
    if (args[0] === 'container') {
      if (cleanupStarted && monotonicMs < 700) throw new Error('Docker daemon restarting');
      if (!present) return '';
      return `${containerId}\t${name}\truntime-snapshot-artifacts.v1\t${token}\n`;
    }
    if (args[0] === 'rm') {
      present = false;
      return `${containerId}\n`;
    }
    throw new Error(`unexpected Docker command: ${args.join(' ')}`);
  };

  assert.equal(withBuilderContainer(runDocker, ['pinned-image'], () => {
    cleanupStarted = true;
    return 'built';
  }, {
    monotonicNow: () => monotonicMs,
    wait(milliseconds) {
      waits.push(milliseconds);
      monotonicMs += milliseconds;
    },
  }), 'built');

  assert.equal(present, false);
  assert.ok(waits.length >= 3);
  assert.ok(waits.every((milliseconds) => milliseconds >= 100 && milliseconds <= 5_000));
  assert.ok(waits.slice(1).every((milliseconds, index) => milliseconds >= waits[index]));
  assert.ok(cleanupTimeouts.length >= 3);
  assert.ok(cleanupTimeouts.every((milliseconds) => milliseconds > 0 && milliseconds <= 10_000));
  assert.ok(monotonicMs >= 700 && monotonicMs < 60_000);
});

test('pinned builder platform inspection resolves the requested linux/amd64 manifest', () => {
  const calls = [];
  pullExactImages((args) => {
    calls.push(args);
    return args[0] === 'image' ? 'linux/amd64\n' : '';
  });

  const inspections = calls.filter(([command]) => command === 'image');
  assert.equal(inspections.length, 5);
  assert.equal(calls.some((args) => args[0] === 'pull' && args.at(-1) === DAYTONA_NODE_RUNTIME_IMAGE), true);
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

test('smokes the complete regular-file Node closure in the exact final DIND base without network', () => {
  const calls = [];
  smokeNodeRuntimeClosure((args) => {
    calls.push(args);
    return 'v22.17.1\n';
  }, '/snapshot-node');

  const mounts = DAYTONA_NODE_USTAR_ATTESTATION.entries.flatMap((entry) => [
    '--mount', `type=bind,src=/snapshot-node/${entry.path},dst=/${entry.path},readonly`,
  ]);
  assert.deepEqual(calls, [[
    'run', '--rm', '--pull', 'never', '--platform', 'linux/amd64', '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...mounts,
    '--entrypoint', '/usr/local/bin/node',
    DAYTONA_DIND_BASE_IMAGE,
    '--version',
  ]]);
  assert.throws(
    () => smokeNodeRuntimeClosure(() => 'v22.17.0\n', '/snapshot-node'),
    (error) => error?.code === 'ERR_RUNTIME_SNAPSHOT_NODE_ABI',
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
