import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';

import {
  ARCHIVE_READY_LINE,
  SUPERVISOR_READY_LINE,
  runArchiveBridge,
  runRemoteBridgeCli,
  runSupervisorControlBridge,
  verifyAuthenticatedControlChannel,
} from '../../../evals/runtime/remote-bridge.mjs';

const TASK_PATH = '/engineer-bounded/transport/task-input.tar';
const OUTPUT_PATH = '/engineer-bounded/transport/trial-output.tar';
const HMAC_SECRET = Buffer.alloc(32, 0xa7);
const PROVIDER_SECRET = Buffer.from('sk-or-v1-remote-bridge-secret');
const CONTROLLED_PROVIDER = 'controlled-provider';
const ZERO_PROVIDER_CANARY = 'zero-provider-canary';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function frame(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function secretPayload({
  magic = 'EHS1',
  hmac = HMAC_SECRET,
  provider = PROVIDER_SECRET,
  hmacLength = hmac.length,
  providerLength = provider.length,
  suffix = Buffer.alloc(0),
} = {}) {
  const header = Buffer.alloc(8);
  header.write(magic, 0, 'ascii');
  header.writeUInt16BE(hmacLength, 4);
  header.writeUInt16BE(providerLength, 6);
  return Buffer.concat([header, hmac, provider, suffix]);
}

function zeroProviderPayload({
  magic = 'EHZ1',
  hmac = HMAC_SECRET,
  hmacLength = hmac.length,
  providerLength = 0,
  suffix = Buffer.alloc(0),
} = {}) {
  const header = Buffer.alloc(8);
  header.write(magic, 0, 'ascii');
  header.writeUInt16BE(hmacLength, 4);
  header.writeUInt16BE(providerLength, 6);
  return Buffer.concat([header, hmac, suffix]);
}

function memoryOutput() {
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { output, bytes: () => Buffer.concat(chunks) };
}

function splitOutput(bytes, readyLine) {
  const prefix = Buffer.from(`${readyLine}\n`);
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
  const frames = [];
  let offset = prefix.length;
  while (offset < bytes.length) {
    assert.ok(offset + 4 <= bytes.length, 'complete frame header');
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    assert.ok(offset + length <= bytes.length, 'complete frame payload');
    frames.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return frames;
}

async function archiveRoot(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'engineer-remote-bridge-'));
  const resolved = await fs.realpath(temporary);
  const transportDirectory = path.join(resolved, 'transport');
  await fs.mkdir(transportDirectory, { mode: 0o700 });
  await fs.chmod(transportDirectory, 0o700);
  t.after(async () => fs.rm(resolved, { recursive: true, force: true }));
  return transportDirectory;
}

function archiveRequest(overrides = {}) {
  const bytes = overrides.bytes ?? Buffer.from('bounded task archive');
  const request = {
    schema: 'engineer-daytona-archive-request.v1',
    operation: 'upload',
    kind: 'task-input',
    path: TASK_PATH,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    ...overrides,
  };
  delete request.bytes;
  return { bytes, request };
}

test('archive upload writes the one fixed task path atomically with owner-only mode', async (t) => {
  const transportDirectory = await archiveRoot(t);
  const { bytes, request } = archiveRequest();
  const sink = memoryOutput();

  const receipt = await runArchiveBridge({
    input: Readable.from([frame(request), frame(bytes)]),
    output: sink.output,
    transportDirectory,
    maxArchiveBytes: 1_024,
  });

  assert.deepEqual(receipt, {
    schema: 'engineer-daytona-archive-result.v1',
    operation: 'upload',
    kind: 'task-input',
    path: TASK_PATH,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    status: 'accepted',
  });
  const responseFrames = splitOutput(sink.bytes(), ARCHIVE_READY_LINE);
  assert.equal(responseFrames.length, 1);
  assert.deepEqual(JSON.parse(responseFrames[0]), receipt);

  const target = path.join(transportDirectory, 'task-input.tar');
  assert.deepEqual(await fs.readFile(target), bytes);
  const stat = await fs.lstat(target);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(transportDirectory)).sort(), ['task-input.tar']);
});

test('archive download verifies a fixed regular file before emitting its bytes', async (t) => {
  const transportDirectory = await archiveRoot(t);
  const bytes = Buffer.alloc(70 * 1_024, 0x5a);
  await fs.writeFile(path.join(transportDirectory, 'trial-output.tar'), bytes, { mode: 0o600 });
  const request = {
    schema: 'engineer-daytona-archive-request.v1',
    operation: 'download',
    kind: 'trial-output',
    path: OUTPUT_PATH,
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
  const sink = memoryOutput();

  const receipt = await runArchiveBridge({
    input: Readable.from([frame(request)]),
    output: sink.output,
    transportDirectory,
    maxArchiveBytes: 128 * 1_024,
  });

  const responseFrames = splitOutput(sink.bytes(), ARCHIVE_READY_LINE);
  assert.equal(responseFrames.length, 2);
  assert.deepEqual(JSON.parse(responseFrames[0]), receipt);
  assert.deepEqual(responseFrames[1], bytes);
  assert.deepEqual(receipt, {
    schema: 'engineer-daytona-archive-result.v1',
    operation: 'download',
    kind: 'trial-output',
    path: OUTPUT_PATH,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    status: 'accepted',
  });
});

test('archive metadata is exact and rejects schema, operation, kind, path, and field drift', async (t) => {
  const transportDirectory = await archiveRoot(t);
  const { bytes, request } = archiveRequest();
  const cases = [
    { ...request, schema: 'engineer-daytona-archive-request.v2' },
    { ...request, operation: 'download' },
    { ...request, kind: 'trial-output' },
    { ...request, path: '/tmp/task-input.tar' },
    { ...request, unexpected: 'do-not-accept' },
    { ...request, byteLength: 0 },
    { ...request, sha256: request.sha256.toUpperCase() },
  ];

  for (const candidate of cases) {
    const sink = memoryOutput();
    await assert.rejects(
      runArchiveBridge({
        input: Readable.from([frame(candidate), frame(bytes)]),
        output: sink.output,
        transportDirectory,
        maxArchiveBytes: 1_024,
      }),
      (error) => error.code?.startsWith('ERR_REMOTE_') && !error.message.includes('do-not-accept')
    );
    assert.deepEqual(sink.bytes(), Buffer.from(`${ARCHIVE_READY_LINE}\n`));
  }
});

test('archive framing, size, digest, trailing data, and channel loss fail closed', async (t) => {
  const transportDirectory = await archiveRoot(t);
  const { bytes, request } = archiveRequest();
  const oversizedMetadata = Buffer.alloc(4);
  oversizedMetadata.writeUInt32BE(8_193);
  const oversizedArchive = Buffer.alloc(4);
  oversizedArchive.writeUInt32BE(1_025);
  const badDigest = { ...request, sha256: '0'.repeat(64) };
  const cases = [
    [oversizedMetadata],
    [frame(Buffer.from('{no'))],
    [frame(request), oversizedArchive],
    [frame(request), frame(bytes.subarray(0, -1))],
    [frame(badDigest), frame(bytes)],
    [Buffer.concat([frame(request), frame(bytes), Buffer.from('trailing')])],
    [frame(request).subarray(0, -2)],
  ];

  for (const chunks of cases) {
    const sink = memoryOutput();
    await assert.rejects(runArchiveBridge({
      input: Readable.from(chunks),
      output: sink.output,
      transportDirectory,
      maxArchiveBytes: 1_024,
    }), /frame|archive|channel|metadata|digest|trailing/i);
    assert.equal(await fs.stat(path.join(transportDirectory, 'task-input.tar')).then(() => true, () => false), false);
  }
});

test('archive bridge rejects target and directory symlinks without touching their victims', async (t) => {
  const transportDirectory = await archiveRoot(t);
  const victim = path.join(path.dirname(transportDirectory), 'victim');
  await fs.writeFile(victim, 'untouched', { mode: 0o600 });
  const target = path.join(transportDirectory, 'task-input.tar');
  await fs.symlink(victim, target);
  const { bytes, request } = archiveRequest();
  await assert.rejects(runArchiveBridge({
    input: Readable.from([frame(request), frame(bytes)]),
    output: memoryOutput().output,
    transportDirectory,
    maxArchiveBytes: 1_024,
  }), /symlink|regular|archive path/i);
  assert.equal(await fs.readFile(victim, 'utf8'), 'untouched');
  assert.equal((await fs.lstat(target)).isSymbolicLink(), true);

  const outputTarget = path.join(transportDirectory, 'trial-output.tar');
  await fs.symlink(victim, outputTarget);
  const outputBytes = Buffer.from('untouched');
  const downloadRequest = {
    schema: 'engineer-daytona-archive-request.v1',
    operation: 'download',
    kind: 'trial-output',
    path: OUTPUT_PATH,
    byteLength: outputBytes.length,
    sha256: sha256(outputBytes),
  };
  await assert.rejects(runArchiveBridge({
    input: Readable.from([frame(downloadRequest)]),
    output: memoryOutput().output,
    transportDirectory,
    maxArchiveBytes: 1_024,
  }), /symlink|regular|archive target/i);
  assert.equal(await fs.readFile(victim, 'utf8'), 'untouched');

  const directoryLink = path.join(path.dirname(transportDirectory), 'transport-link');
  await fs.symlink(transportDirectory, directoryLink);
  await assert.rejects(runArchiveBridge({
    input: Readable.from([frame(request), frame(bytes)]),
    output: memoryOutput().output,
    transportDirectory: directoryLink,
    maxArchiveBytes: 1_024,
  }), /symlink|archive path/i);
});

test('supervisor accepts one EHS1 secret frame, scrubs bridge copies, and relays bounded frames', async () => {
  const payload = secretPayload();
  const request = Buffer.from('{"schema":"engineer-runtime-trial-request.v1"}');
  const response = Buffer.from('{"schema":"engineer-runtime-readiness-lease.v1"}');
  const sink = memoryOutput();
  let capturedSecrets;
  let capturedChannel;
  let verifiedExecutionMode;
  let capturedRequest;
  let closedReason;

  await runSupervisorControlBridge({
    input: Readable.from([frame(payload), frame(request)]),
    output: sink.output,
    controlChannelInspector: () => ({
      kind: 'inherited-pipe',
      kernelBound: true,
      inputDescriptor: { fd: 0, kind: 'pipe', device: '1', inode: '2', mode: 0o600, ownerUid: 0, ownerGid: 0 },
      outputDescriptor: { fd: 1, kind: 'pipe', device: '1', inode: '3', mode: 0o600, ownerUid: 0, ownerGid: 0 },
    }),
    handlerFactory: async ({ hmacKey, executionMode, providerKey, controlChannel }) => {
      assert.deepEqual(hmacKey, HMAC_SECRET);
      assert.equal(executionMode, CONTROLLED_PROVIDER);
      assert.deepEqual(providerKey, PROVIDER_SECRET);
      assert.equal(controlChannel.kind, 'inherited-pipe');
      assert.equal(controlChannel.kernelBound, true);
      assert.equal(controlChannel.open, true);
      assert.equal(controlChannel.receiptHash.length, 64);
      verifiedExecutionMode = verifyAuthenticatedControlChannel(
        controlChannel,
        HMAC_SECRET
      ).executionMode;
      assert.throws(
        () => verifyAuthenticatedControlChannel(
          { ...controlChannel, executionMode: ZERO_PROVIDER_CANARY },
          HMAC_SECRET
        ),
        /authentication|identity/i
      );
      capturedChannel = controlChannel;
      capturedSecrets = { hmacKey, providerKey };
      return {
        async handleFrame(frameBytes) {
          capturedRequest = frameBytes;
          return { response, done: true };
        },
        async close({ reason }) {
          closedReason = reason;
        },
      };
    },
  });

  assert.deepEqual(capturedSecrets.hmacKey, Buffer.alloc(32));
  assert.deepEqual(capturedSecrets.providerKey, Buffer.alloc(PROVIDER_SECRET.length));
  assert.equal(capturedChannel.authenticationTag.length, 64);
  assert.equal(capturedChannel.executionMode, CONTROLLED_PROVIDER);
  assert.equal(verifiedExecutionMode, CONTROLLED_PROVIDER);
  assert.deepEqual(capturedRequest, Buffer.alloc(request.length), 'request buffer is scrubbed after the handler returns');
  assert.equal(closedReason, 'complete');
  const responseFrames = splitOutput(sink.bytes(), SUPERVISOR_READY_LINE);
  assert.equal(responseFrames.length, 2);
  assert.deepEqual(JSON.parse(responseFrames[0]), {
    schema: 'engineer-supervisor-secret-accepted.v1',
    status: 'accepted',
    executionMode: CONTROLLED_PROVIDER,
    frameSha256: sha256(payload),
    byteLength: payload.length,
  });
  assert.deepEqual(responseFrames[1], response);
  assert.equal(sink.bytes().includes(PROVIDER_SECRET), false);
  assert.equal(sink.bytes().includes(HMAC_SECRET), false);
});

test('supervisor accepts the HMAC-only zero-provider variant without constructing provider bytes', async () => {
  const payload = zeroProviderPayload();
  const request = Buffer.from('{"schema":"zero-provider-canary"}');
  const response = Buffer.from('{"status":"complete"}');
  const sink = memoryOutput();
  let capturedInput;
  let capturedHmac;
  let capturedChannel;
  let verifiedExecutionMode;

  await runSupervisorControlBridge({
    input: Readable.from([frame(payload), frame(request)]),
    output: sink.output,
    controlChannelInspector: () => ({
      kind: 'inherited-pipe',
      kernelBound: true,
      inputDescriptor: { fd: 0, kind: 'pipe', device: '1', inode: '2', mode: 0o600, ownerUid: 0, ownerGid: 0 },
      outputDescriptor: { fd: 1, kind: 'pipe', device: '1', inode: '3', mode: 0o600, ownerUid: 0, ownerGid: 0 },
    }),
    handlerFactory: async (input) => {
      capturedInput = input;
      capturedHmac = input.hmacKey;
      capturedChannel = input.controlChannel;
      assert.deepEqual(Object.keys(input).sort(), [
        'controlChannel',
        'executionMode',
        'hmacKey',
      ]);
      assert.equal(input.executionMode, ZERO_PROVIDER_CANARY);
      assert.equal(Object.prototype.hasOwnProperty.call(input, 'providerKey'), false);
      assert.deepEqual(input.hmacKey, HMAC_SECRET);
      assert.equal(input.controlChannel.executionMode, ZERO_PROVIDER_CANARY);
      verifiedExecutionMode = verifyAuthenticatedControlChannel(
        input.controlChannel,
        HMAC_SECRET
      ).executionMode;
      return { handleFrame: async () => ({ response, done: true }) };
    },
  });

  assert.equal(capturedInput.executionMode, ZERO_PROVIDER_CANARY);
  assert.deepEqual(capturedHmac, Buffer.alloc(HMAC_SECRET.length));
  assert.equal(capturedChannel.executionMode, ZERO_PROVIDER_CANARY);
  assert.equal(verifiedExecutionMode, ZERO_PROVIDER_CANARY);
  const responseFrames = splitOutput(sink.bytes(), SUPERVISOR_READY_LINE);
  assert.deepEqual(JSON.parse(responseFrames[0]), {
    schema: 'engineer-supervisor-secret-accepted.v1',
    status: 'accepted',
    executionMode: ZERO_PROVIDER_CANARY,
    frameSha256: sha256(payload),
    byteLength: payload.length,
  });
  assert.deepEqual(responseFrames[1], response);
  assert.equal(sink.bytes().includes(HMAC_SECRET), false);
  assert.equal(sink.bytes().includes(PROVIDER_SECRET), false);
});

test('supervisor rejects malformed and oversized secret frames before invoking the factory', async () => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(1_025);
  const malformed = [
    oversized,
    frame(Buffer.from('short')),
    frame(secretPayload({ magic: 'BAD!' })),
    frame(secretPayload({ hmacLength: 31 })),
    frame(secretPayload({ provider: Buffer.alloc(7), providerLength: 7 })),
    frame(secretPayload({ providerLength: PROVIDER_SECRET.length + 1 })),
    frame(secretPayload({ suffix: Buffer.from('extra') })),
    frame(zeroProviderPayload({ providerLength: 1 })),
    frame(zeroProviderPayload({ suffix: Buffer.from('provider-byte') })),
  ];
  let factoryCalls = 0;
  for (const candidate of malformed) {
    const sink = memoryOutput();
    await assert.rejects(runSupervisorControlBridge({
      input: Readable.from([candidate]),
      output: sink.output,
      handlerFactory: async () => {
        factoryCalls += 1;
        throw new Error('must not run');
      },
    }), /secret|frame|channel/i);
    assert.deepEqual(sink.bytes(), Buffer.from(`${SUPERVISOR_READY_LINE}\n`));
  }
  assert.equal(factoryCalls, 0);
});

test('supervisor blocks secret echoes and exact handler-result drift without leaking values', async () => {
  const cases = [
    { response: PROVIDER_SECRET, done: true },
    { response: Buffer.concat([Buffer.from('prefix'), HMAC_SECRET]), done: true },
    { response: Buffer.from('ok'), done: true, extra: 'drift' },
  ];
  for (const result of cases) {
    const sink = memoryOutput();
    let error;
    try {
      await runSupervisorControlBridge({
        input: Readable.from([frame(secretPayload()), frame(Buffer.from('request'))]),
        output: sink.output,
        handlerFactory: async () => ({ handleFrame: async () => result }),
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.match(error.message, /handler|secret|response/i);
    assert.equal(error.message.includes(PROVIDER_SECRET.toString()), false);
    assert.equal(sink.bytes().includes(PROVIDER_SECRET), false);
    assert.equal(sink.bytes().includes(HMAC_SECRET), false);
  }
});

test('supervisor blocks a secret split across handler response frames before the final bytes leave', async () => {
  const splitAt = Math.floor(PROVIDER_SECRET.length / 2);
  const responses = [
    PROVIDER_SECRET.subarray(0, splitAt),
    PROVIDER_SECRET.subarray(splitAt),
  ];
  const sink = memoryOutput();
  let calls = 0;
  await assert.rejects(runSupervisorControlBridge({
    input: Readable.from([
      frame(secretPayload()),
      frame(Buffer.from('request-1')),
      frame(Buffer.from('request-2')),
    ]),
    output: sink.output,
    handlerFactory: async () => ({
      async handleFrame() {
        const response = responses[calls];
        calls += 1;
        return { response, done: calls === responses.length };
      },
    }),
  }), /secret/i);
  assert.equal(calls, 2);
  assert.equal(sink.bytes().includes(PROVIDER_SECRET), false);
});

test('supervisor protocol frames are bounded and channel loss invokes fail-stop hooks', async () => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(65_537);
  for (const tail of [oversized, Buffer.alloc(0)]) {
    let channelLost = 0;
    let closeReason;
    const sink = memoryOutput();
    await assert.rejects(runSupervisorControlBridge({
      input: Readable.from(tail.length ? [frame(secretPayload()), tail] : [frame(secretPayload())]),
      output: sink.output,
      handlerFactory: async () => ({
        handleFrame: async () => ({ response: Buffer.from('unused'), done: false }),
        async channelLost() {
          channelLost += 1;
        },
        async close({ reason }) {
          closeReason = reason;
        },
      }),
    }), /frame|channel/i);
    assert.equal(channelLost, 1);
    assert.equal(closeReason, 'channel-loss');
    assert.equal(splitOutput(sink.bytes(), SUPERVISOR_READY_LINE).length, 1, 'only the secret receipt was emitted');
  }
});

test('supervisor sanitizes factory and handler failures that contain secret material', async () => {
  for (const failureAt of ['factory', 'handler']) {
    const sink = memoryOutput();
    let error;
    try {
      await runSupervisorControlBridge({
        input: Readable.from([frame(secretPayload()), frame(Buffer.from('request'))]),
        output: sink.output,
        handlerFactory: async () => {
          if (failureAt === 'factory') throw new Error(`factory ${PROVIDER_SECRET}`);
          return { handleFrame: async () => { throw new Error(`handler ${PROVIDER_SECRET}`); } };
        },
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(error.message.includes(PROVIDER_SECRET.toString()), false);
    assert.match(error.code, /^ERR_REMOTE_/);
    assert.equal(sink.bytes().includes(PROVIDER_SECRET), false);
  }
});

test('fixed CLI routes accept only the snapshot wrapper identities and exact flags', async (t) => {
  const transportDirectory = await archiveRoot(t);
  const { bytes, request } = archiveRequest();
  const sink = memoryOutput();
  await runRemoteBridgeCli({
    executableName: 'engineer-archive-bridge',
    argv: ['--stdio'],
    input: Readable.from([frame(request), frame(bytes)]),
    output: sink.output,
    transportDirectory,
    maxArchiveBytes: 1_024,
  });
  assert.equal(splitOutput(sink.bytes(), ARCHIVE_READY_LINE).length, 1);

  for (const invocation of [
    { executableName: 'engineer-archive-bridge', argv: ['--control-stdio'] },
    { executableName: 'engineer-runtime-supervisor', argv: ['--stdio'] },
    { executableName: 'remote-bridge.mjs', argv: ['--stdio'] },
    { executableName: 'engineer-archive-bridge', argv: ['--stdio', '--root=/tmp'] },
  ]) {
    await assert.rejects(runRemoteBridgeCli({ ...invocation }), /route|invocation/i);
  }
});
