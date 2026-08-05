export const ECONOMIC_PHASES = Object.freeze([
  'memory-retrieval',
  'memory-construction',
  'memory-consolidation',
  'guidance',
  'planning-and-gate',
  'verification',
  'orientation',
  'implementation',
  'finalization',
  'uncategorized',
  'mixed',
  'unknown',
]);

export const MEMORY_ECONOMIC_PHASES = Object.freeze([
  'memory-retrieval',
  'memory-construction',
  'memory-consolidation',
]);

export const TASK_EXECUTION_ECONOMIC_PHASES = Object.freeze(
  ECONOMIC_PHASES.filter((phase) => !MEMORY_ECONOMIC_PHASES.includes(phase))
);

/** Authoritative provider-ledger usage field to economic evidence field map. */
export const SOURCE_USAGE_TO_ECONOMIC_FIELD = Object.freeze({
  promptTokens: 'promptTokens',
  cachedTokens: 'cachedPromptTokens',
  reasoningTokens: 'reasoningTokens',
  outputTokens: 'outputTokens',
  localCostUsd: 'localCostUsd',
  providerCostUsd: 'providerReportedCostUsd',
  reconciledCostUsd: 'reconciledCostUsd',
});

export const ECONOMIC_PHASE_FIELDS = Object.freeze(
  Object.values(SOURCE_USAGE_TO_ECONOMIC_FIELD)
);

/** Closed mapping from driver lifecycle sources to economic attribution. */
export const CONTEXT_SOURCE_TO_ECONOMIC_PHASE = Object.freeze({
  'memory-retrieval': 'memory-retrieval',
  'memory-construction': 'memory-construction',
  'memory-consolidation': 'memory-consolidation',
  'guidance-retrieval': 'guidance',
  // A checkpoint constructs compact durable state for later turns/runs, so
  // its write-path cost belongs to memory construction.
  'durable-state': 'memory-construction',
  'planning-and-gate': 'planning-and-gate',
  verification: 'verification',
  orient: 'orientation',
  plan: 'planning-and-gate',
  gate: 'planning-and-gate',
  verify: 'verification',
  edit: 'implementation',
  test: 'verification',
  inspect: 'orientation',
  finish: 'finalization',
  finalization: 'finalization',
  other: 'uncategorized',
  invalid: 'unknown',
  unknown: 'unknown',
});

export function economicPhaseForContextSource(contextSource) {
  if (typeof contextSource !== 'string' ||
      !Object.hasOwn(CONTEXT_SOURCE_TO_ECONOMIC_PHASE, contextSource)) {
    return 'unknown';
  }
  return CONTEXT_SOURCE_TO_ECONOMIC_PHASE[contextSource];
}
