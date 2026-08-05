/**
 * Code-owned OpenRouter profile and broker-policy projection.
 *
 * This module lives inside the runtime closure so the controller and the
 * privileged supervisor derive the same provider identity. The release budget
 * policy is intentionally separate: it describes scheduling and reservations,
 * while this policy describes the exact provider/model/routing/pricing seam.
 */
import { providerBrokerStaticPolicyHash } from './provider-broker.mjs';

const ZERO_HASH = '0'.repeat(64);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const HASH = /^[a-f0-9]{64}$/;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CONTROLLED_OPENROUTER_PROFILES = deepFreeze({
  'kimi-k2.7-code': {
    id: 'kimi-k2.7-code',
    model: 'moonshotai/kimi-k2.7-code-20260612',
    host: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    provider: {
      order: ['moonshotai/int4'],
      expectedResolvedNames: ['Moonshot AI'],
      allowFallbacks: false,
    },
    catalogPin: {
      checkedAt: '2026-07-31',
      canonicalSlug: 'moonshotai/kimi-k2.7-code-20260612',
      endpointTag: 'moonshotai/int4',
    },
    pricing: { inputPerM: 0.95, cachedInputPerM: 0.19, outputPerM: 4.0 },
    maxTokens: 8192,
    temperature: null,
    reasoning: null,
    timeoutMs: 15 * 60_000,
    trialCeilingUsd: 5,
  },
});

function microusd(value, label, { positive = true } = {}) {
  const minimum = positive ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < minimum || value > 20_000_000) {
    throw new TypeError(`${label} must be an integer between ${minimum} and 20000000 microusd`);
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must be a bounded safe identifier`);
  }
  return value;
}

export function getControlledOpenRouterProfile(profileId) {
  const profile = CONTROLLED_OPENROUTER_PROFILES[profileId];
  if (!profile) {
    throw new Error(
      `unknown controlled OpenRouter profile: ${profileId} ` +
      `(known: ${Object.keys(CONTROLLED_OPENROUTER_PROFILES).join(', ')})`,
    );
  }
  return profile;
}

function validateTrial(trial, sessionCeilingMicrousd, profileTrialCeilingMicrousd) {
  if (trial == null) {
    return {
      leaseId: 'engineer-static-policy-placeholder',
      leaseDigest: ZERO_HASH,
      trialId: 'static-policy-placeholder',
      leaseSequence: 1,
      ceilingUsd: 0.000001,
    };
  }
  if (typeof trial !== 'object' || Array.isArray(trial) ||
      Object.keys(trial).sort().join(',') !==
        ['leaseDigest', 'leaseId', 'leaseSequence', 'trialCeilingMicrousd', 'trialId'].sort().join(',')) {
    throw new TypeError('controlled provider trial binding has unexpected or missing fields');
  }
  safeId(trial.leaseId, 'trial leaseId');
  safeId(trial.trialId, 'trial trialId');
  if (typeof trial.leaseDigest !== 'string' || !HASH.test(trial.leaseDigest)) {
    throw new TypeError('trial leaseDigest must be a SHA-256 digest');
  }
  if (!Number.isSafeInteger(trial.leaseSequence) || trial.leaseSequence < 1 ||
      trial.leaseSequence > 1_000_000) {
    throw new TypeError('trial leaseSequence must be a bounded positive integer');
  }
  const ceiling = microusd(trial.trialCeilingMicrousd, 'trial ceiling');
  if (ceiling > sessionCeilingMicrousd) {
    throw new TypeError('trial budget exceeds the session budget');
  }
  if (ceiling > profileTrialCeilingMicrousd) {
    throw new TypeError('trial budget exceeds the controlled profile trial ceiling');
  }
  return {
    leaseId: trial.leaseId,
    leaseDigest: trial.leaseDigest,
    trialId: trial.trialId,
    leaseSequence: trial.leaseSequence,
    ceilingUsd: ceiling / 1_000_000,
  };
}

export function buildControlledProviderBrokerPolicy({
  profileId,
  sessionCeilingMicrousd,
  trial = null,
} = {}) {
  const profile = getControlledOpenRouterProfile(profileId);
  const sessionCeiling = microusd(sessionCeilingMicrousd, 'session ceiling');
  const profileTrialCeiling = microusd(
    profile.trialCeilingUsd * 1_000_000,
    'controlled profile trial ceiling',
  );
  const trialBinding = validateTrial(trial, sessionCeiling, profileTrialCeiling);
  return deepFreeze({
    endpoint: profile.url,
    model: profile.model,
    provider: structuredClone(profile.provider),
    settings: {
      temperature: profile.temperature,
      reasoning: structuredClone(profile.reasoning),
      toolChoice: 'auto',
    },
    maxTokens: profile.maxTokens,
    pricing: structuredClone(profile.pricing),
    sessionCeilingUsd: sessionCeiling / 1_000_000,
    trials: [trialBinding],
  });
}

export function controlledProviderBrokerStaticPolicyHash(input) {
  return providerBrokerStaticPolicyHash(buildControlledProviderBrokerPolicy(input));
}
