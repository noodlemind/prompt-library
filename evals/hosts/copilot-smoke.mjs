/**
 * Host-compatibility smoke: GitHub Copilot Pro — the primary consumption host.
 *
 * Not an A/B. A Harness-enabled smoke run on relevant changes verifying the
 * plan's compatibility checklist; full pairs only on major releases or when
 * the Copilot integration changes.
 */
const CHECKLIST = [
  { id: 'install', description: 'Harness installation and hydration complete without errors' },
  { id: 'discovery', description: 'The @engineer agent is discoverable in the agent dropdown' },
  { id: 'activation', description: 'Skills load on demand when the engineer invokes them' },
  { id: 'hooks', description: 'Hook and tool behavior matches the harness contract' },
  { id: 'completion', description: 'The task completes and the verifier result is recorded' },
];

export function createHost() {
  return {
    id: 'copilot-smoke',
    kind: 'smoke',
    gate: 'on-relevant-changes',
    checklist: CHECKLIST.map((c) => ({ ...c })),
    /** Every checklist item must explicitly pass; unreported items fail closed. */
    evaluate(results = {}) {
      const failed = CHECKLIST.filter((c) => results[c.id] !== true).map((c) => c.id);
      return { ok: failed.length === 0, failed };
    },
  };
}
