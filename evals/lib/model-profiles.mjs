/**
 * Model/provider profiles for the release evaluation.
 *
 * A profile is the single source of truth for how one evaluated model is
 * reached and billed: endpoint, provider pinning, pricing, limits, and the
 * reasoning/temperature configuration that must be identical across the
 * generic and Harness conditions. Profiles are deep-frozen so nothing can
 * drift pricing or routing mid-run; pricing is release-time data, re-verified
 * against the provider catalog when a release is cut.
 *
 * Pricing units are USD per million tokens.
 */
import crypto from 'node:crypto';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const PROFILES = deepFreeze({
  'kimi-k2.7-code': {
    id: 'kimi-k2.7-code',
    model: 'moonshotai/kimi-k2.7-code-20260612',
    host: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    // Pin one exact endpoint variant. A base `moonshotai` slug also matches the
    // 2x-priced `moonshotai/highspeed` endpoint and is not reproducible.
    provider: { order: ['moonshotai/int4'], expectedResolvedNames: ['Moonshot AI'], allowFallbacks: false },
    catalogPin: {
      checkedAt: '2026-07-31',
      canonicalSlug: 'moonshotai/kimi-k2.7-code-20260612',
      endpointTag: 'moonshotai/int4',
    },
    // OpenRouter bills per endpoint: these are the pinned Moonshot AI standard
    // endpoint rates, not the cheaper model-level floor from unpinned providers.
    pricing: { inputPerM: 0.95, cachedInputPerM: 0.19, outputPerM: 4.0 },
    maxTokens: 8192,
    temperature: null, // model default, per the evaluation plan
    reasoning: null, // identical (absent) in both conditions
    timeoutMs: 15 * 60_000,
    trialCeilingUsd: 5,
  },
  'gemma-4-26b-local': {
    id: 'gemma-4-26b-local',
    model: 'gemma4:26b-a4b-it-q4_K_M',
    host: 'ollama',
    url: 'http://localhost:11434/v1/chat/completions',
    provider: null, // local — nothing to pin
    pricing: { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0 },
    maxTokens: 4096,
    temperature: null,
    // Ollama's OpenAI-compatible /v1/chat/completions surface accepts
    // `reasoning.effort`, not the native API's `think`/an `enabled` flag.
    reasoning: { effort: 'high' },
    timeoutMs: 30 * 60_000,
    trialCeilingUsd: 0,
  },
});

export function getProfile(id) {
  const profile = PROFILES[id];
  if (!profile) {
    throw new Error(`unknown model profile: ${id} (known: ${Object.keys(PROFILES).join(', ')})`);
  }
  return profile;
}

/** Stable, non-secret identity for the exact routing and pricing assumptions. */
export function billingProfileEvidence(id) {
  const profile = getProfile(id);
  return {
    profileId: profile.id,
    model: profile.model,
    host: profile.host,
    provider: profile.provider,
    catalogPin: profile.catalogPin ?? null,
    pricing: profile.pricing,
  };
}

export function billingProfileHash(id) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(billingProfileEvidence(id)))
    .digest('hex');
}

export function listProfiles() {
  return Object.values(PROFILES);
}
