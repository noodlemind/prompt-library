import fs from 'node:fs';
import path from 'node:path';
import { createStyle } from './style.mjs';
import { redactedJson } from './redact.mjs';

const TYPES = ['feat', 'fix', 'docs', 'refactor', 'chore'];
const RISKS = ['green', 'amber', 'red'];
const PRIMITIVE_RE = /^\.github\/(skills|agents|instructions|checks)\//;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isPrimitivePath(p) {
  return PRIMITIVE_RE.test(String(p || '').replace(/^\.\//, ''));
}

function classify(primitivePath) {
  if (/\.github\/skills\//.test(primitivePath)) return 'skill';
  if (/\.github\/agents\//.test(primitivePath)) return 'agent';
  if (/\.github\/instructions\//.test(primitivePath)) return 'instruction';
  if (/\.github\/checks\//.test(primitivePath)) return 'check';
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
} = {}) {
  if (!slug || !SLUG_RE.test(slug)) throw new Error('plan-new: --slug is required and must be lowercase-hyphen (a-z0-9-)');
  if (!TYPES.includes(type)) throw new Error(`plan-new: --type must be one of ${TYPES.join('|')}`);
  if (!intent || !intent.trim()) throw new Error('plan-new: --intent is required');
  if (!RISKS.includes(risk)) throw new Error(`plan-new: --risk must be one of ${RISKS.join('|')}`);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('plan-new: date must be YYYY-MM-DD');

  const rel = `docs/plans/${date}-${type}-${slug}-plan.md`;
  const impactedList = impacted.length ? impacted.slice() : gap?.primitive ? [gap.primitive] : [];
  const primitive = impactedList.some(isPrimitivePath) || isPrimitivePath(gap?.primitive);
  const finalStatus = status || (gap ? 'blocked-capability' : 'in-progress');
  const acs = (criteria.length ? criteria : [`${intent} is delivered`]).map((text, i) => ({ id: `AC${i + 1}`, text }));
  const skills = primitive ? ['engineer', 'create-primitive'] : ['engineer'];
  const heading = title || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const criteriaMap = acs.map((ac) => `${ac.id}: [harness-tests]`).join(', ');
  const gapBlock = gap
    ? `capability_gaps:\n  - id: ${gap.id}\n    class: hard\n    fulfillment: proposed\n    primitive: ${gap.primitive}`
    : 'capability_gaps: []';

  const governanceSection = primitive
    ? `\n## Primitive Governance\n\n- Primitive classification: ${classify(impactedList.find(isPrimitivePath) || gap?.primitive || '')}\n- Existing-capability overlap analysis: reviewed existing primitives; none cover this need (refine with specifics).\n- Intended artifact structure: \`${impactedList.find(isPrimitivePath) || gap?.primitive}\` with frontmatter and body per the template.\n- Trigger and negative-trigger implications: triggers on this workflow; does not trigger for unrelated edits (refine).\n- Verification expectations: harness-tests confirm the artifact is well-formed.\n- Registry and documentation impact: update the inventory; no registry entry needed unless externally shared (refine).\n`
    : '';

  const impactedLines = impactedList.length ? impactedList.map((f) => `- \`${f}\``).join('\n') : '- `TODO: add the files this plan will change`';
  const acLines = acs.map((ac) => `- [ ] **${ac.id}** ${ac.text}`).join('\n');

  const content = `---
plan_schema: 1
title: "${heading}"
type: ${type}
status: ${finalStatus}
plan_lock: true
phase: 1
risk: ${risk}
intent: "${intent.replace(/"/g, "'")}"
expected_outputs: ["${slug} delivered"]
success_criteria: ["${intent.replace(/"/g, "'")}"]
verification:
  required: [harness-tests]
  criteria: {${criteriaMap}}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [${skills.join(', ')}]
${gapBlock}
---

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

- Run the harness tests (\`harness-tests\`).

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
