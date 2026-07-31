import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  validateTaskLock,
  verifyTaskAgainstLock,
  stampTaskLock,
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

test('the committed task-lock.json is structurally valid and pins the plan task', () => {
  const verdict = validateTaskLock(LOCK);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.equal(LOCK.datasetRef, 'terminal-bench@2.0');
  assert.equal(LOCK.task, 'cobol-modernization');
});

test('validateTaskLock names every missing field', () => {
  const verdict = validateTaskLock({ task: 'x' });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => /datasetRef/.test(e)));
  assert.ok(verdict.errors.some((e) => /verifier/.test(e)));
});

test('an unstamped lock fails task verification closed', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'task.yaml'), 'name: cobol-modernization');
  const verdict = verifyTaskAgainstLock(dir, { ...LOCK, taskChecksum: null });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not.*stamped|unpinned|no checksum/i);
});

test('stampTaskLock pins the task directory and verification then passes and detects tampering', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'task.yaml'), 'name: cobol-modernization');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'test_output.py'), 'def test(): pass');
  const stamped = stampTaskLock(dir, LOCK);
  assert.equal(stamped.taskChecksum, hashTree(dir));
  assert.equal(verifyTaskAgainstLock(dir, stamped).ok, true);
  fs.writeFileSync(path.join(dir, 'tests', 'test_output.py'), 'def test(): assert False');
  const tampered = verifyTaskAgainstLock(dir, stamped);
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /checksum/i);
});

test('buildHarborRunArgs uses real Harbor flags and anchors the job identity', () => {
  const args = buildHarborRunArgs({
    lock: LOCK,
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

test('buildHarborRunArgs can mount the harness bundle and pass agent environment variables', () => {
  const args = buildHarborRunArgs({
    lock: LOCK,
    agentRef: 'evals.external.terminal_bench.harbor_agent:StdioBridgeAgent',
    model: 'moonshotai/kimi-k2.7-code',
    envName: 'docker',
    jobName: 'j',
    jobsDir: '/w/jobs',
    mounts: [{ source: '/w/harness-bundle', target: '/opt/harness-bundle', readOnly: true }],
    agentEnv: { HARNESS_EVAL_TB_CONDITION: '/w/generic.json', OPENROUTER_API_KEY: 'k' },
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('--mounts'), 'bundle mount must reach harbor');
  assert.ok(args.includes('--ae') && joined.includes('HARNESS_EVAL_TB_CONDITION=/w/generic.json'));
  assert.ok(joined.includes('OPENROUTER_API_KEY=k'));
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
  const verifierDir = path.join(job, 'trial-0', 'artifacts', 'logs', 'verifier');
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
