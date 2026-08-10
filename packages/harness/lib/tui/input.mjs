/**
 * Binding the ledger to a real terminal.
 *
 * THIS IS THE ONLY PART THAT NEEDS A TTY, and it is deliberately the part with
 * the least thinking in it: read a keypress, hand it to whatever currently owns
 * input, repaint what that thing says to paint. Every decision — what a key
 * means, what a block looks like, how tall it is — lives in a module a test can
 * reach without a pty. The phase-4b reopening happened because that split did
 * not exist and the untestable half was the entire product.
 *
 * THE BOTTOM REGION is everything that repaints in place:
 *
 *     [ live block — the running command, sticky header + streaming tail ]
 *     [ composer (two hairlines) OR an overlay, never both ]
 *     [ hint row ]
 *     [ footer ]
 *
 * Everything above it is committed scrollback and is never touched again. That
 * is what keeps selection, the terminal's own search, and scrollback itself
 * working — the whole reason the design declines the alternate screen.
 *
 * COMMAND OUTPUT IS CAPTURED, NOT PASSED THROUGH. Every harness command prints
 * with `console.log`, straight to the stream, with no idea a region is painted
 * below the cursor. Phase 4b's answer was to take the composer off screen for
 * the duration, which fixed the corruption and cost the design its central
 * idea: output that goes straight to the terminal is not a block, cannot be
 * tinted, folded, marked or re-run, and is not a record of anything. So stdout
 * is intercepted for the duration of a dispatch and the lines become the
 * block's. See `capture`.
 */
import readline from 'node:readline';
import { createComposer } from './composer.mjs';
import { renderFooter, renderHint } from './chrome.mjs';
import { renderOverlay } from './overlay.mjs';
import { renderBlock, runningHeader } from './block.mjs';

const ESC = '\x1b';

/** How much of a running command's output stays on screen while it runs. The
 * rest is in the block; this is the tail you watch. */
export const LIVE_TAIL = 8;

export function createInput({
  input,
  output,
  ui,
  interactive = Boolean(input.isTTY),
  ascii = false,
  history = [],
  footerItems,
  paletteChord = 'ctrl+p',
  /**
   * The alternate screen, for operators who want the trade the other way.
   *
   * Off by default and stated as a commitment rather than a preference: the
   * alternate screen costs scrollback, selection and the terminal's own search,
   * which is why the design puts the ledger in the main buffer. It is a config
   * because Codex and Amp both shipped alt-screen and were both forced to add
   * an escape hatch — the pressure exists in both directions, and a tool that
   * refuses to have the argument just gets forked.
   */
  altScreen = false,
  /**
   * Called when Ctrl-C or Esc arrives while NO `next()` is pending — that is,
   * while a command is running.
   *
   * THIS IS THE WHOLE CANCELLATION STORY, and it replaces a worse one. Phase 4b
   * dropped raw mode for the duration of a dispatch so the terminal's own
   * SIGINT would fire, because in raw mode Ctrl-C is a keypress and keypresses
   * were discarded whenever no promise was waiting — which is exactly the
   * window a command runs in.
   *
   * Capturing output instead of passing it through means the region stays on
   * screen for the whole run, so raw mode has to stay on: the live block
   * repaints, and Esc — which the sticky header promises cancels — is a
   * keypress that only exists in raw mode. So the interrupt is handled here
   * rather than being handed back to the tty.
   */
  onInterrupt = null,
} = {}) {
  const width = () => Math.max(40, Math.min(output.columns || 80, 160));
  const composer = createComposer({
    width: width(), ascii, history, paint: (t, s) => ui.paint(t, s), paletteChord,
  });
  let status = {};
  let hintState = { mode: 'deliver', gate: null, shell: 'allowed', rerun: null };
  let overlay = null;
  let live = null;
  let painted = 0;
  // Where the cursor was PARKED inside the region by the last paint, counted in
  // lines down from the region's first row. `erase` walks back exactly this
  // far; assuming the cursor sat below the region (it never does, because
  // parking it is the last thing paint does) overshot and left the old region
  // on screen, so the next paint drew a second one inside the first.
  let parkedRow = 0;
  let resolveEvent = null;
  let closed = false;
  /**
   * The real stdout writer, held while `capture` owns `output.write`.
   *
   * WITHOUT THIS the region draws itself into the block it is drawing. `capture`
   * replaces `output.write` so a command's `console.log` becomes block content;
   * `paint` then calls `output.write` too, so every live repaint — hairlines,
   * sticky header, footer — was appended to the running command's output and
   * committed to scrollback as if the command had printed it. The real-pty
   * capture showed a block that contained its own editor.
   */
  let rawWrite = null;
  const emit = (text) => (rawWrite ?? output.write.bind(output))(text);

  /** The rows of the bottom region, in order. */
  const regionLines = () => {
    const w = width();
    const rows = [];
    if (live?.block) {
      rows.push(runningHeader(live.block, { ui, width: w, lineCount: live.block.lines.length }));
      const tail = live.block.lines.slice(-LIVE_TAIL);
      for (const line of tail) {
        rows.push(...renderBlock(
          { ...live.block, command: '', lines: [line], tally: null, next: null, kind: 'note-row' },
          { ui, width: w, showRecord: false },
        ));
      }
    }
    if (overlay) rows.push(...renderOverlay(overlay, { ui, width: w }));
    else {
      composer.setWidth(w);
      composer.setHint(renderHint({ ui, width: w, ...hintState }));
      rows.push(...composer.render());
    }
    // ONE footer renderer for every state of the session. There used to be a
    // fallback to the older single-row status when no lifecycle facts existed
    // yet, which meant the footer changed shape after the first command — and
    // the new shape dropped the workspace. `renderFooter` now carries the
    // workspace unconditionally, so the fallback (and the inconsistency) died.
    const footer = renderFooter(status, { ui, width: w, items: footerItems });
    if (footer) rows.push(footer);
    return rows;
  };

  /** Where the terminal cursor belongs inside the region. */
  const cursorInRegion = () => {
    let offset = 0;
    if (live?.block) offset += 1 + Math.min(live.block.lines.length, LIVE_TAIL);
    if (overlay) {
      // Inside an overlay the cursor sits at the end of the typed query, which
      // is row 1 of the box (row 0 is the top edge).
      return { row: offset + 1, col: ui.stripAnsi(`  ${overlay.title ? `${overlay.title} ` : ''}${overlay.query}`).length + 2 };
    }
    const c = composer.cursor;
    return { row: offset + c.row, col: c.col };
  };

  /**
   * One visual update, delivered atomically.
   *
   * A repaint is an erase followed by a redraw, and a terminal that renders
   * between the two shows the region missing for a frame — the flicker every
   * keystroke used to produce. CSI ?2026 (synchronized output) tells the
   * terminal to hold rendering until the frame is complete; terminals that do
   * not support it ignore the sequence and behave exactly as before, so this
   * costs nothing where it does not help. The research round named rendering
   * smoothness a converged feature of the field, not a nicety.
   */
  const frame = (fn) => {
    const sync = interactive && Boolean(output.isTTY);
    if (sync) emit(`${ESC}[?2026h`);
    try {
      fn();
    } finally {
      if (sync) emit(`${ESC}[?2026l`);
    }
  };

  const erase = () => {
    if (!interactive || painted === 0) return;
    if (parkedRow > 0) emit(`${ESC}[${parkedRow}A`);
    emit(`\r${ESC}[0J`);
    painted = 0;
    parkedRow = 0;
  };

  const paint = () => {
    if (!interactive || closed) return;
    // Always a full redraw. Making paint idempotent removes an ordering rule
    // rather than asking every caller to remember it.
    erase();
    const lines = regionLines();
    emit(`${lines.join('\n')}\n`);
    painted = lines.length;
    const { row, col } = cursorInRegion();
    parkedRow = Math.max(0, Math.min(row, painted - 1));
    emit(`${ESC}[${painted - parkedRow}A\r${col > 0 ? `${ESC}[${col}C` : ''}`);
  };

  /** Commit rows into scrollback, above the region. Once written they are
   * never touched again. */
  const commit = (lines) => {
    const rows = Array.isArray(lines) ? lines : [lines];
    if (!rows.length) return;
    frame(() => {
      erase();
      emit(`${rows.join('\n')}\n`);
      paint();
    });
  };

  const onResize = () => { frame(() => { erase(); paint(); }); };

  const onKeypress = (str, key = {}) => {
    if (closed) return;
    // Interrupts are read BEFORE the pending-promise check, because the moment
    // they matter most is the moment no promise is pending. See `onInterrupt`.
    if (!resolveEvent) {
      const isCtrlC = Boolean(key.ctrl) && key.name === 'c';
      if ((isCtrlC || key.name === 'escape') && typeof onInterrupt === 'function') onInterrupt();
      return;
    }
    const owner = overlay ? overlay.handleKey(str, key) : composer.handleKey(str, key);
    const deliver = (event) => { const r = resolveEvent; resolveEvent = null; erase(); r(event); };

    if (overlay) {
      if (owner.intent === 'close') { overlay = null; erase(); paint(); return; }
      if (owner.intent === 'choose') { deliver({ intent: 'choose', row: owner.row }); return; }
      if (owner.intent === 'action') { deliver({ intent: 'action', action: owner.action, row: owner.row }); return; }
      // `filter` is handled inside the overlay so a keystroke costs a repaint
      // rather than a round trip through the loop.
      if (owner.changed) frame(() => { erase(); paint(); });
      return;
    }

    if (owner.intent === 'exit') { deliver({ intent: 'exit' }); return; }
    if (owner.intent === 'palette') { deliver({ intent: 'palette' }); return; }
    if (owner.intent === 'navigate') { deliver({ intent: 'navigate' }); return; }
    if (owner.intent === 'escape') { deliver({ intent: 'escape' }); return; }
    if (owner.intent === 'fold') { deliver({ intent: 'fold' }); return; }
    if (owner.intent === 'complete') { deliver({ intent: 'complete', prefix: owner.prefix }); return; }
    if (owner.intent === 'cancel') { deliver({ intent: 'cancel', hadInput: owner.hadInput }); return; }
    if (owner.submitted !== undefined) { deliver({ line: owner.submitted }); return; }
    if (owner.changed) frame(() => { erase(); paint(); });
  };

  let rl = null;
  const usingAltScreen = Boolean(altScreen) && interactive && Boolean(output.isTTY);
  if (interactive) {
    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.on('keypress', onKeypress);
    output.on?.('resize', onResize);
    // 1049 saves the cursor and swaps buffers in one sequence, and its pair
    // restores both — the two-sequence spelling (47 + cursor save) leaves the
    // cursor somewhere else if the process dies between them.
    if (usingAltScreen) emit(`${ESC}[?1049h`);
  } else {
    // The piped path stays scriptable: no raw mode, no repaint, one line per
    // line. Every non-visual test drives this.
    rl = readline.createInterface({ input, output, terminal: false });
  }

  const lineIterator = rl ? rl[Symbol.asyncIterator]() : null;

  return {
    interactive,
    composer,
    commit,
    /** Rows of the bottom region — exposed so a test can assert what a real
     * session would show without owning a terminal. */
    regionLines,

    setStatus(next) { status = { ...status, ...next }; if (interactive) frame(() => { erase(); paint(); }); },
    setHint(next) {
      hintState = { ...hintState, ...next };
      composer.setGate(hintState.gate);
      if (interactive) frame(() => { erase(); paint(); });
    },
    openOverlay(next) { overlay = next; if (interactive) frame(() => { erase(); paint(); }); },
    closeOverlay() { overlay = null; if (interactive) frame(() => { erase(); paint(); }); },
    get overlay() { return overlay; },

    /**
     * Take ownership of stdout for the duration of one dispatch.
     *
     * Returns a `release` that restores it. Lines are handed to `onLine` as
     * they complete, so a long command streams into its block instead of
     * arriving all at once when it finishes. A partial final line — a command
     * that printed without a trailing newline — is flushed on release rather
     * than dropped.
     */
    capture(onLine) {
      const original = output.write.bind(output);
      rawWrite = original;
      let buffer = '';
      const emit = (chunk, encoding) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8');
        buffer += text;
        let at = buffer.indexOf('\n');
        while (at !== -1) {
          onLine(buffer.slice(0, at).replace(/\r$/, ''));
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf('\n');
        }
      };
      output.write = (chunk, encoding, callback) => {
        try { emit(chunk, encoding); } catch { /* a write must never throw into a command */ }
        if (typeof encoding === 'function') encoding();
        else if (typeof callback === 'function') callback();
        return true;
      };
      return {
        write: original,
        release() {
          output.write = original;
          rawWrite = null;
          if (buffer) { onLine(buffer); buffer = ''; }
        },
      };
    },

    /**
     * Show a block as it runs.
     *
     * `refresh` repaints the region so streamed lines appear. It is called
     * once per output line, which is cheap because a repaint is one cursor
     * move and one erase — but it is also throttled by the caller, since a
     * test suite printing 500 lines does not need 500 repaints.
     */
    beginLive(block) { live = { block }; if (interactive) frame(() => { erase(); paint(); }); },
    refreshLive() { if (interactive && live) frame(() => { erase(); paint(); }); },
    endLive() { live = null; },

    /**
     * Clear the visible screen and repaint.
     *
     * CSI 2J + cursor home — NOT 3J, which also wipes scrollback. The ledger is
     * a scrolling transcript; operators clear the viewport, not the history the
     * design exists to keep.
     *
     * A session builtin, not `!clear`: governed bash strips enough of the
     * environment that terminfo cannot resolve ghostty/kitty/etc., so shelling
     * out fails with "unknown terminal type" on the terminals people use.
     */
    clearScreen() {
      erase();
      if (interactive && output.isTTY) emit(`${ESC}[2J${ESC}[H`);
      painted = 0;
      paint();
    },

    /** The next thing the operator did: a line, or an intent the loop owns. */
    async next() {
      if (!interactive) {
        const { value, done } = await lineIterator.next();
        return done ? { intent: 'exit' } : { line: String(value ?? '') };
      }
      paint();
      return new Promise((resolve) => { resolveEvent = resolve; });
    },

    close() {
      // Idempotent: an error path may close a session the normal path also
      // closes, and restoring a terminal twice must not throw on the way out.
      if (closed) return;
      closed = true;
      erase();
      if (interactive) {
        input.off?.('keypress', onKeypress);
        output.off?.('resize', onResize);
        if (input.isTTY) { try { input.setRawMode(false); } catch { /* already gone */ } }
        // Leaving the alternate screen is the LAST thing, after the region is
        // erased: leaving first would put the erase on the main buffer and take
        // two lines of the operator's own scrollback with it.
        if (usingAltScreen) emit(`${ESC}[?1049l`);
      }
      rl?.close();
    },
  };
}
