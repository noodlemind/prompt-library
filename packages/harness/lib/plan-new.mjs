import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfiguredChecks } from './plan-readiness.mjs';
import { isPrimitivePath } from './primitive-governance.mjs';

const TYPES = ['feat', 'fix', 'docs', 'refactor', 'chore'];
const RISKS = ['green', 'amber', 'red'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function scalar(value, name, { multiline = false, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`plan-new: --${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.includes('\0') || (!multiline && /[\r\n]/.test(value))) {
    throw new Error(`plan-new: --${name} must be a ${multiline ? 'text' : 'single-line'} scalar`);
  }
  if (required && !value.trim()) throw new Error(`plan-new: --${name} is required`);
  return value;
}

function classify(primitivePath) {
  if (/(?:^\.github|^enterprise)\/skills\//.test(primitivePath)) return 'skill';
  if (/\.github\/agents\//.test(primitivePath)) return 'agent';
  if (/\.github\/instructions\//.test(primitivePath)) return 'instruction';
  if (/\.github\/checks\//.test(primitivePath)) return 'check';
  if (primitivePath === 'knowledge/capability-registry.yaml') return 'capability registry';
  return 'primitive';
}

/**
 * Build a valid, gate-ready plan skeleton so a model never authors the exact
 * frontmatter, status, capability_gaps shape, or PR2-PR7 governance block by
 * hand. Returns { path, content }. Pure — the CLI handles I/O and the date.
 */
export function buildPlanSkeleton({
  type = 'feat',
  slug,
  title,
  intent,
  date,
  impacted = [],
  criteria = [],
  gap = null,
  risk = 'green',
  status,
  check,
} = {}) {
  scalar(slug, 'slug', { required: true });
  scalar(title, 'title');
  scalar(intent, 'intent', { multiline: true, required: true });
  scalar(type, 'type', { required: true });
  scalar(risk, 'risk', { required: true });
  scalar(status, 'status');
  scalar(check, 'check', { required: true });
  if (!slug || !SLUG_RE.test(slug)) throw new Error('plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)');
  if (!TYPES.includes(type)) throw new Error(`plan-new: --type must be one of ${TYPES.join('|')}`);
  if (!RISKS.includes(risk)) throw new Error(`plan-new: --risk must be one of ${RISKS.join('|')}`);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('plan-new: date must be YYYY-MM-DD');
  for (const value of impacted) scalar(value, 'impacted', { required: true });
  for (const value of criteria) scalar(value, 'criteria', { multiline: true, required: true });
  if (gap) {
    scalar(gap.id, 'gap', { required: true });
    scalar(gap.primitive, 'gap', { required: true });
  }

  const rel = `docs/plans/${date}-${type}-${slug}-plan.md`;
  const impactedList = impacted.length ? impacted.slice() : gap?.primitive ? [gap.primitive] : [];
  const primitive = impactedList.some(isPrimitivePath) || isPrimitivePath(gap?.primitive);
  const finalStatus = status || (gap ? 'blocked-capability' : 'in-progress');
  const acs = (criteria.length ? criteria : [`${intent} is delivered`]).map((text, i) => ({ id: `AC${i + 1}`, text }));
  const skills = primitive ? ['engineer', 'create-primitive'] : ['engineer'];
  const heading = title || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const frontmatter = {
    plan_schema: 1,
    title: heading,
    type,
    status: finalStatus,
    plan_lock: true,
    phase: 1,
    risk,
    intent,
    expected_outputs: [`${slug} delivered`],
    success_criteria: [intent],
    verification: {
      required: [check],
      criteria: Object.fromEntries(acs.map((ac) => [ac.id, [check]])),
    },
    reviews: { required: [], completed: [], critical_open: [] },
    skills_used: skills,
    capability_gaps: gap
      ? [{ id: gap.id, class: 'hard', fulfillment: 'proposed', primitive: gap.primitive }]
      : [],
  };

  const governanceSection = primitive
    ? `\n## Primitive Governance\n\n- Primitive classification: ${classify(impactedList.find(isPrimitivePath) || gap?.primitive || '')}\n- Existing-capability overlap analysis: reviewed existing primitives; none cover this need (refine with specifics).\n- Intended artifact structure: \`${impactedList.find(isPrimitivePath) || gap?.primitive}\` with frontmatter and body per the template.\n- Trigger and negative-trigger implications: triggers on this workflow; does not trigger for unrelated edits (refine).\n- Verification expectations: ${check} confirms the artifact is well-formed.\n- Registry and documentation impact: update the inventory; no registry entry needed unless externally shared (refine).\n`
    : '';

  const impactedLines = impactedList.length ? impactedList.map((f) => `- \`${f}\``).join('\n') : '- `TODO: add the files this plan will change`';
  const acLines = acs.map((ac) => `- [ ] **${ac.id}** ${ac.text}`).join('\n');

  const content = `---
${YAML.stringify(frontmatter, { lineWidth: 0 })}---

# ${heading}

## Overview

${intent}

## Intent Contract

- Goal: ${intent}

## Acceptance Criteria

${acLines}
${governanceSection}
## Plan

### Phase 1

- [ ] ${acs[0].text}

## Impacted Files

${impactedLines}

## Verification Plan

- Run the configured check (\`${check}\`).

## Risk & Review Routing

- ${risk.charAt(0).toUpperCase() + risk.slice(1)}.

## Review Findings

- None.

## Activity

- Scaffolded by \`harness plan-new\`.${gap ? ` Blocked on the ${gap.id} capability gap.` : ''}
`;

  return { path: rel, content };
}

/** CLI: parse the plan-new flags, write the skeleton, print the path. */
export async function cmdPlanNew(argv) {
  const opts = { impacted: [], criteria: [] };
  let workspace = process.cwd();
  let json = false;
  let dryRun = false;
  let toStdout = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--type') opts.type = next();
    else if (a === '--slug') opts.slug = next();
    else if (a === '--title') opts.title = next();
    else if (a === '--intent') opts.intent = next();
    else if (a === '--date') opts.date = next();
    else if (a === '--risk') opts.risk = next();
    else if (a === '--status') opts.status = next();
    else if (a === '--check') opts.check = next();
    else if (a === '--impacted') opts.impacted.push(...String(next() || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--criteria') opts.criteria.push(String(next() || '').trim());
    else if (a === '--gap') {
      const raw = String(next() || '');
      const idx = raw.indexOf(':');
      if (idx < 0) throw new Error('plan-new: --gap must be <id>:<primitive-path>');
      opts.gap = { id: raw.slice(0, idx), primitive: raw.slice(idx + 1) };
    } else if (a === '--workspace') workspace = path.resolve(next());
    else if (a === '--json') json = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--stdout') toStdout = true;
  }

  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);

  const configured = loadConfiguredChecks(workspace);
  if (configured.error) throw new Error(`plan-new: ${configured.error}`);
  const names = configured.checks ? Object.keys(configured.checks) : [];
  if (names.length === 0) {
    throw new Error('plan-new: configure at least one named check in .github/harness/checks.yaml before generating a gate-ready plan');
  }
  if (opts.check) {
    if (!Object.hasOwn(configured.checks, opts.check)) {
      throw new Error(`plan-new: --check ${opts.check} is not configured; choose one of: ${names.join(', ')}`);
    }
  } else if (names.length === 1) {
    [opts.check] = names;
  } else {
    throw new Error(`plan-new: --check is required when multiple checks are configured: ${names.join(', ')}`);
  }

  const { path: rel, content } = buildPlanSkeleton(opts);
  const full = path.join(workspace, rel);
  if (toStdout) {
    process.stdout.write(content);
    return 0;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) throw new Error(`plan-new: ${rel} already exists`);
    fs.writeFileSync(full, content, 'utf8');
  }
  if (json) console.log(JSON.stringify({ path: rel, created: !dryRun }));
  else console.log(`${dryRun ? 'would create' : 'created'} ${rel}\n  next: harness gate --phase implement --plan ${rel} --json`);
  return 0;
}
