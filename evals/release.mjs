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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * properties, items, const, enum) — enough to hold the eval-run/eval-report
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

function summarizeRun(doc) {
  return {
    // Anything that is not an explicit pass counts as a fail here; a malformed
    // verdict is additionally caught by schema validation and blocks the gate.
    verdict: doc?.correctness?.verdict === 'pass' ? 'pass' : 'fail',
    budgetExhausted: doc?.correctness?.completedWithinBudget === false,
    safety: doc?.harnessBehavior?.policyBypassAchieved === true,
    fallback:
      Boolean(doc?.reproducibility?.modelResolved) &&
      doc.reproducibility.modelResolved !== doc.reproducibility.modelRequested,
  };
}

/** The §8 result matrix with its precedence: safety, infrastructure, budget. */
export function classifyPair(pair) {
  const generic = summarizeRun(pair.generic);
  const harness = summarizeRun(pair.harness);
  const fallbackDetected = generic.fallback || harness.fallback;
  const base = { safety: false, fallbackDetected };
  if (generic.safety || harness.safety) {
    return { ...base, safety: true, result: 'harness-regression', reason: 'a harness safety control was bypassed' };
  }
  if (pair.failureKind) {
    // provider and verifier failures are invalid trials too — never "the
    // model wasn't capable".
    return { ...base, result: 'infrastructure-invalid', reason: `${pair.failureKind} failure invalidated the trial` };
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
  if (!efficiency || efficiency.costComplete !== true) return null;
  if (efficiency.providerCostComplete === true && finiteNumber(efficiency.providerReportedCostUsd) != null) {
    return efficiency.providerReportedCostUsd;
  }
  return finiteNumber(efficiency.localCostUsd);
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
export function applyGatePolicy({ deterministic, pairs = [], smokes = [], telemetryComplete, taskLockOk, environmentOk, budgetBreached = false, calibrationRelease = false }) {
  const reasons = [];
  if (deterministic?.failed > 0) reasons.push(`existing deterministic evals regressed (${deterministic.failed} failing)`);
  if (environmentOk === false) reasons.push('required dependencies or credentials are missing');
  if (taskLockOk === false) reasons.push('the pinned task/verifier failed validation');
  if (telemetryComplete === false) reasons.push('required telemetry is missing from at least one run');
  if (budgetBreached) reasons.push('the absolute release API budget was exceeded during provider reconciliation');
  for (const pair of pairs) {
    const c = pair.classification ?? {};
    const label = pair.task ? `${pair.host} (${pair.task})` : pair.host;
    if (c.safety) reasons.push(`harness safety control bypassed on ${label}`);
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
    if (c.result === 'harness-regression' && pair.reproduced === true) {
      reasons.push(`reproduced harness regression on ${label}`);
    }
  }
  for (const smoke of smokes) {
    if (smoke.ok === false) reasons.push(`compatibility smoke failed: ${smoke.host} (${(smoke.failed ?? []).join(', ')})`);
  }
  return { block: reasons.length > 0, reasons };
}

function buildClaim(pairs, telemetryComplete) {
  const active = pairs.filter((pair) => pair.comparisonTrack === 'controlled-ablation' && pair.gateActive && pair.result !== 'skipped');
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
  const preflightOk = deterministic.failed === 0 && environment.ok !== false && taskLock.ok !== false;

  const runDocs = [];
  const pairEntries = [];
  const collect = (pair) => {
    for (const doc of [pair?.generic, pair?.harness]) if (doc) runDocs.push(doc);
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
      let classification = classifyPair(pair);
      let reproduced = null;
      // §9 conditional rerun: one complete fresh pair for THIS task, never treatment-only.
      if (classification.result === 'harness-regression' && !classification.safety && rerunFn) {
        const second = await rerunFn(budgets.rerun, pair.task);
        if (!second) {
          // No rerun evidence: the regression stays a regression, unresolved —
          // it must not silently soften to flaky.
          classification = { ...classification, reason: `${classification.reason}; rerun unavailable — regression unresolved` };
        } else {
          collect(second);
          if (classifyPair(second).result === 'harness-regression') {
            reproduced = true;
          } else {
            reproduced = false;
            classification = { ...classification, result: 'flaky-inconclusive', reason: 'regression did not reproduce on a fresh pair' };
          }
        }
      }
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
  // Evidence is complete only when every run document validates AND every
  // required API pair actually metered its spend — an all-null efficiency
  // block is a missing measurement, not a measurement of nothing.
  const METERED_FIELDS = ['promptTokens', 'outputTokens', 'modelRequests', 'providerAttempts', 'localCostUsd'];
  const attributableTrialEvidence = (doc) => {
    const efficiency = doc?.efficiency ?? {};
    const observability = doc?.observability;
    const workspace = doc?.workspaceEvidence;
    if (!observability || workspace?.available !== true || !doc?.enforcementFidelity?.mode) return false;
    const requestEvents = observability.providerEvents?.filter((event) => event.type === 'request').length;
    return (
      observability.providerAttemptsStarted === efficiency.providerAttempts &&
      observability.providerAttemptsClosed === efficiency.providerAttempts &&
      observability.unclosedProviderAttempts === 0 &&
      observability.uncorrelatedToolResults === 0 &&
      requestEvents === efficiency.modelRequests &&
      Number.isFinite(workspace.changedPathCount) &&
      workspace.changedPathCount >= workspace.changedPaths.length
    );
  };
  const attributableEvidence = (doc) => {
    const repetitions = Array.isArray(doc?.repetitions) ? doc.repetitions : [];
    // Multi-repetition aggregates intentionally carry medians and keep real
    // workspace manifests on the raw repetitions. Never compare those medians
    // to the aggregate (summed) event ledger; validate every retained trial.
    return repetitions.length > 0
      ? repetitions.every((repetition) => attributableTrialEvidence(repetition))
      : attributableTrialEvidence(doc);
  };
  const meteredOk = pairEntries.every((p) => {
    if (!p.required || p.result === 'skipped') return true;
    if (!p.generic || !p.harness) return false;
    return [p.generic, p.harness].every(
      (doc) =>
        METERED_FIELDS.every((f) => doc.efficiency?.[f] != null) &&
        doc.efficiency?.usageComplete === true &&
        doc.efficiency?.providerCostComplete === true &&
        doc.efficiency?.billingComplete === true &&
        doc.efficiency?.costComplete === true &&
        doc.efficiency?.unknownBillingAttempts === 0 &&
        doc.efficiency?.missingUsage === 0 &&
        attributableEvidence(doc)
    );
  });
  const telemetryComplete = meteredOk && runDocs.every((doc) => validateAgainstSchema(doc, RUN_SCHEMA).ok);
  const gate = applyGatePolicy({
    deterministic,
    pairs: pairEntries,
    smokes,
    telemetryComplete,
    taskLockOk: taskLock.ok !== false,
    environmentOk: environment.ok !== false,
    budgetBreached: budgets.release.breached,
    calibrationRelease,
  });

  const taskSet = config.task?.taskSet ?? [];
  const claim = buildClaim(pairEntries, telemetryComplete);

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
      'The coded cash ceiling covers provider API charges only; Daytona credit consumption, local electricity, and subscription opportunity cost require separate operator accounting.',
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
    `Incremental provider API spend: $${report.budget.spentUsd.toFixed(2)} of $${report.budget.ceilingUsd.toFixed(2)} ceiling${report.budget.breached ? ` (BREACHED by $${report.budget.overrunUsd.toFixed(2)})` : ''}${report.budget.reserveUsed ? ` (reserve used: ${report.budget.reserveUsed})` : ''}.`,
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
  const lock = JSON.parse(
    fs.readFileSync(lockFileFlag ? path.resolve(lockFileFlag) : new URL(`../${raw.task.lockFile}`, import.meta.url), 'utf8')
  );
  const budgetUsd = Number(flag('--budget-usd', raw.budget.releaseCeilingUsd));
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > MAX_RELEASE_API_USD) {
    throw new Error(`--budget-usd must be between 0 and ${MAX_RELEASE_API_USD}, got: ${flag('--budget-usd')}`);
  }
  const taskSet = (lock.tasks ?? (lock.task ? [{ task: lock.task, taskChecksum: lock.taskChecksum, role: 'anchor' }] : [])).map(
    ({ task, taskChecksum = null, role = null }) => ({ task, taskChecksum, role })
  );
  const config = {
    budget: scaleReleaseBudget(raw.budget, budgetUsd),
    task: {
      datasetRef: lock.datasetRef,
      task: flag('--task', taskSet.length === 1 ? taskSet[0].task : 'multi-task-canary'),
      taskChecksum: taskSet.length === 1 ? taskSet[0].taskChecksum : null,
      taskSet,
    },
    efficiencyThresholds: raw.efficiencyThresholds ?? DEFAULT_EFFICIENCY_THRESHOLDS,
  };

  const releaseSha = flag('--release-sha', 'workdir');
  const harnessVersion = JSON.parse(fs.readFileSync(new URL('../packages/harness/package.json', import.meta.url), 'utf8')).version;
  const { runEvals, summarize } = await import('./lib/runner.mjs');
  const deterministicStep = async () => {
    const summary = summarize(await runEvals({}));
    return { passed: summary.passed, failed: summary.failed + summary.infrastructureErrors, skipped: summary.skipped };
  };

  let steps;
  let requiredPairs;
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
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-release-'));
    const repetitionsConfig = raw.repetitions ?? raw.seeds;
    const repetitions = calibrationRelease ? repetitionsConfig?.calibration ?? 3 : repetitionsConfig?.routine ?? 1;
    steps = {
      deterministic: deterministicStep,
      ...buildLiveSteps({ config: raw, lock, workDir, releaseSha, harnessVersion, repetitions, localEnabled: withLocal }),
      nativeProducts: async () => (raw.nativeProductRotation ?? []).map((host) => ({
        host,
        status: 'not-run',
        telemetryAvailable: false,
        reason: 'subscription/native agent references require an explicit separately captured run',
      })),
    };
    requiredPairs = ['openrouter-kimi'];
  }

  const { report, exitCode } = await runRelease({ config, steps, calibrationRelease, releaseSha, harnessVersion, requiredPairs });
  const reportVerdict = validateAgainstSchema(report, REPORT_SCHEMA);
  if (!reportVerdict.ok) throw new Error(`internal error: report failed its own schema: ${reportVerdict.errors.join('; ')}`);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(buildMarkdownReport(report));
  // exitCode (not process.exit) so piped stdout flushes fully before exit.
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}
