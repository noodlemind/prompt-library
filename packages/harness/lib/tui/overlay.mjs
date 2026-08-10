/**
 * Overlays — summoned, never resident.
 *
 * The design's rule is that an overlay REPLACES the editor and vanishes: you
 * never live inside one. That is what separates this from the panels and tabs
 * that were rejected — a bordered box is fine when it is a gesture, and wrong
 * when it is furniture. So overlays are the one place the ledger draws a border,
 * and the persistent chrome stays two hairlines.
 *
 * WHAT PHASE 4B DID INSTEAD: the palette printed its rows permanently into the
 * transcript and asked for a number. That is not an overlay — it is a block
 * that happens to be a menu, and it left the ledger full of dead menus. It also
 * meant the palette could not be arrow-navigated (P4bAC13), because there was
 * nothing holding a selection.
 *
 * ONE STATE MACHINE SERVES ALL THREE overlays — palette, run tree, block
 * picker — because they differ only in what fills the rows. Keeping selection,
 * paging, filtering and dismissal in one place is why the run tree gets
 * arrow-key navigation for free rather than as a second implementation.
 */
import { displayWidth, clipTo, padTo } from './width.mjs';

/** Rows shown at once. An overlay taller than a glance is a list, and a list is
 * what the palette exists instead of. */
export const PAGE = 9;

/**
 * Typed prefixes that narrow the palette to one namespace.
 *
 * The design shows these as a hint row inside the overlay (`plan: · search: ·
 * check: · res: · learn:`). They are a filter over the same flat index, not a
 * second grammar — one flat namespace is the contract, and a prefix is a way to
 * say less, never a way to reach something otherwise unreachable.
 */
export const PREFIXES = Object.freeze({
  run: ['run'],
  plan: ['plan', 'gate', 'verify'],
  search: ['search', 'lookup', 'tree'],
  check: ['checks', 'verify'],
  res: ['resources', 'bundles'],
  learn: ['learnings', 'learning', 'remember', 'consolidate', 'knowledge'],
});

/** Split `run:resume` into `{ prefix: 'run', rest: 'resume' }`. Returns a null
 * prefix for anything that is not a declared namespace, so a colon inside a
 * query (a path, a time) is left alone. */
export function splitPrefix(query) {
  const text = String(query ?? '');
  const at = text.indexOf(':');
  if (at <= 0) return { prefix: null, rest: text };
  const head = text.slice(0, at).toLowerCase();
  if (!Object.hasOwn(PREFIXES, head)) return { prefix: null, rest: text };
  return { prefix: head, rest: text.slice(at + 1).trimStart() };
}

/** Keep only the rows whose command belongs to a namespace. */
export function applyPrefix(rows, prefix) {
  if (!prefix) return rows;
  const allowed = PREFIXES[prefix] || [];
  return rows.filter((r) => {
    const noun = String(r.noun ?? r.argvTokens?.[0]?.value ?? r.label ?? '').split(/\s+/)[0];
    return allowed.includes(noun);
  });
}

/**
 * An overlay.
 *
 * `rows` is the full ranked set; the overlay owns which slice is visible and
 * which is selected. `onFilter` is called when the typed query changes, so the
 * caller can re-rank without the overlay knowing how ranking works.
 */
export function createOverlay({
  title = '',
  rows = [],
  query = '',
  footer = '',
  kind = 'palette',
  page = PAGE,
  /** Re-rank on every keystroke, in place. Filtering through the loop instead
   * would cost a round trip per character, which is exactly the latency a
   * palette must not have. */
  filter = null,
  /**
   * Single-key actions, for overlays where letters are commands rather than
   * text — the block picker's `y` copy, `m` mark, `r` re-run. An overlay with
   * actions does not filter, because a surface cannot decide whether `r` meant
   * "re-run" or "the letter r" and guessing would make both unreliable.
   */
  actions = null,
} = {}) {
  let items = [...rows];
  let index = 0;
  let offset = 0;
  let text = query;

  const clamp = () => {
    if (!items.length) { index = 0; offset = 0; return; }
    index = Math.max(0, Math.min(index, items.length - 1));
    if (index < offset) offset = index;
    if (index >= offset + page) offset = index - page + 1;
    offset = Math.max(0, Math.min(offset, Math.max(0, items.length - page)));
  };

  /** Move the selection, skipping nothing.
   *
   * Unavailable rows stay SELECTABLE on purpose. The contract says a command
   * that cannot run is listed and greyed with its reason; skipping it on the
   * way past would hide the reason, which is the part that teaches. Choosing
   * one prints why instead of running it. */
  const move = (delta) => {
    if (!items.length) return false;
    index = (index + delta + items.length) % items.length;
    clamp();
    return true;
  };

  return {
    kind,
    get title() { return title; },
    get query() { return text; },
    get rows() { return items; },
    get index() { return index; },
    get selected() { return items[index] ?? null; },
    get visible() { return items.slice(offset, offset + page); },
    get offset() { return offset; },
    setRows(next) { items = [...next]; index = 0; offset = 0; },
    setQuery(next) { text = String(next ?? ''); },
    setFooter(next) { footer = next; },
    get footerText() { return footer; },
    /**
     * One key press inside the overlay.
     *
     * Returns `{ intent, changed }`. `choose` carries the selected row;
     * `close` means the overlay is done; `filter` means the query changed and
     * the caller should re-rank.
     */
    handleKey(str, key = {}) {
      const name = key.name;
      const ctrl = Boolean(key.ctrl);
      if (name === 'escape' || (ctrl && name === 'c')) return { intent: 'close', changed: true };
      if (name === 'up' || (ctrl && name === 'p')) return { intent: null, changed: move(-1) };
      if (name === 'down' || (ctrl && name === 'n')) return { intent: null, changed: move(1) };
      if (name === 'pageup') return { intent: null, changed: move(-page) };
      if (name === 'pagedown') return { intent: null, changed: move(page) };
      if (name === 'home') { index = 0; clamp(); return { intent: null, changed: true }; }
      if (name === 'end') { index = Math.max(0, items.length - 1); clamp(); return { intent: null, changed: true }; }
      if (name === 'return' || name === 'enter' || name === 'tab') {
        return items.length ? { intent: 'choose', row: items[index], changed: true } : { intent: null, changed: false };
      }
      if (actions) {
        // Action overlays take no text at all, so backspace is a dismissal and
        // an unmapped letter is a no-op rather than a silent filter.
        if (name === 'backspace') return { intent: 'close', changed: true };
        const pressed = typeof str === 'string' ? str.toLowerCase() : null;
        if (!ctrl && !key.meta && pressed && Object.hasOwn(actions, pressed)) {
          return { intent: 'action', action: actions[pressed], row: items[index] ?? null, changed: true };
        }
        // `ctrl+o` folds, and reaches here as a chord rather than a character.
        if (ctrl && name === 'o' && Object.hasOwn(actions, 'ctrl+o')) {
          return { intent: 'action', action: actions['ctrl+o'], row: items[index] ?? null, changed: true };
        }
        return { intent: null, changed: false };
      }
      if (name === 'backspace') {
        if (!text) return { intent: 'close', changed: true };
        text = text.slice(0, -1);
        if (filter) { items = [...filter(text)]; index = 0; offset = 0; }
        return { intent: 'filter', query: text, changed: true };
      }
      if (!ctrl && !key.meta && typeof str === 'string' && str.length === 1 && str >= ' ' && str !== '\x7f') {
        text += str;
        if (filter) { items = [...filter(text)]; index = 0; offset = 0; }
        return { intent: 'filter', query: text, changed: true };
      }
      return { intent: null, changed: false };
    },
  };
}

/**
 * Draw an overlay.
 *
 * The border is `info` because an overlay is a place, and the one colour the
 * design gives to "you are somewhere" is the info blue. Rows are padded to the
 * inner width so the selected row's tint spans the whole line — a highlight
 * that stops at the text is a highlight on the text, not on the row.
 */
/** Cells the side-effect class needs, so the label knows how much it may keep.
 * The class is the last thing a narrow row gives up — see the contract note. */
function effectFloor(row, ui) {
  return row?.sideEffect ? displayWidth(ui.stripAnsi(row.sideEffect)) + 1 : 0;
}

export function renderOverlay(overlay, { ui, width = 80, maxWidth = 72 } = {}) {
  const box = Math.max(32, Math.min(width, maxWidth));
  const inner = box - 2;
  const b = ui.unicode
    ? { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

  const edge = (l, r) => ui.paint('info', `${l}${b.h.repeat(inner)}${r}`);
  const rowOf = (content, tint = null) => {
    const padded = padTo(content, inner);
    const body = tint ? ui.tintRow(tint, padded) : ui.tintRow('panel', padded);
    return `${ui.paint('info', b.v)}${body}${ui.paint('info', b.v)}`;
  };
  const divider = () => ui.paint('info', `${b.v}${ui.paint('muted', b.h.repeat(inner))}${b.v}`);

  const out = [edge(b.tl, b.tr)];

  // The input row: what is being typed, with the caret at the end.
  const prompt = `${ui.paint('info', ui.unicode ? '❯' : '>')} ${overlay.title ? `${ui.paint('muted', `${overlay.title} `)}` : ''}${overlay.query}${ui.paint('info', ui.unicode ? '▏' : '_')}`;
  out.push(rowOf(` ${clipTo(prompt, inner - 2)}`));
  out.push(divider());

  if (!overlay.visible.length) {
    out.push(rowOf(` ${ui.paint('muted', 'nothing matches')}`));
  }
  for (const [i, row] of overlay.visible.entries()) {
    const chosen = overlay.offset + i === overlay.index;
    const disabled = Boolean(row.unavailable || row.disabled);
    // The side-effect class rides every row. No surveyed tool shows what a
    // command will do before it runs, because none declares it per command;
    // the registry does, so the row can warn before the choice rather than
    // after it.
    const effect = row.sideEffect
      ? ui.paint(row.sideEffect === 'read' ? 'ok' : row.sideEffect === 'mutate' ? 'warn' : 'error', row.sideEffect)
      : '';
    // THE NAMESPACE IS DIM, THE VERB IS BRIGHT — Amp's palette typography,
    // and the reason its rows scan: `thread new in orb` reads as a verb you
    // want inside a group you already know. `run list` renders the same way:
    // the noun a person has already narrowed to recedes, the choice stands
    // out. Single-word labels stay bright; disabled rows stay muted whole,
    // because nothing in them is a choice.
    const splitLabel = () => {
      if (disabled) return ui.paint('muted', row.label);
      if (overlay.kind !== 'palette') return row.label;
      const at = String(row.label).indexOf(' ');
      if (at <= 0) return row.label;
      return `${ui.paint('muted', row.label.slice(0, at))} ${row.label.slice(at + 1)}`;
    };
    const label = splitLabel();
    const note = disabled
      ? ui.paint('muted', row.reason || row.unavailable || 'unavailable')
      : ui.paint('muted', row.note || row.summary || '');
    // CLIPPED, because `padTo` never truncates and `gap` is floored at one: an
    // over-long label pushed the closing `│` past the box width and broke the
    // border. The prompt row and the footer already clip; this one did not.
    const headRoom = Math.max(4, inner - effectFloor(row, ui) - 3);
    const head = ` ${displayWidth(label) > headRoom ? clipTo(label, headRoom - 1).concat(ui.paint('muted', '…')) : label}`;
    // THE NOTE IS WHAT GIVES WAY, never the label or the side-effect class.
    // An earlier version fell back to one clipped `label — summary` string when
    // the row did not fit, which dropped the effect — and "every row carries
    // its side-effect class, so the consequence of a command is visible before
    // it runs" is a contract, not a nicety. It is also the row's most important
    // two words on the narrowest terminal, where a mistake costs the most.
    const effectCells = effect ? displayWidth(effect) + 1 : 0;
    const room = inner - displayWidth(head) - effectCells - 3;
    // A disabled row's REASON outranks its summary: "why can't I run this" is
    // the only question being asked once the row is greyed.
    const source = disabled
      ? (row.reason || row.unavailable || 'unavailable')
      : (row.note || row.summary || '');
    const plainNote = ui.stripAnsi(String(source));
    const clipped = room > 4 ? clipTo(plainNote, room) : '';
    // An ellipsis when it was cut, so a truncated note is never read as the
    // whole sentence — `prune: every bucket whose branch is a` looks like a
    // complete, wrong description of what the row does.
    const shownNote = clipped && clipped.length < plainNote.length
      ? `${clipTo(plainNote, room - 1)}…`
      : clipped;
    const paintedNote = shownNote ? ui.paint('muted', shownNote) : '';
    const tail = `${paintedNote}${paintedNote && effect ? ui.paint('muted', ' · ') : ''}${effect}${effect || paintedNote ? ' ' : ''}`;
    const gap = Math.max(1, inner - displayWidth(head) - displayWidth(tail));
    out.push(rowOf(`${head}${' '.repeat(gap)}${tail}`, chosen ? 'selected' : null));
  }

  if (overlay.footerText) {
    out.push(divider());
    out.push(rowOf(` ${ui.paint('muted', clipTo(overlay.footerText, inner - 2))}`));
  }
  out.push(edge(b.bl, b.br));
  return out;
}

/**
 * The run tree — a tree drawn into an overlay.
 *
 * Flattened to rows before it gets here, so the same selection machinery walks
 * it. The tree characters are content, not chrome, which is why they carry no
 * colour of their own.
 */
export function treeRows(node, { ui, prefix = '', last = true, depth = 0 } = {}) {
  const rows = [];
  const stem = depth === 0 ? '' : `${prefix}${last ? (ui.unicode ? '└─ ' : '\\- ') : (ui.unicode ? '├─ ' : '+- ')}`;
  const state = node.status === 'succeeded' || node.status === 'ok' ? 'ok'
    : node.status === 'failed' ? 'error'
      : node.status === 'running' ? 'active' : 'pending';
  const tail = [node.status, node.duration].filter(Boolean).join(' · ');
  rows.push({
    label: `${ui.paint('muted', stem)}${node.label}`,
    note: tail,
    sideEffect: null,
    state,
    node,
  });
  const kids = node.children || [];
  kids.forEach((child, i) => {
    const nextPrefix = depth === 0 ? '' : `${prefix}${last ? '   ' : (ui.unicode ? '│  ' : '|  ')}`;
    rows.push(...treeRows(child, { ui, prefix: nextPrefix, last: i === kids.length - 1, depth: depth + 1 }));
  });
  return rows;
}
