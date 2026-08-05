import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createTrialInputArchive, inspectTrialArchive } from '../../../evals/runtime/trial-archive.mjs';
import { buildZeroProviderCanaryTrialRequest } from '../../../evals/runtime/zero-provider-canary-request.mjs';
import {
  stampTaskLock,
  verifyTaskAgainstLock,
} from '../../../evals/external/terminal_bench/harbor-adapter.mjs';

const TASK_LOCK = JSON.parse(fs.readFileSync(
  new URL('../../../evals/external/terminal_bench/task-lock.json', import.meta.url),
  'utf8',
));
const TASK = TASK_LOCK.tasks[0];

function file(target, contents = 'fixture\n', mode = 0o600) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode });
}

function removeTree(root) {
  if (!fs.existsSync(root)) return;
  const restore = (current) => {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory()) return;
    fs.chmodSync(current, 0o700);
    for (const name of fs.readdirSync(current)) restore(path.join(current, name));
  };
  restore(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-provider-request-'));
  t.after(() => removeTree(root));
  fs.chmodSync(root, 0o700);
  const dataset = path.join(root, 'dataset');
  const task = path.join(dataset, TASK.task);
  fs.mkdirSync(task, { recursive: true, mode: 0o700 });
  file(path.join(task, 'instruction.md'), 'Modernize the COBOL service.\n', 0o444);
  const tests = path.join(task, 'tests');
  fs.mkdirSync(tests, { mode: 0o700 });
  file(path.join(tests, 'run.sh'), '#!/bin/sh\nexit 0\n', 0o555);
  fs.chmodSync(tests, 0o555);
  file(path.join(task, 'task.toml'), [
    '[environment]',
    `docker_image = "${TASK.sandbox.sourceImage}"`,
    `cpus = ${TASK.sandbox.cpus}`,
    `memory = "${TASK.sandbox.memoryMb / 1024}G"`,
    `storage = "${TASK.sandbox.storageMb / 1024}G"`,
    '',
  ].join('\n'), 0o444);
  const taskLock = stampTaskLock(task, TASK_LOCK, TASK.task);
  fs.chmodSync(task, 0o555);
  fs.chmodSync(dataset, 0o555);

  const bundle = path.join(root, 'bundle');
  for (const directory of ['node-x64', 'harness', 'bridge']) {
    fs.mkdirSync(path.join(bundle, directory), { recursive: true, mode: 0o700 });
  }
  for (const relative of [
    'node-x64/bin/node', 'harness/package.json', 'bridge/harbor_agent.py', 'bridge/agent.mjs',
    'evidence-probe', 'evidence-probe.mjs', 'bounded-exec', 'bounded-exec.mjs', 'harness-cli',
  ]) file(path.join(bundle, relative));
  file(path.join(bundle, 'condition-inputs.v1.json'), JSON.stringify({
    version: 'eval-condition-inputs.v1',
    sourceIdentity: { releaseSha: 'a'.repeat(40), harnessVersion: '1.0.0' },
    engineerRuntimeContract: 'Use the Engineer lifecycle.',
    guidancePrompt: 'Load guidance only when needed.',
    guidanceCatalog: {},
  }));
  const genericWork = path.join(root, 'generic-work');
  const harnessWork = path.join(root, 'harness-work');
  fs.mkdirSync(genericWork, { mode: 0o700 });
  fs.mkdirSync(harnessWork, { mode: 0o700 });
  return { root, dataset, bundle, taskLock, genericWork, harnessWork };
}

test('builds two archive-bound no-model requests with treatment-only Harness activation', (t) => {
  const fx = fixture(t);
  const previousUmask = process.umask(0o077);
  let generic;
  let harness;
  try {
    generic = buildZeroProviderCanaryTrialRequest({
      condition: 'generic',
      taskLock: fx.taskLock,
      taskId: TASK.task,
      datasetPath: fx.dataset,
      bundleDir: fx.bundle,
      workDir: fx.genericWork,
      trialId: 'zero-generic-r1',
    });
    harness = buildZeroProviderCanaryTrialRequest({
      condition: 'harness',
      taskLock: fx.taskLock,
      taskId: TASK.task,
      datasetPath: fx.dataset,
      bundleDir: fx.bundle,
      workDir: fx.harnessWork,
      trialId: 'zero-harness-r1',
    });
  } finally {
    process.umask(previousUmask);
  }

  for (const request of [generic, harness]) {
    assert.equal(request.trial.executionMode, 'zero-provider-canary');
    assert.equal(request.trial.ceilingUsd, 0);
    assert.equal(JSON.stringify(request).includes('OPENROUTER'), false);
    assert.equal(JSON.stringify(request).includes('providerUrl'), false);
    const conditionPath = request.harbor.args.find((value) =>
      value.startsWith('HARNESS_EVAL_TB_CONDITION=')).split('=')[1];
    const condition = JSON.parse(fs.readFileSync(conditionPath, 'utf8'));
    assert.equal(condition.id, request.trial.condition);
    assert.equal(condition.runtime.driverMode, 'scripted-canary');
    assert.equal(Object.hasOwn(condition, 'profileId'), false);
    assert.equal(Object.hasOwn(condition, 'apiKeyEnv'), false);
    const taskPath = request.harbor.args[request.harbor.args.indexOf('--path') + 1];
    assert.notEqual(path.dirname(taskPath), fx.dataset);
    assert.match(
      fs.readFileSync(path.join(taskPath, 'task.toml'), 'utf8'),
      new RegExp(`docker_image = "${TASK.sandbox.immutableImage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    );
    const archived = createTrialInputArchive(request);
    const inspected = inspectTrialArchive(archived.bytes, { kind: 'task-input' });
    assert.equal(inspected.document.trial.executionMode, 'zero-provider-canary');
    archived.bytes.fill(0);
  }

  assert.match(
    fs.readFileSync(path.join(fx.dataset, TASK.task, 'task.toml'), 'utf8'),
    new RegExp(`docker_image = "${TASK.sandbox.sourceImage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
  );
  assert.equal(
    verifyTaskAgainstLock(path.join(fx.dataset, TASK.task), fx.taskLock, TASK.task).ok,
    true,
  );
  assert.equal(fs.lstatSync(path.join(fx.dataset, TASK.task, 'task.toml')).mode & 0o777, 0o444);

  const genericMounts = JSON.parse(generic.harbor.args[generic.harbor.args.indexOf('--mounts') + 1]);
  const harnessMounts = JSON.parse(harness.harbor.args[harness.harbor.args.indexOf('--mounts') + 1]);
  assert.equal(genericMounts.some(({ target }) => target.startsWith('/opt/harness-bundle/')), false);
  assert.deepEqual(harnessMounts.slice(-2).map(({ target }) => target), [
    '/opt/harness-bundle/harness',
    '/opt/harness-bundle/harness-cli',
  ]);
  const harnessCondition = JSON.parse(fs.readFileSync(path.join(fx.harnessWork, 'condition.json'), 'utf8'));
  assert.ok(harnessCondition.setupCommands.some((command) => command.includes('/opt/harness-bundle/harness-cli')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.genericWork, 'condition.json'), 'utf8')).setupCommands, []);
});

test('rejects unknown fields, unsafe identities, mutable work roots, and missing bundle contracts', (t) => {
  const fx = fixture(t);
  const base = {
    condition: 'generic',
    taskLock: fx.taskLock,
    taskId: TASK.task,
    datasetPath: fx.dataset,
    bundleDir: fx.bundle,
    workDir: fx.genericWork,
    trialId: 'zero-generic-r1',
  };
  assert.throws(() => buildZeroProviderCanaryTrialRequest({ ...base, providerKey: 'forbidden' }), /unexpected/i);
  assert.throws(() => buildZeroProviderCanaryTrialRequest({ ...base, trialId: '../escape' }), /trialId/i);
  fs.chmodSync(fx.genericWork, 0o777);
  assert.throws(() => buildZeroProviderCanaryTrialRequest(base), /owner-only/i);
  fs.chmodSync(fx.genericWork, 0o700);
  fs.unlinkSync(path.join(fx.bundle, 'condition-inputs.v1.json'));
  assert.throws(() => buildZeroProviderCanaryTrialRequest(base), /condition inputs|unavailable|JSON/i);
});

test('rejects a task tree that drifted after the code-owned offline lock was stamped', (t) => {
  const fx = fixture(t);
  const instruction = path.join(fx.dataset, TASK.task, 'instruction.md');
  fs.chmodSync(instruction, 0o600);
  fs.appendFileSync(instruction, 'tampered\n');
  assert.throws(() => buildZeroProviderCanaryTrialRequest({
    condition: 'generic',
    taskLock: fx.taskLock,
    taskId: TASK.task,
    datasetPath: fx.dataset,
    bundleDir: fx.bundle,
    workDir: fx.genericWork,
    trialId: 'zero-generic-r1',
  }), /checksum|task tree|attest|drift/i);
});
