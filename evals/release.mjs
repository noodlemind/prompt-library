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

/* ----------------------------------------------------------------- budget -- */

/** §10 in code: chained allowances under one release ceiling, reserve gated on a reason. */
export function allocateReleaseBudgets({ releaseCeilingUsd = 20, kimiPairUsd = 10, rerunUsd = 8, reserveUsd = 2 } = {}) {
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

/* ------------------------------------------------------------ gate policy -- */

/** §9: always-blocking rules, with gate-inactive pairs reporting instead of blocking. */
export function applyGatePolicy({ deterministic, pairs = [], smokes = [], telemetryComplete, taskLockOk, environmentOk, calibrationRelease = false }) {
  const reasons = [];
  if (deterministic?.failed > 0) reasons.push(`existing deterministic evals regressed (${deterministic.failed} failing)`);
  if (environmentOk === false) reasons.push('required dependencies or credentials are missing');
  if (taskLockOk === false) reasons.push('the pinned task/verifier failed validation');
  if (telemetryComplete === false) reasons.push('required telemetry is missing from at least one run');
  for (const pair of pairs) {
    const c = pair.classification ?? {};
    if (c.safety) reasons.push(`harness safety control bypassed on ${pair.host}`);
    // A required pair with no valid evidence is a red release, not a green one.
    if (pair.required && pair.result === 'skipped') {
      reasons.push(`required pair ${pair.host} was skipped and did not run`);
    }
    if ((pair.gateActive || pair.required) && pair.result === 'infrastructure-invalid') {
      reasons.push(`pair ${pair.host} produced no valid signal (${pair.reason})`);
    }
    if (!pair.gateActive) continue;
    if (c.fallbackDetected) reasons.push(`model or provider fallback invalidated the comparison on ${pair.host}`);
    if (c.result === 'harness-regression' && pair.reproduced === true) {
      reasons.push(`reproduced harness regression on ${pair.host}`);
    }
  }
  for (const smoke of smokes) {
    if (smoke.ok === false) reasons.push(`compatibility smoke failed: ${smoke.host} (${(smoke.failed ?? []).join(', ')})`);
  }
  return { block: reasons.length > 0, reasons };
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
    const pair = await stepFn(budget);
    if (!pair) {
      pairEntries.push({ host, required, result: 'skipped', reason: 'dependencies unavailable', gateActive: false, reproduced: null, classification: null, generic: null, harness: null });
      return;
    }
    collect(pair);
    let classification = classifyPair(pair);
    let reproduced = null;
    // §9 conditional rerun: one complete fresh pair, never treatment-only.
    if (classification.result === 'harness-regression' && !classification.safety && rerunFn) {
      const second = await rerunFn(budgets.rerun);
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
      required,
      result: classification.result,
      reason: classification.reason,
      gateActive: gateActiveFor(host, calibrationRelease),
      reproduced,
      classification,
      generic: pair.generic ?? null,
      harness: pair.harness ?? null,
    });
  }

  await evaluatePair('codex-subscription', steps.frontierPair);
  await evaluatePair('openrouter-kimi', steps.kimiPair, { rerunFn: steps.rerunKimiPair, budget: budgets.kimiPair });
  await evaluatePair('ollama-gemma', steps.gemmaPair);

  const smokes = preflightOk && steps.smokes ? await steps.smokes() : [];
  // Evidence is complete only when every run document validates AND every
  // required API pair actually metered its spend — an all-null efficiency
  // block is a missing measurement, not a measurement of nothing.
  const METERED_FIELDS = ['promptTokens', 'outputTokens', 'modelRequests', 'localCostUsd'];
  const meteredOk = pairEntries.every(
    (p) =>
      !p.required ||
      !p.generic ||
      !p.harness ||
      [p.generic, p.harness].every((doc) => METERED_FIELDS.every((f) => doc.efficiency?.[f] != null))
  );
  const telemetryComplete = meteredOk && runDocs.every((doc) => validateAgainstSchema(doc, RUN_SCHEMA).ok);
  const gate = applyGatePolicy({
    deterministic,
    pairs: pairEntries,
    smokes,
    telemetryComplete,
    taskLockOk: taskLock.ok !== false,
    environmentOk: environment.ok !== false,
    calibrationRelease,
  });

  const report = {
    schema: 'eval-report.v1',
    harnessVersion,
    releaseSha,
    task: {
      datasetRef: config.task?.datasetRef ?? 'unknown',
      task: config.task?.task ?? 'unknown',
      taskChecksum: config.task?.taskChecksum ?? null,
    },
    calibrationRelease,
    deterministic,
    pairs: pairEntries.map(({ classification, required, ...entry }) => entry),
    smokes,
    budget: {
      ceilingUsd: budgets.release.ceilingUsd,
      spentUsd: budgets.release.spentUsd(),
      exhausted: budgets.release.exhausted,
      reserveUsed: budgets.reserveUsedReason(),
    },
    gate,
    limitations: [
      'Single pinned task — this is a release canary, not a broad productivity claim.',
      'Subscription host results are separate host A/Bs and are never mixed numerically with the neutral API result.',
    ],
  };
  return { report, exitCode: gate.block ? 1 : 0 };
}

/* -------------------------------------------------------------- reporting -- */

/** The Eval Card in markdown, from a report object. */
export function buildMarkdownReport(report) {
  const lines = [
    `# Eval Card — Engineer Harness ${report.harnessVersion} (${report.releaseSha})`,
    '',
    `Task: \`${report.task.task}\` (${report.task.datasetRef})${report.calibrationRelease ? ' — calibration release' : ''}`,
    '',
    `Deterministic suite: ${report.deterministic.passed} passed, ${report.deterministic.failed} failed, ${report.deterministic.skipped} skipped.`,
    '',
    '| Host | Result | Gate | Reason |',
    '|---|---|---|---|',
    ...report.pairs.map((p) => `| ${p.host} | ${p.result} | ${p.gateActive ? 'active' : 'informational'} | ${p.reason} |`),
    '',
    ...(report.smokes.length
      ? [`Smokes: ${report.smokes.map((s) => `${s.host} ${s.ok ? 'ok' : `failed (${(s.failed ?? []).join(', ')})`}`).join(' · ')}`, '']
      : []),
    `Incremental spend: $${report.budget.spentUsd.toFixed(2)} of $${report.budget.ceilingUsd.toFixed(2)} ceiling${report.budget.reserveUsed ? ` (reserve used: ${report.budget.reserveUsed})` : ''}.`,
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
  const json = argv.includes('--json');
  const raw = loadYamlConfig(profile);
  const lockFileFlag = flag('--lock-file', null); // bootstrap/test hook; default is the committed lock
  const lock = JSON.parse(
    fs.readFileSync(lockFileFlag ? path.resolve(lockFileFlag) : new URL(`../${raw.task.lockFile}`, import.meta.url), 'utf8')
  );
  const budgetUsd = Number(flag('--budget-usd', raw.budget.releaseCeilingUsd));
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    throw new Error(`--budget-usd must be a non-negative number, got: ${flag('--budget-usd')}`);
  }
  const config = {
    budget: {
      releaseCeilingUsd: budgetUsd,
      kimiPairUsd: raw.budget.kimiPairUsd,
      rerunUsd: raw.budget.rerunUsd,
      reserveUsd: raw.budget.reserveUsd,
    },
    task: { datasetRef: lock.datasetRef, task: flag('--task', lock.task), taskChecksum: lock.taskChecksum },
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
    steps = {
      deterministic: deterministicStep,
      ...buildLiveSteps({ config: raw, lock, workDir, releaseSha, harnessVersion }),
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
