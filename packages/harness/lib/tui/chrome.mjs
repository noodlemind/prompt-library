import { displayWidth, clipTo, padTo } from './width.mjs';

/** The footer's left column, in the order the design fixes. Configurable per
 * the mock's `statusline items` setting — Warp makes this configurable because
 * it is taste, and the same argument applies here. */
export const DEFAULT_FOOTER_ITEMS = Object.freeze(['plan', 'gate', 'agent', 'shell', 'run', 'knowledge']);

const GATE_GLYPH = {
  pass: ['ok', 'ok'],
  ok: ['ok', 'ok'],
  blocked: ['warn', 'warn'],
  failed: ['error', 'error'],
  expired: ['warn', 'warn'],
};

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
  const sep = ui.paint('muted', ' · ');

  const where = [];
  if (workspace) where.push(ui.paint('info', workspace));
  if (branch) where.push(ui.paint('muted', commit ? `${branch} @ ${commit}` : branch));

  const what = [];
  if (version) what.push(ui.paint('muted', `harness ${version}`));
  if (plan) what.push(`${ui.paint('muted', 'plan')} ${ui.paint('info', plan)}`);
  if (gate) {
    const [token] = GATE_GLYPH[gate] || ['warn'];
    what.push(`${ui.paint('muted', 'gate')} ${ui.paint(token, gate)}`);
  }
  what.push(`${ui.paint('muted', 'run')} ${ui.paint('muted', run || (ui.unicode ? '—' : '-'))}`);

  const line1 = clipLine(`${dot} ${where.join(sep)}`, width, ui);
  const line2 = clipLine(`  ${what.join(sep)}`, width, ui);
  return [line1, line2, ''];
}

function clipLine(text, width, ui) {
  return displayWidth(text) <= width ? text : clipTo(ui.stripAnsi(text), width);
}

export function renderHint({
  ui,
  width = 80,
  mode = 'deliver',
  gate = null, // accepted and unused: the gate's textual home is the footer
  shell = 'allowed',
  rerun = null,
  agent = null,
} = {}) {
  void gate;
  void shell;
  void rerun;
  void agent;
  void mode;
  // Mode/agent live on the rule label (right) and footer — hint is keys only
  // so the chrome does not say "agent on" three times.
  const keys = [
    `${ui.paint('muted', ui.unicode ? '↵' : 'enter')} ${ui.paint('muted', 'run')}`,
    `${ui.paint('muted', 'shift+tab')} ${ui.paint('muted', 'mode')}`,
    `${ui.paint('muted', '?')} ${ui.paint('muted', 'keys')}`,
    `${ui.paint('muted', '/')} ${ui.paint('muted', 'palette')}`,
  ];
  const sep = ui.paint('muted', ' · ');
  const full = `  ${keys.join(sep)}`;
  if (displayWidth(full) <= width) return full;
  const shortKeys = keys.slice(0, 2);
  const short = `  ${shortKeys.join(sep)}`;
  return displayWidth(short) <= width ? short : `  ${clipTo(ui.stripAnsi(short), Math.max(0, width - 2))}`;
}

export function footerSegments(snapshot = {}, items = DEFAULT_FOOTER_ITEMS) {
  const { plan = null, planLocked = false, gate = null, run = null, runStatus = null } = snapshot;
  const build = {
    plan: () => (plan ? { token: 'muted', text: `plan ${plan}`, state: planLocked ? 'ok' : null } : null),
    gate: () => (gate ? { token: (GATE_GLYPH[gate] || ['warn'])[0], text: `gate ${gate === 'pass' ? 'ok' : gate}` } : null),
    run: () => (run ? { token: 'muted', text: `run ${run}`, state: runStatus } : null),
    agent: () => {
      if (snapshot.agent === true || snapshot.agent === 'on') {
        return { token: 'info', text: 'agent on' };
      }
      if (snapshot.agent === false || snapshot.agent === 'off') {
        return { token: 'muted', text: 'agent off' };
      }
      return null;
    },
    shell: () => {
      if (snapshot.shell === 'denied' || snapshot.shell === false) {
        return { token: 'warn', text: 'shell off' };
      }
      if (snapshot.shell === 'allowed' || snapshot.shell === true) {
        return { token: 'muted', text: 'shell on' };
      }
      return null;
    },
    knowledge: () => (snapshot.knowledge ? { token: 'muted', text: snapshot.knowledge } : null),
  };
  return items.map((k) => build[k]?.()).filter(Boolean);
}

/** Collapse a long workspace path for the footer (keep ~ and last two segments). */
export function shortWorkspacePath(workspace, max = 42) {
  const text = String(workspace ?? '');
  if (!text || displayWidth(text) <= max) return text;
  const parts = text.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return clipTo(text, max);
  const tail = parts.slice(-2).join('/');
  const head = text.startsWith('~') ? '~/' : '…/';
  const out = `${head}${tail}`;
  return displayWidth(out) <= max ? out : clipTo(out, max);
}

export function renderFooter(snapshot = {}, {
  ui,
  width = 80,
  items = DEFAULT_FOOTER_ITEMS,
} = {}) {
  const sep = ui.paint('muted', ' · ');
  const fixed = [];
  if (snapshot.workspace) {
    fixed.push(ui.paint('info', shortWorkspacePath(snapshot.workspace, Math.min(48, Math.floor(width * 0.45)))));
  }
  if (snapshot.branch) fixed.push(ui.paint('muted', snapshot.branch));
  // Prefer mode over redundant "agent on" when both exist.
  const footerItems = items.includes('agent') && snapshot.mode
    ? items.filter((k) => k !== 'agent')
    : items;
  if (snapshot.mode) {
    fixed.push(ui.paint(snapshot.mode === 'commands' ? 'muted' : 'info', snapshot.mode));
  }
  const lifecycle = footerSegments(snapshot, footerItems).map((s) => {
    const glyph = s.state ? ` ${ui.glyph(s.state === 'ok' || s.state === 'succeeded' ? 'ok' : s.state === 'failed' ? 'error' : 'pending')}` : '';
    return `${ui.paint(s.token, s.text)}${glyph}`;
  });
  const right = [];
  if (snapshot.tests) right.push(ui.paint('muted', snapshot.tests));
  if (snapshot.learnings) right.push(ui.paint('muted', snapshot.learnings));
  if (snapshot.generation) right.push(ui.paint('muted', `gen ${snapshot.generation}`));
  if (snapshot.model) right.push(ui.paint('info', snapshot.model));
  if (snapshot.version) right.push(ui.paint('muted', `harness ${snapshot.version}`));

  if (!fixed.length && !lifecycle.length && !right.length) return '';
  const compose = (life) => `  ${[...fixed, ...life].join(sep)}`;
  let life = [...lifecycle];
  let leftText = compose(life);
  const rightText = right.length ? `${right.join(sep)}  ` : '';
  while (life.length && displayWidth(ui.stripAnsi(leftText)) > width) {
    life.pop();
    leftText = compose(life);
  }
  // If still too wide, shrink workspace-first fixed path by recomposing without long path.
  if (displayWidth(ui.stripAnsi(leftText)) + displayWidth(ui.stripAnsi(rightText)) > width && snapshot.workspace) {
    const tighter = shortWorkspacePath(snapshot.workspace, 28);
    const fixed2 = [];
    if (tighter) fixed2.push(ui.paint('info', tighter));
    if (snapshot.branch) fixed2.push(ui.paint('muted', snapshot.branch));
    if (snapshot.mode) fixed2.push(ui.paint(snapshot.mode === 'commands' ? 'muted' : 'info', snapshot.mode));
    leftText = `  ${[...fixed2, ...life].join(sep)}`;
  }
  return twoColumn(leftText, rightText, width);
}

export function twoColumn(left, right, width) {
  const lw = displayWidth(left);
  const rw = displayWidth(right);
  if (!right || lw + rw + 2 > width) {
    return lw <= width ? left : clipTo(left, width);
  }
  return `${left}${' '.repeat(Math.max(1, width - lw - rw))}${right}`;
}

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
