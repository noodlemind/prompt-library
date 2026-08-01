import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentLoop } from '../../lib/agent-loop.mjs';
import { materializeFixture, finalizeWorkspace } from '../../lib/fixture.mjs';
import { engineerContract, pickDriver } from '../../lib/scenario.mjs';

// Scenario 3 — Primitive creation trigger. Editing a primitive path
// (.github/skills/**) is denied until BOTH a create-primitive plan scopes it AND
// the create-primitive skill is actually read (activated) in the session. The
// trajectory locks such a plan, is denied before activation, reads the skill to
// activate, and only then creates the new skill file.
export const meta = {
  id: 'primitive-creation-loop',
  capability: 'Primitive creation is gated on create-primitive plan + live skill activation',
  kind: 'deterministic',
  runtime: 'active',
  success: 'primitive edit denied pre-activation, allowed after reading create-primitive',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const NEW_PLAN = 'docs/plans/2026-07-21-feat-payment-check-skill-plan.md';
const SKILL_PATH = '.github/skills/payment-check/SKILL.md';
const SKILL_BODY = '---\nname: payment-check\ndescription: Payment override review steps.\nuser-invocable: false\n---\n\n# payment-check\n\nReview steps for the payment SYSTEM_OVERRIDE path.\n';

const PLAN_CONTENT = `---
plan_schema: 1
title: "Payment check skill"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Create a payment-check skill capturing override review steps"
expected_outputs: ["payment-check skill"]
success_criteria: ["skill created"]
verification:
  required: [harness-tests]
  criteria: {AC1: [harness-tests]}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [engineer, create-primitive]
capability_gaps: []
---

# Payment check skill

## Overview

Create a payment-check skill capturing the override review steps.

## Intent Contract

- Goal: create the payment-check skill.

## Acceptance Criteria

- [ ] **AC1** The payment-check skill exists.

## Primitive Governance

- Primitive classification: skill (a repeatable review workflow).
- Existing-capability overlap analysis: no existing skill covers the payment override review; closest is /code-review, which is broader.
- Intended artifact structure: \`.github/skills/payment-check/SKILL.md\` with frontmatter and steps.
- Trigger and negative-trigger implications: triggers on payment override review; does not trigger for unrelated edits.
- Verification expectations: harness-tests confirm the skill file is well-formed.
- Registry and documentation impact: add to the skills inventory; no registry entry needed for an internal skill.

## Plan

### Phase 1

- [ ] Author the skill.

## Impacted Files

- \`${SKILL_PATH}\`

## Verification Plan

- Run the harness tests.

## Risk & Review Routing

- Green.

## Review Findings

- None.

## Activity

- Captured before creating the primitive.
`;

const CANONICAL = [
  { type: 'tool', name: 'editFiles', input: { path: NEW_PLAN, content: PLAN_CONTENT } },
  { type: 'tool', name: 'runInTerminal', input: { command: `harness gate --phase implement --plan ${NEW_PLAN} --json` } },
  { type: 'tool', name: 'editFiles', input: { path: SKILL_PATH, content: SKILL_BODY } }, // denied: create-primitive not activated
  { type: 'tool', name: 'readFile', input: { path: '.github/skills/create-primitive/SKILL.md' } }, // activates create-primitive
  { type: 'tool', name: 'editFiles', input: { path: SKILL_PATH, content: SKILL_BODY } }, // now allowed
  { type: 'finish', answer: 'Locked a create-primitive plan, was denied until I read create-primitive to activate it, then authored the payment-check skill.' },
];

export async function run(ctx = {}) {
  const ws = materializeFixture('payment-service');
  try {
    const driver = pickDriver(CANONICAL, { transcriptFile: path.join(here, 'transcripts', 'in-session.json'), mode: ctx.agentMode });
    const loop = await runAgentLoop({ workspace: ws, system: engineerContract, instruction: fs.readFileSync(path.join(here, 'instruction.md'), 'utf8'), driver });
    const t = loop.trajectory;
    const skillEdits = t.filter((s) => s.type === 'tool' && s.name === 'editFiles' && s.input.path === SKILL_PATH);
    const planEdit = t.find((s) => s.type === 'tool' && s.name === 'editFiles' && s.input.path === NEW_PLAN);
    const gateCall = t.find((s) => s.type === 'tool' && s.name === 'runInTerminal' && /gate --phase implement/.test(s.input.command));
    let gatePassed = false;
    try {
      gatePassed = gateCall && JSON.parse(gateCall.result.stdout).pass === true;
    } catch {
      gatePassed = false;
    }
    const activation = t.find((s) => s.type === 'tool' && s.name === 'readFile' && /create-primitive\/SKILL\.md/.test(s.input.path));
    return {
      model: loop.model,
      planLocked: planEdit?.result.applied === true,
      gatePassed,
      deniedBeforeActivation: skillEdits[0]?.result.denied === true && /create-primitive/i.test(skillEdits[0]?.result.reason || ''),
      activatedByReading: !!activation,
      allowedAfterActivation: skillEdits[1]?.result.applied === true,
      skillCreated: fs.existsSync(path.join(ws, SKILL_PATH)),
    };
  } finally {
    finalizeWorkspace(ws, 'primitive-creation-loop');
  }
}

const CHECKS = ['planLocked', 'gatePassed', 'deniedBeforeActivation', 'activatedByReading', 'allowedAfterActivation', 'skillCreated'];

export async function grade(result) {
  const failed = CHECKS.filter((k) => result[k] !== true);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason: failed.length === 0 ? `[${result.model}] primitive edit denied pre-activation, allowed after reading create-primitive` : `failed: ${failed.join(', ')}`,
    evidence: result,
  };
}

export const fixtures = {
  pass: { model: 'fixture', planLocked: true, gatePassed: true, deniedBeforeActivation: true, activatedByReading: true, allowedAfterActivation: true, skillCreated: true },
  fail: { model: 'fixture', planLocked: true, gatePassed: true, deniedBeforeActivation: false, activatedByReading: true, allowedAfterActivation: true, skillCreated: true },
};
