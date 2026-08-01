/**
 * Local model host: Gemma 4 26B via Ollama on the workstation.
 *
 * The local capability floor — free, credential-less, initially informational
 * (it does not gate a release unless local support becomes a product
 * guarantee). The provider bridge is a host-side Node subprocess; only its
 * terminal tool calls cross Harbor's container boundary. Ollama therefore
 * remains on the host loopback endpoint.
 */
import { openAiToolDriver } from '../lib/drivers.mjs';
import { getProfile } from '../lib/model-profiles.mjs';

export function createHost() {
  const profile = getProfile('gemma-4-26b-local');
  return {
    id: 'ollama-gemma',
    kind: 'api',
    gate: 'informational',
    profile,
    requiredEnv: [],
    validateCredentials() {
      return { ok: true, missing: [] };
    },
    createDriver({ budget = null, telemetry = null, maxTokens } = {}) {
      return openAiToolDriver({ profile, apiKey: 'ollama', budget, telemetry, maxTokens });
    },
  };
}
