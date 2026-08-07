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
import { getCommand, hasCommand, listCommands, validateArgs } from '../lib/registry.mjs';
import { ROW_KINDS, SKILLS_DIR, buildCommandIndex, resolveArgv } from '../lib/command-index.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

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

/** A `values` map that fills every slot a row can ask for. */
function fillEveryValue(row) {
  const values = {};
  for (const token of row.argvTokens) if (token.kind === 'value') values[token.flag] = 'picked';
  for (const option of [...row.prompts, ...row.refinements]) {
    values[option.flag] = option.type === 'boolean' ? true : 'picked';
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

test('every row resolves to argv the registry accepts', () => {
  const workspace = seedSkills(tempDir('cmdindex-argv-'), [{ dir: 'consolidate' }, { dir: 'plain' }]);
  let withValueToken = 0;
  let withPrompt = 0;
  let withRefinement = 0;
  let dispatchable = 0;
  let rowsNeedingAnswers = 0;

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
      const values = fillEveryValue(row);
      const filled = resolveArgv(row, values);
      assert.equal(validateArgs(entry, filled.slice(1)), undefined, `${row.id} filled argv ${JSON.stringify(filled)} must validate`);
      assert.ok(filled.length >= row.argv.length);

      if (row.argvTokens.some((t) => t.kind === 'value')) withValueToken += 1;
      if (row.prompts.length) withPrompt += 1;
      if (row.refinements.length) withRefinement += 1;
      dispatchable += 1;
    }
  }
  // Non-vacuity: the sweep covered every shape a row can take.
  assert.ok(dispatchable > 40, `expected the whole registry projection, saw ${dispatchable}`);
  assert.ok(withValueToken > 0, 'a value-taking verb row (learnings why) must exist');
  assert.ok(withPrompt > 0, 'a row carrying prompt options must exist');
  assert.ok(withRefinement > 0, 'a row carrying a dependent refinement (index structural / --since) must exist');
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

  // Boolean refinement: present-and-true becomes a bare flag, false vanishes.
  const consolidate = rows.find((r) => r.id === 'command:consolidate');
  const apply = consolidate.refinements.find((o) => o.flag === '--apply');
  assert.equal(apply.type, 'boolean');
  assert.deepEqual(apply.requires, ['--ops']);
  assert.deepEqual(resolveArgv(consolidate, { '--apply': true, '--ops': 'ops.json' }), ['consolidate', '--ops', 'ops.json', '--apply']);
  assert.deepEqual(resolveArgv(consolidate, { '--apply': false, '--ops': 'ops.json' }), ['consolidate', '--ops', 'ops.json']);

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

test('a workspace with no .github/skills yields commands only and creates nothing', () => {
  const workspace = tempDir('cmdindex-bare-');
  assert.deepEqual(fs.readdirSync(workspace), [], 'precondition: the workspace is empty');

  const index = buildCommandIndex({ surface: 'tui', workspace });
  assert.equal(index.skillsRoot, null, 'null distinguishes "not scanned" from "scanned, nothing found"');
  assert.deepEqual(index.collisions, []);
  assert.equal(index.rows.filter((r) => r.kind === 'skill').length, 0);
  assert.ok(index.rows.length > 0, 'commands are still indexed');

  assert.deepEqual(fs.readdirSync(workspace), [], 'a read must create nothing on disk');
});

test('an empty .github/skills is reported as scanned-and-empty', () => {
  const workspace = tempDir('cmdindex-emptyskills-');
  fs.mkdirSync(path.join(workspace, SKILLS_DIR), { recursive: true });
  const before = listTree(workspace);

  const index = buildCommandIndex({ surface: 'tui', workspace });
  assert.equal(index.skillsRoot, SKILLS_DIR, 'the directory exists, so it was scanned');
  assert.equal(index.rows.filter((r) => r.kind === 'skill').length, 0);

  assert.deepEqual(listTree(workspace), before, 'the read left the tree untouched');
});

test('a skills tree is never mutated by a read', () => {
  const workspace = seedSkills(tempDir('cmdindex-readonly-'), [{ dir: 'alpha' }, { dir: 'beta' }, { dir: 'refs', noFile: true }]);
  const before = listTree(workspace);
  buildCommandIndex({ surface: 'tui', workspace });
  buildCommandIndex({ surface: 'cli', workspace });
  assert.deepEqual(listTree(workspace), before);
});

test('an unknown surface is rejected rather than silently defaulted', () => {
  assert.throws(() => buildCommandIndex({ surface: 'desktop', workspace: packageRoot }), TypeError);
});

// --- surfaces -------------------------------------------------------------

const LIFECYCLE_ONLY = ['install', 'upgrade', 'uninstall', 'init-repo', 'resolve'];

test('the palette omits lifecycle and machine-only commands; the CLI keeps them', () => {
  const tui = buildCommandIndex({ surface: 'tui', workspace: packageRoot });
  const cli = buildCommandIndex({ surface: 'cli', workspace: packageRoot });
  for (const name of LIFECYCLE_ONLY) {
    assert.ok(hasCommand(name), `${name} must be registered for this test to mean anything`);
    assert.equal(tui.rows.some((r) => r.noun === name), false, `${name} must not appear on the palette`);
    assert.ok(cli.rows.some((r) => r.id === `command:${name}`), `${name} must still appear on the CLI`);
  }
  assert.equal(cli.rows.length - tui.rows.length, LIFECYCLE_ONLY.length, 'the CLI surface is the palette plus exactly these five');
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
