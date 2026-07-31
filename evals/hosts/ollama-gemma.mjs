/**
 * Local model host: Gemma 4 26B via Ollama on the workstation.
 *
 * The local capability floor — free, credential-less, initially informational
 * (it does not gate a release unless local support becomes a product
 * guarantee). When the agent runs inside a Docker task container, the Ollama
 * endpoint must be reached through host.docker.internal.
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
    /** The profile endpoint as reachable from inside a Docker task container. */
    urlForDockerContainer() {
      return profile.url.replace('localhost', 'host.docker.internal');
    },
    createDriver({ budget = null, telemetry = null, maxTokens } = {}) {
      return openAiToolDriver({ profile, apiKey: 'ollama', budget, telemetry, maxTokens });
    },
  };
}
