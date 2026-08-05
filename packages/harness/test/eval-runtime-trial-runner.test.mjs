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
} from '../../../evals/runtime/trial-archive.mjs';
import {
  PINNED_HARBOR_EXECUTABLE,
  runArchivedTrial,
  runArchivedTrialCli,
} from '../../../evals/runtime/trial-runner.mjs';

const HASH = (character) => character.repeat(64);

function requestFixture() {
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
  fs.writeFileSync(condition, '{"id":"generic"}\n');
  const args = [
    'run', '-p', dataset,
    '--include-task-name', 'task-a',
    '--agent', 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    '--model', 'openrouter/test-small', '--env', 'docker',
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
      identity: { pairId: 'pair-a', repetitionId: 'rep-a', attempt: 1 },
      ceilingUsd: 0.65, profileId: 'small',
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

test('snapshot CLI accepts only the control-plane digest flag and stays output-silent by contract', async () => {
  assert.equal(await runArchivedTrialCli({ argv: [], env: {} }), 64);
  assert.equal(await runArchivedTrialCli({ argv: ['--input-sha256', 'not-a-digest'], env: {} }), 64);
  assert.equal(await runArchivedTrialCli({ argv: ['--input', HASH('1')], env: {} }), 64);
});
