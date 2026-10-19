import fs from 'node:fs';
import path from 'node:path';
import { resolveCopilotHome } from '../paths.mjs';
import { collectSessionState } from './session-state.mjs';
import { canonicalDirectoryRoot, directoryRootsOverlap } from './workspace-scope.mjs';

const NORMALIZED_WORKSPACE = Symbol('normalizedWorkspace');

function candidateLogs(copilotHome) {
  const candidates = [];
  if (process.env.HARNESS_VSCODE_USAGE_LOG) candidates.push(process.env.HARNESS_VSCODE_USAGE_LOG);
  candidates.push(path.join(resolveCopilotHome(copilotHome), 'host-usage', 'vscode.jsonl'));
  const paths = [];
  const seen = new Set();
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (!fs.statSync(resolved).isFile() || seen.has(resolved)) continue;
      seen.add(resolved);
      paths.push(resolved);
    } catch {
      // Missing, unreadable, or non-file candidates are ignored.
    }
  }
  return paths;
}

const NUMERIC_COUNT_TEXT = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function normalizedCount(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !NUMERIC_COUNT_TEXT.test(value)) return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const input =
    record.inputTokens ?? record.input_tokens ?? record.prompt_tokens ?? record['gen_ai.usage.input_tokens'];
  const output =
    record.outputTokens ?? record.output_tokens ?? record.completion_tokens ?? record['gen_ai.usage.output_tokens'];
  const inTok = normalizedCount(input);
  const outTok = normalizedCount(output);
  if (inTok === null && outTok === null) return null;
  const inputTokens = inTok ?? 0;
  const outputTokens = outTok ?? 0;
  const cacheRead = normalizedCount(
    record.cacheReadTokens ?? record.cache_read_tokens ?? record['gen_ai.usage.cache_read_tokens']
  );
  const cacheWrite = normalizedCount(
    record.cacheWriteTokens ?? record.cache_write_tokens ?? record['gen_ai.usage.cache_write_tokens']
  );
  const reasoning = normalizedCount(
    record.reasoningTokens ?? record.reasoning_tokens ?? record['gen_ai.usage.reasoning_tokens']
  );
  const normalized = {
    version: 2,
    id: record.id || `host-${record.sessionId || 'x'}-${record.ts || inputTokens + outputTokens}`,
    type: record.type || 'host_request',
    ts: record.ts || record.timestamp || null,
    session: record.sessionId || record.session || null,
    host: 'github-copilot-vscode',
    source: 'host',
    usageCompleteness: {
      inputTokens: inTok !== null,
      outputTokens: outTok !== null,
    },
    usage: {
      ...(inTok !== null ? { 'gen_ai.usage.input_tokens': inTok } : {}),
      ...(outTok !== null ? { 'gen_ai.usage.output_tokens': outTok } : {}),
      ...(inTok !== null && outTok !== null
        ? { 'gen_ai.usage.total_tokens': inTok + outTok }
        : {}),
      ...(cacheRead !== null ? { 'gen_ai.usage.cache_read_tokens': cacheRead } : {}),
      ...(cacheWrite !== null ? { 'gen_ai.usage.cache_write_tokens': cacheWrite } : {}),
      ...(reasoning !== null ? { 'gen_ai.usage.reasoning_tokens': reasoning } : {}),
      estimated: false,
    },
  };
  Object.defineProperty(normalized, NORMALIZED_WORKSPACE, {
    value: canonicalDirectoryRoot(
      record.workspaceRoot ?? record.workspace ?? record.gitRoot ?? record.cwd ?? null
    ),
    enumerable: false,
  });
  return normalized;
}

function collectNormalizedLog(copilotHome) {
  const events = [];
  for (const file of candidateLogs(copilotHome)) {
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

function mergeNormalizedEvidence(records, sessionState) {
  const input = records.reduce(
    (sum, event) => sum + (event.usage?.['gen_ai.usage.input_tokens'] || 0),
    0
  );
  const output = records.reduce(
    (sum, event) => sum + (event.usage?.['gen_ai.usage.output_tokens'] || 0),
    0
  );
  const authoritativeInput = sessionState.usage?.['gen_ai.usage.input_tokens'];
  const authoritativeOutput = sessionState.usage?.['gen_ai.usage.output_tokens'];
  const expectedRequests = sessionState.metrics?.apiRequests > 0
    ? sessionState.metrics.apiRequests
    : null;
  const tokenTotalsReconcile = input === authoritativeInput && output === authoritativeOutput;
  const requestCountReconciles = expectedRequests !== null && records.length === expectedRequests;
  const recordFieldsComplete = records.every((event) =>
    event.usageCompleteness?.inputTokens === true && event.usageCompleteness?.outputTokens === true
  );
  const requestIdentitiesUnique = records.every((event) => typeof event.id === 'string' && event.id.length > 0) &&
    new Set(records.map((event) => event.id)).size === records.length;
  const evidenceCoverage = tokenTotalsReconcile && requestCountReconciles &&
    recordFieldsComplete && requestIdentitiesUnique ? 'complete' : 'partial';
  const telemetryCoverage = {
    ...sessionState.metrics?.telemetryCoverage,
    perRequestInputTokens: evidenceCoverage,
  };
  return {
    ...sessionState,
    metrics: {
      ...sessionState.metrics,
      tokenSource: evidenceCoverage === 'complete'
        ? 'session-shutdown+normalized-requests'
        : 'session-shutdown',
      normalizedRequestEvidence: {
        requests: records.length,
        expectedRequests,
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        tokenTotalsReconcile,
        requestCountReconciles,
        recordFieldsComplete,
        requestIdentitiesUnique,
        coverage: evidenceCoverage,
      },
      telemetryCoverage,
    },
  };
}

function asRequestEvidence(event) {
  const { usage, ...metadata } = event;
  return {
    ...metadata,
    usage: undefined,
    requestUsage: usage,
    evidenceOnly: true,
  };
}

export function collect({ workspace, copilotHome } = {}) {
  const normalized = collectNormalizedLog(copilotHome);
  const sessionState = collectSessionState({ workspace, copilotHome });
  const stateBySession = new Map(
    sessionState.filter((event) => event.session).map((event) => [event.session, event])
  );
  const canonicalTarget = canonicalDirectoryRoot(workspace);
  const scopedNormalized = workspace
    ? normalized.filter((event) =>
        (event.session && stateBySession.has(event.session)) ||
        directoryRootsOverlap(event[NORMALIZED_WORKSPACE], canonicalTarget)
      )
    : normalized;
  const normalizedBySession = new Map();
  for (const event of scopedNormalized) {
    if (!event.session || !stateBySession.has(event.session)) continue;
    const bucket = normalizedBySession.get(event.session) || [];
    bucket.push(event);
    normalizedBySession.set(event.session, bucket);
  }

  const output = scopedNormalized.map((event) =>
    event.session && stateBySession.has(event.session) ? asRequestEvidence(event) : event
  );
  for (const event of sessionState) {
    const records = normalizedBySession.get(event.session);
    output.push(records ? mergeNormalizedEvidence(records, event) : event);
  }
  return output;
}
