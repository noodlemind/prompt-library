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
 */
import { EXIT } from './style.mjs';
import { cmdOrient, cmdLearnings, cmdStatus } from './commands.mjs';

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
 * already computes from `process.argv`. `ctx` is reserved for later phases
 * (output-lane selection, injected clock/streams, policy) and is passed
 * through untouched; today's handlers ignore it.
 *
 * Resolves to the handler's exit code. Throws the same `{ code: 'E_USAGE',
 * exit: EXIT.usage }` shape for an unregistered command or an unknown flag
 * that every other harness error already uses — bin/harness.mjs's existing
 * top-level catch renders it via `ui.errorBlock` / the `--json` error
 * envelope with no new error-handling path required. Callers that want the
 * switch-fallback behavior described in the Phase 1 plan should check
 * `hasCommand(name)` before calling `dispatch` for that command.
 */
export async function dispatch(argv, ctx = {}) {
  const [name, ...rest] = argv;
  const entry = REGISTRY.get(name);
  if (!entry) {
    throw usageError(`unknown command: ${name}`, 'harness help');
  }
  validateArgs(entry, rest);
  return entry.handler(rest, ctx);
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
});
