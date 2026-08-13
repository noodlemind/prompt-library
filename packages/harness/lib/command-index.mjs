import fs from 'node:fs';
import { listCommands, getCommand, SIDE_EFFECTS, SURFACES } from './registry.mjs';
import { createEnvelope, STATUS } from './envelope.mjs';
import { normalizeChoices } from './value-sources.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';

/** What a row represents. Verb rows come from two structurally different
 * sources (a declared subcommand and a `tui: 'verb'` flag) but present
 * identically to the palette, so both carry `kind: 'verb'`. */
export const ROW_KINDS = Object.freeze(['command', 'verb', 'skill']);

export const TOKEN_KINDS = Object.freeze(['command', 'subcommand', 'flag', 'value']);

/** Where skills are discovered, relative to the workspace root. Reported as a
 * relative posix path so the envelope stays machine-independent. */
export const SKILLS_DIR = '.github/skills';

/** `registerCommand` always normalizes `args`, but every accessor here goes
 * through this one helper anyway — a half-annotated registry is the expected
 * state, and one tolerant reader is cheaper than auditing each call site. */
function flagsOf(entry) {
  return entry.args?.flags || [];
}

function positionalsOf(entry) {
  return entry.args?.positionals || [];
}

function requiresList(def) {
  return Array.isArray(def.requires) ? def.requires : [];
}

function verbScope(def) {
  return Array.isArray(def.verbs) ? def.verbs : [];
}

function dependsOnVerbFlag(entry, def) {
  const byName = new Map();
  for (const f of flagsOf(entry)) {
    byName.set(f.name, f);
    for (const alias of f.aliases || []) byName.set(alias, f);
  }
  return requiresList(def).some((req) => byName.get(req)?.tui === 'verb');
}

/** A flag is its own palette row when it is dispositioned `verb` and does not
 * refine another verb flag (see `dependsOnVerbFlag`). */
function isVerbFlag(entry, def) {
  return def.tui === 'verb' && !dependsOnVerbFlag(entry, def);
}

/** Prompt flags are asked for after selection; one that refines a verb flag
 * belongs to that row instead. A prompt flag required BY a verb flag is still
 * that verb's parameter, which `promptsFor` resolves. */
function isPromptFlag(entry, def) {
  return def.tui === 'prompt' && !dependsOnVerbFlag(entry, def);
}

function verbNameForFlag(def) {
  return def.name.replace(/^-+/, '');
}

/** The value slot a non-boolean flag contributes, or null. `required` mirrors
 * the registry's own declaration so the palette knows whether it may dispatch
 * without asking. */
function valueTokenFor(def) {
  if (!def || def.type === 'boolean') return null;
  return {
    kind: 'value',
    flag: def.name,
    valueName: def.valueName || 'value',
    required: Boolean(def.required),
        choices: normalizeChoices(def.choices),
  };
}

function positionalToken(p) {
  return { kind: 'value', positional: p.name, valueName: p.name, required: true, choices: normalizeChoices(p.choices) };
}

/** The positional slots one declared verb consumes, resolved by name against
 * the entry's own declarations (registration already rejects a name the entry
 * does not declare, so the filter only guards a half-written entry). */
function positionalTokensForVerb(entry, declared) {
  const byName = new Map(positionalsOf(entry).map((p) => [p.name, p]));
  return (declared?.positionals || [])
    .map((name) => byName.get(name))
    .filter(Boolean)
    .map(positionalToken);
}

function optionRow(entry, def) {
  const row = {
    flag: def.name,
    type: def.type || 'string',
    valueName: def.type === 'boolean' ? null : def.valueName || 'value',
    required: Boolean(def.required),
    // Soft defaults on the ledger: scope defaults to user in config-cmd.
    requiredInTui: def.name === '--scope' ? false : Boolean(def.required),
    tui: def.tui || null,
    sideEffect: SIDE_EFFECTS.includes(def.sideEffect) ? def.sideEffect : entry.sideEffect,
    description: def.description || '',
    choices: normalizeChoices(def.choices),
  };
  const requires = requiresList(def);
  if (requires.length) row.requires = [...requires];
  return row;
}

function promptsFor(entry, verb) {
  return flagsOf(entry)
    .filter((def) => {
      if (!isPromptFlag(entry, def)) return false;
      const scope = verbScope(def);
      return scope.length === 0 || (verb !== null && scope.includes(verb));
    })
    .map((def) => optionRow(entry, def));
}

function promptsForFlagVerb(entry, def, verb) {
  const byName = new Map(flagsOf(entry).map((f) => [f.name, f]));
  const required = requiresList(def)
    .map((req) => byName.get(req))
    .filter((f) => f && f.tui !== 'cli-only')
    .map((f) => ({ ...optionRow(entry, f), required: true }));
    const requiredFlags = new Set(required.map((r) => r.flag));
  return [...required, ...promptsFor(entry, verb).filter((p) => !requiredFlags.has(p.flag))];
}

/** Refinements of one row: the dependent options whose `requires` names this
 * row's own flag. This is what keeps `--since` off the top level — it attaches
 * to `index structural` and is offered only after that row is chosen. */
function refinementsFor(entry, ownFlag) {
  if (!ownFlag) return [];
  return flagsOf(entry)
    .filter((def) => def.tui !== 'cli-only' && requiresList(def).includes(ownFlag))
    .map((def) => optionRow(entry, def));
}

function orphanRefinementsFor(entry, rowFlags) {
  return flagsOf(entry)
    .filter((def) => {
      if (def.tui === 'cli-only') return false;
      // Already a row of its own, or already this row's own picker.
      if (rowFlags.has(def.name) || isPromptFlag(entry, def)) return false;
      const requires = requiresList(def);
      if (requires.length === 0) return false;
      return requires.every((req) => !rowFlags.has(req));
    })
    .map((def) => optionRow(entry, def));
}

/**
 * Product-facing labels for the Session Ledger palette.
 * Keep argv/noun/verb machine-accurate; only the human label and note fold.
 * Rule: a stranger should know what the row does without reading registry prose.
 */
const TUI_VERB_LABELS = Object.freeze({
  'config:show': 'Show all settings',
  'config:get': 'Get one setting',
  'config:set': 'Change a setting',
  'config:validate': 'Validate config files',
  'checks:list': 'List checks',
  'checks:show': 'Show a check',
  'checks:run': 'Run a check',
  'trust:status': 'Trust status',
  'trust:approve': 'Trust this project',
  'trust:revoke': 'Revoke project trust',
  'run:list': 'List past runs',
  'run:show': 'Show a run',
  'run:tree': 'Run event tree',
  'run:resume': 'Can this run resume?',
  'todo:list': 'List todos',
  'todo:add': 'Add a todo',
  'todo:complete': 'Complete a todo',
  'todo:clear': 'Clear todos',
  'undo:list': 'List undos',
  'model:show': 'Show model',
  'model:set': 'Set model',
  'model:clear': 'Clear model',
  'model:refresh': 'Refresh models',
  'inspect:config': 'Why is this setting this value?',
  'inspect:permissions': 'What is allowed here?',
  'inspect:workspace': 'Where is this workspace?',
  'inspect:tools': 'Which tools are on?',
  'tree:workspace': 'Browse project files',
  'tree:knowledge': 'Browse knowledge store',
  'learnings:why': 'Why was this learned?',
  'resources:list': 'List local skills and agents',
  'resources:show': 'Show one local skill or agent',
  'resources:register': 'Register a local skill or agent',
  'resources:unregister': 'Unregister without deleting',
  'resources:discard': 'Delete a local skill, agent, or extra file',
  'resources:bundles': 'List installed bundles',
  'resources:add': 'Install a bundle',
  'resources:update': 'Replace an installed bundle',
  'resources:remove': 'Uninstall a bundle',
  'index:status': 'Check knowledge + code index status',
  'index:structural': 'Rebuild code symbol index',
  'orient:explain': 'Explain orient ranking',
  'compound:insight': 'Save an insight (no evidence)',
  'consolidate:apply': 'Apply consolidate ops',
  'consolidate:candidates': 'List consolidate candidates',
  'consolidate:rebuild': 'Rebuild consolidate debt',
  'events:failures': 'Failed events only',
  'events:summary': 'Events summary',
  'report:growth': 'Growth report',
  'report:global': 'Global report',
  'report:sync': 'Sync then report',
  'knowledge:on': 'Knowledge on (full)',
  'knowledge:off': 'Knowledge off',
  'knowledge:suggest': 'Knowledge suggest mode',
  'knowledge:freeze': 'Knowledge freeze',
  'knowledge:status': 'Knowledge status',
  'learning:confirm': 'Confirm a learning',
  'learning:retire': 'Retire a learning',
  'learning:dispute': 'Dispute a learning',
  'learning:promote': 'Promote a learning',
});

const TUI_COMMAND_LABELS = Object.freeze({
  search: 'Search',
  orient: 'Gather context',
  gate: 'Pre-edit gate',
  verify: 'Verify plan checks',
  compound: 'Save a learning',
  write: 'Write a file',
  edit: 'Edit a file',
  bash: 'Shell',
  exec: 'Run a program',
  agent: 'Agent task',
  status: 'Harness status',
  doctor: 'Health check',
  'init-repo': 'Initialize this repo',
  tui: 'Session ledger',
  help: 'Help',
  recall: 'Search team knowledge',
  get: 'Open a document',
  report: 'Reports',
  index: 'Rebuild knowledge index',
  tree: 'Browse files & knowledge',
  learnings: 'Browse learnings',
  knowledge: 'Knowledge layer',
  learning: 'Manage a learning',
  lookup: 'Open by id',
  remember: 'Teach the harness',
  consolidate: 'Consolidate learnings',
  events: 'Session events',
  apply: 'Apply multi-file patch',
  'plan-new': 'New plan',
  'validate-plan': 'Validate plan',
  'eval-knowledge': 'Eval knowledge retrieval',
  undo: 'Undo list',
  resources: 'Skills & agents',
  todo: 'Todos',
  run: 'Past runs',
  checks: 'Checks',
  trust: 'Project trust',
  model: 'Model',
  config: 'Settings',
  inspect: 'Inspect',
});

/** One-line product notes — shown in the palette instead of registry man-page text. */
const TUI_NOTES = Object.freeze({
  search: 'find code, plans, or knowledge by text',
  orient: 'pack plans + learnings for a task',
  gate: 'block edits until the plan is ready',
  verify: 'run named checks and keep evidence',
  compound: 'turn a passed run into a reusable learning',
  write: 'create or replace a file with proof of content',
  edit: 'replace one unique string in a file',
  bash: 'run a shell command (gated separately from exec)',
  exec: 'run a program without a shell',
  agent: 'optional model loop — host still owns mutations',
  status: 'version, home, and what is installed',
  doctor: 'is install, hooks, and knowledge healthy?',
  'init-repo': 'create the repo-local harness files and indexes',
  recall: 'search team solutions and learnings',
  get: 'read a bounded doc excerpt',
  report: 'token or growth reports from events',
  index: 'rebuild knowledge BM25 index (use index structural for code symbols)',
  tree: 'directory tree of the repo or knowledge store',
  learnings: 'list what the harness has learned',
  knowledge: 'turn the knowledge layer on/off or purge',
  learning: 'confirm, retire, dispute, or promote one item',
  lookup: 'open a plan, learning, or run by exact id',
  remember: 'teach a durable claim for later recall',
  consolidate: 'merge episode debt into learnings',
  events: 'telemetry for this session',
  apply: 'all-or-nothing multi-file write',
  'plan-new': 'scaffold a plan under docs/plans',
  'validate-plan': 'check plan readiness',
  undo: 'show reversible edits',
  resources: 'local skills and agents on disk',
  'resources:list': 'what was added by hand, and whether each file is valid',
  'resources:show': 'why one local file is pending, invalid, or stray',
  'resources:register': 'recognize a well-formed local skill or agent',
  'resources:unregister': 'stop recognizing a file without deleting it',
  'resources:discard': 'delete an invalid, stray, or unused local file',
  'resources:remove': 'uninstall a bundle — not a single skill file',
  todo: 'long-horizon worklist',
  run: 'history of harness runs',
  checks: 'named checks from the trusted config',
  trust: 'let this project change harness config',
  model: 'provider and model for the optional agent',
  config: 'settings — values and where they came from',
  inspect: 'effective config, permissions, tools',
  'tree:workspace': 'files under this workspace',
  'tree:knowledge': 'knowledge store as a tree',
  'learnings:why': 'full provenance for one learning id',
});

/** Empty-palette order: intents people reach for first (product, not A–Z). */
export const TUI_COMMON_NOUNS = Object.freeze([
  'search',
  'config',
  'model',
  'bash',
  'run',
  'inspect',
  'agent',
  'tree',
  'learnings',
  'recall',
  'remember',
  'gate',
  'verify',
  'init-repo',
  'walkthrough',
  'doctor',
  'status',
]);

function tuiLabel(noun, verb = null) {
  if (verb) {
    const key = `${noun}:${verb}`;
    if (TUI_VERB_LABELS[key]) return TUI_VERB_LABELS[key];
    // lookup kinds, knowledge verbs — short product pair, not "noun · raw"
    const verbLabel = String(verb).replace(/-/g, ' ');
    const head = TUI_COMMAND_LABELS[noun] || noun;
    return `${head} · ${verbLabel}`;
  }
  return TUI_COMMAND_LABELS[noun] || noun;
}

function tuiNote(noun, verb = null, fallback = '') {
  if (verb) {
    const key = `${noun}:${verb}`;
    if (TUI_NOTES[key]) return TUI_NOTES[key];
  }
  if (TUI_NOTES[noun]) return TUI_NOTES[noun];
  // Strip flag soup and CLI jargon from registry summaries when used as note.
  const plain = String(fallback || '')
    .replace(/\s*·\s*--\S+/g, '')
    .replace(/--\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain;
}

function withProductCopy(row, entry, { surface, verb = null } = {}) {
  if (surface !== 'tui') return row;
  return {
    ...row,
    label: tuiLabel(entry.name, verb),
    note: tuiNote(entry.name, verb, entry.summary),
    // Keep summary for machine/debug; palette prefers note.
    summary: tuiNote(entry.name, verb, entry.summary) || entry.summary || '',
  };
}

function commandRow(entry, prompts, refinements, { surface = 'cli' } = {}) {
  const argvTokens = [
    { kind: 'command', value: entry.name },
    ...positionalsOf(entry).filter((p) => p.required).map(positionalToken),
  ];
  const row = {
    id: `command:${entry.name}`,
    kind: 'command',
    noun: entry.name,
    verb: null,
    label: surface === 'tui' ? tuiLabel(entry.name) : entry.name,
    summary: entry.summary || '',
    sideEffect: SIDE_EFFECTS.includes(entry.bareSideEffect) ? entry.bareSideEffect : entry.sideEffect,
    group: entry.group || 'general',
    argv: [entry.name],
    argvTokens,
    prompts,
    refinements,
  };
  return withProductCopy(row, entry, { surface });
}

/** A verb declared on the entry itself — a bare subcommand word on argv
 * (`knowledge promote` → `['knowledge','promote']`), followed by the value
 * slots for the positionals that verb consumes (`learning confirm <id>`). */
function declaredVerbRow(entry, declared, { surface = 'cli' } = {}) {
  const argvTokens = [
    { kind: 'command', value: entry.name },
    { kind: 'subcommand', value: declared.verb },
    ...positionalTokensForVerb(entry, declared),
  ];
  const row = {
    id: `verb:${entry.name}:${declared.verb}`,
    kind: 'verb',
    noun: entry.name,
    verb: declared.verb,
    label: surface === 'tui' ? tuiLabel(entry.name, declared.verb) : `${entry.name} ${declared.verb}`,
    summary: declared.summary || entry.summary || '',
    sideEffect: SIDE_EFFECTS.includes(declared.sideEffect) ? declared.sideEffect : entry.sideEffect,
    group: entry.group || 'general',
    argv: argvTokens.filter((t) => t.kind !== 'value').map((t) => t.value),
    argvTokens,
    // Soft defaults: do not force cli-only or defaultable flags into the palette.
    prompts: promptsFor(entry, declared.verb).filter((p) => p.tui !== 'cli-only'),
    refinements: [],
  };
  return withProductCopy(row, entry, { surface, verb: declared.verb });
}

function flagVerbRow(entry, def, under, { surface = 'cli' } = {}) {
  const verb = verbNameForFlag(def);
  const argvTokens = [{ kind: 'command', value: entry.name }];
  if (under) {
    argvTokens.push({ kind: 'subcommand', value: under.verb });
    argvTokens.push(...positionalTokensForVerb(entry, under));
  }
  argvTokens.push({ kind: 'flag', value: def.name });
  const value = valueTokenFor(def);
  if (value) argvTokens.push(value);
  const qualified = under ? `${under.verb} ${verb}` : verb;
  const row = {
    id: under ? `flag:${entry.name}:${under.verb}:${def.name}` : `flag:${entry.name}:${def.name}`,
    kind: 'verb',
    noun: entry.name,
    verb: qualified,
    label: surface === 'tui' ? tuiLabel(entry.name, qualified) : `${entry.name} ${qualified}`,
    summary: def.description || entry.summary || '',
    sideEffect: SIDE_EFFECTS.includes(def.sideEffect)
      ? def.sideEffect
      : under && SIDE_EFFECTS.includes(under.sideEffect)
        ? under.sideEffect
        : entry.sideEffect,
    group: entry.group || 'general',
    argv: argvTokens.filter((t) => t.kind !== 'value').map((t) => t.value),
    argvTokens,
    prompts: promptsForFlagVerb(entry, def, under ? under.verb : null),
    refinements: refinementsFor(entry, def.name),
  };
  return withProductCopy(row, entry, { surface, verb: qualified });
}

function pickerRow(entry) {
  return modalFamilyRow(entry, entry.tuiPicker);
}

/**
 * Family modal row — one palette entry opens a settings/action sheet.
 * Avoids dumping CLI verbs (config set/get/show, checks list/run, …) into `/`.
 */
function modalFamilyRow(entry, picker) {
  const row = {
    id: `command:${entry.name}`,
    kind: 'command',
    noun: entry.name,
    verb: null,
    label: tuiLabel(entry.name),
    summary: entry.summary || '',
    sideEffect: SIDE_EFFECTS.includes(entry.bareSideEffect) ? entry.bareSideEffect : entry.sideEffect,
    group: entry.group || 'general',
    argv: [entry.name],
    argvTokens: [{ kind: 'command', value: entry.name }],
    prompts: [],
    refinements: [],
    picker,
  };
  return withProductCopy(row, entry, { surface: 'tui' });
}

/**
 * Empty-query product order: common intents first, then everything else.
 * Typing still uses rankRows; this only shapes the first glance.
 */
export function orderPaletteRows(rows, { query = '' } = {}) {
  const q = String(query ?? '').trim();
  if (q) return rows;
  const commonRank = new Map(TUI_COMMON_NOUNS.map((n, i) => [n, i]));
  const common = [];
  const more = [];
  for (const row of rows) {
    if (row.session) {
      const sessionRank = commonRank.get(row.noun) ?? commonRank.get(row.session);
      if (sessionRank !== undefined) common.push({ row, rank: sessionRank });
      else more.push(row);
      continue;
    }
    const rank = commonRank.get(row.noun);
    if (rank !== undefined && (row.kind === 'command' || row.picker)) {
      common.push({ row, rank });
    } else {
      more.push(row);
    }
  }
  common.sort((a, b) => a.rank - b.rank || String(a.row.label).localeCompare(String(b.row.label)));
  const out = [];
  if (common.length) {
    out.push({ section: true, label: 'common', note: 'what you usually need', ready: true });
    for (const { row } of common) out.push(row);
  }
  if (more.length) {
    out.push({ section: true, label: 'more', note: 'everything else · type to filter', ready: true });
    out.push(...more);
  }
  return out.length ? out : rows;
}

/**
 * Every row one registry entry contributes.
 *
 * **CLI surface:** parent command + every verb (full machine inventory).
 * **TUI surface:** multi-verb families collapse to one modal entry (Settings,
 * Checks, Runs, …). Explicit `tuiPicker` (model, config) uses a specialized sheet.
 * Single-action commands stay one human-labeled row.
 */
function rowsForEntry(entry, surface) {
  const declaredVerbs = entry.verbs || [];
  // Specialized modals (settings keys, model catalog).
  if (surface === 'tui' && entry.tuiPicker) {
    return [modalFamilyRow(entry, entry.tuiPicker)];
  }
  // Generic action sheet for any multi-verb family (industry pattern).
  if (surface === 'tui' && declaredVerbs.length >= 2 && entry.tuiFold !== false) {
    return [modalFamilyRow(entry, 'verbs')];
  }

  const byVerb = new Map(declaredVerbs.map((v) => [v.verb, v]));
  const verbFlags = flagsOf(entry).filter((def) => isVerbFlag(entry, def));
  const rowFlags = new Set(verbFlags.map((def) => def.name));
  const opts = { surface };
  const rows = [];

  const foldParent = surface === 'tui' && declaredVerbs.length > 0;
  if (!foldParent) {
    rows.push(commandRow(entry, promptsFor(entry, null), orphanRefinementsFor(entry, rowFlags), opts));
  }
  for (const declared of declaredVerbs) rows.push(declaredVerbRow(entry, declared, opts));
  for (const def of verbFlags) {
    const scoped = verbScope(def).map((v) => byVerb.get(v)).filter(Boolean);
    if (!scoped.length) rows.push(flagVerbRow(entry, def, null, opts));
    else for (const under of scoped) rows.push(flagVerbRow(entry, def, under, opts));
  }
  return rows;
}

function entryOnSurface(entry, surface) {
  const surfaces = Array.isArray(entry.surfaces) && entry.surfaces.length ? entry.surfaces : SURFACES;
  if (!surfaces.includes(surface)) return false;
    if (surface === 'tui' && entry.userInvocable === false) return false;
  return true;
}

// --- skills ---------------------------------------------------------------

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/**
 * Discover `<workspace>/.github/skills/<name>/SKILL.md`.
 *
 * Degrades to an empty list on ANY filesystem trouble — a missing directory, an
 * unreadable one, a directory with no SKILL.md. This code runs in product repos
 * that have no skills directory at all, where "commands only" is the correct
 * answer, not an error. Nothing here creates a path (read-path invariant), and
 * every candidate is symlink-checked against the workspace the same way
 * lib/index-knowledge.mjs checks docs/solutions.
 *
 * Returns `{found, skills}` — `found` distinguishes "the directory is not
 * there" (a product repo) from "it is there and holds nothing invocable",
 * which the envelope reports as `skillsRoot`.
 */
function readSkills(workspace) {
  const root = assertNoSymlinkAncestors(workspace, SKILLS_DIR);
  if (!root || !fs.existsSync(root)) return { found: false, skills: [] };
  let dirents;
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { found: false, skills: [] };
  }
  const names = dirents
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    // readdir order is filesystem-dependent; sort before anything downstream
    // can observe it, so the index is byte-identical across machines.
    .sort();
  const skills = [];
  for (const dir of names) {
    const rel = `${SKILLS_DIR}/${dir}/SKILL.md`;
    const full = assertNoSymlinkAncestors(workspace, rel);
    if (!full) continue;
    const text = readFileNoFollow(full, { root: workspace });
    if (text === null) continue; // no SKILL.md here (e.g. a shared references dir)
    const fm = parseFrontmatter(text);
    // Absent means invocable: the primitive standard opts OUT explicitly, and
    // a skill missing the field is a normal user-facing skill.
    if (String(fm['user-invocable']).toLowerCase() === 'false') continue;
    skills.push({
      dir,
      name: typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : dir,
      description: typeof fm.description === 'string' ? fm.description.trim() : '',
    });
  }
  return { found: true, skills };
}

/**
 * A skill row. `skill:` is not decoration — it is the qualified form the
 * palette contract reserves so that a command and a skill sharing a name
 * (`consolidate`, `recall`) can both exist in one namespace: the command owns
 * the bare name, the skill is always reached through the prefix. Neither is
 * ever dropped in favor of the other.
 *
 * `argv` is null and `sideEffect` is null deliberately. A skill is a host-run
 * workflow, not a kernel command: it has no harness argv to resolve, and it
 * declares no side-effect class. Asserting `read` or `execute` for it would be
 * a guarantee the harness cannot make.
 */
function skillRow(skill) {
  // A SKILL RESOLVES TO READING IT. The row used to carry `argv: null`, on the
  // correct reasoning that a skill is a workflow for the HOST to run and the
  // harness cannot run it — but a palette row that can only answer "this row
  // resolves to no command" is a dead end, and the palette's contract is that
    const relPath = `${SKILLS_DIR}/${skill.dir}/SKILL.md`;
  return {
    id: `skill:${skill.dir}`,
    kind: 'skill',
    noun: skill.name,
    verb: null,
    label: `skill:${skill.name}`,
    summary: skill.description,
    sideEffect: 'read',
    group: 'skills',
    argv: ['get', '--path', relPath],
    argvTokens: [
      { kind: 'command', value: 'get' },
      { kind: 'flag', value: '--path' },
      { kind: 'literal', value: relPath },
    ],
    prompts: [],
    refinements: [],
  };
}

// --- index ----------------------------------------------------------------

function compareRows(a, b) {
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function buildCommandIndex({ surface = 'tui', workspace = process.cwd() } = {}) {
  if (!SURFACES.includes(surface)) {
    throw new TypeError(`buildCommandIndex: unknown surface ${JSON.stringify(surface)} (expected ${SURFACES.join(' | ')})`);
  }
  const rows = [];
  const commandNames = new Set();
  for (const name of listCommands()) {
    const entry = getCommand(name);
    if (!entry || !entryOnSurface(entry, surface)) continue;
    commandNames.add(entry.name);
    rows.push(...rowsForEntry(entry, surface));
  }

  let skillsRoot = null;
  const collisions = [];
  if (surface === 'tui') {
    const { found, skills } = readSkills(workspace);
    if (found) skillsRoot = SKILLS_DIR;
    for (const skill of skills) {
      rows.push(skillRow(skill));
      if (commandNames.has(skill.name)) collisions.push(skill.name);
    }
  }

  rows.sort(compareRows);
  collisions.sort();
  return { surface, skillsRoot, rows, collisions };
}

export function resolveArgv(row, values = {}) {
  if (!row || !Array.isArray(row.argvTokens) || row.argvTokens.length === 0) return null;
  const argv = [];
  for (const token of row.argvTokens) {
    if (token.kind !== 'value') {
      argv.push(token.value);
      continue;
    }
    const value = values[token.flag ?? token.positional];
    if (value === undefined || value === null) continue;
    argv.push(String(value));
  }
  for (const option of [...(row.prompts || []), ...(row.refinements || [])]) {
    const value = values[option.flag];
    if (value === undefined || value === null) continue;
    if (option.type === 'boolean') {
      if (value) argv.push(option.flag);
      continue;
    }
    argv.push(option.flag, String(value));
  }
  return argv;
}

export function commandIndexEnvelope({ surface = 'tui', workspace = process.cwd() } = {}) {
  const index = buildCommandIndex({ surface, workspace });
  const counts = { command: 0, verb: 0, skill: 0 };
  for (const row of index.rows) counts[row.kind] += 1;
  return createEnvelope({
    command: 'palette',
    status: STATUS.OK,
    surface: index.surface,
    count: index.rows.length,
    commands: counts.command,
    verbs: counts.verb,
    skills: counts.skill,
    skillsRoot: index.skillsRoot,
    collisions: index.collisions,
    rows: index.rows,
  });
}
