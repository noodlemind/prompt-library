/**
 * P4bAC10 — the repaint arithmetic.
 *
 * The composer's first interactive outing drew a box INSIDE the previous box.
 * Nothing in the suite could see it: the state machine and the renderer were
 * both correct, and the defect lived entirely in the escape sequences that move
 * the cursor between paints — the one part with no test.
 *
 * So this file models a cursor. The fake terminal below understands exactly
 * three sequences (`CSI nA` up, `CSI nC` right, `CSI 0J` clear-to-end) plus CR
 * and LF, which is everything the input binding emits. That is enough to assert
 * what a screenshot showed and a stream capture could not: how many composers
 * end up on screen.
 *
 * Two bugs were found and both are pinned here. `erase` walked back `painted`
 * lines while the cursor had already been parked inside the block, overshooting
 * by the parked offset and leaving the old box behind; and `next()` painted on
 * top of a paint `write()` had already done, because neither erased first.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createInput } from '../lib/tui/input.mjs';

const CSI = '[';

/** A terminal with a cursor, a screen, and no dependencies. */
function fakeTty({ columns = 60 } = {}) {
  const screen = [''];
  let cy = 0;
  let cx = 0;
  const ensure = (row) => { while (screen.length <= row) screen.push(''); };

  return {
    isTTY: true,
    columns,
    write(chunk) {
      let rest = String(chunk);
      while (rest.length) {
        if (rest.startsWith(CSI)) {
          const m = /^\[(\d*)([A-Za-z])/.exec(rest);
          if (m) {
            const n = m[1] === '' ? 1 : Number(m[1]);
            if (m[2] === 'A') cy = Math.max(0, cy - n);
            else if (m[2] === 'B') cy += n;
            else if (m[2] === 'C') cx += n;
            else if (m[2] === 'D') cx = Math.max(0, cx - n);
            else if (m[2] === 'J' && (m[1] === '0' || m[1] === '')) {
              ensure(cy);
              screen[cy] = screen[cy].slice(0, cx);
              screen.length = cy + 1;
            } else if (m[2] === 'H') { cy = 0; cx = 0; }
            rest = rest.slice(m[0].length);
            continue;
          }
        }
        const ch = rest[0];
        if (ch === '\n') { cy += 1; cx = 0; ensure(cy); rest = rest.slice(1); continue; }
        if (ch === '\r') { cx = 0; rest = rest.slice(1); continue; }
        const stop = rest.search(/[\n\r]/);
        const text = stop === -1 ? rest : rest.slice(0, stop);
        ensure(cy);
        const padded = screen[cy].padEnd(cx, ' ');
        screen[cy] = padded.slice(0, cx) + text + padded.slice(cx + text.length);
        cx += text.length;
        rest = stop === -1 ? '' : rest.slice(text.length);
      }
      return true;
    },
    on() {}, off() {},
    get lines() { return screen.map((l) => l.replace(/\s+$/, '')); },
  };
}

/** A real stream, so readline's own plumbing works, wearing a TTY hat. */
const fakeInput = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const ui = { paint: (_token, text) => text, unicode: true, arrow: '->' };

test('P4bAC10: repainting repeatedly leaves ONE composer on screen', () => {
  const output = fakeTty();
  const session = createInput({ input: fakeInput(), output, ui, label: 'prompt-library' });

  session.setStatus({ workspace: '~/repo' });
  session.setStatus({ branch: 'main' });
  session.setStatus({ gate: 'pass' });

  const boxes = output.lines.filter((l) => l.includes('prompt-library')).length;
  assert.equal(boxes, 1,
    `the composer appears ${boxes} times — erase walked back the wrong number of lines, so each paint nested inside the last`);
  const carets = output.lines.filter((l) => l.includes('❯')).length;
  assert.equal(carets, 1, 'and exactly one caret, or the operator sees two input lines');
  session.close();
});

test('P4bAC10: a transcript line lands above the composer, which stays at the bottom', () => {
  const output = fakeTty();
  const session = createInput({ input: fakeInput(), output, ui, label: 'repo' });
  session.write('first line');
  session.write('second line');

  const lines = output.lines;
  const firstAt = lines.findIndex((l) => l.includes('first line'));
  const secondAt = lines.findIndex((l) => l.includes('second line'));
  const boxAt = lines.findIndex((l) => l.includes('repo'));
  assert.ok(firstAt !== -1 && secondAt !== -1 && boxAt !== -1, 'all three must be on screen');
  assert.ok(firstAt < secondAt, 'the transcript keeps its order');
  assert.ok(secondAt < boxAt, 'and the composer stays below everything written');
  assert.equal(lines.filter((l) => l.includes('repo')).length, 1);
  session.close();
});

test('P4bAC10: typing repaints in place rather than stacking boxes', () => {
  const output = fakeTty();
  // A label that cannot collide with the status path — the first version used
  // `repo` for both and counted the status line as a second composer.
  const session = createInput({ input: fakeInput(), output, ui, label: 'the-label' });
  session.setStatus({ workspace: '~/somewhere' });
  for (const ch of 'status') session.composer.handleKey(ch, { name: ch, sequence: ch });
  // The binding repaints on every changed keypress; drive it the same way.
  session.setStatus({});
  assert.equal(output.lines.filter((l) => l.includes('the-label')).length, 1,
    'six keypresses must not leave six composers behind');
  assert.equal(output.lines.filter((l) => l.includes('❯')).length, 1);
  session.close();
});

test('P4bAC10: closing the session erases the composer instead of stranding it', () => {
  const output = fakeTty();
  const session = createInput({ input: fakeInput(), output, ui, label: 'repo' });
  session.setStatus({ workspace: '~/repo' });
  session.close();
  assert.equal(output.lines.filter((l) => l.includes('❯')).length, 0,
    'the exit ritual prints after this; a stranded box would sit in the middle of it');
});

test('P4bAC10: the piped path emits no escape sequences at all', () => {
  // Scripted sessions must stay diffable — a repaint sequence in captured
  // output would break every existing test that reads the transcript.
  const output = fakeTty();
  const piped = new PassThrough();
  piped.end();
  const session = createInput({ input: piped, output, ui, label: 'repo' });
  session.write('a line');
  assert.deepEqual(output.lines.filter(Boolean), ['a line']);
  session.close();
});
