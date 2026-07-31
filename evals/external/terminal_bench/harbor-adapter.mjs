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

const REQUIRED_LOCK_FIELDS = ['lockSchema', 'datasetRef', 'verifier'];
const ALLOWED_AGENT_ENV_KEYS = new Set([
  'HARNESS_EVAL_TB_CONDITION',
  'HARNESS_EVAL_TB_TELEMETRY_FILE',
  'HARNESS_EVAL_TB_NODE',
  'HARNESS_EVAL_TB_AGENT_MJS',
]);
const SAFE_TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function isSafeTaskName(value) {
  return typeof value === 'string' && SAFE_TASK_NAME.test(value);
}

function assertSafeTaskName(value) {
  if (!isSafeTaskName(value)) throw new TypeError('Harbor task name must be a safe basename');
}

function buildAgentEnvArgs(agentEnv) {
  const entries = Object.entries(agentEnv);
  for (const [key, value] of entries) {
    if (!ALLOWED_AGENT_ENV_KEYS.has(key)) {
      // Include the rejected key for diagnosis, but never its potentially
      // secret value. This check runs before the Harbor argv is assembled.
      throw new Error(`Harbor agent environment key is not allowed: ${key}`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new TypeError(`Harbor agent environment value must be a NUL-free string: ${key}`);
    }
  }
  return entries.flatMap(([key, value]) => ['--ae', `${key}=${value}`]);
}

/** The pinned task list, normalized: legacy single-task locks become one anchor entry. */
export function tasksOf(lock) {
  if (Array.isArray(lock?.tasks)) return lock.tasks;
  if (lock?.task) return [{ task: lock.task, taskChecksum: lock.taskChecksum ?? null, role: 'anchor' }];
  return [];
}

export function validateTaskLock(lock) {
  const errors = [];
  for (const field of REQUIRED_LOCK_FIELDS) {
    if (lock?.[field] == null) errors.push(`missing required lock field: ${field}`);
  }
  const tasks = tasksOf(lock);
  if (!tasks.length) errors.push('missing required lock field: tasks (or legacy task)');
  for (const entry of tasks) {
    if (!entry || typeof entry !== 'object' || !entry.task) errors.push('every tasks[] entry needs a task name');
    else if (!isSafeTaskName(entry.task)) errors.push('every tasks[] task name must be a safe basename');
  }
  if (lock?.datasetRef != null && !/^[\w./-]+@[\w.-]+$/.test(lock.datasetRef)) {
    errors.push(`datasetRef must pin a version (name@version), got: ${lock.datasetRef}`);
  }
  if (lock?.verifier != null && typeof lock.verifier.passingReward !== 'number') {
    errors.push('verifier.passingReward must be a number');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Return a schema-2 copy of the lock with the named task pinned to the given
 * directory's checksum. An unknown task name is appended as a candidate;
 * existing entries (including a legacy single-task lock's anchor) are updated
 * in place.
 */
export function stampTaskLock(taskDir, lock, taskName = tasksOf(lock)[0]?.task) {
  assertSafeTaskName(taskName);
  const checksum = hashTree(taskDir);
  const tasks = tasksOf(lock).map((entry) => (entry.task === taskName ? { ...entry, taskChecksum: checksum } : entry));
  if (!tasks.some((entry) => entry.task === taskName)) {
    tasks.push({ task: taskName, taskChecksum: checksum, role: 'candidate' });
  }
  const { task: _legacyTask, taskChecksum: _legacyChecksum, ...rest } = lock;
  return { ...rest, lockSchema: 2, tasks };
}

/** Fail closed: an unstamped entry or a drifted task tree both refuse the run. */
export function verifyTaskAgainstLock(taskDir, lock, taskName = tasksOf(lock)[0]?.task) {
  const structural = validateTaskLock(lock);
  if (!structural.ok) return { ok: false, reason: structural.errors.join('; '), checksum: null };
  if (!isSafeTaskName(taskName)) return { ok: false, reason: 'task name must be a safe basename', checksum: null };
  const entry = tasksOf(lock).find((t) => t.task === taskName);
  if (!entry) return { ok: false, reason: `task ${taskName} is not in the pinned lock`, checksum: null };
  if (!entry.taskChecksum) {
    return { ok: false, reason: `task ${taskName} is not stamped (taskChecksum is null) — run stampTaskLock against the pinned task`, checksum: null };
  }
  const checksum = hashTree(taskDir);
  if (checksum !== entry.taskChecksum) {
    return { ok: false, reason: `task ${taskName} checksum mismatch: expected ${entry.taskChecksum}, got ${checksum}`, checksum };
  }
  return { ok: true, reason: '', checksum };
}

// Flags verified against harbor 0.20.0 (src/harbor/cli/jobs.py):
// -i/--include-task-name filters tasks, -k/--n-attempts is attempts per trial,
// -n/--n-concurrent is CONCURRENCY, --job-name/-o/--jobs-dir pin the output
// identity, -y auto-confirms prompts.
export function buildHarborRunArgs({ lock, task = tasksOf(lock)[0]?.task, datasetPath, agentRef, model, envName, jobName, jobsDir, attempts = 1, mounts = [], agentEnv = {} }) {
  assertSafeTaskName(task);
  if (
    datasetPath !== undefined &&
    (typeof datasetPath !== 'string' || !datasetPath || datasetPath.includes('\0') || !path.isAbsolute(datasetPath))
  ) {
    throw new TypeError('datasetPath must be a non-empty absolute NUL-free string');
  }
  const agentEnvArgs = buildAgentEnvArgs(agentEnv);
  // Harbor treats -p and -d as alternative dataset selectors. A prepared
  // local tree is the stronger integrity boundary because registry bytes
  // cannot drift between lock verification and execution.
  const datasetArgs = datasetPath === undefined ? ['-d', lock.datasetRef] : ['-p', datasetPath];
  return [
    'run',
    ...datasetArgs,
    '--include-task-name',
    task,
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
    ...agentEnvArgs,
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
