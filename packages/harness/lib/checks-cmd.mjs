/**
 * `harness checks list|show|run` — Phase 3's first command.
 *
 * The named checks were only ever reachable through `verify`, which runs the
 * whole plan-gated pipeline. That made the simple questions hard: what checks
 * does this repo define, what exactly will one of them execute, and does it
 * pass on its own. Answering them meant reading `.github/harness/checks.yaml`
 * by hand, which is how four independent parsers of that file came to exist.
 *
 * `run` is the one verb here with an execute side effect, and it is declared as
 * such rather than inheriting the entry's maximum: `list` and `show` read, and
 * a palette that painted an execute glyph on them would be warning about the
 * wrong thing — the same mislabelling `bareSideEffect` exists to prevent.
 */
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { CHECKS_REL, loadNamedChecks, validateCommand, runNamedCheck, CHECK_TIMEOUT_DEFAULT_SECONDS } from './checks.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const CHECKS_VERBS = Object.freeze(['list', 'show', 'run']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

function readChecks(workspace) {
  const { checks, error } = loadNamedChecks(workspace);
  if (error) {
    // A missing or malformed config is not an internal fault: the caller asked
    // about checks in a workspace that declares none, or declares them wrongly.
    throw notFoundError(error, `define checks in ${CHECKS_REL} with version: 1`);
  }
  return checks;
}

function describeCheck(name, config) {
  const invalid = validateCommand(name, config);
  return {
    name,
    // The argv is shown in full and never joined into a shell string: joining
    // suggests a shell will interpret it, and the runner deliberately never
    // uses one. A reader who copies a joined string would get different
    // behavior from what the harness actually runs.
    command: Array.isArray(config?.command) ? [...config.command] : null,
    timeoutSeconds: config?.timeout_seconds ?? CHECK_TIMEOUT_DEFAULT_SECONDS,
    valid: invalid === null,
    invalidReason: invalid,
  };
}

function context(argv) {
  const flags = parseFlags(argv);
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      if (!a.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i += 1;
      continue;
    }
    positionals.push(a);
    if (positionals.length === 2) break;
  }
  return {
    flags,
    verb: positionals[0] ?? null,
    name: positionals[1] ?? null,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
  };
}

export async function checksResultOf(argv, ctx = {}) {
  const { verb, name, workspace, copilotHome } = context(argv);
  if (!verb) throw usageError('checks requires a verb', `harness checks <${CHECKS_VERBS.join('|')}>`);
  if (!CHECKS_VERBS.includes(verb)) {
    throw usageError(`unknown checks verb: ${verb}`, `one of ${CHECKS_VERBS.join(', ')}`);
  }
  const checks = readChecks(workspace);
  const names = Object.keys(checks).sort();

  if (verb === 'list') {
    return {
      schema: 1,
      verb,
      config: CHECKS_REL,
      checks: names.map((n) => describeCheck(n, checks[n])),
    };
  }

  if (!name) throw usageError(`checks ${verb} requires a check name`, `harness checks ${verb} <name>`);
  if (!(name in checks)) {
    throw notFoundError(`no check named ${JSON.stringify(name)} in ${CHECKS_REL}`, names.length ? `defined here: ${names.join(', ')}` : 'no checks are defined');
  }

  if (verb === 'show') {
    return { schema: 1, verb, config: CHECKS_REL, check: describeCheck(name, checks[name]) };
  }

  // `run` executes a repo-authored argv, so it is gated on trust for the same
  // reason `verify`'s named checks are: the threat is `git clone && harness
  // checks run`. Refused outright here rather than degraded, because unlike
  // `verify` — which has built-in checks worth reporting either way — running
  // the check IS the whole command, and a `checks run` that quietly did nothing
  // would read as a pass.
  //
  // `list` and `show` are deliberately still allowed: reading what a repository
  // would execute is exactly what someone needs before deciding to approve it.
  if (!isProjectTrusted({ workspace, copilotHome })) {
    throw Object.assign(new Error(`refusing to run ${JSON.stringify(name)}: this project is not trusted`), {
      code: 'E_DENIED',
      exit: EXIT.needsApproval,
      hint: `a named check runs commands this repository authored — read them with \`harness checks show ${name}\`, then \`harness trust approve\``,
    });
  }
  // The AbortSignal is threaded through so a long check is cancellable
  // the same way `verify` already is — Phase 1 wired Ctrl-C to verify only, and
  // an execute-classed command that cannot be interrupted is worse than one
  // that never existed.
  const outcome = await runNamedCheck(workspace, name, checks[name], { signal: ctx.signal, copilotHome, events: ctx.events });
  // `status` is carried on the result so the ENVELOPE reports the check's real
  // verdict. Without it `createEnvelope`'s `status: 'ok'` default stood, and
  // `checks run` on the envelope lane printed `"status":"ok"` directly above an
  // outcome of `failed` — see `checksExitFor` for the half of this that lied
  // even louder.
  return { schema: 1, verb, config: CHECKS_REL, status: statusForOutcome(outcome), check: describeCheck(name, checks[name]), outcome };
}

/** The unified status vocabulary for a check's legacy outcome status. */
function statusForOutcome(outcome) {
  if (outcome?.status === 'passed') return 'ok';
  if (outcome?.status === 'timeout') return 'timed-out';
  return 'failed';
}

/**
 * The exit code for a `checks` result, on EVERY lane.
 *
 * `checks run` exists so CI can gate on a single check without parsing output.
 * `dispatchLane` returns 0 on any success path unless the entry declares an
 * `exitOf`, and this entry did not — so `checks run failing --output
 * json-envelope` exited 0 while the ledger path for the same check exited 1. A
 * pipeline gating through the envelope lane passed every failing check.
 *
 * `timeout` routes to the reserved `EXIT.timedOut` (8). An earlier version kept
 * it at 1 to avoid widening the vocabulary, but that left the envelope
 * reporting `"status":"timed-out"` beside exit 1 — the same status/exit
 * contradiction this function exists to remove, just quieter. Found by the
 * Codex phase review.
 */
export function checksExitFor(result) {
  if (result?.verb !== 'run') return EXIT.ok;
  if (result.outcome?.status === 'passed') return EXIT.ok;
  if (result.outcome?.status === 'timeout') return EXIT.timedOut;
  return 1;
}

const OUTCOME_STATE = { passed: 'ok', failed: 'error', timeout: 'error', unavailable: 'warn' };

export async function cmdChecks(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await checksResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (result.verb === 'list') {
    const keyWidth = keyWidthFor(['checks', ...result.checks.map((c) => c.name)]);
    console.log(ui.line({ key: 'checks', value: `${result.checks.length} defined`, note: result.config, keyWidth }));
    for (const c of result.checks) {
      console.log(ui.line({
        state: c.valid ? 'ok' : 'error',
        key: c.name,
        value: c.command ? c.command.join(' ') : '(no command)',
        note: c.valid ? `${c.timeoutSeconds}s` : c.invalidReason,
        keyWidth,
      }));
    }
  } else {
    const c = result.check;
    const keyWidth = keyWidthFor(['command', 'timeout', 'outcome', 'stdout']);
    console.log(ui.line({ state: c.valid ? 'ok' : 'error', key: 'check', value: c.name, note: c.valid ? undefined : c.invalidReason, keyWidth }));
    console.log(ui.line({ key: 'command', value: (c.command || []).join(' '), keyWidth }));
    console.log(ui.line({ key: 'timeout', value: `${c.timeoutSeconds}s`, keyWidth }));
    if (result.outcome) {
      console.log(ui.line({
        state: OUTCOME_STATE[result.outcome.status] || 'warn',
        key: 'outcome',
        value: result.outcome.status,
        note: result.outcome.message,
        keyWidth,
      }));
      // Check output is untrusted text going straight to a terminal, so it is
      // inerted per line exactly as cmdGet does with a file excerpt.
      for (const stream of ['stdout', 'stderr']) {
        const text = result.outcome[stream];
        if (text) console.log(`${stream}:\n${String(text).split('\n').map(inertLine).join('\n')}`);
      }
    }
  }

  // One rule, shared with the lane path via the registry's `exitOf`, so the two
  // can no longer disagree about whether a check passed.
  return checksExitFor(result);
}
