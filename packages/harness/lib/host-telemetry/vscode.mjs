import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Best-effort VS Code / GitHub Copilot Chat host-usage adapter.
 *
 * GHCP does not officially expose per-request token usage, and the debug-log
 * format is version-specific, so this adapter is deliberately conservative:
 * it reads a normalized usage log if one is present (HARNESS_VSCODE_USAGE_LOG,
 * or `~/.copilot/host-usage/vscode.jsonl`), recognizes a couple of known
 * token-count shapes, and returns [] otherwise. It never throws — a missing or
 * unparseable log simply means the report falls back to harness estimates.
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

export function collect() {
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
