import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOfUsage, estimateRequestCostUsd, estimateTokensForChars, createBudget } from '../../../evals/lib/budget.mjs';

const PRICING = { inputPerM: 0.73, cachedInputPerM: 0.15, outputPerM: 3.5 };

function approx(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);
}

test('uncached cost: full input rate plus output rate', () => {
  const cost = costOfUsage({ prompt_tokens: 1_000_000, completion_tokens: 100_000 }, PRICING);
  approx(cost.usd, 0.73 + 0.35);
  assert.equal(cost.promptTokens, 1_000_000);
  assert.equal(cost.cachedTokens, null, 'missing cache detail remains unknown');
  assert.equal(cost.cachedTokensComplete, false);
  assert.equal(cost.outputTokens, 100_000);
});

test('cached cost: cached share billed at the cached input rate', () => {
  const cost = costOfUsage(
    { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 600_000 } },
    PRICING
  );
  // 400k * 0.73/M + 600k * 0.15/M = 0.292 + 0.09
  approx(cost.usd, 0.382);
  assert.equal(cost.cachedTokens, 600_000);
  assert.equal(cost.cachedTokensComplete, true);
});

test('cached tokens reported above prompt tokens are rejected as incomplete detail', () => {
  const cost = costOfUsage(
    { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 5_000 } },
    PRICING
  );
  assert.equal(cost.cachedTokens, null);
  assert.equal(cost.cachedTokensComplete, false);
  approx(cost.usd, (100 * 0.73) / 1_000_000);
});

test('missing or malformed usage yields null, never a silent estimate', () => {
  assert.equal(costOfUsage(undefined, PRICING), null);
  assert.equal(costOfUsage(null, PRICING), null);
  assert.equal(costOfUsage({}, PRICING), null);
  assert.equal(costOfUsage({ prompt_tokens: 10 }, PRICING), null); // completion missing
  assert.equal(costOfUsage({ prompt_tokens: -1, completion_tokens: 5 }, PRICING), null);
  assert.equal(costOfUsage({ prompt_tokens: '10', completion_tokens: 5 }, PRICING), null);
  assert.equal(costOfUsage({ prompt_tokens: NaN, completion_tokens: 5 }, PRICING), null);
  assert.equal(costOfUsage({ prompt_tokens: 10.5, completion_tokens: 5 }, PRICING), null);
  assert.equal(costOfUsage({ prompt_tokens: 10, completion_tokens: 1.5 }, PRICING), null);
});

test('request estimate is worst-case: uncached input plus maximum output tokens', () => {
  const usd = estimateRequestCostUsd({ promptTokens: 1_000_000, maxOutputTokens: 100_000 }, PRICING);
  approx(usd, 0.73 + 0.35);
});

test('character-based token estimate rounds up at ~4 chars per token', () => {
  assert.equal(estimateTokensForChars(0), 0);
  assert.equal(estimateTokensForChars(1), 1);
  assert.equal(estimateTokensForChars(8), 2);
  assert.equal(estimateTokensForChars(9), 3);
});

test('precheck allows a request that fits under the ceiling', () => {
  const budget = createBudget({ ceilingUsd: 10, label: 'kimi-pair' });
  const verdict = budget.precheck(4);
  assert.equal(verdict.allowed, true);
  assert.equal(budget.exhausted, false);
});

test('precheck refuses a request that could cross the ceiling and records budget_exhausted', () => {
  const budget = createBudget({ ceilingUsd: 5, label: 'trial' });
  budget.charge(4.5, 'earlier requests');
  const verdict = budget.precheck(1);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /trial/);
  assert.equal(budget.exhausted, true);
  const events = budget.events();
  assert.equal(events.at(-1).type, 'budget_exhausted');
  assert.equal(events.at(-1).estimateUsd, 1);
});

test('precheck fails closed on negative or non-finite request estimates', () => {
  for (const estimate of [-1, NaN, Infinity, -Infinity]) {
    const budget = createBudget({ ceilingUsd: 5, label: 'trial' });
    const verdict = budget.precheck(estimate);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /invalid request estimate/);
    assert.equal(budget.exhausted, true);
    assert.equal(budget.events().at(-1).type, 'budget_invalid_estimate');
    assert.equal(budget.spentUsd(), 0);
  }
});

test('charge accumulates and propagates to the parent release budget', () => {
  const release = createBudget({ ceilingUsd: 20, label: 'release' });
  const trial = createBudget({ ceilingUsd: 5, label: 'trial', parent: release });
  trial.charge(2, 'request 1');
  approx(trial.spentUsd(), 2);
  approx(release.spentUsd(), 2);
  approx(trial.remainingUsd(), 3);
  approx(release.remainingUsd(), 18);
});

test('an uncertain reserve consumes allowance without becoming known spend', () => {
  const release = createBudget({ ceilingUsd: 10, label: 'release' });
  const trial = createBudget({ ceilingUsd: 5, label: 'trial', parent: release });
  trial.charge(0.25, 'known response');
  trial.reserve(4.75, 'ambiguous transport');
  assert.equal(trial.spentUsd(), 5);
  assert.equal(trial.knownReconciledSpendUsd(), 0.25);
  assert.equal(trial.uncertainReservedUsd(), 4.75);
  assert.equal(trial.accountedExposureUsd(), 5);
  assert.equal(release.knownReconciledSpendUsd(), 0.25);
  assert.equal(release.uncertainReservedUsd(), 4.75);
  assert.equal(release.events().at(-1).type, 'reserve');
});

test('precheck refuses when the trial fits but the release ceiling would be crossed', () => {
  const release = createBudget({ ceilingUsd: 3, label: 'release' });
  const trial = createBudget({ ceilingUsd: 5, label: 'trial', parent: release });
  trial.charge(2.5, 'prior');
  const verdict = trial.precheck(1);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /release/);
});

test('a budget without a valid ceiling refuses to exist rather than failing open', () => {
  assert.throws(() => createBudget({ label: 'trial' }), /ceilingUsd/);
  assert.throws(() => createBudget({ ceilingUsd: NaN }), /ceilingUsd/);
  assert.throws(() => createBudget({ ceilingUsd: -1 }), /ceilingUsd/);
});

test('a parent refusal marks the child exhausted and lands in its audit trail', () => {
  const release = createBudget({ ceilingUsd: 3, label: 'release' });
  const trial = createBudget({ ceilingUsd: 5, label: 'trial', parent: release });
  trial.charge(2.5, 'prior');
  const verdict = trial.precheck(1);
  assert.equal(verdict.allowed, false);
  assert.equal(trial.exhausted, true, 'the child must not keep re-prechecking forever');
  assert.equal(trial.events().at(-1).type, 'budget_exhausted');
});

test('charge rejects negative amounts and ignores null cost', () => {
  const budget = createBudget({ ceilingUsd: 5, label: 'b' });
  assert.throws(() => budget.charge(-1), /negative/);
  budget.charge(null, 'unusable usage');
  assert.equal(budget.spentUsd(), 0);
});

test('an unexpected actual charge above a prechecked ceiling is retained and marked as a blocking breach', () => {
  const budget = createBudget({ ceilingUsd: 1, label: 'release' });
  assert.equal(budget.precheck(0.9).allowed, true);
  budget.charge(1.1, 'provider reconciliation');
  assert.equal(budget.spentUsd(), 1.1, 'actual provider spend must never be hidden or capped in the ledger');
  assert.equal(budget.breached, true);
  assert.equal(budget.exhausted, true);
  assert.equal(budget.overrunUsd(), 0.1);
  assert.equal(budget.events().at(-1).type, 'budget_breach');
});

test('a child overrun also marks its parent release ceiling when applicable', () => {
  const release = createBudget({ ceilingUsd: 1, label: 'release' });
  const trial = createBudget({ ceilingUsd: 2, label: 'trial', parent: release });
  trial.charge(1.2, 'provider reconciliation');
  assert.equal(trial.breached, false);
  assert.equal(release.breached, true);
  assert.equal(release.spentUsd(), 1.2);
});
