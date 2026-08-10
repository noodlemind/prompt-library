/**
 * `harness run list|show|tree|resume` — the run history surface.
 *
 * `list` answers "what has this harness done here", `show` answers "what
 * happened in that one run", and `tree` answers "what did that run cause" —
 * which is the question the run id was introduced to make answerable at all.
 *
 * `resume` is the one verb that can act, and its whole design is about refusing
 * to: see `resumePlanFor` for why an interrupted command is never replayed.
 */
import path from 'node:path';
import { parseFlags } from './flags.mjs';
import { positionalsOf } from './positionals.mjs';
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import fs from 'node:fs';
import { eventPath } from './events.mjs';
import { RUN_STATUSES, readRuns, readJournal, foldRuns } from './run-journal.mjs';
import { inertLine } from './knowledge/store.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export const RUN_VERBS = Object.freeze(['list', 'show', 'tree', 'resume']);

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: EXIT.usage, hint });
}

function notFoundError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_NOT_FOUND', exit: EXIT.notFound, hint });
}

/** Command-specific value flags, read straight from argv for the same reason
 * `--match` and `--scope` are: parseFlags is shared by every command. */
function readValueFlag(argv, name) {
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  const eq = scan.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1) || null;
  const i = scan.indexOf(name);
  if (i === -1) return null;
  const next = scan[i + 1];
  return next === undefined || next.startsWith('--') ? null : next;
}

/** Flags on this entry that take a value. A BOOLEAN flag before the verb —
 * `harness run --json show <id>` — must not swallow the next token, which is
 * what a blanket "skip the following word" rule did (P2-12). */
function context(argv) {
  const flags = parseFlags(argv);
  const positionals = positionalsOf(argv, { limit: 2 });
  return {
    flags,
    verb: positionals[0] ?? 'list',
    id: positionals[1] ?? null,
    workspace: path.resolve(flags.workspace),
    filters: {
      status: readValueFlag(argv, '--status'),
      command: readValueFlag(argv, '--command'),
      host: readValueFlag(argv, '--host'),
      plan: readValueFlag(argv, '--plan'),
      since: readValueFlag(argv, '--since'),
      until: readValueFlag(argv, '--until'),
    },
  };
}

/**
 * Resolve a run id, accepting an unambiguous prefix.
 *
 * Run ids are long enough to be unpleasant to retype, and `list` prints them in
 * full, so a prefix is what a person will actually paste. An AMBIGUOUS prefix
 * is an error rather than a silent pick of the newest: acting on a run the
 * caller did not mean is exactly the mistake `resume` must never make.
 */
export function resolveRunId(runs, id) {
  if (!id) throw usageError('run requires a run id', 'harness run show <run-id> — see `harness run list`');
  const exact = runs.find((r) => r.run === id);
  if (exact) return exact;
  const matches = runs.filter((r) => r.run.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw usageError(
      `run id ${JSON.stringify(id)} is ambiguous (${matches.length} runs match)`,
      `matching: ${matches.slice(0, 5).map((r) => r.run).join(', ')}${matches.length > 5 ? ' …' : ''}`,
    );
  }
  throw notFoundError(`no run matching ${JSON.stringify(id)}`, 'harness run list');
}

/** The events belonging to one run. The run id is on every event the invocation
 * produced, so this is a filter rather than a reconstruction. */
function eventsForRun(workspace, runId) {
  // Read the file directly rather than through `readEvents`. That reader clamps
  // to EVENTS_MAX_LIMIT and applies the clamp BEFORE any filter, so a run
  // followed by 200 unrelated events reported zero of its own — retained
  // evidence made invisible by a display cap (P2-7, Codex phase-4a review).
  const file = eventPath(workspace);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e && e.run === runId);
}

const STATUS_STATE = {
  succeeded: 'ok',
  running: 'warn',
  failed: 'error',
  inconclusive: 'warn',
  blocked: 'warn',
  cancelled: 'warn',
  'timed-out': 'error',
};

/**
 * Whether a run can be resumed, and from where (P4aAC4).
 *
 * THE RULE IS THAT AN INTERRUPTED COMMAND IS NEVER REPLAYED. A run that stopped
 * partway did so at an unknown point: `compound` may have written half a
 * learning, `install` may have hydrated some files. Re-running it is not
 * idempotent and the journal cannot prove where it got to, so `resume` refuses
 * and names the safe thing to do instead.
 *
 * A SAFE BOUNDARY is a run that reached a terminal state with a side-effect
 * class of `read`. Re-running a read costs nothing and cannot corrupt anything,
 * which is the only case where "just run it again" is honest advice. Everything
 * else is reported with what it would have taken.
 */
export function resumePlanFor(run, { sideEffect = 'execute' } = {}) {
  if (!run) return { resumable: false, reason: 'no such run' };
  if (run.status === 'running') {
    return {
      resumable: false,
      boundary: null,
      reason: run.live
        ? 'this run is still going — its process is alive'
        : 'this run never recorded an outcome, so where it stopped is unknown',
      guidance: run.live
        ? 'wait for it to finish, or interrupt it and inspect the workspace'
        : 'inspect the workspace, then re-run the command yourself if its effects are safe to repeat',
    };
  }
  if (sideEffect !== 'read') {
    return {
      resumable: false,
      boundary: null,
      reason: `${run.command} is ${sideEffect === 'execute' ? 'an' : 'a'} ${sideEffect}-class command, so re-running it is not a safe boundary`,
      guidance: `re-run it deliberately if that is what you want: harness ${run.command} ${(run.argv || []).join(' ')}`.trim(),
    };
  }
  return {
    resumable: true,
    boundary: 'command-start',
    reason: `${run.command} only reads, so running it again cannot change anything`,
    argv: [run.command, ...(run.argv || [])],
  };
}

/**
 * Registry-phase validation — STRUCTURAL only.
 *
 * P2-8 reported that `run list --status bogus` exits 2 having already written a
 * run, and asked for values to be validated before `onRunStart`. Ruled
 * narrower than requested, because the finding conflates two things:
 *
 *   - a DISPATCH-phase refusal (an unknown verb, a missing run id, an unknown
 *     flag) means the command never started, so it has no run — that invariant
 *     is real and is enforced here;
 *   - a VALUE the handler rejects means the command ran, read the journal, and
 *     failed. Recording that as an `inconclusive` run is accurate, and it is
 *     the kind of failed invocation an operator most wants to find later.
 *
 * The registry's `requireArgs` contract also constrains this: the command-index
 * test fills every picker with a placeholder and requires the gate to accept
 * it, so a value check here would refuse legitimate palette output.
 */
export function runRequireArgs(rest) {
  // The SAME scan `context()` uses. These two disagreed: `context()` skipped
  // value-flag arguments and this did not, so `harness run --status succeeded
  // list` was refused with "unknown run verb: succeeded" — the gate rejecting an
  // invocation the handler would have understood perfectly.
  const positionals = positionalsOf(rest);
  const verb = positionals[0] ?? 'list';
  if (!RUN_VERBS.includes(verb)) return `unknown run verb: ${verb}`;
  if (['show', 'tree', 'resume'].includes(verb)) {
    if (positionals.length < 2) return `run ${verb} requires a run id`;
  }
  // `undefined`, not `null`: the registry's requireArgs contract is "a message
  // or nothing", and the contract test asserts the absence is `undefined` the
  // way every other predicate here returns it.
  return undefined;
}

export async function runResultOf(argv, ctx = {}) {
  const { verb, id, workspace, filters } = context(argv);
  if (!RUN_VERBS.includes(verb)) {
    throw usageError(`unknown run verb: ${verb}`, `one of ${RUN_VERBS.join(', ')}`);
  }
  if (filters.status && !RUN_STATUSES.includes(filters.status)) {
    throw usageError(`unknown run status: ${filters.status}`, `one of ${RUN_STATUSES.join(', ')}`);
  }
  // Bounds are validated HERE, before anything is read or opened, so a rejected
  // filter leaves no run behind (P2-8). `queryRuns` throws E_USAGE on an
  // unparseable date; doing it eagerly keeps the refusal on the same side of
  // the no-run invariant as every other usage error.
  for (const [name, value] of [['--since', filters.since], ['--until', filters.until]]) {
    if (!value) continue;
    const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
    if (!Number.isFinite(at)) throw usageError(`${name} is not a date: ${JSON.stringify(value)}`);
  }

  const all = readRuns(workspace, verb === 'list' ? filters : {});

  if (verb === 'list') {
    // `Number(null)` is 0 and 0 is finite, so an absent flag has to be checked
    // for absence rather than for numeric validity — otherwise the default
    // silently becomes "show one run".
    const rawLimit = readValueFlag(argv, '--limit');
    const parsedLimit = rawLimit === null ? NaN : Number(rawLimit);
    if (rawLimit !== null && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw usageError(`--limit must be a positive integer (got ${JSON.stringify(rawLimit)})`);
    }
    const limit = Number.isInteger(parsedLimit) ? parsedLimit : 20;
    return {
      schema: 1,
      verb,
      total: all.length,
      filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      runs: all.slice(0, Math.max(1, limit)),
    };
  }

  const run = resolveRunId(all, id);

  if (verb === 'show') {
    return { schema: 1, verb, run, events: eventsForRun(workspace, run.run) };
  }

  if (verb === 'tree') {
    const events = eventsForRun(workspace, run.run);
    return {
      schema: 1,
      verb,
      run,
      // The lifecycle pair brackets the run and is not itself "work the run
      // caused", so it is separated from the rest rather than listed beside it.
      lifecycle: events.filter((e) => e.type === 'command.start' || e.type === 'command.result'),
      caused: events.filter((e) => e.type !== 'command.start' && e.type !== 'command.result'),
    };
  }

  // `resume`. The registry is imported HERE rather than at module load: it
  // imports this module for its handler and verbs, so a static import would
  // close a cycle that breaks whenever this module is loaded first (a test
  // importing `resumePlanFor` directly did exactly that). Resolving it at call
  // time also keeps `resumePlanFor` a pure function of the run and its
  // side-effect class, which is what makes it testable without a registry.
  const { getCommand: lookup } = await import('./registry.mjs');
  const entry = run.command ? lookup(run.command) : null;
  // P2-14: the ENTRY's sideEffect is the family maximum, so `config show` — a
  // read — inherited `config`'s `mutate` and was refused as unsafe. The verb
  // actually invoked is recorded in the run's argv, and its own declared class
  // is the honest answer.
  // Same scan again. A stored argv like `config --workspace /tmp/x show` used to
  // yield `/tmp/x` as the verb, so `verbEntry` was undefined and `sideEffect`
  // fell back to the family maximum — quietly restoring the exact P2-14
  // behavior this block exists to prevent.
  const invokedVerb = positionalsOf(run.argv || [])[0];
  const verbEntry = entry?.verbs?.find((v) => v.verb === invokedVerb);
  const sideEffect = verbEntry?.sideEffect
    ?? (invokedVerb ? entry?.sideEffect : entry?.bareSideEffect ?? entry?.sideEffect)
    ?? 'execute';
  const plan = resumePlanFor(run, { sideEffect });
  return { schema: 1, verb, run, status: plan.resumable ? 'ok' : 'blocked', resume: plan };
}

function renderList(result) {
  const keyWidth = keyWidthFor(['runs', ...result.runs.map((r) => r.run)]);
  const filters = Object.entries(result.filters).map(([k, v]) => `${k}=${v}`).join(' · ');
  console.log(ui.line({ key: 'runs', value: `${result.runs.length} of ${result.total}`, note: filters || undefined, keyWidth }));
  for (const r of result.runs) {
    console.log(ui.line({
      state: STATUS_STATE[r.status] || 'warn',
      key: r.run,
      value: inertLine(`${r.command || '(unknown)'} · ${r.status}`),
      // `r.plan` is the caller's own `--plan` value, persisted by startRun and
      // printed back here. Redaction on write removes secrets, not terminal
      // control sequences — `inertLine` is what stops a stored argv repainting
      // the operator's screen. The `value` above already had it; this did not.
      note: inertLine([r.startedAt, r.status === 'running' && !r.live ? 'no outcome recorded' : null, r.plan].filter(Boolean).join(' · ')),
      keyWidth,
    }));
  }
  if (!result.runs.length) console.log(ui.paint('muted', '  no runs recorded yet'));
}

function renderRunHeader(run) {
  const keyWidth = keyWidthFor(['run', 'command', 'started', 'status']);
  console.log(ui.line({ state: STATUS_STATE[run.status] || 'warn', key: 'run', value: run.run, note: run.status, keyWidth }));
  // P2-20: an argv is caller free-text that was PERSISTED and is now on its way
  // back to a terminal. Without inerting, a stored OSC sequence would set the
  // window title or forge output when someone ran `run show`. Everything read
  // out of the journal passes the same sanitizer `get` uses on file excerpts.
  console.log(ui.line({ key: 'command', value: inertLine([run.command, ...(run.argv || [])].filter(Boolean).join(' ')), keyWidth }));
  console.log(ui.line({ key: 'started', value: run.startedAt || '(unknown)', note: run.finishedAt ? `finished ${run.finishedAt}` : undefined, keyWidth }));
  if (run.status === 'running') {
    console.log(ui.line({ state: run.live ? 'warn' : 'error', key: 'process', value: run.live ? `alive (pid ${run.pid})` : `gone (pid ${run.pid}) — no outcome was recorded`, keyWidth }));
  }
  return keyWidth;
}

export async function cmdRun(argv, ctx = {}) {
  const { flags } = context(argv);
  const result = await runResultOf(argv, ctx);

  if (flags.json) {
    console.log(redactedJson(result, { pretty: flags.verbose }));
  } else if (result.verb === 'list') {
    renderList(result);
  } else if (result.verb === 'show') {
    const keyWidth = renderRunHeader(result.run);
    console.log(ui.line({ key: 'events', value: `${result.events.length}`, keyWidth }));
    for (const e of result.events) {
      console.log(ui.paint('muted', inertLine(`  ${e.ts}  ${e.type}${e.status ? ` · ${e.status}` : ''}`)));
    }
  } else if (result.verb === 'tree') {
    renderRunHeader(result.run);
    console.log(ui.paint('muted', `  caused ${result.caused.length} recorded action(s)`));
    for (const e of result.caused) {
      const what = e.exec ? [e.exec.check, ...(e.exec.argv || [])].filter(Boolean).join(' ') : e.type;
      console.log(ui.paint('muted', inertLine(`  └─ ${e.type}  ${what}${e.status ? ` · ${e.status}` : ''}`)));
    }
  } else {
    const keyWidth = renderRunHeader(result.run);
    console.log(ui.line({
      state: result.resume.resumable ? 'ok' : 'warn',
      key: 'resume',
      value: result.resume.resumable ? `safe from ${result.resume.boundary}` : 'refused',
      // All three of these embed the stored `run.command` and `run.argv`, which
      // is caller free-text that was persisted and is now being printed back.
      note: inertLine(String(result.resume.reason ?? '')),
      keyWidth,
    }));
    if (result.resume.guidance) console.log(ui.paint('muted', `  ${inertLine(String(result.resume.guidance))}`));
    if (result.resume.resumable) console.log(ui.paint('muted', `  harness ${inertLine(result.resume.argv.join(' '))}`));
  }

  // `resume` reports whether resuming is safe; it does not itself re-run
  // anything, so a refusal is an answer rather than a failure — but it exits
  // non-zero so a script can branch on it without parsing output.
  if (result.verb === 'resume' && !result.resume.resumable) return EXIT.needsApproval;
  return EXIT.ok;
}

export function runExitFor(result) {
  if (result?.verb === 'resume' && !result.resume?.resumable) return EXIT.needsApproval;
  return EXIT.ok;
}

export { readJournal, foldRuns };
