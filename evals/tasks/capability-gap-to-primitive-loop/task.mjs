import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentLoop } from '../../lib/agent-loop.mjs';
import { materializeFixture, finalizeWorkspace } from '../../lib/fixture.mjs';
import { engineerContract, pickDriver } from '../../lib/scenario.mjs';

// Full loop: a task needs a primitive that does not exist → the work is blocked
// by a capability gap → the engineer proposes and creates the primitive through
// create-primitive governance → fulfills the gap → the work unblocks. Ties CAP
// gating + primitive governance + activation + gap fulfillment end to end.
export const meta = {
  id: 'capability-gap-to-primitive-loop',
  capability: 'Capability gap blocks work until the primitive is proposed, created, and the gap fulfilled',
  kind: 'deterministic',
  runtime: 'active',
  success: 'blocked-capability blocks implement; primitive created via governance; gap fulfilled unblocks the work',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const WORK_PLAN = 'docs/plans/2026-07-21-feat-payment-audit-plan.md';
const PRIM_PLAN = 'docs/plans/2026-07-21-feat-payment-audit-skill-plan.md';
const SKILL_PATH = '.github/skills/payment-audit/SKILL.md';
const SKILL_BODY = '---\nname: payment-audit\ndescription: Audit-log the payment override path.\nuser-invocable: false\n---\n\n# payment-audit\n\nSteps to audit-log SYSTEM_OVERRIDE payments.\n';

const workPlan = (blocked) => `---
plan_schema: 1
title: "Payment override audit logging"
type: feat
status: ${blocked ? 'blocked-capability' : 'in-progress'}
plan_lock: true
phase: 1
risk: green
intent: "Add audit logging to the payment override path"
expected_outputs: ["audit log on override"]
success_criteria: ["override path is audited"]
verification:
  required: [harness-tests]
  criteria: {AC1: [harness-tests]}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [engineer]
capability_gaps:
  - id: payment-audit-skill
    class: hard
    fulfillment: ${blocked ? 'proposed' : 'done'}
    primitive: ${SKILL_PATH}
---

# Payment override audit logging

## Overview

Add audit logging to the payment override path, using the payment-audit skill.

## Intent Contract

- Goal: audit-log the override path.

## Acceptance Criteria

- [ ] **AC1** The override path is audit-logged.

## Plan

### Phase 1

- [ ] Add the audit log call.

## Impacted Files

- \`src/PaymentController.java\`

## Verification Plan

- Run the harness tests.

## Risk & Review Routing

- Green.

## Review Findings

- None.

## Activity

- ${blocked ? 'Captured; blocked on the payment-audit capability gap.' : 'Gap fulfilled; proceeding.'}
`;

const primPlan = `---
plan_schema: 1
title: "Payment audit skill"
type: feat
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Create the payment-audit skill to fulfill the capability gap"
expected_outputs: ["payment-audit skill"]
success_criteria: ["skill created"]
verification:
  required: [harness-tests]
  criteria: {AC1: [harness-tests]}
reviews: {required: [], completed: [], critical_open: []}
skills_used: [engineer, create-primitive]
capability_gaps: []
---

# Payment audit skill

## Overview

Create the payment-audit skill to fulfill the capability gap.

## Intent Contract

- Goal: create the payment-audit skill.

## Acceptance Criteria

- [ ] **AC1** The payment-audit skill exists.

## Primitive Governance

- Primitive classification: skill (a repeatable audit workflow).
- Existing-capability overlap analysis: no skill covers payment audit logging; /code-review is broader.
- Intended artifact structure: \`${SKILL_PATH}\` with frontmatter and steps.
- Trigger and negative-trigger implications: triggers on payment audit work; not for unrelated edits.
- Verification expectations: harness-tests confirm the skill file is well-formed.
- Registry and documentation impact: add to the skills inventory; no registry entry for an internal skill.

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

- Captured to fulfill the gap.
`;

const AUDITED = fs.readFileSync(path.join(here, '..', '..', 'fixtures', 'payment-service', 'src', 'PaymentController.java'), 'utf8')
  .replace('store.placeOrder(orderId);\n    store.markProcessed(orderId);\n  }\n}',
    'store.placeOrder(orderId);\n    store.markProcessed(orderId);\n    // audit: payment-audit skill — record override/processing\n  }\n}');

const CANONICAL = [
  { type: 'tool', name: 'editFiles', input: { path: WORK_PLAN, content: workPlan(true) } },              // capture blocked work
  { type: 'tool', name: 'runInTerminal', input: { command: `harness gate --phase implement --plan ${WORK_PLAN} --json` } }, // BLOCKED: CAP
  { type: 'tool', name: 'editFiles', input: { path: PRIM_PLAN, content: primPlan } },                    // propose the primitive
  { type: 'tool', name: 'runInTerminal', input: { command: `harness gate --phase implement --plan ${PRIM_PLAN} --json` } }, // primitive plan passes governance
  { type: 'tool', name: 'editFiles', input: { path: SKILL_PATH, content: SKILL_BODY } },                 // denied: not activated
  { type: 'tool', name: 'readFile', input: { path: '.github/skills/create-primitive/SKILL.md' } },       // activate
  { type: 'tool', name: 'editFiles', input: { path: SKILL_PATH, content: SKILL_BODY } },                 // primitive created
  { type: 'tool', name: 'editFiles', input: { path: WORK_PLAN, content: workPlan(false) } },             // fulfill gap, unblock
  { type: 'tool', name: 'runInTerminal', input: { command: `harness gate --phase implement --plan ${WORK_PLAN} --json` } }, // now PASSES
  { type: 'tool', name: 'editFiles', input: { path: 'src/PaymentController.java', content: AUDITED } },   // do the work
  { type: 'finish', answer: 'The work was blocked by the payment-audit capability gap. I proposed and created the payment-audit primitive through create-primitive governance, fulfilled the gap, and then added the audit logging.' },
];

function gateBlocked(call) {
  if (!call) return false;
  if (call.result.code !== 0) return true;
  try {
    return JSON.parse(call.result.stdout).pass === false;
  } catch {
    return /blocked|fail/i.test(call.result.stdout);
  }
}
function gatePassed(call) {
  if (!call || call.result.code !== 0) return false;
  try {
    return JSON.parse(call.result.stdout).pass === true;
  } catch {
    return !/blocked|fail/i.test(call.result.stdout);
  }
}

export async function run(ctx = {}) {
  const ws = materializeFixture('payment-service');
  try {
    const driver = pickDriver(CANONICAL, { transcriptFile: path.join(here, 'transcripts', 'in-session.json'), mode: ctx.agentMode });
    const loop = await runAgentLoop({ workspace: ws, system: engineerContract, instruction: fs.readFileSync(path.join(here, 'instruction.md'), 'utf8'), driver, maxSteps: 20 });
    const t = loop.trajectory;
    const gates = t.filter((s) => s.type === 'tool' && s.name === 'runInTerminal' && /gate --phase implement/.test(s.input.command));
    const workGates = gates.filter((s) => s.input.command.includes(WORK_PLAN));
    const primGate = gates.find((s) => s.input.command.includes(PRIM_PLAN));
    const skillEdits = t.filter((s) => s.type === 'tool' && s.name === 'editFiles' && s.input.path === SKILL_PATH);
    const workEdit = t.find((s) => s.type === 'tool' && s.name === 'editFiles' && s.input.path === 'src/PaymentController.java');
    return {
      model: loop.model,
      workBlockedByGap: gateBlocked(workGates[0]) && /blocked-capability|capability/i.test(workGates[0]?.result.stdout || ''),
      primitivePlanGated: gatePassed(primGate),
      primitiveDeniedPreActivation: skillEdits[0]?.result.denied === true && /create-primitive/i.test(skillEdits[0]?.result.reason || ''),
      primitiveCreated: skillEdits[1]?.result.applied === true && fs.existsSync(path.join(ws, SKILL_PATH)),
      workUnblockedAfterFulfillment: gatePassed(workGates[1]),
      workApplied: workEdit?.result.applied === true && /audit/i.test(fs.readFileSync(path.join(ws, 'src', 'PaymentController.java'), 'utf8')),
    };
  } finally {
    finalizeWorkspace(ws, 'capability-gap-to-primitive-loop');
  }
}

const CHECKS = ['workBlockedByGap', 'primitivePlanGated', 'primitiveDeniedPreActivation', 'primitiveCreated', 'workUnblockedAfterFulfillment', 'workApplied'];

export async function grade(result) {
  const failed = CHECKS.filter((k) => result[k] !== true);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    reason: failed.length === 0
      ? `[${result.model}] gap blocked the work; primitive proposed+created via governance; gap fulfilled unblocked and delivered the work`
      : `failed: ${failed.join(', ')}`,
    evidence: result,
  };
}

export const fixtures = {
  pass: { model: 'fixture', workBlockedByGap: true, primitivePlanGated: true, primitiveDeniedPreActivation: true, primitiveCreated: true, workUnblockedAfterFulfillment: true, workApplied: true },
  fail: { model: 'fixture', workBlockedByGap: false, primitivePlanGated: true, primitiveDeniedPreActivation: true, primitiveCreated: true, workUnblockedAfterFulfillment: true, workApplied: true },
};
