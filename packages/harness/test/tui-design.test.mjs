/**
 * The Session Ledger's design contract, as executable assertions.
 *
 * WHY THIS FILE IS THE POINT. Phase 4b shipped a four-sided rounded box while
 * the approved design said "two hairlines, tints rather than borders", and nine
 * acceptance criteria stayed green through it — because not one of them
 * described the surface. The criteria had been derived from a phase list and
 * never reconciled against the design, so "all tests pass" and "the design was
 * built" were unrelated statements.
 *
 * Every assertion below names the commitment it protects, in the design's own
 * words. If a future change wants a box back, it has to delete a test that says
 * why there isn't one.
 *
 * Source of record: the approved mock (§7 "What this commits the build to"),
 * `~/.gstack/projects/noodlemind-prompt-library/designs/harness-tui-20260731/`
 * (`approved.json`, `research.md`), and §Interactive TUI of
 * `docs/architecture/harness-cli-workbench.md`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComposer } from '../lib/tui/composer.mjs';
import { createBlock, renderBlock, foldState, formatDuration, recordSegments } from '../lib/tui/block.mjs';
import { renderHeader, renderHint, renderFooter, twoColumn } from '../lib/tui/chrome.mjs';
import { createOverlay, renderOverlay, renderPaletteRows, splitPrefix, applyPrefix } from '../lib/tui/overlay.mjs';
import { createStyle } from '../lib/style.mjs';
import { displayWidth } from '../lib/tui/width.mjs';
import { plainUi } from './helpers/tty.mjs';

const ui = plainUi();
const ascii = plainUi({ unicode: false });

// ── "the persistent chrome is a two-hairline editor" ────────────────────

test('DESIGN: the composer is two hairlines — no verticals, no corners', () => {
  const composer = createComposer({ width: 40 });
  const rows = composer.render();

  assert.equal(rows.length, 3, 'a rule, the input line, a rule — nothing else');
  assert.match(rows[0], /^─+$/, 'the top is a plain rule spanning the width');
  assert.match(rows[2], /^─+$/, 'and so is the bottom');
  assert.equal(displayWidth(rows[0]), 40, 'the rule spans the full width');

  const box = /[│|╭╮╰╯┌┐└┘]/;
  for (const row of rows) {
    assert.doesNotMatch(row, box,
      `"${row}" contains box drawing — the design rejected panel chrome in terminals, and four dashboard variants were rejected before the research round that settled this`);
  }
});

test('DESIGN: the hairlines carry the gate state, which is a channel and not decoration', () => {
  const painted = [];
  const composer = createComposer({
    width: 20,
    paint: (token, text) => { painted.push(token); return text; },
  });
  composer.setGate('blocked');
  composer.render();
  assert.ok(painted.includes('warn'), 'a blocked gate paints the rules warn');

  painted.length = 0;
  composer.setGate('pass');
  composer.render();
  assert.ok(painted.includes('ok'), 'a passing gate paints them ok');

  painted.length = 0;
  composer.setGate(null);
  composer.render();
  assert.ok(painted.includes('muted') && !painted.includes('ok'),
    'an UNKNOWN gate is muted, never green — an unverified gate is not a passing one');
});

test('DESIGN: the ASCII twin is still two rules', () => {
  const rows = createComposer({ width: 24, ascii: true }).render();
  assert.match(rows[0], /^-+$/);
  assert.match(rows[2], /^-+$/);
  assert.match(rows[1], /^> /, 'and the caret degrades to `>`');
});

// ── "a block is a record, not a rendering" ──────────────────────────────

test('DESIGN: a block renders four parts — command, record line, output, tally', () => {
  const block = createBlock({
    command: 'checks run build-assets',
    status: 'failed',
    exit: 6,
    durationMs: 12_000,
    actor: 'you',
    startedAt: '2026-08-10T14:07:03Z',
    lines: ['✗ E_ASSET_BUILD', '  asset manifest references a retired skill wrapper'],
    tally: '1 err → exit 6',
    next: 'patch fix-manifest.patch',
  });
  const rows = renderBlock(block, { ui, width: 78 });
  const text = rows.join('\n');

  assert.match(text, /❯ checks run build-assets/, 'the command, verbatim');
  assert.match(text, /failed · exit 6 · 0m12s · you/, 'the journal entry made visible');
  assert.match(text, /E_ASSET_BUILD/, 'the output');
  assert.match(text, /1 err → exit 6 → patch fix-manifest\.patch/, 'the tally and the one action that follows');
});

test('DESIGN: failure is encoded more than once, so it survives ASCII and a screenshot', () => {
  const block = createBlock({ command: 'verify', status: 'failed', exit: 1, lines: ['[x] E_FAILED'] });

  // Channel 1: the painted stripe, present at any colour depth.
  const stripes = [];
  const stripeUi = { ...ascii, stripe: (state) => { stripes.push(state); return '|'; } };
  renderBlock(block, { ui: stripeUi, width: 60 });
  assert.deepEqual([...new Set(stripes)], ['failed'], 'every row carries the failed stripe');

  // Channel 2: the word, in plain text, with no colour at all.
  const rows = renderBlock(block, { ui: ascii, width: 60 });
  assert.match(rows.join('\n'), /\bfailed\b/,
    'the status word is text — it survives a screen reader, a screenshot and a monochrome terminal');
});

test('DESIGN: the record line omits what it does not know rather than saying "unknown"', () => {
  const segments = recordSegments(createBlock({ status: 'ok', exit: null, durationMs: null, actor: null, startedAt: 'not-a-date' }));
  assert.deepEqual(segments.map((s) => s.text), ['ok'],
    'a row that says `exit —` invites the reader to wonder what broke in the lookup');
});

test('DESIGN: `failed` is muted while `ok` is green — colour goes where attention is owed', () => {
  const failed = recordSegments(createBlock({ status: 'failed' }))[0];
  const ok = recordSegments(createBlock({ status: 'ok' }))[0];
  assert.equal(failed.token, 'muted',
    'a failed block already carries a red tint, a red stripe and a red glyph; a fourth red thing is louder, not clearer');
  assert.equal(ok.token, 'ok');
});

test('DESIGN: long output folds, and ctrl+o is an answer to the heuristic rather than a re-run of it', () => {
  const long = createBlock({ command: 'verify', status: 'ok', lines: Array.from({ length: 40 }, (_, i) => `row ${i}`) });
  assert.equal(foldState(long).folded, true, 'past the threshold a block folds by default');
  assert.match(renderBlock(long, { ui, width: 60 }).join('\n'), /… 34 more lines \(ctrl\+o\)/);

  long.folded = false;
  assert.equal(foldState(long).folded, false, 'an explicit unfold beats the threshold');
  const short = createBlock({ command: 'x', status: 'ok', lines: ['one'] });
  short.folded = true;
  assert.equal(foldState(short).folded, false, 'and folding cannot hide a block shorter than the head');
});

test('DESIGN: a tinted row spans the full width, or it is a highlight on text rather than a block', () => {
  const tinted = createStyle({
    stream: { isTTY: true }, env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, argv: [], platform: 'darwin',
  });
  const rows = renderBlock(createBlock({ command: 'ok', status: 'ok', lines: [] }), { ui: tinted, width: 50 });
  for (const row of rows) {
    assert.match(row, /^\x1b\[48;2;/, 'each row opens its own background');
    assert.match(row, /\x1b\[0m$/, 'and closes it — a background left open at a line end paints the rest of the screen');
    assert.equal(displayWidth(row), 50, 'padded to the full width');
  }
});

test('DESIGN: the contrast floor turns the tint off and keeps every other channel', () => {
  const floor = createStyle({
    stream: { isTTY: true }, env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, argv: [], platform: 'darwin',
    tintMode: 'off',
  });
  assert.equal(floor.tints, false);
  const rows = renderBlock(createBlock({ command: 'verify', status: 'failed', exit: 1 }), { ui: floor, width: 50 });
  const text = rows.join('\n');
  assert.doesNotMatch(text, /\x1b\[48;/, 'nothing is painted over the operator’s own background');
  assert.match(floor.stripAnsi(text), /▌/, 'the stripe stays');
  assert.match(floor.stripAnsi(text), /\bfailed\b/, 'and so does the word');
});

test('DESIGN: 256-colour keeps greyscale separation instead of inventing a saturated approximation', () => {
  const c256 = createStyle({
    stream: { isTTY: true }, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, argv: [], platform: 'darwin',
  });
  const row = renderBlock(createBlock({ command: 'x', status: 'failed' }), { ui: c256, width: 40 })[0];
  assert.match(row, /\x1b\[48;5;\d+m/, 'a 256-colour background');
  assert.doesNotMatch(row, /\x1b\[48;2;/, 'never a truecolour one the terminal did not declare');
});

// ── chrome: header once, hint and footer persistent ─────────────────────

test('DESIGN: the header is a two-line identity block printed once', () => {
  // Line one is WHERE — workspace, branch, commit. Line two is WHAT — the
  // tool and the lifecycle. The field gives identity vertical room (Claude
  // Code three lines, Codex a panel); one dense line read as data, not
  // presence. Still printed into scrollback, never pinned.
  const rows = renderHeader({
    ui, width: 100, workspace: '~/repo', branch: 'main', commit: '9f2c1e4', version: '2.0.0',
    plan: 'phase1-core.md', gate: 'blocked',
  });
  assert.equal(rows.length, 3, 'two lines and a blank');
  assert.match(rows[0], /~\/repo/);
  assert.match(rows[0], /main @ 9f2c1e4/);
  assert.match(rows[1], /harness 2\.0\.0/);
  assert.match(rows[1], /plan phase1-core\.md/);
  assert.match(rows[1], /gate blocked/);
  assert.equal(rows[2], '');
});

test('DESIGN: the hint row states consequence — and the gate is not repeated here', () => {
  const row = renderHint({ ui, width: 120, mode: 'deliver', gate: 'pass', shell: 'allowed', rerun: 'verify' });
  assert.match(row, /deliver/, 'the mode');
  assert.match(row, /shell allowed/, 'whether the shell is available');
  assert.match(row, /!! re-runs verify/, 'what !! would repeat');
  assert.match(row, /↵ run/, 'what Enter does');
  assert.match(row, /ctrl\+d exit/, 'and the way out');
  assert.doesNotMatch(row, /gate/,
    'the gate was stated three times; its textual home is the footer and its ambient home is the hairline tint');
});

test('DESIGN: the hint drops keys before it drops posture — posture is what changes', () => {
  const narrow = renderHint({ ui, width: 26, shell: 'denied' });
  assert.match(narrow, /deliver/);
  assert.match(narrow, /shell denied/);
  assert.doesNotMatch(narrow, /interrupt/, 'the keys are learned once; the posture changes under you');
  assert.ok(displayWidth(narrow) <= 26);
});

test('DESIGN: the footer is two columns and drops the right one first', () => {
  const snapshot = { plan: 'phase1-core', planLocked: true, gate: 'pass', run: '9a12f4', runStatus: 'ok', tests: '930 tests', learnings: '34 learnings', generation: '8c31f0' };
  const wide = renderFooter(snapshot, { ui, width: 120 });
  assert.match(wide, /plan phase1-core/);
  assert.match(wide, /gate ok/);
  assert.match(wide, /930 tests/);
  assert.match(wide, /gen 8c31f0/);

  const narrow = renderFooter(snapshot, { ui, width: 44 });
  assert.match(narrow, /plan phase1-core/, 'lifecycle survives');
  assert.doesNotMatch(narrow, /930 tests/, 'scale is dropped whole rather than truncated into a wrong number');
});

test('DESIGN: the footer order is the setting, not an accident', () => {
  const snapshot = { plan: 'p', gate: 'pass', run: 'r' };
  const gateFirst = renderFooter(snapshot, { ui, width: 120, items: ['gate', 'plan', 'run'] });
  assert.ok(gateFirst.indexOf('gate') < gateFirst.indexOf('plan p'));
});

test('DESIGN: two columns never collide, and the right one is never half-printed', () => {
  // Wide enough for both: they share the row with a gap between them.
  const roomy = twoColumn('left', 'right-hand-side', 40);
  assert.ok(displayWidth(roomy) <= 40);
  assert.match(roomy, /left {2,}right-hand-side/, 'both columns, pushed apart');

  // Too narrow: the RIGHT column goes whole. Half of `right-hand-side` reads as
  // a different value, and a value that is quietly wrong is worse than absent.
  const tight = twoColumn('left'.padEnd(30), 'right-hand-side', 40);
  assert.ok(displayWidth(tight) <= 40);
  assert.doesNotMatch(tight, /right/, 'dropped entirely rather than truncated');
  assert.match(tight, /^left/, 'and the left column survives intact');
});

// ── overlays: summoned, never resident ──────────────────────────────────

test('DESIGN: an overlay is arrow-navigable — the palette is not a numbered menu', () => {
  const overlay = createOverlay({
    rows: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
    footer: 'esc closes',
  });
  assert.equal(overlay.selected.label, 'a');
  overlay.handleKey(null, { name: 'down' });
  assert.equal(overlay.selected.label, 'b', '↑↓ walk the rows (P4bAC13)');
  overlay.handleKey(null, { name: 'up' });
  overlay.handleKey(null, { name: 'up' });
  assert.equal(overlay.selected.label, 'c', 'and wrap');
  assert.equal(overlay.handleKey(null, { name: 'return' }).intent, 'choose');
  assert.equal(overlay.handleKey(null, { name: 'escape' }).intent, 'close');
});

test('DESIGN: an unavailable row stays listed, selectable, and carries its reason', () => {
  const overlay = createOverlay({
    rows: [{ label: 'gate', unavailable: 'no plan under docs/plans/' }, { label: 'verify' }],
  });
  const rows = renderOverlay(overlay, { ui, width: 80 });
  assert.match(rows.join('\n'), /no plan under docs\/plans\//,
    'a capability that silently disappears teaches that it does not exist');
  overlay.handleKey(null, { name: 'down' });
  assert.equal(overlay.selected.label, 'verify', 'navigation does not skip past the reason');
});

test('DESIGN: every palette row shows its side-effect class before it runs', () => {
  const overlay = createOverlay({ rows: [{ label: 'bash', sideEffect: 'execute' }] });
  assert.match(renderOverlay(overlay, { ui, width: 80 }).join('\n'), /execute/,
    'the registry declares it per command, so the consequence is visible before the choice');
});

test('DESIGN: typed prefixes narrow one flat namespace rather than adding a grammar', () => {
  assert.deepEqual(splitPrefix('run:resume'), { prefix: 'run', rest: 'resume' });
  assert.deepEqual(splitPrefix('docs/a:b'), { prefix: null, rest: 'docs/a:b' },
    'a colon that is not a declared namespace is left alone');
  const rows = [{ noun: 'run', label: 'run list' }, { noun: 'search', label: 'search' }];
  assert.deepEqual(applyPrefix(rows, 'run').map((r) => r.label), ['run list']);
  assert.equal(applyPrefix(rows, null).length, 2);
});

test('DESIGN: an action overlay takes keys as commands and never as filter text', () => {
  const overlay = createOverlay({
    rows: [{ label: 'verify', block: { id: 'abc' } }],
    actions: { y: 'copy', m: 'mark', r: 'rerun' },
  });
  const result = overlay.handleKey('r', { name: 'r' });
  assert.equal(result.intent, 'action');
  assert.equal(result.action, 'rerun');
  assert.equal(overlay.query, '', 'a surface cannot decide whether `r` meant re-run or the letter r, so it never guesses');
});

test('DESIGN: filtering happens inside the overlay, so a keystroke costs a repaint and not a round trip', () => {
  const calls = [];
  const overlay = createOverlay({
    rows: [{ label: 'a' }],
    filter: (q) => { calls.push(q); return [{ label: q }]; },
  });
  overlay.handleKey('x', { name: 'x' });
  assert.deepEqual(calls, ['x']);
  assert.equal(overlay.selected.label, 'x');
});

// ── measurement ─────────────────────────────────────────────────────────

test('DESIGN: width is measured in cells, so CJK and emoji do not break the rules', () => {
  assert.equal(displayWidth('日本語'), 6, 'wide characters take two cells each');
  assert.equal(displayWidth('é'), 1, 'a combining mark takes none');
  assert.equal(displayWidth('👩‍💻'), 2, 'a ZWJ sequence is one glyph');
  assert.equal(displayWidth('\x1b[31mred\x1b[0m'), 3, 'colour is not content');
});

test('DESIGN: a composer holding wide text still draws a full-width rule', () => {
  const composer = createComposer({ width: 30 });
  for (const ch of '日本語です') composer.handleKey(ch, { name: ch });
  const rows = composer.render();
  assert.equal(displayWidth(rows[0]), 30);
  assert.equal(displayWidth(rows[rows.length - 1]), 30,
    'the previous version measured code points, so this rule came out short by one cell per wide character');
});

test('DESIGN: the cursor is placed in cells, not in code points', () => {
  const composer = createComposer({ width: 40 });
  for (const ch of '日本') composer.handleKey(ch, { name: ch });
  assert.equal(composer.cursor.col, 2 + 4, 'caret gutter plus four cells for two wide characters');
});

test('DESIGN: duration reads as elapsed time, not as a clock', () => {
  assert.equal(formatDuration(12_000), '0m12s');
  assert.equal(formatDuration(161_000), '2m41s');
  assert.equal(formatDuration(4_380_000), '73m00s', 'minutes never roll into hours you have to subtract');
  assert.equal(formatDuration(null), null);
});


// ── the whole region, drawn onto a modelled screen ──────────────────────

test('DESIGN: a session paints header, blocks, editor, hint and footer, in that order', async () => {
  // The closest a pty-less suite gets to a screenshot. `helpers/tty.mjs` models
  // the cursor and the SGR state, so this asserts what is ON SCREEN rather than
  // which bytes were written — the distinction the phase-4b reopening turned on.
  const { createInput } = await import('../lib/tui/input.mjs');
  const { PassThrough } = await import('node:stream');
  const { fakeTty } = await import('./helpers/tty.mjs');
  const { createStyle } = await import('../lib/style.mjs');

  const styled = createStyle({
    stream: { isTTY: true }, env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, argv: [], platform: 'darwin',
  });
  const output = fakeTty({ columns: 90 });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const session = createInput({ input, output, ui: styled });

  session.commit(renderHeader({ ui: styled, width: 90, workspace: '~/repo', branch: 'main', version: '0.5.0' }));
  session.commit(renderBlock(
    createBlock({ command: 'verify', status: 'failed', exit: 1, durationMs: 2000, lines: ['E_CHECK'], tally: '1 err' }),
    { ui: styled, width: 90 },
  ));
  session.setStatus({ plan: 'phase1.md', gate: 'blocked', run: 'abc123', runStatus: 'failed' });

  const lines = output.lines;
  const at = (needle) => lines.findIndex((l) => styled.stripAnsi(l).includes(needle));
  assert.equal(at('~/repo'), 0, 'the header is printed once, at the top');
  assert.ok(at('verify') > at('~/repo'), 'blocks follow it');
  assert.ok(at('failed · exit 1') > at('verify'), 'each block carries its record line');
  const editorAt = lines.findIndex((l) => /^─{10,}$/.test(styled.stripAnsi(l)));
  assert.ok(editorAt > at('1 err'), 'the editor sits below every committed block');
  assert.ok(at('gate blocked') > editorAt, 'the hint and footer sit below the editor');

  // The colour channel, read back off the modelled screen rather than off the
  // string that produced it.
  const blockRow = at('verify');
  assert.deepEqual(output.backgroundsAt(blockRow), ['48;2;34;30;33'],
    'the failed block is tinted, and tinted with the failed colour');
  assert.deepEqual(output.backgroundsAt(0), [null], 'the header is not');
  session.close();
});

test('DESIGN: the tint covers every cell of a block row, not just the first one', async () => {
  // THE BUG THIS PINS. `paint` closed every coloured fragment with SGR 0, which
  // resets the background as well as the foreground. The first painted thing in
  // a block row is the stripe, at column 0 — so a "tinted" block was tinted for
  // exactly one cell and the rest of the row fell back to the terminal's own
  // ground. Every string-level assertion passed: the opening `48;2;…` was
  // present, the row was the right width, and the closing `0m` was there.
  // Only a per-cell reading of a modelled screen could see it.
  const { createInput } = await import('../lib/tui/input.mjs');
  const { PassThrough } = await import('node:stream');
  const { fakeTty } = await import('./helpers/tty.mjs');
  const { createStyle } = await import('../lib/style.mjs');

  const styled = createStyle({
    stream: { isTTY: true }, env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, argv: [], platform: 'darwin',
  });
  const columns = 70;
  const output = fakeTty({ columns });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const session = createInput({ input, output, ui: styled });

  session.commit(renderBlock(
    createBlock({ command: 'verify', status: 'ok', exit: 0, lines: ['one', 'two'], tally: '2 ok' }),
    { ui: styled, width: columns },
  ));

  const rows = output.lines
    .map((_, i) => i)
    .filter((i) => ['verify', 'one', 'two', '2 ok'].some((needle) => styled.stripAnsi(output.lines[i]).includes(needle)));
  assert.ok(rows.length >= 2, 'the block reached the screen');
  for (const row of rows) {
    const backgrounds = output.backgroundsAt(row);
    assert.deepEqual(backgrounds, ['48;2;26;32;33'],
      `row ${row} has a gap in its tint: ${JSON.stringify(backgrounds)} — a fragment closed with SGR 0 instead of SGR 39`);
  }
  session.close();
});

// ── review round 2: the ones a per-cell reading found ───────────────────

test('DESIGN: clip and wrap measure the same string the same way as displayWidth', async () => {
  // `displayWidth` strips ANSI before measuring; `clipTo` and `wrapCells` did
  // not, so `clusterWidth` dropped the ESC as a control character and counted
  // the remaining `[38;2;134;201;154m` as eighteen cells. A painted row that
  // measured as fitting was cut a third of the way through, and the cut landed
  // inside the escape — leaving the colour open for the rest of the terminal.
  const { clipTo: clip, wrapCells: wrap } = await import('../lib/tui/width.mjs');
  const painted = '\x1b[38;2;134;201;154m✓\x1b[39m ok status line here';
  assert.equal(displayWidth(painted), 21, 'colour is not content');
  assert.equal(displayWidth(clip(painted, 10)), 10, 'a clip lands where it was asked to');
  for (const row of wrap(painted, 8)) {
    assert.ok(displayWidth(row) <= 8, `wrapped row is ${displayWidth(row)} cells: ${JSON.stringify(row)}`);
  }
  assert.deepEqual(wrap('日本語です', 4).map(displayWidth), [4, 4, 2], 'and wide clusters still never split');
});

test('DESIGN: nothing inside a tinted row closes with SGR 0', async () => {
  // The clip and wrap helpers run INSIDE a tinted row, so a `0m` closer of
  // their own resets the background `tintRow` wrapped around them — the same
  // defect as the original, one layer down.
  const { clipTo: clip, wrapCells: wrap } = await import('../lib/tui/width.mjs');
  const painted = '\x1b[38;2;134;201;154mabcdefghij\x1b[39m';
  assert.doesNotMatch(clip(painted, 4), /\x1b\[0m/, 'clip closes the foreground only');
  for (const row of wrap(painted, 4)) {
    assert.doesNotMatch(row, /\x1b\[0m/, 'and so does every wrapped row');
  }
});

test('DESIGN: the 256-colour tint follows the ground it was told about', async () => {
  const { createStyle: mk } = await import('../lib/style.mjs');
  const dark = mk({ stream: { isTTY: true }, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, argv: [], platform: 'darwin', tintMode: 'dark' });
  const light = mk({ stream: { isTTY: true }, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, argv: [], platform: 'darwin', tintMode: 'light' });
  const idxOf = (ui2) => Number(/\x1b\[48;5;(\d+)m/.exec(ui2.tintRow('failed', 'x'))[1]);
  assert.ok(idxOf(dark) < 240, 'the dark ground uses the bottom of the greyscale ramp');
  assert.ok(idxOf(light) > 240,
    'and the light ground the top — one shared dark index painted a near-black band across a light profile');
});

test('DESIGN: an over-long overlay label is clipped rather than breaking the border', () => {
  const overlay = createOverlay({
    rows: [{ label: 'knowledge promote branch '.repeat(6).trim(), sideEffect: 'mutate', summary: 'x' }],
  });
  for (const row of renderOverlay(overlay, { ui, width: 40, maxWidth: 40 })) {
    assert.ok(displayWidth(row) <= 40, `overlay row is ${displayWidth(row)} cells wide: ${row}`);
    if (row.startsWith('│')) assert.ok(row.endsWith('│'), `border broken: ${row}`);
  }
});

test('DESIGN: `@` reports no reference when the cursor sits before the sigil', () => {
  const composer = createComposer({ width: 40 });
  for (const ch of '@docs') composer.handleKey(ch, { name: ch });
  assert.ok(composer.reference, 'mid-token there is a reference');
  composer.handleKey(null, { name: 'home' });
  assert.equal(composer.reference, null,
    'at column 0 there is nothing behind the cursor — completing here spliced the path in FRONT of the token');
});

test('DESIGN: the screen model consumes an escape it does not implement', async () => {
  // It used to slice zero bytes and loop forever, which hangs the test process
  // rather than failing a test — CI blocked instead of reporting.
  const { fakeTty } = await import('./helpers/tty.mjs');
  const out = fakeTty({ columns: 20 });
  out.write('a\x1b7b\x1b]0;title\x07c\n');
  assert.match(out.lines[0], /a/, 'the surrounding text still lands');
  assert.ok(out.unknownEscapes.length > 0, 'and the unmodelled sequence is reported rather than swallowed');
});

// ── consistency: one surface, one treatment ─────────────────────────────

test('CONSISTENCY: the footer carries the workspace before AND after lifecycle facts exist', () => {
  // The footer used to fall back to a different renderer until the first
  // command ran, then switch shape and drop the workspace entirely — the same
  // surface, two treatments, and the lost fact was the one that decides which
  // repository every block above acted on.
  const before = renderFooter({ workspace: '~/repo', branch: 'main' }, { ui, width: 90 });
  const after = renderFooter({ workspace: '~/repo', branch: 'main', plan: 'x.md', gate: 'pass', run: 'abc123' }, { ui, width: 90 });
  assert.match(before, /~\/repo/, 'a fresh session names its workspace');
  assert.match(after, /~\/repo/, 'and it stays named once lifecycle facts arrive');
  assert.match(after, /plan x\.md/, 'alongside them, not instead of them');
});

test('CONSISTENCY: clipping the footer drops lifecycle before it ever drops the workspace', () => {
  const tight = renderFooter(
    { workspace: '~/repo', branch: 'main', plan: 'a-plan.md', gate: 'pass', run: 'abc123' },
    { ui, width: 26 },
  );
  assert.match(tight, /~\/repo/, 'the workspace is the last thing standing');
  assert.doesNotMatch(tight, /run abc123/, 'lifecycle gives way from the right');
  assert.ok(displayWidth(tight) <= 26);
});

test('CONSISTENCY: blocks are separated by untinted ground by default', async () => {
  // Two consecutive ok blocks carry identical tints; without a gap they read
  // as one block. The mock separates every block with untinted ground
  // (`.blk+.blk{margin-top:9px}`) — one blank row is the terminal equivalent,
  // so it is the default and `tui.density=compact` is the zero-gap opt-in.
  const { CONFIG_SCHEMA } = await import('../lib/config.mjs');
  assert.equal(CONFIG_SCHEMA['tui.density'].default, 'comfortable');

  const { runLedger } = await import('../lib/tui-cmd.mjs');
  const { PassThrough } = await import('node:stream');
  // `config` passed explicitly so the assertion is about the setting's effect,
  // not about whatever config the machine running the suite happens to have.
  const transcript = async (config) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => { text += c.toString(); });
    const done = runLedger({
      input, output, workspace: process.cwd(), argv: ['--no-color', '--no-events'],
      dispatcher: async () => 0, config,
    });
    input.write('status\nstatus\nexit\n');
    input.end();
    await done;
    return text;
  };

  const comfy = (await transcript({ 'tui.density': 'comfortable' })).split('\n');
  const carets = comfy.map((l, i) => [l, i]).filter(([l]) => /^[▌|] [>❯] status/.test(l)).map(([, i]) => i);
  assert.equal(carets.length, 2, `two blocks expected:\n${comfy.slice(0, 20).join('\n')}`);
  assert.ok(comfy.slice(carets[0] + 1, carets[1]).some((l) => l.trim() === ''),
    'an untinted blank row separates consecutive blocks — without it two same-state blocks read as one');

  const dense = (await transcript({ 'tui.density': 'compact' })).split('\n');
  const denseCarets = dense.map((l, i) => [l, i]).filter(([l]) => /^[▌|] [>❯] status/.test(l)).map(([, i]) => i);
  assert.equal(denseCarets.length, 2);
  assert.ok(!dense.slice(denseCarets[0] + 1, denseCarets[1]).some((l) => l.trim() === ''),
    'and compact is the zero-gap opt-in, so the setting demonstrably reaches the surface');
});

test('CONSISTENCY: a message is plain rows — only a block carries the stripe', async () => {
  // `help` used to render as eleven one-row note blocks, each with a stripe
  // and a tint, while the startup shortcuts line rendered plain: the same
  // class of content, two treatments. A stripe now means exactly one thing —
  // "this is a record of something that ran".
  const { runLedger } = await import('../lib/tui-cmd.mjs');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({
    input, output, workspace: process.cwd(), argv: ['--no-color', '--no-events'],
    dispatcher: async () => 0,
  });
  input.write('help\nstatus\nexit\n');
  input.end();
  await done;
  const lines = text.split('\n');
  const helpRows = lines.filter((l) => /open the command palette|re-run the previous block|governed bash/.test(l));
  assert.ok(helpRows.length >= 3, 'the help rows rendered');
  for (const row of helpRows) {
    assert.doesNotMatch(row, /^[▌|]/, `a message row carries no stripe: ${JSON.stringify(row)}`);
  }
  assert.ok(lines.some((l) => /^[▌|] [>❯] status/.test(l)), 'while a command block still does');

  // And the help columns align — the first row used the default gutter while
  // the rest used an explicit one, so the columns stepped after line one.
  const starts = new Set(helpRows.map((l) => l.search(/open the|re-run the|run a shell/)));
  assert.equal(starts.size, 1, `help value columns align: ${[...starts].join(', ')}`);
});

test('CONSISTENCY: a successful block does not restate its record line as a tally', async () => {
  const { runLedger } = await import('../lib/tui-cmd.mjs');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({
    input, output, workspace: process.cwd(), argv: ['--no-color', '--no-events'],
    // Through the INJECTED stream, which is what `capture` hooks — a
    // `console.log` here writes to process.stdout, bypasses the capture, and
    // leaves the block empty, so the tally assertion below would hold
    // vacuously for a block with no output at all.
    dispatcher: async () => { output.write('one line of output\n'); return 0; },
  });
  input.write('status\nexit\n');
  input.end();
  await done;
  assert.match(text, /one line of output/, 'the block carried the output the tally is about');
  assert.doesNotMatch(text, /1 line (→|->) exit 0/,
    '`N lines → exit 0` under `ok · exit 0` said the exit twice — a tally must add something');
  assert.match(text, /ok · exit 0/, 'the record line still carries the outcome');
});

test('CONSISTENCY: the completion list sits under the editor, and the hint row stays last', () => {
  const composer = createComposer({ width: 60 });
  composer.setHint('  deliver · shell allowed');
  composer.setCompletion([{ path: 'docs/', kind: 'dir' }, { path: 'README.md', kind: 'file' }]);
  const rows = composer.render();
  const ruleRows = rows.map((r, i) => [r, i]).filter(([r]) => /^─+$/.test(r)).map(([, i]) => i);
  const completionAt = rows.findIndex((r) => r.includes('docs/'));
  const hintAt = rows.findIndex((r) => r.includes('deliver'));
  assert.ok(completionAt > ruleRows[1], 'candidates come after the bottom rule');
  assert.ok(hintAt > completionAt, 'and the hint is the last row — the list refines the editor, not the hint');
  assert.equal(hintAt, rows.length - 1);
});

test('STABILITY: every repaint is wrapped in synchronized output, and the pairs balance', async () => {
  // A repaint is an erase then a redraw; a terminal that renders between the
  // two shows the region missing for a frame — flicker on every keystroke.
  // CSI ?2026 holds rendering until the frame completes; terminals without it
  // ignore the sequence, so this costs nothing where it does not help.
  const { createInput } = await import('../lib/tui/input.mjs');
  const { PassThrough } = await import('node:stream');
  const { fakeTty } = await import('./helpers/tty.mjs');
  const output = fakeTty({ columns: 60 });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const session = createInput({ input, output, ui });

  session.setStatus({ workspace: '~/repo' });
  session.commit(['a line']);
  const pending = session.next();
  input.emit('keypress', 'x', { name: 'x' });
  input.emit('keypress', null, { name: 'return' });
  await pending;
  session.close();

  const begins = (output.bytes.match(/\x1b\[\?2026h/g) || []).length;
  const ends = (output.bytes.match(/\x1b\[\?2026l/g) || []).length;
  assert.ok(begins >= 3, `repaints are batched into frames (saw ${begins})`);
  assert.equal(begins, ends, 'and every begin has its end — an unbalanced pair freezes the terminal');
});

test('STABILITY: clip and wrap consume non-SGR escapes instead of hanging on them', async () => {
  // `tokens` only knew SGR. Any other escape — `\x1b[K`, an OSC title,
  // `\x1b7` — left the scan pointing at the same ESC forever: an infinite
  // loop reachable from a child process\u2019s captured output, hanging the whole
  // TUI. Non-SGR escapes are consumed and DROPPED, matching `stripAnsi`, and
  // never passed through — an erase-line surviving into a padded, tinted row
  // would wipe the row it was wrapped in.
  const { clipTo: clip, wrapCells: wrap, displayWidth: width } = await import('../lib/tui/width.mjs');
  const cases = [
    ['ab\x1b[Kcd', 'abcd'],
    ['a\x1b]0;title\x07b', 'ab'],
    ['x\x1b7y', 'xy'],
    ['a\x1b', 'a'],
  ];
  for (const [input, plain] of cases) {
    assert.equal(clip(input, 20), plain, `clip drops the escape: ${JSON.stringify(input)}`);
    assert.equal(wrap(input, 20).join(''), plain, `wrap drops it too`);
    assert.equal(width(input), plain.length, 'and displayWidth agrees with both');
  }
  assert.match(clip('\x1b[31mred\x1b[39m', 20), /\x1b\[31m/, 'while SGR — colour — is still kept');
});

test('DESIGN: `/` at the start of an empty line opens the palette immediately', () => {
  // The reported flow: type `/index`, press Enter, read a printed list, type a
  // number, press Enter again. The design's entry point is the SIGIL — the
  // palette appears on the keystroke and filters live from the next one, the
  // way every reference CLI in the survey behaves.
  const composer = createComposer({ width: 40 });
  const result = composer.handleKey('/', {});
  assert.equal(result.intent, 'palette', 'the keystroke IS the request');
  assert.equal(composer.value, '', 'and the sigil is consumed, not typed');

  // Anywhere else, `/` is a character: paths are typed mid-command far more
  // often than the palette is wanted mid-word.
  for (const ch of 'get docs') composer.handleKey(ch, {});
  const midLine = composer.handleKey('/', {});
  assert.equal(midLine.intent, undefined, 'mid-line, / inserts');
  assert.equal(composer.value, 'get docs/');
});

// ── field lessons: the references open quiet ────────────────────────────

test('FIELD: an actor renders as a word, never as [object Object]', async () => {
  // The journal stores the contract's shape — {kind:'user'} — and the first
  // session against a real journal printed `actor [object Object]` on every
  // restored record line.
  const { formatActor } = await import('../lib/tui/block.mjs');
  assert.equal(formatActor({ kind: 'user' }), 'you');
  assert.equal(formatActor({ kind: 'ci' }), 'ci');
  assert.equal(formatActor({ kind: 'host', host: 'vscode' }), 'vscode');
  assert.equal(formatActor('you'), 'you');
  assert.equal(formatActor(null), null);

  const segments = recordSegments(createBlock({ status: 'ok', actor: { kind: 'user' } }));
  const text = segments.map((s) => s.text).join(' · ');
  assert.match(text, /\byou\b/, 'a bare word — the label `actor` said nothing the word does not');
  assert.doesNotMatch(text, /object Object/);
});

test('FIELD: the session opens quiet — history hydrates without printing blocks', async () => {
  // Amp, Claude Code, Grok and opencode all open onto identity, a hint or
  // two, and an EMPTY transcript. A ledger that dumps eight blocks of its own
  // past on open is a history lesson, not a prompt. The records still load —
  // ctrl+↑ walks them, !! <id> replays one — but the first screen gets one
  // muted summary line, or silence when there is nothing worth restoring.
  const { runLedger } = await import('../lib/tui-cmd.mjs');
  const { startRun, finishRun, newRunId } = await import('../lib/run-journal.mjs');
  const { PassThrough } = await import('node:stream');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-quiet-')));

  // A journal with one failed verify (worth restoring), one succeeded status
  // (a read — not worth it), and a prior tui session (never worth it).
  const mk = (command, status) => {
    const run = newRunId();
    startRun(workspace, { run, command, argv: [], actor: { kind: 'user' } });
    finishRun(workspace, { run, status, exitCode: status === 'succeeded' ? 0 : 1 });
  };
  mk('verify', 'failed');
  mk('status', 'succeeded');
  mk('tui', 'succeeded');

  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({ input, output, workspace, argv: ['--no-color'], dispatcher: async () => 0 });
  input.write('exit\n');
  input.end();
  await done;

  assert.doesNotMatch(text, /[▌|] [>❯] verify/, 'no restored block is printed onto the first screen');
  assert.doesNotMatch(text, /object Object/, 'and no mis-rendered actor anywhere');
  assert.match(text, /1 prior run · 1 failed/, 'one muted line says the history exists');
  assert.doesNotMatch(text, /[>❯] status.*restored/s, 'reads and prior tui sessions are not even counted');
});

test('FIELD: the startup hints are two short lines, not a manual', async () => {
  const { runLedger } = await import('../lib/tui-cmd.mjs');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({
    input, output, workspace: process.cwd(), argv: ['--no-color', '--no-events'],
    dispatcher: async () => 0,
  });
  input.write('exit\n');
  input.end();
  await done;
  assert.match(text, /\/ for commands/);
  assert.match(text, /\? for shortcuts/);
  assert.doesNotMatch(text, /! shell · !! re-run · @ file/,
    'the full grammar lives in help — a startup that lists every sigil is a manual, not a hint');
});

test('FIELD: the ledger journals the contract actor shape, not a display string', async () => {
  const { createLedger } = await import('../lib/tui/ledger.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-actor-')));
  const store = createLedger({ workspace, journaling: true });
  const block = store.open({ command: 'verify', argv: ['verify'] });
  store.openRun(block);
  store.close(block, { status: 'succeeded', exitCode: 0 });

  const lines = fs.readFileSync(path.join(workspace, '.harness', 'runs.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const start = lines.find((r) => r.type === 'run.start');
  assert.equal(typeof start.actor, 'object', 'the journal gets the {kind} object, same as bin/harness.mjs');
  assert.ok(typeof start.actor.kind === 'string' && start.actor.kind.length > 0);
  assert.equal(typeof block.actor, 'string', 'while the block displays the word');
});

// ── field round 2: size, scale, and the way out ─────────────────────────

test('FIELD: the chrome takes the width the terminal actually has', async () => {
  // A cap at 160 columns left the right quarter of a wide terminal
  // permanently unpainted — hairlines, tints and footer all stopped short,
  // which reads as "not adapting to the terminal". The mockups were drawn at
  // 110 columns, so no capture ever showed it: fixture-width, again.
  const { createInput } = await import('../lib/tui/input.mjs');
  const { PassThrough } = await import('node:stream');
  const { fakeTty } = await import('./helpers/tty.mjs');
  const output = fakeTty({ columns: 200 });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const session = createInput({ input, output, ui });
  const rule = session.regionLines().find((r) => /^─+$/.test(ui.stripAnsi(r)));
  assert.ok(rule, 'the composer hairline is in the region');
  assert.equal(displayWidth(rule), 200, 'and it spans all 200 columns');
  session.close();
});

test('FIELD: the palette scales with the terminal instead of cramming into 72 columns', () => {
  const overlay = createOverlay({ rows: [{ label: 'index status', summary: 'x', sideEffect: 'read' }] });
  const wide = renderOverlay(overlay, { ui, width: 200 });
  assert.equal(displayWidth(wide[0]), 110, 'on a wide terminal the box takes a readable measure');
  const narrow = renderOverlay(overlay, { ui, width: 50 });
  assert.equal(displayWidth(narrow[0]), 46, 'on a narrow one it takes everything but a margin');
});

test('FIELD: exit is discoverable — a palette row and a key in the hint row', async () => {
  // exit worked three ways (the word, /exit, ctrl+d) and appeared NOWHERE on
  // screen. Existing and being discoverable are different properties.
  const hint = renderHint({ ui, width: 160 });
  assert.match(hint, /ctrl\+d exit/, 'leaving lives where Enter’s consequences live');

  const { runLedger } = await import('../lib/tui-cmd.mjs');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({
    input, output, workspace: process.cwd(), argv: ['--no-color', '--no-events'],
    dispatcher: async () => 0,
  });
  // `/exi` filters the palette; the session row `exit` must be offered, and
  // choosing it must end the session with the ritual — no typed word needed.
  input.write('/exi\n1\n');
  input.end();
  await done;
  assert.match(text, /exit.*close the session/, 'the palette lists the way out, with its chord');
  assert.match(text, /session\s+0 commands/, 'and choosing it leaves through the exit ritual');
});

// ── the field review: all nine, plus live resize ────────────────────────

test('REVIEW-1: the region anchors to the bottom of the viewport', async () => {
  // Every reference — Claude Code, Amp, Codex, OpenCode, Grok — keeps the
  // composer at the bottom of the screen with the empty space in the MIDDLE.
  // The first build stacked everything at the top and left thirty-three dead
  // rows underneath.
  const { createInput } = await import('../lib/tui/input.mjs');
  const { PassThrough } = await import('node:stream');
  const { fakeTty } = await import('./helpers/tty.mjs');
  const output = fakeTty({ columns: 90, rows: 30 });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const session = createInput({ input, output, ui });
  session.commit(['header line']);
  session.setStatus({ workspace: '~/repo' });

  const lines = output.lines;
  assert.match(lines[0], /header line/, 'content flows from the top');
  const caretAt = lines.findIndex((l) => l.includes('❯'));
  assert.ok(caretAt >= 25, `the composer sits in the last rows of a 30-row viewport (row ${caretAt + 1})`);
  const between = lines.slice(1, caretAt - 1);
  assert.ok(between.some((l) => l.trim() === ''), 'and the empty space is in the middle, not below');
  session.close();
});

test('REVIEW-width: resize repaints the region at the new width and clears the ghosts', async () => {
  const { createInput } = await import('../lib/tui/input.mjs');
  const { PassThrough } = await import('node:stream');
  const { fakeTty } = await import('./helpers/tty.mjs');
  const output = fakeTty({ columns: 120, rows: 24 });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const session = createInput({ input, output, ui });
  session.setStatus({ workspace: '~/repo' });

  const ruleWidths = () => output.lines.filter((l) => /^─+$/.test(l.trim())).map((l) => displayWidth(l.trim()));
  assert.deepEqual([...new Set(ruleWidths())], [120], 'hairlines take the full width');

  output.resize(70);
  assert.deepEqual([...new Set(ruleWidths())], [70],
    'after a shrink the rules are 70 wide with no 120-wide ghost tails left behind');
  output.resize(150);
  assert.deepEqual([...new Set(ruleWidths())], [150], 'and a grow follows too');
  session.close();
});

test('REVIEW-3: the palette grows upward above a composer that never moves', async () => {
  const { createInput } = await import('../lib/tui/input.mjs');
  const { PassThrough } = await import('node:stream');
  const { fakeTty } = await import('./helpers/tty.mjs');
  const output = fakeTty({ columns: 100, rows: 30 });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const session = createInput({ input, output, ui });

  const rowsFor = (q) => [
    { label: 'index', note: 'rebuild the knowledge index', sideEffect: 'mutate' },
    { label: 'index status', note: 'freshness vs HEAD', sideEffect: 'read' },
  ].filter((r) => r.label.includes(q));
  session.openPalette({ overlay: createOverlay({ rows: rowsFor('') }), filter: rowsFor });

  let lines = output.lines;
  const caretAt = () => output.lines.findIndex((l) => l.includes('❯ /'));
  assert.ok(caretAt() !== -1, 'the input row shows the sigil and stays visible (`❯ /`)');
  const listAt = output.lines.findIndex((l) => l.includes('rebuild the knowledge index'));
  assert.ok(listAt !== -1 && listAt < caretAt(), 'the candidates sit ABOVE the input, Claude Code’s shape');

  // Typing filters live through the composer; the input row shows the query.
  const pending = session.next();
  for (const ch of 'index s') input.emit('keypress', ch, { name: ch, sequence: ch });
  lines = output.lines;
  assert.ok(lines.some((l) => l.includes('❯ /index s')), 'the query is visible at the input row');
  assert.ok(lines.some((l) => l.includes('freshness vs HEAD')), 'and the list narrowed to the match');
  assert.ok(!lines.some((l) => l.includes('rebuild the knowledge index')), 'dropping what no longer matches');

  // Enter chooses the selection and closes the list.
  input.emit('keypress', null, { name: 'return' });
  const event = await pending;
  assert.equal(event.intent, 'choose');
  assert.equal(event.row.label, 'index status');
  session.close();
});

test('REVIEW-2: palette rows are two aligned columns, description left-aligned', () => {
  const overlay = createOverlay({
    rows: [
      { label: 'index', note: 'rebuild the knowledge index', sideEffect: 'mutate' },
      { label: 'index structural', note: 'build the code symbol index', sideEffect: 'mutate' },
    ],
  });
  const rows = renderPaletteRows(overlay, { ui, width: 100 });
  const descCols = rows.slice(0, 2).map((r) => ui.stripAnsi(r).search(/rebuild|build the/));
  assert.equal(new Set(descCols).size, 1,
    'descriptions start at one shared column — right-aligning them made every midfield a different width');
  for (const r of rows) assert.ok(displayWidth(r) <= 100);
  assert.match(ui.stripAnsi(rows[0]), /mutate\s*$/, 'the side-effect class holds the right edge');
});

test('REVIEW-7: the empty composer carries a placeholder that vanishes on typing', () => {
  const composer = createComposer({ width: 80 });
  assert.match(composer.render()[1], /run a command · \/ for the palette/, 'Codex and Grok both seat one here');
  composer.handleKey('s', { name: 's' });
  assert.doesNotMatch(composer.render()[1], /run a command/, 'and it is never part of the value');
  assert.equal(composer.value, 's');
});

test('REVIEW-8: the top hairline carries the mode label, Claude Code’s shape', () => {
  const composer = createComposer({ width: 60 });
  composer.setRuleLabel('deliver');
  const top = composer.render()[0];
  assert.match(top, /deliver/, 'the label rides a row already being spent');
  assert.equal(displayWidth(top), 60, 'without changing the rule’s width');
  assert.match(composer.render().at(-1), /^─+$/, 'the bottom rule stays plain');
});

test('REVIEW-6: the version sits bottom-right in the footer', () => {
  const row = renderFooter({ workspace: '~/repo', version: '0.5.0' }, { ui, width: 100 });
  assert.match(row, /harness 0\.5\.0\s*$/, 'OpenCode’s and Grok’s home for it');
});

test('REVIEW-4: a blocked gate gets one actionable warning at open', async () => {
  const { runLedger } = await import('../lib/tui-cmd.mjs');
  const { PassThrough } = await import('node:stream');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-warn-')));
  fs.mkdirSync(path.join(workspace, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.harness', 'session.json'), JSON.stringify({ gateStatus: 'blocked' }));

  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c.toString(); });
  const done = runLedger({ input, output, workspace, argv: ['--no-color', '--no-events'], dispatcher: async () => 0 });
  input.write('exit\n');
  input.end();
  await done;
  assert.match(text, /gate blocked.*verify collects the evidence/,
    'the problem AND the command that fixes it, once, at open — Claude Code’s ⚠ pattern');
});
