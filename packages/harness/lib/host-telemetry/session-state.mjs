import fs from 'node:fs';
import path from 'node:path';
import { resolveCopilotHome } from '../paths.mjs';

/**
 * Real host token usage and local session performance metrics from Copilot's
 * own session-state logs.
 *
 * VS Code Copilot Chat (agent mode) and the Copilot CLI share a session store
 * at `<copilotHome>/session-state/<sessionId>/events.jsonl` (producer
 * "copilot-agent"). Authoritative per-session totals live on the
 * `session.shutdown` record: `data.modelMetrics.<model>.usage` (input/output/
 * cache/reasoning tokens), `data.totalPremiumRequests`, `data.totalApiDurationMs`,
 * `data.codeChanges`, and a context breakdown (currentTokens etc.). Interaction
 * counts come from the stream: `assistant.turn_start`, `tool.execution_start`,
 * `tool.execution_complete`, `skill.invoked`.
 *
 * Each session yields one `source: 'host'`, `estimated: false` event carrying
 * both `usage` (for token roll-ups) and `metrics` (for the performance view).
 * The headline token total folds in cache and reasoning tokens so the report
 * reflects the full billed footprint. It never throws — a missing or malformed
 * store degrades the report to harness estimates.
 */

// Bound how many session directories we scan so a long-lived store cannot blow
// up a report. Newest sessions (by mtime) win.
const MAX_SESSIONS = 500;

function sessionStateDir(copilotHome) {
  return path.join(resolveCopilotHome(copilotHome), 'session-state');
}

/** Sum every model's usage in a `session.shutdown` modelMetrics block. */
function sumModelMetrics(modelMetrics) {
  if (!modelMetrics || typeof modelMetrics !== 'object' || Array.isArray(modelMetrics)) return null;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, apiRequests: 0 };
  let sawUsage = false;
  for (const model of Object.values(modelMetrics)) {
    const usage = model?.usage;
    totals.apiRequests += Number(model?.requests?.count) || 0;
    if (!usage || typeof usage !== 'object') continue;
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const cacheRead = Number(usage.cacheReadTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    const reasoning = Number(usage.reasoningTokens) || 0;
    if (input || output || cacheRead || cacheWrite || reasoning) sawUsage = true;
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.reasoning += reasoning;
  }
  return sawUsage ? totals : null;
}

/** Include a session when its repo root and the report workspace overlap, or
 * when the session has no locatable root (best-effort: don't silently drop it). */
function matchesWorkspace(sessionRoot, workspace) {
  if (!sessionRoot || !workspace) return true;
  const root = path.resolve(sessionRoot);
  const ws = path.resolve(workspace);
  return root === ws || root.startsWith(ws + path.sep) || ws.startsWith(root + path.sep);
}

function parseJsonl(file) {
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip a malformed line; the rest of the log is still usable.
    }
  }
  return records;
}

function ratio(part, whole) {
  return whole > 0 ? Number((part / whole).toFixed(3)) : null;
}

function wallMs(shutdown, startEpochMs) {
  const end = shutdown?.timestamp ? Date.parse(shutdown.timestamp) : NaN;
  if (!Number.isFinite(end) || !Number.isFinite(startEpochMs)) return null;
  const span = end - startEpochMs;
  return span >= 0 ? span : null;
}

/** Build one host event (usage + metrics) from a session-state log, or null. */
function eventFromSession(file, sessionId, workspace) {
  let records;
  try {
    records = parseJsonl(file);
  } catch {
    return null;
  }

  let start = null;
  let shutdown = null;
  let turns = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  const skillNames = new Set();
  // Actual harness CLI engagement: how often the agent really ran
  // `harness <command>` inside its tool calls. Zero across a session means
  // the engineer contract never exercised the CLI (e.g. only init-repo was
  // ever run by hand) — the report flags that.
  const harnessCliCommands = {};
  let harnessCliCalls = 0;
  for (const record of records) {
    switch (record?.type) {
      case 'session.start':
        start = record;
        break;
      case 'session.shutdown':
        shutdown = record;
        break;
      case 'assistant.turn_start':
        turns += 1;
        break;
      case 'tool.execution_start': {
        toolCalls += 1;
        const text = JSON.stringify(record.data?.arguments ?? '');
        for (const match of text.matchAll(/\bharness(?:\.(?:mjs|cmd|exe))?\s+([a-z][a-z0-9-]{1,32})\b/g)) {
          harnessCliCalls += 1;
          harnessCliCommands[match[1]] = (harnessCliCommands[match[1]] ?? 0) + 1;
        }
        break;
      }
      case 'tool.execution_complete':
        if (record.data?.success === false) toolFailures += 1;
        break;
      case 'skill.invoked':
        if (record.data?.name) skillNames.add(record.data.name);
        break;
      default:
        break;
    }
  }

  const context = start?.data?.context || {};
  if (!matchesWorkspace(context.gitRoot || context.cwd, workspace)) return null;

  const totals = sumModelMetrics(shutdown?.data?.modelMetrics);
  if (!totals) return null; // no authoritative usage — leave to harness estimates

  const session = shutdown?.data?.sessionId || start?.data?.sessionId || sessionId;
  const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning;
  const sd = shutdown?.data || {};
  const codeChanges = sd.codeChanges || {};
  const metrics = {
    model: sd.currentModel || null,
    premiumRequests: Number(sd.totalPremiumRequests) || 0,
    apiRequests: totals.apiRequests,
    apiDurationMs: Number(sd.totalApiDurationMs) || 0,
    wallMs: wallMs(shutdown, Number(sd.sessionStartTime)),
    turns,
    toolCalls,
    harnessCliCalls,
    harnessCliCommands,
    toolFailures,
    skills: skillNames.size,
    skillNames: [...skillNames],
    contextTokens: Number(sd.currentTokens) || 0,
    systemTokens: Number(sd.systemTokens) || 0,
    conversationTokens: Number(sd.conversationTokens) || 0,
    toolDefinitionsTokens: Number(sd.toolDefinitionsTokens) || 0,
    cacheReadRatio: ratio(totals.cacheRead, totals.input + totals.cacheRead),
    tokensPerTurn: turns > 0 ? Math.round(total / turns) : null,
    linesAdded: Number(codeChanges.linesAdded) || 0,
    linesRemoved: Number(codeChanges.linesRemoved) || 0,
    filesModified: Array.isArray(codeChanges.filesModified) ? codeChanges.filesModified.length : 0,
  };

  return {
    version: 2,
    id: `host-ss-${session}`,
    type: 'host_session',
    ts: shutdown?.timestamp || start?.timestamp || null,
    session,
    host: 'github-copilot-vscode',
    source: 'host',
    usage: {
      'gen_ai.usage.input_tokens': totals.input,
      'gen_ai.usage.output_tokens': totals.output,
      'gen_ai.usage.total_tokens': total,
      'gen_ai.usage.cache_read_tokens': totals.cacheRead,
      'gen_ai.usage.cache_write_tokens': totals.cacheWrite,
      'gen_ai.usage.reasoning_tokens': totals.reasoning,
      estimated: false,
    },
    metrics,
  };
}

/** Collect real host usage + metrics from the session-state store. Never throws. */
export function collectSessionState({ workspace, copilotHome } = {}) {
  const dir = sessionStateDir(copilotHome);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // flat legacy *.jsonl carry no modelMetrics
    const file = path.join(dir, entry.name, 'events.jsonl');
    let mtime = 0;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }
    candidates.push({ file, session: entry.name, mtime });
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const events = [];
  for (const candidate of candidates.slice(0, MAX_SESSIONS)) {
    const event = eventFromSession(candidate.file, candidate.session, workspace);
    if (event) events.push(event);
  }
  return events;
}
