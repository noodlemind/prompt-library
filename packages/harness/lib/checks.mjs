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

export async function runNamedCheck(workspace, name, config, { signal, onStdout, onStderr, copilotHome = null, events = null } = {}) {
  const invalid = validateCommand(name, config);
  if (invalid) return resultCheck(name, 'unavailable', invalid);

  const timeoutSeconds = config.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS;

    const home = copilotHome ?? resolveCopilotHome(null);
  const cfg = resolveConfig({ copilotHome: home, workspace, projectTrusted: isProjectTrusted({ workspace, copilotHome: home }) });
    if (cfg.errors.length) {
    return {
      status: 'unavailable',
      reason: 'refusing to run: the harness configuration has errors',
      hint: `run \`harness config validate\` — first error: ${cfg.errors[0]}`,
    };
  }
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
        const detail = execution.signalName ? `Terminated by signal ${execution.signalName}` : 'Named check could not be spawned';
    return resultCheck(name, 'unavailable', detail, output);
  }
  if (execution.status === 'failed') {
    return resultCheck(name, 'failed', `Exited with status ${execution.exitCode}`, { ...output, exitCode: execution.exitCode });
  }
  return resultCheck(name, 'passed', 'Named check passed', { ...output, exitCode: 0 });
}
