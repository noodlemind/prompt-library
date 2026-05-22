import fs from 'fs';
import path from 'path';
import { readSession } from './session.mjs';
import { pickActivePlan, listPlanRels, parsePlanFrontmatter } from './plan-parse.mjs';
import { findMatchingPlans } from './recall-rank.mjs';

export function runGate({ workspace, flags, query = '' }) {
  const session = readSession(workspace);
  const phase = flags.phase || 'implement';
  const checks = [];
  let pass = true;
  let exitCode = 0;

  const planPaths = listPlanRels(workspace);
  const matches = query ? findMatchingPlans(workspace, query, 5) : [];
  const plan = pickActivePlan(workspace, session, matches, planPaths);

  if (!plan && planPaths.length === 0) {
    checks.push({
      id: 'C1',
      pass: false,
      message: 'No plan under docs/plans/',
      severity: 'fail',
    });
    pass = false;
  } else if (!plan) {
    checks.push({
      id: 'C1',
      pass: false,
      message: `Plans exist (${planPaths.length}) but no active plan — run harness orient or set session.activePlan`,
      severity: 'fail',
    });
    pass = false;
  } else {
    checks.push({ id: 'C1', pass: true, message: `Plan: ${plan.path}`, severity: 'ok' });

    if (!plan.sections.overview) {
      checks.push({ id: 'C1a', pass: false, message: 'Missing ## Overview', severity: 'fail' });
      pass = false;
    }
    if (!plan.sections.acceptance) {
      checks.push({ id: 'C1b', pass: false, message: 'Missing ## Acceptance Criteria', severity: 'fail' });
      pass = false;
    }
    if (!plan.sections.activity) {
      checks.push({
        id: 'C4',
        pass: false,
        message: 'Missing ## Activity',
        severity: phase === 'implement' ? 'fail' : 'warn',
      });
      if (phase === 'implement') pass = false;
      else exitCode = Math.max(exitCode, 2);
    } else {
      checks.push({ id: 'C4', pass: true, message: '## Activity present', severity: 'ok' });
    }

    if (plan.status === 'blocked-capability') {
      checks.push({
        id: 'CAP',
        pass: false,
        message: 'status: blocked-capability — fulfill gap before implement',
        severity: 'fail',
      });
      pass = false;
    }

    if (phase === 'implement' || phase === 'default') {
      if (!plan.plan_lock) {
        checks.push({
          id: 'C3',
          pass: false,
          message: 'plan_lock is not true — run /ensure-plan before editFiles',
          severity: 'fail',
        });
        pass = false;
      } else {
        checks.push({ id: 'C3', pass: true, message: 'plan_lock: true', severity: 'ok' });
      }
    }

    if (phase === 'verify') {
      const vp = /## Verification Plan/i.test(plan.text);
      const tests =
        /npm test|pytest|mvn test|gradle test|go test|cargo test|vitest|jest/i.test(plan.text) ||
        /tests?\s+(pass|run|green)/i.test(plan.sections.activity || '');
      if (!vp && !tests) {
        checks.push({
          id: 'V1',
          pass: false,
          message: 'No verification evidence in plan (Verification Plan or Activity)',
          severity: 'warn',
        });
        exitCode = Math.max(exitCode, 2);
      } else {
        checks.push({ id: 'V1', pass: true, message: 'Verification evidence found', severity: 'ok' });
      }
    }
  }

  if (session?.waiver?.capture && phase === 'implement') {
    checks.push({
      id: 'WAIVER',
      pass: true,
      message: `Capture waiver: ${session.waiver.capture}`,
      severity: 'warn',
    });
    exitCode = Math.max(exitCode, 2);
  }

  const result = {
    pass,
    phase,
    exitCode: pass ? exitCode : 1,
    plan: plan ? { path: plan.path, status: plan.status, plan_lock: plan.plan_lock } : null,
    checks,
    blockedReason: pass ? null : checks.filter((c) => !c.pass).map((c) => c.message).join('; '),
    nextTools: pass
      ? phase === 'verify'
        ? ['harness compound', '/auto-compound']
        : ['editFiles (scoped)', 'harness gate --phase verify']
      : ['harness orient', '/ensure-plan', '/ensure-capability'],
  };

  return result;
}

/** Quick scan for any locked plan without full gate context */
export function scanPlansForGate(workspace) {
  for (const rel of listPlanRels(workspace)) {
    const full = path.join(workspace, rel);
    const text = fs.readFileSync(full, 'utf8');
    const fm = parsePlanFrontmatter(text);
    if (fm.plan_lock === 'true') return rel;
  }
  return null;
}
