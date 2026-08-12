const CHARS_PER_TOKEN = 4;

/** Estimate tokens for a string (or any JSON-serializable value). */
export function estimateTokens(value) {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 0;
  const byChars = Math.ceil(text.length / CHARS_PER_TOKEN);
  const byWords = Math.ceil((text.trim().split(/\s+/).filter(Boolean).length * 4) / 3);
  return Math.max(byChars, byWords);
}

export function usageFields({ input = '', output = '' } = {}) {
  const inputTokens = typeof input === 'number' ? input : estimateTokens(input);
  const outputTokens = typeof output === 'number' ? output : estimateTokens(output);
  if (!inputTokens && !outputTokens) return null;
  return {
    'gen_ai.usage.input_tokens': inputTokens,
    'gen_ai.usage.output_tokens': outputTokens,
    'gen_ai.usage.total_tokens': inputTokens + outputTokens,
    estimated: true,
  };
}

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read the independently trustworthy portions of one usage record. */
export function measuredUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const inputTokens = tokenCount(usage['gen_ai.usage.input_tokens']);
  const outputTokens = tokenCount(usage['gen_ai.usage.output_tokens']);
  const recordedTotal = tokenCount(usage['gen_ai.usage.total_tokens']);
  const totalTokens = recordedTotal ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  return { inputTokens, outputTokens, totalTokens };
}

function coverageStatus(present, expected) {
  if (expected === 0 || present === 0) return 'unavailable';
  return present === expected ? 'complete' : 'partial';
}

function usageAccumulator() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usageEvents: 0,
    inputEvents: 0,
    outputEvents: 0,
    totalEvents: 0,
    completeUsageEvents: 0,
  };
}

function addUsage(accumulator, measured) {
  accumulator.usageEvents += 1;
  if (measured.inputTokens !== null) {
    accumulator.inputTokens += measured.inputTokens;
    accumulator.inputEvents += 1;
  }
  if (measured.outputTokens !== null) {
    accumulator.outputTokens += measured.outputTokens;
    accumulator.outputEvents += 1;
  }
  if (measured.totalTokens !== null) {
    accumulator.totalTokens += measured.totalTokens;
    accumulator.totalEvents += 1;
  }
  if (measured.inputTokens !== null && measured.outputTokens !== null && measured.totalTokens !== null) {
    accumulator.completeUsageEvents += 1;
  }
}

function finalizeUsage(accumulator) {
  const coverage = {
    input: coverageStatus(accumulator.inputEvents, accumulator.usageEvents),
    output: coverageStatus(accumulator.outputEvents, accumulator.usageEvents),
    total: coverageStatus(accumulator.totalEvents, accumulator.usageEvents),
  };
  return {
    inputTokens: accumulator.inputEvents > 0 ? accumulator.inputTokens : accumulator.usageEvents > 0 ? null : 0,
    outputTokens: accumulator.outputEvents > 0 ? accumulator.outputTokens : accumulator.usageEvents > 0 ? null : 0,
    totalTokens: coverage.total === 'complete' ? accumulator.totalTokens : accumulator.usageEvents > 0 ? null : 0,
    knownTotalTokens: accumulator.totalTokens,
    usageEvents: accumulator.usageEvents,
    completeTotalEvents: accumulator.totalEvents,
    completeUsageEvents: accumulator.completeUsageEvents,
    partialUsageEvents: accumulator.usageEvents - accumulator.completeUsageEvents,
    coverage,
  };
}

/** Sum usage across events into per-type and total token roll-ups. */
export function summarizeUsage(events = []) {
  const aggregate = usageAccumulator();
  const byType = {};
  for (const event of events) {
    const usage = measuredUsage(event?.usage);
    if (!usage) continue;
    addUsage(aggregate, usage);
    const bucket = (byType[event.type] ||= usageAccumulator());
    addUsage(bucket, usage);
  }
  return {
    ...finalizeUsage(aggregate),
    byType: Object.fromEntries(
      Object.entries(byType).map(([type, bucket]) => [type, finalizeUsage(bucket)])
    ),
  };
}
