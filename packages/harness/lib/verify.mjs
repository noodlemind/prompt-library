import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readSession } from './session.mjs';
import { selectPlan } from './plan-parse.mjs';
import { extractAcceptanceCriteria, validatePlanSchema } from './plan-schema.mjs';
import { validatePlanScope } from './plan-scope.mjs';
import { createEvidenceBinding, writeEvidence } from './evidence.mjs';
import { checkSeverityFor, enforcementExitCode, loadPolicy } from './policy.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { isProjectTrusted } from './trust.mjs';
import { verifyPrimitiveGovernance } from './primitive-governance.mjs';
import { validatePlanReadiness } from './plan-readiness.mjs';
import { STRUCTURAL_CHECK_ID, runStructuralExpectations } from './structural/expectations.mjs';
import { redactSecrets } from './secret-scan.mjs';
import { inertLine } from './knowledge/store.mjs';
import { CHECKS_REL, loadNamedChecks, validateCommand, runNamedCheck } from './checks.mjs';
import { createRedactor, redactionMarker } from './redact.mjs';

const DEFAULT_CHECK_SEVERITIES = { [STRUCTURAL_CHECK_ID]: 'advisory' };

function resultCheck(id, status, message, extra = {}) {
  return { id, status, message, ...extra };
}

export const STREAM_MAX_BYTES_PER_CHECK = 16 * 1024;
export const STREAM_MAX_LINE_BYTES = 512;
const STREAM_CARRY_CAP_BYTES = 8 * 1024;
const STREAM_BLOCK_MAX_BYTES = 16 * 1024;

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export function createCheckOutputStreamer({ check, onEvent, redactText, maxBytes = STREAM_MAX_BYTES_PER_CHECK, maxLineBytes = STREAM_MAX_LINE_BYTES }) {
  const PRIVATE_KEY_MASK = redactionMarker('private-key');
  // Per-stream state: partial-line carry plus the multi-line PEM hold.
  const state = {
    stdout: { carry: '', blockOpen: false, blockLines: [], blockBytes: 0, blockMasked: false },
    stderr: { carry: '', blockOpen: false, blockLines: [], blockBytes: 0, blockMasked: false },
  };
    function rowBytes(payload) {
    return Buffer.byteLength(JSON.stringify({ schema: 1, event: 'row', ...payload }), 'utf8') + 1;
  }
    const markerBytes = Math.max(
    rowBytes({ check, stream: 'stdout', truncated: true }),
    rowBytes({ check, stream: 'stderr', truncated: true }),
  );
  let emittedBytes = 0;
  let truncated = false;

  function clipToBytes(text, cap) {
    if (Buffer.byteLength(text, 'utf8') <= cap) return text;
        let bytes = 0;
    let end = 0;
    for (const ch of text) {
      const chBytes = Buffer.byteLength(ch, 'utf8');
      if (bytes + chBytes > cap) break;
      bytes += chBytes;
      end += ch.length;
    }
    return text.slice(0, end);
  }

  function budgetRow(stream, payload) {
    if (emittedBytes + rowBytes(payload) + markerBytes > maxBytes) {
      truncated = true;
      onEvent('row', { check, stream, truncated: true });
      return;
    }
    emittedBytes += rowBytes(payload);
    onEvent('row', payload);
  }

    function emitLine(stream, line) {
    if (truncated || !line) return;
    const safe = clipToBytes(redactText(line), maxLineBytes);
    budgetRow(stream, { check, stream, line: safe });
  }

    function emitPrivateKeyMask(stream) {
    if (truncated) return;
    budgetRow(stream, { check, stream, line: PRIVATE_KEY_MASK });
  }

  function resetBlock(s) {
    s.blockOpen = false;
    s.blockLines = [];
    s.blockBytes = 0;
    s.blockMasked = false;
  }

  function closeBlock(stream) {
    const s = state[stream];
    const alreadyMasked = s.blockMasked;
    resetBlock(s);
        if (!alreadyMasked) emitPrivateKeyMask(stream);
  }

  // One complete line (newline already stripped) through the PEM state machine.
  function feedLine(stream, line) {
    if (truncated) return;
    const s = state[stream];
    if (!s.blockOpen) {
      if (PEM_BEGIN_RE.test(line)) {
                if (PEM_END_RE.test(line)) {
          emitPrivateKeyMask(stream);
          return;
        }
        s.blockOpen = true;
        s.blockLines = [line];
        s.blockBytes = Buffer.byteLength(line, 'utf8');
        s.blockMasked = false;
        return;
      }
      emitLine(stream, line);
      return;
    }
    // Inside a held block.
    s.blockBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (!s.blockMasked) s.blockLines.push(line);
    if (PEM_END_RE.test(line)) {
      closeBlock(stream);
      return;
    }
    if (s.blockBytes > STREAM_BLOCK_MAX_BYTES && !s.blockMasked) {
            emitPrivateKeyMask(stream);
      s.blockLines = [];
      s.blockMasked = true;
    }
  }

  function push(stream, chunk) {
    if (truncated) return;
    const s = state[stream];
    s.carry += chunk;
    let idx;
    while ((idx = s.carry.indexOf('\n')) !== -1) {
      let line = s.carry.slice(0, idx);
            if (line.endsWith('\r')) line = line.slice(0, -1);
      s.carry = s.carry.slice(idx + 1);
      feedLine(stream, line);
      if (truncated) {
        s.carry = '';
        return;
      }
    }
    if (s.carry.length > STREAM_CARRY_CAP_BYTES) {
      const line = s.carry;
      s.carry = '';
      feedLine(stream, line);
    }
  }

  function flush() {
    for (const stream of ['stdout', 'stderr']) {
      const s = state[stream];
      if (s.carry) {
        const line = s.carry;
        s.carry = '';
        feedLine(stream, line);
      }
            if (s.blockOpen) closeBlock(stream);
    }
  }

  return {
    onStdout: (chunk) => push('stdout', chunk),
    onStderr: (chunk) => push('stderr', chunk),
    flush,
  };
}

export function unifiedStatusForCheck(check) {
  if (check.status === 'passed') return 'ok';
  if (check.status === 'timeout') return 'timed-out';
    if (check.cancelled) return 'cancelled';
  return 'failed';
}

export function statusForVerifyResult(result) {
  if (result.outcome === 'cancelled') return 'cancelled';
  if (result.outcome === 'passed') return 'ok';
  if (result.outcome !== 'failed' && (result.checks || []).some((check) => check.status === 'timeout')) return 'timed-out';
  return 'failed';
}

function checkStatusForEvidence(mapped, byId) {
  if (!Array.isArray(mapped) || mapped.length === 0) return 'failed';
  const statuses = mapped.map((id) => byId.get(id)?.status || 'unavailable');
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => ['unavailable', 'timeout', 'inconclusive'].includes(status))) return 'inconclusive';
  return statuses.every((status) => status === 'passed') ? 'passed' : 'inconclusive';
}

export function isGatingCheck(check) {
  return check.status !== 'passed' && check.status !== 'skipped' && check.severity !== 'advisory';
}

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
        return severity === 'advisory' ? { ...check, severity, optional: true } : { ...check, severity };
  });
  return { checks: applied, refusedSeverityDowngrades };
}

const CHECK_TEXT_CAP = 240;
const CHECK_LIST_CAP = 20;
const CHECK_FINDINGS_CAP = 50;
const CHECK_DEPTH_CAP = 3;

const SANITIZED_CHECK_LISTS = ['findings', 'informational', 'details', 'openTasks'];

function checkText(value) {
  return inertLine(redactSecrets(String(value ?? ''))).slice(0, CHECK_TEXT_CAP);
}

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

function finalize(workspace, flags, partial, { skipEvidence = false } = {}) {
  const policy = loadPolicy(workspace, flags.enforcement, { copilotHome: resolveCopilotHome(flags.copilotHome) });
  const severities = applyCheckSeverities(partial.checks, policy, partial.planGatedChecks || new Set());
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
        projectPolicyIgnored: policy.projectPolicyIgnored,
    projectPolicyError: policy.projectPolicyError ?? null,
    exemptions: policy.exemptions,
    waivers: policy.waivers,
    binding: partial.binding || null,
    evidencePath: null,
  };
  result.evidencePath = skipEvidence ? null : writeEvidence(workspace, result, flags.dryRun);
  return result;
}

export async function runVerify({ workspace, flags, signal, onEvent, events = null }) {
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

    const preScope = validatePlanScope({ workspace, plan, base: flags.base });
  const preBinding = createEvidenceBinding({
    workspace,
    plan,
    base: flags.base,
    changedFiles: preScope.changedFiles,
  });

  const named = loadNamedChecks(workspace);
  const required = Array.isArray(plan.fm.verification?.required) ? plan.fm.verification.required : [];
    const streamRedactor = onEvent ? createRedactor() : null;
    const namedChecksTrusted = isProjectTrusted({ workspace, copilotHome: resolveCopilotHome(flags.copilotHome) });
  const namedResults = [];
  for (const name of required) {
    if (!readiness.pass) {
      namedResults.push(resultCheck(name, 'inconclusive', 'Not run because plan readiness failed'));
      continue;
    }
    if (!namedChecksTrusted) {
      namedResults.push(resultCheck(
        name,
        'unavailable',
        `Not run: this project is not trusted, and a named check executes repo-authored commands. Approve it with \`harness trust approve\` after reading ${CHECKS_REL}.`,
      ));
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
    const streamer = onEvent
      ? createCheckOutputStreamer({ check: name, onEvent, redactText: streamRedactor.redactText })
      : null;
    const outcome = await runNamedCheck(workspace, name, named.checks[name], {
      signal,
      onStdout: streamer?.onStdout,
      onStderr: streamer?.onStderr,
      copilotHome: resolveCopilotHome(flags.copilotHome),
      events,
    });
    streamer?.flush();
    onEvent?.('row', { check: name, status: outcome.status, unifiedStatus: unifiedStatusForCheck(outcome), message: outcome.message });
    namedResults.push(outcome);
    if (signal?.aborted) break; // stop running further checks once cancelled
  }
  checks.push(...namedResults);

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
