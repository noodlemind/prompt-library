import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLOBAL_FLAGS, describeCommand, getCommand, listCommands } from '../lib/registry.mjs';
import { buildCommandIndex } from '../lib/command-index.mjs';

const USAGE_ALLOW_LIST = Object.freeze({
  'knowledge:file':
    'the argument to `purge <file>` — an episode file path supplied through the `target` positional, not a subcommand of its own',
  'knowledge:none':
    'a value of `commit <none|repo>` — the commit mode carried by the `target` positional, not a subcommand',
  'knowledge:repo':
    'a value of `commit <none|repo>` — the commit mode carried by the `target` positional, not a subcommand',
});

function declaredNames(entry) {
  const flags = new Set();
  for (const def of [...GLOBAL_FLAGS, ...(entry.args?.flags || [])]) {
    flags.add(def.name);
    for (const alias of def.aliases || []) flags.add(alias);
  }
  const valueNames = new Set();
  for (const def of entry.args?.flags || []) if (def.valueName) valueNames.add(def.valueName);
  return {
    flags,
    valueNames,
    verbs: new Set((entry.verbs || []).map((v) => v.verb)),
    positionals: new Set((entry.args?.positionals || []).map((p) => p.name)),
  };
}

function auditUsage(entry, usage, usedAllowKeys = new Set()) {
  const { flags, valueNames, verbs, positionals } = declaredNames(entry);
  const violations = [];

    const boundary = usage.search(/(^|\s)--(\s|$)/);
  if (boundary !== -1) usage = usage.slice(0, boundary);

  const allowed = (token) => {
    const key = `${entry.name}:${token}`;
    if (!(key in USAGE_ALLOW_LIST)) return false;
    usedAllowKeys.add(key);
    return true;
  };

  // Angle-bracket groups: `<on|suggest|off>`, `<file|--all>`, `<ref>`.
  for (const [, inner] of usage.matchAll(/<([^<>]*)>/g)) {
        if (valueNames.has(inner)) continue;
    for (const alt of inner.split('|').map((s) => s.trim()).filter(Boolean)) {
      if (verbs.has(alt) || flags.has(alt) || positionals.has(alt) || valueNames.has(alt)) continue;
      if (allowed(alt)) continue;
      violations.push({ token: alt, kind: 'alternative' });
    }
  }

    const bare = usage.replace(/<[^<>]*>/g, ' ').split(/[\s|[\]"]+/).filter(Boolean);
  for (const token of bare) {
    if (token.startsWith('-')) {
      if (!flags.has(token)) violations.push({ token, kind: 'flag' });
      continue;
    }
    if (verbs.has(token) || positionals.has(token)) continue;
    if (allowed(token)) continue;
    violations.push({ token, kind: 'bare' });
  }
  return violations;
}

// --- AC8: no capability lives only in prose ------------------------------

test('AC8: every capability a usage line names is declared registry data', () => {
  const used = new Set();
  const offenders = [];
  for (const name of listCommands()) {
    const entry = getCommand(name);
    const { usage } = describeCommand(name);
    for (const v of auditUsage(entry, usage, used)) {
      offenders.push(`${name}: ${v.kind} "${v.token}" appears in usage ${JSON.stringify(usage)} but is not a declared verb, flag, positional, or value enum`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a capability documented in a usage string must also be declared as data — add it to `verbs`/`args.flags`, or allow-list it with a reason'
  );
  // Non-vacuity: the override usage lines really were parsed. `knowledge`
  // alone contributes eleven verbs plus `--status`/`--all`, so a parser that
  // silently matched nothing could not have consumed the allow-list.
  assert.ok(used.size > 0, 'the audit must actually have inspected the hand-written usage overrides');
});

test('AC8: the usage allow-list carries no stale exceptions', () => {
  const used = new Set();
  for (const name of listCommands()) auditUsage(getCommand(name), describeCommand(name).usage, used);
  assert.deepEqual(
    [...used].sort(),
    Object.keys(USAGE_ALLOW_LIST).sort(),
    'an allow-list entry whose usage text no longer exists must be deleted, not left to excuse a future token'
  );
});

test('AC8: the audit fires on every class of undeclared capability', () => {
  // A prose-only verb (`rollback`), a prose-only subcommand (`teleport`), an
  // undeclared flag (`--warp`), and an undeclared value name (`speed`). This
  // is the test that makes the sweep above non-vacuous: if `auditUsage` ever
  // stops parsing, this fails first and names which class it stopped seeing.
  const drifted = {
    name: 'probe',
    verbs: [{ verb: 'on', summary: 'declared' }],
    args: { flags: [], positionals: [] },
  };
  const found = auditUsage(drifted, '<on|rollback> | teleport [--warp <speed>]');
  assert.deepEqual(
    found.map((v) => `${v.kind}:${v.token}`).sort(),
    ['alternative:rollback', 'alternative:speed', 'bare:teleport', 'flag:--warp'].sort()
  );
});

test('AC8: the audit does not flag a fully declared usage line', () => {
  const clean = {
    name: 'probe',
    verbs: [{ verb: 'on', summary: 'declared' }],
    args: {
      flags: [
        { name: '--warp', type: 'string', valueName: 'speed' },
        { name: '--risk', type: 'string', valueName: 'green|amber|red' },
      ],
      positionals: [{ name: 'target' }],
    },
  };
  assert.deepEqual(auditUsage(clean, '<on> [target] [--warp <speed>] [--risk <green|amber|red>] [--json]'), []);
});

// --- AC8: the verb inventory is pinned -----------------------------------

// Silent LOSS is the other half of enumerability: a verb quietly deleted (or
// a `tui: 'verb'` disposition quietly downgraded) removes a capability from
// the palette without any usage line changing. These fixtures are the pin.
const DECLARED_VERBS = Object.freeze({
  knowledge: ['on', 'suggest', 'off', 'freeze', 'capture-only', 'status', 'promote', 'prune', 'purge', 'commit', 'migrate-store'],
  learning: ['retire', 'dispute', 'confirm', 'promote'],
  // `lookup`'s eleven entity kinds are verbs rather than a free-text
  // positional. As free text the palette filled the slot with any word and
  // dispatch then refused the row; as verbs each kind is a completable row
  // carrying the identifier slot its form cannot run without.
  lookup: ['file', 'symbol', 'document', 'plan', 'skill', 'check', 'run', 'event', 'resource', 'learning', 'episode'],
  // Same reasoning as lookup's kinds: a free-text subject positional is a slot
  // the palette fills with anything, producing a row the command refuses.
  tree: ['workspace', 'knowledge'],
  // `run` executes a repo-authored argv; `list`/`show` override DOWN to read,
  // so the palette warns about the verb that actually executes.
  checks: ['list', 'show', 'run'],
  // `set` writes a file; the three read verbs override DOWN, so the palette
  // warns about the one verb that mutates.
  config: ['show', 'get', 'set', 'validate'],
  // `approve`/`revoke` grant or withdraw a project's authority; `status` reads.
  trust: ['status', 'approve', 'revoke'],
  // Every run verb reads. `resume` REPORTS whether resuming is safe rather than
  // performing it, so the palette must not paint it as an action.
  run: ['list', 'show', 'tree', 'resume'],
  // `register`/`unregister` change what the harness recognizes; `list`/`show`
  // override DOWN to read.
  model: ['show', 'set', 'clear', 'refresh'],
  resources: ['list', 'show', 'register', 'unregister', 'bundles', 'add', 'update', 'remove'],
});

const VERB_FLAGS = Object.freeze({
  compound: ['--insight'],
  consolidate: ['--candidates', '--apply', '--rebuild'],
  events: ['--summary', '--failures'],
  index: ['--status', '--structural'],
  knowledge: ['--merged'],
  learnings: ['--why'],
  orient: ['--explain'],
  report: ['--sync', '--global'],
});

/**
 * The other half of the same enumerability story. `knowledge commit
 * <none|repo>` and `learning confirm <id>` name their argument in a usage
 * line, which is prose; only `positionals` on the verb makes it data the
 * palette can open a picker for. Dropping one silently leaves a row no answer
 * can complete — a capability that is listed but unreachable, which is the
 * same failure mode as a verb that never reached the index at all.
 */
const VERB_POSITIONALS = Object.freeze({
  knowledge: { purge: ['target'], commit: ['target'] },
  learning: { retire: ['id'], dispute: ['id'], confirm: ['id'], promote: ['id'] },
  // Every lookup kind names exactly one entity, so all eleven consume the
  // identifier slot — a kind row without it is a row no answer can complete.
  lookup: {
    file: ['identifier'],
    symbol: ['identifier'],
    document: ['identifier'],
    plan: ['identifier'],
    skill: ['identifier'],
    check: ['identifier'],
    run: ['identifier'],
    event: ['identifier'],
    resource: ['identifier'],
    learning: ['identifier'],
    episode: ['identifier'],
  },
  checks: { show: ['name'], run: ['name'] },
  // `show` and `validate` take no argument — they report on the whole key
  // space, so a picker on them would be asking for something they ignore.
  config: { get: ['key'], set: ['key', 'value'] },
  // `list` takes no id — it is the query over all of them.
  run: { show: ['run-id'], tree: ['run-id'], resume: ['run-id'] },
  // `set` names the provider it is switching to, and optionally the model;
  // `show` and `clear` take neither — one reports on every provider, the
  // other forgets the choice.
  model: { set: ['provider', 'model'], refresh: ['provider'] },
  // `list` takes no name — it is the query over all of them.
  resources: { show: ['path'], register: ['path'], unregister: ['path'], add: ['path'], update: ['path'], remove: ['path'] },
});

test('AC8: every verb-consumed positional is declared and reaches its row as a picker', () => {
  const actual = {};
  for (const name of listCommands()) {
    const consuming = {};
    for (const v of getCommand(name).verbs || []) if (v.positionals?.length) consuming[v.verb] = [...v.positionals];
    if (Object.keys(consuming).length) actual[name] = consuming;
  }
  assert.deepEqual(actual, { ...VERB_POSITIONALS }, 'a verb argument was added or lost — update the fixture deliberately');

  // A picker command's verbs live on the CLI surface — in the TUI it is one row
  // that opens a chooser (see `pickerRow`), so its positionals are answered by
  // the picker rather than by a per-verb row. The CLI index still carries them,
  // which is what this assertion reads.
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const cli = buildCommandIndex({ surface: 'cli', workspace: process.cwd() }).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cliById = new Map(cli.map((r) => [r.id, r]));
  for (const [command, verbs] of Object.entries(VERB_POSITIONALS)) {
    const picker = Boolean(getCommand(command)?.tuiPicker);
    for (const [verb, names] of Object.entries(verbs)) {
      const row = (picker ? cliById : byId).get(`verb:${command}:${verb}`);
      assert.deepEqual(
        row.argvTokens.filter((t) => t.kind === 'value').map((t) => t.positional),
        names,
        `${command} ${verb} must offer a picker for each positional it consumes, in argv order`,
      );
    }
  }
});

test('AC8: the declared verb inventory matches its fixture exactly', () => {
  const actual = {};
  for (const name of listCommands()) {
    const verbs = (getCommand(name).verbs || []).map((v) => v.verb);
    if (verbs.length) actual[name] = verbs;
  }
  assert.deepEqual(actual, { ...DECLARED_VERBS }, 'a verb was added or lost — update the fixture deliberately');
  assert.equal(Object.values(actual).flat().length, 54, '15 knowledge/learning verbs + lookup’s 11 kinds + tree’s 2 subjects + checks’ 3 verbs + config’s 4 verbs + trust’s 3 verbs + run’s 4 verbs + resources’ 8 verbs + model’s 4 verbs');
});

test('AC8: the verb-dispositioned flag inventory matches its fixture exactly', () => {
  const actual = {};
  for (const name of listCommands()) {
    const flags = (getCommand(name).args.flags || []).filter((f) => f.tui === 'verb').map((f) => f.name);
    if (flags.length) actual[name] = flags;
  }
  assert.deepEqual(actual, { ...VERB_FLAGS }, 'a tui:"verb" disposition was added or lost — update the fixture deliberately');
  assert.equal(Object.values(actual).flat().length, 13);
});

// --- AC8: the index actually carries every enumerated verb ---------------

test('AC8: every declared verb reaches the palette as its own row', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const byId = new Map(rows.map((r) => [r.id, r]));
  // A PICKER COMMAND IS THE ONE EXCEPTION, and it is an exception to the
  // RENDERING, not to the reachability this test exists to protect: `model`
  // presents in the TUI as a single row that opens a chooser, where show is what
  // it does on open, set is what choosing does and clear is a row inside it.
  // Every verb is still reachable — through the picker here, and unchanged on
  // the CLI surface, which the assertion below pins.
  const pickers = new Set(
    Object.keys(DECLARED_VERBS).filter((name) => getCommand(name)?.tuiPicker),
  );
  assert.deepEqual([...pickers], ['model'], 'a command became a picker — decide deliberately whether its verbs should leave the palette');
  const cliRows = buildCommandIndex({ surface: 'cli', workspace: process.cwd() }).rows;
  for (const name of pickers) {
    for (const verb of DECLARED_VERBS[name]) {
      assert.ok(cliRows.some((r) => r.id === `verb:${name}:${verb}`), `${name} ${verb} must survive on the CLI surface`);
    }
  }

  for (const [command, verbs] of Object.entries(DECLARED_VERBS)) {
    if (pickers.has(command)) continue;
    for (const verb of verbs) {
      const row = byId.get(`verb:${command}:${verb}`);
      assert.ok(row, `${command} ${verb} must be a palette row`);
      assert.equal(row.kind, 'verb');
      assert.deepEqual(row.argv, [command, verb]);
      assert.ok(row.summary, `${command} ${verb} must carry its declared summary`);
    }
  }
  // 66 minus `model`'s three, which the picker row now stands for.
  assert.equal(rows.filter((r) => r.kind === 'verb').length, 63, '50 palette-visible declared verbs + 13 row-bearing verb flags');
  assert.equal(cliRows.filter((r) => r.kind === 'verb').length, 67, 'the CLI surface keeps every verb');
});

/**
 * Every `tui: 'verb'` flag owns a palette row unless it refines another verb
 * flag. `requires` alone does not demote one — the direction decides
 * (lib/command-index.mjs#dependsOnVerbFlag):
 *
 * - `--since requires --structural` points UP at another verb flag, so `since`
 *   is a refinement of the `index structural` row and correctly has none.
 * - `--apply requires --ops` points DOWN at its own `tui: 'prompt'` parameter.
 *   `apply` IS the capability; `--ops` is the value the palette asks for once
 *   the row is chosen.
 *
 * An earlier implementation treated both alike and dropped `consolidate apply`
 * out of the index entirely, leaving it findable only by knowing to look under
 * `consolidate` — a direct violation of the contract's "reaching a capability
 * never requires knowing its parent". `rowless` must stay empty; anything in
 * it is a declared capability that has lost its own name.
 */
test('AC8: every verb-dispositioned flag owns a row or refines a verb row', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const rowless = [];
  for (const [command, flagNames] of Object.entries(VERB_FLAGS)) {
    const owned = rows.filter((r) => r.noun === command);
    for (const flag of flagNames) {
      const asRow = owned.some((r) => r.argv?.includes(flag));
      const refinesAVerbRow = owned.some(
        (r) => r.kind === 'verb' && r.refinements.some((o) => o.flag === flag),
      );
      assert.ok(asRow || refinesAVerbRow, `${command} ${flag} must stay reachable from the index`);
      if (!asRow && !refinesAVerbRow) rowless.push(`${command} ${flag}`);
    }
  }
  assert.deepEqual(rowless, [], 'every tui:"verb" flag must own a row or refine a verb row');
});
