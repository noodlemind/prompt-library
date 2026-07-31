import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getProfile, listProfiles } from '../../../evals/lib/model-profiles.mjs';

test('kimi profile pins the OpenRouter provider with fallbacks disabled', () => {
  const p = getProfile('kimi-k2.7-code');
  assert.equal(p.model, 'moonshotai/kimi-k2.7-code');
  assert.equal(p.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.ok(Array.isArray(p.provider.order) && p.provider.order.length > 0, 'provider order must be pinned');
  assert.equal(p.provider.allowFallbacks, false);
});

test('kimi profile carries pricing with cached input cheaper than uncached', () => {
  const { pricing } = getProfile('kimi-k2.7-code');
  assert.ok(pricing.inputPerM > 0);
  assert.ok(pricing.outputPerM > 0);
  assert.ok(pricing.cachedInputPerM > 0);
  assert.ok(pricing.cachedInputPerM < pricing.inputPerM);
});

test('kimi profile enforces the plan trial ceiling and timeout', () => {
  const p = getProfile('kimi-k2.7-code');
  assert.equal(p.trialCeilingUsd, 5);
  assert.equal(p.timeoutMs, 15 * 60_000);
});

test('kimi profile uses model-default temperature and no reasoning override', () => {
  const p = getProfile('kimi-k2.7-code');
  assert.equal(p.temperature, null);
  assert.equal(p.reasoning, null);
});

test('gemma local profile is free, unpinned, and has the 30-minute local timeout', () => {
  const p = getProfile('gemma-4-26b-local');
  assert.equal(p.model, 'gemma4:26b-a4b-it-q4_K_M');
  assert.match(p.url, /localhost:11434/);
  assert.equal(p.provider, null);
  assert.deepEqual(p.pricing, { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0 });
  assert.equal(p.timeoutMs, 30 * 60_000);
  assert.equal(p.trialCeilingUsd, 0);
});

test('getProfile throws on an unknown id and names the known profiles', () => {
  assert.throws(() => getProfile('gpt-oss'), /unknown model profile.*kimi-k2\.7-code/s);
});

test('listProfiles returns every profile id', () => {
  const ids = listProfiles().map((p) => p.id);
  assert.deepEqual(ids.sort(), ['gemma-4-26b-local', 'kimi-k2.7-code']);
});

test('profiles are deep-frozen so eval code cannot drift pricing mid-run', () => {
  const p = getProfile('kimi-k2.7-code');
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.pricing));
  assert.ok(Object.isFrozen(p.provider));
  assert.throws(() => {
    'use strict';
    p.pricing.outputPerM = 0;
  }, TypeError);
});
