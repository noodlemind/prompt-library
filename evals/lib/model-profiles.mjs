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

import { CONTROLLED_OPENROUTER_PROFILES } from '../runtime/controlled-provider-policy.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const PROFILES = deepFreeze({
  ...CONTROLLED_OPENROUTER_PROFILES,
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
