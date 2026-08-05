import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getProfile, listProfiles } from '../../../evals/lib/model-profiles.mjs';

test('kimi profile pins the OpenRouter provider with fallbacks disabled', () => {
  const p = getProfile('kimi-k2.7-code');
  assert.equal(p.model, 'moonshotai/kimi-k2.7-code');
  assert.equal('modelAlias' in p, false, 'the mutable convenience alias is not an accepted resolved model');
  assert.equal(p.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.deepEqual(p.provider.order, ['moonshotai/int4']);
  assert.deepEqual(p.provider.expectedResolvedNames, ['Moonshot AI']);
  assert.deepEqual(p.provider.expectedResolvedModels, ['moonshotai/kimi-k2.7-code-20260612']);
  assert.equal(p.provider.allowFallbacks, false);
  assert.equal(p.catalogPin.modelId, p.model);
  assert.equal(p.catalogPin.canonicalSlug, 'moonshotai/kimi-k2.7-code-20260612');
  assert.notEqual(p.catalogPin.canonicalSlug, p.model);
  assert.equal(p.catalogPin.endpointTag, p.provider.order[0]);
});

test('kimi profile carries pricing with cached input cheaper than uncached', () => {
  const { pricing } = getProfile('kimi-k2.7-code');
  assert.ok(pricing.inputPerM > 0);
  assert.ok(pricing.outputPerM > 0);
  assert.ok(pricing.cachedInputPerM > 0);
  assert.ok(pricing.cachedInputPerM < pricing.inputPerM);
});

test('kimi pricing matches the pinned Moonshot AI endpoint, not the model-level floor', () => {
  // OpenRouter bills per endpoint. The profile pins provider order to
  // moonshotai/int4, whose endpoint lists $0.95/M input, $0.19/M cached
  // input, and $4.00/M output — cost totals, charges, and prechecks must use
  // the pinned endpoint's rates.
  assert.deepEqual(getProfile('kimi-k2.7-code').pricing, { inputPerM: 0.95, cachedInputPerM: 0.19, outputPerM: 4.0 });
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

test('every registered OpenRouter profile pins a provider and disables fallback', () => {
  const profiles = listProfiles().filter((profile) => profile.host === 'openrouter');
  assert.ok(profiles.length > 0);
  for (const profile of profiles) {
    assert.equal(profile.provider?.allowFallbacks, false, profile.id);
    assert.ok(Array.isArray(profile.provider?.order) && profile.provider.order.length > 0, profile.id);
    assert.ok(
      Array.isArray(profile.provider?.expectedResolvedNames) && profile.provider.expectedResolvedNames.length > 0,
      profile.id,
    );
    assert.deepEqual(profile.provider?.expectedResolvedModels, [profile.catalogPin?.canonicalSlug], profile.id);
    assert.equal(profile.catalogPin?.modelId, profile.model, profile.id);
    assert.notEqual(profile.catalogPin?.canonicalSlug, profile.model, profile.id);
    assert.ok(profile.provider.order.includes(profile.catalogPin?.endpointTag), profile.id);
  }
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
