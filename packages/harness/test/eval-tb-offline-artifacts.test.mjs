import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OFFLINE_DATASET_ATTESTATION,
  OFFLINE_DATASET_LOCK,
  PINNED_OFFLINE_INPUTS,
  buildOfflineTerminalBenchDataset,
  verifyOfflineTerminalBenchDataset,
} from '../../../evals/external/terminal_bench/offline-artifacts.mjs';
import { OFFLINE_RUNTIME_SCHEMA } from '../../../evals/external/terminal_bench/offline-derivative.mjs';
import { hashTree } from '../../../evals/external/terminal_bench/verifier.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function removeFixture(root) {
  if (!fs.existsSync(root)) return;
  const open = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o700);
      for (const name of fs.readdirSync(current)) open(path.join(current, name));
    } else if (stat.isFile()) fs.chmodSync(current, 0o600);
  };
  open(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function runner(extra = '') {
  return `#!/bin/bash

# Install curl
apt-get update
apt-get install -y curl

# Install uv
curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh
source $HOME/.local/bin/env

# Check if we're in a valid working directory
if [ "$PWD" = "/" ]; then
    exit 1
fi
${extra}
uvx \\
  -p 3.13 \\
  -w pytest==8.4.1 \\
  -w pytest-json-ctrf==0.3.5 \\
  pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA

if [ $? -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
`;
}

function writeTask(root, name, sourceImage) {
  const task = path.join(root, name);
  fs.mkdirSync(path.join(task, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(task, 'solution'), { recursive: true });
  fs.writeFileSync(path.join(task, 'instruction.md'), `Repair ${name}.\n`);
  fs.writeFileSync(path.join(task, 'task.toml'), [
    `docker_image = "${sourceImage}"`,
    'cpus = 1',
    'memory = "2G"',
    'storage = "10G"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(task, 'tests', 'test_outputs.py'), `def test_${name.replaceAll('-', '_')}():\n    assert True\n`);
  fs.writeFileSync(path.join(task, 'tests', 'test.sh'), runner(name === 'cancel-async-tasks' ? '\ncp /tests/test.py /app/test.py\n' : ''), { mode: 0o755 });
  if (name === 'cancel-async-tasks') fs.writeFileSync(path.join(task, 'tests', 'test.py'), 'async def helper():\n    return True\n');
  fs.writeFileSync(path.join(task, 'solution', 'solve.sh'), '#!/bin/sh\ntrue\n', { mode: 0o755 });
  return task;
}

function writeRuntime(root) {
  const runtime = path.join(root, 'runtime');
  const site = path.join(runtime, 'lib', 'python3.13', 'site-packages');
  fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(site, 'pytest-8.4.1.dist-info'), { recursive: true });
  fs.mkdirSync(path.join(site, 'pytest_json_ctrf-0.3.5.dist-info'), { recursive: true });
  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  elf.writeUInt16LE(0x3e, 18);
  fs.writeFileSync(path.join(runtime, 'bin', 'python3'), elf, { mode: 0o555 });
  fs.writeFileSync(path.join(site, 'pytest-8.4.1.dist-info', 'METADATA'), 'Name: pytest\nVersion: 8.4.1\n');
  fs.writeFileSync(path.join(site, 'pytest_json_ctrf-0.3.5.dist-info', 'METADATA'), 'Name: pytest-json-ctrf\nVersion: 0.3.5\n');
  return runtime;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineer-offline-artifacts-'));
  t.after(() => removeFixture(root));
  const repoRoot = path.join(root, 'repo');
  const sourceRoot = path.join(root, 'source');
  const outputRoot = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(repoRoot, 'evals', 'external', 'terminal_bench'), { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  const requirements = path.join(repoRoot, 'evals', 'external', 'terminal_bench');
  fs.copyFileSync(new URL('../../../evals/external/terminal_bench/offline-verifier-requirements.in', import.meta.url), path.join(requirements, 'offline-verifier-requirements.in'));
  fs.copyFileSync(new URL('../../../evals/external/terminal_bench/offline-verifier-requirements.txt', import.meta.url), path.join(requirements, 'offline-verifier-requirements.txt'));
  const taskNames = ['cobol-modernization', 'cancel-async-tasks', 'git-leak-recovery', 'custom-memory-heap-crash'];
  const tasks = taskNames.map((task, index) => {
    const sourceImage = `fixture/${task}:v1`;
    const taskDir = writeTask(sourceRoot, task, sourceImage);
    return {
      task,
      role: index === 0 ? 'anchor' : 'candidate',
      taskChecksum: hashTree(taskDir),
      sandbox: {
        sourceImage,
        immutableImage: `fixture/${task}@sha256:${String(index + 1).repeat(64)}`,
        imageId: `sha256:${String(index + 1).repeat(64)}`,
        platform: 'linux/amd64',
        cpus: 1,
        memoryMb: 2048,
        storageMb: 10240,
      },
    };
  });
  const taskLock = {
    lockSchema: 3,
    taskHashAlgorithm: 'typed-tree-sha256-v1',
    datasetRef: 'terminal-bench@2.0',
    registryUrl: 'https://www.tbench.ai/benchmarks/terminal-bench-2',
    lockedAt: '2026-07-30',
    stampedFrom: 'fixture',
    tasks,
    verifier: { passingReward: 1 },
  };
  const runtimeDir = writeRuntime(root);
  const calls = [];
  const fixtureArchive = Buffer.from('fixture-pinned-archive');
  const fixturePython = Buffer.from('fixture-pinned-python');
  const pins = {
    ...PINNED_OFFLINE_INPUTS,
    source: { ...PINNED_OFFLINE_INPUTS.source, sha256: sha256(fixtureArchive) },
    python: { ...PINNED_OFFLINE_INPUTS.python, sha256: sha256(fixturePython) },
    expected: null,
  };
  const dependencies = {
    downloadPinned: async ({ artifact, destination }) => {
      calls.push(['download', artifact]);
      fs.writeFileSync(
        destination,
        artifact.kind === 'terminal-bench-source' ? fixtureArchive : fixturePython,
        { mode: 0o600, flag: 'wx' },
      );
    },
    materializePinnedInputs: ({ workspace }) => {
      calls.push(['materialize', workspace]);
      return { sourceRoot, runtimeSourceDir: runtimeDir };
    },
    pins,
  };
  return { root, repoRoot, sourceRoot, outputRoot, taskLock, runtimeDir, calls, dependencies, pins };
}

test('builds all four locked tasks into one content-addressed, explicitly non-leaderboard dataset', async (t) => {
  const input = fixture(t);
  const result = await buildOfflineTerminalBenchDataset({
    repoRoot: input.repoRoot,
    outputRoot: input.outputRoot,
    taskLock: input.taskLock,
  }, input.dependencies);

  assert.equal(path.basename(result.artifactDir), result.artifactId);
  assert.equal(result.attestation.schema, OFFLINE_DATASET_ATTESTATION);
  assert.equal(result.taskLock.datasetRef, `terminal-bench-derived-offline@${PINNED_OFFLINE_INPUTS.source.commit.slice(0, 12)}`);
  assert.equal(result.attestation.label, 'private-terminal-bench-derived-offline');
  assert.equal(result.attestation.publicLeaderboardEligible, false);
  assert.equal(result.attestation.networkRequiredAtTrial, false);
  assert.deepEqual(result.taskLock.tasks.map(({ task }) => task), input.taskLock.tasks.map(({ task }) => task));
  assert.deepEqual(input.calls.slice(0, 2), [
    ['download', input.pins.source],
    ['download', input.pins.python],
  ]);
  assert.equal(input.calls[2][0], 'materialize');
  assert.equal(fs.existsSync(path.join(result.datasetDir, 'cobol-modernization', 'tests', '.engineer-offline-verifier', 'bin', 'python3')), true);
  assert.doesNotMatch(fs.readFileSync(path.join(result.datasetDir, 'cobol-modernization', 'tests', 'test.sh'), 'utf8'), /apt-get|curl|uvx/);
  assert.equal(result.datasetTreeHash, hashTree(result.datasetDir),
    'the retained aggregate hash must describe the sealed published dataset');
  assert.equal(verifyOfflineTerminalBenchDataset({ artifactDir: result.artifactDir, expectedPins: input.pins }).ok, true);
  assert.equal(fs.readdirSync(input.outputRoot).length, 1, 'temporary build directories are removed');
});

test('attests exact source, Python, requirements, runtime, source assertions, and derivative bytes', async (t) => {
  const input = fixture(t);
  const result = await buildOfflineTerminalBenchDataset({
    repoRoot: input.repoRoot,
    outputRoot: input.outputRoot,
    taskLock: input.taskLock,
  }, input.dependencies);

  assert.deepEqual(result.attestation.source, input.pins.source);
  assert.deepEqual(result.attestation.python, input.pins.python);
  assert.equal(result.attestation.requirements.inputSha256, PINNED_OFFLINE_INPUTS.requirements.inputSha256);
  assert.equal(result.attestation.requirements.lockSha256, PINNED_OFFLINE_INPUTS.requirements.lockSha256);
  assert.equal(result.attestation.runtime.manifest.schema, OFFLINE_RUNTIME_SCHEMA);
  assert.match(result.attestation.runtime.treeHash, /^[a-f0-9]{64}$/);
  assert.match(result.taskLockHash, /^[a-f0-9]{64}$/);
  for (const task of result.attestation.tasks) {
    const original = input.taskLock.tasks.find((entry) => entry.task === task.task);
    assert.equal(task.sourceChecksum, original.taskChecksum);
    assert.equal(task.derivedChecksum, result.taskLock.tasks.find((entry) => entry.task === task.task).taskChecksum);
    assert.match(task.assertionInventoryHash, /^[a-f0-9]{64}$/);
    assert.notEqual(task.derivedChecksum, task.sourceChecksum);
  }
  assert.equal(sha256(fs.readFileSync(result.lockPath)), result.taskLockHash);
});

test('identical inputs produce the same content identity', async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const one = await buildOfflineTerminalBenchDataset({ repoRoot: first.repoRoot, outputRoot: first.outputRoot, taskLock: first.taskLock }, first.dependencies);
  const two = await buildOfflineTerminalBenchDataset({ repoRoot: second.repoRoot, outputRoot: second.outputRoot, taskLock: second.taskLock }, second.dependencies);
  assert.equal(one.artifactId, two.artifactId);
  assert.equal(one.taskLockHash, two.taskLockHash);
  assert.deepEqual(one.attestation, two.attestation);
});

test('fails closed on requirement lock, source task, materializer, and published artifact drift', async (t) => {
  const lockDrift = fixture(t);
  fs.appendFileSync(path.join(lockDrift.repoRoot, 'evals', 'external', 'terminal_bench', 'offline-verifier-requirements.txt'), '\n# drift\n');
  await assert.rejects(
    buildOfflineTerminalBenchDataset({ repoRoot: lockDrift.repoRoot, outputRoot: lockDrift.outputRoot, taskLock: lockDrift.taskLock }, lockDrift.dependencies),
    /requirements.*digest|lock.*drift/i,
  );
  assert.equal(fs.existsSync(lockDrift.outputRoot) ? fs.readdirSync(lockDrift.outputRoot).length : 0, 0);

  const sourceDrift = fixture(t);
  fs.appendFileSync(path.join(sourceDrift.sourceRoot, 'cobol-modernization', 'instruction.md'), 'drift');
  await assert.rejects(
    buildOfflineTerminalBenchDataset({ repoRoot: sourceDrift.repoRoot, outputRoot: sourceDrift.outputRoot, taskLock: sourceDrift.taskLock }, sourceDrift.dependencies),
    /source checksum mismatch/i,
  );

  const materializerFailure = fixture(t);
  await assert.rejects(
    buildOfflineTerminalBenchDataset(
      { repoRoot: materializerFailure.repoRoot, outputRoot: materializerFailure.outputRoot, taskLock: materializerFailure.taskLock },
      { ...materializerFailure.dependencies, materializePinnedInputs: () => { throw new Error('builder network refused'); } },
    ),
    /builder network refused/i,
  );
  assert.equal(fs.existsSync(materializerFailure.outputRoot) ? fs.readdirSync(materializerFailure.outputRoot).length : 0, 0);

  const published = fixture(t);
  const result = await buildOfflineTerminalBenchDataset({ repoRoot: published.repoRoot, outputRoot: published.outputRoot, taskLock: published.taskLock }, published.dependencies);
  fs.chmodSync(path.join(result.datasetDir, 'git-leak-recovery', 'instruction.md'), 0o644);
  fs.appendFileSync(path.join(result.datasetDir, 'git-leak-recovery', 'instruction.md'), 'drift');
  assert.throws(
    () => verifyOfflineTerminalBenchDataset({ artifactDir: result.artifactDir, expectedPins: published.pins }),
    /checksum|hash|drift/i,
  );
});

test('normalizes runtime links and hardlinks to immutable regular files', async (t) => {
  const input = fixture(t);
  const original = path.join(input.runtimeDir, 'bin', 'python3');
  const actual = path.join(input.runtimeDir, 'bin', 'python3.13');
  fs.renameSync(original, actual);
  fs.symlinkSync('python3.13', original);
  fs.linkSync(
    path.join(input.runtimeDir, 'lib', 'python3.13', 'site-packages', 'pytest-8.4.1.dist-info', 'METADATA'),
    path.join(input.runtimeDir, 'lib', 'python3.13', 'site-packages', 'pytest-8.4.1.dist-info', 'COPY'),
  );
  const result = await buildOfflineTerminalBenchDataset({ repoRoot: input.repoRoot, outputRoot: input.outputRoot, taskLock: input.taskLock }, input.dependencies);
  const embedded = path.join(result.datasetDir, 'cobol-modernization', 'tests', '.engineer-offline-verifier');
  assert.equal(fs.lstatSync(path.join(embedded, 'bin', 'python3')).isFile(), true);
  assert.equal(fs.lstatSync(path.join(embedded, 'bin', 'python3')).nlink, 1);
  assert.equal(fs.lstatSync(path.join(embedded, 'lib', 'python3.13', 'site-packages', 'pytest-8.4.1.dist-info', 'METADATA')).nlink, 1);
  assert.equal(fs.lstatSync(path.join(embedded, 'lib', 'python3.13', 'site-packages', 'pytest-8.4.1.dist-info', 'COPY')).nlink, 1);
  assert.equal(result.attestation.schema, OFFLINE_DATASET_ATTESTATION);
  assert.equal(result.taskLock.lockSchema, 3);
  assert.equal(result.attestation.taskLock.schema, OFFLINE_DATASET_LOCK);
});
