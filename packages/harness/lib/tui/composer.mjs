/**
 * The composer — two hairlines, not a box.
 *
 * WHY THIS WAS REWRITTEN. Phase 4b shipped a four-sided rounded box
 * (`╭─╮ │ ╰─╯`). The approved design says the opposite in as many words: the
 * persistent chrome is a two-hairline editor and one dim footer, and block
 * meaning comes from tints rather than borders. Four dashboard-styled variants
 * had already been rejected before the research round that produced it. The box
 * was not a reading of the design — it was written without opening it.
 *
 * So: a rule above, a rule below, and the text between them sitting flush with
 * the ledger above it. The two rules carry the GATE STATE as colour, which is
 * the one adaptation the design takes from Pi (whose editor border carries
 * thinking level). That is a real channel, not decoration: it answers "will the
 * next mutating command be refused" at the exact point you are deciding what to
 * type, without spending a row on it.
 *
 * WHY IT REMAINS A STATE MACHINE. A keypress goes in; state and rendered lines
 * come out. Nothing here needs a terminal, which is the only reason any of it
 * can be tested — the phase-4b reopening happened because the untestable half
 * was the entire product.
 *
 * MEASUREMENT GOES THROUGH `width.mjs`. Every length in the previous version
 * was `[...text].length`, which is code points. Hairlines drawn from a code
 * point count come out short on CJK and long on combining marks, and a wrap
 * computed the same way splits emoji in half.
 */
import { displayWidth, graphemes, wrapCells, cellOffset } from './width.mjs';

const UNICODE = { rule: '─', caret: '❯' };
const ASCII = { rule: '-', caret: '>' };

export const DEFAULT_HISTORY_LIMIT = 200;

/** Gate state → the token the hairlines are painted in. Unknown gate reads as
 * muted rather than green: an unverified gate is not a passing one. */
const GATE_TOKEN = {
  pass: 'ok',
  ok: 'ok',
  blocked: 'warn',
  failed: 'error',
  expired: 'warn',
};

/** A control character is a key press, never text. Inserting one is how a raw
 * escape sequence used to end up in the dispatched command. */
const isPrintable = (ch) => typeof ch === 'string' && ch.length >= 1 && ch >= ' ' && ch !== '\x7f';

export function createComposer({
  width = 80,
  ascii = false,
  history = [],
  historyLimit = DEFAULT_HISTORY_LIMIT,
  hint = '',
  gate = null,
  paint = (_token, text) => text,
  // The palette chord is configurable per the contract; `Ctrl-P` is the default
  // because `Ctrl-K` is readline's kill-to-end-of-line and taking it would cost
  // a reflex every shell user already has. The design mock's `ctrl+k` is
  // honoured as an ALIAS when the line is empty — there is nothing to kill
  // then, so both muscle memories can be right.
  paletteChord = 'ctrl+p',
  /**
   * Is this word a real command, verb, or flag? The loop supplies it from the
   * registry; without it every line paints as plain text.
   *
   * WHY THE EDITOR PAINTS AT ALL: Claude Code colours a recognised slash
   * command the moment it is complete, so you know BEFORE pressing Enter
   * whether you typed a capability or a sentence. The harness had one input
   * that accepted both governed commands and shell escapes and rendered them
   * identically — a typo and a real command looked the same until the block
   * came back with `unknown`.
   */
  classify = null,
} = {}) {
  const glyphs = ascii ? ASCII : UNICODE;
  // Lines are arrays of grapheme clusters, not strings: every cursor movement,
  // insertion and deletion is then in the same units the renderer measures in,
  // so a combining mark can never be half-deleted.
  let lines = [[]];
  let row = 0;
  let col = 0;
  const past = [...history];
  let historyIndex = null;
  let draft = null;
  let completion = null;
  /** Right-embedded label on the top rule — mode and posture, the way Claude
   * Code carries the session title in its hairline and Amp carries the mode in
   * its border. A rule is a row already being spent; the label rides free. */
  let ruleLabel = '';
  /**
   * Bash mode — `!` on an empty line, sticky until Esc.
   *
   * WHY A MODE AND NOT A PREFIX. `!` and `!!` both read as "shell" in Pi and
   * Claude Code, so using `!!` for re-run put two different meanings behind
   * one sigil that every operator's muscle memory already assigns to the
   * shell. Antigravity resolves it by making `!` a MODE the surface announces
   * ("activated bash mode · esc to cancel") and giving re-run its own named
   * command. The mode also removes a per-line tax: a session spent in the
   * shell types `!` once rather than on every line.
   */
  let bashMode = false;
  /** Muted text shown while the buffer is empty (Codex, Grok). Vanishes on
   * the first keystroke; never part of the value. Overridable: when the ledger
   * is collecting a value, the QUESTION sits here — at the composer, where the
   * answer is typed — rather than in the transcript forty rows away. */
  // ASKING IS LISTED FIRST because it is what a bare line now does — a
  // placeholder that named only commands was why a typed sentence came back
  // as `unknown`.
  const DEFAULT_PLACEHOLDER = 'ask, or run a command · / for the palette';
  let placeholder = DEFAULT_PLACEHOLDER;

  const asText = (clusters) => clusters.join('');
  const clampCursor = () => {
    row = Math.max(0, Math.min(row, lines.length - 1));
    col = Math.max(0, Math.min(col, lines[row].length));
  };
  const setValue = (text) => {
    lines = String(text).split('\n').map((l) => graphemes(l));
    if (!lines.length) lines = [[]];
    row = lines.length - 1;
    col = lines[row].length;
  };
  const insert = (text) => {
    const clusters = graphemes(text);
    lines[row].splice(col, 0, ...clusters);
    col += clusters.length;
    historyIndex = null;
  };

  const currentValue = () => lines.map(asText).join('\n');
  /** As dispatched: rows joined by a space, because a multiline entry is one
   * command typed across several rows, not several commands. */
  const dispatchValue = () => lines.map((l) => asText(l).replace(/\\$/, '').trim()).filter(Boolean).join(' ');

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
    lines = [[]]; row = 0; col = 0; historyIndex = null; draft = null; completion = null;
    if (!value) return { changed: true };
    past.push(value);
    while (past.length > historyLimit) past.shift();
    // The mode STAYS ON after a run — a session in the shell is usually there
    // for more than one command, and Esc is the way out.
    return { submitted: value, bash: bashMode, changed: true };
  }

  /**
   * The `@` token under the cursor, if there is one.
   *
   * Returned as a range so an accepted completion replaces exactly what was
   * typed. Scanning backwards from the cursor rather than tokenising the whole
   * line keeps `@` working mid-command (`get @docs/plans/x.md --json`), which is
   * where it is actually used.
   */
  function activeReference() {
    const clusters = lines[row];
    // AT COLUMN 0 THERE IS NOTHING BEHIND THE CURSOR. Without this the scan
    // fell straight through, `start` landed on 0, and a line beginning with
    // `@` reported a zero-width reference — so Home (or ctrl-a) followed by Tab
    // spliced the chosen path in FRONT of the token instead of replacing it.
    if (col === 0) return null;
    let start = col - 1;
    while (start >= 0 && !/\s/.test(clusters[start])) start -= 1;
    start += 1;
    if (clusters[start] !== '@') return null;
    return { start, end: col, prefix: clusters.slice(start + 1, col).join('') };
  }

  /** Replace the active `@` token with a chosen path. */
  function applyCompletion(pathText) {
    const ref = activeReference();
    if (!ref) return false;
    const replacement = graphemes(`@${pathText}`);
    lines[row].splice(ref.start, ref.end - ref.start, ...replacement);
    col = ref.start + replacement.length;
    completion = null;
    return true;
  }

  const matchesPaletteChord = (name, ctrl, meta) => {
    if (paletteChord === 'ctrl+p') return ctrl && name === 'p';
    if (paletteChord === 'ctrl+k') return ctrl && name === 'k';
    if (paletteChord === 'ctrl+space') return ctrl && name === 'space';
    return ctrl && name === 'p';
  };

  /**
   * One key press.
   *
   * Returns `{ submitted?, intent?, changed }`. `intent` is for what the
   * composer recognises but does not own — opening the palette, leaving for
   * block navigation, cancelling, closing — so the loop keeps those decisions.
   */
  function handleKey(str, key = {}) {
    const name = key.name;
    const ctrl = Boolean(key.ctrl);
    const meta = Boolean(key.meta);
    const shift = Boolean(key.shift);

    // Chords first: one that fell through to the printable branch would type a
    // character instead of opening what it names.
    if (matchesPaletteChord(name, ctrl, meta)) return { intent: 'palette', changed: false };
    if (meta && name === 'k') return { intent: 'palette', changed: false };
    // The mock's chord, honoured only with an empty line — see `paletteChord`.
    if (ctrl && name === 'k' && !dispatchValue()) return { intent: 'palette', changed: false };
    // `ctrl+↑` hands the arrow keys to the ledger. The design puts block
    // navigation behind a chord precisely so a long-running child program can
    // never claim it, the way page-up and home get claimed.
    if (ctrl && name === 'up') return { intent: 'navigate', changed: false };
    if (ctrl && name === 'c') {
      const had = Boolean(dispatchValue());
      lines = [[]]; row = 0; col = 0; historyIndex = null; completion = null;
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
    if (ctrl && name === 'o') return { intent: 'fold', changed: false };
    // Ctrl-L clears the viewport and Ctrl-J inserts a newline: both are
    // readline reflexes every reference honours (Antigravity binds them as
    // `cli.clear_screen` and `prompt.newline`), and both were reachable here
    // only through a typed word or a chord terminals disagree about.
    if (ctrl && name === 'l') return { intent: 'clear', changed: false };
    if (ctrl && name === 'j') {
      const rest = lines[row].slice(col);
      lines[row] = lines[row].slice(0, col);
      lines.splice(row + 1, 0, rest);
      row += 1; col = 0;
      return { changed: true };
    }

    if (name === 'escape' && bashMode) {
      bashMode = false;
      return { intent: 'bash-mode', changed: true };
    }

    if (name === 'escape') {
      // Esc interrupts a running command; the loop decides, because only it
      // knows whether one is running. A second Esc opens the run tree, and that
      // pairing is the loop's to time.
      return { intent: 'escape', changed: false };
    }

    // Completion navigation comes before the plain arrow handlers: while a
    // completion list is open, the arrows belong to it.
    if (completion?.items?.length) {
      if (name === 'up') { completion.index = (completion.index - 1 + completion.items.length) % completion.items.length; return { changed: true }; }
      if (name === 'down') { completion.index = (completion.index + 1) % completion.items.length; return { changed: true }; }
      if (name === 'tab' || name === 'return' || name === 'enter') {
        const chosen = completion.items[completion.index];
        if (chosen && applyCompletion(chosen.path ?? chosen)) return { changed: true };
      }
    }
    // SHIFT+TAB CYCLES THE MODE — the gesture Claude Code, Amp and Antigravity
    // all spend on "what does this surface do with what I type". Here there are
    // two answers and one gate between them: commands only, or commands plus
    // anything else being a question. Checked before plain Tab, which completes.
    if (name === 'tab' && shift) return { intent: 'agent-mode', changed: false };
    if (name === 'tab') {
      const ref = activeReference();
      if (ref) return { intent: 'complete', prefix: ref.prefix, changed: false };
    }

    switch (name) {
      case 'return':
      case 'enter': {
        // Shift/Alt-Enter and a trailing backslash both mean "keep going" — two
        // spellings because terminals disagree about which they can send.
        if (shift || meta || asText(lines[row]).endsWith('\\')) {
          const rest = lines[row].slice(col);
          lines[row] = lines[row].slice(0, col);
          lines.splice(row + 1, 0, rest);
          row += 1; col = 0;
          return { changed: true };
        }
        return submit();
      }
      case 'backspace':
        if (col > 0) { lines[row].splice(col - 1, 1); col -= 1; }
        else if (row > 0) { const merged = lines[row]; lines.splice(row, 1); row -= 1; col = lines[row].length; lines[row] = [...lines[row], ...merged]; }
        completion = null;
        return { changed: true };
      case 'delete':
        if (col < lines[row].length) lines[row].splice(col, 1);
        else if (row < lines.length - 1) { lines[row] = [...lines[row], ...lines[row + 1]]; lines.splice(row + 1, 1); }
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
        // History only at the TOP edge: inside a multiline buffer Up is cursor
        // movement, and recalling instead would destroy what is typed.
        if (row > 0) { row -= 1; clampCursor(); return { changed: true }; }
        return { changed: recallHistory('back') };
      case 'down':
        if (row < lines.length - 1) { row += 1; clampCursor(); return { changed: true }; }
        return { changed: recallHistory('forward') };
      case 'home': col = 0; return { changed: true };
      case 'end': col = lines[row].length; return { changed: true };
      default: break;
    }

    if (!ctrl && !meta && isPrintable(str)) {
      // `/` AT THE START OF AN EMPTY LINE IS THE PALETTE, IMMEDIATELY — not
      // after Enter. Typing the sigil is the request; making someone finish
      // the word, press Enter, read a printed list and type a number is the
      // flow every reference CLI abandoned. The overlay filters live from the
      // next keystroke. Anywhere else `/` is a character, because paths are
      // typed mid-command (`get docs/plans/x.md`) far more often than the
      // palette is wanted mid-word.
      const atStartOfEmptyLine = row === 0 && col === 0 && lines.length === 1 && lines[0].length === 0;
      if (str === '/' && atStartOfEmptyLine && !bashMode) {
        return { intent: 'palette', changed: false };
      }
      // The sigil is consumed by the mode it opens, exactly as `/` is.
      if (str === '!' && atStartOfEmptyLine && !bashMode) {
        bashMode = true;
        return { intent: 'bash-mode', changed: true };
      }
      insert(str);
      completion = null;
      // Typing `@` is itself the request for a completion list — asking someone
      // to press Tab after a sigil that exists to save typing is a poor trade.
      const ref = activeReference();
      if (ref) return { intent: 'complete', prefix: ref.prefix, changed: true };
      return { changed: true };
    }
    // Anything else — an unmapped escape, a stray control byte — is a key press
    // the composer does not know, and a key press is never text.
    return { changed: false };
  }

  /**
   * Every rendered row: a rule, the text, a rule, and the hint.
   *
   * The caller clears exactly `height` lines before repainting, so this and
   * `height` must agree — which is why the hint is rendered here rather than
   * being printed separately by the loop.
   */
  function render() {
    const caret = `${glyphs.caret} `;
    const caretCells = displayWidth(caret);
    const inner = Math.max(8, width - caretCells);
    const token = GATE_TOKEN[gate] ?? 'muted';
    const rule = paint(token, glyphs.rule.repeat(Math.max(1, width)));
    // The top rule carries the label right-aligned inside it — Claude Code's
    // `── title ──` shape. The bottom rule stays plain.
    let topRule = rule;
    if (ruleLabel) {
      const tail = ` ${ruleLabel} `;
      const lead = Math.max(1, width - displayWidth(tail) - 2);
      topRule = paint(token, glyphs.rule.repeat(lead)) + paint('muted', tail) + paint(token, glyphs.rule.repeat(2));
    }

    const body = [];
    const empty = lines.length === 1 && lines[0].length === 0;
    // In bash mode the caret IS the sigil, painted warn: the same colour the
    // ledger gives an execute-class command, because that is what the next
    // Enter will be.
    const caretOut = bashMode ? paint('warn', `${ascii ? '!' : '!'} `) : paint('info', caret);
    if (empty) {
      body.push(`${caretOut}${paint('muted', bashMode ? 'shell command · esc leaves bash mode' : placeholder)}`);
    } else {
      lines.forEach((clusters, i) => {
        const text = asText(clusters);
        const wrapped = wrapCells(text, inner);
        wrapped.forEach((piece, j) => {
          const prefix = i === 0 && j === 0 ? caretOut : ' '.repeat(caretCells);
          // Highlighting applies to an UNWRAPPED first row only: painting
          // across a wrap boundary would need the escape state carried between
          // rows, and a long multiline command is the case where the shape is
          // already obvious.
          const shown = i === 0 && wrapped.length === 1 ? highlight(piece) : piece;
          body.push(`${prefix}${shown}`);
        });
      });
    }

    const out = [topRule, ...body, rule];
    // The completion list sits DIRECTLY under the editor it refines; the hint
    // row stays last. The other order wedged the consequence row between the
    // `@` token and its candidates, which read as the list belonging to the
    // hint rather than to what was being typed.
    if (completion?.items?.length) out.push(...renderCompletion());
    if (hint) out.push(hint);
    return out;
  }

  /**
   * Paint the parts of a line the harness recognises.
   *
   * Four classes, each already meaning something in the design system: a
   * COMMAND or session word is `info` (the colour of a thing you can act on),
   * a VERB is `ok` (it completes a command into something runnable), a FLAG is
   * `warn` (it changes what happens), and a sigil is `info` because it is the
   * strongest signal of all. Everything unrecognised stays plain ink — which
   * is itself the signal: a command that does not light up is a command that
   * does not exist.
   */
  function highlight(text) {
    if (bashMode) return text; // the shell owns this grammar, not the registry
    if (!classify || !text) return text;
    // Shell escapes and re-runs are their own grammar: paint the sigil and
    // leave the script alone, because the shell owns what follows.
    const sigil = /^(!!|!|@|\/)/.exec(text);
    if (sigil) {
      return `${paint('info', sigil[1])}${text.slice(sigil[1].length)}`;
    }
    // The line's HEAD is what makes a later word a verb: `run` is a command,
    // `checks run` is a verb, and the classifier cannot tell them apart
    // without knowing which word came first.
    const head = (text.trim().split(/\s+/)[0] || '');
    let index = -1;
    return text.replace(/\S+/g, (word) => {
      index += 1;
      const kind = classify(word, { first: index === 0, head });
      if (kind === 'command' || kind === 'session') return paint('info', word);
      if (kind === 'verb') return paint('ok', word);
      if (kind === 'flag') return paint('warn', word);
      return word;
    });
  }

  /** The `@` list, drawn under the editor as an inline chooser rather than an
   * overlay: it is a refinement of what is already being typed, so moving the
   * eye somewhere else to pick would be the wrong gesture. */
  function renderCompletion() {
    const items = completion.items.slice(0, 6);
    return items.map((item, i) => {
      const path = item.path ?? item;
      const chosen = i === completion.index;
      const mark = chosen ? paint('info', ascii ? '>' : '❯') : ' ';
      const note = item.kind ? paint('muted', ` · ${item.kind}`) : '';
      return `${mark} ${chosen ? path : paint('muted', path)}${note}`;
    });
  }

  return {
    handleKey,
    render,
    get value() { return currentValue(); },
    get lines() { return lines.map(asText); },
    get height() { return render().length; },
    get history() { return [...past]; },
    get reference() { return activeReference(); },
    get completionOpen() { return Boolean(completion?.items?.length); },
    /** Where the terminal cursor belongs, relative to the block's first line.
     * Row 0 is the top rule, so the text starts at 1. */
    get cursor() {
      const caretCells = displayWidth(`${glyphs.caret} `);
      const inner = Math.max(8, width - caretCells);
      let y = 1;
      for (let i = 0; i < row; i += 1) y += wrapCells(asText(lines[i]), inner).length;
      const cells = cellOffset(asText(lines[row]), col);
      y += Math.floor(cells / inner);
      return { row: y, col: caretCells + (cells % inner) };
    },
    setWidth(next) { width = Math.max(24, next); },
    setHint(next) { hint = next; },
    setRuleLabel(next) { ruleLabel = String(next ?? ''); },
    setPlaceholder(next) { placeholder = next == null ? DEFAULT_PLACEHOLDER : String(next); },
    get bashMode() { return bashMode; },
    setBashMode(on) { bashMode = Boolean(on); },
    setGate(next) { gate = next; },
    setCompletion(items) {
      completion = items?.length ? { items, index: 0 } : null;
    },
    clearCompletion() { completion = null; },
    setValue,
  };
}
