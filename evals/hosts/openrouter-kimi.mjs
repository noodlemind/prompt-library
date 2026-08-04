/** Historical adapter for evidence and callers that identify the Kimi lane. */
import { createHost as createControlledHost } from './openrouter-controlled.mjs';

const KIMI_PROFILE_ID = 'kimi-k2.7-code';

export function createHost(options = {}) {
  const host = createControlledHost({ ...options, profileId: KIMI_PROFILE_ID });
  return { ...host, id: 'openrouter-kimi' };
}
