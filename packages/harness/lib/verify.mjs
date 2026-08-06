import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readSession } from './session.mjs';
import { selectPlan } from './plan-parse.mjs';
import { extractAcceptanceCriteria, validatePlanSchema } from './plan-schema.mjs';
import { validatePlanScope } from './plan-scope.mjs';
import { createEvidenceBinding, writeEvidence } from './evidence.mjs';
import { enforcementExitCode, loadPolicy } from './policy.mjs';
import { verifyPrimitiveGovernance } from './primitive-governance.mjs';
import { validatePlanReadiness } from './plan-readiness.mjs';
import { runProcess } from './runner.mjs';

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

// P1.6 (AC8): named checks now run through lib/runner.mjs's async spawn
// instead of a blocking spawnSync — the same 1 MiB buffer cap as before, plus
// an optional caller-supplied AbortSignal so a check-in-flight can actually
// be cancelled (Ctrl-C -> SIGINT -> AbortSignal, wired in bin/harness.mjs for
// `verify` only). The legacy per-check `status` vocabulary
// (passed|failed|timeout|unavailable) is preserved byte-for-byte for every
// outcome the old spawnSync path could produce; `runProcess`'s
// 'cancelled' status is new (spawnSync had no cancellation concept) and maps
// to 'unavailable' here — the run-level short-circuit in runVerify (see
// below) is what actually matters for AC8, not this one check's own legacy
// status label.
async function runNamedCheck(workspace, name, config, { signal } = {}) {
  const invalid = validateCommand(name, config);
  if (invalid) return resultCheck(name, 'unavailable', invalid);

  const timeoutSeconds = config.timeout_seconds ?? 600;
  const execution = await runProcess({
    argv: config.command,
    cwd: workspace,
    timeoutMs: timeoutSeconds * 1000,
    signal,
    maxBuffer: 1024 * 1024,
  });
  const output = { stdout: trimOutput(execution.stdout), stderr: trimOutput(execution.stderr), durationMs: execution.durationMs };

  if (execution.status === 'cancelled') {
    return resultCheck(name, 'unavailable', 'Cancelled — verification was interrupted', output);
  }
  if (execution.status === 'timed-out') {
    return resultCheck(name, 'timeout', `Timed out after ${timeoutSeconds}s`, output);
  }
  if (execution.status === 'failed' && execution.exitCode === null) {
    // Spawn-level failure (command not found, etc.) or death by an external
    // signal we didn't ask for — mirrors the old spawnSync `execution.error`
    // branch: no real exit code was ever reported.
    const detail = execution.signalName ? `Terminated by signal ${execution.signalName}` : 'Named check could not be spawned';
    return resultCheck(name, 'unavailable', detail, output);
  }
  if (execution.status === 'failed') {
    return resultCheck(name, 'failed', `Exited with status ${execution.exitCode}`, { ...output, exitCode: execution.exitCode });
  }
  return resultCheck(name, 'passed', 'Named check passed', { ...output, exitCode: 0 });
}

// The unified ok|failed|cancelled|timed-out status vocabulary (lib/envelope.mjs)
// for ONE named check's legacy status label — used only by the new `verify
// --output jsonl` row events (AC8's "terminal row with the unified status
// vocabulary"); the legacy `checks[].status` field above is untouched.
export function unifiedStatusForCheck(check) {
  if (check.status === 'passed') return 'ok';
  if (check.status === 'timeout') return 'timed-out';
  return 'failed';
}

// Same unified vocabulary, for the WHOLE verify run (the jsonl stream's
// terminal `result` row). A judgment call, documented: `cancelled` wins
// outright (the run was interrupted, nothing else matters); `passed` -> ok;
// a run whose only reason for not passing is a per-check timeout reports
// `timed-out` at the run level too (AC8: "timeout per check yields
// timed-out distinctly" — carried through to the terminal row, not just the
// individual check); everything else (failed, inconclusive for any other
// reason) is a generic `failed`.
export function statusForVerifyResult(result) {
  if (result.outcome === 'cancelled') return 'cancelled';
  if (result.outcome === 'passed') return 'ok';
  if ((result.checks || []).some((check) => check.status === 'timeout')) return 'timed-out';
  return 'failed';
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

// `skipEvidence` (AC8): a cancelled run must never write evidence — the
// checks array is a partial, interrupted snapshot, not something a later
// `compound`/completion gate should ever bind to. Every other caller keeps
// writing evidence exactly as before.
function finalize(workspace, flags, partial, { skipEvidence = false } = {}) {
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
    binding: partial.binding || null,
    evidencePath: null,
  };
  result.evidencePath = skipEvidence ? null : writeEvidence(workspace, result, flags.dryRun);
  return result;
}

// P1.6 (AC8): async now that named checks run through lib/runner.mjs.
// `signal` (an AbortSignal, optional) cancels a check in flight; `onEvent`
// (optional `(event, fields) => void`) is the streaming hook `verify
// --output jsonl` wires to lib/envelope.mjs's createJsonlStream — see
// lib/commands.mjs's cmdVerify. Neither parameter changes behavior for any
// caller that omits them (doctor.mjs's fixture probe, every existing test).
export async function runVerify({ workspace, flags, signal, onEvent }) {
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
  // Sequential (not Promise.all): a later check must never start once
  // cancellation has been observed, and streaming rows must land in the same
  // order checks actually ran in.
  const namedResults = [];
  for (const name of required) {
    if (!readiness.pass) {
      namedResults.push(resultCheck(name, 'inconclusive', 'Not run because plan readiness failed'));
      continue;
    }
    if (named.error) {
      namedResults.push(resultCheck(name, 'unavailable', named.error));
      continue;
    }
    if (!Object.hasOwn(named.checks, name)) {
      namedResults.push(resultCheck(name, 'unavailable', `Named check is not configured: ${name}`));
      continue;
    }
    onEvent?.('progress', { check: name, phase: 'start' });
    const outcome = await runNamedCheck(workspace, name, named.checks[name], { signal });
    onEvent?.('row', { check: name, status: outcome.status, unifiedStatus: unifiedStatusForCheck(outcome), message: outcome.message });
    namedResults.push(outcome);
    if (signal?.aborted) break; // stop running further checks once cancelled
  }
  checks.push(...namedResults);

  // AC8: cancellation short-circuits the whole run — no further checks
  // (scope, criteria-evidence, workspace-stability, …) run against a
  // partial/interrupted snapshot, and evidence is never written for it.
  if (signal?.aborted) {
    return finalize(
      workspace,
      flags,
      {
        outcome: 'cancelled',
        plan: plan.path,
        checks,
      },
      { skipEvidence: true }
    );
  }

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
