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

export function mergeHostUsage(baseEvents, hostEvents) {
  if (!hostEvents?.length) return baseEvents;
  const hostSessions = new Set(hostEvents.map((e) => e.session).filter(Boolean));
  const rebased = baseEvents.map((e) => (e.session && hostSessions.has(e.session) && e.usage ? { ...e, usage: undefined } : e));
  return [...rebased, ...hostEvents];
}
