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
import { resolveConfig } from './config.mjs';
import { resolveControls } from './controls.mjs';
import { buildChildEnv } from './exec-policy.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';

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

/** The canonical spelling of a path, falling back to the resolved lexical form
 * when it does not exist — an audit record is worth writing either way. */
function canonicalPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
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
export async function runNamedCheck(workspace, name, config, { signal, onStdout, onStderr, copilotHome = null, events = null } = {}) {
  const invalid = validateCommand(name, config);
  if (invalid) return resultCheck(name, 'unavailable', invalid);

  const timeoutSeconds = config.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS;

  // A named check is the harness's most-travelled execution path, so the
  // controls it runs under have to be the SAME ones `exec` declares — a policy
  // that governs the new, rarely-used command while the common one runs
  // unconstrained is the "correct and unused seam" all over again.
  const home = copilotHome ?? resolveCopilotHome(null);
  const cfg = resolveConfig({ copilotHome: home, workspace, projectTrusted: isProjectTrusted({ workspace, copilotHome: home }) });
  // FAIL CLOSED, the same rule `exec` was taught in the phase-3 review. A
  // configuration with parse errors drops the offending key and falls back to
  // defaults — and the dropped key can be a control: `checks.env_allowlist`
  // defaults to false and `exec.network` to allow, so a file the operator
  // believed was tightening things could hand a named check the entire parent
  // environment and the network. An execute-class path must refuse a policy it
  // could not read rather than run under one it invented.
  if (cfg.errors.length) {
    return {
      status: 'unavailable',
      reason: 'refusing to run: the harness configuration has errors',
      hint: `run \`harness config validate\` — first error: ${cfg.errors[0]}`,
    };
  }
  // The environment is the one control NOT applied by default here, and the
  // reason is worth stating rather than hiding in a default. A named check only
  // runs after `trust approve`, which means someone decided to execute this
  // repository's code; once arbitrary code runs, an env allowlist is
  // defence-in-depth, not a boundary — that code can read ~/.aws/credentials
  // whatever the environment says. Turning it on by default would break every
  // check that legitimately needs a variable nobody enumerated, in exchange for
  // stopping an attacker who has an easier route. `checks.env_allowlist` gives
  // the operator the choice today; the default is the behavior checks have
  // always had.
  const allowlisted = cfg.values['checks.env_allowlist'] === true;
  const envReport = allowlisted ? buildChildEnv({ allow: cfg.values['exec.allow_env'] }) : null;

  const { controls, networkWrapper, degraded } = resolveControls({
    networkPolicy: cfg.values['exec.network'],
    environmentAllowlisted: allowlisted,
  });

  const execution = await runProcess({
    argv: [...networkWrapper, ...config.command],
    cwd: workspace,
    ...(envReport ? { env: envReport.env } : {}),
    timeoutMs: timeoutSeconds * 1000,
    signal,
    onStdout,
    onStderr,
    maxBuffer: 1024 * 1024,
  });

  // P3AC5: an execution audit for the checks path, in the same `exec` shape the
  // `exec`/`bash` commands use — so one query over the event log answers "what
  // did this harness run on my machine", rather than one query per surface.
  const sink = typeof events?.withCommand === 'function' ? events.withCommand('exec') : events;
  sink?.emit?.('exec', {
    result: execution.status === 'ok' ? 'pass' : 'fail',
    status: execution.status,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    exec: {
      shell: false,
      check: name,
      argv: config.command,
      // The canonical path, matching what `exec` records (its `resolveExecCwd`
      // resolves symlinks before containment). Two audit records of the same
      // directory must not differ by spelling, or an auditor grouping by cwd
      // sees two locations where there was one.
      cwd: canonicalPath(workspace),
      timeoutSeconds,
      env: envReport
        ? { allowed: envReport.allowed, droppedCount: envReport.dropped.length, refused: envReport.refused }
        : { inherited: true },
      signal: execution.signalName,
      truncated: execution.truncated,
      controls,
      degraded: degraded.map((c) => ({ id: c.id, declared: c.declared, realized: c.realized, reason: c.reason })),
    },
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
