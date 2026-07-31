/**
 * Controlled API host: Kimi K2.7 Code via OpenRouter.
 *
 * The primary host-neutral experiment — the runner controls prompts, tools,
 * provider routing, token limits, telemetry, cost, and Harness activation.
 * Gates the release after the calibration period.
 */
import { openAiToolDriver } from '../lib/drivers.mjs';
import { getProfile } from '../lib/model-profiles.mjs';
import { createBudget } from '../lib/budget.mjs';

const KEY_ENV = 'OPENROUTER_API_KEY';

export function createHost({ apiKey = process.env[KEY_ENV] } = {}) {
  const profile = getProfile('kimi-k2.7-code');
  return {
    id: 'openrouter-kimi',
    kind: 'api',
    gate: 'after-calibration',
    profile,
    requiredEnv: [KEY_ENV],
    validateCredentials() {
      return apiKey ? { ok: true, missing: [] } : { ok: false, missing: [KEY_ENV] };
    },
    /**
     * Null without credentials — a driver that cannot exist cannot spend.
     * A paid driver is never unbudgeted: absent a caller budget, the
     * profile's own trial ceiling is enforced.
     */
    createDriver({ budget = null, telemetry = null, maxTokens, fetchImpl } = {}) {
      if (!apiKey) return null;
      const effectiveBudget = budget ?? createBudget({ ceilingUsd: profile.trialCeilingUsd, label: 'openrouter-kimi-trial' });
      return openAiToolDriver({ profile, apiKey, budget: effectiveBudget, telemetry, maxTokens, fetchImpl });
    },
  };
}
