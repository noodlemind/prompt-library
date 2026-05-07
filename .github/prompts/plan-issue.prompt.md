---
name: plan-issue
description: Generate a phased implementation plan for an existing issue by researching the codebase and best practices.
argument-hint: "[path to issue file]"
agent: plan-coordinator
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

Follow the instructions in [plan-issue skill](../skills/plan-issue/SKILL.md).
For repository-specific work, read available product-owned context first: `README.md`, `docs/agent-context.md`, `docs/codebase-snapshot.md`, `docs/plans/`, and `docs/solutions/`.
