/**
 * Frontier rotation host: Claude Code on the Claude Max subscription.
 *
 * The same host-level A/B contract as the Codex adapter, run on rotation:
 * Claude Code without Engineer Harness, then the same Claude model with it.
 * Uses the existing Max subscription rather than paying for the model through
 * OpenRouter, so it captures the real user experience without API spend.
 * Telemetry the host does not expose is recorded as null — never estimated.
 */
import fs from 'node:fs';
import path from 'node:path';

const TELEMETRY_FIELDS = [
  'premiumRequestsConsumed',
  'rateLimitEvents',
  'hostReportedPromptTokens',
  'hostReportedOutputTokens',
  'hostReportedModel',
  'fallbackObserved',
];

const NUMERIC_FIELDS = new Set([
  'premiumRequestsConsumed',
  'rateLimitEvents',
  'hostReportedPromptTokens',
  'hostReportedOutputTokens',
]);

export function createHost() {
  return {
    id: 'claude-subscription',
    kind: 'subscription',
    gate: 'scheduled-rotation',
    runInstructions: [
      'Run the pinned Terminal-Bench task in Claude Code WITHOUT Engineer Harness (baseline).',
      'Run the same task with the same Claude model WITH Engineer Harness (treatment), in a fresh sandbox.',
      'Record the exact resolved model for each run — subscriptions can silently change versions.',
      'Preserve both transcripts; record subscription rate-limit events where visible.',
      'Never numerically mix this host A/B with the neutral OpenRouter result.',
    ],
    telemetryTemplate() {
      return Object.fromEntries(TELEMETRY_FIELDS.map((f) => [f, null]));
    },
    /** Keep usable fields; anything absent or malformed stays null. */
    normalizeHostReport(raw = {}) {
      const report = this.telemetryTemplate();
      for (const field of TELEMETRY_FIELDS) {
        const value = raw[field];
        if (value == null) continue;
        if (NUMERIC_FIELDS.has(field)) {
          if (typeof value === 'number' && Number.isFinite(value)) report[field] = value;
        } else if (field === 'fallbackObserved') {
          if (typeof value === 'boolean') report[field] = value;
        } else if (typeof value === 'string' && value) {
          report[field] = value;
        }
      }
      return report;
    },
    preserveTranscript({ transcript, dir, label = 'run' }) {
      const file = path.join(dir, `${this.id}-${label}-transcript.txt`);
      fs.writeFileSync(file, transcript);
      return file;
    },
  };
}
