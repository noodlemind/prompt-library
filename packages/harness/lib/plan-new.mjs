import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createStyle } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { loadConfiguredChecks } from './plan-readiness.mjs';
import { isPrimitivePath } from './primitive-governance.mjs';
import { plansWriteTarget } from './project-layout.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { ensureHarnessDir } from './session.mjs';
import { applyClassification, readClassification } from './classification.mjs';
import { ensureIndexes } from './ensure-indexes.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { loadPlan } from './plan-parse.mjs';
import { parseImpactedFiles } from './plan-scope.mjs';
import { emptySnapshot, routeWorkspace } from './route.mjs';

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
  plansRel = 'docs/plans',
  plansBase = null,
  routing = null,
  domains = [],
  playbook = null,
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

  const fileName = `${date}-${type}-${slug}-plan.md`;
  const rel = plansBase ? path.join(plansBase, plansRel, fileName) : `${plansRel}/${fileName}`;
  const impactedList = impacted.length ? impacted.slice() : gap?.primitive ? [gap.primitive] : [];
  const primitive = impactedList.some(isPrimitivePath) || isPrimitivePath(gap?.primitive);
  const finalStatus = status || (gap ? 'blocked-capability' : 'in-progress');
  const acs = (criteria.length ? criteria : [`${intent} is delivered`]).map((text, i) => ({ id: `AC${i + 1}`, text }));
  const skills = ['engineer'];
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
    ...(routing ? { routing } : {}),
    ...(domains?.length ? { domains } : {}),
    ...(playbook ? { playbook } : {}),
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

  // Fix-wave C1: honor the literal-argument boundary, matching
  // lib/flags.mjs#parseFlags and lib/registry.mjs#validateArgs — nothing after
  // a bare `--` is ever interpreted as a flag. Sliced BEFORE the loop, not
  // broken out of inside it, for the exact reason parseFlags gives: a mid-loop
  // `break` cannot stop a value flag from having already consumed the literal
  // `--` via `next()`. Verified pre-fix: `--workspace -- --json` resolved the
  // workspace to `--` AND then re-interpreted the post-boundary `--json`.
  const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  for (let i = 0; i < scan.length; i++) {
    const a = scan[i];
    const next = () => scan[++i];
    if (a === '--type') opts.type = next();
    else if (a === '--slug') opts.slug = next();
    else if (a === '--title') opts.title = next();
    else if (a === '--intent') opts.intent = next();
    else if (a === '--date') opts.date = next();
    else if (a === '--risk') opts.risk = next();
    else if (a === '--status') opts.status = next();
    else if (a === '--verification-check') opts.check = next();
    else if (a === '--impacted') opts.impacted.push(...String(next() || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--criteria') opts.criteria.push(String(next() || '').trim());
    else if (a === '--gap') {
      const raw = String(next() || '');
      const idx = raw.indexOf(':');
      if (idx < 0) throw new Error('plan-new: --gap must be <id>:<primitive-path>');
      opts.gap = { id: raw.slice(0, idx), primitive: raw.slice(idx + 1) };
    } else if (a === '--from') opts.from = next();
    else if (a === '--classification') opts.classification = next();
    else if (a === '--copilot-home') opts.copilotHome = next();
    else if (a === '--workspace') workspace = path.resolve(next());
    else if (a === '--json') json = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--stdout') toStdout = true;
  }

  if (opts.from) {
    if (opts.slug || opts.type || opts.intent || opts.gap) {
      throw new Error('plan-new: --from cannot be combined with new-plan flags');
    }
    return relockPlan({ workspace, from: opts.from, dryRun, toStdout, json, classification: opts.classification, copilotHome: opts.copilotHome });
  }

  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  const plansTarget = plansWriteTarget(workspace, { home: harnessGlobalHome() });
  opts.plansBase = plansTarget.base;
  opts.plansRel = plansTarget.dirRel;
  if (!toStdout) ensureHarnessDir(workspace, dryRun);

  const configured = loadConfiguredChecks(workspace);
  if (configured.error) throw new Error(`plan-new: ${configured.error}`);
  const names = Object.entries(configured.checks || {})
    .filter(([, config]) => Array.isArray(config?.command)
      && config.command.length > 0
      && config.command.every((part) => typeof part === 'string' && part.trim().length > 0))
    .map(([name]) => name);
  if (names.length === 0) {
    throw new Error('plan-new: configure at least one named check in .github/harness/checks.yaml before generating a gate-ready plan');
  }
  if (opts.check) {
    if (!names.includes(opts.check)) {
      throw new Error(`plan-new: --verification-check ${opts.check} is not an executable configured check; choose one of: ${names.join(', ')}`);
    }
  } else if (names.length === 1) {
    [opts.check] = names;
  } else {
    throw new Error(`plan-new: --verification-check is required when multiple checks are configured: ${names.join(', ')}`);
  }

  const prepared = prepareRouting({
    workspace,
    impacted: opts.impacted,
    risk: opts.risk || 'green',
    domains: [],
    classification: opts.classification,
    copilotHome: resolveCopilotHome(opts.copilotHome),
  });
  opts.impacted = prepared.impacted;
  opts.risk = prepared.risk;
  opts.domains = prepared.domains;
  opts.playbook = prepared.playbook;
  opts.routing = prepared.routing;

  const { path: rel, content } = buildPlanSkeleton(opts);
  const full = path.isAbsolute(rel) ? rel : path.join(workspace, rel);
  if (toStdout) {
    process.stdout.write(content);
    return 0;
  }
  if (!dryRun) {
    await ensureIndexes({
      workspace,
      copilotHome: resolveCopilotHome(opts.copilotHome),
      mode: 'missing',
      dryRun: false,
    }).catch(() => {});
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) throw new Error(`plan-new: ${rel} already exists`);
    fs.writeFileSync(full, content, 'utf8');
  }
  // Fix-wave C2: legacy --json serializer routed through the shared
  // redacting emission boundary (lib/redact.mjs) like every other sink.
  if (json) console.log(redactedJson({ path: rel, created: !dryRun }));
  else {
    const ui = createStyle();
    console.log(ui.line({ state: 'ok', key: 'plan-new', value: dryRun ? `would create ${rel}` : rel }));
    console.log(ui.paint('muted', `${ui.arrow} harness gate --phase implement --plan ${rel} --json`));
  }
  return 0;
}

function prepareRouting({ workspace, impacted, risk, domains, classification, copilotHome }) {
  let next = { impacted: impacted.slice(), risk, domains: domains.slice(), playbook: null, abstain: false };
  if (classification) {
    next = applyClassification({
      workspace,
      declaredRisk: risk,
      declaredDomains: domains,
      declaredImpacted: impacted,
      classification: readClassification(classification, workspace),
    });
  }
  if (next.abstain) return { ...next, routing: emptySnapshot('classification-abstain') };
  const routed = routeWorkspace({
    workspace,
    copilotHome,
    impacted: next.impacted,
    risk: next.risk,
    domains: next.domains,
    primitive: next.impacted.some(isPrimitivePath),
    planLock: false,
  });
  if (!routed.ok) throw new Error(`plan-new: ${routed.errors.join('; ')}`);
  return { ...next, routing: routed.snapshot };
}

async function relockPlan({ workspace, from, dryRun, toStdout, json, classification, copilotHome }) {
  const plan = loadPlan(workspace, from);
  if (!plan) throw new Error('plan-new: --from plan was not found');
  if (plan.fm.__parseError) throw new Error(`plan-new: --from plan frontmatter is invalid (${plan.fm.__parseError})`);
  if (plan.plan_lock) throw new Error('plan-new: --from requires an unlocked plan');
  const original = fs.readFileSync(plan.fullPath, 'utf8');
  const prepared = prepareRouting({
    workspace,
    impacted: parseImpactedFiles(plan),
    risk: plan.risk || 'green',
    domains: Array.isArray(plan.fm.domains) ? plan.fm.domains : [],
    classification,
    copilotHome: resolveCopilotHome(copilotHome),
  });
  const frontmatter = {
    ...plan.fm,
    plan_lock: true,
    risk: prepared.risk,
    routing: prepared.routing,
    ...(prepared.domains.length ? { domains: prepared.domains } : {}),
    ...(prepared.playbook ? { playbook: prepared.playbook } : {}),
  };
  const content = original.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${YAML.stringify(frontmatter)}---`);
  if (toStdout) {
    process.stdout.write(content);
    return 0;
  }
  if (!dryRun) {
    await ensureIndexes({ workspace, copilotHome: resolveCopilotHome(copilotHome), mode: 'missing' }).catch(() => {});
    if (fs.readFileSync(plan.fullPath, 'utf8') !== original) throw new Error('plan-new: plan changed before relock');
    fs.writeFileSync(plan.fullPath, content, 'utf8');
  }
  if (json) console.log(redactedJson({ path: plan.path, created: !dryRun, relocked: true }));
  else {
    const ui = createStyle();
    console.log(ui.line({ state: 'ok', key: 'plan-new', value: dryRun ? `would relock ${plan.path}` : plan.path }));
  }
  return 0;
}
