import { readSession } from './session.mjs';
import { loadPlan, pickActivePlan, listPlanRels } from './plan-parse.mjs';
import { intentContractHasContent } from './plan-goal.mjs';
import { validatePlanSchema } from './plan-schema.mjs';

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

function addCheck(checks, { id, pass, message, severity }) {
  checks.push({ id, pass, message, severity: pass ? 'ok' : severity });
}

export function runValidatePlan({ workspace, flags, planPath = null }) {
  const checks = [];
  let pass = true;
  let exitCode = 0;

  const session = readSession(workspace);
  let plan = null;

  if (planPath) {
    const normalized = planPath.replace(/\\/g, '/');
    const rel = normalized.includes('docs/plans/')
      ? normalized.slice(normalized.indexOf('docs/plans/'))
      : `docs/plans/${normalized.split('/').pop()}`;
    plan = loadPlan(workspace, rel);
  } else {
    plan = pickActivePlan(workspace, session, [], listPlanRels(workspace));
  }

  if (!plan) {
    addCheck(checks, {
      id: 'P0',
      pass: false,
      message: 'No plan found — pass --plan docs/plans/<file>.md or run orient',
      severity: 'fail',
    });
    return buildResult({ pass: false, exitCode: 1, plan: null, checks });
  }

  addCheck(checks, { id: 'P0', pass: true, message: `Plan: ${plan.path}`, severity: 'ok' });

  if (plan.fm.plan_schema !== undefined) {
    const schema = validatePlanSchema(plan);
    addCheck(checks, {
      id: 'P-schema',
      pass: schema.pass,
      message: schema.pass
        ? `Plan schema v${schema.version} valid`
        : schema.checks.filter((check) => !check.pass).map((check) => check.message).join('; '),
      severity: 'fail',
    });
    if (!schema.pass) pass = false;
  }

  const sectionChecks = [
    { id: 'S1', ok: plan.sections.overview, label: '## Overview' },
    { id: 'S2', ok: plan.sections.acceptance, label: '## Acceptance Criteria' },
    { id: 'S3', ok: Boolean(plan.sections.verificationPlan), label: '## Verification Plan' },
    { id: 'S4', ok: /## Impacted Files/i.test(plan.text), label: '## Impacted Files' },
  ];

  for (const { id, ok, label } of sectionChecks) {
    if (!ok) {
      addCheck(checks, { id, pass: false, message: `Missing ${label}`, severity: 'fail' });
      pass = false;
    } else {
      addCheck(checks, { id, pass: true, message: `${label} present`, severity: 'ok' });
    }
  }

  if (intentContractHasContent(plan.text)) {
    addCheck(checks, { id: 'S5', pass: true, message: '## Intent Contract present', severity: 'ok' });
  } else if (plan.plan_lock) {
    addCheck(checks, {
      id: 'S5',
      pass: false,
      message: 'Missing or empty ## Intent Contract on locked plan',
      severity: flags.strictIntent ? 'fail' : 'warn',
    });
    if (flags.strictIntent) pass = false;
    else exitCode = Math.max(exitCode, 2);
  }

  if (plan.plan_lock) {
    for (const [id, field, label] of [
      ['I1', 'intent', 'intent frontmatter'],
      ['I2', 'expected_outputs', 'expected_outputs frontmatter'],
      ['I3', 'success_criteria', 'success_criteria frontmatter'],
    ]) {
      const ok = hasValue(plan.fm[field]);
      if (!ok) {
        addCheck(checks, {
          id,
          pass: false,
          message: `Missing ${label}`,
          severity: flags.strictIntent ? 'fail' : 'warn',
        });
        if (flags.strictIntent) pass = false;
        else exitCode = Math.max(exitCode, 2);
      } else {
        addCheck(checks, { id, pass: true, message: `${label} present`, severity: 'ok' });
      }
    }
  }

  if (!plan.sections.activity) {
    addCheck(checks, {
      id: 'S6',
      pass: false,
      message: 'Missing ## Activity',
      severity: 'warn',
    });
    exitCode = Math.max(exitCode, 2);
  } else {
    addCheck(checks, { id: 'S6', pass: true, message: '## Activity present', severity: 'ok' });
  }

  return buildResult({
    pass,
    exitCode: pass ? exitCode : 1,
    plan: { path: plan.path, status: plan.status, plan_lock: plan.plan_lock },
    checks,
  });
}

function buildResult({ pass, exitCode, plan, checks }) {
  const failures = checks.filter((c) => !c.pass);
  return {
    pass,
    exitCode,
    plan,
    checks,
    blockedReason: failures.length
      ? failures.map((c) => c.message).join('; ')
      : null,
    nextTools: pass
      ? ['harness gate --phase implement']
      : ['read ensure-plan/SKILL.md', 'harness orient'],
  };
}
