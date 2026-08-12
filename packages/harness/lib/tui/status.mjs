/** Compose the row from whatever the session actually knows. Missing facts are
 * omitted rather than rendered as `unknown`, which reads as a broken lookup. */
export function statusSegments({
  workspace = null,
  branch = null,
  gate = null,
  plan = null,
  runs = null,
  agent = null,
  authority = null,
  mode = null,
} = {}) {
  const segments = [];
  if (workspace) segments.push({ token: 'info', text: workspace });
  if (branch) segments.push({ token: 'muted', text: branch });
  if (agent === true || agent === 'on') segments.push({ token: 'info', text: 'agent on' });
  else if (agent === false || agent === 'off') segments.push({ token: 'muted', text: 'agent off' });
  if (mode) segments.push({ token: 'muted', text: mode });
  if (authority) segments.push({ token: 'muted', text: authority });
  if (gate) {
    segments.push({ token: gate === 'pass' ? 'ok' : 'warn', text: gate === 'pass' ? 'gate ok' : `gate ${gate}` });
  }
  if (plan) segments.push({ token: 'muted', text: plan });
  if (runs) segments.push({ token: 'muted', text: runs });
  return segments;
}

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
