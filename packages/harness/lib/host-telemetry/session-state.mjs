import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveCopilotHome } from '../paths.mjs';
import { canonicalDirectoryRoot, directoryRootsOverlap } from './workspace-scope.mjs';

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
 * `tool.execution_complete`, and `skill.invoked`. The stream also supplies
 * content-free system-message and loaded-skill fingerprints, compaction usage,
 * and assistant output tokens split between tool-calling and response-only
 * messages. Prompt and skill bodies are never retained.
 *
 * Each session yields one `source: 'host'`, `estimated: false` event carrying
 * both `usage` (for token roll-ups) and `metrics` (for the performance view).
 * VS Code records provider `prompt_tokens` and `completion_tokens` as the input
 * and output totals. Cache read/write and reasoning are detail subsets used for
 * pricing, not extra tokens to add again. VS Code does not expose per-request
 * input tokens in this store, and context composition is only the final
 * snapshot; both limitations are carried explicitly in `telemetryCoverage`.
 * It never throws — a missing or malformed store degrades the report to
 * harness estimates.
 */

// Bound how many session directories we scan so a long-lived store cannot blow
// up a report. Newest sessions (by mtime) win.
const MAX_SESSIONS = 500;

function sessionStateDir(copilotHome) {
  return path.join(resolveCopilotHome(copilotHome), 'session-state');
}

const MODEL_METRIC_FIELDS = {
  inputTokens: (model) => model?.usage?.inputTokens,
  outputTokens: (model) => model?.usage?.outputTokens,
  cacheReadTokens: (model) => model?.usage?.cacheReadTokens,
  cacheWriteTokens: (model) => model?.usage?.cacheWriteTokens,
  reasoningTokens: (model) => model?.usage?.reasoningTokens,
  apiRequests: (model) => model?.requests?.count,
  totalNanoAiu: (model) => model?.totalNanoAiu,
};

const TOKEN_METRIC_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
];

function modelMetricCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function fieldCoverage(presentModels, expectedModels) {
  if (presentModels === 0) return 'unavailable';
  return presentModels === expectedModels ? 'complete' : 'partial';
}

/** Sum only fields reported by every model in a `session.shutdown` modelMetrics block. */
function sumModelMetrics(modelMetrics) {
  if (!modelMetrics || typeof modelMetrics !== 'object' || Array.isArray(modelMetrics)) return null;
  const models = Object.entries(modelMetrics);
  if (models.length === 0) return null;
  const sums = Object.fromEntries(Object.keys(MODEL_METRIC_FIELDS).map((field) => [field, 0]));
  const present = Object.fromEntries(Object.keys(MODEL_METRIC_FIELDS).map((field) => [field, 0]));
  const byModel = {};
  let sawTokenUsage = false;

  for (const [modelName, model] of models) {
    const modelPresence = {};
    for (const [field, read] of Object.entries(MODEL_METRIC_FIELDS)) {
      const value = modelMetricCount(read(model));
      const isPresent = value !== null;
      modelPresence[field] = isPresent;
      if (!isPresent) continue;
      sums[field] += value;
      present[field] += 1;
      if (TOKEN_METRIC_FIELDS.includes(field)) sawTokenUsage = true;
    }
    byModel[modelName] = modelPresence;
  }

  if (!sawTokenUsage) return null;
  const fields = Object.fromEntries(Object.keys(MODEL_METRIC_FIELDS).map((field) => [field, {
    coverage: fieldCoverage(present[field], models.length),
    presentModels: present[field],
    expectedModels: models.length,
  }]));
  const exactValue = (field) => fields[field].coverage === 'complete' ? sums[field] : null;
  return {
    input: exactValue('inputTokens'),
    output: exactValue('outputTokens'),
    cacheRead: exactValue('cacheReadTokens'),
    cacheWrite: exactValue('cacheWriteTokens'),
    reasoning: exactValue('reasoningTokens'),
    apiRequests: exactValue('apiRequests'),
    nanoAiu: exactValue('totalNanoAiu'),
    sessionTotalsCoverage: TOKEN_METRIC_FIELDS.every((field) => fields[field].coverage === 'complete')
      ? 'exact'
      : 'partial',
    modelMetricsCoverage: {
      expectedModels: models.length,
      fields,
      byModel,
    },
  };
}

/** Include every session for an unscoped report. An explicit workspace only
 * admits sessions with a locatable, overlapping repo root; unscoped sessions
 * are unattributed and must not contaminate workspace totals. */
function matchesWorkspace(sessionRoot, workspace) {
  if (workspace == null) return true;
  return directoryRootsOverlap(
    canonicalDirectoryRoot(sessionRoot),
    canonicalDirectoryRoot(workspace)
  );
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

function aiCreditsFromNano(value) {
  if (value === null || value === undefined || value === '') return null;
  const nanoAiu = Number(value);
  return Number.isFinite(nanoAiu) && nanoAiu >= 0 ? nanoAiu / 1_000_000_000 : null;
}

function optionalCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function contentEvidence(content) {
  if (typeof content !== 'string') {
    return { contentChars: null, contentBytes: null, contentSha256: null };
  }
  return {
    contentChars: content.length,
    contentBytes: Buffer.byteLength(content, 'utf8'),
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

function sanitizeSkillPath(value) {
  if (typeof value !== 'string' || !value) return null;
  const segments = value
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  let skillRoot = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].toLowerCase() === 'skills') {
      skillRoot = index;
      break;
    }
  }
  return (skillRoot >= 0 ? segments.slice(skillRoot) : segments.slice(-1)).join('/') || null;
}

function observedCoverage(records, completeRecords) {
  if (records === 0) return 'unavailable';
  return records === completeRecords ? 'complete' : 'partial';
}

function compactionUsage(value) {
  const scalar = optionalCount(value);
  if (scalar !== null) {
    return { total: scalar, input: 0, output: 0, cachedInput: 0, componentsComplete: false };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = optionalCount(value.input ?? value.inputTokens);
  const output = optionalCount(value.output ?? value.outputTokens);
  const cachedInput = optionalCount(value.cachedInput ?? value.cachedInputTokens);
  if ([input, output, cachedInput].every((count) => count === null)) return null;
  return {
    total: (input ?? 0) + (output ?? 0),
    input: input ?? 0,
    output: output ?? 0,
    cachedInput: cachedInput ?? 0,
    componentsComplete: input !== null && output !== null && cachedInput !== null,
  };
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
  const systemMessages = [];
  const loadedSkills = new Map();
  let systemMessageRecords = 0;
  let systemMessageRecordsWithContent = 0;
  let skillInvocationRecords = 0;
  let skillInvocationRecordsWithMetadata = 0;
  const compaction = {
    started: 0,
    completed: 0,
    failed: 0,
    compactionTokensUsed: 0,
    compactionInputTokens: 0,
    compactionOutputTokens: 0,
    compactionCachedInputTokens: 0,
    preCompactionTokens: 0,
    preCompactionMessages: 0,
    completionsWithTokenUsage: 0,
    completionsWithComponentUsage: 0,
  };
  const assistantOutput = {
    messages: 0,
    messagesWithTokens: 0,
    observedTokens: 0,
    byPhase: { toolCalling: 0, responseOnly: 0 },
  };
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
      case 'assistant.message': {
        assistantOutput.messages += 1;
        const outputTokens = optionalCount(record.data?.outputTokens);
        if (outputTokens !== null) {
          assistantOutput.messagesWithTokens += 1;
          assistantOutput.observedTokens += outputTokens;
          const phase = Array.isArray(record.data?.toolRequests) && record.data.toolRequests.length > 0
            ? 'toolCalling'
            : 'responseOnly';
          assistantOutput.byPhase[phase] += outputTokens;
        }
        break;
      }
      case 'system.message': {
        systemMessageRecords += 1;
        const evidence = contentEvidence(record.data?.content);
        if (evidence.contentSha256) systemMessageRecordsWithContent += 1;
        systemMessages.push({
          ordinal: systemMessages.length,
          role: typeof record.data?.role === 'string' ? record.data.role : null,
          chars: evidence.contentChars,
          bytes: evidence.contentBytes,
          sha256: evidence.contentSha256,
        });
        break;
      }
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
      case 'skill.invoked': {
        skillInvocationRecords += 1;
        if (record.data?.name) skillNames.add(record.data.name);
        const evidence = contentEvidence(record.data?.content);
        const sanitizedPath = sanitizeSkillPath(record.data?.path);
        const skill = {
          name: typeof record.data?.name === 'string' ? record.data.name : null,
          path: sanitizedPath,
          ...evidence,
        };
        if (skill.name && skill.path && skill.contentSha256) skillInvocationRecordsWithMetadata += 1;
        const key = JSON.stringify(skill);
        const prior = loadedSkills.get(key);
        if (prior) prior.invocations += 1;
        else loadedSkills.set(key, { ...skill, invocations: 1 });
        break;
      }
      case 'session.compaction_start':
        compaction.started += 1;
        break;
      case 'session.compaction_complete': {
        compaction.completed += 1;
        if (record.data?.success === false) compaction.failed += 1;
        const usage = compactionUsage(record.data?.compactionTokensUsed);
        if (usage) {
          compaction.compactionTokensUsed += usage.total;
          compaction.compactionInputTokens += usage.input;
          compaction.compactionOutputTokens += usage.output;
          compaction.compactionCachedInputTokens += usage.cachedInput;
          compaction.completionsWithTokenUsage += 1;
          if (usage.componentsComplete) compaction.completionsWithComponentUsage += 1;
        }
        compaction.preCompactionTokens += optionalCount(record.data?.preCompactionTokens) ?? 0;
        compaction.preCompactionMessages += optionalCount(record.data?.preCompactionMessagesLength) ?? 0;
        break;
      }
      default:
        break;
    }
  }

  const context = start?.data?.context || {};
  if (!matchesWorkspace(context.gitRoot || context.cwd, workspace)) return null;

  const totals = sumModelMetrics(shutdown?.data?.modelMetrics);
  if (!totals) return null; // no authoritative usage — leave to harness estimates

  const session = shutdown?.data?.sessionId || start?.data?.sessionId || sessionId;
  const sd = shutdown?.data || {};
  const total = totals.input !== null && totals.output !== null
    ? totals.input + totals.output
    : null;
  const aiCredits = aiCreditsFromNano(
    sd.totalNanoAiu ?? totals.nanoAiu
  );
  const codeChanges = sd.codeChanges || {};
  const contextTokens = optionalCount(sd.currentTokens);
  const systemTokens = optionalCount(sd.systemTokens);
  const conversationTokens = optionalCount(sd.conversationTokens);
  const toolDefinitionsTokens = optionalCount(sd.toolDefinitionsTokens);
  const contextFields = [
    contextTokens,
    systemTokens,
    conversationTokens,
    toolDefinitionsTokens,
  ];
  const contextFieldsAvailable = contextFields.filter((value) => value !== null).length;
  const finalContextReconciles = contextFieldsAvailable === contextFields.length
    ? contextTokens === systemTokens + conversationTokens + toolDefinitionsTokens
    : null;
  const finalContextCoverage = contextFieldsAvailable === 0
    ? 'unavailable'
    : contextFieldsAvailable === contextFields.length && finalContextReconciles
      ? 'complete'
      : 'partial';
  const systemMessageCoverage = observedCoverage(systemMessageRecords, systemMessageRecordsWithContent);
  const loadedSkillCoverage = observedCoverage(skillInvocationRecords, skillInvocationRecordsWithMetadata);
  const assistantReconciliation = assistantOutput.messagesWithTokens > 0 && totals.output !== null
    ? assistantOutput.observedTokens === totals.output
    : null;
  const assistantCoverage = assistantOutput.messages === 0 || assistantOutput.messagesWithTokens === 0
    ? 'unavailable'
    : assistantOutput.messagesWithTokens === assistantOutput.messages && assistantReconciliation === true
      ? 'complete'
      : 'partial';
  const compactionCoverage = compaction.started === 0 && compaction.completed === 0
    ? 'unavailable'
    : compaction.started === compaction.completed &&
        compaction.completed > 0 &&
        compaction.completionsWithTokenUsage === compaction.completed &&
        compaction.completionsWithComponentUsage === compaction.completed
      ? 'complete'
      : 'partial';
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
    contextTokens,
    systemTokens,
    conversationTokens,
    toolDefinitionsTokens,
    promptEvidence: {
      systemMessages,
      loadedSkills: [...loadedSkills.values()],
      coverage: {
        systemMessages: systemMessageCoverage,
        loadedSkills: loadedSkillCoverage,
      },
    },
    compaction: {
      ...compaction,
      coverage: compactionCoverage,
    },
    assistantOutput: {
      ...assistantOutput,
      coverage: assistantCoverage,
      reconcilesSessionOutput: assistantReconciliation,
    },
    telemetryCoverage: {
      sessionTotals: totals.sessionTotalsCoverage,
      modelMetrics: totals.modelMetricsCoverage,
      finalContextSnapshot: finalContextCoverage,
      finalContextReconciles,
      perRequestInputTokens: 'unavailable',
      systemMessages: systemMessageCoverage,
      loadedSkills: loadedSkillCoverage,
      compactions: compactionCoverage,
      assistantOutputByPhase: assistantCoverage,
    },
    cacheReadRatio: ratio(totals.cacheRead, totals.input),
    aiCredits,
    tokensPerTurn: turns > 0 && total !== null ? Math.round(total / turns) : null,
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
      ...(totals.input !== null ? { 'gen_ai.usage.input_tokens': totals.input } : {}),
      ...(totals.output !== null ? { 'gen_ai.usage.output_tokens': totals.output } : {}),
      ...(total !== null ? { 'gen_ai.usage.total_tokens': total } : {}),
      ...(totals.cacheRead !== null ? { 'gen_ai.usage.cache_read_tokens': totals.cacheRead } : {}),
      ...(totals.cacheWrite !== null ? { 'gen_ai.usage.cache_write_tokens': totals.cacheWrite } : {}),
      ...(totals.reasoning !== null ? { 'gen_ai.usage.reasoning_tokens': totals.reasoning } : {}),
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
