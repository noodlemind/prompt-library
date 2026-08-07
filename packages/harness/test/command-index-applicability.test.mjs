/**
 * AC9 — applicability. `validateArgs` must reject an option applied to a verb
 * that does not accept it, and a dependent option whose requirement is absent.
 *
 * Both are the parser half of the palette contract: the index only offers
 * combinations the CLI accepts (asserted in command-index-contract.test.mjs),
 * and this file asserts the CLI actually refuses the combinations the index
 * declines to offer. Every rejection is the `E_USAGE`/exit-2 class — "you
 * called it wrong" — never a bare Error that bin/harness.mjs would misreport
 * as a harness fault, so the code AND the exit are asserted, not just that
 * something threw.
 *
 * Also covers `registerCommand`'s registration-time validation of the same
 * metadata: a `requires` or `verbs` scope naming something undeclared can
 * never fire, so it is a typo and must fail at registration rather than
 * silently never applying.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { hasFlag } from '../lib/flags.mjs';
import { getCommand, hasCommand, registerCommand, validateArgs } from '../lib/registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Run `fn`, returning the error it threw — or failing if it threw nothing. */
function caught(fn, what) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail(`${what} must throw`);
}

/** Assert one invocation is refused as caller misuse, with the exact message. */
function rejects(command, argv, message) {
  const err = caught(
    () => validateArgs(getCommand(command), argv),
    `harness ${command} ${argv.join(' ')}`
  );
  assert.equal(err.code, 'E_USAGE', 'caller misuse, not a harness fault');
  assert.equal(err.exit, EXIT.usage);
  assert.equal(err.exit, 2, 'the usage exit code is 2 — pinned, not merely equal to EXIT.usage');
  assert.equal(err.message, message);
  assert.equal(err.hint, `harness help ${command}`);
}

/** Assert one invocation is accepted (validateArgs returns nothing). */
function accepts(command, argv) {
  assert.equal(
    validateArgs(getCommand(command), argv),
    undefined,
    `harness ${command} ${argv.join(' ')} must validate`
  );
}

// --- AC9: per-flag verb scoping -----------------------------------------

test('AC9: an option is rejected on a verb that does not accept it', () => {
  // --branch is declared `verbs: ['promote','prune']`. `status` is a declared
  // verb of the same command, so the parser knows the flag cannot apply.
  rejects('knowledge', ['status', '--branch', 'x'], '--branch does not apply to "knowledge status"');
  rejects('knowledge', ['on', '--all'], '--all does not apply to "knowledge on"');
  rejects('learning', ['retire', '--to', 'p'], '--to does not apply to "learning retire"');
});

test('AC9: the same option passes on every verb that does accept it', () => {
  accepts('knowledge', ['promote', '--branch', 'x']);
  accepts('knowledge', ['prune', '--branch', 'x']);
  accepts('knowledge', ['promote', '--all']);
  accepts('knowledge', ['purge', '--all']);
  accepts('knowledge', ['prune', '--merged', '--stale', '30', '--yes']);
  accepts('learning', ['promote', 'L-1', '--to', 'docs/x.md']);
  // Deliberately unscoped: lifecycle.mjs records `reason` on all four
  // actions, so scoping --reason to retire/dispute would reject a working
  // invocation. Asserted so a future "tidy-up" that scopes it fails here.
  accepts('learning', ['confirm', 'L-1', '--reason', 'still true']);
});

// --- AC9: dependent options ----------------------------------------------

test('AC9: a dependent option is rejected when its requirement is absent', () => {
  rejects('index', ['--since', 'ref'], '--since requires --structural');
  rejects('consolidate', ['--apply'], '--apply requires --ops');
});

test('AC9: a dependent option passes once its requirement is present', () => {
  accepts('index', ['--structural', '--since', 'ref']);
  accepts('index', ['--status']);
  accepts('consolidate', ['--apply', '--ops', 'ops.json']);
  // Order must not matter — `requires` is a set membership check over the
  // whole invocation, not a positional rule.
  accepts('index', ['--since', 'ref', '--structural']);
});

/**
 * The dependency may only fire when the HANDLER would act on the flag.
 * Handlers read booleans by exact token equality (lib/flags.mjs's `hasFlag`,
 * `a === '--apply'`), so `--apply=false` is the status form to cmdConsolidate
 * — and it validated fine before this branch. Enforcing `--apply`'s
 * `requires` on a token the handler ignores newly rejects a working
 * invocation, which is precisely what "the CLI grammar does not change to
 * accommodate the palette" forbids.
 */
test('AC9: a boolean written as --flag=value is accepted, because that is not how a handler reads it', () => {
  assert.equal(hasFlag(['--apply=false'], '--apply'), false, 'the coupling this rests on: the handler does not see it');
  accepts('consolidate', ['--apply=false']);
  // No reader treats `=true` as the apply form either, and verb scoping draws
  // no conclusion from a token the handler ignores.
  accepts('consolidate', ['--apply=true']);
  accepts('knowledge', ['on', '--all=true']);
  // The real form is unchanged in both directions.
  rejects('consolidate', ['--apply'], '--apply requires --ops');
  accepts('consolidate', ['--apply', '--ops', 'ops.json']);
});

test('AC9: end to end, `consolidate --apply=false` still runs the status view', () => {
  const workspace = tempDir('cmdindex-applyeq-ws-');
  const home = tempDir('cmdindex-applyeq-home-');
  const run = (argv) =>
    spawnSync(process.execPath, [binPath, ...argv, '--workspace', workspace, '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: home },
    });

  const bare = run(['consolidate']);
  const equalsFalse = run(['consolidate', '--apply=false']);
  assert.equal(equalsFalse.status, 0, equalsFalse.stderr);
  assert.equal(equalsFalse.stdout, bare.stdout, 'it is the same status view, not a rejected apply');
});

// --- AC9: the negative — unannotated commands are untouched --------------

test('AC9: a command declaring neither verbs nor requires validates exactly as before', () => {
  for (const name of ['orient', 'recall', 'get', 'verify', 'gate', 'plan-new', 'remember']) {
    const entry = getCommand(name);
    assert.deepEqual(entry.verbs, [], `${name} declares no verbs`);
    assert.deepEqual(
      entry.args.flags.filter((f) => f.requires || f.verbs).map((f) => f.name),
      [],
      `${name} declares no per-flag applicability metadata`
    );
  }
  // Every declared flag, all at once, plus globals — the applicability pass
  // must be a no-op for these.
  accepts('orient', ['some', 'query', '--query', 'q', '--limit', '5', '--collection', 'c', '--min-score', '0.2', '--explain', '--json', '--verbose']);
  accepts('recall', ['orders', 'timeout', '--limit', '2', '-c', 'sql', '--include-plans']);
  accepts('verify', ['--plan', 'p.md', '--base', 'HEAD~1', '--enforcement', 'warn', '--learnings', 'a,b']);
  accepts('get', ['--docid', 'd', '--path', 'p', '--lines', '10', '--max-bytes', '99']);
  // …and an unknown flag is still the same rejection it always was.
  rejects('orient', ['--nope'], 'unknown flag: --nope');
  rejects('verify', ['--structural'], 'unknown flag: --structural');
});

test('AC9: applicability never fires without a resolvable verb token', () => {
  // No bare token at all: nothing selected a verb, so a scoped flag cannot be
  // proven inapplicable and must not be rejected (the pre-annotation
  // behavior, which several existing callers rely on).
  accepts('knowledge', ['--branch', 'x']);
  // A bare token that is not a declared verb likewise selects nothing.
  accepts('knowledge', ['not-a-verb', '--branch', 'x']);
  // `--` ends the scan: a verb after it is data, not a selection.
  accepts('knowledge', ['--branch', 'x', '--', 'status']);
});

// --- AC9 end to end: the CLI really exits 2 ------------------------------

test('AC9: the CLI rejects an inapplicable option with exit 2 and touches nothing', () => {
  const workspace = tempDir('cmdindex-ac9-');
  for (const argv of [
    ['knowledge', 'status', '--branch', 'x'],
    ['index', '--since', 'ref'],
  ]) {
    const run = spawnSync(process.execPath, [binPath, ...argv, '--workspace', workspace, '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    assert.equal(run.status, EXIT.usage, `harness ${argv.join(' ')} must exit 2`);
    assert.equal(run.stdout, '', 'a refusal is diagnostics, never stdout payload');
    const payload = JSON.parse(run.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'E_USAGE');
    assert.equal(payload.error.exit, 2);
    // The rejection precedes the handler, so a mutate-class command that was
    // called wrong writes nothing at all — not even a telemetry file.
    assert.deepEqual(fs.readdirSync(workspace), [], 'a rejected invocation must not touch the workspace');
  }
});

// --- registration-time validation of the same metadata -------------------

const PROBE = 'cmdindex-probe';
const baseEntry = { name: PROBE, sideEffect: 'read', handler: () => 0 };

/** Assert `registerCommand` refuses an entry AND leaves the registry clean. */
function refusesRegistration(entry, messageFragment) {
  const err = caught(() => registerCommand(entry), `registerCommand(${JSON.stringify(entry.name)})`);
  assert.match(err.message, messageFragment);
  assert.equal(hasCommand(PROBE), false, 'a refused entry must never land in the registry');
}

test('registerCommand refuses an invalid tui disposition', () => {
  refusesRegistration(
    { ...baseEntry, args: { flags: [{ name: '--x', type: 'boolean', tui: 'sidebar' }] } },
    /invalid tui disposition "sidebar" \(must be verb \| prompt \| cli-only\)/
  );
});

test('registerCommand refuses a requires naming an undeclared flag', () => {
  refusesRegistration(
    { ...baseEntry, args: { flags: [{ name: '--x', type: 'boolean', requires: ['--absent'] }] } },
    /flag --x requires --absent, which it does not declare/
  );
});

test('registerCommand refuses a flag scoped to an undeclared verb', () => {
  refusesRegistration(
    {
      ...baseEntry,
      verbs: [{ verb: 'alpha', summary: 'declared' }],
      args: { flags: [{ name: '--x', type: 'boolean', verbs: ['beta'] }] },
    },
    /flag --x is scoped to verb "beta", which it does not declare/
  );
});

test('registerCommand refuses a duplicate verb', () => {
  refusesRegistration(
    { ...baseEntry, verbs: [{ verb: 'alpha', summary: 'one' }, { verb: 'alpha', summary: 'two' }] },
    /declares verb "alpha" twice/
  );
});

test('registerCommand refuses an invalid surface', () => {
  refusesRegistration({ ...baseEntry, surfaces: ['cli', 'desktop'] }, /invalid surface "desktop" \(must be cli \| tui \| agent\)/);
  refusesRegistration({ ...baseEntry, surfaces: [] }, /surfaces must be a non-empty array/);
});

test('registerCommand refuses an invalid verb sideEffect', () => {
  refusesRegistration(
    { ...baseEntry, verbs: [{ verb: 'alpha', summary: 'declared', sideEffect: 'delete' }] },
    /verb "alpha" has an invalid sideEffect "delete"/
  );
  // A verb without a summary would reach the palette as a blank row.
  refusesRegistration({ ...baseEntry, verbs: [{ verb: 'alpha' }] }, /verb "alpha" needs a summary/);
});

/**
 * `entry.sideEffect` is documented as the MAXIMUM across every form of the
 * command — policy reads it that way, and the palette's per-row glyph is only
 * safe because of it. An enum check alone let an entry declare `read` and
 * then hang a `mutate` flag off it, so the maximum was a maximum by comment
 * only. An override may move down the ordering, never up.
 */
test('registerCommand refuses an override above the command own sideEffect', () => {
  refusesRegistration(
    { ...baseEntry, bareSideEffect: 'mutate' },
    /bareSideEffect declares sideEffect "mutate" above the command's own "read"/
  );
  refusesRegistration(
    { ...baseEntry, verbs: [{ verb: 'alpha', summary: 'declared', sideEffect: 'execute' }] },
    /verb "alpha" declares sideEffect "execute" above the command's own "read"/
  );
  refusesRegistration(
    { ...baseEntry, args: { flags: [{ name: '--x', type: 'boolean', sideEffect: 'mutate' }] } },
    /flag --x declares sideEffect "mutate" above the command's own "read"/
  );
  // An execute-class command may still declare a mutating verb — only the
  // upward direction is refused.
  refusesRegistration(
    { ...baseEntry, sideEffect: 'mutate', args: { flags: [{ name: '--x', type: 'boolean', sideEffect: 'execute' }] } },
    /flag --x declares sideEffect "execute" above the command's own "mutate"/
  );
  // …and the downgrades the registry actually ships are untouched.
  assert.equal(getCommand('consolidate').bareSideEffect, 'read');
  assert.equal(getCommand('consolidate').sideEffect, 'mutate');
  assert.equal(getCommand('report').args.flags.find((f) => f.name === '--host').sideEffect, 'read');
});

test('registerCommand refuses a verb consuming a positional it does not declare', () => {
  refusesRegistration(
    {
      ...baseEntry,
      verbs: [{ verb: 'alpha', summary: 'declared', positionals: ['ghost'] }],
      args: { positionals: [{ name: 'action' }], flags: [] },
    },
    /verb "alpha" consumes positional "ghost", which it does not declare/
  );
  // The verb's own slot is already filled by the subcommand token, so naming
  // it would put the same word on argv twice.
  refusesRegistration(
    {
      ...baseEntry,
      verbs: [{ verb: 'alpha', summary: 'declared', positionals: ['action'] }],
      args: { positionals: [{ name: 'action' }, { name: 'id' }], flags: [] },
    },
    /verb "alpha" consumes positional "action", which is the verb's own slot/
  );
});
