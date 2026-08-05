#!/usr/bin/env node
/**
 * Release evaluation orchestrator (dev/CI tooling — not a shipped command).
 *
 * Runs the plan's release-candidate sequence: deterministic evals first (free,
 * always), then — only when preflight is clean — the paid A/B pairs, smokes,
 * gate policy, and reporting. Every decision surface is an exported pure(ish)
 * function driven by injected steps, so the whole pipeline is testable without
 * a provider, a sandbox, or a dollar:
 *
 *   node evals/release.mjs --profile release-canary --qualification --budget-usd 1.3 \
 *     --report-file /private/eval/qualification.json
 *   node evals/release.mjs --profile release-canary --calibration --budget-usd 18.7 \
 *     --qualification-baseline /private/eval/qualification.json \
 *     --report-file /private/eval/calibration.json
 *
 * Exit code is non-zero only for genuinely blocking results (§9).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { costOfUsage, createBudget } from './lib/budget.mjs';
import { billingProfileHash, getProfile } from './lib/model-profiles.mjs';
import { validateControlledProfile } from './hosts/openrouter-controlled.mjs';
import {
  evaluateProviderSpendEvidence,
  normalizedKeyFingerprint,
  providerSpendPolicy,
  resolveProviderSpendPolicy,
} from './lib/provider-spend-policy.mjs';
import {
  ECONOMIC_PHASES,
  MEMORY_ECONOMIC_PHASES,
  ECONOMIC_PHASE_FIELDS,
} from './lib/economic-phases.mjs';
import { canonicalSha256, protocolDocumentHash } from './runtime/protocol.mjs';
import { controlledProviderBrokerStaticPolicyHash } from './runtime/controlled-provider-policy.mjs';
import {
  isRuntimeControllerReadiness,
  isRuntimeSessionFinal,
} from './runtime/session-controller.mjs';

export const MAX_RELEASE_API_USD = 20;
export const MAX_QUALIFICATION_API_USD = 1.3;
export const MAX_CALIBRATION_API_USD = 18.7;
export const MAX_ROUTINE_API_USD = 10;
const DEFAULT_EFFICIENCY_THRESHOLDS = { promptRatio: 2, costRatio: 1.5, wallTimeRatio: 1.25 };
const RELEASE_TRUST_CAPABILITIES = [
  'fullHarborRuntimeClosureAttested',
  'keyBearingToolchainIsolated',
  'sandboxEntryChainAttested',
  'mountsObservedFromTrustedSupervisor',
  'escapedProcessesAndContainersReaped',
  'imageResourcesAndNetworkObserved',
];
const RUNTIME_CONTROLLER_CAPABILITIES = [
  'perTrialSandboxRequired',
  'wholeSandboxDeletionRequired',
  'authenticatedSupervisorEvidenceRequired',
  'exactBudgetReconciliationRequired',
];

function configuredReleaseTrust(config) {
  const configuredCapabilities = config?.releaseTrust?.capabilities ?? {};
  const missing = RELEASE_TRUST_CAPABILITIES.filter((name) => configuredCapabilities[name] !== true);
  return {
    statusAttested: config?.releaseTrust?.status === 'attested',
    configuredCapabilities,
    missing,
  };
}

/**
 * A code-owned configuration may arm construction of the external runtime,
 * but it is never final release evidence. Final trust remains blocked until
 * the branded session final, retained trials, deletion receipts, and provider
 * reconciliation all bind to this invocation.
 */
export function releaseRuntimeArmingVerdict(config) {
  const configured = configuredReleaseTrust(config);
  const ok = configured.statusAttested && configured.missing.length === 0;
  return {
    ok,
    status: ok ? 'armed' : 'blocked',
    configuredStatus: configured.statusAttested ? 'attested' : 'blocked',
    requiredCapabilities: RELEASE_TRUST_CAPABILITIES.slice(),
    missingCapabilities: configured.missing.slice(),
    reason: !configured.statusAttested
      ? 'release trust kill switch is blocked'
      : configured.missing.length > 0
        ? 'configured release trust capabilities are incomplete'
        : null,
  };
}

export function runtimeReadinessVerdict(config, observedEvidence = null, {
  releaseSha = null,
} = {}) {
  const configured = configuredReleaseTrust(config);
  const missingReadiness = RUNTIME_CONTROLLER_CAPABILITIES.filter((name) => observedEvidence?.[name] !== true);
  const identityValid = typeof observedEvidence?.sessionId === 'string' && observedEvidence.sessionId.length > 0 &&
    /^[a-f0-9]{40,64}$/.test(String(observedEvidence?.releaseSha ?? '')) &&
    (releaseSha == null || observedEvidence.releaseSha === releaseSha);
  const evidenceValid = isRuntimeControllerReadiness(observedEvidence) &&
    observedEvidence.schema === 'engineer-runtime-controller-readiness.v1' &&
    observedEvidence.source === 'external-controller' &&
    observedEvidence.runtimeAttested === false && observedEvidence.providerAuthorized === false &&
    identityValid && missingReadiness.length === 0;
  const ok = configured.statusAttested && configured.missing.length === 0 && evidenceValid;
  return {
    ok,
    status: ok ? 'armed' : 'blocked',
    configuredStatus: configured.statusAttested ? 'attested' : 'blocked',
    evidenceSource: observedEvidence?.source ?? null,
    readinessHash: evidenceValid ? canonicalSha256(observedEvidence) : null,
    sessionId: evidenceValid ? observedEvidence.sessionId : null,
    releaseSha: evidenceValid ? observedEvidence.releaseSha : null,
    runtimeAttested: false,
    providerAuthorized: false,
    requiredCapabilities: RUNTIME_CONTROLLER_CAPABILITIES.slice(),
    missingCapabilities: [...new Set([...configured.missing, ...missingReadiness])],
    reason: !configured.statusAttested
      ? 'release trust kill switch is blocked'
      : configured.missing.length > 0
        ? 'configured release trust capabilities are incomplete'
        : !identityValid
          ? 'controller readiness identity binding is invalid'
          : missingReadiness.length > 0
            ? 'controller readiness capabilities are incomplete'
            : evidenceValid
              ? null
              : 'controller readiness was not issued by the in-process runtime controller',
  };
}

function sameHashMultiset(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  if (![...left, ...right].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) return false;
  return isDeepStrictEqual(left.slice().sort(), right.slice().sort());
}

export function releaseTrustVerdict(config, observedEvidence = null, {
  releaseSha = null,
  expectedTrialHashes = null,
  expectedSessionId = null,
  expectedBindings = null,
  expectedSessionCeilingMicrousd = null,
} = {}) {
  const configured = configuredReleaseTrust(config);
  const orderedTrialHashes = Array.isArray(observedEvidence?.trials)
    ? observedEvidence.trials.map((trial) => trial?.trialAttestationHash)
    : [];
  const deletionReceiptHashes = Array.isArray(observedEvidence?.trials)
    ? observedEvidence.trials.map((trial) => trial?.deletionReceiptHash)
    : [];
  const finalizedTrialsAttested = orderedTrialHashes.length > 0 &&
    orderedTrialHashes.every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) &&
    deletionReceiptHashes.length === orderedTrialHashes.length &&
    deletionReceiptHashes.every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) &&
    new Set(orderedTrialHashes).size === orderedTrialHashes.length;
  const sessionIdValid = typeof observedEvidence?.sessionId === 'string' && observedEvidence.sessionId.length > 0 &&
    (expectedSessionId == null || observedEvidence.sessionId === expectedSessionId);
  const identityValid = sessionIdValid &&
    /^[a-f0-9]{40,64}$/.test(String(observedEvidence?.sessionBindings?.releaseSha ?? '')) &&
    (releaseSha == null || observedEvidence.sessionBindings.releaseSha === releaseSha);
  const bindingFields = [
    'releaseSha', 'profileId', 'taskLockHash', 'bundleHash', 'budgetId', 'budgetPolicyHash',
    'brokerPolicyHash',
  ];
  const bindingsMatched = expectedBindings == null || (
    expectedBindings != null && typeof expectedBindings === 'object' &&
    bindingFields.every((field) => observedEvidence?.sessionBindings?.[field] === expectedBindings[field])
  );
  const sessionBudgetMatched = expectedSessionCeilingMicrousd == null || (
    Number.isSafeInteger(expectedSessionCeilingMicrousd) && expectedSessionCeilingMicrousd > 0 &&
    observedEvidence?.budget?.sessionCeilingMicrousd === expectedSessionCeilingMicrousd
  );
  const trialEvidenceMatched = expectedTrialHashes == null || sameHashMultiset(orderedTrialHashes, expectedTrialHashes);
  const evidenceAttested = isRuntimeSessionFinal(observedEvidence) &&
    observedEvidence.schema === 'engineer-runtime-session-final-attestation.v1' &&
    identityValid && bindingsMatched && sessionBudgetMatched && finalizedTrialsAttested && trialEvidenceMatched &&
    typeof observedEvidence.chainHead === 'string' && /^[a-f0-9]{64}$/.test(observedEvidence.chainHead) &&
    typeof observedEvidence.evidenceArchiveHash === 'string' && /^[a-f0-9]{64}$/.test(observedEvidence.evidenceArchiveHash);
  // Configuration remains only a kill switch. The private module brand can
  // exist only after signed per-trial evidence, cleanup, external deletion,
  // and exact session reconciliation have all succeeded.
  const missing = RELEASE_TRUST_CAPABILITIES.filter((name) =>
    configured.configuredCapabilities[name] !== true || !evidenceAttested
  );
  const ok = configured.statusAttested && evidenceAttested && missing.length === 0;
  return {
    ok,
    status: ok ? 'attested' : 'blocked',
    configuredStatus: configured.statusAttested ? 'attested' : 'blocked',
    evidenceSource: evidenceAttested ? 'runtime-observed' : null,
    evidenceHash: evidenceAttested ? protocolDocumentHash(observedEvidence) : null,
    sessionId: evidenceAttested ? observedEvidence.sessionId : null,
    finalizedTrialsAttested: evidenceAttested,
    trialEvidenceMatched,
    sessionIdMatched: sessionIdValid,
    bindingsMatched,
    sessionBudgetMatched,
    orderedTrialHashes: evidenceAttested ? orderedTrialHashes.slice() : [],
    deletionReceiptHashes: evidenceAttested ? deletionReceiptHashes.slice() : [],
    chainHead: evidenceAttested ? observedEvidence.chainHead : null,
    evidenceArchiveHash: evidenceAttested ? observedEvidence.evidenceArchiveHash : null,
    requiredCapabilities: RELEASE_TRUST_CAPABILITIES.slice(),
    missingCapabilities: missing,
  };
}

export function providerReconciliationVerdict(observedEvidence = null, {
  expectedSessionSpentMicrousd = null,
  runtimeSessionSpentMicrousd = expectedSessionSpentMicrousd,
  retainedTrialSpentMicrousd = runtimeSessionSpentMicrousd,
  schedulerSpentMicrousd = runtimeSessionSpentMicrousd,
} = {}) {
  const boundedInteger = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000_000
    ? value
    : null;
  const projected = {
    schema: observedEvidence?.schema === 'engineer-release-provider-reconciliation.v1'
      ? observedEvidence.schema
      : null,
    verified: false,
    keyFingerprint: typeof observedEvidence?.keyFingerprint === 'string' &&
      /^[a-f0-9]{64}$/.test(observedEvidence.keyFingerprint)
      ? observedEvidence.keyFingerprint
      : null,
    preflightRemainingMicrousd: boundedInteger(observedEvidence?.preflightRemainingMicrousd),
    postflightRemainingMicrousd: boundedInteger(observedEvidence?.postflightRemainingMicrousd),
    observedAllowanceDeltaMicrousd: boundedInteger(observedEvidence?.observedAllowanceDeltaMicrousd),
    sessionSpentMicrousd: boundedInteger(observedEvidence?.sessionSpentMicrousd),
    differenceMicrousd: boundedInteger(observedEvidence?.differenceMicrousd),
    toleranceMicrousd: boundedInteger(observedEvidence?.toleranceMicrousd),
    runtimeSessionSpentMicrousd: boundedInteger(runtimeSessionSpentMicrousd),
    retainedTrialSpentMicrousd: boundedInteger(retainedTrialSpentMicrousd),
    schedulerSpentMicrousd: boundedInteger(schedulerSpentMicrousd),
    runtimeRetainedSchedulerMatched: false,
    reason: 'missing-or-malformed',
  };
  const complete = projected.schema != null && projected.keyFingerprint != null &&
    [
      projected.preflightRemainingMicrousd,
      projected.postflightRemainingMicrousd,
      projected.observedAllowanceDeltaMicrousd,
      projected.sessionSpentMicrousd,
      projected.differenceMicrousd,
      projected.toleranceMicrousd,
    ].every((value) => value != null);
  if (!complete || observedEvidence?.verified !== true) return projected;
  if (projected.observedAllowanceDeltaMicrousd !==
      projected.preflightRemainingMicrousd - projected.postflightRemainingMicrousd ||
      projected.differenceMicrousd !== Math.abs(
        projected.observedAllowanceDeltaMicrousd - projected.sessionSpentMicrousd
      )) {
    return { ...projected, reason: 'allowance-arithmetic-mismatch' };
  }
  if (projected.differenceMicrousd > projected.toleranceMicrousd) {
    return { ...projected, reason: 'tolerance-exceeded' };
  }
  const totalsComplete = [
    projected.runtimeSessionSpentMicrousd,
    projected.retainedTrialSpentMicrousd,
    projected.schedulerSpentMicrousd,
  ].every((value) => value != null);
  const totalsMatched = totalsComplete &&
    projected.runtimeSessionSpentMicrousd === projected.retainedTrialSpentMicrousd &&
    projected.runtimeSessionSpentMicrousd === projected.schedulerSpentMicrousd &&
    projected.sessionSpentMicrousd === projected.runtimeSessionSpentMicrousd;
  if (!totalsMatched) {
    return { ...projected, reason: 'session-spend-mismatch' };
  }
  return {
    ...projected,
    verified: true,
    runtimeRetainedSchedulerMatched: true,
    reason: 'verified',
  };
}

function roundedMicrousd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const microusd = Math.round(value * 1_000_000);
  return Number.isSafeInteger(microusd) && microusd <= 10_000_000_000 &&
    Math.abs(value - microusd / 1_000_000) <= 1e-12
    ? microusd
    : null;
}

function summedRuntimeTrialSpendMicrousd(trials) {
  if (!Array.isArray(trials) || trials.length === 0) return null;
  let total = 0;
  for (const trial of trials) {
    const spend = trial?.observability?.runtimeTrustEvidence?.providerSpendMicrousd;
    if (!Number.isSafeInteger(spend) || spend < 0 || spend > 20_000_000) return null;
    total += spend;
    if (!Number.isSafeInteger(total) || total > 10_000_000_000) return null;
  }
  return total;
}

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('./schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const REPORT_SCHEMA = JSON.parse(fs.readFileSync(new URL('./schema/eval-report.v2.schema.json', import.meta.url), 'utf8'));

function taskIdentityProjection(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => (entry != null && typeof entry === 'object' ? entry : {}))
    .map(({ task = null, taskChecksum = null, role = null, sandbox = null }) => ({
      task,
      taskChecksum,
      role,
      sandbox,
    }))
    .sort((left, right) => String(left.task).localeCompare(String(right.task)));
}

/** Resolve the controlled release role without coupling it to one model name. */
export function controlledLaneOf(config = {}) {
  if (config?.controlledLane == null) {
    throw new Error('controlledLane is required; historical Kimi compatibility must be selected explicitly');
  }
  return {
    host: config.controlledLane.host,
    profileId: config.controlledLane.profileId,
  };
}

function controlledPairAllowanceOf(budget = {}) {
  const hasNeutral = Object.hasOwn(budget, 'controlledPairUsd');
  const hasLegacy = Object.hasOwn(budget, 'kimiPairUsd');
  if (hasNeutral && hasLegacy) {
    throw new Error('budget cannot define both controlledPairUsd and legacy kimiPairUsd');
  }
  if (!hasNeutral && !hasLegacy) {
    throw new Error('budget.controlledPairUsd is required (legacy kimiPairUsd is accepted only for compatibility)');
  }
  return {
    key: hasNeutral ? 'controlledPairUsd' : 'kimiPairUsd',
    value: hasNeutral ? budget.controlledPairUsd : budget.kimiPairUsd,
  };
}

/* ---------------------------------------------------------------- schema -- */

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Minimal JSON-Schema subset validator (type incl. null unions, required,
 * properties, items, const, enum, numeric minimum) — enough to hold the eval-run/eval-report
 * contracts without adding a dependency. Returns { ok, errors } with dotted
 * paths.
 */
export function validateAgainstSchema(value, schema, path = '', rootSchema = schema) {
  const errors = [];
  const at = (key) => (path ? `${path}.${key}` : key);
  if (typeof schema?.$ref === 'string') {
    if (!schema.$ref.startsWith('#/')) {
      return { ok: false, errors: [`${path || '$'}: unsupported schema reference ${schema.$ref}`] };
    }
    const target = schema.$ref.slice(2).split('/').reduce(
      (current, segment) => current?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')],
      rootSchema
    );
    if (target == null) return { ok: false, errors: [`${path || '$'}: unresolved schema reference ${schema.$ref}`] };
    return validateAgainstSchema(value, target, path, rootSchema);
  }
  if ('const' in schema && value !== schema.const) {
    errors.push(`${path || '$'}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path || '$'}: expected one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}`);
  }
  if (schema.type) {
    const allowed = [].concat(schema.type);
    const matches = allowed.some((expected) => expected === 'integer'
      ? typeof value === 'number' && Number.isInteger(value)
      : expected === typeName(value));
    if (!matches) {
      errors.push(`${path || '$'}: expected ${allowed.join('|')}, got ${typeName(value)}`);
    }
  }
  if (typeof value === 'number' && 'minimum' in schema && (!Number.isFinite(value) || value < schema.minimum)) {
    errors.push(`${path || '$'}: expected minimum ${schema.minimum}, got ${JSON.stringify(value)}`);
  }
  if (typeName(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at(key)}: missing required field`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validateAgainstSchema(value[key], sub, at(key), rootSchema).errors);
    }
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(value)) {
      if (known.has(key)) continue;
      if (schema.additionalProperties === false) errors.push(`${at(key)}: unexpected field`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(value[key], schema.additionalProperties, at(key), rootSchema).errors);
      }
    }
  }
  if (typeName(value) === 'array' && schema.items) {
    value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, at(String(i)), rootSchema).errors));
  }
  if (typeName(value) === 'array' && Number.isInteger(schema.minItems) && value.length < schema.minItems) {
    errors.push(`${path || '$'}: expected at least ${schema.minItems} items`);
  }
  if (schema.if && validateAgainstSchema(value, schema.if, path, rootSchema).ok && schema.then) {
    errors.push(...validateAgainstSchema(value, schema.then, path, rootSchema).errors);
  }
  return { ok: errors.length === 0, errors };
}

export function calibrationBaselineVerdict(report, {
  evidenceHash = null,
  releaseSha = null,
  harnessVersion = null,
  requiredTaskSet = [],
  minimumRepetitions = 3,
  minimumHarnessSolvedTasks = 1,
  efficiencyThresholds = DEFAULT_EFFICIENCY_THRESHOLDS,
  valueThresholds = {},
  controlledArmCeilingUsd = null,
  controlledLane = null,
  expectedProviderHardLimitUsd = null,
  expectedProviderKeyFingerprint = null,
  maximumCalibrationUsd = MAX_CALIBRATION_API_USD,
  verifierPassingReward = 1,
} = {}) {
  const reasons = [];
  const note = (reason) => reasons.push(reason);
  const schema = validateAgainstSchema(report, REPORT_SCHEMA);
  if (!schema.ok) note('calibration report does not satisfy eval-report.v2');
  if (!SHA256_HEX.test(String(evidenceHash ?? ''))) note('calibration report digest is missing');
  if (report?.calibrationRelease !== true || report?.evaluationScope?.mode !== 'calibration') {
    note('report is not a calibration run');
  }
  if (report?.evaluationScope?.trust?.ok !== true) note('calibration runtime trust was not attested');
  if (report?.preflight?.ok !== true) note('calibration preflight was not complete');
  if (report?.telemetryComplete !== true) note('calibration telemetry was incomplete');
  if (report?.coverage?.complete !== true) note('calibration task coverage was incomplete');
  if (report?.deterministic?.failed !== 0 || report?.gate?.block !== false || report?.readiness?.ready !== true ||
      (report?.smokes ?? []).some((smoke) => smoke?.ok !== true)) {
    note('calibration overall gate, readiness, deterministic suite, or compatibility smoke did not pass');
  }
  if (report?.budget?.breached === true || report?.budget?.billingUncertain === true) {
    note('calibration billing evidence was unsafe or incomplete');
  }
  if (!Number.isFinite(report?.budget?.ceilingUsd) ||
      report.budget.ceilingUsd > maximumCalibrationUsd + 1e-12) {
    note('calibration exceeded its declared cost ceiling');
  }
  const providerGuard = report?.budget?.providerSpendGuard ?? {};
  const providerKeyFingerprint = normalizedKeyFingerprint(providerGuard.keyFingerprint);
  if (expectedProviderHardLimitUsd != null) {
    const acceptedQualificationFingerprint = normalizedKeyFingerprint(expectedProviderKeyFingerprint);
    const providerPolicy = providerSpendPolicy({
      evaluationMode: 'calibration',
      ceilingUsd: report?.budget?.ceilingUsd,
      hardLimitUsd: expectedProviderHardLimitUsd,
      expectedQualificationFingerprint: acceptedQualificationFingerprint,
    });
    const guardReconciles = providerGuard.verified === true && evaluateProviderSpendEvidence({
      policy: providerPolicy,
      keyFingerprint: providerKeyFingerprint,
      observed: providerGuard,
    }).ok && report?.qualificationBaseline?.providerKeyFingerprint === acceptedQualificationFingerprint;
    if (!guardReconciles) {
      note('calibration did not retain the qualification provider key under the shared hard limit');
    }
  }
  if (releaseSha && report?.releaseSha !== releaseSha) note('calibration release identity does not match');
  if (harnessVersion && report?.harnessVersion !== harnessVersion) note('calibration Harness version does not match');
  const expectedTasks = taskIdentityProjection(requiredTaskSet);
  const observedTasks = taskIdentityProjection(report?.task?.requiredTaskSet ?? report?.task?.taskSet);
  if (!isDeepStrictEqual(observedTasks, expectedTasks)) note('calibration task identities do not match');
  const controlledHost = controlledLane?.host ?? report?.controlledLane?.host;
  const controlled = (report?.pairs ?? []).filter((pair) => pair?.host === controlledHost);
  const observedControlledTasks = controlled.map((pair) => pair.task).sort();
  if (!isDeepStrictEqual(observedControlledTasks, expectedTasks.map((entry) => entry.task).sort())) {
    note('calibration controlled denominator does not match');
  }
  const retainedTrials = controlled.flatMap((pair) => [
    pair?.generic,
    pair?.harness,
    pair?.rerun?.generic,
    pair?.rerun?.harness,
  ].filter(Boolean).flatMap((doc) => rawTrials(doc)));
  const retainedCosts = retainedTrials.map((trial) => trial?.efficiency?.reconciledCostUsd);
  if (retainedTrials.some((trial) => !verifierEvidenceConsistent(trial, verifierPassingReward))) {
    note('calibration retained verifier verdict does not match the locked passing reward');
  }
  const retainedExposureUsd = retainedCosts.length > 0 && retainedCosts.every((value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  ) ? retainedCosts.reduce((sum, value) => sum + value, 0) : null;
  const sameRetainedExposure = (value) => typeof value === 'number' && Number.isFinite(value) &&
    retainedExposureUsd != null && Math.abs(value - retainedExposureUsd) <= 1e-9;
  const calibrationBudgetReconciles = retainedExposureUsd != null &&
    report?.budget?.chargeLedgerMatchesRetainedEvidence === true &&
    report?.budget?.billingUncertain === false && report?.budget?.uncertainReservedUsd === 0 &&
    sameRetainedExposure(report?.budget?.knownReconciledSpendUsd) &&
    sameRetainedExposure(report?.budget?.retainedReconciledSpendUsd) &&
    sameRetainedExposure(report?.budget?.accountedExposureUsd) &&
    sameRetainedExposure(report?.budget?.spentUsd) &&
    typeof report?.budget?.ceilingUsd === 'number' &&
    retainedExposureUsd <= report.budget.ceilingUsd + 1e-9;
  if (!calibrationBudgetReconciles) {
    note('calibration exposure does not reconcile to retained trial cost evidence');
  }
  if (retainedExposureUsd == null || retainedExposureUsd > maximumCalibrationUsd + 1e-12) {
    note('calibration retained trial costs exceeded the declared cost ceiling');
  }
  let controlledWins = 0;
  let harnessSolvedTasks = 0;
  for (const pair of controlled) {
    const taskEntry = expectedTasks.find((entry) => entry.task === pair?.task);
    const envelope = {
      host: pair?.host,
      task: pair?.task,
      pairId: pair?.pairId,
      repetitionCount: pair?.repetitionCount,
      failureKind: pair?.failureKind ?? null,
      generic: pair?.generic,
      harness: pair?.harness,
    };
    const identityOptions = {
      host: controlledHost,
      expectedProfileId: controlledLane?.profileId ?? null,
      releaseSha: report?.releaseSha,
      harnessVersion: report?.harnessVersion,
      expectedTask: pair?.task,
      expectedTaskRevision: report?.task?.datasetRef ?? null,
    expectedTaskHash: taskEntry?.taskChecksum ?? null,
    expectedSandbox: taskEntry?.sandbox ?? null,
    expectedVerifierPassingReward: verifierPassingReward,
    };
    const recomputedClassification = classifyPair(envelope, identityOptions);
    const recomputedEfficiency = efficiencyDelta(
      pair?.generic,
      pair?.harness,
      efficiencyThresholds,
      valueThresholds,
      verifierPassingReward
    );
    const recomputedOverhead = overheadAttribution(pair?.generic, pair?.harness);
    const recomputedAttribution = fullyAttributablePair(envelope, controlledHost, identityOptions) &&
      recomputedClassification.fallbackDetected !== true;
    const retainedTrials = [...rawTrials(pair?.generic), ...rawTrials(pair?.harness)];
    if (controlledArmCeilingUsd != null && retainedTrials.some((trial) =>
      trial?.reproducibility?.trialCeilingUsd !== controlledArmCeilingUsd
    )) {
      note(`calibration pair ${pair?.task ?? 'unknown'} used a different per-arm ceiling`);
    }
    if (!recomputedAttribution || pair?.causallyAttributable !== true || !pair.generic || !pair.harness) {
      note(`calibration pair ${pair?.task ?? 'unknown'} was not causally attributable`);
    }
    if (!Number.isInteger(pair?.repetitionCount) || pair.repetitionCount < minimumRepetitions) {
      note(`calibration pair ${pair?.task ?? 'unknown'} has fewer than ${minimumRepetitions} repetitions`);
    }
    if (recomputedClassification.pairedOutcomes.pairedRepetitions < minimumRepetitions) {
      note(`calibration pair ${pair?.task ?? 'unknown'} has fewer than ${minimumRepetitions} aligned valid repetitions`);
    }
    const calibrationOutcomes = recomputedClassification.pairedOutcomes.counts;
    if (calibrationOutcomes['harness-regression'] > 0 || calibrationOutcomes['inconclusive-capability'] > 0) {
      note(`calibration pair ${pair?.task ?? 'unknown'} did not pass every Harness repetition`);
    }
    if (!pair?.classification || pair.classification.safety === true || pair.classification.fallbackDetected === true ||
        recomputedClassification.safety === true || recomputedClassification.fallbackDetected === true ||
        pair?.result !== recomputedClassification.result) {
      note(`calibration pair ${pair?.task ?? 'unknown'} failed integrity requirements`);
    }
    if (!isDeepStrictEqual(pair?.classification, recomputedClassification) ||
        !isDeepStrictEqual(pair?.pairedOutcomes, recomputedClassification.pairedOutcomes) ||
        !isDeepStrictEqual(pair?.efficiencyDelta, recomputedEfficiency) ||
        !isDeepStrictEqual(pair?.overheadAttribution, recomputedOverhead)) {
      note(`calibration pair ${pair?.task ?? 'unknown'} retained summaries do not match raw repetitions`);
    }
    if (pair?.efficiencyDelta?.evidenceComplete !== true || recomputedEfficiency.evidenceComplete !== true) {
      note(`calibration pair ${pair?.task ?? 'unknown'} lacks complete paired efficiency evidence`);
    }
    if (!['harness-win', 'parity'].includes(recomputedClassification.result)) {
      note(`calibration pair ${pair?.task ?? 'unknown'} did not establish value or policy-clean parity`);
    }
    if (recomputedClassification.result === 'parity' && recomputedEfficiency.withinThresholds !== true) {
      note(`calibration pair ${pair?.task ?? 'unknown'} exceeded a worst-repetition overhead limit`);
    }
    if (recomputedClassification.result === 'harness-win') {
      controlledWins += 1;
      if (recomputedEfficiency.valueEconomics?.policyConfigured !== true ||
          recomputedEfficiency.valueEconomics.withinThresholds !== true) {
        note(`calibration pair ${pair?.task ?? 'unknown'} exceeded incremental value limits`);
      }
    }
    if (pair?.harness?.correctness?.verdict === 'pass') harnessSolvedTasks += 1;
  }
  if (controlledWins < 1) note('calibration did not demonstrate a controlled Harness win');
  if (harnessSolvedTasks < minimumHarnessSolvedTasks) {
    note(`calibration Harness solved ${harnessSolvedTasks} tasks; ${minimumHarnessSolvedTasks} required`);
  }
  return {
    required: true,
    valid: reasons.length === 0,
    evidenceHash: SHA256_HEX.test(String(evidenceHash ?? '')) ? String(evidenceHash).toLowerCase() : null,
    releaseSha: typeof report?.releaseSha === 'string' ? report.releaseSha : null,
    harnessVersion: typeof report?.harnessVersion === 'string' ? report.harnessVersion : null,
    minimumRepetitions,
    minimumHarnessSolvedTasks,
    controlledWins,
    harnessSolvedTasks,
    providerKeyFingerprint,
    accountedExposureUsd: retainedExposureUsd,
    reasons: [...new Set(reasons)],
  };
}

/**
 * Validate the one-task capability probe that must precede a paid calibration.
 * This is deliberately weaker than the release claim: either arm may establish
 * that the selected model can solve the task, but an all-fail result stops the
 * larger run as capability-inconclusive.
 */
export function qualificationBaselineVerdict(report, {
  evidenceHash = null,
  releaseSha = null,
  harnessVersion = null,
  controlledLane = null,
  qualificationTask = null,
  requiredTaskSet = [],
  requiredTaskRevision = null,
  maximumQualificationUsd = MAX_QUALIFICATION_API_USD,
  controlledArmCeilingUsd = null,
  expectedProviderHardLimitUsd = null,
  expectedProviderKeyFingerprint = null,
  verifierPassingReward = 1,
} = {}) {
  const reasons = [];
  const note = (reason) => reasons.push(reason);
  const lane = controlledLane ?? report?.controlledLane;
  const profileId = lane?.profileId;
  let expectedBillingHash = null;
  try {
    expectedBillingHash = billingProfileHash(profileId);
  } catch {
    note('qualification controlled model profile is unknown');
  }
  if (!validateAgainstSchema(report, REPORT_SCHEMA).ok) note('qualification report does not satisfy eval-report.v2');
  if (!SHA256_HEX.test(String(evidenceHash ?? ''))) note('qualification report digest is missing');
  if (report?.evaluationScope?.mode !== 'qualification') note('report is not a one-task qualification run');
  if (report?.evaluationScope?.trust?.ok !== true) note('qualification runtime trust was not attested');
  if (report?.preflight?.ok !== true) note('qualification preflight was not complete');
  if (report?.telemetryComplete !== true) note('qualification telemetry was incomplete');
  if (report?.coverage?.complete !== true) note('qualification task coverage was incomplete');
  if (releaseSha && report?.releaseSha !== releaseSha) note('qualification release identity does not match');
  if (harnessVersion && report?.harnessVersion !== harnessVersion) note('qualification Harness version does not match');
  if (report?.controlledLane?.host !== lane?.host || report?.controlledLane?.profileId !== profileId ||
      report?.controlledLane?.billingProfileHash !== expectedBillingHash) {
    note('qualification controlled lane identity does not match');
  }
  const selectedTasks = report?.task?.taskSet ?? [];
  const expectedTasks = taskIdentityProjection(requiredTaskSet);
  const lockedTaskEntry = expectedTasks.find((entry) => entry.task === qualificationTask) ?? null;
  if (selectedTasks.length !== 1 || selectedTasks[0]?.task !== qualificationTask) {
    note('qualification did not use the configured single task');
  }
  if (expectedTasks.length > 0) {
    const selectedProjection = taskIdentityProjection(selectedTasks);
    const requiredProjection = taskIdentityProjection(report?.task?.requiredTaskSet ?? []);
    if (!isDeepStrictEqual(selectedProjection, expectedTasks) ||
        !isDeepStrictEqual(requiredProjection, expectedTasks)) {
      note('qualification task identities do not match the current lock');
    }
  }
  if (report?.budget?.breached === true || report?.budget?.billingUncertain !== false) {
    note('qualification billing evidence was unsafe or incomplete');
  }
  if (maximumQualificationUsd != null && (!Number.isFinite(report?.budget?.ceilingUsd) ||
      report.budget.ceilingUsd > maximumQualificationUsd + 1e-12)) {
    note('qualification exceeded its declared cost ceiling');
  }

  const controlled = (report?.pairs ?? []).filter((pair) => pair?.host === lane?.host);
  if (controlled.length !== 1) note('qualification controlled denominator must contain exactly one pair');
  const pair = controlled[0] ?? null;
  const explicitTrials = (doc) => Array.isArray(doc?.repetitions) ? doc.repetitions : [];
  const genericTrials = explicitTrials(pair?.generic);
  const harnessTrials = explicitTrials(pair?.harness);
  if (genericTrials.length !== 1 || harnessTrials.length !== 1) {
    note('qualification requires exactly one retained raw repetition per arm');
  }
  const retainedTrials = [...genericTrials, ...harnessTrials];
  const retainedCosts = retainedTrials.map((trial) => trial?.efficiency?.reconciledCostUsd);
  const retainedExposureUsd = retainedCosts.length > 0 && retainedCosts.every((value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  ) ? retainedCosts.reduce((sum, value) => sum + value, 0) : null;
  const sameExposure = (value) => typeof value === 'number' && Number.isFinite(value) &&
    retainedExposureUsd != null && Math.abs(value - retainedExposureUsd) <= 1e-9;
  const providerGuard = report?.budget?.providerSpendGuard ?? {};
  const providerKeyFingerprint = normalizedKeyFingerprint(providerGuard.keyFingerprint);
  const qualificationProviderPolicy = expectedProviderHardLimitUsd == null
    ? null
    : providerSpendPolicy({
      evaluationMode: 'qualification',
      ceilingUsd: report?.budget?.ceilingUsd,
      hardLimitUsd: expectedProviderHardLimitUsd,
      expectedQualificationFingerprint: expectedProviderKeyFingerprint,
    });
  const providerContinuityReconciles = qualificationProviderPolicy == null ||
    evaluateProviderSpendEvidence({
      policy: qualificationProviderPolicy,
      keyFingerprint: providerKeyFingerprint,
      observed: providerGuard,
    }).ok;
  const budgetReconciles = retainedTrials.length === 2 && retainedExposureUsd != null &&
    report?.budget?.chargeLedgerMatchesRetainedEvidence === true &&
    report?.budget?.providerSpendGuard?.verified === true &&
    report?.budget?.providerSpendGuard?.reset === null &&
    report?.budget?.uncertainReservedUsd === 0 &&
    sameExposure(report?.budget?.knownReconciledSpendUsd) &&
    sameExposure(report?.budget?.retainedReconciledSpendUsd) &&
    sameExposure(report?.budget?.accountedExposureUsd) &&
    sameExposure(report?.budget?.spentUsd) && providerContinuityReconciles;
  if (!budgetReconciles) {
    note('qualification exposure does not reconcile to retained trial cost evidence');
  }
  if (!providerContinuityReconciles) {
    note('qualification provider key evidence does not match the fresh shared hard limit');
  }
  if (maximumQualificationUsd != null && (
    retainedExposureUsd == null || retainedExposureUsd > maximumQualificationUsd + 1e-12
  )) {
    note('qualification retained trial costs exceeded the declared cost ceiling');
  }
  const taskEntry = lockedTaskEntry ?? selectedTasks[0] ?? {};
  const identityOptions = {
    host: lane?.host,
    expectedProfileId: profileId,
    releaseSha: report?.releaseSha,
    harnessVersion: report?.harnessVersion,
    expectedTask: qualificationTask,
    expectedTaskRevision: requiredTaskRevision ?? report?.task?.datasetRef ?? null,
    expectedTaskHash: taskEntry.taskChecksum ?? null,
    expectedSandbox: taskEntry.sandbox ?? null,
    expectedVerifierPassingReward: verifierPassingReward,
  };
  const envelope = pair == null ? null : {
    host: pair.host,
    task: pair.task,
    pairId: pair.pairId,
    repetitionCount: pair.repetitionCount,
    failureKind: pair.failureKind ?? null,
    generic: pair.generic,
    harness: pair.harness,
  };
  const recomputedQualificationClassification = envelope == null
    ? null
    : classifyPair(envelope, identityOptions);
  const rawSafetyViolation = retainedTrials.some((trial) =>
    trial?.harnessBehavior?.policyBypassAchieved === true ||
    trial?.harnessBehavior?.unsafeWriteOutsideWorkspace === true
  );
  if (rawSafetyViolation || pair?.classification?.safety === true ||
      recomputedQualificationClassification?.safety === true) {
    note('qualification retained raw evidence contains a safety or policy bypass violation');
  }
  if (!envelope || pair?.repetitionCount !== 1 || pair?.causallyAttributable !== true ||
      !fullyAttributablePair(envelope, lane?.host, identityOptions) ||
      pair?.classification?.fallbackDetected === true) {
    note('qualification pair was not a complete same-model controlled comparison');
  }
  for (const doc of [pair?.generic, pair?.harness]) {
    for (const trial of explicitTrials(doc)) {
      const identity = trial?.reproducibility ?? {};
      if (identity.modelProfileId !== profileId || identity.billingProfileHash !== expectedBillingHash ||
          identity.host !== lane?.host || identity.attribution?.fallbackDetected === true) {
        note('qualification trial model or routing identity drifted');
      }
      if (controlledArmCeilingUsd != null && identity.trialCeilingUsd !== controlledArmCeilingUsd) {
        note('qualification trial used a different per-arm ceiling');
      }
    }
  }

  if (retainedTrials.some((trial) => !verifierEvidenceConsistent(trial, verifierPassingReward))) {
    note('qualification retained verifier verdict does not match the locked passing reward');
  }
  const genericPassed = genericTrials.length === 1 &&
    singleRetainedVerifierPass({ repetitions: genericTrials }, verifierPassingReward);
  const harnessPassed = harnessTrials.length === 1 &&
    singleRetainedVerifierPass({ repetitions: harnessTrials }, verifierPassingReward);
  if (!genericPassed && !harnessPassed) {
    note('neither arm produced a retained verifier pass; model capability is inconclusive');
  }
  const passingArm = genericPassed && harnessPassed
    ? 'both'
    : genericPassed
      ? 'generic'
      : harnessPassed
        ? 'harness'
        : null;
  const recomputedCapability = genericPassed || harnessPassed ? 'qualified' : 'inconclusive';
  if (report?.qualification?.capability !== recomputedCapability ||
      report?.qualification?.passingArm !== passingArm ||
      report?.qualification?.task !== qualificationTask) {
    note('qualification summary does not match retained verifier evidence');
  }
  return {
    required: true,
    valid: reasons.length === 0,
    capability: recomputedCapability,
    passingArm,
    evidenceHash: SHA256_HEX.test(String(evidenceHash ?? '')) ? String(evidenceHash).toLowerCase() : null,
    releaseSha: typeof report?.releaseSha === 'string' ? report.releaseSha : null,
    harnessVersion: typeof report?.harnessVersion === 'string' ? report.harnessVersion : null,
    controlledLane: lane == null ? null : {
      host: lane.host ?? null,
      profileId: profileId ?? null,
      billingProfileHash: expectedBillingHash,
    },
    task: qualificationTask,
    accountedExposureUsd: retainedExposureUsd,
    providerKeyFingerprint,
    reasons: [...new Set(reasons)],
  };
}

/* ---------------------------------------------------- pair classification -- */

function normalizeProviderName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function rawTrials(doc) {
  return Array.isArray(doc?.repetitions) && doc.repetitions.length > 0 ? doc.repetitions : doc ? [doc] : [];
}

function verifierEvidenceConsistent(trial, passingReward = 1) {
  const reward = trial?.correctness?.verifierReward;
  if (!(typeof passingReward === 'number' && Number.isFinite(passingReward)) ||
      !(typeof reward === 'number' && Number.isFinite(reward))) {
    return false;
  }
  const expectedVerdict = reward >= passingReward ? 'pass' : 'fail';
  return trial?.correctness?.verdict === expectedVerdict;
}

function singleRetainedVerifierPass(doc, passingReward = 1) {
  const trials = rawTrials(doc);
  return trials.length === 1 && verifierEvidenceConsistent(trials[0], passingReward) &&
    trials[0].correctness.verdict === 'pass';
}

function alignedValidTrialPairs(generic, harness, passingReward = 1) {
  const uniqueIndexed = (trials) => {
    const byIndex = new Map();
    const duplicates = new Set();
    for (const trial of trials) {
      const index = trial?.reproducibility?.repetitionIndex;
      if (!Number.isInteger(index) || index < 1) continue;
      if (byIndex.has(index)) duplicates.add(index);
      else byIndex.set(index, trial);
    }
    for (const index of duplicates) byIndex.delete(index);
    return byIndex;
  };
  const genericByIndex = uniqueIndexed(rawTrials(generic));
  const harnessByIndex = uniqueIndexed(rawTrials(harness));
  return [...genericByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([repetitionIndex, baseline]) => {
      const treatment = harnessByIndex.get(repetitionIndex);
      if (!treatment) return [];
      const comparable = [baseline, treatment].every((trial) =>
        trial?.trialValidity?.valid === true && trial?.trialValidity?.failureKind == null &&
        verifierEvidenceConsistent(trial, passingReward)
      );
      return comparable ? [{ repetitionIndex, generic: baseline, harness: treatment }] : [];
    });
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const PAIR_SCALAR_FIELDS = [
  'releaseSha',
  'harnessVersion',
  'taskId',
  'taskRevision',
  'taskHash',
  'bundleManifestHash',
  'instructionHash',
  'modelProfileId',
  'billingProfileHash',
  'pricingCatalogCheckedAt',
  'modelRequested',
  'modelResolved',
  'providerExpectedResolvedNames',
  'host',
  'runnerVersion',
  'sandbox',
  'pairId',
  'repetitionId',
  'repetitionIndex',
  'attempt',
];
const CROSS_REPETITION_FIELDS = [
  'releaseSha',
  'harnessVersion',
  'taskId',
  'taskRevision',
  'taskHash',
  'bundleManifestHash',
  'instructionHash',
  'modelProfileId',
  'billingProfileHash',
  'pricingCatalogCheckedAt',
  'modelRequested',
  'modelResolved',
  'providerExpectedResolvedNames',
  'host',
  'runnerVersion',
  'sandbox',
  'pairId',
  'attempt',
];
const CONDITION_REPETITION_FIELDS = [
  'conditionHash',
  'systemPromptHash',
  'toolSchemaHash',
  'harnessContentHash',
];

function normalizedProviderOrder(value) {
  return Array.isArray(value) ? value.map(normalizeProviderName) : null;
}

function pairIdentityVerdict(pair, {
  host = pair?.host,
  expectedProfileId = null,
  releaseSha = null,
  harnessVersion = null,
  expectedTask = pair?.task,
  expectedTaskRevision = null,
  expectedTaskHash = null,
  expectedSandbox = null,
} = {}) {
  const mismatches = [];
  const note = (field) => mismatches.push(field);
  let expectedProfile = null;
  if (expectedProfileId != null) {
    try {
      expectedProfile = getProfile(expectedProfileId);
    } catch {
      note('expected-profile');
    }
  }
  const genericTrials = rawTrials(pair?.generic);
  const harnessTrials = rawTrials(pair?.harness);
  if (!pair?.generic || !pair?.harness) note('arm-presence');
  if (genericTrials.length === 0 || genericTrials.length !== harnessTrials.length) note('repetition-count');
  const declaredRepetitions = pair?.repetitionCount ?? pair?.seedCount;
  if (!Number.isInteger(declaredRepetitions) || declaredRepetitions !== genericTrials.length) note('repetition-count-envelope');

  const indexed = (trials, condition) => {
    const map = new Map();
    for (const trial of trials) {
      const index = trial?.reproducibility?.repetitionIndex;
      if (!Number.isInteger(index) || index < 1 || map.has(index)) {
        note(`${condition}-repetition-index`);
        continue;
      }
      map.set(index, trial);
    }
    return map;
  };
  const genericByIndex = indexed(genericTrials, 'generic');
  const harnessByIndex = indexed(harnessTrials, 'harness');
  const expectedIndices = Array.from({ length: genericTrials.length }, (_, index) => index + 1);
  if (!isDeepStrictEqual([...genericByIndex.keys()].sort((a, b) => a - b), expectedIndices)) note('repetition-index-sequence');
  if (!isDeepStrictEqual([...harnessByIndex.keys()].sort((a, b) => a - b), expectedIndices)) note('repetition-index-sequence');
  const repetitionIds = genericTrials.map((trial) => trial?.reproducibility?.repetitionId);
  if (repetitionIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(repetitionIds).size !== repetitionIds.length) {
    note('repetition-id-uniqueness');
  }
  const firstIdentity = genericTrials[0]?.reproducibility ?? null;
  for (const trial of genericTrials) {
    const identity = trial?.reproducibility ?? {};
    for (const field of CROSS_REPETITION_FIELDS) {
      if (firstIdentity && !isDeepStrictEqual(identity[field], firstIdentity[field])) note(`cross-repetition-${field}`);
    }
    if (firstIdentity && !isDeepStrictEqual(
      normalizedProviderOrder(identity.providerRequestedOrder),
      normalizedProviderOrder(firstIdentity.providerRequestedOrder)
    )) note('cross-repetition-providerRequestedOrder');
    if (firstIdentity && normalizeProviderName(identity.providerResolved) !== normalizeProviderName(firstIdentity.providerResolved)) {
      note('cross-repetition-providerResolved');
    }
    if (firstIdentity && !isDeepStrictEqual(identity.reasoningConfig, firstIdentity.reasoningConfig)) {
      note('cross-repetition-reasoningConfig');
    }
  }
  for (const [condition, trials] of [['generic', genericTrials], ['harness', harnessTrials]]) {
    const first = trials[0]?.reproducibility ?? null;
    for (const trial of trials) {
      const identity = trial?.reproducibility ?? {};
      for (const field of CONDITION_REPETITION_FIELDS) {
        if (first && !isDeepStrictEqual(identity[field], first[field])) {
          note(`cross-repetition-${condition}-${field}`);
        }
      }
    }
  }

  for (const [index, generic] of genericByIndex) {
    const harness = harnessByIndex.get(index);
    if (!harness) {
      note('repetition-alignment');
      continue;
    }
    const genericIdentity = generic?.reproducibility ?? {};
    const harnessIdentity = harness?.reproducibility ?? {};
    for (const field of PAIR_SCALAR_FIELDS) {
      if (!isDeepStrictEqual(genericIdentity[field], harnessIdentity[field])) note(field);
    }
    if (!isDeepStrictEqual(
      normalizedProviderOrder(genericIdentity.providerRequestedOrder),
      normalizedProviderOrder(harnessIdentity.providerRequestedOrder)
    )) note('providerRequestedOrder');
    if (normalizeProviderName(genericIdentity.providerResolved) !== normalizeProviderName(harnessIdentity.providerResolved)) {
      note('providerResolved');
    }
    if (!isDeepStrictEqual(genericIdentity.reasoningConfig, harnessIdentity.reasoningConfig)) note('reasoningConfig');
    if (expectedProfile) {
      if (genericIdentity.modelProfileId !== expectedProfile.id) note('expected-profile-id');
      if (genericIdentity.billingProfileHash !== billingProfileHash(expectedProfile.id)) note('expected-billing-profile');
      if (genericIdentity.pricingCatalogCheckedAt !== (expectedProfile.catalogPin?.checkedAt ?? null)) {
        note('expected-pricing-catalog');
      }
      if (genericIdentity.modelRequested !== expectedProfile.model) note('expected-profile-model');
      if (!isDeepStrictEqual(
        normalizedProviderOrder(genericIdentity.providerRequestedOrder),
        normalizedProviderOrder(expectedProfile.provider?.order)
      )) note('expected-provider-order');
      if (!isDeepStrictEqual(
        normalizedProviderOrder(genericIdentity.providerExpectedResolvedNames),
        normalizedProviderOrder(expectedProfile.provider?.expectedResolvedNames)
      )) note('expected-provider-resolved-names');
      if (!isDeepStrictEqual(genericIdentity.reasoningConfig, expectedProfile.reasoning ?? null)) {
        note('expected-reasoning-config');
      }
      const allowedResolvedProviders = normalizedProviderOrder(expectedProfile.provider?.expectedResolvedNames) ?? [];
      if (normalizeProviderName(genericIdentity.providerResolved) &&
          !allowedResolvedProviders.includes(normalizeProviderName(genericIdentity.providerResolved))) {
        note('expected-resolved-provider');
      }
    }
    if (genericIdentity.condition !== 'generic' || harnessIdentity.condition !== 'harness') note('condition');
    const order = [genericIdentity.orderIndex, harnessIdentity.orderIndex].sort((a, b) => a - b);
    if (!isDeepStrictEqual(order, [1, 2])) note('orderIndex');
    if (!SHA256_HEX.test(String(genericIdentity.taskHash ?? ''))) note('taskHash-presence');
    if (!SHA256_HEX.test(String(genericIdentity.bundleManifestHash ?? ''))) note('bundleManifestHash-presence');
    if (!SHA256_HEX.test(String(genericIdentity.instructionHash ?? ''))) note('generic-instructionHash-presence');
    if (!SHA256_HEX.test(String(harnessIdentity.instructionHash ?? ''))) note('harness-instructionHash-presence');
    for (const field of ['conditionHash', 'systemPromptHash', 'toolSchemaHash']) {
      if (!SHA256_HEX.test(String(genericIdentity[field] ?? ''))) note(`generic-${field}-presence`);
      if (!SHA256_HEX.test(String(harnessIdentity[field] ?? ''))) note(`harness-${field}-presence`);
    }
    if (!SHA256_HEX.test(String(harnessIdentity.harnessContentHash ?? ''))) note('harnessContentHash-presence');
    if (!genericIdentity.pairId || !genericIdentity.repetitionId || !genericIdentity.attempt) note('trial-identity-presence');
    if (pair?.pairId && genericIdentity.pairId !== pair.pairId) note('pairId-envelope');
    if (expectedTask && genericIdentity.taskId !== expectedTask) note('expected-task');
    if (expectedTaskRevision && genericIdentity.taskRevision !== expectedTaskRevision) note('expected-task-revision');
    if (expectedTaskHash && genericIdentity.taskHash !== expectedTaskHash) note('expected-task-hash');
    if (expectedSandbox) {
      const observedSandbox = genericIdentity.sandbox;
      const lockedProjection = observedSandbox && {
        sourceImage: observedSandbox.sourceImage,
        immutableImage: observedSandbox.immutableImage,
        imageId: observedSandbox.imageId,
        platform: observedSandbox.platform,
        cpus: observedSandbox.cpus,
        memoryMb: observedSandbox.memoryMb,
        storageMb: observedSandbox.storageMb,
      };
      if (!isDeepStrictEqual(lockedProjection, expectedSandbox)) note('expected-sandbox');
      if (observedSandbox?.identityAttested !== true ||
          !SHA256_HEX.test(String(observedSandbox?.dockerExecutableHash ?? '')) ||
          observedSandbox?.observedImageId !== expectedSandbox.imageId ||
          observedSandbox?.observedPlatform !== expectedSandbox.platform ||
          !SHA256_HEX.test(String(observedSandbox?.executionTaskHash ?? ''))) {
        note('sandbox-attestation');
      }
    }
    if (host && genericIdentity.host !== host) note('expected-host');
    if (releaseSha && releaseSha !== 'unknown' && genericIdentity.releaseSha !== releaseSha) note('expected-release');
    if (harnessVersion && harnessVersion !== 'unknown' && genericIdentity.harnessVersion !== harnessVersion) note('expected-harness-version');
  }
  for (const index of harnessByIndex.keys()) if (!genericByIndex.has(index)) note('repetition-alignment');
  if (!pair?.task || (expectedTask && pair.task !== expectedTask)) note('task-envelope');
  if (!pair?.pairId) note('pairId-envelope');
  const unique = [...new Set(mismatches)].sort();
  return { ok: unique.length === 0, mismatches: unique };
}

function rerunIdentityVerdict(original, rerun, expected = {}) {
  const rerunPair = pairIdentityVerdict(rerun, expected);
  const mismatches = [...rerunPair.mismatches];
  const originalTrials = rawTrials(original?.generic);
  const rerunTrials = rawTrials(rerun?.generic);
  const originalIdentity = originalTrials[0]?.reproducibility ?? {};
  const rerunIdentity = rerunTrials[0]?.reproducibility ?? {};
  const invariantFields = [
    'releaseSha', 'harnessVersion', 'taskId', 'taskRevision', 'taskHash', 'bundleManifestHash',
    'instructionHash', 'modelRequested', 'modelResolved', 'providerExpectedResolvedNames', 'host', 'runnerVersion', 'sandbox',
  ];
  for (const field of invariantFields) {
    if (!isDeepStrictEqual(originalIdentity[field], rerunIdentity[field])) mismatches.push(`rerun-${field}`);
  }
  if (!isDeepStrictEqual(
    normalizedProviderOrder(originalIdentity.providerRequestedOrder),
    normalizedProviderOrder(rerunIdentity.providerRequestedOrder)
  )) mismatches.push('rerun-providerRequestedOrder');
  if (normalizeProviderName(originalIdentity.providerResolved) !== normalizeProviderName(rerunIdentity.providerResolved)) {
    mismatches.push('rerun-providerResolved');
  }
  if (!isDeepStrictEqual(originalIdentity.reasoningConfig, rerunIdentity.reasoningConfig)) mismatches.push('rerun-reasoningConfig');
  for (const condition of ['generic', 'harness']) {
    const originalCondition = rawTrials(original?.[condition])[0]?.reproducibility ?? {};
    const rerunCondition = rawTrials(rerun?.[condition])[0]?.reproducibility ?? {};
    for (const field of CONDITION_REPETITION_FIELDS) {
      if (!isDeepStrictEqual(originalCondition[field], rerunCondition[field])) {
        mismatches.push(`rerun-${condition}-${field}`);
      }
    }
  }
  if (original?.task !== rerun?.task) mismatches.push('rerun-task-envelope');
  const originalPairIds = new Set(rawTrials(original?.generic).map((trial) => trial?.reproducibility?.pairId).filter(Boolean));
  const rerunPairIds = new Set(rerunTrials.map((trial) => trial?.reproducibility?.pairId).filter(Boolean));
  if ([...rerunPairIds].some((pairId) => originalPairIds.has(pairId))) mismatches.push('rerun-fresh-pairId');
  const originalRepetitionIds = new Set(
    rawTrials(original?.generic).map((trial) => trial?.reproducibility?.repetitionId).filter(Boolean)
  );
  const rerunRepetitionIds = new Set(rerunTrials.map((trial) => trial?.reproducibility?.repetitionId).filter(Boolean));
  if ([...rerunRepetitionIds].some((repetitionId) => originalRepetitionIds.has(repetitionId))) {
    mismatches.push('rerun-fresh-repetitionId');
  }
  const originalAttempts = new Set(rawTrials(original?.generic).map((trial) => trial?.reproducibility?.attempt).filter(Boolean));
  const rerunAttempts = new Set(rerunTrials.map((trial) => trial?.reproducibility?.attempt).filter(Boolean));
  if ([...rerunAttempts].some((attempt) => originalAttempts.has(attempt))) mismatches.push('rerun-fresh-attempt');
  const unique = [...new Set(mismatches)].sort();
  return { ok: unique.length === 0, mismatches: unique };
}

function trialAttribution(doc, { requireProvider = false } = {}) {
  const reproducibility = doc?.reproducibility ?? {};
  const responses = (doc?.observability?.providerEvents ?? []).filter((event) => event?.type === 'response');
  const fallbackEvents = (doc?.observability?.providerEvents ?? []).filter((event) => event?.type === 'fallback');
  const requestedModel = reproducibility.modelRequested;
  const requestedProviders = Array.isArray(reproducibility.providerRequestedOrder)
    ? reproducibility.providerRequestedOrder.map(normalizeProviderName).filter(Boolean)
    : [];
  const expectedResolvedProviders = Array.isArray(reproducibility.providerExpectedResolvedNames)
    ? reproducibility.providerExpectedResolvedNames.map(normalizeProviderName).filter(Boolean)
    : requestedProviders;
  const modelComplete = typeof reproducibility.modelResolved === 'string' && reproducibility.modelResolved.length > 0;
  const providerComplete = !requireProvider || (
    typeof reproducibility.providerResolved === 'string' &&
    reproducibility.providerResolved.length > 0 &&
    requestedProviders.length > 0
  );
  const responseCountComplete =
    responses.length > 0 &&
    responses.length === doc?.efficiency?.providerResponses;
  const responseIdentityComplete = responses.every((response) =>
    typeof response.model === 'string' && response.model.length > 0 &&
    (!requireProvider || (typeof response.provider === 'string' && response.provider.length > 0))
  );
  const modelMismatch =
    (modelComplete && reproducibility.modelResolved !== requestedModel) ||
    responses.some((response) => response.model !== requestedModel);
  const providerMismatch = requireProvider && requestedProviders.length > 0 && (
    (providerComplete && !expectedResolvedProviders.includes(normalizeProviderName(reproducibility.providerResolved))) ||
    responses.some((response) => !expectedResolvedProviders.includes(normalizeProviderName(response.provider)))
  );
  const declaredFallback = reproducibility.attribution?.fallbackDetected === true;
  return {
    complete:
      modelComplete &&
      providerComplete &&
      responseCountComplete &&
      responseIdentityComplete &&
      reproducibility.attribution?.complete !== false,
    contaminated: declaredFallback || fallbackEvents.length > 0 || modelMismatch || providerMismatch,
  };
}

function runAttribution(doc, options) {
  const trials = rawTrials(doc);
  const attribution = trials.map((trial) => trialAttribution(trial, options));
  return {
    complete: trials.length > 0 && attribution.every((entry) => entry.complete),
    contaminated: attribution.some((entry) => entry.contaminated),
  };
}

function summarizeRun(doc, { requireProvider = false } = {}) {
  const attribution = runAttribution(doc, { requireProvider });
  const trials = rawTrials(doc);
  return {
    // Anything that is not an explicit pass counts as a fail here; a malformed
    // verdict is additionally caught by schema validation and blocks the gate.
    verdict: doc?.correctness?.verdict === 'pass' ? 'pass' : 'fail',
    budgetExhausted: doc?.correctness?.completedWithinBudget === false ||
      trials.some((trial) => trial?.correctness?.completedWithinBudget === false),
    safety: doc?.harnessBehavior?.policyBypassAchieved === true ||
      trials.some((trial) => trial?.harnessBehavior?.policyBypassAchieved === true),
    fallback: attribution.contaminated,
    attributionComplete: attribution.complete,
  };
}

function pairedOutcomeDistribution(pair, { requireProvider = false, passingReward = 1 } = {}) {
  const outcomes = [];
  for (const { repetitionIndex, generic: genericTrial, harness: harnessTrial } of
    alignedValidTrialPairs(pair?.generic, pair?.harness, passingReward)) {
    const generic = summarizeRun(genericTrial, { requireProvider });
    const harness = summarizeRun(harnessTrial, { requireProvider });
    const key = `${generic.verdict}/${harness.verdict}`;
    const result = {
      'fail/pass': 'harness-win',
      'pass/pass': 'parity',
      'pass/fail': 'harness-regression',
      'fail/fail': 'inconclusive-capability',
    }[key];
    outcomes.push({ repetitionIndex, result });
  }
  const counts = {
    'harness-win': 0,
    parity: 0,
    'harness-regression': 0,
    'inconclusive-capability': 0,
  };
  for (const outcome of outcomes) counts[outcome.result] += 1;
  const majorityRequired = Math.floor(outcomes.length / 2) + 1;
  const majorityResult = Object.entries(counts)
    .find(([, count]) => count >= majorityRequired)?.[0] ?? null;
  return {
    statistic: 'strict-majority-of-aligned-paired-outcomes',
    pairedRepetitions: outcomes.length,
    majorityRequired,
    counts,
    outcomes,
    majorityResult,
  };
}

/** The §8 result matrix with its precedence: safety, infrastructure, budget. */
export function classifyPair(pair, identityOptions = {}) {
  const requireProvider = String(pair.host ?? '').startsWith('openrouter');
  const generic = summarizeRun(pair.generic, { requireProvider });
  const harness = summarizeRun(pair.harness, { requireProvider });
  const identity = pairIdentityVerdict(pair, identityOptions);
  const fallbackDetected = generic.fallback || harness.fallback;
  const attributionComplete = generic.attributionComplete && harness.attributionComplete;
  const base = {
    safety: false,
    fallbackDetected,
    attributionComplete,
    identityAligned: identity.ok,
    identityMismatches: identity.mismatches,
    pairedOutcomes: pairedOutcomeDistribution(pair, {
      requireProvider,
      passingReward: identityOptions.expectedVerifierPassingReward ?? 1,
    }),
  };
  if (generic.safety || harness.safety) {
    return { ...base, safety: true, result: 'harness-regression', reason: 'a harness safety control was bypassed' };
  }
  if (pair.failureKind === 'budget') {
    return { ...base, result: 'inconclusive-budget', reason: 'a reconciled trial cost exceeded its preallocated budget' };
  }
  if (pair.failureKind) {
    // provider and verifier failures are invalid trials too — never "the
    // model wasn't capable".
    return { ...base, result: 'infrastructure-invalid', reason: `${pair.failureKind} failure invalidated the trial` };
  }
  if (!identity.ok) {
    return {
      ...base,
      result: 'infrastructure-invalid',
      reason: `controlled identity mismatch (${identity.mismatches.join(', ')})`,
    };
  }
  if (fallbackDetected) {
    return { ...base, result: 'infrastructure-invalid', reason: 'model or provider fallback contaminated the comparison' };
  }
  if (requireProvider && !attributionComplete) {
    return { ...base, result: 'infrastructure-invalid', reason: 'model or provider attribution is incomplete' };
  }
  if (generic.budgetExhausted || harness.budgetExhausted) {
    return { ...base, result: 'inconclusive-budget', reason: 'a condition exhausted its budget before completing' };
  }
  if (base.pairedOutcomes.pairedRepetitions === 0) {
    return {
      ...base,
      result: 'infrastructure-invalid',
      reason: 'no valid aligned paired repetition evidence was retained',
    };
  }
  const result = base.pairedOutcomes.majorityResult ?? 'mixed-inconclusive';
  const reasons = {
    'harness-win': 'a strict majority of aligned repetitions were baseline-fail/harness-pass',
    parity: 'a strict majority of aligned repetitions passed in both conditions; compare paired cost and efficiency',
    'harness-regression': 'a strict majority of aligned repetitions were baseline-pass/harness-fail',
    'inconclusive-capability': 'a strict majority of aligned repetitions failed in both conditions',
    'mixed-inconclusive': 'no paired outcome reached a strict majority; result variance is inconclusive',
  };
  const reason = reasons[result];
  return { ...base, result, reason };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ratio(candidate, baseline) {
  const numerator = finiteNumber(candidate);
  const denominator = finiteNumber(baseline);
  if (numerator == null || denominator == null || denominator < 0 || numerator < 0) return null;
  if (denominator === 0) return numerator === 0 ? 1 : null;
  return Number((numerator / denominator).toFixed(6));
}

function comparableCost(doc) {
  const efficiency = doc?.efficiency;
  if (!efficiency || efficiency.costComplete !== true || efficiency.billingUncertain === true) return null;
  const reconciledCost = finiteNumber(efficiency.reconciledCostUsd);
  const localCost = finiteNumber(efficiency.localCostUsd);
  const providerCost = efficiency.providerCostComplete === true
    ? finiteNumber(efficiency.providerReportedCostUsd)
    : null;
  const comparable = [reconciledCost, localCost, providerCost].filter((value) => value != null);
  return comparable.length ? Math.max(...comparable) : null;
}

function median(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function distribution(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return {
    values: finite,
    count: finite.length,
    min: finite.length ? Math.min(...finite) : null,
    median: median(finite),
    max: finite.length ? Math.max(...finite) : null,
  };
}

/**
 * Like-for-like Harness/baseline efficiency over aligned repetitions.
 * Ratios are calculated inside each pair before taking the median; taking two
 * independent arm medians and then dividing can reverse a result.
 */
export function efficiencyDelta(
  generic,
  harness,
  thresholds = DEFAULT_EFFICIENCY_THRESHOLDS,
  valueThresholds = {},
  passingReward = 1
) {
  const limits = { ...DEFAULT_EFFICIENCY_THRESHOLDS, ...(thresholds ?? {}) };
  const aligned = alignedValidTrialPairs(generic, harness, passingReward);
  const observations = aligned.map(({ repetitionIndex, generic: baseline, harness: treatment }) => {
    const genericCost = comparableCost(baseline);
    const harnessCost = comparableCost(treatment);
    const genericWall = finiteNumber(baseline?.efficiency?.wallTimeMs);
    const harnessWall = finiteNumber(treatment?.efficiency?.wallTimeMs);
    return {
      repetitionIndex,
      promptRatio: ratio(treatment?.efficiency?.promptTokens, baseline?.efficiency?.promptTokens),
      costRatio: ratio(harnessCost, genericCost),
      wallTimeRatio: ratio(harnessWall, genericWall),
      modelRequestRatio: ratio(treatment?.efficiency?.modelRequests, baseline?.efficiency?.modelRequests),
      providerAttemptRatio: ratio(treatment?.efficiency?.providerAttempts, baseline?.efficiency?.providerAttempts),
      additionalSuccesses: (treatment?.correctness?.verdict === 'pass' ? 1 : 0) -
        (baseline?.correctness?.verdict === 'pass' ? 1 : 0),
      incrementalApiCostUsd: genericCost == null || harnessCost == null ? null : harnessCost - genericCost,
      incrementalWallTimeMs: genericWall == null || harnessWall == null ? null : harnessWall - genericWall,
    };
  });
  const ratioDistribution = {
    promptRatio: distribution(observations.map((entry) => entry.promptRatio)),
    costRatio: distribution(observations.map((entry) => entry.costRatio)),
    wallTimeRatio: distribution(observations.map((entry) => entry.wallTimeRatio)),
    modelRequestRatio: distribution(observations.map((entry) => entry.modelRequestRatio)),
    providerAttemptRatio: distribution(observations.map((entry) => entry.providerAttemptRatio)),
  };
  const promptRatio = ratioDistribution.promptRatio.median;
  const costRatio = ratioDistribution.costRatio.median;
  const wallTimeRatio = ratioDistribution.wallTimeRatio.median;
  const modelRequestRatio = ratioDistribution.modelRequestRatio.median;
  const providerAttemptRatio = ratioDistribution.providerAttemptRatio.median;
  const breaches = [];
  // Medians are the point estimate; release gating is deliberately tail-safe.
  // With the small release sample, allowing one extreme repetition to disappear
  // behind a median would contradict the consistency/predictability claim.
  if (ratioDistribution.promptRatio.max != null && ratioDistribution.promptRatio.max > limits.promptRatio) breaches.push('promptRatio');
  if (ratioDistribution.costRatio.max != null && ratioDistribution.costRatio.max > limits.costRatio) breaches.push('costRatio');
  if (ratioDistribution.wallTimeRatio.max != null && ratioDistribution.wallTimeRatio.max > limits.wallTimeRatio) breaches.push('wallTimeRatio');
  const evidenceComplete = observations.length > 0 && observations.every((entry) =>
    entry.promptRatio != null && entry.costRatio != null && entry.wallTimeRatio != null
  );
  const additionalSuccesses = observations.reduce((sum, entry) => sum + entry.additionalSuccesses, 0);
  const incrementalCostComplete = observations.every((entry) => entry.incrementalApiCostUsd != null);
  const incrementalWallComplete = observations.every((entry) => entry.incrementalWallTimeMs != null);
  const incrementalApiCostUsd = incrementalCostComplete
    ? observations.reduce((sum, entry) => sum + entry.incrementalApiCostUsd, 0)
    : null;
  const incrementalWallTimeMs = incrementalWallComplete
    ? observations.reduce((sum, entry) => sum + entry.incrementalWallTimeMs, 0)
    : null;
  const maxCostPerSuccess = finiteNumber(valueThresholds.maxIncrementalApiCostPerAdditionalSuccessUsd);
  const maxWallPerSuccess = finiteNumber(valueThresholds.maxIncrementalWallTimePerAdditionalSuccessMs);
  const policyConfigured = maxCostPerSuccess != null && maxWallPerSuccess != null;
  const costPerAdditionalSuccessUsd = additionalSuccesses > 0 && incrementalApiCostUsd != null
    ? Math.max(0, incrementalApiCostUsd) / additionalSuccesses
    : null;
  const wallTimePerAdditionalSuccessMs = additionalSuccesses > 0 && incrementalWallTimeMs != null
    ? Math.max(0, incrementalWallTimeMs) / additionalSuccesses
    : null;
  const valueEvidenceComplete = additionalSuccesses > 0 &&
    costPerAdditionalSuccessUsd != null && wallTimePerAdditionalSuccessMs != null;
  const valueWithinThresholds = policyConfigured && valueEvidenceComplete &&
    costPerAdditionalSuccessUsd <= maxCostPerSuccess &&
    wallTimePerAdditionalSuccessMs <= maxWallPerSuccess;
  return {
    promptRatio,
    costRatio,
    wallTimeRatio,
    modelRequestRatio,
    providerAttemptRatio,
    pairedStatistic: 'median-of-aligned-repetition-ratios',
    gatingStatistic: 'maximum-of-aligned-repetition-ratios',
    pairedRepetitions: observations.length,
    ratioDistribution,
    thresholds: limits,
    evidenceComplete,
    withinThresholds: evidenceComplete && breaches.length === 0,
    breaches,
    valueEconomics: {
      additionalSuccesses,
      incrementalApiCostUsd,
      incrementalWallTimeMs,
      costPerAdditionalSuccessUsd,
      wallTimePerAdditionalSuccessMs,
      thresholds: {
        maxIncrementalApiCostPerAdditionalSuccessUsd: maxCostPerSuccess,
        maxIncrementalWallTimePerAdditionalSuccessMs: maxWallPerSuccess,
      },
      policyConfigured,
      evidenceComplete: valueEvidenceComplete,
      withinThresholds: additionalSuccesses > 0 ? valueWithinThresholds : null,
    },
  };
}

function requestFootprintSummary(doc) {
  const requests = rawTrials(doc).flatMap((trial) =>
    (trial?.observability?.providerEvents ?? []).filter((event) => event?.type === 'request')
  );
  const sum = (field) => requests.reduce(
    (total, event) => total + (Number.isFinite(event?.[field]) ? event[field] : 0),
    0
  );
  const roleNames = [...new Set(requests.flatMap((event) => Object.keys(event?.charsByRole ?? {})))].sort();
  const charsByRole = Object.fromEntries(roleNames.map((role) => [
    role,
    requests.reduce(
      (total, event) => total + (Number.isFinite(event?.charsByRole?.[role]) ? event.charsByRole[role] : 0),
      0
    ),
  ]));
  const payloadChars = sum('payloadChars');
  const recurringStaticChars = sum('baseSystemChars') + sum('instructionChars') + sum('toolSchemaChars');
  const durableStateChars = sum('durableStateChars');
  return {
    requestCount: requests.length,
    payloadChars,
    averagePayloadChars: requests.length ? payloadChars / requests.length : null,
    baseSystemChars: sum('baseSystemChars'),
    instructionChars: sum('instructionChars'),
    toolSchemaChars: sum('toolSchemaChars'),
    durableStateChars,
    recurringStaticChars,
    dynamicAndFramingChars: Math.max(0, payloadChars - recurringStaticChars),
    dynamicExcludingDurableChars: Math.max(0, payloadChars - recurringStaticChars - durableStateChars),
    charsByRole,
    complete: requests.length > 0 && requests.every((event) =>
      ['payloadChars', 'baseSystemChars', 'instructionChars', 'toolSchemaChars', 'durableStateChars']
        .every((field) => Number.isFinite(event?.[field]))
    ),
  };
}

/**
 * Non-gating tokenizer-independent explanation of prompt-volume growth.
 * The additive request-count/request-size split is exact in serialized chars;
 * component buckets exclude JSON framing and are therefore diagnostic, not a
 * provider-token invoice.
 */
export function overheadAttribution(generic, harness) {
  const baseline = requestFootprintSummary(generic);
  const treatment = requestFootprintSummary(harness);
  const requestCountEffectChars = baseline.averagePayloadChars == null
    ? null
    : (treatment.requestCount - baseline.requestCount) * baseline.averagePayloadChars;
  const requestSizeEffectChars = baseline.averagePayloadChars == null || treatment.averagePayloadChars == null
    ? null
    : treatment.requestCount * (treatment.averagePayloadChars - baseline.averagePayloadChars);
  return {
    semantics: 'serialized-request-characters; non-gating; not tokenizer tokens',
    complete: baseline.complete && treatment.complete,
    generic: baseline,
    harness: treatment,
    delta: {
      requestCount: treatment.requestCount - baseline.requestCount,
      payloadChars: treatment.payloadChars - baseline.payloadChars,
      baseSystemChars: treatment.baseSystemChars - baseline.baseSystemChars,
      instructionChars: treatment.instructionChars - baseline.instructionChars,
      toolSchemaChars: treatment.toolSchemaChars - baseline.toolSchemaChars,
      recurringStaticChars: treatment.recurringStaticChars - baseline.recurringStaticChars,
      dynamicAndFramingChars: treatment.dynamicAndFramingChars - baseline.dynamicAndFramingChars,
      dynamicExcludingDurableChars:
        treatment.dynamicExcludingDurableChars - baseline.dynamicExcludingDurableChars,
      durableStateChars: treatment.durableStateChars - baseline.durableStateChars,
      requestCountEffectChars,
      requestSizeEffectChars,
    },
  };
}

/* ----------------------------------------------------------------- budget -- */

/** Chained primary and one-fresh-pair allowances under one release ceiling. */
export function allocateReleaseBudgets(budget = {}) {
  const releaseCeilingUsd = budget.releaseCeilingUsd;
  const controlledPairUsd = controlledPairAllowanceOf(budget).value;
  const rerunUsd = budget.rerunUsd;
  for (const [label, value] of [
    ['budget.releaseCeilingUsd', releaseCeilingUsd],
    ['budget.controlledPairUsd', controlledPairUsd],
    ['budget.rerunUsd', rerunUsd],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${label} must be an explicitly configured finite number >= 0`);
    }
  }
  if (releaseCeilingUsd > MAX_CALIBRATION_API_USD) {
    throw new Error(`a single release evaluation may not exceed the $${MAX_CALIBRATION_API_USD} calibration ceiling`);
  }
  const release = createBudget({ ceilingUsd: releaseCeilingUsd, label: 'release' });
  const controlledPair = createBudget({ ceilingUsd: controlledPairUsd, label: 'controlled-pair', parent: release });
  const rerun = createBudget({ ceilingUsd: rerunUsd, label: 'controlled-rerun', parent: release });
  return {
    release,
    controlledPair,
    // Compatibility for historical callers and fixtures. This is the exact
    // same budget object, never a second allowance.
    kimiPair: controlledPair,
    rerun,
  };
}

/** Scale the planned child allowances when an operator raises the routine ceiling. */
export function scaleReleaseBudget(baseBudget, requestedCeilingUsd) {
  const baseCeiling = Number(baseBudget?.releaseCeilingUsd);
  if (!Number.isFinite(baseCeiling) || baseCeiling <= 0) throw new Error('base releaseCeilingUsd must be positive');
  if (!Number.isFinite(requestedCeilingUsd) || requestedCeilingUsd < 0 || requestedCeilingUsd > MAX_CALIBRATION_API_USD) {
    throw new Error(`release API budget must be between 0 and ${MAX_CALIBRATION_API_USD}`);
  }
  const scale = requestedCeilingUsd / baseCeiling;
  const scaled = (value) => Number((Number(value ?? 0) * scale).toFixed(6));
  const controlled = controlledPairAllowanceOf(baseBudget);
  return {
    releaseCeilingUsd: requestedCeilingUsd,
    [controlled.key]: scaled(controlled.value),
    rerunUsd: scaled(baseBudget.rerunUsd),
    ...(baseBudget.controlledArmCeilingUsd != null
      ? { controlledArmCeilingUsd: Number(baseBudget.controlledArmCeilingUsd) }
      : {}),
    ...(baseBudget.qualificationPairUsd != null
      ? { qualificationPairUsd: Number(baseBudget.qualificationPairUsd) }
      : {}),
    ...(baseBudget.calibrationCeilingUsd != null
      ? { calibrationCeilingUsd: Number(baseBudget.calibrationCeilingUsd) }
      : {}),
    ...(baseBudget.providerHardLimitUsd != null
      ? { providerHardLimitUsd: Number(baseBudget.providerHardLimitUsd) }
      : {}),
  };
}

export function releaseRepetitionCount(raw = {}, calibrationRelease = false) {
  const repetitions = raw?.repetitions ?? raw?.seeds;
  const count = calibrationRelease
    ? repetitions?.calibration ?? 3
    : repetitions?.routine ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${calibrationRelease ? 'calibration' : 'routine'} repetitions must be a positive integer`);
  }
  return count;
}

/** Worst-case scheduled provider exposure for one controlled task matrix. */
export function releaseScheduledExposure({
  taskCount,
  repetitions,
  controlledArmCeilingUsd,
  rerunEnabled = true,
} = {}) {
  if (!Number.isInteger(taskCount) || taskCount < 1) throw new Error('taskCount must be a positive integer');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('repetitions must be a positive integer');
  if (!Number.isFinite(controlledArmCeilingUsd) || controlledArmCeilingUsd <= 0) {
    throw new Error('controlledArmCeilingUsd must be a positive finite number');
  }
  return {
    primaryExposureUsd: controlledArmCeilingUsd * taskCount * repetitions * 2,
    rerunExposureUsd: rerunEnabled ? controlledArmCeilingUsd * 2 : 0,
  };
}

export function releaseMinimumCalibrationRepetitions(raw = {}) {
  const minimum = raw?.claimPolicy?.minimumCalibrationRepetitions ?? releaseRepetitionCount(raw, true);
  if (!Number.isInteger(minimum) || minimum < 2) {
    throw new Error('claimPolicy.minimumCalibrationRepetitions must be an integer >= 2');
  }
  return minimum;
}

export function validateReleasePolicyConfig(config) {
  const errors = [];
  const finiteAtLeast = (value, minimum, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) errors.push(`${label} must be a finite number >= ${minimum}`);
  };
  const budget = config?.budget ?? {};
  const claimMode = config?.claimPolicy?.mode ?? 'regression-gate';
  let controlledAllowance = null;
  try {
    controlledAllowance = controlledPairAllowanceOf(budget);
  } catch (error) {
    errors.push(error.message);
  }
  finiteAtLeast(budget.releaseCeilingUsd, 0, 'budget.releaseCeilingUsd');
  finiteAtLeast(controlledAllowance?.value, 0, `budget.${controlledAllowance?.key ?? 'controlledPairUsd'}`);
  finiteAtLeast(budget.rerunUsd, 0, 'budget.rerunUsd');
  if (budget.providerHardLimitUsd != null) {
    finiteAtLeast(budget.providerHardLimitUsd, 0, 'budget.providerHardLimitUsd');
  }
  if (budget.controlledArmCeilingUsd != null) {
    finiteAtLeast(budget.controlledArmCeilingUsd, 0, 'budget.controlledArmCeilingUsd');
    if (Number.isFinite(budget.controlledArmCeilingUsd) && budget.controlledArmCeilingUsd <= 0) {
      errors.push('budget.controlledArmCeilingUsd must be greater than zero');
    }
  }
  const stagedInitialEvidence = claimMode === 'initial-user-ship' && (
    config?.claimPolicy?.requireQualificationBaseline === true ||
    ['qualification', 'calibration'].includes(config?.evaluationScope?.mode)
  );
  if (stagedInitialEvidence) {
    finiteAtLeast(budget.qualificationPairUsd, 0, 'budget.qualificationPairUsd');
    finiteAtLeast(budget.calibrationCeilingUsd, 0, 'budget.calibrationCeilingUsd');
  } else {
    if (budget.qualificationPairUsd != null) finiteAtLeast(budget.qualificationPairUsd, 0, 'budget.qualificationPairUsd');
    if (budget.calibrationCeilingUsd != null) finiteAtLeast(budget.calibrationCeilingUsd, 0, 'budget.calibrationCeilingUsd');
  }
  const releaseModeCap = claimMode === 'initial-user-ship'
    ? MAX_CALIBRATION_API_USD
    : MAX_ROUTINE_API_USD;
  const providerModeCap = claimMode === 'initial-user-ship'
    ? MAX_RELEASE_API_USD
    : MAX_ROUTINE_API_USD;
  if (Number.isFinite(budget.releaseCeilingUsd) && budget.releaseCeilingUsd > releaseModeCap) {
    errors.push(`budget.releaseCeilingUsd must not exceed ${releaseModeCap} for ${claimMode}`);
  }
  if (Number.isFinite(budget.providerHardLimitUsd) && budget.providerHardLimitUsd > providerModeCap) {
    errors.push(`budget.providerHardLimitUsd must not exceed ${providerModeCap} for ${claimMode}`);
  }
  if (Number.isFinite(budget.qualificationPairUsd) &&
      budget.qualificationPairUsd > MAX_QUALIFICATION_API_USD) {
    errors.push(`budget.qualificationPairUsd must not exceed ${MAX_QUALIFICATION_API_USD}`);
  }
  if (Number.isFinite(budget.calibrationCeilingUsd) &&
      budget.calibrationCeilingUsd > MAX_CALIBRATION_API_USD) {
    errors.push(`budget.calibrationCeilingUsd must not exceed ${MAX_CALIBRATION_API_USD}`);
  }
  if (Number.isFinite(budget.providerHardLimitUsd) && Number.isFinite(budget.releaseCeilingUsd) &&
      budget.releaseCeilingUsd > budget.providerHardLimitUsd + 1e-12) {
    errors.push('budget.releaseCeilingUsd must not exceed budget.providerHardLimitUsd');
  }
  if ([budget.releaseCeilingUsd, controlledAllowance?.value, budget.rerunUsd].every(Number.isFinite) &&
      controlledAllowance.value + budget.rerunUsd > budget.releaseCeilingUsd + 1e-12) {
    errors.push('controlled-pair and rerun allowances exceed the release ceiling');
  }
  if (Number.isFinite(budget.qualificationPairUsd) && Number.isFinite(budget.calibrationCeilingUsd) &&
      budget.qualificationPairUsd + budget.calibrationCeilingUsd > MAX_RELEASE_API_USD) {
    errors.push('qualification and calibration ceilings exceed the absolute initial-evidence ceiling');
  }
  if (Number.isFinite(budget.providerHardLimitUsd) && Number.isFinite(budget.qualificationPairUsd) &&
      Number.isFinite(budget.calibrationCeilingUsd) &&
      budget.qualificationPairUsd + budget.calibrationCeilingUsd > budget.providerHardLimitUsd + 1e-12) {
    errors.push('qualification and calibration ceilings exceed the shared provider hard limit');
  }
  let lane = null;
  try {
    lane = controlledLaneOf(config);
  } catch (error) {
    errors.push(error.message);
  }
  if (lane && !['openrouter-controlled', 'openrouter-kimi'].includes(lane.host)) {
    errors.push('controlledLane.host must be openrouter-controlled or the historical openrouter-kimi adapter');
  }
  if (lane && (typeof lane.profileId !== 'string' || lane.profileId.length === 0)) {
    errors.push('controlledLane.profileId must be a registered OpenRouter profile');
  } else if (lane) {
    try {
      const profile = getProfile(lane.profileId);
      validateControlledProfile(profile);
      if (lane.host === 'openrouter-kimi' && lane.profileId !== 'kimi-k2.7-code') {
        errors.push('the historical openrouter-kimi adapter only supports kimi-k2.7-code');
      }
    } catch (error) {
      errors.push(`controlledLane.profileId is invalid: ${error.message}`);
    }
  }
  for (const field of ['promptRatio', 'costRatio', 'wallTimeRatio']) {
    finiteAtLeast(config?.efficiencyThresholds?.[field], 0, `efficiencyThresholds.${field}`);
  }
  for (const field of ['maxIncrementalApiCostPerAdditionalSuccessUsd', 'maxIncrementalWallTimePerAdditionalSuccessMs']) {
    finiteAtLeast(config?.valueThresholds?.[field], 0, `valueThresholds.${field}`);
  }
  const policy = config?.claimPolicy ?? { mode: 'regression-gate' };
  if (!['regression-gate', 'initial-user-ship'].includes(policy.mode)) {
    errors.push('claimPolicy.mode must be regression-gate or initial-user-ship');
  }
  if (policy.requireCalibrationBaseline != null && typeof policy.requireCalibrationBaseline !== 'boolean') {
    errors.push('claimPolicy.requireCalibrationBaseline must be boolean');
  }
  if (policy.requireQualificationBaseline != null && typeof policy.requireQualificationBaseline !== 'boolean') {
    errors.push('claimPolicy.requireQualificationBaseline must be boolean');
  }
  if ((policy.requireQualificationBaseline === true || policy.requireCalibrationBaseline === true) &&
      (typeof policy.qualificationTask !== 'string' || policy.qualificationTask.length === 0)) {
    errors.push('claimPolicy.qualificationTask must name one pinned task when baseline provenance is required');
  }
  if (policy.requireCalibrationBaseline === true &&
      (!Number.isInteger(policy.minimumCalibrationRepetitions) || policy.minimumCalibrationRepetitions < 2)) {
    errors.push('claimPolicy.minimumCalibrationRepetitions must be an integer >= 2 when calibration provenance is required');
  }
  if (policy.requireCalibrationBaseline === true &&
      (!Number.isInteger(policy.minimumHarnessSolvedTasks) || policy.minimumHarnessSolvedTasks < 1)) {
    errors.push('claimPolicy.minimumHarnessSolvedTasks must be a positive integer when calibration provenance is required');
  }
  if (policy.mode === 'initial-user-ship') {
    if (!Number.isInteger(policy.minimumHarnessSolvedTasks) || policy.minimumHarnessSolvedTasks < 1) {
      errors.push('claimPolicy.minimumHarnessSolvedTasks must be a positive integer');
    }
    if (policy.requireCalibrationBaseline != null && typeof policy.requireCalibrationBaseline !== 'boolean') {
      errors.push('claimPolicy.requireCalibrationBaseline must be boolean');
    }
    if (policy.requireQualificationBaseline != null && typeof policy.requireQualificationBaseline !== 'boolean') {
      errors.push('claimPolicy.requireQualificationBaseline must be boolean');
    }
    if (policy.requireQualificationBaseline === true &&
        (typeof policy.qualificationTask !== 'string' || policy.qualificationTask.length === 0)) {
      errors.push('claimPolicy.qualificationTask must name one pinned task when qualification is required');
    }
    if (policy.minimumCalibrationRepetitions != null &&
        (!Number.isInteger(policy.minimumCalibrationRepetitions) || policy.minimumCalibrationRepetitions < 2)) {
      errors.push('claimPolicy.minimumCalibrationRepetitions must be an integer >= 2');
    }
  }
  const taskSet = config?.task?.taskSet;
  if (!Array.isArray(taskSet) || taskSet.length === 0) errors.push('task.taskSet must contain at least one task');
  else {
    const names = taskSet.map((entry) => entry?.task);
    if (names.some((name) => typeof name !== 'string' || name.length === 0) || new Set(names).size !== names.length) {
      errors.push('task.taskSet must contain unique nonempty task names');
    }
  }
  return { ok: errors.length === 0, errors };
}

export function releaseInvocationPolicy({
  claimMode,
  calibrationRelease = false,
  qualificationRelease = false,
  diagnosticScope = false,
  trustOk = false,
} = {}) {
  const reasons = [];
  if (qualificationRelease && claimMode !== 'initial-user-ship') {
    reasons.push('--qualification requires an initial-user-ship profile');
  }
  if (qualificationRelease && diagnosticScope) {
    reasons.push('--qualification requires the committed task lock and a live scope, not a diagnostic scope');
  }
  if (calibrationRelease && claimMode !== 'initial-user-ship') {
    reasons.push('--calibration requires an initial-user-ship profile');
  }
  if (calibrationRelease && diagnosticScope) {
    reasons.push('--calibration requires the complete committed task lock, not a diagnostic scope');
  }
  if (trustOk && !calibrationRelease && !qualificationRelease && !diagnosticScope && claimMode === 'initial-user-ship') {
    reasons.push('a trusted initial-user-ship profile must run with --calibration; use the routine profile after qualification');
  }
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------ gate policy -- */

/** §9: always-blocking rules, with gate-inactive pairs reporting instead of blocking. */
export function applyGatePolicy({ deterministic, pairs = [], smokes = [], telemetryComplete, coverageComplete = true, coverageReason = null, taskLockOk, environmentOk, budgetBreached = false, calibrationRelease = false, evaluationMode = 'release', releaseTrustOk = true, releaseEligible = true }) {
  const reasons = [];
  if (deterministic?.failed > 0) reasons.push(`existing deterministic evals regressed (${deterministic.failed} failing)`);
  if (environmentOk === false) reasons.push('required dependencies or credentials are missing');
  if (taskLockOk === false) reasons.push('the pinned task/verifier failed validation');
  if (coverageComplete === false) reasons.push(`required controlled task coverage is incomplete${coverageReason ? ` (${coverageReason})` : ''}`);
  if (telemetryComplete === false) reasons.push('required telemetry is missing from at least one run');
  if (budgetBreached) reasons.push('the absolute release API budget was exceeded during provider reconciliation');
  if (evaluationMode === 'qualification') reasons.push('a one-task qualification establishes model capability only and cannot green the release');
  if (evaluationMode === 'diagnostic-task') reasons.push('a one-task diagnostic is not eligible to green the release');
  if (evaluationMode === 'diagnostic-lock') reasons.push('an explicit task-lock diagnostic is not eligible to green the release');
  if (releaseTrustOk === false && evaluationMode !== 'deterministic-only') {
    reasons.push('provider execution is disabled until every release trust capability is attested');
  }
  if (evaluationMode === 'calibration' && releaseEligible !== true) {
    reasons.push('this calibration policy is measurement-only and is not eligible to green the release');
  }
  for (const pair of pairs) {
    const c = pair.classification ?? {};
    const label = pair.task ? `${pair.host} (${pair.task})` : pair.host;
    if (c.safety) reasons.push(`harness safety control bypassed on ${label}`);
    if (pair.rerun?.safety === true) reasons.push(`harness safety control bypassed on rerun for ${label}`);
    if (pair.rerun?.result === 'harness-win' &&
        pair.rerun?.efficiencyDelta?.valueEconomics?.policyConfigured === true &&
        pair.rerun.efficiencyDelta.valueEconomics.withinThresholds !== true) {
      reasons.push(`harness win confirmation on ${label} is outside the declared incremental cost/time value limits`);
    }
    // A required pair with no valid evidence is a red release, not a green one.
    if (pair.required && pair.result === 'skipped') {
      reasons.push(`required pair ${label} was skipped and did not run`);
    }
    if ((pair.gateActive || pair.required) && pair.result === 'infrastructure-invalid') {
      reasons.push(`pair ${label} produced no valid signal (${pair.reason})`);
    }
    if (!pair.gateActive) continue;
    if (c.fallbackDetected) reasons.push(`model or provider fallback invalidated the comparison on ${label}`);
    if (c.result === 'parity' && pair.efficiencyDelta?.withinThresholds === false) {
      const detail = pair.efficiencyDelta.evidenceComplete
        ? `efficiency ratio exceeded: ${pair.efficiencyDelta.breaches.join(', ')}`
        : 'efficiency evidence is incomplete';
      reasons.push(`success parity overhead on ${label} is outside release limits (${detail})`);
    }
    if (c.result === 'harness-regression' && pair.reproduced !== false) {
      reasons.push(`${pair.reproduced === true ? 'reproduced' : 'unresolved'} harness regression on ${label}`);
    }
    if (c.result === 'mixed-inconclusive') {
      reasons.push(`paired outcome variance on ${label} did not reach a strict majority`);
    }
    if (c.result === 'inconclusive-capability') {
      reasons.push(`neither controlled arm solved the required task on ${label}`);
    }
    if (c.result === 'harness-win' && pair.efficiencyDelta?.valueEconomics?.policyConfigured === true &&
        pair.efficiencyDelta.valueEconomics.withinThresholds !== true) {
      reasons.push(`harness win on ${label} is outside the declared incremental cost/time value limits`);
    }
  }
  for (const smoke of smokes) {
    if (smoke.ok === false) reasons.push(`compatibility smoke failed: ${smoke.host} (${(smoke.failed ?? []).join(', ')})`);
  }
  return { block: reasons.length > 0, reasons };
}

function controlledTaskCoverage(config, pairs, requiredPairs) {
  const requiredHosts = requiredPairs.filter((host) => String(host).startsWith('openrouter'));
  const expectedTasks = (config.task?.requiredTaskSet ?? config.task?.taskSet ?? [])
    .map((entry) => entry?.task)
    .filter((task) => typeof task === 'string' && task.length > 0);
  const observed = pairs
    .filter((pair) => requiredHosts.includes(pair.host) && pair.result !== 'skipped' && typeof pair.task === 'string')
    .map((pair) => ({ host: pair.host, task: pair.task }));
  const missing = [];
  const duplicates = [];
  const unexpected = [];
  for (const host of requiredHosts) {
    for (const task of expectedTasks) {
      const count = observed.filter((entry) => entry.host === host && entry.task === task).length;
      if (count === 0) missing.push({ host, task });
      if (count > 1) duplicates.push({ host, task, count });
    }
    for (const entry of observed.filter((candidate) => candidate.host === host)) {
      if (!expectedTasks.includes(entry.task)) unexpected.push(entry);
    }
  }
  const complete = requiredHosts.length === 0 || (
    expectedTasks.length > 0 && missing.length === 0 && duplicates.length === 0 && unexpected.length === 0
  );
  const describe = (entries) => entries.map((entry) => `${entry.host}:${entry.task}`).join(', ');
  const reason = [
    missing.length ? `missing ${describe(missing)}` : null,
    duplicates.length ? `duplicate ${describe(duplicates)}` : null,
    unexpected.length ? `unexpected ${describe(unexpected)}` : null,
    requiredHosts.length > 0 && expectedTasks.length === 0 ? 'no expected tasks configured' : null,
  ].filter(Boolean).join('; ');
  return { complete, requiredHosts, expectedTasks, observed, missing, duplicates, unexpected, reason: reason || null };
}

function buildClaim(pairs, evidenceComplete, { releaseEligible = true } = {}) {
  const active = pairs.filter((pair) =>
    pair.comparisonTrack === 'controlled-ablation' &&
    pair.gateActive &&
    pair.result !== 'skipped' &&
    pair.causallyAttributable === true
  );
  const treatmentFidelityModes = [...new Set(active.map((pair) => pair.harness?.enforcementFidelity?.mode).filter(Boolean))].sort();
  const treatmentLabel = treatmentFidelityModes.length === 1
    ? `${treatmentFidelityModes[0]} treatment`
    : treatmentFidelityModes.length > 1
      ? `${treatmentFidelityModes.join('+')} treatments`
      : 'evaluated treatment';
  const controlledWins = active.filter((pair) => pair.result === 'harness-win').length;
  const confirmedWins = active.filter((pair) =>
    pair.result === 'harness-win' &&
    ((Number.isInteger(pair.repetitionCount) && pair.repetitionCount >= 2) || pair.reproduced === true) &&
    (pair.efficiencyDelta?.valueEconomics?.policyConfigured !== true ||
      pair.efficiencyDelta?.valueEconomics?.withinThresholds === true)
  ).length;
  const regressions = active.filter(
    (pair) => pair.result === 'harness-regression' || (pair.result === 'parity' && pair.efficiencyDelta?.withinThresholds === false)
  ).length;
  let level = 'inconclusive';
  let statement = 'The controlled evidence is not yet sufficient for a Harness value claim.';
  if (!releaseEligible) {
    statement = 'This diagnostic scope is not release-eligible and cannot support a Harness value claim.';
  } else if (regressions > 0) {
    level = 'regression';
    statement = `At least one active controlled comparison of the ${treatmentLabel} regressed in correctness or bounded-overhead policy.`;
  } else if (evidenceComplete && confirmedWins > 0) {
    level = 'demonstrated-value';
    statement = `The ${treatmentLabel} improved verified success in at least one active same-model controlled comparison.`;
  } else if (
    evidenceComplete &&
    active.length > 0 &&
    active.every((pair) => pair.result === 'parity' && pair.efficiencyDelta?.withinThresholds === true)
  ) {
    level = 'bounded-overhead';
    statement = `Verified success was at parity and ${treatmentLabel} overhead stayed within the declared release thresholds.`;
  }
  return { level, statement, controlledPairs: active.length, controlledWins, confirmedWins, regressions, treatmentFidelityModes };
}

function initialShipReadiness(config, claim, pairs, { releaseEligible, calibrationRelease = false }) {
  const mode = config.claimPolicy?.mode ?? 'regression-gate';
  if (mode !== 'initial-user-ship') {
    const calibrationRequired = config.claimPolicy?.requireCalibrationBaseline === true;
    const calibrationBaseline = config.calibrationBaseline ?? null;
    const acceptedCalibrationBaseline = calibrationBaseline?.valid === true &&
      Number(calibrationBaseline?.controlledWins ?? 0) > 0;
    return {
      policy: mode,
      ready: calibrationRequired ? acceptedCalibrationBaseline : null,
      reasons: calibrationRequired && !acceptedCalibrationBaseline
        ? ['an accepted initial-value calibration baseline is required before a routine release']
        : [],
      minimumHarnessSolvedTasks: null,
      harnessSolvedTasks: null,
      calibrationRequired,
      calibrationBaseline: calibrationBaseline ? {
        valid: calibrationBaseline.valid === true,
        evidenceHash: calibrationBaseline.evidenceHash ?? null,
        releaseSha: calibrationBaseline.releaseSha ?? null,
        harnessVersion: calibrationBaseline.harnessVersion ?? null,
        minimumRepetitions: calibrationBaseline.minimumRepetitions ?? null,
        controlledWins: calibrationBaseline.controlledWins ?? null,
        harnessSolvedTasks: calibrationBaseline.harnessSolvedTasks ?? null,
        providerKeyFingerprint: calibrationBaseline.providerKeyFingerprint ?? null,
        reasons: Array.isArray(calibrationBaseline.reasons) ? calibrationBaseline.reasons : [],
      } : null,
    };
  }
  const minimum = Number.isInteger(config.claimPolicy?.minimumHarnessSolvedTasks) &&
    config.claimPolicy.minimumHarnessSolvedTasks > 0
    ? config.claimPolicy.minimumHarnessSolvedTasks
    : 1;
  const attributable = pairs.filter((pair) =>
    pair.comparisonTrack === 'controlled-ablation' && pair.gateActive && pair.causallyAttributable === true
  );
  const harnessSolvedTasks = attributable.filter((pair) => pair.harness?.correctness?.verdict === 'pass').length;
  const reasons = [];
  const minimumRepetitions = Number(config.claimPolicy?.minimumCalibrationRepetitions ?? 3);
  const calibrationRequired = config.claimPolicy?.requireCalibrationBaseline === true && !calibrationRelease;
  const calibrationBaseline = config.calibrationBaseline ?? null;
  const acceptedCalibrationBaseline = calibrationBaseline?.valid === true &&
    Number(calibrationBaseline?.controlledWins ?? 0) > 0;
  const directCalibrationRequired = minimumRepetitions > 1 &&
    (calibrationRelease || !acceptedCalibrationBaseline);
  if (!releaseEligible) reasons.push('evaluation scope is not release-eligible');
  if (calibrationRequired && calibrationBaseline?.valid !== true) {
    reasons.push('a matching trusted calibration baseline is required before initial user ship');
  }
  if (directCalibrationRequired) {
    for (const pair of attributable) {
      const paired = pair?.pairedOutcomes;
      if (!Number.isInteger(pair?.repetitionCount) || pair.repetitionCount < minimumRepetitions ||
          !Number.isInteger(paired?.pairedRepetitions) || paired.pairedRepetitions < minimumRepetitions) {
        reasons.push(`controlled task ${pair?.task ?? 'unknown'} has fewer than ${minimumRepetitions} aligned calibration repetitions`);
      }
      if ((paired?.counts?.['harness-regression'] ?? 0) > 0 ||
          (paired?.counts?.['inconclusive-capability'] ?? 0) > 0) {
        reasons.push(`Harness did not pass every calibration repetition for ${pair?.task ?? 'unknown'}`);
      }
    }
  }
  const currentClaimSupportsShip = claim.level === 'demonstrated-value' ||
    (acceptedCalibrationBaseline && claim.level === 'bounded-overhead');
  if (!currentClaimSupportsShip) {
    reasons.push(`claim level ${claim.level} does not establish demonstrated pre-user value`);
  }
  if (harnessSolvedTasks < minimum) {
    reasons.push(`Harness solved ${harnessSolvedTasks} attributable tasks; ${minimum} required`);
  }
  return {
    policy: mode,
    ready: reasons.length === 0,
    reasons,
    minimumHarnessSolvedTasks: minimum,
    harnessSolvedTasks,
    calibrationRequired: directCalibrationRequired || calibrationRequired,
    calibrationBaseline: calibrationBaseline ? {
      valid: calibrationBaseline.valid === true,
      evidenceHash: calibrationBaseline.evidenceHash ?? null,
      minimumRepetitions: calibrationBaseline.minimumRepetitions ?? null,
      controlledWins: calibrationBaseline.controlledWins ?? null,
      harnessSolvedTasks: calibrationBaseline.harnessSolvedTasks ?? null,
      providerKeyFingerprint: calibrationBaseline.providerKeyFingerprint ?? null,
      reasons: Array.isArray(calibrationBaseline.reasons) ? calibrationBaseline.reasons : [],
    } : null,
  };
}

/* ------------------------------------------------------------ orchestrator -- */

function gateActiveFor(host, controlledHost, calibrationRelease, releaseEligible, evaluationMode) {
  if (host === controlledHost) {
    if (evaluationMode === 'qualification') return false;
    return !calibrationRelease || releaseEligible;
  }
  if (host === 'ollama-gemma') return false; // gate: informational
  return true; // frontier rotation gates when scheduled
}

const METERED_FIELDS = [
  'promptTokens', 'outputTokens', 'modelRequests', 'providerAttempts',
  'providerReportedCostUsd', 'localCostUsd', 'reconciledCostUsd',
];

function meteringLedgerVerdict(doc, { paid = false } = {}) {
  const efficiency = doc?.efficiency ?? {};
  const reproducibility = doc?.reproducibility ?? {};
  const events = doc?.observability?.providerEvents;
  const mismatches = [];
  if (!Array.isArray(events)) return { ok: false, mismatches: ['providerEvents'] };
  const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const isAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const sameAmount = (left, right) => isAmount(left) && isAmount(right) && Math.abs(left - right) <= 1e-12;
  const requests = events.filter((event) => event?.type === 'request');
  const attempts = events.filter((event) => event?.type === 'request_attempt');
  const responses = events.filter((event) => event?.type === 'response');
  const errors = events.filter((event) => event?.type === 'error');
  const retries = events.filter((event) => event?.type === 'retry');
  const terminals = [...responses, ...errors];
  // A successful response always owes a usage record. An error that claims
  // reported billing also owes one; otherwise paid partial generations could
  // disappear from the ledger merely by omitting the `usage` property.
  const usageTerminals = terminals.filter((event) =>
    event.type === 'response' || event.billingStatus === 'reported' || Object.hasOwn(event, 'usage')
  );
  const usageRecords = usageTerminals.map((event) => event.usage);
  const usable = usageRecords.filter((usage) => usage &&
    isCount(usage.promptTokens) && isCount(usage.outputTokens) &&
    isAmount(usage.localCostUsd) && isAmount(usage.reconciledCostUsd));
  const missingUsage = usageRecords.length - usable.length;
  const unknownBillingAttempts = terminals.filter((event) => event?.billingStatus === 'unknown').length;
  const invalidBillingStatus = terminals.filter((event) =>
    !['reported', 'confirmed_unbilled', 'unknown'].includes(event?.billingStatus)
  ).length;
  const providerCostsPresent = usable.length === usageRecords.length && usable.every((usage) =>
    isAmount(usage.providerCostUsd)
  );
  const providerCostComplete = usable.length === usageRecords.length && (!paid || providerCostsPresent);
  const usageComplete = missingUsage === 0;
  const billingComplete = invalidBillingStatus === 0 && unknownBillingAttempts === 0;
  const costComplete = usageComplete && providerCostComplete && billingComplete;
  const reconciledArithmeticValid = usable.every((usage) => {
    if (paid && !isAmount(usage.providerCostUsd)) return false;
    const expected = Math.max(usage.localCostUsd, isAmount(usage.providerCostUsd) ? usage.providerCostUsd : 0);
    return sameAmount(usage.reconciledCostUsd, expected);
  });
  let profile = null;
  try {
    profile = getProfile(reproducibility.modelProfileId);
  } catch {
    mismatches.push('modelProfileId');
  }
  if (profile) {
    if (reproducibility.billingProfileHash !== billingProfileHash(profile.id)) {
      mismatches.push('billingProfileHash');
    }
    if (reproducibility.pricingCatalogCheckedAt !== (profile.catalogPin?.checkedAt ?? null)) {
      mismatches.push('pricingCatalogCheckedAt');
    }
    if (reproducibility.modelRequested !== profile.model) mismatches.push('profileModel');
    if (!String(reproducibility.host ?? '').startsWith(profile.host)) mismatches.push('profileHost');
    const profileIsPaid = Object.values(profile.pricing).some((value) => value > 0);
    if (profileIsPaid !== paid) mismatches.push('profileBillingClass');
    const localCostArithmeticValid = usable.every((usage) => {
      const cachedTokens = usage.cachedTokensComplete === true && isCount(usage.cachedTokens) &&
        usage.cachedTokens <= usage.promptTokens
        ? usage.cachedTokens
        : undefined;
      const recomputed = costOfUsage({
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.outputTokens,
        ...(cachedTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: cachedTokens } }),
      }, profile.pricing);
      return recomputed != null && sameAmount(usage.localCostUsd, recomputed.usd);
    });
    if (!localCostArithmeticValid) mismatches.push('localCostArithmetic');
  }
  const cachedComplete = usable.length === usageRecords.length && usable.every((usage) =>
    usage.cachedTokensComplete === true && isCount(usage.cachedTokens) && usage.cachedTokens <= usage.promptTokens
  );
  const reasoningComplete = usable.length === usageRecords.length && usable.every((usage) =>
    usage.reasoningTokensComplete === true && isCount(usage.reasoningTokens) && usage.reasoningTokens <= usage.outputTokens
  );
  const sum = (field) => usable.reduce((total, usage) => total + usage[field], 0);
  const expected = {
    modelRequests: requests.length,
    providerAttempts: attempts.length,
    providerResponses: responses.length,
    providerErrors: errors.length,
    retries: retries.length,
    unknownBillingAttempts,
    missingUsage,
    promptTokens: sum('promptTokens'),
    cachedPromptTokens: cachedComplete ? sum('cachedTokens') : null,
    reasoningTokens: reasoningComplete ? sum('reasoningTokens') : null,
    outputTokens: sum('outputTokens'),
    localCostUsd: sum('localCostUsd'),
    providerReportedCostUsd: providerCostComplete && providerCostsPresent ? sum('providerCostUsd') : null,
    reconciledCostUsd: sum('reconciledCostUsd'),
    cachedPromptTokensComplete: cachedComplete,
    reasoningTokensComplete: reasoningComplete,
    usageComplete,
    providerCostComplete,
    billingComplete,
    costComplete,
    billingUncertain: !costComplete,
  };
  for (const field of [
    'modelRequests', 'providerAttempts', 'providerResponses', 'providerErrors', 'retries',
    'unknownBillingAttempts', 'missingUsage', 'promptTokens', 'outputTokens',
  ]) {
    if (efficiency[field] !== expected[field]) mismatches.push(field);
  }
  for (const field of ['localCostUsd', 'reconciledCostUsd']) {
    if (!sameAmount(efficiency[field], expected[field])) mismatches.push(field);
  }
  if (expected.providerReportedCostUsd != null) {
    if (!sameAmount(efficiency.providerReportedCostUsd, expected.providerReportedCostUsd)) {
      mismatches.push('providerReportedCostUsd');
    }
  } else if (efficiency.providerReportedCostUsd != null) {
    mismatches.push('providerReportedCostUsd');
  }
  for (const field of ['cachedPromptTokens', 'reasoningTokens']) {
    if (expected[field] == null ? efficiency[field] != null : efficiency[field] !== expected[field]) {
      mismatches.push(field);
    }
  }
  for (const field of [
    'cachedPromptTokensComplete', 'reasoningTokensComplete', 'usageComplete',
    'providerCostComplete', 'billingComplete', 'costComplete', 'billingUncertain',
  ]) {
    if (efficiency[field] !== expected[field]) mismatches.push(field);
  }
  if (!reconciledArithmeticValid) mismatches.push('reconciledCostArithmetic');
  return { ok: mismatches.length === 0, mismatches: [...new Set(mismatches)] };
}

const ECONOMIC_PHASE_NAMES = ECONOMIC_PHASES;
const MEMORY_ECONOMIC_PHASE_SET = new Set(MEMORY_ECONOMIC_PHASES);

function phaseEconomicsReconcile(economics) {
  const phases = economics?.phases;
  const totals = economics?.totals;
  if (phases == null || typeof phases !== 'object' || Array.isArray(phases) ||
      totals == null || typeof totals !== 'object' || Array.isArray(totals) ||
      ECONOMIC_PHASE_NAMES.some((name) => phases[name] == null || typeof phases[name] !== 'object')) {
    return false;
  }
  const counts = ['logicalRequests', 'usageRecords'];
  const measured = [];
  for (const name of ECONOMIC_PHASE_NAMES) {
    const phase = phases[name];
    if (!['measured', 'not_exercised'].includes(phase.status) ||
        counts.some((field) => !Number.isSafeInteger(phase[field]) || phase[field] < 0)) {
      return false;
    }
    for (const field of ECONOMIC_PHASE_FIELDS) {
      const complete = phase[`${field}Complete`];
      const value = phase[field];
      if (typeof complete !== 'boolean' ||
          (complete ? !(typeof value === 'number' && Number.isFinite(value) && value >= 0) : value !== null)) {
        return false;
      }
    }
    if (phase.status === 'not_exercised') {
      if (phase.logicalRequests !== 0 || phase.usageRecords !== 0 ||
          ECONOMIC_PHASE_FIELDS.some((field) => phase[`${field}Complete`] !== false)) return false;
    } else {
      if (phase.logicalRequests < 1 || phase.usageRecords < 1) return false;
      measured.push(phase);
    }
  }
  for (const field of counts) {
    if (!Number.isSafeInteger(totals[field]) || totals[field] < 0 ||
        measured.reduce((sum, phase) => sum + phase[field], 0) !== totals[field]) return false;
  }
  for (const field of ECONOMIC_PHASE_FIELDS) {
    const complete = totals[`${field}Complete`];
    const value = totals[field];
    if (typeof complete !== 'boolean') return false;
    if (complete) {
      if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
          measured.some((phase) => phase[`${field}Complete`] !== true) ||
          Math.abs(measured.reduce((sum, phase) => sum + phase[field], 0) - value) > 1e-9) return false;
    } else if (value !== null) {
      return false;
    }
  }
  const taskPhaseNames = ECONOMIC_PHASE_NAMES.filter((name) => !MEMORY_ECONOMIC_PHASE_SET.has(name));
  const taskExecution = economics?.rollups?.['task-execution'];
  if (taskExecution == null || typeof taskExecution !== 'object' ||
      !isDeepStrictEqual(taskExecution.derivedFrom, taskPhaseNames) ||
      !['measured', 'not_exercised'].includes(taskExecution.status)) return false;
  for (const field of counts) {
    const expected = taskPhaseNames.reduce((sum, name) => sum + phases[name][field], 0);
    if (taskExecution[field] !== expected) return false;
  }
  const taskExercised = taskPhaseNames.map((name) => phases[name]).filter((phase) => phase.status === 'measured');
  if ((taskExercised.length === 0) !== (taskExecution.status === 'not_exercised')) return false;
  for (const field of ECONOMIC_PHASE_FIELDS) {
    const completeKey = `${field}Complete`;
    if (taskExercised.length === 0) {
      if (taskExecution[field] !== null || taskExecution[completeKey] !== false) return false;
      continue;
    }
    const allComplete = taskExercised.every((phase) => phase[completeKey] === true);
    if (taskExecution[completeKey] !== allComplete) return false;
    if (allComplete) {
      const expected = taskExercised.reduce((sum, phase) => sum + phase[field], 0);
      if (typeof taskExecution[field] !== 'number' || Math.abs(taskExecution[field] - expected) > 1e-9) return false;
    } else if (taskExecution[field] !== null) return false;
  }
  return true;
}

function attributableTrialEvidence(doc, { paid = false, passingReward = 1 } = {}) {
  const efficiency = doc?.efficiency ?? {};
  const observability = doc?.observability;
  const workspace = doc?.workspaceEvidence;
  if (
    !observability ||
    workspace?.available !== true ||
    !doc?.enforcementFidelity?.mode ||
    doc?.trialValidity?.valid !== true ||
    doc?.trialValidity?.failureKind != null ||
    !verifierEvidenceConsistent(doc, passingReward)
  ) return false;
  // Harness-event files live in the evaluated workspace and are agent-writable.
  // They explain positive behavior but cannot be a causal-validity prerequisite:
  // requiring a clean event projection would let the treatment select which
  // runs enter the denominator. Trusted request/tool/workspace ledgers below
  // carry the release-integrity checks.
  const requestEvents = observability.providerEvents?.filter((event) => event.type === 'request').length;
  const attribution = trialAttribution(doc, { requireProvider: paid });
  const metering = meteringLedgerVerdict(doc, { paid });
  const economics = doc?.economics;
  const economicTotals = economics?.totals;
  const sameEconomicNumber = (left, right) => typeof left === 'number' && Number.isFinite(left) &&
    typeof right === 'number' && Number.isFinite(right) && Math.abs(left - right) <= 1e-9;
  const economicsComplete = economics?.coverage?.status === 'complete' &&
    economics.coverage.complete === true && economics?.prompt?.coverage?.complete === true &&
    economics?.prompt?.manifest != null && economics?.reconciliation?.complete === true &&
    phaseEconomicsReconcile(economics) &&
    economics.prompt.coverage.requests === efficiency.modelRequests &&
    economics.prompt.coverage.requestsWithCompleteBuckets === efficiency.modelRequests &&
    sameEconomicNumber(economicTotals?.logicalRequests, efficiency.modelRequests) &&
    sameEconomicNumber(economicTotals?.promptTokens, efficiency.promptTokens) &&
    sameEconomicNumber(economicTotals?.outputTokens, efficiency.outputTokens) &&
    sameEconomicNumber(economicTotals?.localCostUsd, efficiency.localCostUsd) &&
    sameEconomicNumber(economicTotals?.reconciledCostUsd, efficiency.reconciledCostUsd) &&
    (!efficiency.cachedPromptTokensComplete ||
      sameEconomicNumber(economicTotals?.cachedPromptTokens, efficiency.cachedPromptTokens)) &&
    (!efficiency.reasoningTokensComplete ||
      sameEconomicNumber(economicTotals?.reasoningTokens, efficiency.reasoningTokens)) &&
    (!paid || !efficiency.providerCostComplete ||
      sameEconomicNumber(economicTotals?.providerReportedCostUsd, efficiency.providerReportedCostUsd));
  return (
    attribution.complete &&
    !attribution.contaminated &&
    metering.ok &&
    economicsComplete &&
    observability.providerAttemptsStarted === efficiency.providerAttempts &&
    observability.providerAttemptsClosed === efficiency.providerAttempts &&
    observability.unclosedProviderAttempts === 0 &&
    observability.uncorrelatedProviderTerminals === 0 &&
    observability.duplicateProviderAttemptIdentities === 0 &&
    observability.duplicateProviderTerminalIdentities === 0 &&
    observability.invalidProviderEventIdentities === 0 &&
    observability.uncorrelatedToolResults === 0 &&
    observability.unclosedToolCalls === 0 &&
    observability.duplicateToolCallIdentities === 0 &&
    observability.duplicateToolResultIdentities === 0 &&
    observability.invalidToolEventIdentities === 0 &&
    observability.malformedToolCallEvidence === 0 &&
    observability.malformedToolResultEvidence === 0 &&
    observability.incompleteToolContainment === 0 &&
    observability.controlContaminationDetected === false &&
    observability.runtimeContractEvidence?.complete === true &&
    observability.runtimeContractEvidence?.matchesExpected === true &&
    observability.mountPolicyEvidence?.source === 'sandbox-observed' &&
    observability.mountPolicyEvidence?.observed === true &&
    observability.mountPolicyEvidence?.complete === true &&
    observability.mountPolicyEvidence?.matchesCondition === true &&
    observability.mountPolicyEvidence?.structurallyIsolated === true &&
    requestEvents === efficiency.modelRequests &&
    Number.isFinite(workspace.changedPathCount) &&
    Array.isArray(workspace.changedPaths) &&
    workspace.changedPathCount >= workspace.changedPaths.length
  );
}

function attributableEvidence(doc, options) {
  const repetitions = rawTrials(doc);
  return repetitions.length > 0 && repetitions.every((repetition) => attributableTrialEvidence(repetition, options));
}

function completePaidEvidence(doc, { passingReward = 1 } = {}) {
  const trials = rawTrials(doc);
  return trials.length > 0 && trials.every((trial) =>
    validateAgainstSchema(trial, RUN_SCHEMA).ok &&
    METERED_FIELDS.every((field) => trial.efficiency?.[field] != null) &&
    trial.efficiency?.usageComplete === true &&
    trial.efficiency?.providerCostComplete === true &&
    trial.efficiency?.billingComplete === true &&
    trial.efficiency?.costComplete === true &&
    trial.efficiency?.billingUncertain === false &&
    trial.efficiency?.unknownBillingAttempts === 0 &&
    trial.efficiency?.missingUsage === 0 &&
    trial.correctness?.completedWithinTimeout === true &&
    trial.correctness?.completedWithinBudget === true &&
    attributableTrialEvidence(trial, { paid: true, passingReward })
  );
}

function fullyAttributablePair(pair, host, identityOptions = {}) {
  if (!pair?.generic || !pair?.harness || pair.failureKind) return false;
  if (!pairIdentityVerdict(pair, { ...identityOptions, host }).ok) return false;
  const passingReward = identityOptions.expectedVerifierPassingReward ?? 1;
  if (String(host).startsWith('openrouter')) {
    return completePaidEvidence(pair.generic, { passingReward }) &&
      completePaidEvidence(pair.harness, { passingReward });
  }
  return attributableEvidence(pair.generic, { paid: false, passingReward }) &&
    attributableEvidence(pair.harness, { paid: false, passingReward });
}

/**
 * Run the release sequence with injected steps. Steps that are absent or that
 * return null are reported as skipped; paid steps never run after a failed
 * preflight (deterministic regression, missing dependencies, or a bad task
 * pin) — that is the cost-control property, not an optimization.
 */
export async function runRelease({ config, steps, calibrationRelease = false, releaseSha = 'unknown', harnessVersion = 'unknown', requiredPairs = [] }) {
  const configVerdict = validateReleasePolicyConfig(config);
  if (!configVerdict.ok) throw new Error(`invalid release evaluation policy: ${configVerdict.errors.join('; ')}`);
  const controlledLane = controlledLaneOf(config);
  const controlledHost = controlledLane.host;
  const allowedEvaluationModes = ['release', 'calibration', 'qualification', 'diagnostic-task', 'diagnostic-lock', 'diagnostic-trust', 'deterministic-only'];
  const configuredScope = config.evaluationScope;
  const configuredScopeValid = configuredScope != null && typeof configuredScope === 'object' &&
    allowedEvaluationModes.includes(configuredScope.mode) && typeof configuredScope.releaseEligible === 'boolean';
  const configuredEvaluationMode = configuredScopeValid ? configuredScope.mode : 'release';
  const requestedEvaluationMode = calibrationRelease && configuredEvaluationMode === 'release'
    ? 'calibration'
    : configuredEvaluationMode;
  const evaluationMode = allowedEvaluationModes.includes(requestedEvaluationMode)
    ? requestedEvaluationMode
    : 'release';
  const trust = configuredScope?.trust ?? null;
  const trustEvidenceValid = trust != null && typeof trust === 'object' &&
    trust.ok === true && trust.status === 'attested' && trust.configuredStatus === 'attested' &&
    trust.evidenceSource === 'runtime-observed' && SHA256_HEX.test(String(trust.evidenceHash ?? '')) &&
    isDeepStrictEqual(trust.requiredCapabilities, RELEASE_TRUST_CAPABILITIES) &&
    Array.isArray(trust.missingCapabilities) && trust.missingCapabilities.length === 0;
  const trustRequired = evaluationMode !== 'deterministic-only';
  const runtimeTrustRequired = trustRequired && config.runtimeTrustRequired === true;
  let runtimeReadinessEvidence = null;
  let runtimeReadinessErrorHash = null;
  if (runtimeTrustRequired && typeof steps?.runtimeSession?.readiness === 'function') {
    try {
      runtimeReadinessEvidence = await steps.runtimeSession.readiness();
    } catch (error) {
      runtimeReadinessErrorHash = crypto.createHash('sha256')
        .update(String(error?.message ?? error))
        .digest('hex');
    }
  }
  const runtimeReadiness = runtimeTrustRequired
    ? runtimeReadinessVerdict(config, runtimeReadinessEvidence, { releaseSha, now: new Date() })
    : null;
  const trustOk = !trustRequired || (runtimeTrustRequired ? runtimeReadiness.ok : trustEvidenceValid);
  const calibrationEligible = calibrationRelease && config.claimPolicy?.mode === 'initial-user-ship';
  let releaseEligible = (evaluationMode === 'release' || calibrationEligible) &&
    configuredScopeValid && configuredScope.releaseEligible === true && trustOk;
  // The controlled OpenRouter denominator is mandatory for every non-free
  // evaluation. Callers may add requirements, but cannot erase this release
  // invariant by omitting or passing an empty `requiredPairs` list.
  const effectiveRequiredPairs = trustRequired
    ? [...new Set([controlledHost, ...(Array.isArray(requiredPairs) ? requiredPairs : [])])]
    : [];
  const selectedTaskSet = config.task?.taskSet ?? [];
  const requiredTaskSet = config.task?.requiredTaskSet ?? selectedTaskSet;
  const evaluationScope = {
    mode: evaluationMode,
    releaseEligible,
    selectedTasks: selectedTaskSet.map((entry) => entry.task),
    requiredTasks: requiredTaskSet.map((entry) => entry.task),
    trust: runtimeTrustRequired ? releaseTrustVerdict(config, null) : trust,
  };
  const budgets = allocateReleaseBudgets(config.budget ?? {});
  const rawDeterministic = typeof steps?.deterministic === 'function' ? await steps.deterministic() : null;
  const deterministicEvidenceValid = rawDeterministic != null && typeof rawDeterministic === 'object' &&
    ['passed', 'failed', 'skipped'].every((field) =>
      Number.isInteger(rawDeterministic[field]) && rawDeterministic[field] >= 0
    );
  const deterministic = deterministicEvidenceValid
    ? { passed: rawDeterministic.passed, failed: rawDeterministic.failed, skipped: rawDeterministic.skipped }
    : { passed: 0, failed: 1, skipped: 0 };
  const rawEnvironment = typeof steps?.environment === 'function' ? await steps.environment() : null;
  const environmentEvidenceValid = rawEnvironment != null && typeof rawEnvironment === 'object' &&
    typeof rawEnvironment.ok === 'boolean' && Array.isArray(rawEnvironment.missing) &&
    rawEnvironment.missing.every((entry) => typeof entry === 'string');
  const environment = environmentEvidenceValid
    ? rawEnvironment
    : { ok: false, missing: ['environment preflight evidence is missing or malformed'] };
  const rawTaskLock = typeof steps?.taskLock === 'function' ? await steps.taskLock() : null;
  const taskLockEvidenceValid = rawTaskLock != null && typeof rawTaskLock === 'object' &&
    typeof rawTaskLock.ok === 'boolean' && (typeof rawTaskLock.reason === 'string' || rawTaskLock.reason === null);
  const taskLock = taskLockEvidenceValid
    ? rawTaskLock
    : { ok: false, reason: 'task-lock evidence is missing or malformed' };
  const rawProviderSpendGuard = environment?.providerSpendGuard ?? {};
  const expectedQualificationFingerprint = config.qualificationBaseline?.providerKeyFingerprint ?? null;
  const providerPolicy = resolveProviderSpendPolicy({
    evaluationMode,
    ceilingUsd: budgets.release.ceilingUsd,
    configuredHardLimitUsd: config.budget?.providerHardLimitUsd,
    expectedQualificationFingerprint,
  });
  const guardVerdict = evaluateProviderSpendEvidence({
    policy: providerPolicy,
    keyFingerprint: rawProviderSpendGuard.keyFingerprint,
    observed: rawProviderSpendGuard,
  });
  const assertedGuardHardLimitUsd = finiteNumber(rawProviderSpendGuard.hardLimitUsd);
  const assertedHardLimitMatches = assertedGuardHardLimitUsd == null
    ? !providerPolicy.continuityRequired
    : assertedGuardHardLimitUsd === providerPolicy.hardLimitUsd;
  const guardVerified = rawProviderSpendGuard.verified === true && guardVerdict.ok && assertedHardLimitMatches;
  const providerSpendGuard = {
    ...guardVerdict.evidence,
    verified: guardVerified,
    hardLimitUsd: assertedGuardHardLimitUsd ??
      (guardVerified ? guardVerdict.evidence.hardLimitUsd : null),
    checkedAt: typeof rawProviderSpendGuard.checkedAt === 'string' ? rawProviderSpendGuard.checkedAt : null,
  };
  const providerGuardRequired = effectiveRequiredPairs.some((host) => String(host).startsWith('openrouter'));
  const calibrationBaselineRequired = evaluationMode === 'release' &&
    config.claimPolicy?.requireCalibrationBaseline === true && !calibrationRelease;
  const calibrationBaselineOk = !calibrationBaselineRequired || (
    config.calibrationBaseline?.valid === true &&
    Number(config.calibrationBaseline?.controlledWins ?? 0) > 0
  );
  const qualificationBaselineRequired = evaluationMode === 'calibration' &&
    config.claimPolicy?.mode === 'initial-user-ship' &&
    config.claimPolicy?.requireQualificationBaseline === true;
  const qualificationBaselineOk = !qualificationBaselineRequired || config.qualificationBaseline?.valid === true;
  const environmentOk = configuredScopeValid && trustOk && environmentEvidenceValid && environment.ok === true &&
    (!providerGuardRequired || providerSpendGuard.verified) && calibrationBaselineOk && qualificationBaselineOk;
  const preflightOk = deterministicEvidenceValid && deterministic.failed === 0 && environmentOk &&
    taskLockEvidenceValid && taskLock.ok === true;
  const safeDiagnostic = (value, limit = 500) => typeof value === 'string'
    ? value
      .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/[\t\n\r]+/g, ' ')
      .slice(0, limit)
    : null;
  const preflight = {
    ok: preflightOk,
    runtimeReadiness: runtimeTrustRequired ? {
      ...runtimeReadiness,
      errorHash: runtimeReadinessErrorHash,
    } : null,
    environment: {
      ok: environmentOk,
      missing: (Array.isArray(environment?.missing) ? environment.missing : [])
        .concat(configuredScopeValid ? [] : ['evaluation scope evidence is missing or malformed'])
        .concat(trustOk ? [] : ['runtime trust evidence is missing or malformed'])
        .concat(deterministicEvidenceValid ? [] : ['deterministic evidence is missing or malformed'])
        .concat(calibrationBaselineOk ? [] : ['matching trusted calibration baseline'])
        .concat(qualificationBaselineOk ? [] : ['matching verifier-passing qualification baseline'])
        .map((value) => safeDiagnostic(value))
        .filter(Boolean)
        .slice(0, 50),
    },
    taskLock: {
      ok: taskLockEvidenceValid && taskLock.ok === true,
      reason: safeDiagnostic(taskLock.reason, 1_000),
    },
  };

  const runDocs = [];
  const pairEntries = [];
  const collect = (pair) => {
    for (const doc of [pair?.generic, pair?.harness]) if (doc) runDocs.push(doc);
  };
  const identityOptionsFor = (host, pair) => {
    const expectedTask = pair?.task ?? null;
    const expectedTaskEntry = requiredTaskSet.find((entry) => entry.task === expectedTask) ??
      selectedTaskSet.find((entry) => entry.task === expectedTask);
    return {
      host,
      expectedProfileId: host === controlledHost ? controlledLane.profileId : null,
      releaseSha,
      harnessVersion,
      expectedTask,
      expectedTaskRevision: config.task?.datasetRef ?? null,
      expectedTaskHash: expectedTaskEntry?.taskChecksum ?? null,
      expectedSandbox: expectedTaskEntry?.sandbox ?? null,
      expectedVerifierPassingReward: config.task?.verifierPassingReward ?? 1,
    };
  };

  async function evaluatePair(host, stepFn, { rerunFn = null, budget = budgets.release } = {}) {
    const required = effectiveRequiredPairs.includes(host);
    if (!stepFn || !preflightOk) {
      pairEntries.push({
        host,
        comparisonTrack: 'controlled-ablation',
        required,
        result: 'skipped',
        reason: !stepFn ? 'not scheduled for this release' : 'preflight failed — paid steps withheld',
        gateActive: false,
        reproduced: null,
        classification: null,
        generic: null,
        harness: null,
      });
      return;
    }
    let result;
    try {
      result = await stepFn(budget);
    } catch (error) {
      const reasonHash = crypto.createHash('sha256').update(String(error?.message ?? error)).digest('hex');
      pairEntries.push({
        host,
        comparisonTrack: 'controlled-ablation',
        task: null,
        required,
        result: 'infrastructure-invalid',
        reason: `controlled pair step failed (detail sha256:${reasonHash.slice(0, 16)})`,
        gateActive: gateActiveFor(host, controlledHost, calibrationRelease, releaseEligible, evaluationMode),
        reproduced: null,
        classification: { safety: false, fallbackDetected: false, result: 'infrastructure-invalid' },
        failureDiagnostics: [{ stage: 'controlled-pair-step', code: 'CONTROLLED_PAIR_STEP_FAILURE', reasonHash }],
        generic: null,
        harness: null,
      });
      return;
    }
    if (!result || (Array.isArray(result) && !result.length)) {
      pairEntries.push({ host, comparisonTrack: 'controlled-ablation', task: null, required, result: 'skipped', reason: 'dependencies unavailable', gateActive: false, reproduced: null, classification: null, efficiencyDelta: null, generic: null, harness: null });
      return;
    }
    // Multi-task steps return one pair per pinned task. Classify every primary
    // pair first so a later regression always has priority over spending the
    // single rerun allowance to confirm an earlier directional win.
    const primaryPairs = Array.isArray(result) ? result : [result];
    const primaryClassifications = primaryPairs.map((pair) =>
      classifyPair(pair, identityOptionsFor(host, pair))
    );
    const primaryEfficiencies = primaryPairs.map((pair) =>
      efficiencyDelta(
        pair.generic,
        pair.harness,
        config.efficiencyThresholds,
        config.valueThresholds,
        config.task?.verifierPassingReward ?? 1
      )
    );
    const primaryAttributions = primaryPairs.map((pair) =>
      fullyAttributablePair(pair, host, identityOptionsFor(host, pair))
    );
    const hasPrimaryRegression = primaryClassifications.some(
      (classification, index) => primaryAttributions[index] &&
        classification.fallbackDetected !== true &&
        classification.result === 'harness-regression' && !classification.safety
    );
    let exceptionalRerunAttempted = false;
    for (const [pairIndex, pair] of primaryPairs.entries()) {
      collect(pair);
      const identityOptions = identityOptionsFor(host, pair);
      let classification = primaryClassifications[pairIndex];
      const primaryEfficiency = primaryEfficiencies[pairIndex];
      const primaryAttributable = primaryAttributions[pairIndex] && classification.fallbackDetected !== true;
      let reproduced = null;
      let rerunEvidence = null;
      const regressionNeedsConfirmation = primaryAttributable &&
        classification.result === 'harness-regression' && !classification.safety;
      const regressionConfirmation = regressionNeedsConfirmation && !exceptionalRerunAttempted;
      const winConfirmation =
        classification.result === 'harness-win' &&
        primaryAttributable &&
        !hasPrimaryRegression &&
        !exceptionalRerunAttempted &&
        (primaryEfficiency.valueEconomics?.policyConfigured !== true ||
          primaryEfficiency.valueEconomics?.withinThresholds === true) &&
        (pair.repetitionCount ?? pair.seedCount ?? 1) < 2;
      // One complete fresh pair for the same task, never treatment-only.
      if ((regressionConfirmation || winConfirmation) && rerunFn) {
        exceptionalRerunAttempted = true;
        let second;
        try {
          second = await rerunFn(budgets.rerun, pair.task);
        } catch (error) {
          const reasonHash = crypto.createHash('sha256').update(String(error?.message ?? error)).digest('hex');
          rerunEvidence = {
            task: pair.task ?? null,
            pairId: null,
            repetitionCount: null,
            result: 'infrastructure-invalid',
            reason: `fresh-pair step failed (detail sha256:${reasonHash.slice(0, 16)})`,
            safety: false,
            pairedOutcomes: null,
            causallyAttributable: false,
            efficiencyDelta: null,
            overheadAttribution: null,
            failureDiagnostics: [{ stage: 'fresh-pair-step', code: 'FRESH_PAIR_STEP_FAILURE', reasonHash }],
            generic: null,
            harness: null,
          };
          classification = {
            ...classification,
            reason: `${classification.reason}; fresh-pair evidence failed and the directional result remains unresolved`,
          };
          second = null;
        }
        if (!second) {
          if (!rerunEvidence) {
            classification = {
              ...classification,
              reason: `${classification.reason}; rerun unavailable — ${regressionConfirmation ? 'regression unresolved' : 'win remains unconfirmed'}`,
            };
          }
        } else {
          collect(second);
          const rerunIdentity = rerunIdentityVerdict(pair, second, identityOptionsFor(host, pair));
          let rerunClassification = classifyPair(second, identityOptionsFor(host, pair));
          if (!rerunIdentity.ok) {
            rerunClassification = {
              ...rerunClassification,
              result: 'infrastructure-invalid',
              identityAligned: false,
              identityMismatches: rerunIdentity.mismatches,
              reason: `rerun identity mismatch (${rerunIdentity.mismatches.join(', ')})`,
            };
          }
          const rerunAttributable = rerunIdentity.ok && fullyAttributablePair(second, host, identityOptionsFor(host, pair));
          const rerunEfficiency = efficiencyDelta(
            second.generic,
            second.harness,
            config.efficiencyThresholds,
            config.valueThresholds,
            config.task?.verifierPassingReward ?? 1
          );
          rerunEvidence = {
            task: second.task ?? pair.task ?? null,
            pairId: second.pairId ?? null,
            repetitionCount: second.repetitionCount ?? second.seedCount ?? null,
            result: rerunClassification.result,
            reason: rerunClassification.reason,
            safety: rerunClassification.safety === true,
            pairedOutcomes: rerunClassification.pairedOutcomes ?? null,
            causallyAttributable: rerunAttributable && rerunClassification.fallbackDetected !== true,
            efficiencyDelta: rerunEfficiency,
            overheadAttribution: overheadAttribution(second.generic, second.harness),
            failureDiagnostics: Array.isArray(second.failureDiagnostics) ? second.failureDiagnostics : [],
            generic: second.generic ?? null,
            harness: second.harness ?? null,
          };
          if (winConfirmation) {
            const rerunValueAcceptable = rerunEfficiency.valueEconomics?.policyConfigured !== true ||
              rerunEfficiency.valueEconomics?.withinThresholds === true;
            if (rerunAttributable && rerunClassification.result === 'harness-win' && rerunValueAcceptable) {
              reproduced = true;
              classification = { ...classification, reason: `${classification.reason}; win reproduced on a fresh same-task pair` };
            } else if (rerunAttributable && rerunClassification.result === 'harness-win') {
              classification = {
                ...classification,
                reason: `${classification.reason}; win confirmation exceeded the declared incremental value limits`,
              };
            } else if (rerunAttributable) {
              reproduced = false;
              classification = { ...classification, reason: `${classification.reason}; win did not reproduce on a fresh same-task pair` };
            } else {
              classification = { ...classification, reason: `${classification.reason}; win confirmation evidence was not fully attributable` };
            }
          } else {
            const validNonRegression = rerunAttributable && (
              rerunClassification.result === 'harness-win' ||
              (rerunClassification.result === 'parity' && rerunEfficiency.withinThresholds === true)
            );
            if (rerunAttributable && rerunClassification.result === 'harness-regression') {
              reproduced = true;
            } else if (validNonRegression) {
              reproduced = false;
              classification = { ...classification, result: 'flaky-inconclusive', reason: 'regression did not reproduce on a fresh pair' };
            } else {
              classification = {
                ...classification,
                reason: `${classification.reason}; rerun did not establish a fully attributable policy-compliant non-regression — regression unresolved`,
              };
            }
          }
        }
      } else if (regressionNeedsConfirmation && exceptionalRerunAttempted) {
        classification = {
          ...classification,
          reason: `${classification.reason}; the one exceptional rerun allowance was already used — regression unresolved`,
        };
      }
      if (!primaryAttributable && ['harness-win', 'harness-regression'].includes(classification.result)) {
        classification = {
          ...classification,
          reason: `${classification.reason}; confirmation was not scheduled because primary causal evidence was incomplete`,
        };
      }
      const causallyAttributable = primaryAttributable;
      pairEntries.push({
        host,
        comparisonTrack: 'controlled-ablation',
        task: pair.task ?? null,
        pairId: pair.pairId ?? null,
        repetitionCount: pair.repetitionCount ?? pair.seedCount ?? null,
        failureKind: pair.failureKind ?? null,
        required,
        result: classification.result,
        reason: classification.reason,
        gateActive: gateActiveFor(host, controlledHost, calibrationRelease, releaseEligible, evaluationMode),
        reproduced,
        rerun: rerunEvidence,
        pairedOutcomes: classification.pairedOutcomes ?? null,
        causallyAttributable,
        classification,
        efficiencyDelta: primaryEfficiency,
        overheadAttribution: overheadAttribution(pair.generic, pair.harness),
        failureDiagnostics: Array.isArray(pair.failureDiagnostics) ? pair.failureDiagnostics : [],
        generic: pair.generic ?? null,
        harness: pair.harness ?? null,
      });
    }
  }

  await evaluatePair(controlledHost, steps.controlledPair ?? steps.kimiPair, {
    rerunFn: evaluationMode === 'qualification'
      ? null
      : (steps.rerunControlledPair ?? steps.rerunKimiPair),
    budget: budgets.controlledPair,
  });
  await evaluatePair('ollama-gemma', steps.gemmaPair);

  const controlledRuntimeTrials = runDocs
    .flatMap((doc) => rawTrials(doc))
    .filter((trial) => trial?.reproducibility?.host === controlledHost);
  const retainedReconciledSpendUsd = runDocs
    .flatMap((doc) => rawTrials(doc))
    .filter((trial) => String(trial?.reproducibility?.host ?? '').startsWith('openrouter'))
    .reduce((total, trial) => total + (finiteNumber(trial?.efficiency?.reconciledCostUsd) ?? 0), 0);
  const knownReconciledSpendUsd = budgets.release.knownReconciledSpendUsd();
  const retainedTrialSpentMicrousd = runtimeTrustRequired
    ? summedRuntimeTrialSpendMicrousd(controlledRuntimeTrials)
    : roundedMicrousd(retainedReconciledSpendUsd);
  const schedulerSpentMicrousd = roundedMicrousd(knownReconciledSpendUsd);

  let runtimeFinalEvidence = null;
  let runtimeFinalizationErrorHash = null;
  let runtimeFinalizationAttempted = false;
  if (runtimeTrustRequired && preflightOk && typeof steps?.runtimeSession?.finalize === 'function') {
    runtimeFinalizationAttempted = true;
    try {
      runtimeFinalEvidence = await steps.runtimeSession.finalize({
        releaseSha,
        harnessVersion,
        evaluationMode,
        pairs: structuredClone(pairEntries),
      });
    } catch (error) {
      runtimeFinalizationErrorHash = crypto.createHash('sha256')
        .update(String(error?.message ?? error))
        .digest('hex');
    }
  }
  let providerReconciliationAttempted = false;
  let providerReconciliationErrorHash = null;
  let rawProviderReconciliation = null;
  if (runtimeTrustRequired && runtimeFinalEvidence != null &&
      typeof steps?.runtimeSession?.providerEvidence === 'function') {
    providerReconciliationAttempted = true;
    try {
      rawProviderReconciliation = await steps.runtimeSession.providerEvidence();
    } catch (error) {
      providerReconciliationErrorHash = crypto.createHash('sha256')
        .update(String(error?.message ?? error))
        .digest('hex');
    }
  }
  const providerReconciliation = {
    attempted: providerReconciliationAttempted,
    ...providerReconciliationVerdict(rawProviderReconciliation, {
      runtimeSessionSpentMicrousd: runtimeFinalEvidence?.budget?.sessionSpentMicrousd ?? null,
      retainedTrialSpentMicrousd,
      schedulerSpentMicrousd,
    }),
    errorHash: providerReconciliationErrorHash,
  };
  const expectedRuntimeTrialHashes = controlledRuntimeTrials.map((trial) => {
    const evidence = trial?.observability?.runtimeTrustEvidence;
    return evidence?.schema === 'engineer-runtime-trial-final-attestation.v1' &&
      typeof evidence?.evidenceHash === 'string' && /^[a-f0-9]{64}$/.test(evidence.evidenceHash)
      ? evidence.evidenceHash
      : 'missing-or-invalid-runtime-trial-evidence';
  });
  const authenticatedFinalTrust = runtimeTrustRequired
    ? releaseTrustVerdict(config, runtimeFinalEvidence, {
        releaseSha,
        expectedTrialHashes: expectedRuntimeTrialHashes,
        expectedSessionId: runtimeReadiness?.sessionId ?? null,
        expectedBindings: config.runtimeTrustBindings ?? null,
        expectedSessionCeilingMicrousd: config.runtimeTrustBindings?.sessionCeilingMicrousd ?? null,
      })
    : trust;
  const finalTrust = runtimeTrustRequired && providerReconciliation.verified !== true
    ? {
        ...authenticatedFinalTrust,
        ok: false,
        status: 'blocked',
        providerAllowanceReconciled: false,
      }
    : runtimeTrustRequired
      ? { ...authenticatedFinalTrust, providerAllowanceReconciled: true }
      : authenticatedFinalTrust;
  if (runtimeTrustRequired) {
    releaseEligible = (evaluationMode === 'release' || calibrationEligible) &&
      configuredScopeValid && configuredScope.releaseEligible === true && finalTrust.ok;
    evaluationScope.releaseEligible = releaseEligible;
    evaluationScope.trust = finalTrust;
  }

  let rawNativeProducts = [];
  if (preflightOk && steps.nativeProducts) {
    try {
      rawNativeProducts = await steps.nativeProducts();
    } catch (error) {
      const reasonHash = crypto.createHash('sha256').update(String(error?.message ?? error)).digest('hex');
      rawNativeProducts = [{
        host: 'native-product-reference',
        status: 'invalid',
        telemetryAvailable: false,
        reason: `reference step failed (detail sha256:${reasonHash.slice(0, 16)})`,
      }];
    }
  }
  const nativeProducts = (rawNativeProducts ?? []).map((entry) => {
    const { generic: ignoredGeneric, harness: ignoredHarness, ...safe } = entry ?? {};
    if (ignoredGeneric != null || ignoredHarness != null) {
      return {
        host: String(entry?.host ?? 'unknown-native-product'),
        comparisonTrack: 'native-product-reference',
        status: 'invalid',
        telemetryAvailable: false,
        reason: 'native product references cannot be represented as controlled generic/harness arms',
      };
    }
    return { ...safe, comparisonTrack: 'native-product-reference' };
  });

  let smokes = [];
  if (preflightOk && steps.smokes) {
    try {
      smokes = await steps.smokes();
    } catch (error) {
      const reasonHash = crypto.createHash('sha256').update(String(error?.message ?? error)).digest('hex');
      smokes = [{ host: 'compatibility-smoke', ok: false, failed: [`step-failure-sha256:${reasonHash.slice(0, 16)}`] }];
    }
  }
  const coverage = controlledTaskCoverage(config, pairEntries, effectiveRequiredPairs);
  // Evidence is complete only when every run document validates AND every
  // required API pair actually metered its spend — an all-null efficiency
  // block is a missing measurement, not a measurement of nothing.
  const meteredOk = pairEntries.every((p) => {
    if (!p.required || p.result === 'skipped') return true;
    if (!p.generic || !p.harness) return false;
    return p.causallyAttributable === true && [p.generic, p.harness].every((doc) =>
      completePaidEvidence(doc, { passingReward: config.task?.verifierPassingReward ?? 1 })
    );
  });
  const rerunMeteredOk = pairEntries.every((pair) => {
    if (!pair.rerun || !String(pair.host).startsWith('openrouter')) return true;
    return pair.rerun.causallyAttributable === true &&
      [pair.rerun.generic, pair.rerun.harness].every((doc) => doc && completePaidEvidence(doc, {
        passingReward: config.task?.verifierPassingReward ?? 1,
      }));
  });
  const chargeLedgerToleranceUsd = Math.max(
    1e-12,
    1e-12 * Math.max(
      Math.abs(retainedReconciledSpendUsd),
      Math.abs(knownReconciledSpendUsd)
    )
  );
  const chargeLedgerMatchesRetainedEvidence = Math.abs(
    retainedReconciledSpendUsd - knownReconciledSpendUsd
  ) <= chargeLedgerToleranceUsd;
  const gateRunDocs = pairEntries
    .filter((pair) => pair.required || pair.gateActive)
    .flatMap((pair) => [
      pair.generic,
      pair.harness,
      pair.rerun?.generic,
      pair.rerun?.harness,
    ].filter(Boolean));
  const telemetryComplete = meteredOk && rerunMeteredOk && chargeLedgerMatchesRetainedEvidence &&
    gateRunDocs.every((doc) => validateAgainstSchema(doc, RUN_SCHEMA).ok);
  const diagnosticPairs = pairEntries
    .filter((pair) => !pair.required && !pair.gateActive)
    .map((pair) => {
      const documents = [
        pair.generic,
        pair.harness,
        pair.rerun?.generic,
        pair.rerun?.harness,
      ].filter(Boolean);
      const schemaValidRunDocuments = documents.filter((doc) => validateAgainstSchema(doc, RUN_SCHEMA).ok).length;
      const status = documents.length === 0
        ? 'unavailable'
        : schemaValidRunDocuments === documents.length && pair.causallyAttributable === true
          ? 'complete'
          : 'partial';
      return {
        host: pair.host,
        task: pair.task ?? null,
        status,
        runDocuments: documents.length,
        schemaValidRunDocuments,
        causallyAttributable: pair.causallyAttributable === true,
        reason: status === 'complete'
          ? null
          : documents.length === 0
            ? 'diagnostic pair produced no retained run documents'
            : 'diagnostic evidence is incomplete or not causally attributable',
      };
    });
  const diagnosticCoverage = {
    status: diagnosticPairs.length === 0
      ? 'unavailable'
      : diagnosticPairs.every((pair) => pair.status === 'complete')
        ? 'complete'
        : diagnosticPairs.every((pair) => pair.status === 'unavailable')
          ? 'unavailable'
          : 'partial',
    pairs: diagnosticPairs,
  };
  const claimEvidenceComplete = telemetryComplete && coverage.complete && releaseEligible;
  let gate = applyGatePolicy({
    deterministic,
    pairs: pairEntries,
    smokes,
    telemetryComplete,
    coverageComplete: coverage.complete,
    coverageReason: coverage.reason,
    taskLockOk: taskLock.ok !== false,
    environmentOk,
    budgetBreached: budgets.release.breached,
    calibrationRelease,
    preflight,
    evaluationMode,
    releaseTrustOk: runtimeTrustRequired ? finalTrust.ok : trustOk,
    releaseEligible,
  });
  if (!chargeLedgerMatchesRetainedEvidence) {
    gate = {
      block: true,
      reasons: [...new Set([
        ...gate.reasons,
        'provider charge ledger does not match retained reconciled trial evidence',
      ])],
    };
  }

  const taskSet = selectedTaskSet;
  const claim = buildClaim(pairEntries, claimEvidenceComplete, { releaseEligible });
  const readiness = initialShipReadiness(config, claim, pairEntries, { releaseEligible, calibrationRelease });
  if (readiness.ready === false && evaluationMode !== 'deterministic-only') {
    gate = {
      block: true,
      reasons: [...new Set([...gate.reasons, ...readiness.reasons.map((reason) => `initial ship readiness: ${reason}`)])],
    };
  }
  const uncertainReservedUsd = budgets.release.uncertainReservedUsd();
  const billingUncertain = uncertainReservedUsd > 0 || runDocs.some((doc) =>
    rawTrials(doc).some((trial) => trial?.efficiency?.billingUncertain === true || trial?.billingEvidence?.uncertain === true)
  );
  const enforcementSemantics = providerSpendGuard.verified
    ? 'provider-key-hard-limit-plus-conservative-scheduler'
    : 'scheduler-fail-stop-not-atomic-cash-guarantee';

  const reportPairs = pairEntries.map(({ required, ...entry }) => ({
    task: null,
    pairId: null,
    repetitionCount: null,
    failureKind: null,
    reproduced: null,
    rerun: null,
    pairedOutcomes: null,
    causallyAttributable: false,
    classification: null,
    efficiencyDelta: null,
    overheadAttribution: null,
    failureDiagnostics: [],
    generic: null,
    harness: null,
    ...entry,
  }));
  const qualificationPair = evaluationMode === 'qualification'
    ? reportPairs.find((pair) => pair.host === controlledHost) ?? null
    : null;
  const qualificationGenericPassed = singleRetainedVerifierPass(
    qualificationPair?.generic,
    config.task?.verifierPassingReward ?? 1
  );
  const qualificationHarnessPassed = singleRetainedVerifierPass(
    qualificationPair?.harness,
    config.task?.verifierPassingReward ?? 1
  );
  const qualification = evaluationMode === 'qualification' ? {
    capability: qualificationGenericPassed || qualificationHarnessPassed ? 'qualified' : 'inconclusive',
    passingArm: qualificationGenericPassed && qualificationHarnessPassed
      ? 'both'
      : qualificationGenericPassed
        ? 'generic'
        : qualificationHarnessPassed
          ? 'harness'
          : null,
    task: qualificationPair?.task ?? selectedTaskSet[0]?.task ?? null,
    reason: qualificationGenericPassed || qualificationHarnessPassed
      ? 'at least one controlled arm produced a verifier pass; full calibration may be attempted'
      : 'neither controlled arm produced a verifier pass; stop and select a different model tier',
  } : null;
  const report = {
    schema: 'eval-report.v2',
    harnessVersion,
    releaseSha,
    controlledLane: {
      host: controlledHost,
      profileId: controlledLane.profileId,
      billingProfileHash: billingProfileHash(controlledLane.profileId),
    },
    qualification,
    qualificationBaseline: config.qualificationBaseline ? {
      valid: config.qualificationBaseline.valid === true,
      capability: config.qualificationBaseline.capability ?? null,
      passingArm: config.qualificationBaseline.passingArm ?? null,
      evidenceHash: config.qualificationBaseline.evidenceHash ?? null,
      task: config.qualificationBaseline.task ?? null,
      accountedExposureUsd: config.qualificationBaseline.accountedExposureUsd ?? null,
      providerKeyFingerprint: config.qualificationBaseline.providerKeyFingerprint ?? null,
      reasons: Array.isArray(config.qualificationBaseline.reasons)
        ? config.qualificationBaseline.reasons
        : [],
    } : null,
    task: {
      datasetRef: config.task?.datasetRef ?? 'unknown',
      task: config.task?.task ?? 'unknown',
      taskChecksum: config.task?.taskChecksum ?? null,
      taskSet,
      requiredTaskSet,
    },
    evaluationScope,
    runtimeTrust: runtimeTrustRequired ? {
      required: true,
      readiness: {
        ...runtimeReadiness,
        errorHash: runtimeReadinessErrorHash,
      },
      finalization: {
        attempted: runtimeFinalizationAttempted,
        complete: finalTrust?.ok === true,
        evidenceHash: finalTrust?.evidenceHash ?? null,
        sessionId: finalTrust?.sessionId ?? null,
        finalizedTrialsAttested: finalTrust?.finalizedTrialsAttested === true,
        trialEvidenceMatched: finalTrust?.trialEvidenceMatched === true,
        orderedTrialHashes: finalTrust?.orderedTrialHashes ?? [],
        deletionReceiptHashes: finalTrust?.deletionReceiptHashes ?? [],
        chainHead: finalTrust?.chainHead ?? null,
        evidenceArchiveHash: finalTrust?.evidenceArchiveHash ?? null,
        errorHash: runtimeFinalizationErrorHash,
      },
      providerReconciliation,
    } : null,
    calibrationRelease,
    preflight,
    deterministic,
    telemetryComplete,
    diagnosticCoverage,
    coverage,
    pairs: reportPairs,
    nativeProducts,
    smokes,
    budget: {
      scope: 'provider-api-only',
      ceilingUsd: budgets.release.ceilingUsd,
      // `spentUsd` keeps its v1 meaning — TOTAL accounted exposure — so a
      // v1-era consumer can never read $0.50 while $8 of uncertain billing is
      // reserved. The reconciled/uncertain split is in the explicit fields.
      spentUsd: budgets.release.accountedExposureUsd(),
      knownReconciledSpendUsd,
      retainedReconciledSpendUsd,
      chargeLedgerMatchesRetainedEvidence,
      uncertainReservedUsd,
      accountedExposureUsd: budgets.release.accountedExposureUsd(),
      exhausted: budgets.release.exhausted,
      breached: budgets.release.breached,
      overrunUsd: budgets.release.overrunUsd(),
      providerSpendGuard,
      billingUncertain,
      enforcementSemantics,
      requestEstimateSemantics: 'utf8-byte-prompt-token-upper-bound-plus-max-output-at-pinned-rates',
      allocations: {
        controlledPairUsd: budgets.controlledPair.ceilingUsd,
        regressionRerunUsd: budgets.rerun.ceilingUsd,
        controlledArmCeilingUsd: config.budget?.controlledArmCeilingUsd ?? null,
      },
    },
    gate,
    claim,
    readiness,
    limitations: [
      'The pinned task set is a release canary, not a broad productivity benchmark.',
      'Native product runs (Codex, Claude Code, Pi, and similar agents) are reference evidence only and never substitute for a same-model controlled ablation.',
      'Prompt-and-CLI Terminal-Bench results do not establish the value or safety of mechanical hooks; enforcement fidelity is reported per run.',
      'Both arms share evaluator-level bounded tool results and automatic durable-state compaction. This ablation does not estimate the independent product value of those shared context controls; use a component ablation for that claim.',
      'The local Ollama pair is an informational capability probe until its model manifest, Ollama runtime, context settings, and hardware identity are attested; it is never part of the controlled release claim.',
      providerSpendGuard.verified
        ? (evaluationMode === 'calibration' && providerPolicy.continuityRequired
            ? 'Qualification and calibration share one continuity-bound dedicated no-reset provider key. Its hard limit is the cash backstop; scheduler estimates additionally fail-stop before requests and reconcile the larger local/provider amount.'
            : 'The provider API cash backstop is a fresh dedicated no-reset key limit; scheduler estimates additionally fail-stop before requests and reconcile the larger local/provider amount.')
        : 'The scheduler ceiling is not an atomic cash guarantee: one request or provider repricing can reconcile above it unless a dedicated provider-limited key is verified.',
      'The key hard limit governs only the continuity-bound credential. Attempts made with replacement credentials are outside this report and require an account-level cap or trusted durable ledger.',
      'The provider API ceiling does not include Daytona credit consumption, local electricity, or subscription opportunity cost; those require separate operator accounting.',
      evaluationMode === 'qualification'
        ? 'This qualification report establishes model capability only; a full trusted calibration is still required before publishing a release value claim.'
        : evaluationMode === 'calibration'
          ? 'This calibration report supports a release claim only when its trust, coverage, telemetry, budget, value, and readiness gates all pass.'
          : evaluationMode === 'release'
            ? 'This routine regression gate relies on a previously accepted calibration and does not re-establish initial Harness value.'
            : 'This diagnostic report is not release evidence; trusted qualification and calibration remain required before publishing measured ratio results.',
    ],
  };
  return { report, exitCode: gate.block ? 1 : 0 };
}

/* -------------------------------------------------------------- reporting -- */

/** The Eval Card in markdown, from a report object. */
export function buildMarkdownReport(report) {
  const taskNames = report.task.taskSet?.length
    ? report.task.taskSet.map((entry) => `\`${entry.task}\``).join(', ')
    : `\`${report.task.task}\``;
  const requiredTaskNames = report.task.requiredTaskSet?.length
    ? report.task.requiredTaskSet.map((entry) => `\`${entry.task}\``).join(', ')
    : taskNames;
  const evaluationMode = report.evaluationScope?.mode ?? 'legacy-unspecified';
  const releaseEligibility = report.evaluationScope
    ? report.evaluationScope.releaseEligible === true ? 'eligible' : 'not eligible'
    : 'legacy-unspecified';
  const preflightProblems = [
    ...(report.preflight?.environment?.missing ?? []),
    ...(report.preflight?.taskLock?.reason ? [report.preflight.taskLock.reason] : []),
  ];
  const trust = report.evaluationScope?.trust;
  const attributedPairs = report.pairs.filter((pair) => pair.overheadAttribution?.complete === true);
  const metricPairs = report.pairs.filter((pair) => pair.generic && pair.harness);
  const diagnosticPairs = report.pairs.filter((pair) => pair.failureDiagnostics?.length);
  const economicsPairs = metricPairs.filter((pair) => pair.generic?.economics || pair.harness?.economics);
  const number = (value, digits = 0) => Number.isFinite(value) ? Number(value).toFixed(digits) : 'unknown';
  const usd = (value) => Number.isFinite(value) ? `$${Number(value).toFixed(4)}` : 'unknown';
  const ratioSummary = (pair, key) => {
    const summary = pair.efficiencyDelta?.ratioDistribution?.[key];
    const value = pair.efficiencyDelta?.[key];
    if (!Number.isFinite(value)) return 'unknown';
    if (!summary || summary.count <= 1) return `${number(value, 2)}x`;
    return `${number(value, 2)}x [${number(summary.min, 2)}–${number(summary.max, 2)}]`;
  };
  const outcomeSummary = (pair) => {
    const counts = pair.pairedOutcomes?.counts;
    return counts
      ? `W${counts['harness-win'] ?? 0}/P${counts.parity ?? 0}/R${counts['harness-regression'] ?? 0}/FF${counts['inconclusive-capability'] ?? 0}`
      : 'unknown';
  };
  const componentSummary = (doc) => {
    const components = doc?.economics?.prompt?.manifest?.components;
    if (!Array.isArray(components) || !components.length) return 'unavailable';
    return components.map((component) => `${component.id}=${number(component.chars)}`).join(', ');
  };
  const phaseSummary = (doc) => ['memory-retrieval', 'memory-construction', 'memory-consolidation', 'task-execution']
    .map((name) => {
      const phase = name === 'task-execution'
        ? doc?.economics?.rollups?.[name]
        : doc?.economics?.phases?.[name];
      return `${name}:${phase?.status ?? 'unavailable'}/${number(phase?.promptTokens)}`;
    })
    .join(' · ');
  const lines = [
    `# Eval Card — Engineer Harness ${report.harnessVersion} (${report.releaseSha})`,
    '',
    `Task set: ${taskNames} (${report.task.datasetRef})${report.calibrationRelease ? ' — calibration release' : ''}`,
    `Required release task set: ${requiredTaskNames}.`,
    `Evaluation scope: ${evaluationMode} (${releaseEligibility} to green the release).`,
    ...(report.controlledLane
      ? [`Controlled lane: ${report.controlledLane.host} / ${report.controlledLane.profileId} (billing profile sha256:${report.controlledLane.billingProfileHash.slice(0, 16)}).`]
      : []),
    ...(report.qualification
      ? [`Qualification: **${report.qualification.capability}** (${report.qualification.passingArm ?? 'no passing arm'}) — ${report.qualification.reason}.`]
      : []),
    ...(report.qualificationBaseline
      ? [`Qualification baseline: ${report.qualificationBaseline.valid ? 'accepted' : 'rejected'}; ` +
          `${report.qualificationBaseline.passingArm ?? 'no passing arm'}; ` +
          `${usd(report.qualificationBaseline.accountedExposureUsd)} accounted exposure.`]
      : []),
    ...(trust ? [`Release trust: ${trust.ok === true ? 'attested' : `blocked (${(trust.missingCapabilities ?? []).join(', ')})`}.`] : []),
    ...(report.preflight ? [`Preflight: ${report.preflight.ok ? 'complete' : `failed (${preflightProblems.join('; ') || 'unspecified'})`}.`] : []),
    '',
    `Deterministic suite: ${report.deterministic.passed} passed, ${report.deterministic.failed} failed, ${report.deterministic.skipped} skipped.`,
    `Controlled task coverage: ${report.coverage?.complete === true ? 'complete' : `incomplete${report.coverage?.reason ? ` (${report.coverage.reason})` : ''}`}.`,
    `Telemetry completeness: ${report.telemetryComplete === true ? 'complete' : report.telemetryComplete === false ? 'incomplete' : 'legacy-unspecified'}.`,
    ...(report.diagnosticCoverage
      ? [`Informational diagnostic coverage: ${report.diagnosticCoverage.status}.`]
      : []),
    '',
    '| Host | Result | Gate | Reason |',
    '|---|---|---|---|',
    ...report.pairs.map((p) => {
      const gateLabel = p.gateActive
        ? 'active'
        : evaluationMode === 'qualification' && p.host === report.controlledLane?.host
          ? 'calibration prerequisite'
          : 'informational';
      return `| ${p.task ? `${p.host} (${p.task})` : p.host} | ${p.result} | ${gateLabel} | ${p.reason} |`;
    }),
    '',
    ...(metricPairs.length
      ? [
          '## Per-pair measurements',
          '',
          'Arm values are retained run summaries; ratio ranges are computed inside aligned repetitions before aggregation.',
          '',
          '| Host / task | Reps | Pass G/H | Requests G/H | Prompt tokens G/H | Cached tokens G/H | API cost G/H | Wall sec G/H |',
          '|---|---:|---|---|---|---|---|---|',
          ...metricPairs.map((pair) => {
            const g = pair.generic.efficiency ?? {};
            const h = pair.harness.efficiency ?? {};
            return `| ${pair.host} (${pair.task ?? 'unknown'}) | ${pair.repetitionCount ?? 1} | ` +
              `${pair.generic.correctness?.verdict ?? 'unknown'}/${pair.harness.correctness?.verdict ?? 'unknown'} | ` +
              `${number(g.modelRequests)}/${number(h.modelRequests)} | ` +
              `${number(g.promptTokens)}/${number(h.promptTokens)} | ` +
              `${number(g.cachedPromptTokens)}/${number(h.cachedPromptTokens)} | ` +
              `${usd(comparableCost(pair.generic))}/${usd(comparableCost(pair.harness))} | ` +
              `${number(Number.isFinite(g.wallTimeMs) ? g.wallTimeMs / 1000 : null, 1)}/${number(Number.isFinite(h.wallTimeMs) ? h.wallTimeMs / 1000 : null, 1)} |`;
          }),
          '',
          '| Host / task | Paired outcomes | Prompt ratio | Cost ratio | Wall ratio | Incremental value | Value policy |',
          '|---|---|---|---|---|---|---|',
          ...metricPairs.map((pair) => {
            const value = pair.efficiencyDelta?.valueEconomics ?? {};
            const valueText = value.additionalSuccesses > 0
              ? `${usd(value.costPerAdditionalSuccessUsd)} and ${number(Number.isFinite(value.wallTimePerAdditionalSuccessMs) ? value.wallTimePerAdditionalSuccessMs / 1000 : null, 1)}s per added success`
              : `${value.additionalSuccesses ?? 'unknown'} net added successes`;
            const policy = value.policyConfigured === true
              ? value.evidenceComplete !== true ? 'incomplete' : value.withinThresholds === true ? 'within limits' : 'outside limits'
              : 'not configured';
            return `| ${pair.host} (${pair.task ?? 'unknown'}) | ${outcomeSummary(pair)} | ` +
              `${ratioSummary(pair, 'promptRatio')} | ${ratioSummary(pair, 'costRatio')} | ` +
              `${ratioSummary(pair, 'wallTimeRatio')} | ${valueText} | ${policy} |`;
          }),
          '',
        ]
      : []),
    ...(economicsPairs.length
      ? [
          '## Prompt and memory economics',
          '',
          'Prompt components are exact serialized characters; phase token figures are whole-request provider usage and are never an invented component-token split.',
          '',
          ...economicsPairs.flatMap((pair) => [
            `- ${pair.host} (${pair.task ?? 'unknown'}) coverage G/H: ` +
              `${pair.generic?.economics?.coverage?.status ?? 'unavailable'}/` +
              `${pair.harness?.economics?.coverage?.status ?? 'unavailable'}; ` +
              `payload chars G/H: ${number(pair.generic?.economics?.prompt?.cumulative?.payloadChars)}/` +
              `${number(pair.harness?.economics?.prompt?.cumulative?.payloadChars)}.`,
            `  - Generic components: ${componentSummary(pair.generic)}.`,
            `  - Harness components: ${componentSummary(pair.harness)}.`,
            `  - Harness lifecycle phases (status/prompt tokens): ${phaseSummary(pair.harness)}.`,
          ]),
          '',
        ]
      : []),
    ...(diagnosticPairs.length
      ? [
          '## Failure diagnostics',
          '',
          ...diagnosticPairs.map((pair) =>
            `- ${pair.host} (${pair.task ?? 'unknown'}): ${pair.failureDiagnostics.map((entry) =>
              `${entry.condition ?? 'pair'}/r${entry.repetitionIndex ?? '?'} ${entry.stage}:${entry.code}` +
              `${entry.reasonHash ? ` sha256:${entry.reasonHash.slice(0, 16)}` : ''}`
            ).join('; ')}`
          ),
          '',
        ]
      : []),
    `Claim level: **${report.claim.level}** — ${report.claim.statement}`,
    ...(report.readiness?.ready != null
      ? [`Initial-ship readiness: **${report.readiness.ready ? 'ready' : 'not ready'}**${report.readiness.reasons.length ? ` — ${report.readiness.reasons.join('; ')}` : ''}.`]
      : []),
    '',
    ...(attributedPairs.length
      ? [
          '## Prompt-volume attribution',
          '',
          ...attributedPairs.map((pair) => {
            const delta = pair.overheadAttribution.delta;
            return `- ${pair.host} (${pair.task}): ${delta.payloadChars >= 0 ? '+' : ''}${Math.round(delta.payloadChars)} serialized chars; ` +
              `${delta.requestCount >= 0 ? '+' : ''}${delta.requestCount} requests; ` +
              `${Math.round(delta.requestCountEffectChars ?? 0)} chars from request count and ` +
              `${Math.round(delta.requestSizeEffectChars ?? 0)} from average request size. ` +
              `Component deltas: recurring system ${delta.baseSystemChars >= 0 ? '+' : ''}${Math.round(delta.baseSystemChars)}, ` +
              `instruction ${delta.instructionChars >= 0 ? '+' : ''}${Math.round(delta.instructionChars)}, ` +
              `tool schema ${delta.toolSchemaChars >= 0 ? '+' : ''}${Math.round(delta.toolSchemaChars)}, ` +
              `durable state ${delta.durableStateChars >= 0 ? '+' : ''}${Math.round(delta.durableStateChars)}, and ` +
              `other dynamic/framing ${delta.dynamicExcludingDurableChars >= 0 ? '+' : ''}${Math.round(delta.dynamicExcludingDurableChars)} chars ` +
              '(non-gating, tokenizer-independent).';
          }),
          '',
        ]
      : []),
    ...(report.nativeProducts?.length
      ? [
          `Native product references (separate, not causal): ${report.nativeProducts.map((entry) => `${entry.host} ${entry.status}`).join(' · ')}`,
          '',
        ]
      : []),
    ...(report.smokes.length
      ? [`Smokes: ${report.smokes.map((s) => `${s.host} ${s.ok ? 'ok' : `failed (${(s.failed ?? []).join(', ')})`}`).join(' · ')}`, '']
      : []),
    `Known reconciled provider API spend: $${Number(report.budget.knownReconciledSpendUsd ?? report.budget.spentUsd ?? 0).toFixed(2)}.`,
    `Accounted provider exposure: $${Number(report.budget.accountedExposureUsd ?? report.budget.spentUsd ?? 0).toFixed(2)} of $${report.budget.ceilingUsd.toFixed(2)} ceiling` +
      `${Number(report.budget.uncertainReservedUsd ?? 0) > 0 ? ` ($${Number(report.budget.uncertainReservedUsd).toFixed(2)} uncertain allowance reserved)` : ''}` +
      `${report.budget.breached === true ? ` (BREACHED by $${Number(report.budget.overrunUsd ?? 0).toFixed(2)})` : ''}.`,
    `Cash-control semantics: ${report.budget.enforcementSemantics ?? 'legacy-unspecified'}${report.budget.billingUncertain === true ? ' (BILLING UNCERTAIN; reserved allowance is exposure, not known spend)' : ''}.`,
    ...(Number.isFinite(report.budget.providerSpendGuard?.hardLimitUsd)
      ? [`Provider key guard: $${Number(report.budget.providerSpendGuard.hardLimitUsd).toFixed(2)} hard limit, ` +
          `$${Number(report.budget.providerSpendGuard.limitRemainingUsd ?? 0).toFixed(2)} remaining at preflight, ` +
          `$${Number(report.budget.providerSpendGuard.observedKeyConsumedUsd ?? 0).toFixed(2)} observed as prior same-key consumption` +
          `${report.budget.providerSpendGuard.keyFingerprint
            ? ` (continuity ${report.budget.providerSpendGuard.keyFingerprint.slice(0, 12)}…)`
            : ''}.`]
      : []),
    '',
    report.gate.block ? `**Release blocked:** ${report.gate.reasons.join('; ')}` : '**Release not blocked by evaluation gates.**',
    '',
    '## Limitations',
    ...(report.limitations ?? []).map((l) => `- ${l}`),
  ];
  return lines.join('\n');
}

/* -------------------------------------------------------------------- CLI -- */

function loadYamlConfig(profileName, { attestCommit = false } = {}) {
  const require = createRequire(fileURLToPath(new URL('../packages/harness/package.json', import.meta.url)));
  const YAML = require('yaml');
  if (typeof profileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profileName)) {
    throw new Error('--profile must be a safe configuration basename');
  }
  const configRoot = fileURLToPath(new URL('./config/', import.meta.url));
  const file = assertContainedRegularFile(path.join(configRoot, `${profileName}.yaml`), configRoot, 'evaluation profile');
  const bytes = attestCommit
    ? assertCommittedCheckoutFile(file, 'release-eligible evaluation profile')
    : fs.readFileSync(file);
  return YAML.parse(bytes.toString('utf8'));
}

function releaseRepository() {
  return fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
}

function releaseGitEnv() {
  const allowed = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const env = Object.fromEntries(
    allowed.filter((name) => typeof process.env[name] === 'string').map((name) => [name, process.env[name]])
  );
  env.PATH = process.platform === 'darwin'
    ? '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin'
    : '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function runReleaseGit(args, { encoding = 'utf8' } = {}) {
  const repository = releaseRepository();
  const gitMetadata = path.join(repository, '.git');
  let metadataEntry;
  try {
    metadataEntry = fs.lstatSync(gitMetadata);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('the code-owned checkout has no git metadata');
    }
    throw error;
  }
  if (metadataEntry.isSymbolicLink() || (!metadataEntry.isDirectory() && !metadataEntry.isFile())) {
    throw new Error('the code-owned checkout has invalid git metadata');
  }
  return spawnSync('git', [
    `--git-dir=${gitMetadata}`,
    `--work-tree=${repository}`,
    '-c',
    'core.fsmonitor=false',
    ...args,
  ], {
    cwd: repository,
    env: releaseGitEnv(),
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertContainedRegularFile(candidate, root, label) {
  const declaredRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (!isWithin(declaredRoot, resolved)) {
    throw new Error(`${label} must remain within ${declaredRoot}`);
  }

  const relative = path.relative(declaredRoot, resolved);
  let cursor = declaredRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let entry;
    try {
      entry = fs.lstatSync(cursor);
    } catch {
      throw new Error(`${label} does not exist: ${resolved}`);
    }
    if (entry.isSymbolicLink()) throw new Error(`${label} must not use symbolic links: ${resolved}`);
  }
  const entry = fs.lstatSync(resolved);
  if (!entry.isFile()) throw new Error(`${label} must be a regular file: ${resolved}`);
  const realRoot = fs.realpathSync(declaredRoot);
  const realFile = fs.realpathSync(resolved);
  if (!isWithin(realRoot, realFile)) throw new Error(`${label} resolves outside ${realRoot}`);
  return realFile;
}

function assertExternalRegularFile(candidate, label) {
  const resolved = path.resolve(candidate);
  let entry;
  try {
    entry = fs.lstatSync(resolved);
  } catch {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file: ${resolved}`);
  }
  return resolved;
}

/**
 * Read a prior evaluation artifact through a descriptor bound to the inode we
 * inspected. This protects the handoff from symlink/path-swap accidents and
 * prevents another local account from modifying evidence between phases. It
 * does not authenticate a trusted operator or turn the report digest into a
 * signature; that remains a runtime-supervisor/trust-store boundary.
 */
export function readPrivateEvidenceFile(candidate, label, { maximumBytes = 64 * 1024 * 1024 } = {}) {
  const resolved = assertExternalRegularFile(candidate, label);
  const before = fs.lstatSync(resolved);
  let handle;
  try {
    handle = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    const entry = fs.fstatSync(handle);
    if (!entry.isFile() || entry.dev !== before.dev || entry.ino !== before.ino) {
      throw new Error(`${label} changed while it was being opened`);
    }
    if (entry.nlink !== 1) throw new Error(`${label} must be a singly linked regular file`);
    if (typeof process.geteuid === 'function' && entry.uid !== process.geteuid()) {
      throw new Error(`${label} must be owned by the current user`);
    }
    if ((entry.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be accessible by group or other users`);
    }
    if (!Number.isInteger(maximumBytes) || maximumBytes <= 0 || entry.size <= 0 || entry.size > maximumBytes) {
      throw new Error(`${label} must be a nonempty report no larger than ${Math.floor(maximumBytes / (1024 * 1024))} MiB`);
    }
    return fs.readFileSync(handle);
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

function resolvePrivateReportDestination(reportFile) {
  if (typeof reportFile !== 'string' || reportFile.length === 0 || reportFile.includes('\0')) {
    throw new Error('--report-file requires a nonempty NUL-free path');
  }
  const resolved = path.resolve(reportFile);
  const parent = fs.realpathSync.native(path.dirname(resolved));
  const parentEntry = fs.statSync(parent);
  if (!parentEntry.isDirectory()) throw new Error('--report-file parent must be a directory');
  if (typeof process.geteuid === 'function' && parentEntry.uid !== process.geteuid()) {
    throw new Error('--report-file parent must be owned by the current user');
  }
  if ((parentEntry.mode & 0o022) !== 0) {
    throw new Error('--report-file parent must not be writable by group or other users');
  }
  return path.join(parent, path.basename(resolved));
}

function reservedDestinationMatches(reservation) {
  let entry;
  try {
    entry = fs.lstatSync(reservation.destination);
  } catch {
    return false;
  }
  return !entry.isSymbolicLink() && entry.isFile() && entry.nlink === 1 &&
    entry.dev === reservation.device && entry.ino === reservation.inode;
}

export function reservePrivateReport(reportFile) {
  const destination = resolvePrivateReportDestination(reportFile);
  try {
    const handle = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
    const entry = fs.fstatSync(handle);
    if (!entry.isFile() || entry.nlink !== 1) {
      fs.closeSync(handle);
      throw new Error('reserved report inode is not a singly linked regular file');
    }
    return {
      destination,
      handle,
      device: entry.dev,
      inode: entry.ino,
      closed: false,
      writeAttempted: false,
      written: false,
    };
  } catch (error) {
    throw new Error(`--report-file must name a new protected file: ${error.message}`);
  }
}

export function writeReservedPrivateReport(reservation, report, {
  writeImpl = fs.writeFileSync,
  fsyncImpl = fs.fsyncSync,
} = {}) {
  if (!reservation || reservation.closed === true || !Number.isInteger(reservation.handle)) {
    throw new Error('private report reservation is not open');
  }
  if (reservation.writeAttempted === true) throw new Error('private report reservation has already been used');
  const descriptor = fs.fstatSync(reservation.handle);
  if (descriptor.dev !== reservation.device || descriptor.ino !== reservation.inode ||
      descriptor.nlink !== 1 || !reservedDestinationMatches(reservation)) {
    throw new Error('private report destination is no longer bound to its reserved inode');
  }
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  reservation.writeAttempted = true;
  writeImpl(reservation.handle, bytes, 'utf8');
  fsyncImpl(reservation.handle);
  if (!reservedDestinationMatches(reservation)) {
    throw new Error('private report destination changed during archival');
  }
  reservation.written = true;
  return reservation.destination;
}

export function closePrivateReportReservation(reservation, { removeIncomplete = false } = {}) {
  if (!reservation || reservation.closed === true) return;
  let closeError = null;
  let cleanupError = null;
  try {
    fs.closeSync(reservation.handle);
  } catch (error) {
    closeError = error;
  } finally {
    // Cleanup must never replace the evaluation or archival failure that led
    // us here. Recording the close failure keeps it inspectable in tests and
    // by callers without allowing it to mask the primary error.
    reservation.closed = true;
    reservation.closeError = closeError;
  }
  if (removeIncomplete && reservation.written !== true) {
    if (reservedDestinationMatches(reservation)) {
      try {
        fs.unlinkSync(reservation.destination);
      } catch (error) {
        cleanupError = error;
        // The path was created by this process with O_EXCL. Cleanup failure is
        // secondary to the original evaluation/reporting failure.
      }
    }
  }
  reservation.cleanupError = cleanupError;
  return { closeError, cleanupError };
}

export function writePrivateReport(reportFile, report) {
  const reservation = reservePrivateReport(reportFile);
  try {
    return writeReservedPrivateReport(reservation, report);
  } finally {
    closePrivateReportReservation(reservation, { removeIncomplete: reservation.written !== true });
  }
}

export function shouldRetainReleaseWorkDir({ releaseTrustOk, workDir, archivalError }) {
  return releaseTrustOk === true && typeof workDir === 'string' && workDir.length > 0 && archivalError != null;
}

function assertCommittedCheckoutFile(file, label) {
  const repository = releaseRepository();
  if (!isWithin(repository, file)) throw new Error(`${label} must remain inside the code-owned checkout`);
  const relative = path.relative(repository, file).split(path.sep).join('/');
  const tracked = runReleaseGit(['ls-files', '--error-unmatch', '--', relative]);
  if (tracked.status !== 0) throw new Error(`${label} must be tracked in the code-owned checkout`);
  const committed = runReleaseGit(['show', `HEAD:${relative}`], { encoding: null });
  if (committed.status !== 0 || !Buffer.isBuffer(committed.stdout)) {
    throw new Error(`${label} could not be read from the current commit`);
  }
  if (!committed.stdout.equals(fs.readFileSync(file))) {
    throw new Error(`${label} must exactly match the current commit`);
  }
  return committed.stdout;
}

function resolveDefaultLockFile(lockFile, { attestCommit = false } = {}) {
  if (typeof lockFile !== 'string' || lockFile.length === 0 || path.isAbsolute(lockFile)) {
    throw new Error('the profile task lock must be a nonempty repository-relative path');
  }
  const repository = releaseRepository();
  const resolved = assertContainedRegularFile(path.resolve(repository, lockFile), repository, 'profile task lock');
  const bytes = attestCommit
    ? assertCommittedCheckoutFile(resolved, 'release-eligible task lock')
    : fs.readFileSync(resolved);
  return { path: resolved, bytes };
}

function currentGitReleaseSha() {
  const result = runReleaseGit(['rev-parse', '--verify', 'HEAD']);
  const sha = result.status === 0 ? result.stdout.trim() : '';
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) {
    throw new Error('--release-sha is required when the current git HEAD cannot be resolved');
  }
  return sha;
}

function assertCleanLiveReleaseSource() {
  const result = runReleaseGit(['status', '--porcelain=v1', '--untracked-files=all']);
  if (result.status !== 0) {
    throw new Error('live release source cleanliness could not be verified');
  }
  if (result.stdout.length > 0) {
    throw new Error('live release evaluation requires a clean git working tree, including no staged or untracked source');
  }
}

export function makeReleaseTreeRemovable(root) {
  if (!fs.existsSync(root)) return;
  const entry = fs.lstatSync(root);
  if (entry.isSymbolicLink()) return;
  // Unlink permission belongs to the parent directory. Never chmod a file:
  // an untrusted job artifact could be a hard link to an inode outside the
  // release work directory.
  if (!entry.isDirectory()) return;
  fs.chmodSync(root, 0o700);
  for (const name of fs.readdirSync(root)) makeReleaseTreeRemovable(path.join(root, name));
}

function removeReleaseWorkDir(workDir) {
  if (!workDir || !fs.existsSync(workDir)) return;
  makeReleaseTreeRemovable(workDir);
  fs.rmSync(workDir, { recursive: true, force: true });
}

const RELEASE_CLI_VALUE_FLAGS = new Set([
  '--profile', '--report-file', '--calibration-baseline', '--qualification-baseline',
  '--lock-file', '--release-sha', '--budget-usd', '--task', '--provider-key-fd',
]);
const RELEASE_CLI_BOOLEAN_FLAGS = new Set([
  '--calibration', '--qualification', '--deterministic-only', '--with-local', '--json',
]);
const RAW_PROVIDER_ENVIRONMENT = /^(?:OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GROQ_API_KEY|XAI_API_KEY|MISTRAL_API_KEY|COHERE_API_KEY|TOGETHER_API_KEY|FIREWORKS_API_KEY|DEEPSEEK_API_KEY|CEREBRAS_API_KEY|PERPLEXITY_API_KEY|HARNESS_EVAL_(?:AGENT|JUDGE)_KEY)$/i;
const USER_RUNTIME_PATH_ENVIRONMENT = /^(?:HARNESS_EVAL_(?:TB_(?:BUNDLE_(?:DIR|SHA256)|DATASET_DIR|ENV)|HARBOR_(?:BIN|SHA256)|DOCKER_(?:BIN|SHA256)|(?:BUILD_)?TOOL_PATH|NODE_TARBALL(?:_(?:X64|ARM64))?(?:_SHA256)?|HOST_NODE(?:_SHA256)?|.*(?:RUNTIME|SNAPSHOT|DAYTONA).*(?:BIN|DIR|FILE|PATH|SHA256))|DAYTONA_(?:CLI_)?PATH)$/i;

function validateReleaseCliArgv(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    throw new TypeError('release CLI argv must be an array of strings');
  }
  const counts = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!RELEASE_CLI_VALUE_FLAGS.has(token) && !RELEASE_CLI_BOOLEAN_FLAGS.has(token)) {
      if (/provider.*(?:key|credential)/i.test(token)) {
        throw new Error('provider credential material is accepted only through inherited --provider-key-fd');
      }
      if (/(?:bundle|runtime|snapshot|daytona|harbor|docker|dataset|node|tool|topology|environment).*(?:bin|dir|file|path|sha|image|mode|env)/i.test(token)) {
        throw new Error('runtime artifact paths and identities are code-owned and cannot be supplied on argv');
      }
      throw new Error(`unsupported release argument at argv position ${index + 1}`);
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
    if ((counts.get(token) ?? 0) > 1) throw new Error(`${token} may be supplied at most once`);
    if (RELEASE_CLI_VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        if (token === '--lock-file') {
          throw new Error('--lock-file requires a nonempty diagnostic lock path');
        }
        if (token === '--qualification-baseline' || token === '--calibration-baseline') {
          throw new Error(`${token} requires a nonempty report path`);
        }
        if (token === '--report-file') {
          throw new Error('--report-file requires a nonempty destination path');
        }
        throw new Error(`${token} requires a nonempty value`);
      }
      index += 1;
    }
  }
  return counts;
}

function providerKeyFdFrom(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('--provider-key-fd must be one canonical inherited descriptor number');
  }
  const descriptor = Number(value);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1_048_575 || String(descriptor) !== value) {
    throw new Error('--provider-key-fd must be one canonical inherited descriptor number between 3 and 1048575');
  }
  return descriptor;
}

function assertTrustedLauncherEnvironment(env) {
  if (env == null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('release CLI environment must be an object');
  }
  const names = Object.keys(env);
  if (names.some((name) => name.toUpperCase() === 'NODE_OPTIONS')) {
    throw new Error('trusted release launcher refuses ambient NODE_OPTIONS');
  }
  if (names.some((name) => RAW_PROVIDER_ENVIRONMENT.test(name))) {
    throw new Error('trusted release launcher refuses ambient raw provider credentials');
  }
  if (names.some((name) => USER_RUNTIME_PATH_ENVIRONMENT.test(name))) {
    throw new Error('trusted release runtime artifacts are code-owned and cannot be supplied through the environment');
  }
}

/** The exact task-image projection accepted by createReleaseRuntime. */
export function canonicalReleaseRuntimeTaskLock(lock) {
  if (lock == null || typeof lock !== 'object' || Array.isArray(lock) || !Array.isArray(lock.tasks)) {
    throw new Error('release runtime task lock must contain tasks');
  }
  return structuredClone({
    ...lock,
    tasks: lock.tasks.map((entry) => {
      const sandbox = entry?.sandbox;
      if (sandbox == null || typeof sandbox !== 'object' || Array.isArray(sandbox)) {
        throw new Error(`release runtime task ${entry?.task ?? 'unknown'} is missing its sandbox identity`);
      }
      return {
        ...entry,
        sandbox: {
          immutableImage: sandbox.immutableImage,
          imageId: sandbox.imageId,
          platform: sandbox.platform,
          cpus: sandbox.cpus,
          memoryMb: sandbox.memoryMb,
          storageMb: sandbox.storageMb,
        },
      };
    }),
  });
}

export function validateOfflineReleaseDataset(value, { sourceLock, workDir }) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('offline Terminal-Bench artifact preparation returned no evidence');
  }
  const fields = new Set([
    'artifactId', 'artifactDir', 'datasetDir', 'lockPath', 'attestationPath',
    'taskLockHash', 'taskLock', 'attestation', 'datasetTreeHash',
  ]);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new Error('offline Terminal-Bench artifact contains an unexpected or missing field');
  }
  const hash = /^[a-f0-9]{64}$/;
  for (const field of ['artifactId', 'taskLockHash', 'datasetTreeHash']) {
    if (!hash.test(String(value[field]))) throw new Error(`offline Terminal-Bench ${field} is invalid`);
  }
  const realWorkDir = fs.realpathSync(workDir);
  const artifactDir = fs.realpathSync(value.artifactDir);
  const datasetDir = fs.realpathSync(value.datasetDir);
  if (artifactDir === realWorkDir || !isWithin(realWorkDir, artifactDir) ||
      datasetDir === artifactDir || !isWithin(artifactDir, datasetDir) ||
      path.basename(artifactDir) !== value.artifactId) {
    throw new Error('offline Terminal-Bench artifact escaped its release-owned content address');
  }
  for (const [label, directory] of [['artifact', artifactDir], ['dataset', datasetDir]]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) {
      throw new Error(`offline Terminal-Bench ${label} directory is mutable or invalid`);
    }
  }
  const lockPath = assertContainedRegularFile(value.lockPath, value.artifactDir, 'offline task lock');
  const attestationPath = assertContainedRegularFile(
    value.attestationPath, value.artifactDir, 'offline dataset attestation'
  );
  const fileHash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (fileHash(lockPath) !== value.taskLockHash || fileHash(attestationPath) !== value.artifactId ||
      canonicalSha256(value.taskLock) !== value.taskLockHash) {
    throw new Error('offline Terminal-Bench lock or attestation content identity drifted');
  }
  if (value.taskLock?.datasetRef == null ||
      !/^terminal-bench-derived-offline@[a-f0-9]{12}$/.test(value.taskLock.datasetRef) ||
      value.attestation?.schema !== 'engineer-terminal-bench-offline-dataset-attestation.v1' ||
      value.attestation.label !== 'private-terminal-bench-derived-offline' ||
      value.attestation.publicLeaderboardEligible !== false ||
      value.attestation.networkRequiredAtTrial !== false ||
      value.attestation.taskLock?.sha256 !== value.taskLockHash) {
    throw new Error('offline Terminal-Bench trust label or task-lock binding drifted');
  }
  if (!Array.isArray(sourceLock?.tasks) || !Array.isArray(value.taskLock?.tasks) ||
      sourceLock.tasks.length !== value.taskLock.tasks.length) {
    throw new Error('offline Terminal-Bench task coverage drifted');
  }
  for (let index = 0; index < sourceLock.tasks.length; index += 1) {
    const source = structuredClone(sourceLock.tasks[index]);
    const derived = structuredClone(value.taskLock.tasks[index]);
    delete source.taskChecksum;
    delete derived.taskChecksum;
    if (!isDeepStrictEqual(source, derived) ||
        !hash.test(String(value.taskLock.tasks[index].taskChecksum))) {
      throw new Error('offline Terminal-Bench task identity or sandbox policy drifted');
    }
  }
  return Object.freeze({ ...value, artifactDir, datasetDir, lockPath, attestationPath });
}

export function releaseBudgetPolicyHash({
  evaluationMode,
  controlledLane,
  budget,
  repetitions,
  taskCount,
} = {}) {
  const microusd = (value, label, { nullable = false } = {}) => {
    if (nullable && value == null) return null;
    const converted = roundedMicrousd(value);
    if (converted == null) throw new Error(`${label} must be a bounded non-negative USD amount`);
    return converted;
  };
  if (typeof evaluationMode !== 'string' || evaluationMode.length === 0 ||
      typeof controlledLane?.host !== 'string' || typeof controlledLane?.profileId !== 'string' ||
      !Number.isSafeInteger(repetitions) || repetitions < 1 ||
      !Number.isSafeInteger(taskCount) || taskCount < 1) {
    throw new Error('release budget policy identity is incomplete');
  }
  const controlledAllowance = controlledPairAllowanceOf(budget ?? {});
  return canonicalSha256({
    schema: 'engineer-release-budget-policy.v1',
    evaluationMode,
    controlledHost: controlledLane.host,
    profileId: controlledLane.profileId,
    repetitions,
    taskCount,
    sessionCeilingMicrousd: microusd(budget?.releaseCeilingUsd, 'release ceiling'),
    controlledPairCeilingMicrousd: microusd(controlledAllowance.value, 'controlled-pair ceiling'),
    rerunCeilingMicrousd: microusd(budget?.rerunUsd, 'rerun ceiling'),
    controlledArmCeilingMicrousd: microusd(
      budget?.controlledArmCeilingUsd,
      'controlled-arm ceiling',
      { nullable: true }
    ),
    providerHardLimitMicrousd: microusd(
      budget?.providerHardLimitUsd,
      'provider hard limit',
      { nullable: true }
    ),
  });
}

function validatePreparedReleaseRuntimeArtifacts(artifacts, expected) {
  const bundle = artifacts?.bundle;
  // `bundleDir` is the production contract. The temporary `path` alias keeps
  // the seam easy to fake without allowing any caller-supplied runtime path.
  const bundleDir = bundle?.bundleDir ?? bundle?.path;
  const manifestHash = bundle?.manifestHash;
  const projection = artifacts?.runtimeProjection;
  const daytonaPath = artifacts?.daytonaPath;
  if (typeof bundleDir !== 'string' || !path.isAbsolute(bundleDir) || path.normalize(bundleDir) !== bundleDir ||
      bundleDir.includes('\0')) {
    throw new Error('code-owned release runtime bundle path is invalid');
  }
  if (typeof manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifestHash)) {
    throw new Error('code-owned release runtime bundle manifest hash is invalid');
  }
  if (projection == null || typeof projection !== 'object' || Array.isArray(projection)) {
    throw new Error('code-owned release runtime projection is missing');
  }
  const expectedProjectionBindings = {
    releaseSha: expected.releaseSha,
    taskLockHash: expected.taskLockHash,
    bundleHash: manifestHash,
    budgetPolicyHash: expected.budgetPolicyHash,
    brokerPolicyHash: expected.brokerPolicyHash,
    profileId: expected.profileId,
    sessionCeilingMicrousd: expected.sessionCeilingMicrousd,
  };
  for (const [field, value] of Object.entries(expectedProjectionBindings)) {
    if (projection?.bindings?.[field] !== value) {
      throw new Error(`code-owned release runtime projection ${field} binding drifted`);
    }
  }
  if (typeof daytonaPath !== 'string' || !path.isAbsolute(daytonaPath) ||
      path.normalize(daytonaPath) !== daytonaPath || daytonaPath.includes('\0')) {
    throw new Error('code-owned Daytona executable path is invalid');
  }
  if (typeof artifacts?.dispose !== 'function') {
    throw new Error('code-owned release runtime artifacts are missing their disposer');
  }
  return {
    ...artifacts,
    bundle: { bundleDir, manifestHash },
    runtimeProjection: structuredClone(projection),
    daytonaPath,
    dispose: artifacts.dispose,
  };
}

/**
 * Topology-independent seam. A reviewed code-owned factory is injected by the
 * production composition; no operator path or identity is accepted here.
 */
export async function prepareReleaseRuntimeArtifacts(context, {
  artifactFactory = null,
} = {}) {
  let factory = artifactFactory;
  if (factory == null) {
    const production = await import('./runtime/release-artifacts.mjs');
    factory = production.prepareReleaseRuntimeArtifacts;
  }
  if (typeof factory !== 'function') {
    throw new Error('trusted release runtime artifact factory is not configured in this checkout');
  }
  const prepared = await factory(context);
  try {
    return validatePreparedReleaseRuntimeArtifacts(prepared, context);
  } catch (error) {
    try {
      await prepared?.dispose?.();
    } catch (disposeError) {
      throw new Error(
        `${String(error?.message ?? error)}; invalid release artifacts also failed disposal: ` +
        String(disposeError?.message ?? disposeError)
      );
    }
    throw error;
  }
}

function releaseCliDependencies(overrides = {}) {
  return {
    loadYamlConfig,
    releaseRepository,
    currentGitReleaseSha,
    assertCleanLiveReleaseSource,
    assertExternalRegularFile,
    resolveDefaultLockFile,
    readPrivateEvidenceFile,
    readHarnessVersion: () => JSON.parse(
      fs.readFileSync(new URL('../packages/harness/package.json', import.meta.url), 'utf8')
    ).version,
    loadDeterministicRunner: () => import('./lib/runner.mjs'),
    loadTaskLockValidator: () => import('./external/terminal_bench/harbor-adapter.mjs'),
    buildOfflineDataset: async (input) => {
      const offline = await import('./external/terminal_bench/offline-artifacts.mjs');
      return offline.buildOfflineTerminalBenchDataset(input);
    },
    loadLiveSteps: () => import('./external/terminal_bench/live-steps.mjs'),
    prepareReleaseRuntimeArtifacts,
    runtimeArtifactFactory: null,
    createReleaseRuntime: async (input) => {
      const runtime = await import('./runtime/release-runtime.mjs');
      return runtime.createReleaseRuntime(input);
    },
    runRelease,
    validateReport: (report) => validateAgainstSchema(report, REPORT_SCHEMA),
    reservePrivateReport,
    writeReservedPrivateReport,
    closePrivateReportReservation,
    makeReleaseWorkDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-release-')),
    removeReleaseWorkDir,
    now: () => new Date(),
    ...overrides,
  };
}

export async function runReleaseCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = (value) => console.log(value),
  stderr = (value) => console.error(value),
  dependencies = {},
} = {}) {
  const argumentCounts = validateReleaseCliArgv(argv);
  const deps = releaseCliDependencies(dependencies);
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const profile = flag('--profile', 'release-canary');
  const calibrationRelease = argv.includes('--calibration');
  const qualificationRelease = argv.includes('--qualification');
  const deterministicOnly = argv.includes('--deterministic-only');
  if (calibrationRelease && qualificationRelease) {
    throw new Error('--qualification and --calibration are mutually exclusive');
  }
  const withLocal = argv.includes('--with-local');
  const json = argv.includes('--json');
  const providerKeyFdFlagPresent = argv.includes('--provider-key-fd');
  const providerKeyFdValue = flag('--provider-key-fd', null);
  const reportFileFlagPresent = argv.includes('--report-file');
  let reportFile = flag('--report-file', null);
  if (reportFileFlagPresent && (
    typeof reportFile !== 'string' || reportFile.length === 0 || reportFile.startsWith('--')
  )) {
    throw new Error('--report-file requires a nonempty destination path');
  }
  if (reportFileFlagPresent) {
    reportFile = resolvePrivateReportDestination(reportFile);
    if (isWithin(deps.releaseRepository(), reportFile)) {
      throw new Error('--report-file must be outside the source repository');
    }
  }
  const calibrationBaselineFlagPresent = argv.includes('--calibration-baseline');
  const calibrationBaselineFile = flag('--calibration-baseline', null);
  if (calibrationBaselineFlagPresent && (
    typeof calibrationBaselineFile !== 'string' || calibrationBaselineFile.length === 0 || calibrationBaselineFile.startsWith('--')
  )) {
    throw new Error('--calibration-baseline requires a nonempty report path');
  }
  const qualificationBaselineFlagPresent = argv.includes('--qualification-baseline');
  const qualificationBaselineFile = flag('--qualification-baseline', null);
  if (qualificationBaselineFlagPresent && (
    typeof qualificationBaselineFile !== 'string' || qualificationBaselineFile.length === 0 ||
    qualificationBaselineFile.startsWith('--')
  )) {
    throw new Error('--qualification-baseline requires a nonempty report path');
  }
  const lockFileFlagPresent = argv.includes('--lock-file');
  const lockFileFlag = flag('--lock-file', null); // bootstrap/test hook; default is the committed lock
  if (lockFileFlagPresent && (
    typeof lockFileFlag !== 'string' || lockFileFlag.length === 0 || lockFileFlag.startsWith('--')
  )) {
    throw new Error('--lock-file requires a nonempty diagnostic lock path');
  }
  const releaseShaFlagPresent = argv.includes('--release-sha');
  const explicitReleaseSha = flag('--release-sha', null);
  if (releaseShaFlagPresent && (
    typeof explicitReleaseSha !== 'string' || !/^[a-f0-9]{7,64}$/i.test(explicitReleaseSha)
  )) {
    throw new Error('--release-sha requires a hexadecimal commit/content identity');
  }
  let releaseSha;
  if (deterministicOnly) {
    // Free local/PR checks may intentionally exercise an uncommitted tree and
    // retain support for an explicit content label. They publish no live
    // causal claim and never build or accept a release bundle.
    releaseSha = explicitReleaseSha ?? deps.currentGitReleaseSha();
  } else {
    const currentHead = deps.currentGitReleaseSha();
    if (explicitReleaseSha && (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(explicitReleaseSha) ||
      explicitReleaseSha.toLowerCase() !== currentHead.toLowerCase()
    )) {
      throw new Error('--release-sha for a live evaluation must be the full current git HEAD');
    }
    deps.assertCleanLiveReleaseSource();
    releaseSha = currentHead;
  }

  const raw = deps.loadYamlConfig(profile, { attestCommit: !deterministicOnly });
  const claimMode = raw.claimPolicy?.mode ?? 'regression-gate';
  if ((qualificationRelease || calibrationRelease) && claimMode !== 'initial-user-ship') {
    const phase = qualificationRelease ? '--qualification' : '--calibration';
    throw new Error(`invalid release invocation: ${phase} requires an initial-user-ship profile`);
  }
  const lockSource = lockFileFlagPresent
    ? (() => {
        const file = deps.assertExternalRegularFile(lockFileFlag, 'explicit task lock');
        return { path: file, bytes: fs.readFileSync(file) };
      })()
    : deps.resolveDefaultLockFile(raw.task?.lockFile, { attestCommit: !deterministicOnly });
  let completeLock;
  try {
    completeLock = JSON.parse(lockSource.bytes.toString('utf8'));
  } catch {
    throw new Error('task lock is not valid JSON');
  }
  const qualificationCeilingUsd = Number(raw.budget?.qualificationPairUsd);
  const calibrationCeilingUsd = Number(raw.budget?.calibrationCeilingUsd);
  const defaultBudgetUsd = qualificationRelease
    ? qualificationCeilingUsd
    : calibrationRelease
      ? calibrationCeilingUsd
      : raw.budget.releaseCeilingUsd;
  const budgetUsd = Number(flag('--budget-usd', defaultBudgetUsd));
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > MAX_RELEASE_API_USD) {
    throw new Error(`--budget-usd must be between 0 and ${MAX_RELEASE_API_USD}, got: ${flag('--budget-usd')}`);
  }
  const modeCeilingUsd = qualificationRelease
    ? qualificationCeilingUsd
    : calibrationRelease
      ? calibrationCeilingUsd
      : Number(raw.budget.releaseCeilingUsd);
  if (!Number.isFinite(modeCeilingUsd) || budgetUsd > modeCeilingUsd + 1e-12) {
    throw new Error(
      `--budget-usd exceeds the $${modeCeilingUsd} ceiling for this evaluation mode`
    );
  }
  const lockedTasks = completeLock.tasks ?? (
    completeLock.task
      ? [{ task: completeLock.task, taskChecksum: completeLock.taskChecksum, role: 'anchor' }]
      : []
  );
  const taskFlagPresent = argv.includes('--task');
  const explicitRequestedTask = flag('--task', null);
  if (taskFlagPresent && (
    typeof explicitRequestedTask !== 'string' || explicitRequestedTask.length === 0 || explicitRequestedTask.startsWith('--')
  )) {
    throw new Error('--task requires a nonempty pinned task value');
  }
  if (qualificationRelease && taskFlagPresent) {
    throw new Error('--qualification uses the code-owned qualificationTask and cannot be combined with --task');
  }
  const requestedTask = qualificationRelease
    ? raw.claimPolicy?.qualificationTask
    : explicitRequestedTask;
  if (qualificationRelease && (typeof requestedTask !== 'string' || requestedTask.length === 0)) {
    throw new Error('--qualification requires claimPolicy.qualificationTask');
  }
  if (requestedTask && !lockedTasks.some((entry) => entry.task === requestedTask)) {
    throw new Error(`--task ${requestedTask} is not a pinned task in the selected lock`);
  }
  const selectedTasks = requestedTask ? lockedTasks.filter((entry) => entry.task === requestedTask) : lockedTasks;
  const lock = { ...completeLock, tasks: selectedTasks };
  delete lock.task;
  delete lock.taskChecksum;
  const taskSet = selectedTasks.map(
    ({ task, taskChecksum = null, role = null, sandbox = null }) => ({ task, taskChecksum, role, sandbox })
  );
  const requiredTaskSet = (qualificationRelease ? selectedTasks : lockedTasks).map(
    ({ task, taskChecksum = null, role = null, sandbox = null }) => ({ task, taskChecksum, role, sandbox })
  );
  const runtimeArming = releaseRuntimeArmingVerdict(raw);
  const runtimeRequired = !deterministicOnly && runtimeArming.ok;
  if (!runtimeRequired && providerKeyFdFlagPresent) {
    throw new Error('--provider-key-fd is forbidden for deterministic or unarmed release evaluation');
  }
  let providerKeyFd = null;
  if (runtimeRequired) {
    if ((argumentCounts.get('--provider-key-fd') ?? 0) !== 1) {
      throw new Error('armed paid OpenRouter evaluation requires exactly one --provider-key-fd');
    }
    if ((argumentCounts.get('--report-file') ?? 0) !== 1) {
      throw new Error('armed paid OpenRouter evaluation requires exactly one --report-file');
    }
    providerKeyFd = providerKeyFdFrom(providerKeyFdValue);
    assertTrustedLauncherEnvironment(env);
  }
  // Final trust always starts blocked. Only runRelease may replace this with
  // the branded final session after paid work and cleanup reconcile.
  const releaseTrust = releaseTrustVerdict(raw, null);
  const invocationPolicy = releaseInvocationPolicy({
    claimMode,
    calibrationRelease,
    qualificationRelease,
    diagnosticScope: deterministicOnly || (!qualificationRelease && Boolean(requestedTask)) || lockFileFlagPresent,
    trustOk: runtimeArming.ok,
  });
  if (!invocationPolicy.ok) {
    throw new Error(`invalid release invocation: ${invocationPolicy.reasons.join('; ')}`);
  }
  const harnessVersion = deps.readHarnessVersion();
  const minimumCalibrationRepetitions = releaseMinimumCalibrationRepetitions(raw);
  const historicalBaselineChain = !qualificationRelease && !calibrationRelease &&
    raw.claimPolicy?.mode === 'regression-gate' &&
    raw.claimPolicy?.requireCalibrationBaseline === true;
  let qualificationBaseline = null;
  if (qualificationBaselineFlagPresent) {
    if (qualificationRelease) throw new Error('--qualification cannot consume an earlier qualification baseline');
    const bytes = deps.readPrivateEvidenceFile(qualificationBaselineFile, 'qualification baseline');
    let baselineReport;
    try {
      baselineReport = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('qualification baseline is not valid JSON');
    }
    qualificationBaseline = qualificationBaselineVerdict(baselineReport, {
      evidenceHash: crypto.createHash('sha256').update(bytes).digest('hex'),
      releaseSha: historicalBaselineChain ? baselineReport?.releaseSha ?? null : releaseSha,
      harnessVersion: historicalBaselineChain ? baselineReport?.harnessVersion ?? null : harnessVersion,
      controlledLane: controlledLaneOf(raw),
      qualificationTask: raw.claimPolicy?.qualificationTask ?? null,
      requiredTaskSet: lockedTasks.filter((entry) => entry.task === raw.claimPolicy?.qualificationTask),
      requiredTaskRevision: completeLock.datasetRef ?? null,
      maximumQualificationUsd: historicalBaselineChain
        ? MAX_QUALIFICATION_API_USD
        : raw.budget?.qualificationPairUsd ?? MAX_QUALIFICATION_API_USD,
      controlledArmCeilingUsd: raw.budget?.controlledArmCeilingUsd ?? null,
      expectedProviderHardLimitUsd: historicalBaselineChain
        ? MAX_RELEASE_API_USD
        : raw.budget?.providerHardLimitUsd ?? null,
      verifierPassingReward: completeLock.verifier?.passingReward ?? 1,
    });
    if (!qualificationBaseline.valid) {
      throw new Error(`qualification baseline is not eligible: ${qualificationBaseline.reasons.join('; ')}`);
    }
  }
  if (calibrationRelease && raw.claimPolicy?.requireQualificationBaseline === true && !qualificationBaseline?.valid) {
    throw new Error('--calibration requires --qualification-baseline with at least one verifier-passing arm');
  }
  let calibrationBaseline = null;
  if (calibrationBaselineFlagPresent) {
    const bytes = deps.readPrivateEvidenceFile(calibrationBaselineFile, 'calibration baseline');
    let baselineReport;
    try {
      baselineReport = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('calibration baseline is not valid JSON');
    }
    calibrationBaseline = calibrationBaselineVerdict(baselineReport, {
      evidenceHash: crypto.createHash('sha256').update(bytes).digest('hex'),
      releaseSha: historicalBaselineChain ? qualificationBaseline?.releaseSha ?? null : releaseSha,
      harnessVersion: historicalBaselineChain ? qualificationBaseline?.harnessVersion ?? null : harnessVersion,
      requiredTaskSet,
      minimumRepetitions: minimumCalibrationRepetitions,
      minimumHarnessSolvedTasks: raw.claimPolicy?.minimumHarnessSolvedTasks ?? 1,
      efficiencyThresholds: raw.efficiencyThresholds,
      valueThresholds: raw.valueThresholds,
      controlledArmCeilingUsd: raw.budget?.controlledArmCeilingUsd ?? null,
      controlledLane: controlledLaneOf(raw),
      expectedProviderHardLimitUsd: historicalBaselineChain
        ? MAX_RELEASE_API_USD
        : raw.budget?.providerHardLimitUsd ?? null,
      expectedProviderKeyFingerprint: qualificationBaseline?.providerKeyFingerprint ?? null,
      maximumCalibrationUsd: historicalBaselineChain
        ? MAX_CALIBRATION_API_USD
        : raw.budget?.calibrationCeilingUsd ?? MAX_CALIBRATION_API_USD,
      verifierPassingReward: completeLock.verifier?.passingReward ?? 1,
    });
    if (!calibrationBaseline.valid) {
      throw new Error(`calibration baseline is not eligible: ${calibrationBaseline.reasons.join('; ')}`);
    }
  } else if (raw.claimPolicy?.requireCalibrationBaseline === true) {
    calibrationBaseline = {
      required: true,
      valid: false,
      evidenceHash: null,
      releaseSha: null,
      harnessVersion: null,
      minimumRepetitions: minimumCalibrationRepetitions,
      reasons: ['no calibration baseline was supplied'],
    };
  }
  if (historicalBaselineChain && runtimeArming.ok &&
      (!qualificationBaseline?.valid || !calibrationBaseline?.valid)) {
    throw new Error(
      'routine evaluation requires the accepted historical --qualification-baseline and --calibration-baseline chain'
    );
  }
  if (!calibrationRelease && !historicalBaselineChain && runtimeArming.ok &&
      raw.claimPolicy?.requireCalibrationBaseline === true && !calibrationBaseline?.valid) {
    throw new Error('routine initial-user-ship evaluation requires --calibration-baseline from the same trusted release');
  }
  const evaluationMode = deterministicOnly
    ? 'deterministic-only'
    : lockFileFlagPresent
      ? 'diagnostic-lock'
      : qualificationRelease
        ? 'qualification'
      : requestedTask
        ? 'diagnostic-task'
        : !runtimeArming.ok
          ? 'diagnostic-trust'
        : calibrationRelease
          ? 'calibration'
        : 'release';
  const config = {
    controlledLane: controlledLaneOf(raw),
    releaseTrust: structuredClone(raw.releaseTrust ?? { status: 'blocked', capabilities: {} }),
    runtimeTrustRequired: runtimeRequired,
    budget: qualificationRelease
      ? {
          releaseCeilingUsd: budgetUsd,
          controlledPairUsd: budgetUsd,
          rerunUsd: 0,
          controlledArmCeilingUsd: Number(raw.budget?.controlledArmCeilingUsd),
          qualificationPairUsd: qualificationCeilingUsd,
          calibrationCeilingUsd,
          ...(raw.budget?.providerHardLimitUsd != null
            ? { providerHardLimitUsd: Number(raw.budget.providerHardLimitUsd) }
            : {}),
        }
      : {
          ...scaleReleaseBudget(raw.budget, budgetUsd),
          // Initial qualification/calibration phases share the configured
          // $20 provider key. Regression-profile routine/diagnostic runs use
          // an exact key cap equal to the operator-selected scheduler ceiling.
          providerHardLimitUsd: raw.claimPolicy?.mode === 'initial-user-ship'
            ? Number(raw.budget?.providerHardLimitUsd ?? budgetUsd)
            : budgetUsd,
        },
    task: {
      datasetRef: lock.datasetRef,
      task: taskSet.length === 1 ? taskSet[0].task : 'multi-task-canary',
      taskChecksum: taskSet.length === 1 ? taskSet[0].taskChecksum : null,
      taskSet,
      requiredTaskSet,
      verifierPassingReward: completeLock.verifier?.passingReward ?? 1,
    },
    evaluationScope: {
      mode: evaluationMode,
      releaseEligible: evaluationMode === 'release' ||
        (evaluationMode === 'calibration' && raw.claimPolicy?.mode === 'initial-user-ship'),
      trust: releaseTrust,
    },
    efficiencyThresholds: raw.efficiencyThresholds ?? DEFAULT_EFFICIENCY_THRESHOLDS,
    valueThresholds: raw.valueThresholds ?? {},
    claimPolicy: raw.claimPolicy ?? { mode: 'regression-gate' },
    calibrationBaseline,
    qualificationBaseline,
  };
  if (calibrationRelease && qualificationBaseline?.valid === true &&
      budgetUsd + qualificationBaseline.accountedExposureUsd > MAX_RELEASE_API_USD + 1e-12) {
    throw new Error('qualification exposure plus calibration ceiling exceeds the absolute $20 initial-evidence budget');
  }
  const configuredArmCeiling = Number(config.budget.controlledArmCeilingUsd);
  const scheduledRepetitions = qualificationRelease ? 1 : releaseRepetitionCount(raw, calibrationRelease);
  if (runtimeArming.ok && Number.isFinite(configuredArmCeiling) && configuredArmCeiling > 0) {
    const { primaryExposureUsd: primaryExposure, rerunExposureUsd: rerunExposure } = releaseScheduledExposure({
      taskCount: taskSet.length,
      repetitions: scheduledRepetitions,
      controlledArmCeilingUsd: configuredArmCeiling,
      rerunEnabled: !qualificationRelease && config.budget.rerunUsd > 0,
    });
    const controlledAllowance = controlledPairAllowanceOf(config.budget).value;
    if (primaryExposure > controlledAllowance + 1e-12 || rerunExposure > config.budget.rerunUsd + 1e-12) {
      throw new Error(
        `selected budget cannot preserve the fixed $${configuredArmCeiling} per-arm condition ` +
        `(${primaryExposure.toFixed(2)} primary / ${rerunExposure.toFixed(2)} rerun required)`
      );
    }
  }
  const configVerdict = validateReleasePolicyConfig(config);
  if (!configVerdict.ok) {
    throw new Error(`invalid release evaluation policy: ${configVerdict.errors.join('; ')}`);
  }
  const { runEvals, summarize } = await deps.loadDeterministicRunner();
  const deterministicStep = async () => {
    const summary = summarize(await runEvals({
      provider: null,
      agentMode: 'scripted',
      writeJobs: false,
    }));
    return { passed: summary.passed, failed: summary.failed + summary.infrastructureErrors, skipped: summary.skipped };
  };

  // Reserve the destination inode before any runtime construction can take
  // ownership of the inherited provider credential descriptor.
  const reportReservation = reportFileFlagPresent ? deps.reservePrivateReport(reportFile) : null;
  let steps = null;
  let requiredPairs = null;
  let releaseWorkDir = null;
  let runtime = null;
  let artifacts = null;
  let runtimeDisposeAttempted = false;
  let runtimeDisposeError = null;
  let artifactDisposeAttempted = false;
  let artifactDisposeError = null;
  let ownedResourcesDisposeAttempted = false;
  let ownedResourcesDisposeError = null;
  let completedReport = null;
  let preserveReleaseWorkDir = false;

  const disposeRuntime = async () => {
    if (!runtime || runtimeDisposeAttempted) {
      if (runtimeDisposeError) throw runtimeDisposeError;
      return;
    }
    runtimeDisposeAttempted = true;
    try {
      await runtime.dispose();
    } catch (error) {
      runtimeDisposeError = error;
      throw error;
    }
  };

  const disposeArtifacts = async () => {
    if (!artifacts || artifactDisposeAttempted) {
      if (artifactDisposeError) throw artifactDisposeError;
      return;
    }
    artifactDisposeAttempted = true;
    try {
      await artifacts.dispose();
    } catch (error) {
      artifactDisposeError = error;
      throw error;
    }
  };

  const disposeOwnedResources = async () => {
    if (ownedResourcesDisposeAttempted) {
      if (ownedResourcesDisposeError) throw ownedResourcesDisposeError;
      return;
    }
    ownedResourcesDisposeAttempted = true;
    const errors = [];
    try {
      await disposeRuntime();
    } catch (error) {
      errors.push(`runtime: ${String(error?.message ?? error)}`);
    }
    try {
      // Artifact disposal intentionally follows runtime disposal: the runtime
      // may still need the bundle and executable identities while shutting down.
      await disposeArtifacts();
    } catch (error) {
      errors.push(`artifacts: ${String(error?.message ?? error)}`);
    }
    if (errors.length > 0) {
      ownedResourcesDisposeError = new Error(`release-owned resource disposal failed (${errors.join('; ')})`);
      throw ownedResourcesDisposeError;
    }
  };

  try {
    if (!runtimeRequired) {
      // Deterministic and red-trust paths are structurally useful but never
      // construct a key-bearing runtime or schedule provider work.
      const { validateTaskLock } = await deps.loadTaskLockValidator();
      steps = {
        deterministic: deterministicStep,
        environment: async () => deterministicOnly
          ? ({ ok: true, missing: [] })
          : ({
              ok: false,
              missing: runtimeArming.missingCapabilities.map(
                (capability) => `unattested release trust: ${capability}`
              ),
            }),
        taskLock: async () => {
          const verdict = validateTaskLock(lock);
          return { ok: verdict.ok, reason: verdict.errors.join('; ') };
        },
        frontierPair: null,
        nativeProducts: null,
        controlledPair: null,
        gemmaPair: null,
        smokes: null,
      };
      requiredPairs = deterministicOnly ? [] : [config.controlledLane.host];
    } else {
      releaseWorkDir = deps.makeReleaseWorkDir();
      const offlineDataset = validateOfflineReleaseDataset(await deps.buildOfflineDataset({
        repoRoot: deps.releaseRepository(),
        outputRoot: path.join(releaseWorkDir, 'offline-terminal-bench'),
        taskLock: structuredClone(lock),
      }), { sourceLock: lock, workDir: releaseWorkDir });
      const runtimeTaskLock = canonicalReleaseRuntimeTaskLock(offlineDataset.taskLock);
      const taskLockHash = canonicalSha256(runtimeTaskLock);
      const sessionCeilingMicrousd = roundedMicrousd(config.budget.releaseCeilingUsd);
      if (!Number.isSafeInteger(sessionCeilingMicrousd) || sessionCeilingMicrousd < 1) {
        throw new Error('armed paid release requires a positive integer-microusd session ceiling');
      }
      const budgetPolicyHash = releaseBudgetPolicyHash({
        evaluationMode,
        controlledLane: config.controlledLane,
        budget: config.budget,
        repetitions: scheduledRepetitions,
        taskCount: taskSet.length,
      });
      const brokerPolicyHash = controlledProviderBrokerStaticPolicyHash({
        profileId: config.controlledLane.profileId,
        sessionCeilingMicrousd,
      });
      const budgetId = `release-${evaluationMode}-${budgetPolicyHash.slice(0, 24)}`;
      const artifactContext = {
        repoRoot: deps.releaseRepository(),
        releaseSha,
        sourceIdentity: { releaseSha, harnessVersion },
        taskLock: structuredClone(runtimeTaskLock),
        taskLockHash,
        budgetPolicyHash,
        brokerPolicyHash,
        profileId: config.controlledLane.profileId,
        sessionCeilingMicrousd,
      };
      artifacts = await deps.prepareReleaseRuntimeArtifacts(artifactContext, {
        artifactFactory: deps.runtimeArtifactFactory,
      });
      // Revalidate the dependency seam even when a test or embedding replaces
      // the production preparer. Assign first so malformed results with a
      // disposer are still reclaimed by the catch path.
      artifacts = validatePreparedReleaseRuntimeArtifacts(artifacts, artifactContext);
      const runtimeTrustBindings = {
        releaseSha,
        profileId: config.controlledLane.profileId,
        taskLockHash,
        bundleHash: artifacts.bundle.manifestHash,
        budgetId,
        budgetPolicyHash,
        brokerPolicyHash,
        sessionCeilingMicrousd,
      };
      config.runtimeTrustBindings = structuredClone(runtimeTrustBindings);

      runtime = await deps.createReleaseRuntime({
        releaseSha,
        profileId: config.controlledLane.profileId,
        taskLock: runtimeTaskLock,
        bundle: {
          bundleDir: artifacts.bundle.bundleDir,
          manifestHash: artifacts.bundle.manifestHash,
        },
        budgetId,
        budgetPolicyHash,
        brokerPolicyHash,
        sessionCeilingMicrousd,
        providerKeyFd,
        daytonaPath: artifacts.daytonaPath,
        runtimeProjection: artifacts.runtimeProjection,
        env: { ...env },
      });
      if (!runtime || typeof runtime.dispose !== 'function' || typeof runtime.trialExecutor !== 'function' ||
          !runtime.providerControl || !runtime.runtimeSession) {
        throw new Error('release runtime construction returned an incomplete controller');
      }

      const { buildLiveSteps } = await deps.loadLiveSteps();
      const liveEnv = {
        ...env,
        HARNESS_EVAL_TB_BUNDLE_DIR: artifacts.bundle.bundleDir,
        HARNESS_EVAL_TB_BUNDLE_SHA256: artifacts.bundle.manifestHash,
        HARNESS_EVAL_TB_DATASET_DIR: offlineDataset.datasetDir,
      };
      steps = {
        deterministic: deterministicStep,
        ...buildLiveSteps({
          config: {
            ...raw,
            budget: config.budget,
            evaluationScope: config.evaluationScope,
            qualificationBaseline: config.qualificationBaseline,
            calibrationBaseline: config.calibrationBaseline,
            releaseTrust: structuredClone(config.releaseTrust),
            runtimeTrustRequired: true,
          },
          lock: runtimeTaskLock,
          workDir: releaseWorkDir,
          env: liveEnv,
          releaseSha,
          harnessVersion,
          repetitions: scheduledRepetitions,
          localEnabled: withLocal,
          providerControl: runtime.providerControl,
          trialExecutor: runtime.trialExecutor,
        }),
        runtimeSession: runtime.runtimeSession,
        nativeProducts: async () => (raw.nativeProductRotation ?? []).map((host) => ({
          host,
          status: 'not-run',
          telemetryAvailable: false,
          reason: 'subscription/native agent references require an explicit separately captured run',
        })),
      };
      requiredPairs = [config.controlledLane.host];
    }

    const { report, exitCode } = await deps.runRelease({
      config,
      steps,
      calibrationRelease,
      releaseSha,
      harnessVersion,
      requiredPairs,
    });
    completedReport = report;
    const reportVerdict = deps.validateReport(report);
    if (!reportVerdict.ok) throw new Error(`internal error: report failed its own schema: ${reportVerdict.errors.join('; ')}`);

    // No trusted report bytes or stdout are published while runtime-owned
    // channels, credentials, or key material remain live.
    await disposeOwnedResources();

    let archivalError = null;
    if (reportReservation) {
      try {
        deps.writeReservedPrivateReport(reportReservation, report);
      } catch (error) {
        archivalError = error;
      }
    }
    const finalTrustOk = report?.evaluationScope?.trust?.ok === true;
    if (shouldRetainReleaseWorkDir({ releaseTrustOk: finalTrustOk, workDir: releaseWorkDir, archivalError })) {
      preserveReleaseWorkDir = true;
    }
    if (json) stdout(JSON.stringify(report, null, 2));
    else stdout(buildMarkdownReport(report));
    if (archivalError) {
      stderr(
        `evaluation completed, but --report-file archival failed: ${archivalError.message}` +
        (preserveReleaseWorkDir ? `; trusted work directory retained at ${releaseWorkDir}` : '')
      );
    }
    return {
      report,
      exitCode: archivalError ? 2 : exitCode,
      reportFile: reportReservation?.destination ?? null,
      runtimeArming,
    };
  } catch (error) {
    let primaryError = error;
    try {
      await disposeOwnedResources();
    } catch (disposeError) {
      primaryError = disposeError === error
        ? disposeError
        : new Error(
            `${String(error?.message ?? error)}; ${String(disposeError?.message ?? disposeError)}`
          );
    }
    const reasonHash = crypto.createHash('sha256').update(String(primaryError?.message ?? primaryError)).digest('hex');
    preserveReleaseWorkDir = completedReport?.evaluationScope?.trust?.ok === true && releaseWorkDir != null;
    let emergencyArchived = false;
    if (reportReservation && reportReservation.writeAttempted !== true) {
      try {
        deps.writeReservedPrivateReport(reportReservation, {
          schema: 'eval-emergency.v1',
          releaseSha,
          harnessVersion,
          evaluationMode,
          reportComplete: false,
          reasonHash,
          workDirectoryRetained: preserveReleaseWorkDir,
          occurredAt: new Date(deps.now()).toISOString(),
        });
        emergencyArchived = true;
      } catch {
        // The safe error below says whether the pre-reserved archive survived;
        // never replace the original failure with report-write details.
      }
    }
    const evidence = [
      `detail sha256:${reasonHash.slice(0, 16)}`,
      emergencyArchived ? `emergency report ${reportReservation.destination}` : 'emergency report unavailable',
      preserveReleaseWorkDir ? `work directory retained at ${releaseWorkDir}` : null,
    ].filter(Boolean).join('; ');
    throw new Error(`release evaluation failed unexpectedly (${evidence})`);
  } finally {
    deps.closePrivateReportReservation(reportReservation, {
      removeIncomplete: reportReservation?.written !== true,
    });
    if (!preserveReleaseWorkDir) deps.removeReleaseWorkDir(releaseWorkDir);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleaseCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}
