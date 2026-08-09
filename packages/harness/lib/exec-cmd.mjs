/**
 * `harness exec -- <argv...>` and `harness bash -- <script>` — Phase 3's
 * governed execution surface.
 *
 * Two commands rather than one with a `--shell` flag, deliberately. They carry
 * different risk and are separately policy-gated, and an auditor filtering the
 * event log for shell invocations should not have to trust a boolean inside a
 * payload to find them. The event types are separate for the same reason.
 *
 * `exec` never invokes a shell: `runProcess` hardcodes `shell: false`, so the
 * argv the operator wrote is the argv that runs — no word splitting, no glob
 * expansion, no `$(…)`. `bash` exists because some workflows genuinely need a
 * shell, and pretending otherwise just pushes people to write
 * `exec sh -c "…"`, which is the same risk with none of the labelling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson, createRedactor } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { runProcess } from './runner.mjs';
import { createCheckOutputStreamer } from './verify.mjs';
import { buildChildEnv, resolveExecCwd, resolveShell, resolveTimeoutSeconds } from './exec-policy.mjs';
import { resolveConfig } from './config.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';
import { resolveControls } from './controls.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * Everything after the first bare `--` is the command to run.
 *
 * The boundary is REQUIRED rather than optional: without it a flag meant for
 * the child (`--json`, `--workspace`) would be eaten by the harness's own
 * parser, and the operator would watch the harness reconfigure itself instead
 * of passing the argument along. Making it mandatory means there is exactly
 * one reading of every invocation.
 */
export function splitAtBoundary(argv) {
  const i = argv.indexOf('--');
  if (i === -1) return { harnessArgs: argv, childArgs: null };
  return { harnessArgs: argv.slice(0, i), childArgs: argv.slice(i + 1) };
}

function repeatedFlag(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
    else if (a === name && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out.push(argv[i += 1]);
  }
  return out.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
}

function singleFlag(argv, name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i === -1 || i > (argv.indexOf('--') === -1 ? Infinity : argv.indexOf('--'))) return null;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

function plan(argv, { shell }) {
  const { harnessArgs, childArgs } = splitAtBoundary(argv);
  const flags = parseFlags(harnessArgs);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const config = resolveConfig({
    copilotHome,
    workspace,
    projectTrusted: isProjectTrusted({ workspace, copilotHome }),
  });

  // The P3AC2 policy gate: `bash` is allowed or denied separately from `exec`.
  // Checked BEFORE the boundary error below, so a denied shell reports being
  // denied rather than complaining about the syntax of a command it was never
  // going to run.
  if (shell && config.values['exec.bash_enabled'] !== true) {
    throw Object.assign(new Error('bash is disabled by configuration'), {
      code: 'E_DENIED',
      exit: EXIT.needsApproval,
      hint: `set exec.bash_enabled true (currently from ${config.provenance['exec.bash_enabled'].source}), or use \`harness exec\`, which never invokes a shell`,
    });
  }

  if (childArgs === null || childArgs.length === 0) {
    throw usageError(
      shell ? 'bash requires a script after --' : 'exec requires a command after --',
      shell ? 'harness bash -- "<script>"' : 'harness exec -- <program> [args...]',
    );
  }

  // The flag wins over configuration where it is given — an explicit argument
  // is the operator speaking now — but it is still bounded by the same
  // validator, so `--timeout` cannot exceed the ceiling either.
  const rawTimeout = singleFlag(harnessArgs, '--timeout');
  const timeoutSeconds = rawTimeout === null || rawTimeout === ''
    ? config.values['exec.timeout_seconds']
    : resolveTimeoutSeconds(rawTimeout);
  const cwd = resolveExecCwd({ workspace, cwd: singleFlag(harnessArgs, '--cwd'), realpath });
  const envReport = buildChildEnv({
    allow: [...config.values['exec.allow_env'], ...repeatedFlag(harnessArgs, '--allow-env')],
  });

  // A shell script is one argument to the shell, never a token list: joining
  // multiple tokens would re-introduce the word-splitting `exec` exists to
  // avoid, at the one boundary where it is hardest to see.
  const resolvedShell = shell ? resolveShell() : null;
  const target = shell ? [...resolvedShell.argv, childArgs.join(' ')] : childArgs;

  // The isolation wrapper goes in FRONT of the target rather than replacing it,
  // and is reported separately from `argv` in the audit — the operator asked to
  // run their command, and an audit that showed `sandbox-exec …` as the thing
  // they ran would misattribute it.
  const { controls, networkWrapper, degraded } = resolveControls({ networkPolicy: config.values['exec.network'] });
  const argvToRun = [...networkWrapper, ...target];

  return { flags, workspace, cwd, timeoutSeconds, envReport, argvToRun, childArgs, shell, controls, degraded, shellPath: resolvedShell?.shell ?? null };
}

/**
 * The execution audit entry (Phase 3 AC5) — written for EVERY execution.
 *
 * It lives here, in the one function both the handler and the `resultOf`
 * producer call, rather than in `cmdExec`/`cmdBash`. Emitting from the handler
 * alone meant `--output json-envelope|agent` spawned a child process and left
 * no execution record at all: the lane path never touches the handler. An audit
 * that a caller can skip by choosing an output format is not an audit.
 *
 * It records WHAT RAN — argv, cwd, timeout, and the environment the child could
 * see. An execution log that carries only an exit code cannot answer the
 * question it exists for. Env is names-and-counts only, never values: the
 * allowlist withheld those credentials, and writing them into the audit would
 * hand them back. Everything here passes through the event registry's redactor
 * before persistence, so a secret typed into the argv is masked in the record.
 */
function emitAudit(ctx, mode, p, result) {
  const events = ctx?.events;
  const sink = typeof events?.withCommand === 'function' ? events.withCommand(mode) : events;
  sink?.emit?.(mode, {
    // Outcome scalars stay top-level, where every other event type already
    // puts them, so `harness events --failures` and the summaries read this
    // record without knowing anything about executions.
    result: result.status === 'ok' ? 'pass' : 'fail',
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    // The invocation descriptor: what ran, where, and under what policy.
    exec: {
      shell: p.shell,
      // Which shell, not just whether one was used — `bash` resolves
      // differently per platform, and an auditor reading "shell: true" cannot
      // tell a POSIX sh from a Git-Bash on Windows.
      shellPath: p.shellPath,
      argv: p.childArgs,
      cwd: p.cwd,
      timeoutSeconds: p.timeoutSeconds,
      env: { allowed: p.envReport.allowed, droppedCount: p.envReport.dropped.length, refused: p.envReport.refused },
      signal: result.signal,
      truncated: result.truncated,
      // P3AC1/P3AC3: what each control ACTUALLY achieved for this run, and any
      // control that could not do what it declares. A degradation nobody
      // records is a control nobody can audit.
      controls: p.controls,
      degraded: p.degraded.map((c) => ({ id: c.id, declared: c.declared, realized: c.realized, reason: c.reason })),
    },
  });
}

async function execute(argv, ctx, { shell }) {
  const p = plan(argv, { shell });
  const { redactText } = createRedactor();
  const rows = [];

  // The same bounded, redacted streamer `verify` uses for check output: a
  // secret split across two chunks is reassembled before redaction, a PEM block
  // is masked whole, and the byte budget counts the serialized row width. None
  // of that is worth reimplementing differently for a second execution surface.
  const streamer = createCheckOutputStreamer({
    check: p.shell ? 'bash' : 'exec',
    onEvent: (_event, fields) => rows.push(fields),
    redactText,
  });

  const execution = await runProcess({
    argv: p.argvToRun,
    cwd: p.cwd,
    env: p.envReport.env,
    timeoutMs: p.timeoutSeconds * 1000,
    signal: ctx?.signal,
    onStdout: (chunk) => streamer.onStdout(chunk),
    onStderr: (chunk) => streamer.onStderr(chunk),
  });
  streamer.flush();

  const result = {
    schema: 1,
    mode: p.shell ? 'bash' : 'exec',
    // The argv is reported as a list, never joined: a joined string reads as
    // something a shell interpreted, which for `exec` is precisely wrong.
    argv: p.childArgs,
    cwd: p.cwd,
    timeoutSeconds: p.timeoutSeconds,
    status: execution.status,
    exitCode: execution.exitCode,
    signal: execution.signalName,
    durationMs: execution.durationMs,
    truncated: execution.truncated,
    // Names only. The audit answers "what could this process see", and a value
    // here would put the very credentials the allowlist withheld into the log.
    env: { allowed: p.envReport.allowed, droppedCount: p.envReport.dropped.length, refused: p.envReport.refused },
    controls: p.controls,
    output: rows,
  };

  emitAudit(ctx, result.mode, p, result);
  return result;
}

const STATUS_EXIT = { ok: EXIT.ok, cancelled: EXIT.cancelled, 'timed-out': EXIT.timedOut };

function render(result, flags) {
  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
    return;
  }
  const keyWidth = keyWidthFor(['command', 'cwd', 'env', 'status']);
  const state = result.status === 'ok' ? 'ok' : result.status === 'failed' ? 'error' : 'warn';
  console.log(ui.line({ state, key: result.mode, value: result.argv.join(' '), keyWidth }));
  console.log(ui.line({ key: 'cwd', value: result.cwd, keyWidth }));
  console.log(ui.line({
    key: 'env',
    value: `${result.env.allowed.length} allowed`,
    note: `${result.env.droppedCount} dropped${result.env.refused.length ? ` · ${result.env.refused.length} refused` : ''}`,
    keyWidth,
  }));
  // A control that could not do what it declares is printed BEFORE the output,
  // where it is still read. `network: deny` that silently achieved nothing is
  // the exact failure this phase exists to make impossible to ship quietly.
  for (const control of result.controls || []) {
    if (control.declared === control.realized) continue;
    console.log(ui.line({
      state: 'warn',
      key: 'control',
      value: `${control.id}: ${control.realized}, not ${control.declared}`,
      note: control.reason,
      keyWidth,
    }));
  }
  for (const row of result.output) {
    if (row.line) console.log(inertLine(row.line));
    else if (row.truncated) console.log(ui.paint('muted', '  …output truncated'));
  }
  console.log(ui.line({
    state,
    key: 'status',
    value: result.status,
    note: result.exitCode === null ? undefined : `exit ${result.exitCode} · ${result.durationMs}ms`,
    keyWidth,
  }));
}

export function exitFor(result) {
  if (result.status in STATUS_EXIT) return STATUS_EXIT[result.status];
  // The child's own code is passed through where it is a normal failure, so a
  // caller scripting around `exec` sees what it would have seen running the
  // command directly.
  return result.exitCode === null || result.exitCode === 0 ? 1 : result.exitCode;
}

export async function execResultOf(argv, ctx = {}) {
  return execute(argv, ctx, { shell: false });
}

export async function cmdExec(argv, ctx = {}) {
  const result = await execute(argv, ctx, { shell: false });
  render(result, parseFlags(splitAtBoundary(argv).harnessArgs));
  return exitFor(result);
}

export async function bashResultOf(argv, ctx = {}) {
  return execute(argv, ctx, { shell: true });
}

export async function cmdBash(argv, ctx = {}) {
  const result = await execute(argv, ctx, { shell: true });
  render(result, parseFlags(splitAtBoundary(argv).harnessArgs));
  return exitFor(result);
}
