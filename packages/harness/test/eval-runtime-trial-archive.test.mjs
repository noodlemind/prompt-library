import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  TASK_INPUT_ARCHIVE_LIMITS,
  TRIAL_OUTPUT_ARCHIVE_LIMITS,
  archiveLimitsForKind,
} from '../../../evals/runtime/archive-limits.mjs';
import {
  TRIAL_ARCHIVE_ENCODING,
  createTrialInputArchive,
  createTrialOutputArchive,
  inspectTrialArchive,
} from '../../../evals/runtime/trial-archive.mjs';

const HASH = (character) => character.repeat(64);
const TASK_IMAGE = `registry.example.invalid/evals/cobol@sha256:${'b'.repeat(64)}`;

test('archive profiles preserve the measured input ceiling and tighter output ceiling', () => {
  assert.deepEqual(TASK_INPUT_ARCHIVE_LIMITS, {
    compressedBytes: 128 * 1024 * 1024,
    uncompressedBytes: 384 * 1024 * 1024,
    contentBytes: 384 * 1024 * 1024,
    fileBytes: 128 * 1024 * 1024,
    entries: 8_192,
    controlDocumentBytes: 2 * 1024 * 1024,
  });
  assert.deepEqual(TRIAL_OUTPUT_ARCHIVE_LIMITS, {
    compressedBytes: 64 * 1024 * 1024,
    uncompressedBytes: 96 * 1024 * 1024,
    contentBytes: 48 * 1024 * 1024,
    fileBytes: 16 * 1024 * 1024,
    entries: 4_096,
    controlDocumentBytes: 512 * 1024,
  });
  assert.equal(Object.isFrozen(TASK_INPUT_ARCHIVE_LIMITS), true);
  assert.equal(Object.isFrozen(TRIAL_OUTPUT_ARCHIVE_LIMITS), true);
  assert.equal(archiveLimitsForKind('task-input'), TASK_INPUT_ARCHIVE_LIMITS);
  assert.equal(archiveLimitsForKind('trial-output'), TRIAL_OUTPUT_ARCHIVE_LIMITS);
  assert.throws(() => archiveLimitsForKind('unknown'), /archive kind/i);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-archive-'));
  const work = path.join(root, 'controller-work');
  const dataset = path.join(root, 'dataset');
  const bridge = path.join(root, 'bundle', 'bridge');
  const common = path.join(root, 'bundle', 'common');
  const harness = path.join(root, 'bundle', 'harness');
  for (const directory of [work, dataset, bridge, common, harness]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.join(dataset, 'cobol-modernization'), { mode: 0o700 });
  fs.writeFileSync(path.join(dataset, 'cobol-modernization', 'instruction.md'), 'modernize\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dataset, 'cobol-modernization', 'task.toml'), [
    '[environment]',
    `docker_image = "${TASK_IMAGE}"`,
    'cpus = 2',
    'memory = "4G"',
    'storage = "8G"',
    '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(bridge, 'harbor_agent.py'), '# bridge\n', { mode: 0o600 });
  fs.writeFileSync(path.join(bridge, 'agent.mjs'), 'export {};\n', { mode: 0o600 });
  fs.writeFileSync(path.join(common, 'AGENTS.md'), 'common\n', { mode: 0o600 });
  fs.writeFileSync(path.join(harness, 'SKILL.md'), 'harness\n', { mode: 0o600 });
  const condition = path.join(work, 'cobol-generic.condition.json');
  const telemetry = path.join(work, 'cobol-generic.done.json');
  fs.writeFileSync(condition, '{"id":"generic"}\n', { mode: 0o600 });
  const jobs = path.join(work, 'jobs');
  const originalNode = '/trusted/controller/node';
  const nodeHash = HASH('a');
  const mounts = [
    { type: 'bind', source: common, target: '/opt/engineer/common', read_only: true },
    { type: 'bind', source: harness, target: '/opt/harness-bundle/harness', read_only: true },
  ];
  const request = {
    trial: {
      trialId: 'pair-1-generic-1',
      task: 'cobol-modernization',
      condition: 'generic',
      executionMode: 'controlled-provider',
      identity: { pairId: 'pair-1', repetitionId: 'rep-1', attempt: 1 },
      ceilingUsd: 0.65,
      profileId: 'economical-small-model',
    },
    harbor: {
      executable: '/trusted/controller/harbor',
      args: [
        'run', '-p', dataset,
        '--include-task-name', 'cobol-modernization',
        '--agent', 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
        '--model', 'openrouter/test-small',
        '--env', 'docker',
        '--n-attempts', '1', '--n-concurrent', '1',
        '--override-cpus', '2', '--override-memory-mb', '4096', '--override-storage-mb', '8192',
        '-y', '--job-name', 'controlled-cobol-generic', '--jobs-dir', jobs,
        '--mounts', JSON.stringify(mounts),
        '--ae', `HARNESS_EVAL_TB_CONDITION=${condition}`,
        '--ae', `HARNESS_EVAL_TB_TELEMETRY_FILE=${telemetry}`,
        '--ae', `HARNESS_EVAL_HOST_NODE=${originalNode}`,
        '--ae', `HARNESS_EVAL_HOST_NODE_SHA256=${nodeHash}`,
      ],
      cwd: work,
      timeoutMs: 900_000,
      spawnEnv: {
        LANG: 'C.UTF-8',
        PATH: '/usr/bin:/bin',
        HOME: path.join(work, '.harbor-runtime-home'),
        PYTHONPATH: bridge,
        PYTHONNOUSERSITE: '1',
        PYTHONSAFEPATH: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        HARNESS_EVAL_HOST_NODE: originalNode,
        HARNESS_EVAL_HOST_NODE_SHA256: nodeHash,
      },
    },
  };
  return { root, work, dataset, bridge, common, harness, condition, telemetry, jobs, request };
}

function isolatedFixture() {
  const fx = fixture();
  const trialName = `engineer-${crypto.createHash('sha256')
    .update(fx.request.trial.trialId)
    .digest('hex')
    .slice(0, 24)}`;
  const commonTargets = [
    '/opt/eval-runtime/node-x64',
    '/opt/eval-runtime/evidence-probe',
    '/opt/eval-runtime/evidence-probe.mjs',
    '/opt/eval-runtime/bounded-exec',
    '/opt/eval-runtime/bounded-exec.mjs',
  ];
  const mounts = commonTargets.map((target) => ({
    type: 'bind', source: fx.common, target, read_only: true,
  }));
  fx.request.harbor.args = [
    'trial', 'start', '--path', path.join(fx.dataset, fx.request.trial.task),
    '--trial-name', trialName,
    '--trials-dir', path.join(fx.jobs, 'controlled-cobol-generic'),
    '--agent', 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    '--model', 'openrouter/test-small',
    '--env', 'docker',
    '--override-cpus', '2', '--override-memory-mb', '4096', '--override-storage-mb', '8192',
    '--extra-docker-compose', path.join(fx.work, 'control', 'security-compose.json'),
    '--mounts', JSON.stringify(mounts),
    '--ae', `HARNESS_EVAL_TB_CONDITION=${fx.condition}`,
    '--ae', `HARNESS_EVAL_TB_TELEMETRY_FILE=${fx.telemetry}`,
    '--ae', 'HARNESS_EVAL_HOST_NODE=/trusted/controller/node',
    '--ae', `HARNESS_EVAL_HOST_NODE_SHA256=${HASH('a')}`,
  ];
  return { ...fx, trialName };
}

test('creates a deterministic content-addressed gzip tar with only rewritten bounded paths', () => {
  const fx = fixture();
  const first = createTrialInputArchive(fx.request);
  const second = createTrialInputArchive(fx.request);

  assert.equal(first.manifest.encoding, TRIAL_ARCHIVE_ENCODING);
  assert.equal(first.manifest.sha256, crypto.createHash('sha256').update(first.bytes).digest('hex'));
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.materialization, second.materialization);

  const inspected = inspectTrialArchive(first.bytes, { kind: 'task-input' });
  assert.ok(inspected.entries.every((entry) => entry.path === 'work' || entry.path.startsWith('work/')));
  assert.ok(inspected.entries.some((entry) => entry.path === 'work/dataset/cobol-modernization/instruction.md'));
  assert.ok(inspected.entries.some((entry) => entry.path === 'work/control/condition.json'));
  assert.ok(inspected.entries.some((entry) => entry.path === 'work/mounts/000/AGENTS.md'));
  assert.ok(inspected.entries.some((entry) => entry.path === 'work/bridge/harbor_agent.py'));

  const serialized = first.bytes.toString('base64');
  for (const controllerPath of [fx.root, fx.dataset, fx.work, fx.common, fx.harness]) {
    assert.equal(Buffer.from(serialized, 'base64').includes(Buffer.from(controllerPath)), false);
  }
  assert.equal(inspected.document.harbor.executable, '/opt/engineer/bin/harbor');
  assert.equal(inspected.document.harbor.cwd, '/engineer-bounded/work');
  assert.ok(inspected.document.harbor.args.includes('/engineer-bounded/work/dataset'));
  assert.ok(inspected.document.harbor.args.includes('/engineer-bounded/work/jobs'));
  assert.ok(inspected.document.harbor.args.includes('HARNESS_EVAL_TB_CONDITION=/engineer-bounded/work/control/condition.json'));
  assert.ok(inspected.document.harbor.args.includes('HARNESS_EVAL_TB_TELEMETRY_FILE=/engineer-bounded/work/telemetry/done.json'));
  assert.ok(inspected.document.harbor.args.includes('HARNESS_EVAL_HOST_NODE=/usr/local/bin/node'));
  assert.ok(inspected.document.harbor.args.includes(`HARNESS_EVAL_HOST_NODE_SHA256=${'0'.repeat(64)}`));
  assert.deepEqual(first.materialization, {
    schema: 'engineer-trial-output-materialization.v1',
    inputArchiveSha256: first.manifest.sha256,
    controllerWorkRoot: fs.realpathSync(fx.work),
    jobsDirectory: fs.realpathSync(fx.work),
    jobsRelativePath: 'jobs',
    telemetryRelativePath: 'cobol-generic.done.json',
    jobName: 'controlled-cobol-generic',
    trialId: 'pair-1-generic-1',
  });
});

test('inspection scrubs owned compressed copies on success and malformed input', (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const archived = createTrialInputArchive(fx.request);
  const compressedLength = archived.bytes.length;
  const originalFill = Buffer.prototype.fill;
  let compressedCopiesScrubbed = 0;
  t.mock.method(Buffer.prototype, 'fill', function fill(value, ...args) {
    if (value === 0 && this.length === compressedLength) compressedCopiesScrubbed += 1;
    return originalFill.call(this, value, ...args);
  });

  const inspected = inspectTrialArchive(Uint8Array.from(archived.bytes), { kind: 'task-input' });
  assert.equal(compressedCopiesScrubbed, 1);
  for (const entry of inspected.entries) entry.bytes.fill(0);

  const malformed = Uint8Array.from(archived.bytes);
  malformed[0] = 0;
  assert.throws(
    () => inspectTrialArchive(malformed, { kind: 'task-input' }),
    /bounded gzip stream/i,
  );
  assert.equal(compressedCopiesScrubbed, 2);
  archived.bytes.fill(0);
});

test('task-input uses a larger bounded profile than untrusted trial-output', (t) => {
  const fx = isolatedFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const taskRoot = path.join(fx.dataset, 'cobol-modernization');
  const closure = path.join(taskRoot, 'tests', '.engineer-offline-verifier');
  fs.mkdirSync(closure, { recursive: true, mode: 0o700 });
  const python = path.join(closure, 'python');
  fs.writeFileSync(python, '');
  fs.truncateSync(python, 16 * 1024 * 1024 + 1);
  for (let index = 0; index < 4_100; index += 1) {
    fs.writeFileSync(path.join(closure, `entry-${String(index).padStart(4, '0')}`), '');
  }

  const archived = createTrialInputArchive(fx.request);
  try {
    const inspected = inspectTrialArchive(archived.bytes, { kind: 'task-input' });
    assert.ok(inspected.entries.length > 4_096);
    assert.ok(inspected.entries.some((entry) => entry.bytes.length > 16 * 1024 * 1024));
    for (const entry of inspected.entries) entry.bytes.fill(0);
    assert.throws(
      () => inspectTrialArchive(archived.bytes, { kind: 'trial-output' }),
      /bound|oversized/i,
    );
  } finally {
    archived.bytes.fill(0);
  }
});

test('task-input hard profile rejects a file or entry count beyond its reviewed ceiling', async (t) => {
  await t.test('file bytes + 1', (child) => {
    const fx = isolatedFixture();
    child.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
    const oversized = path.join(fx.dataset, 'cobol-modernization', 'oversized.bin');
    fs.writeFileSync(oversized, '');
    fs.truncateSync(oversized, TASK_INPUT_ARCHIVE_LIMITS.fileBytes + 1);
    assert.throws(() => createTrialInputArchive(fx.request), /file bound|exceeds.*bound/i);
  });

  await t.test('entries + 1', (child) => {
    const fx = isolatedFixture();
    child.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
    const entries = path.join(fx.dataset, 'cobol-modernization', 'bounded-entries');
    fs.mkdirSync(entries, { mode: 0o700 });
    for (let index = 0; index < TASK_INPUT_ARCHIVE_LIMITS.entries; index += 1) {
      fs.writeFileSync(path.join(entries, String(index).padStart(4, '0')), '');
    }
    assert.throws(() => createTrialInputArchive(fx.request), /too many|entry|files/i);
  });
});

test('trial-output rejects aggregate content before reading the next individually legal file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-output-aggregate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobName = 'bounded-job';
  const jobRoot = path.join(root, 'jobs', jobName);
  fs.mkdirSync(jobRoot, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 3; index += 1) {
    const file = path.join(jobRoot, `${index}-legal.bin`);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, TRIAL_OUTPUT_ARCHIVE_LIMITS.fileBytes);
  }
  const sentinel = path.join(jobRoot, '3-sentinel.bin');
  fs.writeFileSync(sentinel, 'x');
  const sentinelReal = fs.realpathSync.native(sentinel);

  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalFill = Buffer.prototype.fill;
  let sentinelDescriptor = null;
  let sentinelRead = false;
  let clearedBytes = 0;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const descriptor = originalOpenSync.call(fs, file, ...args);
    if (file === sentinelReal) sentinelDescriptor = descriptor;
    return descriptor;
  });
  t.mock.method(fs, 'readSync', (descriptor, ...args) => {
    if (descriptor === sentinelDescriptor) {
      sentinelRead = true;
      throw new Error('aggregate sentinel was read');
    }
    return originalReadSync.call(fs, descriptor, ...args);
  });
  t.mock.method(Buffer.prototype, 'fill', function fill(value, ...args) {
    if (value === 0) clearedBytes += this.length;
    return originalFill.call(this, value, ...args);
  });

  assert.throws(
    () => createTrialOutputArchive({
      workRoot: root,
      inputArchiveSha256: HASH('a'),
      trialId: 'aggregate-bound-trial',
      jobName,
      executionMode: 'zero-provider-canary',
      runtimeBindingHash: HASH('b'),
      brokerBindingHash: null,
      commandResult: { status: 0, signal: null, stdout: '', stderr: '', error: null },
    }),
    /aggregate contents exceed their byte bound/i,
  );
  assert.equal(sentinelRead, false);
  assert.ok(clearedBytes >= TRIAL_OUTPUT_ARCHIVE_LIMITS.contentBytes * 2);
});

test('archives one deterministic Harbor trial start and preserves its exact output layout', () => {
  const fx = isolatedFixture();
  const archived = createTrialInputArchive(fx.request);
  const inspected = inspectTrialArchive(archived.bytes, { kind: 'task-input' });
  const args = inspected.document.harbor.args;

  assert.deepEqual(args.slice(0, 4), [
    'trial', 'start', '--path', '/engineer-bounded/work/dataset/cobol-modernization',
  ]);
  assert.equal(args[args.indexOf('--trial-name') + 1], fx.trialName);
  assert.equal(
    args[args.indexOf('--trials-dir') + 1],
    '/engineer-bounded/work/jobs/controlled-cobol-generic'
  );
  assert.equal(args.includes('--job-name'), false);
  assert.equal(args.includes('--jobs-dir'), false);
  assert.equal(inspected.document.output.jobName, 'controlled-cobol-generic');
  assert.equal(inspected.document.security.immutableImage, TASK_IMAGE);
  assert.equal(
    args[args.indexOf('--extra-docker-compose') + 1],
    '/engineer-bounded/work/control/security-compose.json'
  );
  assert.ok(inspected.entries.some((entry) => entry.path === 'work/control/security-compose.json'));
  assert.equal(archived.materialization.jobName, 'controlled-cobol-generic');
  assert.equal(archived.materialization.jobsRelativePath, 'jobs');
});

test('archive-bound execution mode is the only authority for the scripted zero-provider driver', () => {
  const zero = isolatedFixture();
  zero.request.trial.executionMode = 'zero-provider-canary';
  zero.request.harbor.args[zero.request.harbor.args.indexOf('--agent') + 1] =
    'evals.external.terminal_bench.harbor_agent:ScriptedCanaryAgent';
  fs.writeFileSync(zero.condition, JSON.stringify({
    id: 'generic',
    runtime: { driverMode: 'scripted-canary' },
  }), { mode: 0o600 });
  const archived = createTrialInputArchive(zero.request);
  const inspected = inspectTrialArchive(archived.bytes, { kind: 'task-input' });
  assert.equal(inspected.document.trial.executionMode, 'zero-provider-canary');
  const conditionEntry = inspected.entries.find((entry) => entry.path === 'work/control/condition.json');
  assert.equal(JSON.parse(conditionEntry.bytes).runtime.driverMode, 'scripted-canary');

  const missing = isolatedFixture();
  missing.request.trial.executionMode = 'zero-provider-canary';
  missing.request.harbor.args[missing.request.harbor.args.indexOf('--agent') + 1] =
    'evals.external.terminal_bench.harbor_agent:ScriptedCanaryAgent';
  assert.throws(
    () => createTrialInputArchive(missing.request),
    /zero-provider|scripted-canary|driver mode/i,
  );

  const paid = isolatedFixture();
  fs.writeFileSync(paid.condition, JSON.stringify({
    id: 'generic',
    runtime: { driverMode: 'scripted-canary' },
  }), { mode: 0o600 });
  assert.throws(
    () => createTrialInputArchive(paid.request),
    /controlled-provider|scripted-canary|driver mode/i,
  );

  for (const mode of [undefined, 'zero-provider', 'controlled-provider ']) {
    const invalid = isolatedFixture();
    if (mode === undefined) delete invalid.request.trial.executionMode;
    else invalid.request.trial.executionMode = mode;
    assert.throws(
      () => createTrialInputArchive(invalid.request),
      /execution mode|controlled-provider|zero-provider-canary/i,
    );
  }
});

test('harness archive admits exactly the two treatment mounts after the common ordinal set', () => {
  const fx = isolatedFixture();
  fx.request.trial.condition = 'harness';
  fs.writeFileSync(fx.condition, '{"id":"harness"}\n', { mode: 0o600 });
  const index = fx.request.harbor.args.indexOf('--mounts');
  const mounts = JSON.parse(fx.request.harbor.args[index + 1]);
  mounts.push(
    { type: 'bind', source: fx.harness, target: '/opt/harness-bundle/harness', read_only: true },
    { type: 'bind', source: fx.harness, target: '/opt/harness-bundle/harness-cli', read_only: true },
  );
  fx.request.harbor.args[index + 1] = JSON.stringify(mounts);
  const archived = createTrialInputArchive(fx.request);
  const inspected = inspectTrialArchive(archived.bytes, { kind: 'task-input' });
  const remoteMounts = JSON.parse(
    inspected.document.harbor.args[inspected.document.harbor.args.indexOf('--mounts') + 1]
  );
  assert.deepEqual(remoteMounts.map((mount) => mount.source), remoteMounts.map((_, ordinal) =>
    `/engineer-bounded/work/mounts/${String(ordinal).padStart(3, '0')}`
  ));
  assert.deepEqual(remoteMounts.slice(-2).map((mount) => mount.target), [
    '/opt/harness-bundle/harness', '/opt/harness-bundle/harness-cli',
  ]);
});

test('isolated Harbor archives reject trial identity and output-layout drift', async (t) => {
  await t.test('trial name', () => {
    const fx = isolatedFixture();
    fx.request.harbor.args[fx.request.harbor.args.indexOf('--trial-name') + 1] = `engineer-${'f'.repeat(24)}`;
    assert.throws(() => createTrialInputArchive(fx.request), /trial.*(?:identity|name|drift)/i);
  });

  await t.test('trial output directory', () => {
    const fx = isolatedFixture();
    fx.request.harbor.args[fx.request.harbor.args.indexOf('--trials-dir') + 1] = path.join(fx.root, 'outside');
    assert.throws(() => createTrialInputArchive(fx.request), /trial|jobs|work|escaped/i);
  });

  await t.test('generic treatment mount', () => {
    const fx = isolatedFixture();
    const index = fx.request.harbor.args.indexOf('--mounts');
    const mounts = JSON.parse(fx.request.harbor.args[index + 1]);
    mounts.push({
      type: 'bind', source: fx.harness, target: '/opt/harness-bundle/harness', read_only: true,
    });
    fx.request.harbor.args[index + 1] = JSON.stringify(mounts);
    assert.throws(() => createTrialInputArchive(fx.request), /condition-specific.*mount/i);
  });
});

test('fails closed on secret-bearing env, non-Harbor argv, symlinks, and path escape', async (t) => {
  await t.test('provider env', () => {
    const fx = fixture();
    fx.request.harbor.spawnEnv.OPENROUTER_API_KEY = 'sk-must-not-archive';
    assert.throws(() => createTrialInputArchive(fx.request), /provider|secret/i);
  });

  await t.test('unknown argv', () => {
    const fx = fixture();
    fx.request.harbor.args.push('--legacy-unsafe-flag');
    assert.throws(() => createTrialInputArchive(fx.request), /Harbor argv|argument/i);
  });

  await t.test('symlink input', () => {
    const fx = fixture();
    fs.symlinkSync(path.join(fx.dataset, 'cobol-modernization', 'instruction.md'), path.join(fx.dataset, 'alias'));
    assert.throws(() => createTrialInputArchive(fx.request), /symlink|regular/i);
  });

  await t.test('jobs path escape', () => {
    const fx = fixture();
    const index = fx.request.harbor.args.indexOf('--jobs-dir');
    fx.request.harbor.args[index + 1] = path.join(fx.root, 'outside');
    assert.throws(() => createTrialInputArchive(fx.request), /jobs.*work|escaped/i);
  });
});
