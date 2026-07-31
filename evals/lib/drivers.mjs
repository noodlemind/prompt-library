/**
 * Drivers decide the next tool call for the agent loop. All three feed the SAME
 * executor + real hooks, so fidelity to the host is identical; only the decider
 * differs:
 *
 *   1. replayDriver   — No-Model: a fixed/recorded action list (deterministic).
 *   2. replayDriver   — In-session: the same replay, sourced from a transcript
 *      Claude Code (this session) produced by reasoning over live tool results.
 *   3. openAiToolDriver — a live model via an OpenAI-compatible tool-use API
 *      (Ollama at /v1, OpenRouter, or any compatible endpoint).
 *
 * The distinction between (1) and (2) is provenance, recorded in `model`.
 *
 * For paid release evals the live driver additionally carries the plan's
 * measurement and cost controls: a model profile (endpoint, pinning, pricing,
 * reasoning/temperature config), per-request budget prechecks, usage/cost
 * capture, fallback detection, reasoning-metadata round-tripping, structured
 * telemetry events, and explicit stop reasons. All of it is optional — legacy
 * construction ({ url, apiKey, model }) behaves as before.
 */
import { costOfUsage, estimateRequestCostUsd, estimateTokensForChars } from './budget.mjs';

/**
 * A classified provider failure. `kind` is 'network' (transport, nothing
 * reached the provider), 'http' (non-2xx status), or 'provider' (a 2xx
 * response that is not a usable completion). `billed` is true only when the
 * provider reported usage for the failed call — the retry policy allows one
 * retry for unbilled failures only.
 */
export class ProviderError extends Error {
  constructor(message, { kind, billed = false, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.billed = billed;
    this.status = status;
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

/** Provider names differ in case and spacing across catalogs ("Moonshot AI" vs "moonshotai"). */
function normalizeProviderName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
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
  toolResultLimit = 4000,
  requestTimeoutMs,
  transientRetries = 4,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const endpoint = url ?? profile?.url;
  const requestedModel = model ?? profile?.model;
  if (!endpoint || !apiKey || !requestedModel) return null; // caller skips cleanly

  const maxOutputTokens = maxTokens ?? profile?.maxTokens ?? 2048;
  // undefined → fall back to the profile; null (in either) → omit, model default.
  const effTemperature = temperature !== undefined ? temperature : profile?.temperature ?? null;
  const effReasoning = reasoning !== undefined ? reasoning : profile?.reasoning ?? null;
  const effProvider = provider !== undefined ? provider : profile?.provider ?? null;
  const effPricing = pricing ?? profile?.pricing ?? null;
  const effRequestTimeoutMs = requestTimeoutMs ?? profile?.timeoutMs ?? null;

  // A profile priced at all zeros (local Ollama) is not paid spend — unusable
  // usage there is a telemetry gap, not a metering emergency.
  const isPaid = Boolean(effPricing && (effPricing.inputPerM > 0 || effPricing.cachedInputPerM > 0 || effPricing.outputPerM > 0));

  const tools = [];
  let messages = [];
  let pending = []; // tool_calls from the current assistant turn, not yet answered
  let fallbackDetected = false;
  let lastUsage = null; // observed prompt/output tokens from the previous response

  function toOpenAiTools(schemas) {
    return schemas.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }

  function buildBody() {
    const body = { model: requestedModel, messages, tools, tool_choice: 'auto', max_tokens: maxOutputTokens };
    if (effTemperature != null) body.temperature = effTemperature;
    if (effReasoning != null) body.reasoning = effReasoning;
    if (effProvider != null) body.provider = { order: effProvider.order, allow_fallbacks: effProvider.allowFallbacks };
    return body;
  }

  /**
   * Record usage/cost from a response and charge the budget. Malformed usage
   * is never estimated — and on a paid, budgeted driver it is terminal: spend
   * that cannot be metered must stop immediately, not continue unbudgeted.
   */
  function captureUsage(data) {
    const usage = data?.usage;
    const zeroPricing = { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0 };
    const cost = costOfUsage(usage, effPricing ?? zeroPricing);
    if (!cost) {
      telemetry?.addUsage(null);
      if (isPaid && budget) {
        telemetry?.record('error', { kind: 'usage', message: 'provider usage missing or malformed on a paid profile' });
        throw new ProviderError('provider usage missing or malformed — paid spend cannot be metered', { kind: 'usage', billed: null });
      }
      return null;
    }
    lastUsage = { promptTokens: cost.promptTokens, outputTokens: cost.outputTokens };
    const localCostUsd = effPricing ? cost.usd : 0;
    budget?.charge(localCostUsd, `response ${data?.id ?? ''}`.trim());
    telemetry?.addUsage({
      promptTokens: cost.promptTokens,
      cachedTokens: cost.cachedTokens,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens || 0,
      outputTokens: cost.outputTokens,
      localCostUsd,
      providerCostUsd: typeof usage?.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : undefined,
    });
    return localCostUsd;
  }

  /** A resolved model or provider outside what was requested invalidates the A/B. */
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

  /**
   * Worst-case cost gate for the next request; returns a refusal reason or
   * null. The prompt estimate is the larger of the character heuristic and
   * the previous response's observed prompt + output tokens — the
   * conversation only grows, so observed usage is a floor, not a guess.
   */
  function precheckBudget(payload) {
    if (!budget) return null;
    const observedFloor = lastUsage ? lastUsage.promptTokens + lastUsage.outputTokens : 0;
    const promptTokens = Math.max(estimateTokensForChars(payload.length), observedFloor);
    const estimateUsd = effPricing ? estimateRequestCostUsd({ promptTokens, maxOutputTokens }, effPricing) : 0;
    const verdict = budget.precheck(estimateUsd);
    if (!verdict.allowed) {
      telemetry?.record('budget_refusal', { reason: verdict.reason, estimateUsd });
      return verdict.reason;
    }
    return null;
  }

  async function callApi(payload) {
    telemetry?.record('request', { model: requestedModel, messageCount: messages.length });

    // The abort timer covers the whole request — connection AND body read —
    // so a hung provider becomes a classified failure instead of a stuck
    // trial. Billing for an aborted request is unknowable: billed stays null.
    let data;
    // Rate limits (429) are confirmed-unbilled transient failures — the plan's
    // retry policy allows retrying them, with backoff, inside one request.
    // Everything else (402, 5xx, network) stays terminal and classified.
    for (let attempt = 0; ; attempt += 1) {
      const controller = effRequestTimeoutMs ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), effRequestTimeoutMs) : null;
      const timedOutError = () => {
        telemetry?.record('error', { kind: 'timeout', timeoutMs: effRequestTimeoutMs });
        return new ProviderError(`provider request timed out after ${effRequestTimeoutMs}ms`, { kind: 'timeout', billed: null });
      };
      try {
        let res;
        try {
          res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: payload,
            signal: controller?.signal,
          });
        } catch (err) {
          if (controller?.signal.aborted) throw timedOutError();
          telemetry?.record('error', { kind: 'network', message: err.message });
          throw new ProviderError(`provider request failed: ${err.message}`, { kind: 'network', billed: false });
        }
        if (res.status === 429 && attempt < transientRetries) {
          const retryAfterSec = Number(res.headers?.get?.('retry-after'));
          const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? retryAfterSec * 1000 : Math.min(2 ** (attempt + 1) * 1000, 30_000);
          telemetry?.record('retry', { status: 429, attempt: attempt + 1, waitMs });
          if (timer) clearTimeout(timer);
          await sleepImpl(waitMs);
          continue;
        }
        if (!res.ok) {
          telemetry?.record('error', { kind: 'http', status: res.status });
          throw new ProviderError(`provider http ${res.status}`, { kind: 'http', billed: false, status: res.status });
        }
        try {
          data = await res.json();
        } catch (err) {
          if (controller?.signal.aborted) throw timedOutError();
          telemetry?.record('error', { kind: 'provider', message: `unparseable response: ${err.message}` });
          throw new ProviderError(`provider returned unparseable JSON: ${err.message}`, { kind: 'provider', billed: false });
        }
        break;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Usage and identifiers are captured even for malformed completions — a
    // response that reports usage was billed whether or not it is usable.
    const costUsd = captureUsage(data);
    detectFallback(data);
    telemetry?.record('response', {
      generationId: data?.id ?? null,
      provider: data?.provider ?? null,
      model: data?.model ?? null,
      finishReason: data?.choices?.[0]?.finish_reason ?? null,
      costUsd,
    });
    if (!data?.choices?.[0]?.message) {
      const billed = Boolean(data?.usage);
      telemetry?.record('error', { kind: 'provider', billed, message: 'no completion in response' });
      throw new ProviderError('provider response contained no completion', { kind: 'provider', billed });
    }
    return data;
  }

  function actionFor(call) {
    let input = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = {};
    }
    if (call.function.name === 'finish') {
      telemetry?.record('finish', { stopReason: 'model_finish' });
      return { type: 'finish', answer: input.answer || '', stopReason: 'model_finish', _id: call.id };
    }
    telemetry?.record('tool_call', { tool: call.function.name });
    return { type: 'tool', name: call.function.name, input, _id: call.id };
  }

  return {
    name: 'openai-compatible',
    model: requestedModel,
    get fallbackDetected() {
      return fallbackDetected;
    },
    reset({ system, instruction, tools: schemas }) {
      tools.length = 0;
      tools.push(...toOpenAiTools(schemas));
      messages = [
        { role: 'system', content: system },
        { role: 'user', content: instruction },
      ];
      pending = [];
      fallbackDetected = false; // a reused driver must not taint a fresh trial
      lastUsage = null;
    },
    async next() {
      // Drain any tool_calls the assistant already emitted this turn before
      // asking for another turn — OpenAI requires a tool result per tool_call.
      if (pending.length) return actionFor(pending.shift());
      const payload = JSON.stringify(buildBody());
      if (precheckBudget(payload)) {
        telemetry?.record('finish', { stopReason: 'budget_exhausted' });
        return { type: 'finish', answer: '', stopReason: 'budget_exhausted' };
      }
      const data = await callApi(payload);
      const msg = data.choices[0].message;
      // Pushed verbatim: reasoning metadata (reasoning / reasoning_details)
      // must round-trip into the next request or the model loses its thread.
      messages.push(msg);
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        telemetry?.record('finish', { stopReason: 'model_finish' });
        return { type: 'finish', answer: msg.content || '', stopReason: 'model_finish' };
      }
      pending = calls.slice();
      return actionFor(pending.shift());
    },
    observe(action, result) {
      // Every tool_call needs a matching tool message keyed by its id, or the
      // next turn is malformed and the model loses the thread.
      const serialized = JSON.stringify(result);
      const truncated = serialized.length > toolResultLimit;
      if (truncated) {
        telemetry?.record('tool_result_truncated', {
          tool: action.name || 'finish',
          originalChars: serialized.length,
          limit: toolResultLimit,
        });
      }
      messages.push({
        role: 'tool',
        tool_call_id: action._id || 'call_0',
        name: action.name || 'finish',
        content: truncated ? serialized.slice(0, toolResultLimit) : serialized,
      });
    },
  };
}
