import assert from 'node:assert/strict';
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
  jobDirFor,
  runHarbor,
  findLatestJobDir,
  readTrialResult,
  classifyFailure,
} from '../../../evals/external/terminal_bench/harbor-adapter.mjs';
import { hashTree } from '../../../evals/external/terminal_bench/verifier.mjs';

const LOCK = JSON.parse(fs.readFileSync(new URL('../../../evals/external/terminal_bench/task-lock.json', import.meta.url), 'utf8'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-adapter-'));
}

test('the committed task-lock.json is structurally valid and pins a task LIST', () => {
  const verdict = validateTaskLock(LOCK);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.equal(LOCK.datasetRef, 'terminal-bench@2.0');
  assert.equal(LOCK.lockSchema, 2);
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
  const unstamped = { ...LOCK, tasks: [{ task: 'cobol-modernization', taskChecksum: null, role: 'anchor' }] };
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

test('stampTaskLock can append a NEW task entry to the pinned list', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'main.c'), 'int main(){}');
  const stamped = stampTaskLock(dir, LOCK, 'build-pmars');
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
    '-y',
    '--job-name',
    'canary-generic-1',
    '--jobs-dir',
    '/work/jobs',
  ]);
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
      HARNESS_EVAL_TB_NODE: '/opt/node/bin/node',
      HARNESS_EVAL_TB_AGENT_MJS: '/opt/bridge/agent.mjs',
    },
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('--mounts'), 'bundle mount must reach harbor');
  assert.ok(args.includes('--ae') && joined.includes('HARNESS_EVAL_TB_CONDITION=/w/generic.json'));
  assert.ok(joined.includes('HARNESS_EVAL_TB_TELEMETRY_FILE=/w/generic.done.json'));
  assert.ok(joined.includes('HARNESS_EVAL_TB_NODE=/opt/node/bin/node'));
  assert.ok(joined.includes('HARNESS_EVAL_TB_AGENT_MJS=/opt/bridge/agent.mjs'));
});

test('buildHarborRunArgs rejects every non-control agent env key without echoing its value', () => {
  const sentinel = 'sentinel-openrouter-secret-do-not-persist';
  for (const key of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'SOME_TOKEN', 'PASSWORD', 'HARMLESS_BUT_UNKNOWN']) {
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
    return { status: 0, stdout: 'done', stderr: '' };
  };
  const result = runHarbor({ args: ['run', '-d', 'x'], cwd: '/work', spawnImpl, timeoutMs: 1000 });
  assert.equal(seen.cmd, 'harbor');
  assert.deepEqual(seen.args, ['run', '-d', 'x']);
  assert.equal(seen.opts.cwd, '/work');
  assert.equal(seen.opts.timeout, 1000);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnError, null);
});

test('runHarbor classifies a missing harbor binary and a timeout', () => {
  const enoent = runHarbor({ args: [], cwd: '.', spawnImpl: () => ({ status: null, error: Object.assign(new Error('nf'), { code: 'ENOENT' }) }) });
  assert.equal(enoent.spawnError, 'ENOENT');
  const timeout = runHarbor({ args: [], cwd: '.', spawnImpl: () => ({ status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }) });
  assert.equal(timeout.timedOut, true);
});

test('findLatestJobDir picks the newest job directory', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '2026-07-30__10-00-00'));
  fs.mkdirSync(path.join(root, '2026-07-30__11-00-00'));
  fs.writeFileSync(path.join(root, 'not-a-dir.txt'), 'x');
  assert.equal(findLatestJobDir(root), path.join(root, '2026-07-30__11-00-00'));
  assert.equal(findLatestJobDir(path.join(root, 'missing')), null);
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

test('readTrialResult finds verifier evidence inside the job tree', () => {
  const job = tmpdir();
  const verifierDir = path.join(job, 'trial-0', 'verifier');
  fs.mkdirSync(verifierDir, { recursive: true });
  fs.writeFileSync(path.join(verifierDir, 'reward.json'), '{"reward": 1}');
  const result = readTrialResult(job);
  assert.equal(result.reward, 1);
  assert.equal(result.verdict, 'pass');
});

test('classifyFailure distinguishes infrastructure, provider, verifier, and valid trials', () => {
  assert.equal(classifyFailure({ run: { spawnError: 'ENOENT', code: null, timedOut: false }, reward: null }), 'infrastructure');
  assert.equal(classifyFailure({ run: { spawnError: null, code: null, timedOut: true }, reward: null }), 'infrastructure');
  assert.equal(classifyFailure({ run: { spawnError: null, code: 0, timedOut: false }, reward: null, providerFailure: true }), 'provider');
  assert.equal(classifyFailure({ run: { spawnError: null, code: 0, timedOut: false }, reward: null }), 'verifier');
  assert.equal(classifyFailure({ run: { spawnError: null, code: 0, timedOut: false }, reward: 1 }), null);
  assert.equal(classifyFailure({ run: { spawnError: null, code: 0, timedOut: false }, reward: 0 }), null, 'reward 0 is a graded fail, not an infrastructure failure');
});

test('a verified pass survives a trailing provider error; an interrupted fail does not', () => {
  const run = { spawnError: null, code: 0, timedOut: false };
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
