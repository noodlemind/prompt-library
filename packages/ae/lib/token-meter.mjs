const CHARS_PER_TOKEN = 4;
export const CONTEXT_CATEGORIES = Object.freeze(['pack', 'instructions', 'capabilities', 'evidence', 'toolResults', 'history', 'handoff']);

export function accountContext({ boundary, components = [], usage = null, reads = [] } = {}) {
  const categoryCoverage = Object.fromEntries(CONTEXT_CATEGORIES.map(category => [category, 'unavailable']));
  const measured = components.map(({ category, id, content }) => {
    if (!CONTEXT_CATEGORIES.includes(category)) throw new TypeError(`unknown context category: ${category}`);
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    categoryCoverage[category] = 'estimated';
    return { category, id, bytes: Buffer.byteLength(text, 'utf8'), tokens: estimateTokens(text), measurement: 'estimated' };
  });
  const inputTokens = tokenCount(usage?.['gen_ai.usage.input_tokens'] ?? usage?.inputTokens);
  const outputTokens = tokenCount(usage?.['gen_ai.usage.output_tokens'] ?? usage?.outputTokens);
  const cachedInputTokens = tokenCount(usage?.['gen_ai.usage.cache_read_tokens'] ?? usage?.cacheReadTokens);
  const hasUsage = inputTokens !== null || outputTokens !== null || cachedInputTokens !== null;
  return {
    schema: 1, boundary,
    components: measured.slice(0, 128),
    componentsOmitted: Math.max(0, measured.length - 128),
    knownBytes: measured.reduce((sum, item) => sum + item.bytes, 0),
    estimatedTokens: measured.reduce((sum, item) => sum + item.tokens, 0),
    categoryCoverage,
    modelInputCoverage: boundary === 'headless-request' ? 'runtime-request-only' : 'unavailable',
    modelUsage: { inputTokens, outputTokens, cachedInputTokens, measurement: hasUsage ? usage?.estimated === true ? 'estimated' : 'observed' : 'unavailable' },
    reads: reads.length,
    repeatedReads: reads.length - new Set(reads).size,
  };
}

export function summarizeContextAccounting(events = []) {
  const groups = new Map();
  for (const event of events) {
    const record = event.contextAccounting;
    if (!record || record.schema !== 1 || event.type === 'agent.turn') continue;
    if (!['headless-request', 'orientation-output', 'host-usage-only'].includes(record.boundary)) continue;
    const rows = groups.get(record.boundary) || [];
    rows.push(record);
    groups.set(record.boundary, rows);
  }
  const boundaries = Object.fromEntries([...groups].map(([boundary, rows]) => {
    const observed = rows.filter(row => row.modelUsage?.measurement === 'observed');
    const known = field => {
      const values = observed.map(row => tokenCount(row.modelUsage[field])).filter(value => value !== null);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    };
    return [boundary, {
      records: rows.length,
      observedUsageRecords: observed.length,
      knownBytes: rows.reduce((sum, row) => sum + (tokenCount(row.knownBytes) || 0), 0),
      estimatedTokens: rows.reduce((sum, row) => sum + (tokenCount(row.estimatedTokens) || 0), 0),
      knownObservedInputTokens: known('inputTokens'),
      knownObservedOutputTokens: known('outputTokens'),
      knownCachedInputTokens: known('cachedInputTokens'),
      usageCoverage: observed.length === rows.length ? 'observed-at-least-in-part' : observed.length ? 'partial' : 'unavailable',
    }];
  }));
  return { boundaries, combinedModelTotal: null, reason: 'Artifact estimates, runtime requests and host observations may overlap. Inspect each boundary separately.' };
}

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
