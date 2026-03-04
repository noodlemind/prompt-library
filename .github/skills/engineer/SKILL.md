---
name: engineer
description: "Full-cycle software engineering — understand requirements, debug issues, implement changes, and verify results. Use when you need hands-on engineering work with autonomous investigation and implementation, guided by your steering."
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
