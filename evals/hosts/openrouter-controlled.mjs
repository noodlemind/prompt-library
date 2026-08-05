/**
 * Model-agnostic controlled API host for the release experiment.
 *
 * The caller must select a registered OpenRouter profile explicitly. That
 * profile is shared by the Generic and Harness arms, so changing the model is
 * configuration rather than a host-code change. Provider routing must be
 * pinned and fallback must be disabled before a paid driver can be created.
 */
import { openAiToolDriver } from '../lib/drivers.mjs';
import { getProfile } from '../lib/model-profiles.mjs';
import { createBudget } from '../lib/budget.mjs';

const KEY_ENV = 'OPENROUTER_API_KEY';

export function validateControlledProfile(profile) {
  const profileId = profile?.id ?? 'unknown';
  if (profile.host !== 'openrouter') {
    throw new Error(`controlled host requires an OpenRouter profile: ${profileId}`);
  }

  const provider = profile.provider;
  const providerOrder = provider?.order;
  const expectedResolvedNames = provider?.expectedResolvedNames;
  const expectedResolvedModels = provider?.expectedResolvedModels;
  const catalogPin = profile.catalogPin;
  if (provider?.allowFallbacks !== false) {
    throw new Error(`controlled OpenRouter profile must pin a provider and disable fallback: ${profileId}`);
  }
  if (catalogPin?.modelId !== profile.model ||
      typeof catalogPin?.canonicalSlug !== 'string' || catalogPin.canonicalSlug.length === 0) {
    throw new Error(`controlled OpenRouter profile must pin its catalog model identity: ${profileId}`);
  }
  if (!Array.isArray(providerOrder) || providerOrder.length !== 1 ||
      providerOrder[0] !== catalogPin?.endpointTag) {
    throw new Error(`controlled OpenRouter profile must pin exactly one provider endpoint: ${profileId}`);
  }
  if (!Array.isArray(expectedResolvedNames) || expectedResolvedNames.length !== 1 ||
      typeof expectedResolvedNames[0] !== 'string' || expectedResolvedNames[0].length === 0) {
    throw new Error(`controlled OpenRouter profile must pin exactly one resolved provider identity: ${profileId}`);
  }
  if (!Array.isArray(expectedResolvedModels) || expectedResolvedModels.length !== 1 ||
      expectedResolvedModels[0] !== catalogPin.canonicalSlug) {
    throw new Error(`controlled OpenRouter profile must pin exactly one resolved model identity: ${profileId}`);
  }

  return profile;
}

function requireControlledProfile(profileId) {
  if (typeof profileId !== 'string' || profileId.trim().length === 0) {
    throw new Error('controlled OpenRouter host profileId is required');
  }
  return validateControlledProfile(getProfile(profileId));
}

export function createHost({ profileId, apiKey = process.env[KEY_ENV] } = {}) {
  const profile = requireControlledProfile(profileId);
  return {
    id: 'openrouter-controlled',
    kind: 'api',
    gate: 'controlled-ablation',
    profile,
    requiredEnv: [KEY_ENV],
    validateCredentials() {
      return apiKey ? { ok: true, missing: [] } : { ok: false, missing: [KEY_ENV] };
    },
    /**
     * Null without credentials — a driver that cannot exist cannot spend.
     * A paid driver is never unbudgeted: absent a caller budget, the selected
     * profile's own trial ceiling is enforced.
     */
    createDriver({ budget = null, telemetry = null, maxTokens, fetchImpl } = {}) {
      if (!apiKey) return null;
      const effectiveBudget = budget ?? createBudget({
        ceilingUsd: profile.trialCeilingUsd,
        label: `openrouter-controlled-${profile.id}-trial`,
      });
      return openAiToolDriver({ profile, apiKey, budget: effectiveBudget, telemetry, maxTokens, fetchImpl });
    },
  };
}
