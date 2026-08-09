/**
 * The composer — a bordered, multiline editor that lives in the terminal's
 * MAIN buffer (P4bAC10, P4bAC11, P4bAC16).
 *
 * WHY IT IS A STATE MACHINE. The phase-4b reopening found nine green
 * acceptance criteria sitting beside a TUI that did not exist: the tests drove
 * the loop through injected streams, which have no `isTTY`, so the terminal —
 * the entire product — was on the far side of the test seam. Everything with
 * logic in it therefore lives here, where a keypress goes in and state plus
 * rendered lines come out, and no terminal is needed to prove any of it.
 * `tui-cmd.mjs` binds real keypress events and repaints; that binding is small
 * enough to read in one sitting, which is the most a pty-less suite can ask.
 *
 * WHY A BOX AT ALL, given the Session Ledger direction. "Main-buffer scrolling
 * transcript" was previously read as licence to ship a bare readline. It is not:
 * Amp, Pi, opencode, Grok and Claude Code are all main-buffer transcripts, and
 * every one draws a bordered composer with a status line. The transcript scrolls
 * above; the composer is a fixed block at the bottom that repaints in place. The
 * two ideas were never in tension — see `render` and `height`, which exist so
 * the caller knows exactly how many lines to clear.
 */

const UNICODE = {
  topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯',
  horizontal: '─', vertical: '│', caret: '❯',
};
const ASCII = {
  topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+',
  horizontal: '-', vertical: '|', caret: '>',
};

export const DEFAULT_HISTORY_LIMIT = 200;

/** A control character is a key press, never text. Inserting one is how a raw
 * escape sequence used to end up in the dispatched line. */
const isPrintable = (ch) => typeof ch === 'string' && ch.length === 1 && ch >= ' ' && ch !== '';

const visibleWidth = (text) => [...String(text).replace(/\[[0-9;]*m/g, '')].length;

/**
 * Break one logical line into rows that fit inside the border.
 *
 * A line wider than the terminal used to push the right-hand border off screen,
 * which makes the box look broken precisely when someone is typing something
 * long. Wrapping is by display cell, not by character index, so the arithmetic
 * matches what the terminal actually does.
 */
function wrap(line, width) {
  if (width <= 0) return [''];
  const chars = [...line];
  if (!chars.length) return [''];
  const rows = [];
  for (let i = 0; i < chars.length; i += width) rows.push(chars.slice(i, i + width).join(''));
  return rows;
}

export function createComposer({
  width = 80,
  ascii = false,
  history = [],
  historyLimit = DEFAULT_HISTORY_LIMIT,
  label = '',
  hint = '',
  paint = (_token, text) => text,
} = {}) {
  const glyphs = ascii ? ASCII : UNICODE;
  let lines = [''];
  let row = 0;
  let col = 0;
  const past = [...history];
  // `null` means "editing a fresh line"; an index means "showing history", and
  // `draft` is what to restore on the way back down.
  let historyIndex = null;
  let draft = null;

  const clampCursor = () => {
    row = Math.max(0, Math.min(row, lines.length - 1));
    col = Math.max(0, Math.min(col, lines[row].length));
  };
  const setValue = (text) => {
    lines = String(text).split('\n');
    row = lines.length - 1;
    col = lines[row].length;
  };
  const insert = (text) => {
    const line = lines[row];
    lines[row] = line.slice(0, col) + text + line.slice(col);
    col += text.length;
    historyIndex = null;
  };

  /** The value as dispatched: rows joined by a space, because a multiline entry
   * is one command typed across several rows, not several commands. */
  const currentValue = () => lines.join('\n');
  const dispatchValue = () => lines.map((l) => l.replace(/\\$/, '').trim()).filter(Boolean).join(' ');

  function recallHistory(direction) {
    if (!past.length) return false;
    if (direction === 'back') {
      if (historyIndex === null) { draft = currentValue(); historyIndex = past.length - 1; }
      else if (historyIndex > 0) historyIndex -= 1;
      else return true;
      setValue(past[historyIndex]);
      return true;
    }
    if (historyIndex === null) return false;
    if (historyIndex < past.length - 1) { historyIndex += 1; setValue(past[historyIndex]); return true; }
    historyIndex = null;
    setValue(draft ?? '');
    draft = null;
    return true;
  }

  function submit() {
    const value = dispatchValue();
    lines = ['']; row = 0; col = 0; historyIndex = null; draft = null;
    if (!value) return { changed: true };
    past.push(value);
    while (past.length > historyLimit) past.shift();
    return { submitted: value, changed: true };
  }

  /**
   * One key press.
   *
   * Returns `{ submitted?, intent?, changed }`. `intent` is for the things the
   * composer recognises but does not own — opening the palette, cancelling a
   * running command, closing the session — so the loop keeps those decisions.
   */
  function handleKey(str, key = {}) {
    const name = key.name;
    const ctrl = Boolean(key.ctrl);
    const meta = Boolean(key.meta);

    // Chords first: a chord that fell through to the printable branch would
    // type a character instead of opening what it names.
    if (ctrl && name === 'p') return { intent: 'palette', changed: false };
    if (meta && name === 'k') return { intent: 'palette', changed: false };
    if (ctrl && name === 'c') {
      const had = Boolean(dispatchValue());
      lines = ['']; row = 0; col = 0; historyIndex = null;
      return { intent: 'cancel', hadInput: had, changed: true };
    }
    if (ctrl && name === 'd') {
      if (dispatchValue()) return { changed: false };
      return { intent: 'exit', changed: false };
    }
    if (ctrl && name === 'a') { col = 0; return { changed: true }; }
    if (ctrl && name === 'e') { col = lines[row].length; return { changed: true }; }
    if (ctrl && name === 'u') { lines[row] = lines[row].slice(col); col = 0; return { changed: true }; }
    if (ctrl && name === 'k') { lines[row] = lines[row].slice(0, col); return { changed: true }; }

    switch (name) {
      case 'return':
      case 'enter': {
        // Shift/Alt-Enter and a trailing backslash both mean "keep going" —
        // two spellings because terminals disagree about which they can send.
        if (key.shift || meta || lines[row].endsWith('\\')) {
          const rest = lines[row].slice(col);
          lines[row] = lines[row].slice(0, col);
          lines.splice(row + 1, 0, rest);
          row += 1; col = 0;
          return { changed: true };
        }
        return submit();
      }
      case 'backspace':
        if (col > 0) { lines[row] = lines[row].slice(0, col - 1) + lines[row].slice(col); col -= 1; }
        else if (row > 0) { const merged = lines[row]; lines.splice(row, 1); row -= 1; col = lines[row].length; lines[row] += merged; }
        return { changed: true };
      case 'delete':
        if (col < lines[row].length) lines[row] = lines[row].slice(0, col) + lines[row].slice(col + 1);
        else if (row < lines.length - 1) { lines[row] += lines[row + 1]; lines.splice(row + 1, 1); }
        return { changed: true };
      case 'left':
        if (col > 0) col -= 1;
        else if (row > 0) { row -= 1; col = lines[row].length; }
        return { changed: true };
      case 'right':
        if (col < lines[row].length) col += 1;
        else if (row < lines.length - 1) { row += 1; col = 0; }
        return { changed: true };
      case 'up':
        // History only at the TOP edge: inside a multiline buffer, Up is
        // cursor movement, and recalling instead would destroy what is typed.
        if (row > 0) { row -= 1; clampCursor(); return { changed: true }; }
        return { changed: recallHistory('back') };
      case 'down':
        if (row < lines.length - 1) { row += 1; clampCursor(); return { changed: true }; }
        return { changed: recallHistory('forward') };
      case 'home': col = 0; return { changed: true };
      case 'end': col = lines[row].length; return { changed: true };
      default: break;
    }

    if (!ctrl && !meta && isPrintable(str)) { insert(str); return { changed: true }; }
    // Anything else — an unmapped escape, a stray control byte — is a key press
    // the composer does not know, and a key press is never text.
    return { changed: false };
  }

  /** Every rendered row, border included. The caller clears exactly
   * `height` lines before repainting, so this and `height` must agree. */
  function render() {
    const inner = Math.max(1, width - 2);
    // A leading space so the caret is not welded to the border.
    const caret = ` ${glyphs.caret} `;
    const rows = [];
    lines.forEach((line, i) => {
      const prefix = i === 0 ? caret : ' '.repeat(caret.length);
      for (const [j, piece] of wrap(line, inner - caret.length).entries()) {
        rows.push(`${j === 0 ? prefix : ' '.repeat(caret.length)}${piece}`);
      }
    });

    const title = label ? ` ${label} ` : '';
    const tail = hint ? ` ${hint} ` : '';
    const barLength = Math.max(0, width - 2 - visibleWidth(title) - visibleWidth(tail));
    const left = Math.min(1, barLength);
    const top = `${glyphs.topLeft}${glyphs.horizontal.repeat(left)}${paint('info', title)}${glyphs.horizontal.repeat(barLength - left)}${paint('muted', tail)}${glyphs.topRight}`;
    const bottom = `${glyphs.bottomLeft}${glyphs.horizontal.repeat(Math.max(0, width - 2))}${glyphs.bottomRight}`;

    return [
      top,
      ...rows.map((r) => `${glyphs.vertical}${r}${' '.repeat(Math.max(0, inner - visibleWidth(r)))}${glyphs.vertical}`),
      bottom,
    ];
  }

  return {
    handleKey,
    render,
    get value() { return currentValue(); },
    get lines() { return [...lines]; },
    get height() { return render().length; },
    get history() { return [...past]; },
    /** Where the terminal cursor belongs, relative to the block's first line. */
    get cursor() {
      const caretWidth = 3;
      const inner = Math.max(1, width - 2) - caretWidth;
      let y = 1;
      for (let i = 0; i < row; i += 1) y += wrap(lines[i], inner).length;
      y += Math.floor(col / inner);
      return { row: y, col: 1 + caretWidth + (col % inner) };
    },
    setWidth(next) { width = Math.max(8, next); },
    setLabel(next) { label = next; },
    setHint(next) { hint = next; },
  };
}
