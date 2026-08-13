import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSlug } from '../telemetry-store.mjs';

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
    workspace: record.workspace || record.workspacePath || record.cwd || record.projectPath || null,
    project: record.project || record.repository || record.repo || null,
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

function normalizedWorkspace(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let raw = value.trim();
  if (raw.startsWith('file://')) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname);
    } catch {
      return null;
    }
  }
  const windows = path.win32.isAbsolute(raw);
  const normalized = windows ? path.win32.normalize(raw) : path.resolve(raw);
  const portable = normalized.replace(/\\/g, '/').replace(/\/$/, '');
  return windows ? portable.toLowerCase() : portable;
}

function normalizedProject(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const remote = raw.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1];
  return (remote || raw)
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || null;
}

function belongsToReport(record, { workspace, sessions, global, requestedProject }) {
  if (global) return true;
  const session = record.sessionId || record.session || null;
  const knownSessions = sessions instanceof Set ? sessions : new Set(sessions || []);
  if (session && knownSessions.has(session)) return true;
  const requested = normalizedWorkspace(workspace);
  if (!requested) return false;
  const workspaceMatches = [record.workspace, record.workspacePath, record.cwd, record.projectPath, record.root]
    .map(normalizedWorkspace)
    .some((candidate) => candidate === requested);
  if (workspaceMatches) return true;
  return [record.project, record.repository, record.repo]
    .map(normalizedProject)
    .some((candidate) => candidate === requestedProject);
}

export function collect({ workspace, sessions = [], global = false } = {}) {
  const events = [];
  const requestedProject = global || !workspace ? null : projectSlug(workspace).toLowerCase();
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
        if (!belongsToReport(record, { workspace, sessions, global, requestedProject })) continue;
        const normalized = normalizeRecord(record);
        if (normalized) events.push(normalized);
      }
    } catch {
      // Best-effort: skip unreadable logs.
    }
  }
  return events;
}
