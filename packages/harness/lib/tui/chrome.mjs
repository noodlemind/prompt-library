/**
 * The Session Ledger's chrome: a header banner, a hint row, a footer.
 *
 * THE BUDGET IS THREE ROWS, and the design fixes which three. Persistent chrome
 * is the hint row and the footer; the header is printed ONCE, into scrollback,
 * at the top of the session. That is not a compromise with the main-buffer
 * rule — it is the consequence of it. A bar pinned to the top of the viewport
 * needs the alternate screen, and the alternate screen costs scrollback,
 * selection and the terminal's own search, which is the trade the design
 * declines. A header that scrolls away with the session it opened is the honest
 * form of the same information.
 *
 * THE HINT ROW IS CONSEQUENCE CONTEXT, taken from Cursor CLI: what Enter will
 * do, stated at the point where Enter is pressed. It carries the mode, the gate
 * posture, and whether the shell is allowed — the three facts that change what
 * the next line does. Keys come last because they are learned once; the
 * posture changes under you.
 *
 * THE FOOTER IS TWO COLUMNS. Left is lifecycle (plan, gate, run); right is
 * scale (tests, learnings, knowledge generation). Clipping drops the right
 * column first and then whole segments from the right of the left column, so
 * the fact that changes what the next command does is the last thing to go.
 */
import { displayWidth, clipTo, padTo } from './width.mjs';

/** The footer's left column, in the order the design fixes. Configurable per
 * the mock's `statusline items` setting — Warp makes this configurable because
 * it is taste, and the same argument applies here. */
export const DEFAULT_FOOTER_ITEMS = Object.freeze(['plan', 'gate', 'run', 'knowledge']);

const GATE_GLYPH = {
  pass: ['ok', 'ok'],
  ok: ['ok', 'ok'],
  blocked: ['warn', 'warn'],
  failed: ['error', 'error'],
  expired: ['warn', 'warn'],
};

/**
 * The session header, printed into scrollback once.
 *
 * Every field is omitted when unknown. A header that says `branch unknown` in a
 * container with no git repo reads as a broken lookup rather than as a fact
 * about the container.
 */
export function renderHeader({
  ui,
  width = 80,
  workspace = null,
  branch = null,
  commit = null,
  version = null,
  plan = null,
  gate = null,
  run = null,
} = {}) {
  const dot = ui.paint(gate && gate !== 'pass' && gate !== 'ok' ? 'warn' : 'ok', ui.unicode ? '●' : 'o');
  const left = [];
  if (workspace) left.push(ui.paint('info', workspace));
  if (branch) left.push(ui.paint('muted', commit ? `${branch} @ ${commit}` : branch));
  if (version) left.push(ui.paint('muted', `harness ${version}`));

  const right = [];
  if (plan) right.push(`${ui.paint('muted', 'plan')} ${ui.paint('info', plan)}`);
  if (gate) {
    const [token] = GATE_GLYPH[gate] || ['warn'];
    right.push(`${ui.paint('muted', 'gate')} ${ui.glyph(token === 'ok' ? 'ok' : token === 'error' ? 'error' : 'warn')} ${ui.paint(token, gate)}`);
  }
  right.push(`${ui.paint('muted', 'run')} ${ui.paint('muted', run || (ui.unicode ? '—' : '-'))}`);

  const sep = ui.paint('muted', ' · ');
  const leftText = `${dot} ${left.join(sep)}`;
  const rightText = right.join(sep);
  return [twoColumn(leftText, rightText, width), ''];
}

/**
 * The hint row — what Enter will do, and at what risk.
 *
 * `mode` and `gate` come first because they are the two that change; the keys
 * are a fixed tail. When the row does not fit, the keys go before the posture
 * does, for the same reason.
 */
export function renderHint({
  ui,
  width = 80,
  mode = 'deliver',
  gate = null,
  shell = 'allowed',
  rerun = null,
} = {}) {
  const parts = [ui.paint('muted', mode)];
  if (gate) {
    const [token] = GATE_GLYPH[gate] || ['warn'];
    parts.push(`${ui.paint('muted', 'gate')} ${ui.paint(token, gate === 'pass' ? 'ok' : gate)}`);
  }
  parts.push(ui.paint('muted', `shell ${shell}`));
  if (rerun) parts.push(`${ui.paint('muted', '!!')} ${ui.paint('muted', `re-runs ${rerun}`)}`);

  const keys = [
    `${ui.paint('muted', ui.unicode ? '↵' : 'enter')} ${ui.paint('muted', 'run')}`,
    `${ui.paint('muted', 'esc')} ${ui.paint('muted', 'interrupt')}`,
    // The one key the quiet-open pass made invisible: exit worked three ways
    // and appeared nowhere. The hint row is where Enter's consequences live,
    // so it is also where leaving lives.
    `${ui.paint('muted', 'ctrl+d')} ${ui.paint('muted', 'exit')}`,
  ];
  const sep = ui.paint('muted', ' · ');
  const posture = parts.join(sep);
  const full = `  ${posture}${sep}${keys.join(sep)}`;
  if (displayWidth(full) <= width) return full;
  const short = `  ${posture}`;
  return displayWidth(short) <= width ? short : `  ${clipTo(ui.stripAnsi(posture), Math.max(0, width - 2))}`;
}

/**
 * The footer.
 *
 * `snapshot` carries whatever the session knows; absent facts are dropped
 * rather than rendered as placeholders, and the item order is configurable.
 */
export function footerSegments(snapshot = {}, items = DEFAULT_FOOTER_ITEMS) {
  const { plan = null, planLocked = false, gate = null, run = null, runStatus = null } = snapshot;
  const build = {
    plan: () => (plan ? { token: 'muted', text: `plan ${plan}`, state: planLocked ? 'ok' : null } : null),
    gate: () => (gate ? { token: (GATE_GLYPH[gate] || ['warn'])[0], text: `gate ${gate === 'pass' ? 'ok' : gate}` } : null),
    run: () => (run ? { token: 'muted', text: `run ${run}`, state: runStatus } : null),
    knowledge: () => (snapshot.knowledge ? { token: 'muted', text: snapshot.knowledge } : null),
  };
  return items.map((k) => build[k]?.()).filter(Boolean);
}

export function renderFooter(snapshot = {}, {
  ui,
  width = 80,
  items = DEFAULT_FOOTER_ITEMS,
} = {}) {
  const sep = ui.paint('muted', ' · ');
  // THE WORKSPACE IS NOT AN ITEM. It heads the footer unconditionally, outside
  // the configurable list, because it is the one fact that must never be
  // missing: it decides which repository every block above acted on. Before
  // this, the footer FELL BACK to a different renderer until the first command
  // ran and then dropped the workspace entirely — the same surface changed
  // shape mid-session, and lost its most important fact in the trade.
  const fixed = [];
  if (snapshot.workspace) fixed.push(ui.paint('info', snapshot.workspace));
  if (snapshot.branch) fixed.push(ui.paint('muted', snapshot.branch));
  const lifecycle = footerSegments(snapshot, items).map((s) => {
    const glyph = s.state ? ` ${ui.glyph(s.state === 'ok' || s.state === 'succeeded' ? 'ok' : s.state === 'failed' ? 'error' : 'pending')}` : '';
    return `${ui.paint(s.token, s.text)}${glyph}`;
  });
  const right = [];
  if (snapshot.tests) right.push(ui.paint('muted', snapshot.tests));
  if (snapshot.learnings) right.push(ui.paint('muted', snapshot.learnings));
  if (snapshot.generation) right.push(ui.paint('muted', `gen ${snapshot.generation}`));

  if (!fixed.length && !lifecycle.length && !right.length) return '';
  // Clipping order: the right column goes whole, then lifecycle segments from
  // the right — the workspace is the last thing standing.
  const compose = (life) => `  ${[...fixed, ...life].join(sep)}`;
  let life = [...lifecycle];
  let leftText = compose(life);
  const rightText = right.length ? `${right.join(sep)}  ` : '';
  while (life.length && displayWidth(ui.stripAnsi(leftText)) > width) {
    life.pop();
    leftText = compose(life);
  }
  return twoColumn(leftText, rightText, width);
}

/**
 * Left flush, right flush, one row.
 *
 * When the two would collide the RIGHT column is dropped whole rather than
 * truncated: half of `34 learnings` reads as a different number, and a number
 * that is quietly wrong is worse than one that is absent.
 */
export function twoColumn(left, right, width) {
  const lw = displayWidth(left);
  const rw = displayWidth(right);
  if (!right || lw + rw + 2 > width) {
    return lw <= width ? left : clipTo(left, width);
  }
  return `${left}${' '.repeat(Math.max(1, width - lw - rw))}${right}`;
}

/**
 * The exit ritual — printed into scrollback so it survives the session that
 * produced it. Taken from Grok Build, which prints the session's title, last
 * state and resume command on the way out; a session that ends with nothing to
 * show teaches nothing.
 */
export function renderExit({ ui, counts, started, resume = 'harness tui', width = 80 } = {}) {
  const rows = [''];
  rows.push(ui.line({
    state: counts.failed ? 'warn' : 'ok',
    key: 'session',
    value: `${counts.commands} command${counts.commands === 1 ? '' : 's'}`,
    note: `${counts.ok} ok · ${counts.failed} failed · ${counts.cancelled} cancelled`,
  }));
  if (counts.marked) {
    rows.push(ui.line({ state: 'pending', key: 'marked', value: `${counts.marked} block${counts.marked === 1 ? '' : 's'}`, note: 'kept with the journal' }));
  }
  rows.push(ui.paint('muted', `  started ${started}`));
  rows.push(ui.paint('muted', `  ${ui.arrow} resume with: ${resume}`));
  return rows.map((r) => (displayWidth(r) > width ? clipTo(r, width) : r));
}

/** Used by the running block's sticky row, which pads to full width so the
 * tint runs the whole way across. Re-exported so callers do not reach past the
 * chrome module for a measurement helper. */
export { padTo };
