import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTelemetry } from '../lib/telemetry.mjs';

test('record assigns a monotonically increasing seq and preserves type and data', () => {
  let tick = 10;
  const t = createTelemetry({
    now: () => new Date('2026-07-31T12:00:00.000Z'),
    monotonicNow: () => tick++,
    idFactory: (seq) => `event-${seq}`,
  });
  const a = t.record('request', { model: 'kimi' });
  const b = t.record('response', { generationId: 'gen-1' });
  assert.equal(a.seq, 0);
  assert.equal(b.seq, 1);
  assert.equal(a.type, 'request');
  assert.equal(a.model, 'kimi');
  assert.equal(a.eventId, 'event-0');
  assert.equal(a.timestamp, '2026-07-31T12:00:00.000Z');
  assert.equal(a.monotonicMs, 10);
  assert.equal(b.generationId, 'gen-1');
  assert.deepEqual(
    t.snapshot().events.map((e) => e.seq),
    [0, 1]
  );
});

test('the attempt ledger distinguishes logical requests, physical attempts, responses, and retries', () => {
  let tick = 100;
  const t = createTelemetry({ monotonicNow: () => tick++ });
  t.startRequest({ requestId: 'request-1', model: 'kimi' });
  t.startAttempt({ requestId: 'request-1', attemptId: 'request-1-attempt-1', attempt: 1 });
  t.finishAttempt('request-1-attempt-1', {
    type: 'error',
    billingStatus: 'confirmed_unbilled',
    status: 429,
  });
  t.recordRetry({ requestId: 'request-1', attemptId: 'request-1-attempt-1', status: 429, waitMs: 1 });
  t.startAttempt({ requestId: 'request-1', attemptId: 'request-1-attempt-2', attempt: 2 });
  t.finishAttempt('request-1-attempt-2', {
    type: 'response',
    billingStatus: 'reported',
    usage: {
      promptTokens: 10,
      cachedTokens: 4,
      reasoningTokens: 1,
      outputTokens: 2,
      localCostUsd: 0.01,
      providerCostUsd: 0.02,
      reconciledCostUsd: 0.02,
    },
    providerCostRequired: true,
  });

  const { totals, events } = t.snapshot();
  assert.equal(totals.modelRequests, 1);
  assert.equal(totals.providerAttempts, 2);
  assert.equal(totals.providerResponses, 1);
  assert.equal(totals.providerErrors, 1);
  assert.equal(totals.retries, 1);
  assert.equal(totals.requests, 1, 'legacy requests remains the completed-response count');
  assert.equal(totals.openAttempts, 0);
  assert.equal(totals.billingComplete, true);
  const terminal = events.filter((event) => event.attemptId).filter((event) => event.type === 'response' || event.type === 'error');
  assert.deepEqual(terminal.map((event) => event.attemptId), ['request-1-attempt-1', 'request-1-attempt-2']);
  assert.ok(terminal.every((event) => event.durationMs >= 1));
});

test('unknown billing and an unclosed attempt make cost evidence incomplete', () => {
  const t = createTelemetry();
  t.startRequest({ requestId: 'request-1' });
  t.startAttempt({ requestId: 'request-1', attemptId: 'attempt-1' });
  t.finishAttempt('attempt-1', { type: 'error', billingStatus: 'unknown', message: 'timeout' });
  t.startAttempt({ requestId: 'request-1', attemptId: 'attempt-2' });
  const { totals } = t.snapshot();
  assert.equal(totals.unknownBillingAttempts, 1);
  assert.equal(totals.openAttempts, 1);
  assert.equal(totals.billingComplete, false);
  assert.equal(totals.costComplete, false);
});

test('the attempt ledger rejects every malformed lifecycle transition', () => {
  const t = createTelemetry();
  assert.throws(() => t.startAttempt({ attemptId: 'attempt-missing-request' }), /required/);
  assert.throws(() => t.startAttempt({ requestId: 'request-1' }), /required/);

  t.startAttempt({ requestId: 'request-1', attemptId: 'attempt-1' });
  assert.throws(
    () => t.startAttempt({ requestId: 'request-1', attemptId: 'attempt-1' }),
    /already open/
  );
  assert.throws(() => t.finishAttempt('attempt-never-opened', { type: 'response' }), /not open/);
  assert.throws(() => t.finishAttempt('attempt-1', { type: 'retry' }), /response or error/);
  assert.throws(
    () => t.finishAttempt('attempt-1', { type: 'error', billingStatus: 'free' }),
    /invalid billingStatus/
  );
  assert.doesNotThrow(() => t.finishAttempt('attempt-1', {
    type: 'error',
    billingStatus: 'confirmed_unbilled',
  }));
  assert.equal(t.snapshot().totals.openAttempts, 0, 'rejected transitions must not corrupt the valid open attempt');
});

test('a billable provider error retains usage while remaining an error terminal', () => {
  const t = createTelemetry();
  t.startRequest({ requestId: 'request-1' });
  t.startAttempt({ requestId: 'request-1', attemptId: 'attempt-1' });
  t.finishAttempt('attempt-1', {
    type: 'error',
    billingStatus: 'reported',
    kind: 'provider',
    usage: {
      promptTokens: 10,
      cachedTokens: 0,
      cachedTokensComplete: true,
      reasoningTokens: 0,
      reasoningTokensComplete: true,
      outputTokens: 2,
      localCostUsd: 0.01,
      providerCostUsd: 0.02,
      reconciledCostUsd: 0.02,
    },
    providerCostRequired: true,
  });
  const { totals, events } = t.snapshot();
  assert.equal(totals.providerErrors, 1);
  assert.equal(totals.providerResponses, 0);
  assert.equal(totals.requests, 1);
  assert.equal(totals.promptTokens, 10);
  assert.equal(totals.providerCostUsd, 0.02);
  assert.equal(events.find((event) => event.type === 'error').usage.reconciledCostUsd, 0.02);
});

test('a reported-billing error without usage makes metering incomplete', () => {
  const t = createTelemetry();
  t.startRequest({ requestId: 'request-1' });
  t.startAttempt({ requestId: 'request-1', attemptId: 'attempt-1' });
  t.finishAttempt('attempt-1', {
    type: 'error',
    billingStatus: 'reported',
    providerCostRequired: true,
  });
  const { totals, events } = t.snapshot();
  assert.equal(totals.providerErrors, 1);
  assert.equal(totals.missingUsage, 1);
  assert.equal(totals.usageComplete, false);
  assert.equal(totals.providerCostComplete, false);
  assert.equal(totals.costComplete, false);
  assert.equal(events.find((event) => event.type === 'error').usage, undefined);
});

test('mixed provider-cost presence is incomplete when provider cost is required', () => {
  const t = createTelemetry();
  t.addUsage({ promptTokens: 1, cachedTokens: 0, reasoningTokens: 0, outputTokens: 1, localCostUsd: 0.001, providerCostUsd: 0.002, reconciledCostUsd: 0.002 }, { providerCostRequired: true });
  t.addUsage({ promptTokens: 1, cachedTokens: 0, reasoningTokens: 0, outputTokens: 1, localCostUsd: 0.001, reconciledCostUsd: 0.001 }, { providerCostRequired: true });
  const { totals } = t.snapshot();
  assert.equal(totals.providerCostUsd, 0.002, 'known provider cost remains available but is explicitly partial');
  assert.equal(totals.providerCostComplete, false);
  assert.equal(totals.costComplete, false);
});

test('addUsage accumulates token totals, request count, and local cost', () => {
  const t = createTelemetry();
  t.addUsage({ promptTokens: 100, cachedTokens: 40, reasoningTokens: 10, outputTokens: 20, localCostUsd: 0.001, reconciledCostUsd: 0.001 });
  t.addUsage({ promptTokens: 200, cachedTokens: 0, reasoningTokens: 0, outputTokens: 30, localCostUsd: 0.002, reconciledCostUsd: 0.002 });
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
  t.addUsage({ promptTokens: 100, cachedTokens: 0, reasoningTokens: 0, outputTokens: 10, localCostUsd: 0.001, reconciledCostUsd: 0.001 });
  t.addUsage(null);
  const { totals } = t.snapshot();
  assert.equal(totals.requests, 2);
  assert.equal(totals.missingUsage, 1);
  assert.equal(totals.costComplete, false);
  assert.equal(totals.cachedTokens, null);
  assert.equal(totals.reasoningTokens, null);
  assert.equal(totals.cachedTokensComplete, false);
  assert.equal(totals.reasoningTokensComplete, false);
  assert.ok(Math.abs(totals.localCostUsd - 0.001) < 1e-12, 'known cost is kept, missing cost is not invented');
});

test('missing cache and reasoning details remain null without invalidating usable billing totals', () => {
  const t = createTelemetry();
  t.addUsage({
    promptTokens: 100,
    cachedTokens: null,
    cachedTokensComplete: false,
    reasoningTokens: null,
    reasoningTokensComplete: false,
    outputTokens: 10,
    localCostUsd: 0.001,
    providerCostUsd: 0.002,
    reconciledCostUsd: 0.002,
  }, { providerCostRequired: true });
  const { totals } = t.snapshot();
  assert.equal(totals.cachedTokens, null);
  assert.equal(totals.reasoningTokens, null);
  assert.equal(totals.cachedTokensComplete, false);
  assert.equal(totals.reasoningTokensComplete, false);
  assert.equal(totals.usageComplete, true);
  assert.equal(totals.costComplete, true);
});

test('provider-reported cost stays null until a provider actually reports one', () => {
  const t = createTelemetry();
  t.addUsage({ promptTokens: 1, cachedTokens: 0, reasoningTokens: 0, outputTokens: 1, localCostUsd: 0, reconciledCostUsd: 0 });
  assert.equal(t.snapshot().totals.providerCostUsd, null);
  t.addUsage({ promptTokens: 1, cachedTokens: 0, reasoningTokens: 0, outputTokens: 1, localCostUsd: 0, providerCostUsd: 0.005, reconciledCostUsd: 0.005 });
  assert.ok(Math.abs(t.snapshot().totals.providerCostUsd - 0.005) < 1e-12);
});

test('missing or non-finite core usage is incomplete while known fields still accumulate safely', () => {
  const t = createTelemetry();
  const complete = {
    promptTokens: 10,
    cachedTokens: 0,
    reasoningTokens: 0,
    outputTokens: 2,
    localCostUsd: 0.01,
    reconciledCostUsd: 0.02,
  };
  for (const usage of [
    { ...complete, promptTokens: undefined },
    { ...complete, outputTokens: Infinity },
    { ...complete, localCostUsd: Number.NaN },
    { ...complete, reconciledCostUsd: undefined },
  ]) {
    t.addUsage(usage);
  }

  const { totals } = t.snapshot();
  assert.equal(totals.requests, 4);
  assert.equal(totals.missingUsage, 4);
  assert.equal(totals.usageComplete, false);
  assert.equal(totals.costComplete, false);
  assert.equal(totals.promptTokens, 30, 'only finite prompt-token fields are retained');
  assert.equal(totals.outputTokens, 6, 'only finite output-token fields are retained');
  assert.ok(Math.abs(totals.localCostUsd - 0.03) < 1e-12, 'only finite local costs are retained');
  assert.ok(Math.abs(totals.reconciledCostUsd - 0.06) < 1e-12, 'only finite reconciled costs are retained');
  for (const field of ['promptTokens', 'outputTokens', 'localCostUsd', 'reconciledCostUsd']) {
    assert.equal(Number.isFinite(totals[field]), true, `${field} must never become NaN or Infinity`);
  }
});

test('negative or non-finite provider cost is incomplete and never accumulates', () => {
  const complete = {
    promptTokens: 10,
    cachedTokens: 0,
    reasoningTokens: 0,
    outputTokens: 2,
    localCostUsd: 0.01,
    reconciledCostUsd: 0.02,
  };
  for (const providerCostUsd of [-1, Number.NaN, Infinity, -Infinity]) {
    const t = createTelemetry();
    t.addUsage({ ...complete, providerCostUsd }, { providerCostRequired: true });
    const { totals } = t.snapshot();
    assert.equal(totals.providerCostUsd, null);
    assert.equal(totals.providerCostComplete, false);
    assert.equal(totals.costComplete, false);
  }
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
