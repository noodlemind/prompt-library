import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { extractAcceptanceCriteria } from './plan-schema.mjs';

const CHECKS_REL = '.github/harness/checks.yaml';

function result(id, pass, message) {
  return { id, pass, message };
}

function loadConfiguredChecks(workspace) {
  const full = path.join(workspace, CHECKS_REL);
  if (!fs.existsSync(full)) return { present: false, checks: null, error: null };
  try {
    const parsed = YAML.parse(fs.readFileSync(full, 'utf8'), { maxAliasCount: 50 });
    if (parsed?.version !== 1 || !parsed.checks || typeof parsed.checks !== 'object' || Array.isArray(parsed.checks)) {
      return { present: true, checks: null, error: `${CHECKS_REL} must declare version: 1 and checks` };
    }
    return { present: true, checks: parsed.checks, error: null };
  } catch (error) {
    return { present: true, checks: null, error: `Invalid ${CHECKS_REL}: ${error.message}` };
  }
}

function schemaFocused(name, config) {
  const descriptor = [name, ...(Array.isArray(config?.command) ? config.command : [])]
    .join(' ')
    .toLowerCase();
  return /(^|[^a-z])schema([^a-z]|$)/.test(descriptor);
}

function hasSchemaOutput(outputs) {
  return outputs.some((output) => {
    const normalized = String(output).toLowerCase();
    return /(^|[/_.-])schemas?([/_.-]|$)/.test(normalized) || /\.schema\.[a-z0-9]+$/.test(normalized);
  });
}

function relevantAlternatives(configured) {
  return Object.entries(configured)
    .filter(([name, config]) => !schemaFocused(name, config))
    .map(([name]) => name);
}

export function validatePlanReadiness(workspace, plan) {
  const checks = [];
  if (!plan) return { pass: false, checks: [result('readiness-plan', false, 'Plan not found')] };

  if (plan.status === 'planned') {
    const checkedCriteria = [...(plan.sections.acceptanceText || '').matchAll(/^-\s*\[[xX]\]\s+(.+)$/gm)].map((match) => match[1]);
    const checkedTasks = [...(plan.sections.plan || '').matchAll(/^-\s*\[[xX]\]\s+(.+)$/gm)].map((match) => match[1]);
    const clean = checkedCriteria.length === 0 && checkedTasks.length === 0;
    checks.push(
      result(
        'planned-work-state',
        clean,
        clean
          ? 'Planned acceptance criteria and tasks are unchecked'
          : `A planned plan cannot claim completed work (${checkedCriteria.length} checked criteria, ${checkedTasks.length} checked tasks); leave new items unchecked until implementation and evidence exist`
      )
    );
  }

  const required = Array.isArray(plan.fm.verification?.required) ? plan.fm.verification.required : [];
  const criteria = extractAcceptanceCriteria(plan);
  const mappings = plan.fm.verification?.criteria || {};
  const invalidMappings = criteria.filter((id) => {
    const mapped = mappings[id];
    return !Array.isArray(mapped) || mapped.length === 0 || mapped.some((name) => !required.includes(name));
  });
  checks.push(
    result(
      'criterion-mappings',
      invalidMappings.length === 0,
      invalidMappings.length
        ? `Every acceptance criterion must map to one or more verification.required checks; fix: ${invalidMappings.join(', ')}`
        : 'Every acceptance criterion maps to a required named check'
    )
  );

  const configured = loadConfiguredChecks(workspace);
  if (configured.error) {
    checks.push(result('configured-checks', false, configured.error));
  } else if (configured.present) {
    const missing = required.filter((name) => !Object.hasOwn(configured.checks, name));
    checks.push(
      result(
        'configured-checks',
        missing.length === 0,
        missing.length ? `verification.required contains unconfigured checks: ${missing.join(', ')}` : 'All required checks are configured'
      )
    );

    const outputs = Array.isArray(plan.fm.expected_outputs) ? plan.fm.expected_outputs : [];
    const mismatched = required.filter(
      (name) => Object.hasOwn(configured.checks, name) && schemaFocused(name, configured.checks[name]) && !hasSchemaOutput(outputs)
    );
    const alternatives = relevantAlternatives(configured.checks);
    checks.push(
      result(
        'check-output-relevance',
        mismatched.length === 0,
        mismatched.length
          ? `Schema-focused check ${mismatched.join(', ')} is not relevant because expected_outputs contains no schema artifact; choose a relevant configured check${alternatives.length ? ` such as ${alternatives.join(', ')}` : ''}`
          : 'Required checks are relevant to the expected output types'
      )
    );
  }

  return { pass: checks.every((check) => check.pass), checks };
}
