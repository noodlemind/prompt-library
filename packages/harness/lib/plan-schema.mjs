import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { extractSection } from './plan-parse.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemas = new Map();

function loadSchema(version) {
  if (schemas.has(version)) return schemas.get(version);
  const schemaPath = path.join(packageRoot, 'config', `plan-schema.v${version}.yaml`);
  if (!fs.existsSync(schemaPath)) return null;
  const schema = YAML.parse(fs.readFileSync(schemaPath, 'utf8'));
  schemas.set(version, schema);
  return schema;
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

export function extractAcceptanceCriteria(plan) {
  const body = plan.sections?.acceptanceText || extractSection(plan.text, 'Acceptance Criteria');
  return [...body.matchAll(/^-\s*\[[ xX]\]\s*\*\*([A-Za-z]+\d+)\*\*/gm)].map((match) => match[1]);
}

export function validatePlanSchema(plan) {
  const checks = [];
  if (!plan) return { pass: false, version: null, checks: [{ id: 'schema', pass: false, message: 'Plan not found' }] };
  if (plan.fm?.__parseError) {
    return {
      pass: false,
      version: null,
      checks: [{ id: 'schema-yaml', pass: false, message: `Invalid YAML frontmatter: ${plan.fm.__parseError}` }],
    };
  }

  const version = Number(plan.fm.plan_schema);
  const schema = Number.isInteger(version) ? loadSchema(version) : null;
  if (!schema) {
    return {
      pass: false,
      version: Number.isInteger(version) ? version : null,
      checks: [{ id: 'schema-version', pass: false, message: 'Missing or unsupported plan_schema' }],
    };
  }

  for (const field of schema.required_frontmatter) {
    const emptyArrayAllowed = !plan.plan_lock || field === 'capability_gaps';
    const pass = hasValue(plan.fm[field]) || (emptyArrayAllowed && Array.isArray(plan.fm[field]) && plan.fm[field].length === 0);
    checks.push({ id: `field:${field}`, pass, message: pass ? `${field} present` : `Missing ${field}` });
  }

  checks.push({
    id: 'status',
    pass: schema.statuses.includes(plan.fm.status),
    message: schema.statuses.includes(plan.fm.status) ? 'status valid' : `Invalid status: ${plan.fm.status}`,
  });
  checks.push({
    id: 'risk',
    pass: schema.risks.includes(plan.fm.risk),
    message: schema.risks.includes(plan.fm.risk) ? 'risk valid' : `Invalid risk: ${plan.fm.risk}`,
  });

  for (const section of schema.required_sections) {
    const pass = Boolean(extractSection(plan.text, section));
    checks.push({ id: `section:${section}`, pass, message: pass ? `## ${section} present` : `Missing ## ${section}` });
  }

  const verification = plan.fm.verification;
  const reviews = plan.fm.reviews;
  const verificationRequired = verification?.required;
  const verificationShape = Boolean(
    verification &&
      Array.isArray(verificationRequired) &&
      (!plan.plan_lock || verificationRequired.length > 0) &&
      verification.criteria &&
      typeof verification.criteria === 'object' &&
      !Array.isArray(verification.criteria)
  );
  checks.push({
    id: 'verification-shape',
    pass: verificationShape,
    message: 'verification requires a non-empty named-check array on locked plans and criterion mappings',
  });
  checks.push({
    id: 'reviews-shape',
    pass: Boolean(reviews && Array.isArray(reviews.required) && Array.isArray(reviews.completed) && Array.isArray(reviews.critical_open)),
    message: 'reviews requires required, completed, and critical_open arrays',
  });

  const criteria = extractAcceptanceCriteria(plan);
  const uniqueCriteria = new Set(criteria);
  checks.push({
    id: 'criteria-ids',
    pass: criteria.length > 0 && uniqueCriteria.size === criteria.length,
    message:
      criteria.length === 0
        ? 'Acceptance criteria need stable IDs such as **AC1**'
        : uniqueCriteria.size !== criteria.length
          ? 'Acceptance criterion IDs must be unique'
          : `${criteria.length} unique acceptance criteria identified`,
  });

  return { pass: checks.every((check) => check.pass), version, checks, criteria };
}
