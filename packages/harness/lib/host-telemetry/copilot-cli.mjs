/**
 * GitHub Copilot CLI host-usage adapter (stub).
 *
 * Present so the seam covers every supported host. Returns no host events until
 * the Copilot CLI exposes a confirmed token-usage log; the report degrades to
 * harness estimates in the meantime.
 */
export function collect() {
  return [];
}
