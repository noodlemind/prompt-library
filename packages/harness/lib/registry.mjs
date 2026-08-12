import path from 'node:path';
import { EXIT } from './style.mjs';
import { normalizeChoices } from './value-sources.mjs';
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
import {
  cmdEdit, editResultOf, cmdWrite, writeResultOf, cmdUndo, undoResultOf,
  exitFor as editExitFor, literalFlag,
} from './edit-cmd.mjs';
import { cmdAgent, agentResultOf, agentExitFor, agentJournalArgv, taskFromArgv } from './agent-cmd.mjs';
import { DEFAULT_MAX_SECONDS, DEFAULT_MAX_TURNS, DEFAULT_PERSONA } from './agent-loop.mjs';
import { DEFAULT_PROVIDER, PROVIDERS } from './provider.mjs';
import { GET_DEFAULT_LINES, GET_DEFAULT_MAX_BYTES } from './get-cmd.mjs';
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

export const SURFACES = ['cli', 'tui', 'agent'];

export const TUI_DISPOSITIONS = ['verb', 'prompt', 'cli-only'];

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
  assertValidChoices(entry, args);
}

function assertValidChoices(entry, args) {
  for (const def of [...args.flags, ...args.positionals]) {
    normalizeChoices(def.choices, { where: `registerCommand: "${entry.name}" ${def.name}` });
  }
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

export function validateArgs(entry, argv) {
  const known = flagIndex(entry);
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
        if (def.type !== 'boolean' || eq === -1) present.add(def.name);
    if (def.type !== 'boolean' && eq === -1) {
      const next = argv[i + 1];
            const nextIsValue = next !== undefined && (def.valueIsLiteral === true || !next.startsWith('--'));
      if (nextIsValue) i++;
    }
  }

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

export async function dispatch(argv, ctx = {}) {
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
    if (typeof entry.requireArgs === 'function') {
    const message = entry.requireArgs(rest, parseFlags(rest));
    if (message) throw usageError(message);
  }
    ctx.onRunStart?.();
    const instrumented = entry.instrument !== false;
  const events = instrumented && ctx.events && typeof ctx.events.withCommand === 'function' ? ctx.events.withCommand(entry.name) : null;
    if (lane === 'json' || lane === 'agent') {
    return dispatchLane(entry, rest, ctx, lane, events);
  }
  return runHandler(entry, rest, ctx, events);
}

const LANE_DISPLAY_NAMES = { json: 'json-envelope', agent: 'agent', jsonl: 'jsonl' };

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

function statusForExit(exit) {
  if (exit === EXIT.ok) return STATUS.OK;
  if (exit === EXIT.cancelled) return STATUS.CANCELLED;
  if (exit === EXIT.timedOut) return STATUS.TIMED_OUT;
  return STATUS.FAILED;
}

function legacyResultForStatus(status) {
  if (status === STATUS.OK) return 'pass';
  if (status === STATUS.FAILED) return 'fail';
  return 'warn';
}

function commandResultPayload(status, durationMs, exitCode) {
  return { status, result: legacyResultForStatus(status), durationMs, exitCode };
}

const PENDING_RESULT = 'pending';

async function runHandler(entry, rest, ctx, events) {
  const startedAt = Date.now();
  events?.emit(EVENT_TYPE.COMMAND_START, { flags: summarizeArgFlags(rest, flagIndex(entry)), result: PENDING_RESULT });
  try {
    const exit = await entry.handler(rest, ctx);
        const status = ctx.__reportedStatus ?? statusForExit(exit);
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(status, Date.now() - startedAt, exit));
    return exit;
  } catch (err) {
    const exit = Number.isInteger(err.exit) ? err.exit : 1;
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(statusForExit(exit), Date.now() - startedAt, exit));
    throw err;
  }
}

async function dispatchLane(entry, rest, ctx, lane, events) {
  const schema = 1;
  const startedAt = Date.now();
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
            process.stdout.write(rendered.text);
      if (events) recordAgentLaneBytes({ writeEvent: (record) => events.emit(record.type, { ...record, result: PENDING_RESULT }) }, entry.name, rendered.bytes);
    } else {
            console.log(redactedJson(envelope, { redactor }));
    }
        const status = envelope.status || STATUS.OK;
        ctx.reportStatus?.(status);
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
            process.stdout.write(rendered.text);
      if (events) recordAgentLaneBytes({ writeEvent: (record) => events.emit(record.type, { ...record, result: PENDING_RESULT }) }, entry.name, rendered.bytes);
    } else {
            console.error(redactedJson(errorEnvelope, { redactor }));
    }
    events?.emit(EVENT_TYPE.COMMAND_RESULT, commandResultPayload(status, Date.now() - startedAt, exit));
    return exit;
  }
}

async function orientResultOf(argv) {
  const { result } = await computeOrientResult(argv);
  return result;
}

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

function recallRequireArgs(rest, flags) {
  const query = parseQueryFromArgv(rest, flags);
  if (!query) return 'recall requires a query string, e.g. harness recall "orders timeout"';
}

function agentRequireArgs(rest) {
  if (!taskFromArgv(rest)) return 'agent needs a task, e.g. harness agent "make the failing test pass"';
}

function getRequireArgs(rest, flags) {
  if (!flags.docid && !flags.path) {
    return 'get requires --docid <id> or --path <relative-path>';
  }
}

function editRequireArgs(rest) {
  if (!literalFlag(rest, '--path')) return 'edit requires --path <relative-path>';
  if (!literalFlag(rest, '--old')) return 'edit requires --old <text>';
  if (literalFlag(rest, '--new') === null) return 'edit requires --new <text>';
}

function writeRequireArgs(rest) {
  if (!literalFlag(rest, '--path')) return 'write requires --path <relative-path>';
  if (literalFlag(rest, '--content') === null) return 'write requires --content <text>';
}

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

// --- setup ------------------------------------------------------------

const INSTALL_FLAGS = [
  { name: '--target', type: 'string', valueName: 't,..', description: 'vscode,cli,intellij', required: false, default: null, tui: 'cli-only' },
  { name: '--autonomy', type: 'string', valueName: 'mode', description: 'full | balanced | strict', required: false, default: null, tui: 'cli-only' },
  { name: '--configure-vscode', type: 'boolean', description: 'merge VS Code chat.* discovery settings', required: false, default: false, tui: 'cli-only' },
  { name: '--configure-path', type: 'boolean', description: 'append ~/.copilot/bin to shell PATH (~/.zshrc, ~/.bashrc)', required: false, default: false, tui: 'cli-only' },
  { name: '--force-profile', type: 'boolean', description: 'overwrite knowledge/profile.md', required: false, default: false, tui: 'cli-only' },
  { name: '--force-knowledge-reset', type: 'boolean', description: 'overwrite knowledge/solutions (danger)', required: false, default: false, tui: 'cli-only' },
    { name: '--preserve-knowledge', type: 'boolean', description: 'keep existing knowledge/solutions (default)', required: false, default: true, tui: 'cli-only' },
];

registerCommand({
  name: 'install',
  summary: 'hydrate skills, agents, and team knowledge globally',
  group: 'setup',
  sideEffect: 'mutate',
    surfaces: ['cli'],
  args: { positionals: [], flags: INSTALL_FLAGS },
  handler: (argv) => cmdInstallOrUpgrade('install', argv),
});

registerCommand({
  name: 'upgrade',
  summary: 're-hydrate and purge retired primitives',
  group: 'setup',
  sideEffect: 'mutate',
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
    surfaces: ['cli'],
  args: { positionals: [], flags: [] },
  handler: cmdInitRepo,
});

registerCommand({
  name: 'index',
  summary: 'rebuild knowledge index · --status reports drift · --structural builds the code symbol index',
  group: 'workspace',
  sideEffect: 'mutate',
    usage: '[--status] [--structural [--since <ref>]]',
  args: {
    positionals: [],
    flags: [
            { name: '--status', type: 'boolean', description: 'read-only freshness report vs HEAD (never rebuilds)', required: false, default: false, tui: 'verb', sideEffect: 'read' },
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
    args: {
    positionals: [],
    flags: [
      { name: '--type', type: 'string', valueName: 't', description: 'feat|fix|docs|refactor|chore', required: true, default: null, tui: 'prompt' },
      { name: '--slug', type: 'string', valueName: 's', description: 'lowercase-hyphen slug', required: true, default: null, tui: 'prompt' },
      { name: '--intent', type: 'string', valueName: 'text', description: 'one-line intent', required: true, default: null, tui: 'prompt' },
      { name: '--impacted', type: 'string', valueName: 'a,b', description: 'comma-separated Impacted Files', required: false, default: null, tui: 'prompt' },
      { name: '--criteria', type: 'string', valueName: 'text', description: 'an acceptance criterion (repeatable)', required: false, default: null, tui: 'prompt' },
      { name: '--gap', type: 'string', valueName: 'id:path', description: 'capability gap → blocked-capability + governed primitive plan', required: false, default: null, tui: 'prompt' },
            { name: '--stdout', type: 'boolean', description: 'print the plan instead of writing it', required: false, default: false, tui: 'cli-only' },
            { name: '--title', type: 'string', valueName: 'text', description: 'plan heading override (default: derived from slug)', required: false, default: null, tui: 'prompt' },
      { name: '--date', type: 'string', valueName: 'yyyy-mm-dd', description: 'override the plan filename date (default: today)', required: false, default: null, tui: 'prompt' },
            { name: '--risk', type: 'string', valueName: 'green|amber|red', description: 'risk rating (default green)', required: false, default: null, tui: 'prompt' },
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
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null, tui: 'prompt', choices: 'plan' },
            { name: '--strict-intent', type: 'boolean', description: 'fail locked plans missing intent fields', required: false, default: false, tui: 'cli-only' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt', choices: ['observe', 'warn', 'enforce'] },
    ],
  },
  handler: cmdGate,
});

registerCommand({
  name: 'verify',
  summary: 'run trusted named checks and capture evidence',
  group: 'engineer loop',
  sideEffect: 'execute',
    supportsJsonl: true,
  args: {
    positionals: [],
    flags: [
      { name: '--plan', type: 'string', valueName: 'path', description: 'plan file whose named checks run', required: false, default: null, tui: 'prompt', choices: 'plan' },
      { name: '--base', type: 'string', valueName: 'git-ref', description: 'compare changed files to this git ref', required: false, default: null, tui: 'prompt' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt', choices: ['observe', 'warn', 'enforce'] },
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
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null, tui: 'prompt', choices: 'plan' },
      { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt', choices: ['observe', 'warn', 'enforce'] },
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
      { name: '--plan', type: 'string', valueName: 'path', description: 'explicit plan file', required: false, default: null, tui: 'prompt', choices: 'plan' },
            { name: '--insight', type: 'boolean', description: 'evidence-free investigation capture (kind: insight, secret-scanned)', required: false, default: false, tui: 'verb' },
            { name: '--title', type: 'string', valueName: 't', description: 'insight title (required with --insight)', required: false, default: null, tui: 'prompt' },
      { name: '--body', type: 'string', valueName: 'text', description: 'insight body text', required: false, default: null, tui: 'prompt' },
      { name: '--body-file', type: 'string', valueName: 'path', description: 'read insight body from a file', required: false, default: null, tui: 'prompt', choices: 'path' },
      { name: '--category', type: 'string', valueName: 'c', description: 'docs/solutions/<category>/ (default insights)', required: false, default: null, tui: 'prompt' },
      { name: '--tags', type: 'string', valueName: 'a,b', description: 'comma-separated tags', required: false, default: null, tui: 'prompt' },
      { name: '--trigger', type: 'string', valueName: 't', description: 'applicability condition frontmatter', required: false, default: null, tui: 'prompt' },
      { name: '--claim', type: 'string', valueName: 't', description: 'one-line claim frontmatter', required: false, default: null, tui: 'prompt' },
            { name: '--enforcement', type: 'string', valueName: 'mode', description: 'observe | warn | enforce (default enforce)', required: false, default: null, tui: 'prompt', choices: ['observe', 'warn', 'enforce'] },
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
        positionals: [{ name: 'query', description: 'free-text search terms (joined)', required: true, default: '', variadic: true }],
    flags: [
      { name: '--limit', type: 'number', valueName: 'n', description: 'result count (default 3)', required: false, default: 3, tui: 'prompt' },
      { name: '--collection', aliases: ['-c'], type: 'string', valueName: 'name', description: 'filter by knowledge/collections.yaml', required: false, default: null, tui: 'prompt' },
      { name: '--min-score', type: 'number', valueName: 'n', description: 'minimum score (default 0.15)', required: false, default: 0.15, tui: 'prompt' },
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
            { name: '--docid', type: 'string', valueName: 'id', description: 'manifest doc id', required: false, default: null, tui: 'prompt' },
      { name: '--path', type: 'string', valueName: 'rel', description: 'relative file path', required: false, default: null, tui: 'prompt', choices: 'path' },
      { name: '--lines', type: 'number', valueName: 'n', description: `max lines (default ${GET_DEFAULT_LINES})`, required: false, default: GET_DEFAULT_LINES, tui: 'prompt' },
      { name: '--offset', type: 'number', valueName: 'n', description: 'first line of the window, 1-indexed (default 1)', required: false, default: 1, tui: 'prompt' },
      { name: '--max-bytes', type: 'number', valueName: 'n', description: `max excerpt bytes (default ${GET_DEFAULT_MAX_BYTES})`, required: false, default: GET_DEFAULT_MAX_BYTES, tui: 'prompt' },
    ],
  },
  handler: cmdGet,
  resultOf: getResultOf,
  requireArgs: getRequireArgs,
});

registerCommand({
  name: 'edit',
  summary: 'replace one exact, unique piece of text in a file',
  group: 'engineer loop',
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: {
    positionals: [],
    flags: [
      { name: '--path', type: 'string', valueName: 'rel', description: 'the file to change, relative to the workspace', required: true, default: null, tui: 'prompt', choices: 'path', valueIsLiteral: true },
            { name: '--old', type: 'string', valueName: 'text', description: 'the exact text to replace; it must appear exactly once', required: true, default: null, tui: 'prompt', valueIsLiteral: true },
      { name: '--new', type: 'string', valueName: 'text', description: 'what to put in its place', required: true, default: null, tui: 'prompt', valueIsLiteral: true },
    ],
  },
  handler: cmdEdit,
  resultOf: editResultOf,
  requireArgs: editRequireArgs,
  exitOf: editExitFor,
});

registerCommand({
  name: 'write',
  summary: 'create a file, or replace one whose current content you can prove',
  group: 'engineer loop',
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  args: {
    positionals: [],
    flags: [
      { name: '--path', type: 'string', valueName: 'rel', description: 'the file to write, relative to the workspace', required: true, default: null, tui: 'prompt', choices: 'path', valueIsLiteral: true },
      { name: '--content', type: 'string', valueName: 'text', description: 'the complete new contents of the file', required: true, default: null, tui: 'prompt', valueIsLiteral: true },
            { name: '--expect', type: 'string', valueName: 'sha256', description: 'the digest of the content being replaced — required to overwrite an existing file', required: false, default: null, tui: 'prompt' },
            { name: '--allow-shrink', type: 'boolean', description: 'confirm replacing an existing file with much smaller content is intended', required: false, default: false, tui: 'cli-only' },
    ],
  },
  handler: cmdWrite,
  resultOf: writeResultOf,
  requireArgs: writeRequireArgs,
  exitOf: editExitFor,
});

registerCommand({
  name: 'undo',
  summary: 'put back the most recent edit/write, or list outstanding undos',
  group: 'engineer loop',
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  surfaces: ['cli', 'tui'],
  usage: '[list]',
  args: {
    positionals: [
      { name: 'verb', description: 'list — show outstanding undos without reverting', required: false, default: null },
    ],
    flags: [],
  },
  handler: cmdUndo,
  resultOf: undoResultOf,
  exitOf: editExitFor,
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
    exitOf: execExitFor,
});

registerCommand({
  name: 'bash',
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
    surfaces: ['cli', 'agent'],
  summary: 'open the session ledger — a scrolling transcript that dispatches through this same registry',
  group: 'engineer loop',
    sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger'],
  usage: '',
  args: { positionals: [], flags: [] },
    handler: async (argv, ctx) => (await import('./tui-cmd.mjs')).cmdTui(argv, ctx),
  });

registerCommand({
  name: 'resources',
  summary: 'list, inspect, register, or unregister locally-added skills and agents',
  group: 'setup',
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
    sideEffect: 'execute',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '<task...> [--agent <persona>] [--provider <id>] [--model <id>] [--max-turns <n>] [--max-seconds <s>] [--tool-timeout <s>] [--dry-run]',
  args: {
        positionals: [{ name: 'task...', description: 'what to do, in words', required: true, default: null }],
    flags: [
      { name: '--agent', type: 'string', valueName: 'persona', description: `which hydrated persona to run as (default ${DEFAULT_PERSONA})`, required: false, default: DEFAULT_PERSONA, tui: 'prompt' },
      { name: '--provider', type: 'string', valueName: 'id', description: `which provider answers the model call: ${Object.keys(PROVIDERS).join('|')} (default ${DEFAULT_PROVIDER})`, required: false, default: DEFAULT_PROVIDER, tui: 'prompt' },
      { name: '--model', type: 'string', valueName: 'id', description: "the model to call; the provider's default when omitted", required: false, default: null, tui: 'prompt' },
      { name: '--max-turns', type: 'number', valueName: 'n', description: `stop after this many turns (default ${DEFAULT_MAX_TURNS})`, required: false, default: DEFAULT_MAX_TURNS, tui: 'prompt' },
      { name: '--max-seconds', type: 'number', valueName: 's', description: `stop after this much wall clock (default ${DEFAULT_MAX_SECONDS})`, required: false, default: DEFAULT_MAX_SECONDS, tui: 'prompt' },
      { name: '--tool-timeout', type: 'number', valueName: 's', description: "ceiling on one tool's runtime in seconds; the model may ask for less, never more", required: false, default: null, tui: 'prompt' },
    ],
  },
    requireArgs: agentRequireArgs,
  handler: cmdAgent,
  resultOf: agentResultOf,
    journalArgv: agentJournalArgv,
    exitOf: agentExitFor,
});

registerCommand({
  name: 'run',
  summary: 'list, inspect, or judge the resumability of past harness runs',
  group: 'engineer loop',
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
      { name: 'run-id', description: 'a run id or an unambiguous prefix', required: false, default: null, choices: 'run' },
    ],
    flags: [
      { name: '--status', type: 'string', valueName: 'status', description: `list: ${RUN_STATUSES.join('|')}`, required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--command', type: 'string', valueName: 'name', description: 'list: only runs of this command', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--host', type: 'string', valueName: 'host', description: 'list: only runs from this host', required: false, default: null, tui: 'prompt', verbs: ['list'] },
      { name: '--plan', type: 'string', valueName: 'path', description: 'list: only runs against this plan', required: false, default: null, tui: 'prompt', verbs: ['list'], choices: 'plan' },
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
    requireArgs: runRequireArgs,
});

registerCommand({
  name: 'model',
  summary: 'choose the provider and model that answer',
  group: 'engineer loop',
    tuiPicker: 'model',
  // `set`/`clear` write config; a bare `model` reads, which is the common call.
  sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
  usage: '[show|set|clear] [provider] [model] [--scope <scope>]',
  verbs: [
    { verb: 'show', summary: 'the active provider and model, and every provider you can reach', sideEffect: 'read' },
    { verb: 'set', summary: 'make a provider (and optionally a model) the default', positionals: ['provider', 'model'] },
    { verb: 'clear', summary: 'forget the choice and fall back to the built-in default' },
        { verb: 'refresh', summary: 'ask a provider which models it actually serves, and remember the answer', positionals: ['provider'] },
  ],
  args: {
    positionals: [
      { name: 'verb', description: MODEL_VERBS.join('|'), required: false, default: 'show', choices: MODEL_VERBS },
            { name: 'provider', description: 'the provider id, for set', required: false, default: null, choices: 'provider' },
      { name: 'model', description: 'the model id, for set; omit for the provider default', required: false, default: null, choices: 'model' },
    ],
    flags: [
      { name: '--scope', type: 'string', valueName: 'scope', description: `which file remembers the choice, ${SCOPES.join(' or ')}`, required: false, default: null, tui: 'prompt', verbs: ['set', 'clear'], choices: 'scope' },
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
    bareSideEffect: 'read',
  handler: cmdTrust,
  resultOf: trustResultOf,
});

registerCommand({
  name: 'config',
  summary: 'show, read, or change harness configuration across the user and project scopes',
  group: 'engineer loop',
    sideEffect: 'mutate',
  capabilities: [],
  outputModes: ['ledger', 'json'],
    usage: '<show|get|set|validate> [key] [value] [--scope <scope>]',
  verbs: [
    { verb: 'show', summary: 'every key, its effective value, and which scope supplied it', sideEffect: 'read' },
    { verb: 'get', summary: 'one key: its effective value and provenance', sideEffect: 'read', positionals: ['key'] },
    { verb: 'set', summary: 'write one key into the user or project scope, atomically', positionals: ['key', 'value'] },
    { verb: 'validate', summary: 'parse both scopes and report every schema violation', sideEffect: 'read' },
  ],
  args: {
    positionals: [
      { name: 'verb', description: CONFIG_VERBS.join('|'), required: true, default: null, choices: CONFIG_VERBS },
            { name: 'key', description: CONFIG_KEYS.join('|'), required: false, default: null, choices: 'config-key' },
      { name: 'value', description: 'the new value, for set', required: false, default: null, choices: 'config-value' },
    ],
    flags: [
            { name: '--scope', type: 'string', valueName: 'scope', description: `set: which file to write, ${SCOPES.join(' or ')}`, required: true, default: null, tui: 'prompt', verbs: ['set'], choices: 'scope' },
    ],
  },
  handler: cmdConfig,
  resultOf: configResultOf,
    exitOf: configExitFor,
});

registerCommand({
  name: 'checks',
  summary: 'list, inspect, or run one named check from the trusted check config',
  group: 'engineer loop',
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
    sideEffect: 'read',
  capabilities: [],
  outputModes: ['ledger', 'json'],
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
    resultOf: lookupResultOf,
    usage: `<${LOOKUP_KINDS.join('|')}> <identifier>`,
});

registerCommand({
  name: 'events',
  summary: 'session telemetry',
  group: 'engineer loop',
  sideEffect: 'read',
    instrument: false,
  args: {
    positionals: [],
    flags: [
      { name: '--session', type: 'string', valueName: 'id', description: 'filter by host session ID', required: false, default: null, tui: 'prompt' },
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
    sideEffect: 'mutate',
    bareSideEffect: 'read',
    usage: '[--sync] [--global] [--check] [--json]',
    instrument: false,
  args: {
    positionals: [],
    flags: [
            { name: '--sync', type: 'boolean', description: 'merge workspace events into the global store first', required: false, default: false, tui: 'verb' },
      { name: '--global', type: 'boolean', description: 'report across all synced workspaces', required: false, default: false, tui: 'verb', sideEffect: 'read' },
            { name: '--check', type: 'boolean', description: 'exit non-zero on a budget breach (CI)', required: false, default: false, tui: 'cli-only' },
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
    usage: '<on|suggest|off|freeze|capture-only> | --status | purge <file|--all> | commit <none|repo> | migrate-store',
    extraOptions: [
    ['status', 'layer-aware report: golden domain counts, branch buckets, recall-index drift (read-only)'],
    ['promote [--branch <key>] [--ids a,b] [--all]', 'emit a reviewable branch→golden promotion op-set (.harness/promote-ops.json)'],
    ['prune [--branch <key>] [--merged] [--stale <days>]', 'delete branch buckets (human authority, never mode-gated)'],
    ['purge <file>', 'cascade-delete an episode and dependent learnings'],
    ['purge --all', 'reset the learnings store (episodes remain, become debt)'],
    ['commit <none|repo>', 'repo mirrors ACTIVE learnings into docs/knowledge/learnings (opt-in, never git-commits the product repo); none is the default'],
    ['migrate-store', "move a stranded path-keyed store to this workspace's current (remote-keyed) store id; refuses if the target already exists"],
  ],
    verbs: [
    { verb: 'on', summary: 'default mode: orient injects, and every writer (remember, compound --insight, consolidate --apply) is open' },
    { verb: 'suggest', summary: 'approve-before-write: consolidate --apply stops until a human re-runs it with --yes' },
    { verb: 'off', summary: 'kill switch: no injection and no writers at all' },
    { verb: 'freeze', summary: 'read-only layer: orient still injects, but remember and consolidate --apply stop writing' },
    { verb: 'capture-only', summary: 'stop injecting into orient while compound --insight keeps capturing' },
        {
      verb: 'status',
      summary: 'layer-aware report: golden domain counts, branch buckets, recall-index drift (read-only)',
      sideEffect: 'read',
    },
    { verb: 'promote', summary: 'emit a reviewable branch→golden promotion op-set (.harness/promote-ops.json)' },
    { verb: 'prune', summary: 'delete branch buckets (human authority, never mode-gated)' },
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
            { name: '--status', type: 'boolean', description: 'show the active mode (default)', required: false, default: false, tui: 'cli-only' },
            {
        name: '--all',
        type: 'boolean',
        description: 'purge --all resets the whole learnings store; promote --all takes every promotable id in the bucket',
        required: false,
        default: false,
        tui: 'cli-only',
        verbs: ['promote', 'purge'],
      },
            { name: '--branch', type: 'string', valueName: 'key', description: 'promote/prune: the branch bucket key to act on', required: false, default: null, tui: 'prompt', verbs: ['promote', 'prune'] },
      { name: '--ids', type: 'string', valueName: 'a,b', description: 'promote: comma-separated learning ids to include in the op-set', required: false, default: null, tui: 'prompt', verbs: ['promote'] },
            { name: '--merged', type: 'boolean', description: 'prune: every bucket whose branch is already merged into the default branch', required: false, default: false, tui: 'verb', verbs: ['prune'] },
      { name: '--stale', type: 'string', valueName: 'days', description: 'prune: every bucket older than <days> (integer >= 1)', required: false, default: null, tui: 'prompt', verbs: ['prune'] },
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
    bareSideEffect: 'read',
  usage: '[--status | --candidates | --apply --ops <path> | --rebuild --yes]',
  args: {
    positionals: [],
    flags: [
            { name: '--status', type: 'boolean', description: 'debt vs threshold, quarantine, promotion candidates (default)', required: false, default: false, tui: 'cli-only' },
            { name: '--candidates', type: 'boolean', description: 'deterministic work packet for the consolidation skill', required: false, default: false, tui: 'verb', sideEffect: 'read' },
      {
        name: '--apply',
        type: 'boolean',
        description: 'validate and apply an ops JSON (sole writer); suggest mode requires --yes',
        required: false,
        default: false,
        tui: 'verb',
                requires: ['--ops'],
      },
            { name: '--ops', type: 'string', valueName: 'path', description: 'ops JSON path (with --apply)', required: false, default: null, tui: 'prompt', sideEffect: 'read', choices: 'path' },
            { name: '--rebuild', type: 'boolean', description: 'T2 reset for model-upgrade regeneration (git history retains learnings)', required: false, default: false, tui: 'verb' },
      { name: '--yes', type: 'boolean', description: 'confirm --apply (suggest mode) or --rebuild', required: false, default: false, tui: 'cli-only' },
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
            { name: '--reason', type: 'string', valueName: 'r', description: 'required for retire/dispute; recorded in the store commit', required: false, default: null, tui: 'prompt' },
            { name: '--to', type: 'string', valueName: 'path', description: 'primitive path recorded on promote (behavior supersedes knowledge)', required: false, default: null, tui: 'prompt', verbs: ['promote'], choices: 'path' },
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
    surfaces: ['cli'],
  userInvocable: false,
  args: { positionals: [], flags: [] },
  handler: cmdResolve,
});
