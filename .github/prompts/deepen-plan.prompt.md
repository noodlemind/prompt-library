---
name: deepen-plan
description: Enhance a plan with parallel research per section to add depth, best practices, and implementation details after /plan-issue.
argument-hint: "[path to plan file]"
agent: agent
tools:
  - agent
  - codebase
  - search
  - read
  - editFiles
  - fetch
  - terminalLastCommand
  - problems
---

Follow the instructions in [deepen-plan skill](../skills/deepen-plan/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
