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
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { collectVerifierEvidence, hashTree, verdictFromReward } from './verifier.mjs';

const REQUIRED_LOCK_FIELDS = ['lockSchema', 'taskHashAlgorithm', 'datasetRef', 'verifier'];
const TASK_HASH_ALGORITHM = 'typed-tree-sha256-v1';
const ALLOWED_AGENT_ENV_KEYS = new Set([
  'HARNESS_EVAL_TB_CONDITION',
  'HARNESS_EVAL_TB_TELEMETRY_FILE',
  'HARNESS_EVAL_HOST_NODE',
  'HARNESS_EVAL_HOST_NODE_SHA256',
]);
const SAFE_TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SHA256_ID = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/-]*@sha256:[a-f0-9]{64}$/;

function validateSandboxLock(sandbox, task, errors) {
  if (sandbox == null) {
    errors.push(`tasks[] sandbox for ${task} is required by lockSchema 3`);
    return;
  }
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) {
    errors.push(`tasks[] sandbox for ${task} must be an object`);
    return;
  }
  if (typeof sandbox.sourceImage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(sandbox.sourceImage)) {
    errors.push(`tasks[] sandbox sourceImage for ${task} is invalid`);
  }
  if (typeof sandbox.immutableImage !== 'string' || !IMMUTABLE_IMAGE.test(sandbox.immutableImage)) {
    errors.push(`tasks[] sandbox immutableImage for ${task} must be digest-qualified`);
  }
  if (typeof sandbox.imageId !== 'string' || !SHA256_ID.test(sandbox.imageId)) {
    errors.push(`tasks[] sandbox imageId for ${task} must be a sha256 image ID`);
  }
  if (sandbox.platform !== 'linux/amd64') {
    errors.push(`tasks[] sandbox platform for ${task} must be linux/amd64`);
  }
  for (const field of ['cpus', 'memoryMb', 'storageMb']) {
    if (!Number.isInteger(sandbox[field]) || sandbox[field] <= 0) {
      errors.push(`tasks[] sandbox ${field} for ${task} must be a positive integer`);
    }
  }
}

function isSafeTaskName(value) {
  return typeof value === 'string' && SAFE_TASK_NAME.test(value);
}

function assertSafeTaskName(value) {
  if (!isSafeTaskName(value)) throw new TypeError('Harbor task name must be a safe basename');
}

function assertSafeArgument(value, field) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.startsWith('-')) {
    throw new TypeError(`Harbor ${field} must be a non-empty NUL-free string that does not begin with -`);
  }
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
  if (lock?.lockSchema != null && lock.lockSchema !== 3) errors.push(`lockSchema must be 3, got: ${lock.lockSchema}`);
  if (lock?.taskHashAlgorithm != null && lock.taskHashAlgorithm !== TASK_HASH_ALGORITHM) {
    errors.push(`taskHashAlgorithm must be ${TASK_HASH_ALGORITHM}`);
  }
  if (!tasks.length) errors.push('missing required lock field: tasks (or legacy task)');
  const taskNames = new Set();
  for (const entry of tasks) {
    if (!entry || typeof entry !== 'object' || !entry.task) errors.push('every tasks[] entry needs a task name');
    else if (!isSafeTaskName(entry.task)) errors.push('every tasks[] task name must be a safe basename');
    else {
      if (taskNames.has(entry.task)) errors.push(`tasks[] task names must be unique: ${entry.task}`);
      taskNames.add(entry.task);
      if (!SHA256_HEX.test(String(entry.taskChecksum ?? ''))) {
        errors.push(`tasks[] taskChecksum for ${entry.task} must be a SHA-256 digest`);
      }
      validateSandboxLock(entry.sandbox, entry.task, errors);
    }
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
 * Return a schema-3 typed-tree copy of the lock with the named task pinned to the given
 * directory's checksum. An unknown task name is appended as a candidate;
 * existing entries (including a legacy single-task lock's anchor) are updated
 * in place.
 */
export function stampTaskLock(taskDir, lock, taskName = tasksOf(lock)[0]?.task, { sandbox = null } = {}) {
  assertSafeTaskName(taskName);
  const checksum = hashTree(taskDir);
  const tasks = tasksOf(lock).map((entry) => (entry.task === taskName ? { ...entry, taskChecksum: checksum } : entry));
  if (!tasks.some((entry) => entry.task === taskName)) {
    const sandboxErrors = [];
    validateSandboxLock(sandbox, taskName, sandboxErrors);
    if (sandboxErrors.length) {
      throw new Error(`a new schema-3 task requires a valid sandbox lock: ${sandboxErrors.join('; ')}`);
    }
    tasks.push({ task: taskName, taskChecksum: checksum, role: 'candidate', sandbox: structuredClone(sandbox) });
  }
  const { task: _legacyTask, taskChecksum: _legacyChecksum, ...rest } = lock;
  return { ...rest, lockSchema: 3, taskHashAlgorithm: TASK_HASH_ALGORITHM, tasks };
}

/** Fail closed: an unstamped entry or a drifted task tree both refuse the run. */
export function verifyTaskAgainstLock(taskDir, lock, taskName = tasksOf(lock)[0]?.task) {
  if (!isSafeTaskName(taskName)) return { ok: false, reason: 'task name must be a safe basename', checksum: null };
  const entry = tasksOf(lock).find((t) => t.task === taskName);
  if (!entry) return { ok: false, reason: `task ${taskName} is not in the pinned lock`, checksum: null };
  if (!entry.taskChecksum) {
    return { ok: false, reason: `task ${taskName} is not stamped (taskChecksum is null) — run stampTaskLock against the pinned task`, checksum: null };
  }
  const structural = validateTaskLock(lock);
  if (!structural.ok) return { ok: false, reason: structural.errors.join('; '), checksum: null };
  let checksum;
  try {
    checksum = hashTree(taskDir);
  } catch (error) {
    const reasonHash = crypto.createHash('sha256').update(String(error?.message ?? error)).digest('hex').slice(0, 16);
    return {
      ok: false,
      reason: `task ${taskName} cannot be attested: TASK_TREE_ATTESTATION_FAILURE (detail sha256:${reasonHash})`,
      checksum: null,
    };
  }
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
  const lockVerdict = validateTaskLock(lock);
  if (!lockVerdict.ok) {
    throw new Error(`Harbor task lock is invalid: ${lockVerdict.errors.join('; ')}`);
  }
  assertSafeArgument(agentRef, 'agentRef');
  assertSafeArgument(model, 'model');
  assertSafeArgument(envName, 'envName');
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
  const taskEntry = tasksOf(lock).find((entry) => entry.task === task);
  if (!taskEntry) throw new Error(`Harbor task ${task} is not in the pinned lock`);
  const sandbox = taskEntry.sandbox;
  const resourceArgs = [
    '--override-cpus', String(sandbox.cpus),
    '--override-memory-mb', String(sandbox.memoryMb),
    '--override-storage-mb', String(sandbox.storageMb),
  ];
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
    ...resourceArgs,
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

function processGroupAbsent(pid, killImpl = process.kill, psImpl = spawnSync) {
  try {
    killImpl(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    if (
      error?.code !== 'EPERM' || process.platform === 'win32' ||
      (psImpl === spawnSync && !fs.existsSync('/bin/ps'))
    ) return false;
    // macOS can return EPERM for a just-reaped negative process group. Treat
    // that race as complete only when an independent absolute-path census
    // proves that no process retains the Harbor PGID.
    const census = psImpl('/bin/ps', ['-axo', 'pid=,pgid='], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (census.status !== 0 || census.error || typeof census.stdout !== 'string') return false;
    return !census.stdout.split('\n').some((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      return match && Number(match[2]) === pid;
    });
  }
}

function containSpawnGroup(pid, killImpl = process.kill, psImpl = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return false;
  try {
    killImpl(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    if (error?.code === 'EPERM' && processGroupAbsent(pid, killImpl, psImpl)) return true;
    return false;
  }
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let pass = 0; pass < 100; pass += 1) {
    if (processGroupAbsent(pid, killImpl, psImpl)) return true;
    Atomics.wait(sleeper, 0, 0, 2);
  }
  return false;
}

/** Run one attested Harbor executable in a dedicated, always-cleaned group. */
export function runHarbor({ executable, args, cwd, spawnImpl = spawnSync, timeoutMs, spawnEnv, killImpl = process.kill, psImpl = spawnSync }) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
    return { code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'UNATTESTED_EXECUTABLE', containmentComplete: false };
  }
  const res = spawnImpl(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    detached: process.platform !== 'win32',
    env: spawnEnv ?? {},
  });
  const containmentComplete = Number.isInteger(res.pid) && res.pid > 0
    ? containSpawnGroup(res.pid, killImpl, psImpl)
    : spawnImpl !== spawnSync && res.containmentComplete === true;
  return {
    code: res.status ?? null,
    signal: res.signal ?? null,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    timedOut: res.error?.code === 'ETIMEDOUT',
    spawnError: res.error && res.error.code !== 'ETIMEDOUT' ? res.error.code || res.error.message : null,
    containmentComplete,
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
      try {
        return { full, name: e.name, mtimeMs: fs.statSync(full).mtimeMs };
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return null;
        throw error;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
  return dirs.at(-1)?.full ?? null;
}

/** Verifier evidence + verdict for the (single) trial inside a job directory. */
export function readTrialResult(jobDir, { passingReward = 1 } = {}) {
  const evidence = collectVerifierEvidence(jobDir);
  return { ...evidence, verdict: verdictFromReward(evidence.reward, { passingReward }) };
}

/**
 * The grading trust boundary: harbor's `result.json` is written by the harbor
 * process on the HOST after the verifier phase. Only specific subdirectories
 * (verifier logs, agent logs, artifacts) are mounted into the sandbox — the
 * trial root and this record never are — so unlike the in-sandbox reward
 * files, the evaluated agent cannot forge it. Everything here fails closed:
 * missing, corrupt, non-numeric, or ambiguous records never grade.
 */
export function readHostVerifierReward(jobDir) {
  let entries;
  try {
    entries = fs.readdirSync(jobDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const trials = entries.filter((entry) => entry.isDirectory() && /__[A-Za-z0-9]+$/.test(entry.name));
  if (trials.length !== 1) return null; // one attempt per invocation; ambiguity never grades
  const file = path.join(jobDir, trials[0].name, 'result.json');
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const reward = record?.verifier_result?.rewards?.reward;
  if (typeof reward !== 'number' || !Number.isFinite(reward)) return null;
  return { reward, trialName: trials[0].name, source: 'harbor-host-result' };
}

/**
 * Classify a completed run. Returns the failure kind, or null for a valid
 * graded trial (whose pass/fail comes from the reward, not from here).
 * `jobDirCreated: false` means harbor produced no fresh job directory — the
 * run never really happened, whatever the exit code says.
 */
export function classifyFailure({ run, reward, providerFailure = false, jobDirCreated = true, passed = false }) {
  if (run.spawnError || run.timedOut) return 'infrastructure';
  if (run.containmentComplete !== true) return 'infrastructure';
  if (!jobDirCreated) return 'infrastructure';
  // A nonzero harbor exit is classified before any reward is trusted — a
  // reward file read out of a failed invocation is not evidence.
  if (run.signal != null || run.code !== 0) return 'infrastructure';
  // A verifier PASS is definitive even when a provider error ended the loop
  // afterwards (e.g. credits ran out during post-verification review). A
  // fail with a provider error is NOT definitive — the agent was cut short.
  if (providerFailure && !passed) return 'provider';
  if (reward == null) return 'verifier';
  return null;
}
