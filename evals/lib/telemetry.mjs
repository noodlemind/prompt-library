/**
 * Structured run telemetry for eval trials.
 *
 * Two responsibilities, both append-only:
 *   - `record(type, data)` — the structured transcript: every request,
 *     response, tool call, truncation, fallback, refusal, and finish gets a
 *     sequenced event, so a trial can be audited without re-running it.
 *   - `addUsage(...)` — per-response usage accumulation feeding the
 *     eval-run.v1 efficiency metrics. Unusable usage is counted
 *     (`missingUsage`, `costComplete: false`) but never estimated.
 *
 * `snapshot()` returns a defensive copy safe to serialize into results.
 */
export function createTelemetry() {
  let seq = 0;
  const events = [];
  const totals = {
    requests: 0,
    missingUsage: 0,
    promptTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    localCostUsd: 0,
    providerCostUsd: null,
    costComplete: true,
  };

  return {
    record(type, data = {}) {
      const event = { seq: seq++, type, ...data };
      events.push(event);
      return event;
    },
    /** One provider response's usage; pass null/undefined when usage was unusable. */
    addUsage(usage) {
      totals.requests += 1;
      if (!usage) {
        totals.missingUsage += 1;
        totals.costComplete = false;
        return;
      }
      totals.promptTokens += usage.promptTokens || 0;
      totals.cachedTokens += usage.cachedTokens || 0;
      totals.reasoningTokens += usage.reasoningTokens || 0;
      totals.outputTokens += usage.outputTokens || 0;
      totals.localCostUsd += usage.localCostUsd || 0;
      if (typeof usage.providerCostUsd === 'number' && Number.isFinite(usage.providerCostUsd)) {
        totals.providerCostUsd = (totals.providerCostUsd ?? 0) + usage.providerCostUsd;
      }
    },
    snapshot() {
      return { totals: { ...totals }, events: events.map((e) => ({ ...e })) };
    },
  };
}
