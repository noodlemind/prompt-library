/**
 * Phase 4b — the Session Ledger.
 *
 * The design direction is what makes most of these assertions cheap: a
 * scrolling transcript in the terminal's MAIN buffer is a read-dispatch-print
 * loop, so there is no screen manager to test and no second behavior path to
 * keep in sync. The properties worth pinning are the ones that would let those
 * two things creep back in — a palette that drifts from dispatch, a row that
 * asks someone to type flag syntax, a ledger that shells out instead of
 * dispatching.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT } from '../lib/style.mjs';
import { getCommand, listCommands, validateArgs } from '../lib/registry.mjs';
import { buildCommandIndex } from '../lib/command-index.mjs';
import { rankRows, scoreRow, SCORE } from '../lib/tui/ranking.mjs';
import { containsFlagSyntax, openPalette, promptsFor, resolveSelection, selectionPlan } from '../lib/tui/palette.mjs';
import { createTally, interpretLine, stripControl, tokenize } from '../lib/tui/session.mjs';
import { runLedger } from '../lib/tui-cmd.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(packageRoot, 'bin', 'harness.mjs');
const tempDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const ESC = String.fromCharCode(27);

/** Drive the whole loop over strings — the reason input/output are injected. */
async function ledger(lines, { workspace = process.cwd(), dispatcher } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  // `--no-events` so the suite does not append to the repository's own run
  // journal. The ledger opens and closes a real run per command now — that is
  // the point of blocks being records — and a test run is not history.
  const done = runLedger({ input, output, workspace, argv: ['--no-color', '--no-events'], dispatcher });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return text;
}

// --- P4bAC9: deterministic ranking -----------------------------------------

test('P4bAC9: word-boundary matches rank above interior ones', () => {
  const rows = [
    { id: 'a', label: 'prune' },
    { id: 'b', label: 'run list' },
    { id: 'c', label: 'knowledge prune' },
  ];
  const ranked = rankRows(rows, 'run').map((r) => r.label);
  assert.equal(ranked[0], 'run list',
    'a person typing three letters is naming a thing, not describing where the letters appear');
  assert.ok(ranked.includes('prune'), 'an interior match still matches — it just loses');
  assert.ok(ranked.indexOf('run list') < ranked.indexOf('prune'));
});

test('P4bAC9: the same query against the same rows yields the same order, every time', () => {
  const index = buildCommandIndex({ surface: 'tui', workspace: process.cwd() });
  for (const query of ['run', 'kn', 'status', 'trust ap', 'x']) {
    const first = rankRows(index.rows, query).map((r) => r.id);
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(rankRows(index.rows, query).map((r) => r.id), first,
        `ranking for ${JSON.stringify(query)} must not vary between calls`);
    }
    // …and must not depend on the input order, which is registration order
    // across files and therefore incidental.
    const shuffled = [...index.rows].reverse();
    assert.deepEqual(rankRows(shuffled, query).map((r) => r.id), first,
      'a total tie-break, not sort stability');
  }
});

test('P4bAC9: the score hierarchy is exact > prefix > word-boundary > interior', () => {
  assert.equal(scoreRow({ label: 'status' }, 'status'), SCORE.EXACT);
  assert.equal(scoreRow({ label: 'status' }, 'stat'), SCORE.PREFIX);
  assert.equal(scoreRow({ label: 'index status' }, 'stat'), SCORE.WORD_BOUNDARY);
  assert.equal(scoreRow({ label: 'substatus' }, 'tatu'), SCORE.INTERIOR);
  assert.equal(scoreRow({ label: 'nothing alike' }, 'zzzz'), null, 'a non-match is dropped, not shown last');
});

// --- P4bAC6: nobody types `--` ---------------------------------------------

test('P4bAC6: no palette row asks a person to read or type flag syntax', () => {
  const palette = openPalette({ workspace: process.cwd() });
  assert.ok(palette.rows.length > 0);
  for (const row of palette.rows) {
    assert.equal(containsFlagSyntax(row.label), false,
      `palette row ${JSON.stringify(row.label)} shows flag syntax — the palette is where a capability is CHOSEN, not spelled`);
    for (const prompt of promptsFor(row)) {
      assert.equal(containsFlagSyntax(prompt.label), false,
        `prompt ${JSON.stringify(prompt.label)} asks for flag syntax`);
      assert.equal(prompt.label.startsWith('-'), false, 'a person is asked for the VALUE by name');
    }
  }
});

// --- P4bAC7: the palette and dispatch cannot drift --------------------------

test('P4bAC7: every tui-surfaced command is reachable from the palette', () => {
  const palette = openPalette({ workspace: process.cwd() });
  const reachable = new Set(palette.rows.map((r) => r.argvTokens?.[0]?.value).filter(Boolean));
  const missing = [];
  for (const name of listCommands()) {
    const entry = getCommand(name);
    const surfaces = entry.surfaces || ['cli', 'tui'];
    if (!surfaces.includes('tui')) continue;
    if (!reachable.has(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], 'a command the palette cannot reach is one the TUI user cannot run');
});

test('P4bAC7: every palette row resolves to an argv the CLI actually accepts', () => {
  const palette = openPalette({ workspace: process.cwd() });
  const offenders = [];
  for (const row of palette.rows) {
    // Rows with required values cannot be resolved without them; those are
    // covered by the prompt assertions above. This checks the ones that can.
    const { argv, missing } = resolveSelection(row, {});
    if (missing.length || !argv) continue;
    const [name, ...rest] = argv;
    const entry = getCommand(name);
    if (!entry) { offenders.push(`${row.label} -> unknown command ${name}`); continue; }
    try {
      validateArgs(entry, rest);
    } catch (error) {
      offenders.push(`${row.label} -> ${argv.join(' ')}: ${error.message}`);
    }
  }
  assert.deepEqual(offenders, [], 'the palette must never offer a row the CLI would refuse');
});

// --- the input grammar -----------------------------------------------------

test('the sigils parse, and `!!` wins over `!`', () => {
  assert.deepEqual(interpretLine('/run'), { kind: 'palette', query: 'run' });
  assert.deepEqual(interpretLine('/'), { kind: 'palette', query: '' });
  assert.deepEqual(interpretLine('!ls -a'), { kind: 'shell', script: 'ls -a' });
  // `!!` is RE-RUN, not "run privately". The final design mock rejects pi's
  // reading outright: with no model in the loop there is no context to keep
  // something out of, so the shell's own meaning is the useful one.
  assert.deepEqual(interpretLine('!!'), { kind: 'rerun', target: null });
  assert.deepEqual(interpretLine('!! 5e08c7'), { kind: 'rerun', target: '5e08c7' },
    'the longer sigil must win, or a re-run parses as a shell command starting with `!`');
  assert.equal(interpretLine('!! not an id').kind, 'invalid',
    'anything that is not id-shaped is a mistake worth naming rather than a command worth guessing at');
  assert.deepEqual(interpretLine('@notes.md'), { kind: 'reference', target: 'notes.md' });
  assert.equal(interpretLine('   ').kind, 'empty');
  assert.equal(interpretLine('exit').kind, 'exit');
  assert.deepEqual(interpretLine('status --json'), { kind: 'command', argv: ['status', '--json'] });
});

test('session words work with or without a leading slash', () => {
  // Operators coming from other agent CLIs type /exit and /clear. Shipping
  // those to the palette filter produced "nothing matches" for the session's
  // own words — the same class of failure /help used to have.
  for (const [line, kind] of [
    ['exit', 'exit'], ['quit', 'exit'], ['/exit', 'exit'], ['/quit', 'exit'],
    ['clear', 'clear'], ['/clear', 'clear'],
    ['help', 'help'], ['/help', 'help'], ['?', 'help'], ['/?', 'help'],
  ]) {
    assert.equal(interpretLine(line).kind, kind, line);
  }
  // A real palette filter is still a filter — only reserved words are special.
  assert.deepEqual(interpretLine('/status'), { kind: 'palette', query: 'status' });
  // Shell escape still wins for !clear (even though native clear is preferred).
  assert.deepEqual(interpretLine('!clear'), { kind: 'shell', script: 'clear' });
});

test('tokenize honors quotes but is deliberately not a shell', () => {
  assert.deepEqual(tokenize('search "two words" --limit 5'), ['search', 'two words', '--limit', '5']);
  assert.deepEqual(tokenize("recall 'a b'"), ['recall', 'a b']);
  // No expansion, no substitution, no globbing — the ledger dispatches through
  // the registry, and anything shell-shaped here would misdescribe what runs.
  assert.deepEqual(tokenize('exec $HOME *'), ['exec', '$HOME', '*']);
});

test('the tally counts outcomes apart', () => {
  const tally = createTally();
  tally.record(0);
  tally.record(1);
  tally.record(130, { cancelled: true });
  assert.deepEqual(tally.snapshot(), { commands: 3, ok: 1, failed: 1, cancelled: 1 });
});

// --- P4bAC1 / P4bAC8: one behavior path, and it says what it ran ------------

test('P4bAC1: the ledger dispatches through the registry rather than shelling out', async () => {
  const calls = [];
  const text = await ledger(['status', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1, 'the ledger must call dispatch, not spawn a CLI');
  assert.equal(calls[0][0], 'status');
  assert.match(text, /session/);
});

test('P4bAC8: a palette-initiated run echoes the resolved argv into the ledger', async () => {
  const calls = [];
  const text = await ledger(['/status', '1', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.ok(calls.length >= 1, 'choosing a row must run something');
  assert.match(text, /[>❯] status/,
    'a transcript showing a choice but not the command cannot be replayed or reviewed — the block carries the resolved argv');
});

/**
 * Every dispatched command carries the session's own workspace and home.
 *
 * Without it, `harness tui --workspace B` opened a ledger on B and ran each
 * command against the process cwd — a mutating command could act on a different
 * repository than the session was opened for, silently.
 */
test('the session context reaches every command the ledger dispatches', async () => {
  const calls = [];
  const workspace = tempDir('tui-ctx-');
  await ledger(['status', 'search foo', 'exit'], {
    workspace,
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  for (const argv of calls) {
    assert.ok(argv.includes('--workspace'), `${argv[0]} must carry the session workspace`);
    assert.equal(argv[argv.indexOf('--workspace') + 1], workspace);
  }
});

test('a command that names its own workspace keeps it', async () => {
  const calls = [];
  await ledger(['status --workspace /elsewhere', 'exit'], {
    workspace: tempDir('tui-ctx2-'),
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls[0][calls[0].indexOf('--workspace') + 1], '/elsewhere',
    'an explicit argument is the operator speaking now — the session default must not override it');
});

test('a shell escape is routed through the gated bash command, not spawned directly', async () => {
  const calls = [];
  await ledger(['!echo hi', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls[0][0], 'bash',
    'the shell gate, env allowlist, cwd containment and audit must all apply to a ledger shell-out');
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--')), ['--', 'echo hi'],
    'the script reaches bash unchanged, after the session context');
});

test('an unknown command is answered, not dispatched', async () => {
  const calls = [];
  const text = await ledger(['definitely-not-a-command', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.deepEqual(calls, []);
  assert.match(text, /unknown/);
});

test('the exit ritual prints the tally and how to pick the thread back up', async () => {
  const text = await ledger(['exit'], { dispatcher: async () => 0 });
  assert.match(text, /session/);
  assert.match(text, /resume with: harness tui/);
});

// --- P4bAC4 / P4bAC2 -------------------------------------------------------

test('P4bAC4: the ledger renders through lib/style.mjs and degrades to ASCII', async () => {
  const text = await ledger(['/status', 'exit'], { dispatcher: async () => 0 });
  // `--no-color` is passed in `ledger()`, so the ASCII glyph set is what must
  // appear — and no escape sequences at all.
  assert.equal(text.includes(ESC), false, 'a limited terminal must get no escape sequences');
  assert.match(text, /\[ok\]/, 'the ASCII state token, from style.mjs rather than a local literal');
});

test('P4bAC2: tui declares no output lanes, so --output is refused rather than ignored', () => {
  const res = spawnSync(process.execPath, [binPath, 'tui', '--output', 'json-envelope', '--workspace', tempDir('tui-lane-')], {
    cwd: packageRoot, encoding: 'utf8',
  });
  assert.equal(res.status, EXIT.usage);
  assert.match(res.stdout + res.stderr, /does not support --output/);
});

// --- the session was unusable interactively, and these are the reasons ------

test('an arrow key cannot corrupt the command it precedes', () => {
  const UP = '\u001b[A';
  const DOWN = '\u001b[B';
  // Exactly what the terminal handed us while readline was not doing line
  // editing: the raw bytes for three Up presses, echoed, then the word.
  assert.equal(interpretLine(`${UP}${UP}${UP}exit`).kind, 'exit',
    'this arrived as ^[[A^[[A^[[Aexit and was rejected as an unknown command');
  assert.equal(interpretLine(`${DOWN}status`).kind, 'command');
  assert.deepEqual(interpretLine(`${DOWN}status`).argv, ['status']);
  // A line that is ONLY arrow keys is empty input, not an unknown command —
  // the session reported `unknown` with a blank value for exactly this.
  assert.equal(interpretLine(`${UP}${UP}${DOWN}${DOWN}`).kind, 'empty');
  assert.equal(stripControl('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripControl('a\u0007b\u007f'), 'ab', 'bell and delete are not input either');
});

test('`help` and `/help` answer instead of reporting nothing matches', () => {
  for (const line of ['help', '/help', '?', '/?']) {
    assert.equal(interpretLine(line).kind, 'help',
      `${line} fell through to the palette, which cannot contain \`help\` — it is handled in bin/harness.mjs and never registered`);
  }
});

test('the session renders a visible prompt naming the workspace it acts on', async () => {
  // Asserted against the composer rather than by grepping tui-cmd.mjs for
  // readline options. The old version pinned the shape of an implementation
  // that has since been replaced, which is exactly the kind of test that has to
  // be rewritten instead of read — the behaviour is what was ever at stake.
  const { createComposer } = await import('../lib/tui/composer.mjs');
  const c = createComposer({ width: 60 });
  c.setHint('  deliver · gate ok · shell allowed');
  const block = c.render();
  assert.ok(block.length >= 3, 'the input is a ruled region, not a blank line');
  assert.match(block.join('\n'), /\u276f/, 'with a caret, so a waiting session never reads as a hung one');
  // The workspace moved OFF the editor and onto the header and the footer.
  // Naming it on the editor meant repeating it on every repaint, and the
  // design gives the editor two rules and nothing else.
  assert.match(block.join('\n'), /deliver · gate ok/, 'the editor carries consequence, not identity');
  const { renderFooter } = await import('../lib/tui/chrome.mjs');
  const { plainUi } = await import('./helpers/tty.mjs');
  assert.match(
    renderFooter({ plan: 'x.md', gate: 'pass', run: 'abc123' }, { ui: plainUi(), width: 80 }),
    /plan x\.md/,
    'and the footer names what a command would act on',
  );
});

// --- palette value collection (the ledger was unusable without this) --------

test('required flag prompts keep their required bit from the command index', () => {
  const row = openPalette({ workspace: process.cwd(), query: 'plan-new' }).rows[0];
  const required = promptsFor(row).filter((p) => p.required).map((p) => p.label);
  assert.deepEqual(required, ['type', 'slug', 'intent'],
    'hard-coding required:false made plan-new look optional and the ledger never asked');
});

test('selectionPlan asks for search query and plan-new required flags', () => {
  const search = selectionPlan(openPalette({ workspace: process.cwd(), query: 'search' }).rows[0]);
  assert.equal(search.ready, null);
  assert.deepEqual(search.queue.map((p) => p.label), ['query']);

  const planNew = selectionPlan(openPalette({ workspace: process.cwd(), query: 'plan-new' }).rows[0]);
  assert.deepEqual(planNew.queue.map((p) => p.label), ['type', 'slug', 'intent']);

  const status = selectionPlan(openPalette({ workspace: process.cwd(), query: 'status' }).rows[0]);
  assert.deepEqual(status.ready, ['status']);
});

test('the ledger collects required values from a palette choice and dispatches', async () => {
  const calls = [];
  const text = await ledger(['/search', '1', 'hello world', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1, 'search must run after the query is supplied');
  assert.equal(calls[0][0], 'search');
  assert.ok(calls[0].includes('hello world'), `argv was ${calls[0].join(' ')}`);
  assert.match(text, /[>❯] search/, 'resolved argv is still echoed into the ledger');
  assert.equal(text.includes('not available from a piped session'), false,
    'the previous dead-end message must not appear once collection works');
});

test('the ledger collects plan-new required flags by name, not flag syntax', async () => {
  const calls = [];
  await ledger(['/plan-new', '1', 'feat', 'fix-tui-prompts', 'make the palette ask for values', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'plan-new');
  assert.ok(calls[0].includes('--slug'));
  assert.ok(calls[0].includes('fix-tui-prompts'));
  assert.ok(calls[0].includes('--intent'));
});

test('either/or rows like get stop collecting once resolveSelection accepts', async () => {
  const calls = [];
  // docid left blank, path answered — must not keep asking for lines/max-bytes.
  const text = await ledger(['/get', '1', '', 'README.md', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1, `expected one get, got ${calls.length}: ${JSON.stringify(calls)}`);
  assert.equal(calls[0][0], 'get');
  assert.ok(calls[0].includes('--path'));
  assert.ok(calls[0].includes('README.md'));
  assert.equal(calls[0].includes('--lines'), false, 'untilResolves must not force every optional field');
  assert.match(text, /[>❯] get/);
});

test('the ledger is not offered inside itself, and typing it is still refused', async () => {
  // The palette no longer carries `tui` at all — a row that can only refuse is
  // a row that crowds out one that could act. The typed path keeps its guard,
  // because `tui` remains a real command someone can spell out.
  const { buildCommandIndex } = await import('../lib/command-index.mjs');
  const rows = buildCommandIndex({ surface: 'tui', workspace: process.cwd() }).rows;
  assert.equal(rows.some((r) => r.noun === 'tui'), false, 'no palette row opens the surface you are already in');

  const calls = [];
  const text = await ledger(['tui', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.deepEqual(calls, [], 'opening the ledger from inside the ledger must not dispatch');
  assert.match(text, /already open/);
});

test('exit during value collection cancels the choice without running', async () => {
  const calls = [];
  const text = await ledger(['/search', '1', 'exit', 'status', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'status', 'exit cancels the pending search, then status still runs');
  assert.match(text, /cancelled/);
});

test('/exit closes the session instead of filtering the palette', async () => {
  const text = await ledger(['/exit'], { dispatcher: async () => 0 });
  assert.match(text, /session/);
  assert.match(text, /resume with: harness tui/);
  assert.equal(text.includes('nothing matches'), false);
});

test('clear is a session builtin, not an unknown command', async () => {
  const calls = [];
  const text = await ledger(['clear', 'status', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'status');
  assert.equal(text.includes('unknown'), false, 'clear must not dispatch as a harness command');
  // COUNT the header, do not merely find one. The startup header is printed
  // before `clear` runs, so a substring match passed even with the re-print
  // removed — the assertion could not fail for the reason it named.
  //
  // The marker is the header's own leading dot rather than the version string:
  // at 80 columns a long workspace path clips the right of the header away, so
  // `harness 0.5.0` is not always on it. The dot always is.
  const headers = text.split('\n').filter((l) => /^[●o] /.test(l)).length;
  assert.equal(headers, 2,
    'once at startup and once after clear — otherwise a cleared viewport reads as a session that ended');
});

test('empty Enter after the palette restates how to pick a row', async () => {
  const text = await ledger(['/', '', 'exit'], { dispatcher: async () => 0 });
  assert.match(text, /type 1/);
  assert.match(text, /pick a row/);
  // Piped sessions get the numbered palette: there is no overlay to walk, and
  // the arrow-key form needs a terminal. The interactive path is covered in
  // tui-design.test.mjs and tui-repaint.test.mjs.
});


// --- review findings: replay fidelity and run attribution -------------------

test('!! replays the governed argv of a shell block, not the string that was typed', async () => {
  // `!echo hi` DISPATCHES `bash -- echo hi` and DISPLAYS `!echo hi`. Re-running
  // by re-tokenizing the display string produced `['!echo', 'hi']` and failed as
  // an unknown command, so the one sigil whose whole point is being repeatable
  // was the one that could not be repeated.
  const calls = [];
  await ledger(['!echo hi', '!!', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv.filter((a) => !a.startsWith('--') && a !== process.cwd())); return 0; },
  });
  assert.equal(calls.length, 2, 'the shell command ran, and then ran again');
  assert.deepEqual(calls[1], calls[0], 'the replay is the same argv, not a re-parse of the display string');
  assert.equal(calls[1][0], 'bash', 'and it is still the governed bash, not a bare `!echo`');
});

test('!! <id> resolves a block by id or unique prefix, and says so when it cannot', async () => {
  // Resolution is tested against the store rather than through the piped loop:
  // a scripted session runs with `--no-events`, so its blocks carry no run id
  // and there is nothing on a record line to copy back. What matters is the
  // lookup rule — exact id, then a UNIQUE prefix, and never a guess.
  const { createLedger } = await import('../lib/tui/ledger.mjs');
  // Journaling on, so ids are real run ids — the ones that appear on a record
  // line and that `run tree` also takes. A prefix is only worth supporting on
  // an id someone can actually read off the screen.
  const ledgerStore = createLedger({ workspace: tempDir('tui-byid-'), journaling: true });
  const a = ledgerStore.open({ command: 'verify', argv: ['verify'] });
  const b = ledgerStore.open({ command: '!echo hi', argv: ['bash', '--', 'echo hi'] });

  assert.notEqual(a.id, b.id);
  assert.equal(ledgerStore.byId(a.id)?.command, 'verify', 'an exact id resolves');
  assert.equal(ledgerStore.byId(b.id.slice(0, 12))?.command, '!echo hi', 'so does a unique prefix');
  assert.equal(ledgerStore.byId(b.id.slice(-6))?.command, '!echo hi',
    'and a unique SUFFIX — the record line prints the id tail (#xxxxxx), because the time-ordered head is the colliding part');
  assert.equal(ledgerStore.byId(`#${b.id.slice(-6)}`)?.command, '!echo hi', 'with or without the # sigil');
  assert.equal(ledgerStore.byId('zzzzzzzz'), null, 'and an id that matches nothing resolves to nothing');
  assert.deepEqual(b.argv, ['bash', '--', 'echo hi'],
    'the block keeps the argv that was dispatched, which is what a replay needs');
  assert.equal(ledgerStore.lastCommand().command, '!echo hi',
    'asserted before the ambiguity blocks below are opened, which become the new last command');
  // Ambiguity is a refusal, never a pick: two blocks share a run id's
  // time-ordered head, and guessing between them would replay the wrong one.
  // Constructed ids rather than real ones, so the shared head is guaranteed
  // instead of depending on two `newRunId()` calls landing in the same
  // millisecond.
  const c = ledgerStore.open({ command: 'first', argv: ['first'] });
  const d = ledgerStore.open({ command: 'second', argv: ['second'] });
  c.id = 'shared0head-aaaa'; c.run = c.id;
  d.id = 'shared0head-bbbb'; d.run = d.id;
  assert.equal(ledgerStore.byId('shared0head'), null,
    'a prefix matching two blocks resolves to neither — replaying the wrong one is worse than asking');
  assert.equal(ledgerStore.byId('shared0head-aa')?.command, 'first', 'one more character disambiguates');
  assert.equal(ledgerStore.byId(''), null, 'and an empty id resolves to nothing at all');
});

test('an unknown block id is reported rather than guessed at', async () => {
  const text = await ledger([`!! ${'z'.repeat(8)}`, 'exit'], { dispatcher: async () => 0 });
  assert.match(text, /no block with that id in this session/);
});

/** The shared `ledger` helper passes `--no-events`, which turns journaling off
 * for the whole session — correct for grammar tests, and blinding for these
 * two. They run their own session with journaling ON in a temp workspace. */
async function journalingLedger(lines, { workspace, dispatcher }) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({ input, output, workspace, argv: ['--no-color'], dispatcher });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return text;
}

const readRuns = (workspace) => {
  const file = path.join(workspace, '.harness', 'runs.jsonl');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
};

test('a TUI dispatch carries its own run into the event registry', async () => {
  // Every command in the ledger opens its own run. Dispatching without that
  // run's registry wrote events with no run at all, so `run show` for a command
  // typed in the TUI came back empty and its domain events were attributed to
  // the outer `tui` invocation instead. Journaling is ON here — the shared
  // helper disables it, which made the previous version of this test unable to
  // fail for the reason it named.
  const workspace = tempDir('tui-events-');
  let ctx = null;
  await journalingLedger(['status', 'exit'], {
    workspace,
    dispatcher: async (_argv, received) => {
      ctx = received;
      // The registry calls this once validation passes; the stub stands in.
      received.onRunStart?.();
      return 0;
    },
  });
  assert.ok(ctx, 'the command dispatched');
  assert.ok(ctx.events, 'the dispatch carries the run’s own event registry');
  assert.equal(typeof ctx.onRunStart, 'function',
    'the run record is deferred past validation, exactly as bin/harness.mjs defers it');
  assert.equal(typeof ctx.reportStatus, 'function',
    'and the command can report its own status, which beats reverse-mapping an exit code');

  const runs = readRuns(workspace);
  const starts = runs.filter((r) => r.type === 'run.start' && r.command === 'status');
  const results = runs.filter((r) => r.type === 'run.result');
  assert.equal(starts.length, 1, 'the command opened exactly one run');
  assert.ok(results.some((r) => r.run === starts[0].run && r.status === 'succeeded'),
    'and closed it with a terminal status');
});

test('a refused command journals no run — while an accepted one does', async () => {
  // `openRun` is deferred until validation passes. The CONTROL COMMAND is the
  // point: with journaling disabled (as the previous version had it), an empty
  // journal proved the flag rather than the refusal. `status` journaling in the
  // same session proves the journal was live and the unknown command still
  // left nothing.
  const workspace = tempDir('tui-refused-');
  await journalingLedger(['definitely-not-a-command', 'status', 'exit'], {
    workspace,
    dispatcher: async (_argv, received) => { received.onRunStart?.(); return 0; },
  });
  const runs = readRuns(workspace);
  const starts = runs.filter((r) => r.type === 'run.start');
  assert.equal(starts.length, 1, `only the accepted command opened a run: ${JSON.stringify(starts.map((r) => r.command))}`);
  assert.equal(starts[0].command, 'status');
  assert.ok(!starts.some((r) => r.command === 'definitely-not-a-command'),
    'a command refused before dispatch never reaches the journal');
});
