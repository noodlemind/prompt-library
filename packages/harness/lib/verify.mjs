import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { readSession } from './session.mjs';
import { selectPlan } from './plan-parse.mjs';
import { extractAcceptanceCriteria, validatePlanSchema } from './plan-schema.mjs';
import { validatePlanScope } from './plan-scope.mjs';
import { writeEvidence } from './evidence.mjs';
import { enforcementExitCode, loadPolicy } from './policy.mjs';

const CHECKS_REL = '.github/harness/checks.yaml';

function resultCheck(id, status, message, extra = {}) {
  return { id, status, message, ...extra };
}

function loadNamedChecks(workspace) {
  const full = path.join(workspace, CHECKS_REL);
  if (!fs.existsSync(full)) return { checks: null, error: `Trusted check config not found: ${CHECKS_REL}` };
  try {
    const parsed = YAML.parse(fs.readFileSync(full, 'utf8'), { maxAliasCount: 50 });
    if (parsed?.version !== 1 || !parsed.checks || typeof parsed.checks !== 'object') {
      return { checks: null, error: `${CHECKS_REL} must declare version: 1 and checks` };
    }
    return { checks: parsed.checks, error: null };
  } catch (error) {
    return { checks: null, error: `Invalid ${CHECKS_REL}: ${error.message}` };
  }
}

function validateCommand(name, config) {
  if (!config || !Array.isArray(config.command) || config.command.length === 0) {
    return `${name}.command must be a non-empty argv array`;
  }
  if (!config.command.every((part) => typeof part === 'string' && part.length > 0)) {
    return `${name}.command entries must be non-empty strings`;
  }
  const timeout = config.timeout_seconds ?? 600;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) {
    return `${name}.timeout_seconds must be an integer from 1 to 3600`;
  }
  return null;
}

function trimOutput(value) {
  const text = String(value || '');
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…truncated…` : text;
}

function runNamedCheck(workspace, name, config) {
  const invalid = validateCommand(name, config);
  if (invalid) return resultCheck(name, 'unavailable', invalid);

  const started = Date.now();
  const execution = spawnSync(config.command[0], config.command.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    timeout: config.timeout_seconds * 1000,
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const output = { stdout: trimOutput(execution.stdout), stderr: trimOutput(execution.stderr), durationMs };

  if (execution.error?.code === 'ETIMEDOUT' || execution.signal) {
    return resultCheck(name, 'timeout', `Timed out after ${config.timeout_seconds}s`, output);
  }
  if (execution.error) return resultCheck(name, 'unavailable', execution.error.message, output);
  if (execution.status !== 0) return resultCheck(name, 'failed', `Exited with status ${execution.status}`, { ...output, exitCode: execution.status });
  return resultCheck(name, 'passed', 'Named check passed', { ...output, exitCode: 0 });
}

function checkStatusForEvidence(mapped, byId) {
  if (!Array.isArray(mapped) || mapped.length === 0) return 'failed';
  const statuses = mapped.map((id) => byId.get(id)?.status || 'unavailable');
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => ['unavailable', 'timeout', 'inconclusive'].includes(status))) return 'inconclusive';
  return statuses.every((status) => status === 'passed') ? 'passed' : 'inconclusive';
}

function resolveOutcome(checks) {
  if (checks.some((check) => check.status === 'failed')) return 'failed';
  if (checks.some((check) => ['unavailable', 'timeout', 'inconclusive'].includes(check.status))) return 'inconclusive';
  return 'passed';
}

function finalize(workspace, flags, partial) {
  const policy = loadPolicy(workspace, flags.enforcement);
  const result = {
    outcome: partial.outcome || resolveOutcome(partial.checks),
    plan: partial.plan || null,
    checks: partial.checks,
    unverifiedCriteria: partial.unverifiedCriteria || [],
    scopeViolations: partial.scopeViolations || [],
    openHardGaps: partial.openHardGaps || [],
    requiredReviews: partial.requiredReviews || [],
    enforcement: policy.enforcement,
    exemptions: policy.exemptions,
    waivers: policy.waivers,
    evidencePath: null,
  };
  result.evidencePath = writeEvidence(workspace, result, flags.dryRun);
  return result;
}

export function runVerify({ workspace, flags }) {
  const session = readSession(workspace);
  const selected = selectPlan(workspace, {
    planPath: flags.plan,
    session,
    requireUnique: true,
  });
  if (!selected.plan) {
    return finalize(workspace, flags, {
      outcome: 'inconclusive',
      checks: [resultCheck('plan-selection', 'inconclusive', selected.error || 'No locked active plan; pass --plan explicitly')],
    });
  }

  const plan = selected.plan;
  const checks = [];
  const schema = validatePlanSchema(plan);
  checks.push(
    resultCheck(
      'plan-schema',
      schema.pass ? 'passed' : 'failed',
      schema.pass ? `Plan schema v${schema.version} valid` : schema.checks.filter((check) => !check.pass).map((check) => check.message).join('; '),
      { details: schema.checks }
    )
  );

  const statePass = plan.plan_lock && ['in-progress', 'review', 'done'].includes(plan.status);
  checks.push(resultCheck('plan-state', statePass ? 'passed' : 'failed', statePass ? 'Plan is locked in a verifiable state' : `Invalid verify state: ${plan.status}, plan_lock=${plan.plan_lock}`));

  const taskBody = plan.sections.plan || '';
  const openTasks = [...taskBody.matchAll(/^-\s*\[ \]\s+(.+)$/gm)].map((match) => match[1]);
  checks.push(resultCheck('phase-tasks', openTasks.length ? 'failed' : 'passed', openTasks.length ? `${openTasks.length} phase tasks remain open` : 'All phase tasks are complete', { openTasks }));

  const named = loadNamedChecks(workspace);
  const required = Array.isArray(plan.fm.verification?.required) ? plan.fm.verification.required : [];
  const namedResults = required.map((name) => {
    if (named.error) return resultCheck(name, 'unavailable', named.error);
    if (!Object.hasOwn(named.checks, name)) return resultCheck(name, 'unavailable', `Named check is not configured: ${name}`);
    return runNamedCheck(workspace, name, named.checks[name]);
  });
  checks.push(...namedResults);

  const byId = new Map(namedResults.map((check) => [check.id, check]));
  const criterionIds = extractAcceptanceCriteria(plan);
  const criterionMappings = plan.fm.verification?.criteria || {};
  const unverifiedCriteria = [];
  const criterionStatuses = criterionIds.map((id) => {
    const status = checkStatusForEvidence(criterionMappings[id], byId);
    if (status !== 'passed') unverifiedCriteria.push(id);
    return { id, status };
  });
  let criteriaStatus = 'passed';
  if (criterionStatuses.some((entry) => entry.status === 'failed')) criteriaStatus = 'failed';
  else if (criterionStatuses.some((entry) => entry.status === 'inconclusive')) criteriaStatus = 'inconclusive';
  checks.push(resultCheck('criteria-evidence', criteriaStatus, unverifiedCriteria.length ? `Unverified criteria: ${unverifiedCriteria.join(', ')}` : 'Every acceptance criterion has passed named evidence', { criteria: criterionStatuses }));

  const scope = validatePlanScope({ workspace, plan, base: flags.base });
  checks.push(resultCheck('scope', scope.status, scope.message, { changedFiles: scope.changedFiles, allowed: scope.allowed }));

  const requiredReviews = (plan.fm.reviews?.required || []).filter((review) => !(plan.fm.reviews?.completed || []).includes(review));
  checks.push(resultCheck('required-reviews', requiredReviews.length ? 'failed' : 'passed', requiredReviews.length ? `Missing required reviews: ${requiredReviews.join(', ')}` : 'Required reviews satisfied'));

  const openHardGaps = (plan.fm.capability_gaps || []).filter(
    (gap) => gap && typeof gap === 'object' && gap.class === 'hard' && !['done', 'bridge', 'waived'].includes(gap.fulfillment)
  );
  checks.push(resultCheck('hard-gaps', openHardGaps.length ? 'failed' : 'passed', openHardGaps.length ? `${openHardGaps.length} hard capability gaps remain open` : 'No open hard capability gaps'));

  const criticalOpen = plan.fm.reviews?.critical_open || [];
  checks.push(resultCheck('critical-findings', criticalOpen.length ? 'failed' : 'passed', criticalOpen.length ? `${criticalOpen.length} critical findings remain open` : 'No open critical review findings'));

  return finalize(workspace, flags, {
    plan: plan.path,
    checks,
    unverifiedCriteria,
    scopeViolations: scope.violations,
    openHardGaps,
    requiredReviews,
  });
}

export function exitCodeForOutcome(outcome, enforcement = 'enforce') {
  return enforcementExitCode(outcome, enforcement);
}
