/**
 * Command registry — the single source of truth for what a harness command
 * *is*: name, one-line job, declared args, side-effect class, required
 * capabilities, and which output lanes it renders today. This is data, not
 * convention — later phases' policy (P3) and run journal (P4) consume the
 * same entries (see docs/plans/2026-07-29-harness-cli-phase1-core.md).
 *
 * `dispatch(argv, ctx)` resolves a registered command from `argv[0]`,
 * validates its flags strictly (an unknown flag is rejected, never
 * silently dropped — AC2), and calls the entry's handler with the
 * remaining args. A handler has the exact signature every existing
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
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from './style.mjs';
import { cmdOrient, cmdLearnings, cmdStatus, pkgRoot } from './commands.mjs';
import { parseFlags } from './flags.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { readLock } from './lock.mjs';
import { createEnvelope, createErrorEnvelope, STATUS } from './envelope.mjs';
import { renderAgentLane, recordAgentLaneBytes } from './agent-lane.mjs';
import { EVENT_TYPE, summarizeArgFlags } from './event-registry.mjs';

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
  const events = ctx.events && typeof ctx.events.withCommand === 'function' ? ctx.events.withCommand(entry.name) : null;
  if (lane && lane !== 'ledger' && entry.resultOf) {
    return dispatchLane(entry, rest, ctx, lane, events);
  }
  return runHandler(entry, rest, ctx, events);
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
  events?.emit(EVENT_TYPE.COMMAND_START, { flags: summarizeArgFlags(rest, flagIndex(entry)), result: PENDING_RESULT });
  try {
    const result = await entry.resultOf(rest, ctx);
    const envelope = createEnvelope({ command: entry.name, schema, status: STATUS.OK, ...result });
    if (lane === 'agent') {
      const rendered = renderAgentLane(envelope, {
        budgetBytes: entry.agentBudgetBytes,
        redactor: ctx.redactor,
        inert: ctx.inert,
      });
      process.stdout.write(`${rendered.text}\n`);
      if (events) recordAgentLaneBytes({ writeEvent: (record) => events.emit(record.type, { ...record, result: PENDING_RESULT }) }, entry.name, rendered.bytes);
    } else {
      // lane === 'json' (or any future lane this entry doesn't specialize
      // for) — the versioned envelope is always a safe default rendering.
      console.log(JSON.stringify(envelope));
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
        redactor: ctx.redactor,
        inert: ctx.inert,
      });
      process.stdout.write(`${rendered.text}\n`);
      if (events) recordAgentLaneBytes({ writeEvent: (record) => events.emit(record.type, { ...record, result: PENDING_RESULT }) }, entry.name, rendered.bytes);
    } else {
      console.error(JSON.stringify(errorEnvelope));
    }
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(status, Date.now() - startedAt, exit));
    return exit;
  }
}

function readHarnessVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  return pkg.version;
}

// --- resultOf producers (P1.2): the canonical result data behind each
// pilot's legacy `--json` output, recomputed via the SAME already-exported
// building blocks lib/commands.mjs's cmdOrient/cmdLearnings/cmdStatus call
// internally (runOrient, listingView/whyView, readLock + the package
// version) — never lib/commands.mjs itself, which this task does not edit.

async function orientResultOf(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const query = parseQueryFromArgv(argv, flags);
  const { runOrient } = await import('./orient.mjs');
  return runOrient({ workspace, copilotHome, flags, query });
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
  if (argv.includes('--why') && !flags.why) {
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
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const lock = readLock(copilotHome);
  return { packageVersion: readHarnessVersion(), copilotHome, lock };
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
 * hand-written CATALOG entries already use. Returns `null` for an
 * unregistered command.
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
    usage: buildUsage(entry),
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
