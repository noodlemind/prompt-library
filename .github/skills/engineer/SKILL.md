---
name: engineer
description: "Full-cycle software engineering — understand, debug, implement, and verify. Use for hands-on engineering with autonomous investigation. Not when following an existing plan — use /work-on-task."
argument-hint: "[describe what you need built, fixed, or investigated]"
disable-model-invocation: true
---

# Engineer

## When to Use

Activate when you need a software engineer to:
- **Fix a bug** — investigate, find root cause, implement the fix, verify
- **Build a feature** — understand requirements, plan, implement, test
- **Enhance existing code** — research patterns, plan changes, implement
- **Investigate an issue** — trace through code, identify causes, propose solutions
- **Continue work** on an existing plan file from `docs/plans/`

## How It Works

The engineer follows a 5-phase cycle: **Understand → Investigate → Plan → Implement → Verify**.

At each phase transition, it consults you for guidance. You steer direction and priorities; the engineer handles execution. When specialist expertise is needed (security, performance, architecture, etc.), it delegates to the appropriate specialist agent.

## Pipeline Integration

This skill works natively with the connected pipeline:

- If a plan file exists in `docs/plans/`, the engineer picks up where the last session left off
- For new multi-step work, it creates a plan file with proper frontmatter and phased tasks
- It updates `status`, `plan_lock`, `phase`, `## Activity`, and `## Implementation Notes` as work progresses
- When all phases are complete, it transitions to `status: review` for `/code-review`

## Invocation

Route to the `@engineer` agent. Provide:
- A description of the work needed, OR
- A path to an existing plan file in `docs/plans/`

The engineer will read the codebase, consult `.github/agent-context.md` and `docs/solutions/` for prior knowledge, then begin the understand → investigate → plan → implement → verify cycle.

## Verify Phase

In the Verify phase, run evidence-based checks before claiming completion:

1. **Tests pass** — Run the project's test suite and report actual output. Do not summarize as "tests pass" without showing evidence.
2. **Changed files are within scope** — Compare modified files against the plan or stated requirements. Flag any files changed that fall outside the expected scope.
3. **Implementation matches acceptance criteria** — Verify each criterion from the requirements with specific evidence (test output, behavior confirmation, code references).
4. **No regressions** — Run the full test suite, not just tests for changed code. Report the complete test results.

Report verification results before claiming completion. If any check fails, report the failure with evidence and do not claim the work is done.

## Error Handling

### Skill-Specific Errors

- **No clear requirement** → Ask the user to clarify what needs to be built, fixed, or investigated before proceeding.
- **Delegation to code-implementer fails** → Report the failure with context. Offer to retry the delegation or implement inline within the current session.
- **User consultation needed but non-interactive mode** → Make the most conservative decision available. Document the assumption in the `## Activity` log so it can be reviewed.
- **Test suite fails after implementation** → Report failures with the actual test output as evidence. Do not claim completion. Log the failures and stop for user guidance.

### Common Errors

For subagent failure, tool unavailability, file-not-found, and timeout recovery, follow the shared patterns in `.github/skills/references/error-handling-patterns.md`.
