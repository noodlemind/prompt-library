/**
 * Command index — the flat, searchable index the TUI command palette renders
 * (docs/architecture/harness-cli-workbench.md §"Command palette").
 *
 * The palette is an index OVER the registry, never a second command grammar:
 * this module reads lib/registry.mjs's entries and projects them into rows,
 * and the CLI grammar is untouched. Three properties of that contract drive
 * every decision below.
 *
 * 1. ONE FLAT NAMESPACE. A command, each of its verbs, and each user-invocable
 *    skill are sibling rows. Reaching a capability never requires knowing its
 *    parent — `structural` is findable without knowing it lives under `index`.
 *    That is why this is a flat array and not a tree keyed by command.
 *
 * 2. NO `--` IS EVER TYPED. The index carries options so a capability can be
 *    *found*; it must never require one to be *written*. Hence `argvTokens`:
 *    every row states, as data, the argv the CLI already accepts. The palette
 *    resolves a row by walking those tokens (`resolveArgv`), never by parsing
 *    its own label back into flags — a label is a display string, and
 *    reconstructing argv from it at render time would put the palette's
 *    formatting in the dispatch path.
 *
 * 3. ANNOTATION IS OPTIONAL, NOT ASSUMED. `verbs`, `surfaces`, `userInvocable`
 *    and the per-flag `tui`/`requires`/`verbs` metadata are being populated
 *    entry by entry. Every read here is defensive (`entry.verbs || []`), and
 *    an un-annotated command still yields a row — the registry's own default
 *    is "discoverable", and forgetting to annotate must never silently remove
 *    a capability from the palette.
 *
 * Purity: same registry + same skills directory ⇒ byte-identical index. No
 * model call, no network, and — per the harness read-path invariant — no
 * directory or file is ever created. Filesystem enumeration order is never
 * trusted; skill directories are sorted explicitly before any row is built.
 */
import fs from 'node:fs';
import { listCommands, getCommand, SURFACES } from './registry.mjs';
import { createEnvelope, STATUS } from './envelope.mjs';
import { assertNoSymlinkAncestors, readFileNoFollow } from './fs-safe.mjs';

/** What a row represents. Verb rows come from two structurally different
 * sources (a declared subcommand and a `tui: 'verb'` flag) but present
 * identically to the palette, so both carry `kind: 'verb'`. */
export const ROW_KINDS = Object.freeze(['command', 'verb', 'skill']);

/**
 * The token kinds an `argvTokens` template is built from. `command` and
 * `subcommand` are bare argv words, `flag` is a literal flag token, and
 * `value` is the one slot filled in later from a picker (never typed) — see
 * the palette contract's "Values come from pickers".
 */
export const TOKEN_KINDS = Object.freeze(['command', 'subcommand', 'flag', 'value']);

/** Where skills are discovered, relative to the workspace root. Reported as a
 * relative posix path so the envelope stays machine-independent. */
export const SKILLS_DIR = '.github/skills';

const SIDE_EFFECTS = ['read', 'mutate', 'execute'];

/** `registerCommand` always normalizes `args`, but every accessor here goes
 * through this one helper anyway — a half-annotated registry is the expected
 * state, and one tolerant reader is cheaper than auditing each call site. */
function flagsOf(entry) {
  return entry.args?.flags || [];
}

function requiresList(def) {
  return Array.isArray(def.requires) ? def.requires : [];
}

function verbScope(def) {
  return Array.isArray(def.verbs) ? def.verbs : [];
}

/** A flag is its own palette row only when it is dispositioned `verb` AND
 * stands alone. A dependent option is a refinement of the option it requires
 * ("never listed independently"), so `requires` disqualifies it from being a
 * row even if it was also annotated `verb`. */
function isVerbFlag(def) {
  return def.tui === 'verb' && requiresList(def).length === 0;
}

/** Prompt flags are asked for after selection; a dependent one is a
 * refinement instead, so it is likewise excluded here. */
function isPromptFlag(def) {
  return def.tui === 'prompt' && requiresList(def).length === 0;
}

/** `--structural` presents as the verb `structural`. This derives the DISPLAY
 * name from the flag; the reverse direction never happens — the row keeps the
 * real `--structural` token in `argvTokens`, so dispatch never depends on this
 * transformation being invertible. */
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
  };
}

/** The palette-facing projection of one option: enough to open a picker and
 * label it, without leaking the whole registry flag definition. */
function optionRow(def) {
  const row = {
    flag: def.name,
    type: def.type || 'string',
    valueName: def.type === 'boolean' ? null : def.valueName || 'value',
    required: Boolean(def.required),
    description: def.description || '',
  };
  const requires = requiresList(def);
  if (requires.length) row.requires = [...requires];
  return row;
}

/**
 * Prompt options that apply to one row. `verb` is the DECLARED subcommand this
 * row selects, or null for a bare command row and for a flag-derived verb row
 * (neither puts a bare verb token on argv, so verb-scoped flags cannot apply).
 * The applicability rule deliberately mirrors `validateArgs`'s own scoping
 * check in lib/registry.mjs — the palette must never offer a combination the
 * parser would then reject.
 */
function promptsFor(entry, verb) {
  return flagsOf(entry)
    .filter((def) => {
      if (!isPromptFlag(def)) return false;
      const scope = verbScope(def);
      return scope.length === 0 || (verb !== null && scope.includes(verb));
    })
    .map(optionRow);
}

/** Refinements of one row: the dependent options whose `requires` names this
 * row's own flag. This is what keeps `--since` off the top level — it attaches
 * to `index structural` and is offered only after that row is chosen. */
function refinementsFor(entry, ownFlag) {
  if (!ownFlag) return [];
  return flagsOf(entry)
    .filter((def) => def.tui !== 'cli-only' && requiresList(def).includes(ownFlag))
    .map(optionRow);
}

/**
 * Dependent options whose required flag produced no row at all (it was
 * `cli-only`, or its own `requires` disqualified it). They have no parent to
 * attach to, so they land on the bare command row rather than disappearing —
 * a capability that exists must stay reachable, which is the same reason the
 * registry defaults an un-annotated command to visible.
 */
function orphanRefinementsFor(entry, rowFlags) {
  return flagsOf(entry)
    .filter((def) => {
      if (def.tui === 'cli-only') return false;
      const requires = requiresList(def);
      if (requires.length === 0) return false;
      return requires.every((req) => !rowFlags.has(req));
    })
    .map(optionRow);
}

function commandRow(entry, prompts, refinements) {
  return {
    id: `command:${entry.name}`,
    kind: 'command',
    noun: entry.name,
    verb: null,
    label: entry.name,
    summary: entry.summary || '',
    sideEffect: entry.sideEffect,
    group: entry.group || 'general',
    argv: [entry.name],
    argvTokens: [{ kind: 'command', value: entry.name }],
    prompts,
    refinements,
  };
}

/** A verb declared on the entry itself — a bare subcommand word on argv
 * (`knowledge promote` → `['knowledge','promote']`). */
function declaredVerbRow(entry, declared) {
  const argvTokens = [
    { kind: 'command', value: entry.name },
    { kind: 'subcommand', value: declared.verb },
  ];
  return {
    id: `verb:${entry.name}:${declared.verb}`,
    kind: 'verb',
    noun: entry.name,
    verb: declared.verb,
    label: `${entry.name} ${declared.verb}`,
    summary: declared.summary || entry.summary || '',
    // Verb-level side effect wins: `knowledge status` reads where the command
    // family as a whole mutates, and the palette shows the consequence of the
    // row the user actually selected.
    sideEffect: SIDE_EFFECTS.includes(declared.sideEffect) ? declared.sideEffect : entry.sideEffect,
    group: entry.group || 'general',
    argv: argvTokens.map((t) => t.value),
    argvTokens,
    prompts: promptsFor(entry, declared.verb),
    refinements: [],
  };
}

/**
 * A verb backed by a flag (`index structural` → `['index','--structural']`).
 * A value-taking flag (`learnings why`) keeps its value slot in `argvTokens`
 * so the palette knows to open a picker before dispatching.
 *
 * `under` is the declared verb the flag is scoped to, or null when it applies
 * to the bare command. A scoped flag carries its subcommand token — `--merged`
 * is declared `verbs: ['prune']`, so its row is `knowledge prune merged` →
 * `['knowledge','prune','--merged']`. Emitting `['knowledge','--merged']`
 * instead would dispatch a combination the command ignores: the palette must
 * never offer a row whose argv does not do what the row says it does, and the
 * flat namespace still keeps `merged` findable without knowing its parent.
 */
function flagVerbRow(entry, def, under) {
  const verb = verbNameForFlag(def);
  const argvTokens = [{ kind: 'command', value: entry.name }];
  if (under) argvTokens.push({ kind: 'subcommand', value: under.verb });
  argvTokens.push({ kind: 'flag', value: def.name });
  const value = valueTokenFor(def);
  if (value) argvTokens.push(value);
  const qualified = under ? `${under.verb} ${verb}` : verb;
  return {
    id: under ? `flag:${entry.name}:${under.verb}:${def.name}` : `flag:${entry.name}:${def.name}`,
    kind: 'verb',
    noun: entry.name,
    verb: qualified,
    label: `${entry.name} ${qualified}`,
    summary: def.description || entry.summary || '',
    sideEffect: under && SIDE_EFFECTS.includes(under.sideEffect) ? under.sideEffect : entry.sideEffect,
    group: entry.group || 'general',
    // The template: literal tokens only. A value slot is filled in later, so
    // `learnings why` is `['learnings','--why']` here, exactly as documented.
    argv: argvTokens.filter((t) => t.kind !== 'value').map((t) => t.value),
    argvTokens,
    prompts: promptsFor(entry, under ? under.verb : null),
    refinements: refinementsFor(entry, def.name),
  };
}

/** Every row one registry entry contributes: itself, its declared verbs, and
 * its `tui: 'verb'` flags (one row per verb a scoped flag applies to). */
function rowsForEntry(entry) {
  const declaredVerbs = entry.verbs || [];
  const byVerb = new Map(declaredVerbs.map((v) => [v.verb, v]));
  const verbFlags = flagsOf(entry).filter(isVerbFlag);
  const rowFlags = new Set(verbFlags.map((def) => def.name));
  const rows = [commandRow(entry, promptsFor(entry, null), orphanRefinementsFor(entry, rowFlags))];
  for (const declared of declaredVerbs) rows.push(declaredVerbRow(entry, declared));
  for (const def of verbFlags) {
    // `assertValidFlagMetadata` already rejects a scope naming an undeclared
    // verb, so `scoped` is normally the full list; the filter is only a guard
    // against a half-written entry, and an empty result falls back to the
    // unscoped row rather than dropping the capability.
    const scoped = verbScope(def).map((v) => byVerb.get(v)).filter(Boolean);
    if (!scoped.length) rows.push(flagVerbRow(entry, def, null));
    else for (const under of scoped) rows.push(flagVerbRow(entry, def, under));
  }
  return rows;
}

function entryOnSurface(entry, surface) {
  const surfaces = Array.isArray(entry.surfaces) && entry.surfaces.length ? entry.surfaces : SURFACES;
  if (!surfaces.includes(surface)) return false;
  // `userInvocable: false` marks a command the harness calls on the user's
  // behalf. It is filtered from the palette only — the CLI and agent lanes
  // still dispatch it, so hiding it there would break its actual callers.
  if (surface === 'tui' && entry.userInvocable === false) return false;
  return true;
}

// --- skills ---------------------------------------------------------------

/** Same minimal frontmatter reader lib/index-knowledge.mjs uses: one flat
 * `key: value` per line, quotes stripped. A skill's frontmatter is authored to
 * that shape by the primitive standard, and a real YAML parser is not a
 * dependency this package carries. */
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
  return {
    id: `skill:${skill.dir}`,
    kind: 'skill',
    noun: skill.name,
    verb: null,
    label: `skill:${skill.name}`,
    summary: skill.description,
    sideEffect: null,
    group: 'skills',
    argv: null,
    argvTokens: [],
    prompts: [],
    refinements: [],
  };
}

// --- index ----------------------------------------------------------------

/** Total, deterministic ordering. Plain codepoint comparison, never
 * `localeCompare` — collation must not vary with the host's locale. Sorting by
 * label groups a command with its own verbs for free (`index` < `index status`
 * < `index structural`); the unique `id` breaks every remaining tie. */
function compareRows(a, b) {
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Build the palette index for one surface.
 *
 * `surface` defaults to `'tui'` — the palette is the surface with neither
 * `--help` nor shell completion, and the only one this index exists for.
 * `'cli'` and `'agent'` project the same registry rows for tooling that wants
 * the surface membership, but carry no skills: a skill is dispatched by the
 * host, and there is nothing for a shell or the agent lane to invoke.
 *
 * Returns `{surface, skillsRoot, rows, collisions}`:
 *   - `rows`      — the flat index, sorted (see `compareRows`).
 *   - `skillsRoot`— the relative skills path when it was found, else null, so
 *                   a consumer can distinguish "no skills" from "not scanned".
 *   - `collisions`— names owned by BOTH a command and a skill. Surfaced rather
 *                   than resolved: both rows are always present, and this makes
 *                   the overlap auditable instead of implicit.
 */
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
    rows.push(...rowsForEntry(entry));
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

/**
 * Resolve one row into the argv the CLI already accepts.
 *
 * `values` maps a flag name to the value chosen from a picker; anything absent
 * is simply left out, so `resolveArgv(row)` returns the row's own template
 * (`['learnings','--why']`) and `resolveArgv(row, {'--why': 'L-7'})` returns
 * the complete invocation. Boolean options are emitted as a bare flag when
 * their value is truthy and omitted otherwise.
 *
 * This is the one place a row becomes argv. Prompts and refinements are
 * appended in registry declaration order so a given `{row, values}` pair always
 * produces the identical argv — the resolved form is echoed into the ledger
 * after the run, and an unstable ordering would make that audit trail noise.
 * Returns null for a row with no argv at all (a skill).
 */
export function resolveArgv(row, values = {}) {
  if (!row || !Array.isArray(row.argvTokens) || row.argvTokens.length === 0) return null;
  const argv = [];
  for (const token of row.argvTokens) {
    if (token.kind !== 'value') {
      argv.push(token.value);
      continue;
    }
    const value = values[token.flag];
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

/**
 * The index as a versioned envelope — the "programs / TUI" lane from the
 * output-lanes contract, and the only lane the palette has. Summary scalars
 * first (`createEnvelope` enforces the ordering), detail arrays after, so one
 * payload serves both a status line and the full palette.
 *
 * Emitting through the envelope is what makes the index consumable and
 * testable without a terminal: the TUI reads it in-process, and a test asserts
 * on it without rendering a single styled row.
 */
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
