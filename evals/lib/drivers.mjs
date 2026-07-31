/**
 * Decision drivers for deterministic replays and live OpenAI-compatible
 * tool-use evals. The live driver owns measurement, bounded context, provider
 * billing evidence, and the post-verification stop contract.
 */
import crypto from 'node:crypto';
import { costOfUsage, estimateRequestCostUsd } from './budget.mjs';

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

function commandCategory(command) {
  const text = String(command || '').trim();
  const harnessCommand = '(?:harness|/opt/harness-bundle/harness-cli)';
  const invokesHarness = (subcommand) =>
    new RegExp(`(?:^|[\\s;&|()])${harnessCommand}\\s+${subcommand}(?=\\s|$)`).test(text);
  if (invokesHarness('orient')) return 'orient';
  if (invokesHarness('(?:plan-new|validate-plan)') || /docs\/plans\//.test(text)) return 'plan';
  if (invokesHarness('gate')) return 'gate';
  if (invokesHarness('verify')) return 'verify';
  if (/\b(?:npm|pnpm|yarn|pytest|python\s+-m\s+pytest|go\s+test|cargo\s+test|mvn|gradle)\b[^\n]*(?:test|verify)|\btest\b/.test(text)) return 'test';
  if (/(?:^|\s)(?:>|>>)|\bsed\s+-i\b|\b(?:rm|mv|cp|install|touch|mkdir)\b|\b(?:python|node|perl|ruby)\b[^\n]*(?:write|open\()/.test(text)) return 'edit';
  if (/\b(?:cat|sed|rg|grep|find|ls|pwd|head|tail|wc|git\s+(?:status|diff|log|show))\b/.test(text)) return 'inspect';
  return 'other';
}

function commandProgram(command) {
  return String(command || '').trim().split(/\s+/)[0]?.replace(/^.*\//, '') || null;
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
  const minimal = JSON.stringify({
    schema: state.schema || 'eval-agent-state.v1',
    revision: state.revision || 0,
    stateHash: sha256(json),
    truncated: true,
  });
  if (minimal.length <= maxChars) return minimal;
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
  const effPricing = pricing ?? profile?.pricing ?? null;
  const effRequestTimeoutMs = requestTimeoutMs ?? profile?.timeoutMs ?? null;
  const isPaid = Boolean(effPricing && (effPricing.inputPerM > 0 || effPricing.cachedInputPerM > 0 || effPricing.outputPerM > 0));

  const tools = [];
  let messages = [];
  let pending = [];
  let pendingRequestId = null;
  let baseSystem = '';
  let baseInstruction = '';
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
    const body = { model: requestedModel, messages, tools: selectedTools, tool_choice: 'auto', max_tokens: maxOutputTokens };
    if (effTemperature != null) body.temperature = effTemperature;
    if (effReasoning != null) body.reasoning = effReasoning;
    if (effProvider != null) body.provider = { order: effProvider.order, allow_fallbacks: effProvider.allowFallbacks };
    return body;
  }

  function reserveUncertainBilling(reason, data = {}) {
    const reservedUsd = budget?.remainingUsd() ?? 0;
    if (reservedUsd > 0) budget.charge(reservedUsd, `uncertain billing reserve: ${reason}`);
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
    const providerCostUsd =
      typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
    const billingUncertain = isPaid && providerCostUsd == null;
    const reconciledCostUsd = Math.max(localCostUsd, providerCostUsd ?? 0);
    budget?.charge(reconciledCostUsd, `response ${data?.id ?? ''}`.trim());
    return {
      meteringError: false,
      billingUncertain,
      usageRecord: {
        promptTokens: cost.promptTokens,
        cachedTokens: cost.cachedTokens,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens || 0,
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
    if (resolvedModel && resolvedModel !== requestedModel) {
      reason = `resolved model ${resolvedModel} differs from requested ${requestedModel}`;
    } else if (
      effProvider?.order?.length &&
      resolvedProvider &&
      !effProvider.order.map(normalizeProviderName).includes(normalizeProviderName(resolvedProvider))
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
    return {
      requestId,
      model: requestedModel,
      messageCount: messages.length,
      payloadChars: payload.length,
      payloadBytes: Buffer.byteLength(payload, 'utf8'),
      systemChars: JSON.stringify(messages.filter((message) => message.role === 'system')).length,
      toolSchemaChars: JSON.stringify(body.tools).length,
      charsByRole: roleChars(messages),
      messagesHash: sha256(JSON.stringify(messages)),
      stateRevision,
      postVerify,
    };
  }

  async function callApi(payload, body, { postVerify = false } = {}) {
    const requestId = `request-${++requestSeq}`;
    telemetry?.startRequest(requestFootprint(body, payload, requestId, postVerify));
    const allowedRetries = postVerify ? 0 : transientRetries;

    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0 && precheckBudget(payload)) {
        throw new ProviderError('provider retry refused by budget', { kind: 'budget', billed: false });
      }
      const attemptId = `${requestId}-attempt-${attempt + 1}`;
      telemetry?.startAttempt({ requestId, attemptId, attempt: attempt + 1, payloadChars: payload.length });
      const controller = effRequestTimeoutMs ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), effRequestTimeoutMs) : null;
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
          telemetry?.finishAttempt(attemptId, { type: 'error', billingStatus: 'confirmed_unbilled', kind: 'http', status: 429 });
          if (attempt < allowedRetries) {
            const rawRetryAfter = res.headers?.get?.('retry-after');
            const retryAfterSec = rawRetryAfter == null || String(rawRetryAfter).trim() === '' ? Number.NaN : Number(rawRetryAfter);
            const backoffMs = Math.min(2 ** (attempt + 1) * 1000, 30_000);
            const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec >= 0
              ? Math.min(retryAfterSec * 1000, 30_000)
              : backoffMs;
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
          telemetry?.finishAttempt(attemptId, { type: 'error', billingStatus: 'unknown', kind: 'provider', reason: 'unparseable_response' });
          reserveUncertainBilling('unparseable_response', { requestId, attemptId });
          throw new ProviderError(`provider returned unparseable JSON: ${redactExactSecret(String(error?.message ?? error), apiKey)}`, {
            kind: 'provider',
            billed: null,
            billingUncertain: true,
          });
        }

        const captured = captureUsage(data);
        const billingStatus = captured.meteringError || captured.billingUncertain ? 'unknown' : 'reported';
        telemetry?.finishAttempt(attemptId, {
          type: 'response',
          billingStatus,
          usage: captured.usageRecord,
          providerCostRequired: isPaid,
          generationId: data?.id ?? null,
          provider: data?.provider ?? null,
          model: data?.model ?? null,
          finishReason: data?.choices?.[0]?.finish_reason ?? null,
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

  function actionFor(call, requestId) {
    let input = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = {};
    }
    if (call.function.name === 'finish') {
      telemetry?.record('finish', { stopReason: 'model_finish', requestId });
      return { type: 'finish', answer: input.answer || '', stopReason: 'model_finish', _id: call.id };
    }
    const rawArgs = call.function.arguments || '{}';
    const category = commandCategory(input.command);
    telemetry?.record('tool_call', {
      requestId,
      toolCallId: call.id,
      tool: call.function.name,
      category,
      program: commandProgram(input.command),
      argsChars: rawArgs.length,
      argsHash: sha256(rawArgs),
    });
    return {
      type: 'tool',
      name: call.function.name,
      input,
      _id: call.id,
      _requestId: requestId,
      _category: category,
      _startedAtMs: monotonicNow(),
    };
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
    reset({ system, instruction, tools: schemas }) {
      tools.length = 0;
      tools.push(...toOpenAiTools(schemas));
      baseSystem = redactExactSecret(String(system ?? ''), apiKey);
      baseInstruction = redactExactSecret(String(instruction ?? ''), apiKey);
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
      const safeSnapshot = redactExactSecret(snapshot || {}, apiKey);
      stateLedger = {
        ...structuredClone(stateLedger),
        ...structuredClone(safeSnapshot),
        schema: 'eval-agent-state.v1',
        revision: stateRevision,
        loadedGuidance: [...new Set([...(safeSnapshot?.loadedGuidance || stateLedger.loadedGuidance || []), ...pinnedContext.map((item) => item.id)])],
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
      for (const call of pending) {
        telemetry?.record('post_verify_tool_suppressed', { toolCallId: call.id, tool: call.function?.name || null });
      }
      pending = [];
      pendingRequestId = null;
      telemetry?.record('verification_passed', { plan: safePlan, evidencePath: safeEvidencePath, stateRevision });
    },
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
      if (verified) {
        for (const call of calls) {
          telemetry?.record('post_verify_tool_suppressed', { requestId, toolCallId: call.id, tool: call.function?.name || null });
        }
        const finishCall = calls.find((call) => call.function?.name === 'finish');
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
      pending = calls.slice();
      pendingRequestId = requestId;
      return actionFor(pending.shift(), requestId);
    },
    observe(action, result) {
      const safeResult = redactExactSecret(result, apiKey);
      const serialized = JSON.stringify(safeResult);
      const compacted = compactToolResult(safeResult, toolResultLimit);
      const category = action._category || commandCategory(action.input?.command);
      telemetry?.record('tool_result', {
        requestId: action._requestId ?? null,
        toolCallId: action._id || 'call_0',
        tool: action.name || 'finish',
        category,
        exitCode: Number.isFinite(result?.code) ? result.code : null,
        durationMs: Math.max(0, monotonicNow() - (action._startedAtMs ?? monotonicNow())),
        stdoutChars: String(safeResult?.stdout ?? '').length,
        stderrChars: String(safeResult?.stderr ?? '').length,
        resultChars: serialized.length,
        resultHash: sha256(serialized),
        compacted: compacted.compacted,
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
