import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';

import {
  applyTrialOutputArchive,
  createTrialInputArchive,
} from '../runtime/trial-archive.mjs';
import {
  PINNED_HARBOR_EXECUTABLE,
  TRIAL_INPUT_ARCHIVE_FD,
  TRIAL_OUTPUT_ARCHIVE_FD,
  runArchivedTrial,
  runArchivedTrialCli,
} from '../runtime/trial-runner.mjs';

const HASH = (character) => character.repeat(64);

function requestFixture({ executionMode = 'controlled-provider' } = {}) {
  const zeroProvider = executionMode === 'zero-provider-canary';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-controller-'));
  const work = path.join(root, 'work');
  const dataset = path.join(root, 'dataset');
  const bridge = path.join(root, 'bridge');
  const mount = path.join(root, 'mount');
  for (const directory of [work, dataset, bridge, mount]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dataset, 'task-a'));
  fs.writeFileSync(path.join(dataset, 'task-a', 'instruction.md'), 'fix it\n');
  fs.writeFileSync(path.join(bridge, 'harbor_agent.py'), '# bridge\n');
  fs.writeFileSync(path.join(mount, 'README.md'), 'mounted\n');
  const condition = path.join(work, 'task-a-generic.condition.json');
  const telemetry = path.join(work, 'task-a-generic.done.json');
  fs.writeFileSync(condition, zeroProvider
    ? '{"id":"generic","runtime":{"driverMode":"scripted-canary"}}\n'
    : '{"id":"generic"}\n');
  const args = [
    'run', '-p', dataset,
    '--include-task-name', 'task-a',
    '--agent', zeroProvider
      ? 'evals.external.terminal_bench.harbor_agent:ScriptedCanaryAgent'
      : 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    '--model', zeroProvider ? 'canary/scripted' : 'openrouter/test-small', '--env', 'docker',
    '--n-attempts', '1', '--n-concurrent', '1',
    '--override-cpus', '1', '--override-memory-mb', '2048', '--override-storage-mb', '4096',
    '-y', '--job-name', 'job-a', '--jobs-dir', path.join(work, 'jobs'),
    '--mounts', JSON.stringify([{ type: 'bind', source: mount, target: '/opt/engineer/common', read_only: true }]),
    '--ae', `HARNESS_EVAL_TB_CONDITION=${condition}`,
    '--ae', `HARNESS_EVAL_TB_TELEMETRY_FILE=${telemetry}`,
    '--ae', 'HARNESS_EVAL_HOST_NODE=/trusted/node',
    '--ae', `HARNESS_EVAL_HOST_NODE_SHA256=${HASH('1')}`,
  ];
  const archived = createTrialInputArchive({
    trial: {
      trialId: 'trial-a', task: 'task-a', condition: 'generic',
      executionMode,
      identity: { pairId: 'pair-a', repetitionId: 'rep-a', attempt: 1 },
      ceilingUsd: zeroProvider ? 0 : 0.65, profileId: zeroProvider ? 'canary' : 'small',
    },
    harbor: {
      executable: '/trusted/harbor', args, cwd: work, timeoutMs: 30_000,
      spawnEnv: {
        LANG: 'C.UTF-8', PATH: '/usr/bin:/bin', HOME: path.join(work, '.home'),
        PYTHONPATH: bridge, PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1',
        PYTHONDONTWRITEBYTECODE: '1', HARNESS_EVAL_HOST_NODE: '/trusted/node',
        HARNESS_EVAL_HOST_NODE_SHA256: HASH('1'),
      },
    },
  });
  return { root, work, telemetry, archived };
}

function zeroProviderEnv(overrides = {}) {
  return {
    DOCKER_HOST: 'unix:///run/engineer/harbor-docker.sock',
    ENGINEER_RUNTIME_EXECUTION_MODE: 'zero-provider-canary',
    ENGINEER_RUNTIME_LEASE_HASH: HASH('2'),
    ...overrides,
  };
}

function brokerEnv(overrides = {}) {
  return {
    DOCKER_HOST: 'unix:///run/engineer/harbor-docker.sock',
    ENGINEER_PROVIDER_BROKER_SOCKET: '/run/engineer/provider.sock',
    ENGINEER_PROVIDER_LEASE_ID: 'lease-trial-a',
    ENGINEER_PROVIDER_LEASE_DIGEST: HASH('2'),
    ENGINEER_PROVIDER_LEASE_SEQUENCE: '2',
    ENGINEER_PROVIDER_TRIAL_ID: 'trial-a',
    ENGINEER_RUNTIME_LEASE_HASH: HASH('2'),
    ...overrides,
  };
}

function localDescriptorOwner() {
  return {
    expectedDescriptorOwnerUid: process.getuid(),
    expectedDescriptorOwnerGid: process.getgid(),
  };
}

function descriptorFixture(inputBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-fds-'));
  const input = path.join(root, 'task-input.tar');
  const output = path.join(root, 'trial-output.tar');
  fs.writeFileSync(input, inputBytes, { mode: 0o600 });
  fs.chmodSync(input, 0o600);
  const inputFd = fs.openSync(input, fs.constants.O_RDONLY);
  const outputFd = fs.openSync(
    output,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  fs.chmodSync(output, 0o600);
  return { root, input, output, inputFd, outputFd };
}

test('remote runner uses pinned direct Harbor argv, forwards exact broker bindings, and round-trips only fresh evidence', async () => {
  const fx = requestFixture();
  const boundedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-remote-'));
  fs.chmodSync(boundedRoot, 0o700);
  const outputArchivePath = path.join(boundedRoot, 'transport', 'trial-output.tar');
  const calls = [];
  const result = await runArchivedTrial({
    inputBytes: fx.archived.bytes,
    expectedInputSha256: fx.archived.manifest.sha256,
    boundedRoot,
    outputArchivePath,
    inheritedEnv: brokerEnv(),
    hashExecutable: async (file) => {
      assert.equal(file, '/usr/local/bin/node');
      return HASH('3');
    },
    runCommand: async (file, args, options) => {
      calls.push({ file, args: args.slice(), options: { ...options, env: { ...options.env } } });
      fs.mkdirSync(path.join(options.cwd, 'jobs', 'job-a', 'trial__abc'), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, 'jobs', 'job-a', 'trial__abc', 'result.json'), '{"ok":true}\n');
      fs.writeFileSync(path.join(options.cwd, 'telemetry', 'done.json'), '{"done":true}\n');
      return { status: 0, signal: null, stdout: Buffer.from('private stdout'), stderr: Buffer.alloc(0), error: null };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, PINNED_HARBOR_EXECUTABLE);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, path.join(boundedRoot, 'work'));
  assert.equal(Object.values(calls[0].options.env).includes('sk-secret'), false);
  for (const [key, value] of Object.entries(brokerEnv()).filter(([key]) => key.startsWith('ENGINEER_'))) {
    assert.ok(calls[0].args.includes(`${key}=${value}`), `${key} forwarded through --ae`);
  }
  assert.ok(calls[0].args.includes(`HARNESS_EVAL_HOST_NODE_SHA256=${HASH('3')}`));
  assert.equal(fs.statSync(outputArchivePath).mode & 0o077, 0);
  assert.equal(result.manifest.sha256.length, 64);
  assert.equal(result.run.code, 0);
  assert.equal(result.run.stdout, '');
  assert.equal(result.run.stderr, '');
  assert.equal(result.run.containmentComplete, true);
  assert.equal(result.receipt.executionMode, 'controlled-provider');
  assert.match(result.receipt.runtimeBindingHash, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.brokerBindingHash, result.receipt.runtimeBindingHash);
  assert.equal(fs.readdirSync(boundedRoot).includes('work'), false);

  const applied = applyTrialOutputArchive({
    bytes: result.bytes,
    expectedSha256: result.manifest.sha256,
    expectedByteLength: result.manifest.byteLength,
    materialization: fx.archived.materialization,
  });
  assert.deepEqual(applied, result.run);
  assert.equal(fs.readFileSync(path.join(fx.work, 'jobs', 'job-a', 'trial__abc', 'result.json'), 'utf8'), '{"ok":true}\n');
  assert.equal(fs.readFileSync(fx.telemetry, 'utf8'), '{"done":true}\n');
});

test('runner rejects partial or mismatched broker bindings before Harbor', async () => {
  const fx = requestFixture();
  const boundedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-bindings-'));
  let called = false;
  const inheritedEnv = brokerEnv();
  delete inheritedEnv.ENGINEER_PROVIDER_TRIAL_ID;
  await assert.rejects(
    runArchivedTrial({
      inputBytes: fx.archived.bytes,
      expectedInputSha256: fx.archived.manifest.sha256,
      boundedRoot,
      inheritedEnv,
      hashExecutable: async () => HASH('3'),
      runCommand: async () => { called = true; },
    }),
    /broker.*binding|trial/i
  );
  assert.equal(called, false);
});

test('zero-provider runner executes the archive-bound canary without forwarding provider or broker bindings', async () => {
  const fx = requestFixture({ executionMode: 'zero-provider-canary' });
  const boundedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-zero-provider-'));
  const calls = [];
  const result = await runArchivedTrial({
    inputBytes: fx.archived.bytes,
    expectedInputSha256: fx.archived.manifest.sha256,
    boundedRoot,
    inheritedEnv: zeroProviderEnv(),
    hashExecutable: async () => HASH('3'),
    runCommand: async (file, args, options) => {
      calls.push({ file, args: args.slice(), env: { ...options.env } });
      fs.mkdirSync(path.join(options.cwd, 'jobs', 'job-a', 'trial__canary'), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, 'jobs', 'job-a', 'trial__canary', 'result.json'), '{"canary":true}\n');
      return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: null };
    },
  });

  assert.equal(calls.length, 1);
  const forwarded = [...calls[0].args, ...Object.keys(calls[0].env)];
  assert.equal(forwarded.some((value) => /ENGINEER_PROVIDER_|BROKER/i.test(value)), false);
  assert.equal(calls[0].env.DOCKER_HOST, zeroProviderEnv().DOCKER_HOST);
  assert.equal(calls[0].env.ENGINEER_RUNTIME_LEASE_HASH, HASH('2'));
  assert.equal(Object.hasOwn(calls[0].env, 'ENGINEER_RUNTIME_EXECUTION_MODE'), false);
  assert.equal(result.run.code, 0);
  assert.equal(result.receipt.executionMode, 'zero-provider-canary');
  assert.match(result.receipt.runtimeBindingHash, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.brokerBindingHash, null);
});

test('zero-provider runner rejects mode drift and every provider or broker environment binding before Harbor', async (t) => {
  const fx = requestFixture({ executionMode: 'zero-provider-canary' });
  for (const [name, inheritedEnv] of [
    ['missing authenticated mode', { ...zeroProviderEnv(), ENGINEER_RUNTIME_EXECUTION_MODE: undefined }],
    ['controlled mode', zeroProviderEnv({ ENGINEER_RUNTIME_EXECUTION_MODE: 'controlled-provider' })],
    ['broker socket', zeroProviderEnv({ ENGINEER_PROVIDER_BROKER_SOCKET: '/run/engineer/provider.sock' })],
    ['provider endpoint', zeroProviderEnv({ CUSTOM_PROVIDER_ENDPOINT: 'https://example.invalid' })],
    ['raw credential', zeroProviderEnv({ OPENROUTER_API_KEY: 'sk-secret-value' })],
  ]) {
    await t.test(name, async () => {
      if (inheritedEnv.ENGINEER_RUNTIME_EXECUTION_MODE === undefined) {
        delete inheritedEnv.ENGINEER_RUNTIME_EXECUTION_MODE;
      }
      let called = false;
      await assert.rejects(runArchivedTrial({
        inputBytes: fx.archived.bytes,
        expectedInputSha256: fx.archived.manifest.sha256,
        boundedRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-zero-reject-')),
        inheritedEnv,
        hashExecutable: async () => HASH('3'),
        runCommand: async () => { called = true; },
      }), /mode|provider|broker|secret|binding/i);
      assert.equal(called, false);
    });
  }
});

test('runner rejects a tar link entry before extraction or execution', async () => {
  const fx = requestFixture();
  const raw = zlib.gunzipSync(fx.archived.bytes);
  // Turn the first non-directory payload entry into a checksum-valid symlink,
  // proving the type policy itself rejects links before extraction.
  for (let offset = 0; offset + 512 <= raw.length; offset += 512) {
    const type = String.fromCharCode(raw[offset + 156]);
    const sizeText = raw.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (type === '0' || type === '\0') {
      raw[offset + 156] = '2'.charCodeAt(0);
      raw.fill(0x20, offset + 148, offset + 156);
      let checksum = 0;
      for (let index = offset; index < offset + 512; index += 1) checksum += raw[index];
      raw.write(`${checksum.toString(8).padStart(6, '0')}\0 `, offset + 148, 8, 'ascii');
      break;
    }
    offset += Math.ceil(size / 512) * 512;
  }
  const malicious = zlib.gzipSync(raw, { level: 9, mtime: 0 });
  const maliciousSha256 = crypto.createHash('sha256').update(malicious).digest('hex');
  const boundedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-malicious-'));
  let called = false;
  await assert.rejects(
    runArchivedTrial({
      inputBytes: malicious,
      expectedInputSha256: maliciousSha256,
      boundedRoot,
      inheritedEnv: brokerEnv(),
      hashExecutable: async () => HASH('3'),
      runCommand: async () => { called = true; },
    }),
    /links.*forbidden/i
  );
  assert.equal(called, false);
});

test('runner reads and publishes archives only through protected inherited descriptors', async () => {
  const fx = requestFixture();
  const descriptors = descriptorFixture(fx.archived.bytes);
  const boundedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-inherited-'));
  const calls = [];
  let result;
  try {
    result = await runArchivedTrial({
      inputArchiveFd: descriptors.inputFd,
      expectedInputSha256: fx.archived.manifest.sha256,
      boundedRoot,
      outputArchiveFd: descriptors.outputFd,
      ...localDescriptorOwner(),
      inheritedEnv: brokerEnv(),
      hashExecutable: async () => HASH('3'),
      runCommand: async (file, args, options) => {
        calls.push({ file, args: args.slice(), options });
        fs.mkdirSync(path.join(options.cwd, 'jobs', 'job-a', 'trial__fd'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, 'jobs', 'job-a', 'trial__fd', 'result.json'), '{"fd":true}\n');
        return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: null };
      },
    });
  } finally {
    fs.closeSync(descriptors.inputFd);
    fs.closeSync(descriptors.outputFd);
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(fs.readFileSync(descriptors.output), result.bytes);
  assert.equal(fs.statSync(descriptors.output).mode & 0o777, 0o600);
  assert.equal(result.manifest.sha256, crypto.createHash('sha256').update(result.bytes).digest('hex'));
});

test('runner accepts inherited archive descriptors only as an unmixed input-output pair', async () => {
  const fx = requestFixture();
  const common = {
    expectedInputSha256: fx.archived.manifest.sha256,
    boundedRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-fd-pair-')),
    inheritedEnv: brokerEnv(),
  };

  await assert.rejects(
    runArchivedTrial({ ...common, inputArchiveFd: 40 }),
    /descriptor.*pair|paired.*descriptor/i,
  );
  await assert.rejects(
    runArchivedTrial({ ...common, inputBytes: fx.archived.bytes, outputArchiveFd: 41 }),
    /descriptor.*pair|paired.*descriptor/i,
  );
});

test('runner rejects unprotected or writable input descriptors before Harbor', async (t) => {
  const fx = requestFixture();
  for (const scenario of [
    {
      name: 'write-enabled input',
      prepare(file) { return fs.openSync(file, fs.constants.O_RDWR); },
      pattern: /read-only/i,
    },
    {
      name: 'group-readable input',
      prepare(file) { fs.chmodSync(file, 0o640); return fs.openSync(file, fs.constants.O_RDONLY); },
      pattern: /protected|owner-only/i,
    },
    {
      name: 'setuid input',
      prepare(file) { fs.chmodSync(file, 0o4600); return fs.openSync(file, fs.constants.O_RDONLY); },
      pattern: /protected|owner-only/i,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const descriptors = descriptorFixture(fx.archived.bytes);
      fs.closeSync(descriptors.inputFd);
      descriptors.inputFd = scenario.prepare(descriptors.input);
      let called = false;
      try {
        await assert.rejects(runArchivedTrial({
          inputArchiveFd: descriptors.inputFd,
          expectedInputSha256: fx.archived.manifest.sha256,
          boundedRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-input-fd-reject-')),
          outputArchiveFd: descriptors.outputFd,
          ...localDescriptorOwner(),
          inheritedEnv: brokerEnv(),
          hashExecutable: async () => HASH('3'),
          runCommand: async () => { called = true; },
        }), scenario.pattern);
      } finally {
        fs.closeSync(descriptors.inputFd);
        fs.closeSync(descriptors.outputFd);
      }
      assert.equal(called, false);
    });
  }

  await t.test('owner drift', async () => {
    const descriptors = descriptorFixture(fx.archived.bytes);
    let called = false;
    try {
      await assert.rejects(runArchivedTrial({
        inputArchiveFd: descriptors.inputFd,
        expectedInputSha256: fx.archived.manifest.sha256,
        boundedRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-input-owner-reject-')),
        outputArchiveFd: descriptors.outputFd,
        expectedDescriptorOwnerUid: process.getuid() + 1,
        expectedDescriptorOwnerGid: process.getgid(),
        inheritedEnv: brokerEnv(),
        hashExecutable: async () => HASH('3'),
        runCommand: async () => { called = true; },
      }), /owner|protected/i);
    } finally {
      fs.closeSync(descriptors.inputFd);
      fs.closeSync(descriptors.outputFd);
    }
    assert.equal(called, false);
  });
});

test('runner rejects unsafe output descriptors before Harbor', async (t) => {
  const fx = requestFixture();
  for (const scenario of [
    {
      name: 'read-only output',
      prepare(file) { return fs.openSync(file, fs.constants.O_RDONLY); },
      pattern: /writable/i,
    },
    {
      name: 'nonempty output',
      prepare(file) { fs.writeFileSync(file, 'occupied', { mode: 0o600 }); return fs.openSync(file, fs.constants.O_WRONLY); },
      pattern: /empty|precreated/i,
    },
    {
      name: 'group-writable output',
      prepare(file) { fs.chmodSync(file, 0o620); return fs.openSync(file, fs.constants.O_WRONLY); },
      pattern: /protected|owner-only/i,
    },
    {
      name: 'sticky-bit output',
      prepare(file) { fs.chmodSync(file, 0o1600); return fs.openSync(file, fs.constants.O_WRONLY); },
      pattern: /protected|owner-only/i,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const descriptors = descriptorFixture(fx.archived.bytes);
      fs.closeSync(descriptors.outputFd);
      descriptors.outputFd = scenario.prepare(descriptors.output);
      let called = false;
      try {
        await assert.rejects(runArchivedTrial({
          inputArchiveFd: descriptors.inputFd,
          expectedInputSha256: fx.archived.manifest.sha256,
          boundedRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'trial-runner-output-fd-reject-')),
          outputArchiveFd: descriptors.outputFd,
          ...localDescriptorOwner(),
          inheritedEnv: brokerEnv(),
          hashExecutable: async () => HASH('3'),
          runCommand: async () => { called = true; },
        }), scenario.pattern);
      } finally {
        fs.closeSync(descriptors.inputFd);
        fs.closeSync(descriptors.outputFd);
      }
      assert.equal(called, false);
    });
  }
});

test('snapshot CLI accepts only the control-plane digest flag and stays output-silent by contract', async () => {
  assert.equal(await runArchivedTrialCli({ argv: [], env: {} }), 64);
  assert.equal(await runArchivedTrialCli({ argv: ['--input-sha256', 'not-a-digest'], env: {} }), 64);
  assert.equal(await runArchivedTrialCli({ argv: ['--input', HASH('1')], env: {} }), 64);
});

test('snapshot CLI binds only fixed inherited archive descriptors and never archive pathnames', async () => {
  let received;
  const output = Buffer.from('private output bytes');
  const env = brokerEnv();
  const exitCode = await runArchivedTrialCli({
    argv: ['--input-sha256', HASH('a')],
    env,
    runTrial: async (options) => {
      received = options;
      return {
        run: { code: 0, timedOut: false },
        bytes: output,
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(TRIAL_INPUT_ARCHIVE_FD, 3);
  assert.equal(TRIAL_OUTPUT_ARCHIVE_FD, 4);
  assert.equal(received.inputArchiveFd, TRIAL_INPUT_ARCHIVE_FD);
  assert.equal(received.outputArchiveFd, TRIAL_OUTPUT_ARCHIVE_FD);
  assert.equal(received.expectedDescriptorOwnerUid, 0);
  assert.equal(received.expectedDescriptorOwnerGid, 0);
  assert.equal(received.expectedInputSha256, HASH('a'));
  assert.equal(received.inheritedEnv, env);
  assert.equal(Object.hasOwn(received, 'inputArchivePath'), false);
  assert.equal(Object.hasOwn(received, 'inputBytes'), false);
  assert.equal(Object.hasOwn(received, 'outputArchivePath'), false);
  assert.deepEqual(output, Buffer.alloc(output.length));
});
