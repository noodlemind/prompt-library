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
 *   node evals/release.mjs --profile release-canary --budget-usd 20
 *
 * Exit code is non-zero only for genuinely blocking results (§9).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createBudget } from './lib/budget.mjs';

export const MAX_RELEASE_API_USD = 20;
const DEFAULT_EFFICIENCY_THRESHOLDS = { promptRatio: 2, costRatio: 1.5, wallTimeRatio: 1.25 };

const RUN_SCHEMA = JSON.parse(fs.readFileSync(new URL('./schema/eval-run.v1.schema.json', import.meta.url), 'utf8'));
const REPORT_SCHEMA = JSON.parse(fs.readFileSync(new URL('./schema/eval-report.v1.schema.json', import.meta.url), 'utf8'));

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
export function validateAgainstSchema(value, schema, path = '') {
  const errors = [];
  const at = (key) => (path ? `${path}.${key}` : key);
  if ('const' in schema && value !== schema.const) {
    errors.push(`${path || '$'}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path || '$'}: expected one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}`);
  }
  if (schema.type) {
    const allowed = [].concat(schema.type);
    if (!allowed.includes(typeName(value))) {
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
      if (key in value) errors.push(...validateAgainstSchema(value[key], sub, at(key)).errors);
    }
  }
  if (typeName(value) === 'array' && schema.items) {
    value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, at(String(i))).errors));
  }
  return { ok: errors.length === 0, errors };
}

/* ---------------------------------------------------- pair classification -- */

function normalizeProviderName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function rawTrials(doc) {
  return Array.isArray(doc?.repetitions) && doc.repetitions.length > 0 ? doc.repetitions : doc ? [doc] : [];
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const PAIR_SCALAR_FIELDS = [
  'releaseSha',
  'harnessVersion',
  'taskId',
  'taskRevision',
  'taskHash',
  'bundleManifestHash',
  'modelRequested',
  'modelResolved',
  'host',
  'runnerVersion',
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
  'modelRequested',
  'modelResolved',
  'host',
  'runnerVersion',
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
  releaseSha = null,
  harnessVersion = null,
  expectedTask = pair?.task,
  expectedTaskRevision = null,
  expectedTaskHash = null,
} = {}) {
  const mismatches = [];
  const note = (field) => mismatches.push(field);
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
    if (genericIdentity.condition !== 'generic' || harnessIdentity.condition !== 'harness') note('condition');
    const order = [genericIdentity.orderIndex, harnessIdentity.orderIndex].sort((a, b) => a - b);
    if (!isDeepStrictEqual(order, [1, 2])) note('orderIndex');
    if (!SHA256_HEX.test(String(genericIdentity.taskHash ?? ''))) note('taskHash-presence');
    if (!SHA256_HEX.test(String(genericIdentity.bundleManifestHash ?? ''))) note('bundleManifestHash-presence');
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
    'modelRequested', 'modelResolved', 'host', 'runnerVersion',
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
    (providerComplete && !requestedProviders.includes(normalizeProviderName(reproducibility.providerResolved))) ||
    responses.some((response) => !requestedProviders.includes(normalizeProviderName(response.provider)))
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
  return {
    // Anything that is not an explicit pass counts as a fail here; a malformed
    // verdict is additionally caught by schema validation and blocks the gate.
    verdict: doc?.correctness?.verdict === 'pass' ? 'pass' : 'fail',
    budgetExhausted: doc?.correctness?.completedWithinBudget === false,
    safety: doc?.harnessBehavior?.policyBypassAchieved === true,
    fallback: attribution.contaminated,
    attributionComplete: attribution.complete,
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
  const matrix = {
    'fail/pass': ['harness-win', 'baseline failed, harness passed'],
    'pass/pass': ['parity', 'both conditions passed; compare cost and efficiency'],
    'pass/fail': ['harness-regression', 'baseline passed, harness failed'],
    'fail/fail': ['inconclusive-capability', 'both conditions failed; likely a model capability limitation'],
  };
  const [result, reason] = matrix[`${generic.verdict}/${harness.verdict}`];
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

/** Like-for-like Harness/baseline efficiency ratios for a controlled pair. */
export function efficiencyDelta(generic, harness, thresholds = DEFAULT_EFFICIENCY_THRESHOLDS) {
  const limits = { ...DEFAULT_EFFICIENCY_THRESHOLDS, ...(thresholds ?? {}) };
  const promptRatio = ratio(harness?.efficiency?.promptTokens, generic?.efficiency?.promptTokens);
  const costRatio = ratio(comparableCost(harness), comparableCost(generic));
  const wallTimeRatio = ratio(harness?.efficiency?.wallTimeMs, generic?.efficiency?.wallTimeMs);
  const modelRequestRatio = ratio(harness?.efficiency?.modelRequests, generic?.efficiency?.modelRequests);
  const providerAttemptRatio = ratio(harness?.efficiency?.providerAttempts, generic?.efficiency?.providerAttempts);
  const breaches = [];
  if (promptRatio != null && promptRatio > limits.promptRatio) breaches.push('promptRatio');
  if (costRatio != null && costRatio > limits.costRatio) breaches.push('costRatio');
  if (wallTimeRatio != null && wallTimeRatio > limits.wallTimeRatio) breaches.push('wallTimeRatio');
  const evidenceComplete = [promptRatio, costRatio, wallTimeRatio].every((value) => value != null);
  return {
    promptRatio,
    costRatio,
    wallTimeRatio,
    modelRequestRatio,
    providerAttemptRatio,
    thresholds: limits,
    evidenceComplete,
    withinThresholds: evidenceComplete && breaches.length === 0,
    breaches,
  };
}

/* ----------------------------------------------------------------- budget -- */

/** §10 in code: chained allowances under one release ceiling, reserve gated on a reason. */
export function allocateReleaseBudgets({ releaseCeilingUsd = 10, kimiPairUsd = 8, rerunUsd = 2, reserveUsd = 2 } = {}) {
  if (releaseCeilingUsd > MAX_RELEASE_API_USD) {
    throw new Error(`release API budget may not exceed the absolute $${MAX_RELEASE_API_USD} ceiling`);
  }
  const release = createBudget({ ceilingUsd: releaseCeilingUsd, label: 'release' });
  const kimiPair = createBudget({ ceilingUsd: kimiPairUsd, label: 'kimi-pair', parent: release });
  const rerun = createBudget({ ceilingUsd: rerunUsd, label: 'kimi-rerun', parent: release });
  let reserveReason = null;
  return {
    release,
    kimiPair,
    rerun,
    reserve: {
      amountUsd: reserveUsd,
      use({ reason } = {}) {
        if (!reason) throw new Error('the safety reserve requires a recorded reason');
        reserveReason = reason;
        return createBudget({ ceilingUsd: reserveUsd, label: 'reserve', parent: release });
      },
    },
    reserveUsedReason: () => reserveReason,
  };
}

/** Scale the planned child allowances when an operator raises the routine ceiling. */
export function scaleReleaseBudget(baseBudget, requestedCeilingUsd) {
  const baseCeiling = Number(baseBudget?.releaseCeilingUsd);
  if (!Number.isFinite(baseCeiling) || baseCeiling <= 0) throw new Error('base releaseCeilingUsd must be positive');
  if (!Number.isFinite(requestedCeilingUsd) || requestedCeilingUsd < 0 || requestedCeilingUsd > MAX_RELEASE_API_USD) {
    throw new Error(`release API budget must be between 0 and ${MAX_RELEASE_API_USD}`);
  }
  const scale = requestedCeilingUsd / baseCeiling;
  const scaled = (value) => Number((Number(value ?? 0) * scale).toFixed(6));
  return {
    releaseCeilingUsd: requestedCeilingUsd,
    kimiPairUsd: scaled(baseBudget.kimiPairUsd),
    rerunUsd: scaled(baseBudget.rerunUsd),
    reserveUsd: scaled(baseBudget.reserveUsd),
  };
}

/* ------------------------------------------------------------ gate policy -- */

/** §9: always-blocking rules, with gate-inactive pairs reporting instead of blocking. */
export function applyGatePolicy({ deterministic, pairs = [], smokes = [], telemetryComplete, coverageComplete = true, coverageReason = null, taskLockOk, environmentOk, budgetBreached = false, calibrationRelease = false }) {
  const reasons = [];
  if (deterministic?.failed > 0) reasons.push(`existing deterministic evals regressed (${deterministic.failed} failing)`);
  if (environmentOk === false) reasons.push('required dependencies or credentials are missing');
  if (taskLockOk === false) reasons.push('the pinned task/verifier failed validation');
  if (coverageComplete === false) reasons.push(`required controlled task coverage is incomplete${coverageReason ? ` (${coverageReason})` : ''}`);
  if (telemetryComplete === false) reasons.push('required telemetry is missing from at least one run');
  if (budgetBreached) reasons.push('the absolute release API budget was exceeded during provider reconciliation');
  for (const pair of pairs) {
    const c = pair.classification ?? {};
    const label = pair.task ? `${pair.host} (${pair.task})` : pair.host;
    if (c.safety) reasons.push(`harness safety control bypassed on ${label}`);
    if (pair.rerun?.safety === true) reasons.push(`harness safety control bypassed on rerun for ${label}`);
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
  }
  for (const smoke of smokes) {
    if (smoke.ok === false) reasons.push(`compatibility smoke failed: ${smoke.host} (${(smoke.failed ?? []).join(', ')})`);
  }
  return { block: reasons.length > 0, reasons };
}

function controlledTaskCoverage(config, pairs, requiredPairs) {
  const requiredHosts = requiredPairs.filter((host) => String(host).startsWith('openrouter'));
  const expectedTasks = (config.task?.taskSet ?? [])
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

function buildClaim(pairs, telemetryComplete) {
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
  const regressions = active.filter(
    (pair) => pair.result === 'harness-regression' || (pair.result === 'parity' && pair.efficiencyDelta?.withinThresholds === false)
  ).length;
  let level = 'inconclusive';
  let statement = 'The controlled evidence is not yet sufficient for a Harness value claim.';
  if (regressions > 0) {
    level = 'regression';
    statement = `At least one active controlled comparison of the ${treatmentLabel} regressed in correctness or bounded-overhead policy.`;
  } else if (telemetryComplete && controlledWins > 0) {
    level = 'demonstrated-value';
    statement = `The ${treatmentLabel} improved verified success in at least one active same-model controlled comparison.`;
  } else if (
    telemetryComplete &&
    active.length > 0 &&
    active.every((pair) => pair.result === 'parity' && pair.efficiencyDelta?.withinThresholds === true)
  ) {
    level = 'bounded-overhead';
    statement = `Verified success was at parity and ${treatmentLabel} overhead stayed within the declared release thresholds.`;
  }
  return { level, statement, controlledPairs: active.length, controlledWins, regressions, treatmentFidelityModes };
}

/* ------------------------------------------------------------ orchestrator -- */

function gateActiveFor(host, calibrationRelease) {
  if (host === 'openrouter-kimi') return !calibrationRelease; // gate: after-calibration
  if (host === 'ollama-gemma') return false; // gate: informational
  return true; // frontier rotation gates when scheduled
}

const METERED_FIELDS = ['promptTokens', 'outputTokens', 'modelRequests', 'providerAttempts', 'localCostUsd', 'reconciledCostUsd'];

function attributableTrialEvidence(doc, { paid = false } = {}) {
  const efficiency = doc?.efficiency ?? {};
  const observability = doc?.observability;
  const workspace = doc?.workspaceEvidence;
  if (
    !observability ||
    workspace?.available !== true ||
    !doc?.enforcementFidelity?.mode ||
    doc?.trialValidity?.valid === false ||
    doc?.correctness?.verifierReward == null
  ) return false;
  if (
    doc.reproducibility?.condition === 'harness' &&
    observability.harnessEventEvidence?.complete !== true
  ) return false;
  const requestEvents = observability.providerEvents?.filter((event) => event.type === 'request').length;
  const attribution = trialAttribution(doc, { requireProvider: paid });
  return (
    attribution.complete &&
    !attribution.contaminated &&
    observability.providerAttemptsStarted === efficiency.providerAttempts &&
    observability.providerAttemptsClosed === efficiency.providerAttempts &&
    observability.unclosedProviderAttempts === 0 &&
    observability.uncorrelatedToolResults === 0 &&
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

function completePaidEvidence(doc) {
  const trials = rawTrials(doc);
  return trials.length > 0 && trials.every((trial) =>
    validateAgainstSchema(trial, RUN_SCHEMA).ok &&
    METERED_FIELDS.every((field) => trial.efficiency?.[field] != null) &&
    trial.efficiency?.usageComplete === true &&
    trial.efficiency?.providerCostComplete === true &&
    trial.efficiency?.billingComplete === true &&
    trial.efficiency?.costComplete === true &&
    trial.efficiency?.billingUncertain !== true &&
    trial.efficiency?.unknownBillingAttempts === 0 &&
    trial.efficiency?.missingUsage === 0 &&
    trial.correctness?.completedWithinTimeout === true &&
    trial.correctness?.completedWithinBudget === true &&
    attributableTrialEvidence(trial, { paid: true })
  );
}

function fullyAttributablePair(pair, host, identityOptions = {}) {
  if (!pair?.generic || !pair?.harness || pair.failureKind) return false;
  if (!pairIdentityVerdict(pair, { ...identityOptions, host }).ok) return false;
  if (String(host).startsWith('openrouter')) {
    return completePaidEvidence(pair.generic) && completePaidEvidence(pair.harness);
  }
  return attributableEvidence(pair.generic) && attributableEvidence(pair.harness);
}

/**
 * Run the release sequence with injected steps. Steps that are absent or that
 * return null are reported as skipped; paid steps never run after a failed
 * preflight (deterministic regression, missing dependencies, or a bad task
 * pin) — that is the cost-control property, not an optimization.
 */
export async function runRelease({ config, steps, calibrationRelease = false, releaseSha = 'unknown', harnessVersion = 'unknown', requiredPairs = [] }) {
  const budgets = allocateReleaseBudgets(config.budget ?? {});
  const deterministic = await steps.deterministic();
  const environment = steps.environment ? await steps.environment() : { ok: true, missing: [] };
  const taskLock = steps.taskLock ? await steps.taskLock() : { ok: true, reason: '' };
  const rawProviderSpendGuard = environment?.providerSpendGuard ?? {};
  const guardLimitUsd = finiteNumber(rawProviderSpendGuard.limitUsd);
  const guardRemainingUsd = finiteNumber(rawProviderSpendGuard.limitRemainingUsd);
  const guardVerified =
    rawProviderSpendGuard.verified === true &&
    guardLimitUsd != null && guardLimitUsd === budgets.release.ceilingUsd &&
    guardRemainingUsd != null && guardRemainingUsd === budgets.release.ceilingUsd &&
    rawProviderSpendGuard.reset === null;
  const providerSpendGuard = {
    verified: guardVerified,
    limitUsd: guardLimitUsd,
    limitRemainingUsd: guardRemainingUsd,
    reset: rawProviderSpendGuard.reset ?? null,
    checkedAt: typeof rawProviderSpendGuard.checkedAt === 'string' ? rawProviderSpendGuard.checkedAt : null,
  };
  const providerGuardRequired = requiredPairs.some((host) => String(host).startsWith('openrouter'));
  const environmentOk = environment.ok !== false && (!providerGuardRequired || providerSpendGuard.verified);
  const preflightOk = deterministic.failed === 0 && environmentOk && taskLock.ok !== false;

  const runDocs = [];
  const pairEntries = [];
  const collect = (pair) => {
    for (const doc of [pair?.generic, pair?.harness]) if (doc) runDocs.push(doc);
  };
  const identityOptionsFor = (host, pair) => {
    const expectedTask = pair?.task ?? null;
    const expectedTaskEntry = (config.task?.taskSet ?? []).find((entry) => entry.task === expectedTask);
    return {
      host,
      releaseSha,
      harnessVersion,
      expectedTask,
      expectedTaskRevision: config.task?.datasetRef ?? null,
      expectedTaskHash: expectedTaskEntry?.taskChecksum ?? null,
    };
  };

  async function evaluatePair(host, stepFn, { rerunFn = null, budget = budgets.release } = {}) {
    const required = requiredPairs.includes(host);
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
    const result = await stepFn(budget);
    if (!result || (Array.isArray(result) && !result.length)) {
      pairEntries.push({ host, comparisonTrack: 'controlled-ablation', task: null, required, result: 'skipped', reason: 'dependencies unavailable', gateActive: false, reproduced: null, classification: null, efficiencyDelta: null, generic: null, harness: null });
      return;
    }
    // Multi-task steps return one pair per pinned task; each is classified,
    // rerun, and gated independently.
    for (const pair of Array.isArray(result) ? result : [result]) {
      collect(pair);
      const identityOptions = identityOptionsFor(host, pair);
      let classification = classifyPair(pair, identityOptions);
      let reproduced = null;
      let rerunEvidence = null;
      // §9 conditional rerun: one complete fresh pair for THIS task, never treatment-only.
      if (classification.result === 'harness-regression' && !classification.safety && rerunFn) {
        const second = await rerunFn(budgets.rerun, pair.task);
        if (!second) {
          // No rerun evidence: the regression stays a regression, unresolved —
          // it must not silently soften to flaky.
          classification = { ...classification, reason: `${classification.reason}; rerun unavailable — regression unresolved` };
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
          const rerunEfficiency = efficiencyDelta(second.generic, second.harness, config.efficiencyThresholds);
          rerunEvidence = {
            task: second.task ?? pair.task ?? null,
            pairId: second.pairId ?? null,
            repetitionCount: second.repetitionCount ?? second.seedCount ?? null,
            result: rerunClassification.result,
            reason: rerunClassification.reason,
            safety: rerunClassification.safety === true,
            causallyAttributable: rerunAttributable && rerunClassification.fallbackDetected !== true,
            efficiencyDelta: rerunEfficiency,
            generic: second.generic ?? null,
            harness: second.harness ?? null,
          };
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
      const causallyAttributable = fullyAttributablePair(pair, host, identityOptions) && classification.fallbackDetected !== true;
      pairEntries.push({
        host,
        comparisonTrack: 'controlled-ablation',
        task: pair.task ?? null,
        repetitionCount: pair.repetitionCount ?? pair.seedCount ?? null,
        required,
        result: classification.result,
        reason: classification.reason,
        gateActive: gateActiveFor(host, calibrationRelease),
        reproduced,
        rerun: rerunEvidence,
        causallyAttributable,
        classification,
        efficiencyDelta: efficiencyDelta(pair.generic, pair.harness, config.efficiencyThresholds),
        generic: pair.generic ?? null,
        harness: pair.harness ?? null,
      });
    }
  }

  await evaluatePair('openrouter-kimi', steps.kimiPair, { rerunFn: steps.rerunKimiPair, budget: budgets.kimiPair });
  await evaluatePair('ollama-gemma', steps.gemmaPair);

  const rawNativeProducts = preflightOk && steps.nativeProducts ? await steps.nativeProducts() : [];
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

  const smokes = preflightOk && steps.smokes ? await steps.smokes() : [];
  const coverage = controlledTaskCoverage(config, pairEntries, requiredPairs);
  // Evidence is complete only when every run document validates AND every
  // required API pair actually metered its spend — an all-null efficiency
  // block is a missing measurement, not a measurement of nothing.
  const meteredOk = pairEntries.every((p) => {
    if (!p.required || p.result === 'skipped') return true;
    if (!p.generic || !p.harness) return false;
    return p.causallyAttributable === true && [p.generic, p.harness].every((doc) => completePaidEvidence(doc));
  });
  const rerunMeteredOk = pairEntries.every((pair) => {
    if (!pair.rerun || !String(pair.host).startsWith('openrouter')) return true;
    return pair.rerun.causallyAttributable === true &&
      [pair.rerun.generic, pair.rerun.harness].every((doc) => doc && completePaidEvidence(doc));
  });
  const telemetryComplete = coverage.complete && meteredOk && rerunMeteredOk &&
    runDocs.every((doc) => validateAgainstSchema(doc, RUN_SCHEMA).ok);
  const gate = applyGatePolicy({
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
  });

  const taskSet = config.task?.taskSet ?? [];
  const claim = buildClaim(pairEntries, telemetryComplete);
  const billingUncertain = runDocs.some((doc) =>
    rawTrials(doc).some((trial) => trial?.efficiency?.billingUncertain === true || trial?.billingEvidence?.uncertain === true)
  );
  const enforcementSemantics = providerSpendGuard.verified
    ? 'provider-key-hard-limit-plus-conservative-scheduler'
    : 'scheduler-fail-stop-not-atomic-cash-guarantee';

  const report = {
    schema: 'eval-report.v1',
    harnessVersion,
    releaseSha,
    task: {
      datasetRef: config.task?.datasetRef ?? 'unknown',
      task: config.task?.task ?? 'unknown',
      taskChecksum: config.task?.taskChecksum ?? null,
      taskSet,
    },
    calibrationRelease,
    deterministic,
    coverage,
    pairs: pairEntries.map(({ classification, required, ...entry }) => entry),
    nativeProducts,
    smokes,
    budget: {
      scope: 'provider-api-only',
      ceilingUsd: budgets.release.ceilingUsd,
      spentUsd: budgets.release.spentUsd(),
      exhausted: budgets.release.exhausted,
      breached: budgets.release.breached,
      overrunUsd: budgets.release.overrunUsd(),
      reserveUsed: budgets.reserveUsedReason(),
      providerSpendGuard,
      billingUncertain,
      enforcementSemantics,
      requestEstimateSemantics: 'utf8-byte-prompt-token-upper-bound-plus-max-output-at-pinned-rates',
      allocations: {
        controlledPairUsd: budgets.kimiPair.ceilingUsd,
        regressionRerunUsd: budgets.rerun.ceilingUsd,
        reasonedReserveUsd: budgets.reserve.amountUsd,
      },
    },
    gate,
    claim,
    limitations: [
      'The pinned task set is a release canary, not a broad productivity benchmark.',
      'Native product runs (Codex, Claude Code, Pi, and similar agents) are reference evidence only and never substitute for a same-model controlled ablation.',
      'Prompt-and-CLI Terminal-Bench results do not establish the value or safety of mechanical hooks; enforcement fidelity is reported per run.',
      providerSpendGuard.verified
        ? 'The provider API cash backstop is a fresh dedicated no-reset key limit; scheduler estimates additionally fail-stop before requests and reconcile the larger local/provider amount.'
        : 'The scheduler ceiling is not an atomic cash guarantee: one request or provider repricing can reconcile above it unless a dedicated provider-limited key is verified.',
      'The provider API ceiling does not include Daytona credit consumption, local electricity, or subscription opportunity cost; those require separate operator accounting.',
      'A live paid calibration is still required before publishing measured ratio results from this implementation.',
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
  const lines = [
    `# Eval Card — Engineer Harness ${report.harnessVersion} (${report.releaseSha})`,
    '',
    `Task set: ${taskNames} (${report.task.datasetRef})${report.calibrationRelease ? ' — calibration release' : ''}`,
    '',
    `Deterministic suite: ${report.deterministic.passed} passed, ${report.deterministic.failed} failed, ${report.deterministic.skipped} skipped.`,
    `Controlled task coverage: ${report.coverage?.complete === true ? 'complete' : `incomplete${report.coverage?.reason ? ` (${report.coverage.reason})` : ''}`}.`,
    '',
    '| Host | Result | Gate | Reason |',
    '|---|---|---|---|',
    ...report.pairs.map((p) => `| ${p.task ? `${p.host} (${p.task})` : p.host} | ${p.result} | ${p.gateActive ? 'active' : 'informational'} | ${p.reason} |`),
    '',
    `Claim level: **${report.claim.level}** — ${report.claim.statement}`,
    '',
    ...(report.nativeProducts?.length
      ? [
          `Native product references (separate, not causal): ${report.nativeProducts.map((entry) => `${entry.host} ${entry.status}`).join(' · ')}`,
          '',
        ]
      : []),
    ...(report.smokes.length
      ? [`Smokes: ${report.smokes.map((s) => `${s.host} ${s.ok ? 'ok' : `failed (${(s.failed ?? []).join(', ')})`}`).join(' · ')}`, '']
      : []),
    `Incremental provider API spend: $${report.budget.spentUsd.toFixed(2)} of $${report.budget.ceilingUsd.toFixed(2)} ceiling${report.budget.breached === true ? ` (BREACHED by $${Number(report.budget.overrunUsd ?? 0).toFixed(2)})` : ''}${report.budget.reserveUsed ? ` (reserve used: ${report.budget.reserveUsed})` : ''}.`,
    `Cash-control semantics: ${report.budget.enforcementSemantics ?? 'legacy-unspecified'}${report.budget.billingUncertain === true ? ' (BILLING UNCERTAIN; remaining trial allowance reserved)' : ''}.`,
    '',
    report.gate.block ? `**Release blocked:** ${report.gate.reasons.join('; ')}` : '**Release not blocked by evaluation gates.**',
    '',
    '## Limitations',
    ...(report.limitations ?? []).map((l) => `- ${l}`),
  ];
  return lines.join('\n');
}

/* -------------------------------------------------------------------- CLI -- */

function loadYamlConfig(profileName) {
  const require = createRequire(fileURLToPath(new URL('../packages/harness/package.json', import.meta.url)));
  const YAML = require('yaml');
  const file = new URL(`./config/${profileName}.yaml`, import.meta.url);
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function currentGitReleaseSha() {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sha = result.status === 0 ? result.stdout.trim() : '';
  if (!/^[a-f0-9]{40,64}$/i.test(sha)) {
    throw new Error('--release-sha is required when the current git HEAD cannot be resolved');
  }
  return sha;
}

function makeReleaseTreeRemovable(root) {
  if (!fs.existsSync(root)) return;
  const entry = fs.lstatSync(root);
  if (entry.isSymbolicLink()) return;
  if (!entry.isDirectory()) {
    fs.chmodSync(root, 0o600);
    return;
  }
  fs.chmodSync(root, 0o700);
  for (const name of fs.readdirSync(root)) makeReleaseTreeRemovable(path.join(root, name));
}

function removeReleaseWorkDir(workDir) {
  if (!workDir || !fs.existsSync(workDir)) return;
  makeReleaseTreeRemovable(workDir);
  fs.rmSync(workDir, { recursive: true, force: true });
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const profile = flag('--profile', 'release-canary');
  const calibrationRelease = argv.includes('--calibration');
  const deterministicOnly = argv.includes('--deterministic-only');
  const withLocal = argv.includes('--with-local');
  const json = argv.includes('--json');
  const raw = loadYamlConfig(profile);
  const lockFileFlag = flag('--lock-file', null); // bootstrap/test hook; default is the committed lock
  const completeLock = JSON.parse(
    fs.readFileSync(lockFileFlag ? path.resolve(lockFileFlag) : new URL(`../${raw.task.lockFile}`, import.meta.url), 'utf8')
  );
  const budgetUsd = Number(flag('--budget-usd', raw.budget.releaseCeilingUsd));
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > MAX_RELEASE_API_USD) {
    throw new Error(`--budget-usd must be between 0 and ${MAX_RELEASE_API_USD}, got: ${flag('--budget-usd')}`);
  }
  const lockedTasks = completeLock.tasks ?? (
    completeLock.task
      ? [{ task: completeLock.task, taskChecksum: completeLock.taskChecksum, role: 'anchor' }]
      : []
  );
  const taskFlagPresent = argv.includes('--task');
  const requestedTask = flag('--task', null);
  if (taskFlagPresent && (
    typeof requestedTask !== 'string' || requestedTask.length === 0 || requestedTask.startsWith('--')
  )) {
    throw new Error('--task requires a nonempty pinned task value');
  }
  if (requestedTask && !lockedTasks.some((entry) => entry.task === requestedTask)) {
    throw new Error(`--task ${requestedTask} is not a pinned task in the selected lock`);
  }
  const selectedTasks = requestedTask ? lockedTasks.filter((entry) => entry.task === requestedTask) : lockedTasks;
  const lock = { ...completeLock, tasks: selectedTasks };
  delete lock.task;
  delete lock.taskChecksum;
  const taskSet = selectedTasks.map(
    ({ task, taskChecksum = null, role = null }) => ({ task, taskChecksum, role })
  );
  const config = {
    budget: scaleReleaseBudget(raw.budget, budgetUsd),
    task: {
      datasetRef: lock.datasetRef,
      task: taskSet.length === 1 ? taskSet[0].task : 'multi-task-canary',
      taskChecksum: taskSet.length === 1 ? taskSet[0].taskChecksum : null,
      taskSet,
    },
    efficiencyThresholds: raw.efficiencyThresholds ?? DEFAULT_EFFICIENCY_THRESHOLDS,
  };

  const releaseShaFlagPresent = argv.includes('--release-sha');
  const explicitReleaseSha = flag('--release-sha', null);
  if (releaseShaFlagPresent && (
    typeof explicitReleaseSha !== 'string' || !/^[a-f0-9]{7,64}$/i.test(explicitReleaseSha)
  )) {
    throw new Error('--release-sha requires a hexadecimal commit/content identity');
  }
  const releaseSha = explicitReleaseSha ?? currentGitReleaseSha();
  const harnessVersion = JSON.parse(fs.readFileSync(new URL('../packages/harness/package.json', import.meta.url), 'utf8')).version;
  const { runEvals, summarize } = await import('./lib/runner.mjs');
  const deterministicStep = async () => {
    const summary = summarize(await runEvals({}));
    return { passed: summary.passed, failed: summary.failed + summary.infrastructureErrors, skipped: summary.skipped };
  };

  let steps;
  let requiredPairs;
  let releaseWorkDir = null;
  if (deterministicOnly) {
    // Per-PR mode: free, no pairs scheduled, structural lock validation only.
    const { validateTaskLock } = await import('./external/terminal_bench/harbor-adapter.mjs');
    steps = {
      deterministic: deterministicStep,
      environment: async () => ({ ok: true, missing: [] }),
      taskLock: async () => {
        const verdict = validateTaskLock(lock);
        return { ok: verdict.ok, reason: verdict.errors.join('; ') };
      },
      frontierPair: null,
      nativeProducts: null,
      kimiPair: null,
      gemmaPair: null,
      smokes: null,
    };
    requiredPairs = [];
  } else {
    // Release-candidate mode: the live Kimi pair is REQUIRED. Missing
    // harbor, credentials, or task verification blocks — it never greens.
    const { buildLiveSteps } = await import('./external/terminal_bench/live-steps.mjs');
    releaseWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-release-'));
    const repetitionsConfig = raw.repetitions ?? raw.seeds;
    const repetitions = calibrationRelease ? repetitionsConfig?.calibration ?? 3 : repetitionsConfig?.routine ?? 1;
    try {
      steps = {
        deterministic: deterministicStep,
        ...buildLiveSteps({ config: { ...raw, budget: config.budget }, lock, workDir: releaseWorkDir, releaseSha, harnessVersion, repetitions, localEnabled: withLocal }),
        nativeProducts: async () => (raw.nativeProductRotation ?? []).map((host) => ({
          host,
          status: 'not-run',
          telemetryAvailable: false,
          reason: 'subscription/native agent references require an explicit separately captured run',
        })),
      };
    } catch (error) {
      removeReleaseWorkDir(releaseWorkDir);
      releaseWorkDir = null;
      throw error;
    }
    requiredPairs = ['openrouter-kimi'];
  }

  try {
    const { report, exitCode } = await runRelease({ config, steps, calibrationRelease, releaseSha, harnessVersion, requiredPairs });
    const reportVerdict = validateAgainstSchema(report, REPORT_SCHEMA);
    if (!reportVerdict.ok) throw new Error(`internal error: report failed its own schema: ${reportVerdict.errors.join('; ')}`);
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(buildMarkdownReport(report));
    // exitCode (not process.exit) so piped stdout flushes fully before exit.
    process.exitCode = exitCode;
  } finally {
    removeReleaseWorkDir(releaseWorkDir);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}
