import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSessionState } from './session-state.mjs';

/**
 * VS Code / GitHub Copilot Chat host-usage adapter.
 *
 * Two sources, most-authoritative first:
 *  1. The Copilot session-state store (`<copilotHome>/session-state/<id>/
 *     events.jsonl`), which carries real per-session token totals including
 *     cache and reasoning tokens — see session-state.mjs.
 *  2. A normalized usage log (HARNESS_VSCODE_USAGE_LOG, or
 *     `~/.copilot/host-usage/vscode.jsonl`) for hosts or workflows that emit
 *     their own token counts.
 *
 * The normalized log overrides the session-state event for the same session so
 * a session is never double-counted. Both are marked `source: host` /
 * `estimated: false`. It never throws — with no usable source the report falls
 * back to harness estimates.
 */

function candidateLogs() {
  const paths = [];
  if (process.env.HARNESS_VSCODE_USAGE_LOG) paths.push(process.env.HARNESS_VSCODE_USAGE_LOG);
  paths.push(path.join(os.homedir(), '.copilot', 'host-usage', 'vscode.jsonl'));
  return paths.filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const input =
    record.inputTokens ?? record.input_tokens ?? record.prompt_tokens ?? record['gen_ai.usage.input_tokens'];
  const output =
    record.outputTokens ?? record.output_tokens ?? record.completion_tokens ?? record['gen_ai.usage.output_tokens'];
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const inTok = Number(input) || 0;
  const outTok = Number(output) || 0;
  return {
    version: 2,
    id: record.id || `host-${record.sessionId || 'x'}-${record.ts || inTok + outTok}`,
    type: record.type || 'host_request',
    ts: record.ts || record.timestamp || null,
    session: record.sessionId || record.session || null,
    host: 'github-copilot-vscode',
    source: 'host',
    usage: {
      'gen_ai.usage.input_tokens': inTok,
      'gen_ai.usage.output_tokens': outTok,
      'gen_ai.usage.total_tokens': inTok + outTok,
      estimated: false,
    },
  };
}

function collectNormalizedLog() {
  const events = [];
  for (const file of candidateLogs()) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let record = null;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const normalized = normalizeRecord(record);
        if (normalized) events.push(normalized);
      }
    } catch {
      // Best-effort: skip unreadable logs.
    }
  }
  return events;
}

export function collect({ workspace, copilotHome } = {}) {
  const normalized = collectNormalizedLog();
  const overridden = new Set(normalized.map((e) => e.session).filter(Boolean));
  const sessionState = collectSessionState({ workspace, copilotHome }).filter(
    (e) => !overridden.has(e.session)
  );
  return [...normalized, ...sessionState];
}
