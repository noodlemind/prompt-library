import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SECRET_FIELD = /(?:api[_-]?key|authorization|credential|password|secret|token)/i;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const CLEANUP_DEADLINE_MS = 60_000;
const CLEANUP_COMMAND_TIMEOUT_MS = 10_000;
const CLEANUP_ABSENCE_CONFIRMATIONS = 3;
const DAYTONA_CLI_ENV_ALLOWLIST = Object.freeze(new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'LC_TIME', 'LC_NUMERIC', 'LC_MONETARY', 'LC_COLLATE', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS',
  'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION', 'TERM', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'DAYTONA_API_URL', 'DAYTONA_API_KEY', 'DAYTONA_CONFIG_DIR', 'DAYTONA_CONFIG_FILE',
]));

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function positiveInteger(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function positiveMoney(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive finite number`);
  }
  return value;
}

function executionMode(value) {
  if (!['controlled-provider', 'zero-provider-canary'].includes(value)) {
    throw new TypeError('executionMode must be controlled-provider or zero-provider-canary');
  }
  return value;
}

function modeMoney(value, field, mode) {
  if (mode === 'zero-provider-canary') {
    if (value !== 0) throw new TypeError(`${field} must be zero in zero-provider-canary mode`);
    return value;
  }
  return positiveMoney(value, field);
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
  return value;
}

function safeAbsoluteExecutable(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw new TypeError('daytonaPath must be an absolute NUL-free executable path');
  }
  return value;
}

function parseJsonValue(text, label) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`${label} JSON is missing or oversized`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} JSON is malformed`);
  }
  return value;
}

function parseJsonObject(text, label) {
  const value = parseJsonValue(text, label);
  if (!isPlainObject(value)) throw new Error(`${label} JSON must be an object`);
  return value;
}

function containsSecretField(value, depth = 0) {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((entry) => containsSecretField(entry, depth + 1));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    SECRET_FIELD.test(key) || containsSecretField(entry, depth + 1)
  );
}

function sanitizedEvidence(value) {
  if (!isPlainObject(value) || containsSecretField(value)) {
    throw new Error('final evidence is malformed or contains a secret-bearing field');
  }
  if (typeof value.evidenceHash !== 'string' || !SHA256_HEX.test(value.evidenceHash)) {
    throw new Error('final evidence requires a SHA-256 evidenceHash');
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('final evidence is oversized');
  return structuredClone(value);
}

function commandFailure(label, result) {
  const detail = crypto.createHash('sha256')
    .update(String(result?.error?.message ?? result?.stderr ?? result?.stdout ?? result?.code ?? 'unknown'))
    .digest('hex')
    .slice(0, 16);
  return new Error(`${label} failed (detail sha256:${detail})`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactSandboxNotFound(result, sandboxId) {
  if (result?.code !== 1 || result?.stdout !== '' || typeof result?.stderr !== 'string' ||
      Buffer.byteLength(result.stderr) > 512) return false;
  const escaped = escapeRegExp(sandboxId);
  return new RegExp(
    `^time="[^"\\r\\n]{1,64}" level=fatal msg="Not Found: Sandbox with ID or name ${escaped} not found"\\n?$`
  ).test(result.stderr);
}

function exactSandboxDeletionTransition(observed, sandboxId, sandboxName) {
  if (!isPlainObject(observed) || observed.id !== sandboxId || typeof observed.name !== 'string' ||
      observed.state !== 'destroying' || observed.desiredState !== 'destroyed') return false;
  if (observed.name === sandboxName) return true;
  const match = new RegExp(
    `^DESTROYED_${escapeRegExp(sandboxName)}_[1-9][0-9]{12}$`,
  ).exec(observed.name);
  return match?.[0] === observed.name;
}

export function daytonaCliEnvironment(baseEnv = process.env) {
  if (baseEnv == null || typeof baseEnv !== 'object' || Array.isArray(baseEnv)) {
    throw new TypeError('Daytona CLI base environment must be an object');
  }
  const env = {};
  for (const name of DAYTONA_CLI_ENV_ALLOWLIST) {
    const value = baseEnv[name];
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 16 * 1024) continue;
    env[name] = value;
  }
  return env;
}

export function runDaytonaSessionCliCommand(
  file,
  args,
  { timeoutMs = 180_000, env = daytonaCliEnvironment() } = {},
  spawnImpl = spawnSync,
) {
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  const result = spawnImpl(file, args, {
    shell: false,
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true,
  });
  return {
    code: Number.isInteger(result.status) ? result.status : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function expectedLabels(
  releaseSha,
  trialId = null,
  mode = 'controlled-provider',
  allocationAttempt = null,
) {
  return {
    purpose: 'engineer-release-eval',
    'release-commit': releaseSha,
    'provider-secret': mode === 'zero-provider-canary' ? 'absent' : 'broker-only',
    ...(mode === 'zero-provider-canary' ? { 'execution-mode': mode } : {}),
    ...(trialId == null ? {} : { 'trial-id': trialId }),
    ...(allocationAttempt == null ? {} : { 'allocation-attempt': allocationAttempt }),
  };
}

function hasExpectedAllocationOwnership(allocation, expected) {
  if (!isPlainObject(allocation) || allocation.name !== expected.name ||
      typeof allocation.id !== 'string' || !SAFE_ID.test(allocation.id) ||
      !isPlainObject(allocation.labels)) return false;
  return Object.entries(expectedLabels(
    expected.releaseSha,
    expected.trialId ?? null,
    expected.executionMode ?? 'controlled-provider',
    expected.allocationAttempt ?? null,
  )).every(([key, value]) => allocation.labels[key] === value);
}

export function validateDaytonaAllocation(allocation, expected) {
  const errors = [];
  if (!isPlainObject(allocation)) return { ok: false, errors: ['allocation must be an object'] };
  const exact = (field, value) => {
    if (allocation[field] !== value) errors.push(`${field} must equal the approved value`);
  };
  if (typeof allocation.id !== 'string' || !SAFE_ID.test(allocation.id)) {
    errors.push('allocation id is missing or invalid');
  }
  exact('name', expected.name);
  exact('snapshot', expected.snapshot);
  exact('target', expected.target);
  exact('user', 'root');
  exact('sandboxClass', 'container');
  exact('cpu', expected.cpu);
  // Daytona CLI v0.203 reports sandbox memory in GiB, matching the snapshot
  // creation flag and this controller's public topology option.
  exact('memory', expected.memoryGiB);
  exact('disk', expected.diskGiB);
  exact('public', false);
  if (allocation.state !== 'started' || (allocation.desiredState != null && allocation.desiredState !== 'started')) {
    errors.push('allocation must be started');
  }
  if (!isPlainObject(allocation.env) || Object.keys(allocation.env).length !== 0) {
    errors.push('allocation environment must be empty');
  }
  if (!Array.isArray(allocation.volumes) || allocation.volumes.length !== 0) {
    errors.push('allocation volumes must be empty');
  }
  const labels = allocation.labels;
  if (!isPlainObject(labels)) errors.push('allocation labels are missing');
  else {
    for (const [key, value] of Object.entries(expectedLabels(
      expected.releaseSha,
      expected.trialId ?? null,
      expected.executionMode ?? 'controlled-provider',
      expected.allocationAttempt ?? null,
    ))) {
      if (labels[key] !== value) errors.push(`allocation label ${key} is invalid`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function createDaytonaSessionController({
  daytonaPath,
  snapshot,
  target = 'us',
  cpu = 2,
  memoryGiB = 4,
  diskGiB = 10,
  ttlMinutes = 120,
  releaseSha,
  executionMode: executionModeInput,
  sessionBudgetUsd,
  runCommand = runDaytonaSessionCliCommand,
  provisionTrial = async () => null,
  randomBytes = crypto.randomBytes,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  deletePollAttempts = 100,
  deletePollIntervalMs = 500,
  expectedDaytonaVersion = 'v0.203.0',
  baseEnv = process.env,
} = {}) {
  const executable = safeAbsoluteExecutable(daytonaPath);
  safeId(snapshot, 'snapshot');
  if (!['us', 'eu'].includes(target)) throw new TypeError('target must be us or eu');
  if (cpu !== 2) throw new TypeError('cpu must be exactly 2 for the approved snapshot topology');
  if (memoryGiB !== 4) {
    throw new TypeError('memoryGiB must be exactly 4 for the approved snapshot topology');
  }
  if (diskGiB !== 10) throw new TypeError('diskGiB must be exactly 10 for the approved topology');
  positiveInteger(ttlMinutes, 'ttlMinutes', 240);
  if (typeof releaseSha !== 'string' || !/^[a-f0-9]{7,64}$/.test(releaseSha)) {
    throw new TypeError('releaseSha must be a hexadecimal commit identity');
  }
  const mode = executionMode(executionModeInput);
  modeMoney(sessionBudgetUsd, 'sessionBudgetUsd', mode);
  if (typeof runCommand !== 'function' || typeof provisionTrial !== 'function') {
    throw new TypeError('runCommand and provisionTrial must be functions');
  }
  positiveInteger(deletePollAttempts, 'deletePollAttempts', 100);
  if (deletePollAttempts < CLEANUP_ABSENCE_CONFIRMATIONS) {
    throw new TypeError(`deletePollAttempts must be at least ${CLEANUP_ABSENCE_CONFIRMATIONS}`);
  }
  positiveInteger(deletePollIntervalMs, 'deletePollIntervalMs', 60_000);
  if (typeof monotonicNow !== 'function') throw new TypeError('monotonicNow must be a function');
  if (typeof expectedDaytonaVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(expectedDaytonaVersion)) {
    throw new TypeError('expectedDaytonaVersion must be an exact semantic CLI version');
  }
  const cliEnv = daytonaCliEnvironment(baseEnv);

  let active = null;
  let finalized = false;
  let disposed = false;
  let disposalReceipt = null;
  let sequence = 0;
  const seenTrialIds = new Set();
  const receipts = [];
  const abortDeletions = new Map();
  let committedReservationUsd = 0;
  let versionVerified = false;

  async function invoke(args, label, options = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new TypeError('Daytona argv must be NUL-free strings');
    }
    const result = await runCommand(executable, args, { ...options, env: { ...cliEnv } });
    if (!result || result.code !== 0) throw commandFailure(label, result);
    return result;
  }

  function cleanupBudget() {
    let failure = null;
    const fail = (message) => {
      if (!failure) failure = new Error(message);
      throw failure;
    };
    const readClock = () => {
      if (failure) throw failure;
      let value;
      try {
        value = monotonicNow();
      } catch {
        fail('Daytona sandbox cleanup monotonic clock is unavailable');
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
          value > Number.MAX_SAFE_INTEGER - CLEANUP_DEADLINE_MS) {
        fail('Daytona sandbox cleanup monotonic clock returned an invalid value');
      }
      return value;
    };
    let lastObservedMs = readClock();
    const deadlineMs = lastObservedMs + CLEANUP_DEADLINE_MS;
    const remainingMs = () => {
      const observedMs = readClock();
      if (observedMs < lastObservedMs) {
        fail('Daytona sandbox cleanup monotonic clock moved backwards');
      }
      lastObservedMs = observedMs;
      const remaining = Math.floor(deadlineMs - observedMs);
      if (remaining < 1) fail('Daytona sandbox cleanup exceeded its 60-second monotonic deadline');
      return remaining;
    };
    return Object.freeze({
      assertActive() { remainingMs(); },
      commandTimeoutMs() { return Math.min(CLEANUP_COMMAND_TIMEOUT_MS, remainingMs()); },
      waitMs() { return Math.min(deletePollIntervalMs, remainingMs()); },
      failure() { return failure; },
    });
  }

  async function runCleanupCommand(args, budget) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new TypeError('Daytona argv must be NUL-free strings');
    }
    const options = { timeoutMs: budget.commandTimeoutMs(), env: { ...cliEnv } };
    try {
      const result = await runCommand(executable, args, options);
      budget.assertActive();
      return result;
    } catch (error) {
      budget.assertActive();
      throw error;
    }
  }

  async function waitForCleanup(budget) {
    const waitMs = budget.waitMs();
    if (waitMs > 0) await sleep(waitMs);
    budget.assertActive();
  }

  async function deleteAndConfirm(trial) {
    const cleanupIdentity = trial.cleanupIdentity;
    if (!isPlainObject(cleanupIdentity) || !SAFE_ID.test(String(cleanupIdentity.id ?? '')) ||
        cleanupIdentity.name !== trial.name || !/^[a-f0-9]{32}$/.test(String(trial.allocationAttempt ?? ''))) {
      throw new Error('Daytona cleanup identity is unavailable');
    }
    const budget = cleanupBudget();
    const platformEvidence = crypto.createHash('sha256')
      .update('engineer-eval/daytona-deletion-evidence/v2\0')
      .update(trial.name);
    let cleanupTarget = cleanupIdentity.observed === true ? cleanupIdentity.id : null;
    let absenceProvenWithoutResource = false;
    let reconciliationError = null;
    let reconciliationBudgetError = budget.failure();

    if (cleanupTarget == null) {
      let consecutiveAbsenceObservations = 0;
      for (let attempt = 0; attempt < deletePollAttempts; attempt += 1) {
        if (reconciliationBudgetError) break;
        try {
          const inspected = await runCleanupCommand(
            ['info', trial.name, '--format', 'json'],
            budget,
          );
          if (exactSandboxNotFound(inspected, trial.name)) {
            consecutiveAbsenceObservations += 1;
            platformEvidence.update(JSON.stringify({
              sandboxIdentity: trial.name,
              phase: 'ambiguous-create-reconciliation',
              status: 'not-found',
              cliExitCode: 1,
              confirmation: consecutiveAbsenceObservations,
            }));
            absenceProvenWithoutResource =
              consecutiveAbsenceObservations >= CLEANUP_ABSENCE_CONFIRMATIONS;
          } else if (inspected?.code === 0) {
            consecutiveAbsenceObservations = 0;
            const observed = parseJsonObject(inspected.stdout, 'Daytona ambiguous creation inspection');
            const expectedAllocation = {
              name: trial.name,
              snapshot,
              target,
              cpu,
              memoryGiB,
              diskGiB,
              releaseSha,
              trialId: trial.trialId,
              executionMode: mode,
              allocationAttempt: trial.allocationAttempt,
            };
            const verdict = validateDaytonaAllocation(observed, expectedAllocation);
            const owned = hasExpectedAllocationOwnership(observed, expectedAllocation);
            platformEvidence.update(JSON.stringify({
              id: observed.id ?? null,
              name: observed.name ?? null,
              phase: 'ambiguous-create-reconciliation',
              allocationOwned: owned,
              allocationValid: verdict.ok,
            }));
            if (!owned) {
              reconciliationError = new Error(
                'Daytona ambiguous creation ownership reconciliation failed; refusing deletion',
              );
              break;
            }
            cleanupIdentity.id = observed.id;
            cleanupIdentity.observed = true;
            cleanupTarget = observed.id;
          } else {
            consecutiveAbsenceObservations = 0;
            throw commandFailure('Daytona ambiguous creation reconciliation', inspected);
          }
        } catch (error) {
          consecutiveAbsenceObservations = 0;
          if (!reconciliationError) reconciliationError = error;
          reconciliationBudgetError = budget.failure();
        }
        if (cleanupTarget != null || absenceProvenWithoutResource) break;
        if (reconciliationBudgetError) break;
        if (attempt + 1 < deletePollAttempts) {
          try {
            await waitForCleanup(budget);
          } catch (error) {
            reconciliationBudgetError = budget.failure() ?? error;
            break;
          }
        }
      }
      if (cleanupTarget == null && !absenceProvenWithoutResource) {
        const base = reconciliationBudgetError?.message ?? reconciliationError?.message ??
          'Daytona ambiguous creation could not be reconciled';
        throw new Error(`${base}; sandbox deletion receipt is unavailable`);
      }
    }

    if (absenceProvenWithoutResource) {
      const observedAbsentAt = now().toISOString();
      return {
        sandboxId: null,
        sandboxName: trial.name,
        deleted: false,
        resourceAbsent: true,
        deletedAt: null,
        deletionRequestId: null,
        deletionRequestedAt: null,
        observedAbsentAt,
        platformEvidenceHash: platformEvidence
          .update('\0confirmed-never-observed\0')
          .update(observedAbsentAt)
          .digest('hex'),
      };
    }

    const deletionRequestedAt = now().toISOString();
    const deletionRequestId = crypto.createHash('sha256')
      .update('engineer-eval/daytona-delete/v1\0')
      .update(cleanupTarget)
      .update('\0')
      .update(deletionRequestedAt)
      .digest('hex')
      .slice(0, 32);
    platformEvidence.update('\0').update(deletionRequestId);
    let deleteError = null;
    try {
      const deleted = await runCleanupCommand(['delete', cleanupTarget], budget);
      if (!deleted || deleted.code !== 0) throw commandFailure('Daytona sandbox deletion', deleted);
    } catch (error) {
      deleteError = error;
    }
    let absent = false;
    let consecutiveAbsenceObservations = 0;
    let observationError = null;
    let integrityError = null;
    let budgetError = budget.failure();
    for (let attempt = 0; attempt < deletePollAttempts; attempt += 1) {
      if (budgetError) break;
      try {
        const inspected = await runCleanupCommand(
          ['info', cleanupTarget, '--format', 'json'],
          budget,
        );
        if (exactSandboxNotFound(inspected, cleanupTarget)) {
          consecutiveAbsenceObservations += 1;
          platformEvidence.update(JSON.stringify({
            sandboxIdentity: cleanupTarget,
            status: 'not-found',
            cliExitCode: 1,
            confirmation: consecutiveAbsenceObservations,
          }));
          absent = consecutiveAbsenceObservations >= CLEANUP_ABSENCE_CONFIRMATIONS;
        } else if (inspected?.code === 0) {
          consecutiveAbsenceObservations = 0;
          const observed = parseJsonObject(inspected.stdout, 'Daytona deletion inspection');
          platformEvidence.update(JSON.stringify({
            id: observed.id ?? null,
            name: observed.name ?? null,
            state: observed.state ?? null,
            desiredState: observed.desiredState ?? null,
          }));
          if (!exactSandboxDeletionTransition(observed, cleanupTarget, trial.name)) {
            integrityError = new Error('Daytona deletion inspection returned a mismatched sandbox identity');
            break;
          }
          if (cleanupIdentity.observed !== true) {
            cleanupIdentity.id = observed.id;
            cleanupIdentity.observed = true;
          }
          absent = false;
        } else {
          consecutiveAbsenceObservations = 0;
          throw commandFailure('Daytona sandbox deletion check', inspected);
        }
      } catch (error) {
        consecutiveAbsenceObservations = 0;
        if (!observationError) observationError = error;
        budgetError = budget.failure();
      }
      if (absent) break;
      if (budgetError) break;
      if (attempt + 1 < deletePollAttempts) {
        try {
          await waitForCleanup(budget);
        } catch (error) {
          budgetError = budget.failure() ?? error;
          break;
        }
      }
    }
    if (integrityError || !absent) {
      const base = integrityError?.message ?? budgetError?.message ?? observationError?.message ??
        deleteError?.message ?? 'Daytona sandbox deletion could not be confirmed';
      throw new Error(`${base}; sandbox deletion receipt is unavailable`);
    }
    const observedAbsentAt = now().toISOString();
    return {
      sandboxId: cleanupIdentity.id,
      sandboxName: trial.name,
      deleted: true,
      deletedAt: observedAbsentAt,
      deletionRequestId,
      deletionRequestedAt,
      observedAbsentAt,
      platformEvidenceHash: platformEvidence
        .update('\0confirmed-absent\0')
        .update(observedAbsentAt)
        .digest('hex'),
    };
  }

  async function beginTrial({ trialId, task, condition, reservedUsd }) {
    if (finalized) throw new Error('runtime session is finalized');
    if (disposed) throw new Error('runtime session is disposed');
    if (active) throw new Error('the per-trial topology permits only one active trial; execution is serial');
    safeId(trialId, 'trialId');
    safeId(task, 'task');
    if (!['generic', 'harness'].includes(condition)) throw new TypeError('condition must be generic or harness');
    modeMoney(reservedUsd, 'reservedUsd', mode);
    if (seenTrialIds.has(trialId)) throw new Error(`trialId was already used: ${trialId}`);
    if (committedReservationUsd + reservedUsd > sessionBudgetUsd + 1e-12) {
      throw new Error('trial reservation exceeds the external session budget');
    }
    if (!versionVerified) {
      const version = await invoke(['--version'], 'Daytona CLI version check');
      if (version.stderr !== '' || version.stdout !== `Daytona CLI version ${expectedDaytonaVersion}\n`) {
        throw new Error('Daytona CLI version does not match the reviewed runtime contract');
      }
      versionVerified = true;
    }

    sequence += 1;
    const nonce = randomBytes(16);
    if (!Buffer.isBuffer(nonce) || nonce.length !== 16) throw new Error('randomBytes must return exactly 16 bytes');
    const allocationAttempt = nonce.toString('hex');
    const name = `engineer-eval-${releaseSha.slice(0, 8)}-${sequence}-${allocationAttempt}`;
    const createArgs = [
      'create',
      '--name', name,
      '--snapshot', snapshot,
      '--user', 'root',
      '--target', target,
      '--auto-stop', '0',
      '--ttl', String(ttlMinutes),
      '--label', 'purpose=engineer-release-eval',
      '--label', `release-commit=${releaseSha}`,
      '--label', `provider-secret=${mode === 'zero-provider-canary' ? 'absent' : 'broker-only'}`,
      ...(mode === 'zero-provider-canary' ? ['--label', `execution-mode=${mode}`] : []),
      '--label', `trial-id=${trialId}`,
      '--label', `allocation-attempt=${allocationAttempt}`,
    ];
    const trial = {
      trialId,
      task,
      condition,
      reservedUsd,
      sequence,
      name,
      allocationAttempt,
      allocation: null,
      cleanupIdentity: { id: name, name, observed: false },
      readiness: null,
      cleanupPending: false,
    };
    let createAttempted = false;
    try {
      createAttempted = true;
      seenTrialIds.add(trialId);
      await invoke(createArgs, 'Daytona sandbox creation', { timeoutMs: 300_000 });
      const info = await invoke(['info', name, '--format', 'json'], 'Daytona sandbox inspection');
      const observed = parseJsonObject(info.stdout, 'Daytona allocation');
      const expectedAllocation = {
        name,
        snapshot,
        target,
        cpu,
        memoryGiB,
        diskGiB,
        releaseSha,
        trialId,
        executionMode: mode,
        allocationAttempt,
      };
      if (hasExpectedAllocationOwnership(observed, expectedAllocation)) {
        trial.cleanupIdentity = { id: observed.id, name, observed: true };
      }
      const verdict = validateDaytonaAllocation(observed, expectedAllocation);
      if (!verdict.ok) throw new Error(`Daytona allocation is invalid: ${verdict.errors.join('; ')}`);
      trial.allocation = observed;
      trial.readiness = await provisionTrial({
        allocation: structuredClone(observed),
        trial: { trialId, task, condition, reservedUsd, sequence },
      });
      active = trial;
      return {
        allocation: structuredClone(observed),
        readiness: structuredClone(trial.readiness),
        reservedUsd,
        sequence,
      };
    } catch (error) {
      if (createAttempted) {
        try {
          await deleteAndConfirm(trial);
        } catch (cleanupError) {
          trial.cleanupPending = true;
          trial.allocation = null;
          trial.readiness = null;
          active = trial;
          throw new AggregateError([error, cleanupError], 'trial provisioning failed and sandbox deletion was not confirmed');
        }
      }
      throw error;
    }
  }

  async function completeTrial({ trialId, evidence }) {
    safeId(trialId, 'trialId');
    if (disposed) throw new Error('runtime session is disposed');
    if (!active || active.trialId !== trialId) throw new Error('trial is not the active Daytona allocation');
    const trial = active;
    let retainedEvidence;
    let evidenceError = null;
    try {
      retainedEvidence = sanitizedEvidence(evidence);
    } catch (error) {
      evidenceError = error;
    }
    let deletion;
    try {
      deletion = await deleteAndConfirm(trial);
    } catch (error) {
      trial.cleanupPending = true;
      trial.allocation = null;
      trial.readiness = null;
      throw error;
    }
    active = null;
    const receipt = {
      trialId,
      sequence: trial.sequence,
      task: trial.task,
      condition: trial.condition,
      reservedUsd: trial.reservedUsd,
      evidenceHash: retainedEvidence?.evidenceHash ?? null,
      completed: evidenceError == null,
      ...deletion,
    };
    receipts.push(receipt);
    committedReservationUsd += trial.reservedUsd;
    if (evidenceError) throw evidenceError;
    return structuredClone(receipt);
  }

  async function abortTrial({ trialId, reason = 'aborted' }) {
    safeId(trialId, 'trialId');
    if (!active) {
      const prior = abortDeletions.get(trialId);
      if (prior) return structuredClone(prior);
      throw new Error('trial is not the active Daytona allocation');
    }
    if (active.trialId !== trialId) throw new Error('trial is not the active Daytona allocation');
    const trial = active;
    let deletion;
    try {
      deletion = await deleteAndConfirm(trial);
    } catch (error) {
      trial.cleanupPending = true;
      trial.allocation = null;
      trial.readiness = null;
      throw error;
    }
    active = null;
    const receipt = {
      trialId,
      sequence: trial.sequence,
      task: trial.task,
      condition: trial.condition,
      reservedUsd: 0,
      evidenceHash: null,
      completed: false,
      deleted: true,
      ...deletion,
      abortReasonHash: crypto.createHash('sha256').update(String(reason)).digest('hex'),
    };
    receipts.push(receipt);
    abortDeletions.set(trialId, structuredClone(deletion));
    return structuredClone(deletion);
  }

  async function dispose() {
    disposed = true;
    if (disposalReceipt) return structuredClone(disposalReceipt);
    if (!active) {
      disposalReceipt = {
        schema: 'daytona-controller-disposal.v1',
        disposed: true,
        activeTrialDeleted: false,
        deletion: null,
      };
      return structuredClone(disposalReceipt);
    }
    const trialId = active.trialId;
    const deletion = await abortTrial({ trialId, reason: 'Daytona controller disposed' });
    disposalReceipt = {
      schema: 'daytona-controller-disposal.v1',
      disposed: true,
      activeTrialDeleted: true,
      deletion,
    };
    return structuredClone(disposalReceipt);
  }

  function finalizeSession() {
    if (finalized) throw new Error('runtime session is already finalized');
    if (disposed) throw new Error('runtime session is disposed');
    if (active) throw new Error('cannot finalize a runtime session with an active trial');
    if (receipts.length === 0 || receipts.some((receipt) =>
      receipt.deleted !== true || !SHA256_HEX.test(String(receipt.evidenceHash ?? ''))
    )) {
      throw new Error('runtime session cannot finalize without complete ordered deletion receipts');
    }
    finalized = true;
    return {
      schema: 'daytona-session-deletion.v1',
      releaseSha,
      snapshot,
      executionMode: mode,
      deleted: true,
      reservedUsd: committedReservationUsd,
      finalizedAt: now().toISOString(),
      trials: structuredClone(receipts).sort((left, right) => left.sequence - right.sequence),
    };
  }

  function snapshotState() {
    return {
      releaseSha,
      snapshot,
      sessionBudgetUsd,
      reservedUsd: committedReservationUsd + (active?.reservedUsd ?? 0),
      finalized,
      disposed,
      activeTrial: active ? {
        trialId: active.trialId,
        sequence: active.sequence,
        sandboxId: active.cleanupIdentity?.id ?? null,
        sandboxName: active.name,
        reservedUsd: active.reservedUsd,
        cleanupPending: active.cleanupPending === true,
      } : null,
      receipts: structuredClone(receipts),
    };
  }

  return {
    beginTrial,
    completeTrial,
    abortTrial,
    dispose,
    finalizeSession,
    snapshot: snapshotState,
  };
}
