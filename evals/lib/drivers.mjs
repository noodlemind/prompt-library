/**
 * Decision drivers for deterministic replays and live OpenAI-compatible
 * tool-use evals. The live driver owns measurement, bounded context, provider
 * billing evidence, and the post-verification stop contract.
 */
import crypto from 'node:crypto';
import { costOfUsage, estimateRequestCostUsd } from './budget.mjs';
import {
  PROMPT_COMPONENT_MANIFEST_SEPARATOR,
  validatePromptComponentManifestStructure,
} from './prompt-manifest.mjs';

export class ProviderError extends Error {
  constructor(message, { kind, billed = false, status = null, billingUncertain = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.billed = billed;
    this.status = status;
    this.billingUncertain = billingUncertain;
  }
}

/** Deterministic / recorded driver: yields actions in order, then finishes. */
export function replayDriver(actions, { name = 'replay', model = 'scripted' } = {}) {
  let i = 0;
  return {
    name,
    model,
    next: async () => {
      if (i >= actions.length) return { type: 'finish', answer: '(replay exhausted)', stopReason: 'replay_exhausted' };
      return actions[i++];
    },
  };
}

function normalizeProviderName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function requestControlProjection(endpoint, body) {
  const allowedFields = new Set([
    'model',
    'messages',
    'tools',
    'tool_choice',
    'max_tokens',
    'temperature',
    'reasoning',
    'provider',
  ]);
  const unexpectedRequestFields = Object.keys(body)
    .filter((field) => !allowedFields.has(field))
    .sort();
  const providerPresent = Object.hasOwn(body, 'provider');
  const providerOrder = Array.isArray(body.provider?.order) ? body.provider.order.slice() : null;
  return {
    endpointHash: sha256(endpoint),
    model: body.model ?? null,
    maxTokens: body.max_tokens ?? null,
    temperaturePresent: Object.hasOwn(body, 'temperature'),
    temperature: Object.hasOwn(body, 'temperature') ? body.temperature : null,
    reasoningPresent: Object.hasOwn(body, 'reasoning'),
    reasoning: Object.hasOwn(body, 'reasoning') ? body.reasoning : null,
    toolChoice: body.tool_choice ?? null,
    providerPresent,
    providerOrder,
    providerAllowFallbacks: providerPresent && typeof body.provider?.allow_fallbacks === 'boolean'
      ? body.provider.allow_fallbacks
      : null,
    unexpectedRequestFields,
  };
}

function redactExactSecret(value, secret) {
  if (!secret || String(secret).length < 8) return structuredClone(value);
  if (typeof value === 'string') return value.split(secret).join('[REDACTED_SECRET]');
  if (Array.isArray(value)) return value.map((item) => redactExactSecret(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redactExactSecret(key, secret), redactExactSecret(item, secret)])
    );
  }
  return value;
}

function roleChars(messages) {
  const totals = {};
  for (const message of messages) {
    const role = message.role || 'unknown';
    totals[role] = (totals[role] || 0) + JSON.stringify(message).length;
  }
  return totals;
}

function validatedPromptComponentManifest(manifest, systemPrompt) {
  if (manifest == null) return null;
  const structural = validatePromptComponentManifestStructure(manifest);
  if (!structural.valid && structural.reason === 'unexpected-field') {
    throw new ProviderError('prompt component manifest contains an unexpected field', { kind: 'contract', billed: false });
  }
  if (!structural.valid) {
    throw new ProviderError('prompt component manifest does not match the system prompt', { kind: 'contract', billed: false });
  }
  const value = structural.manifest;
  const components = value.components;
  const shapeMatchesContent =
    value.systemPromptChars === systemPrompt.length &&
    value.systemPromptBytes === Buffer.byteLength(systemPrompt, 'utf8') &&
    value.systemPromptHash === sha256(systemPrompt);
  if (!shapeMatchesContent) {
    throw new ProviderError('prompt component manifest does not match the system prompt', { kind: 'contract', billed: false });
  }

  for (let ordinal = 0; ordinal < components.length; ordinal += 1) {
    const component = components[ordinal];
    const content = systemPrompt.slice(component.startChar, component.endChar);
    const validComponent =
      component.chars === content.length &&
      component.bytes === Buffer.byteLength(content, 'utf8') &&
      component.sha256 === sha256(content);
    if (!validComponent) {
      throw new ProviderError('prompt component manifest contains an invalid component span', { kind: 'contract', billed: false });
    }
    if (ordinal < components.length - 1 &&
        systemPrompt.slice(
          component.endChar,
          component.endChar + PROMPT_COMPONENT_MANIFEST_SEPARATOR.length
        ) !== PROMPT_COMPONENT_MANIFEST_SEPARATOR) {
      throw new ProviderError('prompt component manifest separator does not match the system prompt', { kind: 'contract', billed: false });
    }
  }
  return value;
}

function shellCommandSegments(command) {
  const text = String(command || '');
  const segments = [];
  let start = 0;
  let quote = null;
  let escaped = false;

  function push(end) {
    const segment = text.slice(start, end).trim();
    if (segment) segments.push(segment);
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ';' || char === '\n' || char === '(' || char === ')' || char === '&' || char === '|') {
      push(index);
      if ((char === '&' || char === '|') && text[index + 1] === char) index += 1;
      start = index + 1;
    }
  }
  push(text.length);
  return segments;
}

function shellWords(command) {
  const words = [];
  let word = '';
  let quote = null;
  let escaped = false;
  let started = false;

  const push = () => {
    if (!started) return;
    words.push(word);
    word = '';
    started = false;
  };

  for (const char of String(command || '')) {
    if (escaped) {
      word += char;
      started = true;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    word += char;
    started = true;
  }
  if (escaped) word += '\\';
  push();
  return words;
}

function commandCategory(command) {
  const text = String(command || '').trim();
  const operation = harnessOperation(text);
  if (operation === 'orient') return 'orient';
  if (['plan-new', 'validate-plan'].includes(operation) || /docs\/plans\//.test(text)) return 'plan';
  if (operation === 'gate') return 'gate';
  if (operation === 'verify') return 'verify';
  const gitPrefix = String.raw`\bgit(?:\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+|--(?:git-dir|work-tree)=\S+))*\s+`;
  const mutatingGit = new RegExp(
    `${gitPrefix}(?:add|am|apply|branch|checkout|cherry-pick|clean|clone|commit|filter-branch|filter-repo|gc|merge|mv|rebase|reflog\\s+(?:delete|expire)|remote\\s+(?:add|remove|rename|set-url)|reset|restore|revert|rm|stash|switch|tag|update-index|update-ref|worktree\\s+(?:add|move|prune|remove))\\b`
  );
  const inspectingGit = new RegExp(
    `${gitPrefix}(?:cat-file|diff|fsck|grep|log|ls-files|ls-tree|merge-base|rev-list|rev-parse|show|status)\\b`
  );
  if (/\bgit-filter-repo\b/.test(text) || mutatingGit.test(text)) return 'edit';
  const scriptedWrite = /\b(?:python|node|perl|ruby)\b[^\n]*(?:write_text|write_bytes|writeFile|appendFile|\.write\s*\(|open\s*\([^)]*,\s*['"][wax+])/.test(text);
  if (/(?:^|\s)(?:>|>>)|\bsed\s+-i\b|\b(?:rm|mv|cp|install|touch|mkdir)\b/.test(text) || scriptedWrite) return 'edit';
  const testCommands = [
    /^(?:npm|pnpm|yarn)(?:\s+(?:--(?:prefix|workspace|filter|dir|cwd)(?:=\S+|\s+\S+)|-[CwF]\s+\S+|--\S+(?:=\S+)?|-\S+))*\s+(?:workspace\s+\S+\s+)?(?:(?:run|run-script)\s+)?(?:test|verify)(?::[\w.-]+)?(?=\s|$)/,
    /^(?:npx|pnpm\s+exec|yarn\s+dlx)\s+(?:--?\S+\s+)*(?:[\w./-]*\/)?(?:vitest|jest)(?=\s|$)/,
    /^(?:[\w./-]*\/)?(?:vitest|jest|pytest)(?=\s|$)/,
    /^python(?:3(?:\.\d+)?)?\s+-m\s+pytest(?=\s|$)/,
    /^(?:[\w./-]*\/)?node\b[^\n;&|]*\s--test(?:=\S+)?(?=\s|$)/,
    /^(?:go|cargo|bun|deno|dotnet)\s+test(?=\s|$)/,
    /^cargo\s+nextest\s+run(?=\s|$)/,
    /^(?:mvn|mvnw|\.\/mvnw|gradle|gradlew|\.\/gradlew)\b[^\n;&|]*\b(?:test|verify)\b/,
    /^make\b[^\n;&|]*\b(?:test|verify)(?=\s|$)/,
    /^(?:\.\/)?(?:[\w.-]+\/)*test(?=\s|$)/,
  ];
  if (shellCommandSegments(text).some((segment) => testCommands.some((pattern) => pattern.test(segment)))) {
    return 'test';
  }
  if (inspectingGit.test(text) || /\b(?:cat|sed|rg|grep|find|ls|pwd|head|tail|wc)\b/.test(text)) return 'inspect';
  return 'other';
}

function commandProgram(command) {
  return String(command || '').trim().split(/\s+/)[0]?.replace(/^.*\//, '') || null;
}

const KNOWN_HARNESS_OPERATIONS = new Set([
  'orient', 'recall', 'learnings', 'remember', 'compound', 'index', 'consolidate',
  'plan-new', 'validate-plan', 'gate', 'verify', 'doctor', 'report',
]);

function harnessInvocation(command) {
  for (const segment of shellCommandSegments(command)) {
    const words = shellWords(segment);
    let executableIndex = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executableIndex] || '')) executableIndex += 1;
    const executable = words[executableIndex];
    const immutable = executable === '/opt/harness-bundle/harness-cli';
    if (executable !== 'harness' && !immutable) continue;
    const candidate = words[executableIndex + 1] || null;
    return {
      immutable,
      operation: KNOWN_HARNESS_OPERATIONS.has(candidate) ? candidate : null,
    };
  }
  return null;
}

function harnessOperation(command) {
  return harnessInvocation(command)?.operation ?? null;
}

function contextSourceFor({ toolName, command, category }) {
  if (toolName === 'load_guidance') return 'guidance-retrieval';
  if (toolName === 'checkpoint') return 'durable-state';
  const operation = harnessOperation(command);
  if (['orient', 'recall', 'learnings'].includes(operation)) return 'memory-retrieval';
  if (['remember', 'compound', 'index'].includes(operation)) return 'memory-construction';
  if (operation === 'consolidate') return 'memory-consolidation';
  if (operation === 'gate' || operation === 'plan-new' || operation === 'validate-plan') return 'planning-and-gate';
  if (operation === 'verify' || toolName === 'verify_harness') return 'verification';
  return category || 'unknown';
}

function invokesImmutableHarnessCli(command) {
  return harnessInvocation(command)?.immutable === true;
}

function changedPaths(command) {
  const text = String(command || '');
  const paths = new Set();
  for (const match of text.matchAll(/(?:>|>>)\s*['"]?([^\s'";&|]+)/g)) paths.add(match[1]);
  for (const match of text.matchAll(/\bsed\s+-i(?:\s+[^\s]+)?\s+['"][^'"]*['"]\s+([^\s;&|]+)/g)) paths.add(match[1]);
  return [...paths].filter((value) => value && value !== '/dev/null').slice(0, 50);
}

function excerpt(value, budget) {
  const text = String(value || '');
  if (text.length <= budget) return text;
  if (budget <= 0) return '';
  const marker = `\n… ${text.length - budget} chars omitted …\n`;
  if (marker.length >= budget) return text.slice(-budget);
  const remaining = budget - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

/** Valid JSON, bounded without prefix-slicing through a string escape. */
function compactToolResult(result, limit) {
  const raw = JSON.stringify(result);
  if (raw.length <= limit) return { content: raw, compacted: false, originalChars: raw.length };
  const stdout = String(result?.stdout ?? '');
  const stderr = String(result?.stderr ?? '');
  const code = Number.isFinite(result?.code) ? result.code : null;
  let stdoutBudget = Math.max(0, Math.floor((limit - 180) * 0.65));
  let stderrBudget = Math.max(0, Math.floor((limit - 180) * 0.35));
  let content = '';
  while (stdoutBudget >= 0 && stderrBudget >= 0) {
    const shaped = {
      code,
      stdout: excerpt(stdout, stdoutBudget),
      stderr: excerpt(stderr, stderrBudget),
      _truncated: {
        originalChars: raw.length,
        omittedChars: Math.max(0, stdout.length + stderr.length - stdoutBudget - stderrBudget),
        sha256: sha256(raw),
      },
    };
    content = JSON.stringify(shaped);
    if (content.length <= limit) break;
    if (stdoutBudget >= stderrBudget && stdoutBudget > 0) stdoutBudget = Math.floor(stdoutBudget * 0.75);
    else if (stderrBudget > 0) stderrBudget = Math.floor(stderrBudget * 0.75);
    else break;
  }
  if (content.length > limit) {
    content = JSON.stringify({ code, _truncated: { originalChars: raw.length } });
  }
  if (content.length > limit) content = JSON.stringify({ _truncated: true });
  return { content, compacted: true, originalChars: raw.length };
}

function completedTurns(history) {
  const turns = [];
  for (let i = 0; i < history.length; i += 1) {
    const assistant = history[i];
    if (assistant.role !== 'assistant') continue;
    const turn = [assistant];
    const ids = new Set((assistant.tool_calls || []).map((call) => call.id));
    if (ids.size) {
      let j = i + 1;
      while (j < history.length && history[j].role === 'tool') {
        turn.push(history[j]);
        ids.delete(history[j].tool_call_id);
        j += 1;
      }
      if (ids.size) continue;
      i = j - 1;
    }
    turns.push(turn);
  }
  return turns;
}

function boundedState(state, maxChars) {
  const json = JSON.stringify(state);
  if (json.length <= maxChars) return json;
  const reduced = {
    schema: state.schema || 'eval-agent-state.v1',
    revision: state.revision || 0,
    goal: String(state.goal || '').slice(0, 1000),
    constraints: (state.constraints || []).slice(-10).map((value) => String(value).slice(0, 300)),
    files: {
      inspected: (state.files?.inspected || []).slice(-30),
      changed: (state.files?.changed || []).slice(-30),
    },
    tests: (state.tests || []).slice(-10),
    failures: (state.failures || []).slice(-10),
    lifecycle: state.lifecycle || {},
    loadedGuidance: (state.loadedGuidance || []).slice(-10),
    nextAction: state.nextAction || null,
  };
  const reducedJson = JSON.stringify(reduced);
  if (reducedJson.length <= maxChars) return reducedJson;

  const describe = (value) => {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const tailSummaries = (values, count, chars, summarize = describe) =>
    (Array.isArray(values) ? values : [])
      .slice(-count)
      .map((value) => summarize(value).slice(0, chars));
  const testSummary = (value) => value && typeof value === 'object'
    ? `${value.status ?? 'unknown'}:${value.command ?? 'test'}:${value.summary ?? ''}`
    : describe(value);
  const failureSummary = (value) => value && typeof value === 'object'
    ? `exit-${value.exitCode ?? 'unknown'}:${value.command ?? 'tool'}:${value.summary ?? ''}`
    : describe(value);
  for (const { chars, items, metadata } of [
    { chars: 160, items: 3, metadata: true },
    { chars: 80, items: 2, metadata: false },
    { chars: 40, items: 1, metadata: false },
    { chars: 16, items: 1, metadata: false },
    { chars: 8, items: 1, metadata: false },
    { chars: 2, items: 1, metadata: false },
  ]) {
    const operational = {
      ...(metadata ? {
        schema: state.schema || 'eval-agent-state.v1',
        revision: state.revision || 0,
        stateHash: sha256(json),
      } : {}),
      goal: String(state.goal || '').slice(0, chars),
      constraints: tailSummaries(state.constraints, items, chars),
      files: { changed: tailSummaries(state.files?.changed, items, chars) },
      tests: tailSummaries(state.tests, items, chars, testSummary),
      failures: tailSummaries(state.failures, items, chars, failureSummary),
      nextAction: state.nextAction == null ? null : describe(state.nextAction).slice(0, chars),
      truncated: true,
    };
    const candidate = JSON.stringify(operational);
    if (candidate.length <= maxChars) return candidate;
  }
  const marker = JSON.stringify({ truncated: true });
  return marker.length <= maxChars ? marker : '{}';
}

/** Live model via an OpenAI-compatible chat/completions tool-use endpoint. */
export function openAiToolDriver({
  url,
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  maxTokens,
  profile = null,
  temperature,
  reasoning,
  provider,
  pricing,
  budget = null,
  telemetry = null,
  toolResultLimit = 1600,
  requestTimeoutMs,
  transientRetries = 4,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
  maxPayloadChars = 32_768,
  retainCompletedTurns = 1,
  maxStateChars = 6144,
} = {}) {
  const endpoint = url ?? profile?.url;
  const requestedModel = model ?? profile?.model;
  if (!endpoint || !apiKey || !requestedModel) return null;

  const maxOutputTokens = maxTokens ?? profile?.maxTokens ?? 2048;
  const effTemperature = temperature !== undefined ? temperature : profile?.temperature ?? null;
  const effReasoning = reasoning !== undefined ? reasoning : profile?.reasoning ?? null;
  const effProvider = provider !== undefined ? provider : profile?.provider ?? null;
  const expectedResolvedModels = Array.isArray(effProvider?.expectedResolvedModels)
    ? effProvider.expectedResolvedModels
    : [requestedModel];
  const effPricing = pricing ?? profile?.pricing ?? null;
  const effRequestTimeoutMs = requestTimeoutMs ?? profile?.timeoutMs ?? null;
  const isPaid = Boolean(effPricing && (effPricing.inputPerM > 0 || effPricing.cachedInputPerM > 0 || effPricing.outputPerM > 0));

  const tools = [];
  let messages = [];
  let pending = [];
  let pendingRequestId = null;
  let baseSystem = '';
  let baseInstruction = '';
  let promptComponentManifest = null;
  const toolResultContextSources = new Map();
  let stateLedger = null;
  let stateRevision = 0;
  let fallbackDetected = false;
  let maxObservedPromptTokens = 0;
  let requestSeq = 0;
  let verified = null;
  let verifiedAttempted = false;
  let verifiedTerminal = null;

  function toOpenAiTools(schemas) {
    return redactExactSecret(
      schemas.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      apiKey
    );
  }

  function buildBody({ finishOnly = false } = {}) {
    const selectedTools = finishOnly ? tools.filter((tool) => tool.function.name === 'finish') : tools;
    const requestMessages = messages.map(({ _evalState: internalStateMarker, ...message }) => message);
    const body = { model: requestedModel, messages: requestMessages, tools: selectedTools, tool_choice: 'auto', max_tokens: maxOutputTokens };
    if (effTemperature != null) body.temperature = effTemperature;
    if (effReasoning != null) body.reasoning = effReasoning;
    if (effProvider != null) body.provider = { order: effProvider.order, allow_fallbacks: effProvider.allowFallbacks };
    return body;
  }

  function reserveUncertainBilling(reason, data = {}) {
    const reservedUsd = budget?.remainingUsd() ?? 0;
    if (reservedUsd > 0) budget.reserve(reservedUsd, `uncertain billing reserve: ${reason}`);
    telemetry?.record('billing_uncertain', {
      reason,
      reservedUsd,
      policy: 'reserve-trial-remainder-and-stop',
      ...redactExactSecret(data, apiKey),
    });
    return reservedUsd;
  }

  function captureUsage(data) {
    const usage = data?.usage;
    const zeroPricing = { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0 };
    const cost = costOfUsage(usage, effPricing ?? zeroPricing);
    if (!cost) return { usageRecord: null, meteringError: isPaid, billingUncertain: isPaid };
    maxObservedPromptTokens = Math.max(maxObservedPromptTokens, cost.promptTokens);
    const localCostUsd = effPricing ? cost.usd : 0;
    const providerCostUsd = isPaid &&
      typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
    const billingUncertain = isPaid && providerCostUsd == null;
    const reconciledCostUsd = isPaid ? Math.max(localCostUsd, providerCostUsd ?? 0) : 0;
    const reportedReasoning = usage?.completion_tokens_details?.reasoning_tokens;
    const reasoningTokensComplete = Number.isSafeInteger(reportedReasoning) &&
      reportedReasoning >= 0 && reportedReasoning <= cost.outputTokens;
    budget?.charge(reconciledCostUsd, `response ${data?.id ?? ''}`.trim());
    return {
      meteringError: false,
      billingUncertain,
      usageRecord: {
        promptTokens: cost.promptTokens,
        cachedTokens: cost.cachedTokens,
        cachedTokensComplete: cost.cachedTokensComplete,
        reasoningTokens: reasoningTokensComplete ? reportedReasoning : null,
        reasoningTokensComplete,
        outputTokens: cost.outputTokens,
        localCostUsd,
        providerCostUsd,
        reconciledCostUsd,
      },
    };
  }

  function detectFallback(data) {
    const resolvedModel = data?.model ?? null;
    const resolvedProvider = data?.provider ?? null;
    let reason = null;
    if (resolvedModel && !expectedResolvedModels.includes(resolvedModel)) {
      reason = `resolved model ${resolvedModel} is outside the pinned model identities`;
    } else if (
      effProvider?.order?.length &&
      resolvedProvider &&
      !(effProvider.expectedResolvedNames ?? effProvider.order)
        .map(normalizeProviderName)
        .includes(normalizeProviderName(resolvedProvider))
    ) {
      reason = `resolved provider ${resolvedProvider} is outside the pinned order`;
    }
    if (reason) {
      fallbackDetected = true;
      telemetry?.record('fallback', { requestedModel, resolvedModel, resolvedProvider, reason });
    }
  }

  function precheckBudget(payload) {
    if (!budget) return null;
    // A tokenizer token consumes at least one UTF-8 byte. The serialized
    // request size is therefore a conservative tokenizer-independent input
    // bound. Retain a larger observed value for endpoints with hidden framing.
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const promptTokenUpperBound = Math.max(payloadBytes, maxObservedPromptTokens);
    const estimateUsd = effPricing
      ? estimateRequestCostUsd({ promptTokens: promptTokenUpperBound, maxOutputTokens }, effPricing)
      : 0;
    const verdict = budget.precheck(estimateUsd);
    if (!verdict.allowed) {
      telemetry?.record('budget_refusal', {
        reason: verdict.reason,
        estimateUsd,
        payloadChars: payload.length,
        payloadBytes,
        promptTokenUpperBound,
        maxOutputTokens,
        estimateSemantics: 'utf8-bytes-upper-bound-plus-max-output',
      });
      return verdict.reason;
    }
    return null;
  }

  function requestFootprint(body, payload, requestId, postVerify) {
    const requestMessages = Array.isArray(body.messages) ? body.messages : [];
    const systemMessages = requestMessages.filter((message) => message?.role === 'system');
    const instructionMessages = requestMessages.filter((message) => message?.role === 'user');
    const systemContent = requestMessages[0]?.role === 'system' && typeof requestMessages[0]?.content === 'string'
      ? requestMessages[0].content
      : null;
    const instructionContent = requestMessages[1]?.role === 'user' && typeof requestMessages[1]?.content === 'string'
      ? requestMessages[1].content
      : null;
    const durableStateMessages = requestMessages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) =>
        index > 1 && message?.role === 'system' &&
        typeof message.content === 'string' && message.content.startsWith('# Durable eval state\n')
      );
    const unexpectedSystemMessageCount = requestMessages.filter((message, index) =>
      message?.role === 'system' && index !== 0 &&
      !durableStateMessages.some((candidate) => candidate.index === index)
    ).length;
    const serializedMessages = JSON.stringify(requestMessages);
    const serializedTools = JSON.stringify(body.tools);
    const serializedMessageChars = requestMessages.map((message) => JSON.stringify(message).length);
    const buckets = {
      baseSystem: 0,
      instruction: 0,
      durableState: 0,
      assistantHistory: 0,
      toolResultHistory: 0,
      otherMessages: 0,
      messageEnvelope: Math.max(0, serializedMessages.length - serializedMessageChars.reduce((sum, value) => sum + value, 0)),
      toolSchema: serializedTools.length,
      payloadEnvelope: Math.max(0, payload.length - serializedMessages.length - serializedTools.length),
      toolResultHistoryBySource: {},
      complete: true,
    };
    for (let index = 0; index < requestMessages.length; index += 1) {
      const message = requestMessages[index];
      const chars = serializedMessageChars[index];
      if (index === 0 && message?.role === 'system') buckets.baseSystem += chars;
      else if (index === 1 && message?.role === 'user') buckets.instruction += chars;
      else if (durableStateMessages.some((candidate) => candidate.index === index)) buckets.durableState += chars;
      else if (message?.role === 'assistant') buckets.assistantHistory += chars;
      else if (message?.role === 'tool') {
        buckets.toolResultHistory += chars;
        const source = toolResultContextSources.get(message.tool_call_id) ?? 'unknown';
        buckets.toolResultHistoryBySource[source] = (buckets.toolResultHistoryBySource[source] ?? 0) + chars;
      } else buckets.otherMessages += chars;
    }
    const explainedChars = [
      buckets.baseSystem,
      buckets.instruction,
      buckets.durableState,
      buckets.assistantHistory,
      buckets.toolResultHistory,
      buckets.otherMessages,
      buckets.messageEnvelope,
      buckets.toolSchema,
      buckets.payloadEnvelope,
    ].reduce((sum, value) => sum + value, 0);
    buckets.complete = explainedChars === payload.length;
    const requestControls = requestControlProjection(endpoint, body);
    return {
      requestId,
      ...requestControls,
      requestBodyHash: sha256(payload),
      requestControlHash: sha256(JSON.stringify(requestControls)),
      messageCount: requestMessages.length,
      payloadChars: payload.length,
      payloadBytes: Buffer.byteLength(payload, 'utf8'),
      systemChars: JSON.stringify(systemMessages).length,
      baseSystemChars: systemContent == null ? 0 : JSON.stringify(requestMessages[0]).length,
      instructionChars: instructionContent == null ? 0 : JSON.stringify(requestMessages[1]).length,
      durableStateChars: durableStateMessages.reduce((sum, entry) => sum + JSON.stringify(entry.message).length, 0),
      systemMessageCount: systemMessages.length,
      instructionMessageCount: instructionMessages.length,
      systemPromptPosition: systemContent == null ? null : 0,
      instructionPosition: instructionContent == null ? null : 1,
      systemPromptHash: systemContent == null ? null : sha256(systemContent),
      instructionHash: instructionContent == null ? null : sha256(instructionContent),
      durableStateMessageCount: durableStateMessages.length,
      durableStateMessageIndex: durableStateMessages.length === 1 ? durableStateMessages[0].index : null,
      durableStateMessageHash: durableStateMessages.length === 1
        ? sha256(durableStateMessages[0].message.content)
        : null,
      unexpectedSystemMessageCount,
      toolSchemaChars: JSON.stringify(body.tools).length,
      toolSchemaHash: sha256(JSON.stringify(body.tools)),
      toolCount: body.tools.length,
      toolMode: postVerify ? 'finish-only' : 'full',
      promptComponentManifest: promptComponentManifest ? structuredClone(promptComponentManifest) : null,
      promptBuckets: buckets,
      charsByRole: roleChars(requestMessages),
      messagesHash: sha256(JSON.stringify(requestMessages)),
      stateRevision,
      postVerify,
    };
  }

  async function callApi(payload, body, { postVerify = false } = {}) {
    const requestId = `request-${++requestSeq}`;
    telemetry?.startRequest(requestFootprint(body, payload, requestId, postVerify));
    const allowedRetries = postVerify ? 0 : transientRetries;
    const deadlineMs = effRequestTimeoutMs ? monotonicNow() + effRequestTimeoutMs : null;

    function recordDeadlineExhausted(data = {}) {
      telemetry?.record('request_deadline_exhausted', {
        requestId,
        timeoutMs: effRequestTimeoutMs,
        ...data,
      });
    }

    function deadlineError(data = {}) {
      recordDeadlineExhausted(data);
      return new ProviderError(`provider request exceeded its ${effRequestTimeoutMs}ms deadline`, {
        kind: 'timeout',
        billed: false,
      });
    }

    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0 && precheckBudget(payload)) {
        throw new ProviderError('provider retry refused by budget', { kind: 'budget', billed: false });
      }
      const remainingMs = deadlineMs == null ? null : deadlineMs - monotonicNow();
      if (remainingMs != null && remainingMs <= 0) {
        throw deadlineError({ phase: 'before_attempt', attempt: attempt + 1, remainingMs });
      }
      const attemptId = `${requestId}-attempt-${attempt + 1}`;
      telemetry?.startAttempt({ requestId, attemptId, attempt: attempt + 1, payloadChars: payload.length });
      const controller = remainingMs != null ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), remainingMs) : null;
      try {
        let res;
        try {
          res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: payload,
            signal: controller?.signal,
          });
        } catch (error) {
          const kind = controller?.signal.aborted ? 'timeout' : 'network';
          telemetry?.finishAttempt(attemptId, {
            type: 'error',
            billingStatus: 'unknown',
            kind,
            ...(kind === 'timeout' ? { timeoutMs: effRequestTimeoutMs } : {}),
          });
          reserveUncertainBilling(kind, { requestId, attemptId });
          const safeError = redactExactSecret(String(error?.message ?? error), apiKey);
          const message = kind === 'timeout' ? `provider request timed out after ${effRequestTimeoutMs}ms` : `provider request failed: ${safeError}`;
          throw new ProviderError(message, { kind, billed: null, billingUncertain: true });
        }

        if (res.status === 429) {
          if (timer) clearTimeout(timer);
          telemetry?.finishAttempt(attemptId, { type: 'error', billingStatus: 'confirmed_unbilled', kind: 'http', status: 429 });
          if (attempt < allowedRetries) {
            const rawRetryAfter = res.headers?.get?.('retry-after');
            const retryAfterSec = rawRetryAfter == null || String(rawRetryAfter).trim() === '' ? Number.NaN : Number(rawRetryAfter);
            const backoffMs = Math.min(2 ** (attempt + 1) * 1000, 30_000);
            const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec >= 0
              ? Math.min(retryAfterSec * 1000, 30_000)
              : backoffMs;
            const remainingBeforeBackoffMs = deadlineMs == null ? null : deadlineMs - monotonicNow();
            if (remainingBeforeBackoffMs != null && waitMs >= remainingBeforeBackoffMs) {
              throw deadlineError({
                phase: 'backoff',
                attempt: attempt + 1,
                attemptId,
                remainingMs: remainingBeforeBackoffMs,
                waitMs,
              });
            }
            telemetry?.recordRetry({ requestId, attemptId, status: 429, attempt: attempt + 1, waitMs });
            await sleepImpl(waitMs);
            continue;
          }
          throw new ProviderError('provider http 429', { kind: 'http', billed: false, status: 429 });
        }
        if (!res.ok) {
          telemetry?.finishAttempt(attemptId, { type: 'error', billingStatus: 'unknown', kind: 'http', status: res.status });
          reserveUncertainBilling(`http_${res.status}`, { requestId, attemptId, status: res.status });
          throw new ProviderError(`provider http ${res.status}`, { kind: 'http', billed: null, status: res.status, billingUncertain: true });
        }

        let data;
        try {
          data = redactExactSecret(await res.json(), apiKey);
        } catch (error) {
          if (controller?.signal.aborted) {
            telemetry?.finishAttempt(attemptId, {
              type: 'error',
              billingStatus: 'unknown',
              kind: 'timeout',
              reason: 'response_body_timeout',
              timeoutMs: effRequestTimeoutMs,
            });
            recordDeadlineExhausted({
              phase: 'response_body',
              attempt: attempt + 1,
              attemptId,
              remainingMs: deadlineMs == null ? null : deadlineMs - monotonicNow(),
            });
            reserveUncertainBilling('timeout', { requestId, attemptId, phase: 'response_body' });
            throw new ProviderError(`provider request timed out after ${effRequestTimeoutMs}ms while reading the response body`, {
              kind: 'timeout',
              billed: null,
              billingUncertain: true,
            });
          }
          telemetry?.finishAttempt(attemptId, { type: 'error', billingStatus: 'unknown', kind: 'provider', reason: 'unparseable_response' });
          reserveUncertainBilling('unparseable_response', { requestId, attemptId });
          throw new ProviderError(`provider returned unparseable JSON: ${redactExactSecret(String(error?.message ?? error), apiKey)}`, {
            kind: 'provider',
            billed: null,
            billingUncertain: true,
          });
        }

        const captured = captureUsage(data);
        const choice = data?.choices?.[0] ?? null;
        const completionFailure = data?.error != null || choice?.error != null || choice?.finish_reason === 'error';
        const billingStatus = captured.meteringError || captured.billingUncertain ? 'unknown' : 'reported';
        telemetry?.finishAttempt(attemptId, {
          type: completionFailure ? 'error' : 'response',
          billingStatus,
          usage: captured.usageRecord,
          providerCostRequired: isPaid,
          ...(completionFailure ? { kind: 'provider', reason: 'provider_completion_error' } : {}),
          generationId: data?.id ?? null,
          provider: data?.provider ?? null,
          model: data?.model ?? null,
          finishReason: choice?.finish_reason ?? null,
        });
        detectFallback(data);
        if (captured.meteringError || captured.billingUncertain) {
          const reason = captured.meteringError ? 'missing_or_malformed_usage' : 'missing_provider_cost';
          reserveUncertainBilling(reason, { requestId, attemptId, generationId: data?.id ?? null });
          const message = captured.meteringError
            ? 'provider usage missing or malformed — paid spend cannot be metered'
            : 'provider cost missing — paid billing cannot be reconciled';
          throw new ProviderError(message, {
            kind: captured.meteringError ? 'usage' : 'billing',
            billed: null,
            billingUncertain: true,
          });
        }
        if (completionFailure) {
          telemetry?.record('completion_error', {
            requestId,
            attemptId,
            kind: 'provider',
            billed: true,
            reason: 'provider_completion_error',
          });
          throw new ProviderError('provider returned a partial or errored completion', {
            kind: 'provider',
            billed: true,
          });
        }
        if (!data?.choices?.[0]?.message) {
          telemetry?.record('completion_error', { requestId, attemptId, kind: 'provider', billed: Boolean(data?.usage) });
          throw new ProviderError('provider response contained no completion', { kind: 'provider', billed: Boolean(data?.usage) });
        }
        return { data, requestId };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  function parsedArguments(call) {
    const raw = typeof call?.function?.arguments === 'string' ? call.function.arguments : '';
    try {
      const input = JSON.parse(raw || '{}');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('tool arguments must be an object');
      return { input, raw, valid: true, error: null };
    } catch {
      return { input: {}, raw, valid: false, error: 'provider tool arguments were not a valid JSON object' };
    }
  }

  function recordIssuedToolCall(call, requestId) {
    const parsed = parsedArguments(call);
    const category = !parsed.valid
      ? 'invalid'
      : call.function.name === 'finish'
        ? 'finish'
      : call.function.name === 'verify_harness'
        ? 'verify'
        : commandCategory(parsed.input.command);
    const operation = parsed.valid ? harnessOperation(parsed.input.command) : null;
    const contextSource = contextSourceFor({
      toolName: call.function.name,
      command: parsed.input.command,
      category,
    });
    telemetry?.record('tool_call', {
      requestId,
      toolCallId: call?.id ?? null,
      tool: call?.function?.name ?? null,
      category,
      program: commandProgram(parsed.input.command),
      harnessOperation: operation,
      contextSource,
      immutableHarnessCli: parsed.valid && invokesImmutableHarnessCli(parsed.input.command),
      argumentsValid: parsed.valid,
      argsChars: parsed.raw.length,
      argsHash: sha256(parsed.raw),
    });
  }

  function actionFor(call, requestId) {
    const parsed = parsedArguments(call);
    const input = parsed.input;
    if (call.function.name === 'finish') {
      return {
        type: 'tool',
        name: 'finish',
        input,
        _id: call.id,
        _requestId: requestId,
        _category: parsed.valid ? 'finish' : 'invalid',
        _harnessOperation: null,
        _contextSource: 'finalization',
        _startedAtMs: monotonicNow(),
        _argumentsValid: parsed.valid,
        ...(parsed.error ? { _argumentError: parsed.error } : {}),
      };
    }
    const category = !parsed.valid ? 'invalid' : call.function.name === 'verify_harness' ? 'verify' : commandCategory(input.command);
    const operation = parsed.valid ? harnessOperation(input.command) : null;
    return {
      type: 'tool',
      name: call.function.name,
      input,
      _id: call.id,
      _requestId: requestId,
      _category: category,
      _harnessOperation: operation,
      _contextSource: contextSourceFor({ toolName: call.function.name, command: input.command, category }),
      _startedAtMs: monotonicNow(),
      _argumentsValid: parsed.valid,
      ...(parsed.error ? { _argumentError: parsed.error } : {}),
    };
  }

  function suppressedResult(reason) {
    return {
      code: 126,
      stdout: '',
      stderr: `provider tool call suppressed: ${reason}`,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      containmentMode: 'bridge-local',
      containmentComplete: true,
    };
  }

  function suppressCalls(calls, requestId, reason) {
    for (const call of calls.filter((candidate) => candidate?.function?.name !== 'finish')) {
      const action = actionFor(call, requestId);
      telemetry?.record(reason === 'verification_passed' ? 'post_verify_tool_suppressed' : 'tool_call_suppressed', {
        requestId,
        toolCallId: call.id,
        tool: call.function?.name || null,
        reason,
      });
      driver.observe(action, suppressedResult(reason));
    }
  }

  function settleFinishCalls(calls, requestId) {
    for (const call of calls.filter((candidate) => candidate?.function?.name === 'finish')) {
      const action = actionFor(call, requestId);
      driver.observe(action, {
        code: action._argumentsValid === false ? 126 : 0,
        stdout: '',
        stderr: action._argumentError || '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        containmentMode: 'bridge-local',
        containmentComplete: true,
      });
    }
  }

  function suppressPending(reason) {
    const calls = pending;
    const requestId = pendingRequestId;
    pending = [];
    pendingRequestId = null;
    suppressCalls(calls, requestId, reason);
  }

  function compactContext(body) {
    let payload = JSON.stringify(body);
    if (!Number.isFinite(maxPayloadChars) || maxPayloadChars <= 0 || payload.length <= maxPayloadChars || pending.length) {
      return { body, payload };
    }
    const beforeChars = payload.length;
    const history = messages.slice(2).filter((message) => message._evalState !== true);
    const turns = completedTurns(history);
    let retained = turns.slice(-Math.max(0, retainCompletedTurns));
    const stateContent = boundedState(stateLedger, maxStateChars);
    const stateMessage = { role: 'system', content: `# Durable eval state\n${stateContent}`, _evalState: true };
    const rebuild = () => {
      messages = [
        { role: 'system', content: baseSystem },
        { role: 'user', content: baseInstruction },
        stateMessage,
        ...retained.flat(),
      ];
      const nextBody = buildBody({ finishOnly: verified != null });
      return { body: nextBody, payload: JSON.stringify(nextBody) };
    };
    ({ body, payload } = rebuild());
    while (payload.length > maxPayloadChars && retained.length) {
      retained = retained.slice(1);
      ({ body, payload } = rebuild());
    }
    if (payload.length > maxPayloadChars) {
      telemetry?.record('context_refused', { beforeChars, afterChars: payload.length, limit: maxPayloadChars, stateRevision });
      throw new ProviderError(`immutable eval context exceeds ${maxPayloadChars} characters`, { kind: 'context', billed: false });
    }
    telemetry?.record('context_compacted', {
      beforeChars,
      afterChars: payload.length,
      limit: maxPayloadChars,
      retainedTurns: retained.length,
      stateRevision,
    });
    return { body, payload };
  }

  function verifiedFinish(detail = {}) {
    verifiedTerminal = {
      type: 'finish',
      answer: verified?.fallbackAnswer || '',
      stopReason: 'verified_stop',
      ...detail,
    };
    telemetry?.record('verified_stop', { reason: detail.reason || 'verified_completion' });
    return verifiedTerminal;
  }

  const driver = {
    name: 'openai-compatible',
    model: requestedModel,
    get fallbackDetected() {
      return fallbackDetected;
    },
    get verificationPassed() {
      return verified != null;
    },
    reset({ system, instruction, tools: schemas, promptComponentManifest: manifest = null }) {
      tools.length = 0;
      tools.push(...toOpenAiTools(schemas));
      baseSystem = redactExactSecret(String(system ?? ''), apiKey);
      baseInstruction = redactExactSecret(String(instruction ?? ''), apiKey);
      promptComponentManifest = validatedPromptComponentManifest(manifest, baseSystem);
      toolResultContextSources.clear();
      messages = [
        { role: 'system', content: baseSystem },
        { role: 'user', content: baseInstruction },
      ];
      pending = [];
      pendingRequestId = null;
      fallbackDetected = false;
      maxObservedPromptTokens = 0;
      stateRevision = 0;
      stateLedger = {
        schema: 'eval-agent-state.v1',
        revision: 0,
        goal: baseInstruction,
        constraints: [],
        files: { inspected: [], changed: [] },
        tests: [],
        failures: [],
        lifecycle: { phase: 'orient', planPath: null, gate: 'unknown', verify: 'unknown' },
        loadedGuidance: [],
        nextAction: null,
      };
      verified = null;
      verifiedAttempted = false;
      verifiedTerminal = null;
    },
    checkpoint(snapshot, { pinnedContext = [] } = {}) {
      stateRevision += 1;
      const candidate = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
      const safeSnapshot = redactExactSecret(candidate, apiKey);
      const safeFiles = safeSnapshot.files && typeof safeSnapshot.files === 'object' && !Array.isArray(safeSnapshot.files)
        ? safeSnapshot.files
        : stateLedger.files;
      const files = {
        ...structuredClone(safeFiles),
        inspected: Array.isArray(safeFiles?.inspected) ? structuredClone(safeFiles.inspected) : structuredClone(stateLedger.files.inspected),
        changed: Array.isArray(safeFiles?.changed) ? structuredClone(safeFiles.changed) : structuredClone(stateLedger.files.changed),
      };
      const tests = Array.isArray(safeSnapshot.tests) ? structuredClone(safeSnapshot.tests) : structuredClone(stateLedger.tests);
      const failures = Array.isArray(safeSnapshot.failures) ? structuredClone(safeSnapshot.failures) : structuredClone(stateLedger.failures);
      const loadedGuidance = Array.isArray(safeSnapshot.loadedGuidance)
        ? safeSnapshot.loadedGuidance
        : stateLedger.loadedGuidance;
      stateLedger = {
        ...structuredClone(stateLedger),
        ...structuredClone(safeSnapshot),
        schema: 'eval-agent-state.v1',
        revision: stateRevision,
        files,
        tests,
        failures,
        loadedGuidance: [...new Set([...loadedGuidance, ...pinnedContext.map((item) => item.id)])],
      };
      telemetry?.record('checkpoint', { stateRevision, stateHash: sha256(JSON.stringify(stateLedger)) });
    },
    markVerified({ plan = null, evidencePath = null, fallbackAnswer = '' } = {}) {
      verified = redactExactSecret({ plan, evidencePath, fallbackAnswer }, apiKey);
      const safePlan = verified.plan;
      const safeEvidencePath = verified.evidencePath;
      stateRevision += 1;
      stateLedger = {
        ...stateLedger,
        revision: stateRevision,
        lifecycle: { ...(stateLedger.lifecycle || {}), phase: 'done', planPath: safePlan, verify: 'passed' },
      };
      suppressPending('verification_passed');
      telemetry?.record('verification_passed', { plan: safePlan, evidencePath: safeEvidencePath, stateRevision });
    },
    suppressPending,
    async next() {
      if (verifiedTerminal) return verifiedTerminal;
      if (verified && verifiedAttempted) return verifiedFinish({ reason: 'provider_attempt_already_used' });
      if (!verified && pending.length) return actionFor(pending.shift(), pendingRequestId);

      let body = buildBody({ finishOnly: verified != null });
      let payload = JSON.stringify(body);
      try {
        ({ body, payload } = compactContext(body));
      } catch (error) {
        if (verified) return verifiedFinish({ reason: 'context_refused' });
        throw error;
      }
      if (precheckBudget(payload)) {
        if (verified) return verifiedFinish({ reason: 'budget_refused' });
        telemetry?.record('finish', { stopReason: 'budget_exhausted' });
        return { type: 'finish', answer: '', stopReason: 'budget_exhausted' };
      }

      if (verified) verifiedAttempted = true;
      let result;
      try {
        result = await callApi(payload, body, { postVerify: verified != null });
      } catch (error) {
        if (verified) return verifiedFinish({ reason: `provider_${error.kind || 'error'}` });
        throw error;
      }
      const { data, requestId } = result;
      const msg = data.choices[0].message;
      messages.push(msg);
      const calls = msg.tool_calls || [];
      const actionableCalls = calls.filter((call) => call?.function?.name !== 'finish');
      for (const call of calls) recordIssuedToolCall(call, requestId);
      if (verified) {
        suppressCalls(actionableCalls, requestId, 'verification_passed');
        const finishCall = calls.find((call) => call.function?.name === 'finish');
        settleFinishCalls(calls, requestId);
        let answer = msg.content || verified.fallbackAnswer || '';
        if (finishCall) {
          try {
            answer = JSON.parse(finishCall.function.arguments || '{}').answer || answer;
          } catch {
            // fallback answer remains authoritative
          }
        }
        return verifiedFinish({ answer, reason: calls.some((call) => call.function?.name !== 'finish') ? 'tool_suppressed' : 'provider_final' });
      }
      if (!calls.length) {
        telemetry?.record('finish', { stopReason: 'model_finish', requestId });
        return { type: 'finish', answer: msg.content || '', stopReason: 'model_finish' };
      }
      const finishCall = calls.find((call) => call?.function?.name === 'finish');
      if (finishCall) {
        suppressCalls(actionableCalls, requestId, 'finish_selected');
        settleFinishCalls(calls, requestId);
        const parsed = parsedArguments(finishCall);
        telemetry?.record('finish', { stopReason: 'model_finish', requestId });
        return {
          type: 'finish',
          answer: parsed.valid ? parsed.input.answer || msg.content || '' : msg.content || '',
          stopReason: 'model_finish',
          _id: finishCall.id,
        };
      }
      pending = actionableCalls.slice();
      pendingRequestId = requestId;
      return actionFor(pending.shift(), requestId);
    },
    observe(action, result) {
      const safeResult = redactExactSecret(result, apiKey);
      const serialized = JSON.stringify(safeResult);
      const compacted = compactToolResult(safeResult, toolResultLimit);
      const category = action._category || commandCategory(action.input?.command);
      const operation = action._harnessOperation ?? harnessOperation(action.input?.command);
      const contextSource = action._contextSource ?? contextSourceFor({
        toolName: action.name,
        command: action.input?.command,
        category,
      });
      const terminalTool = ['bash', 'runInTerminal', 'verify_harness'].includes(action.name);
      const exitCode = Number.isFinite(safeResult?.code) ? safeResult.code : null;
      if (action._id) toolResultContextSources.set(action._id, contextSource);
      telemetry?.record('tool_result', {
        requestId: action._requestId ?? null,
        toolCallId: action._id || 'call_0',
        tool: action.name || 'finish',
        category,
        harnessOperation: operation,
        contextSource,
        exitCode,
        durationMs: Math.max(0, monotonicNow() - (action._startedAtMs ?? monotonicNow())),
        stdoutChars: String(safeResult?.stdout ?? '').length,
        stderrChars: String(safeResult?.stderr ?? '').length,
        resultChars: serialized.length,
        resultHash: sha256(serialized),
        compacted: compacted.compacted,
        stdoutTruncated: safeResult?.stdoutTruncated === true,
        stderrTruncated: safeResult?.stderrTruncated === true,
        timedOut: safeResult?.timedOut === true,
        containmentMode: terminalTool ? safeResult?.containmentMode ?? null : 'bridge-local',
        containmentComplete: terminalTool ? safeResult?.containmentComplete === true : true,
      });
      if (compacted.compacted) {
        telemetry?.record('tool_result_compacted', {
          toolCallId: action._id || 'call_0',
          tool: action.name || 'finish',
          originalChars: compacted.originalChars,
          limit: toolResultLimit,
        });
      }

      const code = Number.isFinite(safeResult?.code) ? safeResult.code : null;
      if (category === 'edit' && code === 0) {
        stateLedger.files.changed = [...new Set([...(stateLedger.files.changed || []), ...changedPaths(action.input?.command)])].slice(-50);
      }
      if (category === 'test') {
        stateLedger.tests = [
          ...(stateLedger.tests || []),
          { command: commandProgram(action.input?.command) || 'test', status: code === 0 ? 'passed' : code == null ? 'unknown' : 'failed', summary: `exit ${code}` },
        ].slice(-20);
      }
      if (code != null && code !== 0) {
        stateLedger.failures = [
          ...(stateLedger.failures || []),
          { command: commandProgram(action.input?.command) || action.name || 'tool', exitCode: code, summary: `stderr sha256:${sha256(safeResult?.stderr || '').slice(0, 12)}` },
        ].slice(-20);
      }

      messages.push({
        role: 'tool',
        tool_call_id: action._id || 'call_0',
        name: action.name || 'finish',
        content: compacted.content,
      });
    },
  };

  return driver;
}
