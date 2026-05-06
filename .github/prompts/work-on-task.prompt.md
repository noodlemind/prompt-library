---
name: work-on-task
description: Execute the current phase of a planned issue using TDD with scope control, session logging, and plan_lock enforcement.
argument-hint: "[path to plan file]"
agent: agent
tools:
  - search
  - read
  - editFiles
  - terminalLastCommand
  - fetch
---

Follow the instructions in [work-on-task skill](../skills/work-on-task/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
