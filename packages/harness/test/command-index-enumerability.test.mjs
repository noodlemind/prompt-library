/**
 * AC8 — enumerability. Every verb reachable on the CLI must be enumerable
 * from the registry AS DATA. No capability may exist only inside a `usage:`
 * string.
 *
 * `describeCommand().usage` is either auto-generated from `args` (safe by
 * construction) or a hand-written override (lib/registry.mjs's escape hatch
 * for `index`, `report`, `knowledge`, `consolidate`, `learning`). The override
 * is the whole risk: it is prose, so a new subcommand can be documented there
 * and never declared — which is exactly how pi's command table drifted from
 * its dispatcher. `auditUsage` below re-derives every capability a usage line
 * names and requires each one to resolve against declared data.
 *
 * The audit is a pure function on `(entry, usage)` precisely so it can be
 * exercised against a SYNTHETIC entry carrying a prose-only verb — see "the
 * audit fires on every class of undeclared capability". Without that, a test
 * asserting "zero violations" could pass because the parser matches nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLOBAL_FLAGS, describeCommand, getCommand, listCommands } from '../lib/registry.mjs';
import { buildCommandIndex } from '../lib/command-index.mjs';

/**
 * Alternatives a usage line may name that are legitimately NOT verbs, flags,
 * positional names, or flag value-name enums. Each needs a stated reason —
 * an allow-list entry is a documented exception, not a silencer. Keyed
 * `<command>:<alternative>`; a stale key fails its own test below.
 */
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

/**
 * Every capability `usage` names that does not resolve to registry data.
 * Returns `[{token, kind}]` — `kind` is `alternative` (inside an `<a|b>`
 * group), `bare` (a top-level subcommand word), or `flag` (a `--x` the entry
 * does not declare). `usedAllowKeys` collects the allow-list keys this call
 * consumed so the caller can detect stale exceptions.
 */
function auditUsage(entry, usage, usedAllowKeys = new Set()) {
  const { flags, valueNames, verbs, positionals } = declaredNames(entry);
  const violations = [];

  // Everything after a bare `--` is passthrough: the harness hands those tokens
  // to a child process and never parses them (`exec -- <program> [args...]`).
  // They are the CHILD's capability, not this entry's, so requiring them to
  // resolve against registry data would demand the harness declare arguments it
  // deliberately does not understand — and declaring them would be worse than
  // the prose, because the palette would then offer pickers for them.
  //
  // A general rule rather than a per-command allow-list entry: it holds for any
  // passthrough command, and it states the actual semantic instead of excusing
  // five tokens by name.
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
    // The whole group is one flag's value name — `--risk <green|amber|red>`
    // is that flag's enum, never three verbs (lib/registry.mjs says so on
    // plan-new explicitly).
    if (valueNames.has(inner)) continue;
    for (const alt of inner.split('|').map((s) => s.trim()).filter(Boolean)) {
      if (verbs.has(alt) || flags.has(alt) || positionals.has(alt) || valueNames.has(alt)) continue;
      if (allowed(alt)) continue;
      violations.push({ token: alt, kind: 'alternative' });
    }
  }

  // Bare words left once the groups are removed: knowledge's top-level
  // `purge | commit | migrate-store` alternation, and buildUsage's optional
  // positionals (`[query]`).
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
  resources: ['list', 'show', 'register', 'unregister'],
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
  // `list` takes no name — it is the query over all of them.
  resources: { show: ['path'], register: ['path'], unregister: ['path'] },
});

test('AC8: every verb-consumed positional is declared and reaches its row as a picker', () => {
  const actual = {};
  for (const name of listCommands()) {
    const consuming = {};
    for (const v of getCommand(name).verbs || []) if (v.positionals?.length) consuming[v.verb] = [...v.positionals];
    if (Object.keys(consuming).length) actual[name] = consuming;
  }
  assert.deepEqual(actual, { ...VERB_POSITIONALS }, 'a verb argument was added or lost — update the fixture deliberately');

  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [command, verbs] of Object.entries(VERB_POSITIONALS)) {
    for (const [verb, names] of Object.entries(verbs)) {
      const row = byId.get(`verb:${command}:${verb}`);
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
  assert.equal(Object.values(actual).flat().length, 46, '15 knowledge/learning verbs + lookup’s 11 kinds + tree’s 2 subjects + checks’ 3 verbs + config’s 4 verbs + trust’s 3 verbs + run’s 4 verbs + resources’ 4 verbs');
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
  for (const [command, verbs] of Object.entries(DECLARED_VERBS)) {
    for (const verb of verbs) {
      const row = byId.get(`verb:${command}:${verb}`);
      assert.ok(row, `${command} ${verb} must be a palette row`);
      assert.equal(row.kind, 'verb');
      assert.deepEqual(row.argv, [command, verb]);
      assert.ok(row.summary, `${command} ${verb} must carry its declared summary`);
    }
  }
  assert.equal(rows.filter((r) => r.kind === 'verb').length, 59, '46 declared verbs + 13 row-bearing verb flags');
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
