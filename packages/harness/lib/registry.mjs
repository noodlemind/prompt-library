/**
 * Command registry — the single source of truth for what a harness command
 * *is*: name, one-line job, declared args, side-effect class, required
 * capabilities, and which output lanes it renders today. This is data, not
 * convention — later phases' policy (P3) and run journal (P4) consume the
 * same entries (see docs/plans/2026-07-29-harness-cli-phase1-core.md).
 *
 * `dispatch(argv, ctx)` resolves a registered command from `argv[0]`,
 * validates its flags strictly (an unknown flag is rejected, never
 * silently dropped — AC2), enforces the entry's optional `requireArgs`
 * precondition (a REQUIRED argument missing or unsatisfied is the same
 * `E_USAGE`/exit-2 class as an unknown flag, never a bare thrown Error that
 * would misreport as a harness fault — see the "requireArgs predicates"
 * section below), and calls the entry's handler with the remaining args. A
 * handler has the exact signature every existing
 * `cmdX(argv)` function in lib/commands.mjs already has, so migrating a
 * command to the registry is "point `handler` at the existing function" —
 * no parsing logic is duplicated here; `lib/flags.mjs` / `lib/argv.mjs`
 * still do the real value parsing inside the handler, unchanged.
 *
 * Phase 1 (P1.1) migrates three pilots — orient, learnings, status — behind
 * this registry. bin/harness.mjs tries the registry first for a registered
 * command and falls through to the hand-written switch for everything
 * else; the switch itself is not removed until a later phase (P1.6) moves
 * every remaining command over.
 *
 * P1.2 adds the output-lane machinery (lib/envelope.mjs, lib/agent-lane.mjs)
 * behind `ctx.output` and an entry's optional `resultOf(argv, ctx)`
 * producer — see `dispatch`'s doc comment below for the exact contract and
 * the compatibility guarantee (every pre-P1.2 caller is unaffected).
 */
import path from 'node:path';
import { EXIT } from './style.mjs';
import {
  cmdOrient,
  computeOrientResult,
  cmdLearnings,
  cmdStatus,
  computeStatusResult,
  cmdInstallOrUpgrade,
  cmdDoctor,
  cmdInitRepo,
  cmdIndex,
  cmdGate,
  cmdVerify,
  cmdValidatePlan,
  cmdCompound,
  cmdRecall,
  cmdGet,
  cmdEvents,
  cmdReport,
  cmdKnowledge,
  cmdConsolidate,
  cmdRemember,
  cmdLearning,
  cmdEvalKnowledge,
  cmdUninstall,
  cmdResolve,
} from './commands.mjs';
import { cmdPlanNew } from './plan-new.mjs';
import { parseFlags, hasFlag } from './flags.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createEnvelope, createErrorEnvelope, STATUS } from './envelope.mjs';
import { renderAgentLane, recordAgentLaneBytes } from './agent-lane.mjs';
import { EVENT_TYPE, summarizeArgFlags } from './event-registry.mjs';
import { createRedactor, redactedJson } from './redact.mjs';

const REGISTRY = new Map();

// Flags accepted by every registered command today (bin/harness.mjs's
// GLOBAL_OPTIONS, restated as a declarative schema). Strict validation
// merges these into each entry's own flags so a global flag is never
// mistaken for an unknown one.
export const GLOBAL_FLAGS = [
  { name: '--json', type: 'boolean', description: 'JSON output for machine readers', required: false, default: false },
  { name: '--dry-run', type: 'boolean', description: 'print actions without writing', required: false, default: false },
  {
    name: '--verbose',
    aliases: ['-v'],
    type: 'boolean',
    description: 'full detail: per-file logging, all checks, unclamped hints',
    required: false,
    default: false,
  },
  {
    name: '--no-color',
    type: 'boolean',
    description: 'plain ascii output (also honors NO_COLOR; auto when piped)',
    required: false,
    default: false,
  },
  { name: '--workspace', type: 'string', valueName: 'path', description: 'repo root (default: cwd)', required: false, default: null },
  { name: '--copilot-home', type: 'string', valueName: 'path', description: 'override ~/.copilot', required: false, default: null },
  {
    name: '--no-events',
    type: 'boolean',
    description: 'do not write .harness/events.jsonl',
    required: false,
    default: false,
  },
];

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', hint, exit: EXIT.usage });
}

function assertValidEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('registerCommand: entry must be an object');
  }
  if (!entry.name || typeof entry.name !== 'string') {
    throw new Error('registerCommand: entry.name (string) is required');
  }
  if (typeof entry.handler !== 'function') {
    throw new Error(`registerCommand: "${entry.name}" needs a handler(argv, ctx) function`);
  }
  if (!['read', 'mutate', 'execute'].includes(entry.sideEffect)) {
    throw new Error(`registerCommand: "${entry.name}" has an invalid sideEffect "${entry.sideEffect}" (must be read | mutate | execute)`);
  }
}

/** Register one command entry. Entries are data — see the module doc for the shape. */
export function registerCommand(entry) {
  assertValidEntry(entry);
  const args = { flags: [], positionals: [], ...entry.args };
  REGISTRY.set(entry.name, {
    group: 'general',
    capabilities: [],
    outputModes: ['ledger', 'json'],
    ...entry,
    args,
  });
  return entry.name;
}

export function hasCommand(name) {
  return REGISTRY.has(name);
}

export function getCommand(name) {
  return REGISTRY.get(name) || null;
}

export function listCommands() {
  return [...REGISTRY.keys()];
}

function flagIndex(entry) {
  const index = new Map();
  for (const def of [...GLOBAL_FLAGS, ...entry.args.flags]) {
    index.set(def.name, def);
    for (const alias of def.aliases || []) index.set(alias, def);
  }
  return index;
}

/**
 * Strict flag validation for one command's args (NOT including the command
 * name). Throws a structured `E_USAGE` error naming the flag on the first
 * unrecognized one; returns nothing on success. This is intentionally the
 * *only* thing this pass does — it never reinterprets a flag's value, so
 * behavior for every already-known flag is whatever the handler's own
 * `parseFlags`/`parseQueryFromArgv` decides, unchanged.
 *
 * A value-flag only treats its next token as consumed when that token isn't
 * itself another *long* flag (starts with `--`) — matching the existing
 * `--why` precedent in lib/flags.mjs (`next.startsWith('--')`, not a bare
 * `-` check) — so an unknown long flag can never hide by landing in another
 * flag's value slot, while single-dash-shaped values (negative numbers like
 * `-0.5`, dash-prefixed free text or ids) are still consumed as values,
 * exactly like the pre-registry parsing they sit in front of.
 */
export function validateArgs(entry, argv) {
  const known = flagIndex(entry);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    const isFlagShaped = token.startsWith('-') && token !== '-';
    if (!isFlagShaped) continue;
    const eq = token.indexOf('=');
    const flagName = eq === -1 ? token : token.slice(0, eq);
    const def = known.get(flagName);
    if (!def) {
      throw usageError(`unknown flag: ${flagName}`, `harness help ${entry.name}`);
    }
    if (def.type !== 'boolean' && eq === -1) {
      const next = argv[i + 1];
      const nextIsValue = next !== undefined && !next.startsWith('--');
      if (nextIsValue) i++;
    }
  }
}

/**
 * Resolve, strictly validate, and run one registered command.
 *
 * `argv` is `[commandName, ...args]` — the same slice bin/harness.mjs
 * already computes from `process.argv`. `ctx` is `{style, output}` (P1.2):
 * `output` selects the output lane — `'ledger' | 'json' | 'jsonl' | 'agent'`
 * — and `style` is the bound `createStyle()` instance (see lib/style.mjs).
 * `output` defaults to (and any caller omitting it behaves exactly as)
 * `'ledger'`, which routes to the pre-existing handler untouched — every
 * caller from before P1.2 (including every existing test that calls
 * `dispatch(argv, {})`) is therefore unaffected byte-for-byte. Only
 * `'json'` (the NEW versioned envelope — distinct from the legacy `--json`
 * flag, which the handler still owns and renders exactly as before) and
 * `'agent'` currently divert to the new lane machinery, and only for an
 * entry that declares a `resultOf` producer (see `dispatchLane` below).
 *
 * Resolves to the handler's (or the lane renderer's) exit code. Throws the
 * same `{ code: 'E_USAGE', exit: EXIT.usage }` shape for an unregistered
 * command or an unknown flag that every other harness error already uses —
 * bin/harness.mjs's existing top-level catch renders it via
 * `ui.errorBlock` / the `--json` error envelope with no new error-handling
 * path required. Callers that want the switch-fallback behavior described
 * in the Phase 1 plan should check `hasCommand(name)` before calling
 * `dispatch` for that command.
 *
 * P1.5 (lib/event-registry.mjs): when `ctx.events` is supplied (an event
 * registry instance — `{emit, withCommand}`), EVERY registered-command
 * dispatch — whichever branch below actually runs, the legacy handler or
 * `dispatchLane` — is bracketed with `command.start`/`command.result`
 * telemetry (AC7 #3). `ctx.events` is entirely optional and `undefined` for
 * every pre-P1.5 caller (including every existing test that calls
 * `dispatch(argv, {})` or `dispatch(argv, {style, output})`), so this is a
 * no-op branch for them — behavior is byte-for-byte unchanged. In practice,
 * bin/harness.mjs (the one production caller) only ever attaches
 * `ctx.events` for the NEW `--output json-envelope|agent` lanes, never for
 * the legacy ledger/`--json` default path — see its own comment for why
 * (the pilots' existing self-logging via lib/orient.mjs et al. must not be
 * duplicated, and no existing test's exact events.jsonl assertions may
 * change). This function itself does not know or care which lane triggered
 * `ctx.events`'s presence; it wires both branches identically.
 */
export async function dispatch(argv, ctx = {}) {
  const [name, ...rest] = argv;
  const entry = REGISTRY.get(name);
  if (!entry) {
    throw usageError(`unknown command: ${name}`, 'harness help');
  }
  validateArgs(entry, rest);
  const lane = ctx.output;
  assertLaneSupported(entry, lane);
  // Required-argument precondition (registry-declared, not ad hoc): a
  // command invoked without a REQUIRED argument is caller misuse — the same
  // `E_USAGE`/exit-2 class as an unknown flag above, never a bare thrown
  // Error that bin/harness.mjs's catch-all would misclassify as
  // `E_UNEXPECTED`/exit 1 (a harness FAULT, not a usage mistake). Checked
  // here, after flag/lane validation and before any handler or telemetry
  // runs, so a caller can rely on exit 2 to mean "you called it wrong"
  // across every registered command uniformly. `entry.requireArgs` is
  // optional and, like `resultOf`/`supportsJsonl`/`instrument`, declared
  // per entry below — see the "requireArgs predicates" section for why each
  // one is a small, deliberate duplication of a guard its own handler (or a
  // helper it calls) already makes, kept byte-for-byte identical in message
  // text so this is a pure classification fix, not a behavior change.
  if (typeof entry.requireArgs === 'function') {
    const message = entry.requireArgs(rest, parseFlags(rest));
    if (message) throw usageError(message);
  }
  // P1.6 (carry-list, AC7 widening): ctx.events now attaches on every path,
  // including the legacy ledger/--json default — EXCEPT `entry.instrument
  // === false`. The one entry that opts out today is `events` itself: its
  // own handler's whole job is "read and summarize everything in
  // events.jsonl", so instrumenting its OWN dispatch would append that
  // very invocation's command.start to the file an instant before the
  // handler reads it — a self-referential read-your-own-write that
  // silently inflates `harness events`'s own totals/first-row on every
  // single call (reproduced against the pre-fix build: a fixture of 60
  // events read back as 61; three sequential `harness events` calls each
  // saw one more than the last). No other migrated command has this
  // structural hazard (every other command either doesn't read
  // events.jsonl at all, or — like `learnings`, already instrumented since
  // P1.2/P1.5 — filters by a specific lifecycle `type` that command.start
  // never matches, so ordinary event-log growth doesn't corrupt its
  // result). Documented judgment call, not a spec value.
  const instrumented = entry.instrument !== false;
  const events = instrumented && ctx.events && typeof ctx.events.withCommand === 'function' ? ctx.events.withCommand(entry.name) : null;
  // `assertLaneSupported` above already rejected every unsupported
  // (entry, lane) combination, so by this point `lane === 'json' | 'agent'`
  // implies `entry.resultOf` exists, and `lane === 'jsonl'` (verify only)
  // has already been confirmed to fall through to the entry's own handler
  // (lib/commands.mjs#cmdVerify reads `ctx.output === 'jsonl'` itself).
  if (lane === 'json' || lane === 'agent') {
    return dispatchLane(entry, rest, ctx, lane, events);
  }
  return runHandler(entry, rest, ctx, events);
}

// Human-facing spelling for each internal `ctx.output` lane value — the
// vocabulary bin/harness.mjs's `--output <value>` flag actually accepts
// (its OUTPUT_LANES table maps the other direction). Duplicated here rather
// than imported from bin/harness.mjs so this module stays free of any
// dependency on the CLI wrapper — `dispatch()` is called directly by tests,
// and could be called by any future embedder that shares the same
// `ctx.output` contract documented on `dispatch` above.
const LANE_DISPLAY_NAMES = { json: 'json-envelope', agent: 'agent', jsonl: 'jsonl' };

/** One clause per group of commands that share the same lane support, e.g.
 * "orient, learnings, status (--output json-envelope|agent); verify
 * (--output jsonl)". Built from the registry itself, not a hand-maintained
 * list, so a later command that gains `resultOf`/`supportsJsonl` is picked
 * up automatically — the whole point of the Important-3 fix below is that
 * this text can never silently drift from what dispatch() actually
 * enforces. */
function laneBearingCommands() {
  const dispatchLaneCommands = [];
  const jsonlCommands = [];
  for (const candidate of REGISTRY.values()) {
    if (candidate.resultOf) dispatchLaneCommands.push(candidate.name);
    if (candidate.supportsJsonl) jsonlCommands.push(candidate.name);
  }
  const parts = [];
  if (dispatchLaneCommands.length) parts.push(`${dispatchLaneCommands.join(', ')} (--output json-envelope|agent)`);
  if (jsonlCommands.length) parts.push(`${jsonlCommands.join(', ')} (--output jsonl)`);
  return parts.join('; ') || 'none registered';
}

/**
 * Lane-contract honesty (Important-3 fix): a registered command that does
 * not actually support the requested `--output` lane must fail loudly — a
 * structured `E_USAGE` error, exit 2 — instead of silently rendering its
 * ordinary ledger output as if `--output` had never been passed. Pre-fix
 * repro: `harness gate --output json-envelope` printed plain ledger rows
 * with no envelope, no error, and no signal to the caller that its request
 * was ignored; same for any other non-lane-aware command under
 * `json-envelope`/`agent`/`jsonl`.
 *
 * `lane` is `dispatch()`'s own short internal vocabulary (`'json' |
 * 'agent' | 'jsonl'`); `'ledger'` or a falsy lane is always supported and
 * returns immediately. Support is a STRUCTURAL fact about the entry, not a
 * hand-maintained allowlist: `resultOf` is what lets `dispatchLane` render
 * `json`/`agent` for an entry (see `dispatchLane`'s own doc comment above),
 * and `supportsJsonl` is the one explicit opt-in for verify's own
 * streaming special case (its own handler renders it, not `dispatchLane` —
 * see lib/commands.mjs#cmdVerify).
 */
function assertLaneSupported(entry, lane) {
  if (!lane || lane === 'ledger') return;
  let supported = false;
  if (lane === 'json' || lane === 'agent') supported = Boolean(entry.resultOf);
  else if (lane === 'jsonl') supported = entry.supportsJsonl === true;
  if (supported) return;
  throw usageError(
    `command ${entry.name} does not support --output ${LANE_DISPLAY_NAMES[lane] || lane}; lane-bearing commands: ${laneBearingCommands()}`,
    'harness help'
  );
}

// Reverse-maps a numeric exit code back onto the unified status vocabulary
// (ok|failed|cancelled|timed-out) using the SAME fixed EXIT values every
// other lane already treats as significant (lib/envelope.mjs's
// STATUS_EXIT_CODES uses the identical ok/cancelled/timed-out set the other
// direction). Only `ok`, `cancelled`, and `timed-out` map to one exact,
// reserved exit code everywhere they occur; every other exit code is a
// generic failure from this event's point of view — accurate for the three
// P1.1/P1.2 pilots today (their only non-thrown-nonzero-exit outcomes are
// already-handled `E_*` failures), and the same judgment call `dispatchLane`
// itself already makes for its own error branch below.
function statusForExit(exit) {
  if (exit === EXIT.ok) return STATUS.OK;
  if (exit === EXIT.cancelled) return STATUS.CANCELLED;
  if (exit === EXIT.timedOut) return STATUS.TIMED_OUT;
  return STATUS.FAILED;
}

// Best-effort projection of the new unified `status` onto lib/events.mjs's
// existing pass|warn|fail `result` vocabulary, so `harness events --summary`
// keeps counting these new event types sensibly instead of falling through
// to that module's own generic exitCode-based guess (which has no
// cancelled/timed-out cases and would misclassify exit 130 as a "pass").
// ok -> pass, failed -> fail, cancelled|timed-out -> warn (interrupted, not
// necessarily a code defect). A documented judgment call, not a spec value.
// NOTE (review round 1): because cancelled/timed-out map to 'warn' here, not
// 'fail', such a run will NOT surface under `harness events --failures`
// (lib/events.mjs's failures filter only keeps `result === 'fail'` or an
// explicit `decision: 'block'`/`blockedReason`) — only its own dedicated
// `status: 'cancelled'|'timed-out'` field distinguishes it from an ordinary
// warning once read back. Flagging for anyone querying `--failures` and
// expecting cancelled/timed-out runs to appear there.
function legacyResultForStatus(status) {
  if (status === STATUS.OK) return 'pass';
  if (status === STATUS.FAILED) return 'fail';
  return 'warn';
}

function commandResultPayload(status, durationMs, exitCode) {
  return { status, result: legacyResultForStatus(status), durationMs, exitCode };
}

// Review round 1 (Important): command.start and agent_lane events carry no
// command OUTCOME of their own — command.start fires before the handler
// even runs, and agent_lane is a byte-count metering record, not a
// pass/fail signal. lib/events.mjs's writeEvent() computes a `result` field
// via eventResult({result, exitCode, checks}), which — when neither
// `result` nor a meaningful `exitCode`/`checks` is supplied — DEFAULTS TO
// 'pass'. Left unset, every command.start and agent_lane event would
// silently inflate `harness events --summary`'s pass count (reproduced: one
// successful pilot run showed pass:3 for a single real outcome; a FAILING
// `learnings --why <bad-id>` run showed pass:1/fail:1 — a phantom 50% pass
// rate for a command that failed outright). PENDING_RESULT is an explicit,
// non-tallied marker: eventResult()'s `if (result) return result` short-
// circuits to 'pending' verbatim, and summarizeEvents' pass/warn/fail
// tally (an exact `===` match against those three strings) does not
// recognize it, so it is counted in `summary.total` but in none of
// pass/warn/fail — and it carries no `decision`/`blockedReason`, so it is
// also excluded by `harness events --failures`. lib/events.mjs itself is
// NOT modified for this — PENDING_RESULT only ever appears as an explicit
// payload value on the two event types below.
const PENDING_RESULT = 'pending';

/**
 * Run a registered command's legacy handler (the ledger/default path),
 * optionally bracketed with command.start/command.result telemetry — see
 * `dispatch`'s doc comment above for when `events` is non-null. Re-throws
 * whatever the handler throws, unmodified, so bin/harness.mjs's existing
 * top-level error rendering (`emitError`, exit-code selection) is completely
 * unaffected by this wrapper.
 */
async function runHandler(entry, rest, ctx, events) {
  const startedAt = Date.now();
  events?.emit(EVENT_TYPE.COMMAND_START, { flags: summarizeArgFlags(rest, flagIndex(entry)), result: PENDING_RESULT });
  try {
    const exit = await entry.handler(rest, ctx);
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(statusForExit(exit), Date.now() - startedAt, exit));
    return exit;
  } catch (err) {
    const exit = Number.isInteger(err.exit) ? err.exit : 1;
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(statusForExit(exit), Date.now() - startedAt, exit));
    throw err;
  }
}

/**
 * Render one command through the NEW envelope/agent lane machinery
 * (P1.2's opt-in surface — see the module doc and dispatch()'s doc above).
 * `entry.resultOf(argv, ctx)` computes the SAME canonical result data the
 * entry's legacy `handler` already prints internally — see each `resultOf`
 * below for why it is a small, deliberate duplication of a few branches
 * from lib/commands.mjs rather than a shared extraction (this task's file
 * ownership excludes lib/commands.mjs; a later phase migrating every
 * command onto the registry is the natural place to remove the
 * duplication).
 *
 * Success always carries `status: 'ok'` here — true for all three P1.2
 * pilots today, since each already always exits 0 on its success paths (see
 * their `resultOf` functions: the two branches that don't are usage/target
 * errors, which THROW instead of returning `pass:false`, and are handled by
 * the catch branch below with their own real exit codes). A future
 * registered command with a native non-zero-but-not-thrown outcome can
 * extend this when it is migrated — not needed yet.
 *
 * P1.5 additions (lib/event-registry.mjs), both gated on `events` (see
 * `dispatch`'s doc comment — non-null only when `ctx.events` was supplied):
 *   - command.start/command.result bracket the whole call, on both the
 *     success and error paths (AC7 #3).
 *   - AC10: wherever this function actually renders the agent lane (success
 *     OR error branch — both call `renderAgentLane` today), it calls
 *     `recordAgentLaneBytes` right after, so an `agent_lane` event records
 *     the rendered byte count. `recordAgentLaneBytes` (lib/agent-lane.mjs,
 *     unmodified/off-limits) expects an `eventsApi.writeEvent(record)`
 *     shape; `events.emit(record.type, record)` adapts the command-scoped
 *     emitter to exactly that call shape without lib/agent-lane.mjs needing
 *     to know this registry exists.
 */
async function dispatchLane(entry, rest, ctx, lane, events) {
  const schema = 1;
  const startedAt = Date.now();
  // Critical fix: the json-envelope branch (the `else` below, both success
  // and error) used to serialize `envelope`/`errorEnvelope` via a bare
  // `JSON.stringify` — no redaction at all — while the `agent` branch right
  // next to it already ran the SAME data through `renderAgentLane`'s
  // redactor. Both branches render the identical command result data (a
  // `--why` id, an echoed query, an error message built from caller input),
  // so both must pass through the SAME data-boundary discipline before
  // anything is written to stdout/stderr. One redactor instance, shared by
  // both branches below (mirrors `ctx.redactor || createRedactor()` — the
  // agent branch's own default, made explicit here since the json-envelope
  // branch has no other component to default it for).
  const redactor = ctx.redactor || createRedactor();
  events?.emit(EVENT_TYPE.COMMAND_START, { flags: summarizeArgFlags(rest, flagIndex(entry)), result: PENDING_RESULT });
  try {
    const result = await entry.resultOf(rest, ctx);
    const envelope = createEnvelope({ command: entry.name, schema, status: STATUS.OK, ...result });
    if (lane === 'agent') {
      const rendered = renderAgentLane(envelope, {
        budgetBytes: entry.agentBudgetBytes,
        redactor,
        inert: ctx.inert,
      });
      // Fix-wave Minor #11: `rendered.text` is already newline-terminated
      // and that newline is inside `rendered.bytes` and the budget — write
      // it verbatim so the metered agent_lane byte count equals the bytes
      // actually emitted (pre-fix, a '\n' was appended here OUTSIDE the
      // budget/metering).
      process.stdout.write(rendered.text);
      if (events) recordAgentLaneBytes({ writeEvent: (record) => events.emit(record.type, { ...record, result: PENDING_RESULT }) }, entry.name, rendered.bytes);
    } else {
      // lane === 'json' (or any future lane this entry doesn't specialize
      // for) — the versioned envelope is always a safe default rendering.
      // Redacted (see the fix comment above) via the shared emission
      // boundary before it ever reaches stdout.
      console.log(redactedJson(envelope, { redactor }));
    }
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(STATUS.OK, Date.now() - startedAt, EXIT.ok));
    return EXIT.ok;
  } catch (err) {
    const exit = Number.isInteger(err.exit) ? err.exit : 1;
    const status = err.code === 'E_CANCELLED' ? STATUS.CANCELLED : err.code === 'E_TIMEOUT' ? STATUS.TIMED_OUT : STATUS.FAILED;
    const errorEnvelope = createErrorEnvelope({
      command: entry.name,
      schema,
      status,
      code: err.code || 'E_UNEXPECTED',
      message: err.message,
      fix: err.hint,
      exit,
    });
    if (lane === 'agent') {
      const rendered = renderAgentLane(errorEnvelope, {
        budgetBytes: entry.agentBudgetBytes,
        redactor,
        inert: ctx.inert,
      });
      // Fix-wave Minor #11: same as the success branch — the newline lives
      // inside the budgeted, metered text.
      process.stdout.write(rendered.text);
      if (events) recordAgentLaneBytes({ writeEvent: (record) => events.emit(record.type, { ...record, result: PENDING_RESULT }) }, entry.name, rendered.bytes);
    } else {
      // Redacted for the same reason as the success branch above — an
      // error's `message`/`fix` is frequently built directly from caller
      // input (e.g. learnings' `no learning ${flags.why}`), so it carries
      // exactly the same secret-leak risk as the success envelope.
      console.error(redactedJson(errorEnvelope, { redactor }));
    }
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(status, Date.now() - startedAt, exit));
    return exit;
  }
}

// --- resultOf producers (P1.2): the canonical result data behind each
// pilot's legacy `--json` output. P1.6 (carry-list a): now that
// lib/commands.mjs is editable, `orient` and `status` call the SAME shared
// helper their own cmdX counterpart uses (computeOrientResult/
// computeStatusResult, exported from commands.mjs) instead of duplicating
// its body — collapsing that duplication, and the former local
// readHarnessVersion (now commands.mjs's own exported readPkgVersion).
// `learnings` still duplicates a handful of lines from cmdLearnings on
// purpose: cmdLearnings' branching human/JSON rendering around the same
// two usage/target guards is intricate and heavily tested
// (test/learnings-listing.test.mjs) — collapsing it would mean reshaping
// cmdLearnings' own control flow around a throw/return split for a
// cosmetic dedup, a disproportionate regression risk for this carry-list
// item. Flagged in the P1.6 report as a deliberate, bounded scope call.

async function orientResultOf(argv) {
  const { result } = await computeOrientResult(argv);
  return result;
}

async function learningsResultOf(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const { listingView, whyView } = await import('./knowledge/listing.mjs');

  // Mirrors cmdLearnings' own two usage/target guards exactly (including
  // the trailing-bare-`--why` case parseFlags itself can't detect), but
  // THROWS instead of returning `{pass:false, ...}` — dispatchLane's catch
  // branch turns this into the unified error envelope with the SAME exit
  // codes cmdLearnings already returns for these cases (EXIT.usage / 1).
  if (hasFlag(argv, '--why') && !flags.why) {
    throw usageError('usage: harness learnings --why <id>', 'harness learnings --why <id>');
  }
  if (flags.why) {
    const result = whyView({ workspace, id: flags.why });
    if (!result) {
      throw Object.assign(new Error(`no learning ${flags.why}`), { code: 'E_TARGET', exit: 1 });
    }
    return result;
  }

  const domain = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  return listingView({ workspace, copilotHome, domain });
}

async function statusResultOf(argv) {
  const { copilotHome, lock, version } = computeStatusResult(argv);
  return { packageVersion: version, copilotHome, lock };
}

// --- requireArgs predicates: dispatch()'s optional per-entry REQUIRED-
// argument precondition (see dispatch()'s own comment above). Each predicate
// is `(rest, flags) => string | undefined` — `rest` is the raw per-command
// argv dispatch() already has, `flags` is the SAME `parseFlags(rest)` result
// computed once by dispatch() before calling it. Returning a string means
// "unsatisfied" — dispatch() throws it as a structured `E_USAGE` error;
// returning nothing means the precondition holds and dispatch proceeds to
// the handler as normal.
//
// Every message below is copied byte-for-byte from the handler-side guard
// it front-runs, which stays in place (unreachable defense-in-depth for any
// caller that reaches the handler directly rather than through dispatch —
// e.g. a test importing the handler/helper itself) — this section only
// changes WHERE the same check runs and WHAT it throws, never the text a
// caller sees.

// recall: the query can come from EITHER free-text positional words OR
// --query (lib/argv.mjs#parseQueryFromArgv decides which — reused here
// verbatim so this can never drift from what lib/recall-cmd.mjs#runRecall's
// own identical guard treats as "present").
function recallRequireArgs(rest, flags) {
  const query = parseQueryFromArgv(rest, flags);
  if (!query) return 'recall requires a query string, e.g. harness recall "orders timeout"';
}

// get: --docid and --path are each individually optional, but at least one
// is required — an either/or pair, not a single required flag. Mirrors
// lib/get-cmd.mjs#runGet's own guard.
function getRequireArgs(rest, flags) {
  if (!flags.docid && !flags.path) {
    return 'get requires --docid <id> or --path <relative-path>';
  }
}

// plan-new: --slug and --intent have no default (unlike --type/--risk/date,
// which do — see lib/plan-new.mjs#buildPlanSkeleton's own destructuring
// defaults), so these two are plan-new's genuinely required arguments,
// matching the registry's own `required: true` on both below. (--type is
// ALSO marked `required: true` below, but buildPlanSkeleton defaults it to
// 'feat' when omitted — omitting it is not an error today, so it is left
// out of this predicate on purpose; its own bad-VALUE guard, reachable only
// when --type IS explicitly supplied, is unchanged — out of this fix's
// scope, a documented judgment call, not a spec value.) Re-parses `rest`
// the same greedy, last-token-wins way lib/plan-new.mjs#cmdPlanNew's own
// argv loop reads every flag (lib/flags.mjs#parseFlags doesn't know --slug
// or --intent — plan-new's loop is bespoke), honoring the same `--` literal
// boundary every other harness arg reader does.
const PLAN_NEW_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function planNewFlagValue(rest, name) {
  let value;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') break;
    if (rest[i] === name) value = rest[++i];
  }
  return value;
}

function planNewRequireArgs(rest) {
  const slug = planNewFlagValue(rest, '--slug');
  if (!slug || !PLAN_NEW_SLUG_RE.test(slug)) {
    return 'plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)';
  }
  const intent = planNewFlagValue(rest, '--intent');
  if (!intent || !intent.trim()) {
    return 'plan-new: --intent is required';
  }
}

function flagLabel(def) {
  const names = [def.name, ...(def.aliases || [])];
  return def.type === 'boolean' ? names.join(', ') : `${names.join(', ')} <${def.valueName || 'value'}>`;
}

function buildUsage(entry) {
  const parts = [];
  for (const p of entry.args.positionals) {
    parts.push(p.required ? `<${p.name}>` : `[${p.name}]`);
  }
  for (const f of entry.args.flags) {
    const label = f.type === 'boolean' ? f.name : `${f.name} <${f.valueName || 'value'}>`;
    parts.push(f.required ? label : `[${label}]`);
  }
  return parts.join(' ');
}

/**
 * Registry-generated help data for one command, shaped so the existing
 * design-system help rendering (bin/harness.mjs's `renderCommandHelp`,
 * which paints through lib/style.mjs) can consume it: a usage signature
 * plus an `[flagLabel, description]` options list, the same pair shape the
 * hand-written CATALOG entries (P1.6: retired — this function is now the
 * only source of `harness help`/`harness help <command>` data) already
 * used. Returns `null` for an unregistered command.
 *
 * `entry.usage`, when present, is used verbatim instead of the
 * flags/positionals auto-generated signature — an escape hatch for the
 * handful of commands whose usage line is genuinely subcommand/alternation
 * syntax (`knowledge`, `learning`, `consolidate`, `report`) rather than a
 * flat flag list; every other command's usage is fully data-driven from
 * `args.flags`/`args.positionals`.
 */
export function describeCommand(name) {
  const entry = REGISTRY.get(name);
  if (!entry) return null;
  return {
    name: entry.name,
    summary: entry.summary,
    group: entry.group,
    sideEffect: entry.sideEffect,
    capabilities: entry.capabilities,
    outputModes: entry.outputModes,
    usage: entry.usage ?? buildUsage(entry),
    options: entry.args.flags.map((f) => [flagLabel(f), f.description || '']),
  };
}

/** `describeCommand` for every registered command, in registration order. */
export function describeAll() {
  return listCommands().map(describeCommand);
}

// --- Pilot migration (P1.1): orient, learnings, status -------------------
// Handlers are the existing lib/commands.mjs functions, unchanged — the
// registry only adds strict flag validation in front of them.

registerCommand({
  name: 'orient',
  summary: 'context pack for a task',
  group: 'engineer loop',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: {
    positionals: [
      {
        name: 'query',
        description: 'free-text query words (joined; same as --query)',
        required: false,
        default: '',
        variadic: true,
      },
    ],
    flags: [
      { name: '--query', type: 'string', valueName: 'text', description: 'agent/internal task summary', required: false, default: null },
      { name: '--limit', type: 'number', valueName: 'n', description: 'recall result count (default 3)', required: false, default: 3 },
      {
        name: '--collection',
        aliases: ['-c'],
        type: 'string',
        valueName: 'name',
        description: 'filter by knowledge/collections.yaml',
        required: false,
        default: null,
      },
      { name: '--min-score', type: 'number', valueName: 'n', description: 'minimum score (default 0.15)', required: false, default: 0.15 },
      { name: '--explain', type: 'boolean', description: 'decompose learning ranking (deterministic)', required: false, default: false },
    ],
  },
  handler: cmdOrient,
  resultOf: orientResultOf,
});

registerCommand({
  name: 'learnings',
  summary: 'paged listing of learnings with provenance and failure annotations',
  group: 'knowledge',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: {
    positionals: [{ name: 'domain', description: 'filter by learning domain directory', required: false, default: null }],
    flags: [
      {
        name: '--why',
        type: 'string',
        valueName: 'id',
        description: 'full provenance chain for one learning',
        required: false,
        default: null,
      },
    ],
  },
  handler: cmdLearnings,
  resultOf: learningsResultOf,
});

registerCommand({
  name: 'status',
  summary: 'installed version, home, tracked files',
  group: 'setup',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: { positionals: [], flags: [] },
  handler: cmdStatus,
  resultOf: statusResultOf,
});

// --- P1.6: the remaining command groups — the rest of the former switch ---
// Handlers are the existing lib/commands.mjs (or lib/plan-new.mjs) functions,
// completely unchanged; the registry only adds strict flag validation and
// (for the pilots above) the lane machinery in front of them. None of these
// declare a `resultOf` — they stay on the `'ledger'` default forever (a
// documented, valid choice per P1.2's own report: not every command needs
// the envelope/agent lanes), except `verify`, whose own handler
// (lib/commands.mjs#cmdVerify) special-cases `ctx.output === 'jsonl'`
// itself for AC8's streaming lane — see lib/verify.mjs.
//
// Flag lists below are deliberately broader than the old hand-written
// CATALOG's visible `options` in a few places (documented per entry) —
// every additional flag was independently verified to be read somewhere in
// that command's own call chain (directly via `flags.x`, or via `argv.
// includes('--x')`), so strict validation never rejects a previously
// working, if previously undocumented, invocation. A flag that has zero
// effect on a command (never read anywhere) is NOT included, even if
// `lib/flags.mjs` happens to parse it globally — AC2's whole point is to
// stop silently accepting flags that don't do anything for that command.

// --- setup ------------------------------------------------------------

const INSTALL_FLAGS = [
  { name: '--target', type: 'string', valueName: 't,..', description: 'vscode,cli,intellij', required: false, default: null },
  { name: '--autonomy', type: 'string', valueName: 'mode', description: 'full | balanced | strict', required: false, default: null },
  { name: '--configure-vscode', type: 'boolean', description: 'merge VS Code chat.* discovery settings', required: false, default: false },
  { name: '--configure-path', type: 'boolean', description: 'append ~/.copilot/bin to shell PATH (~/.zshrc, ~/.bashrc)', required: false, default: false },
  { name: '--force-profile', type: 'boolean', description: 'overwrite knowledge/profile.md', required: false, default: false },
  { name: '--force-knowledge-reset', type: 'boolean', description: 'overwrite knowledge/solutions (danger)', required: false, default: false },
  // Undocumented in the old CATALOG but genuinely read (lib/sync.mjs) —
  // the explicit opposite of --force-knowledge-reset, defaults true either way.
  { name: '--preserve-knowledge', type: 'boolean', description: 'keep existing knowledge/solutions (default)', required: false, default: true },
];

registerCommand({
  name: 'install',
  summary: 'hydrate skills, agents, and team knowledge globally',
  group: 'setup',
  sideEffect: 'mutate',
  args: { positionals: [], flags: INSTALL_FLAGS },
  handler: (argv) => cmdInstallOrUpgrade('install', argv),
});

registerCommand({
  name: 'upgrade',
  summary: 're-hydrate and purge retired primitives',
  group: 'setup',
  sideEffect: 'mutate',
  args: { positionals: [], flags: INSTALL_FLAGS },
  handler: (argv) => cmdInstallOrUpgrade('upgrade', argv),
});

registerCommand({
  name: 'doctor',
  summary: 'health checks for install, hooks, and knowledge',
  group: 'setup',
  sideEffect: 'read',
  args: {
    positionals: [],
    flags: [
      { name: '--host', type: 'string', valueName: 'name', description: 'run host-specific checks (vscode executes installed-hook probes)', required: false, default: null },
    ],
  },
  handler: cmdDoctor,
});

registerCommand({
  name: 'uninstall',
  summary: 'remove hydrated files tracked by the lock',
  group: 'setup',
  sideEffect: 'mutate',
  args: { positionals: [], flags: [] },
  handler: cmdUninstall,
});

// --- workspace ----------------------------------------------------------

registerCommand({
  name: 'init-repo',
  summary: 'seed the .harness workspace in a product repo',
  group: 'workspace',
  sideEffect: 'mutate',
  args: { positionals: [], flags: [] },
  handler: cmdInitRepo,
});

registerCommand({
  name: 'index',
  summary: 'rebuild knowledge index · --status reports drift',
  group: 'workspace',
  sideEffect: 'mutate',
  args: {
    positionals: [],
    flags: [{ name: '--status', type: 'boolean', description: 'read-only freshness report vs HEAD (never rebuilds)', required: false, default: false }],
  },
  handler: cmdIndex,
});

registerCommand({
  name: 'plan-new',
  summary: 'scaffold a gate-ready plan',
  group: 'workspace',
  sideEffect: 'mutate',
  args: {
    positionals: [],
    flags: [
      { name: '--type', type: 'string', valueName: 't', description: 'feat|fix|docs|refactor|chore', required: true, default: null },
      { name: '--slug', type: 'string', valueName: 's', description: 'lowercase-hyphen slug', required: true, default: null },
      { name: '--intent', type: 'string', valueName: 'text', description: 'one-line intent', required: true, default: null },
      { name: '--impacted', type: 'string', valueName: 'a,b', description: 'comma-separated Impacted Files', required: false, default: null },
      { name: '--criteria', type: 'string', valueName: 'text', description: 'an acceptance criterion (repeatable)', required: false, default: null },
      { name: '--gap', type: 'string', valueName: 'id:path', description: 'capability gap → blocked-capability + governed primitive plan', required: false, default: null },
      { name: '--stdout', type: 'boolean', description: 'print the plan instead of writing it', required: false, default: false },
      // Undocumented in the old CATALOG, but cmdPlanNew's own bespoke argv
      // loop (lib/plan-new.mjs) genuinely reads all three.
      { name: '--title', type: 'string', valueName: 'text', description: 'plan heading override (default: derived from slug)', required: false, default: null },
      { name: '--date', type: 'string', valueName: 'yyyy-mm-dd', description: 'override the plan filename date (default: today)', required: false, default: null },
      { name: '--risk', type: 'string', valueName: 'green|amber|red', description: 'risk rating (default green)', required: false, default: null },
    ],
  },
  handler: cmdPlanNew,
  requireArgs: planNewRequireArgs,
});

// --- engineer loop --------------------------------------------------------

registerCommand({
  name: 'gate',
  summary: 'edit preconditions before editFiles',
  group: 'engineer loop',
  sideEffect: 'mutate',
  args: {
    positionals: [{ name: 'query', description: 'free-text query words (plan-ranking only)', required: false, default: '', variadic: true }],
    flags: [
      { name: '--phase', type: 'string', valueName: 'name', description: 'implement | verify', required: false, default: 'implement' },
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null },
      { name: '--strict-intent', type: 'boolean', description: 'fail locked plans missing intent fields', required: false, default: false },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null },
    ],
  },
  handler: cmdGate,
});

registerCommand({
  name: 'verify',
  summary: 'run trusted named checks and capture evidence',
  group: 'engineer loop',
  sideEffect: 'execute',
  // No `resultOf` (verify's canonical result isn't duplicated for
  // dispatchLane — see the P1.6 comment on the resultOf producers below),
  // but it DOES support one lane on its own: `--output jsonl` is handled
  // entirely inside its own handler (lib/commands.mjs#cmdVerify reads
  // `ctx.output === 'jsonl'` itself). `supportsJsonl` is the explicit,
  // structural opt-in `assertLaneSupported`/`laneBearingCommands` (this
  // module) key off of — without it, `verify --output jsonl` would now be
  // rejected by the Important-3 lane-contract-honesty guard alongside every
  // other command that doesn't actually support the lane it was asked for.
  supportsJsonl: true,
  args: {
    positionals: [],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'plan file whose named checks run', required: false, default: null },
      { name: '--base', type: 'string', valueName: 'git-ref', description: 'compare changed files to this git ref', required: false, default: null },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null },
      // Undocumented in the old CATALOG, but read (lib/commands.mjs#cmdVerify)
      // and directly tested end to end.
      { name: '--learnings', type: 'string', valueName: 'a,b', description: 'learning ids cited by this verified change', required: false, default: null },
    ],
  },
  handler: cmdVerify,
});

registerCommand({
  name: 'validate-plan',
  summary: 'plan readiness checks',
  group: 'engineer loop',
  sideEffect: 'read',
  args: {
    positionals: [],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null },
      // Undocumented in the old CATALOG, but read (lib/validate-plan.mjs)
      // and directly tested end to end.
      { name: '--strict-intent', type: 'boolean', description: 'fail locked plans missing intent fields', required: false, default: false },
    ],
  },
  handler: cmdValidatePlan,
});

registerCommand({
  name: 'compound',
  summary: 'record learning from passed evidence · --insight captures without evidence',
  group: 'engineer loop',
  sideEffect: 'mutate',
  args: {
    positionals: [],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null },
      { name: '--insight', type: 'boolean', description: 'evidence-free investigation capture (kind: insight, secret-scanned)', required: false, default: false },
      { name: '--title', type: 'string', valueName: 't', description: 'insight title (required with --insight)', required: false, default: null },
      { name: '--body', type: 'string', valueName: 'text', description: 'insight body text', required: false, default: null },
      { name: '--body-file', type: 'string', valueName: 'path', description: 'read insight body from a file', required: false, default: null },
      { name: '--category', type: 'string', valueName: 'c', description: 'docs/solutions/<category>/ (default insights)', required: false, default: null },
      { name: '--tags', type: 'string', valueName: 'a,b', description: 'comma-separated tags', required: false, default: null },
      { name: '--trigger', type: 'string', valueName: 't', description: 'applicability condition frontmatter', required: false, default: null },
      { name: '--claim', type: 'string', valueName: 't', description: 'one-line claim frontmatter', required: false, default: null },
      // Undocumented in the old CATALOG, but read (lib/compound.mjs, via
      // loadPolicy) for both --insight and evidence-bound compound.
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null },
    ],
  },
  handler: cmdCompound,
});

registerCommand({
  name: 'recall',
  summary: 'search team knowledge',
  group: 'engineer loop',
  sideEffect: 'read',
  args: {
    positionals: [{ name: 'query', description: 'free-text search terms (joined)', required: false, default: '', variadic: true }],
    flags: [
      { name: '--limit', type: 'number', valueName: 'n', description: 'result count (default 3)', required: false, default: 3 },
      { name: '--collection', aliases: ['-c'], type: 'string', valueName: 'name', description: 'filter by knowledge/collections.yaml', required: false, default: null },
      { name: '--min-score', type: 'number', valueName: 'n', description: 'minimum score (default 0.15)', required: false, default: 0.15 },
      { name: '--include-plans', type: 'boolean', description: 'include matching plans', required: false, default: false },
    ],
  },
  handler: cmdRecall,
  requireArgs: recallRequireArgs,
});

registerCommand({
  name: 'get',
  summary: 'bounded doc excerpt',
  group: 'engineer loop',
  sideEffect: 'read',
  args: {
    positionals: [],
    flags: [
      { name: '--docid', type: 'string', valueName: 'id', description: 'manifest doc id', required: false, default: null },
      { name: '--path', type: 'string', valueName: 'rel', description: 'relative file path', required: false, default: null },
      { name: '--lines', type: 'number', valueName: 'n', description: 'max lines (default 40)', required: false, default: 40 },
      { name: '--max-bytes', type: 'number', valueName: 'n', description: 'max excerpt bytes (default 2048)', required: false, default: 2048 },
    ],
  },
  handler: cmdGet,
  requireArgs: getRequireArgs,
});

registerCommand({
  name: 'events',
  summary: 'session telemetry',
  group: 'engineer loop',
  sideEffect: 'read',
  // See dispatch()'s own comment: `events` reads and summarizes the whole
  // events.jsonl file, so instrumenting ITS OWN dispatch would corrupt its
  // own read window (self-referential read-your-own-write).
  instrument: false,
  args: {
    positionals: [],
    flags: [
      { name: '--session', type: 'string', valueName: 'id', description: 'filter by host session ID', required: false, default: null },
      { name: '--summary', type: 'boolean', description: 'aggregate summary only', required: false, default: false },
      { name: '--failures', type: 'boolean', description: 'failed or blocked events only', required: false, default: false },
      { name: '--limit', type: 'number', valueName: 'n', description: 'event count (default 20)', required: false, default: 20 },
    ],
  },
  handler: cmdEvents,
});

registerCommand({
  name: 'report',
  summary: 'token-efficiency report from telemetry',
  group: 'engineer loop',
  // mutate, not read: --sync (lib/commands.mjs#cmdReport -> syncWorkspaceEvents,
  // lib/telemetry-store.mjs) performs real fs.mkdirSync/appendFileSync writes
  // to the global ~/.harness telemetry store — same mutating-capability rule
  // already applied to consolidate/gate/plan-new/index (default invocation
  // read-only, but classified by capability) and install/upgrade (writes to
  // the equally-global ~/.copilot).
  sideEffect: 'mutate',
  // AC14: `harness report [--sync] [--global] [--check] [--json]` stays
  // documented verbatim — an explicit usage override (buildUsage can't
  // reproduce the `--json` mention, since --json is a global flag, not one
  // of report's own).
  usage: '[--sync] [--global] [--check] [--json]',
  // Fix-wave Important #8: same structural hazard as `events` (see
  // dispatch()'s comment) — `report` READS events.jsonl (loadReportEvents),
  // so instrumenting its own dispatch appends this invocation's pending
  // command.start an instant before the handler reads the file: report
  // observes its own not-yet-resolved event, and `--sync` then copies that
  // phantom row into the global ~/.harness store where it skews every
  // cross-workspace report thereafter. Opt out, exactly like `events`.
  instrument: false,
  args: {
    positionals: [],
    flags: [
      { name: '--sync', type: 'boolean', description: 'merge workspace events into the global store first', required: false, default: false },
      { name: '--global', type: 'boolean', description: 'report across all synced workspaces', required: false, default: false },
      { name: '--check', type: 'boolean', description: 'exit non-zero on a budget breach (CI)', required: false, default: false },
      // Undocumented in the old CATALOG, but read (lib/commands.mjs#cmdReport
      // -> collectHostUsage) to select a specific host's usage log.
      { name: '--host', type: 'string', valueName: 'name', description: 'host usage log to overlay (default: auto-detect)', required: false, default: null },
    ],
  },
  handler: cmdReport,
});

// --- knowledge ------------------------------------------------------------

registerCommand({
  name: 'knowledge',
  summary: 'knowledge layer mode switch and purge (human deletion always wins)',
  group: 'knowledge',
  sideEffect: 'mutate',
  // Subcommand/alternation syntax (`<on|suggest|...>`, `purge <file|--all>`,
  // `commit <none|repo>`, `migrate-store`) — not a flat flag list, so this is
  // an explicit `usage` override rather than an auto-generated signature.
  usage: '<on|suggest|off|freeze|capture-only> | --status | purge <file|--all> | commit <none|repo> | migrate-store',
  args: {
    positionals: [
      { name: 'subcommand', description: 'on|suggest|off|freeze|capture-only|purge|commit|migrate-store', required: false, default: null },
      { name: 'target', description: 'purge target, or the commit mode (none|repo)', required: false, default: null },
    ],
    flags: [
      // --status has no reader in cmdKnowledge (the bare/no-subcommand
      // branch already IS the status view) — declared anyway so the
      // pre-registry no-op invocation `harness knowledge --status` keeps
      // validating, matching the old CATALOG's documented `--status` option.
      { name: '--status', type: 'boolean', description: 'show the active mode (default)', required: false, default: false },
      // `purge --all` reads this flag-shaped token directly off argv[1]
      // (cmdKnowledge), never through lib/flags.mjs — still flag-shaped, so
      // strict validation needs it declared or it rejects as unknown.
      { name: '--all', type: 'boolean', description: 'purge --all: reset the whole learnings store', required: false, default: false },
    ],
  },
  handler: cmdKnowledge,
});

registerCommand({
  name: 'consolidate',
  summary: 'episode→learning debt, work packet, and validated apply',
  group: 'knowledge',
  sideEffect: 'mutate',
  usage: '[--status | --candidates | --apply --ops <path> | --rebuild --yes]',
  args: {
    positionals: [],
    flags: [
      // --status has no reader (the default/no-flag branch already IS the
      // status view) — declared for the same no-op-but-documented reason as
      // `knowledge --status` above.
      { name: '--status', type: 'boolean', description: 'debt vs threshold, quarantine, promotion candidates (default)', required: false, default: false },
      { name: '--candidates', type: 'boolean', description: 'deterministic work packet for the consolidation skill', required: false, default: false },
      { name: '--apply', type: 'boolean', description: 'validate and apply an ops JSON (sole writer); suggest mode requires --yes', required: false, default: false },
      { name: '--ops', type: 'string', valueName: 'path', description: 'ops JSON path (with --apply)', required: false, default: null },
      { name: '--rebuild', type: 'boolean', description: 'T2 reset for model-upgrade regeneration (git history retains learnings)', required: false, default: false },
      { name: '--yes', type: 'boolean', description: 'confirm --apply (suggest mode) or --rebuild', required: false, default: false },
    ],
  },
  handler: cmdConsolidate,
});

registerCommand({
  name: 'remember',
  summary: 'teach the harness a durable claim (human-teaching episode + learning)',
  group: 'knowledge',
  sideEffect: 'mutate',
  args: {
    positionals: [{ name: 'claim', description: 'the durable claim text', required: true, default: null }],
    flags: [
      { name: '--trigger', type: 'string', valueName: 't', description: 'applicability condition (required)', required: true, default: null },
      { name: '--domain', type: 'string', valueName: 'd', description: 'learning domain directory (default general)', required: false, default: null },
      // Undocumented in the old CATALOG, but read (lib/knowledge/remember.mjs
      // threads its whole `flags` object into the underlying insight write).
      { name: '--category', type: 'string', valueName: 'c', description: 'docs/solutions/<category>/ (default teachings)', required: false, default: null },
      { name: '--tags', type: 'string', valueName: 'a,b', description: 'comma-separated tags', required: false, default: null },
    ],
  },
  handler: cmdRemember,
});

registerCommand({
  name: 'learning',
  summary: 'human authority over one learning: retire, dispute, confirm, or promote',
  group: 'knowledge',
  sideEffect: 'mutate',
  usage: '<retire|dispute|confirm|promote> <id> [--reason "<r>"] [--to <path>]',
  args: {
    positionals: [
      { name: 'action', description: 'retire|dispute|confirm|promote', required: true, default: null },
      { name: 'id', description: 'the learning id', required: true, default: null },
    ],
    flags: [
      { name: '--reason', type: 'string', valueName: 'r', description: 'required for retire/dispute; recorded in the store commit', required: false, default: null },
      { name: '--to', type: 'string', valueName: 'path', description: 'primitive path recorded on promote (behavior supersedes knowledge)', required: false, default: null },
    ],
  },
  handler: cmdLearning,
});

registerCommand({
  name: 'eval-knowledge',
  summary: 'deterministic retrieval eval — hit/false-surface/token cost per arm (proxy, not net-benefit)',
  group: 'knowledge',
  sideEffect: 'read',
  args: { positionals: [], flags: [] },
  handler: cmdEvalKnowledge,
});

// --- utility ----------------------------------------------------------

registerCommand({
  name: 'resolve',
  summary: 'print the resolved harness CLI path for agents',
  group: 'utility',
  sideEffect: 'read',
  args: { positionals: [], flags: [] },
  handler: cmdResolve,
});
