/**
 * Frontier subscription host: GPT-5.3-Codex via ChatGPT Pro.
 *
 * Subscription hosts cannot be driven through a controlled API, so this
 * adapter defines the manual A/B contract: what the operator runs, what gets
 * recorded, and the hard rule that telemetry the host does not expose is
 * recorded as null — never silently estimated. The Codex host's own agent
 * scaffolding is present in both conditions; this A/B measures the
 * incremental value of Engineer Harness on top of it, and is never mixed
 * numerically with the OpenRouter result.
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
    id: 'codex-subscription',
    kind: 'subscription',
    gate: 'scheduled-rotation',
    runInstructions: [
      'Run the pinned Terminal-Bench task in Codex WITHOUT Engineer Harness (baseline).',
      'Run the same task with the same Codex model WITH Engineer Harness (treatment), in a fresh sandbox.',
      'Record the exact resolved model for each run — do not assume the subscription resolves to the same version.',
      'Preserve both transcripts; record premium requests consumed and any rate-limit events where visible.',
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
