/**
 * The command palette's contract properties (docs/architecture/
 * harness-cli-workbench.md §"Command palette"), as distinct from the three
 * numbered ACs:
 *
 *   - Determinism      — same registry + same skills ⇒ byte-identical index.
 *   - No `--` in labels — "No `--` is ever typed in the TUI".
 *   - argv round-trip  — every row's argv must be something `dispatch` accepts.
 *                        This is the bidirectional guard: the index projects
 *                        the registry, so a row that resolves to an invocation
 *                        the parser rejects means the two have drifted.
 *   - Collision policy — "the command owns the bare name; the qualified form
 *                        is the escape hatch", and BOTH rows always exist.
 *   - Degradation      — a product repo with no `.github/skills` gets
 *                        commands only, and a read creates nothing on disk.
 *   - Surfaces         — the palette never lists what it cannot meaningfully
 *                        offer, while the CLI still lists everything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseFlags } from '../lib/flags.mjs';
import { SIDE_EFFECTS, getCommand, hasCommand, listCommands, validateArgs } from '../lib/registry.mjs';
import { ROW_KINDS, SKILLS_DIR, buildCommandIndex, resolveArgv } from '../lib/command-index.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const RANK = Object.fromEntries(SIDE_EFFECTS.map((s, i) => [s, i]));

/**
 * Point the global harness home at an empty directory for one test. The
 * knowledge store lives under it (lib/knowledge/store.mjs), NOT under the
 * workspace, so a read path that accidentally called `ensureStore` would
 * create `<home>/knowledge/...` where a workspace snapshot could never see
 * it. Same save/restore shape test/doctor-structural.test.mjs uses.
 */
function isolatedHome(t, prefix) {
  const home = tempDir(prefix);
  const saved = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = saved;
  });
  return home;
}

/** Seed `<ws>/.github/skills/<dir>/SKILL.md` in the given order. */
function seedSkills(workspace, skills) {
  for (const { dir, name, description, userInvocable, noFile } of skills) {
    const full = path.join(workspace, SKILLS_DIR, dir);
    fs.mkdirSync(full, { recursive: true });
    if (noFile) continue;
    const invocable = userInvocable === false ? 'user-invocable: false\n' : '';
    fs.writeFileSync(
      path.join(full, 'SKILL.md'),
      `---\nname: ${name ?? dir}\ndescription: ${description ?? `does ${dir}`}\n${invocable}---\n\nBody.\n`,
      'utf8'
    );
  }
  return workspace;
}

/** Every path under `root`, relative and sorted — a filesystem fingerprint. */
function listTree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      out.push(rel);
      if (d.isDirectory()) walk(path.join(dir, d.name), rel);
    }
  };
  walk(root, '');
  return out;
}

/** A picker answer of the right shape for one slot. The type matters because
 * `requireArgs` really runs `parseFlags` over the result, and lib/flags.mjs
 * validates values as it parses (`--min-score picked` throws). */
function answerFor(type) {
  return type === 'number' ? '1' : 'picked';
}

/** A `values` map that fills every slot a row can ask for — flag pickers keyed
 * by flag name, positional pickers by the positional's own name. */
function fillEveryValue(row, entry) {
  const values = {};
  for (const token of row.argvTokens) {
    if (token.kind !== 'value') continue;
    if (token.positional) values[token.positional] = 'picked';
    else values[token.flag] = answerFor(entry?.args.flags.find((f) => f.name === token.flag)?.type);
  }
  for (const option of [...row.prompts, ...row.refinements]) {
    values[option.flag] = option.type === 'boolean' ? true : answerFor(option.type);
  }
  return values;
}

// --- determinism ----------------------------------------------------------

test('the index is byte-identical across repeated builds', () => {
  const workspace = seedSkills(tempDir('cmdindex-det-'), [
    { dir: 'zeta' },
    { dir: 'alpha' },
    { dir: 'consolidate' },
  ]);
  const first = buildCommandIndex({ surface: 'tui', workspace });
  const second = buildCommandIndex({ surface: 'tui', workspace });
  assert.notEqual(first, second, 'a fresh object each call — not a memoized reference');
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(buildCommandIndex({ surface: 'cli', workspace })), JSON.stringify(buildCommandIndex({ surface: 'cli', workspace })));
});

test('the index does not depend on filesystem enumeration order', () => {
  // Same skills, opposite creation order. readdir order is filesystem
  // dependent, so only the explicit sort in lib/command-index.mjs makes these
  // two serialize identically.
  const forward = seedSkills(tempDir('cmdindex-order-a-'), [{ dir: 'alpha' }, { dir: 'middle' }, { dir: 'zeta' }]);
  const backward = seedSkills(tempDir('cmdindex-order-b-'), [{ dir: 'zeta' }, { dir: 'middle' }, { dir: 'alpha' }]);
  assert.equal(
    JSON.stringify(buildCommandIndex({ surface: 'tui', workspace: forward })),
    JSON.stringify(buildCommandIndex({ surface: 'tui', workspace: backward }))
  );
});

test('rows are totally ordered by label then id, by codepoint', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: seedSkills(tempDir('cmdindex-sort-'), [{ dir: 'zeta' }, { dir: 'alpha' }]) });
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const ordered = prev.label < cur.label || (prev.label === cur.label && prev.id < cur.id);
    assert.ok(ordered, `rows must be sorted: ${prev.label}/${prev.id} came before ${cur.label}/${cur.id}`);
  }
  // Sorting by label groups a command with its own verbs — the property the
  // comparator exists for.
  const labels = rows.map((r) => r.label);
  assert.deepEqual(labels.slice(labels.indexOf('index'), labels.indexOf('index') + 3), ['index', 'index status', 'index structural']);
});

// --- no flag syntax in labels --------------------------------------------

test('no row label contains flag syntax', () => {
  const workspace = seedSkills(tempDir('cmdindex-labels-'), [{ dir: 'consolidate' }, { dir: 'recall' }]);
  let flagBacked = 0;
  for (const surface of ['tui', 'cli', 'agent']) {
    const { rows } = buildCommandIndex({ surface, workspace });
    for (const row of rows) {
      assert.ok(!row.label.includes('--'), `${surface} row ${row.id} leaks flag syntax in its label: ${row.label}`);
      assert.ok(ROW_KINDS.includes(row.kind));
      if (row.argv?.some((token) => token.startsWith('--'))) flagBacked += 1;
    }
  }
  // Non-vacuity: rows really are backed by `--` argv, so the labels above
  // were transformed rather than simply never containing a flag.
  assert.ok(flagBacked > 0, 'the rule must be exercised by rows whose argv does carry a flag');
});

// --- argv round-trip ------------------------------------------------------

test('every row resolves to argv the registry accepts and dispatch will run', () => {
  const workspace = seedSkills(tempDir('cmdindex-argv-'), [{ dir: 'consolidate' }, { dir: 'plain' }]);
  let withValueToken = 0;
  let withPrompt = 0;
  let withRefinement = 0;
  let dispatchable = 0;
  let rowsNeedingAnswers = 0;
  let gated = 0;
  let withPositional = 0;

  for (const surface of ['tui', 'cli']) {
    const { rows } = buildCommandIndex({ surface, workspace });
    for (const row of rows) {
      if (row.argv === null) {
        // A skill has no harness argv at all — it is host-run.
        assert.equal(row.kind, 'skill', `${row.id} has no argv but is not a skill`);
        assert.deepEqual(row.argvTokens, []);
        assert.equal(resolveArgv(row), null);
        assert.equal(row.sideEffect, null, 'a skill declares no side-effect class the harness can guarantee');
        continue;
      }

      // A SKILL ROW IS THE ONE ROW WHOSE NOUN IS NOT A COMMAND. It resolves to
      // READING the skill (`get --path …/SKILL.md`), because a palette row
      // that can only answer "resolves to no command" is a dead end and the
      // palette's contract is that every row reaches a capability. Running the
      // workflow remains the host's job; `read` is honest about what the
      // harness itself does.
      if (row.kind === 'skill') {
        assert.deepEqual(row.argv.slice(0, 2), ['get', '--path'], `${row.id} must resolve to reading the skill`);
        assert.match(row.argv[2], /^\.github\/skills\/.+\/SKILL\.md$/, `${row.id} points at its own SKILL.md`);
        assert.equal(row.sideEffect, 'read');
        assert.ok(hasCommand('get'));
        continue;
      }

      // The bare template must be exactly the row's own argv — no value slots,
      // nothing reconstructed from the label.
      assert.deepEqual(resolveArgv(row), row.argv, `${row.id} template drift`);
      assert.ok(hasCommand(row.argv[0]), `${row.id} argv[0] "${row.argv[0]}" is not a registered command`);
      const entry = getCommand(row.argv[0]);
      assert.equal(entry.name, row.noun, `${row.id} noun must be its own command`);
      // `validateArgs` enforces declared `requires:` dependencies — not flags
      // merely marked `required: true`, which the entry's own `requireArgs`
      // predicate owns at dispatch (plan-new --type is that case). So the
      // bare template must be rejected exactly when it carries a flag whose
      // requirement it does not also carry: `consolidate apply` without
      // `--ops`. Demanding that row's bare argv validate would be demanding
      // the dependency go unenforced.
      const bareFlags = new Set(row.argv.slice(1));
      const unmetRequires = row.argv
        .slice(1)
        .flatMap((tok) => {
          const def = entry.args.flags.find((f) => f.name === tok || (f.aliases || []).includes(tok));
          return (def?.requires || []).filter((req) => !bareFlags.has(req));
        });
      if (unmetRequires.length === 0) {
        assert.equal(validateArgs(entry, row.argv.slice(1)), undefined, `${row.id} bare argv must validate`);
      } else {
        assert.throws(
          () => validateArgs(entry, row.argv.slice(1)),
          (err) => err.code === 'E_USAGE' && err.exit === 2,
          `${row.id} carries an unmet dependency (${unmetRequires.join(', ')}), so its bare argv must be rejected as E_USAGE rather than silently dispatching`,
        );
        // The answer must also be offered: a row the parser will reject until
        // a value arrives has to ask for that exact value.
        for (const req of unmetRequires) {
          assert.ok(
            row.prompts.some((p) => p.flag === req && p.required),
            `${row.id} requires ${req} but does not prompt for it as required`,
          );
        }
        rowsNeedingAnswers += 1;
      }

      // …and with every picker answered, which is the combination a palette
      // user can actually produce. This must hold for every row without
      // exception — it is the guard that the index cannot drift from dispatch.
      const values = fillEveryValue(row, entry);
      const filled = resolveArgv(row, values);
      const args = filled.slice(1);
      assert.equal(validateArgs(entry, args), undefined, `${row.id} filled argv ${JSON.stringify(filled)} must validate`);
      assert.ok(filled.length >= row.argv.length);

      // dispatch's SECOND gate, and the reason "validates" is not the same as
      // "runs": `validateArgs` only clears the flags, then `requireArgs`
      // decides whether the required ARGUMENTS are there. A row that passes
      // only the first is a row the palette dispatches and the CLI then
      // refuses with E_USAGE — which is how a `recall` row with no query
      // slot, and every other row below, used to pass this test.
      if (typeof entry.requireArgs === 'function') {
        assert.equal(
          entry.requireArgs(args, parseFlags(args)),
          undefined,
          `${row.id} resolves to ${JSON.stringify(filled)}, which dispatch's requireArgs gate refuses`,
        );
        gated += 1;
      }

      // The required arguments no predicate guards. A row must account for
      // every positional the command cannot run without — as the subcommand
      // word it selects, or as a picker of its own.
      const positionalSlots = row.argvTokens.filter((t) => t.kind === 'subcommand' || (t.kind === 'value' && t.positional)).length;
      const required = entry.args.positionals.filter((p) => p.required);
      assert.ok(
        positionalSlots >= required.length,
        `${row.id} fills ${positionalSlots} positional slot(s) but ${entry.name} requires ${required.length} (${required.map((p) => p.name).join(', ')})`,
      );

      // …and a verb that names the positionals it consumes must ask for each
      // one: `knowledge commit` without its mode is not a command.
      const under = (entry.verbs || []).find((v) => v.verb === row.argvTokens[1]?.value);
      for (const name of under?.positionals || []) {
        assert.ok(
          row.argvTokens.some((t) => t.kind === 'value' && t.positional === name),
          `${row.id} runs "${entry.name} ${under.verb}", which consumes <${name}>, but offers no picker for it`,
        );
      }

      if (row.argvTokens.some((t) => t.kind === 'value')) withValueToken += 1;
      if (row.argvTokens.some((t) => t.kind === 'value' && t.positional)) withPositional += 1;
      if (row.prompts.length) withPrompt += 1;
      if (row.refinements.length) withRefinement += 1;
      dispatchable += 1;
    }
  }
  // Non-vacuity: the sweep covered every shape a row can take.
  assert.ok(dispatchable > 40, `expected the whole registry projection, saw ${dispatchable}`);
  assert.ok(withValueToken > 0, 'a value-taking verb row (learnings why) must exist');
  assert.ok(withPositional > 0, 'a row with a positional picker (learning confirm / <id>) must exist');
  assert.ok(withPrompt > 0, 'a row carrying prompt options must exist');
  assert.ok(withRefinement > 0, 'a row carrying a dependent refinement (index structural / --since) must exist');
  assert.ok(gated > 0, 'the requireArgs gate must actually have run, or the branch above proves nothing');
  assert.ok(
    rowsNeedingAnswers > 0,
    'a row with a required prompt (consolidate apply / --ops) must exist, or the required-prompt branch above proves nothing',
  );
});

test('resolveArgv omits unanswered pickers and emits booleans as bare flags', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: packageRoot });
  const structural = rows.find((r) => r.id === 'flag:index:--structural');
  assert.deepEqual(structural.refinements.map((o) => o.flag), ['--since']);
  assert.deepEqual(resolveArgv(structural, {}), ['index', '--structural']);
  assert.deepEqual(resolveArgv(structural, { '--since': 'HEAD~1' }), ['index', '--structural', '--since', 'HEAD~1']);

  const why = rows.find((r) => r.id === 'flag:learnings:--why');
  assert.deepEqual(resolveArgv(why, {}), ['learnings', '--why'], 'the template keeps the flag, drops the empty slot');
  assert.deepEqual(resolveArgv(why, { '--why': 'sql/timeouts' }), ['learnings', '--why', 'sql/timeouts']);

  // A positional picker is keyed by the positional's own name and lands in
  // argv POSITION, not appended like an option.
  const confirm = rows.find((r) => r.id === 'verb:learning:confirm');
  assert.deepEqual(resolveArgv(confirm, {}), ['learning', 'confirm'], 'the template keeps the verb, drops the empty slot');
  assert.deepEqual(resolveArgv(confirm, { id: 'L-7', '--reason': 'still true' }), ['learning', 'confirm', 'L-7', '--reason', 'still true']);
  assert.deepEqual(resolveArgv(rows.find((r) => r.id === 'verb:knowledge:commit'), { target: 'repo' }), ['knowledge', 'commit', 'repo']);
  assert.deepEqual(resolveArgv(rows.find((r) => r.id === 'command:recall'), { query: 'orders timeout' }), ['recall', 'orders timeout']);

  // `--apply` is a row of its own, never a refinement of the bare command: it
  // is the sole writer, and appending it to a row that renders `read` is
  // exactly the mislabelling the side-effect glyph exists to prevent.
  const consolidate = rows.find((r) => r.id === 'command:consolidate');
  assert.deepEqual(consolidate.refinements, [], 'the read-only status row offers no writing refinement');
  assert.deepEqual(consolidate.prompts.map((o) => o.flag), ['--ops', '--layer']);
  assert.deepEqual(
    resolveArgv(consolidate, { '--apply': true, '--ops': 'ops.json' }),
    ['consolidate', '--ops', 'ops.json'],
    'an answer for an option this row does not offer cannot smuggle it onto argv',
  );
  const apply = rows.find((r) => r.id === 'flag:consolidate:--apply');
  assert.deepEqual(apply.prompts.find((o) => o.flag === '--ops').required, true);
  assert.deepEqual(resolveArgv(apply, { '--ops': 'ops.json' }), ['consolidate', '--apply', '--ops', 'ops.json']);

  // Boolean options: present-and-true becomes a bare flag, false vanishes.
  // Built by hand because no registry flag is BOTH `tui: 'prompt'`-or-
  // dependent AND boolean today — the branch is real code on the dispatch
  // path, so it is covered here rather than left to a future entry.
  const synthetic = {
    argvTokens: [{ kind: 'command', value: 'probe' }],
    prompts: [{ flag: '--loud', type: 'boolean' }],
    refinements: [{ flag: '--tag', type: 'string' }],
  };
  assert.deepEqual(resolveArgv(synthetic, { '--loud': true, '--tag': 'x' }), ['probe', '--loud', '--tag', 'x']);
  assert.deepEqual(resolveArgv(synthetic, { '--loud': false, '--tag': 'x' }), ['probe', '--tag', 'x']);

  assert.equal(resolveArgv(null), null);
  assert.equal(resolveArgv({ argvTokens: [] }), null);
});

// --- collision policy -----------------------------------------------------

test('a command and a skill sharing a name both stay in the one flat namespace', () => {
  const workspace = seedSkills(tempDir('cmdindex-collide-'), [
    { dir: 'consolidate', description: 'the consolidation workflow' },
    { dir: 'recall', description: 'the recall workflow' },
    { dir: 'brainstorming', description: 'no command owns this name' },
    { dir: 'ensure-plan', userInvocable: false },
    { dir: 'references', noFile: true },
  ]);
  const { rows, collisions, skillsRoot } = buildCommandIndex({ surface: 'tui', workspace });

  assert.equal(skillsRoot, SKILLS_DIR);
  assert.deepEqual(collisions, ['consolidate', 'recall'], 'both overlaps are reported, sorted');

  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const name of ['consolidate', 'recall']) {
    assert.ok(byId.get(`command:${name}`), `the command row for ${name} survives`);
    const skill = byId.get(`skill:${name}`);
    assert.ok(skill, `the skill row for ${name} survives`);
    assert.equal(skill.label, `skill:${name}`, 'the command owns the bare name; the skill is qualified');
    assert.equal(byId.get(`command:${name}`).label, name);
  }

  assert.equal(rows.filter((r) => r.kind === 'skill').length, 3, 'brainstorming + the two colliding skills');
  assert.equal(byId.has('skill:ensure-plan'), false, 'user-invocable: false is excluded');
  assert.equal(byId.has('skill:references'), false, 'a directory with no SKILL.md is not a skill');
  assert.equal(byId.get('skill:brainstorming').summary, 'no command owns this name');

  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique across the whole flat namespace');
});

test('with no name overlap, collisions is empty but skills are still listed', () => {
  const workspace = seedSkills(tempDir('cmdindex-nocollide-'), [{ dir: 'brainstorming' }, { dir: 'triage-issues' }]);
  const { rows, collisions } = buildCommandIndex({ surface: 'tui', workspace });
  assert.deepEqual(collisions, []);
  assert.deepEqual(rows.filter((r) => r.kind === 'skill').map((r) => r.id), ['skill:brainstorming', 'skill:triage-issues']);
});

// --- graceful degradation -------------------------------------------------

test('a workspace with no .github/skills yields commands only and creates nothing', (t) => {
  const workspace = tempDir('cmdindex-bare-');
  const home = isolatedHome(t, 'cmdindex-bare-home-');
  assert.deepEqual(fs.readdirSync(workspace), [], 'precondition: the workspace is empty');

  const index = buildCommandIndex({ surface: 'tui', workspace });
  assert.equal(index.skillsRoot, null, 'null distinguishes "not scanned" from "scanned, nothing found"');
  assert.deepEqual(index.collisions, []);
  assert.equal(index.rows.filter((r) => r.kind === 'skill').length, 0);
  assert.ok(index.rows.length > 0, 'commands are still indexed');

  assert.deepEqual(fs.readdirSync(workspace), [], 'a read must create nothing in the workspace');
  // …and nothing in the global home either, which is where the knowledge
  // store lives: an accidental `ensureStore` would seed `<home>/knowledge/…`
  // entirely outside the workspace snapshot above.
  assert.deepEqual(listTree(home), [], 'a read must create nothing under the harness home');
});

test('an empty .github/skills is reported as scanned-and-empty', (t) => {
  const workspace = tempDir('cmdindex-emptyskills-');
  const home = isolatedHome(t, 'cmdindex-emptyskills-home-');
  fs.mkdirSync(path.join(workspace, SKILLS_DIR), { recursive: true });
  const before = listTree(workspace);

  const index = buildCommandIndex({ surface: 'tui', workspace });
  assert.equal(index.skillsRoot, SKILLS_DIR, 'the directory exists, so it was scanned');
  assert.equal(index.rows.filter((r) => r.kind === 'skill').length, 0);

  assert.deepEqual(listTree(workspace), before, 'the read left the tree untouched');
  assert.deepEqual(listTree(home), [], 'and left the harness home untouched');
});

test('a skills tree is never mutated by a read', (t) => {
  const workspace = seedSkills(tempDir('cmdindex-readonly-'), [{ dir: 'alpha' }, { dir: 'beta' }, { dir: 'refs', noFile: true }]);
  const home = isolatedHome(t, 'cmdindex-readonly-home-');
  const before = listTree(workspace);
  buildCommandIndex({ surface: 'tui', workspace });
  buildCommandIndex({ surface: 'cli', workspace });
  assert.deepEqual(listTree(workspace), before);
  assert.deepEqual(listTree(home), []);
});

test('an unknown surface is rejected rather than silently defaulted', () => {
  assert.throws(() => buildCommandIndex({ surface: 'desktop', workspace: packageRoot }), TypeError);
});

// --- surfaces -------------------------------------------------------------

// `tui` joins them: a ledger offering "open the session ledger" in its own
// palette is a row that can only refuse, and it crowds out one that could act.
const LIFECYCLE_ONLY = ['install', 'upgrade', 'uninstall', 'init-repo', 'resolve', 'tui'];

test('the palette omits lifecycle and machine-only commands; the CLI keeps them', () => {
  const tui = buildCommandIndex({ surface: 'tui', workspace: packageRoot });
  const cli = buildCommandIndex({ surface: 'cli', workspace: packageRoot });
  for (const name of LIFECYCLE_ONLY) {
    assert.ok(hasCommand(name), `${name} must be registered for this test to mean anything`);
    assert.equal(tui.rows.some((r) => r.noun === name), false, `${name} must not appear on the palette`);
    assert.ok(cli.rows.some((r) => r.id === `command:${name}`), `${name} must still appear on the CLI`);
  }
  assert.equal(cli.rows.length - tui.rows.length, LIFECYCLE_ONLY.length, 'the CLI surface is the palette plus exactly these six');
});

test('nothing marked userInvocable: false reaches the tui surface', () => {
  const internal = listCommands().filter((n) => getCommand(n).userInvocable === false);
  assert.ok(internal.length > 0, 'the rule is vacuous unless at least one command opts out');
  assert.deepEqual(internal, ['resolve']);

  const { rows } = buildCommandIndex({ surface: 'tui', workspace: packageRoot });
  for (const name of internal) {
    assert.equal(rows.some((r) => r.noun === name), false, `${name} is harness-invoked, not user-invoked`);
  }
  // …but it is still indexed on the surface it declares, which is the whole
  // point of filtering the palette rather than the registry. `resolve`
  // declares `surfaces: ['cli']`, so `cli` keeps it and `agent` — which it
  // does not declare — does not.
  assert.ok(buildCommandIndex({ surface: 'cli', workspace: packageRoot }).rows.some((r) => r.noun === 'resolve'));
  assert.equal(buildCommandIndex({ surface: 'agent', workspace: packageRoot }).rows.some((r) => r.noun === 'resolve'), false);
});

test('every row on a surface belongs to a command declaring that surface', () => {
  for (const surface of ['tui', 'cli', 'agent']) {
    const { rows } = buildCommandIndex({ surface, workspace: packageRoot });
    for (const row of rows.filter((r) => r.kind !== 'skill')) {
      const entry = getCommand(row.noun);
      assert.ok(entry, `${row.id} must map to a registered command`);
      assert.ok(entry.surfaces.includes(surface), `${row.id} appears on ${surface} but ${row.noun} does not declare it`);
      if (surface === 'tui') assert.notEqual(entry.userInvocable, false);
    }
  }
});

test('skills are a tui-only concept', () => {
  const workspace = seedSkills(tempDir('cmdindex-surfskills-'), [{ dir: 'brainstorming' }]);
  for (const surface of ['cli', 'agent']) {
    const index = buildCommandIndex({ surface, workspace });
    assert.equal(index.skillsRoot, null, `${surface} does not scan for skills`);
    assert.deepEqual(index.collisions, []);
    assert.equal(index.rows.filter((r) => r.kind === 'skill').length, 0);
  }
  assert.equal(buildCommandIndex({ surface: 'tui', workspace }).rows.filter((r) => r.kind === 'skill').length, 1);
});

/**
 * The side-effect glyph is the palette's one claim no surveyed agent CLI can
 * make — "see what this will do to your repo before you run it". It is only
 * worth anything if it is accurate per row, so the two directions are not
 * symmetric:
 *
 * - Under-warning is a SAFETY bug: a row that writes must never read as `read`.
 * - Over-warning is a TRUST bug: `harness report` alone only reads, and a
 *   glyph that cries wolf on every read-only form stops being read at all.
 *
 * The entry's own `sideEffect` stays the policy-facing maximum; these rows
 * carry `bareSideEffect` / per-verb / per-flag overrides.
 */

/**
 * The one declaration a row's class may come from — its OWN source, not any
 * source somewhere in the entry: a command row's is `bareSideEffect`, a
 * declared verb row's is that verb's, a flag-derived row's is that flag's
 * (falling back to the verb it sits under). Checking "some flag of this
 * command declares `read`" instead would let `consolidate --candidates`
 * excuse a `read` glyph on any consolidate row.
 */
function declaredClassOf(entry, row) {
  const under = (entry.verbs || []).find((v) => v.verb === row.argvTokens[1]?.value);
  const flagToken = row.argvTokens.find((t) => t.kind === 'flag');
  if (flagToken) {
    const def = entry.args.flags.find((f) => f.name === flagToken.value);
    return def?.sideEffect ?? under?.sideEffect ?? entry.sideEffect;
  }
  if (under) return under.sideEffect ?? entry.sideEffect;
  return entry.bareSideEffect ?? entry.sideEffect;
}

/** What one token of a resolved argv is declared to do. A flag that declares
 * nothing is assumed to do the worst the command can — silence is not a
 * promise. */
function classOfFlagToken(entry, token) {
  const def = entry.args.flags.find((f) => f.name === token || (f.aliases || []).includes(token));
  return def?.sideEffect ?? entry.sideEffect;
}

test('every row carries its own consequence, not its command policy maximum', () => {
  const { rows } = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  const byLabel = new Map(rows.map((r) => [r.label, r]));

  const expected = {
    // read-only forms of commands classified `mutate` for policy
    'index status': 'read',
    'report': 'read',
    'report global': 'read',
    'consolidate': 'read',
    'consolidate candidates': 'read',
    // …and the forms that genuinely write, which must not be softened
    'index': 'mutate',
    'index structural': 'mutate',
    'report sync': 'mutate',
    'consolidate apply': 'mutate',
    'consolidate rebuild': 'mutate',
  };
  for (const [label, effect] of Object.entries(expected)) {
    const row = byLabel.get(label);
    assert.ok(row, `${label} must be a palette row`);
    assert.equal(row.sideEffect, effect, `${label} must render as ${effect}`);
  }

  // A downgrade must be JUSTIFIED, not merely declared somewhere in the entry.
  // Two independent obligations, because "the registry says so" is what a
  // mislabelled row would also satisfy:
  //
  //   1. the class comes from this row's own declaration (`declaredClassOf`);
  //   2. the row genuinely cannot exceed it — no option it offers, and no
  //      token any answer can put on its argv, outranks the glyph.
  //
  // (2) is the invariant that makes the glyph worth reading: `consolidate`
  // renders `read`, and no combination of its own pickers may resolve to
  // `consolidate --ops x.json --apply`, which writes the store.
  let downgraded = 0;
  let optionsChecked = 0;
  for (const row of rows) {
    if (row.kind === 'skill') continue;
    const entry = getCommand(row.noun);
    assert.equal(
      row.sideEffect,
      declaredClassOf(entry, row),
      `${row.id} renders ${row.sideEffect}, which is not what its own declaration says`,
    );
    if (RANK[row.sideEffect] < RANK[entry.sideEffect]) downgraded += 1;

    for (const option of [...row.prompts, ...row.refinements]) {
      assert.ok(
        RANK[option.sideEffect] <= RANK[row.sideEffect],
        `${row.id} renders ${row.sideEffect} but offers ${option.flag} (${option.sideEffect}) — selecting it escalates past the glyph`,
      );
      optionsChecked += 1;
    }
    for (const token of resolveArgv(row, fillEveryValue(row, entry)).slice(1)) {
      if (!token.startsWith('-')) continue;
      assert.ok(
        RANK[classOfFlagToken(entry, token)] <= RANK[row.sideEffect],
        `${row.id} renders ${row.sideEffect} but resolves to an argv carrying ${token} (${classOfFlagToken(entry, token)})`,
      );
    }
  }
  assert.ok(downgraded >= Object.values(expected).filter((e) => e === 'read').length, 'the downgrade branch must be exercised');
  assert.ok(optionsChecked > 0, 'rows really do carry options, so the escalation check is not vacuous');
});
