import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';

import { TASK_INPUT_ARCHIVE_LIMITS } from '../runtime/archive-limits.mjs';
import {
  ARCHIVE_BOOTSTRAP,
  SUPERVISOR_BOOTSTRAP,
  createDaytonaTransport,
} from '../runtime/daytona-transport.mjs';
import {
  RuntimeControlFailureCodes,
  RuntimeControlFailurePhases,
  canonicalJson,
  signRuntimeControlFailure,
  verifyRuntimeControlFailure,
} from '../runtime/protocol.mjs';

const DAYTONA = '/opt/homebrew/bin/daytona';
const SANDBOX = 'engineer-eval-abcd1234-1-00112233';
const PROVIDER_SECRET = Buffer.from('sk-or-v1-provider-secret-value');
const HMAC_SECRET = Buffer.alloc(32, 0xa5);
const CONTROLLED_PROVIDER = 'controlled-provider';
const ZERO_PROVIDER_CANARY = 'zero-provider-canary';
const NON_TTY_NOTICE = 'Pseudo-terminal will not be allocated because stdin is not a terminal.\r\n';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function frame(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function secretPayload(hmacKey = HMAC_SECRET, providerKey = PROVIDER_SECRET) {
  const header = Buffer.alloc(8);
  header.write('EHS1', 0, 'ascii');
  header.writeUInt16BE(hmacKey.length, 4);
  header.writeUInt16BE(providerKey.length, 6);
  return Buffer.concat([header, hmacKey, providerKey]);
}

function zeroProviderPayload(hmacKey = HMAC_SECRET) {
  const header = Buffer.alloc(8);
  header.write('EHZ1', 0, 'ascii');
  header.writeUInt16BE(hmacKey.length, 4);
  header.writeUInt16BE(0, 6);
  return Buffer.concat([header, hmacKey]);
}

function fakeChild({
  stdout = [],
  stderr = [],
  events = null,
  closeBeforeOutput = false,
  outputAfterFirstWrite = false,
  onWrite = null,
} = {}) {
  const child = new EventEmitter();
  const writes = [];
  let killCalls = 0;
  let outputStarted = false;
  const emitOutput = () => {
    if (outputStarted) return;
    outputStarted = true;
    if (closeBeforeOutput) {
      child.emit('close', 255, null);
      return;
    }
    if (events) {
      for (const event of events) child[event.stream].write(event.bytes);
      return;
    }
    for (const chunk of stdout) child.stdout.write(chunk);
    for (const chunk of stderr) child.stderr.write(chunk);
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      onWrite?.({ child, writes, chunk: Buffer.from(chunk) });
      if (outputAfterFirstWrite) queueMicrotask(emitOutput);
      callback();
    },
  });
  child.kill = () => {
    killCalls += 1;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  if (!outputAfterFirstWrite) queueMicrotask(emitOutput);
  return { child, writes, get killCalls() { return killCalls; } };
}

function transport(overrides = {}) {
  const commandCalls = [];
  const channelCalls = [];
  const children = [];
  const runCommand = async (file, args, options) => {
    commandCalls.push({ file, args: args.slice(), options: { ...options, env: { ...options.env } } });
    return { code: 0, stdout: Buffer.from('healthy'), stderr: Buffer.alloc(0) };
  };
  const spawnChannel = (file, args, options) => {
    channelCalls.push({ file, args: args.slice(), options: { ...options, env: { ...options.env } } });
    const scripted = overrides.nextChild?.() ?? fakeChild({ closeBeforeOutput: true });
    children.push(scripted);
    return scripted.child;
  };
  return {
    commandCalls,
    channelCalls,
    children,
    value: createDaytonaTransport({
      daytonaPath: DAYTONA,
      runCommand: overrides.runCommand ?? runCommand,
      spawnChannel: overrides.spawnChannel ?? spawnChannel,
      baseEnv: {
        PATH: '/usr/bin:/bin',
        DAYTONA_API_URL: 'https://app.daytona.io/api',
        OPENROUTER_API_KEY: PROVIDER_SECRET.toString(),
        ANTHROPIC_API_KEY: 'anthropic-must-not-propagate',
        CLOUDFLARE_API_TOKEN: 'cloudflare-must-not-propagate',
        AWS_SECRET_ACCESS_KEY: 'aws-must-not-propagate',
        SOME_TOKEN: 'ambient-must-not-propagate',
        NODE_OPTIONS: '--require=/tmp/attacker.cjs',
      },
      commandTimeoutMs: 2_000,
      channelTimeoutMs: overrides.channelTimeoutMs ?? 2_000,
      controlChannelTimeoutMs: overrides.controlChannelTimeoutMs ?? 2_000,
      maxCommandOutputBytes: 4_096,
      maxArchiveBytes: 1_024,
    }),
  };
}

test('interactive bridges disable soft and hard core dumps before fixed execution', () => {
  assert.equal(
    ARCHIVE_BOOTSTRAP,
    'if [ -t 0 ]; then stty -echo || exit 70; fi; ulimit -c 0 || exit 70; exec /opt/engineer/bin/engineer-archive-bridge --stdio',
  );
  assert.equal(
    SUPERVISOR_BOOTSTRAP,
    'if [ -t 0 ]; then stty -echo || exit 70; fi; ulimit -c 0 || exit 70; exec /opt/engineer/bin/engineer-runtime-supervisor --control-stdio',
  );
});

test('remote commands use exact direct argv, scrub provider env, and return hashes rather than output', async () => {
  const harness = transport();
  const result = await harness.value.runRemote({
    sandboxId: SANDBOX,
    executable: '/usr/bin/id',
    args: ['--user', 'runner_2001'],
    cwd: '/engineer-bounded/work',
  });

  assert.deepEqual(harness.commandCalls[0].args, [
    'exec', SANDBOX, '--timeout', '2', '--cwd', '/engineer-bounded/work', '--',
    '/usr/bin/id', '--user', 'runner_2001',
  ]);
  assert.equal(harness.commandCalls[0].file, DAYTONA);
  assert.equal(harness.commandCalls[0].options.shell, false);
  assert.equal(harness.commandCalls[0].options.env.OPENROUTER_API_KEY, undefined);
  assert.equal(harness.commandCalls[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(harness.commandCalls[0].options.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(harness.commandCalls[0].options.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(harness.commandCalls[0].options.env.SOME_TOKEN, undefined);
  assert.equal(harness.commandCalls[0].options.env.NODE_OPTIONS, undefined);
  assert.equal(harness.commandCalls[0].options.env.DAYTONA_API_URL, 'https://app.daytona.io/api');
  assert.deepEqual(result, {
    schema: 'engineer-daytona-command-receipt.v1',
    exitCode: 0,
    stdoutBytes: 7,
    stdoutSha256: sha256('healthy'),
    stderrBytes: 0,
    stderrSha256: sha256(''),
  });
  assert.equal(JSON.stringify(result).includes('healthy'), false);

  for (const attempt of [
    { sandboxId: `${SANDBOX};reboot`, executable: '/usr/bin/id', args: [] },
    { sandboxId: SANDBOX, executable: '/usr/bin/id;reboot', args: [] },
    { sandboxId: SANDBOX, executable: '/usr/bin/id', args: ['ok;touch /tmp/pwn'] },
    { sandboxId: SANDBOX, executable: '/usr/bin/id', args: ['$(touch /tmp/pwn)'] },
    { sandboxId: SANDBOX, executable: '/usr/bin/id', args: ['model name with spaces'] },
    { sandboxId: SANDBOX, executable: '/usr/bin/id', args: [PROVIDER_SECRET.toString()] },
  ]) {
    await assert.rejects(harness.value.runRemote(attempt), /identifier|executable|argument|safe token|secret/i);
  }
  assert.equal(harness.commandCalls.length, 1, 'injection attempts never reach Daytona');
});

test('the default process environment shape is accepted without relaxing provider scrubbing', () => {
  assert.doesNotThrow(() => createDaytonaTransport({
    daytonaPath: DAYTONA,
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawnChannel: () => fakeChild({ closeBeforeOutput: true }).child,
    baseEnv: process.env,
  }));
});

test('transport admits the measured task-input ceiling but nothing above it', () => {
  const options = {
    daytonaPath: DAYTONA,
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawnChannel: () => fakeChild({ closeBeforeOutput: true }).child,
    baseEnv: { PATH: '/usr/bin:/bin' },
  };
  assert.doesNotThrow(() => createDaytonaTransport({
    ...options,
    maxArchiveBytes: TASK_INPUT_ARCHIVE_LIMITS.compressedBytes,
  }));
  assert.throws(() => createDaytonaTransport({
    ...options,
    maxArchiveBytes: TASK_INPUT_ARCHIVE_LIMITS.compressedBytes + 1,
  }), /maxArchiveBytes.*(?:between|bound)/i);
});

test('stripped provider environment values are not copied or retained by the transport', async () => {
  const strippedValue = 'sk-or-v1-stripped-value-that-must-not-be-retained';
  const baseEnv = {
    PATH: '/usr/bin:/bin',
    DAYTONA_API_URL: 'https://app.daytona.io/api',
    OPENROUTER_API_KEY: strippedValue,
  };
  const calls = [];
  const value = createDaytonaTransport({
    daytonaPath: DAYTONA,
    baseEnv,
    runCommand: async (_file, _args, options) => {
      calls.push(options);
      return { code: 0, stdout: Buffer.from(strippedValue), stderr: Buffer.alloc(0) };
    },
    spawnChannel: () => fakeChild({ closeBeforeOutput: true }).child,
  });
  baseEnv.OPENROUTER_API_KEY = 'changed-after-construction';

  const receipt = await value.runRemote({
    sandboxId: SANDBOX,
    executable: '/usr/bin/true',
    args: [],
  });
  assert.equal(calls[0].env.OPENROUTER_API_KEY, undefined);
  assert.equal(JSON.stringify(receipt).includes(strippedValue), false);
  await value.dispose();
});

test('bounded upload and download use a fixed SSH bridge, fixed paths, and verified digests', async () => {
  const archive = Buffer.from('bounded source archive containing the literal scanner prefix sk-or-');
  const digest = sha256(archive);
  const uploadAck = {
    schema: 'engineer-daytona-archive-result.v1',
    operation: 'upload',
    kind: 'task-input',
    path: '/engineer-bounded/transport/task-input.tar',
    byteLength: archive.length,
    sha256: digest,
    status: 'accepted',
  };
  const downloadHeader = {
    schema: 'engineer-daytona-archive-result.v1',
    operation: 'download',
    kind: 'trial-output',
    path: '/engineer-bounded/transport/trial-output.tar',
    byteLength: archive.length,
    sha256: digest,
    status: 'accepted',
  };
  const scripts = [
    fakeChild({
      stdout: [Buffer.from(`${ARCHIVE_BOOTSTRAP}\r\nENGINEER-ARCHIVE/1 READY\n`), frame(uploadAck)],
      stderr: [Buffer.from(NON_TTY_NOTICE.slice(0, 31)), Buffer.from(NON_TTY_NOTICE.slice(31))],
    }),
    fakeChild({ stdout: [Buffer.from('ENGINEER-ARCHIVE/1 READY\n'), frame(downloadHeader), frame(archive)] }),
  ];
  const harness = transport({ nextChild: () => scripts.shift() });

  const uploaded = await harness.value.uploadArchive({
    sandboxId: SANDBOX,
    kind: 'task-input',
    bytes: archive,
    sha256: digest,
  });
  assert.deepEqual(uploaded, uploadAck);

  const downloaded = await harness.value.downloadArchive({
    sandboxId: SANDBOX,
    kind: 'trial-output',
    expectedSha256: digest,
    expectedBytes: archive.length,
  });
  assert.deepEqual(downloaded.bytes, archive);
  assert.deepEqual(downloaded.receipt, downloadHeader);

  assert.equal(harness.channelCalls.length, 2);
  for (const call of harness.channelCalls) {
    assert.equal(call.file, DAYTONA);
    assert.deepEqual(call.args, ['ssh', SANDBOX, '--expires', '5']);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.OPENROUTER_API_KEY, undefined);
    assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.args.join(' ').includes(archive.toString()), false);
  }

  const uploadWrites = harness.children[0].writes;
  assert.equal(uploadWrites[0].toString(), `${ARCHIVE_BOOTSTRAP}\n`);
  const outbound = Buffer.concat(uploadWrites.slice(1));
  const metadataLength = outbound.readUInt32BE(0);
  const metadata = JSON.parse(outbound.subarray(4, 4 + metadataLength).toString());
  assert.deepEqual(metadata, {
    schema: 'engineer-daytona-archive-request.v1',
    operation: 'upload',
    kind: 'task-input',
    path: '/engineer-bounded/transport/task-input.tar',
    byteLength: archive.length,
    sha256: digest,
  });
  const archiveOffset = 4 + metadataLength;
  assert.equal(outbound.readUInt32BE(archiveOffset), archive.length);
  assert.deepEqual(outbound.subarray(archiveOffset + 4), archive);
});

test('final validation accepts a bounded allowed stderr notice split across event-loop turns', async () => {
  const archive = Buffer.from('payload');
  const digest = sha256(archive);
  const accepted = {
    schema: 'engineer-daytona-archive-result.v1',
    operation: 'upload',
    kind: 'task-input',
    path: '/engineer-bounded/transport/task-input.tar',
    byteLength: archive.length,
    sha256: digest,
    status: 'accepted',
  };
  const splitAt = 31;
  const scripted = fakeChild({
    stdout: [Buffer.from('ENGINEER-ARCHIVE/1 READY\n'), frame(accepted)],
    outputAfterFirstWrite: true,
    onWrite: ({ child, writes }) => {
      if (writes.length !== 5) return;
      child.stderr.write(Buffer.from(NON_TTY_NOTICE.slice(0, splitAt)));
      setTimeout(() => child.stderr.write(Buffer.from(NON_TTY_NOTICE.slice(splitAt))), 5);
    },
  });
  const harness = transport({ nextChild: () => scripted });

  await assert.doesNotReject(harness.value.uploadArchive({
    sandboxId: SANDBOX,
    kind: 'task-input',
    bytes: archive,
    sha256: digest,
  }));
});

test('archive digest, size, malformed response, and oversized frame failures are fail-closed', async () => {
  const archive = Buffer.from('payload');
  const noEffect = transport();
  await assert.rejects(noEffect.value.uploadArchive({
    sandboxId: SANDBOX,
    kind: 'task-input',
    bytes: archive,
    sha256: '0'.repeat(64),
  }), /digest/i);
  await assert.rejects(noEffect.value.uploadArchive({
    sandboxId: SANDBOX,
    kind: 'task-input',
    bytes: Buffer.alloc(1_025),
    sha256: sha256(Buffer.alloc(1_025)),
  }), /archive.*bound|oversized/i);
  assert.equal(noEffect.channelCalls.length, 0);

  const malformed = transport({
    nextChild: () => fakeChild({ stdout: [Buffer.from('ENGINEER-ARCHIVE/1 READY\n'), frame(Buffer.from('{no'))] }),
  });
  await assert.rejects(malformed.value.uploadArchive({
    sandboxId: SANDBOX,
    kind: 'task-input',
    bytes: archive,
    sha256: sha256(archive),
  }), /archive.*response|malformed/i);

  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(8_193);
  const oversized = transport({
    nextChild: () => fakeChild({ stdout: [Buffer.from('ENGINEER-ARCHIVE/1 READY\n'), oversizedHeader] }),
  });
  await assert.rejects(oversized.value.uploadArchive({
    sandboxId: SANDBOX,
    kind: 'task-input',
    bytes: archive,
    sha256: sha256(archive),
  }), /frame.*bound|oversized/i);
});

test('supervisor control waits for echo-disabled readiness and sends each secret exactly once in one frame', async () => {
  const payload = secretPayload();
  const payloadDigest = sha256(payload);
  const accepted = {
    schema: 'engineer-supervisor-secret-accepted.v1',
    status: 'accepted',
    executionMode: CONTROLLED_PROVIDER,
    frameSha256: payloadDigest,
    byteLength: payload.length,
  };
  const scripted = fakeChild({
    stdout: [Buffer.from(`${SUPERVISOR_BOOTSTRAP}\r\nENGINEER-SUPERVISOR/1 READY\n`), frame(accepted)],
    stderr: [Buffer.from(NON_TTY_NOTICE)],
  });
  const harness = transport({ nextChild: () => scripted });

  const opened = await harness.value.openSupervisorControl({
    sandboxId: SANDBOX,
    hmacKey: HMAC_SECRET,
    executionMode: CONTROLLED_PROVIDER,
    providerKey: PROVIDER_SECRET,
  });
  assert.deepEqual(opened.receipt, accepted);
  assert.equal(JSON.stringify(opened.receipt).includes(PROVIDER_SECRET.toString()), false);
  assert.deepEqual(HMAC_SECRET, Buffer.alloc(32, 0xa5), 'caller-owned key is not mutated');
  assert.equal(PROVIDER_SECRET.toString(), 'sk-or-v1-provider-secret-value');

  assert.equal(harness.channelCalls.length, 1);
  assert.deepEqual(harness.channelCalls[0].args, ['ssh', SANDBOX, '--expires', '5']);
  assert.equal(JSON.stringify(harness.channelCalls[0]).includes(PROVIDER_SECRET.toString()), false);
  assert.equal(scripted.writes[0].toString(), `${SUPERVISOR_BOOTSTRAP}\n`);
  const writtenFrame = Buffer.concat(scripted.writes.slice(1));
  assert.equal(writtenFrame.readUInt32BE(0), payload.length);
  assert.deepEqual(writtenFrame.subarray(4), payload);
  assert.equal(Buffer.concat(scripted.writes).toString().split(PROVIDER_SECRET.toString()).length - 1, 1);

  await assert.rejects(opened.control.sendFrame(PROVIDER_SECRET), /secret/i);

  await opened.control.close();
});

test('supervisor control uses a trial-length idle bound after the short bootstrap bound', async () => {
  const payload = secretPayload();
  const accepted = {
    schema: 'engineer-supervisor-secret-accepted.v1',
    status: 'accepted',
    executionMode: CONTROLLED_PROVIDER,
    frameSha256: sha256(payload),
    byteLength: payload.length,
  };
  const scripted = fakeChild({
    stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame(accepted)],
  });
  const harness = transport({
    nextChild: () => scripted,
    channelTimeoutMs: 25,
    controlChannelTimeoutMs: 100,
  });
  const opened = await harness.value.openSupervisorControl({
    sandboxId: SANDBOX,
    hmacKey: HMAC_SECRET,
    executionMode: CONTROLLED_PROVIDER,
    providerKey: PROVIDER_SECRET,
  });
  setTimeout(() => scripted.child.stdout.write(frame(Buffer.from('delayed-control-response'))), 50);

  assert.equal((await opened.control.receiveFrame()).toString(), 'delayed-control-response');
  await opened.control.close();
});

test('a complete authenticated control failure frame drains before concurrent stderr and EOF', async () => {
  const payload = secretPayload();
  const accepted = {
    schema: 'engineer-supervisor-secret-accepted.v1',
    status: 'accepted',
    executionMode: CONTROLLED_PROVIDER,
    frameSha256: sha256(payload),
    byteLength: payload.length,
  };
  const expected = {
    operation: 'readiness',
    sessionId: 'session-1',
    trialId: 'trial-1',
    allocationId: SANDBOX,
    controlSequence: 2,
    requestHash: '1'.repeat(64),
  };
  const failure = Buffer.from(canonicalJson(signRuntimeControlFailure({
    schema: 'engineer-runtime-control-failure.v1',
    protocolVersion: 1,
    ...expected,
    phase: RuntimeControlFailurePhases.START_PRIVATE_DAEMON,
    code: RuntimeControlFailureCodes.START_PRIVATE_DAEMON,
    detailSha256: '2'.repeat(64),
  }, HMAC_SECRET)));
  const scripted = fakeChild({
    stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame(accepted)],
    onWrite({ child, writes }) {
      if (writes.length !== 5) return;
      queueMicrotask(() => {
        const framedFailure = frame(failure);
        child.stdout.write(framedFailure.subarray(0, 11));
        child.stderr.write(Buffer.from('engineer remote supervisor failed: ERR_REMOTE_SUPERVISOR_CONTROL\n'));
        setImmediate(() => {
          child.stdout.write(framedFailure.subarray(11, 37));
          setImmediate(() => {
            child.stdout.write(framedFailure.subarray(37));
            child.emit('close', 70, null);
          });
        });
      });
    },
  });
  const harness = transport({ nextChild: () => scripted });
  const opened = await harness.value.openSupervisorControl({
    sandboxId: SANDBOX,
    hmacKey: HMAC_SECRET,
    executionMode: CONTROLLED_PROVIDER,
    providerKey: PROVIDER_SECRET,
  });

  await opened.control.sendFrame(Buffer.from('bounded-control-request'));
  const received = await opened.control.receiveFrame();
  assert.deepEqual(verifyRuntimeControlFailure(received, HMAC_SECRET, expected).phase,
    RuntimeControlFailurePhases.START_PRIVATE_DAEMON);
  await opened.control.close();
});

test('a complete non-failure control frame is rejected when stderr and exit 70 follow next turn', async () => {
  const payload = secretPayload();
  const accepted = {
    schema: 'engineer-supervisor-secret-accepted.v1',
    status: 'accepted',
    executionMode: CONTROLLED_PROVIDER,
    frameSha256: sha256(payload),
    byteLength: payload.length,
  };
  const scripted = fakeChild({
    stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame(accepted)],
    onWrite({ child, writes }) {
      if (writes.length !== 5) return;
      queueMicrotask(() => {
        child.stdout.write(frame({
          schema: 'engineer-runtime-control-response.v1',
          operation: 'readiness',
        }));
        setImmediate(() => {
          child.stderr.write(Buffer.from('engineer remote supervisor failed: ERR_REMOTE_SUPERVISOR_CONTROL\n'));
          child.emit('close', 70, null);
        });
      });
    },
  });
  const harness = transport({ nextChild: () => scripted });
  const opened = await harness.value.openSupervisorControl({
    sandboxId: SANDBOX,
    hmacKey: HMAC_SECRET,
    executionMode: CONTROLLED_PROVIDER,
    providerKey: PROVIDER_SECRET,
  });

  await opened.control.sendFrame(Buffer.from('bounded-control-request'));
  await assert.rejects(
    opened.control.receiveFrame(),
    (error) => error?.code === 'ERR_TRANSPORT_STDERR',
  );
  await opened.control.close();
});

test('a final control response waits for a clean exit status before acceptance', async () => {
  const payload = secretPayload();
  const accepted = {
    schema: 'engineer-supervisor-secret-accepted.v1',
    status: 'accepted',
    executionMode: CONTROLLED_PROVIDER,
    frameSha256: sha256(payload),
    byteLength: payload.length,
  };
  const response = {
    schema: 'engineer-runtime-control-response.v1',
    operation: 'final',
  };
  const scripted = fakeChild({
    stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame(accepted)],
    onWrite({ child, writes }) {
      if (writes.length !== 5) return;
      queueMicrotask(() => {
        child.stdout.write(frame(response));
        setImmediate(() => child.emit('close', 0, null));
      });
    },
  });
  const harness = transport({ nextChild: () => scripted });
  const opened = await harness.value.openSupervisorControl({
    sandboxId: SANDBOX,
    hmacKey: HMAC_SECRET,
    executionMode: CONTROLLED_PROVIDER,
    providerKey: PROVIDER_SECRET,
  });

  await opened.control.sendFrame(Buffer.from('bounded-control-request'));
  assert.deepEqual(JSON.parse((await opened.control.receiveFrame()).toString()), response);
  await opened.control.close();
});

test('a final control response rejects nonzero, signaled, and statusless terminal closes', async (t) => {
  for (const terminal of [
    { label: 'nonzero exit', code: 70, signal: null },
    { label: 'signal exit', code: null, signal: 'SIGKILL' },
    { label: 'EOF without status', code: null, signal: null },
  ]) {
    await t.test(terminal.label, async () => {
      const payload = secretPayload();
      const accepted = {
        schema: 'engineer-supervisor-secret-accepted.v1',
        status: 'accepted',
        executionMode: CONTROLLED_PROVIDER,
        frameSha256: sha256(payload),
        byteLength: payload.length,
      };
      const scripted = fakeChild({
        stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame(accepted)],
        onWrite({ child, writes }) {
          if (writes.length !== 5) return;
          queueMicrotask(() => {
            child.stdout.write(frame({
              schema: 'engineer-runtime-control-response.v1',
              operation: 'final',
            }));
            setImmediate(() => {
              child.stdout.end();
              child.emit('close', terminal.code, terminal.signal);
            });
          });
        },
      });
      const harness = transport({ nextChild: () => scripted });
      const opened = await harness.value.openSupervisorControl({
        sandboxId: SANDBOX,
        hmacKey: HMAC_SECRET,
        executionMode: CONTROLLED_PROVIDER,
        providerKey: PROVIDER_SECRET,
      });

      await opened.control.sendFrame(Buffer.from('bounded-control-request'));
      await assert.rejects(
        opened.control.receiveFrame(),
        (error) => error?.code === 'ERR_TRANSPORT_CHANNEL',
      );
      await opened.control.close();
    });
  }
});

test('concurrent stderr remains authoritative over a non-failure control frame', async () => {
  const payload = secretPayload();
  const accepted = {
    schema: 'engineer-supervisor-secret-accepted.v1',
    status: 'accepted',
    executionMode: CONTROLLED_PROVIDER,
    frameSha256: sha256(payload),
    byteLength: payload.length,
  };
  const scripted = fakeChild({
    stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame(accepted)],
    onWrite({ child, writes }) {
      if (writes.length !== 5) return;
      queueMicrotask(() => {
        const framedResponse = frame({ schema: 'engineer-runtime-control-response.v1' });
        child.stdout.write(framedResponse.subarray(0, 11));
        child.stderr.write(Buffer.from('engineer remote supervisor failed: ERR_REMOTE_SUPERVISOR_CONTROL\n'));
        child.stdout.write(framedResponse.subarray(11));
        child.emit('close', 70, null);
      });
    },
  });
  const harness = transport({ nextChild: () => scripted });
  const opened = await harness.value.openSupervisorControl({
    sandboxId: SANDBOX,
    hmacKey: HMAC_SECRET,
    executionMode: CONTROLLED_PROVIDER,
    providerKey: PROVIDER_SECRET,
  });

  await opened.control.sendFrame(Buffer.from('bounded-control-request'));
  await assert.rejects(
    opened.control.receiveFrame(),
    (error) => error?.code === 'ERR_TRANSPORT_STDERR',
  );
  await opened.control.close();
});

test('zero-provider control sends an authenticated HMAC-only frame and forbids provider bytes', async () => {
  const payload = zeroProviderPayload();
  const accepted = {
    schema: 'engineer-supervisor-secret-accepted.v1',
    status: 'accepted',
    executionMode: ZERO_PROVIDER_CANARY,
    frameSha256: sha256(payload),
    byteLength: payload.length,
  };
  const scripted = fakeChild({
    stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame(accepted)],
  });
  const harness = transport({ nextChild: () => scripted });
  const opened = await harness.value.openSupervisorControl({
    sandboxId: SANDBOX,
    hmacKey: HMAC_SECRET,
    executionMode: ZERO_PROVIDER_CANARY,
  });
  assert.deepEqual(opened.receipt, accepted);
  const writtenFrame = Buffer.concat(scripted.writes.slice(1));
  assert.equal(writtenFrame.readUInt32BE(0), payload.length);
  assert.deepEqual(writtenFrame.subarray(4), payload);
  assert.equal(writtenFrame.subarray(4, 8).toString('ascii'), 'EHZ1');
  assert.equal(writtenFrame.subarray(4).includes(PROVIDER_SECRET), false);
  await opened.control.close();

  for (const input of [
    {
      sandboxId: SANDBOX,
      hmacKey: HMAC_SECRET,
      executionMode: ZERO_PROVIDER_CANARY,
      providerKey: PROVIDER_SECRET,
    },
    {
      sandboxId: SANDBOX,
      hmacKey: HMAC_SECRET,
      executionMode: CONTROLLED_PROVIDER,
    },
    {
      sandboxId: SANDBOX,
      hmacKey: HMAC_SECRET,
      executionMode: 'openrouter',
    },
  ]) {
    const rejected = transport();
    await assert.rejects(
      rejected.value.openSupervisorControl(input),
      /execution mode|provider|unexpected field/i
    );
    assert.equal(rejected.channelCalls.length, 0);
  }
});

test('unexpected echo, secret echo, extra output, and channel loss never leak their content', async () => {
  const cases = [
    {
      name: 'unexpected bootstrap output',
      child: () => fakeChild({ stdout: [Buffer.from('shell prompt$\n')] }),
      pattern: /unexpected.*output|bootstrap/i,
    },
    {
      name: 'secret echo',
      child: () => fakeChild({ stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame(Buffer.concat([Buffer.from('echo:'), PROVIDER_SECRET]))] }),
      pattern: /secret|control/i,
    },
    {
      name: 'extra output',
      child: () => fakeChild({ stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame({
        schema: 'engineer-supervisor-secret-accepted.v1',
        status: 'accepted',
        executionMode: CONTROLLED_PROVIDER,
        frameSha256: sha256(secretPayload()),
        byteLength: secretPayload().length,
      }), Buffer.from('extra')] }),
      pattern: /extra.*output|unexpected/i,
    },
    {
      name: 'channel loss',
      child: () => fakeChild({ closeBeforeOutput: true }),
      pattern: /channel|closed|bootstrap/i,
    },
  ];

  for (const scenario of cases) {
    const harness = transport({ nextChild: scenario.child });
    let error;
    try {
      await harness.value.openSupervisorControl({
        sandboxId: SANDBOX,
        hmacKey: HMAC_SECRET,
        executionMode: CONTROLLED_PROVIDER,
        providerKey: PROVIDER_SECRET,
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, scenario.name);
    assert.match(error.message, scenario.pattern, scenario.name);
    assert.equal(error.message.includes(PROVIDER_SECRET.toString()), false, `${scenario.name} leaked provider key`);
    assert.equal(error.message.includes(HMAC_SECRET.toString()), false, `${scenario.name} leaked HMAC key`);
  }
});

test('interleaved allowed stderr cannot reset stdout secret scanning', async () => {
  const leakedFrame = frame(Buffer.concat([Buffer.from('echo:'), PROVIDER_SECRET]));
  const stdout = Buffer.concat([
    Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'),
    leakedFrame,
  ]);
  const secretOffset = stdout.indexOf(PROVIDER_SECRET);
  const splitAt = secretOffset + Math.floor(PROVIDER_SECRET.length / 2);
  const scripted = fakeChild({
    events: [
      { stream: 'stdout', bytes: stdout.subarray(0, splitAt) },
      { stream: 'stderr', bytes: Buffer.from(NON_TTY_NOTICE) },
      { stream: 'stdout', bytes: stdout.subarray(splitAt) },
    ],
    outputAfterFirstWrite: true,
  });
  const harness = transport({ nextChild: () => scripted });

  await assert.rejects(
    harness.value.openSupervisorControl({
      sandboxId: SANDBOX,
      hmacKey: HMAC_SECRET,
      executionMode: CONTROLLED_PROVIDER,
      providerKey: PROVIDER_SECRET,
    }),
    (error) => error?.code === 'ERR_TRANSPORT_SECRET'
  );
  assert.equal(Buffer.concat(scripted.writes).includes(PROVIDER_SECRET), false);
});

test('incomplete allowed stderr blocks the one-shot secret handoff', async () => {
  const scripted = fakeChild({
    stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n')],
    stderr: [Buffer.from(NON_TTY_NOTICE.slice(0, -1))],
    outputAfterFirstWrite: true,
  });
  const harness = transport({
    nextChild: () => scripted,
    channelTimeoutMs: 25,
  });

  await assert.rejects(
    harness.value.openSupervisorControl({
      sandboxId: SANDBOX,
      hmacKey: HMAC_SECRET,
      executionMode: CONTROLLED_PROVIDER,
      providerKey: PROVIDER_SECRET,
    }),
    (error) => error?.code === 'ERR_TRANSPORT_STDERR'
  );
  const outbound = Buffer.concat(scripted.writes);
  assert.equal(outbound.includes(PROVIDER_SECRET), false);
  assert.equal(outbound.includes(HMAC_SECRET), false);
});

test('provider-shaped output stays behind hash-only receipts while explicit control secrets are scanned', async () => {
  const leak = PROVIDER_SECRET.toString();
  const commandLeak = transport({
    runCommand: async () => ({ code: 0, stdout: Buffer.from(`oops ${leak}`), stderr: Buffer.alloc(0) }),
  });
  const receipt = await commandLeak.value.runRemote({ sandboxId: SANDBOX, executable: '/usr/bin/true', args: [] });
  assert.equal(JSON.stringify(receipt).includes(leak), false);

  const stderrLeak = transport({
    nextChild: () => fakeChild({ stderr: [Buffer.from(`fatal ${leak}`)] }),
  });
  await assert.rejects(
    stderrLeak.value.openSupervisorControl({
      sandboxId: SANDBOX,
      hmacKey: HMAC_SECRET,
      executionMode: CONTROLLED_PROVIDER,
      providerKey: PROVIDER_SECRET,
    }),
    (error) => /secret|channel|stderr/i.test(error.message) && !error.message.includes(leak)
  );
});

test('dispose closes live control channels, drops retained environment, and rejects future effects', async () => {
  const payload = secretPayload();
  const scripted = fakeChild({
    stdout: [Buffer.from('ENGINEER-SUPERVISOR/1 READY\n'), frame({
      schema: 'engineer-supervisor-secret-accepted.v1',
      status: 'accepted',
      executionMode: CONTROLLED_PROVIDER,
      frameSha256: sha256(payload),
      byteLength: payload.length,
    })],
  });
  const harness = transport({ nextChild: () => scripted });
  const opened = await harness.value.openSupervisorControl({
    sandboxId: SANDBOX,
    hmacKey: HMAC_SECRET,
    executionMode: CONTROLLED_PROVIDER,
    providerKey: PROVIDER_SECRET,
  });

  await harness.value.dispose();
  assert.equal(scripted.killCalls, 1);
  await assert.rejects(opened.control.sendFrame(Buffer.from('after-dispose')), /closed|disposed/i);
  await assert.rejects(
    harness.value.runRemote({ sandboxId: SANDBOX, executable: '/usr/bin/true', args: [] }),
    /disposed/i
  );
  await assert.doesNotReject(harness.value.dispose(), 'dispose is idempotent');
});
