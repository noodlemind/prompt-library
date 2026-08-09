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
import { containsFlagSyntax, openPalette, promptsFor, resolveSelection } from '../lib/tui/palette.mjs';
import { createTally, interpretLine, tokenize } from '../lib/tui/session.mjs';
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
  const done = runLedger({ input, output, workspace, argv: ['--no-color'], dispatcher });
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
  assert.deepEqual(interpretLine('!ls -a'), { kind: 'shell', script: 'ls -a', private: false });
  assert.deepEqual(interpretLine('!!ls -a'), { kind: 'shell', script: 'ls -a', private: true },
    'the longer sigil must win, or the private form parses as the public one');
  assert.deepEqual(interpretLine('@notes.md'), { kind: 'reference', target: 'notes.md' });
  assert.equal(interpretLine('   ').kind, 'empty');
  assert.equal(interpretLine('exit').kind, 'exit');
  assert.deepEqual(interpretLine('status --json'), { kind: 'command', argv: ['status', '--json'] });
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
  assert.deepEqual(calls, [['status']], 'the ledger must call dispatch, not spawn a CLI');
  assert.match(text, /session/);
});

test('P4bAC8: a palette-initiated run echoes the resolved argv into the ledger', async () => {
  const calls = [];
  const text = await ledger(['/status', '1', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.ok(calls.length >= 1, 'choosing a row must run something');
  assert.match(text, /\$ harness status/,
    'a transcript showing a choice but not the command cannot be replayed or reviewed');
});

test('a shell escape is routed through the gated bash command, not spawned directly', async () => {
  const calls = [];
  await ledger(['!echo hi', 'exit'], {
    dispatcher: async (argv) => { calls.push(argv); return 0; },
  });
  assert.deepEqual(calls[0], ['bash', '--', 'echo hi'],
    'the shell gate, env allowlist, cwd containment and audit must all apply to a ledger shell-out');
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
  assert.match(text, /resume with: harness run list/);
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
