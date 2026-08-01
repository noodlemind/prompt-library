/**
 * Cost calculation and budget enforcement for paid eval runs.
 *
 * The plan's cost controls, in code: before every provider request the caller
 * prechecks a worst-case estimate (uncached input + maximum output tokens)
 * against every ceiling in the budget chain (trial → release); a refusal is
 * recorded as a `budget_exhausted` event and the request is never sent.
 * Cost of real usage is computed from provider-reported token counts only —
 * missing or malformed usage yields `null`, never a silent estimate.
 *
 * Pricing units are USD per million tokens ({ inputPerM, cachedInputPerM,
 * outputPerM }), matching `model-profiles.mjs`.
 */

const PER_TOKEN = 1 / 1_000_000;

function nonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Provider-reported usage → cost plus an honest cache-detail completeness marker. */
export function costOfUsage(usage, pricing) {
  if (!usage || !nonNegativeInt(usage.prompt_tokens) || !nonNegativeInt(usage.completion_tokens)) return null;
  const promptTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const reportedCached = usage.prompt_tokens_details?.cached_tokens;
  const cachedTokensComplete = nonNegativeInt(reportedCached) && reportedCached <= promptTokens;
  const cachedTokensForCost = cachedTokensComplete ? reportedCached : 0;
  const usd =
    (promptTokens - cachedTokensForCost) * pricing.inputPerM * PER_TOKEN +
    cachedTokensForCost * pricing.cachedInputPerM * PER_TOKEN +
    outputTokens * pricing.outputPerM * PER_TOKEN;
  return {
    usd,
    promptTokens,
    cachedTokens: cachedTokensComplete ? cachedTokensForCost : null,
    cachedTokensComplete,
    outputTokens,
  };
}

/** Worst case for the next request: all input uncached, output at its maximum. */
export function estimateRequestCostUsd({ promptTokens, maxOutputTokens }, pricing) {
  return promptTokens * pricing.inputPerM * PER_TOKEN + maxOutputTokens * pricing.outputPerM * PER_TOKEN;
}

/** Conservative prompt-size guess when no tokenizer is available (~4 chars/token). */
export function estimateTokensForChars(chars) {
  return Math.ceil(chars / 4);
}

/**
 * A ceiling with an audit trail. `parent` chains a trial budget under the
 * release budget: charges propagate up, and precheck must clear every level.
 */
export function createBudget({ ceilingUsd, label = 'budget', parent = null } = {}) {
  // A cost cap that fails open is worse than none: refuse to construct.
  if (!(typeof ceilingUsd === 'number' && Number.isFinite(ceilingUsd)) || ceilingUsd < 0) {
    throw new Error(`budget ceilingUsd must be a non-negative number, got ${ceilingUsd}`);
  }
  let spent = 0;
  let knownSpent = 0;
  let uncertainReserved = 0;
  let exhausted = false;
  let breached = false;
  const events = [];

  const budget = {
    label,
    ceilingUsd,
    get exhausted() {
      return exhausted;
    },
    get breached() {
      return breached;
    },
    spentUsd: () => spent,
    knownReconciledSpendUsd: () => knownSpent,
    uncertainReservedUsd: () => uncertainReserved,
    accountedExposureUsd: () => spent,
    overrunUsd: () => Number(Math.max(0, spent - ceilingUsd).toFixed(12)),
    remainingUsd: () => Math.max(0, ceilingUsd - spent),
    events: () => events.slice(),
    /** Would spending `estimateUsd` cross this ceiling or any parent's? */
    precheck(estimateUsd) {
      if (!(typeof estimateUsd === 'number' && Number.isFinite(estimateUsd)) || estimateUsd < 0) {
        exhausted = true;
        const reason = `budget_exhausted: ${label} received an invalid request estimate`;
        events.push({ type: 'budget_invalid_estimate', label, ceilingUsd, spentUsd: spent });
        return { allowed: false, reason };
      }
      if (spent + estimateUsd > ceilingUsd) {
        exhausted = true;
        const reason = `budget_exhausted: ${label} ceiling $${ceilingUsd} would be crossed (spent $${spent.toFixed(4)}, next up to $${estimateUsd.toFixed(4)})`;
        events.push({ type: 'budget_exhausted', label, ceilingUsd, spentUsd: spent, estimateUsd });
        return { allowed: false, reason };
      }
      if (parent) {
        const up = parent.precheck(estimateUsd);
        if (!up.allowed) {
          // The refusal is the parent's, but this budget is done too: flag it
          // and record the event locally so its own audit trail is complete.
          exhausted = true;
          events.push({ type: 'budget_exhausted', label, ceilingUsd, spentUsd: spent, estimateUsd, via: parent.label });
          return up;
        }
      }
      return { allowed: true, reason: '' };
    },
    /** Record real spend. `null`/undefined (unusable usage) charges nothing. */
    charge(usd, note = '') {
      if (usd == null) return;
      if (!(typeof usd === 'number' && Number.isFinite(usd)) || usd < 0) {
        throw new Error(`budget charge must be a non-negative number, got ${usd}`);
      }
      spent += usd;
      knownSpent += usd;
      events.push({ type: 'charge', label, usd, note, spentUsd: spent });
      if (spent > ceilingUsd) {
        breached = true;
        exhausted = true;
        events.push({
          type: 'budget_breach',
          label,
          ceilingUsd,
          spentUsd: spent,
          overrunUsd: Number((spent - ceilingUsd).toFixed(12)),
          note,
        });
      }
      parent?.charge(usd, note);
    },
    /**
     * Conservatively consume allowance whose billing outcome is unknown without
     * misreporting that exposure as known provider spend.
     */
    reserve(usd, note = '') {
      if (usd == null) return;
      if (!(typeof usd === 'number' && Number.isFinite(usd)) || usd < 0) {
        throw new Error(`budget reserve must be a non-negative number, got ${usd}`);
      }
      spent += usd;
      uncertainReserved += usd;
      events.push({ type: 'reserve', label, usd, note, spentUsd: spent, uncertainReservedUsd: uncertainReserved });
      if (spent > ceilingUsd) {
        breached = true;
        exhausted = true;
        events.push({
          type: 'budget_breach',
          label,
          ceilingUsd,
          spentUsd: spent,
          overrunUsd: Number((spent - ceilingUsd).toFixed(12)),
          note,
        });
      }
      parent?.reserve(usd, note);
    },
  };
  return budget;
}
