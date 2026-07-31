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
    model: 'moonshotai/kimi-k2.7-code',
    host: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    // Pinned routing: one provider, no fallback — a fallback invalidates the A/B.
    provider: { order: ['moonshotai'], allowFallbacks: false },
    pricing: { inputPerM: 0.73, cachedInputPerM: 0.15, outputPerM: 3.5 },
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
    reasoning: { enabled: true }, // thinking on, same in both conditions
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

export function listProfiles() {
  return Object.values(PROFILES);
}
