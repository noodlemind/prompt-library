import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { readSession } from './session.mjs';
import { selectPlan } from './plan-parse.mjs';
import { extractAcceptanceCriteria, validatePlanSchema } from './plan-schema.mjs';
import { validatePlanScope } from './plan-scope.mjs';
import { createEvidenceBinding, writeEvidence } from './evidence.mjs';
import { checkSeverityFor, enforcementExitCode, loadPolicy } from './policy.mjs';
import { verifyPrimitiveGovernance } from './primitive-governance.mjs';
import { validatePlanReadiness } from './plan-readiness.mjs';
import { STRUCTURAL_CHECK_ID, runStructuralExpectations } from './structural/expectations.mjs';
import { redactSecrets } from './secret-scan.mjs';
import { inertLine } from './knowledge/store.mjs';

const CHECKS_REL = '.github/harness/checks.yaml';

// Built-in default severities. Any check without a policy entry and without a
// default here is `enforce` — exactly the pre-severity behavior.
const DEFAULT_CHECK_SEVERITIES = { [STRUCTURAL_CHECK_ID]: 'advisory' };

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

  const timeoutSeconds = config.timeout_seconds ?? 600;
  const started = Date.now();
  const execution = spawnSync(config.command[0], config.command.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    timeout: timeoutSeconds * 1000,
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const output = { stdout: trimOutput(execution.stdout), stderr: trimOutput(execution.stderr), durationMs };

  if (execution.error?.code === 'ETIMEDOUT' || execution.signal) {
    return resultCheck(name, 'timeout', `Timed out after ${timeoutSeconds}s`, output);
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

/**
 * Is this check one that can actually hold the run back? `skipped` is neutral
 * (e.g. the advisory structural check with no index) and so is `advisory` —
 * resolveOutcome excludes it, so counting it as a failure or offering it as the
 * next fix target would point the agent at the one check that can never unblock
 * the run. A check with NO severity field predates policy v2 and still counts.
 *
 * EXPORTED because it is a CONTRACT, not a local convenience (review finding):
 * the CLI's failure count and "next fix" line (commands.mjs) and the test that
 * pins this behavior must be the same predicate. A copy in the test can go on
 * passing while production drifts away from it.
 */
export function isGatingCheck(check) {
  return check.status !== 'passed' && check.status !== 'skipped' && check.severity !== 'advisory';
}

// Outcome reflects only non-advisory checks: an advisory failure is reported
// (checks + advisoryFailures in the evidence payload) but never flips the
// outcome or the exit code. A warn-severity failure degrades to inconclusive
// (exit 2 under enforce) instead of failed; `skipped` is always neutral.
function resolveOutcome(checks) {
  const gating = checks.filter((check) => check.severity !== 'advisory');
  if (gating.some((check) => check.status === 'failed' && check.severity !== 'warn')) return 'failed';
  if (gating.some((check) => check.status === 'failed' || ['unavailable', 'timeout', 'inconclusive'].includes(check.status))) {
    return 'inconclusive';
  }
  return 'passed';
}

/** The check ids the ACTIVE PLAN gates on: everything in
 * `verification.required` plus every id mapped under `verification.criteria`.
 * A policy may not downgrade any of them to advisory (policy.mjs). */
function planGatedCheckIds(plan) {
  const verification = plan?.fm?.verification;
  const ids = new Set();
  for (const name of Array.isArray(verification?.required) ? verification.required : []) {
    if (typeof name === 'string' && name) ids.add(name);
  }
  const criteria = verification?.criteria;
  if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
    for (const mapped of Object.values(criteria)) {
      for (const name of Array.isArray(mapped) ? mapped : []) {
        if (typeof name === 'string' && name) ids.add(name);
      }
    }
  }
  return ids;
}

/** Apply policy severities, refusing any advisory downgrade of a plan-gated
 * check. Returns the refusals alongside the checks so the run can report them
 * instead of silently disagreeing with the policy file. */
function applyCheckSeverities(checks, policy, planGated) {
  const refusedSeverityDowngrades = [];
  const applied = checks.map((check) => {
    const fallback = DEFAULT_CHECK_SEVERITIES[check.id] ?? 'enforce';
    const severity = checkSeverityFor(policy, check.id, fallback, planGated);
    if (severity !== 'advisory' && checkSeverityFor(policy, check.id, fallback) === 'advisory') {
      refusedSeverityDowngrades.push({ id: check.id, requested: 'advisory', effective: severity });
    }
    // `optional` is the existing ledger-rendering hook: advisory rows render
    // as warn, never error, without touching the style pipeline.
    return severity === 'advisory' ? { ...check, severity, optional: true } : { ...check, severity };
  });
  return { checks: applied, refusedSeverityDowngrades };
}

// Check messages and findings carry CURRENT-SIDE REPO TEXT (structural/
// expectations.mjs derives its symbol names from a lexical extractor whose
// per-language patterns are not length-bounded — a `.tf` string literal
// spanning newlines can produce a six-figure-byte "symbol name" — and echoes
// plan-declared expectations back verbatim), and the CANONICAL `result.checks`
// array is what `.harness/evidence/*.json`, `verify --json`, and the event log
// all serialize. Sanitizing only the advisory summary copy left every one of
// those surfaces shipping the raw text. Every other surface that renders
// less-trusted repo-derived text redacts it, flattens control characters, and
// caps it; the shipped check payload must do the same, at the one boundary
// (finalize) every consumer reads from.
const CHECK_TEXT_CAP = 240;
const CHECK_LIST_CAP = 20;
const CHECK_FINDINGS_CAP = 50;
const CHECK_DEPTH_CAP = 3;

// The free-text LIST payloads a check can carry (`message` is handled on its
// own below). `id`/`status`/`severity`/`optional`/`exitCode`/`durationMs` are
// code-set tokens, enums, or numbers — never credential carriers — and
// `stdout`/`stderr` are the trusted named command's own output, already
// length-bounded by trimOutput and deliberately left multi-line so a failing
// check stays readable.
// `details` (plan-schema / plan-readiness sub-check messages) and `openTasks`
// (verbatim `- [ ]` lines lifted out of the plan body) are PLAN-DERIVED text on
// exactly the same surfaces — `.harness/evidence/*.json`, `verify --json`, the
// event log — and a plan is an ordinary repo file a human or model writes. They
// were the two list payloads shipping unredacted, unflattened, and unbounded.
const SANITIZED_CHECK_LISTS = ['findings', 'informational', 'details', 'openTasks'];

function checkText(value) {
  return inertLine(redactSecrets(String(value ?? ''))).slice(0, CHECK_TEXT_CAP);
}

/** Redact + flatten + cap every string reachable in a finding, bound every
 * array/object to CHECK_LIST_CAP entries, and stop at CHECK_DEPTH_CAP —
 * shape-agnostic, so a check that grows a new findings field is covered
 * without this function knowing about it. */
function checkValue(value, depth = 0) {
  if (typeof value === 'string') return checkText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= CHECK_DEPTH_CAP) return null;
  if (Array.isArray(value)) return value.slice(0, CHECK_LIST_CAP).map((entry) => checkValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, CHECK_LIST_CAP)) {
      out[checkText(key)] = checkValue(entry, depth + 1);
    }
    return out;
  }
  return null;
}

/** Sanitize one check's shipped payload. Idempotent: applied at finalize and
 * again (harmlessly) by collectAdvisoryFailures on the same objects. */
export function sanitizeCheckPayload(check) {
  const sanitized = { ...check };
  if (check.message !== undefined) sanitized.message = checkText(check.message);
  for (const field of SANITIZED_CHECK_LISTS) {
    if (check[field] === undefined) continue;
    sanitized[field] = (Array.isArray(check[field]) ? check[field] : []).slice(0, CHECK_FINDINGS_CAP).map((entry) => checkValue(entry));
  }
  return sanitized;
}

export function collectAdvisoryFailures(checks) {
  return checks
    .filter((check) => check.severity === 'advisory' && !['passed', 'skipped'].includes(check.status))
    .map((check) => ({
      id: check.id,
      status: check.status,
      message: checkText(check.message),
      ...(check.findings
        ? { findings: (Array.isArray(check.findings) ? check.findings : []).slice(0, CHECK_FINDINGS_CAP).map((f) => checkValue(f)) }
        : {}),
    }));
}

function currentPhaseTasks(taskBody, phase) {
  const current = Number(phase);
  if (!Number.isInteger(current)) return taskBody;
  const heading = new RegExp(`^###\\s+Phase\\s+${current}\\b[^\\n]*\\n`, 'im');
  const match = heading.exec(taskBody);
  if (!match) return taskBody;
  const bodyStart = match.index + match[0].length;
  const remaining = taskBody.slice(bodyStart);
  const nextHeading = remaining.search(/^###\s+Phase\s+\d+\b/im);
  return nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
}

function finalize(workspace, flags, partial) {
  const policy = loadPolicy(workspace, flags.enforcement);
  const severities = applyCheckSeverities(partial.checks, policy, partial.planGatedChecks || new Set());
  // The single boundary every consumer reads from: evidence, `--json`, the
  // event log, and the ledger all serialize this array.
  const checks = severities.checks.map(sanitizeCheckPayload);
  const result = {
    outcome: partial.outcome || resolveOutcome(checks),
    plan: partial.plan || null,
    checks,
    advisoryFailures: collectAdvisoryFailures(checks),
    refusedSeverityDowngrades: severities.refusedSeverityDowngrades,
    unverifiedCriteria: partial.unverifiedCriteria || [],
    scopeViolations: partial.scopeViolations || [],
    openHardGaps: partial.openHardGaps || [],
    requiredReviews: partial.requiredReviews || [],
    enforcement: policy.enforcement,
    exemptions: policy.exemptions,
    waivers: policy.waivers,
    binding: partial.binding || null,
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

  const readiness = validatePlanReadiness(workspace, plan);
  checks.push(
    resultCheck(
      'plan-readiness',
      readiness.pass ? 'passed' : 'failed',
      readiness.pass
        ? 'Plan verification contract is ready'
        : readiness.checks.filter((check) => !check.pass).map((check) => check.message).join('; '),
      { details: readiness.checks }
    )
  );

  const statePass = plan.plan_lock && ['in-progress', 'review', 'done'].includes(plan.status);
  checks.push(resultCheck('plan-state', statePass ? 'passed' : 'failed', statePass ? 'Plan is locked in a verifiable state' : `Invalid verify state: ${plan.status}, plan_lock=${plan.plan_lock}`));

  const taskBody = currentPhaseTasks(plan.sections.plan || '', plan.phase);
  const openTasks = [...taskBody.matchAll(/^-\s*\[ \]\s+(.+)$/gm)].map((match) => match[1]);
  checks.push(resultCheck('phase-tasks', openTasks.length ? 'failed' : 'passed', openTasks.length ? `${openTasks.length} current phase tasks remain open` : 'All current phase tasks are complete', { openTasks }));

  // Bind-before-check snapshot: the workspace digest captured here must match
  // the digest captured after checks run, or the evidence would certify
  // content the checks never saw.
  const preScope = validatePlanScope({ workspace, plan, base: flags.base });
  const preBinding = createEvidenceBinding({
    workspace,
    plan,
    base: flags.base,
    changedFiles: preScope.changedFiles,
  });

  const named = loadNamedChecks(workspace);
  const required = Array.isArray(plan.fm.verification?.required) ? plan.fm.verification.required : [];
  const namedResults = required.map((name) => {
    if (!readiness.pass) return resultCheck(name, 'inconclusive', 'Not run because plan readiness failed');
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

  // Advisory structural diff vs plan (severity from policy; skips without an
  // index or a current baseline — see lib/structural/expectations.mjs).
  if (scope.status === 'inconclusive') {
    checks.push(resultCheck(STRUCTURAL_CHECK_ID, 'skipped', 'Advisory structural check skipped: changed files unavailable'));
  } else {
    const structural = runStructuralExpectations({ workspace, plan, changedFiles: scope.changedFiles });
    checks.push(
      resultCheck(STRUCTURAL_CHECK_ID, structural.status, structural.message, {
        findings: structural.findings,
        informational: structural.informational,
        baseline: structural.baseline,
      })
    );
  }

  const primitive = verifyPrimitiveGovernance(plan, scope.changedFiles, Object.keys(named.checks || {}));
  if (primitive.required) {
    checks.push(
      resultCheck(
        'primitive-evidence',
        primitive.pass ? 'passed' : 'failed',
        primitive.message,
        {
          changedPrimitives: primitive.changedPrimitives,
          missingPlan: primitive.missingPlan,
          missingEvidence: primitive.missingEvidence,
        }
      )
    );
  }

  const requiredReviews = (plan.fm.reviews?.required || []).filter((review) => !(plan.fm.reviews?.completed || []).includes(review));
  checks.push(resultCheck('required-reviews', requiredReviews.length ? 'failed' : 'passed', requiredReviews.length ? `Missing required reviews: ${requiredReviews.join(', ')}` : 'Required reviews satisfied'));

  const openHardGaps = (plan.fm.capability_gaps || []).filter(
    (gap) => gap && typeof gap === 'object' && gap.class === 'hard' && !['done', 'bridge', 'waived'].includes(gap.fulfillment)
  );
  checks.push(resultCheck('hard-gaps', openHardGaps.length ? 'failed' : 'passed', openHardGaps.length ? `${openHardGaps.length} hard capability gaps remain open` : 'No open hard capability gaps'));

  const criticalOpen = plan.fm.reviews?.critical_open || [];
  checks.push(resultCheck('critical-findings', criticalOpen.length ? 'failed' : 'passed', criticalOpen.length ? `${criticalOpen.length} critical findings remain open` : 'No open critical review findings'));

  const binding = createEvidenceBinding({
    workspace,
    plan,
    base: flags.base,
    changedFiles: scope.changedFiles,
  });
  const stable =
    preBinding.workspaceDigest === binding.workspaceDigest && preBinding.planDigest === binding.planDigest;
  checks.push(
    resultCheck(
      'workspace-stability',
      stable ? 'passed' : 'failed',
      stable
        ? 'Workspace did not change while checks ran'
        : 'Workspace or plan changed while verification checks were running; rerun harness verify'
    )
  );

  return finalize(workspace, flags, {
    plan: plan.path,
    checks,
    planGatedChecks: planGatedCheckIds(plan),
    unverifiedCriteria,
    scopeViolations: scope.violations,
    openHardGaps,
    requiredReviews,
    binding,
  });
}

export function exitCodeForOutcome(outcome, enforcement = 'enforce') {
  return enforcementExitCode(outcome, enforcement);
}
