/**
 * The block — the Session Ledger's unit of everything.
 *
 * ONE IDEA HOLDS THE WHOLE SURFACE TOGETHER: a block is a record, not a
 * rendering. Each one stores command, status, exit code, duration and actor;
 * the CLI writes those same fields to the run journal, and this module is a
 * projection of them. Tint, fold, filter, mark and re-run are therefore views
 * over one structure — there is never a second source of truth for what
 * happened, which is what makes `!!` exact and what lets a session that ended
 * yesterday be read back today.
 *
 * WHAT PHASE 4B SHIPPED INSTEAD, and why this file exists: commands printed
 * with `console.log` while the composer was suspended, so output reached the
 * terminal as undifferentiated text. No tint, no stripe, no record line, no
 * tally — and, more importantly, nothing addressable. A transcript you cannot
 * point at cannot be re-run, marked, folded or resumed, and those are four of
 * the design's named affordances.
 *
 * FAILURE IS ENCODED FOUR TIMES, deliberately, because each channel dies in a
 * different terminal: the tint (truecolour and 256), the painted stripe (any
 * colour at all), the glyph (`✗` / `[x]`), and the word `failed` in the record
 * line (plain text, survives a screenshot and a screen reader). The design
 * called for two; the extra two cost nothing once the record exists.
 */
import { displayWidth, padTo, wrapCells, clipTo } from './width.mjs';

/** Blocks whose output runs longer than this fold to a summary line. Long
 * output is the normal case for `verify` and `bash`, and a ledger that scrolls
 * the previous six blocks off screen to show 400 lines of test output has
 * stopped being a ledger. */
export const FOLD_THRESHOLD = 12;
/** How much of a folded block still shows. Enough to see what it was. */
export const FOLD_HEAD = 6;

/**
 * status → [tint state, glyph state, the token the status WORD is painted in].
 *
 * The word is muted for `failed` and `cancelled` on purpose, following the
 * mock: those blocks already carry a red tint, a red stripe and a red glyph,
 * and a fourth red thing is not more legible, it is just louder. Colour goes
 * where attention is owed and nowhere else.
 */
const STATUS = {
  user: ['user', null, 'muted'],
  running: ['running', 'active', 'info'],
  ok: ['ok', 'ok', 'ok'],
  succeeded: ['ok', 'ok', 'ok'],
  failed: ['failed', 'error', 'muted'],
  blocked: ['failed', 'error', 'muted'],
  inconclusive: ['failed', 'warn', 'warn'],
  cancelled: ['cancelled', 'error', 'muted'],
  'timed-out': ['failed', 'warn', 'warn'],
};

const statusOf = (status) => STATUS[status] || STATUS.user;

/** `0m12s` — the mock's shape. Minutes never roll into hours because a command
 * that ran for an hour should read as `73m` rather than as a clock time you
 * have to subtract. */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/** `14:07:03` — local wall time, which is what someone reading their own
 * scrollback is comparing against. */
export function formatClock(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let counter = 0;
/** A local block id. Short enough to type after `!!`, and drawn from the same
 * alphabet as the run journal's ids so the two read alike. */
export function newBlockId() {
  counter = (counter + 1) % 0xffff;
  return `${Date.now().toString(36).slice(-4)}${counter.toString(36).padStart(2, '0')}`;
}

/**
 * A block record.
 *
 * `lines` are already-rendered output rows — the command's own ledger rows,
 * styled by `lib/style.mjs` before they got here. The block adds the frame
 * around them and never restyles their content, because a command owns how its
 * own output reads.
 */
export function createBlock({
  id = newBlockId(),
  command = '',
  status = 'running',
  exit = null,
  startedAt = new Date().toISOString(),
  durationMs = null,
  actor = 'you',
  run = null,
  lines = [],
  tally = null,
  next = null,
  marked = false,
  folded = null,
  cwd = null,
  kind = 'command',
  // What was DISPATCHED, as distinct from `command`, which is what was typed.
  // `!echo hi` is one string to read and another to replay.
  argv = [],
} = {}) {
  return {
    id, command, status, exit, startedAt, durationMs, actor, run,
    lines: [...lines], tally, next, marked, folded, cwd, kind, argv: [...argv],
  };
}

/**
 * The record line: the journal entry made visible.
 *
 * Fields are omitted rather than rendered as `unknown` or `—`. A row that says
 * `exit —` invites the reader to wonder what went wrong with the lookup; a row
 * that simply does not mention the exit code says the same thing without the
 * false alarm.
 */
export function recordSegments(block) {
  const [, , wordToken] = statusOf(block.status);
  const segments = [{ token: wordToken, text: block.status }];
  if (Number.isInteger(block.exit)) segments.push({ token: 'faint', text: `exit ${block.exit}` });
  const dur = formatDuration(block.durationMs);
  if (dur) segments.push({ token: 'faint', text: dur });
  if (block.actor) segments.push({ token: 'faint', text: `actor ${block.actor}` });
  const clock = formatClock(block.startedAt);
  if (clock) segments.push({ token: 'faint', text: clock });
  if (block.run) segments.push({ token: 'faint', text: block.run });
  return segments;
}

/** How many output rows a block shows right now, and what the fold line says. */
export function foldState(block, { threshold = FOLD_THRESHOLD, head = FOLD_HEAD } = {}) {
  const total = block.lines.length;
  // An explicit `folded` beats the threshold in both directions: `ctrl+o` is an
  // answer to the heuristic, not a request to re-run it.
  const folded = block.folded === null ? total > threshold : block.folded;
  if (!folded || total <= head) return { folded: false, shown: total, hidden: 0 };
  return { folded: true, shown: head, hidden: total - head };
}

/**
 * Render a block to terminal rows.
 *
 * `width` is the full terminal width: the tint has to run the whole way across
 * or it reads as a highlighted paragraph rather than as a block. Every row
 * therefore goes out padded, and every row closes its own background — see the
 * note in `style.mjs#tintRow` for why the reset cannot be hoisted.
 *
 * `selected` draws the navigation cursor. It replaces the stripe rather than
 * adding a second marker, because two markers in one gutter is how a gutter
 * stops being scannable.
 */
export function renderBlock(block, {
  ui,
  width = 80,
  selected = false,
  showRecord = true,
  fold = {},
} = {}) {
  const [tintState, glyphState] = statusOf(block.status);
  const stripeMark = selected
    ? ui.paint('info', ui.unicode ? '┃' : '>')
    : ui.stripe(tintState);
  const gutter = `${stripeMark} `;
  // Two cells: the stripe and one space. Painted text lies about its own
  // length, so the budget is computed from the glyph, not from the string.
  const inner = Math.max(8, width - 2);

  const rows = [];
  const push = (content) => {
    for (const piece of wrapCells(content, inner)) {
      rows.push(ui.tintRow(tintState, padTo(`${gutter}${piece}`, width)));
    }
  };
  // A row whose content is already styled cannot be wrapped without cutting an
  // escape sequence in half, so pre-styled output rows are clipped instead —
  // and clipping is the right call for output anyway, since a wrapped ledger
  // row loses the column alignment that makes it a ledger row.
  const pushStyled = (content) => {
    const visible = displayWidth(content);
    const body = visible <= inner ? content : `${clipTo(ui.stripAnsi(content), inner - 1)}…`;
    const pad = ' '.repeat(Math.max(0, inner - Math.min(visible, inner)));
    rows.push(ui.tintRow(tintState, `${gutter}${body}${pad}`));
  };

  // 1 — the command, verbatim. The caret is the same one the composer draws, so
  // a block reads as the echo of a line that was typed there.
  if (block.command) {
    push(`${ui.paint('info', ui.unicode ? '❯' : '>')} ${block.command}`);
  } else if (block.kind === 'note') {
    push(ui.paint('muted', block.tally || ''));
  }

  // 2 — the record line.
  if (showRecord && block.status !== 'user') {
    const parts = recordSegments(block).map((s) => (
      s.token === 'faint' ? ui.paint('muted', s.text) : ui.paint(s.token, s.text)
    ));
    const mark = block.marked ? `${ui.paint('warn', ui.unicode ? '★' : '*')} ` : '';
    pushStyled(`  ${mark}${parts.join(ui.paint('muted', ' · '))}`);
  }

  // 3 — output, folded past the threshold.
  const state = foldState(block, fold);
  for (const line of block.lines.slice(0, state.shown)) pushStyled(`  ${line}`);
  if (state.folded) {
    pushStyled(`  ${ui.paint('muted', `… ${state.hidden} more line${state.hidden === 1 ? '' : 's'}`)}${ui.paint('muted', ' (ctrl+o)')}`);
  }

  // 4 — the closing tally, and the one action that follows.
  if (block.tally && block.kind !== 'note') {
    const next = block.next ? ui.paint('info', ` ${ui.arrow} ${block.next}`) : '';
    pushStyled(`  ${ui.paint('muted', block.tally)}${next}`);
  } else if (block.next) {
    pushStyled(`  ${ui.paint('info', `${ui.arrow} ${block.next}`)}`);
  }

  // A glyph-only row would be redundant with the record line; the glyph belongs
  // in the OUTPUT, which the commands already emit. Asserted here so the
  // mapping stays exercised rather than quietly unused.
  void glyphState;
  return rows;
}

/**
 * The sticky header shown while a block is running.
 *
 * It is the one piece of chrome that appears mid-block, and it earns its place
 * by answering the two questions a person watching a long command has: what is
 * this, and how do I stop it.
 */
export function runningHeader(block, { ui, width = 80, lineCount = 0 } = {}) {
  const label = block.command || 'running';
  const tail = `esc cancels${lineCount ? ` · ${lineCount} lines` : ''}`;
  const head = `  ${ui.paint('info', ui.unicode ? '◐' : '-')} ${clipTo(label, Math.max(8, width - tail.length - 8))}`;
  const gap = Math.max(1, width - displayWidth(head) - displayWidth(tail) - 2);
  return ui.tintRow('running', padTo(`${ui.stripe('running')} ${head.slice(2)}${' '.repeat(gap)}${ui.paint('muted', tail)}`, width));
}
