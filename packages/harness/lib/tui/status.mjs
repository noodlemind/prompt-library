/**
 * The status line (P4bAC12) — what this session is about, always visible.
 *
 * P4b.1 claimed "the session loop, the editor, the status line, and the exit
 * ritual" and shipped no status line at all. Every reference implementation has
 * one, and for the same reason: a transcript scrolls away, so the facts that
 * stay true for the whole session have to live somewhere that does not.
 *
 * WHAT IT CARRIES is chosen by one rule — a fact belongs here if getting it
 * wrong would make you misread everything above it. The workspace and branch
 * decide which repository a command touched. The gate state decides whether the
 * next mutating command will be refused. A model name would belong here too if
 * the ledger called one, and does not, because it doesn't.
 *
 * It is a pure function of a snapshot for the same reason the composer is a
 * state machine: the phase-4b suite could not see anything that needed a
 * terminal, so nothing that matters is allowed to need one.
 */

/** Compose the row from whatever the session actually knows. Missing facts are
 * omitted rather than rendered as `unknown`, which reads as a broken lookup. */
export function statusSegments({ workspace = null, branch = null, gate = null, plan = null, runs = null } = {}) {
  const segments = [];
  // ORDER IS PRIORITY, because clipping drops from the right. The gate sits
  // ahead of the plan deliberately: at 74 columns the first draft dropped
  // `gate blocked` and kept the plan name, which hides the one fact that
  // changes what the next command will do behind one that does not.
  if (workspace) segments.push({ token: 'info', text: workspace });
  if (branch) segments.push({ token: 'muted', text: branch });
  if (gate) {
    segments.push({ token: gate === 'pass' ? 'ok' : 'warn', text: gate === 'pass' ? 'gate ok' : `gate ${gate}` });
  }
  if (plan) segments.push({ token: 'muted', text: plan });
  if (runs) segments.push({ token: 'muted', text: runs });
  return segments;
}

/**
 * Render to a single line, clipped to the terminal.
 *
 * Clipping drops WHOLE segments from the right rather than truncating one
 * mid-word: half a branch name is worse than no branch name, because it looks
 * like the branch is called that.
 */
export function renderStatus(snapshot, { width = 80, paint = (_t, s) => s, separator = ' · ' } = {}) {
  const segments = statusSegments(snapshot);
  if (!segments.length) return '';
  const plainWidth = (list) => list.map((s) => s.text).join(separator).length;
  const kept = [...segments];
  while (kept.length > 1 && plainWidth(kept) > width) kept.pop();
  const line = kept.map((s) => paint(s.token, s.text)).join(paint('muted', separator));
  return plainWidth(kept) > width
    ? paint('muted', kept[0].text.slice(0, Math.max(0, width - 1)))
    : line;
}
