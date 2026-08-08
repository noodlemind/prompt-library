/**
 * The named-check config: loading, validating, and running one check.
 *
 * Extracted from lib/verify.mjs (Phase 3 prerequisite). These three functions
 * were private there, so `checks list/show/run` could not exist without either
 * duplicating them or reaching into another module's internals — and this file
 * already has four independent readers (verify, plan-readiness, the
 * require-plan-gate hook, and lookup's check resolver). A fifth private copy
 * would have made the drift worse, not better.
 *
 * Behavior is unchanged by the move: verify.mjs imports these rather than
 * defining them, so the execution path a check takes is the same one it took
 * before, including the legacy per-check status vocabulary.
 *
 * "Trusted check config" names the whole trust story today, and it is worth
 * being precise about how thin it is: the file lives in the repo under
 * `.github/`, so anyone who can commit can add an argv the harness executes
 * with the full environment and no containment. There is no signature, no
 * approval, and no trust record — the trust is "it came from the repo".
 * Making that word mean something is what Phase 3's `trust` command is for.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { runProcess } from './runner.mjs';

export const CHECKS_REL = '.github/harness/checks.yaml';

/** The complete schema a check entry accepts. Anything else is ignored. */
export const CHECK_TIMEOUT_DEFAULT_SECONDS = 600;
export const CHECK_TIMEOUT_MIN_SECONDS = 1;
export const CHECK_TIMEOUT_MAX_SECONDS = 3600;

/** Legacy per-check status vocabulary, preserved byte-for-byte from the
 * pre-runner spawnSync era. Distinct from the unified status vocabulary in
 * lib/envelope.mjs; `unifiedStatusForCheck` in verify.mjs is the only bridge. */
export const CHECK_STATUSES = Object.freeze(['passed', 'failed', 'timeout', 'unavailable']);

function resultCheck(id, status, message, extra = {}) {
  return { id, status, message, ...extra };
}

export function loadNamedChecks(workspace) {
  const full = path.join(workspace, CHECKS_REL);
  if (!fs.existsSync(full)) return { checks: null, error: `Trusted check config not found: ${CHECKS_REL}` };
  try {
    // maxAliasCount is a billion-laughs guard: the file is repo-authored, and
    // an alias bomb here would hang the process that reads it.
    const parsed = YAML.parse(fs.readFileSync(full, 'utf8'), { maxAliasCount: 50 });
    if (parsed?.version !== 1 || !parsed.checks || typeof parsed.checks !== 'object') {
      return { checks: null, error: `${CHECKS_REL} must declare version: 1 and checks` };
    }
    return { checks: parsed.checks, error: null };
  } catch (error) {
    return { checks: null, error: `Invalid ${CHECKS_REL}: ${error.message}` };
  }
}

export function validateCommand(name, config) {
  if (!config || !Array.isArray(config.command) || config.command.length === 0) {
    return `${name}.command must be a non-empty argv array`;
  }
  if (!config.command.every((part) => typeof part === 'string' && part.length > 0)) {
    return `${name}.command entries must be non-empty strings`;
  }
  const timeout = config.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < CHECK_TIMEOUT_MIN_SECONDS || timeout > CHECK_TIMEOUT_MAX_SECONDS) {
    return `${name}.timeout_seconds must be an integer from ${CHECK_TIMEOUT_MIN_SECONDS} to ${CHECK_TIMEOUT_MAX_SECONDS}`;
  }
  return null;
}

function trimOutput(value) {
  const text = String(value || '');
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…truncated…` : text;
}

/**
 * Run one named check through the async runner: timeout, optional
 * AbortSignal cancellation, and descendant-process termination.
 *
 * The legacy status vocabulary (`passed|failed|timeout|unavailable`) is
 * preserved byte-for-byte for every outcome the old spawnSync path could
 * produce. `runProcess`'s `cancelled` status is new — spawnSync had no
 * cancellation concept — and maps to `unavailable` here, carrying an explicit
 * `cancelled: true` marker so a consumer keys off structure rather than
 * pattern-matching the message text.
 */
export async function runNamedCheck(workspace, name, config, { signal, onStdout, onStderr } = {}) {
  const invalid = validateCommand(name, config);
  if (invalid) return resultCheck(name, 'unavailable', invalid);

  const timeoutSeconds = config.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS;
  const execution = await runProcess({
    argv: config.command,
    cwd: workspace,
    timeoutMs: timeoutSeconds * 1000,
    signal,
    onStdout,
    onStderr,
    maxBuffer: 1024 * 1024,
  });
  const output = { stdout: trimOutput(execution.stdout), stderr: trimOutput(execution.stderr), durationMs: execution.durationMs };

  if (execution.status === 'cancelled') {
    return resultCheck(name, 'unavailable', 'Cancelled — verification was interrupted', { ...output, cancelled: true });
  }
  if (execution.status === 'timed-out') {
    return resultCheck(name, 'timeout', `Timed out after ${timeoutSeconds}s`, output);
  }
  if (execution.status === 'failed' && execution.exitCode === null) {
    // Spawn-level failure (command not found) or death by an external signal
    // we did not ask for: no real exit code was ever reported.
    const detail = execution.signalName ? `Terminated by signal ${execution.signalName}` : 'Named check could not be spawned';
    return resultCheck(name, 'unavailable', detail, output);
  }
  if (execution.status === 'failed') {
    return resultCheck(name, 'failed', `Exited with status ${execution.exitCode}`, { ...output, exitCode: execution.exitCode });
  }
  return resultCheck(name, 'passed', 'Named check passed', { ...output, exitCode: 0 });
}
