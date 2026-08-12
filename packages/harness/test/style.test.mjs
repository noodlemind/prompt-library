import { test } from 'node:test';
import assert from 'node:assert';
import { createStyle, clampNote, EXIT } from '../lib/style.mjs';

const ttyStream = { isTTY: true };
const pipeStream = { isTTY: false };

function style(overrides = {}) {
  return createStyle({
    stream: overrides.stream ?? ttyStream,
    env: overrides.env ?? { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
    argv: overrides.argv ?? [],
    platform: overrides.platform ?? 'darwin',
  });
}

test('truecolor terminal paints state.ok with 24-bit green', () => {
  const s = style();
    assert.match(s.paint('ok', 'synced'), /\x1b\[38;2;134;201;154msynced\x1b\[39m/);
});

test('256-color terminal falls back to indexed palette', () => {
  const s = style({ env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' } });
  assert.match(s.paint('warn', 'stale'), /\x1b\[38;5;179mstale\x1b\[39m/);
});

test('piped output carries no ANSI and uses ASCII twins', () => {
  const s = style({ stream: pipeStream });
  assert.equal(s.paint('error', 'boom'), 'boom');
  assert.equal(s.glyph('ok'), '[ok]');
  assert.equal(s.glyph('warn'), '[!]');
  assert.equal(s.glyph('error'), '[x]');
  assert.equal(s.glyph('pending'), '.');
  assert.equal(s.arrow, '->');
});

test('NO_COLOR is honored even on a TTY', () => {
  const s = style({ env: { NO_COLOR: '1', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' } });
  assert.equal(s.paint('ok', 'fine'), 'fine');
  assert.equal(s.glyph('ok'), '[ok]');
});

test('--no-color flag is honored', () => {
  const s = style({ argv: ['--no-color'] });
  assert.equal(s.paint('ok', 'fine'), 'fine');
});

test('unicode glyphs on a capable TTY', () => {
  const s = style();
  assert.equal(s.stripAnsi(s.glyph('ok')), '✓');
  assert.equal(s.stripAnsi(s.glyph('warn')), '!');
  assert.equal(s.stripAnsi(s.glyph('error')), '✗');
  assert.equal(s.arrow, '→');
});

test('line() is column-stable: glyph gutter and padded key', () => {
  const s = style({ stream: pipeStream });
  const line = s.line({ state: 'ok', key: 'repo', value: 'initialized', keyWidth: 10 });
  assert.equal(line, '[ok]  repo        initialized');
});

test('line() renders note and next in the grammar order', () => {
  const s = style({ stream: pipeStream });
  const line = s.line({
    state: 'warn',
    key: 'knowledge',
    value: 'index 4m old',
    next: 'harness index',
    keyWidth: 10,
  });
  assert.equal(line, '[!]   knowledge   index 4m old -> harness index');
});

test('line() without state has no glyph gutter (ledger nominal row)', () => {
  const s = style({ stream: pipeStream });
  const line = s.line({ key: 'agents', value: '3 active', note: 'web-qa backend docs', keyWidth: 10 });
  assert.equal(line, 'agents      3 active · web-qa backend docs');
});

test('summary() counts only what exists and always states the exit', () => {
  const s = style({ stream: pipeStream });
  assert.equal(s.summary({ ok: 27, exit: 0 }), '27 ok -> exit 0');
  assert.equal(s.summary({ ok: 2, warn: 1, err: 1, exit: 6 }), '2 ok · 1 warn · 1 err -> exit 6');
});

test('errorBlock() renders code, message, fix, and exit', () => {
  const s = style({ stream: pipeStream });
  const lines = s.errorBlock({
    code: 'E_NOT_INITIALIZED',
    message: 'this repo has no .harness workspace',
    fix: 'harness init-repo',
    exit: EXIT.notInitialized,
  });
  assert.deepEqual(lines, [
    '[x] E_NOT_INITIALIZED',
    '  this repo has no .harness workspace',
    '  -> fix   harness init-repo',
    '  exit 3',
  ]);
});

test('exit code registry matches the agent contract', () => {
  assert.equal(EXIT.ok, 0);
  assert.equal(EXIT.usage, 2);
  assert.equal(EXIT.notInitialized, 3);
  assert.equal(EXIT.needsApproval, 4);
  assert.equal(EXIT.syncConflict, 5);
  assert.equal(EXIT.doctorFailed, 6);
  assert.equal(EXIT.network, 7);
  assert.equal(EXIT.interrupted, 130);
});

test('stripAnsi removes paint for width math', () => {
  const s = style();
  assert.equal(s.stripAnsi(s.paint('info', 'field')), 'field');
});

test('clampNote keeps short notes and truncates long ones toward --verbose', () => {
  assert.equal(clampNote('harness install'), 'harness install');
  const long = 'x'.repeat(500);
  const clamped = clampNote(long);
  assert.ok(clamped.length < 200);
  assert.match(clamped, /… \(--verbose for full\)$/);
});
