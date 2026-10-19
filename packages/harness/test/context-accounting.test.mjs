import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountContext, summarizeContextAccounting } from '../lib/token-meter.mjs';

test('artifact accounting keeps byte estimates separate from model usage and hidden content', () => {
  const result = accountContext({ boundary: 'orientation-output', components: [{ category: 'pack', id: 'pack', content: 'hello' }] });
  assert.equal(result.knownBytes, 5);
  assert.equal(result.components[0].measurement, 'estimated');
  assert.equal(result.modelUsage.inputTokens, null);
  assert.equal(result.categoryCoverage.instructions, 'unavailable');
  assert.equal(result.modelInputCoverage, 'unavailable');
  assert.equal(JSON.stringify(result).includes('hello'), false);
});

test('observed totals do not invent a category breakdown or missing output usage', () => {
  const result = accountContext({ boundary: 'host-usage-only', usage: { 'gen_ai.usage.input_tokens': 120, 'gen_ai.usage.cache_read_tokens': 100, estimated: false } });
  assert.equal(result.modelUsage.inputTokens, 120);
  assert.equal(result.modelUsage.outputTokens, null);
  assert.equal(result.modelUsage.cachedInputTokens, 100);
  assert.equal(result.modelUsage.measurement, 'observed');
  assert.equal(result.categoryCoverage.history, 'unavailable');
});

test('estimated usage stays estimated and repeated reads are counted without source content', () => {
  const result = accountContext({ boundary: 'headless-request', components: [{ category: 'history', id: 'turn', content: 'secret body' }], usage: { 'gen_ai.usage.input_tokens': 90, estimated: true }, reads: ['file-a', 'file-b', 'file-a'] });
  assert.equal(result.modelUsage.measurement, 'estimated');
  assert.equal(result.repeatedReads, 1);
  assert.equal(result.reads, 3);
  assert.equal(JSON.stringify(result).includes('secret body'), false);
});

test('reports keep host usage, runtime requests and produced artifacts in separate totals', () => {
  const request = accountContext({ boundary: 'headless-request', usage: { inputTokens: 10, outputTokens: 5 } });
  const result = summarizeContextAccounting([
    { type: 'context.accounting', contextAccounting: request },
    { type: 'agent.turn', contextAccounting: request },
    { source: 'host', contextAccounting: accountContext({ boundary: 'host-usage-only', usage: { inputTokens: 10, outputTokens: 5 } }) },
    { type: 'orient', contextAccounting: accountContext({ boundary: 'orientation-output', components: [{ category: 'pack', id: 'pack', content: 'text' }] }) },
  ]);
  assert.equal(result.boundaries['headless-request'].records, 1);
  assert.equal(result.boundaries['headless-request'].knownObservedInputTokens, 10);
  assert.equal(result.boundaries['host-usage-only'].knownObservedInputTokens, 10);
  assert.equal(result.boundaries['orientation-output'].knownObservedInputTokens, null);
  assert.equal(result.combinedModelTotal, null);
});
