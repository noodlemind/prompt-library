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
import { createStyle, keyWidthFor, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { readEvents } from './events.mjs';
import { RUN_STATUSES, readRuns, readJournal, foldRuns } from './run-journal.mjs';

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
  // The read cap exists to stop a full-history dump on the human path; a single
  // run's events are a bounded slice of that, so ask for the maximum and filter.
  return readEvents(workspace, { limit: Number.MAX_SAFE_INTEGER }).filter((e) => e.run === runId);
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

export async function runResultOf(argv, ctx = {}) {
  const { verb, id, workspace, filters } = context(argv);
  if (!RUN_VERBS.includes(verb)) {
    throw usageError(`unknown run verb: ${verb}`, `one of ${RUN_VERBS.join(', ')}`);
  }
  if (filters.status && !RUN_STATUSES.includes(filters.status)) {
    throw usageError(`unknown run status: ${filters.status}`, `one of ${RUN_STATUSES.join(', ')}`);
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
  const plan = resumePlanFor(run, { sideEffect: entry?.sideEffect ?? 'execute' });
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
      value: `${r.command || '(unknown)'} · ${r.status}`,
      note: [r.startedAt, r.status === 'running' && !r.live ? 'no outcome recorded' : null, r.plan].filter(Boolean).join(' · '),
      keyWidth,
    }));
  }
  if (!result.runs.length) console.log(ui.paint('muted', '  no runs recorded yet'));
}

function renderRunHeader(run) {
  const keyWidth = keyWidthFor(['run', 'command', 'started', 'status']);
  console.log(ui.line({ state: STATUS_STATE[run.status] || 'warn', key: 'run', value: run.run, note: run.status, keyWidth }));
  console.log(ui.line({ key: 'command', value: [run.command, ...(run.argv || [])].filter(Boolean).join(' '), keyWidth }));
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
      console.log(ui.paint('muted', `  ${e.ts}  ${e.type}${e.status ? ` · ${e.status}` : ''}`));
    }
  } else if (result.verb === 'tree') {
    renderRunHeader(result.run);
    console.log(ui.paint('muted', `  caused ${result.caused.length} recorded action(s)`));
    for (const e of result.caused) {
      const what = e.exec ? [e.exec.check, ...(e.exec.argv || [])].filter(Boolean).join(' ') : e.type;
      console.log(ui.paint('muted', `  └─ ${e.type}  ${what}${e.status ? ` · ${e.status}` : ''}`));
    }
  } else {
    const keyWidth = renderRunHeader(result.run);
    console.log(ui.line({
      state: result.resume.resumable ? 'ok' : 'warn',
      key: 'resume',
      value: result.resume.resumable ? `safe from ${result.resume.boundary}` : 'refused',
      note: result.resume.reason,
      keyWidth,
    }));
    if (result.resume.guidance) console.log(ui.paint('muted', `  ${result.resume.guidance}`));
    if (result.resume.resumable) console.log(ui.paint('muted', `  harness ${result.resume.argv.join(' ')}`));
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
