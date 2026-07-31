/**
 * Harbor CLI adapter for the pinned Terminal-Bench release canary.
 *
 * The plan's rule is to use Harbor rather than re-implement Terminal-Bench
 * execution, so this module owns exactly the seams around the `harbor` CLI:
 *
 *   - task pinning: validate `task-lock.json`, stamp/verify the task tree
 *     checksum so a drifted or tampered task fails closed before any spend;
 *   - command construction: only flags evidenced by the Harbor docs
 *     (`run -d <dataset@version> --task-name <task> --agent <ref> --model
 *     <m> --env <docker|daytona> -n 1`);
 *   - process execution behind an injected spawn (deterministic in CI);
 *   - job/trial result discovery via the verifier evidence reader;
 *   - failure classification: infrastructure vs provider vs verifier vs a
 *     graded trial (a reward of 0 is a fail, not a failure).
 *
 * Jobs land in `<cwd>/jobs`, so callers control output placement by cwd
 * rather than by version-fragile CLI flags.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectVerifierEvidence, hashTree, verdictFromReward } from './verifier.mjs';

const REQUIRED_LOCK_FIELDS = ['lockSchema', 'datasetRef', 'task', 'verifier'];

export function validateTaskLock(lock) {
  const errors = [];
  for (const field of REQUIRED_LOCK_FIELDS) {
    if (lock?.[field] == null) errors.push(`missing required lock field: ${field}`);
  }
  if (lock?.datasetRef != null && !/^[\w./-]+@[\w.-]+$/.test(lock.datasetRef)) {
    errors.push(`datasetRef must pin a version (name@version), got: ${lock.datasetRef}`);
  }
  if (lock?.verifier != null && typeof lock.verifier.passingReward !== 'number') {
    errors.push('verifier.passingReward must be a number');
  }
  return { ok: errors.length === 0, errors };
}

/** Return a copy of the lock pinned to the given task directory's checksum. */
export function stampTaskLock(taskDir, lock) {
  return { ...lock, taskChecksum: hashTree(taskDir) };
}

/** Fail closed: an unstamped lock or a drifted task tree both refuse the run. */
export function verifyTaskAgainstLock(taskDir, lock) {
  const structural = validateTaskLock(lock);
  if (!structural.ok) return { ok: false, reason: structural.errors.join('; '), checksum: null };
  if (!lock.taskChecksum) {
    return { ok: false, reason: 'task lock is not stamped (taskChecksum is null) — run stampTaskLock against the pinned task', checksum: null };
  }
  const checksum = hashTree(taskDir);
  if (checksum !== lock.taskChecksum) {
    return { ok: false, reason: `task checksum mismatch: expected ${lock.taskChecksum}, got ${checksum}`, checksum };
  }
  return { ok: true, reason: '', checksum };
}

// Flags verified against harbor 0.20.0 (src/harbor/cli/jobs.py):
// -i/--include-task-name filters tasks, -k/--n-attempts is attempts per trial,
// -n/--n-concurrent is CONCURRENCY, --job-name/-o/--jobs-dir pin the output
// identity, -y auto-confirms prompts.
export function buildHarborRunArgs({ lock, agentRef, model, envName, jobName, jobsDir, attempts = 1, mounts = [], agentEnv = {} }) {
  return [
    'run',
    '-d',
    lock.datasetRef,
    '--include-task-name',
    lock.task,
    '--agent',
    agentRef,
    '--model',
    model,
    '--env',
    envName,
    '--n-attempts',
    String(attempts),
    '--n-concurrent',
    '1',
    '-y',
    ...(jobName ? ['--job-name', jobName] : []),
    ...(jobsDir ? ['--jobs-dir', jobsDir] : []),
    ...(mounts.length ? ['--mounts', JSON.stringify(mounts)] : []),
    ...Object.entries(agentEnv).flatMap(([key, value]) => ['--ae', `${key}=${value}`]),
  ];
}

/** The deterministic job directory for an invocation that passed --job-name/--jobs-dir. */
export function jobDirFor({ jobsDir, jobName }) {
  return path.join(jobsDir, jobName);
}

/** Run the harbor CLI. `spawnImpl` mirrors spawnSync's contract for testability. */
export function runHarbor({ args, cwd, spawnImpl = spawnSync, timeoutMs, spawnEnv }) {
  const res = spawnImpl('harbor', args, { cwd, encoding: 'utf8', timeout: timeoutMs, ...(spawnEnv ? { env: spawnEnv } : {}) });
  return {
    code: res.status ?? null,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    timedOut: res.error?.code === 'ETIMEDOUT',
    spawnError: res.error && res.error.code !== 'ETIMEDOUT' ? res.error.code || res.error.message : null,
  };
}

/**
 * Newest job directory under `<cwd>/jobs`, by mtime then name. Pass the
 * directory names that existed BEFORE the run as `excludeNames` so a failed
 * harbor invocation can never be graded against a stale previous job.
 */
export function findLatestJobDir(jobsRoot, { excludeNames = [] } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(jobsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const stale = new Set(excludeNames);
  const dirs = entries
    .filter((e) => e.isDirectory() && !stale.has(e.name))
    .map((e) => {
      const full = path.join(jobsRoot, e.name);
      return { full, name: e.name, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
  return dirs.at(-1)?.full ?? null;
}

/** Verifier evidence + verdict for the (single) trial inside a job directory. */
export function readTrialResult(jobDir, { passingReward = 1 } = {}) {
  const evidence = collectVerifierEvidence(jobDir);
  return { ...evidence, verdict: verdictFromReward(evidence.reward, { passingReward }) };
}

/**
 * Classify a completed run. Returns the failure kind, or null for a valid
 * graded trial (whose pass/fail comes from the reward, not from here).
 * `jobDirCreated: false` means harbor produced no fresh job directory — the
 * run never really happened, whatever the exit code says.
 */
export function classifyFailure({ run, reward, providerFailure = false, jobDirCreated = true, passed = false }) {
  if (run.spawnError || run.timedOut) return 'infrastructure';
  if (!jobDirCreated) return 'infrastructure';
  // A nonzero harbor exit is classified before any reward is trusted — a
  // reward file read out of a failed invocation is not evidence.
  if (typeof run.code === 'number' && run.code !== 0) return 'infrastructure';
  // A verifier PASS is definitive even when a provider error ended the loop
  // afterwards (e.g. credits ran out during post-verification review). A
  // fail with a provider error is NOT definitive — the agent was cut short.
  if (providerFailure && !passed) return 'provider';
  if (reward == null) return 'verifier';
  return null;
}
