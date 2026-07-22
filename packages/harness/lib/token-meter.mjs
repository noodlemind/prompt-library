/**
 * Deterministic token estimation for harness telemetry.
 *
 * The harness cannot read the host model's real usage, so it estimates the
 * cost of what it injects and emits. The estimate is a chars/4 baseline (the
 * commonly used rule of thumb) with a small word-count correction so short,
 * whitespace-heavy text is not undercounted. Field names follow the
 * OpenTelemetry gen_ai.usage.* convention so downstream tooling can read them.
 */

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

/**
 * Build a gen_ai.usage-style object from input/output text (or pre-counted
 * token totals). Returns null only when both sides are empty.
 */
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

/** Sum usage across events into per-type and total token roll-ups. */
export function summarizeUsage(events = []) {
  const summary = { inputTokens: 0, outputTokens: 0, totalTokens: 0, byType: {} };
  for (const event of events) {
    const usage = event?.usage;
    if (!usage) continue;
    const input = usage['gen_ai.usage.input_tokens'] || 0;
    const output = usage['gen_ai.usage.output_tokens'] || 0;
    summary.inputTokens += input;
    summary.outputTokens += output;
    summary.totalTokens += input + output;
    const bucket = (summary.byType[event.type] ||= { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    bucket.totalTokens += input + output;
  }
  return summary;
}
