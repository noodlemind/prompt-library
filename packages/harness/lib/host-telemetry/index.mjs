import * as vscode from './vscode.mjs';
import * as intellij from './intellij.mjs';
import * as copilotCli from './copilot-cli.mjs';

const ADAPTERS = {
  'github-copilot-vscode': vscode,
  vscode: vscode,
  'github-copilot-intellij': intellij,
  intellij: intellij,
  'github-copilot-cli': copilotCli,
  cli: copilotCli,
};

/**
 * Collect real host token usage for a host, or [] if none is available.
 * Never throws — a failed adapter degrades the report to harness estimates.
 * With no host specified, every adapter is tried (each returns [] when it has
 * nothing), so the report opportunistically picks up whatever real data exists.
 */
export function collectHostUsage({ workspace, host, copilotHome } = {}) {
  try {
    if (host) {
      const adapter = ADAPTERS[host];
      return adapter ? adapter.collect({ workspace, copilotHome }) || [] : [];
    }
    const seen = new Set();
    const events = [];
    for (const adapter of Object.values(ADAPTERS)) {
      if (seen.has(adapter)) continue;
      seen.add(adapter);
      events.push(...(adapter.collect({ workspace, copilotHome }) || []));
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Merge host-real usage over harness estimates: for any session that has real
 * host usage, the estimated `usage` on that session's base events is stripped
 * (so tokens are not double-counted), then the host events are appended.
 */
export function mergeHostUsage(baseEvents, hostEvents) {
  if (!hostEvents?.length) return baseEvents;
  const hostSessions = new Set(hostEvents.map((e) => e.session).filter(Boolean));
  const rebased = baseEvents.map((e) => (e.session && hostSessions.has(e.session) && e.usage ? { ...e, usage: undefined } : e));
  return [...rebased, ...hostEvents];
}
