import { parseImpactedFiles } from './plan-scope.mjs';

const PRIMITIVE_PREFIXES = [
  '.github/skills/',
  '.github/agents/',
  '.github/instructions/',
  '.github/prompts/',
  '.github/checks/',
  'enterprise/skills/',
];

const PRIMITIVE_FILES = new Set(['knowledge/capability-registry.yaml']);
const SKILL_EVIDENCE = ['prompt-contracts', 'host-contracts', 'build-assets'];

export function isPrimitivePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return PRIMITIVE_FILES.has(normalized) || PRIMITIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function planCheck(id, pass, message) {
  return { id, pass, message, severity: pass ? 'ok' : 'fail' };
}

export function primitivePlanGovernance(plan) {
  const paths = parseImpactedFiles(plan).filter(isPrimitivePath);
  if (paths.length === 0) return { required: false, paths, checks: [] };
  const text = plan.text || '';
  const skills = Array.isArray(plan.fm.skills_used) ? plan.fm.skills_used : [];
  const intentSurface = [
    plan.fm.intent,
    ...(Array.isArray(plan.fm.expected_outputs) ? plan.fm.expected_outputs : []),
    ...(Array.isArray(plan.fm.success_criteria) ? plan.fm.success_criteria : []),
  ].filter(Boolean).join(' ');
  const javaAwsMigration = /java/i.test(intentSurface) && /aws/i.test(intentSurface) && /(?:migration|upgrade)/i.test(intentSurface);
  const requirements = [
    ['PR1', skills.includes('create-primitive'), 'Read ~/.copilot/skills/create-primitive/SKILL.md and record create-primitive in skills_used'],
    ['PR2', /Primitive classification\s*:/i.test(text), 'Plan must state primitive classification'],
    ['PR3', /(?:Existing-capability )?overlap analysis\s*:/i.test(text), 'Plan must state existing-capability overlap analysis'],
    ['PR4', /(?:Intended )?artifact structure\s*:/i.test(text), 'Plan must state intended artifact structure'],
    ['PR5', /Trigger and negative-trigger implications\s*:/i.test(text), 'Plan must state trigger and negative-trigger implications'],
    ['PR6', /Verification expectations\s*:/i.test(text), 'Plan must state primitive verification expectations'],
    ['PR7', /Registry and documentation impact\s*:/i.test(text), 'Plan must state registry and documentation impact'],
  ];
  if (javaAwsMigration) {
    requirements.push([
      'PR8',
      /\/java\s+skill/i.test(text) && /\/aws\s+skill/i.test(text),
      'Java/AWS migration primitives must explicitly compare the existing /java skill and existing /aws skill',
    ]);
  }
  return {
    required: true,
    paths,
    checks: requirements.map(([id, pass, message]) => planCheck(id, pass, message)),
  };
}

export function verifyPrimitiveGovernance(plan, changedFiles, availableChecks = []) {
  const changedPrimitives = (changedFiles || []).filter(isPrimitivePath);
  if (changedPrimitives.length === 0) return { required: false, pass: true, message: 'No primitive paths changed' };
  const planGovernance = primitivePlanGovernance(plan);
  const missingPlan = planGovernance.checks.filter((check) => !check.pass).map((check) => check.id);
  const skillChanged = changedPrimitives.some((file) => /^(?:\.github|enterprise)\/skills\//.test(file));
  const named = new Set(Array.isArray(plan.fm.verification?.required) ? plan.fm.verification.required : []);
  const configured = new Set(availableChecks);
  const applicableEvidence = SKILL_EVIDENCE.filter((check) => configured.has(check));
  const missingEvidence = skillChanged
    ? applicableEvidence.length > 0
      ? applicableEvidence.filter((check) => !named.has(check))
      : named.size > 0
        ? []
        : ['at least one configured named check']
    : [];
  const failures = [];
  if (missingPlan.length) failures.push(`plan governance: ${missingPlan.join(', ')}`);
  if (missingEvidence.length) failures.push(`missing named evidence: ${missingEvidence.join(', ')}`);
  return {
    required: true,
    pass: failures.length === 0,
    message: failures.length ? failures.join('; ') : 'Primitive plan governance and applicable named evidence are present',
    changedPrimitives,
    missingPlan,
    missingEvidence,
  };
}
