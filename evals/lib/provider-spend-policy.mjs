const SHA256_HEX = /^[a-f0-9]{64}$/i;

function finiteNonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function normalizedKeyFingerprint(value) {
  return SHA256_HEX.test(String(value ?? '')) ? String(value).toLowerCase() : null;
}

/**
 * Project one evaluation mode into the provider cash-limit evidence it needs.
 * This is the single executable definition shared by preflight, release
 * revalidation, and persisted-baseline validation.
 */
export function providerSpendPolicy({
  evaluationMode,
  ceilingUsd,
  hardLimitUsd,
  expectedQualificationFingerprint = null,
} = {}) {
  const continuityRequired = ['qualification', 'calibration'].includes(evaluationMode);
  const expectedFingerprint = normalizedKeyFingerprint(expectedQualificationFingerprint);
  const errors = [];
  if (typeof evaluationMode !== 'string' || evaluationMode.length === 0) {
    errors.push('provider evaluation mode is missing or invalid');
  }
  if (!finiteNonnegative(ceilingUsd)) errors.push('scheduled ceiling is missing or invalid');
  if (!finiteNonnegative(hardLimitUsd)) errors.push('provider hard limit is missing or invalid');
  if (finiteNonnegative(ceilingUsd) && finiteNonnegative(hardLimitUsd) && hardLimitUsd < ceilingUsd) {
    errors.push('provider hard limit is below the scheduled ceiling');
  }
  if (evaluationMode === 'calibration' && expectedFingerprint == null) {
    errors.push('accepted qualification credential fingerprint is missing');
  }
  return Object.freeze({
    ok: errors.length === 0,
    evaluationMode: typeof evaluationMode === 'string' && evaluationMode.length > 0
      ? evaluationMode
      : null,
    ceilingUsd: finiteNonnegative(ceilingUsd) ? ceilingUsd : null,
    hardLimitUsd: finiteNonnegative(hardLimitUsd) ? hardLimitUsd : null,
    continuityRequired,
    requireFreshAllowance: evaluationMode !== 'calibration',
    expectedQualificationFingerprint: expectedFingerprint,
    errors: Object.freeze(errors),
  });
}

/**
 * Normalize legacy config at its single compatibility boundary. Older pure
 * callers supplied only a release ceiling, so they retain the exact-ceiling,
 * fresh-key policy. A configured hard limit keeps qualification/calibration
 * continuity semantics. Downstream evidence evaluation receives this resolved
 * policy and performs no further mode or hard-limit fallback.
 */
export function resolveProviderSpendPolicy({
  evaluationMode = 'release',
  ceilingUsd,
  configuredHardLimitUsd = null,
  expectedQualificationFingerprint = null,
} = {}) {
  const hasConfiguredHardLimit = configuredHardLimitUsd !== null && configuredHardLimitUsd !== undefined;
  const continuityMode = hasConfiguredHardLimit && ['qualification', 'calibration'].includes(evaluationMode);
  const compatibilityFallback = !hasConfiguredHardLimit;
  const resolved = providerSpendPolicy({
    evaluationMode: continuityMode ? evaluationMode : 'release',
    ceilingUsd,
    hardLimitUsd: compatibilityFallback ? ceilingUsd : configuredHardLimitUsd,
    expectedQualificationFingerprint: continuityMode ? expectedQualificationFingerprint : null,
  });
  return Object.freeze({
    ...resolved,
    requestedEvaluationMode: evaluationMode,
    hardLimitSource: compatibilityFallback ? 'legacy-release-ceiling' : 'configured',
    compatibilityFallback,
  });
}

export function evaluateProviderSpendEvidence({
  policy = null,
  keyFingerprint = null,
  observed = {},
} = {}) {
  const resolvedPolicy = policy ?? providerSpendPolicy();
  const limitUsd = finiteNonnegative(observed?.limitUsd) ? observed.limitUsd : null;
  const limitRemainingUsd = finiteNonnegative(observed?.limitRemainingUsd)
    ? observed.limitRemainingUsd
    : null;
  const fingerprint = normalizedKeyFingerprint(keyFingerprint);
  const noReset = observed?.reset === null;
  const limitMatches = resolvedPolicy.hardLimitUsd != null && limitUsd === resolvedPolicy.hardLimitUsd;
  const allowanceMatches = resolvedPolicy.requireFreshAllowance
    ? limitRemainingUsd != null && limitRemainingUsd === resolvedPolicy.hardLimitUsd
    : limitRemainingUsd != null && limitRemainingUsd <= resolvedPolicy.hardLimitUsd &&
      limitRemainingUsd + 1e-9 >= resolvedPolicy.ceilingUsd;
  const fingerprintMatches = !resolvedPolicy.continuityRequired || (
    fingerprint != null && (
      resolvedPolicy.expectedQualificationFingerprint == null ||
      fingerprint === resolvedPolicy.expectedQualificationFingerprint
    )
  );
  const verified = resolvedPolicy.ok && limitMatches && allowanceMatches && noReset && fingerprintMatches;
  const observedKeyConsumedUsd = limitUsd != null && limitRemainingUsd != null
    ? Math.max(0, Number((limitUsd - limitRemainingUsd).toFixed(12)))
    : null;
  return {
    ok: verified,
    reason: verified
      ? null
      : resolvedPolicy.evaluationMode === 'calibration'
        ? 'calibration must reuse the qualification credential under the same dedicated no-reset provider limit with enough remaining allowance'
        : 'provider limit must use a fresh dedicated no-reset key capped exactly at the configured hard limit',
    policy: resolvedPolicy,
    evidence: {
      verified,
      required: true,
      limitUsd,
      limitRemainingUsd,
      reset: observed?.reset ?? null,
      ceilingUsd: resolvedPolicy.ceilingUsd,
      hardLimitUsd: resolvedPolicy.hardLimitUsd,
      keyFingerprint: fingerprint,
      observedKeyConsumedUsd,
    },
  };
}
