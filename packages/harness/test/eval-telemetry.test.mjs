import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTelemetry } from '../../../evals/lib/telemetry.mjs';

test('record assigns a monotonically increasing seq and preserves type and data', () => {
  const t = createTelemetry();
  const a = t.record('request', { model: 'kimi' });
  const b = t.record('response', { generationId: 'gen-1' });
  assert.equal(a.seq, 0);
  assert.equal(b.seq, 1);
  assert.equal(a.type, 'request');
  assert.equal(a.model, 'kimi');
  assert.equal(b.generationId, 'gen-1');
  assert.deepEqual(
    t.snapshot().events.map((e) => e.seq),
    [0, 1]
  );
});

test('addUsage accumulates token totals, request count, and local cost', () => {
  const t = createTelemetry();
  t.addUsage({ promptTokens: 100, cachedTokens: 40, reasoningTokens: 10, outputTokens: 20, localCostUsd: 0.001 });
  t.addUsage({ promptTokens: 200, cachedTokens: 0, reasoningTokens: 0, outputTokens: 30, localCostUsd: 0.002 });
  const { totals } = t.snapshot();
  assert.equal(totals.requests, 2);
  assert.equal(totals.promptTokens, 300);
  assert.equal(totals.cachedTokens, 40);
  assert.equal(totals.reasoningTokens, 10);
  assert.equal(totals.outputTokens, 50);
  assert.ok(Math.abs(totals.localCostUsd - 0.003) < 1e-12);
  assert.equal(totals.missingUsage, 0);
  assert.equal(totals.costComplete, true);
});

test('a response with unusable usage is counted but never estimated', () => {
  const t = createTelemetry();
  t.addUsage({ promptTokens: 100, cachedTokens: 0, reasoningTokens: 0, outputTokens: 10, localCostUsd: 0.001 });
  t.addUsage(null);
  const { totals } = t.snapshot();
  assert.equal(totals.requests, 2);
  assert.equal(totals.missingUsage, 1);
  assert.equal(totals.costComplete, false);
  assert.ok(Math.abs(totals.localCostUsd - 0.001) < 1e-12, 'known cost is kept, missing cost is not invented');
});

test('provider-reported cost stays null until a provider actually reports one', () => {
  const t = createTelemetry();
  t.addUsage({ promptTokens: 1, cachedTokens: 0, reasoningTokens: 0, outputTokens: 1, localCostUsd: 0 });
  assert.equal(t.snapshot().totals.providerCostUsd, null);
  t.addUsage({ promptTokens: 1, cachedTokens: 0, reasoningTokens: 0, outputTokens: 1, localCostUsd: 0, providerCostUsd: 0.005 });
  assert.ok(Math.abs(t.snapshot().totals.providerCostUsd - 0.005) < 1e-12);
});

test('snapshot is a copy — mutating it does not corrupt internal state', () => {
  const t = createTelemetry();
  t.record('request', {});
  const snap = t.snapshot();
  snap.events.push({ seq: 99, type: 'forged' });
  snap.totals.requests = 42;
  const clean = t.snapshot();
  assert.equal(clean.events.length, 1);
  assert.equal(clean.totals.requests, 0);
});
