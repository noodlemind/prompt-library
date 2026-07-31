/**
 * Append-only, secret-safe telemetry for one eval trial.
 *
 * The provider ledger deliberately separates a logical model request from its
 * physical HTTP attempts. Every started attempt must close as one response or
 * classified error; an open attempt or unknown billing state makes cost
 * evidence incomplete. Raw prompts, commands, and outputs do not belong here.
 */
export function createTelemetry({
  now = () => new Date(),
  monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
  idFactory = (seq) => `event-${seq}`,
} = {}) {
  let seq = 0;
  const events = [];
  const openAttempts = new Map();
  const totals = {
    // Backward-compatible: completed responses whose usage was inspected.
    requests: 0,
    modelRequests: 0,
    providerAttempts: 0,
    providerResponses: 0,
    providerErrors: 0,
    retries: 0,
    openAttempts: 0,
    unknownBillingAttempts: 0,
    missingUsage: 0,
    promptTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    localCostUsd: 0,
    providerCostUsd: null,
    usageComplete: true,
    providerCostComplete: true,
    billingComplete: true,
    costComplete: true,
  };

  function timestamp() {
    const value = now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  function refreshCostComplete() {
    totals.costComplete = totals.usageComplete && totals.providerCostComplete && totals.billingComplete && openAttempts.size === 0;
  }

  function record(type, data = {}) {
    const current = seq++;
    const event = {
      seq: current,
      eventId: idFactory(current),
      type,
      timestamp: timestamp(),
      monotonicMs: monotonicNow(),
      ...data,
    };
    events.push(event);
    return event;
  }

  function addUsage(usage, { providerCostRequired = false } = {}) {
    totals.requests += 1;
    if (!usage) {
      totals.missingUsage += 1;
      totals.usageComplete = false;
      if (providerCostRequired) totals.providerCostComplete = false;
      refreshCostComplete();
      return;
    }
    totals.promptTokens += usage.promptTokens || 0;
    totals.cachedTokens += usage.cachedTokens || 0;
    totals.reasoningTokens += usage.reasoningTokens || 0;
    totals.outputTokens += usage.outputTokens || 0;
    totals.localCostUsd += usage.localCostUsd || 0;
    if (typeof usage.providerCostUsd === 'number' && Number.isFinite(usage.providerCostUsd)) {
      totals.providerCostUsd = (totals.providerCostUsd ?? 0) + usage.providerCostUsd;
    } else if (providerCostRequired) {
      totals.providerCostComplete = false;
    }
    refreshCostComplete();
  }

  function startRequest(data = {}) {
    totals.modelRequests += 1;
    return record('request', data);
  }

  function startAttempt({ requestId, attemptId, ...data } = {}) {
    if (!requestId || !attemptId) throw new Error('requestId and attemptId are required for a provider attempt');
    if (openAttempts.has(attemptId)) throw new Error(`provider attempt already open: ${attemptId}`);
    const startedMonotonicMs = monotonicNow();
    openAttempts.set(attemptId, { requestId, startedMonotonicMs });
    totals.providerAttempts += 1;
    totals.openAttempts = openAttempts.size;
    refreshCostComplete();
    return record('request_attempt', { requestId, attemptId, ...data });
  }

  function finishAttempt(
    attemptId,
    { type, billingStatus = 'unknown', usage = undefined, providerCostRequired = false, ...data } = {}
  ) {
    const open = openAttempts.get(attemptId);
    if (!open) throw new Error(`provider attempt is not open: ${attemptId}`);
    if (type !== 'response' && type !== 'error') throw new Error('provider attempt must finish as response or error');
    if (!['reported', 'confirmed_unbilled', 'unknown'].includes(billingStatus)) {
      throw new Error(`invalid billingStatus: ${billingStatus}`);
    }
    openAttempts.delete(attemptId);
    totals.openAttempts = openAttempts.size;
    if (type === 'response') {
      totals.providerResponses += 1;
      addUsage(usage ?? null, { providerCostRequired });
    } else {
      totals.providerErrors += 1;
    }
    if (billingStatus === 'unknown') {
      totals.unknownBillingAttempts += 1;
      totals.billingComplete = false;
    }
    refreshCostComplete();
    return record(type, {
      requestId: open.requestId,
      attemptId,
      billingStatus,
      durationMs: Math.max(0, monotonicNow() - open.startedMonotonicMs),
      ...(type === 'response' ? { usage: usage ?? null } : {}),
      ...data,
    });
  }

  function recordRetry(data = {}) {
    totals.retries += 1;
    return record('retry', data);
  }

  return {
    record,
    startRequest,
    startAttempt,
    finishAttempt,
    recordRetry,
    /** Backward-compatible response accumulator for non-attempt-aware callers. */
    addUsage,
    snapshot() {
      refreshCostComplete();
      const snapshotTotals = { ...totals, openAttempts: openAttempts.size };
      return {
        totals: snapshotTotals,
        events: events.map((event) => structuredClone(event)),
      };
    },
  };
}
