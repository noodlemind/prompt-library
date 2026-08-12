/**
 * Thin gate interaction: approve / comment / quit (Grok plan-gate pattern).
 * Maps to host registry commands — no second gate implementation.
 */

export const GATE_ACTIONS = Object.freeze([
  { id: 'a', label: 'approve', note: 'run gate for the active plan', argv: ['gate'] },
  { id: 'c', label: 'comment', note: 'open the plan path for notes', kind: 'open-plan' },
  { id: 'q', label: 'quit', note: 'dismiss without running gate', kind: 'dismiss' },
]);

/**
 * @param {{ plan?: string|null, gate?: string|null }} snapshot
 */
export function gateActionRows(snapshot = {}) {
  const plan = snapshot.plan || null;
  return GATE_ACTIONS.map((a) => ({
    ...a,
    label: a.label,
    note: a.id === 'c' && plan ? `plan ${plan}` : a.note,
    plan,
  }));
}

/**
 * Parse a short answer (a/c/q or full word).
 * @param {string} raw
 */
export function parseGateAction(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return null;
  if (t === 'a' || t === 'approve' || t === 'y' || t === 'yes') return GATE_ACTIONS[0];
  if (t === 'c' || t === 'comment' || t === 'edit' || t === 'plan') return GATE_ACTIONS[1];
  if (t === 'q' || t === 'quit' || t === 'esc' || t === 'cancel' || t === 'n' || t === 'no') {
    return GATE_ACTIONS[2];
  }
  return null;
}

export function gatePromptLines(snapshot = {}) {
  const plan = snapshot.plan ? `plan ${snapshot.plan}` : 'active plan';
  const gate = snapshot.gate ? `gate ${snapshot.gate}` : 'gate unknown';
  return [
    `GATE · ${plan} · ${gate}`,
    '[a]pprove  run gate',
    '[c]omment  note the plan path',
    '[q]uit     dismiss',
  ];
}
