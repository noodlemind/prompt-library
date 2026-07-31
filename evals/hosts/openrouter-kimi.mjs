/**
 * Controlled API host: Kimi K2.7 Code via OpenRouter.
 *
 * The primary host-neutral experiment — the runner controls prompts, tools,
 * provider routing, token limits, telemetry, cost, and Harness activation.
 * Gates the release after the calibration period.
 */
import { openAiToolDriver } from '../lib/drivers.mjs';
import { getProfile } from '../lib/model-profiles.mjs';

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
    /** Null without credentials — a driver that cannot exist cannot spend. */
    createDriver({ budget = null, telemetry = null, maxTokens } = {}) {
      if (!apiKey) return null;
      return openAiToolDriver({ profile, apiKey, budget, telemetry, maxTokens });
    },
  };
}
