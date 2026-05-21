# Capture Gate

Mandatory checkpoint for `@engineer`, `/engineer`, and any full-cycle agent that can edit product code. Smaller or alternate models often skip capture unless this gate is explicit and checked before `editFiles`.

## Rule

**Do not use `editFiles`, delegate to `code-implementer`, or change product code until the capture gate passes.**

Read-only tools (`codebase`, `search`, `read`, `changes`, `usages`, `problems`, `terminalLastCommand`, `fetch`) are allowed in Phase 1 Understand only to classify work and find an existing plan.

## When the gate applies

The gate applies when **any** of these are true:

- The user wants a bug fixed, feature built, refactor, or enhancement (not review-only or pure Q&A).
- The work may touch more than one file or more than one logical step.
- No `docs/plans/*.md` file exists yet for this request.
- An existing plan has `status: open` but implementation has not been planned and locked.

## When the gate does not apply

Proceed without `/capture-issue` only when **one** of these is clearly true:

| Exemption | Route |
|-----------|--------|
| User gave a path to an existing plan with `plan_lock: true` | Resume `/work-on-task` rules on that file |
| Review-only (no implementation) | `/code-review` or specialist reviewer |
| Pure Q&A or explanation (no code changes) | `/btw` or read-only investigation |
| Isolated reproducible bug, single concern | `/tdd-fix` |
| User explicitly waived capture **in this turn** (quote their words) | Log waiver in response; still prefer capture for multi-step work |

## Gate checklist (all required before Phase 2 Investigate or any edit)

1. **Plan file exists** at `docs/plans/YYYY-MM-DD-<type>-<slug>-plan.md`.
2. **Created by `/capture-issue`**, not inline by the engineer. The engineer must **invoke** `/capture-issue` (slash skill) or instruct the user to run it and wait for the file path.
3. **Frontmatter valid:**
   - After capture: `status: open`, `plan_lock: false`, `phase: 0`
   - Before implementation: `status: planned`, `plan_lock: true` (set by `/plan-issue`, not engineer)
4. **Body minimum from capture:** `## Overview`, `## Context`, `## Acceptance Criteria`, `## Activity` (see `/capture-issue` skill).
5. **Route recorded** in the plan `## Activity` or in the chat response: which pipeline path applies.

If any item fails → **stop**. Run `/capture-issue` first. Do not investigate deeply or edit code.

## Forbidden engineer behaviors

- Creating `docs/plans/*.md` inline with `status: planned` or `plan_lock: true` (that skips capture and plan-issue).
- Setting `plan_lock: true` without `/plan-issue`.
- "Skipping plan file creation" for multi-step or multi-file work.
- Jumping from Understand directly to Implement.
- Using "inline equivalent" of `/capture-issue` instead of invoking the skill.

## Allowed sequence

```
/capture-issue  →  /plan-issue  →  /work-on-task or @engineer (locked plan only)
     open              planned + plan_lock
```

For `@engineer` on new trackable work:

1. Phase 1 Understand + Route → decision: needs capture.
2. **Invoke `/capture-issue`** → wait for plan path.
3. **Invoke `/plan-issue`** on that path when implementation planning is needed.
4. Only then Phase 2 Investigate → Phase 3 Plan (approach within locked plan) → Phase 4 Implement.

## Non-interactive mode

If capture cannot run interactively, create the minimal plan file **only** by following the `/capture-issue` skill steps exactly (`status: open`, `plan_lock: false`). Do not lock or implement in the same turn without user approval.

## Template

Use the section layout in `docs/plans/_plan-template.md` when `/capture-issue` or `/plan-issue` needs a skeleton. Do not invent a different schema.
