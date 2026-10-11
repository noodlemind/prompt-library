import { readFileNoFollow } from './fs-safe.mjs';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { runProcess } from './runner.mjs';
import { resolveConfig } from './config.mjs';
import { resolveControls } from './controls.mjs';
import { buildChildEnv } from './exec-policy.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';
import { createRedactor, redactionMarker } from './redact.mjs';

export const CHECKS_REL = '.github/harness/checks.yaml';

/** The complete schema a check entry accepts. Anything else is ignored. */
export const CHECK_TIMEOUT_DEFAULT_SECONDS = 600;
export const CHECK_TIMEOUT_MIN_SECONDS = 1;
export const CHECK_TIMEOUT_MAX_SECONDS = 3600;
export const CHECK_OUTPUT_MAX_CHARS = 4000;

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
        const content = readFileNoFollow(full, { root: workspace, maxBytes: 1024 * 1024 });
    if (content === null) throw new Error('Named check source is unreadable or nonregular');
    const parsed = YAML.parse(content, { maxAliasCount: 50 });
    if (parsed?.version !== 1 || !parsed.checks || typeof parsed.checks !== 'object') {
      return { checks: null, error: `${CHECKS_REL} must declare version: 1 and checks` };
    }
    return { checks: parsed.checks, error: null };
  } catch (error) {
    return { checks: null, error: `Invalid ${CHECKS_REL}: ${error.message}` };
  }
}

function declaredProof(config) {
  if (!config || !Object.hasOwn(config, 'proof')) return 'behavior';
  if (config.proof === 'type-check' || config.proof === 'behavior') return config.proof;
  return null;
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
  if (config.proof !== undefined && config.proof !== 'type-check' && config.proof !== 'behavior') {
    return `${name}.proof must be type-check or behavior`;
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

function secretScanOverlap(redactText) {
  // Covers the shared patterns' bounded tokens (including the ~42K JWT
  // pattern). Known environment masks may be longer, including URL-encoded
  // literals; derive their overlap so output volume cannot grow this state.
  let overlap = 64 * 1024;
  for (const value of Object.values(process.env)) {
    if (typeof value !== 'string') continue;
    if (value.length > overlap && redactText(value) !== value) overlap = value.length;
    try {
      const encoded = encodeURIComponent(value);
      if (encoded.length > overlap && redactText(encoded) !== encoded) overlap = encoded.length;
    } catch {
      // The shared redactor also falls back to a raw literal for lone surrogates.
    }
  }
  return overlap;
}

function observeCheckOutput(onChunk, redactText, overlap) {
  let carry = '';
  let privateKeySeen = false;
  let secretSeen = false;
  return {
    push(chunk) {
      const text = carry + String(chunk);
      privateKeySeen ||= /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
      secretSeen ||= privateKeySeen || redactText(text) !== text;
      carry = text.slice(-overlap);
      onChunk?.(chunk);
    },
    retained(text, omittedChars) {
      if (privateKeySeen) return redactionMarker('private-key');
      if (secretSeen && omittedChars > 0) return redactionMarker('truncated-output');
      return redactText(text);
    },
  };
}

export async function runNamedCheck(workspace, name, config, { signal, onStdout, onStderr, copilotHome = null, events = null } = {}) {
  const proof = declaredProof(config);
  const finish = (result) => (proof == null ? result : { ...result, proof });
  const invalid = validateCommand(name, config);
  if (invalid) return finish(resultCheck(name, 'unavailable', invalid));

  const timeoutSeconds = config.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS;

    const home = copilotHome ?? resolveCopilotHome(null);
  const cfg = resolveConfig({ copilotHome: home, workspace, projectTrusted: isProjectTrusted({ workspace, copilotHome: home }) });
    if (cfg.errors.length) {
    return finish({
      status: 'unavailable',
      reason: 'refusing to run: the harness configuration has errors',
      hint: `run \`harness config validate\` — first error: ${cfg.errors[0]}`,
    });
  }
    const allowlisted = cfg.values['checks.env_allowlist'] === true;
  const envReport = allowlisted ? buildChildEnv({ allow: cfg.values['exec.allow_env'] }) : null;

  const { controls, networkWrapper, degraded } = resolveControls({
    networkPolicy: cfg.values['exec.network'],
    environmentAllowlisted: allowlisted,
  });

  const { redactText } = createRedactor();
  const overlap = secretScanOverlap(redactText);
  const stdout = observeCheckOutput(onStdout, redactText, overlap);
  const stderr = observeCheckOutput(onStderr, redactText, overlap);
  const execution = await runProcess({
    argv: [...networkWrapper, ...config.command],
    cwd: workspace,
    ...(envReport ? { env: envReport.env } : {}),
    timeoutMs: timeoutSeconds * 1000,
    signal,
    onStdout: chunk => stdout.push(chunk),
    onStderr: chunk => stderr.push(chunk),
    maxBuffer: CHECK_OUTPUT_MAX_CHARS,
    bufferMode: 'head-tail',
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
      outputTruncation: execution.outputTruncation,
      controls,
      degraded: degraded.map((c) => ({ id: c.id, declared: c.declared, realized: c.realized, reason: c.reason })),
    },
  });
  const output = {
    stdout: stdout.retained(execution.stdout, execution.outputTruncation.stdout.omittedChars),
    stderr: stderr.retained(execution.stderr, execution.outputTruncation.stderr.omittedChars),
    truncated: execution.truncated,
    outputTruncation: execution.outputTruncation,
    durationMs: execution.durationMs,
  };

  if (execution.status === 'cancelled') {
    return finish(resultCheck(name, 'unavailable', 'Cancelled — verification was interrupted', { ...output, cancelled: true }));
  }
  if (execution.status === 'timed-out') {
    return finish(resultCheck(name, 'timeout', `Timed out after ${timeoutSeconds}s`, output));
  }
  if (execution.status === 'failed' && execution.exitCode === null) {
        const detail = execution.signalName ? `Terminated by signal ${execution.signalName}` : 'Named check could not be spawned';
    return finish(resultCheck(name, 'unavailable', detail, output));
  }
  if (execution.status === 'failed') {
    return finish(resultCheck(name, 'failed', `Exited with status ${execution.exitCode}`, { ...output, exitCode: execution.exitCode }));
  }
  return finish(resultCheck(name, 'passed', 'Named check passed', { ...output, exitCode: 0 }));
}
