/**
 * The repaint arithmetic (P4bAC10).
 *
 * The composer's first interactive outing drew a box INSIDE the previous box.
 * Nothing in the suite could see it: the state machine and the renderer were
 * both correct, and the defect lived entirely in the escape sequences that move
 * the cursor between paints — the one part with no test.
 *
 * So these tests model a screen (see `helpers/tty.mjs`) and assert what a
 * screenshot showed and a stream capture could not: how many editors end up on
 * screen, where the transcript lands relative to them, and whether the region
 * the code thinks it drew is the region it actually cleared.
 *
 * Two original bugs are still pinned here — `erase` walking back `painted`
 * lines while the cursor had already been parked inside the block, and `next()`
 * painting on top of a paint `write()` had already done. Three more are pinned
 * with them: the region now includes a live block, an overlay and a footer, and
 * each of those is a row the erase arithmetic has to know about.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createInput } from '../lib/tui/input.mjs';
import { createOverlay } from '../lib/tui/overlay.mjs';
import { createBlock } from '../lib/tui/block.mjs';
import { fakeTty, plainUi } from './helpers/tty.mjs';

/** A real stream, so readline's own plumbing works, wearing a TTY hat. */
const fakeInput = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const ui = plainUi();

/** Rows that are part of the editor, identified by the rule it draws. */
const ruleRows = (out) => out.lines.filter((l) => /^─{4,}$/.test(l.trim())).length;
const caretRows = (out) => out.lines.filter((l) => l.includes('❯')).length;

test('P4bAC10: repainting repeatedly leaves ONE editor on screen', () => {
  const output = fakeTty();
  const session = createInput({ input: fakeInput(), output, ui });

  session.setStatus({ workspace: '~/repo' });
  session.setStatus({ branch: 'main' });
  session.setStatus({ gate: 'pass' });

  assert.equal(ruleRows(output), 2,
    'exactly two hairlines — more means erase walked back the wrong number of lines and each paint nested inside the last');
  assert.equal(caretRows(output), 1, 'and exactly one caret, or the operator sees two input lines');
  session.close();
});

test('P4bAC10: a transcript line lands above the editor, which stays at the bottom', () => {
  const output = fakeTty();
  const session = createInput({ input: fakeInput(), output, ui });
  session.commit(['first line']);
  session.commit(['second line']);

  const lines = output.lines;
  const firstAt = lines.findIndex((l) => l.includes('first line'));
  const secondAt = lines.findIndex((l) => l.includes('second line'));
  const caretAt = lines.findIndex((l) => l.includes('❯'));
  assert.ok(firstAt !== -1 && secondAt !== -1 && caretAt !== -1, 'all three must be on screen');
  assert.ok(firstAt < secondAt, 'the transcript keeps its order');
  assert.ok(secondAt < caretAt, 'and the editor stays below everything written');
  assert.equal(caretRows(output), 1);
  session.close();
});

test('P4bAC10: typing repaints in place rather than stacking editors', async () => {
  const output = fakeTty();
  const input = fakeInput();
  const session = createInput({ input, output, ui });
  session.setStatus({ workspace: '~/somewhere' });
  // Driven through the REAL keypress binding, not by calling the composer
  // directly. Bypassing the binding could not have detected a stacked repaint
  // per keystroke — the exact defect this was written to catch.
  const pending = session.next();
  for (const ch of 'status') input.emit('keypress', ch, { name: ch, sequence: ch });
  assert.equal(ruleRows(output), 2, 'six keypresses must not leave six editors behind');
  assert.equal(caretRows(output), 1);
  input.emit('keypress', null, { name: 'return' });
  await pending;
  session.close();
});

test('P4bAC10: an overlay replaces the editor rather than stacking on top of it', () => {
  const output = fakeTty();
  const session = createInput({ input: fakeInput(), output, ui });
  session.setStatus({ workspace: '~/repo' });
  session.openOverlay(createOverlay({ rows: [{ label: 'verify' }, { label: 'status' }], footer: 'esc closes' }));

  assert.equal(caretRows(output), 1,
    'the overlay has its own prompt caret; the composer must be gone, not underneath');
  assert.equal(ruleRows(output), 0, 'and the hairlines with it — overlays replace, they do not layer');
  assert.ok(output.lines.some((l) => l.includes('verify')));

  session.closeOverlay();
  assert.equal(ruleRows(output), 2, 'closing brings the editor back, exactly once');
  session.close();
});

test('P4bAC10: a live block sits above the editor and vanishes when the command ends', () => {
  const output = fakeTty();
  const session = createInput({ input: fakeInput(), output, ui });
  const block = createBlock({ command: 'npm test', status: 'running', lines: ['first', 'second'] });
  session.beginLive(block);

  const lines = output.lines;
  const liveAt = lines.findIndex((l) => l.includes('npm test'));
  const caretAt = lines.findIndex((l) => l.includes('❯'));
  assert.ok(liveAt !== -1 && caretAt !== -1);
  assert.ok(liveAt < caretAt, 'the running command is above the editor, where the transcript is');
  assert.ok(lines.some((l) => l.includes('esc cancels')), 'the sticky header says how to stop it');

  session.endLive();
  session.setStatus({ workspace: '~/repo' });
  assert.equal(output.lines.filter((l) => l.includes('esc cancels')).length, 0,
    'and the live region is transient — the committed block is what survives');
  session.close();
});

test('P4bAC10: closing the session erases the region instead of stranding it', () => {
  const output = fakeTty();
  const session = createInput({ input: fakeInput(), output, ui });
  session.setStatus({ workspace: '~/repo' });
  session.close();
  assert.equal(caretRows(output), 0,
    'the exit ritual prints after this; a stranded editor would sit in the middle of it');
  assert.equal(ruleRows(output), 0);
});

test('P4bAC10: the piped path emits no escape sequences at all', () => {
  // Scripted sessions must stay diffable — a repaint sequence in captured
  // output would break every test that reads the transcript.
  const output = fakeTty();
  const piped = new PassThrough();
  piped.end();
  const session = createInput({ input: piped, output, ui });
  session.commit(['a line']);
  assert.deepEqual(output.lines.filter(Boolean), ['a line']);
  assert.doesNotMatch(output.bytes, /\x1b/, 'not one escape byte reaches a pipe');
  session.close();
});

test('the alternate screen is entered and left as a pair, and only when asked for', () => {
  const plain = fakeTty();
  const a = createInput({ input: fakeInput(), output: plain, ui });
  assert.equal(plain.altScreen, false, 'main buffer by default — scrollback is the design commitment');
  a.close();

  const alt = fakeTty();
  const b = createInput({ input: fakeInput(), output: alt, ui, altScreen: true });
  assert.equal(alt.altScreen, true);
  b.close();
  assert.equal(alt.altScreen, false, 'and a session that entered it always leaves it');
});

test('capture takes stdout for one dispatch and gives it back, partial line included', () => {
  const output = fakeTty();
  const session = createInput({ input: fakeInput(), output, ui });
  const seen = [];
  const capture = session.capture((line) => seen.push(line));

  output.write('one\ntwo\n');
  output.write('three without a newline');
  assert.deepEqual(seen, ['one', 'two'], 'complete lines arrive as they complete');
  capture.release();
  assert.deepEqual(seen, ['one', 'two', 'three without a newline'],
    'and the partial last line is flushed rather than dropped — a command that printed without a trailing newline still gets its output');

  output.write('after release');
  assert.equal(seen.length, 3, 'stdout is genuinely handed back');
  session.close();
});
