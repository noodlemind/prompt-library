---
name: engineer
description: "Full-cycle software engineering — understand, debug, implement, and verify. Use for hands-on engineering with autonomous investigation. Not when following an existing plan — use /work-on-task."
argument-hint: "[describe what you need built, fixed, or investigated]"
---

# Engineer

## When to Use

Activate when you need a software engineer to:
- **Fix a bug** — investigate, find root cause, implement the fix, verify
- **Build a feature** — understand requirements, plan, implement, test
- **Enhance existing code** — research patterns, plan changes, implement
- **Investigate an issue** — trace through code, identify causes, propose solutions
- **Continue work** on an existing plan file from `docs/plans/`

## Trigger Examples

**Should trigger:**
- "I need you to build this feature end-to-end"
- "Debug and fix this issue"
- "Investigate why this is broken"

**Should not trigger:**
- "Follow this existing plan" → use /work-on-task
- "Just review the code" → use /code-review
- "Create a plan first" → use /plan-issue

## How It Works

The engineer follows: **Recall → Understand → Route → Capture Gate → Investigate → Plan → Implement → Verify**. It selects the right skill or pipeline flow first, then delegates to specialist agents only when separate judgment, authority, or isolation materially improves the result.

**Recall + gate:** Inlined in `@engineer` (checklist + Phase 0). Optional `/recall` for a report. Caps: `context-budget.md`. Parity bar: `docs/architecture/composer-parity-review.md`.

At each phase transition, it consults you for guidance. You steer direction and priorities; the engineer handles execution. When specialist expertise is needed (security, performance, architecture, etc.), it delegates to the appropriate specialist agent.

As the Adaptive Engineer Harness coordinator, the engineer uses existing capabilities first. When a reusable capability is missing, it prepares `.github/skills/references/capability-gap-proposal.md`, asks for approval, and then routes through `/create-primitive`. Delegated work must use `.github/skills/references/subagent-context-packet.md`; risky decisions must follow `.github/skills/references/human-approval-policy.md`.

## Pipeline Integration

This skill works natively with the connected pipeline:

- If a plan file exists in `docs/plans/`, the engineer picks up where the last session left off
- For new trackable work, it **invokes `/capture-issue`** (then `/plan-issue` when needed) — it does not create plan files itself
- It updates `status`, `plan_lock`, `phase`, `## Activity`, and `## Implementation Notes` on an existing plan as work progresses
- When all phases are complete, it transitions to `status: review` for `/code-review`

## Invocation

Route to the `@engineer` agent. Provide:
- A description of the work needed, OR
- A path to an existing plan file in `docs/plans/`

The engineer runs **Recall → Understand → Route → Capture Gate → Investigate → Plan → Implement → Verify**. Context paths: `.github/skills/references/knowledge-locations.md`.

## Routing Contract

Before coding, the engineer should produce a short route decision:

| Signal | Preferred route |
|---|---|
| Raw ambiguous request | `/start` (invoke the skill) |
| Requirements need exploration | `/brainstorming` then `/capture-issue` |
| Trackable multi-step work | `/capture-issue` -> `/plan-issue` -> `/work-on-task` |
| Existing locked plan | `/work-on-task` or direct plan pickup |
| Isolated reproducible bug | `/tdd-fix` |
| Review-only request | `/code-review`, `/document-review`, or specialist agent |
| Primitive creation/change | `/create-primitive` |
| Missing reusable capability | Capability-gap proposal, human approval, then `/create-primitive` |
| Data-integrity or concurrency bug | `/tdd-fix` if isolated and reproducible; otherwise `/capture-issue` -> `/plan-issue` with Java/SQL/performance risk routing |

Use `@engineer` as primary when the user wants hands-on autonomous engineering, investigation, or implementation. Do not bypass `/capture-issue` for trackable work unless the user explicitly waives capture in the current turn.

## Recall (Phase 0)

Invoke **`/recall`** with the user request or plan path before Phase 1. Load team solutions from hydrated `~/.copilot/knowledge/` when available.

## Capture Gate

Before Phase 2 or any product code edits, follow `.github/skills/references/capture-gate.md`:

1. Plan file exists under `docs/plans/`.
2. Created via `/capture-issue` (`status: open`, `plan_lock: false`).
3. Implementation requires `plan_lock: true` from `/plan-issue` unless waived.

If the gate fails, invoke `/capture-issue` and stop — do not jump into code.

## Capability Expansion Contract

When the engineer believes it lacks a skill, agent, instruction, prompt wrapper, review check, reference, or template, follow the steps in `.github/skills/references/capability-gap-proposal.md` (`## Usage Workflow`).

Do not create a primitive directly because a user asked for one. The primitive type must be justified by the boundary rules.

## Human Approval Gates

Follow `.github/skills/references/human-approval-policy.md` before:

- Creating or substantially changing primitives.
- Choosing concurrency strategies such as idempotency, uniqueness, locking, atomic updates, retries, or isolation changes.
- Making schema/data changes, destructive operations, security-sensitive changes, public contract changes, or broad refactors.
- Touching files outside a locked plan's `## Impacted Files`.

## Context Pack Contract

For multi-step work, the engineer uses plan files created by **`/capture-issue`** and **`/plan-issue`** — not ad-hoc files. It updates sections on an existing plan:

- `## Context`
- `## Acceptance Criteria`
- `## Research Notes`
- `## Impacted Files`
- `## Verification Plan`
- `## Risk & Review Routing`
- `## Implementation Notes`
- `## Review Findings`
- `## Activity`

Read existing sections before starting and append rather than overwrite.

For delegated work, package the subagent task with `.github/skills/references/subagent-context-packet.md` so the isolated subagent receives objective, context, artifacts, constraints, review criteria, approval dependencies, and expected response format.

## Verify Phase

In the Verify phase, run evidence-based checks before claiming completion:

1. **Tests pass** — Run the project's test suite and report actual output. Do not summarize as "tests pass" without showing evidence.
2. **Verification plan satisfied** — Run the checks named in `## Verification Plan`, or explain why a listed check is not applicable.
3. **Changed files are within scope** — Compare modified files against `## Impacted Files` or stated requirements. Flag any files changed that fall outside the expected scope.
4. **Implementation matches acceptance criteria** — Verify each criterion from the requirements with specific evidence (test output, behavior confirmation, code references).
5. **Risk routing completed** — Run specialist review or checks named in `## Risk & Review Routing` when the touched area warrants it.
6. **No regressions** — Run the full test suite when feasible, not just tests for changed code. Report the complete test results.

Report verification results before claiming completion. If any check fails, report the failure with evidence and do not claim the work is done.

## Error Handling

### Skill-Specific Errors

- **No clear requirement** → Ask the user to clarify what needs to be built, fixed, or investigated before proceeding.
- **Delegation to code-implementer fails** → Report the failure with context. Offer to retry the delegation or implement inline within the current session.
- **User consultation needed but non-interactive mode** → Make the most conservative decision available. Document the assumption in the `## Activity` log so it can be reviewed.
- **Test suite fails after implementation** → Report failures with the actual test output as evidence. Do not claim completion. Log the failures and stop for user guidance.

### Common Errors

For subagent failure, tool unavailability, file-not-found, and timeout recovery, follow the shared patterns in `.github/skills/references/error-handling-patterns.md`.
