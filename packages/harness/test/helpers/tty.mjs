/**
 * A terminal with a cursor, a screen, and no dependencies.
 *
 * WHY THIS EXISTS. The phase-4b reopening happened because nine acceptance
 * criteria were green beside a surface that did not exist: the tests drove the
 * loop through injected streams, which have no `isTTY`, so the terminal — the
 * entire product — was on the far side of the test seam. A stream capture can
 * tell you which bytes were written; it cannot tell you what is on screen, and
 * "what is on screen" is the only question a TUI has.
 *
 * So this models the screen. It understands exactly what the input binding
 * emits — `CSI nA/B/C/D`, `CSI 0J`, `CSI 2J`, `CSI H`, `CSI ?1049h/l`, SGR —
 * and nothing else, which keeps it honest: a sequence the binding starts
 * emitting without this knowing about it shows up as garbage on the screen
 * rather than being silently swallowed.
 *
 * SGR IS RECORDED, NOT DISCARDED, because the design's second channel is
 * colour. `cellAttrs` remembers the background at each cell, so a test can ask
 * "is this block tinted as failed" instead of grepping for an escape sequence
 * and hoping it landed on the right row.
 */

const CSI = '\x1b[';

export function fakeTty({ columns = 80, rows = 40 } = {}) {
  const listeners = {};
  const screen = [''];
  /** Background SGR active at each written cell, parallel to `screen`. */
  const attrs = [[]];
  let cy = 0;
  let cx = 0;
  let bg = null;
  let altScreen = false;
  const written = [];
  /** Escapes the model does not implement, kept so a test can assert the
   * renderer stopped emitting something rather than discovering it as garbage
   * on screen. */
  const unknownEscapes = [];

  const ensure = (row) => {
    while (screen.length <= row) { screen.push(''); attrs.push([]); }
  };

  return {
    isTTY: true,
    columns,
    rows,
    // eslint-disable-next-line sort-keys
    write(chunk) {
      const text = String(chunk);
      written.push(text);
      let rest = text;
      while (rest.length) {
        if (rest.startsWith(CSI)) {
          const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(rest);
          if (m) {
            const params = m[1];
            const n = params === '' ? 1 : Number(params.replace(/[^0-9]/g, '') || 1);
            const final = m[2];
            if (final === 'A') cy = Math.max(0, cy - n);
            else if (final === 'B') cy += n;
            else if (final === 'C') cx += n;
            else if (final === 'D') cx = Math.max(0, cx - n);
            else if (final === 'J' && (params === '0' || params === '')) {
              ensure(cy);
              screen[cy] = screen[cy].slice(0, cx);
              attrs[cy] = attrs[cy].slice(0, cx);
              screen.length = cy + 1;
              attrs.length = cy + 1;
            } else if (final === 'J' && params === '2') {
              screen.length = 0; attrs.length = 0; ensure(0); cy = 0; cx = 0;
            } else if (final === 'H') {
              // Parameterized: `ESC[r;cH` is 1-based absolute addressing — the
              // bottom-anchored region positions with it. Bare `ESC[H` is home.
              const parts = params.split(';').map((v) => Number(v));
              cy = Math.max(0, (parts[0] || 1) - 1);
              cx = Math.max(0, (parts[1] || 1) - 1);
            }
            else if (final === 'h' && params === '?1049') altScreen = true;
            else if (final === 'l' && params === '?1049') altScreen = false;
            else if (final === 'm') {
              // SGR: 0 resets, 48;… opens a background. Foreground colours are
              // deliberately ignored — the tests that care about foreground ask
              // through `ui.paint`, and recording both would make every
              // assertion about background noisier for no gain.
              if (params === '' || params === '0') bg = null;
              else if (/^48;/.test(params)) bg = params;
            }
            rest = rest.slice(m[0].length);
            continue;
          }
        }
        const ch = rest[0];
        if (ch === '\n') { cy += 1; cx = 0; ensure(cy); rest = rest.slice(1); continue; }
        if (ch === '\r') { cx = 0; rest = rest.slice(1); continue; }
        // AN UNMODELLED ESCAPE CONSUMES ONE BYTE. `search` returns 0 for a
        // leading `\x1b` that no rule above matched, so the slice below was
        // empty and `rest` never shrank — the loop spun forever on a bare
        // `\x1b`, an `\x1b7`, an OSC title, or any CSI with a final byte
        // outside A-Za-z. That hangs the test process instead of failing a
        // test, which blocks CI rather than reporting anything.
        if (ch === '\x1b') { unknownEscapes.push(rest.slice(0, 8)); rest = rest.slice(1); continue; }
        const stop = rest.search(/[\n\r\x1b]/);
        const run = stop === -1 ? rest : rest.slice(0, stop);
        ensure(cy);
        const padded = screen[cy].padEnd(cx, ' ');
        screen[cy] = padded.slice(0, cx) + run + padded.slice(cx + run.length);
        for (let i = 0; i < run.length; i += 1) attrs[cy][cx + i] = bg;
        cx += run.length;
        rest = stop === -1 ? '' : rest.slice(run.length);
      }
      return true;
    },
    on(event, handler) { (listeners[event] ??= []).push(handler); },
    off(event, handler) { listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler); },
    /** Change the terminal's size and fire the resize handlers, the way a real
     * TTY does on SIGWINCH. */
    resize(nextCols, nextRows) {
      this.columns = nextCols;
      if (nextRows) this.rows = nextRows;
      for (const h of listeners.resize ?? []) h();
    },

    /** The screen as a person would read it, trailing blanks trimmed. */
    get lines() { return screen.map((l) => l.replace(/\s+$/, '')); },
    /** The screen with trailing blanks kept — needed to prove a tint spans the
     * full width rather than stopping at the text. */
    get raw() { return [...screen]; },
    /** Background SGR parameters per row, deduplicated. A tinted row has one
     * entry; an untinted row has `[null]`. */
    backgroundsAt(row) { return [...new Set(attrs[row] ?? [])]; },
    /** Every distinct background on screen, in row order. */
    get backgrounds() { return screen.map((_, i) => [...new Set(attrs[i] ?? [])].filter(Boolean)); },
    get altScreen() { return altScreen; },
    get bytes() { return written.join(''); },
    get cursor() { return { row: cy, col: cx }; },
    get unknownEscapes() { return [...unknownEscapes]; },
  };
}

/**
 * A style renderer that paints nothing, for tests about LAYOUT.
 *
 * Deliberately not `createStyle` with colour off: this keeps the tint and
 * stripe entry points present and inert, so a layout test reads the same text
 * a person would see while a colour test uses the real renderer.
 */
export function plainUi({ unicode = true } = {}) {
  const GLYPH = { ok: '✓', warn: '!', error: '✗', active: '◐', pending: '·' };
  const ASCII = { ok: '[ok]', warn: '[!]', error: '[x]', active: '-', pending: '.' };
  return {
    unicode,
    arrow: unicode ? '→' : '->',
    color: 'none',
    tints: false,
    ground: 'dark',
    paint: (_token, text) => String(text ?? ''),
    glyph: (state) => (unicode ? GLYPH[state] : ASCII[state]) ?? '',
    stripe: () => (unicode ? '▌' : '|'),
    tintRow: (_state, row) => row,
    stripAnsi: (t) => String(t ?? '').replace(/\x1b\[[0-9;]*m/g, ''),
    line: ({ state, key, value = '', note, next, keyWidth = 10 }) => {
      const g = state ? `${(unicode ? GLYPH[state] : ASCII[state]) ?? ''} ` : '';
      let out = `${g}${String(key).padEnd(keyWidth)}  ${value}`;
      if (note) out += ` · ${note}`;
      if (next) out += ` ${unicode ? '→' : '->'} ${next}`;
      return out.trimEnd();
    },
    summary: ({ ok = 0, warn = 0, err = 0, exit = 0 }) => {
      const parts = [`${ok} ok`];
      if (warn) parts.push(`${warn} warn`);
      if (err) parts.push(`${err} err`);
      return `${parts.join(' · ')} ${unicode ? '→' : '->'} exit ${exit}`;
    },
    errorBlock: ({ code, message, fix, exit = 1 }) => [
      `${unicode ? '✗' : '[x]'} ${code}`,
      ...(message ? [`  ${message}`] : []),
      ...(fix ? [`  ${unicode ? '→' : '->'} fix   ${fix}`] : []),
      `  exit ${exit}`,
    ],
  };
}
