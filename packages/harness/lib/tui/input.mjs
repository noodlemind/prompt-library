/**
 * Binding the ledger to a real terminal.
 *
 * THE REGION IS ANCHORED TO THE BOTTOM OF THE VIEWPORT. Every reference
 * surface — Claude Code, Amp, Codex, OpenCode, Grok — puts the composer at
 * the bottom of the screen, content flowing above it, the empty space in the
 * MIDDLE of a fresh session. The first build anchored to the top: chrome at
 * rows 1–12 of a 45-row terminal with thirty-three dead rows underneath,
 * which read as unfinished no matter what the chrome looked like. Anchoring
 * is the single largest "feel" difference between this surface and the field.
 *
 * HOW THE ANCHOR WORKS in the main buffer. On open, the prior shell content
 * is scrolled into scrollback (a screenful of newlines — nothing is erased
 * from history) and the session owns a clean viewport. Committed content is
 * written top-down from `contentRow`; the region — live block, palette,
 * composer, hint, footer — is painted with absolute positioning into the
 * LAST rows of the viewport. While a gap exists between content and region,
 * commits fill it downward; once they meet, commits write through the bottom
 * and the terminal scrolls naturally, exactly as before. Scrollback,
 * selection and terminal search are untouched throughout — the design's
 * main-buffer commitment holds.
 *
 * THE WIDTH IS THE TERMINAL'S WIDTH, live: the region repaints at the current
 * width on every SIGWINCH, and nothing in it is capped. Content that already
 * scrolled keeps the width it was born at — that is what scrollback means,
 * and no reference reflows it either.
 *
 * COMMAND OUTPUT IS CAPTURED, NOT PASSED THROUGH — see `capture`. Every
 * repaint is one synchronized frame (CSI ?2026): terminals that support it
 * render each update atomically, the rest ignore the sequence. This module
 * remains the only one that needs a TTY, and still the one with the least
 * thinking in it.
 */
import readline from 'node:readline';
import { createComposer } from './composer.mjs';
import { renderFooter, renderHint } from './chrome.mjs';
import { renderOverlay, renderPaletteRows } from './overlay.mjs';
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
  /** Word → 'command' | 'verb' | 'flag' | 'session' | null, from the registry. */
  classify = null,
  altScreen = false,
  onInterrupt = null,
} = {}) {
  const width = () => Math.max(40, output.columns || 80);
  const height = () => Math.max(8, output.rows || 24);
  const composer = createComposer({
    width: width(), ascii, history, paint: (t, s) => ui.paint(t, s), paletteChord, classify,
  });
  let status = {};
  let hintState = { mode: 'deliver', gate: null, shell: 'allowed', rerun: null };
  /** The value being collected, or null. While set, the composer's rule label
   * names the command and the placeholder asks the question — the answer is
   * typed exactly where the question is asked. */
  let prompt = null;
  let overlay = null;      // modal picker: run tree, block navigation
  let palette = null;      // composer-attached list: { overlay, filter }
  let live = null;
  let painted = 0;
  /** The next free row for committed content, 1-based absolute. */
  let contentRow = 1;
  let resolveEvent = null;
  let closed = false;
  let rawWrite = null;
  const emit = (text) => (rawWrite ?? output.write.bind(output))(text);

  /** One visual update, delivered atomically — CSI ?2026 holds rendering until
   * the frame completes; terminals without it ignore the sequence. */
  const frame = (fn) => {
    const sync = interactive && Boolean(output.isTTY);
    if (sync) emit(`${ESC}[?2026h`);
    try {
      fn();
    } finally {
      if (sync) emit(`${ESC}[?2026l`);
    }
  };

  const moveTo = (row, col = 1) => emit(`${ESC}[${row};${col}H`);

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
    if (overlay) {
      rows.push(...renderOverlay(overlay, { ui, width: w }));
    } else {
      // The palette grows UPWARD above the composer, Claude Code's shape: the
      // input row never moves and never loses focus; the candidates stack over
      // it and vanish. A menu that replaced the editor sent the query ten rows
      // up-screen the moment `/` was pressed.
      if (palette) rows.push(...renderPaletteRows(palette.overlay, { ui, width: w }));
      composer.setWidth(w);
      composer.setHint(renderHint({ ui, width: w, ...hintState }));
      // The rule label and the placeholder are computed HERE, per paint, from
      // one source of truth each — a prompt in flight owns both.
      if (composer.bashMode) {
        composer.setRuleLabel('bash');
        composer.setPlaceholder(null);
      } else if (prompt) {
        composer.setRuleLabel(`${hintState.mode} · ${prompt.title}`);
        composer.setPlaceholder(`${prompt.label}${prompt.note ? ` — ${prompt.note}` : ''} · ↵ submits · exit cancels`);
      } else {
        composer.setRuleLabel([hintState.mode, hintState.shell === 'denied' ? 'shell denied' : null].filter(Boolean).join(' · '));
        composer.setPlaceholder(null);
      }
      rows.push(...composer.render());
    }
    const footer = renderFooter(status, { ui, width: w, items: footerItems });
    // (the model is part of `status`; see setStatus in the loop)
    if (footer) rows.push(footer);
    return rows;
  };

  /** Where the terminal cursor belongs inside the region (1-based from the
   * region's first row). */
  const cursorInRegion = () => {
    let offset = 0;
    if (live?.block) offset += 1 + Math.min(live.block.lines.length, LIVE_TAIL);
    if (overlay) {
      // The boxed overlay's input row is its second row — index 1, 0-based.
      return { row: offset + 1, col: ui.stripAnsi(`  ${overlay.title ? `${overlay.title} ` : ''}${overlay.query}`).length + 2 };
    }
    if (palette) offset += palette.overlay.visible.length + (palette.overlay.footerText ? 1 : 0);
    const c = composer.cursor;
    return { row: offset + c.row, col: c.col };
  };

  /** Top row of the region, clamped so it never overlaps committed content. */
  const regionTop = (h) => Math.max(contentRow, height() - h + 1);

  const erase = () => {
    if (!interactive || painted === 0) return;
    moveTo(regionTop(painted), 1);
    emit(`${ESC}[0J`);
    painted = 0;
  };

  const paint = () => {
    if (!interactive || closed) return;
    erase();
    const lines = regionLines();
    let top = regionTop(lines.length);
    // A region taller than the space below the content pushes the content up:
    // scroll by the deficit from the bottom row, exactly what the terminal
    // would have done had the rows been printed there.
    const deficit = top + lines.length - 1 - height();
    if (deficit > 0) {
      moveTo(height(), 1);
      emit('\n'.repeat(deficit));
      contentRow = Math.max(1, contentRow - deficit);
      top = regionTop(lines.length);
    }
    moveTo(top, 1);
    // No trailing newline: a newline on the bottom row scrolls the screen,
    // which would walk the region up one row per repaint.
    emit(lines.join('\n'));
    painted = lines.length;
    const { row, col } = cursorInRegion();
    // `row` is a 0-based index within the region (the composer reports its
    // cursor with the top rule at 0). Treating it as 1-based parked the
    // blinker ON the hairline, one row above the text it belonged to.
    moveTo(top + Math.max(0, Math.min(row, painted - 1)), 1);
    if (col > 0) emit(`${ESC}[${col}C`);
  };

  /** Commit rows into the flow above the region. While a gap exists between
   * content and region they fill it; afterwards they scroll through. */
  const commit = (lines) => {
    const rows = Array.isArray(lines) ? lines : [lines];
    if (!rows.length) return;
    if (!interactive) {
      emit(`${rows.join('\n')}\n`);
      return;
    }
    frame(() => {
      erase();
      moveTo(contentRow, 1);
      emit(`${rows.join('\n')}\n`);
      contentRow = Math.min(contentRow + rows.length, height());
      paint();
    });
  };

  const onResize = () => {
    // Everything from the content boundary down is cleared before repainting:
    // a shrink leaves the tail of every wider row on screen otherwise, and a
    // 60-column hairline over a 100-column ghost reads as a broken rule. The
    // committed content above keeps the width it was born at — the terminal
    // reflows scrollback itself, and no reference reflows it either.
    contentRow = Math.min(contentRow, Math.max(1, height()));
    frame(() => {
      moveTo(Math.min(contentRow, height()), 1);
      emit(`${ESC}[0J`);
      painted = 0;
      paint();
    });
  };

  const dropPalette = () => {
    palette = null;
    composer.setValue('');
  };

  const onKeypress = (str, key = {}) => {
    if (closed) return;
    if (!resolveEvent) {
      const isCtrlC = Boolean(key.ctrl) && key.name === 'c';
      if ((isCtrlC || key.name === 'escape') && typeof onInterrupt === 'function') onInterrupt();
      return;
    }
    const deliver = (event) => { const r = resolveEvent; resolveEvent = null; r(event); };

    if (overlay) {
      const owner = overlay.handleKey(str, key);
      // CLOSING IS AN EVENT. It used to be silent, which was fine while every
      // overlay was a view: dismissing one left nothing behind. A value picker
      // leaves the half-collected command it was asking for, and a loop that
      // never hears about the dismissal keeps that question armed — the next
      // ordinary line then answers a prompt that is no longer on screen.
      if (owner.intent === 'close') {
        overlay = null;
        frame(() => { erase(); paint(); });
        deliver({ intent: 'close' });
        return;
      }
      // The typed filter rides along: a picker over a source that cannot
      // enumerate everything (paths, model ids) accepts what was typed when
      // nothing on the list matches it.
      if (owner.intent === 'choose') { deliver({ intent: 'choose', row: owner.row, query: overlay?.query ?? '' }); return; }
      if (owner.intent === 'action') { deliver({ intent: 'action', action: owner.action, row: owner.row }); return; }
      if (owner.changed) frame(() => { erase(); paint(); });
      return;
    }

    // Palette-attached mode: the composer keeps the text and the focus; the
    // list above it owns only the navigation keys.
    if (palette) {
      const name = key.name;
      if (name === 'escape') { dropPalette(); frame(() => { erase(); paint(); }); return; }
      if (['up', 'down', 'pageup', 'pagedown'].includes(name)) {
        const r = palette.overlay.handleKey(str, key);
        if (r.changed) frame(() => { erase(); paint(); });
        return;
      }
      // TAB COMPLETES, ENTER RUNS. Antigravity states both in its own footer
      // (`enter Select · tab Complete`) and the distinction is the fix for the
      // complaint that choosing a row "auto-sent" a half-finished command:
      // Tab puts the row's text in the composer and leaves you typing its
      // arguments; Enter is the commitment. A palette with one key for both
      // has to guess which you meant, and guessed wrong for every command
      // that takes an argument.
      if (name === 'tab') {
        const chosen = palette.overlay.selected;
        if (chosen) { palette = null; deliver({ intent: 'complete-row', row: chosen }); return; }
        return;
      }
      if (name === 'return' || name === 'enter') {
        const chosen = palette.overlay.selected;
        dropPalette();
        deliver({ intent: 'choose', row: chosen });
        return;
      }
      const result = composer.handleKey(str, key);
      const value = composer.value;
      if (!value.startsWith('/')) {
        // The sigil was deleted: the request is withdrawn.
        dropPalette();
        frame(() => { erase(); paint(); });
        return;
      }
      if (result.changed) {
        palette.overlay.setQuery(value.slice(1));
        palette.overlay.setRows(palette.filter(value.slice(1)));
        frame(() => { erase(); paint(); });
      }
      return;
    }

    const owner = composer.handleKey(str, key);
    if (owner.intent === 'exit') { deliver({ intent: 'exit' }); return; }
    if (owner.intent === 'palette') { deliver({ intent: 'palette' }); return; }
    if (owner.intent === 'navigate') { deliver({ intent: 'navigate' }); return; }
    if (owner.intent === 'escape') { deliver({ intent: 'escape' }); return; }
    if (owner.intent === 'agent-mode') { deliver({ intent: 'agent-mode' }); return; }
    if (owner.intent === 'fold') { deliver({ intent: 'fold' }); return; }
    if (owner.intent === 'clear') { deliver({ intent: 'clear' }); return; }
    if (owner.intent === 'complete') { deliver({ intent: 'complete', prefix: owner.prefix }); return; }
    if (owner.intent === 'cancel') { deliver({ intent: 'cancel', hadInput: owner.hadInput }); return; }
    if (owner.intent === 'bash-mode') { frame(() => { erase(); paint(); }); return; }
    if (owner.submitted !== undefined) { deliver({ line: owner.submitted, bash: owner.bash === true }); return; }
    if (owner.changed) frame(() => { erase(); paint(); });
  };

  let rl = null;
  const usingAltScreen = Boolean(altScreen) && interactive && Boolean(output.isTTY);
  if (interactive) {
    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.on('keypress', onKeypress);
    output.on?.('resize', onResize);
    if (usingAltScreen) emit(`${ESC}[?1049h`);
    // THE ANCHOR: scroll whatever the shell had on screen into scrollback and
    // take a clean viewport. Nothing is erased — a screenful of newlines is
    // exactly what a long command's output would have done — and every
    // reference opens the same way, on its own canvas.
    frame(() => {
      emit('\n'.repeat(Math.max(0, height() - 1)));
      moveTo(1, 1);
      emit(`${ESC}[0J`);
    });
  } else {
    rl = readline.createInterface({ input, output, terminal: false });
  }

  const lineIterator = rl ? rl[Symbol.asyncIterator]() : null;

  return {
    interactive,
    composer,
    commit,
    regionLines,

    setStatus(next) { status = { ...status, ...next }; if (interactive) frame(() => { erase(); paint(); }); },
    setHint(next) {
      hintState = { ...hintState, ...next };
      composer.setGate(hintState.gate);
      if (interactive) frame(() => { erase(); paint(); });
    },
    /** Ask a value question at the composer; null clears it. */
    setPrompt(next) { prompt = next; if (interactive) frame(() => { erase(); paint(); }); },
    openOverlay(next) { overlay = next; if (interactive) frame(() => { erase(); paint(); }); },
    closeOverlay() { overlay = null; if (interactive) frame(() => { erase(); paint(); }); },
    get overlay() { return overlay; },

    /**
     * Open the composer-attached palette. `filter(query)` returns the rows for
     * a query; the composer's text after the sigil IS the query, so typing
     * filters live and backspacing the sigil away withdraws the request.
     */
    openPalette({ overlay: paletteOverlay, filter }) {
      // A pending question belongs to the command that asked it. Opening the
      // palette abandons that command, so its title must go with it —
      // otherwise the rule reads `deliver · get` while the operator is
      // filtering for something else entirely.
      prompt = null;
      palette = { overlay: paletteOverlay, filter };
      if (!composer.value.startsWith('/')) composer.setValue(`/${composer.value}`);
      if (interactive) frame(() => { erase(); paint(); });
    },
    closePalette() { dropPalette(); if (interactive) frame(() => { erase(); paint(); }); },
    get palette() { return palette; },

    capture(onLine) {
      const original = output.write.bind(output);
      rawWrite = original;
      let buffer = '';
      const emitLines = (chunk, encoding) => {
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
        try { emitLines(chunk, encoding); } catch { /* a write must never throw into a command */ }
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

    beginLive(block) { live = { block }; if (interactive) frame(() => { erase(); paint(); }); },
    refreshLive() { if (interactive && live) frame(() => { erase(); paint(); }); },
    endLive() { live = null; },

    clearScreen() {
      frame(() => {
        erase();
        if (interactive && output.isTTY) emit(`${ESC}[2J${ESC}[H`);
        painted = 0;
        contentRow = 1;
        paint();
      });
    },

    async next() {
      if (!interactive) {
        const { value, done } = await lineIterator.next();
        return done ? { intent: 'exit' } : { line: String(value ?? '') };
      }
      frame(() => paint());
      return new Promise((resolve) => { resolveEvent = resolve; });
    },

    close() {
      if (closed) return;
      closed = true;
      frame(() => {
        erase();
        // Leave the cursor where the flow ended, so the exit ritual (and the
        // shell prompt after it) print after the content rather than at the
        // bottom of a mostly-empty screen.
        if (interactive) moveTo(Math.min(contentRow, height()), 1);
      });
      if (interactive) {
        input.off?.('keypress', onKeypress);
        output.off?.('resize', onResize);
        if (input.isTTY) { try { input.setRawMode(false); } catch { /* already gone */ } }
        if (usingAltScreen) emit(`${ESC}[?1049l`);
      }
      rl?.close();
    },
  };
}
