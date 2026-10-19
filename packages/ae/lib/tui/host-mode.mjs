/**
 * Host-defined TUI modes (not model permission profiles).
 * Inspired by Cursor Ask/Plan and Claude Shift+Tab modes, mapped to AE:
 *   commands — kernel only, agent off
 *   assist   — optional agent may answer bare lines
 *   plan     — agent may propose; mutations stay gated (label + ledger)
 */

export const HOST_MODES = Object.freeze(['commands', 'assist', 'plan']);

/**
 * @param {string|null|undefined} mode
 * @returns {'commands'|'assist'|'plan'}
 */
export function normalizeHostMode(mode) {
  const m = String(mode ?? '').toLowerCase();
  if (HOST_MODES.includes(m)) return m;
  return 'commands';
}

/**
 * Cycle Shift+Tab order.
 * @param {string} mode
 */
export function nextHostMode(mode) {
  const cur = normalizeHostMode(mode);
  const i = HOST_MODES.indexOf(cur);
  return HOST_MODES[(i + 1) % HOST_MODES.length];
}

/**
 * Whether bare non-command lines may go to the optional agent.
 * @param {string} mode
 */
export function agentAllowedInMode(mode) {
  const m = normalizeHostMode(mode);
  return m === 'assist' || m === 'plan';
}

/**
 * Whether agent.enabled config should be true for this mode.
 * @param {string} mode
 */
export function agentEnabledForMode(mode) {
  return agentAllowedInMode(mode);
}

/**
 * Status chrome labels.
 * @param {string} mode
 */
export function modeChrome(mode) {
  const m = normalizeHostMode(mode);
  if (m === 'plan') {
    return { mode: 'plan', authority: 'propose', agent: true, note: 'proposals only · gate before mutate' };
  }
  if (m === 'assist') {
    return { mode: 'assist', authority: 'assist', agent: true, note: 'bare line → agent' };
  }
  return { mode: 'commands', authority: 'commands', agent: false, note: 'kernel only' };
}
