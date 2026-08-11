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
import { cmdLookup, lookupResultOf } from './retrieval/lookup-cmd.mjs';
import { recallResultOf, getResultOf } from './retrieval/compat-results.mjs';
import { cmdChecks, checksResultOf, checksExitFor, CHECKS_VERBS } from './checks-cmd.mjs';
import { cmdConfig, configResultOf, configExitFor, CONFIG_VERBS } from './config-cmd.mjs';
import { cmdTrust, trustResultOf, TRUST_VERBS } from './trust-cmd.mjs';
import { cmdRun, runResultOf, runExitFor, runRequireArgs, RUN_VERBS } from './run-cmd.mjs';
import { cmdResources, resourcesResultOf, resourcesExitFor, RESOURCES_VERBS } from './resources-cmd.mjs';
import { CONFIG_KEYS, SCOPES } from './config.mjs';
import { RUN_STATUSES } from './run-journal.mjs';
import { cmdExec, execResultOf, cmdBash, bashResultOf, exitFor as execExitFor } from './exec-cmd.mjs';
import { cmdAgent, agentResultOf, agentExitFor, agentJournalArgv, taskFromArgv } from './agent-cmd.mjs';
import { DEFAULT_MAX_SECONDS, DEFAULT_MAX_TURNS, DEFAULT_PERSONA } from './agent-loop.mjs';
import { PROVIDERS } from './provider.mjs';
import {
  cmdSearch,
  searchResultOf,
  cmdTree,
  treeResultOf,
  SEARCH_MATCH_MODES,
  SEARCH_SOURCE_NAMES,
  TREE_SUBJECT_NAMES,
} from './retrieval/search-cmd.mjs';
import { LOOKUP_KINDS, LOOKUP_KIND_SUMMARIES } from './retrieval/lookup.mjs';
import { parseFlags, hasFlag } from './flags.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { createEnvelope, createErrorEnvelope, STATUS } from './envelope.mjs';
import { renderAgentLane, recordAgentLaneBytes } from './agent-lane.mjs';
import { EVENT_TYPE, summarizeArgFlags } from './event-registry.mjs';
import { createRedactor, redactedJson } from './redact.mjs';
import { cmdModel, modelResultOf, MODEL_VERBS } from './model-cmd.mjs';

const REGISTRY = new Map();

// Flags accepted by every registered command today (bin/harness.mjs's
// GLOBAL_OPTIONS, restated as a declarative schema). Strict validation
// merges these into each entry's own flags so a global flag is never
// mistaken for an unknown one.
//
// Every one is `tui: 'cli-only'` — and that is a statement about the whole
// global lane, not seven independent calls. A global flag either selects an
// output lane (`--json`, `--verbose`, `--no-color`), suppresses a side
// channel (`--dry-run`, `--no-events`), or names process-level context
// (`--workspace`, `--copilot-home`). The TUI owns all three itself: it
// renders the lane, it decides whether a run is real, and it already knows
// which workspace the session is attached to. Offering any of them as a
// palette row or a value picker would ask a user to re-answer a question the
// session has already answered.
export const GLOBAL_FLAGS = [
  { name: '--json', type: 'boolean', description: 'JSON output for machine readers', required: false, default: false, tui: 'cli-only' },
  { name: '--dry-run', type: 'boolean', description: 'print actions without writing', required: false, default: false, tui: 'cli-only' },
  {
    name: '--verbose',
    aliases: ['-v'],
    type: 'boolean',
    description: 'full detail: per-file logging, all checks, unclamped hints',
    required: false,
    default: false,
    tui: 'cli-only',
  },
  {
    name: '--no-color',
    type: 'boolean',
    description: 'plain ascii output (also honors NO_COLOR; auto when piped)',
    required: false,
    default: false,
    tui: 'cli-only',
  },
  { name: '--workspace', type: 'string', valueName: 'path', description: 'repo root (default: cwd)', required: false, default: null, tui: 'cli-only' },
  { name: '--copilot-home', type: 'string', valueName: 'path', description: 'override ~/.copilot', required: false, default: null, tui: 'cli-only' },
  {
    name: '--no-events',
    type: 'boolean',
    description: 'do not write any local record: .harness/events.jsonl or runs.jsonl',
    required: false,
    default: false,
    tui: 'cli-only',
  },
];

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', hint, exit: EXIT.usage });
}

/**
 * Surfaces a command may appear on. `cli` is the argv projection (scripts,
 * CI, hooks); `tui` is the command palette; `agent` is the agent-lane tool
 * description. Modelled on Warp's `x-warp-surfaces`, which tags each of its
 * settings with the renderers that consume it rather than leaving surface
 * membership to convention.
 *
 * The default is all three. A command omitted from annotation is therefore
 * *discoverable* rather than hidden — the opposite of pi, whose command
 * table drifted from its dispatcher until three commands became reachable
 * but invisible. Forgetting to annotate must never silently remove a
 * capability from the palette.
 */
export const SURFACES = ['cli', 'tui', 'agent'];

/**
 * How one declared option presents in the TUI palette (see
 * docs/architecture/harness-cli-workbench.md §Command palette).
 *
 * - `verb`     — its own palette row. `index --structural` shows as
 *                `index structural` and resolves back to the flag.
 * - `prompt`   — not a row; once its command or verb is chosen the palette
 *                opens a picker for the value (branch keys, learning ids).
 * - `cli-only` — never shown. Output-lane plumbing (`--json`), confirmations
 *                (`--yes`), and install-time configuration live here.
 *
 * The default is `cli-only`: a wrongly-hidden option is still reachable from
 * the CLI, while a wrongly-shown one puts flag syntax in front of a TUI user,
 * which the palette contract forbids. Completeness is enforced by test, not
 * by the default.
 */
export const TUI_DISPOSITIONS = ['verb', 'prompt', 'cli-only'];

/**
 * The side-effect classes, ordered by escalating consequence:
 * `read` < `mutate` < `execute`. The ORDER is load-bearing, not decoration —
 * `entry.sideEffect` is the maximum across every form of the command, so an
 * override (`bareSideEffect`, a verb's, a flag's) may only ever move DOWN it.
 * `assertNotAboveEntry` enforces that; the palette relies on it to render a
 * glyph no invocation can then exceed.
 */
export const SIDE_EFFECTS = ['read', 'mutate', 'execute'];

/** Guard the one direction an override must never go. `where` names the
 * override so the error points at the declaration to fix. */
function assertNotAboveEntry(entry, where, value) {
  if (SIDE_EFFECTS.indexOf(value) <= SIDE_EFFECTS.indexOf(entry.sideEffect)) return;
  throw new Error(
    `registerCommand: "${entry.name}" ${where} declares sideEffect "${value}" above the command's own "${entry.sideEffect}" — entry.sideEffect is the maximum across every form`
  );
}

function assertValidVerbs(entry, args) {
  if (entry.verbs === undefined) return;
  if (!Array.isArray(entry.verbs)) {
    throw new Error(`registerCommand: "${entry.name}" verbs must be an array`);
  }
  const positionalNames = new Set(args.positionals.map((p) => p.name));
  const verbSlot = args.positionals[0]?.name;
  const seen = new Set();
  for (const v of entry.verbs) {
    if (!v || typeof v !== 'object' || typeof v.verb !== 'string' || !v.verb) {
      throw new Error(`registerCommand: "${entry.name}" has a verb without a verb name`);
    }
    if (typeof v.summary !== 'string' || !v.summary) {
      throw new Error(`registerCommand: "${entry.name}" verb "${v.verb}" needs a summary`);
    }
    if (seen.has(v.verb)) {
      throw new Error(`registerCommand: "${entry.name}" declares verb "${v.verb}" twice`);
    }
    seen.add(v.verb);
    if (v.sideEffect !== undefined && !SIDE_EFFECTS.includes(v.sideEffect)) {
      throw new Error(`registerCommand: "${entry.name}" verb "${v.verb}" has an invalid sideEffect "${v.sideEffect}"`);
    }
    if (v.sideEffect !== undefined) assertNotAboveEntry(entry, `verb "${v.verb}"`, v.sideEffect);
    // `positionals` names the REQUIRED arguments this verb consumes, by
    // reference to the entry's own declarations — `knowledge commit` takes
    // the `target` positional, `knowledge on` takes none. Naming an
    // undeclared positional (or the verb's own slot, which the subcommand
    // token already fills) would never resolve, so it is a typo.
    for (const name of v.positionals || []) {
      if (!positionalNames.has(name)) {
        throw new Error(`registerCommand: "${entry.name}" verb "${v.verb}" consumes positional "${name}", which it does not declare`);
      }
      if (name === verbSlot) {
        throw new Error(`registerCommand: "${entry.name}" verb "${v.verb}" consumes positional "${name}", which is the verb's own slot`);
      }
    }
  }
}

function assertValidFlagMetadata(entry, args) {
  const declared = new Set();
  for (const def of args.flags) {
    declared.add(def.name);
    for (const alias of def.aliases || []) declared.add(alias);
  }
  const verbNames = new Set((entry.verbs || []).map((v) => v.verb));
  for (const def of args.flags) {
    if (def.tui !== undefined && !TUI_DISPOSITIONS.includes(def.tui)) {
      throw new Error(`registerCommand: "${entry.name}" flag ${def.name} has an invalid tui disposition "${def.tui}" (must be ${TUI_DISPOSITIONS.join(' | ')})`);
    }
    if (def.sideEffect !== undefined && !SIDE_EFFECTS.includes(def.sideEffect)) {
      throw new Error(`registerCommand: "${entry.name}" flag ${def.name} has an invalid sideEffect "${def.sideEffect}"`);
    }
    if (def.sideEffect !== undefined) assertNotAboveEntry(entry, `flag ${def.name}`, def.sideEffect);
    // A dependency naming a flag this command does not declare would never
    // fire, so it is a typo rather than a rule — fail at registration.
    for (const req of def.requires || []) {
      if (!declared.has(req)) {
        throw new Error(`registerCommand: "${entry.name}" flag ${def.name} requires ${req}, which it does not declare`);
      }
    }
    for (const verb of def.verbs || []) {
      if (!verbNames.has(verb)) {
        throw new Error(`registerCommand: "${entry.name}" flag ${def.name} is scoped to verb "${verb}", which it does not declare`);
      }
    }
  }
}

function assertValidEntry(entry, args) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('registerCommand: entry must be an object');
  }
  if (!entry.name || typeof entry.name !== 'string') {
    throw new Error('registerCommand: entry.name (string) is required');
  }
  if (typeof entry.handler !== 'function') {
    throw new Error(`registerCommand: "${entry.name}" needs a handler(argv, ctx) function`);
  }
  if (!SIDE_EFFECTS.includes(entry.sideEffect)) {
    throw new Error(`registerCommand: "${entry.name}" has an invalid sideEffect "${entry.sideEffect}" (must be ${SIDE_EFFECTS.join(' | ')})`);
  }
  // `sideEffect` is the policy-facing MAXIMUM across every form of the command
  // — `report` is `mutate` because `--sync` writes, even though bare `report`
  // only reads. Policy must assume the worst; the palette must not, or the
  // glyph that promises "see the consequence before you run it" cries wolf on
  // every read-only invocation. `bareSideEffect` is what the no-argument form
  // actually does, and defaults to `sideEffect` when they agree.
  if (entry.bareSideEffect !== undefined && !SIDE_EFFECTS.includes(entry.bareSideEffect)) {
    throw new Error(`registerCommand: "${entry.name}" has an invalid bareSideEffect "${entry.bareSideEffect}"`);
  }
  if (entry.bareSideEffect !== undefined) assertNotAboveEntry(entry, 'bareSideEffect', entry.bareSideEffect);
  if (entry.surfaces !== undefined) {
    if (!Array.isArray(entry.surfaces) || entry.surfaces.length === 0) {
      throw new Error(`registerCommand: "${entry.name}" surfaces must be a non-empty array`);
    }
    for (const s of entry.surfaces) {
      if (!SURFACES.includes(s)) {
        throw new Error(`registerCommand: "${entry.name}" has an invalid surface "${s}" (must be ${SURFACES.join(' | ')})`);
      }
    }
  }
  assertValidVerbs(entry, args);
  assertValidFlagMetadata(entry, args);
}

/** Register one command entry. Entries are data — see the module doc for the shape. */
export function registerCommand(entry) {
  const args = { flags: [], positionals: [], ...entry.args };
  assertValidEntry(entry, args);
  REGISTRY.set(entry.name, {
    group: 'general',
    capabilities: [],
    outputModes: ['ledger', 'json'],
    surfaces: SURFACES,
    userInvocable: true,
    verbs: [],
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
  // Canonical flag names seen this invocation, plus the first bare token —
  // the latter is the selected verb when the entry declares any (AC9).
  const present = new Set();
  let selectedVerb = null;
  let sawBareToken = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    const isFlagShaped = token.startsWith('-') && token !== '-';
    if (!isFlagShaped) {
      if (!sawBareToken) {
        sawBareToken = true;
        if ((entry.verbs || []).some((v) => v.verb === token)) selectedVerb = token;
      }
      continue;
    }
    const eq = token.indexOf('=');
    const flagName = eq === -1 ? token : token.slice(0, eq);
    const def = known.get(flagName);
    if (!def) {
      throw usageError(`unknown flag: ${flagName}`, `harness help ${entry.name}`);
    }
    // PRESENCE means "the handler will act on this flag", because that is
    // what the applicability pass below draws conclusions from. Handlers read
    // booleans by exact token equality (lib/flags.mjs's `a === '--apply'`,
    // `hasFlag`), so `--apply=false` — legal before this branch, and the
    // status form as far as cmdConsolidate is concerned — is NOT the apply
    // form and must not drag `--apply`'s `requires: ['--ops']` in with it.
    // The token still names a declared flag, so it is accepted, exactly as it
    // was; only the dependency conclusion is withheld.
    if (def.type !== 'boolean' || eq === -1) present.add(def.name);
    if (def.type !== 'boolean' && eq === -1) {
      const next = argv[i + 1];
      const nextIsValue = next !== undefined && !next.startsWith('--');
      if (nextIsValue) i++;
    }
  }

  // Applicability, once every flag is known to be declared. Both checks are
  // no-ops for an entry that declares neither `requires` nor per-flag `verbs`,
  // so every pre-existing command validates exactly as before.
  for (const def of entry.args.flags) {
    if (!present.has(def.name)) continue;
    for (const req of def.requires || []) {
      if (!present.has(req)) {
        throw usageError(
          `${def.name} requires ${req}`,
          `harness help ${entry.name}`,
        );
      }
    }
    if (def.verbs && def.verbs.length && selectedVerb && !def.verbs.includes(selectedVerb)) {
      throw usageError(
        `${def.name} does not apply to "${entry.name} ${selectedVerb}"`,
        `harness help ${entry.name}`,
      );
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
  // One place for a handler or lane to say what actually happened, so callers
  // never have to guess it back out of an exit code.
  const outer = ctx.reportStatus;
  ctx.reportStatus = (status) => {
    ctx.__reportedStatus = status;
    outer?.(status);
  };
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
  // Phase 4a: the run opens HERE — after every validation above has passed and
  // before any handler runs. Opening it earlier (in bin/harness.mjs, next to
  // where the id is minted) wrote a journal entry and created `.harness/` for
  // invocations the CLI then REFUSED, breaking the standing invariant that a
  // rejected option touches nothing. A refused command never started, so it has
  // no run.
  ctx.onRunStart?.();
  // P1.6 (carry-list, AC7 widening): ctx.events now attaches on every path,
  // including the legacy ledger/--json default — EXCEPT `entry.instrument
  // === false`. TWO entries opt out today, `events` and `report`, for the
  // same structural reason. `events`: its
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
    // A handler may have reported its own status through `ctx.reportStatus`
    // (exec/bash/checks do, because their exit code is the CHILD's and cannot
    // be reverse-mapped). Fall back to the exit mapping only when it did not.
    const status = ctx.__reportedStatus ?? statusForExit(exit);
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(status, Date.now() - startedAt, exit));
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
    // A NATIVE non-zero outcome — the command ran to completion and reports a
    // failure as DATA rather than by throwing. Phase 3's `exec`/`bash` are the
    // first such entries: a child exiting 7 is not a harness error, so nothing
    // throws, but returning `EXIT.ok` here would make the envelope lane report
    // exit 0 alongside `"status":"failed"` and hand a scripted caller a false
    // success. `entry.exitOf(result)` is the entry's own mapping, declared as
    // registry data beside `resultOf`; entries without one keep the previous
    // always-ok behavior byte-for-byte. The status comes off the ENVELOPE, not
    // a second derivation, so the event and the rendered output can never
    // disagree about what happened.
    const status = envelope.status || STATUS.OK;
    // The command's OWN outcome, reported upward. bin/harness.mjs used to infer
    // the run status by reverse-mapping the numeric exit — which is exactly the
    // ambiguity `exitFor` documents for `exec`: a child exiting 8 is not a
    // harness timeout, but the reverse map called it one and the journal
    // recorded a `timed-out` run beside an envelope saying `failed`. Found by
    // the Codex phase-4a review, in a hazard this codebase had already written
    // down and then walked into.
    ctx.reportStatus?.(status);
    // The DEFAULT is derived from the status, not hardcoded to ok. Hardcoding
    // it meant a result that declared `"status":"failed"` still exited 0 unless
    // its entry remembered to add `exitOf` — and that was forgotten twice
    // (`exec`, then `checks run`, the latter caught only by an external
    // review). `exitOf` remains the override for a command that needs a
    // SPECIFIC code, like `exec` passing through its child's; every other
    // command now gets a non-zero exit for free the moment it reports a
    // non-ok status, which is the behavior a caller would assume anyway.
    const exit = typeof entry.exitOf === 'function'
      ? entry.exitOf(result)
      : (status === STATUS.OK ? EXIT.ok : 1);
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(status, Date.now() - startedAt, exit));
    return exit;
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

// P2D3: the view decision — the bare-`--why` guard, the domain sniff, and the
// not-found branch — is `resolveLearningsView`, shared with cmdLearnings. Only
// the ERROR MODEL differs here: this path throws so dispatchLane's catch builds
// the unified error envelope, with the same codes and exit values cmdLearnings
// returns for the same two cases.
async function learningsResultOf(argv) {
  const flags = parseFlags(argv);
  const { resolveLearningsView } = await import('./knowledge/listing.mjs');
  const view = resolveLearningsView({
    argv,
    flags,
    workspace: path.resolve(flags.workspace),
    copilotHome: resolveCopilotHome(flags.copilotHome),
    hasFlag,
  });

  if (view.outcome === 'usage') throw usageError(view.message, 'harness learnings --why <id>');
  if (view.outcome === 'not-found') {
    throw Object.assign(new Error(`no learning ${view.id}`), { code: 'E_TARGET', exit: 1 });
  }
  return view.result;
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

// agent: the task is free-text positional words, and there is no flag
// spelling of it — a loop that started without one would ask the model what it
// would like to do, which is not a question a headless run can answer. Mirrors
// lib/agent-cmd.mjs#planAgent's own guard.
function agentRequireArgs(rest) {
  if (!taskFromArgv(rest)) return 'agent needs a task, e.g. harness agent "make the failing test pass"';
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
 *
 * `entry.extraOptions`, when present, is an already-formatted
 * `[label, description]` list appended AFTER the flag-derived rows. It is
 * the second half of the same escape hatch: a subcommand-shaped command
 * (`knowledge status`, `knowledge promote …`, `knowledge purge <file>`)
 * documents rows that are not flags at all, exactly as the retired
 * hand-written CATALOG did. These rows are documentation only — they are
 * NOT part of `flagIndex`, so they can never widen strict flag validation
 * (every flag a row mentions is separately declared in `args.flags`).
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
    options: [
      ...entry.args.flags.map((f) => [flagLabel(f), f.description || '']),
      ...(entry.extraOptions || []),
    ],
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
      { name: '--query', type: 'string', valueName: 'text', description: 'agent/internal task summary', required: false, default: null, tui: 'prompt' },
      { name: '--limit', type: 'number', valueName: 'n', description: 'recall result count (default 3)', required: false, default: 3, tui: 'prompt' },
      {
        name: '--collection',
        aliases: ['-c'],
        type: 'string',
        valueName: 'name',
        description: 'filter by knowledge/collections.yaml',
        required: false,
        default: null,
        tui: 'prompt',
      },
      { name: '--min-score', type: 'number', valueName: 'n', description: 'minimum score (default 0.15)', required: false, default: 0.15, tui: 'prompt' },
      // A mode flag, not a modifier: --explain replaces orient's ordinary
      // context pack with the deterministic ranking decomposition, so
      // `orient explain` is a second thing orient does, not a louder
      // version of the first.
      { name: '--explain', type: 'boolean', description: 'decompose learning ranking (deterministic)', required: false, default: false, tui: 'verb' },
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
        // `verb`, not `prompt`, even though it takes a value: it selects what
        // the command DOES (bare `learnings` pages a listing; `--why` renders
        // one provenance chain), which is the verb test. A value-taking flag
        // is only a `prompt` when it parameterizes an operation the command
        // would perform anyway. The palette renders this as `learnings why`
        // and asks for the id after the row is chosen.
        tui: 'verb',
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

// Every install/upgrade flag is `tui: 'cli-only'` for one reason, stated
// once here rather than seven times below: these decide how the harness is
// hydrated onto a machine, not what it does during a session. A palette
// exists inside an already-installed harness, so every answer here was given
// before the palette could be opened — and the destructive ones
// (--force-profile, --force-knowledge-reset) must stay behind a typed,
// deliberate command line rather than a one-keystroke row.
const INSTALL_FLAGS = [
  { name: '--target', type: 'string', valueName: 't,..', description: 'vscode,cli,intellij', required: false, default: null, tui: 'cli-only' },
  { name: '--autonomy', type: 'string', valueName: 'mode', description: 'full | balanced | strict', required: false, default: null, tui: 'cli-only' },
  { name: '--configure-vscode', type: 'boolean', description: 'merge VS Code chat.* discovery settings', required: false, default: false, tui: 'cli-only' },
  { name: '--configure-path', type: 'boolean', description: 'append ~/.copilot/bin to shell PATH (~/.zshrc, ~/.bashrc)', required: false, default: false, tui: 'cli-only' },
  { name: '--force-profile', type: 'boolean', description: 'overwrite knowledge/profile.md', required: false, default: false, tui: 'cli-only' },
  { name: '--force-knowledge-reset', type: 'boolean', description: 'overwrite knowledge/solutions (danger)', required: false, default: false, tui: 'cli-only' },
  // Undocumented in the old CATALOG but genuinely read (lib/sync.mjs) —
  // the explicit opposite of --force-knowledge-reset, defaults true either way.
  { name: '--preserve-knowledge', type: 'boolean', description: 'keep existing knowledge/solutions (default)', required: false, default: true, tui: 'cli-only' },
];

registerCommand({
  name: 'install',
  summary: 'hydrate skills, agents, and team knowledge globally',
  group: 'setup',
  sideEffect: 'mutate',
  // Lifecycle, not session work: `install` is what puts the TUI and the
  // agent lane on the machine in the first place, so neither surface can
  // meaningfully offer it. Same reasoning for upgrade/uninstall/init-repo.
  surfaces: ['cli'],
  args: { positionals: [], flags: INSTALL_FLAGS },
  handler: (argv) => cmdInstallOrUpgrade('install', argv),
});

registerCommand({
  name: 'upgrade',
  summary: 're-hydrate and purge retired primitives',
  group: 'setup',
  sideEffect: 'mutate',
  // Rewrites the hydrated primitives the running host has already loaded —
  // a restart-shaped operation, not something to fire mid-session.
  surfaces: ['cli'],
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
      { name: '--host', type: 'string', valueName: 'name', description: 'run host-specific checks (vscode executes installed-hook probes)', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdDoctor,
});

registerCommand({
  name: 'uninstall',
  summary: 'remove hydrated files tracked by the lock',
  group: 'setup',
  sideEffect: 'mutate',
  // Removes the very files the TUI/agent surfaces are hydrated from —
  // offering it from inside those surfaces would let a user delete the
  // thing they are standing on.
  surfaces: ['cli'],
  args: { positionals: [], flags: [] },
  handler: cmdUninstall,
});

// --- workspace ----------------------------------------------------------

registerCommand({
  name: 'init-repo',
  summary: 'seed the .harness workspace in a product repo',
  group: 'workspace',
  sideEffect: 'mutate',
  // Bootstrap: it CREATES the .harness workspace every other surface reads
  // from, so by the time a palette or an agent lane is live it has already
  // run. Nothing left to offer.
  surfaces: ['cli'],
  args: { positionals: [], flags: [] },
  handler: cmdInitRepo,
});

registerCommand({
  name: 'index',
  summary: 'rebuild knowledge index · --status reports drift · --structural builds the code symbol index',
  group: 'workspace',
  sideEffect: 'mutate',
  // Subcommand-shaped alternation (`--since` is only legal WITH `--structural`
  // — cmdIndex raises E_USAGE otherwise), so the auto-generated flat signature
  // would misdescribe it. Verbatim from the retired CATALOG (AC: the merge
  // must not lose main's documented usage line).
  usage: '[--status] [--structural [--since <ref>]]',
  args: {
    positionals: [],
    flags: [
      // Both booleans below select WHICH index operation runs, so both are
      // palette rows: `index status` and `index structural` sit beside the
      // bare `index` row rather than hiding flag syntax behind it.
      { name: '--status', type: 'boolean', description: 'read-only freshness report vs HEAD (never rebuilds)', required: false, default: false, tui: 'verb', sideEffect: 'read' },
      // Merge (harness evolution P3): the structural code index. Read by
      // cmdIndex via the boundary-aware `hasFlag(argv, '--structural')`.
      {
        name: '--structural',
        type: 'boolean',
        description:
          'build the persistent structural code index under ~/.harness/index/<repo-id>/<worktree-id>/structural (optional tree-sitter tier, lexical fallback)',
        required: false,
        default: false,
        tui: 'verb',
      },
      {
        name: '--since',
        type: 'string',
        valueName: 'ref',
        description:
          'requires --structural: re-parse only files changed since <ref> (validated via git rev-parse; leading "-" rejected). Narrows ONLY when <ref> is the sha the prior index was built at — any other ref is reported and ignored for a full pass',
        required: false,
        default: null,
        tui: 'prompt',
        // The one dependency the description already states in prose, now
        // declared. cmdIndex (lib/commands.mjs) still raises the identical
        // `--since requires --structural` message for any caller reaching
        // the handler directly; declaring it here only moves the same
        // rejection in front of the handler and, more importantly, tells the
        // palette that picking a `<ref>` is only offered under `structural`.
        requires: ['--structural'],
      },
    ],
  },
  handler: cmdIndex,
});

registerCommand({
  name: 'plan-new',
  summary: 'scaffold a gate-ready plan',
  group: 'workspace',
  sideEffect: 'mutate',
  // No `verbs`. plan-new does exactly one thing — scaffold a plan file — and
  // its only alternation, `--risk <green|amber|red>`, is that flag's VALUE
  // enum, not a set of subcommands: cmdPlanNew (lib/plan-new.mjs) reads it as
  // a single `--risk` token whose argument it validates, and it appears in
  // the auto-generated usage only because `valueName` renders inside the
  // flag's own angle brackets. `plan-new green` is not, and never was, a
  // legal invocation, so promoting the tiers to verbs would invent a grammar
  // the handler cannot answer. They belong to `--risk`, which prompts for
  // one of the three below.
  args: {
    positionals: [],
    flags: [
      { name: '--type', type: 'string', valueName: 't', description: 'feat|fix|docs|refactor|chore', required: true, default: null, tui: 'prompt' },
      { name: '--slug', type: 'string', valueName: 's', description: 'lowercase-hyphen slug', required: true, default: null, tui: 'prompt' },
      { name: '--intent', type: 'string', valueName: 'text', description: 'one-line intent', required: true, default: null, tui: 'prompt' },
      { name: '--impacted', type: 'string', valueName: 'a,b', description: 'comma-separated Impacted Files', required: false, default: null, tui: 'prompt' },
      { name: '--criteria', type: 'string', valueName: 'text', description: 'an acceptance criterion (repeatable)', required: false, default: null, tui: 'prompt' },
      { name: '--gap', type: 'string', valueName: 'id:path', description: 'capability gap → blocked-capability + governed primitive plan', required: false, default: null, tui: 'prompt' },
      // Output-lane plumbing, not a mode: it redirects the same scaffold to
      // stdout for a caller that wants to pipe it. A palette user asked for
      // a plan file, so the row that skips writing one is CLI-only.
      { name: '--stdout', type: 'boolean', description: 'print the plan instead of writing it', required: false, default: false, tui: 'cli-only' },
      // Undocumented in the old CATALOG, but cmdPlanNew's own bespoke argv
      // loop (lib/plan-new.mjs) genuinely reads all three.
      { name: '--title', type: 'string', valueName: 'text', description: 'plan heading override (default: derived from slug)', required: false, default: null, tui: 'prompt' },
      { name: '--date', type: 'string', valueName: 'yyyy-mm-dd', description: 'override the plan filename date (default: today)', required: false, default: null, tui: 'prompt' },
      // See the `verbs` note above: green|amber|red is this flag's value
      // enum, which the palette picks from — not three plan-new verbs.
      { name: '--risk', type: 'string', valueName: 'green|amber|red', description: 'risk rating (default green)', required: false, default: null, tui: 'prompt' },
      // cmdPlanNew reads --status and passes it straight to buildPlanSkeleton
      // (lib/plan-new.mjs), which writes it as the plan's status frontmatter;
      // undeclared, strict validateArgs rejected a working invocation with
      // `unknown flag: --status` before the handler ever ran. `cli-only`, not
      // `prompt`: buildPlanSkeleton already picks the right status for a fresh
      // plan (in-progress, or blocked-capability with --gap), so a palette user
      // scaffolding one must never be asked to name it — this is the override
      // escape hatch for a caller re-creating a plan mid-lifecycle, the same
      // call --stdout above makes.
      // The value enum lives in the description, like --type above: seven plan
      // statuses inline would swamp the generated usage signature.
      { name: '--status', type: 'string', valueName: 'name', description: 'open|planned|in-progress|review|done|blocked-capability|needs-info (default in-progress, or blocked-capability with --gap)', required: false, default: null, tui: 'cli-only' },
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
      { name: '--phase', type: 'string', valueName: 'name', description: 'implement | verify', required: false, default: 'implement', tui: 'prompt' },
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null, tui: 'prompt' },
      // Strictness dial, not a mode: gate does the same job either way, it
      // just refuses more. It reads as an adverb ("gate, strictly"), never
      // as a verb, so it stays off the palette — the same call made for
      // validate-plan's identical flag below.
      { name: '--strict-intent', type: 'boolean', description: 'fail locked plans missing intent fields', required: false, default: false, tui: 'cli-only' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt' },
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
      { name: '--plan', type: 'string', valueName: 'path', description: 'plan file whose named checks run', required: false, default: null, tui: 'prompt' },
      { name: '--base', type: 'string', valueName: 'git-ref', description: 'compare changed files to this git ref', required: false, default: null, tui: 'prompt' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt' },
      // Undocumented in the old CATALOG, but read (lib/commands.mjs#cmdVerify)
      // and directly tested end to end.
      { name: '--learnings', type: 'string', valueName: 'a,b', description: 'learning ids cited by this verified change', required: false, default: null, tui: 'prompt' },
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
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null, tui: 'prompt' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt' },
      // Undocumented in the old CATALOG, but read (lib/validate-plan.mjs)
      // and directly tested end to end.
      // Strictness dial, same call as gate's identical flag above.
      { name: '--strict-intent', type: 'boolean', description: 'fail locked plans missing intent fields', required: false, default: false, tui: 'cli-only' },
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
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null, tui: 'prompt' },
      // The one genuine mode switch here, and the summary above says so:
      // compound normally requires passed evidence, `--insight` records
      // without any. Two different jobs, so `compound insight` earns a row.
      { name: '--insight', type: 'boolean', description: 'evidence-free investigation capture (kind: insight, secret-scanned)', required: false, default: false, tui: 'verb' },
      // No `requires: ['--insight']` on the seven insight-shaped flags below,
      // deliberately. lib/compound.mjs guards the pairing from the other
      // direction and as a SET — "insight capture needs --title and --body
      // (or --body-file)" — an or-of-two that `requires` cannot express, and
      // whose message plus `nextTools` hint is strictly more useful than the
      // generic one this module would generate. Declaring a one-sided
      // dependency here would both degrade that error and newly reject
      // invocations the handler accepts today.
      { name: '--title', type: 'string', valueName: 't', description: 'insight title (required with --insight)', required: false, default: null, tui: 'prompt' },
      { name: '--body', type: 'string', valueName: 'text', description: 'insight body text', required: false, default: null, tui: 'prompt' },
      { name: '--body-file', type: 'string', valueName: 'path', description: 'read insight body from a file', required: false, default: null, tui: 'prompt' },
      { name: '--category', type: 'string', valueName: 'c', description: 'docs/solutions/<category>/ (default insights)', required: false, default: null, tui: 'prompt' },
      { name: '--tags', type: 'string', valueName: 'a,b', description: 'comma-separated tags', required: false, default: null, tui: 'prompt' },
      { name: '--trigger', type: 'string', valueName: 't', description: 'applicability condition frontmatter', required: false, default: null, tui: 'prompt' },
      { name: '--claim', type: 'string', valueName: 't', description: 'one-line claim frontmatter', required: false, default: null, tui: 'prompt' },
      // Undocumented in the old CATALOG, but read (lib/compound.mjs, via
      // loadPolicy) for both --insight and evidence-bound compound.
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt' },
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
    // Required, unlike orient's identically-shaped query: recall has no
    // `--query` flag, so this positional is the ONLY way to supply one, and
    // `recallRequireArgs` below already refuses the invocation without it.
    // Declaring it optional left the palette with a `recall` row that could
    // never resolve to a runnable command.
    positionals: [{ name: 'query', description: 'free-text search terms (joined)', required: true, default: '', variadic: true }],
    flags: [
      { name: '--limit', type: 'number', valueName: 'n', description: 'result count (default 3)', required: false, default: 3, tui: 'prompt' },
      { name: '--collection', aliases: ['-c'], type: 'string', valueName: 'name', description: 'filter by knowledge/collections.yaml', required: false, default: null, tui: 'prompt' },
      { name: '--min-score', type: 'number', valueName: 'n', description: 'minimum score (default 0.15)', required: false, default: 0.15, tui: 'prompt' },
      // Widens the corpus recall searches; it does not change what recall
      // DOES. `recall include-plans` reads as a noun phrase, not a verb, so
      // it is a CLI refinement rather than a second palette row.
      { name: '--include-plans', type: 'boolean', description: 'include matching plans', required: false, default: false, tui: 'cli-only' },
    ],
  },
  handler: cmdRecall,
  resultOf: recallResultOf,
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
      // --docid and --path are an either/or pair, not a dependency, so
      // neither carries `requires` — getRequireArgs above already enforces
      // "at least one", which `requires` has no way to express.
      { name: '--docid', type: 'string', valueName: 'id', description: 'manifest doc id', required: false, default: null, tui: 'prompt' },
      { name: '--path', type: 'string', valueName: 'rel', description: 'relative file path', required: false, default: null, tui: 'prompt' },
      { name: '--lines', type: 'number', valueName: 'n', description: 'max lines (default 40)', required: false, default: 40, tui: 'prompt' },
      { name: '--max-bytes', type: 'number', valueName: 'n', description: 'max excerpt bytes (default 2048)', required: false, default: 2048, tui: 'prompt' },
    ],
  },
  handler: cmdGet,
  resultOf: getResultOf,
  requireArgs: getRequireArgs,
});

registerCommand({
  name: 'exec',
  summary: 'run an argv directly — never through a shell — with a confined cwd and an allowlisted environment',
  group: 'engineer loop',
  sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '[--cwd <dir>] [--timeout <s>] [--allow-env <NAME>] -- <program> [args...]',
  args: {
    positionals: [],
    flags: [
      { name: '--cwd', type: 'string', valueName: 'dir', description: 'working directory, confined to the workspace', required: false, default: null, tui: 'prompt' },
      { name: '--timeout', type: 'number', valueName: 's', description: 'seconds before the process tree is terminated (default 600, max 3600)', required: false, default: 600, tui: 'prompt' },
      { name: '--allow-env', type: 'string', valueName: 'NAME', description: 'pass one parent environment variable through (repeatable); the default is deny-all', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdExec,
  resultOf: execResultOf,
  // The child's own exit code is the command's exit code on every lane, not
  // just the ledger — see `dispatchLane`'s `exitOf` note. Without this the
  // envelope lane would print `"status":"failed"` and exit 0.
  exitOf: execExitFor,
});

registerCommand({
  name: 'bash',
  // A separate command rather than `exec --shell`: the two carry different
  // risk, are separately policy-gated, and an auditor filtering for shell
  // invocations should not have to trust a boolean inside a payload.
  summary: 'run a script through a shell — separately gated from exec, which never uses one',
  group: 'engineer loop',
  sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '[--cwd <dir>] [--timeout <s>] [--allow-env <NAME>] -- "<script>"',
  args: {
    positionals: [],
    flags: [
      { name: '--cwd', type: 'string', valueName: 'dir', description: 'working directory, confined to the workspace', required: false, default: null, tui: 'prompt' },
      { name: '--timeout', type: 'number', valueName: 's', description: 'seconds before the process tree is terminated (default 600, max 3600)', required: false, default: 600, tui: 'prompt' },
      { name: '--allow-env', type: 'string', valueName: 'NAME', description: 'pass one parent environment variable through (repeatable); the default is deny-all', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdBash,
  resultOf: bashResultOf,
  exitOf: execExitFor,
});

registerCommand({
  name: 'tui',
  // NOT OFFERED INSIDE ITSELF. A ledger listing "open the session ledger" in
  // its own palette is a row that can only refuse — the loop already answers
  // "already open" — and it crowded out a row that could act. Every reference
  // palette lists what you can do FROM HERE, never how you got here.
  surfaces: ['cli', 'agent'],
  summary: 'open the session ledger — a scrolling transcript that dispatches through this same registry',
  group: 'engineer loop',
  // The ledger can run ANY command, so its policy maximum is the maximum of
  // everything it can reach. Declaring it `read` because the shell itself only
  // prints would mislabel a surface from which `bash` is one keystroke away.
  sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger'],
  usage: '',
  args: { positionals: [], flags: [] },
  // Imported lazily: `tui-cmd` reaches the command index, which reaches this
  // registry, so a static import would close a cycle. The ledger is also the
  // one command nothing else needs loaded to answer `help`.
  handler: async (argv, ctx) => (await import('./tui-cmd.mjs')).cmdTui(argv, ctx),
  // No resultOf: the ledger is a terminal surface by contract, so there is no
  // envelope or agent lane to render it into. `assertLaneSupported` therefore
  // refuses `--output` on it with a structured error, which is the honest
  // answer rather than a silently ignored flag.
});

registerCommand({
  name: 'resources',
  summary: 'list, inspect, register, or unregister locally-added skills and agents',
  group: 'setup',
  // `register`/`unregister` write the user-scope registration store; the two
  // read verbs override DOWN so the palette warns about the verbs that change
  // what the harness recognizes.
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<list|show|register|unregister|bundles|add|update|remove> [path]',
  verbs: [
    { verb: 'list', summary: 'skills and agents added by hand, with whether each is registered and valid', sideEffect: 'read' },
    { verb: 'show', summary: 'one added primitive: its kind, name, digest, and why it is in that state', sideEffect: 'read', positionals: ['path'] },
    { verb: 'register', summary: 'validate an added primitive and record that this machine recognizes it', positionals: ['path'] },
    { verb: 'unregister', summary: 'withdraw recognition without deleting the file', positionals: ['path'] },
    { verb: 'bundles', summary: 'installed bundles, their state, and what each has placed', sideEffect: 'read' },
    { verb: 'add', summary: 'install a bundle directory and place its contributions', positionals: ['path'] },
    { verb: 'update', summary: 'replace an installed bundle and re-place its contributions', positionals: ['path'] },
    { verb: 'remove', summary: 'uninstall a bundle and withdraw everything it placed', positionals: ['path'] },
  ],
  args: {
    positionals: [
      { name: 'verb', description: RESOURCES_VERBS.join('|'), required: false, default: 'list' },
      { name: 'path', description: 'the primitive path, name, or filename', required: false, default: null },
    ],
    flags: [],
  },
  bareSideEffect: 'read',
  handler: cmdResources,
  resultOf: resourcesResultOf,
  exitOf: resourcesExitFor,
});

registerCommand({
  name: 'agent',
  summary: 'run a task headlessly — orient, ask a model what to do, do it under controls, journal every turn',
  group: 'engineer loop',
  // The loop's whole purpose is to execute, and it does so through the same
  // `exec`/`bash` surface an operator uses. Declaring anything softer would let
  // it run somewhere `exec` itself is refused.
  sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<task...> [--agent <persona>] [--provider <id>] [--model <id>] [--max-turns <n>] [--max-seconds <s>] [--tool-timeout <s>] [--dry-run]',
  args: {
    // Named `task...` rather than `task` because it genuinely is variadic —
    // every bare word is joined, so an unquoted task is not truncated to its
    // first token. The usage line and the declared data have to agree; a
    // capability that lives only in prose is what AC8 exists to catch.
    positionals: [{ name: 'task...', description: 'what to do, in words', required: true, default: null }],
    flags: [
      { name: '--agent', type: 'string', valueName: 'persona', description: `which hydrated persona to run as (default ${DEFAULT_PERSONA})`, required: false, default: DEFAULT_PERSONA, tui: 'prompt' },
      { name: '--provider', type: 'string', valueName: 'id', description: `which provider answers the model call: ${Object.keys(PROVIDERS).join('|')} (default anthropic)`, required: false, default: 'anthropic', tui: 'prompt' },
      { name: '--model', type: 'string', valueName: 'id', description: "the model to call; the provider's default when omitted", required: false, default: null, tui: 'prompt' },
      { name: '--max-turns', type: 'number', valueName: 'n', description: `stop after this many turns (default ${DEFAULT_MAX_TURNS})`, required: false, default: DEFAULT_MAX_TURNS, tui: 'prompt' },
      { name: '--max-seconds', type: 'number', valueName: 's', description: `stop after this much wall clock (default ${DEFAULT_MAX_SECONDS})`, required: false, default: DEFAULT_MAX_SECONDS, tui: 'prompt' },
      { name: '--tool-timeout', type: 'number', valueName: 's', description: "ceiling on one tool's runtime in seconds; the model may ask for less, never more", required: false, default: null, tui: 'prompt' },
    ],
  },
  // A task is REQUIRED, and a missing one is a usage error rather than a loop
  // that starts and asks the model what it would like to do.
  requireArgs: agentRequireArgs,
  handler: cmdAgent,
  resultOf: agentResultOf,
  // The journal records WHICH run this was and how it was configured, not what
  // it was asked to do in words — see agentJournalArgv. Declared as an entry
  // hook so any future command carrying free text gets the same treatment
  // rather than each one remembering to.
  journalArgv: agentJournalArgv,
  // The stop reason decides the exit code — see STOP_REASONS. Without this the
  // envelope lane would exit 0 on a run that hit its turn budget without
  // finishing, which is the reading the named stop conditions exist to prevent.
  exitOf: agentExitFor,
});

registerCommand({
  name: 'run',
  summary: 'list, inspect, or judge the resumability of past harness runs',
  group: 'engineer loop',
  // Every verb reads. `resume` REPORTS whether resuming is safe rather than
  // performing it — see resumePlanFor for why an interrupted command is never
  // replayed — so nothing here mutates or executes.
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<list|show|tree|resume> [run-id] [--status <status>] [--command <name>] [--host <host>] [--plan <path>] [--since <date>] [--until <date>] [--limit <n>]',
  verbs: [
    { verb: 'list', summary: 'past runs, newest first, with the documented filters' },
    { verb: 'show', summary: 'one run and every event it recorded', positionals: ['run-id'] },
    { verb: 'tree', summary: 'one run and the work it caused', positionals: ['run-id'] },
    { verb: 'resume', summary: 'whether this run can safely be resumed, and from where', positionals: ['run-id'] },
  ],
  args: {
    positionals: [
      { name: 'verb', description: RUN_VERBS.join('|'), required: false, default: 'list' },
      { name: 'run-id', description: 'a run id or an unambiguous prefix', required: false, default: null },
    ],
    flags: [
      { name: '--status', type: 'string', valueName: 'status', description: `list: ${RUN_STATUSES.join('|')}`, required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--command', type: 'string', valueName: 'name', description: 'list: only runs of this command', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--host', type: 'string', valueName: 'host', description: 'list: only runs from this host', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--plan', type: 'string', valueName: 'path', description: 'list: only runs against this plan', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--since', type: 'string', valueName: 'date', description: 'list: runs at or after this date', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--until', type: 'string', valueName: 'date', description: 'list: runs at or before this date', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--limit', type: 'number', valueName: 'n', description: 'list: how many runs to show (default 20)', required: false, default: 20, tui: 'prompt', verbs: ['list'] },
    ],
  },
  // A bare `harness run` lists, which reads.
  bareSideEffect: 'read',
  handler: cmdRun,
  resultOf: runResultOf,
  exitOf: runExitFor,
  // Filter values are validated in the registry phase so a refused invocation
  // never opens a run — see runRequireArgs.
  requireArgs: runRequireArgs,
});

registerCommand({
  name: 'model',
  summary: 'show which model answers, and change it — the providers you can actually use',
  group: 'engineer loop',
  // `set`/`clear` write config; a bare `model` reads, which is the common call.
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '[show|set|clear] [provider] [model] [--scope <scope>]',
  verbs: [
    { verb: 'show', summary: 'the active provider and model, and every provider you can reach', sideEffect: 'read' },
    { verb: 'set', summary: 'make a provider (and optionally a model) the default', positionals: ['provider', 'model'] },
    { verb: 'clear', summary: 'forget the choice and fall back to the built-in default' },
  ],
  args: {
    positionals: [
      { name: 'verb', description: MODEL_VERBS.join('|'), required: false, default: 'show' },
      { name: 'provider', description: 'the provider id, for set', required: false, default: null },
      { name: 'model', description: 'the model id, for set; omit for the provider default', required: false, default: null },
    ],
    flags: [
      { name: '--scope', type: 'string', valueName: 'scope', description: `which file remembers the choice, ${SCOPES.join(' or ')}`, required: false, default: null, tui: 'prompt', verbs: ['set', 'clear'] },
    ],
  },
  // A bare `harness model` is the picker view, and reading is what it does.
  bareSideEffect: 'read',
  handler: cmdModel,
  resultOf: modelResultOf,
});

registerCommand({
  name: 'trust',
  summary: 'show, grant, or withdraw this project\u2019s permission to change harness behavior',
  group: 'engineer loop',
  // `approve`/`revoke` write the user-scope trust store; `status` reads.
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<status|approve|revoke>',
  verbs: [
    { verb: 'status', summary: 'whether this project is trusted, why, and which files an approval pins', sideEffect: 'read' },
    { verb: 'approve', summary: 'grant this project permission and pin its policy files by content' },
    { verb: 'revoke', summary: 'withdraw permission; project config and policy stop taking effect' },
  ],
  args: {
    positionals: [
      { name: 'verb', description: TRUST_VERBS.join('|'), required: false, default: 'status' },
    ],
    flags: [],
  },
  // A bare `harness trust` reports status, which reads. Without this the
  // palette would paint the bare row with the entry's mutate maximum.
  bareSideEffect: 'read',
  handler: cmdTrust,
  resultOf: trustResultOf,
});

registerCommand({
  name: 'config',
  summary: 'show, read, or change harness configuration across the user and project scopes',
  group: 'engineer loop',
  // `set` mutates a file; the three read verbs override DOWN, so the palette
  // warns about the verb that actually writes rather than all four.
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  // The scope enum lives in the flag's description, not the usage line — the
  // same convention `--type` and `--match` follow, and what keeps every token
  // in a usage string resolvable to declared registry data.
  usage: '<show|get|set|validate> [key] [value] [--scope <scope>]',
  verbs: [
    { verb: 'show', summary: 'every key, its effective value, and which scope supplied it', sideEffect: 'read' },
    { verb: 'get', summary: 'one key: its effective value and provenance', sideEffect: 'read', positionals: ['key'] },
    { verb: 'set', summary: 'write one key into the user or project scope, atomically', positionals: ['key', 'value'] },
    { verb: 'validate', summary: 'parse both scopes and report every schema violation', sideEffect: 'read' },
  ],
  args: {
    positionals: [
      { name: 'verb', description: CONFIG_VERBS.join('|'), required: true, default: null },
      { name: 'key', description: CONFIG_KEYS.join('|'), required: false, default: null },
      { name: 'value', description: 'the new value, for set', required: false, default: null },
    ],
    flags: [
      // Scoped to `set`: it selects which FILE to write, so offering it on the
      // three read verbs would put a mutate-class option on a row the palette
      // paints as read — the escalation the command-index contract forbids.
      { name: '--scope', type: 'string', valueName: 'scope', description: `set: which file to write, ${SCOPES.join(' or ')}`, required: false, default: null, tui: 'prompt', verbs: ['set'] },
    ],
  },
  handler: cmdConfig,
  resultOf: configResultOf,
  // `config validate` is gated on in CI; without this the envelope lane exited
  // 0 over a body reporting `"valid": false`.
  exitOf: configExitFor,
});

registerCommand({
  name: 'checks',
  summary: 'list, inspect, or run one named check from the trusted check config',
  group: 'engineer loop',
  // The policy-facing MAXIMUM across every form: `run` executes a repo-authored
  // argv. `list`/`show` override DOWN to read, so the palette warns about the
  // verb that actually executes rather than painting all three the same.
  sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<list|show|run> [name]',
  verbs: [
    { verb: 'list', summary: 'every check the workspace declares, with its argv and timeout', sideEffect: 'read' },
    { verb: 'show', summary: 'one check: the exact argv it will execute, and whether it validates', sideEffect: 'read', positionals: ['name'] },
    { verb: 'run', summary: 'execute one check on its own and exit non-zero if it does not pass', positionals: ['name'] },
  ],
  args: {
    positionals: [
      { name: 'verb', description: CHECKS_VERBS.join('|'), required: true, default: null },
      { name: 'name', description: 'the check name, for show and run', required: false, default: null },
    ],
    flags: [],
  },
  handler: cmdChecks,
  resultOf: checksResultOf,
  // `checks run` reports the check's own verdict through the exit code so CI
  // can gate on one check. Without this the envelope/agent lanes exited 0 for a
  // failing check while the ledger path exited 1.
  exitOf: checksExitFor,
});

registerCommand({
  name: 'search',
  summary: 'ranked, literal, regex, path, or symbol search across code, knowledge, learnings and plans',
  group: 'engineer loop',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<query> [--match <mode>] [--source <a,b>] [--explain] [--cursor <c>]',
  args: {
    positionals: [
      { name: 'query', description: 'free-text query words (joined)', required: true, default: '', variadic: true },
    ],
    flags: [
      // `--match` is the mode selector, so it is the one flag that earns its
      // own palette rows: each mode is a different question a user is asking,
      // not a refinement of one.
      { name: '--match', type: 'string', valueName: 'mode', description: `match mode: ${SEARCH_MATCH_MODES.join('|')} (default ranked)`, required: false, default: 'ranked', tui: 'prompt' },
      { name: '--source', type: 'string', valueName: 'a,b', description: `restrict to sources: ${SEARCH_SOURCE_NAMES.join(',')}`, required: false, default: null, tui: 'prompt' },
      { name: '--explain', type: 'boolean', description: 'include the retrieval reason per result', required: false, default: false, tui: 'prompt' },
      { name: '--cursor', type: 'string', valueName: 'c', description: 'resume from a previous page', required: false, default: null, tui: 'cli-only' },
      { name: '--limit', type: 'number', valueName: 'n', description: 'results per page (default 20)', required: false, default: 20, tui: 'prompt' },
      { name: '--collection', aliases: ['-c'], type: 'string', valueName: 'name', description: 'filter by knowledge/collections.yaml', required: false, default: null, tui: 'prompt' },
    ],
  },
  handler: cmdSearch,
  resultOf: searchResultOf,
});

registerCommand({
  name: 'tree',
  summary: 'structural navigation of the workspace or the knowledge corpus',
  group: 'engineer loop',
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<workspace|knowledge> [target] [--depth <n>]',
  // Subjects as verbs for the same reason lookup's kinds are: a free-text
  // subject positional gives the palette a slot it can fill with anything,
  // and the row then resolves to an argv the command refuses.
  verbs: TREE_SUBJECT_NAMES.map((subject) => ({
    verb: subject,
    summary: subject === 'workspace'
      ? 'tracked files as a directory tree'
      : 'the knowledge corpus grouped by scope, category, and learning domain',
    positionals: [],
  })),
  args: {
    positionals: [
      { name: 'subject', description: TREE_SUBJECT_NAMES.join('|'), required: true, default: null },
      { name: 'target', description: 'subtree path, or a collection name for knowledge', required: false, default: null },
    ],
    flags: [
      { name: '--depth', type: 'number', valueName: 'n', description: 'tree depth (default 3, max 10)', required: false, default: 3, tui: 'prompt' },
    ],
  },
  handler: cmdTree,
  resultOf: treeResultOf,
});

registerCommand({
  name: 'lookup',
  summary: 'exact entity retrieval by kind and identifier',
  group: 'engineer loop',
  // Read, unconditionally: every resolver probes and reads, and none may
  // create the knowledge store — the read-path invariant this command is
  // tested against (P2AC6).
  sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  // The eleven kinds are declared as verbs, not left as a free-text positional.
  // The command-index contract test caught why: a bare `kind` positional makes
  // the palette offer a row whose value slot accepts anything, so it resolves
  // to an argv `requireArgs` then refuses — a row no answer can complete, the
  // exact defect the bidirectional palette/dispatch assertion exists to catch.
  // As data they become eleven completable rows, each carrying the identifier
  // slot its form cannot run without. Every kind reads, so none overrides the
  // entry's `read` side effect.
  verbs: LOOKUP_KINDS.map((kind) => ({
    verb: kind,
    summary: LOOKUP_KIND_SUMMARIES[kind],
    positionals: ['identifier'],
  })),
  args: {
    positionals: [
      {
        name: 'kind',
        description: LOOKUP_KINDS.join('|'),
        required: true,
        default: null,
      },
      {
        name: 'identifier',
        description: 'entity id — a path, docid, symbol name, <domain>/<slug>, or path@sha256',
        required: true,
        default: null,
      },
    ],
    flags: [],
  },
  handler: cmdLookup,
  // The lane opt-in. Its presence is what `assertLaneSupported` reads, so
  // declaring it here is what gives lookup the envelope and agent lanes
  // (P2AC7) rather than shipping ledger-only like recall and get still do.
  resultOf: lookupResultOf,
  // No `requireArgs`, matching `learning` and `knowledge` — the other two
  // verb-bearing commands. A requireArgs that validated the kind made the bare
  // `lookup` row unsatisfiable: the palette fills a free-text positional with
  // any word, and the gate then refused it, which is precisely the
  // dispatch-refuses-a-palette-row defect the index contract test guards.
  // `lookupEntity` still rejects an unknown kind with the same E_USAGE/exit 2,
  // and every path reaches it, so nothing goes unvalidated — only the layer
  // that reports it moves.
  usage: `<${LOOKUP_KINDS.join('|')}> <identifier>`,
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
      { name: '--session', type: 'string', valueName: 'id', description: 'filter by host session ID', required: false, default: null, tui: 'prompt' },
      // Both replace the event listing with a different view rather than
      // trimming it — `events summary` and `events failures` are the two
      // things a reader actually asks this command for.
      { name: '--summary', type: 'boolean', description: 'aggregate summary only', required: false, default: false, tui: 'verb' },
      { name: '--failures', type: 'boolean', description: 'failed or blocked events only', required: false, default: false, tui: 'verb' },
      { name: '--limit', type: 'number', valueName: 'n', description: 'event count (default 20)', required: false, default: 20, tui: 'prompt' },
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
  // …and that comment is itself the reason bareSideEffect exists: the entry is
  // classified by its most-mutating form for policy, while `harness report`
  // with no flags only reads. The palette shows the row's own consequence.
  bareSideEffect: 'read',
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
      // --sync performs the write this whole entry is classified `mutate`
      // for, and --global swaps the corpus from this workspace to every
      // synced one. Two distinct operations, two rows.
      { name: '--sync', type: 'boolean', description: 'merge workspace events into the global store first', required: false, default: false, tui: 'verb' },
      { name: '--global', type: 'boolean', description: 'report across all synced workspaces', required: false, default: false, tui: 'verb', sideEffect: 'read' },
      // Renders the same report; all it changes is the process exit code for
      // a CI job. Exit codes have no meaning inside a palette session, so
      // this is the "meaningless mid-session" case rather than a mode.
      { name: '--check', type: 'boolean', description: 'exit non-zero on a budget breach (CI)', required: false, default: false, tui: 'cli-only' },
      // Undocumented in the old CATALOG, but read (lib/commands.mjs#cmdReport
      // -> collectHostUsage) to select a specific host's usage log.
      // `sideEffect: 'read'` because this flag is offered on the `report` and
      // `report global` rows, which render as `read`: an option a read row
      // carries has to say it cannot escalate that row, or the glyph is a
      // promise the palette has no data to keep.
      { name: '--host', type: 'string', valueName: 'name', description: 'host usage log to overlay (default: auto-detect)', required: false, default: null, tui: 'prompt', sideEffect: 'read' },
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
  // Kept verbatim (the M3 public contract, pinned by
  // test/prompt-library-contracts.test.mjs); the merge's NEW subcommands are
  // documented as `extraOptions` rows below, exactly as the retired CATALOG
  // documented them.
  usage: '<on|suggest|off|freeze|capture-only> | --status | purge <file|--all> | commit <none|repo> | migrate-store',
  // Non-flag documentation rows, carried over verbatim from the retired
  // hand-written CATALOG (bin/harness.mjs) so `harness help knowledge` still
  // describes every subcommand surface, including the ones the harness
  // evolution branch added.
  extraOptions: [
    ['status', 'layer-aware report: golden domain counts, branch buckets, recall-index drift (read-only)'],
    ['promote [--branch <key>] [--ids a,b] [--all]', 'emit a reviewable branch→golden promotion op-set (.harness/promote-ops.json)'],
    ['prune [--branch <key>] [--merged] [--stale <days>]', 'delete branch buckets (human authority, never mode-gated)'],
    ['purge <file>', 'cascade-delete an episode and dependent learnings'],
    ['purge --all', 'reset the learnings store (episodes remain, become debt)'],
    ['commit <none|repo>', 'repo mirrors ACTIVE learnings into docs/knowledge/learnings (opt-in, never git-commits the product repo); none is the default'],
    ['migrate-store', "move a stranded path-keyed store to this workspace's current (remote-keyed) store id; refuses if the target already exists"],
  ],
  // The eleven subcommands cmdKnowledge actually branches on, promoted out
  // of the `usage` string and the `extraOptions` rows above into data. Every
  // one is the FIRST bare token of an invocation (cmdKnowledge reads
  // `argv[0]`), which is exactly what `validateArgs` resolves as the
  // selected verb — so the per-flag `verbs` scoping below keys off the same
  // token the handler dispatches on. Summaries are the extraOptions text
  // verbatim wherever a row exists, so `harness help knowledge` and the
  // palette can never describe the same subcommand two different ways.
  //
  // The five modes come first, in the usage line's order. They are the
  // knowledge layer's kill/approve switches (docs/MEMORY-MODEL.md
  // §Knowledge modes) and have no extraOptions row, so their summaries are
  // written from that matrix.
  verbs: [
    { verb: 'on', summary: 'default mode: orient injects, and every writer (remember, compound --insight, consolidate --apply) is open' },
    { verb: 'suggest', summary: 'approve-before-write: consolidate --apply stops until a human re-runs it with --yes' },
    { verb: 'off', summary: 'kill switch: no injection and no writers at all' },
    { verb: 'freeze', summary: 'read-only layer: orient still injects, but remember and consolidate --apply stop writing' },
    { verb: 'capture-only', summary: 'stop injecting into orient while compound --insight keeps capturing' },
    // The one read-only subcommand under a mutating parent. Without this
    // override the palette would paint a write glyph on a report that
    // touches nothing — the exact mislabelling `sideEffect` exists to stop.
    {
      verb: 'status',
      summary: 'layer-aware report: golden domain counts, branch buckets, recall-index drift (read-only)',
      sideEffect: 'read',
    },
    { verb: 'promote', summary: 'emit a reviewable branch→golden promotion op-set (.harness/promote-ops.json)' },
    { verb: 'prune', summary: 'delete branch buckets (human authority, never mode-gated)' },
    // extraOptions documents purge as two rows (`purge <file>` and
    // `purge --all`) because they read differently in help; they are one
    // verb with one handler branch, so the file form's text is the summary
    // and the reset form is described on `--all` itself below.
    // `positionals` is what makes `purge <file>` and `commit <none|repo>`
    // completable from the palette: the `target` positional is optional at
    // the entry level (a mode switch takes none), so only the two verbs that
    // genuinely demand it say so, and their rows carry a value slot for it.
    { verb: 'purge', summary: 'cascade-delete an episode and dependent learnings', positionals: ['target'] },
    {
      verb: 'commit',
      summary:
        'repo mirrors ACTIVE learnings into docs/knowledge/learnings (opt-in, never git-commits the product repo); none is the default',
      positionals: ['target'],
    },
    {
      verb: 'migrate-store',
      summary:
        "move a stranded path-keyed store to this workspace's current (remote-keyed) store id; refuses if the target already exists",
    },
  ],
  args: {
    positionals: [
      {
        name: 'subcommand',
        description: 'on|suggest|off|freeze|capture-only|status|promote|prune|purge|commit|migrate-store',
        required: false,
        default: null,
      },
      { name: 'target', description: 'purge target, or the commit mode (none|repo)', required: false, default: null },
    ],
    flags: [
      // --status has no reader in cmdKnowledge (the bare/no-subcommand
      // branch already IS the status view) — declared anyway so the
      // pre-registry no-op invocation `harness knowledge --status` keeps
      // validating, matching the old CATALOG's documented `--status` option.
      // cli-only, NOT `verb`: the `status` verb enumerated above is the same
      // report reached through the token the handler actually branches on.
      // Painting this no-op as a row too would put two palette entries in
      // front of one behavior, and the one that "works" would be the one
      // that does nothing.
      { name: '--status', type: 'boolean', description: 'show the active mode (default)', required: false, default: false, tui: 'cli-only' },
      // `purge --all` reads this flag-shaped token directly off argv[1]
      // (cmdKnowledge), never through lib/flags.mjs — still flag-shaped, so
      // strict validation needs it declared or it rejects as unknown.
      // `promote --all` reads the SAME flag through flags.all.
      // Scoped to those two verbs: it is meaningless on a mode switch or a
      // commit, and `knowledge on --all` silently accepting it is precisely
      // the "flag that does nothing here" this registry refuses to keep.
      // cli-only because it means two unrelated things depending on the verb
      // (reset the store vs. take every id) — a palette row reading "all"
      // would be ambiguous where a scoped picker under each verb is not.
      {
        name: '--all',
        type: 'boolean',
        description: 'purge --all resets the whole learnings store; promote --all takes every promotable id in the bucket',
        required: false,
        default: false,
        tui: 'cli-only',
        verbs: ['promote', 'purge'],
      },
      // Merge (harness evolution P6, blueprint §5): the branch-bucket
      // maintenance surfaces. Each of the five below is genuinely read by
      // cmdKnowledge's promote/prune branches (flags.branch / flags.ids /
      // flags.merged / flags.stale / flags.yes), so strict validation must
      // know them or every one of main's new invocations is rejected as an
      // unknown flag before its handler ever runs. `verbs` below records
      // WHICH of those branches reads each one — the extraOptions rows above
      // already document the same scoping in prose (`promote [--branch]
      // [--ids] [--all]`, `prune [--branch] [--merged] [--stale]`).
      { name: '--branch', type: 'string', valueName: 'key', description: 'promote/prune: the branch bucket key to act on', required: false, default: null, tui: 'prompt', verbs: ['promote', 'prune'] },
      { name: '--ids', type: 'string', valueName: 'a,b', description: 'promote: comma-separated learning ids to include in the op-set', required: false, default: null, tui: 'prompt', verbs: ['promote'] },
      // The one flag here that earns a row: `knowledge prune merged` is a
      // distinct sweep (every already-merged bucket) rather than a value to
      // pick, and it reads as a verb phrase under prune.
      { name: '--merged', type: 'boolean', description: 'prune: every bucket whose branch is already merged into the default branch', required: false, default: false, tui: 'verb', verbs: ['prune'] },
      { name: '--stale', type: 'string', valueName: 'days', description: 'prune: every bucket older than <days> (integer >= 1)', required: false, default: null, tui: 'prompt', verbs: ['prune'] },
      // A confirmation, which is always cli-only — a palette confirms
      // destructive work with its own prompt, never by making the user
      // pre-select the word "yes".
      { name: '--yes', type: 'boolean', description: 'prune: confirm deleting a bucket that still holds ACTIVE, unpromoted learnings', required: false, default: false, tui: 'cli-only', verbs: ['prune'] },
    ],
  },
  handler: cmdKnowledge,
});

registerCommand({
  name: 'consolidate',
  summary: 'episode→learning debt, work packet, and validated apply',
  group: 'knowledge',
  sideEffect: 'mutate',
  // Bare `consolidate` is the read-only status view; only --apply and
  // --rebuild write. See bareSideEffect in assertValidEntry.
  bareSideEffect: 'read',
  usage: '[--status | --candidates | --apply --ops <path> | --rebuild --yes]',
  args: {
    positionals: [],
    flags: [
      // --status has no reader (the default/no-flag branch already IS the
      // status view) — declared for the same no-op-but-documented reason as
      // `knowledge --status` above.
      // cli-only for a related but not identical reason: consolidate has no
      // subcommands, so the thing this no-op duplicates is the BARE
      // `consolidate` row rather than a verb. Marking it `verb` would put
      // `consolidate` and `consolidate status` side by side as two rows
      // running the same code.
      { name: '--status', type: 'boolean', description: 'debt vs threshold, quarantine, promotion candidates (default)', required: false, default: false, tui: 'cli-only' },
      // The three real operations behind consolidate's alternation usage —
      // emit a work packet, apply an ops file, reset the store. Each is a
      // different job with a different side effect, so each is a row.
      { name: '--candidates', type: 'boolean', description: 'deterministic work packet for the consolidation skill', required: false, default: false, tui: 'verb', sideEffect: 'read' },
      {
        name: '--apply',
        type: 'boolean',
        description: 'validate and apply an ops JSON (sole writer); suggest mode requires --yes',
        required: false,
        default: false,
        tui: 'verb',
        // The pairing the usage line already spells as `--apply --ops <path>`
        // and cmdConsolidate already enforces before it imports applyOps.
        // Declared so the palette knows `consolidate apply` must prompt for
        // an ops path — there is no apply without one. No invocation changes
        // class: same E_USAGE, same exit 2, and nothing that worked before
        // is rejected now, since the handler refused this exact case
        // already. What DOES shorten is the wording — the handler's
        // "--apply requires --ops <path> (the skill-emitted operations
        // JSON)" plus its `harness consolidate --apply --ops ops.json` hint
        // become this module's generic pair. Accepted deliberately: the
        // handler guard stays in place for direct callers, and the
        // dependency has to be data for the palette to honor it at all.
        requires: ['--ops'],
      },
      // `sideEffect: 'read'` on both value flags below for the same reason as
      // report's `--host`: each is offered on the read-only `consolidate` and
      // `consolidate candidates` rows, and naming a path or a layer does not
      // itself write anything — `--apply` is the sole writer. The class here
      // is what ADDING the option does to the invocation, not what the
      // operation it parameterizes eventually does.
      { name: '--ops', type: 'string', valueName: 'path', description: 'ops JSON path (with --apply)', required: false, default: null, tui: 'prompt', sideEffect: 'read' },
      // No `requires: ['--yes']` on --rebuild despite the usage line pairing
      // them: rebuild without --yes is not a usage error, it is the PREVIEW
      // ("rebuild resets N learnings … re-run with --yes"), and a registry
      // dependency would replace that count with a generic refusal.
      { name: '--rebuild', type: 'boolean', description: 'T2 reset for model-upgrade regeneration (git history retains learnings)', required: false, default: false, tui: 'verb' },
      { name: '--yes', type: 'boolean', description: 'confirm --apply (suggest mode) or --rebuild', required: false, default: false, tui: 'cli-only' },
      // Merge (harness evolution P6): explicit layer override threaded into
      // applyOps (lib/commands.mjs#cmdConsolidate -> `layer: flags.layer`).
      // No `requires: ['--apply']` — unlike --ops above, nothing rejects a
      // stray --layer today, so declaring the dependency would newly fail an
      // invocation that currently succeeds.
      { name: '--layer', type: 'string', valueName: 'golden|branch', description: 'explicit layer override for --apply (writes otherwise route by write-time git context)', required: false, default: null, tui: 'prompt', sideEffect: 'read' },
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
      { name: '--trigger', type: 'string', valueName: 't', description: 'applicability condition (required)', required: true, default: null, tui: 'prompt' },
      { name: '--domain', type: 'string', valueName: 'd', description: 'learning domain directory (default general)', required: false, default: null, tui: 'prompt' },
      // Undocumented in the old CATALOG, but read (lib/knowledge/remember.mjs
      // threads its whole `flags` object into the underlying insight write).
      { name: '--category', type: 'string', valueName: 'c', description: 'docs/solutions/<category>/ (default teachings)', required: false, default: null, tui: 'prompt' },
      { name: '--tags', type: 'string', valueName: 'a,b', description: 'comma-separated tags', required: false, default: null, tui: 'prompt' },
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
  // The four actions lib/knowledge/lifecycle.mjs dispatches on (its own
  // ACTIONS set), lifted out of the `usage` alternation. cmdLearning reads
  // them from argv[0], the same token validateArgs resolves as the selected
  // verb. No `sideEffect` overrides: all four append a governance record and
  // rewrite the learning's frontmatter, so every one is the parent's
  // `mutate`.
  // Every action names exactly one learning, so all four consume the `id`
  // positional — without it the row is a verb the CLI would refuse.
  verbs: [
    { verb: 'retire', summary: 'retire the learning from ranking (requires --reason)', positionals: ['id'] },
    { verb: 'dispute', summary: 'mark the learning contested pending review (requires --reason)', positionals: ['id'] },
    { verb: 'confirm', summary: 'reaffirm the learning as active and stamp last_confirmed', positionals: ['id'] },
    { verb: 'promote', summary: 'record that behavior now lives in a primitive (requires --to); terminal for the other three', positionals: ['id'] },
  ],
  args: {
    positionals: [
      { name: 'action', description: 'retire|dispute|confirm|promote', required: true, default: null },
      { name: 'id', description: 'the learning id', required: true, default: null },
    ],
    flags: [
      // Deliberately NOT scoped to retire/dispute even though only those two
      // require it: lifecycle.mjs records `reason` on all four actions
      // (appendGovernance's `reason: reason || null`, and the commit message
      // `${action} ${id}: ${reason}`), so `learning confirm <id> --reason
      // "…"` is a working invocation, not a typo to reject.
      { name: '--reason', type: 'string', valueName: 'r', description: 'required for retire/dispute; recorded in the store commit', required: false, default: null, tui: 'prompt' },
      // Scoped, unlike --reason: `to` is read only inside lifecycle.mjs's
      // promote branch, so on any other action it is a flag that silently
      // does nothing — exactly what this registry declines to keep accepting.
      { name: '--to', type: 'string', valueName: 'path', description: 'primitive path recorded on promote (behavior supersedes knowledge)', required: false, default: null, tui: 'prompt', verbs: ['promote'] },
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
  // The one machine-only entry in the registry, and the summary says so
  // outright: it prints the path a WRAPPER needs in order to invoke the
  // harness. Its whole output is an input to another program — a human
  // choosing it from a palette gets a filesystem path and nothing to do
  // with it. `cli` only (it is a shell/hook primitive), and NOT
  // user-invocable, so a host building a menu from this registry leaves it
  // out rather than listing plumbing beside real work.
  surfaces: ['cli'],
  userInvocable: false,
  args: { positionals: [], flags: [] },
  handler: cmdResolve,
});
