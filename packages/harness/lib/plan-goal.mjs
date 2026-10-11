import { extractSection } from './plan-parse.mjs';
import { readPlanRecord } from './plan-record.mjs';

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter((v) => String(v).trim());
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/** True when ## Intent Contract has substantive body (not just empty template bullets). */
export function intentContractHasContent(text) {
  const section = extractSection(text, 'Intent Contract');
  if (!section) return false;
  const stripped = section
    .replace(/^-\s*\*\*[^:]+:\*\*\s*$/gm, '')
    .replace(/^\s*-\s*$/gm, '')
    .trim();
  return stripped.length > 0;
}

export function extractGoalFromPlan(plan) {
  if (!plan) return null;

  const record = readPlanRecord(plan.text);
  if (record) return { planPath: plan.path, intent: record.goal, success_criteria: record.acceptance, constraints: record.constraints, expected_outputs: [], intentContractExcerpt: '' };

  const intentContract = extractSection(plan.text, 'Intent Contract');
  const intent = typeof plan.fm?.intent === 'string' ? plan.fm.intent.trim() : '';
  const acceptance = extractSection(plan.text, 'Acceptance Criteria').split('\n').filter(line => /^\s*-\s+/.test(line)).map(line => line.replace(/^\s*-\s*(?:\[[ x]\]\s*)?/, '').trim());
  const success_criteria = normalizeList(plan.fm?.success_criteria).length ? normalizeList(plan.fm.success_criteria) : acceptance;
  const constraints = extractSection(plan.text, 'Constraints').split('\n').filter(line => /^\s*-\s+/.test(line)).map(line => line.replace(/^\s*-\s+/, '').trim());
  const expected_outputs = normalizeList(plan.fm?.expected_outputs);

  const hasSection = intentContractHasContent(plan.text);
  const hasFm = Boolean(intent) || success_criteria.length > 0 || expected_outputs.length > 0;
  if (!hasSection && !hasFm) return null;

  return {
    planPath: plan.path,
    intent,
    success_criteria,
    constraints,
    expected_outputs,
    intentContractExcerpt: intentContract.slice(0, 400),
  };
}
