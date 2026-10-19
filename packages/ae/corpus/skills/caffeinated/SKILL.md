---
name: caffeinated
description: "Continue an accepted Deliver plan through its bound playbook and scoped worklist. Internal only; not for planning, questions, read-only investigation, or review-only work."
user-invocable: false
---
# Caffeinated (internal, experimental)

Use only the procedure pointer returned by orient for an accepted Deliver plan with a current playbook binding. The Engineer remains accountable; its agent file owns the delivery lifecycle.

## Trigger Examples
**Should trigger:**
- "Implement this accepted plan using its bound feature playbook."
- "Resume the accepted bug-fix plan and its existing worklist."
- "Continue Deliver after ensure-plan has established the missing prerequisites."

**Should not trigger:**
- "What does this flag mean?" → Engineer Answer mode.
- "Investigate why the service times out without changing it." → Engineer Investigate mode.
- "Plan this feature or review this diff only." → /ensure-plan or /code-review.

## Inputs and Outputs
Read the accepted plan, its bound playbook bytes, current prerequisites, and selected verification recipe. Produce performed work, CLI-recorded progress, required review, current named proof, compounding, and bound completion within that plan.

## Continue delivery
1. Follow orient's procedure read pointers. Read the accepted plan and the exact bound playbook; do not infer activation from a path or `skills_used` declaration. After the actual skill read, record `caffeinated` through an authored `skillsUsed` amendment for a full plan. Short plans retain the session/activity read record. See [plan-operations.md](../references/plan-operations.md).
2. Require a current successful implement gate before product edits. Missing intent, scope, trusted checks, or a missing/changed binding returns to /ensure-plan. High uncertainty remains abstention; evidence-only investigation stays read-only.
3. Run `ae todo sync --plan <path>` and read the scoped worklist. Follow the bound steps in order. Reuse completed steps on resume. Record a step complete only after performing it; accepted inapplicability uses a reasoned plan amendment. Worklist status cannot satisfy plan tasks or acceptance criteria.
4. Implement each applicable unit within accepted scope using focused TDD checks. For visible behavior, read the selected recipe, maintain the affected feature map, and run its named drives with preserved evidence and cleanup.
   If the accepted full plan declares an experiment, read [experiment-workflow.md](references/experiment-workflow.md) before reserving or editing a candidate. A baseline, charged reservation, trusted measurement and explicit resolution are required; an experiment status cannot complete delivery.
5. Record proven progress through plan decisions. Prepare and assemble required review, fix valid findings, then run authoritative `ae verify`. A correction or changed contract requires fresh relevant proof and, when needed, a refreshed implement gate.
6. After current verification passes, use `ae compound --learning-decision <file>` for durable learning or explicit no-learning, then submit the existing complete decision. Report proof and any unmet prerequisites.

## Boundaries and recovery
Do not prepare specs, classify intake again, choose or invent a playbook, lock independently, widen scope, or create another planner. Follow existing authorization and [error-handling-patterns.md](../references/error-handling-patterns.md). In non-interactive use, return the prerequisite or uncertainty to the Engineer; do not guess a gated decision.

For a domain child, keep its accepted parent link and shared binding current. Use ordinary project lifecycle commands in the returned child workspace. The Engineer coordinates the parent through explicit `domain` commands after child completion; this procedure does not grant parent authority or replace joint proof.
