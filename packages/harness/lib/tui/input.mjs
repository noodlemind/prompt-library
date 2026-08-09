/**
 * Binding the composer to a real terminal (P4bAC10, P4bAC12).
 *
 * This is the ONLY part of the ledger that needs a TTY, and it is deliberately
 * the part with the least thinking in it: read a keypress, hand it to the
 * composer, repaint what the composer says to paint. Every decision — what a
 * key means, what the block looks like, how tall it is — lives in
 * `composer.mjs`, where a test can reach it without a pty. The phase-4b
 * reopening happened because that split did not exist and the untestable half
 * was the whole product.
 *
 * REPAINT IN PLACE, IN THE MAIN BUFFER. The composer occupies the last N lines
 * of the terminal; a repaint moves the cursor up N, clears to the end of the
 * screen, and draws again. Nothing above is touched, so scrollback, selection
 * and the terminal's own search keep working — which is what P4bAC2 always
 * meant and what the alt-screen alternative would have cost.
 *
 * WRITING TO THE TRANSCRIPT GOES THROUGH `write`, which erases the block first
 * and repaints after. A caller that wrote to the stream directly would leave
 * the composer's old pixels stranded mid-scrollback, so the session's `write`
 * is the one that must be used.
 */
import readline from 'node:readline';
import { createComposer } from './composer.mjs';
import { renderStatus } from './status.mjs';

const ESC = '';

export function createInput({
  input,
  output,
  ui,
  interactive = Boolean(input.isTTY),
  label = '',
  hint = '',
  ascii = false,
  history = [],
} = {}) {
  const width = () => Math.max(24, Math.min(output.columns || 80, 120));
  const composer = createComposer({
    width: width(), ascii, history, label, hint, paint: (t, s) => ui.paint(t, s),
  });
  let status = {};
  let painted = 0;
  // Where the cursor was PARKED inside the block by the last paint, counted in
  // lines down from the block's first row. `erase` has to walk back exactly
  // this far; assuming the cursor sat below the block (which it never does,
  // because parking it is the last thing paint does) overshot by the same
  // amount and left the old box on screen — so the next paint drew a second
  // box inside the first.
  let parkedRow = 0;
  let resolveLine = null;
  let closed = false;
  let suspended = false;

  const blockLines = () => {
    const lines = composer.render();
    const statusLine = renderStatus(status, { width: width(), paint: (t, s) => ui.paint(t, s) });
    return statusLine ? [...lines, `  ${statusLine}`] : lines;
  };

  const erase = () => {
    if (!interactive || painted === 0) return;
    if (parkedRow > 0) output.write(`${ESC}[${parkedRow}A`);
    output.write(`\r${ESC}[0J`);
    painted = 0;
    parkedRow = 0;
  };

  const paint = () => {
    if (!interactive || closed || suspended) return;
    // Always a full redraw. `next()` and `write()` both used to paint, so a
    // submitted line painted twice with no erase between — the second box drawn
    // inside the first. Making paint idempotent removes the ordering rule
    // rather than asking every caller to remember it.
    erase();
    composer.setWidth(width());
    const lines = blockLines();
    output.write(`${lines.join('\n')}\n`);
    painted = lines.length;
    // Park the cursor where the next character will go: up from the line below
    // the block, then across. Without this it sits under the box and typing
    // looks like it is happening somewhere else.
    const { row, col } = composer.cursor;
    parkedRow = Math.max(0, Math.min(row, painted - 1));
    output.write(`${ESC}[${painted - parkedRow}A\r${ESC}[${col}C`);
  };

  /** Write into the transcript above the composer. */
  const write = (line = '') => {
    erase();
    output.write(`${line}\n`);
    paint();
  };

  const onKeypress = (str, key = {}) => {
    if (closed || !resolveLine) return;
    const result = composer.handleKey(str, key);
    if (result.intent === 'exit') { const r = resolveLine; resolveLine = null; erase(); r({ intent: 'exit' }); return; }
    if (result.intent === 'palette') { const r = resolveLine; resolveLine = null; erase(); r({ intent: 'palette' }); return; }
    if (result.intent === 'cancel') { const r = resolveLine; resolveLine = null; erase(); r({ intent: 'cancel', hadInput: result.hadInput }); return; }
    if (result.submitted !== undefined) {
      const r = resolveLine;
      resolveLine = null;
      erase();
      r({ line: result.submitted });
      return;
    }
    if (result.changed) { erase(); paint(); }
  };

  let rl = null;
  if (interactive) {
    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.on('keypress', onKeypress);
    output.on?.('resize', () => { erase(); paint(); });
  } else {
    // The piped path is unchanged and stays scriptable: no raw mode, no
    // repaint, one line per line. Every existing test drives this.
    rl = readline.createInterface({ input, output, terminal: false });
  }

  const lineIterator = rl ? rl[Symbol.asyncIterator]() : null;

  return {
    interactive,
    write,
    composer,
    setStatus(next) { status = { ...status, ...next }; if (interactive) { erase(); paint(); } },
    setLabel(next) { composer.setLabel(next); },
    /**
     * Clear the visible screen and repaint the composer.
     *
     * Uses CSI 2J (erase display) + cursor home — NOT 3J, which also wipes
     * scrollback. The ledger is a scrolling transcript; operators clear the
     * viewport, not the history the design exists to keep (P4bAC2).
     *
     * A session builtin, not `!clear`: governed bash strips enough of the
     * environment that terminfo cannot resolve ghostty/kitty/etc., so
     * shelling out to `clear` fails with "unknown terminal type" on the
     * terminals people actually use.
     */
    clearScreen() {
      erase();
      if (interactive && output.isTTY) {
        output.write(`${ESC}[2J${ESC}[H`);
      }
      painted = 0;
      paint();
    },
    /**
     * Take the composer off screen while something else owns stdout.
     *
     * THE DEFECT THIS FIXES: every harness command prints with `console.log`,
     * straight to the stream, with no idea a composer is painted below the
     * cursor. `status` therefore wrote its rows THROUGH the box — output
     * interleaved with the border, and a second composer stranded underneath.
     * The module note above warned that a caller writing directly would strand
     * the block; the commands themselves are exactly that caller, and wrapping
     * their dispatch is the only place that can be fixed once for all of them.
     */
    suspend() { erase(); suspended = true; },
    resume() { suspended = false; paint(); },

    /** The next thing the operator did: a line, or an intent the loop owns. */
    async next() {
      if (!interactive) {
        const { value, done } = await lineIterator.next();
        return done ? { intent: 'exit' } : { line: String(value ?? '') };
      }
      paint();
      return new Promise((resolve) => { resolveLine = resolve; });
    },
    /** Echo a submitted line into the transcript, the way a shell does — so the
     * session reads as a record of what was asked, not only of what happened. */
    echo(line) {
      if (!interactive || !line) return;
      write(`${ui.paint('muted', composer.render()[0] ? '' : '')}${ui.paint('ok', '❯')} ${line}`);
    },
    close() {
      closed = true;
      erase();
      if (interactive) {
        input.off?.('keypress', onKeypress);
        if (input.isTTY) { try { input.setRawMode(false); } catch { /* already gone */ } }
      }
      rl?.close();
    },
  };
}
