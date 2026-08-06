import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens, usageFields, summarizeUsage } from '../lib/token-meter.mjs';

test('estimateTokens is zero-safe and monotonic', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  const short = estimateTokens('gate passed');
  const long = estimateTokens('gate passed on every configured check across the whole plan');
  assert.ok(short > 0);
  assert.ok(long > short);
  assert.ok(estimateTokens('a'.repeat(400)) >= 100);
});

test('estimateTokens accepts non-string values', () => {
  assert.ok(estimateTokens({ checks: ['a', 'b', 'c'] }) > 0);
});

test('usageFields emits gen_ai.usage-style keys and totals', () => {
  const usage = usageFields({ input: 'query text', output: 'a much longer body of output text the agent reads' });
  assert.ok(usage);
  assert.ok(Number.isInteger(usage['gen_ai.usage.input_tokens']));
  assert.ok(Number.isInteger(usage['gen_ai.usage.output_tokens']));
  assert.equal(
    usage['gen_ai.usage.total_tokens'],
    usage['gen_ai.usage.input_tokens'] + usage['gen_ai.usage.output_tokens']
  );
  assert.equal(usage.estimated, true);
});

test('usageFields accepts pre-counted totals and returns null when empty', () => {
  const counted = usageFields({ input: 120, output: 40 });
  assert.equal(counted['gen_ai.usage.input_tokens'], 120);
  assert.equal(counted['gen_ai.usage.total_tokens'], 160);
  assert.equal(usageFields({ input: '', output: '' }), null);
  assert.equal(usageFields(), null);
});

test('summarizeUsage rolls up totals per event type', () => {
  const events = [
    { type: 'orient', usage: usageFields({ input: 10, output: 90 }) },
    { type: 'gate', usage: usageFields({ input: 5, output: 25 }) },
    { type: 'orient', usage: usageFields({ input: 10, output: 40 }) },
    { type: 'verify', usage: null },
  ];
  const summary = summarizeUsage(events);
  assert.equal(summary.totalTokens, 100 + 30 + 50);
  assert.equal(summary.byType.orient.totalTokens, 150);
  assert.equal(summary.byType.gate.totalTokens, 30);
  assert.ok(!summary.byType.verify);
});

test('summarizeUsage honors an explicit total (cache + reasoning beyond in/out)', () => {
  const events = [
    {
      type: 'host_session',
      usage: {
        'gen_ai.usage.input_tokens': 1000,
        'gen_ai.usage.output_tokens': 200,
        'gen_ai.usage.total_tokens': 5000, // folds in cache + reasoning
      },
    },
  ];
  const summary = summarizeUsage(events);
  assert.equal(summary.inputTokens, 1000);
  assert.equal(summary.outputTokens, 200);
  assert.equal(summary.totalTokens, 5000, 'total is not recomputed as input + output');
  assert.equal(summary.byType.host_session.totalTokens, 5000);
});

test('summarizeUsage retains known partial subtotals without inventing a total', () => {
  const summary = summarizeUsage([{
    type: 'host_session',
    usage: { 'gen_ai.usage.input_tokens': 150, estimated: false },
  }]);
  assert.equal(summary.inputTokens, 150);
  assert.equal(summary.outputTokens, null);
  assert.equal(summary.totalTokens, null);
  assert.equal(summary.knownTotalTokens, 0);
  assert.equal(summary.completeTotalEvents, 0);
  assert.equal(summary.partialUsageEvents, 1);
  assert.deepEqual(summary.coverage, {
    input: 'complete', output: 'unavailable', total: 'unavailable',
  });
});
