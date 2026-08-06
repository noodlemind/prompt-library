import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  validateTaskLock,
  verifyTaskAgainstLock,
  stampTaskLock,
  tasksOf,
  buildHarborRunArgs,
  buildHarborIsolatedTrialArgs,
  jobDirFor,
  runHarbor,
  findLatestJobDir,
  readTrialResult,
  readHostVerifierReward,
  classifyFailure,
} from '../external/terminal_bench/harbor-adapter.mjs';
import { hashTree } from '../external/terminal_bench/verifier.mjs';

const LOCK = JSON.parse(fs.readFileSync(new URL('../external/terminal_bench/task-lock.json', import.meta.url), 'utf8'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-adapter-'));
}

test('the committed task-lock.json is structurally valid and pins a task LIST', () => {
  const verdict = validateTaskLock(LOCK);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.equal(LOCK.datasetRef, 'terminal-bench@2.0');
  assert.equal(LOCK.lockSchema, 3);
  assert.equal(LOCK.taskHashAlgorithm, 'typed-tree-sha256-v1');
  const tasks = tasksOf(LOCK);
  assert.ok(Array.isArray(tasks) && tasks.length >= 1);
  assert.equal(tasks[0].task, 'cobol-modernization');
  assert.equal(tasks[0].role, 'anchor');
  assert.match(tasks[0].taskChecksum ?? '', /^[0-9a-f]{64}$/);
});

test('tasksOf falls back to a legacy single-task lock', () => {
  const legacy = { lockSchema: 1, datasetRef: 'terminal-bench@2.0', task: 'cobol-modernization', taskChecksum: 'abc', verifier: { passingReward: 1 } };
  assert.deepEqual(tasksOf(legacy), [{ task: 'cobol-modernization', taskChecksum: 'abc', role: 'anchor' }]);
});

test('validateTaskLock names every missing field', () => {
  const verdict = validateTaskLock({ task: 'x' });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => /datasetRef/.test(e)));
  assert.ok(verdict.errors.some((e) => /verifier/.test(e)));
});

test('validateTaskLock reports malformed task entries instead of throwing', () => {
  for (const entry of [null, 1, 'task']) {
    const verdict = validateTaskLock({ ...LOCK, tasks: [entry] });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((error) => /task name/.test(error)));
  }
});

test('schema-3 locks reject duplicate names, malformed checksums, and missing sandbox pins', () => {
  const duplicate = validateTaskLock({ ...LOCK, tasks: [LOCK.tasks[0], { ...LOCK.tasks[0] }] });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some((error) => /unique/i.test(error)));

  const malformed = validateTaskLock({
    ...LOCK,
    tasks: [{ ...LOCK.tasks[0], taskChecksum: 'not-a-digest' }],
  });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.errors.some((error) => /SHA-256/i.test(error)));

  const missingSandbox = validateTaskLock({
    ...LOCK,
    tasks: [{ ...LOCK.tasks[0], sandbox: null }],
  });
  assert.equal(missingSandbox.ok, false);
  assert.ok(missingSandbox.errors.some((error) => /sandbox.*required/i.test(error)));
});

test('task names are safe basenames and cannot traverse Harbor dataset or job paths', () => {
  for (const task of ['../escape', 'nested/task', '/absolute', '.', '..', 'line\nbreak', '-flag']) {
    const verdict = validateTaskLock({ ...LOCK, tasks: [{ task, taskChecksum: 'a'.repeat(64), role: 'candidate' }] });
    assert.equal(verdict.ok, false, task);
    assert.ok(verdict.errors.some((error) => /safe basename/.test(error)), task);
    assert.throws(
      () =>
        buildHarborRunArgs({
          lock: LOCK,
          task,
          agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
          model: 'moonshotai/kimi-k2.7-code',
          envName: 'docker',
        }),
      /safe basename/,
      task
    );
  }
});

test('an unstamped lock entry fails task verification closed', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'task.yaml'), 'name: cobol-modernization');
  const unstamped = {
    ...LOCK,
    tasks: [{ ...LOCK.tasks[0], taskChecksum: null }],
  };
  const verdict = verifyTaskAgainstLock(dir, unstamped);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not.*stamped|unpinned|no checksum/i);
});

test('stampTaskLock pins a named task entry; verification passes and detects tampering', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'task.yaml'), 'name: cobol-modernization');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'test_output.py'), 'def test(): pass');
  const stamped = stampTaskLock(dir, LOCK, 'cobol-modernization');
  assert.equal(tasksOf(stamped)[0].taskChecksum, hashTree(dir));
  assert.equal(verifyTaskAgainstLock(dir, stamped, 'cobol-modernization').ok, true);
  fs.writeFileSync(path.join(dir, 'tests', 'test_output.py'), 'def test(): assert False');
  const tampered = verifyTaskAgainstLock(dir, stamped, 'cobol-modernization');
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /checksum/i);
});

test('a copied task snapshot has the same typed attestation as its source', () => {
  const source = tmpdir();
  const copied = path.join(tmpdir(), 'copied-task');
  fs.mkdirSync(path.join(source, 'empty'));
  fs.mkdirSync(path.join(source, 'bin'));
  fs.writeFileSync(path.join(source, 'bin', 'verify.sh'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(source, 'bin', 'verify.sh'), 0o755);
  fs.cpSync(source, copied, { recursive: true, dereference: false, errorOnExist: true, force: false });

  const stamped = stampTaskLock(source, LOCK, 'cobol-modernization');
  assert.equal(hashTree(copied), hashTree(source));
  assert.equal(verifyTaskAgainstLock(copied, stamped, 'cobol-modernization').ok, true);

  fs.chmodSync(path.join(copied, 'bin', 'verify.sh'), 0o555);
  fs.chmodSync(path.join(copied, 'bin'), 0o555);
  fs.chmodSync(path.join(copied, 'empty'), 0o555);
  fs.chmodSync(copied, 0o555);
  assert.equal(hashTree(copied), hashTree(source), 'making the copy read-only must not create checksum drift');
  assert.equal(verifyTaskAgainstLock(copied, stamped, 'cobol-modernization').ok, true);
});

test('task verification fails closed when a tree cannot be safely attested', (t) => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'target'), 'content');
  try {
    fs.symlinkSync('target', path.join(dir, 'link'));
  } catch (error) {
    if (['EPERM', 'ENOSYS'].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`);
    throw error;
  }
  const pinned = {
    ...LOCK,
    tasks: [{ ...LOCK.tasks[0], taskChecksum: 'a'.repeat(64) }],
  };
  const verdict = verifyTaskAgainstLock(dir, pinned, 'cobol-modernization');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.checksum, null);
  assert.match(verdict.reason, /TASK_TREE_ATTESTATION_FAILURE.*sha256/i);
});

test('stampTaskLock can append a NEW task entry to the pinned list', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'main.c'), 'int main(){}');
  assert.throws(
    () => stampTaskLock(dir, LOCK, 'build-pmars'),
    /new schema-3 task requires a valid sandbox lock/i
  );
  const stamped = stampTaskLock(dir, LOCK, 'build-pmars', { sandbox: LOCK.tasks[0].sandbox });
  const entry = tasksOf(stamped).find((t) => t.task === 'build-pmars');
  assert.equal(entry.taskChecksum, hashTree(dir));
  assert.equal(entry.role, 'candidate');
  assert.equal(tasksOf(stamped)[0].task, 'cobol-modernization', 'existing entries are preserved');
});

test('buildHarborRunArgs uses real Harbor flags and anchors the job identity', () => {
  const args = buildHarborRunArgs({
    lock: LOCK,
    task: 'cobol-modernization',
    agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    model: 'moonshotai/kimi-k2.7-code',
    envName: 'daytona',
    jobName: 'canary-generic-1',
    jobsDir: '/work/jobs',
  });
  // Flags verified against harbor 0.20.0 (src/harbor/cli/jobs.py):
  // -i/--include-task-name filters tasks; -n means CONCURRENCY, not trials;
  // -k/--n-attempts is attempts; --job-name/-o pin the output identity.
  assert.deepEqual(args, [
    'run',
    '-d',
    'terminal-bench@2.0',
    '--include-task-name',
    'cobol-modernization',
    '--agent',
    'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    '--model',
    'moonshotai/kimi-k2.7-code',
    '--env',
    'daytona',
    '--n-attempts',
    '1',
    '--n-concurrent',
    '1',
    '--override-cpus',
    '1',
    '--override-memory-mb',
    '2048',
    '--override-storage-mb',
    '10240',
    '-y',
    '--job-name',
    'canary-generic-1',
    '--jobs-dir',
    '/work/jobs',
  ]);
});

test('buildHarborIsolatedTrialArgs pins one deterministic trial and Compose identity', () => {
  const args = buildHarborIsolatedTrialArgs({
    lock: LOCK,
    task: 'cobol-modernization',
    trialId: 'pair-1-repetition-1-generic-1',
    datasetPath: '/work/pinned-terminal-bench',
    agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    model: 'moonshotai/kimi-k2.7-code',
    envName: 'docker',
    jobName: 'canary-generic-1',
    jobsDir: '/work/jobs',
    mounts: [{ type: 'bind', source: '/work/runtime', target: '/opt/eval-runtime', read_only: true }],
    agentEnv: {
      HARNESS_EVAL_TB_CONDITION: '/work/generic.json',
      HARNESS_EVAL_TB_TELEMETRY_FILE: '/work/generic.done.json',
      HARNESS_EVAL_HOST_NODE: '/opt/node/bin/node',
      HARNESS_EVAL_HOST_NODE_SHA256: 'a'.repeat(64),
    },
  });
  const trialName = args[args.indexOf('--trial-name') + 1];
  assert.equal(
    args[args.indexOf('--extra-docker-compose') + 1],
    '/work/control/security-compose.json'
  );
  assert.match(trialName, /^engineer-[a-f0-9]{24}$/);
  assert.deepEqual(args.slice(0, 7), [
    'trial', 'start', '--path', '/work/pinned-terminal-bench/cobol-modernization',
    '--trial-name', trialName, '--trials-dir',
  ]);
  assert.equal(args[7], '/work/jobs/canary-generic-1');
  assert.deepEqual(args.slice(8, 20), [
    '--agent', 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    '--model', 'moonshotai/kimi-k2.7-code',
    '--env', 'docker',
    '--override-cpus', '1',
    '--override-memory-mb', '2048',
    '--override-storage-mb', '10240',
  ]);
  assert.equal(args.includes('--include-task-name'), false);
  assert.equal(args.includes('--n-attempts'), false);
  assert.equal(args.includes('-y'), false);
  assert.equal(args[args.indexOf('--mounts') + 1], JSON.stringify([
    { type: 'bind', source: '/work/runtime', target: '/opt/eval-runtime', read_only: true },
  ]));
});

test('isolated trial argv refuses caller-selected trial names, missing output identity, and traversal', () => {
  const valid = {
    lock: LOCK,
    task: 'cobol-modernization',
    trialId: 'pair-1-repetition-1-generic-1',
    datasetPath: '/work/pinned-terminal-bench',
    agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    model: 'moonshotai/kimi-k2.7-code',
    envName: 'docker',
    jobName: 'canary-generic-1',
    jobsDir: '/work/jobs',
  };
  for (const input of [
    { ...valid, trialName: 'caller-controlled' },
    { ...valid, trialId: '../escape' },
    { ...valid, datasetPath: 'relative' },
    { ...valid, jobName: '../escape' },
    { ...valid, jobsDir: '' },
  ]) {
    assert.throws(() => buildHarborIsolatedTrialArgs(input), /field|trial|dataset|job|absolute|safe/i);
  }
});

test('buildHarborRunArgs rejects malformed agent, model, and environment values before argv construction', () => {
  const valid = {
    lock: LOCK,
    task: 'cobol-modernization',
    agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    model: 'moonshotai/kimi-k2.7-code',
    envName: 'docker',
  };
  for (const field of ['agentRef', 'model', 'envName']) {
    for (const value of [null, 42, '', `bad\0${field}`, '--flag-like']) {
      assert.throws(
        () => buildHarborRunArgs({ ...valid, [field]: value }),
        new RegExp(field, 'i'),
        `${field}=${String(value)}`
      );
    }
  }
});

test('buildHarborRunArgs refuses missing or invalid sandbox resource locks', () => {
  for (const sandbox of [null, { ...LOCK.tasks[0].sandbox, cpus: 0 }]) {
    const invalidLock = {
      ...LOCK,
      tasks: [{ ...LOCK.tasks[0], sandbox }],
    };
    assert.throws(
      () => buildHarborRunArgs({
        lock: invalidLock,
        task: 'cobol-modernization',
        agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
        model: 'moonshotai/kimi-k2.7-code',
        envName: 'docker',
      }),
      /sandbox.*(?:required|cpus)|task lock is invalid/i
    );
  }
});

test('buildHarborRunArgs binds a prepared local dataset with -p instead of resolving registry bytes with -d', () => {
  const args = buildHarborRunArgs({
    lock: LOCK,
    task: 'cobol-modernization',
    datasetPath: '/work/pinned-terminal-bench',
    agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    model: 'moonshotai/kimi-k2.7-code',
    envName: 'docker',
  });
  assert.deepEqual(args.slice(0, 3), ['run', '-p', '/work/pinned-terminal-bench']);
  assert.equal(args.includes('-d'), false, 'local and registry dataset selectors are mutually exclusive');
  assert.ok(args.includes('--include-task-name'));
});

test('buildHarborRunArgs rejects an empty, relative, or NUL-bearing local dataset path', () => {
  for (const datasetPath of ['', 'relative/path', 'bad\0path']) {
    assert.throws(
      () =>
        buildHarborRunArgs({
          lock: LOCK,
          task: 'cobol-modernization',
          datasetPath,
          agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
          model: 'moonshotai/kimi-k2.7-code',
          envName: 'docker',
        }),
      /datasetPath/
    );
  }
});

test('buildHarborRunArgs can mount the harness bundle and pass only the bridge control variables', () => {
  const args = buildHarborRunArgs({
    lock: LOCK,
    task: 'cobol-modernization',
    agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    model: 'moonshotai/kimi-k2.7-code',
    envName: 'docker',
    jobName: 'j',
    jobsDir: '/w/jobs',
    mounts: [{ source: '/w/harness-bundle', target: '/opt/harness-bundle', readOnly: true }],
    agentEnv: {
      HARNESS_EVAL_TB_CONDITION: '/w/generic.json',
      HARNESS_EVAL_TB_TELEMETRY_FILE: '/w/generic.done.json',
      HARNESS_EVAL_HOST_NODE: '/opt/node/bin/node',
      HARNESS_EVAL_HOST_NODE_SHA256: 'a'.repeat(64),
    },
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('--mounts'), 'bundle mount must reach harbor');
  assert.ok(args.includes('--ae') && joined.includes('HARNESS_EVAL_TB_CONDITION=/w/generic.json'));
  assert.ok(joined.includes('HARNESS_EVAL_TB_TELEMETRY_FILE=/w/generic.done.json'));
  assert.ok(joined.includes('HARNESS_EVAL_HOST_NODE=/opt/node/bin/node'));
  assert.ok(joined.includes(`HARNESS_EVAL_HOST_NODE_SHA256=${'a'.repeat(64)}`));
});

test('buildHarborRunArgs rejects every non-control agent env key without echoing its value', () => {
  const sentinel = 'sentinel-openrouter-secret-do-not-persist';
  for (const key of [
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'SOME_TOKEN',
    'PASSWORD',
    'HARMLESS_BUT_UNKNOWN',
    'HARNESS_EVAL_TB_DRIVER_MODE',
  ]) {
    assert.throws(
      () =>
        buildHarborRunArgs({
          lock: LOCK,
          task: 'cobol-modernization',
          agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
          model: 'moonshotai/kimi-k2.7-code',
          envName: 'docker',
          agentEnv: { HARNESS_EVAL_TB_CONDITION: '/w/generic.json', [key]: sentinel },
        }),
      (error) => {
        assert.match(error.message, /agent environment key is not allowed/i);
        assert.ok(error.message.includes(key));
        assert.ok(!error.message.includes(sentinel), 'rejection errors must never echo secret values');
        return true;
      }
    );
  }
});

test('scripted canary selection is not representable in Harbor process environment arguments', () => {
  const args = buildHarborIsolatedTrialArgs({
    lock: LOCK,
    task: 'cobol-modernization',
    trialId: 'pair-1-repetition-1-runtime-canary-1',
    datasetPath: '/work/dataset',
    agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    model: 'scripted-canary-placeholder',
    envName: 'docker',
    jobName: 'controlled-cobol-runtime-canary',
    jobsDir: '/work/jobs',
    agentEnv: {
      HARNESS_EVAL_TB_CONDITION: '/engineer-bounded/work/control/condition.json',
      HARNESS_EVAL_TB_TELEMETRY_FILE: '/engineer-bounded/work/results/telemetry.json',
      HARNESS_EVAL_HOST_NODE: '/opt/node/bin/node',
      HARNESS_EVAL_HOST_NODE_SHA256: 'a'.repeat(64),
    },
  });
  assert.equal(args.some((value) => /driver.?mode|scripted-canary/i.test(value) && value !== 'scripted-canary-placeholder'), false);
  assert.ok(args.includes('HARNESS_EVAL_TB_CONDITION=/engineer-bounded/work/control/condition.json'));
});

test('buildHarborRunArgs rejects malformed control values before argv construction', () => {
  assert.throws(
    () =>
      buildHarborRunArgs({
        lock: LOCK,
        task: 'cobol-modernization',
        agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
        model: 'moonshotai/kimi-k2.7-code',
        envName: 'docker',
        agentEnv: { HARNESS_EVAL_TB_CONDITION: '/w/generic.json\0unsafe' },
      }),
    /NUL-free string/
  );
});

test('jobDirFor is the deterministic job identity — no newest-directory guessing needed', () => {
  assert.equal(jobDirFor({ jobsDir: '/work/jobs', jobName: 'canary-generic-1' }), path.join('/work/jobs', 'canary-generic-1'));
});

test('runHarbor uses the injected spawn and surfaces exit details', () => {
  let seen = null;
  const spawnImpl = (cmd, args, opts) => {
    seen = { cmd, args, opts };
    return { status: 0, stdout: 'done', stderr: '', containmentComplete: true };
  };
  const result = runHarbor({ executable: '/opt/pinned/harbor', args: ['run', '-d', 'x'], cwd: '/work', spawnImpl, timeoutMs: 1000 });
  assert.equal(seen.cmd, '/opt/pinned/harbor');
  assert.deepEqual(seen.args, ['run', '-d', 'x']);
  assert.equal(seen.opts.cwd, '/work');
  assert.equal(seen.opts.timeout, 1000);
  assert.equal(seen.opts.detached, process.platform !== 'win32');
  assert.deepEqual(seen.opts.env, {}, 'omitting spawnEnv must never inherit the ambient process environment');
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnError, null);
});

test('runHarbor preserves an explicit minimal spawn environment', () => {
  let seenEnv;
  const spawnEnv = { PATH: '/usr/bin:/bin', LANG: 'C' };
  runHarbor({
    executable: '/opt/pinned/harbor',
    args: ['--version'],
    cwd: '/work',
    spawnEnv,
    spawnImpl: (_cmd, _args, options) => {
      seenEnv = options.env;
      return { status: 0, stdout: '0.20.0', stderr: '', containmentComplete: true };
    },
  });
  assert.deepEqual(seenEnv, spawnEnv);
});

test('runHarbor always reaps the dedicated host process group', { skip: process.platform === 'win32' }, () => {
  const killed = [];
  let probeCount = 0;
  const result = runHarbor({
    executable: '/opt/pinned/harbor',
    args: ['run'],
    cwd: '/work',
    spawnImpl: () => ({ pid: 43210, status: 0, stdout: '', stderr: '' }),
    killImpl: (pid, signal) => {
      killed.push([pid, signal]);
      if (signal === 0 && ++probeCount === 2) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });

  assert.deepEqual(killed, [[-43210, 'SIGKILL'], [-43210, 0], [-43210, 0]]);
  assert.equal(result.containmentComplete, true);
});

test('runHarbor fails closed when its host process group does not disappear', { skip: process.platform === 'win32' }, () => {
  const result = runHarbor({
    executable: '/opt/pinned/harbor',
    args: ['run'],
    cwd: '/work',
    spawnImpl: () => ({ pid: 43210, status: 0, stdout: '', stderr: '' }),
    killImpl: () => {},
  });

  assert.equal(result.containmentComplete, false);
  assert.equal(classifyFailure({ run: result, reward: 1, jobDirCreated: true, passed: true }), 'infrastructure');
});

test('runHarbor proves an EPERM cleanup race with an injected process-group census independent of host /bin/ps', { skip: process.platform === 'win32' }, () => {
  const originalExistsSync = fs.existsSync;
  let censusCalls = 0;
  fs.existsSync = (candidate) => candidate === '/bin/ps' ? false : originalExistsSync(candidate);
  let result;
  try {
    result = runHarbor({
      executable: '/opt/pinned/harbor',
      args: ['run'],
      cwd: '/work',
      spawnImpl: () => ({ pid: 43210, status: 0, stdout: '', stderr: '' }),
      killImpl: () => { throw Object.assign(new Error('raced with reap'), { code: 'EPERM' }); },
      psImpl: () => {
        censusCalls += 1;
        return { status: 0, stdout: '  100  100\n  200  200\n', stderr: '' };
      },
    });
  } finally {
    fs.existsSync = originalExistsSync;
  }

  assert.equal(censusCalls, 1, 'the injected census must run even when the host path is absent');
  assert.equal(result.containmentComplete, true);
});

test('runHarbor keeps EPERM fail-closed when the process group still exists', { skip: process.platform === 'win32' }, () => {
  const result = runHarbor({
    executable: '/opt/pinned/harbor',
    args: ['run'],
    cwd: '/work',
    spawnImpl: () => ({ pid: 43210, status: 0, stdout: '', stderr: '' }),
    killImpl: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
    psImpl: () => ({ status: 0, stdout: '  999  43210\n', stderr: '' }),
  });

  assert.equal(result.containmentComplete, false);
});

test('runHarbor classifies a missing harbor binary and a timeout', () => {
  const enoent = runHarbor({ executable: '/opt/pinned/harbor', args: [], cwd: '.', spawnImpl: () => ({ status: null, error: Object.assign(new Error('nf'), { code: 'ENOENT' }) }) });
  assert.equal(enoent.spawnError, 'ENOENT');
  const timeout = runHarbor({ executable: '/opt/pinned/harbor', args: [], cwd: '.', spawnImpl: () => ({ status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }) });
  assert.equal(timeout.timedOut, true);
});

test('runHarbor retains terminating signals and never trusts their artifacts', () => {
  const signaled = runHarbor({
    executable: '/opt/pinned/harbor',
    args: [],
    cwd: '.',
    spawnImpl: () => ({
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      containmentComplete: true,
    }),
  });
  assert.equal(signaled.code, null);
  assert.equal(signaled.signal, 'SIGKILL');
  assert.equal(classifyFailure({ run: signaled, reward: 1, jobDirCreated: true, passed: true }), 'infrastructure');
});

test('findLatestJobDir picks the newest job directory', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '2026-07-30__10-00-00'));
  fs.mkdirSync(path.join(root, '2026-07-30__11-00-00'));
  fs.writeFileSync(path.join(root, 'not-a-dir.txt'), 'x');
  assert.equal(findLatestJobDir(root), path.join(root, '2026-07-30__11-00-00'));
  assert.equal(findLatestJobDir(path.join(root, 'missing')), null);
});

test('findLatestJobDir skips a job directory that disappears during stat', () => {
  const root = tmpdir();
  const stable = path.join(root, 'stable-job');
  const raced = path.join(root, 'raced-job');
  fs.mkdirSync(stable);
  fs.mkdirSync(raced);
  const originalStatSync = fs.statSync;
  let disappearanceCode = 'ENOENT';
  fs.statSync = function racedStatSync(candidate, ...args) {
    if (candidate === raced) throw Object.assign(new Error('removed during scan'), { code: disappearanceCode });
    return originalStatSync.call(this, candidate, ...args);
  };

  try {
    for (disappearanceCode of ['ENOENT', 'ENOTDIR']) {
      assert.equal(findLatestJobDir(root), stable, disappearanceCode);
    }
  } finally {
    fs.statSync = originalStatSync;
  }
});

test('findLatestJobDir fails closed when a candidate cannot be inspected', () => {
  const root = tmpdir();
  const stable = path.join(root, 'stable-job');
  const unreadable = path.join(root, 'unreadable-job');
  fs.mkdirSync(stable);
  fs.mkdirSync(unreadable);
  const originalStatSync = fs.statSync;
  let failureCode = 'EACCES';
  fs.statSync = function failedStatSync(candidate, ...args) {
    if (candidate === unreadable) throw Object.assign(new Error('cannot inspect candidate'), { code: failureCode });
    return originalStatSync.call(this, candidate, ...args);
  };

  try {
    for (failureCode of ['EACCES', 'EIO']) {
      assert.throws(
        () => findLatestJobDir(root),
        (error) => error?.code === failureCode,
        failureCode
      );
    }
  } finally {
    fs.statSync = originalStatSync;
  }
});

test('job discovery anchors to the current run and never grades a stale directory', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'stale-job'));
  assert.equal(findLatestJobDir(root, { excludeNames: ['stale-job'] }), null, 'no fresh job means no result');
  fs.mkdirSync(path.join(root, 'fresh-job'));
  assert.equal(findLatestJobDir(root, { excludeNames: ['stale-job'] }), path.join(root, 'fresh-job'));
});

test('a harbor exit without a fresh job directory is an infrastructure failure', () => {
  assert.equal(classifyFailure({ run: { spawnError: null, code: 3, timedOut: false }, reward: null, jobDirCreated: false }), 'infrastructure');
  assert.equal(
    classifyFailure({ run: { spawnError: null, code: 0, timedOut: false }, reward: null, jobDirCreated: false }),
    'infrastructure',
    'a clean exit that produced no job still is not a verifier failure'
  );
});

test('readHostVerifierReward grades from the host-written trial record only', () => {
  const job = tmpdir();
  const trial = path.join(job, 'cobol-modernization__abc1');
  fs.mkdirSync(trial, { recursive: true });
  fs.writeFileSync(path.join(trial, 'result.json'), JSON.stringify({ verifier_result: { rewards: { reward: 1 } } }));
  const graded = readHostVerifierReward(job);
  assert.equal(graded.reward, 1);
  assert.equal(graded.source, 'harbor-host-result');

  fs.writeFileSync(path.join(trial, 'result.json'), JSON.stringify({ verifier_result: { rewards: { reward: 'one' } } }));
  assert.equal(readHostVerifierReward(job), null, 'a non-numeric reward never grades');
  fs.writeFileSync(path.join(trial, 'result.json'), '{broken');
  assert.equal(readHostVerifierReward(job), null, 'a corrupt record never grades');
  fs.rmSync(path.join(trial, 'result.json'));
  assert.equal(readHostVerifierReward(job), null, 'a missing record never grades');
  fs.mkdirSync(path.join(job, 'cobol-modernization__abc2'));
  assert.equal(readHostVerifierReward(job), null, 'ambiguous trial identity never grades');
});

test('deterministic isolated trial directories support host reward and advisory evidence discovery', () => {
  const job = tmpdir();
  const trialId = 'pair-1-repetition-1-generic-1';
  const trialName = `engineer-${crypto.createHash('sha256').update(trialId).digest('hex').slice(0, 24)}`;
  const trial = path.join(job, trialName);
  const verifierDir = path.join(trial, 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  fs.writeFileSync(
    path.join(trial, 'result.json'),
    JSON.stringify({ verifier_result: { rewards: { reward: 1 } } })
  );
  fs.writeFileSync(path.join(verifierDir, 'test-stdout.txt'), '=== 2 passed in 0.42s ===\n');

  assert.deepEqual(readHostVerifierReward(job), {
    reward: 1,
    trialName,
    source: 'harbor-host-result',
  });
  const evidence = readTrialResult(job);
  assert.deepEqual(evidence.pytest, { passed: 2, failed: 0 });
  assert.match(evidence.treeHash, /^[a-f0-9]{64}$/);
  assert.equal(evidence.reward, null, 'agent-writable verifier artifacts remain advisory');

  fs.mkdirSync(path.join(job, `engineer-${'f'.repeat(24)}`));
  assert.equal(readHostVerifierReward(job), null, 'ambiguous deterministic trial identity never grades');
});

test('readTrialResult never grades agent-writable Harbor verifier rewards', () => {
  const job = tmpdir();
  const verifierDir = path.join(job, 'trial__fx0', 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  fs.writeFileSync(path.join(verifierDir, 'reward.json'), '{"reward": 1}');
  const result = readTrialResult(job);
  assert.equal(result.reward, null);
  assert.equal(result.rewardPath, null);
  assert.equal(result.verdict, 'fail');
  assert.match(result.degraded, /agent-writable/i);
});

test('classifyFailure distinguishes infrastructure, provider, verifier, and valid trials', () => {
  assert.equal(classifyFailure({ run: { spawnError: 'ENOENT', code: null, timedOut: false }, reward: null }), 'infrastructure');
  assert.equal(classifyFailure({ run: { spawnError: null, code: null, timedOut: true }, reward: null }), 'infrastructure');
  assert.equal(classifyFailure({ run: { spawnError: null, code: null, signal: null, timedOut: false }, reward: 1 }), 'infrastructure');
  assert.equal(classifyFailure({ run: { spawnError: null, code: 0, timedOut: false, containmentComplete: true }, reward: null, providerFailure: true }), 'provider');
  assert.equal(classifyFailure({ run: { spawnError: null, code: 0, timedOut: false, containmentComplete: true }, reward: null }), 'verifier');
  assert.equal(classifyFailure({ run: { spawnError: null, code: 0, timedOut: false, containmentComplete: true }, reward: 1 }), null);
  assert.equal(classifyFailure({ run: { spawnError: null, code: 0, timedOut: false, containmentComplete: true }, reward: 0 }), null, 'reward 0 is a graded fail, not an infrastructure failure');
});

test('a verified pass survives a trailing provider error; an interrupted fail does not', () => {
  const run = { spawnError: null, code: 0, timedOut: false, containmentComplete: true };
  assert.equal(
    classifyFailure({ run, reward: 1, providerFailure: true, passed: true }),
    null,
    'the pass happened before the provider error — it is definitive evidence'
  );
  assert.equal(
    classifyFailure({ run, reward: 0, providerFailure: true, passed: false }),
    'provider',
    'a fail cut short by the provider is not a graded fail'
  );
});

test('a nonzero harbor exit is classified before any reward is trusted', () => {
  assert.equal(classifyFailure({ run: { spawnError: null, code: 3, timedOut: false }, reward: null }), 'infrastructure');
  assert.equal(
    classifyFailure({ run: { spawnError: null, code: 1, timedOut: false }, reward: 1 }),
    'infrastructure',
    'a reward read out of a failed invocation is not evidence'
  );
});
