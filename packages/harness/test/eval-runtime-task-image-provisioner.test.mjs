import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  PRIVATE_DOCKER_SOCKET,
  TASK_IMAGE_CLEANUP_RESULT_SCHEMA,
  TASK_IMAGE_PRELOAD_MARKER_PATH,
  TASK_IMAGE_PRELOAD_MARKER_SCHEMA,
  TASK_IMAGE_PROVISION_RESULT_SCHEMA,
  TaskImageProvisionerError,
  createTaskImageProvisioner,
  parseTaskImageProvisionerArgs,
  runTaskImageProvisionerCli,
} from '../../../evals/runtime/task-image-provisioner.mjs';
import { RUNTIME_TOPOLOGY_RECEIPT_PATH } from '../../../evals/runtime/runtime-definition.mjs';

const SANDBOX_ID = 'sandbox-8d2890a2-57ef-4d75-91d5-2b0a81256b89';
const DIGEST = 'a'.repeat(64);
const IMAGE = `registry.example.invalid/evals/cobol-modernization@sha256:${DIGEST}`;
const IMAGE_ID = `sha256:${DIGEST}`;
const PLATFORM = 'linux/amd64';
const DOCKER = '/usr/local/bin/docker';
const SECRET = 'sk-or-v1-output-that-must-never-survive';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactArgv(overrides = {}) {
  const values = {
    sandboxId: SANDBOX_ID,
    immutableImage: IMAGE,
    imageId: IMAGE_ID,
    platform: PLATFORM,
    ...overrides,
  };
  return [
    '--sandbox-id', values.sandboxId,
    '--immutable-image', values.immutableImage,
    '--image-id', values.imageId,
    '--platform', values.platform,
  ];
}

function spec(overrides = {}) {
  return {
    sandboxId: SANDBOX_ID,
    immutableImage: IMAGE,
    imageId: IMAGE_ID,
    platform: PLATFORM,
    ...overrides,
  };
}

function successfulInspect(overrides = {}) {
  return JSON.stringify({
    id: IMAGE_ID,
    os: 'linux',
    architecture: 'amd64',
    repoDigests: [IMAGE],
    ...overrides,
  });
}

function harness(overrides = {}) {
  const calls = [];
  const order = [];
  const markerWrites = [];
  const markerAttestations = [];
  const markerRemovals = [];
  const topologyPublications = [];
  const topologyRemovals = [];
  let retainedMarker = null;
  let removeAttempts = 0;

  const runCommand = async (file, args, options) => {
    const call = {
      file,
      args: args.slice(),
      options: { ...options, env: { ...options.env } },
    };
    calls.push(call);
    const operation = args.includes('pull') ? 'pull' : args.includes('inspect') ? 'inspect' : 'remove';
    order.push(`command:${operation}`);
    if (typeof overrides.runCommand === 'function') {
      return overrides.runCommand({ call, operation, calls, order });
    }
    if (operation === 'pull') {
      return { code: 0, stdout: 'pulled exact digest\n', stderr: '' };
    }
    if (operation === 'inspect') {
      return { code: 0, stdout: successfulInspect(), stderr: '' };
    }
    return { code: 0, stdout: 'untagged exact digest\n', stderr: '' };
  };

  const writeMarkerAtomic = async (request) => {
    order.push('marker:write');
    const copy = { ...request, bytes: Buffer.from(request.bytes) };
    markerWrites.push(copy);
    retainedMarker = Buffer.from(request.bytes);
    if (typeof overrides.writeMarkerAtomic === 'function') {
      return overrides.writeMarkerAtomic(request);
    }
    return { path: request.path, atomic: true };
  };

  const attestMarker = async (request) => {
    order.push('marker:attest');
    markerAttestations.push({ ...request });
    if (typeof overrides.attestMarker === 'function') {
      return overrides.attestMarker(request, retainedMarker);
    }
    return {
      path: request.path,
      kind: 'regular-file',
      real: true,
      symlink: false,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      byteLength: retainedMarker.length,
      sha256: sha256(retainedMarker),
    };
  };

  const removeMarker = async (request) => {
    removeAttempts += 1;
    order.push('marker:remove');
    markerRemovals.push({ ...request });
    if (typeof overrides.removeMarker === 'function') {
      return overrides.removeMarker(request, removeAttempts);
    }
    retainedMarker = null;
    return { path: request.path, absent: true };
  };

  const publishRuntimeTopologyReceipt = async (request) => {
    order.push('topology:publish');
    topologyPublications.push(structuredClone(request));
    if (typeof overrides.publishRuntimeTopologyReceipt === 'function') {
      return overrides.publishRuntimeTopologyReceipt(request);
    }
    return {
      path: RUNTIME_TOPOLOGY_RECEIPT_PATH,
      kind: 'regular-file',
      real: true,
      symlink: false,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      byteLength: 2048,
      sha256: '4'.repeat(64),
      receiptNonce: '5'.repeat(64),
    };
  };

  const removeRuntimeTopologyReceipt = async () => {
    order.push('topology:remove');
    topologyRemovals.push({ path: RUNTIME_TOPOLOGY_RECEIPT_PATH });
    if (typeof overrides.removeRuntimeTopologyReceipt === 'function') {
      return overrides.removeRuntimeTopologyReceipt();
    }
    return { path: RUNTIME_TOPOLOGY_RECEIPT_PATH, absent: true };
  };

  const provisioner = createTaskImageProvisioner({
    runCommand,
    writeMarkerAtomic,
    attestMarker,
    removeMarker,
    publishRuntimeTopologyReceipt,
    removeRuntimeTopologyReceipt,
    baseEnv: overrides.baseEnv ?? { PATH: '/untrusted/path', LANG: 'host-locale' },
  });
  return {
    calls,
    order,
    markerWrites,
    markerAttestations,
    markerRemovals,
    topologyPublications,
    topologyRemovals,
    provisioner,
  };
}

test('parses only the exact fixed entrypoint argv and returns a frozen bound request', () => {
  const parsed = parseTaskImageProvisionerArgs(exactArgv());
  assert.deepEqual(parsed, spec());
  assert.equal(Object.isFrozen(parsed), true);

  for (const argv of [
    exactArgv().slice(0, -2),
    [...exactArgv(), '--platform', PLATFORM],
    ['--sandbox-id', SANDBOX_ID, '--sandbox-id', SANDBOX_ID,
      '--image-id', IMAGE_ID, '--platform', PLATFORM],
    ['--immutable-image', IMAGE, '--sandbox-id', SANDBOX_ID,
      '--image-id', IMAGE_ID, '--platform', PLATFORM],
    exactArgv().map((entry, index) => index === 0 ? `--sandbox-id=${SANDBOX_ID}` : entry),
    [...exactArgv().slice(0, -2), '--unknown', PLATFORM],
    [...exactArgv().slice(0, -1), `${PLATFORM};touch /tmp/pwn`],
  ]) {
    assert.throws(() => parseTaskImageProvisionerArgs(argv), /exact|argument|flag|platform/i);
  }
});

test('rejects mutable or malformed identities before a Docker or marker effect', async () => {
  const badSpecs = [
    spec({ immutableImage: 'registry.example.invalid/evals/cobol-modernization:latest' }),
    spec({ immutableImage: `registry.example.invalid/evals/cobol-modernization:latest@sha256:${DIGEST}` }),
    spec({ immutableImage: `registry.example.invalid/evals/cobol-modernization@sha256:${'A'.repeat(64)}` }),
    spec({ immutableImage: `registry.example.invalid/evals/cobol-modernization@sha256:${'a'.repeat(63)}` }),
    spec({ imageId: `sha256:${'b'.repeat(64)}` }),
    spec({ imageId: DIGEST }),
    spec({ platform: 'linux/arm64' }),
    spec({ platform: 'linux/amd64/v2' }),
    spec({ sandboxId: '../foreign-sandbox' }),
    { ...spec(), credential: SECRET },
  ];

  for (const badSpec of badSpecs) {
    const current = harness();
    await assert.rejects(current.provisioner.provision(badSpec), /immutable|digest|matching|platform|sandbox|field/i);
    assert.equal(current.calls.length, 0);
    assert.equal(current.markerWrites.length, 0);
  }
});

test('pulls then inspects through only the private socket before atomically attesting the owner-only marker', async () => {
  const current = harness();
  const result = await current.provisioner.provision(spec());

  assert.deepEqual(current.order, [
    'command:pull',
    'command:inspect',
    'marker:write',
    'marker:attest',
    'topology:publish',
  ]);
  assert.equal(current.calls.length, 2);
  assert.deepEqual(current.calls[0].args, [
    '--host', `unix://${PRIVATE_DOCKER_SOCKET}`,
    'image', 'pull', '--quiet', '--platform', PLATFORM, IMAGE,
  ]);
  assert.deepEqual(current.calls[1].args.slice(0, 5), [
    '--host', `unix://${PRIVATE_DOCKER_SOCKET}`,
    'image', 'inspect', '--format',
  ]);
  assert.equal(current.calls[1].args.at(-1), IMAGE);
  for (const call of current.calls) {
    assert.equal(call.file, DOCKER);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.DOCKER_HOST, undefined);
    assert.equal(call.options.env.OPENROUTER_API_KEY, undefined);
    assert.equal(call.options.env.PATH, '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    assert.equal(call.options.env.HOME, '/run/engineer/task-image-provisioner');
  }

  assert.equal(current.markerWrites.length, 1);
  const write = current.markerWrites[0];
  assert.equal(write.path, TASK_IMAGE_PRELOAD_MARKER_PATH);
  assert.equal(write.mode, 0o600);
  assert.equal(write.ownerUid, 0);
  assert.equal(write.ownerGid, 0);
  const marker = JSON.parse(write.bytes.toString('utf8'));
  assert.deepEqual(marker, {
    schema: TASK_IMAGE_PRELOAD_MARKER_SCHEMA,
    sandboxId: SANDBOX_ID,
    immutableImage: IMAGE,
    imageId: IMAGE_ID,
    platform: PLATFORM,
    pullReceiptHash: result.pullReceiptHash,
    inspectReceiptHash: result.inspectReceiptHash,
  });
  assert.equal(write.bytes.toString('utf8'), canonicalJson(marker));
  assert.deepEqual(current.markerAttestations[0], {
    path: TASK_IMAGE_PRELOAD_MARKER_PATH,
    expectedSha256: sha256(write.bytes),
    maxBytes: 8 * 1024,
  });

  assert.equal(result.schema, TASK_IMAGE_PROVISION_RESULT_SCHEMA);
  assert.equal(result.sandboxId, SANDBOX_ID);
  assert.equal(result.immutableImage, IMAGE);
  assert.equal(result.imageId, IMAGE_ID);
  assert.equal(result.platform, PLATFORM);
  assert.match(result.pullReceiptHash, /^[a-f0-9]{64}$/);
  assert.match(result.inspectReceiptHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.marker, {
    path: TASK_IMAGE_PRELOAD_MARKER_PATH,
    sha256: sha256(write.bytes),
    byteLength: write.bytes.length,
    ownerUid: 0,
    ownerGid: 0,
    mode: 0o600,
  });
  assert.deepEqual(current.topologyPublications, [{
    request: spec(),
    preload: {
      sandboxId: SANDBOX_ID,
      immutableImage: IMAGE,
      imageId: IMAGE_ID,
      platform: PLATFORM,
      pullReceiptHash: result.pullReceiptHash,
      inspectReceiptHash: result.inspectReceiptHash,
      markerSha256: sha256(write.bytes),
    },
  }]);
  assert.deepEqual(result.runtimeTopology, {
    path: RUNTIME_TOPOLOGY_RECEIPT_PATH,
    kind: 'regular-file',
    real: true,
    symlink: false,
    ownerUid: 0,
    ownerGid: 0,
    mode: 0o600,
    byteLength: 2048,
    sha256: '4'.repeat(64),
    receiptNonce: '5'.repeat(64),
  });
  const { evidenceHash, ...unsigned } = result;
  assert.equal(evidenceHash, sha256(canonicalJson(unsigned)));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.marker), true);
  assert.equal(JSON.stringify(result).includes('pulled exact digest'), false);
  assert.equal(write.bytes.includes(Buffer.from('pulled exact digest')), false);
  assert.equal(current.provisioner.snapshot().state, 'verified');
});

test('rejects ambient provider credentials before any command runner can observe the environment', () => {
  for (const baseEnv of [
    { PATH: '/usr/bin', OPENROUTER_API_KEY: 'present-even-if-never-forwarded' },
    { PATH: '/usr/bin', ANTHROPIC_API_KEY: '' },
    { PATH: '/usr/bin', DAYTONA_API_KEY: 'sandbox-must-not-have-controller-authority' },
    { PATH: '/usr/bin', INNOCENT_NAME: SECRET },
  ]) {
    assert.throws(() => harness({ baseEnv }), /ambient.*credential|provider credential/i);
  }
});

test('keeps the Docker executable, daemon socket, marker path, and command bounds code-owned', () => {
  for (const drift of [
    { dockerPath: '/tmp/docker' },
    { daemonSocket: '/var/run/docker.sock' },
    { markerPath: '/tmp/preload.json' },
    { commandTimeoutMs: 1 },
    { maxCommandOutputBytes: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() => createTaskImageProvisioner(drift), /unexpected|config/i);
  }
});

test('secret-bearing pull or inspect output is rejected, never retained, and triggers fail-closed cleanup', async () => {
  for (const secretOperation of ['pull', 'inspect']) {
    const current = harness({
      runCommand: ({ operation }) => {
        if (operation === secretOperation) {
          return { code: 0, stdout: `${SECRET}\n`, stderr: '' };
        }
        if (operation === 'pull') return { code: 0, stdout: 'safe', stderr: '' };
        if (operation === 'inspect') return { code: 0, stdout: successfulInspect(), stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    let observed;
    try {
      await current.provisioner.provision(spec());
      assert.fail('secret-bearing output unexpectedly succeeded');
    } catch (error) {
      observed = error;
    }
    assert.ok(observed instanceof TaskImageProvisionerError);
    assert.equal(observed.code, 'ERR_TASK_IMAGE_PROVISION_SECRET_OUTPUT');
    assert.equal(String(observed).includes(SECRET), false);
    assert.equal(JSON.stringify(current.provisioner.snapshot()).includes(SECRET), false);
    assert.equal(current.calls.at(-1).args.includes('rm'), true);
    assert.equal(current.markerWrites.length, 0);
    assert.equal(current.provisioner.snapshot().state, 'failed-clean');
  }
});

test('image-ID, repository-digest, or platform drift rolls back the pulled image before returning', async () => {
  for (const inspected of [
    successfulInspect({ id: `sha256:${'b'.repeat(64)}` }),
    successfulInspect({ repoDigests: [`registry.example.invalid/other@sha256:${DIGEST}`] }),
    successfulInspect({ architecture: 'arm64' }),
    '{"id":"malformed-only"}',
  ]) {
    const current = harness({
      runCommand: ({ operation }) => {
        if (operation === 'pull') return { code: 0, stdout: '', stderr: '' };
        if (operation === 'inspect') return { code: 0, stdout: inspected, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await assert.rejects(current.provisioner.provision(spec()), /inspect|identity|platform|digest/i);
    assert.deepEqual(current.order, ['command:pull', 'command:inspect', 'command:remove']);
    assert.deepEqual(current.calls.at(-1).args, [
      '--host', `unix://${PRIVATE_DOCKER_SOCKET}`,
      'image', 'rm', '--force', IMAGE,
    ]);
    assert.equal(current.markerWrites.length, 0);
    assert.equal(current.provisioner.snapshot().state, 'failed-clean');
  }
});

test('marker path, ownership, mode, content hash, or writer atomicity drift fails before handoff and removes both marker and image', async () => {
  const drifts = [
    { path: '/tmp/attacker-marker' },
    { ownerUid: 2001 },
    { mode: 0o644 },
    { sha256: 'f'.repeat(64) },
    { symlink: true, real: false },
  ];
  for (const drift of drifts) {
    const current = harness({
      attestMarker: (request, bytes) => ({
        path: request.path,
        kind: 'regular-file',
        real: true,
        symlink: false,
        ownerUid: 0,
        ownerGid: 0,
        mode: 0o600,
        byteLength: bytes.length,
        sha256: sha256(bytes),
        ...drift,
      }),
    });
    await assert.rejects(current.provisioner.provision(spec()), /marker|attestation|custody/i);
    assert.deepEqual(current.order.slice(-2), ['marker:remove', 'command:remove']);
    assert.equal(current.markerRemovals[0].path, TASK_IMAGE_PRELOAD_MARKER_PATH);
    assert.equal(current.provisioner.snapshot().state, 'failed-clean');
  }

  const writerDrift = harness({
    writeMarkerAtomic: () => ({ path: '/tmp/wrong', atomic: true }),
  });
  await assert.rejects(writerDrift.provisioner.provision(spec()), /marker|path|atomic/i);
  assert.deepEqual(writerDrift.order.slice(-2), ['marker:remove', 'command:remove']);
});

test('runtime topology publication is mandatory and any custody drift revokes receipt, marker, and image', async () => {
  for (const publishRuntimeTopologyReceipt of [
    () => { throw new Error('untrusted topology producer failed'); },
    () => ({
      path: '/tmp/operator-topology.json',
      kind: 'regular-file',
      real: true,
      symlink: false,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      byteLength: 2048,
      sha256: '4'.repeat(64),
      receiptNonce: '5'.repeat(64),
    }),
    () => ({
      path: RUNTIME_TOPOLOGY_RECEIPT_PATH,
      kind: 'regular-file',
      real: false,
      symlink: true,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      byteLength: 2048,
      sha256: '4'.repeat(64),
      receiptNonce: '5'.repeat(64),
    }),
  ]) {
    const current = harness({ publishRuntimeTopologyReceipt });
    await assert.rejects(current.provisioner.provision(spec()), /topology|custody|publication/i);
    assert.deepEqual(current.order.slice(-3), [
      'topology:remove',
      'marker:remove',
      'command:remove',
    ]);
    assert.equal(current.topologyRemovals.length, 1);
    assert.equal(current.provisioner.snapshot().state, 'failed-clean');
  }
});

test('stop revokes topology then marker before removing the image, is idempotent, and can retry cleanup', async () => {
  const current = harness({
    removeMarker: (request, attempt) => {
      if (attempt === 1) throw new Error('simulated unlink failure with no retained content');
      return { path: request.path, absent: true };
    },
  });
  const provisioned = await current.provisioner.provision(spec());

  await assert.rejects(current.provisioner.stop(), /cleanup|failed closed/i);
  assert.deepEqual(current.order.slice(-3), ['topology:remove', 'marker:remove', 'command:remove']);
  assert.equal(current.provisioner.snapshot().state, 'failed-dirty');
  const removeCallCount = current.calls.filter((entry) => entry.args.includes('rm')).length;

  const cleanup = await current.provisioner.stop();
  assert.equal(cleanup.schema, TASK_IMAGE_CLEANUP_RESULT_SCHEMA);
  assert.equal(cleanup.sandboxId, SANDBOX_ID);
  assert.equal(cleanup.preloadEvidenceHash, provisioned.evidenceHash);
  assert.equal(cleanup.runtimeTopologySha256, provisioned.runtimeTopology.sha256);
  assert.equal(cleanup.runtimeTopologyRemoved, true);
  assert.equal(cleanup.markerRemoved, true);
  assert.equal(cleanup.imageRemoved, true);
  const { evidenceHash, ...unsigned } = cleanup;
  assert.equal(evidenceHash, sha256(canonicalJson(unsigned)));
  assert.equal(current.calls.filter((entry) => entry.args.includes('rm')).length, removeCallCount,
    'a successful image removal is not repeated when marker cleanup is retried');
  assert.equal(await current.provisioner.stop(), cleanup);
  assert.equal(current.provisioner.snapshot().state, 'cleaned');
});

test('CLI emits only bounded provision evidence and sanitizes parser or provision failures', async () => {
  const current = harness();
  let stdout = '';
  let stderr = '';
  const exitCode = await runTaskImageProvisionerCli({
    argv: exactArgv(),
    provisioner: current.provisioner,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).schema, TASK_IMAGE_PROVISION_RESULT_SCHEMA);
  assert.equal(Buffer.byteLength(stdout) < 8 * 1024, true);
  assert.equal(stdout.includes('pulled exact digest'), false);

  stdout = '';
  stderr = '';
  const failed = await runTaskImageProvisionerCli({
    argv: ['--sandbox-id', SECRET],
    provisioner: {
      provision: async () => { throw new Error(SECRET); },
      stop: async () => {},
    },
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  assert.equal(failed, 70);
  assert.equal(stdout, '');
  assert.equal(stderr.includes(SECRET), false);
  assert.deepEqual(Object.keys(JSON.parse(stderr)).sort(), ['code', 'schema']);
});
