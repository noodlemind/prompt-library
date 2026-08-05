import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  TRIAL_ARCHIVE_ENCODING,
  createTrialInputArchive,
  inspectTrialArchive,
} from '../../../evals/runtime/trial-archive.mjs';

const HASH = (character) => character.repeat(64);
const TASK_IMAGE = `registry.example.invalid/evals/cobol@sha256:${'b'.repeat(64)}`;

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
    { type: 'bind', source: harness, target: '/opt/engineer/harness', read_only: true },
  ];
  const request = {
    trial: {
      trialId: 'pair-1-generic-1',
      task: 'cobol-modernization',
      condition: 'generic',
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

test('harness archive admits exactly the two treatment mounts after the common ordinal set', () => {
  const fx = isolatedFixture();
  fx.request.trial.condition = 'harness';
  const index = fx.request.harbor.args.indexOf('--mounts');
  const mounts = JSON.parse(fx.request.harbor.args[index + 1]);
  mounts.push(
    { type: 'bind', source: fx.harness, target: '/opt/engineer/harness', read_only: true },
    { type: 'bind', source: fx.harness, target: '/opt/engineer/harness-cli', read_only: true },
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
    '/opt/engineer/harness', '/opt/engineer/harness-cli',
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
      type: 'bind', source: fx.harness, target: '/opt/engineer/harness', read_only: true,
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
